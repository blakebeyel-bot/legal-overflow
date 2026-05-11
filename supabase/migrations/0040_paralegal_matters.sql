-- ============================================================================
-- 0040 — Paralegal Voice Agent: matter system foundations
--
-- Four tables that turn the static /agents/paralegal/* mock pages into a real
-- per-user matter system. The Paralegal voice agent (Phase 3+) will orbit
-- around these tables — every voice turn, tool call, and approval is scoped
-- to a matter; every linked Vault doc / Library file / chat / email lives in
-- paralegal_matter_items.
--
-- Tables:
--   1. paralegal_matters         — one row per client matter (Acme MSA, etc.)
--   2. paralegal_matter_items    — polymorphic links from matters to existing
--                                  workspace objects (vault items, library
--                                  docs, chats, redline runs, emails, etc.)
--   3. paralegal_pending_actions — the voice-approval queue (drafts emails,
--                                  calendar holds, doc shares before they
--                                  fire)
--   4. paralegal_audit_log       — every voice turn, tool call, and approval
--                                  for the per-matter PDF audit export
--
-- RLS posture mirrors the existing workspace_* tables: users SELECT / INSERT
-- / UPDATE only their own rows; service-role (admin endpoints + background
-- workers) bypasses RLS.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. paralegal_matters
-- ---------------------------------------------------------------------------
create table if not exists public.paralegal_matters (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,

  -- Core identification (mirrors the matter-detail page header fields)
  client                      text not null,
  counter_party               text,
  matter_type                 text,                              -- 'Vendor MSA', 'DPA', 'NDA', etc.
  posture                     text,                              -- 'client-side · SaaS', etc.

  -- Stage tracking (mirrors the 6-step stage track on matter detail)
  stage                       text not null default 'intake',    -- 'intake'|'conflict'|'quick_scan'|'redline'|'sign'|'watch'
  status                      text not null default 'active',    -- 'active'|'watching'|'closed'

  -- Deadlines + relationships
  response_due                timestamptz,
  due_date                    timestamptz,
  conflict_cleared_at         timestamptz,

  -- Defaults used when running tools without explicit overrides
  playbook_vault_item_id      uuid references public.workspace_vault_items(id) on delete set null,

  -- Bookkeeping
  hours_billed                numeric(10,2) default 0,
  voice_enabled               boolean not null default true,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  archived_at                 timestamptz                        -- soft delete
);

create index if not exists idx_paralegal_matters_user
  on public.paralegal_matters(user_id)
  where archived_at is null;

create index if not exists idx_paralegal_matters_status
  on public.paralegal_matters(user_id, status)
  where archived_at is null;

create index if not exists idx_paralegal_matters_response_due
  on public.paralegal_matters(user_id, response_due)
  where archived_at is null and response_due is not null;

alter table public.paralegal_matters enable row level security;

create policy "paralegal_matters_self_select" on public.paralegal_matters
  for select using (auth.uid() = user_id);

create policy "paralegal_matters_self_insert" on public.paralegal_matters
  for insert with check (auth.uid() = user_id);

create policy "paralegal_matters_self_update" on public.paralegal_matters
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "paralegal_matters_self_delete" on public.paralegal_matters
  for delete using (auth.uid() = user_id);

-- updated_at trigger
create or replace function public.paralegal_matters_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists paralegal_matters_touch on public.paralegal_matters;
create trigger paralegal_matters_touch
  before update on public.paralegal_matters
  for each row execute procedure public.paralegal_matters_touch();


-- ---------------------------------------------------------------------------
-- 2. paralegal_matter_items
--
-- Polymorphic join. Instead of foreign-keying each item_kind to its own
-- table, we store the kind + ref_id and let the application resolve the
-- canonical row. This keeps the table simple as item kinds proliferate.
-- ---------------------------------------------------------------------------
create table if not exists public.paralegal_matter_items (
  id            uuid primary key default gen_random_uuid(),
  matter_id     uuid not null references public.paralegal_matters(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,

  item_kind     text not null check (item_kind in (
                  'vault_item',
                  'library_document',
                  'chat',
                  'email_thread',
                  'calendar_event',
                  'redline_run',
                  'compare_run',
                  'tr_review',
                  'citation_run',
                  'manual_note'
                )),
  item_ref_id   uuid,                                            -- foreign key to whichever table item_kind names
  -- For email_thread / calendar_event we don't have a workspace table to point
  -- at, so we store a text key (the Graph message_id or event_id) instead:
  item_ref_key  text,
  metadata      jsonb not null default '{}'::jsonb,              -- snapshot of title, kind icon, etc. so detached items still render

  attached_at   timestamptz not null default now(),
  attached_by   text not null default 'user' check (attached_by in ('user', 'agent', 'system'))
);

-- Each (matter, kind, ref) is unique
create unique index if not exists ux_paralegal_matter_items_kind_ref
  on public.paralegal_matter_items(matter_id, item_kind, coalesce(item_ref_id::text, item_ref_key));

create index if not exists idx_paralegal_matter_items_matter
  on public.paralegal_matter_items(matter_id);

create index if not exists idx_paralegal_matter_items_user_kind
  on public.paralegal_matter_items(user_id, item_kind);

-- Reverse-direction lookup: "which matters is this vault item in?"
create index if not exists idx_paralegal_matter_items_ref_id
  on public.paralegal_matter_items(item_ref_id)
  where item_ref_id is not null;

alter table public.paralegal_matter_items enable row level security;

create policy "paralegal_matter_items_self_select" on public.paralegal_matter_items
  for select using (auth.uid() = user_id);

create policy "paralegal_matter_items_self_insert" on public.paralegal_matter_items
  for insert with check (auth.uid() = user_id);

create policy "paralegal_matter_items_self_delete" on public.paralegal_matter_items
  for delete using (auth.uid() = user_id);

-- (No update policy — matter-items are immutable attachments; to "edit" you
--  detach and re-attach with new metadata.)


-- ---------------------------------------------------------------------------
-- 3. paralegal_pending_actions
--
-- The voice-approval queue. Every outbound action the agent drafts (send
-- email, create calendar invite, share doc, open new matter) creates a row
-- here in 'pending' state. The user approves by voice ("approve") or
-- click; the right endpoint then fires the actual outbound (Phase 5).
-- ---------------------------------------------------------------------------
create table if not exists public.paralegal_pending_actions (
  id                  uuid primary key default gen_random_uuid(),
  matter_id           uuid references public.paralegal_matters(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,

  action_kind         text not null check (action_kind in (
                        'email_draft',
                        'calendar_hold',
                        'calendar_invite',
                        'doc_share',
                        'matter_open',
                        'redline_finalize',
                        'tabular_finalize_doc',
                        'vault_save'
                      )),
  payload             jsonb not null,                            -- everything the outbound endpoint needs (to, cc, subject, body, event start/end, etc.)
  voice_prompt        text,                                      -- what the agent should say to request approval

  status              text not null default 'pending' check (status in (
                        'pending',
                        'approved',
                        'edited',
                        'discarded',
                        'expired'
                      )),
  resolved_at         timestamptz,
  resolved_phrase     text,                                      -- the literal STT phrase that approved it
  resolved_confidence numeric(4,3),                              -- STT confidence (0.000–1.000)

  -- Where the agent's draft lives downstream once approved
  result_id           text,                                      -- e.g. Graph message_id after send
  result_at           timestamptz,
  error_message       text,

  created_at          timestamptz not null default now(),
  expires_at          timestamptz                                -- optional TTL (24h default in app code)
);

create index if not exists idx_paralegal_pending_actions_matter_status
  on public.paralegal_pending_actions(matter_id, status)
  where status = 'pending';

create index if not exists idx_paralegal_pending_actions_user_status
  on public.paralegal_pending_actions(user_id, status)
  where status = 'pending';

alter table public.paralegal_pending_actions enable row level security;

create policy "paralegal_pending_actions_self_select" on public.paralegal_pending_actions
  for select using (auth.uid() = user_id);

create policy "paralegal_pending_actions_self_insert" on public.paralegal_pending_actions
  for insert with check (auth.uid() = user_id);

create policy "paralegal_pending_actions_self_update" on public.paralegal_pending_actions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 4. paralegal_audit_log
--
-- Append-only record of every voice turn, tool call, and approval. Drives
-- the activity timeline on the matter detail page and the per-matter PDF
-- audit export (Phase 5).
-- ---------------------------------------------------------------------------
create table if not exists public.paralegal_audit_log (
  id          uuid primary key default gen_random_uuid(),
  matter_id   uuid references public.paralegal_matters(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,

  kind        text not null check (kind in (
                'voice_turn',
                'tool_call',
                'approval',
                'system'
              )),
  -- Payload shape varies by kind. Examples:
  --   voice_turn:  { speaker: 'user'|'agent', transcript: '...', audio_url?: '...', confidence?: 0.97 }
  --   tool_call:   { tool_name: 'search_vault', input: {...}, output: {...}, duration_ms: 412 }
  --   approval:    { action_id: <uuid>, decision: 'approve'|'edit'|'discard', phrase: 'approve', confidence: 0.97 }
  --   system:      { event: 'session_start'|'session_end'|'kill_switch_engaged', ... }
  payload     jsonb not null default '{}'::jsonb,

  occurred_at timestamptz not null default now()
);

-- Audit lookups always scoped by user (RLS) + ordered by time
create index if not exists idx_paralegal_audit_log_user_time
  on public.paralegal_audit_log(user_id, occurred_at desc);

create index if not exists idx_paralegal_audit_log_matter_time
  on public.paralegal_audit_log(matter_id, occurred_at desc)
  where matter_id is not null;

create index if not exists idx_paralegal_audit_log_kind
  on public.paralegal_audit_log(user_id, kind, occurred_at desc);

alter table public.paralegal_audit_log enable row level security;

create policy "paralegal_audit_log_self_select" on public.paralegal_audit_log
  for select using (auth.uid() = user_id);

create policy "paralegal_audit_log_self_insert" on public.paralegal_audit_log
  for insert with check (auth.uid() = user_id);

-- No update or delete from app code: audit is immutable. Service role can
-- purge old rows for retention-policy enforcement, but bypasses RLS anyway.
