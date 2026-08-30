import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";
import { canonicalConnectorProjectionBytes } from "@/lib/connectors/schema";
import {
  createTransactionLocalOperationClosureReader,
  SqliteConnectorRepository,
} from "@/lib/connectors/sqlite-repository";
import type { ConnectorRepositoryTransaction } from "@/lib/connectors/repository";

const IDS = {
  connector: "00000000-0000-4000-8000-000000000101",
  definition1: "00000000-0000-4000-8000-000000000102",
  definition2: "00000000-0000-4000-8000-000000000103",
  operation1: "00000000-0000-4000-8000-000000000104",
  operation2: "00000000-0000-4000-8000-000000000105",
  rate: "00000000-0000-4000-8000-000000000106",
  correlation: "00000000-0000-4000-8000-000000000107",
} as const;

function source(path = "/things/{id}", description = "STRIPPED_CANARY"): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "CANARY_TITLE", version: "1", description },
    servers: [{ url: "https://api.vendor.com" }],
    paths: {
      [path]: {
        get: {
          operationId: "getThing",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "CANARY_RESPONSE" } },
        },
      },
    },
  });
}

function compiled(path = "/things/{id}") {
  const result = compileOpenApi310(source(path));
  if (!result.ok) throw new Error(result.code);
  return result;
}

function setup(): { db: Database.Database; repository: SqliteConnectorRepository } {
  const db = new Database(":memory:");
  runSqliteMigrations(db);
  return { db, repository: new SqliteConnectorRepository(db) };
}

function writeInput(result = compiled(), ids = IDS) {
  return {
    ownerId: "owner-a",
    connectorId: null,
    newConnectorId: ids.connector,
    definitionVersionId: ids.definition1,
    operationVersionId: ids.operation1,
    displayLabel: "Vendor API",
    connectorProjection: result.connectorProjection,
    connectorProjectionHash: result.connectorProjectionHash,
    operation: result.operations[0]!,
    authorAnnotation: { label: "Unverified" as const, effectNote: "Writes records" },
    now: 100,
  };
}

function uncheckedCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(uncheckedCanonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key.normalize("NFC"))}:${uncheckedCanonical(record[key])}`).join(",")}}`;
}

function uncheckedHash(value: unknown): string {
  return createHash("sha256").update(uncheckedCanonical(value)).digest("hex");
}

