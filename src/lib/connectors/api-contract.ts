import { CONNECTOR_IMPORT_V1_LIMITS } from "./limits";
import type {
  ConnectorDefinitionHistoryOptions,
  ConnectorIdentityView,
  ConnectorListCursor,
  ConnectorListOptions,
  OperationVersionListCursor,
  OperationVersionListOptions,
  OperationVersionSummary,
} from "./repository";
import type {
  ConnectorSchemaV1,
  OperationAuthenticationV1,
  SystemPolicyV1,
  UnverifiedAuthorAnnotationV1,
} from "./types";

export const CONNECTOR_METADATA_BODY_LIMIT_BYTES = 64 * 1024;
export const CONNECTOR_SOURCE_BODY_LIMIT_BYTES = CONNECTOR_IMPORT_V1_LIMITS.maxInputBytes;
export const CONNECTOR_SOURCE_TRANSPORT_BODY_LIMIT_BYTES =
  (CONNECTOR_IMPORT_V1_LIMITS.maxInputBytes * 6) + (120 * 6) + 36 + 128;

export type ConnectorPrivateError =
  | "invalid request"
  | "authentication required"
  | "not found"
  | "conflict"
  | "payload too large"
  | "unsupported media type"
  | "import refused"
  | "rate limited"
  | "connector service unavailable";

export interface ConnectorPrivateErrorEnvelope {
  readonly error: ConnectorPrivateError;
  readonly correlationId?: string;
}
export interface ConnectorListEnvelope {
  readonly connectors: readonly ConnectorIdentityView[];
  readonly nextCursor: string | null;
}
export interface ConnectorDefinitionSummary {
  readonly id: string;
  readonly connectorId: string;
  readonly versionNumber: number;
  readonly connectorProjectionHash: string;
  readonly origin: string;
  readonly operationCount: number;
  readonly operations: readonly {
    readonly operationId: string;
    readonly method: OpenApiReviewOperation["method"];
    readonly path: string;
    readonly operationProjectionHash: string;
  }[];
  readonly executionAvailability: "simulation_only";
}
export interface ConnectorEnvelope {
  readonly connector: ConnectorIdentityView;
  readonly history: readonly ConnectorDefinitionSummary[];
  readonly nextCursor: string | null;
}
export interface RenameConnectorBody {
  readonly action: "rename";
  readonly displayLabel: string;
  readonly expectedLifecycleRevision: number;
}
export interface ArchiveConnectorBody {
  readonly action: "archive";
  readonly expectedLifecycleRevision: number;
}
export type ConnectorMutationBody = RenameConnectorBody | ArchiveConnectorBody;
export interface OpenApiReviewBody {
  readonly source: string;
  readonly displayLabel: string;
  readonly connectorId?: string;
}
export interface AddOperationBody {
  readonly connectorDefinitionVersionId: string;
  readonly operationId: string;
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
}
export interface ConnectorOperationSummary {
  readonly id: string;
  readonly connectorDefinitionVersionId: string;
  readonly operationId: string;
  readonly connectorProjectionHash: string;
  readonly operationProjectionHash: string;
  readonly schemaHash: string;
  readonly executionAvailability: "simulation_only";
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
}
export interface ConnectorOperationEnvelope {
  readonly operation: ConnectorOperationSummary;
  readonly disposition: "created" | "reused";
  readonly correlationId: string;
}
export type ConnectorOperationVersionSummary = OperationVersionSummary;
export interface ConnectorOperationsEnvelope {
  readonly operations: readonly ConnectorOperationVersionSummary[];
  readonly nextCursor: string | null;
}
export interface OpenApiReviewOperation {
  readonly operationId: string;
  readonly method: "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE";
  readonly path: string;
  readonly operationProjectionHash: string;
  readonly schemaHash: string;
}
export interface OpenApiReviewEnvelope {
  readonly review: {
    readonly correlationId: string;
    readonly identity: ConnectorIdentityView;
    readonly definition: {
      readonly id: string;
      readonly connectorId: string;
      readonly versionNumber: number;
      readonly connectorProjectionHash: string;
    };
    readonly identityDisposition: "created" | "reused";
    readonly definitionDisposition: "created" | "version-created" | "reused-current" | "reused-historical";
    readonly drift: null | {
      readonly before: { readonly versionId: string; readonly versionNumber: number; readonly connectorProjectionHash: string };
      readonly after: { readonly versionId: string; readonly versionNumber: number; readonly connectorProjectionHash: string };
    };
    readonly operations: readonly OpenApiReviewOperation[];
    readonly refusedOperationCount: number;
  };
}
export interface ResolveOperationsBody { readonly operationVersionIds: readonly string[] }
export interface OperationClosureProjection {
  readonly reference: {
    readonly connectorDefinitionVersionId: string;
    readonly operationVersionId: string;
    readonly operationId: string;
    readonly connectorProjectionHash: string;
    readonly operationProjectionHash: string;
    readonly schemaHash: string;
    readonly readinessBinding?:
      | { readonly kind: "connection"; readonly connectionId: string; readonly capability: "http.headers" }
      | { readonly kind: "unresolved"; readonly requirementKey: string; readonly capability: "http.headers" };
  };
  readonly connectorId: string;
  readonly connectorDisplayLabel: string;
  readonly lifecycleRevision: number;
  readonly archivedAt: number | null;
  readonly definitionVersionNumber: number;
  readonly method: OpenApiReviewOperation["method"];
  readonly path: string;
  readonly authentication: OperationAuthenticationV1;
  readonly requestSchema: ConnectorSchemaV1;
  readonly resultSchema: ConnectorSchemaV1;
  readonly systemPolicy: SystemPolicyV1;
  readonly authorAnnotation: UnverifiedAuthorAnnotationV1 | null;
  readonly executionAvailability: "simulation_only";
}
export interface OperationClosuresEnvelope { readonly closures: readonly OperationClosureProjection[] }

