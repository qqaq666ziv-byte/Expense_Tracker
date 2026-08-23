import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssetAccount, PendingOperation } from '../domain/model';
import type { RemotePullResult } from '../domain/syncEngine';
import { createSupabaseRemoteAdapter } from './supabaseRemote';

const NOW = '2026-08-21T10:00:00.000Z';

function account(overrides: Partial<AssetAccount> = {}): AssetAccount {
  return {
    id: 'cash',
    ownerId: 'user-a',
    version: 2,
    updatedAt: NOW,
    lastOperationId: 'op-save-cash',
    name: 'Cash',
    icon: { type: 'emoji', value: '💵' },
    openingBalance: 500,
    includeInTotalAssets: true,
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

function operation(record: AssetAccount): PendingOperation {
  return {
    id: record.lastOperationId,
    entity: 'accounts',
    recordId: record.id,
    record,
    attempts: 0,
    queuedAt: NOW,
  };
}

function accountRow(record: AssetAccount): Record<string, unknown> {
  return {
    id: record.id,
    user_id: record.ownerId,
    version: record.version,
    updated_at: record.updatedAt,
    last_operation_id: record.lastOperationId,
    deleted_at: record.deletedAt ?? null,
    name: record.name,
    icon_type: record.icon.type,
    icon_value: record.icon.value,
    opening_balance: record.openingBalance,
    include_in_total_assets: record.includeInTotalAssets,
    is_active: record.isActive,
    sort_order: record.sortOrder,
    legacy_key: record.legacyKey ?? null,
    requires_review: record.requiresReview ?? false,
  };
}

function categoryRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...commonRow(id),
    kind: 'expense',
    name: '餐飲',
    icon_type: 'emoji',
    icon_value: '🍜',
    is_active: true,
    sort_order: 0,
    legacy_key: null,
    ...overrides,
  };
}

function transactionRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    user_id: 'user-a',
    version: 1,
    updated_at: NOW,
    last_operation_id: `op-${id}`,
    deleted_at: null,
    amount: 20,
    type: 'expense',
    category_id: 'food',
    category_name: '餐飲',
    account_id: 'cash',
    account_name: 'Cash',
    occurred_at: '2026-08-21T09:00',
    note: null,
    recurring_rule_id: null,
    occurrence_date: null,
    ...overrides,
  };
}

function recurringRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    user_id: 'user-a',
    version: 1,
    updated_at: NOW,
    last_operation_id: `op-${id}`,
    deleted_at: null,
    name: 'Monthly lunch',
    type: 'expense',
    amount: 100,
    category_id: 'food',
    category_name: '餐飲',
    account_id: 'cash',
    account_name: 'Cash',
    frequency: 'monthly',
    start_date: '2026-08-21',
    anchor_day: 21,
    next_occurrence_date: '2026-09-21',
    is_active: true,
    note: null,
    ...overrides,
  };
}

function commonRow(id: string): Record<string, unknown> {
  return {
    id,
    user_id: 'user-a',
    version: 1,
    updated_at: NOW,
    last_operation_id: `op-${id}`,
    deleted_at: null,
  };
}

function adjustmentRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...commonRow(id),
    account_id: 'cash',
    amount_delta: -25,
    occurred_at: '2026-08-21T09:00',
    reason: null,
    ...overrides,
  };
}

function goalRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...commonRow(id),
    name: 'Emergency fund',
    target_amount: 10_000,
    target_date: '2027-08-21',
    is_active: true,
    legacy_unit: null,
    ...overrides,
  };
}

function allocationRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...commonRow(id),
    goal_id: 'goal-valid',
    amount_delta: -30,
    occurred_at: '2026-08-21T09:00',
    note: null,
    ...overrides,
  };
}

function budgetRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...commonRow(id),
    scope: 'overall',
    category_id: null,
    category_name: null,
    period: 'monthly',
    amount: 500,
    is_active: true,
    ...overrides,
  };
}

class FakeSupabaseClient {
  readonly auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: null }> };
  readonly tables = new Map<string, Record<string, unknown>[]>();
  applyResponse?: (table: string, row: Record<string, unknown>) => Record<string, unknown>;

  constructor(ownerId = 'user-a') {
    this.auth = {
      getUser: async () => ({ data: { user: { id: ownerId } }, error: null }),
    };
  }

  from(table: string) {
    let upserted: Record<string, unknown> | undefined;
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: async (from: number, to: number) => ({
        data: (this.tables.get(table) ?? []).slice(from, to + 1),
        error: null,
      }),
      upsert: (row: Record<string, unknown>) => {
        upserted = row;
        return builder;
      },
      single: async () => ({
        data: upserted === undefined
          ? null
          : (this.applyResponse?.(table, upserted) ?? upserted),
        error: null,
      }),
    };
    return builder;
  }
}

function asSupabaseClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

