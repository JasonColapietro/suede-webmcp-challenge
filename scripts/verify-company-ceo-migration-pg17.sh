#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/docs/migrations/company-ceo-messages-production-shared-runtime.sql"
CONTRACT_GUARD="$REPO_ROOT/docs/migrations/company-ceo-shared-runtime-contract-v1.sql"
PG17_BIN="${PG17_BIN:-/usr/local/opt/postgresql@17/bin}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-studio-ceo-pg17.XXXXXX")"
DATA_DIR="$TEST_ROOT/data"
SOCKET_DIR="$TEST_ROOT/socket"
LOG_FILE="$TEST_ROOT/postgres.log"
PORT="$((56000 + ($$ % 5000)))"
SERVER_STARTED=false
FIXTURE_SECRET="local-fixture-secret-0123456789abcdef-CEO"

cleanup() {
  if [[ "$SERVER_STARTED" == true ]]; then
    "$PG17_BIN/pg_ctl" -D "$DATA_DIR" -m fast stop >/dev/null 2>&1 || true
  fi
  if [[ -n "$TEST_ROOT" && -d "$TEST_ROOT" ]]; then
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG17_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable missing: $PG17_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Migration missing: $MIGRATION" >&2
  exit 1
fi
if [[ ! -f "$CONTRACT_GUARD" ]]; then
  echo "Contract guard missing: $CONTRACT_GUARD" >&2
  exit 1
fi

mkdir -p "$SOCKET_DIR"
"$PG17_BIN/initdb" -D "$DATA_DIR" -U postgres -A trust --no-locale >/dev/null
"$PG17_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR" start >/dev/null
SERVER_STARTED=true

PSQL=("$PG17_BIN/psql" -X -v ON_ERROR_STOP=1 -U postgres -h "$SOCKET_DIR" -p "$PORT" -d postgres)

"${PSQL[@]}" >/dev/null <<SQL
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role contract_attacker nologin;

create schema extensions;
create extension pgcrypto with schema extensions;

create table public.agent_studio_runtime_secrets (
  id text primary key,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  schema_revision text not null check (schema_revision = 'shared-runtime-v2'),
  updated_at timestamptz not null default now()
);
insert into public.agent_studio_runtime_secrets (
  id,
  secret_hash,
  schema_revision
) values (
  'primary',
  encode(extensions.digest('$FIXTURE_SECRET', 'sha256'), 'hex'),
  'shared-runtime-v2'
);
alter table public.agent_studio_runtime_secrets enable row level security;
create policy agent_studio_runtime_secrets_deny_all
  on public.agent_studio_runtime_secrets
  for all
  to anon
  using (false)
  with check (false);
revoke all privileges on table public.agent_studio_runtime_secrets
  from public, anon, authenticated, service_role;
grant select, insert, update, delete, truncate, references, trigger
  on table public.agent_studio_runtime_secrets to service_role;

create schema agent_studio_private;
revoke all on schema agent_studio_private from public, authenticated;
grant usage on schema agent_studio_private to anon, service_role;

create or replace function agent_studio_private.request_authorized()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as \$function\$
  select exists (
    select 1
    from public.agent_studio_runtime_secrets secrets
    where secrets.id = 'primary'
      and secrets.secret_hash = encode(
        extensions.digest(
          coalesce(
            coalesce(current_setting('request.headers', true), '{}')::jsonb
              ->> 'x-agent-studio-secret',
            ''
          ),
          'sha256'
        ),
        'hex'
      )
  );
\$function\$;
revoke all on function agent_studio_private.request_authorized()
  from public, anon, authenticated;
grant execute on function agent_studio_private.request_authorized()
  to anon, service_role;

create table public.flows (id text primary key);
create table public.agents (
  id text primary key,
  settlement_live boolean not null default true
);
create table public.runs (id text primary key);
create table public.companies (id text primary key);
alter table public.companies enable row level security;
create policy agent_studio_server_access
  on public.companies
  for all
  to anon
  using (agent_studio_private.request_authorized())
  with check (agent_studio_private.request_authorized());

create table public.company_ceo_messages (
  id text primary key,
  company_id text not null references public.companies (id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  proposal jsonb,
  created_at text not null,
  seq bigint generated always as identity
);
create index idx_ceo_messages_company
  on public.company_ceo_messages (company_id, created_at, seq);
alter table public.company_ceo_messages enable row level security;
revoke all privileges on table public.company_ceo_messages
  from public, anon, authenticated, service_role;
grant select, insert, truncate, references, trigger
  on table public.company_ceo_messages to service_role;
revoke all privileges on sequence public.company_ceo_messages_seq_seq
  from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.company_ceo_messages_seq_seq
  to anon, authenticated, service_role;

insert into public.companies (id) values ('fixture-company');
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null
"${PSQL[@]}" -f "$MIGRATION" >/dev/null
"${PSQL[@]}" -f "$CONTRACT_GUARD" >/dev/null
"${PSQL[@]}" -f "$CONTRACT_GUARD" >/dev/null

expect_contract_rejection() {
  local drift="$1"
  if "${PSQL[@]}" -f "$CONTRACT_GUARD" >/dev/null 2>&1; then
    echo "Contract guard accepted $drift drift" >&2
    exit 1
  fi
}

unauthorized_count="$(
  "${PSQL[@]}" -qAtc \
    "set role anon; set request.headers = '{}'; select count(*) from public.company_ceo_messages;"
)"
if [[ "$unauthorized_count" != "0" ]]; then
  echo "Unauthorized anon read escaped RLS" >&2
  exit 1
fi

if "${PSQL[@]}" -q >/dev/null 2>&1 <<SQL
set role anon;
set request.headers = '{}';
insert into public.company_ceo_messages (
  id, company_id, role, content, created_at
) values (
  'unauthorized', 'fixture-company', 'user', 'must fail', '2026-08-14T00:00:00.000Z'
);
SQL
then
  echo "Unauthorized anon insert escaped RLS" >&2
  exit 1
fi

"${PSQL[@]}" -q >/dev/null <<SQL
set role anon;
set request.headers = '{"x-agent-studio-secret":"$FIXTURE_SECRET"}';
insert into public.company_ceo_messages (
  id, company_id, role, content, created_at
) values (
  'authorized', 'fixture-company', 'user', 'persists', '2026-08-14T00:00:00.000Z'
);
SQL

authorized_count="$(
  "${PSQL[@]}" -qAtc \
    "set role anon; set request.headers = '{\"x-agent-studio-secret\":\"$FIXTURE_SECRET\"}'; select count(*) from public.company_ceo_messages where id = 'authorized';"
)"
if [[ "$authorized_count" != "1" ]]; then
  echo "Authorized shared-runtime read/write failed" >&2
  exit 1
