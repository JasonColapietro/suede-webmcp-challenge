import type {
  DurableExecutionEventTypeV1,
  DurableExecutionEventV1,
  DurableJsonValue,
} from "./types";

const INVALID_EVENT = "Invalid durable execution event";
const MAX_ID_LENGTH = 512;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_LOG_LENGTH = 16 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_DEPTH = 32;
const ENVELOPE_KEYS = ["schemaVersion", "executionId", "sequence", "attempt", "type", "at", "payload"] as const;
const EVENT_TYPES = new Set<DurableExecutionEventTypeV1>([
  "execution.created", "job.enqueued", "job.claimed", "attempt.started",
  "node.started", "node.logged", "node.completed", "node.failed",
  "control.requested", "attempt.retry_scheduled", "execution.paused",
  "execution.resumed", "execution.cancelled", "execution.succeeded",
  "execution.failed", "execution.dead_lettered",
]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TEXT_ENCODER = new TextEncoder();

function invalid(): never {
  throw new Error(INVALID_EVENT);
}

function ownData(value: object): ReadonlyMap<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype) return invalid();
  const entries = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || UNSAFE_KEYS.has(key)) return invalid();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid();
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    entries.set(key, descriptor.value);
  }
  return entries;
}

function exact(entries: ReadonlyMap<string, unknown>, keys: readonly string[]): void {
  if (entries.size !== keys.length || keys.some((key) => !entries.has(key))) invalid();
}

function dataArray(value: unknown[], depth: number, ancestors: Set<object>): readonly DurableJsonValue[] {
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return invalid();
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return invalid();
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return invalid();
  const result: DurableJsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid();
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    result.push(cloneData(descriptor.value, depth + 1, ancestors));
  }
  return Object.freeze(result);
}

function cloneData(value: unknown, depth: number, ancestors: Set<object>): DurableJsonValue {
  if (depth > MAX_DEPTH) return invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid();
    return value;
  }
  if (typeof value !== "object") return invalid();
  if (ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return dataArray(value, depth, ancestors);
    const entries = ownData(value);
    const result: Record<string, DurableJsonValue> = {};
    for (const [key, child] of entries) result[key] = cloneData(child, depth + 1, ancestors);
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return invalid();
  return value;
}

function utf8Text(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes) return invalid();
  if (TEXT_ENCODER.encode(value).byteLength > maximumBytes) return invalid();
  return value;
}

function id(value: unknown): string {
  const result = text(value, MAX_ID_LENGTH);
  if (result.trim() !== result || /[\u0000-\u001f\u007f]/u.test(result) || UNSAFE_KEYS.has(result)) return invalid();
  return result;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) return invalid();
  return value as number;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return invalid();
  return value;
}

