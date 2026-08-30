-- Phase 1 projects and immutable flow versions for Supabase/Postgres.
--
-- MANUAL OPERATOR INPUT ONLY. This file is never applied by builds, tests,
-- application startup, previews, or deploys. Before running it, complete the
-- readback and dry-run procedure in docs/architecture/phase-1-versioning.md.
-- The reviewed baseline is src/lib/db/schema.deploy.sql. Do not apply this on
-- top of the incompatible historical auth schema in src/lib/db/schema.sql
-- without first reconciling the live schema and ownership model.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Prevent two operator sessions from applying this migration concurrently.
select pg_advisory_xact_lock(hashtextextended('suede-agent-studio:phase-1-projects-and-versions', 0));

-- Production baseline prerequisite: Phase 1 binds to the existing UUID flows
-- table without changing it.
do $$
begin
  if to_regclass('public.flows') is null then
    raise exception 'Phase 1 preflight failed: public.flows is missing';
  end if;
  if to_regprocedure('gen_random_uuid()') is null then
    raise exception 'Phase 1 preflight failed: gen_random_uuid() is unavailable';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'flows'
      and column_name = 'id'
      and udt_name = 'uuid'
  ) then
    raise exception 'Phase 1 preflight failed: public.flows.id must be uuid';
  end if;
end
$$;

-- Catalog/drift preflight. A rerun is accepted only when all nine tables and
-- every named Phase 1 constraint/index already exist on the expected tables.
-- A partial or renamed historical schema requires a separately reviewed
-- reconciliation migration.
do $$
declare
  existing_table_count integer;
  expected_constraint_count integer;
  expected_index_count integer;
