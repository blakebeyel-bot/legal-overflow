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

  return json({ chat, messages: messages || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
