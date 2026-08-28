import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  fromMinorUnits,
  MAX_SAFE_MONEY,
  moneyDecimalPlaces,
  subtractMoney,
  sumMoney,
  toMinorUnits,
} from './money';

describe('minor-unit money arithmetic', () => {
  it('adds and subtracts decimal amounts without binary floating-point residue', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(sumMoney([0.1, 0.2, -0.3])).toBe(0);
    expect(subtractMoney(0.3, 0.1, 0.2)).toBe(0);
    expect(compareMoney(0.1 + 0.2, 0.3)).toBe(0);
  });

  it('rounds legacy precision only for derived arithmetic', () => {
    expect(toMinorUnits(0.005)).toBe(1n);
    expect(toMinorUnits(-0.005)).toBe(-1n);
    expect(toMinorUnits(1.005)).toBe(101n);
    expect(toMinorUnits(-1.005)).toBe(-101n);
  });

  it('keeps the supported upper boundary recoverable as exact minor units', () => {
    expect(MAX_SAFE_MONEY).toBe(100_000_000);
    expect(toMinorUnits(MAX_SAFE_MONEY)).toBe(10_000_000_000n);
    expect(toMinorUnits(MAX_SAFE_MONEY - 0.01)).toBe(9_999_999_999n);
    expect(moneyDecimalPlaces(1.234567)).toBe(6);
    expect(moneyDecimalPlaces(0.0000001)).toBe(7);
  });

  it('fails closed instead of rounding an aggregate outside exact minor units', () => {
    expect(() => fromMinorUnits(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/exact minor-unit range/i);
    expect(() => fromMinorUnits(BigInt(Number.MAX_SAFE_INTEGER))).toThrow(/exact minor units/i);
    expect(() => sumMoney(Array.from({ length: 1_000_000 }, () => MAX_SAFE_MONEY)))
      .toThrow(/exact minor-unit range/i);
  });

  it('rejects non-finite values instead of contaminating totals', () => {
    expect(() => sumMoney([1, Number.NaN])).toThrow(RangeError);
    expect(() => sumMoney([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});
