/**
 * GET /api/workspace-projects-list
 *   ?archived=1   include archived
 * Returns: { projects: [{ id, name, description, ...counts }] }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('workspace_projects')
    .select('*')
    .eq('user_id', auth.user.id)
    .order('updated_at', { ascending: false });
  if (!includeArchived) q = q.is('archived_at', null);
  const { data: projects, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // Pull simple counts of contained items per project (chats / docs / reviews).
  // Done in a single trip via in() rather than per-project subqueries.
  const ids = (projects || []).map((p) => p.id);
  const counts = {};
  if (ids.length) {
    const [{ data: chats }, { data: docs }, { data: reviews }] = await Promise.all([
      supabase.from('workspace_chats').select('project_id', { count: 'exact' }).in('project_id', ids),
      supabase.from('workspace_documents').select('project_id', { count: 'exact' }).in('project_id', ids).is('deleted_at', null),
      supabase.from('workspace_tabular_reviews').select('project_id', { count: 'exact' }).in('project_id', ids),
    ]);
    for (const id of ids) counts[id] = { chats: 0, documents: 0, reviews: 0 };
    for (const c of chats || []) if (counts[c.project_id]) counts[c.project_id].chats++;
    for (const d of docs || []) if (counts[d.project_id]) counts[d.project_id].documents++;
    for (const r of reviews || []) if (counts[r.project_id]) counts[r.project_id].reviews++;
  }
  const enriched = (projects || []).map((p) => ({ ...p, counts: counts[p.id] || { chats: 0, documents: 0, reviews: 0 } }));
  return json({ projects: enriched });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
