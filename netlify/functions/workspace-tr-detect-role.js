/**
 * POST /api/workspace-tr-detect-role
 *   body: { document_id }
 *
 * Quick LLM scan of a single document to identify the parties and
 * suggest which role the user might be representing. Used by the
 * new-review modal to auto-fill the "Whose side are you on?" chips
 * when the user selects exactly one document.
 *
 * Response:
 *   {
 *     doc_type: "Master Services Agreement",
 *     parties: [{name, role, description}],
 *     suggested_roles: ["Vendor", "Customer"],   // canonical short labels
 *   }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { completeText, findModel } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `You are quickly classifying a contract before deeper review. Identify the parties, the document type, and the two most likely roles the user might be representing in this transaction.

Output strict JSON only — no prose, no fenced code:
{
  "doc_type": "short name e.g. 'Master Services Agreement', 'Mutual NDA', 'Commercial Lease', 'Employment Agreement'",
  "parties": [
    {"name": "Party Name as written in the doc", "role": "their role e.g. 'Service Provider'", "description": "1 short sentence on who they are"}
  ],
  "suggested_roles": ["short canonical role labels — pick from: Buyer, Seller, Tenant, Landlord, Vendor, Customer, Employer, Employee, Licensor, Licensee, Disclosing Party, Receiving Party, Lender, Borrower, Service Provider, Client, Indemnitor, Indemnitee, OR a one-or-two-word custom label fitting this doc"]
}

Rules:
- "parties" — typically 2 entries. Use the names as actually written in the document.
- "suggested_roles" — the 2 most likely roles the reader might represent. Order: more likely first.
- Be brief. This is a triage call, not the full review.`;

const USER_PROMPT_PREFIX = `Classify this document and identify the parties.

DOCUMENT:
`;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const docId = body.document_id;
  if (!docId) return json({ error: 'Missing document_id' }, 400);

  const supabase = getSupabaseAdmin();

  // Pull the doc + its current version's extracted text. Cap to 30k
  // chars — for triage we only need the first few pages.
  const { data: doc } = await supabase
    .from('workspace_documents')
    .select('id, filename, current_version_id')
    .eq('id', docId)
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!doc) return json({ error: 'Document not found' }, 404);
  if (!doc.current_version_id) return json({ error: 'Document has no version' }, 400);

  const { data: version } = await supabase
    .from('workspace_document_versions')
    .select('extracted_text, extraction_status')
    .eq('id', doc.current_version_id)
    .single();
  const text = version?.extracted_text;
  if (!text) return json({ error: 'Document has no extracted text' }, 400);

  // First 30k chars is plenty for party detection — the front matter
  // names them.
  const snippet = text.slice(0, 30_000);

  const modelInfo = findModel('claude-sonnet-4-5');
  const { key } = await resolveProviderKey({ userId: auth.user.id, provider: modelInfo.provider });
  if (!key) return json({ error: `No API key for ${modelInfo.provider}` }, 400);

  let raw = '';
  try {
    const out = await completeText({
      provider: modelInfo.provider,
      model: modelInfo.id,
      apiKey: key,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: USER_PROMPT_PREFIX + snippet }],
      maxTokens: 500,
      temperature: 0.1,
    });
    raw = out.text;
  } catch (err) {
    return json({ error: `Detection failed: ${err.message}` }, 500);
  }

  // Tolerant JSON parse
  let parsed = null;
  try {
    let s = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON');
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    return json({ error: `Could not parse detection result: ${err.message}` }, 500);
  }

  return json({
    doc_type: String(parsed.doc_type || '').slice(0, 200),
    parties: Array.isArray(parsed.parties) ? parsed.parties.slice(0, 5).map((p) => ({
      name: String(p.name || '').slice(0, 200),
      role: String(p.role || '').slice(0, 100),
      description: String(p.description || '').slice(0, 500),
    })) : [],
    suggested_roles: Array.isArray(parsed.suggested_roles)
      ? parsed.suggested_roles.slice(0, 5).map((r) => String(r).slice(0, 100))
      : [],
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
