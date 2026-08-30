import * as engine from "./engine";
import { getRegistry } from "./registry";
import {
  preflightPlannedTestNodes,
} from "./test-node-policy";
import {
  captureTestLog,
  captureTestValue,
  createTestCaptureBudget,
  createTestLogBudget,
  normalizeTestRunMetrics,
  type TestCapturedValue,
  type TestRunEvent,
  type TestRunLog,
  type TestRunResult,
} from "./test-runner-contract";
import {
  validateAndCompileTestRunRequest,
  type CompiledTestRunRequest,
} from "./test-run-contract";
import type { NodeType, RunEvent } from "./types";

export interface EphemeralScopedTestOptions {
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly runId?: string;
}

type CompiledTestFlowHook = (
  compiled: CompiledTestRunRequest,
  options?: { readonly runId?: string },
) => AsyncGenerator<RunEvent>;

const GENERIC_FAILURE = "Scoped test node failed.";
const COST_INVARIANT_FAILURE = "Scoped test cost invariant failed.";
const CANCELLED_FAILURE = "Scoped test node cancelled.";
const DEFAULT_RUN_ID = "ephemeral-scoped-test";
const CONTROL = /[\u0000-\u001f\u007f]/u;

type RawEventSnapshot =
  | { readonly kind: "run:start" }
  | { readonly kind: "node:start"; readonly nodeId: string; readonly nodeType: string }
  | { readonly kind: "node:log"; readonly nodeId: string; readonly level: "info" | "error"; readonly msg: string }
  | {
      readonly kind: "node:done";
      readonly nodeId: string;
      readonly nodeType: string;
      readonly outputs: unknown;
      readonly costUsdc: number;
    }
  | { readonly kind: "node:error"; readonly nodeId: string; readonly nodeType: string; readonly error: string }
  | { readonly kind: "run:done"; readonly totalCostUsdc: number; readonly status: "done" | "error" };

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

function safeRunId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !CONTROL.test(value)
    ? value
    : DEFAULT_RUN_ID;
}

function descriptorValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const descriptor = descriptors[key];
  return descriptor && "value" in descriptor
    ? { ok: true, value: descriptor.value }
    : { ok: false };
}

function snapshotRawEvent(value: unknown): RawEventSnapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const kind = descriptorValue(descriptors, "kind");
  const runId = descriptorValue(descriptors, "runId");
  if (!kind.ok || typeof kind.value !== "string" || !runId.ok || typeof runId.value !== "string") {
    return null;
  }
  if (kind.value === "run:start") {
    const at = descriptorValue(descriptors, "at");
    return at.ok && typeof at.value === "number" && Number.isFinite(at.value)
      ? { kind: "run:start" }
      : null;
  }
  if (kind.value === "run:done") {
    const totalCostUsdc = descriptorValue(descriptors, "totalCostUsdc");
    const status = descriptorValue(descriptors, "status");
    return totalCostUsdc.ok && typeof totalCostUsdc.value === "number" &&
      status.ok && (status.value === "done" || status.value === "error")
      ? { kind: "run:done", totalCostUsdc: totalCostUsdc.value, status: status.value }
      : null;
  }
  const nodeId = descriptorValue(descriptors, "nodeId");
  if (!nodeId.ok || typeof nodeId.value !== "string") return null;
  if (kind.value === "node:log") {
    const level = descriptorValue(descriptors, "level");
    const msg = descriptorValue(descriptors, "msg");
    return level.ok && (level.value === "info" || level.value === "error") &&
      msg.ok && typeof msg.value === "string"
      ? { kind: "node:log", nodeId: nodeId.value, level: level.value, msg: msg.value }
      : null;
  }
  const nodeType = descriptorValue(descriptors, "nodeType");
  if (!nodeType.ok || typeof nodeType.value !== "string") return null;
  if (kind.value === "node:start") {
    return { kind: "node:start", nodeId: nodeId.value, nodeType: nodeType.value };
  }
  if (kind.value === "node:done") {
    const outputs = descriptorValue(descriptors, "outputs");
    const costUsdc = descriptorValue(descriptors, "costUsdc");
    return outputs.ok && costUsdc.ok && typeof costUsdc.value === "number"
      ? {
          kind: "node:done", nodeId: nodeId.value, nodeType: nodeType.value,
          outputs: outputs.value, costUsdc: costUsdc.value,
        }
      : null;
  }
  if (kind.value === "node:error") {
    const error = descriptorValue(descriptors, "error");
    return error.ok && typeof error.value === "string"
      ? { kind: "node:error", nodeId: nodeId.value, nodeType: nodeType.value, error: error.value }
      : null;
  }
  return null;
}

