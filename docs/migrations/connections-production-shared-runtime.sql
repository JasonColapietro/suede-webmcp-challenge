-- Hosted connection persistence for the temporary shared Supabase runtime.
--
-- Production reaches PostgREST as `anon` plus the server-only
-- x-agent-studio-secret header. The existing request_authorized() policy is the
-- credential boundary; direct browser requests remain outside it. Slot values
-- are AES-256-GCM envelopes only. The encryption key never enters this database.

begin;
set local search_path = public, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('suede-agent-studio:connections-shared-runtime-v1', 0));

do $$
declare
  authorizer_security_definer boolean;
  authorizer_config text[];
  adoption_security_definer boolean;
  adoption_config text[];
  adoption_owner oid;
  trusted_owner oid;
begin
  if to_regprocedure('agent_studio_private.request_authorized()') is null then
    raise exception 'Agent Studio shared-runtime authorization function is missing';
  end if;
  select functions.prosecdef, functions.proconfig
  into authorizer_security_definer, authorizer_config
  from pg_proc functions
  join pg_namespace schemas on schemas.oid = functions.pronamespace
  where schemas.nspname = 'agent_studio_private'
    and functions.proname = 'request_authorized'
    and functions.pronargs = 0;
  if authorizer_security_definer is distinct from true
    or not (
      'search_path=pg_catalog, public, extensions'
      = any(coalesce(authorizer_config, array[]::text[]))
    ) then
    raise exception 'Agent Studio shared-runtime authorization function is not hardened';
  end if;
  if not has_schema_privilege('anon', 'agent_studio_private', 'usage')
    or not has_function_privilege(
      'anon',
      'agent_studio_private.request_authorized()',
      'execute'
    ) then
    raise exception 'Agent Studio shared-runtime anon authorization grant is missing';
  end if;
  if to_regprocedure('public.agent_studio_adopt_owner(text,text)') is null then
    raise exception 'Agent Studio owner-adoption function is missing';
  end if;
  select functions.prosecdef, functions.proconfig, functions.proowner
  into adoption_security_definer, adoption_config, adoption_owner
  from pg_proc functions
  join pg_namespace schemas on schemas.oid = functions.pronamespace
  where schemas.nspname = 'public'
    and functions.proname = 'agent_studio_adopt_owner'
    and functions.proargtypes = '25 25'::oidvector;
  select tables.relowner into trusted_owner
  from pg_class tables
  join pg_namespace schemas on schemas.oid = tables.relnamespace
  where schemas.nspname = 'public'
    and tables.relname = 'agent_studio_runtime_secrets'
    and tables.relkind = 'r';
  if adoption_security_definer is distinct from false
    or not (
      'search_path=pg_catalog, public, extensions'
      = any(coalesce(adoption_config, array[]::text[]))
    )
    or adoption_owner is distinct from trusted_owner then
    raise exception 'Agent Studio owner-adoption function is not hardened';
  end if;
  if not has_function_privilege(
      'anon',
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.agent_studio_adopt_owner(text,text)',
      'execute'
    ) then
    raise exception 'Agent Studio owner-adoption runtime grant is not hardened';
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
  if (to_regclass('public.connections') is null) <> (to_regclass('public.connection_slots') is null) then
    raise exception 'Agent Studio connection table set is partial';
  end if;
end
$$;

