import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type { PersonalContext, WorkbookRecord } from "@/lib/projects/types";

function makeRepo(): { db: Database.Database; repo: SqliteProjectRepo } {
  const db = new Database(":memory:");
  return { db, repo: new SqliteProjectRepo(db) };
}

function insertFlow(
  db: Database.Database,
  input: { id: string; ownerId: string; name: string },
): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.id,
    input.ownerId,
    input.name,
    JSON.stringify({ id: `graph-${input.id}`, nodes: [], edges: [] }),
    1,
  );
}

function addWorkbook(
  db: Database.Database,
  context: PersonalContext,
  id: string,
): WorkbookRecord {
  db.prepare(
    `INSERT INTO workbooks (id, project_id, name, slug, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, context.project.id, `Workbook ${id}`, id, 1, 2);
  return {
    id,
    projectId: context.project.id,
    name: `Workbook ${id}`,
    slug: id,
    position: 1,
    createdAt: 2,
  };
}

async function bind(
  db: Database.Database,
  repo: SqliteProjectRepo,
  context: PersonalContext,
  input: { id: string; name: string; workbook?: WorkbookRecord },
) {
  insertFlow(db, { id: input.id, ownerId: context.organization.personalOwnerId, name: input.name });
  const targetContext = input.workbook ? { ...context, workbook: input.workbook } : context;
  const binding = await repo.bindFlow(input.id, targetContext);
  if (!binding) throw new Error("fixture binding failed");
  return binding;
}

function rawTabs(db: Database.Database): unknown[] {
  return db.prepare("SELECT * FROM workbook_flow_tabs ORDER BY workbook_id, position, id").all();
}

describe("SqliteProjectRepo workbook tabs", () => {
  it("distinguishes an owned empty workbook from missing and wrong-owner workbooks", async () => {
    const { repo } = makeRepo();
    const alice = await repo.ensurePersonalContext("alice");
    const bob = await repo.ensurePersonalContext("bob");

    expect(await repo.listWorkbookTabs({ workbookId: alice.workbook.id, ownerId: "alice" })).toEqual([]);
    expect(await repo.listWorkbookTabs({ workbookId: "missing", ownerId: "alice" })).toBeNull();
    expect(await repo.listWorkbookTabs({ workbookId: alice.workbook.id, ownerId: "bob" })).toBeNull();
    expect(await repo.listWorkbookTabs({ workbookId: bob.workbook.id, ownerId: "alice" })).toBeNull();
  });

  it("creates binding and ordered tab together with deterministic title policy and maps public rows", async () => {
    const { db, repo } = makeRepo();
    const context = await repo.ensurePersonalContext("owner-1");
    const first = await bind(db, repo, context, { id: "flow-1", name: "First flow" });
    const second = await bind(db, repo, context, { id: "flow-2", name: "  Second flow  " });
    await bind(db, repo, context, { id: "flow-3", name: "   " });

    const tabs = await repo.listWorkbookTabs({ workbookId: context.workbook.id, ownerId: "owner-1" });

    expect(tabs).toEqual([
      {
        id: expect.any(String),
        workbookId: context.workbook.id,
        flowId: "flow-1",
        title: "Main",
        position: 0,
        createdAt: first.createdAt,
        updatedAt: first.createdAt,
      },
      {
        id: expect.any(String),
        workbookId: context.workbook.id,
        flowId: "flow-2",
        title: "Second flow",
        position: 1,
        createdAt: second.createdAt,
        updatedAt: second.createdAt,
      },
      expect.objectContaining({ flowId: "flow-3", title: "Flow 3", position: 2 }),
    ]);
    expect(new Set(tabs?.map((tab) => tab.id)).size).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get()).toEqual({ count: 3 });
  });

  it("trims rename, preserves membership and position, and rejects forged or foreign-owner targets", async () => {
    const { db, repo } = makeRepo();
    const alice = await repo.ensurePersonalContext("alice");
    const aliceSecondWorkbook = addWorkbook(db, alice, "alice-second");
    await bind(db, repo, alice, { id: "flow-a", name: "A" });
    await bind(db, repo, alice, { id: "flow-b", name: "B", workbook: aliceSecondWorkbook });
    const first = (await repo.listWorkbookTabs({ workbookId: alice.workbook.id, ownerId: "alice" }))![0];
    const other = (await repo.listWorkbookTabs({ workbookId: aliceSecondWorkbook.id, ownerId: "alice" }))![0];
    const flowBefore = db.prepare("SELECT * FROM flows WHERE id = ?").get("flow-a");
    const bindingBefore = db.prepare("SELECT * FROM flow_project_bindings WHERE flow_id = ?").get("flow-a");

    const renamed = await repo.renameWorkbookTab({
      workbookId: alice.workbook.id,
      tabId: first.id,
      ownerId: "alice",
      title: "  Renamed  ",
    });

    expect(renamed).toEqual({ ...first, title: "Renamed", updatedAt: expect.any(Number) });
    expect(renamed!.position).toBe(first.position);
    expect(renamed!.createdAt).toBe(first.createdAt);
    expect(renamed!.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(db.prepare("SELECT * FROM flows WHERE id = ?").get("flow-a")).toEqual(flowBefore);
    expect(db.prepare("SELECT * FROM flow_project_bindings WHERE flow_id = ?").get("flow-a")).toEqual(bindingBefore);
    expect(
      await repo.renameWorkbookTab({
        workbookId: alice.workbook.id,
        tabId: other.id,
        ownerId: "alice",
        title: "Forged",
      }),
    ).toBeNull();
    expect(
      await repo.renameWorkbookTab({
        workbookId: alice.workbook.id,
        tabId: first.id,
        ownerId: "bob",
        title: "Foreign",
      }),
    ).toBeNull();
  });

  it("reorders only an exact unique current ID set and writes contiguous positions with one timestamp", async () => {
    const { db, repo } = makeRepo();
    const context = await repo.ensurePersonalContext("owner-1");
    await bind(db, repo, context, { id: "flow-1", name: "One" });
    await bind(db, repo, context, { id: "flow-2", name: "Two" });
    await bind(db, repo, context, { id: "flow-3", name: "Three" });
    const original = (await repo.listWorkbookTabs({ workbookId: context.workbook.id, ownerId: "owner-1" }))!;
    const beforeInvalid = rawTabs(db);

    for (const tabIds of [
      [],
      [original[0].id],
      [original[0].id, original[1].id, original[1].id],
      [...original.map((tab) => tab.id), "extra"],
    ]) {
      expect(
        await repo.reorderWorkbookTabs({ workbookId: context.workbook.id, ownerId: "owner-1", tabIds }),
      ).toBeNull();
      expect(rawTabs(db)).toEqual(beforeInvalid);
    }

    const requested = [original[2].id, original[0].id, original[1].id];
    const reordered = await repo.reorderWorkbookTabs({
      workbookId: context.workbook.id,
      ownerId: "owner-1",
      tabIds: requested,
    });

    expect(reordered?.map((tab) => tab.id)).toEqual(requested);
    expect(reordered?.map((tab) => tab.position)).toEqual([0, 1, 2]);
    expect(new Set(reordered?.map((tab) => tab.updatedAt)).size).toBe(1);
    expect(
      await repo.reorderWorkbookTabs({
        workbookId: context.workbook.id,
        ownerId: "wrong-owner",
        tabIds: requested,
      }),
    ).toBeNull();
  });

  it("rolls the entire reorder back when a correlated final update fails", async () => {
    const { db, repo } = makeRepo();
    const context = await repo.ensurePersonalContext("owner-1");
    await bind(db, repo, context, { id: "flow-1", name: "One" });
    await bind(db, repo, context, { id: "flow-2", name: "Two" });
    const tabs = (await repo.listWorkbookTabs({ workbookId: context.workbook.id, ownerId: "owner-1" }))!;
    const before = rawTabs(db);
    db.exec(`
      CREATE TRIGGER fail_workbook_tab_final_update
      BEFORE UPDATE OF position ON workbook_flow_tabs
      WHEN OLD.position < 0 AND NEW.position = 0
      BEGIN
        SELECT RAISE(ABORT, 'forced reorder failure');
      END;
    `);

    await expect(
      repo.reorderWorkbookTabs({
        workbookId: context.workbook.id,
        ownerId: "owner-1",
        tabIds: [tabs[1].id, tabs[0].id],
      }),
    ).rejects.toThrow(/forced reorder failure/);
    expect(rawTabs(db)).toEqual(before);
  });

  it("fails closed and rolls staged reorder back for an injected foreign-owner tab", async () => {
    const { db, repo } = makeRepo();
    const context = await repo.ensurePersonalContext("alice");
    await bind(db, repo, context, { id: "flow-a", name: "A" });
    const owned = (await repo.listWorkbookTabs({ workbookId: context.workbook.id, ownerId: "alice" }))!;
    insertFlow(db, { id: "flow-foreign", ownerId: "bob", name: "Foreign" });
    db.prepare(
      `INSERT INTO flow_project_bindings (flow_id, project_id, workbook_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run("flow-foreign", context.project.id, context.workbook.id, 9);
    db.prepare(
      `INSERT INTO workbook_flow_tabs
        (id, workbook_id, flow_id, title, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("foreign-tab", context.workbook.id, "flow-foreign", "Foreign", 99, 9, 9);
    const before = rawTabs(db);

    expect(
      await repo.renameWorkbookTab({
        workbookId: context.workbook.id,
        tabId: "foreign-tab",
        ownerId: "alice",
        title: "Nope",
      }),
    ).toBeNull();
    await expect(
      repo.reorderWorkbookTabs({
        workbookId: context.workbook.id,
        ownerId: "alice",
        tabIds: owned.map((tab) => tab.id),
      }),
    ).rejects.toThrow(/workbook tab invariant/i);
    expect(rawTabs(db)).toEqual(before);
  });

  it("rolls binding back when tab insertion fails and never repairs missing or wrong-workbook tabs", async () => {
    const { db, repo } = makeRepo();
    const context = await repo.ensurePersonalContext("owner-1");
    insertFlow(db, { id: "flow-fail", ownerId: "owner-1", name: "Failure" });
    db.exec(`
      CREATE TRIGGER fail_workbook_tab_insert
      BEFORE INSERT ON workbook_flow_tabs
      BEGIN
        SELECT RAISE(ABORT, 'forced tab insert failure');
      END;
    `);
    await expect(repo.bindFlow("flow-fail", context)).rejects.toThrow(/forced tab insert failure/);
    expect(db.prepare("SELECT * FROM flow_project_bindings WHERE flow_id = ?").get("flow-fail")).toBeUndefined();
    db.exec("DROP TRIGGER fail_workbook_tab_insert");

    await bind(db, repo, context, { id: "flow-bound", name: "Bound" });
    db.prepare("DELETE FROM workbook_flow_tabs WHERE flow_id = ?").run("flow-bound");
    expect(await repo.bindFlow("flow-bound", context)).toBeNull();
    expect(db.prepare("SELECT * FROM workbook_flow_tabs WHERE flow_id = ?").get("flow-bound")).toBeUndefined();

    const second = addWorkbook(db, context, "workbook-second");
    db.prepare(
      `INSERT INTO workbook_flow_tabs
        (id, workbook_id, flow_id, title, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("wrong-tab", second.id, "flow-bound", "Wrong", 0, 1, 1);
    expect(await repo.bindFlow("flow-bound", context)).toBeNull();
    expect(db.prepare("SELECT workbook_id FROM workbook_flow_tabs WHERE flow_id = ?").get("flow-bound")).toEqual({
      workbook_id: second.id,
    });
  });

  it("returns the original binding and tab on idempotent rebinding without duplicates", async () => {
    const { db, repo } = makeRepo();
    const context = await repo.ensurePersonalContext("owner-1");
    insertFlow(db, { id: "flow-1", ownerId: "owner-1", name: "One" });
    const first = await repo.bindFlow("flow-1", context);
    const tabsBefore = rawTabs(db);

    const second = await repo.bindFlow("flow-1", context);

    expect(second).toEqual(first);
    expect(rawTabs(db)).toEqual(tabsBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings WHERE flow_id = ?").get("flow-1")).toEqual({
      count: 1,
    });
  });

  it(
    "serializes concurrent independent re-binding and returns one original binding and tab",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "suede-workbook-bind-"));
      const dbPath = join(directory, "studio.db");
      const workerPath = join(directory, "bind-worker.ts");
      const barrierPath = join(directory, "start");
      const readyPaths = [join(directory, "ready-a"), join(directory, "ready-b")];
      let workers: Array<{ child: ChildProcess; done: Promise<unknown> }> = [];
      try {
        const db = new Database(dbPath);
        const repo = new SqliteProjectRepo(db);
        await repo.ensurePersonalContext("owner-1");
        insertFlow(db, { id: "flow-1", ownerId: "owner-1", name: "One" });
        db.close();
        writeFileSync(
          workerPath,
          `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteProjectRepo } from ${JSON.stringify(join(process.cwd(), "src/lib/projects/sqlite-project-repo.ts"))};
const dbPath = process.env.WORKBOOK_DB_PATH;
const barrierPath = process.env.WORKBOOK_BARRIER_PATH;
const readyPath = process.env.WORKBOOK_READY_PATH;
if (!dbPath || !barrierPath || !readyPath) throw new Error("missing worker input");
const repo = new SqliteProjectRepo(dbPath);
const context = await repo.ensurePersonalContext("owner-1");
writeFileSync(readyPath, "ready");
while (!existsSync(barrierPath)) await delay(5);
const binding = await repo.bindFlow("flow-1", context);
if (!binding) throw new Error("binding failed");
process.stdout.write(JSON.stringify(binding));
`,
          "utf8",
        );
        const spawnWorker = (readyPath: string) => {
          const child = spawn(
            process.execPath,
            [
              join(process.cwd(), "node_modules/vite-node/vite-node.mjs"),
              "--config",
              join(process.cwd(), "vitest.config.ts"),
              workerPath,
            ],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                SQLITE_PATH: dbPath,
                WORKBOOK_DB_PATH: dbPath,
                WORKBOOK_BARRIER_PATH: barrierPath,
                WORKBOOK_READY_PATH: readyPath,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
          child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
          const done = new Promise<unknown>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => {
              if (code !== 0) reject(new Error(`Bind worker exited ${String(code)}: ${stderr}`));
              else resolve(JSON.parse(stdout) as unknown);
            });
          });
          return { child, done };
        };
        workers = readyPaths.map(spawnWorker);
        for (let attempt = 0; attempt < 1_500; attempt += 1) {
          if (readyPaths.every(existsSync)) break;
          await delay(10);
        }
        expect(readyPaths.every(existsSync)).toBe(true);
        writeFileSync(barrierPath, "start", "utf8");

        const bindings = await Promise.all(workers.map(({ done }) => done));
        expect(bindings[1]).toEqual(bindings[0]);
        const inspection = new Database(dbPath, { readonly: true });
        try {
          expect(inspection.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get()).toEqual({ count: 1 });
          expect(inspection.prepare("SELECT COUNT(*) AS count FROM workbook_flow_tabs").get()).toEqual({ count: 1 });
        } finally {
          inspection.close();
        }
      } finally {
        for (const worker of workers) {
          if (worker.child.exitCode === null && worker.child.signalCode === null) {
            worker.child.kill("SIGTERM");
          }
        }
        await Promise.allSettled(workers.map(({ done }) => done));
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
