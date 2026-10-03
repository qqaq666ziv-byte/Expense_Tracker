import type { BalanceAdjustment, FinanceData, Transaction, Transfer } from './model';
import type { CustomRangeInput, DateRange, PeriodKey } from './dateRange';
import { sortByDisplayOrder } from './displayOrder';
import { addMoney, compareMoney, subtractMoney, sumMoney } from './money';
import { isFinancialTransaction } from './tutorialRecord';
import { getAnalyticsTransactions } from './analyticsTransactions';
import { transferDestinationCredit, transferSourceDebit } from './transfer';
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
  for (const transaction of getAnalyticsTransactions(data)) {
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

  const accountBalances = sortByDisplayOrder(data.accounts.filter(isPresent))
    .map((account) => {
      const transactionDelta = sumMoney(transactions
        .filter((transaction) => transaction.accountId === account.id)
        .map((transaction) => transaction.type === 'income' ? transaction.amount : -transaction.amount));
      const adjustmentDelta = sumMoney(adjustments
        .filter((adjustment) => adjustment.accountId === account.id)
        .map((adjustment) => adjustment.amountDelta));
      const transferDelta = sumMoney(transfers.flatMap((transfer) => {
        if (transfer.sourceAccountId === account.id) return [-transferSourceDebit(transfer)];
        if (transfer.destinationAccountId === account.id) return [transferDestinationCredit(transfer)];
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
    allTime: summarizeCashFlow(getAnalyticsTransactions(data), data.categories),
  };
}

export function calculateInsights(data: FinanceData, options: InsightsOptions): InsightsSummary {
  const transactions = getAnalyticsTransactions(data);
  const todayRange = getTodayRange(options.reference);
  const today = summarizeCashFlow(
    transactions.filter((transaction) => isWithinRange(transaction.occurredAt, todayRange)),
    data.categories,
  );

  const currentRange = getPeriodRange(options.period, options.reference, options.custom);
  const previousRange = getEquivalentPreviousPeriodRange(options.period, options.reference, options.custom);
  const period = summarizePeriod(transactions, data.categories, currentRange, options.reference);
  const previousPeriod = summarizePeriod(transactions, data.categories, previousRange, options.reference);

  return {
    today: {
      income: today.income,
      expense: today.expense,
      net: today.net,
      topExpenseCategory: today.expenseByCategory[0] ?? null,
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

/** Share monetary and category rules across all-time, daily and period analytics. */
function summarizeCashFlow(
  transactions: readonly Transaction[],
  categories: FinanceData['categories'],
): CashFlowSummary {
  const income = sumMoney(transactions
    .filter((transaction) => transaction.type === 'income')
    .map((transaction) => transaction.amount));
  const expenses = transactions.filter((transaction) => transaction.type === 'expense');
  const expense = sumMoney(expenses.map((transaction) => transaction.amount));
  const categoriesById = new Map(categories.filter(isPresent).map((category) => [category.id, category]));
  const categoryTotals = new Map<string, CategoryAmount>();
  for (const transaction of expenses) {
    const total = categoryTotals.get(transaction.categoryId) ?? {
      categoryId: transaction.categoryId,
      name: categoriesById.get(transaction.categoryId)?.name ?? transaction.categoryName ?? '未知分類',
      amount: 0,
    };
    total.amount = addMoney(total.amount, transaction.amount);
    categoryTotals.set(transaction.categoryId, total);
  }
  const expenseByCategory = [...categoryTotals.values()]
    .sort((left, right) => compareMoney(right.amount, left.amount));
  return {
    income,
    expense,
    net: subtractMoney(income, expense),
    expenseByCategory,
  };
}

function summarizePeriod(
  analyticsTransactions: readonly Transaction[],
  categories: FinanceData['categories'],
  range: DateRange,
  reference: Date,
): PeriodAnalytics {
  const transactions = analyticsTransactions.filter((transaction) => isWithinRange(transaction.occurredAt, range));
  const cashFlow = summarizeCashFlow(transactions, categories);
  const expenses = transactions.filter((transaction) => transaction.type === 'expense');
  const elapsedDays = countElapsedDays(range, reference);

  return {
    ...cashFlow,
    range,
    averageDailyExpense: elapsedDays > 0 ? cashFlow.expense / elapsedDays : 0,
    savingsRate: cashFlow.income > 0 ? cashFlow.net / cashFlow.income : null,
    largestExpense: expenses.reduce<Transaction | null>(
      (largest, transaction) => !largest || compareMoney(transaction.amount, largest.amount) > 0
        ? transaction
        : largest,
      null,
    ),
  };
}
