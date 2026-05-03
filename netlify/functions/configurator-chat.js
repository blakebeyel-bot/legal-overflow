/**
 * POST /api/configurator-chat
 *
 * Two modes:
 *   - brainstorm (default when `context.mode === 'brainstorm'`) — the user
 *     is filling the quick-setup form; we give short suggestion pills
 *     wrapped in <suggest field="..."> tags that the UI pastes into the
 *     matching form input on click. No profile save.
 *   - interview (fallback) — traditional turn-by-turn profile build. The
 *     model eventually emits <reply>/<profile>/<done> and the client
 *     writes the profile via /api/save-profile.
 *
 * Enforces the 15-message cap from CLAUDE.md §4.10 (counts user messages).
 *
 * Body (JSON):
 *   {
 *     messages: [{ role, content }],
 *     finalize?: boolean,
 *     context?: {
 *       saved_profile?: object | null,
 *       form_state?: Record<string, string>,
 *       mode?: 'brainstorm' | 'interview'
 *     }
 *   }
 *
 * Response:
 *   { reply, messages_remaining, profile?, done? }
 *
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser } from '../lib/supabase-admin.js';
import { getAgent, loadConfig } from '../lib/agents.js';
import { callModel, extractJson } from '../lib/anthropic.js';
import { MAX_CONFIGURATOR_MESSAGES } from '../lib/constants.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { messages = [], finalize = false, context = null } = body;
  if (!Array.isArray(messages)) return json({ error: 'messages must be an array' }, 400);

  const savedProfile = context?.saved_profile || null;
  const formState = context?.form_state || null;
  const mode = context?.mode === 'interview' ? 'interview' : 'brainstorm';

  const userCount = messages.filter(m => m.role === 'user').length;
  if (userCount > MAX_CONFIGURATOR_MESSAGES) {
    return json({ error: `Message cap reached (${MAX_CONFIGURATOR_MESSAGES}). Try the form submit instead.` }, 400);
  }
  const remaining = Math.max(0, MAX_CONFIGURATOR_MESSAGES - userCount);

  const configurator = getAgent('workflow-configurator');
  const schema = loadConfig('company_profile.schema');

  const system = mode === 'brainstorm'
    ? buildBrainstormSystem(configurator.systemPrompt, savedProfile, formState)
    : buildInterviewSystem(configurator.systemPrompt, savedProfile, schema);

  // Build a single user message: the transcript plus a trailer instruction
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
    .join('\n\n');

  let userMessage;
  if (mode === 'brainstorm') {
    userMessage = `${transcript}\n\nReply in brainstorm mode. Offer 3–7 short concrete suggestions wrapped in <suggest field="..."> tags. Keep prose brief.`;
  } else {
    userMessage = finalize || userCount >= MAX_CONFIGURATOR_MESSAGES
      ? `${transcript}\n\nUSER FORCE-FINALIZE. Emit the three-tag wrap-up NOW with whatever has been gathered.`
      : `${transcript}\n\nContinue the interview. Ask the single next question, or if you have enough info, emit the three-tag wrap-up.`;
  }

  let resp;
  try {
    resp = await callModel({
      agentName: 'workflow-configurator',
      systemPrompt: system,
      userMessage,
      userId: auth.user.id,
      maxTokens: mode === 'brainstorm' ? 1200 : 2048,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }

  if (mode === 'brainstorm') {
    // Brainstorm mode never produces a profile; it just returns suggestions.
    // The <suggest> tags stay in the reply text so the client can parse them.
    return json({
      reply: resp.text.trim(),
      profile: null,
      done: false,
      messages_remaining: remaining - 1,
    });
  }

  // Interview mode — parse the three-tag structure
  const done = /<done>\s*true\s*<\/done>/i.test(resp.text);
  const replyMatch = resp.text.match(/<reply>([\s\S]*?)<\/reply>/i);
  const profileMatch = resp.text.match(/<profile>([\s\S]*?)<\/profile>/i);
  const partialMatch = resp.text.match(/<profile_partial>([\s\S]*?)<\/profile_partial>/i);

  let reply = resp.text.trim();
  let profile = null;
  let profilePartial = null;

  if (replyMatch) {
    reply = replyMatch[1].trim();
  } else {
    reply = reply.replace(/<profile_partial>[\s\S]*?<\/profile_partial>/i, '').trim();
  }
  if (profileMatch) {
    try { profile = JSON.parse(profileMatch[1].trim()); } catch { /* ignore */ }
  }
  if (partialMatch) {
    try { profilePartial = JSON.parse(partialMatch[1].trim()); } catch { /* ignore */ }
  }
  if (done && !profile) {
    try { profile = extractJson(resp.text); } catch { /* ignore */ }
  }

  return json({
    reply,
    profile: profile || profilePartial,
    done: done && !!profile,
    messages_remaining: remaining - 1,
  });
};

