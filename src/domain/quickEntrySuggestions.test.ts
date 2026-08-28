import { describe, expect, it } from 'vitest';
import { TUTORIAL_RECORD_NOTE } from './tutorialRecord';
import type { FinanceData, Transaction, Transfer } from './model';
import {
  deriveCommonNoteSuggestions,
  deriveQuickReentryCandidates,
  normalizeLedgerNote,
} from './quickEntrySuggestions';

const account = {
  id: 'cash', ownerId: 'guest', version: 1, updatedAt: '2026-08-01T00:00:00.000Z',
  lastOperationId: 'cash-create', name: '現金', icon: { type: 'emoji' as const, value: '💵' },
  openingBalance: 0, includeInTotalAssets: true, isActive: true, sortOrder: 0,
};
const expenseCategory = {
  id: 'food', ownerId: 'guest', version: 1, updatedAt: '2026-08-01T00:00:00.000Z',
  lastOperationId: 'food-create', kind: 'expense' as const, name: '餐飲',
  icon: { type: 'emoji' as const, value: '🍖' }, isActive: true, sortOrder: 0,
};
const incomeCategory = {
  ...expenseCategory, id: 'salary', kind: 'income' as const, name: '薪資',
  lastOperationId: 'salary-create',
};

function transaction(id: string, note: string, occurredAt: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id, ownerId: 'guest', version: 1, updatedAt: `${occurredAt}Z`, lastOperationId: `${id}-create`,
    amount: 60, type: 'expense', categoryId: expenseCategory.id, categoryName: expenseCategory.name,
    accountId: account.id, accountName: account.name, occurredAt, note, ...overrides,
  };
}

function financeData(transactions: Transaction[]): FinanceData {
  return {
    accounts: [account], categories: [expenseCategory, incomeCategory], transactions, transfers: [],
    adjustments: [], goals: [], allocations: [], budgets: [], recurringRules: [],
    settings: { currency: 'TWD', locale: 'zh-TW' },
  };
}

function transfer(id: string, note: string, occurredAt: string, overrides: Partial<Transfer> = {}): Transfer {
  return {
    id, ownerId: 'guest', version: 1, updatedAt: `${occurredAt}Z`, lastOperationId: `${id}-create`,
    amount: 100, sourceAccountId: 'cash', sourceAccountName: '現金',
    destinationAccountId: 'bank', destinationAccountName: '銀行', occurredAt, note, ...overrides,
  };
}

