import Database from "better-sqlite3";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type { FlowGraph } from "@/lib/flow/types";

const graph = (id: string): FlowGraph => ({
  id,
  name: `Graph ${id}`,
  nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
});

function makeRepo(): { db: Database.Database; repo: SqliteProjectRepo } {
  const db = new Database(":memory:");
  return { db, repo: new SqliteProjectRepo(db) };
}

function seedFlow(
  db: Database.Database,
  input: { id: string; ownerId: string; graphId: string },
): void {
  db.prepare(
    `INSERT INTO flows (id, owner_id, name, graph, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.id, input.ownerId, "Legacy flow", JSON.stringify(graph(input.graphId)), 1);
}

describe("SqliteProjectRepo personal hierarchy", () => {
  it("creates exactly one complete hierarchy on first access", async () => {
    const { db, repo } = makeRepo();

    const context = await repo.ensurePersonalContext("owner-1");

    expect(context.organization.personalOwnerId).toBe("owner-1");
    expect(context.organization.kind).toBe("personal");
    expect(context.workspace.slug).toBe("personal");
    expect(context.project.slug).toBe("my-project");
    expect(context.workbook.slug).toBe("main");
    expect(context.environments.map((environment) => [environment.slug, environment.kind])).toEqual([
      ["draft", "draft"],
      ["test", "test"],
      ["live", "live"],
    ]);
    expect(
      db.prepare(
        `SELECT
          (SELECT COUNT(*) FROM organizations) AS organizations,
          (SELECT COUNT(*) FROM workspaces) AS workspaces,
          (SELECT COUNT(*) FROM projects) AS projects,
          (SELECT COUNT(*) FROM workbooks) AS workbooks,
          (SELECT COUNT(*) FROM environments) AS environments`,
      ).get(),
    ).toEqual({ organizations: 1, workspaces: 1, projects: 1, workbooks: 1, environments: 3 });
  });

  it("returns the same persisted IDs through duplicate calls on independent connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "suede-project-context-"));
    const path = join(directory, "studio.db");
    let inspection: Database.Database | undefined;
    try {
      const firstRepo = new SqliteProjectRepo(path);
      const secondRepo = new SqliteProjectRepo(path);

      const [first, second] = await Promise.all([
        firstRepo.ensurePersonalContext("owner-1"),
        secondRepo.ensurePersonalContext("owner-1"),
      ]);
      const reopenedRepo = new SqliteProjectRepo(path);
      const reopened = await reopenedRepo.ensurePersonalContext("owner-1");
      inspection = new Database(path, { readonly: true });

      expect(second).toEqual(first);
      expect(reopened).toEqual(first);
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM organizations").get()).toEqual({
        count: 1,
      });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({
        count: 1,
      });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
        count: 1,
      });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM workbooks").get()).toEqual({
        count: 1,
      });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM environments").get()).toEqual({
        count: 3,
      });
    } finally {
      inspection?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("waits for a competing writer transaction before ensuring context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "suede-project-contention-"));
    const path = join(directory, "studio.db");
    let worker: Worker | undefined;
    try {
      const repo = new SqliteProjectRepo(path);
      const require = createRequire(import.meta.url);
      worker = new Worker(
        `
          const { parentPort, workerData } = require("node:worker_threads");
          const Database = require(workerData.databaseModulePath);
          const db = new Database(workerData.databasePath);
          db.exec("BEGIN IMMEDIATE");
          parentPort.postMessage("locked");
          setTimeout(() => {
            db.exec("COMMIT");
            db.close();
            parentPort.postMessage("released");
          }, workerData.holdMilliseconds);
        `,
        {
          eval: true,
          workerData: {
            databaseModulePath: require.resolve("better-sqlite3"),
            databasePath: path,
            holdMilliseconds: 250,
          },
        },
      );
      const exit = once(worker, "exit");
      const [message] = await once(worker, "message");
      expect(message).toBe("locked");

      const startedAt = performance.now();
      const context = await repo.ensurePersonalContext("owner-contended");
      const waitedMilliseconds = performance.now() - startedAt;

      expect(context.organization.personalOwnerId).toBe("owner-contended");
      expect(waitedMilliseconds).toBeGreaterThanOrEqual(150);
      expect(await exit).toEqual([0]);
      expect(await repo.ensurePersonalContext("owner-contended")).toEqual(context);
    } finally {
      await worker?.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates projects, workbooks, environments, and lookups by owner", async () => {
    const { repo } = makeRepo();
    const alice = await repo.ensurePersonalContext("alice");
    const bob = await repo.ensurePersonalContext("bob");

    expect(bob.organization.id).not.toBe(alice.organization.id);
    expect(bob.workspace.id).not.toBe(alice.workspace.id);
    expect(bob.project.id).not.toBe(alice.project.id);
    expect(bob.workbook.id).not.toBe(alice.workbook.id);
    expect(bob.environments.map((environment) => environment.id)).not.toEqual(
      alice.environments.map((environment) => environment.id),
    );
    expect(await repo.getProject(alice.project.id, "bob")).toBeNull();
    expect(await repo.getWorkbook(alice.workbook.id, "bob")).toBeNull();
    expect(await repo.getEnvironment(alice.environments[0].id, "bob")).toBeNull();
    expect(await repo.listWorkbooks(alice.project.id, "bob")).toEqual([]);
    expect(await repo.listEnvironments(alice.project.id, "bob")).toEqual([]);
    expect(await repo.listProjects("alice")).toEqual([alice.project]);
    expect(await repo.listProjects("bob")).toEqual([bob.project]);
  });
});

describe("SqliteProjectRepo legacy-flow binding", () => {
  it("binds an existing flow without changing its row ID or graph ID", async () => {
    const { db, repo } = makeRepo();
    seedFlow(db, { id: "flow-row-1", ownerId: "owner-1", graphId: "graph-contract-1" });
    const before = db.prepare("SELECT id, graph FROM flows WHERE id = ?").get("flow-row-1");
    const context = await repo.ensurePersonalContext("owner-1");

    const binding = await repo.bindFlow("flow-row-1", context);

    expect(binding).toEqual({
      flowId: "flow-row-1",
      projectId: context.project.id,
      workbookId: context.workbook.id,
      createdAt: expect.any(Number),
    });
    expect(db.prepare("SELECT id, graph FROM flows WHERE id = ?").get("flow-row-1")).toEqual(before);
    expect(JSON.parse((before as { graph: string }).graph)).toMatchObject({ id: "graph-contract-1" });
    expect(await repo.getFlowContext("flow-row-1", "owner-1")).toMatchObject({
      project: context.project,
      workbook: context.workbook,
      binding,
    });
  });

  it("checks flow ownership without parsing graph data or distinguishing wrong-owner from missing", async () => {
    const { db, repo } = makeRepo();
    db.prepare(
      "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("flow-corrupt-ownership", "alice", "Corrupt", "not-json", 1);

    expect(await repo.ownsFlow("flow-corrupt-ownership", "alice")).toBe(true);
    expect(await repo.ownsFlow("flow-corrupt-ownership", "bob")).toBe(false);
    expect(await repo.ownsFlow("missing-flow", "bob")).toBe(false);
  });

  it("cannot rebind or read a flow through another owner's hierarchy", async () => {
    const { db, repo } = makeRepo();
    seedFlow(db, { id: "flow-alice", ownerId: "alice", graphId: "graph-alice" });
    const alice = await repo.ensurePersonalContext("alice");
    const bob = await repo.ensurePersonalContext("bob");
    const original = await repo.bindFlow("flow-alice", alice);

    expect(await repo.bindFlow("flow-alice", bob)).toBeNull();
    expect(await repo.getFlowContext("flow-alice", "bob")).toBeNull();
    expect(await repo.getFlowContext("flow-alice", "alice")).toMatchObject({ binding: original });
  });

  it("fails closed for a missing flow without creating a binding", async () => {
    const { db, repo } = makeRepo();
    const context = await repo.ensurePersonalContext("owner-1");

    expect(await repo.bindFlow("missing", context)).toBeNull();
    expect(await repo.getFlowContext("missing", "owner-1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get()).toEqual({ count: 0 });
  });

  it("keeps the owner hierarchy when a legacy flow and its binding are deleted", async () => {
    const { db, repo } = makeRepo();
    seedFlow(db, { id: "flow-row-1", ownerId: "owner-1", graphId: "graph-1" });
    const context = await repo.ensurePersonalContext("owner-1");
    await repo.bindFlow("flow-row-1", context);

    db.transaction(() => {
      db.prepare("DELETE FROM flow_project_bindings WHERE flow_id = ?").run("flow-row-1");
      db.prepare("DELETE FROM flows WHERE id = ?").run("flow-row-1");
    })();

    expect(await repo.getFlowContext("flow-row-1", "owner-1")).toBeNull();
    expect(await repo.ensurePersonalContext("owner-1")).toEqual(context);
    expect(await repo.getProject(context.project.id, "owner-1")).toEqual(context.project);
  });

  it("keeps legacy SqliteRepo deletion compatible after a flow is bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "suede-project-delete-"));
    const path = join(directory, "studio.db");
    try {
      const legacyRepo = new SqliteRepo(path);
      const projectRepo = new SqliteProjectRepo(path);
      const flow = await legacyRepo.saveFlow({
        ownerId: "owner-1",
        name: "Legacy flow",
        graph: graph("graph-1"),
      });
      const context = await projectRepo.ensurePersonalContext("owner-1");
      await projectRepo.bindFlow(flow.id, context);

      expect(await legacyRepo.deleteFlow(flow.id, "owner-1")).toBe(true);
      expect(await legacyRepo.getFlow(flow.id)).toBeNull();
      const inspection = new Database(path, { readonly: true });
      try {
        expect(
          inspection.prepare("SELECT id FROM workbook_flow_tabs WHERE flow_id = ?").get(flow.id),
        ).toBeUndefined();
      } finally {
        inspection.close();
      }
      expect(await projectRepo.ensurePersonalContext("owner-1")).toEqual(context);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // 2026-08-09 deliberate pin rewrite: deploy-on-launch gives EVERY launched
  // flow a version + deployment, so the old "a version blocks flow deletion"
  // contract would have made launched flows undeletable through the public
  // API (tests/compat/public-api-v0.test.ts pins delete-after-launch working).
  // deleteFlow now cascades version/deployment/binding history in the same
  // transaction. Flows with durable_executions rows remain restricted (that
  // FK still has no cascade, by design — execution audit trail).
  it("cascades version and binding history when deleting a versioned flow", async () => {
    const directory = mkdtempSync(join(tmpdir(), "suede-project-delete-rollback-"));
    const path = join(directory, "studio.db");
    let inspection: Database.Database | undefined;
    try {
      const legacyRepo = new SqliteRepo(path);
      const projectRepo = new SqliteProjectRepo(path);
      const flow = await legacyRepo.saveFlow({
        ownerId: "owner-1",
        name: "Versioned flow",
        graph: graph("graph-1"),
      });
      const context = await projectRepo.ensurePersonalContext("owner-1");
      await projectRepo.bindFlow(flow.id, context);
      const agent = await legacyRepo.createAgent({
        flowId: flow.id,
        slug: "versioned-flow",
      });
      await legacyRepo.upsertSchedule({ agentId: agent.id, cron: "0 * * * *", enabled: true });
      const run = await legacyRepo.createRun({
        flowId: flow.id,
        agentId: agent.id,
        trigger: "manual",
      });
      await legacyRepo.appendStep({
        runId: run.id,
        nodeId: "input",
        nodeType: "input",
        status: "done",
        costUsdc: 0,
      });
      inspection = new Database(path);
      inspection.pragma("foreign_keys = ON");
      inspection.prepare(
        `INSERT INTO flow_versions
          (id, flow_id, version_number, schema_version, graph, semantic_hash,
           full_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "version-1",
        flow.id,
        1,
        1,
        JSON.stringify(graph("graph-1")),
        "semantic",
        "full",
        "owner-1",
        1,
      );

      await expect(legacyRepo.deleteFlow(flow.id, "owner-1")).resolves.toBe(true);

      expect(await legacyRepo.getFlow(flow.id)).toBeNull();
      expect(await projectRepo.getFlowContext(flow.id, "owner-1")).toBeNull();
      expect(inspection.prepare("SELECT id FROM agents WHERE flow_id = ?").all(flow.id)).toEqual([]);
      expect(
        inspection.prepare("SELECT agent_id FROM schedules WHERE agent_id = ?").all(agent.id),
      ).toEqual([]);
      expect(inspection.prepare("SELECT id FROM runs WHERE flow_id = ?").all(flow.id)).toEqual([]);
      expect(
        inspection.prepare("SELECT run_id FROM run_steps WHERE run_id = ?").all(run.id),
      ).toEqual([]);
      expect(
        inspection
          .prepare("SELECT flow_id FROM flow_project_bindings WHERE flow_id = ?")
          .get(flow.id),
      ).toBeUndefined();
      expect(
        inspection.prepare("SELECT flow_id FROM workbook_flow_tabs WHERE flow_id = ?").get(flow.id),
      ).toBeUndefined();
      expect(
        inspection.prepare("SELECT id FROM flow_versions WHERE flow_id = ?").get(flow.id),
      ).toBeUndefined();
    } finally {
      inspection?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
