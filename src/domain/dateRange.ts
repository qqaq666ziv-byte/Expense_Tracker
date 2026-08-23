export type PeriodKey = 'week' | 'month' | 'year' | 'custom';

export interface DateRange {
  start: Date;
  end: Date;
}

export interface CustomRangeInput {
  start: string;
  end: string;
}

export type CustomRangeValidation =
  | { valid: true }
  | { valid: false; message: string };

export function parseLocalDateTime(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  const localMatch = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (localMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0', milliseconds = '0'] = localMatch;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(milliseconds.padEnd(3, '0')),
    );
    if (
      parsed.getFullYear() !== Number(year) ||
      parsed.getMonth() !== Number(month) - 1 ||
      parsed.getDate() !== Number(day) ||
      parsed.getHours() !== Number(hour) ||
      parsed.getMinutes() !== Number(minute)
    ) {
      throw new Error(`Invalid local date/time: ${value}`);
    }
    return parsed;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date/time: ${value}`);
  }
  return parsed;
}

export function toLocalDateKey(value: string | Date): string {
  const date = parseLocalDateTime(value);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 23, 59, 59, 999);
}

export function getPeriodRange(period: PeriodKey, reference: Date, custom?: CustomRangeInput): DateRange {
  if (period === 'month') {
    const first = new Date(reference.getFullYear(), reference.getMonth(), 1);
    const last = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
    return { start: startOfLocalDay(first), end: endOfLocalDay(last) };
  }

  if (period === 'year') {
    const first = new Date(reference.getFullYear(), 0, 1);
    const last = new Date(reference.getFullYear(), 11, 31);
    return { start: startOfLocalDay(first), end: endOfLocalDay(last) };
  }

  if (period === 'custom') {
    if (!custom?.start || !custom.end) {
      throw new Error('Custom ranges require both a start and end date');
    }
    const start = startOfLocalDay(parseLocalDateTime(custom.start));
    const end = endOfLocalDay(parseLocalDateTime(custom.end));
    if (start.getTime() > end.getTime()) {
      throw new Error('Custom range start must not be after its end');
    }
    return { start, end };
  }

  if (period !== 'week') {
    throw new Error(`Unsupported period: ${period}`);
  }

  const day = reference.getDay();
  const distanceToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - distanceToMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

  return { start: startOfLocalDay(monday), end: endOfLocalDay(sunday) };
}

/** Validate user-editable custom dates without throwing during a React render. */
export function validateCustomRangeInput(custom: CustomRangeInput): CustomRangeValidation {
  if (!custom.start || !custom.end) {
    return { valid: false, message: '請同時選擇開始日與結束日。' };
  }
  try {
    const start = startOfLocalDay(parseLocalDateTime(custom.start));
    const end = endOfLocalDay(parseLocalDateTime(custom.end));
    if (start.getTime() > end.getTime()) {
      return { valid: false, message: '開始日不能晚於結束日。' };
    }
    return { valid: true };
  } catch {
    return { valid: false, message: '請輸入有效的日期。' };
  }
}

export function isWithinRange(value: string | Date, range: DateRange): boolean {
  const time = parseLocalDateTime(value).getTime();
  return time >= range.start.getTime() && time <= range.end.getTime();
}

export function getTodayRange(reference: Date): DateRange {
  return { start: startOfLocalDay(reference), end: endOfLocalDay(reference) };
}

function shiftLocalDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function localDayOrdinal(value: Date): number {
  return Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000);
}

export function countCalendarDays(range: DateRange): number {
  return localDayOrdinal(range.end) - localDayOrdinal(range.start) + 1;
}

export function countElapsedDays(range: DateRange, reference: Date): number {
  if (reference.getTime() < range.start.getTime()) return 0;
  const effectiveEnd = reference.getTime() < range.end.getTime() ? reference : range.end;
  return localDayOrdinal(effectiveEnd) - localDayOrdinal(range.start) + 1;
}

export function getPreviousPeriodRange(
  period: PeriodKey,
  reference: Date,
  custom?: CustomRangeInput,
): DateRange {
  if (period === 'week') {
    return getPeriodRange('week', shiftLocalDays(reference, -7));
  }
  if (period === 'month') {
    return getPeriodRange('month', new Date(reference.getFullYear(), reference.getMonth() - 1, 1));
  }
  if (period === 'year') {
    return getPeriodRange('year', new Date(reference.getFullYear() - 1, 0, 1));
  }

  const current = getPeriodRange('custom', reference, custom);
  const previousEndDay = shiftLocalDays(current.start, -1);
  const previousStartDay = shiftLocalDays(previousEndDay, -(countCalendarDays(current) - 1));
  return { start: startOfLocalDay(previousStartDay), end: endOfLocalDay(previousEndDay) };
}

/**
 * Return a previous-period comparison with the same number of included local
 * days when the selected calendar period is still in progress. A shorter
 * previous period is clamped at its natural end (for example, March 31 versus
 * February), while completed or historical/custom periods remain unchanged.
 */
export function getEquivalentPreviousPeriodRange(
  period: PeriodKey,
  reference: Date,
  custom?: CustomRangeInput,
): DateRange {
  const current = getPeriodRange(period, reference, custom);
  const previous = getPreviousPeriodRange(period, reference, custom);
  if (period === 'custom'
    || reference.getTime() < current.start.getTime()
    || reference.getTime() >= current.end.getTime()) {
    return previous;
  }

  const elapsedDays = countElapsedDays(current, reference);
  if (elapsedDays <= 0) return previous;
  const equivalentEnd = endOfLocalDay(shiftLocalDays(previous.start, elapsedDays - 1));
  return {
    start: previous.start,
    end: equivalentEnd.getTime() < previous.end.getTime() ? equivalentEnd : previous.end,
  };
}
