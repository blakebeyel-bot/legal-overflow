-- 0025_workspace_chat_privacy_flag.sql
--
-- Adds the per-message Privacy mode marker. When a chat is sent
-- with Privacy mode on, the user's message is rewritten as an
-- abstract hypothetical before being stored. This column tells the
-- frontend to render the small "🔒 Privacy mode: abstracted" badge
-- on the message bubble after page reload.
--
-- The flag is informational only — the actual privacy guarantee is
-- that the original raw text was NEVER persisted to Supabase. By
-- the time the row exists, the content is already abstracted.

alter table public.workspace_chat_messages
  add column if not exists privacy_applied boolean not null default false;

comment on column public.workspace_chat_messages.privacy_applied is
  'True when this message was passed through the Privacy mode abstractor before storage. The content column already holds the abstracted form; this flag is just for surfacing a UI badge.';

-- Done.
