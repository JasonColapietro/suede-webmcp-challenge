/** Strict browser-only client for Task 9's private zero-egress simulation route. */

import { readBoundedConnectorJson } from "./client";
import type {
  ApiOperationSimulationFailureCode,
  ApiOperationSimulationReceiptV1,
  ApiOperationSimulationRequestV1,
} from "./simulation-contract";
import type { UnverifiedAuthorAnnotationV1 } from "./types";

const RESPONSE_LIMIT = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const METHODS = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);
const REQUEST_KEYS = ["environmentId", "nodeId", "pinnedInputs", "scope"] as const;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface ApiOperationSimulationEnvelope { readonly simulation: ApiOperationSimulationReceiptV1 }
export type ApiOperationSimulationClientErrorCode = ApiOperationSimulationFailureCode |
  "authentication required" | "forbidden" | "not found" | "unsupported media type" |
  "too many test runs";

export class ApiOperationSimulationClientError extends Error {
  readonly status: number;
  readonly code: ApiOperationSimulationClientErrorCode;
  readonly correlationId?: string;

  constructor(status: number, code: ApiOperationSimulationClientErrorCode, correlationId?: string) {
    super(code);
    this.name = "ApiOperationSimulationClientError";
    this.status = status;
    this.code = code;
    if (correlationId !== undefined) this.correlationId = correlationId;
  }
}

export interface ApiOperationSimulationClient {
  simulate(
    flowId: string,
    input: ApiOperationSimulationRequestV1,
    signal?: AbortSignal,
  ): Promise<ApiOperationSimulationReceiptV1>;
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (required.some((key) => !keys.includes(key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))) return null;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

type Inspection = Readonly<{ ok: true }> | Readonly<{ ok: false; fixture: boolean }>;

function inspectJson(value: unknown, maxDepth = 64, maxValues = 100_000): Inspection {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let values = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    values += 1;
    if (current.depth > maxDepth || values > maxValues) return { ok: false, fixture: false };
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return { ok: false, fixture: false };
      continue;
    }
    if (typeof item !== "object" || seen.has(item)) return { ok: false, fixture: false };
    seen.add(item);
    try {
      const prototype = Object.getPrototypeOf(item);
      if ((Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
          Object.getOwnPropertySymbols(item).length !== 0) return { ok: false, fixture: false };
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const entries = Object.entries(descriptors).filter(([key]) => !Array.isArray(item) || key !== "length");
      if (Array.isArray(item) && (entries.length !== item.length ||
          entries.some(([key], index) => key !== String(index)))) return { ok: false, fixture: false };
      for (const [key, descriptor] of entries) {
        if (key.toLocaleLowerCase("en-US").includes("fixture")) return { ok: false, fixture: true };
        if (UNSAFE_KEYS.has(key) || !("value" in descriptor) || !descriptor.enumerable) {
          return { ok: false, fixture: false };
        }
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } catch {
      return { ok: false, fixture: false };
    }
  }
  return { ok: true };
}

function canonicalPinKey(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > 4_096) return false;
  let tuple: unknown;
  try { tuple = JSON.parse(value) as unknown; } catch { return false; }
  if (!Array.isArray(tuple) || tuple.length !== 6 || JSON.stringify(tuple) !== value || Object.keys(tuple).length !== 6) return false;
  const bounded = (item: unknown): boolean => boundedText(item, 128);
  if (tuple[0] === "edge-input") return tuple.slice(1).every(bounded);
  if (tuple[0] !== "node-binding" && tuple[0] !== "edge-condition") return false;
  return tuple.slice(1, 5).every(bounded) &&
    (tuple[5] === null || (typeof tuple[5] === "string" &&
      new TextEncoder().encode(tuple[5]).byteLength <= 512 && !CONTROL.test(tuple[5])));
}

