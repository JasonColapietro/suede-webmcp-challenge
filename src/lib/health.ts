// server-only — imported by the /api/health route, the /status.json route, the
// cron recorder, and the /status server component. NEVER import this into a
// client component: it performs outbound dependency probes and pulls the
// server-only x402 facilitator config, which would break the client bundle.

import { getRepo } from "./db/repo";
import type { AgentRecord, FlowRepo } from "./db/repo";
import { getProjectRepo } from "./projects/provider";
import type { ProjectRepo } from "./projects/repo";
import { facilitatorChain } from "./rails/x402-verify";

export type ProbeStatus = "ok" | "degraded" | "down";

export interface DependencyProbe {
  ok: boolean;
  /** Round-trip latency of the probe in whole milliseconds. */
  latencyMs: number;
}

export interface SettlementReadiness {
  /**
   * True only when X402_SKIP_SETTLEMENT === "false" (platform-level live
   * settlement). False means every paid call is dry-run regardless of any
   * per-agent opt-in.
   */
  envLive: boolean;
  /**
   * Live agents priced above zero whose flow holds no active Live
   * deployment. Their paid (non-dry-run) calls fail with 503 "published run
   * unavailable", so any non-zero count means sellable agents cannot earn.
   * Null when the count could not be computed inside the probe budget; the
   * probe itself never throws.
   */
  pricedAgentsWithoutLiveDeployment: number | null;
}

export interface HealthReport {
  status: ProbeStatus;
  db: DependencyProbe;
  gateway: DependencyProbe;
  facilitator: DependencyProbe;
  /** Settlement env state + launch-rail coverage. Informational: never affects `status`. */
  settlement: SettlementReadiness;
  /** ISO-8601 timestamp the probes completed. */
  checkedAt: string;
}

/** Per-probe timeout. Short so a hung dependency never stalls the request. */
const PROBE_TIMEOUT_MS = 2_500;

export interface ProbeOptions {
  /**
   * When set, probe fetches cache for this many seconds (Next.js
   * `next: { revalidate }`), so a cached page (e.g. /status, revalidate=60)
   * reuses one probe result across its window instead of forcing per-request
   * dynamic rendering. Omit for always-fresh probes (external monitors,
   * /status.json, the cron recorder).
   */
  revalidateSeconds?: number;
}

/**
 * Derive the overall status from the three dependency probes.
 *  - core DB down          => "down"     (the studio cannot serve)
 *  - any non-core dep down => "degraded" (gateway or facilitator)
 *  - all ok                => "ok"
 * Pure and exported so the rule can be unit-tested without the network.
 */
export function deriveHealthStatus(
  db: DependencyProbe,
  gateway: DependencyProbe,
  facilitator: DependencyProbe,
): ProbeStatus {
  if (!db.ok) return "down";
  if (!gateway.ok || !facilitator.ok) return "degraded";
  return "ok";
}

/**
 * The LLM model gateway base to probe (non-mutating, unauthenticated). Mirrors
 * createLlmFromEnv's provider priority (Anthropic first, else OpenRouter). Both
 * `/v1/models` endpoints answer without our key — a 401 still proves the host
 * is up — and we send no Authorization header, so no secret is ever exposed.
 * Override with HEALTH_GATEWAY_URL when ops points the gateway elsewhere.
 */
function gatewayProbeUrl(): string {
  const override = process.env.HEALTH_GATEWAY_URL?.trim();
  if (override) return override;
  if (process.env.ANTHROPIC_API_KEY) return "https://api.anthropic.com/v1/models";
  return "https://openrouter.ai/api/v1/models";
}

/**
 * The x402 facilitator base to probe. Reuses the real configured chain from
 * x402-verify so the probe always targets the live facilitator. GET only —
 * never the mutating /verify or /settle paths. Override with
 * HEALTH_FACILITATOR_URL if a dedicated health path is preferred.
 */
function facilitatorProbeUrl(): string {
  const override = process.env.HEALTH_FACILITATOR_URL?.trim();
  if (override) return override;
  const [primary] = facilitatorChain();
  return primary;
}

/** Race a non-abortable promise (e.g. a DB ping) against a timeout. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeDb(): Promise<DependencyProbe> {
  const start = Date.now();
  try {
    const repo = await getRepo();
    await withTimeout(repo.ping(), PROBE_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/**
 * GET a dependency's base URL and treat any response below 500 as reachable —
 * a 401/404 still proves the host is up and routing. Only a 5xx or a
 * network/timeout error counts as down. The response status and body are never
 * surfaced to callers, so no upstream error strings leak into the report.
 */
