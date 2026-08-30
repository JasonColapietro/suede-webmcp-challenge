import type { JsonValue } from "@/lib/flow/types";
import { CONNECTOR_IMPORT_V1_LIMITS } from "./limits";
import { createCompileGuard, parseBoundedJson } from "./openapi/json";
import { parseConnectorSchemaV1 } from "./schema";
import type {
  ConnectorSchemaV1,
  OperationAuthenticationV1,
  SystemPolicyV1,
  UnverifiedAuthorAnnotationV1,
} from "./types";

export const SIMULATION_INVALID_REQUEST = "SIMULATION_INVALID_REQUEST" as const;
export const UNSUPPORTED_FIXTURE_INPUT = "UNSUPPORTED_FIXTURE_INPUT" as const;
export const SIMULATION_NOT_FOUND = "SIMULATION_NOT_FOUND" as const;
export const SIMULATION_POLICY_REFUSED = "SIMULATION_POLICY_REFUSED" as const;
export const SIMULATION_DRIFT_REFUSED = "SIMULATION_DRIFT_REFUSED" as const;
export const SIMULATION_INPUT_REFUSED = "SIMULATION_INPUT_REFUSED" as const;
export const SIMULATION_CANCELLED = "SIMULATION_CANCELLED" as const;
export const SIMULATION_TIMEOUT = "SIMULATION_TIMEOUT" as const;
export const SIMULATION_REFUSED = "SIMULATION_REFUSED" as const;
export const SIMULATION_UNAVAILABLE = "SIMULATION_UNAVAILABLE" as const;
export const AUDIT_UNAVAILABLE = "AUDIT_UNAVAILABLE" as const;

export type ApiOperationSimulationFailureCode =
  | typeof SIMULATION_INVALID_REQUEST
  | typeof UNSUPPORTED_FIXTURE_INPUT
  | typeof SIMULATION_NOT_FOUND
  | typeof SIMULATION_POLICY_REFUSED
  | typeof SIMULATION_DRIFT_REFUSED
  | typeof SIMULATION_INPUT_REFUSED
  | typeof SIMULATION_CANCELLED
  | typeof SIMULATION_TIMEOUT
  | typeof SIMULATION_REFUSED
  | typeof SIMULATION_UNAVAILABLE
  | typeof AUDIT_UNAVAILABLE;

export interface ApiOperationSimulationRequestV1 {
  readonly environmentId: string;
  readonly nodeId: string;
  readonly pinnedInputs: Readonly<Record<string, JsonValue>>;
  readonly scope: "node" | "from-node";
}

export type ApiOperationSimulationRequestParseResult =
  | { readonly ok: true; readonly value: ApiOperationSimulationRequestV1 }
  | { readonly ok: false; readonly code: typeof SIMULATION_INVALID_REQUEST | typeof UNSUPPORTED_FIXTURE_INPUT };

export interface ApiOperationSimulationReceiptV1 {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly simulationId: string;
  readonly message: "Simulated locally. No request sent.";
  readonly operation: {
    readonly operationVersionId: string;
    readonly operationId: string;
    readonly connectorProjectionHash: string;
    readonly operationProjectionHash: string;
    readonly schemaHash: string;
    readonly method: string;
    readonly origin: string;
    readonly pathTemplate: string;
    readonly pathParameterNames: readonly string[];
    readonly queryParameterNames: readonly string[];
    readonly requestHeaderNames: readonly string[];
    readonly hasBody: boolean;
    readonly selectedStatus: number;
    readonly credentialPlaceholder: null | {
      readonly kind: Exclude<OperationAuthenticationV1["kind"], "none">;
      readonly headerName: string;
      readonly value: "[redacted]";
    };
  };
  readonly systemPolicy: SystemPolicyV1;
  readonly authorAnnotation: UnverifiedAuthorAnnotationV1 | null;
  readonly execution: {
    readonly plannedNodeCount: number;
    readonly completedNodeCount: number;
  };
  readonly egressCount: 0;
  readonly costUsdc: 0;
  readonly durationMs: number;
}

export type ApiOperationSimulationReceiptInput = Omit<
  ApiOperationSimulationReceiptV1,
  "schemaVersion" | "message" | "operation" | "execution" | "egressCount" | "costUsdc"
