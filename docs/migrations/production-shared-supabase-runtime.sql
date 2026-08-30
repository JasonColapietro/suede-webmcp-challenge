-- Agent Studio production runtime on the temporarily shared Suede Supabase project.
--
-- Replace __AGENT_STUDIO_SECRET_SHA256__ with the SHA-256 digest of a 32-byte
-- server-only secret. The raw secret belongs only in Vercel as
-- AGENT_STUDIO_DB_SECRET. Direct anon/authenticated table access remains blocked.

begin;
set local search_path = public, pg_catalog, extensions;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('suede-agent-studio:shared-runtime-v1', 0));

do $$
declare
  collision text;
  marker_owner oid;
  owned_table_count integer;
  actual_column_inventory jsonb;
  expected_column_inventory constant jsonb := '{
    "flows": ["id", "owner_id", "name", "graph", "updated_at"],
    "agents": ["id", "flow_id", "slug", "status", "price_usdc", "created_at", "settlement_live"],
    "runs": ["id", "flow_id", "agent_id", "trigger", "status", "total_cost_usdc", "started_at", "finished_at", "settled_at"],
    "run_steps": ["id", "run_id", "node_id", "node_type", "status", "cost_usdc", "output", "error", "created_at"],
    "schedules": ["id", "agent_id", "cron", "enabled", "last_run_at"],
    "wallets": ["owner_id", "address", "network", "label"],
    "relay_endpoints": ["agent_id", "url", "secret", "created_at"],
    "webhook_endpoints": ["agent_id", "secret_hash", "created_at"],
    "usage": ["id", "owner_id", "kind", "units", "cost_usdc", "created_at"],
    "credits": ["id", "owner_id", "delta_usdc", "reason", "tx", "created_at"],
    "organizations": ["id", "personal_owner_id", "name", "kind", "created_at"],
    "workspaces": ["id", "organization_id", "name", "slug", "created_at"],
    "projects": ["id", "workspace_id", "name", "slug", "created_at", "updated_at"],
    "workbooks": ["id", "project_id", "name", "slug", "position", "created_at"],
    "environments": ["id", "project_id", "name", "slug", "kind", "created_at"],
    "flow_project_bindings": ["flow_id", "project_id", "workbook_id", "created_at"],
    "flow_versions": ["id", "flow_id", "version_number", "schema_version", "label", "description", "graph", "semantic_hash", "full_hash", "created_by", "created_at"],
    "dependency_pins": ["id", "flow_version_id", "kind", "resource_id", "version", "content_hash", "created_at"],
    "deployments": ["id", "flow_id", "flow_version_id", "environment_id", "status", "created_at", "retired_at"],
    "workbook_flow_tabs": ["id", "workbook_id", "flow_id", "title", "position", "created_at", "updated_at"]
  }'::jsonb;