describe("SqliteConnectorRepository", () => {
  it("creates one identity, immutable definition, and selected operation then reuses exact bytes", () => {
    const { db, repository } = setup();
    const first = repository.immediate((transaction) => transaction.persistCompiledImport(writeInput()));
    const second = repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(),
      connectorId: IDS.connector,
      newConnectorId: "00000000-0000-4000-8000-000000000199",
      definitionVersionId: "00000000-0000-4000-8000-000000000198",
      operationVersionId: "00000000-0000-4000-8000-000000000197",
      now: 101,
    }));

    expect(first.status).toBe("ok");
    expect(first).toMatchObject({
      identityDisposition: "created",
      definitionDisposition: "created",
      operationDisposition: "created",
      drift: null,
    });
    expect(second).toMatchObject({
      status: "ok",
      identityDisposition: "reused",
      definitionDisposition: "reused-current",
      operationDisposition: "reused",
      drift: null,
    });
    expect(second.status === "ok" && second.definition.id).toBe(IDS.definition1);
    expect(second.status === "ok" && second.operation.id).toBe(IDS.operation1);
    expect(db.prepare("SELECT count(*) count FROM connector_identities").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM connector_definition_versions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM connector_operation_versions").get()).toEqual({ count: 1 });
  });

  it.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://api.vendor.internal",
    "https://xn--mnich-kva.example.com",
  ])("refuses a hash-consistent unsafe origin at the direct repository boundary: %s", (origin) => {
    const { db, repository } = setup();
    const result = compiled();
    const connectorProjection = { ...result.connectorProjection, origin };
    expect(() => repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(result),
      connectorProjection,
      connectorProjectionHash: uncheckedHash(connectorProjection),
    }))).toThrow(/Invalid connector contract/);
    expect(db.prepare("SELECT COUNT(*) count FROM connector_identities").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM connector_definition_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM connector_operation_versions").get()).toEqual({ count: 0 });
    db.close();
  });

  it("requires the exact owner connector id, versions changed projections, and reuses history", () => {
    const { repository } = setup();
    repository.immediate((transaction) => transaction.persistCompiledImport(writeInput()));
    const changed = compiled("/v2/things/{id}");
    const next = repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(changed),
      connectorId: IDS.connector,
      definitionVersionId: IDS.definition2,
      operationVersionId: IDS.operation2,
      now: 200,
    }));
    const reverted = repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(),
      connectorId: IDS.connector,
      newConnectorId: "00000000-0000-4000-8000-000000000190",
      definitionVersionId: "00000000-0000-4000-8000-000000000191",
      operationVersionId: "00000000-0000-4000-8000-000000000192",
      now: 300,
    }));
    const foreign = repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(), ownerId: "owner-b", connectorId: IDS.connector,
    }));

    expect(next).toMatchObject({
      status: "ok",
      identityDisposition: "reused",
      definitionDisposition: "version-created",
      drift: {
        before: {
          versionId: IDS.definition1,
          versionNumber: 1,
          connectorProjectionHash: compiled().connectorProjectionHash,
        },
        after: {
          versionId: IDS.definition2,
          versionNumber: 2,
          connectorProjectionHash: changed.connectorProjectionHash,
        },
      },
    });
    expect(next.status === "ok" && next.definition.versionNumber).toBe(2);
    expect(reverted).toMatchObject({ status: "ok", definitionDisposition: "reused-historical" });
    expect(foreign).toEqual({ status: "not-found" });
    expect(repository.listDefinitionHistory("owner-a", IDS.connector).map((entry) => entry.versionNumber))
      .toEqual([2, 1]);
  });

  it("owner-filters before hydrating projection bytes, including malformed foreign rows", () => {
    const { db, repository } = setup();
    const foreignConnector = "00000000-0000-4000-8000-000000000150";
    const foreignDefinition = "00000000-0000-4000-8000-000000000151";
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`INSERT INTO connector_identities
      (id, owner_id, display_label, archived_at, lifecycle_revision, created_at, updated_at)
      VALUES (?, 'owner-b', 'Foreign', NULL, 1, 1, 1)`).run(foreignConnector);
    db.prepare(`INSERT INTO connector_definition_versions
      (id, owner_id, connector_id, version_number, projection_json, connector_projection_hash, created_at)
      VALUES (?, 'owner-b', ?, 1, 'MALFORMED_FOREIGN', ?, 1)`)
      .run(foreignDefinition, foreignConnector, "a".repeat(64));
    db.pragma("ignore_check_constraints = OFF");

    expect(repository.getDefinitionVersion("owner-a", foreignDefinition)).toBeNull();
    expect(() => repository.getDefinitionVersion("owner-b", foreignDefinition)).toThrow("Invalid connector contract");

    const foreignOperation = "00000000-0000-4000-8000-000000000152";
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`INSERT INTO connector_operation_versions
      (id, owner_id, connector_definition_version_id, operation_id, projection_json,
       operation_projection_hash, schema_hash, author_annotation_json, created_at)
      VALUES (?, 'owner-b', ?, 'getThing', 'MALFORMED_OPERATION', ?, ?, NULL, 1)`)
      .run(foreignOperation, foreignDefinition, "b".repeat(64), "c".repeat(64));
    db.pragma("ignore_check_constraints = OFF");
    expect(repository.getOperationVersion("owner-a", foreignOperation)).toBeNull();
    expect(repository.getOperationClosure("owner-a", foreignOperation)).toBeNull();
    expect(() => repository.getOperationVersion("owner-b", foreignOperation)).toThrow("Invalid connector contract");
    expect(() => repository.getOperationClosure("owner-b", foreignOperation)).toThrow("Invalid connector contract");
  });

  it("rejects all three forged hashes, non-member operations, and conflicting annotation reuse on write", () => {
    const { repository } = setup();
    expect(() => repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(), connectorProjectionHash: "f".repeat(64),
    }))).toThrow("Invalid connector contract");
    expect(() => repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(), operation: { ...writeInput().operation, operationProjectionHash: "f".repeat(64) },
    }))).toThrow("Invalid connector contract");
    expect(() => repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(), operation: { ...writeInput().operation, schemaHash: "f".repeat(64) },
    }))).toThrow("Invalid connector contract");
    expect(() => repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(), operation: compiled("/other/{id}").operations[0]!,
    }))).toThrow("Invalid connector contract");
    repository.immediate((transaction) => transaction.persistCompiledImport(writeInput()));
    const conflict = repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(),
      connectorId: IDS.connector,
      authorAnnotation: { label: "Unverified", effectNote: "Different" },
    }));
    expect(conflict).toEqual({ status: "annotation-conflict" });
  });

  it("verifies every stored hash and exact parent operation membership during hydration", () => {
    for (const mutate of [
      (db: Database.Database): void => {
        db.exec("DROP TRIGGER connector_definition_versions_no_update");
        db.prepare("UPDATE connector_definition_versions SET connector_projection_hash = ?")
          .run("f".repeat(64));
      },
      (db: Database.Database): void => {
        db.exec("DROP TRIGGER connector_operation_versions_no_update");
        db.prepare("UPDATE connector_operation_versions SET operation_projection_hash = ?")
          .run("f".repeat(64));
      },
      (db: Database.Database): void => {
        db.exec("DROP TRIGGER connector_operation_versions_no_update");
        db.prepare("UPDATE connector_operation_versions SET schema_hash = ?")
          .run("f".repeat(64));
      },
      (db: Database.Database): void => {
        const other = compiled("/other/{id}");
        db.exec("DROP TRIGGER connector_definition_versions_no_update");
        db.prepare(`UPDATE connector_definition_versions
          SET projection_json = ?, connector_projection_hash = ?`)
          .run(
            canonicalConnectorProjectionBytes(other.connectorProjection).toString("utf8"),
            other.connectorProjectionHash,
          );
      },
    ]) {
      const { db, repository } = setup();
      repository.immediate((transaction) => transaction.persistCompiledImport(writeInput()));
      mutate(db);
      expect(() => repository.getOperationVersion("owner-a", IDS.operation1)).toThrow("Invalid connector contract");
      expect(() => repository.getOperationClosure("owner-a", IDS.operation1)).toThrow("Invalid connector contract");
    }
  });

  it("invalidates escaped transaction facades and rejects async callbacks before commit", () => {
    const { db, repository } = setup();
    let escaped: ConnectorRepositoryTransaction | undefined;
    repository.immediate((transaction) => {
      escaped = transaction;
    });
    expect(() => escaped?.reserveImport({
      id: IDS.rate,
      ownerId: "owner-a",
      correlationId: IDS.correlation,
      now: 1,
    })).toThrow(/transaction is no longer active/i);

    expect(() => repository.immediate(async (transaction) => {
      transaction.reserveImport({
        id: IDS.rate,
        ownerId: "owner-a",
        correlationId: IDS.correlation,
        now: 1,
      });
    })).toThrow(/synchronous/i);
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get())
      .toEqual({ count: 0 });
  });

  it("invalidates the transaction facade before inspecting a returned thenable", () => {
    const { db, repository } = setup();
    let escaped: ConnectorRepositoryTransaction | undefined;

    expect(() => repository.immediate((transaction) => {
      escaped = transaction;
      return Object.defineProperty({}, "then", {
        get: () => {
          escaped?.reserveImport({
            id: IDS.rate,
            ownerId: "owner-a",
            correlationId: IDS.correlation,
            now: 1,
          });
          return undefined;
        },
      });
    })).toThrow(/transaction is no longer active/i);
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get())
      .toEqual({ count: 0 });
  });

  it("renames and archives identity metadata without resetting history", () => {
    const { repository } = setup();
    repository.immediate((transaction) => transaction.persistCompiledImport(writeInput()));
    expect(repository.rename("owner-a", IDS.connector, 1, "Renamed", 200)).toMatchObject({
      status: "updated", identity: { displayLabel: "Renamed", lifecycleRevision: 2 },
    });
    expect(repository.archive("owner-a", IDS.connector, 2, 300)).toMatchObject({
      status: "updated", identity: { archivedAt: 300, lifecycleRevision: 3 },
    });
    expect(repository.listDefinitionHistory("owner-a", IDS.connector)).toHaveLength(1);
    expect(repository.rename("owner-b", IDS.connector, 3, "Nope", 400)).toEqual({ status: "not-found" });
  });

  it("reserves a rolling ten-per-minute budget atomically", () => {
    const { db, repository } = setup();
    for (let index = 0; index < 10; index += 1) {
      const reserved = repository.immediate((transaction) => transaction.reserveImport({
        id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
        ownerId: "owner-a",
        correlationId: `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
        now: 60_000 + index,
      }));
      expect(reserved).toBe(true);
    }
    expect(repository.immediate((transaction) => transaction.reserveImport({
      id: IDS.rate, ownerId: "owner-a", correlationId: IDS.correlation, now: 60_010,
    }))).toBe(false);
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get())
      .toEqual({ count: 10 });
    expect(repository.immediate((transaction) => transaction.reserveImport({
      id: IDS.rate, ownerId: "owner-a", correlationId: IDS.correlation, now: 120_001,
    }))).toBe(true);
  });

  it("provides owner-scoped bounded identity search and paginated history for downstream APIs", () => {
    const { db, repository } = setup();
    repository.immediate((transaction) => transaction.persistCompiledImport(writeInput()));
    const changed = compiled("/v2/things/{id}");
    repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(changed), connectorId: IDS.connector, definitionVersionId: IDS.definition2,
      operationVersionId: IDS.operation2, now: 200,
    }));

    expect(repository.getConnectorIdentity("owner-b", IDS.connector)).toBeNull();
    expect(repository.listConnectorIdentities("owner-a", { limit: 1, search: "Vendor" })).toMatchObject({
      items: [{ id: IDS.connector }], nextCursor: null,
    });
    const first = repository.listDefinitionHistoryPage("owner-a", IDS.connector, { limit: 1 });
    expect(first.items.map((item) => item.versionNumber)).toEqual([2]);
    expect(first.nextBeforeVersionNumber).toBe(2);
    expect(repository.listDefinitionHistoryPage("owner-a", IDS.connector, {
      limit: 1, beforeVersionNumber: first.nextBeforeVersionNumber!,
    }).items.map((item) => item.versionNumber)).toEqual([1]);
    expect(repository.getOperationClosure("owner-a", IDS.operation1)).toMatchObject({
      identity: { id: IDS.connector }, definition: { id: IDS.definition1 }, operation: { id: IDS.operation1 },
    });
    expect(repository.getOperationClosure("owner-b", IDS.operation1)).toBeNull();
    expect(db.transaction(() =>
      createTransactionLocalOperationClosureReader(db).getOperationClosure("owner-a", IDS.operation1),
    )()).toMatchObject({
      identity: { id: IDS.connector }, definition: { id: IDS.definition1 }, operation: { id: IDS.operation1 },
    });
  });

  it("lists bounded materialized operation summaries owner-first without hydrating projections", () => {
    const { db, repository } = setup();
    const firstCompiled = compiled();
    const secondCompiled = compiled("/v2/things/{id}");
    repository.immediate((transaction) => transaction.persistCompiledImport(writeInput(firstCompiled)));
    repository.immediate((transaction) => transaction.persistCompiledImport({
      ...writeInput(secondCompiled), connectorId: IDS.connector, definitionVersionId: IDS.definition2,
      operationVersionId: IDS.operation2, now: 200,
    }));

    db.exec("DROP TRIGGER connector_operation_versions_no_update");
    db.prepare("UPDATE connector_operation_versions SET projection_json = ? WHERE id = ?")
      .run(JSON.stringify({ source: "projection-must-not-be-read" }), IDS.operation1);

    const first = repository.listOperationVersions("owner-a", IDS.connector, { limit: 1 });
    expect(first.items).toEqual([{
      operationVersionId: IDS.operation2,
      connectorDefinitionVersionId: IDS.definition2,
      definitionVersionNumber: 2,
      operationId: "getThing",
      connectorProjectionHash: secondCompiled.connectorProjectionHash,
      operationProjectionHash: secondCompiled.operations[0]!.operationProjectionHash,
      schemaHash: secondCompiled.operations[0]!.schemaHash,
      executionAvailability: "simulation_only",
      authorAnnotation: { label: "Unverified", effectNote: "Writes records" },
    }]);
    expect(first.nextCursor).toEqual({ createdAt: 200, id: IDS.operation2 });
    expect(Object.isFrozen(first.items[0])).toBe(true);

    const second = repository.listOperationVersions("owner-a", IDS.connector, {
      limit: 1,
      after: first.nextCursor!,
    });
    expect(second.items).toMatchObject([{ operationVersionId: IDS.operation1, definitionVersionNumber: 1 }]);
    expect(second.nextCursor).toBeNull();
    expect(repository.listOperationVersions("owner-b", IDS.connector, { limit: 10 }))
      .toEqual({ items: [], nextCursor: null });
    expect(() => repository.listOperationVersions("owner-a", IDS.connector, { limit: 0 })).toThrow(/page/i);
    expect(() => repository.listOperationVersions("owner-a", IDS.connector, {
      limit: 1,
      after: { createdAt: -1, id: IDS.operation1 },
    })).toThrow(/page/i);

    const query = `SELECT listing.operation_version_id
      FROM connector_operation_list_entries listing
      JOIN connector_operation_versions operation
        ON operation.owner_id = listing.owner_id
       AND operation.id = listing.operation_version_id
      JOIN connector_definition_versions definition
        ON definition.owner_id = listing.owner_id
       AND definition.connector_id = listing.connector_id
       AND definition.id = operation.connector_definition_version_id
      WHERE listing.owner_id = ? AND listing.connector_id = ?`;
    const firstPlan = db.prepare(`EXPLAIN QUERY PLAN ${query}
      ORDER BY listing.created_at DESC, listing.operation_version_id DESC LIMIT ?`)
      .all("owner-a", IDS.connector, 2) as Array<{ detail: string }>;
    const cursorPlan = db.prepare(`EXPLAIN QUERY PLAN ${query}
      AND (listing.created_at, listing.operation_version_id) < (?, ?)
      ORDER BY listing.created_at DESC, listing.operation_version_id DESC LIMIT ?`)
      .all("owner-a", IDS.connector, 200, IDS.operation2, 2) as Array<{ detail: string }>;
    expect(firstPlan.some((row) => /SEARCH listing USING PRIMARY KEY \(owner_id=\? AND connector_id=\?\)/u.test(row.detail))).toBe(true);
    expect(cursorPlan.some((row) => /SEARCH listing USING PRIMARY KEY \(owner_id=\? AND connector_id=\? AND \(created_at,operation_version_id\)<\(\?,\?\)\)/u.test(row.detail))).toBe(true);
    expect([...firstPlan, ...cursorPlan].every((row) => !/USE TEMP B-TREE/iu.test(row.detail))).toBe(true);
  });
});
