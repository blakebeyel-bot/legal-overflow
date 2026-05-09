-- 0026_workspace_vault.sql
--
-- Personal Vault — per-user RAG knowledge base.
--
-- Lawyers continuously accumulate work product (deposition transcripts,
-- prior briefs, contract precedents, internal memos). The Vault
-- captures all of that in one place and exposes it to chat via
-- semantic retrieval, giving the AI long-term memory of the user's
-- practice without forcing them to re-attach the same docs every chat.
--
-- Data model:
--   workspace_vault_items   — header per "thing" the user added
--   workspace_vault_chunks  — paragraph-sized chunks with embeddings
--   workspace_user_settings — per-user vault preferences (provider, auto-ingest)
--
-- Privacy: strictly per-user. RLS enforces auth.uid() = user_id on
-- every row. Vault content is stored RAW; the chat pipeline runs it
-- through abstractContent() at retrieval time when privacy mode is on
-- ("clean on the way out").
--
-- Embeddings: three vector columns per chunk (voyage 1024 / openai 1536
-- / gemini 768). Only the column matching the user's chosen provider
-- is populated; switching providers triggers a re-embed background
-- job.

create extension if not exists vector;

-- ============================================================
-- workspace_vault_items — header row per saved knowledge item
-- ============================================================

create table if not exists public.workspace_vault_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,

  -- Where did this come from?
  source_kind     text not null check (source_kind in ('document','chat','review_finding','manual_note')),
  source_doc_id        uuid references public.workspace_documents on delete set null,
  source_chat_id       uuid references public.workspace_chats on delete set null,
  source_message_id    uuid references public.workspace_chat_messages on delete set null,
  source_review_id     uuid references public.workspace_tabular_reviews on delete set null,

  -- Display metadata
  title           text not null,
  summary         text,                       -- short 1-2 sentence scan
  tags            text[],                     -- e.g. ['deposition','smith-v-jones','damages']

  -- Full raw content. Privacy abstraction happens at retrieval time
  -- (when a privacy-mode chat asks for vault content) so we always
  -- store the original.
  content         text not null,
  content_chars   integer generated always as (length(content)) stored,

  -- Which embedding provider produced the chunks below. Lets us know
  -- whether a re-embed is needed when the user switches providers.
  embedding_provider text check (embedding_provider in ('voyage','openai','gemini')),

  -- User flags
  pinned          boolean not null default false,
  archived_at     timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists workspace_vault_items_user_idx
  on public.workspace_vault_items(user_id);
create index if not exists workspace_vault_items_user_archived_idx
  on public.workspace_vault_items(user_id, archived_at) where archived_at is null;
create index if not exists workspace_vault_items_user_pinned_idx
  on public.workspace_vault_items(user_id, pinned) where pinned = true;
create index if not exists workspace_vault_items_user_kind_idx
  on public.workspace_vault_items(user_id, source_kind);

-- Auto-update updated_at on row change
create or replace function public._workspace_vault_items_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists workspace_vault_items_touch_updated_at on public.workspace_vault_items;
create trigger workspace_vault_items_touch_updated_at
  before update on public.workspace_vault_items
  for each row execute function public._workspace_vault_items_touch_updated_at();

-- ============================================================
-- workspace_vault_chunks — paragraph chunks with embeddings
-- ============================================================

create table if not exists public.workspace_vault_chunks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  item_id     uuid not null references public.workspace_vault_items on delete cascade,
  chunk_index integer not null,
  content     text not null,

  -- One column per supported provider. Only one is populated per row,
  -- matching the user's chosen embedding_provider. Switching providers
  -- re-embeds and rewrites these columns.
  embedding_voyage  vector(1024),
  embedding_openai  vector(1536),
  embedding_gemini  vector(768),

  created_at  timestamptz not null default now()
);

create index if not exists workspace_vault_chunks_item_idx
  on public.workspace_vault_chunks(item_id, chunk_index);
create index if not exists workspace_vault_chunks_user_idx
  on public.workspace_vault_chunks(user_id);

