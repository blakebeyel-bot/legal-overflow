/**
 * POST /api/save-profile
 *
 * Upserts the authenticated user's company_profiles row. Used by both the
 * chat configurator (incremental updates during onboarding) and the
 * playbook-ingestor flow (bulk set).
 *
 * Body (JSON):
 *   { profile_json: object }
 *
 * Validates loosely — the workflow-configurator agent is responsible for
 * producing a schema-conformant profile. We just ensure it's a non-empty
 * object before storing it.
 *
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { profile_json } = body;
  if (!profile_json || typeof profile_json !== 'object' || Array.isArray(profile_json)) {
    return json({ error: 'profile_json must be a non-empty object' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('company_profiles')
    .upsert(
      { user_id: auth.user.id, profile_json },
      { onConflict: 'user_id' }
    )
    .select('id, updated_at')
    .single();

  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, profile_id: data.id, updated_at: data.updated_at });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
