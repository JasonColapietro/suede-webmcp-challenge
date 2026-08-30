/**
 * Client store for /portfolio: REAL settlement data (from /api/portfolio) with a
 * MANUAL overlay (localStorage) layered on top — extra agents the owner tracks,
 * plus per-day number overrides. Manual data is per-browser (single operator);
 * graduating it to a server table is the cross-device upgrade.
 */
import type {
  Agent,
  AgentDetail,
  AgentStatus,
  AgentWithStats,
  DailyRoll,
  Earning,
  PortfolioSummary,
} from "./types";
import { dayKey, windowKeys } from "./dates";
import { detailFor, summarize, withStatsAll } from "./aggregate";

const KEY = "suede.portfolio.manual.v1";

export interface RealData {
  ownerWallet: string;
  now: string; // ISO
  agents: Agent[];
  daily: DailyRoll[];
  recentRuns: Record<string, Earning[]>;
}

export interface AgentInput {
  name: string;
  x402Url: string;
  ownerWallet: string;
  priceUsdc: number;
  category: string;
  status: AgentStatus;
  launchedAt: string;
}

export interface EntryInput {
  agentId: string;
  day: string;
  calls: number;
  revenueUsdc: number;
  errors?: number;
}

interface Manual {
  agents: Agent[];
  entries: DailyRoll[];
}

const empty = (): Manual => ({ agents: [], entries: [] });

export function loadManual(): Manual {
  if (typeof window === "undefined") return empty();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return empty();
    const p = JSON.parse(raw) as Partial<Manual>;
    return { agents: p.agents ?? [], entries: p.entries ?? [] };
  } catch {
    return empty();
  }
}

function saveManual(m: Manual): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(m));
  window.dispatchEvent(new Event("suede:portfolio"));
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function newId(): string {
  return `man_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normLaunch(s: string): string {
  return s.length === 10 ? `${s}T12:00:00.000Z` : s;
}

// ── mutations ───────────────────────────────────────────────────────────────
export function addManualAgent(input: AgentInput): Agent {
  const m = loadManual();
  const agent: Agent = {
    id: newId(),
    name: input.name.trim(),
    slug: slugify(input.name),
    ownerWallet: input.ownerWallet.trim(),
    x402Url: input.x402Url.trim(),
    priceUsdc: input.priceUsdc,
    category: input.category.trim() || "Other",
    launchedAt: normLaunch(input.launchedAt),
    status: input.status,
    manual: true,
  };
  m.agents.push(agent);
  saveManual(m);
  return agent;
}

export function updateManualAgent(id: string, patch: Partial<AgentInput>): void {
  const m = loadManual();
  const a = m.agents.find((x) => x.id === id);
  if (!a) return;
  if (patch.name != null) {
    a.name = patch.name.trim();
    a.slug = slugify(patch.name);
  }
  if (patch.x402Url != null) a.x402Url = patch.x402Url.trim();
  if (patch.ownerWallet != null) a.ownerWallet = patch.ownerWallet.trim();
  if (patch.priceUsdc != null) a.priceUsdc = patch.priceUsdc;
  if (patch.category != null) a.category = patch.category.trim() || "Other";
  if (patch.status != null) a.status = patch.status;
  if (patch.launchedAt != null) a.launchedAt = normLaunch(patch.launchedAt);
  saveManual(m);
}

export function removeManualAgent(id: string): void {
  const m = loadManual();
  m.agents = m.agents.filter((a) => a.id !== id);
  m.entries = m.entries.filter((e) => e.agentId !== id);
  saveManual(m);
}

/** Log/override a day for any agent (real or manual). Manual wins over real. */
export function logManualEntry(input: EntryInput): void {
  const m = loadManual();
  m.entries = m.entries.filter((e) => !(e.agentId === input.agentId && e.day === input.day));
  m.entries.push({
    agentId: input.agentId,
    day: input.day,
    calls: Math.max(0, Math.round(input.calls)),
    revenueUsdc: Math.max(0, input.revenueUsdc),
    errors: Math.max(0, Math.round(input.errors ?? 0)),
  });
  saveManual(m);
}

export function clearManual(): void {
  saveManual(empty());
}

// ── merge + read-models ──────────────────────────────────────────────────────
function mergedDailyMap(real: RealData, manual: Manual): Map<string, DailyRoll> {
  const map = new Map<string, DailyRoll>();
  for (const r of real.daily) map.set(`${r.agentId}|${r.day}`, r);
  for (const e of manual.entries) map.set(`${e.agentId}|${e.day}`, e); // manual overrides
  return map;
}

function agentDailyWindow(agent: Agent, map: Map<string, DailyRoll>, now: Date): DailyRoll[] {
  // Records saved before the form validated launchedAt can hold an Invalid
  // Date; dayKey would throw and brick every portfolio surface. Fall back to
  // the full window ("" sorts before every day-key) so the agent still
  // renders and its date can be repaired from the Edit form.
  const launchMs = Date.parse(agent.launchedAt);
  const launchDay = Number.isNaN(launchMs) ? "" : dayKey(new Date(launchMs));
  return windowKeys(now)
    .filter((d) => d >= launchDay)
    .map((d) => map.get(`${agent.id}|${d}`) ?? { agentId: agent.id, day: d, calls: 0, revenueUsdc: 0, errors: 0 });
}

function allAgents(real: RealData, manual: Manual): Agent[] {
  const realIds = new Set(real.agents.map((a) => a.id));
  return [...real.agents, ...manual.agents.filter((a) => !realIds.has(a.id))];
}

export interface PortfolioView {
  ownerWallet: string;
  nowISO: string;
  summary: PortfolioSummary;
  agents: AgentWithStats[];
}

export function buildView(real: RealData, manual: Manual = loadManual()): PortfolioView {
  const now = new Date(real.now);
  const map = mergedDailyMap(real, manual);
  const agents = allAgents(real, manual);
  const dailyByAgent = new Map<string, DailyRoll[]>();
  for (const a of agents) dailyByAgent.set(a.id, agentDailyWindow(a, map, now));
  const runsByAgent = new Map<string, Earning[]>(Object.entries(real.recentRuns));
  const flat = [...dailyByAgent.values()].flat();
  return {
    ownerWallet: real.ownerWallet,
    nowISO: real.now,
    summary: summarize(real.ownerWallet, agents, flat, now),
    agents: withStatsAll(agents, dailyByAgent, runsByAgent),
  };
}

export interface AgentView {
  nowISO: string;
  isManual: boolean;
  agent: AgentDetail;
}

export function buildAgentView(real: RealData, id: string, manual: Manual = loadManual()): AgentView | null {
  const now = new Date(real.now);
  const agents = allAgents(real, manual);
  const agent = agents.find((a) => a.id === id || a.slug === id);
  if (!agent) return null;
  const map = mergedDailyMap(real, manual);
  const daily = agentDailyWindow(agent, map, now);
  const runs = real.recentRuns[agent.id] ?? [];
  return { nowISO: real.now, isManual: !!agent.manual, agent: detailFor(agent, daily, runs, now) };
}

export async function fetchPortfolio(): Promise<RealData> {
  const res = await fetch("/api/portfolio", { cache: "no-store" });
  if (!res.ok) throw new Error(`portfolio fetch failed: ${res.status}`);
  return (await res.json()) as RealData;
}
