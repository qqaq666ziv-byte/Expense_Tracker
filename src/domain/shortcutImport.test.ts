import { describe, expect, it, vi } from 'vitest';
import {
  normalizeShortcutAmount, normalizeShortcutTimestamp, parseShortcutNotification,
  shortcutEventIdentity, shortcutSha256, validateShortcutPayload,
} from '../../supabase/functions/_shared/shortcutNotification';
import { handleShortcutRequest, type ShortcutReceiverDependencies } from '../../supabase/functions/_shared/shortcutHandler';

// All fixtures are synthetic; no user screenshot, merchant or amount is stored.
const simple = {
  version: 1, source: 'jkopay', title: '扣款通知',
  text: '您有一筆來自Example Services的授權扣款訂單，已於 2026/01/02 07:47 成功扣款 $1234',
  test: false,
} as const;
const mixed = {
  ...simple,
  text: '您有一筆來自Example Services的授權扣款$1234訂單，已於 2026/01/02 07:47 自動儲值 $1234 至您的街口帳戶，並已於 2026/01/02 07:47 使用街口幣折抵 $8 元、街口券折抵 $50 元成功扣款 $1234',
};

describe('shortcut notification proposals', () => {
  it('pre-fills final debit from mixed top-up/reward content, never auto eligible', () => {
    expect(parseShortcutNotification(mixed)).toEqual({ amount: '1234.00', merchant: 'Example Services',
      occurredAt: '2026-01-01T23:47:00.000Z', confidence: 'review', reason: 'topup_requires_review', format: null, autoEligible: false });
  });

  it('recognizes only the small single-debit candidate template', () => {
    expect(parseShortcutNotification(simple)).toMatchObject({ amount: '1234.00', confidence: 'strict',
      autoEligible: true, format: 'jkopay-single-debit-v1' });
    expect(parseShortcutNotification({ ...simple, text: `${simple.text} 立即參加抽獎` }).autoEligible).toBe(false);
    expect(parseShortcutNotification({ ...simple, title: '優惠通知' }).autoEligible).toBe(false);
    expect(parseShortcutNotification({ ...simple, text: `${simple.text}；其他文字` }).autoEligible).toBe(false);
  });

  it.each(['退款', '退貨', '取消', '轉帳', '失敗', '收款', 'refund', 'transfer'])("does not treat %s as an expense", (word) => {
    expect(parseShortcutNotification({ ...simple, text: `${simple.text} ${word}` })).toMatchObject({ autoEligible: false, amount: null, reason: 'non_expense_notice' });
  });

  it('multiple amounts and discount text remain pending proposals', () => {
    expect(parseShortcutNotification({ ...simple, text: `${simple.text}，折抵 $50` })).toMatchObject({ amount: '1234.00', reason: 'multiple_amounts', autoEligible: false });
  });

  it('structured fields never by themselves prove the payment format', () => {
    expect(parseShortcutNotification({ source: 'jkopay', title: '', text: 'Unknown notification',
      amount: '12.50', merchant: 'Test shop', occurredAt: '2026-01-02T07:47:00+08:00', kind: 'expense',
    })).toMatchObject({ amount: '12.50', reason: 'structured_requires_review', autoEligible: false, format: null });
    expect(parseShortcutNotification({ ...simple, amount: '99' })).toMatchObject({ autoEligible: false, reason: 'structured_mismatch' });
  });

  it('does not invent a transaction timestamp for an unknown raw message', () => {
    expect(parseShortcutNotification({ source: 'jkopay', title: '', text: 'Successful purchase', amount: '1' }))
      .toMatchObject({ occurredAt: null, reason: 'no_timestamp', autoEligible: false });
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '1e3', '1,234', '1.234', '100000000.01', '01', '', ' 1'])('rejects unsafe amount %s', (value) => {
    expect(normalizeShortcutAmount(value)).toBeNull();
  });
  it('uses exact decimal cents and bounds money', () => {
    expect(normalizeShortcutAmount('0.01')).toBe('0.01');
    expect(normalizeShortcutAmount('100000000')).toBe('100000000.00');
    expect(normalizeShortcutAmount('125.5')).toBe('125.50');
  });
  it.each(['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00',
    '2026-01-01T00:00:00+14:01', '1999-01-01T00:00:00Z', 'Infinity'])('rejects invalid or ambiguous date %s', (value) => {
    expect(normalizeShortcutTimestamp(value)).toBeNull();
  });
  it('normalizes timezone without changing instant', () => {
    expect(normalizeShortcutTimestamp('2026-01-02T07:47:00+08:00')).toBe('2026-01-01T23:47:00.000Z');
  });
  it.each([{ user_id: 'another-owner' }, { account_id: 'other-account' }, { source: 'linepay' },
    { test: 'false' }, { amount: 1234 }, { kind: 'income' }, { eventId: '' }, { text: '字'.repeat(2001) },
    { merchant: 'x'.repeat(161) }, { occurredAt: '2026-02-30T00:00:00Z' }])('rejects an invalid or caller-directed field %j', (change) => {
    expect(() => validateShortcutPayload({ ...simple, ...change })).toThrow();
  });
  it.each([undefined, null, 0, 1, 'true', 'false'])('requires an explicit boolean test flag instead of inferring intent from %j', (test) => {
    expect(() => validateShortcutPayload({ ...simple, test })).toThrow();
  });
  it.each([true, false])('preserves explicit test=%s while normalizing optional fields', (test) => {
    expect(validateShortcutPayload({ ...simple, test, amount: '12.5' })).toMatchObject({ test, amount: '12.50' });
  });
  it('stable source IDs distinguish real vs test and expose content changes separately', async () => {
    const first = await shortcutEventIdentity(validateShortcutPayload({ ...simple, eventId: 'source-event-1' }));
    const retry = await shortcutEventIdentity(validateShortcutPayload({ ...simple, eventId: 'source-event-1' }));
    const changed = await shortcutEventIdentity(validateShortcutPayload({ ...simple, eventId: 'source-event-1', text: 'Different' }));
    const test = await shortcutEventIdentity(validateShortcutPayload({ ...simple, eventId: 'source-event-1', test: true }));
    expect(retry).toEqual(first);
    expect(changed.eventKey).toBe(first.eventKey);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(test.eventKey).not.toBe(first.eventKey);
  });
  it('normalizes timestamp offsets before content fingerprinting', async () => {
    const first = await shortcutEventIdentity(validateShortcutPayload({ ...simple, occurredAt: '2026-01-02T07:47:00+08:00' }));
    const second = await shortcutEventIdentity(validateShortcutPayload({ ...simple, occurredAt: '2026-01-01T23:47:00Z' }));
    expect(first).toEqual(second);
    expect(first.eventKey).toMatch(/^fp:[a-f0-9]{64}$/);
  });
});