> & ApiOperationSimulationReceiptV1["operation"] & {
  readonly plannedNodeCount: number;
  readonly completedNodeCount: number;
};

const ENCODER = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/u;
const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
const REQUEST_KEYS = ["environmentId", "nodeId", "pinnedInputs", "scope"] as const;
const MAX_PINS = 512;
const MAX_PIN_BYTES = 256 * 1024;
const MAX_PIN_VALUE_BYTES = 64 * 1024;
const MAX_PIN_VALUE_DEPTH = 16;
const MAX_PIN_VALUE_VALUES = 10_000;
const MAX_ID_BYTES = 512;

function failure(code: typeof SIMULATION_INVALID_REQUEST | typeof UNSUPPORTED_FIXTURE_INPUT): ApiOperationSimulationRequestParseResult {
  return Object.freeze({ ok: false, code });
}

function fixtureKey(key: string): boolean {
  return key.toLocaleLowerCase("en-US").includes("fixture");
}

function boundedIdentity(value: unknown, maxBytes = MAX_ID_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    ENCODER.encode(value).byteLength <= maxBytes && !CONTROL.test(value);
}

function descriptors(value: object): Record<string, PropertyDescriptor> | null {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return null;
    } else if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const result = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(result)) {
      if (Array.isArray(value) && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor) || UNSAFE.has(key)) return null;
    }
    return result;
  } catch {
    return null;
  }
}

type Inspection = { readonly ok: true } | { readonly ok: false; readonly fixture: boolean };

function inspectJson(
  value: unknown,
  limits: Readonly<{ depth: number; values: number; entries: number }> = {
    depth: CONNECTOR_IMPORT_V1_LIMITS.maxJsonDepth,
    values: CONNECTOR_IMPORT_V1_LIMITS.maxInspectedValues,
    entries: CONNECTOR_IMPORT_V1_LIMITS.maxContainerEntries,
  },
): Inspection {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let values = 0;
  let aggregateEntries = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    values += 1;
    if (values > limits.values || current.depth > limits.depth) {
      return { ok: false, fixture: false };
    }
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return { ok: false, fixture: false };
      continue;
    }
    if (typeof item !== "object" || seen.has(item)) return { ok: false, fixture: false };
    seen.add(item);
    const own = descriptors(item);
    if (!own) return { ok: false, fixture: false };
    const entries = Object.entries(own).filter(([key]) => !Array.isArray(item) || key !== "length");
    if (Array.isArray(item) && (entries.length !== item.length ||
        entries.some(([key], index) => key !== String(index)))) return { ok: false, fixture: false };
    aggregateEntries += entries.length;
    if (aggregateEntries > limits.entries) return { ok: false, fixture: false };
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, descriptor] = entries[index]!;
      if (fixtureKey(key)) return { ok: false, fixture: true };
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return { ok: true };
}

function canonicalPinKey(value: string): boolean {
  if (ENCODER.encode(value).byteLength > 4_096) return false;
  let tuple: unknown;
  try { tuple = JSON.parse(value) as unknown; } catch { return false; }
  if (!Array.isArray(tuple) || tuple.length !== 6 || JSON.stringify(tuple) !== value || Object.keys(tuple).length !== 6) return false;
  if (tuple[0] === "edge-input") return tuple.slice(1).every((item) => boundedIdentity(item, 128));
  if (tuple[0] !== "node-binding" && tuple[0] !== "edge-condition") return false;
  const path = tuple[5];
  return tuple.slice(1, 5).every((item) => boundedIdentity(item, 128)) &&
    (path === null || (typeof path === "string" && ENCODER.encode(path).byteLength <= 512 && !CONTROL.test(path)));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending = [value as object];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(current);
  }
  return value;
}

