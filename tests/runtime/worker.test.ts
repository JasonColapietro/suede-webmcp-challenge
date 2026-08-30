import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { canonicalDurableGraphJson } from "@/lib/runtime/durable-graph-audit";
import { enqueueDurableExecution } from "@/lib/runtime/enqueue";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { runWorkerTick } from "@/lib/runtime/worker";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { TEST_KEY } from "./task3-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function inputGraph(id = "child"): SupportedFlowGraph {
  return { id, name: id, nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }], edges: [] };
}

async function fixture(closure = false) {
  const rootDir = mkdtempSync(join(tmpdir(), "durable-worker-")); roots.push(rootDir);
  const path = join(rootDir, "runtime.sqlite");
  const child = inputGraph();
  const graph: SupportedFlowGraph = closure
    ? { id: "root", name: "root", nodes: [{ id: "sub", type: "subflow", params: { flowId: "child" }, position: { x: 0, y: 0 } }], edges: [] }
    : inputGraph("root");
  const db = new Database(path); runSqliteMigrations(db);
  const graphJson = canonicalDurableGraphJson(graph);
  db.prepare("INSERT INTO flows (id,owner_id,name,graph,updated_at) VALUES ('flow','owner','Flow',?,1)").run(graphJson);
  db.prepare("INSERT INTO flow_versions (id,flow_id,version_number,schema_version,graph,semantic_hash,full_hash,created_by,created_at) VALUES ('version','flow',1,1,?,?,?,'owner',1)").run(graphJson, "c".repeat(64), "d".repeat(64));
  db.close();
  const clock = { now: 100 };
  const repository = new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: TEST_KEY, clock: () => clock.now });
  const loadSubflow = vi.fn(async () => child);
  const enqueued = await enqueueDurableExecution({
    repository, ownerId: "owner", flowId: "flow", flowVersionId: "version", definitionHash: "d".repeat(64), graph,
    ...(closure ? { resolvers: { loadSubflow } } : {}), triggerInput: { hello: "world" }, trigger: { type: "api" },
    idempotency: { namespace: "run", key: "key", expiresAt: 10_000 }, executionId: "execution", jobId: "job",
    availableAt: 100, maxAttempts: 3, createdAt: 100,
  });
  expect(enqueued.status).toBe("created");
  return { path, graph, child, repository, clock, loadSubflow };
}

describe("durable whole-run worker", () => {
  it("claims one job, maps exact engine events, and completes zero-cost output", async () => {
    const setup = await fixture();
    const result = await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 });
    expect(result).toEqual({ status: "completed", executionId: "execution" });
    const db = new Database(setup.path);
    expect(db.prepare("SELECT seq,type FROM execution_events ORDER BY seq").all()).toEqual([
      { seq: 1, type: "execution.created" }, { seq: 2, type: "job.enqueued" },
      { seq: 3, type: "job.claimed" }, { seq: 4, type: "attempt.started" },
      { seq: 5, type: "node.started" }, { seq: 6, type: "node.completed" },
      { seq: 7, type: "execution.succeeded" },
    ]);
    expect(db.prepare("SELECT state FROM execution_jobs").get()).toEqual({ state: "completed" });
    expect(db.prepare("SELECT cost_micro_usdc,token_count FROM durable_executions").get()).toEqual({ cost_micro_usdc: 0, token_count: 0 });
    db.close(); setup.repository.close();
  });

  it("executes only persisted root, trigger, variables, and closure after every live source changes", async () => {
    const setup = await fixture(true);
    expect(setup.loadSubflow).toHaveBeenCalledTimes(1);
    (setup.child.nodes[0] as { type: string }).type = "http";
    (setup.graph.nodes[0] as { params: unknown }).params = { flowId: "other" };
    setup.loadSubflow.mockImplementation(async () => { throw new Error("live resolver must not run"); });
    const db = new Database(setup.path);
    db.prepare("UPDATE flow_versions SET graph = ? WHERE id = 'version'").run(JSON.stringify({ id: "edited", nodes: [] }));
    db.close();
    expect(await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 }))
      .toEqual({ status: "completed", executionId: "execution" });
    expect(setup.loadSubflow).toHaveBeenCalledTimes(1);
    setup.repository.close();
  });

  it("never claims a migrated legacy row whose invocation snapshot is absent", async () => {
    const setup = await fixture();
    const db = new Database(setup.path);
    db.exec("DROP TRIGGER execution_invocations_no_delete; DELETE FROM execution_invocations"); db.close();
    expect(await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 100 })).toEqual({ status: "no-job" });
    setup.repository.close();
  });

  it("refuses a tampered invocation before mutating the ready job", async () => {
    const setup = await fixture();
    const db = new Database(setup.path);
    db.exec("DROP TRIGGER execution_invocations_no_update");
    db.prepare("UPDATE execution_invocations SET snapshot_hash = ?").run("f".repeat(64)); db.close();
    expect(await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 100 })).toEqual({ status: "refused" });
    const inspect = new Database(setup.path);
    expect(inspect.prepare("SELECT state,attempt_count FROM execution_jobs").get()).toEqual({ state: "ready", attempt_count: 0 });
    inspect.close(); setup.repository.close();
  });

  it("skips a mirror-tampered head job without mutation and progresses the following verified invocation", async () => {
    const setup = await fixture();
    const second = await enqueueDurableExecution({ repository: setup.repository, ownerId: "owner", flowId: "flow", flowVersionId: "version", definitionHash: "d".repeat(64), graph: setup.graph, trigger: { type: "api" }, idempotency: { namespace: "run", key: "second", expiresAt: 10_000 }, executionId: "execution-2", jobId: "job-2", availableAt: 100, maxAttempts: 2, createdAt: 100 });
    expect(second.status).toBe("created");
    const db = new Database(setup.path);
    db.prepare("UPDATE execution_jobs SET priority = 100 WHERE id = 'job'").run();
    db.prepare("UPDATE durable_executions SET frozen_definition_json = ? WHERE id = 'execution'").run(JSON.stringify({ id: "other", name: "other", nodes: [], edges: [] }));
    db.close();
    expect(await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 })).toEqual({ status: "completed", executionId: "execution-2" });
    const inspect = new Database(setup.path);
    expect(inspect.prepare("SELECT state,attempt_count FROM execution_jobs WHERE id='job'").get()).toEqual({ state: "ready", attempt_count: 0 });
    expect(inspect.prepare("SELECT count(*) AS count FROM execution_attempts WHERE execution_id='execution'").get()).toEqual({ count: 0 });
    expect(inspect.prepare("SELECT count(*) AS count FROM execution_events WHERE execution_id='execution'").get()).toEqual({ count: 2 });
    inspect.close(); setup.repository.close();
  });
});
