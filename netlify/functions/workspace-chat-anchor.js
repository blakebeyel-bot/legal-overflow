/**
 * POST /api/workspace-chat-anchor
 *   body: { chat_id: string, item_id: string, anchored: boolean }
 *
 * Toggles the pinned state of a vault item on a chat. Anchored items
 * are guaranteed to contribute chunks + images to every subsequent
 * turn's system prompt, regardless of semantic match against the
 * user's query.
 *
 * Cap at 5 anchors per chat — beyond that the prompt gets bloated and
 * non-anchored vault items have no room to surface. Server-enforced
 * to defend against bulk-anchor abuse from the UI.
 *
 * Returns: { anchored_item_ids: uuid[], anchors: [{id, title}] }
 *   `anchors` hydrates the ids with vault item titles so the chat
 *   page can render the chip strip without a second round-trip.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const MAX_ANCHORS_PER_CHAT = 5;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const chatId = body.chat_id;
  const itemId = body.item_id;
  const want = body.anchored !== false;
  if (!chatId || !itemId) return json({ error: 'Missing chat_id or item_id' }, 400);

  const supabase = getSupabaseAdmin();

  // 1. Verify chat ownership AND item ownership in parallel.
  const [chatRes, itemRes] = await Promise.all([
    supabase
      .from('workspace_chats')
      .select('id, user_id, anchored_item_ids')
      .eq('id', chatId)
      .eq('user_id', auth.user.id)
      .maybeSingle(),
    supabase
      .from('workspace_vault_items')
      .select('id, user_id')
      .eq('id', itemId)
      .eq('user_id', auth.user.id)
      .maybeSingle(),
  ]);
  if (!chatRes.data) return json({ error: 'Chat not found' }, 404);
  if (!itemRes.data) return json({ error: 'Vault item not found' }, 404);

  // 2. Mutate the anchor list. uuid[] columns are easiest to update
  //    via a normal UPDATE rather than the array-append PostgREST
  //    helpers (those don't enforce uniqueness).
  const current = Array.isArray(chatRes.data.anchored_item_ids)
    ? chatRes.data.anchored_item_ids
    : [];
  let next;
  if (want) {
    if (current.includes(itemId)) {
      next = current;
    } else {
      next = [...current, itemId];
      if (next.length > MAX_ANCHORS_PER_CHAT) {
        return json({
          error: `Max ${MAX_ANCHORS_PER_CHAT} anchored docs per chat. Unanchor one before adding another.`,
        }, 400);
      }
    }
  } else {
    next = current.filter((id) => id !== itemId);
  }

  if (next.length !== current.length || (want && !current.includes(itemId))) {
    const { error: upErr } = await supabase
      .from('workspace_chats')
      .update({ anchored_item_ids: next })
      .eq('id', chatId);
    if (upErr) return json({ error: upErr.message }, 500);
  }

  // 3. Hydrate ids with titles for the UI chip strip.
  let anchors = [];
  if (next.length > 0) {
    const { data: items } = await supabase
      .from('workspace_vault_items')
      .select('id, title, source_kind')
      .in('id', next);
    if (Array.isArray(items)) {
      // Preserve the order of `next` (chronological by anchor click)
      // so the chip strip renders newest-anchor-on-the-right.
      const byId = new Map(items.map((it) => [it.id, it]));
      anchors = next.map((id) => byId.get(id)).filter(Boolean);
    }
  }

  return json({ anchored_item_ids: next, anchors });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
