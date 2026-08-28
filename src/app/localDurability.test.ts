// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PersistedFinanceState,
  SavingsAllocation,
  SavingsGoal,
  Transaction,
} from '../domain/model';
import {
  assertFreshLocalRecordMutation,
  assertLatestMutationDependencies,
  assertRestoreBaseUnchanged,
  createInitialState,
  legacyStorageKeys,
  putRecord,
  saveFinanceState,
  storageKey,
} from './state';
import { restoreFinanceStateUnlessLegacyBootstrap } from './useFinanceApp';
import {
  createFinancePersistence,
  createInMemoryOwnerStateStore,
  createIndexedDbOwnerStateStore,
} from './localDurability';

beforeEach(() => localStorage.clear());

function readyOwnerState(ownerId: string): PersistedFinanceState {
  const state = createInitialState(ownerId);
  state.initialBootstrap = undefined;
  state.outbox = [];
  return state;
}

function transaction(
  state: PersistedFinanceState,
  id: string,
  amount: number,
): Transaction {
  const category = state.data.categories.find((candidate) => candidate.kind === 'expense')!;
  const account = state.data.accounts[0];
  return {
    id,
    ownerId: state.ownerId,
    amount,
    type: 'expense',
    categoryId: category.id,
    categoryName: category.name,
    accountId: account.id,
    accountName: account.name,
    occurredAt: '2026-08-28 12:00',
    version: 1,
    updatedAt: '2026-08-28T04:00:00.000Z',
    lastOperationId: `operation-${id}`,
  };
}

