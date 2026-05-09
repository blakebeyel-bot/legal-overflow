/**
 * POST /api/workspace-vault-search
 *   body: { query: string, top_k?: number, kinds?: string[] }
 *
 * Semantic search over the user's vault. Embeds the query under the
 * user's chosen provider and returns the top-K matching chunks with
 * their parent item metadata + a similarity score.
 *
 * Returns: { results: [{ chunk, item, score }] }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { searchVault } from '../lib/vault.js';

const VALID_KINDS = new Set(['document', 'chat', 'review_finding', 'manual_note']);
const MAX_TOP_K = 25;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const query = String(body.query || '').trim();
  if (!query) return json({ error: 'Missing query' }, 400);
  const topK = Math.min(MAX_TOP_K, Math.max(1, Number(body.top_k) || 6));
  const kinds = Array.isArray(body.kinds)
    ? body.kinds.filter((k) => VALID_KINDS.has(k))
    : null;

  const supabase = getSupabaseAdmin();
  try {
    const results = await searchVault({
      supabase,
      userId: auth.user.id,
      query,
      topK,
      kinds: kinds && kinds.length ? kinds : null,
    });
    return json({ results });
  } catch (err) {
    console.error('[vault-search] failed:', err);
    return json({ error: err.message || 'search failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
