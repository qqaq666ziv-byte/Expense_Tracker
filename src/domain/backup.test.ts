import { describe, expect, it, vi } from 'vitest';
import type { FinanceData, PersistedFinanceState } from './model';
import { applyRestoredData } from '../app/state';
import { syncFinanceState, type RemoteAdapter } from './syncEngine';
import {
  createFinanceBackup,
  exportFinanceBackup,
  exportTransactionsCsv,
  MAX_BACKUP_BYTES,
  parseFinanceBackup,
  restoreFinanceBackup,
} from './backup';

const fixture: FinanceData = {
  accounts: [{
    id: 'account-cash', ownerId: 'guest', name: '現金', icon: { type: 'emoji', value: '💵' },
    openingBalance: 1_000, includeInTotalAssets: true, isActive: true, sortOrder: 0,
    version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
  }],
  categories: [{
    id: 'category-food', ownerId: 'guest', kind: 'expense', name: '餐飲',
    icon: { type: 'emoji', value: '🍜' }, isActive: true, sortOrder: 0,
    version: 1, updatedAt: '2026-08-21T08:00:00.000Z', lastOperationId: 'fixture',
  }],
  transactions: [{
    id: 'tx-breakfast', ownerId: 'guest', amount: 80, type: 'expense',
    categoryId: 'category-food', categoryName: '餐飲', accountId: 'account-cash',
    accountName: '現金', occurredAt: '2026-08-21 08:30', note: '早餐',
    version: 1, updatedAt: '2026-08-21T08:31:00.000Z', lastOperationId: 'fixture',
  }],
  adjustments: [{
    id: 'adjustment-1', ownerId: 'guest', accountId: 'account-cash', amountDelta: 20,
    occurredAt: '2026-08-21 09:00', reason: '對帳', version: 1,
    updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
  }],
  goals: [{
    id: 'goal-home', ownerId: 'guest', name: '新家基金', targetAmount: 50_000,
    targetDate: '2028-02-29', isActive: true, legacyUnit: '元', version: 1,
    updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
  }],
  allocations: [{
    id: 'allocation-1', ownerId: 'guest', goalId: 'goal-home', amountDelta: 500,
    occurredAt: '2026-08-21 09:05', version: 1,
    updatedAt: '2026-08-21T09:05:00.000Z', lastOperationId: 'fixture',
  }],
  budgets: [{
    id: 'budget-food', ownerId: 'guest', scope: 'category', categoryId: 'category-food',
    categoryName: '餐飲', period: 'monthly', amount: 5_000, isActive: true,
    version: 1, updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
  }],
  recurringRules: [{
    id: 'recurring-lunch', ownerId: 'guest', name: '午餐', type: 'expense', amount: 100,
    categoryId: 'category-food', categoryName: '餐飲', accountId: 'account-cash',
    accountName: '現金', frequency: 'monthly', startDate: '2026-08-21',
    anchorDay: 21, nextOccurrenceDate: '2026-09-21', isActive: true, version: 1,
    updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'fixture',
  }],
  settings: { currency: 'TWD', locale: 'zh-TW', activeGoalId: 'goal-home' },
};

const emptyData = (): FinanceData => ({
  accounts: [], categories: [], transactions: [], adjustments: [], goals: [], allocations: [],
  budgets: [], recurringRules: [], settings: { currency: 'TWD', locale: 'zh-TW' },
});

