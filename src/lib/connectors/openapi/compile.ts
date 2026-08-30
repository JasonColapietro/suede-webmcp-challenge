import {
  connectorProjectionHash,
  operationProjectionHash,
  parseConnectorDefinitionProjectionV1,
  parseConnectorOriginV1,
  parseConnectorSchemaV1,
  parseOperationProjectionV1,
  schemaHash,
  CONNECTOR_SYSTEM_POLICY_V1,
} from "../schema";
import { generateSchemaSentinel } from "../sentinel";
import type {
  ConnectorDefinitionProjectionV1,
  ConnectorSchemaV1,
  OperationAuthenticationV1,
  OperationProjectionV1,
} from "../types";
import { resolveLocalReference } from "./local-ref";
import {
  boundedText,
  checkpoint,
  createCompileGuard,
  jsonArray,
  jsonObject,
  OpenApiRefusal,
  parseBoundedJson,
  refuse,
  type OpenApiCompileGuard,
  type OpenApiCompilerLimitOverrides,
  type OpenApiFailureCode,
  type ParsedJson,
  type ParsedJsonObject,
} from "./json";
import { assertScalarParameterSchema, projectOpenApiSchema } from "./schema-projection";

export type OpenApiCompileFailureCode = OpenApiFailureCode;

export interface CompiledOpenApiOperation {
  readonly operationId: string;
  readonly projection: OperationProjectionV1;
  readonly operationProjectionHash: string;
  readonly schemaHash: string;
}

export interface RefusedOpenApiOperation {
  readonly operationId: string;
  readonly method: OperationProjectionV1["method"];
  readonly path: string;
  readonly code: OpenApiFailureCode;
}

export type OpenApiCompileResult =
  | Readonly<{
      ok: true;
      connectorProjection: ConnectorDefinitionProjectionV1;
      connectorProjectionHash: string;
      operations: readonly CompiledOpenApiOperation[];
      refusedOperations: readonly RefusedOpenApiOperation[];
    }>
  | Readonly<{ ok: false; code: OpenApiFailureCode }>;

export interface CompileOpenApi310Options {
  readonly signal?: AbortSignal;
  readonly limits?: OpenApiCompilerLimitOverrides;
}

const METHODS = Object.freeze(["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const);
const ANNOTATIONS = new Set([
  "title", "summary", "description", "externalDocs", "tags", "deprecated", "example", "examples",
]);
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const FORBIDDEN_HEADERS = new Set([
  "__proto__", "constructor", "prototype", "accept", "accept-charset", "accept-encoding",
  "accept-language", "authorization", "connection", "content-encoding", "content-length",
  "content-type", "cookie", "expect", "forwarded", "from", "host", "keep-alive", "origin",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "referer", "te", "trailer",
  "transfer-encoding", "upgrade", "user-agent", "via", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto", "x-payment",
]);
const GLOBAL_CODES = new Set<OpenApiFailureCode>([
  "INVALID_LIMIT_PROFILE", "IMPORT_CANCELLED", "COMPILER_DEADLINE", "INPUT_BYTES_LIMIT", "INVALID_JSON",
  "DUPLICATE_JSON_KEY", "JSON_DEPTH_LIMIT", "JSON_ENTRY_LIMIT", "INSPECTED_VALUE_LIMIT", "OPERATION_LIMIT",
  "PARAMETER_LIMIT", "LOCAL_REFERENCE_LIMIT", "CANONICAL_PROJECTION_LIMIT", "OPENAPI_VERSION_REFUSED",
  "OPENAPI_STRUCTURE_REFUSED", "UNSUPPORTED_FIXTURE_INPUT", "SERVER_ORIGIN_REFUSED", "MISSING_OPERATION_ID",
  "DUPLICATE_OPERATION_ID",
]);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if ("value" in descriptor && descriptor.value !== null && typeof descriptor.value === "object") pending.push(descriptor.value as object);
    }
    Object.freeze(current);
  }
  return value;
}

