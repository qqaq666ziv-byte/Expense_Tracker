import { describe, expect, it } from 'vitest';
import { accountKindLabel, displayMoney } from './presentation';

describe('product presentation', () => {
  it('keeps transaction-scale money precise and compacts large summaries', () => {
    expect(displayMoney(3307)).toContain('3,307');
    expect(displayMoney(12540, true)).toMatch(/1\.3\s*萬|12\.5K/);
    expect(displayMoney(1050000, true)).toMatch(/105\s*萬|1\.1M/);
  });

  it('turns common account names into human-facing account types', () => {
    expect(accountKindLabel({ name: '街口支付', icon: { type: 'emoji', value: '📱' } })).toBe('電子支付');
    expect(accountKindLabel({ name: '台新銀行', icon: { type: 'emoji', value: '🏦' } })).toBe('銀行');
  });
});
