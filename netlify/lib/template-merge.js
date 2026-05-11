/**
 * Template merge — given a DOCX template, its variable schema, and a
 * map of values, produce a merged DOCX preserving the original
 * letterhead, fonts, margins, page numbering, and styling.
 *
 * Strategy:
 *   1. Open the .docx as a ZIP (it IS a zip — that's the format).
 *   2. For each text-bearing XML inside the archive (document.xml,
 *      headers, footers, footnotes, endnotes), do a text-run-aware
 *      replace of each var's placeholder_text with a docxtemplater
 *      delimiter form: `{key}`.
 *   3. Hand the now-merge-ready zip to docxtemplater and render with
 *      the supplied values.
 *
 * The text-run-aware replace handles the classic problem where a
 * single placeholder like "[CLIENT NAME]" is split across multiple
 * `<w:t>` elements because of mid-word formatting changes — we
 * concatenate text within a single `<w:p>` (paragraph), do the
 * replacement, and write the result back to the first run while
 * blanking the rest. This works for 95% of legal templates whose
 * placeholders sit in a single styled paragraph.
 *
 * Edge cases the simple approach DOESN'T handle:
 *   - Placeholders spanning multiple paragraphs (very rare in
 *     templates that mean to be filled)
 *   - Inline fields with deeply nested formatting (bold, italic,
 *     underline inside the placeholder text itself)
 *   - SmartArt or text boxes (not common in legal letterheads)
 *
 * If those break, the user can re-author the placeholder as a single
 * run before re-uploading.
 */

import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

const TEXT_BEARING_FILES = [
  'word/document.xml',
];
// Headers + footers may be numbered (header1.xml, header2.xml, ...)
// We discover them dynamically when iterating the zip.

/**
 * Pull the concatenated text-run content of a `<w:p>` paragraph as a
 * single string, paired with the array of `<w:t>...</w:t>` matches so
 * we can rewrite the runs after we've done the replacement.
 *
 * Returns: { text, runs: [{ openTag, closeTag, content, start, end }] }
 *   - runs[0..n-1].content is the inner text of each <w:t>
 *   - text is the concatenation
 *   - start/end are character offsets into `text` for each run
 */
function paragraphRuns(paraXml) {
  const runs = [];
  let text = '';
  // <w:t> can have attributes (xml:space="preserve"); allow them.
  const re = /<w:t(\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(paraXml)) !== null) {
    const inner = m[2] || '';
    runs.push({
      openTag: `<w:t${m[1] || ' xml:space="preserve"'}>`,
      closeTag: '</w:t>',
      content: inner,
      start: text.length,
      end: text.length + inner.length,
      matchIndex: m.index,
      matchLength: m[0].length,
    });
    text += inner;
  }
  return { text, runs };
}

/**
 * Replace placeholder strings inside a paragraph's XML with
 * docxtemplater delimiter form (`{key}`). Works at the
 * concatenated-text level so split runs aren't a problem.
 *
 * Replaces are case-insensitive for [BRACKETED CAPS] forms (because
 * legal templates often vary case) but case-sensitive for {{var}} /
 * <<var>> / _______ forms.
 *
 * Returns the rewritten paragraph XML.
 */
