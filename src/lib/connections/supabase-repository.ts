import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalConnectionPublicConfig,
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "./crypto";
import {
  ConnectionRepositoryUnavailableError,
  InvalidConnectionPageError,
  type CloseableConnectionRepository,
  type ConnectionListPage,
  type ConnectionListResult,
  type ConnectionUsageItem,
  type ConnectionUsageResult,
  type MutationResult,
} from "./repository";
import {
  normalizeConnectionSecret,
  parseConnectionCreateInput,
  parseConnectionSecretInput,
  parseConnectionView,
  type ConnectionCreateInput,
  type ConnectionEnvironment,
  type ConnectionKind,
  type ConnectionSecretInput,
  type ConnectionView,
} from "./types";
import { scanConnectionReferences } from "./usage-parser";

const PAGE_ERROR = "Invalid connection page";
const MAX_USAGE_ARTIFACTS = 500;
const MAX_USAGE_BYTES = 16 * 1024 * 1024;
const MAX_USAGE_MATCHES = 100;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const CONNECTION_COLUMNS = [
  "id",
  "name",
  "kind",
  "public_config",
  "schema_version",
  "lifecycle_revision",
  "created_at",
  "updated_at",
].join(",");
const SLOT_METADATA_COLUMNS = [
  "environment",
  "status",
  "secret_version",
  "updated_at",
  "revoked_at",
].join(",");
const CONNECTION_WITH_SLOTS = `${CONNECTION_COLUMNS},connection_slots(${SLOT_METADATA_COLUMNS})`;
const INTERNAL_CONNECTION_WITH_SLOTS = `${CONNECTION_COLUMNS},crypto_owner_id,connection_slots(${SLOT_METADATA_COLUMNS})`;
const PROTECTED_SLOT_SELECT = [
  "connection_id",
  "environment",
  "status",
  "secret_version",
  "key_version",
  "nonce",
  "ciphertext",
  "auth_tag",
  "connections!inner(id,owner_id,crypto_owner_id,kind,public_config,schema_version)",
].join(",");

interface ListCursor {
  readonly updatedAt: number;
  readonly id: string;
}

type ListFilter =
  | { readonly kind: "same_timestamp"; readonly updatedAt: number; readonly id: string }
  | { readonly kind: "older"; readonly updatedAt: number };

interface UsageCursor {
  readonly artifactKind: "draft" | "active_deployment";
  readonly sortAt: number;
  readonly flowId: string;
  readonly flowVersionId: string | null;
  readonly environment: "draft" | "test" | "live";
}

interface ParsedConnectionRow {
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectionKind;
  readonly publicConfig: ConnectionCreateInput["publicConfig"];
  readonly schemaVersion: 1;
  readonly lifecycleRevision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly slots: readonly ParsedSlotRow[];
}

interface ParsedSlotRow {
  readonly environment: ConnectionEnvironment;
  readonly status: "configured" | "revoked";
  readonly secretVersion: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
}

interface InternalConnectionRow extends ParsedConnectionRow {
  readonly cryptoOwnerId: string;
}

interface UsageArtifact {
  readonly artifactKind: "draft" | "active_deployment";
  readonly flowId: string;
  readonly flowName: string;
  readonly flowVersionId: string | null;
  readonly environment: "draft" | "test" | "live";
  readonly sortAt: number;
  readonly graphBytes: number;
  readonly graph: string | null;
}

export interface SupabaseConnectionRepositoryOptions {
  /** Boolean-only disposal observation. Key bytes are never exposed. */
  readonly onKeyWiped?: (zeroed: boolean) => void;
}

function unavailable(): never {
  throw new ConnectionRepositoryUnavailableError();
}

function secretUnavailable(): never {
  throw new Error("Connection secret unavailable");
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return unavailable();
  if (Object.getOwnPropertySymbols(value).length !== 0) return unavailable();
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) return unavailable();
    result[key] = descriptor.value;
  }
  return result;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) unavailable();
}

function plainArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    return unavailable();
  }
  return value;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) return unavailable();
  return value;
}

function boundedUtf8String(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    return unavailable();
  }
  return value;
}

