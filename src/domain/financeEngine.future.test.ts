import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import { getAnalyticsTransactions } from './analyticsTransactions';
import { calculateBudgetUsage } from './budgetEngine';
import { getPeriodRange, toLocalDateKey } from './dateRange';
import { calculateFinancials, calculateInsights, calculateSpendingTrend } from './financeEngine';
import type { FinanceData, Transaction } from './model';

function fixture(): FinanceData {
  const data = createInitialState('guest').data;
  const account = data.accounts[0];
  data.accounts.push({ ...account, id: 'synthetic-bank', name: '合成銀行', sortOrder: 1 });
  const food = data.categories.find(c => c.kind === 'expense')!;
  const income = data.categories.find(c => c.kind === 'income')!;
  const transaction = (id: string, occurredAt: string, amount: number, type: 'expense' | 'income' = 'expense'): Transaction => ({
    id, ownerId: 'guest', version: 1, updatedAt: '2026-10-13T00:00:00Z', lastOperationId: id,
    accountId: account.id, accountName: account.name, categoryId: type === 'expense' ? food.id : income.id,
    categoryName: type === 'expense' ? food.name : income.name, occurredAt, amount, type,
  });
  data.transactions = [
    transaction('prior-week', '2026-10-05 00:00', 400),
    transaction('outside-prior-week', '2026-10-07 00:00', 999),
    transaction('prior-month', '2026-09-13 23:59:59.999', 200),
    transaction('outside-prior-month', '2026-09-14 00:00', 999),
    transaction('monday', '2026-10-12 00:00', 200),
    transaction('today-end', '2026-10-13 23:59:59.999', 400),
    transaction('tomorrow', '2026-10-14 00:00', 1000),
    transaction('future-month', '2026-11-01 00:00', 5000),
    transaction('income', '2026-10-13 23:59', 1200, 'income'),
    transaction('future-income', '2026-10-14 00:00', 9000, 'income'),
  ];
  data.transfers = [{
    id: 'fee-today', ownerId: 'guest', version: 1, updatedAt: '2026-10-13T00:00:00Z', lastOperationId: 'fee',
    amount: 100, fee: 10, sourceAccountId: account.id, sourceAccountName: account.name,
    destinationAccountId: 'synthetic-bank', destinationAccountName: '合成銀行', occurredAt: '2026-10-13 23:59:59.999',
  }];
  data.transfers.push({ ...data.transfers[0], id: 'fee-tomorrow', fee: 99, occurredAt: '2026-10-14 00:00' });
  data.budgets = ['weekly', 'monthly'].flatMap(period => ['overall', 'category'].map(scope => ({
    id: `${period}-${scope}`, ownerId: 'guest', version: 1, updatedAt: '2026-10-13T00:00:00Z', lastOperationId: 'budget',
    period: period as 'weekly' | 'monthly', scope: scope as 'overall' | 'category',
    ...(scope === 'category' ? { categoryId: food.id, categoryName: food.name } : {}), amount: 10000, isActive: true,
  })));
  return data;
}

const now = new Date(2026, 9, 13, 12);

