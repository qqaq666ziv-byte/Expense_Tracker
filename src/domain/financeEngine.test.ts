import { describe, expect, it } from 'vitest';
import type { FinanceData } from './model';
import { getPeriodRange } from './dateRange';
import {
  buildLedgerHistory,
  calculateFinancials,
  calculateInsights,
  calculateSpendingTrend,
} from './financeEngine';
import { TUTORIAL_RECORD_NOTE } from '../app/tutorial';

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
  it('keeps an active tutorial record out of the normal ledger, assets and analytics', () => {
    const data: FinanceData = {
      ...baseData,
      transactions: [{
        id: 'tutorial-record', ownerId: 'guest', amount: 100, type: 'expense',
        categoryId: 'food', categoryName: '餐飲', accountId: 'cash', accountName: '現金',
        occurredAt: '2026-08-21 12:00', note: TUTORIAL_RECORD_NOTE, version: 1,
        updatedAt: '2026-08-21T04:00:00.000Z', lastOperationId: 'tutorial-create',
      }],
    };

    expect(buildLedgerHistory(data)).toEqual([]);
    expect(calculateFinancials(data)).toMatchObject({
      totalAssets: 1_500,
      allTime: { income: 0, expense: 0, net: 0 },
    });
    expect(calculateInsights(data, {
      period: 'month',
      reference: new Date(2026, 7, 21, 12),
    }).today).toMatchObject({ income: 0, expense: 0, net: 0 });
    expect(calculateSpendingTrend(
      data,
      getPeriodRange('month', new Date(2026, 7, 21, 12)),
    )).toEqual([]);
  });

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

  it('uses deterministic display-order ties for account balances regardless of pull order', () => {
    const data: FinanceData = {
      ...baseData,
      accounts: [
        { ...baseData.accounts[0], id: 'z-account', name: '同順位帳戶', sortOrder: 5 },
        { ...baseData.accounts[0], id: 'a-account', name: '同順位帳戶', sortOrder: 5 },
      ],
    };

    expect(calculateFinancials(data).accountBalances.map((account) => account.accountId)).toEqual([
      'a-account',
      'z-account',
    ]);
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

  it('keeps two-decimal cash flow and available assets exact in minor units', () => {
    const goal = {
      id: 'goal-decimal', ownerId: 'guest', name: '零錢目標', targetAmount: 1,
      isActive: true, version: 1, updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
    } satisfies FinanceData['goals'][number];
    const allocation = (id: string, amountDelta: number) => ({
      id, ownerId: 'guest', goalId: goal.id, amountDelta, occurredAt: '2026-08-21 09:00',
      version: 1, updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: `fixture-${id}`,
    }) satisfies FinanceData['allocations'][number];
    const allocationData: FinanceData = {
      ...baseData,
      accounts: [{ ...baseData.accounts[0], openingBalance: 0.3 }],
      goals: [goal],
      allocations: [allocation('allocation-10', 0.1), allocation('allocation-20', 0.2)],
    };

    expect(calculateFinancials(allocationData)).toMatchObject({
      totalAssets: 0.3,
      allocatedSavings: 0.3,
      availableAssets: 0,
    });

    const incomeCategory = {
      ...baseData.categories[0], id: 'income', kind: 'income' as const, name: '收入',
    };
    const transaction = (
      id: string,
      amount: number,
      type: 'income' | 'expense',
      categoryId: string,
      categoryName: string,
    ) => ({
      id, ownerId: 'guest', amount, type, categoryId, categoryName,
      accountId: 'cash', accountName: '現金', occurredAt: '2026-08-21 10:00',
      version: 1, updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: `fixture-${id}`,
    }) satisfies FinanceData['transactions'][number];
    const cashFlowData: FinanceData = {
      ...baseData,
      categories: [...baseData.categories, incomeCategory],
      transactions: [
        transaction('income-10', 0.1, 'income', 'income', '收入'),
        transaction('income-20', 0.2, 'income', 'income', '收入'),
        transaction('expense-30', 0.3, 'expense', 'food', '餐飲'),
      ],
    };
    const financials = calculateFinancials(cashFlowData);
    const insights = calculateInsights(cashFlowData, {
      period: 'month',
      reference: new Date(2026, 7, 21, 12),
    });

    expect(financials.allTime).toMatchObject({ income: 0.3, expense: 0.3, net: 0 });
    expect(insights.today).toMatchObject({ income: 0.3, expense: 0.3, net: 0 });
    expect(calculateSpendingTrend(
      cashFlowData,
      getPeriodRange('month', new Date(2026, 7, 21, 12)),
    )).toEqual([['2026-08-21', 0.3]]);
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
        makeExpense('jul-25', 900, '2026-07-25 13:00'),
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
