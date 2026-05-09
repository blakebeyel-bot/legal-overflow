/**
 * POST /api/workspace-vault-add
 *   body: {
 *     source_kind: 'document' | 'chat' | 'review_finding' | 'manual_note',
 *     source_doc_id?: uuid,
 *     source_chat_id?: uuid,
 *     source_message_id?: uuid,
 *     source_review_id?: uuid,
 *     title: string,
 *     content: string,
 *     summary?: string,
 *     tags?: string[]
 *   }
 *
 * Adds an item to the user's vault. Chunks the content, embeds each
 * chunk under the user's chosen embedding provider, and inserts both
 * the header row and the chunk rows.
 *
 * Returns: { item, chunk_count }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { addVaultItem } from '../lib/vault.js';

const VALID_KINDS = new Set(['document', 'chat', 'review_finding', 'manual_note']);

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const sourceKind = String(body.source_kind || '');
  if (!VALID_KINDS.has(sourceKind)) {
    return json({ error: 'Invalid source_kind' }, 400);
  }
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!title) return json({ error: 'Missing title' }, 400);
  if (!content) return json({ error: 'Missing content' }, 400);

  const supabase = getSupabaseAdmin();

  try {
    const { item, chunks } = await addVaultItem({
      supabase,
      userId: auth.user.id,
      sourceKind,
      sourceIds: {
        docId:     body.source_doc_id     || null,
        chatId:    body.source_chat_id    || null,
        messageId: body.source_message_id || null,
        reviewId:  body.source_review_id  || null,
      },
      title,
      content,
      summary: body.summary || null,
      tags: Array.isArray(body.tags) ? body.tags : null,
    });
    return json({ item, chunk_count: chunks.length });
  } catch (err) {
    console.error('[vault-add] failed:', err);
    return json({ error: err.message || 'add failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
