import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "docs/migrations/phase-1-projects-and-versions.sql";
const sql = readFileSync(migrationPath, "utf8");
const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
const statements = sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim().toLowerCase();

const TABLES = [
  "organizations",
  "workspaces",
  "projects",
  "workbooks",
  "environments",
  "flow_project_bindings",
  "flow_versions",
  "dependency_pins",
  "deployments",
].sort();

const FOREIGN_KEYS = [
  "workspaces_organization_id_fkey",
  "projects_workspace_id_fkey",
  "workbooks_project_id_fkey",
  "environments_project_id_fkey",
  "flow_project_bindings_flow_id_fkey",
  "flow_project_bindings_project_id_fkey",
  "flow_project_bindings_workbook_id_fkey",
  "flow_versions_flow_id_fkey",
  "dependency_pins_flow_version_id_fkey",
  "deployments_flow_id_fkey",
  "deployments_flow_version_id_fkey",
  "deployments_environment_id_fkey",
].sort();

function matches(pattern: RegExp): string[] {
  return Array.from(sql.matchAll(pattern), (match) => match[1]);
}

describe("prepared Phase 1 Supabase migration", () => {
  it("mirrors the nine SQLite v5/v6 tables and fourteen explicit indexes", () => {
    expect(matches(/create table if not exists\s+(?:public\.)?(\w+)/gi).sort()).toEqual(TABLES);
    expect(matches(/create (?:unique )?index if not exists\s+(\w+)/gi)).toHaveLength(14);
  });

  it("names twelve NO ACTION foreign keys and seven scoped unique constraints", () => {
    const foreignKeys = matches(/constraint\s+(\w+_fkey)\s+foreign key/gi);
    const uniqueConstraints = matches(/constraint\s+(uq_\w+)\s+unique/gi);
    expect([...new Set(foreignKeys)].sort()).toEqual(FOREIGN_KEYS);
    expect(new Set(uniqueConstraints).size).toBe(7);
    expect(
      Array.from(
        sql.matchAll(
          /constraint\s+\w+_fkey\s+foreign key[\s\S]*?on update no action\s+on delete no action/gi,
        ),
      ),
    ).toHaveLength(12);
  });

  it("uses bounded transactional locking and aborts on catalog or shape drift", () => {
    expect(normalized).toMatch(/^--[\s\S]* begin; /i);
    expect(normalized).toContain("set local lock_timeout = '5s'");
    expect(normalized).toContain("set local statement_timeout = '60s'");
    expect(normalized).toContain("pg_advisory_xact_lock");
    expect(normalized).toMatch(/to_regprocedure\('(?:public\.)?gen_random_uuid\(\)'\)/);
    expect(normalized).toContain("catalog/drift preflight");
    expect(normalized).toContain("shape preflight failed");
    expect(normalized.endsWith("commit;")).toBe(true);
  });

  it("contains nine duplicate and twelve orphan preflight checks", () => {
    expect(Array.from(sql.matchAll(/group by[\s\S]*?having count\(\*\) > 1/gi))).toHaveLength(9);
    expect(Array.from(sql.matchAll(/left join[\s\S]*?where p\.id is null/gi))).toHaveLength(12);
  });

  it("uses production-native types without changing the legacy flows or auth model", () => {
    expect(normalized).toContain("flow_id uuid");
    expect(normalized).toContain("personal_owner_id text");
    expect(normalized).toContain("graph jsonb");
    expect(normalized).toContain("created_at timestamptz");
    expect(normalized).not.toMatch(/alter table flows|auth\.users/i);
    expect(normalized).toContain("column_default");
    expect(normalized).toContain("gen_random_uuid()");
    expect(normalized).toContain("now()");
  });

  it("qualifies public objects and grants service_role only CRUD table privileges", () => {
    for (const table of TABLES) {
      expect(normalized).toContain(`create table if not exists public.${table}`);
      expect(normalized).toContain(`alter table public.${table} enable row level security`);
    }
    expect(normalized).toContain("grant select, insert, update, delete on table");
    expect(normalized).toContain("to service_role");
    expect(normalized).not.toMatch(/grant all/i);
  });

  it("enables RLS on all nine tables with no public policies", () => {
    expect(
      matches(/alter table\s+(?:public\.)?(\w+)\s+enable row level security/gi).sort(),
    ).toEqual(TABLES);
    expect(normalized).not.toMatch(/create policy/i);
    expect(normalized).toContain("revoke all on table");
    expect(normalized).toContain("grant select, insert, update, delete on table");
  });

  it("is manual-only additive SQL and is never invoked by package scripts", () => {
    expect(statements).not.toMatch(
      /\b(drop|truncate|cascade)\b|delete from|alter column|create extension|create policy|create index concurrently|exception when|supabase\s+db|psql\b/i,
    );
    const packageJson = readFileSync("package.json", "utf8");
    const phase0 = readFileSync("scripts/verify-phase-0.mjs", "utf8");
    const phase1 = readFileSync("scripts/verify-phase-1-lib.mjs", "utf8");
    expect(`${packageJson}\n${phase0}\n${phase1}`).not.toContain(migrationPath);
  });

  it("documents SQLite complete while PostgreSQL execution and runtime remain unavailable", () => {
    const architecture = readFileSync("docs/architecture/phase-1-versioning.md", "utf8");
    const pending = readFileSync("docs/migrations/PENDING.md", "utf8");
    expect(architecture).toContain("Local SQLite support is complete");
    expect(architecture).toMatch(/PostgreSQL execution status: SKIP/i);
    expect(architecture).toContain("Supabase runtime is unavailable");
    expect(`${architecture}\n${pending}`).toMatch(/not applied/i);
  });
});

describe("prepared Phase 2D subflow impact receipt migration", () => {
  const path = "docs/migrations/phase-2d-subflow-impact-receipts.sql";
  const source = readFileSync(path, "utf8");
  const compact = source.replace(/\s+/g, " ").toLowerCase();

  it("is manual-only, transactional, owner-guarded, private, and unapplied", () => {
    expect(compact).toContain("manual operator input only");
    expect(compact).toContain("begin;");
    expect(compact).toContain("set local lock_timeout = '5s'");
    expect(compact).toContain("pg_advisory_xact_lock");
    expect(compact).toContain("foreign key (child_flow_id) references public.flows(id)");
    expect(compact).toContain("create unique index uq_subflow_impact_receipts_owner_child");
    expect(compact).toContain("create index idx_subflow_impact_receipts_child");
    expect(compact).toContain("create index idx_flows_owner_id");
    expect(compact).toContain("if to_regclass('public.subflow_impact_receipts') is not null");
    expect(compact).toContain("create table public.subflow_impact_receipts");
    expect(compact).not.toMatch(/create (?:table|index) if not exists|create or replace/i);
    expect(compact).toContain("assert_subflow_impact_receipt_owner");
    expect(compact).toContain("enable row level security");
    expect(compact).not.toContain("create policy");
    expect(compact).toContain("grant select, insert, update, delete");
    expect(compact.trim().endsWith("commit;")).toBe(true);
    expect(readFileSync("docs/migrations/PENDING.md", "utf8")).toContain("PostgreSQL execution **SKIP**");
  });

  it("is unreachable from package and verification execution", () => {
    const executionSources = [
      "package.json",
      "scripts/verify-phase-0.mjs",
      "scripts/verify-phase-1-lib.mjs",
      "scripts/verify-phase-2d.mjs",
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(executionSources).not.toContain(path);
  });
});
