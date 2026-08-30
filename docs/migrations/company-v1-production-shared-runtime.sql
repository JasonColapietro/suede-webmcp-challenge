-- Company v1 access bridge for the temporary shared Supabase runtime.
--
-- Production Agent Studio may use the anon PostgREST role plus the
-- server-only x-agent-studio-secret header instead of a service-role key.
-- The shared runtime already protects its tables with
-- agent_studio_private.request_authorized(); extend that exact boundary to
-- the five Company v1 tables and allow the security-invoker Guided RPC to run
-- through the same authenticated request path. Direct browser requests still
-- fail RLS because they do not possess the server-only request secret.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('suede-agent-studio:company-v1-shared-runtime', 0));

do $$
declare
  table_name text;
  rpc_security_definer boolean;
begin
  if to_regprocedure('agent_studio_private.request_authorized()') is null then
    raise exception 'Agent Studio shared-runtime authorization function is missing';
  end if;

  if not exists (
    select 1
    from public.agent_studio_runtime_secrets
    where id = 'primary' and schema_revision = 'shared-runtime-v2'
  ) then
    raise exception 'Agent Studio shared-runtime v2 marker is missing';
  end if;

  foreach table_name in array array[
    'settlements',
    'companies',
    'company_departments',
    'company_employees',
    'company_approvals'
  ] loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise exception 'Company v1 table is missing: %', table_name;
    end if;
    if not (
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = table_name and c.relkind = 'r'
    ) then
      raise exception 'Company v1 table must have RLS enabled: %', table_name;
    end if;

    execute format('drop policy if exists agent_studio_server_access on public.%I', table_name);
    execute format(
      'create policy agent_studio_server_access on public.%I for all to anon using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())',
      table_name
    );
  end loop;

  select p.prosecdef into rpc_security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = to_regprocedure(
      'public.agent_studio_mutate_guided_flow(text,uuid,timestamp with time zone,text,jsonb,numeric,text)'
    );
  if rpc_security_definer is null then
    raise exception 'Company v1 Guided RPC is missing';
  end if;
  if rpc_security_definer then
    raise exception 'Company v1 Guided RPC must remain security invoker';
  end if;
end
$$;

revoke all privileges on table
  public.settlements,
  public.companies,
  public.company_departments,
  public.company_employees,
  public.company_approvals
from public, authenticated;
grant select, insert, update on table
  public.settlements,
  public.companies,
  public.company_departments,
  public.company_employees,
  public.company_approvals
to anon, service_role;
revoke delete on table
  public.settlements,
  public.companies,
  public.company_departments,
  public.company_employees,
  public.company_approvals
from anon, service_role;

revoke all on function public.agent_studio_mutate_guided_flow(
  text, uuid, timestamptz, text, jsonb, numeric, text
) from public, authenticated;
grant execute on function public.agent_studio_mutate_guided_flow(
  text, uuid, timestamptz, text, jsonb, numeric, text
) to anon, service_role;

comment on policy agent_studio_server_access on public.companies is
  'Server-only Company v1 access through the shared-runtime request secret.';

commit;
