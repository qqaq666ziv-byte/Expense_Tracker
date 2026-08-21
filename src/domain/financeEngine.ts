import type { BalanceAdjustment, FinanceData, Transaction } from './model';
import type { CustomRangeInput, DateRange, PeriodKey } from './dateRange';
import {
  countElapsedDays,
  getPeriodRange,
  getPreviousPeriodRange,
  getTodayRange,
  isWithinRange,
  parseLocalDateTime,
  toLocalDateKey,
} from './dateRange';

export interface AccountBalance {
  accountId: string;
  name: string;
  balance: number;
  isActive: boolean;
  includeInTotalAssets: boolean;
}

export interface CategoryAmount {
  categoryId: string;
  name: string;
  amount: number;
}

export interface CashFlowSummary {
  income: number;
  expense: number;
  net: number;
  expenseByCategory: CategoryAmount[];
}

export interface FinancialSummary {
  accountBalances: AccountBalance[];
  totalAssets: number;
  allocatedSavings: number;
  availableAssets: number;
  allTime: CashFlowSummary;
}

export interface InsightsOptions {
  period: PeriodKey;
  reference: Date;
  custom?: CustomRangeInput;
}

export interface TodaySnapshot {
  income: number;
  expense: number;
  net: number;
  topExpenseCategory: CategoryAmount | null;
}

export interface InsightsSummary {
  today: TodaySnapshot;
  period: PeriodAnalytics;
  previousPeriod: PeriodAnalytics;
  comparison: {
    incomeDelta: number;
    expenseDelta: number;
    netDelta: number;
  };
}

export interface PeriodAnalytics extends CashFlowSummary {
  range: DateRange;
  averageDailyExpense: number;
  savingsRate: number | null;
  largestExpense: Transaction | null;
}

export type LedgerHistoryEntry =
  | { kind: 'transaction'; record: Transaction }
  | { kind: 'adjustment'; record: BalanceAdjustment };

const isPresent = <T extends { deletedAt?: string }>(record: T): boolean => !record.deletedAt;

/** Normal transactions and balance corrections share one auditable timeline. */
export function buildLedgerHistory(data: FinanceData): LedgerHistoryEntry[] {
  return [
    ...data.transactions.filter(isPresent).map((record) => ({ kind: 'transaction' as const, record })),
    ...data.adjustments.filter(isPresent).map((record) => ({ kind: 'adjustment' as const, record })),
  ].sort((left, right) => {
    const timeDelta = parseLocalDateTime(right.record.occurredAt).getTime()
      - parseLocalDateTime(left.record.occurredAt).getTime();
    return timeDelta || right.record.id.localeCompare(left.record.id);
  });
}

export type SpendingTrendPoint = [date: string, amount: number];

/** Groups expenses by the user's local calendar date, including explicit UTC instants. */
export function calculateSpendingTrend(
  data: FinanceData,
  range: DateRange,
  maxPoints = 14,
): SpendingTrendPoint[] {
  if (maxPoints <= 0) return [];
  const totals = new Map<string, number>();
  for (const transaction of data.transactions) {
    if (!isPresent(transaction) || transaction.type !== 'expense' || !isWithinRange(transaction.occurredAt, range)) {
      continue;
    }
    const date = toLocalDateKey(transaction.occurredAt);
    totals.set(date, (totals.get(date) ?? 0) + transaction.amount);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-Math.trunc(maxPoints));
}

export function calculateFinancials(data: FinanceData): FinancialSummary {
  const transactions = data.transactions.filter(isPresent);
  const adjustments = data.adjustments.filter(isPresent);
  const categoriesById = new Map(data.categories.filter(isPresent).map((category) => [category.id, category]));

  const accountBalances = data.accounts
    .filter(isPresent)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((account) => {
      const transactionDelta = transactions.reduce((sum, transaction) => {
        if (transaction.accountId !== account.id) return sum;
        return sum + (transaction.type === 'income' ? transaction.amount : -transaction.amount);
      }, 0);
      const adjustmentDelta = adjustments
        .filter((adjustment) => adjustment.accountId === account.id)
        .reduce((sum, adjustment) => sum + adjustment.amountDelta, 0);
      return {
        accountId: account.id,
        name: account.name,
        balance: account.openingBalance + transactionDelta + adjustmentDelta,
        isActive: account.isActive,
        includeInTotalAssets: account.includeInTotalAssets,
      };
    });

  const income = transactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const expenseTransactions = transactions.filter((transaction) => transaction.type === 'expense');
  const expense = expenseTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);
  const expenseByCategoryMap = new Map<string, number>();
  for (const transaction of expenseTransactions) {
    expenseByCategoryMap.set(
      transaction.categoryId,
      (expenseByCategoryMap.get(transaction.categoryId) ?? 0) + transaction.amount,
    );
  }

  const totalAssets = accountBalances
    .filter((account) => account.isActive && account.includeInTotalAssets)
    .reduce((sum, account) => sum + account.balance, 0);
  const allocatedSavings = data.allocations
    .filter(isPresent)
    .reduce((sum, allocation) => sum + allocation.amountDelta, 0);

  return {
    accountBalances,
    totalAssets,
    allocatedSavings,
    availableAssets: totalAssets - allocatedSavings,
    allTime: {
      income,
      expense,
      net: income - expense,
      expenseByCategory: [...expenseByCategoryMap.entries()]
        .map(([categoryId, amount]) => ({
          categoryId,
          name: categoriesById.get(categoryId)?.name
            ?? expenseTransactions.find((transaction) => transaction.categoryId === categoryId)?.categoryName
            ?? '未知分類',
          amount,
        }))
        .sort((left, right) => right.amount - left.amount),
    },
  };
}

