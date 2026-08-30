# Pending Supabase migrations

This directory contains historical and prepared manual SQL inputs. It is not evidence of the live production schema, migration status, or runtime capability.

The reviewed server-side baseline is `src/lib/db/schema.deploy.sql`. The file `src/lib/db/schema.sql` is a conflicting historical Supabase Auth bootstrap with a different owner type and policy model; it is not an apply target and must not be layered onto the deployment baseline.

## Safety gate

- Never paste or run a file from this directory based on this index alone.
- **Confirm you are in the right Supabase PROJECT before anything else.**
  Production is **`drzuelosizfllruocmly`** (org "Suede AI", project
  "Suede-AI's Project") — the ref this file and
  `runs-trigger-input-and-run-variables.sql` already name, confirmed
  2026-07-27 by fingerprint query. That one project holds Agent Studio's
  tables and Suede Social's, which is why `src/lib/suede-identity.ts` also
  calls it the shared identity project; both descriptions are correct.
  In the same editor session as the apply, run:
  `select current_database(), to_regclass('public.agents'), to_regclass('public.flows'), to_regclass('public.runs'), to_regclass('public.companies');`
  and stop if any is null. Two traps this catches: `auth.users` exists in
  every Supabase project so it proves nothing about location, and a stale
  `agentix` project (`qaprmzqaedopigqkbamy`, org "Volume Bot") has
  agents/flows/runs but NOT companies — it is pre-Phase-9, holds 85 unrelated
  agents, and is not production. Never identify a project from the
  dashboard's Database → Tables list: it lazy-loads, and reading a partial
  page as proof of absence produced a wrong inventory on 2026-07-27.
- Read back production columns, constraints, indexes, policies, privileges, extensions, and relevant row counts first.
- Compare the readback with `src/lib/db/schema.deploy.sql` and stop on any drift.
- Dry-run an unchanged, checksummed file twice in a disposable production-shaped database.
- Require a reviewed migration-specific runbook, explicit production approval, a named operator, and a rollback owner.
- Archive a post-apply readback before making any runtime claim.

`readback-template.sql` in this directory is the starting point for both the pre-apply and post-apply readbacks. Copy it per migration, fill in the placeholders, and delete the sections that do not apply.

Builds, tests, application startup, previews, and deploys never apply SQL from this directory.

## Agent Resource Foundry — prepared, not applied

`agent-resource-foundry.sql` prepares the eight private Resource Foundry tables,
their server-only RLS and grants, immutable snapshot/pack/release/receipt guards,
transactional repository RPCs, and the non-public Resource owner-adoption
helper. The separately prepared Stripe migration owns the hardened public
`agent_studio_adopt_owner_with_connections` wrapper and composes its private
Stripe helper with the Resource helper in the same transaction. Both reviewed
apply orders preserve Resource rows, Stripe authorization, aliases, credits,
and connections. Neither migration has been applied or connected to production
data as part of this work.

The prepared owner read model also exposes a bounded, newest-first release
receipt RPC. Each receipt contains exact pack freshness, access, payout and
settlement readiness, agent/deployment lifecycle state, immutable identifiers,
hashes, and recorded URLs; it never returns pack content or source bodies.

The apply gate must prove the existing owner-adoption and connection functions
match the reviewed prerequisite before replacement. When Stripe is already
installed, the Resource transaction must attest the exact reviewed
`pg_get_functiondef` hashes for both its private adoption helper and public
wrapper before the first Resource DDL. If any Resource table exists, the
migration attests the complete 54-constraint inventory across all eight tables:
stable names, check/primary-key/unique/foreign-key types, validation state, and
canonical `pg_get_constraintdef`. Preflight permits only reviewed additive
gaps: the ten named parity checks converged by this artifact, plus the three
Task 7 receipt checks when all four Task 7 payment columns are absent together;
postflight still requires all 54. Any other missing, extra,
unvalidated, or definition-drifted constraint is a hard stop before durable
Resource DDL. A disposable production-shaped PostgreSQL 17 database
must then prove: blank creation, unchanged second apply, both Resource/Stripe
apply orders, replayed adoption, candidate optimistic-concurrency failure,
immutable approved/live pack content, append-only release/receipt identity,
direct-browser RLS denial, exact canonical hash readback through the application
adapter, and rollback of flows, connections, products, releases, receipts,
Stripe aliases, and credits when any adoption update fails.
Duplicate target-owner slugs are a hard-stop conflict; they must never be
silently merged or allowed to split workspace adoption.

