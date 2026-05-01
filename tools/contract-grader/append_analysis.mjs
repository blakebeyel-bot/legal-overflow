// Append narrative analysis to REPORT_round_1.md.
import fs from 'node:fs';
import path from 'node:path';

const dir = 'tools/contract-grader/runs';
const REPORT = 'tools/contract-grader/REPORT_round_1.md';

function load(label) {
  const p = path.join(dir, `${label}.graded.json`);
  if (!fs.existsSync(p)) {
    const f2 = path.join(dir, `${label}.json`);
    if (fs.existsSync(f2)) return JSON.parse(fs.readFileSync(f2, 'utf8'));
    return null;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const runs = {};
for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
  runs[i] = load(`run-${String(i).padStart(2, '0')}`);
}
runs['02-pdf'] = load('run-02-pdf');
runs['06-pdf'] = load('run-06-pdf');

function dist(run) {
  if (!run) return null;
  const d = { MECHANICAL: 0, GENERIC: 0, CONTEXTUAL: 0, EXEMPLARY: 0, UNKNOWN: 0, ERROR: 0 };
  for (const f of run.accepted_findings) d[f._rationale_quality || 'UNKNOWN']++;
  return { total: run.accepted_findings.length, ...d };
}

const lines = [];
const push = (s) => lines.push(s);

push('');
push('---');
push('');
push('## Analysis & Interpretation');
push('');
push('### TL;DR');
push('');
push('1. **The tool is NOT a mechanical playbook enforcer.** Across 12 .docx scenarios and 254 graded findings, only 5 (~2%) were classified MECHANICAL. The dominant rationale quality is CONTEXTUAL.');
push('2. **Reasoning quality varies meaningfully across deal posture and profile presence — but not always in the direction the hypothesis predicted.**');
push('3. **Profile presence increases finding count and produces some MECHANICAL emissions that disappear when the profile is empty.** A few rationales when a profile is provided do read like rote playbook citations.');
push('4. **The biggest single finding from this round is structural: PDF input substantially degrades reasoning quality even though the underlying word content is identical to DOCX.**');
push('');

push('### Aggregate quality across all 12 .docx runs');
push('');
const agg = { MECHANICAL: 0, GENERIC: 0, CONTEXTUAL: 0, EXEMPLARY: 0, UNKNOWN: 0, ERROR: 0, total: 0 };
for (let i = 1; i <= 12; i++) {
  const d = dist(runs[i]);
  if (!d) continue;
  for (const k of Object.keys(d)) agg[k] += d[k];
}
push(`Total findings graded: ${agg.total}`);
push('');
push('| Quality | Count | % |');
push('|---|---|---|');
for (const k of ['MECHANICAL', 'GENERIC', 'CONTEXTUAL', 'EXEMPLARY', 'UNKNOWN', 'ERROR']) {
  push(`| ${k} | ${agg[k]} | ${((agg[k] / agg.total) * 100).toFixed(1)}% |`);
}
push('');
push('CONTEXTUAL is dominant. EXEMPLARY appears in a small minority but is not absent. MECHANICAL is rare. The aggregate signal is consistent with reasoning, not automation.');
push('');

push('### Posture differential (Section B interpretation)');
push('');
push('Hypothesis: `their_paper_high_leverage` (HL) should produce FEWER findings than `their_paper_low_leverage` (LL) — when the buyer needs the deal, picking battles is leverage-expensive.');
push('');
const r1 = dist(runs[1]); const r2 = dist(runs[2]); const r3 = dist(runs[3]); const r4 = dist(runs[4]);
push(`- run-01 (our_paper):           ${r1.total} findings, EXEMPLARY ${r1.EXEMPLARY}, MECHANICAL ${r1.MECHANICAL}`);
push(`- run-02 (their_paper_HL):      ${r2.total} findings, EXEMPLARY ${r2.EXEMPLARY}, MECHANICAL ${r2.MECHANICAL}`);
push(`- run-03 (their_paper_LL):      ${r3.total} findings, EXEMPLARY ${r3.EXEMPLARY}, MECHANICAL ${r3.MECHANICAL}`);
push(`- run-04 (negotiated_draft):    ${r4.total} findings, EXEMPLARY ${r4.EXEMPLARY}, MECHANICAL ${r4.MECHANICAL}`);
push('');
push('**Result on count:** HL produced **MORE** findings than LL (24 vs 20). This is the opposite of the leverage-economic prediction. Two interpretations:');
push('');
push('1. The specialists do not actually constrict scope on HL — they continue to fire on profile-covered topics regardless of leverage. The "Deal posture sensitivity" sections in each specialist .md acknowledge HL but the model may not be operationalizing them.');
push('2. The compiler / proportionality prune is not actively suppressing lower-stakes findings on HL — i.e., the gate exists in the prompts but doesn\'t produce a tighter output set.');
push('');
push('**Result on quality:** HL produced more EXEMPLARY findings (5 vs 0). The rationales DO get more deal-aware on HL, even though the count doesn\'t drop. So the leverage signal is reaching the model partially: it changes what the model says about each finding, but not how many it emits.');
push('');
push('**Categories appearing in ALL 4 postures (profile_buyer):** these are findings the tool emits regardless of posture — strong candidates for "mechanical" enforcement. The Section B table above lists these.');
push('');
push('**Categories appearing in only 1-2 postures:** these are posture-sensitive findings — the tool is making different decisions about whether to raise. These show that posture does affect SOMETHING, even if the aggregate count doesn\'t shift the way the hypothesis predicted.');
push('');

push('### Profile differential (Section C interpretation)');
push('');
push('Comparing run-02 (profile_buyer × HL) vs run-06 (profile_empty × HL):');
push('');
const r02 = dist(runs[2]); const r06 = dist(runs[6]);
push(`- With buyer profile: ${r02.total} findings, ${r02.MECHANICAL} mechanical, ${r02.EXEMPLARY} exemplary`);
push(`- With empty profile: ${r06.total} findings, ${r06.MECHANICAL} mechanical, ${r06.EXEMPLARY} exemplary`);
push('');
push('**Findings:**');
push('');
push('1. With profile, total findings rise (+50%). Tier-1 findings are 13 with profile, 2 without — the profile is doing exactly what it should: surfacing the user\'s stated positions.');
push('2. **MECHANICAL appears (0 → 2) when the profile is provided.** This is the failure signal the user worried about. With no profile, the tool reasons from legal knowledge alone and never emits mechanical rationales. With a profile, two findings drift into "playbook says X, contract has Y, change to X" territory.');
push('3. **EXEMPLARY also rises (1 → 5)** with a profile. So a profile is not pure noise: it raises both the floor of mechanicalism AND the ceiling of partner-level reasoning. The middle (CONTEXTUAL) shrinks slightly.');
push('4. The tool produces DIFFERENT findings entirely when the profile is empty — see the Section C category lists. With no playbook to anchor on, the empty-profile run picks up several risk-allocation issues (gross-negligence-misconduct-unlimited-exposure, ip-indemnity-remedy-hierarchy, dispute-resolution, post-termination-insurance-survival) that the profile run misses.');
push('');

push('### Playbook equivalence (Section D interpretation)');
push('');
push('Comparing profile (runs 1-4) vs playbook (runs 9-12) paths at each posture:');
push('');
push('| Posture | Profile total | Playbook total | Δ | Profile EXEMPLARY | Playbook EXEMPLARY |');
push('|---|---|---|---|---|---|');
for (const [pl, pb] of [[1,9], [2,10], [3,11], [4,12]]) {
  const a = dist(runs[pl]); const b = dist(runs[pb]);
  if (!a || !b) continue;
  const lab = ['our_paper','their_paper_HL','their_paper_LL','negotiated_draft'][[1,9].indexOf(pl) >= 0 ? 0 : [2,10].indexOf(pl) >= 0 ? 1 : [3,11].indexOf(pl) >= 0 ? 2 : 3];
  push(`| ${lab} | ${a.total} | ${b.total} | ${b.total - a.total} | ${a.EXEMPLARY} | ${b.EXEMPLARY} |`);
}
push('');
push('**Findings:**');
push('');
push('1. Playbook path consistently produces FEWER findings than profile path at every posture (Δ averaging -3.5).');
push('2. **The playbook path produces MORE EXEMPLARY findings overall** (3 + 5 + 2 + 1 = 11) than the profile path (0 + 5 + 0 + 0 = 5).');
push('3. Substantively, the findings target similar issues but the playbook path\'s rationales lean more toward partner-level reasoning. This may be because the LLM-derived profile loses the nuance and prose of the original playbook (the schema-fitter compresses positions into ~100-char strings), and the loss of nuance pushes the specialists toward more rote enforcement when reading the structured form.');
push('4. **This is a meaningful finding for tuning:** if user-uploaded playbook prose produces higher reasoning quality than the schema-fitted profile, then the playbook → profile conversion is a lossy step that degrades downstream review quality.');
push('');

push('### Automation-trap analysis (Section A interpretation)');
push('');
push('The tool fired on payment terms, liability cap, and auto-renewal in BOTH run-02 (profile + HL) AND run-10 (playbook + HL). On the leverage hypothesis, HL should suppress lower-stakes findings — but these all fired.');
push('');
push('**Run-02 — payment terms** fired as `payment_terms` with rationale referencing the Net-60 vs Net-30 deviation. Quality classification mostly CONTEXTUAL — the rationale engages with the gap and the buyer cycle. Not pure automation but not deal-leverage-aware either: there is no acknowledgement that pushing on Net-30 is leverage-expensive when the buyer needs the deal.');
push('');
push('**Run-02 — liability cap with carve-outs** fires multiple findings (liability_cap_carveout_data_breach, _gross_negligence, _carveouts_data_breach). These read as legitimate carve-out gaps even given the existing 12-month cap, AND the rationales are CONTEXTUAL/EXEMPLARY engaging with the dollar exposure. This is the strongest reasoning in the run.');
push('');
push('**Run-02 — auto-renewal** fires as `Auto-renewal with extended notice period` (60-day notice, profile prefers 30). Rationale is GENERIC — references general buyer-side concerns about evergreen rather than weighing whether the 60-day window meets a procurement cycle reliably enough to accept under leverage pressure.');
push('');
push('**Verdict on the automation-trap test:** The tool is mostly reasoning, but it does NOT suppress lower-stakes profile-covered findings under leverage pressure. The "Deal posture sensitivity" gate in specialist prompts is not producing a quantitative reduction in scope on HL. Tuning candidate: harden the HL gate, or redesign the proportionality prune in `review-compiler.md` to actually act on posture.');
push('');

push('### PDF parity addendum');
push('');
push('Re-ran run-02 (profile_buyer × HL) with .pdf input. The run-06-pdf retry hit API credit exhaustion before completing and is not available for parity comparison; only the run-02 pair has data.');
push('');
const r2pdf = dist(runs['02-pdf']);
if (r2pdf) {
  push(`- run-02 (DOCX): 24 findings · MECH 2 / GEN 5 / CTX 12 / EX 5`);
  push(`- run-02-pdf (PDF): 34 findings · MECH 2 / GEN 13 / CTX 19 / EX 0`);
  push('');
  push('**This is a substantial reasoning-quality degradation despite identical word content.** Three observations:');
  push('');
  push('1. PDF emits MORE findings (24 → 34, +42%) — the specialist sees the same words but produces different judgments about what to flag.');
  push('2. EXEMPLARY drops from 5 to 0. GENERIC rises from 5 to 13. CONTEXTUAL rises from 12 to 19 (proportional to total). The tail of partner-level reasoning is GONE in PDF.');
  push('3. MECHANICAL stays the same (2). So the "bad" tail isn\'t getting worse, but the "good" tail collapses.');
  push('');
  push('**Hypothesis:** the loss of paragraph structure in PDF extraction (75 paragraphs → 8) prevents the model from confidently reasoning about provision boundaries. When boundaries are unclear, the model defaults to safer, more generic rationale rather than partner-level engagement with how a specific provision interacts with the rest of the contract. The specific feature degraded — partner-level deal-aware reasoning — is exactly what depends on cross-provision navigation.');
  push('');
  push('**This is a finding worth surfacing to tuning before any reasoning-quality tuning round.** Investing in better PDF text extraction (e.g., preserving paragraph boundaries via pdfjs `getTextContent` ordering, or running pdfjs in a layout-preserving mode) would lift reasoning quality on PDF inputs without any prompt changes.');
}
if (!runs['06-pdf'] || runs['06-pdf'].accepted_findings.length === 0) {
  push('');
  push('**run-06-pdf could not be retried successfully** — the second sequential PDF retry hit API credit exhaustion mid-run and produced no findings. This pair is incomplete; recommend re-running on a refreshed key for completeness.');
}
push('');

push('### Recommended tuning priorities (from this round)');
push('');
push('1. **PDF input parity** (HIGH priority). Investigate paragraph-boundary preservation in `extract.js:65-91`. Reasoning quality dropped substantially on PDF input despite identical words. Likely root cause: pdfjs-dist `getTextContent` joined-with-space discards intra-page paragraph breaks. Fix: detect line breaks via `transform[5]` y-coordinate gaps and insert `\\n` between paragraphs. This is a deterministic fix, no prompt tuning needed.');
push('');
push('2. **HL leverage gate not operationalized** (MEDIUM-HIGH priority). The "Deal posture sensitivity" sections in specialist prompts mention `their_paper_high_leverage` but the resulting finding count doesn\'t drop relative to LL. Tuning: either harden each specialist\'s HL gate with explicit suppression rules, or make `review-compiler.md`\'s proportionality prune posture-aware.');
push('');
push('3. **Playbook → profile conversion is lossy** (MEDIUM priority). User-uploaded playbook prose produced higher reasoning quality (more EXEMPLARY) than the LLM-derived profile JSON. The schema-fitter at `upload-playbook.js:84-93` compresses positions into ~100-char strings, losing the nuance that pushes specialists toward partner-level reasoning. Tuning: either pass the playbook prose through to specialists alongside the structured profile, OR loosen the "under 1.5KB JSON" target to preserve more reasoning context.');
push('');
push('4. **Profile presence introduces 2% MECHANICAL findings.** Small but real. Look at the specific MECHANICAL rationales in run-02 and run-03 to identify which specialist / category produces them, and tune those specific prompts to demand reasoning rather than assertion.');
push('');
push('5. **Compiler dedupe across runs.** Categories like `coherence`, `auto-renewal mechanics`, `cure_period_asymmetry` appear under varying labels — `auto-renewal mechanics` vs `auto_renewal_notice_period` vs `Auto-renewal with extended notice period`. Free-form category strings make cross-run analysis brittle. Recommend formalizing category taxonomy.');
push('');

const existing = fs.readFileSync(REPORT, 'utf8');
fs.writeFileSync(REPORT, existing + lines.join('\n'));
console.log(`Appended ${lines.length} lines of analysis to ${REPORT}`);
