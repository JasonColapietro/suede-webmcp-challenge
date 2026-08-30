import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = "docs/migrations/phase-2d-workbook-flow-tabs.sql";
const sql = readFileSync(migrationPath, "utf8");
const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
const statements = sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim().toLowerCase();

function securityContractIssues(candidate: string): string[] {
  const compact = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  const issues: string[] = [];
  if ((compact.match(/rolname = 'service_role'[\s\S]{0,120}rolbypassrls is true/g) ?? []).length !== 2) {
    issues.push("service_role bypass preflight/readback");
  }
  if ((compact.match(/a\.attacl is not null/g) ?? []).length !== 2) {
    issues.push("column ACL preflight/readback");
  }
  if (
    !/revoke all privileges \(\s*id, workbook_id, flow_id, title, position, created_at, updated_at\s*\) on table public\.workbook_flow_tabs from public, anon, authenticated, service_role/.test(
      compact,
    )
  ) {
    issues.push("column ACL clearing");
  }
  if (
    !/regexp_replace\(lower\(c\.column_default\), '\\s\+', '', 'g'\) = 'now\(\)'/.test(compact) ||
    compact.includes("current_timestamp")
  ) {
    issues.push("exact now default");
  }
  return issues;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("prepared Phase 2D workbook-tab Postgres migration", () => {
  it("is one bounded, serialized, manual-only transaction", () => {
    expect(normalized).toContain("manual operator input only");
    expect(normalized).toMatch(/^--[\s\S]* begin; /);
    expect(normalized).toContain("set local lock_timeout = '5s'");
    expect(normalized).toContain("set local statement_timeout = '60s'");
    expect(normalized).toContain("pg_advisory_xact_lock");
    expect(normalized.endsWith("commit;")).toBe(true);
  });

  it("fails closed on missing or drifted production prerequisites", () => {
    expect(normalized).toContain("to_regclass('public.' || prerequisite)");
    for (const table of [
      "flows",
      "organizations",
      "workspaces",
      "projects",
      "workbooks",
      "flow_project_bindings",
    ]) {
      expect(normalized).toMatch(new RegExp(`['\"]${table}['\"]`));
    }
    expect(normalized).toContain("production baseline preflight");
    expect(normalized).toContain("catalog/drift preflight");
    expect(normalized).toContain("shape preflight failed");
    expect(normalized).toContain("column_name = 'owner_id'");
    expect(normalized).toContain("column_name = 'personal_owner_id'");
    expect(normalized).toMatch(/existing_table_count\s+not in\s*\(0,\s*1\)/);
    expect(normalized.match(/rolname = 'service_role'[\s\S]{0,120}rolbypassrls is true/g)).toHaveLength(2);
  });

  it("fails closed on existing owner, security, policy, or direct ACL drift", () => {
    expect(normalized).toContain("to_regrole('service_role')");
    expect(normalized).toContain("to_regrole('anon')");
    expect(normalized).toContain("to_regrole('authenticated')");
    expect(normalized).toContain("c.relowner <> (select oid from pg_roles where rolname = current_user)");
    expect(normalized).toContain("c.relrowsecurity is not true");
    expect(normalized).toContain("c.relforcerowsecurity is not false");
    expect(normalized).toContain("c.relpersistence <> 'p'");
    expect(normalized).toContain("c.relreplident <> 'd'");
    expect(normalized).toContain("from pg_policy p");
    expect(normalized).toContain("p.polrelid = 'public.workbook_flow_tabs'::regclass");
    expect(normalized).toContain("aclexplode(coalesce(c.relacl, acldefault('r', c.relowner)))");
    expect(normalized).toContain("unexpected direct acl drift");
    expect(normalized).toContain("owner/security flag drift");
  });

  it("mirrors the exact SQLite v7 table, constraints, indexes, and cascade", () => {
    expect(normalized).toContain("create table if not exists public.workbook_flow_tabs");
    expect(normalized).toContain("id uuid constraint pk_workbook_flow_tabs primary key");
    expect(normalized).toContain("created_at timestamptz not null default now()");
    expect(normalized).toContain("updated_at timestamptz not null default now()");

    for (const constraint of [
      "workbook_flow_tabs_workbook_id_fkey",
      "workbook_flow_tabs_flow_id_fkey",
      "uq_workbook_flow_tabs_membership",
      "uq_workbook_flow_tabs_flow",
      "uq_workbook_flow_tabs_position",
      "ck_workbook_flow_tabs_title",
      "ck_workbook_flow_tabs_position",
    ]) {
      expect(normalized).toContain(`constraint ${constraint}`);
    }
    expect(normalized).toMatch(
      /workbook_flow_tabs_workbook_id_fkey foreign key \(workbook_id\) references public\.workbooks\(id\) on update no action on delete no action/,
    );
    expect(normalized).toMatch(
      /workbook_flow_tabs_flow_id_fkey foreign key \(flow_id\) references public\.flows\(id\) on update no action on delete cascade/,
    );
    expect(normalized).toContain("char_length(btrim(title)) between 1 and 200");
    expect(normalized).toContain("check (position >= 0)");
    expect(normalized).toContain(
      "create index if not exists idx_workbook_flow_tabs_workbook_order on public.workbook_flow_tabs (workbook_id, position, id)",
    );
    expect(normalized).toContain(
      "create index if not exists idx_workbook_flow_tabs_flow_id on public.workbook_flow_tabs (flow_id)",
    );
    expect(normalized).toContain("foreign-key action drift");
    expect(normalized).toContain("named constraint definition drift");
    expect(normalized).toContain("complete explicit index set drift");
  });

  it("requires exact column defaults/metadata and the complete non-constraint index set", () => {
    expect(normalized).toContain("c.ordinal_position = e.ordinal_position");
    expect(normalized).toContain("c.is_identity = 'no'");
    expect(normalized).toContain("c.is_generated = 'never'");
    expect(normalized).toContain("c.column_default is null");
    expect(normalized).toMatch(
      /regexp_replace\(lower\(c\.column_default\), '\\s\+', '', 'g'\) = 'now\(\)'/,
    );
    expect(normalized).not.toContain("current_timestamp");
    expect(normalized).toContain("exact column/default drift");
    expect(normalized).toContain("left join pg_constraint backing on backing.conindid = i.indexrelid");
    expect(normalized).toContain("backing.oid is null");
    expect(normalized).toContain("explicit_index_count <> 2");
    expect(normalized).toContain("complete explicit index set drift");
  });

  it("preflights duplicate, orphan, hierarchy, and owner-chain corruption", () => {
    expect(normalized).toMatch(/group by b\.flow_id[\s\S]*having count\(\*\) > 1/);
    expect(normalized).toMatch(/left join public\.flows f[\s\S]*f\.id is null/);
    expect(normalized).toMatch(/left join public\.workbooks w[\s\S]*w\.id is null/);
    expect(normalized).toMatch(/left join public\.projects p[\s\S]*p\.id is null/);
    expect(normalized).toContain("b.project_id <> w.project_id");
    expect(normalized).toContain("f.owner_id <> o.personal_owner_id");
    expect(normalized).toContain("binding integrity preflight failed");
  });

  it("backfills deterministic IDs, titles, and contiguous positions", () => {
    expect(normalized).toMatch(
      /row_number\(\) over \(\s*partition by b\.workbook_id order by b\.created_at, b\.flow_id\s*\) - 1/,
    );
    expect(normalized).toContain("md5(workbook_id::text || ':' || flow_id::text)");
    expect(normalized).toMatch(/when position = 0 then 'main'/);
    expect(normalized).toMatch(/nullif\(btrim\(flow_name\), ''\)/);
    expect(normalized).toMatch(/'flow ' \|\| \(position \+ 1\)::text/);
    expect(normalized).toContain("on conflict (workbook_id, flow_id) do nothing");
    expect(normalized).toContain("contiguous position readback failed");
  });

  it("asserts the exact bidirectional binding projection after backfill", () => {
    expect(normalized).toMatch(
      /from public\.flow_project_bindings b left join public\.workbook_flow_tabs t on t\.flow_id = b\.flow_id and t\.workbook_id = b\.workbook_id[\s\S]*t\.id is null/,
    );
    expect(normalized).toMatch(
      /from public\.workbook_flow_tabs t left join public\.flow_project_bindings b on b\.flow_id = t\.flow_id and b\.workbook_id = t\.workbook_id[\s\S]*b\.flow_id is null/,
    );
    expect(normalized).toContain("bidirectional projection readback failed");
  });

  it("enables RLS and grants only CRUD to service_role", () => {
    expect(normalized).toContain("alter table public.workbook_flow_tabs enable row level security");
    expect(normalized).toContain("revoke all on table public.workbook_flow_tabs from public");
    expect(normalized).toContain("revoke all on table public.workbook_flow_tabs from anon");
    expect(normalized).toContain("revoke all on table public.workbook_flow_tabs from authenticated");
    expect(normalized).toContain("revoke all on table public.workbook_flow_tabs from service_role");
    expect(normalized).toContain(
      "grant select, insert, update, delete on table public.workbook_flow_tabs to service_role",
    );
    expect(normalized).not.toMatch(/create policy|grant all/);
    expect(normalized).toContain("post-grant rls/policy readback failed");
    expect(normalized).toContain("post-grant direct acl readback failed");
  });

  it("rejects, clears, and postasserts every column-level ACL", () => {
    expect(normalized.match(/from pg_attribute a/g)).toHaveLength(2);
    expect(normalized.match(/a\.attrelid = 'public\.workbook_flow_tabs'::regclass/g)).toHaveLength(2);
    expect(normalized.match(/a\.attnum > 0/g)).toHaveLength(2);
    expect(normalized.match(/a\.attisdropped is false/g)).toHaveLength(2);
    expect(normalized.match(/a\.attacl is not null/g)).toHaveLength(2);
    expect(normalized).toContain("unexpected column acl drift");
    expect(normalized).toContain("post-grant column acl readback failed");
    expect(normalized).toMatch(
      /revoke all privileges \(\s*id, workbook_id, flow_id, title, position, created_at, updated_at\s*\) on table public\.workbook_flow_tabs from public, anon, authenticated, service_role/,
    );
  });

  it("adversarially rejects weakened bypass, column ACL, and timestamp-default contracts", () => {
    expect(securityContractIssues(sql)).toEqual([]);

    const mutants = [
      sql.replaceAll("rolbypassrls is true", "rolbypassrls is false"),
      sql.replaceAll("a.attacl is not null", "a.attacl is null"),
      sql.replace(
        "regexp_replace(lower(c.column_default), '\\s+', '', 'g') = 'now()'",
        "regexp_replace(lower(c.column_default), '\\s+', '', 'g') in ('now()', 'current_timestamp')",
      ),
      sql.replace(/revoke all privileges \([\s\S]*?\) on table public\.workbook_flow_tabs from public, anon, authenticated, service_role;/, ""),
    ];

    for (const mutant of mutants) {
      expect(securityContractIssues(mutant)).not.toEqual([]);
    }
  });

  it("is additive, does not alter ownership, and is unreachable from runtime and automation", () => {
    expect(statements).not.toMatch(
      /\bdrop\b|\btruncate\s+(?:table\s+)?public\.|delete from|alter table public\.flows|alter table public\.organizations|auth\.users|create extension|create policy|create index concurrently|exception when/,
    );

    const reachableSources = [
      "package.json",
      "src/lib/projects/provider.ts",
      ...sourceFiles("scripts").filter((path) => /verify-phase-.*\.mjs$/.test(path)),
    ];
    for (const source of reachableSources) {
      expect(readFileSync(source, "utf8"), source).not.toContain(migrationPath);
    }

    const pending = readFileSync("docs/migrations/PENDING.md", "utf8");
    expect(pending).toContain("`phase-2d-workbook-flow-tabs.sql`");
    expect(pending).toMatch(
      /Prepared; PostgreSQL execution \*\*SKIP\*\*; not applied; SQLite runtime only/,
    );
  });
});
