import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { invocationFor } from "./task3-fixture";

const VALID_GRAPH = { id: "root", name: "root", nodes: [], edges: [] };
const INVOCATION = invocationFor(VALID_GRAPH, { ownerId: "o", flowId: "f", flowVersionId: "v" });
import { foldExecutionEvents } from "@/lib/runtime/projection";
import type { DurableExecutionEventV1 } from "@/lib/runtime/types";

const roots: string[] = [];
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "durable-integrity-")); roots.push(root);
  const path = join(root, "db.sqlite"); const db = new Database(path); runSqliteMigrations(db);
  const graphJson = JSON.stringify(VALID_GRAPH);
  db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES ('f','o','F',?,1)").run(graphJson);
  db.prepare("INSERT INTO flow_versions (id, flow_id, version_number, schema_version, graph, semantic_hash, full_hash, created_by, created_at) VALUES ('v','f',1,1,?,?,?,'o',1)").run(graphJson, "a".repeat(64), "b".repeat(64)); db.close();
  const repo = new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: "0123456789abcdefZYXWVUTSRQPONMLK" });
  const create = () => repo.createExecution({ ownerId: "o", executionId: "e", jobId: "j", flowId: "f", flowVersionId: "v", frozenDefinition: VALID_GRAPH, definitionHash: "b".repeat(64), trigger: { type: "api" }, priority: 0, availableAt: 1, maxAttempts: 2, costBudgetMicroUsdc: 0, tokenBudget: 0, createdAt: 1, idempotency: { namespace: "n", key: "k", expiresAt: 10 }, invocation: INVOCATION });
  return { path, repo, create };
}