describe('shortcut HTTP boundary', () => {
  const token = `shiba_sc_${'a'.repeat(64)}`;
  function request(body: unknown = simple, authorization: string | null = `Bearer ${token}`, extra: Record<string, string> = {}) {
    return new Request('https://example.invalid/finance-shortcut-receive', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}), ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body) });
  }
  function dependencies() {
    return {
      authenticate: vi.fn(async () => ({ data: true, error: null })),
      receive: vi.fn(async () => ({ data: { status: 'pending', id: 'test-id', duplicate: false, user_id: 'private' }, error: null })),
    } as ShortcutReceiverDependencies & { authenticate: ReturnType<typeof vi.fn>; receive: ReturnType<typeof vi.fn> };
  }
  it('hashes the full credential, strips response metadata and sets no-store', async () => {
    const db = dependencies();
    const response = await handleShortcutRequest(request(mixed), db);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'pending', id: 'test-id', duplicate: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(db.authenticate).toHaveBeenCalledWith(await shortcutSha256(token));
    expect(db.receive.mock.calls[0][0]).toMatchObject({ p_auto_eligible: false, p_reason: 'topup_requires_review', p_amount: '1234.00' });
    expect(JSON.stringify(db.receive.mock.calls[0])).not.toContain(token);
  });
  it.each([null, 'Bearer wrong', 'Bearer shiba_sc_', `Bearer ${token} extra`])('rejects malformed auth before calling a database', async (authorization) => {
    const db = dependencies();
    expect((await handleShortcutRequest(request(simple, authorization), db)).status).toBe(401);
    expect(db.authenticate).not.toHaveBeenCalled();
    expect(db.receive).not.toHaveBeenCalled();
  });
  it('rejects unknown/revoked credentials before processing invalid JSON', async () => {
    const db = dependencies();
    db.authenticate.mockResolvedValue({ data: false, error: null });
    expect((await handleShortcutRequest(request('{'), db)).status).toBe(401);
    expect(db.receive).not.toHaveBeenCalled();
  });
  it.each(['{', JSON.stringify({ ...simple, user_id: 'owner-b' }), JSON.stringify({ ...simple, amount: '1.001' })])('does not store invalid input', async (body) => {
    const db = dependencies();
    expect((await handleShortcutRequest(request(body), db)).status).toBe(400);
    expect(db.receive).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'false'])('never calls receive when test is omitted or not boolean (%j)', async (test) => {
    const db = dependencies();
    const response = await handleShortcutRequest(request({ ...simple, test }), db);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_shortcut_payload' });
    expect(db.receive).not.toHaveBeenCalled();
  });
  it('enforces the streamed byte limit without relying on Content-Length', async () => {
    const db = dependencies();
    expect((await handleShortcutRequest(request(' '.repeat(8193)), db)).status).toBe(413);
    expect(db.receive).not.toHaveBeenCalled();
  });
  it('requires JSON content type', async () => {
    expect((await handleShortcutRequest(request(simple, `Bearer ${token}`, { 'Content-Type': 'text/plain' }), dependencies())).status).toBe(415);
  });
  it.each([['42501', 401], ['53300', 429], ['54000', 429], ['23505', 409], ['22023', 400], ['XX000', 503]])('maps DB error %s without leaking details', async (code, expected) => {
    const db = dependencies();
    db.receive.mockResolvedValue({ data: null, error: { code, message: 'private raw payload' } });
    const response = await handleShortcutRequest(request(), db);
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain('private');
  });
  it('fails closed when server configuration or RPC response is unavailable', async () => {
    expect((await handleShortcutRequest(request(), null)).status).toBe(503);
    const db = dependencies();
    db.receive.mockResolvedValue({ data: null, error: null });
    expect((await handleShortcutRequest(request(), db)).status).toBe(503);
  });
  it.each([true, false])('passes explicit test=%s without changing the caller intent', async (test) => {
    const db = dependencies();
    expect((await handleShortcutRequest(request({ ...simple, test }), db)).status).toBe(200);
    expect(db.receive.mock.calls[0][0].p_payload.test).toBe(test);
  });
});
