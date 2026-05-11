-- Default letterhead — Option B from the design discussion.
--
-- A user can mark exactly ONE template vault item as their "default
-- letterhead". When a draft is rendered with `apply_letterhead: true`,
-- the server pulls the user's default-letterhead template, extracts
-- the merged body XML from the source template, and injects it into
-- the letterhead's body — preserving the letterhead's header (logo,
-- firm name) and footer (address, page numbering) intact.

alter table public.workspace_vault_items
  add column if not exists is_default_letterhead boolean not null default false;

-- Partial unique index: only one default letterhead per user. A NULL
-- user_id (system templates) can never be a default letterhead — the
-- WHERE clause already excludes them via is_default_letterhead = true,
-- since the seed never sets that flag.
create unique index if not exists ux_vault_items_default_letterhead_per_user
  on public.workspace_vault_items (user_id)
  where is_default_letterhead = true and source_kind = 'template' and archived_at is null;