export const CONNECTOR_PRIVATE_ERROR_STATUS = Object.freeze({
  "invalid request": 400,
  "authentication required": 401,
  "not found": 404,
  "conflict": 409,
  "payload too large": 413,
  "unsupported media type": 415,
  "import refused": 422,
  "rate limited": 429,
  "connector service unavailable": 503,
} satisfies Record<ConnectorPrivateError, number>);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const FORBIDDEN_HEADERS = new Set([
  "__proto__", "accept", "authorization", "connection", "constructor",
  "content-length", "content-type", "cookie", "forwarded", "host",
  "keep-alive", "origin", "prototype", "proxy-authenticate",
  "proxy-authorization", "proxy-connection", "referer", "te", "trailer",
  "transfer-encoding", "upgrade", "user-agent", "via",
]);
const MAX_CURSOR_CHARACTERS = 4_096;
const MAX_ITEMS = 100;
const UTF8 = new TextEncoder();
const FORBIDDEN_RESPONSE_KEYS = new Set([
  "apikey", "authorization", "authtag", "body", "ciphertext", "default", "defaults",
  "example", "examples", "headers", "keyversion", "nonce", "password", "rawsource",
  "rejectedvalue", "rejectedvalues", "requestbody", "secret", "source", "token", "username", "values",
]);
const CREDENTIAL_SIGNATURES = [
  /(?:^|[^A-Za-z0-9_])Bearer[ \t]+\S+/iu,
  /(?:^|[^A-Za-z0-9_])Basic[ \t]+[A-Za-z0-9+/]+={0,2}(?=$|[^A-Za-z0-9+/=])/iu,
  /(?:^|[^A-Za-z0-9_])(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/iu,
  /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/iu,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/iu,
] as const;

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) return null;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function safeInteger(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && (allowZero ? (value as number) >= 0 : (value as number) >= 1);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !CONTROL.test(value) && UTF8.encode(value).byteLength <= maxBytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { return null; }
}

function encodeCursor(value: Readonly<object>): string {
  return encodeBase64Url(UTF8.encode(JSON.stringify(value)));
}

export function parseConnectorId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function identity(value: unknown): ConnectorIdentityView | null {
  const record = exactRecord(value, ["id", "displayLabel", "archivedAt", "lifecycleRevision", "createdAt", "updatedAt"]);
  if (!record || !parseConnectorId(record.id) || !boundedText(record.displayLabel, 120) ||
      (record.archivedAt !== null && !safeInteger(record.archivedAt, true)) ||
      !safeInteger(record.lifecycleRevision) || !safeInteger(record.createdAt, true) || !safeInteger(record.updatedAt, true)) return null;
  return Object.freeze({
    id: record.id as string,
    displayLabel: record.displayLabel as string,
    archivedAt: record.archivedAt as number | null,
    lifecycleRevision: record.lifecycleRevision as number,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  });
}

function canonicalCursor(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CURSOR_CHARACTERS || !CURSOR.test(value)) return null;
  try {
    const bytes = decodeBase64Url(value);
    if (!bytes || encodeBase64Url(bytes) !== value) return null;
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (encodeCursor(parsed as object) !== value) return null;
    return exactRecord(parsed, keys);
  } catch {
    return null;
  }
}

export function encodeConnectorListCursor(value: ConnectorListCursor | null): string | null {
  if (value === null) return null;
  if (!safeInteger(value.updatedAt, true) || !parseConnectorId(value.id)) return null;
  return encodeCursor({ updatedAt: value.updatedAt, id: value.id });
}

export function encodeConnectorHistoryCursor(value: number | null): string | null {
  if (value === null) return null;
  if (!safeInteger(value)) return null;
  return encodeCursor({ beforeVersionNumber: value });
}

export function encodeConnectorOperationListCursor(value: OperationVersionListCursor | null): string | null {
  if (value === null) return null;
  if (!safeInteger(value.createdAt, true) || !parseConnectorId(value.id)) return null;
  return encodeCursor({ createdAt: value.createdAt, id: value.id });
}

export function parseConnectorListPage(params: URLSearchParams): ConnectorListOptions | null {
  const allowed = new Set(["cursor", "limit", "search", "includeArchived"]);
  const keys = [...params.keys()];
  if (keys.some((key) => !allowed.has(key)) || [...allowed].some((key) => params.getAll(key).length > 1)) return null;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(rawLimit)) return null;
  const rawSearch = params.get("search");
  if (rawSearch !== null && !boundedText(rawSearch, 120)) return null;
  const rawArchived = params.get("includeArchived");
  if (rawArchived !== null && rawArchived !== "true" && rawArchived !== "false") return null;
  const rawCursor = params.get("cursor");
  let after: ConnectorListCursor | undefined;
  if (rawCursor !== null) {
    const record = canonicalCursor(rawCursor, ["updatedAt", "id"]);
    const id = record ? parseConnectorId(record.id) : null;
    if (!record || !safeInteger(record.updatedAt, true) || !id) return null;
    after = Object.freeze({ updatedAt: record.updatedAt, id });
  }
  return Object.freeze({
    limit: rawLimit === null ? 50 : Number(rawLimit),
    ...(rawSearch === null ? {} : { search: rawSearch.normalize("NFC") }),
    ...(rawArchived === null ? {} : { includeArchived: rawArchived === "true" }),
    ...(after === undefined ? {} : { after }),
  });
}

export function parseConnectorHistoryPage(params: URLSearchParams): ConnectorDefinitionHistoryOptions | null {
  const keys = [...params.keys()];
  if (keys.some((key) => key !== "cursor" && key !== "limit") || params.getAll("cursor").length > 1 || params.getAll("limit").length > 1) return null;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(rawLimit)) return null;
  const rawCursor = params.get("cursor");
  if (rawCursor === null) return Object.freeze({ limit: rawLimit === null ? 50 : Number(rawLimit) });
  const record = canonicalCursor(rawCursor, ["beforeVersionNumber"]);
  if (!record || !safeInteger(record.beforeVersionNumber)) return null;
  return Object.freeze({ limit: rawLimit === null ? 50 : Number(rawLimit), beforeVersionNumber: record.beforeVersionNumber });
}

