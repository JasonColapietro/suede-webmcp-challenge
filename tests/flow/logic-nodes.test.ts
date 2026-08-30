/**
 * Behaviour cover for the pure Logic nodes: switch (n-way routing) and
 * aggregate (list reduction).
 */
import { describe, expect, it } from "vitest";
import { switchNode } from "@/lib/flow/nodes/logic/switch";
import { aggregateNode } from "@/lib/flow/nodes/logic/aggregate";
import type { NodeContext, NodeResult } from "@/lib/flow/executor";

const ctx = {} as NodeContext;

async function run(
  node: typeof switchNode | typeof aggregateNode,
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<Extract<NodeResult, { ok: true }>> {
  const result = await node.executor(ctx, params, inputs);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("logic.switch", () => {
  it("emits only the matched handle so every other edge stays inactive", async () => {
    const result = await run(
      switchNode,
      { field: "status", cases: { urgent: "a", normal: "b" } },
      { in: { status: "urgent", id: 7 } },
    );
    expect(result.ok).toBe(true);
    // Exactly one handle: the engine treats absent handles as inactive edges.
    expect(Object.keys(result.outputs ?? {})).toEqual(["a"]);
    expect(result.outputs?.a).toEqual({ status: "urgent", id: 7 });
    expect(result.costUsdc).toBe(0);
  });

  it("routes an unmatched value to fallback rather than dropping it", async () => {
    const result = await run(
      switchNode,
      { field: "status", cases: { urgent: "a" } },
      { in: { status: "whatever" } },
    );
    expect(Object.keys(result.outputs ?? {})).toEqual(["fallback"]);
  });

  it("matches numeric and boolean fields by their string form", async () => {
    const num = await run(switchNode, { field: "code", cases: { "404": "c" } }, { in: { code: 404 } });
    expect(Object.keys(num.outputs ?? {})).toEqual(["c"]);
    const bool = await run(switchNode, { field: "ok", cases: { true: "d" } }, { in: { ok: true } });
    expect(Object.keys(bool.outputs ?? {})).toEqual(["d"]);
  });

  it("reads the whole value when it is not an object", async () => {
    const result = await run(switchNode, { field: "status", cases: { hello: "b" } }, { in: "hello" });
    expect(Object.keys(result.outputs ?? {})).toEqual(["b"]);
  });

  it("sends an unmatchable value (an array) to fallback", async () => {
    const result = await run(switchNode, { field: "x", cases: { a: "a" } }, { in: [1, 2] });
    expect(Object.keys(result.outputs ?? {})).toEqual(["fallback"]);
  });
});

describe("logic.aggregate", () => {
  it("counts every item regardless of shape", async () => {
    const result = await run(aggregateNode, { op: "count" }, { in: [1, "x", null, {}] });
    expect(result.outputs?.result).toEqual({ op: "count", value: 4, count: 4 });
  });

  it("sums a field across object rows", async () => {
    const result = await run(
      aggregateNode,
      { op: "sum", field: "amount" },
      { in: [{ amount: 10 }, { amount: 5.5 }] },
    );
    expect(result.outputs?.result).toEqual({ op: "sum", value: 15.5, count: 2 });
  });

  it("skips rows whose value is not numeric rather than returning NaN", async () => {
    const result = await run(
      aggregateNode,
      { op: "sum", field: "amount" },
      { in: [{ amount: 10 }, { amount: "oops" }, { other: 1 }, { amount: null }] },
    );
    expect(result.outputs?.result).toEqual({ op: "sum", value: 10, count: 1 });
  });

  it("accepts clean numeric strings, which is how CSV rows arrive", async () => {
    const result = await run(aggregateNode, { op: "sum", field: "amount" }, { in: [{ amount: "3" }, { amount: "4" }] });
    expect(result.outputs?.result).toEqual({ op: "sum", value: 7, count: 2 });
  });

  it("averages, mins and maxes over bare numbers", async () => {
    expect((await run(aggregateNode, { op: "avg" }, { in: [1, 2, 3, 4] })).outputs?.result)
      .toEqual({ op: "avg", value: 2.5, count: 4 });
    expect((await run(aggregateNode, { op: "min" }, { in: [5, -2, 9] })).outputs?.result)
      .toEqual({ op: "min", value: -2, count: 3 });
    expect((await run(aggregateNode, { op: "max" }, { in: [5, -2, 9] })).outputs?.result)
      .toEqual({ op: "max", value: 9, count: 3 });
  });

  it("reports null rather than a fake zero when nothing is summable", async () => {
    const result = await run(aggregateNode, { op: "sum", field: "amount" }, { in: [] });
    expect(result.outputs?.result).toEqual({ op: "sum", value: null, count: 0 });
  });

  it("is free and never reports a cost", async () => {
    for (const node of [switchNode, aggregateNode]) {
      expect((await run(node, {}, { in: [1] })).costUsdc).toBe(0);
    }
  });
});
