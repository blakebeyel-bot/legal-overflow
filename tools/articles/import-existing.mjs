/**
 * One-time import: pull every markdown article from src/content/articles/
 * into the public.articles table. Idempotent on slug — safe to re-run;
 * an article with the same slug is updated rather than duplicated.
 *
 * Run after migration 0013 has been applied:
 *   node tools/articles/import-existing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

// .env bootstrap
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const ARTICLES_DIR = 'src/content/articles';
const files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.md'));

console.log(`[import] ${files.length} markdown file(s) found`);
let inserted = 0, updated = 0, errored = 0;

for (const file of files) {
  const slug = file.replace(/\.md$/, '');
  const raw = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf8');
  const fm = parseFrontmatter(raw);
  if (!fm.frontmatter || !fm.frontmatter.title) {
    console.warn(`[import] ${file}: no frontmatter title — skipping`);
    errored++;
    continue;
  }
  const f = fm.frontmatter;
  const row = {
    slug,
    title: f.title || slug,
    dek: f.dek || '',
    kind: f.kind || 'Essay',
    track: ['legal', 'business', 'both'].includes(f.track) ? f.track : 'legal',
    read_minutes: Number.isFinite(+f.readMinutes) ? +f.readMinutes : 5,
    topic: f.topic || 'General',
    cover: f.cover || 'ph-b',
    featured: f.featured === true || f.featured === 'true',
    status: f.draft === true || f.draft === 'true' ? 'draft' : 'published',
    body_md: fm.body,
    date: parseDate(f.date) || new Date().toISOString().slice(0, 10),
  };

  // Upsert on slug
  const { data: existing } = await supabase
    .from('articles')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('articles')
      .update(row)
      .eq('id', existing.id);
    if (error) { console.error(`[import] ${slug}: update failed —`, error.message); errored++; continue; }
    console.log(`↻ ${slug} (updated)`);
    updated++;
  } else {
    const { error } = await supabase.from('articles').insert(row);
    if (error) { console.error(`[import] ${slug}: insert failed —`, error.message); errored++; continue; }
    console.log(`+ ${slug} (inserted)`);
    inserted++;
  }
}

console.log(`\n[import] DONE — inserted: ${inserted}, updated: ${updated}, errored: ${errored}`);

// ============== helpers ==============

/**
 * Minimal frontmatter parser. Handles:
 *   ---
 *   key: value
 *   key: "quoted value"
 *   key: 12
 *   key: true
 *   key: 2026-04-03   (parsed as a date string)
 *   ---
 *   body markdown...
 *
 * Returns { frontmatter: object, body: string }.
 */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: raw };
  const fmText = m[1];
  const body = (m[2] || '').replace(/^\s+/, '');
  const fm = {};
  for (const line of fmText.split('\n')) {
    const lineMatch = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!lineMatch) continue;
    const key = lineMatch[1];
    let val = lineMatch[2].trim();
    if (val === '') continue;
    // Strip wrapping quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(val)) val = parseFloat(val);
    fm[key] = val;
  }
  return { frontmatter: fm, body };
}

function parseDate(input) {
  if (!input) return null;
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  const s = String(input).trim();
  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10);
}
