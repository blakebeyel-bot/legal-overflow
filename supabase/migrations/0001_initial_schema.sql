-- =====================================================================
-- Legal Overflow — Contract Review Platform — Initial schema
-- =====================================================================
-- Four tables + Row-Level Security + auto-profile trigger + storage policies.
-- Run this entire file in Supabase SQL Editor (New query → paste → Run).
-- =====================================================================

-- ---------- extensions ----------
create extension if not exists "pgcrypto";

-- ---------- utility: updated_at trigger ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- 1. profiles — one row per signed-up user
-- =====================================================================
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  tier          text not null default 'trial'
                check (tier in ('trial', 'standard', 'pro', 'enterprise')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles_self_select" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_self_insert" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

-- auto-create a profile row whenever a new auth.users row appears
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =====================================================================
-- 2. company_profiles — the JSON profile per user (their playbook)
-- =====================================================================
create table if not exists public.company_profiles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  profile_json  jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id)  -- one active profile per user
);

create index if not exists company_profiles_user_id_idx
  on public.company_profiles(user_id);

create trigger company_profiles_updated_at
  before update on public.company_profiles
  for each row execute procedure public.set_updated_at();

alter table public.company_profiles enable row level security;

create policy "company_profiles_self_all" on public.company_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =====================================================================
-- 3. reviews — one row per contract reviewed
-- =====================================================================
create table if not exists public.reviews (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  filename           text not null,
  contract_type      text,
  pipeline_mode      text check (pipeline_mode in ('express','standard','comprehensive')),
  severity_counts    jsonb default '{"blocker":0,"major":0,"moderate":0,"minor":0}'::jsonb,
  status             text not null default 'queued'
                     check (status in ('queued','classifying','analyzing','auditing','compiling','complete','failed')),
  progress_message   text,
  annotated_url      text,
  summary_url        text,
  findings_json_url  text,
  error_message      text,
  total_tokens       integer not null default 0,
  cost_usd           numeric(10,4) not null default 0,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index if not exists reviews_user_id_created_idx
  on public.reviews(user_id, created_at desc);

create index if not exists reviews_user_id_status_idx
  on public.reviews(user_id, status);

alter table public.reviews enable row level security;

create policy "reviews_self_select" on public.reviews
  for select using (auth.uid() = user_id);

create policy "reviews_self_insert" on public.reviews
  for insert with check (auth.uid() = user_id);

-- Note: UPDATE is deliberately NOT allowed to the user. Only the backend
-- service_role key can update reviews (progress/results). This prevents
-- a malicious client from lying about review state.

-- =====================================================================
-- 4. usage_events — audit log, one row per Anthropic API call
-- =====================================================================
create table if not exists public.usage_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  review_id           uuid references public.reviews(id) on delete cascade,
  agent_name          text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  timestamp           timestamptz not null default now()
);

create index if not exists usage_events_user_id_idx
  on public.usage_events(user_id, timestamp desc);

create index if not exists usage_events_review_id_idx
  on public.usage_events(review_id);

alter table public.usage_events enable row level security;

create policy "usage_events_self_select" on public.usage_events
  for select using (auth.uid() = user_id);

-- Inserts only allowed via service_role (backend). No client-side INSERT policy.

-- =====================================================================
-- 5. Helper view — current-month review count for quota checks
-- =====================================================================
create or replace view public.reviews_current_window as
select
  user_id,
  count(*) filter (where status = 'complete') as reviews_complete,
  count(*) filter (where status in ('queued','classifying','analyzing','auditing','compiling')) as reviews_in_progress,
  count(*) as reviews_total
from public.reviews
where created_at > (now() - interval '30 days')
group by user_id;

grant select on public.reviews_current_window to authenticated;

-- =====================================================================
-- 6. Storage bucket policies
--    Buckets themselves are created via the dashboard (next step).
--    These policies restrict each user to their own <user_id>/* path.
-- =====================================================================
-- Policies for the contracts-incoming bucket
create policy "contracts_incoming_own_read"
  on storage.objects for select
  using (
    bucket_id = 'contracts-incoming'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "contracts_incoming_own_upload"
  on storage.objects for insert
  with check (
    bucket_id = 'contracts-incoming'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "contracts_incoming_own_delete"
  on storage.objects for delete
  using (
    bucket_id = 'contracts-incoming'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Policies for the reviews-output bucket — read-only for users, write by service_role
create policy "reviews_output_own_read"
  on storage.objects for select
  using (
    bucket_id = 'reviews-output'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- =====================================================================
-- Done. Verify in Supabase dashboard: Table Editor should show 4 tables.
-- =====================================================================
