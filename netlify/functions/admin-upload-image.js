/**
 * POST /api/admin-upload-image
 *
 * Multipart form upload. Saves the image into the article-images
 * Supabase storage bucket and returns the public URL.
 *
 * Form fields:
 *   file  — the image (jpg, png, webp, gif)
 *   slug? — optional article slug to namespace the file path
 *
 * Response:
 *   { ok: true, url: "https://.../article-images/<slug>/<filename>" }
 *
 * Admin only. The bucket is publicly readable so the URL can be embedded
 * directly in markdown body.
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { MAX_UPLOAD_BYTES } from '../lib/constants.js';

const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg']);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let formData;
  try { formData = await req.formData(); } catch { return json({ error: 'Expected multipart/form-data' }, 400); }
  const file = formData.get('file');
  const slug = String(formData.get('slug') || 'misc').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'misc';
  if (!file || typeof file === 'string') return json({ error: 'file required' }, 400);
  if (file.size > 10 * 1024 * 1024) return json({ error: 'image exceeds 10 MB' }, 413);

  const filename = file.name || 'image';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return json({ error: `Unsupported format: .${ext}. Allowed: ${[...ALLOWED_EXT].join(', ')}` }, 400);
  }

  const ts = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
  const storagePath = `${slug}/${ts}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const supabase = getSupabaseAdmin();
  const { error: upErr } = await supabase.storage
    .from('article-images')
    .upload(storagePath, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
      cacheControl: '31536000',
    });
  if (upErr) return json({ error: upErr.message }, 500);

  const { data: pub } = supabase.storage.from('article-images').getPublicUrl(storagePath);
  return json({ ok: true, url: pub.publicUrl, path: storagePath });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
