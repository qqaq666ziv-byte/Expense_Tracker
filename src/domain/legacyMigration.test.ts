import { describe, expect, it } from 'vitest';
import {
  migrateLegacyData,
  stableLegacyId,
} from './legacyMigration';

const legacyFixture = {
  transactions: [
    {
      id: 'tx-breakfast', amount: 80, type: 'expense', category: '餐飲',
      date: '2026-08-20 08:15', account: '街口支付', note: '早餐', icon: 'UTENSILS',
    },
    {
      id: 'tx-allowance', amount: 2_000, type: 'income', category: '零用錢',
      date: '2026-08-20 18:00', account: '現金', icon: 'SPARKLES',
    },
  ],
  goals: [{
    id: 'goal-trip', name: '旅遊', targetAmount: 10_000, currentAmount: 1_500,
    unit: '元', targetDate: '2027-12-31',
  }],
  subscriptions: [{
    id: 'sub-video', name: '影音會員', amount: 390, category: '娛樂',
    account: '街口支付', recurringDate: 31,
  }],
  budgets: [{ id: 'budget-food', category: '餐飲', period: 'monthly', amount: 3_000 }],
  payment_methods: ['現金', '街口支付'],
  custom_categories: [
    { name: '餐飲', icon: '🍜', color: 'amber', type: 'expense' },
    { name: '零用錢', icon: '🎁', color: 'green', type: 'income' },
    { name: '娛樂', icon: '✨', color: 'purple', type: 'expense' },
  ],
};

const migrationOptions = {
  ownerId: 'guest' as const,
  migratedAt: '2026-08-21T10:00:00.000Z',
};