function jsonBytes(value: DurableJsonValue): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function parsePayload(type: DurableExecutionEventTypeV1, value: unknown): DurableJsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const raw = ownData(value);
  let payload: Record<string, DurableJsonValue>;
  switch (type) {
    case "execution.created":
      exact(raw, ["definitionHash"]);
      payload = { definitionHash: hash(raw.get("definitionHash")) };
      break;
    case "job.enqueued":
      exact(raw, ["jobId", "priority", "availableAt"]);
      payload = { jobId: id(raw.get("jobId")), priority: safeInteger(raw.get("priority")), availableAt: safeInteger(raw.get("availableAt")) };
      break;
    case "job.claimed":
      exact(raw, ["jobId", "attemptId", "workerId", "leaseExpiresAt"]);
      payload = { jobId: id(raw.get("jobId")), attemptId: id(raw.get("attemptId")), workerId: id(raw.get("workerId")), leaseExpiresAt: safeInteger(raw.get("leaseExpiresAt")) };
      break;
    case "attempt.started":
      exact(raw, ["attemptId"]);
      payload = { attemptId: id(raw.get("attemptId")) };
      break;
    case "node.started":
      exact(raw, ["nodeId"]);
      payload = { nodeId: id(raw.get("nodeId")) };
      break;
    case "node.logged": {
      exact(raw, ["nodeId", "level", "message"]);
      const level = raw.get("level");
      if (level !== "info" && level !== "warn" && level !== "error") return invalid();
      payload = { nodeId: id(raw.get("nodeId")), level, message: text(raw.get("message"), MAX_LOG_LENGTH) };
      break;
    }
    case "node.completed": {
      exact(raw, ["nodeId", "output", "costMicroUsdc", "tokens"]);
      const output = cloneData(raw.get("output"), 0, new Set());
      if (jsonBytes(output) > MAX_OUTPUT_BYTES) return invalid();
      payload = { nodeId: id(raw.get("nodeId")), output, costMicroUsdc: safeInteger(raw.get("costMicroUsdc")), tokens: safeInteger(raw.get("tokens")) };
      break;
    }
    case "node.failed":
      exact(raw, ["nodeId", "error"]);
      payload = { nodeId: id(raw.get("nodeId")), error: utf8Text(raw.get("error"), MAX_ERROR_BYTES) };
      break;
    case "control.requested": {
      exact(raw, ["action"]);
      const action = raw.get("action");
      if (action !== "cancel" && action !== "pause" && action !== "resume") return invalid();
      payload = { action };
      break;
    }
    case "attempt.retry_scheduled":
      exact(raw, ["attemptId", "error", "availableAt"]);
      payload = { attemptId: id(raw.get("attemptId")), error: utf8Text(raw.get("error"), MAX_ERROR_BYTES), availableAt: safeInteger(raw.get("availableAt")) };
      break;
    case "execution.paused":
    case "execution.resumed":
      exact(raw, []);
      payload = {};
      break;
    case "execution.cancelled":
      exact(raw, ["reason"]);
      payload = { reason: utf8Text(raw.get("reason"), MAX_ERROR_BYTES) };
      break;
    case "execution.succeeded": {
      exact(raw, ["output", "costMicroUsdc", "tokens"]);
      const output = cloneData(raw.get("output"), 0, new Set());
      if (jsonBytes(output) > MAX_OUTPUT_BYTES) return invalid();
      payload = { output, costMicroUsdc: safeInteger(raw.get("costMicroUsdc")), tokens: safeInteger(raw.get("tokens")) };
      break;
    }
    case "execution.failed":
      exact(raw, ["error", "costMicroUsdc", "tokens"]);
      payload = { error: utf8Text(raw.get("error"), MAX_ERROR_BYTES), costMicroUsdc: safeInteger(raw.get("costMicroUsdc")), tokens: safeInteger(raw.get("tokens")) };
      break;
    case "execution.dead_lettered":
      exact(raw, ["error"]);
      payload = { error: utf8Text(raw.get("error"), MAX_ERROR_BYTES) };
      break;
  }
  const frozen = Object.freeze(payload);
  if (jsonBytes(frozen) > MAX_PAYLOAD_BYTES) return invalid();
  return frozen;
}

export function parseDurableExecutionEvent(value: unknown): DurableExecutionEventV1 {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
    const raw = ownData(value);
    exact(raw, ENVELOPE_KEYS);
    if (raw.get("schemaVersion") !== 1) return invalid();
    const type = raw.get("type");
    if (typeof type !== "string" || !EVENT_TYPES.has(type as DurableExecutionEventTypeV1)) return invalid();
    const parsed = {
      schemaVersion: 1 as const,
      executionId: id(raw.get("executionId")),
      sequence: safeInteger(raw.get("sequence"), 1),
      attempt: safeInteger(raw.get("attempt")),
      type: type as DurableExecutionEventTypeV1,
      at: safeInteger(raw.get("at")),
      payload: parsePayload(type as DurableExecutionEventTypeV1, raw.get("payload")),
    };
    return Object.freeze(parsed) as DurableExecutionEventV1;
  } catch {
    return invalid();
  }
}
