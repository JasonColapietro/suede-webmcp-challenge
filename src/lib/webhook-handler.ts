/**
 * Pure handler logic for POST /api/agents/[agent]/webhook.
 *
 * Extracted from the Next.js route (src/app/api/agents/[agent]/webhook/route.ts)
 * so vitest can import and exercise it directly, mirroring the existing
 * src/lib/cli/relay-handler.ts convention in this codebase.
 *
 * Route shape: POST /api/agents/[agent]/webhook, where [agent] is the
 * agent's id or slug (same convention as /api/agents/[agent]/run). This was
 * chosen over an unguessable-token URL (e.g. /api/webhooks/[token]) because
 * the actual secret already lives in a signed HMAC header, not the URL —
 * URLs leak far more easily than headers (server access logs, reverse-proxy
 * logs, Referer headers, browser history, accidental screenshots), so
 * putting the credential there instead of in the URL is strictly safer once
 * you already have real signature verification, and it keeps this route
 * discoverable the same way every other agent endpoint is (agents.ts'
 * resolveAgent, launch response `urls`).
 *
 * Body-size and content-type checks happen in the route (they require
 * streaming the raw request body before this function ever sees it); this
 * function receives the raw body as a string and owns everything after
 * that: agent resolution, signature/timestamp verification, dry-run mode
 * resolution, and running the flow.
 */
import { getRepo } from "@/lib/db/repo";
import {
  runPublishedLiveToCompletion,
  runToCompletion,
  AgentDailyCapExceededError,
} from "@/lib/run-service";
import { resolveRunMode } from "@/lib/run-mode";
import {
  WEBHOOK_DUMMY_SECRET,
  isTimestampFresh,
  verifyWebhookSignature,
} from "@/lib/webhook-auth";

export interface WebhookRequestInput {
  /** Agent id or slug, taken from the route param. */
  agentParam: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  /** Raw request body bytes as received, before JSON parsing — this is what was signed. */
  rawBody: string;
  /** Overridable clock for tests. */
  nowMs?: number;
}

export type WebhookHandlerResult =
  | {
      ok: true;
      runId: string;
      status: "done" | "error";
      totalCostUsdc: number;
      outputs: Record<string, Record<string, unknown>>;
    }
  | { ok: false; status: number; error: string };

/** Generic 401 body — identical for "agent doesn't exist", "no webhook
 *  configured", "bad signature", and "stale timestamp" so a caller can't
 *  use response differences to enumerate valid agent ids/slugs. */
const UNAUTHORIZED: WebhookHandlerResult = { ok: false, status: 401, error: "unauthorized" };

export async function handleInboundWebhook(
  input: WebhookRequestInput,
): Promise<WebhookHandlerResult> {
  const nowMs = input.nowMs ?? Date.now();
  const repo = await getRepo();

  const agent =
    (await repo.getAgent(input.agentParam)) ?? (await repo.getAgentBySlug(input.agentParam));

  const endpoint = agent ? await repo.getWebhookEndpoint(agent.id) : null;
  const flow = agent ? await repo.getFlow(agent.flowId) : null;
  // Defense against a stale secret outliving its node: if the flow no
  // longer contains a webhook trigger (the owner removed it and relaunched
  // with a different trigger), the old row must not keep authorizing calls.
  const hasWebhookNode = flow ? flow.graph.nodes.some((n) => n.type === "webhook") : false;

  // Always run a full signature check, even when nothing above resolved,
  // against a fixed dummy secret — so the timing and response shape for
  // "no such agent" and "wrong signature" are indistinguishable.
  const secret = endpoint?.secretHash ?? WEBHOOK_DUMMY_SECRET;
  const hasHeaders = input.signatureHeader !== null && input.timestampHeader !== null;
  const signatureOk =
    hasHeaders &&
    verifyWebhookSignature(
      input.timestampHeader as string,
      input.rawBody,
      secret,
      input.signatureHeader as string,
    );
  const freshOk = input.timestampHeader !== null && isTimestampFresh(input.timestampHeader, nowMs);

  const authorized =
    agent !== null &&
    agent.status === "live" &&
    endpoint !== null &&
    endpoint.agentId === agent.id &&
    flow !== null &&
    flow.id === agent.flowId &&
    typeof flow.ownerId === "string" &&
    flow.ownerId.length > 0 &&
    hasWebhookNode &&
    signatureOk &&
    freshOk;

  if (!authorized || agent === null || flow === null) {
    return UNAUTHORIZED;
  }
  let triggerInput: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.rawBody);
    triggerInput =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { body: parsed };
  } catch {
    return { ok: false, status: 400, error: "request body is not valid JSON" };
  }

  // Never let the inbound caller pick the run mode. This mirrors
  // src/app/api/cron/tick/route.ts exactly: requestedDryRun is always
  // false (a webhook delivery is a machine trigger, not a human preview),
  // so an agent that hasn't opted into live settlement stays dry-run no
  // matter what the caller sends, and a live agent never gets forced into
  // a free dry-run either.
  const globalLive = process.env.X402_SKIP_SETTLEMENT === "false";
  const { dryRun } = resolveRunMode({
    requestedDryRun: false,
    globalLive,
    agentSettlementLive: agent.settlementLive,
  });

  try {
    const summary = dryRun
      ? await runToCompletion(flow.graph, {
          trigger: "webhook",
          agentId: agent.id,
          flowId: flow.id,
          triggerInput,
          dryRun: true,
        })
      : await runPublishedLiveToCompletion({
          flowId: flow.id,
          ownerId: flow.ownerId,
          trigger: "webhook",
          agentId: agent.id,
          triggerInput,
        });
    if (!summary) return UNAUTHORIZED;
    return {
      ok: true,
      runId: summary.runId,
      status: summary.status,
      totalCostUsdc: summary.totalCostUsdc,
      outputs: summary.outputs,
    };
  } catch (error: unknown) {
    if (error instanceof AgentDailyCapExceededError) {
      return { ok: false, status: 402, error: error.message };
    }
    throw error;
  }
}
