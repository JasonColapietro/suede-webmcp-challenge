/**
 * Tests for the in-run cost ceiling as wired through run-service.ts — the
 * "effective ceiling for THIS run" computation (min of the absolute per-run
 * ceiling and the agent's remaining daily budget), and the typed
 * RunCostCeilingExceededError raised when a run gets aborted by it.
 *
 * getRepo() and the node registry are mocked (same pattern as
 * run-service-cap.test.ts) so this can run without a DB or real x402/LLM
 * network calls. The mocked registry provides one node type ("http") whose
 * declared priceUsdc/costUsdc are configurable per test via mockPriced, so
 * the ceiling's pre-execution check can be tripped deterministically on the
 * very first node — meaning the (never-executed) node's real executor body
 * never runs and no network call is ever attempted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FlowGraph } from "@/lib/flow/types";
import type { NodeDef, NodeRegistry, NodeResult } from "@/lib/flow/executor";

const TEST_TIMEOUT_MS = 20_000;
// Well-formed 32-byte hex key so X402Client can construct in "live" mode
// (dryRun: false) without throwing. Never used for a real signature — the
// mocked node's executor never runs in any of these tests.
const FAKE_PRIVATE_KEY = `0x${"01".repeat(32)}`;
const FAKE_SELLER_WALLET = `0x${"02".repeat(20)}`;

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

const mockPriced = { priceUsdc: 0, costUsdc: 0 };
const mockPricedNodeExecutor = vi.fn(
  async (): Promise<NodeResult> => ({
    ok: true,
    outputs: { result: {} },
    costUsdc: mockPriced.costUsdc,
  }),
);
const mockPricedNodeDef: NodeDef = {
  type: "http",
  label: "priced test node",
  group: "Logic",
  costBearing: true,
  get priceUsdc(): number {
    return mockPriced.priceUsdc;
  },
  paramsSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
  inputs: ["in"],
  outputs: ["result"],
  executor: mockPricedNodeExecutor,
};

vi.mock("@/lib/flow/registry", () => ({
  getRegistry: (): NodeRegistry => ({ http: mockPricedNodeDef }),
}));

const pricedGraph = (id: string): FlowGraph => ({
  id,
  name: id,
  nodes: [{ id: "n1", type: "http", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
});

describe("run-service — in-run cost ceiling", () => {
  beforeEach(() => {
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
    mockPricedNodeExecutor.mockClear();
    mockPriced.priceUsdc = 0;
    mockPriced.costUsdc = 0;
    vi.unstubAllEnvs();
    vi.stubEnv("X402_PRIVATE_KEY", FAKE_PRIVATE_KEY);
    vi.stubEnv("X402_SELLER_WALLET_ADDRESS", FAKE_SELLER_WALLET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "the remaining-daily-budget ceiling binds when it is tighter than the absolute ceiling",
    async () => {
      // Agent has spent $24 of a $25 daily cap -> $1 remaining. Absolute
      // per-run ceiling is $5. Effective ceiling = min(5, 1) = $1.
      vi.stubEnv("AGENT_DAILY_COST_CAP_USDC", "25");
      vi.stubEnv("RUN_COST_CEILING_USDC", "5");
      mockRepo.sumAgentCostSince.mockResolvedValue(24);
      mockPriced.priceUsdc = 1.5; // over the $1 effective ceiling
      mockPriced.costUsdc = 1.5;
      const { runToCompletion, RunCostCeilingExceededError } = await import("@/lib/run-service");

      const err: unknown = await runToCompletion(pricedGraph("g-daily-tighter"), {
        trigger: "agent",
        agentId: "agent-daily",
        flowId: "flow-daily",
        dryRun: false,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RunCostCeilingExceededError);
      const ceilingErr = err as InstanceType<typeof RunCostCeilingExceededError>;
      expect(ceilingErr.ceilingUsdc).toBeCloseTo(1, 5);
      expect(mockPricedNodeExecutor).not.toHaveBeenCalled(); // refused before running — never charged
      expect(mockRepo.finishRun).toHaveBeenCalledWith("run-1", "error", 0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the absolute ceiling binds when it is tighter than the remaining daily budget",
    async () => {
      // Agent has spent only $2 of a $25 daily cap -> $23 remaining. The
      // absolute per-run ceiling of $1 is the tighter constraint.
      vi.stubEnv("AGENT_DAILY_COST_CAP_USDC", "25");
      vi.stubEnv("RUN_COST_CEILING_USDC", "1");
      mockRepo.sumAgentCostSince.mockResolvedValue(2);
      mockPriced.priceUsdc = 1.5;
      mockPriced.costUsdc = 1.5;
      const { runToCompletion, RunCostCeilingExceededError } = await import("@/lib/run-service");

      const err: unknown = await runToCompletion(pricedGraph("g-abs-tighter"), {
        trigger: "agent",
        agentId: "agent-abs",
        flowId: "flow-abs",
        dryRun: false,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RunCostCeilingExceededError);
      const ceilingErr = err as InstanceType<typeof RunCostCeilingExceededError>;
      expect(ceilingErr.ceilingUsdc).toBeCloseTo(1, 5);
      expect(mockPricedNodeExecutor).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "enforces only the absolute ceiling when there is no agentId (preview/manual run)",
    async () => {
      vi.stubEnv("RUN_COST_CEILING_USDC", "5");
      mockRepo.sumAgentCostSince.mockRejectedValue(new Error("should not be called"));
      mockPriced.priceUsdc = 6; // over the $5 absolute ceiling
      mockPriced.costUsdc = 6;
      const { runToCompletion, RunCostCeilingExceededError } = await import("@/lib/run-service");

      const err: unknown = await runToCompletion(pricedGraph("g-no-agent"), {
        trigger: "manual",
        agentId: null,
        flowId: "flow-no-agent",
        dryRun: false,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RunCostCeilingExceededError);
      const ceilingErr = err as InstanceType<typeof RunCostCeilingExceededError>;
      expect(ceilingErr.ceilingUsdc).toBeCloseTo(5, 5);
      expect(mockRepo.sumAgentCostSince).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a run within the ceiling completes normally with no ceiling error",
    async () => {
      vi.stubEnv("RUN_COST_CEILING_USDC", "5");
      mockRepo.sumAgentCostSince.mockResolvedValue(0);
      mockPriced.priceUsdc = 0.5;
      mockPriced.costUsdc = 0.5;
      const { runToCompletion } = await import("@/lib/run-service");

      const summary = await runToCompletion(pricedGraph("g-under"), {
        trigger: "agent",
        agentId: "agent-under",
        flowId: "flow-under",
        dryRun: false,
      });

      expect(summary.status).toBe("done");
      expect(summary.totalCostUsdc).toBeCloseTo(0.5, 5);
      expect(mockPricedNodeExecutor).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the ceiling abort is typed and distinguishable from an ordinary node failure",
    async () => {
      // Ceiling abort: rejects with a typed error, never resolves a summary.
      vi.stubEnv("RUN_COST_CEILING_USDC", "1");
      mockRepo.sumAgentCostSince.mockResolvedValue(0);
      mockPriced.priceUsdc = 2;
      mockPriced.costUsdc = 2;
      const { runToCompletion, RunCostCeilingExceededError, AgentDailyCapExceededError } = await import(
        "@/lib/run-service"
      );

      await expect(
        runToCompletion(pricedGraph("g-typed"), {
          trigger: "agent",
          agentId: "agent-typed",
          flowId: "flow-typed",
          dryRun: false,
        }),
      ).rejects.toBeInstanceOf(RunCostCeilingExceededError);

      // Sanity: it's specifically the cost-ceiling error, not the daily cap
      // error (a different, pre-existing, similarly-shaped typed error).
      await expect(
        runToCompletion(pricedGraph("g-typed-2"), {
          trigger: "agent",
          agentId: "agent-typed-2",
          flowId: "flow-typed-2",
          dryRun: false,
        }),
      ).rejects.not.toBeInstanceOf(AgentDailyCapExceededError);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an ordinary node failure (not a ceiling breach) resolves a status:\"error\" summary instead of rejecting",
    async () => {
      vi.stubEnv("RUN_COST_CEILING_USDC", "5");
      mockRepo.sumAgentCostSince.mockResolvedValue(0);
      mockPriced.priceUsdc = 0.1;
      mockPriced.costUsdc = 0.1;
      mockPricedNodeExecutor.mockResolvedValueOnce({ ok: false, error: "boom", costUsdc: 0 });
      const { runToCompletion } = await import("@/lib/run-service");

      const summary = await runToCompletion(pricedGraph("g-plain-fail"), {
        trigger: "agent",
        agentId: "agent-plain-fail",
        flowId: "flow-plain-fail",
        dryRun: false,
      });

      expect(summary.status).toBe("error");
    },
    TEST_TIMEOUT_MS,
  );
});
