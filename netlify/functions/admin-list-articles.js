/**
 * GET /api/admin-list-articles
 *
 * Returns every article (drafts + published) in reverse-chronological
 * order. Admin only.
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('articles')
    .select('id, slug, title, dek, kind, track, status, featured, read_minutes, topic, cover, cover_image_url, date, updated_at, created_at')
    .order('date', { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json({ articles: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
