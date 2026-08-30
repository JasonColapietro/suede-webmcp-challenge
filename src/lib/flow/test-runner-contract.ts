import { inspectTestInput } from "./test-input-safety";
import type { JsonValue, NodeType } from "./types";

export const TEST_RUN_CAPTURE_LIMITS = Object.freeze({
  valueBytes: 64 * 1024,
  valueDepth: 16,
  valueCount: 10_000,
  aggregateValueBytes: 256 * 1024,
  logCount: 128,
  logBytes: 2 * 1024,
  aggregateLogBytes: 64 * 1024,
} as const);

export type TestCapturedValue =
  | { readonly kind: "value"; readonly value: JsonValue }
  | { readonly kind: "omitted"; readonly reason: "limit" | "sensitive" | "unsupported" };

export interface TestCaptureBudget {
  readonly maxBytes: number;
  usedBytes: number;
}

export interface TestLogBudget {
  readonly maxBytes: number;
  readonly maxCount: number;
  usedBytes: number;
  count: number;
}

export interface TestRunMetrics {
  readonly latencyMs?: number;
  readonly tokens?: number;
}

export interface TestRunLog {
  readonly level: "info" | "error";
  readonly message: string;
}

interface TestRunEventBase {
  readonly sequence: number;
  readonly runId: string;
}

interface TestRunNodeEventBase extends TestRunEventBase {
  readonly nodeId: string;
  readonly nodeType: NodeType;
}

export type TestRunEvent =
  | (TestRunEventBase & { readonly kind: "test:start" })
  | (TestRunNodeEventBase & { readonly kind: "node:start" })
  | (TestRunNodeEventBase & TestRunMetrics & {
      readonly kind: "node:done";
      readonly outputs: TestCapturedValue;
      readonly costUsdc: 0;
    })
  | (TestRunNodeEventBase & TestRunMetrics & {
      readonly kind: "node:error";
      readonly code: "policy-refused" | "execution-failed" | "cost-invariant" | "cancelled";
      readonly message: string;
      readonly costUsdc: 0;
    })
  | (TestRunEventBase & TestRunMetrics & {
      readonly kind: "test:done";
      readonly status: "done" | "error" | "cancelled";
      readonly costUsdc: 0;
    });

export interface TestRunResult extends TestRunMetrics {
  readonly runId: string;
  readonly status: "done" | "error" | "cancelled";
  readonly costUsdc: 0;
  readonly outputs: Readonly<Record<string, TestCapturedValue>>;
  readonly events: readonly TestRunEvent[];
  readonly logs: readonly TestRunLog[];
}

const OMITTED_LIMIT = Object.freeze({ kind: "omitted", reason: "limit" } as const);
const OMITTED_SENSITIVE = Object.freeze({ kind: "omitted", reason: "sensitive" } as const);
const OMITTED_UNSUPPORTED = Object.freeze({ kind: "omitted", reason: "unsupported" } as const);
const TEXT_ENCODER = new TextEncoder();
const NATIVE_STRUCTURED_CLONE = globalThis.structuredClone.bind(globalThis);
const REDACTED_LOG = "[redacted]";

function validBudgetLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function omittedCapture(code: "invalid-json" | "limit-exceeded" | "credential-material"): TestCapturedValue {
  if (code === "credential-material") return OMITTED_SENSITIVE;
  if (code === "limit-exceeded") return OMITTED_LIMIT;
  return OMITTED_UNSUPPORTED;
}

export function createTestCaptureBudget(): TestCaptureBudget {
  const budget: TestCaptureBudget = {
    maxBytes: TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes,
    usedBytes: 0,
  };
  Object.defineProperty(budget, "maxBytes", { writable: false, configurable: false });
  return Object.preventExtensions(budget);
}

export function createTestLogBudget(): TestLogBudget {
  const budget: TestLogBudget = {
    maxBytes: TEST_RUN_CAPTURE_LIMITS.aggregateLogBytes,
    maxCount: TEST_RUN_CAPTURE_LIMITS.logCount,
    usedBytes: 0,
    count: 0,
  };
  Object.defineProperties(budget, {
    maxBytes: { writable: false, configurable: false },
    maxCount: { writable: false, configurable: false },
  });
  return Object.preventExtensions(budget);
}

export function captureTestValue(
  value: unknown,
  budget: TestCaptureBudget,
): TestCapturedValue {
  const inspected = inspectTestInput(value, {
    limits: {
      maxBytes: TEST_RUN_CAPTURE_LIMITS.valueBytes,
      maxDepth: TEST_RUN_CAPTURE_LIMITS.valueDepth,
      maxValues: TEST_RUN_CAPTURE_LIMITS.valueCount,
    },
  });
  if (!inspected.ok) return omittedCapture(inspected.code);
  let detached: JsonValue;
  try {
    detached = NATIVE_STRUCTURED_CLONE(value) as JsonValue;
  } catch {
    return OMITTED_UNSUPPORTED;
  }
  const detachedInspection = inspectTestInput(detached, {
    limits: {
      maxBytes: TEST_RUN_CAPTURE_LIMITS.valueBytes,
      maxDepth: TEST_RUN_CAPTURE_LIMITS.valueDepth,
      maxValues: TEST_RUN_CAPTURE_LIMITS.valueCount,
    },
  });
  if (!detachedInspection.ok) return omittedCapture(detachedInspection.code);
  if (
    !validBudgetLimit(budget.maxBytes) ||
    !validBudgetLimit(budget.usedBytes) ||
    budget.usedBytes > budget.maxBytes ||
    detachedInspection.encodedBytes > budget.maxBytes - budget.usedBytes
  ) {
    return OMITTED_LIMIT;
  }
  budget.usedBytes += detachedInspection.encodedBytes;
  return deepFreeze({ kind: "value", value: detached });
}

export function normalizeTestRunMetrics(value: {
  readonly latencyMs?: unknown;
  readonly tokens?: unknown;
}): Readonly<TestRunMetrics> {
  let latencyMs: unknown;
  let tokens: unknown;
  try {
    latencyMs = Reflect.get(value, "latencyMs");
    tokens = Reflect.get(value, "tokens");
  } catch {
    return Object.freeze({});
  }
  const normalized: { latencyMs?: number; tokens?: number } = {};
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    normalized.latencyMs = latencyMs;
  }
  if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) {
    normalized.tokens = tokens;
  }
  return Object.freeze(normalized);
}

function encodedStringBytes(value: string): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

export function captureTestLog(
  level: TestRunLog["level"],
  message: unknown,
  budget: TestLogBudget,
): Readonly<TestRunLog> | null {
  if (
    typeof message !== "string" ||
    !validBudgetLimit(budget.maxBytes) ||
    !validBudgetLimit(budget.maxCount) ||
    !validBudgetLimit(budget.usedBytes) ||
    !validBudgetLimit(budget.count) ||
    budget.usedBytes > budget.maxBytes ||
    budget.count >= budget.maxCount
  ) {
    return null;
  }
  const sensitive = inspectTestInput(message);
  const capturedMessage = !sensitive.ok && sensitive.code === "credential-material"
    ? REDACTED_LOG
    : message;
  const bounded = inspectTestInput(capturedMessage, {
    limits: { maxBytes: TEST_RUN_CAPTURE_LIMITS.logBytes, maxDepth: 0, maxValues: 1 },
  });
  if (!bounded.ok) return null;
  const encodedBytes = encodedStringBytes(capturedMessage);
  if (encodedBytes > budget.maxBytes - budget.usedBytes) return null;
  budget.usedBytes += encodedBytes;
  budget.count += 1;
  return Object.freeze({ level, message: capturedMessage });
}
