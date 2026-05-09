-- 0027_workspace_documents_library_hidden.sql
--
-- Lets a document live in Storage + the extraction pipeline without
-- appearing in the user's Library list. Used when the user uploads a
-- file via the Vault page and chooses "Vault only" — the file bytes
-- still need a home (Storage) and a metadata row (so OCR/extraction
-- works the same), but they don't want it cluttering their Library.
--
-- The Vault list still surfaces these docs (via source_doc_id on
-- workspace_vault_items). The Library list filters them out.

alter table public.workspace_documents
  add column if not exists library_hidden boolean not null default false;

comment on column public.workspace_documents.library_hidden is
  'When true, this document is not shown in the Library list. Set when the user uploads a file via the Vault page with destination=Vault only. The file still goes through the normal extraction + OCR pipeline; it just stays invisible in the Library UI.';

-- Done.