### Separately authorized production sequence

This is a future operating sequence, not approval to run it. The SQL checksum
at this integration commit is
`8367772c30cd392d140516fd951f97aa3c06d1dfdc8b42906c4e2809005bdbb0` (SHA-256).
If the file changes, stop and review a new checksum and diff from the beginning.

1. Obtain explicit production-apply approval for this exact file, a named
   operator, a change window, and a rollback owner. Applying SQL, changing a
   deployment, and enabling Resource execution or settlement are separate
   approvals.
2. In the same production SQL session intended for the apply, identify project
   `drzuelosizfllruocmly` and run the fingerprint query in the Safety gate.
   Stop if any required table is null, if the project identity is ambiguous, or
   if the stale `qaprmzqaedopigqkbamy` project is open.
3. Archive a pre-apply readback of the eight Resource table names and any
   partial state: columns, defaults, constraint names/types/validation states/
   canonical definitions, indexes, triggers, RLS and
   policies, grants, function signatures, owners, `search_path`, definitions,
   and row counts. Also read back the existing request authorizer,
   owner-adoption function, connection wrapper, and their grants. Stop on any
   prerequisite or partial-schema drift.
4. From a clean checkout, run
   `shasum -a 256 docs/migrations/agent-resource-foundry.sql` and compare it to
   the reviewed checksum. Archive the checksum and unchanged file; do not edit
   SQL in the production editor.
5. Apply the prerequisite production baseline, the exact Resource SQL, and the
   separately reviewed Stripe SQL to a disposable production-shaped
   PostgreSQL 17 cluster in both Resource-then-Stripe and Stripe-then-Resource
   order. Replay each migration unchanged. Prove blank creation, complete
   54-constraint preflight/postflight attestation, rejection without catalog
   mutation when an expected same-name constraint is weakened, optimistic
   candidate conflict, approved/Live immutability, append-only release and
   receipt identity, browser-role RLS denial, exact canonical-hash adapter
   readback, replayed adoption, and atomic rollback of Resource rows, Stripe
   aliases, credits, and connections, plus the duplicate-slug hard stop.
   Destroy the disposable cluster after evidence is archived.
6. Only after the separate production approval remains current, apply the exact
   checksummed file as its single transaction. Do not paste fragments, repair
   drift interactively, or apply another pending migration as part of this
   change.
7. If the approved runbook requires it, notify PostgREST to reload its schema.
   Do not use a reload as evidence that schema or privileges are correct.
8. Repeat the complete catalog readback. Confirm exactly the eight tables,
   their reviewed columns, constraints, indexes, immutable triggers, RLS
   policies, grants, RPC signatures/owners/search paths, adoption wrapper, and
   expected row counts. Compare pre- and post-apply inventories and prove no
   partial state or unexpected grants exist.
9. Archive the SQL checksum and pre/post evidence before any runtime claim.
   Do not deploy or enable Resource execution until the environment and
   rollback plan receive their own review. If readback is ambiguous, stop;
   never run destructive rollback against real Resource rows without a new,
   explicit approval.

## AP2 authorization ledger — pending, do not enable

`ap2-authorizations.sql` is prepared but not production evidence. Before
`AP2_MODE` may leave `off`, a named operator must apply it to production project
`drzuelosizfllruocmly` under the safety gate above and archive a readback that
proves the complete column inventory, unique constraints on mandate reference,
payment nonce hash, and checkout hash, required indexes, RLS policies, grants,
and zero pre-existing replay collisions. `AP2_REPLAY_STORE_READY=1` is only an
operator assertion after that readback; the application also calls the
`agent_studio_ap2_replay_store_attestation()` database function and accepts
only the exact `ap2-replay-v2` revision after it rechecks the column inventory,
all three replay uniqueness constraints, RLS policy, and runtime privileges.
Missing, stale, denied, or drifted attestations fail closed. Deployment with `AP2_MODE=off` neither
advertises nor accepts AP2 and does not require this migration.

