-- Company CEO shared-runtime security contract guard v1.
--
-- Generated with Supabase CLI migration new, then placed in the repository's
-- reviewed manual-migration directory.
-- Operator: Codex
-- Rollback owner: Jason Colapietro
--
-- This is a validation-only, idempotent migration. It makes no persistent
-- schema, policy, privilege, function, or data changes. It records a migration
-- only when the live production fingerprint, CEO persistence contract, and
-- every shared-runtime security dependency match the reviewed state exactly.

begin;
set local search_path = pg_catalog, public;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(
  hashtextextended(
    'suede-agent-studio:company-ceo-messages:shared-runtime-contract:v1',
    0
  )
);

do $contract$
declare
  private_schema_acl jsonb;
  authorizer_acl jsonb;
  marker_acl jsonb;
  target_acl jsonb;
  sequence_acl jsonb;
  authorizer_owner text;
  authorizer_security_definer boolean;
  authorizer_volatility "char";
  authorizer_config text[];
  authorizer_definition_md5 text;
begin
  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'Company CEO security contract requires PostgreSQL 17 or newer';
  end if;

  if to_regclass('public.flows') is null
    or to_regclass('public.agents') is null
    or to_regclass('public.runs') is null
    or to_regclass('public.companies') is null
    or to_regclass('public.company_ceo_messages') is null
    or to_regclass('public.agent_studio_runtime_secrets') is null
    or to_regnamespace('agent_studio_private') is null
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
    raise exception 'Company CEO messages policy drift';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type
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
    raise exception 'Company CEO messages ACL drift';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type
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
    raise exception 'Company CEO messages sequence ACL drift';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type
    ),
    '[]'::jsonb
  )
  into private_schema_acl
  from pg_namespace schemas
  cross join lateral aclexplode(
    coalesce(schemas.nspacl, acldefault('n', schemas.nspowner))
  ) privileges
  where schemas.nspname = 'agent_studio_private'
    and privileges.grantee <> schemas.nspowner;

  if not exists (
    select 1
    from pg_namespace schemas
    where schemas.nspname = 'agent_studio_private'
      and pg_get_userbyid(schemas.nspowner) = 'postgres'
  ) or private_schema_acl is distinct from '[
    ["anon", "USAGE", "postgres", false],
    ["service_role", "USAGE", "postgres", false]
  ]'::jsonb then
    raise exception 'Agent Studio private schema owner or ACL drift';
  end if;

  if to_regprocedure('agent_studio_private.request_authorized()') is null then
    raise exception 'Agent Studio shared-runtime authorization function is missing';
  end if;

  select
    pg_get_userbyid(functions.proowner),
    functions.prosecdef,
    functions.provolatile,
    functions.proconfig,
    md5(pg_get_functiondef(functions.oid))
  into
    authorizer_owner,
    authorizer_security_definer,
    authorizer_volatility,
    authorizer_config,
    authorizer_definition_md5
  from pg_proc functions
  where functions.oid =
    'agent_studio_private.request_authorized()'::regprocedure;

  if authorizer_owner is distinct from 'postgres'
    or authorizer_security_definer is distinct from true
    or authorizer_volatility is distinct from 's'::"char"
    or authorizer_config is distinct from
      array['search_path=pg_catalog, public, extensions']::text[]
    or authorizer_definition_md5 is distinct from
      'df7b8f2cecae6b0b0ad121f0801ae57c'
  then
    raise exception 'Agent Studio shared-runtime authorization function drift';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type
    ),
    '[]'::jsonb
  )
  into authorizer_acl
  from pg_proc functions
  cross join lateral aclexplode(
    coalesce(functions.proacl, acldefault('f', functions.proowner))
  ) privileges
  where functions.oid =
      'agent_studio_private.request_authorized()'::regprocedure
    and privileges.grantee <> functions.proowner;

  if authorizer_acl is distinct from '[
    ["anon", "EXECUTE", "postgres", false],
    ["service_role", "EXECUTE", "postgres", false]
  ]'::jsonb then
    raise exception 'Agent Studio shared-runtime authorization ACL drift';
  end if;

  if not exists (
    select 1
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'agent_studio_runtime_secrets'
      and tables.relkind = 'r'
      and pg_get_userbyid(tables.relowner) = 'postgres'
      and tables.relrowsecurity
      and not tables.relforcerowsecurity
  ) then
    raise exception 'Agent Studio shared-runtime marker owner or RLS drift';
  end if;

  if (
    select array_agg(
      array[
        columns.column_name::text,
        columns.udt_name::text,
        columns.is_nullable::text,
        coalesce(columns.column_default, '')::text
      ]
      order by columns.ordinal_position
    )
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'agent_studio_runtime_secrets'
  ) is distinct from array[
    array['id', 'text', 'NO', ''],
    array['secret_hash', 'text', 'NO', ''],
    array['schema_revision', 'text', 'NO', ''],
    array['updated_at', 'timestamptz', 'NO', 'now()']
  ]::text[][] then
    raise exception 'Agent Studio shared-runtime marker column drift';
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
    raise exception 'Agent Studio shared-runtime marker row drift';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_studio_runtime_secrets'
      and policyname = 'agent_studio_runtime_secrets_deny_all'
      and permissive = 'PERMISSIVE'
      and roles = array['anon']::name[]
      and cmd = 'ALL'
      and qual = 'false'
      and with_check = 'false'
  ) <> 1 or (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_studio_runtime_secrets'
  ) <> 1 then
    raise exception 'Agent Studio shared-runtime marker policy drift';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type,
        pg_get_userbyid(privileges.grantor),
        privileges.is_grantable
      )
      order by
        case
          when privileges.grantee = 0 then 'PUBLIC'
          else pg_get_userbyid(privileges.grantee)
        end,
        privileges.privilege_type
    ),
    '[]'::jsonb
  )
  into marker_acl
  from pg_class tables
  join pg_namespace schemas on schemas.oid = tables.relnamespace
  cross join lateral aclexplode(
    coalesce(tables.relacl, acldefault('r', tables.relowner))
  ) privileges
  where schemas.nspname = 'public'
    and tables.relname = 'agent_studio_runtime_secrets'
    and privileges.grantee <> tables.relowner;

  if marker_acl is distinct from '[
    ["service_role", "DELETE", "postgres", false],
    ["service_role", "INSERT", "postgres", false],
    ["service_role", "REFERENCES", "postgres", false],
    ["service_role", "SELECT", "postgres", false],
    ["service_role", "TRIGGER", "postgres", false],
    ["service_role", "TRUNCATE", "postgres", false],
    ["service_role", "UPDATE", "postgres", false]
  ]'::jsonb then
    raise exception 'Agent Studio shared-runtime marker ACL drift';
  end if;
end
$contract$;

commit;
