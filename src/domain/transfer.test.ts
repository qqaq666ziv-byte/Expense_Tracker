import { describe, expect, it } from 'vitest';
import type { FinanceData, SyncRecord } from './model';
import { buildTransferRecord } from './transfer';

const meta: SyncRecord = {
  id: 'transfer-1', ownerId: 'user-a', version: 1,
  updatedAt: '2026-08-28T02:00:00.000Z', lastOperationId: 'operation-transfer-1',
};

const data: FinanceData = {
  accounts: [
    {
      id: 'bank', ownerId: 'user-a', name: '銀行', icon: { type: 'vector', value: 'landmark' },
      openingBalance: 1_000, includeInTotalAssets: true, isActive: true, sortOrder: 0,
      version: 1, updatedAt: meta.updatedAt, lastOperationId: 'bank-clock',
    },
    {
      id: 'cash', ownerId: 'user-a', name: '現金', icon: { type: 'emoji', value: '💵' },
      openingBalance: 0, includeInTotalAssets: true, isActive: true, sortOrder: 1,
      version: 1, updatedAt: meta.updatedAt, lastOperationId: 'cash-clock',
    },
  ],
  categories: [], transactions: [], transfers: [], adjustments: [], goals: [],
  allocations: [], budgets: [], recurringRules: [],
  settings: { currency: 'TWD', locale: 'zh-TW' },
};

describe('first-class transfer record', () => {
  it('captures both account display snapshots in one owner-scoped record', () => {
    expect(buildTransferRecord(data, {
      amount: 100,
      sourceAccountId: 'bank',
      destinationAccountId: 'cash',
      occurredAt: '2026-08-28 10:00',
      note: '領現',
    }, meta)).toEqual({
      ...meta,
      amount: 100,
      sourceAccountId: 'bank',
      sourceAccountName: '銀行',
      destinationAccountId: 'cash',
      destinationAccountName: '現金',
      occurredAt: '2026-08-28 10:00',
      note: '領現',
    });
  });

  it.each([
    ['zero amount', { amount: 0 }, /大於零/],
    ['unsafe precision', { amount: 0.0000001 }, /小數位/],
    ['unsafe magnitude', { amount: 100_000_001 }, /安全金額/],
    ['same account', { destinationAccountId: 'bank' }, /不同/],
    ['foreign source', { sourceAccountId: 'foreign' }, /來源帳戶/],
  ])('rejects %s without constructing a partial record', (_case, override, error) => {
    expect(() => buildTransferRecord(data, {
      amount: 100,
      sourceAccountId: 'bank',
      destinationAccountId: 'cash',
      occurredAt: '2026-08-28 10:00',
      ...override,
    }, meta)).toThrow(error);
  });

  it('allows an unchanged archived historical endpoint but rejects retargeting to it', () => {
    const archived = {
      ...data,
      accounts: data.accounts.map((account) => account.id === 'bank'
        ? { ...account, isActive: false }
        : account),
    };
    const historical = {
      ...meta,
      amount: 100,
      sourceAccountId: 'bank', sourceAccountName: '銀行',
      destinationAccountId: 'cash', destinationAccountName: '現金',
      occurredAt: '2026-08-28 10:00',
    };

    expect(buildTransferRecord(archived, {
      amount: 120,
      sourceAccountId: 'bank',
      destinationAccountId: 'cash',
      occurredAt: '2026-08-28 10:00',
    }, { ...meta, version: 2, lastOperationId: 'edit' }, historical))
      .toMatchObject({ amount: 120, sourceAccountName: '銀行' });

    expect(() => buildTransferRecord(archived, {
      amount: 120,
      sourceAccountId: 'cash',
      destinationAccountId: 'bank',
      occurredAt: '2026-08-28 10:00',
    }, { ...meta, version: 2, lastOperationId: 'edit' }, historical))
      .toThrow(/目的帳戶.*不可用/);
  });
});
