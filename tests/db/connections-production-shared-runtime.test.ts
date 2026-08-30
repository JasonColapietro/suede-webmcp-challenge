import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sharedSql = readFileSync(
  join(process.cwd(), "docs/migrations/connections-production-shared-runtime.sql"),
  "utf8",
);
const shared = sharedSql.replace(/\s+/gu, " ").toLowerCase();

function section(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("hosted connections production shared runtime", () => {
  it("requires every configured envelope field to be non-null before byte checks", () => {
    const slotState = section(
      shared,
      "constraint connection_slots_state_check check",
      "create index if not exists idx_connections_owner_updated",
    );
    for (const field of ["key_version", "nonce", "ciphertext", "auth_tag"] as const) {
      expect(slotState).toContain(`${field} is not null`);
    }
    expect(slotState).toContain("key_version = 1");
    expect(slotState).toContain("octet_length(nonce) = 12");
    expect(slotState).toContain("octet_length(ciphertext) between 1 and 32768");
    expect(slotState).toContain("octet_length(auth_tag) = 16");
  });

  it("keeps Authorization available while rejecting proxy authorization metadata", () => {
    const validator = section(
      shared,
      "create or replace function public.agent_studio_connection_public_config_valid",
      "create table if not exists public.connections",
    );
    expect(validator).toContain(
      "return coalesce(p_config = jsonb_build_object('headername', header_name)",
    );
    expect(validator).toContain("]::text[]), false)");
    expect(validator).toContain("'proxy-authorization'");
    expect(validator).not.toContain("'authorization'");
  });

  it("uses row-locked transactional RPCs for slot configuration and revocation", () => {
    const configure = section(
      shared,
      "create or replace function public.agent_studio_configure_connection_slot",
      "create or replace function public.agent_studio_revoke_connection_slot",
    );
    expect(configure.match(/for update/gu)).toHaveLength(2);
    expect(configure).toContain("current_connection.lifecycle_revision <> p_expected_lifecycle_revision");
    expect(configure).toContain("p_expected_secret_version <> coalesce(current_slot.secret_version, 0) + 1");
    expect(configure).toContain("update public.connection_slots");
    expect(configure).toContain("update public.connections set lifecycle_revision = lifecycle_revision + 1");
    expect(configure).toContain("return 'updated'");

    const revoke = section(
      shared,
      "create or replace function public.agent_studio_revoke_connection_slot",
      "create or replace function public.agent_studio_connection_usage_artifacts",
    );
    expect(revoke.match(/for update/gu)).toHaveLength(2);
    expect(revoke).toContain("set status = 'revoked', key_version = null, nonce = null, ciphertext = null");
    expect(revoke).toContain("update public.connections set lifecycle_revision = lifecycle_revision + 1");
    expect(revoke).toContain("return 'updated'");
  });

  it("monotonicizes connection and slot timestamps inside the database", () => {
    const connectionGuard = section(
      shared,
      "create or replace function public.agent_studio_guard_connection_update",
      "create or replace function public.agent_studio_guard_connection_slot_update",
    );
    expect(connectionGuard).toContain("if old.updated_at >= 9007199254740991 then");
    expect(connectionGuard).toContain("raise exception 'connection timestamp exhausted' using errcode = '22003'");
    expect(connectionGuard).toContain(
      "if new.updated_at is null or new.updated_at not between 0 and 9007199254740991 then",
    );
    expect(connectionGuard).toContain("effective_now := greatest(old.updated_at + 1, new.updated_at)");
    expect(connectionGuard).toContain("new.updated_at := effective_now");

    const slotGuard = section(
      shared,
      "create or replace function public.agent_studio_guard_connection_slot_update",
      "drop trigger if exists connections_guard_update",
    );
    expect(slotGuard).toContain("if old.updated_at >= 9007199254740991 then");
    expect(slotGuard).toContain("raise exception 'connection slot timestamp exhausted' using errcode = '22003'");
    expect(slotGuard).toContain(
      "if new.updated_at is null or new.updated_at not between 0 and 9007199254740991 then",
    );
    expect(slotGuard).toContain("effective_now := greatest(old.updated_at + 1, new.updated_at)");
    expect(slotGuard).toContain("new.updated_at := effective_now");
    expect(slotGuard).toContain("new.configured_at := effective_now");
    expect(slotGuard).toContain("new.revoked_at := null");
    expect(slotGuard).toContain("new.configured_at := old.configured_at");
    expect(slotGuard).toContain("new.revoked_at := effective_now");

    const configure = section(
      shared,
      "create or replace function public.agent_studio_configure_connection_slot",
      "create or replace function public.agent_studio_revoke_connection_slot",
    );
    const revoke = section(
      shared,
      "create or replace function public.agent_studio_revoke_connection_slot",
      "create or replace function public.agent_studio_connection_usage_artifacts",
    );
    for (const mutation of [configure, revoke]) {
      expect(mutation).toContain("p_now is null");
      expect(mutation).toContain("p_now not between 0 and 9007199254740991");
    }

    const adoption = section(
      shared,
      "create or replace function public.agent_studio_adopt_owner_with_connections",
      "alter table public.connections enable row level security",
    );
    expect(adoption).toContain("connection.updated_at + 1");
    expect(adoption).toContain("extract(epoch from clock_timestamp())");
  });

  it("hydrates usage sequentially and stops before later graph payloads exceed a bound", () => {
    const usage = section(
      shared,
      "create or replace function public.agent_studio_connection_usage_artifacts",
      "create or replace function public.agent_studio_adopt_owner_with_connections",
    );
    expect(usage).toContain("p_artifact_limit not between 1 and 501");
    expect(usage).toContain("p_graph_byte_limit not between 1 and 2097152");
    expect(usage).toContain("p_total_byte_limit not between 1 and 16777216");
    expect(usage).toContain("p_artifact_limit is null or p_artifact_limit not between 1 and 501");
    expect(usage).toContain("p_graph_byte_limit is null or p_graph_byte_limit not between 1 and 2097152");
    expect(usage).toContain("p_total_byte_limit is null or p_total_byte_limit not between 1 and 16777216");
    expect(usage).toContain("raise exception 'invalid connection usage cursor'");
    expect(usage).toContain("p_cursor_environment is distinct from 'draft'");
    expect(usage).toContain("p_cursor_flow_version_id is null or p_cursor_environment is null");
    expect(usage).toContain("p_cursor_environment not in ('test', 'live')");
    expect(usage).toContain("limit p_artifact_limit + 1");
    expect(usage).toContain("artifact_items jsonb[] := array[]::jsonb[]");
    expect(usage).toContain("for candidate in");
    expect(usage).toContain("if artifact_count >= p_artifact_limit then result_truncated := true; exit");
    expect(usage).toContain("select draft.graph::text into graph_text");
    expect(usage).toContain("select version.graph::text into graph_text");
    expect(usage).toContain("if not found or graph_text is null then");
    expect(usage).toContain("graph_bytes := octet_length(convert_to(graph_text, 'utf8'))");
    expect(usage).toContain("if graph_bytes > p_graph_byte_limit then");
    expect(usage).toContain("if cumulative_bytes + graph_bytes > p_total_byte_limit then");
    expect(usage).toContain("artifact_payload := to_jsonb(artifact_items)");
    expect(usage).toContain("'truncated', result_truncated");
    expect(usage).not.toContain("hydrated as (");
    expect(usage).not.toContain("sum(graph_bytes) over");
    expect(usage).not.toContain("jsonb_agg(");
  });

  it("adds only the reviewed shared request-secret policy and runtime ACLs", () => {
    expect(shared).toContain("to_regprocedure('agent_studio_private.request_authorized()')");
    expect(shared).toContain("adoption_security_definer is distinct from false");
    expect(shared).toContain("'search_path=pg_catalog, public, extensions'");
    expect(shared).toContain("adoption_owner is distinct from trusted_owner");
    expect(shared).toContain("'public.agent_studio_adopt_owner(text,text)'");
    expect(shared).toContain("has_function_privilege( 'authenticated'");
    expect(shared).toContain("schema_revision = 'shared-runtime-v2'");
    for (const table of ["connections", "connection_slots"] as const) {
      expect(shared).toContain(
        `create policy agent_studio_server_access on public.${table} for all to anon using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized());`,
      );
    }
    expect(shared).toContain(
      "grant select, insert, update on table public.connections, public.connection_slots to anon, service_role;",
    );
    expect(shared).toContain(
      "revoke delete, truncate, references, trigger on table public.connections, public.connection_slots from anon, service_role;",
    );
    expect(shared).not.toContain("to authenticated");
  });

  it("adopts access ownership without rewriting the cryptographic owner", () => {
    const adoption = section(
      shared,
      "create or replace function public.agent_studio_adopt_owner_with_connections",
      "alter table public.connections enable row level security",
    );
    expect(adoption).toContain("perform public.agent_studio_adopt_owner(p_from_owner_id, p_to_owner_id)");
    expect(adoption).toContain("set owner_id = p_to_owner_id");
    expect(adoption).toContain("lifecycle_revision = connection.lifecycle_revision + 1");
    expect(adoption).not.toContain("crypto_owner_id =");
    expect(adoption).not.toContain("ciphertext =");
  });

  it("contains fail-closed physical, column, constraint, index, policy, and privilege readback", () => {
    expect(shared).toContain("authorizer_security_definer is distinct from true");
    expect(shared).toContain("has_schema_privilege('anon', 'agent_studio_private', 'usage')");
    expect(shared).toContain("tables.relowner = (");
    expect(shared).toContain("tables.relpersistence = 'p'");
    expect(shared).toContain("columns.column_default is null");
    expect(shared).toContain("agent studio connection exact column/type/default drift");
    expect(shared).toContain("connection_columns is distinct from array[");
    expect(shared).toContain("'id','owner_id','crypto_owner_id','name','kind','public_config','schema_version'");
    expect(shared).toContain("slot_columns is distinct from array[");
    expect(shared).toContain("pg_get_constraintdef(constraints.oid)");
    expect(shared).toContain("agent studio connection exact constraint definition drift");
    expect(shared).toContain("'idx_connections_owner_updated'");
    expect(shared).toContain("'idx_connections_owner_name'");
    expect(shared).toContain("index_meta.indisvalid is true");
    expect(shared).toContain("explicit_index_count <> 3");
    expect(shared).toContain("agent studio connection exact index definition drift");
    expect(shared).toContain("agent studio connection shared-runtime policy readback failed");
    expect(shared).toContain("agent studio connection table has unexpected rls policies");
    expect(shared).toContain("agent studio connection table privilege readback failed");
    expect(shared).toContain("agent studio connection runtime grants are incomplete");
    expect(shared).toContain(
      "grants.grantee in ('anon','service_role') and grants.privilege_type in ('select','insert','update')",
    );
  });
});
