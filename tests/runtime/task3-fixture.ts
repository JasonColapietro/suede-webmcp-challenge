import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { createDurableInvocation } from "@/lib/runtime/invocation";
import { createHash } from "node:crypto";
import { durableRuntimePolicyFingerprint } from "@/lib/runtime/durable-policy";

export const TEST_KEY = "0123456789abcdefZYXWVUTSRQPONMLK";
export function invocationFor(graph: Record<string, unknown>, execution = { ownerId: "owner", flowId: "flow", flowVersionId: "version" }) {
  const canonicalJson = JSON.stringify(Object.fromEntries(Object.entries(graph).sort(([a], [b]) => a.localeCompare(b))));
  const frozen = Object.freeze(JSON.parse(canonicalJson));
  const graphId = typeof frozen.id === "string" ? frozen.id : "fixture";
  const key = JSON.stringify(["root", graphId]);
  return createDurableInvocation({ executionPackage: Object.freeze({ schemaVersion: 1, rootKey: key, graphs: Object.freeze([Object.freeze({ key, identity: Object.freeze({ kind: "root" as const, graphId }), canonicalJson, byteLength: Buffer.byteLength(canonicalJson), contentHash: createHash("sha256").update(canonicalJson).digest("hex"), graph: frozen })]) }), execution, policyFingerprint: durableRuntimePolicyFingerprint() });
}

export function task3Fixture(): { root: string; path: string; repo: SqliteDurableRuntimeRepository; clock: { now: number } } {
  const root = mkdtempSync(join(tmpdir(), "durable-task3-"));
  const path = join(root, "runtime.db");
  const db = new Database(path);
  runSqliteMigrations(db);
  for (const index of [1, 2, 3, 4]) {
    const graph = JSON.stringify({ id: `root-${index}`, name: `Root ${index}`, nodes: [], edges: [], marker: index });
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, 'owner', ?, ?, 1)").run(`flow-${index}`, `Flow ${index}`, graph);
    db.prepare("INSERT INTO flow_versions (id, flow_id, version_number, schema_version, graph, semantic_hash, full_hash, created_by, created_at) VALUES (?, ?, 1, 1, ?, ?, ?, 'owner', 1)").run(`version-${index}`, `flow-${index}`, graph, "a".repeat(64), String(index).repeat(64));
  }
  db.close();
  const clock = { now: 10 };
  return { root, path, clock, repo: new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: TEST_KEY, clock: () => clock.now }) };
}

export function createInput(index: number, overrides: Record<string, unknown> = {}) {
  return {
    ownerId: "owner", executionId: `execution-${index}`, jobId: `job-${index}`,
    flowId: `flow-${index}`, flowVersionId: `version-${index}`,
    frozenDefinition: { id: `root-${index}`, name: `Root ${index}`, nodes: [], edges: [], marker: index }, definitionHash: String(index).repeat(64),
    trigger: { type: "api" as const }, priority: 0, availableAt: 10, maxAttempts: 2,
    costBudgetMicroUsdc: 0, tokenBudget: 0, createdAt: index,
    idempotency: { namespace: "run", key: `key-${index}`, expiresAt: 10_000 },
    invocation: invocationFor({ id: `root-${index}`, name: `Root ${index}`, nodes: [], edges: [], marker: index }, { ownerId: "owner", flowId: `flow-${index}`, flowVersionId: `version-${index}` }),
    ...overrides,
  };
}
