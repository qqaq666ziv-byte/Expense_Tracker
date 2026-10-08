import { describe, expect, it, vi } from 'vitest';
import { handleShortcutRequest } from './shortcutHandler';

const token = `shiba_sc_${'a'.repeat(64)}`;
const request = () => new Request('https://example.invalid/receive', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ version: 1, source: 'jkopay', title: 'Synthetic', text: 'Synthetic fixture', test: false, eventId: 'fixture-1' }),
});

function dependencies(data: unknown) {
  return { authenticate: vi.fn(async () => ({ data: true, error: null })),
    receive: vi.fn(async () => ({ data, error: null })) };
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
