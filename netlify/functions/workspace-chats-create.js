/**
 * POST /api/workspace-chats-create
 *   body: { project_id?: uuid, model?: string, workflow_id?: uuid, template_id?: uuid }
 * Returns: { id, primed?: boolean }
 *
 * If the new chat is bound to a workflow flagged as a prompt pack
 * (is_prompt_pack=true on workspace_workflows), we synchronously
 * generate an opening assistant message that walks the user through
 * the pack via guided interview. The user lands on the chat with
 * the model already engaged — no awkward "type to start" moment.
 *
 * Priming adds ~2s to chat creation but only when running a prompt
 * pack. User-created workflows and plain new chats are unchanged.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { primeChat } from '../lib/chat-prime.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const supabase = getSupabaseAdmin();

  // Resolve template_id if provided — must be a template vault item
  // the user owns or a published system template (user_id IS NULL).
  let templateId = null;
  if (body.template_id) {
    const { data: tmpl } = await supabase
      .from('workspace_vault_items')
      .select('id, user_id, source_kind')
      .eq('id', body.template_id)
      .or(`user_id.eq.${auth.user.id},user_id.is.null`)
      .maybeSingle();
    if (tmpl && tmpl.source_kind === 'template') {
      templateId = tmpl.id;
    }
  }

  const insertRow = {
    user_id: auth.user.id,
    project_id: body.project_id || null,
    workflow_id: body.workflow_id || null,
    model: body.model || 'claude-sonnet-4-5',
  };
  if (templateId) insertRow.bound_template_id = templateId;

  const { data, error } = await supabase
    .from('workspace_chats')
    .insert(insertRow)
    .select('id')
    .single();
  if (error) return json({ error: error.message }, 500);

  // Auto-prime when the chat is bound to a prompt-pack workflow.
  // primeChat() is internally guarded — returns null if the workflow
  // isn't flagged is_prompt_pack, if the chat already has messages,
  // or if any step fails. So this is safe to call unconditionally
  // when workflow_id is set; user-created workflows just no-op.
  let primed = false;
  if (body.workflow_id) {
    const msg = await primeChat({
      supabase,
      userId: auth.user.id,
      chatId: data.id,
      workflowId: body.workflow_id,
    });
    primed = !!msg;
  }

  return json({ id: data.id, primed });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
