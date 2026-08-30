/** Strict browser-only Connector Lab metadata client. Raw OpenAPI source is never retained. */

import {
  CONNECTOR_PRIVATE_ERROR_STATUS,
  parseAddOperationBody,
  parseConnectorEnvelope as parseContractConnectorEnvelope,
  parseConnectorId,
  parseConnectorListEnvelope as parseContractConnectorListEnvelope,
  parseConnectorListPage,
  parseConnectorMutationBody,
  parseConnectorHistoryPage,
  parseConnectorOperationListPage,
  parseConnectorOperationEnvelope as parseContractConnectorOperationEnvelope,
  parseConnectorOperationsEnvelope as parseContractConnectorOperationsEnvelope,
  parseConnectorPrivateErrorEnvelope as parseContractPrivateErrorEnvelope,
  parseOpenApiReviewBody,
  parseOpenApiReviewEnvelope as parseContractOpenApiReviewEnvelope,
  parseOperationClosuresEnvelope as parseContractOperationClosuresEnvelope,
  parseResolveOperationsBody,
  type AddOperationBody,
  type ConnectorEnvelope,
  type ConnectorListEnvelope,
  type ConnectorMutationBody,
  type ConnectorOperationEnvelope,
  type ConnectorOperationsEnvelope,
  type ConnectorPrivateError,
  type ConnectorPrivateErrorEnvelope,
  type OpenApiReviewBody,
  type OpenApiReviewEnvelope,
  type OperationClosuresEnvelope,
} from "./api-contract";
import { createCompileGuard, parseBoundedJson } from "./openapi/json";

const RESPONSE_BYTE_LIMIT = 256 * 1024;
const RESPONSE_DEPTH_LIMIT = 32;
const RESPONSE_VALUE_LIMIT = 10_000;
const RESPONSE_STRING_BYTE_LIMIT = 64 * 1024;
const FORBIDDEN_KEYS = new Set([
  "apikey", "authorization", "authtag", "body", "ciphertext", "default", "defaults",
  "example", "examples", "headers", "keyversion", "nonce", "password", "rawsource",
  "rejectedvalue", "rejectedvalues", "requestbody", "secret", "source", "token", "username", "values",
]);
const CREDENTIAL_SIGNATURES = [
  /(?:^|[^A-Za-z0-9_])Bearer[ \t]+\S+/iu,
  /(?:^|[^A-Za-z0-9_])Basic[ \t]+[A-Za-z0-9+/]+={0,2}(?=$|[^A-Za-z0-9+/=])/iu,
  /(?:^|[^A-Za-z0-9_])(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/iu,
  /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/iu,
  /(?:^|[^A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{8,}/iu,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/iu,
] as const;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectorClientListPage {
  readonly cursor?: string;
  readonly limit?: number;
  readonly search?: string;
  readonly includeArchived?: boolean;
}
export interface ConnectorClientHistoryPage { readonly cursor?: string; readonly limit?: number }
export interface ConnectorClientOperationPage { readonly cursor?: string; readonly limit?: number }
export interface ConnectorChoice {
  readonly id: string;
  readonly label: string;
  readonly archived: boolean;
  readonly lifecycleRevision: number;
}
export interface ConnectorClient {
  list(page?: ConnectorClientListPage, signal?: AbortSignal): Promise<ConnectorListEnvelope>;
  get(connectorId: string, page?: ConnectorClientHistoryPage, signal?: AbortSignal): Promise<ConnectorEnvelope>;
  rename(connectorId: string, input: Extract<ConnectorMutationBody, { action: "rename" }>, signal?: AbortSignal): Promise<Readonly<{ connector: ConnectorEnvelope["connector"] }>>;
  archive(connectorId: string, expectedLifecycleRevision: number, signal?: AbortSignal): Promise<Readonly<{ connector: ConnectorEnvelope["connector"] }>>;
  reviewOpenApi(input: OpenApiReviewBody, signal?: AbortSignal): Promise<OpenApiReviewEnvelope>;
  addOperation(connectorId: string, input: AddOperationBody, signal?: AbortSignal): Promise<ConnectorOperationEnvelope>;
  listOperations(connectorId: string, page?: ConnectorClientOperationPage, signal?: AbortSignal): Promise<ConnectorOperationsEnvelope>;
  resolveOperations(operationVersionIds: readonly string[], signal?: AbortSignal): Promise<OperationClosuresEnvelope>;
}

export class ConnectorClientError extends Error {
  readonly status: number;
  readonly error: ConnectorPrivateError | "request cancelled";
  readonly correlationId?: string;
  constructor(status: number, error: ConnectorPrivateError | "request cancelled", correlationId?: string) {
    super(error);
    this.name = "ConnectorClientError";
    this.status = status;
    this.error = error;
    if (correlationId !== undefined) this.correlationId = correlationId;
  }
}

function invalidRequest(): ConnectorClientError {
  return new ConnectorClientError(CONNECTOR_PRIVATE_ERROR_STATUS["invalid request"], "invalid request");
}

function unavailable(): ConnectorClientError {
  return new ConnectorClientError(0, "connector service unavailable");
}

function secretShaped(value: string): boolean {
  return CREDENTIAL_SIGNATURES.some((signature) => signature.test(value));
}

function structurallySafeJson(value: unknown, canaries: readonly string[] = [], schemaProjection = false): boolean {
  const encoder = new TextEncoder();
  const seen = new WeakSet<object>();
  let count = 0;
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > RESPONSE_DEPTH_LIMIT || ++count > RESPONSE_VALUE_LIMIT) return false;
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string") {
      return encoder.encode(current).byteLength <= RESPONSE_STRING_BYTE_LIMIT && !secretShaped(current) &&
        !canaries.some((canary) => canary.length > 0 && current.includes(canary));
    }
    if (typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    try {
      const prototype = Object.getPrototypeOf(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Object.getOwnPropertySymbols(current).length !== 0) return false;
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype || current.length > RESPONSE_VALUE_LIMIT) return false;
        const allowed = new Set([...current.keys()].map(String).concat("length"));
        if (Object.keys(descriptors).some((key) => !allowed.has(key))) return false;
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !visit(descriptor.value, depth + 1)) return false;
        }
        return true;
      }
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if ((FORBIDDEN_KEYS.has(key.toLowerCase()) && !schemaProjection) ||
            secretShaped(key) || canaries.some((canary) => canary.length > 0 && key.includes(canary)) ||
            !("value" in descriptor) || !descriptor.enumerable || !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } catch { return false; }
  };
  if (!visit(value, 0)) return false;
  try { return encoder.encode(JSON.stringify(value)).byteLength <= RESPONSE_BYTE_LIMIT; } catch { return false; }
}

