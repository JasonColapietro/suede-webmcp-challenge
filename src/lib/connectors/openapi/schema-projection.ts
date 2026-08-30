import { generateSchemaSentinel } from "../sentinel";
import { parseConnectorSchemaV1, SCHEMA_UNSATISFIABLE as CONTRACT_UNSATISFIABLE } from "../schema";
import type { ConnectorSchemaNonNullType, ConnectorSchemaType, ConnectorSchemaV1 } from "../types";
import { referenceObject, resolveLocalReference } from "./local-ref";
import {
  checkpoint,
  jsonArray,
  jsonObject,
  refuse,
  type OpenApiCompileGuard,
  type ParsedJson,
  type ParsedJsonObject,
} from "./json";

const ANNOTATIONS = new Set(["title", "summary", "description", "examples", "example", "default", "deprecated"]);
const FORMATS = new Set(["date-time", "date", "time", "email", "hostname", "ipv4", "ipv6", "uri", "uuid"]);
const NON_NULL_TYPES = new Set<ConnectorSchemaNonNullType>(["object", "array", "string", "number", "integer", "boolean"]);
const TYPE_KEYS: Readonly<Record<ConnectorSchemaNonNullType | "null", ReadonlySet<string>>> = Object.freeze({
  object: new Set(["type", "properties", "required", "additionalProperties"]),
  array: new Set(["type", "items", "minItems", "maxItems"]),
  string: new Set(["type", "minLength", "maxLength", "format"]),
  number: new Set(["type", "minimum", "maximum"]),
  integer: new Set(["type", "minimum", "maximum"]),
  boolean: new Set(["type"]),
  null: new Set(["type"]),
});

function schemaType(value: ParsedJson | undefined): { readonly type: ConnectorSchemaType; readonly base: ConnectorSchemaNonNullType | "null" } {
  if (typeof value === "string") {
    if (value === "null" || NON_NULL_TYPES.has(value as ConnectorSchemaNonNullType)) {
      return { type: value as ConnectorSchemaType, base: value as ConnectorSchemaNonNullType | "null" };
    }
    return refuse("SCHEMA_KEYWORD_REFUSED");
  }
  const values = jsonArray(value, "SCHEMA_KEYWORD_REFUSED");
  if (values.length !== 2 || values.filter((entry) => entry === "null").length !== 1) refuse("SCHEMA_KEYWORD_REFUSED");
  const base = values.find((entry) => entry !== "null");
  if (typeof base !== "string" || !NON_NULL_TYPES.has(base as ConnectorSchemaNonNullType)) refuse("SCHEMA_KEYWORD_REFUSED");
  return { type: Object.freeze([base, "null"] as [ConnectorSchemaNonNullType, "null"]), base: base as ConnectorSchemaNonNullType };
}

function nonNegativeInteger(value: ParsedJson | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) refuse("SCHEMA_UNSATISFIABLE");
  return value as number;
}

function finite(value: ParsedJson | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse("SCHEMA_UNSATISFIABLE");
  return Object.is(value, -0) ? 0 : value;
}

function assertAllowed(record: ParsedJsonObject, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (ANNOTATIONS.has(key)) continue;
    if (key.toLowerCase().includes("fixture")) refuse("UNSUPPORTED_FIXTURE_INPUT");
    if (!allowed.has(key)) refuse("SCHEMA_KEYWORD_REFUSED");
  }
}

interface ProjectionContext {
  readonly document: ParsedJsonObject;
  readonly guard: OpenApiCompileGuard;
  readonly activeReferences: ReadonlySet<string>;
}

