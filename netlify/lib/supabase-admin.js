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
    .select('tier')
    .eq('id', userId)
    .single();
  const tier = profile?.tier || 'trial';

  const limits = {
    trial: 3,
    standard: 25,
    pro: 100,
    enterprise: Infinity,
  };
  const cap = limits[tier] ?? 3;

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
