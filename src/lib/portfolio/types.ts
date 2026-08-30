/**
 * Portfolio domain types for the Studio's /portfolio earnings dashboard.
 * Ported from the standalone Agentix tracker so the two stay in lockstep.
 */
export type AgentStatus = "live" | "degraded" | "down" | "draft" | "paused";

export interface Agent {
  id: string;
  name: string;
  ownerWallet: string;
  x402Url: string;
  slug: string;
  priceUsdc: number;
  category: string;
  launchedAt: string;
  status: AgentStatus;
  /** True when the row was hand-added/overridden by the owner (vs. real settlement data). */
  manual?: boolean;
}

export interface Earning {
  agentId: string;
  ts: string;
  callId: string;
  amountUsdc: number;
  grossUsdc: number;
  settled: boolean;
}

export interface DailyRoll {
  agentId: string;
  day: string;
  calls: number;
  revenueUsdc: number;
  errors: number;
}

export interface DailyPoint {
  day: string;
  calls: number;
  revenueUsdc: number;
  errors: number;
}

export interface AgentStats {
  calls: number;
  revenueUsdc: number;
  grossUsdc: number;
  errors: number;
  lastActiveAt: string | null;
  spark: number[];
}

export interface AgentWithStats extends Agent {
  stats: AgentStats;
}

export interface PortfolioSummary {
  ownerWallet: string;
  totalRevenueUsdc: number;
  totalGrossUsdc: number;
  totalCalls: number;
  activeAgents: number;
  agentCount: number;
  trend: DailyPoint[];
  delta7d: number;
  revenue7d: number;
}

export interface AgentDetail extends AgentWithStats {
  daily: DailyRoll[];
  recentRuns: Earning[];
  delta7d: number;
}