export function parseConnectorOperationListPage(params: URLSearchParams): OperationVersionListOptions | null {
  const keys = [...params.keys()];
  if (keys.some((key) => key !== "cursor" && key !== "limit") ||
      params.getAll("cursor").length > 1 || params.getAll("limit").length > 1) return null;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(rawLimit)) return null;
  const rawCursor = params.get("cursor");
  if (rawCursor === null) return Object.freeze({ limit: rawLimit === null ? 50 : Number(rawLimit) });
  const record = canonicalCursor(rawCursor, ["createdAt", "id"]);
  const id = record ? parseConnectorId(record.id) : null;
  if (!record || !safeInteger(record.createdAt, true) || !id ||
      encodeConnectorOperationListCursor({ createdAt: record.createdAt, id }) !== rawCursor) return null;
  return Object.freeze({
    limit: rawLimit === null ? 50 : Number(rawLimit),
    after: Object.freeze({ createdAt: record.createdAt, id }),
  });
}

export function parseConnectorMutationBody(value: unknown): ConnectorMutationBody | null {
  const actionRecord = exactRecord(value, ["action", "expectedLifecycleRevision"], ["displayLabel"]);
  if (!actionRecord || !safeInteger(actionRecord.expectedLifecycleRevision)) return null;
  if (actionRecord.action === "archive") {
    if (Object.hasOwn(actionRecord, "displayLabel")) return null;
    return Object.freeze({ action: "archive", expectedLifecycleRevision: actionRecord.expectedLifecycleRevision });
  }
  if (actionRecord.action !== "rename" || !Object.hasOwn(actionRecord, "displayLabel") || !boundedText(actionRecord.displayLabel, 120)) return null;
  return Object.freeze({ action: "rename", displayLabel: actionRecord.displayLabel, expectedLifecycleRevision: actionRecord.expectedLifecycleRevision });
}

export function parseOpenApiReviewBody(value: unknown): OpenApiReviewBody | null {
  const record = exactRecord(value, ["source", "displayLabel"], ["connectorId"]);
  if (!record || typeof record.source !== "string" || UTF8.encode(record.source).byteLength > CONNECTOR_IMPORT_V1_LIMITS.maxInputBytes ||
      !boundedText(record.displayLabel, 120)) return null;
  if (Object.hasOwn(record, "connectorId") && !parseConnectorId(record.connectorId)) return null;
  return Object.freeze({
    source: record.source,
    displayLabel: record.displayLabel,
    ...(Object.hasOwn(record, "connectorId") ? { connectorId: record.connectorId as string } : {}),
  });
}

function parseAnnotation(value: unknown): UnverifiedAuthorAnnotationV1 | null {
  const record = exactRecord(value, ["label"], ["effectNote", "retryNote"]);
  if (!record || record.label !== "Unverified" || (!Object.hasOwn(record, "effectNote") && !Object.hasOwn(record, "retryNote"))) return null;
  if (Object.hasOwn(record, "effectNote") && !boundedText(record.effectNote, 512)) return null;
  if (Object.hasOwn(record, "retryNote") && !boundedText(record.retryNote, 512)) return null;
  return Object.freeze({
    label: "Unverified",
    ...(Object.hasOwn(record, "effectNote") ? { effectNote: record.effectNote as string } : {}),
    ...(Object.hasOwn(record, "retryNote") ? { retryNote: record.retryNote as string } : {}),
  });
}

export function parseAddOperationBody(value: unknown): AddOperationBody | null {
  const record = exactRecord(value, ["connectorDefinitionVersionId", "operationId"], ["authorAnnotation"]);
  if (!record || !parseConnectorId(record.connectorDefinitionVersionId) || !boundedText(record.operationId, 512)) return null;
  let annotation: UnverifiedAuthorAnnotationV1 | undefined;
  if (Object.hasOwn(record, "authorAnnotation")) {
    const parsed = parseAnnotation(record.authorAnnotation);
    if (!parsed) return null;
    annotation = parsed;
  }
  return Object.freeze({
    connectorDefinitionVersionId: record.connectorDefinitionVersionId as string,
    operationId: record.operationId as string,
    ...(annotation === undefined ? {} : { authorAnnotation: annotation }),
  });
}

export function parseResolveOperationsBody(value: unknown): ResolveOperationsBody | null {
  const record = exactRecord(value, ["operationVersionIds"]);
  if (!record || !Array.isArray(record.operationVersionIds) || record.operationVersionIds.length < 1 || record.operationVersionIds.length > 100) return null;
  const ids = record.operationVersionIds.map(parseConnectorId);
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) return null;
  return Object.freeze({ operationVersionIds: Object.freeze(ids as string[]) });
}

function recursivelySecretFree(value: unknown, schemaProjection = false): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "string") {
      const text = current.value;
      if (UTF8.encode(text).byteLength > CONNECTOR_IMPORT_V1_LIMITS.maxTerminalReceiptBytes ||
          CREDENTIAL_SIGNATURES.some((signature) => signature.test(text))) return false;
      continue;
    }
    if (current.value === null || typeof current.value === "boolean" || typeof current.value === "number") continue;
    if (typeof current.value !== "object" || current.depth > 32 || ++count > 10_000) return false;
    try {
      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(current.value).length !== 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      if (Array.isArray(current.value)) {
        const allowed = new Set([...current.value.keys()].map(String).concat("length"));
        if (Object.keys(descriptors).some((key) => !allowed.has(key))) return false;
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(current.value) && key === "length") continue;
        if (!("value" in descriptor) || !descriptor.enumerable ||
            (FORBIDDEN_RESPONSE_KEYS.has(key.toLowerCase()) && !schemaProjection)) return false;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } catch { return false; }
  }
  return true;
}

function serializedWithin(value: unknown, maxBytes: number): boolean {
  try { return UTF8.encode(JSON.stringify(value)).byteLength <= maxBytes; } catch { return false; }
}

