/**
 * POST /api/upload-playbook
 *
 * Takes an uploaded playbook file (.docx / .pdf / .md / .txt), extracts its
 * text, passes it through the workflow-configurator agent to produce a
 * company_profile.json, and upserts into company_profiles.
 *
 * Gatekeeper: rejects files >50MB or with unsupported formats before
 * touching the model or storage. The contract gets stored in
 * contracts-incoming/<user>/playbook-<timestamp>.<ext> for audit, but
 * we do NOT descend on it for review.
 *
 * Body: multipart/form-data, single field named "file"
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { loadConfig } from '../lib/agents.js';
import { callModel, extractJson } from '../lib/anthropic.js';
import { extractDocumentText } from '../lib/extract.js';
import { MAX_UPLOAD_BYTES } from '../lib/constants.js';

const ALLOWED_EXT = new Set(['docx', 'pdf', 'md', 'txt']);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  let formData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data with a "file" field' }, 400);
  }
  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'No file uploaded' }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB cap` }, 413);
  }

  const filename = file.name || 'playbook';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return json({ error: `Unsupported format: .${ext}. Allowed: .docx, .pdf, .md, .txt` }, 400);
  }

  const t0 = Date.now();
  const stamp = (label) => console.log(`[upload-playbook] ${label} @ ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  stamp('got file ' + filename + ' (' + file.size + ' bytes)');

  const buffer = Buffer.from(await file.arrayBuffer());

  let extracted;
  try {
    extracted = await extractDocumentText(buffer, filename);
    stamp('extracted ' + extracted.text.length + ' chars');
  } catch (err) {
    return json({ error: 'Extraction failed: ' + err.message }, 400);
  }

  // Audit-log the playbook (private bucket, user-scoped path)
  const supabase = getSupabaseAdmin();
  const ts = Date.now();
  const storageKey = `${auth.user.id}/playbooks/${ts}_${filename}`;
  await supabase.storage.from('contracts-incoming').upload(storageKey, buffer, {
    upsert: false,
    contentType: file.type || 'application/octet-stream',
  });
  stamp('uploaded to storage');

  // Focused system prompt — we don't need the full workflow-configurator
  // agent (2K+ tokens of Python-agent framing). This function has ONE job:
  // take a playbook text and emit a JSON profile.
  //
  // Large playbook PDFs (100K+ chars) approach the Netlify timeout even on
  // production. We slice to 25K chars (~6K tokens) — picks up the first
  // ~20 pages which typically contain the core positions. Users can always
  // chat-in extra nuance after the initial save.
  const schema = loadConfig('company_profile.schema');
  const systemPrompt =
    `You are a contract-review playbook ingestor. You receive a text playbook ` +
    `and emit a company_profile.json object that conforms to the provided schema.\n\n` +
    `Rules:\n` +
    `1. Output ONLY a JSON object — no prose, no markdown fences, no commentary.\n` +
    `2. ALWAYS emit ALL seven required top-level keys: company, jurisdiction, positions, red_flags, escalation, voice, output. Never omit a required key — if the playbook is silent on a section, populate it with a sensible default (see below) rather than leaving it out.\n` +
    `3. Do NOT invent SPECIFIC positions or red flags the user didn't state. For unspecified sections, use the empty defaults below and set a top-level "needs_review": true marker.\n` +
    `4. Be faithful to the user's words. Use their phrasings for red flags and positions.\n` +
    `5. KEEP IT TIGHT — aim for under 1.5KB of JSON. Summarize rather than restate. Pick the 10–15 most important red flags/positions, not everything.\n` +
    `6. Emit the JSON immediately — no reasoning preamble.\n` +
    `7. Field values should be short strings (~100 chars) not long paragraphs. The full playbook lives in storage — this profile is a structured summary.\n\n` +
    `DEFAULTS when the playbook is silent on a section:\n` +
    `  red_flags: []  (empty array)\n` +
    `  escalation: { "senior_reviewers": [], "escalation_trigger_severity": "blocker" }\n` +
    `  voice: { "tone": "measured senior counsel", "speaker_label": "we", "counterparty_label": "you" }\n` +
    `  output: { "reviewer_author": "<reviewer name from playbook, else company name>", "reviewer_initials": "<derived 2-letter initials>" }\n` +
    `  positions: {}  (empty object — only fill if the playbook clearly states positions on liability, payment, IP, termination, etc.)\n\n` +
    `SCHEMA:\n${JSON.stringify(schema, null, 2)}`;

  const MAX_PLAYBOOK_CHARS = 25_000;
  const truncated = extracted.text.length > MAX_PLAYBOOK_CHARS;
  const playbookSnippet = extracted.text.slice(0, MAX_PLAYBOOK_CHARS);
  const userMessage =
    `PLAYBOOK TEXT${truncated ? ` (first ${MAX_PLAYBOOK_CHARS} of ${extracted.text.length} chars)` : ''}:\n${playbookSnippet}\n\n` +
    `Emit the JSON profile now.`;

  let profile;
  try {
    const resp = await callModel({
      agentName: 'workflow-configurator',
      systemPrompt,
      userMessage,
      userId: auth.user.id,
      // 2500 tokens ≈ 8KB JSON. The model needs room for rich positions
      // + red_flags content AND the lower-priority keys (voice, output,
      // escalation). At 1500 tokens it was running out of budget and
      // dropping the latter group.
      maxTokens: 2500,
    });
    stamp('model returned ' + (resp.text?.length || 0) + ' chars');
    profile = extractJson(resp.text);
    stamp('parsed profile JSON');

    // Defensive defaulting — even with explicit "ALWAYS emit all 7 keys"
    // instructions, the model occasionally omits low-priority sections.
    // Backfill so the saved profile always satisfies the schema's
    // required-fields contract; downstream specialists fall back to these
    // defaults gracefully.
    profile = applyProfileDefaults(profile);
    stamp('applied schema defaults');
  } catch (err) {
    stamp('model/parse failed: ' + err.message);
    return json({ error: 'Configurator failed: ' + err.message }, 500);
  }

  // Upsert into company_profiles
  const { error: upsertErr } = await supabase
    .from('company_profiles')
    .upsert(
      { user_id: auth.user.id, profile_json: profile },
      { onConflict: 'user_id' }
    );
  if (upsertErr) return json({ error: upsertErr.message }, 500);
  stamp('upserted profile');

  return json({
    ok: true,
    profile,
    playbook_storage_key: storageKey,
    source_format: extracted.format,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Backfill schema-required keys the model may have omitted. The schema
 * (company_profile.schema.json) requires seven top-level keys plus several
 * required sub-keys (e.g. company.name, jurisdiction.primary, voice.tone).
 * The workflow-configurator prompt instructs the model to ALWAYS emit them
 * with sensible defaults, but at the token boundary the model occasionally
 * drops the lower-priority sections (voice, output, escalation). This
 * function backfills any missing keys so the saved profile satisfies the
 * schema contract, with clearly-marked-as-default values that downstream
 * specialists can detect and surface to the user as "needs review."
 */
