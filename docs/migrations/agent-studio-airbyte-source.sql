-- Privacy-safe Agent Studio outcome source for Airbyte.
--
-- Prepared manual migration. It creates:
--   * an append-only, RLS-protected private outcome ledger;
--   * commit-serialized source_revision_at cursors;
--   * HMAC-pseudonymous event/account keys backed by Supabase Vault;
--   * one allowlisted source view at
--       airbyte_source.normalized_agent_outcomes; and
--   * one strict NOLOGIN capability role.
--
-- It intentionally does not create a LOGIN or contain a password. Provision
-- the Airbyte login separately with the least-privilege procedure in
-- docs/architecture/airbyte-marketing-source.md.

begin;
set local search_path = pg_catalog, pg_temp;
set local createrole_self_grant = '';
set local lock_timeout = '5s';
set local statement_timeout = '120s';
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'suede-agent-studio:airbyte-source:v1',
    0
  )
);

-- Fail closed if the production tables this adapter depends on have drifted.
do $migration$
declare
  v_issue text;
begin
  with expected(
    table_name,
    column_name,
    udt_name,
    is_nullable
  ) as (
    values
      ('agents', 'id', 'uuid', 'NO'),
      ('agents', 'flow_id', 'uuid', 'NO'),
      ('agents', 'status', 'text', 'NO'),
      ('agents', 'created_at', 'timestamptz', 'NO'),
      ('runs', 'id', 'uuid', 'NO'),
      ('runs', 'flow_id', 'uuid', 'NO'),
      ('runs', 'agent_id', 'uuid', 'YES'),
      ('runs', 'trigger', 'text', 'NO'),
      ('runs', 'status', 'text', 'NO'),
      ('runs', 'started_at', 'timestamptz', 'NO'),
      ('runs', 'finished_at', 'timestamptz', 'YES'),
      ('runs', 'settled_at', 'text', 'YES'),
      ('deployments', 'id', 'uuid', 'NO'),
      ('deployments', 'flow_id', 'uuid', 'NO'),
      ('deployments', 'flow_version_id', 'uuid', 'NO'),
      ('deployments', 'environment_id', 'uuid', 'NO'),
      ('deployments', 'status', 'text', 'NO'),
      ('deployments', 'created_at', 'timestamptz', 'NO'),
      ('environments', 'id', 'uuid', 'NO'),
      ('environments', 'kind', 'text', 'NO'),
      ('flow_versions', 'id', 'uuid', 'NO'),
      ('flow_versions', 'version_number', 'int4', 'NO'),
      ('settlements', 'run_id', 'text', 'NO'),
      ('settlements', 'agent_id', 'text', 'NO'),
      ('settlements', 'created_at', 'text', 'NO')
  ),
  actual as (
    select
      columns.table_name,
      columns.column_name,
      columns.udt_name,
      columns.is_nullable
    from information_schema.columns as columns
    where columns.table_schema = 'public'
      and columns.table_name in (
        'agents',
        'runs',
        'deployments',
        'environments',
        'flow_versions',
        'settlements'
      )
  )
  select pg_catalog.format(
    '%I.%I expected %s/%s',
    expected.table_name,
    expected.column_name,
    expected.udt_name,
    expected.is_nullable
  )
  into v_issue
  from expected
  left join actual
    on actual.table_name = expected.table_name
   and actual.column_name = expected.column_name
   and actual.udt_name = expected.udt_name
   and actual.is_nullable = expected.is_nullable
  where actual.column_name is null
  order by expected.table_name, expected.column_name
  limit 1;

  if v_issue is not null then
    raise exception 'Agent Studio Airbyte source-column drift: %', v_issue
      using errcode = '55000';
  end if;

  select c.oid::regclass::text
  into v_issue
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'agents',
      'runs',
      'deployments',
      'environments',
      'flow_versions',
      'settlements'
    )
    and (c.relkind <> 'r' or c.relpersistence <> 'p')
  order by c.relname
  limit 1;

  if v_issue is not null then
    raise exception
      'Agent Studio Airbyte source requires permanent ordinary tables: %',
      v_issue
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.settlements as settlements
    where not pg_catalog.pg_input_is_valid(
      settlements.created_at,
      'timestamp with time zone'
    )
  ) then
    raise exception
      'Agent Studio Airbyte source found an invalid settlement timestamp'
      using errcode = '22007';
  end if;
end
$migration$;

-- The capability role is deliberately unable to log in and may not inherit
-- any other role. A separately managed LOGIN inherits this role.
do $migration$
declare
  v_role record;
  v_migration_oid oid;
  v_migration_super boolean;
  v_migration_createrole boolean;
begin
  select
    oid,
    rolsuper,
    rolcreaterole
  into strict
    v_migration_oid,
    v_migration_super,
    v_migration_createrole
  from pg_catalog.pg_roles
  where rolname = current_user;

  select
    oid,
    rolcanlogin,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolbypassrls,
    rolinherit
  into v_role
  from pg_catalog.pg_roles
  where rolname = 'suede_agent_studio_airbyte_reader';

  if not found then
    create role suede_agent_studio_airbyte_reader
      nologin
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls;
  elsif
    v_role.rolcanlogin
    or v_role.rolsuper
    or v_role.rolcreatedb
    or v_role.rolcreaterole
    or v_role.rolreplication
    or v_role.rolbypassrls
    or v_role.rolinherit
    or exists (
      select 1
      from pg_catalog.pg_auth_members
      where member = v_role.oid
    )
    or exists (
      select 1
      from pg_catalog.pg_auth_members as memberships
      join pg_catalog.pg_roles as members
        on members.oid = memberships.member
      where memberships.roleid = v_role.oid
        and not (
          (
            members.rolname = 'suede_agent_studio_airbyte_login'
            and not memberships.admin_option
            and memberships.inherit_option
            and not memberships.set_option
          )
          or (
            not v_migration_super
            and v_migration_createrole
            and memberships.member = v_migration_oid
            and memberships.admin_option
            and not memberships.inherit_option
            and not memberships.set_option
          )
        )
    )
    or (
      not v_migration_super
      and v_migration_createrole
      and not exists (
        select 1
        from pg_catalog.pg_auth_members as memberships
        where memberships.roleid = v_role.oid
          and memberships.member = v_migration_oid
          and memberships.admin_option
          and not memberships.inherit_option
          and not memberships.set_option
      )
    )
    or exists (
      select 1
      from pg_catalog.pg_shdepend as dependencies
      where dependencies.refclassid = 'pg_authid'::regclass
        and dependencies.refobjid = v_role.oid
        and dependencies.deptype = 'o'
    )
    or exists (
      select 1
      from pg_catalog.pg_namespace as n
      cross join lateral pg_catalog.aclexplode(n.nspacl) as acl
      where n.nspname not in (
        'airbyte_source',
        'airbyte_source_private'
      )
        and n.nspacl is not null
        and acl.grantee = v_role.oid
    )
    or exists (
      select 1
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(c.relacl) as acl
      where n.nspname not in (
        'airbyte_source',
        'airbyte_source_private'
      )
        and c.relacl is not null
        and acl.grantee = v_role.oid
    )
    or exists (
      select 1
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(p.proacl) as acl
      where n.nspname not in (
        'airbyte_source',
        'airbyte_source_private'
      )
        and p.proacl is not null
        and acl.grantee = v_role.oid
    )
    or exists (
      select 1
      from pg_catalog.pg_default_acl as d
      cross join lateral pg_catalog.aclexplode(d.defaclacl) as acl
      where acl.grantee = v_role.oid
    )
  then
    raise exception
      'suede_agent_studio_airbyte_reader has unsafe attributes, memberships, or grants'
      using errcode = '42501';
  end if;
