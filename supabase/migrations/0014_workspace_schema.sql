-- Round 14 — Workspace.
--
-- Adds the persistent multi-turn chat / document library / projects /
-- folders / workflows / tabular reviews substrate. This is a clean-room
-- design (no AGPL code copied from any third party) implemented in our
-- existing stack: Supabase Postgres + Storage + Auth, Netlify Functions
-- for write-paths, Netlify Edge Functions for chat streaming, Astro
-- pages for the UI.
--
-- Architecture choices:
--   - All ownership keyed off auth.uid() (uuid). RLS enforces
--     "own data only" everywhere. No multi-user sharing in this
--     migration; that's a deliberate later phase.
--   - Documents are soft-deleted (deleted_at) so users can't lose work
--     to a fat-fingered click. The 30-day purge function ignores library
--     uploads — purge is only for the ephemeral one-shot agent uploads.
--   - Workflows have a system/published flag so the operator can curate
--     a default set of FL-specific playbooks visible to every user.
--   - Tabular review cells are stored as individual rows so we can
--     stream cell completion to the client and recover from partial
--     failures without losing completed work.
--   - BYOK API keys are stored as ciphertext only. Encryption +
--     decryption happen in the application layer using the
--     BYOK_ENCRYPTION_KEY env var (AES-256-GCM). Compromising the
--     database alone does NOT leak keys; an attacker also needs the
--     env var.

-- ============================================================================
-- 1. Projects
-- ============================================================================
-- A "project" is a workspace for a matter/deal. Documents, chats, and
-- tabular reviews all may belong to a project (or live in the global
-- "no project" bucket).

create table if not exists public.workspace_projects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  archived_at   timestamptz,                            -- soft-archive
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_workspace_projects_user
  on public.workspace_projects (user_id, archived_at, updated_at desc);

create or replace function public.touch_workspace_projects_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_projects_updated_at on public.workspace_projects;
create trigger trg_workspace_projects_updated_at
  before update on public.workspace_projects
  for each row execute procedure public.touch_workspace_projects_updated_at();

alter table public.workspace_projects enable row level security;

drop policy if exists "Own projects: read" on public.workspace_projects;
create policy "Own projects: read"
  on public.workspace_projects for select using (auth.uid() = user_id);

drop policy if exists "Own projects: write" on public.workspace_projects;
create policy "Own projects: write"
  on public.workspace_projects for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- 2. Project folders (1 level deep — keep it simple)
-- ============================================================================

