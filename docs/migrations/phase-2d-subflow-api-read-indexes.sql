-- Phase 2D private subflow API read indexes for Supabase/Postgres.
--
-- MANUAL OPERATOR INPUT ONLY. Prepared source; not applied. Builds, tests,
-- previews, deploys, and runtime providers must never execute this file.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

select pg_advisory_xact_lock(hashtextextended('suede-agent-studio:phase-2d-subflow-api-read-indexes', 0));

do $$
begin
  if to_regclass('public.flows') is null or to_regclass('public.flow_versions') is null then
    raise exception 'Phase 2D subflow API index preflight failed: required table missing';
  end if;
  if to_regclass('public.idx_flows_owner_name_id') is not null
    or to_regclass('public.idx_flow_versions_flow_number_id') is not null then
    raise exception 'Phase 2D subflow API index preflight failed: reviewed index name already exists';
  end if;
end
$$;

create index idx_flows_owner_name_id
  on public.flows(owner_id, name, id);
create index idx_flow_versions_flow_number_id
  on public.flow_versions(flow_id, version_number desc, id desc);

commit;
