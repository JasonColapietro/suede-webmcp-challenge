import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  loopNode,
  LOOP_ITERATION_CEILING,
  type LoopElementError,
} from "@/lib/flow/nodes/loop";
import { inputNode } from "@/lib/flow/nodes/input";
import { llmNode } from "@/lib/flow/nodes/llm";
import { runFlow, collectRun, MAX_SUBFLOW_DEPTH } from "@/lib/flow/engine";
import { getRepo } from "@/lib/db/repo";
import { buildRunContext } from "@/lib/run-context";
import { RunLogger } from "@/lib/log";
import { NODE_TYPE_SET } from "@/lib/flow/node-meta";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import { codegen } from "@/lib/manifest/codegen";
import type { NodeDef } from "@/lib/flow/executor";
import type { FlowGraph, FlowNode } from "@/lib/flow/types";
import type { FlowCallableInterface, FlowGraphV2, SubflowReference } from "@/lib/flow/types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { makeCtx, passNode, node, edge, graph, registry } from "../_helpers";

function withParams(n: FlowNode, params: Record<string, unknown>): FlowNode {
  return { ...n, params };
}

describe("loop node — mapping and ordering", () => {
  it("maps an array through a subflow, preserving order even with concurrent execution", async () => {
    // Elements sleep in reverse order (item 0 sleeps longest) so completion
    // order is the opposite of input order — proving results are written
    // by index, not by arrival.
    const delayNode: NodeDef = {
      type: "delay" as never,
      label: "delay",
      group: "Logic",
      costBearing: false,
      paramsSchema: z.any(),
      inputs: ["in"],
      outputs: ["result"],
      executor: async (_ctx, _params, inputs) => {
        const idx = (inputs as Record<string, unknown>).index as number;
        await new Promise((r) => setTimeout(r, (5 - idx) * 5));
        return { ok: true, outputs: { result: inputs }, costUsdc: 0 };
      },
    };
    const sub = graph([node("d", "delay" as never)], []);
    const ctx = makeCtx({ registry: registry([delayNode]), loadSubflow: async () => sub });

    const items = [10, 20, 30, 40, 50];
    const res = await loopNode.executor(ctx, { flowId: "sub-1", concurrency: 3 }, { in: items });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const resultArr = res.outputs.result as Array<Record<string, Record<string, unknown>> | null>;
      expect(resultArr).toHaveLength(5);
      const gotIn = resultArr.map((r) => (r!.d.result as Record<string, unknown>).in);
      expect(gotIn).toEqual(items);
      expect(res.outputs.errors).toEqual([]);
    }
  });

  it("returns an empty result for an empty array without touching the subflow", async () => {
    const loadSubflow = vi.fn();
    const ctx = makeCtx({ loadSubflow });
    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual([]);
      expect(res.outputs.errors).toEqual([]);
      expect(res.costUsdc).toBe(0);
    }
    expect(loadSubflow).not.toHaveBeenCalled();
  });

  it("rejects a non-array input cleanly", async () => {
    const ctx = makeCtx();
    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: { not: "an array" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not an array/i);
  });

  it("resolves the array via itemsPath when the upstream value is an object", async () => {
    const sub = graph([node("only", "echo" as never)], []);
    const ctx = makeCtx({ registry: registry([passNode("echo" as never)]), loadSubflow: async () => sub });
    const res = await loopNode.executor(
      ctx,
      { flowId: "sub-1", itemsPath: "transactions" },
      { in: { transactions: [1, 2] } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as unknown[]).length).toBe(2);
  });
});

