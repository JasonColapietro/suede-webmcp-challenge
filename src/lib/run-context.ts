/** Builds a NodeContext for a run from the environment. Server-only. */
import { createX402Client } from "./rails/x402-client";
import { getServerWalletAddress } from "./rails/wallet";
import {
  createLlmFromEnv,
  createStubLlm,
  estimateLlmTokens,
  hasRealLlmProvider,
  type LlmClient,
  type LlmGenerateOptions,
  type LlmGeneration,
} from "./llm";
import {
  modelSpendEntitlement,
  recordModelSpend,
  type ModelSpendBilling,
  type ModelSpendEntitlement,
} from "./gateway/model-spend";
import type { FlowRepo } from "./db/repo";
import { getRepo } from "./db/repo";
import { getRegistry } from "./flow/registry";
import { runCostCeilingUsdc } from "./flow/engine";
import type { NodeContext } from "./flow/executor";
import type { RunLogger } from "./log";
import type { SecretReferenceResolver } from "./flow/value-bindings";
import { createSubflowResolver } from "./flow/subflow-resolver";
import { getProjectRepo } from "./projects/provider";
import type { RunSubflowSnapshot } from "./flow/run-subflow-preflight";
import { getResourceRepository } from "./resources/provider";
import { createOwnerScopedResourcePackResolver } from "./projects/resource-dependencies";
import type { OwnerScopedResourcePackResolver } from "./projects/resource-dependencies";

export interface BuildRunContextOptions {
  runId: string;
  logger: RunLogger;
  /** Overrides X402_SKIP_SETTLEMENT; defaults to dry-run. */
  dryRun?: boolean;
  /**
   * Owner of the flow this run belongs to. A Subflow node may only load
   * another flow owned by the same owner — otherwise a user could reference
   * a stranger's flow UUID and execute their private graph. Pass null when
   * the run isn't tied to a persisted flow (no owner to check against);
   * loadSubflow then refuses every subflow load.
   */
  ownerId: string | null;
  /**
   * Agent's remaining daily cost budget at run start (daily cap minus spend
   * so far), already computed by run-service.ts's per-agent daily cap check.
   * The in-run cost ceiling is the MINIMUM of the absolute per-run ceiling
   * (runCostCeilingUsdc()) and this value. Omit/null when there's no
   * agentId (editor preview / manual run) — only the absolute ceiling
   * applies then.
   */
  dailyRemainingUsdc?: number | null;
  /** Request-scoped graph variable values keyed by variable id. */
  runVariables?: Readonly<Record<string, unknown>>;
  /** Optional runtime integration for opaque connection references. */
  resolveSecretReference?: SecretReferenceResolver;
  /** Authoritative persisted flow row ID. Gateway/unpersisted execution omits it. */
  rootFlowId?: string;
  /** Validated request snapshot; when present, execution must not reload children. */
  subflowSnapshot?: RunSubflowSnapshot;
  /** Exact Resource Pack snapshot bound to this one prepared public execution. */
  resolveResourcePack?: OwnerScopedResourcePackResolver;
}

/**
 * The public payment gate (opts.dryRun) and whether this server has a funded
 * signer for downstream x402 tool calls are independent facts. A settled
 * public call must not throw after the customer's money has already moved
 * just because X402_PRIVATE_KEY isn't configured — X402Client's constructor
 * requires a privateKey whenever dryRun is false. Dry-run the internal
 * client instead of propagating opts.dryRun verbatim when no signer exists;
 * an explicit dry-run request (opts.dryRun === true) always still wins.
 */
function resolveInternalX402DryRun(requestedDryRun: boolean | undefined): boolean | undefined {
  if (requestedDryRun !== false) return requestedDryRun;
  return getServerWalletAddress() ? false : true;
}

/** Ledger label for model spend booked from real flow runs. */
export const FLOW_RUN_MODEL_SPEND_REASON = "flow-run";

interface EntitledModelSpend {
  readonly billing: ModelSpendBilling;
  readonly entitlement: Extract<ModelSpendEntitlement, { allowed: true }>;
}

export interface MeteredLlmOptions {
  /** Real provider-backed client whose calls must be entitled and metered. */
  base: LlmClient;
  /**
   * The flow OWNER's billing identity. Model spend from a run is the owner's
   * spend, not the caller's: the caller pays the agent's x402/credit price,
   * and whatever inference the flow performs comes out of the owner's
   * gateway allowance/credit. Null (no persisted owner) fails closed to the
   * degraded client — an ownerless run has no entitlement that could cover
   * platform inference.
   */
  ownerId: string | null;
  /** Ledger label for credit debits; defaults to FLOW_RUN_MODEL_SPEND_REASON. */
  spendReason?: string;
  /** Injectable for tests; defaults to the shared repo. */
  resolveRepo?: () => Promise<FlowRepo>;
  /** Client used when the owner is not entitled; defaults to a labeled stub. */
  degraded?: LlmClient;
}

/**
 * Wraps a real LlmClient so every generate call from a flow run is
 * entitlement-checked against the flow OWNER and booked to the shared model
 * spend ledger (see gateway/model-spend.ts — the same allowance and per-IP
 * rules as /api/gateway/llm).
 *
 * Behavior, in order:
 *  1. The entitlement is resolved lazily, once, before the FIRST real
 *     generate of the run. Runs that never call the model never touch the DB.
 *  2. Denial (unpaid owner, spent allowance, read error, missing owner)
 *     DEGRADES to the stub client. The run still completes with stub output —
 *     degrade-never-paywall — but no unmetered platform inference happens.
 *  3. Spend is recorded immediately after each successful model call and
 *     BEFORE any caller-side validation of the output: garbage output still
 *     bills. A provider throw bills nothing.
 */
