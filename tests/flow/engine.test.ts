import { describe, it, expect, vi } from "vitest";
import {
  runFlow,
  collectRun,
  topoSort,
  FlowCycleError,
  MAX_SUBFLOW_DEPTH,
  SubflowDepthError,
} from "@/lib/flow/engine";
import { makeCtx, passNode, failNode, node, edge, graph, registry } from "../_helpers";
import { subflowNode } from "@/lib/flow/nodes/subflow";
import { loopNode } from "@/lib/flow/nodes/loop";

describe("topoSort", () => {
  it("orders a linear chain", () => {
    const g = graph(
      [node("a", "input"), node("b", "llm"), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(topoSort(g)).toEqual(["a", "b", "c"]);
  });

  it("throws on a cycle", () => {
    const g = graph(
      [node("a", "input"), node("b", "llm")],
      [edge("a", "b"), edge("b", "a")],
    );
    expect(() => topoSort(g)).toThrow(FlowCycleError);
  });
});

describe("runFlow", () => {
  it("refuses dispatch when the optional run signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const execute = vi.fn(async () => ({ ok: true as const, outputs: { result: true }, costUsdc: 0 }));
    const def = { ...passNode("input"), executor: execute, dryRunStub: execute };

    await expect(collectRun(runFlow(
      graph([node("a", "input")], []),
      makeCtx({ signal: controller.signal }),
      registry([def]),
    ))).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("checks cancellation after every yielded event before dispatching the next node", async () => {
    const controller = new AbortController();
    const second = vi.fn(async () => ({ ok: true as const, outputs: { result: true }, costUsdc: 0 }));
    const reg = registry([
      passNode("input"),
      { ...passNode("output"), executor: second, dryRunStub: second },
    ]);
    const generator = runFlow(
      graph([node("a", "input"), node("b", "output")], [edge("a", "b")]),
      makeCtx({ signal: controller.signal }),
      reg,
    );

    await expect(generator.next()).resolves.toMatchObject({ value: { kind: "run:start" } });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(generator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(second).not.toHaveBeenCalled();
  });

  it("propagates the optional signal into safe subflow loading", async () => {
    const controller = new AbortController();
    const child = graph([node("child", "input")], []);
    const loadSubflow = vi.fn(async () => child);
    const reg = registry([subflowNode, passNode("input")]);
    const outer = graph([
      { ...node("sub", "subflow"), params: { flowId: "child-flow" } },
    ], []);

    await expect(collectRun(runFlow(
      outer,
      makeCtx({ signal: controller.signal, loadSubflow, registry: reg }),
      reg,
    ))).resolves.toMatchObject({ status: "done" });
    expect(loadSubflow).toHaveBeenCalledWith("child-flow", controller.signal);
  });

  it("stops a loop before another iteration starts after cancellation", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      return { ok: true as const, outputs: { result: true }, costUsdc: 0 };
    });
    const childDef = { ...passNode("input"), executor: execute, dryRunStub: execute };
    const child = graph([node("child", "input")], []);
    const reg = registry([loopNode, childDef]);
    const outer = graph([
      { ...node("loop", "loop"), params: { flowId: "child-flow", concurrency: 1, maxIterations: 3 } },
    ], []);

    await expect(collectRun(runFlow(
      outer,
      makeCtx({
        signal: controller.signal,
        loadSubflow: async () => child,
        registry: reg,
      }),
      reg,
      { in: [1, 2, 3] },
    ))).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("executes nodes in dependency order", async () => {
    const g = graph(
      [node("a", "input"), node("b", "llm"), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    const reg = registry([passNode("input"), passNode("llm"), passNode("output")]);
    const { events, status } = await collectRun(runFlow(g, makeCtx(), reg, { seed: 1 }));
    const doneOrder = events.filter((e) => e.kind === "node:done").map((e) => e.nodeId);
    expect(doneOrder).toEqual(["a", "b", "c"]);
    expect(status).toBe("done");
  });

  it("waits for all parents at a fan-in node", async () => {
    const g = graph(
      [node("a", "input"), node("b", "schedule"), node("c", "output")],
      [edge("a", "c"), edge("b", "c")],
    );
    const reg = registry([passNode("input"), passNode("schedule"), passNode("output")]);
    const { outputs } = await collectRun(runFlow(g, makeCtx(), reg, {}));
    // c's result merges both parents keyed by source id
    const cResult = outputs.c.result as Record<string, unknown>;
    expect(Object.keys(cResult)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("halts a failed node's downstream branch but completes parallel branches", async () => {
    const g = graph(
      [node("a", "input"), node("b", "llm"), node("c", "output"), node("d", "analyze" as never)],
      [edge("a", "b"), edge("b", "c"), edge("a", "d")],
    );
    const reg = registry([
      passNode("input"),
      failNode("llm"),
      passNode("output"),
      passNode("analyze" as never),
    ]);
    const { events, status } = await collectRun(runFlow(g, makeCtx(), reg, {}));
    const done = events.filter((e) => e.kind === "node:done").map((e) => e.nodeId);
    const errored = events.filter((e) => e.kind === "node:error").map((e) => e.nodeId);
    expect(errored).toContain("b");
    expect(done).toContain("d"); // parallel branch still ran
    expect(done).not.toContain("c"); // downstream of failure skipped
    expect(status).toBe("error");
  });

  it("accumulates the cost ledger", async () => {
    const g = graph(
      [node("a", "input"), node("b", "llm"), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    // dryRun: false — this test is about cost-ledger accumulation across
    // nodes, not dry-run semantics. Under dry-run, the engine's central
    // dry-run gate correctly forces cost-bearing nodes to $0 (see
    // dryrun-enumeration.test.ts and http-dryrun.test.ts), so a live-mode
    // ctx is required here to exercise real declared costs.
    const ctx = makeCtx({ dryRun: false });
    const reg = registry([passNode("input", 0.2), passNode("llm", 0.04), passNode("output", 0)]);
    const { totalCostUsdc } = await collectRun(runFlow(g, ctx, reg, {}));
    expect(totalCostUsdc).toBeCloseTo(0.24, 5);
    expect(ctx.logger.totalCostUsdc()).toBeCloseTo(0.24, 5);
  });

  it("emits a visible warning instead of silently clobbering a duplicate fan-in target", async () => {
    // Two edges explicitly targeting the same handle on "c" — an old saved
    // graph shape the canvas now blocks creating, but the engine must still
    // run it without silently dropping the first edge's value.
    const g = graph(
      [node("a", "input"), node("b", "schedule"), node("c", "output")],
      [
        { id: "a->c", source: "a", target: "c", targetHandle: "value" },
        { id: "b->c", source: "b", target: "c", targetHandle: "value" },
      ],
    );
    const reg = registry([passNode("input"), passNode("schedule"), passNode("output")]);
    const { events, status } = await collectRun(runFlow(g, makeCtx(), reg, {}));
    const warnings = events.filter(
      (e) => e.kind === "node:log" && e.nodeId === "c" && e.level === "error",
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect((warnings[0] as { msg: string }).msg).toContain('"value"');
    expect(status).toBe("done"); // still completes — last-write-wins, not a hard failure
  });

  it("does not warn when a fan-in merges edges keyed by distinct sources", async () => {
    const g = graph(
      [node("a", "input"), node("b", "schedule"), node("c", "output")],
      [edge("a", "c"), edge("b", "c")],
    );
    const reg = registry([passNode("input"), passNode("schedule"), passNode("output")]);
    const { events } = await collectRun(runFlow(g, makeCtx(), reg, {}));
    expect(events.filter((e) => e.kind === "node:log")).toHaveLength(0);
  });

  it("routes loop result and errors handles only to their wired downstream nodes", async () => {
    const g = graph(
      [node("loop", "loop"), node("results", "output"), node("errors", "output")],
      [
        {
          id: "loop->results",
          source: "loop",
          sourceHandle: "result",
          target: "results",
          targetHandle: "in",
        },
        {
          id: "loop->errors",
          source: "loop",
          sourceHandle: "errors",
          target: "errors",
          targetHandle: "in",
        },
      ],
    );
    const loopOutputs = {
      result: [{ index: 0, value: "kept" }],
      errors: [{ index: 1, error: "failed" }],
    };
    const loopDef = {
      ...passNode("loop"),
      outputs: ["result", "errors"],
      executor: async () => ({ ok: true as const, outputs: loopOutputs, costUsdc: 0 }),
      dryRunStub: async () => ({ ok: true as const, outputs: loopOutputs, costUsdc: 0 }),
    };
    const reg = registry([loopDef, passNode("output")]);

    const { outputs, status } = await collectRun(runFlow(g, makeCtx(), reg, {}));

    expect(status).toBe("done");
    expect(outputs.results.result).toEqual({ in: loopOutputs.result });
    expect(outputs.errors.result).toEqual({ in: loopOutputs.errors });
    expect(outputs.results.result).not.toEqual({ in: loopOutputs.errors });
    expect(outputs.errors.result).not.toEqual({ in: loopOutputs.result });
  });

  it("guards against runaway subflow recursion", async () => {
    const g = graph([node("a", "input")], []);
    const reg = registry([passNode("input")]);
    await expect(collectRun(runFlow(
      g,
      makeCtx({ depth: MAX_SUBFLOW_DEPTH }),
      reg,
      {},
    ))).resolves.toMatchObject({ status: "done" });
    await expect(collectRun(runFlow(
      g,
      makeCtx({ depth: MAX_SUBFLOW_DEPTH + 1 }),
      reg,
      {},
    ))).rejects.toThrow(
      SubflowDepthError,
    );
  });
});
