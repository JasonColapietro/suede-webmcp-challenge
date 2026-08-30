/** Strict browser-only client for metadata-only Connector Lab Test readiness. */

import { readBoundedConnectorJson } from "./client";
import {
  parseConnectorReadinessRequest,
  type ConnectorReadinessReceipt,
  type ConnectorReadinessRequest,
} from "./readiness";

const RESPONSE_LIMIT = 64 * 1024;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const SUFFIX = /^[0-9a-f]{8}$/u;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ConfiguredReceipt = Extract<ConnectorReadinessReceipt, { readonly status: "configured" }>;
type UnavailableReceipt = Extract<ConnectorReadinessReceipt, { readonly status: "unavailable" }>;
type NotRequiredReceipt = Extract<ConnectorReadinessReceipt, { readonly status: "not_required" }>;

export type ConnectorReadinessClientResult =
  | Readonly<{ readonly ok: true; readonly readiness: ConfiguredReceipt | NotRequiredReceipt }>
  | Readonly<{
      readonly ok: false;
      readonly code: "TEST_CONNECTION_UNAVAILABLE";
      readonly readiness: UnavailableReceipt;
    }>;

export type ConnectorReadinessClientErrorCode =
  | "READINESS_INVALID_REQUEST"
  | "READINESS_CANCELLED"
  | "READINESS_UNAVAILABLE"
  | "authentication required"
  | "not found"
  | "payload too large"
  | "unsupported media type"
  | "connector service unavailable";

export class ConnectorReadinessClientError extends Error {
  readonly status: number;
  readonly code: ConnectorReadinessClientErrorCode;

  constructor(status: number, code: ConnectorReadinessClientErrorCode) {
    super(code);
    this.name = "ConnectorReadinessClientError";
    this.status = status;
    this.code = code;
  }
}

export interface ConnectorReadinessClient {
  check(input: ConnectorReadinessRequest, signal?: AbortSignal): Promise<ConnectorReadinessClientResult>;
}

function exactRecord(value: unknown, required: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const expected = [...required].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of required) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function zeroReceiptFields(record: Record<string, unknown>): boolean {
  return record.egressCount === 0 && record.costUsdc === 0;
}

function configuredReceipt(value: unknown): ConfiguredReceipt | null {
  const record = exactRecord(value, [
    "status", "message", "authentication", "observedLifecycleRevision", "connection", "egressCount", "costUsdc",
  ]);
  const connection = record && exactRecord(record.connection, [
    "kind", "publicHeaderNames", "testSlotStatus", "idSuffix",
  ]);
  if (!record || !connection || record.status !== "configured" ||
      record.message !== "Test slot configured. Authentication unverified." ||
      record.authentication !== "unverified" || !Number.isSafeInteger(record.observedLifecycleRevision) ||
      (record.observedLifecycleRevision as number) < 1 || !zeroReceiptFields(record) ||
      !["api_key", "bearer", "basic", "custom_headers"].includes(connection.kind as string) ||
      connection.testSlotStatus !== "configured" || typeof connection.idSuffix !== "string" ||
      !SUFFIX.test(connection.idSuffix) || !Array.isArray(connection.publicHeaderNames) ||
      connection.publicHeaderNames.length < 1 || connection.publicHeaderNames.length > 16) return null;
  const names = connection.publicHeaderNames;
  const descriptors = Object.getOwnPropertyDescriptors(names);
  const allowed = new Set([...names.keys()].map(String).concat("length"));
  if (Object.getPrototypeOf(names) !== Array.prototype || Object.getOwnPropertySymbols(names).length !== 0 ||
      Object.keys(descriptors).some((key) => !allowed.has(key))) return null;
  const parsedNames: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const name = descriptor && "value" in descriptor ? descriptor.value : null;
    if (!descriptor?.enumerable || typeof name !== "string" || name.length < 1 || name.length > 64 ||
        !HEADER_TOKEN.test(name) || name !== name.toLowerCase()) return null;
    parsedNames.push(name);
  }
  if (new Set(parsedNames).size !== parsedNames.length) return null;
  const kind = connection.kind as ConfiguredReceipt["connection"]["kind"];
  if ((kind === "bearer" || kind === "basic") &&
      (parsedNames.length !== 1 || parsedNames[0] !== "authorization")) return null;
  return Object.freeze({
    status: "configured",
    message: "Test slot configured. Authentication unverified.",
    authentication: "unverified",
    observedLifecycleRevision: record.observedLifecycleRevision as number,
    connection: Object.freeze({
      kind,
      publicHeaderNames: Object.freeze(parsedNames),
      testSlotStatus: "configured",
      idSuffix: connection.idSuffix,
    }),
    egressCount: 0,
    costUsdc: 0,
  });
}