describe('Supabase remote adapter', () => {
  it('keeps an operation pending when Supabase returns the same clock with a different payload', async () => {
    const client = new FakeSupabaseClient();
    client.applyResponse = (_table, row) => ({ ...row, name: 'Cloud value' });
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));
    const record = account();

    await expect(remote.apply('user-a', operation(record))).rejects.toThrow(
      /persisted payload differs.*name/i,
    );
  });

  it('isolates one malformed legacy row while returning other valid remote records with diagnostics', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [accountRow(account())]);
    client.tables.set('categories', [categoryRow('food')]);
    client.tables.set('transactions', [
      {
        id: 'legacy-incomplete',
        user_id: 'user-a',
        version: 1,
        updated_at: NOW,
        last_operation_id: 'legacy-op',
        deleted_at: null,
        amount: 80,
        type: 'expense',
        // A legacy row may not have received a category/account relation.
        category_id: null,
        category_name: '餐飲',
        account_id: 'cash',
        account_name: 'Cash',
        occurred_at: '2026-08-21T08:00',
        note: null,
        recurring_rule_id: null,
        occurrence_date: null,
      },
      {
        id: 'valid-after-malformed',
        user_id: 'user-a',
        version: 1,
        updated_at: NOW,
        last_operation_id: 'valid-op',
        deleted_at: null,
        amount: 20,
        type: 'expense',
        category_id: 'food',
        category_name: '餐飲',
        account_id: 'cash',
        account_name: 'Cash',
        occurred_at: '2026-08-21T09:00',
        note: null,
        recurring_rule_id: null,
        occurrence_date: null,
      },
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a') as unknown as {
      records: Array<{ entity: string; record: { id: string } }>;
      issues: Array<{ stage: string; entity: string; recordId?: string; message: string }>;
    };

    expect(result.records).toEqual([
      expect.objectContaining({ entity: 'accounts', record: expect.objectContaining({ id: 'cash' }) }),
      expect.objectContaining({ entity: 'categories', record: expect.objectContaining({ id: 'food' }) }),
      expect.objectContaining({
        entity: 'transactions',
        record: expect.objectContaining({ id: 'valid-after-malformed' }),
      }),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        stage: 'pull',
        entity: 'transactions',
        recordId: 'legacy-incomplete',
        message: expect.stringContaining('category_id'),
      }),
    ]);
  });

  it('isolates non-positive and unsafe transaction amounts while returning a later valid row', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [accountRow(account())]);
    client.tables.set('categories', [categoryRow('food')]);
    client.tables.set('transactions', [
      transactionRow('zero-amount', { amount: 0 }),
      transactionRow('negative-amount', { amount: -1 }),
      transactionRow('unsafe-amount', { amount: Number.MAX_SAFE_INTEGER + 1 }),
      transactionRow('valid-after-invalid', { amount: 80 }),
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a') as RemotePullResult;

    expect(result.records.map(({ record }) => record.id)).toEqual(['cash', 'food', 'valid-after-invalid']);
    expect(result.issues.map(({ entity, recordId, message }) => ({ entity, recordId, message })))
      .toEqual([
        expect.objectContaining({ entity: 'transactions', recordId: 'zero-amount', message: expect.stringContaining('amount') }),
        expect.objectContaining({ entity: 'transactions', recordId: 'negative-amount', message: expect.stringContaining('amount') }),
        expect.objectContaining({ entity: 'transactions', recordId: 'unsafe-amount', message: expect.stringContaining('amount') }),
      ]);
  });

  it('isolates invalid sync clocks and integer domain fields while preserving valid rows', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [
      accountRow(account({ id: 'fractional-version', version: 1.5 })),
      accountRow(account({ id: 'zero-version', version: 0 })),
      { ...accountRow(account({ id: 'timezone-free-update' })), updated_at: '2026-08-21T10:00' },
      { ...accountRow(account({ id: 'fractional-sort' })), sort_order: 0.5 },
      accountRow(account({ id: 'valid-account' })),
    ]);
    client.tables.set('categories', [categoryRow('food')]);
    client.tables.set('recurring_rules', [
      recurringRow('fractional-anchor', { anchor_day: 21.5 }),
      recurringRow('valid-rule', { account_id: 'valid-account' }),
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a') as RemotePullResult;

    expect(result.records.map(({ record }) => record.id)).toEqual(['valid-account', 'food', 'valid-rule']);
    expect(result.issues.map(({ recordId }) => recordId)).toEqual([
      'fractional-version',
      'zero-version',
      'timezone-free-update',
      'fractional-sort',
      'fractional-anchor',
    ]);
  });

  it('enforces remaining FinanceData row contracts without rejecting signed deltas', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [
      accountRow(account({ id: 'unsafe-opening', openingBalance: Number.MAX_SAFE_INTEGER + 1 })),
      accountRow(account({ id: 'blank-account-name', name: '   ' })),
      accountRow(account({ id: 'cash' })),
    ]);
    client.tables.set('categories', [categoryRow('food')]);
    client.tables.set('transactions', [
      transactionRow('invalid-transaction-date', { occurred_at: '2026-02-30' }),
    ]);
    client.tables.set('adjustments', [
      adjustmentRow('zero-adjustment', { amount_delta: 0 }),
      adjustmentRow('signed-adjustment', { amount_delta: -25 }),
    ]);
    client.tables.set('goals', [
      goalRow('zero-goal', { target_amount: 0 }),
      goalRow('invalid-goal-date', { target_date: '2027-02-29' }),
      goalRow('goal-valid'),
    ]);
    client.tables.set('savings_allocations', [
      allocationRow('zero-allocation', { amount_delta: 0 }),
      allocationRow('signed-allocation', { amount_delta: -30 }),
    ]);
    client.tables.set('budgets', [
      budgetRow('zero-budget', { amount: 0 }),
      budgetRow('overall-with-category', { category_id: 'food', category_name: '餐飲' }),
      budgetRow('budget-valid'),
    ]);
    client.tables.set('recurring_rules', [
      recurringRow('zero-recurring', { amount: 0 }),
      recurringRow('invalid-recurring-date', { start_date: '2026-13-01' }),
      recurringRow('recurring-valid'),
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a') as RemotePullResult;

    expect(result.records.map(({ record }) => record.id)).toEqual([
      'cash',
      'food',
      'signed-adjustment',
      'goal-valid',
      'signed-allocation',
      'budget-valid',
      'recurring-valid',
    ]);
    expect(result.issues.map(({ recordId }) => recordId)).toEqual([
      'unsafe-opening',
      'blank-account-name',
      'invalid-transaction-date',
      'zero-adjustment',
      'zero-goal',
      'invalid-goal-date',
      'zero-allocation',
      'zero-budget',
      'overall-with-category',
      'zero-recurring',
      'invalid-recurring-date',
    ]);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity: 'adjustments',
        record: expect.objectContaining({ id: 'signed-adjustment', amountDelta: -25 }),
      }),
      expect.objectContaining({
        entity: 'allocations',
        record: expect.objectContaining({ id: 'signed-allocation', amountDelta: -30 }),
      }),
    ]));
  });

  it('isolates decoded rows whose cross-entity references are missing or the wrong kind', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [accountRow(account({ id: 'cash' }))]);
    client.tables.set('categories', [
      categoryRow('food', { kind: 'expense' }),
      categoryRow('salary', { kind: 'income' }),
    ]);
    client.tables.set('transactions', [
      transactionRow('missing-account', { account_id: 'missing' }),
      transactionRow('wrong-kind', { category_id: 'salary', category_name: '薪資' }),
      transactionRow('valid-transaction'),
    ]);
    client.tables.set('recurring_rules', [
      recurringRow('broken-rule', { account_id: 'missing' }),
    ]);
    client.tables.set('savings_allocations', [
      allocationRow('missing-goal', { goal_id: 'missing' }),
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a') as RemotePullResult;

    expect(result.records.map(({ record }) => record.id)).toEqual(['cash', 'food', 'salary', 'valid-transaction']);
    expect(result.issues.map(({ stage, recordId }) => ({ stage, recordId }))).toEqual(expect.arrayContaining([
      { stage: 'validation', recordId: 'missing-account' },
      { stage: 'validation', recordId: 'wrong-kind' },
      { stage: 'validation', recordId: 'broken-rule' },
      { stage: 'validation', recordId: 'missing-goal' },
    ]));
  });

  it('accepts explicit database normalization without weakening payload comparison', async () => {
    const client = new FakeSupabaseClient();
    client.applyResponse = (_table, row) => ({
      ...row,
      version: String(row.version),
      updated_at: '2026-08-21T10:00:00Z',
      opening_balance: String(row.opening_balance),
      sort_order: String(row.sort_order),
      requires_review: false,
    });
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    await expect(remote.apply('user-a', operation(account()))).resolves.toBeUndefined();
  });

  it('fails closed when getUser does not match the requested owner', async () => {
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(new FakeSupabaseClient('user-b')));

    await expect(remote.pull('user-a')).rejects.toThrow(/session owner does not match/i);
    await expect(remote.apply('user-a', operation(account()))).rejects.toThrow(
      /session owner does not match/i,
    );
  });

  it('drops a foreign-owner query result and reports an ownership diagnostic', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [accountRow(account({ ownerId: 'user-b' }))]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a');

    expect(Array.isArray(result)).toBe(false);
    const pullResult = result as RemotePullResult;
    expect(pullResult.records).toEqual([]);
    expect(pullResult.issues).toEqual([
      expect.objectContaining({
        stage: 'validation',
        entity: 'accounts',
        recordId: 'cash',
        message: expect.stringContaining('foreign-owner'),
      }),
    ]);
  });
});
