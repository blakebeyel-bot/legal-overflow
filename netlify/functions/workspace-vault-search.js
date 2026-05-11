/**
 * POST /api/workspace-vault-search
 *   body: {
 *     query: string,
 *     top_k?: number,
 *     kinds?: string[],
 *     mode?: 'semantic' | 'keyword' | 'hybrid'   (default 'hybrid')
 *   }
 *
 * Search over the user's vault. Three modes:
 *
 *   'semantic' — embed the query, vector search via pgvector RPC.
 *                Finds documents by MEANING (paraphrases, synonyms).
 *
 *   'keyword'  — literal ilike substring match against
 *                workspace_vault_chunks.content. Finds EXACT phrases
 *                in contract text. No embedding required.
 *
 *   'hybrid'   — run both, merge by item with semantic results first,
 *                keyword fillers second. Default. Best general-purpose
 *                mode for the vault search bar.
 *
 * Returns: { results: [{ chunk, item, score, match_type }] }
 *   match_type ∈ 'semantic' | 'keyword' (only set on hybrid + keyword)
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { searchVault, keywordSearchVault } from '../lib/vault.js';

const VALID_KINDS = new Set(['document', 'chat', 'review_finding', 'manual_note']);
const VALID_MODES = new Set(['semantic', 'keyword', 'hybrid']);
const MAX_TOP_K = 50;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const query = String(body.query || '').trim();
  if (!query) return json({ error: 'Missing query' }, 400);
  const topK = Math.min(MAX_TOP_K, Math.max(1, Number(body.top_k) || 30));
  const kinds = Array.isArray(body.kinds)
    ? body.kinds.filter((k) => VALID_KINDS.has(k))
    : null;
  const mode = VALID_MODES.has(String(body.mode)) ? String(body.mode) : 'hybrid';
  // Optional matter scoping: when supplied, results pinned to that matter
  // get a 1.3× score boost so the paralegal agent surfaces in-file
  // documents ahead of generic vault hits.
  const matterId = typeof body.matter_id === 'string' && body.matter_id ? body.matter_id : null;

  const supabase = getSupabaseAdmin();
  try {
    const filterKinds = kinds && kinds.length ? kinds : null;

    // Pre-fetch the set of vault item IDs attached to the given matter
    // (if any). The actual boost is applied below after retrieval.
    let matterItemIds = null;
    if (matterId) {
      const { data: mItems } = await supabase
        .from('paralegal_matter_items')
        .select('item_ref_id')
        .eq('user_id', auth.user.id)
        .eq('matter_id', matterId)
        .eq('item_kind', 'vault_item');
      matterItemIds = new Set((mItems || []).map((r) => r.item_ref_id).filter(Boolean));
    }

    function applyMatterBoost(results) {
      if (!matterItemIds || matterItemIds.size === 0) return results;
      return results.map((r) => {
        if (r.item && matterItemIds.has(r.item.id)) {
          return { ...r, score: (r.score ?? 0) * 1.3, in_matter: true };
        }
        return r;
      }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    if (mode === 'keyword') {
      const results = await keywordSearchVault({
        supabase, userId: auth.user.id, query, topK, kinds: filterKinds,
      });
      return json({ results: applyMatterBoost(results), mode });
    }

    if (mode === 'semantic') {
      const results = await searchVault({
        supabase, userId: auth.user.id, query, topK, kinds: filterKinds,
      });
      const tagged = results.map((r) => ({ ...r, match_type: 'semantic' }));
      return json({ results: applyMatterBoost(tagged), mode });
    }

    // mode === 'hybrid' — run both in parallel and merge.
    // Semantic results lead (better signal for paraphrase queries),
    // keyword results fill in any items semantic missed (better for
    // the user's "find this exact phrase in my contracts" use case).
    // Cap to topK total.
    const [semantic, keyword] = await Promise.all([
      searchVault({ supabase, userId: auth.user.id, query, topK, kinds: filterKinds }),
      keywordSearchVault({ supabase, userId: auth.user.id, query, topK, kinds: filterKinds }),
    ]);

    const seen = new Set();
    const merged = [];
    for (const r of semantic) {
      if (!r.item || seen.has(r.item.id)) continue;
      seen.add(r.item.id);
      merged.push({ ...r, match_type: 'semantic' });
    }
    for (const r of keyword) {
      if (!r.item || seen.has(r.item.id)) continue;
      seen.add(r.item.id);
      merged.push({ ...r, match_type: 'keyword' });
    }
    return json({ results: applyMatterBoost(merged).slice(0, topK), mode });
  } catch (err) {
    console.error('[vault-search] failed:', err);
    return json({ error: 'Search failed — please try again' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