function rewriteParagraph(paraXml, vars) {
  const { text, runs } = paragraphRuns(paraXml);
  if (!runs.length || !text) return paraXml;

  let modified = false;
  let working = text;

  for (const v of vars) {
    if (!v.placeholder_text || !v.key) continue;
    const needle = v.placeholder_text;
    const repl = `{${v.key}}`;
    // Decide case sensitivity by needle shape:
    //   ALL_CAPS_OR_BRACKETED → case-insensitive
    //   anything else → case-sensitive
    const isCaseInsensitive = /^[\[<({][A-Z _\-/0-9]+[\]>)}]$/.test(needle)
      || /^[A-Z _\-/0-9]+$/.test(needle);
    if (isCaseInsensitive) {
      const escNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escNeedle, 'gi');
      if (re.test(working)) {
        working = working.replace(re, repl);
        modified = true;
      }
    } else {
      if (working.indexOf(needle) !== -1) {
        working = working.split(needle).join(repl);
        modified = true;
      }
    }
  }

  if (!modified) return paraXml;

  // Rebuild the paragraph: put the entire rewritten text into the
  // FIRST run and blank all subsequent runs. This collapses
  // formatting variation across the placeholder span, but for the
  // typical legal template the placeholder shares the same style as
  // its neighbors anyway.
  if (runs.length === 1) {
    const r = runs[0];
    return (
      paraXml.slice(0, r.matchIndex) +
      `<w:t xml:space="preserve">${escapeXmlText(working)}</w:t>` +
      paraXml.slice(r.matchIndex + r.matchLength)
    );
  }

  // Multi-run case: blank all runs, then put text in run 0.
  // Build the new paragraph by walking the runs back-to-front so
  // index offsets stay valid.
  let out = paraXml;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    const replacement = (i === 0)
      ? `<w:t xml:space="preserve">${escapeXmlText(working)}</w:t>`
      : '<w:t xml:space="preserve"></w:t>';
    out = out.slice(0, r.matchIndex) + replacement + out.slice(r.matchIndex + r.matchLength);
  }
  return out;
}

function escapeXmlText(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

/**
 * Walk every `<w:p>` in an XML document and run rewriteParagraph
 * on each. Returns the new XML.
 */
function normalizeXml(xml, vars) {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (para) => rewriteParagraph(para, vars));
}

/**
 * Normalize a DOCX buffer: replace each var's placeholder_text with
 * `{key}` form in every text-bearing XML file inside the archive.
 * Returns a new buffer with the same structure but merge-ready.
 */
export function normalizeTemplate({ docxBuffer, vars }) {
  const zip = new PizZip(docxBuffer);
  // Discover the text-bearing files: document.xml plus any
  // header*.xml / footer*.xml / footnotes.xml / endnotes.xml.
  //
  // PizZip exposes its archive as `zip.files` (object keyed by path),
  // NOT via a forEach method (JSZip has forEach, PizZip does not).
  // Iterate the keys directly.
  const filesToProcess = [];
  for (const relativePath of Object.keys(zip.files || {})) {
    if (TEXT_BEARING_FILES.includes(relativePath)) {
      filesToProcess.push(relativePath);
    } else if (/^word\/(header|footer)\d+\.xml$/.test(relativePath)) {
      filesToProcess.push(relativePath);
    } else if (relativePath === 'word/footnotes.xml' || relativePath === 'word/endnotes.xml') {
      filesToProcess.push(relativePath);
    }
  }

  for (const path of filesToProcess) {
    const file = zip.file(path);
    if (!file) continue;
    const xml = file.asText();
    const rewritten = normalizeXml(xml, vars);
    if (rewritten !== xml) {
      zip.file(path, rewritten);
    }
  }

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Main entry — merge a template with values.
 *
 * @param {object} opts
 * @param {Buffer} opts.docxBuffer  — original template .docx bytes
 * @param {Array}  opts.vars        — template_schema.vars array
 * @param {object} opts.values      — { key: value, ... }
 * @returns {Buffer}                — merged .docx bytes
 */
export function mergeTemplate({ docxBuffer, vars, values }) {
  // Step 1 — normalize the template so docxtemplater can find {key}
  // placeholders. Skip if vars empty (then we just clone the file).
  const normalized = (Array.isArray(vars) && vars.length > 0)
    ? normalizeTemplate({ docxBuffer, vars })
    : docxBuffer;

  // Step 2 — run docxtemplater. nullGetter returns the placeholder
  // text in braces so the user can see which fields didn't get filled
  // (we ALSO surface missing fields as an explicit list via the
  // render endpoint's response, so this is a defensive belt).
  const zip = new PizZip(normalized);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: (part) => {
      // For missing values, leave the placeholder visible so the user
      // knows what wasn't filled. Wrap in [angled brackets] for
      // clarity.
      const tag = part && part.value ? part.value : 'unknown';
      return `[${tag}]`;
    },
  });

  // Coerce values for tricky types — Date objects → ISO strings,
  // numbers → strings (so docxtemplater doesn't error on type
  // surprises). Already-string values pass through.
  const safeValues = {};
  for (const v of (vars || [])) {
    if (!v?.key) continue;
    let val = values?.[v.key];
    if (val === undefined || val === null) {
      safeValues[v.key] = '';
      continue;
    }
    if (val instanceof Date) val = val.toISOString().slice(0, 10);
    if (typeof val === 'number') val = String(val);
    if (Array.isArray(val)) val = val.join(', ');
    if (typeof val === 'object') val = JSON.stringify(val);
    safeValues[v.key] = String(val);
  }
  // Also include any keys present in values that AREN'T in the
  // schema — defensive, lets the extraction model add fields the
  // schema missed.
  for (const k of Object.keys(values || {})) {
    if (!(k in safeValues)) safeValues[k] = String(values[k] ?? '');
  }

  doc.render(safeValues);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Extract the *inner* body XML of a DOCX — everything inside
 * `<w:body>...</w:body>` MINUS the closing `<w:sectPr>` (which
 * holds page setup + header/footer references for the source doc,
 * not the destination).
 *
 * Used by the "wrap with letterhead" path: we render a template
 * normally (fields or body mode) → call this on the result to get
 * the merged content → call wrapInLetterhead to drop it into the
 * letterhead's body while preserving the letterhead's own sectPr
 * (which points to the logo header / firm footer).
 *
 * @param {Buffer} docxBuffer
 * @param {object} [opts]
 * @param {boolean} [opts.stripLetterheadBlock]
 *   When true, strip any leading RIGHT-ALIGNED paragraphs from the
 *   top of the body. This is the universal "fake letterhead at the
 *   top of a legal letter" pattern (firm name + address aligned
 *   right) — when the destination is the user's own letterhead, we
 *   don't want that info duplicated. Bottom signature blocks are
 *   preserved (they're left-aligned and belong in the body either
 *   way).
 */
