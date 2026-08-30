import Database from "better-sqlite3";
import type { ControlAuditEventInput } from "@/lib/audit/repository";
import { SqliteAuditRepository } from "@/lib/audit/sqlite-repository";
import type { ControlAuditEvent } from "@/lib/audit/types";
import {
  canonicalConnectorProjectionBytes,
  canonicalOperationProjectionBytes,
  connectorProjectionHash,
  operationProjectionHash,
  parseConnectorDefinitionProjectionV1,
  parseConnectorDefinitionVersionV1,
  parseOperationProjectionV1,
  parseOperationVersionV1,
  parseUnverifiedAuthorAnnotationV1,
  schemaHash,
} from "./schema";
import { CONNECTOR_IMPORT_V1_LIMITS } from "./limits";
import type {
  CloseableConnectorRepository,
  ConnectorDriftReceipt,
  ConnectorDefinitionHistoryOptions,
  ConnectorDefinitionHistoryPage,
  ConnectorIdentityMutationResult,
  ConnectorIdentityPage,
  ConnectorIdentityView,
  ConnectorListOptions,
  ConnectorOperationClosure,
  ConnectorRepositoryTransaction,
  DefinitionDisposition,
  ImportRateReservationInput,
  MaterializeStoredOperationInput,
  MaterializeStoredOperationResult,
  OperationVersionListOptions,
  OperationVersionPage,
  OperationVersionSummary,
  PersistCompiledImportInput,
  PersistCompiledImportResult,
  PersistCompiledDefinitionInput,
  PersistCompiledDefinitionResult,
} from "./repository";
import type { ConnectorDefinitionVersionV1, OperationVersionV1, UnverifiedAuthorAnnotationV1 } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

interface SqliteConnectorRepositoryOptions {
  readonly ownsDatabase?: boolean;
}

interface IdentityRow {
  id: string;
  display_label: string;
  archived_at: number | null;
  lifecycle_revision: number;
  created_at: number;
  updated_at: number;
}

interface DefinitionMetadataRow {
  id: string;
  connector_id: string;
  version_number: number;
  connector_projection_hash: string;
}

interface OperationMetadataRow {
  id: string;
  connector_definition_version_id: string;
  operation_id: string;
  operation_projection_hash: string;
  schema_hash: string;
}

interface OperationListRow {
  operation_version_id: string;
  connector_definition_version_id: string;
  definition_version_number: number;
  operation_id: string;
  connector_projection_hash: string;
  operation_projection_hash: string;
  schema_hash: string;
  author_annotation_json: string | null;
  created_at: number;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 512 || CONTROL.test(value)) {
    throw new TypeError("Invalid connector identity");
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError("Invalid connector identity");
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid connector timestamp");
  return value as number;
}

function label(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || CONTROL.test(value) ||
      Buffer.byteLength(value, "utf8") > 120) throw new TypeError("Invalid connector label");
  return value;
}

function pageLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new TypeError("Invalid connector page");
  }
  return value as number;
}

