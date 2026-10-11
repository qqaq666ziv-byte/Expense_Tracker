import { describe, expect, it, vi } from 'vitest';
import { handleShortcutRequest, type ShortcutRpcResult } from './shortcutHandler';
import { shortcutSha256 } from './shortcutNotification';

const token = `shiba_sc_${'a'.repeat(64)}`;
const request = () => new Request('https://example.invalid/receive', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ version: 1, source: 'jkopay', title: 'Synthetic', text: 'Synthetic fixture', test: false, eventId: 'fixture-1' }),
});

function dependencies(data: unknown) {
  return { authenticate: vi.fn(async (): Promise<ShortcutRpcResult> => ({ data: true, error: null })),
    meterRejection: vi.fn(async (): Promise<ShortcutRpcResult> => ({ data: { status: 'metered' }, error: null })),
    receive: vi.fn(async (): Promise<ShortcutRpcResult> => ({ data, error: null })) };
}

describe('shortcut receive rejection contract', () => {
  it('maps committed fingerprint conflicts to a sanitized 409', async () => {
    const deps = dependencies({ error: 'event_id_payload_conflict' });
    const response = await handleShortcutRequest(request(), deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'event_id_payload_conflict' });
  });
  it.each(['shortcut_rate_limit', 'shortcut_inbox_limit'])('maps committed %s to a sanitized 429', async (code) => {
    const response = await handleShortcutRequest(request(), dependencies({ error: code }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'shortcut_limit_reached' });
  });
});

