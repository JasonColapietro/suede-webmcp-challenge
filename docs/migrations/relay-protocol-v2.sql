-- MANUAL ONLY. Apply under docs/migrations/PENDING.md safety gate.
-- This is additive and keeps every existing relay on legacy protocol v1.

alter table public.relay_endpoints
  add column if not exists protocol_version integer not null default 1;

do $$
begin
  if exists (
    select 1 from public.relay_endpoints
    where protocol_version not in (1, 2)
  ) then
    raise exception 'Relay protocol version preflight failed';
  end if;
  if not exists (
    select 1 from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'relay_endpoints'
      and constraints.conname = 'relay_endpoints_protocol_version_check'
  ) then
    alter table public.relay_endpoints
      add constraint relay_endpoints_protocol_version_check
      check (protocol_version in (1, 2));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'relay_endpoints'
      and columns.column_name = 'protocol_version'
      and columns.is_nullable = 'NO'
      and columns.column_default is not null
  ) then
    raise exception 'Relay protocol version column/default drift';
  end if;
end
$$;
