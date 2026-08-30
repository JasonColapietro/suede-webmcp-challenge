export type TestConnectionKind = "api_key" | "bearer" | "basic" | "custom_headers";
export type TestConnectionSlotStatus = "configured" | "missing" | "revoked";

export interface TestConnectionMetadata {
  readonly kind: TestConnectionKind;
  readonly publicHeaderNames: readonly string[];
  readonly lifecycleRevision: number;
  readonly testSlotStatus: TestConnectionSlotStatus;
  readonly idSuffix: string;
}

/** The complete capability exposed to readiness. It cannot mutate, resolve, or decrypt. */
export interface TestConnectionMetadataReader {
  readTestMetadata(ownerId: string, connectionId: string): TestConnectionMetadata | null;
}

interface MetadataStatement {
  get(ownerId: string, connectionId: string): unknown;
}

interface TestConnectionMetadataDatabase {
  prepare(sql: string): MetadataStatement;
}

export const TEST_CONNECTION_METADATA_QUERY = `SELECT
  connection.kind AS kind,
  connection.public_config AS public_config,
  connection.lifecycle_revision AS lifecycle_revision,
  COALESCE(test_slot.status, 'missing') AS test_slot_status,
  substr('00000000' || lower(hex(CAST(connection.id AS BLOB))), -8) AS id_suffix
FROM connections connection
LEFT JOIN connection_slots test_slot
  ON test_slot.connection_id = connection.id
  AND test_slot.environment = 'test'
WHERE connection.owner_id = ? AND connection.id = ?
LIMIT 1`;

const CONTROL = /[\u0000-\u001f\u007f]/u;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const FORBIDDEN_HEADERS = new Set([
  "__proto__", "accept", "authorization", "connection", "constructor", "content-length",
  "content-type", "cookie", "forwarded", "host", "keep-alive", "origin", "prototype",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "referer", "te", "trailer",
  "transfer-encoding", "upgrade", "user-agent", "via",
]);
const SAFE_SUFFIX = /^[0-9a-f]{8}$/u;
const MAX_HEADER_NAMES = 16;
const MAX_HEADER_NAME_CHARACTERS = 64;
const UTF8 = new TextEncoder();

function boundedIdentity(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !CONTROL.test(value) && UTF8.encode(value).byteLength <= maxBytes;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
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

function headerName(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_HEADER_NAME_CHARACTERS ||
      !HEADER_TOKEN.test(value)) return null;
  const folded = value.toLowerCase();
  return FORBIDDEN_HEADERS.has(folded) || folded.startsWith("x-forwarded-") ? null : folded;
}

function exactArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > MAX_HEADER_NAMES || Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...value.keys()].map(String).concat("length"));
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) return null;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
  }
  return value;
}

function publicHeaders(kind: TestConnectionKind, raw: unknown): readonly string[] | null {
  let parsed: unknown;
  try {
    if (typeof raw !== "string" || UTF8.encode(raw).byteLength > 32 * 1024) return null;
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (kind === "api_key") {
    const record = exactRecord(parsed, ["headerName"]);
    const name = record ? headerName(record.headerName) : null;
    return name ? Object.freeze([name]) : null;
  }
  if (kind === "custom_headers") {
    const record = exactRecord(parsed, ["headerNames"]);
    const candidates = record ? exactArray(record.headerNames) : null;
    if (!candidates) return null;
    const names = candidates.map(headerName);
    if (names.some((name) => name === null)) return null;
    const folded = names as string[];
    if (new Set(folded).size !== folded.length) return null;
    return Object.freeze([...folded].sort());
  }
  return exactRecord(parsed, []) ? Object.freeze(["authorization"]) : null;
}

function metadata(value: unknown): TestConnectionMetadata | null {
  const record = exactRecord(value, [
    "kind", "public_config", "lifecycle_revision", "test_slot_status", "id_suffix",
  ]);
  if (!record || (record.kind !== "api_key" && record.kind !== "bearer" &&
      record.kind !== "basic" && record.kind !== "custom_headers") ||
      !Number.isSafeInteger(record.lifecycle_revision) || (record.lifecycle_revision as number) < 1 ||
      (record.test_slot_status !== "configured" && record.test_slot_status !== "missing" &&
        record.test_slot_status !== "revoked") || typeof record.id_suffix !== "string" ||
      !SAFE_SUFFIX.test(record.id_suffix)) return null;
  const names = publicHeaders(record.kind, record.public_config);
  if (!names) return null;
  return Object.freeze({
    kind: record.kind,
    publicHeaderNames: names,
    lifecycleRevision: record.lifecycle_revision as number,
    testSlotStatus: record.test_slot_status,
    idSuffix: record.id_suffix,
  });
}

export class SqliteTestConnectionMetadataReader implements TestConnectionMetadataReader {
  readonly #database: TestConnectionMetadataDatabase;

  constructor(database: TestConnectionMetadataDatabase) {
    this.#database = database;
  }

  readTestMetadata(ownerId: string, connectionId: string): TestConnectionMetadata | null {
    if (!boundedIdentity(ownerId, 512) || !boundedIdentity(connectionId, 256)) return null;
    try {
      const row = this.#database.prepare(TEST_CONNECTION_METADATA_QUERY).get(ownerId, connectionId);
      return row === undefined ? null : metadata(row);
    } catch {
      return null;
    }
  }
}