-- HNSW indexes per provider (partial — only over populated rows so
-- unused providers don't pay the index cost).
create index if not exists vault_chunks_voyage_idx on public.workspace_vault_chunks
  using hnsw (embedding_voyage vector_cosine_ops) where embedding_voyage is not null;
create index if not exists vault_chunks_openai_idx on public.workspace_vault_chunks
  using hnsw (embedding_openai vector_cosine_ops) where embedding_openai is not null;
create index if not exists vault_chunks_gemini_idx on public.workspace_vault_chunks
  using hnsw (embedding_gemini vector_cosine_ops) where embedding_gemini is not null;

-- ============================================================
-- workspace_user_settings — per-user vault preferences
-- ============================================================

create table if not exists public.workspace_user_settings (
  user_id     uuid primary key references auth.users on delete cascade,

  -- Which embedding provider the vault uses for THIS user. Switching
  -- triggers a re-embed background job for all of the user's chunks.
  vault_embedding_provider text not null default 'gemini'
    check (vault_embedding_provider in ('voyage','openai','gemini')),

  -- Auto-capture defaults
  vault_auto_ingest_uploads boolean not null default true,
  vault_auto_ingest_chats   boolean not null default false,
  vault_auto_use_in_chats   boolean not null default true,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists workspace_user_settings_touch_updated_at on public.workspace_user_settings;
create trigger workspace_user_settings_touch_updated_at
  before update on public.workspace_user_settings
  for each row execute function public._workspace_vault_items_touch_updated_at();

-- ============================================================
-- workspace_document_versions extensions
-- ============================================================
-- Tracks which extraction path produced extracted_text and whether
-- the content is structured markdown vs plain text. Used by the chat
-- pipeline to inline attachments correctly and by the OCR background
-- job to mark its output.

alter table public.workspace_document_versions
  add column if not exists extraction_method text;
-- 'pdfjs' | 'mammoth' | 'plain' | 'ocr' | null (legacy / not yet extracted)

alter table public.workspace_document_versions
  add column if not exists extracted_format text not null default 'plain'
  check (extracted_format in ('plain','markdown'));

-- ============================================================
-- Row Level Security — strictly per-user. No sharing in v1.
-- ============================================================

alter table public.workspace_vault_items enable row level security;
alter table public.workspace_vault_chunks enable row level security;
alter table public.workspace_user_settings enable row level security;

drop policy if exists vault_items_owner_all on public.workspace_vault_items;
create policy vault_items_owner_all
  on public.workspace_vault_items for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists vault_chunks_owner_all on public.workspace_vault_chunks;
create policy vault_chunks_owner_all
  on public.workspace_vault_chunks for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists vault_settings_owner_all on public.workspace_user_settings;
create policy vault_settings_owner_all
  on public.workspace_user_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- workspace_vault_search — RPC for semantic search
-- ============================================================
--
-- Supabase / PostgREST doesn't expose pgvector operators directly,
-- so we wrap the cosine-distance query in a SECURITY INVOKER
-- function. SECURITY INVOKER means the function runs with the
-- caller's privileges — RLS still applies, and the user can only
-- see their own chunks. We additionally filter by p_user_id for
-- belt-and-suspenders.
--
-- The function takes the embedding as a `vector` literal text
-- (e.g. '[0.1, 0.2, ...]') so we don't have to worry about its
-- dimension being baked into the signature. It picks the right
-- column by the p_provider argument.
--
-- Returns one row per matching chunk with item metadata joined.

create or replace function public.workspace_vault_search(
  p_user_id           uuid,
  p_query_vec         text,
  p_top_k             int,
  p_kinds             text[],
  p_provider          text,
  p_include_archived  boolean
)
returns table (
  chunk_id            uuid,
  item_id             uuid,
  chunk_content       text,
  chunk_index         int,
  distance            float,
  item_title          text,
  item_summary        text,
  item_source_kind    text,
  item_source_doc_id  uuid,
  item_created_at     timestamptz,
  item_pinned         boolean
)
language plpgsql
security invoker
as $$
begin
  if p_provider = 'voyage' then
    return query
      select c.id,
             c.item_id,
             c.content,
             c.chunk_index,
             (c.embedding_voyage <=> p_query_vec::vector)::float as distance,
             i.title,
             i.summary,
             i.source_kind,
             i.source_doc_id,
             i.created_at,
             i.pinned
      from public.workspace_vault_chunks c
      join public.workspace_vault_items i on i.id = c.item_id
      where c.user_id = p_user_id
        and c.embedding_voyage is not null
        and (p_kinds is null or i.source_kind = any(p_kinds))
        and (p_include_archived or i.archived_at is null)
      order by c.embedding_voyage <=> p_query_vec::vector
      limit p_top_k;
  elsif p_provider = 'openai' then
    return query
      select c.id,
             c.item_id,
             c.content,
             c.chunk_index,
             (c.embedding_openai <=> p_query_vec::vector)::float as distance,
             i.title,
             i.summary,
             i.source_kind,
             i.source_doc_id,
             i.created_at,
             i.pinned
      from public.workspace_vault_chunks c
      join public.workspace_vault_items i on i.id = c.item_id
      where c.user_id = p_user_id
        and c.embedding_openai is not null
        and (p_kinds is null or i.source_kind = any(p_kinds))
        and (p_include_archived or i.archived_at is null)
      order by c.embedding_openai <=> p_query_vec::vector
      limit p_top_k;
  elsif p_provider = 'gemini' then
    return query
      select c.id,
             c.item_id,
             c.content,
             c.chunk_index,
             (c.embedding_gemini <=> p_query_vec::vector)::float as distance,
             i.title,
             i.summary,
             i.source_kind,
             i.source_doc_id,
             i.created_at,
             i.pinned
      from public.workspace_vault_chunks c
      join public.workspace_vault_items i on i.id = c.item_id
      where c.user_id = p_user_id
        and c.embedding_gemini is not null
        and (p_kinds is null or i.source_kind = any(p_kinds))
        and (p_include_archived or i.archived_at is null)
      order by c.embedding_gemini <=> p_query_vec::vector
      limit p_top_k;
  else
    raise exception 'workspace_vault_search: unknown provider %', p_provider;
  end if;
end;
$$;

grant execute on function public.workspace_vault_search to authenticated;

-- ============================================================
-- Comments — for posterity & schema tooling
-- ============================================================

comment on table public.workspace_vault_items is
  'Per-user knowledge base header. Each row is one "thing" the user added — a document, a saved chat, a review finding, or a manual note. Content is stored raw; privacy abstraction happens at retrieval time.';
comment on table public.workspace_vault_chunks is
  'Paragraph-sized chunks of a vault item with embeddings. Three nullable vector columns (one per supported provider); only the column matching the user''s embedding_provider setting is populated.';
comment on table public.workspace_user_settings is
  'Per-user preferences for vault behavior — embedding provider, auto-ingest defaults, and auto-use-in-chats default.';
comment on column public.workspace_document_versions.extraction_method is
  'Which extraction path produced extracted_text: pdfjs, mammoth, plain, or ocr.';
comment on column public.workspace_document_versions.extracted_format is
  'Format of extracted_text: plain (legacy) or markdown (new pipeline).';

-- Done.
