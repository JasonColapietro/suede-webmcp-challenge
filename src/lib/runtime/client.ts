/** Browser-only durable runtime contracts. Keep this module free of server imports. */

export type DurableClientState = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | "dead";
export type DurableClientDesiredState = "running" | "paused" | "cancelled";
export type DurableClientAction = "cancel" | "pause" | "resume" | "retry";
export type DurableClientJson = null | boolean | number | string | readonly DurableClientJson[] | { readonly [key: string]: DurableClientJson };

export interface DurableClientEvent {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly type: string;
  readonly at: number;
  readonly payload: Readonly<Record<string, DurableClientJson>>;
}

export interface DurableClientProjection {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly sequence: number;
  readonly state: DurableClientState;
  readonly desiredState: DurableClientDesiredState;
  readonly attempt: number;
  readonly jobId: string | null;
  readonly attemptId: string | null;
  readonly costMicroUsdc: number;
  readonly tokens: number;
  readonly output: DurableClientJson | null;
  readonly error: string | null;
  readonly nodes: Readonly<Record<string, Readonly<{ state: "running" | "completed" | "failed"; attempt: number; output: DurableClientJson | null; error: string | null }>>>;
  readonly logs: readonly Readonly<{ sequence: number; nodeId: string; level: "info" | "warn" | "error"; message: string }>[];
  readonly logCount: number;
  readonly controlRequests: readonly Readonly<{ sequence: number; action: "cancel" | "pause" | "resume" }>[];
  readonly controlRequestCount: number;
  readonly retry: Readonly<{ attempt: number; availableAt: number; error: string }> | null;
  readonly deadLetter: Readonly<{ attempt: number; error: string }> | null;
}

export interface DurableClientRun {
  readonly executionId: string;
  readonly flowId: string;
  readonly flowVersionId: string;
  readonly parentExecutionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  readonly deadlineAt: number | null;
  readonly projection: DurableClientProjection;
}

export interface DurableEnqueueEnvelope {
  readonly runId: string;
  readonly state: DurableClientState;
  readonly statusUrl: string;
  readonly eventsUrl: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const STATES = new Set<DurableClientState>(["queued", "running", "paused", "succeeded", "failed", "cancelled", "dead"]);
const DESIRED = new Set<DurableClientDesiredState>(["running", "paused", "cancelled"]);
const EVENTS = new Set(["execution.created", "job.enqueued", "job.claimed", "attempt.started", "node.started", "node.logged", "node.completed", "node.failed", "control.requested", "attempt.retry_scheduled", "execution.paused", "execution.resumed", "execution.cancelled", "execution.succeeded", "execution.failed", "execution.dead_lettered"]);
const JSON_LIMIT = 512 * 1024;
const ENQUEUE_BODY_LIMIT = 256 * 1024;
const EVENT_LIMIT = 256 * 1024;
const EVENT_BUFFER_LIMIT = 512 * 1024;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}));
}
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function nullableInteger(value: unknown): value is number | null { return value === null || integer(value); }
function utf8Text(value: unknown, bytes: number, allowEmpty = true): value is string { return typeof value === "string" && (allowEmpty || value.length > 0) && new TextEncoder().encode(value).byteLength <= bytes; }
function dataArray(value: unknown, maximum: number, parse: (entry: unknown) => boolean): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(value).length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || !parse(descriptor.value)) return false;
  }
  return true;
}
function hasMediaType(headers: Headers, expected: string): boolean {
  const raw = headers.get("content-type"); if (!raw || /[\r\n]/u.test(raw)) return false;
  const [base, ...parameters] = raw.split(";");
  return base?.trim().toLowerCase() === expected && parameters.every((parameter) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n]*")$/u.test(parameter.trim()));
}
function json(value: unknown, depth = 0, count = { value: 0 }): value is DurableClientJson {
  if (depth > 32 || ++count.value > 10_000) return false;
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return true;
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength <= 65_536;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000 || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor) || !json(descriptor.value, depth + 1, count)) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    return typeof key === "string" && key !== "__proto__" && key !== "constructor" && key !== "prototype" && descriptor?.enumerable === true && "value" in descriptor && json(descriptor.value, depth + 1, count);
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

