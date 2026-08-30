/**
 * Run service — ties the engine to persistence. Creates a run, streams engine
 * events while recording each step + the cost ledger, and finalizes the run.
 * Server-only. Used by both the manual-run and agent-run routes.
 */
import { runFlow } from "./flow/engine";
import { isDeepStrictEqual } from "node:util";
import { getRegistry } from "./flow/registry";
import type { JsonObjectSchema } from "./flow/input-contract";
import { RunLogger } from "./log";
import { buildRunContext } from "./run-context";
import { getRepo, type RelayEndpointRecord } from "./db/repo";
import type { RunEvent, SupportedFlowGraph } from "./flow/types";
import type { SecretReferenceResolver } from "./flow/value-bindings";
import type { RunSubflowSnapshot } from "./flow/run-subflow-preflight";
import { getProjectRepo } from "./projects/provider";
import type { ReadonlyFlowGraph } from "./projects/types";
import { resolveActiveLiveExecution, type ActiveLiveExecution } from "./projects/live-execution";
import {
  getConnectionRepository,
  type CloseableConnectionRepository,
} from "./connections/provider";
import { createConnectionSecretResolver } from "./connections/runtime-resolver";
import {
  ApiOperationLiveUnavailableError,
  refuseApiOperationLive,
} from "./connectors/operation-closure";
import {
  loadExactFreshResourcePackSnapshot,
  type ExactFreshResourcePackSnapshotEntry,
  type OwnerScopedResourcePackResolver,
  type ResourcePackResolutionReference,
} from "./projects/resource-dependencies";
import { resourcePackSemanticHash } from "./resources/pack-hash";
import { getResourceRepository } from "./resources/provider";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fallback cap when AGENT_DAILY_COST_CAP_USDC is unset or invalid. */
const DEFAULT_AGENT_DAILY_COST_CAP_USDC = 25;

function agentDailyCostCapUsdc(): number {
  const raw = process.env.AGENT_DAILY_COST_CAP_USDC;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_DAILY_COST_CAP_USDC;
}

/** Thrown when an agent has spent its rolling 24h cost budget. */
export class AgentDailyCapExceededError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly capUsdc: number,
    public readonly spentUsdc: number,
  ) {
    super(
      `Agent ${agentId} has reached its daily cost cap: spent $${spentUsdc.toFixed(2)} of a $${capUsdc.toFixed(2)} USDC/24h budget`,
    );
    this.name = "AgentDailyCapExceededError";
  }
}

/**
 * Thrown when a single run's OWN cumulative cost ledger crosses its ceiling
 * mid-run (engine.ts's ctx.costCeiling), as opposed to AgentDailyCapExceededError
 * above, which is a point-in-time check of PAST spend before a run even
 * starts. This is the in-run backstop: a loop node can spend up to
 * LOOP_ITERATION_CEILING x (subflow cost) inside a single run, so the daily
 * cap alone would only ever notice on the NEXT run, after the money is
 * already spent. Distinguishable from a plain node failure: a normal node
 * failure still resolves runToCompletion/runAndStream with a `status:
 * "error"` summary; this REJECTS the call instead.
 */
export class RunCostCeilingExceededError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly ceilingUsdc: number,
    public readonly spentUsdc: number,
  ) {
    super(
      `Run aborted: its in-run cost ceiling of $${ceilingUsdc.toFixed(2)} was reached before node "${nodeId}" (${nodeType}) could run. Spent $${spentUsdc.toFixed(2)} before aborting.`,
    );
    this.name = "RunCostCeilingExceededError";
  }
}

export interface RunOptions {
  trigger: string;
  agentId?: string | null;
  triggerInput?: Record<string, unknown>;
  dryRun?: boolean;
  /**
   * The flows ROW id. Required whenever the graph was persisted: graph.id is
   * the graph's internal id and differs from the row id, and runs.flow_id has
   * a foreign key onto flows.id in the deploy schema.
   */
  flowId?: string;
  /** Request-scoped graph variables keyed by variable id. */
  runVariables?: Readonly<Record<string, unknown>>;
  /** Runtime integration for opaque secret references. */
  /** @deprecated Caller-provided secret authority is deliberately ignored. */
  resolveSecretReference?: SecretReferenceResolver;
  /** Exact request-scoped reusable-flow closure validated before this run. */
  subflowSnapshot?: RunSubflowSnapshot;
}

