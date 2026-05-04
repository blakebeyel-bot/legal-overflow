-- Round 18 — redline runs.
--
-- Phase 6 of the workspace plan. A redline run takes one document
-- and a free-text concerns prompt, asks the LLM to produce a JSON
-- list of edits, ships the original .docx + edits to the LibreOffice
-- service on Fly.io, and saves the redlined .docx back to the
-- library as a new version.
--
-- The run row is the unit the UI polls — a status enum tracks its
-- progress so the user sees "running…" then "complete" without us
-- needing real-time pubsub.

create table if not exists public.workspace_redline_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  document_id     uuid not null references public.workspace_documents(id) on delete cascade,
  concerns        text not null,                  -- user's free-text prompt
  model           text not null default 'claude-sonnet-4-5',
  status          text not null default 'pending'
                  check (status in ('pending','running','complete','error')),
  status_detail   text,
  edits_summary   text,                           -- LLM-written summary of changes
  edits_count     integer,
  result_version_id uuid references public.workspace_document_versions(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_workspace_redline_runs_user_doc
  on public.workspace_redline_runs (user_id, document_id, created_at desc);

create or replace function public.touch_workspace_redline_runs_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_redline_runs_updated_at on public.workspace_redline_runs;
create trigger trg_workspace_redline_runs_updated_at
  before update on public.workspace_redline_runs
  for each row execute procedure public.touch_workspace_redline_runs_updated_at();

alter table public.workspace_redline_runs enable row level security;

drop policy if exists "Own redline runs: read" on public.workspace_redline_runs;
create policy "Own redline runs: read"
  on public.workspace_redline_runs for select using (auth.uid() = user_id);

drop policy if exists "Own redline runs: write" on public.workspace_redline_runs;
create policy "Own redline runs: write"
  on public.workspace_redline_runs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
