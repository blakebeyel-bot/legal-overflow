-- =====================================================================
-- Legal Overflow — Mata Tracker schema
-- =====================================================================
-- Adds five tables (cases, opinions, annotations, skill_links,
-- discovery_log), enums, triggers, RLS policies, and a v_tracker_cases
-- convenience view used by /tracker/.
--
-- All annotation content is generated from primary-source opinions.
-- Damien Charlotin's database is used as a research index only — no
-- third-party commentary is stored here.
--
-- Run this entire file in Supabase SQL Editor (New query → paste → Run).
-- Designed to be idempotent so you can re-run it safely.
-- =====================================================================

-- ---------- extensions ----------
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------- enums (guarded) ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'sanction_severity') then
    create type public.sanction_severity as enum ('low', 'moderate', 'high', 'severe');
  end if;
  if not exists (select 1 from pg_type where typname = 'annotation_status') then
    create type public.annotation_status as enum ('draft', 'in_review', 'published', 'archived');
  end if;
end$$;

-- =====================================================================
-- 1. cases — case identification only (no third-party commentary)
-- =====================================================================
create table if not exists public.cases (
  id                  uuid primary key default gen_random_uuid(),
  case_name           text not null,
  court               text not null,
  state               text not null default 'USA',
  decision_date       date not null,
  docket_number       text,
  judge               text,
  party_type          text not null,
  ai_tool             text,
  slug                text unique not null,
  is_us               boolean not null default true,
  discovery_source    text not null default 'charlotin_index',
  discovery_date      date not null default current_date,
  status              text not null default 'pending_opinion',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- status values:
--   'pending_opinion'  case identified, opinion not yet fetched
--   'opinion_fetched'  opinion text stored, awaiting annotation
--   'annotated'        draft annotation exists
--   'published'        annotation reviewed and published
--   'needs_review'     flagged for human review

create index if not exists idx_cases_slug          on public.cases (slug);
create index if not exists idx_cases_decision_date on public.cases (decision_date desc);
create index if not exists idx_cases_court         on public.cases (court);
create index if not exists idx_cases_party_type    on public.cases (party_type);
create index if not exists idx_cases_status        on public.cases (status);
create index if not exists idx_cases_name_trgm     on public.cases using gin (case_name gin_trgm_ops);

-- generated full-text search column (guarded)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cases' and column_name = 'fts'
  ) then
    alter table public.cases add column fts tsvector
      generated always as (
        to_tsvector('english', coalesce(case_name, '') || ' ' || coalesce(court, ''))
      ) stored;
  end if;
end$$;

create index if not exists idx_cases_fts on public.cases using gin (fts);