begin
  select count(*) into existing_table_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in (
      'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
      'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments'
    );

  if existing_table_count not in (0, 9) then
    raise exception 'Phase 1 catalog preflight failed: found % of 9 tables', existing_table_count;
  end if;

  if existing_table_count = 9 then
    with expected(table_name, constraint_name, constraint_type) as (
      values
        ('organizations', 'pk_organizations', 'p'),
        ('workspaces', 'pk_workspaces', 'p'),
        ('projects', 'pk_projects', 'p'),
        ('workbooks', 'pk_workbooks', 'p'),
        ('environments', 'pk_environments', 'p'),
        ('flow_project_bindings', 'pk_flow_project_bindings', 'p'),
        ('flow_versions', 'pk_flow_versions', 'p'),
        ('dependency_pins', 'pk_dependency_pins', 'p'),
        ('deployments', 'pk_deployments', 'p'),
        ('organizations', 'uq_organizations_personal_owner', 'u'),
        ('workspaces', 'uq_workspaces_organization_slug', 'u'),
        ('projects', 'uq_projects_workspace_slug', 'u'),
        ('workbooks', 'uq_workbooks_project_slug', 'u'),
        ('environments', 'uq_environments_project_slug', 'u'),
        ('flow_versions', 'uq_flow_versions_flow_number', 'u'),
        ('dependency_pins', 'uq_dependency_pins_version_kind_resource', 'u'),
        ('workspaces', 'workspaces_organization_id_fkey', 'f'),
        ('projects', 'projects_workspace_id_fkey', 'f'),
        ('workbooks', 'workbooks_project_id_fkey', 'f'),
        ('environments', 'environments_project_id_fkey', 'f'),
        ('flow_project_bindings', 'flow_project_bindings_flow_id_fkey', 'f'),
        ('flow_project_bindings', 'flow_project_bindings_project_id_fkey', 'f'),
        ('flow_project_bindings', 'flow_project_bindings_workbook_id_fkey', 'f'),
        ('flow_versions', 'flow_versions_flow_id_fkey', 'f'),
        ('dependency_pins', 'dependency_pins_flow_version_id_fkey', 'f'),
        ('deployments', 'deployments_flow_id_fkey', 'f'),
        ('deployments', 'deployments_flow_version_id_fkey', 'f'),
        ('deployments', 'deployments_environment_id_fkey', 'f')
    )
    select count(*) into expected_constraint_count
    from expected e
    join pg_class t on t.relname = e.table_name
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
    join pg_constraint c
      on c.conrelid = t.oid
      and c.conname = e.constraint_name
      and c.contype::text = e.constraint_type;

    if expected_constraint_count <> 28 then
      raise exception 'Phase 1 catalog preflight failed: expected 28 named constraints, found %', expected_constraint_count;
    end if;

    if exists (
      with expected(constraint_name, definition) as (
        values
          ('pk_organizations', 'primarykey(id)'),
          ('pk_workspaces', 'primarykey(id)'),
          ('pk_projects', 'primarykey(id)'),
          ('pk_workbooks', 'primarykey(id)'),
          ('pk_environments', 'primarykey(id)'),
          ('pk_flow_project_bindings', 'primarykey(flow_id)'),
          ('pk_flow_versions', 'primarykey(id)'),
          ('pk_dependency_pins', 'primarykey(id)'),
          ('pk_deployments', 'primarykey(id)'),
          ('uq_organizations_personal_owner', 'unique(personal_owner_id)'),
          ('uq_workspaces_organization_slug', 'unique(organization_id,slug)'),
          ('uq_projects_workspace_slug', 'unique(workspace_id,slug)'),
          ('uq_workbooks_project_slug', 'unique(project_id,slug)'),
          ('uq_environments_project_slug', 'unique(project_id,slug)'),
          ('uq_flow_versions_flow_number', 'unique(flow_id,version_number)'),
          ('uq_dependency_pins_version_kind_resource', 'unique(flow_version_id,kind,resource_id)'),
          ('workspaces_organization_id_fkey', 'foreignkey(organization_id)referencesorganizations(id)'),
          ('projects_workspace_id_fkey', 'foreignkey(workspace_id)referencesworkspaces(id)'),
          ('workbooks_project_id_fkey', 'foreignkey(project_id)referencesprojects(id)'),
          ('environments_project_id_fkey', 'foreignkey(project_id)referencesprojects(id)'),
          ('flow_project_bindings_flow_id_fkey', 'foreignkey(flow_id)referencesflows(id)'),
          ('flow_project_bindings_project_id_fkey', 'foreignkey(project_id)referencesprojects(id)'),
          ('flow_project_bindings_workbook_id_fkey', 'foreignkey(workbook_id)referencesworkbooks(id)'),
          ('flow_versions_flow_id_fkey', 'foreignkey(flow_id)referencesflows(id)'),
          ('dependency_pins_flow_version_id_fkey', 'foreignkey(flow_version_id)referencesflow_versions(id)'),
          ('deployments_flow_id_fkey', 'foreignkey(flow_id)referencesflows(id)'),
          ('deployments_flow_version_id_fkey', 'foreignkey(flow_version_id)referencesflow_versions(id)'),
          ('deployments_environment_id_fkey', 'foreignkey(environment_id)referencesenvironments(id)')
      )
      select 1
      from expected e
      join pg_constraint c on c.conname = e.constraint_name
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
      where replace(
        regexp_replace(lower(pg_get_constraintdef(c.oid)), '\s+', '', 'g'),
        'public.',
        ''
      ) <> e.definition
    ) then
      raise exception 'Phase 1 catalog preflight failed: named constraint definition drift';
    end if;

    if exists (
      select 1 from pg_constraint c
      where c.conname in (
          'workspaces_organization_id_fkey', 'projects_workspace_id_fkey',
          'workbooks_project_id_fkey', 'environments_project_id_fkey',
          'flow_project_bindings_flow_id_fkey', 'flow_project_bindings_project_id_fkey',
          'flow_project_bindings_workbook_id_fkey', 'flow_versions_flow_id_fkey',
          'dependency_pins_flow_version_id_fkey', 'deployments_flow_id_fkey',
          'deployments_flow_version_id_fkey', 'deployments_environment_id_fkey'
        )
        and c.conrelid in (
          'public.workspaces'::regclass, 'public.projects'::regclass,
          'public.workbooks'::regclass, 'public.environments'::regclass,
          'public.flow_project_bindings'::regclass, 'public.flow_versions'::regclass,
          'public.dependency_pins'::regclass, 'public.deployments'::regclass
        )
        and (c.confupdtype <> 'a' or c.confdeltype <> 'a')
    ) then
      raise exception 'Phase 1 catalog preflight failed: foreign-key action drift';
    end if;

    with expected(table_name, index_name) as (
      values
        ('workspaces', 'idx_workspaces_organization_id'),
        ('projects', 'idx_projects_workspace_id'),
        ('workbooks', 'idx_workbooks_project_id'),
        ('environments', 'idx_environments_project_id'),
        ('flow_project_bindings', 'idx_flow_project_bindings_project_id'),
        ('flow_project_bindings', 'idx_flow_project_bindings_workbook_id'),
        ('flow_versions', 'idx_flow_versions_flow_id'),
        ('dependency_pins', 'idx_dependency_pins_flow_version_id'),
        ('deployments', 'idx_deployments_flow_id'),
        ('deployments', 'idx_deployments_flow_version_id'),
        ('deployments', 'idx_deployments_environment_id'),
        ('environments', 'uq_environments_project_kind'),
        ('deployments', 'uq_deployments_active_flow_environment'),
        ('deployments', 'idx_deployments_flow_history')
    )
    select count(*) into expected_index_count
    from expected e
    join pg_indexes i
      on i.schemaname = 'public'
      and i.tablename = e.table_name
      and i.indexname = e.index_name;

    if expected_index_count <> 14 then
      raise exception 'Phase 1 catalog preflight failed: expected 14 explicit indexes, found %', expected_index_count;
    end if;

    if exists (
      with expected(index_name, definition) as (
        values
          ('idx_workspaces_organization_id', 'createindexidx_workspaces_organization_idonworkspacesusingbtree(organization_id)'),
          ('idx_projects_workspace_id', 'createindexidx_projects_workspace_idonprojectsusingbtree(workspace_id)'),
          ('idx_workbooks_project_id', 'createindexidx_workbooks_project_idonworkbooksusingbtree(project_id)'),
          ('idx_environments_project_id', 'createindexidx_environments_project_idonenvironmentsusingbtree(project_id)'),
          ('idx_flow_project_bindings_project_id', 'createindexidx_flow_project_bindings_project_idonflow_project_bindingsusingbtree(project_id)'),
          ('idx_flow_project_bindings_workbook_id', 'createindexidx_flow_project_bindings_workbook_idonflow_project_bindingsusingbtree(workbook_id)'),
          ('idx_flow_versions_flow_id', 'createindexidx_flow_versions_flow_idonflow_versionsusingbtree(flow_id)'),
          ('idx_dependency_pins_flow_version_id', 'createindexidx_dependency_pins_flow_version_idondependency_pinsusingbtree(flow_version_id)'),
          ('idx_deployments_flow_id', 'createindexidx_deployments_flow_idondeploymentsusingbtree(flow_id)'),
          ('idx_deployments_flow_version_id', 'createindexidx_deployments_flow_version_idondeploymentsusingbtree(flow_version_id)'),
          ('idx_deployments_environment_id', 'createindexidx_deployments_environment_idondeploymentsusingbtree(environment_id)'),
          ('uq_environments_project_kind', 'createuniqueindexuq_environments_project_kindonenvironmentsusingbtree(project_id,kind)'),
          ('uq_deployments_active_flow_environment', 'createuniqueindexuq_deployments_active_flow_environmentondeploymentsusingbtree(flow_id,environment_id)where(retired_atisnull)'),
          ('idx_deployments_flow_history', 'createindexidx_deployments_flow_historyondeploymentsusingbtree(flow_id,created_atdesc,iddesc)')
      )
      select 1
      from expected e
      join pg_indexes i
        on i.schemaname = 'public'
        and i.indexname = e.index_name
      where replace(
        regexp_replace(lower(i.indexdef), '\s+', '', 'g'),
        'public.',
        ''
      ) <> e.definition
    ) then
      raise exception 'Phase 1 catalog preflight failed: explicit index definition drift';
    end if;

    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and tablename = 'deployments'
        and indexname = 'uq_deployments_active_flow_environment'
        and lower(indexdef) like '%where (retired_at is null)%'
    ) then
      raise exception 'Phase 1 catalog preflight failed: active deployment index predicate drift';
    end if;
  end if;
