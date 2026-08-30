-- Prepared manual input: AP2 v0.2 merchant authorization and replay ledger.
-- Subject to docs/migrations/PENDING.md: confirm the production project,
-- compare live schema, dry-run this unchanged file twice, obtain explicit
-- production approval, and archive post-apply readback. Additive only; no
-- backfill. AP2_MODE must remain off until this migration and runtime
-- readiness checks are proven.
--
-- This table is a hard pre-settlement dependency. The application must fail
-- closed on every read/write error. Only stable references, hashes, exact
-- payment terms, state, and sanitized receipt/result JSON belong here. Never
-- store raw mandates, disclosures, checkout JWTs, payment signatures,
-- authorization headers, request bodies, or risk-provider payloads.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(
  hashtextextended('suede-agent-studio:ap2-authorizations:v1', 0)
);

do $$
declare
  authorizer_security_definer boolean;
  authorizer_config text[];
begin
  if to_regprocedure('agent_studio_private.request_authorized()') is null then
    raise exception 'Agent Studio shared-runtime authorization function is missing';
  end if;

  select p.prosecdef, p.proconfig
  into authorizer_security_definer, authorizer_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'agent_studio_private'
    and p.proname = 'request_authorized'
    and p.pronargs = 0;

  if authorizer_security_definer is distinct from true
    or not (
      'search_path=pg_catalog, public, extensions'
      = any(coalesce(authorizer_config, array[]::text[]))
    ) then
    raise exception 'Agent Studio shared-runtime authorization function is not hardened';
  end if;

  if not exists (
    select 1
    from public.agent_studio_runtime_secrets
    where id = 'primary'
      and schema_revision = 'shared-runtime-v2'
      and secret_hash ~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Agent Studio shared-runtime v2 marker is missing';
  end if;

  if not has_schema_privilege('anon', 'agent_studio_private', 'usage')
    or not has_function_privilege(
      'anon',
      'agent_studio_private.request_authorized()',
      'execute'
    ) then
    raise exception 'Agent Studio shared-runtime anon authorization grant is missing';
  end if;
end
$$;

create table if not exists public.ap2_authorizations (
  id text primary key,
  mandate_reference text not null,
  payment_nonce_hash text not null,
  request_digest text not null,
  issuer text not null,
  subject_id text,
  checkout_hash text not null,
  agent_id text not null,
  flow_id text not null,
  deployment_id text not null,
  network text not null,
  asset text not null,
  amount_atomic text not null,
  amount_minor_usd bigint not null check (amount_minor_usd >= 0),
  payee_id text not null,
  pay_to text not null,
  payer text not null,
  state text not null check (state in (
    'authorized', 'settling', 'settled', 'executing', 'completed',
    'rejected', 'failed', 'pending_reconciliation'
  )),
  decision_code text,
  receipt_json jsonb,
  result_json jsonb,
  expires_at text not null,
  payment_valid_before text not null,
  run_id text,
  tx text,
  created_at text not null,
  updated_at text not null,
  constraint ap2_authorizations_mandate_reference_key
    unique (mandate_reference),
  constraint ap2_authorizations_payment_nonce_hash_key
    unique (payment_nonce_hash),
  constraint ap2_authorizations_checkout_hash_key
    unique (checkout_hash)
);
create index if not exists idx_ap2_authorizations_state_updated
  on public.ap2_authorizations (state, updated_at);
create index if not exists idx_ap2_authorizations_agent_created
  on public.ap2_authorizations (agent_id, created_at);
create index if not exists idx_ap2_authorizations_run
  on public.ap2_authorizations (run_id);

alter table public.ap2_authorizations enable row level security;

do $$
begin
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
      and columns.table_name = 'ap2_authorizations'
  ) is distinct from array[
    array['id', 'text', 'NO'],
    array['mandate_reference', 'text', 'NO'],
    array['payment_nonce_hash', 'text', 'NO'],
    array['request_digest', 'text', 'NO'],
    array['issuer', 'text', 'NO'],
    array['subject_id', 'text', 'YES'],
    array['checkout_hash', 'text', 'NO'],
    array['agent_id', 'text', 'NO'],
    array['flow_id', 'text', 'NO'],
    array['deployment_id', 'text', 'NO'],
    array['network', 'text', 'NO'],
    array['asset', 'text', 'NO'],
    array['amount_atomic', 'text', 'NO'],
    array['amount_minor_usd', 'int8', 'NO'],
    array['payee_id', 'text', 'NO'],
    array['pay_to', 'text', 'NO'],
    array['payer', 'text', 'NO'],
    array['state', 'text', 'NO'],
    array['decision_code', 'text', 'YES'],
    array['receipt_json', 'jsonb', 'YES'],
    array['result_json', 'jsonb', 'YES'],
    array['expires_at', 'text', 'NO'],
    array['payment_valid_before', 'text', 'NO'],
    array['run_id', 'text', 'YES'],
    array['tx', 'text', 'YES'],
    array['created_at', 'text', 'NO'],
    array['updated_at', 'text', 'NO']
  ]::text[][] then
    raise exception 'Agent Studio AP2 authorization column inventory drift';
  end if;

  if not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_mandate_reference_key'
      and constraints.contype = 'u'
  ) or not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_payment_nonce_hash_key'
      and constraints.contype = 'u'
  ) or not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_checkout_hash_key'
      and constraints.contype = 'u'
  ) then
    raise exception 'Agent Studio AP2 replay uniqueness constraint drift';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ap2_authorizations'
      and policyname <> 'agent_studio_server_access'
  ) then
    raise exception 'Agent Studio AP2 authorization table has unexpected RLS policies';
  end if;
end
$$;

drop policy if exists agent_studio_server_access
  on public.ap2_authorizations;