end
$migration$;

do $migration$
declare
  v_secret_count integer;
begin
  if
    pg_catalog.to_regprocedure(
      'vault.create_secret(text,text,text,uuid)'
    ) is null
    or pg_catalog.to_regprocedure(
      'extensions.gen_random_bytes(integer)'
    ) is null
    or pg_catalog.to_regprocedure(
      'extensions.hmac(bytea,bytea,text)'
    ) is null
  then
    raise exception
      'Supabase Vault and pgcrypto are required for the Agent Studio Airbyte adapter'
      using errcode = '0A000';
  end if;

  select pg_catalog.count(*)
  into v_secret_count
  from vault.secrets
  where name = 'suede_agent_studio_airbyte_identity_hmac_v1';

  if v_secret_count = 0 then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'hex'),
      'suede_agent_studio_airbyte_identity_hmac_v1',
      'HMAC-SHA-256 key for Agent Studio privacy-safe Airbyte outcomes',
      null
    );
  elsif v_secret_count <> 1 then
    raise exception
      'Expected exactly one Agent Studio Airbyte identity secret'
      using errcode = '22000';
  end if;
end
$migration$;

create schema if not exists airbyte_source_private;
alter schema airbyte_source_private owner to current_user;
create schema if not exists airbyte_source;
alter schema airbyte_source owner to current_user;

revoke all privileges on schema airbyte_source_private
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;
revoke all privileges on schema airbyte_source
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;
grant usage on schema airbyte_source
  to suede_agent_studio_airbyte_reader;

create table if not exists
  airbyte_source_private.agent_outcome_events (
    ledger_id bigint generated always as identity,
    source_key_hash text not null,
    dedupe_key text not null,
    event_id text not null,
    occurred_at timestamp(3) with time zone not null,
    source_revision_at timestamp(3) with time zone not null,
    event_name text not null,
    lifecycle_stage text not null,
    account_key text not null,
    product_version text,
    outcome text not null,
    state text not null,
    delivery_state text,
    constraint pk_agent_outcome_events primary key (ledger_id),
    constraint uq_agent_outcome_events_source_revision
      unique (source_revision_at),
    constraint uq_agent_outcome_events_dedupe unique (dedupe_key),
    constraint uq_agent_outcome_events_event unique (event_id),
    constraint ck_agent_outcome_events_source_key
      check (source_key_hash ~ '^[0-9a-f]{64}$'),
    constraint ck_agent_outcome_events_dedupe_key
      check (dedupe_key ~ '^[0-9a-f]{64}$'),
    constraint ck_agent_outcome_events_event_id
      check (event_id ~ '^[0-9a-f]{64}$'),
    constraint ck_agent_outcome_events_account_key
      check (account_key ~ '^[0-9a-f]{64}$'),
    constraint ck_agent_outcome_events_event_name
      check (event_name in (
        'agent_drafted',
        'agent_published',
        'test_run_completed',
        'test_deployed',
        'live_deployed',
        'paid_call_settled'
      )),
    constraint ck_agent_outcome_events_lifecycle_stage
      check (lifecycle_stage in (
        'activation',
        'qualified',
        'retained',
        'revenue'
      )),
    constraint ck_agent_outcome_events_product_version
      check (
        product_version is null
        or (
          pg_catalog.octet_length(product_version) between 1 and 32
          and product_version ~ '^[1-9][0-9]{0,9}$'
        )
      ),
    constraint ck_agent_outcome_events_outcome
      check (outcome in (
        'drafted',
        'published',
        'completed',
        'deployed',
        'settled'
      )),
    constraint ck_agent_outcome_events_state
      check (state in (
        'draft',
        'live',
        'done',
        'test',
        'settled'
      )),
    constraint ck_agent_outcome_events_delivery_state
      check (
        delivery_state is null
        or delivery_state in ('test', 'live', 'terminal')
      )
  );

alter table airbyte_source_private.agent_outcome_events
  enable row level security;
revoke all privileges on table
  airbyte_source_private.agent_outcome_events
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

create or replace function
  airbyte_source_private.hmac_sha256(
    p_namespace text,
    p_value text
  )
returns text
language plpgsql
stable
strict
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_secret text;
  v_secret_count integer;
begin
  if
    pg_catalog.octet_length(p_namespace) not between 1 and 128
    or pg_catalog.octet_length(p_value) not between 1 and 1024
  then
    raise exception 'Agent Studio Airbyte HMAC input is outside its bounds'
      using errcode = '22023';
  end if;

  select pg_catalog.count(*), pg_catalog.min(decrypted_secret)
  into v_secret_count, v_secret
  from vault.decrypted_secrets
  where name = 'suede_agent_studio_airbyte_identity_hmac_v1';

  if
    v_secret_count <> 1
    or v_secret is null
    or v_secret !~ '^[0-9a-f]{64}$'
  then
    raise exception
      'Agent Studio Airbyte identity HMAC key is unavailable or invalid'
      using errcode = '55000';
  end if;

  return pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(
        p_namespace || chr(31) || p_value,
        'UTF8'
      ),
      pg_catalog.decode(v_secret, 'hex'),
      'sha256'
    ),
    'hex'
  );
end
$function$;

revoke all privileges on function
  airbyte_source_private.hmac_sha256(text, text)
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

create or replace function
  airbyte_source_private.append_agent_outcome(
    p_source_kind text,
    p_source_id text,
    p_revision_token text,
    p_account_source_id text,
    p_occurred_at timestamp with time zone,
    p_event_name text,
    p_lifecycle_stage text,
    p_product_version text,
    p_outcome text,
    p_state text,
    p_delivery_state text
  )
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_source_key_hash text;
  v_dedupe_key text;
  v_event_id text;
  v_occurred_at timestamp(3) with time zone;
  v_source_revision_at timestamp(3) with time zone;