describe('owner-scoped durable finance persistence', () => {
  it('does not publish or replace the prior durable state when the storage write fails', async () => {
    const owner = readyOwnerState('user-a');
    const store = createInMemoryOwnerStateStore();
    const persistence = createFinancePersistence(store, localStorage);
    saveFinanceState(owner);
    const loaded = await persistence.load(owner.ownerId);
    const before = structuredClone(loaded.state);
    store.failNextWrite(new DOMException('quota exhausted', 'QuotaExceededError'));

    const result = await persistence.commit(owner.ownerId, 'attempt-fails', (latest) => (
      putRecord(latest, 'transactions', transaction(latest, 'failed-write', 80))
    ));

    expect(result).toMatchObject({ ok: false, lockWrites: true, code: 'DURABILITY_FAILED' });
    expect((await persistence.load(owner.ownerId)).state).toEqual(before);
  });

  it('persists an authenticated record and its matching outbox atomically', async () => {
    const owner = readyOwnerState('user-a');
    saveFinanceState(owner);
    const store = createInMemoryOwnerStateStore();
    const firstContext = createFinancePersistence(store, localStorage);
    const secondContext = createFinancePersistence(store, localStorage);
    await firstContext.load(owner.ownerId);
    const record = transaction(owner, 'durable-authenticated', 125);

    const committed = await firstContext.commit(owner.ownerId, record.lastOperationId, (latest) => (
      putRecord(latest, 'transactions', record)
    ));
    const reloaded = await secondContext.load(owner.ownerId);

    expect(committed.ok).toBe(true);
    expect(reloaded.state.data.transactions).toContainEqual(record);
    expect(reloaded.state.outbox).toContainEqual(expect.objectContaining({
      id: record.lastOperationId,
      entity: 'transactions',
      recordId: record.id,
      record,
    }));
  });

  it('serializes two same-owner IndexedDB contexts that both started at S0 while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const owner = readyOwnerState('user-a');
    saveFinanceState(owner);
    const factory = new IDBFactory();
    const databaseName = 'durability-concurrency-test';
    const contextA = createFinancePersistence(
      createIndexedDbOwnerStateStore(factory, databaseName),
      localStorage,
    );
    const contextB = createFinancePersistence(
      createIndexedDbOwnerStateStore(factory, databaseName),
      localStorage,
    );
    const [loadedA, loadedB] = await Promise.all([
      contextA.load(owner.ownerId),
      contextB.load(owner.ownerId),
    ]);
    expect(loadedA.state.data.transactions).toEqual([]);
    expect(loadedB.state.data.transactions).toEqual([]);
    const recordA = transaction(loadedA.state, 'transaction-a', 100);
    const recordB = transaction(loadedB.state, 'transaction-b', 200);

    await Promise.all([
      contextA.commit(owner.ownerId, recordA.lastOperationId, (latest) => (
        putRecord(latest, 'transactions', recordA)
      )),
      contextB.commit(owner.ownerId, recordB.lastOperationId, (latest) => (
        putRecord(latest, 'transactions', recordB)
      )),
    ]);
    const finalState = (await contextA.load(owner.ownerId)).state;

    expect(finalState.data.transactions.map(({ id }) => id)).toEqual(expect.arrayContaining([
      recordA.id,
      recordB.id,
    ]));
    expect(finalState.outbox.map(({ id }) => id)).toEqual(expect.arrayContaining([
      recordA.lastOperationId,
      recordB.lastOperationId,
    ]));
    expect(finalState.outbox).toHaveLength(2);
  });

  it('publishes no IndexedDB state when the object-store put aborts', async () => {
    const factory = new IDBFactory();
    const store = createIndexedDbOwnerStateStore(factory, 'indexeddb-abort-test');
    const initial = readyOwnerState('guest');
    const sourceSnapshot = JSON.stringify(Object.fromEntries([
      storageKey('guest'),
      ...legacyStorageKeys('guest'),
    ].map((key) => [key, null])));
    const envelope = {
      ownerId: 'guest', revision: 0, state: initial,
      appliedAttemptIds: [], legacySourceRaw: sourceSnapshot,
    };
    await store.transact('guest', () => envelope);

    await expect(store.transact('guest', (current) => ({
      ...current!,
      revision: 1,
      uncloneable: () => undefined,
    }) as never)).rejects.toMatchObject({ name: 'DataCloneError' });
    const afterAbort = await store.transact('guest', (current) => current!);

    expect(afterAbort.revision).toBe(0);
    expect(afterAbort.state).toEqual(initial);
  });

  it('isolates owners, replays an attempt once, and never resurrects a tombstone', async () => {
    const userA = readyOwnerState('user-a');
    const userB = readyOwnerState('user-b');
    const original = transaction(userA, 'delete-me', 300);
    userA.data.transactions = [original];
    saveFinanceState(userA);
    saveFinanceState(userB);
    const store = createInMemoryOwnerStateStore();
    const persistence = createFinancePersistence(store, localStorage);
    await persistence.load(userA.ownerId);
    await persistence.load(userB.ownerId);
    const reducer = vi.fn((latest: PersistedFinanceState) => putRecord(latest, 'transactions', {
      ...latest.data.transactions.find(({ id }) => id === original.id)!,
      version: 2,
      updatedAt: '2026-08-28T05:00:00.000Z',
      lastOperationId: 'tombstone:delete-me',
      deletedAt: '2026-08-28T05:00:00.000Z',
    }));

    const deleted = await persistence.commit(userA.ownerId, 'delete-attempt', reducer);
    const replayed = await persistence.commit(userA.ownerId, 'delete-attempt', reducer);
    const foreignWrite = await persistence.commit(userB.ownerId, 'foreign-attempt', (latest) => (
      putRecord(latest, 'transactions', original)
    ));

    expect(deleted.ok).toBe(true);
    expect(replayed).toMatchObject({ ok: true, replayed: true });
    expect(reducer).toHaveBeenCalledOnce();
    expect(foreignWrite).toMatchObject({ ok: false, code: 'DOMAIN_REJECTED' });
    const finalA = (await persistence.load(userA.ownerId)).state;
    expect(finalA.data.transactions[0]).toMatchObject({
      id: original.id,
      deletedAt: '2026-08-28T05:00:00.000Z',
      lastOperationId: 'tombstone:delete-me',
    });
    expect((await persistence.load(userB.ownerId)).state.data.transactions).toEqual([]);
  });

  it('does not consume an attempt receipt for a temporary no-op', async () => {
    const owner = readyOwnerState('user-a');
    saveFinanceState(owner);
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const loaded = await persistence.load(owner.ownerId);
    let allowed = false;
    const record = transaction(loaded.state, 'retry-after-no-op', 35);
    const reducer = vi.fn((latest: PersistedFinanceState) => (
      allowed ? putRecord(latest, 'transactions', record) : latest
    ));

    const noOp = await persistence.commit(owner.ownerId, 'retryable-attempt', reducer);
    allowed = true;
    const applied = await persistence.commit(owner.ownerId, 'retryable-attempt', reducer);

    expect(noOp).toMatchObject({ ok: true, revision: 0, replayed: false });
    expect(applied).toMatchObject({ ok: true, revision: 1, replayed: false });
    expect(reducer).toHaveBeenCalledTimes(2);
    expect((await persistence.load(owner.ownerId)).state.data.transactions).toContainEqual(record);
  });

  it('fails closed when an older PWA writer changes localStorage after IndexedDB migration', async () => {
    const owner = readyOwnerState('user-a');
    saveFinanceState(owner);
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    await persistence.load(owner.ownerId);
    const staleWriterState = putRecord(
      owner,
      'transactions',
      transaction(owner, 'legacy-writer-operation', 45),
    );
    saveFinanceState(staleWriterState);

    const loaded = await persistence.load(owner.ownerId);
    const commit = await persistence.commit(owner.ownerId, 'new-writer-attempt', (latest) => (
      putRecord(latest, 'transactions', transaction(latest, 'new-writer-operation', 55))
    ));

    expect(loaded.recovery?.message).toMatch(/舊版 PWA|migration/);
    expect(loaded.recovery?.raw).toContain('legacy-writer-operation');
    expect(commit).toMatchObject({ ok: false, code: 'RECOVERY_LOCKED', lockWrites: true });
  });

  it('also detects a pre-v3 legacy-key writer after migration', async () => {
    const firstLegacy = {
      id: 'legacy-a', amount: 40, type: 'expense', category: '餐飲',
      account: '現金', date: '2026-08-28 10:00',
    };
    localStorage.setItem('guest_transactions', JSON.stringify([firstLegacy]));
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const migrated = await persistence.load('guest');
    expect(migrated.state.data.transactions).toHaveLength(1);
    localStorage.setItem('guest_transactions', JSON.stringify([
      firstLegacy,
      { ...firstLegacy, id: 'legacy-b', amount: 50 },
    ]));

    const commit = await persistence.commit('guest', 'new-bundle-write', (latest) => (
      putRecord(latest, 'transactions', transaction(latest, 'new-bundle-transaction', 60))
    ));

    expect(commit).toMatchObject({ ok: false, code: 'RECOVERY_LOCKED', lockWrites: true });
    if (commit.ok === false) expect(commit.message).toMatch(/舊版 PWA|migration/);
  });

  it('keeps a committed tombstone when another context submits a stale active edit', async () => {
    const owner = readyOwnerState('user-a');
    const original = transaction(owner, 'tombstone-race', 60);
    owner.data.transactions = [original];
    saveFinanceState(owner);
    const store = createInMemoryOwnerStateStore();
    const contextA = createFinancePersistence(store, localStorage);
    const contextB = createFinancePersistence(store, localStorage);
    await Promise.all([contextA.load(owner.ownerId), contextB.load(owner.ownerId)]);
    const staleEdit = { ...original, amount: 70, version: 2, lastOperationId: 'stale-edit' };

    const deleted = await contextA.commit(owner.ownerId, 'delete-wins', (latest) => {
      const current = latest.data.transactions.find(({ id }) => id === original.id)!;
      return putRecord(latest, 'transactions', {
        ...current,
        version: current.version + 1,
        updatedAt: '2026-08-28T06:00:00.000Z',
        lastOperationId: 'tombstone:delete-wins',
        deletedAt: '2026-08-28T06:00:00.000Z',
      });
    });
    const edited = await contextB.commit(owner.ownerId, staleEdit.lastOperationId, (latest) => {
      assertFreshLocalRecordMutation(latest, 'transactions', staleEdit);
      return putRecord(latest, 'transactions', staleEdit);
    });

    expect(deleted.ok).toBe(true);
    expect(edited).toMatchObject({ ok: false, code: 'DOMAIN_REJECTED' });
    if (edited.ok === false) expect(edited.message).toMatch(/其他分頁刪除|tombstone/);
    const finalRecord = (await contextA.load(owner.ownerId)).state.data.transactions[0];
    expect(finalRecord).toMatchObject({
      amount: 60,
      lastOperationId: 'tombstone:delete-wins',
      deletedAt: '2026-08-28T06:00:00.000Z',
    });
  });

  it('rejects a stale transaction when another context archives its selected parent', async () => {
    const owner = readyOwnerState('user-a');
    saveFinanceState(owner);
    const store = createInMemoryOwnerStateStore();
    const contextA = createFinancePersistence(store, localStorage);
    const contextB = createFinancePersistence(store, localStorage);
    const [, loadedB] = await Promise.all([contextA.load(owner.ownerId), contextB.load(owner.ownerId)]);
    const staleTransaction = transaction(loadedB.state, 'stale-parent-transaction', 90);
    const account = owner.data.accounts[0];

    const archived = await contextA.commit(owner.ownerId, 'archive-parent', (latest) => (
      putRecord(latest, 'accounts', {
        ...latest.data.accounts.find(({ id }) => id === account.id)!,
        isActive: false,
        version: account.version + 1,
        updatedAt: '2026-08-28T07:00:00.000Z',
        lastOperationId: 'archive-parent-operation',
      })
    ));
    const staleWrite = await contextB.commit(
      owner.ownerId,
      staleTransaction.lastOperationId,
      (latest) => {
        assertFreshLocalRecordMutation(latest, 'transactions', staleTransaction);
        assertLatestMutationDependencies(latest, 'transactions', staleTransaction);
        return putRecord(latest, 'transactions', staleTransaction);
      },
    );

    expect(archived.ok).toBe(true);
    expect(staleWrite).toMatchObject({ ok: false, code: 'DOMAIN_REJECTED' });
    expect((await contextA.load(owner.ownerId)).state.data.transactions).toEqual([]);
  });

  it('rejects a stale restore preview instead of tombstoning another context write', async () => {
    const owner = readyOwnerState('user-a');
    saveFinanceState(owner);
    const store = createInMemoryOwnerStateStore();
    const contextA = createFinancePersistence(store, localStorage);
    const contextB = createFinancePersistence(store, localStorage);
    const [, loadedB] = await Promise.all([contextA.load(owner.ownerId), contextB.load(owner.ownerId)]);
    const stalePreviewBase = structuredClone(loadedB.state);
    const staleRestoreData = structuredClone(loadedB.state.data);
    const recordA = transaction(owner, 'survives-stale-restore', 110);
    await contextA.commit(owner.ownerId, recordA.lastOperationId, (latest) => (
      putRecord(latest, 'transactions', recordA)
    ));

    const staleRestore = await contextB.commit(owner.ownerId, 'stale-restore', (latest) => {
      assertRestoreBaseUnchanged(stalePreviewBase, latest);
      return restoreFinanceStateUnlessLegacyBootstrap(
        latest,
        staleRestoreData,
        () => undefined,
        () => undefined,
      );
    });
    const finalState = (await contextA.load(owner.ownerId)).state;

    expect(staleRestore).toMatchObject({ ok: false, code: 'DOMAIN_REJECTED' });
    expect(finalState.data.transactions).toContainEqual(recordA);
    expect(finalState.outbox).toContainEqual(expect.objectContaining({ id: recordA.lastOperationId }));
  });

  it('serializes allocation availability checks against the latest durable state', async () => {
    const owner = readyOwnerState('user-a');
    owner.data.accounts[0].openingBalance = 100;
    const goal: SavingsGoal = {
      id: 'goal-shared', ownerId: owner.ownerId, version: 1,
      updatedAt: '2026-08-28T04:00:00.000Z', lastOperationId: 'seed-goal-shared',
      name: '共同目標', targetAmount: 500, isActive: true,
    };
    owner.data.goals = [goal];
    saveFinanceState(owner);
    const factory = new IDBFactory();
    const databaseName = 'allocation-concurrency-test';
    const contextA = createFinancePersistence(createIndexedDbOwnerStateStore(factory, databaseName), localStorage);
    const contextB = createFinancePersistence(createIndexedDbOwnerStateStore(factory, databaseName), localStorage);
    await Promise.all([contextA.load(owner.ownerId), contextB.load(owner.ownerId)]);
    const allocation = (id: string): SavingsAllocation => ({
      id, ownerId: owner.ownerId, version: 1,
      updatedAt: '2026-08-28T08:00:00.000Z', lastOperationId: `operation-${id}`,
      goalId: goal.id, amountDelta: 80, occurredAt: '2026-08-28 16:00',
    });
    const allocationA = allocation('allocation-a');
    const allocationB = allocation('allocation-b');
    const commitAllocation = (
      persistence: typeof contextA,
      value: SavingsAllocation,
    ) => persistence.commit(owner.ownerId, value.lastOperationId, (latest) => {
      assertFreshLocalRecordMutation(latest, 'allocations', value);
      assertLatestMutationDependencies(latest, 'allocations', value);
      return putRecord(latest, 'allocations', value);
    });

    const results = await Promise.all([
      commitAllocation(contextA, allocationA),
      commitAllocation(contextB, allocationB),
    ]);
    const finalState = (await contextA.load(owner.ownerId)).state;

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toHaveLength(1);
    expect(finalState.data.allocations.filter(({ deletedAt }) => !deletedAt)).toHaveLength(1);
    expect(finalState.outbox.filter(({ entity }) => entity === 'allocations')).toHaveLength(1);
  });

  it('replaces a recovery-locked source only when the caller presents the exact preserved raw value', async () => {
    localStorage.setItem('shiba-finance:v3:guest', '{broken-json');
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const locked = await persistence.load('guest');
    const replacement = createInitialState('guest');
    replacement.data.transactions = [transaction(replacement, 'recovered-transaction', 75)];

    const staleRecovery = await persistence.recover(
      'guest',
      'stale-recovery',
      '{different-json',
      replacement,
    );
    const recovered = await persistence.recover(
      'guest',
      'valid-recovery',
      locked.recovery!.raw,
      replacement,
    );

    expect(staleRecovery).toMatchObject({ ok: false, code: 'DOMAIN_REJECTED' });
    expect(recovered.ok).toBe(true);
    expect((await persistence.load('guest')).state.data.transactions)
      .toContainEqual(replacement.data.transactions[0]);
  });

  it('repairs corrupted revision and retry-receipt metadata from an exact recovery source', async () => {
    const sourceSnapshot = JSON.stringify(Object.fromEntries([
      storageKey('guest'),
      ...legacyStorageKeys('guest'),
    ].map((key) => [key, null])));
    let corrupted: any = {
      ownerId: 'guest',
      revision: -1,
      state: createInitialState('guest'),
      appliedAttemptIds: { invalid: true },
      legacySourceRaw: sourceSnapshot,
    };
    const store: Parameters<typeof createFinancePersistence>[0] = {
      async transact(_ownerId, update) {
        corrupted = update(structuredClone(corrupted));
        return structuredClone(corrupted);
      },
    };
    const persistence = createFinancePersistence(store, localStorage);
    const locked = await persistence.load('guest');
    expect(locked.recovery).toBeDefined();

    const recovered = await persistence.recover(
      'guest',
      'repair-corrupted-metadata',
      locked.recovery!.raw,
      createInitialState('guest'),
    );

    expect(recovered).toMatchObject({ ok: true, revision: 1 });
    expect((await persistence.load('guest')).recovery).toBeUndefined();
  });
});
