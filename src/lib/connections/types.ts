/** Strict, secret-free connection contracts and static-auth normalization. */

export const CONNECTION_INPUT_ERROR = "Invalid connection input";

export type ConnectionKind = "api_key" | "bearer" | "basic" | "custom_headers";
export type ConnectionEnvironment = "test" | "live";
export type ConnectionSlotStatus = "missing" | "configured" | "revoked";
export type ConnectionSemanticField = "headers" | "webhook";

export interface ConnectionSlotView {
  readonly environment: ConnectionEnvironment;
  readonly status: ConnectionSlotStatus;
  readonly secretVersion: number;
  readonly updatedAt: number | null;
  readonly revokedAt: number | null;
}

export interface ConnectionView {
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectionKind;
  readonly publicConfig: Readonly<Record<string, string | readonly string[]>>;
  readonly lifecycleRevision: number;
  readonly slots: Readonly<{ test: ConnectionSlotView; live: ConnectionSlotView }>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ConnectionSecretInput =
  | { readonly kind: "api_key"; readonly apiKey: string }
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "basic"; readonly username: string; readonly password: string }
  | { readonly kind: "custom_headers"; readonly values: Readonly<Record<string, string>> };

export type ConnectionCreateInput =
  | { readonly name: string; readonly kind: "api_key"; readonly publicConfig: Readonly<{ headerName: string }> }
  | { readonly name: string; readonly kind: "bearer"; readonly publicConfig: Readonly<Record<string, never>> }
  | { readonly name: string; readonly kind: "basic"; readonly publicConfig: Readonly<Record<string, never>> }
  | { readonly name: string; readonly kind: "custom_headers"; readonly publicConfig: Readonly<{ headerNames: readonly string[] }> };

const MAX_ID_CHARACTERS = 256;
const MAX_NAME_BYTES = 120;
const MAX_HEADER_COUNT = 16;
const MAX_HEADER_NAME_CHARACTERS = 64;
const MAX_SECRET_STRING_BYTES = 8_192;
const MAX_SECRET_JSON_BYTES = 32 * 1024;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/u;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_HEADERS = new Set([
  "__proto__",
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "prototype",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "constructor",
]);

function invalid(): never {
  throw new TypeError(CONNECTION_INPUT_ERROR);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (symbols.length !== 0) invalid();
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  const allowed = new Set([...value.keys()].map(String).concat("length"));
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) invalid();
  return value;
}

function boundedString(value: unknown, maximumBytes: number, controlsAllowed = false): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) invalid();
  if (!controlsAllowed && CONTROL_CHAR.test(value)) invalid();
  return value;
}

function parseName(value: unknown): string {
  const name = boundedString(value, MAX_NAME_BYTES);
  if (name.trim() !== name) invalid();
  return name;
}

function parseHeaderName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_HEADER_NAME_CHARACTERS) invalid();
  if (!HEADER_TOKEN.test(value) || FORBIDDEN_HEADERS.has(value.toLowerCase())) invalid();
  return value;
}

function parseHeaderNames(value: unknown): readonly string[] {
  const input = exactArray(value, MAX_HEADER_COUNT);
  if (input.length === 0) invalid();
  const seen = new Set<string>();
  const names = input.map((candidate) => {
    const name = parseHeaderName(candidate);
    const folded = name.toLowerCase();
    if (seen.has(folded)) invalid();
    seen.add(folded);
    return name;
  });
  return Object.freeze(names);
}

function parsePublicConfig(kind: ConnectionKind, value: unknown): ConnectionCreateInput["publicConfig"] {
  if (kind === "api_key") {
    const config = exactRecord(value, ["headerName"]);
    return Object.freeze({ headerName: parseHeaderName(config.headerName) });
  }
  if (kind === "custom_headers") {
    const config = exactRecord(value, ["headerNames"]);
    return Object.freeze({ headerNames: parseHeaderNames(config.headerNames) });
  }
  exactRecord(value, []);
  return Object.freeze(Object.create(null) as Record<string, never>);
}

function parseKind(value: unknown): ConnectionKind {
  if (value === "api_key" || value === "bearer" || value === "basic" || value === "custom_headers") return value;
  return invalid();
}

function parseConnectionCreateInputUnsafe(value: unknown): ConnectionCreateInput {
  const record = exactRecord(value, ["name", "kind", "publicConfig"]);
  const kind = parseKind(record.kind);
  const name = parseName(record.name);
  const publicConfig = parsePublicConfig(kind, record.publicConfig);
  return Object.freeze({ name, kind, publicConfig }) as ConnectionCreateInput;
}

export function parseConnectionCreateInput(value: unknown): ConnectionCreateInput {
  try {
    return parseConnectionCreateInputUnsafe(value);
  } catch {
    return invalid();
  }
}

function parseCustomValues(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length < 1 || keys.length > MAX_HEADER_COUNT) invalid();
  const seen = new Set<string>();
  const result = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    const name = parseHeaderName(key);
    const folded = name.toLowerCase();
    if (seen.has(folded)) invalid();
    seen.add(folded);
    result[name] = boundedString(descriptor.value, MAX_SECRET_STRING_BYTES);
  }
  return Object.freeze(result);
}

