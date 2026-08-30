import { NODE_TYPE_SET } from "./node-definitions";
import {
  planFlowTestScope,
  type FlowTestBoundaryPin,
  type FlowTestScope,
  type PlannedFlowTestScope,
} from "./test-scope";
import {
  TEST_RUN_CAPTURE_LIMITS,
  type TestCapturedValue,
  type TestRunEvent,
  type TestRunLog,
  type TestRunResult,
} from "./test-runner-contract";
import {
  TEST_RUN_REQUEST_LIMITS,
  parseTestBoundaryPinKey,
  parseTestRunRequest,
  validateAndCompileTestRunRequest,
  type TestRunRequest,
} from "./test-run-contract";
import { inspectTestInput } from "./test-input-safety";
import type { TestInputPath } from "./test-input-safety";
import type { FlowGraphV2, JsonValue, NodeType } from "./types";
import type { ValidatedNodePortResolver } from "./node-ports";

const DISABLED_MESSAGE = "This scoped test cannot run safely." as const;
const INVALID_PINS_MESSAGE = "Enter valid values for every required pin." as const;
const TEXT_ENCODER = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_RESULT_EVENTS = TEST_RUN_REQUEST_LIMITS.graphNodes * 2 + 2;
const MAX_RESULT_OUTPUTS = TEST_RUN_REQUEST_LIMITS.graphNodes;
const MAX_RESULT_BYTES =
  TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes * 2 +
  TEST_RUN_CAPTURE_LIMITS.aggregateLogBytes +
  MAX_RESULT_EVENTS * (
    TEST_RUN_REQUEST_LIMITS.graphIdentityBytes * 2 + TEST_RUN_CAPTURE_LIMITS.logBytes + 512
  ) +
  MAX_RESULT_OUTPUTS * (TEST_RUN_REQUEST_LIMITS.graphIdentityBytes + 128);
const MAX_RESULT_VALUES =
  TEST_RUN_REQUEST_LIMITS.requestValues * 2 +
  MAX_RESULT_EVENTS * 16 +
  TEST_RUN_CAPTURE_LIMITS.logCount * 2;
const MAX_RESULT_DEPTH = TEST_RUN_CAPTURE_LIMITS.valueDepth + 5;

export const TEST_RUN_UI_LIMITS = Object.freeze({
  responseBytes: MAX_RESULT_BYTES,
  responseChunks: 8_192,
} as const);

export interface TestRunPinFormDescriptor {
  readonly key: string;
  readonly kind: FlowTestBoundaryPin["kind"];
  readonly label: string;
  readonly control: "json" | "boolean";
}

export interface ReadyTestRunUiPlan {
  readonly status: "ready";
  readonly scope: FlowTestScope;
  readonly executionOrder: readonly string[];
  readonly pins: readonly TestRunPinFormDescriptor[];
}

export interface DisabledTestRunUiPlan {
  readonly status: "disabled";
  readonly message: typeof DISABLED_MESSAGE;
}

export type TestRunUiPlan = ReadyTestRunUiPlan | DisabledTestRunUiPlan;

export type ParsedTestRunPinValues =
  | { readonly ok: true; readonly pinnedInputs: Readonly<Record<string, JsonValue>> }
  | { readonly ok: false; readonly message: typeof INVALID_PINS_MESSAGE };

export type AssembledTestRunRequest =
  | { readonly ok: true; readonly request: TestRunRequest }
  | { readonly ok: false; readonly message: typeof DISABLED_MESSAGE | typeof INVALID_PINS_MESSAGE };

function pinLabel(pin: FlowTestBoundaryPin): string {
  const source = `${pin.sourceNodeId}.${pin.sourcePortId}`;
  if (pin.kind === "edge-input") {
    return `${source} → ${pin.targetNodeId}.${pin.targetPortId}`;
  }
  if (pin.kind === "node-binding") {
    return `${source} → ${pin.targetNodeId}.${pin.bindingKey}${pin.path === undefined ? "" : ` at ${pin.path}`}`;
  }
  return `${source} → condition on ${pin.edgeId}${pin.path === undefined ? "" : ` at ${pin.path}`}`;
}