create policy agent_studio_server_access
  on public.ap2_authorizations
  for all
  to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());

revoke all privileges on table public.ap2_authorizations
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.ap2_authorizations
  to anon, service_role;
revoke delete on table public.ap2_authorizations
  from anon, service_role;

create or replace function public.agent_studio_ap2_replay_store_attestation()
returns text
language plpgsql
stable
set search_path = pg_catalog, public
as $$
begin
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
      and columns.table_name = 'ap2_authorizations'
  ) is distinct from array[
    array['id', 'text', 'NO'],
    array['mandate_reference', 'text', 'NO'],
    array['payment_nonce_hash', 'text', 'NO'],
    array['request_digest', 'text', 'NO'],
    array['issuer', 'text', 'NO'],
    array['subject_id', 'text', 'YES'],
    array['checkout_hash', 'text', 'NO'],
    array['agent_id', 'text', 'NO'],
    array['flow_id', 'text', 'NO'],
    array['deployment_id', 'text', 'NO'],
    array['network', 'text', 'NO'],
    array['asset', 'text', 'NO'],
    array['amount_atomic', 'text', 'NO'],
    array['amount_minor_usd', 'int8', 'NO'],
    array['payee_id', 'text', 'NO'],
    array['pay_to', 'text', 'NO'],
    array['payer', 'text', 'NO'],
    array['state', 'text', 'NO'],
    array['decision_code', 'text', 'YES'],
    array['receipt_json', 'jsonb', 'YES'],
    array['result_json', 'jsonb', 'YES'],
    array['expires_at', 'text', 'NO'],
    array['payment_valid_before', 'text', 'NO'],
    array['run_id', 'text', 'YES'],
    array['tx', 'text', 'YES'],
    array['created_at', 'text', 'NO'],
    array['updated_at', 'text', 'NO']
  ]::text[][] then
    return null;
  end if;

  if not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_mandate_reference_key'
      and constraints.contype = 'u'
      and pg_get_constraintdef(constraints.oid) = 'UNIQUE (mandate_reference)'
  ) or not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_payment_nonce_hash_key'
      and constraints.contype = 'u'
      and pg_get_constraintdef(constraints.oid) = 'UNIQUE (payment_nonce_hash)'
  ) or not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and constraints.conname = 'ap2_authorizations_checkout_hash_key'
      and constraints.contype = 'u'
      and pg_get_constraintdef(constraints.oid) = 'UNIQUE (checkout_hash)'
  ) then
    return null;
  end if;

  if (
    select tables.relrowsecurity
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and tables.relkind = 'r'
  ) is distinct from true or (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ap2_authorizations'
  ) <> 1 or (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ap2_authorizations'
      and policyname = 'agent_studio_server_access'
      and cmd = 'ALL'
      and roles = array['anon']::name[]
      and qual = 'agent_studio_private.request_authorized()'
      and with_check = 'agent_studio_private.request_authorized()'
  ) <> 1 then
    return null;
  end if;

  if not has_table_privilege('anon', 'public.ap2_authorizations', 'select')
    or not has_table_privilege('anon', 'public.ap2_authorizations', 'insert')
    or not has_table_privilege('anon', 'public.ap2_authorizations', 'update')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'delete')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'select')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'insert')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'update')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'delete')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'select')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'insert')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'update')
    or has_table_privilege('authenticated', 'public.ap2_authorizations', 'delete')
  then
    return null;
  end if;

  return 'ap2-replay-v2';
end;
$$;

revoke execute on function public.agent_studio_ap2_replay_store_attestation()
  from public, authenticated;
grant execute on function public.agent_studio_ap2_replay_store_attestation()
  to anon, service_role;

comment on table public.ap2_authorizations is
  'Server-held AP2 merchant authorization, replay, settlement, and fulfillment state.';
comment on policy agent_studio_server_access
  on public.ap2_authorizations is
  'Server-only AP2 ledger access through the shared-runtime request secret.';

do $$
begin
  if not (
    select tables.relrowsecurity
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'ap2_authorizations'
      and tables.relkind = 'r'
  ) then
    raise exception 'Agent Studio AP2 authorization table must have RLS enabled';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ap2_authorizations'
      and policyname = 'agent_studio_server_access'
      and cmd = 'ALL'
      and roles = array['anon']::name[]
      and qual = 'agent_studio_private.request_authorized()'
      and with_check = 'agent_studio_private.request_authorized()'
  ) <> 1 then
    raise exception 'Agent Studio AP2 authorization policy readback failed';
  end if;

  if not has_table_privilege('anon', 'public.ap2_authorizations', 'select')
    or not has_table_privilege('anon', 'public.ap2_authorizations', 'insert')
    or not has_table_privilege('anon', 'public.ap2_authorizations', 'update')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'delete')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'truncate')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'references')
    or has_table_privilege('anon', 'public.ap2_authorizations', 'trigger')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'select')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'insert')
    or not has_table_privilege('service_role', 'public.ap2_authorizations', 'update')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'delete')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'truncate')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'references')
    or has_table_privilege('service_role', 'public.ap2_authorizations', 'trigger')
    or exists (
      select 1
      from information_schema.role_table_grants grants
      where grants.table_schema = 'public'
        and grants.table_name = 'ap2_authorizations'
        and grants.grantee in ('PUBLIC', 'authenticated')
    )
  then
    raise exception 'Agent Studio AP2 authorization privilege readback failed';
  end if;

  if not has_function_privilege(
    'anon',
    'public.agent_studio_ap2_replay_store_attestation()',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.agent_studio_ap2_replay_store_attestation()',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.agent_studio_ap2_replay_store_attestation()',
    'execute'
  ) then
    raise exception 'Agent Studio AP2 readiness attestation privilege readback failed';
  end if;
end
$$;

commit;