function assertSecretAggregate(input: ConnectionSecretInput): ConnectionSecretInput {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_SECRET_JSON_BYTES) invalid();
  return input;
}

function parseConnectionSecretInputUnsafe(value: unknown): ConnectionSecretInput {
  const kindRecord = exactRecordForSecretKind(value);
  const kind = parseKind(kindRecord.kind);
  let result: ConnectionSecretInput;
  if (kind === "api_key") {
    const record = exactRecord(value, ["kind", "apiKey"]);
    result = Object.freeze({ kind, apiKey: boundedString(record.apiKey, MAX_SECRET_STRING_BYTES) });
  } else if (kind === "bearer") {
    const record = exactRecord(value, ["kind", "token"]);
    result = Object.freeze({ kind, token: boundedString(record.token, MAX_SECRET_STRING_BYTES) });
  } else if (kind === "basic") {
    const record = exactRecord(value, ["kind", "username", "password"]);
    const username = boundedString(record.username, MAX_SECRET_STRING_BYTES);
    if (username.includes(":")) invalid();
    result = Object.freeze({
      kind,
      username,
      password: boundedString(record.password, MAX_SECRET_STRING_BYTES),
    });
  } else {
    const record = exactRecord(value, ["kind", "values"]);
    result = Object.freeze({ kind, values: parseCustomValues(record.values) });
  }
  return assertSecretAggregate(result);
}

export function parseConnectionSecretInput(value: unknown): ConnectionSecretInput {
  try {
    return parseConnectionSecretInputUnsafe(value);
  } catch {
    return invalid();
  }
}

function exactRecordForSecretKind(value: unknown): { kind: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  return { kind: descriptor.value };
}

export function normalizeConnectionSecret(
  createValue: unknown,
  secretValue: unknown,
): Readonly<Record<string, string>> {
  const create = parseConnectionCreateInput(createValue);
  const secret = parseConnectionSecretInput(secretValue);
  if (create.kind !== secret.kind) invalid();
  const headers = Object.create(null) as Record<string, string>;
  if (secret.kind === "api_key" && create.kind === "api_key") {
    headers[create.publicConfig.headerName] = secret.apiKey;
  } else if (secret.kind === "bearer") {
    headers.Authorization = `Bearer ${secret.token}`;
  } else if (secret.kind === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${secret.username}:${secret.password}`, "utf8").toString("base64")}`;
  } else if (secret.kind === "custom_headers" && create.kind === "custom_headers") {
    const supplied = new Map(Object.entries(secret.values).map(([key, value]) => [key.toLowerCase(), { key, value }]));
    if (supplied.size !== create.publicConfig.headerNames.length) invalid();
    for (const name of create.publicConfig.headerNames) {
      const suppliedHeader = supplied.get(name.toLowerCase());
      if (suppliedHeader === undefined || suppliedHeader.key !== name) invalid();
      headers[name] = suppliedHeader.value;
    }
  } else {
    invalid();
  }
  return Object.freeze(headers);
}

function positiveInteger(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) < 1)) invalid();
  return value as number;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : positiveInteger(value);
}

function parseSlot(value: unknown, environment: ConnectionEnvironment): ConnectionSlotView {
  const record = exactRecord(value, ["environment", "status", "secretVersion", "updatedAt", "revokedAt"]);
  if (record.environment !== environment) invalid();
  const status = record.status;
  if (status !== "missing" && status !== "configured" && status !== "revoked") invalid();
  const secretVersion = positiveInteger(record.secretVersion, true);
  const updatedAt = nullableTimestamp(record.updatedAt);
  const revokedAt = nullableTimestamp(record.revokedAt);
  if (status === "missing" && (secretVersion !== 0 || updatedAt !== null || revokedAt !== null)) invalid();
  if (status === "configured" && (secretVersion < 1 || updatedAt === null || revokedAt !== null)) invalid();
  if (status === "revoked" && (secretVersion < 1 || updatedAt === null || revokedAt === null)) invalid();
  return Object.freeze({ environment, status, secretVersion, updatedAt, revokedAt });
}

function parseConnectionViewUnsafe(value: unknown): ConnectionView {
  const record = exactRecord(value, [
    "id", "name", "kind", "publicConfig", "lifecycleRevision", "slots", "createdAt", "updatedAt",
  ]);
  if (typeof record.id !== "string" || record.id.length < 1 || record.id.length > MAX_ID_CHARACTERS || !SAFE_ID.test(record.id)) invalid();
  const kind = parseKind(record.kind);
  const slotsRecord = exactRecord(record.slots, ["test", "live"]);
  const view: ConnectionView = {
    id: record.id,
    name: parseName(record.name),
    kind,
    publicConfig: parsePublicConfig(kind, record.publicConfig),
    lifecycleRevision: positiveInteger(record.lifecycleRevision),
    slots: Object.freeze({
      test: parseSlot(slotsRecord.test, "test"),
      live: parseSlot(slotsRecord.live, "live"),
    }),
    createdAt: positiveInteger(record.createdAt),
    updatedAt: positiveInteger(record.updatedAt),
  };
  return Object.freeze(view);
}

export function parseConnectionView(value: unknown): ConnectionView {
  try {
    return parseConnectionViewUnsafe(value);
  } catch {
    return invalid();
  }
}
