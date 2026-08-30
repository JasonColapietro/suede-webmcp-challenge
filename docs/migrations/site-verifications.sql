-- site_verifications: domain-ownership proof for site-drafted agents.
--
-- WHY
-- /from-website lets anyone draft an agent that speaks for any public
-- website. On 2026-07-26 a test run published a live public "Zingerman's
-- Mail Order Concierge" from a workspace that does not own zingermans.com —
-- nothing stopped it. Site-drafted agents therefore start UNLISTED: live at
-- their own /a/<slug> URL, but excluded from buildCatalog() (and so from
-- /agents, /api/catalog, the x402 index, and the sitemap) until the owning
-- workspace proves it controls the domain by placing a one-line file at
-- https://<host>/.well-known/suede-agent.txt (see lib/site/verification.ts).
--
-- This table stores the proof. One row per (owner, host). The catalog gate
-- reads it; POST /api/site-agent/verify writes it after fetching the file.
--
-- SAFETY / DARK-DEPLOY
-- Until this is applied, the Supabase adapter's getSiteVerification catches
-- the missing-table error and returns null — every site agent stays
-- unlisted (fail closed). upsertSiteVerification throws, so the verify
-- endpoint reports "verification storage not provisioned" instead of
-- pretending success. Applying this table turns verification ON; it does
-- not list anyone retroactively (no rows exist until owners verify).
--
-- Production uses the reviewed shared Supabase runtime: PostgREST runs as
-- `anon` with a server-only x-agent-studio-secret header. This migration
-- extends that existing request-secret boundary to this table. Direct browser
-- traffic remains outside the policy, authenticated receives no table grant,
-- and destructive access remains revoked.
--
-- Idempotent. Existing proof rows are never read or rewritten.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(
  hashtextextended('suede-agent-studio:site-verifications:v1', 0)
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

create table if not exists public.site_verifications (
  owner_id text not null,
  host text not null,
  method text not null,
  verified_at text not null,
  primary key (owner_id, host)
);
alter table public.site_verifications enable row level security;

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
      and columns.table_name = 'site_verifications'
  ) is distinct from array[
    array['owner_id', 'text', 'NO'],
    array['host', 'text', 'NO'],
    array['method', 'text', 'NO'],
    array['verified_at', 'text', 'NO']
  ]::text[][] then
    raise exception 'Agent Studio site-verifications column inventory drift';
  end if;

  if (
    select array_agg(attributes.attname::text order by keys.ordinality)
    from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    cross join lateral unnest(constraints.conkey)
      with ordinality as keys(attnum, ordinality)
    join pg_attribute attributes
      on attributes.attrelid = tables.oid
      and attributes.attnum = keys.attnum
    where schemas.nspname = 'public'
      and tables.relname = 'site_verifications'
      and constraints.contype = 'p'
  ) is distinct from array['owner_id', 'host']::text[] then
    raise exception 'Agent Studio site-verifications primary-key drift';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'site_verifications'
      and policyname <> 'agent_studio_server_access'
  ) then
    raise exception 'Agent Studio site-verifications table has unexpected RLS policies';
  end if;
end
$$;

drop policy if exists agent_studio_server_access
  on public.site_verifications;
create policy agent_studio_server_access
  on public.site_verifications
  for all
  to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());

revoke all privileges on table public.site_verifications
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.site_verifications
  to anon, service_role;
revoke delete on table public.site_verifications
  from anon, service_role;

comment on table public.site_verifications is
  'Server-held domain proofs for site-drafted Agent Studio agents.';
comment on policy agent_studio_server_access
  on public.site_verifications is
  'Server-only site-verification access through the shared-runtime request secret.';

do $$
begin
  if not (
    select tables.relrowsecurity
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'site_verifications'
      and tables.relkind = 'r'
  ) then
    raise exception 'Agent Studio site-verifications table must have RLS enabled';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'site_verifications'
      and policyname = 'agent_studio_server_access'
      and cmd = 'ALL'
      and roles = array['anon']::name[]
      and qual = 'agent_studio_private.request_authorized()'
      and with_check = 'agent_studio_private.request_authorized()'
  ) <> 1 then
    raise exception 'Agent Studio site-verifications policy readback failed';
  end if;

  if not has_table_privilege('anon', 'public.site_verifications', 'select')
    or not has_table_privilege('anon', 'public.site_verifications', 'insert')
    or not has_table_privilege('anon', 'public.site_verifications', 'update')
    or has_table_privilege('anon', 'public.site_verifications', 'delete')
    or has_table_privilege('anon', 'public.site_verifications', 'truncate')
    or has_table_privilege('anon', 'public.site_verifications', 'references')
    or has_table_privilege('anon', 'public.site_verifications', 'trigger')
    or not has_table_privilege('service_role', 'public.site_verifications', 'select')
    or not has_table_privilege('service_role', 'public.site_verifications', 'insert')
    or not has_table_privilege('service_role', 'public.site_verifications', 'update')
    or has_table_privilege('service_role', 'public.site_verifications', 'delete')
    or has_table_privilege('service_role', 'public.site_verifications', 'truncate')
    or has_table_privilege('service_role', 'public.site_verifications', 'references')
    or has_table_privilege('service_role', 'public.site_verifications', 'trigger')
    or exists (
      select 1
      from information_schema.role_table_grants grants
      where grants.table_schema = 'public'
        and grants.table_name = 'site_verifications'
        and grants.grantee in ('PUBLIC', 'authenticated')
    )
  then
    raise exception 'Agent Studio site-verifications privilege readback failed';
  end if;
end
$$;

-- READBACK — expect the table to exist with a 2-column primary key:
--
--   select to_regclass('public.site_verifications');
--
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'site_verifications';

commit;
