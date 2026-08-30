# Agent Studio marketing outcome source

`airbyte_source.normalized_agent_outcomes` is the only Agent Studio relation
approved for the Marketing Agent OS PostgreSQL source. It exports bounded
product outcomes, not application rows.

The prepared migration is
`docs/migrations/agent-studio-airbyte-source.sql`. Builds and application
startup never apply it. Production application requires the manual gate in
`docs/migrations/PENDING.md`, an operator-owned rollback, and a post-apply
catalog readback.

## Evidence contract

| Event | Stage | Source evidence | Export condition |
| --- | --- | --- | --- |
| `agent_drafted` | `activation` | `agents` | Current/transitioned status is exactly `draft` |
| `agent_published` | `retained` | `agents` | Current/transitioned status is exactly `live` |
| `test_run_completed` | `qualified` | `runs` | Stored trigger is exactly `test` and status is exactly `done` |
| `test_deployed` | `qualified` | `deployments` + `environments` | Immutable environment kind is `test` |
| `live_deployed` | `retained` | `deployments` + `environments` | Immutable environment kind is `live` |
| `paid_call_settled` | `revenue` | `settlements` + `runs` | A settlement row exists and the matching run has `settled_at` |

Manual runs are not Test evidence. Agent status is not settlement evidence.
Price, potential earnings, `settlement_live`, and a transaction-shaped string
are not settlement evidence. The adapter does not fabricate an event when its
source proof is absent.

The initial snapshot emits one current-state event per existing agent, every
historical Test/Live deployment, successful explicit Test runs, and terminal
settlements. After the migration, triggers append only newly committed
transitions. The settlement-insert trigger locks the matching `runs` row before
it checks `settled_at`; an update of `runs.settled_at` already holds that same
row lock. This serializes both evidence write orders so the later observer
emits exactly one terminal event after the earlier transaction commits.

Because the legacy agent table has no publication timestamp, its current-state
backfill uses the migration statement time as the honest observation time for
both Draft and Live state. It does not mislabel `agents.created_at` as a
historical publication time. Post-migration agent inserts use their stored
creation time and status transitions use the database clock.

A completed legacy Test run without `finished_at` is likewise observed at the
migration statement time; a new completion without `finished_at` uses the
trigger-time database clock. `started_at` is never presented as a completion
timestamp.

## Cursor and idempotency

The private ledger serializes every writer on one transaction-level advisory
lock. It assigns:

```text
source_revision_at =
  max(
    millisecond(clock_timestamp()),
    millisecond(occurred_at),
    prior_cursor + 1 millisecond
  )
```

The advisory lock is held until commit. A second transaction cannot receive a
later cursor and commit before the transaction that owns the earlier cursor.
Every cursor is unique and both exported timestamps are pinned to millisecond
precision for the Marketing landing contract.

`event_id`, the private dedupe key, and `account_key` are HMAC-SHA-256 values.
The 32-byte key is generated in PostgreSQL and stored in Supabase Vault as
`suede_agent_studio_airbyte_identity_hmac_v1`. No raw key material is in Git,
the view, Airbyte, or the warehouse. Re-reading a committed ledger row returns
the same deterministic identifiers.

Do not rotate, replace, or delete that identity key in place. Its continuity is
part of the event-ID contract; changing it would fork pseudonymous identities
and dedupe keys. Back it up and recover it only through the approved Vault
procedure without printing its value.

## View schema

The source view has this exact order:

| Column | PostgreSQL type | Contract |
| --- | --- | --- |
| `event_id` | `text` | Lowercase 64-character HMAC |
| `occurred_at` | `timestamptz(3)` | Millisecond-normalized source outcome time |
| `source_revision_at` | `timestamptz(3)` | Unique millisecond commit-serialized cursor |
| `project_id` | `text` | Constant `suede-agent-studio` |
| `event_name` | `text` | One of the six evidence events above |
| `lifecycle_stage` | `text` | `activation`, `qualified`, `retained`, or `revenue` |
| `channel` | `text` | Constant `product` |
| `anonymous_person_key` | `text` | Always null |
| `account_key` | `text` | Lowercase 64-character flow HMAC |
| `campaign_id` | `text` | Always null |
| `ad_set_id` | `text` | Always null |
| `ad_id` | `text` | Always null |
| `creative_id` | `text` | Always null |
| `utm_source` | `text` | Always null |
| `utm_medium` | `text` | Always null |
| `utm_campaign` | `text` | Always null |
| `utm_content` | `text` | Always null |
| `click_id` | `text` | Always null |
| `session_key` | `text` | Always null |
| `touch_order` | `integer` | Always null |
| `attribution_model` | `text` | Always null |
| `plan` | `text` | Always null |
| `product_version` | `text` | Version number for deployment events; otherwise null |
| `template_id` | `text` | Always null |
| `experiment_id` | `text` | Always null |
| `variant_id` | `text` | Always null |
| `outcome` | `text` | Bounded evidence outcome |
| `state` | `text` | Bounded source state |
| `delivery_state` | `text` | `test`, `live`, `terminal`, or null |
| `campaign_ref` | `text` | Always null |
| `lead_quality_score` | `integer` | Always null |

The adapter never reads or returns flow graphs, run inputs/variables, step
outputs, errors, owner identifiers, slugs, names, email, phone, wallets, payer,
pay-to addresses, transaction identifiers, message bodies, access tokens, API
keys, or other secrets.

## Database identities

The migration creates only
`suede_agent_studio_airbyte_reader NOLOGIN NOINHERIT`. That capability role
receives:

- `USAGE` on `airbyte_source`;
- `SELECT` on `airbyte_source.normalized_agent_outcomes`; and
- `EXECUTE` on the same-shape reader function used by the security-invoker
  view.