function allowed(record: ParsedJsonObject, keys: readonly string[], code: OpenApiFailureCode): void {
  const set = new Set(keys);
  for (const key of Object.keys(record)) {
    if (ANNOTATIONS.has(key)) continue;
    if (key.toLowerCase().includes("fixture")) refuse("UNSUPPORTED_FIXTURE_INPUT");
    if (!set.has(key)) refuse(code);
  }
}

/** Whole-tree policy scanning is free; json.ts owns source counts and semantic helpers charge revisits. */
function rejectFixtureIngress(value: ParsedJson, guard: OpenApiCompileGuard): void {
  checkpoint(guard);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) rejectFixtureIngress(entry, guard);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes("fixture")) refuse("UNSUPPORTED_FIXTURE_INPUT");
    rejectFixtureIngress(child, guard);
  }
}

function safeOrigin(value: ParsedJson | undefined): string {
  const raw = boundedText(value, "SERVER_ORIGIN_REFUSED", 2_048);
  try { return parseConnectorOriginV1(raw); } catch { return refuse("SERVER_ORIGIN_REFUSED"); }
}

function dereferenceObject(
  document: ParsedJsonObject,
  value: ParsedJson,
  guard: OpenApiCompileGuard,
  active = new Set<string>(),
): ParsedJsonObject {
  const record = jsonObject(value);
  checkpoint(guard, true);
  if (!Object.hasOwn(record, "$ref")) return record;
  allowed(record, ["$ref"], "UNSUPPORTED_OPENAPI_KEYWORD");
  const resolved = resolveLocalReference(document, record.$ref!, guard, active);
  return dereferenceObject(document, resolved.value, guard, new Set(resolved.activeReferences));
}

function headerName(value: ParsedJson | undefined): string {
  const name = boundedText(value, "HEADER_OWNERSHIP_REFUSED", 64).toLowerCase();
  if (!HEADER_TOKEN.test(name) || FORBIDDEN_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-")) {
    refuse("HEADER_OWNERSHIP_REFUSED");
  }
  if (name.startsWith("content-") || name.startsWith("accept-") || name.startsWith("if-") ||
      name.startsWith("x-forwarded-")) refuse("HEADER_OWNERSHIP_REFUSED");
  return name;
}

function securitySchemes(document: ParsedJsonObject): ParsedJsonObject {
  if (!Object.hasOwn(document, "components")) return Object.freeze(Object.create(null) as ParsedJsonObject);
  const components = jsonObject(document.components!, "SECURITY_REFUSED");
  allowed(components, ["schemas", "securitySchemes", "parameters", "requestBodies", "responses"], "UNSUPPORTED_OPENAPI_KEYWORD");
  return Object.hasOwn(components, "securitySchemes")
    ? jsonObject(components.securitySchemes!, "SECURITY_REFUSED")
    : Object.freeze(Object.create(null) as ParsedJsonObject);
}

function schemeAuthentication(
  document: ParsedJsonObject,
  value: ParsedJson,
  guard: OpenApiCompileGuard,
): OperationAuthenticationV1 {
  const scheme = dereferenceObject(document, value, guard);
  const type = scheme.type;
  if (type === "apiKey") {
    allowed(scheme, ["type", "in", "name"], "SECURITY_REFUSED");
    if (scheme.in !== "header") refuse("SECURITY_REFUSED");
    return Object.freeze({ kind: "api_key_header", headerName: headerName(scheme.name) });
  }
  if (type === "http") {
    allowed(scheme, ["type", "scheme", "bearerFormat"], "SECURITY_REFUSED");
    if (typeof scheme.scheme !== "string") refuse("SECURITY_REFUSED");
    const normalized = scheme.scheme.toLowerCase();
    if (normalized === "bearer") return Object.freeze({ kind: "http_bearer" });
    if (normalized === "basic") return Object.freeze({ kind: "http_basic" });
  }
  return refuse("SECURITY_REFUSED");
}

