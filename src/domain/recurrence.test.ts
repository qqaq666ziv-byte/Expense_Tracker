import { describe, expect, it } from 'vitest';
import type { RecurringRule } from './model';
import {
  catchUpRecurringTransactions,
  getNextOccurrenceDate,
  getRecurringCatchUpStatus,
  getRecurringOccurrenceDates,
  getRecurringEditCursor,
  MAX_RECURRING_CATCH_UP_OCCURRENCES,
} from './recurrence';

const createRule = (overrides: Partial<RecurringRule> = {}): RecurringRule => ({
  id: 'salary',
  ownerId: 'guest',
  version: 1,
  updatedAt: '2026-08-01T00:00:00.000Z',
  lastOperationId: 'rule-created',
  name: '週薪',
  type: 'income',
  amount: 10_000,
  categoryId: 'salary-category',
  categoryName: '薪資',
  accountId: 'cash',
  accountName: '現金',
  frequency: 'weekly',
  startDate: '2026-08-03',
  nextOccurrenceDate: '2026-08-03',
  isActive: true,
  note: '固定收入',
  ...overrides,
});

describe('recurring transactions', () => {
  it('fails closed without advancing an extreme historical catch-up', () => {
    const rule = createRule({
      startDate: '0001-01-01',
      nextOccurrenceDate: '0001-01-01',
    });

    expect(catchUpRecurringTransactions(rule, '2026-08-23')).toEqual({
      transactions: [],
      nextOccurrenceDate: '0001-01-01',
      blockedByLimit: {
        maximumOccurrences: MAX_RECURRING_CATCH_UP_OCCURRENCES,
        overflowOccurrenceDate: expect.any(String),
      },
    });
    expect(getRecurringCatchUpStatus(rule, '2026-08-23')).toMatchObject({
      blocked: true,
      maximumOccurrences: MAX_RECURRING_CATCH_UP_OCCURRENCES,
    });
    expect(() => getRecurringOccurrenceDates(rule, '2026-08-23'))
      .toThrow(`${MAX_RECURRING_CATCH_UP_OCCURRENCES}`);
  });

  it('allows exactly the catch-up limit and blocks before occurrence 501', () => {
    const rule = createRule({
      startDate: '2017-01-02',
      nextOccurrenceDate: '2017-01-02',
    });

    const atLimit = catchUpRecurringTransactions(rule, '2026-07-27');
    expect(atLimit.transactions).toHaveLength(MAX_RECURRING_CATCH_UP_OCCURRENCES);
    expect(atLimit.nextOccurrenceDate).toBe('2026-08-03');
    expect(atLimit.blockedByLimit).toBeUndefined();

    expect(catchUpRecurringTransactions(rule, '2026-08-03')).toEqual({
      transactions: [],
      nextOccurrenceDate: '2017-01-02',
      blockedByLimit: {
        maximumOccurrences: MAX_RECURRING_CATCH_UP_OCCURRENCES,
        overflowOccurrenceDate: '2026-08-03',
      },
    });
  });

  it('catches up weekly income through an inclusive date and advances the active cursor', () => {
    const rule = createRule();

    const result = catchUpRecurringTransactions(rule, '2026-08-17');

    expect(result.transactions.map(({ id, type, amount, occurrenceDate, occurredAt }) => ({
      id,
      type,
      amount,
      occurrenceDate,
      occurredAt,
    }))).toEqual([
      {
        id: 'rec-salary-2026-08-03',
        type: 'income',
        amount: 10_000,
        occurrenceDate: '2026-08-03',
        occurredAt: '2026-08-03',
      },
      {
        id: 'rec-salary-2026-08-10',
        type: 'income',
        amount: 10_000,
        occurrenceDate: '2026-08-10',
        occurredAt: '2026-08-10',
      },
      {
        id: 'rec-salary-2026-08-17',
        type: 'income',
        amount: 10_000,
        occurrenceDate: '2026-08-17',
        occurredAt: '2026-08-17',
      },
    ]);
    expect(result.nextOccurrenceDate).toBe('2026-08-24');
    expect(getNextOccurrenceDate(rule, '2026-08-17')).toBe('2026-08-24');
  });

  it('clamps a monthly expense to each short month end without drifting its start-day anchor', () => {
    const rule = createRule({
      id: 'rent-31',
      name: '月底房租',
      type: 'expense',
      frequency: 'monthly',
      startDate: '2027-01-31',
      nextOccurrenceDate: '2027-01-31',
    });

    const result = catchUpRecurringTransactions(rule, '2027-04-30');

    expect(result.transactions.map((transaction) => transaction.occurrenceDate)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
    expect(result.transactions.every((transaction) => transaction.type === 'expense')).toBe(true);
    expect(result.nextOccurrenceDate).toBe('2027-05-31');
    expect(getNextOccurrenceDate(rule, '2027-02-28')).toBe('2027-03-31');
  });

  it.each([
    ['29th', '2027-01-29', ['2027-01-29', '2027-02-28', '2027-03-29']],
    ['30th', '2027-01-30', ['2027-01-30', '2027-02-28', '2027-03-30']],
  ])('keeps the original %s monthly anchor after February', (_label, startDate, expected) => {
    const rule = createRule({
      frequency: 'monthly',
      startDate,
      nextOccurrenceDate: startDate,
    });

    expect(getRecurringOccurrenceDates(rule, '2027-03-31')).toEqual(expected);
  });

  it('clamps a leap-day yearly rule to February 28 and restores February 29 in leap years', () => {
    const rule = createRule({
      id: 'leap-day',
      frequency: 'yearly',
      startDate: '2028-02-29',
      nextOccurrenceDate: '2028-02-29',
    });

    const result = catchUpRecurringTransactions(rule, '2032-02-29');

    expect(result.transactions.map((transaction) => transaction.occurrenceDate)).toEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ]);
    expect(result.nextOccurrenceDate).toBe('2033-02-28');
  });

  it('preserves an explicit legacy 31st anchor when migration begins in a short month', () => {
    const rule = createRule({
      frequency: 'monthly',
      startDate: '2027-02-28',
      nextOccurrenceDate: '2027-02-28',
      anchorDay: 31,
    });

    expect(getRecurringOccurrenceDates(rule, '2027-05-31')).toEqual([
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
    ]);
  });

  it('does not generate or advance an inactive rule', () => {
    const rule = createRule({ isActive: false, nextOccurrenceDate: '2026-08-10' });

    expect(catchUpRecurringTransactions(rule, '2026-08-31')).toEqual({
      transactions: [],
      nextOccurrenceDate: '2026-08-10',
    });
    expect(getRecurringOccurrenceDates(rule, '2026-08-31')).toEqual([]);
  });

  it('starts resumed catch-up from the reset active cursor without recreating the paused window', () => {
    const resumedRule = createRule({
      frequency: 'monthly',
      startDate: '2027-01-31',
      nextOccurrenceDate: '2027-04-30',
      isActive: true,
    });

    expect(getRecurringOccurrenceDates(resumedRule, '2027-05-31')).toEqual([
      '2027-04-30',
      '2027-05-31',
    ]);
  });

  it('never creates an occurrence before the rule start date even with a stale cursor', () => {
    const rule = createRule({
      startDate: '2026-08-10',
      nextOccurrenceDate: '2026-07-27',
    });

    expect(getRecurringOccurrenceDates(rule, '2026-08-17')).toEqual([
      '2026-08-10',
      '2026-08-17',
    ]);
  });

  it('is idempotent when retrying occurrences that already exist', () => {
    const rule = createRule();
    const firstAttempt = catchUpRecurringTransactions(rule, '2026-08-10');

    const retry = catchUpRecurringTransactions(rule, '2026-08-10', firstAttempt.transactions);

    expect(retry.transactions).toEqual([]);
    expect(retry.nextOccurrenceDate).toBe('2026-08-17');
  });

  it('moves an edited schedule forward past every historical or tombstoned occurrence', () => {
    const current = createRule({ nextOccurrenceDate: '2026-08-24' });
    const historical = catchUpRecurringTransactions(createRule(), '2026-08-17').transactions;
    historical[1] = { ...historical[1], deletedAt: '2026-08-18T00:00:00.000Z' };
    const edited = { ...current, frequency: 'monthly' as const, startDate: '2026-08-01', anchorDay: 1 };

    expect(getRecurringEditCursor(current, edited, historical)).toBe('2026-09-01');
    expect(catchUpRecurringTransactions(
      { ...edited, nextOccurrenceDate: getRecurringEditCursor(current, edited, historical) },
      '2026-09-01',
      historical,
    ).transactions.map((item) => item.occurrenceDate)).toEqual(['2026-09-01']);
  });

  it('never moves an edited schedule behind the currently committed cursor', () => {
    const current = createRule({ nextOccurrenceDate: '2026-09-07' });
    const historical = catchUpRecurringTransactions(createRule(), '2026-08-03').transactions;
    const edited = { ...current, frequency: 'monthly' as const, startDate: '2026-08-01', anchorDay: 1 };

    expect(getRecurringEditCursor(current, edited, historical)).toBe('2026-10-01');
  });

  it('uses edited values only for the next occurrence and never rewrites history', () => {
    const original = createRule();
    const first = catchUpRecurringTransactions(original, '2026-08-03').transactions;
    const history = structuredClone(first);
    const current = { ...original, nextOccurrenceDate: '2026-08-10' };
    const edited = { ...current, name: '新版週薪', amount: 12000 };
    const next = catchUpRecurringTransactions(
      { ...edited, nextOccurrenceDate: getRecurringEditCursor(current, edited, first) },
      '2026-08-10',
      first,
    );

    expect(first).toEqual(history);
    expect(next.transactions).toEqual([
      expect.objectContaining({ occurrenceDate: '2026-08-10', amount: 12000 }),
    ]);
  });

  it('recognizes the rule/date idempotency key even if an existing transaction ID was remapped', () => {
    const rule = createRule();
    const existing = catchUpRecurringTransactions(rule, '2026-08-03').transactions[0];

    const result = catchUpRecurringTransactions(rule, '2026-08-03', [{
      ...existing,
      id: 'server-remapped-id',
    }]);

    expect(result.transactions).toEqual([]);
  });

  it('does not let another owner transaction suppress this owner recurring occurrence', () => {
    const rule = createRule({ ownerId: 'user-a' });
    const otherOwnerTransaction = catchUpRecurringTransactions(
      createRule({ ownerId: 'user-b' }),
      '2026-08-03',
    ).transactions[0];

    const result = catchUpRecurringTransactions(rule, '2026-08-03', [otherOwnerTransaction]);

    expect(result.transactions.map((transaction) => transaction.ownerId)).toEqual(['user-a']);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-positive or non-finite recurring amount (%s)',
    (amount) => {
      expect(() => catchUpRecurringTransactions(createRule({ amount }), '2026-08-03'))
        .toThrow('Recurring transaction amount must be a positive finite number');
    },
  );

  it('maps the recurring rule to a deterministic normal transaction record', () => {
    const rule = createRule();

    const first = catchUpRecurringTransactions(rule, '2026-08-03').transactions[0];
    const retriedFromScratch = catchUpRecurringTransactions(rule, '2026-08-03').transactions[0];

    expect(first).toEqual(retriedFromScratch);
    expect(first).toMatchObject({
      id: 'rec-salary-2026-08-03',
      ownerId: 'guest',
      categoryId: 'salary-category',
      categoryName: '薪資',
      accountId: 'cash',
      accountName: '現金',
      note: '固定收入',
      recurringRuleId: 'salary',
      occurrenceDate: '2026-08-03',
      lastOperationId: 'rec-salary-2026-08-03',
    });
  });
});
