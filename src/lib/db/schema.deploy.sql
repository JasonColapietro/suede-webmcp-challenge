-- Agentix deploy schema (serverless / Vercel).
-- No Supabase Auth dependency: owner is a plain text id ('dev-user') until real
-- auth is wired. All access is server-side via the service-role key, which
-- bypasses RLS; RLS is enabled with no policies so the anon key has no access.
create extension if not exists pgcrypto;

create table if not exists flows (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null default 'dev-user',
  name text not null,
  graph jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references flows (id) on delete cascade,
  slug text unique not null,
  status text not null default 'draft',
  price_usdc numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references flows (id) on delete cascade,
  agent_id uuid references agents (id) on delete set null,
  trigger text not null,
  status text not null default 'running',
  total_cost_usdc numeric not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete cascade,
  node_id text not null,
  node_type text not null,
  status text not null,
  cost_usdc numeric not null default 0,
  output jsonb,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists schedules (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (id) on delete cascade,
  cron text not null,
  enabled boolean not null default true,
  last_run_at timestamptz
);

-- One atomic Guided save: flow graph/name, agent price, and schedule sidecar.
-- The exact prior revision is locked and checked before any row changes.
create or replace function agent_studio_mutate_guided_flow(
  p_owner_id text,
  p_flow_id uuid,
  p_expected_updated_at timestamptz,
  p_name text,
  p_graph jsonb,
  p_price_usdc numeric,
  p_schedule_cron text
) returns timestamptz
language plpgsql
set search_path = public
as $$
declare
  v_agent_id uuid;
  v_schedule_id uuid;
  v_updated_at timestamptz;
begin
  perform 1 from flows
    where id = p_flow_id
      and owner_id = p_owner_id
      and date_trunc('milliseconds', updated_at) =
          date_trunc('milliseconds', p_expected_updated_at)
    for update;
  if not found then return null; end if;

  v_updated_at := greatest(
    date_trunc('milliseconds', clock_timestamp()),
    date_trunc('milliseconds', p_expected_updated_at) + interval '1 millisecond'
  );
  update flows
    set name = p_name, graph = p_graph, updated_at = v_updated_at
    where id = p_flow_id and owner_id = p_owner_id;

  select id into v_agent_id from agents
    where flow_id = p_flow_id
    order by created_at asc
    limit 1
    for update;
  if v_agent_id is not null then
    update agents set price_usdc = p_price_usdc where id = v_agent_id;
    select id into v_schedule_id from schedules
      where agent_id = v_agent_id
      order by id asc
      limit 1
      for update;

    if p_schedule_cron is not null then
      if v_schedule_id is null then
        insert into schedules (agent_id, cron, enabled)
          values (v_agent_id, p_schedule_cron, false);
      else
        update schedules set cron = p_schedule_cron where id = v_schedule_id;
      end if;
    elsif v_schedule_id is not null then
      update schedules set enabled = false where id = v_schedule_id;
    end if;
  end if;
  return v_updated_at;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Guided saves
-- are server-only and use the Supabase service-role client, so keep this RPC
-- off the public Data API surface and grant only the role that calls it.
revoke execute on function public.agent_studio_mutate_guided_flow(
  text, uuid, timestamptz, text, jsonb, numeric, text
) from public, anon, authenticated;
grant execute on function public.agent_studio_mutate_guided_flow(
  text, uuid, timestamptz, text, jsonb, numeric, text
) to service_role;

create table if not exists wallets (
  owner_id text primary key,
  address text not null,
  network text not null default 'base-mainnet',
  label text
);

create table if not exists relay_endpoints (
  agent_id text not null,
  url text not null,
  secret text not null,
  protocol_version integer not null default 1 check (protocol_version in (1, 2)),
  created_at text not null,
  unique (agent_id)
);

-- One inbound webhook secret per agent. secret_hash is a SHA-256 digest of
-- server-generated CSPRNG bytes that doubles as the HMAC key for verifying
-- inbound signatures (see src/lib/webhook-auth.ts for why "hashed at rest"
-- and a working HMAC-SHA256 verify coexist here).
create table if not exists webhook_endpoints (
  agent_id text not null,
  secret_hash text not null,
  created_at text not null,
  unique (agent_id)
);

-- Phase 9 additions (additive, idempotent via IF NOT EXISTS / IF NOT EXISTS column syntax)
create table if not exists usage (
  id text primary key,
  owner_id text not null,
  kind text not null,
  units integer not null,
  cost_usdc real not null,
  created_at text not null
);

-- settlement_live has TWO different defaults on purpose. Read both before
-- touching either — they protect against opposite failures.
--
-- 1. ADD-TIME default TRUE (the line below) is backfill safety and MUST NOT
--    CHANGE: prod ran live before this column existed, so adding it with a
--    false default would silently turn every pre-existing priced agent
--    free-to-call (AI_HANDOFF Phase 9 hotfix). Rows that predate the column
--    must land LIVE. This matters only on a database where the column does
--    not exist yet; on production it is long since a no-op.
--
-- 2. ONGOING default FALSE (the set default below, 2026-07-26) is
--    money safety for rows inserted AFTER the column exists. createAgent()
--    in both repos writes an EXPLICIT settlement_live=false (2026-07-20:
--    fresh launches start settlement-off, matching the FAQ/docs promise;
--    the owner opts in via POST /api/agents/[agent]/settlement {live:true}).
--    That guarantee lived only in application code while the column default
--    said the opposite, so ANY insert path that omitted the column minted a
--    settlement-live agent. That is not hypothetical: three agents created
--    2026-07-20 20:17 UTC — after that commit landed but before the deploy
--    carrying it — came out settlement-live and 503'd on every call (see
--    AI_HANDOFF "The three 503 agents").
--
-- Setting the ongoing default does NOT rewrite existing rows: a column
-- default applies to future inserts only. Flipping an existing agent stays
-- an explicit owner action.
alter table agents add column if not exists settlement_live boolean not null default true;
alter table agents alter column settlement_live set default false;
alter table runs add column if not exists settled_at text;
-- The exact trigger input / run variables a run was started with, so a later
-- "Run again" can resubmit it. Null for rows written before this column
-- existed and for callers that supplied no input.
alter table runs add column if not exists trigger_input jsonb;
alter table runs add column if not exists run_variables jsonb;

