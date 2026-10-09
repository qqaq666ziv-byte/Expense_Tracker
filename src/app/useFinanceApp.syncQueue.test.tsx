// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFinancePersistence, createInMemoryOwnerStateStore } from './localDurability';
import { useFinanceApp } from './useFinanceApp';
import { createInitialState } from './state';
import type { Transaction } from '../domain/model';
import type { RemotePullResponse, SyncReport, SyncResult } from '../domain/syncEngine';
import { syncRecordKey } from '../domain/syncEngine';
import type { FinanceSyncOutcome } from './useFinanceApp';

type SyntheticSession = { user: { id: string }; access_token: string };
const mocks = vi.hoisted(() => ({
  sync: vi.fn(), remote: vi.fn(),
  authChange: undefined as ((event: string, session: SyntheticSession | null) => void) | undefined,
}));
vi.mock('../lib/supabaseClient', () => ({
  supabaseConfigured: true,
  supabase: { auth: {
    getSession: async () => ({ data: { session: { user: { id: 'owner-sync' }, access_token: 'test-token' } } }),
    onAuthStateChange: (callback: typeof mocks.authChange) => {
      mocks.authChange = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
  } },
}));
vi.mock('../data/supabaseRemote', () => ({ createSupabaseRemoteAdapter: mocks.remote }));
vi.mock('./safeSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./safeSync')>()),
  syncFinanceStateUnlessRecovering: mocks.sync,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}

function syncedResult(state: SyncResult['state'], status: SyncReport['status'], transactionId?: string, failedPull = false): SyncResult {
  const next = structuredClone(state);
  if (transactionId) {
    const account = next.data.accounts[0];
    const category = next.data.categories.find((row) => row.kind === 'expense')!;
    const transaction: Transaction = {
      id: transactionId, ownerId: next.ownerId, amount: 12, type: 'expense',
      categoryId: category.id, categoryName: category.name, accountId: account.id, accountName: account.name,
      occurredAt: '2026-10-08 12:00', version: 1, updatedAt: '2026-10-08T12:00:00.000Z',
      lastOperationId: `operation-${transactionId}`,
    };
    next.data.transactions.push(transaction);
  }
  return { state: next, report: { ownerId: next.ownerId, status, applied: 0, pulled: transactionId ? 1 : 0,
    pending: [], failures: failedPull ? [{ stage: 'pull', message: 'synthetic failed pull' }] : [], conflicts: [] } };
}

async function conflictFixture() {
  const initial = createInitialState('owner-sync');
  initial.initialBootstrap = undefined;
  const account = initial.data.accounts[0];
  initial.unresolvedSyncRecordKeys = [syncRecordKey('accounts', account.id)];
  const store = createInMemoryOwnerStateStore();
  const persistence = createFinancePersistence(store, localStorage);
  expect((await persistence.commit(initial.ownerId, 'seed-conflict', () => initial)).ok).toBe(true);
  mocks.sync.mockResolvedValueOnce(undefined);
  const hook = renderHook(() => useFinanceApp(persistence));
  await waitFor(() => expect(hook.result.current.state.unresolvedSyncRecordKeys).toEqual(initial.unresolvedSyncRecordKeys));
  await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(hook.result.current.syncBusy).toBe(false));
  const pull = deferred<RemotePullResponse>();
  mocks.remote.mockReturnValue({ pull: vi.fn(() => pull.promise) });
  const remoteRecord = { entity: 'accounts' as const, record: {
    ...account, name: 'Synthetic cloud cash', version: account.version + 1,
    lastOperationId: 'synthetic-remote-account',
  } };
  return { ...hook, pull, remoteRecord, persistence, store };
}

