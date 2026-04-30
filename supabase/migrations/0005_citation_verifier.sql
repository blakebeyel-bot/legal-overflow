-- =====================================================================
-- Legal Overflow — Citation Verifier (Bluebook 22e form-check + existence)
-- =====================================================================
-- Schema for the citation-verifier agent at /agents/citation-verifier/.
--
-- One run per upload. Each run produces:
--   - many `citations` rows (one per extracted candidate)
--   - many `flags` rows (zero-to-many per citation)
--   - one `disclaimer_acceptances` row (legal record-keeping)
--
-- Privilege defaults (mirrors build spec §6):
--   • candidate_text is NULL unless retain_text = true
--   • candidate_text_hash is always set (SHA-256 of the raw text)
--   • the uploaded source file in storage is deleted after the run
--     completes; no document body persists in this DB
--
-- Run this entire file in Supabase SQL Editor (paste -> Run).
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------- extensions ----------
create extension if not exists "pgcrypto";

-- ---------- enums (guarded) ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'verification_run_status') then
    create type public.verification_run_status as enum (
      'queued',
      'extracting',
      'classifying',
      'checking_existence',
      'validating',
      'judging',
      'building_outputs',
      'complete',
      'failed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'citation_type') then
    create type public.citation_type as enum (
      'case',
      'statute',
      'regulation',
      'constitutional',
      'book',
      'periodical',
      'internet',
      'court_document',
      'short_form_id',
      'short_form_supra',
      'short_form_case',
      'unknown'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'citation_existence_status') then
    create type public.citation_existence_status as enum (
      'existence_verified',
      'existence_not_found',
      'existence_uncertain',
      'not_applicable'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'citation_flag_severity') then
    create type public.citation_flag_severity as enum (
      'conforming',
      'review',
      'non_conforming'
    );
  end if;
end$$;

-- =====================================================================
-- 1. verification_runs — one row per upload
-- =====================================================================
create table if not exists public.verification_runs (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  file_hash                   text not null,
  file_name                   text not null,
  file_format                 text not null check (file_format in ('docx', 'pdf')),
  retain_text                 boolean not null default false,
  bluebook_edition            text not null default '22e',
  ruleset                     text not null default 'federal',
  style                       text not null default 'bluepages'
                              check (style in ('bluepages', 'whitepages')),
  model_pass2                 text not null,
  model_pass4                 text not null,
  status                      public.verification_run_status not null default 'queued',
  status_progress             smallint not null default 0
                              check (status_progress between 0 and 100),
  citation_count              int,
  flag_count_review           int,
  flag_count_nonconforming    int,
  existence_not_found_count   int,
  existence_uncertain_count   int,
  form_report_storage_path    text,
  marked_source_storage_path  text,
  created_at                  timestamptz not null default now(),
  completed_at                timestamptz,
  error_message               text
);

create index if not exists idx_verification_runs_user_created
  on public.verification_runs (user_id, created_at desc);
create index if not exists idx_verification_runs_status
  on public.verification_runs (status);

-- =====================================================================
-- 2. citations — one row per extracted candidate
-- =====================================================================
create table if not exists public.citations (
  id                       uuid primary key default gen_random_uuid(),
  run_id                   uuid not null references public.verification_runs(id) on delete cascade,
  candidate_text           text,                          -- nullable; only stored if retain_text
  candidate_text_hash      text not null,
  char_start               int not null,
  char_end                 int not null,
  page_number              int,                            -- nullable; PDFs only
  in_footnote              boolean not null default false,
  footnote_num             int,
  citation_type            public.citation_type,
  components               jsonb,
  governing_rule           text,
  governing_table          text,
  -- Pass 2.5 existence-check fields:
  existence_status         public.citation_existence_status,
  courtlistener_opinion_id text,
  courtlistener_url        text,
  courtlistener_search_url text,
  classified_at            timestamptz default now()
);

create index if not exists idx_citations_run on public.citations (run_id);
create index if not exists idx_citations_existence_status on public.citations (existence_status);

-- =====================================================================
-- 3. flags — zero-to-many per citation
-- =====================================================================
create table if not exists public.flags (
  id            uuid primary key default gen_random_uuid(),
  citation_id   uuid not null references public.citations(id) on delete cascade,
  severity      public.citation_flag_severity not null,
  category      text not null,
  -- categories per spec §6:
  --   form_components | abbreviations | reporter | short_form | signal |
  --   parenthetical | quotation | history | parallel | capitalization | existence
  rule_cite     text,                                       -- e.g. "BB R. 10.2.2"
  table_cite    text,                                       -- e.g. "T6"
  message       text not null,
  suggested_fix text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_flags_citation on public.flags (citation_id);
create index if not exists idx_flags_severity on public.flags (severity);
create index if not exists idx_flags_category on public.flags (category);

-- =====================================================================
-- 4. disclaimer_acceptances — legal record-keeping (separate table on purpose)
-- =====================================================================
create table if not exists public.disclaimer_acceptances (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  surface              text not null,                       -- e.g. "citation-verifier-upload"
  disclaimer_version   text not null,
  accepted_at          timestamptz not null default now(),
  ip_hash              text,                                -- never raw IP
  user_agent_hash      text                                 -- never raw UA
);

create index if not exists idx_disclaimer_acceptances_user
  on public.disclaimer_acceptances (user_id, accepted_at desc);

-- =====================================================================
-- Row-Level Security
-- =====================================================================
alter table public.verification_runs    enable row level security;
alter table public.citations            enable row level security;
alter table public.flags                enable row level security;
alter table public.disclaimer_acceptances enable row level security;

-- Users see their own runs, citations, flags, and acceptances. The
-- service role (used by the pipeline functions) bypasses RLS via the
-- service-role key — no insert policies needed for end users.
drop policy if exists "users see own runs" on public.verification_runs;
create policy "users see own runs"
  on public.verification_runs
  for select using (auth.uid() = user_id);

drop policy if exists "users see own citations" on public.citations;
create policy "users see own citations"
  on public.citations
  for select using (
    exists (
      select 1 from public.verification_runs r
      where r.id = run_id and r.user_id = auth.uid()
    )
  );

drop policy if exists "users see own flags" on public.flags;
create policy "users see own flags"
  on public.flags
  for select using (
    exists (
      select 1
      from public.citations c
      join public.verification_runs r on r.id = c.run_id
      where c.id = citation_id and r.user_id = auth.uid()
    )
  );

drop policy if exists "users see own acceptances" on public.disclaimer_acceptances;
create policy "users see own acceptances"
  on public.disclaimer_acceptances
  for select using (auth.uid() = user_id);

-- =====================================================================
-- v_citation_runs_summary — convenience view for the agent's results UI
-- =====================================================================
create or replace view public.v_citation_runs_summary as
select
  r.id                          as run_id,
  r.user_id,
  r.file_name,
  r.file_format,
  r.style,
  r.ruleset,
  r.bluebook_edition,
  r.status,
  r.status_progress,
  r.citation_count,
  r.flag_count_review,
  r.flag_count_nonconforming,
  r.existence_not_found_count,
  r.existence_uncertain_count,
  r.form_report_storage_path,
  r.marked_source_storage_path,
  r.created_at,
  r.completed_at,
  r.error_message
from public.verification_runs r
order by r.created_at desc;

-- =====================================================================
-- After running, verify with:
--   select count(*) as runs       from public.verification_runs;
--   select count(*) as citations  from public.citations;
--   select count(*) as flags      from public.flags;
--   select count(*) as acceptances from public.disclaimer_acceptances;
-- =====================================================================