interface InternalRunOptions extends RunOptions {
  /**
   * A server-created, still-running row that must be reused by this execution.
   * This is used by paid paths that must durably attach settlement/accounting
   * to the final run id before any provider, relay, or secret-bearing node can
   * execute. It is never accepted from an HTTP request.
   */
  readonly precreatedRunId?: string;
}

interface InternalLiveAuthority {
  readonly execution: ActiveLiveExecution;
  readonly resolveSecretReference: SecretReferenceResolver;
  readonly resolveResourcePack: OwnerScopedResourcePackResolver | null;
}

const trustedLiveReceipts = new WeakSet<object>();

const refusingSecretResolver: SecretReferenceResolver = async () => {
  throw new Error("Secret references are unavailable in this run");
};

/** Run a flow, yielding RunEvents while persisting steps + the ledger. */
async function* runAndStreamInternal(
  flow: SupportedFlowGraph,
  opts: InternalRunOptions,
  authority?: InternalLiveAuthority,
): AsyncGenerator<RunEvent> {
  if (opts.dryRun !== true) refuseApiOperationLive(flow);
  const trustedLiveAuthority = authority !== undefined &&
    trustedLiveReceipts.delete(authority.execution.receipt) &&
    authority.execution.graph === flow &&
    authority.execution.receipt.flowId === opts.flowId &&
    opts.dryRun === false;
  const resolveSecretReference = trustedLiveAuthority && authority
    ? authority.resolveSecretReference
    : refusingSecretResolver;
  const repo = await getRepo();

  // Durable per-agent daily cost cap, enforced against the database.
  //
  // src/lib/rate-limit.ts is an in-memory, per-instance token bucket — on
  // serverless that state resets on every cold start and isn't shared
  // across concurrently-running instances, so it is a speed bump, not a
  // hard ceiling. An attacker (or a bug) that fans requests out across
  // enough cold instances, or across IPs, can bypass it entirely. This
  // check is the backstop: it sums *actually incurred* cost for this
  // agent from the runs table (durable, instance-independent) and refuses
  // to start a new run once the rolling 24h window is over budget, no
  // matter how many instances or IPs the calls came from.
  //
  // Residual gap: this is checked once per run, at start, from a
  // point-in-time read — concurrent in-flight runs that haven't finished
  // (and so haven't recorded their cost yet) aren't counted until they
  // finish, so a burst of truly simultaneous runs can slightly overshoot
  // the cap before it trips. A proper fix (atomic DB-side increment/quota
  // reservation) is out of scope for this pass.
  // dailyRemainingUsdc feeds the in-run cost ceiling below (see
  // buildRunContext / engine.ts's ctx.costCeiling): the effective ceiling
  // for THIS run is the minimum of the absolute per-run ceiling and however
  // much of the agent's daily budget is left at run start. Null (no
  // agentId) means only the absolute ceiling applies.
  let dailyRemainingUsdc: number | null = null;
  if (opts.agentId) {
    const capUsdc = agentDailyCostCapUsdc();
    const sinceMs = Date.now() - MS_PER_DAY;
    const spentUsdc = await repo.sumAgentCostSince(opts.agentId, sinceMs);
    if (spentUsdc >= capUsdc) {
      throw new AgentDailyCapExceededError(opts.agentId, capUsdc, spentUsdc);
    }
    dailyRemainingUsdc = capUsdc - spentUsdc;
  }

  const expectedRun = {
    flowId: opts.flowId ?? flow.id,
    agentId: opts.agentId ?? null,
    trigger: opts.trigger,
    triggerInput: opts.triggerInput ?? null,
    runVariables: opts.runVariables ?? null,
  };
  const precreatedRun = opts.precreatedRunId
    ? await repo.getRun(opts.precreatedRunId)
    : null;
  if (opts.precreatedRunId && (
    !precreatedRun
    || precreatedRun.status !== "running"
    || precreatedRun.flowId !== expectedRun.flowId
    || precreatedRun.agentId !== expectedRun.agentId
    || precreatedRun.trigger !== expectedRun.trigger
    || !isDeepStrictEqual(precreatedRun.triggerInput, expectedRun.triggerInput)
    || !isDeepStrictEqual(precreatedRun.runVariables, expectedRun.runVariables)
  )) {
    throw new Error("Precreated run is unavailable or does not match this execution");
  }
  const run = precreatedRun ?? await repo.createRun(expectedRun);
  const logger = new RunLogger();
  // Resolve the owner of the flow being run (not the caller's session — the
  // cron and agent routes have no session owner) so loadSubflow can check a
  // referenced flow's owner against it. No flowId means the graph isn't
  // persisted, so there's no owner to check against: subflow loads refuse.
  const ownerId = opts.flowId ? ((await repo.getFlow(opts.flowId))?.ownerId ?? null) : null;
  const ctx = buildRunContext({
    runId: run.id,
    logger,
    dryRun: opts.dryRun,
    ownerId,
    dailyRemainingUsdc,
    runVariables: opts.runVariables,
    resolveSecretReference,
    rootFlowId: opts.flowId,
    subflowSnapshot: opts.subflowSnapshot,
    ...(authority?.resolveResourcePack ? { resolveResourcePack: authority.resolveResourcePack } : {}),
  });

  let totalCostUsdc = 0;
  let status: "done" | "error" = "done";
  // Set from a node:error event whose costCeilingExceeded flag is set — the
  // in-run cost ceiling aborted the run. Captured here (not thrown
  // immediately) so the step + ledger recording below still happens and
  // `finally` still finalizes the run row before we raise the typed error.
  let ceilingExceededEvent: Extract<RunEvent, { kind: "node:error" }> | null = null;

  try {
    for await (const event of runFlow(flow, ctx, getRegistry(), opts.triggerInput ?? {})) {
      if (event.kind === "node:done") {
        await repo.appendStep({
          runId: run.id,
          nodeId: event.nodeId,
          nodeType: event.nodeType,
          status: "done",
          costUsdc: event.costUsdc,
          output: event.outputs,
        });
      } else if (event.kind === "node:error") {
        await repo.appendStep({
          runId: run.id,
          nodeId: event.nodeId,
          nodeType: event.nodeType,
          status: "error",
          costUsdc: 0,
          error: event.error,
        });
        status = "error";
        if (event.costCeilingExceeded) ceilingExceededEvent = event;
      } else if (event.kind === "run:done") {
        totalCostUsdc = event.totalCostUsdc;
        status = event.status;
      }
      yield event;
    }
  } catch (error: unknown) {
    status = "error";
    totalCostUsdc = 0;
    throw error;
  } finally {
    await repo.finishRun(run.id, status, totalCostUsdc);
  }

  if (ceilingExceededEvent) {
    throw new RunCostCeilingExceededError(
      ceilingExceededEvent.nodeId,
      ceilingExceededEvent.nodeType,
      ctx.costCeiling.limitUsdc,
      totalCostUsdc,
    );
  }
}