begin
  if to_regclass('public.agent_studio_runtime_secrets') is null then
    select string_agg(c.relname, ', ' order by c.relname) into collision
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'flows', 'agents', 'runs', 'run_steps', 'schedules', 'wallets',
        'relay_endpoints', 'webhook_endpoints', 'usage', 'credits',
        'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
        'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments',
        'workbook_flow_tabs'
      );
    if collision is not null then
      raise exception 'Agent Studio shared-runtime preflight found unowned table collisions: %', collision;
    end if;
  else
    select c.relowner into marker_owner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'agent_studio_runtime_secrets'
      and c.relkind = 'r';
    if marker_owner is null or (
      select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'agent_studio_runtime_secrets'
        and (
          (column_name = 'id' and data_type = 'text' and is_nullable = 'NO')
          or (column_name = 'secret_hash' and data_type = 'text' and is_nullable = 'NO')
          or (column_name = 'schema_revision' and data_type = 'text' and is_nullable = 'NO')
          or (column_name = 'updated_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
        )
    ) <> 4 or (
      select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'agent_studio_runtime_secrets'
    ) <> 4 then
      raise exception 'Agent Studio shared-runtime marker shape drift';
    end if;

    select count(*) into owned_table_count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relowner = marker_owner
      and c.relname in (
        'flows', 'agents', 'runs', 'run_steps', 'schedules', 'wallets',
        'relay_endpoints', 'webhook_endpoints', 'usage', 'credits',
        'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
        'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments',
        'workbook_flow_tabs'
      );
    if owned_table_count <> 20 then
      raise exception 'Agent Studio shared-runtime owned-table drift: expected 20, found %', owned_table_count;
    end if;

    select jsonb_object_agg(table_name, column_names)
    into actual_column_inventory
    from (
      select
        columns.table_name,
        jsonb_agg(columns.column_name order by columns.ordinal_position) as column_names
      from information_schema.columns columns
      where columns.table_schema = 'public'
        and columns.table_name in (
          'flows', 'agents', 'runs', 'run_steps', 'schedules', 'wallets',
          'relay_endpoints', 'webhook_endpoints', 'usage', 'credits',
          'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
          'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments',
          'workbook_flow_tabs'
        )
      group by columns.table_name
    ) owned_columns;
    if actual_column_inventory is distinct from expected_column_inventory then
      raise exception 'Agent Studio shared-runtime owned-table column inventory drift';
    end if;
  end if;
end
$$;

create table if not exists public.agent_studio_runtime_secrets (
  id text primary key,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  schema_revision text not null check (schema_revision = 'shared-runtime-v2'),
  updated_at timestamptz not null default now()
);

insert into public.agent_studio_runtime_secrets (id, secret_hash, schema_revision, updated_at)
values ('primary', '__AGENT_STUDIO_SECRET_SHA256__', 'shared-runtime-v2', now())
on conflict (id) do update
set secret_hash = excluded.secret_hash,
    schema_revision = excluded.schema_revision,
    updated_at = excluded.updated_at;

create schema if not exists agent_studio_private;
revoke all on schema agent_studio_private from public, authenticated;
grant usage on schema agent_studio_private to anon, service_role;

create or replace function agent_studio_private.request_authorized()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
  select exists (
    select 1
    from public.agent_studio_runtime_secrets secrets
    where secrets.id = 'primary'
      and secrets.secret_hash = encode(
        extensions.digest(
          coalesce(
            coalesce(current_setting('request.headers', true), '{}')::jsonb
              ->> 'x-agent-studio-secret',
            ''
          ),
          'sha256'
        ),
        'hex'
      )
  );
$$;

revoke all on function agent_studio_private.request_authorized() from public, anon, authenticated;
grant execute on function agent_studio_private.request_authorized() to anon, service_role;

create table if not exists public.flows (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  graph jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete cascade,
  slug text unique not null,
  status text not null default 'draft' check (status in ('draft', 'live')),
  price_usdc numeric not null default 0 check (price_usdc >= 0),
  created_at timestamptz not null default now(),
  settlement_live boolean not null default true
);

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  trigger text not null,
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  total_cost_usdc numeric not null default 0 check (total_cost_usdc >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  settled_at text
);

create table if not exists public.run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  node_id text not null,
  node_type text not null,
  status text not null,
  cost_usdc numeric not null default 0 check (cost_usdc >= 0),
  output jsonb,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.schedules (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null unique references public.agents (id) on delete cascade,
  cron text not null,
  enabled boolean not null default true,
  last_run_at timestamptz
);

create table if not exists public.wallets (
  owner_id text primary key,
  address text not null,
  network text not null default 'base-mainnet',
  label text
);

create table if not exists public.relay_endpoints (
  agent_id text primary key,
  url text not null,
  secret text not null,
  created_at text not null
);

create table if not exists public.webhook_endpoints (
  agent_id text primary key,
  secret_hash text not null,
  created_at text not null
);

create table if not exists public.usage (
  id text primary key,
  owner_id text not null,
  kind text not null,
  units integer not null check (units >= 0),
  cost_usdc numeric(20, 8) not null check (cost_usdc >= 0),
  created_at text not null
);

create table if not exists public.credits (
  id text primary key,
  owner_id text not null,
  delta_usdc numeric(20, 8) not null,
  reason text not null,
  tx text,
  created_at text not null
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  personal_owner_id text not null unique,
  name text not null,
  kind text not null check (kind in ('personal', 'team')),
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists public.workbooks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null,
  slug text not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (project_id, slug)
);

create table if not exists public.environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null,
  slug text not null,
  kind text not null check (kind in ('draft', 'test', 'live')),
  created_at timestamptz not null default now(),
  unique (project_id, slug),
  unique (project_id, kind)
);

