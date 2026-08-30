import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";

describe("connector portability lookup migration v19", () => {
  it("adds and integrity-checks the bounded owner/hash lookup index", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 19").get())
      .toEqual({ version: 19, name: "connector-portability-lookup" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_connector_definition_owner_projection_hash'",
    ).get()).toEqual({ name: "idx_connector_definition_owner_projection_hash" });
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT definition.id
      FROM connector_definition_versions definition
      JOIN connector_identities identity
        ON identity.owner_id = definition.owner_id
       AND identity.id = definition.connector_id
       AND identity.archived_at IS NULL
      WHERE definition.owner_id = ? AND definition.connector_projection_hash = ?
      ORDER BY definition.connector_id, definition.id LIMIT 1`)
      .all("owner", "a".repeat(64)) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_connector_definition_owner_projection_hash")))
      .toBe(true);
    db.exec("DROP INDEX idx_connector_definition_owner_projection_hash");
    expect(() => runSqliteMigrations(db)).toThrow(/connector portability.*index.*definition mismatch/i);
    db.close();
  });
});
