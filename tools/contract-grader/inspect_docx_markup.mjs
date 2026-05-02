// Programmatically verify markup application on an annotated .docx.
// Pulls comments.xml and document.xml from the file, cross-references
// against the findings list, and reports per-finding markup status.
import fs from 'node:fs';
import JSZip from 'jszip';

const [, , markedDocx, findingsPath, unanchoredPath] = process.argv;
if (!markedDocx || !findingsPath) {
  console.error('Usage: node inspect_docx_markup.mjs <marked.docx> <findings.json> [unanchored.json]');
  process.exit(1);
}

const buf = fs.readFileSync(markedDocx);
const zip = await JSZip.loadAsync(buf);

// Load comments.xml
const commentsXml = await zip.file('word/comments.xml')?.async('string');
const documentXml = await zip.file('word/document.xml')?.async('string');
if (!documentXml) { console.error('No word/document.xml'); process.exit(1); }

// Parse comment entries
const comments = [];
if (commentsXml) {
  const commentRe = /<w:comment\s+w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:comment>/g;
  let m;
  while ((m = commentRe.exec(commentsXml)) !== null) {
    const body = m[2];
    const tParts = [];
    let t;
    const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    while ((t = tRe.exec(body)) !== null) tParts.push(t[1]);
    const text = tParts.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    comments.push({ id: m[1], text });
  }
}

// Count tracked-change markers
const delCount = (documentXml.match(/<w:del\b/g) || []).length;
const insCount = (documentXml.match(/<w:ins\b/g) || []).length;
const commentRangeCount = (documentXml.match(/<w:commentRangeStart\b/g) || []).length;

console.log('=== DOCX markup summary ===');
console.log(`File: ${markedDocx}`);
console.log(`File size: ${buf.length} bytes`);
console.log(`<w:del> markers: ${delCount}`);
console.log(`<w:ins> markers: ${insCount}`);
console.log(`<w:commentRangeStart> markers: ${commentRangeCount}`);
console.log(`Comments in comments.xml: ${comments.length}`);

// Cross-reference against findings
const run = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
const findings = run.accepted_findings || run.findings || [];
const unanchored = unanchoredPath && fs.existsSync(unanchoredPath)
  ? JSON.parse(fs.readFileSync(unanchoredPath, 'utf8')) : [];
const unanchoredIds = new Set(unanchored.map((u) => u.id).filter(Boolean));

console.log('\n=== Findings ===');
console.log(`Total: ${findings.length}`);
const types = {};
for (const f of findings) types[f.markup_type || '?'] = (types[f.markup_type || '?'] || 0) + 1;
console.log(`Markup types:`, types);
console.log(`Unanchored: ${unanchored.length}`);

// Per-finding verification
console.log('\n=== Per-finding ===');
const perFinding = [];
for (const f of findings) {
  const isUnanchored = unanchoredIds.has(f.id);
  const status = {
    id: f.id,
    markup_type: f.markup_type,
    severity: f.severity,
    specialist: f.specialist,
    source_in_doc: false,
    suggested_in_doc: false,
    has_comment: false,
    comment_text_match: false,
    unanchored: isUnanchored,
  };
  if (f.source_text) {
    // Source text presence — strip XML tags from document for fuzzy compare
    const docText = documentXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    status.source_in_doc = docText.includes(f.source_text.slice(0, 60));
  }
  if (f.suggested_text || f.proposed_text) {
    const sug = f.suggested_text || f.proposed_text;
    const docText = documentXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    status.suggested_in_doc = docText.includes(sug.slice(0, 60));
  }
  if (f.external_comment) {
    const matched = comments.find((c) => c.text.includes(f.external_comment.slice(0, 60)));
    status.has_comment = Boolean(matched);
    status.comment_text_match = Boolean(matched);
  }
  perFinding.push(status);
  const mark = isUnanchored ? 'UNANCHORED' : 'ok';
  console.log(`  [${f.id}] ${f.markup_type} ${f.severity} | source=${status.source_in_doc?'Y':'n'} sug=${status.suggested_in_doc?'Y':'n'} comm=${status.has_comment?'Y':'n'} ${mark}`);
}

// Summary
const correctly = perFinding.filter((p) => {
  if (p.unanchored) return false;
  if (p.markup_type === 'replace') return p.source_in_doc && p.suggested_in_doc && p.has_comment;
  if (p.markup_type === 'insert') return p.suggested_in_doc && p.has_comment;
  if (p.markup_type === 'delete') return p.source_in_doc && p.has_comment;
  if (p.markup_type === 'annotate') return p.source_in_doc && p.has_comment;
  return false;
}).length;

console.log('\n=== Summary ===');
console.log(`total_findings: ${findings.length}`);
console.log(`markup_type_breakdown:`, types);
console.log(`unanchored: ${unanchored.length}`);
console.log(`correctly_applied (heuristic): ${correctly}`);
console.log(`incorrectly_applied: ${findings.length - correctly - unanchored.length}`);

// Write detailed JSON for the report
const out = {
  file: markedDocx,
  total_findings: findings.length,
  markup_types: types,
  unanchored_count: unanchored.length,
  unanchored: unanchored.map((u) => ({ id: u.id, markup_type: u.markup_type, source_text_preview: (u.source_text || '').slice(0, 100) })),
  correctly_applied: correctly,
  per_finding: perFinding,
  comment_count: comments.length,
  del_marker_count: delCount,
  ins_marker_count: insCount,
};
const outPath = markedDocx.replace(/\.docx$/, '.inspection.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