function snapshotOptions(options: EphemeralScopedTestOptions): {
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly runId: string;
} {
  try {
    const signal = Reflect.get(options, "signal");
    const now = Reflect.get(options, "now");
    const runId = Reflect.get(options, "runId");
    return {
      ...(signal instanceof AbortSignal ? { signal } : {}),
      ...(typeof now === "function" ? { now: now as () => number } : {}),
      runId: safeRunId(runId),
    };
  } catch {
    return { runId: DEFAULT_RUN_ID };
  }
}

function clockValue(now: (() => number) | undefined): number | undefined {
  if (!now) return undefined;
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function finalMetrics(startedAt: number | undefined, now: (() => number) | undefined) {
  const finishedAt = clockValue(now);
  return normalizeTestRunMetrics({
    ...(startedAt !== undefined && finishedAt !== undefined && finishedAt >= startedAt
      ? { latencyMs: finishedAt - startedAt }
      : {}),
  });
}

function makeResult(
  runId: string,
  status: TestRunResult["status"],
  events: readonly TestRunEvent[],
  outputs: Readonly<Record<string, TestCapturedValue>>,
  logs: readonly TestRunLog[],
  startedAt: number | undefined,
  now: (() => number) | undefined,
): TestRunResult {
  const metrics = finalMetrics(startedAt, now);
  const finishedEvents = [...events, {
    kind: "test:done" as const,
    sequence: events.length,
    runId,
    status,
    costUsdc: 0 as const,
    ...metrics,
  }];
  return deepFreeze({
    runId,
    status,
    costUsdc: 0 as const,
    outputs: { ...outputs },
    events: finishedEvents,
    logs: [...logs],
    ...metrics,
  });
}

function initialEvents(runId: string): TestRunEvent[] {
  return [{ kind: "test:start", sequence: 0, runId }];
}

function policyFailure(
  runId: string,
  startedAt: number | undefined,
  now: (() => number) | undefined,
): TestRunResult {
  return makeResult(runId, "error", initialEvents(runId), {}, [], startedAt, now);
}

function closeIterator(iterator: AsyncGenerator<RunEvent>): void {
  void iterator.return(undefined).catch(() => undefined);
}

async function nextOrAbort(
  iterator: AsyncGenerator<RunEvent>,
  signal: AbortSignal | undefined,
): Promise<{ readonly kind: "next"; readonly value: IteratorResult<RunEvent> } | { readonly kind: "aborted" }> {
  if (!signal) return { kind: "next", value: await iterator.next() };
  if (signal.aborted) return { kind: "aborted" };
  const pending = iterator.next();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([
      pending.then((value) => ({ kind: "next" as const, value })),
      aborted,
    ]);
    if (outcome.kind === "aborted") {
      void pending.catch(() => undefined);
      closeIterator(iterator);
    }
    return outcome;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runEphemeralScopedTest(
  raw: unknown,
  rawOptions: EphemeralScopedTestOptions = {},
): Promise<TestRunResult> {
  const options = snapshotOptions(rawOptions);
  const { runId } = options;
  const startedAt = clockValue(options.now);
  const events = initialEvents(runId);
  if (options.signal?.aborted) {
    return makeResult(runId, "cancelled", events, {}, [], startedAt, options.now);
  }

  const compiled = validateAndCompileTestRunRequest(raw);
  if (!compiled.ok) return policyFailure(runId, startedAt, options.now);
  const canonical = getRegistry();
  const policy = preflightPlannedTestNodes(compiled.value.graph, compiled.value.plan, canonical);
  if (!policy.ok) return policyFailure(runId, startedAt, options.now);
  const plannedTypes = new Set(compiled.value.plan.nodeIds.map((nodeId) =>
    compiled.value.graph.nodes.find((node) => node.id === nodeId)?.type));
  if (plannedTypes.has("subflow") || plannedTypes.has("loop") || plannedTypes.has(undefined)) {
    return policyFailure(runId, startedAt, options.now);
  }
  const hook = (engine as unknown as { readonly runCompiledTestFlow?: CompiledTestFlowHook })
    .runCompiledTestFlow;
  if (typeof hook !== "function") return policyFailure(runId, startedAt, options.now);

  const publicCaptureBudget = createTestCaptureBudget();
  const publicLogBudget = createTestLogBudget();
  const outputs: Record<string, TestCapturedValue> = Object.create(null) as Record<string, TestCapturedValue>;
  const logs: TestRunLog[] = [];
  let status: TestRunResult["status"] = "done";
  let iterator: AsyncGenerator<RunEvent> | null = null;
  const plannedNodes = compiled.value.plan.executionOrder.map((nodeId) => {
    const planned = compiled.value.graph.nodes.find((node) => node.id === nodeId)!;
    return { id: planned.id, type: planned.type };
  });
  const plannedIndex = new Map(plannedNodes.map((node, index) => [node.id, index]));
  let runStarted = false;
  let runDone = false;
  let lastStartedIndex = -1;
  let active: { readonly index: number; readonly id: string; readonly type: NodeType } | null = null;
  let protocolFailed = false;

  try {
    iterator = hook(compiled.value, { runId });
    while (true) {
      const outcome = await nextOrAbort(iterator, options.signal);
      if (outcome.kind === "aborted") {
        if (active) {
          events.push({
            kind: "node:error",
            sequence: events.length,
            runId,
            nodeId: active.id,
            nodeType: active.type,
            code: "cancelled",
            message: CANCELLED_FAILURE,
            costUsdc: 0,
          });
          active = null;
        }
        status = "cancelled";
        break;
      }
      const next = outcome.value;
      if (next.done) break;
      const event = snapshotRawEvent(next.value);
      if (!event) {
        protocolFailed = true;
        status = "error";
        closeIterator(iterator);
        break;
      }
      if (event.kind === "run:start") {
        if (runStarted || runDone || active) {
          protocolFailed = true;
          status = "error";
          closeIterator(iterator);
          break;
        }
        runStarted = true;
        continue;
      }
      if (event.kind === "node:start") {
        if (options.signal?.aborted) {
          status = "cancelled";
          closeIterator(iterator);
          break;
        }
        const index = plannedIndex.get(event.nodeId);
        const planned = index === undefined ? undefined : plannedNodes[index];
        if (!runStarted || runDone || active || index === undefined || index <= lastStartedIndex ||
            !planned || event.nodeType !== planned.type) {
          protocolFailed = true;
          status = "error";
          closeIterator(iterator);
          break;
        }
        active = { index, id: planned.id, type: planned.type };
        lastStartedIndex = index;
        events.push({
          kind: "node:start",
          sequence: events.length,
          runId,
          nodeId: planned.id,
          nodeType: planned.type,
        });
        continue;
      }
      if (event.kind === "node:log") {
        if (!active || event.nodeId !== active.id) {
          protocolFailed = true;
          status = "error";
          closeIterator(iterator);
          break;
        }
        const captured = captureTestLog(event.level, event.msg, publicLogBudget);
        if (captured) logs.push(captured);
        continue;
      }
      if (event.kind === "node:done") {
        if (!active || event.nodeId !== active.id || event.nodeType !== active.type) {
          protocolFailed = true;
          status = "error";
          closeIterator(iterator);
          break;
        }
        const completed = active;
        active = null;
        if (event.costUsdc !== 0) {
          status = "error";
          events.push({
            kind: "node:error", sequence: events.length, runId,
            nodeId: completed.id, nodeType: completed.type,
            code: "cost-invariant", message: COST_INVARIANT_FAILURE, costUsdc: 0,
          });
          closeIterator(iterator);
          break;
        }
        const captured = captureTestValue(event.outputs, publicCaptureBudget);
        outputs[completed.id] = captured;
        events.push({
          kind: "node:done",
          sequence: events.length,
          runId,
          nodeId: completed.id,
          nodeType: completed.type,
          outputs: captured,
          costUsdc: 0,
        });
        continue;
      }
      if (event.kind === "node:error") {
        if (!active || event.nodeId !== active.id || event.nodeType !== active.type) {
          protocolFailed = true;
          status = "error";
          closeIterator(iterator);
          break;
        }
        const failed = active;
        active = null;
        status = "error";
        const costInvariant = event.error === COST_INVARIANT_FAILURE;
        events.push({
          kind: "node:error",
          sequence: events.length,
          runId,
          nodeId: failed.id,
          nodeType: failed.type,
          code: costInvariant ? "cost-invariant" : "execution-failed",
          message: costInvariant ? COST_INVARIANT_FAILURE : GENERIC_FAILURE,
          costUsdc: 0,
        });
        continue;
      }
      if (event.kind === "run:done") {
        if (!runStarted || runDone || active) {
          protocolFailed = true;
          status = "error";
          closeIterator(iterator);
          break;
        }
        runDone = true;
        if (event.totalCostUsdc !== 0) status = "error";
        else if (status !== "error") status = event.status;
        continue;
      }
      status = "error";
    }
  } catch {
    status = "error";
    protocolFailed = true;
    if (iterator) closeIterator(iterator);
  }

  if (status !== "cancelled" && (!runStarted || !runDone || active !== null)) {
    protocolFailed = true;
    status = "error";
  }

  if (protocolFailed) {
    for (const key of Object.keys(outputs)) delete outputs[key];
    logs.splice(0, logs.length);
    events.splice(1, events.length - 1);
  }
  return makeResult(runId, status, events, outputs, logs, startedAt, options.now);
}
