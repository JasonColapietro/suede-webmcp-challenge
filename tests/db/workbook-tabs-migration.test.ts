import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { removePostV16MigrationFixture } from "../helpers/sqlite-migration-fixture";

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function createV6Database(): Database.Database {
  const db = new Database(":memory:");
  runSqliteMigrations(db);
  removePostV16MigrationFixture(db);
  if (tableExists(db, "workbook_flow_tabs")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE subflow_impact_receipts");
    db.exec("DROP TABLE workbook_flow_tabs");
    db.exec("DROP INDEX idx_flows_owner_id");
    db.exec("DROP INDEX idx_flows_owner_name_id");
    db.exec("DROP INDEX idx_flow_versions_flow_number_id");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 7").run();
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

function insertHierarchy(
  db: Database.Database,
  input: {
    ownerId?: string;
    organizationId?: string;
    workspaceId?: string;
    projectId?: string;
    workbookId?: string;
  } = {},
): void {
  const ownerId = input.ownerId ?? "owner-1";
  const organizationId = input.organizationId ?? "org-1";
  const workspaceId = input.workspaceId ?? "workspace-1";
  const projectId = input.projectId ?? "project-1";
  const workbookId = input.workbookId ?? "workbook-1";
  db.prepare("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)").run(
    organizationId,
    ownerId,
    `Organization ${organizationId}`,
    "personal",
    1,
  );
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
    workspaceId,
    organizationId,
    `Workspace ${workspaceId}`,
    workspaceId,
    1,
  );
  db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)").run(
    projectId,
    workspaceId,
    `Project ${projectId}`,
    projectId,
    1,
    1,
  );
  db.prepare("INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)").run(
    workbookId,
    projectId,
    `Workbook ${workbookId}`,
    workbookId,
    0,
    1,
  );
}

function insertFlow(
  db: Database.Database,
  id: string,
  ownerId: string,
  name: string,
  updatedAt = 1,
): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, ownerId, name, JSON.stringify({ id: `graph-${id}`, nodes: [], edges: [] }), updatedAt);
}

