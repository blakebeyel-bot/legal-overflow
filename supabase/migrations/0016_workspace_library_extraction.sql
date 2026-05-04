-- Round 16 — workspace document text extraction.
--
-- Phase 2 of the workspace plan: documents in the library need to be
-- READ by the chat. Rather than re-extracting text on every message
-- (slow, expensive), we extract once at upload time and cache the
-- result on the version row. Subsequent chat messages that reference
-- the doc just read this column.
--
-- We also track the extraction state so the UI can show "extracting…"
-- while the upload's still being processed (PDFs with 50 pages can
-- take 10-20 seconds to extract).

alter table public.workspace_document_versions
  add column if not exists extracted_text text,
  add column if not exists extraction_status text not null default 'pending'
    check (extraction_status in ('pending','running','done','failed','skipped')),
  add column if not exists extraction_detail text,
  add column if not exists extracted_chars integer;

comment on column public.workspace_document_versions.extracted_text is
  'Plain-text extraction of the document, cached. Filled by the upload function. NULL until extraction_status=done.';
