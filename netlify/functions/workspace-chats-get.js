/**
 * GET /api/workspace-chats-get?id=<uuid>
 * Returns: { chat, messages: [...] }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: chat, error: chatErr } = await supabase
    .from('workspace_chats')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (chatErr) return json({ error: chatErr.message }, 500);
  if (!chat) return json({ error: 'Chat not found' }, 404);

  const { data: messages, error: msgErr } = await supabase
    .from('workspace_chat_messages')
    .select('*')
    .eq('chat_id', id)
    .order('created_at', { ascending: true });
  if (msgErr) return json({ error: msgErr.message }, 500);

  // Hydrate anchored vault items so the chat UI can render the
  // anchor chip strip without a second round-trip. Empty array
  // when the column is missing (migration 0033 not applied yet).
  let anchors = [];
  const anchoredIds = Array.isArray(chat.anchored_item_ids) ? chat.anchored_item_ids : [];
  if (anchoredIds.length > 0) {
    try {
      const { data: items } = await supabase
        .from('workspace_vault_items')
        .select('id, title, source_kind')
        .in('id', anchoredIds)
        .eq('user_id', auth.user.id);
      if (Array.isArray(items)) {
        const byId = new Map(items.map((it) => [it.id, it]));
        // Preserve anchor order from the chat row
        anchors = anchoredIds.map((aid) => byId.get(aid)).filter(Boolean);
      }
    } catch {
      // Schema-not-applied case — anchors stay []
    }
  }

  // Hydrate the bound workflow (if any). This lets the chat page
  // render a "Running workflow: <title>" chip + an intro card in
  // the empty state so the user knows the prompt pack is active
  // before they send a message.
  let workflow = null;
  if (chat.workflow_id) {
    try {
      const { data: wf } = await supabase
        .from('workspace_workflows')
        .select('id, title, description, kind, prompt_md, practice_area, is_prompt_pack')
        .eq('id', chat.workflow_id)
        .or(`user_id.eq.${auth.user.id},and(user_id.is.null,is_published.eq.true)`)
        .maybeSingle();
      if (wf) {
        workflow = {
          id: wf.id,
          title: wf.title,
          description: wf.description || '',
          kind: wf.kind,
          practice_area: wf.practice_area || null,
          // Send a short preview of the system prompt so the user
          // can see the gist without us shipping the full body.
          prompt_preview: typeof wf.prompt_md === 'string'
            ? wf.prompt_md.slice(0, 600)
            : '',
          prompt_chars: typeof wf.prompt_md === 'string' ? wf.prompt_md.length : 0,
          // Whether this workflow came from the homepage prompt-pack
          // catalog. The chat page uses this to apply the
          // teal "active workflow mode" tint to the chat container —
          // visible signal that a guided pack is running.
          is_prompt_pack: !!wf.is_prompt_pack,
        };
      }
    } catch {
      // Workflow row missing or inaccessible — chat still works,
      // just without the workflow metadata.
    }
  }

  // Hydrate the bound template (Phase 3 — "Use in chat" entry point).
  // The chat page renders a "Drafting from: <title>" chip so the user
  // knows the chat is in template-drafting mode.
  let template = null;
  if (chat.bound_template_id) {
    try {
      const { data: tmpl } = await supabase
        .from('workspace_vault_items')
        .select('id, title, template_schema')
        .eq('id', chat.bound_template_id)
        .or(`user_id.eq.${auth.user.id},user_id.is.null`)
        .maybeSingle();
      if (tmpl) {
        const vars = (tmpl.template_schema && Array.isArray(tmpl.template_schema.vars))
          ? tmpl.template_schema.vars
          : [];
        template = {
          id: tmpl.id,
          title: tmpl.title,
          vars_count: vars.length,
          vars: vars.map((v) => ({
            key: v.key,
            label: v.label,
            type: v.type,
          })),
        };
      }
    } catch {
      // Template missing or inaccessible — chat still works, just no chip.
    }
  }

  return json({ chat, messages: messages || [], anchors, workflow, template });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