It receives no privilege on `public`, `airbyte_source_private`, the private
ledger, Vault, source tables, mutating routines, or default ACLs. `PUBLIC`,
`anon`, `authenticated`, and `service_role` receive no source-view privilege.

The migration intentionally does not create a login. After the migration and
ACL readback pass, a database operator creates a separate secret-bearing login
through a protected SQL session:

```sql
create role suede_agent_studio_airbyte_login
  login
  inherit
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls
  connection limit 2
  password '<inject a generated password out of band>';

grant suede_agent_studio_airbyte_reader
  to suede_agent_studio_airbyte_login
  with admin false, inherit true, set false;

alter role suede_agent_studio_airbyte_login
  set default_transaction_read_only = 'on';
alter role suede_agent_studio_airbyte_login
  set statement_timeout = '60s';
alter role suede_agent_studio_airbyte_login
  set lock_timeout = '5s';
```

On PostgreSQL 17, a non-superuser migration identity with `CREATEROLE`
automatically receives an administrative membership in each role it creates.
The migration pins that creator membership to exactly `ADMIN TRUE, INHERIT
FALSE, SET FALSE`, so it can manage the capability without gaining its runtime
authority. Preflight and postflight allow that membership only for the current
non-superuser `CREATEROLE` migration identity. The only other allowed member is
the separately provisioned Airbyte login above, with exactly `ADMIN FALSE,
INHERIT TRUE, SET FALSE`; every other member or option tuple is rejected.

Never put the password in this repo, a migration body, a shell command, logs,
screenshots, or handoffs. Store it directly in the approved credential store
and Airbyte secret field. Rotate it with `ALTER ROLE ... PASSWORD` in the same
protected channel.

Before accepting the login, verify that it has exactly one granted role, no
direct table/function/default-ACL grants, no administrative attributes, and
no executable `SECURITY DEFINER` routine granted through `PUBLIC` in a
user-controlled schema. A role cannot opt out of privileges granted to
`PUBLIC`, so that audit is part of the login gate.

## Manual apply and readback

1. Confirm Supabase project `drzuelosizfllruocmly` and read back the exact
   source table columns, constraints, triggers, ACLs, extensions, and counts.
2. Checksum the unchanged migration and, as a non-superuser `CREATEROLE`
   identity, run it twice, disable triggers, and reapply it in a disposable
   PostgreSQL 17 database. The second run must add zero rows; rollback must
   preserve the ledger, view, Vault key, and append-only trigger; reapply must
   restore all five application triggers. Catalog readback must show only the
   exact admin-only creator membership and, when provisioned, the exact
   functional login membership described above.
3. Apply the exact file once as a named migration,
   `agent_studio_airbyte_source_v1`, with the authorized migration identity.
4. Read back the private table shape/RLS state, all six triggers, the view
   order/types/security options, the Vault secret count, and effective
   privileges. Run Supabase security and performance advisors.
5. Provision and verify the login separately. Store the generated password
   without printing it.
6. Configure Airbyte to discover only:

```text
schema: airbyte_source
stream: normalized_agent_outcomes
cursor: source_revision_at
destination prefix: agent_studio_db_
destination table:
  airbyte_landing.agent_studio_db_normalized_agent_outcomes
```

Use incremental append with dedupe on `event_id`. The Marketing contract is:

```text
source: agent_studio_db
stream: normalized_agent_outcomes
adapter: airbyte-agent-studio-outcomes/v1
```

7. Run one manual sync. Verify row counts and HMAC formats without selecting
   private source fields. Bridge the exact landing table, promote its immutable
   window, and verify the canonical heartbeat/checkpoint/audit.

The disposable two-connection settlement regression requires local PostgreSQL
binaries and is explicit rather than part of the database-free default suite:

```bash
AGENT_STUDIO_AIRBYTE_POSTGRES_INTEGRATION=1 \
  npx vitest run tests/db/agent-studio-airbyte-source-postgres.test.ts
```

The production-major compatibility gate runs the same assertions in a
disposable `postgres:17-alpine` container:

```bash
AGENT_STUDIO_AIRBYTE_POSTGRES17_INTEGRATION=1 \
  npx vitest run tests/db/agent-studio-airbyte-source-postgres.test.ts
```

## Emergency trigger-disable rollback

The reviewed rollback file is
`docs/migrations/agent-studio-airbyte-source-disable-triggers.sql`. Run its
checksummed bytes with the migration-only identity when adapter capture is
blocking or materially delaying primary application writes. It takes both
adapter advisory locks, removes the five synchronous triggers from `agents`,
`runs`, `deployments`, and `settlements`, and fails unless catalog readback
confirms that all five are absent.

This rollback deliberately preserves the append-only ledger, its identity key,
the source view, and the reader capability. Existing rows remain readable, but
no new application outcomes are captured while the triggers are disabled.
Record the disable time, stop or clearly mark downstream syncs stale, and audit
the source gap before reactivation. Re-enable only by rerunning the unchanged
primary migration through the full disposable double-run and production
readback gate; do not hand-create individual triggers.

## Read-only production snapshot

The source was inspected read-only on 2026-07-29 before this migration was
applied:

| Evidence | Rows |
| --- | ---: |
| Draft agents | 1 |
| Live agents | 29 |
| Completed explicit Test runs | 0 |
| Completed manual runs | 5 |
| Completed paid-agent runs | 42 |
| Test deployments | 26 |
| Live deployments | 26 |
| Terminal settlements | 0 |

Expected initial source-view rows are therefore 82: 30 agent-state outcomes
plus 52 deployment outcomes. The five manual runs remain manual and produce no
`test_run_completed` row. The snapshot is evidence for review, not proof that
the migration, login, Airbyte source, sync, bridge, or promotion is live.
