/**
 * GET /api/microsoft-calendar-list
 *   ?days_ahead=<n>     (default 5)
 *   ?days_back=<n>      (default 0)
 *   ?matter_id=<uuid>   (optional — reserved for future filtering)
 *
 * Returns: { events: [{ id, subject, start, end, location, attendees, organizer, webLink, isAllDay, bodyPreview }] }
 */
import { requireUser, checkUserApproval } from '../lib/supabase-admin.js';
import { listCalendarEvents } from '../lib/microsoft-graph.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const daysAhead = Math.max(1, Number(url.searchParams.get('days_ahead') || 5));
  const daysBack = Math.max(0, Number(url.searchParams.get('days_back') || 0));
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

  try {
    const events = await listCalendarEvents(auth.user.id, { start, end });
    return json({ events });
  } catch (err) {
    if (/not connected/i.test(err.message || '')) {
      return json({ error: err.message, not_connected: true }, 412);
    }
    console.warn('[microsoft-calendar-list]', err.message);
    return json({ error: err.message || 'Calendar fetch failed' }, 502);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
