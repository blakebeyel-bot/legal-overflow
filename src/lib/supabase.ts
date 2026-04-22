/**
 * Supabase browser client — safe to import from Astro pages and UI scripts.
 *
 * Uses only the public anon key, which is meant to be exposed in client code.
 * Row-Level Security on every table restricts what the anon key can do.
 *
 * For server-side code that needs to bypass RLS (Netlify Functions that
 * create review rows, update progress, etc.), use the service_role key from
 * Netlify env vars — do NOT import from this file.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://vgthztpvxvwwfvyretec.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZndGh6dHB2eHZ3d2Z2eXJldGVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MTMyMjgsImV4cCI6MjA5MjM4OTIyOH0.ukEhVKl0JK5cAuvaYAzRgHXpqoqY9siH2Wjmg6kGhNQ';

let browserClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (browserClient) return browserClient;
  browserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });
  return browserClient;
}
