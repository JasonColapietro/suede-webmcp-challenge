-- Emergency write stop for Agent Studio Stripe revenue receipts.
--
-- Manual migration only. This revokes the Stripe receipt-writer capability.
-- It deliberately preserves owner adoption and its private aliases so delayed
-- webhook evidence can route correctly after writes are restored, plus the
-- receipt ledger, revenue view, Vault HMAC key, historical rows, Airbyte reader
-- contract, and the guard that makes a rollback to the legacy raw-Checkout-
-- Session writer fail closed.

begin;
set local search_path = pg_catalog, pg_temp;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'suede-agent-studio:stripe-revenue-source:v1',
    0
  )
);

do $preflight$
begin
  if pg_catalog.to_regprocedure(
    'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)'
  ) is null then
    raise exception 'Agent Studio Stripe revenue writer is unavailable'
      using errcode = '55000';
  end if;
end
$preflight$;

revoke execute on function
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
  from anon, service_role;

do $verification$
begin
  if exists (
    select 1
    from pg_catalog.unnest(
      array['anon', 'service_role']
    ) as roles(role_name)
    where pg_catalog.has_function_privilege(
      roles.role_name,
      'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
      'execute'
    )
  ) then
    raise exception 'Agent Studio Stripe runtime write stop failed'
      using errcode = '42501';
  end if;

  if
    pg_catalog.to_regclass(
      'airbyte_source_private.stripe_revenue_receipts'
    ) is null
    or pg_catalog.to_regclass(
      'airbyte_source_private.stripe_owner_adoptions'
    ) is null
    or pg_catalog.to_regclass(
      'airbyte_source.normalized_revenue_events'
    ) is null
    or pg_catalog.to_regprocedure(
      'airbyte_source.read_normalized_revenue_events()'
    ) is null
    or not pg_catalog.has_function_privilege(
      'anon',
      'public.agent_studio_adopt_owner_with_connections(text,text)',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.agent_studio_adopt_owner_with_connections(text,text)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'anon',
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    )
    or pg_catalog.has_function_privilege(
      'service_role',
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    )
    or not exists (
      select 1
      from pg_catalog.pg_trigger as triggers
      where triggers.tgrelid = 'public.credits'::regclass
        and triggers.tgname =
          'agent_studio_reject_legacy_stripe_topup'
        and not triggers.tgisinternal
        and triggers.tgenabled = 'O'
        and triggers.tgtype = 7
        and triggers.tgfoid =
          'airbyte_source_private.reject_legacy_stripe_topup_credit()'::regprocedure
    )
    or not exists (
      select 1
      from pg_catalog.pg_trigger as triggers
      where triggers.tgrelid = 'public.credits'::regclass
        and triggers.tgname =
          'agent_studio_serialize_credit_updates'
        and not triggers.tgisinternal
        and triggers.tgenabled = 'O'
        and triggers.tgtype = 18
        and triggers.tgfoid =
          'airbyte_source_private.serialize_stripe_credit_updates()'::regprocedure
    )
    or not exists (
      select 1
      from pg_catalog.pg_trigger as triggers
      where triggers.tgrelid =
          'airbyte_source_private.stripe_owner_adoptions'::regclass
        and triggers.tgname = 'stripe_owner_adoptions_append_only'
        and not triggers.tgisinternal
        and triggers.tgenabled = 'O'
        and triggers.tgfoid =
          'airbyte_source_private.reject_stripe_revenue_mutation()'::regprocedure
    )
  then
    raise exception
      'Agent Studio Stripe write stop removed retained safety state'
      using errcode = '55000';
  end if;
end
$verification$;

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
  'DISABLED: service_role runtime grant revoked; reapply the reviewed revenue migration to re-enable';

commit;