AP2 support for self-hosted relays additionally requires
`relay-protocol-v2.sql`. Existing relay registrations remain protocol v1 and
continue on the baseline non-AP2 path. A relay may be registered as v2 only
after this additive column/check is applied and after that relay implements a
durable delivery-id claim plus the signed execute/status contract; AP2 refuses
legacy v1 relays before settlement.

## Autonomous Company production gate — cleared 2026-07-18

Jason explicitly approved the production apply and Codex completed it against
Supabase project `drzuelosizfllruocmly`. The migration records are:

- `20260718181115 company_v1_settlements_ledger`
- `20260718181405 company_v1_settlements_restrict_delete`
- `20260718181457 company_v1_guided_atomic_rpc`
- `20260718181536 company_v1_autonomous_company_tables`
- `20260718181841 company_v1_employee_department_index`
- `20260718190755 company_v1_shared_runtime_access`

The gate required and received archived readback for all additive schema
blocks:

1. The `settlements` ledger in `docs/migrations/settlements-ledger.sql` must be
   compared with the current live schema, manually applied under the safety
   gate above, and read back with its columns, primary key, indexes, and RLS
   state verified.
2. The `companies`, `company_departments`, `company_employees`, and
   `company_approvals` block in `src/lib/db/schema.deploy.sql` must separately
   be compared with the current live schema, manually applied under the same
   gate, and read back with its columns (including the employee-history
   `removed_at` tombstone and the approval snapshot columns `action_summary`,
   `cost_basis`, `cost_usdc`, and `cost_note`), foreign keys, indexes (including
   `idx_employees_department` for the department foreign key),
   constraints, defaults, and RLS state verified. The index readback must
   include `idx_runs_company_activity` and `idx_approvals_company_activity`,
   which bound the stable company-activity cursor queries.
3. The `agent_studio_mutate_guided_flow` function in
   `src/lib/db/schema.deploy.sql` must be compared, manually applied, and
   read back with its argument types, millisecond-normalized owner/revision
   predicate and revision write, row locks, all three mutations, rollback
   behavior, and service-role-only execute privileges verified before Guided
   edits use Supabase. The five new tables must likewise show SELECT, INSERT,
   and UPDATE for `service_role`, no DELETE for `service_role`, and no table
   privileges for PUBLIC, `anon`, or `authenticated` under the dedicated
   service-role baseline.
4. Production Agent Studio currently uses the temporary shared-project
   request-secret lane documented in
   `docs/migrations/production-shared-supabase-runtime.sql`. The Company v1
   objects therefore also require the reviewed bridge in
   `docs/migrations/company-v1-production-shared-runtime.sql`: its `anon`
   grants are usable only through the existing
   `agent_studio_private.request_authorized()` RLS policy, which verifies the
   server-only `x-agent-studio-secret` header. Direct browser traffic still
   fails RLS, `authenticated` retains no table access, and DELETE remains
   revoked.

Post-apply catalog evidence confirms all five tables exist with the reviewed
columns, defaults, primary keys, foreign keys, approval checks, RLS enabled,
and zero rows at release time. All ten named release indexes are valid and
ready. The initial dedicated-service-role readback showed zero policies and no
browser-role privileges. The shared-runtime bridge then added the existing
`agent_studio_server_access` request-secret policy to all five tables and
SELECT/INSERT/UPDATE for `anon` and `service_role`, with DELETE still revoked;
PUBLIC and `authenticated` retain no CRUD access. The Guided RPC remains
security-invoker with `search_path=public`; EXECUTE is limited to `anon` and
`service_role`, and the `anon` path remains bounded by the same server-only
request secret and underlying RLS policies.

A rollback-only production fixture verified the valid three-record mutation,
stale-revision no-op, forced-failure atomic rollback, and service-role execute
path, then left zero fixture rows. The post-DDL advisors reported only the
intentional `rls_enabled_no_policy` INFO notices for these server-only tables
and unused-index INFO notices on empty tables; the initially reported
department foreign-key index gap was closed by
`idx_employees_department`. Full evidence and rollback anchors are archived in
the Drive vault release handoff.

## Moderation shared-runtime bridge — applied 2026-07-21

