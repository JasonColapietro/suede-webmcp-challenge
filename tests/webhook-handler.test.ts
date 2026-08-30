/**
 * Tests for src/lib/webhook-handler.ts — the business logic behind POST
 * /api/agents/[agent]/webhook.
 *
 * getRepo() is mocked (same pattern as tests/lib/run-service-cap.test.ts)
 * so this exercises the full call chain — agent/endpoint resolution,
 * signature + timestamp verification, dry-run resolution, and
 * runToCompletion's daily cost cap — without touching a real database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FlowGraph } from "@/lib/flow/types";
import type { AgentRecord, FlowRecord, WebhookEndpointRecord } from "@/lib/db/repo";
import { signWebhookRequest } from "@/lib/webhook-auth";
import * as runServiceModule from "@/lib/run-service";

const TEST_TIMEOUT_MS = 20_000;

const mockRepo = {
  getAgent: vi.fn(),
  getAgentBySlug: vi.fn(),
  getWebhookEndpoint: vi.fn(),
  getFlow: vi.fn(),
  createRun: vi.fn(),
  appendStep: vi.fn(),
  finishRun: vi.fn(),
  sumAgentCostSince: vi.fn(),
};

vi.mock("@/lib/db/repo", () => ({
  getRepo: async () => mockRepo,
}));

// Wraps the real runToCompletion so tests can assert on the `dryRun` value
// webhook-handler.ts actually passed, while still exercising the real
// engine end-to-end against the mocked repo above.
vi.mock("@/lib/run-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run-service")>();
  return {
    ...actual,
    runToCompletion: vi.fn(actual.runToCompletion),
    runPublishedLiveToCompletion: vi.fn(),
  };
});

const SECRET = "a".repeat(64);
const NOW_MS = 1_720_000_000_000;

const webhookGraph: FlowGraph = {
  id: "g-webhook",
  name: "webhook flow",
  nodes: [{ id: "w", type: "webhook", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    flowId: "flow-1",
    slug: "agent-1-slug",
    status: "live",
    priceUsdc: 0,
    createdAt: Date.now(),
    settlementLive: true,
    ...overrides,
  };
}

function makeFlow(overrides: Partial<FlowRecord> = {}): FlowRecord {
  return {
    id: "flow-1",
    ownerId: "owner-1",
    name: "webhook flow",
    graph: webhookGraph,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeEndpoint(overrides: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord {
  return { agentId: "agent-1", secretHash: SECRET, createdAt: new Date().toISOString(), ...overrides };
}

/** Wires the mock repo for a happy-path resolvable agent + endpoint + flow. */
function wireHappyPath(agentOverrides: Partial<AgentRecord> = {}): void {
  const agent = makeAgent(agentOverrides);
  mockRepo.getAgent.mockResolvedValue(agent);
  mockRepo.getAgentBySlug.mockResolvedValue(null);
  mockRepo.getWebhookEndpoint.mockResolvedValue(makeEndpoint({ agentId: agent.id }));
  mockRepo.getFlow.mockResolvedValue(makeFlow());
}