function freezeDeep<Value>(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  const pending = [value as object];
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

function parseBrowserSimulationRequest(input: unknown):
  | Readonly<{ ok: true; value: ApiOperationSimulationRequestV1 }>
  | Readonly<{ ok: false; code: "SIMULATION_INVALID_REQUEST" | "UNSUPPORTED_FIXTURE_INPUT" }> {
  const inspected = inspectJson(input);
  if (!inspected.ok) return Object.freeze({
    ok: false,
    code: inspected.fixture ? "UNSUPPORTED_FIXTURE_INPUT" : "SIMULATION_INVALID_REQUEST",
  });
  const record = exactRecord(input, REQUEST_KEYS);
  if (!record || !boundedText(record.environmentId, 512) || !boundedText(record.nodeId, 128) ||
      (record.scope !== "node" && record.scope !== "from-node") || record.pinnedInputs === null ||
      typeof record.pinnedInputs !== "object" || Array.isArray(record.pinnedInputs)) {
    return Object.freeze({ ok: false, code: "SIMULATION_INVALID_REQUEST" });
  }
  const pins = exactRecord(record.pinnedInputs, [], Object.keys(record.pinnedInputs));
  if (!pins || Object.keys(pins).length > 512 || Object.keys(pins).some((key) => !canonicalPinKey(key))) {
    return Object.freeze({ ok: false, code: "SIMULATION_INVALID_REQUEST" });
  }
  try {
    const entries = Object.entries(pins).sort(([left], [right]) => left.localeCompare(right));
    for (const [, value] of entries) {
      if (!inspectJson(value, 16, 10_000).ok ||
          new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024) {
        return Object.freeze({ ok: false, code: "SIMULATION_INVALID_REQUEST" });
      }
    }
    const pinnedInputs = Object.fromEntries(entries.map(([key, value]) => [key, structuredClone(value)]));
    if (new TextEncoder().encode(JSON.stringify(pinnedInputs)).byteLength > 256 * 1024) {
      return Object.freeze({ ok: false, code: "SIMULATION_INVALID_REQUEST" });
    }
    return Object.freeze({
      ok: true,
      value: freezeDeep({
        environmentId: record.environmentId,
        nodeId: record.nodeId,
        pinnedInputs,
        scope: record.scope,
      } as ApiOperationSimulationRequestV1),
    });
  } catch {
    return Object.freeze({ ok: false, code: "SIMULATION_INVALID_REQUEST" });
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !CONTROL.test(value) && new TextEncoder().encode(value).byteLength <= maximum;
}

function safeInteger(value: unknown, allowZero = true): value is number {
  return Number.isSafeInteger(value) && (allowZero ? (value as number) >= 0 : (value as number) >= 1);
}

function exactStringArray(value: unknown, maximum: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...value.keys()].map(String).concat("length"));
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) return null;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !boundedText(descriptor.value, 512)) return null;
    result.push(descriptor.value);
  }
  return new Set(result).size === result.length ? Object.freeze(result) : null;
}

function annotation(value: unknown): UnverifiedAuthorAnnotationV1 | null {
  const record = exactRecord(value, ["label"], ["effectNote", "retryNote"]);
  if (!record || record.label !== "Unverified" ||
      (!Object.hasOwn(record, "effectNote") && !Object.hasOwn(record, "retryNote")) ||
      (Object.hasOwn(record, "effectNote") && !boundedText(record.effectNote, 512)) ||
      (Object.hasOwn(record, "retryNote") && !boundedText(record.retryNote, 512))) return null;
  return Object.freeze({
    label: "Unverified",
    ...(Object.hasOwn(record, "effectNote") ? { effectNote: record.effectNote as string } : {}),
    ...(Object.hasOwn(record, "retryNote") ? { retryNote: record.retryNote as string } : {}),
  });
}