begin
  if p_source_kind not in (
    'agent',
    'run',
    'deployment',
    'settlement'
  ) then
    raise exception 'Unsupported Agent Studio Airbyte source kind'
      using errcode = '22023';
  end if;
  if
    p_source_id is null
    or pg_catalog.octet_length(p_source_id) not between 1 and 128
    or p_revision_token is null
    or pg_catalog.octet_length(p_revision_token) not between 1 and 128
    or p_account_source_id is null
    or pg_catalog.octet_length(p_account_source_id) not between 1 and 128
    or p_occurred_at is null
    or p_occurred_at < '2000-01-01 00:00:00+00'::timestamptz
    or p_occurred_at >
      pg_catalog.clock_timestamp() + interval '5 minutes'
  then
    raise exception 'Invalid Agent Studio Airbyte source evidence'
      using errcode = '22023';
  end if;

  if not (
    (
      p_source_kind = 'agent'
      and p_event_name = 'agent_drafted'
      and p_lifecycle_stage = 'activation'
      and p_product_version is null
      and p_outcome = 'drafted'
      and p_state = 'draft'
      and p_delivery_state is null
    )
    or (
      p_source_kind = 'agent'
      and p_event_name = 'agent_published'
      and p_lifecycle_stage = 'retained'
      and p_product_version is null
      and p_outcome = 'published'
      and p_state = 'live'
      and p_delivery_state is null
    )
    or (
      p_source_kind = 'run'
      and p_event_name = 'test_run_completed'
      and p_lifecycle_stage = 'qualified'
      and p_product_version is null
      and p_outcome = 'completed'
      and p_state = 'done'
      and p_delivery_state = 'test'
    )
    or (
      p_source_kind = 'deployment'
      and p_event_name = 'test_deployed'
      and p_lifecycle_stage = 'qualified'
      and p_product_version ~ '^[1-9][0-9]{0,9}$'
      and p_outcome = 'deployed'
      and p_state = 'test'
      and p_delivery_state = 'test'
    )
    or (
      p_source_kind = 'deployment'
      and p_event_name = 'live_deployed'
      and p_lifecycle_stage = 'retained'
      and p_product_version ~ '^[1-9][0-9]{0,9}$'
      and p_outcome = 'deployed'
      and p_state = 'live'
      and p_delivery_state = 'live'
    )
    or (
      p_source_kind = 'settlement'
      and p_event_name = 'paid_call_settled'
      and p_lifecycle_stage = 'revenue'
      and p_product_version is null
      and p_outcome = 'settled'
      and p_state = 'settled'
      and p_delivery_state = 'terminal'
    )
  ) then
    raise exception 'Invalid Agent Studio Airbyte outcome mapping'
      using errcode = '22023';
  end if;

  v_occurred_at := pg_catalog.date_trunc('milliseconds', p_occurred_at);
  v_source_key_hash :=
    airbyte_source_private.hmac_sha256(
      'agent_studio_db:source:' || p_source_kind,
      p_source_id
    );
  v_dedupe_key :=
    airbyte_source_private.hmac_sha256(
      'agent_studio_db:dedupe:' || p_event_name,
      p_source_id || chr(31) || p_revision_token
    );
  v_event_id :=
    airbyte_source_private.hmac_sha256(
      'agent_studio_db:event:' || p_event_name,
      p_source_id || chr(31) || p_revision_token
    );

  -- Every transaction that emits an outcome takes the same transaction-level
  -- advisory lock. The lock is held through commit, so a later transaction
  -- cannot receive an earlier cursor and commit first. The +1 millisecond
  -- floor makes the millisecond-precision cursor unique at clock boundaries.
  perform pg_catalog.pg_advisory_xact_lock(1987202607, 30);

  if exists (
    select 1
    from airbyte_source_private.agent_outcome_events as existing
    where existing.dedupe_key = v_dedupe_key
  ) then
    return;
  end if;

  select greatest(
    pg_catalog.date_trunc(
      'milliseconds',
      pg_catalog.clock_timestamp()
    ),
    v_occurred_at,
    coalesce(
      pg_catalog.max(events.source_revision_at)
        + interval '1 millisecond',
      '2000-01-01 00:00:00+00'::timestamptz
    )
  )
  into strict v_source_revision_at
  from airbyte_source_private.agent_outcome_events as events;

  insert into airbyte_source_private.agent_outcome_events (
    source_key_hash,
    dedupe_key,
    event_id,
    occurred_at,
    source_revision_at,
    event_name,
    lifecycle_stage,
    account_key,
    product_version,
    outcome,
    state,
    delivery_state
  ) values (
    v_source_key_hash,
    v_dedupe_key,
    v_event_id,
    v_occurred_at,
    v_source_revision_at,
    p_event_name,
    p_lifecycle_stage,
    airbyte_source_private.hmac_sha256(
      'agent_studio_db:account:flow',
      p_account_source_id
    ),
    p_product_version,
    p_outcome,
    p_state,
    p_delivery_state
  )
  on conflict (dedupe_key) do nothing;
end
$function$;

revoke all privileges on function
  airbyte_source_private.append_agent_outcome(
    text,
    text,
    text,
    text,
    timestamp with time zone,
    text,
    text,
    text,
    text,
    text,
    text
  )
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

create or replace function
  airbyte_source_private.reject_agent_outcome_mutation()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'Agent Studio Airbyte outcome events are append-only'
    using errcode = '55000';
end
$function$;

revoke all privileges on function
  airbyte_source_private.reject_agent_outcome_mutation()
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

drop trigger if exists agent_outcome_events_append_only
  on airbyte_source_private.agent_outcome_events;
create trigger agent_outcome_events_append_only
before update or delete
on airbyte_source_private.agent_outcome_events
for each row execute function
  airbyte_source_private.reject_agent_outcome_mutation();

create or replace function
  airbyte_source_private.capture_agent_outcome()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_event_name text;
  v_lifecycle_stage text;
  v_outcome text;
  v_occurred_at timestamp with time zone;
begin
  if
    tg_op = 'UPDATE'
    and old.status is not distinct from new.status
  then
    return new;
  end if;
  if new.status = 'draft' then
    v_event_name := 'agent_drafted';
    v_lifecycle_stage := 'activation';
    v_outcome := 'drafted';
  elsif new.status = 'live' then
    v_event_name := 'agent_published';
    v_lifecycle_stage := 'retained';
    v_outcome := 'published';
  else
    return new;
  end if;

  v_occurred_at := case
    when tg_op = 'INSERT' then new.created_at
    else pg_catalog.clock_timestamp()
  end;

  perform airbyte_source_private.append_agent_outcome(
    'agent',
    new.id::text,
    pg_catalog.txid_current()::text || ':' || new.status,
    new.flow_id::text,
    v_occurred_at,
    v_event_name,
    v_lifecycle_stage,
    null,
    v_outcome,
    new.status,
    null
  );
  return new;