function validateComponents(document: ParsedJsonObject, guard: OpenApiCompileGuard): void {
  if (!Object.hasOwn(document, "components")) return;
  const components = jsonObject(document.components!, "OPENAPI_STRUCTURE_REFUSED");
  allowed(components, ["schemas", "securitySchemes", "parameters", "requestBodies", "responses"], "UNSUPPORTED_OPENAPI_KEYWORD");
  for (const category of ["schemas", "securitySchemes", "parameters", "requestBodies", "responses"] as const) {
    if (!Object.hasOwn(components, category)) continue;
    const entries = jsonObject(components[category]!, "OPENAPI_STRUCTURE_REFUSED");
    for (const value of Object.values(entries)) {
      checkpoint(guard, true);
      jsonObject(value, "OPENAPI_STRUCTURE_REFUSED");
      if (category === "schemas") projectOpenApiSchema(value, document, guard);
      else if (category === "securitySchemes") schemeAuthentication(document, value, guard);
      else if (category === "parameters") parameter(document, value, guard);
      else if (category === "requestBodies") requestBodySchema(document, value, guard);
      else validateReusableResponse(document, value, guard);
    }
  }
}

function validateReusableResponse(document: ParsedJsonObject, value: ParsedJson, guard: OpenApiCompileGuard): void {
  const response = dereferenceObject(document, value, guard);
  if (Object.hasOwn(response, "links")) refuse("LINK_REFUSED");
  allowed(response, ["description", "content"], "RESPONSE_MEDIA_TYPE_REFUSED");
  if (!Object.hasOwn(response, "content")) return;
  const content = jsonObject(response.content!, "RESPONSE_MEDIA_TYPE_REFUSED");
  if (Object.keys(content).length !== 1 || !Object.hasOwn(content, "application/json")) refuse("RESPONSE_MEDIA_TYPE_REFUSED");
  const media = jsonObject(content["application/json"]!, "RESPONSE_MEDIA_TYPE_REFUSED");
  allowed(media, ["schema"], "RESPONSE_MEDIA_TYPE_REFUSED");
  if (!Object.hasOwn(media, "schema")) refuse("RESPONSE_MEDIA_TYPE_REFUSED");
  projectOpenApiSchema(media.schema!, document, guard);
}

function authentication(
  document: ParsedJsonObject,
  security: ParsedJson | undefined,
  guard: OpenApiCompileGuard,
): OperationAuthenticationV1 {
  if (security === undefined) return Object.freeze({ kind: "none" });
  const requirements = jsonArray(security, "SECURITY_REFUSED");
  if (requirements.length === 0) return Object.freeze({ kind: "none" });
  if (requirements.length !== 1) refuse("SECURITY_REFUSED");
  const requirement = jsonObject(requirements[0]!, "SECURITY_REFUSED");
  const names = Object.keys(requirement);
  if (names.length === 0) refuse("SECURITY_REFUSED");
  if (names.length !== 1) refuse("SECURITY_REFUSED");
  const scopes = jsonArray(requirement[names[0]!]!, "SECURITY_REFUSED");
  if (scopes.length !== 0) refuse("SECURITY_REFUSED");
  const schemes = securitySchemes(document);
  if (!Object.hasOwn(schemes, names[0]!)) refuse("SECURITY_REFUSED");
  return schemeAuthentication(document, schemes[names[0]!]!, guard);
}

interface ProjectedParameter {
  readonly name: string;
  readonly location: "path" | "query" | "header";
  readonly required: boolean;
  readonly schema: ConnectorSchemaV1;
}

