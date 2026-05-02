// Part D: classify external_comment text from every Round 1 finding as
// CUSTOMER-FACING / INTERNAL / PROBLEMATIC.
import fs from 'node:fs';
import path from 'node:path';

for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { callModel, extractJson } from '../../netlify/lib/anthropic.js';

const SYSTEM_PROMPT = `You are a senior transactional attorney auditing the customer-facing margin comments produced by a contract review tool. The tool emits an "external_comment" field intended to appear as a margin comment in the marked-up contract. The user's expectation: these comments should read as something opposing counsel could see without revision — professional, factual, and either position-neutral or clearly position-stated.

For each comment, classify into ONE bucket:

CUSTOMER-FACING — Reads as something an attorney could send to opposing counsel without revision. Professional, factual, position-neutral or clearly position-stated. Uses third-party voice or neutral redline style.

INTERNAL — Reads as internal counsel notes. References client preferences in first person ("we want," "our position is"), or directs internal action ("push back on," "negotiate to," "Counsel should..."). Would need editing before sending externally.

PROBLEMATIC — Contains language the user wouldn't want sent externally. Speculation about opposing counsel's motives, strategic statements, language that would weaken the user's position if seen, references to leverage or deal pressure, naming the buyer's BATNA, etc.

Output ONLY a JSON object: { "classification": "CUSTOMER-FACING"|"INTERNAL"|"PROBLEMATIC", "reason": "<one short sentence>" }`;

async function classify(comment) {
  const userMessage = `EXTERNAL_COMMENT (verbatim):\n\n${comment}\n\nClassify and emit JSON.`;
  try {
    const resp = await callModel({
      agentName: 'external-comment-auditor',
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      userId: 'auditor',
      maxTokens: 200,
    });
    const parsed = extractJson(resp.text);
    return { classification: parsed?.classification || 'UNKNOWN', reason: parsed?.reason || '' };
  } catch (e) {
    return { classification: 'ERROR', reason: e.message };
  }
}

// Collect all findings from Round 1 graded runs
const dir = 'tools/contract-grader/runs';
const findings = [];
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.graded.json')).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const finding of r.accepted_findings || []) {
    if (!finding.external_comment) continue;
    findings.push({
      run: f.replace('.graded.json', ''),
      id: finding.id,
      specialist: finding.specialist || '',
      severity: finding.severity || '',
      category: finding.category || '',
      external_comment: finding.external_comment,
    });
  }
}
console.log(`Total external_comments to classify: ${findings.length}`);

// Classify in batches of 8 to manage rate limits
const results = [];
const BATCH = 8;
for (let i = 0; i < findings.length; i += BATCH) {
  const batch = findings.slice(i, i + BATCH);
  const classifications = await Promise.all(batch.map(async (f, j) => {
    const c = await classify(f.external_comment);
    return { ...f, ...c };
  }));
  results.push(...classifications);
  console.log(`  ${Math.min(i + BATCH, findings.length)} / ${findings.length} classified`);
}

const dist = { 'CUSTOMER-FACING': 0, INTERNAL: 0, PROBLEMATIC: 0, UNKNOWN: 0, ERROR: 0 };
for (const r of results) dist[r.classification] = (dist[r.classification] || 0) + 1;
console.log('\nDistribution:', dist);

// By specialist
const bySpecialist = {};
for (const r of results) {
  if (!bySpecialist[r.specialist]) bySpecialist[r.specialist] = { 'CUSTOMER-FACING': 0, INTERNAL: 0, PROBLEMATIC: 0, UNKNOWN: 0, ERROR: 0, total: 0 };
  bySpecialist[r.specialist][r.classification]++;
  bySpecialist[r.specialist].total++;
}
console.log('\nBy specialist:');
for (const k of Object.keys(bySpecialist).sort()) {
  const d = bySpecialist[k];
  console.log(`  ${k}: total=${d.total} CF=${d['CUSTOMER-FACING']} INT=${d.INTERNAL} PROB=${d.PROBLEMATIC}`);
}

const out = {
  total: findings.length,
  distribution: dist,
  by_specialist: bySpecialist,
  classifications: results,
};
fs.writeFileSync('tools/contract-grader/round-3.5-runs/external_comment_audit.json', JSON.stringify(out, null, 2));
console.log('\nWrote tools/contract-grader/round-3.5-runs/external_comment_audit.json');
