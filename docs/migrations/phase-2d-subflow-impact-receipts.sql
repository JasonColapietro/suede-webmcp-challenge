-- Phase 2D subflow breaking-impact receipts for Supabase/Postgres.
--
-- MANUAL OPERATOR INPUT ONLY. This file is prepared, reviewed source and has
-- not been applied. Builds, tests, previews, deploys, and runtime providers
-- must never execute it. SQLite v8 is the only enabled runtime implementation.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

select pg_advisory_xact_lock(
  hashtextextended('suede-agent-studio:phase-2d-subflow-impact-receipts', 0)
);

do $$
begin
  if to_regclass('public.flows') is null then
    raise exception 'Phase 2D subflow receipt preflight failed: public.flows is missing';
  end if;
  if to_regrole('service_role') is null
    or to_regrole('anon') is null
    or to_regrole('authenticated') is null then
    raise exception 'Phase 2D subflow receipt preflight failed: required Supabase roles are missing';
  end if;
  if not exists (
    select 1 from pg_roles where rolname = 'service_role' and rolbypassrls
  ) then
    raise exception 'Phase 2D subflow receipt preflight failed: service_role must bypass RLS';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flows'
      and column_name = 'id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flows'
      and column_name = 'owner_id' and data_type = 'text' and is_nullable = 'NO'
  ) then
    raise exception 'Phase 2D subflow receipt preflight failed: flows ownership shape drift';
  end if;

  if to_regclass('public.subflow_impact_receipts') is not null then
    raise exception 'Phase 2D subflow receipt preflight failed: table already exists';
  end if;
  if to_regprocedure('public.assert_subflow_impact_receipt_owner()') is not null then
    raise exception 'Phase 2D subflow receipt preflight failed: owner guard function already exists';
  end if;
  if to_regclass('public.uq_subflow_impact_receipts_owner_child') is not null
    or to_regclass('public.idx_subflow_impact_receipts_expiry') is not null
    or to_regclass('public.idx_subflow_impact_receipts_child') is not null
    or to_regclass('public.idx_flows_owner_id') is not null then
    raise exception 'Phase 2D subflow receipt preflight failed: reviewed index name already exists';
  end if;
end
$$;

create table public.subflow_impact_receipts (
  id text not null,
  owner_id text not null,
  child_flow_id uuid not null,
  old_interface_hash text not null,
  proposed_interface_hash text not null,
  dependent_set_hash text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint pk_subflow_impact_receipts primary key (id),
  constraint subflow_impact_receipts_child_flow_id_fkey
    foreign key (child_flow_id) references public.flows(id)
    on update no action on delete cascade,
  constraint ck_subflow_impact_receipts_id check (length(id) between 32 and 256),
  constraint ck_subflow_impact_receipts_owner check (length(owner_id) between 1 and 512),
  constraint ck_subflow_impact_receipts_old_hash check (
    old_interface_hash = 'none' or old_interface_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint ck_subflow_impact_receipts_proposed_hash check (
    proposed_interface_hash = 'none' or proposed_interface_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint ck_subflow_impact_receipts_set_hash check (
    dependent_set_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint ck_subflow_impact_receipts_expiry check (expires_at > issued_at),
  constraint ck_subflow_impact_receipts_consumed check (
    consumed_at is null or consumed_at between issued_at and expires_at
  )
);

create unique index uq_subflow_impact_receipts_owner_child
  on public.subflow_impact_receipts(owner_id, child_flow_id);
create index idx_subflow_impact_receipts_expiry
  on public.subflow_impact_receipts(expires_at, consumed_at);
create index idx_subflow_impact_receipts_child
  on public.subflow_impact_receipts(child_flow_id, id);
create index idx_flows_owner_id
  on public.flows(owner_id, id);

create function public.assert_subflow_impact_receipt_owner()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1 from public.flows
    where id = new.child_flow_id and owner_id = new.owner_id
  ) then
    raise exception 'impact receipt owner mismatch';
  end if;
  return new;
end
$$;

create trigger subflow_impact_receipts_owner_guard
before insert or update of owner_id, child_flow_id
on public.subflow_impact_receipts
for each row execute function public.assert_subflow_impact_receipt_owner();

alter table public.subflow_impact_receipts enable row level security;
revoke all on table public.subflow_impact_receipts from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.subflow_impact_receipts to service_role;
revoke all on function public.assert_subflow_impact_receipt_owner() from public, anon, authenticated;
grant execute on function public.assert_subflow_impact_receipt_owner() to service_role;

do $$
begin
  if exists (
    select 1 from pg_policy
    where polrelid = 'public.subflow_impact_receipts'::regclass
  ) then
    raise exception 'Phase 2D subflow receipt postflight failed: unexpected RLS policy';
  end if;
  if exists (
    select 1 from public.subflow_impact_receipts r
    left join public.flows f
      on f.id = r.child_flow_id and f.owner_id = r.owner_id
    where f.id is null
  ) then
    raise exception 'Phase 2D subflow receipt postflight failed: owner-chain drift';
  end if;
end
$$;

commit;
