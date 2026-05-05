-- Round 23 — compare two contracts.
--
-- A separate workflow from tabular reviews: the user picks two
-- documents — typically "our template" + "their proposal" — and the
-- AI walks both end-to-end identifying every meaningful difference.
-- Output is a list of diffs the user can accept (use their version),
-- reject (keep ours), or refine. A finalized version applies the
-- chosen subset.

create table if not exists public.workspace_compare_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  project_id      uuid references public.workspace_projects(id) on delete set null,
  title           text not null,
  base_document_id     uuid not null references public.workspace_documents(id) on delete cascade,
  proposed_document_id uuid not null references public.workspace_documents(id) on delete cascade,
  client_role     text,
  additional_context text,
  model           text not null default 'claude-sonnet-4-5',
  status          text not null default 'pending'
                  check (status in ('pending','running','complete','partial','error')),
  status_detail   text,
  diffs_count     integer,
  summary         text,
  finalized_version_id uuid references public.workspace_document_versions(id) on delete set null,
  finalized_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_workspace_compare_runs_user
  on public.workspace_compare_runs (user_id, project_id, updated_at desc);

create or replace function public.touch_workspace_compare_runs_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_compare_runs_updated_at on public.workspace_compare_runs;
create trigger trg_workspace_compare_runs_updated_at
  before update on public.workspace_compare_runs
  for each row execute procedure public.touch_workspace_compare_runs_updated_at();

alter table public.workspace_compare_runs enable row level security;

drop policy if exists "Own compare runs: read" on public.workspace_compare_runs;
create policy "Own compare runs: read"
  on public.workspace_compare_runs for select using (auth.uid() = user_id);
drop policy if exists "Own compare runs: write" on public.workspace_compare_runs;
create policy "Own compare runs: write"
  on public.workspace_compare_runs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Per-diff row. One per identified difference between the two docs.
create table if not exists public.workspace_compare_diffs (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.workspace_compare_runs(id) on delete cascade,
  diff_index      integer not null,
  section_name    text,                          -- e.g. "Section 7.2 — Liability"
  change_type     text not null check (change_type in ('addition','deletion','modification','equivalent')),
  severity        text not null default 'medium' check (severity in ('high','medium','low','info')),
  base_text       text,                          -- text in the base/template
  proposed_text   text,                          -- text in the proposed/counterparty
  why_it_matters  text,
  recommendation  text,                          -- one of 'accept', 'reject', 'negotiate' — model's recommendation given the user's role
  user_choice     text not null default 'pending'
                  check (user_choice in ('pending','accept_proposed','keep_base','custom')),
  user_custom_text text,                         -- if user wrote their own version
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (run_id, diff_index)
);

create index if not exists idx_workspace_compare_diffs_run
  on public.workspace_compare_diffs (run_id, diff_index);

alter table public.workspace_compare_diffs enable row level security;

drop policy if exists "Own compare diffs: read" on public.workspace_compare_diffs;
create policy "Own compare diffs: read"
  on public.workspace_compare_diffs for select using (
    exists (
      select 1 from public.workspace_compare_runs r
      where r.id = workspace_compare_diffs.run_id and r.user_id = auth.uid()
    )
  );
drop policy if exists "Own compare diffs: write" on public.workspace_compare_diffs;
create policy "Own compare diffs: write"
  on public.workspace_compare_diffs for all using (
    exists (
      select 1 from public.workspace_compare_runs r
      where r.id = workspace_compare_diffs.run_id and r.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspace_compare_runs r
      where r.id = workspace_compare_diffs.run_id and r.user_id = auth.uid()
    )
  );
