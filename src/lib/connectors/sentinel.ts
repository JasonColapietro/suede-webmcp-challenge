import type { JsonValue } from "@/lib/flow/types";
import { CONNECTOR_IMPORT_V1_LIMITS } from "./limits";
import {
  parseConnectorSchemaV1,
  SCHEMA_UNSATISFIABLE,
} from "./schema";
import type { ConnectorSchemaNonNullType, ConnectorSchemaV1, ConnectorStringFormat } from "./types";

export { parseConnectorSchemaV1 } from "./schema";

const FORMAT_SENTINELS: Readonly<Record<ConnectorStringFormat, string>> = Object.freeze({
  "date-time": "2000-01-01T00:00:00Z",
  date: "2000-01-01",
  time: "00:00:00Z",
  email: "sentinel@example.invalid",
  hostname: "sentinel.invalid",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  uri: "https://example.invalid/",
  uuid: "00000000-0000-4000-8000-000000000000",
});

const MAX_SENTINEL_STRING_BYTES = CONNECTOR_IMPORT_V1_LIMITS.maxCanonicalProjectionBytes - 2;

function impossible(): never {
  throw new TypeError(SCHEMA_UNSATISFIABLE);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

interface SentinelBudget { values: number }

function baseType(schema: ConnectorSchemaV1): ConnectorSchemaNonNullType | "null" {
  return Array.isArray(schema.type) ? schema.type[0] : schema.type as ConnectorSchemaNonNullType | "null";
}

function numberSentinel(schema: ConnectorSchemaV1, integer: boolean): number {
  const minimum = schema.minimum ?? (integer ? Number.MIN_SAFE_INTEGER : -Number.MAX_VALUE);
  const maximum = schema.maximum ?? (integer ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE);
  const low = integer ? Math.ceil(minimum) : minimum;
  const high = integer ? Math.floor(maximum) : maximum;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high ||
      (integer && (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)))) impossible();
  if (low <= 0 && high >= 0) return 0;
  return low > 0 ? low : high;
}

function distributeCharacters(total: number, groups: number, maximum: number): number[] | null {
  if (groups < 1 || total < groups || total > groups * maximum) return null;
  const lengths = Array.from({ length: groups }, () => 1);
  let remaining = total - groups;
  for (let index = 0; index < groups && remaining > 0; index += 1) {
    const added = Math.min(maximum - 1, remaining);
    lengths[index] += added;
    remaining -= added;
  }
  return remaining === 0 ? lengths : null;
}

function hostnameOfLength(length: number): string | null {
  if (length < 1 || length > 253) return null;
  for (let groups = 1; groups <= 127; groups += 1) {
    const lengths = distributeCharacters(length - (groups - 1), groups, 63);
    if (lengths) return lengths.map((size) => "a".repeat(size)).join(".");
  }
  return null;
}

function ipv4OfLength(length: number): string | null {
  const lengths = distributeCharacters(length - 3, 4, 3);
  if (!lengths) return null;
  return lengths.map((size) => size === 1 ? "1" : size === 2 ? "10" : "100").join(".");
}

function ipv6OfLength(length: number): string | null {
  if (length === 2) return "::";
  for (let groups = 1; groups <= 7; groups += 1) {
    const lengths = distributeCharacters(length - 1 - groups, groups, 4);
    if (lengths) return `::${lengths.map((size) => "1".repeat(size)).join(":")}`;
  }
  const full = distributeCharacters(length - 7, 8, 4);
  return full ? full.map((size) => "1".repeat(size)).join(":") : null;
}

function firstLength(
  minimum: number,
  maximum: number,
  lower: number,
  upper: number,
  preferred: number,
): number | null {
  const low = Math.max(minimum, lower);
  const high = Math.min(maximum, upper);
  if (low > high) return null;
  return preferred >= low && preferred <= high ? preferred : low;
}