function encodedJsonBytes(value: unknown, limit: number): number {
  const encoder = new TextEncoder();
  let total = 0;
  let count = 0;
  const add = (amount: number): boolean => { total += amount; return total <= limit; };
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > 32 || ++count > 10_000) return false;
    if (current === null) return add(4);
    if (typeof current === "boolean") return add(current ? 4 : 5);
    if (typeof current === "number") return Number.isFinite(current) && add(encoder.encode(JSON.stringify(current)).byteLength);
    if (typeof current === "string") {
      if (encoder.encode(current).byteLength > 65_536) return false;
      return add(encoder.encode(JSON.stringify(current)).byteLength);
    }
    if (!current || typeof current !== "object") return false;
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || current.length > 10_000 || Reflect.ownKeys(current).length !== current.length + 1) return false;
      if (!add(2)) return false;
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor) || (index > 0 && !add(1)) || !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(current);
    if (!add(2)) return false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") return false;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || (index > 0 && !add(1)) ||
        !add(encoder.encode(JSON.stringify(key)).byteLength + 1) ||
        !visit(descriptor.value, depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0) ? total : limit + 1;
}

function parseNode(value: unknown): DurableClientProjection["nodes"][string] | null {
  if (!exact(value, ["state", "attempt", "output", "error"]) || !["running", "completed", "failed"].includes(String(value.state)) || !integer(value.attempt) || !json(value.output) || !(value.error === null || utf8Text(value.error, 8 * 1024, false))) return null;
  return freeze(value as unknown as DurableClientProjection["nodes"][string]);
}

export function parseDurableProjection(value: unknown): DurableClientProjection | null {
  const keys = ["schemaVersion", "executionId", "sequence", "state", "desiredState", "attempt", "jobId", "attemptId", "costMicroUsdc", "tokens", "output", "error", "nodes", "logs", "logCount", "controlRequests", "controlRequestCount", "retry", "deadLetter"];
  if (!exact(value, keys) || value.schemaVersion !== 1 || !id(value.executionId) || !integer(value.sequence) || !STATES.has(value.state as DurableClientState) || !DESIRED.has(value.desiredState as DurableClientDesiredState) || !integer(value.attempt) || !(value.jobId === null || id(value.jobId)) || !(value.attemptId === null || id(value.attemptId)) || !integer(value.costMicroUsdc) || !integer(value.tokens) || !json(value.output) || !(value.error === null || utf8Text(value.error, 8 * 1024, false))) return null;
  if (!value.nodes || typeof value.nodes !== "object" || Array.isArray(value.nodes) || Object.getPrototypeOf(value.nodes) !== Object.prototype || Reflect.ownKeys(value.nodes).length > 2_000) return null;
  for (const key of Reflect.ownKeys(value.nodes)) if (typeof key !== "string" || !id(key) || !parseNode(Object.getOwnPropertyDescriptor(value.nodes, key)?.value)) return null;
  if (!dataArray(value.logs, 1_000, (log) => exact(log, ["sequence", "nodeId", "level", "message"]) && integer(log.sequence) && id(log.nodeId) && ["info", "warn", "error"].includes(String(log.level)) && utf8Text(log.message, 16 * 1024, false))) return null;
  if (!integer(value.logCount) || !dataArray(value.controlRequests, 1_000, (request) => exact(request, ["sequence", "action"]) && integer(request.sequence) && ["cancel", "pause", "resume"].includes(String(request.action))) || !integer(value.controlRequestCount)) return null;
  if (!(value.retry === null || (exact(value.retry, ["attempt", "availableAt", "error"]) && integer(value.retry.attempt) && integer(value.retry.availableAt) && utf8Text(value.retry.error, 8 * 1024, false))) || !(value.deadLetter === null || (exact(value.deadLetter, ["attempt", "error"]) && integer(value.deadLetter.attempt) && utf8Text(value.deadLetter.error, 8 * 1024, false)))) return null;
  return freeze(value as unknown as DurableClientProjection);
}