function project(value: ParsedJson, depth: number, context: ProjectionContext): ConnectorSchemaV1 {
  checkpoint(context.guard, true);
  if (depth > context.guard.limits.maxSchemaDepth) refuse("SCHEMA_DEPTH_LIMIT");
  const reference = referenceObject(value);
  if (reference) {
    assertAllowed(reference, new Set(["$ref"]));
    const resolved = resolveLocalReference(context.document, reference.$ref!, context.guard, context.activeReferences);
    return project(resolved.value, depth, { ...context, activeReferences: resolved.activeReferences });
  }

  const record = jsonObject(value, "SCHEMA_KEYWORD_REFUSED");
  if (!Object.hasOwn(record, "type")) refuse("SCHEMA_KEYWORD_REFUSED");
  const parsedType = schemaType(record.type);
  const allowed = TYPE_KEYS[parsedType.base];
  assertAllowed(record, allowed);
  const result: Record<string, unknown> = { type: parsedType.type };

  if (parsedType.base === "object") {
    if (!Object.hasOwn(record, "properties") || !Object.hasOwn(record, "required") || record.additionalProperties !== false) {
      refuse("SCHEMA_UNSATISFIABLE");
    }
    const rawProperties = jsonObject(record.properties!, "SCHEMA_KEYWORD_REFUSED");
    const properties = Object.create(null) as Record<string, ConnectorSchemaV1>;
    for (const key of Object.keys(rawProperties).sort()) {
      if (!key || /[\u0000-\u001f\u007f]/u.test(key) || Buffer.byteLength(key, "utf8") > 256) refuse("SCHEMA_KEYWORD_REFUSED");
      properties[key.normalize("NFC")] = project(rawProperties[key]!, depth + 1, context);
    }
    const rawRequired = jsonArray(record.required, "SCHEMA_UNSATISFIABLE");
    const required = rawRequired.map((entry) => {
      if (typeof entry !== "string" || !entry || /[\u0000-\u001f\u007f]/u.test(entry)) refuse("SCHEMA_UNSATISFIABLE");
      return entry.normalize("NFC");
    }).sort();
    if (new Set(required).size !== required.length || required.some((key) => !Object.hasOwn(properties, key))) {
      refuse("SCHEMA_UNSATISFIABLE");
    }
    result.properties = properties;
    result.required = required;
    result.additionalProperties = false;
  } else if (parsedType.base === "array") {
    if (!Object.hasOwn(record, "items")) refuse("SCHEMA_UNSATISFIABLE");
    result.items = project(record.items!, depth + 1, context);
    if (Object.hasOwn(record, "minItems")) result.minItems = nonNegativeInteger(record.minItems);
    if (Object.hasOwn(record, "maxItems")) result.maxItems = nonNegativeInteger(record.maxItems);
    if (typeof result.minItems === "number" && typeof result.maxItems === "number" && result.minItems > result.maxItems) {
      refuse("SCHEMA_UNSATISFIABLE");
    }
  } else if (parsedType.base === "string") {
    if (Object.hasOwn(record, "minLength")) result.minLength = nonNegativeInteger(record.minLength);
    if (Object.hasOwn(record, "maxLength")) result.maxLength = nonNegativeInteger(record.maxLength);
    if (typeof result.minLength === "number" && typeof result.maxLength === "number" && result.minLength > result.maxLength) {
      refuse("SCHEMA_UNSATISFIABLE");
    }
    if (Object.hasOwn(record, "format")) {
      if (typeof record.format !== "string" || !FORMATS.has(record.format)) refuse("SCHEMA_FORMAT_REFUSED");
      result.format = record.format;
    }
  } else if (parsedType.base === "number" || parsedType.base === "integer") {
    if (Object.hasOwn(record, "minimum")) result.minimum = finite(record.minimum);
    if (Object.hasOwn(record, "maximum")) result.maximum = finite(record.maximum);
    if (typeof result.minimum === "number" && typeof result.maximum === "number" && result.minimum > result.maximum) {
      refuse("SCHEMA_UNSATISFIABLE");
    }
    if (parsedType.base === "integer") {
      const low = typeof result.minimum === "number" ? Math.ceil(result.minimum) : Number.MIN_SAFE_INTEGER;
      const high = typeof result.maximum === "number" ? Math.floor(result.maximum) : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) refuse("SCHEMA_UNSATISFIABLE");
    }
  }

  try {
    const parsed = parseConnectorSchemaV1(result);
    generateSchemaSentinel(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === CONTRACT_UNSATISFIABLE) refuse("SCHEMA_UNSATISFIABLE");
    return refuse("SCHEMA_UNSATISFIABLE");
  }
}

export function projectOpenApiSchema(
  value: ParsedJson,
  document: ParsedJsonObject,
  guard: OpenApiCompileGuard,
): ConnectorSchemaV1 {
  return project(value, 0, { document, guard, activeReferences: new Set() });
}

export function assertScalarParameterSchema(schema: ConnectorSchemaV1): void {
  const base = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (base !== "string" && base !== "number" && base !== "integer" && base !== "boolean") {
    refuse("PARAMETER_REFUSED");
  }
}
