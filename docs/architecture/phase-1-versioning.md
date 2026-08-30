# Phase 1 project and version persistence

Phase 1 adds project organization, immutable flow versions, dependency pins, environments, and deployment history. Local SQLite support is complete through migrations 5 (`projects-and-versions`) and 6 (`deployment-integrity`). Supabase SQL is prepared for an operator-reviewed manual migration, but the Supabase runtime is unavailable in this phase and the SQL has not been applied.

**PostgreSQL execution status: SKIP — no PostgreSQL or Supabase connection was made, and the prepared SQL was not applied.**

## Sources of truth

- `src/lib/db/migrations/sqlite.ts` is the executable source of truth for local SQLite. Migrations 5 and 6 own nine Phase 1 tables, fourteen explicit indexes, twelve foreign keys, scoped uniqueness, and the single-active-deployment invariant.
- `src/lib/db/schema.deploy.sql` is the authoritative checked-in baseline for the current server-side Supabase ownership model: UUID `flows.id`, text owner identifiers, service-role access, and RLS with no public policies.
- `docs/migrations/phase-1-projects-and-versions.sql` is an additive, idempotent, manual operator input mirroring SQLite migrations 5 and 6 with Postgres-native UUID, `jsonb`, and `timestamptz` types.
- `src/lib/db/schema.sql` is a conflicting historical Supabase Auth bootstrap. It uses `auth.users`, UUID owner columns, client policies, and a public live-agent policy. It is reference material only and must not be treated as the deployment baseline.
- A fresh production schema readback overrides every checked-in SQL file and is required before the Phase 1 migration can be approved.

No build, test, application-startup, preview, or deploy command applies SQL under `docs/migrations/` or either checked-in schema file.

## SQLite and Postgres mapping

The Postgres migration preserves the SQLite v5/v6 relationships and constraints while translating storage types:

| SQLite | Postgres | Notes |
| --- | --- | --- |
| entity IDs as `TEXT` | `uuid` | Phase 1 foreign keys bind to the production `flows.id uuid` baseline. |
| `personal_owner_id TEXT` | `text` | Deliberately remains text; it is not an `auth.users` UUID. |
| graph JSON as `TEXT` | `jsonb` | Immutable flow-version graph snapshots. |
| millisecond timestamps as `INTEGER` | `timestamptz` | Server defaults use `now()`; repository adaptation is required before hosted runtime support. |

The nine tables are `organizations`, `workspaces`, `projects`, `workbooks`, `environments`, `flow_project_bindings`, `flow_versions`, `dependency_pins`, and `deployments`. The migration names all seven scoped unique constraints and all twelve foreign keys. Its fourteen explicit indexes include the unique `(project_id, kind)` environment index, the partial single-active `(flow_id, environment_id) where retired_at is null` deployment index, and descending deployment history lookup.

RLS is enabled on all nine tables. The migration creates no policies, revokes table access from `public`, `anon`, and `authenticated`, and grants table access only to `service_role`. Application routes must continue to enforce owner isolation server-side. This is not permission to expose the service-role key to a client.

## Mandatory production gate

The migration must not be run until an authorized operator completes every gate below in a non-production clone first.

### 1. Read back production

Export or query, at minimum:

- server version and enabled extensions, including availability of `gen_random_uuid()`;
- `information_schema.columns` for `flows` and all nine proposed Phase 1 tables;
- `pg_constraint`, `pg_indexes`, `pg_policies`, and table privileges for those tables;
- row counts and representative non-secret types for existing Phase 1-named tables;
- confirmation that `flows.id` is `uuid` and that the live ownership model matches `schema.deploy.sql`, not historical `schema.sql`.

Stop if any Phase 1 table already exists with a different column, type, nullability, constraint, index, policy, or privilege shape. Reconcile that drift in a newly reviewed migration; do not edit around it in the SQL Editor.

### 2. Dry-run preflight

Restore the readback into a disposable Postgres/Supabase project. Run `docs/migrations/phase-1-projects-and-versions.sql` there twice. Both runs must commit successfully and produce identical schema readbacks.

The SQL itself performs required shape, duplicate, and orphan checks before adding constraints. It aborts for:

- a missing `flows` table or non-UUID `flows.id`;
- missing, additional, mistyped, or incorrectly nullable Phase 1 columns;
- duplicate personal owners, scoped slugs, environment kinds, version numbers, dependency pins, or active deployments;
- any of the twelve orphan relationship cases.

The transaction, bounded five-second lock timeout, bounded sixty-second statement timeout, and transaction-scoped advisory lock prevent indefinite waits, partial application, or concurrent application. A failed preflight rolls back the entire attempt.

### 3. Approval and manual apply

Record the production readback checksum, disposable dry-run evidence, exact SQL checksum, reviewer, operator, maintenance window, and rollback/restore owner. Obtain explicit production approval. Only then may the authorized operator paste the unchanged migration into the Supabase SQL Editor and run it once.

This repository task does not grant apply authority. The SQL prepared here was not connected to Supabase and was not applied.

### 4. Post-apply checks

Immediately read back and archive evidence that:

- all nine tables exist with the documented types and nullability;
- all seven named unique constraints, twelve named foreign keys, and fourteen explicit indexes exist with their expected definitions;
- `uq_deployments_active_flow_environment` remains a partial index with `retired_at is null`;
- RLS is enabled on all nine tables, `pg_policies` returns no policies for them, and only `service_role` has application table privileges;
- duplicate and orphan queries return zero rows;
- a second transaction on the disposable clone remains idempotent;
- legacy v1 behavior remains available and hosted v2 still reports capability unavailable until a reviewed Supabase repository/runtime implementation is shipped.

If any check differs, stop the rollout and restore from the approved backup procedure. Do not claim hosted Phase 1 persistence from the presence of tables alone.

## Historical Task 7 UI evidence

Reuse the existing Drive artifact folder `05_handoffs/artifacts/2026-07-10-agent-studio-phase1-task7-final`; do not rewrite it. Its manifest binds clean commit `b91ebfbae0b881b5460f85f23bcbdd8956435451`, tree `eedc89cca8e0d650af433bde7dc306b0e4743d51`, and `dirty: false`. Rebased commit `d4858b6` is patch-id equivalent (`5340d9fc74de0ff6e653eeea7fec469c57112869`), but its build-page tree differs because its upstream parent differs. The folder is accepted historical Task 7 UI evidence, not rebound evidence or proof of the current tree. Task 9 captures no new screenshots.
