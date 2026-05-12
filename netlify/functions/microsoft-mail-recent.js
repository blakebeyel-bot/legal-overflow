/**
 * GET /api/microsoft-mail-recent
 *   ?matter_id=<uuid>    (optional — uses the matter's client +
 *                         counter_party as keywords; searches the
 *                         ENTIRE inbox, no date cap)
 *   ?search=<keyword>    (optional — direct keyword search, also
 *                         searches the entire inbox)
 *   ?from=<substring>    (optional — sender substring; treated as a
 *                         search keyword)
 *   ?days=<n>            (only used when no keyword is supplied;
 *                         default 30, max 365)
 *   ?top=<n>             (default 25, max 50)
 *
 * Returns: { messages: [{ id, subject, from, sentDateTime, receivedDateTime,
 *                          bodyPreview, hasAttachments, webLink, ... }] }
 *
 * Behavior:
 *   - When a matter_id is supplied, we build a search query from the
 *     matter's counter_party (primary) and client (fallback). Graph's
 *     $search runs across the full mailbox (subject, body, sender, etc.)
 *     — there's no date cap.
 *   - When no matter context exists, we fall back to "last N days
 *     in the inbox" so the timeline still has something useful to show.
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
  let search = url.searchParams.get('search') || undefined;
  let from = url.searchParams.get('from') || undefined;
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || 30)));
  const top = Math.min(50, Math.max(1, Number(url.searchParams.get('top') || 25)));

  // Matter-scoped search: build a keyword from the matter's
  // counter_party (priority) or client name. This searches the full
  // inbox via Graph's $search — not limited to the last N days.
  if (matterId && !search && !from) {
    const supabase = getSupabaseAdmin();
    const { data: matter } = await supabase
      .from('paralegal_matters')
      .select('counter_party, client')
      .eq('id', matterId)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    search = matter?.counter_party || matter?.client || undefined;
  }

  try {
    const messages = await listRecentMail(auth.user.id, { search, from, days, top });
    return json({ messages, mode: (search || from) ? 'keyword_search' : 'recent_window', keyword: search || from || null });
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
