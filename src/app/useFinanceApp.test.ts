import { describe, expect, it, vi } from 'vitest';
import type { RecurringRule, Transaction } from '../domain/model';
import {
  createInitialState,
  loadFinanceStateWithRecovery,
  putRecord,
  storageKey,
} from './state';
import {
  applyFinanceMutationUnlessRecovering,
  assertFinanceMutationNotSyncing,
  assertSyncRecordMutationAllowed,
  assertSyncRecordMutationsAllowed,
  assertCurrentOwnerContext,
  clearSuccessfulRecoveryUiState,
  materializeRecurringTransactionsUnlessRecovering,
  materializeRecurringTransactionsUnlessSyncing,
  resolveLegacyBootstrapState,
  restoreFinanceStateUnlessLegacyBootstrap,
  syncMutationTargets,
} from './useFinanceApp';

describe('unresolved sync conflict mutation lock', () => {
  it('blocks a new local winner for a record with a durable same-clock payload conflict', () => {
    const state = createInitialState('user-a');
    const account = state.data.accounts[0];
    state.outbox = [];
    state.unresolvedSyncRecordKeys = [`accounts:${account.id}`];

    expect(() => assertSyncRecordMutationAllowed(state, 'accounts', account.id))
      .toThrow(/未解同步衝突/);
  });

  it('serializes financial mutations behind an in-flight sync', () => {
    expect(() => assertFinanceMutationNotSyncing(true)).toThrow(/同步正在比對/);
    expect(() => assertFinanceMutationNotSyncing(false)).not.toThrow();
  });

  it('rechecks the authoritative sync token before recurrence materialization', () => {
    const state = createInitialState('guest');
    const syncInProgress = vi.fn(() => true);

    expect(materializeRecurringTransactionsUnlessSyncing(
      state,
      '2026-08-27',
      undefined,
      syncInProgress,
    )).toBe(state);
    expect(syncInProgress).toHaveBeenCalledOnce();
  });

  it('includes dependent recurring rules and reordered siblings in a category mutation lock', () => {
    const state = createInitialState('guest');
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    const sibling = state.data.categories.find((item) => item.kind === 'expense' && item.id !== category.id)!;
    const account = state.data.accounts[0];
    state.data.recurringRules = [{
      id: 'rule-dependent', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-create',
      name: '依賴規則', type: 'expense', amount: 100,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    }];
    state.unresolvedSyncRecordKeys = ['recurringRules:rule-dependent'];
    const targets = syncMutationTargets(state, 'categories', {
      ...category,
      name: '改名後分類',
      sortOrder: sibling.sortOrder,
    });

    expect(targets).toEqual(expect.arrayContaining([
      { entity: 'categories', recordId: sibling.id },
      { entity: 'recurringRules', recordId: 'rule-dependent' },
    ]));
    expect(() => assertSyncRecordMutationsAllowed(state, targets)).toThrow(/未解同步衝突/);
  });

  it('allows an appended replacement category without touching a locked tombstoned sibling', () => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    state.outbox = [];
    const expenseCategories = state.data.categories
      .filter((category) => category.kind === 'expense' && !category.deletedAt);
    const locked = expenseCategories[0];
    state.unresolvedSyncRecordKeys = [`categories:${locked.id}`];
    const replacement = {
      id: 'replacement-expense', ownerId: 'user-a', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'replacement-create',
      name: '替代支出', kind: 'expense' as const,
      icon: { type: 'emoji' as const, value: '🧾' }, isActive: true,
      sortOrder: Math.max(...expenseCategories.map((category) => category.sortOrder)) + 1,
    };

    const targets = syncMutationTargets(state, 'categories', replacement);

    expect(targets).toEqual([{ entity: 'categories', recordId: replacement.id }]);
    expect(() => assertSyncRecordMutationsAllowed(state, targets)).not.toThrow();
  });

  it('expands a persisted conflict lock to every still-pending batch member', () => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    const rule: RecurringRule = {
      id: 'rule-batch-member', ownerId: 'user-a', version: 2,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-pause',
      name: '批次規則', type: 'expense', amount: 100,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: false,
    };
    state.data.recurringRules = [rule];
    state.outbox = [{
      id: account.lastOperationId, entity: 'accounts', recordId: account.id,
      record: account, attempts: 1, queuedAt: account.updatedAt, batchId: 'archive-batch',
      batchBeforeRecord: account,
    }, {
      id: rule.lastOperationId, entity: 'recurringRules', recordId: rule.id,
      record: rule, attempts: 1, queuedAt: rule.updatedAt, batchId: 'archive-batch',
      batchBeforeRecord: { ...rule, version: 1, lastOperationId: 'rule-active', isActive: true },
    }];
    state.unresolvedSyncRecordKeys = [`accounts:${account.id}`];

    expect(() => assertSyncRecordMutationAllowed(state, 'recurringRules', rule.id))
      .toThrow(/未解同步衝突/);
  });

  it('blocks a new recurring rule while either selected parent belongs to a pending batch', () => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.outbox = [{
      id: account.lastOperationId,
      entity: 'accounts',
      recordId: account.id,
      record: account,
      attempts: 0,
      queuedAt: account.updatedAt,
      batchId: 'pending-account-batch',
      batchBeforeRecord: structuredClone(account),
    }];
    const rule: RecurringRule = {
      id: 'new-rule-under-pending-parent', ownerId: 'user-a', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-create',
      name: '新規則', type: 'expense', amount: 100,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-09-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    };
    const targets = syncMutationTargets(state, 'recurringRules', rule);

    expect(targets).toEqual(expect.arrayContaining([
      { entity: 'accounts', recordId: account.id },
      { entity: 'categories', recordId: category.id },
    ]));
    expect(() => assertSyncRecordMutationsAllowed(state, targets)).toThrow(/未解同步衝突/);
  });

  it('locks transactions, adjustments, and category budgets behind their referenced parents', () => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    state.outbox = [];
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.unresolvedSyncRecordKeys = [
      `accounts:${account.id}`,
      `categories:${category.id}`,
    ];
    const meta = {
      ownerId: 'user-a', version: 1, updatedAt: '2026-08-27T00:00:00.000Z',
    } as const;
    const transactionTargets = syncMutationTargets(state, 'transactions', {
      ...meta, id: 'new-transaction', lastOperationId: 'transaction-create',
      amount: 100, type: 'expense', categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-27 08:00',
    });
    const adjustmentTargets = syncMutationTargets(state, 'adjustments', {
      ...meta, id: 'new-adjustment', lastOperationId: 'adjustment-create',
      accountId: account.id, amountDelta: 50, occurredAt: '2026-08-27 08:01',
    });
    const budgetTargets = syncMutationTargets(state, 'budgets', {
      ...meta, id: 'new-budget', lastOperationId: 'budget-create',
      scope: 'category', categoryId: category.id, categoryName: category.name,
      period: 'monthly', amount: 5_000, isActive: true,
    });

    expect(transactionTargets).toEqual(expect.arrayContaining([
      { entity: 'accounts', recordId: account.id },
      { entity: 'categories', recordId: category.id },
    ]));
    expect(adjustmentTargets).toContainEqual({ entity: 'accounts', recordId: account.id });
    expect(budgetTargets).toContainEqual({ entity: 'categories', recordId: category.id });
    expect(() => assertSyncRecordMutationsAllowed(state, transactionTargets)).toThrow(/未解同步衝突/);
    expect(() => assertSyncRecordMutationsAllowed(state, adjustmentTargets)).toThrow(/未解同步衝突/);
    expect(() => assertSyncRecordMutationsAllowed(state, budgetTargets)).toThrow(/未解同步衝突/);
  });

  it('keeps old parents locked when an edit changes references or a delete tombstones the child', () => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    state.outbox = [];
    const oldAccount = state.data.accounts[0];
    const newAccount = { ...oldAccount, id: 'safe-account', lastOperationId: 'safe-account-create' };
    const oldCategory = state.data.categories.find((item) => item.kind === 'expense')!;
    const newCategory = {
      ...oldCategory, id: 'safe-category', lastOperationId: 'safe-category-create', name: '安全分類',
    };
    state.data.accounts.push(newAccount);
    state.data.categories.push(newCategory);
    const existing: Transaction = {
      id: 'transaction-old-parents', ownerId: 'user-a', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'transaction-create',
      amount: 100, type: 'expense', categoryId: oldCategory.id, categoryName: oldCategory.name,
      accountId: oldAccount.id, accountName: oldAccount.name, occurredAt: '2026-08-27 08:00',
    };
    state.data.transactions = [existing];
    state.unresolvedSyncRecordKeys = [
      `accounts:${oldAccount.id}`,
      `categories:${oldCategory.id}`,
    ];
    const moved = {
      ...existing, version: 2, lastOperationId: 'transaction-move',
      accountId: newAccount.id, accountName: newAccount.name,
      categoryId: newCategory.id, categoryName: newCategory.name,
    };

    const editTargets = syncMutationTargets(state, 'transactions', moved);
    const deleteTargets = syncMutationTargets(state, 'transactions', existing);

    expect(editTargets).toEqual(expect.arrayContaining([
      { entity: 'accounts', recordId: oldAccount.id },
      { entity: 'categories', recordId: oldCategory.id },
      { entity: 'accounts', recordId: newAccount.id },
      { entity: 'categories', recordId: newCategory.id },
    ]));
    expect(() => assertSyncRecordMutationsAllowed(state, editTargets)).toThrow(/未解同步衝突/);
    expect(() => assertSyncRecordMutationsAllowed(state, deleteTargets)).toThrow(/未解同步衝突/);
  });

  it('does not materialize a recurring transaction while a referenced parent is conflicted', () => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    state.outbox = [];
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.recurringRules = [{
      id: 'rule-conflicted-parent', ownerId: 'user-a', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-create',
      name: '房租', type: 'expense', amount: 10_000,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-08-01',
      isActive: true,
    }];
    state.unresolvedSyncRecordKeys = [`accounts:${account.id}`];

    const result = materializeRecurringTransactionsUnlessRecovering(
      state,
      '2026-08-27',
      undefined,
    );

    expect(result).toBe(state);
    expect(result.data.transactions).toEqual([]);
    expect(result.data.recurringRules[0].nextOccurrenceDate).toBe('2026-08-01');
  });

  it('locks a new allocation behind its parent goal and every active sibling allocation', () => {
    const state = createInitialState('guest');
    state.data.goals = [{
      id: 'goal-a', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'goal-create',
      name: '緊急預備金', targetAmount: 5_000, isActive: true,
    }];
    state.data.allocations = [{
      id: 'allocation-existing', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'allocation-create',
      goalId: 'goal-a', amountDelta: 500, occurredAt: '2026-08-27 08:00',
    }];
    state.unresolvedSyncRecordKeys = ['allocations:allocation-existing'];
    const targets = syncMutationTargets(state, 'allocations', {
      id: 'allocation-new', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T01:00:00.000Z', lastOperationId: 'allocation-new',
      goalId: 'goal-a', amountDelta: 300, occurredAt: '2026-08-27 09:00',
    });

    expect(targets).toEqual(expect.arrayContaining([
      { entity: 'goals', recordId: 'goal-a' },
      { entity: 'allocations', recordId: 'allocation-existing' },
    ]));
    expect(() => assertSyncRecordMutationsAllowed(state, targets)).toThrow(/未解同步衝突/);
  });

  it('blocks backup restore until every record conflict has an explicit resolution', () => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    state.unresolvedSyncRecordKeys = [`accounts:${state.data.accounts[0].id}`];

    expect(() => restoreFinanceStateUnlessLegacyBootstrap(
      state,
      structuredClone(state.data),
      vi.fn(),
      vi.fn(),
    )).toThrow(/先.*選擇雲端版本/);
  });
});