function viewIdentity(row: IdentityRow): ConnectorIdentityView {
  return Object.freeze({
    id: row.id,
    displayLabel: row.display_label,
    archivedAt: row.archived_at,
    lifecycleRevision: row.lifecycle_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function annotationJson(annotation: UnverifiedAuthorAnnotationV1 | undefined, operation: {
  id: string;
  definitionId: string;
  operationId: string;
  projection: unknown;
  operationHash: string;
  schemaDigest: string;
}): string | null {
  const parsed = parseOperationVersionV1({
    contractVersion: 1,
    id: operation.id,
    connectorDefinitionVersionId: operation.definitionId,
    operationId: operation.operationId,
    projection: operation.projection,
    operationProjectionHash: operation.operationHash,
    schemaHash: operation.schemaDigest,
    executionAvailability: "simulation_only",
    ...(annotation === undefined ? {} : { authorAnnotation: annotation }),
  });
  return parsed.authorAnnotation === undefined ? null : JSON.stringify(parsed.authorAnnotation);
}

function isThenable(value: unknown): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function";
}

export class SqliteConnectorRepository implements CloseableConnectorRepository {
  readonly #db: Database.Database;
  readonly #audit: SqliteAuditRepository;
  readonly #ownsDatabase: boolean;
  #closed = false;

  constructor(db: Database.Database, options: SqliteConnectorRepositoryOptions = {}) {
    this.#db = db;
    this.#audit = new SqliteAuditRepository(db);
    this.#ownsDatabase = options.ownsDatabase ?? false;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Connector repository is closed");
  }

  immediate<T>(work: (transaction: ConnectorRepositoryTransaction) => T): T {
    this.#assertOpen();
    if (typeof work !== "function") throw new TypeError("Invalid connector transaction");
    let active = true;
    const assertActive = (): void => {
      if (!active) throw new Error("Connector transaction is no longer active");
    };
    const transaction: ConnectorRepositoryTransaction = Object.freeze({
      getOperationClosure: (ownerId: string, operationVersionId: string): ConnectorOperationClosure | null => {
        assertActive();
        return this.getOperationClosure(ownerId, operationVersionId);
      },
      findActiveDefinitionForOperation: (
        ownerIdValue: string,
        connectorProjectionHashValue: string,
        operationIdValue: string,
        authorAnnotation: UnverifiedAuthorAnnotationV1 | undefined,
      ): ConnectorDefinitionVersionV1 | null => {
        assertActive();
        const ownerId = identity(ownerIdValue);
        const operationId = identity(operationIdValue);
        if (!SHA256.test(connectorProjectionHashValue)) throw new TypeError("Invalid connector contract");
        const annotation = authorAnnotation === undefined ? null : JSON.stringify(authorAnnotation);
        const row = this.#db.prepare(`SELECT definition.id
          FROM connector_definition_versions definition
          JOIN connector_identities identity
            ON identity.owner_id = definition.owner_id
           AND identity.id = definition.connector_id
           AND identity.archived_at IS NULL
          LEFT JOIN connector_operation_versions operation
            ON operation.owner_id = definition.owner_id
           AND operation.connector_definition_version_id = definition.id
           AND operation.operation_id = ?
          WHERE definition.owner_id = ? AND definition.connector_projection_hash = ?
            AND (operation.id IS NULL OR operation.author_annotation_json IS ?)
          ORDER BY CASE WHEN operation.id IS NULL THEN 1 ELSE 0 END,
                   definition.connector_id, definition.id
          LIMIT 1`).get(operationId, ownerId, connectorProjectionHashValue, annotation) as { id: string } | undefined;
        return row ? this.getDefinitionVersion(ownerId, row.id) : null;
      },
      reserveImport: (input: ImportRateReservationInput): boolean => {
        assertActive();
        return this.#reserveImport(input);
      },
      persistCompiledDefinition: (input: PersistCompiledDefinitionInput): PersistCompiledDefinitionResult => {
        assertActive();
        return this.#persistCompiledDefinition(input);
      },
      persistCompiledImport: (input: PersistCompiledImportInput): PersistCompiledImportResult => {
        assertActive();
        return this.#persistCompiledImport(input);
      },
      materializeStoredOperation: (input: MaterializeStoredOperationInput): MaterializeStoredOperationResult => {
        assertActive();
        return this.#materializeStoredOperation(input);
      },
      appendAudit: (input: ControlAuditEventInput): ControlAuditEvent => {
        assertActive();
        return this.#audit.append(input);
      },
    });
    return this.#db.transaction((): T => {
      let result: T;
      try {
        result = work(transaction);
      } finally {
        active = false;
      }
      if (isThenable(result)) throw new TypeError("Connector transaction callbacks must be synchronous");
      return result;
    }).immediate();
  }

  #reserveImport(input: ImportRateReservationInput): boolean {
    const ownerId = identity(input.ownerId);
    const now = timestamp(input.now);
    const count = this.#db.prepare(`SELECT count(*) count FROM connector_import_rate_reservations
      WHERE owner_id = ? AND reserved_at > ?`).get(ownerId, Math.max(0, now - 60_000)) as { count: number };
    if (count.count >= CONNECTOR_IMPORT_V1_LIMITS.maxImportsPerOwnerPerMinute) return false;
    this.#db.prepare(`INSERT INTO connector_import_rate_reservations
      (id, owner_id, correlation_id, reserved_at) VALUES (?, ?, ?, ?)`)
      .run(uuid(input.id), ownerId, uuid(input.correlationId), now);
    return true;
  }

  #identity(ownerId: string, connectorId: string): ConnectorIdentityView | null {
    const row = this.#db.prepare(`SELECT id, display_label, archived_at, lifecycle_revision, created_at, updated_at
      FROM connector_identities WHERE owner_id = ? AND id = ?`).get(ownerId, connectorId) as IdentityRow | undefined;
    return row ? viewIdentity(row) : null;
  }

  getConnectorIdentity(ownerIdValue: string, connectorIdValue: string): ConnectorIdentityView | null {
    this.#assertOpen();
    return this.#identity(identity(ownerIdValue), uuid(connectorIdValue));
  }

  listConnectorIdentities(ownerIdValue: string, options: ConnectorListOptions): ConnectorIdentityPage {
    this.#assertOpen();
    const ownerId = identity(ownerIdValue);
    const limit = pageLimit(options.limit);
    const search = options.search === undefined ? null : label(options.search);
    const afterUpdatedAt = options.after === undefined ? null : timestamp(options.after.updatedAt);
    const afterId = options.after === undefined ? null : uuid(options.after.id);
    const rows = this.#db.prepare(`SELECT id, display_label, archived_at, lifecycle_revision, created_at, updated_at
      FROM connector_identities
      WHERE owner_id = ?
        AND (? = 1 OR archived_at IS NULL)
        AND (? IS NULL OR instr(lower(display_label), lower(?)) > 0)
        AND (? IS NULL OR updated_at < ? OR updated_at = ? AND id < ?)
      ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(
        ownerId,
        options.includeArchived === true ? 1 : 0,
        search,
        search,
        afterUpdatedAt,
        afterUpdatedAt,
        afterUpdatedAt,
        afterId,
        limit + 1,
      ) as IdentityRow[];
    const pageRows = rows.slice(0, limit);
    const items = Object.freeze(pageRows.map(viewIdentity));
    const last = rows.length > limit ? pageRows.at(-1) : undefined;
    return Object.freeze({
      items,
      nextCursor: last ? Object.freeze({ updatedAt: last.updated_at, id: last.id }) : null,
    });
  }

  #validatedInput(input: PersistCompiledImportInput): {
    ownerId: string;
    now: number;
    projectionJson: string;
    operationJson: string;
    annotation: string | null;
  } {
    const ownerId = identity(input.ownerId);
    const now = timestamp(input.now);
    uuid(input.newConnectorId);
    uuid(input.definitionVersionId);
    uuid(input.operationVersionId);
    if (input.connectorId !== null) uuid(input.connectorId);
    label(input.displayLabel);
    const connectorProjection = parseConnectorDefinitionProjectionV1(input.connectorProjection);
    if (connectorProjectionHash(connectorProjection) !== input.connectorProjectionHash) {
      throw new TypeError("Invalid connector contract");
    }
    const operationProjection = parseOperationProjectionV1(input.operation.projection);
    const operationHash = operationProjectionHash(operationProjection);
    const schemaDigest = schemaHash(operationProjection.requestSchema, operationProjection.resultSchema);
    if (input.operation.operationId !== operationProjection.operationId ||
        input.operation.operationProjectionHash !== operationHash || input.operation.schemaHash !== schemaDigest) {
      throw new TypeError("Invalid connector contract");
    }
    const parentEntry = connectorProjection.operations.find((entry) => entry.operationId === input.operation.operationId);
    if (!parentEntry || parentEntry.operationProjectionHash !== operationHash ||
        canonicalOperationProjectionBytes(parentEntry.operationProjection).compare(
          canonicalOperationProjectionBytes(operationProjection),
        ) !== 0) throw new TypeError("Invalid connector contract");
    return {
      ownerId,
      now,
      projectionJson: canonicalConnectorProjectionBytes(connectorProjection).toString("utf8"),
      operationJson: canonicalOperationProjectionBytes(operationProjection).toString("utf8"),
      annotation: annotationJson(input.authorAnnotation, {
        id: input.operationVersionId,
        definitionId: input.definitionVersionId,
        operationId: input.operation.operationId,
        projection: operationProjection,
        operationHash,
        schemaDigest,
      }),
    };
  }

  #persistCompiledImport(input: PersistCompiledImportInput): PersistCompiledImportResult {
    const valid = this.#validatedInput(input);
    const persisted = this.#persistCompiledDefinition(input);
    if (persisted.status !== "ok") return persisted;
    const definition = persisted.definition;
    const materialized = this.#materializeOperation({
      ownerId: valid.ownerId,
      definition,
      operationId: input.operation.operationId,
      operationVersionId: input.operationVersionId,
      authorAnnotation: input.authorAnnotation,
      now: valid.now,
    });
    if (materialized.status !== "ok") return materialized;
    return Object.freeze({
      ...persisted,
      operation: materialized.operation,
      operationDisposition: materialized.disposition,
    });
  }

  #persistCompiledDefinition(input: PersistCompiledDefinitionInput): PersistCompiledDefinitionResult {
    const ownerId = identity(input.ownerId);
    const now = timestamp(input.now);
    uuid(input.newConnectorId);
    uuid(input.definitionVersionId);
    if (input.connectorId !== null) uuid(input.connectorId);
    label(input.displayLabel);
    const projection = parseConnectorDefinitionProjectionV1(input.connectorProjection);
    if (connectorProjectionHash(projection) !== input.connectorProjectionHash) throw new TypeError("Invalid connector contract");
    const projectionJson = canonicalConnectorProjectionBytes(projection).toString("utf8");
    let identityView: ConnectorIdentityView;
    let definition: ConnectorDefinitionVersionV1;
    const identityDisposition = input.connectorId === null ? "created" as const : "reused" as const;
    let definitionDisposition: DefinitionDisposition;
    let drift: ConnectorDriftReceipt | null = null;
    const connectorId = input.connectorId ?? input.newConnectorId;
    if (input.connectorId === null) {
      this.#db.prepare(`INSERT INTO connector_identities
        (id, owner_id, display_label, archived_at, lifecycle_revision, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 1, ?, ?)`).run(connectorId, ownerId, input.displayLabel, now, now);
      identityView = this.#identity(ownerId, connectorId)!;
      this.#db.prepare(`INSERT INTO connector_definition_versions
        (id, owner_id, connector_id, version_number, projection_json, connector_projection_hash, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run(input.definitionVersionId, ownerId, connectorId, projectionJson, input.connectorProjectionHash, now);
      definition = this.getDefinitionVersion(ownerId, input.definitionVersionId)!;
      definitionDisposition = "created";
    } else {
      const existingIdentity = this.#identity(ownerId, connectorId);
      if (!existingIdentity) return Object.freeze({ status: "not-found" });
      identityView = existingIdentity;
      const latest = this.#db.prepare(`SELECT id, version_number, connector_projection_hash FROM connector_definition_versions
        WHERE owner_id = ? AND connector_id = ? ORDER BY version_number DESC LIMIT 1`)
        .get(ownerId, connectorId) as {
          id: string;
          version_number: number;
          connector_projection_hash: string;
        } | undefined;
      const exact = this.#db.prepare(`SELECT id, version_number FROM connector_definition_versions
        WHERE owner_id = ? AND connector_id = ? AND connector_projection_hash = ?`)
        .get(ownerId, connectorId, input.connectorProjectionHash) as { id: string; version_number: number } | undefined;
      if (exact) {
        definition = this.getDefinitionVersion(ownerId, exact.id)!;
        definitionDisposition = latest?.id === exact.id ? "reused-current" : "reused-historical";
      } else {
        const versionNumber = (latest?.version_number ?? 0) + 1;
        this.#db.prepare(`INSERT INTO connector_definition_versions
          (id, owner_id, connector_id, version_number, projection_json, connector_projection_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(input.definitionVersionId, ownerId, connectorId, versionNumber, projectionJson,
            input.connectorProjectionHash, now);
        definition = this.getDefinitionVersion(ownerId, input.definitionVersionId)!;
        definitionDisposition = "version-created";
        drift = latest ? Object.freeze({
          before: Object.freeze({
            versionId: latest.id,
            versionNumber: latest.version_number,
            connectorProjectionHash: latest.connector_projection_hash,
          }),
          after: Object.freeze({
            versionId: definition.id,
            versionNumber: definition.versionNumber,
            connectorProjectionHash: definition.connectorProjectionHash,
          }),
        }) : null;
      }
    }
    return Object.freeze({
      status: "ok",
      identity: identityView,
      definition,
      identityDisposition,
      definitionDisposition,
      drift,
    });
  }

  #materializeOperation(input: {
    ownerId: string;
    definition: ConnectorDefinitionVersionV1;
    operationId: string;
    operationVersionId: string;
    authorAnnotation?: UnverifiedAuthorAnnotationV1;
    now: number;
  }): MaterializeStoredOperationResult {
    const entry = input.definition.projection.operations.find((candidate) => candidate.operationId === input.operationId);
    if (!entry) return Object.freeze({ status: "not-found" });
    const operationHash = operationProjectionHash(entry.operationProjection);
    const schemaDigest = schemaHash(entry.operationProjection.requestSchema, entry.operationProjection.resultSchema);
    if (operationHash !== entry.operationProjectionHash) throw new TypeError("Invalid connector contract");
    const storedAnnotation = annotationJson(input.authorAnnotation, {
      id: input.operationVersionId,
      definitionId: input.definition.id,
      operationId: input.operationId,
      projection: entry.operationProjection,
      operationHash,
      schemaDigest,
    });
    const existing = this.#db.prepare(`SELECT id, author_annotation_json FROM connector_operation_versions
      WHERE owner_id = ? AND connector_definition_version_id = ? AND operation_id = ?`)
      .get(input.ownerId, input.definition.id, input.operationId) as { id: string; author_annotation_json: string | null } | undefined;
    if (existing) {
      if (existing.author_annotation_json !== storedAnnotation) return Object.freeze({ status: "annotation-conflict" });
      return Object.freeze({ status: "ok", operation: this.getOperationVersion(input.ownerId, existing.id)!, disposition: "reused" });
    }
    this.#db.prepare(`INSERT INTO connector_operation_versions
      (id, owner_id, connector_definition_version_id, operation_id, projection_json,
       operation_projection_hash, schema_hash, author_annotation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.operationVersionId, input.ownerId, input.definition.id, input.operationId,
        canonicalOperationProjectionBytes(entry.operationProjection).toString("utf8"), operationHash, schemaDigest,
        storedAnnotation, input.now);
    return Object.freeze({
      status: "ok",
      operation: this.getOperationVersion(input.ownerId, input.operationVersionId)!,
      disposition: "created",
    });
  }

  #materializeStoredOperation(input: MaterializeStoredOperationInput): MaterializeStoredOperationResult {
    const ownerId = identity(input.ownerId);
    uuid(input.connectorDefinitionVersionId);
    uuid(input.operationVersionId);
    const definition = this.getDefinitionVersion(ownerId, input.connectorDefinitionVersionId);
    if (!definition) return Object.freeze({ status: "not-found" });
    return this.#materializeOperation({
      ownerId,
      definition,
      operationId: identity(input.operationId),
      operationVersionId: input.operationVersionId,
      authorAnnotation: input.authorAnnotation,
      now: timestamp(input.now),
    });
  }

  getDefinitionVersion(ownerIdValue: string, definitionVersionIdValue: string): ConnectorDefinitionVersionV1 | null {
    this.#assertOpen();
    const ownerId = identity(ownerIdValue);
    const definitionVersionId = uuid(definitionVersionIdValue);
    const metadata = this.#db.prepare(`SELECT id, connector_id, version_number, connector_projection_hash
      FROM connector_definition_versions WHERE owner_id = ? AND id = ?`)
      .get(ownerId, definitionVersionId) as DefinitionMetadataRow | undefined;
    if (!metadata) return null;
    const payload = this.#db.prepare(`SELECT projection_json FROM connector_definition_versions
      WHERE owner_id = ? AND id = ?`).get(ownerId, definitionVersionId) as { projection_json: string } | undefined;
    if (!payload) return null;
    let projection: unknown;
    try { projection = JSON.parse(payload.projection_json) as unknown; } catch { throw new TypeError("Invalid connector contract"); }
    return parseConnectorDefinitionVersionV1({
      contractVersion: 1,
      id: metadata.id,
      connectorId: metadata.connector_id,
      versionNumber: metadata.version_number,
      projection,
      connectorProjectionHash: metadata.connector_projection_hash,
      executionAvailability: "simulation_only",
    });
  }

  getOperationVersion(ownerIdValue: string, operationVersionIdValue: string): OperationVersionV1 | null {
    this.#assertOpen();
    const ownerId = identity(ownerIdValue);
    const operationVersionId = uuid(operationVersionIdValue);
    const metadata = this.#db.prepare(`SELECT id, connector_definition_version_id, operation_id,
      operation_projection_hash, schema_hash FROM connector_operation_versions WHERE owner_id = ? AND id = ?`)
      .get(ownerId, operationVersionId) as OperationMetadataRow | undefined;
    if (!metadata) return null;
    const payload = this.#db.prepare(`SELECT projection_json, author_annotation_json FROM connector_operation_versions
      WHERE owner_id = ? AND id = ?`).get(ownerId, operationVersionId) as {
        projection_json: string;
        author_annotation_json: string | null;
      } | undefined;
    if (!payload) return null;
    let projection: unknown;
    let authorAnnotation: unknown;
    try {
      projection = JSON.parse(payload.projection_json) as unknown;
      authorAnnotation = payload.author_annotation_json === null ? undefined : JSON.parse(payload.author_annotation_json) as unknown;
    } catch { throw new TypeError("Invalid connector contract"); }
    const operation = parseOperationVersionV1({
      contractVersion: 1,
      id: metadata.id,
      connectorDefinitionVersionId: metadata.connector_definition_version_id,
      operationId: metadata.operation_id,
      projection,
      operationProjectionHash: metadata.operation_projection_hash,
      schemaHash: metadata.schema_hash,
      executionAvailability: "simulation_only",
      ...(authorAnnotation === undefined ? {} : { authorAnnotation }),
    });
    const definition = this.getDefinitionVersion(ownerId, operation.connectorDefinitionVersionId);
    const parentEntry = definition?.projection.operations.find((entry) => entry.operationId === operation.operationId);
    if (!parentEntry || parentEntry.operationProjectionHash !== operation.operationProjectionHash ||
        canonicalOperationProjectionBytes(parentEntry.operationProjection).compare(
          canonicalOperationProjectionBytes(operation.projection),
        ) !== 0) throw new TypeError("Invalid connector contract");
    return operation;
  }

  getOperationClosure(ownerId: string, operationVersionId: string): ConnectorOperationClosure | null {
    this.#assertOpen();
    return this.#db.transaction(() => {
      const operation = this.getOperationVersion(ownerId, operationVersionId);
      if (!operation) return null;
      const definition = this.getDefinitionVersion(ownerId, operation.connectorDefinitionVersionId);
      if (!definition) return null;
      const connectorIdentity = this.getConnectorIdentity(ownerId, definition.connectorId);
      return connectorIdentity ? Object.freeze({ identity: connectorIdentity, definition, operation }) : null;
    })();
  }

  listOperationVersions(
    ownerIdValue: string,
    connectorIdValue: string,
    options: OperationVersionListOptions,
  ): OperationVersionPage {
    this.#assertOpen();
    const ownerId = identity(ownerIdValue);
    const connectorId = uuid(connectorIdValue);
    const limit = pageLimit(options.limit);
    const afterCreatedAt = options.after === undefined ? null : options.after.createdAt;
    if (afterCreatedAt !== null && (!Number.isSafeInteger(afterCreatedAt) || afterCreatedAt < 0)) {
      throw new TypeError("Invalid connector page");
    }
    const afterId = options.after === undefined ? null : uuid(options.after.id);
    const select = `SELECT
        listing.operation_version_id,
        operation.connector_definition_version_id,
        definition.version_number AS definition_version_number,
        operation.operation_id,
        definition.connector_projection_hash,
        operation.operation_projection_hash,
        operation.schema_hash,
        operation.author_annotation_json,
        listing.created_at
      FROM connector_operation_list_entries listing
      JOIN connector_operation_versions operation
        ON operation.owner_id = listing.owner_id
       AND operation.id = listing.operation_version_id
      JOIN connector_definition_versions definition
        ON definition.owner_id = listing.owner_id
       AND definition.connector_id = listing.connector_id
       AND definition.id = operation.connector_definition_version_id
      WHERE listing.owner_id = ? AND listing.connector_id = ?`;
    const rows = (options.after === undefined
      ? this.#db.prepare(`${select}
          ORDER BY listing.created_at DESC, listing.operation_version_id DESC
          LIMIT ?`).all(ownerId, connectorId, limit + 1)
      : this.#db.prepare(`${select}
          AND (listing.created_at, listing.operation_version_id) < (?, ?)
          ORDER BY listing.created_at DESC, listing.operation_version_id DESC
          LIMIT ?`).all(ownerId, connectorId, afterCreatedAt, afterId, limit + 1)) as OperationListRow[];
    const pageRows = rows.slice(0, limit);
    const items = Object.freeze(pageRows.map((row): OperationVersionSummary => {
      let authorAnnotation: UnverifiedAuthorAnnotationV1 | undefined;
      if (row.author_annotation_json !== null) {
        let raw: unknown;
        try { raw = JSON.parse(row.author_annotation_json) as unknown; } catch { throw new TypeError("Invalid connector contract"); }
        authorAnnotation = parseUnverifiedAuthorAnnotationV1(raw);
      }
      if (!SHA256.test(row.connector_projection_hash) || !SHA256.test(row.operation_projection_hash) ||
          !SHA256.test(row.schema_hash) || !Number.isSafeInteger(row.definition_version_number) ||
          row.definition_version_number < 1) throw new TypeError("Invalid connector contract");
      return Object.freeze({
        operationVersionId: uuid(row.operation_version_id),
        connectorDefinitionVersionId: uuid(row.connector_definition_version_id),
        definitionVersionNumber: row.definition_version_number,
        operationId: identity(row.operation_id),
        connectorProjectionHash: row.connector_projection_hash,
        operationProjectionHash: row.operation_projection_hash,
        schemaHash: row.schema_hash,
        executionAvailability: "simulation_only",
        ...(authorAnnotation === undefined ? {} : { authorAnnotation }),
      });
    }));
    const last = rows.length > limit ? pageRows.at(-1) : undefined;
    return Object.freeze({
      items,
      nextCursor: last
        ? Object.freeze({ createdAt: timestamp(last.created_at), id: uuid(last.operation_version_id) })
        : null,
    });
  }

  listDefinitionHistory(ownerIdValue: string, connectorIdValue: string): readonly ConnectorDefinitionVersionV1[] {
    return this.listDefinitionHistoryPage(ownerIdValue, connectorIdValue, { limit: 100 }).items;
  }

  listDefinitionHistoryPage(
    ownerIdValue: string,
    connectorIdValue: string,
    options: ConnectorDefinitionHistoryOptions,
  ): ConnectorDefinitionHistoryPage {
    this.#assertOpen();
    const ownerId = identity(ownerIdValue);
    const connectorId = uuid(connectorIdValue);
    const limit = pageLimit(options.limit);
    const before = options.beforeVersionNumber === undefined ? null : options.beforeVersionNumber;
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new TypeError("Invalid connector page");
    if (!this.#identity(ownerId, connectorId)) {
      return Object.freeze({ items: Object.freeze([]), nextBeforeVersionNumber: null });
    }
    const rows = this.#db.prepare(`SELECT id, version_number FROM connector_definition_versions
      WHERE owner_id = ? AND connector_id = ? AND (? IS NULL OR version_number < ?)
      ORDER BY version_number DESC LIMIT ?`)
      .all(ownerId, connectorId, before, before, limit + 1) as Array<{ id: string; version_number: number }>;
    const pageRows = rows.slice(0, limit);
    const items = Object.freeze(pageRows.map((row) => this.getDefinitionVersion(ownerId, row.id)!));
    return Object.freeze({
      items,
      nextBeforeVersionNumber: rows.length > limit ? pageRows.at(-1)!.version_number : null,
    });
  }

  rename(ownerIdValue: string, connectorIdValue: string, expectedRevision: number, labelValue: string, nowValue: number): ConnectorIdentityMutationResult {
    return this.#mutateIdentity(ownerIdValue, connectorIdValue, expectedRevision, label(labelValue), undefined, nowValue);
  }

  archive(ownerIdValue: string, connectorIdValue: string, expectedRevision: number, nowValue: number): ConnectorIdentityMutationResult {
    const now = timestamp(nowValue);
    return this.#mutateIdentity(ownerIdValue, connectorIdValue, expectedRevision, undefined, now, now);
  }

  #mutateIdentity(
    ownerIdValue: string,
    connectorIdValue: string,
    expectedRevision: number,
    newLabel: string | undefined,
    archivedAt: number | undefined,
    nowValue: number,
  ): ConnectorIdentityMutationResult {
    const ownerId = identity(ownerIdValue);
    const connectorId = uuid(connectorIdValue);
    const now = timestamp(nowValue);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TypeError("Invalid connector revision");
    return this.#db.transaction((): ConnectorIdentityMutationResult => {
      const current = this.#identity(ownerId, connectorId);
      if (!current) return Object.freeze({ status: "not-found" });
      if (current.lifecycleRevision !== expectedRevision) return Object.freeze({ status: "conflict" });
      const result = this.#db.prepare(`UPDATE connector_identities SET
        display_label = ?, archived_at = ?, lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE owner_id = ? AND id = ? AND lifecycle_revision = ?`)
        .run(newLabel ?? current.displayLabel, archivedAt ?? current.archivedAt, now, ownerId, connectorId, expectedRevision);
      if (result.changes !== 1) return Object.freeze({ status: "conflict" });
      return Object.freeze({ status: "updated", identity: this.#identity(ownerId, connectorId)! });
    }).immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsDatabase) this.#db.close();
  }

  dispose(): void { this.close(); }
}

/** Same-handle synchronous closure reader for an already-owned SQLite transaction. */
export function createTransactionLocalOperationClosureReader(
  db: Database.Database,
): Pick<CloseableConnectorRepository, "getOperationClosure"> {
  const repository = new SqliteConnectorRepository(db);
  return Object.freeze({
    getOperationClosure: (ownerId: string, operationVersionId: string) =>
      repository.getOperationClosure(ownerId, operationVersionId),
  });
}
