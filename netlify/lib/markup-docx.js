/**
 * DOCX markup — JS port of scripts/markup_docx.py.
 *
 * Produces native Word tracked changes (<w:ins>, <w:del>) and real Word
 * comments (comments.xml + commentRangeStart/End + commentReference) so
 * the counterparty can Accept/Reject and reply in Word.
 *
 * Format-in-format-out rule (CLAUDE.md §4.4): we edit the DOCX in place —
 * the output is a byte-different .docx that opens and behaves identically
 * except for our additions.
 *
 * Where proposed replacement text goes (CLAUDE.md §4.5 for DOCX):
 *   - 'replace' → <w:del> on source_text + adjacent <w:ins> with suggested_text
 *   - 'insert'  → <w:ins> with suggested_text anchored after anchor_text
 *   - 'delete'  → <w:del> on source_text (no insertion)
 *   - 'annotate'→ no text change; just a comment attached to source_text
 *
 * Comment body = external_comment ONLY. Never duplicate the replacement
 * text inside the comment — the counterparty sees it on the page face
 * via the tracked insertion.
 */
import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CONTENT_TYPES_PATH = '[Content_Types].xml';
const DOCUMENT_PATH = 'word/document.xml';
const COMMENTS_PATH = 'word/comments.xml';
const RELS_PATH = 'word/_rels/document.xml.rels';

const AUTHOR = 'Legal Overflow';
const INITIALS = 'LO';

const parserOpts = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
};

const builderOpts = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  format: false,
  suppressBooleanAttributes: false,
};

/**
 * Apply an array of finding objects to a DOCX buffer. Returns a new Buffer.
 *
 * @param {Buffer} docxBuffer — input DOCX bytes
 * @param {Array<Finding>} findings — findings from specialist fan-out
 * @returns {Promise<{ buffer: Buffer, applied: number, unanchored: Finding[] }>}
 */
export async function applyDocxMarkup(docxBuffer, findings) {
  const zip = await JSZip.loadAsync(docxBuffer);

  // Load document.xml as text and extract paragraphs for anchor matching.
  const documentXml = await zip.file(DOCUMENT_PATH).async('string');
  let modifiedXml = documentXml;

  // Load or create comments.xml
  const existingComments = zip.file(COMMENTS_PATH)
    ? await zip.file(COMMENTS_PATH).async('string')
    : null;

  let commentIdCounter = highestCommentId(existingComments) + 1;
  const commentsToAppend = [];
  const applied = [];
  const unanchored = [];

  // Walk findings; for each, try to locate anchor text in the body and
  // splice the tracked-change + comment markup in.
  for (const f of findings) {
    const { markup_type, source_text, suggested_text, anchor_text, external_comment } = f;

    const searchText = source_text || anchor_text || '';
    if (!searchText || searchText.length < 8) {
      unanchored.push(f);
      continue;
    }

    const location = locateText(modifiedXml, searchText);
    if (location == null) {
      unanchored.push(f);
      continue;
    }

    const cid = commentIdCounter++;
    const replacement = buildMarkupXml({
      markupType: markup_type,
      sourceText: source_text,
      suggestedText: suggested_text || '',
      commentId: cid,
      originalRunXml: location.runXml,
    });

    modifiedXml = modifiedXml.slice(0, location.start) + replacement + modifiedXml.slice(location.end);

    if (external_comment) {
      commentsToAppend.push({ id: cid, text: external_comment });
    }
    applied.push(f);
  }

  // Write comments.xml (merge with existing if present)
  if (commentsToAppend.length > 0) {
    const commentsXml = buildCommentsXml(existingComments, commentsToAppend);
    zip.file(COMMENTS_PATH, commentsXml);

    // Ensure [Content_Types].xml and relationships include comments
    await ensureCommentsContentType(zip);
    await ensureCommentsRelationship(zip);
  }

  zip.file(DOCUMENT_PATH, modifiedXml);
  const outBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return { buffer: outBuffer, applied: applied.length, unanchored };
}

// ---------- helpers ----------

/**
 * Locate a substring in the document XML by scanning <w:t> text content.
 * Returns the byte offset range covering the PARENT <w:r> run so we can
 * splice markup at the run boundary (preserves paragraph structure).
 *
 * Simple first-pass implementation: match character-exact source_text
 * across consecutive <w:t> runs within the same paragraph.
 */
