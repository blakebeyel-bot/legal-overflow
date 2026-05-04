-- Round 10 — articles CMS.
--
-- Until now articles lived as markdown files under src/content/articles/.
-- Editing meant a code-level commit, which is friction we want to remove.
-- This migration moves articles into a database-backed CMS so the operator
-- can manage them through /admin/articles/ without touching the codebase.
--
-- Architecture:
--   - articles table holds title, dek, kind, track, body markdown, etc.
--   - article-images storage bucket holds inline images referenced by markdown.
--   - Public pages (src/pages/articles/[...slug].astro + home page cards)
--     read from the table at BUILD TIME via getStaticPaths(). New articles
--     appear publicly after a rebuild — triggered automatically by the
--     admin save endpoint via a Netlify Build Hook.
--   - Drafts (status='draft') do NOT generate public pages; they only show
--     up in the admin list.

-- ----- articles table -----
create table if not exists public.articles (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  dek           text not null default '',
  kind          text not null default 'Essay',         -- "Case Study" | "Essay" | "Field Note" | etc.
  track         text not null default 'legal'
                check (track in ('legal','business','both')),
  read_minutes  integer not null default 5,
  topic         text not null default 'General',
  cover         text not null default 'ph-b',          -- ph-a..ph-m placeholder color tokens
  cover_image_url text,                                 -- override; if set, used instead of placeholder
  featured      boolean not null default false,
  status        text not null default 'draft'
                check (status in ('draft','published')),
  body_md       text not null default '',              -- markdown body
  date          date not null default current_date,    -- publication date (used for display + sorting)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_articles_status_date
  on public.articles (status, date desc);
create index if not exists idx_articles_slug
  on public.articles (slug);
create index if not exists idx_articles_track
  on public.articles (track);

create or replace function public.touch_articles_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_articles_updated_at on public.articles;
create trigger trg_articles_updated_at
  before update on public.articles
  for each row execute procedure public.touch_articles_updated_at();

-- ----- RLS -----
alter table public.articles enable row level security;

-- Public can read PUBLISHED articles only (used by build-time and any
-- runtime queries from the storefront).
drop policy if exists "Public read published" on public.articles;
create policy "Public read published"
  on public.articles for select using (status = 'published');

-- Admin (tier='admin' on profiles) can do everything via the admin
-- endpoints — those endpoints use the service-role client which
-- bypasses RLS, so we don't need a permissive policy for them. We DO
-- want regular signed-in users to NOT be able to edit articles, which
-- the default-deny RLS achieves automatically.

-- ----- article-images storage bucket -----
-- Created via Supabase storage API; the SQL below registers it as a
-- public bucket so signed-in admins can upload and the public site can
-- reference uploaded images directly. Idempotent — `do nothing` on conflict.
insert into storage.buckets (id, name, public)
values ('article-images', 'article-images', true)
on conflict (id) do nothing;

-- Allow admins (tier='admin') to upload to article-images
drop policy if exists "Admins upload article images" on storage.objects;
create policy "Admins upload article images"
  on storage.objects for insert
  with check (
    bucket_id = 'article-images'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.tier = 'admin'
    )
  );

-- Allow public to read article images (so the public site can display them)
drop policy if exists "Public read article images" on storage.objects;
create policy "Public read article images"
  on storage.objects for select
  using (bucket_id = 'article-images');

-- Allow admins to delete their uploads
drop policy if exists "Admins delete article images" on storage.objects;
create policy "Admins delete article images"
  on storage.objects for delete
  using (
    bucket_id = 'article-images'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.tier = 'admin'
    )
  );

comment on table public.articles is
  'Database-backed article store. Replaces src/content/articles/ markdown files. Read at build time by Astro getStaticPaths; written by /admin/articles/ admin UI via netlify functions.';