async function probeHttp(url: string, opts: ProbeOptions): Promise<DependencyProbe> {
  const start = Date.now();
  try {
    const init: RequestInit & { next?: { revalidate: number } } = {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    };
    if (opts.revalidateSeconds !== undefined) {
      init.next = { revalidate: opts.revalidateSeconds };
    } else {
      init.cache = "no-store";
    }
    const res = await fetch(url, init);
    return { ok: res.status < 500, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/** The exact reads settlementReadiness needs; narrowed so tests can inject fixtures. */
export interface SettlementReadinessStores {
  readonly repo: Pick<FlowRepo, "listLiveAgents" | "getFlow">;
  readonly projectRepo: Pick<ProjectRepo, "getActiveDeployment">;
}

async function countPricedAgentsWithoutLiveDeployment(
  stores: SettlementReadinessStores,
): Promise<number> {
  const liveAgents = await stores.repo.listLiveAgents();
  const priced: AgentRecord[] = liveAgents.filter((agent) => agent.priceUsdc > 0);
  let missing = 0;
  for (const agent of priced) {
    const flow = await stores.repo.getFlow(agent.flowId);
    if (!flow) {
      // An orphaned agent row can never resolve a Live deployment either.
      missing += 1;
      continue;
    }
    const deployment = await stores.projectRepo.getActiveDeployment({
      flowId: agent.flowId,
      environmentKind: "live",
      ownerId: flow.ownerId,
    });
    if (!deployment || deployment.status !== "live" || deployment.retiredAt !== undefined) {
      missing += 1;
    }
  }
  return missing;
}

/**
 * Settlement env state plus launch-rail coverage: how many live, priced
 * agents cannot serve a paid call because no active Live deployment exists.
 * Count failures degrade to null (unknown), never a false zero, and this
 * never throws. Stores are injectable for tests; production callers omit them.
 */
export async function settlementReadiness(
  stores?: SettlementReadinessStores,
): Promise<SettlementReadiness> {
  const envLive = process.env.X402_SKIP_SETTLEMENT === "false";
  try {
    const resolved = stores ?? {
      repo: await getRepo(),
      projectRepo: await getProjectRepo(),
    };
    const count = await withTimeout(
      countPricedAgentsWithoutLiveDeployment(resolved),
      PROBE_TIMEOUT_MS,
    );
    return { envLive, pricedAgentsWithoutLiveDeployment: count };
  } catch {
    return { envLive, pricedAgentsWithoutLiveDeployment: null };
  }
}

/**
 * Probe the three tracked dependencies in parallel and derive the overall
 * status. Every probe is wrapped in try/catch + a timeout, so this never
 * throws and never surfaces secrets, addresses, or upstream error strings.
 */
export async function runHealthProbes(opts: ProbeOptions = {}): Promise<HealthReport> {
  const [db, gateway, facilitator, settlement] = await Promise.all([
    probeDb(),
    probeHttp(gatewayProbeUrl(), opts),
    probeHttp(facilitatorProbeUrl(), opts),
    settlementReadiness(),
  ]);
  return {
    status: deriveHealthStatus(db, gateway, facilitator),
    db,
    gateway,
    facilitator,
    settlement,
    checkedAt: new Date().toISOString(),
  };
}

export type UptimeWindowKey = "7d" | "30d" | "90d";

export interface UptimeWindow {
  /** Window length in milliseconds. */
  ms: number;
  /**
   * Minimum recorded checks before a percentage is published for this window.
   * Below it, /status shows "Measuring since <date>" instead of a number — a
   * short run of hourly checks is not yet a defensible uptime figure.
   */
  minSamples: number;
  /** Human label used in copy ("7 days"). */
  label: string;
}

/**
 * The three published availability windows. Ordered longest-first for display.
 * minSamples targets roughly 70% coverage of the window's hourly checks, so a
 * percentage only appears once a window is meaningfully filled.
 */
export const UPTIME_WINDOWS: Record<UptimeWindowKey, UptimeWindow> = {
  "90d": { ms: 90 * 86_400_000, minSamples: 1_500, label: "90 days" },
  "30d": { ms: 30 * 86_400_000, minSamples: 500, label: "30 days" },
  "7d": { ms: 7 * 86_400_000, minSamples: 120, label: "7 days" },
};

/**
 * Availability percentage = the share of checks that were NOT a major outage
 * (status !== "down"), rounded to one decimal. Returns null when there are no
 * checks or the sample is below the window's threshold — the page must never
 * publish a number it cannot defend. Always computed live from the counts;
 * never a stored constant.
 */
export function availabilityPct(
  total: number,
  down: number,
  minSamples: number,
): number | null {
  if (total <= 0 || total < minSamples) return null;
  const available = total - down;
  return Math.round((available / total) * 1000) / 10;
}
