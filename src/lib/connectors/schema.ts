import { createHash } from "node:crypto";
import type { JsonPrimitive, JsonValue } from "@/lib/flow/types";
import { CONNECTOR_IMPORT_V1_LIMITS } from "./limits";
import type {
  ConnectorDefinitionProjectionV1,
  ConnectorDefinitionVersionV1,
  ConnectorOperationIndexEntryV1,
  ConnectorSchemaNonNullType,
  ConnectorSchemaType,
  ConnectorSchemaV1,
  ConnectorStringFormat,
  OperationAuthenticationV1,
  OperationProjectionV1,
  OperationRequestV1,
  OperationResultV1,
  OperationVersionV1,
  SystemPolicyV1,
  UnverifiedAuthorAnnotationV1,
} from "./types";

export const CONNECTOR_CONTRACT_ERROR = "Invalid connector contract";
export const CONNECTOR_SCHEMA_ERROR = "Invalid connector schema";
export const SCHEMA_UNSATISFIABLE = "SCHEMA_UNSATISFIABLE";

export const CONNECTOR_SYSTEM_POLICY_V1: SystemPolicyV1 = Object.freeze({
  effects: Object.freeze(["write"] as ["write"]),
  retry: "unsafe",
  cost: "unknown",
  idempotency: "none",
});

const CONTROL = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MAX_HEADER_NAME_CHARACTERS = 64;
const FORBIDDEN_HEADERS = new Set([
  "__proto__", "accept", "authorization", "connection", "constructor",
  "content-length", "content-type", "cookie", "forwarded", "host",
  "keep-alive", "origin", "prototype", "proxy-authenticate",
  "proxy-authorization", "proxy-connection", "referer", "te", "trailer",
  "transfer-encoding", "upgrade", "user-agent", "via",
]);
const HTTP_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);
const FORMATS = new Set<ConnectorStringFormat>([
  "date-time", "date", "time", "email", "hostname", "ipv4", "ipv6", "uri", "uuid",
]);
const NON_NULL_TYPES = new Set<ConnectorSchemaNonNullType>([
  "object", "array", "string", "number", "integer", "boolean",
]);
const INTERNAL_ORIGIN_SUFFIXES = new Set([
  "local", "internal", "localhost", "localdomain", "home", "lan", "intranet", "corp", "test", "invalid", "example",
]);

function invalidContract(): never {
  throw new TypeError(CONNECTOR_CONTRACT_ERROR);
}

function invalidSchema(message = CONNECTOR_SCHEMA_ERROR): never {
  throw new TypeError(message);
}

function descriptors(value: unknown, error: () => never): PropertyDescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) error();
  let prototype: object | null;
  let result: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    result = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    error();
  }
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length !== 0) error();
  return result;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  error: () => never = invalidContract,
): Record<string, unknown> {
  const source = descriptors(value, error);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(source);
  if (required.some((key) => !Object.hasOwn(source, key)) || keys.some((key) => !allowed.has(key))) error();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = source[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) error();
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown, maximum: number, error: () => never): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) error();
  const source = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) error();
  const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (Object.keys(source).some((key) => !allowed.has(key))) error();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = source[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) error();
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, maximumBytes: number, error: () => never = invalidContract): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL.test(value)) error();
  const normalized = value.normalize("NFC");
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) error();
  return normalized;
}

function nonNegativeInteger(value: unknown, error: () => never = invalidSchema): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) error();
  return value as number;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidSchema();
  return Object.is(value, -0) ? 0 : value;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if ("value" in descriptor && descriptor.value !== null && typeof descriptor.value === "object") {
        pending.push(descriptor.value as object);
      }
    }
    Object.freeze(current);
  }
  return value;
}

function parseSchemaType(value: unknown): { readonly type: ConnectorSchemaType; readonly base: ConnectorSchemaType } {
  if (typeof value === "string") {
    if (value === "null" || NON_NULL_TYPES.has(value as ConnectorSchemaNonNullType)) {
      return { type: value as ConnectorSchemaType, base: value as ConnectorSchemaType };
    }
    return invalidSchema();
  }
  const values = exactArray(value, 2, invalidSchema);
  if (values.length !== 2 || values.filter((entry) => entry === "null").length !== 1) invalidSchema();
  const base = values.find((entry) => entry !== "null");
  if (typeof base !== "string" || !NON_NULL_TYPES.has(base as ConnectorSchemaNonNullType)) invalidSchema();
  return { type: Object.freeze([base, "null"] as [ConnectorSchemaNonNullType, "null"]), base: base as ConnectorSchemaNonNullType };
}

