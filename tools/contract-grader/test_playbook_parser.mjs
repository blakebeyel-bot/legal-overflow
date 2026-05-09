// Local end-to-end test for the playbook parser. Exercises the EXACT same
// extraction + LLM call that netlify/functions/upload-playbook.js runs in
// production, minus the auth gate and the DB upsert. Output: a JSON profile
// printed to stdout + a schema-conformance check against company_profile.schema.
//
// Usage: node tools/contract-grader/test_playbook_parser.mjs [path/to/playbook.docx]
// Cost:  ~$0.01 per run (one ~1500-token Sonnet call).

import fs from 'node:fs';

// .env bootstrap so callModel sees the API key
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { extractDocumentText } from '../../netlify/lib/extract.js';
import { callModel, extractJson } from '../../netlify/lib/anthropic.js';
import { loadConfig } from '../../netlify/lib/agents.js';

const playbookPath = process.argv[2] || 'tools/contract-grader/test_profiles/playbook_buyer_positions.docx';

console.log(`[playbook-test] reading ${playbookPath}`);
const buffer = fs.readFileSync(playbookPath);

console.log(`[playbook-test] extracting text…`);
const extracted = await extractDocumentText(buffer, playbookPath.split('/').pop());
console.log(`[playbook-test] got ${extracted.text.length} chars (${extracted.format})`);
console.log(`[playbook-test] first 500 chars:\n  ${extracted.text.slice(0, 500).replace(/\n/g, '\n  ')}\n`);

const schema = loadConfig('company_profile.schema');
// Mirror upload-playbook.js's prompt exactly so the harness tests the
// production code path, not a divergent copy.
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
const userMessage =
  `PLAYBOOK TEXT${truncated ? ` (first ${MAX_PLAYBOOK_CHARS} of ${extracted.text.length} chars)` : ''}:\n${extracted.text.slice(0, MAX_PLAYBOOK_CHARS)}\n\n` +
  `Emit the JSON profile now.`;

console.log(`[playbook-test] calling workflow-configurator (sonnet)…`);
const t0 = Date.now();
const resp = await callModel({
  agentName: 'workflow-configurator',
  systemPrompt,
  userMessage,
  userId: 'playbook-test',
  maxTokens: 2500,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[playbook-test] model returned ${resp.text?.length || 0} chars in ${elapsed}s`);

let profile = extractJson(resp.text);

// Inline copy of upload-playbook.js's defaulting layer (kept here verbatim
// so the test exercises the same post-processing the prod endpoint runs).
profile = applyProfileDefaults(profile);

function applyProfileDefaults(profileIn) {
  const profile = profileIn && typeof profileIn === 'object' ? { ...profileIn } : {};
  let backfilled = false;
  profile.company = profile.company && typeof profile.company === 'object' ? { ...profile.company } : {};
  if (!profile.company.name) { profile.company.name = profile.company_name || ''; backfilled = true; }
  if (!profile.company.industry) { profile.company.industry = profile.industry || ''; backfilled = true; }
  if (!profile.company.role_in_contracts) { profile.company.role_in_contracts = profile.role_in_contracts || ''; backfilled = true; }
  if (typeof profile.jurisdiction !== 'object' || !profile.jurisdiction) {
    profile.jurisdiction = { primary: typeof profileIn?.jurisdiction === 'string' ? profileIn.jurisdiction : '' };
    backfilled = true;
  } else if (!profile.jurisdiction.primary) { profile.jurisdiction.primary = ''; backfilled = true; }
  if (typeof profile.positions !== 'object' || !profile.positions) { profile.positions = {}; backfilled = true; }
  if (!Array.isArray(profile.red_flags)) { profile.red_flags = []; backfilled = true; }
  if (typeof profile.escalation !== 'object' || !profile.escalation) {
    profile.escalation = { senior_reviewers: [], escalation_trigger_severity: 'blocker' }; backfilled = true;
  } else {
    if (!Array.isArray(profile.escalation.senior_reviewers)) { profile.escalation.senior_reviewers = []; backfilled = true; }
    if (!profile.escalation.escalation_trigger_severity) { profile.escalation.escalation_trigger_severity = 'blocker'; backfilled = true; }
  }
  if (typeof profile.voice !== 'object' || !profile.voice) {
    profile.voice = { tone: 'measured senior counsel', speaker_label: 'we', counterparty_label: 'you' }; backfilled = true;
  } else {
    if (!profile.voice.tone) { profile.voice.tone = 'measured senior counsel'; backfilled = true; }
    if (!profile.voice.speaker_label) { profile.voice.speaker_label = 'we'; backfilled = true; }
    if (!profile.voice.counterparty_label) { profile.voice.counterparty_label = 'you'; backfilled = true; }
  }
  if (typeof profile.output !== 'object' || !profile.output) {
    const author = profile.company?.name || '';
    profile.output = { reviewer_author: author, reviewer_initials: deriveInitials(author) }; backfilled = true;
  } else {
    if (!profile.output.reviewer_author) { profile.output.reviewer_author = profile.company?.name || ''; backfilled = true; }
    if (!profile.output.reviewer_initials) { profile.output.reviewer_initials = deriveInitials(profile.output.reviewer_author); backfilled = true; }
  }
  if (backfilled && profile.needs_review !== false) profile.needs_review = true;
  return profile;
}
function deriveInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

console.log('\n=== Parsed profile ===');
console.log(JSON.stringify(profile, null, 2));

// Quick schema-shape audit — what would the UI have access to?
console.log('\n=== UI render preview (matches renderProfileSummary) ===');
const companyName = profile.company?.name || profile.company_name || '';
const industry = profile.company?.industry || profile.industry || profile.sector || '';
const jurisdiction =
  (typeof profile.jurisdiction === 'object' && profile.jurisdiction)
    ? profile.jurisdiction.primary || profile.jurisdiction.governing_law || ''
    : (profile.jurisdiction || profile.governing_law || '');
const positionsCount = profile.positions && typeof profile.positions === 'object'
  ? Object.keys(profile.positions).length : 0;
const redFlagsCount = Array.isArray(profile.red_flags)
  ? profile.red_flags.length
  : (profile.red_flags && typeof profile.red_flags === 'object' ? Object.keys(profile.red_flags).length : 0);

console.log('  Company     :', JSON.stringify(companyName) || '(empty)');
console.log('  Industry    :', JSON.stringify(industry) || '(empty)');
console.log('  Jurisdiction:', JSON.stringify(jurisdiction) || '(empty)');
console.log('  Positions   :', positionsCount, 'group(s)');
console.log('  Red flags   :', redFlagsCount, 'flag(s)');

// Schema check — required top-level fields
console.log('\n=== Schema required fields check ===');
const required = schema.required || [];
let missing = 0;
for (const k of required) {
  const present = profile[k] !== undefined && profile[k] !== null;
  console.log(`  ${present ? '✓' : '✗'} ${k}`);
  if (!present) missing++;
}
console.log(`\n[playbook-test] ${missing === 0 ? 'PASS — all required fields present' : `FAIL — ${missing} required field(s) missing`}`);
