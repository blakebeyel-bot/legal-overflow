/**
 * POST /.netlify/functions/workspace-chat-verify-background
 *   body: { message_id, law_settings }
 *   header: X-Internal-Trigger required
 *
 * Background worker (15min timeout) that runs the post-hoc
 * citation verification on an assistant message:
 *   - extracts every statute / case / URL citation
 *   - verifies each via the appropriate waterfall
 *   - if statutes_enabled and LegiScan key present, runs the
 *     passive amendment-freshness check on every cited statute
 *   - writes the result back to workspace_chat_messages.verification
 *
 * Fired by the edge function workspace-chat-stream after the
 * assistant message finishes streaming. Fire-and-forget — the
 * chat page polls workspace-chat-message-get for the result.
 *
 * Soft-fails on every external error: we'd rather show "verification
 * failed" once than break the chat.
 */
import { verifyMessage } from '../lib/cite-verifier.js';
import { makeSupabaseREST } from '../lib/supabase-rest.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  // Internal trigger header — prevents arbitrary callers from
  // running verification jobs. The edge function sets this.
  if (req.headers.get('X-Internal-Trigger') !== 'chat-verify') {
    return json({ error: 'Forbidden' }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const messageId = body.message_id;
  const lawSettings = body.law_settings || {};
  if (!messageId) return json({ error: 'Missing message_id' }, 400);

  const sb = makeSupabaseREST({
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  // Load the message text
  let msg;
  try {
    const rows = await sb.select(`workspace_chat_messages?id=eq.${encodeURIComponent(messageId)}&select=id,content,role,verification`);
    msg = rows?.[0];
  } catch (err) {
    console.error('[chat-verify] message load failed:', err.message);
    return json({ error: 'Message lookup failed' }, 500);
  }
  if (!msg) return json({ error: 'Message not found' }, 404);
  if (msg.role !== 'assistant') return json({ error: 'Not an assistant message' }, 400);

  // Mark verification as started (idempotent — frontend may already
  // see this from the edge function's initial insert, but if not we
  // set it here so polls see "pending" not "null")
  if (!msg.verification || msg.verification.status !== 'pending') {
    try {
      await sb.update(
        'workspace_chat_messages',
        `id=eq.${encodeURIComponent(messageId)}`,
        { verification: { status: 'pending', started_at: new Date().toISOString(), cites: [] } }
      );
    } catch (err) {
      console.warn('[chat-verify] started-marker write failed:', err.message);
    }
  }

  // Run verification
  let verification;
  try {
    verification = await verifyMessage({
      content: msg.content || '',
      lawSettings,
      sb,
      clApiKey: process.env.COURTLISTENER_TOKEN || process.env.COURTLISTENER_API_KEY || null,
      legiscanApiKey: process.env.LEGISCAN_API_KEY || null,
    });
  } catch (err) {
    console.error('[chat-verify] verifyMessage threw:', err);
    verification = {
      status: 'error',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error: String(err?.message || err).slice(0, 500),
      cites: [],
    };
  }

  // Persist
  try {
    await sb.update(
      'workspace_chat_messages',
      `id=eq.${encodeURIComponent(messageId)}`,
      { verification }
    );
  } catch (err) {
    // Log raw error server-side; don't leak DB / Supabase error details
    // (which can include constraint names, column names, etc.) back to
    // the browser.
    console.error('[chat-verify] persist failed:', err);
    return json({ error: 'Verification persist failed' }, 500);
  }

  return json({
    ok: true,
    message_id: messageId,
    cite_count: verification.cites?.length || 0,
    status: verification.status,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