Production migration `20260721060217 moderation_production_shared_runtime`
extends the existing server-only request-secret boundary to
`moderation_reports`. Preflight confirmed the reviewed table shape, indexes,
RLS state, shared-runtime v2 marker, and hardened request authorizer. Readback
confirmed exactly one `agent_studio_server_access` policy for `anon`, only
SELECT/INSERT/UPDATE for `anon` and `service_role`, no DELETE/TRUNCATE/
REFERENCES/TRIGGER for either runtime role, and no PUBLIC or `authenticated`
table access. The live signed report path then created one identifier-only
`open` queue row; direct browser traffic remains outside the server-secret
policy boundary.

## Hosted connections shared-runtime gate — applied 2026-07-21

Codex applied production migration
`20260722003210 connections_production_shared_runtime` to Supabase project
`drzuelosizfllruocmly`. The applied source SHA-256 is
`c04fa86520a871886c1de09e2c21995f66384371ccbebae23540ba37bc0c11d0`.
Preflight confirmed both connection tables were absent, the shared-runtime v2
marker and request authorizer were valid, and the existing owner-adoption
function retained its reviewed owner, search path, and role grants.

The migration extends only the reviewed temporary shared-project runtime; the
connection provider deliberately does not treat a service-role key alone as a
supported configuration. It must remain one unchanged, checksummed transaction
and may run only after preflight confirms the shared-runtime v2 marker, hardened
request authorizer, existing owner-adoption function, and either both connection
tables absent or the complete reviewed table pair present. A partial or drifted
connection table set is a stop.

Archived post-apply readback confirms:

1. The exact `connections` and `connection_slots` column inventories, including
   immutable `crypto_owner_id`, envelope byte bounds, primary/foreign keys, all
   three indexes, both lifecycle triggers, and RLS enabled.
2. The configure, revoke, and bounded usage RPC signatures; security-invoker and
   pinned `search_path` properties; row locks, optimistic revisions, transactional
   lifecycle updates, cursor validation, and artifact/graph/total byte limits.
3. Exactly one `agent_studio_server_access` policy for `anon` on each connection
   table, SELECT/INSERT/UPDATE only for `anon` and `service_role`, no destructive
   grants, no PUBLIC or `authenticated` access, and only the reviewed RPC EXECUTE
   grants.
4. The `agent_studio_adopt_owner_with_connections` wrapper calling the existing
   owner adoption in the same transaction, changing only `owner_id` plus lifecycle
   metadata, and leaving `crypto_owner_id` unchanged so existing ciphertext keeps
   its original authenticated identity.
5. The application environment using one protected 32-byte
   `CONNECTION_ENCRYPTION_KEY` across every instance plus the already-reviewed
   shared request secret. Neither secret may appear in SQL, catalog output, logs,
   screenshots, or handoff text.

The catalog readback found exactly the reviewed two-table shape, 21 columns, 18
constraints, five indexes including both primary keys, two lifecycle triggers,
two request-secret RLS policies, and the seven hardened functions. Runtime table
grants are SELECT/INSERT/UPDATE only for `anon` and `service_role`; PUBLIC and
`authenticated` retain no CRUD access, and the trigger functions retain no
runtime EXECUTE grant. Both tables had zero rows at release time.

A rollback-only production canary configured an encrypted Live envelope under a
backdated timestamp, adopted its mutable access owner without changing
`crypto_owner_id` or envelope bytes, then revoked it under another backdated
timestamp. Database-side monotonic timestamps and lifecycle revisions advanced
as reviewed, and rollback left zero connection or slot rows. Fresh Supabase
security and performance advisors reported no connection-specific findings.
Vercel production has one protected `CONNECTION_ENCRYPTION_KEY` (value never
printed or archived) alongside the reviewed request-secret configuration. Live
route and runtime-log evidence belongs in the release handoff rather than this
schema index.

## Agent Studio Airbyte outcome source — applied and read back 2026-07-29

`agent-studio-airbyte-source.sql` prepares the privacy-safe
`airbyte_source.normalized_agent_outcomes` contract for the Marketing Agent OS.
It does not create a login, connect Airbyte, run a sync, change a deployment,
or expose application tables.