function bindFlow(
  db: Database.Database,
  flowId: string,
  projectId: string,
  workbookId: string,
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO flow_project_bindings (flow_id, project_id, workbook_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(flowId, projectId, workbookId, createdAt);
}

function expectedTabId(workbookId: string, flowId: string): string {
  return `wft_${createHash("sha256")
    .update(`${workbookId}\0${flowId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function expectV7RolledBack(db: Database.Database): void {
  expect(tableExists(db, "workbook_flow_tabs")).toBe(false);
  expect(
    db.prepare("SELECT version FROM schema_migrations WHERE version = 7").get(),
  ).toBeUndefined();
}

describe("SQLite workbook tab migration", () => {
  it("defines the exact public tab and owner-scoped repository contracts", () => {
    const typesSource = readFileSync("src/lib/projects/types.ts", "utf8");
    const repoSource = readFileSync("src/lib/projects/repo.ts", "utf8");

    expect(typesSource).toContain("export interface WorkbookFlowTab");
    expect(typesSource).toContain("export interface FlowWorkbookContext");
    expect(repoSource).toContain("export interface WorkbookTabRepo");
    expect(repoSource).toContain("listWorkbookTabs(input: ListWorkbookTabsRepositoryInput)");
    expect(repoSource).toContain("renameWorkbookTab(input: RenameWorkbookTabRepositoryInput)");
    expect(repoSource).toContain("reorderWorkbookTabs(input: ReorderWorkbookTabsRepositoryInput)");
    expect(repoSource).toContain("export interface ProjectRepo extends FlowVersionRepo, DeploymentRepo, WorkbookTabRepo");
  });

  it("creates the v7 table, exact indexes, constraints, and cascade from blank", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE version = 7").get(),
    ).toEqual({ version: 7, name: "workbook-flow-tabs" });
    expect(db.prepare("PRAGMA table_info(workbook_flow_tabs)").all()).toEqual(
      expect.arrayContaining(
        ["id", "workbook_id", "flow_id", "title", "position", "created_at", "updated_at"].map(
          (name) => expect.objectContaining({ name }),
        ),
      ),
    );
    expect(
      db.prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'idx_workbook_flow_tabs_workbook_order', 'idx_workbook_flow_tabs_flow_id'
         ) ORDER BY name`,
      ).all(),
    ).toEqual([
      expect.objectContaining({
        name: "idx_workbook_flow_tabs_flow_id",
        sql: expect.stringMatching(/ON workbook_flow_tabs\s*\(flow_id\)/i),
      }),
      expect.objectContaining({
        name: "idx_workbook_flow_tabs_workbook_order",
        sql: expect.stringMatching(/ON workbook_flow_tabs\s*\(workbook_id, position, id\)/i),
      }),
    ]);

    const foreignKeys = db.prepare("PRAGMA foreign_key_list(workbook_flow_tabs)").all();
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "workbook_id", table: "workbooks", to: "id" }),
        expect.objectContaining({ from: "flow_id", table: "flows", to: "id", on_delete: "CASCADE" }),
      ]),
    );
    const tableSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(
        "workbook_flow_tabs",
      ) as { sql: string }
    ).sql;
    expect(tableSql).toMatch(/flow_id TEXT NOT NULL UNIQUE/i);
    expect(tableSql).toMatch(/UNIQUE\s*\(workbook_id, flow_id\)/i);
    expect(tableSql).toMatch(/UNIQUE\s*\(workbook_id, position\)/i);
    expect(tableSql).toMatch(/length\s*\(trim\s*\(title\)\) BETWEEN 1 AND 200/i);
  });

  it("backfills v6 bindings deterministically without changing persisted flow rows or row IDs", () => {
    const db = createV6Database();
    insertHierarchy(db);
    db.prepare("INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)").run(
      "workbook-2",
      "project-1",
      "Second",
      "second",
      1,
      2,
    );
    insertFlow(db, "flow-z", "owner-1", "  Later  ", 11);
    insertFlow(db, "flow-b", "owner-1", "   ", 12);
    insertFlow(db, "flow-a", "owner-1", "First by id", 13);
    insertFlow(db, "flow-other", "owner-1", "Other", 14);
    bindFlow(db, "flow-z", "project-1", "workbook-1", 20);
    bindFlow(db, "flow-b", "project-1", "workbook-1", 10);
    bindFlow(db, "flow-a", "project-1", "workbook-1", 10);
    bindFlow(db, "flow-other", "project-1", "workbook-2", 5);
    const flowsBefore = db.prepare("SELECT * FROM flows ORDER BY id").all();

    runSqliteMigrations(db);

    expect(db.prepare("SELECT * FROM flows ORDER BY id").all()).toEqual(flowsBefore);
    expect(
      db.prepare(
        `SELECT id, workbook_id, flow_id, title, position, created_at, updated_at
         FROM workbook_flow_tabs ORDER BY workbook_id, position`,
      ).all(),
    ).toEqual([
      {
        id: expectedTabId("workbook-1", "flow-a"),
        workbook_id: "workbook-1",
        flow_id: "flow-a",
        title: "Main",
        position: 0,
        created_at: 10,
        updated_at: 10,
      },
      {
        id: expectedTabId("workbook-1", "flow-b"),
        workbook_id: "workbook-1",
        flow_id: "flow-b",
        title: "Flow 2",
        position: 1,
        created_at: 10,
        updated_at: 10,
      },
      {
        id: expectedTabId("workbook-1", "flow-z"),
        workbook_id: "workbook-1",
        flow_id: "flow-z",
        title: "Later",
        position: 2,
        created_at: 20,
        updated_at: 20,
      },
      {
        id: expectedTabId("workbook-2", "flow-other"),
        workbook_id: "workbook-2",
        flow_id: "flow-other",
        title: "Main",
        position: 0,
        created_at: 5,
        updated_at: 5,
      },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("is repeatable and rejects checksum drift without changing tab rows", () => {
    const db = createV6Database();
    insertHierarchy(db);
    insertFlow(db, "flow-1", "owner-1", "One");
    bindFlow(db, "flow-1", "project-1", "workbook-1", 7);
    runSqliteMigrations(db);
    const rowsBefore = db.prepare("SELECT * FROM workbook_flow_tabs").all();
    const ledgerBefore = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

    runSqliteMigrations(db);

    expect(db.prepare("SELECT * FROM workbook_flow_tabs").all()).toEqual(rowsBefore);
    expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledgerBefore);
    db.prepare("UPDATE schema_migrations SET checksum = 'drift' WHERE version = 7").run();
    expect(() => runSqliteMigrations(db)).toThrow(/migration 7 checksum mismatch/i);
    expect(db.prepare("SELECT * FROM workbook_flow_tabs").all()).toEqual(rowsBefore);
  });

  it("enforces membership, position, title, and foreign-key constraints", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertHierarchy(db);
    db.prepare("INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)").run(
      "workbook-2", "project-1", "Second", "second", 1, 2,
    );
    insertFlow(db, "flow-1", "owner-1", "One");
    insertFlow(db, "flow-2", "owner-1", "Two");
    const insert = db.prepare(
      `INSERT INTO workbook_flow_tabs
        (id, workbook_id, flow_id, title, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("tab-1", "workbook-1", "flow-1", "Main", 0, 1, 1);

    expect(() => insert.run("tab-flow", "workbook-2", "flow-1", "Again", 0, 1, 1)).toThrow();
    expect(() => insert.run("tab-position", "workbook-1", "flow-2", "Two", 0, 1, 1)).toThrow();
    expect(() => insert.run("tab-workbook", "missing", "flow-2", "Two", 1, 1, 1)).toThrow();
    expect(() => insert.run("tab-flow-fk", "workbook-1", "missing", "Two", 1, 1, 1)).toThrow();
    expect(() => insert.run("tab-title", "workbook-1", "flow-2", "   ", 1, 1, 1)).toThrow();
    expect(() => insert.run("tab-long", "workbook-1", "flow-2", "x".repeat(201), 1, 1, 1)).toThrow();
  });

  it("cascades the tab when the owner-scoped bound-flow deletion transaction removes binding then flow", () => {
    const db = createV6Database();
    insertHierarchy(db);
    insertFlow(db, "flow-1", "owner-1", "One");
    bindFlow(db, "flow-1", "project-1", "workbook-1", 1);
    runSqliteMigrations(db);

    db.transaction(() => {
      db.prepare("DELETE FROM flow_project_bindings WHERE flow_id = ?").run("flow-1");
      db.prepare("DELETE FROM flows WHERE id = ? AND owner_id = ?").run("flow-1", "owner-1");
    }).immediate();

    expect(db.prepare("SELECT * FROM workbook_flow_tabs").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM flows WHERE id = 'flow-1'").get()).toBeUndefined();
  });

  it.each([
    {
      label: "binding and workbook projects disagree",
      corrupt(db: Database.Database): void {
        insertHierarchy(db);
        insertHierarchy(db, {
          ownerId: "owner-2",
          organizationId: "org-2",
          workspaceId: "workspace-2",
          projectId: "project-2",
          workbookId: "workbook-2",
        });
        insertFlow(db, "flow-1", "owner-2", "Flow");
        bindFlow(db, "flow-1", "project-1", "workbook-2", 1);
      },
    },
    {
      label: "flow and workbook owners disagree",
      corrupt(db: Database.Database): void {
        insertHierarchy(db);
        insertFlow(db, "flow-1", "owner-other", "Flow");
        bindFlow(db, "flow-1", "project-1", "workbook-1", 1);
      },
    },
    {
      label: "the owner hierarchy is incomplete",
      corrupt(db: Database.Database): void {
        insertHierarchy(db);
        insertFlow(db, "flow-1", "owner-1", "Flow");
        bindFlow(db, "flow-1", "project-1", "workbook-1", 1);
        db.exec("PRAGMA foreign_keys = OFF");
        db.prepare("DELETE FROM organizations WHERE id = 'org-1'").run();
      },
    },
  ])("rolls v7 back completely when $label", ({ corrupt }) => {
    const db = createV6Database();
    corrupt(db);

    expect(() => runSqliteMigrations(db)).toThrow(/workbook tab|foreign key/i);

    expectV7RolledBack(db);
  });

  it("rolls table creation, backfill, and ledger write back on a foreign-key failure", () => {
    const db = createV6Database();
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
      "orphan-workspace", "missing-org", "Orphan", "orphan", 1,
    );

    expect(() => runSqliteMigrations(db)).toThrow(/foreign key integrity check failed/i);

    expectV7RolledBack(db);
  });

  it("fails closed when committed tabs and bindings stop being an exact bidirectional projection", () => {
    const db = createV6Database();
    insertHierarchy(db);
    insertFlow(db, "flow-1", "owner-1", "Flow");
    bindFlow(db, "flow-1", "project-1", "workbook-1", 1);
    runSqliteMigrations(db);
    db.prepare("DELETE FROM workbook_flow_tabs WHERE flow_id = ?").run("flow-1");

    expect(() => runSqliteMigrations(db)).toThrow(/binding missing.*tab|workbook tab/i);
  });
});