export function parseDurableEnqueueEnvelope(value: unknown): DurableEnqueueEnvelope | null {
  if (!exact(value, ["runId", "state", "statusUrl", "eventsUrl"]) || !id(value.runId) || !STATES.has(value.state as DurableClientState)) return null;
  const statusUrl = `/api/v3/runs/${encodeURIComponent(value.runId)}`;
  if (value.statusUrl !== statusUrl || value.eventsUrl !== `${statusUrl}/events`) return null;
  return freeze(value as unknown as DurableEnqueueEnvelope);
}

export function parseDurableRun(value: unknown): DurableClientRun | null {
  if (!exact(value, ["executionId", "flowId", "flowVersionId", "parentExecutionId", "createdAt", "updatedAt", "finishedAt", "deadlineAt", "projection"]) || !id(value.executionId) || !id(value.flowId) || !id(value.flowVersionId) || !(value.parentExecutionId === null || id(value.parentExecutionId)) || !integer(value.createdAt) || !integer(value.updatedAt) || !nullableInteger(value.finishedAt) || !nullableInteger(value.deadlineAt)) return null;
  const projection = parseDurableProjection(value.projection);
  if (!projection || projection.executionId !== value.executionId) return null;
  return freeze({ ...value, projection } as unknown as DurableClientRun);
}

export function parseDurableRunEnvelope(value: unknown): Readonly<{ run: DurableClientRun }> | null {
  if (!exact(value, ["run"])) return null;
  const run = parseDurableRun(value.run);
  return run ? freeze({ run }) : null;
}

function validEventPayload(type: string, payload: Record<string, unknown>): boolean {
  const text = (value: unknown, max = 16_384) => typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= max;
  const output = (value: unknown) => json(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 128 * 1024;
  switch (type) {
    case "execution.created": return exact(payload, ["definitionHash"]) && typeof payload.definitionHash === "string" && /^[a-f0-9]{64}$/u.test(payload.definitionHash);
    case "job.enqueued": return exact(payload, ["jobId", "priority", "availableAt"]) && id(payload.jobId) && integer(payload.priority) && integer(payload.availableAt);
    case "job.claimed": return exact(payload, ["jobId", "attemptId", "workerId", "leaseExpiresAt"]) && id(payload.jobId) && id(payload.attemptId) && id(payload.workerId) && integer(payload.leaseExpiresAt);
    case "attempt.started": return exact(payload, ["attemptId"]) && id(payload.attemptId);
    case "node.started": return exact(payload, ["nodeId"]) && id(payload.nodeId);
    case "node.logged": return exact(payload, ["nodeId", "level", "message"]) && id(payload.nodeId) && ["info", "warn", "error"].includes(String(payload.level)) && text(payload.message);
    case "node.completed": return exact(payload, ["nodeId", "output", "costMicroUsdc", "tokens"]) && id(payload.nodeId) && output(payload.output) && integer(payload.costMicroUsdc) && integer(payload.tokens);
    case "node.failed": return exact(payload, ["nodeId", "error"]) && id(payload.nodeId) && text(payload.error, 8_192);
    case "control.requested": return exact(payload, ["action"]) && ["cancel", "pause", "resume"].includes(String(payload.action));
    case "attempt.retry_scheduled": return exact(payload, ["attemptId", "error", "availableAt"]) && id(payload.attemptId) && text(payload.error, 8_192) && integer(payload.availableAt);
    case "execution.paused": case "execution.resumed": return exact(payload, []);
    case "execution.cancelled": return exact(payload, ["reason"]) && text(payload.reason, 8_192);
    case "execution.succeeded": return exact(payload, ["output", "costMicroUsdc", "tokens"]) && output(payload.output) && integer(payload.costMicroUsdc) && integer(payload.tokens);
    case "execution.failed": return exact(payload, ["error", "costMicroUsdc", "tokens"]) && text(payload.error, 8_192) && integer(payload.costMicroUsdc) && integer(payload.tokens);
    case "execution.dead_lettered": return exact(payload, ["error"]) && text(payload.error, 8_192);
    default: return false;
  }
}

export type DurableActionEnvelope =
  | Readonly<{ action: "cancel" | "pause" | "resume"; run: DurableClientProjection }>
  | Readonly<{ action: "retry"; runId: string; state: DurableClientState; statusUrl: string; eventsUrl: string }>;

export function parseDurableActionEnvelope(value: unknown): DurableActionEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = Object.getOwnPropertyDescriptor(value, "action")?.value;
  if (action === "retry") {
    if (!exact(value, ["action", "runId", "state", "statusUrl", "eventsUrl"])) return null;
    const enqueue = parseDurableEnqueueEnvelope({ runId: value.runId, state: value.state, statusUrl: value.statusUrl, eventsUrl: value.eventsUrl });
    return enqueue ? freeze({ action, ...enqueue }) : null;
  }
  if (!["cancel", "pause", "resume"].includes(String(action)) || !exact(value, ["action", "run"])) return null;
  const run = parseDurableProjection(Object.getOwnPropertyDescriptor(value, "run")?.value);
  return run ? freeze({ action, run } as DurableActionEnvelope) : null;
}

