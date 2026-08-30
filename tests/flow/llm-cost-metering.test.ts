/**
 * The llm node's real cost surfaces as costUsdc (src/lib/flow/nodes/llm.ts).
 *
 * Historically the executor returned costUsdc: 0 for every call, so real
 * model spend was invisible to the run ledger, the in-run cost ceiling, and
 * the per-agent daily cap. It now prefers the client's usage-reporting
 * variant (LlmClient.generateWithUsage) and returns
 * gatewayCostUsdc(usage.totalTokens); clients without the variant keep the
 * historical zero-cost behavior so minimal test doubles are unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import { llmNode } from "@/lib/flow/nodes/llm";
import { runFlow, collectRun } from "@/lib/flow/engine";
import { gatewayCostUsdc } from "@/lib/billing";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { makeCtx, node, graph, edge, registry } from "../_helpers";
import type { LlmClient } from "@/lib/llm";

function usageClient(totalTokens: number, text = "real-provider-response"): {
  client: LlmClient;
  generateWithUsage: ReturnType<typeof vi.fn>;
} {
  const generateWithUsage = vi.fn(async () => ({ text, usage: { totalTokens } }));
  return {
    client: { generate: vi.fn(async () => text), generateWithUsage },
    generateWithUsage,
  };
}

describe("llm executor — costUsdc from reported usage", () => {
  it("returns gatewayCostUsdc(totalTokens) when the client reports usage", async () => {
    const { client, generateWithUsage } = usageClient(1_500);
    const ctx = makeCtx({ dryRun: false, llm: client });

    const res = await llmNode.executor(ctx, { prompt: "hello" }, {});

    expect(generateWithUsage).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.costUsdc).toBeCloseTo(gatewayCostUsdc(1_500), 9);
      expect(res.costUsdc).toBeGreaterThan(0);
      expect(res.outputs.result).toBe("real-provider-response");
    }
  });

  it("keeps the historical zero cost for a client without generateWithUsage", async () => {
    const generate = vi.fn(async () => "real-provider-response");
    const ctx = makeCtx({ dryRun: false, llm: { generate } });

    const res = await llmNode.executor(ctx, { prompt: "hello" }, {});

    expect(generate).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.costUsdc).toBe(0);
  });

  it("still never reaches the provider (or bills) in dry-run", async () => {
    const { client, generateWithUsage } = usageClient(1_500);
    const ctx = makeCtx({ dryRun: true, llm: client });

    const res = await llmNode.executor(ctx, { prompt: "hello" }, {});

    expect(generateWithUsage).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.costUsdc).toBe(0);
  });

  it("charges nothing when the provider call throws", async () => {
    const generateWithUsage = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    const client: LlmClient = { generate: vi.fn(async () => "x"), generateWithUsage };
    const ctx = makeCtx({ dryRun: false, llm: client });

    const res = await llmNode.executor(ctx, { prompt: "hello" }, {});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.costUsdc).toBe(0);
  });
});

describe("llm node cost — run ledger and in-run cost ceiling", () => {
  it("feeds real spend into run:done totalCostUsdc and the shared cost ceiling ledger", async () => {
    const tokens = 100_000;
    const { client } = usageClient(tokens);
    const ctx = makeCtx({
      dryRun: false,
      llm: client,
      costCeiling: { limitUsdc: 1_000, spentUsdc: 0 },
    });
    const g = graph([{ ...node("a", "llm"), params: { prompt: "hello" } }], []);

    const { status, totalCostUsdc } = await collectRun(
      runFlow(g, ctx, registry([llmNode]), {}),
    );

    expect(status).toBe("done");
    expect(totalCostUsdc).toBeCloseTo(gatewayCostUsdc(tokens), 9);
    expect(ctx.costCeiling.spentUsdc).toBeCloseTo(gatewayCostUsdc(tokens), 9);
  });

  it("lets the in-run cost ceiling abort on REAL llm spend, not just list prices", async () => {
    // 500k tokens ≈ $5.4 of real spend. Ceiling is $3: the first llm call
    // lands, the second must be refused before it executes.
    const tokens = 500_000;
    const { client, generateWithUsage } = usageClient(tokens);
    const ctx = makeCtx({
      dryRun: false,
      llm: client,
      costCeiling: { limitUsdc: 3, spentUsdc: 0 },
    });
    const g = graph(
      [
        { ...node("a", "llm"), params: { prompt: "first" } },
        { ...node("b", "llm"), params: { prompt: "second" } },
      ],
      [edge("a", "b")],
    );

    const { events, status } = await collectRun(runFlow(g, ctx, registry([llmNode]), {}));

    expect(status).toBe("error");
    expect(generateWithUsage).toHaveBeenCalledTimes(1);
    const bError = events.find((e) => e.kind === "node:error" && e.nodeId === "b");
    expect(bError).toBeDefined();
    if (bError && bError.kind === "node:error") {
      expect(bError.costCeilingExceeded).toBe(true);
    }
  });

  it("counts a finished run's real cost toward the per-agent daily cap window", async () => {
    // run-service.ts's daily cap sums runs.total_cost_usdc for the agent —
    // now that llm spend lands in totalCostUsdc, the cap sees it.
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({
      ownerId: "owner-1",
      name: "f",
      graph: { id: "g-daily-cap", name: "f", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "cap-agent",
      status: "live",
      priceUsdc: 0,
    });
    const run = await repo.createRun({
      flowId: flow.id,
      agentId: agent.id,
      trigger: "agent",
      triggerInput: null,
      runVariables: null,
    });
    const cost = gatewayCostUsdc(500_000);
    await repo.finishRun(run.id, "done", cost);

    expect(await repo.sumAgentCostSince(agent.id, Date.now() - 24 * 60 * 60 * 1000)).toBeCloseTo(
      cost,
      6,
    );
  });
});
