import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_RUN_CAPTURE_LIMITS,
  captureTestLog,
  captureTestValue,
  createTestCaptureBudget,
  createTestLogBudget,
  normalizeTestRunMetrics,
  type TestRunEvent,
  type TestRunResult,
} from "@/lib/flow/test-runner-contract";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("test runner result contract", () => {
  it("publishes fixed output and log ceilings", () => {
    expect(TEST_RUN_CAPTURE_LIMITS).toEqual({
      valueBytes: 64 * 1024,
      valueDepth: 16,
      valueCount: 10_000,
      aggregateValueBytes: 256 * 1024,
      logCount: 128,
      logBytes: 2 * 1024,
      aggregateLogBytes: 64 * 1024,
    });
    expect(Object.isFrozen(TEST_RUN_CAPTURE_LIMITS)).toBe(true);
  });

  it("captures detached deeply frozen JSON values and charges their exact bytes", () => {
    const source = { nested: [{ value: "safe" }] };
    const budget = createTestCaptureBudget();
    const captured = captureTestValue(source, budget);

    expect(captured).toEqual({ kind: "value", value: source });
    expect(budget.usedBytes).toBe(new TextEncoder().encode(JSON.stringify(source)).byteLength);
    expect(captured).not.toBe(source);
    expect(Object.isFrozen(captured)).toBe(true);
    if (captured.kind === "value") {
      expect(captured.value).not.toBe(source);
      expect(Object.isFrozen(captured.value)).toBe(true);
      expect(Object.isFrozen((captured.value as { nested: unknown[] }).nested)).toBe(true);
    }
    source.nested[0]!.value = "changed";
    expect(captured).toEqual({ kind: "value", value: { nested: [{ value: "safe" }] } });
  });

  it("classifies credential, invalid, and over-limit values without consuming budget", () => {
    const budget = createTestCaptureBudget();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(captureTestValue({ apiKey: "placeholder" }, budget)).toEqual({
      kind: "omitted", reason: "sensitive",
    });
    expect(captureTestValue(cyclic, budget)).toEqual({
      kind: "omitted", reason: "unsupported",
    });
    expect(captureTestValue("x".repeat(TEST_RUN_CAPTURE_LIMITS.valueBytes), budget)).toEqual({
      kind: "omitted", reason: "limit",
    });
    expect(budget.usedBytes).toBe(0);
  });

  it("omits an entire value when the aggregate budget is exhausted", () => {
    const budget = createTestCaptureBudget();
    budget.usedBytes = TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes - 6;
    expect(captureTestValue("1234", budget)).toEqual({ kind: "value", value: "1234" });
    expect(budget.usedBytes).toBe(TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes);
    expect(captureTestValue("56789", budget)).toEqual({ kind: "omitted", reason: "limit" });
    expect(budget.usedBytes).toBe(TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes);
  });

  it("makes the aggregate value ceiling non-writable and non-configurable at runtime", () => {
    const budget = createTestCaptureBudget();
    expect(() => ((budget as { maxBytes: number }).maxBytes = Number.MAX_SAFE_INTEGER)).toThrow();
    expect(Reflect.set(budget, "maxBytes", Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(() => Object.defineProperty(budget, "maxBytes", { value: Number.MAX_SAFE_INTEGER })).toThrow();
    expect(Object.getOwnPropertyDescriptor(budget, "maxBytes")).toMatchObject({
      value: TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes,
      writable: false,
      configurable: false,
    });

    const chunk = "x ".repeat(30 * 1024);
    const accepted = Array.from({ length: 5 }, () => captureTestValue(chunk, budget));
    expect(accepted.slice(0, 4).every(({ kind }) => kind === "value")).toBe(true);
    expect(accepted[4]).toEqual({ kind: "omitted", reason: "limit" });
    expect(budget.usedBytes).toBeLessThanOrEqual(TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes);
  });

  it("fails unsupported if a stateful proxy changes between inspection and detachment", () => {
    const target = { value: "safe" };
    const stateful = new Proxy(target, {
      getOwnPropertyDescriptor(current, property) {
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });
    const budget = createTestCaptureBudget();
    expect(captureTestValue(stateful, budget)).toEqual({ kind: "omitted", reason: "unsupported" });
    expect(budget.usedBytes).toBe(0);
  });

  it("uses the module-captured clone primitive and never trusts a late global replacement", () => {
    vi.stubGlobal("structuredClone", vi.fn(() => ({ apiKey: "injected-credential" })));
    const budget = createTestCaptureBudget();
    expect(captureTestValue({ value: "safe" }, budget)).toEqual({
      kind: "value", value: { value: "safe" },
    });
  });

  it("re-inspects detached clone output before charging or returning it", async () => {
    vi.resetModules();
    vi.stubGlobal("structuredClone", vi.fn(() => ({ apiKey: "injected-credential" })));
    const isolated = await import("@/lib/flow/test-runner-contract");
    const budget = isolated.createTestCaptureBudget();
    expect(isolated.captureTestValue({ value: "safe" }, budget)).toEqual({
      kind: "omitted", reason: "sensitive",
    });
    expect(budget.usedBytes).toBe(0);
  });

  it("normalizes only finite nonnegative latency and nonnegative safe-integer tokens", () => {
    expect(normalizeTestRunMetrics({ latencyMs: 12.5, tokens: 42 })).toEqual({
      latencyMs: 12.5, tokens: 42,
    });
    expect(normalizeTestRunMetrics({ latencyMs: -1, tokens: -1 })).toEqual({});
    expect(normalizeTestRunMetrics({ latencyMs: Number.POSITIVE_INFINITY, tokens: 1.5 })).toEqual({});
    expect(normalizeTestRunMetrics({ latencyMs: "12", tokens: "42" })).toEqual({});
    expect(Object.isFrozen(normalizeTestRunMetrics({ latencyMs: 1 }))).toBe(true);
  });

  it("snapshots metric properties once and generically omits throwing proxies", () => {
    const reads = { latencyMs: 0, tokens: 0 };
    const swapping = new Proxy({}, {
      get(_target, property) {
        if (property === "latencyMs") return ++reads.latencyMs === 1 ? 12.5 : Number.POSITIVE_INFINITY;
        if (property === "tokens") return ++reads.tokens === 1 ? 42 : -1;
        return undefined;
      },
    });
    expect(normalizeTestRunMetrics(swapping)).toEqual({ latencyMs: 12.5, tokens: 42 });
    expect(reads).toEqual({ latencyMs: 1, tokens: 1 });

    const throwing = new Proxy({}, {
      get() {
        throw new Error("must-not-echo");
      },
    });
    expect(() => normalizeTestRunMetrics(throwing)).not.toThrow();
    expect(normalizeTestRunMetrics(throwing)).toEqual({});
  });

  it("captures bounded logs, redacts sensitive text, and never partially slices", () => {
    const budget = createTestLogBudget();
    expect(captureTestLog("info", "ready", budget)).toEqual({ level: "info", message: "ready" });
    expect(captureTestLog("error", "Bearer abcdefghijklmnop", budget)).toEqual({
      level: "error", message: "[redacted]",
    });
    expect(captureTestLog("info", "x".repeat(TEST_RUN_CAPTURE_LIMITS.logBytes), budget)).toBeNull();
    expect(budget.count).toBe(2);
    expect(Object.isFrozen(captureTestLog("info", "still safe", budget))).toBe(true);
  });

  it("enforces both log count and aggregate byte ceilings", () => {
    const countBudget = createTestLogBudget();
    for (let index = 0; index < TEST_RUN_CAPTURE_LIMITS.logCount; index += 1) {
      expect(captureTestLog("info", "x", countBudget)).not.toBeNull();
    }
    expect(captureTestLog("info", "overflow", countBudget)).toBeNull();
    expect(countBudget.count).toBe(TEST_RUN_CAPTURE_LIMITS.logCount);

    const byteBudget = createTestLogBudget();
    byteBudget.usedBytes = TEST_RUN_CAPTURE_LIMITS.aggregateLogBytes - 6;
    expect(captureTestLog("info", "1234", byteBudget)).not.toBeNull();
    expect(captureTestLog("info", "567", byteBudget)).toBeNull();
    expect(byteBudget.usedBytes).toBe(TEST_RUN_CAPTURE_LIMITS.aggregateLogBytes);
    expect(byteBudget.count).toBe(1);
  });

  it("makes fixed log ceilings non-writable and non-configurable at runtime", () => {
    const budget = createTestLogBudget();
    for (const key of ["maxBytes", "maxCount"] as const) {
      expect(() => ((budget as { maxBytes: number; maxCount: number })[key] = Number.MAX_SAFE_INTEGER)).toThrow();
      expect(Reflect.set(budget, key, Number.MAX_SAFE_INTEGER)).toBe(false);
      expect(() => Object.defineProperty(budget, key, { value: Number.MAX_SAFE_INTEGER })).toThrow();
      expect(Object.getOwnPropertyDescriptor(budget, key)).toMatchObject({
        writable: false,
        configurable: false,
      });
    }

    const message = "x ".repeat(511);
    for (let index = 0; index < 64; index += 1) {
      expect(captureTestLog("info", message, budget)).not.toBeNull();
    }
    expect(captureTestLog("info", message, budget)).toBeNull();
    expect(budget.usedBytes).toBe(TEST_RUN_CAPTURE_LIMITS.aggregateLogBytes);
    expect(budget.count).toBe(64);
  });

  it("defines a zero-cost event stream and final result with optional metrics", () => {
    const events = [
      { kind: "test:start", sequence: 0, runId: "test-1" },
      { kind: "node:start", sequence: 1, runId: "test-1", nodeId: "n1", nodeType: "transform" },
      {
        kind: "node:done", sequence: 2, runId: "test-1", nodeId: "n1", nodeType: "transform",
        outputs: { kind: "value", value: { result: true } }, costUsdc: 0, latencyMs: 2, tokens: 3,
      },
      { kind: "test:done", sequence: 3, runId: "test-1", status: "done", costUsdc: 0 },
    ] satisfies TestRunEvent[];
    const result = {
      runId: "test-1",
      status: "done",
      costUsdc: 0,
      outputs: { n1: { kind: "value", value: { result: true } } },
      events,
      logs: [],
      latencyMs: 2,
      tokens: 3,
    } satisfies TestRunResult;

    expect(result.costUsdc).toBe(0);
    expect(result.events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
  });

  it("stays client-safe and imports only the input inspector and flow types", () => {
    const source = readFileSync("src/lib/flow/test-runner-contract.ts", "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    expect(imports.every((specifier) => ["./test-input-safety", "./types"].includes(specifier!))).toBe(true);
    expect(source).not.toMatch(/\b(?:fetch|process\.env|runFlow|executeNode|getRepo|createRun|appendStep|finishRun)\b/);
  });
});
