/**
 * Client-side API wrapper — calls Netlify Functions with the user's
 * Supabase access token attached as a Bearer header.
 *
 * All contract-review endpoints go through here so auth is uniform.
 */
import { getSupabase } from './supabase';

async function authHeader(): Promise<Record<string, string>> {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return { Authorization: `Bearer ${token}` };
}

/**
 * Read a Response as JSON, but if the body is plaintext (e.g. a Netlify
 * function timeout page that starts with "TimeoutError: ..."), surface a
 * readable error instead of a cryptic "Unexpected token T ... is not
 * valid JSON".
 */
async function parseResponse(res: Response, labelOnFail: string): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON response. Almost always a timeout or a crash page.
    if (!res.ok) {
      const snippet = text.slice(0, 180).trim();
      if (snippet.toLowerCase().startsWith('timeouterror')) {
        throw new Error(
          `${labelOnFail} timed out — the function took longer than its configured limit. Try again, or reduce the input size.`,
        );
      }
      throw new Error(`${labelOnFail} failed (${res.status}): ${snippet || 'non-JSON response'}`);
    }
    throw new Error(`${labelOnFail}: server returned non-JSON body.`);
  }
  if (!res.ok) throw new Error(body.error || `${labelOnFail} failed (${res.status})`);
  return body;
}

export async function startReview(
  file: File,
  dealPosture: string,
): Promise<StartReviewResponse> {
  const headers = await authHeader();
  const fd = new FormData();
  fd.append('file', file);
  fd.append('deal_posture', dealPosture);
  const res = await fetch('/.netlify/functions/start-review', { method: 'POST', headers, body: fd });
  return parseResponse(res, 'Start review');
}

export interface GoverningAgreementContext {
  mode: 'summary' | 'file';
  text?: string;
  storage_key?: string;
}

export async function confirmReview(
  reviewId: string,
  pipelineMode: 'express' | 'standard' | 'comprehensive',
  governingAgreementContext?: GoverningAgreementContext | null,
): Promise<{ ok: boolean; review_id: string }> {
  const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
  const res = await fetch('/.netlify/functions/confirm-review', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      review_id: reviewId,
      pipeline_mode: pipelineMode,
      governing_agreement_context: governingAgreementContext ?? null,
    }),
  });
  return parseResponse(res, 'Confirm review');
}

export async function getReview(reviewId: string): Promise<GetReviewResponse> {
  const headers = await authHeader();
  const res = await fetch(`/.netlify/functions/get-review?review_id=${encodeURIComponent(reviewId)}`, { headers });
  return parseResponse(res, 'Get review');
}

export async function uploadPlaybook(file: File): Promise<UploadPlaybookResponse> {
  const headers = await authHeader();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/.netlify/functions/upload-playbook', { method: 'POST', headers, body: fd });
  return parseResponse(res, 'Build profile');
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }
export interface ChatResponse {
  reply: string;
  profile: Record<string, unknown> | null;
  done: boolean;
  messages_remaining: number;
}

export interface ChatContext {
  /** Profile already persisted to DB, if any. */
  saved_profile?: Record<string, unknown> | null;
  /** Snapshot of the form the user is filling right now (brainstorm mode). */
  form_state?: Record<string, string>;
  /** 'brainstorm' = help fill a form; 'interview' = traditional profile-build chat. */
  mode?: 'brainstorm' | 'interview';
}

export async function configuratorChat(
  messages: ChatMessage[],
  finalize = false,
  context: ChatContext | null = null,
): Promise<ChatResponse> {
  const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
  const res = await fetch('/.netlify/functions/configurator-chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, finalize, context }),
  });
  return parseResponse(res, 'Chat');
}

export async function saveProfile(profile: unknown): Promise<SaveProfileResponse> {
  const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
  const res = await fetch('/.netlify/functions/save-profile', {
    method: 'POST',
    headers,
    body: JSON.stringify({ profile_json: profile }),
  });
  return parseResponse(res, 'Save profile');
}

/** Poll get-review until status is 'complete' or 'failed', or timeout. */
export async function pollReview(
  reviewId: string,
  onProgress?: (r: GetReviewResponse) => void,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<GetReviewResponse> {
  const intervalMs = opts.intervalMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000; // 15 min
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await getReview(reviewId);
    onProgress?.(snapshot);
    if (snapshot.review.status === 'complete' || snapshot.review.status === 'failed') {
      return snapshot;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Review timed out — check /archive later.');
}

/** List the user's reviews (for the Archive view) — uses Supabase directly. */
export async function listReviews() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('reviews')
    .select('id, filename, contract_type, pipeline_mode, status, severity_counts, created_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

/** Current profile (null if user hasn't onboarded). */
export async function getProfile() {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('company_profiles')
    .select('profile_json, updated_at')
    .maybeSingle();
  return data?.profile_json || null;
}

// ---------- types ----------
export interface StartReviewResponse {
  ok: boolean;
  review_id: string;
  contract_type: string;
  pipeline_mode: string;
  confidence: number;
  is_subordinate: boolean;
  reasoning: string;
  quota: { used: number; cap: number; remaining: number; tier: string };
  profile_mode: 'configured' | 'baseline_only';
  deal_posture: string | null;
}

export interface GetReviewResponse {
  review: {
    id: string;
    filename: string;
    contract_type: string | null;
    pipeline_mode: string | null;
    status: 'queued' | 'classifying' | 'analyzing' | 'auditing' | 'compiling' | 'complete' | 'failed';
    progress_message: string | null;
    severity_counts: { blocker: number; major: number; moderate: number; minor: number };
    error_message: string | null;
    total_tokens: number;
    cost_usd: number;
    created_at: string;
    completed_at: string | null;
  };
  downloads: { annotated?: string; summary?: string; findings_json?: string };
  quota: { used: number; cap: number };
}

export interface UploadPlaybookResponse {
  ok: boolean;
  profile: Record<string, unknown>;
  playbook_storage_key: string;
  source_format: string;
}

export interface SaveProfileResponse {
  ok: boolean;
  profile_id: string;
  updated_at: string;
}
