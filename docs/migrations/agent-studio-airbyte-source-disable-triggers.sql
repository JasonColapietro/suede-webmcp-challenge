-- Emergency write-path rollback for the Agent Studio Airbyte source.
-- This intentionally preserves the private ledger, HMAC key, view, reader
-- capability, and append-only protection. It only removes synchronous
-- triggers from application tables so primary writes no longer depend on
-- adapter capture.

begin;
set local search_path = pg_catalog, pg_temp;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Serialize with migration/apply activity and wait for any in-flight outcome
-- append to commit before the application-table triggers are removed.
select pg_catalog.pg_advisory_xact_lock(1987202607, 29);
select pg_catalog.pg_advisory_xact_lock(1987202607, 30);

drop trigger if exists agent_studio_airbyte_agents
  on public.agents;
drop trigger if exists agent_studio_airbyte_test_runs
  on public.runs;
drop trigger if exists agent_studio_airbyte_settled_runs
  on public.runs;
drop trigger if exists agent_studio_airbyte_deployments
  on public.deployments;
drop trigger if exists agent_studio_airbyte_settlements
  on public.settlements;

do $rollback$
begin
  if exists (
    select 1
    from pg_catalog.pg_trigger as triggers
    where not triggers.tgisinternal
      and (
        (
          triggers.tgrelid = 'public.agents'::regclass
          and triggers.tgname = 'agent_studio_airbyte_agents'
        )
        or (
          triggers.tgrelid = 'public.runs'::regclass
          and triggers.tgname in (
            'agent_studio_airbyte_test_runs',
            'agent_studio_airbyte_settled_runs'
          )
        )
        or (
          triggers.tgrelid = 'public.deployments'::regclass
          and triggers.tgname = 'agent_studio_airbyte_deployments'
        )
        or (
          triggers.tgrelid = 'public.settlements'::regclass
          and triggers.tgname = 'agent_studio_airbyte_settlements'
        )
      )
  ) then
    raise exception
      'Agent Studio Airbyte application trigger disable did not complete'
      using errcode = '55000';
  end if;
end
$rollback$;

commit;