describe('finance sync request coalescing', () => {
  beforeEach(() => {
    localStorage.clear(); mocks.sync.mockReset(); mocks.remote.mockReset().mockReturnValue({});
    mocks.authChange = undefined;
  });
  it('drains one trailing sync after accepting a cloud conflict and preserves all queued transaction IDs', async () => {
    const { result, pull, remoteRecord } = await conflictFixture();
    const trailing = deferred<SyncResult | undefined>();
    mocks.sync.mockReturnValueOnce(trailing.promise);
    let resolution!: Promise<boolean>;
    let firstRequest!: Promise<FinanceSyncOutcome>;
    let secondRequest!: Promise<FinanceSyncOutcome>;
    act(() => {
      resolution = result.current.acceptRemoteConflict('accounts', remoteRecord.record.id);
      firstRequest = result.current.syncNow(['transaction-first']);
      secondRequest = result.current.syncNow(['transaction-second', 'transaction-first']);
    });
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await act(async () => { pull.resolve([remoteRecord]); expect(await resolution).toBe(true); });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    const trailingStart = mocks.sync.mock.calls[1][0];
    expect(trailingStart.unresolvedSyncRecordKeys).toBeUndefined();
    expect(trailingStart.data.accounts).toContainEqual(remoteRecord.record);
    let settled = false;
    void firstRequest.then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    let outcomes!: FinanceSyncOutcome[];
    await act(async () => {
      const firstPulled = syncedResult(trailingStart, 'synced', 'transaction-first');
      trailing.resolve(syncedResult(firstPulled.state, 'synced', 'transaction-second'));
      outcomes = await Promise.all([firstRequest, secondRequest]);
    });
    expect(outcomes).toEqual([
      { status: 'synced', confirmedTransactionIds: ['transaction-first', 'transaction-second'] },
      { status: 'synced', confirmedTransactionIds: ['transaction-first', 'transaction-second'] },
    ]);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it.each(['pull rejection', 'invalid pull', 'missing record', 'durable commit failure'] as const)(
    'drains the queued refresh after conflict resolution fails through %s', async (failure) => {
      const { result, pull, remoteRecord, store } = await conflictFixture();
      mocks.sync.mockResolvedValueOnce(undefined);
      let resolution!: Promise<boolean>;
      let requested!: Promise<FinanceSyncOutcome>;
      act(() => {
        resolution = result.current.acceptRemoteConflict('accounts', remoteRecord.record.id);
        requested = result.current.syncNow(['transaction-unconfirmed']);
      });
      await act(async () => {
        if (failure === 'pull rejection') pull.reject(new Error('synthetic conflict pull failure'));
        else if (failure === 'invalid pull') {
          pull.resolve({ records: [], issues: [{ entity: 'accounts', stage: 'validation', message: 'synthetic invalid pull' }] });
        } else if (failure === 'missing record') pull.resolve([]);
        else {
          store.failNextWrite(new DOMException('synthetic conflict commit failure', 'QuotaExceededError'));
          pull.resolve([remoteRecord]);
        }
        expect(await resolution).toBe(false);
      });
      await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
      let outcome!: FinanceSyncOutcome;
      await act(async () => { outcome = await requested; });
      expect(outcome).toEqual({ status: 'skipped', confirmedTransactionIds: [] });
      expect(result.current.syncBusy).toBe(false);
      expect(result.current.state.unresolvedSyncRecordKeys).toEqual([syncRecordKey('accounts', remoteRecord.record.id)]);
    },
  );

  it.each(['partial', 'rejected', 'uncommitted'] as const)('preserves a trailing %s sync outcome after conflict acceptance', async (status) => {
    const { result, pull, remoteRecord, store } = await conflictFixture();
    mocks.sync.mockImplementationOnce(async (started) => {
      if (status === 'uncommitted') store.failNextWrite(new DOMException('synthetic trailing commit failure', 'QuotaExceededError'));
      return syncedResult(started, status === 'uncommitted' ? 'synced' : status, 'transaction-unconfirmed');
    });
    let resolution!: Promise<boolean>;
    let requested!: Promise<FinanceSyncOutcome>;
    act(() => {
      resolution = result.current.acceptRemoteConflict('accounts', remoteRecord.record.id);
      requested = result.current.syncNow(['transaction-unconfirmed']);
    });
    await act(async () => { pull.resolve([remoteRecord]); expect(await resolution).toBe(true); });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    let outcome!: FinanceSyncOutcome;
    await act(async () => { outcome = await requested; });
    expect(outcome).toEqual({ status, confirmedTransactionIds: [] });
  });

  it('rejects the waiting refresh if its trailing sync fails and releases the token for a retry', async () => {
    const { result, pull, remoteRecord } = await conflictFixture();
    const failure = new Error('synthetic trailing sync failure');
    mocks.sync.mockRejectedValueOnce(failure);
    let resolution!: Promise<boolean>;
    let requested!: Promise<FinanceSyncOutcome>;
    let rejected!: Promise<void>;
    act(() => {
      resolution = result.current.acceptRemoteConflict('accounts', remoteRecord.record.id);
      requested = result.current.syncNow(['transaction-unconfirmed']);
      rejected = expect(requested).rejects.toBe(failure);
    });
    await act(async () => { pull.resolve([remoteRecord]); expect(await resolution).toBe(true); });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    await rejected;
    expect(result.current.syncBusy).toBe(false);
    mocks.sync.mockResolvedValueOnce(undefined);
    await act(async () => {
      expect(await result.current.syncNow()).toEqual({ status: 'skipped', confirmedTransactionIds: [] });
    });
    expect(mocks.sync).toHaveBeenCalledTimes(3);
  });

  it.each(['owner switch', 'sign out'] as const)('cancels a conflict queue on %s without draining it into the next owner', async (cancellation) => {
    const { result, pull, remoteRecord } = await conflictFixture();
    const nextOwnerSync = deferred<SyncResult | undefined>();
    if (cancellation === 'owner switch') mocks.sync.mockReturnValueOnce(nextOwnerSync.promise);
    let resolution!: Promise<boolean>;
    let requested!: Promise<FinanceSyncOutcome>;
    act(() => {
      resolution = result.current.acceptRemoteConflict('accounts', remoteRecord.record.id);
      requested = result.current.syncNow(['transaction-old-owner']);
      mocks.authChange?.('SIGNED_IN', cancellation === 'owner switch'
        ? { user: { id: 'owner-next' }, access_token: 'test-next-token' }
        : null);
    });
    await waitFor(() => expect(result.current.state.ownerId).toBe(cancellation === 'owner switch' ? 'owner-next' : 'guest'));
    let outcome!: FinanceSyncOutcome;
    await act(async () => { outcome = await requested; });
    expect(outcome).toEqual({ status: 'skipped', confirmedTransactionIds: [] });
    if (cancellation === 'owner switch') await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    await act(async () => { pull.resolve([remoteRecord]); expect(await resolution).toBe(false); });
    expect(mocks.sync).toHaveBeenCalledTimes(cancellation === 'owner switch' ? 2 : 1);
    if (cancellation === 'owner switch') {
      expect(mocks.sync.mock.calls[1][0].ownerId).toBe('owner-next');
      expect(result.current.syncBusy).toBe(true);
      await act(async () => { nextOwnerSync.resolve(undefined); await Promise.resolve(); });
    }
  });

  it('discards old IDs and notices across owner A to B to A while preserving the new token', async () => {
    const { result, pull, remoteRecord } = await conflictFixture();
    const ownerBSync = deferred<SyncResult | undefined>();
    const returningOwnerSync = deferred<SyncResult | undefined>();
    mocks.sync.mockReturnValueOnce(ownerBSync.promise).mockReturnValueOnce(returningOwnerSync.promise);
    let resolution!: Promise<boolean>;
    let oldRequest!: Promise<FinanceSyncOutcome>;
    act(() => {
      resolution = result.current.acceptRemoteConflict('accounts', remoteRecord.record.id);
      oldRequest = result.current.syncNow(['transaction-old-generation']);
      mocks.authChange?.('SIGNED_IN', { user: { id: 'owner-next' }, access_token: 'test-next-token' });
    });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    act(() => { mocks.authChange?.('SIGNED_IN', { user: { id: 'owner-sync' }, access_token: 'test-return-token' }); });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(3));
    expect(await oldRequest).toEqual({ status: 'skipped', confirmedTransactionIds: [] });
    let newRequest!: Promise<FinanceSyncOutcome>;
    await act(async () => {
      expect(await result.current.acceptRemoteConflict('accounts', remoteRecord.record.id)).toBe(false);
      newRequest = result.current.syncNow(['transaction-new-generation']);
    });
    const currentNotice = result.current.safetyNotice;
    expect(currentNotice).toMatch(/同步進行中/);
    await act(async () => {
      pull.reject(new Error('synthetic stale conflict rejection'));
      expect(await resolution).toBe(false);
      ownerBSync.resolve(undefined);
      await Promise.resolve();
    });
    expect(result.current.syncBusy).toBe(true);
    expect(result.current.safetyNotice).toBe(currentNotice);
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    mocks.sync.mockImplementationOnce(async (started) => {
      const oldPulled = syncedResult(started, 'synced', 'transaction-old-generation');
      return syncedResult(oldPulled.state, 'synced', 'transaction-new-generation');
    });
    let outcome!: FinanceSyncOutcome;
    await act(async () => {
      returningOwnerSync.resolve(undefined);
      outcome = await newRequest;
    });
    expect(outcome).toEqual({ status: 'synced', confirmedTransactionIds: ['transaction-new-generation'] });
    expect(mocks.sync).toHaveBeenCalledTimes(4);
    expect(mocks.sync.mock.calls[3][0].ownerId).toBe('owner-sync');
  });

  it('settles a conflict queue as skipped on unmount and does not start a trailing sync', async () => {
    const { result, pull, remoteRecord, unmount } = await conflictFixture();
    let resolution!: Promise<boolean>;
    let requested!: Promise<FinanceSyncOutcome>;
    let outcome: FinanceSyncOutcome | undefined;
    act(() => {
      resolution = result.current.acceptRemoteConflict('accounts', remoteRecord.record.id);
      requested = result.current.syncNow(['transaction-unmounted']);
      void requested.then((next) => { outcome = next; });
    });
    unmount();
    await waitFor(() => expect(outcome).toEqual({ status: 'skipped', confirmedTransactionIds: [] }));
    pull.resolve([remoteRecord]);
    expect(await resolution).toBe(false);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  it('runs one trailing sync and keeps the import caller waiting for it', async () => {
    const first = deferred<SyncResult | undefined>();
    const second = deferred<SyncResult | undefined>();
    mocks.sync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const { result } = renderHook(() => useFinanceApp(persistence));
    await waitFor(() => expect(result.current.state.ownerId).toBe('owner-sync'));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    let requested!: Promise<FinanceSyncOutcome>;
    act(() => { requested = result.current.syncNow(['transaction-queued']); });
    await act(async () => { first.resolve(undefined); await Promise.resolve(); });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    let outcome: FinanceSyncOutcome | undefined;
    await act(async () => {
      second.resolve(syncedResult(mocks.sync.mock.calls[1][0], 'synced', 'transaction-queued'));
      outcome = await requested;
    });
    expect(outcome).toEqual({ status: 'synced', confirmedTransactionIds: ['transaction-queued'] });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it('settles a normal sync queue as skipped on unmount and ignores the in-flight result', async () => {
    const inFlight = deferred<SyncResult | undefined>();
    mocks.sync.mockReturnValueOnce(inFlight.promise);
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const { result, unmount } = renderHook(() => useFinanceApp(persistence));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    const started = mocks.sync.mock.calls[0][0];
    let outcome: FinanceSyncOutcome | undefined;
    let requested!: Promise<FinanceSyncOutcome>;
    const savedSyncNow = result.current.syncNow;
    act(() => {
      requested = result.current.syncNow(['transaction-unmounted']);
      void requested.then((next) => { outcome = next; });
    });
    unmount();
    await waitFor(() => expect(outcome).toEqual({ status: 'skipped', confirmedTransactionIds: [] }));
    inFlight.resolve(syncedResult(started, 'synced', 'transaction-unmounted'));
    await Promise.resolve();
    await Promise.resolve();
    expect(await savedSyncNow()).toEqual({ status: 'skipped', confirmedTransactionIds: [] });
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect((await persistence.load('owner-sync')).state.data.transactions).toEqual([]);
  });

  it('ignores a released token when StrictMode reactivates the mounted ref', async () => {
    const first = deferred<SyncResult | undefined>();
    const second = deferred<SyncResult | undefined>();
    mocks.sync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const requests: Promise<FinanceSyncOutcome>[] = [];
    const { result } = renderHook(() => {
      const app = useFinanceApp(persistence);
      useEffect(() => {
        mocks.authChange?.('SIGNED_IN', { user: { id: 'owner-sync' }, access_token: 'test-strict-token' });
        requests.push(app.syncNow());
        // Exercise the same setup, cleanup, and setup that React applies to effects.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return app;
    }, { wrapper: StrictMode });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.ownerId).toBe('owner-sync'));
    await act(async () => {
      first.resolve(syncedResult(mocks.sync.mock.calls[0][0], 'synced', 'transaction-stale-strict'));
      expect(await requests[0]).toEqual({ status: 'skipped', confirmedTransactionIds: [] });
    });
    expect(result.current.syncBusy).toBe(true);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect((await persistence.load('owner-sync')).state.data.transactions).toEqual([]);
    await act(async () => { second.resolve(undefined); await requests[1]; });
    await waitFor(() => expect(result.current.syncBusy).toBe(false));
  });

  it('does not confirm imported IDs after partial, skipped, or uncommitted syncs', async () => {
    const store = createInMemoryOwnerStateStore();
    const persistence = createFinancePersistence(store, localStorage);
    mocks.sync.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useFinanceApp(persistence));
    await waitFor(() => expect(result.current.state.ownerId).toBe('owner-sync'));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));

    const before = result.current.state;
    mocks.sync.mockResolvedValueOnce(syncedResult(before, 'partial', 'transaction-partial'));
    let partial!: FinanceSyncOutcome;
    await act(async () => { partial = await result.current.syncNow(['transaction-partial']); });
    expect(partial).toEqual({ status: 'partial', confirmedTransactionIds: [] });

    mocks.sync.mockResolvedValueOnce(syncedResult(result.current.state, 'synced', 'transaction-failed-pull', true));
    let failedPull!: FinanceSyncOutcome;
    await act(async () => { failedPull = await result.current.syncNow(['transaction-failed-pull']); });
    expect(failedPull).toEqual({ status: 'synced', confirmedTransactionIds: [] });

    mocks.sync.mockResolvedValueOnce(syncedResult(result.current.state, 'rejected', 'transaction-rejected'));
    let rejected!: FinanceSyncOutcome;
    await act(async () => { rejected = await result.current.syncNow(['transaction-rejected']); });
    expect(rejected).toEqual({ status: 'rejected', confirmedTransactionIds: [] });

    mocks.sync.mockResolvedValueOnce(undefined);
    let skipped!: FinanceSyncOutcome;
    await act(async () => { skipped = await result.current.syncNow(['transaction-skipped']); });
    expect(skipped).toEqual({ status: 'skipped', confirmedTransactionIds: [] });

    mocks.sync.mockResolvedValueOnce(syncedResult(result.current.state, 'synced'));
    let missing!: FinanceSyncOutcome;
    await act(async () => { missing = await result.current.syncNow(['transaction-not-pulled']); });
    expect(missing).toEqual({ status: 'synced', confirmedTransactionIds: [] });

    store.failNextWrite(new DOMException('synthetic commit failure', 'QuotaExceededError'));
    mocks.sync.mockResolvedValueOnce(syncedResult(result.current.state, 'synced', 'transaction-uncommitted'));
    let uncommitted!: FinanceSyncOutcome;
    await act(async () => { uncommitted = await result.current.syncNow(['transaction-uncommitted']); });
    expect(uncommitted).toEqual({ status: 'uncommitted', confirmedTransactionIds: [] });
  });
});
