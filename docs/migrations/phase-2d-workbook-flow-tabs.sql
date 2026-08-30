-- Phase 2D ordered workbook flow tabs for Supabase/Postgres.
--
-- MANUAL OPERATOR INPUT ONLY. This prepared file is never applied by builds,
-- tests, application startup, previews, deploys, or runtime providers. It has
-- not been applied to production. Before any future operator use, read back
-- the live catalog and data, test this unchanged file twice in a disposable
-- production-shaped database, obtain explicit approval, and name a rollback
-- owner. SQLite remains the only enabled runtime store for this feature.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Serialize the manual operation. The lock is released by commit or rollback.
select pg_advisory_xact_lock(
  hashtextextended('suede-agent-studio:phase-2d-workbook-flow-tabs', 0)
);

-- Production baseline preflight. Phase 2D is additive and must never create a
-- replacement hierarchy or modify the existing flows/auth ownership model.
do $$
declare
  prerequisite text;
begin
  foreach prerequisite in array array[
    'flows',
    'organizations',
    'workspaces',
    'projects',
    'workbooks',
    'flow_project_bindings'
  ] loop
    if to_regclass('public.' || prerequisite) is null then
      raise exception 'Phase 2D production baseline preflight failed: public.% is missing', prerequisite;
    end if;
  end loop;

  if to_regrole('service_role') is null
    or to_regrole('anon') is null
    or to_regrole('authenticated') is null then
    raise exception 'Phase 2D production baseline preflight failed: required Supabase role is missing';
  end if;

  -- With zero policies and a table owner distinct from service_role, server
  -- access is viable only when the Supabase service role bypasses RLS.
  if not exists (
    select 1
    from pg_roles
    where rolname = 'service_role'
      and rolbypassrls is true
  ) then
    raise exception 'Phase 2D production baseline preflight failed: service_role must bypass RLS';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flows'
      and column_name = 'id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flows'
      and column_name = 'owner_id' and data_type = 'text' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations'
      and column_name = 'id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations'
      and column_name = 'personal_owner_id' and data_type = 'text' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flow_project_bindings'
      and column_name = 'flow_id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flow_project_bindings'
      and column_name = 'project_id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flow_project_bindings'
      and column_name = 'workbook_id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flow_project_bindings'
      and column_name = 'created_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO'
  ) then
    raise exception 'Phase 2D production baseline preflight failed: prerequisite column shape drift';
  end if;
end
$$;

-- Catalog/drift preflight. A prior table is accepted only when it is the exact
-- reviewed table. Partial, renamed, or differently constrained shapes abort.
do $$
declare
  existing_table_count integer;
  matching_column_count integer;
  matching_constraint_count integer;
  matching_index_count integer;
  explicit_index_count integer;
