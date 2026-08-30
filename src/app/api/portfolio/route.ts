/**
 * GET /api/portfolio — real settlement data for the owner's launched agents,
 * shaped into the portfolio read-model building blocks (agents + per-day rolls
 * + recent runs). The /portfolio page layers any manual additions on top of this
 * client-side. Reconstructs the time-series from raw `runs` (no schema changes).
 */
import { NextResponse } from "next/server";
import { privateJson } from "@/lib/projects/api-response";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { dayKey, MS_DAY, startOfUtcDay } from "@/lib/portfolio/dates";
import type { Agent, AgentStatus, DailyRoll, Earning } from "@/lib/portfolio/types";

export const runtime = "nodejs";

// Cap raw runs pulled for the time-series. Plenty for a single operator; a
// dedicated repo method (listSettledRunsByOwner) is the scale-up path.
const RUNS_LIMIT = 5000;

export async function GET(): Promise<NextResponse> {
  try {
    const owner = await resolveOwnerId();
    const repo = await getRepo();
    const [flows, agentRecords, runs, wallet] = await Promise.all([
      repo.listFlows(owner),
      repo.listAgentsByOwner(owner),
      repo.listRunsByOwner(owner, RUNS_LIMIT),
      repo.getWallet(owner),
    ]);

    const flowName = new Map(flows.map((f) => [f.id, f.name]));
    const priceById = new Map(agentRecords.map((a) => [a.id, a.priceUsdc]));
    const ownerWallet = wallet?.address ?? "";
    const now = new Date();
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const dailyMap = new Map<string, DailyRoll>(); // `${agentId}|${day}`
    const runsByAgent = new Map<string, Earning[]>();
    const acc = new Map<string, { total: number; last7: number; err7: number; lastTs: number }>();
    const sevenAgo = startOfUtcDay(now).getTime() - 6 * MS_DAY;
    const threeAgo = startOfUtcDay(now).getTime() - 2 * MS_DAY;

    for (const r of runs) {
      if (!r.agentId || r.trigger !== "agent") continue; // external paid calls only
      const price = priceById.get(r.agentId) ?? 0;
      const settled = !!r.settledAt;
      const tsMs = r.settledAt ? new Date(r.settledAt).getTime() : r.startedAt;
      const day = dayKey(new Date(tsMs));
      // Full price, not splitCall().creatorUsdc: x402 settlement routes 100%
      // of each call to the creator's wallet (resolvePayout → single payTo).
      // Switch back to the PLATFORM_TAKE_RATE split once split collection
      // exists at settlement.
      const creatorShare = price;

      const key = `${r.agentId}|${day}`;
      let roll = dailyMap.get(key);
      if (!roll) {
        roll = { agentId: r.agentId, day, calls: 0, revenueUsdc: 0, errors: 0 };
        dailyMap.set(key, roll);
      }
      roll.calls += 1;
      if (settled) roll.revenueUsdc += creatorShare;
      if (r.status === "error") roll.errors += 1;

      const list = runsByAgent.get(r.agentId) ?? [];
      list.push({
        agentId: r.agentId,
        ts: new Date(tsMs).toISOString(),
        callId: r.id,
        grossUsdc: price,
        amountUsdc: settled ? creatorShare : 0,
        settled,
      });
      runsByAgent.set(r.agentId, list);

      const a = acc.get(r.agentId) ?? { total: 0, last7: 0, err7: 0, lastTs: 0 };
      a.total += 1;
      a.lastTs = Math.max(a.lastTs, tsMs);
      if (tsMs >= sevenAgo) {
        a.last7 += 1;
        if (r.status === "error") a.err7 += 1;
      }
      acc.set(r.agentId, a);
    }

    function healthFor(rec: { id: string; status: "draft" | "live" }): AgentStatus {
      if (rec.status === "draft") return "draft";
      const a = acc.get(rec.id);
      if (!a || a.total === 0) return "live";
      if (a.lastTs < threeAgo) return "down"; // had calls, silent ~3 days
      if (a.last7 > 0 && a.err7 / a.last7 > 0.15) return "degraded";
      return "live";
    }

    const agents: Agent[] = agentRecords.map((a) => ({
      id: a.id,
      name: flowName.get(a.flowId) ?? a.slug,
      slug: a.slug,
      ownerWallet,
      x402Url: `/a/${a.slug}`,
      priceUsdc: a.priceUsdc,
      category: "x402",
      launchedAt: new Date(a.createdAt).toISOString(),
      status: healthFor(a),
      manual: false,
    }));

    const daily = [...dailyMap.values()].map((r) => ({ ...r, revenueUsdc: round2(r.revenueUsdc) }));
    const recentRuns: Record<string, Earning[]> = {};
    for (const [id, list] of runsByAgent) {
      recentRuns[id] = list.sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, 14);
    }

    return privateJson({ ownerWallet, now: now.toISOString(), agents, daily, recentRuns });
  } catch (err) {
    if (err instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: err.message }, err.status);
    }
    console.error("[/api/portfolio]", err);
    return privateJson({ error: "failed to load portfolio" }, 500);
  }
}
