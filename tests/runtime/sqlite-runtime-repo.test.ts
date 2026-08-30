import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { invocationFor } from "./task3-fixture";

const EXECUTION_IDENTITY = { ownerId: "owner-1", flowId: "flow-1", flowVersionId: "version-1" };
const ROOT_GRAPH = { id: "root", name: "root", nodes: [], edges: [], meta: { a: 1, b: 2 } };
const INVOCATION = invocationFor(ROOT_GRAPH, EXECUTION_IDENTITY);

const roots: string[] = [];

function fixture(): { path: string; repo: SqliteDurableRuntimeRepository; inspect: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "durable-runtime-"));
  roots.push(root);
  const path = join(root, "runtime.db");
  const seed = new Database(path);
  runSqliteMigrations(seed);
  const graph = '{"id":"root","name":"root","nodes":[],"edges":[],"meta":{"a":1,"b":2}}';
  seed.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)").run("flow-1", "owner-1", "Flow", graph, 1);
  seed.prepare("INSERT INTO flow_versions (id, flow_id, version_number, schema_version, graph, semantic_hash, full_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("version-1", "flow-1", 1, 1, graph, "a".repeat(64), "c".repeat(64), "owner-1", 1);
  seed.close();
  return { path, repo: new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: "0123456789abcdefZYXWVUTSRQPONMLK" }), inspect: new Database(path) };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: "owner-1",
    executionId: "execution-1",
    jobId: "job-1",
    flowId: "flow-1",
    flowVersionId: "version-1",
    frozenDefinition: { id: "root", name: "root", nodes: [], edges: [], meta: { b: 2, a: 1 } },
    definitionHash: "c".repeat(64),
    trigger: { type: "api" as const },
    priority: 7,
    availableAt: 100,
    maxAttempts: 3,
    costBudgetMicroUsdc: 0,
    tokenBudget: 10,
    createdAt: 100,
    idempotency: { namespace: "durable-run", key: "secret-key", expiresAt: 1_000 },
    invocation: INVOCATION,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteDurableRuntimeRepository", () => {
  it("atomically creates reservation, execution, ready job, and exact first two events", async () => {
    const { repo, inspect } = fixture();
    const result = await repo.createExecution(request());
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.execution).toMatchObject({ executionId: "execution-1", sequence: 2, state: "queued", jobId: "job-1" });
    }
    expect(inspect.prepare("SELECT state, next_event_seq, projected_event_seq FROM durable_executions").get()).toEqual({ state: "queued", next_event_seq: 3, projected_event_seq: 2 });
    expect(inspect.prepare("SELECT state, priority, available_at FROM execution_jobs").get()).toEqual({ state: "ready", priority: 7, available_at: 100 });
    expect(inspect.prepare("SELECT seq, type FROM execution_events ORDER BY seq").all()).toEqual([
      { seq: 1, type: "execution.created" },
      { seq: 2, type: "job.enqueued" },
    ]);
    repo.close(); inspect.close();
  });

  it("returns duplicate for the same scoped key/request and conflict for changed request", async () => {
    const { repo, inspect } = fixture();
    expect((await repo.createExecution(request())).status).toBe("created");
    expect((await repo.createExecution(request({ executionId: "execution-2", jobId: "job-2" }))).status).toBe("duplicate");
    expect((await repo.createExecution(request({ executionId: "execution-3", jobId: "job-3", tokenBudget: 11 }))).status).toBe("conflict");
    const changedSnapshot = JSON.parse(INVOCATION.json); changedSnapshot.triggerInput = { changed: true };
    const changedJson = JSON.stringify(changedSnapshot);
    expect((await repo.createExecution(request({ invocation: { json: changedJson, hash: createHash("sha256").update(changedJson).digest("hex") } }))).status).toBe("conflict");
    expect(inspect.prepare("SELECT count(*) AS count FROM durable_executions").get()).toEqual({ count: 1 });
    const stored = inspect.prepare("SELECT key_hash, response_json FROM execution_idempotency").get() as { key_hash: string; response_json: string };
    expect(stored.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.key_hash).not.toBe(createHash("sha256").update("secret-key").digest("hex"));
    expect(stored.key_hash).not.toBe(createHmac("sha256", "0123456789abcdefZYXWVUTSRQPONMLK").update("secret-key").digest("hex"));
    expect(JSON.stringify(stored)).not.toContain("secret-key");
    repo.close(); inspect.close();
  });

  it("requires an immutable version owned through the requested flow and owner", async () => {
    const { repo, inspect } = fixture();
    expect((await repo.createExecution(request({ ownerId: "owner-2" }))).status).toBe("refused");
    expect((await repo.createExecution(request({ ownerId: "owner-2", invocation: invocationFor(ROOT_GRAPH, { ...EXECUTION_IDENTITY, ownerId: "owner-2" }) }))).status).toBe("not-found");
    expect((await repo.createExecution(request({ flowVersionId: "draft" }))).status).toBe("refused");
    expect(inspect.prepare("SELECT count(*) AS count FROM durable_executions").get()).toEqual({ count: 0 });
    repo.close(); inspect.close();
  });

  it("refuses caller definition or hash drift from the authoritative immutable version before writes", async () => {
    const { repo, inspect } = fixture();
    expect((await repo.createExecution(request({ frozenDefinition: { nodes: [] } }))).status).toBe("refused");
    expect((await repo.createExecution(request({ definitionHash: "d".repeat(64) }))).status).toBe("refused");
    expect(inspect.prepare("SELECT count(*) AS count FROM durable_executions").get()).toEqual({ count: 0 });
    repo.close(); inspect.close();
  });

  it("refuses weak HMAC material and separates persisted key hashes by purpose", () => {
    const root = mkdtempSync(join(tmpdir(), "durable-key-")); roots.push(root);
    const path = join(root, "runtime.db");
    expect(() => new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: "short" })).toThrow(/hash key/i);
    expect(() => new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: "x".repeat(64) })).toThrow(/hash key/i);
  });

  it("rejects payload and budget bounds before writing", async () => {
    const { repo, inspect } = fixture();
    expect((await repo.createExecution(request({ frozenDefinition: { body: "x".repeat(300_000) } }))).status).toBe("refused");
    expect((await repo.createExecution(request({ costBudgetMicroUsdc: -1 }))).status).toBe("refused");
    expect((await repo.createExecution(request({ tokenBudget: Number.MAX_SAFE_INTEGER + 1 }))).status).toBe("refused");
    expect(inspect.prepare("SELECT count(*) AS count FROM durable_executions").get()).toEqual({ count: 0 });
    repo.close(); inspect.close();
  });

  it("canonicalizes definition and event payload JSON", async () => {
    const { repo, inspect } = fixture();
    await repo.createExecution(request());
    expect((inspect.prepare("SELECT frozen_definition_json FROM durable_executions").get() as { frozen_definition_json: string }).frozen_definition_json).toBe('{"edges":[],"id":"root","meta":{"a":1,"b":2},"name":"root","nodes":[]}');
    expect((inspect.prepare("SELECT payload_json FROM execution_events WHERE seq = 2").get() as { payload_json: string }).payload_json).toBe('{"availableAt":100,"jobId":"job-1","priority":7}');
    repo.close(); inspect.close();
  });

  it("accepts an authoritative canonical definition at the exact 256 KiB edge", async () => {
    const { repo, inspect } = fixture();
    const empty = { id: "root", name: "root", nodes: [], edges: [], x: "" };
    const body = "a".repeat(262_144 - Buffer.byteLength(JSON.stringify(empty)));
    const graph = { ...empty, x: body };
    inspect.prepare("UPDATE flow_versions SET graph = ?, full_hash = ? WHERE id = 'version-1'").run(JSON.stringify(graph), "d".repeat(64));
    const result = await repo.createExecution(request({ frozenDefinition: graph, definitionHash: "d".repeat(64), invocation: invocationFor(graph, EXECUTION_IDENTITY) }));
    expect(result.status).toBe("created");
    expect(Buffer.byteLength((inspect.prepare("SELECT frozen_definition_json FROM durable_executions").get() as { frozen_definition_json: string }).frozen_definition_json)).toBe(262_144);
    repo.close(); inspect.close();
  });

  it("strictly owner-scopes projection and event reads before returning data", async () => {
    const { repo, inspect } = fixture();
    await repo.createExecution(request());
    expect(await repo.getExecution("owner-2", "execution-1")).toBeNull();
    expect(await repo.listEvents("owner-2", "execution-1", 0, 10)).toEqual([]);
    expect((await repo.getExecution("owner-1", "execution-1"))?.sequence).toBe(2);
    expect((await repo.listEvents("owner-1", "execution-1", 1, 10)).map((event) => event.sequence)).toEqual([2]);
    repo.close(); inspect.close();
  });
});
