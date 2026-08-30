import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { canonicalDurableJson } from "@/lib/runtime/invocation";
import { parseDurableExecutionEvent } from "@/lib/runtime/event-schema";
import { foldExecutionEvents } from "@/lib/runtime/projection";
import { enqueueDurableExecution } from "@/lib/runtime/enqueue";
import { runWorkerTick } from "@/lib/runtime/worker";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import type { DurableJobClaim } from "@/lib/runtime/repository";
import { task4bFixture } from "./task4b-fixture";
import { removePostV16MigrationFixture } from "../helpers/sqlite-migration-fixture";
import { TEST_KEY } from "./task3-fixture";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function claim(setup: Awaited<ReturnType<typeof task4bFixture>>, workerId = "worker"): Promise<DurableJobClaim> {
  const result = await setup.repository.claimNextJob({ workerId, leaseDurationMs: 100 });
  if (result.status !== "claimed") throw new Error(`claim expected, received ${result.status}`);
  return result.claim;
}

function usage(path: string, executionId = "execution") {
  const db = new Database(path);
  const row = db.prepare(
    "SELECT total_event_bytes,node_event_bytes,total_event_limit,node_event_limit,event_count,event_count_limit FROM execution_event_usage WHERE execution_id=?",
  ).get(executionId) as Record<string, number>;
  db.close();
  return row;
}

async function enqueueFollowing(setup: Awaited<ReturnType<typeof task4bFixture>>) {
  const result = await enqueueDurableExecution({
    repository: setup.repository,
    ownerId: "owner",
    flowId: "flow",
    flowVersionId: "version",
    definitionHash: "d".repeat(64),
    graph: setup.graph,
    trigger: { type: "api" },
    idempotency: { namespace: "run", key: "following", expiresAt: 10_000 },
    executionId: "execution-following",
    jobId: "job-following",
    priority: 0,
    availableAt: 100,
    maxAttempts: 2,
    createdAt: 100,
  });
  expect(result.status).toBe("created");
}

async function enqueueNamed(setup: Awaited<ReturnType<typeof task4bFixture>>, suffix: string, priority: number) {
  return enqueueDurableExecution({
    repository: setup.repository,
    ownerId: "owner",
    flowId: "flow",
    flowVersionId: "version",
    definitionHash: "d".repeat(64),
    graph: setup.graph,
    trigger: { type: "api" },
    idempotency: { namespace: "run", key: `key-${suffix}`, expiresAt: 10_000 },
    executionId: `execution-${suffix}`,
    jobId: `job-${suffix}`,
    priority,
    availableAt: 100,
    maxAttempts: 2,
    createdAt: 100,
  });
}

