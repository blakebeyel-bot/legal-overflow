/**
 * Chat priming — generate the opening assistant message for a
 * fresh chat bound to a prompt-pack workflow.
 *
 * Pattern: when a user clicks "Run in chat" on a homepage skill
 * card or hits Run on a saved prompt-pack workflow, the chat is
 * created empty. Without priming, the user lands on a blank chat
 * and has to figure out what to type to start the workflow. With
 * priming, the model has already "spoken first" — its opening
 * message asks a focused first question that walks the user toward
 * the prompt pack's final deliverable.
 *
 * How it works:
 *   1. Wrap the workflow's prompt_md with a meta-instruction that
 *      tells the model to act as a guided interviewer (intro +
 *      one focused first question, no final deliverable yet).
 *   2. Call Gemini Flash 2.5 — fast and cheap, doesn't matter what
 *      chat model the user has selected since this is just the
 *      kickoff. Their selected model takes over from message #2.
 *   3. Persist the result as the first assistant message in the
 *      chat row. User navigates and sees it instantly — no streaming
 *      gymnastics, no special UI.
 *
 * Failure mode: any error here is logged + swallowed. The chat is
 * still created and works normally — user just sees the empty-state
 * intro card we already render. Priming is a UX upgrade, not a
 * blocker.
 */

import { resolveProviderKey } from './byok-keys.js';

// Claude Haiku 4.5 follows format constraints (specifically "must
// end in a question mark") far more reliably than Gemini Flash.
// We use Haiku as the primary primer; Gemini Flash is the fallback
// if no Anthropic key resolves. The primer is a one-shot generation
// of an 80-word opener — Haiku is fast (<1s) and cheap (~$0.0006).
const PRIMER_MODEL_ANTHROPIC = 'claude-haiku-4-5';
const PRIMER_MODEL_GEMINI = 'gemini-2.5-flash';
const PRIMER_TIMEOUT_MS = 30_000;

/**
 * Build the wrapper prompt that turns any prompt pack into a
 * guided-interview kickoff. Generic enough to work without rewriting
 * the .md content of individual packs.
 */
function buildPrimerPrompt(promptMd) {
  return `You are about to begin a guided, conversational walkthrough of the prompt pack below. Your job is to help the user produce the FINAL DELIVERABLE described in the pack — but instead of executing all the prompts at once, you will walk them through it step by step, asking ONE focused question at a time and gathering inputs along the way.

PROMPT PACK CONTENT (your methodology and end goal):
====================
${promptMd}
====================

YOUR FIRST MESSAGE — produce it NOW. ABSOLUTE RULES:

1. The message MUST end with a question mark. Not a statement, not "let me know what you need", not "feel free to share more". A specific, focused QUESTION.

2. Open with ONE short sentence (under 25 words) introducing what this pack will help the user accomplish.

3. Then ask ONE concrete, specific question to gather the FIRST input the methodology requires. Pick from these patterns based on what the pack needs:
   - For document review packs: "Can you paste the [contract / clause / brief] you want to review?"
   - For research packs: "What's the legal question or fact pattern we're working through?"
   - For drafting packs: "What kind of [document / clause / motion] are we drafting, and who's the client?"
   - For deposition / discovery packs: "What's the matter — case name, posture, and what's the deposition / discovery focus?"
   - For citation / verification packs: "Can you paste the brief or memo whose citations need checking?"
   - For analysis packs: "What's the issue or case you'd like me to analyze first?"

4. The question must be ANSWERABLE in one short reply. No "tell me everything about your case." Pick the smallest input that gets you started.

5. Tone: friendly professional colleague. Not "How can I assist you?" — that's chatbot generic. Be specific to this pack's purpose.

6. Do NOT produce the final deliverable.
7. Do NOT list multiple questions or bullet points.
8. Do NOT recite the pack's methodology or step list.
9. Do NOT use markdown headings, bold, or bullet points.
10. Total length under 75 words. Two sentences is ideal.

Respond now with the opening message text only — no "Here's:" preamble, no framing. Plain conversational prose. The message MUST end in a question mark.`;
}

/**
 * Call Anthropic Claude Haiku with the wrapper prompt. More
 * reliable than Gemini Flash for format-constrained outputs.
 * Returns the assistant's opening message or null on any failure.
 */