function invalidRequest(body: BodyInit | null = '{', extraHeaders: Record<string, string> = {}) {
  return new Request('https://example.invalid/receive', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
}

describe('authenticated shortcut validation failures consume quota', () => {
  it.each([
    ['malformed JSON', () => invalidRequest('{'), 400],
    ['empty body', () => invalidRequest(null), 400],
    ['invalid shape', () => invalidRequest('{}'), 400],
    ['unknown field', () => invalidRequest(JSON.stringify({ version: 1, source: 'jkopay', title: 'Synthetic', text: 'Synthetic', test: false, unexpected: token })), 400],
    ['invalid UTF-8', () => invalidRequest(new Uint8Array([255])), 400],
    ['declared oversized body', () => invalidRequest('x', { 'content-length': '8193' }), 413],
    ['invalid content length', () => invalidRequest('x', { 'content-length': '-1' }), 413],
    ['actual oversized body', () => invalidRequest('x'.repeat(8193)), 413],
    ['non-JSON', () => invalidRequest('Synthetic', { 'content-type': 'text/plain' }), 415],
    ['missing content type', () => { const req = invalidRequest('{'); req.headers.delete('content-type'); return req; }, 415],
  ] as const)('meters %s once using only a credential hash', async (_label, makeRequest, expected) => {
    const deps = dependencies(null);
    const res = await handleShortcutRequest(makeRequest(), deps);
    expect(res.status).toBe(expected);
    expect(await res.json()).toEqual({ error: expected === 415 ? 'json_content_type_required' : 'invalid_shortcut_payload' });
    expect(deps.authenticate).toHaveBeenCalledExactlyOnceWith(await shortcutSha256(token));
    expect(deps.meterRejection).toHaveBeenCalledExactlyOnceWith(await shortcutSha256(token));
    expect(deps.receive).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each([400, 413, 415])('returns 429 when a %s failure reaches shared quota', async (status) => {
    const deps = dependencies(null);
    deps.meterRejection.mockResolvedValue({ data: { error: 'shortcut_rate_limit', owner: token }, error: null });
    const req = status === 413 ? invalidRequest('x'.repeat(8193))
      : status === 415 ? invalidRequest('{', { 'content-type': 'text/plain' }) : invalidRequest('{');
    const res = await handleShortcutRequest(req, deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'shortcut_limit_reached' });
    expect(deps.meterRejection).toHaveBeenCalledTimes(1);
    expect(deps.receive).not.toHaveBeenCalled();
  });

  it('returns 401 if a credential was revoked after edge authentication', async () => {
    const deps = dependencies(null);
    deps.meterRejection.mockResolvedValue({ data: null, error: { code: '42501' } });
    const res = await handleShortcutRequest(invalidRequest('{'), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_shortcut_token' });
    expect(deps.receive).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { code: 'XX000' } },
    { data: null, error: null },
    { data: { status: 'unexpected', secret: token }, error: null },
  ])('fails closed when metering does not confirm a committed result', async (result) => {
    const deps = dependencies(null);
    deps.meterRejection.mockResolvedValue(result);
    const res = await handleShortcutRequest(invalidRequest(), deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'shortcut_service_unavailable' });
  });

  it('sanitizes thrown metering errors', async () => {
    const deps = dependencies(null);
    deps.meterRejection.mockRejectedValue(new Error(token));
    const res = await handleShortcutRequest(invalidRequest(), deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'shortcut_service_unavailable' });
  });

  it.each(['42501', '53300', '54000'])('preserves the metering SQL error %s contract', async (code) => {
    const deps = dependencies(null);
    deps.meterRejection.mockResolvedValue({ data: null, error: { code } });
    expect((await handleShortcutRequest(invalidRequest(), deps)).status).toBe(code === '42501' ? 401 : 429);
  });

  it('does not meter an unknown or already revoked credential', async () => {
    const deps = dependencies(null);
    deps.authenticate.mockResolvedValue({ data: false, error: null });
    const res = await handleShortcutRequest(invalidRequest(), deps);
    expect(res.status).toBe(401);
    expect(deps.meterRejection).not.toHaveBeenCalled();
    expect(deps.receive).not.toHaveBeenCalled();
  });

  it('does not authenticate or meter a missing bearer token', async () => {
    const deps = dependencies(null);
    const req = invalidRequest(); req.headers.delete('authorization');
    expect((await handleShortcutRequest(req, deps)).status).toBe(401);
    expect(deps.authenticate).not.toHaveBeenCalled();
    expect(deps.meterRejection).not.toHaveBeenCalled();
    expect(deps.receive).not.toHaveBeenCalled();
  });

  it('keeps a valid intake on its single existing metering path', async () => {
    const deps = dependencies({ status: 'pending', id: 'synthetic-id', duplicate: false });
    expect((await handleShortcutRequest(request(), deps)).status).toBe(200);
    expect(deps.receive).toHaveBeenCalledTimes(1);
    expect(deps.meterRejection).not.toHaveBeenCalled();
  });

  it.each(['22023', '23514'])('meters SQL validation error %s after receive rolls back', async (code) => {
    const deps = dependencies(null);
    deps.receive.mockResolvedValue({ data: null, error: { code } });
    const res = await handleShortcutRequest(request(), deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_shortcut_payload' });
    expect(deps.receive).toHaveBeenCalledTimes(1);
    expect(deps.meterRejection).toHaveBeenCalledExactlyOnceWith(await shortcutSha256(token));
  });

  it('accepts a valid body exactly at the byte boundary without rejection metering', async () => {
    const deps = dependencies({ status: 'pending', id: 'synthetic-id', duplicate: false });
    const body = await request().text();
    expect((await handleShortcutRequest(invalidRequest(body + ' '.repeat(8192 - new TextEncoder().encode(body).length)), deps)).status).toBe(200);
    expect(deps.receive).toHaveBeenCalledTimes(1);
    expect(deps.meterRejection).not.toHaveBeenCalled();
  });

  it('cancels an oversized stream and preserves 413 if cancellation rejects', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8193)); },
      cancel() { canceled = true; return Promise.reject(new Error(token)); },
    });
    const deps = dependencies(null);
    const res = await handleShortcutRequest(invalidRequest(stream), deps);
    expect(canceled).toBe(true);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'invalid_shortcut_payload' });
    expect(deps.meterRejection).toHaveBeenCalledTimes(1);
  });

  it('meters a stream read failure without leaking its exception', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(token)); } });
    const deps = dependencies(null);
    const res = await handleShortcutRequest(invalidRequest(stream), deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_shortcut_payload' });
    expect(deps.meterRejection).toHaveBeenCalledTimes(1);
    expect(deps.receive).not.toHaveBeenCalled();
  });
});
