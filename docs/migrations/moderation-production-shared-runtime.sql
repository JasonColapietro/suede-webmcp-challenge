-- Moderation queue access bridge for the temporary shared Supabase runtime.
--
-- Production Agent Studio currently reaches PostgREST as `anon` with the
-- server-only x-agent-studio-secret header. Extend the existing reviewed
-- request-secret RLS boundary to moderation_reports without exposing the
-- table to direct browser traffic or granting destructive access.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('suede-agent-studio:moderation-shared-runtime', 0));

do $$
declare
  authorizer_security_definer boolean;
  authorizer_config text[];
begin
  if to_regclass('public.moderation_reports') is null then
    raise exception 'Agent Studio moderation table is missing';
  end if;

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

  if not (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'moderation_reports'
      and c.relkind = 'r'
  ) then
    raise exception 'Agent Studio moderation table must have RLS enabled';
  end if;

  if (
    select array_agg(columns.column_name::text order by columns.ordinal_position)
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'moderation_reports'
  ) is distinct from array[
    'id',
    'reporter_owner_id',
    'subject_owner_id',
    'subject_type',
    'flow_id',
    'run_id',
    'node_id',
    'agent_id',
    'reason',
    'status',
    'reviewer_notes',
    'reviewed_by',
    'created_at',
    'updated_at',
    'reviewed_at'
  ]::text[] then
    raise exception 'Agent Studio moderation table column inventory drift';
  end if;

  if exists (
    select 1
    from unnest(array[
      'idx_moderation_reports_queue',
      'idx_moderation_reports_reporter'
    ]::text[]) expected(index_name)
    left join pg_class indexes
      on indexes.relname = expected.index_name
      and indexes.relnamespace = (
        select oid from pg_namespace where nspname = 'public'
      )
    left join pg_index index_state on index_state.indexrelid = indexes.oid
    where indexes.oid is null
      or index_state.indisvalid is distinct from true
      or index_state.indisready is distinct from true
  ) then
    raise exception 'Agent Studio moderation table index inventory drift';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'moderation_reports'
      and policyname <> 'agent_studio_server_access'
  ) then
    raise exception 'Agent Studio moderation table has unexpected RLS policies';
  end if;
end
$$;

drop policy if exists agent_studio_server_access on public.moderation_reports;
create policy agent_studio_server_access
  on public.moderation_reports
  for all
  to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());

revoke all privileges on table public.moderation_reports
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.moderation_reports
  to anon, service_role;
revoke delete on table public.moderation_reports
  from anon, service_role;

comment on policy agent_studio_server_access on public.moderation_reports is
  'Server-only moderation access through the shared-runtime request secret.';

do $$
begin
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'moderation_reports'
      and policyname = 'agent_studio_server_access'
      and cmd = 'ALL'
      and roles = array['anon']::name[]
  ) <> 1 then
    raise exception 'Agent Studio moderation shared-runtime policy readback failed';
  end if;

  if not has_table_privilege('anon', 'public.moderation_reports', 'select')
    or not has_table_privilege('anon', 'public.moderation_reports', 'insert')
    or not has_table_privilege('anon', 'public.moderation_reports', 'update')
    or has_table_privilege('anon', 'public.moderation_reports', 'delete')
    or has_table_privilege('anon', 'public.moderation_reports', 'truncate')
    or has_table_privilege('anon', 'public.moderation_reports', 'references')
    or has_table_privilege('anon', 'public.moderation_reports', 'trigger')
    or not has_table_privilege('service_role', 'public.moderation_reports', 'select')
    or not has_table_privilege('service_role', 'public.moderation_reports', 'insert')
    or not has_table_privilege('service_role', 'public.moderation_reports', 'update')
    or has_table_privilege('service_role', 'public.moderation_reports', 'delete')
    or has_table_privilege('service_role', 'public.moderation_reports', 'truncate')
    or has_table_privilege('service_role', 'public.moderation_reports', 'references')
    or has_table_privilege('service_role', 'public.moderation_reports', 'trigger')
    or exists (
      select 1
      from information_schema.role_table_grants grants
      where grants.table_schema = 'public'
        and grants.table_name = 'moderation_reports'
        and grants.grantee in ('PUBLIC', 'authenticated')
    )
    or exists (
      select 1
      from information_schema.column_privileges grants
      where grants.table_schema = 'public'
        and grants.table_name = 'moderation_reports'
        and grants.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
        and grants.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')
    )
  then
    raise exception 'Agent Studio moderation shared-runtime privilege readback failed';
  end if;
end
$$;

commit;
