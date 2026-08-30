-- Prospect Engine access bridge for the temporary shared Supabase runtime.
--
-- Production Agent Studio reaches PostgREST as `anon` with the server-only
-- x-agent-studio-secret header. Extend the reviewed request-secret RLS
-- boundary to prospect_records without allowing direct browser or destructive
-- access. Apply prospect-engine-records.sql first.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('suede-agent-studio:prospect-engine-shared-runtime', 0));

do $$
declare
  authorizer_security_definer boolean;
  authorizer_config text[];
begin
  if to_regclass('public.prospect_records') is null then
    raise exception 'Agent Studio prospect records table is missing';
  end if;
  if to_regclass('public.prospect_recipient_suppressions') is null then
    raise exception 'Agent Studio prospect suppression registry is missing';
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
      and c.relname = 'prospect_records'
      and c.relkind = 'r'
  ) then
    raise exception 'Agent Studio prospect records table must have RLS enabled';
  end if;
  if not (
    select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'prospect_recipient_suppressions' and c.relkind = 'r'
  ) then raise exception 'Agent Studio prospect suppression registry must have RLS enabled'; end if;
  if (
    select array_agg(columns.column_name::text order by columns.ordinal_position)
    from information_schema.columns columns where columns.table_schema = 'public' and columns.table_name = 'prospect_recipient_suppressions'
  ) is distinct from array['owner_id','email_sha256','reason','created_at']::text[] then
    raise exception 'Agent Studio prospect suppression registry column inventory drift';
  end if;
  if not exists (
    select 1 from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'prospect_recipient_suppressions' and k.contype = 'p'
      and pg_get_constraintdef(k.oid) = 'PRIMARY KEY (owner_id, email_sha256)'
  ) then raise exception 'Agent Studio prospect suppression registry primary key drift'; end if;
  if (select count(*) from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname='public' and t.relname='prospect_recipient_suppressions' and k.contype='c') <> 3 then
    raise exception 'Agent Studio prospect suppression registry check constraint drift';
  end if;

  if (
    select array_agg(columns.column_name::text order by columns.ordinal_position)
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'prospect_records'
  ) is distinct from array[
    'id',
    'owner_id',
    'domain',
    'stage',
    'record_json',
    'revision',
    'created_at',
    'updated_at'
  ]::text[] then
    raise exception 'Agent Studio prospect records column inventory drift';
  end if;

  if not exists (
    select 1
    from pg_class indexes
    join pg_namespace n on n.oid = indexes.relnamespace
    join pg_index index_state on index_state.indexrelid = indexes.oid
    where n.nspname = 'public'
      and indexes.relname = 'idx_prospect_records_owner_updated'
      and index_state.indisvalid
      and index_state.indisready
  ) then
    raise exception 'Agent Studio prospect records index inventory drift';
  end if;

  if not exists (
    select 1
    from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace n on n.oid = tables.relnamespace
    where n.nspname = 'public'
      and tables.relname = 'prospect_records'
      and constraints.contype = 'u'
      and pg_get_constraintdef(constraints.oid) = 'UNIQUE (owner_id, domain)'
  ) then
    raise exception 'Agent Studio prospect records owner-domain constraint drift';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'prospect_records'
      and policyname <> 'agent_studio_server_access'
  ) then
    raise exception 'Agent Studio prospect records table has unexpected RLS policies';
  end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='prospect_recipient_suppressions' and policyname <> 'agent_studio_server_access') then
    raise exception 'Agent Studio prospect suppression registry has unexpected RLS policies';
  end if;
end
$$;

drop policy if exists agent_studio_server_access on public.prospect_records;
create policy agent_studio_server_access
  on public.prospect_records
  for all
  to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());
drop policy if exists agent_studio_server_access on public.prospect_recipient_suppressions;
create policy agent_studio_server_access
  on public.prospect_recipient_suppressions
  for all
  to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());

revoke all privileges on table public.prospect_records
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.prospect_records
  to anon, service_role;
revoke delete on table public.prospect_records
  from anon, service_role;
revoke all privileges on table public.prospect_recipient_suppressions
  from public, anon, authenticated, service_role;
grant select, insert on table public.prospect_recipient_suppressions
  to anon, service_role;
revoke update, delete on table public.prospect_recipient_suppressions
  from anon, service_role;