function receipt(value: unknown): ApiOperationSimulationReceiptV1 | null {
  const record = exactRecord(value, [
    "schemaVersion", "correlationId", "simulationId", "message", "operation", "systemPolicy",
    "authorAnnotation", "execution", "egressCount", "costUsdc", "durationMs",
  ]);
  const operation = record && exactRecord(record.operation, [
    "operationVersionId", "operationId", "connectorProjectionHash", "operationProjectionHash", "schemaHash",
    "method", "origin", "pathTemplate", "pathParameterNames", "queryParameterNames", "requestHeaderNames",
    "hasBody", "selectedStatus", "credentialPlaceholder",
  ]);
  const policy = record && exactRecord(record.systemPolicy, ["effects", "retry", "cost", "idempotency"]);
  const execution = record && exactRecord(record.execution, ["plannedNodeCount", "completedNodeCount"]);
  if (!record || !operation || !policy || !execution || record.schemaVersion !== 1 ||
      typeof record.correlationId !== "string" || !UUID.test(record.correlationId) ||
      typeof record.simulationId !== "string" || !UUID.test(record.simulationId) ||
      record.message !== "Simulated locally. No request sent." || record.egressCount !== 0 || record.costUsdc !== 0 ||
      !safeInteger(record.durationMs) || typeof operation.operationVersionId !== "string" ||
      !UUID.test(operation.operationVersionId) || !boundedText(operation.operationId, 512) ||
      typeof operation.connectorProjectionHash !== "string" || !SHA256.test(operation.connectorProjectionHash) ||
      typeof operation.operationProjectionHash !== "string" || !SHA256.test(operation.operationProjectionHash) ||
      typeof operation.schemaHash !== "string" || !SHA256.test(operation.schemaHash) ||
      !METHODS.has(operation.method as string) || !boundedText(operation.origin, 2_048) ||
      !boundedText(operation.pathTemplate, 8_192) || !operation.pathTemplate.startsWith("/") ||
      typeof operation.hasBody !== "boolean" || !safeInteger(operation.selectedStatus, false) ||
      (operation.selectedStatus as number) < 200 || (operation.selectedStatus as number) > 299 ||
      !Array.isArray(policy.effects) || policy.effects.length !== 1 || policy.effects[0] !== "write" ||
      policy.retry !== "unsafe" || policy.cost !== "unknown" || policy.idempotency !== "none" ||
      !safeInteger(execution.plannedNodeCount, false) || !safeInteger(execution.completedNodeCount) ||
      (execution.completedNodeCount as number) > (execution.plannedNodeCount as number)) return null;
  try {
    const origin = new URL(operation.origin);
    if (origin.protocol !== "https:" || origin.origin !== operation.origin) return null;
  } catch { return null; }
  const pathParameterNames = exactStringArray(operation.pathParameterNames, 64);
  const queryParameterNames = exactStringArray(operation.queryParameterNames, 64);
  const requestHeaderNames = exactStringArray(operation.requestHeaderNames, 64);
  if (!pathParameterNames || !queryParameterNames || !requestHeaderNames) return null;
  let credentialPlaceholder: ApiOperationSimulationReceiptV1["operation"]["credentialPlaceholder"] = null;
  if (operation.credentialPlaceholder !== null) {
    const credential = exactRecord(operation.credentialPlaceholder, ["kind", "headerName", "value"]);
    if (!credential || !["api_key_header", "http_bearer", "http_basic"].includes(credential.kind as string) ||
        !boundedText(credential.headerName, 64) || !HEADER_TOKEN.test(credential.headerName as string) ||
        credential.headerName !== (credential.headerName as string).toLowerCase() || credential.value !== "[redacted]" ||
        (credential.kind === "api_key_header" && credential.headerName === "authorization") ||
        ((credential.kind === "http_bearer" || credential.kind === "http_basic") && credential.headerName !== "authorization")) return null;
    credentialPlaceholder = Object.freeze({
      kind: credential.kind as "api_key_header" | "http_bearer" | "http_basic",
      headerName: credential.headerName,
      value: "[redacted]",
    });
  }
  const authorAnnotation = record.authorAnnotation === null ? null : annotation(record.authorAnnotation);
  if (record.authorAnnotation !== null && !authorAnnotation) return null;
  return Object.freeze({
    schemaVersion: 1,
    correlationId: record.correlationId,
    simulationId: record.simulationId,
    message: "Simulated locally. No request sent.",
    operation: Object.freeze({
      operationVersionId: operation.operationVersionId,
      operationId: operation.operationId,
      connectorProjectionHash: operation.connectorProjectionHash,
      operationProjectionHash: operation.operationProjectionHash,
      schemaHash: operation.schemaHash,
      method: operation.method as string,
      origin: operation.origin,
      pathTemplate: operation.pathTemplate,
      pathParameterNames,
      queryParameterNames,
      requestHeaderNames,
      hasBody: operation.hasBody,
      selectedStatus: operation.selectedStatus,
      credentialPlaceholder,
    }),
    systemPolicy: Object.freeze({ effects: Object.freeze(["write"]), retry: "unsafe", cost: "unknown", idempotency: "none" }),
    authorAnnotation,
    execution: Object.freeze({
      plannedNodeCount: execution.plannedNodeCount,
      completedNodeCount: execution.completedNodeCount,
    }),
    egressCount: 0,
    costUsdc: 0,
    durationMs: record.durationMs,
  }) as ApiOperationSimulationReceiptV1;
}

