-- ============================================================
-- 0033_chat_anchors.sql
--
-- Pinned vault items per chat. When the user asks the first few
-- questions about a specific document and clicks "Anchor", that
-- doc's id lands in workspace_chats.anchored_item_ids. Every
-- subsequent turn the chat-stream guarantees:
--   1. Chunks from anchored items are included in the system prompt
--      (top N chunks per item, regardless of vector match)
--   2. Images from anchored items are attached to vision-capable
--      chat models (every turn, not just when vector search wins)
--
-- This solves the "follow-up question lost the doc" problem:
-- semantic retrieval was running fresh per turn against the user's
-- new query text — short follow-ups like "how many dotted lines?"
-- failed to match the doc's chunks and pulled unrelated material.
-- Anchors short-circuit that.
--
-- Capped at 5 anchors per chat (server enforces) to keep prompt
-- bloat reasonable. Anchors persist per-chat; deleting the chat
-- cascades them away.
-- ============================================================

alter table public.workspace_chats
  add column if not exists anchored_item_ids uuid[] not null default '{}';

-- Helpful index for the rare "which chats anchor this item?" query.
-- Postgres' GIN index on uuid[] supports the @> and && operators.
create index if not exists workspace_chats_anchored_item_ids_idx
  on public.workspace_chats
  using gin (anchored_item_ids);

comment on column public.workspace_chats.anchored_item_ids is
  'Vault item ids pinned to this chat. Every turn'' chunks + images come from these items in addition to vector search.';
