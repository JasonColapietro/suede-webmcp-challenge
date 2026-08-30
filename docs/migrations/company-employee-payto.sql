-- Individual employee wallets — additive column on company_employees.
-- Mirrors the pay_to column in src/lib/db/schema.deploy.sql (SQLite
-- migration 32 equivalent, src/lib/db/migrations/sqlite.ts).
--
-- MANUAL SAFETY GATE (docs/migrations/PENDING.md): do not run without the
-- full readback/dry-run/runbook/approval procedure. Until applied:
--   - reads are dark-deploy safe (supabase-repo maps a missing pay_to to
--     null, so every employee settles to the founder wallet as before);
--   - hires stay safe (addEmployee omits pay_to when null);
--   - the ONLY affected surface is setting a wallet: PATCH
--     /api/companies/[id]/employees/[agentId] with payTo fails loudly (500)
--     rather than silently dropping the address.
-- resolvePayout (src/lib/payout.ts) prefers this address when set; routed
-- funds remain 100% creator-side (settlements.payout_source = 'creator').
-- No change to the platform-take custody question (split-collection brief).

alter table company_employees add column if not exists pay_to text;