export function parseClientApiOperationSimulationEnvelope(
  value: unknown,
  status: number,
): ApiOperationSimulationEnvelope | null {
  if (status !== 200) return null;
  const record = exactRecord(value, ["simulation"]);
  const parsed = record ? receipt(record.simulation) : null;
  return parsed ? Object.freeze({ simulation: parsed }) : null;
}

const FAILURE_STATUS = Object.freeze({
  SIMULATION_INVALID_REQUEST: 400,
  UNSUPPORTED_FIXTURE_INPUT: 422,
  SIMULATION_NOT_FOUND: 404,
  SIMULATION_POLICY_REFUSED: 409,
  SIMULATION_DRIFT_REFUSED: 409,
  SIMULATION_INPUT_REFUSED: 422,
  SIMULATION_CANCELLED: 408,
  SIMULATION_TIMEOUT: 504,
  SIMULATION_REFUSED: 422,
  SIMULATION_UNAVAILABLE: 503,
  AUDIT_UNAVAILABLE: 503,
} satisfies Record<ApiOperationSimulationFailureCode, number>);

function error(value: unknown, status: number): ApiOperationSimulationClientError | null {
  const record = exactRecord(value, ["error"], ["correlationId"]);
  if (!record || typeof record.error !== "string") return null;
  if (Object.hasOwn(FAILURE_STATUS, record.error)) {
    const code = record.error as ApiOperationSimulationFailureCode;
    if (FAILURE_STATUS[code] !== status ||
        (Object.hasOwn(record, "correlationId") && (typeof record.correlationId !== "string" || !UUID.test(record.correlationId)))) return null;
    return new ApiOperationSimulationClientError(status, code,
      Object.hasOwn(record, "correlationId") ? record.correlationId as string : undefined);
  }
  if (Object.hasOwn(record, "correlationId")) return null;
  const privateStatus = new Map<string, number>([
    ["authentication required", 401], ["forbidden", 403], ["not found", 404],
    ["unsupported media type", 415], ["too many test runs", 429],
  ]);
  return privateStatus.get(record.error) === status
    ? new ApiOperationSimulationClientError(status, record.error as ApiOperationSimulationClientErrorCode)
    : null;
}

function flowId(value: unknown): string | null {
  return boundedText(value, 512) ? value : null;
}

function init(body: ApiOperationSimulationRequestV1, signal?: AbortSignal): RequestInit {
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

export function createApiOperationSimulationClient(fetcher: FetchLike = fetch): ApiOperationSimulationClient {
  return Object.freeze({
    async simulate(
      flowIdValue: string,
      input: ApiOperationSimulationRequestV1,
      signal?: AbortSignal,
    ): Promise<ApiOperationSimulationReceiptV1> {
      if (signal?.aborted) throw new ApiOperationSimulationClientError(0, "SIMULATION_CANCELLED");
      const id = flowId(flowIdValue);
      const parsed = parseBrowserSimulationRequest(input);
      if (!id) throw new ApiOperationSimulationClientError(400, "SIMULATION_INVALID_REQUEST");
      if (!parsed.ok) throw new ApiOperationSimulationClientError(FAILURE_STATUS[parsed.code], parsed.code);
      let response: Response;
      try {
        response = await fetcher(
          `/api/v2/flows/${encodeURIComponent(id)}/test/api-operation`,
          init(parsed.value, signal),
        );
      } catch {
        throw new ApiOperationSimulationClientError(0, signal?.aborted ? "SIMULATION_CANCELLED" : "SIMULATION_UNAVAILABLE");
      }
      if (signal?.aborted) {
        try { await response.body?.cancel(); } catch { /* terminal */ }
        throw new ApiOperationSimulationClientError(0, "SIMULATION_CANCELLED");
      }
      const value = await readBoundedConnectorJson(response, signal, [], false, RESPONSE_LIMIT);
      if (signal?.aborted) throw new ApiOperationSimulationClientError(0, "SIMULATION_CANCELLED");
      if (value !== null) {
        const envelope = parseClientApiOperationSimulationEnvelope(value, response.status);
        if (envelope) return envelope.simulation;
        const failure = error(value, response.status);
        if (failure) throw failure;
      }
      throw new ApiOperationSimulationClientError(0, "SIMULATION_UNAVAILABLE");
    },
  });
}