function parameter(
  document: ParsedJsonObject,
  value: ParsedJson,
  guard: OpenApiCompileGuard,
): ProjectedParameter {
  const record = dereferenceObject(document, value, guard);
  allowed(record, ["name", "in", "required", "style", "explode", "allowReserved", "schema"], "PARAMETER_REFUSED");
  const location = record.in;
  if (location !== "path" && location !== "query" && location !== "header") refuse("PARAMETER_REFUSED");
  const rawName = boundedText(record.name, "PARAMETER_REFUSED", location === "header" ? 64 : 256);
  const name = location === "header" ? headerName(rawName) : rawName.normalize("NFC");
  const required = record.required === true;
  if (record.required !== undefined && typeof record.required !== "boolean") refuse("PARAMETER_REFUSED");
  if (location === "path" && !required) refuse("PARAMETER_REFUSED");
  if (!Object.hasOwn(record, "schema")) refuse("PARAMETER_REFUSED");
  if (location === "path") {
    if ((record.style !== undefined && record.style !== "simple") ||
        (record.explode !== undefined && record.explode !== false) ||
        (record.allowReserved !== undefined && record.allowReserved !== false)) refuse("PARAMETER_SERIALIZATION_REFUSED");
  } else if (location === "query") {
    if ((record.style !== undefined && record.style !== "form") ||
        (record.explode !== undefined && record.explode !== true) ||
        (record.allowReserved !== undefined && record.allowReserved !== false)) refuse("PARAMETER_SERIALIZATION_REFUSED");
  } else if ((record.style !== undefined && record.style !== "simple") ||
      (record.explode !== undefined && record.explode !== false) || Object.hasOwn(record, "allowReserved")) {
    refuse("PARAMETER_SERIALIZATION_REFUSED");
  }
  const schema = projectOpenApiSchema(record.schema!, document, guard);
  assertScalarParameterSchema(schema);
  return Object.freeze({ name, location, required, schema });
}

function parameters(
  document: ParsedJsonObject,
  pathParameters: ParsedJson | undefined,
  operationParameters: ParsedJson | undefined,
  guard: OpenApiCompileGuard,
): readonly ProjectedParameter[] {
  const pathValues = pathParameters === undefined ? [] : jsonArray(pathParameters, "PARAMETER_REFUSED");
  const operationValues = operationParameters === undefined ? [] : jsonArray(operationParameters, "PARAMETER_REFUSED");
  if (pathValues.length + operationValues.length > guard.limits.maxParametersPerOperation) refuse("PARAMETER_LIMIT");
  const merged = new Map<string, ProjectedParameter>();
  for (const [values, override] of [[pathValues, false], [operationValues, true]] as const) {
    const local = new Set<string>();
    for (const item of values) {
      const projected = parameter(document, item, guard);
      const key = `${projected.location}\u0000${projected.name}`;
      if (local.has(key)) refuse("PARAMETER_REFUSED");
      local.add(key);
      if (override || !merged.has(key)) merged.set(key, projected);
    }
  }
  if (merged.size > guard.limits.maxParametersPerOperation) refuse("PARAMETER_LIMIT");
  return Object.freeze([...merged.values()].sort((left, right) =>
    left.location.localeCompare(right.location) || left.name.localeCompare(right.name)));
}

function closedObject(properties: Record<string, ConnectorSchemaV1>, required: readonly string[]): ConnectorSchemaV1 {
  return parseConnectorSchemaV1({
    type: "object",
    properties,
    required: [...required].sort(),
    additionalProperties: false,
  });
}

function requestBodySchema(
  document: ParsedJsonObject,
  value: ParsedJson | undefined,
  guard: OpenApiCompileGuard,
): { readonly schema?: ConnectorSchemaV1; readonly required: boolean } {
  if (value === undefined) return { required: false };
  const body = dereferenceObject(document, value, guard);
  allowed(body, ["required", "content"], "REQUEST_BODY_REFUSED");
  if (body.required !== undefined && typeof body.required !== "boolean") refuse("REQUEST_BODY_REFUSED");
  const content = jsonObject(body.content!, "REQUEST_BODY_REFUSED");
  if (Object.keys(content).length !== 1 || !Object.hasOwn(content, "application/json")) refuse("REQUEST_BODY_REFUSED");
  const media = jsonObject(content["application/json"]!, "REQUEST_BODY_REFUSED");
  allowed(media, ["schema"], "REQUEST_BODY_REFUSED");
  if (!Object.hasOwn(media, "schema")) refuse("REQUEST_BODY_REFUSED");
  return { schema: projectOpenApiSchema(media.schema!, document, guard), required: body.required === true };
}