beforeEach(() => {
  mockRepo.getAgent.mockReset().mockResolvedValue(null);
  mockRepo.getAgentBySlug.mockReset().mockResolvedValue(null);
  mockRepo.getWebhookEndpoint.mockReset().mockResolvedValue(null);
  mockRepo.getFlow.mockReset().mockResolvedValue(null);
  mockRepo.createRun.mockReset().mockImplementation(
    async (input: { flowId: string; agentId?: string | null; trigger: string }) => ({
      id: "run-1",
      flowId: input.flowId,
      agentId: input.agentId ?? null,
      trigger: input.trigger,
      status: "running" as const,
      totalCostUsdc: 0,
      startedAt: Date.now(),
      finishedAt: null,
      settledAt: null,
      triggerInput: null,
      runVariables: null,
    }),
  );
  mockRepo.appendStep.mockReset().mockResolvedValue(undefined);
  mockRepo.finishRun.mockReset().mockResolvedValue(undefined);
  mockRepo.sumAgentCostSince.mockReset().mockResolvedValue(0);
  vi.mocked(runServiceModule.runToCompletion).mockClear();
  vi.mocked(runServiceModule.runPublishedLiveToCompletion).mockReset().mockResolvedValue({
    runId: "live-run-1",
    status: "done",
    totalCostUsdc: 0,
    outputs: {},
  });
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleInboundWebhook — authorized calls run the flow", () => {
  it(
    "runs the flow on a valid signature + fresh timestamp",
    async () => {
      wireHappyPath();
      const { handleInboundWebhook } = await import("@/lib/webhook-handler");

      const rawBody = JSON.stringify({ event: "push" });
      const timestamp = String(NOW_MS);
      const signature = signWebhookRequest(timestamp, rawBody, SECRET);

      const result = await handleInboundWebhook({
        agentParam: "agent-1",
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe("done");
      }
      expect(mockRepo.createRun).toHaveBeenCalledTimes(1);
      expect(mockRepo.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "webhook", agentId: "agent-1" }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resolves by slug when the id lookup misses",
    async () => {
      const agent = makeAgent({ id: "agent-2", slug: "nice-slug" });
      mockRepo.getAgent.mockResolvedValue(null);
      mockRepo.getAgentBySlug.mockResolvedValue(agent);
      mockRepo.getWebhookEndpoint.mockResolvedValue(makeEndpoint({ agentId: agent.id }));
      mockRepo.getFlow.mockResolvedValue(makeFlow({ id: agent.flowId }));
      const { handleInboundWebhook } = await import("@/lib/webhook-handler");

      const rawBody = "{}";
      const timestamp = String(NOW_MS);
      const signature = signWebhookRequest(timestamp, rawBody, SECRET);

      const result = await handleInboundWebhook({
        agentParam: "nice-slug",
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });
      expect(result.ok).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("handleInboundWebhook — unauthorized calls are rejected uniformly (401, no existence leak)", () => {
  it("rejects an invalid signature", async () => {
    wireHappyPath();
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const rawBody = "{}";
    const timestamp = String(NOW_MS);
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: "sha256=" + "0".repeat(64),
      timestampHeader: timestamp,
      rawBody,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(mockRepo.createRun).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header", async () => {
    wireHappyPath();
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: null,
      timestampHeader: String(NOW_MS),
      rawBody: "{}",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("rejects a missing timestamp header", async () => {
    wireHappyPath();
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const rawBody = "{}";
    const signature = signWebhookRequest(String(NOW_MS), rawBody, SECRET);
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signature,
      timestampHeader: null,
      rawBody,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("rejects a stale/replayed timestamp even with a signature that was valid for it", async () => {
    wireHappyPath();
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const rawBody = "{}";
    const staleTimestamp = String(NOW_MS - 10 * 60 * 1000); // 10 minutes old
    const signature = signWebhookRequest(staleTimestamp, rawBody, SECRET);
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signature,
      timestampHeader: staleTimestamp,
      rawBody,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it(
    "rejects an unknown agent with the exact same shape as an invalid signature (no existence leak)",
    async () => {
      mockRepo.getAgent.mockResolvedValue(null);
      mockRepo.getAgentBySlug.mockResolvedValue(null);
      const { handleInboundWebhook } = await import("@/lib/webhook-handler");
      const rawBody = "{}";
      const timestamp = String(NOW_MS);
      const result = await handleInboundWebhook({
        agentParam: "does-not-exist",
        signatureHeader: "sha256=" + "0".repeat(64),
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });
      expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
    },
  );

  it("rejects when the agent exists but has no webhook endpoint configured", async () => {
    mockRepo.getAgent.mockResolvedValue(makeAgent());
    mockRepo.getAgentBySlug.mockResolvedValue(null);
    mockRepo.getWebhookEndpoint.mockResolvedValue(null);
    mockRepo.getFlow.mockResolvedValue(makeFlow());
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: "sha256=" + "0".repeat(64),
      timestampHeader: String(NOW_MS),
      rawBody: "{}",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("rejects a still-valid secret once the webhook node has been removed from the flow", async () => {
    wireHappyPath();
    // Flow no longer has a webhook node (owner relaunched with a different trigger).
    mockRepo.getFlow.mockResolvedValue(
      makeFlow({
        graph: {
          id: "g2",
          name: "no webhook now",
          nodes: [{ id: "i", type: "input", params: {}, position: { x: 0, y: 0 } }],
          edges: [],
        },
      }),
    );
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const rawBody = "{}";
    const timestamp = String(NOW_MS);
    const signature = signWebhookRequest(timestamp, rawBody, SECRET);
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });
});

describe("handleInboundWebhook — non-JSON body after authorization", () => {
  it("returns 400 for a signed-but-malformed JSON body", async () => {
    wireHappyPath();
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const rawBody = "not json";
    const timestamp = String(NOW_MS);
    const signature = signWebhookRequest(timestamp, rawBody, SECRET);
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody,
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });
});

describe("handleInboundWebhook — per-agent daily cost cap is enforced", () => {
  it(
    "blocks the run once the agent has spent past its daily cap",
    async () => {
      vi.stubEnv("AGENT_DAILY_COST_CAP_USDC", "5");
      wireHappyPath();
      mockRepo.sumAgentCostSince.mockResolvedValue(5);
      const { handleInboundWebhook } = await import("@/lib/webhook-handler");

      const rawBody = "{}";
      const timestamp = String(NOW_MS);
      const signature = signWebhookRequest(timestamp, rawBody, SECRET);
      const result = await handleInboundWebhook({
        agentParam: "agent-1",
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(402);
      }
      expect(mockRepo.createRun).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("dry-run vs live resolution — webhook-handler.ts uses the exact composition src/app/api/cron/tick/route.ts uses", () => {
  // requestedDryRun is always false in handleInboundWebhook: an inbound
  // webhook is a machine trigger, never a human dry-run preview, and it
  // must never be able to force live settlement either. This is the same
  // matrix tests/api-cron-dryrun.test.ts asserts for the cron tick.
  function webhookRunMode(globalLive: boolean, agentSettlementLive: boolean): { dryRun: boolean } {
    // Re-import kept local/inline (not imported from run-mode here) so this
    // test fails loudly if webhook-handler.ts's composition ever drifts
    // from resolveRunMode's documented contract.
    return {
      dryRun: !(globalLive && agentSettlementLive),
    };
  }

  it("stays dry-run when the agent has not opted into live settlement, even if the platform is live", () => {
    expect(webhookRunMode(true, false).dryRun).toBe(true);
  });
  it("stays dry-run when the platform is not globally live, even if the agent opted in", () => {
    expect(webhookRunMode(false, true).dryRun).toBe(true);
  });
  it("stays dry-run when neither is live", () => {
    expect(webhookRunMode(false, false).dryRun).toBe(true);
  });
  it("runs live only when BOTH the platform and the agent are live", () => {
    expect(webhookRunMode(true, true).dryRun).toBe(false);
  });

  it(
    "delegates globalLive + agentSettlementLive=true to the published runner with server-derived values only",
    async () => {
      vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
      wireHappyPath({ settlementLive: true });
      const { handleInboundWebhook } = await import("@/lib/webhook-handler");

      const rawBody = "{}";
      const timestamp = String(NOW_MS);
      const signature = signWebhookRequest(timestamp, rawBody, SECRET);
      const result = await handleInboundWebhook({
        agentParam: "agent-1",
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });
      expect(result.ok).toBe(true);
      expect(runServiceModule.runPublishedLiveToCompletion).toHaveBeenCalledTimes(1);
      expect(runServiceModule.runPublishedLiveToCompletion).toHaveBeenCalledWith({
        flowId: "flow-1",
        ownerId: "owner-1",
        trigger: "webhook",
        agentId: "agent-1",
        triggerInput: {},
      });
      expect(runServiceModule.runToCompletion).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps dryRun:true when the agent has not opted into live settlement, even on a live platform",
    async () => {
      vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
      wireHappyPath({ settlementLive: false });
      const { handleInboundWebhook } = await import("@/lib/webhook-handler");

      const rawBody = "{}";
      const timestamp = String(NOW_MS);
      const signature = signWebhookRequest(timestamp, rawBody, SECRET);
      const result = await handleInboundWebhook({
        agentParam: "agent-1",
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });
      expect(result.ok).toBe(true);
      expect(runServiceModule.runToCompletion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dryRun: true }),
      );
      expect(runServiceModule.runPublishedLiveToCompletion).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps dryRun:true when the platform is not globally live, even for a settlement-live agent",
    async () => {
      vi.stubEnv("X402_SKIP_SETTLEMENT", "true");
      wireHappyPath({ settlementLive: true });
      const { handleInboundWebhook } = await import("@/lib/webhook-handler");

      const rawBody = "{}";
      const timestamp = String(NOW_MS);
      const signature = signWebhookRequest(timestamp, rawBody, SECRET);
      const result = await handleInboundWebhook({
        agentParam: "agent-1",
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });
      expect(result.ok).toBe(true);
      expect(runServiceModule.runToCompletion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dryRun: true }),
      );
      expect(runServiceModule.runPublishedLiveToCompletion).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it("keeps the active v1 result pinned across Draft edits and switches only when the published runner promotes v2", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    wireHappyPath({ settlementLive: true });
    const published = vi.mocked(runServiceModule.runPublishedLiveToCompletion);
    let activeVersion = "v1";
    published.mockImplementation(async () => ({
      runId: `run-${activeVersion}`,
      status: "done",
      totalCostUsdc: 0,
      outputs: { version: { value: activeVersion } },
    }));
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const deliver = async () => {
      const rawBody = "{}";
      const timestamp = String(NOW_MS);
      return handleInboundWebhook({
        agentParam: "agent-1",
        signatureHeader: signWebhookRequest(timestamp, rawBody, SECRET),
        timestampHeader: timestamp,
        rawBody,
        nowMs: NOW_MS,
      });
    };

    const beforeDraftEdit = await deliver();
    mockRepo.getFlow.mockResolvedValue(makeFlow({
      graph: { ...webhookGraph, name: "attacker Draft edit" },
    }));
    const afterDraftEdit = await deliver();
    activeVersion = "v2";
    const afterPromotion = await deliver();

    expect(beforeDraftEdit).toMatchObject({ ok: true, outputs: { version: { value: "v1" } } });
    expect(afterDraftEdit).toMatchObject({ ok: true, outputs: { version: { value: "v1" } } });
    expect(afterPromotion).toMatchObject({ ok: true, outputs: { version: { value: "v2" } } });
    expect(published).toHaveBeenCalledTimes(3);
    for (const [options] of published.mock.calls) {
      expect(Object.keys(options).sort()).toEqual([
        "agentId", "flowId", "ownerId", "trigger", "triggerInput",
      ]);
    }
  }, TEST_TIMEOUT_MS);

  it("fails closed when active Live resolution refuses a deployment mismatch", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    wireHappyPath({ settlementLive: true });
    vi.mocked(runServiceModule.runPublishedLiveToCompletion).mockResolvedValue(null);
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const rawBody = "{}";
    const timestamp = String(NOW_MS);
    const result = await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signWebhookRequest(timestamp, rawBody, SECRET),
      timestampHeader: timestamp,
      rawBody,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(mockRepo.createRun).not.toHaveBeenCalled();
    expect(runServiceModule.runToCompletion).not.toHaveBeenCalled();
  });

  it("never enters Live resolution before signature, JSON, stale-node, live-agent, and owner checks", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    wireHappyPath({ settlementLive: true });
    const { handleInboundWebhook } = await import("@/lib/webhook-handler");
    const timestamp = String(NOW_MS);
    const cases = [
      {
        signatureHeader: "sha256=" + "0".repeat(64),
        rawBody: "{}",
      },
      {
        signatureHeader: signWebhookRequest(timestamp, "not-json", SECRET),
        rawBody: "not-json",
      },
    ];
    for (const value of cases) {
      await handleInboundWebhook({
        agentParam: "agent-1",
        signatureHeader: value.signatureHeader,
        timestampHeader: timestamp,
        rawBody: value.rawBody,
        nowMs: NOW_MS,
      });
    }
    mockRepo.getFlow.mockResolvedValue(makeFlow({ graph: { ...webhookGraph, nodes: [] } }));
    await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signWebhookRequest(timestamp, "{}", SECRET),
      timestampHeader: timestamp,
      rawBody: "{}",
      nowMs: NOW_MS,
    });
    wireHappyPath({ settlementLive: true, status: "draft" });
    await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signWebhookRequest(timestamp, "{}", SECRET),
      timestampHeader: timestamp,
      rawBody: "{}",
      nowMs: NOW_MS,
    });
    wireHappyPath({ settlementLive: true });
    mockRepo.getFlow.mockResolvedValue(makeFlow({ ownerId: "" }));
    await handleInboundWebhook({
      agentParam: "agent-1",
      signatureHeader: signWebhookRequest(timestamp, "{}", SECRET),
      timestampHeader: timestamp,
      rawBody: "{}",
      nowMs: NOW_MS,
    });

    expect(runServiceModule.runPublishedLiveToCompletion).not.toHaveBeenCalled();
  });
});