async function cancelResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* fixed refusal */ }
}

async function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    try { void reader.cancel(); } catch { /* fixed refusal */ }
    return null;
  }
  const pending = reader.read();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => {
      try { void reader.cancel(); } catch { /* fixed refusal */ }
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([pending, aborted]);
    if (result === null) void pending.catch(() => undefined);
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function jsonMediaType(headers: Headers): boolean {
  const raw = headers.get("content-type");
  if (raw === null || /[\r\n]/u.test(raw)) return false;
  const [base, ...parameters] = raw.split(";");
  return base?.trim().toLowerCase() === "application/json" && parameters.every((parameter) =>
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n]*")$/u.test(parameter.trim()));
}

export async function readBoundedConnectorJson(
  response: Response,
  signal?: AbortSignal,
  canaries: readonly string[] = [],
  schemaProjection = false,
  maxBytes = RESPONSE_BYTE_LIMIT,
): Promise<unknown | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > RESPONSE_BYTE_LIMIT) return null;
  if (!jsonMediaType(response.headers)) { await cancelResponse(response); return null; }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maxBytes)) {
    await cancelResponse(response);
    return null;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { if (!response.body) return null; reader = response.body.getReader(); } catch { return null; }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return null;
      const next = await readOrAbort(reader, signal);
      if (next === null) return null;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = parseBoundedJson(bytes, createCompileGuard({
      maxInputBytes: maxBytes,
      maxJsonDepth: RESPONSE_DEPTH_LIMIT,
      maxContainerEntries: RESPONSE_VALUE_LIMIT,
      maxInspectedValues: RESPONSE_VALUE_LIMIT,
    }, signal));
    return structurallySafeJson(parsed, canaries, schemaProjection) ? parsed : null;
  } catch { return null; }
  finally {
    signal?.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { /* fixed refusal */ }
  }
}

