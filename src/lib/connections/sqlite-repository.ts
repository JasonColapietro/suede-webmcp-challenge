import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  canonicalConnectionPublicConfig,
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "./crypto";
import {
  ConnectionRepositoryUnavailableError,
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

interface ConnectionRow {
  id: string;
  owner_id: string;
  crypto_owner_id: string;
  name: string;
  kind: ConnectionKind;
  public_config: string;
  schema_version: 1;
  lifecycle_revision: number;
  created_at: number;
  updated_at: number;
}

interface SlotMetadataRow {
  environment: ConnectionEnvironment;
  status: "configured" | "revoked";
  secret_version: number;
  updated_at: number;
  revoked_at: number | null;
}

interface ProtectedSlotRow extends SlotMetadataRow {
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}

interface ListCursor {
  updatedAt: number;
  id: string;
}

interface UsageCursor {
  artifactKind: "draft" | "active_deployment";
  sortAt: number;
  flowId: string;
  flowVersionId: string | null;
  // Internal Rule 3 correction: the public cursor is opaque, while this discriminator
  // makes same-version, same-timestamp Test and Live artifacts independently resumable.
  environment: "draft" | "test" | "live";
}

interface UsageArtifactRow {
  artifact_kind: "draft" | "active_deployment";
  artifact_order: 0 | 1;
  flow_id: string;
  flow_name: string;
  flow_version_id: string | null;
  environment: "draft" | "test" | "live";
  sort_at: number;
  graph_bytes: number;
}

function pageLimit(page: ConnectionListPage): number {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new TypeError(PAGE_ERROR);
  return page.limit;
}

function mutationTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid connection input");
  return value;
}

function encodeCursor(value: ListCursor | UsageCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
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
    throw new TypeError(PAGE_ERROR);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(PAGE_ERROR);
  }
}

function parseListCursor(cursor: string | undefined): ListCursor | null {
  if (cursor === undefined) return null;
  const value = decodedRecord(cursor);
  exactKeys(value, ["updatedAt", "id"]);
  if (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0 ||
      typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256) throw new TypeError(PAGE_ERROR);
  return { updatedAt: value.updatedAt as number, id: value.id };
}

function parseUsageCursor(cursor: string | undefined): UsageCursor | null {
  if (cursor === undefined) return null;
  const value = decodedRecord(cursor);
  exactKeys(value, ["artifactKind", "sortAt", "flowId", "flowVersionId", "environment"]);
  if ((value.artifactKind !== "draft" && value.artifactKind !== "active_deployment") ||
      !Number.isSafeInteger(value.sortAt) || (value.sortAt as number) < 0 ||
      typeof value.flowId !== "string" || value.flowId.length < 1 ||
      (value.flowVersionId !== null && typeof value.flowVersionId !== "string")) throw new TypeError(PAGE_ERROR);
  if (value.artifactKind === "draft") {
    if (value.flowVersionId !== null || value.environment !== "draft") throw new TypeError(PAGE_ERROR);
  } else if (typeof value.flowVersionId !== "string" || value.flowVersionId.length < 1 ||
      (value.environment !== "test" && value.environment !== "live")) throw new TypeError(PAGE_ERROR);
  return {
    artifactKind: value.artifactKind,
    sortAt: value.sortAt as number,
    flowId: value.flowId,
    flowVersionId: value.flowVersionId as string | null,
    environment: value.environment as UsageCursor["environment"],
  };
}

function slotView(environment: ConnectionEnvironment, row: SlotMetadataRow | undefined) {
  if (!row) return Object.freeze({ environment, status: "missing" as const, secretVersion: 0, updatedAt: null, revokedAt: null });
  return Object.freeze({
    environment,
    status: row.status,
    secretVersion: row.secret_version,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  });
}

function createInputFromRow(row: ConnectionRow): ConnectionCreateInput {
  return parseConnectionCreateInput({
    name: row.name,
    kind: row.kind,
    publicConfig: JSON.parse(row.public_config) as unknown,
  });
}

export interface SqliteConnectionRepositoryOptions {
  /** Provider-created repositories own their handle; injected handles are shared by default. */
  readonly ownsDatabase?: boolean;
  /** Boolean-only disposal observation. Key bytes are never exposed. */
  readonly onKeyWiped?: (zeroed: boolean) => void;
}

export class SqliteConnectionRepository implements CloseableConnectionRepository {
  readonly #db: Database.Database;
  readonly #key: Buffer;
  readonly #ownsDatabase: boolean;
  readonly #onKeyWiped: ((zeroed: boolean) => void) | undefined;
  #terminal = false;
  #databaseClosed = false;

