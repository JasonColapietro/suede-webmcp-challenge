import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { canonicalDurableGraphJson } from "@/lib/runtime/durable-graph-audit";
import { enqueueDurableExecution } from "@/lib/runtime/enqueue";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { TEST_KEY } from "./task3-fixture";

export async function task4bFixture(options: { deadlineAt?: number; maxAttempts?: number; graph?: SupportedFlowGraph; triggerInput?: Readonly<Record<string, unknown>>; executionId?: string; jobId?: string; priority?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "durable-task4b-"));
  const path = join(root, "runtime.sqlite");
  const graph: SupportedFlowGraph = options.graph ?? { id: "root", name: "root", nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }], edges: [] };
  const graphJson = canonicalDurableGraphJson(graph);
  const db = new Database(path); runSqliteMigrations(db);
  db.prepare("INSERT INTO flows (id,owner_id,name,graph,updated_at) VALUES ('flow','owner','Flow',?,1)").run(graphJson);
  db.prepare("INSERT INTO flow_versions (id,flow_id,version_number,schema_version,graph,semantic_hash,full_hash,created_by,created_at) VALUES ('version','flow',1,1,?,?,?,'owner',1)").run(graphJson, "c".repeat(64), "d".repeat(64)); db.close();
  const clock = { now: 100 };
  const repository = new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: TEST_KEY, clock: () => clock.now });
  const result = await enqueueDurableExecution({ repository, ownerId: "owner", flowId: "flow", flowVersionId: "version", definitionHash: "d".repeat(64), graph, triggerInput: options.triggerInput ?? { hello: "world" }, trigger: { type: "api" }, idempotency: { namespace: "run", key: `key-${options.executionId ?? "execution"}`, expiresAt: 10_000 }, executionId: options.executionId ?? "execution", jobId: options.jobId ?? "job", priority: options.priority, availableAt: 100, maxAttempts: options.maxAttempts ?? 3, createdAt: 100, ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }) });
  if (result.status !== "created") throw new Error(`fixture enqueue failed: ${JSON.stringify(result)}`);
  return { root, path, graph, clock, repository };
}
