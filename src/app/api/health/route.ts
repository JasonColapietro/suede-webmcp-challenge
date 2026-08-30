/**
 * Live liveness endpoint. GET returns the current HealthReport as JSON —
 * 200 when the studio is up (ok/degraded), 503 on a major outage (down). Built
 * for external monitors and agents, so the rate limit is generous. The report
 * carries only reachability + latencies; no secrets, addresses, or upstream
 * error strings ever appear (see src/lib/health.ts).
 */
import { NextResponse } from "next/server";
import { runHealthProbes } from "@/lib/health";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 60-request burst, refills 1/s — comfortable for a per-minute external poll. */
const HEALTH_RL_OPTS = { capacity: 60, refillPerSec: 1 };

export async function GET(req: Request): Promise<NextResponse> {
  const ip = ipFromRequest(req);
  const rl = checkRateLimit(`health:${ip}`, HEALTH_RL_OPTS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: `Too many requests. Retry after ${rl.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const report = await runHealthProbes();
  return NextResponse.json(report, {
    status: report.status === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