function unavailableReceipt(value: unknown): UnavailableReceipt | null {
  const record = exactRecord(value, [
    "status", "message", "authentication", "observedLifecycleRevision", "connection", "egressCount", "costUsdc",
  ]);
  return record && record.status === "unavailable" &&
    record.message === "Test slot unavailable. Authentication unverified." &&
    record.authentication === "unverified" && record.observedLifecycleRevision === null &&
    record.connection === null && zeroReceiptFields(record)
    ? Object.freeze({
        status: "unavailable",
        message: "Test slot unavailable. Authentication unverified.",
        authentication: "unverified",
        observedLifecycleRevision: null,
        connection: null,
        egressCount: 0,
        costUsdc: 0,
      })
    : null;
}

function notRequiredReceipt(value: unknown): NotRequiredReceipt | null {
  const record = exactRecord(value, [
    "status", "message", "authentication", "observedLifecycleRevision", "connection", "egressCount", "costUsdc",
  ]);
  return record && record.status === "not_required" && record.message === "Authentication not required." &&
    record.authentication === "not_required" && record.observedLifecycleRevision === null &&
    record.connection === null && zeroReceiptFields(record)
    ? Object.freeze({
        status: "not_required",
        message: "Authentication not required.",
        authentication: "not_required",
        observedLifecycleRevision: null,
        connection: null,
        egressCount: 0,
        costUsdc: 0,
      })
    : null;
}

export function parseClientConnectorReadinessEnvelope(
  value: unknown,
  status: number,
): ConnectorReadinessClientResult | null {
  if (status === 200) {
    const record = exactRecord(value, ["readiness"]);
    if (!record) return null;
    const receipt = configuredReceipt(record.readiness) ?? notRequiredReceipt(record.readiness);
    return receipt ? Object.freeze({ ok: true, readiness: receipt }) : null;
  }
  if (status === 409) {
    const record = exactRecord(value, ["error", "readiness"]);
    const receipt = record ? unavailableReceipt(record.readiness) : null;
    return record?.error === "test readiness unavailable" && receipt
      ? Object.freeze({ ok: false, code: "TEST_CONNECTION_UNAVAILABLE", readiness: receipt })
      : null;
  }
  return null;
}

function parseError(value: unknown, status: number): ConnectorReadinessClientError | null {
  const record = exactRecord(value, ["error"]);
  if (!record || typeof record.error !== "string") return null;
  const expected = new Map<number, ConnectorReadinessClientErrorCode>([
    [400, "READINESS_INVALID_REQUEST"],
    [401, "authentication required"],
    [404, "not found"],
    [413, "payload too large"],
    [415, "unsupported media type"],
    [503, "connector service unavailable"],
  ]);
  if (status === 409 && record.error === "request cancelled") {
    return new ConnectorReadinessClientError(409, "READINESS_CANCELLED");
  }
  const code = expected.get(status);
  const expectedText = status === 400 ? "invalid request" : code;
  return code && record.error === expectedText ? new ConnectorReadinessClientError(status, code) : null;
}

function init(body: ConnectorReadinessRequest, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
}

export function createConnectorReadinessClient(fetcher: FetchLike = fetch): ConnectorReadinessClient {
  return Object.freeze({
    async check(input: ConnectorReadinessRequest, signal?: AbortSignal): Promise<ConnectorReadinessClientResult> {
      if (signal?.aborted) throw new ConnectorReadinessClientError(0, "READINESS_CANCELLED");
      const parsed = parseConnectorReadinessRequest(input);
      if (!parsed) throw new ConnectorReadinessClientError(400, "READINESS_INVALID_REQUEST");
      let response: Response;
      try { response = await fetcher("/api/v2/connectors/readiness", init(parsed, signal)); }
      catch {
        throw new ConnectorReadinessClientError(0, signal?.aborted ? "READINESS_CANCELLED" : "READINESS_UNAVAILABLE");
      }
      if (signal?.aborted) {
        try { await response.body?.cancel(); } catch { /* terminal */ }
        throw new ConnectorReadinessClientError(0, "READINESS_CANCELLED");
      }
      const value = await readBoundedConnectorJson(response, signal, [], false, RESPONSE_LIMIT);
      if (signal?.aborted) throw new ConnectorReadinessClientError(0, "READINESS_CANCELLED");
      if (value !== null) {
        const envelope = parseClientConnectorReadinessEnvelope(value, response.status);
        if (envelope) return envelope;
        const error = parseError(value, response.status);
        if (error) throw error;
      }
      throw new ConnectorReadinessClientError(0, "READINESS_UNAVAILABLE");
    },
  });
}
