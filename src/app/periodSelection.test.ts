import { describe, expect, it } from 'vitest';
import { getPeriodRange, toLocalDateKey } from '../domain/dateRange';
import { parsePeriodSelection, periodSelectionValue, shiftPeriodSelection } from './periodSelection';

describe('calendar period selection', () => {
  it('uses any selected day to identify a Monday-to-Sunday week across years', () => {
    const date = parsePeriodSelection('week', '2027-01-03')!;
    const range = getPeriodRange('week', date);
    expect([toLocalDateKey(range.start), toLocalDateKey(range.end)]).toEqual(['2026-12-28', '2027-01-03']);
    expect(periodSelectionValue('week', date)).toBe('2026-12-28');
    expect(shiftPeriodSelection('week', '2027-01-03', 1)).toBe('2027-01-04');
    expect(shiftPeriodSelection('week', '2027-01-03', -1)).toBe('2026-12-21');
  });

  it('navigates months from their first day without skipping a short month', () => {
    const januaryEnd = new Date(2028, 0, 31, 23, 59);
    expect(periodSelectionValue('month', januaryEnd)).toBe('2028-01');
    expect(shiftPeriodSelection('month', '2028-01', 1)).toBe('2028-02');
    expect(shiftPeriodSelection('month', '2028-02', 1)).toBe('2028-03');
    expect(shiftPeriodSelection('month', '2027-12', 1)).toBe('2028-01');
    expect(shiftPeriodSelection('month', '2028-01', -1)).toBe('2027-12');
    const leapMonth = getPeriodRange('month', parsePeriodSelection('month', '2028-02')!);
    expect(toLocalDateKey(leapMonth.end)).toBe('2028-02-29');
  });

  it.each(['', '2027-02-29', '2028-02-30', '2026-13-01', '2026-08-21T00:00:00Z', 'bad'])('rejects an incomplete or invalid date: %s', (value) => {
    expect(parsePeriodSelection('week', value)).toBeNull();
    expect(shiftPeriodSelection('week', value, 1)).toBeNull();
  });

  it.each(['', '2028-00', '2028-13', '2028-2', '2028-02-29', 'bad'])('rejects an incomplete or invalid month: %s', (value) => {
    expect(parsePeriodSelection('month', value)).toBeNull();
  });

  it('stops navigation outside the supported input range', () => {
    expect(shiftPeriodSelection('month', '9999-12', 1)).toBeNull();
    expect(shiftPeriodSelection('month', '0101-01', -1)).toBeNull();
    expect(parsePeriodSelection('week', '0100-01-01')).toBeNull();
    expect(parsePeriodSelection('month', '0100-01')).toBeNull();
  });

  it('accepts real calendar dates in a timezone that skips midnight for DST', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Santiago';
    try {
      const sunday = parsePeriodSelection('week', '2026-09-06');
      expect(sunday).not.toBeNull();
      const range = getPeriodRange('week', sunday!);
      expect([toLocalDateKey(range.start), toLocalDateKey(range.end)]).toEqual(['2026-08-31', '2026-09-06']);
      expect(shiftPeriodSelection('week', '2026-09-06', 1)).toBe('2026-09-07');
      expect(shiftPeriodSelection('week', '2026-09-06', -1)).toBe('2026-08-24');
      // A month whose first midnight was skipped still remains selectable.
      expect(parsePeriodSelection('month', '2024-09')).not.toBeNull();
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
