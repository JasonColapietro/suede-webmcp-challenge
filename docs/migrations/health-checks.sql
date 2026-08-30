-- Prepared manual input: infra health-check history (SQLite migration 30
-- equivalent). Mirrors the health_checks block in src/lib/db/schema.deploy.sql.
-- Subject to the full safety gate in PENDING.md — live readback, drift check,
-- dry run, explicit production approval. Additive only; no data backfill.
-- Until applied, recordHealthCheck in src/lib/db/supabase-repo.ts logs the
-- write failure and continues, and getHealthUptime returns zeroed stats, so
-- /status renders live probes + run volume only (dark-deploy safe by design).
-- No user data and no owner scoping — only dependency reachability, latencies,
-- and a timestamp.
--
-- Production uses the reviewed shared Supabase runtime: PostgREST runs as
-- `anon` with a server-only x-agent-studio-secret header. This migration
-- extends that existing request-secret boundary to the append-only ledger.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(
  hashtextextended('suede-agent-studio:health-checks:v1', 0)
);

do $$
declare
  authorizer_security_definer boolean;
  authorizer_config text[];
begin
  if to_regprocedure('agent_studio_private.request_authorized()') is null then
    raise exception 'Agent Studio shared-runtime authorization function is missing';
  end if;

  select p.prosecdef, p.proconfig
  into authorizer_security_definer, authorizer_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'agent_studio_private'
    and p.proname = 'request_authorized'
    and p.pronargs = 0;

  if authorizer_security_definer is distinct from true
    or not (
      'search_path=pg_catalog, public, extensions'
      = any(coalesce(authorizer_config, array[]::text[]))
    ) then
    raise exception 'Agent Studio shared-runtime authorization function is not hardened';
  end if;

  if not exists (
    select 1
    from public.agent_studio_runtime_secrets
    where id = 'primary'
      and schema_revision = 'shared-runtime-v2'
      and secret_hash ~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Agent Studio shared-runtime v2 marker is missing';
  end if;

  if not has_schema_privilege('anon', 'agent_studio_private', 'usage')
    or not has_function_privilege(
      'anon',
      'agent_studio_private.request_authorized()',
      'execute'
    ) then
    raise exception 'Agent Studio shared-runtime anon authorization grant is missing';
  end if;
end
$$;

create table if not exists public.health_checks (
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
  on public.health_checks (checked_at desc);

alter table public.health_checks enable row level security;

do $$
begin
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
      and columns.table_name = 'health_checks'
  ) is distinct from array[
    array['id', 'uuid', 'NO'],
    array['status', 'text', 'NO'],
    array['db_ok', 'bool', 'NO'],
    array['db_latency_ms', 'int4', 'YES'],
    array['gateway_ok', 'bool', 'NO'],
    array['gateway_latency_ms', 'int4', 'YES'],
    array['facilitator_ok', 'bool', 'NO'],
    array['facilitator_latency_ms', 'int4', 'YES'],
    array['checked_at', 'timestamptz', 'NO']
  ]::text[][] then
    raise exception 'Agent Studio health-checks column inventory drift';
  end if;

  if not exists (
    select 1
    from pg_class indexes
    join pg_namespace schemas on schemas.oid = indexes.relnamespace
    join pg_index index_state on index_state.indexrelid = indexes.oid
    where schemas.nspname = 'public'
      and indexes.relname = 'idx_health_checks_checked_at'
      and index_state.indisvalid
      and index_state.indisready
  ) then
    raise exception 'Agent Studio health-checks index inventory drift';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'health_checks'
      and policyname <> 'agent_studio_server_access'
  ) then
    raise exception 'Agent Studio health-checks table has unexpected RLS policies';
  end if;
end
$$;

drop policy if exists agent_studio_server_access
  on public.health_checks;
create policy agent_studio_server_access
  on public.health_checks
  for all
  to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());

-- Server-only Data API access. New Supabase tables are not guaranteed to
-- receive implicit grants, and browser roles must not read infra rows. This
-- table is append-only in the runtime: select + insert only, never delete.
revoke all privileges on table public.health_checks
from public, anon, authenticated, service_role;
grant select, insert on table public.health_checks
to anon, service_role;
revoke update, delete on table public.health_checks
from anon, service_role;

comment on table public.health_checks is
  'Append-only Agent Studio dependency-health snapshots.';
comment on policy agent_studio_server_access
  on public.health_checks is
  'Server-only health-check access through the shared-runtime request secret.';

do $$
begin
  if not (
    select tables.relrowsecurity
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'health_checks'
      and tables.relkind = 'r'
  ) then
    raise exception 'Agent Studio health-checks table must have RLS enabled';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'health_checks'
      and policyname = 'agent_studio_server_access'
      and cmd = 'ALL'
      and roles = array['anon']::name[]
      and qual = 'agent_studio_private.request_authorized()'
      and with_check = 'agent_studio_private.request_authorized()'
  ) <> 1 then
    raise exception 'Agent Studio health-checks policy readback failed';
  end if;

  if not has_table_privilege('anon', 'public.health_checks', 'select')
    or not has_table_privilege('anon', 'public.health_checks', 'insert')
    or has_table_privilege('anon', 'public.health_checks', 'update')
    or has_table_privilege('anon', 'public.health_checks', 'delete')
    or has_table_privilege('anon', 'public.health_checks', 'truncate')
    or has_table_privilege('anon', 'public.health_checks', 'references')
    or has_table_privilege('anon', 'public.health_checks', 'trigger')
    or not has_table_privilege('service_role', 'public.health_checks', 'select')
    or not has_table_privilege('service_role', 'public.health_checks', 'insert')
    or has_table_privilege('service_role', 'public.health_checks', 'update')
    or has_table_privilege('service_role', 'public.health_checks', 'delete')
    or has_table_privilege('service_role', 'public.health_checks', 'truncate')
    or has_table_privilege('service_role', 'public.health_checks', 'references')
    or has_table_privilege('service_role', 'public.health_checks', 'trigger')
    or exists (
      select 1
      from information_schema.role_table_grants grants
      where grants.table_schema = 'public'
        and grants.table_name = 'health_checks'
        and grants.grantee in ('PUBLIC', 'authenticated')
    )
  then
    raise exception 'Agent Studio health-checks privilege readback failed';
  end if;
end
$$;

commit;
