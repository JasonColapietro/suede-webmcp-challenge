/**
 * Gateway run handler — executes ONE platform node server-side.
 *
 * Auth: Authorization: Bearer <workspaceKey>
 * Rate limit: 20 burst / 20 per minute per owner (same bucket as llm gateway).
 * Meters usage (kind="run", units=1).
 *
 * Paid-rail nodes (suede.* group, priceUsdc > 0) are blocked when the owner
 * has neither free allowance remaining nor sufficient gateway credit.
 *
 * Server-only — imports registry/executors, must NEVER be imported client-side.
 */
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { FREE_MONTHLY_GATEWAY_TOKENS, gatewayCostUsdc } from "@/lib/billing";
import { getNodeMeta, NODE_TYPE_SET } from "@/lib/flow/node-meta";
import {
  isNodeTypeAvailable,
  type NodeAvailabilityProjection,
} from "@/lib/flow/node-definitions";
import { CONNECTOR_LAB_FLAG } from "@/lib/connectors/flags";
import {
  createNodeExecutionProvenance,
  executeSelectedNode,
  selectNodeDispatch,
} from "@/lib/flow/executor";
import type { FlowRepo } from "@/lib/db/repo";
import type { NodeType } from "@/lib/flow/types";
import { loadGatewayNode, type GatewayNodeLoader } from "@/lib/gateway/node-loader";
import { freeAllowanceEligible } from "@/lib/gateway/eligibility";
import { resourceQueryNodeParamsSchema } from "@/lib/flow/nodes/resources/query";

// Per-IP request rate limit — a fresh workspace key resets the per-owner bucket,
// but the source IP does not. Same shape as the LLM gateway. 30 burst / 30 pm.
const GATEWAY_IP_BURST = 30;
const GATEWAY_IP_REFILL_PER_SEC = 0.5;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ResourceQueryGatewayInputsSchema = z.object({
  filters: z.record(z.string(), z.unknown()),
}).strict();