interface SchemaBudget { values: number }

function parseSchema(value: unknown, depth: number, budget: SchemaBudget): ConnectorSchemaV1 {
  if (depth > CONNECTOR_IMPORT_V1_LIMITS.maxSchemaDepth) invalidSchema("Connector schema depth exceeded");
  budget.values += 1;
  if (budget.values > CONNECTOR_IMPORT_V1_LIMITS.maxInspectedValues) invalidSchema("Connector schema value limit exceeded");
  const source = descriptors(value, invalidSchema);
  const typeDescriptor = source.type;
  if (!typeDescriptor || !("value" in typeDescriptor) || !typeDescriptor.enumerable) invalidSchema();
  const parsedType = parseSchemaType(typeDescriptor.value);
  const base = parsedType.base;
  const keysByType: Record<string, readonly string[]> = {
    object: ["type", "properties", "required", "additionalProperties"],
    array: ["type", "items", "minItems", "maxItems"],
    string: ["type", "minLength", "maxLength", "format"],
    number: ["type", "minimum", "maximum"],
    integer: ["type", "minimum", "maximum"],
    boolean: ["type"],
    null: ["type"],
  };
  const allowed = new Set(keysByType[String(base)]);
  if (Object.keys(source).some((key) => !allowed.has(key))) invalidSchema();
  const raw = exactRecord(value, ["type"], [...allowed].filter((key) => key !== "type"), invalidSchema);
  const result: Record<string, unknown> = { type: parsedType.type };

  if (base === "object") {
    if (!Object.hasOwn(raw, "properties") || !Object.hasOwn(raw, "required") || raw.additionalProperties !== false) {
      invalidSchema('Invalid connector schema: object requires additionalProperties: false');
    }
    const propertySource = descriptors(raw.properties, invalidSchema);
    const properties = Object.create(null) as Record<string, ConnectorSchemaV1>;
    const normalizedPropertyNames = new Set<string>();
    for (const key of Object.keys(propertySource).sort()) {
      const descriptor = propertySource[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidSchema();
      const normalized = text(key, 256, invalidSchema);
      if (normalizedPropertyNames.has(normalized)) invalidSchema();
      normalizedPropertyNames.add(normalized);
      Object.defineProperty(properties, normalized, {
        value: parseSchema(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true,
      });
    }
    const rawRequired = exactArray(raw.required, CONNECTOR_IMPORT_V1_LIMITS.maxInspectedValues, invalidSchema);
    const required = rawRequired.map((entry) => text(entry, 256, invalidSchema)).sort();
    if (new Set(required).size !== required.length || required.some((key) => !Object.hasOwn(properties, key))) {
      invalidSchema(SCHEMA_UNSATISFIABLE);
    }
    result.properties = properties;
    result.required = required;
    result.additionalProperties = false;
  } else if (base === "array") {
    if (!Object.hasOwn(raw, "items")) invalidSchema();
    result.items = parseSchema(raw.items, depth + 1, budget);
    if (Object.hasOwn(raw, "minItems")) result.minItems = nonNegativeInteger(raw.minItems);
    if (Object.hasOwn(raw, "maxItems")) result.maxItems = nonNegativeInteger(raw.maxItems);
    if ((result.minItems as number | undefined) !== undefined && (result.maxItems as number | undefined) !== undefined &&
        (result.minItems as number) > (result.maxItems as number)) invalidSchema(SCHEMA_UNSATISFIABLE);
  } else if (base === "string") {
    if (Object.hasOwn(raw, "minLength")) result.minLength = nonNegativeInteger(raw.minLength);
    if (Object.hasOwn(raw, "maxLength")) result.maxLength = nonNegativeInteger(raw.maxLength);
    if ((result.minLength as number | undefined) !== undefined && (result.maxLength as number | undefined) !== undefined &&
        (result.minLength as number) > (result.maxLength as number)) invalidSchema(SCHEMA_UNSATISFIABLE);
    if (Object.hasOwn(raw, "format")) {
      if (typeof raw.format !== "string" || !FORMATS.has(raw.format as ConnectorStringFormat)) invalidSchema();
      result.format = raw.format;
    }
  } else if (base === "number" || base === "integer") {
    if (Object.hasOwn(raw, "minimum")) result.minimum = finite(raw.minimum);
    if (Object.hasOwn(raw, "maximum")) result.maximum = finite(raw.maximum);
    const minimum = result.minimum as number | undefined;
    const maximum = result.maximum as number | undefined;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) invalidSchema(SCHEMA_UNSATISFIABLE);
    if (base === "integer") {
      const low = minimum === undefined ? Number.MIN_SAFE_INTEGER : Math.ceil(minimum);
      const high = maximum === undefined ? Number.MAX_SAFE_INTEGER : Math.floor(maximum);
      if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) invalidSchema(SCHEMA_UNSATISFIABLE);
    }
  }
  return deepFreeze(result as unknown as ConnectorSchemaV1);
}

