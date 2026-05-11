/**
 * POST /api/paralegal-matters-update
 *   body: { id: uuid, ...patch fields }
 *
 * Patch any subset of:
 *   client, counter_party, matter_type, posture, stage, status,
 *   response_due, due_date, conflict_cleared_at, playbook_vault_item_id,
 *   hours_billed, voice_enabled, notes
 *
 * Returns: { matter }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID_STAGES = new Set(['intake', 'conflict', 'quick_scan', 'redline', 'sign', 'watch']);
const VALID_STATUSES = new Set(['active', 'watching', 'closed']);

const ALLOWED_FIELDS = new Set([
  'client', 'counter_party', 'matter_type', 'posture', 'stage', 'status',
  'response_due', 'due_date', 'conflict_cleared_at', 'playbook_vault_item_id',
  'hours_billed', 'voice_enabled', 'notes',
]);

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { id, ...patch } = body || {};
  if (!id) return json({ error: 'id is required' }, 400);

  if (patch.stage && !VALID_STAGES.has(patch.stage)) {
    return json({ error: `Invalid stage: ${patch.stage}` }, 400);
  }
  if (patch.status && !VALID_STATUSES.has(patch.status)) {
    return json({ error: `Invalid status: ${patch.status}` }, 400);
  }

  // Whitelist + light coercion.
  const update = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (typeof v === 'string') update[k] = v.slice(0, 4000);
    else update[k] = v;
  }
  if (Object.keys(update).length === 0) {
    return json({ error: 'No update fields provided' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const { data: matter, error } = await supabase
    .from('paralegal_matters')
    .update(update)
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .select('*')
    .single();
  if (error) return json({ error: error.message }, 500);
  if (!matter) return json({ error: 'matter not found' }, 404);

  return json({ matter });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