function pinDescriptor(pin: FlowTestBoundaryPin): TestRunPinFormDescriptor {
  return {
    key: pin.key,
    kind: pin.kind,
    label: pinLabel(pin),
    control: pin.kind === "edge-condition" ? "boolean" : "json",
  };
}

function uiPlanSecretReferencePath(path: TestInputPath): boolean {
  return (path.length === 5 && path[0] === "graph" && path[1] === "nodes" &&
      typeof path[2] === "number" && path[3] === "bindings" && typeof path[4] === "string") ||
    (path.length === 4 && path[0] === "graph" && path[1] === "edges" &&
      typeof path[2] === "number" && path[3] === "condition");
}

export function createTestRunUiPlan(
  graph: FlowGraphV2,
  scope: FlowTestScope,
  resolvePorts?: ValidatedNodePortResolver,
): TestRunUiPlan {
  let plan: ReturnType<typeof planFlowTestScope>;
  try {
    const snapshot = structuredClone({ graph, scope });
    const inspected = inspectTestInput(snapshot, {
      limits: {
        maxBytes: TEST_RUN_REQUEST_LIMITS.requestBytes,
        maxDepth: TEST_RUN_REQUEST_LIMITS.requestDepth,
        maxValues: TEST_RUN_REQUEST_LIMITS.requestValues,
      },
      allowGraphSecretReferenceAt: uiPlanSecretReferencePath,
    });
    if (!inspected.ok) return { status: "disabled", message: DISABLED_MESSAGE };
    plan = planFlowTestScope(snapshot.graph, snapshot.scope, resolvePorts);
  } catch {
    return { status: "disabled", message: DISABLED_MESSAGE };
  }
  if (plan.status !== "planned") return { status: "disabled", message: DISABLED_MESSAGE };
  return {
    status: "ready",
    scope: { ...plan.scope },
    executionOrder: [...plan.executionOrder],
    pins: plan.boundaryPins.map(pinDescriptor),
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonValueWithinBounds(value: unknown): value is JsonValue {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return false;
  }
  if (encoded === undefined || TEXT_ENCODER.encode(encoded).byteLength > TEST_RUN_CAPTURE_LIMITS.valueBytes) {
    return false;
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    count += 1;
    if (count > TEST_RUN_CAPTURE_LIMITS.valueCount || current.depth > TEST_RUN_CAPTURE_LIMITS.valueDepth) {
      return false;
    }
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!plainRecord(item)) return false;
    for (const child of Object.values(item)) pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function validPinDescriptors(value: unknown): value is readonly TestRunPinFormDescriptor[] {
  return Array.isArray(value) && value.every((pin) => {
    if (!plainRecord(pin) || !exactKeys(pin, ["key", "kind", "label", "control"]) ||
        !boundedText(pin.key, 4_096) || !boundedText(pin.label, 1_024) ||
        (pin.kind !== "edge-input" && pin.kind !== "edge-condition" && pin.kind !== "node-binding") ||
        (pin.control !== "json" && pin.control !== "boolean") ||
        (pin.kind === "edge-condition" ? pin.control !== "boolean" : pin.control !== "json")) return false;
    const tuple = parseTestBoundaryPinKey(pin.key);
    return tuple !== null && tuple[0] === pin.kind;
  });
}

function safePinMap<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

function definePin<Value>(target: Record<string, Value>, key: string, value: Value): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

export function parseTestRunPinValues(
  pins: readonly TestRunPinFormDescriptor[],
  values: Readonly<Record<string, string>>,
): ParsedTestRunPinValues {
  let pinSnapshot: readonly TestRunPinFormDescriptor[];
  let valueSnapshot: Readonly<Record<string, string>>;
  try {
    pinSnapshot = structuredClone(pins);
    valueSnapshot = structuredClone(values);
  } catch {
    return { ok: false, message: INVALID_PINS_MESSAGE };
  }
  if (!validPinDescriptors(pinSnapshot) || !plainRecord(valueSnapshot)) {
    return { ok: false, message: INVALID_PINS_MESSAGE };
  }
  const required = pinSnapshot.map(({ key }) => key).sort();
  const provided = Object.keys(valueSnapshot).sort();
  if (required.length !== provided.length || required.some((key, index) => key !== provided[index])) {
    return { ok: false, message: INVALID_PINS_MESSAGE };
  }
  const pinnedInputs = safePinMap<JsonValue>();
  for (const pin of pinSnapshot) {
    const raw = valueSnapshot[pin.key];
    if (typeof raw !== "string") return { ok: false, message: INVALID_PINS_MESSAGE };
    if (pin.control === "boolean") {
      if (raw !== "true" && raw !== "false") return { ok: false, message: INVALID_PINS_MESSAGE };
      definePin(pinnedInputs, pin.key, raw === "true");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, message: INVALID_PINS_MESSAGE };
    }
    const inspected = inspectTestInput(parsed, {
      limits: {
        maxBytes: TEST_RUN_REQUEST_LIMITS.pinnedValueBytes,
        maxDepth: TEST_RUN_REQUEST_LIMITS.pinnedValueDepth,
        maxValues: TEST_RUN_REQUEST_LIMITS.pinnedValueValues,
      },
    });
    if (!inspected.ok || !jsonValueWithinBounds(parsed)) {
      return { ok: false, message: INVALID_PINS_MESSAGE };
    }
    definePin(pinnedInputs, pin.key, structuredClone(parsed) as JsonValue);
  }
  return { ok: true, pinnedInputs };
}

export function pruneTestRunPinValues(
  pins: readonly TestRunPinFormDescriptor[],
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const next = safePinMap<string>();
  let pinSnapshot: readonly TestRunPinFormDescriptor[];
  let valueSnapshot: Readonly<Record<string, string>>;
  try {
    pinSnapshot = structuredClone(pins);
    valueSnapshot = structuredClone(values);
  } catch {
    return next;
  }
  if (!validPinDescriptors(pinSnapshot) || !plainRecord(valueSnapshot)) return next;
  for (const pin of pinSnapshot) {
    const raw = valueSnapshot[pin.key];
    if (typeof raw !== "string") continue;
    if (!parseTestRunPinValues([pin], { [pin.key]: raw }).ok) return {};
    definePin(next, pin.key, raw);
  }
  return next;
}

function validEnvironmentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !CONTROL.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= 512;
}

