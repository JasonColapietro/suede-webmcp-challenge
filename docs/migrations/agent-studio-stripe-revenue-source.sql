-- Suede Agent Studio Stripe topup receipts + privacy-safe Airbyte revenue.
--
-- Manual migration only. Apply after agent-studio-airbyte-source.sql with the
-- migration identity. It creates no login and contains no credential.
--
-- Raw Stripe ids and owner ids exist only in the RLS-protected private ledger.
-- The Airbyte view exports Vault-backed HMAC references and authoritative USD
-- cents. Credits (including committed-use bonuses) are separate from cash.

begin;
set local search_path = pg_catalog, pg_temp;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'suede-agent-studio:stripe-revenue-source:v1',
    0
  )
);

do $preflight$
declare
  v_role pg_catalog.pg_roles%rowtype;
  v_migration_oid oid;
  v_migration_super boolean;
  v_migration_createrole boolean;
  v_adoption_security_definer boolean;
  v_adoption_config text[];
  v_adoption_owner oid;
  v_secret_count integer;
begin
  if
    pg_catalog.to_regclass(
      'airbyte_source_private.agent_outcome_events'
    ) is null
    or pg_catalog.to_regprocedure(
      'airbyte_source_private.hmac_sha256(text,text)'
    ) is null
    or pg_catalog.to_regprocedure(
      'agent_studio_private.request_authorized()'
    ) is null
    or pg_catalog.to_regclass('public.credits') is null
    or pg_catalog.to_regclass('public.connections') is null
    or pg_catalog.to_regprocedure(
      'public.agent_studio_adopt_owner(text,text)'
    ) is null
    or pg_catalog.to_regprocedure(
      'public.agent_studio_adopt_owner_with_connections(text,text)'
    ) is null
  then
    raise exception
      'Apply Airbyte, billing, and connection ownership migrations first'
      using errcode = '55000';
  end if;

  select roles.oid, roles.rolsuper, roles.rolcreaterole
  into strict
    v_migration_oid,
    v_migration_super,
    v_migration_createrole
  from pg_catalog.pg_roles as roles
  where roles.rolname = current_user;

  select
    functions.prosecdef,
    functions.proconfig,
    functions.proowner
  into strict
    v_adoption_security_definer,
    v_adoption_config,
    v_adoption_owner
  from pg_catalog.pg_proc as functions
  where functions.oid =
    'public.agent_studio_adopt_owner(text,text)'::regprocedure;

  if
    v_adoption_security_definer
    or v_adoption_owner <> v_migration_oid
    or not (
      'search_path=pg_catalog, public, extensions' =
        any(coalesce(v_adoption_config, array[]::text[]))
    )
  then
    raise exception 'Agent Studio base owner adoption is not hardened'
      using errcode = '42501';
  end if;

  if
    not pg_catalog.has_schema_privilege(
      current_user,
      'public',
      'usage,create'
    )
    or not pg_catalog.has_schema_privilege(
      current_user,
      'airbyte_source_private',
      'usage,create'
    )
    or not pg_catalog.has_schema_privilege(
      current_user,
      'airbyte_source',
      'usage,create'
    )
    or not pg_catalog.has_schema_privilege(
      current_user,
      'agent_studio_private',
      'usage'
    )
    or not pg_catalog.has_table_privilege(
      current_user,
      'public.credits',
      'select,insert,update,trigger'
    )
    or not pg_catalog.has_table_privilege(
      current_user,
      'public.connections',
      'update'
    )
    or not pg_catalog.has_function_privilege(
      current_user,
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'anon',
      'agent_studio_private.request_authorized()',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      current_user,
      'agent_studio_private.request_authorized()',
      'execute'
    )
  then
    raise exception
      'Agent Studio Stripe migration identity lacks required DDL/DML'
      using errcode = '42501';
  end if;

  select *
  into strict v_role
  from pg_catalog.pg_roles
  where rolname = 'suede_agent_studio_airbyte_reader';

  if
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
  then
    raise exception
      'Agent Studio Airbyte reader capability or membership is unsafe'
      using errcode = '42501';
  end if;

  if exists (
    with expected(
      column_name,
      udt_name,
      is_nullable,
      numeric_precision,
      numeric_scale
    ) as (
      values
        ('id', 'text', 'NO', null::integer, null::integer),
        ('owner_id', 'text', 'NO', null::integer, null::integer),
        ('delta_usdc', 'numeric', 'NO', 20, 8),
        ('reason', 'text', 'NO', null::integer, null::integer),
        ('tx', 'text', 'YES', null::integer, null::integer),
        ('created_at', 'text', 'NO', null::integer, null::integer)
    )
    select 1
    from expected
    left join information_schema.columns as columns
      on columns.table_schema = 'public'
     and columns.table_name = 'credits'
     and columns.column_name = expected.column_name
     and (
       expected.udt_name is null
       or columns.udt_name = expected.udt_name
     )
     and columns.is_nullable = expected.is_nullable
     and columns.numeric_precision is not distinct from
       expected.numeric_precision
     and columns.numeric_scale is not distinct from expected.numeric_scale
    where columns.column_name is null
  ) then
    raise exception 'Agent Studio credits schema drifted'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)
  into v_secret_count
  from vault.secrets
  where name = 'suede_agent_studio_airbyte_identity_hmac_v1';
  if v_secret_count <> 1 then
    raise exception 'Agent Studio Airbyte Vault identity is unavailable'
      using errcode = '55000';
  end if;
end
$preflight$;

create table if not exists
  airbyte_source_private.stripe_owner_adoptions (
    from_owner_id text primary key,
    to_owner_id text not null,
    adopted_at timestamp(3) with time zone not null,
    constraint ck_stripe_owner_adoption_from
      check (
        pg_catalog.octet_length(from_owner_id) between 1 and 512
      ),
    constraint ck_stripe_owner_adoption_to
      check (
        pg_catalog.octet_length(to_owner_id) between 1 and 512
      ),
    constraint ck_stripe_owner_adoption_distinct
      check (from_owner_id <> to_owner_id)
  );

create index if not exists
  idx_stripe_owner_adoptions_to
on airbyte_source_private.stripe_owner_adoptions (to_owner_id);

create table if not exists
  airbyte_source_private.stripe_revenue_receipts (
    receipt_id uuid primary key,
    kind text not null,
    owner_id text not null,
    provider_event_id text not null,
    provider_checkout_session_id text,
    provider_payment_intent_id text not null,
    provider_refund_id text,
    amount_total_cents bigint not null,
    currency text not null,
    terminal_status text not null,
    refund_state text not null,
    provider_product_id text,
    provider_price_id text,
    occurred_at timestamp(3) with time zone not null,
    source_revision_at timestamp(3) with time zone not null,
    credit_delta_usdc numeric(20, 8) not null,
    credit_id text not null,
    parent_receipt_id uuid,
    constraint uq_stripe_revenue_provider_event
      unique (provider_event_id),
    constraint uq_stripe_revenue_source_revision
      unique (source_revision_at),
    constraint uq_stripe_revenue_credit
      unique (credit_id),
    constraint fk_stripe_revenue_credit
      foreign key (credit_id)
      references public.credits(id)
      on delete restrict,
    constraint fk_stripe_revenue_parent
      foreign key (parent_receipt_id)
      references airbyte_source_private.stripe_revenue_receipts(receipt_id)
      on delete restrict,
    constraint ck_stripe_revenue_kind
      check (kind in ('payment', 'refund')),
    constraint ck_stripe_revenue_owner
      check (pg_catalog.octet_length(owner_id) between 1 and 512),
    constraint ck_stripe_revenue_event
      check (
        pg_catalog.octet_length(provider_event_id) between 6 and 255
        and provider_event_id ~ '^evt_[A-Za-z0-9_]+$'
      ),
    constraint ck_stripe_revenue_session
      check (
        provider_checkout_session_id is null
        or (
          pg_catalog.octet_length(provider_checkout_session_id)
            between 6 and 255
          and provider_checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
        )
      ),
    constraint ck_stripe_revenue_payment_intent
      check (
        pg_catalog.octet_length(provider_payment_intent_id)
          between 6 and 255
        and provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
      ),
    constraint ck_stripe_revenue_refund
      check (
        provider_refund_id is null
        or (
          pg_catalog.octet_length(provider_refund_id) between 6 and 255
          and provider_refund_id ~ '^re_[A-Za-z0-9_]+$'
        )
      ),
    constraint ck_stripe_revenue_amount
      check (amount_total_cents between 1 and 9007199254740991),
    constraint ck_stripe_revenue_currency
      check (currency = 'USD'),
    constraint ck_stripe_revenue_status
      check (terminal_status in ('paid', 'succeeded')),
    constraint ck_stripe_revenue_refund_state
      check (refund_state in ('none', 'partial', 'full')),
    constraint ck_stripe_revenue_product
      check (
        provider_product_id is null
        or (
          pg_catalog.octet_length(provider_product_id) between 6 and 255
          and provider_product_id ~ '^prod_[A-Za-z0-9_]+$'
        )
      ),
    constraint ck_stripe_revenue_price
      check (
        provider_price_id is null
        or (
          pg_catalog.octet_length(provider_price_id) between 7 and 255
          and provider_price_id ~ '^price_[A-Za-z0-9_]+$'
        )
      ),
    constraint ck_stripe_revenue_shape
      check (
        (
          kind = 'payment'
          and provider_checkout_session_id is not null
          and provider_refund_id is null
          and terminal_status = 'paid'
          and refund_state = 'none'
          and credit_delta_usdc > 0
          and parent_receipt_id is null
        )
        or (
          kind = 'refund'
          and provider_checkout_session_id is null
          and provider_refund_id is not null
          and terminal_status = 'succeeded'
          and refund_state in ('partial', 'full')
          and credit_delta_usdc < 0
          and parent_receipt_id is not null
        )
      )
  );

