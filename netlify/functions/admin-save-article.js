/**
 * POST /api/admin-save-article
 *
 * Create or update an article. Body:
 *   { id?, slug, title, dek, kind, track, read_minutes, topic, cover,
 *     cover_image_url?, featured, status, body_md, date, trigger_rebuild? }
 *
 * If id is supplied, the row is UPDATED. Otherwise INSERTed (slug must
 * be unique).
 *
 * If trigger_rebuild is true AND status = 'published', the Netlify
 * Build Hook (NETLIFY_BUILD_HOOK env var) is fired so the public site
 * regenerates immediately.
 *
 * Admin only.
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';

const VALID_TRACKS = new Set(['legal', 'business', 'both']);
const VALID_STATUS = new Set(['draft', 'published']);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const id = body.id;
  const trigger = !!body.trigger_rebuild;
  const row = sanitizeArticle(body);
  if (!row.slug) return json({ error: 'slug required' }, 400);
  if (!row.title) return json({ error: 'title required' }, 400);
  if (!VALID_TRACKS.has(row.track)) return json({ error: 'invalid track' }, 400);
  if (!VALID_STATUS.has(row.status)) return json({ error: 'invalid status' }, 400);

  const supabase = getSupabaseAdmin();
  let saved;
  if (id) {
    const { data, error } = await supabase
      .from('articles').update(row).eq('id', id).select('*').single();
    if (error) return json({ error: error.message }, 500);
    saved = data;
  } else {
    const { data, error } = await supabase
      .from('articles').insert(row).select('*').single();
    if (error) return json({ error: error.message }, 500);
    saved = data;
  }

  // Optional rebuild trigger — only fires for published articles AND when
  // a build hook is configured. The hook URL goes in Netlify env vars
  // (Site → Settings → Build & deploy → Build hooks → New build hook).
  let rebuildTriggered = false;
  if (trigger && saved.status === 'published' && process.env.NETLIFY_BUILD_HOOK) {
    try {
      const hookResp = await fetch(process.env.NETLIFY_BUILD_HOOK, { method: 'POST' });
      rebuildTriggered = hookResp.ok;
    } catch (err) {
      console.error('build-hook trigger failed:', err.message);
    }
  }

  return json({ ok: true, article: saved, rebuild_triggered: rebuildTriggered });
};

function sanitizeArticle(b) {
  return {
    slug: typeof b.slug === 'string' ? b.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : '',
    title: typeof b.title === 'string' ? b.title.trim().slice(0, 240) : '',
    dek: typeof b.dek === 'string' ? b.dek.slice(0, 600) : '',
    kind: typeof b.kind === 'string' && b.kind ? b.kind.trim().slice(0, 60) : 'Essay',
    track: typeof b.track === 'string' ? b.track : 'legal',
    read_minutes: Number.isFinite(+b.read_minutes) ? Math.max(1, Math.min(60, +b.read_minutes)) : 5,
    topic: typeof b.topic === 'string' && b.topic ? b.topic.trim().slice(0, 60) : 'General',
    cover: typeof b.cover === 'string' && /^ph-[a-m]$/.test(b.cover) ? b.cover : 'ph-b',
    cover_image_url: typeof b.cover_image_url === 'string' && b.cover_image_url.trim() ? b.cover_image_url.trim().slice(0, 600) : null,
    featured: !!b.featured,
    status: typeof b.status === 'string' ? b.status : 'draft',
    body_md: typeof b.body_md === 'string' ? b.body_md : '',
    date: typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : new Date().toISOString().slice(0, 10),
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