export function parseDurableEvent(value: unknown): DurableClientEvent | null {
  if (!exact(value, ["schemaVersion", "executionId", "sequence", "attempt", "type", "at", "payload"]) || value.schemaVersion !== 1 || !id(value.executionId) || !integer(value.sequence) || value.sequence < 1 || !integer(value.attempt) || !EVENTS.has(String(value.type)) || !integer(value.at) || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload) || Object.getPrototypeOf(value.payload) !== Object.prototype || !validEventPayload(String(value.type), value.payload as Record<string, unknown>)) return null;
  return freeze(value as unknown as DurableClientEvent);
}

export function durableActionAvailability(state: DurableClientState, desired: DurableClientDesiredState): readonly DurableClientAction[] {
  if ((state === "cancelled" && desired === "cancelled") || (["succeeded", "failed", "dead"].includes(state) && desired === "running")) return ["retry"];
  if (["succeeded", "failed", "cancelled", "dead"].includes(state)) return [];
  if (desired === "cancelled") return [];
  if ((state === "queued" || state === "running") && desired === "running") return ["pause", "cancel"];
  if ((state === "queued" || state === "running") && desired === "paused") return ["cancel"];
  if (state === "paused" && desired === "paused") return ["resume", "cancel"];
  return [];
}

export async function readBoundedDurableJson(response: Response, signal?: AbortSignal): Promise<unknown | null> {
  if (!hasMediaType(response.headers, "application/json")) { void response.body?.cancel(); return null; }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > JSON_LIMIT)) { void response.body?.cancel(); return null; }
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return null;
      const pending = reader.read();
      const part = signal ? await Promise.race([pending, new Promise<null>((resolve) => {
        const stop = () => resolve(null); signal.addEventListener("abort", stop, { once: true });
        pending.finally(() => signal.removeEventListener("abort", stop)).catch(() => undefined);
      })]) : await pending;
      if (part === null) { void reader.cancel(); return null; }
      if (part.done) break;
      total += part.value.byteLength; if (total > JSON_LIMIT) { void reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { return null; } finally { signal?.removeEventListener("abort", abort); }
}

