/**
 * Tiny runtime-portable Supabase REST adapter.
 *
 * Provides a uniform { select, upsert, update, insert } interface
 * that both Deno (edge functions) and Node (Netlify Functions) can
 * consume. Pass an explicit URL + serviceKey + fetchImpl so the
 * caller decides which env vars feed in.
 *
 * Method conventions:
 *   select(path)          — `path` is the part after `/rest/v1/`,
 *                           including query string.
 *                           e.g. "workspace_chats?id=eq.123&select=*"
 *   insert(table, body)   — POST, returns rows
 *   upsert(table, body)   — POST with on-conflict merge
 *   update(table, filter, patch)
 */

export function makeSupabaseREST({ url, serviceKey, fetchImpl }) {
  if (!url || !serviceKey) throw new Error('makeSupabaseREST requires url + serviceKey');
  const f = fetchImpl || globalThis.fetch;

  async function select(path) {
    const r = await f(`${url}/rest/v1/${path}`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
      },
    });
    if (!r.ok) throw new Error(`Supabase select ${r.status}: ${(await r.text()).slice(0, 400)}`);
    return await r.json();
  }

  async function insert(table, body) {
    const r = await f(`${url}/rest/v1/${table}?select=*`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Supabase insert ${r.status}: ${(await r.text()).slice(0, 400)}`);
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async function upsert(table, body) {
    const r = await f(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Supabase upsert ${r.status}: ${(await r.text()).slice(0, 400)}`);
  }

  async function update(table, filter, patch) {
    const r = await f(`${url}/rest/v1/${table}?${filter}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`Supabase update ${r.status}: ${(await r.text()).slice(0, 400)}`);
  }

  return { select, insert, upsert, update };
}
