import { describe, it, expect } from "vitest";
import { createTransformExecutor, transformNode, transformParamsSchema } from "@/lib/flow/nodes/transform";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { NODE_META, getNodeMeta } from "@/lib/flow/node-meta";
import { FREE_NODE_TYPES, isCostBearingNode } from "@/lib/flow/executor";
import { makeCtx } from "../_helpers";

/**
 * Every test below exercises expression SEMANTICS, not the wall-clock budget,
 * so real time must never decide the outcome. The evaluator checks maxTimeMs
 * on every step against the injected clock, so a frozen clock makes these
 * immune to host load; without it a descheduled process fails a trivial
 * `number(in.s)` with a time-limit error. The budget itself is covered
 * deterministically in transform-expr-adversarial.test.ts.
 */
const createExecutor = (): ReturnType<typeof createTransformExecutor> =>
  createTransformExecutor({ now: () => 0 });

describe("transform node registration", () => {
  it("is registered in the server executor list and client-safe meta", () => {
    expect(NODE_DEFS.some((d) => d.type === "transform")).toBe(true);
    expect(NODE_META.some((m) => m.type === "transform")).toBe(true);
    expect(getNodeMeta("transform")?.priceUsdc).toBeUndefined();
    expect(getNodeMeta("transform")?.group).toBe("Logic");
  });

  it("has a label and hint on every field", () => {
    const meta = getNodeMeta("transform");
    expect(meta).toBeDefined();
    for (const field of meta?.fields ?? []) {
      expect(field.label).toBeTruthy();
      expect(field.hint).toBeTruthy();
    }
  });

  it("is classified as free and non-cost-bearing", () => {
    expect(FREE_NODE_TYPES).toContain("transform");
    expect(isCostBearingNode({ type: "transform" })).toBe(false);
  });
});

describe("transformParamsSchema", () => {
  it("requires a non-empty expression", () => {
    expect(() => transformParamsSchema.parse({})).toThrow();
    expect(() => transformParamsSchema.parse({ expression: "" })).toThrow();
    expect(transformParamsSchema.parse({ expression: "in" }).expression).toBe("in");
  });
});