function parseSchema(value: unknown, depth = 0, budget = { entries: 0 }): ConnectorSchemaV1 | null {
  if (depth > CONNECTOR_IMPORT_V1_LIMITS.maxSchemaDepth || ++budget.entries > 10_000) return null;
  const record = exactRecord(value, ["type"], [
    "properties", "required", "items", "additionalProperties", "minimum", "maximum",
    "minLength", "maxLength", "minItems", "maxItems", "format",
  ]);
  if (!record) return null;
  const scalar = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
  const typeValid = typeof record.type === "string"
    ? scalar.has(record.type)
    : Array.isArray(record.type) && record.type.length === 2 && typeof record.type[0] === "string" && scalar.has(record.type[0]) && record.type[0] !== "null" && record.type[1] === "null";
  if (!typeValid) return null;
  const base = Array.isArray(record.type) ? record.type[0] : record.type;
  const allowedByType: Record<string, readonly string[]> = {
    object: ["type", "properties", "required", "additionalProperties"],
    array: ["type", "items", "minItems", "maxItems"],
    string: ["type", "minLength", "maxLength", "format"],
    number: ["type", "minimum", "maximum"],
    integer: ["type", "minimum", "maximum"],
    boolean: ["type"],
    null: ["type"],
  };
  const allowed = new Set(allowedByType[String(base)]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (Object.hasOwn(record, "additionalProperties") && record.additionalProperties !== false) return null;
  for (const key of ["minimum", "maximum"] as const) {
    if (Object.hasOwn(record, key) && (typeof record[key] !== "number" || !Number.isFinite(record[key]))) return null;
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (Object.hasOwn(record, key) && !safeInteger(record[key], true)) return null;
  }
  if (Object.hasOwn(record, "format") && (typeof record.format !== "string" || !new Set([
    "date-time", "date", "time", "email", "hostname", "ipv4", "ipv6", "uri", "uuid",
  ]).has(record.format))) return null;
  const output: Record<string, unknown> = { type: record.type };
  if (Object.hasOwn(record, "properties")) {
    const properties = exactRecord(record.properties, [], Object.keys(record.properties as object));
    if (!properties || Object.keys(properties).length > 1_000) return null;
    const parsedProperties: Record<string, ConnectorSchemaV1> = Object.create(null) as Record<string, ConnectorSchemaV1>;
    for (const [key, child] of Object.entries(properties)) {
      if (!boundedText(key, 256) || key === "__proto__" || key === "constructor" || key === "prototype") return null;
      const parsed = parseSchema(child, depth + 1, budget);
      if (!parsed) return null;
      parsedProperties[key] = parsed;
    }
    output.properties = Object.freeze(parsedProperties);
  }
  if (Object.hasOwn(record, "required")) {
    if (!Array.isArray(record.required) || record.required.some((key) => typeof key !== "string") || new Set(record.required).size !== record.required.length) return null;
    output.required = Object.freeze([...record.required]);
  }
  if (base === "object") {
    if (!Object.hasOwn(record, "properties") || !Object.hasOwn(record, "required") || record.additionalProperties !== false) return null;
    const properties = output.properties as Readonly<Record<string, ConnectorSchemaV1>>;
    const required = output.required as readonly string[];
    if (required.some((key) => !Object.hasOwn(properties, key))) return null;
  } else if (base === "array") {
    if (!Object.hasOwn(record, "items") ||
        (Object.hasOwn(record, "minItems") && Object.hasOwn(record, "maxItems") && (record.minItems as number) > (record.maxItems as number))) return null;
  } else if (base === "string") {
    if (Object.hasOwn(record, "minLength") && Object.hasOwn(record, "maxLength") && (record.minLength as number) > (record.maxLength as number)) return null;
  } else if (base === "number" || base === "integer") {
    if (Object.hasOwn(record, "minimum") && Object.hasOwn(record, "maximum") && (record.minimum as number) > (record.maximum as number)) return null;
    if (base === "integer") {
      const low = Object.hasOwn(record, "minimum") ? Math.ceil(record.minimum as number) : Number.MIN_SAFE_INTEGER;
      const high = Object.hasOwn(record, "maximum") ? Math.floor(record.maximum as number) : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) return null;
    }
  }
  if (Object.hasOwn(record, "items")) {
    const items = parseSchema(record.items, depth + 1, budget);
    if (!items) return null;
    output.items = items;
  }
  for (const key of ["additionalProperties", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "format"] as const) {
    if (Object.hasOwn(record, key)) output[key] = record[key];
  }
  return Object.freeze(output) as unknown as ConnectorSchemaV1;
}

function parseAuthentication(value: unknown): OperationAuthenticationV1 | null {
  const kindRecord = exactRecord(value, ["kind"], ["headerName"]);
  if (!kindRecord) return null;
  if (kindRecord.kind === "api_key_header") {
    const headerName = Object.hasOwn(kindRecord, "headerName") ? parseHeaderName(kindRecord.headerName) : null;
    return headerName
      ? Object.freeze({ kind: "api_key_header", headerName })
      : null;
  }
  if ((kindRecord.kind === "none" || kindRecord.kind === "http_bearer" || kindRecord.kind === "http_basic") && !Object.hasOwn(kindRecord, "headerName")) {
    return Object.freeze({ kind: kindRecord.kind });
  }
  return null;
}

function parseHeaderName(value: unknown): string | null {
  if (!boundedText(value, 64) || !HEADER_TOKEN.test(value)) return null;
  const folded = value.toLowerCase();
  return FORBIDDEN_HEADERS.has(folded) || folded.startsWith("x-forwarded-") ? null : folded;
}

