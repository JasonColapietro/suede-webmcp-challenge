import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SupabaseRepo } from "@/lib/db/supabase-repo";
import type { EmployeeRecord } from "@/lib/company/types";

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function downgradeLedgerToPreChecksum(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_migrations_legacy (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations_legacy (version, name, applied_at)
      SELECT version, name, applied_at FROM schema_migrations;
    DROP TABLE schema_migrations;
    ALTER TABLE schema_migrations_legacy RENAME TO schema_migrations;
  `);
}

describe("SQLite numbered migrations", () => {
  it("creates the complete current schema from a blank database", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "agents",
        "ap2_authorizations",
        "credits",
        "flows",
        "health_checks",
        "moderation_reports",
        "resource_products",
        "resource_source_assets",
        "resource_source_snapshots",
        "resource_pack_versions",
        "resource_records",
        "resource_evidence_refs",
        "resource_releases",
        "resource_run_receipts",
        "relay_endpoints",
        "run_steps",
        "runs",
        "schedules",
        "schema_migrations",
        "stripe_owner_adoptions",
        "stripe_revenue_receipts",
        "usage",
        "wallets",
        "webhook_endpoints",
      ]),
    );
    expect(indexNames(db, "health_checks")).toContain("idx_health_checks_checked_at");
    expect(columnNames(db, "agents")).toContain("settlement_live");
    expect(columnNames(db, "runs")).toContain("settled_at");
    expect(columnNames(db, "company_approvals")).toEqual(expect.arrayContaining([
      "action_summary",
      "cost_basis",
      "cost_usdc",
      "cost_note",
    ]));
    expect(indexNames(db, "runs")).toContain("idx_runs_company_activity");
    expect(indexNames(db, "company_approvals")).toContain("idx_approvals_company_activity");
    expect(indexNames(db, "moderation_reports")).toEqual(expect.arrayContaining([
      "idx_moderation_reports_queue",
      "idx_moderation_reports_reporter",
    ]));
    expect(indexNames(db, "stripe_owner_adoptions")).toContain(
      "idx_stripe_owner_adoptions_to",
    );
    expect(tableNames(db)).toContain("company_employee_instructions");
    expect(columnNames(db, "company_employee_instructions")).toEqual([
      "agent_id",
      "agents_md",
      "soul_md",
      "heartbeat_md",
      "tools_md",
      "session_summary",
      "updated_at",
    ]);
    expect(columnNames(db, "ap2_authorizations")).toEqual(expect.arrayContaining([
      "mandate_reference",
      "payment_nonce_hash",
      "request_digest",
      "receipt_json",
      "result_json",
      "expires_at",
    ]));
    expect(indexNames(db, "ap2_authorizations")).toEqual(expect.arrayContaining([
      "idx_ap2_authorizations_state_updated",
      "idx_ap2_authorizations_agent_created",
      "idx_ap2_authorizations_run",
    ]));
  });

  // Every org-chart column has to arrive nullable with no stored default:
  // a default would make rows hired before the migration claim a value
  // nobody wrote, and role in particular would read as 'worker' on every
  // legacy employee, leaving each already-founded company with no CEO.
  it("adds the org-chart and heartbeat columns as nullable with no default", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info(company_employees)")
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const added = [
      "role",
      "reports_to",
      "lifecycle_status",
      "heartbeat_enabled",
      "heartbeat_interval_seconds",
      "last_heartbeat_at",
    ];
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(added));
    for (const name of added) {
      const column = columns.find((candidate) => candidate.name === name);
      expect(column).toMatchObject({ notnull: 0, dflt_value: null });
    }
    expect(indexNames(db, "company_employees")).toContain("idx_employees_reports_to");
  });

  it("rejects a lifecycle status outside the supported union", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec(`
      INSERT INTO companies (id, owner_id, name, mission, status, created_at)
        VALUES ('co-1', 'owner-1', 'Co', 'Mission', 'active', '2026-08-05T00:00:00.000Z');
      INSERT INTO company_departments (id, company_id, name) VALUES ('dept-1', 'co-1', 'Ops');
      INSERT INTO company_employees (agent_id, company_id, department_id, job_description)
        VALUES ('agent-1', 'co-1', 'dept-1', 'Operator');
    `);

    // 'terminated' is deliberately not a lifecycle value: removal is the
    // removed_at tombstone, and a second answer would drift from it.
    expect(() =>
      db
        .prepare("UPDATE company_employees SET lifecycle_status = ? WHERE agent_id = ?")
        .run("terminated", "agent-1"),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      db
        .prepare("UPDATE company_employees SET lifecycle_status = ? WHERE agent_id = ?")
        .run("budget_paused", "agent-1"),
    ).not.toThrow();
  });

  it("upgrades a legacy database and preserves existing rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL, price_usdc REAL NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, agent_id TEXT,
        trigger TEXT NOT NULL, status TEXT NOT NULL, total_cost_usdc REAL NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER
      );
    `);
    db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?)").run(
      "agent-legacy",
      "flow-legacy",
      "legacy-agent",
      "live",
      1,
      1,
    );

    runSqliteMigrations(db);

    const row = db
      .prepare("SELECT slug, settlement_live FROM agents WHERE id = ?")
      .get("agent-legacy") as { slug: string; settlement_live: number };
    expect(row).toEqual({ slug: "legacy-agent", settlement_live: 1 });
    expect(columnNames(db, "runs")).toContain("settled_at");
  });

  it("is idempotent and records migrations in ascending order", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    runSqliteMigrations(db);

    const rows = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    expect(rows).toEqual([
      { version: 1, name: "initial-core" },
      { version: 2, name: "relay-usage-credits" },
      { version: 3, name: "settlement-columns" },
      { version: 4, name: "webhook-endpoints" },
      { version: 5, name: "projects-and-versions" },
      { version: 6, name: "deployment-integrity" },
      { version: 7, name: "workbook-flow-tabs" },
      { version: 8, name: "subflow-impact-receipts" },
      { version: 9, name: "subflow-api-read-index" },
      { version: 10, name: "durable-runtime" },
      { version: 11, name: "durable-invocations" },
      { version: 12, name: "durable-event-usage" },
      { version: 13, name: "durable-parent-owner-integrity" },
      { version: 14, name: "logical-connections" },
      { version: 15, name: "logical-connection-hardening" },
      { version: 16, name: "logical-connection-replacement-guards" },
      { version: 17, name: "control-audit-events" },
      { version: 18, name: "immutable-connector-assets" },
      { version: 19, name: "connector-portability-lookup" },
      { version: 20, name: "connector-operation-list-lookup" },
      { version: 21, name: "settlements-ledger" },
      { version: 22, name: "companies-core" },
      { version: 23, name: "company-employee-history" },
      { version: 24, name: "company-approval-snapshot" },
      { version: 25, name: "company-activity-indexes" },
      { version: 26, name: "moderation-reports" },
      { version: 27, name: "run-trigger-input" },
      { version: 28, name: "logical-connection-crypto-owner" },
      { version: 29, name: "agent-listings" },
      { version: 30, name: "health-checks" },
      { version: 31, name: "company-ceo-messages" },
      { version: 32, name: "company-employee-payto" },
      { version: 33, name: "site-verifications" },
      { version: 34, name: "stripe-revenue-receipts" },
      { version: 35, name: "stripe-owner-adoptions" },
      { version: 36, name: "company-org-roles" },
      { version: 37, name: "company-employee-instructions" },
      { version: 38, name: "prospect-records" },
      { version: 39, name: "prospect-recipient-suppressions" },
      { version: 40, name: "ap2-authorizations" },
      { version: 41, name: "relay-protocol-v2" },
      { version: 42, name: "ap2-replay-hardening" },
      { version: 43, name: "agent-resource-foundry" },
      { version: 44, name: "resource-release-publication-contract" },
      { version: 45, name: "resource-run-receipt-payment-facts" },
    ]);
    const checksums = db
      .prepare("SELECT checksum FROM schema_migrations ORDER BY version")
      .all() as Array<{ checksum: string }>;
    expect(checksums.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    expect(
      db.prepare(
        "SELECT checksum FROM schema_migrations WHERE version = 34",
      ).get(),
    ).toEqual({
      checksum:
        "f45ad0a4dd1fbffb1fde0e9d520f62d48630d149d26a430b556d1b1cf8cf3dfd",
    });
  });

  it("reconciles correct additive company columns when their ledger suffix is absent", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.prepare("DELETE FROM schema_migrations WHERE version >= 23").run();

    expect(() => runSqliteMigrations(db)).not.toThrow();
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get())
      .toEqual({ version: 45 });
    expect(columnNames(db, "company_employees")).toContain("removed_at");
    expect(columnNames(db, "company_approvals")).toEqual(expect.arrayContaining([
      "action_summary",
      "cost_basis",
      "cost_usdc",
      "cost_note",
    ]));
  });

  it("fails closed when a preexisting unledgered employee-history column has the wrong shape", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.prepare("DELETE FROM schema_migrations WHERE version >= 23").run();
    db.exec(`
      DROP INDEX idx_employees_company_active;
      ALTER TABLE company_employees RENAME COLUMN removed_at TO removed_at_legacy;
      ALTER TABLE company_employees ADD COLUMN removed_at INTEGER;
    `);

    expect(() => runSqliteMigrations(db)).toThrow(/company_employees\.removed_at definition mismatch/i);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 23").get())
      .toBeUndefined();
  });

  it("rolls back partial DDL and its ledger row when a later step fails", () => {
    const db = new Database(":memory:");
    Object.defineProperty(db, "exec", {
      value: ((original) => (sql: string): Database.Database => {
        if (sql.includes("CREATE TABLE IF NOT EXISTS usage")) {
          original.call(
            db,
            `CREATE TABLE relay_endpoints (
              agent_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
              created_at TEXT NOT NULL, UNIQUE (agent_id)
            )`,
          );
          throw new Error("forced migration failure");
        }
        return original.call(db, sql) as Database.Database;
      })(db.exec),
      configurable: true,
    });

    expect(() => runSqliteMigrations(db)).toThrow("forced migration failure");
    const applied = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(applied.map((row) => row.version)).toEqual([1]);
    expect(tableNames(db)).not.toContain("relay_endpoints");
    expect(tableNames(db)).not.toContain("usage");
  });

  it("applies every version once when a parallel process migrates the same file", () => {
    const directory = mkdtempSync(join(tmpdir(), "suede-migration-race-"));
    // Two connections onto one file, exactly like two Next prerender workers.
    const worker = new Database(join(directory, "studio.db"));
    const parallelWorker = new Database(join(directory, "studio.db"));
    let raced = false;

    try {
      Object.defineProperty(worker, "prepare", {
        value: ((original) => (sql: string): Database.Statement<[]> => {
          const statement = original.call(worker, sql) as Database.Statement<[]>;
          if (raced || !sql.includes("SELECT version, name, checksum FROM schema_migrations")) {
            return statement;
          }
          Object.defineProperty(statement, "all", {
            value: ((originalAll) => (): unknown[] => {
              const ledger = originalAll.call(statement) as unknown[];
              // The other worker commits the whole schema the moment this one
              // has read the ledger, so `ledger` is a stale snapshot from here on.
              raced = true;
              runSqliteMigrations(parallelWorker);
              return ledger;
            })(statement.all),
            configurable: true,
          });
          return statement;
        })(worker.prepare),
        configurable: true,
      });

      expect(() => runSqliteMigrations(worker)).not.toThrow();
      expect(raced).toBe(true);
      expect(
        parallelWorker
          .prepare(
            "SELECT count(*) AS ledgerRows, count(DISTINCT version) AS versions FROM schema_migrations",
          )
          .get(),
      ).toEqual({ ledgerRows: 45, versions: 45 });
    } finally {
      worker.close();
      parallelWorker.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "a renamed applied migration",
      mutate: (db: Database.Database) =>
        db.prepare("UPDATE schema_migrations SET name = 'renamed' WHERE version = 2").run(),
      error: "name mismatch",
    },
    {
      label: "a changed migration definition",
      mutate: (db: Database.Database) =>
        db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 2").run(),
      error: "checksum mismatch",
    },
    {
      label: "a non-prefix ledger",
      mutate: (db: Database.Database) =>
        db.prepare("DELETE FROM schema_migrations WHERE version = 2").run(),
      error: "not a strict applied prefix",
    },
  ])("rejects $label", ({ mutate, error }) => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    mutate(db);
    expect(() => runSqliteMigrations(db)).toThrow(error);
  });

  it("rejects a database migrated by a newer application", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(99, "future", "future", Date.now());
    expect(() => runSqliteMigrations(db)).toThrow("newer than this application");
  });

  it("upgrades the real pre-checksum migration ledger", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    downgradeLedgerToPreChecksum(db);

    runSqliteMigrations(db);

    expect(columnNames(db, "schema_migrations")).toContain("checksum");
    const rows = db
      .prepare("SELECT checksum FROM schema_migrations ORDER BY version")
      .all() as Array<{ checksum: string }>;
    expect(rows).toHaveLength(45);
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
  });

  it("validates the entire legacy prefix before backfilling any checksum", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    downgradeLedgerToPreChecksum(db);
    db.prepare("UPDATE schema_migrations SET name = 'renamed' WHERE version = 4").run();

    expect(() => runSqliteMigrations(db)).toThrow("name mismatch");
    const rows = db
      .prepare("SELECT checksum FROM schema_migrations ORDER BY version")
      .all() as Array<{ checksum: string | null }>;
    expect(rows.every((row) => row.checksum === null)).toBe(true);
  });
});

