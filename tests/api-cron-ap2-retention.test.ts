import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  scrubFailure: true,
}));

const repository = vi.hoisted(() => ({
  recordHealthCheck: vi.fn(async () => undefined),
  scrubExpiredAp2TerminalEvidence: vi.fn(async () => {
    if (control.scrubFailure) throw new Error("retention store unavailable");
    return 2;
  }),
  dueSchedules: vi.fn(async () => [{
    id: "schedule-draft",
    agentId: "agent-draft",
    cron: "0 * * * *",
    enabled: true,
    lastRunAt: null,
  }]),
  getAgent: vi.fn(async () => ({
    id: "agent-draft",
    flowId: "flow-draft",
    slug: "draft",
    status: "draft" as const,
    priceUsdc: 0,
    createdAt: 1,
    settlementLive: false,
  })),
  markScheduleRun: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/repo")>();
  return {
    ...actual,
    getRepo: vi.fn(async () => repository),
  };
});
vi.mock("@/lib/health", () => ({
  runHealthProbes: vi.fn(async () => ({
    status: "ok" as const,
    db: { ok: true, latencyMs: 1 },
    gateway: { ok: true, latencyMs: 1 },
    facilitator: { ok: true, latencyMs: 1 },
    checkedAt: "2026-08-14T12:00:00.000Z",
  })),
}));
vi.mock("@/lib/run-service", () => ({
  runPublishedLiveToCompletion: vi.fn(),
  runToCompletion: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
  ipFromRequest: () => "203.0.113.12",
}));

const CRON_SECRET = "retention-cron-secret-at-least-32-bytes";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("AP2_TERMINAL_EVIDENCE_RETENTION_DAYS", "30");
  control.scrubFailure = true;
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("authenticated cron AP2 evidence retention", () => {
  it("isolates cleanup failure and still services due schedules", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = await import("@/app/api/cron/tick/route");
    const response = await route.GET(new Request("https://agents.suedeai.ai/api/cron/tick", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: 1 });
    expect(repository.scrubExpiredAp2TerminalEvidence).toHaveBeenCalledWith({
      terminalBefore: "2026-07-15T12:00:00.000Z",
      scrubbedAt: "2026-08-14T12:00:00.000Z",
      limit: 100,
    });
    expect(repository.dueSchedules).toHaveBeenCalledWith(Date.parse("2026-08-14T12:00:00.000Z"));
    expect(repository.markScheduleRun).toHaveBeenCalledWith(
      "schedule-draft",
      Date.parse("2026-08-14T12:00:00.000Z"),
    );
    expect(error).toHaveBeenCalledWith("AP2 terminal evidence cleanup failed");
    error.mockRestore();
  });
});