Production migration `20260729141154 agent_studio_airbyte_source_v1` is present
on Supabase project `drzuelosizfllruocmly`. The 2026-07-31 catalog readback
confirmed the private ledger and normalized source view each contain the
predicted 82 rows, all five application capture triggers plus the private
append-only trigger are installed, and the capability role
`suede_agent_studio_airbyte_reader` remains NOLOGIN, NOINHERIT, non-superuser,
without create/database/replication/bypass-RLS privileges. That role has only
the reviewed source-schema usage, normalized-view SELECT, and reader-function
EXECUTE capabilities; it cannot read the private ledger.

The source-specific runbook in
`docs/architecture/airbyte-marketing-source.md` remains authoritative for
connector provisioning and recovery. The completed migration gate included:

1. Read back the exact `agents`, `runs`, `deployments`, `environments`,
   `flow_versions`, and `settlements` shapes and current counts.
2. Verify Supabase Vault and pgcrypto availability without printing secrets.
3. As a non-superuser `CREATEROLE` identity, apply the unchanged migration
   twice, disable triggers, and reapply it against disposable PostgreSQL 17.
   Prove the second apply adds no outcome rows, rollback preserves the ledger,
   view, Vault key, and append-only trigger, and reapply restores all five
   application triggers.
4. Review the append-only private ledger, global transaction-level
   millisecond cursor serialization, HMAC namespaces, convergent settlement
   trigger row locking, exact view order/types, RLS, all-grantee ACL/owner
   normalization, default-ACL assertions, and browser-role revocations.
5. Applying the checksummed file once with a migration-only identity and
   archiving the post-apply catalog readback. A separate least-privilege
   Airbyte login still must be provisioned through a protected channel before
   a connector can use the capability role.
6. Checksum and dry-run
   `agent-studio-airbyte-source-disable-triggers.sql`; the named rollback owner
   must be able to remove and read back all five application-table triggers
   without deleting the ledger, Vault key, source view, or append-only trigger.

The PostgreSQL 17 membership readback must contain only the current
non-superuser `CREATEROLE` migration identity as `ADMIN TRUE, INHERIT FALSE,
SET FALSE` and, after separate login provisioning, the Airbyte login as `ADMIN
FALSE, INHERIT TRUE, SET FALSE`. Either identity with any other option tuple,
or any additional member, is a hard stop.

The 2026-07-31 production readback contains the predicted 82 initial rows: one
draft agent, 29 live agents, 26 Test deployments, and 26 Live deployments.
There were no explicitly triggered successful Test runs and no settlement
rows. Five manual runs must remain excluded rather than being relabeled as
Test evidence.

## Agent Studio Stripe revenue source — prepared, not applied

`agent-studio-stripe-revenue-source.sql` adds a private append-only receipt
ledger, an atomic server-only receipt/credit RPC, forward refund handling, and
the 26-column `airbyte_source.normalized_revenue_events` contract. The
production anon-key path is additionally gated by the existing server-only
Agent Studio request secret. It has not been applied, backfilled, deployed,
connected to Stripe, or synced to Airbyte.

The migration must pass the general safety gate and
`docs/architecture/stripe-revenue-source.md`. In particular:

1. Apply and verify `agent-studio-airbyte-source.sql` first. If the base source
   is later reapplied, reapply the reviewed Stripe revenue migration before
   restoring the revenue sync because the base migration deliberately
   normalizes the reader's grants.
2. Prove only `service_role` and request-secret-authorized `anon` can execute
   the writer RPC, boolean paid-entitlement aggregate, and Stripe-aware adoption
   wrapper; anon calls without the secret are rejected, the original adoption
   function has no runtime grant, the Airbyte reader gets only the hardened
   reader/view, and no runtime role can read either private ledger. The
   owner-only historical helper must have no runtime grant.
3. Verify signed provider USD cents remain separate from gateway credits and
   committed-use bonus; payments export positive cash, refunds export negative
   cash, and x402 USDC settlements remain absent.