export function parseApiOperationSimulationRequest(value: unknown): ApiOperationSimulationRequestParseResult {
  const inspected = inspectJson(value);
  if (!inspected.ok) return failure(inspected.fixture ? UNSUPPORTED_FIXTURE_INPUT : SIMULATION_INVALID_REQUEST);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return failure(SIMULATION_INVALID_REQUEST);
  const own = descriptors(value);
  if (!own) return failure(SIMULATION_INVALID_REQUEST);
  const keys = Object.keys(own).sort();
  if (keys.length !== REQUEST_KEYS.length || keys.some((key, index) => key !== [...REQUEST_KEYS].sort()[index])) {
    return failure(keys.some(fixtureKey) ? UNSUPPORTED_FIXTURE_INPUT : SIMULATION_INVALID_REQUEST);
  }
  const nodeId = own.nodeId!.value;
  const environmentId = own.environmentId!.value;
  const scope = own.scope!.value;
  const pins = own.pinnedInputs!.value;
  if (!boundedIdentity(nodeId, 128) || !boundedIdentity(environmentId) || (scope !== "node" && scope !== "from-node") ||
      pins === null || typeof pins !== "object" || Array.isArray(pins)) return failure(SIMULATION_INVALID_REQUEST);
  const pinDescriptors = descriptors(pins);
  if (!pinDescriptors) return failure(SIMULATION_INVALID_REQUEST);
  const pinEntries = Object.entries(pinDescriptors);
  if (pinEntries.length > MAX_PINS || pinEntries.some(([key]) => !canonicalPinKey(key))) return failure(SIMULATION_INVALID_REQUEST);
  let snapshot: ApiOperationSimulationRequestV1;
  try {
    if (!inspectJson(pins, { depth: MAX_PIN_VALUE_DEPTH + 1, values: MAX_PIN_VALUE_VALUES + 1, entries: MAX_PIN_VALUE_VALUES }).ok) {
      return failure(SIMULATION_INVALID_REQUEST);
    }
    for (const [, descriptor] of pinEntries) {
      const value = descriptor.value;
      if (!inspectJson(value, { depth: MAX_PIN_VALUE_DEPTH, values: MAX_PIN_VALUE_VALUES, entries: MAX_PIN_VALUE_VALUES }).ok ||
          ENCODER.encode(JSON.stringify(value)).byteLength > MAX_PIN_VALUE_BYTES) return failure(SIMULATION_INVALID_REQUEST);
    }
    const pinnedInputs = Object.fromEntries(pinEntries.sort(([a], [b]) => a.localeCompare(b)).map(([key, descriptor]) => [key, structuredClone(descriptor.value)]));
    if (ENCODER.encode(JSON.stringify(pinnedInputs)).byteLength > MAX_PIN_BYTES) return failure(SIMULATION_INVALID_REQUEST);
    snapshot = { environmentId, nodeId, pinnedInputs, scope };
  } catch {
    return failure(SIMULATION_INVALID_REQUEST);
  }
  return Object.freeze({ ok: true, value: deepFreeze(snapshot) });
}

/** Duplicate-aware UTF-8 JSON boundary used by the private route. */
export function parseApiOperationSimulationJson(
  source: string | Uint8Array,
  signal?: AbortSignal,
): ApiOperationSimulationRequestParseResult {
  try {
    return parseApiOperationSimulationRequest(parseBoundedJson(source, createCompileGuard(undefined, signal)));
  } catch {
    return failure(SIMULATION_INVALID_REQUEST);
  }
}

function ipv4Valid(value: string): boolean {
  const pieces = value.split(".");
  return pieces.length === 4 && pieces.every((piece) => /^(?:0|[1-9][0-9]{0,2})$/u.test(piece) && Number(piece) <= 255);
}

function ipv6PieceCount(value: string): number | null {
  if (value.length === 0) return 0;
  const pieces = value.split(":");
  let count = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    if (piece.includes(".")) {
      if (index !== pieces.length - 1 || !ipv4Valid(piece)) return null;
      count += 2;
    } else {
      if (!/^[0-9a-f]{1,4}$/iu.test(piece)) return null;
      count += 1;
    }
  }
  return count;
}

function ipv6Valid(value: string): boolean {
  if (value.length === 0 || value.includes("%") || value.split("::").length > 2) return false;
  const compressed = value.includes("::");
  const [left = "", right = ""] = value.split("::");
  const leftCount = ipv6PieceCount(left);
  const rightCount = compressed ? ipv6PieceCount(right) : 0;
  if (leftCount === null || rightCount === null) return false;
  return compressed ? leftCount + rightCount < 8 : leftCount === 8;
}

