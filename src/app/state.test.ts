import { describe, expect, it } from 'vitest';
import {
  applySyncCompletion,
  applyAccountArchiveMutation,
  applyGoalAllocationReleaseMutation,
  applyRestoredData,
  applyCategoryLifecycleMutation,
  advanceFinanceStateRef,
  canAutoSaveFinanceState,
  createInitialState,
  guestSnapshotFingerprint,
  hasUserContent,
  loadFinanceState,
  loadFinanceStateWithRecovery,
  mergeConcurrentSync,
  persistGuestImportState,
  planGuestImport,
  putRecord,
  putCategoryWithDependents,
  putAccountWithDependents,
  releaseGoalAllocations,
  remapOwner,
  saveFinanceState,
  storageKey,
  tombstoneRecordMeta,
} from './state';
import { TUTORIAL_RECORD_NOTE } from '../domain/tutorialRecord';
import type { FinanceData } from '../domain/model';
import { activeOperationId, syncFinanceState, type RemoteRecord } from '../domain/syncEngine';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function readyAuthenticatedState(ownerId = 'user-a') {
  const state = createInitialState(ownerId);
  state.initialBootstrap = undefined;
  return state;
}

describe('owner-scoped local state', () => {
  it('upgrades a schema-3 snapshot and bootstrap candidates without losing the original key', () => {
    const legacy = createInitialState('user-a') as unknown as Record<string, unknown>;
    legacy.schemaVersion = 3;
    const legacyData = legacy.data as Record<string, unknown>;
    delete legacyData.transfers;
    const bootstrap = legacy.initialBootstrap as { candidate: Record<string, unknown> };
    delete bootstrap.candidate.transfers;
    const raw = JSON.stringify(legacy);
    const storage = {
      getItem: (key: string) => key === storageKey('user-a') ? raw : null,
    };

    const loaded = loadFinanceStateWithRecovery('user-a', storage);

    expect(loaded.recovery).toBeUndefined();
    expect(loaded.state.schemaVersion).toBe(4);
    expect(loaded.state.data.transfers).toEqual([]);
    expect(loaded.state.initialBootstrap?.candidate.transfers).toEqual([]);
  });

  it('round-trips a pending authenticated transfer across an app restart', () => {
    const storage = memoryStorage();
    const initial = readyAuthenticatedState();
    const source = initial.data.accounts[0];
    const destination = {
      ...source, id: 'account-bank', name: '銀行', sortOrder: 1,
      lastOperationId: 'account-bank-create',
    };
    initial.data.accounts.push(destination);
    const record = {
      id: 'offline-transfer', ownerId: initial.ownerId, amount: 321,
      sourceAccountId: source.id, sourceAccountName: source.name,
      destinationAccountId: destination.id, destinationAccountName: destination.name,
      occurredAt: '2026-08-28 10:30', note: '離線建立', version: 1,
      updatedAt: '2026-08-28T02:30:00.000Z', lastOperationId: 'offline-transfer-create',
    } satisfies FinanceData['transfers'][number];
    const pending = putRecord(initial, 'transfers', record);

    saveFinanceState(pending, storage);
    const reloaded = loadFinanceState('user-a', storage);

    expect(reloaded.data.transfers).toEqual([record]);
    expect(reloaded.outbox).toEqual([expect.objectContaining({
      entity: 'transfers', recordId: record.id, record,
    })]);
  });

  it('quarantines an impossible guest conflict lock so backup recovery remains available', () => {
    const impossible = createInitialState('guest');
    impossible.unresolvedSyncRecordKeys = [`accounts:${impossible.data.accounts[0].id}`];
    const storage = {
      getItem: (key: string) => key === storageKey('guest') ? JSON.stringify(impossible) : null,
    };

    const loaded = loadFinanceStateWithRecovery('guest', storage);

    expect(loaded.recovery?.message).toMatch(/unresolved sync record keys/);
    expect(loaded.recovery?.raw).toContain('unresolvedSyncRecordKeys');
    expect(loaded.state.unresolvedSyncRecordKeys).toBeUndefined();
  });

  it('archives an account and pauses its active recurring rules atomically', () => {
    const state = readyAuthenticatedState();
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.recurringRules = [{
      id: 'rule-account', ownerId: state.ownerId, version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-created',
      name: '月租', type: 'expense', amount: 10_000,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    }];

    const next = applyAccountArchiveMutation(
      state,
      account.id,
      new Date('2026-08-27T01:00:00.000Z'),
      () => 'account-archive',
    );

    expect(next.data.accounts[0].isActive).toBe(false);
    expect(next.data.recurringRules[0].isActive).toBe(false);
    expect(next.outbox.map((operation) => operation.recordId)).toEqual([
      'rule-account',
      account.id,
    ]);
    expect(state.data.accounts[0].isActive).toBe(true);
    expect(state.data.recurringRules[0].isActive).toBe(true);
  });

  it('releases every goal allocation in one authenticated outbox batch', () => {
    const state = readyAuthenticatedState();
    state.data.goals = [{
      id: 'goal-trip', ownerId: state.ownerId, version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'goal-create',
      name: '旅行', targetAmount: 10_000, isActive: true,
    }];
    state.data.allocations = ['a1', 'a2'].map((id) => ({
      id, ownerId: state.ownerId, version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: `${id}-create`,
      goalId: 'goal-trip', amountDelta: 500, occurredAt: '2026-08-27 08:00',
    }));

    const next = applyGoalAllocationReleaseMutation(
      state,
      'goal-trip',
      new Date('2026-08-27T01:00:00.000Z'),
      (() => {
        let index = 0;
        return () => `release-${++index}`;
      })(),
      'release-goal-batch',
    );

    expect(next.data.allocations.every((allocation) => Boolean(allocation.deletedAt))).toBe(true);
    expect(next.outbox).toHaveLength(2);
    expect(next.outbox.every((operation) => operation.batchId === 'release-goal-batch')).toBe(true);
    expect(state.data.allocations.every((allocation) => !allocation.deletedAt)).toBe(true);
  });

  it('archives a category and pauses its active recurring rules in one state transition', () => {
    const state = createInitialState('guest');
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    const account = state.data.accounts[0];
    state.data.recurringRules = [{
      id: 'rule-food', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-created',
      name: '午餐', type: 'expense', amount: 100,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    }];

    const next = applyCategoryLifecycleMutation(
      state,
      category.id,
      'archive',
      new Date('2026-08-27T01:00:00.000Z'),
      () => 'operation',
    );

    expect(next.data.categories.find((item) => item.id === category.id)?.isActive).toBe(false);
    expect(next.data.recurringRules[0].isActive).toBe(false);
    expect(state.data.recurringRules[0].isActive).toBe(true);
  });

  it('soft-deletes an unused authenticated category as a retryable tombstone', () => {
    const state = readyAuthenticatedState();
    const category = state.data.categories.find((item) => item.kind === 'expense')!;

    const next = applyCategoryLifecycleMutation(
      state,
      category.id,
      'delete',
      new Date('2026-08-27T01:00:00.000Z'),
      () => 'category-delete',
    );

    expect(next.data.categories.find((item) => item.id === category.id)).toMatchObject({
      isActive: false,
      deletedAt: '2026-08-27T01:00:00.000Z',
      lastOperationId: 'tombstone:category-delete',
    });
    expect(next.outbox).toEqual([
      expect.objectContaining({
        entity: 'categories',
        recordId: category.id,
        id: 'tombstone:category-delete',
      }),
    ]);
  });

  it('renames future recurring occurrences without rewriting historical transaction snapshots', () => {
    const state = createInitialState('guest');
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    const account = state.data.accounts[0];
    state.data.transactions = [{
      id: 'history', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'history-created',
      amount: 100, type: 'expense', categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-27 08:00',
    }];
    state.data.recurringRules = [{
      id: 'rule', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-created',
      name: '早餐', type: 'expense', amount: 100,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    }];

    const next = putCategoryWithDependents(state, {
      ...category,
      name: '外食',
      version: category.version + 1,
      updatedAt: '2026-08-27T01:00:00.000Z',
      lastOperationId: 'category-renamed',
    }, new Date('2026-08-27T01:00:00.000Z'), () => 'rule-renamed');

    expect(next.data.transactions[0].categoryName).toBe(category.name);
    expect(next.data.recurringRules[0].categoryName).toBe('外食');
  });

  it('renames future recurring account snapshots without rewriting history or adjustments', () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.transactions = [{
      id: 'history-account', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'history-account-created',
      amount: 100, type: 'expense', categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-27 08:00',
    }];
    state.data.adjustments = [{
      id: 'adjustment-history', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'adjustment-created',
      accountId: account.id, amountDelta: 50, occurredAt: '2026-08-27 09:00', reason: '盤點',
    }];
    state.data.recurringRules = [{
      id: 'rule-account', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'rule-account-created',
      name: '早餐', type: 'expense', amount: 100,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    }];

    const next = putAccountWithDependents(state, {
      ...account,
      name: '日常錢包',
      version: account.version + 1,
      updatedAt: '2026-08-27T01:00:00.000Z',
      lastOperationId: 'account-renamed',
    }, new Date('2026-08-27T01:00:00.000Z'), () => 'rule-account-renamed');

    expect(next.data.transactions[0].accountName).toBe(account.name);
    expect(next.data.adjustments).toEqual(state.data.adjustments);
    expect(next.data.recurringRules[0].accountName).toBe('日常錢包');
  });

  it('reorders one category without leaving duplicate sort positions', () => {
    const state = createInitialState('guest');
    const expenses = state.data.categories.filter((item) => item.kind === 'expense');
    const target = expenses.at(-1)!;
    const next = putCategoryWithDependents(state, {
      ...target,
      sortOrder: 0,
      version: target.version + 1,
      updatedAt: '2026-08-27T01:00:00.000Z',
      lastOperationId: 'category-reordered',
    }, new Date('2026-08-27T01:00:00.000Z'), () => 'sibling-reordered');
    const orders = next.data.categories
      .filter((item) => item.kind === 'expense' && !item.deletedAt)
      .map((item) => item.sortOrder)
      .sort((left, right) => left - right);

    expect(next.data.categories.find((item) => item.id === target.id)?.sortOrder).toBe(0);
    expect(orders).toEqual(orders.map((_, index) => index));
  });

  it('gives tombstones a conflict-clock operation id that wins same-version legacy edits', () => {
    const record = createInitialState('guest').data.categories[0];
    const meta = tombstoneRecordMeta(record, new Date('2026-08-27T00:00:00.000Z'), () => 'fixed');

    expect(meta).toEqual({
      version: record.version + 1,
      updatedAt: '2026-08-27T00:00:00.000Z',
      lastOperationId: 'tombstone:fixed',
      deletedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(meta.lastOperationId > 'ffffffff-ffff-ffff-ffff-ffffffffffff').toBe(true);
  });

  it('orders active updates below legacy UUID deletes across a preflight/apply race', () => {
    const active = activeOperationId('ffffffff-ffff-4fff-8fff-ffffffffffff');

    expect(active).toBe('00000000-0000-0000-0000-000000000000:active:ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(active < '00000000-0000-4000-8000-000000000000').toBe(true);
  });

  it('pulls an existing authenticated cloud graph before any synthetic default write', async () => {
    const initial = loadFinanceStateWithRecovery('user-a', memoryStorage()).state;
    const cloudAccount = {
      ...initial.data.accounts[0],
      name: 'Cloud authoritative account',
      version: 2,
      updatedAt: '2026-08-24T10:00:00.000Z',
      lastOperationId: 'cloud-account-v2',
    };
    const cloudCategory = {
      ...initial.data.categories[0],
      name: 'Cloud authoritative category',
      version: 2,
      updatedAt: '2026-08-24T10:00:00.000Z',
      lastOperationId: 'cloud-category-v2',
    };
    const cloudTransaction = {
      id: 'cloud-ledger-row',
      ownerId: 'user-a',
      version: 3,
      updatedAt: '2026-08-24T10:00:00.000Z',
      lastOperationId: 'cloud-ledger-row-v3',
      amount: 128,
      type: 'expense' as const,
      categoryId: cloudCategory.id,
      categoryName: cloudCategory.name,
      accountId: cloudAccount.id,
      accountName: cloudAccount.name,
      occurredAt: '2026-08-24T09:30',
    };
    const calls: string[] = [];
    const pullConsistencies: Array<string | undefined> = [];

    const result = await syncFinanceState(initial, 'user-a', {
      apply: async (_ownerId, operation) => { calls.push(`apply:${operation.entity}`); },
      pull: async (_ownerId, options) => {
        calls.push('pull');
        pullConsistencies.push(options?.consistency);
        return [
          { entity: 'accounts', record: cloudAccount },
          { entity: 'categories', record: cloudCategory },
          { entity: 'transactions', record: cloudTransaction },
        ] as RemoteRecord[];
      },
    }, () => '2026-08-24T10:01:00.000Z');

    expect(calls).toEqual(['pull']);
    expect(pullConsistencies).toEqual(['authoritative']);
    expect(result.state.data.accounts).toEqual([cloudAccount]);
    expect(result.state.data.categories).toEqual([cloudCategory]);
    expect(result.state.data.transactions).toEqual([cloudTransaction]);
    expect(result.state.outbox).toEqual([]);
  });

  it('creates and synchronizes defaults only after an authoritative pull proves the account is empty', async () => {
    const initial = loadFinanceStateWithRecovery('user-a', memoryStorage()).state;
    const calls: string[] = [];
    let remoteRecords: RemoteRecord[] = [];

    const result = await syncFinanceState(initial, 'user-a', {
      pull: async () => {
        calls.push('pull');
        return structuredClone(remoteRecords);
      },
      apply: async (_ownerId, operation) => {
        calls.push(`apply:${operation.entity}:${operation.recordId}`);
        const key = `${operation.entity}:${operation.recordId}`;
        remoteRecords = [
          ...remoteRecords.filter(({ entity, record }) => `${entity}:${record.id}` !== key),
          { entity: operation.entity, record: structuredClone(operation.record) } as RemoteRecord,
        ];
      },
    }, () => '2026-08-24T10:01:00.000Z');

    expect(calls[0]).toBe('pull');
    expect(calls.filter((call) => call === 'pull')).toHaveLength(3);
    expect(calls.filter((call) => call.startsWith('apply:'))).toHaveLength(15);
    expect(result.state.data.accounts).toHaveLength(1);
    expect(result.state.data.categories).toHaveLength(14);
    expect(result.state.outbox).toEqual([]);
    expect(result.state.initialBootstrap).toBeUndefined();
  });

  it('keeps partial default seeding durable across reload until every seed is synchronized', async () => {
    const storage = memoryStorage();
    const initial = loadFinanceStateWithRecovery('user-a', storage).state;
    let remoteRecords: RemoteRecord[] = [];
    let failAccountOnce = true;
    const remote = {
      pull: async () => structuredClone(remoteRecords),
      apply: async (_ownerId: string, operation: typeof initial.outbox[number]) => {
        if (operation.entity === 'accounts' && failAccountOnce) {
          failAccountOnce = false;
          throw new Error('temporary account write failure');
        }
        const key = `${operation.entity}:${operation.recordId}`;
        remoteRecords = [
          ...remoteRecords.filter(({ entity, record }) => `${entity}:${record.id}` !== key),
          { entity: operation.entity, record: structuredClone(operation.record) } as RemoteRecord,
        ];
      },
    };

    const first = await syncFinanceState(initial, 'user-a', remote);
    expect(first.state.initialBootstrap?.status).toBe('seeding');
    expect(first.state.outbox).toEqual([
      expect.objectContaining({ entity: 'accounts', attempts: 1 }),
    ]);
    expect(remoteRecords.filter(({ entity }) => entity === 'accounts')).toHaveLength(0);
    expect(remoteRecords.filter(({ entity }) => entity === 'categories')).toHaveLength(14);

    saveFinanceState(first.state, storage);
    const reloaded = loadFinanceStateWithRecovery('user-a', storage).state;
    expect(reloaded.initialBootstrap?.status).toBe('seeding');
    expect(reloaded.outbox).toHaveLength(1);
    expect(reloaded.initialBootstrap?.pendingOperations).toEqual([]);

    const second = await syncFinanceState(reloaded, 'user-a', remote);
    expect(second.state.initialBootstrap).toBeUndefined();
    expect(second.state.outbox).toEqual([]);
    expect(second.state.data.accounts).toHaveLength(1);
    expect(second.state.data.categories).toHaveLength(14);
    expect(remoteRecords.filter(({ entity }) => entity === 'accounts')).toHaveLength(1);
    expect(remoteRecords.filter(({ entity }) => entity === 'categories')).toHaveLength(14);
  });

  it('fails closed without applying or discarding provisional defaults when the first pull fails', async () => {
    const initial = loadFinanceStateWithRecovery('user-a', memoryStorage()).state;
    let applyCount = 0;

    const result = await syncFinanceState(initial, 'user-a', {
      apply: async () => { applyCount += 1; },
      pull: async () => { throw new Error('offline during authoritative bootstrap'); },
    });

    expect(applyCount).toBe(0);
    expect(result.report).toMatchObject({ status: 'partial', applied: 0, pulled: 0 });
    expect(result.state.initialBootstrap).toEqual(initial.initialBootstrap);
    expect(result.state.outbox).toEqual([]);
    expect(result.state.data).toEqual(initial.data);
  });

  it('recovers exact stale seed operations pull-first while preserving a genuine local mutation', async () => {
    const storage = memoryStorage();
    const unsafe = createInitialState('user-a');
    const candidate = structuredClone(unsafe.initialBootstrap!.candidate);
    unsafe.initialBootstrap = undefined;
    unsafe.data = structuredClone(candidate);
    unsafe.outbox = [];
    for (const record of unsafe.data.accounts) {
      unsafe.outbox.push({
        id: record.lastOperationId,
        entity: 'accounts',
        recordId: record.id,
        record,
        attempts: 7,
        queuedAt: record.updatedAt,
        lastError: 'conflicting payload for identical finance sync clock',
      });
    }
    for (const record of unsafe.data.categories) {
      unsafe.outbox.push({
        id: record.lastOperationId,
        entity: 'categories',
        recordId: record.id,
        record,
        attempts: 7,
        queuedAt: record.updatedAt,
        lastError: 'conflicting payload for identical finance sync clock',
      });
    }
    const genuineAccount = {
      ...unsafe.data.accounts[0],
      id: 'genuine-local-account',
      name: '離線新增帳戶',
      version: 1,
      updatedAt: '2026-08-24T10:05:00.000Z',
      lastOperationId: 'genuine-local-account-create',
    };
    unsafe.data.accounts.push(genuineAccount);
    unsafe.outbox.push({
      id: genuineAccount.lastOperationId,
      entity: 'accounts',
      recordId: genuineAccount.id,
      record: genuineAccount,
      attempts: 2,
      queuedAt: genuineAccount.updatedAt,
      lastError: 'offline',
    });
    saveFinanceState(unsafe, storage);

    const recovered = loadFinanceStateWithRecovery('user-a', storage).state;
    expect(recovered.outbox).toEqual([]);
    expect(recovered.initialBootstrap?.pendingOperations).toEqual([
      expect.objectContaining({ id: genuineAccount.lastOperationId, attempts: 2, lastError: 'offline' }),
    ]);

    const cloudAccount = { ...candidate.accounts[0], name: '雲端既有帳戶' };
    let remoteRecords: RemoteRecord[] = [
      { entity: 'accounts', record: cloudAccount },
      ...candidate.categories.map((record) => ({ entity: 'categories' as const, record })),
    ];
    const calls: string[] = [];
    const result = await syncFinanceState(recovered, 'user-a', {
      pull: async () => {
        calls.push('pull');
        return structuredClone(remoteRecords);
      },
      apply: async (_ownerId, operation) => {
        calls.push(`apply:${operation.id}`);
        const key = `${operation.entity}:${operation.recordId}`;
        remoteRecords = [
          ...remoteRecords.filter(({ entity, record }) => `${entity}:${record.id}` !== key),
          { entity: operation.entity, record: structuredClone(operation.record) } as RemoteRecord,
        ];
      },
    }, () => '2026-08-24T10:06:00.000Z');

    expect(calls).toEqual(['pull', 'pull', `apply:${genuineAccount.lastOperationId}`, 'pull']);
    expect(result.state.data.accounts).toEqual(expect.arrayContaining([cloudAccount, genuineAccount]));
    expect(result.state.outbox).toEqual([]);
    expect(result.state.initialBootstrap).toBeUndefined();
  });

  it('advances the mutation source synchronously so a same-tick restore tombstones a queued put', () => {
    const initial = readyAuthenticatedState();
    const backup = structuredClone(initial.data);
    const ref = { current: initial };
    const queuedAccount = {
      ...initial.data.accounts[0],
      id: 'same-tick-wallet',
      name: '同一事件迴圈新增',
      version: 1,
      lastOperationId: 'same-tick-put',
    };

    advanceFinanceStateRef(ref, (current) => putRecord(current, 'accounts', queuedAccount));
    const restored = applyRestoredData(
      ref.current,
      backup,
      new Date('2026-08-23T12:00:00.000Z'),
      () => 'same-tick-restore',
    );

    expect(restored.data.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'same-tick-wallet',
        deletedAt: '2026-08-23T12:00:00.000Z',
        lastOperationId: 'tombstone:same-tick-restore',
      }),
    ]));
    expect(restored.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity: 'accounts',
        recordId: 'same-tick-wallet',
        id: 'tombstone:same-tick-restore',
      }),
    ]));
  });

  it('keeps guest, user A and user B in separate keys', () => {
    const storage = memoryStorage();
    const guest = createInitialState('guest');
    const userA = createInitialState('user-a');
    saveFinanceState(guest, storage);
    saveFinanceState(userA, storage);

    expect(storageKey('guest')).not.toBe(storageKey('user-a'));
    expect(guest.data.accounts[0].id).not.toBe(userA.data.accounts[0].id);
    expect(loadFinanceState('guest', storage).ownerId).toBe('guest');
    expect(loadFinanceState('user-a', storage).ownerId).toBe('user-a');
    expect(loadFinanceState('user-a', storage).initialBootstrap?.status).toBe('pending');
    expect(loadFinanceState('user-b', storage).ownerId).toBe('user-b');
  });

  it('refuses records owned by another user', () => {
    const state = readyAuthenticatedState();
    const foreign = { ...state.data.accounts[0], ownerId: 'user-b' };
    expect(() => putRecord(state, 'accounts', foreign)).toThrow(/其他使用者/);
  });

  it('rejects an oversized multibyte record before it can enter the authenticated outbox', () => {
    const state = readyAuthenticatedState();
    const oversized = {
      ...state.data.accounts[0],
      name: '中'.repeat(171),
      version: 2,
      lastOperationId: 'oversized-name-operation',
    };

    expect(() => putRecord(state, 'accounts', oversized)).toThrow(/512 UTF-8 bytes/i);
    expect(state.outbox.some((operation) => operation.id === oversized.lastOperationId)).toBe(false);
  });

  it('rejects a new record at the owner ceiling while still allowing an existing record update', () => {
    const state = readyAuthenticatedState();
    const template = state.data.accounts[0];
    state.data.accounts = Array.from({ length: 250 }, (_, index) => ({
      ...template,
      id: `account-${index}`,
      name: `Account ${index}`,
      lastOperationId: `account-${index}-create`,
    }));
    state.outbox = [];

    expect(() => putRecord(state, 'accounts', {
      ...template,
      id: 'account-251',
      name: 'Account 251',
      lastOperationId: 'account-251-create',
    })).toThrow(/owner row limit.*250/i);

    expect(() => putRecord(state, 'accounts', {
      ...state.data.accounts[249],
      name: 'Updated account 250',
      version: 2,
      lastOperationId: 'account-250-update',
    })).not.toThrow();
  });

  it('keeps authenticated legacy data as a pull-only candidate without importing guest data', () => {
    const storage = memoryStorage();
    storage.setItem('guest_transactions', JSON.stringify([{ id: 'guest-tx', amount: 99, type: 'expense', category: '餐飲', account: '現金', date: '2026-08-20 12:00' }]));
    storage.setItem('user_transactions_user-a', JSON.stringify([{ id: 'user-tx', amount: 200, type: 'income', category: '薪資', account: '現金', date: '2026-08-20 18:00', synced: true }]));
    storage.setItem('custom_categories', JSON.stringify([{ name: '訪客私密分類', icon: '🔒', type: 'expense' }]));

    const guest = loadFinanceState('guest', storage);
    const user = loadFinanceState('user-a', storage);

    expect(guest.data.transactions.map((item) => item.id)).toEqual(['guest-tx']);
    expect(user.data.transactions).toEqual([]);
    expect(user.outbox).toEqual([]);
    expect(user.legacyBootstrap).toMatchObject({
      status: 'pending',
      unsyncedTransactionIds: [],
    });
    expect(user.legacyBootstrap?.candidate.transactions.map((item) => item.id)).toEqual(['user-tx']);
    expect(user.legacyBootstrap?.candidate.transactions.every((item) => item.ownerId === 'user-a')).toBe(true);
    expect(user.legacyBootstrap?.candidate.categories.some((item) => item.name === '訪客私密分類')).toBe(false);
  });

  it('preserves synced-false legacy transactions as durable review candidates across reloads', () => {
    const storage = memoryStorage();
    storage.setItem('user_transactions_user-a', JSON.stringify([
      { id: 'acknowledged', amount: 100, type: 'expense', category: '餐飲', account: '現金', date: '2026-08-20 12:00', synced: true },
      { id: 'offline-pending', amount: 250, type: 'expense', category: '交通', account: '現金', date: '2026-08-20 18:00', synced: false },
    ]));

    const first = loadFinanceState('user-a', storage);
    saveFinanceState(first, storage);
    const reloaded = loadFinanceState('user-a', storage);

    expect(first.outbox).toEqual([]);
    expect(first.legacyBootstrap?.candidate.transactions.map((item) => item.id)).toEqual([
      'acknowledged',
      'offline-pending',
    ]);
    expect(first.legacyBootstrap?.unsyncedTransactionIds).toEqual(['offline-pending']);
    expect(reloaded.legacyBootstrap).toEqual(first.legacyBootstrap);
  });

  it('demotes a pre-fix v3 legacy outbox back to a pull-only candidate on reload', () => {
    const storage = memoryStorage();
    storage.setItem('user_transactions_user-a', JSON.stringify([
      { id: 'stale-cache-row', amount: 180, type: 'expense', category: '餐飲', account: '現金', date: '2026-08-20 12:00', synced: true },
    ]));
    const safe = loadFinanceState('user-a', storage);
    const candidate = safe.legacyBootstrap!.candidate;
    const transaction = candidate.transactions[0];
    const unsafePreFixState = {
      ...safe,
      data: candidate,
      outbox: [{
        id: transaction.lastOperationId,
        entity: 'transactions' as const,
        recordId: transaction.id,
        record: transaction,
        attempts: 0,
        queuedAt: transaction.updatedAt,
      }],
      legacyBootstrap: undefined,
    };
    storage.setItem(storageKey('user-a'), JSON.stringify(unsafePreFixState));

    const recovered = loadFinanceState('user-a', storage);

    expect(recovered.data.transactions).toEqual([]);
    expect(recovered.outbox).toEqual([]);
    expect(recovered.lastSyncedAt).toBeUndefined();
    expect(recovered.legacyBootstrap).toEqual({
      status: 'pending',
      candidate,
      unsyncedTransactionIds: [],
    });
  });

  it('remaps guest IDs and references before an explicit account import', () => {
    const guest = createInitialState('guest').data;
    const accountId = guest.accounts[0].id;
    const categoryId = guest.categories.find((item) => item.kind === 'expense')!.id;
    guest.transactions.push({
      ...newRecordForTest('tx-guest', 'guest'),
      amount: 80,
      type: 'expense',
      accountId,
      accountName: '現金',
      categoryId,
      categoryName: '餐飲',
      occurredAt: '2026-08-20 08:00',
    });

    const imported = remapOwner(guest, 'user-a');
    expect(imported.accounts[0].id).not.toBe(accountId);
    expect(imported.transactions[0].accountId).toBe(imported.accounts[0].id);
    expect(imported.transactions[0].categoryId).toBe(imported.categories.find((item) => item.kind === 'expense')!.id);
    expect(imported.transactions[0].ownerId).toBe('user-a');
  });

  it('keeps imported guest tombstones above legacy active operation ids', () => {
    const guest = createInitialState('guest').data;
    guest.categories[0] = {
      ...guest.categories[0],
      isActive: false,
      deletedAt: '2026-08-20T00:00:00.000Z',
    };

    const imported = remapOwner(guest, 'user-a');

    expect(imported.categories[0].lastOperationId).toMatch(/^tombstone:/);
    expect(imported.categories[1].lastOperationId).toMatch(/^00000000-0000-0000-0000-000000000000:active:/);
  });

  it('fails an explicit guest re-import atomically when an earlier imported record changed', () => {
    const guest = createInitialState('guest').data;
    guest.categories[0] = { ...guest.categories[0], name: '早餐' };
    const firstMapped = remapOwner(guest, 'user-a');
    const firstImport = planGuestImport(
      readyAuthenticatedState(),
      firstMapped,
    );
    expect(firstImport.conflicts).toEqual([]);
    expect(firstImport.addedCount).toBeGreaterThan(0);

    const changedGuest = structuredClone(guest);
    changedGuest.categories[0] = { ...changedGuest.categories[0], name: '早午餐' };
    const secondImport = planGuestImport(
      firstImport.state,
      remapOwner(changedGuest, 'user-a'),
    );

    expect(secondImport.conflicts).toEqual([
      expect.objectContaining({ entity: 'categories', id: firstMapped.categories[0].id }),
    ]);
    expect(secondImport.state).toBe(firstImport.state);
    expect(secondImport.addedCount).toBe(0);
  });

  it('treats a repeated identical guest import as an explicit no-op despite new sync metadata', () => {
    const guest = createInitialState('guest').data;
    const firstImport = planGuestImport(
      readyAuthenticatedState(),
      remapOwner(guest, 'user-a'),
    );
    const repeated = planGuestImport(
      firstImport.state,
      remapOwner(guest, 'user-a'),
    );

    expect(repeated.conflicts).toEqual([]);
    expect(repeated.addedCount).toBe(0);
    expect(repeated.skippedCount).toBeGreaterThan(0);
  });

  it('marks guest-imported accounts and historical transfers as one explicit server batch', () => {
    const guest = createInitialState('guest').data;
    const source = { ...guest.accounts[0], isActive: false };
    const destination = {
      ...guest.accounts[0],
      id: 'guest-cash',
      name: '現金',
      lastOperationId: 'guest-cash-create',
      isActive: true,
      deletedAt: undefined,
    };
    guest.accounts = [source, destination];
    guest.transfers = [{
      ...newRecordForTest('guest-history-transfer', 'guest'),
      amount: 250,
      sourceAccountId: source.id,
      sourceAccountName: source.name,
      destinationAccountId: destination.id,
      destinationAccountName: destination.name,
      occurredAt: '2026-08-20 08:00',
    }];

    const imported = planGuestImport(
      readyAuthenticatedState(),
      remapOwner(guest, 'user-a'),
    ).state;
    const accountAndTransferOperations = imported.outbox.filter((operation) => (
      operation.entity === 'accounts' || operation.entity === 'transfers'
    ));
    const importBatchIds = new Set(accountAndTransferOperations.map((operation) => (
      (operation as typeof operation & { historicalImportBatchId?: string }).historicalImportBatchId
    )));

    expect(accountAndTransferOperations.some((operation) => operation.entity === 'transfers')).toBe(true);
    expect(importBatchIds.size).toBe(1);
    expect([...importBatchIds][0]).toMatch(/^historical-import:guest:/);
  });

  it('marks authenticated backup transfer restores as an explicit restore server batch', () => {
    const current = readyAuthenticatedState();
    current.outbox = [];
    const restored = structuredClone(current.data);
    const destination = {
      ...restored.accounts[0],
      id: 'restored-cash',
      name: '現金備用',
      lastOperationId: 'restored-cash-op',
    };
    restored.accounts.push(destination);
    restored.transfers.push({
      ...newRecordForTest('restored-history-transfer', 'user-a'),
      amount: 250,
      sourceAccountId: restored.accounts[0].id,
      sourceAccountName: restored.accounts[0].name,
      destinationAccountId: destination.id,
      destinationAccountName: destination.name,
      occurredAt: '2026-08-20 08:00',
    });

    const result = applyRestoredData(current, restored);
    const batchIds = new Set(result.outbox
      .filter((operation) => operation.entity === 'accounts' || operation.entity === 'transfers')
      .map((operation) => operation.historicalImportBatchId));

    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toMatch(/^historical-import:restore:/);
  });

  it('never remembers a guest import when its owner snapshot could not be persisted', () => {
    const imported = planGuestImport(
      readyAuthenticatedState(),
      remapOwner(createInitialState('guest').data, 'user-a'),
    ).state;
    const writes: string[] = [];
    const storage = {
      setItem: (key: string) => {
        writes.push(key);
        if (key === storageKey('user-a')) throw new Error('quota exceeded');
      },
    };

    expect(() => persistGuestImportState(
      imported,
      'shiba-finance:v3:guest-decision:user-a',
      'guest-fingerprint',
      storage,
    )).toThrow(/quota exceeded/);
    expect(writes).toEqual([storageKey('user-a')]);
  });

  it('reports a decision-write failure only after the imported owner snapshot is durable', () => {
    const imported = planGuestImport(
      readyAuthenticatedState(),
      remapOwner(createInitialState('guest').data, 'user-a'),
    ).state;
    const values = new Map<string, string>();
    const decisionKey = 'shiba-finance:v3:guest-decision:user-a';
    const result = persistGuestImportState(imported, decisionKey, 'fingerprint', {
      setItem: (key, value) => {
        if (key === decisionKey) throw new Error('decision storage denied');
        values.set(key, value);
      },
    });

    expect(result).toEqual({
      decisionRemembered: false,
      decisionError: 'decision storage denied',
    });
    expect(JSON.parse(values.get(storageKey('user-a')) ?? '{}')).toMatchObject({
      schemaVersion: 4,
      ownerId: 'user-a',
    });
  });

  it('releases each source allocation by stable tombstone so concurrent devices cannot double-release', () => {
    const base = [{
      ...newRecordForTest('allocation-source', 'user-a'),
      goalId: 'goal-a',
      amountDelta: 800,
      occurredAt: '2026-08-21 10:00',
    }];
    const deviceA = releaseGoalAllocations(
      base,
      'goal-a',
      new Date('2026-08-21T12:00:00.000Z'),
      () => 'release-a',
    );
    const deviceB = releaseGoalAllocations(
      base,
      'goal-a',
      new Date('2026-08-21T12:01:00.000Z'),
      () => 'release-b',
    );

    expect(deviceA).toEqual([expect.objectContaining({
      id: 'allocation-source', amountDelta: 800, deletedAt: '2026-08-21T12:00:00.000Z',
    })]);
    expect(deviceB[0].id).toBe(deviceA[0].id);
    expect(new Set([...deviceA, ...deviceB].map((record) => record.id))).toEqual(
      new Set(['allocation-source']),
    );
  });

  it('treats guest-only category customization as user content and fingerprints changes', () => {
    const data = createInitialState('guest').data;
    expect(hasUserContent(data)).toBe(false);
    const before = guestSnapshotFingerprint(data);
    data.categories[0] = { ...data.categories[0], name: '早午餐', icon: { type: 'emoji', value: '🥢' } };
    expect(hasUserContent(data)).toBe(true);
    expect(guestSnapshotFingerprint(data)).not.toBe(before);
  });

  it('does not treat or import an onboarding-only guest tombstone as long-term user content', () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.transactions.push({
      id: 'tutorial-record', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-24T09:00:00.000Z', lastOperationId: 'tutorial-delete',
      deletedAt: '2026-08-24T09:00:00.000Z', amount: 100, type: 'expense',
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-24 17:00',
      note: TUTORIAL_RECORD_NOTE,
    });

    expect(hasUserContent(state.data)).toBe(false);
    expect(remapOwner(state.data, 'user-a').transactions).toEqual([]);
  });

  it('does not lose a local mutation completed while synchronization is in flight', () => {
    const started = readyAuthenticatedState();
    const synced = { ...started, outbox: [], lastSyncedAt: '2026-08-21T10:00:00.000Z' };
    const transaction = {
      ...newRecordForTest('concurrent-tx', 'user-a'),
      amount: 80,
      type: 'expense' as const,
      accountId: started.data.accounts[0].id,
      accountName: started.data.accounts[0].name,
      categoryId: started.data.categories.find((item) => item.kind === 'expense')!.id,
      categoryName: '餐飲',
      occurredAt: '2026-08-21 12:00',
    };
    const latest = putRecord(started, 'transactions', transaction);

    const result = mergeConcurrentSync(started, latest, synced);

    expect(result.data.transactions).toEqual([transaction]);
    expect(result.outbox).toEqual([expect.objectContaining({ id: transaction.lastOperationId, recordId: transaction.id })]);
    expect(result.lastSyncedAt).toBe('2026-08-21T10:00:00.000Z');
  });

  it('keeps one complete authoritative bootstrap snapshot across same-owner contexts', () => {
    const started = createInitialState('user-a');
    const remoteBase = structuredClone(started.initialBootstrap!.candidate);
    const account = remoteBase.accounts[0];
    const category = remoteBase.categories.find((item) => item.kind === 'expense')!;
    const durableR1 = {
      ...started,
      data: {
        ...remoteBase,
        accounts: remoteBase.accounts.map((item) => item.id === account.id ? {
          ...item,
          name: 'Authoritative R1',
          version: 2,
          lastOperationId: 'remote-r1-account',
        } : item),
      },
      initialBootstrap: undefined,
      lastSyncedAt: '2026-08-28T12:00:00.000Z',
    };
    const remoteR2 = {
      ...started,
      data: {
        ...remoteBase,
        accounts: remoteBase.accounts.map((item) => item.id === account.id ? {
          ...item,
          name: 'Authoritative R2',
          version: 3,
          lastOperationId: 'remote-r2-account',
        } : item),
        transactions: [{
          ...newRecordForTest('remote-r2-independent', 'user-a'),
          amount: 80,
          type: 'expense' as const,
          accountId: account.id,
          accountName: account.name,
          categoryId: category.id,
          categoryName: category.name,
          occurredAt: '2026-08-28 20:00',
        }],
      },
      initialBootstrap: undefined,
      lastSyncedAt: '2026-08-28T12:00:01.000Z',
    };

    const result = applySyncCompletion(started, durableR1, remoteR2, 'user-a');

    expect(result).toEqual(durableR1);
  });

  it('preserves a durable seeding lifecycle when another bootstrap completion arrives', () => {
    const started = createInitialState('user-a');
    const candidate = structuredClone(started.initialBootstrap!.candidate);
    const account = candidate.accounts[0];
    const durableSeeding = {
      ...started,
      data: candidate,
      outbox: [{
        id: account.lastOperationId,
        entity: 'accounts' as const,
        recordId: account.id,
        record: account,
        attempts: 1,
        queuedAt: account.updatedAt,
      }],
      initialBootstrap: {
        ...started.initialBootstrap!,
        status: 'seeding' as const,
        pendingOperations: [],
      },
    };
    const completedElsewhere = {
      ...durableSeeding,
      outbox: [],
      initialBootstrap: undefined,
      lastSyncedAt: '2026-08-28T12:00:02.000Z',
    };

    const result = applySyncCompletion(started, durableSeeding, completedElsewhere, 'user-a');

    expect(result).toEqual(durableSeeding);
  });

  it('accepts a successful bootstrap after another context only persisted failure metadata', () => {
    const started = createInitialState('user-a');
    const failedElsewhere = {
      ...started,
      lastSyncError: 'Temporary authoritative pull failure',
    };
    const successful = {
      ...started,
      data: structuredClone(started.initialBootstrap!.candidate),
      initialBootstrap: undefined,
      lastSyncedAt: '2026-08-28T12:00:04.000Z',
      lastSyncError: undefined,
    };

    const result = applySyncCompletion(started, failedElsewhere, successful, 'user-a');

    expect(result).toEqual(successful);
  });

  it('does not let an older same-owner sync completion overwrite a newer conflict clock', () => {
    const started = readyAuthenticatedState();
    const account = started.data.accounts[0];
    const category = started.data.categories.find((item) => item.kind === 'expense')!;
    const durableOlder = {
      ...started,
      data: {
        ...started.data,
        accounts: started.data.accounts.map((item) => item.id === account.id ? {
          ...item,
          name: 'Remote version 2',
          version: 2,
          lastOperationId: 'remote-account-v2',
        } : item),
      },
      lastSyncedAt: '2026-08-28T12:00:00.000Z',
    };
    const syncedNewer = {
      ...started,
      data: {
        ...started.data,
        accounts: started.data.accounts.map((item) => item.id === account.id ? {
          ...item,
          name: 'Remote version 3',
          version: 3,
          lastOperationId: 'remote-account-v3',
        } : item),
        transactions: [{
          ...newRecordForTest('remote-version-3-transaction', 'user-a'),
          amount: 120,
          type: 'expense' as const,
          accountId: account.id,
          accountName: account.name,
          categoryId: category.id,
          categoryName: category.name,
          occurredAt: '2026-08-28 20:05',
        }],
      },
      lastSyncedAt: '2026-08-28T12:00:01.000Z',
    };

    const result = mergeConcurrentSync(started, durableOlder, syncedNewer);

    expect(result).toEqual(syncedNewer);
  });

  it('still replays a durable pending local edit over a higher remote conflict clock', () => {
    const started = readyAuthenticatedState();
    const account = started.data.accounts[0];
    const localAccount = {
      ...account,
      name: 'Pending local edit',
      version: 2,
      lastOperationId: 'local-account-v2',
    };
    const latest = putRecord(started, 'accounts', localAccount);
    const synced = {
      ...started,
      data: {
        ...started.data,
        accounts: started.data.accounts.map((item) => item.id === account.id ? {
          ...item,
          name: 'Remote version 3',
          version: 3,
          lastOperationId: 'remote-account-v3',
        } : item),
      },
      lastSyncedAt: '2026-08-28T12:00:03.000Z',
    };

    const result = mergeConcurrentSync(started, latest, synced);

    expect(result.data.accounts.find((item) => item.id === account.id)).toEqual(localAccount);
    expect(result.outbox).toEqual(latest.outbox);
  });

  it('rejects a delayed sync completion after switching from user A to guest or user B', () => {
    const started = readyAuthenticatedState();
    const synced = { ...started, outbox: [], lastSyncedAt: '2026-08-21T10:00:00.000Z' };
    const guest = createInitialState('guest');
    const userB = readyAuthenticatedState('user-b');

    expect(applySyncCompletion(started, guest, synced, 'guest')).toBe(guest);
    expect(applySyncCompletion(started, userB, synced, 'user-b')).toBe(userB);
    expect(applySyncCompletion(started, userB, synced, 'user-b').data.accounts
      .some((account) => account.ownerId === 'user-a')).toBe(false);
  });

  it('quarantines a corrupt v3 snapshot without overwriting its recoverable raw text', () => {
    const storage = memoryStorage();
    const key = storageKey('user-a');
    const corruptRaw = '{"schemaVersion":3,"ownerId":"user-a","data":';
    storage.setItem(key, corruptRaw);

    const loaded = loadFinanceStateWithRecovery('user-a', storage);

    expect(loaded.state.ownerId).toBe('user-a');
    expect(loaded.recovery).toMatchObject({ key, raw: corruptRaw });
    expect(canAutoSaveFinanceState(loaded.state, 'user-a', loaded.recovery)).toBe(false);
    expect(storage.getItem(key)).toBe(corruptRaw);
  });

  it('fails closed instead of crashing when browser storage denies the primary snapshot read', () => {
    const deniedStorage = {
      getItem: () => { throw new Error('SecurityError: storage access denied'); },
    };

    const loaded = loadFinanceStateWithRecovery('user-a', deniedStorage);

    expect(loaded.state.ownerId).toBe('user-a');
    expect(loaded.recovery).toMatchObject({
      key: storageKey('user-a'),
      raw: '',
    });
    expect(loaded.recovery?.message).toContain('storage access denied');
    expect(canAutoSaveFinanceState(loaded.state, 'user-a', loaded.recovery)).toBe(false);
  });

  it('keeps recovery mode active when legacy keys become unreadable after the primary lookup', () => {
    const primaryKey = storageKey('user-a');
    const intermittentlyDeniedStorage = {
      getItem: (key: string) => {
        if (key === primaryKey) return null;
        throw new Error('legacy storage read denied');
      },
    };

    const loaded = loadFinanceStateWithRecovery('user-a', intermittentlyDeniedStorage);

    expect(loaded.state.ownerId).toBe('user-a');
    expect(loaded.recovery?.raw).toContain('legacy-localStorage-recovery-unavailable');
    expect(loaded.recovery?.raw).not.toContain('transactions":[');
    expect(canAutoSaveFinanceState(loaded.state, 'user-a', loaded.recovery)).toBe(false);
  });

  it('blocks v3 autosave when corrupt legacy input cannot be migrated', () => {
    const storage = memoryStorage();
    storage.setItem('guest_transactions', '{broken legacy json');

    const loaded = loadFinanceStateWithRecovery('guest', storage);

    expect(loaded.recovery?.raw).toContain('guest_transactions');
    expect(canAutoSaveFinanceState(loaded.state, 'guest', loaded.recovery)).toBe(false);
    expect(storage.getItem('guest_transactions')).toBe('{broken legacy json');
    expect(storage.getItem(storageKey('guest'))).toBeNull();
  });

  it('rebases an older authenticated backup as a newer mutation instead of enqueueing its stale clock', () => {
    const current = readyAuthenticatedState();
    const cloudCurrent = current.data.accounts[0];
    current.data.accounts[0] = { ...cloudCurrent, name: '雲端新版', version: 9, lastOperationId: 'op-cloud-9' };
    current.outbox = [];
    const restored = structuredClone(current.data);
    restored.accounts[0] = { ...restored.accounts[0], name: '備份舊值', version: 2, lastOperationId: 'op-backup-2' };

    const result = applyRestoredData(
      current,
      restored,
      new Date('2026-08-21T12:00:00.000Z'),
      () => 'op-restore-10',
    );

    expect(result.data.accounts[0]).toMatchObject({
      name: '備份舊值', version: 10, lastOperationId: '00000000-0000-0000-0000-000000000000:active:op-restore-10',
    });
    expect(result.outbox).toEqual([
      expect.objectContaining({ id: '00000000-0000-0000-0000-000000000000:active:op-restore-10', entity: 'accounts', recordId: cloudCurrent.id }),
    ]);
  });

  it('preserves tombstone conflict priority when rebasing an authenticated restore', () => {
    const current = readyAuthenticatedState();
    const restored = structuredClone(current.data);
    restored.accounts[0] = {
      ...restored.accounts[0],
      isActive: false,
      deletedAt: '2026-08-20T00:00:00.000Z',
    };

    const result = applyRestoredData(
      current,
      restored,
      new Date('2026-08-27T00:00:00.000Z'),
      () => 'restore-delete',
    );

    expect(result.data.accounts[0]).toMatchObject({
      isActive: false,
      deletedAt: '2026-08-20T00:00:00.000Z',
      lastOperationId: 'tombstone:restore-delete',
    });
    expect(result.outbox[0]).toMatchObject({ id: 'tombstone:restore-delete' });
  });

  it('preserves supported legacy precision through authenticated restore and outbox enqueue', () => {
    const current = readyAuthenticatedState();
    current.outbox = [];
    const restored = structuredClone(current.data);
    restored.accounts[0] = { ...restored.accounts[0], openingBalance: 1.234567 };

    const result = applyRestoredData(
      current,
      restored,
      new Date('2026-08-21T12:00:00.000Z'),
      () => 'op-legacy-precision-restore',
    );

    expect(result.data.accounts[0].openingBalance).toBe(1.234567);
    expect(result.outbox).toEqual([
      expect.objectContaining({
        id: '00000000-0000-0000-0000-000000000000:active:op-legacy-precision-restore',
        entity: 'accounts',
        recordId: current.data.accounts[0].id,
        record: expect.objectContaining({ openingBalance: 1.234567 }),
      }),
    ]);
  });
});

function newRecordForTest(id: string, ownerId: string) {
  return { id, ownerId, version: 1, updatedAt: '2026-08-20T00:00:00.000Z', lastOperationId: `op-${id}` };
}
