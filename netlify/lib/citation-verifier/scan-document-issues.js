/**
 * Citation Verifier — document-level issue scanner.
 *
 * Some Bluebook rules apply to PROSE, not citations: ellipsis spacing
 * (R. 5.3), block-quote formatting (R. 5.1), capitalization conventions
 * (R. 8). These can't be evaluated per-citation because the violation
 * doesn't live inside a citation candidate's span — it's somewhere in
 * the surrounding text.
 *
 * This module scans the document body and returns SYNTHETIC citation
 * objects with pre-attached flags. The orchestrator merges these with
 * the real citations from Pass 1 so they flow through Pass 5 markup
 * unchanged.
 *
 * Synthetic-candidate shape:
 *   {
 *     pattern_name:     'doc-issue-ellipsis' | 'doc-issue-block-quote' | ...,
 *     provisional_type: 'document_annotation',
 *     citation_type:    'document_annotation',
 *     candidate_text:   <string — the offending span, used as markup anchor>,
 *     char_start, char_end, pre_context, post_context,
 *     in_footnote, footnote_num,
 *     components:       {},
 *     existence:        { status: 'not_applicable' },
 *     flags:            [<pre-attached flag>],
 *     candidate_text_hash: 'doc-issue:<rule>:<sha>',
 *   }
 *
 * runAllValidators skips citation_type='document_annotation' (no path),
 * so the pre-attached flag is the only flag emitted. markup-shared's
 * buildFindings sees c.flags non-empty and emits the comment.
 */

import { sha256Hex } from './extract.js';

/**
 * Scan document text and return synthetic citation objects for any
 * non-citation Bluebook issues found.
 *
 * @param {string} text — canonical document body (post-extraction)
 * @returns {Array<SyntheticCitation>}
 */
import { scanHereinafterUndeclared } from './validators.js';

export function scanDocumentIssues(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  out.push(...scanEllipsisSpacing(text));
  out.push(...scanBlockQuoteShortLength(text));
  out.push(...scanR8Capitalization(text));
  // Round 19 — R. 4.2(b) hereinafter undeclared.
  out.push(...scanHereinafterUndeclared(text));
  // Round 24 — R. 3.2(a) paragraph-range pin (¶¶ N-M / ¶¶ N—M).
  // Record citations like "Compl. ¶¶ 31-38" don't pass through the case
  // extractor; they're emitted as synthetic candidates with pre-attached
  // R. 3.2(a) flags.
  out.push(...scanParagraphRange(text));
  return out;
}

/**
 * R. 3.2(a) — Paragraph range with hyphen or em dash where en dash is required.
 *
 * Detects "¶ N-M" / "¶¶ N-M" / "¶¶ N—M" patterns in document text. These
 * appear in record citations (Compl., Mot., Pet'n, etc.) and aren't
 * captured by the case extractor.
 *
 * Round 29 — consolidation. The long-document stress test produced 52
 * paragraph-range comments (out of 81 total), burying substantive catches
 * (T6 advisories, R. 10.9 gaps, CourtListener mismatches) in format noise.
 * Per user product decision: when the document contains 5+ HYPHEN ¶¶
 * ranges, emit ONE consolidated advisory anchored at the first occurrence
 * with the count + 2-3 examples + a find-and-replace recommendation.
 *
 * Consolidation only applies to:
 *   • HYPHEN ¶¶ ranges (em-dash ranges fire individually — em dashes
 *     come from Word auto-correct of "--", a separate semantic intent
 *     and rare enough that per-occurrence comments aren't noisy).
 *   • PARAGRAPH ranges in record citations. Pin-cite ranges in case
 *     citations (validators.js Pattern 1) and Id. short-form ranges
 *     (validators.js Pattern 2) fire per occurrence regardless — those
 *     have higher per-instance importance and are caught by a different
 *     code path.
 *
 * Below the threshold (4 or fewer), behavior is unchanged: per-occurrence
 * emission. The 8-brief corpus has no brief with 5+ ¶¶ hyphens so the
 * regression suite is unaffected.
 */
const PARAGRAPH_RANGE_CONSOLIDATION_THRESHOLD = 5;

