const MINOR_UNIT_SCALE = 100n;
const MINOR_UNIT_DIGITS = 2;

export type MinorUnits = bigint;

/**
 * Converts a persisted numeric amount to two-decimal minor units for arithmetic.
 * The source record is never rewritten; legacy values with extra decimals are
 * rounded to the nearest minor unit, with midpoint values away from zero.
 */
export function toMinorUnits(amount: number): MinorUnits {
  if (!Number.isFinite(amount)) {
    throw new RangeError('Money amounts must be finite numbers');
  }

  const [coefficient, exponentText = '0'] = Math.abs(amount).toString().toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = BigInt(`${whole}${fraction}`);
  const shift = Number(exponentText) - fraction.length + MINOR_UNIT_DIGITS;

  let minorUnits: bigint;
  if (shift >= 0) {
    minorUnits = digits * (10n ** BigInt(shift));
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    minorUnits = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  return amount < 0 ? -minorUnits : minorUnits;
}

export function fromMinorUnits(minorUnits: MinorUnits): number {
  const amount = Number(minorUnits) / Number(MINOR_UNIT_SCALE);
  if (!Number.isFinite(amount)) {
    throw new RangeError('Money total exceeds the supported numeric range');
  }
  return amount;
}

export function sumMoney(amounts: Iterable<number>): number {
  let total = 0n;
  for (const amount of amounts) total += toMinorUnits(amount);
  return fromMinorUnits(total);
}

export function addMoney(...amounts: number[]): number {
  return sumMoney(amounts);
}

export function subtractMoney(minuend: number, ...subtrahends: number[]): number {
  let result = toMinorUnits(minuend);
  for (const amount of subtrahends) result -= toMinorUnits(amount);
  return fromMinorUnits(result);
}

export function compareMoney(left: number, right: number): -1 | 0 | 1 {
  const leftMinorUnits = toMinorUnits(left);
  const rightMinorUnits = toMinorUnits(right);
  return leftMinorUnits < rightMinorUnits ? -1 : leftMinorUnits > rightMinorUnits ? 1 : 0;
}