function safeInteger(value: unknown, allowZero = false): number {
  let number = value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) number = Number(value);
  if (!Number.isSafeInteger(number) || (allowZero ? (number as number) < 0 : (number as number) < 1)) {
    return unavailable();
  }
  return number as number;
}

function inputPositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid connection input");
  return value;
}

function pageLimit(page: ConnectionListPage): number {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new TypeError(PAGE_ERROR);
  return page.limit;
}

function invalidPage(): never {
  throw new InvalidConnectionPageError();
}

function decodedRecord(cursor: string): Record<string, unknown> {
  try {
    if (cursor.length < 1 || cursor.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error();
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) throw new Error();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalidPage();
  }
}

function exactCursorKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidPage();
  }
}

function parseListCursor(cursor: string | undefined): ListCursor | null {
  if (cursor === undefined) return null;
  const value = decodedRecord(cursor);
  exactCursorKeys(value, ["updatedAt", "id"]);
  if (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0 ||
      typeof value.id !== "string" || !UUID.test(value.id)) {
    invalidPage();
  }
  return { updatedAt: value.updatedAt as number, id: value.id };
}

function parseUsageCursor(cursor: string | undefined): UsageCursor | null {
  if (cursor === undefined) return null;
  const value = decodedRecord(cursor);
  exactCursorKeys(value, ["artifactKind", "sortAt", "flowId", "flowVersionId", "environment"]);
  if ((value.artifactKind !== "draft" && value.artifactKind !== "active_deployment") ||
      !Number.isSafeInteger(value.sortAt) || (value.sortAt as number) < 0 ||
      typeof value.flowId !== "string" || !UUID.test(value.flowId) ||
      (value.flowVersionId !== null && (typeof value.flowVersionId !== "string" || !UUID.test(value.flowVersionId)))) {
    invalidPage();
  }
  if (value.artifactKind === "draft") {
    if (value.flowVersionId !== null || value.environment !== "draft") invalidPage();
  } else if (typeof value.flowVersionId !== "string" || value.flowVersionId.length < 1 ||
      (value.environment !== "test" && value.environment !== "live")) {
    invalidPage();
  }
  return {
    artifactKind: value.artifactKind,
    sortAt: value.sortAt as number,
    flowId: value.flowId,
    flowVersionId: value.flowVersionId,
    environment: value.environment as UsageCursor["environment"],
  };
}

function encodeCursor(value: ListCursor | UsageCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseSlotRow(value: unknown): ParsedSlotRow {
  const row = plainRecord(value);
  exactKeys(row, ["environment", "status", "secret_version", "updated_at", "revoked_at"]);
  if (row.environment !== "test" && row.environment !== "live") return unavailable();
  if (row.status !== "configured" && row.status !== "revoked") return unavailable();
  const secretVersion = safeInteger(row.secret_version);
  const updatedAt = safeInteger(row.updated_at);
  const revokedAt = row.revoked_at === null ? null : safeInteger(row.revoked_at);
  if ((row.status === "configured") !== (revokedAt === null)) return unavailable();
  return Object.freeze({
    environment: row.environment,
    status: row.status,
    secretVersion,
    updatedAt,
    revokedAt,
  });
}

function parseConnectionRow(value: unknown, requireCryptoOwner = false): ParsedConnectionRow | InternalConnectionRow {
  const row = plainRecord(value);
  const expected = [
    "id", "name", "kind", "public_config", "schema_version", "lifecycle_revision", "created_at", "updated_at",
    "connection_slots",
  ];
  if (requireCryptoOwner) expected.push("crypto_owner_id");
  exactKeys(row, expected);
  if (row.kind !== "api_key" && row.kind !== "bearer" && row.kind !== "basic" && row.kind !== "custom_headers") {
    return unavailable();
  }
  if (safeInteger(row.schema_version) !== 1) return unavailable();
  let parsedCreate: ConnectionCreateInput;
  try {
    parsedCreate = parseConnectionCreateInput({
      name: row.name,
      kind: row.kind,
      publicConfig: row.public_config,
    });
  } catch {
    return unavailable();
  }
  const slots = plainArray(row.connection_slots, 2).map(parseSlotRow);
  if (new Set(slots.map(({ environment }) => environment)).size !== slots.length) return unavailable();
  const parsed: ParsedConnectionRow = Object.freeze({
    id: boundedString(row.id, 256),
    name: parsedCreate.name,
    kind: parsedCreate.kind,
    publicConfig: parsedCreate.publicConfig,
    schemaVersion: 1,
    lifecycleRevision: safeInteger(row.lifecycle_revision),
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.updated_at),
    slots: Object.freeze(slots),
  });
  if (!requireCryptoOwner) return parsed;
  return Object.freeze({ ...parsed, cryptoOwnerId: boundedString(row.crypto_owner_id, 512) });
}