create table if not exists public.flow_project_bindings (
  flow_id uuid primary key references public.flows (id) on delete cascade,
  project_id uuid not null references public.projects (id),
  workbook_id uuid not null references public.workbooks (id),
  created_at timestamptz not null default now()
);

create table if not exists public.flow_versions (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete cascade,
  version_number integer not null check (version_number > 0),
  schema_version integer not null check (schema_version > 0),
  label text,
  description text,
  graph jsonb not null,
  semantic_hash text not null,
  full_hash text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (flow_id, version_number)
);

create table if not exists public.dependency_pins (
  id uuid primary key default gen_random_uuid(),
  flow_version_id uuid not null references public.flow_versions (id) on delete cascade,
  kind text not null constraint dependency_pins_kind_check
    check (kind in ('agent', 'connector', 'flow', 'resource', 'skill', 'template')),
  resource_id text not null,
  version text not null,
  content_hash text,
  created_at timestamptz not null default now(),
  unique (flow_version_id, kind, resource_id)
);

alter table public.dependency_pins
  drop constraint if exists dependency_pins_kind_check;
alter table public.dependency_pins
  add constraint dependency_pins_kind_check
  check (kind in ('agent', 'connector', 'flow', 'resource', 'skill', 'template'));

create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete cascade,
  flow_version_id uuid not null references public.flow_versions (id),
  environment_id uuid not null references public.environments (id),
  status text not null check (status in ('draft', 'test', 'live', 'retired')),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  check ((status = 'retired') = (retired_at is not null))
);

create table if not exists public.workbook_flow_tabs (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.workbooks (id),
  flow_id uuid not null unique references public.flows (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workbook_id, flow_id),
  unique (workbook_id, position)
);

create index if not exists idx_flows_owner_updated on public.flows (owner_id, updated_at desc, id);
create index if not exists idx_agents_flow_id on public.agents (flow_id);
create index if not exists idx_runs_flow_started on public.runs (flow_id, started_at desc, id);
create index if not exists idx_runs_agent_started on public.runs (agent_id, started_at desc, id);
create index if not exists idx_run_steps_run_created on public.run_steps (run_id, created_at, id);
create index if not exists idx_usage_owner_kind_created on public.usage (owner_id, kind, created_at);
create index if not exists idx_credits_owner_created on public.credits (owner_id, created_at);
create unique index if not exists uq_credits_owner_tx
  on public.credits (owner_id, tx) where tx is not null;
create index if not exists idx_workspaces_organization_id on public.workspaces (organization_id);
create index if not exists idx_projects_workspace_id on public.projects (workspace_id);
create index if not exists idx_workbooks_project_position on public.workbooks (project_id, position, id);
create index if not exists idx_environments_project_id on public.environments (project_id);
create index if not exists idx_bindings_project_id on public.flow_project_bindings (project_id);
create index if not exists idx_bindings_workbook_id on public.flow_project_bindings (workbook_id);
create index if not exists idx_flow_versions_flow_number on public.flow_versions (flow_id, version_number desc, id);
create index if not exists idx_dependency_pins_version on public.dependency_pins (flow_version_id, kind, resource_id);
create index if not exists idx_deployments_version_id on public.deployments (flow_version_id);
create index if not exists idx_deployments_environment_id on public.deployments (environment_id);
create unique index if not exists uq_deployments_active_flow_environment
  on public.deployments (flow_id, environment_id) where retired_at is null;