4. Dry-run retry/concurrency, partial and full refunds, forced rollback,
   append-only guards, monotonic millisecond cursors, HMAC outputs, exact column
   order/types, and the allowance invariant: partial refund stays eligible,
   full refund becomes ineligible, ordinary spend does not revoke eligibility.
   Include a committed-use bonus split across partial and final refunds against
   the production `numeric(20,8)` credit column to prove both public credit and
   private receipt netting reach exact zero. Mutate public reasons afterward to
   prove entitlement follows immutable receipt linkage. Exercise
   payment-before-adoption, adoption-before-payment,
   chained adoption, canonical-equivalent retry, and post-adoption replay under
   the shared advisory lock. Prove a joined 31-edge alias path works and edge
   32 is rejected before any credit, connection, or alias mutation. Use
   disposable PostgreSQL 17.
5. Treat the exactly-two-session template as a mechanism, not evidence. A
   protected operator must independently verify both paid, non-refunded $5 USD
   sessions and bind the populated JSON without printing or archiving any raw
   provider or owner identifier. Invoke the owner-only helper through the
   authenticated linked database query path with the populated request
   constructed only in process memory; do not create a public/runtime wrapper.
   Invocation is a separately approved production write.
6. Archive only aggregate and catalog readback before deploying the webhook or
   configuring the Airbyte stream. Configure terminal payment and refund event
   subscriptions only after the writer exists.
7. Checksum and dry-run
   `agent-studio-stripe-revenue-source-disable-writes.sql`; the rollback owner
   must be able to revoke runtime writes without deleting the ledger, Vault
   identity, view, or Airbyte reader access.
8. Keep the Agent Studio Airbyte connection disabled until Marketing deploys
   and verifies the distinct
   `airbyte_landing.agent_studio_stripe_normalized_revenue_events` physical
   binding for source prefix `agent_studio_stripe_`. The existing Promo Stripe
   landing binding is not interchangeable.
9. If `connections-production-shared-runtime.sql` or
   `production-shared-supabase-runtime.sql` is reapplied, immediately reapply
   the unchanged Stripe revenue migration before restoring card writes. Those
   older migrations can replace the Stripe-aware adoption wrapper or restore
   direct runtime access to the base adoption function.

## File register

