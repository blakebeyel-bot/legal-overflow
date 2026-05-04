/**
 * GET /api/workspace-redline-status?id=<run_id>
 * Returns: { run, version? }
 *
 * version is included when status='complete' so the client can build
 * a download URL from the storage_path.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: run, error } = await supabase
    .from('workspace_redline_runs')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!run) return json({ error: 'Run not found' }, 404);

  let version = null;
  if (run.result_version_id) {
    const { data } = await supabase
      .from('workspace_document_versions')
      .select('id, version_number, storage_path, display_name, created_at')
      .eq('id', run.result_version_id)
      .maybeSingle();
    version = data;
  }

  return json({ run, version });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
