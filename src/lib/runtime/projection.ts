import { parseDurableExecutionEvent } from "./event-schema";
import type {
  DurableExecutionEventV1,
  DurableExecutionProjection,
  DurableExecutionState,
  DurableJsonValue,
} from "./types";

const INVALID_PROJECTION = "Invalid durable execution projection";
const TERMINAL = new Set<DurableExecutionState>(["succeeded", "failed", "cancelled", "dead"]);
const MAX_NODE_RECORDS = 1_000;
const MAX_LOG_TAIL = 200;
const MAX_CONTROL_TAIL = 100;

function invalid(): never {
  throw new Error(INVALID_PROJECTION);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

type MutableProjection = {
  schemaVersion: 1;
  executionId: string;
  definitionHash: string;
  sequence: number;
  state: DurableExecutionState;
  desiredState: "running" | "paused" | "cancelled";
  attempt: number;
  jobId: string | null;
  attemptId: string | null;
  costMicroUsdc: number;
  tokens: number;
  output: DurableJsonValue | null;
  error: string | null;
  nodes: Record<string, { state: "running" | "completed" | "failed"; attempt: number; output: DurableJsonValue | null; error: string | null }>;
  logs: Array<{ sequence: number; nodeId: string; level: "info" | "warn" | "error"; message: string }>;
  logCount: number;
  controlRequests: Array<{ sequence: number; action: "cancel" | "pause" | "resume" }>;
  controlRequestCount: number;
  retry: { attempt: number; availableAt: number; error: string } | null;
  deadLetter: { attempt: number; error: string } | null;
  claimedAttemptId: string | null;
  attemptStarted: boolean;
  nodeCount: number;
  seenAttemptIds: Set<string>;
};

function initial(event: Extract<DurableExecutionEventV1, { type: "execution.created" }>): MutableProjection {
  return {
    schemaVersion: 1,
    executionId: event.executionId,
    definitionHash: event.payload.definitionHash,
    sequence: event.sequence,
    state: "queued",
    desiredState: "running",
    attempt: 0,
    jobId: null,
    attemptId: null,
    costMicroUsdc: 0,
    tokens: 0,
    output: null,
    error: null,
    nodes: {},
    logs: [],
    logCount: 0,
    controlRequests: [],
    controlRequestCount: 0,
    retry: null,
    deadLetter: null,
    claimedAttemptId: null,
    attemptStarted: false,
    nodeCount: 0,
    seenAttemptIds: new Set(),
  };
}

function requireRunningAttempt(state: MutableProjection, event: DurableExecutionEventV1): void {
  if (state.state !== "running" || !state.attemptStarted || event.attempt !== state.attempt) invalid();
}

function readEventStream(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return invalid();
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return invalid();
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value <= 0) return invalid();
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return invalid();
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    result.push(descriptor.value);
  }
  return result;
}

