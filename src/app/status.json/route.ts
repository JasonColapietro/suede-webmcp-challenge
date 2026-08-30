/**
 * Machine-readable status: current dependency probes plus availability computed
 * live from recorded checks over 7/30/90-day windows. `pct` is null until a
 * window has enough samples to publish a defensible figure — never a stored
 * constant. Shaped for monitors and agents that would rather parse JSON than
 * scrape /status.
 */
import { NextResponse } from "next/server";
import {
  availabilityPct,
  runHealthProbes,
  UPTIME_WINDOWS,
  type UptimeWindowKey,
} from "@/lib/health";
import { getRepo } from "@/lib/db/repo";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_RL_OPTS = { capacity: 60, refillPerSec: 1 };

interface WindowAvailability {
  pct: number | null;
  total: number;
  since: string | null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const ip = ipFromRequest(req);
  const rl = checkRateLimit(`status-json:${ip}`, STATUS_RL_OPTS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: `Too many requests. Retry after ${rl.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const report = await runHealthProbes();

  const now = Date.now();
  const repo = await getRepo();
  const windowKeys = Object.keys(UPTIME_WINDOWS) as UptimeWindowKey[];
  const availabilityEntries = await Promise.all(
    windowKeys.map(async (key): Promise<[UptimeWindowKey, WindowAvailability]> => {
      const window = UPTIME_WINDOWS[key];
      const stats = await repo.getHealthUptime(now - window.ms);
      return [
        key,
        {
          pct: availabilityPct(stats.total, stats.down, window.minSamples),
          total: stats.total,
          since: stats.firstAt,
        },
      ];
    }),
  );
  const availability = Object.fromEntries(availabilityEntries) as Record<
    UptimeWindowKey,
    WindowAvailability
  >;

  return NextResponse.json(
    {
      status: report.status,
      dependencies: {
        db: { ok: report.db.ok, latencyMs: report.db.latencyMs },
        gateway: { ok: report.gateway.ok, latencyMs: report.gateway.latencyMs },
        facilitator: {
          ok: report.facilitator.ok,
          latencyMs: report.facilitator.latencyMs,
        },
      },
      availability,
      checkedAt: report.checkedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