create or replace function public.agent_studio_connection_public_config_valid(
  p_kind text,
  p_config jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
declare
  item jsonb;
  header_name text;
  previous_folded text := null;
begin
  if jsonb_typeof(p_config) <> 'object' then return false; end if;
  if p_kind in ('bearer', 'basic') then return p_config = '{}'::jsonb; end if;

  if p_kind = 'api_key' then
    header_name := p_config ->> 'headerName';
    return coalesce(p_config = jsonb_build_object('headerName', header_name)
      and octet_length(header_name) between 1 and 64
      and header_name ~ '^[!#$%&''*+\-.^_`|~0-9A-Za-z]{1,64}$'
      and lower(header_name) <> all(array[
        'host','cookie','set-cookie','proxy-authorization',
        'connection','keep-alive','proxy-authenticate','proxy-connection','te',
        'trailer','transfer-encoding','upgrade','__proto__','prototype','constructor'
      ]::text[]), false);
  end if;

  if p_kind <> 'custom_headers'
    or jsonb_typeof(p_config -> 'headerNames') <> 'array'
    or p_config <> jsonb_build_object('headerNames', p_config -> 'headerNames')
    or jsonb_array_length(p_config -> 'headerNames') not between 1 and 16 then
    return false;
  end if;

  for item in select value from jsonb_array_elements(p_config -> 'headerNames') loop
    if jsonb_typeof(item) <> 'string' then return false; end if;
    header_name := item #>> '{}';
    if octet_length(header_name) not between 1 and 64
      or header_name !~ '^[!#$%&''*+\-.^_`|~0-9A-Za-z]{1,64}$'
      or lower(header_name) = any(array[
        'host','cookie','set-cookie','proxy-authorization',
        'connection','keep-alive','proxy-authenticate','proxy-connection','te',
        'trailer','transfer-encoding','upgrade','__proto__','prototype','constructor'
      ]::text[])
      or (previous_folded is not null and previous_folded >= lower(header_name)) then
      return false;
    end if;
    previous_folded := lower(header_name);
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create table if not exists public.connections (
  id uuid constraint connections_pkey primary key,
  owner_id text not null constraint connections_owner_id_check
    check (char_length(owner_id) between 1 and 512),
  crypto_owner_id text not null constraint connections_crypto_owner_id_check
    check (char_length(crypto_owner_id) between 1 and 512),
  name text not null constraint connections_name_check
    check (octet_length(name) between 1 and 120 and name = btrim(name)),
  kind text not null constraint connections_kind_check
    check (kind in ('api_key', 'bearer', 'basic', 'custom_headers')),
  public_config jsonb not null constraint connections_public_config_check
    check (octet_length(public_config::text) between 2 and 32768
      and public.agent_studio_connection_public_config_valid(kind, public_config)),
  schema_version smallint not null constraint connections_schema_version_check
    check (schema_version = 1),
  lifecycle_revision bigint not null constraint connections_lifecycle_revision_check
    check (lifecycle_revision between 1 and 9007199254740991),
  created_at bigint not null constraint connections_created_at_check
    check (created_at between 0 and 9007199254740991),
  updated_at bigint not null constraint connections_updated_at_check
    check (updated_at between created_at and 9007199254740991)
);

create table if not exists public.connection_slots (
  connection_id uuid not null,
  environment text not null constraint connection_slots_environment_check
    check (environment in ('test', 'live')),
  status text not null constraint connection_slots_status_check
    check (status in ('configured', 'revoked')),
  secret_version bigint not null constraint connection_slots_secret_version_check
    check (secret_version between 1 and 9007199254740991),
  key_version smallint,
  nonce bytea,
  ciphertext bytea,
  auth_tag bytea,
  configured_at bigint not null constraint connection_slots_configured_at_check
    check (configured_at between 0 and 9007199254740991),
  updated_at bigint not null constraint connection_slots_updated_at_check
    check (updated_at between configured_at and 9007199254740991),
  revoked_at bigint,
  constraint connection_slots_pkey primary key (connection_id, environment),
  constraint connection_slots_connection_id_fkey foreign key (connection_id)
    references public.connections (id) on delete restrict,
  constraint connection_slots_state_check check ((
    (status = 'configured'
      and key_version is not null
      and nonce is not null
      and ciphertext is not null
      and auth_tag is not null
      and key_version = 1
      and octet_length(nonce) = 12
      and octet_length(ciphertext) between 1 and 32768
      and octet_length(auth_tag) = 16
      and revoked_at is null)
    or
    (status = 'revoked'
      and key_version is null
      and nonce is null
      and ciphertext is null
      and auth_tag is null
      and revoked_at is not null
      and revoked_at between configured_at and updated_at)
  ) is true)
);

create index if not exists idx_connections_owner_updated
  on public.connections (owner_id, updated_at desc, id desc);
create index if not exists idx_connections_owner_name
  on public.connections (owner_id, name, id);
create index if not exists idx_connection_slots_status_environment
  on public.connection_slots (status, environment, connection_id);

create or replace function public.agent_studio_guard_connection_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  effective_now bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'connections are append-only' using errcode = '23514';
  end if;
  if new.id is distinct from old.id
    or new.crypto_owner_id is distinct from old.crypto_owner_id
    or new.schema_version is distinct from old.schema_version
    or new.created_at is distinct from old.created_at then
    raise exception 'connection cryptographic identity is immutable' using errcode = '23514';
  end if;
  if new.lifecycle_revision <> old.lifecycle_revision + 1 then
    raise exception 'invalid connection lifecycle revision' using errcode = '23514';
  end if;
  if old.updated_at >= 9007199254740991 then
    raise exception 'connection timestamp exhausted' using errcode = '22003';
  end if;
  if new.updated_at is null or new.updated_at not between 0 and 9007199254740991 then
    raise exception 'invalid connection timestamp' using errcode = '22023';
  end if;
  if (new.kind is distinct from old.kind or new.public_config is distinct from old.public_config)
    and exists (select 1 from public.connection_slots where connection_id = old.id) then
    raise exception 'configured connection identity is immutable' using errcode = '23514';
  end if;
  effective_now := greatest(old.updated_at + 1, new.updated_at);
  new.updated_at := effective_now;
  return new;
end;
$$;

create or replace function public.agent_studio_guard_connection_slot_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  effective_now bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'connection slots are append-only' using errcode = '23514';
  end if;
  if new.connection_id is distinct from old.connection_id
    or new.environment is distinct from old.environment
    or not (
      (old.status = 'configured' and new.status = 'configured'
        and new.secret_version = old.secret_version + 1)
      or (old.status = 'configured' and new.status = 'revoked'
        and new.secret_version = old.secret_version)
      or (old.status = 'revoked' and new.status = 'configured'
        and new.secret_version = old.secret_version + 1)
    ) then
    raise exception 'invalid connection slot transition' using errcode = '23514';
  end if;
  if old.updated_at >= 9007199254740991 then
    raise exception 'connection slot timestamp exhausted' using errcode = '22003';
  end if;
  if new.updated_at is null or new.updated_at not between 0 and 9007199254740991 then
    raise exception 'invalid connection slot timestamp' using errcode = '22023';
  end if;
  effective_now := greatest(old.updated_at + 1, new.updated_at);
  new.updated_at := effective_now;
  if new.status = 'configured' then
    new.configured_at := effective_now;
    new.revoked_at := null;
  else
    new.configured_at := old.configured_at;
    new.revoked_at := effective_now;
  end if;
  return new;
end;
$$;

drop trigger if exists connections_guard_update on public.connections;
create trigger connections_guard_update
  before update or delete on public.connections
  for each row execute function public.agent_studio_guard_connection_update();
drop trigger if exists connection_slots_guard_update on public.connection_slots;
create trigger connection_slots_guard_update
  before update or delete on public.connection_slots
  for each row execute function public.agent_studio_guard_connection_slot_update();

create or replace function public.agent_studio_configure_connection_slot(
  p_owner_id text,
  p_connection_id uuid,
  p_environment text,
  p_expected_lifecycle_revision bigint,
  p_expected_secret_version bigint,
  p_key_version smallint,
  p_nonce bytea,
  p_ciphertext bytea,
  p_auth_tag bytea,
  p_now bigint
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  current_connection public.connections%rowtype;
  current_slot public.connection_slots%rowtype;
  slot_exists boolean;
begin
  if p_environment not in ('test', 'live')
    or p_key_version <> 1
    or p_now is null
    or p_now not between 0 and 9007199254740991 then
    raise exception 'invalid connection slot input' using errcode = '22023';
  end if;
  select * into current_connection
  from public.connections
  where owner_id = p_owner_id and id = p_connection_id
  for update;
  if not found then return 'not-found'; end if;
  if current_connection.lifecycle_revision <> p_expected_lifecycle_revision then
    return 'conflict';
  end if;

  select * into current_slot
  from public.connection_slots
  where connection_id = p_connection_id and environment = p_environment
  for update;
  slot_exists := found;
  if p_expected_secret_version <> coalesce(current_slot.secret_version, 0) + 1 then
    return 'conflict';
  end if;

  if slot_exists then
    update public.connection_slots
    set status = 'configured',
        secret_version = p_expected_secret_version,
        key_version = p_key_version,
        nonce = p_nonce,
        ciphertext = p_ciphertext,
        auth_tag = p_auth_tag,
        configured_at = p_now,
        updated_at = p_now,
        revoked_at = null
    where connection_id = p_connection_id and environment = p_environment;
  else
    insert into public.connection_slots (
      connection_id, environment, status, secret_version, key_version,
      nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at
    ) values (
      p_connection_id, p_environment, 'configured', p_expected_secret_version,
      p_key_version, p_nonce, p_ciphertext, p_auth_tag, p_now, p_now, null
    );
  end if;

  update public.connections
  set lifecycle_revision = lifecycle_revision + 1, updated_at = p_now
  where owner_id = p_owner_id and id = p_connection_id
    and lifecycle_revision = p_expected_lifecycle_revision;
  if not found then raise exception 'connection lifecycle conflict' using errcode = '40001'; end if;
  return 'updated';
end;
$$;

create or replace function public.agent_studio_revoke_connection_slot(
  p_owner_id text,
  p_connection_id uuid,
  p_environment text,
  p_expected_lifecycle_revision bigint,
  p_now bigint
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  current_connection public.connections%rowtype;
  current_slot public.connection_slots%rowtype;
begin
  if p_environment not in ('test', 'live')
    or p_now is null
    or p_now not between 0 and 9007199254740991 then
    raise exception 'invalid connection slot input' using errcode = '22023';
  end if;
  select * into current_connection
  from public.connections
  where owner_id = p_owner_id and id = p_connection_id
  for update;
  if not found then return 'not-found'; end if;
  if current_connection.lifecycle_revision <> p_expected_lifecycle_revision then
    return 'conflict';
  end if;

  select * into current_slot
  from public.connection_slots
  where connection_id = p_connection_id and environment = p_environment
  for update;
  if not found or current_slot.status <> 'configured' then return 'conflict'; end if;

  update public.connection_slots
  set status = 'revoked', key_version = null, nonce = null, ciphertext = null,
      auth_tag = null, updated_at = p_now, revoked_at = p_now
  where connection_id = p_connection_id and environment = p_environment
    and status = 'configured';
  update public.connections
  set lifecycle_revision = lifecycle_revision + 1, updated_at = p_now
  where owner_id = p_owner_id and id = p_connection_id
    and lifecycle_revision = p_expected_lifecycle_revision;
  if not found then raise exception 'connection lifecycle conflict' using errcode = '40001'; end if;
  return 'updated';
end;
$$;

create or replace function public.agent_studio_connection_usage_artifacts(
  p_owner_id text,
  p_connection_id uuid,
  p_cursor_artifact_order integer,
  p_cursor_sort_at bigint,
  p_cursor_flow_id uuid,
  p_cursor_flow_version_id uuid,
  p_cursor_environment text,
  p_artifact_limit integer,
  p_graph_byte_limit integer,
  p_total_byte_limit integer
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  connection_revision bigint;
  artifact_payload jsonb;
  artifact_items jsonb[] := array[]::jsonb[];
  result_truncated boolean := false;
  candidate record;
  graph_text text;
  graph_bytes integer;
  cumulative_bytes bigint := 0;
  artifact_count integer := 0;
begin
  if p_artifact_limit is null or p_artifact_limit not between 1 and 501
    or p_graph_byte_limit is null or p_graph_byte_limit not between 1 and 2097152
    or p_total_byte_limit is null or p_total_byte_limit not between 1 and 16777216 then
    raise exception 'invalid connection usage limits' using errcode = '22023';
  end if;
  if p_cursor_artifact_order is null then
    if p_cursor_sort_at is not null or p_cursor_flow_id is not null
      or p_cursor_flow_version_id is not null or p_cursor_environment is not null then
      raise exception 'invalid connection usage cursor' using errcode = '22023';
    end if;
  elsif p_cursor_artifact_order = 0 then
    if p_cursor_sort_at is null or p_cursor_flow_id is null
      or p_cursor_flow_version_id is not null
      or p_cursor_environment is distinct from 'draft' then
      raise exception 'invalid connection usage cursor' using errcode = '22023';
    end if;
  elsif p_cursor_artifact_order = 1 then
    if p_cursor_sort_at is null or p_cursor_flow_id is null
      or p_cursor_flow_version_id is null or p_cursor_environment is null
      or p_cursor_environment not in ('test', 'live') then
      raise exception 'invalid connection usage cursor' using errcode = '22023';
    end if;
  else
    raise exception 'invalid connection usage cursor' using errcode = '22023';
  end if;

  select lifecycle_revision into connection_revision
  from public.connections
  where owner_id = p_owner_id and id = p_connection_id
  for share;
  if not found then return jsonb_build_object('status', 'not-found'); end if;

  for candidate in
    with active_refs as materialized (
      select d.flow_id, d.flow_version_id, e.kind as environment,
        floor(extract(epoch from max(d.created_at)) * 1000)::bigint as sort_at
      from public.deployments d
      join public.flows f on f.id = d.flow_id and f.owner_id = p_owner_id
      join public.flow_versions fv on fv.id = d.flow_version_id and fv.flow_id = d.flow_id
      join public.environments e on e.id = d.environment_id and e.kind in ('test', 'live')
      where d.retired_at is null and d.status = e.kind
      group by d.flow_id, d.flow_version_id, e.kind
    ), artifact_keys as (
      select 0 as artifact_order, 'draft'::text as artifact_kind,
        f.id as flow_id, f.name as flow_name, null::uuid as flow_version_id,
        'draft'::text as environment,
        floor(extract(epoch from f.updated_at) * 1000)::bigint as sort_at
      from public.flows f where f.owner_id = p_owner_id
      union all
      select 1, 'active_deployment', f.id, f.name, active.flow_version_id,
        active.environment, active.sort_at
      from active_refs active
      join public.flows f on f.id = active.flow_id and f.owner_id = p_owner_id
    )
    select * from artifact_keys candidate_key
    where p_cursor_artifact_order is null
      or candidate_key.artifact_order > p_cursor_artifact_order
      or (candidate_key.artifact_order = p_cursor_artifact_order and (
        candidate_key.sort_at < p_cursor_sort_at
        or (candidate_key.sort_at = p_cursor_sort_at and (
          candidate_key.flow_id > p_cursor_flow_id
          or (candidate_key.flow_id = p_cursor_flow_id and (
            coalesce(candidate_key.flow_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
              > coalesce(p_cursor_flow_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
            or (coalesce(candidate_key.flow_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = coalesce(p_cursor_flow_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
              and candidate_key.environment > p_cursor_environment)
          ))
        ))
      ))
    order by artifact_order, sort_at desc, flow_id,
      coalesce(flow_version_id, '00000000-0000-0000-0000-000000000000'::uuid), environment
    limit p_artifact_limit + 1
  loop
    -- The lookahead row proves truncation without touching its graph payload.
    if artifact_count >= p_artifact_limit then
      result_truncated := true;
      exit;
    end if;

    graph_text := null;
    if candidate.artifact_order = 0 then
      select draft.graph::text into graph_text
      from public.flows draft
      where draft.id = candidate.flow_id and draft.owner_id = p_owner_id;
    else
      select version.graph::text into graph_text
      from public.flow_versions version
      join public.flows owned_flow
        on owned_flow.id = version.flow_id and owned_flow.owner_id = p_owner_id
      where version.id = candidate.flow_version_id
        and version.flow_id = candidate.flow_id;
    end if;

    if not found or graph_text is null then
      artifact_items := array_append(artifact_items, jsonb_build_object(
        'artifactKind', candidate.artifact_kind,
        'flowId', candidate.flow_id::text,
        'flowName', candidate.flow_name,
        'flowVersionId', case when candidate.flow_version_id is null then null else candidate.flow_version_id::text end,
        'environment', candidate.environment,
        'sortAt', candidate.sort_at,
        'graphBytes', 0,
        'graph', null
      ));
      result_truncated := true;
      exit;
    end if;

    -- Materialize each graph exactly once, then stop before any later graph as
    -- soon as the per-artifact or cumulative transport budget is exhausted.
    graph_bytes := octet_length(convert_to(graph_text, 'UTF8'));
    if graph_bytes > p_graph_byte_limit then
      artifact_items := array_append(artifact_items, jsonb_build_object(
        'artifactKind', candidate.artifact_kind,
        'flowId', candidate.flow_id::text,
        'flowName', candidate.flow_name,
        'flowVersionId', case when candidate.flow_version_id is null then null else candidate.flow_version_id::text end,
        'environment', candidate.environment,
        'sortAt', candidate.sort_at,
        'graphBytes', graph_bytes,
        'graph', null
      ));
      result_truncated := true;
      exit;
    end if;
    if cumulative_bytes + graph_bytes > p_total_byte_limit then
      -- Do not advance the cursor past a valid graph that a fresh page can admit.
      result_truncated := true;
      exit;
    end if;

    cumulative_bytes := cumulative_bytes + graph_bytes;
    artifact_count := artifact_count + 1;
    artifact_items := array_append(artifact_items, jsonb_build_object(
      'artifactKind', candidate.artifact_kind,
      'flowId', candidate.flow_id::text,
      'flowName', candidate.flow_name,
      'flowVersionId', case when candidate.flow_version_id is null then null else candidate.flow_version_id::text end,
      'environment', candidate.environment,
      'sortAt', candidate.sort_at,
      'graphBytes', graph_bytes,
      'graph', graph_text
    ));
  end loop;

  artifact_payload := to_jsonb(artifact_items);

  return jsonb_build_object(
    'status', 'ok',
    'lifecycleRevision', connection_revision,
    'artifacts', artifact_payload,
    'truncated', result_truncated
  );
end;
$$;

create or replace function public.agent_studio_adopt_owner_with_connections(
  p_from_owner_id text,
  p_to_owner_id text
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_from_owner_id = p_to_owner_id then return; end if;
  perform public.agent_studio_adopt_owner(p_from_owner_id, p_to_owner_id);
  update public.connections connection
  set owner_id = p_to_owner_id,
      lifecycle_revision = connection.lifecycle_revision + 1,
      updated_at = greatest(
        connection.updated_at + 1,
        floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      )
  where connection.owner_id = p_from_owner_id;
end;
$$;

alter table public.connections enable row level security;
alter table public.connection_slots enable row level security;
drop policy if exists agent_studio_server_access on public.connections;
create policy agent_studio_server_access on public.connections
  for all to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());
drop policy if exists agent_studio_server_access on public.connection_slots;
create policy agent_studio_server_access on public.connection_slots
  for all to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());

revoke all privileges on table public.connections, public.connection_slots
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.connections, public.connection_slots
  to anon, service_role;
revoke delete, truncate, references, trigger on table public.connections, public.connection_slots
  from anon, service_role;

revoke all on function public.agent_studio_connection_public_config_valid(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_studio_guard_connection_update()
  from public, anon, authenticated, service_role;
revoke all on function public.agent_studio_guard_connection_slot_update()
  from public, anon, authenticated, service_role;
revoke all on function public.agent_studio_configure_connection_slot(text, uuid, text, bigint, bigint, smallint, bytea, bytea, bytea, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_studio_revoke_connection_slot(text, uuid, text, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_studio_connection_usage_artifacts(text, uuid, integer, bigint, uuid, uuid, text, integer, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_studio_adopt_owner_with_connections(text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.agent_studio_connection_public_config_valid(text, jsonb)
  to anon, service_role;
grant execute on function public.agent_studio_configure_connection_slot(text, uuid, text, bigint, bigint, smallint, bytea, bytea, bytea, bigint)
  to anon, service_role;
grant execute on function public.agent_studio_revoke_connection_slot(text, uuid, text, bigint, bigint)
  to anon, service_role;
grant execute on function public.agent_studio_connection_usage_artifacts(text, uuid, integer, bigint, uuid, uuid, text, integer, integer, integer)
  to anon, service_role;
grant execute on function public.agent_studio_adopt_owner_with_connections(text, text)
  to anon, service_role;

do $$
declare
  connection_columns text[];
  slot_columns text[];
  matching_column_count integer;
  matching_constraint_count integer;
  matching_index_count integer;
  explicit_index_count integer;
begin
  if (
    select count(*)
    from pg_class tables
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname in ('connections', 'connection_slots')
      and tables.relkind = 'r'
      and tables.relpersistence = 'p'
      and tables.relowner = (
        select flows.relowner
        from pg_class flows
        join pg_namespace flow_schema on flow_schema.oid = flows.relnamespace
        where flow_schema.nspname = 'public' and flows.relname = 'flows'
      )
      and tables.relrowsecurity is true
      and tables.relforcerowsecurity is false
      and tables.relreplident = 'd'
      and tables.relispartition is false
  ) <> 2 then
    raise exception 'Agent Studio connection table owner or physical shape drift';
  end if;

  if exists (
    select 1
    from pg_attribute columns
    where columns.attrelid in ('public.connections'::regclass, 'public.connection_slots'::regclass)
      and columns.attnum > 0
      and columns.attisdropped is false
      and columns.attacl is not null
  ) then
    raise exception 'Agent Studio connection column ACL drift';
  end if;

  with expected(table_name, ordinal_position, column_name, udt_name, nullable) as (
    values
      ('connections', 1, 'id', 'uuid', 'NO'),
      ('connections', 2, 'owner_id', 'text', 'NO'),
      ('connections', 3, 'crypto_owner_id', 'text', 'NO'),
      ('connections', 4, 'name', 'text', 'NO'),
      ('connections', 5, 'kind', 'text', 'NO'),
      ('connections', 6, 'public_config', 'jsonb', 'NO'),
      ('connections', 7, 'schema_version', 'int2', 'NO'),
      ('connections', 8, 'lifecycle_revision', 'int8', 'NO'),
      ('connections', 9, 'created_at', 'int8', 'NO'),
      ('connections', 10, 'updated_at', 'int8', 'NO'),
      ('connection_slots', 1, 'connection_id', 'uuid', 'NO'),
      ('connection_slots', 2, 'environment', 'text', 'NO'),
      ('connection_slots', 3, 'status', 'text', 'NO'),
      ('connection_slots', 4, 'secret_version', 'int8', 'NO'),
      ('connection_slots', 5, 'key_version', 'int2', 'YES'),
      ('connection_slots', 6, 'nonce', 'bytea', 'YES'),
      ('connection_slots', 7, 'ciphertext', 'bytea', 'YES'),
      ('connection_slots', 8, 'auth_tag', 'bytea', 'YES'),
      ('connection_slots', 9, 'configured_at', 'int8', 'NO'),
      ('connection_slots', 10, 'updated_at', 'int8', 'NO'),
      ('connection_slots', 11, 'revoked_at', 'int8', 'YES')
  )
  select count(*) into matching_column_count
  from expected
  join information_schema.columns columns
    on columns.table_schema = 'public'
    and columns.table_name = expected.table_name
    and columns.ordinal_position = expected.ordinal_position
    and columns.column_name = expected.column_name
    and columns.udt_name = expected.udt_name
    and columns.is_nullable = expected.nullable
    and columns.is_identity = 'NO'
    and columns.is_generated = 'NEVER'
    and columns.column_default is null;

  if matching_column_count <> 21 or (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name in ('connections', 'connection_slots')
  ) <> 21 then
    raise exception 'Agent Studio connection exact column/type/default drift';
  end if;

  select array_agg(column_name::text order by ordinal_position) into connection_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'connections';
  if connection_columns is distinct from array[
    'id','owner_id','crypto_owner_id','name','kind','public_config','schema_version',
    'lifecycle_revision','created_at','updated_at'
  ]::text[] then
    raise exception 'Agent Studio connections column inventory drift';
  end if;

  select array_agg(column_name::text order by ordinal_position) into slot_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'connection_slots';
  if slot_columns is distinct from array[
    'connection_id','environment','status','secret_version','key_version','nonce',
    'ciphertext','auth_tag','configured_at','updated_at','revoked_at'
  ]::text[] then
    raise exception 'Agent Studio connection_slots column inventory drift';
  end if;

  with expected(table_name, constraint_name, constraint_type, definition) as (
    values
      ('connections', 'connections_pkey', 'p', 'primarykey(id)'),
      ('connections', 'connections_owner_id_check', 'c', 'check(((char_length(owner_id)>=1)and(char_length(owner_id)<=512)))'),
      ('connections', 'connections_crypto_owner_id_check', 'c', 'check(((char_length(crypto_owner_id)>=1)and(char_length(crypto_owner_id)<=512)))'),
      ('connections', 'connections_name_check', 'c', 'check((((octet_length(name)>=1)and(octet_length(name)<=120))and(name=btrim(name))))'),
      ('connections', 'connections_kind_check', 'c', 'check((kind=any(array[''api_key''::text,''bearer''::text,''basic''::text,''custom_headers''::text])))'),
      ('connections', 'connections_public_config_check', 'c', 'check((((octet_length((public_config)::text)>=2)and(octet_length((public_config)::text)<=32768))andagent_studio_connection_public_config_valid(kind,public_config)))'),
      ('connections', 'connections_schema_version_check', 'c', 'check((schema_version=1))'),
      ('connections', 'connections_lifecycle_revision_check', 'c', 'check(((lifecycle_revision>=1)and(lifecycle_revision<=''9007199254740991''::bigint)))'),
      ('connections', 'connections_created_at_check', 'c', 'check(((created_at>=0)and(created_at<=''9007199254740991''::bigint)))'),
      ('connections', 'connections_updated_at_check', 'c', 'check(((updated_at>=created_at)and(updated_at<=''9007199254740991''::bigint)))'),
      ('connection_slots', 'connection_slots_pkey', 'p', 'primarykey(connection_id,environment)'),
      ('connection_slots', 'connection_slots_connection_id_fkey', 'f', 'foreignkey(connection_id)referencesconnections(id)ondeleterestrict'),
      ('connection_slots', 'connection_slots_environment_check', 'c', 'check((environment=any(array[''test''::text,''live''::text])))'),
      ('connection_slots', 'connection_slots_status_check', 'c', 'check((status=any(array[''configured''::text,''revoked''::text])))'),
      ('connection_slots', 'connection_slots_secret_version_check', 'c', 'check(((secret_version>=1)and(secret_version<=''9007199254740991''::bigint)))'),
      ('connection_slots', 'connection_slots_configured_at_check', 'c', 'check(((configured_at>=0)and(configured_at<=''9007199254740991''::bigint)))'),
      ('connection_slots', 'connection_slots_updated_at_check', 'c', 'check(((updated_at>=configured_at)and(updated_at<=''9007199254740991''::bigint)))'),
      ('connection_slots', 'connection_slots_state_check', 'c', 'check(((((status=''configured''::text)and(key_versionisnotnull)and(nonceisnotnull)and(ciphertextisnotnull)and(auth_tagisnotnull)and(key_version=1)and(octet_length(nonce)=12)and((octet_length(ciphertext)>=1)and(octet_length(ciphertext)<=32768))and(octet_length(auth_tag)=16)and(revoked_atisnull))or((status=''revoked''::text)and(key_versionisnull)and(nonceisnull)and(ciphertextisnull)and(auth_tagisnull)and(revoked_atisnotnull)and((revoked_at>=configured_at)and(revoked_at<=updated_at))))istrue))')
  )
  select count(*) into matching_constraint_count
  from expected
  join pg_class tables on tables.relname = expected.table_name
  join pg_namespace schemas on schemas.oid = tables.relnamespace and schemas.nspname = 'public'
  join pg_constraint constraints
    on constraints.conrelid = tables.oid
    and constraints.conname = expected.constraint_name
    and constraints.contype::text = expected.constraint_type
    and constraints.convalidated is true
    and replace(
      regexp_replace(lower(pg_get_constraintdef(constraints.oid)), '\s+', '', 'g'),
      'public.',
      ''
    ) = expected.definition;

  if matching_constraint_count <> 18 or (
    select count(*) from pg_constraint
    where conrelid in ('public.connections'::regclass, 'public.connection_slots'::regclass)
  ) <> 18 then
    raise exception 'Agent Studio connection exact constraint definition drift';
  end if;

  if (
    select count(*)
    from pg_trigger triggers
    where triggers.tgrelid in ('public.connections'::regclass, 'public.connection_slots'::regclass)
      and not triggers.tgisinternal
      and triggers.tgenabled <> 'D'
      and replace(
        regexp_replace(lower(pg_get_triggerdef(triggers.oid)), '\s+', '', 'g'),
        'public.',
        ''
      ) in (
        'createtriggerconnections_guard_updatebeforedeleteorupdateonconnectionsforeachrowexecutefunctionagent_studio_guard_connection_update()',
        'createtriggerconnection_slots_guard_updatebeforedeleteorupdateonconnection_slotsforeachrowexecutefunctionagent_studio_guard_connection_slot_update()'
      )
  ) <> 2 or (
    select count(*) from pg_trigger
    where tgrelid in ('public.connections'::regclass, 'public.connection_slots'::regclass)
      and not tgisinternal
  ) <> 2 then
    raise exception 'Agent Studio connection exact trigger definition drift';
  end if;

  with expected(table_name, index_name, definition) as (
    values
      ('connections', 'idx_connections_owner_updated', 'createindexidx_connections_owner_updatedonconnectionsusingbtree(owner_id,updated_atdesc,iddesc)'),
      ('connections', 'idx_connections_owner_name', 'createindexidx_connections_owner_nameonconnectionsusingbtree(owner_id,name,id)'),
      ('connection_slots', 'idx_connection_slots_status_environment', 'createindexidx_connection_slots_status_environmentonconnection_slotsusingbtree(status,environment,connection_id)')
  )
  select count(*) into matching_index_count
  from expected
  join pg_indexes catalog_index
    on catalog_index.schemaname = 'public'
    and catalog_index.tablename = expected.table_name
    and catalog_index.indexname = expected.index_name
  join pg_class index_class on index_class.relname = catalog_index.indexname
  join pg_namespace index_namespace
    on index_namespace.oid = index_class.relnamespace and index_namespace.nspname = 'public'
  join pg_index index_meta
    on index_meta.indexrelid = index_class.oid
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
  ) = expected.definition;

  select count(*) into explicit_index_count
  from pg_index indexes
  left join pg_constraint backing on backing.conindid = indexes.indexrelid
  where indexes.indrelid in ('public.connections'::regclass, 'public.connection_slots'::regclass)
    and backing.oid is null;

  if matching_index_count <> 3 or explicit_index_count <> 3 then
    raise exception 'Agent Studio connection exact index definition drift';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename in ('connections','connection_slots')
        and policyname = 'agent_studio_server_access' and cmd = 'ALL'
        and roles = array['anon']::name[]) <> 2 then
    raise exception 'Agent Studio connection shared-runtime policy readback failed';
  end if;
  if (select count(*) from pg_class tables
      join pg_namespace schemas on schemas.oid = tables.relnamespace
      where schemas.nspname = 'public'
        and tables.relname in ('connections','connection_slots')
        and tables.relrowsecurity) <> 2 then
    raise exception 'Agent Studio connection RLS readback failed';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('connections','connection_slots')
      and policyname <> 'agent_studio_server_access'
  ) then
    raise exception 'Agent Studio connection table has unexpected RLS policies';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants grants
    where grants.table_schema = 'public'
      and grants.table_name in ('connections','connection_slots')
      and (
        grants.grantee in ('PUBLIC','authenticated')
        or (grants.grantee in ('anon','service_role')
          and grants.privilege_type not in ('SELECT','INSERT','UPDATE'))
      )
  ) then
    raise exception 'Agent Studio connection table privilege readback failed';
  end if;
  if (
    select count(*) from information_schema.role_table_grants grants
    where grants.table_schema = 'public'
      and grants.table_name in ('connections','connection_slots')
      and grants.grantee in ('anon','service_role')
      and grants.privilege_type in ('SELECT','INSERT','UPDATE')
  ) <> 12 then
    raise exception 'Agent Studio connection runtime grants are incomplete';
  end if;

  if exists (
    select 1 from pg_proc functions
    join pg_namespace schemas on schemas.oid = functions.pronamespace
    where schemas.nspname = 'public'
      and functions.proname in (
        'agent_studio_connection_public_config_valid',
        'agent_studio_guard_connection_update',
        'agent_studio_guard_connection_slot_update',
        'agent_studio_configure_connection_slot',
        'agent_studio_revoke_connection_slot',
        'agent_studio_connection_usage_artifacts',
        'agent_studio_adopt_owner_with_connections'
      )
      and (functions.prosecdef
        or not ('search_path=pg_catalog, public' = any(coalesce(functions.proconfig, array[]::text[]))
          or (functions.proname = 'agent_studio_adopt_owner_with_connections'
            and 'search_path=pg_catalog, public, extensions' = any(coalesce(functions.proconfig, array[]::text[])))))
  ) then
    raise exception 'Agent Studio connection function hardening drift';
  end if;
  if not has_function_privilege('anon', 'public.agent_studio_configure_connection_slot(text,uuid,text,bigint,bigint,smallint,bytea,bytea,bytea,bigint)', 'execute')
    or not has_function_privilege('service_role', 'public.agent_studio_configure_connection_slot(text,uuid,text,bigint,bigint,smallint,bytea,bytea,bytea,bigint)', 'execute')
    or has_function_privilege('authenticated', 'public.agent_studio_configure_connection_slot(text,uuid,text,bigint,bigint,smallint,bytea,bytea,bytea,bigint)', 'execute')
    or not has_function_privilege('anon', 'public.agent_studio_revoke_connection_slot(text,uuid,text,bigint,bigint)', 'execute')
    or has_function_privilege('authenticated', 'public.agent_studio_revoke_connection_slot(text,uuid,text,bigint,bigint)', 'execute')
    or not has_function_privilege('anon', 'public.agent_studio_connection_usage_artifacts(text,uuid,integer,bigint,uuid,uuid,text,integer,integer,integer)', 'execute')
    or has_function_privilege('authenticated', 'public.agent_studio_connection_usage_artifacts(text,uuid,integer,bigint,uuid,uuid,text,integer,integer,integer)', 'execute')
    or not has_function_privilege('anon', 'public.agent_studio_adopt_owner_with_connections(text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.agent_studio_adopt_owner_with_connections(text,text)', 'execute') then
    raise exception 'Agent Studio connection RPC privilege readback failed';
  end if;
end
$$;

commit;