create unique index if not exists
  uq_stripe_revenue_payment_session
on airbyte_source_private.stripe_revenue_receipts (
  provider_checkout_session_id
)
where kind = 'payment';

create unique index if not exists
  uq_stripe_revenue_payment_intent
on airbyte_source_private.stripe_revenue_receipts (
  provider_payment_intent_id
)
where kind = 'payment';

create unique index if not exists
  uq_stripe_revenue_refund_id
on airbyte_source_private.stripe_revenue_receipts (
  provider_refund_id
)
where kind = 'refund';

create index if not exists
  idx_stripe_revenue_refunds_by_payment
on airbyte_source_private.stripe_revenue_receipts (
  provider_payment_intent_id,
  occurred_at,
  receipt_id
)
where kind = 'refund';

-- Keep the non-Stripe paid-entitlement branch away from the workspace's
-- lifetime model-spend ledger. Stripe rows use the receipt credit-link index.
create index if not exists
  idx_credits_paid_entitlement_non_stripe
on public.credits (owner_id)
where
  delta_usdc > 0
  and reason not in ('stripe-topup', 'stripe-refund');

alter table airbyte_source_private.stripe_revenue_receipts
  enable row level security;
alter table airbyte_source_private.stripe_owner_adoptions
  enable row level security;
revoke all privileges on table
  airbyte_source_private.stripe_revenue_receipts,
  airbyte_source_private.stripe_owner_adoptions
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

create or replace function
  airbyte_source_private.reject_stripe_revenue_mutation()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'Agent Studio private Stripe evidence is append-only'
    using errcode = '55000';
end
$function$;

revoke all privileges on function
  airbyte_source_private.reject_stripe_revenue_mutation()
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

drop trigger if exists stripe_revenue_receipts_append_only
  on airbyte_source_private.stripe_revenue_receipts;
create trigger stripe_revenue_receipts_append_only
before update or delete
on airbyte_source_private.stripe_revenue_receipts
for each row execute function
  airbyte_source_private.reject_stripe_revenue_mutation();

drop trigger if exists stripe_owner_adoptions_append_only
  on airbyte_source_private.stripe_owner_adoptions;
create trigger stripe_owner_adoptions_append_only
before update or delete
on airbyte_source_private.stripe_owner_adoptions
for each row execute function
  airbyte_source_private.reject_stripe_revenue_mutation();

create or replace function
  airbyte_source_private.reject_legacy_stripe_topup_credit()
returns trigger
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $function$
begin
  if
    new.reason = 'stripe-topup'
    and pg_catalog.left(new.tx, 3) = 'cs_'
  then
    raise exception
      'Legacy Agent Studio Stripe credit writes are disabled'
      using errcode = '55000';
  end if;
  return new;
end
$function$;

revoke all privileges on function
  airbyte_source_private.reject_legacy_stripe_topup_credit()
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

create or replace function
  airbyte_source_private.serialize_stripe_credit_updates()
returns trigger
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $function$
begin
  if not pg_catalog.pg_try_advisory_xact_lock(1987202607, 31) then
    raise exception
      'Retry Agent Studio credit-owner update after Stripe mutation'
      using errcode = '40001';
  end if;
  return null;
end
$function$;

revoke all privileges on function
  airbyte_source_private.serialize_stripe_credit_updates()
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

do $legacy_write_guard$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger as triggers
    where triggers.tgrelid = 'public.credits'::regclass
      and triggers.tgname = 'agent_studio_reject_legacy_stripe_topup'
      and not triggers.tgisinternal
  ) then
    create trigger agent_studio_reject_legacy_stripe_topup
    before insert
    on public.credits
    for each row execute function
      airbyte_source_private.reject_legacy_stripe_topup_credit();
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as triggers
    where triggers.tgrelid = 'public.credits'::regclass
      and triggers.tgname = 'agent_studio_serialize_credit_updates'
      and not triggers.tgisinternal
  ) then
    create trigger agent_studio_serialize_credit_updates
    before update
    on public.credits
    for each statement execute function
      airbyte_source_private.serialize_stripe_credit_updates();
  end if;
end
$legacy_write_guard$;

-- VOLATILE is intentional: a writer can begin its statement while adoption
-- holds the shared lock. After the writer acquires that lock, the resolver
-- must take a fresh READ COMMITTED snapshot and observe the committed alias.
create or replace function
  airbyte_source_private.resolve_stripe_owner(
    p_owner_id text
  )
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_current text := p_owner_id;
  v_next text;
  v_seen text[] := array[p_owner_id];
begin
  if
    p_owner_id is null
    or pg_catalog.octet_length(p_owner_id) not between 1 and 512
  then
    raise exception 'Invalid Agent Studio Stripe owner'
      using errcode = '22023';
  end if;

  for v_depth in 1..32 loop
    select adoptions.to_owner_id
    into v_next
    from airbyte_source_private.stripe_owner_adoptions as adoptions
    where adoptions.from_owner_id = v_current;
    if not found then
      return v_current;
    end if;
    if v_next = any(v_seen) then
      raise exception 'Agent Studio Stripe owner adoption cycle'
        using errcode = '23514';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_next);
    v_current := v_next;
  end loop;

  raise exception 'Agent Studio Stripe owner adoption chain is too deep'
    using errcode = '54001';
end
$function$;

revoke all privileges on function
  airbyte_source_private.resolve_stripe_owner(text)
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

-- Keep Stripe ownership and alias resolution in a private domain helper. The
-- public workspace wrapper below composes this helper with any optional domain
-- helper installed by another prepared migration, without mutable rereads or
-- migration-order replacement.
create or replace function
  airbyte_source_private.agent_studio_adopt_stripe_owner(
    p_from_owner_id text,
    p_to_owner_id text
  )
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_existing_target text;
  v_existing_effective_target text;
  v_effective_target text;
  v_target_depth integer;
  v_ancestor_depth integer;
  v_ancestor_cycle boolean;
  v_alias_exists boolean;
begin
  if coalesce(
    nullif(
      pg_catalog.current_setting(
        'request.jwt.claim.role',
        true
      ),
      ''
    ),
    (
      coalesce(
        nullif(
          pg_catalog.current_setting(
            'request.jwt.claims',
            true
          ),
          ''
        ),
        '{}'
      )::jsonb ->> 'role'
    ),
    ''
  ) <> 'service_role' then
    if not agent_studio_private.request_authorized() then
      raise exception 'Agent Studio owner adoption is unauthorized'
        using errcode = '42501';
    end if;
  end if;

  if
    p_from_owner_id is null
    or p_to_owner_id is null
    or pg_catalog.octet_length(p_from_owner_id) not between 1 and 512
    or pg_catalog.octet_length(p_to_owner_id) not between 1 and 512
  then
    raise exception 'Invalid Agent Studio owner adoption'
      using errcode = '22023';
  end if;
  if p_from_owner_id = p_to_owner_id then
    return p_to_owner_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(1987202607, 31);

  select adoptions.to_owner_id
  into v_existing_target
  from airbyte_source_private.stripe_owner_adoptions as adoptions
  where adoptions.from_owner_id = p_from_owner_id
  for update;
  v_alias_exists := found;

  v_effective_target :=
    airbyte_source_private.resolve_stripe_owner(p_to_owner_id);
  if v_effective_target = p_from_owner_id then
    raise exception 'Agent Studio owner adoption would create a cycle'
      using errcode = '23514';
  end if;

  if v_alias_exists then
    v_existing_effective_target :=
      airbyte_source_private.resolve_stripe_owner(v_existing_target);
    if v_existing_effective_target <> v_effective_target then
      raise exception 'Conflicting Agent Studio owner adoption'
        using errcode = '23505';
    end if;
  else
    with recursive target_chain(owner_id, depth) as (
      values (p_to_owner_id, 0)
      union all
      select
        adoptions.to_owner_id,
        target_chain.depth + 1
      from target_chain
      join airbyte_source_private.stripe_owner_adoptions as adoptions
        on adoptions.from_owner_id = target_chain.owner_id
      where target_chain.depth < 31
    )
    select coalesce(pg_catalog.max(target_chain.depth), 0)
    into v_target_depth
    from target_chain;

    with recursive ancestors(
      owner_id,
      depth,
      path,
      cycle_detected
    ) as (
      values (
        p_from_owner_id,
        0,
        array[p_from_owner_id]::text[],
        false
      )
      union all
      select
        adoptions.from_owner_id,
        ancestors.depth + 1,
        pg_catalog.array_append(
          ancestors.path,
          adoptions.from_owner_id
        ),
        adoptions.from_owner_id = any(ancestors.path)
      from ancestors
      join airbyte_source_private.stripe_owner_adoptions as adoptions
        on adoptions.to_owner_id = ancestors.owner_id
      where
        not ancestors.cycle_detected
        and ancestors.depth < 32
    )
    select
      coalesce(pg_catalog.max(ancestors.depth), 0),
      coalesce(pg_catalog.bool_or(ancestors.cycle_detected), false)
    into v_ancestor_depth, v_ancestor_cycle
    from ancestors;

    if
      v_ancestor_cycle
      or v_ancestor_depth + 1 + v_target_depth > 31
    then
      raise exception 'Agent Studio owner adoption chain is too deep'
        using errcode = '54001';
    end if;
  end if;

  perform public.agent_studio_adopt_owner(
    p_from_owner_id,
    v_effective_target
  );
  update public.connections as connection
  set
    owner_id = v_effective_target,
    lifecycle_revision = connection.lifecycle_revision + 1,
    updated_at = greatest(
      connection.updated_at + 1,
      pg_catalog.floor(
        pg_catalog.date_part(
          'epoch',
          pg_catalog.clock_timestamp()
        ) * 1000
      )::bigint
    )
  where connection.owner_id = p_from_owner_id;

  if not v_alias_exists then
    insert into airbyte_source_private.stripe_owner_adoptions (
      from_owner_id,
      to_owner_id,
      adopted_at
    ) values (
      p_from_owner_id,
      p_to_owner_id,
      pg_catalog.date_trunc(
        'milliseconds',
        pg_catalog.clock_timestamp()
      )
    );
  end if;
  return v_effective_target;