/** Run a dry/unpublished graph. Secret-bearing Live authority cannot enter through this primitive. */
export async function* runAndStream(flow: SupportedFlowGraph, opts: RunOptions): AsyncGenerator<RunEvent> {
  yield* runAndStreamInternal(flow, opts);
}

export interface RunSummary {
  runId: string;
  status: "done" | "error";
  totalCostUsdc: number;
  outputs: Record<string, Record<string, unknown>>;
}

const executionErrorRunIds = new WeakMap<object, string>();

/** Recover the already-created durable run id from an execution exception. */
export function runIdFromExecutionError(error: unknown): string | null {
  return typeof error === "object" && error !== null
    ? executionErrorRunIds.get(error) ?? null
    : null;
}

/** Run a flow to completion (no streaming) — used by machine/agent runs. */
export async function runToCompletion(flow: SupportedFlowGraph, opts: RunOptions): Promise<RunSummary> {
  return runToCompletionInternal(flow, opts);
}

async function runToCompletionInternal(
  flow: SupportedFlowGraph,
  opts: InternalRunOptions,
  authority?: InternalLiveAuthority,
): Promise<RunSummary> {
  const outputs: Record<string, Record<string, unknown>> = {};
  let runId = "";
  let status: "done" | "error" = "done";
  let totalCostUsdc = 0;
  try {
    for await (const event of runAndStreamInternal(flow, opts, authority)) {
      if (event.kind === "run:start") runId = event.runId;
      if (event.kind === "node:done") outputs[event.nodeId] = event.outputs;
      if (event.kind === "run:done") {
        status = event.status;
        totalCostUsdc = event.totalCostUsdc;
      }
    }
  } catch (error) {
    if (runId && typeof error === "object" && error !== null) {
      executionErrorRunIds.set(error, runId);
    }
    throw error;
  }
  return { runId, status, totalCostUsdc, outputs };
}

