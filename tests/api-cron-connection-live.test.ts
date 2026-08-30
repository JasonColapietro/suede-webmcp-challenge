import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

interface PublishedRunInput {
  readonly flowId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly trigger: string;
}

const control = vi.hoisted(() => ({
  order: [] as string[],
  due: [] as Array<{ id: string; agentId: string; cron: string; enabled: boolean; lastRunAt: number | null }>,
  agent: {
    id: "agent-live",
    flowId: "flow-live",
    slug: "agent-live",
    status: "live" as const,
    priceUsdc: 1,
    createdAt: 1,
    settlementLive: true,
  } as null | {
    id: string;
    flowId: string;
    slug: string;
    status: "draft" | "live";
    priceUsdc: number;
    createdAt: number;
    settlementLive: boolean;
  },
  flow: {
    id: "flow-live",
    ownerId: "owner-live",
    name: "Live",
    graph: { id: "draft-graph", name: "Draft", nodes: [], edges: [] },
    updatedAt: 1,
  } as null | {
    id: string;
    ownerId: string;
    name: string;
    graph: { id: string; name: string; nodes: never[]; edges: never[] };
    updatedAt: number;
  },
  liveResult: { runId: "run-live", status: "done" as const, totalCostUsdc: 0, outputs: {} } as null | {
    runId: string;
    status: "done" | "error";
    totalCostUsdc: number;
    outputs: Record<string, Record<string, unknown>>;
  },
  rateAllowed: true,
}));

const repository = vi.hoisted(() => ({
  dueSchedules: vi.fn(async () => {
    control.order.push("due");
    return control.due;
  }),
  getAgent: vi.fn(async () => {
    control.order.push("agent");
    return control.agent;
  }),
  getFlow: vi.fn(async () => {
    control.order.push("flow");
    return control.flow;
  }),
  markScheduleRun: vi.fn(async () => {
    control.order.push("mark");
  }),
}));

const runners = vi.hoisted(() => ({
  published: vi.fn(async (_input: PublishedRunInput) => {
    control.order.push("published");
    return control.liveResult;
  }),
  preview: vi.fn(async (_graph: unknown, _options: unknown) => {
    control.order.push("preview");
    return { runId: "run-dry", status: "done", totalCostUsdc: 0, outputs: {} };
  }),
}));

const rate = vi.hoisted(() => ({
  check: vi.fn((_key: string, _options: unknown) => {
    control.order.push("rate");
    return { allowed: control.rateAllowed, retryAfterSec: 30 };
  }),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => {
    control.order.push("storage");
    return repository;
  }),
}));
// The tick records a best-effort health snapshot before the schedule loop.
// Mock it so this suite stays hermetic (no real dependency probes) and its
// operation-order assertions keep measuring only the schedule authority path.
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
  runPublishedLiveToCompletion: (input: PublishedRunInput) => runners.published(input),
  runToCompletion: (graph: unknown, options: unknown) => runners.preview(graph, options),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string, options: unknown) => rate.check(key, options),
  ipFromRequest: () => "203.0.113.9",
}));

const CRON_SECRET = "cron-secret-32-bytes-minimum-value";

beforeEach(() => {
  vi.clearAllMocks();
  control.order.length = 0;
  control.due = [{ id: "schedule-live", agentId: "agent-live", cron: "0 * * * *", enabled: true, lastRunAt: null }];
  control.agent = {
    id: "agent-live",
    flowId: "flow-live",
    slug: "agent-live",
    status: "live",
    priceUsdc: 1,
    createdAt: 1,
    settlementLive: true,
  };
  control.flow = {
    id: "flow-live",
    ownerId: "owner-live",
    name: "Live",
    graph: { id: "draft-graph", name: "Attacker-edited Draft", nodes: [], edges: [] },
    updatedAt: 1,
  };
  control.liveResult = { runId: "run-live", status: "done", totalCostUsdc: 0, outputs: {} };
  control.rateAllowed = true;
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

async function route() {
  return import("@/app/api/cron/tick/route");
}

function request(method: "GET" | "POST", authorization?: string, attackerPayload = false): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(
    attackerPayload
      ? "https://agents.suedeai.ai/api/cron/tick?graph=attacker&version=evil&environment=test&hash=forged&secret=leak"
      : "https://agents.suedeai.ai/api/cron/tick",
    {
      method,
      headers,
      ...(method === "POST" && attackerPayload
        ? {
            body: JSON.stringify({
              graph: { id: "attacker" }, version: "evil", deployment: "evil", environment: "test",
              hash: "forged", connection: "private", secret: "leak",
            }),
          }
        : {}),
    },
  );
}

async function expectFixedUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
}

