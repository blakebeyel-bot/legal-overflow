/**
 * POST /api/workspace-chat-send  (streaming)
 *   body: { chat_id, content, model? }
 *
 * Persists the user message, streams the assistant's response back over
 * Server-Sent Events, then persists the final assistant message and
 * (if first turn) generates a chat title.
 *
 * SSE event format:
 *   event: text
 *   data: {"delta": "..."}
 *
 *   event: done
 *   data: {"message_id":"...","title":"...","usage":{...}}
 *
 *   event: error
 *   data: {"error":"..."}
 *
 * The frontend listens for these via EventSource (or fetch + ReadableStream
 * since EventSource can't send POST bodies).
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { streamText, findModel, completeText } from '../lib/llm-providers.js';

// Phase 1 system prompt — chat is a general-purpose legal assistant for
// the signed-in user. Tool-calling (read_document, find_in_document)
// arrives in Phase 2 once the document library exists.
const SYSTEM_PROMPT = `You are a helpful AI legal research assistant for a U.S. attorney. The user is your professional peer.

Tone and format:
- Write in flowing conversational prose, the way a senior associate would explain something at the office. No corporate-memo voice.
- Do NOT use markdown headings (#, ##, ###) — ever. Don't use bullet lists or numbered lists unless the user explicitly asks for one. No tables.
- It is fine to use **bold** sparingly for a key term or rule name, and *italics* for case names.
- Be concise. No filler, no padding, no closing summary that just repeats what you already said.

Substance:
- Identify the governing rule, statute, or doctrine. Note the jurisdiction if it matters.
- Flag any open factual questions before opining.
- If you cite a case, statute, or rule, give the formal citation. If you do not have a verified citation, say so plainly and offer the underlying point in your own words. Never invent a citation.

You are not the user's lawyer and do not produce final-form legal advice. Treat the user as a peer who will independently verify what you give them.`;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const chatId = body.chat_id;
  const content = String(body.content || '').trim();
  const requestedModel = body.model;
  if (!chatId) return json({ error: 'Missing chat_id' }, 400);
  if (!content) return json({ error: 'Empty message' }, 400);
  if (content.length > 50_000) return json({ error: 'Message too long (50k char limit)' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify ownership and load chat metadata
  const { data: chat, error: chatErr } = await supabase
    .from('workspace_chats')
    .select('id, user_id, model, title')
    .eq('id', chatId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (chatErr || !chat) return json({ error: 'Chat not found' }, 404);

  // Persist the user message immediately so it survives if streaming fails
  const { data: userMsg, error: userMsgErr } = await supabase
    .from('workspace_chat_messages')
    .insert({ chat_id: chatId, role: 'user', content, status: 'complete' })
    .select('id')
    .single();
  if (userMsgErr) return json({ error: userMsgErr.message }, 500);

  // Decide which model + provider to use
  const modelId = requestedModel || chat.model || 'claude-sonnet-4-5';
  const modelInfo = findModel(modelId);
  if (!modelInfo) return json({ error: `Unknown model: ${modelId}` }, 400);
  if (modelInfo.id !== chat.model) {
    // Persist the new selection on the chat
    await supabase.from('workspace_chats').update({ model: modelInfo.id }).eq('id', chatId);
  }

  const { key, source } = await resolveProviderKey({ userId: auth.user.id, provider: modelInfo.provider });
  if (!key) {
    return json({
      error: `No API key configured for ${modelInfo.provider}. Add your own in /account/ or contact the operator.`,
    }, 400);
  }

  // Load conversation history for context
  const { data: history } = await supabase
    .from('workspace_chat_messages')
    .select('role, content, status')
    .eq('chat_id', chatId)
    .neq('id', userMsg.id)
    .order('created_at', { ascending: true })
    .limit(40);
  const messages = (history || [])
    .filter((m) => m.status === 'complete' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content || '' }));
  messages.push({ role: 'user', content });

  // Insert the assistant placeholder row up front so the UI can poll it
  const { data: asstMsg, error: asstErr } = await supabase
    .from('workspace_chat_messages')
    .insert({ chat_id: chatId, role: 'assistant', content: '', status: 'streaming', model_used: modelInfo.id })
    .select('id')
    .single();
  if (asstErr) return json({ error: asstErr.message }, 500);

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      // Tell the client which message id and the source (server vs user key)
      send('start', { message_id: asstMsg.id, model: modelInfo.id, key_source: source });

      let full = '';
      let usage = { input: 0, output: 0 };
      try {
        for await (const chunk of streamText({
          provider: modelInfo.provider,
          model: modelInfo.id,
          apiKey: key,
          system: SYSTEM_PROMPT,
          messages,
          maxTokens: 4096,
          temperature: 0.4,
        })) {
          if (chunk.type === 'text') {
            full += chunk.delta;
            send('text', { delta: chunk.delta });
          } else if (chunk.type === 'done') {
            usage = chunk.usage;
          }
        }
      } catch (err) {
        send('error', { error: err.message || String(err) });
        await supabase
          .from('workspace_chat_messages')
          .update({ status: 'error', status_detail: err.message?.slice(0, 1000) || 'unknown' })
          .eq('id', asstMsg.id);
        controller.close();
        return;
      }

      // Persist final assistant message
      await supabase
        .from('workspace_chat_messages')
        .update({
          content: full,
          status: 'complete',
          prompt_tokens: usage.input || null,
          completion_tokens: usage.output || null,
        })
        .eq('id', asstMsg.id);

      // Auto-generate a title on the first turn (chat.title is null)
      let title = chat.title;
      if (!title) {
        try {
          title = await generateTitle({ provider: modelInfo.provider, apiKey: key, modelId: modelInfo.id, userMessage: content, assistantReply: full });
          if (title) await supabase.from('workspace_chats').update({ title }).eq('id', chatId);
        } catch {/* ignore title failures */}
      }

      // Touch chat updated_at
      await supabase.from('workspace_chats').update({ updated_at: new Date().toISOString() }).eq('id', chatId);

      send('done', { message_id: asstMsg.id, title, usage });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
};

async function generateTitle({ provider, apiKey, modelId, userMessage, assistantReply }) {
  // Use a small/cheap call to summarize the chat into a 5-7 word title.
  const prompt = `Summarize this exchange as a title of 3-7 words. No quotes, no period.

USER: ${userMessage.slice(0, 500)}
ASSISTANT: ${assistantReply.slice(0, 800)}

Title:`;
  const { text } = await completeText({
    provider,
    model: modelId,
    apiKey,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 30,
    temperature: 0.3,
  });
  const cleaned = text.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '').slice(0, 100);
  return cleaned || null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