export interface PublishedLiveRunOptions {
  readonly flowId: string;
  readonly ownerId: string;
  readonly trigger: string;
  readonly agentId?: string | null;
  readonly triggerInput?: Record<string, unknown>;
  readonly runVariables?: Readonly<Record<string, unknown>>;
  /** Internal marker for a local preview of the prepared Live release. */
  readonly dryRun?: true;
  /** Server-generated run id used to enforce a pre-execution accounting barrier. */
  readonly precreatedRunId?: string;
}

export interface PreparedPublishedLiveExecution {
  /** Detached and frozen graph from the exact immutable Live version. */
  readonly graph: ReadonlyFlowGraph;
  /** Immutable Live release identity confirmed during preparation. */
  readonly release: ActiveLiveExecution["receipt"];
  /** Exact Resource Pack references classified from the immutable root and pinned closure. */
  readonly resourceDependencies: readonly ResourcePackResolutionReference[];
  /** Public agent contract captured before this authority can settle. */
  readonly agent: Readonly<{
    readonly id: string;
    readonly flowId: string;
    readonly priceUsdc: number;
  }> | null;
  /** Whether the prepared server-only authority captured a relay endpoint. */
  readonly relay: boolean;
}

/** Public, immutable identity of the exact Live deployment behind an opaque authority. */
export type PublishedLiveExecutionReceipt = ActiveLiveExecution["receipt"];

interface PreparedPublishedLiveState {
  readonly execution: ActiveLiveExecution;
  readonly agent: PreparedPublishedLiveExecution["agent"];
  readonly relay: RelayEndpointRecord | null;
  readonly resolveSecretReference: SecretReferenceResolver;
  readonly connectionRepository: CloseableConnectionRepository | null;
  readonly resolveResourcePack: OwnerScopedResourcePackResolver | null;
}

const preparedPublishedLiveExecutions = new WeakMap<
  PreparedPublishedLiveExecution,
  PreparedPublishedLiveState
>();

function closeConnectionRepository(repository: CloseableConnectionRepository | null): void {
  if (!repository) return;
  try {
    repository.close();
  } catch {
    try { repository.dispose(); } catch { /* cleanup never masks the selected result */ }
  }
}

/** Resolve immutable Live authority and retain connection protection, if the exact closure needs it. */
export async function preparePublishedLiveExecution(input: {
  readonly flowId: string;
  readonly ownerId: string;
  /** Bind a public caller's mutable AgentRecord before any payment work. */
  readonly agent?: Readonly<{ id: string; priceUsdc: number }>;
}): Promise<PreparedPublishedLiveExecution | null> {
  let connectionRepository: CloseableConnectionRepository | null = null;
  try {
    const projectRepo = await getProjectRepo();
    const execution = await resolveActiveLiveExecution({
      flowId: input.flowId,
      ownerId: input.ownerId,
      projectRepo,
    });
    if (!execution) return null;
    refuseApiOperationLive(execution.graph as SupportedFlowGraph);
    let agentContract: PreparedPublishedLiveExecution["agent"] = null;
    let relay: RelayEndpointRecord | null = null;
    if (input.agent) {
      const repo = await getRepo();
      const agent = await repo.getAgent(input.agent.id);
      if (!agent || agent.status !== "live" || agent.flowId !== input.flowId ||
          agent.priceUsdc !== input.agent.priceUsdc) return null;
      agentContract = Object.freeze({
        id: agent.id,
        flowId: agent.flowId,
        priceUsdc: agent.priceUsdc,
      });
      const relayRecord = await repo.getRelayEndpoint(agent.id);
      relay = relayRecord ? Object.freeze({ ...relayRecord }) : null;
    }

    let resolveSecretReference = refusingSecretResolver;
    if (execution.usesConnections) {
      connectionRepository = await getConnectionRepository();
      resolveSecretReference = createConnectionSecretResolver({
        ownerId: execution.receipt.ownerId,
        environment: "live",
        repository: connectionRepository,
      });
    }
    const handle = Object.freeze({
      graph: execution.graph,
      release: execution.receipt,
      resourceDependencies: execution.resourceDependencies,
      agent: agentContract,
      relay: relay !== null,
    });
    preparedPublishedLiveExecutions.set(handle, {
      execution,
      agent: agentContract,
      relay,
      resolveSecretReference,
      connectionRepository,
      resolveResourcePack: null,
    });
    return handle;
  } catch (error) {
    closeConnectionRepository(connectionRepository);
    if (error instanceof ApiOperationLiveUnavailableError) throw error;
    return null;
  }
}

