import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { handleShortcutRequest } from '../_shared/shortcutHandler.ts';

/** verify_jwt=false is required for a custom, revocable write-only credential. */
export async function handleShortcutReceive(request: Request): Promise<Response> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) return handleShortcutRequest(request, null);
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleShortcutRequest(request, {
    authenticate: async (hash) => admin.rpc('finance_shortcut_authenticate', { p_token_hash: hash }),
    meterRejection: async (hash) => admin.rpc('finance_shortcut_meter_rejection', { p_token_hash: hash }),
    receive: async (parameters) => admin.rpc('finance_shortcut_receive', parameters),
  });
}

if (import.meta.main) Deno.serve(handleShortcutReceive);