revoke all on function public.agent_studio_opt_out_prospect(text,text,integer,jsonb,text,integer,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.agent_studio_opt_out_prospect(text,text,integer,jsonb,text,integer,text,text,text,text)
  to anon, service_role;
revoke all on function public.agent_studio_update_prospect_unless_suppressed(text,text,integer,jsonb,text,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.agent_studio_update_prospect_unless_suppressed(text,text,integer,jsonb,text,integer,text,text)
  to anon, service_role;

create or replace function public.agent_studio_redact_prospect(p_id text, p_owner_id text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare affected integer;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    and not agent_studio_private.request_authorized() then
    return false;
  end if;
  delete from public.prospect_records where id = p_id and owner_id = p_owner_id;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;
revoke all on function public.agent_studio_redact_prospect(text,text)
  from public, anon, authenticated;
grant execute on function public.agent_studio_redact_prospect(text,text)
  to anon, service_role;

comment on policy agent_studio_server_access on public.prospect_records is
  'Server-only Prospect Engine access through the shared-runtime request secret.';

do $$
begin
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'prospect_records'
      and policyname = 'agent_studio_server_access'
      and cmd = 'ALL'
      and roles = array['anon']::name[]
  ) <> 1 then
    raise exception 'Agent Studio prospect records shared-runtime policy readback failed';
  end if;

  if not has_table_privilege('anon', 'public.prospect_records', 'select')
    or not has_table_privilege('anon', 'public.prospect_records', 'insert')
    or not has_table_privilege('anon', 'public.prospect_records', 'update')
    or has_table_privilege('anon', 'public.prospect_records', 'delete')
    or has_table_privilege('anon', 'public.prospect_records', 'truncate')
    or has_table_privilege('anon', 'public.prospect_records', 'references')
    or has_table_privilege('anon', 'public.prospect_records', 'trigger')
    or not has_table_privilege('service_role', 'public.prospect_records', 'select')
    or not has_table_privilege('service_role', 'public.prospect_records', 'insert')
    or not has_table_privilege('service_role', 'public.prospect_records', 'update')
    or has_table_privilege('service_role', 'public.prospect_records', 'delete')
    or has_table_privilege('service_role', 'public.prospect_records', 'truncate')
    or has_table_privilege('service_role', 'public.prospect_records', 'references')
    or has_table_privilege('service_role', 'public.prospect_records', 'trigger')
    or exists (
      select 1
      from information_schema.role_table_grants grants
      where grants.table_schema = 'public'
        and grants.table_name = 'prospect_records'
        and grants.grantee in ('PUBLIC', 'authenticated')
    )
    or exists (
      select 1
      from information_schema.column_privileges grants
      where grants.table_schema = 'public'
        and grants.table_name = 'prospect_records'
        and grants.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
        and grants.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')
    )
  then
    raise exception 'Agent Studio prospect records shared-runtime privilege readback failed';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='prospect_recipient_suppressions'
      and policyname='agent_studio_server_access' and cmd='ALL' and roles=array['anon']::name[]) <> 1 then
    raise exception 'Agent Studio prospect suppression registry policy readback failed';
  end if;
  if not has_table_privilege('anon','public.prospect_recipient_suppressions','select')
    or not has_table_privilege('anon','public.prospect_recipient_suppressions','insert')
    or has_table_privilege('anon','public.prospect_recipient_suppressions','update')
    or has_table_privilege('anon','public.prospect_recipient_suppressions','delete') then
    raise exception 'Agent Studio prospect suppression registry privilege readback failed';
  end if;
  if not has_function_privilege('anon','public.agent_studio_opt_out_prospect(text,text,integer,jsonb,text,integer,text,text,text,text)','execute')
    or not has_function_privilege('anon','public.agent_studio_update_prospect_unless_suppressed(text,text,integer,jsonb,text,integer,text,text)','execute')
    or not has_function_privilege('anon','public.agent_studio_redact_prospect(text,text)','execute') then
    raise exception 'Agent Studio prospect suppression function grant readback failed';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('agent_studio_opt_out_prospect','agent_studio_update_prospect_unless_suppressed')
      and (p.prosecdef or not ('search_path=pg_catalog, public' = any(coalesce(p.proconfig,array[]::text[]))))
  ) or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='agent_studio_redact_prospect' and p.prosecdef
      and 'search_path=pg_catalog, public' = any(coalesce(p.proconfig,array[]::text[]))
  ) then raise exception 'Agent Studio prospect suppression function security readback failed'; end if;
end
$$;

commit;
