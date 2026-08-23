import { describe, expect, it } from 'vitest';
import { money, parseRequiredNumberInput, shortDate } from './format';

describe('financial formatting', () => {
  it('does not round fractional amounts into a different ledger value', () => {
    expect(money.format(0.5)).toContain('0.5');
    expect(money.format(1)).not.toContain('.0');
  });

  it('keeps date-only values on their authored calendar day', () => {
    expect(shortDate('2026-08-21')).toBe('2026/8/21');
  });

  it('does not reinterpret a cleared required amount as zero', () => {
    expect(parseRequiredNumberInput('')).toBeNull();
    expect(parseRequiredNumberInput('   ')).toBeNull();
    expect(parseRequiredNumberInput('0')).toBe(0);
    expect(parseRequiredNumberInput('-12.5')).toBe(-12.5);
    expect(parseRequiredNumberInput('1.234')).toBeNull();
    expect(parseRequiredNumberInput(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });

  it('rejects two-decimal text when Number would silently change its exact minor units', () => {
    expect(parseRequiredNumberInput('9007199254740991.01')).toBeNull();
    expect(parseRequiredNumberInput('00012.30')).toBe(12.3);
    expect(parseRequiredNumberInput('0.1')).toBe(0.1);
    expect(parseRequiredNumberInput('0.2')).toBe(0.2);
  });
});
