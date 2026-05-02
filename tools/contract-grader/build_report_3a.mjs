// Build Round 3a variance report.
import fs from 'node:fs';
import path from 'node:path';

const dir = 'tools/contract-grader/round-3a-runs';
const OUT = 'tools/contract-grader/REPORT_round_3a.md';

function load(label) {
  const p = path.join(dir, `${label}.graded.json`);
  if (!fs.existsSync(p)) {
    const fallback = path.join(dir, `${label}.json`);
    if (fs.existsSync(fallback)) return { ...JSON.parse(fs.readFileSync(fallback, 'utf8')), _ungraded: true };
    return null;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function dist(run) {
  if (!run) return null;
  const d = { MECHANICAL: 0, GENERIC: 0, CONTEXTUAL: 0, EXEMPLARY: 0, UNKNOWN: 0, ERROR: 0 };
  for (const f of run.accepted_findings) d[f._rationale_quality || 'UNKNOWN']++;
  return { total: run.accepted_findings.length, ...d };
}

const labels = ['r3a-docx-a', 'r3a-docx-b', 'r3a-pdf-a', 'r3a-pdf-b'];
const runs = labels.map(load);

// Reference data from prior rounds
const REF = {
  'docx-r1':     { total: 24, EXEMPLARY: 5, CONTEXTUAL: 12, GENERIC: 5,  MECHANICAL: 2, label: 'DOCX run-02 R1' },
  'pdf-pre-r1':  { total: 34, EXEMPLARY: 0, CONTEXTUAL: 19, GENERIC: 13, MECHANICAL: 2, label: 'PDF run-02 pre-fix R1' },
  'pdf-post-r2': { total: 18, EXEMPLARY: 1, CONTEXTUAL: 11, GENERIC: 5,  MECHANICAL: 1, label: 'PDF run-02 post-fix R2' },
};

const lines = [];
const push = (s) => lines.push(s);

push('# Round 3a — Variance Check on Round 2 PDF Extraction Fix');
push('');
push(`Generated ${new Date().toISOString()}`);
push('');
push('## Question being tested');
push('');
push('Round 2 produced clean directional improvements on every reasoning quality metric (MECHANICAL/GENERIC/CONTEXTUAL/EXEMPLARY all moved correctly), but EXEMPLARY came in at 1 — below the spec\'s ≥3 pass threshold. This round runs the same scenario four times (2 DOCX + 2 PDF post-fix) to determine whether the EXEMPLARY shortfall is sample variance against an outlier baseline (Round 1\'s DOCX run-02 had EXEMPLARY=5, the highest of 12 DOCX runs; median 0, mean 1.6) or a real residual format-induced reasoning loss.');
push('');
push('Scenario fixed for all four runs:');
push('');
push('- Profile: `profile_buyer_positions`');
push('- Posture: `their_paper_high_leverage`');
push('- Pipeline mode: `standard` (7 specialists with SaaS auto-enabled)');
push('- Code state: Round 2 codebase (PDF extraction fix in `extract.js`)');
push('');

push('## Run results');
push('');
push('| Run | Format | Total | MECH | GEN | CTX | EX | Tokens | Wall (s) |');
push('|---|---|---|---|---|---|---|---|---|');
for (let i = 0; i < runs.length; i++) {
  const r = runs[i];
  if (!r) { push(`| ${labels[i]} | — | (missing) |`); continue; }
  const d = dist(r);
  push(`| \`${labels[i]}\` | ${r.contract_format} | ${d.total} | ${d.MECHANICAL} | ${d.GENERIC} | ${d.CONTEXTUAL} | ${d.EXEMPLARY} | ${r.tokens_used} | ${r.elapsed_seconds} |`);
}
push('');
push('Reference data from prior rounds:');
push('');
push('| Run | Format | Total | MECH | GEN | CTX | EX |');
push('|---|---|---|---|---|---|---|');
for (const k of Object.keys(REF)) {
  const v = REF[k];
  push(`| ${v.label} | ${k.includes('docx') ? 'docx' : 'pdf'} | ${v.total} | ${v.MECHANICAL} | ${v.GENERIC} | ${v.CONTEXTUAL} | ${v.EXEMPLARY} |`);
}
push('');

// Variance analysis
function stat(values) {
  if (!values.length) return null;
  const mean = values.reduce((a,b)=>a+b,0) / values.length;
  const variance = values.reduce((a,b)=>a+(b-mean)*(b-mean),0) / values.length;
  const sd = Math.sqrt(variance);
  return { min: Math.min(...values), max: Math.max(...values), mean: mean.toFixed(2), sd: sd.toFixed(2), range: Math.max(...values) - Math.min(...values) };
}

const docxRuns = [runs[0], runs[1]].filter(Boolean);
const pdfRuns = [runs[2], runs[3]].filter(Boolean);
const docxR1 = REF['docx-r1'];
const pdfR2 = REF['pdf-post-r2'];

const docxExAll = [...docxRuns.map(r => dist(r).EXEMPLARY), docxR1.EXEMPLARY];
const pdfExAll = [...pdfRuns.map(r => dist(r).EXEMPLARY), pdfR2.EXEMPLARY];

push('## Variance analysis');
push('');
push('### DOCX EXEMPLARY across 3 runs (R3a runs A+B + R1 run-02)');
push('');
const docxExStats = stat(docxExAll);
if (docxExStats) {
  push(`- Values: ${docxExAll.join(', ')}`);
  push(`- Range: ${docxExStats.min}–${docxExStats.max} (spread ${docxExStats.range})`);
  push(`- Mean: ${docxExStats.mean}`);
  push(`- Standard deviation: ${docxExStats.sd}`);
}
push('');
push('### PDF post-fix EXEMPLARY across 3 runs (R3a runs A+B + R2 run-02-pdf)');
push('');
const pdfExStats = stat(pdfExAll);
if (pdfExStats) {
  push(`- Values: ${pdfExAll.join(', ')}`);
  push(`- Range: ${pdfExStats.min}–${pdfExStats.max} (spread ${pdfExStats.range})`);
  push(`- Mean: ${pdfExStats.mean}`);
  push(`- Standard deviation: ${pdfExStats.sd}`);
}
push('');

// Determination
push('## Determination');
push('');
const docxMean = docxExStats ? parseFloat(docxExStats.mean) : null;
const pdfMean = pdfExStats ? parseFloat(pdfExStats.mean) : null;
const docxAnyLowSample = docxExAll.some(v => v <= 2);
const pdfAllAtLeastOne = pdfExAll.every(v => v >= 1);
const meanGap = docxMean !== null && pdfMean !== null ? Math.abs(docxMean - pdfMean) : null;
const parityEstablished = docxMean !== null && pdfMean !== null && docxMean <= 2.5 && meanGap <= 1;

push('Per spec gates:');
push('');
push(`- **DOCX EXEMPLARY any value ≤ 2** (would indicate variance): ${docxAnyLowSample ? '✅ YES' : '❌ NO'}`);
push(`- **PDF post-fix EXEMPLARY ≥ 1 in all runs** (would indicate stability): ${pdfAllAtLeastOne ? '✅ YES' : '❌ NO'}`);
push(`- **DOCX mean ≤ 2.5 AND |DOCX mean − PDF mean| ≤ 1** (parity): ${parityEstablished ? '✅ YES' : '❌ NO'} (DOCX mean ${docxMean}, PDF mean ${pdfMean}, gap ${meanGap?.toFixed(2)})`);
push('');

// Determination logic
let verdict, recommendation;
if (parityEstablished || (docxAnyLowSample && pdfAllAtLeastOne)) {
  verdict = '**SHIP Round 2 as-is.**';
  recommendation = 'The Round 2 PDF extraction fix improves reasoning quality, and the EXEMPLARY=1 result on the original Round 2 run is consistent with within-format sample variance — DOCX itself produces EXEMPLARY counts in the same range across reruns of the identical scenario. The structural fix is a strict improvement and is safe to deploy.';
} else if (docxExStats && pdfExStats && docxExStats.min >= 4 && pdfExStats.max <= 1) {
  verdict = '**Real residual gap. Proceed to Round 3b (heading detection).**';
  recommendation = 'DOCX consistently produces EXEMPLARY ≥ 4 while PDF post-fix consistently caps at ≤ 1. This is not sample variance; the format itself is degrading reasoning quality even after the paragraph-extraction fix. Hypothesis 4 (heading detection / structural cues beyond paragraph breaks) is the highest-leverage candidate.';
} else if (docxExStats && docxExStats.range >= 4) {
  verdict = '**High variance on DOCX itself. Single-scenario testing is unreliable.**';
  recommendation = 'EXEMPLARY counts swing widely between reruns of the identical DOCX scenario, which means the metric is too noisy to grade a single PDF run against. Future rounds should test multiple scenarios (e.g., 5+ contracts) and grade on aggregate quality rather than per-run absolute counts.';
} else {
  verdict = '**Mixed signal. Recommend Round 3b conditional on user judgment.**';
  recommendation = 'The data does not cleanly support either the variance-only or the real-gap interpretation. Worth a closer human read of the rationales to compare DOCX-EXEMPLARY findings against PDF post-fix findings on the same provisions to decide whether the difference is structural or noise.';
}
push(verdict);
push('');
push(recommendation);
push('');

push('## Findings comparison (verbatim rationales)');
push('');
push('To support human judgment, here are the EXEMPLARY-classified findings from each run.');
push('');
for (let i = 0; i < runs.length; i++) {
  const r = runs[i];
  if (!r) continue;
  const exemplary = (r.accepted_findings || []).filter(f => f._rationale_quality === 'EXEMPLARY');
  push(`### ${labels[i]} — ${r.contract_format} — ${exemplary.length} EXEMPLARY finding(s)`);
  push('');
  if (!exemplary.length) push('_(no EXEMPLARY findings)_');
  for (const f of exemplary) {
    push(`**\`${f.id}\`** · ${f.severity} · category \`${f.category || '?'}\``);
    push('');
    push(`> ${(f.materiality_rationale || '').replace(/\n/g, '\n> ')}`);
    push('');
  }
  push('---');
  push('');
}

push('## Cost');
push('');
let totalTokens = 0;
for (const r of runs.filter(Boolean)) totalTokens += r.tokens_used || 0;
push(`Total tokens used (4 runs): ${totalTokens.toLocaleString()}`);
push(`Approximate cost: $${(totalTokens * 0.000003 + totalTokens * 0.000015).toFixed(2)} (rough Sonnet 4.5 estimate at 50/50 in/out split)`);
push('');

fs.writeFileSync(OUT, lines.join('\n'));
console.log(`Wrote ${OUT} (${lines.length} lines)`);