create index if not exists idx_deployments_flow_history
  on public.deployments (flow_id, created_at desc, id desc);
create index if not exists idx_workbook_tabs_workbook_position
  on public.workbook_flow_tabs (workbook_id, position, id);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'flows', 'agents', 'runs', 'run_steps', 'schedules', 'wallets',
    'relay_endpoints', 'webhook_endpoints', 'usage', 'credits',
    'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
    'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments',
    'workbook_flow_tabs'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists agent_studio_server_access on public.%I', table_name);
    execute format(
      'create policy agent_studio_server_access on public.%I for all to anon using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())',
      table_name
    );
    execute format('revoke all on table public.%I from public, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to anon, service_role', table_name);
  end loop;
end
$$;

drop function if exists public.agent_studio_request_authorized();

alter table public.agent_studio_runtime_secrets enable row level security;
drop policy if exists agent_studio_runtime_secrets_deny_all
  on public.agent_studio_runtime_secrets;
create policy agent_studio_runtime_secrets_deny_all
  on public.agent_studio_runtime_secrets
  for all to anon
  using (false)
  with check (false);
revoke all on table public.agent_studio_runtime_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.agent_studio_runtime_secrets to service_role;

create or replace function public.agent_studio_bind_flow(
  p_flow_id uuid,
  p_owner_id text,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_project_id uuid,
  p_workbook_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  flow_name text;
  binding public.flow_project_bindings%rowtype;
  next_position integer;
begin
  select f.name into flow_name
  from public.flows f
  join public.organizations o
    on o.id = p_organization_id and o.personal_owner_id = p_owner_id
  join public.workspaces w
    on w.id = p_workspace_id and w.organization_id = o.id
  join public.projects p
    on p.id = p_project_id and p.workspace_id = w.id
  join public.workbooks wb
    on wb.id = p_workbook_id and wb.project_id = p.id
  where f.id = p_flow_id and f.owner_id = p_owner_id
  for update of f, wb;
  if not found then return null; end if;

  select * into binding
  from public.flow_project_bindings
  where flow_id = p_flow_id;
  if found then
    if binding.project_id <> p_project_id or binding.workbook_id <> p_workbook_id then
      return null;
    end if;
    if not exists (
      select 1 from public.workbook_flow_tabs
      where flow_id = p_flow_id and workbook_id = p_workbook_id
    ) then return null; end if;
    return to_jsonb(binding);
  end if;

  if exists (select 1 from public.workbook_flow_tabs where flow_id = p_flow_id) then
    return null;
  end if;
  select coalesce(max(position), -1) + 1 into next_position
  from public.workbook_flow_tabs
  where workbook_id = p_workbook_id;
  insert into public.flow_project_bindings (flow_id, project_id, workbook_id)
  values (p_flow_id, p_project_id, p_workbook_id)
  returning * into binding;
  insert into public.workbook_flow_tabs (workbook_id, flow_id, title, position)
  values (
    p_workbook_id,
    p_flow_id,
    case when next_position = 0 then 'Main'
      else coalesce(nullif(btrim(flow_name), ''), format('Flow %s', next_position + 1)) end,
    next_position
  );
  return to_jsonb(binding);
end;
$$;

create or replace function public.agent_studio_reorder_workbook_tabs(
  p_workbook_id uuid,
  p_owner_id text,
  p_tab_ids uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  current_ids uuid[];
  requested_ids uuid[];
  tab_count integer;
  temporary_offset integer;
  tab_id uuid;
  tab_position integer := 0;
  result jsonb;
begin
  perform 1
  from public.workbooks wb
  join public.projects p on p.id = wb.project_id
  join public.workspaces w on w.id = p.workspace_id
  join public.organizations o on o.id = w.organization_id
  where wb.id = p_workbook_id and o.personal_owner_id = p_owner_id
  for update of wb;
  if not found then return null; end if;

  perform id from public.workbook_flow_tabs
  where workbook_id = p_workbook_id
  order by id
  for update;
  select array_agg(id order by id), count(*),
    coalesce(max(position), -1) + count(*) + 1
    into current_ids, tab_count, temporary_offset
  from public.workbook_flow_tabs
  where workbook_id = p_workbook_id;
  select array_agg(value order by value) into requested_ids from unnest(p_tab_ids) value;
  if coalesce(cardinality(p_tab_ids), 0) <> tab_count
    or cardinality(requested_ids) <> cardinality(array(select distinct value from unnest(p_tab_ids) value))
    or coalesce(requested_ids, array[]::uuid[]) <> coalesce(current_ids, array[]::uuid[])
  then return null; end if;

  update public.workbook_flow_tabs
  set position = position + temporary_offset, updated_at = now()
  where workbook_id = p_workbook_id;
  foreach tab_id in array p_tab_ids loop
    update public.workbook_flow_tabs
    set position = tab_position, updated_at = now()
    where id = tab_id and workbook_id = p_workbook_id;
    tab_position := tab_position + 1;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.position, t.id), '[]'::jsonb) into result
  from public.workbook_flow_tabs t where t.workbook_id = p_workbook_id;
  return result;
