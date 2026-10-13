import { getPeriodRange, parseLocalDateTime, toLocalDateKey } from '../domain/dateRange';

export type SelectablePeriod = 'week' | 'month';

/** Date/month inputs represent local calendar dates, never UTC instants. */
export function parsePeriodSelection(period: SelectablePeriod, value: string): Date | null {
  const pattern = period === 'week' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
  if (!pattern.test(value)) return null;
  try {
    // Noon survives timezone transitions that skip local midnight.
    const day = period === 'month' ? `${value}-01` : value;
    const date = parseLocalDateTime(`${day} 12:00`);
    // Leave room for a previous week/month without entering JS's 0–99 year mapping.
    return date.getFullYear() >= 101 && date.getFullYear() <= 9999 ? date : null;
  } catch {
    return null;
  }
}

export function periodSelectionValue(period: SelectablePeriod, reference: Date): string {
  const start = getPeriodRange(period, reference).start;
  return toLocalDateKey(start).slice(0, period === 'week' ? 10 : 7);
}

export function shiftPeriodSelection(
  period: SelectablePeriod,
  value: string,
  direction: -1 | 1,
): string | null {
  const reference = parsePeriodSelection(period, value);
  if (!reference) return null;
  const start = getPeriodRange(period, reference).start;
  const next = period === 'week'
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + direction * 7)
    : new Date(start.getFullYear(), start.getMonth() + direction, 1);
  if (next.getFullYear() < 101 || next.getFullYear() > 9999) return null;
  return periodSelectionValue(period, next);
}