export function extractBodyContent(docxBuffer, opts = {}) {
  const zip = new PizZip(docxBuffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('Source doc has no word/document.xml');
  const xml = documentFile.asText();
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error('Source doc has no <w:body>');
  let inner = bodyMatch[1];
  // Strip any sectPr at the end of the body — the destination
  // letterhead has its own.
  inner = inner.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/, '');
  if (opts.stripLetterheadBlock) {
    inner = stripLeadingRightAlignedParagraphs(inner);
  }
  return inner.trim();
}

/**
 * Walk paragraphs at the top of the body and drop any that are
 * right-aligned (or have a blank "spacer" right-aligned style).
 * Stops at the first non-right-aligned paragraph — i.e. the actual
 * letter body. Also tolerates blank paragraphs interspersed in the
 * letterhead block (which appear as `<w:p/>` or `<w:p><w:pPr>...</w:pPr></w:p>`).
 */
function stripLeadingRightAlignedParagraphs(bodyXml) {
  // We process paragraph-by-paragraph from the start until we hit
  // one that ISN'T right-aligned and ISN'T empty/spacer.
  let cursor = 0;
  const lengths = []; // [paragraphLengthInChars]
  while (cursor < bodyXml.length) {
    const startMatch = bodyXml.slice(cursor).match(/^[\s]*<w:p\b/);
    if (!startMatch) break;
    const pStart = cursor + startMatch.index + startMatch[0].length - 4;
    // Find the end of this <w:p>...</w:p> — has to handle nested?
    // Word never nests <w:p> inside <w:p>, so a non-greedy match works.
    const remainder = bodyXml.slice(pStart);
    const endMatch = remainder.match(/^<w:p\b[^>]*\/>|^<w:p\b[^>]*>[\s\S]*?<\/w:p>/);
    if (!endMatch) break;
    const para = endMatch[0];
    const paraEnd = pStart + para.length;
    const isRightAligned = /<w:jc\s+w:val="right"\s*\/>/.test(para);
    // Empty / spacer paragraph — `<w:p/>` or a paragraph with NO
    // text content (only pPr). Don't break on these between
    // letterhead lines; they're just blank rows for spacing.
    const hasText = /<w:t\b/.test(para);
    if (isRightAligned) {
      cursor = paraEnd;
      continue;
    }
    if (!hasText && lengths.length > 0) {
      // Spacer paragraph following a right-aligned one — keep
      // walking; it's just visual breathing room above the body.
      lengths.push(para.length);
      cursor = paraEnd;
      continue;
    }
    // Real content paragraph — stop here.
    break;
  }
  return bodyXml.slice(cursor);
}

