/**
 * GET /api/microsoft-mail-get?id=<message_id>
 *
 * Returns the full message body + attachment metadata.
 *
 * Response: {
 *   message: { id, subject, from, toRecipients, ccRecipients, body, ... },
 *   attachments: [{ id, name, contentType, size, isInline }]
 * }
 */
import { requireUser, checkUserApproval } from '../lib/supabase-admin.js';
import { getMessage } from '../lib/microsoft-graph.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id is required' }, 400);

  try {
    const result = await getMessage(auth.user.id, id);
    return json(result);
  } catch (err) {
    if (/not connected/i.test(err.message || '')) {
      return json({ error: err.message, not_connected: true }, 412);
    }
    console.warn('[microsoft-mail-get]', err.message);
    return json({ error: err.message || 'Message fetch failed' }, 502);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