end;
$$;

create or replace function public.agent_studio_create_flow_version(
  p_flow_id uuid,
  p_owner_id text,
  p_version_id uuid,
  p_schema_version integer,
  p_label text,
  p_description text,
  p_graph jsonb,
  p_flow_name text,
  p_semantic_hash text,
  p_full_hash text,
  p_dependencies jsonb,
  p_checkpoint boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  persisted_graph jsonb;
  next_version integer;
  version_row public.flow_versions%rowtype;
  requested_dependencies jsonb;
begin
  select graph into persisted_graph
  from public.flows
  where id = p_flow_id and owner_id = p_owner_id
  for update;
  if not found then return null; end if;
  if not p_checkpoint and persisted_graph <> p_graph then
    raise exception 'Agent Studio flow changed during version creation' using errcode = '40001';
  end if;
  if p_checkpoint then
    update public.flows
    set name = p_flow_name, graph = p_graph, updated_at = now()
    where id = p_flow_id and owner_id = p_owner_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', pin.kind,
        'resource_id', pin.resource_id,
        'version', pin.version,
        'content_hash', pin.content_hash
      ) order by pin.kind, pin.resource_id
    ),
    '[]'::jsonb
  ) into requested_dependencies
  from jsonb_to_recordset(coalesce(p_dependencies, '[]'::jsonb)) as pin(
    kind text, resource_id text, version text, content_hash text
  );

  if p_label is null then
    select fv.* into version_row
    from public.flow_versions fv
    where fv.flow_id = p_flow_id
      and (
        (p_checkpoint and fv.full_hash = p_full_hash and fv.graph = p_graph)
        or (not p_checkpoint and fv.semantic_hash = p_semantic_hash)
      )
      and (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'kind', dp.kind,
              'resource_id', dp.resource_id,
              'version', dp.version,
              'content_hash', dp.content_hash
            ) order by dp.kind, dp.resource_id
          ),
          '[]'::jsonb
        )
        from public.dependency_pins dp
        where dp.flow_version_id = fv.id
      ) = requested_dependencies
    order by fv.version_number desc, fv.id
    limit 1;
    if found then return to_jsonb(version_row); end if;
  end if;

  select coalesce(max(version_number), 0) + 1 into next_version
  from public.flow_versions where flow_id = p_flow_id;
  insert into public.flow_versions (
    id, flow_id, version_number, schema_version, label, description, graph,
    semantic_hash, full_hash, created_by
  ) values (
    p_version_id, p_flow_id, next_version, p_schema_version, p_label, p_description,
    p_graph, p_semantic_hash, p_full_hash, p_owner_id
  ) returning * into version_row;

  insert into public.dependency_pins (
    flow_version_id, kind, resource_id, version, content_hash
  )
  select
    p_version_id, pin.kind, pin.resource_id, pin.version, pin.content_hash
  from jsonb_to_recordset(coalesce(p_dependencies, '[]'::jsonb)) as pin(
    kind text, resource_id text, version text, content_hash text
  );
  return to_jsonb(version_row);
