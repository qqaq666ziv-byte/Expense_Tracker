import { describe, expect, it } from 'vitest';
import { millisecondsUntilNextLocalDay } from './useCalendarReference';

describe('calendar reference clock', () => {
  it('schedules the refresh at the next local midnight, including leap-day boundaries', () => {
    const reference = new Date(2028, 1, 29, 23, 59, 59, 500);

    expect(millisecondsUntilNextLocalDay(reference)).toBe(500);
  });
});