  constructor(
    db: Database.Database,
    encryptionKey: Buffer,
    options: SqliteConnectionRepositoryOptions = {},
  ) {
    this.#db = db;
    this.#key = Buffer.from(encryptionKey);
    this.#ownsDatabase = options.ownsDatabase === true;
    this.#onKeyWiped = options.onKeyWiped;
  }

  #assertOpen(): void {
    if (this.#terminal) throw new ConnectionRepositoryUnavailableError();
  }

  close(): void {
    if (!this.#terminal) {
      this.#terminal = true;
      this.#key.fill(0);
      const zeroed = this.#key.every((byte) => byte === 0);
      try { this.#onKeyWiped?.(zeroed); } catch { /* observation cannot alter disposal */ }
    }
    if (!this.#ownsDatabase || this.#databaseClosed) return;
    try {
      this.#db.close();
      this.#databaseClosed = true;
    } catch {
      throw new ConnectionRepositoryUnavailableError();
    }
  }

  dispose(): void {
    this.close();
  }

  #connection(ownerId: string, connectionId: string): ConnectionRow | undefined {
    return this.#db.prepare(`SELECT id, owner_id, crypto_owner_id, name, kind, public_config, schema_version,
      lifecycle_revision, created_at, updated_at FROM connections WHERE owner_id=? AND id=?`)
      .get(ownerId, connectionId) as ConnectionRow | undefined;
  }

  #view(row: ConnectionRow): ConnectionView {
    const slots = this.#db.prepare(`SELECT environment, status, secret_version, updated_at, revoked_at
      FROM connection_slots WHERE connection_id=? ORDER BY environment`).all(row.id) as SlotMetadataRow[];
    const byEnvironment = new Map(slots.map((slot) => [slot.environment, slot]));
    return parseConnectionView({
      id: row.id,
      name: row.name,
      kind: row.kind,
      publicConfig: JSON.parse(row.public_config) as unknown,
      lifecycleRevision: row.lifecycle_revision,
      slots: Object.freeze({
        test: slotView("test", byEnvironment.get("test")),
        live: slotView("live", byEnvironment.get("live")),
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  async create(ownerId: string, input: ConnectionCreateInput, now: number): Promise<ConnectionView> {
    this.#assertOpen();
    const parsed = parseConnectionCreateInput(input);
    const timestamp = mutationTime(now);
    const canonical = canonicalConnectionPublicConfig(parsed.kind, parsed.publicConfig);
    const id = randomUUID();
    this.#db.transaction(() => {
      this.#db.prepare(`INSERT INTO connections
        (id, owner_id, crypto_owner_id, name, kind, public_config, schema_version, lifecycle_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`)
        .run(id, ownerId, ownerId, parsed.name, parsed.kind, canonical.bytes.toString("utf8"), timestamp, timestamp);
    }).immediate();
    const row = this.#connection(ownerId, id);
    if (!row) throw new Error("Connection persistence failed");
    return this.#view(row);
  }

  async list(ownerId: string, page: ConnectionListPage): Promise<ConnectionListResult> {
    this.#assertOpen();
    const limit = pageLimit(page);
    const cursor = parseListCursor(page.cursor);
    const rows = (cursor
      ? this.#db.prepare(`SELECT id, owner_id, crypto_owner_id, name, kind, public_config, schema_version,
          lifecycle_revision, created_at, updated_at FROM connections
          WHERE owner_id=? AND (updated_at < ? OR (updated_at = ? AND id < ?))
          ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .all(ownerId, cursor.updatedAt, cursor.updatedAt, cursor.id, limit + 1)
      : this.#db.prepare(`SELECT id, owner_id, crypto_owner_id, name, kind, public_config, schema_version,
          lifecycle_revision, created_at, updated_at FROM connections
          WHERE owner_id=? ORDER BY updated_at DESC, id DESC LIMIT ?`).all(ownerId, limit + 1)) as ConnectionRow[];
    const selected = rows.slice(0, limit);
    const items = Object.freeze(selected.map((row) => this.#view(row)));
    const last = selected.at(-1);
    return Object.freeze({
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null,
    });
  }

  async get(ownerId: string, connectionId: string): Promise<ConnectionView | null> {
    this.#assertOpen();
    const row = this.#connection(ownerId, connectionId);
    return row ? this.#view(row) : null;
  }

  async rename(
    ownerId: string,
    connectionId: string,
    expectedLifecycleRevision: number,
    name: string,
    now: number,
  ): Promise<MutationResult> {
    this.#assertOpen();
    return this.#db.transaction((): MutationResult => {
      const current = this.#connection(ownerId, connectionId);
      if (!current) return Object.freeze({ status: "not-found" as const });
      if (current.lifecycle_revision !== expectedLifecycleRevision) return Object.freeze({ status: "conflict" as const });
      const timestamp = mutationTime(now);
      const parsedName = parseConnectionCreateInput({ name, kind: current.kind, publicConfig: JSON.parse(current.public_config) }).name;
      const result = this.#db.prepare(`UPDATE connections SET name=?, updated_at=?, lifecycle_revision=lifecycle_revision+1
        WHERE owner_id=? AND id=? AND lifecycle_revision=?`)
        .run(parsedName, timestamp, ownerId, connectionId, expectedLifecycleRevision);
      if (result.changes !== 1) return Object.freeze({ status: "conflict" as const });
      const updated = this.#connection(ownerId, connectionId);
      if (!updated) throw new Error("Connection persistence failed");
      return Object.freeze({ status: "updated" as const, connection: this.#view(updated) });
    }).immediate();
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
    return this.#db.transaction((): MutationResult => {
      const current = this.#connection(ownerId, connectionId);
      if (!current) return Object.freeze({ status: "not-found" as const });
      if (current.lifecycle_revision !== expectedLifecycleRevision) return Object.freeze({ status: "conflict" as const });
      const timestamp = mutationTime(now);
      const parsedSecret = parseConnectionSecretInput(secret);
      if (parsedSecret.kind !== current.kind) throw new TypeError("Invalid connection input");
      const createInput = createInputFromRow(current);
      normalizeConnectionSecret(createInput, parsedSecret);
      const existing = this.#db.prepare(`SELECT environment, status, secret_version, updated_at, revoked_at
        FROM connection_slots WHERE connection_id=? AND environment=?`).get(connectionId, environment) as SlotMetadataRow | undefined;
      const secretVersion = (existing?.secret_version ?? 0) + 1;
      const canonical = canonicalConnectionPublicConfig(current.kind, createInput.publicConfig);
      const plaintext = Buffer.from(JSON.stringify(parsedSecret), "utf8");
      const envelope = encryptConnectionSecret({
        key: this.#key,
        ownerId: current.crypto_owner_id,
        connectionId,
        kind: current.kind,
        environment,
        schemaVersion: 1,
        secretVersion,
        publicConfigSha256: canonical.sha256,
        plaintext,
      });
      if (existing) {
        this.#db.prepare(`UPDATE connection_slots SET status='configured', secret_version=?, key_version=1,
          nonce=?, ciphertext=?, auth_tag=?, configured_at=?, updated_at=?, revoked_at=NULL
          WHERE connection_id=? AND environment=?`)
          .run(secretVersion, envelope.nonce, envelope.ciphertext, envelope.authTag, timestamp, timestamp, connectionId, environment);
      } else {
        this.#db.prepare(`INSERT INTO connection_slots
          (connection_id, environment, status, secret_version, key_version, nonce, ciphertext, auth_tag,
           configured_at, updated_at, revoked_at) VALUES (?, ?, 'configured', ?, 1, ?, ?, ?, ?, ?, NULL)`)
          .run(connectionId, environment, secretVersion, envelope.nonce, envelope.ciphertext, envelope.authTag, timestamp, timestamp);
      }
      const changed = this.#db.prepare(`UPDATE connections SET updated_at=?, lifecycle_revision=lifecycle_revision+1
        WHERE owner_id=? AND id=? AND lifecycle_revision=?`)
        .run(timestamp, ownerId, connectionId, expectedLifecycleRevision);
      if (changed.changes !== 1) throw new Error("Connection lifecycle conflict");
      const updated = this.#connection(ownerId, connectionId);
      if (!updated) throw new Error("Connection persistence failed");
      return Object.freeze({ status: "updated" as const, connection: this.#view(updated) });
    }).immediate();
  }

  async revokeSlot(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    expectedLifecycleRevision: number,
    now: number,
  ): Promise<MutationResult> {
    this.#assertOpen();
    return this.#db.transaction((): MutationResult => {
      const current = this.#connection(ownerId, connectionId);
      if (!current) return Object.freeze({ status: "not-found" as const });
      if (current.lifecycle_revision !== expectedLifecycleRevision) return Object.freeze({ status: "conflict" as const });
      const timestamp = mutationTime(now);
      const slot = this.#db.prepare(`SELECT status FROM connection_slots
        WHERE connection_id=? AND environment=?`).get(connectionId, environment) as { status: string } | undefined;
      if (slot?.status !== "configured") return Object.freeze({ status: "conflict" as const });
      this.#db.prepare(`UPDATE connection_slots SET status='revoked', key_version=NULL, nonce=NULL,
        ciphertext=NULL, auth_tag=NULL, updated_at=?, revoked_at=?
        WHERE connection_id=? AND environment=? AND status='configured'`)
        .run(timestamp, timestamp, connectionId, environment);
      const changed = this.#db.prepare(`UPDATE connections SET updated_at=?, lifecycle_revision=lifecycle_revision+1
        WHERE owner_id=? AND id=? AND lifecycle_revision=?`)
        .run(timestamp, ownerId, connectionId, expectedLifecycleRevision);
      if (changed.changes !== 1) throw new Error("Connection lifecycle conflict");
      const updated = this.#connection(ownerId, connectionId);
      if (!updated) throw new Error("Connection persistence failed");
      return Object.freeze({ status: "updated" as const, connection: this.#view(updated) });
    }).immediate();
  }

  async resolveHeaders(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    _field: "headers",
  ): Promise<Readonly<Record<string, string>> | null> {
    this.#assertOpen();
    if (_field !== "headers") return null;
    const row = this.#db.prepare(`SELECT c.id, c.owner_id, c.crypto_owner_id, c.name, c.kind, c.public_config,
      c.schema_version, c.lifecycle_revision, c.created_at, c.updated_at,
      s.environment, s.status, s.secret_version, s.key_version, s.nonce, s.ciphertext, s.auth_tag,
      s.updated_at AS slot_updated_at, s.revoked_at
      FROM connections c JOIN connection_slots s ON s.connection_id=c.id
      WHERE c.owner_id=? AND c.id=? AND s.environment=? AND s.status='configured'`)
      .get(ownerId, connectionId, environment) as (ConnectionRow & ProtectedSlotRow) | undefined;
    if (!row) return null;
    const createInput = createInputFromRow(row);
    const canonical = canonicalConnectionPublicConfig(row.kind, createInput.publicConfig);
    let plaintext: Buffer | null = null;
    try {
      plaintext = decryptConnectionSecret({
        key: this.#key,
        ownerId: row.crypto_owner_id,
        connectionId,
        kind: row.kind,
        environment,
        schemaVersion: 1,
        secretVersion: row.secret_version,
        publicConfigSha256: canonical.sha256,
        envelope: {
          keyVersion: row.key_version as 1,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
        },
      });
      const parsed = parseConnectionSecretInput(JSON.parse(plaintext.toString("utf8")) as unknown);
      return normalizeConnectionSecret(createInput, parsed);
    } catch {
      throw new Error("Connection secret unavailable");
    } finally {
      plaintext?.fill(0);
    }
  }

  async usage(
    ownerId: string,
    connectionId: string,
    page: ConnectionListPage,
  ): Promise<ConnectionUsageResult | null> {
    this.#assertOpen();
    const matchLimit = Math.min(pageLimit(page), MAX_USAGE_MATCHES);
    const cursor = parseUsageCursor(page.cursor);
    return this.#db.transaction((): ConnectionUsageResult | null => {
      const connection = this.#connection(ownerId, connectionId);
      if (!connection) return null;
      const cursorOrder = cursor?.artifactKind === "active_deployment" ? 1 : 0;
      const artifacts = this.#db.prepare(`WITH active_refs AS (
        SELECT d.flow_id, d.flow_version_id, e.kind environment, MAX(d.created_at) sort_at
        FROM deployments d
        JOIN flows f ON f.id=d.flow_id AND f.owner_id=@ownerId
        JOIN flow_versions fv ON fv.id=d.flow_version_id AND fv.flow_id=d.flow_id
        JOIN environments e ON e.id=d.environment_id AND e.kind IN ('test','live')
        WHERE d.retired_at IS NULL AND d.status=e.kind
        GROUP BY d.flow_id, d.flow_version_id, e.kind
      ), artifacts AS (
        SELECT 'draft' artifact_kind, 0 artifact_order, f.id flow_id, f.name flow_name,
          NULL flow_version_id, 'draft' environment, f.updated_at sort_at,
          length(CAST(f.graph AS BLOB)) graph_bytes
        FROM flows f WHERE f.owner_id=@ownerId
        UNION ALL
        SELECT 'active_deployment' artifact_kind, 1 artifact_order, f.id flow_id, f.name flow_name,
          fv.id flow_version_id, active.environment, active.sort_at,
          length(CAST(fv.graph AS BLOB)) graph_bytes
        FROM active_refs active
        JOIN flows f ON f.id=active.flow_id AND f.owner_id=@ownerId
        JOIN flow_versions fv ON fv.id=active.flow_version_id AND fv.flow_id=active.flow_id
      )
      SELECT * FROM artifacts
      WHERE @hasCursor=0 OR artifact_order > @cursorOrder OR (
        artifact_order=@cursorOrder AND (
          sort_at < @sortAt OR (sort_at=@sortAt AND (
            flow_id > @flowId OR (flow_id=@flowId AND (
              COALESCE(flow_version_id,'') > @flowVersionId OR
              (COALESCE(flow_version_id,'')=@flowVersionId AND environment > @environment)
            ))
          ))
        )
      )
      ORDER BY artifact_order, sort_at DESC, flow_id, COALESCE(flow_version_id,''), environment
      LIMIT 501`).all({
        ownerId,
        hasCursor: cursor ? 1 : 0,
        cursorOrder,
        sortAt: cursor?.sortAt ?? 0,
        flowId: cursor?.flowId ?? "",
        flowVersionId: cursor?.flowVersionId ?? "",
        environment: cursor?.environment ?? "",
      }) as UsageArtifactRow[];

      const items: ConnectionUsageItem[] = [];
      let scanned = 0;
      let encodedBytes = 0;
      let matchedLowerBound = 0;
      let truncated = false;
      let lastCursor: UsageCursor | null = null;

      for (const artifact of artifacts) {
        if (scanned >= MAX_USAGE_ARTIFACTS) {
          truncated = true;
          break;
        }
        const artifactCursor: UsageCursor = {
          artifactKind: artifact.artifact_kind,
          sortAt: artifact.sort_at,
          flowId: artifact.flow_id,
          flowVersionId: artifact.flow_version_id,
          environment: artifact.environment,
        };
        if (artifact.graph_bytes > MAX_ARTIFACT_BYTES) {
          scanned += 1;
          lastCursor = artifactCursor;
          truncated = true;
          break;
        }
        if (encodedBytes + artifact.graph_bytes > MAX_USAGE_BYTES) {
          truncated = true;
          break;
        }
        const graphRow = artifact.artifact_kind === "draft"
          ? this.#db.prepare("SELECT graph FROM flows WHERE owner_id=? AND id=?").get(ownerId, artifact.flow_id) as { graph: string } | undefined
          : this.#db.prepare(`SELECT fv.graph FROM deployments d
              JOIN flows f ON f.id=d.flow_id AND f.owner_id=?
              JOIN flow_versions fv ON fv.id=d.flow_version_id AND fv.flow_id=d.flow_id
              JOIN environments e ON e.id=d.environment_id AND e.kind=?
              WHERE d.retired_at IS NULL AND d.status=e.kind AND d.flow_id=? AND fv.id=? LIMIT 1`)
            .get(ownerId, artifact.environment, artifact.flow_id, artifact.flow_version_id) as { graph: string } | undefined;
        if (!graphRow || Buffer.byteLength(graphRow.graph, "utf8") !== artifact.graph_bytes) {
          lastCursor = artifactCursor;
          truncated = true;
          break;
        }
        encodedBytes += artifact.graph_bytes;
        scanned += 1;
        lastCursor = artifactCursor;
        const scan = scanConnectionReferences(graphRow.graph, connectionId);
        if (scan === "malformed" || scan === "limited") {
          truncated = true;
          break;
        }
        if (scan === "match") {
          matchedLowerBound += 1;
          items.push(Object.freeze({
            artifactKind: artifact.artifact_kind,
            flowId: artifact.flow_id,
            flowName: artifact.flow_name,
            flowVersionId: artifact.flow_version_id,
            environment: artifact.environment,
            updatedAt: artifact.sort_at,
          }));
          if (items.length >= matchLimit) {
            if (scanned < artifacts.length) truncated = true;
            break;
          }
        }
      }
      if (artifacts.length > MAX_USAGE_ARTIFACTS && scanned >= MAX_USAGE_ARTIFACTS) truncated = true;
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: truncated && lastCursor ? encodeCursor(lastCursor) : null,
        matchedLowerBound,
        truncated,
        lifecycleRevision: connection.lifecycle_revision,
      });
    }).immediate();
  }
}