describe("typed loop ABI", () => {
  const callable: FlowCallableInterface = {
    inputs: [{ id: "value", label: "Value", schema: {}, required: true, cardinality: "one", target: { kind: "trigger", path: "/value" } }],
    outputs: [{ id: "doubled", label: "Doubled", schema: {}, required: true, cardinality: "one", source: { nodeId: "work", portId: "result" } }],
  };
  const reference: SubflowReference = { kind: "draft", flowId: "typed-child", interface: callable, interfaceHash: hashCallableInterface(callable) };
  const child: FlowGraphV2 = {
    schemaVersion: 2, id: "typed-child-graph", name: "Typed", variables: [], groups: [], annotations: [], callableInterface: callable,
    nodes: [{ id: "work", type: "transform", position: { x: 0, y: 0 }, params: {}, bindings: {} }], edges: [],
  };
  const work: NodeDef = {
    type: "transform", label: "Work", group: "Logic", costBearing: false, paramsSchema: z.any(), inputs: ["in"], outputs: ["result"],
    executor: async (_ctx, _params, inputs) => typeof inputs.value === "number" && inputs.value === 2
      ? { ok: false, error: "two refused", costUsdc: 0 }
      : { ok: true, outputs: { result: (inputs.value as number) * 2 }, costUsdc: 0 },
  };

  it("returns ordered fixed-length nullable named outputs and indexed errors", async () => {
    const ctx = makeCtx({ registry: registry([work]), resolveSubflow: async () => ({ graph: child, flowId: "typed-child", semanticHash: "a".repeat(64), callableInterface: callable }) });
    const result = await loopNode.executor(ctx, { reference, concurrency: 3 }, { items: [{ value: 1 }, { value: 2 }, { value: 3 }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outputs.doubled).toEqual([2, null, 6]);
      expect(result.outputs.errors).toEqual([{ index: 1, error: "work: two refused" }]);
      expect(result.outputs).not.toHaveProperty("result");
    }
  });

  it("fails only an item containing undeclared callable input keys", async () => {
    const ctx = makeCtx({ registry: registry([work]), resolveSubflow: async () => ({ graph: child, flowId: "typed-child", semanticHash: "a".repeat(64), callableInterface: callable }) });
    const result = await loopNode.executor(ctx, { reference }, { items: [{ value: 1, extra: true }, { value: 3 }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outputs.doubled).toEqual([null, 6]);
      expect(result.outputs.errors).toEqual([{ index: 0, error: expect.stringMatching(/undeclared.*extra/i) }]);
    }
  });

  it("refuses typed and legacy self-recursion before any loop item dispatch", async () => {
    let dispatches = 0;
    const probe = { ...work, executor: async () => { dispatches += 1; return { ok: true as const, outputs: { result: 1 }, costUsdc: 0 }; } };
    const typedCtx = makeCtx({
      flowAncestry: Object.freeze(["typed-child"]), registry: registry([probe]),
      resolveSubflow: async () => ({ graph: child, flowId: "typed-child", semanticHash: "a".repeat(64), callableInterface: callable }),
    });
    const typed = await loopNode.executor(typedCtx, { reference }, { items: [{ value: 1 }] });
    expect(typed.ok).toBe(false);
    if (!typed.ok) expect(typed.error).toMatch(/recursive subflow.*typed-child/i);

    const legacyCtx = makeCtx({
      flowAncestry: Object.freeze(["legacy-child"]), registry: registry([probe]),
      loadSubflow: async () => child,
    });
    const legacy = await loopNode.executor(legacyCtx, { flowId: "legacy-child" }, { in: [1] });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.error).toMatch(/recursive subflow.*legacy-child/i);
    expect(dispatches).toBe(0);
    expect(typedCtx.costCeiling.spentUsdc).toBe(0);
    expect(legacyCtx.costCeiling.spentUsdc).toBe(0);
  });

  it("reports successful typed iterations accurately when a later item hits the cost ceiling", async () => {
    let calls = 0;
    const paid: NodeDef = {
      type: "llm", label: "Paid", group: "AI", priceUsdc: 0.6,
      paramsSchema: z.any(), inputs: ["in"], outputs: ["result"],
      dryRunStub: async () => ({ ok: true, outputs: { result: "dry" }, costUsdc: 0 }),
      executor: async (_ctx, _params, inputs) => {
        calls += 1;
        return { ok: true, outputs: { result: (inputs.value as number) * 2 }, costUsdc: 0.6 };
      },
    };
    const paidChild: FlowGraphV2 = {
      ...child,
      nodes: [{ id: "work", type: "llm", position: { x: 0, y: 0 }, params: {}, bindings: {} }],
    };
    const ctx = makeCtx({
      dryRun: false,
      registry: registry([paid]),
      resolveSubflow: async () => ({ graph: paidChild, flowId: "typed-child", semanticHash: "a".repeat(64), callableInterface: callable }),
      costCeiling: { limitUsdc: 1, spentUsdc: 0, reservedUsdc: 0 },
    });
    const result = await loopNode.executor(ctx, { reference, concurrency: 1 }, { items: [{ value: 1 }, { value: 2 }, { value: 3 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.costCeilingExceeded).toBe(true);
      expect(result.error).toMatch(/1 of 3 iterations completed/i);
      expect(result.costUsdc).toBeCloseTo(0.6);
    }
    expect(calls).toBe(1);
  });

  it("counts a paid child completion even when its typed output projection fails before a later ceiling abort", async () => {
    const projectedInterface: FlowCallableInterface = {
      ...callable,
      outputs: [{ ...callable.outputs[0]!, source: { nodeId: "work", portId: "result", path: "/missing" } }],
    };
    const projectedReference: SubflowReference = {
      kind: "draft", flowId: "typed-child", interface: projectedInterface,
      interfaceHash: hashCallableInterface(projectedInterface),
    };
    const paid: NodeDef = {
      type: "llm", label: "Paid", group: "AI", priceUsdc: 0.6,
      paramsSchema: z.any(), inputs: ["in"], outputs: ["result"],
      dryRunStub: async () => ({ ok: true, outputs: { result: "dry" }, costUsdc: 0 }),
      executor: async () => ({ ok: true, outputs: { result: 2 }, costUsdc: 0.6 }),
    };
    const paidChild: FlowGraphV2 = {
      ...child, callableInterface: projectedInterface,
      nodes: [{ id: "work", type: "llm", position: { x: 0, y: 0 }, params: {}, bindings: {} }],
    };
    const ctx = makeCtx({
      dryRun: false, registry: registry([paid]),
      resolveSubflow: async () => ({ graph: paidChild, flowId: "typed-child", semanticHash: "a".repeat(64), callableInterface: projectedInterface }),
      costCeiling: { limitUsdc: 1, spentUsdc: 0, reservedUsdc: 0 },
    });
    const result = await loopNode.executor(ctx, { reference: projectedReference, concurrency: 1 }, { items: [{ value: 1 }, { value: 2 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/1 of 2 iterations completed/i);
      expect(result.costUsdc).toBeCloseTo(0.6);
    }
  });
});

describe("loop node — iteration ceiling", () => {
  it("rejects input longer than the configured max iterations, without truncating", async () => {
    const ctx = makeCtx();
    const items = Array.from({ length: 5 }, (_, i) => i);
    const res = await loopNode.executor(ctx, { flowId: "sub-1", maxIterations: 3 }, { in: items });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/over the configured cap of 3/i);
      expect(res.error).toMatch(/5 items/);
    }
  });

  it("clamps a configured max iterations above the absolute ceiling and still enforces it", async () => {
    const ctx = makeCtx();
    const items = Array.from({ length: LOOP_ITERATION_CEILING + 1 }, (_, i) => i);
    const res = await loopNode.executor(
      ctx,
      { flowId: "sub-1", maxIterations: LOOP_ITERATION_CEILING + 50 },
      { in: items },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(new RegExp(`over the absolute cap of ${LOOP_ITERATION_CEILING}`));
  });

  it("accepts input exactly at the default cap", async () => {
    const sub = graph([node("only", "echo" as never)], []);
    const ctx = makeCtx({ registry: registry([passNode("echo" as never)]), loadSubflow: async () => sub });
    const items = Array.from({ length: 50 }, (_, i) => i); // LOOP_DEFAULT_MAX_ITERATIONS
    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: items });
    expect(res.ok).toBe(true);
  });
});

describe("loop node — depth guard", () => {
  it("is blocked by the subflow depth guard when already at max nesting depth", async () => {
    // A loop node reached at ctx.depth === MAX_SUBFLOW_DEPTH (already one
    // subflow/loop deep) must refuse to go one level deeper, exactly like a
    // plain Subflow node would. This is what stops loop-inside-loop from
    // recursing without bound: nesting is bounded by the same constant
    // engine.ts already enforces for subflow.ts.
    const sub = graph([node("only", "echo" as never)], []);
    const ctx = makeCtx({
      depth: MAX_SUBFLOW_DEPTH,
      registry: registry([passNode("echo" as never)]),
      loadSubflow: async () => sub,
    });
    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: [1, 2] });
    // Structurally the loop still starts fine (valid array, subflow loads) —
    // the depth guard fires per-element inside the nested runFlow call, and
    // collect-errors surfaces it instead of throwing out of the node.
    expect(res.ok).toBe(true);
    if (res.ok) {
      const errors = res.outputs.errors as LoopElementError[];
      expect(errors).toHaveLength(2);
      expect(errors[0].error).toMatch(/exceeds max/i);
      expect(res.outputs.result).toEqual([null, null]);
    }
  });
});

