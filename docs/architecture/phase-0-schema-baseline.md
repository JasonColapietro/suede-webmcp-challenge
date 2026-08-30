# Phase 0 schema baseline

Phase 0 establishes a deterministic local SQLite migration history without changing the deployed Supabase schema. Application builds, tests, and local startup must never apply SQL to a remote database.

## Sources of truth

- `src/lib/db/migrations/sqlite.ts` is the executable migration ledger for local SQLite databases.
- `src/lib/db/schema.deploy.sql` describes the current server-side Supabase deployment shape. It is a reviewed deployment input, not an automatic migration.
- `src/lib/db/schema.sql` is the older Supabase Auth/RLS bootstrap. It remains historical reference until the authentication model is intentionally reconciled.
- `docs/migrations/PENDING.md` records historical migration intent. Its statements must not be treated as proof that production has or lacks a column or table.
- A fresh production schema readback is required before preparing or applying any Supabase SQL. The live database overrides every checked-in schema document.

## SQLite migration ledger

SQLite records successful migrations in `schema_migrations`, including a definition checksum. Each migration runs in its own transaction and writes its ledger row only after the migration succeeds. Startup rejects renamed, reordered, changed, or unknown future migrations; older ledgers receive checksums only after their version/name prefix is verified.

| Version | Name | Purpose |
| --- | --- | --- |
| 1 | `initial-core` | Flows, agents, runs, run steps, schedules, and wallets |
| 2 | `relay-usage-credits` | Relay endpoints, usage ledger, and credits |
| 3 | `settlement-columns` | Live-settlement flag and run settlement timestamp |
| 4 | `webhook-endpoints` | Hashed inbound webhook credentials |

The runner supports blank databases, upgrades legacy unversioned databases in place, preserves existing rows, and is idempotent. `settlement_live` deliberately defaults to `1`; changing that default would silently bypass the payment gate for existing priced agents.

## Safety boundary

- `npm test`, `npm run build`, and application startup may initialize or upgrade only the configured local SQLite database.
- No build, test, preview, or deployment command applies `schema.sql`, `schema.deploy.sql`, or files under `docs/migrations/` to Supabase.
- Supabase changes require an explicit production schema readback, a reviewed additive migration, an operator-approved apply step, and a post-apply readback.
- Phase 1 owns the new workspace, project, environment, flow-version, and related collaboration tables. Those tables are not smuggled into the Phase 0 baseline.