export function assembleTestRunRequest(input: {
  readonly graph: FlowGraphV2;
  readonly scope: FlowTestScope;
  readonly environmentId: string;
  readonly pinValues: Readonly<Record<string, string>>;
}): AssembledTestRunRequest {
  let snapshot: typeof input;
  try {
    snapshot = structuredClone(input);
  } catch {
    return { ok: false, message: DISABLED_MESSAGE };
  }
  if (!validEnvironmentId(snapshot.environmentId)) {
    return { ok: false, message: DISABLED_MESSAGE };
  }
  const plan = createTestRunUiPlan(snapshot.graph, snapshot.scope);
  if (plan.status !== "ready") return { ok: false, message: plan.message };
  const parsed = parseTestRunPinValues(plan.pins, snapshot.pinValues);
  if (!parsed.ok) return parsed;
  const request: TestRunRequest = {
      graph: snapshot.graph,
      scope: plan.scope,
      pinnedInputs: (() => {
        const pins = safePinMap<JsonValue>();
        for (const [key, value] of Object.entries(parsed.pinnedInputs)) {
          definePin(pins, key, structuredClone(value));
        }
        return pins;
      })(),
      mode: "test" as const,
      environmentId: snapshot.environmentId,
  };
  const canonical = parseTestRunRequest(request);
  if (!canonical.ok || !validateAndCompileTestRunRequest(request).ok) {
    return { ok: false, message: DISABLED_MESSAGE };
  }
  return { ok: true, request };
}

function boundedIdentity(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    TEXT_ENCODER.encode(value).byteLength <= maxBytes && !CONTROL.test(value);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && TEXT_ENCODER.encode(value).byteLength <= maxBytes;
}

function metricFields(value: Readonly<Record<string, unknown>>): boolean {
  return (value.latencyMs === undefined ||
      (typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0)) &&
    (value.tokens === undefined ||
      (typeof value.tokens === "number" && Number.isSafeInteger(value.tokens) && value.tokens >= 0));
}

