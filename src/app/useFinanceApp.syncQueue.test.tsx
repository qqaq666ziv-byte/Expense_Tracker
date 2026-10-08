// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFinancePersistence, createInMemoryOwnerStateStore } from './localDurability';
import { useFinanceApp } from './useFinanceApp';
import { createInitialState } from './state';
import type { Transaction } from '../domain/model';
import type { SyncReport, SyncResult } from '../domain/syncEngine';
import type { FinanceSyncOutcome } from './useFinanceApp';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), remote: vi.fn() }));
vi.mock('../lib/supabaseClient', () => ({
  supabaseConfigured: true,
  supabase: { auth: {
    getSession: async () => ({ data: { session: { user: { id: 'owner-sync' }, access_token: 'synthetic' } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
  } },
}));
vi.mock('../data/supabaseRemote', () => ({ createSupabaseRemoteAdapter: mocks.remote }));
vi.mock('./safeSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./safeSync')>()),
  syncFinanceStateUnlessRecovering: mocks.sync,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
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

describe('finance sync request coalescing', () => {
  beforeEach(() => { mocks.sync.mockReset(); mocks.remote.mockReset().mockReturnValue({}); });
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
