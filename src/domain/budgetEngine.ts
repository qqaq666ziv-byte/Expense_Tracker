import { getPeriodRange, isWithinRange } from './dateRange';
import type { FinanceData } from './model';

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

export function calculateBudgetUsage(data: FinanceData, reference: Date): BudgetUsage[] {
  const categories = new Map(
    data.categories.filter((category) => !category.deletedAt).map((category) => [category.id, category]),
  );
  const expenses = data.transactions.filter(
    (transaction) => !transaction.deletedAt && transaction.type === 'expense',
  );

  return data.budgets
    .filter((budget) => !budget.deletedAt && budget.isActive)
    .map((budget) => {
      const range = getPeriodRange(budget.period === 'weekly' ? 'week' : 'month', reference);
      const used = expenses
        .filter((transaction) => (
          isWithinRange(transaction.occurredAt, range)
          && (budget.scope === 'overall' || transaction.categoryId === budget.categoryId)
        ))
        .reduce((sum, transaction) => sum + transaction.amount, 0);
      return {
        budgetId: budget.id,
        scope: budget.scope,
        ...(budget.categoryId ? { categoryId: budget.categoryId } : {}),
        period: budget.period,
        name: budget.scope === 'overall'
          ? '總預算'
          : categories.get(budget.categoryId ?? '')?.name ?? budget.categoryName ?? '未知分類',
        limit: budget.amount,
        used,
        remaining: Math.max(budget.amount - used, 0),
        overBy: Math.max(used - budget.amount, 0),
        usageRatio: budget.amount > 0 ? used / budget.amount : 0,
      };
    });
}
