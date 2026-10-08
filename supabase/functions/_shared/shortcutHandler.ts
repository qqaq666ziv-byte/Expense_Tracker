import { parseShortcutNotification, shortcutEventIdentity, shortcutSha256, validateShortcutPayload } from './shortcutNotification.ts';

export interface ShortcutRpcResult {
  data: unknown;
  error: { code?: string } | null;
}

export interface ShortcutReceiverDependencies {
  authenticate(hash: string): Promise<ShortcutRpcResult>;
  receive(parameters: Record<string, unknown>): Promise<ShortcutRpcResult>;
}

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MAX_BYTES = 8192;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error('payload_too_large');
  if (!request.body) throw new Error('invalid_body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error('payload_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
}

/** HTTP boundary is dependency-injected for real Request/Response tests. */
export async function handleShortcutRequest(request: Request, dependencies: ShortcutReceiverDependencies | null): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
  const token = /^Bearer (shiba_sc_[0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return response(401, { error: 'shortcut_authentication_required' });
  if (!dependencies) return response(503, { error: 'shortcut_service_unavailable' });
  try {
    const tokenHash = await shortcutSha256(token);
    // Validate the credential before parsing or storing any notification. The
    // intake RPC checks it again while holding the revocation/owner lock.
    const authentication = await dependencies.authenticate(tokenHash);
    if (authentication.error) return response(503, { error: 'shortcut_service_unavailable' });
    if (authentication.data !== true) return response(401, { error: 'invalid_shortcut_token' });
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return response(415, { error: 'json_content_type_required' });
    }
    let payload;
    try {
      payload = validateShortcutPayload(await readBoundedJson(request));
    } catch (error) {
      return response(error instanceof Error && error.message === 'payload_too_large' ? 413 : 400, { error: 'invalid_shortcut_payload' });
    }
    const parsed = parseShortcutNotification(payload);
    const identity = await shortcutEventIdentity(payload);
    const result = await dependencies.receive({
      p_token_hash: tokenHash, p_event_key: identity.eventKey, p_fingerprint: identity.fingerprint,
      p_payload: payload, p_amount: parsed.amount, p_merchant: parsed.merchant,
      p_occurred_at: parsed.occurredAt, p_format: parsed.format,
      p_auto_eligible: parsed.autoEligible, p_reason: parsed.reason,
    });
    if (result.error) {
      const code = result.error.code;
      if (code === '42501') return response(401, { error: 'invalid_shortcut_token' });
      if (code === '53300' || code === '54000') return response(429, { error: 'shortcut_limit_reached' });
      if (code === '23505') return response(409, { error: 'event_id_payload_conflict' });
      if (code === '22023' || code === '23514') return response(400, { error: 'invalid_shortcut_payload' });
      return response(503, { error: 'shortcut_service_unavailable' });
    }
    const data = result.data as Record<string, unknown> | null;
    if (data?.error === 'event_id_payload_conflict') return response(409, { error: 'event_id_payload_conflict' });
    if (data?.error === 'shortcut_rate_limit' || data?.error === 'shortcut_inbox_limit') {
      return response(429, { error: 'shortcut_limit_reached' });
    }
    if (!data || !['pending', 'imported', 'ignored', 'test'].includes(String(data.status))
      || typeof data.id !== 'string' || typeof data.duplicate !== 'boolean') {
      return response(503, { error: 'shortcut_service_unavailable' });
    }
    // Never return account names, raw text, owner IDs or connection credentials.
    return response(200, { status: data.status, id: data.id, duplicate: data.duplicate });
  } catch {
    // No raw exception logging: request bodies and credentials are private.
    return response(503, { error: 'shortcut_service_unavailable' });
  }
}
