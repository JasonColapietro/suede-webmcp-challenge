-- REVIEWED PREPARED ARTIFACT ONLY. NOT APPLIED.
-- Resource Foundry durable storage and atomic workspace adoption extension.
-- Application code recomputes the canonical pack hash before every write and readback.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('suede-agent-studio:resource-foundry:v1', 0)
);

-- Resource RPCs deliberately reuse the production shared-runtime authorizer.
-- Refuse to create or alter any Resource object unless that trust boundary is
-- the exact reviewed function, owner, marker, and role grant set.
do $resource_authorization_preflight$
declare
  v_authorizer oid := pg_catalog.to_regprocedure(
    'agent_studio_private.request_authorized()'
  );
  v_authorizer_security_definer boolean;
  v_authorizer_volatility "char";
  v_authorizer_config text[];
  v_authorizer_definition_md5 text;
  v_authorizer_owner oid;
  v_secret_owner oid;
  v_secret_oid oid;
  v_secret_rls boolean;
begin
  if v_authorizer is null
    or pg_catalog.to_regclass('public.agent_studio_runtime_secrets') is null
    or pg_catalog.to_regprocedure('public.agent_studio_adopt_owner(text,text)') is null
    or pg_catalog.to_regclass('public.connections') is null
  then
    raise exception 'Resource authorization prerequisite drift: required objects'
      using errcode='42501';
  end if;

  select
    functions.prosecdef,
    functions.provolatile,
    functions.proconfig,
    pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid)),
    functions.proowner
  into strict
    v_authorizer_security_definer,
    v_authorizer_volatility,
    v_authorizer_config,
    v_authorizer_definition_md5,
    v_authorizer_owner
  from pg_catalog.pg_proc as functions
  where functions.oid=v_authorizer;

  select tables.oid,tables.relowner,tables.relrowsecurity
  into strict v_secret_oid,v_secret_owner,v_secret_rls
  from pg_catalog.pg_class as tables
  where tables.oid='public.agent_studio_runtime_secrets'::pg_catalog.regclass;

  if v_authorizer_security_definer is distinct from true
    or v_authorizer_volatility is distinct from 's'::"char"
    or v_authorizer_config is distinct from
      array['search_path=pg_catalog, public, extensions']::text[]
    or v_authorizer_definition_md5 is distinct from
      'df7b8f2cecae6b0b0ad121f0801ae57c'
    or v_authorizer_owner<>v_secret_owner
    or not v_secret_rls
    or v_authorizer_owner<>(
      select roles.oid
      from pg_catalog.pg_roles as roles
      where roles.rolname=current_user
    )
    or not pg_catalog.has_schema_privilege(
      'anon','agent_studio_private','usage'
    )
    or not pg_catalog.has_schema_privilege(
      'service_role','agent_studio_private','usage'
    )
    or pg_catalog.has_schema_privilege(
      'authenticated','agent_studio_private','usage'
    )
    or not pg_catalog.has_function_privilege(
      'anon',v_authorizer,'execute'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',v_authorizer,'execute'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',v_authorizer,'execute'
    )
    or pg_catalog.has_table_privilege(
      'anon','public.agent_studio_runtime_secrets','select'
    )
    or pg_catalog.has_table_privilege(
      'anon','public.agent_studio_runtime_secrets','insert'
    )
    or pg_catalog.has_table_privilege(
      'anon','public.agent_studio_runtime_secrets','update'
    )
    or pg_catalog.has_table_privilege(
      'anon','public.agent_studio_runtime_secrets','delete'
    )
    or pg_catalog.has_table_privilege(
      'authenticated','public.agent_studio_runtime_secrets','select'
    )
    or pg_catalog.has_table_privilege(
      'authenticated','public.agent_studio_runtime_secrets','insert'
    )
    or pg_catalog.has_table_privilege(
      'authenticated','public.agent_studio_runtime_secrets','update'
    )
    or pg_catalog.has_table_privilege(
      'authenticated','public.agent_studio_runtime_secrets','delete'
    )
    or not pg_catalog.has_table_privilege(
      'service_role','public.agent_studio_runtime_secrets','select'
    )
    or not pg_catalog.has_table_privilege(
      'service_role','public.agent_studio_runtime_secrets','insert'
    )
    or not pg_catalog.has_table_privilege(
      'service_role','public.agent_studio_runtime_secrets','update'
    )
    or not pg_catalog.has_table_privilege(
      'service_role','public.agent_studio_runtime_secrets','delete'
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.pg_policy as policies
      where policies.polrelid=v_secret_oid
    )<>1
    or not exists (
      select 1
      from pg_catalog.pg_policy as policies
      where policies.polrelid=v_secret_oid
        and policies.polname='agent_studio_runtime_secrets_deny_all'
        and policies.polpermissive
        and policies.polcmd='*'
        and policies.polroles=array[(
          select roles.oid
          from pg_catalog.pg_roles as roles
          where roles.rolname='anon'
        )]::oid[]
        and pg_catalog.pg_get_expr(policies.polqual,policies.polrelid)='false'
        and pg_catalog.pg_get_expr(policies.polwithcheck,policies.polrelid)='false'
    )
  then
    raise exception 'Resource authorization prerequisite drift: authorizer or ACL'
      using errcode='42501';
  end if;

  if (
    select pg_catalog.count(*)
    from public.agent_studio_runtime_secrets
  )<>1 or not exists (
    select 1
    from public.agent_studio_runtime_secrets
    where id='primary'
      and schema_revision='shared-runtime-v2'
      and secret_hash ~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Resource authorization prerequisite drift: runtime marker'
      using errcode='42501';
  end if;
end
$resource_authorization_preflight$;

-- Stripe may have installed the shared adoption wrapper first. When it has,
-- attest the exact reviewed helper and wrapper before the first Resource DDL.
-- Ownership and hardened settings alone cannot distinguish a no-op body.
do $resource_stripe_adoption_preflight$
declare
  v_stripe_helper oid := pg_catalog.to_regprocedure(
    'airbyte_source_private.agent_studio_adopt_stripe_owner(text,text)'
  );
  v_wrapper oid := pg_catalog.to_regprocedure(
    'public.agent_studio_adopt_owner_with_connections(text,text)'
  );
  v_wrapper_security_definer boolean;
  v_wrapper_config text[];
  v_wrapper_owner oid;
  v_wrapper_definition_md5 text;
  v_helper_security_definer boolean;
  v_helper_config text[];
  v_helper_owner oid;
  v_helper_definition_md5 text;
begin
  if v_stripe_helper is null then
    return;
  end if;
  if v_wrapper is null then
    raise exception 'Resource adoption found an unsafe Stripe owner wrapper'
      using errcode='42501';
  end if;

  select
    functions.prosecdef,
    functions.proconfig,
    functions.proowner,
    pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid))
  into strict
    v_wrapper_security_definer,
    v_wrapper_config,
    v_wrapper_owner,
    v_wrapper_definition_md5
  from pg_catalog.pg_proc as functions
  where functions.oid=v_wrapper;
  select
    functions.prosecdef,
    functions.proconfig,
    functions.proowner,
    pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid))
  into strict
    v_helper_security_definer,
    v_helper_config,
    v_helper_owner,
    v_helper_definition_md5
  from pg_catalog.pg_proc as functions
  where functions.oid=v_stripe_helper;

  if v_wrapper_security_definer is distinct from true
    or v_helper_security_definer is distinct from true
    or v_wrapper_config is distinct from array[
      'search_path=pg_catalog, pg_temp','row_security=off'
    ]::text[]
    or v_helper_config is distinct from array[
      'search_path=pg_catalog, pg_temp','row_security=off'
    ]::text[]
    or v_wrapper_owner<>v_helper_owner
    or v_wrapper_owner<>(
      select roles.oid
      from pg_catalog.pg_roles as roles
      where roles.rolname=current_user
    )
    or v_wrapper_definition_md5 is distinct from
      '7166de166f29fb2dc03177c0bc5e5ef2'
    or v_helper_definition_md5 is distinct from
      'f2382065902b17f90fcc5679ccac40dd'
  then
    raise exception 'Resource adoption found an unsafe Stripe owner wrapper'
      using errcode='42501';
  end if;
end
$resource_stripe_adoption_preflight$;

-- Keep one reviewed inventory for both the preflight and postflight. The
-- generated names below are PostgreSQL's stable names for these exact table
-- declarations; changing a name, type, validation state, or canonical
-- definition is drift, even when the replacement constraint is weaker but
-- still validated. This temporary catalog disappears at commit or rollback.
create temporary table pg_temp.agent_studio_resource_expected_constraints (
  table_name text not null,
  constraint_name text not null,
  constraint_type "char" not null,
  expected_definition text not null,
  primary key(table_name,constraint_name)
) on commit drop;

