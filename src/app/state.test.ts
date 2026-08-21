import { describe, expect, it } from 'vitest';
import {
  applySyncCompletion,
  applyRestoredData,
  canAutoSaveFinanceState,
  createInitialState,
  guestSnapshotFingerprint,
  hasUserContent,
  loadFinanceState,
  loadFinanceStateWithRecovery,
  mergeConcurrentSync,
  putRecord,
  remapOwner,
  saveFinanceState,
  storageKey,
} from './state';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('owner-scoped local state', () => {
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
    expect(loadFinanceState('user-b', storage).ownerId).toBe('user-b');
  });

  it('refuses records owned by another user', () => {
    const state = createInitialState('user-a');
    const foreign = { ...state.data.accounts[0], ownerId: 'user-b' };
    expect(() => putRecord(state, 'accounts', foreign)).toThrow(/其他使用者/);
  });

  it('migrates account-specific legacy data without importing guest data into a user', () => {
    const storage = memoryStorage();
    storage.setItem('guest_transactions', JSON.stringify([{ id: 'guest-tx', amount: 99, type: 'expense', category: '餐飲', account: '現金', date: '2026-08-20 12:00' }]));
    storage.setItem('user_transactions_user-a', JSON.stringify([{ id: 'user-tx', amount: 200, type: 'income', category: '薪資', account: '現金', date: '2026-08-20 18:00' }]));
    storage.setItem('custom_categories', JSON.stringify([{ name: '訪客私密分類', icon: '🔒', type: 'expense' }]));

    const guest = loadFinanceState('guest', storage);
    const user = loadFinanceState('user-a', storage);

    expect(guest.data.transactions.map((item) => item.id)).toEqual(['guest-tx']);
    expect(user.data.transactions.map((item) => item.id)).toEqual(['user-tx']);
    expect(user.outbox.length).toBeGreaterThan(0);
    expect(user.data.transactions.every((item) => item.ownerId === 'user-a')).toBe(true);
    expect(user.data.categories.some((item) => item.name === '訪客私密分類')).toBe(false);
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

  it('treats guest-only category customization as user content and fingerprints changes', () => {
    const data = createInitialState('guest').data;
    expect(hasUserContent(data)).toBe(false);
    const before = guestSnapshotFingerprint(data);
    data.categories[0] = { ...data.categories[0], name: '早午餐', icon: { type: 'emoji', value: '🥢' } };
    expect(hasUserContent(data)).toBe(true);
    expect(guestSnapshotFingerprint(data)).not.toBe(before);
  });

  it('does not lose a local mutation completed while synchronization is in flight', () => {
    const started = createInitialState('user-a');
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
    const started = createInitialState('user-a');
    const synced = { ...started, outbox: [], lastSyncedAt: '2026-08-21T10:00:00.000Z' };
    const guest = createInitialState('guest');
    const userB = createInitialState('user-b');

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
    const current = createInitialState('user-a');
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
});

function newRecordForTest(id: string, ownerId: string) {
  return { id, ownerId, version: 1, updatedAt: '2026-08-20T00:00:00.000Z', lastOperationId: `op-${id}` };
}