/**
 * Wrap pre-rendered body content into a user's letterhead template.
 *
 * @param {object} opts
 * @param {Buffer} opts.letterheadBuffer  — the letterhead .docx bytes
 * @param {string} opts.bodyXml           — OOXML from extractBodyContent
 * @returns {Buffer}                      — merged .docx
 */
export function wrapInLetterhead({ letterheadBuffer, bodyXml }) {
  const zip = new PizZip(letterheadBuffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) {
    throw new Error('Letterhead has no word/document.xml — not a valid DOCX.');
  }
  const xml = documentFile.asText();
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) {
    throw new Error('Letterhead has no <w:body>.');
  }
  // Preserve letterhead's sectPr (header / footer / page setup).
  const sectPrMatch = bodyMatch[1].match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/);
  const sectPr = sectPrMatch ? sectPrMatch[0] : '';

  const newBody = `<w:body>${bodyXml}${sectPr}</w:body>`;
  const newXml = xml.replace(/<w:body\b[^>]*>[\s\S]*?<\/w:body>/, newBody);
  zip.file('word/document.xml', newXml);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Body-write mode merge — for letterhead-only templates whose body
 * is empty. The user supplies free-form text (typically a chat
 * response) that becomes the document body, while the template's
 * header, footer, page setup, fonts, and styles stay intact.
 *
 * Mechanics:
 *   1. Open the .docx as a ZIP.
 *   2. Find the `<w:body>...</w:body>` block in word/document.xml.
 *   3. Extract the `<w:sectPr>` (section properties — these hold
 *      page setup AND header/footer references; preserve them).
 *   4. Replace everything else inside `<w:body>` with new `<w:p>`
 *      elements built from the supplied content. Markdown-light
 *      formatting is supported (bold, italic, headings 1-3).
 *   5. Repack and return.
 *
 * @param {object} opts
 * @param {Buffer} opts.docxBuffer   — original template .docx bytes
 * @param {string} opts.bodyContent  — markdown-ish text to inject
 * @returns {Buffer}                 — merged .docx bytes
 */
