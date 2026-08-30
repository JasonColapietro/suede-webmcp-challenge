import type { DurableExecutionOwnerView } from "./repository";
import type { DurableExecutionEventV1, DurableExecutionProjection, DurableJsonValue } from "./types";

const ID_MAX = 512;
const KEY_MAX_BYTES = 128;
const JSON_MAX_BYTES = 256 * 1024;
const JSON_MAX_DEPTH = 24;
const JSON_MAX_ENTRIES = 20_000;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type DurableRunBody = Readonly<{
  flowVersionId: string;
  triggerInput?: Readonly<Record<string, DurableJsonValue>>;
  runVariables?: Readonly<Record<string, DurableJsonValue>>;
}>;

export type DurableActionBody = Readonly<{ action: "cancel" | "pause" | "resume" | "retry" }>;

export const PRIVATE_JSON_HEADERS = Object.freeze({ "cache-control": "private, no-store" });
export const PRIVATE_SSE_HEADERS = Object.freeze({
  "cache-control": "private, no-store, no-transform",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
});

export function privateJson(body: Readonly<object>, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "private, no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function durableError(status: 400 | 401 | 403 | 404 | 409 | 415 | 422 | 503): Response {
  const messages = {
    400: "invalid request", 401: "authentication required", 403: "forbidden",
    404: "not found", 409: "conflict", 415: "unsupported media type",
    422: "graph is not eligible for durable execution", 503: "durable runtime unavailable",
  } as const;
  return privateJson({ error: messages[status] }, status);
}

export function isCanonicalOpaqueId(value: unknown, maximum = ID_MAX): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) && !UNSAFE_KEYS.has(value);
}

export function isCanonicalIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= KEY_MAX_BYTES &&
    value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validateMutationHeaders(request: Request): 403 | 415 | null {
  if (request.headers.has("authorization")) return 403;
  const origin = request.headers.get("origin");
  let expected: string;
  try { expected = new URL(request.url).origin; } catch { return 403; }
  if (origin === null || origin !== expected) return 403;
  if (request.headers.has("content-encoding")) return 415;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" ? null : 415;
}

function exactObject(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key) || UNSAFE_KEYS.has(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}

function cloneJson(value: unknown, depth: number, state: { entries: number; ancestors: Set<object> }): DurableJsonValue {
  if (depth > JSON_MAX_DEPTH) throw new TypeError("invalid json");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 65_536) throw new TypeError("invalid json");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || state.ancestors.has(value)) throw new TypeError("invalid json");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("invalid json");
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || Reflect.ownKeys(value).length !== length + 1) throw new TypeError("invalid json");
      state.entries += length;
      if (state.entries > JSON_MAX_ENTRIES) throw new TypeError("invalid json");
      return Array.from({ length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("invalid json");
        return cloneJson(descriptor.value, depth + 1, state);
      });
    }
    if (!exactObject(value, Reflect.ownKeys(value).filter((key): key is string => typeof key === "string"))) throw new TypeError("invalid json");
    const keys = Reflect.ownKeys(value) as string[];
    state.entries += keys.length;
    if (state.entries > JSON_MAX_ENTRIES) throw new TypeError("invalid json");
    const result: Record<string, DurableJsonValue> = {};
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      result[key] = cloneJson(descriptor.value, depth + 1, state);
    }
    return result;
  } finally { state.ancestors.delete(value); }
}

function jsonRecord(value: unknown): Readonly<Record<string, DurableJsonValue>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!exactObject(value, Reflect.ownKeys(value).filter((key): key is string => typeof key === "string"))) return null;
  try {
    const cloned = cloneJson(value, 0, { entries: 0, ancestors: new Set() });
    const json = JSON.stringify(cloned);
    if (Buffer.byteLength(json, "utf8") > JSON_MAX_BYTES) return null;
    return Object.freeze(cloned as Record<string, DurableJsonValue>);
  } catch { return null; }
}

export function parseDurableRunBody(value: unknown): DurableRunBody | null {
  if (!exactObject(value, ["flowVersionId", "triggerInput", "runVariables"])) return null;
  const version = Object.getOwnPropertyDescriptor(value, "flowVersionId")?.value;
  if (!isCanonicalOpaqueId(version) || version.toLowerCase() === "draft") return null;
  const triggerRaw = Object.getOwnPropertyDescriptor(value, "triggerInput")?.value;
  const variablesRaw = Object.getOwnPropertyDescriptor(value, "runVariables")?.value;
  const triggerInput = triggerRaw === undefined ? undefined : jsonRecord(triggerRaw);
  const runVariables = variablesRaw === undefined ? undefined : jsonRecord(variablesRaw);
  if ((triggerRaw !== undefined && !triggerInput) || (variablesRaw !== undefined && !runVariables)) return null;
  return Object.freeze({ flowVersionId: version, ...(triggerInput ? { triggerInput } : {}), ...(runVariables ? { runVariables } : {}) });
}

export function parseDurableActionBody(value: unknown): DurableActionBody | null {
  if (!exactObject(value, ["action"])) return null;
  const action = Object.getOwnPropertyDescriptor(value, "action")?.value;
  return ["cancel", "pause", "resume", "retry"].includes(action) ? Object.freeze({ action }) as DurableActionBody : null;
}

export async function readBoundedJson(request: Request): Promise<unknown | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > JSON_MAX_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (request.signal.aborted) { try { void reader.cancel(); } catch {} return null; }
      const pending = reader.read();
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      });
      const part = await Promise.race([pending, aborted]);
      if (onAbort) request.signal.removeEventListener("abort", onAbort);
      if (part === null) { void pending.catch(() => undefined); try { void reader.cancel(); } catch {} return null; }
      if (part.done) break;
      total += part.value.byteLength;
      if (total > JSON_MAX_BYTES) { void reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { try { void reader.cancel(); } catch {} return null; }
}

export function parseEventCursor(request: Request): number | null | "invalid" {
  let url: URL;
  try { url = new URL(request.url); } catch { return "invalid"; }
  const values = url.searchParams.getAll("after");
  if (values.length > 1 || [...url.searchParams.keys()].some((key) => key !== "after")) return "invalid";
  const query = values[0];
  const header = request.headers.get("last-event-id") ?? undefined;
  const parse = (value: string | undefined): number | undefined => value === undefined ? undefined : /^(?:0|[1-9]\d{0,15})$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  const q = parse(query); const h = parse(header);
  if ((query !== undefined && q === undefined) || (header !== undefined && h === undefined) || (q !== undefined && h !== undefined && q !== h)) return "invalid";
  return q ?? h ?? 0;
}

export type PublicDurableProjection = Omit<DurableExecutionProjection, "definitionHash">;

export function publicDurableProjection(projection: DurableExecutionProjection): PublicDurableProjection {
  const { definitionHash: _internalHash, ...safe } = projection;
  return safe;
}

export function publicDurableExecutionView(view: DurableExecutionOwnerView): Omit<DurableExecutionOwnerView, "projection"> & Readonly<{ projection: PublicDurableProjection }> {
  return Object.freeze({
    executionId: view.executionId, flowId: view.flowId, flowVersionId: view.flowVersionId,
    parentExecutionId: view.parentExecutionId, createdAt: view.createdAt, updatedAt: view.updatedAt,
    finishedAt: view.finishedAt, deadlineAt: view.deadlineAt,
    projection: publicDurableProjection(view.projection),
  });
}

export function sseEventFrame(event: DurableExecutionEventV1): string {
  return `id: ${event.sequence}\nevent: durable-execution-event\ndata: ${JSON.stringify(event)}\n\n`;
}