function slotView(environment: ConnectionEnvironment, slot: ParsedSlotRow | undefined) {
  if (!slot) {
    return Object.freeze({ environment, status: "missing" as const, secretVersion: 0, updatedAt: null, revokedAt: null });
  }
  return Object.freeze({
    environment,
    status: slot.status,
    secretVersion: slot.secretVersion,
    updatedAt: slot.updatedAt,
    revokedAt: slot.revokedAt,
  });
}

function connectionView(row: ParsedConnectionRow): ConnectionView {
  const slots = new Map(row.slots.map((slot) => [slot.environment, slot]));
  try {
    return parseConnectionView({
      id: row.id,
      name: row.name,
      kind: row.kind,
      publicConfig: row.publicConfig,
      lifecycleRevision: row.lifecycleRevision,
      slots: Object.freeze({
        test: slotView("test", slots.get("test")),
        live: slotView("live", slots.get("live")),
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch {
    return unavailable();
  }
}

function rowWithNoSlots(value: unknown): Record<string, unknown> {
  const row = plainRecord(value);
  exactKeys(row, ["id", "name", "kind", "public_config", "schema_version", "lifecycle_revision", "created_at", "updated_at"]);
  return Object.freeze({ ...row, connection_slots: Object.freeze([]) });
}

function rows(value: unknown, maximum: number): readonly unknown[] {
  return plainArray(value, maximum);
}

function rpcStatus(value: unknown): MutationResult["status"] {
  if (typeof value === "string") {
    if (value === "updated" || value === "conflict" || value === "not-found") return value;
    return unavailable();
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) return unavailable();
    return rpcStatus(value[0]);
  }
  const record = plainRecord(value);
  exactKeys(record, ["status"]);
  return rpcStatus(record.status);
}

function bytea(value: Buffer): string {
  return `\\x${value.toString("hex")}`;
}

function parseBytea(value: unknown, minimum: number, maximum: number): Buffer {
  if (typeof value !== "string" || !/^\\x(?:[0-9a-fA-F]{2})+$/u.test(value)) return secretUnavailable();
  const result = Buffer.from(value.slice(2), "hex");
  if (result.length < minimum || result.length > maximum) {
    result.fill(0);
    return secretUnavailable();
  }
  return result;
}

function unwrapRpcObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length !== 1) return unavailable();
    return plainRecord(value[0]);
  }
  return plainRecord(value);
}

function parseUsageArtifact(value: unknown): UsageArtifact {
  const row = plainRecord(value);
  exactKeys(row, [
    "artifactKind", "flowId", "flowName", "flowVersionId", "environment", "sortAt", "graphBytes", "graph",
  ]);
  if (row.artifactKind !== "draft" && row.artifactKind !== "active_deployment") return unavailable();
  if (row.artifactKind === "draft") {
    if (row.environment !== "draft" || row.flowVersionId !== null) return unavailable();
  } else if ((row.environment !== "test" && row.environment !== "live") ||
      typeof row.flowVersionId !== "string" || row.flowVersionId.length < 1) {
    return unavailable();
  }
  return Object.freeze({
    artifactKind: row.artifactKind,
    flowId: boundedString(row.flowId, 256),
    flowName: boundedUtf8String(row.flowName, 200),
    flowVersionId: row.flowVersionId === null ? null : boundedString(row.flowVersionId, 256),
    environment: row.environment as UsageArtifact["environment"],
    sortAt: safeInteger(row.sortAt, true),
    graphBytes: safeInteger(row.graphBytes, true),
    graph: row.graph === null ? null : typeof row.graph === "string" ? row.graph : unavailable(),
  });
}

function usageCursor(artifact: UsageArtifact): UsageCursor {
  return {
    artifactKind: artifact.artifactKind,
    sortAt: artifact.sortAt,
    flowId: artifact.flowId,
    flowVersionId: artifact.flowVersionId,
    environment: artifact.environment,
  };
}

export class SupabaseConnectionRepository implements CloseableConnectionRepository {
  readonly #db: SupabaseClient;
  readonly #key: Buffer;
  readonly #onKeyWiped: ((zeroed: boolean) => void) | undefined;
  #terminal = false;

  constructor(
    encryptionKey: Buffer,
    client: SupabaseClient,
    options: SupabaseConnectionRepositoryOptions = {},
  ) {
    this.#db = client;
    this.#key = Buffer.from(encryptionKey);
    this.#onKeyWiped = options.onKeyWiped;
  }

  #assertOpen(): void {
    if (this.#terminal) unavailable();
  }

  close(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#key.fill(0);
    const zeroed = this.#key.every((value) => value === 0);
    try { this.#onKeyWiped?.(zeroed); } catch { /* observation cannot alter disposal */ }
  }

  dispose(): void {
    this.close();
  }

  async #getParsed(ownerId: string, connectionId: string): Promise<ParsedConnectionRow | null> {
    const { data, error } = await this.#db.from("connections")
      .select(CONNECTION_WITH_SLOTS)
      .eq("owner_id", ownerId)
      .eq("id", connectionId)
      .maybeSingle();
    if (error) return unavailable();
    return data === null ? null : parseConnectionRow(data);
  }

  async #getInternal(ownerId: string, connectionId: string): Promise<InternalConnectionRow | null> {
    const { data, error } = await this.#db.from("connections")
      .select(INTERNAL_CONNECTION_WITH_SLOTS)
      .eq("owner_id", ownerId)
      .eq("id", connectionId)
      .maybeSingle();
    if (error) return unavailable();
    return data === null ? null : parseConnectionRow(data, true) as InternalConnectionRow;
  }

  async create(ownerId: string, input: ConnectionCreateInput, now: number): Promise<ConnectionView> {
    this.#assertOpen();
    const parsed = parseConnectionCreateInput(input);
    const timestamp = inputPositiveInteger(now);
    const canonical = canonicalConnectionPublicConfig(parsed.kind, parsed.publicConfig);
    const id = randomUUID();
    const { data, error } = await this.#db.from("connections").insert({
      id,
      owner_id: ownerId,
      crypto_owner_id: ownerId,
      name: parsed.name,
      kind: parsed.kind,
      public_config: canonical.value,
      schema_version: 1,
      lifecycle_revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }).select(CONNECTION_COLUMNS).single();
    if (error || data === null) return unavailable();
    return connectionView(parseConnectionRow(rowWithNoSlots(data)));
  }

  async #listQuery(
    ownerId: string,
    limit: number,
    filter?: ListFilter,
  ): Promise<readonly ParsedConnectionRow[]> {
    let query = this.#db.from("connections").select(CONNECTION_WITH_SLOTS).eq("owner_id", ownerId);
    if (filter?.kind === "same_timestamp") {
      query = query.eq("updated_at", filter.updatedAt).lt("id", filter.id);
    } else if (filter?.kind === "older") {
      query = query.lt("updated_at", filter.updatedAt);
    }
    const { data, error } = await query.order("updated_at", { ascending: false })
      .order("id", { ascending: false }).limit(limit);
    if (error) return unavailable();
    return Object.freeze(rows(data, limit).map((row) => parseConnectionRow(row)));
  }

  async list(ownerId: string, page: ConnectionListPage): Promise<ConnectionListResult> {
    this.#assertOpen();
    const limit = pageLimit(page);
    const cursor = parseListCursor(page.cursor);
    let selected: readonly ParsedConnectionRow[];
    if (!cursor) {
      selected = await this.#listQuery(ownerId, limit + 1);
    } else {
      const sameTimestamp = await this.#listQuery(
        ownerId,
        limit + 1,
        { kind: "same_timestamp", updatedAt: cursor.updatedAt, id: cursor.id },
      );
      const remaining = limit + 1 - sameTimestamp.length;
      const older = remaining > 0
        ? await this.#listQuery(ownerId, remaining, { kind: "older", updatedAt: cursor.updatedAt })
        : Object.freeze([]) as readonly ParsedConnectionRow[];
      selected = Object.freeze([...sameTimestamp, ...older]);
    }
    const pageRows = selected.slice(0, limit);
    const last = pageRows.at(-1);
    return Object.freeze({
      items: Object.freeze(pageRows.map(connectionView)),
      nextCursor: selected.length > limit && last
        ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
        : null,
    });
  }

  async get(ownerId: string, connectionId: string): Promise<ConnectionView | null> {
    this.#assertOpen();
    if (!UUID.test(connectionId)) return null;
    const row = await this.#getParsed(ownerId, connectionId);
    return row ? connectionView(row) : null;
  }

  async rename(
    ownerId: string,
    connectionId: string,
    expectedLifecycleRevision: number,
    name: string,
    now: number,
  ): Promise<MutationResult> {
    this.#assertOpen();
    if (!UUID.test(connectionId)) return Object.freeze({ status: "not-found" as const });
    inputPositiveInteger(expectedLifecycleRevision);
    const timestamp = inputPositiveInteger(now);
    const current = await this.#getParsed(ownerId, connectionId);
    if (!current) return Object.freeze({ status: "not-found" as const });
    if (current.lifecycleRevision !== expectedLifecycleRevision) {
      return Object.freeze({ status: "conflict" as const });
    }
    const parsedName = parseConnectionCreateInput({
      name,
      kind: current.kind,
      publicConfig: current.publicConfig,
    }).name;
    const { data, error } = await this.#db.from("connections").update({
      name: parsedName,
      updated_at: timestamp,
      lifecycle_revision: expectedLifecycleRevision + 1,
    }).eq("owner_id", ownerId).eq("id", connectionId)
      .eq("lifecycle_revision", expectedLifecycleRevision).select("id").maybeSingle();
    if (error) return unavailable();
    if (data === null) return Object.freeze({ status: "conflict" as const });
    const updated = await this.#getParsed(ownerId, connectionId);
    if (!updated) return unavailable();
    return Object.freeze({ status: "updated" as const, connection: connectionView(updated) });
  }

  async configureSlot(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    expectedLifecycleRevision: number,
    secret: ConnectionSecretInput,
    now: number,
  ): Promise<MutationResult> {
    this.#assertOpen();
    if (!UUID.test(connectionId)) return Object.freeze({ status: "not-found" as const });
    if (environment !== "test" && environment !== "live") throw new TypeError("Invalid connection input");
    inputPositiveInteger(expectedLifecycleRevision);
    const timestamp = inputPositiveInteger(now);
    const current = await this.#getInternal(ownerId, connectionId);
    if (!current) return Object.freeze({ status: "not-found" as const });
    if (current.lifecycleRevision !== expectedLifecycleRevision) {
      return Object.freeze({ status: "conflict" as const });
    }
    const parsedSecret = parseConnectionSecretInput(secret);
    if (parsedSecret.kind !== current.kind) throw new TypeError("Invalid connection input");
    const createInput = parseConnectionCreateInput({
      name: current.name,
      kind: current.kind,
      publicConfig: current.publicConfig,
    });
    normalizeConnectionSecret(createInput, parsedSecret);
    const currentSlot = current.slots.find((slot) => slot.environment === environment);
    const expectedSecretVersion = currentSlot?.secretVersion ?? 0;
    const nextSecretVersion = expectedSecretVersion + 1;
    const canonical = canonicalConnectionPublicConfig(current.kind, current.publicConfig);
    const envelope = encryptConnectionSecret({
      key: this.#key,
      ownerId: current.cryptoOwnerId,
      connectionId,
      kind: current.kind,
      environment,
      schemaVersion: 1,
      secretVersion: nextSecretVersion,
      publicConfigSha256: canonical.sha256,
      plaintext: Buffer.from(JSON.stringify(parsedSecret), "utf8"),
    });
    try {
      const { data, error } = await this.#db.rpc("agent_studio_configure_connection_slot", {
        p_owner_id: ownerId,
        p_connection_id: connectionId,
        p_environment: environment,
        p_expected_lifecycle_revision: expectedLifecycleRevision,
        p_expected_secret_version: nextSecretVersion,
        p_key_version: 1,
        p_nonce: bytea(envelope.nonce),
        p_ciphertext: bytea(envelope.ciphertext),
        p_auth_tag: bytea(envelope.authTag),
        p_now: timestamp,
      });
      if (error) return unavailable();
      const status = rpcStatus(data);
      if (status !== "updated") return Object.freeze({ status });
      const updated = await this.#getParsed(ownerId, connectionId);
      if (!updated) return unavailable();
      return Object.freeze({ status: "updated" as const, connection: connectionView(updated) });
    } finally {
      envelope.nonce.fill(0);
      envelope.ciphertext.fill(0);
      envelope.authTag.fill(0);
    }
  }

  async revokeSlot(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    expectedLifecycleRevision: number,
    now: number,
  ): Promise<MutationResult> {
    this.#assertOpen();
    if (!UUID.test(connectionId)) return Object.freeze({ status: "not-found" as const });
    if (environment !== "test" && environment !== "live") throw new TypeError("Invalid connection input");
    inputPositiveInteger(expectedLifecycleRevision);
    const timestamp = inputPositiveInteger(now);
    const { data, error } = await this.#db.rpc("agent_studio_revoke_connection_slot", {
      p_owner_id: ownerId,
      p_connection_id: connectionId,
      p_environment: environment,
      p_expected_lifecycle_revision: expectedLifecycleRevision,
      p_now: timestamp,
    });
    if (error) return unavailable();
    const status = rpcStatus(data);
    if (status !== "updated") return Object.freeze({ status });
    const updated = await this.#getParsed(ownerId, connectionId);
    if (!updated) return unavailable();
    return Object.freeze({ status: "updated" as const, connection: connectionView(updated) });
  }

  async resolveHeaders(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    field: "headers",
  ): Promise<Readonly<Record<string, string>> | null> {
    this.#assertOpen();
    if (field !== "headers" || (environment !== "test" && environment !== "live")) return null;
    if (!UUID.test(connectionId)) return null;
    const { data, error } = await this.#db.from("connection_slots")
      .select(PROTECTED_SLOT_SELECT)
      .eq("connection_id", connectionId)
      .eq("environment", environment)
      .eq("status", "configured")
      .eq("connections.owner_id", ownerId)
      .maybeSingle();
    if (error) return unavailable();
    if (data === null) return null;
    const slot = plainRecord(data);
    exactKeys(slot, [
      "connection_id", "environment", "status", "secret_version", "key_version", "nonce", "ciphertext", "auth_tag",
      "connections",
    ]);
    if (slot.connection_id !== connectionId || slot.environment !== environment || slot.status !== "configured" ||
        safeInteger(slot.key_version) !== 1) return secretUnavailable();
    const connection = plainRecord(slot.connections);
    exactKeys(connection, ["id", "owner_id", "crypto_owner_id", "kind", "public_config", "schema_version"]);
    if (connection.id !== connectionId || connection.owner_id !== ownerId || safeInteger(connection.schema_version) !== 1 ||
        (connection.kind !== "api_key" && connection.kind !== "bearer" && connection.kind !== "basic" &&
          connection.kind !== "custom_headers")) return secretUnavailable();
    let createInput: ConnectionCreateInput;
    try {
      createInput = parseConnectionCreateInput({
        name: "Protected connection",
        kind: connection.kind,
        publicConfig: connection.public_config,
      });
    } catch {
      return secretUnavailable();
    }
    const secretVersion = safeInteger(slot.secret_version);
    const nonce = parseBytea(slot.nonce, 12, 12);
    const ciphertext = parseBytea(slot.ciphertext, 1, 32_768);
    const authTag = parseBytea(slot.auth_tag, 16, 16);
    let plaintext: Buffer | null = null;
    try {
      const canonical = canonicalConnectionPublicConfig(createInput.kind, createInput.publicConfig);
      plaintext = decryptConnectionSecret({
        key: this.#key,
        ownerId: boundedString(connection.crypto_owner_id, 512),
        connectionId,
        kind: createInput.kind,
        environment,
        schemaVersion: 1,
        secretVersion,
        publicConfigSha256: canonical.sha256,
        envelope: { keyVersion: 1, nonce, ciphertext, authTag },
      });
      const parsed = parseConnectionSecretInput(JSON.parse(plaintext.toString("utf8")) as unknown);
      return normalizeConnectionSecret(createInput, parsed);
    } catch {
      return secretUnavailable();
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      authTag.fill(0);
      plaintext?.fill(0);
    }
  }

  async usage(
    ownerId: string,
    connectionId: string,
    page: ConnectionListPage,
  ): Promise<ConnectionUsageResult | null> {
    this.#assertOpen();
    if (!UUID.test(connectionId)) return null;
    const matchLimit = Math.min(pageLimit(page), MAX_USAGE_MATCHES);
    const cursor = parseUsageCursor(page.cursor);
    const { data, error } = await this.#db.rpc("agent_studio_connection_usage_artifacts", {
      p_owner_id: ownerId,
      p_connection_id: connectionId,
      p_cursor_artifact_order: cursor === null ? null : cursor.artifactKind === "draft" ? 0 : 1,
      p_cursor_sort_at: cursor?.sortAt ?? null,
      p_cursor_flow_id: cursor?.flowId ?? null,
      p_cursor_flow_version_id: cursor?.flowVersionId ?? null,
      p_cursor_environment: cursor?.environment ?? null,
      p_artifact_limit: MAX_USAGE_ARTIFACTS + 1,
      p_graph_byte_limit: MAX_ARTIFACT_BYTES,
      p_total_byte_limit: MAX_USAGE_BYTES,
    });
    if (error) return unavailable();
    const payload = unwrapRpcObject(data);
    if (payload.status === "not-found") {
      exactKeys(payload, ["status"]);
      return null;
    }
    exactKeys(payload, ["status", "lifecycleRevision", "artifacts", "truncated"]);
    if (payload.status !== "ok" || typeof payload.truncated !== "boolean") return unavailable();
    const artifacts = plainArray(payload.artifacts, MAX_USAGE_ARTIFACTS + 1).map(parseUsageArtifact);
    const lifecycleRevision = safeInteger(payload.lifecycleRevision);
    const items: ConnectionUsageItem[] = [];
    let encodedBytes = 0;
    let matchedLowerBound = 0;
    let scanned = 0;
    let truncated = payload.truncated || artifacts.length > MAX_USAGE_ARTIFACTS;
    let lastCursor: UsageCursor | null = null;

    for (const artifact of artifacts) {
      if (scanned >= MAX_USAGE_ARTIFACTS) {
        truncated = true;
        break;
      }
      const artifactCursor = usageCursor(artifact);
      if (artifact.graphBytes > MAX_ARTIFACT_BYTES) {
        scanned += 1;
        lastCursor = artifactCursor;
        truncated = true;
        break;
      }
      if (encodedBytes + artifact.graphBytes > MAX_USAGE_BYTES) {
        truncated = true;
        break;
      }
      if (artifact.graph === null || Buffer.byteLength(artifact.graph, "utf8") !== artifact.graphBytes) {
        lastCursor = artifactCursor;
        truncated = true;
        break;
      }
      encodedBytes += artifact.graphBytes;
      scanned += 1;
      lastCursor = artifactCursor;
      const scan = scanConnectionReferences(artifact.graph, connectionId);
      if (scan === "malformed" || scan === "limited") {
        truncated = true;
        break;
      }
      if (scan === "match") {
        matchedLowerBound += 1;
        items.push(Object.freeze({
          artifactKind: artifact.artifactKind,
          flowId: artifact.flowId,
          flowName: artifact.flowName,
          flowVersionId: artifact.flowVersionId,
          environment: artifact.environment,
          updatedAt: artifact.sortAt,
        }));
        if (items.length >= matchLimit) {
          if (scanned < artifacts.length) truncated = true;
          break;
        }
      }
    }
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: truncated && lastCursor ? encodeCursor(lastCursor) : null,
      matchedLowerBound,
      truncated,
      lifecycleRevision,
    });
  }
}
