import { describe, expect, it } from 'vitest';
import type { PersistedFinanceState } from './model';
import { createFinanceStore } from './financeStore';

const initialState: PersistedFinanceState = {
  schemaVersion: 3,
  ownerId: 'guest',
  outbox: [],
  data: {
    accounts: [{
      id: 'cash', ownerId: 'guest', name: '現金', icon: { type: 'emoji', value: '💵' },
      openingBalance: 1_000, includeInTotalAssets: true, isActive: true, sortOrder: 0,
      version: 1, updatedAt: '2026-08-21T00:00:00.000Z', lastOperationId: 'fixture',
    }],
    categories: [], transactions: [], adjustments: [], budgets: [], recurringRules: [],
    goals: [{
      id: 'goal', ownerId: 'guest', name: '旅遊', targetAmount: 2_000, isActive: true,
      version: 1, updatedAt: '2026-08-21T00:00:00.000Z', lastOperationId: 'fixture',
    }],
    allocations: [],
    settings: { currency: 'TWD', locale: 'zh-TW' },
  },
};

describe('finance store interface', () => {
  it('rejects a new savings allocation that exceeds available assets without mutating state', () => {
    const store = createFinanceStore(initialState, {
      now: () => new Date('2026-08-21T10:00:00.000Z'),
      generateId: () => 'generated',
    });
    const before = store.snapshot();

    const result = store.execute({ type: 'allocateSavings', goalId: 'goal', amount: 1_001 });

    expect(result).toEqual({
      ok: false,
      code: 'INSUFFICIENT_AVAILABLE_ASSETS',
      message: '可配置資產不足',
    });
    expect(store.snapshot()).toEqual(before);
  });

  it('atomically records an authenticated transaction and its retryable outbox operation', () => {
    const userState: PersistedFinanceState = structuredClone(initialState);
    userState.ownerId = 'user-a';
    userState.data.accounts[0].ownerId = 'user-a';
    userState.data.categories = [{
      id: 'food', ownerId: 'user-a', kind: 'expense', name: '餐飲', icon: { type: 'emoji', value: '🍜' },
      isActive: true, sortOrder: 0, version: 1, updatedAt: '2026-08-21T00:00:00.000Z', lastOperationId: 'fixture',
    }];
    const ids = ['op-1', 'tx-1'];
    const store = createFinanceStore(userState, {
      now: () => new Date('2026-08-21T10:00:00.000Z'),
      generateId: () => ids.shift()!,
    });

    const result = store.execute({
      type: 'addTransaction',
      amount: 80,
      transactionType: 'expense',
      categoryId: 'food',
      accountId: 'cash',
      occurredAt: '2026-08-21 18:00',
      note: '晚餐',
    });
    const snapshot = store.snapshot();

    expect(result).toEqual({ ok: true, recordId: 'tx-1' });
    expect(snapshot.data.transactions[0]).toMatchObject({
      id: 'tx-1', ownerId: 'user-a', amount: 80, type: 'expense', categoryId: 'food',
      categoryName: '餐飲', accountId: 'cash', accountName: '現金', note: '晚餐',
      lastOperationId: 'op-1', version: 1,
    });
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.outbox[0]).toMatchObject({
      id: 'op-1', entity: 'transactions', recordId: 'tx-1', attempts: 0,
    });
  });

  it('archives a category without invalidating historical transactions', () => {
    const state: PersistedFinanceState = structuredClone(initialState);
    state.ownerId = 'user-a';
    state.data.categories = [{
      id: 'food', ownerId: 'user-a', kind: 'expense', name: '餐飲', icon: { type: 'emoji', value: '🍜' },
      isActive: true, sortOrder: 0, version: 1, updatedAt: '2026-08-21T00:00:00.000Z', lastOperationId: 'fixture',
    }];
    state.data.transactions = [{
      id: 'history', ownerId: 'user-a', amount: 80, type: 'expense', categoryId: 'food', categoryName: '餐飲',
      accountId: 'cash', accountName: '現金', occurredAt: '2026-08-20 08:00', version: 1,
      updatedAt: '2026-08-20T00:00:00.000Z', lastOperationId: 'fixture',
    }];
    const store = createFinanceStore(state, {
      now: () => new Date('2026-08-21T10:00:00.000Z'),
      generateId: () => 'archive-op',
    });

    const result = store.execute({ type: 'archiveCategory', categoryId: 'food' });
    const snapshot = store.snapshot();

    expect(result.ok).toBe(true);
    expect(snapshot.data.categories[0]).toMatchObject({ id: 'food', isActive: false, version: 2 });
    expect(snapshot.data.transactions[0]).toMatchObject({ id: 'history', categoryId: 'food' });
    expect(snapshot.outbox[0]).toMatchObject({ entity: 'categories', recordId: 'food' });
  });
});