/** Dispose an unconsumed prepared authority. Safe to call repeatedly. */
export function disposePreparedPublishedLiveExecution(
  prepared: PreparedPublishedLiveExecution,
): void {
  const state = preparedPublishedLiveExecutions.get(prepared);
  if (!state) return;
  preparedPublishedLiveExecutions.delete(prepared);
  closeConnectionRepository(state.connectionRepository);
}

/** Bind one validated, detached fresh Resource closure into an opaque one-use authority. */
export function bindPreparedPublishedLiveResourceSnapshot(
  prepared: PreparedPublishedLiveExecution,
  snapshot: readonly ExactFreshResourcePackSnapshotEntry[],
): boolean {
  const state = preparedPublishedLiveExecutions.get(prepared);
  if (!state || state.resolveResourcePack !== null ||
      prepared.resourceDependencies !== state.execution.resourceDependencies ||
      snapshot.length !== state.execution.resourceDependencies.length) return false;
  const resolvedByProduct = new Map<string, ExactFreshResourcePackSnapshotEntry["resolved"]>();
  for (const dependency of state.execution.resourceDependencies) {
    const entry = snapshot.find((candidate) =>
      candidate.reference.resourceProductId === dependency.resourceProductId);
    if (!entry || resolvedByProduct.has(dependency.resourceProductId) ||
        entry.reference.packVersionId !== dependency.packVersionId ||
        entry.reference.contentHash !== dependency.contentHash ||
        (entry.resolved.status !== "approved" && entry.resolved.status !== "live") ||
        entry.resolved.bundle.resourceProductId !== dependency.resourceProductId ||
        entry.resolved.bundle.packVersionId !== dependency.packVersionId ||
        entry.resolved.bundle.semanticHash !== dependency.contentHash ||
        entry.resolved.bundle.freshness !== "fresh" ||
        resourcePackSemanticHash(entry.resolved.bundle.content).semanticHash !== dependency.contentHash) return false;
    resolvedByProduct.set(dependency.resourceProductId, entry.resolved);
  }
  const resolveResourcePack: OwnerScopedResourcePackResolver = async (reference) => {
    const dependency = state.execution.resourceDependencies.find((candidate) =>
      candidate.resourceProductId === reference.resourceProductId);
    if (!dependency || dependency.packVersionId !== reference.packVersionId ||
        dependency.contentHash !== reference.contentHash) return null;
    return resolvedByProduct.get(reference.resourceProductId) ?? null;
  };
  preparedPublishedLiveExecutions.set(prepared, Object.freeze({
    ...state,
    resolveResourcePack,
  }));
  return true;
}

function preparedStateMatches(
  state: PreparedPublishedLiveState,
  prepared: PreparedPublishedLiveExecution,
  opts: Pick<PublishedLiveRunOptions, "flowId" | "ownerId" | "agentId">,
): boolean {
  return state.execution.receipt.flowId === opts.flowId &&
    state.execution.receipt.ownerId === opts.ownerId &&
    state.execution.receipt.flowId === prepared.release.flowId &&
    state.execution.receipt.ownerId === prepared.release.ownerId &&
    state.execution.receipt.deploymentId === prepared.release.deploymentId &&
    state.execution.receipt.flowVersionId === prepared.release.flowVersionId &&
    state.execution.receipt.environmentId === prepared.release.environmentId &&
    state.execution.receipt.semanticHash === prepared.release.semanticHash &&
    state.execution.receipt.fullHash === prepared.release.fullHash &&
    state.execution.graph === prepared.graph &&
    state.execution.resourceDependencies === prepared.resourceDependencies &&
    state.agent === prepared.agent &&
    prepared.relay === (state.relay !== null) &&
    (state.agent === null || opts.agentId === state.agent.id);
}