begin
  select count(*) into existing_table_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname = 'workbook_flow_tabs';

  if existing_table_count not in (0, 1) then
    raise exception 'Phase 2D catalog/drift preflight failed: unexpected table count %', existing_table_count;
  end if;

  if existing_table_count = 1 then
    -- Column grants are independent of table grants. Exact reruns have none.
    if exists (
      select 1
      from pg_class c
      where c.oid = 'public.workbook_flow_tabs'::regclass
        and (
          c.relkind <> 'r'
          or c.relpersistence <> 'p'
          or c.relowner <> (select oid from pg_roles where rolname = current_user)
          or c.relrowsecurity is not true
          or c.relforcerowsecurity is not false
          or c.relreplident <> 'd'
          or c.relispartition is true
        )
    ) then
      raise exception 'Phase 2D shape preflight failed: owner/security flag drift';
    end if;

    if exists (
      select 1
      from pg_policy p
      where p.polrelid = 'public.workbook_flow_tabs'::regclass
    ) then
      raise exception 'Phase 2D shape preflight failed: existing RLS policy drift';
    end if;

    if exists (
      select 1
      from pg_attribute a
      where a.attrelid = 'public.workbook_flow_tabs'::regclass
        and a.attnum > 0
        and a.attisdropped is false
        and a.attacl is not null
    ) then
      raise exception 'Phase 2D shape preflight failed: unexpected column ACL drift';
    end if;

    if (
      select count(*)
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = 'public.workbook_flow_tabs'::regclass
    ) <> 11 or (
      select count(*)
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = 'public.workbook_flow_tabs'::regclass
        and acl.grantee = c.relowner
        and upper(acl.privilege_type) in (
          'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
        )
    ) <> 7 or (
      select count(*)
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = 'public.workbook_flow_tabs'::regclass
        and acl.grantee = to_regrole('service_role')
        and upper(acl.privilege_type) in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ) <> 4 or exists (
      select 1
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = 'public.workbook_flow_tabs'::regclass
        and (
          acl.grantor <> c.relowner
          or acl.is_grantable is true
          or not (
            (
              acl.grantee = c.relowner
              and upper(acl.privilege_type) in (
                'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
              )
            )
            or (
              acl.grantee = to_regrole('service_role')
              and upper(acl.privilege_type) in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
            )
          )
        )
    ) then
      raise exception 'Phase 2D shape preflight failed: unexpected direct ACL drift';
    end if;

    with expected(
      ordinal_position,
      column_name,
      udt_name,
      nullable,
      default_kind
    ) as (
      values
        (1, 'id', 'uuid', 'NO', 'none'),
        (2, 'workbook_id', 'uuid', 'NO', 'none'),
        (3, 'flow_id', 'uuid', 'NO', 'none'),
        (4, 'title', 'text', 'NO', 'none'),
        (5, 'position', 'int4', 'NO', 'none'),
        (6, 'created_at', 'timestamptz', 'NO', 'now'),
        (7, 'updated_at', 'timestamptz', 'NO', 'now')
    )
    select count(*) into matching_column_count
    from expected e
    join information_schema.columns c
      on c.table_schema = 'public'
      and c.table_name = 'workbook_flow_tabs'
      and c.ordinal_position = e.ordinal_position
      and c.column_name = e.column_name
      and c.udt_name = e.udt_name
      and c.is_nullable = e.nullable
      and c.is_identity = 'NO'
      and c.is_generated = 'NEVER'
      and (
        (e.default_kind = 'none' and c.column_default is null)
        or (
          e.default_kind = 'now'
          and regexp_replace(lower(c.column_default), '\s+', '', 'g') = 'now()'
        )
      );

    if matching_column_count <> 7 or (
      select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'workbook_flow_tabs'
    ) <> 7 then
      raise exception 'Phase 2D shape preflight failed: exact column/default drift';
    end if;

    with expected(constraint_name, constraint_type) as (
      values
        ('pk_workbook_flow_tabs', 'p'),
        ('workbook_flow_tabs_workbook_id_fkey', 'f'),
        ('workbook_flow_tabs_flow_id_fkey', 'f'),
        ('uq_workbook_flow_tabs_membership', 'u'),
        ('uq_workbook_flow_tabs_flow', 'u'),
        ('uq_workbook_flow_tabs_position', 'u'),
        ('ck_workbook_flow_tabs_title', 'c'),
        ('ck_workbook_flow_tabs_position', 'c')
    )
    select count(*) into matching_constraint_count
    from expected e
    join pg_constraint c
      on c.conrelid = 'public.workbook_flow_tabs'::regclass
      and c.conname = e.constraint_name
      and c.contype::text = e.constraint_type;

    if matching_constraint_count <> 8 or (
      select count(*) from pg_constraint
      where conrelid = 'public.workbook_flow_tabs'::regclass
    ) <> 8 then
      raise exception 'Phase 2D shape preflight failed: workbook_flow_tabs constraint drift';
    end if;

    if exists (
      with expected(constraint_name, definition) as (
        values
          ('pk_workbook_flow_tabs', 'primarykey(id)'),
          ('workbook_flow_tabs_workbook_id_fkey', 'foreignkey(workbook_id)referencesworkbooks(id)'),
          ('workbook_flow_tabs_flow_id_fkey', 'foreignkey(flow_id)referencesflows(id)ondeletecascade'),
          ('uq_workbook_flow_tabs_membership', 'unique(workbook_id,flow_id)'),
          ('uq_workbook_flow_tabs_flow', 'unique(flow_id)'),
          ('uq_workbook_flow_tabs_position', 'unique(workbook_id,position)')
      )
      select 1
      from expected e
      join pg_constraint c
        on c.conrelid = 'public.workbook_flow_tabs'::regclass
        and c.conname = e.constraint_name
      where replace(
        regexp_replace(lower(pg_get_constraintdef(c.oid)), '\s+', '', 'g'),
        'public.',
        ''
      ) <> e.definition
    ) or exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.workbook_flow_tabs'::regclass
        and c.conname = 'ck_workbook_flow_tabs_title'
        and regexp_replace(
          lower(pg_get_constraintdef(c.oid)),
          '[()\s]',
          '',
          'g'
        ) <> 'checkchar_lengthbtrimtitle>=1andchar_lengthbtrimtitle<=200'
    ) or exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.workbook_flow_tabs'::regclass
        and c.conname = 'ck_workbook_flow_tabs_position'
        and regexp_replace(
          lower(pg_get_constraintdef(c.oid)),
          '[()\s]',
          '',
          'g'
        ) <> 'checkposition>=0'
    ) then
      raise exception 'Phase 2D shape preflight failed: named constraint definition drift';
    end if;

    if exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.workbook_flow_tabs'::regclass
        and (
          (c.conname = 'workbook_flow_tabs_workbook_id_fkey'
            and (c.confrelid <> 'public.workbooks'::regclass or c.confupdtype <> 'a' or c.confdeltype <> 'a'))
          or
          (c.conname = 'workbook_flow_tabs_flow_id_fkey'
            and (c.confrelid <> 'public.flows'::regclass or c.confupdtype <> 'a' or c.confdeltype <> 'c'))
        )
    ) then
      raise exception 'Phase 2D shape preflight failed: foreign-key action drift';
    end if;

    with expected(index_name, definition) as (
      values
        (
          'idx_workbook_flow_tabs_workbook_order',
          'createindexidx_workbook_flow_tabs_workbook_orderonworkbook_flow_tabsusingbtree(workbook_id,position,id)'
        ),
        (
          'idx_workbook_flow_tabs_flow_id',
          'createindexidx_workbook_flow_tabs_flow_idonworkbook_flow_tabsusingbtree(flow_id)'
        )
    )
    select count(*) into matching_index_count
    from expected e
    join pg_indexes catalog_index
      on catalog_index.schemaname = 'public'
      and catalog_index.tablename = 'workbook_flow_tabs'
      and catalog_index.indexname = e.index_name
    join pg_class index_class on index_class.relname = catalog_index.indexname
    join pg_namespace index_namespace
      on index_namespace.oid = index_class.relnamespace
      and index_namespace.nspname = 'public'
    join pg_index index_meta on index_meta.indexrelid = index_class.oid
      and index_meta.indisvalid is true
      and index_meta.indisready is true
      and index_meta.indisunique is false
      and index_meta.indisprimary is false
      and index_meta.indpred is null
      and index_meta.indexprs is null
    where replace(
        regexp_replace(lower(catalog_index.indexdef), '\s+', '', 'g'),
        'public.',
        ''
      ) = e.definition;

    select count(*) into explicit_index_count
    from pg_index i
    join pg_class table_class on table_class.oid = i.indrelid
    join pg_namespace table_namespace
      on table_namespace.oid = table_class.relnamespace
      and table_namespace.nspname = 'public'
    left join pg_constraint backing on backing.conindid = i.indexrelid
    where table_class.relname = 'workbook_flow_tabs'
      and backing.oid is null;

    if matching_index_count <> 2 or explicit_index_count <> 2 then
      raise exception 'Phase 2D shape preflight failed: complete explicit index set drift';
    end if;
  end if;
