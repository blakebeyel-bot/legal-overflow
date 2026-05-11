/**
 * POST /api/paralegal-matter-attach-counts
 *   body: { item_kind: string, item_ref_ids: [uuid] }
 *
 * Returns: {
 *   counts: { <ref_id>: { count: number, matters: [{ id, client, counter_party }] } }
 * }
 *
 * Batched lookup so the vault / library list pages can render "▸ N matters"
 * badges across all visible items in a single round-trip. Each item's
 * "matters" array contains up to 3 matter previews for the hover tooltip.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID_KINDS = new Set([
  'vault_item', 'library_document', 'chat', 'email_thread',
  'calendar_event', 'redline_run', 'compare_run', 'tr_review',
  'citation_run', 'manual_note',
]);

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { item_kind, item_ref_ids } = body || {};

  if (!VALID_KINDS.has(item_kind)) return json({ error: `Invalid item_kind: ${item_kind}` }, 400);
  if (!Array.isArray(item_ref_ids) || item_ref_ids.length === 0) {
    return json({ counts: {} });
  }
  // Cap input size to prevent abuse
  const ids = item_ref_ids.filter((x) => typeof x === 'string').slice(0, 200);

  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('paralegal_matter_items')
    .select('item_ref_id, matter_id, paralegal_matters!inner(id, client, counter_party)')
    .eq('item_kind', item_kind)
    .eq('user_id', auth.user.id)
    .in('item_ref_id', ids);
  if (error) return json({ error: error.message }, 500);

  const counts = {};
  for (const id of ids) counts[id] = { count: 0, matters: [] };

  for (const r of rows || []) {
    const ref = r.item_ref_id;
    if (!counts[ref]) continue;
    counts[ref].count++;
    if (counts[ref].matters.length < 3 && r.paralegal_matters) {
      counts[ref].matters.push({
        id: r.paralegal_matters.id,
        client: r.paralegal_matters.client,
        counter_party: r.paralegal_matters.counter_party,
      });
    }
  }

  return json({ counts });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