export function parseConnectorSchemaV1(value: unknown): ConnectorSchemaV1 {
  return parseSchema(value, 0, { values: 0 });
}

function parseSystemPolicy(value: unknown): SystemPolicyV1 {
  const source = exactRecord(value, ["effects", "retry", "cost", "idempotency"]);
  const effects = exactArray(source.effects, 1, invalidContract);
  if (effects.length !== 1 || effects[0] !== "write" || source.retry !== "unsafe" ||
      source.cost !== "unknown" || source.idempotency !== "none") invalidContract();
  return CONNECTOR_SYSTEM_POLICY_V1;
}

export function parseSystemPolicyV1(value: unknown): SystemPolicyV1 {
  return parseSystemPolicy(value);
}

function parseHeaderName(value: unknown): string {
  const headerName = text(value, MAX_HEADER_NAME_CHARACTERS).toLowerCase();
  if (!HEADER_TOKEN.test(headerName) || FORBIDDEN_HEADERS.has(headerName) ||
      headerName.startsWith("x-forwarded-")) invalidContract();
  return headerName;
}

function parseAuthentication(value: unknown): OperationAuthenticationV1 {
  const kindDescriptor = descriptors(value, invalidContract).kind;
  if (!kindDescriptor || !("value" in kindDescriptor) || !kindDescriptor.enumerable) invalidContract();
  if (kindDescriptor.value === "none" || kindDescriptor.value === "http_bearer" || kindDescriptor.value === "http_basic") {
    exactRecord(value, ["kind"]);
    return Object.freeze({ kind: kindDescriptor.value });
  }
  if (kindDescriptor.value === "api_key_header") {
    const source = exactRecord(value, ["kind", "headerName"]);
    return Object.freeze({ kind: "api_key_header", headerName: parseHeaderName(source.headerName) });
  }
  return invalidContract();
}