function responseSchema(
  document: ParsedJsonObject,
  value: ParsedJson,
  status: number,
  guard: OpenApiCompileGuard,
): ConnectorSchemaV1 {
  const response = dereferenceObject(document, value, guard);
  if (Object.hasOwn(response, "links")) refuse("LINK_REFUSED");
  allowed(response, ["description", "content", "headers"], "RESPONSE_MEDIA_TYPE_REFUSED");
  if (Object.hasOwn(response, "headers")) refuse("RESPONSE_MEDIA_TYPE_REFUSED");
  if (status === 204) {
    if (Object.hasOwn(response, "content")) refuse("RESPONSE_SELECTION_REFUSED");
    return parseConnectorSchemaV1({ type: "null" });
  }
  if (!Object.hasOwn(response, "content")) refuse("RESPONSE_MEDIA_TYPE_REFUSED");
  const content = jsonObject(response.content!, "RESPONSE_MEDIA_TYPE_REFUSED");
  if (Object.keys(content).length !== 1 || !Object.hasOwn(content, "application/json")) refuse("RESPONSE_MEDIA_TYPE_REFUSED");
  const media = jsonObject(content["application/json"]!, "RESPONSE_MEDIA_TYPE_REFUSED");
  allowed(media, ["schema"], "RESPONSE_MEDIA_TYPE_REFUSED");
  if (!Object.hasOwn(media, "schema")) refuse("RESPONSE_MEDIA_TYPE_REFUSED");
  return projectOpenApiSchema(media.schema!, document, guard);
}

function selectedResponse(
  document: ParsedJsonObject,
  value: ParsedJson | undefined,
  guard: OpenApiCompileGuard,
): { readonly status: number; readonly body: ConnectorSchemaV1 } {
  const responses = jsonObject(value!, "RESPONSE_SELECTION_REFUSED");
  if (Object.keys(responses).some((key) => /^2xx$/iu.test(key))) refuse("RESPONSE_SELECTION_REFUSED");
  const selected = Object.keys(responses).filter((key) => /^2\d\d$/u.test(key));
  if (selected.length !== 1) refuse("RESPONSE_SELECTION_REFUSED");
  const status = Number(selected[0]);
  return { status, body: responseSchema(document, responses[selected[0]!]!, status, guard) };
}

interface OperationCandidate {
  readonly operationId: string;
  readonly method: OperationProjectionV1["method"];
  readonly path: string;
  readonly pathItem: ParsedJsonObject;
  readonly operation: ParsedJsonObject;
}

