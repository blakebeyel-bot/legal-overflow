/**
 * Supabase admin client — uses the service_role key, bypasses RLS.
 *
 * NEVER import this from browser-facing code. ONLY from Netlify Functions.
 *
 * The service_role key lives in Netlify env vars as SUPABASE_SERVICE_ROLE_KEY.
 * If it's missing, every function that tries to do privileged writes (create
 * review rows, update progress, upload to buckets) will fail loudly — which
 * is the correct failure mode.
 */
import { createClient } from '@supabase/supabase-js';

let adminClient = null;

export function getSupabaseAdmin() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'Supabase admin client missing env vars. ' +
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify dashboard → Site settings → Environment variables.'
    );
  }
  adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}

/**
 * Verify a user's access token (sent from the browser) and return the user.
 * Called at the top of every authenticated function.
 */
export async function requireUser(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing Authorization header', status: 401 };
  }
  const token = authHeader.slice(7);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { error: 'Invalid or expired session', status: 401 };
  }
  return { user: data.user };
}

/**
 * Quota check — trial users get 3 reviews per 30-day window.
 * Reads the reviews_current_window view (SQL defined in migration 0001).
 */
export async function checkReviewQuota(userId) {
  const supabase = getSupabaseAdmin();
  const { data: profile } = await supabase
    .from('profiles')
    .select('tier, review_cap_override')
    .eq('id', userId)
    .single();
  const tier = profile?.tier || 'trial';

  const limits = {
    trial: 3,
    standard: 25,
    pro: 100,
    admin: 9999,
    enterprise: Infinity,
  };
  // Per-user override (set from /admin/users/) takes precedence over the
  // tier default. Null = use tier default.
  const cap = (profile?.review_cap_override != null && profile.review_cap_override >= 0)
    ? profile.review_cap_override
    : (limits[tier] ?? 3);

  const { data: window } = await supabase
    .from('reviews_current_window')
    .select('reviews_total')
    .eq('user_id', userId)
    .maybeSingle();
  const used = window?.reviews_total || 0;

  return {
    allowed: used < cap,
    used,
    remaining: Math.max(0, cap - used),
    cap,
    tier,
  };
}

/**
 * Admin gate. Returns { ok: true, user } when the caller's profile has
 * tier='admin', else { ok: false, status }. Used by every /api/admin/*
 * endpoint to keep the approve-user / set-quota actions out of regular
 * users' reach.
 */
export async function requireAdmin(authHeader) {
  const auth = await requireUser(authHeader);
  if (auth.error) return { ok: false, status: auth.status, error: auth.error };
  const supabase = getSupabaseAdmin();
  const { data: profile } = await supabase
    .from('profiles')
    .select('tier')
    .eq('id', auth.user.id)
    .single();
  if (profile?.tier !== 'admin') {
    return { ok: false, status: 403, error: 'Admin only' };
  }
  return { ok: true, user: auth.user };
}

/**
 * Approval gate for the agent endpoints. New signups land in a pending
 * state (profiles.approved_at is null); the operator approves them
 * manually before they can run any agent that costs money or touches a
 * third-party document. See migrations/0012_profiles_approval_gate.sql.
 *
 * Returns { approved: boolean, profile: row | null }. Callers should
 * 403 on `approved === false`.
 */
export async function checkUserApproval(userId) {
  const supabase = getSupabaseAdmin();
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, tier, approved_at')
    .eq('id', userId)
    .single();
  if (!profile) return { approved: false, profile: null };
  return {
    approved: !!profile.approved_at,
    profile,
  };
}

/**
 * Quota check for the citation verifier — same shape as checkReviewQuota,
 * counted against verification_runs in the last 30 days. Trial users get
 * 3 verifications per window; tier limits scale to higher caps for paid
 * plans. Same return contract as checkReviewQuota so the client UI can
 * render either quota with a single component.
 */
export async function checkCitationQuota(userId) {
  const supabase = getSupabaseAdmin();
  const { data: profile } = await supabase
    .from('profiles')
    .select('tier, citation_cap_override')
    .eq('id', userId)
    .single();
  const tier = profile?.tier || 'trial';

  const limits = {
    trial: 3,
    standard: 25,
    pro: 100,
    admin: 9999,
    enterprise: Infinity,
  };
  const cap = (profile?.citation_cap_override != null && profile.citation_cap_override >= 0)
    ? profile.citation_cap_override
    : (limits[tier] ?? 3);

  // Count verifications started in the last 30 days. We count any row,
  // not only completed/successful ones — kicking off a run consumes the
  // API budget regardless of how it terminates, so quota should reflect
  // attempts, not only successes.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('verification_runs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);
  const used = count || 0;

  return {
    allowed: used < cap,
    used,
    remaining: Math.max(0, cap - used),
    cap,
    tier,
  };
}

/**
 * Record a single Anthropic API call to usage_events.
 * Call this after every specialist completes (success or failure).
 */
export async function recordUsage({ userId, reviewId, agentName, usage }) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('usage_events').insert({
    user_id: userId,
    review_id: reviewId,
    agent_name: agentName,
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cache_read_tokens: usage?.cache_read_input_tokens || 0,
    cache_write_tokens: usage?.cache_creation_input_tokens || 0,
  });
  if (error) console.error('recordUsage failed', error);
}
