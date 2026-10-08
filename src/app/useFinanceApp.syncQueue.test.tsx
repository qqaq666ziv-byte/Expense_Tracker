// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFinancePersistence, createInMemoryOwnerStateStore } from './localDurability';
import { useFinanceApp } from './useFinanceApp';
import { createInitialState } from './state';

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

describe('finance sync request coalescing', () => {
  beforeEach(() => { mocks.sync.mockReset(); mocks.remote.mockReset().mockReturnValue({}); });
  it('runs one trailing sync and keeps the import caller waiting for it', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.sync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const persistence = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const { result } = renderHook(() => useFinanceApp(persistence));
    await waitFor(() => expect(result.current.state.ownerId).toBe('owner-sync'));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    let requested!: Promise<void>;
    act(() => { requested = result.current.syncNow(); });
    let completed = false;
    void requested.then(() => { completed = true; });
    await act(async () => { first.resolve(undefined); await Promise.resolve(); });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    expect(completed).toBe(false);
    await act(async () => { second.resolve(undefined); await requested; });
    expect(completed).toBe(true);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });
});
