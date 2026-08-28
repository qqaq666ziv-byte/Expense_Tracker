import { getPeriodRange, isWithinRange } from './dateRange';
import type { Budget, FinanceData } from './model';
import { stableLegacyId } from './legacyMigration';
import { subtractMoney, sumMoney } from './money';
import { isFinancialTransaction } from './tutorialRecord';

export interface BudgetUsage {
  budgetId: string;
  scope: 'overall' | 'category';
  categoryId?: string;
  period: 'weekly' | 'monthly';
  name: string;
  limit: number;
  used: number;
  remaining: number;
  overBy: number;
  usageRatio: number;
}

/** Keep the persisted budget shape consistent with its selected scope. */
export function normalizeBudgetScope(budget: FinanceData['budgets'][number]): FinanceData['budgets'][number] {
  if (budget.scope === 'category') return budget;
  const normalized = { ...budget };
  delete normalized.categoryId;
  delete normalized.categoryName;
  return normalized;
}

export function budgetSemanticId(
  ownerId: string,
  scope: Budget['scope'],
  period: Budget['period'],
  categoryId?: string,
): string {
  return stableLegacyId(
    'budget',
    ownerId,
    'semantic-v1',
    scope,
    period,
    scope === 'category' ? (categoryId ?? 'missing-category') : 'overall',
  );
}

export function hasSameBudgetSemantics(left: Budget, right: Budget): boolean {
  return left.ownerId === right.ownerId
    && left.scope === right.scope
    && left.period === right.period
    && (left.scope === 'overall' || left.categoryId === right.categoryId);
}

export function findBudgetSemanticMatch(
  budgets: readonly Budget[],
  candidate: Budget,
): Budget | undefined {
  return budgets.find((budget) => (
    budget.id !== candidate.id && !budget.deletedAt && hasSameBudgetSemantics(budget, candidate)
  ));
}

export function findBudgetCreationCollision(
  budgets: readonly Budget[],
  candidate: Budget,
): Budget | undefined {
  return budgets.find((budget) => budget.id === candidate.id)
    ?? findBudgetSemanticMatch(budgets, candidate);
}

/** Find the active record that would conflict with saving or restoring this budget. */
export function findActiveBudgetConflict(
  budgets: readonly Budget[],
  candidate: Budget,
): Budget | undefined {
  if (!candidate.isActive || candidate.deletedAt) return undefined;
  return findBudgetSemanticMatch(
    budgets.filter((budget) => budget.isActive),
    candidate,
  );
}

export function calculateBudgetUsage(data: FinanceData, reference: Date): BudgetUsage[] {
  const categories = new Map(
    data.categories.filter((category) => !category.deletedAt).map((category) => [category.id, category]),
  );
  const expenses = data.transactions.filter(
    (transaction) => isFinancialTransaction(transaction) && transaction.type === 'expense',
  );

  return data.budgets
    .filter((budget) => !budget.deletedAt && budget.isActive)
    .map((budget) => {
      const range = getPeriodRange(budget.period === 'weekly' ? 'week' : 'month', reference);
      const used = sumMoney(expenses
        .filter((transaction) => (
          isWithinRange(transaction.occurredAt, range)
          && (budget.scope === 'overall' || transaction.categoryId === budget.categoryId)
        ))
        .map((transaction) => transaction.amount));
      const limit = sumMoney([budget.amount]);
      return {
        budgetId: budget.id,
        scope: budget.scope,
        ...(budget.categoryId ? { categoryId: budget.categoryId } : {}),
        period: budget.period,
        name: budget.scope === 'overall'
          ? '總預算'
          : categories.get(budget.categoryId ?? '')?.name ?? budget.categoryName ?? '未知分類',
        limit,
        used,
        remaining: Math.max(subtractMoney(limit, used), 0),
        overBy: Math.max(subtractMoney(used, limit), 0),
        usageRatio: limit > 0 ? used / limit : 0,
      };
    });
}