function dateValid(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

function timeValid(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const offsetHour = match[5] === undefined ? 0 : Number(match[5]);
  const offsetMinute = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return false;
  if (second !== 60) return true;
  const offset = (match[4] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const utcMinute = ((hour * 60 + minute - offset) % 1_440 + 1_440) % 1_440;
  return utcMinute === 23 * 60 + 59;
}

function hostnameValid(value: string): boolean {
  if (value.length > 253 || value.length === 0 || value.endsWith(".")) return false;
  return value.split(".").every((label) => label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
}

function emailValid(value: string): boolean {
  if (ENCODER.encode(value).byteLength > 254) return false;
  let separator = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === "@" && !quoted) {
      if (separator !== -1) return false;
      separator = index;
    }
  }
  if (quoted || escaped || separator <= 0) return false;
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  const addressLiteral = /^\[(?:IPv6:([^\]]+)|(\d+(?:\.\d+){3}))\]$/iu.exec(domain);
  if (ENCODER.encode(local).byteLength > 64 ||
      (!hostnameValid(domain) && !(addressLiteral && (addressLiteral[1] ? ipv6Valid(addressLiteral[1]) : ipv4Valid(addressLiteral[2]!))))) return false;
  if (/^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/u.test(local)) return true;
  return /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+)(?:\.(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+))*$/iu.test(local);
}