create table if not exists credits (
  id text primary key,
  owner_id text not null,
  delta_usdc real not null,
  reason text not null,
  tx text,
  created_at text not null
);

alter table credits enable row level security;

-- One row per settled x402 agent call: what actually routed on-chain.
-- Amounts are facts recorded at settle time, not recomputed from price —
-- see SettlementRecord in src/lib/db/repo.ts.
create table if not exists settlements (
  run_id text primary key,
  agent_id text not null,
  owner_id text not null,
  gross_usdc real not null,
  creator_usdc real not null,
  platform_usdc real not null,
  pay_to text not null,
  payout_source text not null,
  payer text,
  tx text,
  created_at text not null
);
create index if not exists idx_settlements_owner on settlements (owner_id);
create index if not exists idx_settlements_agent on settlements (agent_id);

alter table settlements enable row level security;

-- AP2 authorization and replay ledger. This is a hard pre-settlement
-- dependency: unlike the post-settlement accounting ledger above, application
-- writes and reads fail closed when this table is unavailable. It stores only
-- hashes, stable references, exact payment terms, and sanitized JSON
-- projections — never raw mandates, disclosures, checkout JWTs, payment
-- signatures, authorization headers, or request bodies.
create table if not exists ap2_authorizations (
  id text primary key,
  mandate_reference text not null unique,
  payment_nonce_hash text not null unique,
  request_digest text not null,
  issuer text not null,
  subject_id text,
  checkout_hash text not null unique,
  agent_id text not null,
  flow_id text not null,
  deployment_id text not null,
  network text not null,
  asset text not null,
  amount_atomic text not null,
  amount_minor_usd bigint not null check (amount_minor_usd >= 0),
  payee_id text not null,
  pay_to text not null,
  payer text not null,
  state text not null check (state in (
    'authorized', 'settling', 'settled', 'executing', 'completed',
    'rejected', 'failed', 'pending_reconciliation'
  )),
  decision_code text,
  receipt_json jsonb,
  result_json jsonb,
  expires_at text not null,
  payment_valid_before text not null,
  run_id text,
  tx text,
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_ap2_authorizations_state_updated
  on ap2_authorizations (state, updated_at);
create index if not exists idx_ap2_authorizations_agent_created
  on ap2_authorizations (agent_id, created_at);
create index if not exists idx_ap2_authorizations_run
  on ap2_authorizations (run_id);

alter table ap2_authorizations enable row level security;
revoke all privileges on table public.ap2_authorizations
  from public, anon, authenticated;
grant select, insert, update on table public.ap2_authorizations
  to service_role;
revoke delete on table public.ap2_authorizations
  from service_role;

-- Runtime readiness must prove the exact AP2 replay-store revision and its
-- anti-replay constraints, not merely that similarly named columns are
-- readable. This deploy baseline is service-role-only: browser roles cannot
-- call the attestation or access the ledger.
create or replace function public.agent_studio_ap2_replay_store_attestation()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if to_regclass('public.ap2_authorizations') is null then
    return null;
  end if;

  if (
    select array_agg(
      array[
        columns.column_name::text,
        columns.udt_name::text,
        columns.is_nullable::text
      ]
      order by columns.ordinal_position
    )
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'ap2_authorizations'
  ) is distinct from array[
    array['id', 'text', 'NO'],
    array['mandate_reference', 'text', 'NO'],
    array['payment_nonce_hash', 'text', 'NO'],
    array['request_digest', 'text', 'NO'],
    array['issuer', 'text', 'NO'],
    array['subject_id', 'text', 'YES'],
    array['checkout_hash', 'text', 'NO'],
    array['agent_id', 'text', 'NO'],
    array['flow_id', 'text', 'NO'],
    array['deployment_id', 'text', 'NO'],
    array['network', 'text', 'NO'],
    array['asset', 'text', 'NO'],
    array['amount_atomic', 'text', 'NO'],
    array['amount_minor_usd', 'int8', 'NO'],
    array['payee_id', 'text', 'NO'],
    array['pay_to', 'text', 'NO'],
    array['payer', 'text', 'NO'],
    array['state', 'text', 'NO'],
    array['decision_code', 'text', 'YES'],
    array['receipt_json', 'jsonb', 'YES'],
    array['result_json', 'jsonb', 'YES'],
    array['expires_at', 'text', 'NO'],
    array['payment_valid_before', 'text', 'NO'],
    array['run_id', 'text', 'YES'],
    array['tx', 'text', 'YES'],
    array['created_at', 'text', 'NO'],
    array['updated_at', 'text', 'NO']
  ]::text[][] then
    return null;
  end if;

  if not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_mandate_reference_key'
      and constraints.contype = 'u'
      and pg_get_constraintdef(constraints.oid) = 'UNIQUE (mandate_reference)'
  ) or not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_payment_nonce_hash_key'
      and constraints.contype = 'u'
      and pg_get_constraintdef(constraints.oid) = 'UNIQUE (payment_nonce_hash)'
  ) or not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_checkout_hash_key'
      and constraints.contype = 'u'
      and pg_get_constraintdef(constraints.oid) = 'UNIQUE (checkout_hash)'
  ) then
    return null;
  end if;

  if not (
    select tables.relrowsecurity
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and tables.relkind = 'r'
  ) or exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ap2_authorizations'
  ) then
    return null;
  end if;

  if not has_table_privilege('service_role', 'public.ap2_authorizations', 'select')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'insert')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'update')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'delete')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'truncate')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'references')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'trigger')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'select')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'insert')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'update')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'delete')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'select')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'insert')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'update')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'delete')
  then
    return null;
  end if;

  return 'ap2-replay-v2';