export function mergeTemplateBody({ docxBuffer, bodyContent }) {
  const zip = new PizZip(docxBuffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) {
    throw new Error('Template has no word/document.xml — not a valid DOCX.');
  }
  const xml = documentFile.asText();

  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) {
    throw new Error('Could not locate <w:body> in template document.xml.');
  }

  // Preserve section properties (page size, margins, header/footer
  // references). These usually sit at the END of <w:body>.
  const sectPrMatch = bodyMatch[1].match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/);
  const sectPr = sectPrMatch ? sectPrMatch[0] : '';

  const newParagraphs = markdownToOoxmlBody(bodyContent || '');
  const newBody = `<w:body>${newParagraphs}${sectPr}</w:body>`;

  const newXml = xml.replace(/<w:body\b[^>]*>[\s\S]*?<\/w:body>/, newBody);
  zip.file('word/document.xml', newXml);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Convert markdown-ish text into a string of OOXML `<w:p>` elements.
 *
 * Markdown supported:
 *   - Headings: `# H1`, `## H2`, `### H3` (and four `####` → H4)
 *   - Paragraphs: blank-line separated blocks
 *   - Bullet lists: lines beginning with `- `, `* `, or `• `
 *   - Numbered lists: lines beginning with `1. `, `2. `, etc.
 *   - Bold: `**text**`, `__text__`
 *   - Italic: `*text*`, `_text_`
 *   - Bold + italic: `***text***`
 *   - Inline code: `` `code` `` → Courier-style run
 *   - Horizontal rule: `---` on its own line
 *
 * OOXML output uses BOTH `<w:pStyle>` references (which adopt the
 * template's heading style if defined) AND explicit run properties
 * (size, weight, italic) so the output still looks like a heading
 * even when the template lacks the named style.
 */
function markdownToOoxmlBody(markdown) {
  if (!markdown || !markdown.trim()) {
    return '<w:p/>';
  }
  const normalized = String(markdown).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  // Split into blocks (blank-line separated), but keep contiguous
  // list lines grouped so they render as a single bulleted/numbered
  // block. We do this in a single forward pass over lines.
  const lines = normalized.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip leading blank lines
    if (!line.trim()) { i++; continue; }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ kind: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() });
      i++;
      continue;
    }

    // Bullet list (group consecutive lines)
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Numbered list (group consecutive)
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // Paragraph — accumulate until blank line or block-level marker
    const paraLines = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^(#{1,4})\s+/.test(lines[i])
      && !/^\s*[-*•]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !/^---+\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', text: paraLines.join('\n') });
  }

  return blocks.map(blockToOoxml).join('');
}

// Heading sizes (half-points per OOXML convention — so 32 = 16pt).
// Tuned for legal-document hierarchy: H1 prominent but not huge.
const HEADING_SIZES = { 1: 32, 2: 28, 3: 24, 4: 22 };