end
$function$;

revoke all privileges on function
  airbyte_source_private.agent_studio_adopt_stripe_owner(text, text)
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

-- Extend the already-deployed atomic workspace adoption so a Checkout Session
-- opened under anonymous owner A can still credit the canonical owner when its
-- signed payment webhook arrives after adoption. Resource is optional at this
-- migration boundary, so resolve its helper by prepared immutable definition
-- inside this same database transaction rather than overwriting its behavior.
create or replace function
  public.agent_studio_adopt_owner_with_connections(
    p_from_owner_id text,
    p_to_owner_id text
  )
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_effective_target text;
begin
  v_effective_target :=
    airbyte_source_private.agent_studio_adopt_stripe_owner(
      p_from_owner_id,
      p_to_owner_id
    );
  if pg_catalog.to_regprocedure(
    'public.agent_studio_adopt_resource_owner(text,text)'
  ) is not null then
    execute
      'select public.agent_studio_adopt_resource_owner($1,$2)'
      using p_from_owner_id,v_effective_target;
  end if;
end
$function$;

revoke all privileges on function
  public.agent_studio_adopt_owner_with_connections(text, text)
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;
grant execute on function
  public.agent_studio_adopt_owner_with_connections(text, text)
  to anon, service_role;
revoke all privileges on function
  public.agent_studio_adopt_owner(text, text)
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

create or replace function
  public.agent_studio_record_stripe_revenue_event(
    p_kind text,
    p_provider_event_id text,
    p_owner_id text,
    p_checkout_session_id text,
    p_payment_intent_id text,
    p_refund_id text,
    p_amount_total_cents bigint,
    p_currency text,
    p_terminal_status text,
    p_product_id text,
    p_price_id text,
    p_occurred_at timestamp with time zone,
    p_credit_grant_usdc numeric
  )
