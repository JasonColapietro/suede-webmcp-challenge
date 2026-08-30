import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "docs/migrations/agent-studio-airbyte-source.sql",
  ),
  "utf8",
);
const normalized = migration.replace(/\s+/gu, " ").toLowerCase();
const architecture = readFileSync(
  join(
    process.cwd(),
    "docs/architecture/airbyte-marketing-source.md",
  ),
  "utf8",
);
const pending = readFileSync(
  join(process.cwd(), "docs/migrations/PENDING.md"),
  "utf8",
);
const triggerDisableRollback = readFileSync(
  join(
    process.cwd(),
    "docs/migrations/agent-studio-airbyte-source-disable-triggers.sql",
  ),
  "utf8",
);
const normalizedTriggerDisableRollback = triggerDisableRollback
  .replace(/\s+/gu, " ")
  .toLowerCase();

function section(start: string, end: string): string {
  const from = normalized.indexOf(start);
  const to = normalized.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return normalized.slice(from, to);
}

describe("Agent Studio Airbyte privacy source migration", () => {
  it("is one manual transaction and never embeds or creates a login secret", () => {
    expect(normalized.startsWith("-- privacy-safe")).toBe(true);
    expect(normalized).toContain("begin; set local search_path = pg_catalog, pg_temp;");
    expect(normalized).toContain("set local createrole_self_grant = ''");
    expect(normalized.trimEnd().endsWith("commit;")).toBe(true);
    expect(normalized).not.toContain("create role suede_agent_studio_airbyte_login");
    expect(normalized).not.toMatch(/\bpassword\s+['"]/u);
    expect(normalized).toContain(
      "it intentionally does not create a login or contain a password",
    );
  });

  it("fails closed on the exact required production source shapes", () => {
    for (const required of [
      "('agents', 'id', 'uuid', 'no')",
      "('agents', 'flow_id', 'uuid', 'no')",
      "('agents', 'status', 'text', 'no')",
      "('runs', 'trigger', 'text', 'no')",
      "('runs', 'agent_id', 'uuid', 'yes')",
      "('runs', 'finished_at', 'timestamptz', 'yes')",
      "('runs', 'settled_at', 'text', 'yes')",
      "('deployments', 'flow_version_id', 'uuid', 'no')",
      "('environments', 'kind', 'text', 'no')",
      "('flow_versions', 'version_number', 'int4', 'no')",
      "('settlements', 'created_at', 'text', 'no')",
    ]) {
      expect(normalized).toContain(required);
    }
    expect(normalized).toContain(
      "agent studio airbyte source-column drift",
    );
    expect(normalized).toContain(
      "pg_input_is_valid( settlements.created_at, 'timestamp with time zone' )",
    );
    expect(normalized).toContain(
      "agent studio airbyte source requires permanent ordinary tables",
    );
  });

  it("creates a strict NOLOGIN capability role with no unsafe inheritance", () => {
    const roleBlock = section(
      "do $migration$ declare v_role record;",
      "do $migration$ declare v_secret_count integer;",
    );
    expect(roleBlock).toContain(
      "create role suede_agent_studio_airbyte_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    );
    expect(roleBlock).toContain("from pg_catalog.pg_auth_members where member = v_role.oid");
    expect(roleBlock).toContain(
      "members.rolname = 'suede_agent_studio_airbyte_login' and not memberships.admin_option and memberships.inherit_option and not memberships.set_option",
    );
    expect(roleBlock).toContain(
      "not v_migration_super and v_migration_createrole and memberships.member = v_migration_oid and memberships.admin_option and not memberships.inherit_option and not memberships.set_option",
    );
    expect(roleBlock).toContain(
      "not v_migration_super and v_migration_createrole and not exists",
    );
    expect(roleBlock).toContain(
      "from pg_catalog.pg_shdepend as dependencies",
    );
    expect(roleBlock).toContain(
      "dependencies.refobjid = v_role.oid and dependencies.deptype = 'o'",
    );
    expect(roleBlock).toContain("pg_catalog.pg_default_acl");
    expect(roleBlock).toContain(
      "has unsafe attributes, memberships, or grants",
    );

    expect(normalized).toContain(
      "grant usage on schema airbyte_source to suede_agent_studio_airbyte_reader",
    );
    expect(normalized).toContain(
      "grant select on table airbyte_source.normalized_agent_outcomes to suede_agent_studio_airbyte_reader",
    );
    expect(normalized).toContain(
      "grant execute on function airbyte_source.read_normalized_agent_outcomes() to suede_agent_studio_airbyte_reader",
    );
    expect(normalized).toContain(
      "agent studio airbyte direct function grants are not exact",
    );
    expect(normalized).toContain(
      "agent studio airbyte direct schema grants are not exact",
    );
    expect(normalized).toContain(
      "agent studio airbyte direct relation grants are not exact",
    );
    expect(normalized).not.toMatch(
      /grant\s+(?:select|insert|update|delete)[^;]*public\.(?:agents|runs|deployments|settlements)[^;]*suede_agent_studio_airbyte_reader/u,
    );
  });

  it("keeps HMAC key material inside Vault and private routines", () => {
    expect(normalized).toContain(
      "suede_agent_studio_airbyte_identity_hmac_v1",
    );
    expect(normalized).toContain(
      "extensions.gen_random_bytes(32)",
    );
    expect(normalized).toContain(
      "from vault.decrypted_secrets",
    );
    expect(normalized).toContain(
      "extensions.hmac(",
    );
    expect(normalized).toContain(
      "revoke all privileges on function airbyte_source_private.hmac_sha256(text, text) from public, anon, authenticated, service_role, suede_agent_studio_airbyte_reader",
    );
    expect(normalized).not.toMatch(/[0-9a-f]{64}['"]\s*,\s*['"]suede_agent_studio_airbyte_identity_hmac_v1/u);
  });

  it("uses an append-only ledger and millisecond commit-serialized cursors", () => {
    expect(normalized).toContain(
      "constraint uq_agent_outcome_events_source_revision unique (source_revision_at)",
    );
    expect(normalized).toContain(
      "occurred_at timestamp(3) with time zone not null",
    );
    expect(normalized).toContain(
      "source_revision_at timestamp(3) with time zone not null",
    );
    expect(normalized).toContain(
      "before update or delete on airbyte_source_private.agent_outcome_events",
    );
    expect(normalized).toContain(
      "perform pg_catalog.pg_advisory_xact_lock(1987202607, 30)",
    );
    expect(normalized).toContain(
      "max(events.source_revision_at) + interval '1 millisecond'",
    );
    expect(normalized).toContain(
      "v_occurred_at := pg_catalog.date_trunc('milliseconds', p_occurred_at)",
    );
    expect(normalized).toContain(
      "pg_catalog.date_trunc( 'milliseconds', pg_catalog.clock_timestamp() )",
    );
    expect(normalized).not.toContain("interval '1 microsecond'");
    expect(normalized).toContain(
      "on conflict (dedupe_key) do nothing",
    );
    expect(normalized).toContain(
      "source_revision_at < events.occurred_at",
    );
    expect(normalized).toContain(
      "events.source_revision_at <> pg_catalog.date_trunc( 'milliseconds', events.source_revision_at )",
    );
  });

  it("maps only evidence-backed product outcomes", () => {
    for (const eventName of [
      "agent_drafted",
      "agent_published",
      "test_run_completed",
      "test_deployed",
      "live_deployed",
      "paid_call_settled",
    ]) {
      expect(normalized).toContain(`'${eventName}'`);
    }
    expect(normalized).toContain(
      "new.trigger <> 'test' or new.status <> 'done'",
    );
    expect(normalized).toContain(
      "where runs.trigger = 'test' and runs.status = 'done'",
    );
    expect(normalized).toContain(
      "where runs.id::text = new.run_id for update of runs",
    );
    expect(normalized).toContain(
      "on agents.id = runs.agent_id and agents.id::text = new.agent_id",
    );
    expect(normalized).toContain(
      "v_snapshot_observed_at constant timestamp with time zone := pg_catalog.statement_timestamp()",
    );
    expect(normalized).toContain(
      "'backfill-current-v1', v_row.flow_id::text, v_snapshot_observed_at",
    );
    expect(normalized).toContain(
      "coalesce(new.finished_at, pg_catalog.clock_timestamp())",
    );
    expect(normalized).toContain(
      "coalesce(v_row.finished_at, v_snapshot_observed_at)",
    );
    expect(normalized).not.toMatch(
      /runs\.trigger\s+in\s*\([^)]*manual/gu,
    );
  });

  it("converges settlement evidence in either write order", () => {
    const settlementInsertCapture = section(
      "create or replace function airbyte_source_private.capture_settlement_outcome()",
      "create or replace function airbyte_source_private.capture_settled_run_outcome()",
    );
    const settledRunCapture = section(
      "create or replace function airbyte_source_private.capture_settled_run_outcome()",
      "revoke all privileges on function airbyte_source_private.capture_agent_outcome()",
    );
    expect(settlementInsertCapture).toContain(
      "select runs.flow_id, runs.settled_at into v_flow_id, v_settled_at",
    );
    expect(settlementInsertCapture).toContain(
      "where runs.id::text = new.run_id for update of runs",
    );
    expect(settlementInsertCapture).toContain(
      "if v_flow_id is null or v_settled_at is null then return new",
    );
    expect(settledRunCapture).toContain(
      "where settlements.run_id = new.id::text and settlements.agent_id = new.agent_id::text",
    );
    expect(settlementInsertCapture).toContain(
      "'settlement', new.run_id, 'terminal-v1'",
    );
    expect(settledRunCapture).toContain(
      "'settlement', new.id::text, 'terminal-v1'",
    );
    expect(normalized).toContain(
      "create trigger agent_studio_airbyte_settled_runs after update of settled_at on public.runs",
    );
    expect(normalized.match(/'terminal-v1'/gu)).toHaveLength(3);
  });

  it("exposes the exact Marketing bridge column order and scalar types", () => {
    const view = section(
      "create or replace view airbyte_source.normalized_agent_outcomes",
      "revoke all privileges on table airbyte_source.normalized_agent_outcomes",
    );
    const columns = [
      "event_id",
      "occurred_at",
      "source_revision_at",
      "project_id",
      "event_name",
      "lifecycle_stage",
      "channel",
      "anonymous_person_key",
      "account_key",
      "campaign_id",
      "ad_set_id",
      "ad_id",
      "creative_id",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "click_id",
      "session_key",
      "touch_order",
      "attribution_model",
      "plan",
      "product_version",
      "template_id",
      "experiment_id",
      "variant_id",
      "outcome",
      "state",
      "delivery_state",
      "campaign_ref",
      "lead_quality_score",
    ];
    let cursor = -1;
    for (const column of columns) {
      const next = view.indexOf(column, cursor + 1);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(normalized).toContain(
      "with (security_invoker = true, security_barrier = true)",
    );
    expect(normalized).toContain(
      "columns.column_name in ( 'occurred_at', 'source_revision_at' ) and ( columns.udt_name <> 'timestamptz' or columns.datetime_precision <> 3 )",
    );
    expect(normalized).toContain(
      "columns.column_name in ( 'touch_order', 'lead_quality_score' ) and columns.udt_name <> 'int4'",
    );
  });

  it("normalizes every owner and rejects every unexpected grantee", () => {
    for (const ownerStatement of [
      "alter table airbyte_source_private.agent_outcome_events owner to current_user",
      "alter sequence airbyte_source_private.agent_outcome_events_ledger_id_seq owner to current_user",
      "alter function airbyte_source_private.hmac_sha256(text, text) owner to current_user",
      "alter function airbyte_source_private.capture_settled_run_outcome() owner to current_user",
      "alter function airbyte_source.read_normalized_agent_outcomes() owner to current_user",
      "alter view airbyte_source.normalized_agent_outcomes owner to current_user",
    ]) {
      expect(normalized).toContain(ownerStatement);
    }
    expect(normalized).toContain(
      "cross join lateral pg_catalog.aclexplode(namespaces.nspacl) as acl",
    );
    expect(normalized).toContain(
      "cross join lateral pg_catalog.aclexplode(relations.relacl) as acl",
    );
    expect(normalized).toContain(
      "cross join lateral pg_catalog.aclexplode(functions.proacl) as acl",
    );
    expect(normalized).toContain(
      "alter default privileges for role %i in schema %i revoke all privileges on %s from %s",
    );
    for (const assertion of [
      "agent studio airbyte object-owner drift",
      "agent studio airbyte reader membership drift",
      "agent studio airbyte unexpected schema grantee",
      "agent studio airbyte unexpected relation grantee",
      "agent studio airbyte unexpected function grantee",
      "agent studio airbyte default-acl drift",
    ]) {
      expect(normalized).toContain(assertion);
    }
    expect(normalized).toContain(
      "not v_owner_super and v_owner_createrole and memberships.member = v_owner_oid and memberships.admin_option and not memberships.inherit_option and not memberships.set_option",
    );
    expect(normalized).toContain(
      "not v_owner_super and v_owner_createrole and not exists",
    );
  });

  it("returns no direct identity, graph, prompt, output, error, or payment fields", () => {
    const reader = section(
      "create or replace function airbyte_source.read_normalized_agent_outcomes()",
      "revoke all privileges on function airbyte_source.read_normalized_agent_outcomes()",
    );
    expect(reader).toContain("'suede-agent-studio'::text as project_id");
    expect(reader).toContain("'product'::text as channel");
    expect(reader).toContain("null::text as anonymous_person_key");
    for (const forbidden of [
      "owner_id",
      "slug",
      "name",
      "email",
      "phone",
      "graph",
      "trigger_input",
      "run_variables",
      "output",
      "error",
      "wallet",
      "payer",
      "pay_to",
      "transaction",
      "access_token",
      "api_key",
    ]) {
      expect(reader).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`, "u"),
      );
    }
    expect(reader).not.toMatch(/\btx\b/u);
  });

  it("pins the separate Airbyte login and destination contract in docs", () => {
    expect(architecture).toContain(
      "create role suede_agent_studio_airbyte_login",
    );
    expect(architecture).toContain(
      "grant suede_agent_studio_airbyte_reader",
    );
    expect(architecture).toContain(
      "with admin false, inherit true, set false",
    );
    expect(architecture).toContain(
      "set default_transaction_read_only = 'on'",
    );
    expect(architecture).toContain(
      "stream: normalized_agent_outcomes",
    );
    expect(architecture).toContain(
      "cursor: source_revision_at",
    );
    expect(architecture).toContain(
      "destination prefix: agent_studio_db_",
    );
    expect(architecture).toContain(
      "airbyte_landing.agent_studio_db_normalized_agent_outcomes",
    );
    expect(architecture).toContain(
      "adapter: airbyte-agent-studio-outcomes/v1",
    );
    expect(pending).toContain(
      "Agent Studio Airbyte outcome source — applied and read back 2026-07-29",
    );
    expect(pending).toContain(
      "twice, disable triggers, and reapply",
    );
  });

  it("ships an executable trigger-disable rollback that preserves evidence", () => {
    expect(normalizedTriggerDisableRollback).toContain(
      "begin; set local search_path = pg_catalog, pg_temp;",
    );
    expect(normalizedTriggerDisableRollback.trimEnd().endsWith("commit;")).toBe(
      true,
    );
    expect(normalizedTriggerDisableRollback).toContain(
      "select pg_catalog.pg_advisory_xact_lock(1987202607, 29)",
    );
    expect(normalizedTriggerDisableRollback).toContain(
      "select pg_catalog.pg_advisory_xact_lock(1987202607, 30)",
    );
    for (const trigger of [
      "agent_studio_airbyte_agents",
      "agent_studio_airbyte_test_runs",
      "agent_studio_airbyte_settled_runs",
      "agent_studio_airbyte_deployments",
      "agent_studio_airbyte_settlements",
    ]) {
      expect(normalizedTriggerDisableRollback).toContain(
        `drop trigger if exists ${trigger}`,
      );
    }
    expect(normalizedTriggerDisableRollback).toContain(
      "agent studio airbyte application trigger disable did not complete",
    );
    expect(normalizedTriggerDisableRollback).not.toMatch(
      /\bdrop\s+(?:table|schema|role|function|view|sequence)\b/gu,
    );
    expect(normalizedTriggerDisableRollback).not.toContain(
      "agent_outcome_events_append_only",
    );
  });
});