end;
$$;

revoke execute on function public.agent_studio_ap2_replay_store_attestation()
  from public, anon, authenticated;
grant execute on function public.agent_studio_ap2_replay_store_attestation()
  to service_role;

-- One row per (agent, venue) discovery submission: real receipts for the
-- distribution console (a free-registry POST, a GitHub PR/issue URL, or a
-- queued/failed attempt), never a marketing claim. UNIQUE(agent_id, venue_id)
-- makes upsertAgentListing idempotent per pair. Server-only, like settlements —
-- until this table exists, the repo swallows the write and returns the
-- in-memory record (dark-deploy safe by design).
create table if not exists agent_listings (
  id text primary key,
  agent_id text not null,
  venue_id text not null,
  status text not null check (status in ('submitted', 'listed', 'failed', 'pending')),
  external_url text,
  submitted_at text not null,
  updated_at text not null,
  unique (agent_id, venue_id)
);
create index if not exists idx_agent_listings_agent on agent_listings (agent_id);

alter table agent_listings enable row level security;
revoke all privileges on table public.agent_listings
  from public, anon, authenticated;
grant select, insert, update on table public.agent_listings
  to service_role;
revoke delete on table public.agent_listings
  from service_role;

-- Server-only infra health snapshots, written by the hourly cron recorder
-- (src/app/api/cron/tick/route.ts). No user data and no owner scoping — only
-- dependency reachability, latencies, and a timestamp. Append-only: the
-- runtime role may select/insert but never delete. Like settlements, the repo
-- swallows writes until this table exists (dark-deploy safe by design), so
-- /status renders live probes + run volume until the migration is applied.
create table if not exists health_checks (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('ok', 'degraded', 'down')),
  db_ok boolean not null,
  db_latency_ms integer,
  gateway_ok boolean not null,
  gateway_latency_ms integer,
  facilitator_ok boolean not null,
  facilitator_latency_ms integer,
  checked_at timestamptz not null default now()
);
create index if not exists idx_health_checks_checked_at
  on health_checks (checked_at desc);

alter table health_checks enable row level security;
revoke all privileges on table public.health_checks
  from public, anon, authenticated;
grant select, insert on table public.health_checks
  to service_role;
revoke delete on table public.health_checks
  from service_role;