describe('legacy local-data migration', () => {
  it('preserves financial meaning and turns string relations into stable IDs', () => {
    const source = structuredClone(legacyFixture);
    const before = structuredClone(source);

    const migrated = migrateLegacyData(source, migrationOptions);

    expect(migrated.transactions.map((transaction) => ({
      amount: transaction.amount,
      occurredAt: transaction.occurredAt,
      categoryName: transaction.categoryName,
      accountName: transaction.accountName,
    }))).toEqual([
      { amount: 80, occurredAt: '2026-08-20 08:15', categoryName: '餐飲', accountName: '街口支付' },
      { amount: 2_000, occurredAt: '2026-08-20 18:00', categoryName: '零用錢', accountName: '現金' },
    ]);
    expect(migrated.transactions[0].accountId).toBe(stableLegacyId('account', 'guest', '街口支付'));
    expect(migrated.transactions[0].categoryId).toBe(stableLegacyId('category', 'guest', 'expense', '餐飲'));
    expect(migrated.allocations).toEqual([expect.objectContaining({
      goalId: migrated.goals[0].id,
      amountDelta: 1_500,
    })]);
    expect(migrated.settings.activeGoalId).toBe(migrated.goals[0].id);
    expect(source).toEqual(before);
  });

  it('uses reversible UTF-8 base64url parts for SQL-compatible deterministic IDs', () => {
    expect(stableLegacyId('account', 'guest', '現金')).toBe('account-Z3Vlc3Q.54--6YeR');
    expect(stableLegacyId('account', 'guest', '現金')).toBe(stableLegacyId('account', 'guest', '現金'));
  });

  it('migrates goals, monthly subscriptions, budgets, payment methods, and categories repeatably', () => {
    const first = migrateLegacyData(legacyFixture, migrationOptions);
    const retried = migrateLegacyData(legacyFixture, migrationOptions);

    expect(retried).toEqual(first);
    expect(first.accounts.map((account) => account.name)).toEqual(['現金', '街口支付']);
    expect(first.accounts.every((account) => account.includeInTotalAssets && !account.requiresReview)).toBe(true);
    expect(first.categories.map((category) => [category.kind, category.name])).toEqual([
      ['expense', '餐飲'],
      ['income', '零用錢'],
      ['expense', '娛樂'],
    ]);
    expect(first.goals[0]).toMatchObject({ legacyUnit: '元' });
    expect(first.recurringRules[0]).toMatchObject({
      amount: 390,
      categoryName: '娛樂',
      accountName: '街口支付',
      frequency: 'monthly',
      anchorDay: 31,
      startDate: '2026-08-31',
      nextOccurrenceDate: '2026-08-31',
    });
    expect(first.budgets[0]).toMatchObject({
      scope: 'category',
      categoryName: '餐飲',
      period: 'monthly',
      amount: 3_000,
    });
  });

  it('preserves an unclassified legacy payment method without silently treating debt as an asset', () => {
    const migrated = migrateLegacyData({
      transactions: [{ id: 'card-expense', amount: 500, type: 'expense', category: '購物', account: 'Card', date: '2026-08-20 12:00' }],
    }, migrationOptions);

    expect(migrated.accounts[0]).toMatchObject({
      name: 'Card',
      includeInTotalAssets: false,
      requiresReview: true,
    });
    expect(migrated.transactions[0].accountId).toBe(migrated.accounts[0].id);
  });

  it('isolates guest and authenticated scopes while keeping each migration internally related', () => {
    const guest = migrateLegacyData(legacyFixture, migrationOptions);
    const user = migrateLegacyData(legacyFixture, {
      ownerId: 'user-a',
      migratedAt: migrationOptions.migratedAt,
    });

    expect(new Set(user.accounts.map((record) => record.ownerId))).toEqual(new Set(['user-a']));
    expect(new Set(user.categories.map((record) => record.ownerId))).toEqual(new Set(['user-a']));
    expect(user.accounts[0].id).not.toBe(guest.accounts[0].id);
    expect(user.categories[0].id).not.toBe(guest.categories[0].id);
    expect(user.transactions[0].accountId).toBe(user.accounts.find((account) => account.name === '街口支付')?.id);
  });

  it('clamps a legacy 31st occurrence in a short month while retaining its anchor day', () => {
    const migrated = migrateLegacyData(legacyFixture, {
      ownerId: 'guest',
      migratedAt: '2026-09-21T10:00:00.000Z',
    });

    expect(migrated.recurringRules[0]).toMatchObject({
      anchorDay: 31,
      startDate: '2026-09-30',
      nextOccurrenceDate: '2026-09-30',
    });
  });

  it('uses the caller-local calendar date when migratedAt is a Date object', () => {
    const localMigrationTime = new Date(2026, 8, 1, 0, 30);
    const migrated = migrateLegacyData(legacyFixture, {
      ownerId: 'guest',
      migratedAt: localMigrationTime,
    });

    expect(migrated.recurringRules[0].nextOccurrenceDate).toBe('2026-09-30');
  });

  it('fails atomically on malformed legacy financial data and never mutates the source', () => {
    const malformed = structuredClone(legacyFixture);
    malformed.transactions[0].date = '2026-02-30 08:15';
    const before = structuredClone(malformed);

    expect(() => migrateLegacyData(malformed, migrationOptions)).toThrow(/cannot be migrated safely/i);
    expect(malformed).toEqual(before);
  });

  it('rejects null collections and combines snake/camel legacy aliases without data loss', () => {
    const nullCollection: Record<string, unknown> = structuredClone(legacyFixture);
    nullCollection.payment_methods = null;
    expect(() => migrateLegacyData(nullCollection, migrationOptions)).toThrow(/payment_methods/i);

    const aliases: Record<string, unknown> = structuredClone(legacyFixture);
    aliases.payment_methods = ['現金'];
    aliases.paymentMethods = ['銀行帳戶'];
    const migrated = migrateLegacyData(aliases, migrationOptions);
    expect(migrated.accounts.map((account) => account.name)).toContain('銀行帳戶');
  });

  it('keeps generated record IDs stable when unrelated legacy rows are reordered', () => {
    const original = structuredClone(legacyFixture);
    original.transactions.forEach((transaction) => delete (transaction as { id?: string }).id);
    const reordered = structuredClone(original);
    reordered.transactions.reverse();

    const first = migrateLegacyData(original, migrationOptions);
    const second = migrateLegacyData(reordered, migrationOptions);
    const idsByCategory = (data: typeof first) => Object.fromEntries(
      data.transactions.map((transaction) => [transaction.categoryName, transaction.id]),
    );

    expect(idsByCategory(second)).toEqual(idsByCategory(first));
  });

  it('re-identifies every member of a duplicate legacy-ID group without order dependence', () => {
    const original = structuredClone(legacyFixture);
    original.transactions[0].id = 'duplicate-id';
    original.transactions[1].id = 'duplicate-id';
    const reordered = structuredClone(original);
    reordered.transactions.reverse();

    const first = migrateLegacyData(original, migrationOptions);
    const second = migrateLegacyData(reordered, migrationOptions);
    const idsByCategory = (data: typeof first) => Object.fromEntries(
      data.transactions.map((transaction) => [transaction.categoryName, transaction.id]),
    );

    expect(idsByCategory(second)).toEqual(idsByCategory(first));
    expect(first.transactions.every((transaction) => transaction.id !== 'duplicate-id')).toBe(true);
  });

  it('isolates generated IDs from a unique explicit ID with the same text', () => {
    const original = structuredClone(legacyFixture);
    delete (original.transactions[0] as { id?: string }).id;
    original.transactions[1].id = stableLegacyId(
      'transaction',
      'guest',
      'expense',
      80,
      '餐飲',
      '街口支付',
      '2026-08-20 08:15',
      '早餐',
    );
    const reordered = structuredClone(original);
    reordered.transactions.reverse();

    const first = migrateLegacyData(original, migrationOptions);
    const second = migrateLegacyData(reordered, migrationOptions);
    const idsByCategory = (data: typeof first) => Object.fromEntries(
      data.transactions.map((transaction) => [transaction.categoryName, transaction.id]),
    );

    expect(idsByCategory(second)).toEqual(idsByCategory(first));
  });

  it('uses legacy allocation amount and unit when disambiguating otherwise-identical goals', () => {
    const goals = [
      { name: '共同目標', targetAmount: 10_000, currentAmount: 100, unit: '元', targetDate: '2027-12-31' },
      { name: '共同目標', targetAmount: 10_000, currentAmount: 200, unit: '點', targetDate: '2027-12-31' },
    ];
    const original: Record<string, unknown> = { ...structuredClone(legacyFixture), goals };
    const reordered: Record<string, unknown> = {
      ...structuredClone(legacyFixture),
      goals: [...goals].reverse(),
    };

    const first = migrateLegacyData(original, migrationOptions);
    const second = migrateLegacyData(reordered, migrationOptions);
    const goalIdsByAmount = (data: typeof first) => Object.fromEntries(
      data.allocations.map((allocation) => [allocation.amountDelta, allocation.goalId]),
    );

    expect(goalIdsByAmount(second)).toEqual(goalIdsByAmount(first));
  });
});