function schemaBaseType(schema: ConnectorSchemaV1): ConnectorSchemaType {
  return Array.isArray(schema.type) ? schema.type[0] : schema.type;
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function assertOperationPortSchemas(
  request: ConnectorSchemaV1,
  result: ConnectorSchemaV1,
  authentication: OperationAuthenticationV1,
): void {
  if (schemaBaseType(request) !== "object" || !request.properties || request.additionalProperties !== false) {
    invalidContract();
  }
  const requestKeys = Object.keys(request.properties);
  if (!sameKeys(requestKeys.filter((key) => key !== "body"), ["path", "query", "headers"]) ||
      requestKeys.some((key) => !["path", "query", "headers", "body"].includes(key)) ||
      !(request.required ?? []).every((key) => requestKeys.includes(key)) ||
      !["path", "query", "headers"].every((key) => (request.required ?? []).includes(key))) {
    invalidContract();
  }
  for (const namespace of ["path", "query", "headers"] as const) {
    const schema = request.properties[namespace];
    if (!schema || schemaBaseType(schema) !== "object" || schema.additionalProperties !== false) invalidContract();
  }
  const headerSchema = request.properties.headers!;
  const credentialHeader = authentication.kind === "api_key_header"
    ? authentication.headerName
    : authentication.kind === "http_bearer" || authentication.kind === "http_basic"
      ? "authorization"
      : null;
  const foldedHeaders = new Set<string>();
  for (const headerName of Object.keys(headerSchema.properties ?? {})) {
    const folded = parseHeaderName(headerName);
    if (foldedHeaders.has(folded) || folded === credentialHeader) invalidContract();
    foldedHeaders.add(folded);
  }

  if (schemaBaseType(result) !== "object" || !result.properties || result.additionalProperties !== false ||
      !sameKeys(Object.keys(result.properties), ["status", "body"]) ||
      !sameKeys(result.required ?? [], ["status", "body"])) invalidContract();
  const status = result.properties.status;
  const body = result.properties.body;
  if (!status || !body || status.type !== "integer" || status.minimum !== status.maximum ||
      !Number.isSafeInteger(status.minimum) || (status.minimum as number) < 200 || (status.minimum as number) > 299) {
    invalidContract();
  }
  if (status.minimum === 204 ? body.type !== "null" : schemaBaseType(body) === "null") invalidContract();
}

function parseOperationProjection(value: unknown): OperationProjectionV1 {
  const source = exactRecord(value, [
    "projectionVersion", "operationId", "method", "path", "authentication",
    "requestSchema", "resultSchema", "redaction", "testBehavior", "limitsProfile",
    "executionAvailability", "systemPolicy",
  ]);
  if (source.projectionVersion !== 1 || !HTTP_METHODS.has(String(source.method)) ||
      source.limitsProfile !== "connector-import-v1" || source.executionAvailability !== "simulation_only") invalidContract();
  const redaction = exactRecord(source.redaction, ["requestValues", "responseValues", "credentialValues"]);
  if (redaction.requestValues !== "omit" || redaction.responseValues !== "omit" || redaction.credentialValues !== "redact") invalidContract();
  const testBehavior = exactRecord(source.testBehavior, ["mode", "egress", "credentials"]);
  if (testBehavior.mode !== "schema_sentinel" || testBehavior.egress !== "forbidden" || testBehavior.credentials !== "forbidden") invalidContract();
  const requestSchema = parseConnectorSchemaV1(source.requestSchema);
  const resultSchema = parseConnectorSchemaV1(source.resultSchema);
  const authentication = parseAuthentication(source.authentication);
  assertOperationPortSchemas(requestSchema, resultSchema, authentication);
  return deepFreeze({
    projectionVersion: 1,
    operationId: text(source.operationId, 512),
    method: source.method as OperationProjectionV1["method"],
    path: text(source.path, CONNECTOR_IMPORT_V1_LIMITS.maxInputBytes),
    authentication,
    requestSchema,
    resultSchema,
    redaction: { requestValues: "omit", responseValues: "omit", credentialValues: "redact" },
    testBehavior: { mode: "schema_sentinel", egress: "forbidden", credentials: "forbidden" },
    limitsProfile: "connector-import-v1",
    executionAvailability: "simulation_only",
    systemPolicy: parseSystemPolicy(source.systemPolicy),
  } as OperationProjectionV1);
}

export function parseOperationProjectionV1(value: unknown): OperationProjectionV1 {
  return parseOperationProjection(value);
}

function sameAuthentication(left: OperationAuthenticationV1, right: OperationAuthenticationV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseIndexEntry(value: unknown): ConnectorOperationIndexEntryV1 {
  const source = exactRecord(value, [
    "operationId", "method", "path", "authentication", "operationProjection", "operationProjectionHash",
  ]);
  const projection = parseOperationProjection(source.operationProjection);
  const operationId = text(source.operationId, 512);
  const path = text(source.path, CONNECTOR_IMPORT_V1_LIMITS.maxInputBytes);
  const authentication = parseAuthentication(source.authentication);
  if (source.method !== projection.method || operationId !== projection.operationId || path !== projection.path ||
      !sameAuthentication(authentication, projection.authentication) ||
      typeof source.operationProjectionHash !== "string" || !SHA256.test(source.operationProjectionHash) ||
      source.operationProjectionHash !== operationProjectionHash(projection)) invalidContract();
  return deepFreeze({
    operationId,
    method: source.method as OperationProjectionV1["method"],
    path,
    authentication,
    operationProjection: projection,
    operationProjectionHash: source.operationProjectionHash,
  });
}

export function parseConnectorDefinitionProjectionV1(value: unknown): ConnectorDefinitionProjectionV1 {
  const source = exactRecord(value, ["projectionVersion", "origin", "operations"]);
  if (source.projectionVersion !== 1) invalidContract();
  const rawOperations = exactArray(source.operations, CONNECTOR_IMPORT_V1_LIMITS.maxOperations, invalidContract);
  if (rawOperations.length === 0) invalidContract();
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const operations = rawOperations.map(parseIndexEntry).sort((left, right) =>
    compare(left.operationId, right.operationId) || compare(left.method, right.method) || compare(left.path, right.path));
  if (new Set(operations.map((entry) => entry.operationId)).size !== operations.length) invalidContract();
  return deepFreeze({ projectionVersion: 1, origin: parseConnectorOriginV1(source.origin), operations });
}

/** The single safe-origin policy shared by compilation, portable parsing, and persistence. */
export function parseConnectorOriginV1(value: unknown): string {
  const raw = text(value, 2_048);
  if (!/^https:\/\//iu.test(raw) || /[^\x20-\x7e]/u.test(raw) || raw.includes("\\") || raw.includes("%") ||
      raw.includes("{") || raw.includes("}")) invalidContract();
  const authority = raw.slice(raw.indexOf("//") + 2).replace(/\/$/u, "");
  const rawPort = /:(\d+)$/u.exec(authority)?.[1];
  if (rawPort !== undefined && rawPort !== "443") invalidContract();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return invalidContract(); }
  const hostname = parsed.hostname.toLowerCase();
  const suffix = hostname.split(".").at(-1) ?? "";
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.port || parsed.pathname !== "/" || !hostname.includes(".") || hostname.endsWith(".") ||
      hostname === "localhost" || hostname.endsWith(".localhost") || INTERNAL_ORIGIN_SUFFIXES.has(suffix) ||
      hostname.includes("xn--") || hostname.startsWith("[") || /^\d+(?:\.\d+){0,3}$/u.test(hostname) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname)) {
    invalidContract();
  }
  return parsed.origin;
}

