/**
 * GET /api/workspace-vault-list?kind=&pinned=&archived=&q=&offset=0&limit=50
 *
 * Lists the user's vault items, paginated, filterable. Returns header
 * rows only (no chunk content) so the page is light to load.
 *
 * Query params:
 *   kind     — optional: filter to one source_kind
 *   pinned   — '1' to show only pinned
 *   archived — '1' to include archived; default omits them
 *   q        — case-insensitive substring match on title or summary
 *   offset, limit — pagination
 *
 * Returns: { items: [...], total: <count> }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID_KINDS = new Set(['document', 'chat', 'review_finding', 'manual_note']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const pinnedOnly = url.searchParams.get('pinned') === '1';
  const includeArchived = url.searchParams.get('archived') === '1';
  const q = (url.searchParams.get('q') || '').trim();
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10)));

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('workspace_vault_items')
    .select('id, source_kind, source_doc_id, source_chat_id, source_message_id, source_review_id, title, summary, tags, content_chars, embedding_provider, pinned, archived_at, created_at, updated_at', { count: 'exact' })
    .eq('user_id', auth.user.id);

  if (kind && VALID_KINDS.has(kind)) query = query.eq('source_kind', kind);
  if (pinnedOnly) query = query.eq('pinned', true);
  if (!includeArchived) query = query.is('archived_at', null);
  if (q) {
    // Postgres ilike on title OR summary; PostgREST supports `or` filter.
    // We STRIP the LIKE-pattern metacharacters (% _ \) instead of
    // escaping them — the previous escape relied on the backend
    // applying ESCAPE '\', which PostgREST doesn't reliably do, so a
    // user query containing `\\%` could re-introduce the wildcard.
    // Stripping is safe: a search for "50%" will look for "50" which
    // is what the user reasonably expected anyway. Also strip commas
    // and parens, which terminate / nest the PostgREST `or` filter.
    const safe = q.replace(/[%_\\,()]/g, '');
    if (safe) {
      query = query.or(`title.ilike.%${safe}%,summary.ilike.%${safe}%`);
    }
  }

  query = query
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) return json({ error: error.message }, 500);

  return json({ items: data || [], total: count ?? 0, offset, limit });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
