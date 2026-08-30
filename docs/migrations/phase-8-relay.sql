-- Phase 8 — Relay: self-hosted agents earn via Suede
-- Apply this to prod Supabase BEFORE deploying the Phase 8 build.
-- Safe to apply with CREATE TABLE IF NOT EXISTS — idempotent.

create table if not exists relay_endpoints (
  agent_id text not null,
  url text not null,
  secret text not null,
  created_at text not null,
  unique (agent_id)
);

alter table relay_endpoints enable row level security;