function corruptedGuestLoad() {
  const raw = '{broken-json';
  const getItem = vi.fn((key: string) => key === storageKey('guest') ? raw : null);
  return {
    getItem,
    load: () => loadFinanceStateWithRecovery('guest', { getItem }),
  };
}

function readyLegacyState() {
  const state = createInitialState('user-a');
  state.initialBootstrap = undefined;
  state.outbox = [];
  const candidate = structuredClone(state.data);
  candidate.accounts[0] = {
    ...candidate.accounts[0],
    name: '舊版現金',
  };
  state.legacyBootstrap = {
    status: 'ready',
    candidate,
    unsyncedTransactionIds: [],
  };
  return state;
}

describe('authenticated legacy bootstrap decisions', () => {
  it('persists removal of the candidate before returning the keep-cloud state', () => {
    const state = readyLegacyState();
    const persisted: typeof state[] = [];

    const next = resolveLegacyBootstrapState(
      state,
      'keep-cloud',
      (value) => persisted.push(value),
      vi.fn(),
    );

    expect(persisted).toEqual([next]);
    expect(next.legacyBootstrap).toBeUndefined();
    expect(next.migratedFromLegacy).toBeUndefined();
    expect(next.data).toEqual(state.data);
    expect(state.legacyBootstrap?.status).toBe('ready');
  });

  it('imports the candidate through the durable restore path only after an explicit decision', () => {
    const state = readyLegacyState();
    const order: string[] = [];

    const next = resolveLegacyBootstrapState(
      state,
      'import-candidate',
      () => order.push('persist'),
      () => order.push('clear-recovery'),
    );

    expect(order).toEqual(['persist', 'clear-recovery']);
    expect(next.legacyBootstrap).toBeUndefined();
    expect(next.migratedFromLegacy).toBeUndefined();
    expect(next.data.accounts[0].name).toBe('舊版現金');
    expect(next.data.accounts[0].version).toBeGreaterThan(state.data.accounts[0].version);
    expect(next.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'accounts', recordId: state.data.accounts[0].id }),
    ]));
  });

  it('keeps the candidate and recovery lock when persistence fails', () => {
    const state = readyLegacyState();
    const clearRecovery = vi.fn();

    expect(() => resolveLegacyBootstrapState(
      state,
      'import-candidate',
      () => { throw new Error('quota exceeded'); },
      clearRecovery,
    )).toThrow(/quota exceeded/);

    expect(clearRecovery).not.toHaveBeenCalled();
    expect(state.legacyBootstrap?.status).toBe('ready');
  });

  it('rejects decisions until the cloud-first pull has completed', () => {
    const state = readyLegacyState();
    state.legacyBootstrap = { ...state.legacyBootstrap!, status: 'pending' };
    const persist = vi.fn();

    expect(() => resolveLegacyBootstrapState(
      state,
      'keep-cloud',
      persist,
      vi.fn(),
    )).toThrow(/cloud-first pull/i);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(['pending', 'ready'] as const)(
    'blocks an ordinary backup restore while the legacy candidate is %s',
    (status) => {
      const state = readyLegacyState();
      state.legacyBootstrap = { ...state.legacyBootstrap!, status };
      const persist = vi.fn();
      const clearRecovery = vi.fn();

      expect(() => restoreFinanceStateUnlessLegacyBootstrap(
        state,
        structuredClone(state.data),
        persist,
        clearRecovery,
      )).toThrow(/完成舊版候選資料決策/);

      expect(persist).not.toHaveBeenCalled();
      expect(clearRecovery).not.toHaveBeenCalled();
      expect(state.legacyBootstrap?.status).toBe(status);
    },
  );
});

