import { describe, expect, it } from 'vitest';
import type { AssetAccount } from './model';
import { MAX_SAFE_MONEY } from './money';
import { assertFinanceRecordWithinWriteLimits, utf8ByteLength } from './resourceLimits';

const account = (name: string): AssetAccount => ({
  id: 'account-1',
  ownerId: 'user-a',
  name,
  icon: { type: 'emoji', value: '💵' },
  openingBalance: 0,
  includeInTotalAssets: true,
  isActive: true,
  sortOrder: 0,
  version: 1,
  updatedAt: '2026-08-24T00:00:00.000Z',
  lastOperationId: 'operation-1',
});

describe('server-aligned finance write limits', () => {
  it('counts UTF-8 bytes rather than JavaScript code units', () => {
    expect(utf8ByteLength('中🙂')).toBe(7);
  });

  it('accepts a name at 512 bytes and rejects a multibyte name over that limit', () => {
    expect(() => assertFinanceRecordWithinWriteLimits(
      'accounts',
      account('中'.repeat(170)),
    )).not.toThrow();
    expect(() => assertFinanceRecordWithinWriteLimits(
      'accounts',
      account('中'.repeat(171)),
    )).toThrow(/accounts\.name.*512 UTF-8 bytes/i);
  });

  it('preserves legacy precision while rejecting magnitudes the server cannot accept', () => {
    expect(() => assertFinanceRecordWithinWriteLimits(
      'accounts',
      { ...account('現金'), openingBalance: 1.234 },
    )).not.toThrow();
    expect(() => assertFinanceRecordWithinWriteLimits(
      'accounts',
      { ...account('現金'), openingBalance: 1.2345678 },
    )).toThrow(/6 legacy decimal places/i);
    expect(() => assertFinanceRecordWithinWriteLimits(
      'accounts',
      { ...account('現金'), openingBalance: MAX_SAFE_MONEY + 1 },
    )).toThrow(/safe monetary range/i);
  });
});