describe("authenticated Live cron execution", () => {
  it.each(["GET", "POST"] as const)("rejects missing, malformed, mismatched, and weak %s auth before rate or storage", async (method) => {
    const handler = await route();
    for (const candidate of [
      undefined,
      CRON_SECRET,
      `Basic ${CRON_SECRET}`,
      `Bearer  ${CRON_SECRET}`,
      `bearer ${CRON_SECRET}`,
      `Bearer ${CRON_SECRET} extra`,
      "Bearer wrong-secret-value-that-is-long-enough",
    ]) {
      control.order.length = 0;
      await expectFixedUnauthorized(await handler[method](request(method, candidate)));
      expect(control.order).toEqual([]);
      expect(repository.dueSchedules).not.toHaveBeenCalled();
      expect(runners.published).not.toHaveBeenCalled();
    }

    vi.stubEnv("CRON_SECRET", "too-short");
    control.order.length = 0;
    await expectFixedUnauthorized(await handler[method](request(method, "Bearer too-short")));
    expect(control.order).toEqual([]);
    vi.stubEnv("CRON_SECRET", undefined);
    await expectFixedUnauthorized(await handler[method](request(method, `Bearer ${CRON_SECRET}`)));
    expect(control.order).toEqual([]);
  });

  it.each(["GET", "POST"] as const)("runs authenticated non-dry %s schedules through immutable Live authority only", async (method) => {
    const handler = await route();
    const response = await handler[method](request(method, `Bearer ${CRON_SECRET}`, true));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: 1 });
    expect(control.order).toEqual(["rate", "storage", "due", "agent", "flow", "published", "mark"]);
    expect(runners.preview).not.toHaveBeenCalled();
    expect(runners.published).toHaveBeenCalledWith({
      flowId: "flow-live",
      ownerId: "owner-live",
      agentId: "agent-live",
      trigger: "schedule",
    });
    const publishedInput = runners.published.mock.calls[0]?.[0];
    expect(publishedInput).toBeDefined();
    if (!publishedInput) throw new Error("published input missing");
    expect(Object.keys(publishedInput).sort())
      .toEqual(["agentId", "flowId", "ownerId", "trigger"]);
    expect(JSON.stringify(publishedInput)).not.toMatch(
      /attacker|version|deployment|environment|hash|connection|secret/iu,
    );
    expect(repository.markScheduleRun).toHaveBeenCalledWith("schedule-live", expect.any(Number));
  });

  it.each([
    { label: "preview", globalLive: false },
    { label: "Live", globalLive: true },
  ])("skips an enabled due draft before the $label execution path", async ({ globalLive }) => {
    const handler = await route();
    if (!control.agent) throw new Error("agent fixture missing");
    control.agent = { ...control.agent, status: "draft" };
    vi.stubEnv("X402_SKIP_SETTLEMENT", globalLive ? "false" : "true");

    const response = await handler.GET(request("GET", `Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: 1 });
    expect(control.order).toEqual(["rate", "storage", "due", "agent", "mark"]);
    expect(repository.getFlow).not.toHaveBeenCalled();
    expect(runners.preview).not.toHaveBeenCalled();
    expect(runners.published).not.toHaveBeenCalled();
    expect(repository.markScheduleRun).toHaveBeenCalledWith("schedule-live", expect.any(Number));
  });

  it("accepts an exactly 32-byte configured secret", async () => {
    const handler = await route();
    const exact = "x".repeat(32);
    vi.stubEnv("CRON_SECRET", exact);
    control.due = [];

    const response = await handler.GET(request("GET", `Bearer ${exact}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: 0 });
    expect(control.order).toEqual(["rate", "storage", "due"]);
  });

  it("refuses a missing or mismatched Live deployment before mark, preview, or any later schedule", async () => {
    const handler = await route();
    control.liveResult = null;

    const response = await handler.GET(request("GET", `Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "connection service unavailable" });
    expect(control.order).toEqual(["rate", "storage", "due", "agent", "flow", "published"]);
    expect(repository.markScheduleRun).not.toHaveBeenCalled();
    expect(runners.preview).not.toHaveBeenCalled();
  });

  it("keeps authentication ahead of rate limiting even when the bucket is exhausted", async () => {
    const handler = await route();
    control.rateAllowed = false;
    await expectFixedUnauthorized(await handler.GET(request("GET", "Bearer wrong-secret-value-that-is-long-enough")));
    expect(rate.check).not.toHaveBeenCalled();

    const authorized = await handler.GET(request("GET", `Bearer ${CRON_SECRET}`));
    expect(authorized.status).toBe(429);
    expect(control.order).toEqual(["rate"]);
  });
});