function locateText(xml, needle) {
  // Strategy: build a parallel "plain text + offset map" over all <w:t>
  // content, find the needle in the plain text, then translate back to
  // XML offsets of the enclosing <w:r> run(s).
  const textRunRegex = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  const runs = [];
  let plain = '';
  let match;
  while ((match = textRunRegex.exec(xml)) !== null) {
    const runXml = match[0];
    const runStart = match.index;
    const runEnd = match.index + runXml.length;
    const textMatch = runXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/);
    const runText = textMatch ? decodeXml(textMatch[1]) : '';
    runs.push({ runStart, runEnd, runXml, plainOffset: plain.length, text: runText });
    plain += runText;
  }

  const needleNormalized = needle.replace(/\s+/g, ' ').trim();
  const plainNormalized = plain.replace(/\s+/g, ' ');
  const idx = plainNormalized.indexOf(needleNormalized);
  if (idx === -1) return null;

  // Find which run(s) the match starts/ends in using offset map (works on
  // original plain since whitespace compression only shortens; we use the
  // shortened index to locate the run by walking original offsets). Close
  // approximation: find first run whose plainOffset >= idx via shortened.
  // For markup simplicity we anchor to the first matching run and replace
  // its text wholesale when possible.
  let startRun = null;
  for (const r of runs) {
    const rNormalizedOffset = r.plainOffset - countCompressed(plain.slice(0, r.plainOffset));
    if (rNormalizedOffset <= idx && rNormalizedOffset + r.text.length >= idx) {
      startRun = r;
      break;
    }
  }
  if (!startRun) return null;
  return {
    start: startRun.runStart,
    end: startRun.runEnd,
    runXml: startRun.runXml,
    matchedText: needleNormalized,
  };
}

function countCompressed(s) {
  // How many chars were "lost" to whitespace normalization in `s`
  const orig = s.length;
  const norm = s.replace(/\s+/g, ' ').length;
  return orig - norm;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function encodeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildMarkupXml({ markupType, sourceText, suggestedText, commentId, originalRunXml }) {
  const ts = new Date().toISOString();
  const commentStart = `<w:commentRangeStart w:id="${commentId}"/>`;
  const commentEnd = `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:commentReference w:id="${commentId}"/></w:r>`;

  // Preserve the run's formatting properties (rPr) when we replace its content
  const rPrMatch = originalRunXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  const rPr = rPrMatch ? rPrMatch[0] : '';

  let body = '';
  if (markupType === 'replace') {
    body =
      `<w:del w:id="${commentId + 1000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:delText xml:space="preserve">${encodeXml(sourceText)}</w:delText></w:r></w:del>` +
      `<w:ins w:id="${commentId + 2000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(suggestedText)}</w:t></w:r></w:ins>`;
  } else if (markupType === 'delete') {
    body =
      `<w:del w:id="${commentId + 1000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:delText xml:space="preserve">${encodeXml(sourceText)}</w:delText></w:r></w:del>`;
  } else if (markupType === 'insert') {
    // Keep the original run (as anchor), then insert after it
    body =
      originalRunXml +
      `<w:ins w:id="${commentId + 2000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(suggestedText)}</w:t></w:r></w:ins>`;
    return commentStart + body + commentEnd;
  } else {
    // annotate: keep run, just wrap with comment markers
    body = originalRunXml;
  }

  return commentStart + body + commentEnd;
}

function highestCommentId(existingCommentsXml) {
  if (!existingCommentsXml) return 0;
  const matches = [...existingCommentsXml.matchAll(/w:id="(\d+)"/g)].map(m => parseInt(m[1], 10));
  return matches.length ? Math.max(...matches) : 0;
}

function buildCommentsXml(existingXml, newComments) {
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}">`;
  const footer = `</w:comments>`;
  const ts = new Date().toISOString();

  let existingBody = '';
  if (existingXml) {
    const inner = existingXml.match(/<w:comments[^>]*>([\s\S]*)<\/w:comments>/);
    if (inner) existingBody = inner[1];
  }

  const newBody = newComments
    .map(c =>
      `<w:comment w:id="${c.id}" w:author="${AUTHOR}" w:date="${ts}" w:initials="${INITIALS}">` +
      `<w:p><w:r><w:t xml:space="preserve">${encodeXml(c.text)}</w:t></w:r></w:p>` +
      `</w:comment>`
    )
    .join('');

  return header + existingBody + newBody + footer;
}

async function ensureCommentsContentType(zip) {
  const ctxFile = zip.file(CONTENT_TYPES_PATH);
  if (!ctxFile) return;
  let ctx = await ctxFile.async('string');
  if (ctx.includes('comments+xml')) return;
  const override = `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`;
  ctx = ctx.replace('</Types>', override + '</Types>');
  zip.file(CONTENT_TYPES_PATH, ctx);
}

async function ensureCommentsRelationship(zip) {
  const relsFile = zip.file(RELS_PATH);
  if (!relsFile) return;
  let rels = await relsFile.async('string');
  if (rels.includes('comments.xml')) return;
  const rId = nextRelId(rels);
  const newRel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`;
  rels = rels.replace('</Relationships>', newRel + '</Relationships>');
  zip.file(RELS_PATH, rels);
}

function nextRelId(relsXml) {
  const nums = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map(m => parseInt(m[1], 10));
  const max = nums.length ? Math.max(...nums) : 0;
  return `rId${max + 1}`;
}