function schemaBaseType(schema: ConnectorSchemaV1): string {
  return typeof schema.type === "string" ? schema.type : schema.type[0];
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function operationPortSchemasValid(
  request: ConnectorSchemaV1,
  result: ConnectorSchemaV1,
  authentication: OperationAuthenticationV1,
): boolean {
  if (schemaBaseType(request) !== "object" || !request.properties || request.additionalProperties !== false) return false;
  const requestKeys = Object.keys(request.properties);
  if (!sameKeys(requestKeys.filter((key) => key !== "body"), ["path", "query", "headers"]) ||
      requestKeys.some((key) => !["path", "query", "headers", "body"].includes(key)) ||
      !(request.required ?? []).every((key) => requestKeys.includes(key)) ||
      !["path", "query", "headers"].every((key) => (request.required ?? []).includes(key))) return false;
  for (const namespace of ["path", "query", "headers"] as const) {
    const schema = request.properties[namespace];
    if (!schema || schemaBaseType(schema) !== "object" || schema.additionalProperties !== false) return false;
  }
  const credentialHeader = authentication.kind === "api_key_header"
    ? authentication.headerName
    : authentication.kind === "http_bearer" || authentication.kind === "http_basic"
      ? "authorization"
      : null;
  const foldedHeaders = new Set<string>();
  for (const headerName of Object.keys(request.properties.headers!.properties ?? {})) {
    const folded = parseHeaderName(headerName);
    if (!folded || foldedHeaders.has(folded) || folded === credentialHeader) return false;
    foldedHeaders.add(folded);
  }

  if (schemaBaseType(result) !== "object" || !result.properties || result.additionalProperties !== false ||
      !sameKeys(Object.keys(result.properties), ["status", "body"]) ||
      !sameKeys(result.required ?? [], ["status", "body"])) return false;
  const status = result.properties.status;
  const body = result.properties.body;
  if (!status || !body || status.type !== "integer" || status.minimum !== status.maximum ||
      !Number.isSafeInteger(status.minimum) || (status.minimum as number) < 200 || (status.minimum as number) > 299) return false;
  return status.minimum === 204 ? body.type === "null" : schemaBaseType(body) !== "null";
}

export function parseOperationClosuresEnvelope(value: unknown): OperationClosuresEnvelope | null {
  if (!recursivelySecretFree(value, true) || !serializedWithin(value, 256 * 1024)) return null;
  const outer = exactRecord(value, ["closures"]);
  if (!outer || !Array.isArray(outer.closures) || outer.closures.length < 1 || outer.closures.length > 100) return null;
  const closures: OperationClosureProjection[] = [];
  const ids = new Set<string>();
  for (const raw of outer.closures) {
    const record = exactRecord(raw, [
      "reference", "connectorId", "connectorDisplayLabel", "lifecycleRevision", "archivedAt", "definitionVersionNumber",
      "method", "path", "authentication", "requestSchema", "resultSchema", "systemPolicy", "authorAnnotation", "executionAvailability",
    ]);
    const reference = record && exactRecord(record.reference, [
      "connectorDefinitionVersionId", "operationVersionId", "operationId", "connectorProjectionHash", "operationProjectionHash", "schemaHash",
    ], ["readinessBinding"]);
    if (!record || !reference || !parseConnectorId(record.connectorId) || !boundedText(record.connectorDisplayLabel, 120) ||
        !parseConnectorId(reference.connectorDefinitionVersionId) ||
        !parseConnectorId(reference.operationVersionId) || ids.has(reference.operationVersionId as string) ||
        !safeInteger(record.lifecycleRevision) || (record.archivedAt !== null && !safeInteger(record.archivedAt, true)) ||
        !safeInteger(record.definitionVersionNumber) || !boundedText(reference.operationId, 512) ||
        typeof reference.connectorProjectionHash !== "string" || !SHA256.test(reference.connectorProjectionHash) ||
        typeof reference.operationProjectionHash !== "string" || !SHA256.test(reference.operationProjectionHash) ||
        typeof reference.schemaHash !== "string" || !SHA256.test(reference.schemaHash) ||
        !new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]).has(record.method as string) ||
        !boundedText(record.path, 8_192) || record.executionAvailability !== "simulation_only") return null;
    const authentication = parseAuthentication(record.authentication);
    const requestSchema = parseSchema(record.requestSchema);
    const resultSchema = parseSchema(record.resultSchema);
    const policy = exactRecord(record.systemPolicy, ["effects", "retry", "cost", "idempotency"]);
    if (!authentication || !requestSchema || !resultSchema || !operationPortSchemasValid(requestSchema, resultSchema, authentication) ||
        !policy || !Array.isArray(policy.effects) || policy.effects.length !== 1 ||
        policy.effects[0] !== "write" || policy.retry !== "unsafe" || policy.cost !== "unknown" || policy.idempotency !== "none") return null;
    const annotation = record.authorAnnotation === null ? null : parseAnnotation(record.authorAnnotation);
    if (record.authorAnnotation !== null && !annotation) return null;
    let readinessBinding: OperationClosureProjection["reference"]["readinessBinding"];
    if (Object.hasOwn(reference, "readinessBinding")) {
      const discriminator = exactRecord(reference.readinessBinding, ["kind", "capability"], ["connectionId", "requirementKey"]);
      if (!discriminator || discriminator.capability !== "http.headers") return null;
      if (discriminator.kind === "connection") {
        const binding = exactRecord(reference.readinessBinding, ["kind", "connectionId", "capability"]);
        if (!binding || !boundedText(binding.connectionId, 512)) return null;
        readinessBinding = Object.freeze({ kind: "connection", connectionId: binding.connectionId, capability: "http.headers" });
      } else if (discriminator.kind === "unresolved") {
        const binding = exactRecord(reference.readinessBinding, ["kind", "requirementKey", "capability"]);
        if (!binding || !boundedText(binding.requirementKey, 512)) return null;
        readinessBinding = Object.freeze({ kind: "unresolved", requirementKey: binding.requirementKey, capability: "http.headers" });
      } else {
        return null;
      }
    }
    if (authentication.kind === "none" && readinessBinding !== undefined) return null;
    ids.add(reference.operationVersionId as string);
    closures.push(Object.freeze({
      reference: Object.freeze({
        connectorDefinitionVersionId: reference.connectorDefinitionVersionId as string,
        operationVersionId: reference.operationVersionId as string,
        operationId: reference.operationId as string,
        connectorProjectionHash: reference.connectorProjectionHash,
        operationProjectionHash: reference.operationProjectionHash,
        schemaHash: reference.schemaHash,
        ...(readinessBinding === undefined ? {} : { readinessBinding }),
      }),
      connectorId: record.connectorId as string,
      connectorDisplayLabel: record.connectorDisplayLabel as string,
      lifecycleRevision: record.lifecycleRevision as number,
      archivedAt: record.archivedAt as number | null,
      definitionVersionNumber: record.definitionVersionNumber as number,
      method: record.method as OpenApiReviewOperation["method"],
      path: record.path as string,
      authentication,
      requestSchema,
      resultSchema,
      systemPolicy: Object.freeze({ effects: Object.freeze(["write"] as ["write"]), retry: "unsafe", cost: "unknown", idempotency: "none" }),
      authorAnnotation: annotation,
      executionAvailability: "simulation_only",
    }));
  }
  return Object.freeze({ closures: Object.freeze(closures) });
}