returns table (
  recorded boolean,
  credit_delta_usdc numeric,
  refund_state text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_existing airbyte_source_private.stripe_revenue_receipts%rowtype;
  v_payment airbyte_source_private.stripe_revenue_receipts%rowtype;
  v_receipt_id uuid;
  v_credit_id text;
  v_source_revision_at timestamp(3) with time zone;
  v_occurred_at timestamp(3) with time zone;
  v_prior_refund_cents bigint;
  v_prior_reversed_credit numeric(20, 8);
  v_refunded_cents bigint;
  v_target_reversed_credit numeric(20, 8);
  v_credit_delta numeric(20, 8);
  v_refund_state text;
  v_payment_owner_id text;
  v_payment_credit_owner_id text;
  v_payment_credit_delta public.credits.delta_usdc%type;
  v_payment_credit_reason text;
  v_payment_credit_tx text;
begin
  if coalesce(
    nullif(
      pg_catalog.current_setting(
        'request.jwt.claim.role',
        true
      ),
      ''
    ),
    (
      coalesce(
        nullif(
          pg_catalog.current_setting(
            'request.jwt.claims',
            true
          ),
          ''
        ),
        '{}'
      )::jsonb ->> 'role'
    ),
    ''
  ) <> 'service_role' then
    if not agent_studio_private.request_authorized() then
      raise exception 'Agent Studio Stripe writer is unauthorized'
        using errcode = '42501';
    end if;
  end if;

  if
    p_kind not in ('payment', 'refund')
    or p_provider_event_id is null
    or pg_catalog.octet_length(p_provider_event_id) not between 6 and 255
    or p_provider_event_id !~ '^evt_[A-Za-z0-9_]+$'
    or p_payment_intent_id is null
    or pg_catalog.octet_length(p_payment_intent_id) not between 6 and 255
    or p_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    or p_amount_total_cents not between 1 and 9007199254740991
    or p_currency <> 'USD'
    or p_occurred_at is null
    or p_occurred_at <> pg_catalog.date_trunc('milliseconds', p_occurred_at)
    or p_occurred_at < '2000-01-01 00:00:00+00'::timestamptz
    or p_occurred_at > pg_catalog.clock_timestamp() + interval '5 minutes'
  then
    raise exception 'Invalid Agent Studio Stripe revenue evidence'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(1987202607, 31);
  v_occurred_at := p_occurred_at;

  if p_kind = 'payment' then
    if
      p_owner_id is null
      or pg_catalog.octet_length(p_owner_id) not between 1 and 512
      or p_checkout_session_id is null
      or pg_catalog.octet_length(p_checkout_session_id)
        not between 6 and 255
      or p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
      or p_refund_id is not null
      or p_terminal_status <> 'paid'
      or p_credit_grant_usdc is null
      or p_credit_grant_usdc <= 0
      or pg_catalog.round(p_credit_grant_usdc, 8) <= 0
      or p_credit_grant_usdc >
        (p_amount_total_cents::numeric / 100) * 1.2
      or (
        p_product_id is not null
        and (
          pg_catalog.octet_length(p_product_id) not between 6 and 255
          or p_product_id !~ '^prod_[A-Za-z0-9_]+$'
        )
      )
      or (
        p_price_id is not null
        and (
          pg_catalog.octet_length(p_price_id) not between 7 and 255
          or p_price_id !~ '^price_[A-Za-z0-9_]+$'
        )
      )
    then
      raise exception 'Invalid Agent Studio Stripe payment receipt'
        using errcode = '22023';
    end if;

    v_payment_owner_id :=
      airbyte_source_private.resolve_stripe_owner(p_owner_id);

    select receipts.*
    into v_existing
    from airbyte_source_private.stripe_revenue_receipts as receipts
    where receipts.kind = 'payment'
      and receipts.provider_checkout_session_id = p_checkout_session_id;

    if found then
      if
        airbyte_source_private.resolve_stripe_owner(
          v_existing.owner_id
        ) <> v_payment_owner_id
        or v_existing.provider_payment_intent_id <> p_payment_intent_id
        or v_existing.amount_total_cents <> p_amount_total_cents
        or v_existing.currency <> p_currency
        or v_existing.terminal_status <> p_terminal_status
        or v_existing.provider_product_id is distinct from p_product_id
        or v_existing.provider_price_id is distinct from p_price_id
        or v_existing.credit_delta_usdc <>
          pg_catalog.round(p_credit_grant_usdc, 8)
        or exists (
          select 1
          from airbyte_source_private.stripe_revenue_receipts as receipts
          where receipts.provider_event_id = p_provider_event_id
            and receipts.receipt_id <> v_existing.receipt_id
        )
      then
        raise exception 'Conflicting Agent Studio Stripe payment replay'
          using errcode = '23505';
      end if;
      return query select
        false,
        v_existing.credit_delta_usdc,
        v_existing.refund_state;
      return;
    end if;

    if exists (
      select 1
      from airbyte_source_private.stripe_revenue_receipts as receipts
      where receipts.provider_event_id = p_provider_event_id
        or (
          receipts.kind = 'payment'
          and receipts.provider_payment_intent_id = p_payment_intent_id
        )
    ) then
      raise exception 'Conflicting Agent Studio Stripe payment identity'
        using errcode = '23505';
    end if;

    select greatest(
      pg_catalog.date_trunc(
        'milliseconds',
        pg_catalog.clock_timestamp()
      ),
      v_occurred_at,
      coalesce(
        pg_catalog.max(receipts.source_revision_at)
          + interval '1 millisecond',
        '2000-01-01 00:00:00+00'::timestamptz
      )
    )
    into strict v_source_revision_at
    from airbyte_source_private.stripe_revenue_receipts as receipts;

    v_receipt_id := extensions.gen_random_uuid();
    v_credit_id := extensions.gen_random_uuid()::text;
    v_credit_delta := pg_catalog.round(p_credit_grant_usdc, 8);

    insert into public.credits (
      id,
      owner_id,
      delta_usdc,
      reason,
      tx,
      created_at
    ) values (
      v_credit_id,
      v_payment_owner_id,
      v_credit_delta,
      'stripe-topup',
      'stripe-receipt:' || v_receipt_id::text,
      pg_catalog.to_char(
        v_source_revision_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );

    insert into airbyte_source_private.stripe_revenue_receipts (
      receipt_id,
      kind,
      owner_id,
      provider_event_id,
      provider_checkout_session_id,
      provider_payment_intent_id,
      provider_refund_id,
      amount_total_cents,
      currency,
      terminal_status,
      refund_state,
      provider_product_id,
      provider_price_id,
      occurred_at,
      source_revision_at,
      credit_delta_usdc,
      credit_id,
      parent_receipt_id
    ) values (
      v_receipt_id,
      'payment',
      v_payment_owner_id,
      p_provider_event_id,
      p_checkout_session_id,
      p_payment_intent_id,
      null,
      p_amount_total_cents,
      p_currency,
      'paid',
      'none',
      p_product_id,
      p_price_id,
      v_occurred_at,
      v_source_revision_at,
      v_credit_delta,
      v_credit_id,
      null
    );

    return query select true, v_credit_delta, 'none'::text;
    return;
  end if;

  if
    p_owner_id is not null
    or p_checkout_session_id is not null
    or p_refund_id is null
    or pg_catalog.octet_length(p_refund_id) not between 6 and 255
    or p_refund_id !~ '^re_[A-Za-z0-9_]+$'
    or p_terminal_status <> 'succeeded'
    or p_product_id is not null
    or p_price_id is not null
    or p_credit_grant_usdc is not null
  then
    raise exception 'Invalid Agent Studio Stripe refund receipt'
      using errcode = '22023';
  end if;

  select receipts.*
  into v_existing
  from airbyte_source_private.stripe_revenue_receipts as receipts
  where receipts.kind = 'refund'
    and receipts.provider_refund_id = p_refund_id;

  if found then
    if
      v_existing.provider_payment_intent_id <> p_payment_intent_id
      or v_existing.amount_total_cents <> p_amount_total_cents
      or v_existing.currency <> p_currency
      or v_existing.terminal_status <> p_terminal_status
      or exists (
        select 1
        from airbyte_source_private.stripe_revenue_receipts as receipts
        where receipts.provider_event_id = p_provider_event_id
          and receipts.receipt_id <> v_existing.receipt_id
      )
    then
      raise exception 'Conflicting Agent Studio Stripe refund replay'
        using errcode = '23505';
    end if;
    return query select
      false,
      v_existing.credit_delta_usdc,
      v_existing.refund_state;
    return;
  end if;

  if exists (
    select 1
    from airbyte_source_private.stripe_revenue_receipts as receipts
    where receipts.provider_event_id = p_provider_event_id
  ) then
    raise exception 'Conflicting Agent Studio Stripe refund identity'
      using errcode = '23505';
  end if;

  select receipts.*
  into v_payment
  from airbyte_source_private.stripe_revenue_receipts as receipts
  where receipts.kind = 'payment'
    and receipts.provider_payment_intent_id = p_payment_intent_id
  for update;

  if not found then
    -- This account is shared with other products and webhook delivery order is
    -- not guaranteed. Return a no-write "unmatched" shape so the application
    -- can inspect the PaymentIntent product tag: unrelated refunds are
    -- acknowledged, while Agent Studio refunds remain retryable.
    return query select false, 0::numeric, 'none'::text;
    return;
  end if;
  if v_payment.currency <> p_currency then
    raise exception 'Stripe refund currency conflicts with its payment'
      using errcode = '22023';
  end if;

  select
    credits.owner_id,
    credits.delta_usdc,
    credits.reason,
    credits.tx
  into
    v_payment_credit_owner_id,
    v_payment_credit_delta,
    v_payment_credit_reason,
    v_payment_credit_tx
  from public.credits as credits
  where credits.id = v_payment.credit_id
  for update;

  if
    not found
    or pg_catalog.octet_length(v_payment_credit_owner_id)
      not between 1 and 512
    or v_payment_credit_delta is distinct from
      v_payment.credit_delta_usdc
    or v_payment_credit_reason <> 'stripe-topup'
    or v_payment_credit_tx <> (
      'stripe-receipt:' || v_payment.receipt_id::text
    )
  then
    raise exception 'Stripe payment credit linkage is invalid'
      using errcode = '55000';
  end if;

  select
    coalesce(pg_catalog.sum(receipts.amount_total_cents), 0),
    coalesce(pg_catalog.sum(-receipts.credit_delta_usdc), 0)
  into
    v_prior_refund_cents,
    v_prior_reversed_credit
  from airbyte_source_private.stripe_revenue_receipts as receipts
  where receipts.kind = 'refund'
    and receipts.parent_receipt_id = v_payment.receipt_id;

  v_refunded_cents := v_prior_refund_cents + p_amount_total_cents;
  if v_refunded_cents > v_payment.amount_total_cents then
    raise exception 'Stripe refunds exceed the recorded payment'
      using errcode = '22023';
  end if;

  if v_refunded_cents = v_payment.amount_total_cents then
    v_refund_state := 'full';
    v_target_reversed_credit := v_payment.credit_delta_usdc;
  else
    v_refund_state := 'partial';
    v_target_reversed_credit := pg_catalog.round(
      v_payment.credit_delta_usdc
        * v_refunded_cents::numeric
        / v_payment.amount_total_cents::numeric,
      8
    );
  end if;
  v_credit_delta := -pg_catalog.round(
    v_target_reversed_credit - v_prior_reversed_credit,
    8
  );
  if v_credit_delta >= 0 then
    raise exception 'Stripe refund credit reversal is invalid'
      using errcode = '22023';
  end if;

  select greatest(
    pg_catalog.date_trunc(
      'milliseconds',
      pg_catalog.clock_timestamp()
    ),
    v_occurred_at,
    coalesce(
      pg_catalog.max(receipts.source_revision_at)
        + interval '1 millisecond',
      '2000-01-01 00:00:00+00'::timestamptz
    )
  )
  into strict v_source_revision_at
  from airbyte_source_private.stripe_revenue_receipts as receipts;

  v_receipt_id := extensions.gen_random_uuid();
  v_credit_id := extensions.gen_random_uuid()::text;

  insert into public.credits (
    id,
    owner_id,
    delta_usdc,
    reason,
    tx,
    created_at
  ) values (
    v_credit_id,
    v_payment_credit_owner_id,
    v_credit_delta,
    'stripe-refund',
    'stripe-receipt:' || v_receipt_id::text,
    pg_catalog.to_char(
      v_source_revision_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );

  insert into airbyte_source_private.stripe_revenue_receipts (
    receipt_id,
    kind,
    owner_id,
    provider_event_id,
    provider_checkout_session_id,
    provider_payment_intent_id,
    provider_refund_id,
    amount_total_cents,
    currency,
    terminal_status,
    refund_state,
    provider_product_id,
    provider_price_id,
    occurred_at,
    source_revision_at,
    credit_delta_usdc,
    credit_id,
    parent_receipt_id
  ) values (
    v_receipt_id,
    'refund',
    v_payment.owner_id,
    p_provider_event_id,
    null,
    p_payment_intent_id,
    p_refund_id,
    p_amount_total_cents,
    p_currency,
    'succeeded',
    v_refund_state,
    v_payment.provider_product_id,
    v_payment.provider_price_id,
    v_occurred_at,
    v_source_revision_at,
    v_credit_delta,
    v_credit_id,
    v_payment.receipt_id
  );

  return query select true, v_credit_delta, v_refund_state;
end
$function$;

revoke all privileges on function
  public.agent_studio_record_stripe_revenue_event(
    text,
    text,
    text,
    text,
    text,
    text,
    bigint,
    text,
    text,
    text,
    text,
    timestamp with time zone,
    numeric
  )
  from public, anon, authenticated,
    suede_agent_studio_airbyte_reader, service_role;
grant execute on function
  public.agent_studio_record_stripe_revenue_event(
    text,
    text,
    text,
    text,
    text,
    text,
    bigint,
    text,
    text,
    text,
    text,
    timestamp with time zone,
    numeric
  )
  to anon, service_role;

-- Server-only paid entitlement aggregate. Returning one boolean avoids
-- exporting the credit ledger on the funded-model hot path. Gateway spend is
-- deliberately ignored; only a full Stripe refund can erase Stripe-derived
-- payment evidence.
create or replace function
  public.agent_studio_has_paid_entitlement(
    p_owner_id text
  )
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_paid boolean;
begin
  if coalesce(
    nullif(
      pg_catalog.current_setting(
        'request.jwt.claim.role',
        true
      ),
      ''
    ),
    (
      coalesce(
        nullif(
          pg_catalog.current_setting(
            'request.jwt.claims',
            true
          ),
          ''
        ),
        '{}'
      )::jsonb ->> 'role'
    ),
    ''
  ) <> 'service_role' then
    if not agent_studio_private.request_authorized() then
      raise exception 'Agent Studio paid entitlement is unauthorized'
        using errcode = '42501';
    end if;
  end if;

  if
    p_owner_id is null
    or pg_catalog.octet_length(p_owner_id) not between 1 and 512
  then
    raise exception 'Invalid Agent Studio paid-entitlement owner'
      using errcode = '22023';
  end if;

  select
    exists (
      select 1
      from public.credits as credits
      where credits.owner_id = p_owner_id
        and credits.delta_usdc > 0
        and credits.reason not in ('stripe-topup', 'stripe-refund')
        and not exists (
          select 1
          from airbyte_source_private.stripe_revenue_receipts as receipts
          where receipts.credit_id = credits.id
        )
    )
    or coalesce(
      (
        select pg_catalog.sum(receipts.credit_delta_usdc)
        from airbyte_source_private.stripe_revenue_receipts as receipts
        join public.credits as credits
          on credits.id = receipts.credit_id
        where credits.owner_id = p_owner_id
      ),
      0::numeric
    ) > 0
  into v_paid;

  return v_paid;
end
$function$;

revoke all privileges on function
  public.agent_studio_has_paid_entitlement(text)
  from public, anon, authenticated,
    suede_agent_studio_airbyte_reader, service_role;
grant execute on function
  public.agent_studio_has_paid_entitlement(text)
  to anon, service_role;

-- Owner-only historical bridge. It accepts exactly two already-verified paid
-- $5 USD sessions, associates their existing stripe-topup credit rows, moves
-- raw session ids out of public.credits.tx, and appends private receipts.
-- No role receives EXECUTE. Supply the JSON only through a protected,
-- parameterized migration session; never paste it into a dashboard/editor.
create or replace function
  airbyte_source_private.backfill_two_verified_stripe_topups(
    p_request jsonb
  )
returns table (
  backfilled_count integer,
  total_amount_cents bigint
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $function$
declare
  v_row record;
  v_credit record;
  v_existing airbyte_source_private.stripe_revenue_receipts%rowtype;
  v_receipt_id uuid;
  v_source_revision_at timestamp(3) with time zone;
  v_inserted integer := 0;
begin
  if
    pg_catalog.jsonb_typeof(p_request) <> 'object'
    or p_request->>'schema_version' <> '1'
    or p_request->>'project_id' <> 'suede-agent-studio'
    or p_request->>'expected_event_count' <> '2'
    or p_request->>'expected_total_amount_cents' <> '1000'
    or pg_catalog.jsonb_typeof(p_request->'events') <> 'array'
    or pg_catalog.jsonb_array_length(p_request->'events') <> 2
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_request) as keys(key)
      where keys.key not in (
        'schema_version',
        'project_id',
        'expected_event_count',
        'expected_total_amount_cents',
        'events'
      )
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        p_request->'events'
      ) as events(event)
      where pg_catalog.jsonb_typeof(events.event) <> 'object'
        or (
          select pg_catalog.count(*)
          from pg_catalog.jsonb_object_keys(events.event)
        ) <> 12
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(events.event) as keys(key)
          where keys.key not in (
            'slot',
            'provider_event_id',
            'owner_id',
            'provider_checkout_session_id',
            'provider_payment_intent_id',
            'amount_total_cents',
            'currency',
            'terminal_status',
            'refund_state',
            'provider_product_id',
            'provider_price_id',
            'occurred_at'
          )
        )
    )
  then
    raise exception 'Invalid Agent Studio Stripe backfill envelope'
      using errcode = '22023';
  end if;

  if (
    select pg_catalog.array_agg((event->>'slot')::integer order by (event->>'slot')::integer)
    from pg_catalog.jsonb_array_elements(p_request->'events') as events(event)
  ) is distinct from array[1, 2] then
    raise exception 'Stripe backfill requires slots 1 and 2'
      using errcode = '22023';
  end if;

  if
    (
      select pg_catalog.count(distinct event->>'provider_event_id')
      from pg_catalog.jsonb_array_elements(
        p_request->'events'
      ) as events(event)
    ) <> 2
    or (
      select pg_catalog.count(
        distinct event->>'provider_checkout_session_id'
      )
      from pg_catalog.jsonb_array_elements(
        p_request->'events'
      ) as events(event)
    ) <> 2
    or (
      select pg_catalog.count(
        distinct event->>'provider_payment_intent_id'
      )
      from pg_catalog.jsonb_array_elements(
        p_request->'events'
      ) as events(event)
    ) <> 2
  then
    raise exception 'Stripe backfill requires two distinct transactions'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(1987202607, 31);

  for v_row in
    select
      (event->>'slot')::integer as slot,
      event->>'provider_event_id' as provider_event_id,
      event->>'owner_id' as owner_id,
      event->>'provider_checkout_session_id' as checkout_session_id,
      event->>'provider_payment_intent_id' as payment_intent_id,
      (event->>'amount_total_cents')::bigint as amount_total_cents,
      event->>'currency' as currency,
      event->>'terminal_status' as terminal_status,
      event->>'refund_state' as refund_state,
      nullif(event->>'provider_product_id', '') as product_id,
      nullif(event->>'provider_price_id', '') as price_id,
      (event->>'occurred_at')::timestamptz as occurred_at
    from pg_catalog.jsonb_array_elements(p_request->'events') as events(event)
    order by
      (event->>'occurred_at')::timestamptz,
      event->>'provider_checkout_session_id'
  loop
    if
      v_row.slot is null
      or v_row.provider_event_id is null
      or v_row.owner_id is null
      or v_row.checkout_session_id is null
      or v_row.payment_intent_id is null
      or v_row.amount_total_cents is null
      or v_row.currency is null
      or v_row.terminal_status is null
      or v_row.refund_state is null
      or v_row.occurred_at is null
      or v_row.amount_total_cents <> 500
      or v_row.currency <> 'USD'
      or v_row.terminal_status <> 'paid'
      or v_row.refund_state <> 'none'
      or v_row.provider_event_id !~ '^evt_[A-Za-z0-9_]+$'
      or v_row.checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
      or v_row.payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
      or pg_catalog.octet_length(v_row.owner_id) not between 1 and 512
      or v_row.occurred_at <>
        pg_catalog.date_trunc('milliseconds', v_row.occurred_at)
      or v_row.occurred_at < '2000-01-01 00:00:00+00'::timestamptz
      or v_row.occurred_at >
        pg_catalog.clock_timestamp() + interval '5 minutes'
      or (
        v_row.product_id is not null
        and v_row.product_id !~ '^prod_[A-Za-z0-9_]+$'
      )
      or (
        v_row.price_id is not null
        and v_row.price_id !~ '^price_[A-Za-z0-9_]+$'
      )
    then
      raise exception 'Invalid verified $5 Stripe backfill row'
        using errcode = '22023';
    end if;

    select receipts.*
    into v_existing
    from airbyte_source_private.stripe_revenue_receipts as receipts
    where receipts.kind = 'payment'
      and receipts.provider_checkout_session_id = v_row.checkout_session_id;

    if found then
      select
        credits.id,
        credits.owner_id,
        credits.delta_usdc,
        credits.reason,
        credits.tx
      into v_credit
      from public.credits as credits
      where credits.id = v_existing.credit_id
      for update;

      if
        not found
        or v_existing.owner_id <> v_row.owner_id
        or v_existing.provider_event_id <> v_row.provider_event_id
        or v_existing.provider_checkout_session_id <>
          v_row.checkout_session_id
        or v_existing.provider_payment_intent_id <> v_row.payment_intent_id
        or v_existing.amount_total_cents <> 500
        or v_existing.currency <> 'USD'
        or v_existing.terminal_status <> 'paid'
        or v_existing.refund_state <> 'none'
        or v_existing.provider_product_id is distinct from v_row.product_id
        or v_existing.provider_price_id is distinct from v_row.price_id
        or v_existing.occurred_at is distinct from v_row.occurred_at
        or v_existing.provider_refund_id is not null
        or v_existing.parent_receipt_id is not null
        or v_credit.id is distinct from v_existing.credit_id
        or v_credit.reason <> 'stripe-topup'
        or pg_catalog.round(v_credit.delta_usdc::numeric, 8)
          is distinct from v_existing.credit_delta_usdc
        or v_credit.tx <> (
          'stripe-receipt:' || v_existing.receipt_id::text
        )
      then
        raise exception 'Conflicting Stripe backfill replay'
          using errcode = '23505';
      end if;
      continue;
    end if;

    select credits.id, credits.delta_usdc
    into strict v_credit
    from public.credits as credits
    where credits.owner_id = v_row.owner_id
      and credits.tx = v_row.checkout_session_id
      and credits.reason = 'stripe-topup'
      and credits.delta_usdc > 0
    for update;

    if v_credit.delta_usdc::numeric >
      (v_row.amount_total_cents::numeric / 100) * 1.2
    then
      raise exception 'Legacy Stripe credit exceeds the paid amount ceiling'
        using errcode = '22023';
    end if;

    select greatest(
      pg_catalog.date_trunc(
        'milliseconds',
        pg_catalog.clock_timestamp()
      ),
      v_row.occurred_at,
      coalesce(
        pg_catalog.max(receipts.source_revision_at)
          + interval '1 millisecond',
        '2000-01-01 00:00:00+00'::timestamptz
      )
    )
    into strict v_source_revision_at
    from airbyte_source_private.stripe_revenue_receipts as receipts;

    v_receipt_id := extensions.gen_random_uuid();
    insert into airbyte_source_private.stripe_revenue_receipts (
      receipt_id,
      kind,
      owner_id,
      provider_event_id,
      provider_checkout_session_id,
      provider_payment_intent_id,
      provider_refund_id,
      amount_total_cents,
      currency,
      terminal_status,
      refund_state,
      provider_product_id,
      provider_price_id,
      occurred_at,
      source_revision_at,
      credit_delta_usdc,
      credit_id,
      parent_receipt_id
    ) values (
      v_receipt_id,
      'payment',
      v_row.owner_id,
      v_row.provider_event_id,
      v_row.checkout_session_id,
      v_row.payment_intent_id,
      null,
      500,
      'USD',
      'paid',
      'none',
      v_row.product_id,
      v_row.price_id,
      v_row.occurred_at,
      v_source_revision_at,
      pg_catalog.round(v_credit.delta_usdc::numeric, 8),
      v_credit.id,
      null
    );

    update public.credits
    set tx = 'stripe-receipt:' || v_receipt_id::text
    where id = v_credit.id
      and tx = v_row.checkout_session_id;
    if not found then
      raise exception 'Legacy Stripe credit changed during backfill'
        using errcode = '40001';
    end if;
    v_inserted := v_inserted + 1;
  end loop;

  if (
    select pg_catalog.count(*)
    from airbyte_source_private.stripe_revenue_receipts as receipts
    join pg_catalog.jsonb_array_elements(p_request->'events') as events(event)
      on receipts.kind = 'payment'
     and receipts.provider_checkout_session_id =
       events.event->>'provider_checkout_session_id'
    where receipts.amount_total_cents = 500
      and receipts.currency = 'USD'
      and receipts.terminal_status = 'paid'
  ) <> 2 then
    raise exception 'Stripe backfill did not reconcile exactly two sessions'
      using errcode = '55000';
  end if;

  return query select v_inserted, 1000::bigint;
