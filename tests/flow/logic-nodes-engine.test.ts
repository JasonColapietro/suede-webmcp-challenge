/**
 * Engine-level cover for the Logic additions. The unit tests prove each
 * executor's arithmetic; these prove the parts only the engine can:
 *   - switch emits one handle, so the untaken edges really go inactive and
 *     their downstream nodes never run, which no unit test can show;
 *   - aggregate reduces real upstream output rather than a hand-built array.
 *
 * These run against a v1 graph, the shape the studio actually saves.
 */
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { runFlow, collectRun } from "@/lib/flow/engine";
import type { NodeDef } from "@/lib/flow/executor";
import { makeCtx, node, graph, registry } from "../_helpers";
import { outputNode } from "@/lib/flow/nodes/output";
import { switchNode } from "@/lib/flow/nodes/logic/switch";
import { aggregateNode } from "@/lib/flow/nodes/logic/aggregate";

/** The shared helper omits targetHandle; real graphs always carry one. */
function edge(source: string, target: string, sourceHandle: string, targetHandle = "in") {
  return { id: `${source}->${target}:${sourceHandle}`, source, target, sourceHandle, targetHandle };
}

/** Stands in for the trigger so a bare array reaches the node under test. */
function emitter(value: unknown): NodeDef {
  return {
    type: "input",
    label: "input",
    group: "I/O",
    priceUsdc: 0,
    paramsSchema: z.any(),
    inputs: [],
    outputs: ["result"],
    executor: async () => ({ ok: true, outputs: { result: value }, costUsdc: 0 }),
  };
}

function withParams(n: ReturnType<typeof node>, params: Record<string, unknown>) {
  return { ...n, params };
}

function reg(value: unknown) {
  return registry([emitter(value), outputNode, switchNode, aggregateNode]);
}

describe("logic.switch in the engine", () => {
  it("runs only the matched branch and leaves the others inactive", async () => {
    const g = graph(
      [
        node("start", "input"),
        withParams(node("sw", "logic.switch"), { field: "tier", cases: { gold: "a", silver: "b" } }),
        node("goldOut", "output"),
        node("silverOut", "output"),
        node("elseOut", "output"),
      ],
      [
        edge("start", "sw", "result"),
        edge("sw", "goldOut", "a"),
        edge("sw", "silverOut", "b"),
        edge("sw", "elseOut", "fallback"),
      ],
    );

    const result = await collectRun(runFlow(g, makeCtx(), reg({ tier: "gold" })));
    const ran = new Set(Object.keys(result.outputs));

    expect(ran.has("sw")).toBe(true);
    expect(ran.has("goldOut")).toBe(true);
    // The whole point: the untaken handles must not execute downstream work.
    expect(ran.has("silverOut")).toBe(false);
    expect(ran.has("elseOut")).toBe(false);
  });

  it("takes the fallback path when nothing matches", async () => {
    const g = graph(
      [
        node("start", "input"),
        withParams(node("sw", "logic.switch"), { field: "tier", cases: { gold: "a" } }),
        node("goldOut", "output"),
        node("elseOut", "output"),
      ],
      [edge("start", "sw", "result"), edge("sw", "goldOut", "a"), edge("sw", "elseOut", "fallback")],
    );

    const result = await collectRun(runFlow(g, makeCtx(), reg({ tier: "bronze" })));
    const ran = new Set(Object.keys(result.outputs));

    expect(ran.has("elseOut")).toBe(true);
    expect(ran.has("goldOut")).toBe(false);
  });
});

describe("logic.aggregate in the engine", () => {
  it("totals a field across rows handed down from the trigger", async () => {
    const g = graph(
      [
        node("start", "input"),
        withParams(node("total", "logic.aggregate"), { op: "sum", field: "amount" }),
        node("end", "output"),
      ],
      [edge("start", "total", "result"), edge("total", "end", "result")],
    );

    const result = await collectRun(
      runFlow(g, makeCtx(), reg([{ amount: 10 }, { amount: 5.5 }, { amount: "not a number" }])),
    );
    expect(result.outputs.total?.result).toEqual({ op: "sum", value: 15.5, count: 2 });
    expect(result.totalCostUsdc).toBe(0);
  });
});
