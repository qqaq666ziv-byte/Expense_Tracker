import { describe, expect, it } from 'vitest';
import {
  countElapsedDays,
  getEquivalentPreviousPeriodRange,
  getPeriodRange,
  getPreviousPeriodRange,
  getTodayRange,
  isWithinRange,
  toLocalDateKey,
  validateCustomRangeInput,
} from './dateRange';

describe('calendar date range', () => {
  it('defines this week as Monday through Sunday in local time', () => {
    const range = getPeriodRange('week', new Date(2026, 7, 23, 12, 30));

    expect([
      range.start.getFullYear(),
      range.start.getMonth(),
      range.start.getDate(),
      range.start.getHours(),
    ]).toEqual([2026, 7, 17, 0]);
    expect([
      range.end.getFullYear(),
      range.end.getMonth(),
      range.end.getDate(),
      range.end.getHours(),
      range.end.getMinutes(),
      range.end.getSeconds(),
      range.end.getMilliseconds(),
    ]).toEqual([2026, 7, 23, 23, 59, 59, 999]);
  });

  it('defines this month without including the previous month tail', () => {
    const range = getPeriodRange('month', new Date(2026, 2, 1, 8));

    expect([range.start.getFullYear(), range.start.getMonth(), range.start.getDate()]).toEqual([2026, 2, 1]);
    expect([range.end.getFullYear(), range.end.getMonth(), range.end.getDate()]).toEqual([2026, 2, 31]);
  });

  it('defines this year from January 1 through December 31', () => {
    const range = getPeriodRange('year', new Date(2028, 1, 29, 20));

    expect([range.start.getFullYear(), range.start.getMonth(), range.start.getDate()]).toEqual([2028, 0, 1]);
    expect([range.end.getFullYear(), range.end.getMonth(), range.end.getDate()]).toEqual([2028, 11, 31]);
  });

  it('includes every local time on a custom leap-day end date', () => {
    const range = getPeriodRange('custom', new Date(2028, 1, 1), {
      start: '2028-02-29',
      end: '2028-02-29',
    });

    expect(isWithinRange('2028-02-29 23:59', range)).toBe(true);
    expect(isWithinRange('2028-03-01 00:00', range)).toBe(false);
  });

  it('uses local-day boundaries for today', () => {
    const range = getTodayRange(new Date(2026, 7, 21, 14, 10));

    expect(isWithinRange('2026-08-21 00:00', range)).toBe(true);
    expect(isWithinRange('2026-08-21 23:59:59.999', range)).toBe(true);
    expect(isWithinRange('2026-08-22 00:00', range)).toBe(false);
  });

  it('uses the previous calendar period and elapsed local days for comparisons', () => {
    const reference = new Date(2026, 7, 21, 12);
    const current = getPeriodRange('month', reference);
    const previous = getPreviousPeriodRange('month', reference);

    expect([previous.start.getMonth(), previous.start.getDate()]).toEqual([6, 1]);
    expect([previous.end.getMonth(), previous.end.getDate()]).toEqual([6, 31]);
    expect(countElapsedDays(current, reference)).toBe(21);
    expect(countElapsedDays(previous, reference)).toBe(31);
  });

  it('caps an in-progress previous month to the same elapsed included days', () => {
    const previous = getEquivalentPreviousPeriodRange('month', new Date(2026, 7, 23, 12));

    expect([previous.start.getMonth(), previous.start.getDate()]).toEqual([6, 1]);
    expect([previous.end.getMonth(), previous.end.getDate()]).toEqual([6, 23]);
  });

  it('clamps short previous months and preserves elapsed-day equivalence across leap years', () => {
    const shortMonth = getEquivalentPreviousPeriodRange('month', new Date(2026, 2, 31, 12));
    const leapYear = getEquivalentPreviousPeriodRange('year', new Date(2028, 1, 29, 12));

    expect([shortMonth.end.getMonth(), shortMonth.end.getDate()]).toEqual([1, 28]);
    expect([leapYear.end.getMonth(), leapYear.end.getDate()]).toEqual([2, 1]);
  });

  it('returns an inline-safe validation result when a custom date is cleared', () => {
    expect(validateCustomRangeInput({ start: '', end: '2026-08-21' })).toEqual({
      valid: false,
      message: '請同時選擇開始日與結束日。',
    });
  });

  it('rejects a reversed custom range without asking callers to catch an exception', () => {
    expect(validateCustomRangeInput({ start: '2026-08-22', end: '2026-08-21' })).toEqual({
      valid: false,
      message: '開始日不能晚於結束日。',
    });
  });

  it('accepts a complete inclusive custom range', () => {
    expect(validateCustomRangeInput({ start: '2028-02-29', end: '2028-03-01' })).toEqual({ valid: true });
  });

  it('groups explicit instants by the user-local calendar date', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Taipei';
    try {
      expect(toLocalDateKey('2026-08-20T23:30:00Z')).toBe('2026-08-21');
      expect(toLocalDateKey('2026-08-21')).toBe('2026-08-21');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