describe('smart quick entry suggestions', () => {
  it('normalizes only surrounding and accidental repeated whitespace', () => {
    expect(normalizeLedgerNote('  滷肉飯\t  加蛋  ')).toBe('滷肉飯 加蛋');
    expect(normalizeLedgerNote('魯肉飯')).not.toBe(normalizeLedgerNote('滷肉飯'));
    expect(normalizeLedgerNote('  🍙  早餐  ')).toBe('🍙 早餐');
  });

  it('groups exact normalized notes, ranks frequency, and omits one-off noise', () => {
    const data = financeData([
      transaction('a1', ' 滷肉飯 ', '2026-08-25T12:00:00.000'),
      transaction('a2', '滷肉飯', '2026-08-26T12:00:00.000'),
      transaction('a3', '滷肉飯', '2026-08-27T12:00:00.000'),
      transaction('b1', '早餐', '2026-08-27T08:00:00.000'),
      transaction('b2', '早餐', '2026-08-28T08:00:00.000'),
      transaction('noise', '只出現一次', '2026-08-28T09:00:00.000'),
    ]);

    expect(deriveCommonNoteSuggestions(data, {
      mode: 'expense', ownerId: 'guest', now: new Date('2026-08-28T12:00:00.000Z'),
    })).toEqual(['滷肉飯', '早餐']);
  });

  it('lets recent repeated habits outrank one ancient saturated habit', () => {
    const old = Array.from({ length: 20 }, (_, index) => (
      transaction(`old-${index}`, '以前每天喝的飲料', `2024-01-${String((index % 20) + 1).padStart(2, '0')}T08:00:00.000`)
    ));
    const data = financeData([
      ...old,
      transaction('new-1', '最近早餐', '2026-08-27T08:00:00.000'),
      transaction('new-2', '最近早餐', '2026-08-28T08:00:00.000'),
    ]);

    expect(deriveCommonNoteSuggestions(data, {
      mode: 'expense', ownerId: 'guest', now: new Date('2026-08-28T12:00:00.000Z'),
    })[0]).toBe('最近早餐');
  });

  it('uses explicitly selected category and account only as deterministic ranking context', () => {
    const data = financeData([
      transaction('a1', '超商', '2026-08-27T08:00:00.000', { categoryId: 'shopping', accountId: 'card' }),
      transaction('a2', '超商', '2026-08-28T08:00:00.000', { categoryId: 'shopping', accountId: 'card' }),
      transaction('b1', '早餐', '2026-08-27T08:00:00.000'),
      transaction('b2', '早餐', '2026-08-28T08:00:00.000'),
    ]);

    expect(deriveCommonNoteSuggestions(data, {
      mode: 'expense', ownerId: 'guest', categoryId: 'food', accountId: 'cash',
      now: new Date('2026-08-28T12:00:00.000Z'),
    })[0]).toBe('早餐');
  });

  it('separates modes and excludes tutorial, tombstone, malformed, and wrong-owner records', () => {
    const data = financeData([
      transaction('expense-1', '🍙 早餐', '2026-08-27T08:00:00.000'),
      transaction('expense-2', '🍙 早餐', '2026-08-28T08:00:00.000'),
      transaction('income-1', '薪水', '2026-08-27T08:00:00.000', { type: 'income', categoryId: 'salary' }),
      transaction('income-2', '薪水', '2026-08-28T08:00:00.000', { type: 'income', categoryId: 'salary' }),
      transaction('tutorial-1', TUTORIAL_RECORD_NOTE, '2026-08-27T08:00:00.000'),
      transaction('tutorial-2', TUTORIAL_RECORD_NOTE, '2026-08-28T08:00:00.000'),
      transaction('deleted-1', '已刪除', '2026-08-27T08:00:00.000', { deletedAt: '2026-08-28T09:00:00.000Z' }),
      transaction('deleted-2', '已刪除', '2026-08-28T08:00:00.000', { deletedAt: '2026-08-28T09:00:00.000Z' }),
      transaction('wrong-owner-1', '別人的', '2026-08-27T08:00:00.000', { ownerId: 'user-b' }),
      transaction('wrong-owner-2', '別人的', '2026-08-28T08:00:00.000', { ownerId: 'user-b' }),
      transaction('malformed-1', '壞資料', 'invalid'),
      transaction('malformed-2', '壞資料', 'invalid'),
    ]);
    data.transfers = [
      transfer('transfer-1', '房租轉帳', '2026-08-27T08:00:00.000'),
      transfer('transfer-2', '房租轉帳', '2026-08-28T08:00:00.000'),
    ];

    expect(deriveCommonNoteSuggestions(data, { mode: 'expense', ownerId: 'guest' })).toEqual(['🍙 早餐']);
    expect(deriveCommonNoteSuggestions(data, { mode: 'income', ownerId: 'guest' })).toEqual(['薪水']);
    expect(deriveCommonNoteSuggestions(data, { mode: 'transfer', ownerId: 'guest' })).toEqual(['房租轉帳']);
  });

  it('filters by typed Unicode text and resolves exact ties by locale-aware note order', () => {
    const data = financeData([
      transaction('a1', '🍙 早餐', '2026-08-27T08:00:00.000'),
      transaction('a2', '🍙 早餐', '2026-08-28T08:00:00.000'),
      transaction('b1', '🍜 晚餐', '2026-08-27T08:00:00.000'),
      transaction('b2', '🍜 晚餐', '2026-08-28T08:00:00.000'),
    ]);

    const first = deriveCommonNoteSuggestions(data, { mode: 'expense', ownerId: 'guest' });
    const second = deriveCommonNoteSuggestions(data, { mode: 'expense', ownerId: 'guest' });
    expect(first).toEqual(second);
    expect(deriveCommonNoteSuggestions(data, {
      mode: 'expense', ownerId: 'guest', query: '早餐', excludeNormalizedNotes: ['不存在'],
    })).toEqual(['🍙 早餐']);
    expect(deriveCommonNoteSuggestions(data, {
      mode: 'expense', ownerId: 'guest', query: '🍙 早餐',
    })).toEqual([]);
  });

  it('derives a repeated full quick-reentry candidate with its explicit parents', () => {
    const data = financeData([
      transaction('meal-1', '滷肉飯', '2026-08-27T12:00:00.000'),
      transaction('meal-2', ' 滷肉飯 ', '2026-08-28T12:00:00.000'),
      transaction('different-price', '滷肉飯', '2026-08-28T13:00:00.000', { amount: 65 }),
    ]);

    expect(deriveQuickReentryCandidates(data, {
      mode: 'expense', ownerId: 'guest', now: new Date('2026-08-28T14:00:00.000Z'),
    })).toEqual([expect.objectContaining({
      sourceTransactionId: 'meal-2', note: '滷肉飯', amount: 60,
      categoryId: 'food', categoryName: '餐飲', accountId: 'cash', accountName: '現金',
    })]);
  });

  it.each([
    ['archived account', (data: FinanceData) => { data.accounts[0].isActive = false; }],
    ['deleted account', (data: FinanceData) => { data.accounts[0].deletedAt = '2026-08-28T14:00:00.000Z'; }],
    ['archived category', (data: FinanceData) => { data.categories[0].isActive = false; }],
    ['deleted category', (data: FinanceData) => { data.categories[0].deletedAt = '2026-08-28T14:00:00.000Z'; }],
  ])('fails closed for an unavailable quick-reentry parent: %s', (_label, mutate) => {
    const data = financeData([
      transaction('meal-1', '滷肉飯', '2026-08-27T12:00:00.000'),
      transaction('meal-2', '滷肉飯', '2026-08-28T12:00:00.000'),
    ]);
    data.accounts.push({ ...account, id: 'fallback', name: '不可靜默替換的其他帳戶', lastOperationId: 'fallback-create' });
    mutate(data);

    expect(deriveQuickReentryCandidates(data, { mode: 'expense', ownerId: 'guest' })).toEqual([]);
    expect(deriveCommonNoteSuggestions(data, { mode: 'expense', ownerId: 'guest' })).toEqual(['滷肉飯']);
  });

  it('fails closed for conflicted candidate records or parents without affecting note-only evidence', () => {
    const data = financeData([
      transaction('meal-1', '滷肉飯', '2026-08-27T12:00:00.000'),
      transaction('meal-2', '滷肉飯', '2026-08-28T12:00:00.000'),
    ]);

    for (const lockedRecordKeys of [
      new Set(['accounts:cash']),
      new Set(['categories:food']),
      new Set(['transactions:meal-2', 'transactions:meal-1']),
    ]) {
      expect(deriveQuickReentryCandidates(data, {
        mode: 'expense', ownerId: 'guest', lockedRecordKeys,
      })).toEqual([]);
    }
    expect(deriveCommonNoteSuggestions(data, { mode: 'expense', ownerId: 'guest' })).toEqual(['滷肉飯']);
  });
});