function collectOperations(document: ParsedJsonObject, guard: OpenApiCompileGuard): readonly OperationCandidate[] {
  const paths = jsonObject(document.paths!, "OPENAPI_STRUCTURE_REFUSED");
  const candidates: OperationCandidate[] = [];
  const ids = new Set<string>();
  for (const path of Object.keys(paths).sort()) {
    if (!path.startsWith("/") || /[\u0000-\u001f\u007f?#\\]/u.test(path)) refuse("OPENAPI_STRUCTURE_REFUSED");
    const item = dereferenceObject(document, paths[path]!, guard);
    allowed(item, [...METHODS, "parameters", "servers"], "UNSUPPORTED_OPENAPI_KEYWORD");
    if (Object.hasOwn(item, "servers")) refuse("SERVER_ORIGIN_REFUSED");
    for (const method of METHODS) {
      if (!Object.hasOwn(item, method)) continue;
      const operation = jsonObject(item[method]!, "OPENAPI_STRUCTURE_REFUSED");
      const operationId = boundedText(operation.operationId, "MISSING_OPERATION_ID", 512);
      if (ids.has(operationId)) refuse("DUPLICATE_OPERATION_ID");
      ids.add(operationId);
      candidates.push({ operationId, method: method.toUpperCase() as OperationProjectionV1["method"], path, pathItem: item, operation });
      if (candidates.length > guard.limits.maxOperations) refuse("OPERATION_LIMIT");
    }
  }
  if (candidates.length === 0) refuse("OPENAPI_STRUCTURE_REFUSED");
  return Object.freeze(candidates);
}

function assertPathParameters(path: string, projected: readonly ProjectedParameter[]): void {
  const malformedRemoved = path.replace(/\{[^{}]+\}/gu, "");
  if (malformedRemoved.includes("{") || malformedRemoved.includes("}")) refuse("PARAMETER_REFUSED");
  const placeholders = [...path.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!.normalize("NFC"));
  if (new Set(placeholders).size !== placeholders.length) refuse("PARAMETER_REFUSED");
  const pathNames = projected.filter((item) => item.location === "path").map((item) => item.name);
  if (placeholders.length !== pathNames.length || placeholders.some((name) => !pathNames.includes(name))) refuse("PARAMETER_REFUSED");
}

function compileOperation(
  document: ParsedJsonObject,
  candidate: OperationCandidate,
  guard: OpenApiCompileGuard,
): CompiledOpenApiOperation {
  const operation = candidate.operation;
  allowed(operation, [
    "operationId", "parameters", "requestBody", "responses", "callbacks", "security", "servers",
    "tags", "summary", "description", "externalDocs", "deprecated",
  ], "UNSUPPORTED_OPENAPI_KEYWORD");
  if (Object.hasOwn(operation, "callbacks")) refuse("CALLBACK_REFUSED");
  if (Object.hasOwn(operation, "servers")) refuse("SERVER_ORIGIN_REFUSED");
  const projectedParameters = parameters(document, candidate.pathItem.parameters, operation.parameters, guard);
  assertPathParameters(candidate.path, projectedParameters);
  const auth = authentication(document, operation.security ?? document.security, guard);
  const ownedHeader = auth.kind === "api_key_header" ? auth.headerName : auth.kind === "none" ? null : "authorization";
  if (ownedHeader && projectedParameters.some((item) => item.location === "header" && item.name === ownedHeader)) {
    refuse("HEADER_OWNERSHIP_REFUSED");
  }

  const namespaces = { path: Object.create(null), query: Object.create(null), headers: Object.create(null) } as Record<"path" | "query" | "headers", Record<string, ConnectorSchemaV1>>;
  const required = { path: [] as string[], query: [] as string[], headers: [] as string[] };
  for (const item of projectedParameters) {
    const namespace = item.location === "header" ? "headers" : item.location;
    namespaces[namespace][item.name] = item.schema;
    if (item.required) required[namespace].push(item.name);
  }
  const body = requestBodySchema(document, operation.requestBody, guard);
  const requestProperties: Record<string, ConnectorSchemaV1> = {
    headers: closedObject(namespaces.headers, required.headers),
    path: closedObject(namespaces.path, required.path),
    query: closedObject(namespaces.query, required.query),
  };
  const requestRequired = ["headers", "path", "query"];
  if (body.schema) {
    requestProperties.body = body.schema;
    if (body.required) requestRequired.push("body");
  }
  const response = selectedResponse(document, operation.responses, guard);
  const requestSchema = closedObject(requestProperties, requestRequired);
  const resultSchema = closedObject({
    body: response.body,
    status: parseConnectorSchemaV1({ type: "integer", minimum: response.status, maximum: response.status }),
  }, ["body", "status"]);
  try {
    const requestSentinel = generateSchemaSentinel(requestSchema);
    const resultSentinel = generateSchemaSentinel(resultSchema);
    if (Buffer.byteLength(JSON.stringify([requestSentinel, resultSentinel]), "utf8") >
        guard.limits.maxCanonicalProjectionBytes) refuse("SCHEMA_UNSATISFIABLE");
  } catch (error) {
    if (error instanceof OpenApiRefusal) throw error;
    refuse("SCHEMA_UNSATISFIABLE");
  }
  const projection = parseOperationProjectionV1({
    projectionVersion: 1,
    operationId: candidate.operationId,
    method: candidate.method,
    path: candidate.path,
    authentication: auth,
    requestSchema,
    resultSchema,
    redaction: { requestValues: "omit", responseValues: "omit", credentialValues: "redact" },
    testBehavior: { mode: "schema_sentinel", egress: "forbidden", credentials: "forbidden" },
    limitsProfile: "connector-import-v1",
    executionAvailability: "simulation_only",
    systemPolicy: CONNECTOR_SYSTEM_POLICY_V1,
  });
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > guard.limits.maxCanonicalProjectionBytes) {
    refuse("CANONICAL_PROJECTION_LIMIT");
  }
  return deepFreeze({
    operationId: candidate.operationId,
    projection,
    operationProjectionHash: operationProjectionHash(projection),
    schemaHash: schemaHash(requestSchema, resultSchema),
  });
}

function readOptions(options: CompileOpenApi310Options | undefined): { signal?: AbortSignal; limits?: OpenApiCompilerLimitOverrides } {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.getOwnPropertySymbols(options).length !== 0) refuse("INVALID_LIMIT_PROFILE");
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.keys(descriptors).some((key) => key !== "signal" && key !== "limits")) refuse("INVALID_LIMIT_PROFILE");
  for (const descriptor of Object.values(descriptors)) if (!("value" in descriptor) || !descriptor.enumerable) refuse("INVALID_LIMIT_PROFILE");
  const signal = descriptors.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) refuse("INVALID_LIMIT_PROFILE");
  return { signal, limits: descriptors.limits?.value as OpenApiCompilerLimitOverrides | undefined };
}