create table if not exists public.workspace_project_folders (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.workspace_projects(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_workspace_folders_project
  on public.workspace_project_folders (project_id);

alter table public.workspace_project_folders enable row level security;

drop policy if exists "Own folders: read" on public.workspace_project_folders;
create policy "Own folders: read"
  on public.workspace_project_folders for select using (auth.uid() = user_id);

drop policy if exists "Own folders: write" on public.workspace_project_folders;
create policy "Own folders: write"
  on public.workspace_project_folders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- 3. Library documents (persistent uploads, separate from one-shot agent uploads)
-- ============================================================================
-- Files uploaded into the workspace stay until the user deletes them.
-- The optional project_id + folder_id locate them in a project; null
-- both means "global library, not in any project".

create table if not exists public.workspace_documents (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  project_id          uuid references public.workspace_projects(id) on delete cascade,
  folder_id           uuid references public.workspace_project_folders(id) on delete set null,
  filename            text not null,                   -- display name (user-editable)
  original_filename   text not null,                   -- original uploaded name (immutable)
  file_type           text not null,                   -- MIME type
  size_bytes          bigint not null default 0,
  page_count          integer,
  current_version_id  uuid,                             -- FK populated after first version inserted
  status              text not null default 'ready'
                      check (status in ('uploading','processing','ready','failed')),
  status_detail       text,                             -- error message if status='failed'
  deleted_at          timestamptz,                      -- soft delete
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_workspace_documents_user_project
  on public.workspace_documents (user_id, project_id, deleted_at, updated_at desc);
create index if not exists idx_workspace_documents_folder
  on public.workspace_documents (folder_id);

create or replace function public.touch_workspace_documents_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_documents_updated_at on public.workspace_documents;
create trigger trg_workspace_documents_updated_at
  before update on public.workspace_documents
  for each row execute procedure public.touch_workspace_documents_updated_at();

alter table public.workspace_documents enable row level security;

drop policy if exists "Own documents: read" on public.workspace_documents;
create policy "Own documents: read"
  on public.workspace_documents for select using (auth.uid() = user_id);

drop policy if exists "Own documents: write" on public.workspace_documents;
create policy "Own documents: write"
  on public.workspace_documents for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- 4. Document versions (every save creates a new version)
-- ============================================================================
-- source: how the version was created. 'upload' = user uploaded fresh,
-- 'redline' = produced by the chat redlining tool, 'user_edit' = user
-- accepted/rejected redlines and saved the resolved version.

create table if not exists public.workspace_document_versions (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.workspace_documents(id) on delete cascade,
  version_number  integer not null,
  storage_path    text not null,                        -- supabase storage 'library/...' key
  pdf_storage_path text,                                -- optional pre-converted pdf
  source          text not null default 'upload'
                  check (source in ('upload','redline','user_edit','generated')),
  display_name    text,                                 -- e.g. "v3 — redline by Claude"
  size_bytes      bigint not null default 0,
  created_at      timestamptz not null default now(),
  unique (document_id, version_number)
);

create index if not exists idx_workspace_doc_versions_doc
  on public.workspace_document_versions (document_id, version_number desc);

alter table public.workspace_document_versions enable row level security;

drop policy if exists "Own document versions: read" on public.workspace_document_versions;
create policy "Own document versions: read"
  on public.workspace_document_versions for select using (
    exists (
      select 1 from public.workspace_documents d
      where d.id = workspace_document_versions.document_id and d.user_id = auth.uid()
    )
  );

drop policy if exists "Own document versions: write" on public.workspace_document_versions;
create policy "Own document versions: write"
  on public.workspace_document_versions for all using (
    exists (
      select 1 from public.workspace_documents d
      where d.id = workspace_document_versions.document_id and d.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspace_documents d
      where d.id = workspace_document_versions.document_id and d.user_id = auth.uid()
    )
  );

-- now that the table exists we can add the FK from documents.current_version_id
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_documents_current_version_fk'
  ) then
    alter table public.workspace_documents
      add constraint workspace_documents_current_version_fk
      foreign key (current_version_id)
      references public.workspace_document_versions(id)
      on delete set null;
  end if;
end $$;

-- ============================================================================
-- 5. Chats and chat messages
-- ============================================================================
-- A chat is a conversation thread. Messages within store the user's
-- prompts, the assistant's streamed responses, attached document refs,
-- citations, and metadata (which model / how many tokens / etc.).

create table if not exists public.workspace_chats (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  project_id   uuid references public.workspace_projects(id) on delete set null,
  title        text,                                    -- auto-generated from first message; null until generated
  model        text not null default 'claude-sonnet-4-5',  -- last-used model on this chat
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_workspace_chats_user
  on public.workspace_chats (user_id, project_id, updated_at desc);

create or replace function public.touch_workspace_chats_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_chats_updated_at on public.workspace_chats;
create trigger trg_workspace_chats_updated_at
  before update on public.workspace_chats
  for each row execute procedure public.touch_workspace_chats_updated_at();

alter table public.workspace_chats enable row level security;

drop policy if exists "Own chats: read" on public.workspace_chats;
create policy "Own chats: read"
  on public.workspace_chats for select using (auth.uid() = user_id);

drop policy if exists "Own chats: write" on public.workspace_chats;
create policy "Own chats: write"
  on public.workspace_chats for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.workspace_chat_messages (
  id              uuid primary key default gen_random_uuid(),
  chat_id         uuid not null references public.workspace_chats(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system','tool')),
  content         text,                                 -- final rendered text (post-streaming)
  attachments     jsonb not null default '[]'::jsonb,   -- [{document_id, version_id, filename}]
  citations       jsonb not null default '[]'::jsonb,   -- [{ref, doc_id, page, quote}]
  tool_calls      jsonb,                                 -- if assistant invoked tools
  model_used      text,                                  -- which model produced this
  prompt_tokens   integer,
  completion_tokens integer,
  workflow_id     uuid,                                  -- if message kicked off a workflow run
  status          text not null default 'complete'
                  check (status in ('streaming','complete','error','cancelled')),
  status_detail   text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_workspace_chat_messages_chat
  on public.workspace_chat_messages (chat_id, created_at);

alter table public.workspace_chat_messages enable row level security;

drop policy if exists "Own chat messages: read" on public.workspace_chat_messages;
create policy "Own chat messages: read"
  on public.workspace_chat_messages for select using (
    exists (
      select 1 from public.workspace_chats c
      where c.id = workspace_chat_messages.chat_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "Own chat messages: write" on public.workspace_chat_messages;
create policy "Own chat messages: write"
  on public.workspace_chat_messages for all using (
    exists (
      select 1 from public.workspace_chats c
      where c.id = workspace_chat_messages.chat_id and c.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspace_chats c
      where c.id = workspace_chat_messages.chat_id and c.user_id = auth.uid()
    )
  );

-- ============================================================================
-- 6. Workflows (saved playbooks)
-- ============================================================================
-- A workflow is a reusable prompt + (for tabular workflows) column
-- config. system+published workflows are visible to every user;
-- user-owned workflows are private to that user. The operator publishes
-- FL-specific defaults via /admin/workflows/.

create table if not exists public.workspace_workflows (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,  -- null for system
  title           text not null,
  description     text not null default '',
  kind            text not null check (kind in ('chat','tabular')),
  prompt_md       text not null default '',             -- chat: system prompt body. tabular: pre-prompt for every cell.
  columns_config  jsonb,                                 -- tabular only: [{name, prompt, format?}]
  practice_area   text,                                  -- "MSA review", "NDA review", "FL real estate", etc.
  is_system       boolean not null default false,        -- can't be deleted; appears for everyone
  is_published    boolean not null default false,        -- user_id=null + is_published=true → visible to all
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_workspace_workflows_user
  on public.workspace_workflows (user_id, kind, updated_at desc);
create index if not exists idx_workspace_workflows_published
  on public.workspace_workflows (is_published, kind) where user_id is null;

create or replace function public.touch_workspace_workflows_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_workflows_updated_at on public.workspace_workflows;
create trigger trg_workspace_workflows_updated_at
  before update on public.workspace_workflows
  for each row execute procedure public.touch_workspace_workflows_updated_at();

alter table public.workspace_workflows enable row level security;

-- Read: own workflows OR published system workflows
drop policy if exists "Workflows: read" on public.workspace_workflows;
create policy "Workflows: read"
  on public.workspace_workflows for select using (
    auth.uid() = user_id
    or (user_id is null and is_published = true)
  );

-- Write: only own workflows. System workflows are managed via admin
-- service-role client (bypasses RLS).
drop policy if exists "Workflows: write own" on public.workspace_workflows;
create policy "Workflows: write own"
  on public.workspace_workflows for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- 7. Tabular reviews and cells
-- ============================================================================
-- A tabular review is an N×M grid: N documents (rows) by M columns
-- (questions). Each cell is a separate LLM call so we can fan out and
-- recover from partial failure.

create table if not exists public.workspace_tabular_reviews (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  project_id      uuid references public.workspace_projects(id) on delete set null,
  title           text not null,
  columns_config  jsonb not null,                       -- [{index, name, prompt, format?}]
  workflow_id     uuid references public.workspace_workflows(id) on delete set null,
  model           text not null default 'claude-sonnet-4-5',
  status          text not null default 'pending'
                  check (status in ('pending','running','complete','partial','error','cancelled')),
  status_detail   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_workspace_tr_user
  on public.workspace_tabular_reviews (user_id, project_id, updated_at desc);

create or replace function public.touch_workspace_tr_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_tr_updated_at on public.workspace_tabular_reviews;
create trigger trg_workspace_tr_updated_at
  before update on public.workspace_tabular_reviews
  for each row execute procedure public.touch_workspace_tr_updated_at();

alter table public.workspace_tabular_reviews enable row level security;

drop policy if exists "Own tabular reviews: read" on public.workspace_tabular_reviews;
create policy "Own tabular reviews: read"
  on public.workspace_tabular_reviews for select using (auth.uid() = user_id);

drop policy if exists "Own tabular reviews: write" on public.workspace_tabular_reviews;
create policy "Own tabular reviews: write"
  on public.workspace_tabular_reviews for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.workspace_tabular_cells (
  id              uuid primary key default gen_random_uuid(),
  review_id       uuid not null references public.workspace_tabular_reviews(id) on delete cascade,
  document_id     uuid not null references public.workspace_documents(id) on delete cascade,
  column_index    integer not null,
  content         text,                                 -- the answer
  citations       jsonb not null default '[]'::jsonb,
  model_used      text,
  prompt_tokens   integer,
  completion_tokens integer,
  status          text not null default 'pending'
                  check (status in ('pending','running','complete','error')),
  status_detail   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (review_id, document_id, column_index)
);

create index if not exists idx_workspace_tr_cells_review
  on public.workspace_tabular_cells (review_id, status);

create or replace function public.touch_workspace_tr_cells_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_tr_cells_updated_at on public.workspace_tabular_cells;
create trigger trg_workspace_tr_cells_updated_at
  before update on public.workspace_tabular_cells
  for each row execute procedure public.touch_workspace_tr_cells_updated_at();

alter table public.workspace_tabular_cells enable row level security;

drop policy if exists "Own tabular cells: read" on public.workspace_tabular_cells;
create policy "Own tabular cells: read"
  on public.workspace_tabular_cells for select using (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_cells.review_id and r.user_id = auth.uid()
    )
  );

drop policy if exists "Own tabular cells: write" on public.workspace_tabular_cells;
create policy "Own tabular cells: write"
  on public.workspace_tabular_cells for all using (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_cells.review_id and r.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspace_tabular_reviews r
      where r.id = workspace_tabular_cells.review_id and r.user_id = auth.uid()
    )
  );

-- ============================================================================
-- 8. BYOK API keys (encrypted at the application layer)
-- ============================================================================
-- Stored as ciphertext only. Encryption + decryption happen in the
-- application using BYOK_ENCRYPTION_KEY (AES-256-GCM). The DB never
-- sees the key. We also store a hashed fingerprint so the UI can show
-- "key ending in ...xyz9" without decrypting.

create table if not exists public.workspace_user_api_keys (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  provider        text not null check (provider in ('anthropic','openai','google')),
  ciphertext      text not null,                        -- base64(iv || authtag || ciphertext)
  fingerprint     text not null,                        -- last 4 chars of plaintext (display only)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists idx_workspace_api_keys_user
  on public.workspace_user_api_keys (user_id);

create or replace function public.touch_workspace_api_keys_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_workspace_api_keys_updated_at on public.workspace_user_api_keys;
create trigger trg_workspace_api_keys_updated_at
  before update on public.workspace_user_api_keys
  for each row execute procedure public.touch_workspace_api_keys_updated_at();

alter table public.workspace_user_api_keys enable row level security;

drop policy if exists "Own api keys: read" on public.workspace_user_api_keys;
create policy "Own api keys: read"
  on public.workspace_user_api_keys for select using (auth.uid() = user_id);

drop policy if exists "Own api keys: write" on public.workspace_user_api_keys;
create policy "Own api keys: write"
  on public.workspace_user_api_keys for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- 9. Library storage bucket policies
-- ============================================================================
-- The 'library' bucket is created via Supabase UI (Phase 0 step 0.5).
-- These policies scope read/write to "user owns the row in
-- workspace_documents that points at this storage_path". Path
-- convention: library/{user_id}/{document_id}/{version_id}.{ext}

-- Allow authenticated users to upload to their own user-id-prefixed path.
drop policy if exists "Workspace library: upload own" on storage.objects;
create policy "Workspace library: upload own"
  on storage.objects for insert
  with check (
    bucket_id = 'library'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Workspace library: read own" on storage.objects;
create policy "Workspace library: read own"
  on storage.objects for select
  using (
    bucket_id = 'library'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Workspace library: update own" on storage.objects;
create policy "Workspace library: update own"
  on storage.objects for update
  using (
    bucket_id = 'library'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Workspace library: delete own" on storage.objects;
create policy "Workspace library: delete own"
  on storage.objects for delete
  using (
    bucket_id = 'library'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================================
-- 10. Comments
-- ============================================================================

comment on table public.workspace_projects is
  'Workspace projects (matters/deals). Container for documents, chats, tabular reviews. Phase 3.';
comment on table public.workspace_documents is
  'Persistent document library. Survives 30-day purge. Phase 2.';
comment on table public.workspace_document_versions is
  'Version history per document. Includes redline outputs from chat tools. Phase 2/6.';
comment on table public.workspace_chats is
  'Persistent chat threads. One row per conversation. Phase 1.';
comment on table public.workspace_chat_messages is
  'Individual messages within a chat. Stores citations + tool-call traces. Phase 1.';
comment on table public.workspace_workflows is
  'Saved playbooks. is_published+user_id=null = curated by operator. Phase 5.';
comment on table public.workspace_tabular_reviews is
  'N-doc x M-column analysis grids. Phase 4.';
comment on table public.workspace_tabular_cells is
  'Individual cells in a tabular review. Each is one LLM call. Phase 4.';
comment on table public.workspace_user_api_keys is
  'BYOK API keys, AES-256-GCM ciphertext. Phase 1.';