end
$function$;

create or replace function
  airbyte_source_private.capture_test_run_outcome()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
begin
  if
    new.trigger <> 'test'
    or new.status <> 'done'
    or (
      tg_op = 'UPDATE'
      and old.status = 'done'
    )
  then
    return new;
  end if;

  perform airbyte_source_private.append_agent_outcome(
    'run',
    new.id::text,
    pg_catalog.txid_current()::text || ':done',
    new.flow_id::text,
    coalesce(new.finished_at, pg_catalog.clock_timestamp()),
    'test_run_completed',
    'qualified',
    null,
    'completed',
    'done',
    'test'
  );
  return new;
end
$function$;

create or replace function
  airbyte_source_private.capture_deployment_outcome()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_environment_kind text;
  v_version_number integer;
begin
  select environments.kind, versions.version_number
  into v_environment_kind, v_version_number
  from public.environments as environments
  join public.flow_versions as versions
    on versions.id = new.flow_version_id
  where environments.id = new.environment_id;

  if
    v_environment_kind not in ('test', 'live')
    or new.status <> v_environment_kind
    or v_version_number is null
    or v_version_number < 1
  then
    return new;
  end if;

  perform airbyte_source_private.append_agent_outcome(
    'deployment',
    new.id::text,
    pg_catalog.txid_current()::text || ':' || v_environment_kind,
    new.flow_id::text,
    new.created_at,
    case v_environment_kind
      when 'test' then 'test_deployed'
      else 'live_deployed'
    end,
    case v_environment_kind
      when 'test' then 'qualified'
      else 'retained'
    end,
    v_version_number::text,
    'deployed',
    v_environment_kind,
    v_environment_kind
  );
  return new;
end
$function$;

create or replace function
  airbyte_source_private.capture_settlement_outcome()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_flow_id uuid;
  v_occurred_at timestamp with time zone;
  v_settled_at text;
begin
  begin
    v_occurred_at := new.created_at::timestamptz;
  exception when others then
    return new;
  end;

  -- Updating runs.settled_at already holds this row lock before its AFTER
  -- trigger executes. Taking the same lock here makes the two evidence
  -- writers observe one another after commit instead of both seeing the
  -- other's pre-transaction state.
  select runs.flow_id, runs.settled_at
  into v_flow_id, v_settled_at
  from public.runs as runs
  join public.agents as agents
    on agents.id = runs.agent_id
   and agents.id::text = new.agent_id
  where runs.id::text = new.run_id
  for update of runs;

  if v_flow_id is null or v_settled_at is null then
    return new;
  end if;

  perform airbyte_source_private.append_agent_outcome(
    'settlement',
    new.run_id,
    'terminal-v1',
    v_flow_id::text,
    v_occurred_at,
    'paid_call_settled',
    'revenue',
    null,
    'settled',
    'settled',
    'terminal'
  );
  return new;
end
$function$;

create or replace function
  airbyte_source_private.capture_settled_run_outcome()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_created_at text;
  v_occurred_at timestamp with time zone;
begin
  if new.settled_at is null then
    return new;
  end if;

  select settlements.created_at
  into v_created_at
  from public.settlements as settlements
  where settlements.run_id = new.id::text
    and settlements.agent_id = new.agent_id::text;

  if v_created_at is null then
    return new;
  end if;

  begin
    v_occurred_at := v_created_at::timestamptz;
  exception when others then
    return new;
  end;

  perform airbyte_source_private.append_agent_outcome(
    'settlement',
    new.id::text,
    'terminal-v1',
    new.flow_id::text,
    v_occurred_at,
    'paid_call_settled',
    'revenue',
    null,
    'settled',
    'settled',
    'terminal'
  );
  return new;
end
$function$;

revoke all privileges on function
  airbyte_source_private.capture_agent_outcome(),
  airbyte_source_private.capture_test_run_outcome(),
  airbyte_source_private.capture_deployment_outcome(),
  airbyte_source_private.capture_settlement_outcome(),
  airbyte_source_private.capture_settled_run_outcome()
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

drop trigger if exists agent_studio_airbyte_agents
  on public.agents;
create trigger agent_studio_airbyte_agents
after insert or update of status
on public.agents
for each row execute function
  airbyte_source_private.capture_agent_outcome();

drop trigger if exists agent_studio_airbyte_test_runs
  on public.runs;
create trigger agent_studio_airbyte_test_runs
after insert or update of status, finished_at
on public.runs
for each row execute function
  airbyte_source_private.capture_test_run_outcome();

drop trigger if exists agent_studio_airbyte_settled_runs
  on public.runs;
create trigger agent_studio_airbyte_settled_runs
after update of settled_at
on public.runs
for each row execute function
  airbyte_source_private.capture_settled_run_outcome();

drop trigger if exists agent_studio_airbyte_deployments
  on public.deployments;
create trigger agent_studio_airbyte_deployments
after insert
on public.deployments
for each row execute function
  airbyte_source_private.capture_deployment_outcome();

drop trigger if exists agent_studio_airbyte_settlements
  on public.settlements;
create trigger agent_studio_airbyte_settlements
after insert
on public.settlements
for each row execute function
  airbyte_source_private.capture_settlement_outcome();

-- Initial snapshot. Existing current agent state is one evidence event per
-- agent. A run is a Test outcome only when its stored trigger says "test";
-- manual runs are never relabeled. Every historical deployment uses its
-- immutable environment kind, including deployments later retired. A
-- settlement is included only when its run has terminal settlement evidence.
do $migration$
declare
  v_row record;
  v_event_name text;
  v_snapshot_observed_at constant timestamp with time zone :=
    pg_catalog.statement_timestamp();