function uriValid(value: string): boolean {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/u.exec(value);
  if (!scheme || /[^\x21-\x7e]/u.test(value) || /%(?![0-9a-f]{2})/iu.test(value)) return false;
  let remainder = scheme[2]!;
  if ((remainder.match(/#/gu) ?? []).length > 1) return false;
  const hashIndex = remainder.indexOf("#");
  const fragment = hashIndex < 0 ? null : remainder.slice(hashIndex + 1);
  remainder = hashIndex < 0 ? remainder : remainder.slice(0, hashIndex);
  const queryIndex = remainder.indexOf("?");
  const query = queryIndex < 0 ? null : remainder.slice(queryIndex + 1);
  let path = queryIndex < 0 ? remainder : remainder.slice(0, queryIndex);
  const USERINFO = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}|[!$&'()*+,;=:])*$/u;
  const PATH = /^(?:(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}|[!$&'()*+,;=:@/]))*$/u;
  const QUERY = /^(?:(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}|[!$&'()*+,;=:@/?]))*$/u;
  if ((query !== null && !QUERY.test(query)) || (fragment !== null && !QUERY.test(fragment))) return false;
  if (path.startsWith("//")) {
    const slash = path.indexOf("/", 2);
    const authority = slash < 0 ? path.slice(2) : path.slice(2, slash);
    path = slash < 0 ? "" : path.slice(slash);
    const at = authority.lastIndexOf("@");
    if (at >= 0 && !USERINFO.test(authority.slice(0, at))) return false;
    const hostPort = authority.slice(at + 1);
    if (hostPort.startsWith("[")) {
      const close = hostPort.indexOf("]");
      if (close < 0) return false;
      const literal = hostPort.slice(1, close);
      const ipvFuture = /^v[0-9A-F]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/iu.test(literal);
      if (!ipvFuture && !ipv6Valid(literal)) return false;
      const suffix = hostPort.slice(close + 1);
      if (suffix !== "" && !/^:[0-9]*$/u.test(suffix)) return false;
    } else {
      const colon = hostPort.lastIndexOf(":");
      const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
      const port = colon < 0 ? null : hostPort.slice(colon + 1);
      if (host.includes(":") || (port !== null && !/^[0-9]*$/u.test(port)) ||
          !/^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}|[!$&'()*+,;=])*$/u.test(host)) return false;
    }
  } else if (path.startsWith("//")) {
    return false;
  }
  return PATH.test(path);
}

function dateTimeValid(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([zZ]|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !dateValid(match[1]!) || !timeValid(value.slice(11))) return false;
  if (Number(match[4]) !== 60) return true;
  const [year, month, day] = match[1]!.split("-").map(Number) as [number, number, number];
  if (year === 0) return false;
  const sign = match[6] === "-" ? -1 : 1;
  const offsetMinutes = match[5]!.toLowerCase() === "z" ? 0 : sign * (Number(match[7]) * 60 + Number(match[8]));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(Number(match[2]), Number(match[3]) - offsetMinutes, 59, 0);
  return date.getUTCHours() === 23 && date.getUTCMinutes() === 59 &&
    new Date(date.getTime() + 60_000).getUTCDate() === 1;
}

function formatValid(format: ConnectorSchemaV1["format"], value: string): boolean {
  if (!format) return true;
  if (format === "uuid") return value === "00000000-0000-0000-0000-000000000000" ||
    value.toLowerCase() === "ffffffff-ffff-ffff-ffff-ffffffffffff" ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
  if (format === "email") return emailValid(value);
  if (format === "hostname") return hostnameValid(value);
  if (format === "ipv4") return ipv4Valid(value);
  if (format === "ipv6") return ipv6Valid(value);
  if (format === "uri") return uriValid(value);
  if (format === "date") return dateValid(value);
  if (format === "time") return timeValid(value);
  return dateTimeValid(value);
}

function matches(schema: ConnectorSchemaV1, value: unknown, depth: number, budget: { values: number }): boolean {
  budget.values += 1;
  if (depth > CONNECTOR_IMPORT_V1_LIMITS.maxSchemaDepth || budget.values > CONNECTOR_IMPORT_V1_LIMITS.maxInspectedValues) return false;
  if (Array.isArray(schema.type) && value === null) return true;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) &&
    (type !== "integer" || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (type === "string") {
    if (typeof value !== "string") return false;
    const length = [...value].length;
    return length >= (schema.minLength ?? 0) && length <= (schema.maxLength ?? Infinity) && formatValid(schema.format, value);
  }
  if (type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) &&
    value.length <= (schema.maxItems ?? Infinity) && !!schema.items && value.every((item) => matches(schema.items!, item, depth + 1, budget));
  if (type !== "object" || value === null || typeof value !== "object" || Array.isArray(value) || schema.additionalProperties !== false || !schema.properties) return false;
  const own = descriptors(value);
  if (!own) return false;
  const keys = Object.keys(own);
  if (keys.some((key) => !Object.hasOwn(schema.properties!, key))) return false;
  if ((schema.required ?? []).some((key) => !Object.hasOwn(own, key))) return false;
  return keys.every((key) => matches(schema.properties![key]!, own[key]!.value, depth + 1, budget));
}

export function validateConnectorValue(schemaValue: unknown, value: unknown): boolean {
  try {
    const schema = parseConnectorSchemaV1(schemaValue);
    return inspectJson(value).ok && matches(schema, value, 0, { values: 0 });
  } catch {
    return false;
  }
}

export function buildApiOperationSimulationReceipt(input: ApiOperationSimulationReceiptInput): ApiOperationSimulationReceiptV1 {
  const receipt: ApiOperationSimulationReceiptV1 = {
    schemaVersion: 1,
    correlationId: input.correlationId,
    simulationId: input.simulationId,
    message: "Simulated locally. No request sent.",
    operation: {
      operationVersionId: input.operationVersionId,
      operationId: input.operationId,
      connectorProjectionHash: input.connectorProjectionHash,
      operationProjectionHash: input.operationProjectionHash,
      schemaHash: input.schemaHash,
      method: input.method,
      origin: input.origin,
      pathTemplate: input.pathTemplate,
      pathParameterNames: [...input.pathParameterNames],
      queryParameterNames: [...input.queryParameterNames],
      requestHeaderNames: [...input.requestHeaderNames],
      hasBody: input.hasBody,
      selectedStatus: input.selectedStatus,
      credentialPlaceholder: input.credentialPlaceholder,
    },
    systemPolicy: input.systemPolicy,
    authorAnnotation: input.authorAnnotation,
    execution: { plannedNodeCount: input.plannedNodeCount, completedNodeCount: input.completedNodeCount },
    egressCount: 0,
    costUsdc: 0,
    durationMs: input.durationMs,
  };
  if (ENCODER.encode(JSON.stringify(receipt)).byteLength > CONNECTOR_IMPORT_V1_LIMITS.maxTerminalReceiptBytes) {
    throw new TypeError(SIMULATION_REFUSED);
  }
  return deepFreeze(receipt);
}
