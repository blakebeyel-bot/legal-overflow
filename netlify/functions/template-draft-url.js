/**
 * GET /api/template-draft-url?id=<draft_vault_item_id>
 *
 * Mint a fresh signed URL for downloading a draft .docx. The chat
 * bubble cached signed URL from template-render expires after 1
 * hour; if the user comes back to the chat later they need a new
 * one to keep the download chip functional.
 *
 * Returns: { download_url, draft_title }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const SIGNED_URL_TTL_SECONDS = 60 * 60;

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: row, error } = await supabase
    .from('workspace_vault_items')
    .select('id, user_id, source_kind, title, rendered_storage_path')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!row) return json({ error: 'Not found' }, 404);
  if (row.source_kind !== 'draft' || !row.rendered_storage_path) {
    return json({ error: 'Not a rendered draft' }, 400);
  }

  const { data: signed, error: sigErr } = await supabase.storage
    .from('library')
    .createSignedUrl(row.rendered_storage_path, SIGNED_URL_TTL_SECONDS, {
      download: `${(row.title || 'draft').replace(/[^A-Za-z0-9 _.-]/g, '_')}.docx`,
    });
  if (sigErr) return json({ error: sigErr.message }, 500);

  return json({
    download_url: signed?.signedUrl || null,
    draft_title: row.title,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
