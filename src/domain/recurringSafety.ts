import type { FinanceData, RecurringRule } from './model';

/**
 * A paused/archived parent must fail closed. Historical transactions may keep
 * referencing archived accounts/categories, but an active recurring rule must
 * never manufacture a new transaction through one.
 */
export function recurringRuleParentIssue(
  data: Pick<FinanceData, 'accounts' | 'categories'>,
  rule: RecurringRule,
): string | undefined {
  const account = data.accounts.find((candidate) => candidate.id === rule.accountId);
  if (!account || account.deletedAt || !account.isActive) {
    return 'recurring rule references an unavailable account';
  }
  const category = data.categories.find((candidate) => candidate.id === rule.categoryId);
  if (!category || category.deletedAt || !category.isActive) {
    return 'recurring rule references an unavailable category';
  }
  if (category.kind !== rule.type) {
    return 'recurring rule category kind does not match its transaction type';
  }
  return undefined;
}