function listCursorIsCanonical(value: unknown): value is string | null {
  if (value === null) return true;
  const record = canonicalCursor(value, ["updatedAt", "id"]);
  const id = record ? parseConnectorId(record.id) : null;
  return !!record && safeInteger(record.updatedAt, true) && !!id &&
    encodeConnectorListCursor({ updatedAt: record.updatedAt, id }) === value;
}

function historyCursorIsCanonical(value: unknown): value is string | null {
  if (value === null) return true;
  const record = canonicalCursor(value, ["beforeVersionNumber"]);
  return !!record && safeInteger(record.beforeVersionNumber) && encodeConnectorHistoryCursor(record.beforeVersionNumber) === value;
}

function operationCursorIsCanonical(value: unknown): value is string | null {
  if (value === null) return true;
  const record = canonicalCursor(value, ["createdAt", "id"]);
  const id = record ? parseConnectorId(record.id) : null;
  return !!record && safeInteger(record.createdAt, true) && !!id &&
    encodeConnectorOperationListCursor({ createdAt: record.createdAt, id }) === value;
}

export function parseConnectorListEnvelope(value: unknown): ConnectorListEnvelope | null {
  if (!recursivelySecretFree(value) || !serializedWithin(value, 256 * 1024)) return null;
  const record = exactRecord(value, ["connectors", "nextCursor"]);
  if (!record || !Array.isArray(record.connectors) || record.connectors.length > MAX_ITEMS || !listCursorIsCanonical(record.nextCursor)) return null;
  const connectors = record.connectors.map(identity);
  if (connectors.some((item) => item === null)) return null;
  return Object.freeze({ connectors: Object.freeze(connectors as ConnectorIdentityView[]), nextCursor: record.nextCursor });
}

function definitionSummary(value: unknown): ConnectorDefinitionSummary | null {
  const record = exactRecord(value, ["id", "connectorId", "versionNumber", "connectorProjectionHash", "origin", "operationCount", "operations", "executionAvailability"]);
  if (!record || !parseConnectorId(record.id) || !parseConnectorId(record.connectorId) || !safeInteger(record.versionNumber) ||
      typeof record.connectorProjectionHash !== "string" || !SHA256.test(record.connectorProjectionHash) ||
      !boundedText(record.origin, 2_048) || !safeInteger(record.operationCount) || record.operationCount > CONNECTOR_IMPORT_V1_LIMITS.maxOperations ||
      !Array.isArray(record.operations) || record.operations.length !== record.operationCount ||
      record.executionAvailability !== "simulation_only") return null;
  try {
    const origin = new URL(record.origin);
    if (origin.protocol !== "https:" || origin.origin !== record.origin) return null;
  } catch { return null; }
  const operations = record.operations.map((value) => {
    const operation = exactRecord(value, ["operationId", "method", "path", "operationProjectionHash"]);
    return operation && boundedText(operation.operationId, 512) &&
      new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]).has(operation.method as string) &&
      boundedText(operation.path, 8_192) && typeof operation.operationProjectionHash === "string" && SHA256.test(operation.operationProjectionHash)
      ? Object.freeze(operation as unknown as ConnectorDefinitionSummary["operations"][number])
      : null;
  });
  if (operations.some((operation) => operation === null) || new Set(operations.map((operation) => operation?.operationId)).size !== operations.length) return null;
  return Object.freeze({ ...record, operations: Object.freeze(operations) } as unknown as ConnectorDefinitionSummary);
}

export function parseConnectorEnvelope(value: unknown): ConnectorEnvelope | null {
  if (!recursivelySecretFree(value) || !serializedWithin(value, 256 * 1024)) return null;
  const record = exactRecord(value, ["connector", "history", "nextCursor"]);
  const connector = record ? identity(record.connector) : null;
  if (!record || !connector || !Array.isArray(record.history) || record.history.length > MAX_ITEMS || !historyCursorIsCanonical(record.nextCursor)) return null;
  const history = record.history.map(definitionSummary);
  if (history.some((item) => item === null || item.connectorId !== connector.id)) return null;
  return Object.freeze({ connector, history: Object.freeze(history as ConnectorDefinitionSummary[]), nextCursor: record.nextCursor });
}

function operationVersionSummary(value: unknown): ConnectorOperationVersionSummary | null {
  const record = exactRecord(value, [
    "operationVersionId", "connectorDefinitionVersionId", "definitionVersionNumber", "operationId",
    "connectorProjectionHash", "operationProjectionHash", "schemaHash", "executionAvailability",
  ], ["authorAnnotation"]);
  if (!record || !parseConnectorId(record.operationVersionId) ||
      !parseConnectorId(record.connectorDefinitionVersionId) || !safeInteger(record.definitionVersionNumber) ||
      !boundedText(record.operationId, 512) || typeof record.connectorProjectionHash !== "string" ||
      !SHA256.test(record.connectorProjectionHash) || typeof record.operationProjectionHash !== "string" ||
      !SHA256.test(record.operationProjectionHash) || typeof record.schemaHash !== "string" ||
      !SHA256.test(record.schemaHash) || record.executionAvailability !== "simulation_only") return null;
  const authorAnnotation = Object.hasOwn(record, "authorAnnotation")
    ? parseAnnotation(record.authorAnnotation)
    : undefined;
  if (Object.hasOwn(record, "authorAnnotation") && !authorAnnotation) return null;
  return Object.freeze({
    operationVersionId: record.operationVersionId as string,
    connectorDefinitionVersionId: record.connectorDefinitionVersionId as string,
    definitionVersionNumber: record.definitionVersionNumber as number,
    operationId: record.operationId as string,
    connectorProjectionHash: record.connectorProjectionHash,
    operationProjectionHash: record.operationProjectionHash,
    schemaHash: record.schemaHash,
    executionAvailability: "simulation_only",
    ...(authorAnnotation === undefined ? {} : { authorAnnotation }),
  }) as ConnectorOperationVersionSummary;
}

