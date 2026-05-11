/**
 * POST /api/workspace-chat-cancel
 *   body: { chat_id: string, content: string }
 *
 * Called by the chat page when the user clicks the stop button mid-
 * stream. Updates the most recent in-flight assistant message for
 * this chat with whatever partial content the client received and
 * marks it as cancelled so a reload shows the same partial + stop
 * marker.
 *
 * Note: the edge-function may continue to run on the server side
 * after the client aborts (the model keeps generating until it
 * finishes or hits its own timeout). That's fine — when the edge
 * function eventually finalizes the row, it'll see status='cancelled'
 * via the unique row id and the update should be a no-op overwrite
 * because we use a different status. To be safe we set status BEFORE
 * the content so the edge function's `status: 'complete'` write
 * would still flip it back if it races us. The window is tiny and
 * the visible effect on the user side is just that reload may show
 * the full completed response instead of the partial. Acceptable.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const chatId = body.chat_id;
  const partial = typeof body.content === 'string' ? body.content.slice(0, 200000) : '';
  if (!chatId) return json({ error: 'Missing chat_id' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify chat ownership before mutating any message rows.
  const { data: chat } = await supabase
    .from('workspace_chats')
    .select('id, user_id')
    .eq('id', chatId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!chat) return json({ error: 'Chat not found' }, 404);

  // Find the most recent assistant message for this chat that's
  // still streaming. There should only ever be one — the
  // edge-function inserts a 'streaming' row at the top of each
  // turn and flips it to 'complete' or 'error' at the end.
  const { data: row } = await supabase
    .from('workspace_chat_messages')
    .select('id, content, status')
    .eq('chat_id', chatId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return json({ ok: true, updated: false });

  // Only flip rows that haven't already been finalized. If the
  // server-side stream completed before our cancel landed, leave
  // the completed content in place — the user got the full
  // response despite clicking stop.
  if (row.status === 'complete' || row.status === 'cancelled') {
    return json({ ok: true, updated: false });
  }

  // Prefer the longer of (client partial, whatever the server may
  // have already persisted into the row) so we never lose chars.
  const serverContent = typeof row.content === 'string' ? row.content : '';
  const finalContent = partial.length > serverContent.length ? partial : serverContent;

  const { error: upErr } = await supabase
    .from('workspace_chat_messages')
    .update({ status: 'cancelled', content: finalContent })
    .eq('id', row.id);
  if (upErr) return json({ error: upErr.message }, 500);

  return json({ ok: true, updated: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
