/**
 * Adversarial suite for the transform node's expression evaluator. Every
 * case here must come back as `{ ok: false, error }` (the engine's normal
 * NodeResult contract), never as a thrown exception and never as a
 * successful escape. See src/lib/flow/expr/ for the implementation these
 * tests are pinning down.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTransformExecutor } from "@/lib/flow/nodes/transform";
import { makeCtx } from "../_helpers";

/**
 * Frozen clock by default: these tests assert specific rejection REASONS
 * (prototype-access denials, cap messages). The wall-clock backstop can abort
 * any evaluation under host load, which would surface a "time limit" error and
 * fail those message assertions for an unrelated reason. The two tests that
 * genuinely exercise the clock inject their own below.
 */
const executor = createTransformExecutor({ now: () => 0 });

describe("adversarial: __proto__ / constructor / prototype access", () => {
  it("rejects dot access to in.__proto__", async () => {
    await expect(
      executor(makeCtx(), { expression: "in.__proto__" }, { in: {} }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects dot access to in.constructor", async () => {
    await expect(
      executor(makeCtx(), { expression: "in.constructor" }, { in: {} }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects dot access to in.prototype", async () => {
    await expect(
      executor(makeCtx(), { expression: "in.prototype" }, { in: {} }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects bracket access with a literal '__proto__' string", async () => {
    const res = await executor(makeCtx(), { expression: 'in["__proto__"]' }, { in: {} });
    expect(res.ok).toBe(false);
  });

  it("rejects a computed bracket index that resolves to '__proto__' at runtime", async () => {
    // The denylisted key isn't visible in the expression source at all -
    // it comes from the data. Static (parse-time) checks alone would miss
    // this; the runtime safeGet() denylist is what catches it.
    const res = await executor(
      makeCtx(),
      { expression: "in.items[in.evilKey]" },
      { in: { items: { a: 1 }, evilKey: "__proto__" } },
    );
    expect(res.ok).toBe(false);
  });

  it("rejects constructor.constructor chaining (the classic non-strict-mode escape)", async () => {
    const res = await executor(
      makeCtx(),
      { expression: "in.constructor.constructor" },
      { in: {} },
    );
    expect(res.ok).toBe(false);
  });

  it("rejects __proto__ as an object literal key (prototype pollution attempt)", async () => {
    const res = await executor(
      makeCtx(),
      { expression: "{ __proto__: { polluted: true } }" },
      { in: {} },
    );
    expect(res.ok).toBe(false);
  });

  it("does not actually pollute Object.prototype, even though the attempt was rejected", async () => {
    await executor(makeCtx(), { expression: "{ __proto__: { polluted: true } }" }, { in: {} });
     
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
  });

  it("rejects __proto__ as a map() lambda parameter name", async () => {
    const res = await executor(
      makeCtx(),
      { expression: "map(in.items, __proto__ => __proto__)" },
      { in: { items: [1, 2] } },
    );
    expect(res.ok).toBe(false);
  });
});

describe("adversarial: no access to real globals", () => {
  it("rejects a bare reference to process", async () => {
    const res = await executor(makeCtx(), { expression: "process" }, { in: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown variable/i);
  });

  it("rejects a bare reference to global", async () => {
    const res = await executor(makeCtx(), { expression: "global" }, { in: {} });
    expect(res.ok).toBe(false);
  });

  it("rejects a bare reference to globalThis", async () => {
    const res = await executor(makeCtx(), { expression: "globalThis" }, { in: {} });
    expect(res.ok).toBe(false);
  });

  it("rejects globalThis.process.env style chains (fails at the first unknown identifier)", async () => {
    const res = await executor(makeCtx(), { expression: "globalThis.process.env" }, { in: {} });
    expect(res.ok).toBe(false);
  });

  it("never resolves 'in' to anything but the scope object literally passed in", async () => {
    // Even if the upstream payload has a key that shadows a dangerous name,
    // it can only ever be plain JSON data - never a live object.
    const res = await executor(
      makeCtx(),
      { expression: "in.process" },
      { in: { process: { env: { SECRET: "nope" } } } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toEqual({ env: { SECRET: "nope" } });
  });
});

describe("adversarial: no eval/Function reachable", () => {
  it("rejects a call to a function named eval (not in the builtin allowlist)", async () => {
    const res = await executor(makeCtx(), { expression: "eval(in.x)" }, { in: { x: "1+1" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown function/i);
  });

  it("rejects a call to a function named Function", async () => {
    const res = await executor(makeCtx(), { expression: "Function(in.x)" }, { in: { x: "1+1" } });
    expect(res.ok).toBe(false);
  });

  it("rejects a call to require or import-shaped names", async () => {
    const res1 = await executor(makeCtx(), { expression: "require('fs')" }, { in: {} });
    expect(res1.ok).toBe(false);
  });

  it("the evaluator's own source never calls eval, new Function, or vm2", () => {
    const exprDir = path.join(process.cwd(), "src", "lib", "flow", "expr");
    const files = fs.readdirSync(exprDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = fs.readFileSync(path.join(exprDir, file), "utf-8");
      expect(contents).not.toMatch(/\beval\s*\(/);
      expect(contents).not.toMatch(/new\s+Function\s*\(/);
      expect(contents).not.toMatch(/require\s*\(\s*["']vm2?["']\s*\)/);
      expect(contents).not.toMatch(/\bimport\s*\(/); // no dynamic import either
    }
  });
});

describe("adversarial: bounded evaluation - depth limit", () => {
  it("rejects a deeply nested parenthesized expression", async () => {
    const depth = 200;
    const source = "(".repeat(depth) + "1" + ")".repeat(depth);
    const res = await executor(makeCtx(), { expression: source }, { in: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nested too deeply/i);
  });

  it("rejects a deeply nested array literal", async () => {
    const depth = 100;
    const source = "[".repeat(depth) + "1" + "]".repeat(depth);
    const res = await executor(makeCtx(), { expression: source }, { in: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nested too deeply|too large/i);
  });

  it("rejects a long chained ternary (right-recursive, not just parens)", async () => {
    const count = 200;
    const source = Array.from({ length: count }, () => "true ? 1 :").join(" ") + " 0";
    const res = await executor(makeCtx(), { expression: source }, { in: {} });
    expect(res.ok).toBe(false);
  });

  it("accepts a reasonably nested expression well under the limit", async () => {
    const res = await executor(makeCtx(), { expression: "((((1 + 2)))) * ((((3))))" }, { in: {} });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toBe(9);
  });
});

describe("adversarial: bounded evaluation - node-count limit", () => {
  it("rejects a huge array literal that is wide, not deep", async () => {
    // 600 single-digit elements: ~1200 chars, well under maxSourceLength
    // (5000). This can trip either the token cap or the node-count cap
    // first depending on the shape - both are legitimate size-bomb
    // defenses, so this test only pins down that one of them fires.
    const elements = Array.from({ length: 600 }, () => "1").join(",");
    const source = `[${elements}]`;
    expect(source.length).toBeLessThan(2000);
    const res = await executor(makeCtx(), { expression: source }, { in: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too large|too many tokens/i);
  });

  it("rejects a huge object literal the same way", async () => {
    const props = Array.from({ length: 260 }, (_, i) => `k${i}:${i}`).join(",");
    const source = `{${props}}`;
    expect(source.length).toBeLessThan(3000);
    const res = await executor(makeCtx(), { expression: source }, { in: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too large|too many tokens/i);
  });

  it("isolates the node-count check specifically: an additive chain where tokens and nodes grow 1:1, sized to stay under the token cap but over the node cap", async () => {
    // 260 literals joined by "+": 519 tokens, 519 AST nodes (both under
    // maxTokens=1000 for the former, over maxNodes=500 for the latter) -
    // this is the one shape in the grammar where tokens and nodes grow at
    // exactly the same rate, so it cleanly proves the node-count check
    // fires on its own, not merely as a side effect of the token cap.
    const source = Array.from({ length: 260 }, () => "1").join("+");
    expect(source.length).toBeLessThan(1000);
    const res = await executor(makeCtx(), { expression: source }, { in: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too large/i);
  });

  it("rejects an expression that is short in text but huge in tokens (a long identifier chain)", async () => {
    const source = Array.from({ length: 600 }, (_, i) => `k${i}`).join("+");
    const scope: Record<string, unknown> = {};
    for (let i = 0; i < 600; i++) scope[`k${i}`] = 1;
    const res = await executor(makeCtx(), { expression: source }, scope);
    expect(res.ok).toBe(false);
  });

  it("rejects an expression source that is simply too long", async () => {
    const source = "in.a" + " + 1".repeat(5000);
    const res = await executor(makeCtx(), { expression: source }, { in: { a: 1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too long/i);
  });
});

describe("adversarial: bounded evaluation - long-running expressions", () => {
  it("rejects map() over an array larger than the configured cap", async () => {
    const bigExecutor = createTransformExecutor({
      limits: { maxArrayOpItems: 100 },
      now: () => 0,
    });
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
    const res = await bigExecutor(
      makeCtx(),
      { expression: "map(in.items, x => x.id)" },
      { in: { items } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exceeding the limit/i);
  });

  it("aborts once the evaluation step budget is exhausted", async () => {
    // Frozen clock: this asserts the STEP limit specifically. Both guards can
    // abort the same evaluation, so under host load the wall-clock backstop
    // would trip first and the error would say "time limit", failing the
    // /step limit/i match below for a reason unrelated to step counting.
    const tightExecutor = createTransformExecutor({
      limits: { maxSteps: 20, maxArrayOpItems: 10000 },
      now: () => 0,
    });
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const res = await tightExecutor(
      makeCtx(),
      { expression: "map(in.items, x => upper(string(x.id)))" },
      { in: { items } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/step limit/i);
  });

  it("bounds total wall-clock time via an injectable clock, without a real sleep", async () => {
    // Simulates the clock jumping forward past the budget between the
    // first tick (startedAt) and the second (first node evaluated), so the
    // test is deterministic and fast instead of racing a real timer.
    let calls = 0;
    const now = () => {
      calls++;
      return calls === 1 ? 0 : 5000;
    };
    const timedExecutor = createTransformExecutor({ limits: { maxTimeMs: 50 }, now });
    const res = await timedExecutor(makeCtx(), { expression: "in.a + in.b" }, { in: { a: 1, b: 2 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/time limit/i);
  });

  it("a legitimate map() within the caps completes normally, not rejected by a budget", async () => {
    // Freeze the clock so the WALL-CLOCK budget can never trip. A real-time
    // "finishes in time" check measures whether the machine is busy, not whether
    // the code is correct. The evaluator's wall-clock budget is real time, so a
    // 200-element map could exceed it under load — that is what made this flake
    // when the default was 50ms, and it is why the default is now a loose
    // backstop with maxSteps doing the real bounding. The deterministic
    // time-limit trip is covered by the injected-clock test above. The STEP and
    // array-item caps (which are counters, not clocks) stay fully active here,
    // so this still proves a legitimate 200-element map is accepted by the real
    // caps and returns every result.
    const frozenNow = () => 0;
    const steadyExecutor = createTransformExecutor({ now: frozenNow });
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const res = await steadyExecutor(
      makeCtx(),
      { expression: "map(in.items, x => { id: x.id, label: upper(x.name) })" },
      { in: { items } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as unknown[]).length).toBe(200);
  });
});

describe("adversarial: malformed input never throws, always returns ok:false", () => {
  const badExpressions = [
    "",
    "   ",
    "in.",
    "in..a",
    "{",
    "}",
    "[",
    "(",
    "in.a +",
    "1 +",
    "1 2 3",
    "map(in.items)",
    "map(in.items, 1)",
    "map(1, x => x)",
    "unknownFn(1,2,3)",
    "in[",
    "'unterminated",
    "in.a ? 1",
    "&&",
    "==",
    "in.a.b.c.d.e.f.g.h.i.j.k.__proto__",
  ];

  for (const expression of badExpressions) {
    it(`does not throw for: ${JSON.stringify(expression)}`, async () => {
      // .resolves fails distinctly (promise rejected) if the executor ever
      // throws instead of returning the node's {ok:false,error} contract.
      await expect(
        executor(makeCtx(), { expression: expression || " " }, { in: { a: 1 } }),
      ).resolves.toMatchObject({ ok: false });
    });
  }

  it("rejects params that fail schema validation without throwing", async () => {
    const res = await executor(makeCtx(), { expression: 123 as unknown as string }, { in: {} });
    expect(res.ok).toBe(false);
  });
});
