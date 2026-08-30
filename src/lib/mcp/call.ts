/**
 * The MCP paid-call path — pre-funded workspace credit, not x402.
 *
 * A model in the middle of a tool call cannot answer an HTTP 402 challenge, so
 * the x402 rail that gates /api/agents/[agent]/run is the wrong shape here.
 * Instead the bearer key on the request identifies a workspace, and the
 * agent's price moves inside the credit ledger: debit the caller, credit the
 * creator. PLATFORM_TAKE_RATE is 0, so the creator receives the full price,
 * matching what an on-chain settle would route.
 *
 * Money is moved BEFORE the flow runs and reversed if the run does not
 * succeed. A failed run must never leave the caller charged.
 *
 * Server-only: the injected runner reaches the engine.
 */
import type { CatalogEntry } from "@/lib/catalog";
import type { FlowRepo } from "@/lib/db/repo";
import { mcpEligibility, toolIndex } from "./tools";
import type { McpCallToolInput, McpToolResult } from "./server";
import { triggerInputContractViolations } from "@/lib/run-service";
import {
  RESOURCE_CONTRACT_EXTENSION_URI,
  type PublicServiceContract,
} from "@/lib/public-service-contract";
import type { ResourceRepository } from "@/lib/resources/repository";
import {
  buildAndPersistResourceRunEnvelope,
  resourceRunEnvelopeAccepts,
  resourceRunEnvelopeSchema,
} from "@/lib/resources/run-receipt";

export interface McpAgentRunSummary {
  readonly runId: string;
  readonly status: string;
  readonly outputs: Record<string, unknown>;
  readonly totalCostUsdc: number;
  /** Normalized against the exact prepared Live contract, when available. */
  readonly result?: Record<string, unknown> | null;
}

interface McpAgentRunInput {
  readonly entry: CatalogEntry;
  readonly flowId: string;
  readonly ownerId: string;
  readonly input: Record<string, unknown>;
}

export interface McpPreparedAgentRun {
  readonly resourceService: PublicServiceContract | null;
  execute(): Promise<McpAgentRunSummary>;
  dispose(): void;
}

export interface McpAgentRunner {
  (input: McpAgentRunInput): Promise<McpAgentRunSummary>;
  prepare?: (input: McpAgentRunInput) => Promise<McpPreparedAgentRun>;
}

export interface McpCallDeps {
  readonly repo: FlowRepo;
  loadCatalog(): Promise<readonly CatalogEntry[]>;
  readonly runAgent: McpAgentRunner;
  readonly resourceRepository?: Pick<ResourceRepository, "recordRunReceipt"> | null;
  resolveResourceRepository?(): Promise<Pick<ResourceRepository, "recordRunReceipt"> | null>;
}

/** Ledger reasons, so an MCP-sourced movement is greppable in the credits table. */
const REASON_SPEND = "mcp:spend";
const REASON_EARN = "mcp:earn";
const REASON_REFUND = "mcp:refund";
const REASON_CLAWBACK = "mcp:clawback";

function toolError(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}

function exactPreparedResource(entry: CatalogEntry, service: PublicServiceContract | null): service is PublicServiceContract {
  if (!service || service.kind !== "resource" || !service.resource || service.id !== entry.id ||
      service.slug !== entry.slug || service.priceUsdc !== entry.priceUsdc) return false;
  const advertised = entry.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI];
  return advertised !== undefined && JSON.stringify(canonicalJson(service.resource)) === JSON.stringify(canonicalJson(advertised));
}

/**
 * Execute one MCP tool call end to end.
 *
 * Returns a tool *result* rather than throwing for every failure the model
 * could act on — a missing key, an empty balance, a failed run are all things
 * a model can report or retry against, and the spec asks that those come back
 * as `isError: true` content rather than JSON-RPC protocol errors.
 */