| File | Status | Notes |
| --- | --- | --- |
| `prospect-engine-records.sql` | Applied and read back 2026-08-09 | Private owner-scoped Prospect Engine queue, digest-bound lifecycle records, minimal hashed recipient suppression registry, atomic opt-out RPC, and owner-scoped redaction RPC. Verified by an authoritative synthetic create/read/redact canary with zero canary rows retained. |
| `prospect-engine-production-shared-runtime.sql` | Applied and read back 2026-08-09 | Extends the existing server-only request-secret RLS boundary to `prospect_records` for the production anon-key bridge, with fail-closed shape, policy, index, constraint, and privilege readback. The request secret was coordinated with Vercel production; no browser or DELETE access was granted. |
| `phase-1-projects-and-versions.sql` | Prepared; PostgreSQL execution **SKIP**; not applied | Phase 1 gate is documented in `docs/architecture/phase-1-versioning.md`. Supabase Phase 1 runtime support is unavailable. |
| `phase-2d-workbook-flow-tabs.sql` | Prepared; PostgreSQL execution **SKIP**; not applied; SQLite runtime only | Mirrors the SQLite v7 workbook-tab shape for future reviewed manual use. It is unreachable from application and verification paths. |
| `phase-2d-subflow-impact-receipts.sql` | Prepared; PostgreSQL execution **SKIP**; not applied; SQLite runtime only | Mirrors the SQLite v8 one-use owner-scoped breaking-impact receipt store. It is unreachable from application and verification paths. |
| `phase-2d-subflow-api-read-indexes.sql` | Prepared; PostgreSQL execution **SKIP**; not applied; SQLite runtime only | Mirrors the SQLite v9 bounded keyset read indexes. It is unreachable from application and verification paths. |
| `phase-8-relay.sql` | Applied — confirmed live 2026-07-21 | Read back via `to_regclass('public.relay_endpoints')`: table exists in production. |
| `phase-9-billing.sql` | Applied — confirmed live 2026-07-21 | Read back via `to_regclass`/`information_schema.columns`: `usage`, `credits` tables and `runs.settled_at`, `agents.settlement_live` columns all exist in production. |
| `settlements-ledger.sql` | Applied and read back 2026-07-18 | Production migration `20260718181115`; least-privilege correction `20260718181405`. |
| Autonomous Company block in `src/lib/db/schema.deploy.sql` | Applied and read back 2026-07-18 | Production migrations `20260718181457`, `20260718181536`, and `20260718181841`; catalog, privilege, advisor, and rollback-only fixture gates passed. |
| `company-v1-production-shared-runtime.sql` | Applied and read back 2026-07-18 | Production migration `20260718190755`; extends the existing request-secret RLS boundary to Company v1 without granting DELETE or authenticated-browser access. |
| `moderation-production-shared-runtime.sql` | Applied and read back 2026-07-21 | Production migration `20260721060217`; extends the existing request-secret RLS boundary to `moderation_reports`, normalizes runtime ACLs to SELECT/INSERT/UPDATE only, and keeps direct browser and destructive access closed. |
| `connections-production-shared-runtime.sql` | Applied and read back 2026-07-21 | Production migration `20260722003210`; hosted encrypted connection persistence, transactional slot and bounded-usage RPCs, shared request-secret RLS/ACLs, owner adoption preserving `crypto_owner_id`, rollback-only canary, and catalog/advisor gates passed. |
| `runs-trigger-input-and-run-variables.sql` | Applied and read back 2026-07-21 | `runs.trigger_input` / `runs.run_variables` (both `jsonb`, nullable) from schema.deploy.sql lines 176-177 / PR #119. Applied by Jason via the Supabase SQL editor after production error confirmation (Vercel runtime error on `createRun`, `/api/agents/[agent]/run`, 6 occurrences 2026-07-21T02:44:45Z–03:06:55Z). Verified fixed via a live dry-run call to a published agent (200 + runId, no schema-cache error) and a clean `get_runtime_errors` window afterward. |
| `company-employee-payto.sql` | Applied and read back 2026-07-24 | Additive `company_employees.pay_to` (SQLite migration 32 equivalent) for individual employee wallets. Applied by Jason via the Supabase SQL editor under the manual gate; read back via `information_schema.columns` returning the `pay_to` row. `resolvePayout` now honors per-employee wallets in production; funds remain 100% creator-side (`payout_source = 'creator'`) — unrelated to the gated platform-take custody decision. |
| `company-ceo-messages.sql` | Applied and read back 2026-07-24; table creation only | `company_ceo_messages` table (SQLite migration 31 equivalent) for append-only CEO chat history. The table existed with RLS enabled, but production later used the anon-key + request-secret shared runtime while this initial file granted only `service_role`; the adapter therefore swallowed permission failures and reload history stayed empty until the dedicated bridge below. |
| `company-ceo-messages-production-shared-runtime.sql` | Applied and read back 2026-08-14 | Production migration `20260814061444 agent_studio_company_ceo_messages_shared_runtime_v1`; source SHA-256 `f4766f57e214cc217d07c7443ad157492d386298c38d34b6f97e2c9411982739`. The exact seven-column/three-constraint/two-index table contract, PostgreSQL 17 identity sequence, RLS state, shared-runtime-v2 marker, unchanged authorizer hash, existing Company policy template, and pre-state ACLs were asserted before mutation. Post-state has exactly one `anon` request-secret policy, SELECT/INSERT table grants for `anon` and `service_role`, USAGE-only sequence grants for those roles, and no `authenticated` access. A production HTTP canary persisted one user/assistant turn across a fresh GET in sequence order, returned 404 to another owner, and was then removed with zero-row cleanup readback. |
| `company-ceo-shared-runtime-contract-v1.sql` | Applied and read back 2026-08-14 | Validation-only production migration `20260815014851 agent_studio_company_ceo_shared_runtime_contract_v1`; source SHA-256 `aa4f2911a12d6f2a0522f386042452cfa94d9597e7a0c3f79e0cc7e34edef748`. It recorded no persistent SQL changes and passed exact production fingerprint, CEO table/sequence/policy/ACL, private-schema owner/ACL, authorizer owner/definition/config/ACL, and shared-runtime marker owner/RLS/row/policy/ACL checks. Fresh readback retained CEO RLS, one request-authorized policy, intended `anon` SELECT/INSERT grants, no `authenticated` table access, one protected marker row, and zero CEO rows. The original applied bridge checksum remains unchanged. |
| `settlement-live-default-false.sql` | Applied and read back 2026-07-31 | Production migration `20260731052658 agent_studio_settlement_live_default_false`; source SHA-256 `ea71f4062076652391915b67faadd430e94a45742d84defab088facbfd59ef53`. The ongoing column default is FALSE. Existing rows were unchanged: 3 settlement-live, 27 off. |
| `health-checks.sql` | Applied and read back 2026-07-31 | Production migration `20260731052820 agent_studio_health_checks_v1`; source SHA-256 `226c32fc85e80609fcf568c0ed8ca7fc6753881988a7b38bf2cfa86db1c05258`. Exact nine-column shape, primary key, descending time index, RLS, request-secret policy, and append-only SELECT/INSERT runtime grants read back cleanly; zero rows at apply time. |
| `site-verifications.sql` | Applied and read back 2026-07-31 | Production migration `20260731052727 agent_studio_site_verifications_v1`; source SHA-256 `68a968a9ce75169b4ba066116712d105ffa54df4a789d0c760121677781b5076`. Exact four-column shape and owner/host primary key, RLS, request-secret policy, and SELECT/INSERT/UPDATE runtime grants read back cleanly; zero rows at apply time. |
| `agent-studio-airbyte-source.sql` | Applied and read back 2026-07-29 | Production migration `20260729141154 agent_studio_airbyte_source_v1`. The 2026-07-31 catalog readback found 82 private-ledger rows, 82 normalized-view rows, all six triggers, the strict NOLOGIN capability role, and no private-ledger SELECT for that role. No raw graph/run/error/identity/wallet/transaction data is exported. Connector login and sync activation are separate gates. |
| `agent-studio-airbyte-source-disable-triggers.sql` | Prepared emergency rollback; **not applied** | Transactionally removes and verifies the five synchronous application-table capture triggers while preserving the append-only ledger, HMAC key, source view, reader capability, and private mutation guard. |
| `agent-studio-stripe-revenue-source.sql` | Prepared; **not applied** | Private append-only Stripe topup/refund and owner-adoption evidence, atomic receipt-plus-credit RPC, delayed-webhook owner resolution, guarded paid-entitlement aggregate, USD-cent cash independent of gateway bonus, Vault-HMAC 26-column revenue view, strict reader/runtime ACL split, and owner-only exact-two-session bridge. No x402 settlement or raw provider/owner identifier is exported. |
| `agent-studio-stripe-revenue-backfill-request.template.json` | Prepared placeholder only; **contains no production identifiers** | Deterministic two-slot, 1,000-cent request shape for separately approved protected backfill of exactly two verified paid $5 USD sessions. Never populate this checked-in file. |
| `company-org-roles-heartbeat.sql` | Prepared; **not applied** | Additive `company_employees` columns `role`, `reports_to`, `lifecycle_status`, `heartbeat_enabled`, `heartbeat_interval_seconds`, `last_heartbeat_at` (SQLite migration 36 equivalent) plus the `company_employee_instructions` table (SQLite migration 37 equivalent). Every column is nullable with no default and the migration backfills nothing: `role` NULL is resolved by `src/lib/company/roles.ts`, not replaced with `'worker'`, because defaulting legacy rows would make every already-founded company read as zero-CEO/all-orphans. `lifecycle_status` deliberately has no `'terminated'` value — removal remains the `removed_at` tombstone. Until it is applied, `SupabaseRepo.addEmployee` omits every key still at its column default (not merely every `undefined` key, which would break the read-then-re-add path, since reads populate all six) so hires keep writing exactly the eight pre-existing columns, and reads fall back to role NULL / no manager / `'idle'` / no heartbeat. The instructions table is not covered by `company-v1-production-shared-runtime.sql`; extend that bridge under its own gate before the anon request-secret lane touches it. |
| `agent-studio-stripe-revenue-source-disable-writes.sql` | Prepared emergency rollback; **not applied** | Revokes both service-role and protected-anon Stripe receipt writer grants while preserving guards, the private ledger, HMAC identity, normalized view, and Airbyte reader contract. |

This index deliberately contains no paste-ready SQL, direct apply steps, or activation promises.
