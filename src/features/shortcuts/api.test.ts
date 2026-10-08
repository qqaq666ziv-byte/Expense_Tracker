import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShortcutApi, createShortcutSecret, ShortcutApiError } from './api';

vi.mock('../../lib/supabaseClient', () => ({
  supabase: null,
  isBrowserSafeSupabaseKey: (key: string | undefined) => !!key && !key.startsWith('sb_secret_'),
}));

const connection = {
  id: 'connection-a', label: '測試手機', mode: 'review', account_id: null, category_id: null,
  verified_at: null, revoked_at: null, created_at: '2026-01-02T00:00:00.000Z',
};

function setup() {
  const fetcher = vi.fn(async () => new Response(JSON.stringify([connection]), { status: 200 }));
  const getSession = vi.fn(async () => ({ data: { session: { access_token: 'test-owner-a-bearer', user: { id: 'owner-a' } } } }));
  return {
    fetcher, getSession,
    api: createShortcutApi({ url: 'https://example.invalid', anonKey: 'test-public-key', getSession, fetcher }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('shortcut API owner and credential boundaries', () => {
  it('rejects guest and mismatched sessions before making a network request', async () => {
    const { api, fetcher } = setup();
    await expect(api.listConnections('guest')).rejects.toMatchObject({ kind: 'auth' });
    await expect(api.listInbox('owner-b')).rejects.toMatchObject({ kind: 'auth' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('captures the current owner bearer without putting it in the URL or body', async () => {
    const { api, fetcher, getSession } = setup();
    await api.listConnections('owner-a');
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-owner-b-bearer', user: { id: 'owner-b' } } } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.invalid/rest/v1/rpc/finance_shortcut_list_connections');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-owner-a-bearer' });
    expect(init.body).toBe('{}');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    await expect(api.listConnections('owner-a')).rejects.toMatchObject({ kind: 'auth' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('creates cryptographically independent tokens and only submits a complete-token SHA-256 hash', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const first = await createShortcutSecret();
    const second = await createShortcutSecret();
    expect(first.token).toMatch(/^shiba_sc_[a-f0-9]{64}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toBe(createHash('sha256').update(first.token).digest('hex'));
    const { api, fetcher } = setup();
    await api.create('owner-a', '測試手機', first.tokenHash);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ p_label: '測試手機', p_token_hash: first.tokenHash });
    expect(String(init.body)).not.toContain(first.token);
  });

  it('sanitizes server errors containing private details and recognizes missing migrations', async () => {
    const { api, fetcher } = setup();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PGRST202', message: 'private row contents' }), { status: 404 }));
    await expect(api.listConnections('owner-a')).rejects.toMatchObject({ kind: 'unavailable' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: '23514', message: 'private row contents' }), { status: 400 }));
    const error = await api.listConnections('owner-a').catch((caught) => caught);
    expect(error).toBeInstanceOf(ShortcutApiError);
    expect(error.message).not.toContain('private row contents');
  });

  it('refuses unsafe service addresses and secret API keys', async () => {
    const { getSession, fetcher } = setup();
    const credentialsUrl = new URL('https://example.invalid');
    credentialsUrl.username = 'test-user';
    credentialsUrl.password = 'test-password';
    for (const url of [credentialsUrl.href, 'http://remote.invalid', 'https://example.invalid?token=x']) {
      const api = createShortcutApi({ url, anonKey: 'test-public-key', getSession, fetcher });
      expect(api.endpoint).toBeNull();
      await expect(api.listConnections('owner-a')).rejects.toMatchObject({ kind: 'unavailable' });
    }
    const unsafe = createShortcutApi({ url: 'https://example.invalid', anonKey: 'sb_secret_' + 'test-only', getSession, fetcher });
    await expect(unsafe.listInbox('owner-a')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose extra server fields or accept malformed inbox statuses', async () => {
    const { api, fetcher } = setup();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([{ ...connection, token_hash: 'internal-only' }])));
    const result = await api.listConnections('owner-a');
    expect(result[0]).not.toHaveProperty('token_hash');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'notice-a', status: 'unexpected' }])));
    await expect(api.listInbox('owner-a')).rejects.toMatchObject({ kind: 'request' });
  });

  it('requests a bounded pending keyset page and validates its contract', async () => {
    const { api, fetcher } = setup();
    const item = { id: 'pending-a', connection_id: 'connection-a', amount: 12, merchant: 'Synthetic', occurred_at: null,
      status: 'pending', transaction_id: null, reason: 'review', payload: {}, created_at: '2026-01-01T00:00:00Z' };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ items: [item], pending_count: 125, has_more: true,
      next_created_at: item.created_at, next_id: item.id })));
    const page = await api.listPending('owner-a', null);
    expect(page.items).toHaveLength(1);
    expect(page.pending_count).toBe(125);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('finance_shortcut_list_pending');
    expect(JSON.parse(String(init.body))).toEqual({
      p_before_created_at: null, p_before_id: null, p_limit: 100,
    });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], pending_count: 125, has_more: true,
      next_created_at: null, next_id: null })));
    await expect(api.listPending('owner-a', { created_at: item.created_at, id: item.id })).rejects.toMatchObject({ kind: 'request' });
  });

  it('reports network failures without leaking their text', async () => {
    const { api, fetcher } = setup();
    fetcher.mockRejectedValueOnce(new Error('private network details'));
    const error = await api.listInbox('owner-a').catch((caught) => caught);
    expect(error).toMatchObject({ kind: 'network' });
    expect(error.message).not.toContain('private network details');
  });

  it('requires an explicit stable-ID confirmation for auto and sends false in review mode', async () => {
    const { api, fetcher } = setup();
    const configuration = { id: connection.id, accountId: 'account-a', categoryId: 'category-a', mode: 'auto' as const, stableEventIdConfirmed: false };
    await expect(api.configure('owner-a', configuration)).rejects.toMatchObject({ kind: 'stable-event-id-required' });
    expect(fetcher).not.toHaveBeenCalled();
    await api.configure('owner-a', { ...configuration, stableEventIdConfirmed: true });
    const [, autoRequest] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(autoRequest.body))).toEqual({
      p_id: connection.id, p_account_id: 'account-a', p_category_id: 'category-a', p_mode: 'auto', p_stable_event_id_confirmed: true,
    });
    await api.configure('owner-a', { ...configuration, mode: 'review', stableEventIdConfirmed: true });
    const [, reviewRequest] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(reviewRequest.body))).toMatchObject({ p_mode: 'review', p_stable_event_id_confirmed: false });
  });

  it('maps only exact stable-ID and active-auto server errors to safe guidance', async () => {
    const { api, fetcher } = setup();
    const configuration = { id: connection.id, accountId: 'account-a', categoryId: 'category-a', mode: 'auto' as const, stableEventIdConfirmed: true };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: '23514', message: 'stable_event_id_confirmation_required' }), { status: 400 }));
    await expect(api.configure('owner-a', configuration)).rejects.toMatchObject({ kind: 'stable-event-id-required', message: expect.stringContaining('iPhone 重送測試') });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: '23514', message: 'active_auto_connection_exists' }), { status: 400 }));
    await expect(api.configure('owner-a', configuration)).rejects.toMatchObject({ kind: 'active-auto-connection', message: expect.stringContaining('不會自動停用其他連線') });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: '23514', message: 'active_auto_connection_exists private details' }), { status: 400 }));
    const error = await api.configure('owner-a', configuration).catch((caught) => caught);
    expect(error.kind).toBe('request');
    expect(error.message).not.toContain('private details');
  });
});
