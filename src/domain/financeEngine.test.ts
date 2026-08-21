import { describe, expect, it } from 'vitest';
import type { FinanceData } from './model';
import { getPeriodRange } from './dateRange';
import {
  buildLedgerHistory,
  calculateFinancials,
  calculateInsights,
  calculateSpendingTrend,
} from './financeEngine';

const baseData: FinanceData = {
  accounts: [
    {
      id: 'cash', ownerId: 'guest', name: '現金', icon: { type: 'emoji', value: '💵' },
      openingBalance: 1_000, includeInTotalAssets: true, isActive: true, sortOrder: 0,
      version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
    },
    {
      id: 'jkopay', ownerId: 'guest', name: '街口支付', icon: { type: 'vector', value: 'wallet-cards' },
      openingBalance: 500, includeInTotalAssets: true, isActive: true, sortOrder: 1,
      version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
    },
  ],
  categories: [
    {
      id: 'food', ownerId: 'guest', kind: 'expense', name: '餐飲', icon: { type: 'emoji', value: '🍜' },
      isActive: true, sortOrder: 0, version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
    },
  ],
  transactions: [],
  adjustments: [],
  goals: [],
  allocations: [],
  budgets: [],
  recurringRules: [],
  settings: { currency: 'TWD', locale: 'zh-TW' },
};

