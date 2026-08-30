import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { removePostV16MigrationFixture } from "../helpers/sqlite-migration-fixture";

function objectNames(db: Database.Database, type: "index" | "table" | "trigger"): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
  ).all(type) as Array<{ name: string }>).map((row) => row.name);
}

function uuid(suffix: number): string {
  return `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function downgradeAuditMigration(db: Database.Database): void {
  removePostV16MigrationFixture(db);
}

describe("control audit migration v17", () => {
  it("creates the bounded append-only audit schema and required indexes", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    expect(objectNames(db, "table")).toContain("control_audit_events");
    expect(objectNames(db, "index")).toEqual(expect.arrayContaining([
      "idx_control_audit_events_owner_created",
      "idx_control_audit_events_owner_correlation",
      "idx_control_audit_events_owner_resource",
      "uq_control_audit_events_owner_correlation_action",
    ]));
    expect(objectNames(db, "trigger")).toEqual(expect.arrayContaining([
      "control_audit_events_no_delete",
      "control_audit_events_no_update",
    ]));

    const columns = (db.prepare("PRAGMA table_info(control_audit_events)").all() as Array<{
      name: string;
    }>).map((row) => row.name);
    expect(columns).toEqual([
      "id",
      "schema_version",
      "owner_id",
      "actor_id",
      "correlation_id",
      "action",
      "resource_kind",
      "resource_id",
      "resource_version_id",
      "projection_hash",
      "schema_hash",
      "outcome",
      "error_code",
      "effect",
      "connection_kind",
      "connection_suffix",
      "test_slot_status",
      "duration_ms",
      "egress_count",
      "cost_micro_usdc",
      "created_at",
    ]);
  });

  it("upgrades a v16 database, preserves prior rows, and reruns idempotently", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const prefix = db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version <= 16 ORDER BY version",
    ).all();
    downgradeAuditMigration(db);
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("flow-before-audit", "owner-a", "Before audit", "{}", 1);

    runSqliteMigrations(db);
    runSqliteMigrations(db);

    expect(db.prepare("SELECT name FROM flows WHERE id = ?").get("flow-before-audit"))
      .toEqual({ name: "Before audit" });
    expect(db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version <= 16 ORDER BY version",
    ).all()).toEqual(prefix);
    expect(db.prepare(
      "SELECT version, name FROM schema_migrations WHERE version = 17",
    ).get()).toEqual({ version: 17, name: "control-audit-events" });
  });

  it("rolls back partial v17 DDL and the ledger row on failure", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    downgradeAuditMigration(db);
    const original = db.exec.bind(db);
    Object.defineProperty(db, "exec", {
      configurable: true,
      value: (sql: string): Database.Database => {
        if (sql.includes("CREATE TABLE control_audit_events")) {
          original("CREATE TABLE control_audit_events (id TEXT PRIMARY KEY)");
          throw new Error("forced audit migration failure");
        }
        return original(sql);
      },
    });

    expect(() => runSqliteMigrations(db)).toThrow("forced audit migration failure");
    expect(objectNames(db, "table")).not.toContain("control_audit_events");
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 17").get())
      .toBeUndefined();
  });

  it("rejects mutation and malformed direct inserts at the database boundary", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const insert = db.prepare(`INSERT INTO control_audit_events (
      id, schema_version, owner_id, actor_id, correlation_id, action,
      resource_kind, resource_id, resource_version_id, projection_hash, schema_hash,
      outcome, error_code, effect, connection_kind, connection_suffix,
      test_slot_status, duration_ms, egress_count, cost_micro_usdc, created_at
    ) VALUES (
      @id, 1, 'owner-a', 'actor-a', '00000000-0000-4000-8000-000000000001',
      'connector.import', 'connector_definition', '00000000-0000-4000-8000-000000000301',
      '00000000-0000-4000-8000-000000000302',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL,
      'completed', NULL, 'write', NULL, NULL, NULL, 3, 0, 0, 10
    )`);
    insert.run({ id: "00000000-0000-4000-8000-000000000002" });
    expect(() => insert.run({ id: "00000000-0000-4000-8000-000000000007" }))
      .toThrow(/unique/i);

    expect(() => db.prepare(
      "UPDATE control_audit_events SET duration_ms = 4 WHERE resource_id = '00000000-0000-4000-8000-000000000301'",
    ).run()).toThrow("control audit events are append-only");
    expect(() => db.prepare(
      "DELETE FROM control_audit_events WHERE resource_id = '00000000-0000-4000-8000-000000000301'",
    ).run()).toThrow("control audit events are append-only");
    expect(() => db.prepare(`INSERT INTO control_audit_events (
      id, schema_version, owner_id, actor_id, correlation_id, action,
      resource_kind, resource_id, outcome, error_code, effect,
      duration_ms, egress_count, cost_micro_usdc, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "00000000-0000-4000-8000-000000000003",
        "owner-a",
        "actor-a",
        "00000000-0000-4000-8000-000000000004",
        "connector.import",
        "connector_definition",
        "connector-b",
        "completed",
        "PARSE_REFUSED",
        "write",
        1,
        0,
        0,
        10,
      )).toThrow();
    expect(() => db.prepare(`INSERT INTO control_audit_events (
      id, schema_version, owner_id, actor_id, correlation_id, action,
      resource_kind, resource_id, outcome, error_code, effect,
      duration_ms, egress_count, cost_micro_usdc, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "00000000-0000-4000-8000-000000000005",
        "owner-a",
        "actor-a",
        "00000000-0000-4000-8000-000000000006",
        "connector.import",
        "operation_version",
        "operation-a",
        "refused",
        "PROJECTION_REFUSED",
        "write",
        1,
        0,
        0,
        10,
      )).toThrow();
  });

  it("enforces structured resource IDs and action-specific terminal evidence in SQL", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const insert = db.prepare(`INSERT INTO control_audit_events (
      id, schema_version, owner_id, actor_id, correlation_id, action,
      resource_kind, resource_id, resource_version_id, projection_hash, schema_hash,
      outcome, error_code, effect, connection_kind, connection_suffix,
      test_slot_status, duration_ms, egress_count, cost_micro_usdc, created_at
    ) VALUES (
      @id, 1, 'owner-a', 'actor-a', @correlationId, @action,
      @resourceKind, @resourceId, @versionId, @projectionHash, @schemaHash,
      @outcome, @errorCode, 'write', @connectionKind, @connectionSuffix,
      @testSlotStatus, 3, 0, 0, 10
    )`);
    const completeOperation = {
      id: "00000000-0000-4000-8000-000000000311",
      correlationId: "00000000-0000-4000-8000-000000000312",
      action: "connector.operation.create",
      resourceKind: "operation_version",
      resourceId: "00000000-0000-4000-8000-000000000313",
      versionId: "00000000-0000-4000-8000-000000000314",
      projectionHash: "a".repeat(64),
      schemaHash: "b".repeat(64),
      outcome: "completed",
      errorCode: null,
      connectionKind: null,
      connectionSuffix: null,
      testSlotStatus: null,
    };

    const completeImport = {
      ...completeOperation,
      id: "00000000-0000-4000-8000-000000000351",
      correlationId: "00000000-0000-4000-8000-000000000352",
      action: "connector.import",
      resourceKind: "connector_definition",
      resourceId: "00000000-0000-4000-8000-000000000353",
      versionId: "00000000-0000-4000-8000-000000000354",
      schemaHash: null,
    };

    for (const [index, [field, value]] of ([
      ["versionId", null],
      ["projectionHash", null],
      ["schemaHash", "b".repeat(64)],
    ] as const).entries()) {
      expect(() => insert.run({
        ...completeImport,
        id: uuid(360 + index),
        correlationId: uuid(370 + index),
        [field]: value,
      })).toThrow();
    }

    for (const [index, field] of ["versionId", "projectionHash", "schemaHash"].entries()) {
      expect(() => insert.run({
        ...completeOperation,
        id: uuid(320 + index),
        correlationId: uuid(330 + index),
        [field]: null,
      })).toThrow();
    }
    expect(() => insert.run({
      ...completeOperation,
      id: "00000000-0000-4000-8000-000000000341",
      correlationId: "00000000-0000-4000-8000-000000000342",
      resourceId: "CANARY-secret-payload",
    })).toThrow();
    expect(() => insert.run({
      ...completeOperation,
      id: "00000000-0000-4000-8000-000000000347",
      correlationId: "00000000-0000-4000-8000-000000000348",
      resourceId: "0000000--000-4000-8000-000000000313",
    })).toThrow();
    expect(() => insert.run({
      ...completeOperation,
      id: "00000000-0000-4000-8000-000000000343",
      correlationId: "00000000-0000-4000-8000-000000000344",
      versionId: "CANARY-secret-payload",
    })).toThrow();
    expect(() => insert.run({
      ...completeOperation,
      id: "00000000-0000-4000-8000-000000000345",
      correlationId: "00000000-0000-4000-8000-000000000346",
      action: "connector.import",
      resourceKind: "connector_definition",
      schemaHash: null,
      connectionKind: "bearer",
      connectionSuffix: "a1b2c3d4",
      testSlotStatus: "configured",
    })).toThrow();
    expect(() => insert.run({
      ...completeOperation,
      id: "00000000-0000-4000-8000-000000000349",
      correlationId: "00000000-0000-4000-8000-000000000350",
      action: "connector.simulation",
      resourceKind: "simulation",
      schemaHash: null,
    })).toThrow();
  });
});