export function parseClientConnectorListEnvelope(value: unknown): ConnectorListEnvelope | null {
  return structurallySafeJson(value) ? parseContractConnectorListEnvelope(value) : null;
}
export function parseClientConnectorEnvelope(value: unknown): ConnectorEnvelope | null {
  return structurallySafeJson(value) ? parseContractConnectorEnvelope(value) : null;
}
export function parseClientOpenApiReviewEnvelope(value: unknown): OpenApiReviewEnvelope | null {
  return structurallySafeJson(value) ? parseContractOpenApiReviewEnvelope(value) : null;
}
export function parseClientConnectorOperationEnvelope(value: unknown): ConnectorOperationEnvelope | null {
  return structurallySafeJson(value) ? parseContractConnectorOperationEnvelope(value) : null;
}
export function parseClientConnectorOperationsEnvelope(value: unknown): ConnectorOperationsEnvelope | null {
  return structurallySafeJson(value) ? parseContractConnectorOperationsEnvelope(value) : null;
}
export function parseClientConnectorPrivateErrorEnvelope(value: unknown): ConnectorPrivateErrorEnvelope | null {
  return structurallySafeJson(value) ? parseContractPrivateErrorEnvelope(value) : null;
}
export function parseClientOperationClosuresEnvelope(value: unknown): OperationClosuresEnvelope | null {
  return structurallySafeJson(value, [], true) ? parseContractOperationClosuresEnvelope(value) : null;
}

export function connectorChoices(envelope: ConnectorListEnvelope): readonly ConnectorChoice[] {
  const parsed = parseClientConnectorListEnvelope(envelope);
  if (!parsed) throw unavailable();
  return Object.freeze(parsed.connectors.map((connector) => Object.freeze({
    id: connector.id,
    label: `${connector.displayLabel} · …${connector.id.slice(-6)}`,
    archived: connector.archivedAt !== null,
    lifecycleRevision: connector.lifecycleRevision,
  })));
}

function strictId(value: unknown): string {
  const parsed = parseConnectorId(value);
  if (!parsed) throw invalidRequest();
  return parsed;
}

function listQuery(page: ConnectorClientListPage | undefined): string {
  const params = new URLSearchParams({ limit: String(page?.limit ?? 50) });
  if (page?.cursor !== undefined) params.set("cursor", page.cursor);
  if (page?.search !== undefined) params.set("search", page.search);
  if (page?.includeArchived !== undefined) params.set("includeArchived", String(page.includeArchived));
  if (!parseConnectorListPage(params)) throw invalidRequest();
  return params.toString();
}

function historyQuery(page: ConnectorClientHistoryPage | undefined): string {
  const params = new URLSearchParams({ limit: String(page?.limit ?? 50) });
  if (page?.cursor !== undefined) params.set("cursor", page.cursor);
  if (!parseConnectorHistoryPage(params)) throw invalidRequest();
  return params.toString();
}

function operationQuery(page: ConnectorClientOperationPage | undefined): string {
  const params = new URLSearchParams({ limit: String(page?.limit ?? 50) });
  if (page?.cursor !== undefined) params.set("cursor", page.cursor);
  if (!parseConnectorOperationListPage(params)) throw invalidRequest();
  return params.toString();
}

function mutationInit(method: "POST" | "PATCH", body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
}

