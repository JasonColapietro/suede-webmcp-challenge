/**
 * Regression: GET/POST /api/cron/tick ran every due schedule with a
 * hardcoded `dryRun: true`, ignoring the agent's settlementLive flag and
 * X402_SKIP_SETTLEMENT entirely — a launched agent with live settlement
 * enabled would still only ever produce synthetic dry-run output on its
 * schedule (suede.promo stub, registerIp `registered: false`, ...).
 *
 * Fix: the tick route now resolves the run mode via the same
 * `resolveRunMode` used by the manual `/api/agents/[agent]/run` route,
 * with `requestedDryRun: false` (a schedule tick carries no per-call
 * dry-run signal — it's a machine trigger, not a human preview). This
 * mirrors `tests/api-run-dryrun.test.ts`'s convention of testing the
 * mode-resolution logic directly rather than importing the route handler
 * (which pulls server-only deps the test runner can't resolve).
 */
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { resolveRunMode } from "@/lib/run-mode";

const routeControl = vi.hoisted(() => ({
  due: [] as Array<{ id: string; agentId: string; cron: string; enabled: boolean; lastRunAt: number | null }>,
  globalLive: false,
}));
const routeRepo = vi.hoisted(() => ({
  dueSchedules: vi.fn(async () => routeControl.due),
  getAgent: vi.fn(async () => ({
    id: "agent-dry", flowId: "flow-dry", slug: "dry", status: "live", priceUsdc: 0,
    createdAt: 1, settlementLive: false,
  })),
  getFlow: vi.fn(async () => ({
    id: "flow-dry", ownerId: "owner-dry", name: "Draft preview",
    graph: { id: "stored-draft", name: "Stored Draft", nodes: [], edges: [] }, updatedAt: 1,
  })),
  markScheduleRun: vi.fn(async () => undefined),
}));
const routeRunners = vi.hoisted(() => ({
  preview: vi.fn(async (_graph: unknown, _options: unknown) => ({ runId: "dry", status: "done", totalCostUsdc: 0, outputs: {} })),
  published: vi.fn(async (_options: unknown) => null),
}));

vi.mock("@/lib/db/repo", () => ({ getRepo: vi.fn(async () => routeRepo) }));
// The tick records a best-effort health snapshot before running schedules;
// mock it so this suite performs no real dependency probes.
vi.mock("@/lib/health", () => ({
  runHealthProbes: vi.fn(async () => ({
    status: "ok" as const,
    db: { ok: true, latencyMs: 1 },
    gateway: { ok: true, latencyMs: 1 },
    facilitator: { ok: true, latencyMs: 1 },
    checkedAt: "2026-07-22T00:00:00.000Z",
  })),
}));
vi.mock("@/lib/run-service", () => ({
  runToCompletion: (graph: unknown, options: unknown) => routeRunners.preview(graph, options),
  runPublishedLiveToCompletion: (options: unknown) => routeRunners.published(options),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
  ipFromRequest: () => "203.0.113.10",
}));

const CRON_SECRET = "dry-cron-secret-at-least-32-bytes";

beforeEach(() => {
  vi.clearAllMocks();
  routeControl.due = [];
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("X402_SKIP_SETTLEMENT", routeControl.globalLive ? "false" : "true");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** The exact composition src/app/api/cron/tick/route.ts now uses per due schedule. */
function scheduledRunMode(globalLive: boolean, agentSettlementLive: boolean): { dryRun: boolean } {
  return resolveRunMode({ requestedDryRun: false, globalLive, agentSettlementLive });
}

describe("scheduled cron runs respect the agent's settlement mode", () => {
  it("stays dry-run when the agent has not opted into live settlement, even if the platform is live", () => {
    expect(scheduledRunMode(true, false).dryRun).toBe(true);
  });

  it("stays dry-run when the platform is not globally live, even if the agent opted in", () => {
    expect(scheduledRunMode(false, true).dryRun).toBe(true);
  });

  it("stays dry-run when neither the platform nor the agent is live", () => {
    expect(scheduledRunMode(false, false).dryRun).toBe(true);
  });

  it("runs live only when BOTH the platform and the agent are live", () => {
    expect(scheduledRunMode(true, true).dryRun).toBe(false);
  });

  it("never forces live globally — a not-live agent stays dry-run under a live platform", () => {
    // Regression guard for "the behavior change must be gated on the agent's
    // own settlement mode, never forcing live globally."
    for (const globalLive of [true, false]) {
      expect(scheduledRunMode(globalLive, false).dryRun).toBe(true);
    }
  });

  it("runs an authenticated dry due schedule through the stored preview path with zero Live provider", async () => {
    routeControl.due = [{ id: "schedule-dry", agentId: "agent-dry", cron: "0 * * * *", enabled: true, lastRunAt: null }];
    const route = await import("@/app/api/cron/tick/route");
    const response = await route.GET(new Request("https://agents.suedeai.ai/api/cron/tick", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }));

    expect(response.status).toBe(200);
    expect(routeRunners.published).not.toHaveBeenCalled();
    expect(routeRunners.preview).toHaveBeenCalledWith(
      { id: "stored-draft", name: "Stored Draft", nodes: [], edges: [] },
      { trigger: "schedule", agentId: "agent-dry", flowId: "flow-dry", dryRun: true },
    );
    expect(routeRepo.markScheduleRun).toHaveBeenCalledWith("schedule-dry", expect.any(Number));
  });

  it("does not construct either run path when no schedule is due", async () => {
    const route = await import("@/app/api/cron/tick/route");
    const response = await route.POST(new Request("https://agents.suedeai.ai/api/cron/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: 0 });
    expect(routeRunners.preview).not.toHaveBeenCalled();
    expect(routeRunners.published).not.toHaveBeenCalled();
    expect(routeRepo.getAgent).not.toHaveBeenCalled();
    expect(routeRepo.getFlow).not.toHaveBeenCalled();
    expect(routeRepo.markScheduleRun).not.toHaveBeenCalled();
  });
});