describe('authenticated initial bootstrap gate', () => {
  it('blocks ordinary mutations and backup restore until the cloud-first pull completes', () => {
    const state = createInitialState('user-a');
    const account = {
      ...state.data.accounts[0],
      id: 'blocked-before-pull',
      lastOperationId: 'blocked-before-pull-create',
    };
    const persist = vi.fn();
    const clearRecovery = vi.fn();

    expect(() => putRecord(state, 'accounts', account)).toThrow(/initial bootstrap/i);
    expect(() => restoreFinanceStateUnlessLegacyBootstrap(
      state,
      structuredClone(state.data),
      persist,
      clearRecovery,
    )).toThrow(/authoritative pull/i);
    expect(materializeRecurringTransactionsUnlessRecovering(
      state,
      '2026-08-24',
      undefined,
    )).toBe(state);
    expect(persist).not.toHaveBeenCalled();
    expect(clearRecovery).not.toHaveBeenCalled();
    expect(state.outbox).toEqual([]);
  });

  it('allows an explicit valid backup to durably recover a malformed authenticated snapshot', () => {
    const storage = {
      getItem: (key: string) => key === storageKey('user-a') ? '{broken-json' : null,
    };
    const loaded = loadFinanceStateWithRecovery('user-a', storage);
    const backup = structuredClone(createInitialState('user-a').data);
    const order: string[] = [];

    const restored = restoreFinanceStateUnlessLegacyBootstrap(
      loaded.state,
      backup,
      () => order.push('persist'),
      () => order.push('clear-recovery'),
      true,
    );

    expect(loaded.recovery).toBeDefined();
    expect(order).toEqual(['persist', 'clear-recovery']);
    expect(restored.initialBootstrap).toBeUndefined();
    expect(restored.outbox).toHaveLength(15);
    expect(restored.outbox.every(({ record }) => record.deletedAt === undefined)).toBe(true);
    expect(restored.data.accounts).toHaveLength(1);
    expect(restored.data.categories).toHaveLength(14);
  });

  it('keeps recurrence materialization blocked throughout partial default seeding', () => {
    const state = createInitialState('user-a');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'income')!;
    state.data.recurringRules = [{
      id: 'seeding-weekly-income',
      ownerId: 'user-a',
      version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastOperationId: 'seeding-weekly-income-create',
      name: '每週收入',
      type: 'income',
      amount: 1_000,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      frequency: 'weekly',
      startDate: '2026-08-03',
      nextOccurrenceDate: '2026-08-03',
      isActive: true,
    }];
    state.initialBootstrap = { ...state.initialBootstrap!, status: 'seeding' };

    expect(materializeRecurringTransactionsUnlessRecovering(
      state,
      '2026-08-24',
      undefined,
    )).toBe(state);
    expect(state.outbox).toEqual([]);
  });
});