end
$$;

create table if not exists public.organizations (
  id uuid constraint pk_organizations primary key default gen_random_uuid(),
  personal_owner_id text not null,
  name text not null,
  kind text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid constraint pk_workspaces primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  slug text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid constraint pk_projects primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workbooks (
  id uuid constraint pk_workbooks primary key default gen_random_uuid(),
  project_id uuid not null,
  name text not null,
  slug text not null,
  position integer not null,
  created_at timestamptz not null default now()
);

create table if not exists public.environments (
  id uuid constraint pk_environments primary key default gen_random_uuid(),
  project_id uuid not null,
  name text not null,
  slug text not null,
  kind text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.flow_project_bindings (
  flow_id uuid constraint pk_flow_project_bindings primary key,
  project_id uuid not null,
  workbook_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.flow_versions (
  id uuid constraint pk_flow_versions primary key default gen_random_uuid(),
  flow_id uuid not null,
  version_number integer not null,
  schema_version integer not null,
  label text,
  description text,
  graph jsonb not null,
  semantic_hash text not null,
  full_hash text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.dependency_pins (
  id uuid constraint pk_dependency_pins primary key default gen_random_uuid(),
  flow_version_id uuid not null,
  kind text not null,
  resource_id text not null,
  version text not null,
  content_hash text,
  created_at timestamptz not null default now()
);

create table if not exists public.deployments (
  id uuid constraint pk_deployments primary key default gen_random_uuid(),
  flow_id uuid not null,
  flow_version_id uuid not null,
  environment_id uuid not null,
  status text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

-- Shape preflight. A pre-existing table must contain exactly the Phase 1
-- columns with the expected Postgres types and nullability. This intentionally
-- aborts rather than silently accepting a historical or partially applied
-- table. The transaction rolls back any tables created above on failure.
do $$
declare
  mismatch text;
begin
  with expected(table_name, column_name, udt_name, is_nullable) as (
    values
      ('organizations', 'id', 'uuid', 'NO'),
      ('organizations', 'personal_owner_id', 'text', 'NO'),
      ('organizations', 'name', 'text', 'NO'),
      ('organizations', 'kind', 'text', 'NO'),
      ('organizations', 'created_at', 'timestamptz', 'NO'),
      ('workspaces', 'id', 'uuid', 'NO'),
      ('workspaces', 'organization_id', 'uuid', 'NO'),
      ('workspaces', 'name', 'text', 'NO'),
      ('workspaces', 'slug', 'text', 'NO'),
      ('workspaces', 'created_at', 'timestamptz', 'NO'),
      ('projects', 'id', 'uuid', 'NO'),
      ('projects', 'workspace_id', 'uuid', 'NO'),
      ('projects', 'name', 'text', 'NO'),
      ('projects', 'slug', 'text', 'NO'),
      ('projects', 'created_at', 'timestamptz', 'NO'),
      ('projects', 'updated_at', 'timestamptz', 'NO'),
      ('workbooks', 'id', 'uuid', 'NO'),
      ('workbooks', 'project_id', 'uuid', 'NO'),
      ('workbooks', 'name', 'text', 'NO'),
      ('workbooks', 'slug', 'text', 'NO'),
      ('workbooks', 'position', 'int4', 'NO'),
      ('workbooks', 'created_at', 'timestamptz', 'NO'),
      ('environments', 'id', 'uuid', 'NO'),
      ('environments', 'project_id', 'uuid', 'NO'),
      ('environments', 'name', 'text', 'NO'),
      ('environments', 'slug', 'text', 'NO'),
      ('environments', 'kind', 'text', 'NO'),
      ('environments', 'created_at', 'timestamptz', 'NO'),
      ('flow_project_bindings', 'flow_id', 'uuid', 'NO'),
      ('flow_project_bindings', 'project_id', 'uuid', 'NO'),
      ('flow_project_bindings', 'workbook_id', 'uuid', 'NO'),
      ('flow_project_bindings', 'created_at', 'timestamptz', 'NO'),
      ('flow_versions', 'id', 'uuid', 'NO'),
      ('flow_versions', 'flow_id', 'uuid', 'NO'),
      ('flow_versions', 'version_number', 'int4', 'NO'),
      ('flow_versions', 'schema_version', 'int4', 'NO'),
      ('flow_versions', 'label', 'text', 'YES'),
      ('flow_versions', 'description', 'text', 'YES'),
      ('flow_versions', 'graph', 'jsonb', 'NO'),
      ('flow_versions', 'semantic_hash', 'text', 'NO'),
      ('flow_versions', 'full_hash', 'text', 'NO'),
      ('flow_versions', 'created_by', 'text', 'NO'),
      ('flow_versions', 'created_at', 'timestamptz', 'NO'),
      ('dependency_pins', 'id', 'uuid', 'NO'),
      ('dependency_pins', 'flow_version_id', 'uuid', 'NO'),
      ('dependency_pins', 'kind', 'text', 'NO'),
      ('dependency_pins', 'resource_id', 'text', 'NO'),
      ('dependency_pins', 'version', 'text', 'NO'),
      ('dependency_pins', 'content_hash', 'text', 'YES'),
      ('dependency_pins', 'created_at', 'timestamptz', 'NO'),
      ('deployments', 'id', 'uuid', 'NO'),
      ('deployments', 'flow_id', 'uuid', 'NO'),
      ('deployments', 'flow_version_id', 'uuid', 'NO'),
      ('deployments', 'environment_id', 'uuid', 'NO'),
      ('deployments', 'status', 'text', 'NO'),
      ('deployments', 'created_at', 'timestamptz', 'NO'),
      ('deployments', 'retired_at', 'timestamptz', 'YES')
  ), actual as (
    select c.table_name, c.column_name, c.udt_name, c.is_nullable
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name in (
        'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
        'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments'
      )
  ), differences as (
    (select * from expected except select * from actual)
    union all
    (select * from actual except select * from expected)
  )
  select string_agg(format('%s.%s %s nullable=%s', table_name, column_name, udt_name, is_nullable), ', ')
    into mismatch
  from differences;

  if mismatch is not null then
    raise exception 'Phase 1 shape preflight failed: %', mismatch;
  end if;
end
$$;

-- Default-expression preflight. Every Phase 1 column is checked: generated
-- UUID identifiers use gen_random_uuid(), creation/update timestamps use
-- now(), and all other columns (including the binding key and retired_at)
-- have no default.
do $$
begin
  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name in (
        'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
        'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments'
      )
      and case
        when (c.table_name, c.column_name) in (
          ('organizations', 'id'), ('workspaces', 'id'), ('projects', 'id'),
          ('workbooks', 'id'), ('environments', 'id'), ('flow_versions', 'id'),
          ('dependency_pins', 'id'), ('deployments', 'id')
        ) then regexp_replace(lower(coalesce(c.column_default, '')), '\s+', '', 'g') <> 'gen_random_uuid()'
        when c.column_name = 'created_at'
          or (c.table_name = 'projects' and c.column_name = 'updated_at')
        then regexp_replace(lower(coalesce(c.column_default, '')), '\s+', '', 'g') <> 'now()'
        else c.column_default is not null
      end
  ) then
    raise exception 'Phase 1 shape preflight failed: column default drift';
  end if;
end
$$;

-- Duplicate and orphan preflight. Compatible reruns pass; incompatible data
-- fails before any uniqueness or foreign-key constraint is added.
do $$
begin
  if exists (select 1 from public.organizations group by personal_owner_id having count(*) > 1)
    or exists (select 1 from public.workspaces group by organization_id, slug having count(*) > 1)
    or exists (select 1 from public.projects group by workspace_id, slug having count(*) > 1)
    or exists (select 1 from public.workbooks group by project_id, slug having count(*) > 1)
    or exists (select 1 from public.environments group by project_id, slug having count(*) > 1)
    or exists (select 1 from public.environments group by project_id, kind having count(*) > 1)
    or exists (select 1 from public.flow_versions group by flow_id, version_number having count(*) > 1)
    or exists (
      select 1 from public.dependency_pins
      group by flow_version_id, kind, resource_id having count(*) > 1
    )
    or exists (
      select 1 from public.deployments where retired_at is null
      group by flow_id, environment_id having count(*) > 1
    ) then
    raise exception 'Phase 1 duplicate preflight failed';
  end if;

  if exists (select 1 from public.workspaces c left join public.organizations p on p.id = c.organization_id where p.id is null)
    or exists (select 1 from public.projects c left join public.workspaces p on p.id = c.workspace_id where p.id is null)
    or exists (select 1 from public.workbooks c left join public.projects p on p.id = c.project_id where p.id is null)
    or exists (select 1 from public.environments c left join public.projects p on p.id = c.project_id where p.id is null)
    or exists (select 1 from public.flow_project_bindings c left join public.flows p on p.id = c.flow_id where p.id is null)
    or exists (select 1 from public.flow_project_bindings c left join public.projects p on p.id = c.project_id where p.id is null)
    or exists (select 1 from public.flow_project_bindings c left join public.workbooks p on p.id = c.workbook_id where p.id is null)
    or exists (select 1 from public.flow_versions c left join public.flows p on p.id = c.flow_id where p.id is null)
    or exists (select 1 from public.dependency_pins c left join public.flow_versions p on p.id = c.flow_version_id where p.id is null)
    or exists (select 1 from public.deployments c left join public.flows p on p.id = c.flow_id where p.id is null)
    or exists (select 1 from public.deployments c left join public.flow_versions p on p.id = c.flow_version_id where p.id is null)
    or exists (select 1 from public.deployments c left join public.environments p on p.id = c.environment_id where p.id is null) then
    raise exception 'Phase 1 orphan preflight failed';
  end if;
end
$$;

-- Named uniqueness constraints from SQLite migration 5.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'uq_organizations_personal_owner') then
    alter table public.organizations add constraint uq_organizations_personal_owner unique (personal_owner_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.workspaces'::regclass and conname = 'uq_workspaces_organization_slug') then
    alter table public.workspaces add constraint uq_workspaces_organization_slug unique (organization_id, slug);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.projects'::regclass and conname = 'uq_projects_workspace_slug') then
    alter table public.projects add constraint uq_projects_workspace_slug unique (workspace_id, slug);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.workbooks'::regclass and conname = 'uq_workbooks_project_slug') then
    alter table public.workbooks add constraint uq_workbooks_project_slug unique (project_id, slug);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.environments'::regclass and conname = 'uq_environments_project_slug') then
    alter table public.environments add constraint uq_environments_project_slug unique (project_id, slug);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.flow_versions'::regclass and conname = 'uq_flow_versions_flow_number') then
    alter table public.flow_versions add constraint uq_flow_versions_flow_number unique (flow_id, version_number);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.dependency_pins'::regclass and conname = 'uq_dependency_pins_version_kind_resource') then
    alter table public.dependency_pins add constraint uq_dependency_pins_version_kind_resource unique (flow_version_id, kind, resource_id);
  end if;
end
$$;

-- Twelve named foreign keys from SQLite migration 5. No cascade behavior is
-- added because SQLite uses its default NO ACTION behavior for these links.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workspaces'::regclass and conname = 'workspaces_organization_id_fkey') then
    alter table public.workspaces add constraint workspaces_organization_id_fkey foreign key (organization_id) references public.organizations (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.projects'::regclass and conname = 'projects_workspace_id_fkey') then
    alter table public.projects add constraint projects_workspace_id_fkey foreign key (workspace_id) references public.workspaces (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.workbooks'::regclass and conname = 'workbooks_project_id_fkey') then
    alter table public.workbooks add constraint workbooks_project_id_fkey foreign key (project_id) references public.projects (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.environments'::regclass and conname = 'environments_project_id_fkey') then
    alter table public.environments add constraint environments_project_id_fkey foreign key (project_id) references public.projects (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.flow_project_bindings'::regclass and conname = 'flow_project_bindings_flow_id_fkey') then
    alter table public.flow_project_bindings add constraint flow_project_bindings_flow_id_fkey foreign key (flow_id) references public.flows (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.flow_project_bindings'::regclass and conname = 'flow_project_bindings_project_id_fkey') then
    alter table public.flow_project_bindings add constraint flow_project_bindings_project_id_fkey foreign key (project_id) references public.projects (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.flow_project_bindings'::regclass and conname = 'flow_project_bindings_workbook_id_fkey') then
    alter table public.flow_project_bindings add constraint flow_project_bindings_workbook_id_fkey foreign key (workbook_id) references public.workbooks (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.flow_versions'::regclass and conname = 'flow_versions_flow_id_fkey') then
    alter table public.flow_versions add constraint flow_versions_flow_id_fkey foreign key (flow_id) references public.flows (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.dependency_pins'::regclass and conname = 'dependency_pins_flow_version_id_fkey') then
    alter table public.dependency_pins add constraint dependency_pins_flow_version_id_fkey foreign key (flow_version_id) references public.flow_versions (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deployments'::regclass and conname = 'deployments_flow_id_fkey') then
    alter table public.deployments add constraint deployments_flow_id_fkey foreign key (flow_id) references public.flows (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deployments'::regclass and conname = 'deployments_flow_version_id_fkey') then
    alter table public.deployments add constraint deployments_flow_version_id_fkey foreign key (flow_version_id) references public.flow_versions (id) on update no action on delete no action;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deployments'::regclass and conname = 'deployments_environment_id_fkey') then
    alter table public.deployments add constraint deployments_environment_id_fkey foreign key (environment_id) references public.environments (id) on update no action on delete no action;
  end if;
end
$$;

-- Fourteen explicit indexes from SQLite migrations 5 and 6.
create index if not exists idx_workspaces_organization_id on public.workspaces (organization_id);
create index if not exists idx_projects_workspace_id on public.projects (workspace_id);
create index if not exists idx_workbooks_project_id on public.workbooks (project_id);
create index if not exists idx_environments_project_id on public.environments (project_id);
create index if not exists idx_flow_project_bindings_project_id on public.flow_project_bindings (project_id);
create index if not exists idx_flow_project_bindings_workbook_id on public.flow_project_bindings (workbook_id);
create index if not exists idx_flow_versions_flow_id on public.flow_versions (flow_id);
create index if not exists idx_dependency_pins_flow_version_id on public.dependency_pins (flow_version_id);
create index if not exists idx_deployments_flow_id on public.deployments (flow_id);
create index if not exists idx_deployments_flow_version_id on public.deployments (flow_version_id);
create index if not exists idx_deployments_environment_id on public.deployments (environment_id);
create unique index if not exists uq_environments_project_kind on public.environments (project_id, kind);
create unique index if not exists uq_deployments_active_flow_environment
  on public.deployments (flow_id, environment_id)
  where retired_at is null;
create index if not exists idx_deployments_flow_history
  on public.deployments (flow_id, created_at desc, id desc);

-- Server-only access model: RLS on every Phase 1 table, no public policies,
-- no anon/authenticated privileges, and explicit service-role privileges.
alter table public.organizations enable row level security;
alter table public.workspaces enable row level security;
alter table public.projects enable row level security;
alter table public.workbooks enable row level security;
alter table public.environments enable row level security;
alter table public.flow_project_bindings enable row level security;
alter table public.flow_versions enable row level security;
alter table public.dependency_pins enable row level security;
alter table public.deployments enable row level security;

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'organizations', 'workspaces', 'projects', 'workbooks', 'environments',
        'flow_project_bindings', 'flow_versions', 'dependency_pins', 'deployments'
      )
  ) then
    raise exception 'Phase 1 RLS preflight failed: Phase 1 tables must have no policies';
  end if;
end
$$;

revoke all on table
  public.organizations, public.workspaces, public.projects, public.workbooks,
  public.environments, public.flow_project_bindings, public.flow_versions,
  public.dependency_pins, public.deployments
from public, anon, authenticated;
grant select, insert, update, delete on table
  public.organizations, public.workspaces, public.projects, public.workbooks,
  public.environments, public.flow_project_bindings, public.flow_versions,
  public.dependency_pins, public.deployments
to service_role;

commit;
