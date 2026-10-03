// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceData, Transaction } from '../domain/model';
import { createFinancePersistence, createInMemoryOwnerStateStore } from './localDurability';
import {
  createInitialState,
  guestSnapshotFingerprint,
  planGuestImport,
  putRecord,
  remapOwner,
  saveFinanceState,
} from './state';
import { useFinanceApp } from './useFinanceApp';

vi.mock('../lib/supabaseClient', () => ({
  supabaseConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'user-a' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
}));

vi.mock('./safeSync', async (importOriginal) => ({
  ...await importOriginal<typeof import('./safeSync')>(),
  syncFinanceStateUnlessRecovering: vi.fn(async () => undefined),
}));

function guestTransaction(data: FinanceData, id: string): Transaction {
  const account = data.accounts[0];
  const category = data.categories.find((candidate) => candidate.kind === 'expense')!;
  return {
    id, ownerId: 'guest', amount: 75, type: 'expense',
    accountId: account.id, accountName: account.name,
    categoryId: category.id, categoryName: category.name,
    occurredAt: '2026-09-27 10:00', version: 1,
    updatedAt: '2026-09-27T02:00:00.000Z', lastOperationId: `create-${id}`,
  };
}

beforeEach(() => localStorage.clear());

describe('guest import snapshot identity', () => {
  it.each([false, true])('uses the freshly loaded guest snapshot when the rendered snapshot has an existing receipt: %s', async (hasPreviousReceipt) => {
    const guest = createInitialState('guest');
    guest.data.transactions = [guestTransaction(guest.data, 'first-guest-record')];
    const owner = createInitialState('user-a');
    owner.initialBootstrap = undefined;
    owner.outbox = [];
    saveFinanceState(guest);
    saveFinanceState(owner);
    const base = createFinancePersistence(createInMemoryOwnerStateStore(), localStorage);
    const persistence = { ...base, commit: vi.fn(base.commit) };
    const renderedFingerprint = guestSnapshotFingerprint(guest.data);
    if (hasPreviousReceipt) {
      expect(await persistence.commit('user-a', `guest-import:${renderedFingerprint}`, (current) => (
        planGuestImport(current, remapOwner(guest.data, 'user-a')).state
      ))).toMatchObject({ ok: true });
    }
    const { result } = renderHook(() => useFinanceApp(persistence));
    await waitFor(() => expect(result.current.hasSeparateGuestData).toBe(true));
    await waitFor(() => expect(result.current.syncBusy).toBe(false));
    const importFromRenderedPrompt = result.current.importGuestData;

    const laterTransaction = guestTransaction(guest.data, 'later-guest-record');
    expect(await persistence.commit('guest', laterTransaction.lastOperationId, (current) => (
      putRecord(current, 'transactions', laterTransaction)
    ))).toMatchObject({ ok: true });
    const freshGuest = (await persistence.load('guest')).state.data;
    const freshFingerprint = guestSnapshotFingerprint(freshGuest);
    expect(freshFingerprint).not.toBe(renderedFingerprint);

    await act(async () => { await importFromRenderedPrompt(); });

    const imported = (await persistence.load('user-a')).state.data;
    expect(imported.transactions.map(({ id }) => id).sort()).toEqual(
      remapOwner(freshGuest, 'user-a').transactions.map(({ id }) => id).sort(),
    );
    expect(persistence.commit).toHaveBeenCalledWith(
      'user-a', `guest-import:${freshFingerprint}`, expect.any(Function),
    );
    expect(localStorage.getItem('shiba-finance:v3:guest-decision:user-a')).toBe(freshFingerprint);
    expect(result.current.guestImportNotice).toMatch(/訪客資料匯入完成/);
  });
});