function capturedValue(value: unknown): value is TestCapturedValue {
  if (!plainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "value") {
    return exactKeys(value, ["kind", "value"]) && jsonValueWithinBounds(value.value);
  }
  return value.kind === "omitted" && exactKeys(value, ["kind", "reason"]) &&
    (value.reason === "limit" || value.reason === "sensitive" || value.reason === "unsupported");
}

function validNodeBase(value: Readonly<Record<string, unknown>>, runId: string): boolean {
  return value.runId === runId && boundedIdentity(value.nodeId, TEST_RUN_REQUEST_LIMITS.scopeIdBytes) &&
    typeof value.nodeType === "string" && NODE_TYPE_SET.has(value.nodeType as NodeType);
}

function testRunEvent(value: unknown, runId: string, sequence: number): value is TestRunEvent {
  if (!plainRecord(value) || value.runId !== runId || value.sequence !== sequence || !Number.isSafeInteger(value.sequence)) {
    return false;
  }
  if (value.kind === "test:start") return exactKeys(value, ["kind", "sequence", "runId"]);
  if (value.kind === "node:start") {
    return exactKeys(value, ["kind", "sequence", "runId", "nodeId", "nodeType"]) && validNodeBase(value, runId);
  }
  if (value.kind === "node:done") {
    return exactKeys(
      value,
      ["kind", "sequence", "runId", "nodeId", "nodeType", "outputs", "costUsdc"],
      ["latencyMs", "tokens"],
    ) && validNodeBase(value, runId) && capturedValue(value.outputs) && value.costUsdc === 0 && metricFields(value);
  }
  if (value.kind === "node:error") {
    return exactKeys(
      value,
      ["kind", "sequence", "runId", "nodeId", "nodeType", "code", "message", "costUsdc"],
      ["latencyMs", "tokens"],
    ) && validNodeBase(value, runId) &&
      ["policy-refused", "execution-failed", "cost-invariant", "cancelled"].includes(String(value.code)) &&
      boundedText(value.message, TEST_RUN_CAPTURE_LIMITS.logBytes) && value.costUsdc === 0 && metricFields(value);
  }
  if (value.kind === "test:done") {
    return exactKeys(
      value,
      ["kind", "sequence", "runId", "status", "costUsdc"],
      ["latencyMs", "tokens"],
    ) && (value.status === "done" || value.status === "error" || value.status === "cancelled") &&
      value.costUsdc === 0 && metricFields(value);
  }
  return false;
}

function testRunLog(value: unknown): value is TestRunLog {
  return plainRecord(value) && exactKeys(value, ["level", "message"]) &&
    (value.level === "info" || value.level === "error") &&
    boundedText(value.message, TEST_RUN_CAPTURE_LIMITS.logBytes);
}

function capturesEqual(left: TestCapturedValue, right: TestCapturedValue): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function coherentLifecycle(result: TestRunResult): boolean {
  const activeStarts = new Set<string>();
  const completed = new Map<string, TestCapturedValue>();
  let active: { readonly nodeId: string; readonly nodeType: NodeType } | null = null;
  let sawNodeError = false;
  let sawCancelledError = false;
  for (let index = 0; index < result.events.length; index += 1) {
    const event = result.events[index]!;
    if (index === 0) {
      if (event.kind !== "test:start") return false;
      continue;
    }
    if (event.kind === "test:start") return false;
    if (event.kind === "test:done") {
      if (index !== result.events.length - 1 || active !== null) return false;
      continue;
    }
    if (event.kind === "node:start") {
      if (active !== null || activeStarts.has(event.nodeId)) return false;
      activeStarts.add(event.nodeId);
      active = { nodeId: event.nodeId, nodeType: event.nodeType };
      continue;
    }
    if (!active || event.nodeId !== active.nodeId || event.nodeType !== active.nodeType) return false;
    if (event.kind === "node:done") {
      completed.set(event.nodeId, event.outputs);
    } else {
      sawNodeError = true;
      if (event.code === "cancelled") sawCancelledError = true;
    }
    active = null;
  }
  const outputEntries = Object.entries(result.outputs);
  if (outputEntries.length !== completed.size || outputEntries.some(([nodeId, output]) => {
    const eventOutput = completed.get(nodeId);
    return eventOutput === undefined || !capturesEqual(output, eventOutput);
  })) return false;
  if (result.status === "done" && sawNodeError) return false;
  if (sawCancelledError && result.status !== "cancelled") return false;
  return true;
}