function apply(state: MutableProjection, event: DurableExecutionEventV1): void {
  if (TERMINAL.has(state.state) || event.type === "execution.created") invalid();
  switch (event.type) {
    case "job.enqueued":
      if (state.jobId !== null || state.state !== "queued" || event.attempt !== 0) invalid();
      state.jobId = event.payload.jobId;
      break;
    case "job.claimed":
      if (state.jobId !== event.payload.jobId || state.state !== "queued" || state.desiredState !== "running" || event.attempt !== state.attempt + 1 || state.seenAttemptIds.has(event.payload.attemptId)) invalid();
      state.seenAttemptIds.add(event.payload.attemptId);
      state.state = "running";
      state.attempt = event.attempt;
      state.attemptId = event.payload.attemptId;
      state.claimedAttemptId = event.payload.attemptId;
      state.attemptStarted = false;
      break;
    case "attempt.started":
      if (state.state !== "running" || state.attemptStarted || event.attempt !== state.attempt || event.payload.attemptId !== state.claimedAttemptId) invalid();
      state.attemptStarted = true;
      break;
    case "node.started":
      requireRunningAttempt(state, event);
      if (state.nodes[event.payload.nodeId]) {
        if (state.nodes[event.payload.nodeId].attempt >= event.attempt) invalid();
      } else {
        if (state.nodeCount >= MAX_NODE_RECORDS) invalid();
        state.nodeCount += 1;
      }
      state.nodes[event.payload.nodeId] = { state: "running", attempt: event.attempt, output: null, error: null };
      break;
    case "node.logged": {
      requireRunningAttempt(state, event);
      const node = state.nodes[event.payload.nodeId];
      if (!node || node.state !== "running" || node.attempt !== event.attempt) invalid();
      state.logCount += 1;
      if (state.logs.length === MAX_LOG_TAIL) state.logs.shift();
      state.logs.push({ sequence: event.sequence, nodeId: event.payload.nodeId, level: event.payload.level, message: event.payload.message });
      break;
    }
    case "node.completed": {
      requireRunningAttempt(state, event);
      const node = state.nodes[event.payload.nodeId];
      if (!node || node.state !== "running" || node.attempt !== event.attempt) invalid();
      state.costMicroUsdc += event.payload.costMicroUsdc;
      state.tokens += event.payload.tokens;
      if (!Number.isSafeInteger(state.costMicroUsdc) || !Number.isSafeInteger(state.tokens)) invalid();
      state.nodes[event.payload.nodeId] = { state: "completed", attempt: event.attempt, output: event.payload.output, error: null };
      break;
    }
    case "node.failed": {
      requireRunningAttempt(state, event);
      const node = state.nodes[event.payload.nodeId];
      if (!node || node.state !== "running" || node.attempt !== event.attempt) invalid();
      state.nodes[event.payload.nodeId] = { state: "failed", attempt: event.attempt, output: null, error: event.payload.error };
      break;
    }
    case "control.requested":
      if (event.attempt !== state.attempt) invalid();
      if (event.payload.action === "pause") {
        if (state.state !== "queued" && state.state !== "running") invalid();
        state.desiredState = "paused";
      } else if (event.payload.action === "cancel") {
        if (state.state === "paused" || state.state === "queued" || state.state === "running") state.desiredState = "cancelled";
        else invalid();
      } else if (event.payload.action === "resume") {
        if (state.state !== "paused" || state.desiredState !== "paused") invalid();
        state.desiredState = "running";
      }
      state.controlRequestCount += 1;
      if (state.controlRequests.length === MAX_CONTROL_TAIL) state.controlRequests.shift();
      state.controlRequests.push({ sequence: event.sequence, action: event.payload.action });
      break;
    case "attempt.retry_scheduled":
      requireRunningAttempt(state, event);
      if (event.payload.attemptId !== state.attemptId || event.payload.availableAt < event.at) invalid();
      state.retry = { attempt: event.attempt, availableAt: event.payload.availableAt, error: event.payload.error };
      state.state = "queued";
      state.attemptStarted = false;
      state.claimedAttemptId = null;
      break;
    case "execution.paused":
      if ((state.state !== "running" && state.state !== "queued") || state.desiredState !== "paused" || event.attempt !== state.attempt) invalid();
      state.state = "paused";
      state.attemptStarted = false;
      break;
    case "execution.resumed":
      if (state.state !== "paused" || state.desiredState !== "running" || event.attempt !== state.attempt) invalid();
      state.state = "queued";
      break;
    case "execution.cancelled":
      if (state.desiredState !== "cancelled" || event.attempt !== state.attempt) invalid();
      state.state = "cancelled";
      state.error = event.payload.reason;
      break;
    case "execution.succeeded":
      requireRunningAttempt(state, event);
      if (event.payload.costMicroUsdc !== state.costMicroUsdc || event.payload.tokens !== state.tokens) invalid();
      state.state = "succeeded";
      state.output = event.payload.output;
      break;
    case "execution.failed":
      requireRunningAttempt(state, event);
      if (event.payload.costMicroUsdc !== state.costMicroUsdc || event.payload.tokens !== state.tokens) invalid();
      state.state = "failed";
      state.error = event.payload.error;
      break;
    case "execution.dead_lettered":
      requireRunningAttempt(state, event);
      state.state = "dead";
      state.error = event.payload.error;
      state.deadLetter = { attempt: event.attempt, error: event.payload.error };
      break;
  }
  state.sequence = event.sequence;
}

export function foldExecutionEvents(events: readonly DurableExecutionEventV1[]): DurableExecutionProjection {
  try {
    const stream = readEventStream(events);
    const validated = stream.map((event, index) => {
      const parsed = parseDurableExecutionEvent(event);
      if (parsed.sequence !== index + 1) return invalid();
      return parsed;
    });
    const first = validated[0];
    if (!first || first.type !== "execution.created" || first.attempt !== 0) return invalid();
    const state = initial(first);
    for (let index = 1; index < validated.length; index += 1) {
      const event = validated[index] as DurableExecutionEventV1;
      if (event.executionId !== state.executionId) return invalid();
      apply(state, event);
    }
    const {
      claimedAttemptId: _claimedAttemptId,
      attemptStarted: _attemptStarted,
      nodeCount: _nodeCount,
      seenAttemptIds: _seenAttemptIds,
      ...projection
    } = state;
    return freezeDeep(projection) as DurableExecutionProjection;
  } catch {
    return invalid();
  }
}