describe('calendar insights exclude future local dates without rewriting records', () => {
  it.each(['week', 'month'] as const)('uses the same elapsed cutoff in %s totals, average, categories, trend, detail and budget', period => {
    const data = fixture();
    const original = structuredClone(data);
    const allTime = calculateFinancials(data);
    const result = calculateInsights(data, { period, reference: now });
    const expense = period === 'week' ? 610 : 2009;
    expect(result.period).toMatchObject({ income: 1200, expense, net: 1200 - expense,
      averageDailyExpense: expense / (period === 'week' ? 2 : 13), largestExpense: { id: period === 'week' ? 'today-end' : 'outside-prior-week' } });
    expect(result.previousPeriod.expense).toBe(period === 'week' ? 400 : 200);
    expect(result.comparison.expenseDelta).toBe(expense - (period === 'week' ? 400 : 200));
    expect(result.period.expenseByCategory.reduce((sum, c) => sum + c.amount, 0)).toBe(expense);
    expect(calculateSpendingTrend(data, result.period.range, 14, now).reduce((sum, [, amount]) => sum + amount, 0)).toBe(expense);
    expect(getAnalyticsTransactions(data, now).some(t => t.id === 'tomorrow' || t.id === 'transfer-fee:fee-tomorrow')).toBe(false);
    const budgets = calculateBudgetUsage(data, now).filter(b => b.period === (period === 'week' ? 'weekly' : 'monthly'));
    expect(budgets.map(b => b.used)).toEqual([expense, expense - 10]);
    expect(result.today.expense).toBe(410);
    expect(data).toEqual(original);
    expect(calculateFinancials(data)).toEqual(allTime);
    expect(getAnalyticsTransactions(data).some(t => t.id === 'tomorrow')).toBe(true);
  });

  it.each(['week', 'month'] as const)('keeps both comparison sides empty for an unstarted %s while today stays live', period => {
    const data = fixture();
    const periodReference = period === 'week' ? new Date(2026, 9, 19) : new Date(2026, 10, 1);
    const result = calculateInsights(data, { period, reference: now, periodReference });
    for (const summary of [result.period, result.previousPeriod]) {
      expect(summary).toMatchObject({ income: 0, expense: 0, net: 0, averageDailyExpense: 0, largestExpense: null, expenseByCategory: [] });
    }
    expect(result.comparison).toEqual({ incomeDelta: 0, expenseDelta: 0, netDelta: 0 });
    expect(result.today.expense).toBe(410);
    expect(calculateSpendingTrend(data, result.period.range, 14, now)).toEqual([]);
  });

  it('includes tomorrow automatically after local midnight, then includes the full period when historical', () => {
    const data = fixture();
    const tomorrow = calculateInsights(data, { period: 'week', reference: new Date(2026, 9, 14, 0) });
    expect(tomorrow.period).toMatchObject({ expense: 1709, averageDailyExpense: 1709 / 3 });
    expect(tomorrow.previousPeriod.expense).toBe(1399);
    const history = calculateInsights(data, { period: 'week', reference: new Date(2026, 10, 1), periodReference: now });
    expect(history.period).toMatchObject({ expense: 1709, averageDailyExpense: 1709 / 7 });
    expect(history.previousPeriod.expense).toBe(1399);
  });

  it('compares an in-progress custom range using matching elapsed days too', () => {
    const result = calculateInsights(fixture(), { period: 'custom', reference: now,
      custom: { start: '2026-10-12', end: '2026-10-18' } });
    expect(result.period).toMatchObject({ expense: 610, averageDailyExpense: 305 });
    expect(result.previousPeriod.expense).toBe(400);
  });

  it('keeps an elapsed period with only future records at zero', () => {
    const data = fixture();
    data.transactions = data.transactions.filter(t => t.id === 'tomorrow');
    data.transfers = [];
    const result = calculateInsights(data, { period: 'month', reference: now });
    expect(result.period).toMatchObject({ expense: 0, averageDailyExpense: 0, largestExpense: null });
    expect(calculateBudgetUsage(data, now).every(b => b.used === 0)).toBe(true);
  });

  it.each(['Asia/Taipei', 'America/Los_Angeles', 'America/Santiago'])('uses local end-of-day for UTC instants in %s', timezone => {
    const previous = process.env.TZ;
    process.env.TZ = timezone;
    try {
      const data = fixture();
      const reference = new Date(2026, 8, 6, 12); // midnight DST transition in Santiago
      const end = new Date(2026, 8, 6, 23, 59, 59, 999);
      data.transactions = [
        { ...data.transactions[0], id: 'last-ms', amount: 10, occurredAt: end.toISOString() },
        { ...data.transactions[0], id: 'next-day', amount: 99, occurredAt: new Date(end.getTime() + 1).toISOString() },
      ];
      data.transfers = [];
      const result = calculateInsights(data, { period: 'week', reference });
      expect(result.period).toMatchObject({ expense: 10, averageDailyExpense: 10 / 7 });
      expect(calculateSpendingTrend(data, getPeriodRange('week', reference), 14, reference)).toEqual([[toLocalDateKey(end), 10]]);
      expect(calculateBudgetUsage(data, reference).every(b => b.used === 10)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
