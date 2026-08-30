/**
 * Tests for the in-run cost ceiling in src/lib/flow/engine.ts.
 *
 * Context: the per-agent daily cost cap (run-service.ts) is only ever
 * checked once, before a run starts, against PAST spend. A loop node can
 * execute a subflow up to LOOP_ITERATION_CEILING times inside a SINGLE run,
 * so a run could blow past the daily cap by an unbounded multiple before
 * the next run's check would ever notice. This ceiling closes that gap: it
 * is checked live, inside the run, before every cost-bearing node.
 *
 * These tests exercise engine.ts's runFlow/collectRun directly (not through
 * run-service.ts), using ctx.dryRun: false so the projected-cost check
 * actually applies — makeCtx() defaults to dryRun: true, under which the
 * ceiling is deliberately inert (see the "dry-run" describe block).
 */
import { describe, it, expect, vi } from "vitest";
import { runFlow, collectRun } from "@/lib/flow/engine";
import { loopNode } from "@/lib/flow/nodes/loop";
import { subflowNode } from "@/lib/flow/nodes/subflow";
import type { NodeDef } from "@/lib/flow/executor";
import { makeCtx, passNode, node, edge, graph, registry } from "../_helpers";
import { readFileSync } from "node:fs";

describe("in-run cost ceiling — absolute per-run ceiling", () => {
  it("documents concurrent and nested estimate under-runs without claiming a one-leaf bound", () => {
    const source = readFileSync(new URL("../../src/lib/flow/engine.ts", import.meta.url), "utf8");
    expect(source).toMatch(/concurrent.*nested.*underestimat/is);
    expect(source).not.toMatch(/overshoot[^.]*up to one[^.]*in-flight/i);
  });
  it("releases an in-flight reservation when the async generator is cancelled at node:start", async () => {
    const ctx = makeCtx({
      dryRun: false,
      costCeiling: { limitUsdc: 2, spentUsdc: 0, reservedUsdc: 0 },
    });
    const gen = runFlow(graph([node("paid", "llm")], []), ctx, registry([passNode("llm", 1)]), {});
    expect((await gen.next()).value).toMatchObject({ kind: "run:start" });
    expect((await gen.next()).value).toMatchObject({ kind: "node:start", nodeId: "paid" });
    expect(ctx.costCeiling.reservedUsdc).toBe(1);
    await gen.return(undefined);
    expect(ctx.costCeiling.reservedUsdc).toBe(0);
    expect(ctx.costCeiling.spentUsdc).toBe(0);
  });
  it("aborts before executing the node that would cross the ceiling, and does not charge for it", async () => {
    // a costs 2, b costs 2, c costs 2 — ceiling is 3. a runs (spent=2), b
    // would bring cumulative spend to 4 > 3, so b must be refused before it
    // ever executes, and c (downstream of b) must never run either.
    const g = graph(
      [node("a", "llm"), node("b", "http" as never), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    const bExecutor = vi.fn(async (_ctx, _params, inputs) => ({
      ok: true as const,
      outputs: { result: inputs },
      costUsdc: 2,
    }));
    const reg = registry([
      passNode("llm", 2),
      { ...passNode("http" as never, 2), executor: bExecutor },
      passNode("output", 2),
    ]);
    const ctx = makeCtx({ dryRun: false, costCeiling: { limitUsdc: 3, spentUsdc: 0 } });

    const { events, status, totalCostUsdc } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(bExecutor).not.toHaveBeenCalled(); // never executed — never charged
    expect(status).toBe("error");
    expect(totalCostUsdc).toBeCloseTo(2, 5); // only a's cost, b was refused before running
    expect(events.some((e) => e.kind === "node:done" && e.nodeId === "a")).toBe(true);
    expect(events.some((e) => e.kind === "node:start" && e.nodeId === "b")).toBe(false);
    expect(events.some((e) => e.kind === "node:start" && e.nodeId === "c")).toBe(false);

    const bError = events.find((e) => e.kind === "node:error" && e.nodeId === "b");
    expect(bError).toBeDefined();
    if (bError && bError.kind === "node:error") {
      expect(bError.costCeilingExceeded).toBe(true);
      expect(bError.error).toMatch(/cost ceiling/i);
      expect(bError.error).not.toContain("undefined");
    }

    const runDone = events.find((e) => e.kind === "run:done");
    expect(runDone).toBeDefined();
    if (runDone && runDone.kind === "run:done") {
      expect(runDone.abortedReason).toBe("cost-ceiling");
    }
  });

  it("aborts the whole run, not just the offending node's downstream branch", async () => {
    // b (costing 5) exceeds the ceiling (3) and has an independent sibling
    // branch d. Ordinary node failures let independent branches complete
    // (see engine.test.ts) — a cost-ceiling abort must NOT: d must not run
    // either, because the whole run is out of budget.
    const g = graph(
      [node("a", "input"), node("b", "llm"), node("d", "http" as never)],
      [edge("a", "b"), edge("a", "d")],
    );
    const reg = registry([passNode("input"), passNode("llm", 5), passNode("http" as never, 0)]);
    const ctx = makeCtx({ dryRun: false, costCeiling: { limitUsdc: 3, spentUsdc: 0 } });

    const { events } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(events.some((e) => e.kind === "node:start" && e.nodeId === "d")).toBe(false);
  });

  it("does not abort when spend stays within the ceiling", async () => {
    const g = graph([node("a", "llm")], []);
    const reg = registry([passNode("llm", 2)]);
    const ctx = makeCtx({ dryRun: false, costCeiling: { limitUsdc: 3, spentUsdc: 0 } });

    const { status, totalCostUsdc } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(status).toBe("done");
    expect(totalCostUsdc).toBeCloseTo(2, 5);
  });
});

describe("in-run cost ceiling — dry run cooperation", () => {
  it("never trips even with many nominally-expensive cost-bearing nodes", async () => {
    // 20 chained "llm" nodes each declaring a $10 list price — 200x over a
    // $1 ceiling if taken at face value. In dry run, the projected cost the
    // engine checks against is forced to $0 regardless of priceUsdc, so
    // this must complete cleanly.
    const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`, "llm"));
    const edges = nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id));
    const g = graph(nodes, edges);
    const reg = registry([passNode("llm", 10)]);
    const ctx = makeCtx({ dryRun: true, costCeiling: { limitUsdc: 1, spentUsdc: 0 } });

    const { status, events } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(status).toBe("done");
    expect(events.some((e) => e.kind === "node:error")).toBe(false);
    expect(events.filter((e) => e.kind === "node:done")).toHaveLength(20);
  });
});

describe("in-run cost ceiling — loop node", () => {
  it("halts partway through its iterations when the ceiling is reached, and reports how many completed", async () => {
    // Each iteration's subflow costs 1. Ceiling is 3, so at most 3
    // iterations can complete before the 4th is refused.
    const sub = graph([node("only", "echo" as never)], []);
    const echoDef: NodeDef = { ...passNode("echo" as never, 1) };
    const ctx = makeCtx({
      dryRun: false,
      registry: registry([echoDef]),
      loadSubflow: async () => sub,
      costCeiling: { limitUsdc: 3, spentUsdc: 0 },
    });

    const items = [1, 2, 3, 4, 5, 6];
    const res = await loopNode.executor(ctx, { flowId: "sub-1", concurrency: 1 }, { in: items });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.costCeilingExceeded).toBe(true);
      expect(res.error).toMatch(/3 of 6/);
      expect(res.costUsdc).toBeCloseTo(3, 5);
    }
  });

  it("propagates the abort through the engine so the whole run stops, not just the loop", async () => {
    const sub = graph([node("only", "echo" as never)], []);
    const outerGraph = graph(
      [{ ...node("b", "loop"), params: { flowId: "sub-1", concurrency: 1 } }, node("c", "output")],
      [edge("b", "c")],
    );
    const outerReg = registry([loopNode, passNode("output")]);
    const ctx = makeCtx({
      dryRun: false,
      registry: registry([passNode("echo" as never, 1)]),
      loadSubflow: async () => sub,
      costCeiling: { limitUsdc: 2, spentUsdc: 0 },
    });

    const { events, status } = await collectRun(runFlow(outerGraph, ctx, outerReg, { in: [1, 2, 3, 4, 5] }));

    expect(status).toBe("error");
    expect(events.some((e) => e.kind === "node:start" && e.nodeId === "c")).toBe(false);
    const bError = events.find((e) => e.kind === "node:error" && e.nodeId === "b");
    expect(bError).toBeDefined();
    if (bError && bError.kind === "node:error") {
      expect(bError.costCeilingExceeded).toBe(true);
    }
  });

  it("a dry-run loop never trips the ceiling regardless of declared subflow cost", async () => {
    const sub = graph([node("only", "echo" as never)], []);
    const ctx = makeCtx({
      dryRun: true,
      registry: registry([passNode("echo" as never, 5)]),
      loadSubflow: async () => sub,
      costCeiling: { limitUsdc: 1, spentUsdc: 0 },
    });

    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: [1, 2, 3, 4] });

    expect(res.ok).toBe(true);
  });
});

describe("in-run cost ceiling — subflow node", () => {
  it("propagates a ceiling abort from a nested subflow as costCeilingExceeded, not a plain failure", async () => {
    const sub = graph(
      [node("x", "llm"), node("y", "http" as never)],
      [edge("x", "y")],
    );
    const childReg = registry([passNode("llm", 2), passNode("http" as never, 2)]);
    const ctx = makeCtx({
      dryRun: false,
      registry: childReg,
      loadSubflow: async () => sub,
      costCeiling: { limitUsdc: 3, spentUsdc: 0 },
    });

    const res = await subflowNode.executor(ctx, { flowId: "sub-1" }, {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.costCeilingExceeded).toBe(true);
      expect(res.costUsdc).toBeCloseTo(2, 5); // x ran and was charged, y was refused
    }
  });
});

describe("in-run cost ceiling — distinguishable from a node failure", () => {
  it("a plain node failure has no costCeilingExceeded flag and the run's independent branches still complete", async () => {
    const g = graph(
      [node("a", "input"), node("b", "llm"), node("d", "http" as never)],
      [edge("a", "b"), edge("a", "d")],
    );
    const failing: NodeDef = {
      ...passNode("llm", 0),
      executor: async () => ({ ok: false, error: "boom", costUsdc: 0 }),
    };
    const reg = registry([passNode("input"), failing, passNode("http" as never, 0)]);
    const ctx = makeCtx({ dryRun: false, costCeiling: { limitUsdc: 3, spentUsdc: 0 } });

    const { events, status } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(status).toBe("error");
    const bError = events.find((e) => e.kind === "node:error" && e.nodeId === "b");
    if (bError && bError.kind === "node:error") {
      expect(bError.costCeilingExceeded).toBeUndefined();
    }
    // Independent branch d still ran — ordinary failures only halt their
    // own downstream, unlike a cost-ceiling abort.
    expect(events.some((e) => e.kind === "node:done" && e.nodeId === "d")).toBe(true);
  });
});
