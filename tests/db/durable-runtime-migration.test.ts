import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";

const TABLES = [
  "durable_executions",
  "execution_events",
  "execution_jobs",
  "execution_attempts",
  "execution_checkpoints",
  "execution_idempotency",
] as const;

function schemaNames(db: Database.Database, type: "table" | "index" | "trigger"): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as Array<{ name: string }>).map((row) => row.name);
}

describe("SQLite durable runtime migration v10", () => {
  it("creates only additive durable tables, constraints, indexes, and append-only guards", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    expect(schemaNames(db, "table")).toEqual(expect.arrayContaining([...TABLES]));
    expect(schemaNames(db, "index")).toEqual(expect.arrayContaining([
      "idx_durable_executions_owner_created",
      "idx_execution_events_execution_sequence",
      "idx_execution_jobs_claim",
      "idx_execution_attempts_job",
      "idx_execution_checkpoints_execution_sequence",
      "uq_execution_idempotency_scope",
    ]));
    expect(schemaNames(db, "trigger")).toEqual(expect.arrayContaining([
      "execution_events_no_update",
      "execution_events_no_delete",
      "execution_checkpoints_no_update",
      "execution_checkpoints_no_delete",
    ]));

    const migration = db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version = 10").get();
    expect(migration).toMatchObject({ version: 10, name: "durable-runtime" });
    expect((migration as { checksum: string }).checksum).toMatch(/^[0-9a-f]{64}$/);

    db.close();
  });

  it("preserves legacy row bytes and does not backfill old runs", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const graph = '{"z":1,"a":[3,2,1]}';
    const output = '{"raw":"legacy\\u0000bytes"}';
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)").run("flow-old", "owner", "Old", graph, 1);
    db.prepare("INSERT INTO runs (id, flow_id, trigger, status, total_cost_usdc, started_at) VALUES (?, ?, ?, ?, ?, ?)").run("run-old", "flow-old", "api", "complete", 0, 1);
    db.prepare("INSERT INTO run_steps (id, run_id, node_id, node_type, status, cost_usdc, output) VALUES (?, ?, ?, ?, ?, ?, ?)").run("step-old", "run-old", "n1", "output", "complete", 0, output);

    const before = db.prepare("SELECT hex(graph) AS graph FROM flows WHERE id = 'flow-old'").get();
    runSqliteMigrations(db);
    const after = db.prepare("SELECT hex(graph) AS graph FROM flows WHERE id = 'flow-old'").get();
    expect(after).toEqual(before);
    expect(db.prepare("SELECT hex(output) AS output FROM run_steps WHERE id = 'step-old'").get()).toEqual({ output: Buffer.from(output).toString("hex").toUpperCase() });
    expect(db.prepare("SELECT count(*) AS count FROM durable_executions").get()).toEqual({ count: 0 });
    db.close();
  });

  it("is idempotent and refuses a changed v10 checksum", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'durable_executions'").get();
    runSqliteMigrations(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'durable_executions'").get()).toEqual(before);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 10").run("0".repeat(64));
    expect(() => runSqliteMigrations(db)).toThrow(/checksum mismatch/i);
    db.close();
  });

  it("fails closed when a committed append-only guard drifts", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec("DROP TRIGGER execution_events_no_delete");
    expect(() => runSqliteMigrations(db)).toThrow(/durable runtime.*execution_events_no_delete/i);
    db.close();
  });

  it.each([
    ["trigger", "execution_events_no_delete", "CREATE TRIGGER execution_events_no_delete BEFORE DELETE ON execution_events BEGIN SELECT 1; END"],
    ["index", "idx_execution_jobs_claim", "CREATE INDEX idx_execution_jobs_claim ON execution_jobs(id)"],
    ["table", "execution_idempotency", "CREATE TABLE execution_idempotency (id INTEGER PRIMARY KEY)"],
  ] as const)("rejects a malformed preexisting %s definition", (_type, name, replacement) => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`DROP ${_type.toUpperCase()} ${name}`);
    db.exec(replacement);
    expect(() => runSqliteMigrations(db)).toThrow(new RegExp(`durable runtime.*${name}`, "i"));
    db.close();
  });

  it("enforces foreign keys, checks, uniqueness, and append-only event/checkpoint rows", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run("missing", 1, 1, 0, "execution.created", 1, "{}" )).toThrow(/foreign key/i);
    expect(() => db.prepare("INSERT INTO durable_executions (id, owner_id, flow_id, flow_version_id, frozen_definition_json, definition_hash, trigger_type, state, desired_state, next_event_seq, projected_event_seq, cost_micro_usdc, token_count, cost_budget_micro_usdc, token_budget, attempt_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("e", "o", "f", "", "{}", "a".repeat(64), "api", "queued", "running", 3, 2, 0, 0, 0, 0, 0, 1, 1)).toThrow();
    db.close();
  });
});
