const MINOR_UNIT_SCALE = 100n;
const MINOR_UNIT_DIGITS = 2;

/**
 * The per-record ceiling keeps every monetary field across all eight maximum
 * 50,000-row backup collections below Number.MAX_SAFE_INTEGER when aggregated
 * as minor units. Six decimal places preserve legacy inputs while remaining
 * distinguishable at this bound; new UI input is stricter at two places.
 */
export const MAX_SAFE_MONEY = 100_000_000;
export const MAX_LEGACY_MONEY_DECIMAL_PLACES = 6;

export type MinorUnits = bigint;

export function moneyDecimalPlaces(amount: number): number {
  if (!Number.isFinite(amount)) return Number.POSITIVE_INFINITY;
  const [coefficient, exponentText = '0'] = Math.abs(amount).toString().toLowerCase().split('e');
  const fractionLength = coefficient.split('.')[1]?.length ?? 0;
  return Math.max(0, fractionLength - Number(exponentText));
}

/** Returns the semantic decimal places in a JSON/Postgres numeric token. */
export function moneyLexemeDecimalPlaces(source: string): number {
  const match = /^-?(?:\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(source.trim());
  if (!match) return Number.POSITIVE_INFINITY;
  const fraction = match[1] ?? '';
  const significantFractionLength = fraction.replace(/0+$/, '').length;
  const exponent = Number(match[2] ?? 0);
  if (!Number.isSafeInteger(exponent)) return Number.POSITIVE_INFINITY;
  return Math.max(0, significantFractionLength - exponent);
}

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
  if (minorUnits < BigInt(Number.MIN_SAFE_INTEGER)
    || minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Money total exceeds the exact minor-unit range');
  }
  const amount = Number(minorUnits) / Number(MINOR_UNIT_SCALE);
  if (!Number.isFinite(amount)) {
    throw new RangeError('Money total exceeds the supported numeric range');
  }
  if (toMinorUnits(amount) !== minorUnits) {
    throw new RangeError('Money total cannot be represented as exact minor units');
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
