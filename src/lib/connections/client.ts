/** Browser-safe connection metadata client. This module never persists response or secret input. */

import {
  PRIVATE_ERROR_STATUS,
  parseConfigureSlotBody,
  parseConnectionEnvelope as parseContractConnectionEnvelope,
  parseConnectionEnvironmentPath,
  parseConnectionListEnvelope as parseContractConnectionListEnvelope,
  parseConnectionListPage,
  parseCreateBody,
  parsePrivateErrorEnvelope as parseContractPrivateErrorEnvelope,
  parseRenameBody,
  parseUsageEnvelope as parseContractUsageEnvelope,
  type ConfigureSlotBody,
  type ConnectionEnvelope,
  type ConnectionListEnvelope,
  type PrivateError,
  type PrivateErrorEnvelope,
  type RenameBody,
  type UsageEnvelope,
} from "./api-contract";
import type { ConnectionListPage } from "./repository";
import type {
  ConnectionCreateInput,
  ConnectionEnvironment,
  ConnectionKind,
  ConnectionSecretInput,
  ConnectionSlotStatus,
} from "./types";

const RESPONSE_BYTE_LIMIT = 256 * 1024;
const RESPONSE_DEPTH_LIMIT = 32;
const RESPONSE_VALUE_LIMIT = 10_000;
const RESPONSE_STRING_BYTE_LIMIT = 64 * 1024;
const CONNECTION_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const FORBIDDEN_KEYS = new Set([
  "apikey", "authtag", "authorization", "ciphertext", "headers", "keyversion",
  "nonce", "password", "secret", "token", "username", "values",
]);
const CREDENTIAL_SIGNATURES = [
  /(?:^|[^A-Za-z0-9_])Bearer[ \t]+\S+/iu,
  /(?:^|[^A-Za-z0-9_])Basic[ \t]+[A-Za-z0-9+/]+={0,2}(?=$|[^A-Za-z0-9+/=])/iu,
  /(?:^|[^A-Za-z0-9_])(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/iu,
  /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/iu,
  /(?:^|[^A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{8,}/iu,
  /(?:^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}(?=$|[^0-9A-Z])/u,
  /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?=$|[^A-Za-z0-9_-])/u,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/iu,
] as const;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectionChoice {
  readonly id: string;
  readonly label: string;
  readonly kind: ConnectionKind;
  readonly publicHeaderNames: readonly string[];
  readonly lifecycleRevision: number;
  readonly slots: Readonly<{
    readonly test: ConnectionSlotStatus;
    readonly live: ConnectionSlotStatus;
  }>;
}

export interface ConnectionClient {
  list(page?: ConnectionListPage): Promise<ConnectionListEnvelope>;
  get(connectionId: string, signal?: AbortSignal): Promise<ConnectionEnvelope>;
  create(input: ConnectionCreateInput, signal?: AbortSignal): Promise<ConnectionEnvelope>;
  rename(connectionId: string, input: RenameBody, signal?: AbortSignal): Promise<ConnectionEnvelope>;
  configureSlot(
    connectionId: string,
    environment: ConnectionEnvironment,
    input: ConfigureSlotBody,
    signal?: AbortSignal,
  ): Promise<ConnectionEnvelope>;
  revokeSlot(
    connectionId: string,
    environment: ConnectionEnvironment,
    input: Readonly<{ expectedLifecycleRevision: number }>,
    signal?: AbortSignal,
  ): Promise<ConnectionEnvelope>;
  usage(connectionId: string, page?: ConnectionListPage): Promise<UsageEnvelope>;
}

export class ConnectionClientError extends Error {
  readonly status: number;
  readonly error: PrivateError;

  constructor(status: number, error: PrivateError) {
    super(error);
    this.name = "ConnectionClientError";
    this.status = status;
    this.error = error;
  }
}

function invalidRequest(): ConnectionClientError {
  return new ConnectionClientError(PRIVATE_ERROR_STATUS["invalid request"], "invalid request");
}

function unavailable(): ConnectionClientError {
  return new ConnectionClientError(0, "connection service unavailable");
}

function mediaTypeIsJson(headers: Headers): boolean {
  const raw = headers.get("content-type");
  if (raw === null || /[\r\n]/u.test(raw)) return false;
  const [base, ...parameters] = raw.split(";");
  return base?.trim().toLowerCase() === "application/json" && parameters.every((parameter) =>
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n]*")$/u.test(parameter.trim()));
}

function secretShapedString(value: string): boolean {
  return CREDENTIAL_SIGNATURES.some((signature) => signature.test(value));
}

function containsCanary(value: string, canaries: readonly string[]): boolean {
  return canaries.some((canary) => canary.length > 0 && value.includes(canary));
}

function structurallySafeJson(value: unknown, canaries: readonly string[] = []): boolean {
  const encoder = new TextEncoder();
  const seen = new WeakSet<object>();
  let count = 0;
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > RESPONSE_DEPTH_LIMIT || ++count > RESPONSE_VALUE_LIMIT) return false;
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string") {
      return encoder.encode(current).byteLength <= RESPONSE_STRING_BYTE_LIMIT &&
        !secretShapedString(current) && !containsCanary(current, canaries);
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
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
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
              !visit(descriptor.value, depth + 1)) return false;
        }
        return true;
      }
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase()) || secretShapedString(key) || containsCanary(key, canaries) ||
            !("value" in descriptor) || !descriptor.enumerable ||
            !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  if (!visit(value, 0)) return false;
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= RESPONSE_BYTE_LIMIT;
  } catch {
    return false;
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* rejection is already fixed */ }
}

