/**
 * GET /api/microsoft-mail-recent
 *   ?matter_id=<uuid>    (optional — narrows results by the matter's
 *                         counter_party name as a sender filter)
 *   ?from=<substring>    (optional — direct sender filter)
 *   ?days=<n>            (default 2)
 *   ?top=<n>             (default 25, max 50)
 *
 * Returns: { messages: [{ id, subject, from, sentDateTime, receivedDateTime,
 *                          bodyPreview, hasAttachments, webLink, ... }] }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { listRecentMail } from '../lib/microsoft-graph.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const matterId = url.searchParams.get('matter_id');
  let from = url.searchParams.get('from') || undefined;
  const days = Number(url.searchParams.get('days') || 2);
  const top = Math.min(50, Math.max(1, Number(url.searchParams.get('top') || 25)));

  // If matter_id supplied and no explicit `from`, use the matter's
  // counter_party as a best-effort sender filter.
  if (matterId && !from) {
    const supabase = getSupabaseAdmin();
    const { data: matter } = await supabase
      .from('paralegal_matters')
      .select('counter_party')
      .eq('id', matterId)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (matter?.counter_party) from = matter.counter_party;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const messages = await listRecentMail(auth.user.id, { from, since, top });
    return json({ messages });
  } catch (err) {
    if (/not connected/i.test(err.message || '')) {
      return json({ error: err.message, not_connected: true }, 412);
    }
    console.warn('[microsoft-mail-recent]', err.message);
    return json({ error: err.message || 'Mail fetch failed' }, 502);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