export function parseUnverifiedAuthorAnnotationV1(value: unknown): UnverifiedAuthorAnnotationV1 {
  const source = exactRecord(value, ["label"], ["effectNote", "retryNote"]);
  if (source.label !== "Unverified" || (!Object.hasOwn(source, "effectNote") && !Object.hasOwn(source, "retryNote"))) invalidContract();
  return deepFreeze({
    label: "Unverified",
    ...(Object.hasOwn(source, "effectNote") ? { effectNote: text(source.effectNote, 512) } : {}),
    ...(Object.hasOwn(source, "retryNote") ? { retryNote: text(source.retryNote, 512) } : {}),
  });
}

function id(value: unknown): string {
  const parsed = text(value, 512);
  if (parsed.trim() !== parsed) invalidContract();
  return parsed;
}

export function parseConnectorDefinitionVersionV1(value: unknown): ConnectorDefinitionVersionV1 {
  const source = exactRecord(value, [
    "contractVersion", "id", "connectorId", "versionNumber", "projection",
    "connectorProjectionHash", "executionAvailability",
  ]);
  if (source.contractVersion !== 1 || !Number.isSafeInteger(source.versionNumber) || (source.versionNumber as number) < 1 ||
      typeof source.connectorProjectionHash !== "string" || !SHA256.test(source.connectorProjectionHash) ||
      source.executionAvailability !== "simulation_only") invalidContract();
  const projection = parseConnectorDefinitionProjectionV1(source.projection);
  if (source.connectorProjectionHash !== connectorProjectionHash(projection)) invalidContract();
  return deepFreeze({
    contractVersion: 1,
    id: id(source.id),
    connectorId: id(source.connectorId),
    versionNumber: source.versionNumber as number,
    projection,
    connectorProjectionHash: source.connectorProjectionHash,
    executionAvailability: "simulation_only",
  });
}

export function parseOperationVersionV1(value: unknown): OperationVersionV1 {
  const source = exactRecord(value, [
    "contractVersion", "id", "connectorDefinitionVersionId", "operationId", "projection",
    "operationProjectionHash", "schemaHash", "executionAvailability",
  ], ["authorAnnotation"]);
  const projection = parseOperationProjection(source.projection);
  const operationId = id(source.operationId);
  if (source.contractVersion !== 1 || operationId !== projection.operationId ||
      typeof source.operationProjectionHash !== "string" || !SHA256.test(source.operationProjectionHash) ||
      typeof source.schemaHash !== "string" || !SHA256.test(source.schemaHash) ||
      source.executionAvailability !== "simulation_only") invalidContract();
  if (source.operationProjectionHash !== operationProjectionHash(projection) ||
      source.schemaHash !== schemaHash(projection.requestSchema, projection.resultSchema)) invalidContract();
  return deepFreeze({
    contractVersion: 1,
    id: id(source.id),
    connectorDefinitionVersionId: id(source.connectorDefinitionVersionId),
    operationId,
    projection,
    operationProjectionHash: source.operationProjectionHash,
    schemaHash: source.schemaHash,
    executionAvailability: "simulation_only",
    ...(Object.hasOwn(source, "authorAnnotation") ? { authorAnnotation: parseUnverifiedAuthorAnnotationV1(source.authorAnnotation) } : {}),
  });
}

