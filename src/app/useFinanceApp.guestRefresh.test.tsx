// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedFinanceState, Transaction } from '../domain/model';
import { createFinancePersistence, createInMemoryOwnerStateStore } from './localDurability';
import { syncFinanceStateUnlessRecovering } from './safeSync';
import { createInitialState, putRecord, saveFinanceState, storageKey, type LoadedFinanceState } from './state';
import { useFinanceApp } from './useFinanceApp';

type Session = { user: { id: string } } | null;
const auth = vi.hoisted(() => ({
  ownerId: 'user-a',
  listener: undefined as ((event: string, session: Session) => void) | undefined,
}));

vi.mock('../lib/supabaseClient', () => ({
  supabaseConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: auth.ownerId } } } }),
      onAuthStateChange: (listener: (event: string, session: Session) => void) => {
        auth.listener = listener;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  },
}));

vi.mock('./safeSync', async (importOriginal) => ({
  ...await importOriginal<typeof import('./safeSync')>(),
  syncFinanceStateUnlessRecovering: vi.fn(async () => undefined),
}));

function transaction(state: PersistedFinanceState, id: string): Transaction {
  const account = state.data.accounts[0];
  const category = state.data.categories.find((item) => item.kind === 'expense')!;
  return {
    id, ownerId: state.ownerId, amount: 40, type: 'expense',
    accountId: account.id, accountName: account.name,
    categoryId: category.id, categoryName: category.name,
    occurredAt: '2026-09-27 10:00', version: 1,
    updatedAt: '2026-09-27T02:00:00.000Z', lastOperationId: `create-${id}`,
  };
}

async function setup() {
  const guest = createInitialState('guest');
  saveFinanceState(guest);
  for (const ownerId of ['user-a', 'user-b']) {
    const owner = createInitialState(ownerId);
    owner.initialBootstrap = undefined;
    owner.outbox = [];
    saveFinanceState(owner);
  }
  const base = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
  const persistence = { ...base, load: vi.fn(base.load) };
  const view = renderHook(() => useFinanceApp(persistence));
  await waitFor(() => {
    expect(view.result.current.state.ownerId).toBe('user-a');
    expect(view.result.current.authLoading).toBe(false);
    expect(view.result.current.syncBusy).toBe(false);
  });
  await act(async () => { await view.result.current.syncNow(); });
  persistence.load.mockClear();
  return { ...view, base, persistence, guest };
}

