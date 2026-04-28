-- =====================================================================
-- Legal Overflow — Rules & Orders tracker (Phase 1)
-- =====================================================================
-- Adds the `rules` table parallel to `cases`, plus an enum for the type
-- of authority (ABA opinion, state ethics opinion, federal standing
-- order, etc.), RLS policies, an updated_at trigger, and a flat view
-- the front-end consumes.
--
-- Each row is a single rule, ethics opinion, or standing order. The
-- annotation fields (summary, takeaways, practitioner_take, penalties)
-- are written by hand for Phase 1 and editable in Supabase Studio.
-- Phase 2 will wire scrapers into this same table.
--
-- Run this entire file in Supabase SQL Editor (paste → Run).
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------- enum (guarded) ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rule_jurisdiction') then
    create type public.rule_jurisdiction as enum ('aba', 'federal', 'state', 'circuit');
  end if;
  if not exists (select 1 from pg_type where typname = 'rule_type') then
    create type public.rule_type as enum (
      'aba_opinion',
      'ethics_opinion',
      'standing_order',
      'local_rule',
      'court_rule',
      'task_force_report',
      'proposed_rule',
      'statute'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'rule_status') then
    create type public.rule_status as enum ('draft', 'published', 'archived', 'superseded');
  end if;
end$$;

-- =====================================================================
-- rules — the catalog
-- =====================================================================
create table if not exists public.rules (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text unique not null,
  title                    text not null,
  subtitle                 text,
  citation                 text not null,
  jurisdiction             public.rule_jurisdiction not null,
  jurisdiction_label       text not null,           -- display string e.g. "N.D. Tex. — J. Starr"
  state                    text,                    -- 'FL', 'CA', etc., or null for federal/aba
  court                    text,                    -- 'N.D. Tex.', 'USCIT', etc.
  judge                    text,                    -- per-judge standing orders
  type                     public.rule_type not null,
  type_label               text not null,           -- display string
  effective_date           date not null,
  source_url               text not null,
  source_archive_url       text,                    -- secondary archival URL
  rules_implicated         text[] default '{}',     -- model rule numbers as text: '1.1','1.4','3.3', etc.
  requires_disclosure      boolean not null default false,
  requires_verification    boolean not null default false,
  summary                  text not null,
  takeaways                text[] default '{}',     -- bulleted practitioner takeaways
  practitioner_take        text,                    -- editorial voice
  penalties                text,
  status                   public.rule_status not null default 'draft',
  is_provisional           boolean not null default false,
  reviewed_by              text,
  reviewed_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_rules_slug          on public.rules (slug);
create index if not exists idx_rules_jurisdiction  on public.rules (jurisdiction);
create index if not exists idx_rules_type          on public.rules (type);
create index if not exists idx_rules_status        on public.rules (status);
create index if not exists idx_rules_effective     on public.rules (effective_date desc);
create index if not exists idx_rules_state         on public.rules (state);
create index if not exists idx_rules_title_trgm    on public.rules using gin (title gin_trgm_ops);

-- generated FTS column
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rules' and column_name = 'fts'
  ) then
    alter table public.rules add column fts tsvector
      generated always as (
        to_tsvector('english',
          coalesce(title, '') || ' ' ||
          coalesce(subtitle, '') || ' ' ||
          coalesce(citation, '') || ' ' ||
          coalesce(summary, '') || ' ' ||
          coalesce(practitioner_take, ''))
      ) stored;
  end if;
end$$;

create index if not exists idx_rules_fts on public.rules using gin (fts);

-- updated_at trigger reuses the existing public.set_updated_at()
drop trigger if exists trg_rules_updated_at on public.rules;
create trigger trg_rules_updated_at
  before update on public.rules
  for each row execute function public.set_updated_at();

-- =====================================================================
-- row-level security
-- =====================================================================
alter table public.rules enable row level security;

drop policy if exists "Public read published rules" on public.rules;
create policy "Public read published rules"
  on public.rules for select using (status = 'published');

drop policy if exists "Service full access rules" on public.rules;
create policy "Service full access rules"
  on public.rules for all using (true) with check (true);

-- =====================================================================
-- v_tracker_rules — flat published-rules view consumed by /tracker/
-- =====================================================================
create or replace view public.v_tracker_rules as
select
  id, slug, title, subtitle, citation,
  jurisdiction, jurisdiction_label, state, court, judge,
  type, type_label, effective_date,
  source_url, source_archive_url,
  rules_implicated,
  requires_disclosure, requires_verification,
  summary, takeaways, practitioner_take, penalties,
  is_provisional, reviewed_by, reviewed_at,
  created_at, updated_at
from public.rules
where status = 'published'
order by effective_date desc;

-- =====================================================================
-- verification: paste in a fresh SQL editor tab after running
--   select count(*) as rules from public.rules;
--   select count(*) as published from public.v_tracker_rules;
-- =====================================================================
