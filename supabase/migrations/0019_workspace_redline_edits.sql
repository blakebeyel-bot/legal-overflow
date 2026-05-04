-- Round 19 — track individual redline edits.
--
-- Phase 6.5. Each LLM-proposed edit becomes its own row so the user
-- can accept or reject them individually from the browser without
-- opening Word. The finalize endpoint then collects accepted edits
-- and produces a clean (no-track-changes) final version.

create table if not exists public.workspace_redline_edits (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.workspace_redline_runs(id) on delete cascade,
  edit_index      integer not null,                -- 0-based position in the LLM's output
  find_text       text not null,
  replace_text    text not null default '',
  rationale       text,
  status          text not null default 'pending'
                  check (status in ('pending','accepted','rejected')),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (run_id, edit_index)
);

create index if not exists idx_workspace_redline_edits_run
  on public.workspace_redline_edits (run_id, edit_index);
create index if not exists idx_workspace_redline_edits_status
  on public.workspace_redline_edits (run_id, status);

alter table public.workspace_redline_edits enable row level security;

drop policy if exists "Own redline edits: read" on public.workspace_redline_edits;
create policy "Own redline edits: read"
  on public.workspace_redline_edits for select using (
    exists (
      select 1 from public.workspace_redline_runs r
      where r.id = workspace_redline_edits.run_id and r.user_id = auth.uid()
    )
  );

drop policy if exists "Own redline edits: write" on public.workspace_redline_edits;
create policy "Own redline edits: write"
  on public.workspace_redline_edits for all using (
    exists (
      select 1 from public.workspace_redline_runs r
      where r.id = workspace_redline_edits.run_id and r.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspace_redline_runs r
      where r.id = workspace_redline_edits.run_id and r.user_id = auth.uid()
    )
  );

-- Add a column on the runs table for the finalized version reference
alter table public.workspace_redline_runs
  add column if not exists finalized_version_id uuid
  references public.workspace_document_versions(id) on delete set null,
  add column if not exists finalized_at timestamptz;
