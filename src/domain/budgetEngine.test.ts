import { describe, expect, it } from 'vitest';
import type { Budget, FinanceData } from './model';
import { createFinanceBackup, restoreFinanceBackup } from './backup';
import {
  calculateBudgetUsage,
  budgetSemanticId,
  findBudgetCreationCollision,
  findActiveBudgetConflict,
  normalizeBudgetScope,
} from './budgetEngine';
import { TUTORIAL_RECORD_NOTE } from '../app/tutorial';

describe('budget engine', () => {
  it('uses one stable id for concurrent creation of the same budget semantics', () => {
    expect(budgetSemanticId('user-a', 'category', 'monthly', 'food'))
      .toBe(budgetSemanticId('user-a', 'category', 'monthly', 'food'));
    expect(budgetSemanticId('user-a', 'category', 'monthly', 'food'))
      .not.toBe(budgetSemanticId('user-a', 'category', 'weekly', 'food'));
  });

  it('blocks create when the deterministic id already belongs to an archived or tombstoned budget', () => {
    const id = budgetSemanticId('user-a', 'overall', 'monthly');
    const archived: Budget = {
      id, ownerId: 'user-a', scope: 'overall', period: 'monthly', amount: 500,
      isActive: false, version: 2, updatedAt: '2026-08-27T00:00:00.000Z',
      lastOperationId: 'archived-budget',
    };
    const candidate: Budget = {
      ...archived,
      amount: 600,
      isActive: true,
      version: 1,
      lastOperationId: 'new-budget',
    };

    expect(findBudgetCreationCollision([archived], candidate)).toBe(archived);
    expect(findBudgetCreationCollision([{ ...archived, deletedAt: '2026-08-27T00:00:00.000Z' }], candidate))
      .toBeDefined();
  });

  it('finds another active budget with the same semantic scope while ignoring itself and archived records', () => {
    const active: Budget = {
      id: 'active-food', ownerId: 'guest', scope: 'category', categoryId: 'food', categoryName: '餐飲',
      period: 'monthly', amount: 5_000, isActive: true, version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z', lastOperationId: 'active-food-create',
    };
    const archived: Budget = {
      ...active,
      id: 'archived-food',
      isActive: false,
      lastOperationId: 'archived-food-archive',
    };
    const candidate: Budget = {
      ...active,
      id: 'candidate-food',
      amount: 6_000,
      lastOperationId: 'candidate-food-create',
    };

    expect(findActiveBudgetConflict([active, archived], candidate)?.id).toBe('active-food');
    expect(findActiveBudgetConflict([active, archived], active)).toBeUndefined();
    expect(findActiveBudgetConflict([archived], candidate)).toBeUndefined();
    expect(findActiveBudgetConflict([active, archived], { ...archived, isActive: true })?.id)
      .toBe('active-food');
    expect(findActiveBudgetConflict([active], { ...candidate, period: 'weekly' })).toBeUndefined();
  });

  it('uses shared calendar rules for overall and category budgets without counting income or adjustments', () => {
    const data: FinanceData = {
      accounts: [],
      categories: [{
        id: 'food', ownerId: 'guest', kind: 'expense', name: '外食', icon: { type: 'emoji', value: '🍜' },
        isActive: false, sortOrder: 0, version: 2, updatedAt: '2026-08-20T00:00:00.000Z', lastOperationId: 'rename',
      }],
      transactions: [
        {
          id: 'expense', ownerId: 'guest', amount: 80, type: 'expense', categoryId: 'food', categoryName: '餐飲',
          accountId: 'cash', accountName: '現金', occurredAt: '2026-08-21 12:00', version: 1,
          updatedAt: '2026-08-21T04:00:00.000Z', lastOperationId: 'fixture',
        },
        {
          id: 'income', ownerId: 'guest', amount: 500, type: 'income', categoryId: 'salary', categoryName: '薪水',
          accountId: 'cash', accountName: '現金', occurredAt: '2026-08-21 09:00', version: 1,
          updatedAt: '2026-08-21T01:00:00.000Z', lastOperationId: 'fixture',
        },
        {
          id: 'tutorial', ownerId: 'guest', amount: 100, type: 'expense', categoryId: 'food', categoryName: '餐飲',
          accountId: 'cash', accountName: '現金', occurredAt: '2026-08-21 10:00', note: TUTORIAL_RECORD_NOTE,
          version: 1, updatedAt: '2026-08-21T02:00:00.000Z', lastOperationId: 'tutorial-create',
        },
      ],
      adjustments: [{
        id: 'adjust', ownerId: 'guest', accountId: 'cash', amountDelta: -10, occurredAt: '2026-08-21 14:00',
        version: 1, updatedAt: '2026-08-21T06:00:00.000Z', lastOperationId: 'fixture',
      }],
      goals: [], allocations: [], recurringRules: [],
      budgets: [
        {
          id: 'overall', ownerId: 'guest', scope: 'overall', period: 'monthly', amount: 300, isActive: true,
          version: 1, updatedAt: '2026-08-01T00:00:00.000Z', lastOperationId: 'fixture',
        },
        {
          id: 'food-budget', ownerId: 'guest', scope: 'category', categoryId: 'food', categoryName: '餐飲',
          period: 'monthly', amount: 100, isActive: true, version: 1,
          updatedAt: '2026-08-01T00:00:00.000Z', lastOperationId: 'fixture',
        },
      ],
      settings: { currency: 'TWD', locale: 'zh-TW' },
    };

    expect(calculateBudgetUsage(data, new Date(2026, 7, 21, 15))).toEqual([
      {
        budgetId: 'overall', scope: 'overall', period: 'monthly', name: '總預算',
        limit: 300, used: 80, remaining: 220, overBy: 0, usageRatio: 80 / 300,
      },
      {
        budgetId: 'food-budget', scope: 'category', categoryId: 'food', period: 'monthly', name: '外食',
        limit: 100, used: 80, remaining: 20, overBy: 0, usageRatio: 0.8,
      },
    ]);
  });

  it('removes stale category fields when an overall budget is updated and survives backup round trip', () => {
    const staleOverall: Budget = {
      id: 'overall', ownerId: 'guest', scope: 'overall', categoryId: 'food', categoryName: '餐飲',
      period: 'monthly', amount: 500, isActive: true, version: 2,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'update-overall',
    };
    const normalized = normalizeBudgetScope(staleOverall);
    const data: FinanceData = {
      accounts: [], categories: [], transactions: [], adjustments: [], goals: [], allocations: [],
      budgets: [normalized], recurringRules: [], settings: { currency: 'TWD', locale: 'zh-TW' },
    };

    const restored = restoreFinanceBackup(
      { ...data, budgets: [] },
      createFinanceBackup(data, '2026-08-21T10:30:00.000Z'),
      { ownerId: 'guest' },
    );

    expect(restored.budgets).toEqual([{
      id: 'overall', ownerId: 'guest', scope: 'overall', period: 'monthly', amount: 500,
      isActive: true, version: 2, updatedAt: '2026-08-21T10:00:00.000Z',
      lastOperationId: 'update-overall',
    }]);
  });

  it('does not report a cent-level overrun when 0.10 plus 0.20 meets a 0.30 budget', () => {
    const transactions = [0.1, 0.2].map((amount, index) => ({
      id: `expense-${index}`, ownerId: 'guest', amount, type: 'expense' as const,
      categoryId: 'food', categoryName: '餐飲', accountId: 'cash', accountName: '現金',
      occurredAt: '2026-08-21 12:00', version: 1,
      updatedAt: '2026-08-21T04:00:00.000Z', lastOperationId: `fixture-${index}`,
    }));
    const budget: Budget = {
      id: 'decimal-budget', ownerId: 'guest', scope: 'overall', period: 'monthly', amount: 0.3,
      isActive: true, version: 1, updatedAt: '2026-08-01T00:00:00.000Z', lastOperationId: 'fixture',
    };
    const data: FinanceData = {
      accounts: [], categories: [], transactions, adjustments: [], goals: [], allocations: [],
      budgets: [budget], recurringRules: [], settings: { currency: 'TWD', locale: 'zh-TW' },
    };

    expect(calculateBudgetUsage(data, new Date(2026, 7, 21, 15))).toEqual([{
      budgetId: 'decimal-budget', scope: 'overall', period: 'monthly', name: '總預算',
      limit: 0.3, used: 0.3, remaining: 0, overBy: 0, usageRatio: 1,
    }]);
  });
});