describe("loop node — concurrency", () => {
  it("never runs more than the configured concurrency limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const probe: NodeDef = {
      type: "probe" as never,
      label: "probe",
      group: "Logic",
      costBearing: false,
      paramsSchema: z.any(),
      inputs: ["in"],
      outputs: ["result"],
      executor: async (_ctx, _params, inputs) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return { ok: true, outputs: { result: inputs }, costUsdc: 0 };
      },
    };
    const sub = graph([node("p", "probe" as never)], []);
    const ctx = makeCtx({ registry: registry([probe]), loadSubflow: async () => sub });
    const items = Array.from({ length: 8 }, (_, i) => i);

    await loopNode.executor(ctx, { flowId: "sub-1", concurrency: 2 }, { in: items });

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1); // sanity: it did run concurrently, not serialized to 1
  });

  it("clamps a concurrency value above the absolute ceiling", async () => {
    let peak = 0;
    let inFlight = 0;
    const probe: NodeDef = {
      type: "probe" as never,
      label: "probe",
      group: "Logic",
      costBearing: false,
      paramsSchema: z.any(),
      inputs: ["in"],
      outputs: ["result"],
      executor: async (_ctx, _params, inputs) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { ok: true, outputs: { result: inputs }, costUsdc: 0 };
      },
    };
    const sub = graph([node("p", "probe" as never)], []);
    const ctx = makeCtx({ registry: registry([probe]), loadSubflow: async () => sub });
    const items = Array.from({ length: 10 }, (_, i) => i);

    await loopNode.executor(ctx, { flowId: "sub-1", concurrency: 999 }, { in: items });

    expect(peak).toBeLessThanOrEqual(4); // LOOP_CONCURRENCY_CEILING
  });
});