insert into pg_temp.agent_studio_resource_expected_constraints(
  table_name,constraint_name,constraint_type,expected_definition
) values
  ('resource_evidence_refs','resource_evidence_refs_confidence_check','c',
    $definition$CHECK (confidence IS NULL OR confidence >= 0::double precision AND confidence <= 1::double precision)$definition$),
  ('resource_evidence_refs','resource_evidence_refs_field_hash_check','c',
    $definition$CHECK (field_hash IS NULL OR field_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_evidence_refs','resource_evidence_refs_pack_version_id_fkey','f',
    $definition$FOREIGN KEY (pack_version_id) REFERENCES resource_pack_versions(id) ON DELETE CASCADE$definition$),
  ('resource_evidence_refs','resource_evidence_refs_pkey','p',
    $definition$PRIMARY KEY (pack_version_id, id)$definition$),
  ('resource_evidence_refs','resource_evidence_refs_source_snapshot_id_fkey','f',
    $definition$FOREIGN KEY (source_snapshot_id) REFERENCES resource_source_snapshots(id) ON DELETE RESTRICT$definition$),
  ('resource_pack_versions','resource_pack_versions_pkey','p',
    $definition$PRIMARY KEY (id)$definition$),
  ('resource_pack_versions','resource_pack_versions_resource_product_id_fkey','f',
    $definition$FOREIGN KEY (resource_product_id) REFERENCES resource_products(id) ON DELETE RESTRICT$definition$),
  ('resource_pack_versions','resource_pack_versions_resource_product_id_id_key','u',
    $definition$UNIQUE (resource_product_id, id)$definition$),
  ('resource_pack_versions','resource_pack_versions_resource_product_id_revision_key','u',
    $definition$UNIQUE (resource_product_id, revision)$definition$),
  ('resource_pack_versions','resource_pack_versions_revision_check','c',
    $definition$CHECK (revision > 0)$definition$),
  ('resource_pack_versions','resource_pack_versions_semantic_hash_check','c',
    $definition$CHECK (semantic_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_pack_versions','resource_pack_versions_status_check','c',
    $definition$CHECK (status = ANY (ARRAY['candidate'::text, 'approved'::text, 'live'::text, 'retired'::text]))$definition$),
  ('resource_products','resource_products_discovery_access_check','c',
    $definition$CHECK (discovery_access = ANY (ARRAY['public'::text, 'unlisted'::text]))$definition$),
  ('resource_products','resource_products_execution_access_check','c',
    $definition$CHECK (execution_access = ANY (ARRAY['free'::text, 'paid'::text, 'private'::text]))$definition$),
  ('resource_products','resource_products_owner_id_check','c',
    $definition$CHECK (octet_length(owner_id) >= 1 AND octet_length(owner_id) <= 128 AND owner_id = btrim(owner_id) AND owner_id !~ '[[:cntrl:]]'::text AND owner_id = NORMALIZE(owner_id, NFC))$definition$),
  ('resource_products','resource_products_owner_id_slug_key','u',
    $definition$UNIQUE (owner_id, slug)$definition$),
  ('resource_products','resource_products_pkey','p',
    $definition$PRIMARY KEY (id)$definition$),
  ('resource_products','resource_products_status_check','c',
    $definition$CHECK (status = ANY (ARRAY['draft'::text, 'test'::text, 'live'::text, 'paused'::text, 'retired'::text]))$definition$),
  ('resource_records','resource_records_pack_version_id_fkey','f',
    $definition$FOREIGN KEY (pack_version_id) REFERENCES resource_pack_versions(id) ON DELETE CASCADE$definition$),
  ('resource_records','resource_records_pkey','p',
    $definition$PRIMARY KEY (pack_version_id, id)$definition$),
  ('resource_releases','resource_releases_check','c',
    $definition$CHECK (execution_access = 'paid'::text OR price_usdc = 0::double precision)$definition$),
  ('resource_releases','resource_releases_deployment_id_key','u',
    $definition$UNIQUE (deployment_id)$definition$),
  ('resource_releases','resource_releases_discovery_access_check','c',
    $definition$CHECK (discovery_access = ANY (ARRAY['public'::text, 'unlisted'::text]))$definition$),
  ('resource_releases','resource_releases_execution_access_check','c',
    $definition$CHECK (execution_access = ANY (ARRAY['free'::text, 'paid'::text, 'private'::text]))$definition$),
  ('resource_releases','resource_releases_graph_full_hash_check','c',
    $definition$CHECK (graph_full_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_releases','resource_releases_graph_semantic_hash_check','c',
    $definition$CHECK (graph_semantic_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_releases','resource_releases_owner_id_check','c',
    $definition$CHECK (octet_length(owner_id) >= 1 AND octet_length(owner_id) <= 128 AND owner_id = btrim(owner_id) AND owner_id !~ '[[:cntrl:]]'::text AND owner_id = NORMALIZE(owner_id, NFC))$definition$),
  ('resource_releases','resource_releases_owner_id_resource_product_id_publication__key','u',
    $definition$UNIQUE (owner_id, resource_product_id, publication_key)$definition$),
  ('resource_releases','resource_releases_pack_version_id_fkey','f',
    $definition$FOREIGN KEY (pack_version_id) REFERENCES resource_pack_versions(id) ON DELETE RESTRICT$definition$),
  ('resource_releases','resource_releases_pkey','p',
    $definition$PRIMARY KEY (id)$definition$),
  ('resource_releases','resource_releases_price_usdc_check','c',
    $definition$CHECK (price_usdc >= 0::double precision)$definition$),
  ('resource_releases','resource_releases_publication_request_hash_check','c',
    $definition$CHECK (publication_request_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_releases','resource_releases_resource_product_id_fkey','f',
    $definition$FOREIGN KEY (resource_product_id) REFERENCES resource_products(id) ON DELETE RESTRICT$definition$),
  ('resource_releases','resource_releases_resource_product_id_pack_version_id_fkey','f',
    $definition$FOREIGN KEY (resource_product_id, pack_version_id) REFERENCES resource_pack_versions(resource_product_id, id) ON DELETE RESTRICT$definition$),
  ('resource_releases','resource_releases_semantic_hash_check','c',
    $definition$CHECK (semantic_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_run_receipts','resource_run_receipts_freshness_check','c',
    $definition$CHECK (freshness = ANY (ARRAY['fresh'::text, 'stale'::text, 'mixed'::text]))$definition$),
  ('resource_run_receipts','resource_run_receipts_owner_id_check','c',
    $definition$CHECK (octet_length(owner_id) >= 1 AND octet_length(owner_id) <= 128 AND owner_id = btrim(owner_id) AND owner_id !~ '[[:cntrl:]]'::text AND owner_id = NORMALIZE(owner_id, NFC))$definition$),
  ('resource_run_receipts','resource_run_receipts_pack_version_id_fkey','f',
    $definition$FOREIGN KEY (pack_version_id) REFERENCES resource_pack_versions(id) ON DELETE RESTRICT$definition$),
  ('resource_run_receipts','resource_run_receipts_payment_id_check','c',
    $definition$CHECK (payment_id IS NULL OR payment_id <> ''::text)$definition$),
  ('resource_run_receipts','resource_run_receipts_payment_state_check','c',
    $definition$CHECK (payment_state = ANY (ARRAY['free'::text, 'challenged'::text, 'credited'::text, 'settled'::text, 'refunded'::text, 'failed'::text]))$definition$),
  ('resource_run_receipts','resource_run_receipts_pkey','p',
    $definition$PRIMARY KEY (id)$definition$),
  ('resource_run_receipts','resource_run_receipts_price_usdc_check','c',
    $definition$CHECK (price_usdc >= 0::double precision)$definition$),
  ('resource_run_receipts','resource_run_receipts_resource_product_id_fkey','f',
    $definition$FOREIGN KEY (resource_product_id) REFERENCES resource_products(id) ON DELETE RESTRICT$definition$),
  ('resource_run_receipts','resource_run_receipts_resource_product_id_pack_version_id_fkey','f',
    $definition$FOREIGN KEY (resource_product_id, pack_version_id) REFERENCES resource_pack_versions(resource_product_id, id) ON DELETE RESTRICT$definition$),
  ('resource_run_receipts','resource_run_receipts_run_id_key','u',
    $definition$UNIQUE (run_id)$definition$),
  ('resource_run_receipts','resource_run_receipts_semantic_hash_check','c',
    $definition$CHECK (semantic_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_source_assets','resource_source_assets_pkey','p',
    $definition$PRIMARY KEY (id)$definition$),
  ('resource_source_assets','resource_source_assets_resource_product_id_fkey','f',
    $definition$FOREIGN KEY (resource_product_id) REFERENCES resource_products(id) ON DELETE RESTRICT$definition$),
  ('resource_source_assets','resource_source_assets_resource_product_id_locator_source_k_key','u',
    $definition$UNIQUE (resource_product_id, locator, source_kind)$definition$),
  ('resource_source_snapshots','resource_source_snapshots_content_hash_check','c',
    $definition$CHECK (content_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
  ('resource_source_snapshots','resource_source_snapshots_pkey','p',
    $definition$PRIMARY KEY (id)$definition$),
  ('resource_source_snapshots','resource_source_snapshots_provenance_check','c',
    $definition$CHECK (provenance IS NULL OR (provenance = ANY (ARRAY['mine'::text, 'licensed_or_permissioned'::text, 'public_source'::text, 'other_or_unspecified'::text])))$definition$),
  ('resource_source_snapshots','resource_source_snapshots_resource_product_id_fkey','f',
    $definition$FOREIGN KEY (resource_product_id) REFERENCES resource_products(id) ON DELETE RESTRICT$definition$),
  ('resource_source_snapshots','resource_source_snapshots_source_asset_id_fkey','f',
    $definition$FOREIGN KEY (source_asset_id) REFERENCES resource_source_assets(id) ON DELETE RESTRICT$definition$);

-- A blank install may omit this inventory. Existing installs may omit only the
-- ten reviewed additive parity checks converged below, plus the three Task 7
-- receipt checks when all four Task 7 payment columns are absent together.
-- Every existing constraint is still attested here, and postflight requires
-- all 54 after the guarded convergence and receipt upgrade.
do $resource_constraint_preflight$
declare
  v_existing_table_count integer;
  v_task_6_receipt_shape boolean;
  v_spec record;
  v_actual record;
begin
  select pg_catalog.count(*)
  into v_existing_table_count
  from (
    select distinct expected.table_name
    from pg_temp.agent_studio_resource_expected_constraints as expected
  ) as resource_tables
  where pg_catalog.to_regclass('public.'||resource_tables.table_name) is not null;

  if v_existing_table_count=0 then
    return;
  end if;
  if v_existing_table_count<>8 then
    raise exception 'Resource table inventory drift before migration'
      using errcode='42501';
  end if;

  select pg_catalog.count(*)=0
  into v_task_6_receipt_shape
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid='public.resource_run_receipts'::pg_catalog.regclass
    and attributes.attnum>0
    and not attributes.attisdropped
    and attributes.attname=any(array[
      'agent_id','payment_id','payment_state','price_usdc'
    ]::text[]);

  for v_spec in
    select *
    from pg_temp.agent_studio_resource_expected_constraints
    order by table_name,constraint_name
  loop
    select
      constraints.contype,
      constraints.convalidated,
      pg_catalog.pg_get_constraintdef(constraints.oid,true) as definition
    into v_actual
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid=pg_catalog.to_regclass('public.'||v_spec.table_name)
      and constraints.conname=v_spec.constraint_name;

    if not found and (
      (
        v_spec.table_name||'.'||v_spec.constraint_name
      )=any(array[
        'resource_products.resource_products_owner_id_check',
        'resource_evidence_refs.resource_evidence_refs_field_hash_check',
        'resource_evidence_refs.resource_evidence_refs_confidence_check',
        'resource_releases.resource_releases_owner_id_check',
        'resource_releases.resource_releases_semantic_hash_check',
        'resource_releases.resource_releases_publication_request_hash_check',
        'resource_releases.resource_releases_graph_semantic_hash_check',
        'resource_releases.resource_releases_graph_full_hash_check',
        'resource_run_receipts.resource_run_receipts_owner_id_check',
        'resource_run_receipts.resource_run_receipts_semantic_hash_check'
      ]::text[])
      or (
        v_task_6_receipt_shape
      and v_spec.table_name='resource_run_receipts'
      and v_spec.constraint_name=any(array[
        'resource_run_receipts_payment_id_check',
        'resource_run_receipts_payment_state_check',
        'resource_run_receipts_price_usdc_check'
      ]::text[])
      )
    )
    then
      continue;
    end if;
    if not found then
      raise exception 'Resource constraint missing on %.%',
        v_spec.table_name,v_spec.constraint_name
        using errcode='42501';
    end if;
    if v_actual.contype is distinct from v_spec.constraint_type
      or v_actual.convalidated is distinct from true
      or v_actual.definition is distinct from v_spec.expected_definition
    then
      raise exception 'Resource constraint definition drift on %.%',
        v_spec.table_name,v_spec.constraint_name
        using errcode='42501';
    end if;
  end loop;

  select
    tables.relname as table_name,
    constraints.conname as constraint_name
  into v_actual
  from pg_catalog.pg_constraint as constraints
  join pg_catalog.pg_class as tables
    on tables.oid=constraints.conrelid
  join pg_catalog.pg_namespace as schemas
    on schemas.oid=tables.relnamespace
  left join pg_temp.agent_studio_resource_expected_constraints as expected
    on expected.table_name=tables.relname
    and expected.constraint_name=constraints.conname
  where schemas.nspname='public'
    and tables.relname in (
      select distinct inventory.table_name
      from pg_temp.agent_studio_resource_expected_constraints as inventory
    )
    and expected.constraint_name is null
  order by tables.relname,constraints.conname
  limit 1;
  if found then
    raise exception 'Unexpected Resource constraint on %.%',
      v_actual.table_name,v_actual.constraint_name
      using errcode='42501';
  end if;
end
$resource_constraint_preflight$;

create table if not exists public.resource_products (
  id text primary key,
  owner_id text not null constraint resource_products_owner_id_check check (
    pg_catalog.octet_length(owner_id) between 1 and 128
    and owner_id=pg_catalog.btrim(owner_id)
    and owner_id !~ '[[:cntrl:]]'
    and owner_id=normalize(owner_id,NFC)
  ),
  name text not null,
  slug text not null,
  status text not null check (status in ('draft','test','live','paused','retired')),
  execution_access text not null check (execution_access in ('free','paid','private')),
  discovery_access text not null check (discovery_access in ('public','unlisted')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (owner_id, slug)
);
create index if not exists idx_resource_products_owner_status on public.resource_products(owner_id,status,updated_at desc,id desc);

create table if not exists public.resource_source_assets (
  id text primary key,
  resource_product_id text not null references public.resource_products(id) on delete restrict,
  locator text not null,
  source_kind text not null,
  created_at timestamptz not null,
  unique(resource_product_id,locator,source_kind)
);
create index if not exists idx_resource_source_assets_product on public.resource_source_assets(resource_product_id,created_at,id);

create table if not exists public.resource_source_snapshots (
  id text primary key,
  resource_product_id text not null references public.resource_products(id) on delete restrict,
  source_asset_id text not null references public.resource_source_assets(id) on delete restrict,
  locator text not null,
  source_kind text not null,
  captured_at timestamptz not null,
  source_published_at timestamptz,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  freshness_deadline timestamptz not null,
  provenance text check (provenance is null or provenance in ('mine','licensed_or_permissioned','public_source','other_or_unspecified')),
  provenance_note text,
  created_at timestamptz not null
);
create index if not exists idx_resource_source_snapshots_product on public.resource_source_snapshots(resource_product_id,captured_at desc,id desc);
create index if not exists idx_resource_source_snapshots_asset on public.resource_source_snapshots(source_asset_id,captured_at desc,id desc);

create table if not exists public.resource_pack_versions (
  id text primary key,
  resource_product_id text not null references public.resource_products(id) on delete restrict,
  revision integer not null check (revision > 0),
  status text not null check (status in ('candidate','approved','live','retired')),
  semantic_hash text not null check (semantic_hash ~ '^[a-f0-9]{64}$'),
  content_json jsonb not null,
  created_by text not null,
  created_at timestamptz not null,
  approved_by text,
  approved_at timestamptz,
  unique(resource_product_id,revision),
  unique(resource_product_id,id)
);
create unique index if not exists uq_resource_pack_candidate on public.resource_pack_versions(resource_product_id) where status='candidate';
create index if not exists idx_resource_pack_product_status on public.resource_pack_versions(resource_product_id,status,revision desc,id desc);

create table if not exists public.resource_records (
  pack_version_id text not null references public.resource_pack_versions(id) on delete cascade,
  id text not null,
  fields_json jsonb not null,
  tags_json jsonb not null,
  evidence_ids_json jsonb not null,
  unknowns_json jsonb,
  conflicts_json jsonb,
  primary key(pack_version_id,id)
);
create index if not exists idx_resource_records_pack on public.resource_records(pack_version_id,id);

create table if not exists public.resource_evidence_refs (
  pack_version_id text not null references public.resource_pack_versions(id) on delete cascade,
  id text not null,
  source_snapshot_id text not null references public.resource_source_snapshots(id) on delete restrict,
  locator text not null,
  observed_at timestamptz not null,
  field_hash text constraint resource_evidence_refs_field_hash_check check (
    field_hash is null or field_hash ~ '^[a-f0-9]{64}$'
  ),
  confidence double precision constraint resource_evidence_refs_confidence_check check (
    confidence is null or confidence between 0 and 1
  ),
  conflict text,
  primary key(pack_version_id,id)
);
create index if not exists idx_resource_evidence_pack on public.resource_evidence_refs(pack_version_id,id);
create index if not exists idx_resource_evidence_snapshot on public.resource_evidence_refs(source_snapshot_id,pack_version_id);

create table if not exists public.resource_releases (
  id text primary key,
  owner_id text not null constraint resource_releases_owner_id_check check (
    pg_catalog.octet_length(owner_id) between 1 and 128
    and owner_id=pg_catalog.btrim(owner_id)
    and owner_id !~ '[[:cntrl:]]'
    and owner_id=normalize(owner_id,NFC)
  ),
  resource_product_id text not null references public.resource_products(id) on delete restrict,
  pack_version_id text not null references public.resource_pack_versions(id) on delete restrict,
  semantic_hash text not null constraint resource_releases_semantic_hash_check check (
    semantic_hash ~ '^[a-f0-9]{64}$'
  ),
  publication_key text not null,
  publication_request_hash text not null constraint resource_releases_publication_request_hash_check check (
    publication_request_hash ~ '^[a-f0-9]{64}$'
  ),
  graph_semantic_hash text not null constraint resource_releases_graph_semantic_hash_check check (
    graph_semantic_hash ~ '^[a-f0-9]{64}$'
  ),
  graph_full_hash text not null constraint resource_releases_graph_full_hash_check check (
    graph_full_hash ~ '^[a-f0-9]{64}$'
  ),
  price_usdc double precision not null check (price_usdc>=0),
  execution_access text not null check (execution_access in ('free','paid','private')),
  discovery_access text not null check (discovery_access in ('public','unlisted')),
  agent_id text not null,
  flow_id text not null,
  flow_version_id text not null,
  deployment_id text not null unique,
  environment_id text not null,
  created_at timestamptz not null,
  check (execution_access='paid' or price_usdc=0),
  unique(owner_id,resource_product_id,publication_key),
  foreign key(resource_product_id,pack_version_id)
    references public.resource_pack_versions(resource_product_id,id) on delete restrict
);
create index if not exists idx_resource_releases_agent on public.resource_releases(agent_id,created_at desc,id desc);
create index if not exists idx_resource_releases_owner_product on public.resource_releases(owner_id,resource_product_id,created_at desc,id desc);
create unique index if not exists uq_resource_releases_publication on public.resource_releases(owner_id,resource_product_id,publication_key);

create table if not exists public.resource_run_receipts (
  id text primary key,
  owner_id text not null constraint resource_run_receipts_owner_id_check check (
    pg_catalog.octet_length(owner_id) between 1 and 128
    and owner_id=pg_catalog.btrim(owner_id)
    and owner_id !~ '[[:cntrl:]]'
    and owner_id=normalize(owner_id,NFC)
  ),
  resource_product_id text not null references public.resource_products(id) on delete restrict,
  pack_version_id text not null references public.resource_pack_versions(id) on delete restrict,
  agent_id text not null,
  run_id text not null unique,
  flow_version_id text not null,
  deployment_id text not null,
  payment_id text check (payment_id is null or payment_id<>''),
  payment_state text not null check (payment_state in ('free','challenged','credited','settled','refunded','failed')),
  price_usdc double precision not null check (price_usdc>=0),
  semantic_hash text not null constraint resource_run_receipts_semantic_hash_check check (
    semantic_hash ~ '^[a-f0-9]{64}$'
  ),
  freshness text not null check (freshness in ('fresh','stale','mixed')),
  evidence_json jsonb not null,
  unknowns_json jsonb not null,
  conflicts_json jsonb not null,
  output_schema_valid boolean not null,
  created_at timestamptz not null,
  foreign key(resource_product_id,pack_version_id)
    references public.resource_pack_versions(resource_product_id,id) on delete restrict
);

-- CREATE TABLE IF NOT EXISTS does not add checks to a database that already
-- received the deploy schema. Converge every deploy/migration parity check by
-- name, and make replay a no-op once the exact named post-state exists.
do $resource_constraint_convergence$
declare
  v_spec record;
  v_constraint_oid oid;
  v_constraint_validated boolean;
  v_constraint_type "char";
  v_constraint_definition text;
begin
  for v_spec in
    select * from (values
      ('resource_products','resource_products_owner_id_check',
        $check$pg_catalog.octet_length(owner_id) between 1 and 128 and owner_id=pg_catalog.btrim(owner_id) and owner_id !~ '[[:cntrl:]]' and owner_id=normalize(owner_id,NFC)$check$,
        $definition$CHECK (octet_length(owner_id) >= 1 AND octet_length(owner_id) <= 128 AND owner_id = btrim(owner_id) AND owner_id !~ '[[:cntrl:]]'::text AND owner_id = NORMALIZE(owner_id, NFC))$definition$),
      ('resource_evidence_refs','resource_evidence_refs_field_hash_check',
        $check$field_hash is null or field_hash ~ '^[a-f0-9]{64}$'$check$,
        $definition$CHECK (field_hash IS NULL OR field_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
      ('resource_evidence_refs','resource_evidence_refs_confidence_check',
        $check$confidence is null or confidence between 0 and 1$check$,
        $definition$CHECK (confidence IS NULL OR confidence >= 0::double precision AND confidence <= 1::double precision)$definition$),
      ('resource_releases','resource_releases_owner_id_check',
        $check$pg_catalog.octet_length(owner_id) between 1 and 128 and owner_id=pg_catalog.btrim(owner_id) and owner_id !~ '[[:cntrl:]]' and owner_id=normalize(owner_id,NFC)$check$,
        $definition$CHECK (octet_length(owner_id) >= 1 AND octet_length(owner_id) <= 128 AND owner_id = btrim(owner_id) AND owner_id !~ '[[:cntrl:]]'::text AND owner_id = NORMALIZE(owner_id, NFC))$definition$),
      ('resource_releases','resource_releases_semantic_hash_check',
        $check$semantic_hash ~ '^[a-f0-9]{64}$'$check$,
        $definition$CHECK (semantic_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
      ('resource_releases','resource_releases_publication_request_hash_check',
        $check$publication_request_hash ~ '^[a-f0-9]{64}$'$check$,
        $definition$CHECK (publication_request_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
      ('resource_releases','resource_releases_graph_semantic_hash_check',
        $check$graph_semantic_hash ~ '^[a-f0-9]{64}$'$check$,
        $definition$CHECK (graph_semantic_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
      ('resource_releases','resource_releases_graph_full_hash_check',
        $check$graph_full_hash ~ '^[a-f0-9]{64}$'$check$,
        $definition$CHECK (graph_full_hash ~ '^[a-f0-9]{64}$'::text)$definition$),
      ('resource_run_receipts','resource_run_receipts_owner_id_check',
        $check$pg_catalog.octet_length(owner_id) between 1 and 128 and owner_id=pg_catalog.btrim(owner_id) and owner_id !~ '[[:cntrl:]]' and owner_id=normalize(owner_id,NFC)$check$,
        $definition$CHECK (octet_length(owner_id) >= 1 AND octet_length(owner_id) <= 128 AND owner_id = btrim(owner_id) AND owner_id !~ '[[:cntrl:]]'::text AND owner_id = NORMALIZE(owner_id, NFC))$definition$),
      ('resource_run_receipts','resource_run_receipts_semantic_hash_check',
        $check$semantic_hash ~ '^[a-f0-9]{64}$'$check$,
        $definition$CHECK (semantic_hash ~ '^[a-f0-9]{64}$'::text)$definition$)
    ) as specs(
      table_name,
      constraint_name,
      expression,
      expected_definition
    )
  loop
    select
      constraints.oid,
      constraints.convalidated,
      constraints.contype,
      pg_catalog.pg_get_constraintdef(constraints.oid,true)
    into
      v_constraint_oid,
      v_constraint_validated,
      v_constraint_type,
      v_constraint_definition
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid=pg_catalog.to_regclass('public.'||v_spec.table_name)
      and constraints.conname=v_spec.constraint_name;

    if v_constraint_oid is not null and (
      v_constraint_type is distinct from 'c'::"char"
      or v_constraint_definition is distinct from v_spec.expected_definition
    ) then
      raise exception 'Resource constraint definition drift on %.%',
        v_spec.table_name,v_spec.constraint_name
        using errcode='42501';
    end if;

    if v_constraint_oid is null then
      execute pg_catalog.format(
        'alter table public.%I add constraint %I check (%s)',
        v_spec.table_name,v_spec.constraint_name,v_spec.expression
      );
    elsif not v_constraint_validated then
      execute pg_catalog.format(
        'alter table public.%I validate constraint %I',
        v_spec.table_name,v_spec.constraint_name
      );
    end if;

    select
      constraints.oid,
      constraints.convalidated,
      constraints.contype,
      pg_catalog.pg_get_constraintdef(constraints.oid,true)
    into strict
      v_constraint_oid,
      v_constraint_validated,
      v_constraint_type,
      v_constraint_definition
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid=pg_catalog.to_regclass('public.'||v_spec.table_name)
      and constraints.conname=v_spec.constraint_name;

    if v_constraint_type is distinct from 'c'::"char"
      or v_constraint_validated is distinct from true
      or v_constraint_definition is distinct from v_spec.expected_definition
    then
      raise exception 'Resource constraint convergence failed on %.%',
        v_spec.table_name,v_spec.constraint_name
        using errcode='42501';
    end if;
  end loop;
end
$resource_constraint_convergence$;

-- Task 7 upgrade path for databases that already applied the Task 4-6
-- prepared artifact. Drop the append-only trigger inside this transaction,
-- backfill only through one exact immutable release, then recreate it below.
drop trigger if exists resource_run_receipts_immutable on public.resource_run_receipts;
alter table public.resource_run_receipts add column if not exists agent_id text;
alter table public.resource_run_receipts add column if not exists payment_id text;
alter table public.resource_run_receipts add column if not exists payment_state text;
alter table public.resource_run_receipts add column if not exists price_usdc double precision;
do $resource_receipt_upgrade$
begin
  if to_regclass('public.settlements') is not null then
    execute $backfill$
      update public.resource_run_receipts receipt
      set agent_id=release.agent_id,
          payment_id=case when release.price_usdc=0 then null else (select settlement.tx from public.settlements settlement
            where settlement.run_id=receipt.run_id and settlement.owner_id=receipt.owner_id
              and settlement.agent_id=release.agent_id and settlement.gross_usdc=release.price_usdc) end,
          payment_state=case when release.price_usdc=0 then 'free' else 'settled' end,
          price_usdc=release.price_usdc
      from public.resource_releases release
      where (receipt.agent_id is null or receipt.payment_state is null or receipt.price_usdc is null)
        and release.owner_id=receipt.owner_id
        and release.resource_product_id=receipt.resource_product_id
        and release.pack_version_id=receipt.pack_version_id
        and release.flow_version_id=receipt.flow_version_id
        and release.deployment_id=receipt.deployment_id
        and (release.price_usdc=0 or exists(select 1 from public.settlements settlement
          where settlement.run_id=receipt.run_id and settlement.owner_id=receipt.owner_id
            and settlement.agent_id=release.agent_id and settlement.gross_usdc=release.price_usdc))
    $backfill$;
  else
    update public.resource_run_receipts receipt
    set agent_id=release.agent_id,payment_id=null,payment_state='free',price_usdc=0
    from public.resource_releases release
    where (receipt.agent_id is null or receipt.payment_state is null or receipt.price_usdc is null)
      and release.owner_id=receipt.owner_id
      and release.resource_product_id=receipt.resource_product_id
      and release.pack_version_id=receipt.pack_version_id
      and release.flow_version_id=receipt.flow_version_id
      and release.deployment_id=receipt.deployment_id
      and release.price_usdc=0;
  end if;
  if exists(
    select 1 from public.resource_run_receipts receipt
    left join public.resource_releases release
      on release.owner_id=receipt.owner_id
      and release.resource_product_id=receipt.resource_product_id
      and release.pack_version_id=receipt.pack_version_id
      and release.agent_id=receipt.agent_id
      and release.flow_version_id=receipt.flow_version_id
      and release.deployment_id=receipt.deployment_id
      and release.price_usdc=receipt.price_usdc
    where receipt.agent_id is null or receipt.payment_state is null or receipt.price_usdc is null
      or release.id is null
  ) then raise exception 'RESOURCE_CONFLICT'; end if;
  alter table public.resource_run_receipts alter column agent_id set not null;
  alter table public.resource_run_receipts alter column payment_state set not null;
  alter table public.resource_run_receipts alter column price_usdc set not null;
  if not exists(select 1 from pg_constraint where conrelid='public.resource_run_receipts'::regclass
    and conname='resource_run_receipts_payment_id_check') then
    alter table public.resource_run_receipts add constraint resource_run_receipts_payment_id_check
      check (payment_id is null or payment_id<>'');
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.resource_run_receipts'::regclass
    and conname='resource_run_receipts_payment_state_check') then
    alter table public.resource_run_receipts add constraint resource_run_receipts_payment_state_check
      check (payment_state in ('free','challenged','credited','settled','refunded','failed'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.resource_run_receipts'::regclass
    and conname='resource_run_receipts_price_usdc_check') then
    alter table public.resource_run_receipts add constraint resource_run_receipts_price_usdc_check
      check (price_usdc>=0);
  end if;
end $resource_receipt_upgrade$;
create index if not exists idx_resource_receipts_owner_product on public.resource_run_receipts(owner_id,resource_product_id,created_at desc,id desc);
create index if not exists idx_resource_receipts_pack on public.resource_run_receipts(pack_version_id,created_at desc,id desc);

create or replace function public.agent_studio_resource_immutable_guard()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then
    if tg_table_name='resource_source_snapshots' then raise exception 'Resource source snapshots are append-only'; end if;
    if tg_table_name in ('resource_records','resource_evidence_refs') then
      if exists(select 1 from public.resource_pack_versions where id=old.pack_version_id and status in ('approved','live','retired'))
        then raise exception 'Resource pack content is append-only'; end if;
    end if;
    if tg_table_name='resource_releases' then raise exception 'Resource releases are append-only'; end if;
    if tg_table_name='resource_run_receipts' then raise exception 'Resource run receipts are append-only'; end if;
    if tg_table_name='resource_pack_versions' then
      if old.status in ('approved','live','retired') then raise exception 'Resource pack versions are append-only'; end if;
    end if;
    return old;
  end if;
  if tg_table_name='resource_source_snapshots' then raise exception 'Resource source snapshots are append-only'; end if;
  if tg_table_name='resource_pack_versions' then
    if old.status in ('approved','live','retired') and
       ((old.status='approved' and new.status not in ('approved','live','retired')) or
        (old.status='live' and new.status not in ('live','retired')) or
        (old.status='retired' and new.status<>'retired') or
        (new.id,new.resource_product_id,new.revision,new.semantic_hash,new.content_json,new.created_by,new.created_at,new.approved_by,new.approved_at)
          is distinct from (old.id,old.resource_product_id,old.revision,old.semantic_hash,old.content_json,old.created_by,old.created_at,old.approved_by,old.approved_at))
       then raise exception 'Resource pack content is immutable'; end if;
  end if;
  if tg_table_name in ('resource_records','resource_evidence_refs') then
    if exists(select 1 from public.resource_pack_versions where id in (old.pack_version_id,new.pack_version_id) and status in ('approved','live','retired'))
      then raise exception 'Resource pack content is immutable'; end if;
  end if;
  if tg_table_name='resource_releases' and to_jsonb(new)-'owner_id' is distinct from to_jsonb(old)-'owner_id'
     then raise exception 'Resource releases are append-only'; end if;
  if tg_table_name='resource_run_receipts' and to_jsonb(new)-'owner_id' is distinct from to_jsonb(old)-'owner_id'
     then raise exception 'Resource run receipts are append-only'; end if;
  return new;
end; $$;

drop trigger if exists resource_source_snapshots_immutable on public.resource_source_snapshots;
create trigger resource_source_snapshots_immutable before update or delete on public.resource_source_snapshots for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_pack_versions_immutable on public.resource_pack_versions;
create trigger resource_pack_versions_immutable before update or delete on public.resource_pack_versions for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_records_immutable on public.resource_records;
create trigger resource_records_immutable before update or delete on public.resource_records for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_evidence_refs_immutable on public.resource_evidence_refs;
create trigger resource_evidence_refs_immutable before update or delete on public.resource_evidence_refs for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_releases_immutable on public.resource_releases;
create trigger resource_releases_immutable before update or delete on public.resource_releases for each row execute function public.agent_studio_resource_immutable_guard();
drop trigger if exists resource_run_receipts_immutable on public.resource_run_receipts;
create trigger resource_run_receipts_immutable before update or delete on public.resource_run_receipts for each row execute function public.agent_studio_resource_immutable_guard();

create or replace function public.agent_studio_resource_pack_json(p_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select to_jsonb(v) || jsonb_build_object('content',v.content_json) from public.resource_pack_versions v where v.id=p_id
$$;

create or replace function public.agent_studio_resource_create_product(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.resource_products; owner_id text:=p_input->>'ownerId';
begin
  if owner_id is null
    or pg_catalog.octet_length(owner_id) not between 1 and 128
    or owner_id<>pg_catalog.btrim(owner_id)
    or owner_id ~ '[[:cntrl:]]'
    or owner_id<>normalize(owner_id,NFC)
  then
    raise exception 'RESOURCE_INVALID' using errcode='22023';
  end if;
  insert into public.resource_products(id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
  values(coalesce(p_input->>'id',gen_random_uuid()::text),owner_id,p_input->>'name',p_input->>'slug','draft',p_input->>'executionAccess',p_input->>'discoveryAccess',clock_timestamp(),clock_timestamp()) returning * into r;
  return to_jsonb(r);
exception when unique_violation then raise exception 'RESOURCE_CONFLICT'; end; $$;

create or replace function public.agent_studio_resource_get_owned_product(p_owner_id text,p_resource_product_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select to_jsonb(p) from public.resource_products p where p.owner_id=p_owner_id and p.id=p_resource_product_id
$$;

create or replace function public.agent_studio_resource_get_owned_portfolio_item(p_owner_id text,p_resource_product_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select to_jsonb(p)||jsonb_build_object(
    'candidate_revision',(select max(v.revision) from public.resource_pack_versions v where v.resource_product_id=p.id and v.status='candidate'),
    'current_candidate',(select jsonb_build_object('packVersionId',v.id,'revision',v.revision,'semanticHash',v.semantic_hash) from public.resource_pack_versions v where v.resource_product_id=p.id and v.status='candidate' order by revision desc limit 1),
    'approved_pack_version_id',(select v.id from public.resource_pack_versions v where v.resource_product_id=p.id and v.status='approved' order by revision desc limit 1),
    'approved_pack',(select jsonb_build_object('packVersionId',v.id,'revision',v.revision,'semanticHash',v.semantic_hash) from public.resource_pack_versions v where v.resource_product_id=p.id and v.status='approved' order by revision desc limit 1),
    'live_pack_version_id',(select v.id from public.resource_pack_versions v where v.resource_product_id=p.id and v.status='live' order by revision desc limit 1),
    'live_pack',(select jsonb_build_object('packVersionId',v.id,'revision',v.revision,'semanticHash',v.semantic_hash) from public.resource_pack_versions v where v.resource_product_id=p.id and v.status='live' order by revision desc limit 1),
    'portfolio_freshness',(select case
      when jsonb_array_length(v.content_json->'sourceSnapshotIds')=0 then 'fresh'
      when exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
        where not exists(select 1 from public.resource_source_snapshots s where s.id=declared.id and s.resource_product_id=v.resource_product_id)) then 'invalid'
      when not exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
        join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
        where s.freshness_deadline<clock_timestamp()) then 'fresh'
      when not exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
        join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
        where s.freshness_deadline>=clock_timestamp()) then 'stale'
      else 'mixed' end from public.resource_pack_versions v where v.id=(
        select selected.id from public.resource_pack_versions selected
        where selected.resource_product_id=p.id and selected.status in ('candidate','approved','live')
        order by case when selected.status='candidate' then 0 else 1 end,selected.revision desc,
          case when selected.status='approved' then 0 else 1 end limit 1
      )),
    'portfolio_payments',jsonb_build_object(
      'attempted',null,
      'free',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='free'),
      'challenged',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='challenged'),
      'executed',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state in ('free','credited','settled','refunded')),
      'credited',jsonb_build_object('count',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='credited'),'amountUsdc',(select round(coalesce(sum(r.price_usdc),0)::numeric,6) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='credited')),
      'settled',jsonb_build_object('count',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='settled'),'amountUsdc',(select round(coalesce(sum(r.price_usdc),0)::numeric,6) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='settled')),
      'refunded',jsonb_build_object('count',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='refunded'),'amountUsdc',(select round(coalesce(sum(r.price_usdc),0)::numeric,6) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='refunded')),
      'failed',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id and r.payment_state='failed')
    ),
    'current_release',(select jsonb_build_object(
      'id',r.id,'resourceProductId',r.resource_product_id,
      'packVersionId',r.pack_version_id,'semanticHash',r.semantic_hash,
      'publicationKey',r.publication_key,'publicationRequestHash',r.publication_request_hash,
      'priceUsdc',r.price_usdc,'executionAccess',r.execution_access,
      'discoveryAccess',r.discovery_access,
      'freshness',(select case
        when jsonb_array_length(v.content_json->'sourceSnapshotIds')=0 then 'fresh'
        when exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
          where not exists(select 1 from public.resource_source_snapshots s where s.id=declared.id and s.resource_product_id=v.resource_product_id)) then 'invalid'
        when not exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
          join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
          where s.freshness_deadline<clock_timestamp()) then 'fresh'
        when not exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
          join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
          where s.freshness_deadline>=clock_timestamp()) then 'stale'
        else 'mixed' end from public.resource_pack_versions v
        where v.id=r.pack_version_id and v.resource_product_id=r.resource_product_id),
      'payoutReady',(r.execution_access<>'paid' or w.owner_id is not null),
      'settlementState',case when a.settlement_live then 'on' else 'off' end,
      'agentId',r.agent_id,'agentStatus',a.status,'flowVersionId',r.flow_version_id,
      'deploymentId',r.deployment_id,'deploymentStatus',d.status,
      'deploymentRetiredAt',d.retired_at,
      'createdAt',r.created_at,'urls',jsonb_build_object(
        'run','/api/agents/'||a.slug||'/run',
        'card','/api/agents/'||a.slug||'/.well-known/agent-card.json',
        'x402','/api/agents/'||a.slug||'/.well-known/x402',
        'a2a','/api/agents/'||a.slug||'/a2a','public','/a/'||a.slug)
      ) from public.resource_releases r left join public.agents a on a.id::text=r.agent_id
        left join public.deployments d on d.id::text=r.deployment_id
        left join public.wallets w on w.owner_id=p.owner_id
      where r.owner_id=p_owner_id and r.resource_product_id=p.id order by r.created_at desc,r.id desc limit 1),
    'release_count',(select count(*) from public.resource_releases r where r.resource_product_id=p.id),
    'run_receipt_count',(select count(*) from public.resource_run_receipts r where r.resource_product_id=p.id)
  ) from public.resource_products p
  where p.owner_id=p_owner_id and p.id=p_resource_product_id
$$;

create or replace function public.agent_studio_resource_list_owned_products(p_owner_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(public.agent_studio_resource_get_owned_portfolio_item(p_owner_id,p.id)
    order by p.updated_at desc,p.id desc),'[]'::jsonb)
  from (
    select id,updated_at from public.resource_products
    where owner_id=p_owner_id order by updated_at desc,id desc limit 100
  ) p
$$;

create or replace function public.agent_studio_resource_list_owned_releases(
  p_owner_id text,p_resource_product_id text,p_limit integer
)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  if p_limit is null or p_limit<1 or p_limit>50 then
    raise exception 'invalid release history limit' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(entry.receipt order by entry.created_at desc,entry.id desc),'[]'::jsonb)
  into result
  from (
    select r.id,r.created_at,jsonb_build_object(
      'id',r.id,'resourceProductId',r.resource_product_id,
      'packVersionId',r.pack_version_id,'semanticHash',r.semantic_hash,
      'publicationKey',r.publication_key,'publicationRequestHash',r.publication_request_hash,
      'priceUsdc',r.price_usdc,'executionAccess',r.execution_access,
      'discoveryAccess',r.discovery_access,
      'freshness',(select case
        when jsonb_array_length(v.content_json->'sourceSnapshotIds')=0 then 'fresh'
        when exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
          where not exists(select 1 from public.resource_source_snapshots s where s.id=declared.id and s.resource_product_id=v.resource_product_id)) then 'invalid'
        when not exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
          join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
          where s.freshness_deadline<clock_timestamp()) then 'fresh'
        when not exists(select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
          join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
          where s.freshness_deadline>=clock_timestamp()) then 'stale'
        else 'mixed' end from public.resource_pack_versions v
        where v.id=r.pack_version_id and v.resource_product_id=r.resource_product_id),
      'payoutReady',(r.execution_access<>'paid' or w.owner_id is not null),
      'settlementState',case when a.settlement_live then 'on' else 'off' end,
      'agentId',r.agent_id,'agentStatus',a.status,'flowVersionId',r.flow_version_id,
      'deploymentId',r.deployment_id,'deploymentStatus',d.status,
      'deploymentRetiredAt',d.retired_at,
      'createdAt',r.created_at,'urls',jsonb_build_object(
        'run','/api/agents/'||a.slug||'/run',
        'card','/api/agents/'||a.slug||'/.well-known/agent-card.json',
        'x402','/api/agents/'||a.slug||'/.well-known/x402',
        'a2a','/api/agents/'||a.slug||'/a2a','public','/a/'||a.slug)
    ) receipt
    from public.resource_releases r
    join public.resource_products p on p.id=r.resource_product_id
      and p.owner_id=r.owner_id
    left join public.agents a on a.id::text=r.agent_id
    left join public.deployments d on d.id::text=r.deployment_id
    left join public.wallets w on w.owner_id=r.owner_id
    where r.owner_id=p_owner_id and r.resource_product_id=p_resource_product_id
    order by r.created_at desc,r.id desc
    limit p_limit
  ) entry;
  return result;
end;
$$;

create or replace function public.agent_studio_resource_update_product(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.resource_products; next_status text:=coalesce(p_input->>'status',p_input->>'expectedStatus');
begin
  if p_input->>'expectedStatus'='retired' and
     (p_input ? 'name' or p_input ? 'slug' or p_input ? 'executionAccess' or p_input ? 'discoveryAccess')
     then raise exception 'RESOURCE_CONFLICT'; end if;
  if not ((p_input->>'expectedStatus'='draft' and next_status in ('draft','test','retired')) or (p_input->>'expectedStatus'='test' and next_status in ('test','retired')) or (p_input->>'expectedStatus'='live' and next_status='live') or (p_input->>'expectedStatus'='paused' and next_status='paused') or (p_input->>'expectedStatus'='retired' and next_status='retired')) then raise exception 'RESOURCE_CONFLICT'; end if;
  update public.resource_products set name=coalesce(p_input->>'name',name),slug=coalesce(p_input->>'slug',slug),status=next_status,
    execution_access=coalesce(p_input->>'executionAccess',execution_access),discovery_access=coalesce(p_input->>'discoveryAccess',discovery_access),updated_at=clock_timestamp()
  where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId' and status=p_input->>'expectedStatus' returning * into r;
  if not found then if exists(select 1 from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId') then raise exception 'RESOURCE_CONFLICT'; else raise exception 'RESOURCE_NOT_FOUND'; end if; end if;
  return to_jsonb(r);
end; $$;

create or replace function public.agent_studio_resource_create_product_with_candidate(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare product_row public.resource_products; next_pack_id text:=gen_random_uuid()::text; record jsonb; evidence jsonb; owner_id text:=p_input->>'ownerId';
begin
  if owner_id is null
    or pg_catalog.octet_length(owner_id) not between 1 and 128
    or owner_id<>pg_catalog.btrim(owner_id)
    or owner_id ~ '[[:cntrl:]]'
    or owner_id<>normalize(owner_id,NFC)
  then
    raise exception 'RESOURCE_INVALID' using errcode='22023';
  end if;
  insert into public.resource_products(id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
  values(coalesce(p_input->>'id',gen_random_uuid()::text),owner_id,p_input->>'name',p_input->>'slug','draft',p_input->>'executionAccess',p_input->>'discoveryAccess',clock_timestamp(),clock_timestamp()) returning * into product_row;
  insert into public.resource_pack_versions(id,resource_product_id,revision,status,semantic_hash,content_json,created_by,created_at)
  values(next_pack_id,product_row.id,1,'candidate',p_input->>'semanticHash',p_input->'content',p_input->>'createdBy',clock_timestamp());
  for record in select value from jsonb_array_elements(p_input->'content'->'records') loop
    insert into public.resource_records values(next_pack_id,record->>'id',record->'fields',record->'tags',record->'evidenceIds',record->'unknowns',record->'conflicts');
  end loop;
  for evidence in select value from jsonb_array_elements(p_input->'content'->'evidence') loop
    insert into public.resource_evidence_refs values(next_pack_id,evidence->>'id',evidence->>'sourceSnapshotId',evidence->>'locator',(evidence->>'observedAt')::timestamptz,evidence->>'fieldHash',nullif(evidence->>'confidence','')::double precision,evidence->>'conflict');
  end loop;
  return jsonb_build_object('product',to_jsonb(product_row),'candidate',public.agent_studio_resource_pack_json(next_pack_id));
exception when unique_violation then raise exception 'RESOURCE_CONFLICT'; end; $$;

create or replace function public.agent_studio_resource_create_source_snapshot(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare asset_id text:=coalesce(p_input->>'sourceAssetId',gen_random_uuid()::text); r public.resource_source_snapshots;
begin
  if not exists(select 1 from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId') then raise exception 'RESOURCE_NOT_FOUND'; end if;
  insert into public.resource_source_assets(id,resource_product_id,locator,source_kind,created_at) values(asset_id,p_input->>'resourceProductId',p_input->>'locator',p_input->>'sourceKind',clock_timestamp()) on conflict(resource_product_id,locator,source_kind) do nothing;
  select id into asset_id from public.resource_source_assets where resource_product_id=p_input->>'resourceProductId' and locator=p_input->>'locator' and source_kind=p_input->>'sourceKind';
  insert into public.resource_source_snapshots(id,resource_product_id,source_asset_id,locator,source_kind,captured_at,source_published_at,content_hash,freshness_deadline,provenance,provenance_note,created_at)
  values(coalesce(p_input->>'id',gen_random_uuid()::text),p_input->>'resourceProductId',asset_id,p_input->>'locator',p_input->>'sourceKind',(p_input->>'capturedAt')::timestamptz,nullif(p_input->>'sourcePublishedAt','')::timestamptz,p_input->>'contentHash',(p_input->>'freshnessDeadline')::timestamptz,p_input->>'provenance',p_input->>'provenanceNote',clock_timestamp()) returning * into r;
  return to_jsonb(r);
end; $$;

create or replace function public.agent_studio_resource_replace_candidate(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare current_id text; maximum integer; product_status text; next_id text:=gen_random_uuid()::text; record jsonb; evidence jsonb;
begin
  select status into product_status from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId' for update;
  if not found then raise exception 'RESOURCE_NOT_FOUND'; end if;
  if product_status='retired' then raise exception 'RESOURCE_CONFLICT'; end if;
  select id into current_id from public.resource_pack_versions where resource_product_id=p_input->>'resourceProductId' and status='candidate' for update;
  select coalesce(max(revision),0) into maximum from public.resource_pack_versions where resource_product_id=p_input->>'resourceProductId';
  if current_id is distinct from nullif(p_input->>'expectedCandidatePackVersionId','') or maximum<>(p_input->>'expectedRevision')::integer then raise exception 'RESOURCE_CONFLICT'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_input->'content'->'sourceSnapshotIds') s(id) where not exists(select 1 from public.resource_source_snapshots where resource_product_id=p_input->>'resourceProductId' and resource_source_snapshots.id=s.id)) then raise exception 'RESOURCE_CONFLICT'; end if;
  delete from public.resource_pack_versions where id=current_id and status='candidate';
  insert into public.resource_pack_versions(id,resource_product_id,revision,status,semantic_hash,content_json,created_by,created_at) values(next_id,p_input->>'resourceProductId',maximum+1,'candidate',p_input->>'semanticHash',p_input->'content',p_input->>'createdBy',clock_timestamp());
  for record in select value from jsonb_array_elements(p_input->'content'->'records') loop
    insert into public.resource_records values(next_id,record->>'id',record->'fields',record->'tags',record->'evidenceIds',record->'unknowns',record->'conflicts');
  end loop;
  for evidence in select value from jsonb_array_elements(p_input->'content'->'evidence') loop
    insert into public.resource_evidence_refs values(next_id,evidence->>'id',evidence->>'sourceSnapshotId',evidence->>'locator',(evidence->>'observedAt')::timestamptz,evidence->>'fieldHash',nullif(evidence->>'confidence','')::double precision,evidence->>'conflict');
  end loop;
  return public.agent_studio_resource_pack_json(next_id);
end; $$;

create or replace function public.agent_studio_resource_collect_source_candidate(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb; candidate jsonb;
begin
  if nullif(p_input->'snapshot'->>'ownerId','') is null or
     nullif(p_input->'snapshot'->>'resourceProductId','') is null or
     p_input->'snapshot'->>'ownerId' is distinct from p_input->'candidate'->>'ownerId' or
     p_input->'snapshot'->>'resourceProductId' is distinct from p_input->'candidate'->>'resourceProductId'
     then raise exception 'RESOURCE_CONFLICT'; end if;
  snapshot:=public.agent_studio_resource_create_source_snapshot(p_input->'snapshot');
  candidate:=public.agent_studio_resource_replace_candidate(p_input->'candidate');
  return jsonb_build_object('snapshot',snapshot,'candidate',candidate);
end; $$;

create or replace function public.agent_studio_resource_approve_candidate(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  perform 1 from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId' and status<>'retired' for update;
  if not found then
    if exists(select 1 from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId') then raise exception 'RESOURCE_CONFLICT'; else raise exception 'RESOURCE_NOT_FOUND'; end if;
  end if;
  update public.resource_pack_versions set status='approved',approved_by=p_input->>'approvedBy',approved_at=clock_timestamp()
  where id=p_input->>'candidatePackVersionId' and resource_product_id=p_input->>'resourceProductId' and status='candidate' and revision=(p_input->>'expectedRevision')::integer and semantic_hash=p_input->>'expectedSemanticHash';
  if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  update public.resource_products set status='test',updated_at=clock_timestamp() where id=p_input->>'resourceProductId' and status='draft';
  return public.agent_studio_resource_pack_json(p_input->>'candidatePackVersionId');
end; $$;

create or replace function public.agent_studio_resource_reject_candidate(p_input jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare deleted_count integer;
begin
  perform 1 from public.resource_products
    where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId' and status<>'retired'
    for update;
  if not found then
    if exists(select 1 from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId')
      then raise exception 'RESOURCE_CONFLICT'; else raise exception 'RESOURCE_NOT_FOUND'; end if;
  end if;
  delete from public.resource_pack_versions
    where id=p_input->>'candidatePackVersionId'
      and resource_product_id=p_input->>'resourceProductId'
      and status='candidate'
      and revision=(p_input->>'expectedRevision')::integer
      and semantic_hash=p_input->>'expectedSemanticHash';
  get diagnostics deleted_count = row_count;
  if deleted_count<>1 then raise exception 'RESOURCE_CONFLICT'; end if;
end; $$;

create or replace function public.agent_studio_resource_get_owned_pack(p_reference jsonb)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select public.agent_studio_resource_pack_json(v.id)||jsonb_build_object('freshness',case
    when jsonb_array_length(v.content_json->'sourceSnapshotIds')=0 then 'fresh'
    when exists(
      select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
      where not exists(select 1 from public.resource_source_snapshots s where s.id=declared.id and s.resource_product_id=v.resource_product_id)
    ) then null
    when not exists(
      select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
      join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
      where s.freshness_deadline<clock_timestamp()
    ) then 'fresh'
    when not exists(
      select 1 from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
      join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
      where s.freshness_deadline>=clock_timestamp()
    ) then 'stale' else 'mixed' end)
  from public.resource_products p join public.resource_pack_versions v on v.resource_product_id=p.id
  where p.owner_id=p_reference->>'ownerId' and p.id=p_reference->>'resourceProductId' and v.id=p_reference->>'packVersionId' and v.semantic_hash=p_reference->>'semanticHash'
$$;

create or replace function public.agent_studio_resource_get_owned_approved_pack(p_owner_id text,p_resource_product_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select public.agent_studio_resource_get_owned_pack(jsonb_build_object(
    'ownerId',p_owner_id,
    'resourceProductId',p_resource_product_id,
    'packVersionId',v.id,
    'semanticHash',v.semantic_hash
  ))
  from public.resource_products p
  join public.resource_pack_versions v on v.resource_product_id=p.id
  where p.owner_id=p_owner_id and p.id=p_resource_product_id and v.status='approved'
  order by v.revision desc,v.id desc limit 1
$$;

create or replace function public.agent_studio_resource_get_source_disclosure(p_reference jsonb)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select jsonb_build_object(
    'source_count',jsonb_array_length(v.content_json->'sourceSnapshotIds'),
    'source_kinds',coalesce((
      select jsonb_agg(kind order by kind) from (
        select distinct s.source_kind kind
        from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
        join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
      ) kinds
    ),'[]'::jsonb)
  )
  from public.resource_products p join public.resource_pack_versions v on v.resource_product_id=p.id
  where p.owner_id=p_reference->>'ownerId' and p.id=p_reference->>'resourceProductId'
    and v.id=p_reference->>'packVersionId' and v.semantic_hash=p_reference->>'semanticHash'
    and jsonb_array_length(v.content_json->'sourceSnapshotIds')=(
      select count(*) from jsonb_array_elements_text(v.content_json->'sourceSnapshotIds') declared(id)
      join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=v.resource_product_id
    )
$$;

create or replace function public.agent_studio_resource_create_release(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.resource_releases;
begin
  perform pg_advisory_xact_lock(hashtextextended('resource-release:'||coalesce(p_input->>'ownerId','')||':'||coalesce(p_input->>'resourceProductId','')||':'||coalesce(p_input->>'publicationKey','')||':'||coalesce(p_input->>'deploymentId',''),0));
  if exists(select 1 from public.resource_releases by_deployment join public.resource_releases by_publication
    on by_publication.owner_id=p_input->>'ownerId' and by_publication.resource_product_id=p_input->>'resourceProductId'
      and by_publication.publication_key=p_input->>'publicationKey'
    where by_deployment.deployment_id=p_input->>'deploymentId' and by_deployment.id<>by_publication.id)
  then raise exception 'RESOURCE_CONFLICT'; end if;
  select * into r from public.resource_releases where deployment_id=p_input->>'deploymentId'
    or (owner_id=p_input->>'ownerId' and resource_product_id=p_input->>'resourceProductId' and publication_key=p_input->>'publicationKey')
    order by (publication_key=p_input->>'publicationKey') desc limit 1;
  if found then
    if to_jsonb(r)-'id'-'created_at' is distinct from jsonb_build_object(
      'owner_id',p_input->>'ownerId','resource_product_id',p_input->>'resourceProductId',
      'pack_version_id',p_input->>'packVersionId','semantic_hash',p_input->>'semanticHash',
      'publication_key',p_input->>'publicationKey','publication_request_hash',p_input->>'publicationRequestHash',
      'graph_semantic_hash',p_input->>'graphSemanticHash','graph_full_hash',p_input->>'graphFullHash',
      'price_usdc',(p_input->>'priceUsdc')::double precision,'execution_access',p_input->>'executionAccess',
      'discovery_access',p_input->>'discoveryAccess','agent_id',p_input->>'agentId',
      'flow_id',p_input->>'flowId','flow_version_id',p_input->>'flowVersionId',
      'deployment_id',p_input->>'deploymentId','environment_id',p_input->>'environmentId')
    then raise exception 'RESOURCE_CONFLICT'; end if;
    if not exists(
      select 1 from public.agents a
      join public.flows f on f.id=a.flow_id
      join public.flow_versions fv on fv.id::text=p_input->>'flowVersionId' and fv.flow_id=f.id
        and fv.semantic_hash=p_input->>'graphSemanticHash' and fv.full_hash=p_input->>'graphFullHash'
      join public.deployments d on d.id::text=p_input->>'deploymentId' and d.flow_id=f.id and d.flow_version_id=fv.id
      join public.environments e on e.id=d.environment_id
      join public.resource_products p on p.id=p_input->>'resourceProductId'
      join public.resource_pack_versions rp on rp.id=p_input->>'packVersionId' and rp.resource_product_id=p.id
      where a.id::text=p_input->>'agentId' and f.id::text=p_input->>'flowId'
        and a.status='live' and a.settlement_live=false and a.price_usdc=(p_input->>'priceUsdc')::double precision and f.owner_id=p_input->>'ownerId'
        and d.environment_id::text=p_input->>'environmentId' and d.status='live' and d.retired_at is null
        and e.kind='live' and p.owner_id=p_input->>'ownerId' and p.status='live'
        and p.execution_access=p_input->>'executionAccess' and p.discovery_access=p_input->>'discoveryAccess'
        and rp.status='live' and rp.semantic_hash=p_input->>'semanticHash'
        and exists(select 1 from public.dependency_pins dp where dp.flow_version_id=fv.id
          and dp.kind='resource' and dp.resource_id=p.id and dp.version=rp.id
          and dp.content_hash=rp.semantic_hash)
    ) then raise exception 'RESOURCE_CONFLICT'; end if;
    return to_jsonb(r);
  end if;
  if p_input->>'executionAccess' not in ('free','paid','private') or
     p_input->>'discoveryAccess' not in ('public','unlisted') or
     (p_input->>'priceUsdc')::double precision<0 or
     (p_input->>'executionAccess'<>'paid' and (p_input->>'priceUsdc')::double precision<>0)
  then raise exception 'RESOURCE_CONFLICT'; end if;
  perform 1 from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId' and status<>'retired'
    and execution_access=p_input->>'executionAccess' and discovery_access=p_input->>'discoveryAccess' for update;
  if not found or not exists(select 1 from public.resource_pack_versions where id=p_input->>'packVersionId' and resource_product_id=p_input->>'resourceProductId' and semantic_hash=p_input->>'semanticHash' and status='approved') then raise exception 'RESOURCE_CONFLICT'; end if;
  if exists(
    select 1 from public.resource_pack_versions rp
    cross join lateral jsonb_array_elements_text(rp.content_json->'sourceSnapshotIds') declared(id)
    left join public.resource_source_snapshots s on s.id=declared.id and s.resource_product_id=rp.resource_product_id
    where rp.id=p_input->>'packVersionId' and (s.id is null or s.freshness_deadline<clock_timestamp())
  ) then raise exception 'RESOURCE_CONFLICT'; end if;
  if not exists(
    select 1 from public.agents a
    join public.flows f on f.id=a.flow_id
    join public.flow_versions fv on fv.id::text=p_input->>'flowVersionId' and fv.flow_id=f.id and fv.created_by=p_input->>'ownerId'
      and fv.semantic_hash=p_input->>'graphSemanticHash' and fv.full_hash=p_input->>'graphFullHash'
    join public.deployments d on d.id::text=p_input->>'deploymentId' and d.flow_id=f.id and d.flow_version_id=fv.id
    join public.environments e on e.id=d.environment_id
    where a.id::text=p_input->>'agentId' and a.flow_id::text=p_input->>'flowId'
      and a.status='draft' and a.settlement_live=false and a.price_usdc=(p_input->>'priceUsdc')::double precision
      and f.id::text=p_input->>'flowId' and f.owner_id=p_input->>'ownerId'
      and d.environment_id::text=p_input->>'environmentId' and d.status='live' and d.retired_at is null and e.kind='live'
  ) or not exists(
    select 1 from public.dependency_pins dp
    where dp.flow_version_id::text=p_input->>'flowVersionId' and dp.kind='resource'
      and dp.resource_id=p_input->>'resourceProductId' and dp.version=p_input->>'packVersionId'
      and dp.content_hash=p_input->>'semanticHash'
  ) then raise exception 'RESOURCE_CONFLICT'; end if;
  insert into public.resource_releases(
    id,owner_id,resource_product_id,pack_version_id,semantic_hash,publication_key,
    publication_request_hash,graph_semantic_hash,graph_full_hash,price_usdc,
    execution_access,discovery_access,agent_id,flow_id,flow_version_id,deployment_id,
    environment_id,created_at)
  values(coalesce(p_input->>'id',gen_random_uuid()::text),p_input->>'ownerId',p_input->>'resourceProductId',
    p_input->>'packVersionId',p_input->>'semanticHash',p_input->>'publicationKey',p_input->>'publicationRequestHash',
    p_input->>'graphSemanticHash',p_input->>'graphFullHash',(p_input->>'priceUsdc')::double precision,
    p_input->>'executionAccess',p_input->>'discoveryAccess',p_input->>'agentId',p_input->>'flowId',
    p_input->>'flowVersionId',p_input->>'deploymentId',p_input->>'environmentId',
    coalesce((p_input->>'createdAt')::timestamptz,clock_timestamp())) returning * into r;
  update public.resource_pack_versions set status='live' where id=p_input->>'packVersionId'
    and resource_product_id=p_input->>'resourceProductId' and semantic_hash=p_input->>'semanticHash' and status='approved';
  if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  update public.resource_products set status='live',updated_at=clock_timestamp() where id=p_input->>'resourceProductId'
    and owner_id=p_input->>'ownerId' and execution_access=p_input->>'executionAccess'
    and discovery_access=p_input->>'discoveryAccess' and status in ('draft','test','paused','live');
  if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  update public.agents set status='live' where id::text=p_input->>'agentId' and flow_id::text=p_input->>'flowId'
    and status='draft' and settlement_live=false and price_usdc=(p_input->>'priceUsdc')::double precision;
  if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  return to_jsonb(r);
end; $$;

create or replace function public.agent_studio_resource_transition_release_lifecycle(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  action text:=p_input->>'action';
  expected_status text:=p_input->>'expectedStatus';
  release_row public.resource_releases;
  product_row public.resource_products;
begin
  if action not in ('pause','resume','retire')
    or expected_status not in ('live','paused')
    or (action='pause' and expected_status<>'live')
    or (action='resume' and expected_status<>'paused')
    or coalesce(p_input->>'ownerId','')=''
    or coalesce(p_input->>'resourceProductId','')=''
    or coalesce(p_input->>'releaseId','')=''
    or coalesce(p_input->>'agentId','')=''
    or coalesce(p_input->>'deploymentId','')=''
  then raise exception 'RESOURCE_CONFLICT'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'resource-lifecycle:'||coalesce(p_input->>'ownerId','')||':'||
      coalesce(p_input->>'resourceProductId',''),0
  ));
  select * into product_row
  from public.resource_products product
  where product.id=p_input->>'resourceProductId'
    and product.owner_id=p_input->>'ownerId'
  for update;
  if not found then raise exception 'RESOURCE_NOT_FOUND'; end if;
  if product_row.status<>expected_status then raise exception 'RESOURCE_CONFLICT'; end if;

  select release.* into release_row
  from public.resource_releases release
  join public.resource_pack_versions pack
    on pack.id=release.pack_version_id
    and pack.resource_product_id=release.resource_product_id
  join public.flows flow
    on flow.id::text=release.flow_id and flow.owner_id=release.owner_id
  join public.agents agent
    on agent.id::text=release.agent_id and agent.flow_id=flow.id
  join public.deployments deployment
    on deployment.id::text=release.deployment_id
    and deployment.flow_id=flow.id
    and deployment.flow_version_id::text=release.flow_version_id
    and deployment.environment_id::text=release.environment_id
  where release.id=p_input->>'releaseId'
    and release.owner_id=p_input->>'ownerId'
    and release.resource_product_id=p_input->>'resourceProductId'
    and release.agent_id=p_input->>'agentId'
    and release.deployment_id=p_input->>'deploymentId'
    and release.id=(
      select current.id from public.resource_releases current
      where current.owner_id=p_input->>'ownerId'
        and current.resource_product_id=p_input->>'resourceProductId'
      order by current.created_at desc,current.id desc limit 1
    )
    and pack.status='live'
    and agent.status=case when expected_status='live' then 'live' else 'draft' end
    and deployment.status=case when expected_status='live' then 'live' else 'retired' end
    and ((expected_status='live' and deployment.retired_at is null)
      or (expected_status='paused' and deployment.retired_at is not null))
  for update of release,pack,agent,deployment;
  if not found then raise exception 'RESOURCE_CONFLICT'; end if;

  if action='resume' and exists(
    select 1 from public.deployments competing
    where competing.flow_id::text=release_row.flow_id
      and competing.environment_id::text=release_row.environment_id
      and competing.id::text<>release_row.deployment_id
      and competing.retired_at is null
  ) then raise exception 'RESOURCE_CONFLICT'; end if;

  if expected_status='live' then
    update public.deployments set status='retired',retired_at=clock_timestamp()
    where id::text=release_row.deployment_id
      and flow_id::text=release_row.flow_id
      and flow_version_id::text=release_row.flow_version_id
      and environment_id::text=release_row.environment_id
      and status='live' and retired_at is null;
    if not found then raise exception 'RESOURCE_CONFLICT'; end if;
    update public.agents set status='draft'
    where id::text=release_row.agent_id and flow_id::text=release_row.flow_id
      and status='live';
    if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  elsif action='resume' then
    update public.deployments set status='live',retired_at=null
    where id::text=release_row.deployment_id
      and flow_id::text=release_row.flow_id
      and flow_version_id::text=release_row.flow_version_id
      and environment_id::text=release_row.environment_id
      and status='retired' and retired_at is not null;
    if not found then raise exception 'RESOURCE_CONFLICT'; end if;
    update public.agents set status='live'
    where id::text=release_row.agent_id and flow_id::text=release_row.flow_id
      and status='draft';
    if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  end if;

  if action='retire' then
    update public.resource_pack_versions set status='retired'
    where id=release_row.pack_version_id
      and resource_product_id=release_row.resource_product_id
      and semantic_hash=release_row.semantic_hash and status='live';
    if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  end if;

  update public.resource_products
  set status=case action when 'pause' then 'paused' when 'resume' then 'live' else 'retired' end,
    updated_at=clock_timestamp()
  where id=release_row.resource_product_id and owner_id=release_row.owner_id
    and status=expected_status
  returning * into product_row;
  if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  return jsonb_build_object('product',to_jsonb(product_row),'release',to_jsonb(release_row));
exception when unique_violation then raise exception 'RESOURCE_CONFLICT';
end; $$;

create or replace function public.agent_studio_resource_get_release_by_agent(p_agent_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select to_jsonb(r) from public.resource_releases r
  join public.resource_products p
    on p.id=r.resource_product_id and p.owner_id=r.owner_id and p.status='live'
  join public.resource_pack_versions pack
    on pack.id=r.pack_version_id and pack.resource_product_id=r.resource_product_id and pack.status='live'
  join public.flows f on f.id::text=r.flow_id and f.owner_id=r.owner_id
  join public.agents a on a.id::text=r.agent_id and a.flow_id=f.id and a.status='live'
  join public.deployments d
    on d.id::text=r.deployment_id and d.flow_id=f.id
    and d.flow_version_id::text=r.flow_version_id
    and d.environment_id::text=r.environment_id
    and d.status='live' and d.retired_at is null
  where r.agent_id=p_agent_id order by r.created_at desc,r.id desc limit 1
$$;

create or replace function public.agent_studio_resource_list_releases_by_agents(p_agent_ids text[])
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(to_jsonb(latest) order by latest.agent_id),'[]'::jsonb)
  from (
    select distinct on (r.agent_id) r.*
    from public.resource_releases r
    join public.resource_products p
      on p.id=r.resource_product_id and p.owner_id=r.owner_id and p.status='live'
    join public.resource_pack_versions pack
      on pack.id=r.pack_version_id and pack.resource_product_id=r.resource_product_id and pack.status='live'
    join public.flows f on f.id::text=r.flow_id and f.owner_id=r.owner_id
    join public.agents a on a.id::text=r.agent_id and a.flow_id=f.id and a.status='live'
    join public.deployments d
      on d.id::text=r.deployment_id and d.flow_id=f.id
      and d.flow_version_id::text=r.flow_version_id
      and d.environment_id::text=r.environment_id
      and d.status='live' and d.retired_at is null
    where r.agent_id=any(p_agent_ids)
    order by r.agent_id,r.created_at desc,r.id desc
  ) latest
$$;

create or replace function public.agent_studio_resource_get_release_by_publication(p_owner_id text,p_resource_product_id text,p_publication_key text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select to_jsonb(r) from public.resource_releases r
  join public.resource_products p on p.id=r.resource_product_id and p.owner_id=p_owner_id
  where r.owner_id=p_owner_id and r.resource_product_id=p_resource_product_id and r.publication_key=p_publication_key
  order by r.created_at desc,r.id desc limit 1
$$;

create or replace function public.agent_studio_resource_record_run_receipt(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.resource_run_receipts; receipt jsonb:=p_input->'receipt';
begin
  perform pg_advisory_xact_lock(hashtextextended('resource-receipt:'||coalesce(p_input->>'runId',''),0));
  if jsonb_typeof(receipt->'evidence') is distinct from 'array'
    or exists(
      select 1 from jsonb_array_elements(receipt->'evidence') presented
      where not exists(
        select 1
        from public.resource_pack_versions v
        cross join lateral jsonb_array_elements(v.content_json->'evidence') approved
        join public.resource_evidence_refs evidence_ref
          on evidence_ref.pack_version_id=v.id
          and evidence_ref.id=approved->>'id'
          and evidence_ref.source_snapshot_id=approved->>'sourceSnapshotId'
          and evidence_ref.locator=approved->>'locator'
          and evidence_ref.observed_at=(approved->>'observedAt')::timestamptz
          and evidence_ref.field_hash is not distinct from approved->>'fieldHash'
          and to_jsonb(evidence_ref.confidence) is not distinct from approved->'confidence'
          and evidence_ref.conflict is not distinct from approved->>'conflict'
        where v.id=p_input->>'packVersionId'
          and v.resource_product_id=p_input->>'resourceProductId'
          and v.semantic_hash=receipt->>'semanticHash'
          and v.status in ('approved','live')
          and approved=presented
      )
    )
  then raise exception 'RESOURCE_CONFLICT'; end if;
  select * into r from public.resource_run_receipts where run_id=p_input->>'runId';
  if found then
    if to_jsonb(r)-'id'-'created_at' is distinct from jsonb_build_object('owner_id',p_input->>'ownerId','resource_product_id',p_input->>'resourceProductId','pack_version_id',p_input->>'packVersionId','agent_id',p_input->>'agentId','run_id',p_input->>'runId','flow_version_id',p_input->>'flowVersionId','deployment_id',p_input->>'deploymentId','payment_id',p_input->>'paymentId','payment_state',p_input->>'paymentState','price_usdc',(p_input->>'priceUsdc')::double precision,'semantic_hash',receipt->>'semanticHash','freshness',receipt->>'freshness','evidence_json',receipt->'evidence','unknowns_json',receipt->'unknowns','conflicts_json',receipt->'conflicts','output_schema_valid',(receipt->>'outputSchemaValid')::boolean) then raise exception 'RESOURCE_CONFLICT'; end if;
    return to_jsonb(r)||jsonb_build_object('evidence',r.evidence_json,'unknowns',r.unknowns_json,'conflicts',r.conflicts_json);
  end if;
  if receipt->>'resourceProductId'<>p_input->>'resourceProductId' or receipt->>'resourceVersion'<>p_input->>'packVersionId'
    or p_input->>'paymentState' not in ('free','challenged','credited','settled','refunded','failed')
    or (p_input->>'paymentId' is not null and p_input->>'paymentId'='')
    or (p_input->>'priceUsdc')::double precision<0
    or not exists(select 1 from public.resource_products where id=p_input->>'resourceProductId' and owner_id=p_input->>'ownerId')
    or not exists(select 1 from public.resource_pack_versions where id=p_input->>'packVersionId' and resource_product_id=p_input->>'resourceProductId' and semantic_hash=receipt->>'semanticHash' and status in ('approved','live'))
    or not exists(select 1 from public.resource_releases where owner_id=p_input->>'ownerId' and resource_product_id=p_input->>'resourceProductId' and pack_version_id=p_input->>'packVersionId' and agent_id=p_input->>'agentId' and flow_version_id=p_input->>'flowVersionId' and deployment_id=p_input->>'deploymentId' and price_usdc=(p_input->>'priceUsdc')::double precision)
  then raise exception 'RESOURCE_CONFLICT'; end if;
  insert into public.resource_run_receipts(id,owner_id,resource_product_id,pack_version_id,agent_id,run_id,flow_version_id,deployment_id,payment_id,payment_state,price_usdc,semantic_hash,freshness,evidence_json,unknowns_json,conflicts_json,output_schema_valid,created_at)
  values(coalesce(p_input->>'id',gen_random_uuid()::text),p_input->>'ownerId',p_input->>'resourceProductId',p_input->>'packVersionId',p_input->>'agentId',p_input->>'runId',p_input->>'flowVersionId',p_input->>'deploymentId',p_input->>'paymentId',p_input->>'paymentState',(p_input->>'priceUsdc')::double precision,receipt->>'semanticHash',receipt->>'freshness',receipt->'evidence',receipt->'unknowns',receipt->'conflicts',(receipt->>'outputSchemaValid')::boolean,coalesce((p_input->>'createdAt')::timestamptz,clock_timestamp())) returning * into r;
  return to_jsonb(r)||jsonb_build_object('evidence',r.evidence_json,'unknowns',r.unknowns_json,'conflicts',r.conflicts_json);
end; $$;

create or replace function public.agent_studio_resource_list_run_receipts(p_owner_id text,p_resource_product_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('evidence',r.evidence_json,'unknowns',r.unknowns_json,'conflicts',r.conflicts_json) order by r.created_at desc,r.id desc),'[]'::jsonb)
  from public.resource_run_receipts r where r.owner_id=p_owner_id and r.resource_product_id=p_resource_product_id and exists(select 1 from public.resource_products p where p.id=r.resource_product_id and p.owner_id=p_owner_id)
$$;

create or replace function public.agent_studio_restore_active_deployment(
  p_deployment_id uuid,
  p_expected_active_deployment_id uuid,
  p_owner_id text
)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,extensions as $$
declare prior_row public.deployments%rowtype; current_row public.deployments%rowtype; environment_kind text;
begin
  select d.* into prior_row
  from public.deployments d
  join public.flows f on f.id=d.flow_id and f.owner_id=p_owner_id
  where d.id=p_deployment_id and d.status='retired' and d.retired_at is not null;
  if prior_row.id is not null then
    select e.kind into environment_kind
    from public.environments e
    where e.id=prior_row.environment_id;
  end if;
  if prior_row.id is null or environment_kind not in ('test','live') then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'suede-agent-studio:deployment:'||prior_row.flow_id::text||':'||prior_row.environment_id::text,0));
  select * into current_row from public.deployments
  where id=p_expected_active_deployment_id and flow_id=prior_row.flow_id
    and environment_id=prior_row.environment_id and status=environment_kind and retired_at is null
  for update;
  if current_row.id is null then return null; end if;
  update public.deployments set status='retired',retired_at=clock_timestamp()
  where id=current_row.id and retired_at is null;
  if not found then return null; end if;
  update public.deployments set status=environment_kind,retired_at=null
  where id=prior_row.id and status='retired' and retired_at is not null returning * into prior_row;
  if not found then raise exception 'RESOURCE_CONFLICT'; end if;
  return to_jsonb(prior_row);
end; $$;

-- Keep Resource ownership in a domain helper so the shared workspace wrapper
-- can compose it with later optional domains (notably Stripe) without either
-- migration replacing the other domain's behavior.
create or replace function public.agent_studio_adopt_resource_owner(p_from_owner_id text,p_to_owner_id text)
returns void language plpgsql volatile security invoker set search_path=pg_catalog,public,extensions as $$
begin
  if p_from_owner_id=p_to_owner_id then return; end if;
  update public.resource_releases set owner_id=p_to_owner_id where owner_id=p_from_owner_id;
  update public.resource_run_receipts set owner_id=p_to_owner_id where owner_id=p_from_owner_id;
  update public.resource_products set owner_id=p_to_owner_id,updated_at=clock_timestamp() where owner_id=p_from_owner_id;
end; $$;

-- If Stripe is already installed, its hardened SECURITY DEFINER wrapper owns
-- authentication, alias resolution, credits, and connections. It dynamically
-- discovers the Resource helper above, so retain it after verifying its exact
-- definition/security preconditions. Otherwise extend the baseline invoker
-- wrapper with Resource ownership. Applying Resource -> Stripe or Stripe ->
-- Resource therefore reaches the same composed transaction.
do $resource_adoption_wrapper$
declare
  v_stripe_helper oid := pg_catalog.to_regprocedure(
    'airbyte_source_private.agent_studio_adopt_stripe_owner(text,text)'
  );
  v_wrapper oid := pg_catalog.to_regprocedure(
    'public.agent_studio_adopt_owner_with_connections(text,text)'
  );
  v_wrapper_security_definer boolean;
  v_wrapper_config text[];
  v_wrapper_owner oid;
  v_wrapper_definition_md5 text;
  v_helper_security_definer boolean;
  v_helper_config text[];
  v_helper_owner oid;
  v_helper_definition_md5 text;
begin
  if v_stripe_helper is null then
    execute $wrapper$
      create or replace function public.agent_studio_adopt_owner_with_connections(
        p_from_owner_id text,
        p_to_owner_id text
      )
      returns void
      language plpgsql
      volatile
      security definer
      set search_path=pg_catalog,pg_temp
      set row_security=off
      as $function$
      begin
        if coalesce(
          nullif(pg_catalog.current_setting('request.jwt.claim.role',true),''),
          (coalesce(nullif(pg_catalog.current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'),
          ''
        )<>'service_role' and not agent_studio_private.request_authorized()
        then
          raise exception 'Resource owner adoption is unauthorized'
            using errcode='42501';
        end if;
        if p_from_owner_id=p_to_owner_id then return; end if;
        perform public.agent_studio_adopt_owner(p_from_owner_id,p_to_owner_id);
        update public.connections
        set owner_id=p_to_owner_id,
            lifecycle_revision=lifecycle_revision+1,
            updated_at=greatest(
              updated_at+1,
              floor(extract(epoch from clock_timestamp())*1000)::bigint
            )
        where owner_id=p_from_owner_id;
        perform public.agent_studio_adopt_resource_owner(
          p_from_owner_id,
          p_to_owner_id
        );
      end;
      $function$
    $wrapper$;
  else
    if v_wrapper is null then
      raise exception 'Resource adoption found an unsafe Stripe owner wrapper'
        using errcode='42501';
    end if;
    select
      functions.prosecdef,
      functions.proconfig,
      functions.proowner,
      pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid))
    into strict
      v_wrapper_security_definer,
      v_wrapper_config,
      v_wrapper_owner,
      v_wrapper_definition_md5
    from pg_catalog.pg_proc as functions
    where functions.oid=v_wrapper;
    select
      functions.prosecdef,
      functions.proconfig,
      functions.proowner,
      pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid))
    into strict
      v_helper_security_definer,
      v_helper_config,
      v_helper_owner,
      v_helper_definition_md5
    from pg_catalog.pg_proc as functions
    where functions.oid=v_stripe_helper;
    if v_wrapper_security_definer is distinct from true
      or v_helper_security_definer is distinct from true
      or v_wrapper_owner<>v_helper_owner
      or v_wrapper_owner<>(select roles.oid from pg_catalog.pg_roles as roles where roles.rolname=current_user)
      or v_wrapper_config is distinct from array[
        'search_path=pg_catalog, pg_temp','row_security=off'
      ]::text[]
      or v_helper_config is distinct from array[
        'search_path=pg_catalog, pg_temp','row_security=off'
      ]::text[]
      or v_wrapper_definition_md5 is distinct from
        '7166de166f29fb2dc03177c0bc5e5ef2'
      or v_helper_definition_md5 is distinct from
        'f2382065902b17f90fcc5679ccac40dd'
    then
      raise exception 'Resource adoption found an unsafe Stripe owner wrapper'
        using errcode='42501';
    end if;
  end if;
end
$resource_adoption_wrapper$;

alter table public.resource_products enable row level security;
alter table public.resource_source_assets enable row level security;
alter table public.resource_source_snapshots enable row level security;
alter table public.resource_pack_versions enable row level security;
alter table public.resource_records enable row level security;
alter table public.resource_evidence_refs enable row level security;
alter table public.resource_releases enable row level security;
alter table public.resource_run_receipts enable row level security;

revoke all privileges on table public.resource_products,public.resource_source_assets,public.resource_source_snapshots,public.resource_pack_versions,public.resource_records,public.resource_evidence_refs,public.resource_releases,public.resource_run_receipts from public,anon,authenticated,service_role;
grant select,insert,update on table public.resource_products,public.resource_source_assets,public.resource_source_snapshots,public.resource_pack_versions,public.resource_records,public.resource_evidence_refs,public.resource_releases,public.resource_run_receipts to service_role;
revoke delete on table public.resource_products,public.resource_source_assets,public.resource_source_snapshots,public.resource_pack_versions,public.resource_records,public.resource_evidence_refs,public.resource_releases,public.resource_run_receipts from service_role;
grant delete on table public.resource_pack_versions to service_role;
grant delete on table public.resource_pack_versions to anon;

do $$ declare table_name text; begin
  foreach table_name in array array['resource_products','resource_source_assets','resource_source_snapshots','resource_pack_versions','resource_records','resource_evidence_refs','resource_releases','resource_run_receipts'] loop
    execute format('drop policy if exists agent_studio_server_access on public.%I',table_name);
    execute format('create policy agent_studio_server_access on public.%I for all to anon using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())',table_name);
    execute format('grant select,insert,update on table public.%I to anon',table_name);
  end loop;
end $$;

revoke all on function public.agent_studio_resource_immutable_guard() from public,anon,authenticated,service_role;
revoke all on function public.agent_studio_restore_active_deployment(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.agent_studio_restore_active_deployment(uuid,uuid,text) to anon,service_role;
revoke all on function public.agent_studio_adopt_resource_owner(text,text) from public,anon,authenticated,service_role;
revoke all on function public.agent_studio_adopt_owner_with_connections(text,text) from public,anon,authenticated,service_role;
grant execute on function public.agent_studio_adopt_owner_with_connections(text,text) to anon,service_role;

revoke all on function public.agent_studio_resource_pack_json(text),public.agent_studio_resource_create_product(jsonb),public.agent_studio_resource_create_product_with_candidate(jsonb),public.agent_studio_resource_get_owned_product(text,text),public.agent_studio_resource_get_owned_portfolio_item(text,text),public.agent_studio_resource_list_owned_products(text),public.agent_studio_resource_list_owned_releases(text,text,integer),public.agent_studio_resource_update_product(jsonb),public.agent_studio_resource_create_source_snapshot(jsonb),public.agent_studio_resource_replace_candidate(jsonb),public.agent_studio_resource_collect_source_candidate(jsonb),public.agent_studio_resource_approve_candidate(jsonb),public.agent_studio_resource_reject_candidate(jsonb),public.agent_studio_resource_get_owned_pack(jsonb),public.agent_studio_resource_get_owned_approved_pack(text,text),public.agent_studio_resource_get_source_disclosure(jsonb),public.agent_studio_resource_create_release(jsonb),public.agent_studio_resource_transition_release_lifecycle(jsonb),public.agent_studio_resource_get_release_by_agent(text),public.agent_studio_resource_list_releases_by_agents(text[]),public.agent_studio_resource_get_release_by_publication(text,text,text),public.agent_studio_resource_record_run_receipt(jsonb),public.agent_studio_resource_list_run_receipts(text,text) from public,anon,authenticated,service_role;
grant execute on function public.agent_studio_resource_pack_json(text),public.agent_studio_resource_create_product(jsonb),public.agent_studio_resource_create_product_with_candidate(jsonb),public.agent_studio_resource_get_owned_product(text,text),public.agent_studio_resource_get_owned_portfolio_item(text,text),public.agent_studio_resource_list_owned_products(text),public.agent_studio_resource_list_owned_releases(text,text,integer),public.agent_studio_resource_update_product(jsonb),public.agent_studio_resource_create_source_snapshot(jsonb),public.agent_studio_resource_replace_candidate(jsonb),public.agent_studio_resource_collect_source_candidate(jsonb),public.agent_studio_resource_approve_candidate(jsonb),public.agent_studio_resource_reject_candidate(jsonb),public.agent_studio_resource_get_owned_pack(jsonb),public.agent_studio_resource_get_owned_approved_pack(text,text),public.agent_studio_resource_get_source_disclosure(jsonb),public.agent_studio_resource_create_release(jsonb),public.agent_studio_resource_transition_release_lifecycle(jsonb),public.agent_studio_resource_get_release_by_agent(text),public.agent_studio_resource_list_releases_by_agents(text[]),public.agent_studio_resource_get_release_by_publication(text,text,text),public.agent_studio_resource_record_run_receipt(jsonb),public.agent_studio_resource_list_run_receipts(text,text) to anon,service_role;

-- Verify the post-state instead of silently composing with an unexpected
-- browser policy or a broader table/function ACL.
do $resource_authorization_postflight$
declare
  v_table_name text;
  v_table_oid oid;
  v_anon_delete_expected boolean;
  v_wrapper oid := pg_catalog.to_regprocedure(
    'public.agent_studio_adopt_owner_with_connections(text,text)'
  );
  v_helper oid := pg_catalog.to_regprocedure(
    'public.agent_studio_adopt_resource_owner(text,text)'
  );
  v_lifecycle oid := pg_catalog.to_regprocedure(
    'public.agent_studio_resource_transition_release_lifecycle(jsonb)'
  );
  v_stripe_helper oid := pg_catalog.to_regprocedure(
    'airbyte_source_private.agent_studio_adopt_stripe_owner(text,text)'
  );
  v_wrapper_security_definer boolean;
  v_wrapper_config text[];
  v_wrapper_owner oid;
  v_wrapper_definition_md5 text;
  v_helper_security_definer boolean;
  v_helper_owner oid;
  v_stripe_helper_owner oid;
  v_stripe_helper_definition_md5 text;
  v_lifecycle_security_definer boolean;
  v_lifecycle_config text[];
begin
  foreach v_table_name in array array[
    'resource_products','resource_source_assets','resource_source_snapshots',
    'resource_pack_versions','resource_records','resource_evidence_refs',
    'resource_releases','resource_run_receipts'
  ] loop
    v_table_oid:=pg_catalog.to_regclass('public.'||v_table_name);
    v_anon_delete_expected:=v_table_name='resource_pack_versions';

    if v_table_oid is null
      or not exists (
        select 1
        from pg_catalog.pg_class as tables
        where tables.oid=v_table_oid
          and tables.relrowsecurity
      )
      or (
        select pg_catalog.count(*)
        from pg_catalog.pg_policy as policies
        where policies.polrelid=v_table_oid
      )<>1
      or not exists (
        select 1
        from pg_catalog.pg_policy as policies
        where policies.polrelid=v_table_oid
          and policies.polname='agent_studio_server_access'
          and policies.polpermissive
          and policies.polcmd='*'
          and policies.polroles=array[(
            select roles.oid
            from pg_catalog.pg_roles as roles
            where roles.rolname='anon'
          )]::oid[]
          and pg_catalog.pg_get_expr(
            policies.polqual,policies.polrelid
          )='agent_studio_private.request_authorized()'
          and pg_catalog.pg_get_expr(
            policies.polwithcheck,policies.polrelid
          )='agent_studio_private.request_authorized()'
      )
      or not pg_catalog.has_table_privilege('anon',v_table_oid,'select')
      or not pg_catalog.has_table_privilege('anon',v_table_oid,'insert')
      or not pg_catalog.has_table_privilege('anon',v_table_oid,'update')
      or pg_catalog.has_table_privilege(
        'anon',v_table_oid,'delete'
      ) is distinct from v_anon_delete_expected
      or not pg_catalog.has_table_privilege('service_role',v_table_oid,'select')
      or not pg_catalog.has_table_privilege('service_role',v_table_oid,'insert')
      or not pg_catalog.has_table_privilege('service_role',v_table_oid,'update')
      or pg_catalog.has_table_privilege(
        'service_role',v_table_oid,'delete'
      ) is distinct from v_anon_delete_expected
      or pg_catalog.has_table_privilege('authenticated',v_table_oid,'select')
      or pg_catalog.has_table_privilege('authenticated',v_table_oid,'insert')
      or pg_catalog.has_table_privilege('authenticated',v_table_oid,'update')
      or pg_catalog.has_table_privilege('authenticated',v_table_oid,'delete')
    then
      raise exception 'Resource RLS policy drift on %',v_table_name
        using errcode='42501';
    end if;
  end loop;

  if v_wrapper is null or v_helper is null or v_lifecycle is null then
    raise exception 'Resource adoption wrapper drift'
      using errcode='42501';
  end if;

  select
    functions.prosecdef,
    functions.proconfig,
    functions.proowner,
    pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid))
  into strict
    v_wrapper_security_definer,
    v_wrapper_config,
    v_wrapper_owner,
    v_wrapper_definition_md5
  from pg_catalog.pg_proc as functions
  where functions.oid=v_wrapper;
  select functions.prosecdef,functions.proowner
  into strict v_helper_security_definer,v_helper_owner
  from pg_catalog.pg_proc as functions
  where functions.oid=v_helper;
  select functions.prosecdef,functions.proconfig
  into strict v_lifecycle_security_definer,v_lifecycle_config
  from pg_catalog.pg_proc as functions
  where functions.oid=v_lifecycle;
  if v_stripe_helper is not null then
    select
      functions.proowner,
      pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid))
    into strict
      v_stripe_helper_owner,
      v_stripe_helper_definition_md5
    from pg_catalog.pg_proc as functions
    where functions.oid=v_stripe_helper;
  end if;

  if not v_wrapper_security_definer
    or not ('search_path=pg_catalog, pg_temp'=any(
      coalesce(v_wrapper_config,array[]::text[])
    ))
    or not ('row_security=off'=any(
      coalesce(v_wrapper_config,array[]::text[])
    ))
    or v_wrapper_owner<>v_helper_owner
    or v_wrapper_owner<>(
      select roles.oid
      from pg_catalog.pg_roles as roles
      where roles.rolname=current_user
    )
    or (
      v_stripe_helper is not null
      and (
        v_wrapper_owner<>v_stripe_helper_owner
        or v_wrapper_definition_md5 is distinct from
          '7166de166f29fb2dc03177c0bc5e5ef2'
        or v_stripe_helper_definition_md5 is distinct from
          'f2382065902b17f90fcc5679ccac40dd'
      )
    )
    or v_helper_security_definer
    or not pg_catalog.has_function_privilege(
      'anon',v_wrapper,'execute'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',v_wrapper,'execute'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',v_wrapper,'execute'
    )
    or pg_catalog.has_function_privilege(
      'anon',v_helper,'execute'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',v_helper,'execute'
    )
    or pg_catalog.has_function_privilege(
      'service_role',v_helper,'execute'
    )
    or v_lifecycle_security_definer
    or not ('search_path=pg_catalog, public'=any(
      coalesce(v_lifecycle_config,array[]::text[])
    ))
    or not pg_catalog.has_function_privilege(
      'anon',v_lifecycle,'execute'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',v_lifecycle,'execute'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',v_lifecycle,'execute'
    )
  then
    raise exception 'Resource adoption wrapper drift'
      using errcode='42501';
  end if;
end
$resource_authorization_postflight$;

-- Re-attest the same complete inventory after every Resource DDL, upgrade,
-- trigger, function, policy, grant, and adoption-wrapper change. This catches
-- omissions as well as weaker same-name replacements before commit.
do $resource_constraint_postflight$
declare
  v_spec record;
  v_actual record;
begin
  for v_spec in
    select *
    from pg_temp.agent_studio_resource_expected_constraints
    order by table_name,constraint_name
  loop
    select
      constraints.contype,
      constraints.convalidated,
      pg_catalog.pg_get_constraintdef(constraints.oid,true) as definition
    into v_actual
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid=pg_catalog.to_regclass('public.'||v_spec.table_name)
      and constraints.conname=v_spec.constraint_name;

    if not found then
      raise exception 'Resource constraint postflight missing on %.%',
        v_spec.table_name,v_spec.constraint_name
        using errcode='42501';
    end if;
    if v_actual.contype is distinct from v_spec.constraint_type
      or v_actual.convalidated is distinct from true
      or v_actual.definition is distinct from v_spec.expected_definition
    then
      raise exception 'Resource constraint postflight drift on %.%',
        v_spec.table_name,v_spec.constraint_name
        using errcode='42501';
    end if;
  end loop;

  select
    tables.relname as table_name,
    constraints.conname as constraint_name
  into v_actual
  from pg_catalog.pg_constraint as constraints
  join pg_catalog.pg_class as tables
    on tables.oid=constraints.conrelid
  join pg_catalog.pg_namespace as schemas
    on schemas.oid=tables.relnamespace
  left join pg_temp.agent_studio_resource_expected_constraints as expected
    on expected.table_name=tables.relname
    and expected.constraint_name=constraints.conname
  where schemas.nspname='public'
    and tables.relname in (
      select distinct inventory.table_name
      from pg_temp.agent_studio_resource_expected_constraints as inventory
    )
    and expected.constraint_name is null
  order by tables.relname,constraints.conname
  limit 1;
  if found then
    raise exception 'Unexpected Resource constraint after migration on %.%',
      v_actual.table_name,v_actual.constraint_name
      using errcode='42501';
  end if;
end
$resource_constraint_postflight$;

commit;