export async function readBoundedConnectionJson(
  response: Response,
  signal?: AbortSignal,
  canaries: readonly string[] = [],
): Promise<unknown | null> {
  if (!mediaTypeIsJson(response.headers)) {
    await cancelResponse(response);
    return null;
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > RESPONSE_BYTE_LIMIT)) {
    await cancelResponse(response);
    return null;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (!response.body) return null;
    reader = response.body.getReader();
  } catch {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return null;
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > RESPONSE_BYTE_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return structurallySafeJson(parsed, canaries) ? parsed : null;
  } catch {
    return null;
  } finally {
    signal?.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { /* rejection is already fixed */ }
  }
}

export function parseClientConnectionEnvelope(value: unknown): ConnectionEnvelope | null {
  return structurallySafeJson(value) ? parseContractConnectionEnvelope(value) : null;
}

export function parseClientConnectionListEnvelope(value: unknown): ConnectionListEnvelope | null {
  return structurallySafeJson(value) ? parseContractConnectionListEnvelope(value) : null;
}

export function parseClientUsageEnvelope(value: unknown): UsageEnvelope | null {
  return structurallySafeJson(value) ? parseContractUsageEnvelope(value) : null;
}

export function parseClientPrivateErrorEnvelope(value: unknown): PrivateErrorEnvelope | null {
  return structurallySafeJson(value) ? parseContractPrivateErrorEnvelope(value) : null;
}

export function connectionChoices(envelope: ConnectionListEnvelope): readonly ConnectionChoice[] {
  const parsed = parseClientConnectionListEnvelope(envelope);
  if (!parsed) throw unavailable();
  return Object.freeze(parsed.connections.map((connection) => Object.freeze({
    id: connection.id,
    label: connection.name,
    kind: connection.kind,
    publicHeaderNames: Object.freeze(connection.kind === "api_key"
      ? [String(connection.publicConfig.headerName).toLowerCase()]
      : connection.kind === "custom_headers"
        ? (connection.publicConfig.headerNames as readonly string[]).map((name) => name.toLowerCase()).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        : ["authorization"]),
    lifecycleRevision: connection.lifecycleRevision,
    slots: Object.freeze({
      test: connection.slots.test.status,
      live: connection.slots.live.status,
    }),
  })));
}

function strictConnectionId(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_ID.test(value)) throw invalidRequest();
  return value;
}

function pageQuery(page: ConnectionListPage | undefined, kind: "list" | "usage"): string {
  const query = new URLSearchParams({ limit: String(page?.limit ?? 50) });
  if (page?.cursor !== undefined) query.set("cursor", page.cursor);
  if (!parseConnectionListPage(query, kind)) throw invalidRequest();
  return query.toString();
}

function exactRevokeBody(value: Readonly<{ expectedLifecycleRevision: number }>): Readonly<{ expectedLifecycleRevision: number }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.keys(descriptors).length !== 1) throw invalidRequest();
    const descriptor = descriptors.expectedLifecycleRevision;
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
        !Number.isSafeInteger(descriptor.value) || (descriptor.value as number) < 1) throw invalidRequest();
    return Object.freeze({ expectedLifecycleRevision: descriptor.value as number });
  } catch (error) {
    if (error instanceof ConnectionClientError) throw error;
    throw invalidRequest();
  }
}