describe("loop node — element failure policy (collect-errors)", () => {
  it("collects per-element failures instead of failing the whole loop", async () => {
    const maybeFail: NodeDef = {
      type: "maybeFail" as never,
      label: "maybeFail",
      group: "Logic",
      costBearing: false,
      paramsSchema: z.any(),
      inputs: ["in"],
      outputs: ["result"],
      executor: async (_ctx, _params, inputs) => {
        const idx = (inputs as Record<string, unknown>).index as number;
        if (idx === 1) return { ok: false, error: "boom at index 1", costUsdc: 0 };
        return { ok: true, outputs: { result: inputs }, costUsdc: 0 };
      },
    };
    const sub = graph([node("m", "maybeFail" as never)], []);
    const ctx = makeCtx({ registry: registry([maybeFail]), loadSubflow: async () => sub });

    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: ["a", "b", "c"] });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const results = res.outputs.result as unknown[];
      const errors = res.outputs.errors as LoopElementError[];
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBeNull();
      expect(results[2]).not.toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
      expect(errors[0].error).toContain("boom at index 1");
    }
  });
});

describe("loop node — output handle routing", () => {
  // Proves the runtime contract the canvas's second output handle relies on:
  // a handle-less edge from a loop carries its `result` array, and an edge
  // tagged with sourceHandle "errors" carries its `errors` array. This is what
  // the SuedeNode canvas produces when a user wires the default vs. the errors
  // handle, so it must hold end to end through the real engine, not just in the
  // manifest round-trip.
  it("routes result to a default edge and errors to the 'errors' handle edge", async () => {
    const maybeFail: NodeDef = {
      type: "maybeFail" as never,
      label: "maybeFail",
      group: "Logic",
      costBearing: false,
      paramsSchema: z.any(),
      inputs: ["in"],
      outputs: ["result"],
      executor: async (_ctx, _params, inputs) => {
        const idx = (inputs as Record<string, unknown>).index as number;
        if (idx === 1) return { ok: false, error: "boom at index 1", costUsdc: 0 };
        return { ok: true, outputs: { result: inputs }, costUsdc: 0 };
      },
    };
    const sub = graph([node("m", "maybeFail" as never)], []);

    // loop -> resultSink via the default handle; loop -> errorSink via "errors".
    const outerGraph = graph(
      [
        withParams(node("loop", "loop"), { flowId: "sub-1" }),
        node("resultSink", "output"),
        node("errorSink", "output"),
      ],
      [edge("loop", "resultSink"), edge("loop", "errorSink", "errors")],
    );
    const outerReg = registry([loopNode, passNode("output")]);
    const ctx = makeCtx({
      registry: registry([maybeFail]),
      loadSubflow: async () => sub,
    });

    const run = await collectRun(runFlow(outerGraph, ctx, outerReg, { in: ["a", "b", "c"] }));
    expect(run.status).toBe("done");

    // passNode("output") echoes its inputs as { result: { [sourceId]: value } },
    // so each sink's received value is keyed by the loop node id.
    const resultReceived = (run.outputs.resultSink.result as Record<string, unknown>).loop as unknown[];
    const errorReceived = (run.outputs.errorSink.result as Record<string, unknown>).loop as LoopElementError[];

    // The default handle carried the results array (index 1 failed -> null).
    expect(resultReceived).toHaveLength(3);
    expect(resultReceived[0]).not.toBeNull();
    expect(resultReceived[1]).toBeNull();
    expect(resultReceived[2]).not.toBeNull();

    // The "errors" handle carried the errors array, NOT the results array.
    expect(errorReceived).toHaveLength(1);
    expect(errorReceived[0].index).toBe(1);
    expect(errorReceived[0].error).toContain("boom at index 1");
  });

  it("keeps the errors edge inactive-safe: an empty errors array still routes as an array", async () => {
    const sub = graph([node("only", "echo" as never)], []);
    const outerGraph = graph(
      [
        withParams(node("loop", "loop"), { flowId: "sub-1" }),
        node("errorSink", "output"),
      ],
      [edge("loop", "errorSink", "errors")],
    );
    const outerReg = registry([loopNode, passNode("output")]);
    const ctx = makeCtx({
      registry: registry([passNode("echo" as never)]),
      loadSubflow: async () => sub,
    });

    const run = await collectRun(runFlow(outerGraph, ctx, outerReg, { in: [1, 2] }));
    expect(run.status).toBe("done");
    const errorReceived = (run.outputs.errorSink.result as Record<string, unknown>).loop as LoopElementError[];
    // Loop always populates `errors` (empty here), so the errors edge is active
    // and delivers an empty array rather than dropping the downstream node.
    expect(errorReceived).toEqual([]);
  });
});