interface JsonBudget { depth: number; entries: number }

function parseJson(value: unknown, depth: number, budget: JsonBudget): JsonValue {
  if (depth > CONNECTOR_IMPORT_V1_LIMITS.maxJsonDepth) invalidContract();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidContract();
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const source = exactArray(value, CONNECTOR_IMPORT_V1_LIMITS.maxContainerEntries, invalidContract);
    budget.entries += source.length;
    if (budget.entries > CONNECTOR_IMPORT_V1_LIMITS.maxContainerEntries) invalidContract();
    return Object.freeze(source.map((entry) => parseJson(entry, depth + 1, budget)));
  }
  const source = descriptors(value, invalidContract);
  const keys = Object.keys(source);
  budget.entries += keys.length;
  if (budget.entries > CONNECTOR_IMPORT_V1_LIMITS.maxContainerEntries) invalidContract();
  const result = Object.create(null) as Record<string, JsonValue>;
  const normalized = new Set<string>();
  for (const key of keys.sort()) {
    const descriptor = source[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidContract();
    const normalizedKey = text(key, 512);
    if (normalized.has(normalizedKey)) invalidContract();
    normalized.add(normalizedKey);
    Object.defineProperty(result, normalizedKey, {
      value: parseJson(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true,
    });
  }
  return deepFreeze(result);
}

function scalarRecord(value: unknown): Readonly<Record<string, JsonPrimitive>> {
  const source = descriptors(value, invalidContract);
  const result = Object.create(null) as Record<string, JsonPrimitive>;
  const normalized = new Set<string>();
  for (const key of Object.keys(source).sort()) {
    const descriptor = source[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidContract();
    const item = descriptor.value;
    if (item !== null && typeof item !== "string" && typeof item !== "boolean" &&
        (typeof item !== "number" || !Number.isFinite(item))) invalidContract();
    const normalizedKey = text(key, 512);
    if (normalized.has(normalizedKey)) invalidContract();
    normalized.add(normalizedKey);
    Object.defineProperty(result, normalizedKey, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return deepFreeze(result);
}

export function parseOperationRequestV1(value: unknown): OperationRequestV1 {
  const source = exactRecord(value, ["path", "query", "headers"], ["body"]);
  const result: OperationRequestV1 = {
    path: scalarRecord(source.path),
    query: scalarRecord(source.query),
    headers: scalarRecord(source.headers),
    ...(Object.hasOwn(source, "body") ? { body: parseJson(source.body, 0, { depth: 0, entries: 0 }) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > CONNECTOR_IMPORT_V1_LIMITS.maxInputBytes) invalidContract();
  return deepFreeze(result);
}

export function parseOperationResultV1(value: unknown): OperationResultV1 {
  const source = exactRecord(value, ["status", "body"]);
  if (!Number.isSafeInteger(source.status) || (source.status as number) < 200 || (source.status as number) > 299) invalidContract();
  if (source.status === 204 && source.body !== null) invalidContract();
  return deepFreeze({
    status: source.status as number,
    body: parseJson(source.body, 0, { depth: 0, entries: 0 }),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(source[key])}`).join(",")}}`;
}

function boundedCanonicalBytes(value: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.byteLength > CONNECTOR_IMPORT_V1_LIMITS.maxCanonicalProjectionBytes) {
    throw new RangeError("Connector projection exceeds canonical projection limit");
  }
  return bytes;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalConnectorProjectionBytes(value: unknown): Buffer {
  return boundedCanonicalBytes(parseConnectorDefinitionProjectionV1(value));
}

export function canonicalOperationProjectionBytes(value: unknown): Buffer {
  return boundedCanonicalBytes(parseOperationProjectionV1(value));
}

export function canonicalSchemaBytes(requestSchema: unknown, resultSchema: unknown): Buffer {
  return boundedCanonicalBytes({
    requestSchema: parseConnectorSchemaV1(requestSchema),
    resultSchema: parseConnectorSchemaV1(resultSchema),
  });
}

export function connectorProjectionHash(value: unknown): string {
  return digest(canonicalConnectorProjectionBytes(value));
}

export function operationProjectionHash(value: unknown): string {
  return digest(canonicalOperationProjectionBytes(value));
}

export function schemaHash(requestSchema: unknown, resultSchema: unknown): string {
  return digest(canonicalSchemaBytes(requestSchema, resultSchema));
}
