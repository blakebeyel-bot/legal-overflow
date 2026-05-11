/**
 * POST /api/paralegal-matters-create
 *   body: {
 *     client: string (required),
 *     counter_party?: string,
 *     matter_type?: string,
 *     posture?: string,
 *     stage?: 'intake'|'conflict'|'quick_scan'|'redline'|'sign'|'watch',
 *     status?: 'active'|'watching'|'closed',
 *     response_due?: ISO timestamp,
 *     due_date?: ISO timestamp,
 *     playbook_vault_item_id?: uuid,
 *     notes?: string
 *   }
 * Returns: { matter: { id, ...all fields } }
 *
 * Creates a new paralegal matter for the authenticated user. The "client"
 * field is the only one we require — everything else can be filled in
 * later from the matter detail page or via voice.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID_STAGES = new Set(['intake', 'conflict', 'quick_scan', 'redline', 'sign', 'watch']);
const VALID_STATUSES = new Set(['active', 'watching', 'closed']);

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const {
    client,
    counter_party,
    matter_type,
    posture,
    stage,
    status,
    response_due,
    due_date,
    playbook_vault_item_id,
    notes,
  } = body || {};

  if (!client || typeof client !== 'string' || !client.trim()) {
    return json({ error: 'client is required' }, 400);
  }
  if (stage && !VALID_STAGES.has(stage)) return json({ error: `Invalid stage: ${stage}` }, 400);
  if (status && !VALID_STATUSES.has(status)) return json({ error: `Invalid status: ${status}` }, 400);

  const supabase = getSupabaseAdmin();
  const row = {
    user_id: auth.user.id,
    client: client.trim().slice(0, 240),
    counter_party: counter_party ? String(counter_party).trim().slice(0, 240) : null,
    matter_type: matter_type ? String(matter_type).trim().slice(0, 120) : null,
    posture: posture ? String(posture).trim().slice(0, 120) : null,
    stage: stage || 'intake',
    status: status || 'active',
    response_due: response_due || null,
    due_date: due_date || null,
    playbook_vault_item_id: playbook_vault_item_id || null,
    notes: notes ? String(notes).slice(0, 4000) : null,
  };

  const { data: matter, error } = await supabase
    .from('paralegal_matters')
    .insert(row)
    .select('*')
    .single();
  if (error) return json({ error: error.message }, 500);

  // Audit: opening a matter is a system event worth recording.
  await supabase.from('paralegal_audit_log').insert({
    user_id: auth.user.id,
    matter_id: matter.id,
    kind: 'system',
    payload: { event: 'matter_opened', client: row.client, counter_party: row.counter_party },
  });

  return json({ matter });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
