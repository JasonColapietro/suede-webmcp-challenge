import {
  parseConnectionCreateInput,
  parseConnectionSecretInput,
  parseConnectionView,
  type ConnectionCreateInput,
  type ConnectionEnvironment,
  type ConnectionSecretInput,
  type ConnectionView,
} from "./types";
import type {
  ConnectionListPage,
  ConnectionUsageItem,
} from "./repository";

export const CONNECTION_BODY_LIMIT_BYTES = 64 * 1024;

export type CreateBody = ConnectionCreateInput;
export interface RenameBody { readonly name: string; readonly expectedLifecycleRevision: number }
export interface ConfigureSlotBody { readonly expectedLifecycleRevision: number; readonly secret: ConnectionSecretInput }
export interface ConnectionEnvelope { readonly connection: ConnectionView }
export interface ConnectionListEnvelope { readonly connections: readonly ConnectionView[]; readonly nextCursor: string | null }
export interface UsageEnvelope {
  readonly usage: readonly ConnectionUsageItem[];
  readonly nextCursor: string | null;
  readonly matchedLowerBound: number;
  readonly truncated: boolean;
  readonly lifecycleRevision: number;
}
export type PrivateError =
  | "invalid request"
  | "authentication required"
  | "not found"
  | "conflict"
  | "payload too large"
  | "unsupported media type"
  | "connection service unavailable";
export interface PrivateErrorEnvelope { readonly error: PrivateError }

export const CONNECTION_API_STATUS = Object.freeze({
  create: 201, firstSlotConfigure: 201, list: 200, get: 200, rename: 200,
  rotate: 200, reconfigure: 200, revoke: 200, usage: 200,
});
export const PRIVATE_ERROR_STATUS = Object.freeze({
  "invalid request": 400,
  "authentication required": 401,
  "not found": 404,
  conflict: 409,
  "payload too large": 413,
  "unsupported media type": 415,
  "connection service unavailable": 503,
} satisfies Record<PrivateError, number>);

const MAX_CURSOR_CHARACTERS = 4_096;
const MAX_RESPONSE_ITEMS = 100;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const CURSOR_ID = /^[A-Za-z0-9._:-]+$/u;
const FORBIDDEN_RESPONSE_KEYS = new Set([
  "apikey", "authtag", "authorization", "ciphertext", "headers", "keyversion",
  "nonce", "password", "secret", "token", "username", "values",
]);

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function safeInteger(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && (allowZero ? (value as number) >= 0 : (value as number) >= 1);
}

export type ConnectionCursorKind = "list" | "usage";

function canonicalCursorRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CURSOR_CHARACTERS || !CURSOR.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return null;
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url") !== value) return null;
    return exactRecord(parsed, Object.keys(parsed as object));
  } catch {
    return null;
  }
}

function boundedCursorId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && CURSOR_ID.test(value);
}

function boundedUsageId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && [...value].length <= 256;
}

function encodesExactCursor(value: unknown, payload: Record<string, unknown>): boolean {
  return typeof value === "string" &&
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") === value;
}

function safeCursor(value: unknown, kind: ConnectionCursorKind): value is string | null {
  if (value === null) return true;
  const record = canonicalCursorRecord(value);
  if (!record) return false;
  if (kind === "list") {
    const exact = exactRecord(record, ["updatedAt", "id"]);
    return exact !== null && safeInteger(exact.updatedAt, true) && boundedCursorId(exact.id) &&
      encodesExactCursor(value, { updatedAt: exact.updatedAt, id: exact.id });
  }
  const exact = exactRecord(record, [
    "artifactKind", "sortAt", "flowId", "flowVersionId", "environment",
  ]);
  if (!exact || !safeInteger(exact.sortAt, true) || !boundedUsageId(exact.flowId)) return false;
  if (exact.artifactKind === "draft") {
    if (exact.flowVersionId !== null || exact.environment !== "draft") return false;
  } else if (exact.artifactKind === "active_deployment") {
    if (!boundedUsageId(exact.flowVersionId) ||
        (exact.environment !== "test" && exact.environment !== "live")) return false;
  } else {
    return false;
  }
  return encodesExactCursor(value, {
    artifactKind: exact.artifactKind,
    sortAt: exact.sortAt,
    flowId: exact.flowId,
    flowVersionId: exact.flowVersionId,
    environment: exact.environment,
  });
}