function readInit(signal?: AbortSignal): RequestInit {
  return { method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error", signal };
}

async function perform<T>(input: {
  fetcher: FetchLike;
  path: string;
  init: RequestInit;
  successStatuses: readonly number[];
  parse: (value: unknown) => T | null;
  canaries?: readonly string[];
  schemaProjection?: boolean;
}): Promise<T> {
  if (input.init.signal?.aborted) throw new ConnectorClientError(0, "request cancelled");
  let response: Response;
  try { response = await input.fetcher(input.path, input.init); } catch {
    throw input.init.signal?.aborted ? new ConnectorClientError(0, "request cancelled") : unavailable();
  }
  if (input.init.signal?.aborted) {
    await cancelResponse(response);
    throw new ConnectorClientError(0, "request cancelled");
  }
  const value = await readBoundedConnectorJson(response, input.init.signal ?? undefined, input.canaries, input.schemaProjection);
  if (input.init.signal?.aborted) throw new ConnectorClientError(0, "request cancelled");
  if (input.successStatuses.includes(response.status)) {
    const parsed = value === null ? null : input.parse(value);
    if (parsed) return parsed;
    throw unavailable();
  }
  const error = value === null ? null : parseClientConnectorPrivateErrorEnvelope(value);
  if (error && CONNECTOR_PRIVATE_ERROR_STATUS[error.error] === response.status) {
    throw new ConnectorClientError(response.status, error.error, error.correlationId);
  }
  throw unavailable();
}

function parseMutationEnvelope(value: unknown): Readonly<{ connector: ConnectorEnvelope["connector"] }> | null {
  if (!structurallySafeJson(value) || value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0 || Object.keys(descriptors).length !== 1) return null;
    const connector = descriptors.connector;
    if (!connector || !("value" in connector) || !connector.enumerable) return null;
    const parsed = parseContractConnectorListEnvelope({ connectors: [connector.value], nextCursor: null });
    return parsed ? Object.freeze({ connector: parsed.connectors[0]! }) : null;
  } catch { return null; }
}

export function createConnectorClient(fetcher: FetchLike = fetch): ConnectorClient {
  const client: ConnectorClient = {
    async list(page, signal) {
      return perform({ fetcher, path: `/api/v2/connectors?${listQuery(page)}`, init: readInit(signal), successStatuses: [200], parse: parseClientConnectorListEnvelope });
    },
    async get(connectorId, page, signal) {
      return perform({ fetcher, path: `/api/v2/connectors/${encodeURIComponent(strictId(connectorId))}?${historyQuery(page)}`, init: readInit(signal), successStatuses: [200], parse: parseClientConnectorEnvelope });
    },
    async rename(connectorId, input, signal) {
      const parsed = parseConnectorMutationBody(input);
      if (!parsed || parsed.action !== "rename") throw invalidRequest();
      return perform({ fetcher, path: `/api/v2/connectors/${encodeURIComponent(strictId(connectorId))}`, init: mutationInit("PATCH", parsed, signal), successStatuses: [200], parse: parseMutationEnvelope });
    },
    async archive(connectorId, expectedLifecycleRevision, signal) {
      const parsed = parseConnectorMutationBody({ action: "archive", expectedLifecycleRevision });
      if (!parsed) throw invalidRequest();
      return perform({ fetcher, path: `/api/v2/connectors/${encodeURIComponent(strictId(connectorId))}`, init: mutationInit("PATCH", parsed, signal), successStatuses: [200], parse: parseMutationEnvelope });
    },
    async reviewOpenApi(input, signal) {
      const parsed = parseOpenApiReviewBody(input);
      if (!parsed) throw invalidRequest();
      const escaped = JSON.stringify(parsed.source).slice(1, -1);
      return perform({
        fetcher,
        path: "/api/v2/connectors/openapi",
        init: mutationInit("POST", parsed, signal),
        successStatuses: [200, 201],
        parse: parseClientOpenApiReviewEnvelope,
        canaries: Object.freeze([parsed.source, escaped]),
      });
    },
    async addOperation(connectorId, input, signal) {
      const parsed = parseAddOperationBody(input);
      if (!parsed) throw invalidRequest();
      return perform({
        fetcher,
        path: `/api/v2/connectors/${encodeURIComponent(strictId(connectorId))}/operations`,
        init: mutationInit("POST", parsed, signal),
        successStatuses: [200, 201],
        parse: parseClientConnectorOperationEnvelope,
      });
    },
    async listOperations(connectorId, page, signal) {
      return perform({
        fetcher,
        path: `/api/v2/connectors/${encodeURIComponent(strictId(connectorId))}/operations?${operationQuery(page)}`,
        init: readInit(signal),
        successStatuses: [200],
        parse: parseClientConnectorOperationsEnvelope,
      });
    },
    async resolveOperations(operationVersionIds, signal) {
      const parsed = parseResolveOperationsBody({ operationVersionIds });
      if (!parsed) throw invalidRequest();
      return perform({
        fetcher,
        path: "/api/v2/connectors/operations/resolve",
        init: mutationInit("POST", parsed, signal),
        successStatuses: [200],
        parse: parseClientOperationClosuresEnvelope,
        schemaProjection: true,
      });
    },
  };
  return Object.freeze(client);
}
