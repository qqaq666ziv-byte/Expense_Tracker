import { parseLocalDateTime } from '../domain/dateRange';
import { MAX_SAFE_MONEY, toMinorUnits } from '../domain/money';

export const money = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function toLocalInput(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function localDate(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function parseRequiredNumberInput(value: string): number | null {
  const normalized = value.trim();
  if (!/^-?(?:\d+|\d*\.\d{1,2})$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_SAFE_MONEY) return null;

  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = (negative ? normalized.slice(1) : normalized).split('.');
  const exactMinorUnits = BigInt(whole || '0') * 100n
    + BigInt(fraction.padEnd(2, '0'));
  const signedExactMinorUnits = negative && exactMinorUnits !== 0n
    ? -exactMinorUnits
    : exactMinorUnits;

  return toMinorUnits(parsed) === signedExactMinorUnits ? parsed : null;
}

export function shortDate(value: string): string {
  try {
    const date = parseLocalDateTime(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
    }
    return new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return value.replace('T', ' ');
  }
}