-- Reference-only AI/UGC moderation queue. Generated output and credentials are
-- intentionally not copied here; reviewers follow the bounded server-side ids.
create table if not exists moderation_reports (
  id text primary key check (char_length(id) between 1 and 256),
  reporter_owner_id text not null check (char_length(reporter_owner_id) between 1 and 256),
  subject_owner_id text not null check (char_length(subject_owner_id) between 1 and 256),
  subject_type text not null
    check (subject_type in ('run_output', 'agent_output', 'agent')),
  flow_id text check (flow_id is null or char_length(flow_id) between 1 and 256),
  run_id text check (run_id is null or char_length(run_id) between 1 and 256),
  node_id text check (node_id is null or char_length(node_id) between 1 and 256),
  agent_id text check (agent_id is null or char_length(agent_id) between 1 and 256),
  reason text not null check (reason in (
    'sexual_content',
    'hate_or_harassment',
    'violence_or_self_harm',
    'illegal_or_dangerous',
    'privacy_or_personal_data',
    'deceptive_or_misleading',
    'other_unsafe_content'
  )),
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  reviewer_notes text check (reviewer_notes is null or char_length(reviewer_notes) <= 2000),
  reviewed_by text check (reviewed_by is null or char_length(reviewed_by) between 1 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check (
    (subject_type = 'run_output' and flow_id is not null and run_id is not null and agent_id is null)
    or (subject_type = 'agent_output' and flow_id is not null and agent_id is not null and node_id is null)
    or (subject_type = 'agent' and flow_id is not null and agent_id is not null and run_id is null and node_id is null)
  )
);
create index if not exists idx_moderation_reports_queue
  on moderation_reports (status, created_at desc, id desc);
create index if not exists idx_moderation_reports_reporter
  on moderation_reports (reporter_owner_id, created_at desc, id desc);
alter table moderation_reports enable row level security;
revoke all privileges on table public.moderation_reports
  from public, anon, authenticated;
grant select, insert, update on table public.moderation_reports
  to service_role;
revoke delete on table public.moderation_reports
  from service_role;

-- Autonomous Company tables: a company groups agent employees into
-- departments under one founder (owner), with budgets, approval gates, and
-- settlement-grounded books. See src/lib/company/types.ts for the domain
-- model (CompanyRecord, DepartmentRecord, EmployeeRecord, ApprovalRecord).
create table if not exists companies (
  id text primary key,
  owner_id text not null,
  name text not null,
  mission text not null,
  status text not null default 'draft',
  fire_cost_threshold_usdc real,
  created_at text not null
);
create index if not exists idx_companies_owner on companies (owner_id);

create table if not exists company_departments (
  id text primary key,
  company_id text not null references companies (id),
  name text not null,
  monthly_budget_usdc real
);
create index if not exists idx_departments_company on company_departments (company_id);

create table if not exists company_employees (
  agent_id text primary key,
  company_id text not null references companies (id),
  department_id text not null references company_departments (id),
  job_description text not null,
  publish_gated boolean not null default false,
  monthly_budget_usdc real,
  removed_at text,
  -- Employee's own payout wallet (EVM address). null = settle to the
  -- founder's owner wallet, exactly as before this column existed.
  pay_to text,
  -- Org chart + heartbeat. Every column is additive and nullable: rows hired
  -- before they existed keep reading null, and src/lib/company/roles.ts
  -- resolves a null role rather than defaulting it to 'worker' (defaulting
  -- would make every already-founded company read as zero-CEO/all-orphans).
  -- There is no 'terminated' lifecycle value on purpose — removal is the
  -- removed_at tombstone above, and one answer to that question is enough.
  role text check (role is null or role in ('ceo', 'manager', 'worker')),
  -- agent_id of this employee's manager. Intentionally no foreign key: hires
  -- and reparents are validated in application code (validateHire /
  -- validateReparent), which also rejects self-parents and cycles that a
  -- foreign key cannot see.
  reports_to text,
  lifecycle_status text check (
    lifecycle_status is null
    or lifecycle_status in ('idle', 'running', 'error', 'paused', 'budget_paused')
  ),
  heartbeat_enabled boolean,
  heartbeat_interval_seconds integer check (
    heartbeat_interval_seconds is null or heartbeat_interval_seconds > 0
  ),
  last_heartbeat_at text
);
alter table company_employees add column if not exists role text
  check (role is null or role in ('ceo', 'manager', 'worker'));
alter table company_employees add column if not exists reports_to text;
alter table company_employees add column if not exists lifecycle_status text
  check (
    lifecycle_status is null
    or lifecycle_status in ('idle', 'running', 'error', 'paused', 'budget_paused')
  );
alter table company_employees add column if not exists heartbeat_enabled boolean;
alter table company_employees add column if not exists heartbeat_interval_seconds integer
  check (heartbeat_interval_seconds is null or heartbeat_interval_seconds > 0);
alter table company_employees add column if not exists last_heartbeat_at text;
create index if not exists idx_employees_company on company_employees (company_id);
create index if not exists idx_employees_company_active on company_employees (company_id, removed_at);
create index if not exists idx_employees_department on company_employees (department_id);
create index if not exists idx_employees_reports_to on company_employees (reports_to);

-- One row per employee holding the markdown documents it boots with. Additive
-- and pending: until this table exists the employee simply has no authored
-- instructions, exactly as before the table was designed.
create table if not exists company_employee_instructions (
  agent_id text primary key references company_employees (agent_id),
  agents_md text,
  soul_md text,
  heartbeat_md text,
  tools_md text,
  session_summary text,
  updated_at text not null
);
alter table company_employee_instructions enable row level security;
revoke all privileges on table public.company_employee_instructions
  from public, anon, authenticated;
grant select, insert, update on table public.company_employee_instructions
  to service_role;
revoke delete on table public.company_employee_instructions
  from service_role;

create table if not exists company_approvals (
  id text primary key,
  company_id text not null references companies (id),
  kind text not null,
  subject_id text not null,
  status text not null default 'pending',
  reason text,
  action_summary text,
  cost_basis text check (cost_basis is null or cost_basis in ('quoted', 'estimated', 'unavailable')),
  cost_usdc real check (cost_usdc is null or cost_usdc >= 0),
  cost_note text,
  created_at text not null,
  decided_at text
);
alter table company_approvals add column if not exists action_summary text;
alter table company_approvals add column if not exists cost_basis text
  check (cost_basis is null or cost_basis in ('quoted', 'estimated', 'unavailable'));
alter table company_approvals add column if not exists cost_usdc real
  check (cost_usdc is null or cost_usdc >= 0);
alter table company_approvals add column if not exists cost_note text;
create index if not exists idx_approvals_company on company_approvals (company_id, status);
create index if not exists idx_approvals_company_activity
  on company_approvals (company_id, created_at desc, id desc);
create index if not exists idx_runs_company_activity
  on runs (agent_id, started_at desc, id desc);

-- CEO chat: a persistent, per-company conversation where the founder tells
-- an already-founded company's CEO assistant what to change (hire, let an
-- employee go, or change a budget). See src/lib/company/ceo.ts. Additive
-- and pending — until this table exists, the repo swallows the write and
-- listCeoMessages returns [] (dark-deploy safe by design, same pattern as
-- health_checks/agent_listings above).
-- `seq` is a monotonic tie-break, not a public id: two turns appended
-- within one request commonly share one millisecond of created_at
-- resolution, and `id` (a random UUID) does not preserve insertion order
-- under that tie the way SQLite's implicit rowid does.
create table if not exists company_ceo_messages (
  id text primary key,
  company_id text not null references companies (id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  proposal jsonb,
  created_at text not null,
  seq bigint generated always as identity
);
create index if not exists idx_ceo_messages_company
  on company_ceo_messages (company_id, created_at, seq);
alter table company_ceo_messages enable row level security;
revoke all privileges on table public.company_ceo_messages
  from public, anon, authenticated;
grant select, insert on table public.company_ceo_messages
  to service_role;
revoke delete, update on table public.company_ceo_messages
  from service_role;

alter table companies enable row level security;
alter table company_departments enable row level security;
alter table company_employees enable row level security;
alter table company_approvals enable row level security;

-- Supabase projects may require explicit Data API grants for newly-created
-- public tables. These records are accessed only by the server-side
-- service-role client; browser roles receive no table privileges and RLS with
-- no policies remains defense in depth.
revoke all privileges on table
  public.settlements,
  public.companies,
  public.company_departments,
  public.company_employees,
  public.company_approvals
from public, anon, authenticated;
grant select, insert, update on table
  public.settlements,
  public.companies,
  public.company_departments,
  public.company_employees,
  public.company_approvals
to service_role;
revoke delete on table
  public.settlements,
  public.companies,
  public.company_departments,
  public.company_employees,
  public.company_approvals
from service_role;

alter table flows enable row level security;
alter table agents enable row level security;
alter table runs enable row level security;
alter table run_steps enable row level security;
alter table schedules enable row level security;
alter table wallets enable row level security;
alter table relay_endpoints enable row level security;
alter table webhook_endpoints enable row level security;
alter table usage enable row level security;

-- Domain-ownership proof for site-drafted agents (lib/site/verification.ts).
-- One row per (owner, host); its ABSENCE keeps a site agent out of the
-- public catalog, so a missing table fails closed (unlisted), never open.
create table if not exists site_verifications (
  owner_id text not null,
  host text not null,
  method text not null,
  verified_at text not null,
  primary key (owner_id, host)
);
alter table site_verifications enable row level security;
revoke all privileges on table public.site_verifications
  from public, anon, authenticated;
grant select, insert, update on table public.site_verifications
  to service_role;
revoke delete on table public.site_verifications
  from service_role;

-- Resource Foundry: private durable source snapshots, immutable pack versions,
-- exact release identities, and append-only run receipts. The reviewed
-- production migration (docs/migrations/agent-resource-foundry.sql) carries
-- the transactional RPCs and extends workspace owner adoption.
create table if not exists resource_products (
  id text primary key, owner_id text not null constraint resource_products_owner_id_check check(
    pg_catalog.octet_length(owner_id) between 1 and 128 and owner_id=pg_catalog.btrim(owner_id)
    and owner_id !~ '[[:cntrl:]]' and owner_id=normalize(owner_id,NFC)
  ), name text not null, slug text not null,
  status text not null check (status in ('draft','test','live','paused','retired')),
  execution_access text not null check (execution_access in ('free','paid','private')),
  discovery_access text not null check (discovery_access in ('public','unlisted')),
  created_at timestamptz not null, updated_at timestamptz not null,
  unique(owner_id,slug)
);
create index if not exists idx_resource_products_owner_status on resource_products(owner_id,status,updated_at desc,id desc);
create table if not exists resource_source_assets (
  id text primary key, resource_product_id text not null references resource_products(id) on delete restrict,
  locator text not null, source_kind text not null, created_at timestamptz not null,
  unique(resource_product_id,locator,source_kind)
);
create index if not exists idx_resource_source_assets_product on resource_source_assets(resource_product_id,created_at,id);
create table if not exists resource_source_snapshots (
  id text primary key, resource_product_id text not null references resource_products(id) on delete restrict,
  source_asset_id text not null references resource_source_assets(id) on delete restrict,
  locator text not null, source_kind text not null, captured_at timestamptz not null,
  source_published_at timestamptz, content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
  freshness_deadline timestamptz not null,
  provenance text check(provenance is null or provenance in ('mine','licensed_or_permissioned','public_source','other_or_unspecified')),
  provenance_note text, created_at timestamptz not null
);
create index if not exists idx_resource_source_snapshots_product on resource_source_snapshots(resource_product_id,captured_at desc,id desc);
create index if not exists idx_resource_source_snapshots_asset on resource_source_snapshots(source_asset_id,captured_at desc,id desc);
create table if not exists resource_pack_versions (
  id text primary key, resource_product_id text not null references resource_products(id) on delete restrict,
  revision integer not null check(revision>0), status text not null check(status in ('candidate','approved','live','retired')),
  semantic_hash text not null check(semantic_hash ~ '^[a-f0-9]{64}$'), content_json jsonb not null,
  created_by text not null, created_at timestamptz not null, approved_by text, approved_at timestamptz,
  unique(resource_product_id,revision),unique(resource_product_id,id)
);
create unique index if not exists uq_resource_pack_candidate on resource_pack_versions(resource_product_id) where status='candidate';
create index if not exists idx_resource_pack_product_status on resource_pack_versions(resource_product_id,status,revision desc,id desc);
create table if not exists resource_records (
  pack_version_id text not null references resource_pack_versions(id) on delete cascade, id text not null,
  fields_json jsonb not null,tags_json jsonb not null,evidence_ids_json jsonb not null,unknowns_json jsonb,conflicts_json jsonb,
  primary key(pack_version_id,id)
);
create index if not exists idx_resource_records_pack on resource_records(pack_version_id,id);
create table if not exists resource_evidence_refs (
  pack_version_id text not null references resource_pack_versions(id) on delete cascade, id text not null,
  source_snapshot_id text not null references resource_source_snapshots(id) on delete restrict,
  locator text not null,observed_at timestamptz not null,
  field_hash text constraint resource_evidence_refs_field_hash_check check(field_hash is null or field_hash ~ '^[a-f0-9]{64}$'),
  confidence double precision constraint resource_evidence_refs_confidence_check check(confidence is null or confidence between 0 and 1),conflict text,
  primary key(pack_version_id,id)
);
create index if not exists idx_resource_evidence_pack on resource_evidence_refs(pack_version_id,id);
create index if not exists idx_resource_evidence_snapshot on resource_evidence_refs(source_snapshot_id,pack_version_id);
create table if not exists resource_releases (
  id text primary key,owner_id text not null constraint resource_releases_owner_id_check check(
    pg_catalog.octet_length(owner_id) between 1 and 128 and owner_id=pg_catalog.btrim(owner_id)
    and owner_id !~ '[[:cntrl:]]' and owner_id=normalize(owner_id,NFC)
  ),resource_product_id text not null references resource_products(id) on delete restrict,
  pack_version_id text not null references resource_pack_versions(id) on delete restrict,
  semantic_hash text not null constraint resource_releases_semantic_hash_check check(semantic_hash ~ '^[a-f0-9]{64}$'),
  publication_key text not null,
  publication_request_hash text not null constraint resource_releases_publication_request_hash_check check(publication_request_hash ~ '^[a-f0-9]{64}$'),
  graph_semantic_hash text not null constraint resource_releases_graph_semantic_hash_check check(graph_semantic_hash ~ '^[a-f0-9]{64}$'),
  graph_full_hash text not null constraint resource_releases_graph_full_hash_check check(graph_full_hash ~ '^[a-f0-9]{64}$'),
  price_usdc double precision not null check(price_usdc>=0),execution_access text not null check(execution_access in ('free','paid','private')),
  discovery_access text not null check(discovery_access in ('public','unlisted')),
  agent_id text not null,flow_id text not null,flow_version_id text not null,deployment_id text not null unique,
  environment_id text not null,created_at timestamptz not null,
  check(execution_access='paid' or price_usdc=0),unique(owner_id,resource_product_id,publication_key),
  foreign key(resource_product_id,pack_version_id) references resource_pack_versions(resource_product_id,id) on delete restrict
);
create index if not exists idx_resource_releases_agent on resource_releases(agent_id,created_at desc,id desc);
create index if not exists idx_resource_releases_owner_product on resource_releases(owner_id,resource_product_id,created_at desc,id desc);
create unique index if not exists uq_resource_releases_publication on resource_releases(owner_id,resource_product_id,publication_key);
create table if not exists resource_run_receipts (
  id text primary key,owner_id text not null constraint resource_run_receipts_owner_id_check check(
    pg_catalog.octet_length(owner_id) between 1 and 128 and owner_id=pg_catalog.btrim(owner_id)
    and owner_id !~ '[[:cntrl:]]' and owner_id=normalize(owner_id,NFC)
  ),resource_product_id text not null references resource_products(id) on delete restrict,
  pack_version_id text not null references resource_pack_versions(id) on delete restrict,run_id text not null unique,
  agent_id text not null,flow_version_id text not null,deployment_id text not null,
  payment_id text check(payment_id is null or payment_id<>''),
  payment_state text not null check(payment_state in ('free','challenged','credited','settled','refunded','failed')),
  price_usdc double precision not null check(price_usdc>=0),
  semantic_hash text not null constraint resource_run_receipts_semantic_hash_check check(semantic_hash ~ '^[a-f0-9]{64}$'),
  freshness text not null check(freshness in ('fresh','stale','mixed')),evidence_json jsonb not null,
  unknowns_json jsonb not null,conflicts_json jsonb not null,output_schema_valid boolean not null,created_at timestamptz not null,
  foreign key(resource_product_id,pack_version_id) references resource_pack_versions(resource_product_id,id) on delete restrict
);
create index if not exists idx_resource_receipts_owner_product on resource_run_receipts(owner_id,resource_product_id,created_at desc,id desc);
create index if not exists idx_resource_receipts_pack on resource_run_receipts(pack_version_id,created_at desc,id desc);
create or replace function public.agent_studio_resource_immutable_guard()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then
    if tg_table_name='resource_source_snapshots' then raise exception 'Resource source snapshots are append-only'; end if;
    if tg_table_name in ('resource_records','resource_evidence_refs') and exists(
      select 1 from public.resource_pack_versions where id=old.pack_version_id and status in ('approved','live','retired')
    ) then raise exception 'Resource pack content is append-only'; end if;
    if tg_table_name='resource_releases' then raise exception 'Resource releases are append-only'; end if;
    if tg_table_name='resource_run_receipts' then raise exception 'Resource run receipts are append-only'; end if;
    if tg_table_name='resource_pack_versions' and old.status in ('approved','live','retired') then raise exception 'Resource pack versions are append-only'; end if;
    return old;
  end if;
  if tg_table_name='resource_source_snapshots' then raise exception 'Resource source snapshots are append-only'; end if;
  if tg_table_name='resource_pack_versions' and old.status in ('approved','live','retired') and
    ((old.status='approved' and new.status not in ('approved','live','retired')) or
     (old.status='live' and new.status not in ('live','retired')) or
     (old.status='retired' and new.status<>'retired') or
     (new.id,new.resource_product_id,new.revision,new.semantic_hash,new.content_json,new.created_by,new.created_at,new.approved_by,new.approved_at)
       is distinct from (old.id,old.resource_product_id,old.revision,old.semantic_hash,old.content_json,old.created_by,old.created_at,old.approved_by,old.approved_at))
    then raise exception 'Resource pack content is immutable'; end if;
  if tg_table_name in ('resource_records','resource_evidence_refs') and exists(
    select 1 from public.resource_pack_versions where id in (old.pack_version_id,new.pack_version_id) and status in ('approved','live','retired')
  ) then raise exception 'Resource pack content is immutable'; end if;
  if tg_table_name='resource_releases' and to_jsonb(new)-'owner_id' is distinct from to_jsonb(old)-'owner_id'
    then raise exception 'Resource releases are append-only'; end if;
  if tg_table_name='resource_run_receipts' and to_jsonb(new)-'owner_id' is distinct from to_jsonb(old)-'owner_id'
    then raise exception 'Resource run receipts are append-only'; end if;
  return new;
end; $$;
drop trigger if exists resource_source_snapshots_immutable on resource_source_snapshots;
create trigger resource_source_snapshots_immutable before update or delete on resource_source_snapshots for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_pack_versions_immutable on resource_pack_versions;
create trigger resource_pack_versions_immutable before update or delete on resource_pack_versions for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_records_immutable on resource_records;
create trigger resource_records_immutable before update or delete on resource_records for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_evidence_refs_immutable on resource_evidence_refs;
create trigger resource_evidence_refs_immutable before update or delete on resource_evidence_refs for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_releases_immutable on resource_releases;
create trigger resource_releases_immutable before update or delete on resource_releases for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_run_receipts_immutable on resource_run_receipts;
create trigger resource_run_receipts_immutable before update or delete on resource_run_receipts for each row execute function public.agent_studio_resource_immutable_guard();
alter table resource_products enable row level security;
alter table resource_source_assets enable row level security;
alter table resource_source_snapshots enable row level security;
alter table resource_pack_versions enable row level security;
alter table resource_records enable row level security;
alter table resource_evidence_refs enable row level security;
alter table resource_releases enable row level security;
alter table resource_run_receipts enable row level security;
revoke all privileges on table public.resource_products,public.resource_source_assets,public.resource_source_snapshots,public.resource_pack_versions,public.resource_records,public.resource_evidence_refs,public.resource_releases,public.resource_run_receipts from public,anon,authenticated;
grant select,insert,update on table public.resource_products,public.resource_source_assets,public.resource_source_snapshots,public.resource_pack_versions,public.resource_records,public.resource_evidence_refs,public.resource_releases,public.resource_run_receipts to service_role;
revoke delete on table public.resource_products,public.resource_source_assets,public.resource_source_snapshots,public.resource_pack_versions,public.resource_records,public.resource_evidence_refs,public.resource_releases,public.resource_run_receipts from service_role;
grant delete on table public.resource_pack_versions to service_role;
grant delete on table public.resource_pack_versions to anon;
revoke all on function public.agent_studio_resource_immutable_guard() from public,anon,authenticated,service_role;

-- Private Prospect Engine state. The JSON document is validated at every
-- application read/write; indexed columns exist only for owner-scoped queueing,
-- deduplication, optimistic concurrency, and lifecycle filtering.
create table if not exists prospect_records (
  id text primary key,
  owner_id text not null check (char_length(owner_id) between 1 and 512),
  domain text not null check (char_length(domain) between 1 and 253),
  stage text not null check (stage in (
    'discovered', 'audited', 'reproduced', 'repair_ready', 'draft_ready',
    'approved', 'sent', 'follow_up_due', 'replied', 'opted_out', 'closed'
  )),
  record_json jsonb not null,
  revision integer not null check (revision > 0),
  created_at text not null,
  updated_at text not null,
  unique (owner_id, domain)
);
create index if not exists idx_prospect_records_owner_updated
  on prospect_records (owner_id, updated_at desc);
alter table prospect_records enable row level security;
revoke all privileges on table public.prospect_records
  from public, anon, authenticated;
grant select, insert, update on table public.prospect_records
  to service_role;
revoke delete on table public.prospect_records
  from service_role;
create table if not exists prospect_recipient_suppressions (
  owner_id text not null check (char_length(owner_id) between 1 and 512),
  email_sha256 text not null check (email_sha256 ~ '^v1:[0-9a-f]{64}$'),
  reason text not null check (reason in ('opt-out', 'operator')),
  created_at text not null,
  primary key (owner_id, email_sha256)
);
alter table prospect_recipient_suppressions enable row level security;
revoke all privileges on table public.prospect_recipient_suppressions
  from public, anon, authenticated;
grant select, insert on table public.prospect_recipient_suppressions to service_role;
revoke update, delete on table public.prospect_recipient_suppressions from service_role;
create or replace function public.agent_studio_opt_out_prospect(
  p_id text, p_owner_id text, p_expected_revision integer, p_record_json jsonb,
  p_stage text, p_revision integer, p_updated_at text, p_email_sha256 text, p_recorded_at text, p_reason text
) returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare affected integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id || ':' || p_email_sha256, 0));
  update public.prospect_records set stage = p_stage, record_json = p_record_json,
    revision = p_revision, updated_at = p_updated_at
  where id = p_id and owner_id = p_owner_id and revision = p_expected_revision;
  get diagnostics affected = row_count;
  if affected <> 1 then return false; end if;
  insert into public.prospect_recipient_suppressions (owner_id, email_sha256, reason, created_at)
    values (p_owner_id, p_email_sha256, p_reason, p_recorded_at)
    on conflict (owner_id, email_sha256) do nothing;
  return true;
