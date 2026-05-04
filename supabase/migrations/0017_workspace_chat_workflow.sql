-- Round 17 — workflows attached to chats.
--
-- A chat can be associated with a workflow whose prompt_md becomes the
-- system prompt for that chat. The user picks a workflow from the
-- chat header (or from the workflows page via "Use in chat") and it
-- sticks for the whole conversation. Null = use the default
-- conversational legal-research prompt.

alter table public.workspace_chats
  add column if not exists workflow_id uuid
  references public.workspace_workflows(id) on delete set null;

create index if not exists idx_workspace_chats_workflow
  on public.workspace_chats (workflow_id);
