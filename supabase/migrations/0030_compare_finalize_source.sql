-- 0030_compare_finalize_source.sql
--
-- Widen the workspace_document_versions.source check constraint to
-- include 'compare-finalize' — the source value the new compare-
-- finalize background worker writes when it uploads the redlined
-- output as a new version on the proposed document.
--
-- Original constraint (migration 0014) allowed:
--   upload | redline | user_edit | generated
--
-- The compare-finalize worker is producing a tracked-changes redline
-- that's distinct from the existing 'redline' value (which is reserved
-- for the standalone redline agent that runs against a single doc with
-- a list of concerns). Adding a new value keeps the audit trail clear:
-- you can tell at a glance whether a version came from the redline
-- agent vs from finalizing a compare run.
--
-- Safe to re-run.

alter table public.workspace_document_versions
  drop constraint if exists workspace_document_versions_source_check;

alter table public.workspace_document_versions
  add constraint workspace_document_versions_source_check
  check (source in ('upload', 'redline', 'user_edit', 'generated', 'compare-finalize'));

comment on column public.workspace_document_versions.source is
  'How this version was created. (0030) Now includes ''compare-finalize'' for outputs of workspace-compare-finalize-background — the tracked-changes redline / inline-redline PDF produced from a compare run''s decisions.';