end
$$;
revoke all on function public.agent_studio_opt_out_prospect(text,text,integer,jsonb,text,integer,text,text,text,text) from public, anon, authenticated;
grant execute on function public.agent_studio_opt_out_prospect(text,text,integer,jsonb,text,integer,text,text,text,text) to service_role;
create or replace function public.agent_studio_update_prospect_unless_suppressed(
  p_id text, p_owner_id text, p_expected_revision integer, p_record_json jsonb,
  p_stage text, p_revision integer, p_updated_at text, p_email_sha256 text
) returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare affected integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id || ':' || p_email_sha256, 0));
  if exists (select 1 from public.prospect_recipient_suppressions where owner_id = p_owner_id and email_sha256 = p_email_sha256) then return false; end if;
  update public.prospect_records set stage = p_stage, record_json = p_record_json, revision = p_revision, updated_at = p_updated_at where id = p_id and owner_id = p_owner_id and revision = p_expected_revision;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;
revoke all on function public.agent_studio_update_prospect_unless_suppressed(text,text,integer,jsonb,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.agent_studio_update_prospect_unless_suppressed(text,text,integer,jsonb,text,integer,text,text) to service_role;
create or replace function public.agent_studio_redact_prospect(p_id text, p_owner_id text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare affected integer;
begin
  delete from public.prospect_records where id = p_id and owner_id = p_owner_id;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;
revoke all on function public.agent_studio_redact_prospect(text,text) from public, anon, authenticated;
grant execute on function public.agent_studio_redact_prospect(text,text) to service_role;
