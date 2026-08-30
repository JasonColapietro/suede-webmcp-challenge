import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { removePostV16MigrationFixture } from "../helpers/sqlite-migration-fixture";

const PHASE_ONE_TABLES = [
  "organizations",
  "workspaces",
  "projects",
  "workbooks",
  "environments",
  "flow_project_bindings",
  "flow_versions",
  "dependency_pins",
  "deployments",
] as const;

const PHASE_ONE_INDEXES = [
  "idx_workspaces_organization_id",
  "idx_projects_workspace_id",
  "idx_workbooks_project_id",
  "idx_environments_project_id",
  "idx_flow_project_bindings_project_id",
  "idx_flow_project_bindings_workbook_id",
  "idx_flow_versions_flow_id",
  "idx_dependency_pins_flow_version_id",
  "idx_deployments_flow_id",
  "idx_deployments_flow_version_id",
  "idx_deployments_environment_id",
  "uq_environments_project_kind",
  "uq_deployments_active_flow_environment",
  "idx_deployments_flow_history",
] as const;

const LEGACY_TABLES = [
  "flows",
  "agents",
  "runs",
  "run_steps",
  "schedules",
  "wallets",
  "relay_endpoints",
  "usage",
  "credits",
  "webhook_endpoints",
] as const;

const EXPECTED_PHASE_ONE_FOREIGN_KEYS = [
  "dependency_pins.flow_version_id->flow_versions.id",
  "deployments.environment_id->environments.id",
  "deployments.flow_id->flows.id",
  "deployments.flow_version_id->flow_versions.id",
  "environments.project_id->projects.id",
  "flow_project_bindings.flow_id->flows.id",
  "flow_project_bindings.project_id->projects.id",
  "flow_project_bindings.workbook_id->workbooks.id",
  "flow_versions.flow_id->flows.id",
  "projects.workspace_id->workspaces.id",
  "workbooks.project_id->projects.id",
  "workspaces.organization_id->organizations.id",
] as const;

const PROJECTS_AND_VERSIONS_CHECKSUM =
  "2149fde0c1384c78ec9e81cb9daf57194e73e26e11148897688cd493196a0285";

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function foreignKeysEnabled(db: Database.Database): number {
  return (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
    .foreign_keys;
}

function foreignKeyMappings(db: Database.Database): string[] {
  return PHASE_ONE_TABLES.flatMap((table) =>
    (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      from: string;
      table: string;
      to: string;
    }>).map((row) => `${table}.${row.from}->${row.table}.${row.to}`),
  ).sort();
}

function tableShape(db: Database.Database, table: string): unknown[] {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function createPhaseZeroDatabase(): Database.Database {
  const db = new Database(":memory:");
  runSqliteMigrations(db);
  removePostV16MigrationFixture(db);
  db.exec("PRAGMA foreign_keys = OFF");
  for (const table of ["execution_idempotency", "execution_checkpoints", "execution_attempts", "execution_jobs", "execution_events", "durable_executions"]) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.exec("DROP INDEX IF EXISTS uq_flows_id_owner");
  db.exec("DROP TABLE IF EXISTS subflow_impact_receipts");
  db.exec("DROP INDEX IF EXISTS idx_flows_owner_id");
  db.exec("DROP INDEX IF EXISTS idx_flows_owner_name_id");
  db.exec("DROP TABLE IF EXISTS workbook_flow_tabs");
  for (const table of [...PHASE_ONE_TABLES].reverse()) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.prepare("DELETE FROM schema_migrations WHERE version >= 5").run();
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function insertHierarchy(db: Database.Database): void {
  db.prepare("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)").run(
    "org-1",
    "owner-1",
    "Personal",
    "personal",
    1,
  );
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
    "workspace-1",
    "org-1",
    "Personal",
    "personal",
    1,
  );
  db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)").run(
    "project-1",
    "workspace-1",
    "My project",
    "my-project",
    1,
    1,
  );
  db.prepare("INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)").run(
    "workbook-1",
    "project-1",
    "Main",
    "main",
    0,
    1,
  );
  db.prepare("INSERT INTO environments VALUES (?, ?, ?, ?, ?, ?)").run(
    "environment-1",
    "project-1",
    "Draft",
    "draft",
    "draft",
    1,
  );
}