export function parseConnectorOperationsEnvelope(value: unknown): ConnectorOperationsEnvelope | null {
  if (!recursivelySecretFree(value) || !serializedWithin(value, 256 * 1024)) return null;
  const record = exactRecord(value, ["operations", "nextCursor"]);
  if (!record || !Array.isArray(record.operations) || record.operations.length > MAX_ITEMS ||
      !operationCursorIsCanonical(record.nextCursor)) return null;
  const operations = record.operations.map(operationVersionSummary);
  if (operations.some((item) => item === null) ||
      new Set(operations.map((item) => item?.operationVersionId)).size !== operations.length) return null;
  return Object.freeze({
    operations: Object.freeze(operations as ConnectorOperationVersionSummary[]),
    nextCursor: record.nextCursor,
  });
}

function driftVersion(value: unknown): { versionId: string; versionNumber: number; connectorProjectionHash: string } | null {
  const record = exactRecord(value, ["versionId", "versionNumber", "connectorProjectionHash"]);
  if (!record || !parseConnectorId(record.versionId) || !safeInteger(record.versionNumber) || typeof record.connectorProjectionHash !== "string" || !SHA256.test(record.connectorProjectionHash)) return null;
  return Object.freeze(record as { versionId: string; versionNumber: number; connectorProjectionHash: string });
}

function reviewOperation(value: unknown): OpenApiReviewOperation | null {
  const record = exactRecord(value, ["operationId", "method", "path", "operationProjectionHash", "schemaHash"]);
  const methods = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);
  if (!record || !boundedText(record.operationId, 512) || !methods.has(record.method as string) || !boundedText(record.path, 8_192) ||
      typeof record.operationProjectionHash !== "string" || !SHA256.test(record.operationProjectionHash) || typeof record.schemaHash !== "string" || !SHA256.test(record.schemaHash)) return null;
  return Object.freeze(record as unknown as OpenApiReviewOperation);
}

export function parseOpenApiReviewEnvelope(value: unknown): OpenApiReviewEnvelope | null {
  if (!recursivelySecretFree(value) || !serializedWithin(value, CONNECTOR_IMPORT_V1_LIMITS.maxTerminalReceiptBytes)) return null;
  const outer = exactRecord(value, ["review"]);
  const record = outer && exactRecord(outer.review, [
    "correlationId", "identity", "definition", "identityDisposition", "definitionDisposition", "drift", "operations", "refusedOperationCount",
  ]);
  if (!record || !parseConnectorId(record.correlationId)) return null;
  const parsedIdentity = identity(record.identity);
  const definition = exactRecord(record.definition, ["id", "connectorId", "versionNumber", "connectorProjectionHash"]);
  if (!parsedIdentity || !definition || !parseConnectorId(definition.id) || definition.connectorId !== parsedIdentity.id ||
      !safeInteger(definition.versionNumber) || typeof definition.connectorProjectionHash !== "string" || !SHA256.test(definition.connectorProjectionHash)) return null;
  if ((record.identityDisposition !== "created" && record.identityDisposition !== "reused") ||
      !["created", "version-created", "reused-current", "reused-historical"].includes(record.definitionDisposition as string) ||
      !Array.isArray(record.operations) || record.operations.length > CONNECTOR_IMPORT_V1_LIMITS.maxOperations || !safeInteger(record.refusedOperationCount, true)) return null;
  const operations = record.operations.map(reviewOperation);
  if (operations.some((item) => item === null)) return null;
  let drift: OpenApiReviewEnvelope["review"]["drift"] = null;
  if (record.drift !== null) {
    const rawDrift = exactRecord(record.drift, ["before", "after"]);
    const before = rawDrift ? driftVersion(rawDrift.before) : null;
    const after = rawDrift ? driftVersion(rawDrift.after) : null;
    if (!before || !after) return null;
    drift = Object.freeze({ before, after });
  }
  return Object.freeze({ review: Object.freeze({
    correlationId: record.correlationId as string,
    identity: parsedIdentity,
    definition: Object.freeze(definition as unknown as OpenApiReviewEnvelope["review"]["definition"]),
    identityDisposition: record.identityDisposition as "created" | "reused",
    definitionDisposition: record.definitionDisposition as OpenApiReviewEnvelope["review"]["definitionDisposition"],
    drift,
    operations: Object.freeze(operations as OpenApiReviewOperation[]),
    refusedOperationCount: record.refusedOperationCount as number,
  }) });
}

export function parseConnectorOperationSummary(value: unknown): ConnectorOperationSummary | null {
  if (!recursivelySecretFree(value)) return null;
  const operation = exactRecord(value, [
    "id", "connectorDefinitionVersionId", "operationId", "connectorProjectionHash", "operationProjectionHash", "schemaHash", "executionAvailability",
  ], ["authorAnnotation"]);
  if (!operation || !parseConnectorId(operation.id) || !parseConnectorId(operation.connectorDefinitionVersionId) || !boundedText(operation.operationId, 512) ||
      typeof operation.connectorProjectionHash !== "string" || !SHA256.test(operation.connectorProjectionHash) ||
      typeof operation.operationProjectionHash !== "string" || !SHA256.test(operation.operationProjectionHash) ||
      typeof operation.schemaHash !== "string" || !SHA256.test(operation.schemaHash) || operation.executionAvailability !== "simulation_only") return null;
  const annotation = Object.hasOwn(operation, "authorAnnotation") ? parseAnnotation(operation.authorAnnotation) : undefined;
  if (Object.hasOwn(operation, "authorAnnotation") && !annotation) return null;
  return Object.freeze({
    id: operation.id as string,
    connectorDefinitionVersionId: operation.connectorDefinitionVersionId as string,
    operationId: operation.operationId as string,
    connectorProjectionHash: operation.connectorProjectionHash,
    operationProjectionHash: operation.operationProjectionHash,
    schemaHash: operation.schemaHash,
    executionAvailability: "simulation_only",
    ...(annotation === undefined ? {} : { authorAnnotation: annotation }),
  }) as ConnectorOperationSummary;
}