/**
 * The Supabase half of the same migration. Production applies these columns by
 * hand under docs/migrations/PENDING.md, so the deployed code has to keep
 * working against a schema that does not have them yet.
 */
describe("company_employees org-chart columns are dark-deploy safe on Supabase", () => {
  const PRE_EXISTING_KEYS = [
    "agent_id",
    "company_id",
    "department_id",
    "job_description",
    "publish_gated",
    "monthly_budget_usdc",
  ];

  function repoWith(rows: Record<string, unknown>[]): {
    repo: SupabaseRepo;
    upserts: Record<string, unknown>[];
  } {
    const upserts: Record<string, unknown>[] = [];
    interface Query {
      select(): Query;
      eq(): Query;
      is(): Promise<{ data: Record<string, unknown>[]; error: null }>;
    }
    const query: Query = {
      select: (): typeof query => query,
      eq: (): typeof query => query,
      is: (): Promise<{ data: Record<string, unknown>[]; error: null }> =>
        Promise.resolve({ data: rows, error: null }),
    };
    const client = {
      from: (): unknown => ({
        select: query.select,
        upsert: (row: Record<string, unknown>): Promise<{ error: null }> => {
          upserts.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return { repo: new SupabaseRepo(client as never), upserts };
  }

  const BASE_EMPLOYEE: EmployeeRecord = {
    agentId: "agent-1",
    companyId: "co-1",
    departmentId: "dept-1",
    jobDescription: "Operator",
    publishGated: false,
    monthlyBudgetUsdc: null,
    payTo: null,
  };

  it("omits every unset org-chart key from the insert payload", async () => {
    const { repo, upserts } = repoWith([]);

    await repo.addEmployee(BASE_EMPLOYEE);

    expect(Object.keys(upserts[0]).sort()).toEqual([...PRE_EXISTING_KEYS].sort());
  });

  it("sends an org-chart key only when it differs from the column default", async () => {
    const { repo, upserts } = repoWith([]);

    await repo.addEmployee({
      ...BASE_EMPLOYEE,
      role: "ceo",
      lifecycleStatus: "paused",
      heartbeatEnabled: true,
    });

    expect(Object.keys(upserts[0]).sort()).toEqual(
      [...PRE_EXISTING_KEYS, "role", "lifecycle_status", "heartbeat_enabled"].sort(),
    );
  });

  // The reason the guard compares against the default rather than undefined.
  // listEmployees populates all six on every read, so a record that came back
  // out of the repository carries lifecycleStatus "idle" and heartbeatEnabled
  // false. Re-inserting it must still send only the six original columns, or
  // every read-then-re-add path 500s against the production schema that has
  // not had this migration applied.
  it("omits defaulted org-chart keys when re-inserting a record read back from the repo", async () => {
    const { repo } = repoWith([
      {
        agent_id: "agent-1",
        company_id: "co-1",
        department_id: "dept-1",
        job_description: "Operator",
        publish_gated: false,
        monthly_budget_usdc: null,
      },
    ]);
    const [roundTripped] = await repo.listEmployees("co-1");
    const { repo: target, upserts } = repoWith([]);

    await target.addEmployee(roundTripped);

    expect(Object.keys(upserts[0]).sort()).toEqual([...PRE_EXISTING_KEYS].sort());
  });

  it("reads a row without any of the six columns as the pre-column employee", async () => {
    const { repo } = repoWith([
      {
        agent_id: "agent-1",
        company_id: "co-1",
        department_id: "dept-1",
        job_description: "Operator",
        publish_gated: false,
        monthly_budget_usdc: null,
      },
    ]);

    const [employee] = await repo.listEmployees("co-1");

    expect(employee).toMatchObject({
      role: null,
      reportsTo: null,
      lifecycleStatus: "idle",
      heartbeatEnabled: false,
      heartbeatIntervalSeconds: null,
      lastHeartbeatAt: null,
    });
  });
});
