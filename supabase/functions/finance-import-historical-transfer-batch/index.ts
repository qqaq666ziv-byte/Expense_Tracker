import { createClient } from 'npm:@supabase/supabase-js@2.112.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type JsonRecord = Record<string, unknown>;

function response(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredArray(body: JsonRecord, key: string, maximum: number): JsonRecord[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > maximum || value.some((row) => !isRecord(row))) {
    throw new Error(`invalid ${key}`);
  }
  return value as JsonRecord[];
}

function validateOwnedRows(rows: JsonRecord[], ownerId: string, label: string): void {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.id;
    if (row.user_id !== ownerId || typeof id !== 'string' || id.length === 0 || ids.has(id)) {
      throw new Error(`invalid or foreign ${label}`);
    }
    ids.add(id);
  }
}

export function validateManifest(body: JsonRecord, ownerId: string) {
  const intent = body.intent;
  const batchId = body.batch_id;
  const expectedPrefix = intent === 'guest-import'
    ? 'historical-import:guest:'
    : intent === 'backup-restore'
      ? 'historical-import:restore:'
      : undefined;
  if (!expectedPrefix || typeof batchId !== 'string' || !batchId.startsWith(expectedPrefix)
    || batchId.length > 512) {
    throw new Error('invalid historical import intent or batch id');
  }

  const accountOperations = requiredArray(body, 'account_operations', 25_000);
  const endpointAccounts = requiredArray(body, 'endpoint_accounts', 50_000);
  const transferOperations = requiredArray(body, 'transfer_operations', 25_000);
  if (transferOperations.length === 0) throw new Error('historical import requires transfers');
  validateOwnedRows(accountOperations, ownerId, 'account operation');
  validateOwnedRows(endpointAccounts, ownerId, 'endpoint manifest');
  validateOwnedRows(transferOperations, ownerId, 'transfer operation');

  const endpointIds = new Set(endpointAccounts.map((row) => row.id as string));
  for (const transfer of transferOperations) {
    const sourceId = transfer.source_account_id;
    const destinationId = transfer.destination_account_id;
    if (typeof sourceId !== 'string' || typeof destinationId !== 'string'
      || sourceId === destinationId || !endpointIds.has(sourceId) || !endpointIds.has(destinationId)) {
      throw new Error('historical import endpoint manifest is incomplete');
    }
  }

  return { batchId, accountOperations, endpointAccounts, transferOperations };
}

export async function handleHistoricalImport(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return response(405, { error: 'method not allowed' });

  const authorization = request.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!authorization || !supabaseUrl || !publicKey || !serviceRoleKey) {
    return response(401, { error: 'historical import authorization is unavailable' });
  }

  const userClient = createClient(supabaseUrl, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return response(401, { error: 'authentication required' });

  let manifest: ReturnType<typeof validateManifest>;
  try {
    const body = await request.json();
    if (!isRecord(body)) throw new Error('invalid request body');
    manifest = validateManifest(body, user.id);
  } catch (error) {
    return response(400, { error: error instanceof Error ? error.message : 'invalid manifest' });
  }

  // This credential never crosses the server boundary. The database RPC is
  // executable only by service_role, and receives the owner derived from the
  // verified JWT rather than trusting a browser-supplied owner parameter.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('finance_import_historical_transfer_batch', {
    p_owner_id: user.id,
    p_batch_id: manifest.batchId,
    p_account_operations: manifest.accountOperations,
    p_endpoint_accounts: manifest.endpointAccounts,
    p_transfer_operations: manifest.transferOperations,
  });
  if (error) return response(409, { error: 'historical import was not committed', code: error.code });
  return response(200, data);
}

if (import.meta.main) Deno.serve(handleHistoricalImport);