export async function readDurableEventStream(input: { readonly response: Response; readonly runId: string; readonly after: number; readonly signal?: AbortSignal; readonly onEvent: (event: DurableClientEvent) => void }): Promise<number> {
  if (!input.response.ok || !input.response.body || !hasMediaType(input.response.headers, "text/event-stream") || !id(input.runId) || !integer(input.after)) { void input.response.body?.cancel(); throw new TypeError("invalid durable event stream"); }
  const reader = input.response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = ""; let cursor = input.after; let count = 0; let totalBytes = 0;
  const abort = () => { void reader.cancel(); }; input.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!input.signal?.aborted) {
      const part = await reader.read(); if (part.done) { buffer += decoder.decode(); break; }
      totalBytes += part.value.byteLength;
      if (totalBytes > EVENT_BUFFER_LIMIT) throw new TypeError("invalid durable event stream");
      buffer += decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/gu, "\n");
      if (buffer.length > EVENT_BUFFER_LIMIT) throw new TypeError("invalid durable event stream");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (new TextEncoder().encode(frame).byteLength > EVENT_LIMIT) throw new TypeError("invalid durable event stream");
        const lines = frame.split("\n");
        if (lines.length !== 3 || !lines[0]?.startsWith("id: ") || lines[1] !== "event: durable-execution-event" || !lines[2]?.startsWith("data: ")) throw new TypeError("invalid durable event stream");
        const event = parseDurableEvent(JSON.parse(lines[2].slice(6)) as unknown); const sequence = Number(lines[0].slice(4));
        if (!event || sequence !== event.sequence || event.executionId !== input.runId || sequence !== cursor + 1 || ++count > 1_000) throw new TypeError("invalid durable event stream");
        input.onEvent(event); cursor = sequence; index = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim() !== "") throw new TypeError("invalid durable event stream");
    return cursor;
  } catch (error) { try { await reader.cancel(); } catch {} throw error; }
  finally { input.signal?.removeEventListener("abort", abort); if (input.signal?.aborted) void reader.cancel(); }
}

export function durableRunUrls(runId: string): Readonly<{ status: string; events: string; actions: string }> {
  if (!id(runId)) throw new TypeError("invalid run id");
  const status = `/api/v3/runs/${encodeURIComponent(runId)}`;
  return freeze({ status, events: `${status}/events`, actions: `${status}/actions` });
}

export type DurableEnqueueResult = Readonly<{ status: "accepted"; receipt: DurableEnqueueEnvelope }> | Readonly<{ status: "not-admitted" }> | Readonly<{ status: "rejected" }> | Readonly<{ status: "error" }>;

export async function enqueueDurableRun(input: {
  readonly flowId: string;
  readonly flowVersionId: string;
  readonly triggerInput: Readonly<Record<string, unknown>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly createId?: () => string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}): Promise<DurableEnqueueResult> {
  if (!id(input.flowId) || !id(input.flowVersionId)) return { status: "rejected" };
  const requestBody = { flowVersionId: input.flowVersionId, triggerInput: input.triggerInput } as const;
  if (encodedJsonBytes(requestBody, ENQUEUE_BODY_LIMIT) > ENQUEUE_BODY_LIMIT || !json(input.triggerInput)) return { status: "rejected" };
  const createId = input.createId ?? (() => {
    if (!globalThis.crypto?.randomUUID) throw new TypeError("random UUID unavailable");
    return globalThis.crypto.randomUUID();
  });
  try {
    const key = input.idempotencyKey ?? createId(); if (!id(key)) return { status: "rejected" };
    const response = await (input.fetch ?? globalThis.fetch)(`/api/v3/flows/${encodeURIComponent(input.flowId)}/runs`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(requestBody), signal: input.signal,
    });
    if (response.status === 422) return { status: "not-admitted" };
    if (response.status !== 202) {
      const definitiveClientRefusal = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      return definitiveClientRefusal ? { status: "rejected" } : { status: "error" };
    }
    const receipt = parseDurableEnqueueEnvelope(await readBoundedDurableJson(response, input.signal));
    return receipt ? { status: "accepted", receipt } : { status: "error" };
  } catch { return { status: "error" }; }
}