/**
 * Read the non-secret deployment identity bound to a prepared authority.
 * The graph, connection resolver, and one-use execution capability remain
 * private; callers can only bind an external authorization to this receipt.
 */
export function preparedPublishedLiveExecutionReceipt(
  prepared: PreparedPublishedLiveExecution,
): PublishedLiveExecutionReceipt | null {
  return preparedPublishedLiveExecutions.get(prepared)?.execution.receipt ?? null;
}

/** Read the exact relay row captured with this one-use Live authority. */
export function preparedPublishedLiveRelaySnapshot(
  prepared: PreparedPublishedLiveExecution,
): Readonly<RelayEndpointRecord> | null | undefined {
  return preparedPublishedLiveExecutions.get(prepared)?.relay;
}

/** Consume the exact prepared authority once; structural forgeries and owner/flow rebinding fail closed. */
export async function runPreparedPublishedLiveToCompletion(
  prepared: PreparedPublishedLiveExecution,
  opts: PublishedLiveRunOptions,
): Promise<RunSummary | null> {
  const state = preparedPublishedLiveExecutions.get(prepared);
  if (!state) return null;
  preparedPublishedLiveExecutions.delete(prepared);
  try {
    if (state.relay !== null || !preparedStateMatches(state, prepared, opts) ||
        (state.execution.resourceDependencies.length > 0 && !state.resolveResourcePack)) return null;
    trustedLiveReceipts.add(state.execution.receipt);
    return await runToCompletionInternal(
      state.execution.graph as SupportedFlowGraph,
      {
        flowId: state.execution.receipt.flowId,
        trigger: opts.trigger,
        agentId: opts.agentId,
        triggerInput: opts.triggerInput,
        dryRun: false,
        runVariables: opts.runVariables,
        precreatedRunId: opts.precreatedRunId,
        subflowSnapshot: state.execution.subflowSnapshot,
      },
      {
        execution: state.execution,
        resolveSecretReference: state.resolveSecretReference,
        resolveResourcePack: state.resolveResourcePack,
      },
    );
  } finally {
    closeConnectionRepository(state.connectionRepository);
  }
}

/** Consume a prepared authority once to preview its exact immutable Live graph locally. */
export async function runPreparedPublishedLiveDryRunToCompletion(
  prepared: PreparedPublishedLiveExecution,
  opts: PublishedLiveRunOptions,
): Promise<RunSummary | null> {
  const state = preparedPublishedLiveExecutions.get(prepared);
  if (!state) return null;
  preparedPublishedLiveExecutions.delete(prepared);
  try {
    if (!preparedStateMatches(state, prepared, opts) ||
        (state.execution.resourceDependencies.length > 0 && !state.resolveResourcePack)) return null;
    return await runToCompletionInternal(
      state.execution.graph as SupportedFlowGraph,
      {
        flowId: state.execution.receipt.flowId,
        trigger: opts.trigger,
        agentId: opts.agentId,
        triggerInput: opts.triggerInput,
        dryRun: true,
        runVariables: opts.runVariables,
        subflowSnapshot: state.execution.subflowSnapshot,
      },
      {
        execution: state.execution,
        resolveSecretReference: refusingSecretResolver,
        resolveResourcePack: state.resolveResourcePack,
      },
    );
  } finally {
    closeConnectionRepository(state.connectionRepository);
  }
}

/** Consume the prepared server-only relay decision once, without rereading mutable relay configuration. */
export async function consumePreparedPublishedLiveRelay(
  prepared: PreparedPublishedLiveExecution,
  opts: Pick<PublishedLiveRunOptions, "flowId" | "ownerId" | "agentId">,
): Promise<Readonly<{ url: string; secret: string }> | null> {
  const state = preparedPublishedLiveExecutions.get(prepared);
  if (!state) return null;
  preparedPublishedLiveExecutions.delete(prepared);
  try {
    if (!preparedStateMatches(state, prepared, opts) || !state.relay) return null;
    return Object.freeze({ url: state.relay.url, secret: state.relay.secret });
  } finally {
    closeConnectionRepository(state.connectionRepository);
  }
}