describe("project and version migration", () => {
  it("enables foreign-key enforcement before applying migrations", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    expect(foreignKeysEnabled(db)).toBe(0);

    runSqliteMigrations(db);

    expect(foreignKeysEnabled(db)).toBe(1);
    expect(() =>
      db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
        "workspace-orphan",
        "organization-missing",
        "Orphan",
        "orphan",
        1,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("creates the complete Phase 1 schema and lookup indexes from blank", () => {
    const db = new Database(":memory:");

    runSqliteMigrations(db);

    expect(tableNames(db)).toEqual(expect.arrayContaining([...PHASE_ONE_TABLES]));
    expect(indexNames(db)).toEqual(expect.arrayContaining([...PHASE_ONE_INDEXES]));
    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE version = 5").get(),
    ).toEqual({ version: 5, name: "projects-and-versions" });
    expect(
      db.prepare("PRAGMA foreign_key_list(flow_versions)").all(),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ table: "flows" })]));
    expect(foreignKeyMappings(db)).toEqual([...EXPECTED_PHASE_ONE_FOREIGN_KEYS]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.prepare("SELECT checksum FROM schema_migrations WHERE version = 5").get(),
    ).toEqual({ checksum: PROJECTS_AND_VERSIONS_CHECKSUM });
    expect(tableNames(db)).toContain("workbook_flow_tabs");
  });

  it("upgrades representative Phase 0 rows without changing shapes or ledger prefix", () => {
    const db = createPhaseZeroDatabase();
    db.prepare(
      "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("flow-legacy", "owner-legacy", "Legacy", "{}", 1);
    db.prepare(
      `INSERT INTO agents
        (id, flow_id, slug, status, price_usdc, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent-legacy", "flow-legacy", "legacy", "draft", 0, 1);
    db.prepare(
      `INSERT INTO runs
        (id, flow_id, agent_id, trigger, status, total_cost_usdc, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("run-legacy", "flow-legacy", "agent-legacy", "manual", "done", 0, 1, 2);
    db.prepare("INSERT INTO run_steps VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "step-legacy",
      "run-legacy",
      "node-1",
      "input",
      "done",
      0,
      "{}",
      null,
    );
    db.prepare("INSERT INTO schedules VALUES (?, ?, ?, ?, ?)").run(
      "schedule-legacy",
      "agent-legacy",
      "0 * * * *",
      1,
      1,
    );
    db.prepare("INSERT INTO wallets VALUES (?, ?, ?, ?)").run(
      "owner-legacy",
      "0x0000000000000000000000000000000000000001",
      "base-mainnet",
      "Legacy",
    );
    db.prepare("INSERT INTO relay_endpoints (agent_id, url, secret, created_at) VALUES (?, ?, ?, ?)").run(
      "agent-legacy",
      "https://example.test/relay",
      "secret",
      "legacy-time",
    );
    db.prepare("INSERT INTO usage VALUES (?, ?, ?, ?, ?, ?)").run(
      "usage-legacy", "owner-legacy", "run", 1, 0, "legacy-time",
    );
    db.prepare("INSERT INTO credits VALUES (?, ?, ?, ?, ?, ?)").run(
      "credit-legacy", "owner-legacy", 1, "seed", null, "legacy-time",
    );
    db.prepare("INSERT INTO webhook_endpoints VALUES (?, ?, ?)").run(
      "agent-legacy", "hash", "legacy-time",
    );
    const legacyShapes = new Map(
      LEGACY_TABLES.map((table) => [table, tableShape(db, table)] as const),
    );
    const legacyRows = new Map(
      LEGACY_TABLES.map(
        (table) => [table, db.prepare(`SELECT * FROM ${table}`).all()] as const,
      ),
    );
    const ledgerPrefix = db
      .prepare(
        "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
      )
      .all();

    runSqliteMigrations(db);

    for (const table of LEGACY_TABLES) {
      expect(tableShape(db, table)).toEqual(legacyShapes.get(table));
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(legacyRows.get(table));
    }
    expect(
      db.prepare("SELECT settlement_live FROM agents WHERE id = ?").get("agent-legacy"),
    ).toEqual({ settlement_live: 1 });
    expect(
      db.prepare(
        "SELECT version, name, checksum, applied_at FROM schema_migrations WHERE version < 5 ORDER BY version",
      ).all(),
    ).toEqual(ledgerPrefix);
    expect(tableNames(db)).toEqual(expect.arrayContaining([...PHASE_ONE_TABLES]));
  });

  it("rejects an orphan-bearing upgraded schema before recording migration 5", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.prepare("DELETE FROM schema_migrations WHERE version >= 5").run();
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
      "workspace-orphan",
      "organization-missing",
      "Orphan",
      "orphan",
      1,
    );

    expect(() => runSqliteMigrations(db)).toThrow(/foreign key integrity check failed/i);
    expect(foreignKeysEnabled(db)).toBe(1);
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version = 5").get(),
    ).toBeUndefined();
  });

  it("rejects foreign-key drift after all migrations are already applied", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
      "workspace-orphan",
      "organization-missing",
      "Orphan",
      "orphan",
      1,
    );

    expect(() => runSqliteMigrations(db)).toThrow(/foreign key integrity check failed/i);
    expect(foreignKeysEnabled(db)).toBe(1);
  });

  it("applies migration 5 idempotently", () => {
    const db = createPhaseZeroDatabase();

    runSqliteMigrations(db);
    runSqliteMigrations(db);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5").get(),
    ).toEqual({ count: 1 });
    expect(tableNames(db)).toEqual(expect.arrayContaining([...PHASE_ONE_TABLES]));
  });

  it("rolls back every Phase 1 table and the ledger row after a forced failure", () => {
    const db = createPhaseZeroDatabase();
    const originalExec = db.exec;
    Object.defineProperty(db, "exec", {
      value: (sql: string): Database.Database => {
        if (sql.includes("CREATE TABLE IF NOT EXISTS organizations")) {
          originalExec.call(
            db,
            `CREATE TABLE organizations (
              id TEXT PRIMARY KEY, personal_owner_id TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
            )`,
          );
          throw new Error("forced project migration failure");
        }
        return originalExec.call(db, sql) as Database.Database;
      },
      configurable: true,
    });

    expect(() => runSqliteMigrations(db)).toThrow("forced project migration failure");
    expect(tableNames(db).filter((table) => PHASE_ONE_TABLES.includes(
      table as (typeof PHASE_ONE_TABLES)[number],
    ))).toEqual([]);
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version = 5").get(),
    ).toBeUndefined();
  });

  it("enforces the personal owner and scoped slug uniqueness constraints", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertHierarchy(db);

    expect(() =>
      db.prepare("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)").run(
        "org-2",
        "owner-1",
        "Duplicate",
        "personal",
        2,
      ),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
        "workspace-2",
        "org-1",
        "Duplicate",
        "personal",
        2,
      ),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)").run(
        "project-2",
        "workspace-1",
        "Duplicate",
        "my-project",
        2,
        2,
      ),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)").run(
        "workbook-2",
        "project-1",
        "Duplicate",
        "main",
        1,
        2,
      ),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO environments VALUES (?, ?, ?, ?, ?, ?)").run(
        "environment-2",
        "project-1",
        "Duplicate",
        "draft",
        "test",
        2,
      ),
    ).toThrow();
  });

  it("enforces version numbers and dependency pins per version", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.prepare(
      "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("flow-1", "owner-1", "Flow", "{}", 1);
    const insertVersion = db.prepare(
      `INSERT INTO flow_versions
        (id, flow_id, version_number, schema_version, label, description, graph,
         semantic_hash, full_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertVersion.run("version-1", "flow-1", 1, 1, null, null, "{}", "sem", "full", "owner-1", 1);

    expect(() =>
      insertVersion.run("version-2", "flow-1", 1, 1, null, null, "{}", "sem", "full", "owner-1", 2),
    ).toThrow();
    const insertPin = db.prepare(
      `INSERT INTO dependency_pins
        (id, flow_version_id, kind, resource_id, version, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertPin.run("pin-1", "version-1", "tool", "search", "1", null, 1);
    expect(() =>
      insertPin.run("pin-2", "version-1", "tool", "search", "2", null, 2),
    ).toThrow();
  });

  it("keeps settlement live by default for legacy and newly inserted agents", () => {
    const db = createPhaseZeroDatabase();
    db.prepare(
      `INSERT INTO agents
        (id, flow_id, slug, status, price_usdc, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent-legacy", "flow-legacy", "legacy", "draft", 0, 1);

    runSqliteMigrations(db);
    db.prepare(
      `INSERT INTO agents
        (id, flow_id, slug, status, price_usdc, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent-new", "flow-new", "new", "draft", 0, 2);

    expect(
      db.prepare("SELECT id, settlement_live FROM agents ORDER BY id").all(),
    ).toEqual([
      { id: "agent-legacy", settlement_live: 1 },
      { id: "agent-new", settlement_live: 1 },
    ]);
  });

  it("creates the exact v8 impact-receipt table, checks, indexes, and cascade", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    expect(db.prepare("PRAGMA table_info(subflow_impact_receipts)").all()).toMatchObject([
      { name: "id", type: "TEXT", notnull: 0, pk: 1 },
      { name: "owner_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "child_flow_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "old_interface_hash", type: "TEXT", notnull: 1, pk: 0 },
      { name: "proposed_interface_hash", type: "TEXT", notnull: 1, pk: 0 },
      { name: "dependent_set_hash", type: "TEXT", notnull: 1, pk: 0 },
      { name: "issued_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "expires_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "consumed_at", type: "INTEGER", notnull: 0, pk: 0 },
    ]);
    expect(
      (db.prepare("PRAGMA index_list(subflow_impact_receipts)").all() as Array<{ name: string }>)
        .map((row) => row.name).sort(),
    ).toEqual([
      "idx_subflow_impact_receipts_child",
      "idx_subflow_impact_receipts_expiry",
      "sqlite_autoindex_subflow_impact_receipts_1",
      "uq_subflow_impact_receipts_owner_child",
    ]);
    expect(indexNames(db)).toContain("idx_flows_owner_id");
    expect(db.prepare("PRAGMA foreign_key_list(subflow_impact_receipts)").all()).toMatchObject([
      { table: "flows", from: "child_flow_id", to: "id", on_delete: "CASCADE" },
    ]);
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'subflow_impact_receipts' ORDER BY name").all() as Array<{ name: string }>)
        .map((row) => row.name),
    ).toEqual(["subflow_impact_receipts_owner_insert", "subflow_impact_receipts_owner_update"]);
    db.prepare("INSERT INTO flows VALUES (?, ?, ?, ?, ?)").run("child", "owner", "Child", "{}", 1);
    const insert = db.prepare(
      `INSERT INTO subflow_impact_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => insert.run("short", "owner", "child", "none", "none", "bad", 1, 2, null)).toThrow();
    const hash = "a".repeat(64);
    expect(() => insert.run("x".repeat(32), "other", "child", "none", "none", hash, 1, 2, null)).toThrow(/owner mismatch/i);
    expect(() => insert.run("y".repeat(32), "owner", "child", "none", "none", `a${"!".repeat(63)}`, 1, 2, null)).toThrow();
    const ownerPlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM flows WHERE owner_id = ? ORDER BY id",
    ).all("owner") as Array<{ detail: string }>;
    expect(ownerPlan.some((row) => row.detail.includes("idx_flows_owner_id"))).toBe(true);
    const cascadePlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM subflow_impact_receipts WHERE child_flow_id = ?",
    ).all("child") as Array<{ detail: string }>;
    expect(cascadePlan.some((row) => row.detail.includes("idx_subflow_impact_receipts_child"))).toBe(true);
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 8").get())
      .toEqual({ version: 8, name: "subflow-impact-receipts" });
  });

  it("rolls back the v8 table and ledger row after a forced migration failure", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec("DROP TABLE subflow_impact_receipts");
    db.exec("DROP INDEX idx_flows_owner_id");
    db.exec("DROP INDEX idx_flows_owner_name_id");
    db.exec("DROP INDEX idx_flow_versions_flow_number_id");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 8").run();
    const originalExec = db.exec;
    Object.defineProperty(db, "exec", {
      value: (sql: string): Database.Database => {
        if (sql.includes("CREATE TABLE subflow_impact_receipts")) {
          originalExec.call(db, sql);
          throw new Error("forced v8 migration failure");
        }
        return originalExec.call(db, sql);
      },
    });
    expect(() => runSqliteMigrations(db)).toThrow(/forced v8 migration failure/);
    expect(tableNames(db)).not.toContain("subflow_impact_receipts");
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 8").get()).toBeUndefined();
  });

  it("fails closed on reopened v8 table, index, or trigger definition drift", () => {
    for (const drift of ["table", "index", "trigger"] as const) {
      const db = new Database(":memory:");
      runSqliteMigrations(db);
      if (drift === "table") {
        db.exec("DROP TABLE subflow_impact_receipts");
        db.exec(`CREATE TABLE subflow_impact_receipts (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, child_flow_id TEXT NOT NULL,
          old_interface_hash TEXT NOT NULL, proposed_interface_hash TEXT NOT NULL,
          dependent_set_hash TEXT NOT NULL, issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, consumed_at INTEGER
        )`);
      } else if (drift === "index") {
        db.exec("DROP INDEX idx_subflow_impact_receipts_expiry");
      } else {
        db.exec("DROP TRIGGER subflow_impact_receipts_owner_insert");
      }
      expect(() => runSqliteMigrations(db)).toThrow(/subflow impact receipt/i);
      db.close();
    }
  });

  it("installs and reopen-verifies the exact v9 bounded keyset indexes", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    expect(indexNames(db)).toEqual(expect.arrayContaining([
      "idx_flows_owner_name_id",
      "idx_flow_versions_flow_number_id",
    ]));
    const candidatePlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT id, name FROM flows
       WHERE owner_id = ? AND (? IS NULL OR name > ? OR (name = ? AND id > ?))
       ORDER BY name COLLATE BINARY ASC, id COLLATE BINARY ASC LIMIT 2`,
    ).all("owner", null, null, null, "") as Array<{ detail: string }>;
    expect(candidatePlan.some((row) => row.detail.includes("idx_flows_owner_name_id"))).toBe(true);
    expect(candidatePlan.some((row) => row.detail.includes("USE TEMP B-TREE"))).toBe(false);
    const versionPlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT id, version_number FROM flow_versions
       WHERE flow_id = ? AND (? IS NULL OR version_number < ? OR (version_number = ? AND id < ?))
       ORDER BY version_number DESC, id DESC LIMIT 2`,
    ).all("flow", null, null, null, "") as Array<{ detail: string }>;
    expect(versionPlan.some((row) => row.detail.includes("idx_flow_versions_flow_number_id"))).toBe(true);
    expect(versionPlan.some((row) => row.detail.includes("USE TEMP B-TREE"))).toBe(false);

    db.exec("DROP INDEX idx_flows_owner_name_id");
    db.exec("CREATE INDEX idx_flows_owner_name_id ON flows(owner_id, id, name)");
    expect(() => runSqliteMigrations(db)).toThrow(/subflow API read index/i);
    db.close();
  });

  it("rolls back both v9 indexes and its ledger row after a forced failure", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec("DROP INDEX idx_flows_owner_name_id");
    db.exec("DROP INDEX idx_flow_versions_flow_number_id");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 9").run();
    const originalExec = db.exec;
    Object.defineProperty(db, "exec", {
      value: (sql: string): Database.Database => {
        if (sql.includes("CREATE INDEX idx_flows_owner_name_id")) {
          originalExec.call(db, sql);
          throw new Error("forced v9 migration failure");
        }
        return originalExec.call(db, sql);
      },
    });
    expect(() => runSqliteMigrations(db)).toThrow(/forced v9 migration failure/);
    expect(indexNames(db)).not.toContain("idx_flows_owner_name_id");
    expect(indexNames(db)).not.toContain("idx_flow_versions_flow_number_id");
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 9").get()).toBeUndefined();
    db.close();
  });
});