export const GatewayRunBodySchema = z.object({
  nodeType: z.string().min(1, "nodeType is required"),
  config: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((body, ctx) => {
  if (body.nodeType !== "resource.query") {
    if (body.inputs !== undefined) {
      ctx.addIssue({ code: "custom", path: ["inputs"], message: "Inputs are not supported for this node" });
    }
    return;
  }
  if (!resourceQueryNodeParamsSchema.safeParse(body.config).success) {
    ctx.addIssue({ code: "custom", path: ["config"], message: "Invalid resource.query config" });
  }
  if (!ResourceQueryGatewayInputsSchema.safeParse(body.inputs).success) {
    ctx.addIssue({ code: "custom", path: ["inputs"], message: "Invalid resource.query inputs" });
  }
});

export type GatewayRunBody = z.infer<typeof GatewayRunBodySchema>;
// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type GatewayRunResult =
  | { ok: true; output: unknown; costUsdc: number }
  | { ok: false; status: 400 | 401 | 402 | 429 | 500 | 503; error: string };

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Execute a single platform node via the gateway.
 *
 * @param ownerId   - Resolved workspace owner (already authenticated).
 * @param body      - Parsed + validated request body.
 * @param repo      - FlowRepo for usage + credit reads/writes.
 * @param nowMs     - Optional clock override for tests.
 * @param ip        - Client IP for the per-IP limit (omit/"unknown" → skipped).
 */
export async function handleGatewayRun(
  ownerId: string,
  body: GatewayRunBody,
  repo: FlowRepo,
  nowMs: number = Date.now(),
  ip?: string,
  availability: NodeAvailabilityProjection = CONNECTOR_LAB_FLAG,
  nodeLoader: GatewayNodeLoader = loadGatewayNode,
): Promise<GatewayRunResult> {
  if (body.nodeType === "api.operation" &&
      !isNodeTypeAvailable(body.nodeType, availability, "executable")) {
    return {
      ok: false,
      status: 400,
      error: `Unknown or unavailable node type: ${body.nodeType}. See /api/catalog for available types.`,
    };
  }
  // Rate limit: same config as LLM gateway — 20 burst per owner.
  const rl = checkRateLimit(`gateway-run:${ownerId}`, { capacity: 20, refillPerSec: 20 / 60 }, nowMs);
  if (!rl.allowed) {
    return { ok: false, status: 429, error: `Rate limited. Retry after ${rl.retryAfterSec}s.` };
  }

  // Per-IP request rate limit — throttles UUID-farming bursts (new key, same IP).
  if (typeof ip === "string" && ip.length > 0 && ip !== "unknown") {
    const ipRl = checkRateLimit(
      `gateway-run-ip:${ip}`,
      { capacity: GATEWAY_IP_BURST, refillPerSec: GATEWAY_IP_REFILL_PER_SEC },
      nowMs,
    );
    if (!ipRl.allowed) {
      return { ok: false, status: 429, error: `Rate limited (network). Retry after ${ipRl.retryAfterSec}s.` };
    }
  }

  if (!NODE_TYPE_SET.has(body.nodeType) ||
      !isNodeTypeAvailable(body.nodeType, availability, "executable")) {
    return {
      ok: false,
      status: 400,
      error: `Unknown or unavailable node type: ${body.nodeType}. See /api/catalog for available types.`,
    };
  }

  const meta = getNodeMeta(body.nodeType as never);
  const nodePrice = meta?.priceUsdc ?? 0;
  const isPaidRail = nodePrice > 0;

  if (isPaidRail) {
    // Check credit balance — must cover the node cost.
    let balance = 0;
    try {
      balance = await repo.getCreditBalance(ownerId);
    } catch {
      // credits table absent — billing not provisioned, gate paid-rail nodes.
      return {
        ok: false,
        status: 503,
        error: "billing not provisioned",
      };
    }
    if (balance < nodePrice) {
      return {
        ok: false,
        status: 402,
        error: `Insufficient gateway credit ($${balance.toFixed(6)} < $${nodePrice.toFixed(6)} required). Top up at /api/gateway/topup.`,
      };
    }
  } else {
    // Free-tier nodes: the allowance is earned by having paid, exactly as on
    // the LLM gateway. Without this the free branch was reachable by any
    // freshly-minted workspace UUID with no payment and no age check at all.
    const eligible = await freeAllowanceEligible(ownerId, repo);
    if (!eligible) {
      return {
        ok: false,
        status: 402,
        error:
          "The free monthly gateway allowance is included with any paid workspace. Top up at /api/gateway/topup.",
      };
    }
    const monthlyUnits = await repo.sumMonthlyUsage(ownerId, "run").catch(() => 0);
    if (monthlyUnits >= FREE_MONTHLY_GATEWAY_TOKENS) {
      return {
        ok: false,
        status: 402,
        error: `Monthly gateway run limit (${FREE_MONTHLY_GATEWAY_TOKENS.toLocaleString()}) reached. Top up at /api/gateway/topup.`,
      };
    }
  }

  // Load only the requested definition. The normal graph runtime still uses
  // the full registry; this handler's contract is exactly one node.
  let def: import("@/lib/flow/executor").NodeDef | undefined;
  try {
    def = await nodeLoader(body.nodeType as NodeType);
  } catch {
    return { ok: false, status: 503, error: "executor unavailable" };
  }

  if (!def) {
    return { ok: false, status: 400, error: `Node type not executable: ${body.nodeType}` };
  }

  // Build a minimal NodeContext (dry-run: gateway never settles x402 itself).
  let context: import("@/lib/flow/executor").NodeContext;
  try {
    const { buildGatewayRunContext } = await import("@/lib/gateway/run-context");
    context = buildGatewayRunContext(ownerId, `gateway-run-${ownerId}-${nowMs}`, def);
  } catch {
    return { ok: false, status: 503, error: "run context unavailable" };
  }

  let output: unknown;
  let costUsdc = 0;
  try {
    // Select before evaluating either parameter path. The gateway currently
    // has static config only, but using the same authority as graph execution
    // keeps guarded dry runs from ever drifting onto the real executor path.
    const selection = selectNodeDispatch(def, context);
    const parsed = def.paramsSchema.safeParse(body.config);
    const params: unknown = parsed.success ? parsed.data : body.config;
    const inputs = body.nodeType === "resource.query" ? body.inputs ?? {} : {};
    const result = await executeSelectedNode(
      selection,
      context,
      { params, provenance: createNodeExecutionProvenance({}) },
      inputs,
    );
    if (!result.ok) {
      return { ok: false, status: 500, error: result.error ?? "executor error" };
    }
    output = result.outputs;
    costUsdc = result.costUsdc;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "executor threw";
    return { ok: false, status: 500, error: message };
  }

  // Meter: one run unit, cost derived from node price or gateway cost formula.
  const billedCost = isPaidRail ? nodePrice : gatewayCostUsdc(1);
  await repo.createUsage({ ownerId, kind: "run", units: 1, costUsdc: billedCost }).catch(() => {
    // Non-fatal — best-effort metering.
  });

  // Debit credit for paid-rail nodes.
  if (isPaidRail) {
    await repo.createCredit({ ownerId, deltaUsdc: -billedCost, reason: `node:${body.nodeType}` }).catch(() => {
      // Non-fatal.
    });
  }

  return { ok: true, output, costUsdc: costUsdc || billedCost };
}