end
$$;

-- Binding integrity preflight. Reject duplicates, incomplete hierarchy rows,
-- mismatched workbook/project pairs, and divergent flow/organization owners.
do $$
begin
  if exists (
    select 1
    from public.flow_project_bindings b
    group by b.flow_id
    having count(*) > 1
  ) or exists (
    select 1
    from public.flow_project_bindings b
    left join public.flows f on f.id = b.flow_id
    where f.id is null
  ) or exists (
    select 1
    from public.flow_project_bindings b
    left join public.workbooks w on w.id = b.workbook_id
    where w.id is null
  ) or exists (
    select 1
    from public.flow_project_bindings b
    left join public.projects p on p.id = b.project_id
    where p.id is null
  ) or exists (
    select 1
    from public.flow_project_bindings b
    join public.workbooks w on w.id = b.workbook_id
    join public.projects p on p.id = b.project_id
    left join public.workspaces ws on ws.id = p.workspace_id
    where ws.id is null
  ) or exists (
    select 1
    from public.flow_project_bindings b
    join public.workbooks w on w.id = b.workbook_id
    join public.projects p on p.id = b.project_id
    join public.workspaces ws on ws.id = p.workspace_id
    left join public.organizations o on o.id = ws.organization_id
    where o.id is null
  ) or exists (
    select 1
    from public.flow_project_bindings b
    join public.workbooks w on w.id = b.workbook_id
    where b.project_id <> w.project_id
  ) or exists (
    select 1
    from public.flow_project_bindings b
    join public.flows f on f.id = b.flow_id
    join public.projects p on p.id = b.project_id
    join public.workspaces ws on ws.id = p.workspace_id
    join public.organizations o on o.id = ws.organization_id
    where f.owner_id <> o.personal_owner_id
  ) then
    raise exception 'Phase 2D binding integrity preflight failed';
  end if;
