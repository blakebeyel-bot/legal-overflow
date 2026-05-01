// Build Round 1 report from graded runs.
// Reads tools/contract-grader/runs/run-*.graded.json and writes a
// structured Markdown report to tools/contract-grader/REPORT_round_1.md.
import fs from 'node:fs';
import path from 'node:path';

const RUNS_DIR = 'tools/contract-grader/runs';
const OUT = 'tools/contract-grader/REPORT_round_1.md';

function loadRun(label) {
  const p = path.join(RUNS_DIR, `${label}.graded.json`);
  if (!fs.existsSync(p)) {
    const fallback = path.join(RUNS_DIR, `${label}.json`);
    if (fs.existsSync(fallback)) return { ...JSON.parse(fs.readFileSync(fallback, 'utf8')), _ungraded: true };
    return null;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SCENARIOS = [
  { label: 'run-01', profile: 'profile_buyer_positions', posture: 'our_paper' },
  { label: 'run-02', profile: 'profile_buyer_positions', posture: 'their_paper_high_leverage' },
  { label: 'run-03', profile: 'profile_buyer_positions', posture: 'their_paper_low_leverage' },
  { label: 'run-04', profile: 'profile_buyer_positions', posture: 'negotiated_draft' },
  { label: 'run-05', profile: 'profile_empty', posture: 'our_paper' },
  { label: 'run-06', profile: 'profile_empty', posture: 'their_paper_high_leverage' },
  { label: 'run-07', profile: 'profile_empty', posture: 'their_paper_low_leverage' },
  { label: 'run-08', profile: 'profile_empty', posture: 'negotiated_draft' },
  { label: 'run-09', profile: 'playbook_buyer_positions', posture: 'our_paper' },
  { label: 'run-10', profile: 'playbook_buyer_positions', posture: 'their_paper_high_leverage' },
  { label: 'run-11', profile: 'playbook_buyer_positions', posture: 'their_paper_low_leverage' },
  { label: 'run-12', profile: 'playbook_buyer_positions', posture: 'negotiated_draft' },
];

function severityDist(findings) {
  const d = { blocker: 0, major: 0, moderate: 0, minor: 0 };
  for (const f of findings) {
    const s = (f.severity || '').toLowerCase();
    if (d[s] !== undefined) d[s]++;
  }
  return d;
}
function tierDist(findings) {
  const d = { tier_1: 0, tier_2: 0 };
  for (const f of findings) {
    const t = f.tier ?? ((Array.isArray(f.profile_refs) && f.profile_refs.length > 0) ? 1 : 2);
    d[`tier_${t}`]++;
  }
  return d;
}
function qualityDist(findings) {
  const d = { MECHANICAL: 0, GENERIC: 0, CONTEXTUAL: 0, EXEMPLARY: 0, UNKNOWN: 0, ERROR: 0 };
  for (const f of findings) d[f._rationale_quality || 'UNKNOWN'] = (d[f._rationale_quality || 'UNKNOWN'] || 0) + 1;
  return d;
}

const out = [];
const push = (s) => out.push(s);

push('# Round 1 — Reasoning-Verification Report');
push('');
push(`Generated ${new Date().toISOString()}`);
push('');
push('## Architectural Confirmations');
push('');
push('Two parity questions were checked before running the matrix:');
push('');
push('| Confirmation | Status | Detail |');
push('|---|---|---|');
push('| **Specialist prompt parity** | CLEAN | No specialist .md branches on input format. All `format` references in `netlify/agents/*.md` are finding-ID format (e.g. `commercial-terms-analyst-NNN`) or data-export format. Zero references to `.docx` / `.pdf`. |');
push('| **Specialist input parity (words)** | CLEAN | Both formats yield identical word content (4436 words). Whitespace-normalized strings are byte-identical (29595 chars each). |');
push('| **Specialist input parity (structure)** | DIVERGES | DOCX preserves paragraph structure (75 `\\n\\n`-separated paragraphs). PDF flattens within-page structure (only 8 paragraphs — one per page) because `extract.js:80` joins pdfjs `getTextContent()` items with single space and only inserts `\\n\\n` between pages. |');
push('');
push('**Implication:** specialists see the same words but a different paragraph rhythm. Reasoning should be substantively similar (because content is identical), but `replace`/`delete` source_text quoting may have subtly different boundaries. Markup application (separate concern) is amplified — `markup-pdf.js` does fuzzy-locate, no paragraph IDs to anchor to.');
push('');

push('## Test materials');
push('');
push('| Artifact | Path |');
push('|---|---|');
push('| Test contract DOCX (4436 words) | `tools/contract-grader/test_contracts/msa_reasoning_test.docx` |');
push('| Test contract PDF (born-digital, 8 pages) | `tools/contract-grader/test_contracts/msa_reasoning_test.pdf` |');
push('| Buyer profile JSON | `tools/contract-grader/test_profiles/profile_buyer_positions.json` |');
push('| Empty / DEFAULT_PROFILE-equivalent | `tools/contract-grader/test_profiles/profile_empty.json` |');
push('| Buyer playbook prose DOCX | `tools/contract-grader/test_profiles/playbook_buyer_positions.docx` |');
push('| Pipeline harness | `tools/contract-grader/harness.mjs` |');
push('| Rationale grader (LLM judge) | `tools/contract-grader/grade_rationales.mjs` |');
push('');
push('Pipeline mode: `standard` (6 specialists + auditor + compiler + posture-integrity + coherence-checker). The buyer profile auto-enables `industry-saas-analyst` via the SaaS industry regex, so 7 specialists ran for runs 1-4 and 9-12; 6 ran for runs 5-8 (empty profile, no industry).');
push('');

push('## Per-run summaries');
push('');
push('Each run is presented in the format the spec requested. Findings are listed in their compiler-ordered sequence with full materiality_rationale text.');
push('');

for (const s of SCENARIOS) {
  const r = loadRun(s.label);
  if (!r) {
    push(`### ${s.label}`);
    push(`*(run output missing)*`);
    push('');
    continue;
  }
  const sev = severityDist(r.accepted_findings);
  const tier = tierDist(r.accepted_findings);
  const qual = qualityDist(r.accepted_findings);
  push(`### ${s.label} — profile: \`${s.profile}\`, posture: \`${s.posture}\``);
  push('');
  push('```');
  push(`run: ${s.label}`);
  push(`profile: ${s.profile}`);
  push(`deal_posture: ${s.posture}`);
  push(`total_findings: ${r.accepted_findings.length}`);
  push(`severity_distribution: ${JSON.stringify(sev)}`);
  push(`tier_distribution: ${JSON.stringify(tier)}`);
  push(`rationale_quality_distribution: ${JSON.stringify(qual)}`);
  push(`specialist_failures: ${r.specialist_failures?.length || 0}${r.specialist_failures?.length ? ' (' + r.specialist_failures.map(f=>f.specialist).join(', ') + ')' : ''}`);
  push(`tokens_used: ${r.tokens_used}`);
  push(`elapsed_seconds: ${r.elapsed_seconds}`);
  push('```');
  push('');
  push('**Findings:**');
  push('');
  for (const f of r.accepted_findings) {
    const tierVal = f.tier ?? ((Array.isArray(f.profile_refs) && f.profile_refs.length > 0) ? 1 : 2);
    push(`- **\`${f.id}\`** · ${f.severity || '?'} · tier ${tierVal} · category: \`${f.category || '?'}\``);
    if (f._rationale_quality) push(`  - **rationale_quality:** ${f._rationale_quality}`);
    if (f.source_text) push(`  - source_text: ${JSON.stringify(f.source_text).slice(0, 240)}`);
    push(`  - **materiality_rationale (verbatim):** ${f.materiality_rationale}`);
    push('');
  }
  push('---');
  push('');
}

// =================== Section A — Automation-Trap Analysis ===================
push('## Section A — Automation-Trap Analysis');
push('');
push('Runs 2 and 10 are the most diagnostic: profile/playbook with `their_paper_high_leverage` (the buyer needs the deal). A reasoning tool should recognize that pushing on every playbook deviation is leverage-expensive in this posture and may legitimately stay silent on lower-stakes deviations. An automated tool will fire on every playbook deviation regardless.');
push('');
push('Profile-covered topics in this contract: payment terms, late fees, liability cap, indemnification, auto-renewal, cure-period symmetry, subcontracting, dispute-resolution venue, data-security floors, insurance, IP/customer outputs, confidentiality tail.');
push('');
for (const label of ['run-02', 'run-10']) {
  const r = loadRun(label);
  if (!r) { push(`### ${label} — missing`); continue; }
  push(`### ${label}`);
  push('');
  // Identify findings touching profile-covered topics
  const profileTopicRe = /payment|net-?\d|late fee|liability|cap|indemn|renew|cure|subcontract|venue|arbitration|dispute|breach.notif|SOC|insurance|cyber|E&O|GL|IP|outputs|confidential/i;
  const relevant = r.accepted_findings.filter((f) =>
    profileTopicRe.test((f.category || '') + ' ' + (f.materiality_rationale || '') + ' ' + (f.source_text || ''))
  );
  push(`Findings touching profile-covered topics: ${relevant.length} of ${r.accepted_findings.length} total.`);
  push('');
  for (const f of relevant) {
    push(`**\`${f.id}\`** · ${f.severity} · category \`${f.category || '?'}\`${f._rationale_quality ? ' · ' + f._rationale_quality : ''}`);
    push(`> ${(f.materiality_rationale || '').replace(/\n/g, '\n> ')}`);
    push('');
  }
  push('---');
  push('');
}

// =================== Section B — Deal-Posture Differential ===================
push('## Section B — Deal-Posture Differential (profile_buyer_positions)');
push('');
const postureRuns = ['run-01', 'run-02', 'run-03', 'run-04'].map(loadRun).filter(Boolean);
if (postureRuns.length === 4) {
  push('| Posture | Total | Blocker | Major | Moderate | Minor | Tier-1 | Tier-2 | MECH | GEN | CTX | EX |');
  push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of postureRuns) {
    const sev = severityDist(r.accepted_findings);
    const tier = tierDist(r.accepted_findings);
    const qual = qualityDist(r.accepted_findings);
    push(`| ${r.deal_posture} | ${r.accepted_findings.length} | ${sev.blocker} | ${sev.major} | ${sev.moderate} | ${sev.minor} | ${tier.tier_1} | ${tier.tier_2} | ${qual.MECHANICAL} | ${qual.GENERIC} | ${qual.CONTEXTUAL} | ${qual.EXEMPLARY} |`);
  }
  push('');
  // Categories appearing in all 4 vs only some
  const catSets = postureRuns.map(r => new Set(r.accepted_findings.map(f => f.category)));
  const allCats = new Set([...catSets[0], ...catSets[1], ...catSets[2], ...catSets[3]]);
  const inAll = [...allCats].filter(c => catSets.every(s => s.has(c)));
  const inSome = [...allCats].filter(c => !catSets.every(s => s.has(c)));
  push(`Categories appearing in all 4 postures: ${inAll.length}`);
  push(`Categories appearing in only some: ${inSome.length}`);
  push('');
  push('**Categories in ALL postures:**');
  push(inAll.map(c => '`' + c + '`').join(', ') || '(none)');
  push('');
  push('**Categories in only SOME postures:**');
  push('');
  push('| Category | run-01 (our) | run-02 (their_HL) | run-03 (their_LL) | run-04 (negotiated) |');
  push('|---|---|---|---|---|');
  for (const c of inSome) {
    const flags = postureRuns.map(r => catSets[postureRuns.indexOf(r)].has(c) ? '✓' : '–');
    push(`| \`${c}\` | ${flags[0]} | ${flags[1]} | ${flags[2]} | ${flags[3]} |`);
  }
  push('');
}

// =================== Section C — Profile Differential ===================
push('## Section C — Profile Differential (their_paper_high_leverage)');
push('');
push('Comparing run-02 (profile_buyer_positions) vs run-06 (profile_empty), holding posture constant at `their_paper_high_leverage`.');
push('');
const r02 = loadRun('run-02');
const r06 = loadRun('run-06');
if (r02 && r06) {
  push('| Metric | run-02 (profile_buyer) | run-06 (profile_empty) |');
  push('|---|---|---|');
  push(`| Total findings | ${r02.accepted_findings.length} | ${r06.accepted_findings.length} |`);
  const s2 = severityDist(r02.accepted_findings); const s6 = severityDist(r06.accepted_findings);
  push(`| Severity | B${s2.blocker}/M${s2.major}/Mod${s2.moderate}/Min${s2.minor} | B${s6.blocker}/M${s6.major}/Mod${s6.moderate}/Min${s6.minor} |`);
  const t2 = tierDist(r02.accepted_findings); const t6 = tierDist(r06.accepted_findings);
  push(`| Tier 1 / Tier 2 | ${t2.tier_1}/${t2.tier_2} | ${t6.tier_1}/${t6.tier_2} |`);
  const q2 = qualityDist(r02.accepted_findings); const q6 = qualityDist(r06.accepted_findings);
  push(`| Mechanical / Generic / Contextual / Exemplary | ${q2.MECHANICAL}/${q2.GENERIC}/${q2.CONTEXTUAL}/${q2.EXEMPLARY} | ${q6.MECHANICAL}/${q6.GENERIC}/${q6.CONTEXTUAL}/${q6.EXEMPLARY} |`);
  push('');
  const cats2 = new Set(r02.accepted_findings.map(f => f.category));
  const cats6 = new Set(r06.accepted_findings.map(f => f.category));
  const onlyIn2 = [...cats2].filter(c => !cats6.has(c));
  const onlyIn6 = [...cats6].filter(c => !cats2.has(c));
  push(`Categories only in run-02 (with profile): ${onlyIn2.map(c=>'`'+c+'`').join(', ') || '(none)'}`);
  push('');
  push(`Categories only in run-06 (no profile): ${onlyIn6.map(c=>'`'+c+'`').join(', ') || '(none)'}`);
  push('');
}

// =================== Section D — Playbook Equivalence ===================
push('## Section D — Playbook Equivalence');
push('');
push('Comparing profile_buyer_positions runs (1-4) vs playbook_buyer_positions runs (9-12) at each posture.');
push('');
const pairs = [['run-01', 'run-09', 'our_paper'], ['run-02', 'run-10', 'their_paper_high_leverage'], ['run-03', 'run-11', 'their_paper_low_leverage'], ['run-04', 'run-12', 'negotiated_draft']];
push('| Posture | Profile total | Playbook total | Δ | Profile MECH/GEN/CTX/EX | Playbook MECH/GEN/CTX/EX |');
push('|---|---|---|---|---|---|');
for (const [pl, pb, posture] of pairs) {
  const a = loadRun(pl); const b = loadRun(pb);
  if (!a || !b) continue;
  const qa = qualityDist(a.accepted_findings); const qb = qualityDist(b.accepted_findings);
  push(`| ${posture} | ${a.accepted_findings.length} | ${b.accepted_findings.length} | ${b.accepted_findings.length - a.accepted_findings.length} | ${qa.MECHANICAL}/${qa.GENERIC}/${qa.CONTEXTUAL}/${qa.EXEMPLARY} | ${qb.MECHANICAL}/${qb.GENERIC}/${qb.CONTEXTUAL}/${qb.EXEMPLARY} |`);
}
push('');

// =================== PDF parity ===================
push('## PDF Parity Addendum');
push('');
push('Re-ran runs 2 and 6 with the .pdf version of the same contract.');
push('');
const pairs2 = [['run-02', 'run-02-pdf'], ['run-06', 'run-06-pdf']];
push('| Pair | DOCX findings | PDF findings | DOCX failures | PDF failures | DOCX MECH/GEN/CTX/EX | PDF MECH/GEN/CTX/EX |');
push('|---|---|---|---|---|---|---|');
for (const [d, p] of pairs2) {
  const a = loadRun(d); const b = loadRun(p);
  if (!a || !b) continue;
  const qa = qualityDist(a.accepted_findings); const qb = qualityDist(b.accepted_findings);
  push(`| ${d} vs ${p} | ${a.accepted_findings.length} | ${b.accepted_findings.length} | ${a.specialist_failures?.length || 0} | ${b.specialist_failures?.length || 0} | ${qa.MECHANICAL}/${qa.GENERIC}/${qa.CONTEXTUAL}/${qa.EXEMPLARY} | ${qb.MECHANICAL}/${qb.GENERIC}/${qb.CONTEXTUAL}/${qb.EXEMPLARY} |`);
}
push('');

fs.writeFileSync(OUT, out.join('\n'));
console.log(`Wrote ${OUT} (${out.length} lines)`);