function scanParagraphRange(text) {
  if (!text) return [];
  const re = /¶{1,2}\s*(\d{1,5})([-—])(\d{1,5})\b/g;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      raw: m[0],
      a: m[1],
      dash: m[2],
      b: m[3],
      index: m.index,
    });
  }
  if (matches.length === 0) return [];

  const hyphenMatches = matches.filter((mm) => mm.dash === '-');
  const emDashMatches = matches.filter((mm) => mm.dash === '—');

  const out = [];

  // Em-dash matches always fire individually (per Round 29 spec).
  for (const mm of emDashMatches) {
    out.push(makeIndividualParagraphRangeFlag(text, mm));
  }

  // Hyphen matches: consolidate at threshold.
  if (hyphenMatches.length >= PARAGRAPH_RANGE_CONSOLIDATION_THRESHOLD) {
    out.push(makeConsolidatedParagraphRangeFlag(text, hyphenMatches));
  } else {
    for (const mm of hyphenMatches) {
      out.push(makeIndividualParagraphRangeFlag(text, mm));
    }
  }

  return out;
}

function makeIndividualParagraphRangeFlag(text, m) {
  const span = m.raw;
  const start = m.index;
  const end = start + span.length;
  const dashName = m.dash === '—' ? 'em dash (—)' : 'hyphen';
  const fixed = span.replace(/([-—])/, '–');
  return {
    pattern_name: 'doc-issue-paragraph-range',
    provisional_type: 'document_annotation',
    citation_type: 'document_annotation',
    candidate_text: span,
    char_start: start,
    char_end: end,
    pre_context: text.slice(Math.max(0, start - 200), start),
    post_context: text.slice(end, Math.min(text.length, end + 200)),
    in_footnote: false,
    footnote_num: null,
    components: {},
    existence: { status: 'not_applicable' },
    flags: [{
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 3.2(a)',
      table_cite: null,
      message: `Paragraph range "${m.a}${m.dash}${m.b}" uses ${dashName}; R. 3.2(a) requires an en dash (–): "${m.a}–${m.b}".`,
      suggested_fix: fixed,
    }],
    candidate_text_hash: 'doc-issue:' + sha256Hex(Buffer.from(span + '|' + start, 'utf8')).slice(0, 16),
  };
}

