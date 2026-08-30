import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { task4bFixture } from "./task4b-fixture";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { TEST_KEY } from "./task3-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable v3 control boundary", () => {
  it("refuses retry for foreign and nonterminal sources without parsing or mutation", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    expect(await setup.repository.retryExecution({ ownerId: "foreign", sourceExecutionId: "execution", executionId: "child", jobId: "child-job", idempotencyKey: "retry", expiresAt: 1_000 }))
      .toEqual({ status: "not-found" });
    expect(await setup.repository.retryExecution({ ownerId: "owner", sourceExecutionId: "execution", executionId: "child", jobId: "child-job", idempotencyKey: "retry", expiresAt: 1_000 }))
      .toEqual({ status: "conflict" });
    const db = new Database(setup.path);
    expect((db.prepare("SELECT count(*) AS n FROM durable_executions").get() as { n: number }).n).toBe(1);
    db.close(); setup.repository.close();
  });

  it("atomically clones exact immutable bytes and policy into one child lineage", async () => {
    const setup = await task4bFixture({ deadlineAt: 600, maxAttempts: 4 }); roots.push(setup.root);
    expect((await setup.repository.controlExecution("owner", "execution", "cancel")).status).toBe("applied");
    const inspect = new Database(setup.path);
    const before = inspect.prepare(`SELECT x.deployment_id, x.environment_id, x.frozen_definition_json, x.definition_hash, x.cost_budget_micro_usdc, x.token_budget,
      x.deadline_at, x.created_at, i.snapshot_json, i.snapshot_hash, j.priority, j.max_attempts,
      u.total_event_limit, u.node_event_limit, u.event_count_limit
      FROM durable_executions x JOIN execution_invocations i ON i.execution_id=x.id JOIN execution_jobs j ON j.execution_id=x.id
      JOIN execution_event_usage u ON u.execution_id=x.id WHERE x.id='execution'`).get();
    const sourceQueries = [
      "SELECT * FROM durable_executions WHERE id='execution'", "SELECT * FROM execution_jobs WHERE execution_id='execution'",
      "SELECT * FROM execution_invocations WHERE execution_id='execution'", "SELECT * FROM execution_event_usage WHERE execution_id='execution'",
      "SELECT * FROM execution_events WHERE execution_id='execution' ORDER BY seq", "SELECT * FROM execution_attempts WHERE execution_id='execution' ORDER BY attempt_number",
      "SELECT * FROM execution_checkpoints WHERE execution_id='execution' ORDER BY event_seq", "SELECT * FROM execution_job_quarantine WHERE execution_id='execution' ORDER BY rowid",
    ];
    const sourceSnapshot = sourceQueries.map((query) => JSON.stringify(inspect.prepare(query).all()));
    const result = await setup.repository.retryExecution({ ownerId: "owner", sourceExecutionId: "execution", executionId: "child", jobId: "child-job", idempotencyKey: "retry-key", expiresAt: 1_000 });
    expect(result.status).toBe("created");
    const child = inspect.prepare(`SELECT x.parent_execution_id, x.trigger_type, x.trigger_id, x.deployment_id, x.environment_id, x.frozen_definition_json, x.definition_hash,
      x.cost_budget_micro_usdc, x.token_budget, x.deadline_at, x.created_at, i.snapshot_json, i.snapshot_hash, j.priority, j.max_attempts,
      u.total_event_limit, u.node_event_limit, u.event_count_limit
      FROM durable_executions x JOIN execution_invocations i ON i.execution_id=x.id JOIN execution_jobs j ON j.execution_id=x.id
      JOIN execution_event_usage u ON u.execution_id=x.id WHERE x.id='child'`).get() as Record<string, unknown>;
    expect(child).toMatchObject({ parent_execution_id: "execution", trigger_type: "retry", trigger_id: "execution", deadline_at: 600, created_at: 100 });
    const { parent_execution_id: _parent, trigger_type: _trigger, trigger_id: _triggerId, ...childPolicy } = child;
    expect(childPolicy).toEqual(before);
    expect(inspect.prepare("SELECT seq,type FROM execution_events WHERE execution_id='child' ORDER BY seq").all()).toEqual([
      { seq: 1, type: "execution.created" }, { seq: 2, type: "job.enqueued" },
    ]);
    expect(inspect.prepare("SELECT state,attempt_count FROM execution_jobs WHERE execution_id='child'").get()).toEqual({ state: "ready", attempt_count: 0 });
    expect(inspect.prepare("SELECT state FROM durable_executions WHERE id='execution'").get()).toEqual({ state: "cancelled" });
    expect(sourceQueries.map((query) => JSON.stringify(inspect.prepare(query).all()))).toEqual(sourceSnapshot);
    inspect.close(); setup.repository.close();
  });

  it("deduplicates concurrent retry and lets an expired key create a fresh child", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    expect((await setup.repository.controlExecution("owner", "execution", "cancel")).status).toBe("applied");
    const other = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: TEST_KEY, clock: () => setup.clock.now });
    const [a, b] = await Promise.all([
      setup.repository.retryExecution({ ownerId: "owner", sourceExecutionId: "execution", executionId: "child-a", jobId: "job-a", idempotencyKey: "same", expiresAt: 110 }),
      other.retryExecution({ ownerId: "owner", sourceExecutionId: "execution", executionId: "child-b", jobId: "job-b", idempotencyKey: "same", expiresAt: 110 }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["created", "duplicate"]);
    setup.clock.now = 111;
    expect((await setup.repository.retryExecution({ ownerId: "owner", sourceExecutionId: "execution", executionId: "child-c", jobId: "job-c", idempotencyKey: "same", expiresAt: 200 })).status).toBe("created");
    const db = new Database(setup.path);
    expect((db.prepare("SELECT count(*) AS n FROM durable_executions WHERE parent_execution_id='execution'").get() as { n: number }).n).toBe(2);
    expect(JSON.stringify(db.prepare("SELECT * FROM execution_idempotency").all())).not.toContain("same");
    db.close(); other.close(); setup.repository.close();
  });

  it("enforces same-owner parent lineage for insert and update", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const db = new Database(setup.path);
    db.prepare("INSERT INTO flows (id,owner_id,name,graph,updated_at) VALUES ('foreign-flow','foreign','Foreign','{}',1)").run();
    expect(() => db.prepare(`INSERT INTO durable_executions
      (id,owner_id,flow_id,flow_version_id,parent_execution_id,frozen_definition_json,definition_hash,trigger_type,state,desired_state,next_event_seq,projected_event_seq,projection_json,cost_micro_usdc,token_count,cost_budget_micro_usdc,token_budget,attempt_number,created_at,updated_at)
      SELECT 'foreign-child','foreign',flow_id,flow_version_id,'execution',frozen_definition_json,definition_hash,'retry','queued','running',next_event_seq,projected_event_seq,projection_json,0,0,0,0,0,created_at,updated_at FROM durable_executions WHERE id='execution'`).run()).toThrow(/parent owner mismatch/i);
    expect((await setup.repository.controlExecution("owner", "execution", "cancel")).status).toBe("applied");
    expect((await setup.repository.retryExecution({ ownerId: "owner", sourceExecutionId: "execution", executionId: "owned-child", jobId: "owned-child-job", idempotencyKey: "parent-update", expiresAt: 1_000 })).status).toBe("created");
    expect(() => db.prepare("UPDATE durable_executions SET owner_id='foreign' WHERE id='execution'").run()).toThrow(/parent owner mismatch/i);
    db.close(); setup.repository.close();
  });

  it("refuses a terminal materialized-state lie over a nonterminal event projection", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const db = new Database(setup.path);
    db.prepare("UPDATE durable_executions SET state='failed', finished_at=100 WHERE id='execution'").run();
    expect(await setup.repository.retryExecution({ ownerId: "owner", sourceExecutionId: "execution", executionId: "child", jobId: "job", idempotencyKey: "drift", expiresAt: 1_000 }))
      .toEqual({ status: "refused" });
    expect((db.prepare("SELECT count(*) AS n FROM durable_executions").get() as { n: number }).n).toBe(1);
    db.close(); setup.repository.close();
  });
});