begin
  for v_row in
    select agents.id, agents.flow_id, agents.status, agents.created_at
    from public.agents as agents
    where agents.status in ('draft', 'live')
      and not exists (
        select 1
        from airbyte_source_private.agent_outcome_events as events
        where events.source_key_hash =
          airbyte_source_private.hmac_sha256(
            'agent_studio_db:source:agent',
            agents.id::text
          )
          and events.event_name in (
            'agent_drafted',
            'agent_published'
          )
      )
    order by agents.created_at, agents.id
  loop
    v_event_name := case v_row.status
      when 'draft' then 'agent_drafted'
      else 'agent_published'
    end;
    perform airbyte_source_private.append_agent_outcome(
      'agent',
      v_row.id::text,
      'backfill-current-v1',
      v_row.flow_id::text,
      v_snapshot_observed_at,
      v_event_name,
      case v_row.status
        when 'draft' then 'activation'
        else 'retained'
      end,
      null,
      case v_row.status
        when 'draft' then 'drafted'
        else 'published'
      end,
      v_row.status,
      null
    );
  end loop;

  for v_row in
    select
      runs.id,
      runs.flow_id,
      runs.started_at,
      runs.finished_at
    from public.runs as runs
    where runs.trigger = 'test'
      and runs.status = 'done'
      and not exists (
        select 1
        from airbyte_source_private.agent_outcome_events as events
        where events.source_key_hash =
          airbyte_source_private.hmac_sha256(
            'agent_studio_db:source:run',
            runs.id::text
          )
          and events.event_name = 'test_run_completed'
      )
    order by coalesce(runs.finished_at, runs.started_at), runs.id
  loop
    perform airbyte_source_private.append_agent_outcome(
      'run',
      v_row.id::text,
      'backfill-v1',
      v_row.flow_id::text,
      coalesce(v_row.finished_at, v_snapshot_observed_at),
      'test_run_completed',
      'qualified',
      null,
      'completed',
      'done',
      'test'
    );
  end loop;

  for v_row in
    select
      deployments.id,
      deployments.flow_id,
      deployments.created_at,
      environments.kind,
      versions.version_number
    from public.deployments as deployments
    join public.environments as environments
      on environments.id = deployments.environment_id
    join public.flow_versions as versions
      on versions.id = deployments.flow_version_id
    where environments.kind in ('test', 'live')
      and versions.version_number >= 1
      and not exists (
        select 1
        from airbyte_source_private.agent_outcome_events as events
        where events.source_key_hash =
          airbyte_source_private.hmac_sha256(
            'agent_studio_db:source:deployment',
            deployments.id::text
          )
          and events.event_name = case environments.kind
            when 'test' then 'test_deployed'
            else 'live_deployed'
          end
      )
    order by deployments.created_at, deployments.id
  loop
    perform airbyte_source_private.append_agent_outcome(
      'deployment',
      v_row.id::text,
      'backfill-v1',
      v_row.flow_id::text,
      v_row.created_at,
      case v_row.kind
        when 'test' then 'test_deployed'
        else 'live_deployed'
      end,
      case v_row.kind
        when 'test' then 'qualified'
        else 'retained'
      end,
      v_row.version_number::text,
      'deployed',
      v_row.kind,
      v_row.kind
    );
  end loop;

  for v_row in
    select
      settlements.run_id,
      runs.flow_id,
      settlements.created_at::timestamptz as occurred_at
    from public.settlements as settlements
    join public.runs as runs
      on runs.id::text = settlements.run_id
     and runs.settled_at is not null
    join public.agents as agents
      on agents.id = runs.agent_id
     and agents.id::text = settlements.agent_id
    where not exists (
        select 1
        from airbyte_source_private.agent_outcome_events as events
        where events.source_key_hash =
          airbyte_source_private.hmac_sha256(
            'agent_studio_db:source:settlement',
            settlements.run_id
          )
          and events.event_name = 'paid_call_settled'
      )
    order by settlements.created_at::timestamptz, settlements.run_id
  loop
    perform airbyte_source_private.append_agent_outcome(
      'settlement',
      v_row.run_id,
      'terminal-v1',
      v_row.flow_id::text,
      v_row.occurred_at,
      'paid_call_settled',
      'revenue',
      null,
      'settled',
      'settled',
      'terminal'
    );
  end loop;
end
$migration$;

create or replace function
  airbyte_source.read_normalized_agent_outcomes()