describe('owner-bound controller actions', () => {
  it('accepts the exact owner and activation generation rendered with the action', () => {
    expect(() => assertCurrentOwnerContext(
      { ownerId: 'user-a', generation: 3 },
      'user-a',
      'user-a',
      3,
    )).not.toThrow();
  });

  it('rejects a stale action after switching to another owner', () => {
    expect(() => assertCurrentOwnerContext(
      { ownerId: 'user-a', generation: 3 },
      'user-b',
      'user-b',
      4,
    )).toThrow(/帳號已切換/);
  });

  it('rejects a stale action after reactivating the same owner', () => {
    expect(() => assertCurrentOwnerContext(
      { ownerId: 'user-a', generation: 3 },
      'user-a',
      'user-a',
      4,
    )).toThrow(/帳號已切換/);
  });
});

describe('local snapshot recovery mutation lock', () => {
  it('clears the stale safety notice together with the recovery lock after a durable restore', () => {
    const loaded = corruptedGuestLoad().load();
    const recoveryRef = { current: loaded.recovery };
    const setRecovery = vi.fn();
    const setSafetyNotice = vi.fn();

    clearSuccessfulRecoveryUiState(recoveryRef, setRecovery, setSafetyNotice);

    expect(recoveryRef.current).toBeUndefined();
    expect(setRecovery).toHaveBeenCalledOnce();
    expect(setRecovery).toHaveBeenCalledWith(undefined);
    expect(setSafetyNotice).toHaveBeenCalledOnce();
    expect(setSafetyNotice).toHaveBeenCalledWith(undefined);
  });

  it('does not enqueue or expose an ordinary mutation that would disappear on reload', () => {
    const storage = corruptedGuestLoad();
    const loaded = storage.load();
    const account = loaded.state.data.accounts[0];
    const category = loaded.state.data.categories.find((item) => item.kind === 'expense')!;
    const transaction: Transaction = {
      id: 'blocked-expense',
      ownerId: 'guest',
      version: 1,
      updatedAt: '2026-08-23T00:00:00.000Z',
      lastOperationId: 'blocked-expense-create',
      amount: 100,
      type: 'expense',
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      occurredAt: '2026-08-23T00:00:00.000Z',
    };
    const mutate = vi.fn((current: typeof loaded.state) => (
      putRecord(current, 'transactions', transaction)
    ));

    const next = applyFinanceMutationUnlessRecovering(
      loaded.state,
      loaded.recovery,
      mutate,
    );

    expect(loaded.recovery).toBeDefined();
    expect(mutate).not.toHaveBeenCalled();
    expect(next).toBe(loaded.state);
    expect(next.data.transactions).toEqual([]);
    expect(next.outbox).toEqual([]);

    const reloaded = storage.load();
    expect(reloaded.recovery?.raw).toBe('{broken-json');
    expect(reloaded.state.data.transactions).toEqual([]);
    expect(reloaded.state.outbox).toEqual([]);
  });

  it('does not materialize recurring transactions or advance their cursor during recovery', () => {
    const storage = corruptedGuestLoad();
    const loaded = storage.load();
    const account = loaded.state.data.accounts[0];
    const category = loaded.state.data.categories.find((item) => item.kind === 'income')!;
    const rule: RecurringRule = {
      id: 'blocked-weekly-income',
      ownerId: 'guest',
      version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastOperationId: 'blocked-weekly-income-create',
      name: '每週收入',
      type: 'income',
      amount: 1_000,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      frequency: 'weekly',
      startDate: '2026-08-03',
      nextOccurrenceDate: '2026-08-03',
      isActive: true,
    };
    const state = {
      ...loaded.state,
      data: {
        ...loaded.state.data,
        recurringRules: [rule],
      },
    };

    const next = materializeRecurringTransactionsUnlessRecovering(
      state,
      '2026-08-23',
      loaded.recovery,
    );

    expect(next).toBe(state);
    expect(next.data.transactions).toEqual([]);
    expect(next.data.recurringRules[0]).toBe(rule);
    expect(next.data.recurringRules[0].nextOccurrenceDate).toBe('2026-08-03');
    expect(next.outbox).toEqual([]);
    expect(storage.load().recovery?.raw).toBe('{broken-json');
  });
});
