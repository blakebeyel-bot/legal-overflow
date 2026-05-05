/**
 * GET /.netlify/functions/workspace-chat-message-get?id=<message_id>
 *
 * Returns one chat message + its verification jsonb. Used by the
 * chat page to poll for verification results after the assistant
 * message finishes streaming.
 *
 * Auth: requires the message's chat to belong to the requesting
 * user (defense-in-depth — RLS would block this anyway, but the
 * service-role client bypasses RLS).
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: msg, error } = await supabase
    .from('workspace_chat_messages')
    .select('id, chat_id, role, content, verification, status, privacy_applied, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!msg) return json({ error: 'Not found' }, 404);

  // Confirm ownership via the chat row
  const { data: chat } = await supabase
    .from('workspace_chats')
    .select('id, user_id')
    .eq('id', msg.chat_id)
    .maybeSingle();
  if (!chat || chat.user_id !== auth.user.id) {
    return json({ error: 'Not found' }, 404);
  }

  return json({ message: msg });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
