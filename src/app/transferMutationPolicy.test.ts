import { describe, expect, it, vi } from 'vitest';
import type { AssetAccount, PendingOperation, Transfer } from '../domain/model';
import type { RemoteAdapter } from '../domain/syncEngine';
import { calculateFinancials } from '../domain/financeEngine';
import { createInitialState, loadFinanceStateWithRecovery, saveFinanceState } from './state';
import {
  assertTransferCollectionMutationAllowed,
  assertTransferMutationAllowed,
  createTransferReadOnlyRemoteAdapter,
  transferMutationsEnabled,
} from './transferMutationPolicy';

const account: AssetAccount = {
  id: 'cash', ownerId: 'user-a', version: 1,
  updatedAt: '2026-08-28T01:00:00.000Z', lastOperationId: 'cash-op',
  name: '現金', icon: { type: 'emoji', value: '💵' }, openingBalance: 0,
  includeInTotalAssets: true, isActive: true, sortOrder: 0,
};
const transfer: Transfer = {
  id: 'transfer-1', ownerId: 'user-a', version: 1,
  updatedAt: '2026-08-28T01:00:00.000Z', lastOperationId: 'transfer-op',
  amount: 100, sourceAccountId: 'bank', sourceAccountName: '銀行',
  destinationAccountId: 'cash', destinationAccountName: '現金',
  occurredAt: '2026-08-20 08:00',
};
const pending = (entity: 'accounts' | 'transfers'): PendingOperation => {
  const record = entity === 'accounts' ? account : transfer;
  return {
    id: record.lastOperationId,
    entity,
    recordId: record.id,
    record,
    attempts: 0,
    queuedAt: record.updatedAt,
  };
};

describe('transfer-aware emergency mode', () => {
  it('is reproducibly enabled by the dedicated build mode or explicit false flag', () => {
    expect(transferMutationsEnabled('transfer-read-only', undefined)).toBe(false);
    expect(transferMutationsEnabled('production', 'false')).toBe(false);
    expect(transferMutationsEnabled('production', undefined)).toBe(true);
  });

  it('continues remote reads and non-transfer writes while rejecting every transfer write seam', async () => {
    const apply = vi.fn(async () => undefined);
    const remote: RemoteAdapter = {
      pull: async () => [{ entity: 'transfers', record: transfer }],
      apply,
      applyHistoricalImportBatch: vi.fn(async () => undefined),
      compareAndSwap: vi.fn(async (_ownerId, _expected, replacement) => ({
        entity: replacement.entity,
        record: replacement.record,
      })),
    };
    const readOnly = createTransferReadOnlyRemoteAdapter(remote);

    await expect(readOnly.pull('user-a')).resolves.toEqual([{ entity: 'transfers', record: transfer }]);
    await expect(readOnly.apply('user-a', pending('accounts'))).resolves.toBeUndefined();
    await expect(readOnly.apply('user-a', pending('transfers'))).rejects.toThrow(/read-only/i);
    await expect(readOnly.applyHistoricalImportBatch?.('user-a', {
      id: 'historical-import:blocked',
      operations: [{ ...pending('transfers'), historicalImportBatchId: 'historical-import:blocked' }],
      endpointAccounts: [account],
    })).rejects.toThrow(/read-only/i);
    await expect(readOnly.compareAndSwap?.(
      'user-a',
      { entity: 'transfers', record: transfer },
      pending('transfers'),
    )).rejects.toThrow(/read-only/i);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('fails closed at the local mutation guard for transfer create, edit, and delete', () => {
    expect(() => assertTransferMutationAllowed('transfers', false)).toThrow(/read-only/i);
    expect(() => assertTransferMutationAllowed('accounts', false)).not.toThrow();
    expect(() => assertTransferMutationAllowed('transfers', true)).not.toThrow();
    expect(() => assertTransferCollectionMutationAllowed([], [transfer], false)).toThrow(/read-only/i);
    expect(() => assertTransferCollectionMutationAllowed([transfer], [transfer], false)).not.toThrow();
  });

  it('loads schema v4 and still includes transfers in balances and total assets', () => {
    const state = createInitialState('guest');
    const bank = {
      ...state.data.accounts[0],
      id: 'bank',
      name: '銀行',
      openingBalance: 1_000,
      lastOperationId: 'bank-op',
    };
    state.data.accounts = [bank, { ...account, ownerId: 'guest' }];
    state.data.transfers = [{ ...transfer, ownerId: 'guest' }];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    saveFinanceState(state, storage);

    const loaded = loadFinanceStateWithRecovery('guest', storage);
    const totals = calculateFinancials(loaded.state.data);

    expect(loaded.recovery).toBeUndefined();
    expect(loaded.state.schemaVersion).toBe(4);
    expect(loaded.state.data.transfers).toEqual([{ ...transfer, ownerId: 'guest' }]);
    expect(totals.accountBalances.find((item) => item.accountId === 'bank')?.balance).toBe(900);
    expect(totals.accountBalances.find((item) => item.accountId === 'cash')?.balance).toBe(100);
    expect(totals.totalAssets).toBe(1_000);
  });
});
