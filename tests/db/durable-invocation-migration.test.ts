import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { removePostV16MigrationFixture } from "../helpers/sqlite-migration-fixture";

describe("SQLite v11 durable invocation migration", () => {
  it("adds the exact append-only invocation object without changing v10 schema bytes", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    removePostV16MigrationFixture(db);
    const v10 = db.prepare("SELECT name, checksum FROM schema_migrations WHERE version = 10").get();
    const legacySql = db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'durable_%' OR name LIKE 'execution_%' ORDER BY name").all()
      .filter((row) => (row as { name: string }).name !== "execution_invocations" && !(row as { name: string }).name.startsWith("execution_invocations_"));
    db.exec("DROP TRIGGER durable_executions_parent_owner_insert; DROP TRIGGER durable_executions_parent_owner_update; DROP TABLE execution_job_quarantine; DROP TABLE execution_event_usage; DROP TRIGGER execution_invocations_no_update; DROP TRIGGER execution_invocations_no_delete; DROP TABLE execution_invocations; DELETE FROM schema_migrations WHERE version >= 11");
    runSqliteMigrations(db);
    expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version = 10").get()).toEqual(v10);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'durable_%' OR name LIKE 'execution_%' ORDER BY name").all()
      .filter((row) => (row as { name: string }).name !== "execution_invocations" && !(row as { name: string }).name.startsWith("execution_invocations_"))).toEqual(legacySql);
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 11").get()).toEqual({ version: 11, name: "durable-invocations" });
    db.close();
  });

  it("requires one object snapshot and physically rejects mutation", () => {
    const db = new Database(":memory:"); runSqliteMigrations(db);
    db.exec("INSERT INTO flows (id,owner_id,name,graph,updated_at) VALUES ('f','o','f','{}',1); INSERT INTO flow_versions (id,flow_id,version_number,schema_version,graph,semantic_hash,full_hash,created_by,created_at) VALUES ('v','f',1,1,'{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','o',1)");
    db.prepare("INSERT INTO durable_executions (id,owner_id,flow_id,flow_version_id,frozen_definition_json,definition_hash,trigger_type,state,desired_state,next_event_seq,projected_event_seq,projection_json,cost_micro_usdc,token_count,cost_budget_micro_usdc,token_budget,attempt_number,created_at,updated_at) VALUES ('e','o','f','v','{}',?,'api','queued','running',1,0,'{}',0,0,0,0,0,1,1)").run("b".repeat(64));
    const insert = db.prepare("INSERT INTO execution_invocations (execution_id,schema_version,snapshot_json,snapshot_hash,created_at) VALUES ('e',1,?,?,1)");
    expect(() => insert.run("[]", "a".repeat(64))).toThrow();
    expect(() => insert.run("1", "a".repeat(64))).toThrow();
    insert.run("{}", "a".repeat(64));
    expect(() => db.exec("UPDATE execution_invocations SET created_at = 2")).toThrow(/append-only/i);
    expect(() => db.exec("DELETE FROM execution_invocations")).toThrow(/append-only/i);
    db.close();
  });

  it("detects normalized sqlite_master drift", () => {
    const db = new Database(":memory:"); runSqliteMigrations(db);
    db.exec("DROP TRIGGER execution_invocations_no_delete");
    expect(() => runSqliteMigrations(db)).toThrow(/durable invocation.*mismatch/i);
    db.close();
  });
});
