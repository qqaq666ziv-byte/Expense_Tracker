import type { BalanceAdjustment, FinanceData, Transaction, Transfer } from './model';
import type { CustomRangeInput, DateRange, PeriodKey } from './dateRange';
import { sortByDisplayOrder } from './displayOrder';
import { addMoney, compareMoney, subtractMoney, sumMoney } from './money';
import { isFinancialTransaction } from './tutorialRecord';
import {
  countElapsedDays,
  getEquivalentPreviousPeriodRange,
  getPeriodRange,
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
  | { kind: 'transfer'; record: Transfer }
  | { kind: 'adjustment'; record: BalanceAdjustment };

const isPresent = <T extends { deletedAt?: string }>(record: T): boolean => !record.deletedAt;

/** Normal transactions and balance corrections share one auditable timeline. */
export function buildLedgerHistory(data: FinanceData): LedgerHistoryEntry[] {
  return [
    ...data.transactions.filter(isFinancialTransaction).map((record) => ({ kind: 'transaction' as const, record })),
    ...data.transfers.filter(isPresent).map((record) => ({ kind: 'transfer' as const, record })),
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
    if (!isFinancialTransaction(transaction) || transaction.type !== 'expense' || !isWithinRange(transaction.occurredAt, range)) {
      continue;
    }
    const date = toLocalDateKey(transaction.occurredAt);
    totals.set(date, addMoney(totals.get(date) ?? 0, transaction.amount));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-Math.trunc(maxPoints));
}

export function calculateFinancials(data: FinanceData): FinancialSummary {
  const transactions = data.transactions.filter(isFinancialTransaction);
  const transfers = data.transfers.filter(isPresent);
  const adjustments = data.adjustments.filter(isPresent);
  const categoriesById = new Map(data.categories.filter(isPresent).map((category) => [category.id, category]));

  const accountBalances = sortByDisplayOrder(data.accounts.filter(isPresent))
    .map((account) => {
      const transactionDelta = sumMoney(transactions
        .filter((transaction) => transaction.accountId === account.id)
        .map((transaction) => transaction.type === 'income' ? transaction.amount : -transaction.amount));
      const adjustmentDelta = sumMoney(adjustments
        .filter((adjustment) => adjustment.accountId === account.id)
        .map((adjustment) => adjustment.amountDelta));
      const transferDelta = sumMoney(transfers.flatMap((transfer) => {
        if (transfer.sourceAccountId === account.id) return [-transfer.amount];
        if (transfer.destinationAccountId === account.id) return [transfer.amount];
        return [];
      }));
      return {
        accountId: account.id,
        name: account.name,
        balance: sumMoney([account.openingBalance, transactionDelta, adjustmentDelta, transferDelta]),
        isActive: account.isActive,
        includeInTotalAssets: account.includeInTotalAssets,
      };
    });

  const income = sumMoney(transactions
    .filter((transaction) => transaction.type === 'income')
    .map((transaction) => transaction.amount));
  const expenseTransactions = transactions.filter((transaction) => transaction.type === 'expense');
  const expense = sumMoney(expenseTransactions.map((transaction) => transaction.amount));
  const expenseByCategoryMap = new Map<string, number>();
  for (const transaction of expenseTransactions) {
    expenseByCategoryMap.set(
      transaction.categoryId,
      addMoney(expenseByCategoryMap.get(transaction.categoryId) ?? 0, transaction.amount),
    );
  }

  const totalAssets = sumMoney(accountBalances
    .filter((account) => account.isActive && account.includeInTotalAssets)
    .map((account) => account.balance));
  const allocatedSavings = sumMoney(data.allocations
    .filter(isPresent)
    .map((allocation) => allocation.amountDelta));

  return {
    accountBalances,
    totalAssets,
    allocatedSavings,
    availableAssets: subtractMoney(totalAssets, allocatedSavings),
    allTime: {
      income,
      expense,
      net: subtractMoney(income, expense),
      expenseByCategory: [...expenseByCategoryMap.entries()]
        .map(([categoryId, amount]) => ({
          categoryId,
          name: categoriesById.get(categoryId)?.name
            ?? expenseTransactions.find((transaction) => transaction.categoryId === categoryId)?.categoryName
            ?? '未知分類',
          amount,
        }))
        .sort((left, right) => compareMoney(right.amount, left.amount)),
    },
  };
}

export function calculateInsights(data: FinanceData, options: InsightsOptions): InsightsSummary {
  const todayRange = getTodayRange(options.reference);
  const todayTransactions = data.transactions.filter(
    (transaction) => isFinancialTransaction(transaction) && isWithinRange(transaction.occurredAt, todayRange),
  );
  const income = sumMoney(todayTransactions
    .filter((transaction) => transaction.type === 'income')
    .map((transaction) => transaction.amount));
  const expenses = todayTransactions.filter((transaction) => transaction.type === 'expense');
  const expense = sumMoney(expenses.map((transaction) => transaction.amount));
  const categoriesById = new Map(data.categories.filter(isPresent).map((category) => [category.id, category]));
  const byCategory = new Map<string, number>();
  for (const transaction of expenses) {
    byCategory.set(transaction.categoryId, addMoney(byCategory.get(transaction.categoryId) ?? 0, transaction.amount));
  }
  const topEntry = [...byCategory.entries()].sort((left, right) => compareMoney(right[1], left[1]))[0];
  const topTransaction = topEntry
    ? expenses.find((transaction) => transaction.categoryId === topEntry[0])
    : undefined;

  const currentRange = getPeriodRange(options.period, options.reference, options.custom);
  const previousRange = getEquivalentPreviousPeriodRange(options.period, options.reference, options.custom);
  const period = summarizePeriod(data, currentRange, options.reference);
  const previousPeriod = summarizePeriod(data, previousRange, options.reference);

  return {
    today: {
      income,
      expense,
      net: subtractMoney(income, expense),
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
      incomeDelta: subtractMoney(period.income, previousPeriod.income),
      expenseDelta: subtractMoney(period.expense, previousPeriod.expense),
      netDelta: subtractMoney(period.net, previousPeriod.net),
    },
  };
}

function summarizePeriod(data: FinanceData, range: DateRange, reference: Date): PeriodAnalytics {
  const transactions = data.transactions.filter(
    (transaction) => isFinancialTransaction(transaction) && isWithinRange(transaction.occurredAt, range),
  );
  const income = sumMoney(transactions
    .filter((transaction) => transaction.type === 'income')
    .map((transaction) => transaction.amount));
  const expenses = transactions.filter((transaction) => transaction.type === 'expense');
  const expense = sumMoney(expenses.map((transaction) => transaction.amount));
  const categoriesById = new Map(data.categories.filter(isPresent).map((category) => [category.id, category]));
  const categoryTotals = new Map<string, number>();
  for (const transaction of expenses) {
    categoryTotals.set(
      transaction.categoryId,
      addMoney(categoryTotals.get(transaction.categoryId) ?? 0, transaction.amount),
    );
  }
  const expenseByCategory = [...categoryTotals.entries()]
    .map(([categoryId, amount]) => ({
      categoryId,
      name: categoriesById.get(categoryId)?.name
        ?? expenses.find((transaction) => transaction.categoryId === categoryId)?.categoryName
        ?? '未知分類',
      amount,
    }))
    .sort((left, right) => compareMoney(right.amount, left.amount));
  const elapsedDays = countElapsedDays(range, reference);

  return {
    range,
    income,
    expense,
    net: subtractMoney(income, expense),
    expenseByCategory,
    averageDailyExpense: elapsedDays > 0 ? expense / elapsedDays : 0,
    savingsRate: income > 0 ? subtractMoney(income, expense) / income : null,
    largestExpense: expenses.reduce<Transaction | null>(
      (largest, transaction) => !largest || compareMoney(transaction.amount, largest.amount) > 0
        ? transaction
        : largest,
      null,
    ),
  };
}