end
$$;

create table if not exists public.workbook_flow_tabs (
  id uuid constraint pk_workbook_flow_tabs primary key,
  workbook_id uuid not null,
  flow_id uuid not null,
  title text not null,
  position integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workbook_flow_tabs_workbook_id_fkey foreign key (workbook_id)
    references public.workbooks(id) on update no action on delete no action,
  constraint workbook_flow_tabs_flow_id_fkey foreign key (flow_id)
    references public.flows(id) on update no action on delete cascade,
  constraint uq_workbook_flow_tabs_membership unique (workbook_id, flow_id),
  constraint uq_workbook_flow_tabs_flow unique (flow_id),
  constraint uq_workbook_flow_tabs_position unique (workbook_id, position),
  constraint ck_workbook_flow_tabs_title check (char_length(btrim(title)) between 1 and 200),
  constraint ck_workbook_flow_tabs_position check (position >= 0)
);

create index if not exists idx_workbook_flow_tabs_workbook_order
  on public.workbook_flow_tabs (workbook_id, position, id);
create index if not exists idx_workbook_flow_tabs_flow_id
  on public.workbook_flow_tabs (flow_id);

-- Deterministic migration backfill. Runtime-created tab IDs remain unrelated
-- to this migration and are generated by the application.
with ranked as (
  select
    b.workbook_id,
    b.flow_id,
    f.name as flow_name,
    b.created_at,
    (row_number() over (
      partition by b.workbook_id order by b.created_at, b.flow_id
    ) - 1)::integer as position
  from public.flow_project_bindings b
  join public.flows f on f.id = b.flow_id
), hashed as (
  select
    ranked.*,
    md5(workbook_id::text || ':' || flow_id::text) as hash_hex
  from ranked
)
insert into public.workbook_flow_tabs (
  id, workbook_id, flow_id, title, position, created_at, updated_at
)
select
  (
    substr(hash_hex, 1, 8) || '-' ||
    substr(hash_hex, 9, 4) || '-' ||
    substr(hash_hex, 13, 4) || '-' ||
    substr(hash_hex, 17, 4) || '-' ||
    substr(hash_hex, 21, 12)
  )::uuid,
  workbook_id,
  flow_id,
  case
    when position = 0 then 'Main'
    else coalesce(nullif(btrim(flow_name), ''), 'Flow ' || (position + 1)::text)
  end,
  position,
  created_at,
  created_at
from hashed
on conflict (workbook_id, flow_id) do nothing;

