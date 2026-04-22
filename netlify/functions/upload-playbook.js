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
  // take a playbook text and emit a JSON profile. Keeping the prompt lean
  // makes the call fast enough to finish inside Netlify dev's hardcoded
  // 30s local-emulator timeout.
  const schema = loadConfig('company_profile.schema');
  const systemPrompt =
    `You are a contract-review playbook ingestor. You receive a text ` +
    `playbook (may be short/structured form answers, may be a full written ` +
    `playbook) and emit a company_profile.json object that conforms to the ` +
    `provided schema.\n\n` +
    `Rules:\n` +
    `1. Output ONLY a JSON object — no prose, no markdown fences, no commentary.\n` +
    `2. Do not invent positions the user didn't state. For unspecified sections, use an empty object/array or null, and set a top-level "needs_review": true marker.\n` +
    `3. Be faithful to the user's words. Use their phrasings for red flags and positions.\n` +
    `4. Keep the response concise — target under 3KB of JSON.`;

  const userMessage =
    `SCHEMA:\n${JSON.stringify(schema, null, 2)}\n\n` +
    `PLAYBOOK TEXT:\n${extracted.text.slice(0, 40_000)}\n\n` +
    `Emit the JSON profile now.`;

  let profile;
  try {
    const resp = await callModel({
      agentName: 'workflow-configurator',
      systemPrompt,
      userMessage,
      userId: auth.user.id,
      maxTokens: 3072,
    });
    stamp('model returned ' + (resp.text?.length || 0) + ' chars');
    profile = extractJson(resp.text);
    stamp('parsed profile JSON');
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
