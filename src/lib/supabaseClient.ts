import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export function isBrowserSafeSupabaseKey(value: string | undefined): boolean {
  if (!value || value.startsWith('sb_secret_')) return false;
  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown };
      if (payload.role === 'service_role') return false;
    } catch {
      // Non-JWT publishable keys are valid; createClient performs final format validation.
    }
  }
  return true;
}

export const supabaseConfigured = Boolean(supabaseUrl && isBrowserSafeSupabaseKey(supabaseAnonKey));

/** Public browser client only. A service-role key must never be used here. */
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