export function parseConnectorOperationEnvelope(value: unknown): ConnectorOperationEnvelope | null {
  if (!recursivelySecretFree(value) || !serializedWithin(value, CONNECTOR_IMPORT_V1_LIMITS.maxTerminalReceiptBytes)) return null;
  const record = exactRecord(value, ["operation", "disposition", "correlationId"]);
  const operation = record ? parseConnectorOperationSummary(record.operation) : null;
  if (!record || !operation || !parseConnectorId(record.correlationId) || (record.disposition !== "created" && record.disposition !== "reused")) return null;
  return Object.freeze({ operation, disposition: record.disposition, correlationId: record.correlationId } as ConnectorOperationEnvelope);
}

export function parseConnectorPrivateErrorEnvelope(value: unknown): ConnectorPrivateErrorEnvelope | null {
  const record = exactRecord(value, ["error"], ["correlationId"]);
  if (!record || typeof record.error !== "string" || !Object.hasOwn(CONNECTOR_PRIVATE_ERROR_STATUS, record.error)) return null;
  if (!Object.hasOwn(record, "correlationId")) return Object.freeze({ error: record.error as ConnectorPrivateError });
  const correlationId = parseConnectorId(record.correlationId);
  return correlationId
    ? Object.freeze({ error: record.error as ConnectorPrivateError, correlationId })
    : null;
}

type PreflightFailure = Readonly<{ ok: false; status: number; error: ConnectorPrivateErrorEnvelope }>;
type PreflightContext<Provider> = Readonly<{ ok: true; ownerId: string; provider: Provider }>;

function failure(error: ConnectorPrivateError): PreflightFailure {
  return Object.freeze({ ok: false, status: CONNECTOR_PRIVATE_ERROR_STATUS[error], error: Object.freeze({ error }) });
}

function requestShapeFailure(request: Request, mutation: boolean): PreflightFailure | null {
  if (request.headers.has("authorization")) return failure("invalid request");
  if (mutation) {
    const contentType = request.headers.get("content-type")?.toLowerCase();
    if (contentType !== "application/json" && contentType !== "application/json; charset=utf-8") return failure("unsupported media type");
    const encoding = request.headers.get("content-encoding")?.toLowerCase();
    if (encoding !== undefined && encoding !== "identity") return failure("unsupported media type");
  }
  let origin: string;
  try { origin = new URL(request.url).origin; } catch { return failure("invalid request"); }
  const requestOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (mutation && (requestOrigin === null || fetchSite === null)) return failure("invalid request");
  if (requestOrigin !== null && requestOrigin !== origin) return failure("invalid request");
  if (fetchSite !== null && fetchSite !== "same-origin") return failure("invalid request");
  return null;
}

async function resolvePrivateContext<Provider>(input: {
  resolveOwner: () => Promise<string | null>;
  resolveProvider: () => Promise<Provider | null>;
}): Promise<PreflightContext<Provider> | PreflightFailure> {
  let ownerId: string | null;
  try { ownerId = await input.resolveOwner(); } catch { return failure("authentication required"); }
  if (typeof ownerId !== "string" || ownerId.length === 0) return failure("authentication required");
  let provider: Provider | null;
  try { provider = await input.resolveProvider(); } catch { return failure("connector service unavailable"); }
  if (provider === null || provider === undefined) return failure("connector service unavailable");
  return Object.freeze({ ok: true, ownerId, provider });
}

export async function readBoundedConnectorRequestJson(request: Request, maxBytes: number): Promise<Readonly<{ ok: true; value: unknown }> | PreflightFailure> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) return failure("invalid request");
    if (Number(declared) > maxBytes) return failure("payload too large");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const body = request.body;
    if (!body) return failure("invalid request");
    reader = body.getReader();
  } catch { return failure("invalid request"); }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return failure("payload too large");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return Object.freeze({ ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown });
  } catch { return failure("invalid request"); }
  finally { try { reader.releaseLock(); } catch { /* fixed result selected */ } }
}

export async function preflightConnectorMutation<Body, Provider>(input: {
  readonly enabled: boolean;
  readonly request: Request;
  readonly resolveOwner: () => Promise<string | null>;
  readonly resolveProvider: () => Promise<Provider | null>;
  readonly parseBody: (value: unknown) => Body | null;
  readonly maxBytes?: number;
}): Promise<(PreflightContext<Provider> & { readonly body: Body }) | PreflightFailure> {
  if (!input.enabled) return failure("not found");
  const shape = requestShapeFailure(input.request, true);
  if (shape) return shape;
  const context = await resolvePrivateContext(input);
  if (!context.ok) return context;
  const decoded = await readBoundedConnectorRequestJson(input.request, input.maxBytes ?? CONNECTOR_METADATA_BODY_LIMIT_BYTES);
  if (!decoded.ok) return decoded;
  let body: Body | null;
  try { body = input.parseBody(decoded.value); } catch { body = null; }
  return body === null || body === undefined ? failure("invalid request") : Object.freeze({ ...context, body });
}

export async function preflightConnectorRead<Provider>(input: {
  readonly enabled: boolean;
  readonly request: Request;
  readonly resolveOwner: () => Promise<string | null>;
  readonly resolveProvider: () => Promise<Provider | null>;
}): Promise<PreflightContext<Provider> | PreflightFailure> {
  if (!input.enabled) return failure("not found");
  const shape = requestShapeFailure(input.request, false);
  return shape ?? resolvePrivateContext(input);
}

/** Exact private, no-store response builder shared by Connector Lab routes. */
export function connectorPrivateJson(body: Readonly<object>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" },
  });
}
