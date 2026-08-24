import { describe, expect, it } from 'vitest';
import {
  applySyncCompletion,
  applyRestoredData,
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
  releaseGoalAllocations,
  remapOwner,
  saveFinanceState,
  storageKey,
} from './state';
import { TUTORIAL_RECORD_NOTE } from '../domain/tutorialRecord';
import { syncFinanceState, type RemoteRecord } from '../domain/syncEngine';

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

    const result = await syncFinanceState(initial, 'user-a', {
      apply: async (_ownerId, operation) => { calls.push(`apply:${operation.entity}`); },
      pull: async () => {
        calls.push('pull');
        return [
          { entity: 'accounts', record: cloudAccount },
          { entity: 'categories', record: cloudCategory },
          { entity: 'transactions', record: cloudTransaction },
        ] as RemoteRecord[];
      },
    }, () => '2026-08-24T10:01:00.000Z');

    expect(calls).toEqual(['pull']);
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
    expect(calls.filter((call) => call === 'pull')).toHaveLength(2);
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

    expect(calls).toEqual(['pull', `apply:${genuineAccount.lastOperationId}`, 'pull']);
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
        lastOperationId: 'same-tick-restore',
      }),
    ]));
    expect(restored.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity: 'accounts',
        recordId: 'same-tick-wallet',
        id: 'same-tick-restore',
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
      schemaVersion: 3,
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
      name: '備份舊值', version: 10, lastOperationId: 'op-restore-10',
    });
    expect(result.outbox).toEqual([
      expect.objectContaining({ id: 'op-restore-10', entity: 'accounts', recordId: cloudCurrent.id }),
    ]);
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
        id: 'op-legacy-precision-restore',
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
