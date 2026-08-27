import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import type { Category } from './model';
import {
  assertCategoryUpsert,
  assertLifecycleTransition,
  findCategoryNameConflict,
  getCategoryActionBlock,
  getCategoryDisplayStatus,
  getCategoryReferences,
  normalizeCategoryName,
} from './lifecycle';

describe('category lifecycle', () => {
  it('normalizes Unicode width, surrounding whitespace, repeated whitespace and case', () => {
    expect(normalizeCategoryName('  ＦＯＯ　 Bar  ')).toBe('foo bar');
  });

  it('finds a semantic duplicate only within the same income or expense kind', () => {
    const data = createInitialState('guest').data;
    const existing: Category = {
      ...data.categories[0],
      id: 'wide-food',
      name: 'Ｆｏｏ　ＢＡＲ',
      kind: 'expense',
    };
    data.categories.push(existing);

    expect(findCategoryNameConflict(data.categories, 'expense', ' foo   bar ')).toBe(existing);
    expect(findCategoryNameConflict(data.categories, 'income', ' foo bar ')).toBeUndefined();
    expect(findCategoryNameConflict(data.categories, 'expense', ' foo bar ', existing.id)).toBeUndefined();
  });

  it('counts every category reference, including tombstoned financial records', () => {
    const data = createInitialState('guest').data;
    const category = data.categories.find((item) => item.kind === 'expense')!;
    const account = data.accounts[0];
    data.transactions = [
      {
        id: 'transaction-current', ownerId: 'guest', version: 1,
        updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'transaction-current-op',
        amount: 100, type: 'expense', categoryId: category.id, categoryName: category.name,
        accountId: account.id, accountName: account.name, occurredAt: '2026-08-27 08:00',
      },
      {
        id: 'transaction-tombstone', ownerId: 'guest', version: 2,
        updatedAt: '2026-08-27T01:00:00.000Z', lastOperationId: 'transaction-delete-op',
        deletedAt: '2026-08-27T01:00:00.000Z', amount: 80, type: 'expense',
        categoryId: category.id, categoryName: category.name, accountId: account.id,
        accountName: account.name, occurredAt: '2026-08-26 08:00',
      },
    ];
    data.budgets = [{
      id: 'budget-tombstone', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-27T01:00:00.000Z', lastOperationId: 'budget-delete-op',
      deletedAt: '2026-08-27T01:00:00.000Z', scope: 'category', categoryId: category.id,
      categoryName: category.name, period: 'monthly', amount: 5_000, isActive: false,
    }];
    data.recurringRules = [{
      id: 'rule-tombstone', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-27T01:00:00.000Z', lastOperationId: 'rule-delete-op',
      deletedAt: '2026-08-27T01:00:00.000Z', name: '早餐', type: 'expense', amount: 100,
      categoryId: category.id, categoryName: category.name, accountId: account.id,
      accountName: account.name, frequency: 'monthly', startDate: '2026-08-27',
      nextOccurrenceDate: '2026-09-27', isActive: false,
    }];

    expect(getCategoryReferences(data, category.id)).toEqual({
      transactions: 2,
      budgets: 1,
      recurringRules: 1,
      total: 4,
    });
  });

  it('derives in-use, unused and archived display states without storing another status', () => {
    const data = createInitialState('guest').data;
    const inUse = data.categories.find((item) => item.kind === 'expense')!;
    const unused = data.categories.find((item) => item.kind === 'income')!;
    const archived = data.categories.find((item) => item.kind === 'expense' && item.id !== inUse.id)!;
    const account = data.accounts[0];
    data.transactions = [{
      id: 'history', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'history-op',
      amount: 100, type: 'expense', categoryId: inUse.id, categoryName: inUse.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-27 08:00',
    }];
    archived.isActive = false;

    expect(getCategoryDisplayStatus(data, inUse)).toBe('in-use');
    expect(getCategoryDisplayStatus(data, unused)).toBe('unused');
    expect(getCategoryDisplayStatus(data, archived)).toBe('archived');
  });

  it('rejects kind changes and semantic duplicates while allowing a category to keep its own name', () => {
    const data = createInitialState('guest').data;
    const expense = data.categories.find((item) => item.kind === 'expense')!;
    const otherExpense = data.categories.find((item) => item.kind === 'expense' && item.id !== expense.id)!;

    expect(() => assertCategoryUpsert(data, { ...expense, kind: 'income' })).toThrow(/收支類型.*不可變更/);
    expect(() => assertCategoryUpsert(data, { ...otherExpense, name: ` ${expense.name}　` })).toThrow(/已有同名/);
    expect(() => assertCategoryUpsert(data, { ...expense, name: ` ${expense.name} ` })).not.toThrow();

    otherExpense.name = expense.name;
    expect(() => assertCategoryUpsert(data, {
      ...expense,
      icon: { type: 'emoji', value: '🧪' },
    })).not.toThrow();
  });

  it('rejects deterministic-id collisions with archived or tombstoned categories', () => {
    const data = createInitialState('guest').data;
    const archived = data.categories.find((item) => item.kind === 'expense')!;
    archived.isActive = false;
    archived.version = 3;
    archived.lastOperationId = 'archive-operation';

    expect(() => assertCategoryUpsert(data, {
      ...archived,
      isActive: true,
      version: 1,
      lastOperationId: 'new-category-operation',
    })).toThrow(/重新整理.*重新啟用/);

    archived.deletedAt = '2026-08-27T00:00:00.000Z';
    expect(() => assertCategoryUpsert(data, {
      ...archived,
      isActive: true,
      deletedAt: undefined,
      version: 4,
      lastOperationId: 'resurrection-operation',
    })).toThrow(/同步刪除紀錄/);
  });

  it('blocks archiving or deleting the last active category of either kind', () => {
    const data = createInitialState('guest').data;
    const expense = data.categories.find((item) => item.kind === 'expense')!;
    const income = data.categories.find((item) => item.kind === 'income')!;
    data.categories.forEach((item) => {
      if (item.kind === 'expense') item.isActive = item.id === expense.id;
      if (item.kind === 'income') item.isActive = item.id === income.id;
    });

    expect(getCategoryActionBlock(data, expense, 'archive')).toMatchObject({
      code: 'LAST_ACTIVE_CATEGORY',
      message: expect.stringContaining('至少保留一個可用的支出分類'),
    });
    expect(getCategoryActionBlock(data, income, 'delete')).toMatchObject({
      code: 'LAST_ACTIVE_CATEGORY',
      message: expect.stringContaining('至少保留一個可用的收入分類'),
    });
  });

  it('blocks deleting a referenced category with counts and a safe archive alternative', () => {
    const data = createInitialState('guest').data;
    const category = data.categories.find((item) => item.kind === 'expense')!;
    const account = data.accounts[0];
    data.transactions = [{
      id: 'history', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'history-op',
      amount: 100, type: 'expense', categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-27 08:00',
    }];

    expect(getCategoryActionBlock(data, category, 'delete')).toEqual({
      code: 'CATEGORY_REFERENCED',
      message: '此分類仍被 1 筆交易引用，不能刪除；請改用封存來保留過去資料。',
      references: { transactions: 1, budgets: 0, recurringRules: 0, total: 1 },
    });
  });

  it('allows safe actions and blocks restoring an archived semantic duplicate', () => {
    const data = createInitialState('guest').data;
    const target = data.categories.find((item) => item.kind === 'expense')!;
    const duplicate = data.categories.find((item) => item.kind === 'expense' && item.id !== target.id)!;
    target.name = '  Ｆｏｏ  ';
    target.isActive = false;
    duplicate.name = 'foo';

    expect(getCategoryActionBlock(data, target, 'archive')).toBeUndefined();
    expect(getCategoryActionBlock(data, target, 'delete')).toBeUndefined();
    expect(getCategoryActionBlock(data, target, 'restore')).toMatchObject({
      code: 'DUPLICATE_CATEGORY_NAME',
      message: expect.stringContaining('已有同名'),
    });
  });

  it('fails closed on meaning/minimum changes while allowing existing duplicates to be displayed', () => {
    const current = createInitialState('guest').data;
    const expense = current.categories.find((item) => item.kind === 'expense')!;
    const kindDrift = structuredClone(current);
    kindDrift.categories.find((item) => item.id === expense.id)!.kind = 'income';
    expect(() => assertLifecycleTransition(current, kindDrift)).toThrow(/收支類型/);

    const duplicate = structuredClone(current);
    duplicate.categories.push({
      ...expense,
      id: 'semantic-duplicate',
      name: ` ${expense.name}　`,
      lastOperationId: 'semantic-duplicate-created',
    });
    expect(() => assertLifecycleTransition(current, duplicate)).not.toThrow();

    const budgetConflict = structuredClone(current);
    const category = budgetConflict.categories.find((item) => item.kind === 'expense')!;
    budgetConflict.budgets = [
      {
        id: 'budget-a', ownerId: 'guest', version: 1, updatedAt: '2026-08-27T00:00:00.000Z',
        lastOperationId: 'budget-a-created', scope: 'category', period: 'monthly', amount: 100,
        categoryId: category.id, categoryName: category.name, isActive: true,
      },
      {
        id: 'budget-b', ownerId: 'guest', version: 1, updatedAt: '2026-08-27T00:00:00.000Z',
        lastOperationId: 'budget-b-created', scope: 'category', period: 'monthly', amount: 200,
        categoryId: category.id, categoryName: category.name, isActive: true,
      },
    ];
    expect(() => assertLifecycleTransition(current, budgetConflict)).not.toThrow();
  });
});
