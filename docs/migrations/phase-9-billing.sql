-- Phase 9 — Billing / Metering / Settlement Toggle
-- Apply via Supabase dashboard SQL editor (Settings → SQL Editor).
-- All statements are additive and idempotent.

-- 1. Usage ledger: gateway LLM token consumption per workspace.
create table if not exists usage (
  id text primary key,
  owner_id text not null,
  kind text not null,           -- 'llm' | 'run' (extensible)
  units integer not null,       -- token count for 'llm', step count for 'run'
  cost_usdc real not null,      -- derived via gatewayCostUsdc(units) at write time
  created_at text not null      -- ISO-8601 UTC timestamp
);

alter table usage enable row level security;

-- 2. settled_at on runs: stamp ISO timestamp when a run was actually settled.
--    Nullable — null means dry-run or not yet settled.
alter table runs add column if not exists settled_at text;

-- 3. settlement_live on agents: per-agent settlement OPT-OUT toggle.
--    Default TRUE — settlement is already live globally; owners toggle OFF per agent.
alter table agents add column if not exists settlement_live boolean not null default true;

-- 4. Gateway credit ledger.
--    Positive delta_usdc = topup, negative = debit.
create table if not exists credits (
  id text primary key,
  owner_id text not null,
  delta_usdc real not null,   -- positive for topup, negative for debit
  reason text not null,       -- 'topup' | 'node:<nodeType>' | 'manual'
  tx text,                    -- on-chain transaction hash (null for non-x402 credits)
  created_at text not null    -- ISO-8601 UTC timestamp
);

alter table credits enable row level security;
