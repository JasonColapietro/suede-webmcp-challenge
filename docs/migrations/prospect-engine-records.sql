begin;

create table if not exists public.prospect_records (
  id text primary key,
  owner_id text not null check (char_length(owner_id) between 1 and 512),
  domain text not null check (char_length(domain) between 1 and 253),
  stage text not null check (stage in (
    'discovered', 'audited', 'reproduced', 'repair_ready', 'draft_ready',
    'approved', 'sent', 'follow_up_due', 'replied', 'opted_out', 'closed'
  )),
  record_json jsonb not null,
  revision integer not null check (revision > 0),
  created_at text not null,
  updated_at text not null,
  unique (owner_id, domain)
);
create index if not exists idx_prospect_records_owner_updated
  on public.prospect_records (owner_id, updated_at desc);
alter table public.prospect_records enable row level security;
revoke all privileges on table public.prospect_records from public, anon, authenticated;
grant select, insert, update on table public.prospect_records to service_role;
revoke delete on table public.prospect_records from service_role;

create table if not exists public.prospect_recipient_suppressions (
  owner_id text not null check (char_length(owner_id) between 1 and 512),
  email_sha256 text not null check (email_sha256 ~ '^v1:[0-9a-f]{64}$'),
  reason text not null check (reason in ('opt-out', 'operator')),
  created_at text not null,
  primary key (owner_id, email_sha256)
);
alter table public.prospect_recipient_suppressions enable row level security;
revoke all privileges on table public.prospect_recipient_suppressions from public, anon, authenticated;
grant select, insert on table public.prospect_recipient_suppressions to service_role;
revoke update, delete on table public.prospect_recipient_suppressions from service_role;

create or replace function public.agent_studio_opt_out_prospect(
  p_id text, p_owner_id text, p_expected_revision integer, p_record_json jsonb,
  p_stage text, p_revision integer, p_updated_at text, p_email_sha256 text, p_recorded_at text, p_reason text
) returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare affected integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id || ':' || p_email_sha256, 0));
  update public.prospect_records set stage = p_stage, record_json = p_record_json,
    revision = p_revision, updated_at = p_updated_at
  where id = p_id and owner_id = p_owner_id and revision = p_expected_revision;
  get diagnostics affected = row_count;
  if affected <> 1 then return false; end if;
  insert into public.prospect_recipient_suppressions (owner_id, email_sha256, reason, created_at)
    values (p_owner_id, p_email_sha256, p_reason, p_recorded_at)
    on conflict (owner_id, email_sha256) do nothing;
  return true;
end
$$;
revoke all on function public.agent_studio_opt_out_prospect(text,text,integer,jsonb,text,integer,text,text,text,text) from public, anon, authenticated;
grant execute on function public.agent_studio_opt_out_prospect(text,text,integer,jsonb,text,integer,text,text,text,text) to service_role;

create or replace function public.agent_studio_update_prospect_unless_suppressed(
  p_id text, p_owner_id text, p_expected_revision integer, p_record_json jsonb,
  p_stage text, p_revision integer, p_updated_at text, p_email_sha256 text
) returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare affected integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id || ':' || p_email_sha256, 0));
  if exists (select 1 from public.prospect_recipient_suppressions where owner_id = p_owner_id and email_sha256 = p_email_sha256) then return false; end if;
  update public.prospect_records set stage = p_stage, record_json = p_record_json, revision = p_revision, updated_at = p_updated_at
    where id = p_id and owner_id = p_owner_id and revision = p_expected_revision;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;
revoke all on function public.agent_studio_update_prospect_unless_suppressed(text,text,integer,jsonb,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.agent_studio_update_prospect_unless_suppressed(text,text,integer,jsonb,text,integer,text,text) to service_role;

create or replace function public.agent_studio_redact_prospect(p_id text, p_owner_id text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare affected integer;
begin
  delete from public.prospect_records where id = p_id and owner_id = p_owner_id;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;
revoke all on function public.agent_studio_redact_prospect(text,text) from public, anon, authenticated;
grant execute on function public.agent_studio_redact_prospect(text,text) to service_role;

commit;
