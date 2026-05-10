-- ============================================================
-- 0034_workflow_prompt_pack_flag.sql
--
-- Marks workflows that came from the homepage prompt-pack catalog
-- (the static .md files in /assets/skills/). When a user clicks
-- "Save to my workflows" or "Run in chat" on a homepage skill card,
-- the imported workflow is flagged is_prompt_pack=true. Chats bound
-- to such workflows trigger an auto-primed opening assistant
-- message — the model speaks first with an introduction and the
-- first guided question, walking the user toward the final
-- deliverable defined in the pack.
--
-- User-created workflows (kind='chat' from /workspace/workflows)
-- stay silent — same behavior as before.
-- ============================================================

alter table public.workspace_workflows
  add column if not exists is_prompt_pack boolean not null default false;

comment on column public.workspace_workflows.is_prompt_pack is
  'True when this workflow was imported from the homepage prompt-pack catalog. Chats bound to such workflows auto-prime the first assistant message so the model walks the user through the pack via a guided interview rather than waiting passively for the user to type.';

create index if not exists workspace_workflows_prompt_pack_idx
  on public.workspace_workflows(is_prompt_pack)
  where is_prompt_pack = true;
