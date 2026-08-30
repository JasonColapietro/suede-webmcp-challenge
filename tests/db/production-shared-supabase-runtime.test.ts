import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "docs/migrations/production-shared-supabase-runtime.sql"),
  "utf8",
);
const normalized = sql.replace(/\s+/gu, " ").toLowerCase();

describe("shared Supabase production migration", () => {
  it("uses exact monetary columns and owner-scoped transaction idempotency", () => {
    expect(normalized).toContain("cost_usdc numeric(20, 8)");
    expect(normalized).toContain("delta_usdc numeric(20, 8)");
    expect(normalized).toContain("create unique index if not exists uq_credits_owner_tx on public.credits (owner_id, tx) where tx is not null");
    expect(normalized).not.toMatch(/(?:cost_usdc|delta_usdc) real/u);
  });

  it("locks reorder inputs before aggregate reads and uses a collision-free positive offset", () => {
    expect(normalized).toContain("perform id from public.workbook_flow_tabs");
    expect(normalized).toContain("for update; select array_agg(id order by id), count(*), coalesce(max(position), -1) + count(*) + 1");
    expect(normalized).toContain("set position = position + temporary_offset");
    expect(normalized).not.toContain("where workbook_id = p_workbook_id for update");
  });

  it("dedupes unlabeled versions under the flow lock with dependency equality", () => {
    expect(normalized).toContain("if p_label is null then");
    expect(normalized).toContain("p_checkpoint and fv.full_hash = p_full_hash and fv.graph = p_graph");
    expect(normalized).toContain("not p_checkpoint and fv.semantic_hash = p_semantic_hash");
    expect(normalized).toContain("where dp.flow_version_id = fv.id ) = requested_dependencies");
  });

  it("allows exact Resource Pack dependency pins on fresh and already-prepared runtimes", () => {
    expect(normalized).toContain(
      "kind text not null constraint dependency_pins_kind_check check (kind in ('agent', 'connector', 'flow', 'resource', 'skill', 'template'))",
    );
    expect(normalized).toContain(
      "alter table public.dependency_pins drop constraint if exists dependency_pins_kind_check",
    );
    expect(normalized).toContain(
      "alter table public.dependency_pins add constraint dependency_pins_kind_check check (kind in ('agent', 'connector', 'flow', 'resource', 'skill', 'template'))",
    );
  });

  it("owns reruns with a versioned marker and exposes only normalized server RPC grants", () => {
    expect(normalized).toContain("schema_revision text not null check (schema_revision = 'shared-runtime-v2')");
    expect(normalized).toContain("owned-table drift: expected 20");
    expect(normalized).toContain("owned-table column inventory drift");
    expect(normalized).toContain("create policy agent_studio_runtime_secrets_deny_all on public.agent_studio_runtime_secrets for all to anon using (false) with check (false)");
    expect(normalized).toContain("create schema if not exists agent_studio_private");
    expect(normalized).toContain("create or replace function agent_studio_private.request_authorized()");
    expect(normalized).toContain("grant usage on schema agent_studio_private to anon, service_role");
    expect(normalized).toContain("using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())");
    expect(normalized).toContain("drop function if exists public.agent_studio_request_authorized()");
    expect(normalized).not.toContain("grant execute on function public.agent_studio_request_authorized()");
    expect(normalized).toContain("create or replace function public.agent_studio_adopt_owner");
    expect(normalized).toContain("revoke all on function public.agent_studio_adopt_owner(text, text) from public, anon, authenticated");
    expect(normalized).toContain("grant execute on function public.agent_studio_adopt_owner(text, text) to anon, service_role");
  });

  it("preserves the source wallet when the target owner already has one", () => {
    expect(normalized).toContain("if not exists (select 1 from public.wallets where owner_id = p_to_owner_id) then update public.wallets set owner_id = p_to_owner_id where owner_id = p_from_owner_id");
    expect(normalized).not.toContain("delete from public.wallets where owner_id = p_from_owner_id");
  });
});