/** Resolve and run only the immutable version currently promoted to this owner's Live environment. */
export async function runPublishedLiveToCompletion(
  opts: PublishedLiveRunOptions,
): Promise<RunSummary | null> {
  const prepared = await preparePublishedLiveExecution({
    flowId: opts.flowId,
    ownerId: opts.ownerId,
  });
  if (!prepared) return null;
  if (prepared.resourceDependencies.length > 0) {
    const repository = await getResourceRepository().catch(() => null);
    const snapshot = repository
      ? await loadExactFreshResourcePackSnapshot(
          opts.ownerId,
          repository,
          prepared.resourceDependencies,
        )
      : null;
    if (!snapshot || !bindPreparedPublishedLiveResourceSnapshot(prepared, snapshot)) {
      disposePreparedPublishedLiveExecution(prepared);
      return null;
    }
  }
  return runPreparedPublishedLiveToCompletion(prepared, opts);
}

/** Encode a RunEvent as an SSE frame. */
export function sseFrame(event: RunEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Additive machine-readable marker for simulated runs. Spread into a run
 * route's JSON response: a dry-run response carries `mode: "dry-run"` so a
 * machine caller can distinguish a simulation from a settled execution
 * without inferring it from `settled`/cost fields; a real run adds nothing,
 * keeping settled response shapes byte-compatible with existing clients.
 */
export function runModeResponseFields(
  dryRun: boolean,
): { readonly mode: "dry-run" } | Record<string, never> {
  return dryRun ? { mode: "dry-run" } : {};
}

/**
 * Violations of a published input contract (see flow/input-contract.ts's
 * deriveInputSchema) for one trigger-input payload. Empty array means the
 * input conforms.
 *
 * The contract is deliberately permissive in the same places the schema is.
 * Graph-derived fields remain optional because they carry defaults. Explicit
 * curated contracts may add required fields and scalar constraints. Unknown
 * keys are rejected only when the schema is closed, and untyped properties
 * accept anything.
 */
export function triggerInputContractViolations(
  schema: JsonObjectSchema,
  input: Readonly<Record<string, unknown>>,
): string[] {
  const violations: string[] = [];
  const properties = schema.properties ?? {};
  const closed = schema.additionalProperties === false;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  for (const key of required) {
    if (!(key in input)) violations.push(`missing required field "${key}"`);
  }
  for (const [key, value] of Object.entries(input)) {
    const propSchema = properties[key] as Record<string, unknown> | undefined;
    if (!propSchema) {
      if (closed) violations.push(`unexpected field "${key}"`);
      continue;
    }
    const expected = propSchema.type;
    if (typeof expected !== "string") continue;
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const typeMatches = expected === "integer"
      ? typeof value === "number" && Number.isInteger(value)
      : expected === actual;
    if (!typeMatches) {
      violations.push(`field "${key}" must be ${expected}, got ${actual}`);
      continue;
    }
    if (typeof value === "string") {
      if (typeof propSchema.minLength === "number" && value.length < propSchema.minLength) {
        violations.push(`field "${key}" must be at least ${propSchema.minLength} characters`);
      }
      if (typeof propSchema.pattern === "string") {
        try {
          if (!new RegExp(propSchema.pattern, "u").test(value)) {
            violations.push(`field "${key}" does not match the required pattern`);
          }
        } catch {
          // Invalid authored patterns are a schema bug, not a caller violation.
        }
      }
      if (propSchema.contentEncoding === "base64") {
        const compact = value.replace(/\s/gu, "");
        const validBase64 = compact.length > 0 && compact.length % 4 === 0 &&
          /^[A-Za-z0-9+/]*={0,2}$/u.test(compact);
        if (!validBase64) violations.push(`field "${key}" must be valid base64`);
      }
    }
    if (typeof value === "number" && typeof propSchema.minimum === "number" &&
      value < propSchema.minimum) {
      violations.push(`field "${key}" must be at least ${propSchema.minimum}`);
    }
    if (Array.isArray(propSchema.enum) &&
      !propSchema.enum.some((candidate) => Object.is(candidate, value))) {
      violations.push(`field "${key}" must be one of the declared values`);
    }
  }
  return violations;
}