async function callPrimerAnthropic({ promptMd, apiKey }) {
  if (!promptMd || !apiKey) return null;
  const wrapped = buildPrimerPrompt(promptMd);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PRIMER_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: PRIMER_MODEL_ANTHROPIC,
        max_tokens: 400,
        temperature: 0.5,
        messages: [{ role: 'user', content: wrapped }],
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn(`[chat-prime] Anthropic ${r.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    const text = j?.content?.[0]?.text || '';
    const trimmed = String(text).trim();
    return trimmed || null;
  } catch (err) {
    console.warn('[chat-prime] Anthropic call failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate the primer output. The wrapper instructs the model to
 * ALWAYS end with a question mark — but models occasionally produce
 * statement-only outputs anyway. When that happens we append a
 * generic-but-relevant question derived from the prompt pack title
 * / content rather than letting an unhelpful statement land in the
 * user's chat. Returns the (possibly amended) opening message.
 */
function ensureEndsInQuestion(opening, promptMd) {
  const trimmed = String(opening || '').trim();
  if (!trimmed) return null;
  // If the trimmed message ends with a question mark, we're good.
  if (/\?\s*$/.test(trimmed)) return trimmed;
  // Otherwise, append a sensible default question derived from the
  // pack content. We pick the question template based on keywords
  // in the prompt — same heuristics the wrapper offers as examples.
  const lc = String(promptMd || '').toLowerCase();
  let fallback;
  if (/citation|cite[- ]check|bluebook/.test(lc)) {
    fallback = 'Can you paste the brief or memo whose citations need checking?';
  } else if (/depo|deposition/.test(lc)) {
    fallback = 'What\'s the matter — case name, posture, and what\'s the deposition focus?';
  } else if (/extract|clause/.test(lc)) {
    fallback = 'What kind of agreement are we extracting from, and which clauses do you need?';
  } else if (/research|memo|argument|motion/.test(lc)) {
    fallback = 'What\'s the legal question or fact pattern we\'re working through?';
  } else if (/redline|review|contract|msa|nda|saas|agreement/.test(lc)) {
    fallback = 'Can you paste the contract or specific clause you\'d like to start with?';
  } else {
    fallback = 'What would you like to start with?';
  }
  return `${trimmed} ${fallback}`;
}

/**
 * Call Gemini Flash 2.5 with the wrapper prompt. Returns the
 * assistant's opening message, or null on any failure.
 *
 * @param {object} opts
 * @param {string} opts.promptMd  — the workflow's system prompt body
 * @param {string} opts.apiKey    — Google AI key (resolved by caller)
 * @returns {Promise<string|null>}
 */
async function callPrimerGemini({ promptMd, apiKey }) {
  if (!promptMd || !apiKey) return null;
  const wrapped = buildPrimerPrompt(promptMd);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${PRIMER_MODEL_GEMINI}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PRIMER_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: wrapped }] }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 400,
        },
        // Disable Gemini's overzealous safety filters — they sometimes
        // refuse legal-context content under RECITATION. Mirrors the
        // chat-stream safetySettings.
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',   threshold: 'BLOCK_NONE' },
        ],
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn(`[chat-prime] Gemini ${r.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const trimmed = String(text).trim();
    if (!trimmed) return null;
    return trimmed;
  } catch (err) {
    console.warn('[chat-prime] generation failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Main entry — prime a fresh chat bound to a prompt-pack workflow.
 *
 * Idempotent guards:
 *   - Returns early if the chat already has any messages
 *   - Returns early if the workflow isn't flagged is_prompt_pack
 *   - Returns early if no Google AI key resolves
 *   - Returns early if the LLM call fails
 *
 * On success, inserts the assistant message into workspace_chat_messages
 * and returns the inserted row.
 *
 * @param {object} opts
 * @param {object} opts.supabase   — service-role client
 * @param {string} opts.userId
 * @param {string} opts.chatId
 * @param {string} opts.workflowId
 * @returns {Promise<object|null>}  — inserted message row or null
 */
export async function primeChat({ supabase, userId, chatId, workflowId }) {
  if (!supabase || !userId || !chatId || !workflowId) return null;

  try {
    // 1. Verify the workflow is flagged as a prompt pack and pull
    //    its prompt_md. RLS-safe: the workflow may be user-owned OR
    //    a system-published one (user_id is null).
    const { data: wf } = await supabase
      .from('workspace_workflows')
      .select('id, kind, prompt_md, is_prompt_pack, user_id, is_published')
      .eq('id', workflowId)
      .or(`user_id.eq.${userId},and(user_id.is.null,is_published.eq.true)`)
      .maybeSingle();
    if (!wf) {
      console.log(`[chat-prime] skipped — workflow ${workflowId} not found or not accessible`);
      return null;
    }
    if (!wf.is_prompt_pack) {
      // User-created workflows stay silent — only homepage prompt
      // packs get the auto-primed first message. Workflows imported
      // BEFORE the is_prompt_pack flag was rolled out also land
      // here; users need to re-import or run the bulk-flag SQL.
      console.log(`[chat-prime] skipped — workflow ${workflowId} is_prompt_pack=false (user-created or pre-flag import)`);
      return null;
    }
    if (wf.kind !== 'chat' || !wf.prompt_md) {
      console.log(`[chat-prime] skipped — workflow ${workflowId} kind=${wf.kind} promptLen=${wf.prompt_md?.length || 0}`);
      return null;
    }

    // 2. Belt-and-suspenders: verify the chat is actually empty.
    //    Prevents double-priming if this gets called twice for the
    //    same chat (e.g. retry on transient error).
    const { count: existingCount } = await supabase
      .from('workspace_chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('chat_id', chatId);
    if ((existingCount ?? 0) > 0) {
      return null;
    }

    // 3. Resolve API keys for primer providers via BYOK first
    //    (user's stored key) then server env fallback. Prefer
    //    Anthropic (Claude Haiku follows format constraints
    //    reliably); fall back to Gemini Flash if Anthropic
    //    resolution returned nothing.
    let anthropicKey = '';
    try {
      const r = await resolveProviderKey({ userId, provider: 'anthropic' });
      anthropicKey = r.key || '';
    } catch {}
    let geminiKey = '';
    try {
      const r = await resolveProviderKey({ userId, provider: 'google' });
      geminiKey = r.key || '';
    } catch {}

    if (!anthropicKey && !geminiKey) {
      console.warn('[chat-prime] no Anthropic or Google key — skipping primer');
      return null;
    }

    // 4. Generate the opening message — try Claude Haiku first
    //    (best at "must end in a question" instruction-following),
    //    fall back to Gemini Flash if it fails.
    let opening = null;
    let modelUsed = '';
    if (anthropicKey) {
      opening = await callPrimerAnthropic({ promptMd: wf.prompt_md, apiKey: anthropicKey });
      if (opening) modelUsed = PRIMER_MODEL_ANTHROPIC;
    }
    if (!opening && geminiKey) {
      opening = await callPrimerGemini({ promptMd: wf.prompt_md, apiKey: geminiKey });
      if (opening) modelUsed = PRIMER_MODEL_GEMINI;
    }
    if (!opening) {
      console.warn('[chat-prime] both primer paths failed — no message generated');
      return null;
    }

    // 4b. VALIDATE — ensure the message ends with a question mark.
    //     Models occasionally violate the wrapper's strict rule
    //     (Gemini Flash especially). If they do, append a sensible
    //     default question derived from the prompt-pack content.
    const validated = ensureEndsInQuestion(opening, wf.prompt_md);
    if (!validated) return null;
    if (validated !== opening) {
      console.log(`[chat-prime] validation appended fallback question to ${modelUsed} output`);
    }

    // 5. Persist as the first assistant message.
    const { data: msg, error } = await supabase
      .from('workspace_chat_messages')
      .insert({
        chat_id: chatId,
        role: 'assistant',
        content: validated,
        status: 'complete',
        model_used: modelUsed,
      })
      .select('*')
      .single();
    if (error) {
      console.warn('[chat-prime] message insert failed:', error.message);
      return null;
    }
    console.log(`[chat-prime] chat=${chatId} primed via ${modelUsed} (${validated.length} chars)`);
    return msg;
  } catch (err) {
    console.warn('[chat-prime] primeChat threw:', err?.message || err);
    return null;
  }
}
