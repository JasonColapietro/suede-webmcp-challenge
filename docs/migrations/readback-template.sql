-- Readback template for the manual production migration gate.
--
-- The gate in PENDING.md requires TWO readbacks around every manual apply:
--
--   1. PRE-APPLY   prove the live schema is what you think it is, and that the
--                  objects you are about to create do not already exist.
--   2. POST-APPLY  prove the apply did exactly what was intended, and archive
--                  the output before making any runtime claim.
--
-- Both halves are read-only. Neither changes anything. Run them in the
-- Supabase SQL Editor against production and keep the output.
--
-- HOW TO USE
--   Copy this file, rename it for the migration (e.g. readback-<migration>.sql),
--   then find and replace the placeholders below. Delete the sections that do
--   not apply. Do not run it with placeholders left in.
--
--   <TABLE>      target table, unqualified          e.g. company_employees
--   <COLUMN>     target column, if adding one       e.g. pay_to
--   <INDEX>      index name(s) the migration creates
--   <FUNCTION>   function signature(s) it creates   e.g. public.fn_name()
--
-- Compare every result against src/lib/db/schema.deploy.sql, which is the
-- reviewed baseline. Stop on any drift instead of adapting the migration to
-- whatever production happens to look like.


-- =====================================================================
-- PART 1: PRE-APPLY. Run before touching anything.
-- =====================================================================

-- 1.1 Server version and the extensions the baseline assumes.
select version();
select extname, extversion from pg_extension where extname in ('pgcrypto');
select 1 as gen_random_uuid_ok, gen_random_uuid();

-- 1.2 Does the target already exist? Re-running an applied migration is the
--     most common way this gate gets tripped. Expected: null for a create,
--     a row for an alter.
select to_regclass('public.<TABLE>') as target_table;

-- 1.3 Current shape of the table being altered. Compare column for column
--     with schema.deploy.sql before adding to it.
select column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = '<TABLE>'
order by ordinal_position;

-- 1.4 Adding a column? Expected: zero rows before the apply.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = '<TABLE>'
  and column_name = '<COLUMN>';

-- 1.5 Constraints and indexes that already exist on the target. A name
--     collision here is a hard stop, not something to rename around.
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = to_regclass('public.<TABLE>');

select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = '<TABLE>';

-- 1.6 Names the migration intends to create must not already be taken.
--     Expected: zero rows.
select relname from pg_class where relname in ('<INDEX>');
select to_regprocedure('<FUNCTION>') as existing_function;

-- 1.7 RLS state and policies on the target. Additive column work should not
--     change either; record them so the post-apply readback can prove it.
select relname, relrowsecurity, relforcerowsecurity
from pg_class where oid = to_regclass('public.<TABLE>');

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' and tablename = '<TABLE>';

-- 1.8 Privileges. The house rule is that RPCs and tables are revoked from
--     public/anon/authenticated and granted narrowly to service_role, so
--     capture the current grants before and after.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = '<TABLE>'
order by grantee, privilege_type;

-- 1.9 Required roles and their RLS bypass status.
select rolname, rolbypassrls from pg_roles
where rolname in ('service_role', 'anon', 'authenticated');

-- 1.10 Row count, for sanity and for comparison after the apply. An additive
--      migration must not change this.
select count(*) as row_count_before from public.<TABLE>;


-- =====================================================================
-- PART 2: POST-APPLY. Run immediately after, and archive the output.
-- Making a runtime claim without this is what the gate exists to prevent.
-- =====================================================================

-- 2.1 The object now exists.
select to_regclass('public.<TABLE>') as target_table;

-- 2.2 The column landed with the intended type and nullability.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = '<TABLE>'
  and column_name = '<COLUMN>';

-- 2.3 Indexes and constraints match what the migration declared, and nothing
--     else changed.
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = '<TABLE>';

select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = to_regclass('public.<TABLE>');

-- 2.4 RLS and policies are what 1.7 recorded, plus only the intended changes.
select relname, relrowsecurity, relforcerowsecurity
from pg_class where oid = to_regclass('public.<TABLE>');

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' and tablename = '<TABLE>';

-- 2.5 Grants are narrow. Anything readable by anon or authenticated that was
--     not deliberately granted is a finding, not a detail.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = '<TABLE>'
order by grantee, privilege_type;

-- 2.6 Row count is unchanged for an additive migration.
select count(*) as row_count_after from public.<TABLE>;


-- =====================================================================
-- WORKED EXAMPLES
-- =====================================================================
--
-- The two migrations applied on 2026-07-24 used the minimal form of the
-- above. Recorded here because the smallest honest readback is often just
-- one query, and the point is that it is run and archived, not that it is long.
--
--   company-employee-payto.sql  (add a nullable column)
--     PRE:  select column_name from information_schema.columns
--           where table_name = 'company_employees' and column_name = 'pay_to';
--           -- expected zero rows
--     POST: same query, expected exactly one row
--
--   company-ceo-messages.sql  (create a table with RLS and narrow grants)
--     PRE:  select to_regclass('public.company_ceo_messages');  -- expected null
--     POST: select to_regclass('public.company_ceo_messages');  -- expected the table
--           plus 2.4 and 2.5 above, to prove RLS is on and that delete/update
--           were revoked from service_role as the file intends.
--
-- Record the outcome in PENDING.md as "Applied and read back <date>" with the
-- query used. A row in that table without a readback behind it is a claim,
-- not evidence.
