import type { RecurringRule, Transaction } from './model';

export interface RecurrenceCatchUpResult {
  transactions: Transaction[];
  nextOccurrenceDate: string;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

function parseDate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid recurrence date: ${value}`);

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid recurrence date: ${value}`);
  }

  return { year, month, day };
}

function toTimestamp(value: CalendarDate): number {
  return Date.UTC(value.year, value.month - 1, value.day);
}

function formatDate(value: CalendarDate): string {
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function addWeeklyOccurrences(startDate: CalendarDate, count: number): CalendarDate {
  const date = new Date(toTimestamp(startDate) + count * 7 * DAY_IN_MILLISECONDS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonthlyOccurrences(startDate: CalendarDate, count: number, anchorDay = startDate.day): CalendarDate {
  const monthIndex = startDate.year * 12 + startDate.month - 1 + count;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return {
    year,
    month,
    day: Math.min(anchorDay, daysInMonth(year, month)),
  };
}

function addYearlyOccurrences(startDate: CalendarDate, count: number, anchorDay = startDate.day): CalendarDate {
  const year = startDate.year + count;
  return {
    year,
    month: startDate.month,
    day: Math.min(anchorDay, daysInMonth(year, startDate.month)),
  };
}

function firstOccurrenceOnOrAfter(rule: RecurringRule, requestedDate: string): string {
  const start = parseDate(rule.startDate);
  const requested = parseDate(requestedDate);
  if (toTimestamp(requested) <= toTimestamp(start)) return formatDate(start);

  if (rule.frequency === 'weekly') {
    const elapsedDays = (toTimestamp(requested) - toTimestamp(start)) / DAY_IN_MILLISECONDS;
    return formatDate(addWeeklyOccurrences(start, Math.ceil(elapsedDays / 7)));
  }

  if (rule.frequency === 'monthly') {
    const anchorDay = rule.anchorDay ?? start.day;
    let occurrenceIndex = (requested.year - start.year) * 12 + requested.month - start.month;
    occurrenceIndex = Math.max(0, occurrenceIndex);
    let occurrence = addMonthlyOccurrences(start, occurrenceIndex, anchorDay);
    if (toTimestamp(occurrence) < toTimestamp(requested)) {
      occurrence = addMonthlyOccurrences(start, occurrenceIndex + 1, anchorDay);
    }
    return formatDate(occurrence);
  }

  if (rule.frequency === 'yearly') {
    const anchorDay = rule.anchorDay ?? start.day;
    let occurrenceIndex = Math.max(0, requested.year - start.year);
    let occurrence = addYearlyOccurrences(start, occurrenceIndex, anchorDay);
    if (toTimestamp(occurrence) < toTimestamp(requested)) {
      occurrence = addYearlyOccurrences(start, occurrenceIndex + 1, anchorDay);
    }
    return formatDate(occurrence);
  }

  throw new Error(`Unsupported recurrence frequency: ${rule.frequency}`);
}

export function getNextOccurrenceDate(rule: RecurringRule, afterDate: string): string {
  const after = parseDate(afterDate);
  const followingDate = new Date(toTimestamp(after) + DAY_IN_MILLISECONDS);
  return firstOccurrenceOnOrAfter(rule, formatDate({
    year: followingDate.getUTCFullYear(),
    month: followingDate.getUTCMonth() + 1,
    day: followingDate.getUTCDate(),
  }));
}

function occurrenceId(ruleId: string, occurrenceDate: string): string {
  return `rec-${ruleId}-${occurrenceDate}`;
}

function getActiveCursor(rule: RecurringRule): string {
  const start = parseDate(rule.startDate);
  const next = parseDate(rule.nextOccurrenceDate);
  const requestedDate = toTimestamp(next) < toTimestamp(start) ? rule.startDate : rule.nextOccurrenceDate;
  return firstOccurrenceOnOrAfter(rule, requestedDate);
}

export function getRecurringOccurrenceDates(rule: RecurringRule, throughDate: string): string[] {
  parseDate(throughDate);
  if (!rule.isActive || rule.deletedAt) return [];

  const occurrences: string[] = [];
  let occurrenceDate = getActiveCursor(rule);
  while (occurrenceDate <= throughDate) {
    occurrences.push(occurrenceDate);
    occurrenceDate = getNextOccurrenceDate(rule, occurrenceDate);
  }
  return occurrences;
}

function createTransaction(rule: RecurringRule, occurrenceDate: string): Transaction {
  if (!Number.isFinite(rule.amount) || rule.amount <= 0) {
    throw new Error('Recurring transaction amount must be a positive finite number');
  }
  const id = occurrenceId(rule.id, occurrenceDate);
  return {
    id,
    ownerId: rule.ownerId,
    version: 1,
    updatedAt: `${occurrenceDate}T00:00:00.000Z`,
    lastOperationId: id,
    amount: rule.amount,
    type: rule.type,
    categoryId: rule.categoryId,
    categoryName: rule.categoryName,
    accountId: rule.accountId,
    accountName: rule.accountName,
    occurredAt: occurrenceDate,
    note: rule.note,
    recurringRuleId: rule.id,
    occurrenceDate,
  };
}

export function catchUpRecurringTransactions(
  rule: RecurringRule,
  throughDate: string,
  existingTransactions: readonly Transaction[] = [],
): RecurrenceCatchUpResult {
  parseDate(throughDate);
  const cursor = getActiveCursor(rule);
  if (!rule.isActive || rule.deletedAt) {
    return { transactions: [], nextOccurrenceDate: cursor };
  }

  const existingKeys = new Set(existingTransactions
    .filter((transaction) => transaction.ownerId === rule.ownerId)
    .flatMap((transaction) => {
      const keys = [transaction.id];
      if (transaction.recurringRuleId === rule.id && transaction.occurrenceDate) {
        keys.push(occurrenceId(rule.id, transaction.occurrenceDate));
      }
      return keys;
    }));
  const transactions: Transaction[] = [];
  const occurrenceDates = getRecurringOccurrenceDates(rule, throughDate);
  for (const occurrenceDate of occurrenceDates) {
    const id = occurrenceId(rule.id, occurrenceDate);
    if (!existingKeys.has(id)) transactions.push(createTransaction(rule, occurrenceDate));
  }

  const nextOccurrenceDate = occurrenceDates.length > 0
    ? getNextOccurrenceDate(rule, occurrenceDates.at(-1)!)
    : cursor;

  return { transactions, nextOccurrenceDate };
}