function boundedFormatSentinel(format: ConnectorStringFormat, minimum: number, maximum: number): string {
  const preferred = FORMAT_SENTINELS[format];
  if (preferred.length >= minimum && preferred.length <= maximum) return preferred;
  if (format === "date") {
    if (minimum <= 10 && maximum >= 10) return FORMAT_SENTINELS.date;
    return impossible();
  }
  if (format === "uuid") {
    if (minimum <= 36 && maximum >= 36) return FORMAT_SENTINELS.uuid;
    return impossible();
  }
  if (format === "date-time") {
    const length = firstLength(minimum, maximum, 22, MAX_SENTINEL_STRING_BYTES, preferred.length);
    if (length === null) return impossible();
    return `2000-01-01T00:00:00.${"0".repeat(length - 21)}Z`;
  }
  if (format === "time") {
    const length = firstLength(minimum, maximum, 11, MAX_SENTINEL_STRING_BYTES, preferred.length);
    if (length === null) return impossible();
    return `00:00:00.${"0".repeat(length - 10)}Z`;
  }
  if (format === "email") {
    const length = firstLength(minimum, maximum, 3, 254, preferred.length);
    const hostname = length === null ? null : hostnameOfLength(length - 2);
    return hostname ? `a@${hostname}` : impossible();
  }
  if (format === "hostname") {
    const length = firstLength(minimum, maximum, 1, 253, preferred.length);
    return length === null ? impossible() : hostnameOfLength(length) ?? impossible();
  }
  if (format === "ipv4") {
    const length = firstLength(minimum, maximum, 7, 15, preferred.length);
    return length === null ? impossible() : ipv4OfLength(length) ?? impossible();
  }
  if (format === "ipv6") {
    const length = firstLength(minimum, maximum, 2, 39, preferred.length);
    return length === null ? impossible() : ipv6OfLength(length) ?? impossible();
  }
  const length = firstLength(minimum, maximum, 2, MAX_SENTINEL_STRING_BYTES, preferred.length);
  return length === null ? impossible() : `x:${"a".repeat(length - 2)}`;
}

function stringSentinel(schema: ConnectorSchemaV1): string {
  const minimum = schema.minLength ?? 0;
  const maximum = Math.min(schema.maxLength ?? MAX_SENTINEL_STRING_BYTES, MAX_SENTINEL_STRING_BYTES);
  if (minimum > maximum) impossible();
  return schema.format
    ? boundedFormatSentinel(schema.format, minimum, maximum)
    : "x".repeat(minimum);
}

function generate(schema: ConnectorSchemaV1, budget: SentinelBudget): JsonValue {
  budget.values += 1;
  if (budget.values > CONNECTOR_IMPORT_V1_LIMITS.maxInspectedValues) impossible();
  switch (baseType(schema)) {
    case "null": return null;
    case "boolean": return false;
    case "number": return numberSentinel(schema, false);
    case "integer": return numberSentinel(schema, true);
    case "string": return stringSentinel(schema);
    case "array": {
      if (!schema.items) impossible();
      const count = schema.minItems ?? 0;
      if (count > (schema.maxItems ?? Number.MAX_SAFE_INTEGER) ||
          count > CONNECTOR_IMPORT_V1_LIMITS.maxInspectedValues) impossible();
      return Array.from({ length: count }, () => generate(schema.items!, budget));
    }
    case "object": {
      if (!schema.properties || schema.additionalProperties !== false) impossible();
      const result = Object.create(null) as Record<string, JsonValue>;
      for (const key of schema.required ?? []) {
        const property = schema.properties[key];
        if (!property) impossible();
        Object.defineProperty(result, key, {
          value: generate(property, budget), enumerable: true, writable: true, configurable: true,
        });
      }
      return result;
    }
  }
}

export function generateSchemaSentinel(value: unknown): JsonValue {
  const schema = parseConnectorSchemaV1(value);
  const sentinel = deepFreeze(generate(schema, { values: 0 }));
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(sentinel), "utf8"); } catch { return impossible(); }
  if (bytes > CONNECTOR_IMPORT_V1_LIMITS.maxCanonicalProjectionBytes) impossible();
  return sentinel;
}
