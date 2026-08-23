import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import type { RecurringRule } from './model';
import { recurringRuleParentIssue } from './recurringSafety';

function ruleForInitialState(): { data: ReturnType<typeof createInitialState>['data']; rule: RecurringRule } {
  const data = createInitialState('user-a').data;
  const account = data.accounts[0];
  const category = data.categories.find((candidate) => candidate.kind === 'expense')!;
  return {
    data,
    rule: {
      id: 'rent-rule', ownerId: 'user-a', version: 1,
      updatedAt: '2026-08-23T12:00:00.000Z', lastOperationId: 'rule-create',
      name: '房租', type: 'expense', amount: 500, categoryId: category.id,
      categoryName: category.name, accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    },
  };
}

describe('recurring parent safety', () => {
  it('allows active rules only while both referenced parents remain active', () => {
    const { data, rule } = ruleForInitialState();
    expect(recurringRuleParentIssue(data, rule)).toBeUndefined();

    data.accounts[0] = { ...data.accounts[0], isActive: false };
    expect(recurringRuleParentIssue(data, rule)).toMatch(/unavailable account/);

    data.accounts[0] = { ...data.accounts[0], isActive: true };
    const categoryIndex = data.categories.findIndex((item) => item.id === rule.categoryId);
    data.categories[categoryIndex] = { ...data.categories[categoryIndex], isActive: false };
    expect(recurringRuleParentIssue(data, rule)).toMatch(/unavailable category/);
  });
});