async function seedLongExecution(repo: SqliteDurableRuntimeRepository, path: string): Promise<void> {
  const db = new Database(path);
  const base = (await repo.listEvents("o", "e", 0, 10)) as DurableExecutionEventV1[];
  const events: DurableExecutionEventV1[] = [...base,
    { schemaVersion: 1, executionId: "e", sequence: 3, attempt: 1, type: "job.claimed", at: 2, payload: { jobId: "j", attemptId: "a1", workerId: "w", leaseExpiresAt: 20 } },
    { schemaVersion: 1, executionId: "e", sequence: 4, attempt: 1, type: "attempt.started", at: 2, payload: { attemptId: "a1" } },
    { schemaVersion: 1, executionId: "e", sequence: 5, attempt: 1, type: "node.started", at: 2, payload: { nodeId: "n" } },
  ];
  for (let index = 0; index < 1_001; index += 1) events.push({ schemaVersion: 1, executionId: "e", sequence: index + 6, attempt: 1, type: "node.logged", at: index + 3, payload: { nodeId: "n", level: "info", message: `log-${index}` } });
  const insert = db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => { for (const event of events.slice(2)) insert.run(event.executionId, event.sequence, 1, event.attempt, event.type, event.at, JSON.stringify(event.payload)); })();
  const projection = foldExecutionEvents(events);
  db.prepare("UPDATE durable_executions SET projected_event_seq = ?, next_event_seq = ?, projection_json = ? WHERE id = 'e'").run(projection.sequence, projection.sequence + 1, canonicalJson(projection));
  db.close();
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable event/projection transaction integrity", () => {
  it("owns a WAL/FK/bounded-timeout connection independent from inspectors", () => {
    const { repo, path } = setup();
    const db = new Database(path);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    const internal = (repo as unknown as { db: Database.Database }).db;
    expect(internal.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(internal.pragma("busy_timeout", { simple: true })).toBe(5_000);
    db.close(); repo.close();
  });

  it("allows an explicitly injected in-memory test connection without claiming WAL ownership", () => {
    const db = new Database(":memory:");
    const repo = new SqliteDurableRuntimeRepository(db, { idempotencyHashKey: "0123456789abcdefZYXWVUTSRQPONMLK" });
    expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    repo.close();
    expect(db.open).toBe(true);
    db.close();
  });

  it("refuses a persistent owned connection when WAL cannot be established", () => {
    const original = Database.prototype.pragma;
    const spy = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source: string, options?: unknown): unknown {
      if (source === "journal_mode = WAL") return "delete";
      return original.call(this, source, options as never);
    } as never);
    const root = mkdtempSync(join(tmpdir(), "durable-wal-")); roots.push(root);
    expect(() => new SqliteDurableRuntimeRepository(join(root, "db.sqlite"), { idempotencyHashKey: "0123456789abcdefZYXWVUTSRQPONMLK" })).toThrow(/WAL mode/i);
    spy.mockRestore();
  });

  it("appends an event and updates its projection in the same immediate transaction", async () => {
    const { repo, create } = setup(); await create();
    const claim = await repo.claimNextJob({ workerId: "w", leaseDurationMs: 10_000 });
    if (claim.status !== "claimed") throw new Error("expected claim");
    const result = await repo.appendLeasedEvent({ jobId: claim.claim.jobId, attemptId: claim.claim.attemptId, leaseToken: claim.claim.leaseToken, expectedSequence: 4, event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "n" } } });
    expect(result.status).toBe("appended");
    if (result.status === "appended") expect(result.execution).toMatchObject({ sequence: 5, state: "running", attemptId: claim.claim.attemptId });
    repo.close();
  });

  it("rejects expected-sequence drift without an event or projection write", async () => {
    const { repo, path, create } = setup(); await create();
    const claim = await repo.claimNextJob({ workerId: "w", leaseDurationMs: 10_000 }); if (claim.status !== "claimed") throw new Error("expected claim");
    expect((await repo.appendLeasedEvent({ jobId: claim.claim.jobId, attemptId: claim.claim.attemptId, leaseToken: claim.claim.leaseToken, expectedSequence: 3, event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "n" } } })).status).toBe("conflict");
    const db = new Database(path); expect(db.prepare("SELECT count(*) AS count FROM execution_events").get()).toEqual({ count: 4 }); db.close(); repo.close();
  });

  it("rolls back event insertion when projection folding fails", async () => {
    const { repo, path, create } = setup(); await create();
    const claim = await repo.claimNextJob({ workerId: "w", leaseDurationMs: 10_000 }); if (claim.status !== "claimed") throw new Error("expected claim");
    expect((await repo.appendLeasedEvent({ jobId: claim.claim.jobId, attemptId: claim.claim.attemptId, leaseToken: claim.claim.leaseToken, expectedSequence: 4, event: { schemaVersion: 1, type: "node.completed", payload: { nodeId: "n", output: {}, costMicroUsdc: 0, tokens: 0 } } })).status).toBe("refused");
    const db = new Database(path); expect(db.prepare("SELECT projected_event_seq, next_event_seq FROM durable_executions").get()).toEqual({ projected_event_seq: 4, next_event_seq: 5 }); db.close(); repo.close();
  });

  it("rebuilds a byte-identical projection from append-only events", async () => {
    const { repo, path, create } = setup(); await create();
    const rebuilt = await repo.rebuildProjection("o", "e");
    expect(rebuilt?.status).toBe("equal");
    const db = new Database(path); const stored = db.prepare("SELECT projection_json FROM durable_executions WHERE id = 'e'").get() as { projection_json: string };
    expect(rebuilt && rebuilt.status === "equal" ? rebuilt.projectionJson : null).toBe(stored.projection_json); db.close(); repo.close();
  });

  it("rebuilds complete valid streams beyond the public 1000-event page bound", async () => {
    const { repo, path, create } = setup(); await create();
    await seedLongExecution(repo, path);
    const rebuilt = await repo.rebuildProjection("o", "e");
    expect(rebuilt?.status).toBe("equal");
    expect(rebuilt?.projection.sequence).toBe(1_006);
    repo.close();
  });

  it("hydrates all pages and its owner row from one read snapshot", async () => {
    const { repo, path, create } = setup(); await create(); await seedLongExecution(repo, path);
    const internal = (repo as unknown as { db: Database.Database }).db;
    const originalPrepare = internal.prepare.bind(internal);
    const writer = new Database(path); writer.pragma("foreign_keys = ON");
    let page = 0;
    Object.defineProperty(internal, "prepare", { configurable: true, value: (sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("FROM execution_events WHERE execution_id") && sql.includes("seq > ?")) {
        const originalAll = statement.all.bind(statement);
        Object.defineProperty(statement, "all", { value: (...args: unknown[]) => {
          page += 1;
          if (page === 2) writer.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES ('e',1007,1,1,'node.logged',2000,?)").run(JSON.stringify({ nodeId: "n", level: "info", message: "concurrent" }));
          return originalAll(...args);
        } });
      }
      return statement;
    } });
    const hydrated = await repo.getExecution("o", "e");
    expect(hydrated?.sequence).toBe(1_006);
    expect(page).toBe(2);
    Object.defineProperty(internal, "prepare", { configurable: true, value: originalPrepare });
    writer.close(); repo.close();
  });

  it("rebuilds all pages and its materialized row from one read snapshot", async () => {
    const { repo, path, create } = setup(); await create(); await seedLongExecution(repo, path);
    const internal = (repo as unknown as { db: Database.Database }).db;
    const originalPrepare = internal.prepare.bind(internal);
    const writer = new Database(path); writer.pragma("foreign_keys = ON");
    let page = 0;
    Object.defineProperty(internal, "prepare", { configurable: true, value: (sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("FROM execution_events WHERE execution_id") && sql.includes("seq > ?")) {
        const originalAll = statement.all.bind(statement);
        Object.defineProperty(statement, "all", { value: (...args: unknown[]) => {
          page += 1;
          if (page === 2) writer.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES ('e',1007,1,1,'node.logged',2000,?)").run(JSON.stringify({ nodeId: "n", level: "info", message: "concurrent" }));
          return originalAll(...args);
        } });
      }
      return statement;
    } });
    const rebuilt = await repo.rebuildProjection("o", "e");
    expect(rebuilt?.status).toBe("equal");
    expect(rebuilt?.projection.sequence).toBe(1_006);
    expect(page).toBe(2);
    Object.defineProperty(internal, "prepare", { configurable: true, value: originalPrepare });
    writer.close(); repo.close();
  });

  it("fails closed on tampered materialized projections and returns deeply frozen hydrated projections", async () => {
    const { repo, path, create } = setup(); await create();
    const projection = await repo.getExecution("o", "e");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.nodes)).toBe(true);
    const db = new Database(path);
    db.prepare("UPDATE durable_executions SET projection_json = ? WHERE id = 'e'").run('{"tampered":true}');
    expect(await repo.getExecution("o", "e")).toBeNull();
    db.close(); repo.close();
  });

  it("enforces exact Task 1 byte and safe-integer boundaries in direct SQL", async () => {
    const { repo, path, create } = setup(); await create();
    const db = new Database(path);
    const insert = db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES ('e', ?, 1, 0, 'execution.paused', 1, ?)");
    expect(() => insert.run(3, `{"x":"${"a".repeat(262_136)}"}`)).not.toThrow();
    expect(() => insert.run(4, `{"x":"${"a".repeat(262_137)}"}`)).toThrow();
    expect(() => db.prepare("UPDATE durable_executions SET result_json = ? WHERE id = 'e'").run(`"${"a".repeat(131_070)}"`)).not.toThrow();
    expect(() => db.prepare("UPDATE durable_executions SET result_json = ? WHERE id = 'e'").run(`"${"a".repeat(131_071)}"`)).toThrow();
    expect(() => db.prepare("UPDATE durable_executions SET error_text = ? WHERE id = 'e'").run("a".repeat(8_192))).not.toThrow();
    expect(() => db.prepare("UPDATE durable_executions SET error_text = ? WHERE id = 'e'").run("a".repeat(8_193))).toThrow();
    const failed = db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES ('e', ?, 1, 0, 'execution.dead_lettered', 1, ?)");
    expect(() => failed.run(4, JSON.stringify({ error: "a".repeat(8_192) }))).not.toThrow();
    expect(() => failed.run(5, JSON.stringify({ error: "a".repeat(8_193) }))).toThrow();
    expect(() => db.exec("UPDATE durable_executions SET token_count = 1.5 WHERE id = 'e'")).toThrow();
    expect(() => db.exec("UPDATE durable_executions SET token_count = 9007199254740992 WHERE id = 'e'")).toThrow();
    db.close(); repo.close();
  });

  it("rolls back every creation row if a later job insert fails", async () => {
    const { repo, path, create } = setup(); await create();
    const result = await repo.createExecution({ ownerId: "o", executionId: "e2", jobId: "j", flowId: "f", flowVersionId: "v", frozenDefinition: VALID_GRAPH, definitionHash: "b".repeat(64), trigger: { type: "api" }, priority: 0, availableAt: 1, maxAttempts: 2, costBudgetMicroUsdc: 0, tokenBudget: 0, createdAt: 2, idempotency: { namespace: "n", key: "k2", expiresAt: 10 }, invocation: INVOCATION });
    expect(result.status).toBe("refused");
    const db = new Database(path);
    expect(db.prepare("SELECT count(*) AS count FROM durable_executions WHERE id = 'e2'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM execution_idempotency WHERE key_hash <> (SELECT key_hash FROM execution_idempotency LIMIT 1)").get()).toEqual({ count: 0 });
    db.close(); repo.close();
  });

  it("physically rejects event updates and deletes", async () => {
    const { repo, path, create } = setup(); await create();
    const db = new Database(path); db.pragma("foreign_keys = ON");
    expect(() => db.prepare("UPDATE execution_events SET at = 2 WHERE execution_id = 'e' AND seq = 1").run()).toThrow(/append-only/i);
    expect(() => db.prepare("DELETE FROM execution_events WHERE execution_id = 'e' AND seq = 1").run()).toThrow(/append-only/i);
    expect(db.prepare("SELECT count(*) AS count FROM execution_events WHERE execution_id = 'e'").get()).toEqual({ count: 2 });
    db.close(); repo.close();
  });

  it("rejects cross-execution and cross-owner lineage through direct SQL", async () => {
    const { repo, path, create } = setup(); await create();
    const second = await repo.createExecution({ ownerId: "o", executionId: "e2", jobId: "j2", flowId: "f", flowVersionId: "v", frozenDefinition: VALID_GRAPH, definitionHash: "b".repeat(64), trigger: { type: "api" }, priority: 0, availableAt: 2, maxAttempts: 2, costBudgetMicroUsdc: 0, tokenBudget: 0, createdAt: 2, idempotency: { namespace: "n", key: "k2", expiresAt: 10 }, invocation: INVOCATION });
    expect(second.status).toBe("created");
    const db = new Database(path); db.pragma("foreign_keys = ON");
    const insertAttempt = db.prepare("INSERT INTO execution_attempts (id, execution_id, job_id, attempt_number, worker_id, lease_token_hash, state, started_at, heartbeat_at) VALUES (?, ?, ?, 1, 'w', ?, 'leased', 3, 3)");
    expect(() => insertAttempt.run("bad-attempt", "e2", "j", "a".repeat(64))).toThrow(/foreign key/i);
    insertAttempt.run("a1", "e", "j", "a".repeat(64));
    const insertCheckpoint = db.prepare("INSERT INTO execution_checkpoints (id, execution_id, attempt_id, event_seq, state_json, state_hash, created_at) VALUES (?, ?, ?, ?, '{}', ?, 3)");
    expect(() => insertCheckpoint.run("bad-checkpoint", "e2", "a1", 2, "b".repeat(64))).toThrow(/foreign key/i);
    insertCheckpoint.run("c1", "e", "a1", 2, "b".repeat(64));
    expect(() => insertCheckpoint.run("eventless-checkpoint", "e", "a1", 999, "b".repeat(64))).toThrow(/foreign key/i);
    expect(() => db.prepare("UPDATE durable_executions SET parent_execution_id = 'e2', checkpoint_id = 'c1' WHERE id = 'e'").run()).toThrow(/foreign key/i);
    expect(() => db.prepare("INSERT INTO execution_idempotency (owner_id, namespace, key_hash, request_hash, execution_id, job_id, state, response_json, expires_at, committed_at) VALUES ('other','x',?,?, 'e2','j2','committed','{}',10,3)").run("c".repeat(64), "d".repeat(64))).toThrow(/owner mismatch/i);
    db.close(); repo.close();
  });

  it("rejects durable owner, flow, and immutable-version mismatches through direct SQL", async () => {
    const { repo, path, create } = setup(); await create();
    const db = new Database(path); db.pragma("foreign_keys = ON");
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES ('f2','o','F2','{}',1),('f3','other','F3','{}',1)").run();
    db.prepare("INSERT INTO flow_versions (id, flow_id, version_number, schema_version, graph, semantic_hash, full_hash, created_by, created_at) VALUES ('v2','f2',1,1,'{}',?,?,'o',1)").run("a".repeat(64), "b".repeat(64));
    expect(() => db.prepare("UPDATE durable_executions SET owner_id = 'other' WHERE id = 'e'").run()).toThrow(/foreign key/i);
    expect(() => db.prepare("UPDATE durable_executions SET flow_id = 'f2' WHERE id = 'e'").run()).toThrow(/foreign key/i);
    expect(() => db.prepare("UPDATE durable_executions SET flow_version_id = 'v2' WHERE id = 'e'").run()).toThrow(/foreign key/i);
    expect(() => db.prepare("UPDATE durable_executions SET flow_id = 'f3', flow_version_id = 'v2' WHERE id = 'e'").run()).toThrow(/foreign key/i);
    db.close(); repo.close();
  });
});