export function createMeteredLlm(opts: MeteredLlmOptions): LlmClient {
  const degraded =
    opts.degraded ??
    createStubLlm(
      (prompt) =>
        `[degraded] Model spend is not covered by this workspace's allowance or credit; ` +
        `returning a stub instead of real inference. Prompt preview: ${prompt.slice(0, 200)}`,
    );
  const spendReason = opts.spendReason ?? FLOW_RUN_MODEL_SPEND_REASON;
  const resolveRepo = opts.resolveRepo ?? (async (): Promise<FlowRepo> => getRepo());
  let gate: Promise<EntitledModelSpend | null> | null = null;
  const resolveGate = (): Promise<EntitledModelSpend | null> => {
    gate ??= (async () => {
      // No owner means no entitlement to bill against. Fail closed to the
      // degraded client rather than granting unmetered platform inference.
      if (!opts.ownerId) return null;
      try {
        const repo = await resolveRepo();
        const billing: ModelSpendBilling = { ownerId: opts.ownerId, repo };
        const entitlement = await modelSpendEntitlement(billing);
        if (!entitlement.allowed) return null;
        return { billing, entitlement };
      } catch {
        // Payment-adjacent read failed: fail CLOSED (degrade, never bill blind).
        return null;
      }
    })();
    return gate;
  };

  const generateWithUsage = async (
    prompt: string,
    generateOpts: LlmGenerateOptions = {},
  ): Promise<LlmGeneration> => {
    const entitled = await resolveGate();
    if (!entitled) {
      const text = await degraded.generate(prompt, generateOpts);
      return { text, usage: { totalTokens: 0 } };
    }
    const generation = opts.base.generateWithUsage
      ? await opts.base.generateWithUsage(prompt, generateOpts)
      : await opts.base.generate(prompt, generateOpts).then(
          (text): LlmGeneration => ({
            text,
            usage: { totalTokens: estimateLlmTokens(prompt, text, generateOpts.system) },
          }),
        );
    // Meter NOW, before the caller sees (let alone validates) the output.
    await recordModelSpend(
      entitled.billing,
      entitled.entitlement,
      generation.usage.totalTokens,
      spendReason,
    );
    return generation;
  };

  return {
    async generate(prompt: string, generateOpts: LlmGenerateOptions = {}): Promise<string> {
      return (await generateWithUsage(prompt, generateOpts)).text;
    },
    generateWithUsage,
  };
}

export function buildRunContext(opts: BuildRunContextOptions): NodeContext {
  const x402 = createX402Client({ dryRun: resolveInternalX402DryRun(opts.dryRun) });
  // A real provider client is wrapped so run inference is entitled to the
  // flow owner and metered; the no-key stub costs nothing and stays bare.
  const baseLlm = createLlmFromEnv();
  const llm = hasRealLlmProvider()
    ? createMeteredLlm({ base: baseLlm, ownerId: opts.ownerId })
    : baseLlm;
  const absoluteCeilingUsdc = runCostCeilingUsdc();
  const limitUsdc =
    opts.dailyRemainingUsdc != null
      ? Math.min(absoluteCeilingUsdc, opts.dailyRemainingUsdc)
      : absoluteCeilingUsdc;
  let resolver: Promise<NodeContext["resolveSubflow"]> | null = null;
  const liveResolveSubflow = async (...args: Parameters<NodeContext["resolveSubflow"]>) => {
    resolver ??= Promise.all([getRepo(), getProjectRepo()]).then(([flowRepo, versionRepo]) =>
      createSubflowResolver({ ownerId: opts.ownerId, flowRepo, versionRepo }),
    );
    return (await resolver)(...args);
  };
  const resolveSubflow = opts.subflowSnapshot?.resolveSubflow ?? liveResolveSubflow;
  let resourceResolver: Promise<NodeContext["resolveResourcePack"]> | null = null;
  const liveResolveResourcePack: NodeContext["resolveResourcePack"] = async (reference) => {
    if (!opts.ownerId) return null;
    resourceResolver ??= getResourceRepository().then((repository) =>
      createOwnerScopedResourcePackResolver(opts.ownerId!, repository),
    );
    return (await resourceResolver)(reference);
  };
  const resolveResourcePack = opts.resolveResourcePack ?? liveResolveResourcePack;
  return {
    runId: opts.runId,
    dryRun: x402.dryRun,
    ownerId: opts.ownerId,
    wallet: { address: x402.walletAddress, network: "base-mainnet" },
    x402,
    llm,
    logger: opts.logger,
    loadSubflow: opts.subflowSnapshot?.loadSubflow ?? (async (flowId: string) => {
      const repo = await getRepo();
      const flow = opts.ownerId ? await repo.getOwnedFlow(flowId, opts.ownerId) : null;
      // Same "not found" error whether the flow is missing or owned by
      // someone else — a subflow node must never be able to probe for the
      // existence of another owner's private flow.
      if (!flow) {
        throw new Error(`Subflow ${flowId} not found`);
      }
      return flow.graph;
    }),
    resolveSubflow,
    resolveResourcePack,
    registry: getRegistry(),
    depth: 0,
    flowAncestry: Object.freeze(opts.rootFlowId ? [opts.rootFlowId] : []),
    costCeiling: { limitUsdc, spentUsdc: 0, reservedUsdc: 0 },
    runVariables: opts.runVariables ?? {},
    resolveSecretReference: opts.resolveSecretReference ?? (async ({ connectionId, field }) => {
      throw new Error(`Secret reference ${connectionId}:${field} is unavailable in this run`);
    }),
  };
}
