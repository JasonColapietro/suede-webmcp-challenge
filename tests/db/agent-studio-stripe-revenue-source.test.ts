import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const migration = read(
  "docs/migrations/agent-studio-stripe-revenue-source.sql",
);
const normalized = migration.replace(/\s+/gu, " ").toLowerCase();
const rollback = read(
  "docs/migrations/agent-studio-stripe-revenue-source-disable-writes.sql",
);
const normalizedRollback = rollback.replace(/\s+/gu, " ").toLowerCase();
const architecture = read("docs/architecture/stripe-revenue-source.md");
const pending = read("docs/migrations/PENDING.md");
const templateText = read(
  "docs/migrations/agent-studio-stripe-revenue-backfill-request.template.json",
);
const template = JSON.parse(templateText) as {
  schema_version: string;
  project_id: string;
  expected_event_count: string;
  expected_total_amount_cents: string;
  events: Array<Record<string, unknown>>;
};

function section(start: string, end: string): string {
  const from = normalized.indexOf(start);
  const to = normalized.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return normalized.slice(from, to);
}

describe("Agent Studio Stripe revenue source migration", () => {
  it("is a prepared manual transaction with no login or credential", () => {
    expect(normalized).toContain(
      "manual migration only. apply after agent-studio-airbyte-source.sql",
    );
    expect(normalized).toContain(
      "begin; set local search_path = pg_catalog, pg_temp;",
    );
    expect(normalized.trimEnd().endsWith("commit;")).toBe(true);
    expect(normalized).not.toMatch(/\bcreate\s+(?:user|role)\b/u);
    expect(normalized).not.toMatch(/\bpassword\s+['"]/u);
    expect(normalized).not.toContain("extensions.gen_random_bytes");
    expect(normalized).toContain(
      "suede_agent_studio_airbyte_identity_hmac_v1",
    );
  });

  it("stores raw Stripe evidence only in an append-only private USD ledger", () => {
    expect(normalized).toContain(
      "create table if not exists airbyte_source_private.stripe_revenue_receipts",
    );
    for (const column of [
      "provider_event_id text not null",
      "provider_checkout_session_id text",
      "provider_payment_intent_id text not null",
      "provider_refund_id text",
      "amount_total_cents bigint not null",
      "currency text not null",
      "terminal_status text not null",
      "refund_state text not null",
      "provider_product_id text",
      "provider_price_id text",
      "occurred_at timestamp(3) with time zone not null",
      "source_revision_at timestamp(3) with time zone not null",
    ]) {
      expect(normalized).toContain(column);
    }
    expect(normalized).toContain("check (currency = 'usd')");
    expect(normalized).toContain(
      "before update or delete on airbyte_source_private.stripe_revenue_receipts",
    );
    expect(normalized).toContain(
      "perform pg_catalog.pg_advisory_xact_lock(1987202607, 31)",
    );
    expect(normalized).toContain(
      "max(receipts.source_revision_at) + interval '1 millisecond'",
    );
    expect(normalized).toContain(
      "constraint uq_stripe_revenue_source_revision unique (source_revision_at)",
    );
  });

  it("makes receipt and credit writes atomic while keeping cash independent", () => {
    expect(normalized).toContain(
      "('delta_usdc', 'numeric', 'no', 20, 8)",
    );
    expect(normalized).toContain(
      "columns.numeric_precision is not distinct from expected.numeric_precision",
    );
    expect(normalized).toContain(
      "columns.numeric_scale is not distinct from expected.numeric_scale",
    );
    expect(normalized).not.toContain("'delta_usdc', 'float4'");
    const writer = section(
      "create or replace function public.agent_studio_record_stripe_revenue_event(",
      "revoke all privileges on function public.agent_studio_record_stripe_revenue_event(",
    );
    expect(writer).toContain("security definer");
    expect(writer).toContain("set search_path = pg_catalog, pg_temp");
    expect(writer).toContain("set row_security = off");
    expect(writer).toContain("insert into public.credits");
    expect(writer).toContain(
      "insert into airbyte_source_private.stripe_revenue_receipts",
    );
    expect(writer).toContain("'stripe-receipt:' || v_receipt_id::text");
    expect(writer).toContain("p_amount_total_cents");
    expect(writer).toContain("p_credit_grant_usdc");
    expect(writer).toContain(
      "v_payment.credit_delta_usdc * v_refunded_cents::numeric / v_payment.amount_total_cents::numeric",
    );
    expect(writer).toContain(
      "v_target_reversed_credit := v_payment.credit_delta_usdc",
    );
    expect(writer).toContain(
      "return query select false, 0::numeric, 'none'::text",
    );
    expect(writer).toContain(
      "where credits.id = v_payment.credit_id for update",
    );
    expect(writer).toContain(
      "v_payment_credit_delta public.credits.delta_usdc%type",
    );
    expect(writer).toContain(
      "v_payment_credit_delta is distinct from v_payment.credit_delta_usdc",
    );
    expect(writer).not.toContain("v_payment_credit_delta::real");
    expect(writer).toContain("v_payment_credit_owner_id");
    expect(writer).toContain(
      "if not agent_studio_private.request_authorized()",
    );
    expect(writer).not.toContain("exception when others");
  });

  it("serializes owner adoption with delayed Stripe evidence", () => {
    expect(normalized).toContain(
      "create table if not exists airbyte_source_private.stripe_owner_adoptions",
    );
    expect(normalized).toContain(
      "before update or delete on airbyte_source_private.stripe_owner_adoptions",
    );
    expect(normalized).toContain(
      "create index if not exists idx_stripe_owner_adoptions_to on airbyte_source_private.stripe_owner_adoptions (to_owner_id)",
    );
    const resolver = section(
      "create or replace function airbyte_source_private.resolve_stripe_owner(",
      "revoke all privileges on function airbyte_source_private.resolve_stripe_owner(text)",
    );
    expect(resolver).toContain("language plpgsql volatile security definer");
    expect(resolver).toContain(
      "from airbyte_source_private.stripe_owner_adoptions as adoptions",
    );
    expect(resolver).toContain("for v_depth in 1..32 loop");
    expect(resolver).toContain(
      "agent studio stripe owner adoption cycle",
    );

    const stripeAdoption = section(
      "create or replace function airbyte_source_private.agent_studio_adopt_stripe_owner(",
      "revoke all privileges on function airbyte_source_private.agent_studio_adopt_stripe_owner(text, text)",
    );
    expect(stripeAdoption).toContain("security definer");
    expect(stripeAdoption).toContain("set search_path = pg_catalog, pg_temp");
    expect(stripeAdoption).toContain("set row_security = off");
    expect(stripeAdoption).toContain(
      "perform pg_catalog.pg_advisory_xact_lock(1987202607, 31)",
    );
    expect(stripeAdoption).toContain(
      "v_effective_target := airbyte_source_private.resolve_stripe_owner(p_to_owner_id)",
    );
    expect(stripeAdoption).toContain(
      "v_existing_effective_target := airbyte_source_private.resolve_stripe_owner(v_existing_target)",
    );
    expect(stripeAdoption).toContain(
      "v_existing_effective_target <> v_effective_target",
    );
    expect(stripeAdoption).toContain(
      "on adoptions.to_owner_id = ancestors.owner_id",
    );
    expect(stripeAdoption).toContain(
      "v_ancestor_depth + 1 + v_target_depth > 31",
    );
    expect(stripeAdoption).toContain(
      "agent studio owner adoption chain is too deep",
    );
    expect(stripeAdoption).toContain(
      "perform public.agent_studio_adopt_owner( p_from_owner_id, v_effective_target )",
    );
    expect(stripeAdoption).toContain(
      "insert into airbyte_source_private.stripe_owner_adoptions",
    );
    expect(stripeAdoption).toContain(
      "if not agent_studio_private.request_authorized()",
    );

    const adoption = section(
      "create or replace function public.agent_studio_adopt_owner_with_connections(",
      "revoke all privileges on function public.agent_studio_adopt_owner_with_connections(text, text)",
    );
    expect(adoption).toContain("security definer");
    expect(adoption).toContain("set search_path = pg_catalog, pg_temp");
    expect(adoption).toContain("set row_security = off");
    expect(adoption).toContain(
      "airbyte_source_private.agent_studio_adopt_stripe_owner( p_from_owner_id, p_to_owner_id )",
    );
    expect(adoption).toContain(
      "public.agent_studio_adopt_resource_owner(text,text)",
    );
    expect(adoption).toContain(
      "using p_from_owner_id,v_effective_target",
    );

    const writer = section(
      "create or replace function public.agent_studio_record_stripe_revenue_event(",
      "revoke all privileges on function public.agent_studio_record_stripe_revenue_event(",
    );
    expect(writer).toContain(
      "v_payment_owner_id := airbyte_source_private.resolve_stripe_owner(p_owner_id)",
    );
    expect(writer).toContain(
      "airbyte_source_private.resolve_stripe_owner( v_existing.owner_id ) <> v_payment_owner_id",
    );
    expect(normalized).toContain(
      "revoke all privileges on function public.agent_studio_adopt_owner(text, text) from public, anon, authenticated, service_role",
    );
    expect(normalized).toContain(
      "functions.provolatile = 'v'",
    );
    expect(normalized).toContain(
      "agent studio owner-adoption index drift",
    );
    expect(normalized).toContain(
      "perform airbyte_source_private.resolve_stripe_owner( adoptions.from_owner_id ) from airbyte_source_private.stripe_owner_adoptions as adoptions",
    );
    expect(architecture).toContain(
      "adoption wrapper and receipt writer share one transaction-level",
    );
    expect(architecture).toContain(
      "Raw aliases are private evidence and are never exported.",
    );
    expect(architecture).toContain(
      "Alias paths are capped at 31 edges.",
    );
    expect(architecture.replace(/\s+/gu, " ")).toContain(
      "A 32nd edge is rejected before credits, connections, or the alias ledger can change",
    );
  });

  it("fails closed if a pre-receipt handler tries a raw Stripe credit write", () => {
    expect(normalized).toContain(
      "create or replace function airbyte_source_private.reject_legacy_stripe_topup_credit()",
    );
    expect(normalized).toContain(
      "new.reason = 'stripe-topup' and pg_catalog.left(new.tx, 3) = 'cs_'",
    );
    expect(normalized).toContain(
      "create trigger agent_studio_reject_legacy_stripe_topup before insert on public.credits",
    );
    expect(normalized).toContain(
      "legacy agent studio stripe credit writes are disabled",
    );
    expect(normalized).toContain(
      "pg_catalog.pg_try_advisory_xact_lock(1987202607, 31)",
    );
    expect(normalized).toContain(
      "create trigger agent_studio_serialize_credit_updates before update on public.credits for each statement",
    );
    expect(normalizedRollback).toContain(
      "agent_studio_reject_legacy_stripe_topup",
    );
    expect(architecture).toContain(
      "Application rollback is forward-fix-only for the Stripe webhook.",
    );
  });

  it("exports the exact 26-column Marketing revenue schema", () => {
    const match = migration.match(
      /create or replace function\s+airbyte_source\.read_normalized_revenue_events\(\)\s+returns table\s*\(([\s\S]*?)\)\s*language plpgsql/u,
    );
    expect(match).not.toBeNull();
    const columns = match![1]
      .split(",")
      .map((definition) => definition.trim().split(/\s+/u)[0]);
    expect(columns).toEqual([
      "event_id",
      "occurred_at",
      "source_revision_at",
      "project_id",
      "event_name",
      "currency",
      "gross_amount_cents",
      "net_amount_cents",
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
      "external_transaction_ref",
      "status",
      "refund_state",
      "subscription_state",
      "product_id",
      "price_id",
      "settlement_state",
    ]);
    expect(match![1]).toContain(
      "occurred_at timestamp(3) with time zone",
    );
    expect(match![1]).toContain(
      "source_revision_at timestamp(3) with time zone",
    );
    expect(match![1]).toContain("gross_amount_cents bigint");
    expect(match![1]).toContain("net_amount_cents bigint");
    expect(normalized).toContain(
      "create or replace view airbyte_source.normalized_revenue_events with (security_invoker = true, security_barrier = true)",
    );
  });

  it("HMACs every reader-facing identity and exports no private identifier column", () => {
    const reader = section(
      "create or replace function airbyte_source.read_normalized_revenue_events()",
      "revoke all privileges on function airbyte_source.read_normalized_revenue_events()",
    );
    expect(reader).toContain(
      "airbyte_source_private.hmac_sha256( 'stripe:event:agent_studio_receipt', receipts.provider_event_id ) as event_id",
    );
    expect(reader).toContain(
      "airbyte_source_private.hmac_sha256( 'stripe:account:agent_studio_owner', receipts.owner_id ) as account_key",
    );
    expect(reader).toContain(
      "airbyte_source_private.hmac_sha256( 'stripe:transaction:agent_studio'",
    );
    expect(reader).toContain(
      "'suede-agent-studio'::text as project_id",
    );
    expect(reader).not.toMatch(
      /\bas\s+(?:owner_id|provider_event_id|provider_checkout_session_id|provider_payment_intent_id|provider_refund_id|customer_id|payer|wallet)\b/u,
    );
    expect(reader).not.toContain("credit_delta_usdc");
    expect(reader).not.toContain("settlements");
    expect(reader).not.toContain("x402");
    expect(reader).toContain(
      "when 'payment' then receipts.amount_total_cents else -receipts.amount_total_cents",
    );
  });

  it("enforces the reader/runtime privilege split", () => {
    expect(normalized).toContain(
      "grant execute on function public.agent_studio_record_stripe_revenue_event",
    );
    expect(normalized).toContain("to anon, service_role");
    expect(normalized).toContain(
      "create or replace function public.agent_studio_has_paid_entitlement(",
    );
    const entitlement = section(
      "create or replace function public.agent_studio_has_paid_entitlement(",
      "revoke all privileges on function public.agent_studio_has_paid_entitlement(text)",
    );
    expect(entitlement).toContain("returns boolean");
    expect(entitlement).toContain("security definer");
    expect(entitlement).toContain("set search_path = pg_catalog, pg_temp");
    expect(entitlement).toContain("set row_security = off");
    expect(entitlement).toContain(
      "credits.reason not in ('stripe-topup', 'stripe-refund')",
    );
    expect(entitlement).toContain(
      "pg_catalog.sum(receipts.credit_delta_usdc)",
    );
    expect(entitlement).toContain(
      "join public.credits as credits on credits.id = receipts.credit_id",
    );
    expect(entitlement).toContain(
      "where receipts.credit_id = credits.id",
    );
    expect(entitlement).toContain(
      "if not agent_studio_private.request_authorized()",
    );
    expect(normalized).toContain(
      "grant execute on function public.agent_studio_has_paid_entitlement(text) to anon, service_role",
    );
    expect(normalized).toContain(
      "create index if not exists idx_credits_paid_entitlement_non_stripe on public.credits (owner_id)",
    );
    expect(normalized).toContain(
      "agent studio paid-entitlement index drift",
    );
    expect(normalized).toContain(
      "grant select on table airbyte_source.normalized_revenue_events to suede_agent_studio_airbyte_reader",
    );
    expect(normalized).toContain(
      "grant execute on function airbyte_source.read_normalized_revenue_events() to suede_agent_studio_airbyte_reader",
    );
    expect(normalized).toContain(
      "if not pg_catalog.pg_has_role( session_user, 'suede_agent_studio_airbyte_reader', 'member' )",
    );
    expect(normalized).toContain(
      "memberships.roleid = v_role.oid",
    );
    expect(normalized).toContain(
      "members.rolname = 'suede_agent_studio_airbyte_login'",
    );
    expect(normalized).toContain(
      "agent studio airbyte revenue reader membership drift",
    );
    expect(normalized).toContain("acl.grantee = 0");
    expect(normalized).not.toMatch(
      /grant\s+execute\s+on\s+function\s+airbyte_source_private\.backfill_two_verified_stripe_topups/u,
    );
  });

  it("provides an identifier-free exact-two-session backfill template", () => {
    expect(template.schema_version).toBe("1");
    expect(template.project_id).toBe("suede-agent-studio");
    expect(template.expected_event_count).toBe("2");
    expect(template.expected_total_amount_cents).toBe("1000");
    expect(template.events).toHaveLength(2);
    expect(template.events.map((event) => event.slot)).toEqual([1, 2]);
    for (const event of template.events) {
      expect(event.amount_total_cents).toBe(500);
      expect(event.currency).toBe("USD");
      expect(event.terminal_status).toBe("paid");
      expect(event.refund_state).toBe("none");
      expect(Object.keys(event)).toHaveLength(12);
    }
    expect(templateText).not.toMatch(
      /\b(?:evt|cs|pi|re)_[A-Za-z0-9_]{6,}\b/u,
    );
    expect(templateText).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    );
    expect(normalized).toContain(
      "pg_catalog.jsonb_array_length(p_request->'events') <> 2",
    );
    expect(normalized).toContain(
      "p_request->>'expected_total_amount_cents' <> '1000'",
    );
    expect(normalized).toContain("v_row.amount_total_cents <> 500");
    expect(normalized).toContain(
      "stripe backfill requires two distinct transactions",
    );
    expect(normalized).toContain(
      "stripe backfill did not reconcile exactly two sessions",
    );
    for (const replayEvidence of [
      "v_existing.provider_event_id <> v_row.provider_event_id",
      "v_existing.provider_product_id is distinct from v_row.product_id",
      "v_existing.provider_price_id is distinct from v_row.price_id",
      "v_existing.occurred_at is distinct from v_row.occurred_at",
      "v_credit.reason <> 'stripe-topup'",
      "v_credit.tx <> ( 'stripe-receipt:' || v_existing.receipt_id::text )",
    ]) {
      expect(normalized).toContain(replayEvidence);
    }
    expect(architecture).toContain(
      "do not create a public/runtime backfill wrapper",
    );
  });

  it("ships a non-destructive write-stop and a no-live-write runbook", () => {
    expect(normalizedRollback).toContain(
      "revoke execute on function public.agent_studio_record_stripe_revenue_event",
    );
    expect(normalizedRollback).toContain("from anon, service_role");
    expect(normalizedRollback).not.toContain(
      "agent_studio_has_paid_entitlement",
    );
    expect(normalizedRollback).toContain(
      "not pg_catalog.has_function_privilege( 'service_role', 'public.agent_studio_adopt_owner_with_connections(text,text)', 'execute' )",
    );
    expect(normalizedRollback).toContain(
      "stripe_owner_adoptions_append_only",
    );
    expect(normalizedRollback).not.toMatch(/\bdrop\s+(?:table|view|function)\b/u);
    expect(normalizedRollback).not.toMatch(
      /\b(?:delete|truncate)\s+(?:from\s+)?airbyte_source_private\.stripe_revenue_receipts\b/u,
    );
    expect(architecture).toContain("Status: prepared, not applied.");
    expect(architecture.replace(/\s+/gu, " ")).toContain(
      "This invocation is a production write and requires separate explicit approval",
    );
    expect(architecture.replace(/\s+/gu, " ")).toContain(
      "The x402 USDC settlement rail remains unrepresented",
    );
    expect(architecture).toContain("airbyte-stripe-revenue/v1");
    expect(architecture).toContain("agent_studio_stripe_");
    expect(architecture).toContain(
      "airbyte_landing.agent_studio_stripe_normalized_revenue_events",
    );
    expect(pending).toContain(
      "## Agent Studio Stripe revenue source — prepared, not applied",
    );
  });
});