-- Readback integrity. Membership is an exact bidirectional projection of the
-- authoritative binding table, including workbook and owner hierarchy.
do $$
begin
  if exists (
    select 1
    from public.flow_project_bindings b
    left join public.workbook_flow_tabs t
      on t.flow_id = b.flow_id and t.workbook_id = b.workbook_id
    where t.id is null
  ) or exists (
    select 1
    from public.workbook_flow_tabs t
    left join public.flow_project_bindings b
      on b.flow_id = t.flow_id and b.workbook_id = t.workbook_id
    where b.flow_id is null
  ) then
    raise exception 'Phase 2D bidirectional projection readback failed';
  end if;

  if exists (
    select 1
    from public.workbook_flow_tabs t
    join public.flow_project_bindings b on b.flow_id = t.flow_id
    join public.workbooks w on w.id = t.workbook_id
    join public.projects p on p.id = w.project_id
    join public.workspaces ws on ws.id = p.workspace_id
    join public.organizations o on o.id = ws.organization_id
    join public.flows f on f.id = t.flow_id
    where b.workbook_id <> t.workbook_id
      or b.project_id <> w.project_id
      or f.owner_id <> o.personal_owner_id
  ) then
    raise exception 'Phase 2D hierarchy and owner-chain readback failed';
  end if;

  if exists (
    select 1
    from (
      select
        position,
        (row_number() over (
          partition by workbook_id order by position, id
        ) - 1)::integer as expected_position
      from public.workbook_flow_tabs
    ) ordered
    where ordered.position <> ordered.expected_position
  ) then
    raise exception 'Phase 2D contiguous position readback failed';
  end if;

  if exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.workbook_flow_tabs'::regclass
      and (
        (c.conname = 'workbook_flow_tabs_workbook_id_fkey'
          and (c.confrelid <> 'public.workbooks'::regclass or c.confupdtype <> 'a' or c.confdeltype <> 'a'))
        or
        (c.conname = 'workbook_flow_tabs_flow_id_fkey'
          and (c.confrelid <> 'public.flows'::regclass or c.confupdtype <> 'a' or c.confdeltype <> 'c'))
      )
  ) then
    raise exception 'Phase 2D post-create foreign-key action drift';
  end if;
end
$$;

-- Server-only access: no browser/public policies are introduced.
alter table public.workbook_flow_tabs enable row level security;
-- Table-level REVOKE does not clear column ACLs, so clear every named column
-- for every role this migration recognizes before establishing table grants.
revoke all privileges (
  id, workbook_id, flow_id, title, position, created_at, updated_at
) on table public.workbook_flow_tabs from public, anon, authenticated, service_role;
revoke all on table public.workbook_flow_tabs from public;
revoke all on table public.workbook_flow_tabs from anon;
revoke all on table public.workbook_flow_tabs from authenticated;
revoke all on table public.workbook_flow_tabs from service_role;
grant select, insert, update, delete on table public.workbook_flow_tabs to service_role;

-- Privilege/security readback is part of the same transaction. Any unexpected
-- direct grantee, policy, owner, flag, or grant option rolls everything back.
do $$
begin
  if not exists (
    select 1
    from pg_class c
    where c.oid = 'public.workbook_flow_tabs'::regclass
      and c.relkind = 'r'
      and c.relpersistence = 'p'
      and c.relowner = (select oid from pg_roles where rolname = current_user)
      and c.relrowsecurity is true
      and c.relforcerowsecurity is false
      and c.relreplident = 'd'
      and c.relispartition is false
  ) or exists (
    select 1
    from pg_policy p
    where p.polrelid = 'public.workbook_flow_tabs'::regclass
  ) then
    raise exception 'Phase 2D post-grant RLS/policy readback failed';
  end if;

  if not exists (
    select 1
    from pg_roles
    where rolname = 'service_role'
      and rolbypassrls is true
  ) then
    raise exception 'Phase 2D post-grant service_role RLS bypass readback failed';
  end if;

  if exists (
    select 1
    from pg_attribute a
    where a.attrelid = 'public.workbook_flow_tabs'::regclass
      and a.attnum > 0
      and a.attisdropped is false
      and a.attacl is not null
  ) then
    raise exception 'Phase 2D post-grant column ACL readback failed';
  end if;

  if (
    select count(*)
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'public.workbook_flow_tabs'::regclass
  ) <> 11 or (
    select count(*)
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'public.workbook_flow_tabs'::regclass
      and acl.grantee = c.relowner
      and upper(acl.privilege_type) in (
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      )
  ) <> 7 or (
    select count(*)
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'public.workbook_flow_tabs'::regclass
      and acl.grantee = to_regrole('service_role')
      and upper(acl.privilege_type) in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) <> 4 or exists (
    select 1
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'public.workbook_flow_tabs'::regclass
      and (
        acl.grantor <> c.relowner
        or acl.is_grantable is true
        or not (
          (
            acl.grantee = c.relowner
            and upper(acl.privilege_type) in (
              'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
            )
          )
          or (
            acl.grantee = to_regrole('service_role')
            and upper(acl.privilege_type) in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
          )
        )
      )
  ) then
    raise exception 'Phase 2D post-grant direct ACL readback failed';
  end if;
end
$$;

commit;