describe('finance engine', () => {
  it('deducts an expense from its selected account and includes it in its category', () => {
    const data: FinanceData = {
      ...baseData,
      transactions: [{
        id: 'tx-breakfast', ownerId: 'guest', amount: 80, type: 'expense',
        categoryId: 'food', categoryName: '餐飲', accountId: 'jkopay', accountName: '街口支付',
        occurredAt: '2026-08-21 08:30', version: 1, updatedAt: '2026-08-21T08:31:00.000Z',
        lastOperationId: 'fixture',
      }],
    };

    const result = calculateFinancials(data);

    expect(result.accountBalances).toEqual([
      { accountId: 'cash', name: '現金', balance: 1_000, isActive: true, includeInTotalAssets: true },
      { accountId: 'jkopay', name: '街口支付', balance: 420, isActive: true, includeInTotalAssets: true },
    ]);
    expect(result.totalAssets).toBe(1_420);
    expect(result.allTime.expense).toBe(80);
    expect(result.allTime.expenseByCategory).toEqual([{ categoryId: 'food', name: '餐飲', amount: 80 }]);
  });

  it('adds income to only its selected account and includes every account in total assets', () => {
    const data: FinanceData = {
      ...baseData,
      categories: [...baseData.categories, {
        id: 'salary', ownerId: 'guest', kind: 'income', name: '薪資',
        icon: { type: 'vector', value: 'banknote' }, isActive: true, sortOrder: 1,
        version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
      }],
      transactions: [{
        id: 'tx-salary', ownerId: 'guest', amount: 2_000, type: 'income',
        categoryId: 'salary', categoryName: '薪資', accountId: 'cash', accountName: '現金',
        occurredAt: '2026-08-21 09:00', version: 1, updatedAt: '2026-08-21T09:00:00.000Z',
        lastOperationId: 'fixture',
      }],
    };

    const result = calculateFinancials(data);

    expect(result.accountBalances.find((account) => account.accountId === 'cash')?.balance).toBe(3_000);
    expect(result.accountBalances.find((account) => account.accountId === 'jkopay')?.balance).toBe(500);
    expect(result.totalAssets).toBe(3_500);
    expect(result.allTime).toMatchObject({ income: 2_000, expense: 0, net: 2_000 });
  });

  it('resolves history through a renamed, re-iconed and archived category', () => {
    const data: FinanceData = {
      ...baseData,
      categories: [{
        ...baseData.categories[0],
        name: '外食',
        icon: { type: 'emoji', value: '🥢' },
        isActive: false,
        version: 2,
      }],
      transactions: [{
        id: 'legacy-breakfast', ownerId: 'guest', amount: 80, type: 'expense',
        categoryId: 'food', categoryName: '餐飲', accountId: 'cash', accountName: '現金',
        occurredAt: '2026-08-20 08:00', version: 1, updatedAt: '2026-08-20T08:00:00.000Z',
        lastOperationId: 'fixture',
      }],
    };

    expect(calculateFinancials(data).allTime.expenseByCategory).toEqual([
      { categoryId: 'food', name: '外食', amount: 80 },
    ]);
  });

  it('applies a balance adjustment to assets without treating it as income or expense', () => {
    const data: FinanceData = {
      ...baseData,
      adjustments: [{
        id: 'adjust-jko', ownerId: 'guest', accountId: 'jkopay', amountDelta: 30,
        occurredAt: '2026-08-21 09:00', reason: '對帳校正', version: 1,
        updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
      }],
    };

    const result = calculateFinancials(data);

    expect(result.accountBalances.find((account) => account.accountId === 'jkopay')?.balance).toBe(530);
    expect(result.totalAssets).toBe(1_530);
    expect(result.allTime).toMatchObject({ income: 0, expense: 0, net: 0 });
  });

  it('includes visible balance adjustments in the chronological auditable ledger as non-cash-flow entries', () => {
    const data: FinanceData = {
      ...baseData,
      transactions: [{
        id: 'tx-breakfast', ownerId: 'guest', amount: 80, type: 'expense',
        categoryId: 'food', categoryName: '餐飲', accountId: 'cash', accountName: '現金',
        occurredAt: '2026-08-21 08:30', version: 1, updatedAt: '2026-08-21T08:31:00.000Z',
        lastOperationId: 'fixture',
      }],
      adjustments: [
        {
          id: 'adjust-visible', ownerId: 'guest', accountId: 'cash', amountDelta: -25,
          occurredAt: '2026-08-21 09:00', reason: '盤點校正', version: 1,
          updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
        },
        {
          id: 'adjust-deleted', ownerId: 'guest', accountId: 'cash', amountDelta: 10,
          occurredAt: '2026-08-21 10:00', version: 2, updatedAt: '2026-08-21T10:00:00.000Z',
          lastOperationId: 'fixture-delete', deletedAt: '2026-08-21T10:01:00.000Z',
        },
      ],
    };

    expect(buildLedgerHistory(data).map((entry) => ({
      kind: entry.kind,
      id: entry.record.id,
      occurredAt: entry.record.occurredAt,
    }))).toEqual([
      { kind: 'adjustment', id: 'adjust-visible', occurredAt: '2026-08-21 09:00' },
      { kind: 'transaction', id: 'tx-breakfast', occurredAt: '2026-08-21 08:30' },
    ]);
  });

  it('treats savings as an allocation without reducing total assets', () => {
    const data: FinanceData = {
      ...baseData,
      goals: [{
        id: 'goal-home', ownerId: 'guest', name: '新家基金', targetAmount: 5_000,
        isActive: true, version: 1, updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
      }],
      allocations: [{
        id: 'allocation-1', ownerId: 'guest', goalId: 'goal-home', amountDelta: 500,
        occurredAt: '2026-08-21 09:00', version: 1,
        updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
      }],
    };

    const result = calculateFinancials(data);

    expect(result.totalAssets).toBe(1_500);
    expect(result.allocatedSavings).toBe(500);
    expect(result.availableAssets).toBe(1_000);
  });

  it('builds an always-local today snapshot independently from the selected period', () => {
    const data: FinanceData = {
      ...baseData,
      categories: [
        ...baseData.categories,
        {
          id: 'allowance', ownerId: 'guest', kind: 'income', name: '零用錢',
          icon: { type: 'emoji', value: '🧧' }, isActive: true, sortOrder: 1,
          version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
        },
      ],
      transactions: [
        {
          id: 'before', ownerId: 'guest', amount: 50, type: 'expense', categoryId: 'food',
          categoryName: '餐飲', accountId: 'cash', accountName: '現金', occurredAt: '2026-08-20 23:59',
          version: 1, updatedAt: '2026-08-20T15:59:00.000Z', lastOperationId: 'fixture',
        },
        {
          id: 'income', ownerId: 'guest', amount: 200, type: 'income', categoryId: 'allowance',
          categoryName: '零用錢', accountId: 'cash', accountName: '現金', occurredAt: '2026-08-21 00:00',
          version: 1, updatedAt: '2026-08-20T16:00:00.000Z', lastOperationId: 'fixture',
        },
        {
          id: 'today-expense', ownerId: 'guest', amount: 80, type: 'expense', categoryId: 'food',
          categoryName: '餐飲', accountId: 'jkopay', accountName: '街口支付', occurredAt: '2026-08-21 23:59',
          version: 1, updatedAt: '2026-08-21T15:59:00.000Z', lastOperationId: 'fixture',
        },
        {
          id: 'after', ownerId: 'guest', amount: 100, type: 'expense', categoryId: 'food',
          categoryName: '餐飲', accountId: 'cash', accountName: '現金', occurredAt: '2026-08-22 00:00',
          version: 1, updatedAt: '2026-08-21T16:00:00.000Z', lastOperationId: 'fixture',
        },
      ],
    };

    const result = calculateInsights(data, { period: 'year', reference: new Date(2026, 7, 21, 12) });

    expect(result.today).toEqual({
      income: 200,
      expense: 80,
      net: 120,
      topExpenseCategory: { categoryId: 'food', name: '餐飲', amount: 80 },
    });
  });

  it('calculates current calendar-period metrics and compares the previous equivalent period', () => {
    const makeExpense = (id: string, amount: number, occurredAt: string): FinanceData['transactions'][number] => ({
      id, ownerId: 'guest', amount, type: 'expense', categoryId: 'food', categoryName: '餐飲',
      accountId: 'cash', accountName: '現金', occurredAt, version: 1,
      updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
    });
    const data: FinanceData = {
      ...baseData,
      categories: [
        ...baseData.categories,
        {
          id: 'salary', ownerId: 'guest', kind: 'income', name: '薪水', icon: { type: 'vector', value: 'briefcase' },
          isActive: true, sortOrder: 1, version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
        },
      ],
      transactions: [
        makeExpense('aug-1', 100, '2026-08-01 09:00'),
        makeExpense('aug-21', 110, '2026-08-21 13:00'),
        makeExpense('jul-15', 60, '2026-07-15 13:00'),
        {
          id: 'salary-aug', ownerId: 'guest', amount: 500, type: 'income', categoryId: 'salary', categoryName: '薪水',
          accountId: 'cash', accountName: '現金', occurredAt: '2026-08-10 09:00', version: 1,
          updatedAt: '2026-08-10T01:00:00.000Z', lastOperationId: 'fixture',
        },
      ],
    };

    const result = calculateInsights(data, { period: 'month', reference: new Date(2026, 7, 21, 12) });

    expect(result.period).toMatchObject({
      income: 500,
      expense: 210,
      net: 290,
      averageDailyExpense: 10,
      savingsRate: 0.58,
      largestExpense: { id: 'aug-21', amount: 110 },
      expenseByCategory: [{ categoryId: 'food', name: '餐飲', amount: 210 }],
    });
    expect(result.previousPeriod).toMatchObject({ income: 0, expense: 60, net: -60, savingsRate: null });
    expect(result.comparison).toEqual({ incomeDelta: 500, expenseDelta: 150, netDelta: 350 });
  });

  it('groups trend points by the user-local date instead of the stored UTC prefix', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Taipei';
    try {
      const data: FinanceData = {
        ...baseData,
        transactions: [{
          id: 'near-midnight', ownerId: 'guest', amount: 80, type: 'expense',
          categoryId: 'food', categoryName: '餐飲', accountId: 'cash', accountName: '現金',
          occurredAt: '2026-08-20T23:30:00Z', version: 1,
          updatedAt: '2026-08-20T23:31:00Z', lastOperationId: 'fixture',
        }],
      };
      const range = getPeriodRange('custom', new Date(2026, 7, 21, 12), {
        start: '2026-08-21',
        end: '2026-08-21',
      });

      expect(calculateSpendingTrend(data, range)).toEqual([['2026-08-21', 80]]);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