export async function callAgentTool(
  input: McpCallToolInput,
  deps: McpCallDeps,
): Promise<McpToolResult> {
  const entries = await deps.loadCatalog();
  const entry = toolIndex(entries).get(input.name);
  if (!entry) {
    return toolError(
      `Unknown tool: ${input.name}. Call tools/list for the agents currently published.`,
    );
  }

  const agent = await deps.repo.getAgent(entry.id);
  if (!agent || agent.status !== "live") {
    return toolError("This agent is no longer published.");
  }
  const flow = await deps.repo.getFlow(agent.flowId);
  if (!flow) {
    return toolError("This agent is no longer published.");
  }

  // Eligibility is re-checked here, not just at list time: the tool list is
  // cacheable by clients, so an agent that became a company employee after
  // being listed must still be refused at the point of execution.
  const [employee, relay] = await Promise.all([
    typeof deps.repo.getEmployeeByAgent === "function"
      ? deps.repo.getEmployeeByAgent(agent.id)
      : Promise.resolve(null),
    deps.repo.getRelayEndpoint(agent.id),
  ]);
  const eligibility = mcpEligibility({
    isCompanyEmployee: employee !== null,
    hasRelay: relay !== null,
    hasPublishedDeployment: entry.publishedLive,
  });
  if (!eligibility.eligible) {
    return toolError(eligibility.reason);
  }

  // Validate before any ledger movement. The MCP descriptor and executor use
  // the same catalog schema, so malformed arguments cannot consume credit.
  const inputViolations = triggerInputContractViolations(
    entry.inputSchema,
    input.arguments,
  );
  if (inputViolations.length > 0) {
    return toolError(`Invalid input: ${inputViolations.join("; ")}. Nothing was charged.`);
  }

  const expectsResource = entry.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI] !== undefined;
  const resourceRepository = expectsResource
    ? deps.resourceRepository ?? await deps.resolveResourceRepository?.().catch(() => null) ?? null
    : null;
  if (expectsResource && !resourceRepository) {
    return toolError("Resource execution is unavailable because its receipt store is not configured. Nothing was charged.");
  }

  const price = round6(entry.priceUsdc);

  /*
   * The caller's agreed ceiling, enforced against the price this call will
   * ACTUALLY charge. Any check performed by the caller ran against its own,
   * earlier catalog read; between that read and this one sit the eligibility
   * queries and a catalog cache that can expire, so a price raised in that
   * window would otherwise be charged silently. Refuse instead — no ledger
   * movement has happened yet at this point.
   */
  if (input.maxPriceUsdc !== undefined && price > round6(input.maxPriceUsdc)) {
    return toolError(
      `${entry.name} now costs ${price} USDC per call, above the ${round6(input.maxPriceUsdc)} USDC you confirmed. ` +
        "Nothing was charged. Re-read the price and call again to accept it.",
    );
  }

  const creatorId = flow.ownerId;
  const callerId = input.workspaceKey;

  // A creator calling its own agent would debit and credit one ledger for the
  // same amount. Skip the round trip rather than write two cancelling rows.
  const billable = price > 0 && callerId !== creatorId;
  let paymentCreditId: string | null = null;
  let balance: number | null = null;

  if (price > 0 && callerId === null) {
    return toolError(
      `${entry.name} costs ${price} USDC per call. Send a workspace key as ` +
        "`Authorization: Bearer <workspace key>` on the MCP request, and top that " +
        "workspace up at /pricing (card checkout) or machine-fund it with " +
        "POST /api/gateway/topup (x402, USDC on Base) before calling again.",
    );
  }

  if (billable && callerId !== null) {
    try {
      balance = await deps.repo.getCreditBalance(callerId);
    } catch (error: unknown) {
      console.error("mcp credit balance read failed", error);
      return toolError("Billing is unavailable right now. No call was made and nothing was charged.");
    }
    if (balance < price) {
      return toolError(
        `Insufficient workspace credit: ${entry.name} costs ${price} USDC per call and ` +
          `this workspace holds ${round6(balance)} USDC. Top up at /pricing, or ` +
          "machine-fund with POST /api/gateway/topup (x402, USDC on Base), then retry.",
      );
    }

  }

  const runInput = { entry, flowId: flow.id, ownerId: creatorId, input: input.arguments };
  let prepared: McpPreparedAgentRun | null = null;
  let resourceService: PublicServiceContract | null = null;
  if (deps.runAgent.prepare) {
    try {
      prepared = await deps.runAgent.prepare(runInput);
      if (expectsResource && !exactPreparedResource(entry, prepared.resourceService)) {
        prepared.dispose();
        return toolError(`${entry.name} is unavailable because its exact immutable resource contract did not match. Nothing was charged.`);
      }
      if (!expectsResource && prepared.resourceService !== null) {
        prepared.dispose();
        return toolError(`${entry.name} is unavailable because its exact immutable published contract did not match. Nothing was charged.`);
      }
      resourceService = prepared.resourceService;
    } catch {
      prepared?.dispose();
      return toolError(`${entry.name} is unavailable because its exact immutable published contract could not be prepared. Nothing was charged.`);
    }
  } else if (expectsResource) {
      return toolError(`${entry.name} is unavailable because its exact immutable resource contract could not be prepared. Nothing was charged.`);
  }

  if (billable && callerId !== null) {
    try {
      const debit = await deps.repo.createCredit({
        ownerId: callerId,
        deltaUsdc: -price,
        reason: `${REASON_SPEND}:${agent.id}`,
        tx: null,
      });
      paymentCreditId = debit.id;
      await deps.repo.createCredit({
        ownerId: creatorId,
        deltaUsdc: price,
        reason: `${REASON_EARN}:${agent.id}`,
        tx: null,
      });
    } catch (error: unknown) {
      prepared?.dispose();
      console.error("mcp credit debit failed", error);
      return toolError("Billing is unavailable right now. No call was made and nothing was charged.");
    }
  }

  /** Put the money back exactly as it was taken. */
  const reverse = async (): Promise<void> => {
    if (!billable || callerId === null) return;
    try {
      await deps.repo.createCredit({
        ownerId: callerId,
        deltaUsdc: price,
        reason: `${REASON_REFUND}:${agent.id}`,
        tx: null,
      });
      await deps.repo.createCredit({
        ownerId: creatorId,
        deltaUsdc: -price,
        reason: `${REASON_CLAWBACK}:${agent.id}`,
        tx: null,
      });
    } catch (error: unknown) {
      // A failed refund is a real money bug: log loudly, and still report the
      // run failure to the caller rather than masking it with a billing error.
      console.error("mcp refund failed", { agentId: agent.id, callerId }, error);
    }
  };

  let summary: McpAgentRunSummary;
  try {
    summary = prepared ? await prepared.execute() : await deps.runAgent(runInput);
  } catch (error: unknown) {
    // Opaque to the caller — a raw message can leak database, facilitator, or
    // relay internals on the money path.
    console.error("mcp agent run failed", error);
    await reverse();
    return toolError(
      `${entry.name} failed to run. ${billable ? "Your workspace was not charged." : ""}`.trim(),
    );
  } finally {
    prepared?.dispose();
  }

  if (summary.status !== "done") {
    await reverse();
    return toolError(
      `${entry.name} finished with status "${summary.status}". ${
        billable ? "Your workspace was not charged." : ""
      }`.trim(),
    );
  }

  if (expectsResource && resourceService) {
    if (!resourceRepository) {
      await reverse();
      return toolError(`${entry.name} finished, but its resource receipt could not be recorded. ${billable ? "Your workspace was not charged." : ""}`.trim());
    }
    try {
      const envelope = await buildAndPersistResourceRunEnvelope({
        service: resourceService,
        summary: {
          runId: summary.runId,
          status: summary.status === "done" ? "done" : "error",
          totalCostUsdc: summary.totalCostUsdc,
          outputs: summary.outputs as Record<string, Record<string, unknown>>,
        },
        payment: {
          priceUsdc: resourceService.priceUsdc,
          state: billable ? "credited" : "free",
          paymentId: paymentCreditId,
        },
        repository: resourceRepository,
      });
      const advertisedSchema = resourceService.responseSchema ?? resourceRunEnvelopeSchema(resourceService.outputSchema);
      if (!resourceRunEnvelopeAccepts(advertisedSchema, envelope)) throw new TypeError("invalid resource envelope");
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        isError: false,
        structuredContent: envelope,
      };
    } catch {
      await reverse();
      return toolError(`${entry.name} finished, but its resource receipt could not be recorded. ${billable ? "Your workspace was not charged." : ""}`.trim());
    }
  }

  const result = summary.result ?? null;
  return {
    content: [{ type: "text", text: JSON.stringify(summary.outputs) }],
    isError: false,
    structuredContent: {
      runId: summary.runId,
      outputs: summary.outputs,
      ...(result ? { result } : {}),
      chargedUsdc: billable ? price : 0,
    },
  };
}
