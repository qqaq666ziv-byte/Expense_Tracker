/** Shared with the local preview. No network, secrets, or persistence. */
export interface ShortcutNotification {
  source: 'jkopay';
  title: string;
  text: string;
  occurredAt?: string;
  amount?: string;
  merchant?: string;
  kind?: 'expense';
}

export interface ShortcutPayload extends ShortcutNotification {
  version: 1;
  eventId?: string;
  test: boolean;
}

export interface ParsedShortcutNotification {
  amount: string | null;
  merchant: string | null;
  occurredAt: string | null;
  confidence: 'strict' | 'review' | 'unknown';
  reason: string;
  format: 'jkopay-single-debit-v1' | null;
  autoEligible: boolean;
}

const utf8 = new TextEncoder();
const decimalPattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;
const currencyAmount = '(?:NT\\$|NTD\\s*|TWD\\s*|\\$)\\s*((?:[1-9]\\d{0,2}(?:,\\d{3})+|0|[1-9]\\d{0,8})(?:\\.\\d{1,2})?)(?![\\d.,])';

export function normalizeShortcutAmount(value: unknown): string | null {
  if (typeof value !== 'string' || !decimalPattern.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n || minor > 10_000_000_000n) return null;
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}

/** Require a timezone and reject JS Date's rollover of invalid calendar dates. */
export function normalizeShortcutTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day));
  if (+year < 2000 || +year > 2100 || calendar.getUTCFullYear() !== +year
    || calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day
    || +hour > 23 || +minute > 59 || +second > 59) return null;
  if (zone !== 'Z') {
    const offsetHour = +zone.slice(1, 3);
    const offsetMinute = +zone.slice(4, 6);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function embeddedTaipeiTimestamp(text: string): string | null {
  const matches = [...text.matchAll(/(?:已於|並已於)\s*(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/g)];
  const last = matches.at(-1);
  return last ? normalizeShortcutTimestamp(`${last[1]}-${last[2]}-${last[3]}T${last[4]}:${last[5]}:${last[6] ?? '00'}+08:00`) : null;
}

/**
 * A notification is untrusted input, not a receipt from a payment API.
 * The strict template is only a candidate; the server requires a real received
 * example to be manually approved before enabling this exact format for auto.
 * Multiple amounts, rewards, top-ups, transfers and refunds never qualify.
 */
export function parseShortcutNotification(input: ShortcutNotification): ParsedShortcutNotification {
  const body = input.text.trim();
  const allText = `${input.title}\n${body}`;
  const amounts = [...body.matchAll(new RegExp(currencyAmount, 'g'))];
  const finalDebit = [...body.matchAll(new RegExp(`成功扣款\\s*${currencyAmount}(?:\\s*元)?`, 'g'))].at(-1);
  const rawAmount = finalDebit ? normalizeShortcutAmount(finalDebit[1].replaceAll(',', '')) : null;
  const rawMerchant = /來自(.{1,160}?)的授權扣款/u.exec(body)?.[1]?.trim() ?? null;
  const rawTime = embeddedTaipeiTimestamp(body);
  const amount = rawAmount ?? normalizeShortcutAmount(input.amount);
  const merchant = rawMerchant ?? input.merchant?.trim() ?? null;
  const occurredAt = rawTime ?? normalizeShortcutTimestamp(input.occurredAt);
  const result: ParsedShortcutNotification = {
    amount, merchant, occurredAt, confidence: amount ? 'review' : 'unknown',
    reason: 'unrecognized_format', format: null, autoEligible: false,
  };
  if (/退款|退貨|取消|撤銷|失敗|轉帳|收款|匯款|回饋入帳|優惠通知|抽獎|促銷|refund|reversed|transfer|failed/i.test(allText)) {
    return { ...result, amount: null, confidence: 'unknown', reason: 'non_expense_notice' };
  }
  if (/儲值|充值|top[ -]?up/i.test(allText)) return { ...result, reason: 'topup_requires_review' };
  if (amounts.length > 1 || /折抵|街口幣|街口券|回饋|折扣/.test(allText)) return { ...result, reason: 'multiple_amounts' };

  // Intentionally small allowlist. A changed/unfamiliar message remains review.
  const strict = new RegExp(`^您有一筆來自(.{1,160}?)的授權扣款(?:訂單)?，(?:並)?已於\\s*(\\d{4}[/-]\\d{2}[/-]\\d{2})\\s+(\\d{2}:\\d{2}(?::\\d{2})?)\\s*成功扣款\\s*${currencyAmount}(?:\\s*元)?[。.!！]?$`, 'u').exec(body);
  if (input.title.trim() === '扣款通知' && strict && amounts.length === 1
    && rawAmount && rawMerchant && rawTime) {
    // Caller-provided structured fields may not override conflicting raw data.
    if ((input.amount !== undefined && normalizeShortcutAmount(input.amount) !== rawAmount)
      || (input.merchant !== undefined && input.merchant.trim() !== rawMerchant)) {
      return { ...result, reason: 'structured_mismatch' };
    }
    return { ...result, confidence: 'strict', reason: 'ready_for_review', format: 'jkopay-single-debit-v1', autoEligible: true };
  }
  if (input.amount !== undefined) result.reason = 'structured_requires_review';
  if (!occurredAt && amount) result.reason = 'no_timestamp';
  return result;
}

function boundedString(value: unknown, label: string, chars: number, bytes: number, required = false): string {
  if (typeof value !== 'string' || value.length > chars || utf8.encode(value).byteLength > bytes
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

export function validateShortcutPayload(value: unknown): ShortcutPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
  const body = value as Record<string, unknown>;
  const allowed = new Set(['version', 'source', 'eventId', 'occurredAt', 'title', 'text', 'test', 'amount', 'merchant', 'kind']);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.version !== 1 || body.source !== 'jkopay'
    || (body.test !== undefined && typeof body.test !== 'boolean')
    || (body.kind !== undefined && body.kind !== 'expense')) throw new Error('invalid_body');
  const payload: ShortcutPayload = {
    version: 1, source: 'jkopay', test: body.test === true,
    title: boundedString(body.title, 'title', 256, 1024),
    text: boundedString(body.text, 'text', 2000, 6000, true),
  };
  if (body.eventId !== undefined) payload.eventId = boundedString(body.eventId, 'event_id', 128, 512, true);
  if (body.occurredAt !== undefined) {
    const timestamp = normalizeShortcutTimestamp(body.occurredAt);
    if (!timestamp) throw new Error('invalid_timestamp');
    payload.occurredAt = timestamp;
  }
  if (body.amount !== undefined) {
    const amount = normalizeShortcutAmount(body.amount);
    if (!amount) throw new Error('invalid_amount');
    payload.amount = amount;
  }
  if (body.merchant !== undefined) payload.merchant = boundedString(body.merchant, 'merchant', 160, 640, true).trim();
  if (body.kind !== undefined) payload.kind = 'expense';
  return payload;
}

export async function shortcutSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function shortcutEventIdentity(payload: ShortcutPayload): Promise<{ eventKey: string; fingerprint: string }> {
  // Stable object order and no received-at clock: retry identity must not drift.
  const fingerprint = await shortcutSha256(JSON.stringify([
    payload.source, payload.title, payload.text, payload.occurredAt ?? null,
    payload.amount ?? null, payload.merchant ?? null, payload.kind ?? null, payload.test,
  ]));
  const eventKey = payload.eventId
    ? `id:${await shortcutSha256(JSON.stringify([payload.source, payload.eventId, payload.test]))}`
    : `fp:${fingerprint}`;
  return { eventKey, fingerprint };
}
