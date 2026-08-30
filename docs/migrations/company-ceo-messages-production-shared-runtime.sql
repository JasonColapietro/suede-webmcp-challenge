-- Company CEO message persistence bridge for the production shared runtime.
--
-- Operator: Codex
-- Rollback owner: Jason Colapietro
--
-- The table was created separately on 2026-07-24. Production runs the
-- Supabase Data API as `anon` plus the server-only
-- x-agent-studio-secret header, so the original service-role-only ACL made
-- every CEO history read/write fail. This migration does not create or
-- rewrite the table. It accepts only the exact reviewed pre-state or its own
-- exact post-state, preserves RLS, installs the same request-secret policy as
-- the other Company tables, and narrows both table and identity-sequence
-- privileges to the append-only runtime contract.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(
  hashtextextended('suede-agent-studio:company-ceo-messages:shared-runtime:v1', 0)
);

do $$
declare
  target_acl jsonb;
  sequence_acl jsonb;
  authorizer_security_definer boolean;
  authorizer_volatility "char";
  authorizer_config text[];
  authorizer_definition_md5 text;
begin
  -- Production fingerprint. A wrong or partially provisioned project must
  -- fail before any policy or ACL is touched.
  if to_regclass('public.flows') is null
    or to_regclass('public.agents') is null
    or to_regclass('public.runs') is null
    or to_regclass('public.companies') is null
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'agents'
        and column_name = 'settlement_live'
    )
  then
    raise exception 'Agent Studio production fingerprint mismatch';
  end if;

  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'Company CEO persistence bridge requires PostgreSQL 17 or newer';
  end if;

  if not exists (
    select 1
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'company_ceo_messages'
      and tables.relkind = 'r'
      and pg_get_userbyid(tables.relowner) = 'postgres'
      and tables.relrowsecurity
      and not tables.relforcerowsecurity
  ) then
    raise exception 'Company CEO messages table ownership or RLS drift';
  end if;

  if (
    select array_agg(
      array[
        columns.column_name::text,
        columns.udt_name::text,
        columns.is_nullable::text,
        coalesce(columns.column_default, '')::text,
        columns.is_identity::text,
        coalesce(columns.identity_generation, '')::text
      ]
      order by columns.ordinal_position
    )
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'company_ceo_messages'
  ) is distinct from array[
    array['id', 'text', 'NO', '', 'NO', ''],
    array['company_id', 'text', 'NO', '', 'NO', ''],
    array['role', 'text', 'NO', '', 'NO', ''],
    array['content', 'text', 'NO', '', 'NO', ''],
    array['proposal', 'jsonb', 'YES', '', 'NO', ''],
    array['created_at', 'text', 'NO', '', 'NO', ''],
    array['seq', 'int8', 'NO', '', 'YES', 'ALWAYS']
  ]::text[][] then
    raise exception 'Company CEO messages column inventory drift';
  end if;

  if (
    select jsonb_agg(
      jsonb_build_array(
        constraints.conname,
        constraints.contype,
        pg_get_constraintdef(constraints.oid, true),
        constraints.convalidated
      )
      order by constraints.contype, constraints.conname
    )
    from pg_constraint constraints
    where constraints.conrelid = 'public.company_ceo_messages'::regclass
  ) is distinct from '[
    ["company_ceo_messages_role_check", "c", "CHECK (role = ANY (ARRAY[''user''::text, ''assistant''::text]))", true],
    ["company_ceo_messages_company_id_fkey", "f", "FOREIGN KEY (company_id) REFERENCES companies(id)", true],
    ["company_ceo_messages_pkey", "p", "PRIMARY KEY (id)", true]
  ]'::jsonb then
    raise exception 'Company CEO messages constraint inventory drift';
  end if;

  if (
    select jsonb_agg(
      jsonb_build_array(indexes.indexname, indexes.indexdef)
      order by indexes.indexname
    )
    from pg_indexes indexes
    where indexes.schemaname = 'public'
      and indexes.tablename = 'company_ceo_messages'
  ) is distinct from '[
    ["company_ceo_messages_pkey", "CREATE UNIQUE INDEX company_ceo_messages_pkey ON public.company_ceo_messages USING btree (id)"],
    ["idx_ceo_messages_company", "CREATE INDEX idx_ceo_messages_company ON public.company_ceo_messages USING btree (company_id, created_at, seq)"]
  ]'::jsonb then
    raise exception 'Company CEO messages index inventory drift';
  end if;

  if not exists (
    select 1
    from pg_class sequences
    join pg_namespace schemas on schemas.oid = sequences.relnamespace
    where schemas.nspname = 'public'
      and sequences.relname = 'company_ceo_messages_seq_seq'
      and sequences.relkind = 'S'
      and pg_get_userbyid(sequences.relowner) = 'postgres'
  ) or not exists (
    select 1
    from pg_sequences sequences
    where sequences.schemaname = 'public'
      and sequences.sequencename = 'company_ceo_messages_seq_seq'
      and sequences.data_type::text = 'bigint'
      and sequences.start_value = 1
      and sequences.min_value = 1
      and sequences.max_value = 9223372036854775807
      and sequences.increment_by = 1
      and not sequences.cycle
  ) or (
    select jsonb_agg(
      jsonb_build_array(dependencies.deptype, attributes.attname)
      order by dependencies.deptype, attributes.attname
    )
    from pg_depend dependencies
    join pg_class sequences on sequences.oid = dependencies.objid
    join pg_namespace schemas on schemas.oid = sequences.relnamespace
    join pg_class tables on tables.oid = dependencies.refobjid
    join pg_attribute attributes
      on attributes.attrelid = tables.oid
      and attributes.attnum = dependencies.refobjsubid
    where schemas.nspname = 'public'
      and sequences.relname = 'company_ceo_messages_seq_seq'
      and tables.oid = 'public.company_ceo_messages'::regclass
  ) is distinct from '[["i", "seq"]]'::jsonb then
    raise exception 'Company CEO messages identity sequence drift';
  end if;

  -- Preserve the existing shared-runtime primitive exactly; this migration
  -- only extends it to one table.
  if to_regprocedure('agent_studio_private.request_authorized()') is null then
    raise exception 'Agent Studio shared-runtime authorization function is missing';
  end if;

  select
    functions.prosecdef,
    functions.provolatile,
    functions.proconfig,
    md5(pg_get_functiondef(functions.oid))
  into
    authorizer_security_definer,
    authorizer_volatility,
    authorizer_config,
    authorizer_definition_md5
  from pg_proc functions
  join pg_namespace schemas on schemas.oid = functions.pronamespace
  where schemas.nspname = 'agent_studio_private'
    and functions.proname = 'request_authorized'
    and functions.pronargs = 0;

  if authorizer_security_definer is distinct from true
    or authorizer_volatility is distinct from 's'::"char"
    or authorizer_config is distinct from
      array['search_path=pg_catalog, public, extensions']::text[]
    or authorizer_definition_md5 is distinct from
      'df7b8f2cecae6b0b0ad121f0801ae57c'
  then
    raise exception 'Agent Studio shared-runtime authorization function drift';
  end if;

  if not has_schema_privilege('anon', 'agent_studio_private', 'usage')
    or not has_function_privilege(
      'anon',
      'agent_studio_private.request_authorized()',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'agent_studio_private.request_authorized()',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'agent_studio_private.request_authorized()',
      'execute'
    )
  then
    raise exception 'Agent Studio shared-runtime authorization grants drift';
  end if;

  if (
    select count(*)
    from public.agent_studio_runtime_secrets
  ) <> 1 or not exists (
    select 1
    from public.agent_studio_runtime_secrets
    where id = 'primary'
      and schema_revision = 'shared-runtime-v2'
      and secret_hash ~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Agent Studio shared-runtime v2 marker drift';
  end if;

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
      and columns.table_name = 'agent_studio_runtime_secrets'
  ) is distinct from array[
    array['id', 'text', 'NO'],
    array['secret_hash', 'text', 'NO'],
    array['schema_revision', 'text', 'NO'],
    array['updated_at', 'timestamptz', 'NO']
  ]::text[][] then
    raise exception 'Agent Studio shared-runtime marker column drift';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'companies'
      and policyname = 'agent_studio_server_access'
      and permissive = 'PERMISSIVE'
      and roles = array['anon']::name[]
      and cmd = 'ALL'
      and qual = 'agent_studio_private.request_authorized()'
      and with_check = 'agent_studio_private.request_authorized()'
  ) <> 1 then
    raise exception 'Company shared-runtime policy template drift';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'company_ceo_messages'
      and (
        policyname <> 'agent_studio_server_access'
        or permissive <> 'PERMISSIVE'
        or roles <> array['anon']::name[]
        or cmd <> 'ALL'
        or qual <> 'agent_studio_private.request_authorized()'
        or with_check <> 'agent_studio_private.request_authorized()'
      )
  ) or (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'company_ceo_messages'
  ) > 1 then
    raise exception 'Company CEO messages policy drift';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        pg_get_userbyid(privileges.grantee),
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by pg_get_userbyid(privileges.grantee), privileges.privilege_type
    ),
    '[]'::jsonb
  )
  into target_acl
  from pg_class tables
  join pg_namespace schemas on schemas.oid = tables.relnamespace
  cross join lateral aclexplode(
    coalesce(tables.relacl, acldefault('r', tables.relowner))
  ) privileges
  where schemas.nspname = 'public'
    and tables.relname = 'company_ceo_messages'
    and privileges.grantee <> tables.relowner;

  if target_acl is distinct from '[
    ["service_role", "INSERT", "postgres", false],
    ["service_role", "REFERENCES", "postgres", false],
    ["service_role", "SELECT", "postgres", false],
    ["service_role", "TRIGGER", "postgres", false],
    ["service_role", "TRUNCATE", "postgres", false]
  ]'::jsonb and target_acl is distinct from '[
    ["anon", "INSERT", "postgres", false],
    ["anon", "SELECT", "postgres", false],
    ["service_role", "INSERT", "postgres", false],
    ["service_role", "SELECT", "postgres", false]
  ]'::jsonb then
    raise exception 'Company CEO messages pre-apply ACL drift';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        pg_get_userbyid(privileges.grantee),
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by pg_get_userbyid(privileges.grantee), privileges.privilege_type
    ),
    '[]'::jsonb
  )
  into sequence_acl
  from pg_class sequences
  join pg_namespace schemas on schemas.oid = sequences.relnamespace
  cross join lateral aclexplode(
    coalesce(sequences.relacl, acldefault('S', sequences.relowner))
  ) privileges
  where schemas.nspname = 'public'
    and sequences.relname = 'company_ceo_messages_seq_seq'
    and privileges.grantee <> sequences.relowner;

  if sequence_acl is distinct from '[
    ["anon", "SELECT", "postgres", false],
    ["anon", "UPDATE", "postgres", false],
    ["anon", "USAGE", "postgres", false],
    ["authenticated", "SELECT", "postgres", false],
    ["authenticated", "UPDATE", "postgres", false],
    ["authenticated", "USAGE", "postgres", false],
    ["service_role", "SELECT", "postgres", false],
    ["service_role", "UPDATE", "postgres", false],
    ["service_role", "USAGE", "postgres", false]
  ]'::jsonb and sequence_acl is distinct from '[
    ["anon", "USAGE", "postgres", false],
    ["service_role", "USAGE", "postgres", false]
  ]'::jsonb then
    raise exception 'Company CEO messages pre-apply sequence ACL drift';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'company_ceo_messages'
      and policyname = 'agent_studio_server_access'
  ) then
    execute $policy$
      create policy agent_studio_server_access
        on public.company_ceo_messages
        for all
        to anon
        using (agent_studio_private.request_authorized())
        with check (agent_studio_private.request_authorized())
    $policy$;
  end if;