function compile(source: string | Uint8Array, options?: CompileOpenApi310Options): OpenApiCompileResult {
  const parsedOptions = readOptions(options);
  const guard = createCompileGuard(parsedOptions.limits, parsedOptions.signal);
  const document = jsonObject(parseBoundedJson(source, guard), "OPENAPI_STRUCTURE_REFUSED");
  rejectFixtureIngress(document, guard);
  allowed(document, ["openapi", "info", "servers", "paths", "components", "security", "tags", "externalDocs"], "UNSUPPORTED_OPENAPI_KEYWORD");
  if (document.openapi !== "3.1.0") refuse("OPENAPI_VERSION_REFUSED");
  if (!Object.hasOwn(document, "info") || !Object.hasOwn(document, "paths")) refuse("OPENAPI_STRUCTURE_REFUSED");
  const servers = jsonArray(document.servers, "SERVER_ORIGIN_REFUSED");
  if (servers.length !== 1) refuse("SERVER_ORIGIN_REFUSED");
  const server = jsonObject(servers[0]!, "SERVER_ORIGIN_REFUSED");
  allowed(server, ["url", "description"], "SERVER_ORIGIN_REFUSED");
  const origin = safeOrigin(server.url);
  validateComponents(document, guard);
  const candidates = collectOperations(document, guard);
  const operations: CompiledOpenApiOperation[] = [];
  const refusedOperations: RefusedOpenApiOperation[] = [];
  for (const candidate of candidates) {
    checkpoint(guard);
    try {
      operations.push(compileOperation(document, candidate, guard));
    } catch (error) {
      if (!(error instanceof OpenApiRefusal) || GLOBAL_CODES.has(error.code)) throw error;
      refusedOperations.push(deepFreeze({
        operationId: candidate.operationId,
        method: candidate.method,
        path: candidate.path,
        code: error.code,
      }));
    }
  }
  if (operations.length === 0) refuse(refusedOperations[0]?.code ?? "OPENAPI_STRUCTURE_REFUSED");
  const projectionInput = {
    projectionVersion: 1,
    origin,
    operations: operations.map((operation) => ({
      operationId: operation.operationId,
      method: operation.projection.method,
      path: operation.projection.path,
      authentication: operation.projection.authentication,
      operationProjection: operation.projection,
      operationProjectionHash: operation.operationProjectionHash,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(projectionInput), "utf8") > guard.limits.maxCanonicalProjectionBytes) {
    refuse("CANONICAL_PROJECTION_LIMIT");
  }
  const connectorProjection = parseConnectorDefinitionProjectionV1(projectionInput);
  return deepFreeze({
    ok: true,
    connectorProjection,
    connectorProjectionHash: connectorProjectionHash(connectorProjection),
    operations: operations.sort((left, right) => left.operationId.localeCompare(right.operationId)),
    refusedOperations: refusedOperations.sort((left, right) => left.operationId.localeCompare(right.operationId)),
  });
}

export function compileOpenApi310(source: string | Uint8Array, options?: CompileOpenApi310Options): OpenApiCompileResult {
  try {
    return compile(source, options);
  } catch (error) {
    const code = error instanceof OpenApiRefusal ? error.code : "OPENAPI_STRUCTURE_REFUSED";
    return Object.freeze({ ok: false, code });
  }
}