function recursivelySecretFree(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.depth > 32 || ++visited > 10_000 || seen.has(current.value)) return false;
    seen.add(current.value);
    try {
      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(current.value).length !== 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      if (Array.isArray(current.value)) {
        const allowed = new Set([...current.value.keys()].map(String).concat("length"));
        if (Object.keys(descriptors).some((key) => !allowed.has(key)) ||
            [...current.value.keys()].some((index) => !Object.hasOwn(descriptors, String(index)))) return false;
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length" && Array.isArray(current.value)) continue;
        if (!("value" in descriptor) || !descriptor.enumerable || FORBIDDEN_RESPONSE_KEYS.has(key.toLowerCase())) return false;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function parseCreateBody(value: unknown): CreateBody | null {
  try { return parseConnectionCreateInput(value); } catch { return null; }
}

export function parseRenameBody(value: unknown): RenameBody | null {
  const record = exactRecord(value, ["name", "expectedLifecycleRevision"]);
  if (!record || !safeInteger(record.expectedLifecycleRevision)) return null;
  try {
    const parsed = parseConnectionCreateInput({ name: record.name, kind: "bearer", publicConfig: {} });
    return Object.freeze({ name: parsed.name, expectedLifecycleRevision: record.expectedLifecycleRevision });
  } catch {
    return null;
  }
}

export function parseConfigureSlotBody(value: unknown): ConfigureSlotBody | null {
  const record = exactRecord(value, ["expectedLifecycleRevision", "secret"]);
  if (!record || !safeInteger(record.expectedLifecycleRevision)) return null;
  try {
    return Object.freeze({
      expectedLifecycleRevision: record.expectedLifecycleRevision,
      secret: parseConnectionSecretInput(record.secret),
    });
  } catch {
    return null;
  }
}

export function parseConnectionEnvironmentPath(value: unknown): ConnectionEnvironment | null {
  return value === "test" || value === "live" ? value : null;
}

export function parseConnectionListPage(
  value: URLSearchParams,
  kind: ConnectionCursorKind,
): ConnectionListPage | null {
  const keys = [...value.keys()];
  if (keys.some((key) => key !== "cursor" && key !== "limit")) return null;
  if (value.getAll("cursor").length > 1 || value.getAll("limit").length > 1) return null;
  const cursor = value.get("cursor");
  if (cursor !== null && !safeCursor(cursor, kind)) return null;
  const rawLimit = value.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(rawLimit)) return null;
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  return Object.freeze({ ...(cursor === null ? {} : { cursor }), limit });
}

export function parseConnectionEnvelope(value: unknown): ConnectionEnvelope | null {
  if (!recursivelySecretFree(value)) return null;
  const record = exactRecord(value, ["connection"]);
  if (!record) return null;
  try { return Object.freeze({ connection: parseConnectionView(record.connection) }); } catch { return null; }
}

export function parseConnectionListEnvelope(value: unknown): ConnectionListEnvelope | null {
  if (!recursivelySecretFree(value)) return null;
  const record = exactRecord(value, ["connections", "nextCursor"]);
  if (!record || !Array.isArray(record.connections) || record.connections.length > MAX_RESPONSE_ITEMS || !safeCursor(record.nextCursor, "list")) return null;
  try {
    return Object.freeze({
      connections: Object.freeze(record.connections.map((item) => parseConnectionView(item))),
      nextCursor: record.nextCursor,
    });
  } catch {
    return null;
  }
}

function parseUsageItem(value: unknown): ConnectionUsageItem | null {
  const record = exactRecord(value, [
    "artifactKind", "flowId", "flowName", "flowVersionId", "environment", "updatedAt",
  ]);
  if (!record || !boundedUsageId(record.flowId) ||
      typeof record.flowName !== "string" || Buffer.byteLength(record.flowName, "utf8") > 200 ||
      !safeInteger(record.updatedAt, true)) return null;
  if (record.artifactKind === "draft") {
    if (record.flowVersionId !== null || record.environment !== "draft") return null;
  } else if (record.artifactKind === "active_deployment") {
    if (!boundedUsageId(record.flowVersionId) ||
        (record.environment !== "test" && record.environment !== "live")) return null;
  } else return null;
  return Object.freeze(record as unknown as ConnectionUsageItem);
}

export function parseUsageEnvelope(value: unknown): UsageEnvelope | null {
  if (!recursivelySecretFree(value)) return null;
  const record = exactRecord(value, [
    "usage", "nextCursor", "matchedLowerBound", "truncated", "lifecycleRevision",
  ]);
  if (!record || !Array.isArray(record.usage) || record.usage.length > MAX_RESPONSE_ITEMS ||
      !safeCursor(record.nextCursor, "usage") || !safeInteger(record.matchedLowerBound, true) ||
      typeof record.truncated !== "boolean" || !safeInteger(record.lifecycleRevision)) return null;
  const usage = record.usage.map(parseUsageItem);
  if (usage.some((item) => item === null) || record.matchedLowerBound < usage.length) return null;
  return Object.freeze({
    usage: Object.freeze(usage as ConnectionUsageItem[]),
    nextCursor: record.nextCursor,
    matchedLowerBound: record.matchedLowerBound,
    truncated: record.truncated,
    lifecycleRevision: record.lifecycleRevision,
  });
}

export function parsePrivateErrorEnvelope(value: unknown): PrivateErrorEnvelope | null {
  const record = exactRecord(value, ["error"]);
  if (!record || typeof record.error !== "string" || !Object.hasOwn(PRIVATE_ERROR_STATUS, record.error)) return null;
  return Object.freeze({ error: record.error as PrivateError });
}

type PreflightFailure = { readonly ok: false; readonly status: number; readonly error: PrivateErrorEnvelope };
type PreflightBase<Provider> = { readonly ok: true; readonly ownerId: string; readonly provider: Provider };

function failure(error: PrivateError): PreflightFailure {
  return Object.freeze({ ok: false, status: PRIVATE_ERROR_STATUS[error], error: Object.freeze({ error }) });
}

function requestOrigin(request: Request): string | null {
  try { return new URL(request.url).origin; } catch { return null; }
}

function requestShapeFailure(request: Request, mutation: boolean): PreflightFailure | null {
  if (request.headers.has("authorization")) return failure("invalid request");
  if (mutation) {
    const contentType = request.headers.get("content-type")?.toLowerCase();
    if (contentType !== "application/json" && contentType !== "application/json; charset=utf-8") {
      return failure("unsupported media type");
    }
    const encoding = request.headers.get("content-encoding")?.toLowerCase();
    if (encoding !== undefined && encoding !== "identity") return failure("unsupported media type");
  }
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (mutation && (origin === null || fetchSite === null)) return failure("invalid request");
  if (origin !== null && origin !== requestOrigin(request)) return failure("invalid request");
  if (fetchSite !== null && fetchSite !== "same-origin") return failure("invalid request");
  return null;
}

async function resolvePrivateContext<Provider>(input: {
  readonly resolveOwner: () => Promise<string | null>;
  readonly resolveProvider: () => Promise<Provider | null>;
}): Promise<PreflightBase<Provider> | PreflightFailure> {
  let ownerId: string | null;
  try { ownerId = await input.resolveOwner(); } catch { return failure("authentication required"); }
  if (typeof ownerId !== "string" || ownerId.length === 0) return failure("authentication required");
  let provider: Provider | null;
  try { provider = await input.resolveProvider(); } catch { return failure("connection service unavailable"); }
  if (provider === null || provider === undefined) return failure("connection service unavailable");
  return Object.freeze({ ok: true, ownerId, provider });
}

async function readBoundedJson(
  request: Request,
): Promise<{ readonly ok: true; readonly value: unknown } | PreflightFailure> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) return failure("invalid request");
    if (Number(contentLength) > CONNECTION_BODY_LIMIT_BYTES) return failure("payload too large");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const body = request.body;
    if (!body) return failure("invalid request");
    reader = body.getReader();
  } catch {
    return failure("invalid request");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > CONNECTION_BODY_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return failure("payload too large");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return failure("invalid request");
  } finally {
    try { reader.releaseLock(); } catch { /* fixed response already selected */ }
  }
}

export async function preflightConnectionMutation<Body, Provider>(input: {
  readonly request: Request;
  readonly resolveOwner: () => Promise<string | null>;
  readonly resolveProvider: () => Promise<Provider | null>;
  readonly parseBody: (value: unknown) => Body | null;
}): Promise<(PreflightBase<Provider> & { readonly body: Body }) | PreflightFailure> {
  const shapeFailure = requestShapeFailure(input.request, true);
  if (shapeFailure) return shapeFailure;
  const context = await resolvePrivateContext(input);
  if (!context.ok) return context;
  const decoded = await readBoundedJson(input.request);
  if (!decoded.ok) return decoded;
  let body: Body | null;
  try { body = input.parseBody(decoded.value); } catch { body = null; }
  if (body === null || body === undefined) return failure("invalid request");
  return Object.freeze({ ...context, body });
}

export async function preflightConnectionRead<Provider>(input: {
  readonly request: Request;
  readonly resolveOwner: () => Promise<string | null>;
  readonly resolveProvider: () => Promise<Provider | null>;
}): Promise<PreflightBase<Provider> | PreflightFailure> {
  const shapeFailure = requestShapeFailure(input.request, false);
  if (shapeFailure) return shapeFailure;
  return resolvePrivateContext(input);
}
