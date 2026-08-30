/** Owner overview backing the /flows dashboard: my flows, agents, recent runs. */
import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { resolveSuedeIdentity } from "@/lib/suede-identity";
import { getRepo } from "@/lib/db/repo";
import { describeCron, nextOccurrence } from "@/lib/cron";
import { FREE_MONTHLY_GATEWAY_TOKENS } from "@/lib/billing";
import { privateJson } from "@/lib/projects/api-response";

export const runtime = "nodejs";

const RECENT_RUNS_LIMIT = 25;

export async function GET(): Promise<NextResponse> {
  try {
    const owner = await resolveOwnerId();
    const repo = await getRepo();
    const [flows, agents, runs, wallet] = await Promise.all([
      repo.listFlows(owner),
      repo.listAgentsByOwner(owner),
      repo.listRunsByOwner(owner, RECENT_RUNS_LIMIT),
      repo.getWallet(owner),
    ]);
    const agentIds = agents.map((a) => a.id);
    const [counts, schedules, settledCounts, usageThisMonth, creditBalance] = await Promise.all([
      // External machine calls only — scheduled self-runs don't count as demand.
      repo.countRunsByAgent(agentIds, "agent"),
      repo.listSchedulesByAgents(agentIds),
      repo.countSettledRunsByAgent(agentIds),
      repo.sumMonthlyUsage(owner, "llm").catch(() => 0),
      repo.getCreditBalance(owner).catch(() => 0),
    ]);
    const scheduleByAgent = new Map(schedules.map((s) => [s.agentId, s]));
    const now = Date.now();

    const agentsOut = agents.map((a) => {
      const calls = counts[a.id] ?? 0;
      const settled = settledCounts[a.id] ?? 0;
      const schedule = scheduleByAgent.get(a.id);
      const scheduled = schedule !== undefined && schedule.enabled;
      const earnedUsdc = calls * a.priceUsdc;
      // Full price, not splitCall().creatorUsdc: x402 settlement routes 100%
      // of each call to the creator's wallet (resolvePayout → single payTo).
      // Switch back to the PLATFORM_TAKE_RATE split once split collection
      // exists at settlement.
      const settledUsdc = settled * a.priceUsdc;
      return {
        id: a.id,
        flowId: a.flowId,
        slug: a.slug,
        status: a.status,
        priceUsdc: a.priceUsdc,
        settlementLive: a.settlementLive,
        calls,
        earnedUsdc,
        settledUsdc,
        schedule: scheduled
          ? {
              cron: schedule.cron,
              description: describeCron(schedule.cron),
              nextRunAt: nextOccurrence(schedule.cron, now),
              lastRunAt: schedule.lastRunAt,
            }
          : null,
      };
    });

    const totals = agentsOut.reduce(
      (acc, a) => ({
        earnedUsdc: acc.earnedUsdc + a.earnedUsdc,
        settledUsdc: acc.settledUsdc + a.settledUsdc,
        calls: acc.calls + a.calls,
      }),
      { earnedUsdc: 0, settledUsdc: 0, calls: 0 },
    );

    // Served from the per-instance verify cache after resolveOwnerId's call.
    const suede = await resolveSuedeIdentity();

    return privateJson({
      ownerId: owner,
      identity: suede
        ? { signedIn: true, email: suede.email }
        : { signedIn: false, email: null },
      wallet: wallet ? { address: wallet.address, network: wallet.network } : null,
      gateway: {
        usageThisMonth,
        freeMonthlyTokens: FREE_MONTHLY_GATEWAY_TOKENS,
        creditBalanceUsdc: creditBalance,
      },
      totals,
      flows: flows.map((f) => ({
        id: f.id,
        name: f.name,
        nodeCount: f.graph.nodes.length,
        updatedAt: f.updatedAt,
      })),
      agents: agentsOut,
      runs,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("me route failed", error);
    return privateJson({ error: "internal error" }, 500);
  }
}
