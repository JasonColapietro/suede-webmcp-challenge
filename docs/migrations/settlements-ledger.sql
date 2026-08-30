-- Prepared manual input: settlements accounting ledger (SQLite migration 21
-- equivalent). Mirrors the settlements block in src/lib/db/schema.deploy.sql.
-- Subject to the full safety gate in PENDING.md — live readback, drift check,
-- dry run, explicit production approval. Additive only; no data backfill.
-- Until applied, recordSettlement in src/lib/db/supabase-repo.ts logs the
-- write failure and continues (dark-deploy safe by design).

create table if not exists settlements (
  run_id text primary key,
  agent_id text not null,
  owner_id text not null,
  gross_usdc real not null,
  creator_usdc real not null,
  platform_usdc real not null,
  pay_to text not null,
  payout_source text not null,
  payer text,
  tx text,
  created_at text not null
);
create index if not exists idx_settlements_owner on settlements (owner_id);
create index if not exists idx_settlements_agent on settlements (agent_id);

alter table settlements enable row level security;

-- Server-only Data API access. New Supabase tables are not guaranteed to
-- receive implicit grants, and browser roles must not read accounting rows.
revoke all privileges on table public.settlements
from public, anon, authenticated;
grant select, insert, update on table public.settlements
to service_role;
revoke delete on table public.settlements
from service_role;
