import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { canonicalDurableJson } from "@/lib/runtime/invocation";
import { parseDurableExecutionEvent } from "@/lib/runtime/event-schema";
import { foldExecutionEvents } from "@/lib/runtime/projection";
import { task4bFixture } from "../runtime/task4b-fixture";
import { removePostV16MigrationFixture } from "../helpers/sqlite-migration-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function migrateFromV11(path: string): Database.Database {
  const db = new Database(path); db.pragma("foreign_keys = ON");
  removePostV16MigrationFixture(db);
  db.exec("DROP TRIGGER durable_executions_parent_owner_insert; DROP TRIGGER durable_executions_parent_owner_update; DROP TABLE execution_job_quarantine; DROP TABLE execution_event_usage; DELETE FROM schema_migrations WHERE version >= 12");
  runSqliteMigrations(db);
  return db;
}

describe("SQLite v12 durable event usage migration", () => {
  it("backfills exact UTF-8 payload bytes/counts and legacy lifecycle headroom above the new-node policy", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const claim = await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 10 });
    if (claim.status !== "claimed") throw new Error("claim expected");
    const raise = new Database(setup.path); raise.prepare("UPDATE execution_event_usage SET node_event_limit=100000,total_event_limit=1048576").run(); raise.close();
    let sequence = claim.claim.eventSequence;
    const append = async (event: any) => {
      const result = await setup.repository.appendLeasedEvent({ jobId: claim.claim.jobId, attemptId: claim.claim.attemptId, leaseToken: claim.claim.leaseToken, expectedSequence: sequence, event });
      if (result.status !== "appended") throw new Error(`append failed: ${result.status}`);
      sequence = result.execution.sequence;
    };
    await append({ schemaVersion: 1, type: "node.started", payload: { nodeId: "n" } });
    for (let index = 0; index < 4; index += 1) await append({ schemaVersion: 1, type: "node.logged", payload: { nodeId: "n", level: "info", message: "💥".repeat(3_300) } });
    setup.repository.close();
    const db = migrateFromV11(setup.path);
    const actual = db.prepare("SELECT SUM(length(CAST(payload_json AS BLOB))) AS total, SUM(CASE WHEN type LIKE 'node.%' THEN length(CAST(payload_json AS BLOB)) ELSE 0 END) AS node, COUNT(*) AS count FROM execution_events").get() as { total: number; node: number; count: number };
    const usage = db.prepare("SELECT total_event_bytes,node_event_bytes,total_event_limit,node_event_limit,event_count,event_count_limit FROM execution_event_usage").get() as Record<string, number>;
    expect(usage).toEqual({ total_event_bytes: actual.total, node_event_bytes: actual.node, total_event_limit: Math.max(2_097_152, actual.total + 262_144), node_event_limit: Math.max(49_152, actual.node + 49_152), event_count: actual.count, event_count_limit: Math.max(4_096, actual.count + 512) });
    expect(actual.node).toBeGreaterThan(49_152);
    db.close();
    const { SqliteDurableRuntimeRepository } = await import("@/lib/runtime/sqlite-runtime-repo");
    const repo = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: "0123456789abcdefZYXWVUTSRQPONMLK", clock: () => 111 });
    expect(await repo.recoverExpiredLeases({ limit: 1 })).toEqual({ status: "recovered", recovered: 1, retried: 1, deadLettered: 0 });
    repo.close();
  });

  it("backfills a valid near-10k lifecycle stream and preserves claim/recovery count headroom", async () => {
    const setup = await task4bFixture(); roots.push(setup.root); setup.repository.close();
    const db = new Database(setup.path);
    const baseRows = db.prepare("SELECT execution_id,seq,schema_version,attempt,type,at,payload_json FROM execution_events ORDER BY seq").all() as any[];
    const events = baseRows.map((row) => parseDurableExecutionEvent({ schemaVersion: row.schema_version, executionId: row.execution_id, sequence: row.seq, attempt: row.attempt, type: row.type, at: row.at, payload: JSON.parse(row.payload_json) }));
    const insert = db.prepare("INSERT INTO execution_events (execution_id,seq,schema_version,attempt,type,at,payload_json) VALUES ('execution',?,1,0,?,100,?)");
    for (let cycle = 0; cycle < 2_499; cycle += 1) {
      for (const [type, payload] of [["control.requested", { action: "pause" }], ["execution.paused", {}], ["control.requested", { action: "resume" }], ["execution.resumed", {}]] as const) {
        const event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: "execution", sequence: events.length + 1, attempt: 0, type, at: 100, payload });
        events.push(event); insert.run(event.sequence, event.type, JSON.stringify(event.payload));
      }
    }
    const projection = foldExecutionEvents(events);
    db.prepare("UPDATE durable_executions SET state='queued',desired_state='running',projected_event_seq=?,next_event_seq=?,projection_json=? WHERE id='execution'")
      .run(projection.sequence, projection.sequence + 1, canonicalDurableJson(projection, 256 * 1024).json);
    db.close();
    const migrated = migrateFromV11(setup.path);
    expect(migrated.prepare("SELECT event_count,event_count_limit FROM execution_event_usage").get()).toEqual({ event_count: 9_998, event_count_limit: 10_510 });
    migrated.close();
    const { SqliteDurableRuntimeRepository } = await import("@/lib/runtime/sqlite-runtime-repo");
    const repo = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: "0123456789abcdefZYXWVUTSRQPONMLK", clock: () => 100 });
    expect((await repo.claimNextJob({ workerId: "worker", leaseDurationMs: 10 })).status).toBe("no-job");
    expect((await repo.getExecution("owner", "execution"))?.state).toBe("failed");
    repo.close();
  }, 20_000);

  it("migrates the full legacy 10,002-event and post-batch byte edge, then policy-terminalizes recovery", async () => {
    const setup = await task4bFixture({ maxAttempts: 3 }); roots.push(setup.root);
    const claimed = await setup.repository.claimNextJob({ workerId: "legacy", leaseDurationMs: 10 });
    if (claimed.status !== "claimed") throw new Error("claim expected");
    setup.repository.close();
    const db = new Database(setup.path);
    const rows = db.prepare("SELECT execution_id,seq,schema_version,attempt,type,at,payload_json FROM execution_events ORDER BY seq").all() as any[];
    const events = rows.map((row) => parseDurableExecutionEvent({ schemaVersion: row.schema_version, executionId: row.execution_id, sequence: row.seq, attempt: row.attempt, type: row.type, at: row.at, payload: JSON.parse(row.payload_json) }));
    const insert = db.prepare("INSERT INTO execution_events (execution_id,seq,schema_version,attempt,type,at,payload_json) VALUES ('execution',?,1,1,?,100,?)");
    db.transaction(() => {
      const started = parseDurableExecutionEvent({ schemaVersion: 1, executionId: "execution", sequence: 5, attempt: 1, type: "node.started", at: 100, payload: { nodeId: "n" } });
      events.push(started); insert.run(started.sequence, started.type, JSON.stringify(started.payload));
      for (let sequence = 6; sequence <= 10_002; sequence += 1) {
        const logged = parseDurableExecutionEvent({ schemaVersion: 1, executionId: "execution", sequence, attempt: 1, type: "node.logged", at: 100, payload: { nodeId: "n", level: "info", message: "x".repeat(800) } });
        events.push(logged); insert.run(logged.sequence, logged.type, JSON.stringify(logged.payload));
      }
    })();
    const projection = foldExecutionEvents(events);
    db.prepare("UPDATE durable_executions SET projected_event_seq=?,next_event_seq=?,projection_json=? WHERE id='execution'")
      .run(projection.sequence, projection.sequence + 1, canonicalDurableJson(projection, 256 * 1024).json);
    const actual = db.prepare("SELECT SUM(length(CAST(payload_json AS BLOB))) AS total,COUNT(*) AS count FROM execution_events").get() as { total: number; count: number };
    expect(actual.count).toBe(10_002);
    expect(actual.total).toBeGreaterThan(8 * 1024 * 1024);
    expect(actual.total).toBeLessThanOrEqual(8 * 1024 * 1024 + 2 * 256 * 1024);
    removePostV16MigrationFixture(db);
    db.exec("DROP TRIGGER durable_executions_parent_owner_insert; DROP TRIGGER durable_executions_parent_owner_update; DROP TABLE execution_job_quarantine; DROP TABLE execution_event_usage; DELETE FROM schema_migrations WHERE version >= 12");
    runSqliteMigrations(db);
    expect(db.prepare("SELECT total_event_bytes,total_event_limit,event_count,event_count_limit FROM execution_event_usage").get())
      .toEqual({ total_event_bytes: actual.total, total_event_limit: actual.total + 256 * 1024, event_count: 10_002, event_count_limit: 10_514 });
    db.close();
    const { SqliteDurableRuntimeRepository } = await import("@/lib/runtime/sqlite-runtime-repo");
    const repo = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: "0123456789abcdefZYXWVUTSRQPONMLK", clock: () => 111 });
    expect(await repo.recoverExpiredLeases({ limit: 1 })).toEqual({ status: "recovered", recovered: 1, retried: 0, deadLettered: 0 });
    expect((await repo.getExecution("owner", "execution"))?.state).toBe("failed");
    repo.close();
  }, 30_000);

  it("detects normalized v12 schema drift", async () => {
    const setup = await task4bFixture(); roots.push(setup.root); setup.repository.close();
    const db = new Database(setup.path);
    db.exec("ALTER TABLE execution_event_usage RENAME TO execution_event_usage_old; CREATE TABLE execution_event_usage (execution_id TEXT PRIMARY KEY)");
    expect(() => runSqliteMigrations(db)).toThrow(/durable event usage.*mismatch/i);
    db.close();
  });
});