describe('versioned finance backup', () => {
  it('round-trips every FinanceData collection without changing logical data', () => {
    const backup = createFinanceBackup(fixture, '2026-08-21T10:00:00.000Z');
    const restored = restoreFinanceBackup(emptyData(), backup, { ownerId: 'guest' });

    expect(backup).toMatchObject({
      schemaVersion: 1,
      exportedAt: '2026-08-21T10:00:00.000Z',
    });
    expect(restored).toEqual(fixture);
  });

  it('serializes a portable JSON document that can be parsed and validated', () => {
    const json = exportFinanceBackup(fixture, '2026-08-21T10:00:00.000Z');

    expect(parseFinanceBackup(json)).toEqual(createFinanceBackup(
      fixture,
      '2026-08-21T10:00:00.000Z',
    ));
  });

  it('rejects an export whose UTF-8 bytes exceed the limit even when its character count does not', () => {
    const multibyteData = structuredClone(fixture);
    multibyteData.transactions = Array.from({ length: 150 }, (_, index) => ({
      ...fixture.transactions[0],
      id: `multibyte-transaction-${index}`,
      note: '中🙂'.repeat(5_000),
      lastOperationId: `multibyte-operation-${index}`,
    }));
    const serialized = JSON.stringify(
      createFinanceBackup(multibyteData, '2026-08-21T10:00:00.000Z'),
      null,
      2,
    );

    expect(serialized.length).toBeLessThan(MAX_BACKUP_BYTES);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(MAX_BACKUP_BYTES);
    expect(() => exportFinanceBackup(multibyteData, '2026-08-21T10:00:00.000Z'))
      .toThrow(/byte safety limit/i);
  });

  it('rejects an imported JSON string by UTF-8 bytes before parsing its structure', () => {
    const serialized = JSON.stringify({
      note: '中'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3)),
    });

    expect(serialized.length).toBeLessThan(MAX_BACKUP_BYTES);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(MAX_BACKUP_BYTES);
    expect(() => parseFinanceBackup(serialized)).toThrow(/byte safety limit/i);
  });

  it('short-circuits an oversized character count before allocating a UTF-8 buffer', () => {
    const encode = vi.fn(() => {
      throw new Error('TextEncoder must not run for an already oversized string');
    });
    vi.stubGlobal('TextEncoder', class {
      encode = encode;
    });

    try {
      expect(() => parseFinanceBackup(' '.repeat(MAX_BACKUP_BYTES + 1)))
        .toThrow(/byte safety limit/i);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects malformed structure and unsupported versions without mutating current data', () => {
    const current = structuredClone(fixture);
    const before = structuredClone(current);

    expect(() => restoreFinanceBackup(current, '{not json')).toThrow(/JSON/i);
    expect(() => restoreFinanceBackup(current, {
      schemaVersion: 999,
      exportedAt: '2026-08-21T10:00:00.000Z',
      data: emptyData(),
    })).toThrow(/schemaVersion/i);
    expect(() => restoreFinanceBackup(current, {
      schemaVersion: 1,
      exportedAt: '2026-08-21T10:00:00.000Z',
      data: { accounts: [] },
    })).toThrow(/categories/i);
    expect(current).toEqual(before);
  });

  it('rejects oversized input and unsafe numeric values before mutation', () => {
    expect(() => parseFinanceBackup(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow(/safety limit/i);
    const oversizedExport = structuredClone(fixture);
    oversizedExport.transactions = Array.from(
      { length: Math.ceil(MAX_BACKUP_BYTES / 20_000) + 1 },
      (_, index) => ({
        ...fixture.transactions[0],
        id: `oversized-transaction-${index}`,
        note: 'x'.repeat(20_000),
        lastOperationId: `oversized-operation-${index}`,
      }),
    );
    expect(() => exportFinanceBackup(oversizedExport)).toThrow(/was not exported/i);
    const unsafe = structuredClone(fixture);
    unsafe.transactions[0].amount = Number.MAX_SAFE_INTEGER + 1;
    expect(() => createFinanceBackup(unsafe)).toThrow(/safe numeric range/i);
  });

  it('rejects non-finite or invalid amounts and impossible calendar dates', () => {
    const invalidAmount = structuredClone(fixture);
    invalidAmount.transactions[0].amount = Number.NaN;
    expect(() => createFinanceBackup(invalidAmount)).toThrow(/amount/i);

    const negativeBudget = structuredClone(fixture);
    negativeBudget.budgets[0].amount = -1;
    expect(() => createFinanceBackup(negativeBudget)).toThrow(/amount/i);

    const invalidDate = createFinanceBackup(fixture);
    invalidDate.data.transactions[0].occurredAt = '2026-02-30 08:00';
    expect(() => parseFinanceBackup(invalidDate)).toThrow(/occurredAt/i);

    const dateOnlyExport = createFinanceBackup(fixture);
    dateOnlyExport.exportedAt = '2026-08-21';
    expect(() => parseFinanceBackup(dateOnlyExport)).toThrow(/exportedAt.*date-time/i);

    const timezoneFreeSyncTime = createFinanceBackup(fixture);
    timezoneFreeSyncTime.data.transactions[0].updatedAt = '2026-08-21T10:00:00';
    expect(() => parseFinanceBackup(timezoneFreeSyncTime)).toThrow(/updatedAt.*timezone/i);

    const invalidAnchor = createFinanceBackup(fixture);
    invalidAnchor.data.recurringRules[0].anchorDay = 32;
    expect(() => parseFinanceBackup(invalidAnchor)).toThrow(/anchorDay/i);

    const dateTimeRuleStart = createFinanceBackup(fixture);
    dateTimeRuleStart.data.recurringRules[0].startDate = '2026-08-21T00:00:00Z';
    expect(() => parseFinanceBackup(dateTimeRuleStart)).toThrow(/startDate.*date-only/i);

    const dateTimeNextOccurrence = createFinanceBackup(fixture);
    dateTimeNextOccurrence.data.recurringRules[0].nextOccurrenceDate = '2026-09-21T00:00:00Z';
    expect(() => parseFinanceBackup(dateTimeNextOccurrence)).toThrow(/nextOccurrenceDate.*date-only/i);

    const dateTimeOccurrence = createFinanceBackup(fixture);
    dateTimeOccurrence.data.transactions[0].recurringRuleId = 'recurring-lunch';
    dateTimeOccurrence.data.transactions[0].occurrenceDate = '2026-08-21T00:00:00Z';
    expect(() => parseFinanceBackup(dateTimeOccurrence)).toThrow(/occurrenceDate.*date-only/i);

    const dateTimeGoalTarget = createFinanceBackup(fixture);
    dateTimeGoalTarget.data.goals[0].targetDate = '2028-02-29T00:00:00Z';
    expect(() => parseFinanceBackup(dateTimeGoalTarget)).toThrow(/targetDate.*date-only/i);
  });

  it.each(['adjustments', 'allocations'] as const)(
    'rejects a zero %s delta before a restored backup can enqueue remote writes',
    async (entity) => {
      const incoming = structuredClone(fixture);
      for (const records of [
        incoming.accounts,
        incoming.categories,
        incoming.transactions,
        incoming.adjustments,
        incoming.goals,
        incoming.allocations,
        incoming.budgets,
        incoming.recurringRules,
      ]) {
        records.forEach((record) => { record.ownerId = 'user-a'; });
      }
      incoming[entity][0].amountDelta = 0;
      const backup = {
        schemaVersion: 1,
        exportedAt: '2026-08-21T10:00:00.000Z',
        data: incoming,
      };
      const current: PersistedFinanceState = {
        schemaVersion: 3,
        ownerId: 'user-a',
        data: emptyData(),
        outbox: [],
      };
      let applyCount = 0;
      const remote: RemoteAdapter = {
        apply: async () => { applyCount += 1; },
        pull: async () => [],
      };

      const restoreThenSync = async () => {
        const restored = restoreFinanceBackup(current.data, backup, { ownerId: 'user-a' });
        const queued = applyRestoredData(
          current,
          restored,
          new Date('2026-08-21T10:00:00.000Z'),
          () => 'restore-operation',
        );
        await syncFinanceState(queued, 'user-a', remote);
      };

      await expect(restoreThenSync()).rejects.toThrow(new RegExp(`${entity}.*amountDelta`, 'i'));
      expect(applyCount).toBe(0);
    },
  );

  it('rejects duplicate identifiers and broken or semantically wrong references', () => {
    const missingAccount = createFinanceBackup(fixture);
    missingAccount.data.transactions[0].accountId = 'account-missing';
    expect(() => parseFinanceBackup(missingAccount)).toThrow(/missing account/i);

    const duplicateCategory = createFinanceBackup(fixture);
    duplicateCategory.data.categories.push(structuredClone(duplicateCategory.data.categories[0]));
    expect(() => parseFinanceBackup(duplicateCategory)).toThrow(/duplicates/i);

    const wrongCategoryKind = createFinanceBackup(fixture);
    wrongCategoryKind.data.categories[0].kind = 'income';
    expect(() => parseFinanceBackup(wrongCategoryKind)).toThrow(/wrong category kind/i);

    const ambiguousOverallBudget = createFinanceBackup(fixture);
    ambiguousOverallBudget.data.budgets[0].scope = 'overall';
    expect(() => parseFinanceBackup(ambiguousOverallBudget)).toThrow(/overall.*category/i);
  });

  it('merges the same backup repeatedly without duplicating records', () => {
    const backup = createFinanceBackup(fixture, '2026-08-21T10:00:00.000Z');
    const firstRestore = restoreFinanceBackup(emptyData(), backup, { ownerId: 'guest' });
    const secondRestore = restoreFinanceBackup(firstRestore, backup, { ownerId: 'guest' });

    expect(secondRestore).toEqual(firstRestore);
    expect(secondRestore.transactions).toHaveLength(1);
    expect(secondRestore.accounts).toHaveLength(1);
  });

  it('compares equal-version update timestamps by instant rather than timestamp spelling', () => {
    const current = structuredClone(fixture);
    current.transactions[0].updatedAt = '2026-08-21T10:00:00+08:00';
    current.transactions[0].note = '舊資料';
    const incoming = structuredClone(fixture);
    incoming.transactions[0].updatedAt = '2026-08-21T03:00:00Z';
    incoming.transactions[0].note = '新資料';

    const restored = restoreFinanceBackup(current, createFinanceBackup(incoming), { ownerId: 'guest' });

    expect(restored.transactions[0].note).toBe('新資料');
  });

  it('preserves sub-millisecond ordering and resolves exact timestamp ties deterministically', () => {
    const older = structuredClone(fixture);
    older.transactions[0].updatedAt = '2026-08-21T03:00:00.000000001Z';
    older.transactions[0].lastOperationId = 'operation-a';
    older.transactions[0].note = '舊資料';
    const newer = structuredClone(fixture);
    newer.transactions[0].updatedAt = '2026-08-21T03:00:00.000000002Z';
    newer.transactions[0].lastOperationId = 'operation-a';
    newer.transactions[0].note = '新資料';

    expect(restoreFinanceBackup(older, createFinanceBackup(newer), { ownerId: 'guest' })
      .transactions[0].note).toBe('新資料');

    older.transactions[0].updatedAt = '2026-08-21T03:00:00.000000002Z';
    newer.transactions[0].lastOperationId = 'operation-z';
    const forward = restoreFinanceBackup(older, createFinanceBackup(newer), { ownerId: 'guest' });
    const reverse = restoreFinanceBackup(newer, createFinanceBackup(older), { ownerId: 'guest' });
    expect(forward.transactions[0].lastOperationId).toBe('operation-z');
    expect(reverse.transactions[0].lastOperationId).toBe('operation-z');
  });

  it('rejects divergent records that claim the exact same version and operation identity', () => {
    const divergent = structuredClone(fixture);
    divergent.transactions[0].amount = 81;

    expect(() => restoreFinanceBackup(fixture, createFinanceBackup(divergent), { ownerId: 'guest' }))
      .toThrow(/conflicting.*tx-breakfast/i);
  });

  it('keeps the current active goal during a non-destructive merge', () => {
    const incoming = structuredClone(fixture);
    incoming.goals.push({
      ...incoming.goals[0],
      id: 'goal-trip',
      name: '旅遊基金',
      lastOperationId: 'fixture-trip',
    });
    incoming.settings.activeGoalId = 'goal-trip';

    const restored = restoreFinanceBackup(fixture, createFinanceBackup(incoming), { ownerId: 'guest' });

    expect(restored.settings.activeGoalId).toBe('goal-home');
  });

  it('keeps guest and authenticated-owner restores isolated', () => {
    const guestBackup = createFinanceBackup(fixture);

    expect(() => restoreFinanceBackup(emptyData(), guestBackup, { ownerId: 'user-a' }))
      .toThrow(/ownerId/i);
  });

  it('requires an explicit confirmation for destructive replacement mode', () => {
    const backup = createFinanceBackup(emptyData());

    expect(() => restoreFinanceBackup(fixture, backup, { mode: 'replace' }))
      .toThrow(/confirmReplace/i);
    expect(restoreFinanceBackup(fixture, backup, {
      mode: 'replace',
      confirmReplace: true,
      ownerId: 'guest',
    })).toEqual(emptyData());
  });
});

describe('transaction CSV export', () => {
  it('includes stable identifiers and display fields with RFC 4180 escaping', () => {
    const data = structuredClone(fixture);
    data.transactions[0].note = '="早餐, 大份"\n第二行';

    const csv = exportTransactionsCsv(data);

    expect(csv.startsWith(
      'id,owner_id,type,amount,occurred_at,category_id,category_name,account_id,account_name,note,recurring_rule_id,occurrence_date,deleted_at\r\n',
    )).toBe(true);
    expect(csv).toContain('"tx-breakfast","guest","expense","80"');
    expect(csv).toContain('"category-food","餐飲","account-cash","現金"');
    expect(csv).toContain('"\'=\"\"早餐, 大份\"\"\r\n第二行"');
  });

  it('neutralizes spreadsheet formulas even when they follow leading whitespace', () => {
    const data = structuredClone(fixture);
    data.transactions[0].note = ' \n=HYPERLINK("https://invalid.example")';

    const csv = exportTransactionsCsv(data);

    expect(csv).toContain('"\' \r\n=HYPERLINK(""https://invalid.example"")"');
  });
});