describe("transform node executor - happy path reshaping", () => {
  it("plucks a field out of an upstream object", async () => {
    const res = await transformNode.executor(
      makeCtx(),
      { expression: "in.user.email" },
      { in: { user: { email: "a@b.com" } } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe("a@b.com");
  });

  it("indexes into a nested array", async () => {
    const res = await transformNode.executor(
      makeCtx(),
      { expression: "in.items[0].id" },
      { in: { items: [{ id: "x1" }, { id: "x2" }] } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe("x1");
  });

  it("builds a reshaped object literal from multiple upstream fields", async () => {
    const res = await transformNode.executor(
      makeCtx(),
      {
        expression: '{ email: in.user.email, itemCount: len(in.items), firstId: in.items[0].id }',
      },
      { in: { user: { email: "a@b.com" }, items: [{ id: "x1" }, { id: "x2" }] } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({ email: "a@b.com", itemCount: 2, firstId: "x1" });
    }
  });

  it("supports arithmetic, comparison, boolean logic, and ternary", async () => {
    const res = await transformNode.executor(
      makeCtx(),
      { expression: "(in.a + in.b) > 10 && in.ok ? 'big' : 'small'" },
      { in: { a: 6, b: 5, ok: true } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe("big");
  });

  it("builds an array literal from a mix of literals and paths", async () => {
    const res = await transformNode.executor(
      makeCtx(),
      { expression: "[in.a, in.b, 1, 2, in.a + in.b]" },
      { in: { a: 1, b: 2 } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toEqual([1, 2, 1, 2, 3]);
  });

  it("returns { ok: false } (not a throw) for a syntax error", async () => {
    const res = await transformNode.executor(makeCtx(), { expression: "in.user." }, { in: {} });
    expect(res.ok).toBe(false);
  });

  it("returns { ok: false } for an unknown variable name", async () => {
    const res = await transformNode.executor(makeCtx(), { expression: "notARealVar" }, { in: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown variable/i);
  });

  it("runs during dry-run since it is a free, local-only node", async () => {
    const res = await transformNode.executor(
      makeCtx({ dryRun: true }),
      { expression: "in.a" },
      { in: { a: 42 } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toBe(42);
      expect(res.costUsdc).toBe(0);
    }
  });
});

describe("transform node executor - each allowlisted helper", () => {
  it("len() over string, array, and object", async () => {
    const executor = createExecutor();
    expect((await executor(makeCtx(), { expression: "len(in.s)" }, { in: { s: "hello" } })))
      .toMatchObject({ ok: true, outputs: { result: 5 } });
    expect((await executor(makeCtx(), { expression: "len(in.arr)" }, { in: { arr: [1, 2, 3] } })))
      .toMatchObject({ ok: true, outputs: { result: 3 } });
    expect((await executor(makeCtx(), { expression: "len(in.obj)" }, { in: { obj: { a: 1, b: 2 } } })))
      .toMatchObject({ ok: true, outputs: { result: 2 } });
  });

  it("upper() / lower() / trim()", async () => {
    const executor = createExecutor();
    expect(await executor(makeCtx(), { expression: "upper(in.s)" }, { in: { s: "abc" } })).toMatchObject({
      ok: true,
      outputs: { result: "ABC" },
    });
    expect(await executor(makeCtx(), { expression: "lower(in.s)" }, { in: { s: "ABC" } })).toMatchObject({
      ok: true,
      outputs: { result: "abc" },
    });
    expect(await executor(makeCtx(), { expression: "trim(in.s)" }, { in: { s: "  hi  " } })).toMatchObject({
      ok: true,
      outputs: { result: "hi" },
    });
  });

  it("join() with a default and a custom separator", async () => {
    const executor = createExecutor();
    expect(await executor(makeCtx(), { expression: "join(in.arr)" }, { in: { arr: ["a", "b", "c"] } })).toMatchObject({
      ok: true,
      outputs: { result: "a,b,c" },
    });
    expect(
      await executor(makeCtx(), { expression: "join(in.arr, ' | ')" }, { in: { arr: ["a", "b"] } }),
    ).toMatchObject({ ok: true, outputs: { result: "a | b" } });
  });

  it("split()", async () => {
    const executor = createExecutor();
    const res = await executor(makeCtx(), { expression: "split(in.s, ',')" }, { in: { s: "a,b,c" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toEqual(["a", "b", "c"]);
  });

  it("map() over a simple sub-expression", async () => {
    const executor = createExecutor();
    const res = await executor(
      makeCtx(),
      { expression: "map(in.items, x => x.id)" },
      { in: { items: [{ id: "a" }, { id: "b" }, { id: "c" }] } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toEqual(["a", "b", "c"]);
  });

  it("map() with an object-literal body reshapes each element", async () => {
    const executor = createExecutor();
    const res = await executor(
      makeCtx(),
      { expression: "map(in.items, x => { id: x.id, label: upper(x.name) })" },
      { in: { items: [{ id: "a", name: "one" }, { id: "b", name: "two" }] } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual([
        { id: "a", label: "ONE" },
        { id: "b", label: "TWO" },
      ]);
    }
  });

  it("get() with a default when the path is missing", async () => {
    const executor = createExecutor();
    const res = await executor(
      makeCtx(),
      { expression: "get(in, 'user.nickname', 'anon')" },
      { in: { user: { email: "a@b.com" } } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe("anon");
  });

  it("get() returns the value when the path exists", async () => {
    const executor = createExecutor();
    const res = await executor(
      makeCtx(),
      { expression: "get(in, 'items.1.id')" },
      { in: { items: [{ id: "x" }, { id: "y" }] } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe("y");
  });

  it("jsonParse() and jsonStringify() round trip", async () => {
    const executor = createExecutor();
    const res = await executor(
      makeCtx(),
      { expression: "jsonStringify(jsonParse(in.raw))" },
      { in: { raw: '{"a":1,"b":[1,2,3]}' } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe('{"a":1,"b":[1,2,3]}');
  });

  it("jsonParse() rejects invalid JSON with ok:false", async () => {
    const executor = createExecutor();
    const res = await executor(makeCtx(), { expression: "jsonParse(in.raw)" }, { in: { raw: "not json{" } });
    expect(res.ok).toBe(false);
  });

  it("number() coerces strings and booleans", async () => {
    const executor = createExecutor();
    expect(await executor(makeCtx(), { expression: "number(in.s)" }, { in: { s: "42" } })).toMatchObject({
      ok: true,
      outputs: { result: 42 },
    });
    expect(await executor(makeCtx(), { expression: "number(in.b)" }, { in: { b: true } })).toMatchObject({
      ok: true,
      outputs: { result: 1 },
    });
  });

  it("string() renders every type without throwing", async () => {
    const executor = createExecutor();
    const res = await executor(
      makeCtx(),
      { expression: "string(in.obj)" },
      { in: { obj: { a: 1 } } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe('{"a":1}');
  });

  it("default() falls back on null or undefined only", async () => {
    const executor = createExecutor();
    expect(
      await executor(makeCtx(), { expression: "default(in.missing, 'fallback')" }, { in: {} }),
    ).toMatchObject({ ok: true, outputs: { result: "fallback" } });
    expect(
      await executor(makeCtx(), { expression: "default(in.zero, 'fallback')" }, { in: { zero: 0 } }),
    ).toMatchObject({ ok: true, outputs: { result: 0 } });
  });
});