end
$$;

revoke all privileges on table public.company_ceo_messages
  from public, anon, authenticated, service_role;
grant select, insert on table public.company_ceo_messages
  to anon, service_role;

revoke all privileges on sequence public.company_ceo_messages_seq_seq
  from public, anon, authenticated, service_role;
grant usage on sequence public.company_ceo_messages_seq_seq
  to anon, service_role;

comment on policy agent_studio_server_access
  on public.company_ceo_messages is
  'Server-only CEO conversation access through the shared-runtime request secret.';

do $$
declare
  target_acl jsonb;
  sequence_acl jsonb;
begin
  if not (
    select tables.relrowsecurity
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'company_ceo_messages'
      and tables.relkind = 'r'
  ) then
    raise exception 'Company CEO messages RLS was not preserved';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'company_ceo_messages'
      and policyname = 'agent_studio_server_access'
      and permissive = 'PERMISSIVE'
      and roles = array['anon']::name[]
      and cmd = 'ALL'
      and qual = 'agent_studio_private.request_authorized()'
      and with_check = 'agent_studio_private.request_authorized()'
  ) <> 1 or (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'company_ceo_messages'
  ) <> 1 then
    raise exception 'Company CEO messages policy readback failed';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        pg_get_userbyid(privileges.grantee),
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by pg_get_userbyid(privileges.grantee), privileges.privilege_type
    ),
    '[]'::jsonb
  )
  into target_acl
  from pg_class tables
  join pg_namespace schemas on schemas.oid = tables.relnamespace
  cross join lateral aclexplode(
    coalesce(tables.relacl, acldefault('r', tables.relowner))
  ) privileges
  where schemas.nspname = 'public'
    and tables.relname = 'company_ceo_messages'
    and privileges.grantee <> tables.relowner;

  if target_acl is distinct from '[
    ["anon", "INSERT", "postgres", false],
    ["anon", "SELECT", "postgres", false],
    ["service_role", "INSERT", "postgres", false],
    ["service_role", "SELECT", "postgres", false]
  ]'::jsonb then
    raise exception 'Company CEO messages privilege readback failed';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        pg_get_userbyid(privileges.grantee),
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by pg_get_userbyid(privileges.grantee), privileges.privilege_type
    ),
    '[]'::jsonb
  )
  into sequence_acl
  from pg_class sequences
  join pg_namespace schemas on schemas.oid = sequences.relnamespace
  cross join lateral aclexplode(
    coalesce(sequences.relacl, acldefault('S', sequences.relowner))
  ) privileges
  where schemas.nspname = 'public'
    and sequences.relname = 'company_ceo_messages_seq_seq'
    and privileges.grantee <> sequences.relowner;

  if sequence_acl is distinct from '[
    ["anon", "USAGE", "postgres", false],
    ["service_role", "USAGE", "postgres", false]
  ]'::jsonb then
    raise exception 'Company CEO messages sequence privilege readback failed';
  end if;

  if has_table_privilege('authenticated', 'public.company_ceo_messages', 'select')
    or has_table_privilege('authenticated', 'public.company_ceo_messages', 'insert')
    or has_sequence_privilege(
      'authenticated',
      'public.company_ceo_messages_seq_seq',
      'usage'
    )
    or has_sequence_privilege(
      'authenticated',
      'public.company_ceo_messages_seq_seq',
      'select'
    )
    or has_sequence_privilege(
      'authenticated',
      'public.company_ceo_messages_seq_seq',
      'update'
    )
  then
    raise exception 'Company CEO messages browser-role privilege readback failed';
  end if;
end
$$;

commit;