returns table (
  event_id text,
  occurred_at timestamp(3) with time zone,
  source_revision_at timestamp(3) with time zone,
  project_id text,
  event_name text,
  lifecycle_stage text,
  channel text,
  anonymous_person_key text,
  account_key text,
  campaign_id text,
  ad_set_id text,
  ad_id text,
  creative_id text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  click_id text,
  session_key text,
  touch_order integer,
  attribution_model text,
  plan text,
  product_version text,
  template_id text,
  experiment_id text,
  variant_id text,
  outcome text,
  state text,
  delivery_state text,
  campaign_ref text,
  lead_quality_score integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
begin
  if not pg_catalog.pg_has_role(
    session_user,
    'suede_agent_studio_airbyte_reader',
    'member'
  ) then
    raise exception 'Agent Studio Airbyte reader role is required'
      using errcode = '42501';
  end if;

  return query
  select
    events.event_id,
    events.occurred_at,
    events.source_revision_at,
    'suede-agent-studio'::text as project_id,
    events.event_name,
    events.lifecycle_stage,
    'product'::text as channel,
    null::text as anonymous_person_key,
    events.account_key,
    null::text as campaign_id,
    null::text as ad_set_id,
    null::text as ad_id,
    null::text as creative_id,
    null::text as utm_source,
    null::text as utm_medium,
    null::text as utm_campaign,
    null::text as utm_content,
    null::text as click_id,
    null::text as session_key,
    null::integer as touch_order,
    null::text as attribution_model,
    null::text as plan,
    events.product_version,
    null::text as template_id,
    null::text as experiment_id,
    null::text as variant_id,
    events.outcome,
    events.state,
    events.delivery_state,
    null::text as campaign_ref,
    null::integer as lead_quality_score
  from airbyte_source_private.agent_outcome_events as events;
end
$function$;

revoke all privileges on function
  airbyte_source.read_normalized_agent_outcomes()
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;
grant execute on function
  airbyte_source.read_normalized_agent_outcomes()
  to suede_agent_studio_airbyte_reader;

create or replace view airbyte_source.normalized_agent_outcomes
with (security_invoker = true, security_barrier = true)
as
select
  event_id,
  occurred_at::timestamp(3) with time zone as occurred_at,
  source_revision_at::timestamp(3) with time zone as source_revision_at,
  project_id,
  event_name,
  lifecycle_stage,
  channel,
  anonymous_person_key,
  account_key,
  campaign_id,
  ad_set_id,
  ad_id,
  creative_id,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_content,
  click_id,
  session_key,
  touch_order,
  attribution_model,
  plan,
  product_version,
  template_id,
  experiment_id,
  variant_id,
  outcome,
  state,
  delivery_state,
  campaign_ref,
  lead_quality_score
from airbyte_source.read_normalized_agent_outcomes();

revoke all privileges on table
  airbyte_source.normalized_agent_outcomes
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;
grant select on table
  airbyte_source.normalized_agent_outcomes
  to suede_agent_studio_airbyte_reader;

-- CREATE OR REPLACE and IF NOT EXISTS preserve existing owners and ACLs.
-- Normalize every adapter object to the migration identity, remove every
-- explicit grant (including grants to custom roles), then add back only the
-- reviewed reader capability.
alter table airbyte_source_private.agent_outcome_events
  owner to current_user;
alter sequence airbyte_source_private.agent_outcome_events_ledger_id_seq
  owner to current_user;
alter function airbyte_source_private.hmac_sha256(text, text)
  owner to current_user;
alter function airbyte_source_private.append_agent_outcome(
  text,
  text,
  text,
  text,
  timestamp with time zone,
  text,
  text,
  text,
  text,
  text,
  text
) owner to current_user;
alter function airbyte_source_private.reject_agent_outcome_mutation()
  owner to current_user;
alter function airbyte_source_private.capture_agent_outcome()
  owner to current_user;
alter function airbyte_source_private.capture_test_run_outcome()
  owner to current_user;
alter function airbyte_source_private.capture_deployment_outcome()
  owner to current_user;
alter function airbyte_source_private.capture_settlement_outcome()
  owner to current_user;
alter function airbyte_source_private.capture_settled_run_outcome()
  owner to current_user;
alter function airbyte_source.read_normalized_agent_outcomes()
  owner to current_user;
alter view airbyte_source.normalized_agent_outcomes
  owner to current_user;

revoke all privileges on schema
  airbyte_source_private,
  airbyte_source
  from public;
revoke all privileges on table
  airbyte_source_private.agent_outcome_events,
  airbyte_source.normalized_agent_outcomes
  from public;
revoke all privileges on sequence
  airbyte_source_private.agent_outcome_events_ledger_id_seq
  from public;
revoke all privileges on function
  airbyte_source_private.hmac_sha256(text, text),
  airbyte_source_private.append_agent_outcome(
    text,
    text,
    text,
    text,
    timestamp with time zone,
    text,
    text,
    text,
    text,
    text,
    text
  ),
  airbyte_source_private.reject_agent_outcome_mutation(),
  airbyte_source_private.capture_agent_outcome(),
  airbyte_source_private.capture_test_run_outcome(),
  airbyte_source_private.capture_deployment_outcome(),
  airbyte_source_private.capture_settlement_outcome(),
  airbyte_source_private.capture_settled_run_outcome(),
  airbyte_source.read_normalized_agent_outcomes()
  from public;

do $acl_reset$
declare
  v_acl record;
  v_grantee_sql text;
  v_object_group text;
begin
  for v_acl in
    select distinct
      namespaces.nspname,
      acl.grantee
    from pg_catalog.pg_namespace as namespaces
    cross join lateral pg_catalog.aclexplode(namespaces.nspacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and namespaces.nspacl is not null
      and acl.grantee <> namespaces.nspowner
  loop
    v_grantee_sql := case
      when v_acl.grantee = 0 then 'public'
      else pg_catalog.format(
        '%I',
        pg_catalog.pg_get_userbyid(v_acl.grantee)
      )
    end;
    execute pg_catalog.format(
      'revoke all privileges on schema %I from %s',
      v_acl.nspname,
      v_grantee_sql
    );
  end loop;

  for v_acl in
    select distinct
      namespaces.nspname,
      relations.relname,
      relations.relkind,
      acl.grantee
    from pg_catalog.pg_class as relations
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = relations.relnamespace
    cross join lateral pg_catalog.aclexplode(relations.relacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and relations.relacl is not null
      and relations.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and acl.grantee <> relations.relowner
  loop
    v_grantee_sql := case
      when v_acl.grantee = 0 then 'public'
      else pg_catalog.format(
        '%I',
        pg_catalog.pg_get_userbyid(v_acl.grantee)
      )
    end;
    execute pg_catalog.format(
      'revoke all privileges on %s %I.%I from %s',
      case
        when v_acl.relkind = 'S' then 'sequence'
        else 'table'
      end,
      v_acl.nspname,
      v_acl.relname,
      v_grantee_sql
    );
  end loop;

  for v_acl in
    select distinct
      namespaces.nspname,
      functions.proname,
      pg_catalog.pg_get_function_identity_arguments(
        functions.oid
      ) as identity_arguments,
      acl.grantee
    from pg_catalog.pg_proc as functions
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = functions.pronamespace
    cross join lateral pg_catalog.aclexplode(functions.proacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and functions.proacl is not null
      and acl.grantee <> functions.proowner
  loop
    v_grantee_sql := case
      when v_acl.grantee = 0 then 'public'
      else pg_catalog.format(
        '%I',
        pg_catalog.pg_get_userbyid(v_acl.grantee)
      )
    end;
    execute pg_catalog.format(
      'revoke all privileges on function %I.%I(%s) from %s',
      v_acl.nspname,
      v_acl.proname,
      v_acl.identity_arguments,
      v_grantee_sql
    );
  end loop;

  -- Remove schema-scoped custom defaults owned by this migration identity.
  -- Defaults owned by another identity are not modified; the post-apply
  -- assertion below rejects them instead.
  for v_acl in
    select distinct
      defaults.defaclrole,
      namespaces.nspname,
      defaults.defaclobjtype,
      acl.grantee
    from pg_catalog.pg_default_acl as defaults
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = defaults.defaclnamespace
    cross join lateral
      pg_catalog.aclexplode(defaults.defaclacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and defaults.defaclrole =
        (select oid from pg_catalog.pg_roles where rolname = current_user)
      and acl.grantee <> defaults.defaclrole
  loop
    v_object_group := case v_acl.defaclobjtype
      when 'r' then 'tables'
      when 'S' then 'sequences'
      when 'f' then 'functions'
      when 'T' then 'types'
      else null
    end;
    if v_object_group is null then
      raise exception 'Unsupported Agent Studio Airbyte default ACL type'
        using errcode = '42501';
    end if;
    v_grantee_sql := case
      when v_acl.grantee = 0 then 'public'
      else pg_catalog.format(
        '%I',
        pg_catalog.pg_get_userbyid(v_acl.grantee)
      )
    end;
    execute pg_catalog.format(
      'alter default privileges for role %I in schema %I revoke all privileges on %s from %s',
      pg_catalog.pg_get_userbyid(v_acl.defaclrole),
      v_acl.nspname,
      v_object_group,
      v_grantee_sql
    );
  end loop;
end
$acl_reset$;

alter default privileges in schema airbyte_source_private
  revoke all privileges on tables from public;
alter default privileges in schema airbyte_source_private
  revoke all privileges on sequences from public;
alter default privileges in schema airbyte_source_private
  revoke all privileges on functions from public;
alter default privileges in schema airbyte_source_private
  revoke all privileges on types from public;
alter default privileges in schema airbyte_source
  revoke all privileges on tables from public;
alter default privileges in schema airbyte_source
  revoke all privileges on sequences from public;
alter default privileges in schema airbyte_source
  revoke all privileges on functions from public;
alter default privileges in schema airbyte_source
  revoke all privileges on types from public;

grant usage on schema airbyte_source
  to suede_agent_studio_airbyte_reader;
grant execute on function
  airbyte_source.read_normalized_agent_outcomes()
  to suede_agent_studio_airbyte_reader;
grant select on table
  airbyte_source.normalized_agent_outcomes
  to suede_agent_studio_airbyte_reader;

-- Post-apply drift and privilege assertions. Any mismatch aborts the entire
-- transaction, including the backfill and Vault secret creation.
do $migration$
declare
  v_actual_columns text[];
  v_expected_columns constant text[] := array[
    'event_id',
    'occurred_at',
    'source_revision_at',
    'project_id',
    'event_name',
    'lifecycle_stage',
    'channel',
    'anonymous_person_key',
    'account_key',
    'campaign_id',
    'ad_set_id',
    'ad_id',
    'creative_id',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'click_id',
    'session_key',
    'touch_order',
    'attribution_model',
    'plan',
    'product_version',
    'template_id',
    'experiment_id',
    'variant_id',
    'outcome',
    'state',
    'delivery_state',
    'campaign_ref',
    'lead_quality_score'
  ];
  v_reader_oid oid;
  v_owner_oid oid;
  v_owner_super boolean;
  v_owner_createrole boolean;
  v_issue text;
  v_count integer;
begin
  select pg_catalog.array_agg(columns.column_name order by columns.ordinal_position)
  into v_actual_columns
  from information_schema.columns as columns
  where columns.table_schema = 'airbyte_source'
    and columns.table_name = 'normalized_agent_outcomes';

  if v_actual_columns is distinct from v_expected_columns then
    raise exception 'Agent Studio Airbyte view column-order drift'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from information_schema.columns as columns
    where columns.table_schema = 'airbyte_source'
      and columns.table_name = 'normalized_agent_outcomes'
      and (
        (
          columns.column_name in (
            'occurred_at',
            'source_revision_at'
          )
          and (
            columns.udt_name <> 'timestamptz'
            or columns.datetime_precision <> 3
          )
        )
        or (
          columns.column_name in (
            'touch_order',
            'lead_quality_score'
          )
          and columns.udt_name <> 'int4'
        )
        or (
          columns.column_name not in (
            'occurred_at',
            'source_revision_at',
            'touch_order',
            'lead_quality_score'
          )
          and columns.udt_name <> 'text'
        )
      )
  ) then
    raise exception 'Agent Studio Airbyte view type drift'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'airbyte_source'
      and c.relname = 'normalized_agent_outcomes'
      and c.relkind = 'v'
      and c.reloptions @> array[
        'security_invoker=true',
        'security_barrier=true'
      ]
  ) then
    raise exception
      'Agent Studio Airbyte view security options are unavailable'
      using errcode = '55000';
  end if;

  select roles.oid
  into strict v_reader_oid
  from pg_catalog.pg_roles as roles
  where roles.rolname = 'suede_agent_studio_airbyte_reader'
    and not roles.rolcanlogin
    and not roles.rolsuper
    and not roles.rolcreatedb
    and not roles.rolcreaterole
    and not roles.rolreplication
    and not roles.rolbypassrls
    and not roles.rolinherit;

  select
    roles.oid,
    roles.rolsuper,
    roles.rolcreaterole
  into strict
    v_owner_oid,
    v_owner_super,
    v_owner_createrole
  from pg_catalog.pg_roles as roles
  where roles.rolname = current_user;

  if exists (
    select 1
    from pg_catalog.pg_namespace as namespaces
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and namespaces.nspowner <> v_owner_oid
  ) or exists (
    select 1
    from pg_catalog.pg_class as relations
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = relations.relnamespace
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and relations.relowner <> v_owner_oid
  ) or exists (
    select 1
    from pg_catalog.pg_proc as functions
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = functions.pronamespace
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and functions.proowner <> v_owner_oid
  ) then
    raise exception 'Agent Studio Airbyte object-owner drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_shdepend as dependencies
    where dependencies.refclassid = 'pg_authid'::regclass
      and dependencies.refobjid = v_reader_oid
      and dependencies.deptype = 'o'
  ) then
    raise exception 'Agent Studio Airbyte reader may not own database objects'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members as memberships
    join pg_catalog.pg_roles as members
      on members.oid = memberships.member
    where memberships.roleid = v_reader_oid
      and not (
        (
          members.rolname = 'suede_agent_studio_airbyte_login'
          and not memberships.admin_option
          and memberships.inherit_option
          and not memberships.set_option
        )
        or (
          not v_owner_super
          and v_owner_createrole
          and memberships.member = v_owner_oid
          and memberships.admin_option
          and not memberships.inherit_option
          and not memberships.set_option
        )
      )
  ) or (
    not v_owner_super
    and v_owner_createrole
    and not exists (
      select 1
      from pg_catalog.pg_auth_members as memberships
      where memberships.roleid = v_reader_oid
        and memberships.member = v_owner_oid
        and memberships.admin_option
        and not memberships.inherit_option
        and not memberships.set_option
    )
  ) then
    raise exception 'Agent Studio Airbyte reader membership drift'
      using errcode = '42501';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_namespace as namespaces
  cross join lateral pg_catalog.aclexplode(namespaces.nspacl) as acl
  where namespaces.nspacl is not null
    and acl.grantee = v_reader_oid;
  if v_count <> 1 or not exists (
    select 1
    from pg_catalog.pg_namespace as namespaces
    cross join lateral pg_catalog.aclexplode(namespaces.nspacl) as acl
    where namespaces.nspname = 'airbyte_source'
      and acl.grantee = v_reader_oid
      and acl.privilege_type = 'USAGE'
      and not acl.is_grantable
  ) then
    raise exception 'Agent Studio Airbyte direct schema grants are not exact'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_namespace as namespaces
    cross join lateral pg_catalog.aclexplode(namespaces.nspacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and namespaces.nspacl is not null
      and acl.grantee <> v_owner_oid
      and not (
        namespaces.nspname = 'airbyte_source'
        and acl.grantee = v_reader_oid
        and acl.privilege_type = 'USAGE'
        and not acl.is_grantable
      )
  ) then
    raise exception 'Agent Studio Airbyte unexpected schema grantee'
      using errcode = '42501';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_class as relations
  cross join lateral pg_catalog.aclexplode(relations.relacl) as acl
  where relations.relacl is not null
    and acl.grantee = v_reader_oid;
  if v_count <> 1 or not exists (
    select 1
    from pg_catalog.pg_class as relations
    cross join lateral pg_catalog.aclexplode(relations.relacl) as acl
    where relations.oid =
      'airbyte_source.normalized_agent_outcomes'::regclass
      and acl.grantee = v_reader_oid
      and acl.privilege_type = 'SELECT'
      and not acl.is_grantable
  ) then
    raise exception 'Agent Studio Airbyte direct relation grants are not exact'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as relations
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = relations.relnamespace
    cross join lateral pg_catalog.aclexplode(relations.relacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and relations.relacl is not null
      and acl.grantee <> v_owner_oid
      and not (
        relations.oid =
          'airbyte_source.normalized_agent_outcomes'::regclass
        and acl.grantee = v_reader_oid
        and acl.privilege_type = 'SELECT'
        and not acl.is_grantable
      )
  ) then
    raise exception 'Agent Studio Airbyte unexpected relation grantee'
      using errcode = '42501';
  end if;

  if
    not pg_catalog.has_schema_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source',
      'usage'
    )
    or pg_catalog.has_schema_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source',
      'create'
    )
    or pg_catalog.has_schema_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source_private',
      'usage'
    )
    or pg_catalog.has_table_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source_private.agent_outcome_events',
      'select,insert,update,delete,truncate,references,trigger'
    )
  then
    raise exception 'Agent Studio Airbyte schema/private ACL drift'
      using errcode = '42501';
  end if;

  if
    not pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source.read_normalized_agent_outcomes()',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source_private.hmac_sha256(text,text)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source_private.append_agent_outcome(text,text,text,text,timestamp with time zone,text,text,text,text,text,text)',
      'execute'
    )
  then
    raise exception 'Agent Studio Airbyte function ACL drift'
      using errcode = '42501';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_proc as functions
  cross join lateral pg_catalog.aclexplode(functions.proacl) as acl
  where functions.proacl is not null
    and acl.grantee = v_reader_oid;
  if v_count <> 1 or not exists (
    select 1
    from pg_catalog.pg_proc as functions
    cross join lateral pg_catalog.aclexplode(functions.proacl) as acl
    where functions.oid =
      'airbyte_source.read_normalized_agent_outcomes()'::regprocedure
      and acl.grantee = v_reader_oid
      and acl.privilege_type = 'EXECUTE'
      and not acl.is_grantable
  ) then
    raise exception 'Agent Studio Airbyte direct function grants are not exact'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as functions
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = functions.pronamespace
    cross join lateral pg_catalog.aclexplode(functions.proacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and functions.proacl is not null
      and acl.grantee <> v_owner_oid
      and not (
        functions.oid =
          'airbyte_source.read_normalized_agent_outcomes()'::regprocedure
        and acl.grantee = v_reader_oid
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
      )
  ) then
    raise exception 'Agent Studio Airbyte unexpected function grantee'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl as defaults
    join pg_catalog.pg_namespace as namespaces
      on namespaces.oid = defaults.defaclnamespace
    cross join lateral
      pg_catalog.aclexplode(defaults.defaclacl) as acl
    where namespaces.nspname in (
      'airbyte_source',
      'airbyte_source_private'
    )
      and acl.grantee <> defaults.defaclrole
  ) then
    raise exception 'Agent Studio Airbyte default-ACL drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from information_schema.role_table_grants as grants
    where grants.table_schema = 'airbyte_source'
      and grants.table_name = 'normalized_agent_outcomes'
      and grants.grantee in (
        'PUBLIC',
        'anon',
        'authenticated',
        'service_role'
      )
  ) or exists (
    select 1
    from pg_catalog.pg_proc as functions
    where functions.oid in (
      'airbyte_source.read_normalized_agent_outcomes()'::regprocedure,
      'airbyte_source_private.hmac_sha256(text,text)'::regprocedure,
      'airbyte_source_private.append_agent_outcome(text,text,text,text,timestamp with time zone,text,text,text,text,text,text)'::regprocedure,
      'airbyte_source_private.capture_agent_outcome()'::regprocedure,
      'airbyte_source_private.capture_test_run_outcome()'::regprocedure,
      'airbyte_source_private.capture_deployment_outcome()'::regprocedure,
      'airbyte_source_private.capture_settlement_outcome()'::regprocedure,
      'airbyte_source_private.capture_settled_run_outcome()'::regprocedure
    )
      and (
        pg_catalog.has_function_privilege(
          'anon',
          functions.oid,
          'execute'
        )
        or pg_catalog.has_function_privilege(
          'authenticated',
          functions.oid,
          'execute'
        )
      )
  ) then
    raise exception 'Agent Studio Airbyte browser-role ACL drift'
      using errcode = '42501';
  end if;

  select c.oid::regclass::text
  into v_issue
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'airbyte_source_private'
    and c.relname = 'agent_outcome_events'
    and (
      c.relkind <> 'r'
      or c.relpersistence <> 'p'
      or not c.relrowsecurity
    );
  if v_issue is not null then
    raise exception 'Agent Studio Airbyte private ledger drift: %', v_issue
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_trigger as triggers
  where not triggers.tgisinternal
    and (
      (
        triggers.tgrelid = 'public.agents'::regclass
        and triggers.tgname = 'agent_studio_airbyte_agents'
      )
      or (
        triggers.tgrelid = 'public.runs'::regclass
        and triggers.tgname = 'agent_studio_airbyte_test_runs'
      )
      or (
        triggers.tgrelid = 'public.runs'::regclass
        and triggers.tgname = 'agent_studio_airbyte_settled_runs'
      )
      or (
        triggers.tgrelid = 'public.deployments'::regclass
        and triggers.tgname = 'agent_studio_airbyte_deployments'
      )
      or (
        triggers.tgrelid = 'public.settlements'::regclass
        and triggers.tgname = 'agent_studio_airbyte_settlements'
      )
      or (
        triggers.tgrelid =
          'airbyte_source_private.agent_outcome_events'::regclass
        and triggers.tgname = 'agent_outcome_events_append_only'
      )
    );
  if v_count <> 6 then
    raise exception 'Agent Studio Airbyte trigger drift'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from airbyte_source_private.agent_outcome_events as events
    where events.event_id !~ '^[0-9a-f]{64}$'
      or events.account_key !~ '^[0-9a-f]{64}$'
      or events.source_revision_at < events.occurred_at
      or events.occurred_at <>
        pg_catalog.date_trunc('milliseconds', events.occurred_at)
      or events.source_revision_at <>
        pg_catalog.date_trunc(
          'milliseconds',
          events.source_revision_at
        )
  ) then
    raise exception 'Agent Studio Airbyte row invariant drift'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)
  into v_count
  from vault.secrets
  where name = 'suede_agent_studio_airbyte_identity_hmac_v1';
  if v_count <> 1 then
    raise exception 'Agent Studio Airbyte Vault secret drift'
      using errcode = '55000';
  end if;
end
$migration$;

comment on role suede_agent_studio_airbyte_reader is
  'NOLOGIN capability role: reads only the privacy-safe Agent Studio Airbyte view';
comment on table airbyte_source_private.agent_outcome_events is
  'Append-only privacy-safe Agent Studio outcome ledger; no raw user, graph, output, error, wallet, payer, pay_to, transaction, or credential data';
comment on view airbyte_source.normalized_agent_outcomes is
  'Privacy-safe Agent Studio funnel outcomes for airbyte-agent-studio-outcomes/v1; source_revision_at is commit serialized';

commit;
