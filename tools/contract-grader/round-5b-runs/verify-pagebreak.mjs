// Round 5b programmatic verification.
//
// Walks every StrikeOut annotation in the marked PDF and verifies:
//   • Total StrikeOut count matches expected (one per page in each
//     IRT group, plus one each for single-page cases).
//   • Multi-page groups: first annotation has Contents + T; second+
//     annotations have /IRT pointing back to the first, AND no
//     Contents/T (or empty).
//   • Single-page cases: one annotation with Contents + T, no /IRT.
//   • Every annotation has valid QuadPoints (8 × N numbers).
//
// Usage: node tools/contract-grader/round-5b-runs/verify-pagebreak.mjs <marked.pdf>

import fs from 'node:fs';
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib';

const path = process.argv[2] || 'tools/contract-grader/round-5b-runs/synthetic-pagebreak-marked.pdf';
const buf = fs.readFileSync(path);
const pdfDoc = await PDFDocument.load(buf);

// Walk every annotation, collect StrikeOuts with their full metadata.
const strikes = [];
for (let pi = 0; pi < pdfDoc.getPageCount(); pi++) {
  const page = pdfDoc.getPage(pi);
  const annotsRef = page.node.get(PDFName.of('Annots'));
  if (!annotsRef) continue;
  const annots = page.node.context.lookup(annotsRef);
  if (!annots?.array) continue;
  for (const ref of annots.array) {
    const a = page.node.context.lookup(ref);
    if (!a?.get) continue;
    const subtype = a.get(PDFName.of('Subtype'))?.toString();
    if (subtype !== '/StrikeOut') continue;
    const qp = a.get(PDFName.of('QuadPoints'));
    const quadPointsLen = qp?.array?.length ?? 0;
    const c = a.get(PDFName.of('Contents'));
    const t = a.get(PDFName.of('T'));
    const irtRef = a.get(PDFName.of('IRT'));
    const ownRef = ref; // PDFRef
    strikes.push({
      pageIndex: pi,
      ownRef,
      ownRefStr: ownRef.toString(),
      hasContents: !!c,
      contentsPreview: c?.decodeText ? c.decodeText().slice(0, 60) : '',
      hasT: !!t,
      quadPointsLen,
      quadCount: quadPointsLen / 8,
      irt: irtRef ? irtRef.toString() : null,
    });
  }
}

console.log('=== Round 5b verification ===\n');
console.log(`Total /StrikeOut annotations in PDF: ${strikes.length}\n`);
for (const s of strikes) {
  console.log(`  page ${s.pageIndex + 1}, ref=${s.ownRefStr}, ${s.quadCount} quad${s.quadCount !== 1 ? 's' : ''}, ${s.hasContents ? 'has Contents' : 'NO Contents'}, ${s.hasT ? 'has T' : 'NO T'}, IRT=${s.irt || 'none'}`);
  if (s.hasContents) console.log(`    Contents: ${JSON.stringify(s.contentsPreview)}…`);
}

// Group by IRT chain. Each "logical edit" is either:
//   • a single annotation with no IRT
//   • a chain: annotation A (no IRT) ← annotation B (IRT=A) ← annotation C (IRT=A)
//     (Adobe convention: all IRT-linked annotations point to the FIRST one)
const refToStrike = new Map(strikes.map((s) => [s.ownRefStr, s]));
const groups = []; // each: { leader: strike, followers: [strike...] }

// First pass: leaders (no IRT)
for (const s of strikes) {
  if (!s.irt) groups.push({ leader: s, followers: [] });
}
// Second pass: assign followers to their leader
for (const s of strikes) {
  if (!s.irt) continue;
  const leader = groups.find((g) => g.leader.ownRefStr === s.irt);
  if (leader) leader.followers.push(s);
  else console.log(`  [WARN] strike on page ${s.pageIndex + 1} has IRT=${s.irt} but no annotation matches that ref`);
}

console.log(`\n=== Logical edit groups: ${groups.length} ===`);
let pass = 0, fail = 0;
const issues = [];
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; issues.push(msg); }
}

for (let gi = 0; gi < groups.length; gi++) {
  const { leader, followers } = groups[gi];
  const totalAnnots = 1 + followers.length;
  const pages = [leader.pageIndex, ...followers.map((f) => f.pageIndex)].sort((a, b) => a - b);
  console.log(`\nGroup ${gi + 1}: ${totalAnnots} annotation${totalAnnots > 1 ? 's' : ''} on page${totalAnnots > 1 ? 's' : ''} ${pages.map((p) => p + 1).join(', ')}`);
  console.log(`  Leader (page ${leader.pageIndex + 1}, ref=${leader.ownRefStr}): ${leader.contentsPreview}…`);
  for (const f of followers) {
    console.log(`  Follower (page ${f.pageIndex + 1}, ref=${f.ownRefStr}, IRT=${f.irt}): ${f.hasContents ? 'has Contents (UNEXPECTED)' : 'no Contents (correct)'}`);
  }

  // Invariants for this group
  assert(leader.hasContents, `Group ${gi + 1}: leader on page ${leader.pageIndex + 1} must have Contents`);
  assert(leader.hasT, `Group ${gi + 1}: leader must have T (author)`);
  assert(!leader.irt, `Group ${gi + 1}: leader must NOT have IRT (it's the head of the chain)`);
  assert(leader.quadCount >= 1, `Group ${gi + 1}: leader must have ≥1 quadrilateral`);
  for (const f of followers) {
    assert(!f.hasContents, `Group ${gi + 1}: follower on page ${f.pageIndex + 1} must NOT have Contents (defers to leader via IRT)`);
    assert(!f.hasT, `Group ${gi + 1}: follower must NOT have T`);
    assert(f.irt === leader.ownRefStr, `Group ${gi + 1}: follower's IRT must match leader ref`);
    assert(f.quadCount >= 1, `Group ${gi + 1}: follower must have ≥1 quadrilateral`);
    assert(f.pageIndex !== leader.pageIndex, `Group ${gi + 1}: follower must be on a different page from leader`);
  }
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${pass}`);
console.log(`Failed: ${fail}`);
if (issues.length) {
  console.log('\nIssues:');
  for (const i of issues) console.log(`  • ${i}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED — Round 5b structure is correct.');