function makeConsolidatedParagraphRangeFlag(text, matches) {
  // Anchor on the first occurrence in document order so the comment lands
  // at the top of the cluster. Markup-shared finds the candidate_text
  // verbatim in the source XML — the first occurrence is the most
  // reliable anchor (later duplicates would also match but the first
  // gets the comment in the natural reading position).
  const first = matches[0];
  const span = first.raw;
  const start = first.index;
  const end = start + span.length;

  // Build 2-3 distinct examples. Prefer the first three matches' textual
  // forms; the user said "list 2-3 example ranges" so 3 is the cap.
  const seen = new Set();
  const examples = [];
  for (const mm of matches) {
    const key = `¶¶ ${mm.a}-${mm.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(key);
    if (examples.length >= 3) break;
  }
  const exampleList = examples.join(', ');
  const total = matches.length;

  return {
    pattern_name: 'doc-issue-paragraph-range-consolidated',
    provisional_type: 'document_annotation',
    citation_type: 'document_annotation',
    candidate_text: span,
    char_start: start,
    char_end: end,
    pre_context: text.slice(Math.max(0, start - 200), start),
    post_context: text.slice(end, Math.min(text.length, end + 200)),
    in_footnote: false,
    footnote_num: null,
    components: {},
    existence: { status: 'not_applicable' },
    flags: [{
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 3.2(a)',
      table_cite: null,
      message:
        `This document contains ${total} paragraph ranges in record citations ` +
        `(e.g., ${exampleList}) that use a hyphen where R. 3.2(a) requires an ` +
        `en dash (–). Each is a real R. 3.2(a) violation; consolidating into ` +
        `one advisory because of volume. Recommended: a document-wide ` +
        `find-and-replace on "¶¶ <N>-<N>" patterns, replacing the hyphen ` +
        `with an en dash (–). (R. 3.2(a))`,
      // No single-span suggested_fix — this is a doc-wide issue; per-line
      // surgery is in markup-shared territory and would mismatch the
      // anchor's narrow span.
      suggested_fix: null,
    }],
    candidate_text_hash: 'doc-issue:' + sha256Hex(Buffer.from('consolidated|' + total + '|' + span + '|' + start, 'utf8')).slice(0, 16),
  };
}

/**
 * R. 8 — Capitalization conventions.
 *
 * Per Bluebook R. 8:
 *   • "Constitution" is ALWAYS capitalized when referring to a specific
 *     constitution (the U.S. or a state).
 *   • "Congress" is capitalized when referring to the U.S. Congress
 *     (proper noun). Lowercase only for generic plural "congresses".
 *   • "Bill of Rights" is ALWAYS capitalized.
 *   • "Court" is capitalized only when referring to the Supreme Court of
 *     the United States, the receiving court ("this Court"), OR when
 *     part of the FULL proper name of a court ("United States Court of
 *     Appeals for the D.C. Circuit"). Otherwise lowercase.
 *
 * Conservative bias: only flag the LOWERCASE-when-should-be-uppercase
 * direction (and the specific "Court of Appeals" miscapitalization). The
 * uppercase-when-should-be-lowercase direction is harder to distinguish
 * from a legitimate proper-name reference, so we skip it.
 *
 * Critical FP-resistance: do NOT flag "Congress", "Constitution", "This
 * Court", "The Supreme Court", "Defendant" (party reference), "Article I"
 * (Roman numeral). The regexes are scoped to specifically match the
 * lowercase forms only.
 */
function scanR8Capitalization(text) {
  const flags = [];

  // 1. "the constitution" — lowercase 'c' should be capital.
  //    Skip when "constitution" is followed by lowercase letters that
  //    indicate an internal word boundary (handled by `\b`). Skip
  //    "constitutions" plural generic.
  const constRe = /\bthe\s+constitution\b/g;
  let m;
  while ((m = constRe.exec(text)) !== null) {
    flags.push(buildR8Flag({
      text, start: m.index, end: m.index + m[0].length,
      span: m[0],
      message: `"the constitution" should be capitalized as "the Constitution" when referring to the U.S. or a state constitution per R. 8.`,
      suggested: m[0].replace(/\bconstitution\b/, 'Constitution'),
      pattern: 'doc-issue-r8-constitution',
    }));
  }

  // 2. "congress" — lowercase, referring to the U.S. Congress as a proper
  //    noun. Conservative: only flag the standalone word, not "congresses"
  //    or "congressional". Word boundary in JS regex handles both.
  const congressRe = /\bcongress\b/g;
  while ((m = congressRe.exec(text)) !== null) {
    flags.push(buildR8Flag({
      text, start: m.index, end: m.index + m[0].length,
      span: m[0],
      message: `"congress" should be capitalized as "Congress" when referring to the U.S. Congress (proper noun) per R. 8.`,
      suggested: 'Congress',
      pattern: 'doc-issue-r8-congress',
    }));
  }

  // 3. "the bill of rights" — must be capitalized.
  const borRe = /\bthe\s+bill\s+of\s+rights\b/g;
  while ((m = borRe.exec(text)) !== null) {
    flags.push(buildR8Flag({
      text, start: m.index, end: m.index + m[0].length,
      span: m[0],
      message: `"the bill of rights" must be capitalized as "the Bill of Rights" per R. 8.`,
      suggested: 'the Bill of Rights',
      pattern: 'doc-issue-r8-bill-of-rights',
    }));
  }

  // 4. "The Court of Appeals" / "the Court of Appeals" — generic capitalized
  //    reference should be lowercase per R. 8. EXCEPTION: when preceded by
  //    "United States" (full proper name) it stays capitalized.
  //    The negative lookbehind requires the prior token NOT to be "States"
  //    (which would indicate the full "United States Court of Appeals" name).
  const courtAppRe = /(?<!United\s)(?<!States\s)\b[Tt]he\s+Court\s+of\s+Appeals\b/g;
  while ((m = courtAppRe.exec(text)) !== null) {
    flags.push(buildR8Flag({
      text, start: m.index, end: m.index + m[0].length,
      span: m[0],
      message: `"Court of Appeals" should be lowercased ("court of appeals") per R. 8 unless used as part of the FULL proper name ("United States Court of Appeals for the D.C. Circuit"). Generic references use lowercase.`,
      suggested: m[0].replace(/Court\s+of\s+Appeals/, 'court of appeals'),
      pattern: 'doc-issue-r8-court-of-appeals',
    }));
  }

  return flags;
}

function buildR8Flag({ text, start, end, span, message, suggested, pattern }) {
  return {
    pattern_name: pattern,
    provisional_type: 'document_annotation',
    citation_type: 'document_annotation',
    candidate_text: span,
    char_start: start,
    char_end: end,
    pre_context: text.slice(Math.max(0, start - 200), start),
    post_context: text.slice(end, Math.min(text.length, end + 200)),
    in_footnote: false,
    footnote_num: null,
    components: {},
    existence: { status: 'not_applicable' },
    flags: [{
      severity: 'non_conforming',
      category: 'capitalization',
      rule_cite: 'BB R. 8',
      table_cite: null,
      message,
      suggested_fix: suggested,
    }],
    candidate_text_hash: 'doc-issue:' + sha256Hex(Buffer.from(span + '|' + start, 'utf8')).slice(0, 16),
  };
}

/**
 * R. 5.1 — Block-quote vs. inline.
 *
 * Quotations of FEWER than 50 words must be inline (with quotation marks),
 * NOT formatted as a block quote (indented, no quote marks). Detection
 * heuristic for an indented paragraph that's actually a block quote:
 *
 *   • Paragraph starts with ≥4 leading spaces or a tab.
 *   • Word count is between 5 and 50 (too short for block quote, but too
 *     long to be a heading).
 *   • Paragraph is NOT a section heading, signature, or list marker.
 *   • Either:
 *      a) The PREVIOUS paragraph ends with ":" (introduces a quote), OR
 *      b) The NEXT paragraph is a citation in the form "Caseword, V Reporter at P."
 *
 * Conservative bias: if neither colon-intro NOR citation-trailer is
 * present, do not flag. The cost of a false positive on a chapter
 * heading or block of indented prose is higher than missing one
 * miscategorised quote.
 */
function scanBlockQuoteShortLength(text) {
  const flags = [];
  // Split into paragraphs on a blank line (one or more \n\n sequences,
  // possibly with whitespace between).
  const paraRe = /([^\n]*(?:\n[ \t]*[^\n]+)*)(?:\n\s*\n|\n\s*$|$)/g;
  const paragraphs = [];
  let m;
  while ((m = paraRe.exec(text)) !== null) {
    if (m[0].length === 0) { paraRe.lastIndex++; continue; }
    const pStart = m.index;
    const pText = m[1];
    if (!pText || !pText.trim()) continue;
    paragraphs.push({ text: pText, start: pStart, end: pStart + pText.length });
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    // Indented: ≥4 spaces or a tab at start.
    if (!/^[\t ]{4,}\S/.test(para.text)) continue;

    const trimmed = para.text.trim();
    if (!trimmed) continue;

    // Word count.
    const words = trimmed.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    if (wordCount < 5 || wordCount >= 50) continue;

    // Skip headings, signatures, list markers, all-caps lines.
    if (/^[IVX]+\.\s/.test(trimmed)) continue;        // "I. Argument"
    if (/^[A-Z][A-Z][A-Z\s,&'.-]+$/.test(trimmed)) continue;  // "ARGUMENT"
    if (/^\/s\//.test(trimmed)) continue;             // "/s/ Counsel"
    if (/^Respectfully\b/i.test(trimmed)) continue;
    if (/^By:/i.test(trimmed)) continue;
    if (/^\d+[.)]\s/.test(trimmed)) continue;         // "1. ..." or "1) ..."
    if (/^[A-Za-z]\.\s/.test(trimmed) && wordCount < 8) continue; // "A. Topic"
    if (/^Hon\./i.test(trimmed)) continue;            // judge name line
    if (/^Case\s+No\./i.test(trimmed)) continue;
    // Skip if the paragraph is actually quoted (has quote marks at edges).
    if (/^["“]/.test(trimmed)) continue;

    // Context: preceding paragraph ends with ":" — introduces a quote.
    const prev = i > 0 ? paragraphs[i - 1].text.trimEnd() : '';
    const prevEndsWithColon = /:$/.test(prev);

    // OR following paragraph looks like a citation
    // ("Caseword, V Reporter at P." / "Caseword v. Other, V Reporter ...")
    const next = i < paragraphs.length - 1 ? paragraphs[i + 1].text.trim() : '';
    const nextLooksLikeCitation = /^[A-Z][A-Za-z'.\-]+,?\s+\d+\s+[A-Z][A-Za-z.\d\s]+\s+(?:at\s+)?\d/.test(next);

    if (!prevEndsWithColon && !nextLooksLikeCitation) continue;

    // Found a likely R. 5.1 violation. Anchor on the paragraph itself.
    const anchor = trimmed;
    flags.push({
      pattern_name: 'doc-issue-block-quote',
      provisional_type: 'document_annotation',
      citation_type: 'document_annotation',
      candidate_text: anchor,
      char_start: para.start + para.text.indexOf(anchor.charAt(0)),
      char_end: para.end,
      pre_context: text.slice(Math.max(0, para.start - 200), para.start),
      post_context: text.slice(para.end, Math.min(text.length, para.end + 200)),
      in_footnote: false,
      footnote_num: null,
      components: {},
      existence: { status: 'not_applicable' },
      flags: [
        {
          severity: 'non_conforming',
          category: 'quotation',
          rule_cite: 'BB R. 5.1',
          table_cite: null,
          message: `Block-quote paragraph has only ${wordCount} words; R. 5.1 requires a 50-word minimum for block format. Quotations under 50 words must be inline (with quotation marks), not set off as a block quote.`,
          suggested_fix: null,
        },
      ],
      candidate_text_hash: 'doc-issue:' + sha256Hex(Buffer.from(anchor + '|' + para.start, 'utf8')).slice(0, 16),
    });
  }
  return flags;
}

/**
 * R. 5.3 — Ellipsis spacing.
 *
 * Bluebook ellipsis is THREE periods separated by spaces, with a space
 * before the first period and after the last. e.g.:
 *
 *   "the rule . . . applies"     ← correct
 *   "the rule...applies"         ← wrong (no spaces)
 *   "the rule . .. applies"      ← wrong (uneven spacing)
 *
 * Detection: any cluster of three periods in close sequence preceded by
 * a non-space, OR three periods with anything other than the canonical
 * " . . . " spacing. We're conservative — we only flag the most common
 * mistake (no spaces at all, "word...word") and the variant where
 * spaces are missing on one side.
 *
 * NOTE: U+2026 (HORIZONTAL ELLIPSIS, "…") is also wrong in Bluebook
 * style; flag it separately.
 */
function scanEllipsisSpacing(text) {
  const flags = [];

  // Form A: three ASCII periods with no surrounding spaces, e.g. "word...word"
  // Capture group 0 is the whole span including the surrounding word chars
  // so the markup anchor is locatable in the .docx.
  const noSpaceRe = /\b([A-Za-z][\w'\-]*\.\.\.[A-Za-z][\w'\-]*)\b/g;
  let m;
  while ((m = noSpaceRe.exec(text)) !== null) {
    const spanText = m[1];
    const start = m.index;
    const end = start + spanText.length;
    flags.push(
      buildSyntheticCitation({
        text,
        start,
        end,
        spanText,
        patternName: 'doc-issue-ellipsis',
        flag: {
          severity: 'non_conforming',
          category: 'quotation',
          rule_cite: 'BB R. 5.3',
          table_cite: null,
          message: `Ellipsis "${spanText}" lacks the required Bluebook spacing — three periods must be separated by single spaces and surrounded by spaces, e.g. "${reformatEllipsis(spanText)}" per R. 5.3.`,
          suggested_fix: reformatEllipsis(spanText),
        },
      })
    );
  }

  // Form B: U+2026 horizontal ellipsis character (typographic "…")
  const horizEllipsisRe = /([A-Za-z][\w'\-]*…[A-Za-z][\w'\-]*)|(…)/g;
  while ((m = horizEllipsisRe.exec(text)) !== null) {
    const spanText = m[0];
    const start = m.index;
    const end = start + spanText.length;
    flags.push(
      buildSyntheticCitation({
        text,
        start,
        end,
        spanText,
        patternName: 'doc-issue-ellipsis-horiz',
        flag: {
          severity: 'non_conforming',
          category: 'quotation',
          rule_cite: 'BB R. 5.3',
          table_cite: null,
          message: `Typographic ellipsis character "…" is not Bluebook-conforming. Replace with three spaced periods " . . . " per R. 5.3.`,
          suggested_fix: spanText.replace(/…/g, ' . . . '),
        },
      })
    );
  }

  return flags;
}

/**
 * Reformat an ellipsis-collapsed span like "word...other" into
 * "word . . . other" for the suggested_fix field.
 */
function reformatEllipsis(span) {
  return span.replace(/(\w)\.\.\.(\w)/, '$1 . . . $2');
}

function buildSyntheticCitation({ text, start, end, spanText, patternName, flag }) {
  return {
    pattern_name: patternName,
    provisional_type: 'document_annotation',
    citation_type: 'document_annotation',
    candidate_text: spanText,
    char_start: start,
    char_end: end,
    pre_context: text.slice(Math.max(0, start - 200), start),
    post_context: text.slice(end, Math.min(text.length, end + 200)),
    in_footnote: false,
    footnote_num: null,
    components: {},
    existence: { status: 'not_applicable' },
    flags: [flag],
    candidate_text_hash: 'doc-issue:' + sha256Hex(Buffer.from(spanText + '|' + start, 'utf8')).slice(0, 16),
  };
}
