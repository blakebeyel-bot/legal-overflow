/**
 * Citation Verifier — Pass 1 DOCX extractor.
 *
 * Produces:
 *   { text, format: 'docx', footnotes, candidates }
 *
 * Where:
 *   - `text` is the canonical body text (no footnote bodies inlined)
 *   - `footnotes` is an array of { num, text } pulled from word/footnotes.xml
 *   - `candidates` is the union of body candidates + footnote candidates,
 *     each annotated with `in_footnote` and (if applicable) `footnote_num`.
 *
 * Why we read footnotes.xml directly
 * ----------------------------------
 * mammoth.extractRawText() returns body text only — footnotes are not in
 * the result. Citations live in footnotes more often than not in legal
 * writing, so a citation verifier that ignores them is useless. We use
 * jszip (already in the dep tree) to crack the docx open and read
 * word/footnotes.xml directly. The XML schema is well-documented; we
 * only need the visible <w:t> content per footnote.
 *
 * Format-in-format-out (CLAUDE.md §4.4): we DO NOT modify the docx here.
 * markup-docx-citations (Pass 5b) does that downstream with the original
 * bytes still in hand.
 */

import mammoth from 'mammoth';
import JSZip from 'jszip';
import { findCitationCandidates, dropContainedDuplicates } from './citation-patterns.js';

const FOOTNOTES_PATH = 'word/footnotes.xml';

// Mammoth's "preserveSeparator" hint: it inserts \n between paragraphs in
// raw-text mode by default, which is what we want for citation matching
// (case-name reach-back stops at sentence boundaries).
const MAMMOTH_OPTS = { /* defaults */ };

/**
 * Extract DOCX body text + footnotes + citation candidates.
 *
 * @param {Buffer} buffer
 * @returns {Promise<ExtractDocxResult>}
 */
export async function extractDocxForCitations(buffer) {
  // 1. Body text via mammoth (battle-tested in this codebase).
  const bodyResult = await mammoth.extractRawText({ buffer }, MAMMOTH_OPTS);
  const bodyText = (bodyResult.value || '').trim();
  if (bodyText.length < 50) {
    throw new Error('DOCX body contains almost no extractable text — file may be corrupt.');
  }

  // 2. Footnotes via direct XML read. Missing footnotes.xml is not an
  //    error — many briefs have no footnotes.
  const footnotes = await extractFootnotes(buffer);

  // 3. Candidate scan over body.
  const bodyCandidates = findCitationCandidates(bodyText).map((c) => ({
    ...c,
    in_footnote: false,
    footnote_num: null,
    page_number: null, // PDFs only
  }));

  // 4. Candidate scan over each footnote separately, so char_start /
  //    char_end remain meaningful inside that footnote (we don't merge
  //    footnote text into the body — a citation's offsets must point
  //    back to the right XML element later).
  const footnoteCandidates = [];
  for (const fn of footnotes) {
    const fnCands = findCitationCandidates(fn.text);
    for (const c of fnCands) {
      footnoteCandidates.push({
        ...c,
        in_footnote: true,
        footnote_num: fn.num,
        page_number: null,
      });
    }
  }

  const allCandidates = dropContainedDuplicates([
    ...bodyCandidates,
    ...footnoteCandidates,
  ]);

  return {
    text: bodyText,
    format: 'docx',
    footnotes,
    candidates: allCandidates,
  };
}

/**
 * Pull plain text out of word/footnotes.xml. Returns one entry per
 * footnote, in the order they appear in the XML.
 *
 * Footnote IDs 0 and 1 are reserved by Word for separator/continuation
 * separator and are skipped.
 */
async function extractFootnotes(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    // If the docx can't even be opened as a zip we'll have failed in
    // mammoth already; defensive.
    return [];
  }
  const file = zip.file(FOOTNOTES_PATH);
  if (!file) return [];

  const xml = await file.async('string');
  return parseFootnotesXml(xml);
}

/**
 * Tiny purpose-built parser for word/footnotes.xml. We don't need the full
 * fast-xml-parser pipeline; a regex over the visible text content is
 * adequate (and matches what mammoth's body extraction produces — visible
 * text only, no formatting marks).
 *
 * Each <w:footnote> may contain many <w:t>...</w:t> runs; we concatenate
 * them with a single space and then collapse runs of whitespace.
 *
 * Word reserves footnote IDs 0 ("separator") and 1 ("continuationSeparator")
 * by `w:type` attribute. We skip any footnote with a w:type attribute set.
 */
export function parseFootnotesXml(xml) {
  const result = [];
  // Match each <w:footnote ... > ... </w:footnote> block.
  const footnoteRegex = /<w:footnote\b([^>]*)>([\s\S]*?)<\/w:footnote>/g;
  let m;
  while ((m = footnoteRegex.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';

    // Skip Word's built-in separator entries.
    if (/\bw:type\s*=/.test(attrs)) continue;

    // Pull the w:id="...".
    const idMatch = attrs.match(/\bw:id\s*=\s*"(-?\d+)"/);
    if (!idMatch) continue;
    const num = parseInt(idMatch[1], 10);

    // Concatenate every <w:t>...</w:t> inside.
    const textRuns = [];
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let t;
    while ((t = tRegex.exec(inner)) !== null) {
      textRuns.push(decodeXmlEntities(t[1]));
    }
    const text = textRuns.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;

    result.push({ num, text });
  }
  return result;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // amp last — must be last so we don't double-decode
}