describe("loop node — cost ledger", () => {
  it("reserves projected cost synchronously so concurrent workers do not all dispatch", async () => {
    let externalCalls = 0;
    const paid: NodeDef = {
      type: "llm", label: "Paid", group: "AI", priceUsdc: 0.6,
      paramsSchema: z.any(), inputs: ["in"], outputs: ["result"],
      dryRunStub: async () => ({ ok: true, outputs: { result: "dry" }, costUsdc: 0 }),
      executor: async (_ctx, _params, inputs) => {
        externalCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, outputs: { result: inputs }, costUsdc: 0.6 };
      },
    };
    const sub = graph([node("paid", "llm")], []);
    const ctx = makeCtx({
      dryRun: false,
      registry: registry([paid]),
      loadSubflow: async () => sub,
      costCeiling: { limitUsdc: 1, spentUsdc: 0, reservedUsdc: 0 },
    });
    const result = await loopNode.executor(ctx, { flowId: "paid-child", concurrency: 4 }, { in: [1, 2, 3, 4] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.costCeilingExceeded).toBe(true);
    expect(externalCalls).toBe(1);
    expect(ctx.costCeiling.spentUsdc).toBeCloseTo(0.6);
    expect(ctx.costCeiling.reservedUsdc).toBe(0);
  });
  it("sums per-element subflow cost into the loop node's own cost", async () => {
    const sub = graph([node("only", "echo" as never)], []);
    // dryRun: false — this test is about cost-ledger accumulation through a
    // loop, not dry-run semantics (that's covered separately by "loop node
    // — dry-run" below and dryrun-enumeration.test.ts). Under dry-run, the
    // inner "echo" node's cost is correctly forced to $0 by the engine's
    // central dry-run gate.
    const ctx = makeCtx({
      dryRun: false,
      registry: registry([passNode("echo" as never, 0.05)]),
      loadSubflow: async () => sub,
    });

    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: [1, 2, 3] });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.costUsdc).toBeCloseTo(0.15, 5);
  });

  it("flows into the run's total cost through the engine, exactly like any other node", async () => {
    const sub = graph([node("only", "echo" as never)], []);
    const outerGraph = graph(
      [withParams(node("b", "loop"), { flowId: "sub-1" }), node("c", "output")],
      [edge("b", "c")],
    );
    const outerReg = registry([loopNode, passNode("output")]);
    const ctx = makeCtx({
      dryRun: false,
      registry: registry([passNode("echo" as never, 0.05)]),
      loadSubflow: async () => sub,
    });

    const { totalCostUsdc, status } = await collectRun(
      runFlow(outerGraph, ctx, outerReg, { in: [1, 2, 3] }),
    );

    expect(status).toBe("done");
    expect(totalCostUsdc).toBeCloseTo(0.15, 5);
  });
});

