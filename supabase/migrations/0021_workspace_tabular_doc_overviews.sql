-- Round 21 — per-document overview (summary + red flags) for tabular
-- reviews. Auto-generated when a review runs. Surfaces at the top of
-- the findings sidebar in the doc view, regardless of review kind:
-- extraction users get a quick read on the doc + risks, redline users
-- get the same context next to their proposed edits.

create table if not exists public.workspace_tabular_doc_overviews (
  id              uuid primary key default gen_random_uuid(),
  review_id       uuid not null references public.workspace_tabular_reviews(id) on delete cascade,
  document_id     uuid not null references public.workspace_documents(id) on delete cascade,
  summary         text,
  risks           jsonb not null default '[]'::jsonb,
                  -- shape: [{title, severity:'high'|'medium'|'low', detail, quote?, page?}]
  status          text not null default 'pending'
                  check (status in ('pending','running','complete','error')),
  status_detail   text,
  prompt_tokens   integer,
  completion_tokens integer,
  model_used      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (review_id, document_id)
);

create index if not exists idx_workspace_tr_overviews_review
  on public.workspace_tabular_doc_overviews (review_id);

create or replace function public.touch_workspace_tr_overviews_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_tr_overviews_updated_at on public.workspace_tabular_doc_overviews;
create trigger trg_workspace_tr_overviews_updated_at
  before update on public.workspace_tabular_doc_overviews
  for each row execute procedure public.touch_workspace_tr_overviews_updated_at();

alter table public.workspace_tabular_doc_overviews enable row level security;

drop policy if exists "Own overviews: read" on public.workspace_tabular_doc_overviews;
create policy "Own overviews: read"
  on public.workspace_tabular_doc_overviews for select using (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_doc_overviews.review_id and r.user_id = auth.uid()
    )
  );

drop policy if exists "Own overviews: write" on public.workspace_tabular_doc_overviews;
create policy "Own overviews: write"
  on public.workspace_tabular_doc_overviews for all using (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_doc_overviews.review_id and r.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_doc_overviews.review_id and r.user_id = auth.uid()
    )
  );