end;
$$;

create or replace function public.agent_studio_deploy_version(
  p_flow_id uuid,
  p_version_id uuid,
  p_version_semantic_hash text,
  p_version_full_hash text,
  p_environment_id uuid,
  p_environment_kind text,
  p_expected_active_deployment_id uuid,
  p_source_test_deployment_id uuid,
  p_confirmation text,
  p_owner_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  version_row public.flow_versions%rowtype;
  environment_row public.environments%rowtype;
  current_row public.deployments%rowtype;
  source_test_row public.deployments%rowtype;
  inserted_row public.deployments%rowtype;
begin
  select fv.* into version_row
  from public.flow_versions fv
  join public.flows f on f.id = fv.flow_id and f.owner_id = p_owner_id
  where fv.id = p_version_id and fv.flow_id = p_flow_id;
  select e.* into environment_row
  from public.environments e
  join public.flow_project_bindings b
    on b.flow_id = p_flow_id and b.project_id = e.project_id
  join public.projects p on p.id = b.project_id
  join public.workspaces w on w.id = p.workspace_id
  join public.organizations o on o.id = w.organization_id and o.personal_owner_id = p_owner_id
  where e.id = p_environment_id;
  if version_row.id is null or environment_row.id is null then
    return jsonb_build_object('status', 'not-found');
  end if;
  if environment_row.kind <> p_environment_kind
    or version_row.semantic_hash <> p_version_semantic_hash
    or version_row.full_hash <> p_version_full_hash
  then return jsonb_build_object('status', 'conflict'); end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'suede-agent-studio:deployment:' || p_flow_id::text || ':' || p_environment_id::text,
      0
    )
  );

  select * into current_row
  from public.deployments
  where flow_id = p_flow_id and environment_id = p_environment_id and retired_at is null
  for update;
  if current_row.id is distinct from p_expected_active_deployment_id then
    return jsonb_build_object('status', 'conflict');
  end if;
  if p_environment_kind = 'test' then
    if p_confirmation <> 'PROMOTE TEST' or p_source_test_deployment_id is not null then
      return jsonb_build_object('status', 'invalid-request');
    end if;
  elsif p_environment_kind = 'live' then
    if p_confirmation <> 'PROMOTE LIVE' or p_source_test_deployment_id is null then
      return jsonb_build_object('status', 'invalid-request');
    end if;
    select d.* into source_test_row
    from public.deployments d
    join public.environments e
      on e.id = d.environment_id and e.kind = 'test'
      and e.project_id = environment_row.project_id
    where d.id = p_source_test_deployment_id
      and d.flow_id = p_flow_id
      and d.flow_version_id = p_version_id
      and d.status = 'test'
      and d.retired_at is null
    for share of d;
    if not found then return jsonb_build_object('status', 'conflict'); end if;
  else
    return jsonb_build_object('status', 'invalid-request');
  end if;

  if current_row.id is not null and current_row.flow_version_id = p_version_id then
    return jsonb_build_object('status', 'deployed', 'deployment', to_jsonb(current_row));
  end if;
  if current_row.id is not null then
    update public.deployments
    set status = 'retired', retired_at = now()
    where id = current_row.id and retired_at is null;
  end if;
  insert into public.deployments (flow_id, flow_version_id, environment_id, status)
  values (p_flow_id, p_version_id, p_environment_id, p_environment_kind)
  returning * into inserted_row;
  return jsonb_build_object('status', 'deployed', 'deployment', to_jsonb(inserted_row));