-- =====================================================================
-- 2. opinions — primary-source judicial opinion text
-- =====================================================================
create table if not exists public.opinions (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references public.cases(id) on delete cascade,
  source          text not null,
  source_url      text,
  source_doc_id   text,
  retrieval_date  date not null default current_date,
  opinion_text    text,
  opinion_type    text not null default 'sanctions',
  page_count      integer,
  file_hash       text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_opinions_case_id on public.opinions (case_id);
create index if not exists idx_opinions_source  on public.opinions (source);

-- =====================================================================
-- 3. annotations — original analysis generated from opinion text
-- =====================================================================
create table if not exists public.annotations (
  id                       uuid primary key default gen_random_uuid(),
  case_id                  uuid not null references public.cases(id) on delete cascade,
  opinion_id               uuid references public.opinions(id),
  version                  integer not null default 1,
  status                   public.annotation_status not null default 'draft',
  severity                 public.sanction_severity not null,
  one_line                 text not null,
  what_happened            text not null,
  what_went_wrong          text not null,
  outcome_summary          text not null,
  monetary_penalty_usd     numeric(12,2),
  professional_sanction    boolean not null default false,
  rule_1_1_competence      jsonb,
  rule_1_4_communication   jsonb,
  rule_1_6_confidentiality jsonb,
  rule_3_3_candor          jsonb,
  rule_5_1_supervisory     jsonb,
  rule_5_3_nonlawyer       jsonb,
  rule_8_4_misconduct      jsonb,
  insurance_exposure       text,
  bar_referral_risk        text,
  firm_policy_takeaway     text,
  prevention_notes         text,
  is_provisional           boolean not null default false,
  generated_by             text not null default 'claude',
  reviewed_by              text,
  reviewed_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_annotations_case_id on public.annotations (case_id);
create index if not exists idx_annotations_status  on public.annotations (status);
create index if not exists idx_annotations_version on public.annotations (case_id, version desc);
create unique index if not exists idx_annotations_one_published
  on public.annotations (case_id) where status = 'published';

-- =====================================================================
-- 4. skill_links — practitioner Skills referenced from each annotation
-- =====================================================================
create table if not exists public.skill_links (
  id              uuid primary key default gen_random_uuid(),
  annotation_id   uuid not null references public.annotations(id) on delete cascade,
  skill_slug      text not null,
  skill_name      text not null,
  skill_url       text not null,
  relevance_note  text not null,
  display_order   integer not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists idx_skill_links_annotation on public.skill_links (annotation_id);

-- =====================================================================
-- 5. discovery_log — audit trail for automated case-discovery runs
-- =====================================================================
create table if not exists public.discovery_log (
  id              uuid primary key default gen_random_uuid(),
  run_date        timestamptz not null default now(),
  source          text not null,
  query_used      text not null,
  results_found   integer not null default 0,
  cases_added     integer not null default 0,
  cases_skipped   integer not null default 0,
  notes           text,
  created_at      timestamptz not null default now()
);

-- =====================================================================
-- triggers
-- =====================================================================
-- Reuse existing public.set_updated_at() from migration 0001.
drop trigger if exists trg_cases_updated_at on public.cases;
create trigger trg_cases_updated_at
  before update on public.cases
  for each row execute function public.set_updated_at();

drop trigger if exists trg_annotations_updated_at on public.annotations;
create trigger trg_annotations_updated_at
  before update on public.annotations
  for each row execute function public.set_updated_at();

-- When an opinion is inserted, advance case status if still pending.
create or replace function public.update_case_status_on_opinion()
returns trigger
language plpgsql
as $$
begin
  update public.cases
     set status = 'opinion_fetched'
   where id = new.case_id
     and status = 'pending_opinion';
  return new;
end;
$$;

drop trigger if exists trg_opinion_updates_case on public.opinions;
create trigger trg_opinion_updates_case
  after insert on public.opinions
  for each row execute function public.update_case_status_on_opinion();

-- When an annotation is inserted/updated, mirror status onto the case.
create or replace function public.update_case_status_on_annotation()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'published' then
    update public.cases set status = 'published' where id = new.case_id;
  elsif new.status = 'draft' then
    update public.cases
       set status = 'annotated'
     where id = new.case_id
       and status in ('opinion_fetched', 'pending_opinion');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_annotation_updates_case on public.annotations;
create trigger trg_annotation_updates_case
  after insert or update on public.annotations
  for each row execute function public.update_case_status_on_annotation();

-- =====================================================================
-- row-level security
-- =====================================================================
alter table public.cases         enable row level security;
alter table public.opinions      enable row level security;
alter table public.annotations   enable row level security;
alter table public.skill_links   enable row level security;
alter table public.discovery_log enable row level security;

-- Public (anon) read policies
drop policy if exists "Public read cases"       on public.cases;
create policy "Public read cases"
  on public.cases for select using (true);

drop policy if exists "Public read opinions"    on public.opinions;
create policy "Public read opinions"
  on public.opinions for select using (true);

drop policy if exists "Public read annotations" on public.annotations;
create policy "Public read annotations"
  on public.annotations for select using (status = 'published');

drop policy if exists "Public read skill_links" on public.skill_links;
create policy "Public read skill_links"
  on public.skill_links for select using (true);

-- Service-role full access (service_role bypasses RLS, but explicit
-- policies keep behaviour consistent across roles).
drop policy if exists "Service full access cases"         on public.cases;
create policy "Service full access cases"
  on public.cases for all using (true) with check (true);

drop policy if exists "Service full access opinions"      on public.opinions;
create policy "Service full access opinions"
  on public.opinions for all using (true) with check (true);

drop policy if exists "Service full access annotations"   on public.annotations;
create policy "Service full access annotations"
  on public.annotations for all using (true) with check (true);

drop policy if exists "Service full access skill_links"   on public.skill_links;
create policy "Service full access skill_links"
  on public.skill_links for all using (true) with check (true);

drop policy if exists "Service full access discovery_log" on public.discovery_log;
create policy "Service full access discovery_log"
  on public.discovery_log for all using (true) with check (true);

-- =====================================================================
-- v_tracker_cases — flat view consumed by the /tracker/ front-end
-- =====================================================================
create or replace view public.v_tracker_cases as
select
  c.id              as case_id,
  c.slug,
  c.case_name,
  c.court,
  c.state,
  c.decision_date,
  c.docket_number,
  c.judge,
  c.party_type,
  c.ai_tool,
  c.status          as case_status,
  a.id              as annotation_id,
  a.severity,
  a.one_line,
  a.what_happened,
  a.what_went_wrong,
  a.outcome_summary,
  a.monetary_penalty_usd,
  a.professional_sanction,
  a.rule_1_1_competence,
  a.rule_3_3_candor,
  a.rule_1_6_confidentiality,
  a.rule_5_1_supervisory,
  a.rule_5_3_nonlawyer,
  a.insurance_exposure,
  a.bar_referral_risk,
  a.firm_policy_takeaway,
  a.prevention_notes,
  a.is_provisional,
  a.reviewed_by,
  a.reviewed_at
from public.cases c
left join public.annotations a
  on a.case_id = c.id
 and a.status = 'published'
where c.is_us = true
order by c.decision_date desc;

-- =====================================================================
-- verification helper — list created tables
-- =====================================================================
-- After running, paste this in a new SQL editor tab to verify:
--   select table_name from information_schema.tables
--    where table_schema = 'public'
--      and table_name in ('cases','opinions','annotations','skill_links','discovery_log')
--    order by table_name;