function secretCanaries(secret: ConnectionSecretInput): readonly string[] {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(secret);
    const kindDescriptor = descriptors.kind;
    if (!kindDescriptor || !("value" in kindDescriptor) || !kindDescriptor.enumerable) throw invalidRequest();
    const readString = (record: PropertyDescriptorMap, key: string): string => {
      const descriptor = record[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
          typeof descriptor.value !== "string" || descriptor.value.length === 0) throw invalidRequest();
      return descriptor.value;
    };
    let values: string[];
    if (kindDescriptor.value === "api_key") {
      values = [readString(descriptors, "apiKey")];
    } else if (kindDescriptor.value === "bearer") {
      values = [readString(descriptors, "token")];
    } else if (kindDescriptor.value === "basic") {
      values = [readString(descriptors, "username"), readString(descriptors, "password")];
    } else if (kindDescriptor.value === "custom_headers") {
      const valuesDescriptor = descriptors.values;
      if (!valuesDescriptor || !("value" in valuesDescriptor) || !valuesDescriptor.enumerable ||
          valuesDescriptor.value === null || typeof valuesDescriptor.value !== "object" ||
          Array.isArray(valuesDescriptor.value)) throw invalidRequest();
      const valueDescriptors = Object.getOwnPropertyDescriptors(valuesDescriptor.value);
      values = Object.keys(valueDescriptors).map((key) => readString(valueDescriptors, key));
      if (values.length === 0) throw invalidRequest();
    } else {
      throw invalidRequest();
    }
    const canaries = new Set<string>();
    for (const value of values) {
      canaries.add(value);
      const serialized = JSON.stringify(value);
      canaries.add(serialized.slice(1, -1));
    }
    return Object.freeze([...canaries]);
  } catch (error) {
    if (error instanceof ConnectionClientError) throw error;
    throw invalidRequest();
  }
}

function mutationInit(method: "POST" | "PATCH" | "PUT" | "DELETE", body: unknown, signal?: AbortSignal): RequestInit {
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
  readonly fetcher: FetchLike;
  readonly path: string;
  readonly init: RequestInit;
  readonly successStatuses: readonly number[];
  readonly parse: (value: unknown) => T | null;
  readonly canaries?: readonly string[];
}): Promise<T> {
  let response: Response;
  try {
    response = await input.fetcher(input.path, input.init);
  } catch {
    throw unavailable();
  }
  const value = await readBoundedConnectionJson(response, input.init.signal ?? undefined, input.canaries);
  if (input.successStatuses.includes(response.status)) {
    const parsed = value === null ? null : input.parse(value);
    if (parsed) return parsed;
    throw unavailable();
  }
  const error = value === null ? null : parseClientPrivateErrorEnvelope(value);
  if (error && PRIVATE_ERROR_STATUS[error.error] === response.status) {
    throw new ConnectionClientError(response.status, error.error);
  }
  throw unavailable();
}

export function createConnectionClient(fetcher: FetchLike = fetch): ConnectionClient {
  const connection = (
    path: string,
    init: RequestInit,
    successStatuses: readonly number[],
    canaries?: readonly string[],
  ) => perform({
    fetcher, path, init, successStatuses, parse: parseClientConnectionEnvelope, canaries,
  });
  const client: ConnectionClient = {
    async list(page) {
      return perform({
        fetcher,
        path: `/api/v2/connections?${pageQuery(page, "list")}`,
        init: readInit(),
        successStatuses: [200],
        parse: parseClientConnectionListEnvelope,
      });
    },
    async get(connectionId, signal) {
      return connection(`/api/v2/connections/${encodeURIComponent(strictConnectionId(connectionId))}`, readInit(signal), [200]);
    },
    async create(input, signal) {
      const parsed = parseCreateBody(input);
      if (!parsed) throw invalidRequest();
      return connection("/api/v2/connections", mutationInit("POST", parsed, signal), [201]);
    },
    async rename(connectionId, input, signal) {
      const parsed = parseRenameBody(input);
      if (!parsed) throw invalidRequest();
      return connection(
        `/api/v2/connections/${encodeURIComponent(strictConnectionId(connectionId))}`,
        mutationInit("PATCH", parsed, signal),
        [200],
      );
    },
    async configureSlot(connectionId, environment, input, signal) {
      const parsedEnvironment = parseConnectionEnvironmentPath(environment);
      const parsed = parseConfigureSlotBody(input);
      if (!parsedEnvironment || !parsed) throw invalidRequest();
      return connection(
        `/api/v2/connections/${encodeURIComponent(strictConnectionId(connectionId))}/slots/${parsedEnvironment}`,
        mutationInit("PUT", parsed, signal),
        [200, 201],
        secretCanaries(parsed.secret),
      );
    },
    async revokeSlot(connectionId, environment, input, signal) {
      const parsedEnvironment = parseConnectionEnvironmentPath(environment);
      if (!parsedEnvironment) throw invalidRequest();
      return connection(
        `/api/v2/connections/${encodeURIComponent(strictConnectionId(connectionId))}/slots/${parsedEnvironment}`,
        mutationInit("DELETE", exactRevokeBody(input), signal),
        [200],
      );
    },
    async usage(connectionId, page) {
      return perform({
        fetcher,
        path: `/api/v2/connections/${encodeURIComponent(strictConnectionId(connectionId))}/usage?${pageQuery(page, "usage")}`,
        init: readInit(),
        successStatuses: [200],
        parse: parseClientUsageEnvelope,
      });
    },
  };
  return Object.freeze(client);
}