describe("loop node — dry-run", () => {
  it("does not execute a real LLM call inside the subflow during dry-run", async () => {
    const generate = vi.fn().mockResolvedValue("real-provider-response");
    const sub = graph(
      [node("i", "input"), withParams(node("l", "llm"), { prompt: "summarize {{i.result.in}}" })],
      [edge("i", "l")],
    );
    const ctx = makeCtx({
      dryRun: true,
      llm: { generate },
      registry: registry([inputNode, llmNode]),
      loadSubflow: async () => sub,
    });

    const res = await loopNode.executor(ctx, { flowId: "sub-1" }, { in: [1] });

    expect(generate).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.costUsdc).toBe(0);
      const results = res.outputs.result as Array<Record<string, Record<string, unknown>>>;
      expect(String(results[0].l.result)).toContain("dry-run");
    }
  });
});

describe("loop node — manifest round-trip", () => {
  it("is a known node type and its config round-trips through the manifest compiler", () => {
    expect(NODE_TYPE_SET.has("loop")).toBe(true);

    const g = graph(
      [node("a", "input"), withParams(node("b", "loop"), { flowId: "sub-1", concurrency: 2 }), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    const manifest = flowToManifest(g);
    const loopStep = manifest.steps.find((s) => s.id === "b");
    expect(loopStep?.type).toBe("loop");
    expect(loopStep?.config).toEqual({ flowId: "sub-1", concurrency: 2 });

    const rebuilt = manifestToFlow(manifest);
    const rebuiltLoopNode = rebuilt.nodes.find((n) => n.id === "b");
    expect(rebuiltLoopNode?.params).toEqual({ flowId: "sub-1", concurrency: 2 });

    // codegen does not throw and includes the step id/type like any other node.
    const src = codegen(manifest);
    expect(src).toContain('"loop"');
    expect(src).toContain("b");
  });

  it("a downstream edge wired to the \"errors\" handle survives the manifest round-trip", () => {
    const g = graph(
      [
        node("a", "input"),
        withParams(node("b", "loop"), { flowId: "sub-1" }),
        node("c", "output"),
      ],
      [edge("a", "b"), { id: "b->c", source: "b", target: "c", sourceHandle: "errors" }],
    );
    const manifest = flowToManifest(g);
    // The manifest now carries the source handle alongside the node id, so the
    // errors-handle wiring is visible in the manifest itself, not just after a
    // round-trip back to a flow.
    const cStep = manifest.steps.find((s) => s.id === "c");
    expect(cStep?.after).toEqual([{ node: "b", handle: "errors" }]);

    const rebuilt = manifestToFlow(manifest);
    const edgeIntoC = rebuilt.edges.find((e) => e.target === "c");
    expect(edgeIntoC?.sourceHandle).toBe("errors");
  });
});

describe("loop node — owner-scoped subflow (inherits the subflow ownership fix)", () => {
  const subGraph = (id: string): FlowGraph => ({
    id,
    name: `Flow ${id}`,
    nodes: [{ id: "i", type: "input", params: {}, position: { x: 0, y: 0 } }],
    edges: [],
  });

  it("refuses to loop over a subflow owned by a different owner", async () => {
    const repo = await getRepo();
    const victim = `owner-loop-${Date.now()}-victim`;
    const attacker = `owner-loop-${Date.now()}-attacker`;
    const theirs = await repo.saveFlow({ ownerId: victim, name: "Theirs", graph: subGraph("loop-theirs") });

    const ctx = buildRunContext({ runId: "test-run", logger: new RunLogger(), ownerId: attacker });
    const res = await loopNode.executor(ctx, { flowId: theirs.id }, { in: [1, 2, 3] });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(`Subflow ${theirs.id} not found`);
  });

  it("loops over a subflow owned by the same owner", async () => {
    const repo = await getRepo();
    const owner = `owner-loop-${Date.now()}-mine`;
    const mine = await repo.saveFlow({ ownerId: owner, name: "Mine", graph: subGraph("loop-mine") });

    const ctx = buildRunContext({ runId: "test-run", logger: new RunLogger(), ownerId: owner, dryRun: true });
    const res = await loopNode.executor(ctx, { flowId: mine.id }, { in: [1, 2] });

    expect(res.ok).toBe(true);
  });
});
