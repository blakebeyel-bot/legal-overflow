-- ============================================================
-- 0032_vault_images.sql
--
-- Multimodal RAG support: store the IMAGES embedded in vault docs
-- (PDFs, DOCXs) as first-class searchable objects with their own
-- vector embeddings, AI-generated captions, and source-position
-- metadata. Lets chat answer "what's in the chart on page 4?" by
-- attaching the actual image bytes to multimodal-capable models, or
-- by surfacing the caption text for non-multimodal ones.
--
-- This migration is PURELY ADDITIVE. It does not touch any existing
-- table, column, index, or RLS policy. Vault items, chunks, and
-- search behavior remain unchanged. Image extraction is gated behind:
--   1. The VAULT_IMAGE_EXTRACTION env var (default: off)
--   2. workspace_user_settings.vault_image_extraction_enabled
--      (default: false). Migration also adds this column.
--
-- ============================================================

-- ------------------------------------------------------------
-- workspace_vault_images — one row per extracted image
-- ------------------------------------------------------------
create table if not exists public.workspace_vault_images (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  item_id         uuid not null references public.workspace_vault_items(id) on delete cascade,

  -- Storage location — uses the existing 'library' bucket so we don't
  -- need to provision a new one. Path convention:
  --   {user_id}/vault-images/{image_uuid}.{ext}
  storage_path    text not null,
  mime_type       text not null,

  -- Source-position metadata. Lets chat say "see image on p.4 near
  -- the indemnity clause" instead of just "an image".
  source_kind     text not null default 'embedded'
    check (source_kind in ('embedded','rendered','attached')),
  source_page     integer,                    -- PDF: 1-indexed page; null for DOCX
  source_paragraph integer,                   -- DOCX: paragraph index in walk order; null for PDF
  source_rect     jsonb,                      -- {x1,y1,x2,y2} for PDFs (PDF user-space coords)

  -- Dimensions + size for cost / sanity capping
  width_px        integer,
  height_px       integer,
  byte_size       integer,

  -- AI caption from the vision model. Used inline in the body text
  -- as `[image-N: <description>]` so existing keyword + semantic
  -- search picks up image content for free, even before multimodal
  -- embeddings are added below. Nullable until the caption job runs.
  description     text,

  -- One column per supported MULTIMODAL embedding provider. Only one
  -- is populated per row, matching the user's chosen provider. We
  -- use voyage (multimodal-3) and gemini (Vertex multimodal). OpenAI
  -- has no public multimodal embedding API today; users on OpenAI
  -- fall back to caption-text retrieval (which still works because
  -- captions are written into chunk content).
  embedding_voyage  vector(1024),
  embedding_gemini  vector(768),

  -- Which provider populated the embedding above (nullable when
  -- captions exist but no multimodal embedding was generated, e.g.
  -- the user is on OpenAI).
  embedding_provider text
    check (embedding_provider is null or embedding_provider in ('voyage','gemini')),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists workspace_vault_images_item_idx
  on public.workspace_vault_images(item_id);
create index if not exists workspace_vault_images_user_idx
  on public.workspace_vault_images(user_id);

-- HNSW vector indexes per provider — partial so unused providers
-- don't pay the index cost. Same pattern as workspace_vault_chunks.
create index if not exists workspace_vault_images_voyage_idx
  on public.workspace_vault_images
  using hnsw (embedding_voyage vector_cosine_ops)
  where embedding_voyage is not null;
create index if not exists workspace_vault_images_gemini_idx
  on public.workspace_vault_images
  using hnsw (embedding_gemini vector_cosine_ops)
  where embedding_gemini is not null;

-- ------------------------------------------------------------
-- RLS — owner-only read/write
-- ------------------------------------------------------------
alter table public.workspace_vault_images enable row level security;

drop policy if exists workspace_vault_images_select on public.workspace_vault_images;
create policy workspace_vault_images_select
  on public.workspace_vault_images
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists workspace_vault_images_insert on public.workspace_vault_images;
create policy workspace_vault_images_insert
  on public.workspace_vault_images
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists workspace_vault_images_update on public.workspace_vault_images;
create policy workspace_vault_images_update
  on public.workspace_vault_images
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists workspace_vault_images_delete on public.workspace_vault_images;
create policy workspace_vault_images_delete
  on public.workspace_vault_images
  for delete to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------
-- updated_at trigger — reuse the helper from 0026
-- ------------------------------------------------------------
drop trigger if exists workspace_vault_images_touch_updated_at
  on public.workspace_vault_images;
create trigger workspace_vault_images_touch_updated_at
  before update on public.workspace_vault_images
  for each row execute function public._workspace_vault_items_touch_updated_at();

-- ------------------------------------------------------------
-- Per-user opt-in flag on workspace_user_settings
-- ------------------------------------------------------------
-- Default false: users explicitly opt in (Settings → Vault) before
-- the ingest pipeline starts staging images. Cost-control: image
-- extraction adds storage + vision API calls per upload.
alter table public.workspace_user_settings
  add column if not exists vault_image_extraction_enabled boolean not null default false;

-- ------------------------------------------------------------
-- workspace_vault_search RPC — extend to also search images
-- ------------------------------------------------------------
-- The existing workspace_vault_search RPC searches chunks. We add a
-- companion RPC workspace_vault_image_search that searches the
-- images table by cosine distance. The application layer (vault.js
-- searchVault) calls both in parallel and merges results.
create or replace function public.workspace_vault_image_search(
  p_user_id           uuid,
  p_query_vec         text,           -- vector literal '[...]'
  p_top_k             integer default 10,
  p_provider          text default 'voyage',
  p_include_archived  boolean default false
)
returns table (
  image_id          uuid,
  item_id           uuid,
  storage_path      text,
  mime_type         text,
  description       text,
  source_page       integer,
  source_paragraph  integer,
  width_px          integer,
  height_px         integer,
  distance          double precision,
  item_title        text,
  item_summary      text,
  item_source_kind  text,
  item_source_doc_id uuid,
  item_created_at   timestamptz,
  item_pinned       boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  qv vector;
begin
  qv := p_query_vec::vector;
  if p_provider = 'voyage' then
    return query
      select
        img.id, img.item_id, img.storage_path, img.mime_type, img.description,
        img.source_page, img.source_paragraph, img.width_px, img.height_px,
        (img.embedding_voyage <=> qv)::double precision as distance,
        it.title, it.summary, it.source_kind, it.source_doc_id, it.created_at, it.pinned
      from public.workspace_vault_images img
      join public.workspace_vault_items it on it.id = img.item_id
      where img.user_id = p_user_id
        and img.embedding_voyage is not null
        and (p_include_archived or it.archived_at is null)
      order by img.embedding_voyage <=> qv
      limit p_top_k;
  elsif p_provider = 'gemini' then
    return query
      select
        img.id, img.item_id, img.storage_path, img.mime_type, img.description,
        img.source_page, img.source_paragraph, img.width_px, img.height_px,
        (img.embedding_gemini <=> qv)::double precision as distance,
        it.title, it.summary, it.source_kind, it.source_doc_id, it.created_at, it.pinned
      from public.workspace_vault_images img
      join public.workspace_vault_items it on it.id = img.item_id
      where img.user_id = p_user_id
        and img.embedding_gemini is not null
        and (p_include_archived or it.archived_at is null)
      order by img.embedding_gemini <=> qv
      limit p_top_k;
  else
    return; -- unknown provider, return nothing
  end if;
end;
$$;

grant execute on function public.workspace_vault_image_search(
  uuid, text, integer, text, boolean
) to authenticated;

-- ============================================================
-- Migration complete.
--
-- Verification (run manually in SQL editor after applying):
--   1. select count(*) from workspace_vault_images;        -- 0
--   2. \d workspace_vault_images                            -- columns + indexes
--   3. select vault_image_extraction_enabled
--        from workspace_user_settings limit 1;             -- false
--   4. Try as a regular user:
--        insert into workspace_vault_images (user_id, item_id, storage_path, mime_type)
--        values ('00000000-0000-0000-0000-000000000000', ...);  -- must fail RLS
-- ============================================================