function terminalMetricsMatch(result: TestRunResult): boolean {
  const terminal = result.events[result.events.length - 1];
  if (!terminal || terminal.kind !== "test:done") return false;
  for (const key of ["latencyMs", "tokens"] as const) {
    if (Object.hasOwn(result, key) !== Object.hasOwn(terminal, key) || result[key] !== terminal[key]) {
      return false;
    }
  }
  return true;
}

function resultShape(value: unknown): value is TestRunResult {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["runId", "status", "costUsdc", "outputs", "events", "logs"],
    ["latencyMs", "tokens"],
  )) return false;
  if (!boundedIdentity(value.runId, TEST_RUN_REQUEST_LIMITS.graphIdentityBytes) ||
      (value.status !== "done" && value.status !== "error" && value.status !== "cancelled") ||
      value.costUsdc !== 0 || !metricFields(value) || !plainRecord(value.outputs) ||
      !Array.isArray(value.events) || !Array.isArray(value.logs)) return false;
  const outputEntries = Object.entries(value.outputs);
  if (outputEntries.length > MAX_RESULT_OUTPUTS || outputEntries.some(([key, output]) =>
    !boundedIdentity(key, TEST_RUN_REQUEST_LIMITS.scopeIdBytes) || !capturedValue(output))) return false;
  let capturedBytes = 0;
  for (const [, output] of outputEntries) {
    if (!plainRecord(output) || output.kind !== "value") continue;
    const inspected = inspectTestInput(output.value, {
      limits: {
        maxBytes: TEST_RUN_CAPTURE_LIMITS.valueBytes,
        maxDepth: TEST_RUN_CAPTURE_LIMITS.valueDepth,
        maxValues: TEST_RUN_CAPTURE_LIMITS.valueCount,
      },
    });
    if (!inspected.ok || inspected.encodedBytes > TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes - capturedBytes) {
      return false;
    }
    capturedBytes += inspected.encodedBytes;
  }
  if (value.events.length < 2 || value.events.length > MAX_RESULT_EVENTS ||
      value.events.some((event, index) => !testRunEvent(event, value.runId as string, index))) return false;
  const first = value.events[0];
  const last = value.events[value.events.length - 1];
  if (!plainRecord(first) || first.kind !== "test:start" || !plainRecord(last) ||
      last.kind !== "test:done" || last.status !== value.status) return false;
  if (value.logs.length > TEST_RUN_CAPTURE_LIMITS.logCount || !value.logs.every(testRunLog)) return false;
  let logBytes = 0;
  for (const log of value.logs) {
    const encoded = TEXT_ENCODER.encode(JSON.stringify(log.message)).byteLength;
    if (encoded > TEST_RUN_CAPTURE_LIMITS.aggregateLogBytes - logBytes) return false;
    logBytes += encoded;
  }
  const result = value as unknown as TestRunResult;
  return coherentLifecycle(result) && terminalMetricsMatch(result);
}

export function parseTestRunResultEnvelope(value: unknown): TestRunResult | null {
  const inspected = inspectTestInput(value, {
    limits: { maxBytes: MAX_RESULT_BYTES, maxDepth: MAX_RESULT_DEPTH, maxValues: MAX_RESULT_VALUES },
  });
  if (!inspected.ok) return null;
  try {
    const snapshot = structuredClone(value);
    if (!plainRecord(snapshot) || !exactKeys(snapshot, ["result"]) || !resultShape(snapshot.result)) {
      return null;
    }
    return structuredClone(snapshot.result);
  } catch {
    return null;
  }
}

/** Compile-time assertion that the UI model never widens the canonical planner shape. */
const _plannedScopeCompatibility: PlannedFlowTestScope["scope"] extends FlowTestScope ? true : never = true;
void _plannedScopeCompatibility;