end
$function$;

revoke all privileges on function
  airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;

create or replace function
  airbyte_source.read_normalized_revenue_events()
returns table (
  event_id text,
  occurred_at timestamp(3) with time zone,
  source_revision_at timestamp(3) with time zone,
  project_id text,
  event_name text,
  currency text,
  gross_amount_cents bigint,
  net_amount_cents bigint,
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
  external_transaction_ref text,
  status text,
  refund_state text,
  subscription_state text,
  product_id text,
  price_id text,
  settlement_state text
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
    raise exception 'Agent Studio Airbyte revenue reader role is required'
      using errcode = '42501';
  end if;

  return query
  select
    airbyte_source_private.hmac_sha256(
      'stripe:event:agent_studio_receipt',
      receipts.provider_event_id
    ) as event_id,
    receipts.occurred_at,
    receipts.source_revision_at,
    'suede-agent-studio'::text as project_id,
    case receipts.kind
      when 'payment' then 'payment_succeeded'
      else 'payment_refunded'
    end::text as event_name,
    receipts.currency,
    case receipts.kind
      when 'payment' then receipts.amount_total_cents
      else -receipts.amount_total_cents
    end as gross_amount_cents,
    case receipts.kind
      when 'payment' then receipts.amount_total_cents
      else -receipts.amount_total_cents
    end as net_amount_cents,
    null::text as anonymous_person_key,
    airbyte_source_private.hmac_sha256(
      'stripe:account:agent_studio_owner',
      receipts.owner_id
    ) as account_key,
    null::text as campaign_id,
    null::text as ad_set_id,
    null::text as ad_id,
    null::text as creative_id,
    null::text as utm_source,
    null::text as utm_medium,
    null::text as utm_campaign,
    null::text as utm_content,
    null::text as click_id,
    airbyte_source_private.hmac_sha256(
      'stripe:transaction:agent_studio',
      case receipts.kind
        when 'payment' then receipts.provider_checkout_session_id
        else receipts.provider_refund_id
      end
    ) as external_transaction_ref,
    case receipts.kind
      when 'payment' then 'succeeded'
      else 'refunded'
    end::text as status,
    receipts.refund_state,
    null::text as subscription_state,
    case
      when receipts.provider_product_id is null then null
      else airbyte_source_private.hmac_sha256(
        'stripe:product:agent_studio',
        receipts.provider_product_id
      )
    end::text as product_id,
    case
      when receipts.provider_price_id is null then null
      else airbyte_source_private.hmac_sha256(
        'stripe:price:agent_studio',
        receipts.provider_price_id
      )
    end::text as price_id,
    'settled'::text as settlement_state
  from airbyte_source_private.stripe_revenue_receipts as receipts;
end
$function$;

revoke all privileges on function
  airbyte_source.read_normalized_revenue_events()
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;
grant execute on function
  airbyte_source.read_normalized_revenue_events()
  to suede_agent_studio_airbyte_reader;

create or replace view airbyte_source.normalized_revenue_events
with (security_invoker = true, security_barrier = true)
as
select
  event_id,
  occurred_at::timestamp(3) with time zone as occurred_at,
  source_revision_at::timestamp(3) with time zone as source_revision_at,
  project_id,
  event_name,
  currency,
  gross_amount_cents,
  net_amount_cents,
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
  external_transaction_ref,
  status,
  refund_state,
  subscription_state,
  product_id,
  price_id,
  settlement_state
from airbyte_source.read_normalized_revenue_events();

revoke all privileges on table
  airbyte_source.normalized_revenue_events
  from public, anon, authenticated, service_role,
    suede_agent_studio_airbyte_reader;
grant select on table
  airbyte_source.normalized_revenue_events
  to suede_agent_studio_airbyte_reader;

alter table airbyte_source_private.stripe_revenue_receipts
  owner to current_user;
alter table airbyte_source_private.stripe_owner_adoptions
  owner to current_user;
alter function
  airbyte_source_private.reject_stripe_revenue_mutation()
  owner to current_user;
alter function
  airbyte_source_private.reject_legacy_stripe_topup_credit()
  owner to current_user;
alter function
  airbyte_source_private.serialize_stripe_credit_updates()
  owner to current_user;
alter function
  airbyte_source_private.resolve_stripe_owner(text)
  owner to current_user;
alter function
  airbyte_source_private.agent_studio_adopt_stripe_owner(text, text)
  owner to current_user;
alter function
  airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)
  owner to current_user;
