/**
 * Tests for the durable per-agent daily cost cap in src/lib/run-service.ts.
 *
 * The in-memory rate limiter (src/lib/rate-limit.ts) is per-instance and
 * resets on cold start, so it cannot be the sole ceiling on serverless.
 * This cap reads cumulative spend for the agent from the database (via
 * repo.sumAgentCostSince), which is durable across instances, and refuses
 * to start a new run once the rolling 24h window is over budget.
 *
 * getRepo() is mocked here (rather than using a real SqliteRepo) so the
 * cap logic can be exercised in isolation, independent of the DB-layer
 * sumAgentCostSince implementation (which has its own coverage via the
 * SqliteRepo-backed tests elsewhere).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";

// Test timeout bumped: constructing the run context (createLlmFromEnv, the
// x402 client, the "ai" SDK import) is slow on a heavily-loaded dev machine
// and the default 5s vitest timeout has been observed to flake here.
const TEST_TIMEOUT_MS = 20_000;

const mockRepo = {
  createRun: vi.fn(),
  appendStep: vi.fn(),
  finishRun: vi.fn(),
  sumAgentCostSince: vi.fn(),
  getFlow: vi.fn(),
};

vi.mock("@/lib/db/repo", () => ({
  getRepo: async () => mockRepo,
}));

const emptyGraph = (id: string): FlowGraph => ({ id, name: id, nodes: [], edges: [] });

describe("runAndStream / runToCompletion — per-agent daily cost cap", () => {
  beforeEach(() => {
    // Full reset (not just clearAllMocks) so no test's mockResolvedValueOnce
    // queue can leak into the next test — then re-establish sane defaults.
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
    mockRepo.getFlow.mockReset().mockResolvedValue(null);
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "allows a run when spend is below the cap",
    async () => {
      vi.stubEnv("AGENT_DAILY_COST_CAP_USDC", "5");
      mockRepo.sumAgentCostSince.mockResolvedValue(1);
      const { runToCompletion } = await import("@/lib/run-service");

      const summary = await runToCompletion(emptyGraph("g1"), {
        trigger: "agent",
        agentId: "agent-1",
        flowId: "flow-1",
        dryRun: true,
      });

      expect(summary.status).toBe("done");
      expect(mockRepo.createRun).toHaveBeenCalledTimes(1);
      expect(mockRepo.sumAgentCostSince).toHaveBeenCalledWith("agent-1", expect.any(Number));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "blocks a run once the agent has spent past its daily cap, without ever creating the run",
    async () => {
      vi.stubEnv("AGENT_DAILY_COST_CAP_USDC", "5");
      mockRepo.sumAgentCostSince.mockResolvedValue(5);
      const { runToCompletion, AgentDailyCapExceededError } = await import("@/lib/run-service");

      await expect(
        runToCompletion(emptyGraph("g2"), {
          trigger: "agent",
          agentId: "agent-2",
          flowId: "flow-2",
          dryRun: true,
        }),
      ).rejects.toBeInstanceOf(AgentDailyCapExceededError);
      expect(mockRepo.createRun).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "blocks a run when spend has already exceeded the cap",
    async () => {
      vi.stubEnv("AGENT_DAILY_COST_CAP_USDC", "5");
      mockRepo.sumAgentCostSince.mockResolvedValue(37.5);
      const { runToCompletion, AgentDailyCapExceededError } = await import("@/lib/run-service");

      await expect(
        runToCompletion(emptyGraph("g3"), {
          trigger: "agent",
          agentId: "agent-3",
          flowId: "flow-3",
          dryRun: true,
        }),
      ).rejects.toBeInstanceOf(AgentDailyCapExceededError);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not apply the cap to runs without an agentId (manual/editor preview runs)",
    async () => {
      // sumAgentCostSince must not even be called for an agentId-less run —
      // make it reject if called, to prove that.
      mockRepo.sumAgentCostSince.mockRejectedValue(new Error("should not be called"));
      const { runToCompletion } = await import("@/lib/run-service");

      const summary = await runToCompletion(emptyGraph("g4"), {
        trigger: "manual",
        agentId: null,
        flowId: "flow-4",
        dryRun: true,
      });

      expect(summary.status).toBe("done");
      expect(mockRepo.sumAgentCostSince).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the default cap when AGENT_DAILY_COST_CAP_USDC is unset or invalid",
    async () => {
      vi.stubEnv("AGENT_DAILY_COST_CAP_USDC", "not-a-number");
      mockRepo.sumAgentCostSince.mockResolvedValue(1); // comfortably under any sane default
      const { runToCompletion } = await import("@/lib/run-service");

      const summary = await runToCompletion(emptyGraph("g5"), {
        trigger: "agent",
        agentId: "agent-5",
        flowId: "flow-5",
        dryRun: true,
      });

      expect(summary.status).toBe("done");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "persists a preflight exception as one zero-cost error finalization",
    async () => {
      const malformed: FlowGraphV2 = {
        schemaVersion: 2,
        id: "preflight-error",
        name: "Preflight error",
        nodes: [{ id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
        edges: [{ id: "dangling", source: "input", sourceHandle: "result", target: "missing", targetHandle: "in" }],
        variables: [],
        groups: [],
        annotations: [],
      };
      const { runToCompletion } = await import("@/lib/run-service");
      const { FlowExecutionValidationError } = await import("@/lib/flow/engine");

      await expect(runToCompletion(malformed, {
        trigger: "manual",
        flowId: "flow-preflight-error",
        dryRun: true,
      })).rejects.toBeInstanceOf(FlowExecutionValidationError);

      expect(mockRepo.appendStep).not.toHaveBeenCalled();
      expect(mockRepo.finishRun).toHaveBeenCalledTimes(1);
      expect(mockRepo.finishRun).toHaveBeenCalledWith("run-1", "error", 0);
    },
    TEST_TIMEOUT_MS,
  );
});