function blockToOoxml(block) {
  if (block.kind === 'hr') {
    // Horizontal rule = a paragraph with a bottom border.
    return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`;
  }
  if (block.kind === 'heading') {
    const size = HEADING_SIZES[block.level] || 24;
    const runs = inlineRuns(block.text, { boldBaseline: true, sizeHalfPoints: size });
    // Heading-paragraph spacing: a bit more above, a touch below.
    // Use pStyle so templates with their own heading definitions take
    // precedence; the run-level <w:b/> + <w:sz/> are belt-and-suspenders.
    return `<w:p>` +
      `<w:pPr>` +
        `<w:pStyle w:val="Heading${block.level}"/>` +
        `<w:spacing w:before="240" w:after="120"/>` +
        `<w:keepNext/>` +
      `</w:pPr>` +
      runs +
    `</w:p>`;
  }
  if (block.kind === 'p') {
    // Body paragraph — 120 twips (~6pt) of after-spacing, 1.15 line
    // spacing for legibility. Mirrors Word's default "Normal" style.
    const runs = inlineRuns(block.text);
    return `<w:p>` +
      `<w:pPr>` +
        `<w:spacing w:after="160" w:line="276" w:lineRule="auto"/>` +
      `</w:pPr>` +
      runs +
    `</w:p>`;
  }
  if (block.kind === 'ul' || block.kind === 'ol') {
    return block.items.map((item, idx) => listItemToOoxml(item, block.kind, idx + 1)).join('');
  }
  return '';
}

function listItemToOoxml(text, kind, index) {
  // Prefix the bullet/number inline (since we don't ship a custom
  // numbering.xml in v1 — that'd require modifying multiple files
  // in the docx archive). Hanging-indent via `ind` so wrapped lines
  // align with the text after the marker.
  const prefix = kind === 'ul' ? '•  ' : `${index}.  `;
  const runs = inlineRuns(prefix + text);
  return `<w:p>` +
    `<w:pPr>` +
      `<w:spacing w:after="80" w:line="276" w:lineRule="auto"/>` +
      `<w:ind w:left="360" w:hanging="360"/>` +
    `</w:pPr>` +
    runs +
  `</w:p>`;
}

/**
 * Split inline text into runs (bold / italic / code / plain) and
 * emit OOXML `<w:r>` elements. Mid-paragraph single newlines become
 * `<w:br/>`. Honors a heading-baseline style via opts.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.boldBaseline] — true: every run inherits bold (for headings)
 * @param {number}  [opts.sizeHalfPoints] — set explicit run size in half-points (24 = 12pt)
 */
function inlineRuns(text, opts = {}) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(parseInlineLine(lines[i], opts));
    if (i < lines.length - 1) {
      out.push('<w:r><w:br/></w:r>');
    }
  }
  return out.join('');
}

function parseInlineLine(line, opts) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    // Bold+italic: ***text***
    if (line.startsWith('***', i)) {
      const closeIdx = line.indexOf('***', i + 3);
      if (closeIdx > i + 3) {
        tokens.push({ kind: 'bi', text: line.slice(i + 3, closeIdx) });
        i = closeIdx + 3;
        continue;
      }
    }
    // Bold: **text** or __text__
    if (line.startsWith('**', i) || line.startsWith('__', i)) {
      const marker = line.substr(i, 2);
      const closeIdx = line.indexOf(marker, i + 2);
      if (closeIdx > i + 2) {
        tokens.push({ kind: 'b', text: line.slice(i + 2, closeIdx) });
        i = closeIdx + 2;
        continue;
      }
    }
    // Inline code: `text`
    if (line[i] === '`') {
      const closeIdx = line.indexOf('`', i + 1);
      if (closeIdx > i + 1) {
        tokens.push({ kind: 'code', text: line.slice(i + 1, closeIdx) });
        i = closeIdx + 1;
        continue;
      }
    }
    // Italic: *text* or _text_ (single marker)
    if ((line[i] === '*' || line[i] === '_') && line[i + 1] !== line[i]) {
      const marker = line[i];
      const closeIdx = line.indexOf(marker, i + 1);
      if (closeIdx > i + 1) {
        tokens.push({ kind: 'i', text: line.slice(i + 1, closeIdx) });
        i = closeIdx + 1;
        continue;
      }
    }
    // Plain — accumulate until the next marker
    let j = i;
    while (j < line.length) {
      if (line.startsWith('***', j)) break;
      if (line.startsWith('**', j) || line.startsWith('__', j)) break;
      if (line[j] === '`') break;
      if ((line[j] === '*' || line[j] === '_') && line[j + 1] !== line[j]) {
        const closeIdx = line.indexOf(line[j], j + 1);
        if (closeIdx > j + 1) break;
      }
      j++;
    }
    if (j > i) {
      tokens.push({ kind: 'plain', text: line.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: 'plain', text: line[i] });
      i++;
    }
  }
  return tokens.map((t) => tokenToRun(t, opts)).join('');
}

function tokenToRun(tok, opts = {}) {
  const escaped = escapeXmlText(tok.text);
  // Build the <w:rPr> based on token kind + heading-baseline opts.
  const rPrParts = [];
  const isBold = tok.kind === 'b' || tok.kind === 'bi' || !!opts.boldBaseline;
  const isItalic = tok.kind === 'i' || tok.kind === 'bi';
  const isCode = tok.kind === 'code';
  if (isBold) rPrParts.push('<w:b/>');
  if (isItalic) rPrParts.push('<w:i/>');
  if (isCode) {
    rPrParts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
    rPrParts.push('<w:shd w:val="clear" w:color="auto" w:fill="F4F2EE"/>');
  }
  if (typeof opts.sizeHalfPoints === 'number') {
    rPrParts.push(`<w:sz w:val="${opts.sizeHalfPoints}"/>`);
    rPrParts.push(`<w:szCs w:val="${opts.sizeHalfPoints}"/>`);
  }
  const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
}

/**
 * Compute which fields are missing from `values` given the schema.
 * Returns an array of var objects (key + label) so the UI can render
 * "Missing: client_address, effective_date" pills.
 */
export function computeMissingFields({ vars, values }) {
  if (!Array.isArray(vars)) return [];
  const missing = [];
  for (const v of vars) {
    if (!v?.key) continue;
    const val = values?.[v.key];
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      missing.push({ key: v.key, label: v.label || v.key });
    }
  }
  return missing;
}
