-- Company org chart + heartbeat: additive company_employees columns and the
-- company_employee_instructions table.
--
-- Prepared input for the manual production gate in docs/migrations/PENDING.md.
-- Do not paste or run this file from the index alone. Builds, tests,
-- application startup, previews, and deploys never apply SQL from this
-- directory.
--
-- Mirrors the reviewed baseline in src/lib/db/schema.deploy.sql and SQLite
-- migrations 36 (company-org-roles) and 37 (company-employee-instructions).
--
-- Every column is nullable with NO DEFAULT, deliberately:
--
--   * `role` stays NULL on every row hired before this migration. Defaulting
--     legacy rows to 'worker' would make each already-founded company read as
--     zero-CEO/all-orphans, which blanks the chart and leaves a new hire with
--     no manager to attach to. src/lib/company/roles.ts resolves a NULL role
--     instead (earliest-hired active employee reads as 'ceo', everyone else as
--     'worker') and persists that reading once, on the first hire after this
--     lands.
--   * `lifecycle_status` has no 'terminated' value. Removal is already the
--     `removed_at` tombstone, which listEmployees filters on; a second answer
--     to "is this employee gone" would drift from it. 'budget_paused' is
--     separate from 'paused' so a budget pause can auto-clear at the UTC month
--     rollover while a founder's pause stays sticky.
--   * `reports_to` has no foreign key. Hires and reparents are validated in
--     application code, which also rejects self-parents and cycles that a
--     foreign key cannot see.
--
-- Until this is applied the application stays dark-deploy safe: SupabaseRepo
-- omits each unset key from the insert payload, so a hire writes exactly the
-- eight columns it always wrote, and reads fall back to role NULL, no manager,
-- 'idle', and no heartbeat.

begin;

alter table public.company_employees add column if not exists role text;
alter table public.company_employees add column if not exists reports_to text;
alter table public.company_employees add column if not exists lifecycle_status text;
alter table public.company_employees add column if not exists heartbeat_enabled boolean;
alter table public.company_employees
  add column if not exists heartbeat_interval_seconds integer;
alter table public.company_employees add column if not exists last_heartbeat_at text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'company_employees_role_check'
  ) then
    alter table public.company_employees
      add constraint company_employees_role_check
      check (role is null or role in ('ceo', 'manager', 'worker'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'company_employees_lifecycle_status_check'
  ) then
    alter table public.company_employees
      add constraint company_employees_lifecycle_status_check
      check (
        lifecycle_status is null
        or lifecycle_status in ('idle', 'running', 'error', 'paused', 'budget_paused')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'company_employees_heartbeat_interval_seconds_check'
  ) then
    alter table public.company_employees
      add constraint company_employees_heartbeat_interval_seconds_check
      check (heartbeat_interval_seconds is null or heartbeat_interval_seconds > 0);
  end if;
end
$$;

create index if not exists idx_employees_reports_to
  on public.company_employees (reports_to);

-- One row per employee holding the markdown documents it boots with.
create table if not exists public.company_employee_instructions (
  agent_id text primary key references public.company_employees (agent_id),
  agents_md text,
  soul_md text,
  heartbeat_md text,
  tools_md text,
  session_summary text,
  updated_at text not null
);

alter table public.company_employee_instructions enable row level security;
revoke all privileges on table public.company_employee_instructions
  from public, anon, authenticated;
grant select, insert, update on table public.company_employee_instructions
  to service_role;
revoke delete on table public.company_employee_instructions
  from service_role;

commit;

-- Readback (start from readback-template.sql and archive the output):
--
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'company_employees'
--      and column_name in ('role', 'reports_to', 'lifecycle_status',
--                          'heartbeat_enabled', 'heartbeat_interval_seconds',
--                          'last_heartbeat_at')
--    order by column_name;
--   -- expect six rows, is_nullable = YES and column_default null on each.
--
--   select count(*) filter (where role is not null) as roled,
--          count(*) as total
--     from public.company_employees;
--   -- expect roled = 0 immediately after apply: this migration backfills nothing.
--
--   select to_regclass('public.company_employee_instructions');
--   select conname from pg_constraint
--    where conrelid = 'public.company_employees'::regclass
--      and conname like 'company_employees_%_check';
--   select indexname from pg_indexes
--    where schemaname = 'public' and tablename = 'company_employees';
--
-- The shared-runtime bridge in company-v1-production-shared-runtime.sql grants
-- the request-secret `anon` lane on the existing Company v1 tables. The new
-- company_employee_instructions table is NOT covered by it; extend that bridge
-- under its own gate before the runtime reads or writes instructions through
-- the anon path.