end;
$$;

create or replace function public.agent_studio_adopt_owner(
  p_from_owner_id text,
  p_to_owner_id text
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  source_organization_id uuid;
  target_organization_id uuid;
  target_workspace_id uuid;
  target_project_id uuid;
  target_workbook_id uuid;
  target_next_position integer;
begin
  if p_from_owner_id is null or btrim(p_from_owner_id) = ''
    or p_to_owner_id is null or btrim(p_to_owner_id) = '' then
    raise exception 'Agent Studio owner ids are required' using errcode = '22023';
  end if;
  if p_from_owner_id = p_to_owner_id then return; end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'suede-agent-studio:adopt:' || least(p_from_owner_id, p_to_owner_id)
        || ':' || greatest(p_from_owner_id, p_to_owner_id),
      0
    )
  );
  select id into source_organization_id
  from public.organizations
  where personal_owner_id = p_from_owner_id
  for update;
  select id into target_organization_id
  from public.organizations
  where personal_owner_id = p_to_owner_id
  for update;

  if source_organization_id is not null and target_organization_id is null then
    update public.organizations
    set personal_owner_id = p_to_owner_id
    where id = source_organization_id and personal_owner_id = p_from_owner_id;
  elsif source_organization_id is not null and target_organization_id is not null then
    insert into public.workspaces (organization_id, name, slug)
    values (target_organization_id, 'Personal', 'personal')
    on conflict (organization_id, slug) do nothing;
    select id into strict target_workspace_id
    from public.workspaces
    where organization_id = target_organization_id and slug = 'personal';

    insert into public.projects (workspace_id, name, slug)
    values (target_workspace_id, 'My Project', 'my-project')
    on conflict (workspace_id, slug) do nothing;
    select id into strict target_project_id
    from public.projects
    where workspace_id = target_workspace_id and slug = 'my-project';

    insert into public.workbooks (project_id, name, slug, position)
    values (target_project_id, 'Main', 'main', 0)
    on conflict (project_id, slug) do nothing;
    select id into strict target_workbook_id
    from public.workbooks
    where project_id = target_project_id and slug = 'main'
    for update;

    insert into public.environments (project_id, name, slug, kind)
    values
      (target_project_id, 'Draft', 'draft', 'draft'),
      (target_project_id, 'Test', 'test', 'test'),
      (target_project_id, 'Live', 'live', 'live')
    on conflict (project_id, slug) do nothing;

    if exists (
      select 1
      from public.flow_project_bindings b
      join public.projects p on p.id = b.project_id
      join public.workspaces w on w.id = p.workspace_id
      left join public.flows f on f.id = b.flow_id
      where w.organization_id = source_organization_id
        and (f.id is null or f.owner_id <> p_from_owner_id)
    ) then
      raise exception 'Agent Studio adoption found a foreign source binding' using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.workbook_flow_tabs tab
      join public.workbooks wb on wb.id = tab.workbook_id
      join public.projects p on p.id = wb.project_id
      join public.workspaces w on w.id = p.workspace_id
      left join public.flow_project_bindings b
        on b.flow_id = tab.flow_id and b.workbook_id = tab.workbook_id
      where w.organization_id = source_organization_id and b.flow_id is null
    ) then
      raise exception 'Agent Studio adoption found an unbound source tab' using errcode = '23514';
    end if;

    update public.deployments d
    set environment_id = target_environment.id
    from public.flow_project_bindings b
    join public.projects source_project on source_project.id = b.project_id
    join public.workspaces source_workspace on source_workspace.id = source_project.workspace_id
    join public.environments source_environment on source_environment.project_id = source_project.id
    join public.environments target_environment
      on target_environment.project_id = target_project_id
      and target_environment.kind = source_environment.kind
    where source_workspace.organization_id = source_organization_id
      and d.flow_id = b.flow_id
      and d.environment_id = source_environment.id;

    select coalesce(max(position), -1) + 1 into target_next_position
    from public.workbook_flow_tabs
    where workbook_id = target_workbook_id;
    with moving_tabs as materialized (
      select
        tab.id,
        target_next_position + row_number() over (
          order by tab.created_at, tab.id
        )::integer - 1 as new_position
      from public.workbook_flow_tabs tab
      join public.workbooks wb on wb.id = tab.workbook_id
      join public.projects p on p.id = wb.project_id
      join public.workspaces w on w.id = p.workspace_id
      where w.organization_id = source_organization_id
    )
    update public.workbook_flow_tabs tab
    set workbook_id = target_workbook_id,
        position = moving_tabs.new_position,
        updated_at = now()
    from moving_tabs
    where tab.id = moving_tabs.id;

    update public.flow_project_bindings b
    set project_id = target_project_id, workbook_id = target_workbook_id
    from public.projects p
    join public.workspaces w on w.id = p.workspace_id
    where b.project_id = p.id and w.organization_id = source_organization_id;

    delete from public.environments
    where project_id in (
      select p.id from public.projects p
      join public.workspaces w on w.id = p.workspace_id
      where w.organization_id = source_organization_id
    );
    delete from public.workbooks
    where project_id in (
      select p.id from public.projects p
      join public.workspaces w on w.id = p.workspace_id
      where w.organization_id = source_organization_id
    );
    delete from public.projects
    where workspace_id in (
      select id from public.workspaces where organization_id = source_organization_id
    );
    delete from public.workspaces where organization_id = source_organization_id;
    delete from public.organizations where id = source_organization_id;
  end if;

  delete from public.credits source_credit
  using public.credits target_credit
  where source_credit.owner_id = p_from_owner_id
    and target_credit.owner_id = p_to_owner_id
    and source_credit.tx is not null
    and source_credit.tx = target_credit.tx
    and source_credit.delta_usdc = target_credit.delta_usdc
    and source_credit.reason = target_credit.reason;
  update public.flows set owner_id = p_to_owner_id where owner_id = p_from_owner_id;
  update public.usage set owner_id = p_to_owner_id where owner_id = p_from_owner_id;
  update public.credits set owner_id = p_to_owner_id where owner_id = p_from_owner_id;
  update public.flow_versions
  set created_by = p_to_owner_id
  where created_by = p_from_owner_id;

  if not exists (select 1 from public.wallets where owner_id = p_to_owner_id) then
    update public.wallets
    set owner_id = p_to_owner_id
    where owner_id = p_from_owner_id;
  end if;