// ---- system prompts ----

function buildBrainstormSystem(agentPrompt, savedProfile, formState) {
  const savedBlock = savedProfile
    ? `\n\nSAVED PROFILE (already persisted — use as background context):\n${JSON.stringify(savedProfile, null, 2)}\n`
    : '';
  const formBlock = formState
    ? `\n\nCURRENT FORM STATE (what the user has typed so far — fields with empty string are unfilled):\n${JSON.stringify(formState, null, 2)}\n`
    : '';
  return (
    agentPrompt +
    `\n\n---\n\nRUNTIME MODE: BRAINSTORM HELPER\n` +
    savedBlock + formBlock +
    `\nThe user is filling a form. Your job is to suggest concrete values for specific form fields, so the user can one-click paste them in.\n\n` +
    `FORMAT RULES (STRICT):\n` +
    `- Reply with a SHORT prose intro (1–2 sentences max) explaining what you're suggesting.\n` +
    `- Then emit 3–7 <suggest field="FIELD_NAME">value</suggest> tags, one per line.\n` +
    `- FIELD_NAME must be exactly one of: company, jurisdiction, industry, description, liability, payment, red_flags, notes.\n` +
    `- Each <suggest> value should be short, self-contained, and ready to paste (no markdown, no bullets, no quotes around it).\n` +
    `- For red_flags, one <suggest> per red flag (so the user can pick which to add).\n` +
    `- For description / notes, each <suggest> is one complete candidate sentence or paragraph.\n` +
    `- Tailor suggestions to the saved profile + form state shown above (e.g., if industry is "Software / SaaS", suggest SaaS-vendor-appropriate red flags). Side-of-deal is determined per-contract by the party picker at intake, not by this form.\n` +
    `- NEVER emit <reply>/<profile>/<done>/<profile_partial>/<option> tags — those are for a different mode.\n` +
    `- NEVER invent fields other than the 8 listed above.\n` +
    `- If the user asks a question that isn't about filling the form, answer briefly and still suggest any relevant form entries you can.\n\n` +
    `EXAMPLE (for a SaaS vendor asking about red flags):\n` +
    `Here are common red flags for a SaaS vendor in your position:\n\n` +
    `<suggest field="red_flags">Auto-renewal without written notice at least 30 days prior</suggest>\n` +
    `<suggest field="red_flags">Unlimited indemnification obligations</suggest>\n` +
    `<suggest field="red_flags">Unilateral right to modify material terms</suggest>\n` +
    `<suggest field="red_flags">Waiver of limitation of liability for breach of confidentiality</suggest>\n` +
    `<suggest field="red_flags">Source code escrow obligations</suggest>\n`
  );
}

function buildInterviewSystem(agentPrompt, savedProfile, schema) {
  const savedBlock = savedProfile
    ? `\n\nEXISTING PROFILE (merge — preserve existing fields, only add new info):\n${JSON.stringify(savedProfile, null, 2)}\n`
    : '';
  return (
    agentPrompt +
    `\n\n---\n\nRUNTIME MODE: INTERVIEW\n` +
    savedBlock +
    `\nRUNTIME RULES:\n` +
    `- Ask ONE question per turn. Offer 3–5 <option>...</option> tags where useful.\n` +
    `- EVERY turn, append <profile_partial>{...}</profile_partial> with accumulated knowledge.\n` +
    `- When enough gathered, emit:\n` +
    `  <reply>wrap-up message</reply>\n` +
    `  <profile>{ complete schema JSON }</profile>\n` +
    `  <done>true</done>\n` +
    `- NEVER emit the final three-tag structure before message 4 unless the user forces it.\n\n` +
    `SCHEMA:\n${JSON.stringify(schema, null, 2)}`
  );
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
