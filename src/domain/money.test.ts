import { describe, expect, it } from 'vitest';
import { addMoney, compareMoney, subtractMoney, sumMoney, toMinorUnits } from './money';

describe('minor-unit money arithmetic', () => {
  it('adds and subtracts decimal amounts without binary floating-point residue', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(sumMoney([0.1, 0.2, -0.3])).toBe(0);
    expect(subtractMoney(0.3, 0.1, 0.2)).toBe(0);
    expect(compareMoney(0.1 + 0.2, 0.3)).toBe(0);
  });

  it('rounds legacy precision only for derived arithmetic', () => {
    expect(toMinorUnits(1.005)).toBe(101n);
    expect(toMinorUnits(-1.005)).toBe(-101n);
  });

  it('rejects non-finite values instead of contaminating totals', () => {
    expect(() => sumMoney([1, Number.NaN])).toThrow(RangeError);
    expect(() => sumMoney([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});