describe("durable event usage adversarial budgets", () => {
  it("v11 to v12 backfills exact UTF-8 usage while preserving every existing v10/v11 schema object", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const leased = await claim(setup);
    const appended = await setup.repository.appendLeasedEvent({
      ...leased,
      expectedSequence: leased.eventSequence,
      event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "多字节💥" } },
    });
    expect(appended.status).toBe("appended");
    setup.repository.close();

    const db = new Database(setup.path);
    removePostV16MigrationFixture(db);
    db.exec(`
      DROP TRIGGER durable_executions_parent_owner_insert;
      DROP TRIGGER durable_executions_parent_owner_update;
      DROP TABLE execution_job_quarantine;
      DROP TABLE execution_event_usage;
      DROP TABLE connection_slots;
      DROP TABLE connections;
      DELETE FROM schema_migrations WHERE version >= 12;
    `);
    const before = db.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY type,name",
    ).all();
    const actual = db.prepare(
      "SELECT SUM(length(CAST(payload_json AS BLOB))) AS total, SUM(CASE WHEN type LIKE 'node.%' THEN length(CAST(payload_json AS BLOB)) ELSE 0 END) AS node, COUNT(*) AS count FROM execution_events WHERE execution_id='execution'",
    ).get() as { total: number; node: number; count: number };
    expect(actual.node).toBe(Buffer.byteLength('{"nodeId":"多字节💥"}', "utf8"));

    runSqliteMigrations(db);
    const after = db.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','execution_event_usage','execution_job_quarantine','idx_execution_job_quarantine_execution','execution_job_quarantine_no_update','execution_job_quarantine_no_delete','durable_executions_parent_owner_insert','durable_executions_parent_owner_update') ORDER BY type,name",
    ).all();
    const legacyNames = new Set(before.map((row) => (row as { name: string }).name));
    expect(after.filter((row) => legacyNames.has((row as { name: string }).name))).toEqual(before);
    expect(db.prepare(
      "SELECT total_event_bytes,node_event_bytes,event_count,total_event_limit,node_event_limit,event_count_limit FROM execution_event_usage WHERE execution_id='execution'",
    ).get()).toEqual({
      total_event_bytes: actual.total,
      node_event_bytes: actual.node,
      event_count: actual.count,
      total_event_limit: Math.max(2 * 1024 * 1024, actual.total + 256 * 1024),
      node_event_limit: actual.node + 48 * 1024,
      event_count_limit: Math.max(4_096, actual.count + 512),
    });
    db.close();
  });

  it("gives a populated near-old-ceiling history per-row count headroom without lowering its existing ceiling", async () => {
    const setup = await task4bFixture(); roots.push(setup.root); setup.repository.close();
    const db = new Database(setup.path);
    removePostV16MigrationFixture(db);
    db.exec("DROP TRIGGER durable_executions_parent_owner_insert; DROP TRIGGER durable_executions_parent_owner_update; DROP TABLE execution_job_quarantine; DROP TABLE execution_event_usage; DELETE FROM schema_migrations WHERE version >= 12");
    const baseRows = db.prepare(
      "SELECT execution_id,seq,schema_version,attempt,type,at,payload_json FROM execution_events ORDER BY seq",
    ).all() as Array<{ execution_id: string; seq: number; schema_version: number; attempt: number; type: string; at: number; payload_json: string }>;
    const events = baseRows.map((row) => parseDurableExecutionEvent({
      schemaVersion: row.schema_version,
      executionId: row.execution_id,
      sequence: row.seq,
      attempt: row.attempt,
      type: row.type,
      at: row.at,
      payload: JSON.parse(row.payload_json),
    }));
    const insert = db.prepare(
      "INSERT INTO execution_events (execution_id,seq,schema_version,attempt,type,at,payload_json) VALUES ('execution',?,1,0,?,100,?)",
    );
    for (let cycle = 0; cycle < 2_499; cycle += 1) {
      for (const [type, payload] of [
        ["control.requested", { action: "pause" }], ["execution.paused", {}],
        ["control.requested", { action: "resume" }], ["execution.resumed", {}],
      ] as const) {
        const event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: "execution", sequence: events.length + 1, attempt: 0, type, at: 100, payload });
        events.push(event);
        insert.run(event.sequence, event.type, JSON.stringify(event.payload));
      }
    }
    const projection = foldExecutionEvents(events);
    db.prepare(
      "UPDATE durable_executions SET state='queued',desired_state='running',projected_event_seq=?,next_event_seq=?,projection_json=? WHERE id='execution'",
    ).run(projection.sequence, projection.sequence + 1, canonicalDurableJson(projection, 256 * 1024).json);
    runSqliteMigrations(db);
    expect(db.prepare("SELECT event_count,event_count_limit FROM execution_event_usage WHERE execution_id='execution'").get())
      .toEqual({ event_count: 9_998, event_count_limit: 10_510 });
    db.close();
  }, 20_000);

  it("skips a counter-tampered head and completes the following valid job", async () => {
    const setup = await task4bFixture({ priority: 100 }); roots.push(setup.root);
    await enqueueFollowing(setup);
    const db = new Database(setup.path);
    db.prepare("UPDATE execution_event_usage SET total_event_bytes=total_event_bytes+1 WHERE execution_id='execution'").run();
    db.close();

    expect(await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 }))
      .toEqual({ status: "completed", executionId: "execution-following" });
    const inspect = new Database(setup.path);
    expect(inspect.prepare("SELECT state,attempt_count FROM execution_jobs WHERE id='job'").get()).toEqual({ state: "ready", attempt_count: 0 });
    expect(inspect.prepare("SELECT state FROM execution_jobs WHERE id='job-following'").get()).toEqual({ state: "completed" });
    inspect.close(); setup.repository.close();
  });

  it("quarantines more than one claim page of invalid heads and lets a valid row progress after restart", async () => {
    const setup = await task4bFixture({ priority: 0 }); roots.push(setup.root);
    for (let index = 0; index < 101; index += 1) {
      expect((await enqueueNamed(setup, `bad-${index}`, 1_000 + index)).status).toBe("created");
    }
    const db = new Database(setup.path);
    db.prepare("UPDATE execution_event_usage SET total_event_bytes=total_event_bytes+1 WHERE execution_id LIKE 'execution-bad-%'").run();
    db.close();
    expect(await setup.repository.claimNextJob({ workerId: "first", leaseDurationMs: 100 })).toEqual({ status: "refused" });
    const afterFirst = new Database(setup.path);
    expect(afterFirst.prepare("SELECT COUNT(*) AS count FROM execution_job_quarantine").get()).toEqual({ count: 100 });
    expect(afterFirst.prepare("SELECT COUNT(*) AS count FROM execution_jobs WHERE id LIKE 'job-bad-%' AND state='ready' AND attempt_count=0").get()).toEqual({ count: 101 });
    afterFirst.close(); setup.repository.close();

    const restarted = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: TEST_KEY, clock: () => 100 });
    const claimed = await restarted.claimNextJob({ workerId: "second", leaseDurationMs: 100 });
    expect(claimed.status).toBe("claimed");
    if (claimed.status === "claimed") expect(claimed.claim.executionId).toBe("execution");
    const afterRestart = new Database(setup.path);
    expect(afterRestart.prepare("SELECT COUNT(*) AS count FROM execution_job_quarantine").get()).toEqual({ count: 101 });
    expect(afterRestart.prepare("SELECT DISTINCT reason FROM execution_job_quarantine").all()).toEqual([{ reason: "durable_event_usage_mismatch" }]);
    expect(() => afterRestart.prepare("UPDATE execution_job_quarantine SET reason='invalid_durable_invocation'").run()).toThrow(/append-only/i);
    expect(() => afterRestart.prepare("DELETE FROM execution_job_quarantine").run()).toThrow(/append-only/i);
    afterRestart.close(); restarted.close();
  }, 30_000);

  it("rolls an append transaction back without changing events, projection, or usage", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const leased = await claim(setup);
    const db = new Database(setup.path);
    const snapshot = () => ({
      events: db.prepare("SELECT seq,type,payload_json FROM execution_events ORDER BY seq").all(),
      projection: db.prepare("SELECT state,next_event_seq,projected_event_seq,projection_json FROM durable_executions").get(),
      usage: db.prepare("SELECT * FROM execution_event_usage").get(),
    });
    const before = snapshot();
    db.exec("CREATE TRIGGER reject_usage_update BEFORE UPDATE ON execution_event_usage BEGIN SELECT RAISE(ABORT, 'injected usage write failure'); END");
    expect(await setup.repository.appendLeasedEvent({
      ...leased,
      expectedSequence: leased.eventSequence,
      event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "rollback" } },
    })).toEqual({ status: "refused" });
    expect(snapshot()).toEqual(before);
    db.close(); setup.repository.close();
  });

  it("returns budget-exhausted atomically and worker policy terminalizes that job while a following job still completes", async () => {
    const direct = await task4bFixture(); roots.push(direct.root);
    const leased = await claim(direct);
    const started = await direct.repository.appendLeasedEvent({
      ...leased,
      expectedSequence: leased.eventSequence,
      event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "cumulative" } },
    });
    if (started.status !== "appended") throw new Error(`started append expected, received ${started.status}`);
    const logged = await direct.repository.appendLeasedEvent({
      ...leased,
      expectedSequence: started.execution.sequence,
      event: { schemaVersion: 1, type: "node.logged", payload: { nodeId: "cumulative", level: "info", message: "💥".repeat(2_000) } },
    });
    if (logged.status !== "appended") throw new Error(`log append expected, received ${logged.status}`);
    const directBefore = usage(direct.path);
    const lower = new Database(direct.path);
    lower.prepare("UPDATE execution_event_usage SET node_event_limit=node_event_bytes WHERE execution_id='execution'").run();
    lower.close();
    expect(await direct.repository.appendLeasedEvent({
      ...leased,
      expectedSequence: logged.execution.sequence,
      event: { schemaVersion: 1, type: "node.completed", payload: { nodeId: "cumulative", output: { value: "cannot-fit" }, costMicroUsdc: 0, tokens: 0 } },
    })).toEqual({ status: "budget-exhausted" });
    const directAfter = usage(direct.path);
    expect({ ...directAfter, node_event_limit: directBefore.node_event_limit }).toEqual(directBefore);
    direct.repository.close();

    const worker = await task4bFixture({ priority: 100 }); roots.push(worker.root);
    await enqueueFollowing(worker);
    const db = new Database(worker.path);
    db.prepare("UPDATE execution_event_usage SET node_event_limit=node_event_bytes WHERE execution_id='execution'").run();
    db.close();
    expect(await runWorkerTick({ repository: worker.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 }))
      .toEqual({ status: "failed", executionId: "execution" });
    const terminal = new Database(worker.path);
    expect(terminal.prepare("SELECT state,lease_token_hash FROM execution_jobs WHERE id='job'").get()).toEqual({ state: "completed", lease_token_hash: null });
    expect(terminal.prepare("SELECT type,payload_json FROM execution_events WHERE execution_id='execution' ORDER BY seq DESC LIMIT 1").get())
      .toEqual({ type: "execution.failed", payload_json: '{"costMicroUsdc":0,"error":"durable_policy_refused","tokens":0}' });
    terminal.close();
    expect(await runWorkerTick({ repository: worker.repository, workerId: "worker-2", leaseDurationMs: 100, heartbeatIntervalMs: 10 }))
      .toEqual({ status: "completed", executionId: "execution-following" });
    worker.repository.close();
  });

  it("reserves count headroom for lifecycle terminalization instead of admitting more node work", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const leased = await claim(setup);
    const db = new Database(setup.path);
    db.prepare("UPDATE execution_event_usage SET event_count_limit=event_count+512 WHERE execution_id='execution'").run();
    db.close();
    expect(await setup.repository.appendLeasedEvent({
      ...leased,
      expectedSequence: leased.eventSequence,
      event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "reserved" } },
    })).toEqual({ status: "budget-exhausted" });
    expect((await setup.repository.failAttempt({ ...leased, classification: "policy", error: "durable_policy_refused" })).status).toBe("failed");
    const terminal = new Database(setup.path);
    expect(terminal.prepare("SELECT type FROM execution_events ORDER BY seq DESC LIMIT 1").get()).toEqual({ type: "execution.failed" });
    terminal.close(); setup.repository.close();
  });

  it("turns a retry into a stable policy terminal when nonterminal lifecycle headroom is exhausted", async () => {
    const setup = await task4bFixture({ maxAttempts: 100 }); roots.push(setup.root);
    const leased = await claim(setup);
    const db = new Database(setup.path);
    db.prepare("UPDATE execution_event_usage SET event_count_limit=event_count+512 WHERE execution_id='execution'").run();
    db.close();
    expect((await setup.repository.failAttempt({ ...leased, classification: "transient", error: "retryable" })).status).toBe("failed");
    const terminal = new Database(setup.path);
    expect(terminal.prepare("SELECT state,attempt_count,last_error FROM execution_jobs").get())
      .toEqual({ state: "completed", attempt_count: 1, last_error: "durable_policy_refused" });
    expect(terminal.prepare("SELECT type,payload_json FROM execution_events ORDER BY seq DESC LIMIT 1").get())
      .toEqual({ type: "execution.failed", payload_json: '{"costMicroUsdc":0,"error":"durable_policy_refused","tokens":0}' });
    terminal.close(); setup.repository.close();
  });

  it("refuses nonterminal resume at the exact reserve boundary but still applies terminal cancel", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    expect((await setup.repository.controlExecution("owner", "execution", "pause")).status).toBe("applied");
    const db = new Database(setup.path);
    db.prepare("UPDATE execution_event_usage SET total_event_limit=total_event_bytes+262144,event_count_limit=event_count+512 WHERE execution_id='execution'").run();
    const before = {
      execution: db.prepare("SELECT state,desired_state,projected_event_seq,projection_json FROM durable_executions").get(),
      job: db.prepare("SELECT state,attempt_count FROM execution_jobs").get(),
      events: db.prepare("SELECT seq,type,payload_json FROM execution_events ORDER BY seq").all(),
      usage: db.prepare("SELECT * FROM execution_event_usage").get(),
    };
    db.close();
    expect(await setup.repository.controlExecution("owner", "execution", "resume")).toEqual({ status: "refused" });
    const unchanged = new Database(setup.path);
    expect({
      execution: unchanged.prepare("SELECT state,desired_state,projected_event_seq,projection_json FROM durable_executions").get(),
      job: unchanged.prepare("SELECT state,attempt_count FROM execution_jobs").get(),
      events: unchanged.prepare("SELECT seq,type,payload_json FROM execution_events ORDER BY seq").all(),
      usage: unchanged.prepare("SELECT * FROM execution_event_usage").get(),
    }).toEqual(before);
    unchanged.close();
    expect((await setup.repository.controlExecution("owner", "execution", "cancel")).status).toBe("applied");
    const terminal = new Database(setup.path);
    expect(terminal.prepare("SELECT state,desired_state FROM durable_executions").get()).toEqual({ state: "cancelled", desired_state: "cancelled" });
    expect(terminal.prepare("SELECT state,attempt_count FROM execution_jobs").get()).toEqual({ state: "cancelled", attempt_count: 0 });
    expect(terminal.prepare("SELECT type FROM execution_events ORDER BY seq DESC LIMIT 2").all()).toEqual([{ type: "execution.cancelled" }, { type: "control.requested" }]);
    terminal.close(); setup.repository.close();
  });

  it("lets leased pause settlement enter the reserve at the exact byte/count boundary, including expiry recovery", async () => {
    for (const mode of ["cooperative", "recovery"] as const) {
      const setup = await task4bFixture(); roots.push(setup.root);
      const leased = await claim(setup);
      const db = new Database(setup.path);
      const current = db.prepare("SELECT total_event_bytes,event_count FROM execution_event_usage WHERE execution_id='execution'").get() as { total_event_bytes: number; event_count: number };
      const controlBytes = Buffer.byteLength('{"action":"pause"}', "utf8");
      db.prepare("UPDATE execution_event_usage SET total_event_limit=?,event_count_limit=? WHERE execution_id='execution'")
        .run(current.total_event_bytes + 256 * 1024 + controlBytes, current.event_count + 512 + 1);
      db.close();
      expect((await setup.repository.controlExecution("owner", "execution", "pause")).status).toBe("applied");
      if (mode === "cooperative") {
        expect((await setup.repository.pauseAttempt(leased)).status).toBe("appended");
      } else {
        setup.clock.now = leased.leaseExpiresAt;
        expect(await setup.repository.recoverExpiredLeases({ limit: 1 }))
          .toEqual({ status: "recovered", recovered: 1, retried: 0, deadLettered: 0 });
      }
      const paused = new Database(setup.path);
      expect(paused.prepare("SELECT state,desired_state FROM durable_executions").get()).toEqual({ state: "paused", desired_state: "paused" });
      expect(paused.prepare("SELECT state FROM execution_jobs").get()).toEqual({ state: "retry" });
      paused.close(); setup.repository.close();
    }
  });

  it("keeps cumulative counters across retry and expired-lease recovery", async () => {
    const setup = await task4bFixture({ maxAttempts: 3 }); roots.push(setup.root);
    const first = await claim(setup, "first");
    const appended = await setup.repository.appendLeasedEvent({
      ...first,
      expectedSequence: first.eventSequence,
      event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "first-node" } },
    });
    expect(appended.status).toBe("appended");
    expect((await setup.repository.failAttempt({ ...first, classification: "transient", error: "retry" })).status).toBe("retry-scheduled");
    const afterRetry = usage(setup.path);
    const availableDb = new Database(setup.path);
    const availableAt = (availableDb.prepare("SELECT available_at FROM execution_jobs").get() as { available_at: number }).available_at;
    availableDb.close();
    setup.clock.now = availableAt;
    const second = await claim(setup, "second");
    expect(second.totalEventBytes).toBe(usage(setup.path).total_event_bytes);
    expect(second.nodeEventBytes).toBe(afterRetry.node_event_bytes);
    setup.clock.now = second.leaseExpiresAt;
    expect(await setup.repository.recoverExpiredLeases({ limit: 1 })).toEqual({ status: "recovered", recovered: 1, retried: 1, deadLettered: 0 });
    const afterRecovery = usage(setup.path);
    expect(afterRecovery.total_event_bytes).toBeGreaterThan(afterRetry.total_event_bytes);
    expect(afterRecovery.node_event_bytes).toBe(afterRetry.node_event_bytes);
    const nextAvailableDb = new Database(setup.path);
    setup.clock.now = (nextAvailableDb.prepare("SELECT available_at FROM execution_jobs").get() as { available_at: number }).available_at;
    nextAvailableDb.close();
    const third = await claim(setup, "third");
    expect(third.totalEventBytes).toBe(usage(setup.path).total_event_bytes);
    expect(third.totalEventBytes).toBeGreaterThan(afterRecovery.total_event_bytes);
    expect(third.nodeEventBytes).toBe(afterRecovery.node_event_bytes);
    setup.repository.close();
  });
});
