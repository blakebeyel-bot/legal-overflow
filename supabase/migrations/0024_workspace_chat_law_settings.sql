-- 0024_workspace_chat_law_settings.sql
--
-- Adds the three-toggle research mode: per-chat law_settings on
-- workspace_chats, post-hoc verification metadata on
-- workspace_chat_messages, and a Supabase-backed cache for fetched
-- statute/case HTML so we don't re-hit external sources on every
-- request.
--
-- Three toggles:
--   statutes_enabled  → server-side waterfall fetch of state statute
--                        text (state official → Cornell → Justia)
--   case_law_enabled  → server-side waterfall fetch of opinions
--                        (CourtListener → Justia → Cornell)
--   legiscan_enabled  → independent research mode pulling LegiScan
--                        bills + amendments
--
-- Plus an always-on passive amendment-freshness check on every
-- cited statute when statutes_enabled and LEGISCAN_API_KEY is
-- configured.

-- ============================================================
-- 1) law_settings on workspace_chats
-- ============================================================

alter table public.workspace_chats
  add column if not exists law_settings jsonb not null default '{}'::jsonb;

comment on column public.workspace_chats.law_settings is
  'Per-chat research toggles: { statutes_enabled, case_law_enabled, legiscan_enabled, state }. Updated each time the user changes a toggle in the chat composer toolbar.';

-- ============================================================
-- 2) verification on workspace_chat_messages
-- ============================================================
--
-- Shape:
-- {
--   "status": "pending" | "complete" | "error",
--   "started_at": iso,
--   "completed_at": iso | null,
--   "cites": [
--     { "kind": "statute"|"case"|"url",
--       "raw": "Fla. Stat. § 768.81",
--       "span": [start_offset, end_offset],
--       "status": "verified"|"secondary"|"unverified"|"pending_amendment"|"amended_enacted",
--       "primary_url": "https://...",
--       "amendment_note": "..." | null,
--       "details": { ... }
--     }
--   ]
-- }

alter table public.workspace_chat_messages
  add column if not exists verification jsonb;

comment on column public.workspace_chat_messages.verification is
  'Post-hoc citation verification result populated by workspace-chat-verify background function. status=pending while in flight; status=complete when cites[] is final.';

-- ============================================================
-- 3) workspace_law_cache — cached external HTML fetches
-- ============================================================
--
-- Statute and opinion text doesn't change often; caching for a
-- week saves a huge number of external requests.  Cache key is the
-- full URL we fetched.  Cleanup of expired rows is opportunistic
-- (the fetcher checks expires_at; a separate cron could prune).

create table if not exists public.workspace_law_cache (
  url            text primary key,
  source         text not null,            -- 'state' | 'cornell' | 'justia' | 'courtlistener' | 'legiscan'
  http_status    int  not null,
  parsed_text    text,                      -- statute / opinion body after HTML parse
  raw_html_size  int,
  fetched_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

create index if not exists workspace_law_cache_expires_idx
  on public.workspace_law_cache (expires_at);

comment on table public.workspace_law_cache is
  'Cache of external statute/opinion fetches. Keyed by URL with 7-day TTL. Service role only; no user-scoped RLS needed.';

-- Service role bypasses RLS; we still enable it for symmetry with
-- the rest of the schema.
alter table public.workspace_law_cache enable row level security;

-- No user-facing policies — cache is only read/written by the
-- service role from edge/background functions.

-- ============================================================
-- Done.
