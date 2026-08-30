-- Prepared manual input: CEO chat message persistence (SQLite migration 31
-- equivalent). Mirrors the company_ceo_messages block in
-- src/lib/db/schema.deploy.sql. Subject to the full safety gate in
-- PENDING.md — live readback, drift check, dry run, explicit production
-- approval. Additive only; no data backfill.
-- Until applied, appendCeoMessage in src/lib/db/supabase-repo.ts logs the
-- write failure and continues, and listCeoMessages returns [], so the CEO
-- chat renders empty history until this migration is applied (dark-deploy
-- safe by design). Append-only in the runtime: select + insert only.
-- `seq` is a monotonic tie-break, not a public id: two turns appended
-- within one request commonly share one millisecond of created_at
-- resolution, and `id` (a random UUID) does not preserve insertion order
-- under that tie the way SQLite's implicit rowid does.

create table if not exists company_ceo_messages (
  id text primary key,
  company_id text not null references companies (id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  proposal jsonb,
  created_at text not null,
  seq bigint generated always as identity
);
create index if not exists idx_ceo_messages_company
  on company_ceo_messages (company_id, created_at, seq);

alter table company_ceo_messages enable row level security;

revoke all privileges on table public.company_ceo_messages
from public, anon, authenticated;
grant select, insert on table public.company_ceo_messages
to service_role;
revoke delete, update on table public.company_ceo_messages
from service_role;
