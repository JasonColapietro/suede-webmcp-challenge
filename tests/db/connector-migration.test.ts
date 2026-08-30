import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";

const IDENTITY_ID = "00000000-0000-4000-8000-000000000101";
const DEFINITION_ID = "00000000-0000-4000-8000-000000000102";
const OPERATION_ID = "00000000-0000-4000-8000-000000000103";
const RATE_ID = "00000000-0000-4000-8000-000000000104";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000105";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function objects(db: Database.Database, type: "table" | "index" | "trigger"): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as Array<{ name: string }>)
    .map((row) => row.name);
}

function insertIdentity(db: Database.Database): void {
  db.prepare(`INSERT INTO connector_identities
    (id, owner_id, display_label, archived_at, lifecycle_revision, created_at, updated_at)
    VALUES (?, 'owner-a', 'Example API', NULL, 1, 10, 10)`).run(IDENTITY_ID);
}

function insertDefinition(db: Database.Database): void {
  db.prepare(`INSERT INTO connector_definition_versions
    (id, owner_id, connector_id, version_number, projection_json, connector_projection_hash, created_at)
    VALUES (?, 'owner-a', ?, 1, '{}', ?, 10)`).run(DEFINITION_ID, IDENTITY_ID, HASH_A);
}

describe("connector persistence migration v18", () => {
  it("appends the owner-scoped schema, indexes, foreign keys, and immutable guards", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    expect(objects(db, "table")).toEqual(expect.arrayContaining([
      "connector_identities",
      "connector_definition_versions",
      "connector_operation_versions",
      "connector_import_rate_reservations",
    ]));
    expect(objects(db, "index")).toEqual(expect.arrayContaining([
      "uq_connector_identities_owner_id",
      "uq_connector_definition_owner_version",
      "uq_connector_definition_owner_hash",
      "idx_connector_definition_owner_created",
      "uq_connector_operation_owner_definition_operation",
      "idx_connector_operation_owner_created",
      "idx_connector_import_rate_owner_time",
    ]));
    expect(objects(db, "trigger")).toEqual(expect.arrayContaining([
      "connector_definition_versions_no_update",
      "connector_definition_versions_no_delete",
      "connector_operation_versions_no_update",
      "connector_operation_versions_no_delete",
      "connector_import_rate_no_update",
      "connector_import_rate_no_delete",
      "connector_identities_identity_no_update",
      "connector_identities_revision_update",
    ]));
    expect(db.prepare("PRAGMA foreign_key_list(connector_definition_versions)").all()).toHaveLength(2);
    expect(db.prepare("PRAGMA foreign_key_list(connector_operation_versions)").all()).toHaveLength(2);
  });

  it("upgrades v17, preserves the exact v1-v17 ledger, and reruns idempotently", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const prefix = db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version <= 17 ORDER BY version",
    ).all();
    db.exec(`
      DROP TABLE resource_run_receipts;
      DROP TABLE resource_releases;
      DROP TABLE resource_evidence_refs;
      DROP TABLE resource_records;
      DROP TABLE resource_pack_versions;
      DROP TABLE resource_source_snapshots;
      DROP TABLE resource_source_assets;
      DROP TABLE resource_products;
      DROP TABLE ap2_authorizations;
      DROP INDEX idx_ceo_messages_company;
      DROP TABLE company_ceo_messages;
      DROP INDEX idx_agent_listings_agent;
      DROP TABLE agent_listings;
      DROP TRIGGER connections_crypto_owner_update;
      DROP TRIGGER connections_crypto_owner_insert;
      ALTER TABLE connections DROP COLUMN crypto_owner_id;
      DROP TRIGGER connector_operation_list_no_delete;
      DROP TRIGGER connector_operation_list_no_update;
      DROP TRIGGER connector_operation_list_insert;
      DROP TABLE connector_operation_list_entries;
      DROP TRIGGER connector_import_rate_no_delete;
      DROP TRIGGER connector_import_rate_no_update;
      DROP TRIGGER connector_operation_versions_no_delete;
      DROP TRIGGER connector_operation_versions_no_update;
      DROP TRIGGER connector_definition_versions_no_delete;
      DROP TRIGGER connector_definition_versions_no_update;
      DROP TRIGGER connector_identities_revision_update;
      DROP TRIGGER connector_identities_identity_no_update;
      DROP TABLE connector_import_rate_reservations;
      DROP TABLE connector_operation_versions;
      DROP TABLE connector_definition_versions;
      DROP TABLE connector_identities;
      DROP INDEX idx_runs_company_activity;
      DROP INDEX idx_approvals_company_activity;
      DROP INDEX idx_approvals_company;
      DROP TABLE company_approvals;
      DROP TABLE company_employee_instructions;
      DROP INDEX idx_employees_company;
      DROP TABLE company_employees;
      DROP INDEX idx_departments_company;
      DROP TABLE company_departments;
      DROP INDEX idx_companies_owner;
      DROP TABLE companies;
      DROP INDEX idx_settlements_owner;
      DROP INDEX idx_settlements_agent;
      DROP TABLE settlements;
      DROP INDEX idx_moderation_reports_queue;
      DROP INDEX idx_moderation_reports_reporter;
      DROP TABLE moderation_reports;
      DROP INDEX idx_health_checks_checked_at;
      DROP TABLE health_checks;
      DROP TABLE prospect_recipient_suppressions;
      DROP TABLE prospect_records;
      DELETE FROM schema_migrations WHERE version IN (18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45);
    `);

    runSqliteMigrations(db);
    runSqliteMigrations(db);

    expect(db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version <= 17 ORDER BY version",
    ).all()).toEqual(prefix);
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 18").get())
      .toEqual({ version: 18, name: "immutable-connector-assets" });
  });

  it("rejects v18 checksum, index, and trigger drift on rerun", () => {
    for (const [mutate, expected] of [
      [
        (db: Database.Database): void => {
          db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 18").run();
        },
        "checksum mismatch",
      ],
      [
        (db: Database.Database): void => {
          db.exec("DROP INDEX idx_connector_import_rate_owner_time");
        },
        "index idx_connector_import_rate_owner_time definition mismatch",
      ],
      [
        (db: Database.Database): void => {
          db.exec("DROP TRIGGER connector_operation_versions_no_delete");
        },
        "trigger connector_operation_versions_no_delete definition mismatch",
      ],
    ] as const) {
      const db = new Database(":memory:");
      runSqliteMigrations(db);
      mutate(db);
      expect(() => runSqliteMigrations(db)).toThrow(expected);
    }
  });

  it("enforces owner foreign keys and refuses update, delete, and replace of immutable rows", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertIdentity(db);
    insertDefinition(db);

    expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);
    expect(() => db.prepare(`INSERT OR REPLACE INTO connector_definition_versions
      (id, owner_id, connector_id, version_number, projection_json, connector_projection_hash, created_at)
      VALUES (?, 'owner-a', ?, 1, '{}', ?, 11)`)
      .run("00000000-0000-4000-8000-000000000111", IDENTITY_ID, HASH_A)).toThrow(/replacement/i);

    db.prepare(`INSERT INTO connector_operation_versions
      (id, owner_id, connector_definition_version_id, operation_id, projection_json,
       operation_projection_hash, schema_hash, author_annotation_json, created_at)
      VALUES (?, 'owner-a', ?, 'getThing', '{}', ?, ?, NULL, 10)`)
      .run(OPERATION_ID, DEFINITION_ID, HASH_A, HASH_B);
    db.prepare(`INSERT INTO connector_import_rate_reservations
      (id, owner_id, correlation_id, reserved_at) VALUES (?, 'owner-a', ?, 10)`)
      .run(RATE_ID, CORRELATION_ID);

    expect(() => db.prepare(
      "INSERT INTO connector_definition_versions VALUES (?, 'owner-b', ?, 2, '{}', ?, 11)",
    ).run("00000000-0000-4000-8000-000000000106", IDENTITY_ID, HASH_B)).toThrow(/foreign key/i);
    for (const [table, update] of [
      ["connector_definition_versions", "created_at = 11"],
      ["connector_operation_versions", "created_at = 11"],
      ["connector_import_rate_reservations", "reserved_at = 11"],
    ] as const) {
      expect(() => db.prepare(`UPDATE ${table} SET ${update}`).run()).toThrow(/append-only/i);
      expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/i);
    }
    expect(() => db.prepare(`INSERT OR REPLACE INTO connector_definition_versions
      (id, owner_id, connector_id, version_number, projection_json, connector_projection_hash, created_at)
      VALUES (?, 'owner-a', ?, 1, '{}', ?, 12)`).run(DEFINITION_ID, IDENTITY_ID, HASH_A)).toThrow();
  });

  it("refuses replacement through every immutable secondary unique key", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertIdentity(db);
    insertDefinition(db);
    db.prepare(`INSERT INTO connector_operation_versions
      (id, owner_id, connector_definition_version_id, operation_id, projection_json,
       operation_projection_hash, schema_hash, author_annotation_json, created_at)
      VALUES (?, 'owner-a', ?, 'getThing', '{}', ?, ?, NULL, 10)`)
      .run(OPERATION_ID, DEFINITION_ID, HASH_A, HASH_B);
    db.prepare(`INSERT INTO connector_import_rate_reservations
      (id, owner_id, correlation_id, reserved_at) VALUES (?, 'owner-a', ?, 10)`)
      .run(RATE_ID, CORRELATION_ID);

    expect(() => db.prepare(`INSERT OR REPLACE INTO connector_operation_versions
      (id, owner_id, connector_definition_version_id, operation_id, projection_json,
       operation_projection_hash, schema_hash, author_annotation_json, created_at)
      VALUES (?, 'owner-a', ?, 'getThing', '{}', ?, ?, NULL, 11)`)
      .run("00000000-0000-4000-8000-000000000112", DEFINITION_ID, HASH_A, HASH_B)).toThrow(/replacement/i);
    expect(() => db.prepare(`INSERT OR REPLACE INTO connector_import_rate_reservations
      (id, owner_id, correlation_id, reserved_at) VALUES (?, 'owner-a', ?, 11)`)
      .run("00000000-0000-4000-8000-000000000113", CORRELATION_ID)).toThrow(/replacement/i);

    expect(db.prepare("SELECT id FROM connector_definition_versions").all()).toEqual([{ id: DEFINITION_ID }]);
    expect(db.prepare("SELECT id FROM connector_operation_versions").all()).toEqual([{ id: OPERATION_ID }]);
    expect(db.prepare("SELECT id FROM connector_import_rate_reservations").all()).toEqual([{ id: RATE_ID }]);
  });

  it("allows label/archive lifecycle changes without changing immutable version rows", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertIdentity(db);
    insertDefinition(db);
    const before = db.prepare("SELECT * FROM connector_definition_versions").all();

    db.prepare(`UPDATE connector_identities
      SET display_label = 'Renamed', archived_at = 20, lifecycle_revision = 2, updated_at = 20
      WHERE id = ? AND owner_id = 'owner-a'`).run(IDENTITY_ID);

    expect(db.prepare("SELECT * FROM connector_definition_versions").all()).toEqual(before);
    expect(() => db.prepare("UPDATE connector_identities SET owner_id = 'owner-b' WHERE id = ?")
      .run(IDENTITY_ID)).toThrow(/immutable/i);
    expect(() => db.prepare("UPDATE connector_identities SET display_label = 'Again' WHERE id = ?")
      .run(IDENTITY_ID)).toThrow(/revision/i);
  });
});