fi

if "${PSQL[@]}" -q >/dev/null 2>&1 <<SQL
set role authenticated;
set request.headers = '{"x-agent-studio-secret":"$FIXTURE_SECRET"}';
select * from public.company_ceo_messages;
SQL
then
  echo "Authenticated browser role retained table access" >&2
  exit 1
fi

"${PSQL[@]}" -q -c \
  "alter schema agent_studio_private owner to contract_attacker;" >/dev/null
expect_contract_rejection "private-schema owner"
"${PSQL[@]}" -q -c \
  "alter schema agent_studio_private owner to postgres;" >/dev/null

"${PSQL[@]}" -q -c \
  "grant create on schema agent_studio_private to anon;" >/dev/null
expect_contract_rejection "private-schema ACL"
"${PSQL[@]}" -q -c \
  "revoke create on schema agent_studio_private from anon;" >/dev/null

"${PSQL[@]}" -q -c \
  "alter function agent_studio_private.request_authorized() owner to contract_attacker;" >/dev/null
expect_contract_rejection "authorizer owner"
"${PSQL[@]}" -q -c \
  "alter function agent_studio_private.request_authorized() owner to postgres;" >/dev/null

"${PSQL[@]}" -q -c \
  "grant execute on function agent_studio_private.request_authorized() to authenticated;" >/dev/null
expect_contract_rejection "authorizer ACL"
"${PSQL[@]}" -q -c \
  "revoke execute on function agent_studio_private.request_authorized() from authenticated;" >/dev/null

"${PSQL[@]}" -q -c \
  "alter table public.agent_studio_runtime_secrets owner to contract_attacker;" >/dev/null
expect_contract_rejection "marker owner"
"${PSQL[@]}" -q -c \
  "alter table public.agent_studio_runtime_secrets owner to postgres;" >/dev/null

"${PSQL[@]}" -q -c \
  "alter table public.agent_studio_runtime_secrets disable row level security;" >/dev/null
expect_contract_rejection "marker RLS"
"${PSQL[@]}" -q -c \
  "alter table public.agent_studio_runtime_secrets enable row level security;" >/dev/null

"${PSQL[@]}" -q -c \
  "grant select on table public.agent_studio_runtime_secrets to anon;" >/dev/null
expect_contract_rejection "marker ACL"
"${PSQL[@]}" -q -c \
  "revoke select on table public.agent_studio_runtime_secrets from anon;" >/dev/null

"${PSQL[@]}" -q -c \
  "create policy unexpected_marker_policy on public.agent_studio_runtime_secrets for select to service_role using (true);" >/dev/null
expect_contract_rejection "marker policy"
"${PSQL[@]}" -q -c \
  "drop policy unexpected_marker_policy on public.agent_studio_runtime_secrets;" >/dev/null

"${PSQL[@]}" -f "$CONTRACT_GUARD" >/dev/null

"${PSQL[@]}" -q -c \
  "create index unexpected_ceo_drift on public.company_ceo_messages (role);" >/dev/null
if "${PSQL[@]}" -f "$MIGRATION" >/dev/null 2>&1; then
  echo "Migration accepted an unexpected live index" >&2
  exit 1
fi

echo "PostgreSQL: $("$PG17_BIN/postgres" --version)"
echo "Migration SHA-256: $(shasum -a 256 "$MIGRATION" | awk '{print $1}')"
echo "Contract guard SHA-256: $(shasum -a 256 "$CONTRACT_GUARD" | awk '{print $1}')"
echo "Rehearsal: two clean applies; RLS deny/allow; browser-role deny; schema, authorizer, and marker drift rejection passed"