beforeEach(() => {
  localStorage.clear();
  auth.ownerId = 'user-a';
  auth.listener = undefined;
  vi.mocked(syncFinanceStateUnlessRecovering).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('guest ledger prompt refresh', () => {
  it('does not read the guest ledger again for authenticated writes or sync completion', async () => {
    const { result, persistence } = await setup();
    const record = transaction(result.current.state, 'authenticated-write');

    await act(async () => { expect(await result.current.put('transactions', record)).toBe(true); });

    expect(persistence.load.mock.calls.filter(([ownerId]) => ownerId === 'guest')).toHaveLength(0);
    vi.mocked(syncFinanceStateUnlessRecovering).mockImplementation(async (state) => ({
      state: { ...state, outbox: [], lastSyncedAt: '2026-09-27T03:00:00.000Z' },
      report: { ownerId: state.ownerId, status: 'synced', applied: 1, pulled: 0, pending: [], failures: [], conflicts: [] },
    }));
    await act(async () => { await result.current.syncNow(); });

    expect(result.current.state.data.transactions).toContainEqual(record);
    expect(result.current.state.lastSyncedAt).toBe('2026-09-27T03:00:00.000Z');
    expect(persistence.load.mock.calls.filter(([ownerId]) => ownerId === 'guest')).toHaveLength(0);
  });

  it.each(['focus', 'visible', 'storage', 'legacy-storage', 'storage-clear'] as const)(
    'refreshes the prompt after a guest write when receiving %s', async (event) => {
      const { result, persistence, guest } = await setup();
      const record = transaction(guest, `guest-${event}`);
      await persistence.commit('guest', record.lastOperationId, (latest) => putRecord(latest, 'transactions', record));
      expect(result.current.hasSeparateGuestData).toBe(false);

      if (event === 'focus') fireEvent.focus(window);
      else if (event === 'visible') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        fireEvent(document, new Event('visibilitychange'));
      } else {
        fireEvent(window, new StorageEvent('storage', {
          key: event === 'storage-clear' ? null : event === 'legacy-storage' ? 'guest_transactions' : storageKey('guest'),
        }));
      }

      await waitFor(() => expect(result.current.hasSeparateGuestData).toBe(true));
      expect(persistence.load.mock.calls.filter(([ownerId]) => ownerId === 'guest')).toHaveLength(1);
      expect(result.current.state.ownerId).toBe('user-a');
      expect(result.current.state.data.transactions).toEqual([]);
    },
  );

  it('ignores unrelated storage changes and hidden visibility events', async () => {
    const { persistence } = await setup();
    fireEvent(window, new StorageEvent('storage', { key: storageKey('user-b') }));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {});

    expect(persistence.load).not.toHaveBeenCalled();
  });

  it('coalesces refreshes while a read is pending and rereads after the final invalidation', async () => {
    const { result, base, persistence, guest } = await setup();
    const oldSnapshot = await base.load('guest');
    let finish: ((loaded: LoadedFinanceState) => void) | undefined;
    persistence.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.focus(window);
    expect(persistence.load).toHaveBeenCalledOnce();
    const record = transaction(guest, 'changed-during-read');
    await base.commit('guest', record.lastOperationId, (latest) => putRecord(latest, 'transactions', record));
    fireEvent.focus(window);
    fireEvent(window, new StorageEvent('storage', { key: storageKey('guest') }));
    expect(persistence.load).toHaveBeenCalledOnce();

    await act(async () => { finish?.(oldSnapshot); });

    await waitFor(() => expect(result.current.hasSeparateGuestData).toBe(true));
    expect(persistence.load).toHaveBeenCalledTimes(2);
  });

  it('does not publish an old refresh result after an owner switch', async () => {
    const { result, base, persistence, guest } = await setup();
    const oldSnapshot = await base.load('guest');
    let finish: ((loaded: LoadedFinanceState) => void) | undefined;
    persistence.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.focus(window);
    const record = transaction(guest, 'before-owner-switch');
    await base.commit('guest', record.lastOperationId, (latest) => putRecord(latest, 'transactions', record));
    await act(async () => { auth.listener?.('SIGNED_IN', { user: { id: 'user-b' } }); });
    await waitFor(() => {
      expect(result.current.state.ownerId).toBe('user-b');
      expect(result.current.hasSeparateGuestData).toBe(true);
    });

    await act(async () => { finish?.(oldSnapshot); });

    expect(result.current.hasSeparateGuestData).toBe(true);
    expect(result.current.state.ownerId).toBe('user-b');
  });

  it('does not restart failed automatic sync when only attempt metadata changes', async () => {
    const { result } = await setup();
    vi.useFakeTimers();
    vi.mocked(syncFinanceStateUnlessRecovering).mockClear().mockImplementation(async (state) => ({
      state: {
        ...state,
        lastSyncError: 'offline',
        outbox: state.outbox.map((operation) => ({ ...operation, attempts: operation.attempts + 1, lastError: 'offline' })),
      },
      report: { ownerId: state.ownerId, status: 'partial', applied: 0, pulled: 0, pending: [], failures: [], conflicts: [] },
    }));
    await act(async () => {
      expect(await result.current.put('transactions', transaction(result.current.state, 'retry-once'))).toBe(true);
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(351); });
    expect(syncFinanceStateUnlessRecovering).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(syncFinanceStateUnlessRecovering).toHaveBeenCalledOnce();
    expect(result.current.state.lastSyncError).toBe('offline');
  });
});
