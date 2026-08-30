import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";

const DEPLOYMENT_INDEXES = [
  "uq_environments_project_kind",
  "uq_deployments_active_flow_environment",
  "idx_deployments_flow_history",
] as const;

const PROJECTS_AND_VERSIONS_CHECKSUM =
  "2149fde0c1384c78ec9e81cb9daf57194e73e26e11148897688cd493196a0285";
const DEPLOYMENT_INTEGRITY_CHECKSUM =
  "3654174df6016ea3ff0981db8944442b9ab1a79be3ffb491378d42ed32ea86c6";

function indexNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map(({ name }) => name);
}

function createPhaseFiveDatabase(): Database.Database {
  const db = new Database(":memory:");
  runSqliteMigrations(db);
  db.exec("DROP TABLE workbook_flow_tabs");
  for (const index of [...DEPLOYMENT_INDEXES].reverse()) {
    db.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  db.prepare("DELETE FROM schema_migrations WHERE version >= 6").run();
  return db;
}

function seedHierarchy(db: Database.Database): void {
  db.prepare("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)").run(
    "organization-1",
    "owner-1",
    "Personal",
    "personal",
    1,
  );
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(
    "workspace-1",
    "organization-1",
    "Personal",
    "personal",
    1,
  );
  db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)").run(
    "project-1",
    "workspace-1",
    "My Project",
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
}

function seedVersionedFlow(db: Database.Database): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("flow-1", "owner-1", "Flow", "{}", 1);
  db.prepare(
    `INSERT INTO flow_versions
      (id, flow_id, version_number, schema_version, graph, semantic_hash,
       full_hash, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("version-1", "flow-1", 1, 1, "{}", "semantic", "full", "owner-1", 1);
}

describe("deployment integrity migration", () => {
  it("adds immutable migration 6 with pinned checksums and lookup indexes", () => {
    const db = new Database(":memory:");

    runSqliteMigrations(db);
    runSqliteMigrations(db);

    expect(indexNames(db)).toEqual(expect.arrayContaining([...DEPLOYMENT_INDEXES]));
    expect(
      db
        .prepare(
          "SELECT version, name, checksum FROM schema_migrations WHERE version BETWEEN 5 AND 6 ORDER BY version",
        )
        .all(),
    ).toEqual([
      {
        version: 5,
        name: "projects-and-versions",
        checksum: PROJECTS_AND_VERSIONS_CHECKSUM,
      },
      {
        version: 6,
        name: "deployment-integrity",
        checksum: DEPLOYMENT_INTEGRITY_CHECKSUM,
      },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6").get(),
    ).toEqual({ count: 1 });
  });

  it("enforces one environment kind per project and one active deployment per target", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    seedHierarchy(db);
    seedVersionedFlow(db);
    const insertEnvironment = db.prepare(
      "INSERT INTO environments VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertEnvironment.run("environment-1", "project-1", "Draft", "draft", "draft", 1);

    expect(() =>
      insertEnvironment.run(
        "environment-2",
        "project-1",
        "Draft Copy",
        "draft-copy",
        "draft",
        2,
      ),
    ).toThrow(/UNIQUE constraint failed/);

    const insertDeployment = db.prepare(
      `INSERT INTO deployments
        (id, flow_id, flow_version_id, environment_id, status, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertDeployment.run(
      "deployment-1",
      "flow-1",
      "version-1",
      "environment-1",
      "draft",
      1,
      null,
    );
    expect(() =>
      insertDeployment.run(
        "deployment-2",
        "flow-1",
        "version-1",
        "environment-1",
        "draft",
        2,
        null,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertDeployment.run(
        "deployment-retired",
        "flow-1",
        "version-1",
        "environment-1",
        "retired",
        2,
        2,
      ),
    ).not.toThrow();
  });

  it("fails closed and rolls back every index when duplicate environment kinds exist", () => {
    const db = createPhaseFiveDatabase();
    seedHierarchy(db);
    db.prepare("INSERT INTO environments VALUES (?, ?, ?, ?, ?, ?)").run(
      "environment-1",
      "project-1",
      "Draft",
      "draft",
      "draft",
      1,
    );
    db.prepare("INSERT INTO environments VALUES (?, ?, ?, ?, ?, ?)").run(
      "environment-2",
      "project-1",
      "Draft Copy",
      "draft-copy",
      "draft",
      2,
    );

    expect(() => runSqliteMigrations(db)).toThrow(/UNIQUE constraint failed/);
    expect(indexNames(db)).not.toEqual(expect.arrayContaining([...DEPLOYMENT_INDEXES]));
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version = 6").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM environments").get()).toEqual({ count: 2 });
  });

  it("rolls back an earlier index and ledger when duplicate active deployments exist", () => {
    const db = createPhaseFiveDatabase();
    seedHierarchy(db);
    seedVersionedFlow(db);
    db.prepare("INSERT INTO environments VALUES (?, ?, ?, ?, ?, ?)").run(
      "environment-1",
      "project-1",
      "Draft",
      "draft",
      "draft",
      1,
    );
    const insert = db.prepare(
      `INSERT INTO deployments
        (id, flow_id, flow_version_id, environment_id, status, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    );
    insert.run("deployment-1", "flow-1", "version-1", "environment-1", "draft", 1);
    insert.run("deployment-2", "flow-1", "version-1", "environment-1", "draft", 2);

    expect(() => runSqliteMigrations(db)).toThrow(/UNIQUE constraint failed/);
    expect(indexNames(db)).not.toEqual(expect.arrayContaining([...DEPLOYMENT_INDEXES]));
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version = 6").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({ count: 2 });
  });

  it.each(DEPLOYMENT_INDEXES)(
    "fails closed when the v6 ledger exists but %s is missing",
    (index) => {
      const db = new Database(":memory:");
      runSqliteMigrations(db);
      db.exec(`DROP INDEX ${index}`);

      expect(() => runSqliteMigrations(db)).toThrow(new RegExp(`${index}.*missing`, "i"));
      expect(
        db.prepare("SELECT version, name FROM schema_migrations WHERE version = 6").get(),
      ).toEqual({ version: 6, name: "deployment-integrity" });
    },
  );

  it("fails closed when a required v6 index definition drifts", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec(`
      DROP INDEX idx_deployments_flow_history;
      CREATE INDEX idx_deployments_flow_history ON deployments(flow_id);
    `);

    expect(() => runSqliteMigrations(db)).toThrow(/idx_deployments_flow_history.*definition/i);
  });
});