alter function
  public.agent_studio_record_stripe_revenue_event(
    text,
    text,
    text,
    text,
    text,
    text,
    bigint,
    text,
    text,
    text,
    text,
    timestamp with time zone,
    numeric
  )
  owner to current_user;
alter function
  public.agent_studio_has_paid_entitlement(text)
  owner to current_user;
alter function
  public.agent_studio_adopt_owner_with_connections(text, text)
  owner to current_user;
alter function
  airbyte_source.read_normalized_revenue_events()
  owner to current_user;
alter view airbyte_source.normalized_revenue_events
  owner to current_user;

do $verification$
declare
  v_columns text[];
  v_reader_oid oid;
  v_anon_oid oid;
  v_service_oid oid;
  v_owner_oid oid;
  v_owner_super boolean;
  v_owner_createrole boolean;
  v_count integer;
  v_issue text;
begin
  select pg_catalog.array_agg(columns.column_name order by columns.ordinal_position)
  into v_columns
  from information_schema.columns as columns
  where columns.table_schema = 'airbyte_source'
    and columns.table_name = 'normalized_revenue_events';

  if v_columns is distinct from array[
    'event_id',
    'occurred_at',
    'source_revision_at',
    'project_id',
    'event_name',
    'currency',
    'gross_amount_cents',
    'net_amount_cents',
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
    'external_transaction_ref',
    'status',
    'refund_state',
    'subscription_state',
    'product_id',
    'price_id',
    'settlement_state'
  ]::text[] then
    raise exception 'Agent Studio revenue view column drift'
      using errcode = '55000';
  end if;

  select pg_catalog.string_agg(
    columns.column_name || ':' || columns.udt_name || ':' ||
      coalesce(columns.datetime_precision::text, '-'),
    ',' order by columns.ordinal_position
  )
  into v_issue
    from information_schema.columns as columns
    where columns.table_schema = 'airbyte_source'
      and columns.table_name = 'normalized_revenue_events'
      and (
        (
          columns.column_name in ('occurred_at', 'source_revision_at')
          and (
            columns.udt_name <> 'timestamptz'
            or columns.datetime_precision <> 3
          )
        )
        or (
          columns.column_name in (
            'gross_amount_cents',
            'net_amount_cents'
          )
          and columns.udt_name <> 'int8'
        )
        or (
          columns.column_name not in (
            'occurred_at',
            'source_revision_at',
            'gross_amount_cents',
            'net_amount_cents'
          )
          and columns.udt_name <> 'text'
        )
      );
  if v_issue is not null then
    raise exception 'Agent Studio revenue view type drift: %', v_issue
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class as relations
    where relations.oid =
      'airbyte_source.normalized_revenue_events'::regclass
      and relations.relkind = 'v'
      and relations.reloptions @> array[
        'security_invoker=true',
        'security_barrier=true'
      ]
  ) then
    raise exception 'Agent Studio revenue view security drift'
      using errcode = '42501';
  end if;

  select roles.oid
  into strict v_reader_oid
  from pg_catalog.pg_roles as roles
  where roles.rolname = 'suede_agent_studio_airbyte_reader';
  select roles.oid, roles.rolsuper, roles.rolcreaterole
  into strict v_owner_oid, v_owner_super, v_owner_createrole
  from pg_catalog.pg_roles as roles
  where roles.rolname = current_user;
  select roles.oid
  into strict v_anon_oid
  from pg_catalog.pg_roles as roles
  where roles.rolname = 'anon';
  select roles.oid
  into strict v_service_oid
  from pg_catalog.pg_roles as roles
  where roles.rolname = 'service_role';

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_class as indexes
  join pg_catalog.pg_namespace as namespaces
    on namespaces.oid = indexes.relnamespace
  join pg_catalog.pg_index as definitions
    on definitions.indexrelid = indexes.oid
  where namespaces.nspname = 'public'
    and definitions.indrelid = 'public.credits'::regclass
    and definitions.indisvalid
    and definitions.indisready
    and not definitions.indisunique
    and definitions.indexprs is null
    and definitions.indpred is not null
    and indexes.relowner = v_owner_oid
    and indexes.relname = 'idx_credits_paid_entitlement_non_stripe'
    and definitions.indnkeyatts = 1
    and definitions.indnatts = 1
    and pg_catalog.pg_get_indexdef(
      indexes.oid,
      1,
      true
    ) = 'owner_id'
    and pg_catalog.strpos(
      pg_catalog.pg_get_expr(
        definitions.indpred,
        definitions.indrelid
      ),
      'delta_usdc >'
    ) > 0
    and pg_catalog.strpos(
      pg_catalog.pg_get_expr(
        definitions.indpred,
        definitions.indrelid
      ),
      'reason'
    ) > 0
    and pg_catalog.strpos(
      pg_catalog.pg_get_expr(
        definitions.indpred,
        definitions.indrelid
      ),
      'stripe-topup'
    ) > 0
    and pg_catalog.strpos(
      pg_catalog.pg_get_expr(
        definitions.indpred,
        definitions.indrelid
      ),
      'stripe-refund'
    ) > 0;
  if v_count <> 1 then
    raise exception 'Agent Studio paid-entitlement index drift'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_class as indexes
  join pg_catalog.pg_namespace as namespaces
    on namespaces.oid = indexes.relnamespace
  join pg_catalog.pg_index as definitions
    on definitions.indexrelid = indexes.oid
  where namespaces.nspname = 'airbyte_source_private'
    and definitions.indrelid =
      'airbyte_source_private.stripe_owner_adoptions'::regclass
    and definitions.indisvalid
    and definitions.indisready
    and not definitions.indisunique
    and definitions.indexprs is null
    and definitions.indpred is null
    and indexes.relowner = v_owner_oid
    and indexes.relname = 'idx_stripe_owner_adoptions_to'
    and definitions.indnkeyatts = 1
    and definitions.indnatts = 1
    and pg_catalog.pg_get_indexdef(
      indexes.oid,
      1,
      true
    ) = 'to_owner_id';
  if v_count <> 1 then
    raise exception 'Agent Studio owner-adoption index drift'
      using errcode = '55000';
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
    raise exception 'Agent Studio Airbyte revenue reader membership drift'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class as relations
    where relations.oid =
      'airbyte_source_private.stripe_revenue_receipts'::regclass
      and relations.relkind = 'r'
      and relations.relpersistence = 'p'
      and relations.relrowsecurity
      and relations.relowner = v_owner_oid
  ) then
    raise exception 'Agent Studio private revenue ledger drift'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class as relations
    where relations.oid =
      'airbyte_source_private.stripe_owner_adoptions'::regclass
      and relations.relkind = 'r'
      and relations.relpersistence = 'p'
      and relations.relrowsecurity
      and relations.relowner = v_owner_oid
  ) then
    raise exception 'Agent Studio private owner-adoption ledger drift'
      using errcode = '55000';
  end if;

  perform airbyte_source_private.resolve_stripe_owner(
    adoptions.from_owner_id
  )
  from airbyte_source_private.stripe_owner_adoptions as adoptions;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_trigger as triggers
  where triggers.tgrelid =
      'airbyte_source_private.stripe_revenue_receipts'::regclass
    and triggers.tgname = 'stripe_revenue_receipts_append_only'
    and not triggers.tgisinternal
    and triggers.tgenabled = 'O';
  if v_count <> 1 then
    raise exception 'Agent Studio revenue append-only trigger drift'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_trigger as triggers
  where triggers.tgrelid =
      'airbyte_source_private.stripe_owner_adoptions'::regclass
    and triggers.tgname = 'stripe_owner_adoptions_append_only'
    and not triggers.tgisinternal
    and triggers.tgenabled = 'O'
    and triggers.tgfoid =
      'airbyte_source_private.reject_stripe_revenue_mutation()'::regprocedure;
  if v_count <> 1 then
    raise exception 'Agent Studio owner-adoption append-only trigger drift'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_trigger as triggers
  where triggers.tgrelid = 'public.credits'::regclass
    and triggers.tgname = 'agent_studio_reject_legacy_stripe_topup'
    and not triggers.tgisinternal
    and triggers.tgenabled = 'O'
    and triggers.tgtype = 7
    and triggers.tgfoid =
      'airbyte_source_private.reject_legacy_stripe_topup_credit()'::regprocedure;
  if v_count <> 1 then
    raise exception 'Agent Studio legacy Stripe write guard drift'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_trigger as triggers
  where triggers.tgrelid = 'public.credits'::regclass
    and triggers.tgname = 'agent_studio_serialize_credit_updates'
    and not triggers.tgisinternal
    and triggers.tgenabled = 'O'
    and triggers.tgtype = 18
    and triggers.tgfoid =
      'airbyte_source_private.serialize_stripe_credit_updates()'::regprocedure;
  if v_count <> 1 then
    raise exception 'Agent Studio Stripe owner serialization drift'
      using errcode = '55000';
  end if;

  if
    not pg_catalog.has_table_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source.normalized_revenue_events',
      'select'
    )
    or not pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source.read_normalized_revenue_events()',
      'execute'
    )
    or pg_catalog.has_table_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source_private.stripe_revenue_receipts',
      'select,insert,update,delete,truncate,references,trigger'
    )
    or pg_catalog.has_table_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source_private.stripe_owner_adoptions',
      'select,insert,update,delete,truncate,references,trigger'
    )
    or pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'airbyte_source_private.hmac_sha256(text,text)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'public.agent_studio_has_paid_entitlement(text)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'suede_agent_studio_airbyte_reader',
      'public.agent_studio_adopt_owner_with_connections(text,text)',
      'execute'
    )
  then
    raise exception 'Agent Studio revenue reader boundary drift'
      using errcode = '42501';
  end if;

  if
    not pg_catalog.has_function_privilege(
      'service_role',
      'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.agent_studio_has_paid_entitlement(text)',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.agent_studio_adopt_owner_with_connections(text,text)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'service_role',
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    )
    or pg_catalog.has_table_privilege(
      'service_role',
      'airbyte_source.normalized_revenue_events',
      'select'
    )
    or pg_catalog.has_function_privilege(
      'service_role',
      'airbyte_source.read_normalized_revenue_events()',
      'execute'
    )
    or pg_catalog.has_table_privilege(
      'service_role',
      'airbyte_source_private.stripe_revenue_receipts',
      'select,insert,update,delete,truncate,references,trigger'
    )
    or pg_catalog.has_table_privilege(
      'service_role',
      'airbyte_source_private.stripe_owner_adoptions',
      'select,insert,update,delete,truncate,references,trigger'
    )
    or pg_catalog.has_function_privilege(
      'service_role',
      'airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)',
      'execute'
    )
  then
    raise exception 'Agent Studio revenue service boundary drift'
      using errcode = '42501';
  end if;

  if
    not pg_catalog.has_function_privilege(
      'anon',
      'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'anon',
      'public.agent_studio_has_paid_entitlement(text)',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'anon',
      'public.agent_studio_adopt_owner_with_connections(text,text)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'anon',
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    )
    or pg_catalog.has_table_privilege(
      'anon',
      'airbyte_source.normalized_revenue_events',
      'select'
    )
    or pg_catalog.has_function_privilege(
      'anon',
      'airbyte_source.read_normalized_revenue_events()',
      'execute'
    )
    or pg_catalog.has_table_privilege(
      'anon',
      'airbyte_source_private.stripe_revenue_receipts',
      'select,insert,update,delete,truncate,references,trigger'
    )
    or pg_catalog.has_table_privilege(
      'anon',
      'airbyte_source_private.stripe_owner_adoptions',
      'select,insert,update,delete,truncate,references,trigger'
    )
    or pg_catalog.has_function_privilege(
      'anon',
      'airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)',
      'execute'
    )
  then
    raise exception 'Agent Studio revenue protected-anon boundary drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as relations
    cross join lateral pg_catalog.aclexplode(
      coalesce(relations.relacl, '{}'::aclitem[])
    ) as acl
    where relations.oid in (
      'airbyte_source.normalized_revenue_events'::regclass,
      'airbyte_source_private.stripe_revenue_receipts'::regclass,
      'airbyte_source_private.stripe_owner_adoptions'::regclass
    )
      and acl.grantee <> v_owner_oid
      and not (
        relations.oid =
          'airbyte_source.normalized_revenue_events'::regclass
        and acl.grantee = v_reader_oid
        and acl.privilege_type = 'SELECT'
        and not acl.is_grantable
      )
  ) then
    raise exception 'Agent Studio revenue relation has unexpected grantee'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as functions
    cross join lateral pg_catalog.aclexplode(
      coalesce(functions.proacl, '{}'::aclitem[])
    ) as acl
    where functions.oid in (
      'airbyte_source.read_normalized_revenue_events()'::regprocedure,
      'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)'::regprocedure,
      'public.agent_studio_has_paid_entitlement(text)'::regprocedure,
      'public.agent_studio_adopt_owner_with_connections(text,text)'::regprocedure,
      'public.agent_studio_adopt_owner(text,text)'::regprocedure,
      'airbyte_source_private.resolve_stripe_owner(text)'::regprocedure,
      'airbyte_source_private.agent_studio_adopt_stripe_owner(text,text)'::regprocedure,
      'airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)'::regprocedure,
      'airbyte_source_private.reject_stripe_revenue_mutation()'::regprocedure,
      'airbyte_source_private.reject_legacy_stripe_topup_credit()'::regprocedure,
      'airbyte_source_private.serialize_stripe_credit_updates()'::regprocedure
    )
      and acl.grantee <> v_owner_oid
      and not (
        functions.oid =
          'airbyte_source.read_normalized_revenue_events()'::regprocedure
        and acl.grantee = v_reader_oid
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
      )
      and not (
        functions.oid =
          'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)'::regprocedure
        and acl.grantee in (v_anon_oid, v_service_oid)
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
      )
      and not (
        functions.oid =
          'public.agent_studio_has_paid_entitlement(text)'::regprocedure
        and acl.grantee in (v_anon_oid, v_service_oid)
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
      )
      and not (
        functions.oid =
          'public.agent_studio_adopt_owner_with_connections(text,text)'::regprocedure
        and acl.grantee in (v_anon_oid, v_service_oid)
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
      )
  ) then
    raise exception 'Agent Studio revenue function has unexpected grantee'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(
      array['authenticated']
    ) as roles(role_name)
    where pg_catalog.has_table_privilege(
        roles.role_name,
        'airbyte_source.normalized_revenue_events',
        'select'
      )
      or pg_catalog.has_table_privilege(
        roles.role_name,
        'airbyte_source_private.stripe_revenue_receipts',
        'select,insert,update,delete'
      )
      or pg_catalog.has_table_privilege(
        roles.role_name,
        'airbyte_source_private.stripe_owner_adoptions',
        'select,insert,update,delete'
      )
      or pg_catalog.has_function_privilege(
        roles.role_name,
        'airbyte_source.read_normalized_revenue_events()',
        'execute'
      )
      or pg_catalog.has_function_privilege(
        roles.role_name,
        'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
        'execute'
      )
      or pg_catalog.has_function_privilege(
        roles.role_name,
        'public.agent_studio_has_paid_entitlement(text)',
        'execute'
      )
      or pg_catalog.has_function_privilege(
        roles.role_name,
        'public.agent_studio_adopt_owner_with_connections(text,text)',
        'execute'
      )
      or pg_catalog.has_function_privilege(
        roles.role_name,
        'public.agent_studio_adopt_owner(text,text)',
        'execute'
      )
      or pg_catalog.has_function_privilege(
        roles.role_name,
        'airbyte_source_private.resolve_stripe_owner(text)',
        'execute'
      )
      or pg_catalog.has_function_privilege(
        roles.role_name,
        'airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)',
        'execute'
      )
  ) then
    raise exception 'Agent Studio revenue browser/public ACL drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as relations
    cross join lateral pg_catalog.aclexplode(
      coalesce(relations.relacl, '{}'::aclitem[])
    ) as acl
    where relations.oid in (
      'airbyte_source.normalized_revenue_events'::regclass,
      'airbyte_source_private.stripe_revenue_receipts'::regclass,
      'airbyte_source_private.stripe_owner_adoptions'::regclass
    )
      and acl.grantee = 0
  ) or exists (
    select 1
    from pg_catalog.pg_proc as functions
    cross join lateral pg_catalog.aclexplode(
      coalesce(functions.proacl, '{}'::aclitem[])
    ) as acl
    where functions.oid in (
      'airbyte_source.read_normalized_revenue_events()'::regprocedure,
      'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)'::regprocedure,
      'public.agent_studio_has_paid_entitlement(text)'::regprocedure,
      'public.agent_studio_adopt_owner_with_connections(text,text)'::regprocedure,
      'public.agent_studio_adopt_owner(text,text)'::regprocedure,
      'airbyte_source_private.resolve_stripe_owner(text)'::regprocedure,
      'airbyte_source_private.agent_studio_adopt_stripe_owner(text,text)'::regprocedure,
      'airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)'::regprocedure,
      'airbyte_source_private.reject_legacy_stripe_topup_credit()'::regprocedure,
      'airbyte_source_private.serialize_stripe_credit_updates()'::regprocedure
    )
      and acl.grantee = 0
  ) then
    raise exception 'Agent Studio revenue PUBLIC ACL drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as functions
    where functions.oid in (
      'airbyte_source.read_normalized_revenue_events()'::regprocedure,
      'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)'::regprocedure,
      'public.agent_studio_has_paid_entitlement(text)'::regprocedure,
      'public.agent_studio_adopt_owner_with_connections(text,text)'::regprocedure,
      'airbyte_source_private.resolve_stripe_owner(text)'::regprocedure,
      'airbyte_source_private.agent_studio_adopt_stripe_owner(text,text)'::regprocedure,
      'airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)'::regprocedure
    )
      and (
        not functions.prosecdef
        or (
          select setting
          from pg_catalog.unnest(
            coalesce(functions.proconfig, '{}'::text[])
          ) as setting
          where setting like 'search_path=%'
        ) is distinct from 'search_path=pg_catalog, pg_temp'
        or (
          select setting
          from pg_catalog.unnest(
            coalesce(functions.proconfig, '{}'::text[])
          ) as setting
          where setting like 'row_security=%'
        ) is distinct from 'row_security=off'
      )
  ) then
    raise exception 'Agent Studio revenue function hardening drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as functions
    where functions.oid =
      'public.agent_studio_adopt_owner(text,text)'::regprocedure
      and (
        functions.prosecdef
        or functions.proowner <> v_owner_oid
        or (
          select setting
          from pg_catalog.unnest(
            coalesce(functions.proconfig, '{}'::text[])
          ) as setting
          where setting like 'search_path=%'
        ) is distinct from
          'search_path=pg_catalog, public, extensions'
      )
  ) then
    raise exception 'Agent Studio base adoption hardening drift'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc as functions
    where functions.oid =
      'airbyte_source_private.resolve_stripe_owner(text)'::regprocedure
      and functions.provolatile = 'v'
  ) then
    raise exception 'Agent Studio Stripe owner resolver volatility drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as functions
    where functions.oid in (
      'airbyte_source_private.reject_legacy_stripe_topup_credit()'::regprocedure,
      'airbyte_source_private.serialize_stripe_credit_updates()'::regprocedure
    )
      and (
        functions.prosecdef
        or (
          select setting
          from pg_catalog.unnest(
            coalesce(functions.proconfig, '{}'::text[])
          ) as setting
          where setting like 'search_path=%'
        ) is distinct from 'search_path=pg_catalog, pg_temp'
      )
  ) then
    raise exception 'Agent Studio legacy Stripe guard hardening drift'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from airbyte_source_private.stripe_revenue_receipts as receipts
    where receipts.currency <> 'USD'
      or receipts.occurred_at <>
        pg_catalog.date_trunc('milliseconds', receipts.occurred_at)
      or receipts.source_revision_at <>
        pg_catalog.date_trunc(
          'milliseconds',
          receipts.source_revision_at
        )
      or receipts.source_revision_at < receipts.occurred_at
  ) then
    raise exception 'Agent Studio revenue row invariant drift'
      using errcode = '55000';
  end if;
