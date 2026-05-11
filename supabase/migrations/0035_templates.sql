-- Templates feature.
--
-- Templates are vault items with extra metadata (no new table). When
-- a .docx upload is detected as a template (auto-detect on upload OR
-- manual user flag), we set source_kind='template' and populate
-- template_schema with the detected variable fields.
--
-- Drafts rendered from templates are ALSO vault items, with
-- source_kind='draft', rendered_from_template_id pointing back at the
-- template, and rendered_values storing the JSON used in the merge.

-- 1. Extend the source_kind constraint to allow 'template' and 'draft'.
--    Drop + recreate is the only way to extend a CHECK constraint.
alter table public.workspace_vault_items
  drop constraint if exists workspace_vault_items_source_kind_check;
alter table public.workspace_vault_items
  add constraint workspace_vault_items_source_kind_check
  check (source_kind in ('document','chat','review_finding','manual_note','template','draft'));

-- 2. Template metadata columns.
alter table public.workspace_vault_items
  add column if not exists template_schema jsonb,
  add column if not exists template_status text default 'none'
    check (template_status in ('none','detecting','ready','failed')),
  add column if not exists template_storage_path text;
--   template_storage_path: when the template was uploaded as a real
--   .docx file (not just text), this points to the storage object the
--   merge endpoint will download to run docxtemplater against.

-- 3. Draft back-pointer + the JSON values that were merged in.
alter table public.workspace_vault_items
  add column if not exists rendered_from_template_id uuid
    references public.workspace_vault_items(id) on delete set null,
  add column if not exists rendered_values jsonb,
  add column if not exists rendered_storage_path text;

-- 4. Helpful partial indexes — most queries filter by source_kind.
create index if not exists idx_vault_items_user_template
  on public.workspace_vault_items (user_id, updated_at desc)
  where source_kind = 'template' and archived_at is null;

create index if not exists idx_vault_items_user_draft
  on public.workspace_vault_items (user_id, updated_at desc)
  where source_kind = 'draft' and archived_at is null;

-- 5. Bind a chat to a template (Phase 3 — "Use in chat" entry point).
--    When set, the chat-stream edge function uses a template-aware
--    system prompt that asks the model to gather field values
--    conversationally and offer to render on each turn.
alter table public.workspace_chats
  add column if not exists bound_template_id uuid
    references public.workspace_vault_items(id) on delete set null;

create index if not exists idx_workspace_chats_bound_template
  on public.workspace_chats (bound_template_id)
  where bound_template_id is not null;