export function calculateInsights(data: FinanceData, options: InsightsOptions): InsightsSummary {
  const todayRange = getTodayRange(options.reference);
  const todayTransactions = data.transactions.filter(
    (transaction) => isPresent(transaction) && isWithinRange(transaction.occurredAt, todayRange),
  );
  const income = todayTransactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const expenses = todayTransactions.filter((transaction) => transaction.type === 'expense');
  const expense = expenses.reduce((sum, transaction) => sum + transaction.amount, 0);
  const categoriesById = new Map(data.categories.filter(isPresent).map((category) => [category.id, category]));
  const byCategory = new Map<string, number>();
  for (const transaction of expenses) {
    byCategory.set(transaction.categoryId, (byCategory.get(transaction.categoryId) ?? 0) + transaction.amount);
  }
  const topEntry = [...byCategory.entries()].sort((left, right) => right[1] - left[1])[0];
  const topTransaction = topEntry
    ? expenses.find((transaction) => transaction.categoryId === topEntry[0])
    : undefined;

  const currentRange = getPeriodRange(options.period, options.reference, options.custom);
  const previousRange = getPreviousPeriodRange(options.period, options.reference, options.custom);
  const period = summarizePeriod(data, currentRange, options.reference);
  const previousPeriod = summarizePeriod(data, previousRange, options.reference);

  return {
    today: {
      income,
      expense,
      net: income - expense,
      topExpenseCategory: topEntry
        ? {
            categoryId: topEntry[0],
            name: categoriesById.get(topEntry[0])?.name ?? topTransaction?.categoryName ?? '未知分類',
            amount: topEntry[1],
          }
        : null,
    },
    period,
    previousPeriod,
    comparison: {
      incomeDelta: period.income - previousPeriod.income,
      expenseDelta: period.expense - previousPeriod.expense,
      netDelta: period.net - previousPeriod.net,
    },
  };
}

function summarizePeriod(data: FinanceData, range: DateRange, reference: Date): PeriodAnalytics {
  const transactions = data.transactions.filter(
    (transaction) => isPresent(transaction) && isWithinRange(transaction.occurredAt, range),
  );
  const income = transactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const expenses = transactions.filter((transaction) => transaction.type === 'expense');
  const expense = expenses.reduce((sum, transaction) => sum + transaction.amount, 0);
  const categoriesById = new Map(data.categories.filter(isPresent).map((category) => [category.id, category]));
  const categoryTotals = new Map<string, number>();
  for (const transaction of expenses) {
    categoryTotals.set(transaction.categoryId, (categoryTotals.get(transaction.categoryId) ?? 0) + transaction.amount);
  }
  const expenseByCategory = [...categoryTotals.entries()]
    .map(([categoryId, amount]) => ({
      categoryId,
      name: categoriesById.get(categoryId)?.name
        ?? expenses.find((transaction) => transaction.categoryId === categoryId)?.categoryName
        ?? '未知分類',
      amount,
    }))
    .sort((left, right) => right.amount - left.amount);
  const elapsedDays = countElapsedDays(range, reference);

  return {
    range,
    income,
    expense,
    net: income - expense,
    expenseByCategory,
    averageDailyExpense: elapsedDays > 0 ? expense / elapsedDays : 0,
    savingsRate: income > 0 ? (income - expense) / income : null,
    largestExpense: expenses.reduce<Transaction | null>(
      (largest, transaction) => !largest || transaction.amount > largest.amount ? transaction : largest,
      null,
    ),
  };
}