end;
$$;

revoke all on function public.agent_studio_bind_flow(uuid, text, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.agent_studio_reorder_workbook_tabs(uuid, text, uuid[]) from public, anon, authenticated;
revoke all on function public.agent_studio_create_flow_version(uuid, text, uuid, integer, text, text, jsonb, text, text, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.agent_studio_deploy_version(uuid, uuid, text, text, uuid, text, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.agent_studio_adopt_owner(text, text) from public, anon, authenticated;
grant execute on function public.agent_studio_bind_flow(uuid, text, uuid, uuid, uuid, uuid) to anon, service_role;
grant execute on function public.agent_studio_reorder_workbook_tabs(uuid, text, uuid[]) to anon, service_role;
grant execute on function public.agent_studio_create_flow_version(uuid, text, uuid, integer, text, text, jsonb, text, text, text, jsonb, boolean) to anon, service_role;
grant execute on function public.agent_studio_deploy_version(uuid, uuid, text, text, uuid, text, uuid, uuid, text, text) to anon, service_role;
grant execute on function public.agent_studio_adopt_owner(text, text) to anon, service_role;

comment on table public.agent_studio_runtime_secrets is
  'Ownership marker and request-secret digest for Suede Agent Studio temporary shared-project runtime.';
comment on function agent_studio_private.request_authorized() is
  'Authorizes server-only Agent Studio PostgREST requests by SHA-256 request-secret digest.';

commit;