end
$verification$;

comment on table
  airbyte_source_private.stripe_revenue_receipts is
  'Append-only raw Stripe topup/refund evidence; private owner/provider ids never leave this table';
comment on table
  airbyte_source_private.stripe_owner_adoptions is
  'Append-only private owner aliases for delayed Stripe webhook routing; never exported';
comment on function
  public.agent_studio_record_stripe_revenue_event(
    text,
    text,
    text,
    text,
    text,
    text,
    bigint,
    text,
    text,
    text,
    text,
    timestamp with time zone,
    numeric
  ) is
  'Server-only atomic Stripe receipt plus gateway-credit mutation; anon requires the Agent Studio request secret';
comment on function
  public.agent_studio_has_paid_entitlement(text) is
  'Server-only boolean paid-entitlement aggregate; full Stripe refunds revoke Stripe-derived eligibility';
comment on function
  public.agent_studio_adopt_owner_with_connections(text, text) is
  'Server-only atomic owner adoption composed across Stripe, connections, credits, aliases, and optional Resource rows';
comment on function
  airbyte_source_private.agent_studio_adopt_stripe_owner(text, text) is
  'Private canonical Stripe owner adoption helper; called only by the public composed adoption wrapper';
comment on view airbyte_source.normalized_revenue_events is
  '26-column Stripe-only USD-cent revenue adapter with Vault HMAC references';

commit;
