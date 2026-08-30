-- Suede Agent Studio — Supabase schema with RLS scoped to the owner.
-- Apply via: supabase db execute < src/lib/db/schema.sql

create table if not exists flows (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  graph jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references flows (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  slug text unique not null,
  status text not null default 'draft' check (status in ('draft', 'live')),
  price_usdc numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references flows (id) on delete cascade,
  agent_id uuid references agents (id) on delete set null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  trigger text not null,
  status text not null default 'running' check (status in ('running', 'done', 'error')),
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
  owner_id uuid not null references auth.users (id) on delete cascade,
  cron text not null,
  enabled boolean not null default true,
  last_run_at timestamptz
);

create table if not exists wallets (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  address text not null,
  network text not null default 'base-mainnet',
  label text
);

-- Server-only AI/UGC moderation queue. It stores references, never generated
-- content, prompts, credentials, or other run payloads.
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

-- Server-only discovery-submission receipts (one row per agent+venue). Written
-- only by the service-role client; browser roles get no table privileges.
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

-- Server-only infra health snapshots, written by the hourly cron recorder.
-- No user data and no owner scoping — only dependency reachability, latencies,
-- and a timestamp. Append-only: the runtime role may select/insert but never
-- delete (mirrors settlements / agent_listings).
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

alter table flows enable row level security;
alter table agents enable row level security;
alter table runs enable row level security;
alter table run_steps enable row level security;
alter table schedules enable row level security;
alter table wallets enable row level security;

create policy "own flows" on flows using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own agents" on agents using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own runs" on runs using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own steps" on run_steps using (
  exists (select 1 from runs r where r.id = run_steps.run_id and r.owner_id = auth.uid())
);
create policy "own schedules" on schedules using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own wallet" on wallets using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Public read for live agents' discovery descriptors (slug-based machine access).
create policy "public live agents" on agents for select using (status = 'live');
