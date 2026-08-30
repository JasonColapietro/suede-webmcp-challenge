/**
 * Cron tick — invoked by an external scheduler (Vercel Cron). Finds every due
 * schedule and runs its agent's flow to completion, then stamps the schedule
 * as run. The run mode follows the same rule as a manual agent run: it
 * settles live only when BOTH the platform (X402_SKIP_SETTLEMENT) and the
 * agent (settlementLive) are live; an agent that hasn't opted into live
 * settlement always stays dry-run on its schedule. Both GET and POST are
 * supported so platform crons (GET) and manual triggers (POST) both work.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  AP2_TERMINAL_EVIDENCE_SCRUB_BATCH_LIMIT,
  getRepo,
  resolveAp2TerminalEvidenceRetentionDays,
} from "@/lib/db/repo";
import { runPublishedLiveToCompletion, runToCompletion } from "@/lib/run-service";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { resolveRunMode } from "@/lib/run-mode";
import { runHealthProbes } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tighter bucket for the tick endpoint: 4 burst, 1 per 30s refill.
 *  The Vercel cron fires hourly so this never affects it; the limit
 *  only blocks unexpected external callers hammering the endpoint. */
const TICK_RL_OPTS = { capacity: 4, refillPerSec: 1 / 30 };

function authorizedCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return false;
  const expected = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  const supplied = createHash("sha256").update(req.headers.get("authorization") ?? "", "utf8").digest();
  return timingSafeEqual(expected, supplied);
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function liveUnavailable(): NextResponse {
  return NextResponse.json({ error: "connection service unavailable" }, { status: 503 });
}

async function tick(req: Request): Promise<NextResponse> {
  if (!authorizedCronRequest(req)) return unauthorized();
  const ip = ipFromRequest(req);
  const rl = checkRateLimit(`tick:${ip}`, TICK_RL_OPTS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: `Too many requests. Retry after ${rl.retryAfterSec}s.` },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSec) },
      },
    );
  }

  try {
    const now = Date.now();
    const repo = await getRepo();

    // Record one infra health snapshot per authorized tick — a free hourly
    // recording hook that bolts onto the existing cron with zero new cost (see
    // src/lib/health.ts). Best-effort: a probe or write failure here must never
    // break the schedule run below, so it is fully isolated in its own catch.
    try {
      const report = await runHealthProbes();
      await repo.recordHealthCheck({
        status: report.status,
        dbOk: report.db.ok,
        dbLatencyMs: report.db.latencyMs,
        gatewayOk: report.gateway.ok,
        gatewayLatencyMs: report.gateway.latencyMs,
        facilitatorOk: report.facilitator.ok,
        facilitatorLatencyMs: report.facilitator.latencyMs,
      });
    } catch {
      // Health recording is best-effort and must not affect schedule execution.
    }

    // Terminal AP2 response bodies and signed receipt payloads are retained
    // only for the configured bounded window. Replay, settlement, state, run,
    // transaction, and receipt-reference facts remain durable indefinitely.
    // Cleanup is independently best-effort so storage trouble never blocks a
    // due schedule or changes the authenticated tick response contract.
    if (typeof repo.scrubExpiredAp2TerminalEvidence === "function") {
      try {
        const retentionDays = resolveAp2TerminalEvidenceRetentionDays(
          process.env.AP2_TERMINAL_EVIDENCE_RETENTION_DAYS,
        );
        await repo.scrubExpiredAp2TerminalEvidence({
          terminalBefore: new Date(now - retentionDays * 86_400_000).toISOString(),
          scrubbedAt: new Date(now).toISOString(),
          limit: AP2_TERMINAL_EVIDENCE_SCRUB_BATCH_LIMIT,
        });
      } catch {
        console.error("AP2 terminal evidence cleanup failed");
      }
    }

    const due = await repo.dueSchedules(now);

    // Read once per tick, not per schedule — every due schedule this tick
    // sees the same platform-live state.
    const globalLive = process.env.X402_SKIP_SETTLEMENT === "false";

    for (const schedule of due) {
      const agent = await repo.getAgent(schedule.agentId);
      // Unpublishing intentionally preserves the schedule row and immutable
      // deployment history, but no non-live agent may execute from cron.
      if (agent?.status === "live") {
        const flow = await repo.getFlow(agent.flowId);
        if (flow) {
          const { dryRun } = resolveRunMode({
            requestedDryRun: false,
            globalLive,
            agentSettlementLive: agent.settlementLive,
          });
          if (dryRun) {
            await runToCompletion(flow.graph, {
              trigger: "schedule",
              agentId: agent.id,
              flowId: flow.id,
              dryRun: true,
            });
          } else {
            const result = await runPublishedLiveToCompletion({
              flowId: flow.id,
              ownerId: flow.ownerId,
              agentId: agent.id,
              trigger: "schedule",
            });
            if (!result) return liveUnavailable();
          }
        }
      }
      await repo.markScheduleRun(schedule.id, now);
    }

    return NextResponse.json({ ran: due.length });
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("cron tick route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  return tick(req);
}

export async function POST(req: Request): Promise<NextResponse> {
  return tick(req);
}
