-- Round 20 — tabular reviews gain a "redline" kind.
--
-- Phase 7 consolidation: a tabular review now has two flavors. Extraction
-- (the original) yields per-cell answer + verbatim quote. Redline (new)
-- yields per-cell find + replace + rationale that can be accepted /
-- rejected per-cell, then finalized into a clean .docx per document.
--
-- The standalone single-doc redline flow on the library page is being
-- removed; everything redline-related lives under /workspace/reviews/
-- now. workspace_redline_runs and workspace_redline_edits remain in
-- place for backward compatibility but new flows write to
-- workspace_tabular_cells.

alter table public.workspace_tabular_reviews
  add column if not exists kind text not null default 'extraction'
  check (kind in ('extraction','redline'));

create index if not exists idx_workspace_tr_kind
  on public.workspace_tabular_reviews (kind);

-- Per-cell redline fields. Reuse the row but carry edit-shaped data
-- when the parent review is kind='redline'. The status column is
-- already on the cell row; we add a SEPARATE redline_status so the
-- existing "running/complete/error" generation lifecycle isn't
-- conflated with "user accepted/rejected this edit".
alter table public.workspace_tabular_cells
  add column if not exists redline_find text,
  add column if not exists redline_replace text,
  add column if not exists redline_rationale text,
  add column if not exists redline_status text default 'pending'
    check (redline_status in ('pending','accepted','rejected')),
  add column if not exists redline_resolved_at timestamptz;

create index if not exists idx_workspace_tr_cells_redline_status
  on public.workspace_tabular_cells (review_id, redline_status)
  where redline_find is not null;

-- Track finalized clean .docx versions produced from a redline review,
-- per document. A redline review with N docs can produce up to N
-- finalized versions (one per doc, with that doc's accepted edits
-- applied). Stored as a small junction table so we know which
-- workspace_document_versions row was the latest finalization for a
-- given (review, doc) pair.
create table if not exists public.workspace_tabular_doc_finalizations (
  id              uuid primary key default gen_random_uuid(),
  review_id       uuid not null references public.workspace_tabular_reviews(id) on delete cascade,
  document_id     uuid not null references public.workspace_documents(id) on delete cascade,
  version_id      uuid references public.workspace_document_versions(id) on delete set null,
  edits_applied   integer not null default 0,
  finalized_at    timestamptz not null default now(),
  unique (review_id, document_id)
);

create index if not exists idx_tr_doc_finalizations_review
  on public.workspace_tabular_doc_finalizations (review_id);

alter table public.workspace_tabular_doc_finalizations enable row level security;

drop policy if exists "Own tr finalizations: read" on public.workspace_tabular_doc_finalizations;
create policy "Own tr finalizations: read"
  on public.workspace_tabular_doc_finalizations for select using (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_doc_finalizations.review_id and r.user_id = auth.uid()
    )
  );
drop policy if exists "Own tr finalizations: write" on public.workspace_tabular_doc_finalizations;
create policy "Own tr finalizations: write"
  on public.workspace_tabular_doc_finalizations for all using (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_doc_finalizations.review_id and r.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_doc_finalizations.review_id and r.user_id = auth.uid()
    )
  );
