/**
 * HTML → plain text parsers for statute and opinion pages.
 *
 * Pure JS, no DOM library. We strip HTML tags, decode common
 * entities, collapse whitespace, and trim navigation chrome.
 *
 * Each `parse*` function takes raw HTML and returns the largest
 * extractable text body. If parsing fails or the page looks like a
 * shell (search form, navigation only), returns an empty string —
 * the caller treats that as a parse failure and falls through to
 * the next source.
 *
 * Keep this conservative: we'd rather return nothing on a thin/JS-
 * only page than feed the LLM a page of menu links labeled as
 * "authoritative statute text".
 */

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&nbsp;': ' ', '&#160;': ' ',
  '&sect;': '§', '&#167;': '§',
  '&ndash;': '–', '&mdash;': '—',
  '&lsquo;': '‘', '&rsquo;': '’',
  '&ldquo;': '“', '&rdquo;': '”',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-zA-Z]+;/g, (e) => HTML_ENTITIES[e] || e);
}

function stripTags(html) {
  // Remove <script> and <style> blocks entirely
  let s = String(html);
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ');
  // Replace block-level tags with newlines so paragraphs survive
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode entities
  s = decodeEntities(s);
  // Normalize whitespace
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Justia statute pages — body is in <div id="codes-content"> or a
 * similar wrapper. As a fallback we just strip the whole HTML.
 */
function parseJustia(html) {
  const m = html.match(/<div[^>]+id=["']codes-content["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]+class=["']?(?:related|footer|sidebar|breadcrumbs)/i);
  const body = m ? m[1] : html;
  const text = stripTags(body);
  // Filter out the standard Justia "DISCLAIMER" footer
  return text.replace(/Disclaimer:\s*Justia[\s\S]+$/i, '').trim();
}

/**
 * Cornell LII pages — main text lives in <div class="row" id="..."> or
 * <main>. Use <main> if present, else fall back to whole body.
 */
function parseCornell(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const body = main ? main[1] : html;
  return stripTags(body);
}

/**
 * Generic / state-specific parsers. State sites vary widely — for
 * v1 we just strip the whole document. The thin-parse check in
 * the fetcher (length < 200) catches JS-only shells.
 */
function parseStateGeneric(html) {
  // Try to grab <main> or the largest <article> / <section>
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return stripTags(main[1]);
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return stripTags(article[1]);
  return stripTags(html);
}

/**
 * Parse statute HTML based on source.
 */
export function parseStatuteHTML(html, source) {
  if (!html || typeof html !== 'string') return '';
  if (source === 'justia') return parseJustia(html);
  if (source === 'cornell') return parseCornell(html);
  // 'state' or anything else
  return parseStateGeneric(html);
}

/**
 * Parse a CourtListener opinion page or Justia case page or Cornell
 * case page. Same generic strip — opinion text is the bulk of these
 * pages so generic stripping works well.
 */
export function parseOpinionHTML(html) {
  return parseStateGeneric(html);
}