function applyProfileDefaults(profileIn) {
  const profile = profileIn && typeof profileIn === 'object' ? { ...profileIn } : {};

  // Track whether we had to fill in any defaults so downstream UI can
  // show a "we filled in some sections — review when ready" hint.
  let backfilled = false;

  // company — required keys: name, industry, role_in_contracts
  profile.company = profile.company && typeof profile.company === 'object' ? { ...profile.company } : {};
  if (!profile.company.name) { profile.company.name = profile.company_name || ''; backfilled = true; }
  if (!profile.company.industry) { profile.company.industry = profile.industry || ''; backfilled = true; }
  if (!profile.company.role_in_contracts) {
    // Legacy field — kept for backward compat with reviews that ran
    // before the per-contract party picker landed.
    profile.company.role_in_contracts = profile.role_in_contracts || '';
    backfilled = true;
  }

  // jurisdiction — required: primary
  if (typeof profile.jurisdiction !== 'object' || !profile.jurisdiction) {
    profile.jurisdiction = { primary: typeof profileIn?.jurisdiction === 'string' ? profileIn.jurisdiction : '' };
    backfilled = true;
  } else if (!profile.jurisdiction.primary) {
    profile.jurisdiction.primary = '';
    backfilled = true;
  }

  // positions — empty object if missing
  if (typeof profile.positions !== 'object' || !profile.positions) {
    profile.positions = {};
    backfilled = true;
  }

  // red_flags — empty array if missing
  if (!Array.isArray(profile.red_flags)) {
    profile.red_flags = [];
    backfilled = true;
  }

  // escalation — required sub-keys: senior_reviewers, escalation_trigger_severity
  if (typeof profile.escalation !== 'object' || !profile.escalation) {
    profile.escalation = { senior_reviewers: [], escalation_trigger_severity: 'blocker' };
    backfilled = true;
  } else {
    if (!Array.isArray(profile.escalation.senior_reviewers)) {
      profile.escalation.senior_reviewers = []; backfilled = true;
    }
    if (!profile.escalation.escalation_trigger_severity) {
      profile.escalation.escalation_trigger_severity = 'blocker'; backfilled = true;
    }
  }

  // voice — required sub-keys: tone, speaker_label, counterparty_label
  if (typeof profile.voice !== 'object' || !profile.voice) {
    profile.voice = { tone: 'measured senior counsel', speaker_label: 'we', counterparty_label: 'you' };
    backfilled = true;
  } else {
    if (!profile.voice.tone) { profile.voice.tone = 'measured senior counsel'; backfilled = true; }
    if (!profile.voice.speaker_label) { profile.voice.speaker_label = 'we'; backfilled = true; }
    if (!profile.voice.counterparty_label) { profile.voice.counterparty_label = 'you'; backfilled = true; }
  }

  // output — required sub-keys: reviewer_author, reviewer_initials
  if (typeof profile.output !== 'object' || !profile.output) {
    const author = profile.company?.name || '';
    profile.output = { reviewer_author: author, reviewer_initials: deriveInitials(author) };
    backfilled = true;
  } else {
    if (!profile.output.reviewer_author) {
      profile.output.reviewer_author = profile.company?.name || ''; backfilled = true;
    }
    if (!profile.output.reviewer_initials) {
      profile.output.reviewer_initials = deriveInitials(profile.output.reviewer_author); backfilled = true;
    }
  }

  // Hint to downstream UI / configurator-chat that some defaults were applied.
  // Don't clobber an existing needs_review flag the model already set.
  if (backfilled && profile.needs_review !== false) {
    profile.needs_review = true;
  }

  return profile;
}

function deriveInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
