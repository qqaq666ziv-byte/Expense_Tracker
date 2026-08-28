import { describe, expect, it } from 'vitest';
import { MAX_SAFE_MONEY } from '../domain/money';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssetAccount, PendingOperation, SavingsAllocation, Transfer } from '../domain/model';
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

function allocationOperation(overrides: Partial<SavingsAllocation> = {}): PendingOperation {
  const record: SavingsAllocation = {
    id: 'allocation-over-capacity',
    ownerId: 'user-a',
    version: 1,
    updatedAt: NOW,
    lastOperationId: 'op-allocation-over-capacity',
    goalId: 'goal-valid',
    amountDelta: 300,
    occurredAt: '2026-08-21T09:00',
    ...overrides,
  };
  return {
    id: record.lastOperationId,
    entity: 'allocations',
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

function transferRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...commonRow(id),
    amount: 100,
    source_account_id: 'bank',
    source_account_name: '銀行',
    destination_account_id: 'cash',
    destination_account_name: 'Cash',
    occurred_at: '2026-08-21T09:30',
    note: '領現',
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
  applyError?: (table: string, row: Record<string, unknown>) => {
    code: string;
    message: string;
    details?: string;
    hint?: string;
  } | null;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  rpcResponse?: { data: unknown; error: null | { code: string; message: string } };

  constructor(ownerId = 'user-a') {
    this.auth = {
      getUser: async () => ({ data: { user: { id: ownerId } }, error: null }),
    };
  }

  from(table: string) {
    let upserted: Record<string, unknown> | undefined;
    let updated: Record<string, unknown> | undefined;
    const filters = new Map<string, unknown>();
    let projection = '*';
    const moneyColumn = new Map([
      ['accounts', 'opening_balance'],
      ['transactions', 'amount'],
      ['transfers', 'amount'],
      ['adjustments', 'amount_delta'],
      ['goals', 'target_amount'],
      ['savings_allocations', 'amount_delta'],
      ['budgets', 'amount'],
      ['recurring_rules', 'amount'],
    ]).get(table);
    const project = (row: Record<string, unknown>) => (
      moneyColumn !== undefined && projection.includes('__finance_money_text')
        ? {
          ...row,
          __finance_money_text: row.__finance_money_text ?? String(row[moneyColumn]),
        }
        : row
    );
    const builder = {
      select: (value = '*') => { projection = value; return builder; },
      eq: (column: string, value: unknown) => { filters.set(column, value); return builder; },
      order: () => builder,
      range: async (from: number, to: number) => ({
        data: (this.tables.get(table) ?? []).slice(from, to + 1).map(project),
        error: null,
      }),
      upsert: (row: Record<string, unknown>) => {
        upserted = row;
        return builder;
      },
      update: (row: Record<string, unknown>) => {
        updated = row;
        return builder;
      },
      single: async () => {
        const error = upserted === undefined
          ? null
          : (this.applyError?.(table, upserted) ?? null);
        return {
          data: error || upserted === undefined
            ? null
            : project(this.applyResponse?.(table, upserted) ?? upserted),
          error,
        };
      },
      maybeSingle: async () => {
        if (!updated) return { data: null, error: null };
        const rows = this.tables.get(table) ?? [];
        const index = rows.findIndex((row) => (
          [...filters].every(([column, value]) => row[column] === value)
        ));
        if (index < 0) return { data: null, error: null };
        const next = { ...rows[index], ...updated };
        this.tables.set(table, rows.map((row, rowIndex) => rowIndex === index ? next : row));
        return { data: project(next), error: null };
      },
    };
    return builder;
  }

  async rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args });
    return this.rpcResponse ?? { data: [], error: null };
  }
}

function asSupabaseClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

describe('Supabase remote adapter', () => {
  it('uses the dedicated RPC for an explicitly marked historical transfer import batch', async () => {
    const client = new FakeSupabaseClient();
    const source = account({ id: 'bank', name: '主要銀行', isActive: false });
    const destination = account({ id: 'cash', name: '現金' });
    const historical: Transfer = {
      id: 'historical-transfer', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'historical-transfer-op',
      amount: 250, sourceAccountId: source.id, sourceAccountName: '舊銀行名',
      destinationAccountId: destination.id, destinationAccountName: destination.name,
      occurredAt: '2026-08-20 08:00',
    };
    const transferPending: PendingOperation = {
      id: historical.lastOperationId,
      entity: 'transfers',
      recordId: historical.id,
      record: historical,
      attempts: 0,
      queuedAt: NOW,
    };
    const operations: PendingOperation[] = [
      operation(source),
      operation(destination),
      transferPending,
    ].map((pending) => ({
      ...pending,
      historicalImportBatchId: 'historical-import:restore-1',
    }));
    client.rpcResponse = {
      data: operations.map((pending) => ({
        entity: pending.entity,
        id: pending.recordId,
        version: pending.record.version,
        last_operation_id: pending.id,
      })),
      error: null,
    };
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    await remote.applyHistoricalImportBatch!('user-a', {
      id: 'historical-import:restore-1',
      operations,
      endpointAccounts: [source, destination],
    });

    expect(client.rpcCalls).toEqual([expect.objectContaining({
      fn: 'finance_import_historical_transfer_batch',
      args: expect.objectContaining({
        p_batch_id: 'historical-import:restore-1',
        p_account_operations: expect.arrayContaining([
          expect.objectContaining({ id: 'bank', is_active: false, user_id: 'user-a' }),
        ]),
        p_endpoint_accounts: expect.arrayContaining([
          expect.objectContaining({ id: 'bank', name: '主要銀行', user_id: 'user-a' }),
        ]),
        p_transfer_operations: [expect.objectContaining({
          id: 'historical-transfer', source_account_name: '舊銀行名', user_id: 'user-a',
        })],
      }),
    })]);
  });

  it('encodes and decodes one first-class transfer without paired transactions', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [
      accountRow(account({ id: 'bank', name: '銀行' })),
      accountRow(account()),
    ]);
    client.tables.set('transfers', [transferRow('transfer-1')]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const pulled = await remote.pull('user-a') as RemotePullResult;
    expect(pulled.records).toContainEqual({
      entity: 'transfers',
      record: expect.objectContaining({
        id: 'transfer-1', amount: 100, sourceAccountId: 'bank',
        destinationAccountId: 'cash', note: '領現',
      }),
    });

    let encoded: Record<string, unknown> | undefined;
    client.applyResponse = (table, row) => {
      if (table === 'transfers') encoded = row;
      return row;
    };
    const record = pulled.records.find((entry) => entry.entity === 'transfers')!.record as Transfer;
    await remote.apply('user-a', {
      id: record.lastOperationId,
      entity: 'transfers',
      recordId: record.id,
      record,
      attempts: 0,
      queuedAt: NOW,
    });
    expect(encoded).toMatchObject({
      source_account_id: 'bank', destination_account_id: 'cash', amount: 100,
    });
  });

  it('quarantines a transfer with missing or identical endpoints', async () => {
    const client = new FakeSupabaseClient();
    client.tables.set('accounts', [accountRow(account())]);
    client.tables.set('transfers', [
      transferRow('missing-source'),
      transferRow('same-account', {
        source_account_id: 'cash', destination_account_id: 'cash',
      }),
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const pulled = await remote.pull('user-a') as RemotePullResult;

    expect(pulled.records.map((entry) => entry.record.id)).toEqual(['cash']);
    expect(pulled.issues).toEqual([
      expect.objectContaining({ entity: 'transfers', recordId: 'same-account' }),
      expect.objectContaining({ entity: 'transfers', recordId: 'missing-source' }),
    ]);
  });

  it('maps allocation capacity rejection to a private actionable message', async () => {
    const client = new FakeSupabaseClient();
    client.applyError = () => ({
      code: '23514',
      message: 'new savings allocation exceeds available assets',
      details: 'Failing row contains private financial values',
    });
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const failure = await remote.apply('user-a', allocationOperation()).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toBe(
      '雲端可配置資產不足。請先釋放既有儲蓄配置或增加資產後再重試。',
    );
  });

  it('preserves the existing diagnostic for unrelated server constraints', async () => {
    const client = new FakeSupabaseClient();
    client.applyError = () => ({
      code: '23514',
      message: 'new row violates check constraint "some_other_constraint"',
    });
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    await expect(remote.apply('user-a', allocationOperation())).rejects.toThrow(
      'Unable to apply allocations/allocation-over-capacity to Supabase: 23514: new row violates check constraint "some_other_constraint"',
    );
  });

  it('keeps an operation pending when Supabase returns the same clock with a different payload', async () => {
    const client = new FakeSupabaseClient();
    client.applyResponse = (_table, row) => ({ ...row, name: 'Cloud value' });
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));
    const record = account();

    await expect(remote.apply('user-a', operation(record))).rejects.toThrow(
      /persisted payload differs.*name/i,
    );
  });

  it('conditionally compensates only while the expected remote clock is unchanged', async () => {
    const client = new FakeSupabaseClient();
    const expected = account({ version: 2, lastOperationId: 'forward-v2', isActive: false });
    const compensated = account({
      version: 3,
      lastOperationId: '00000000-0000-0000-0000-000000000000:active:batch-compensation:test',
      isActive: true,
    });
    client.tables.set('accounts', [accountRow(expected)]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    await expect(remote.compareAndSwap!(
      'user-a',
      { entity: 'accounts', record: expected },
      operation(compensated),
    )).resolves.toEqual({
      entity: 'accounts',
      record: { ...compensated, requiresReview: false },
    });
    expect(client.tables.get('accounts')?.[0]).toEqual(accountRow(compensated));

    const staleReplacement = account({
      version: 4,
      lastOperationId: '00000000-0000-0000-0000-000000000000:active:batch-compensation:stale',
    });
    await expect(remote.compareAndSwap!(
      'user-a',
      { entity: 'accounts', record: expected },
      operation(staleReplacement),
    )).resolves.toBeUndefined();
    expect(client.tables.get('accounts')?.[0]).toEqual(accountRow(compensated));
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
      transactionRow('unsafe-money-magnitude', { amount: MAX_SAFE_MONEY + 1 }),
      transactionRow('legacy-precision', { amount: 1.234 }),
      transactionRow('unsupported-precision', { amount: '1.234567890123456789' }),
      transactionRow('collapsed-precision', {
        amount: 0.1,
        __finance_money_text: '0.1000000000000000000001',
      }),
      transactionRow('valid-after-invalid', { amount: 80 }),
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a') as RemotePullResult;

    expect(result.records.map(({ record }) => record.id)).toEqual([
      'cash',
      'food',
      'legacy-precision',
      'valid-after-invalid',
    ]);
    expect(result.issues.map(({ entity, recordId, message }) => ({ entity, recordId, message })))
      .toEqual([
        expect.objectContaining({ entity: 'transactions', recordId: 'zero-amount', message: expect.stringContaining('amount') }),
        expect.objectContaining({ entity: 'transactions', recordId: 'negative-amount', message: expect.stringContaining('amount') }),
        expect.objectContaining({ entity: 'transactions', recordId: 'unsafe-amount', message: expect.stringContaining('amount') }),
        expect.objectContaining({ entity: 'transactions', recordId: 'unsafe-money-magnitude', message: expect.stringContaining('amount') }),
        expect.objectContaining({ entity: 'transactions', recordId: 'unsupported-precision', message: expect.stringContaining('precision') }),
        expect.objectContaining({ entity: 'transactions', recordId: 'collapsed-precision', message: expect.stringContaining('precision') }),
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
    client.tables.set('accounts', [
      accountRow(account({ id: 'cash' })),
      accountRow(account({ id: 'archived-account', isActive: false })),
    ]);
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
      recurringRow('active-rule-with-archived-parent', { account_id: 'archived-account' }),
      recurringRow('paused-rule-with-archived-parent', {
        account_id: 'archived-account',
        is_active: false,
      }),
    ]);
    client.tables.set('savings_allocations', [
      allocationRow('missing-goal', { goal_id: 'missing' }),
    ]);
    const remote = createSupabaseRemoteAdapter(asSupabaseClient(client));

    const result = await remote.pull('user-a') as RemotePullResult;

    expect(result.records.map(({ record }) => record.id)).toEqual([
      'cash',
      'archived-account',
      'food',
      'salary',
      'valid-transaction',
      'paused-rule-with-archived-parent',
    ]);
    expect(result.issues.map(({ stage, recordId }) => ({ stage, recordId }))).toEqual(expect.arrayContaining([
      { stage: 'validation', recordId: 'missing-account' },
      { stage: 'validation', recordId: 'wrong-kind' },
      { stage: 'validation', recordId: 'broken-rule' },
      { stage: 'validation', recordId: 'active-rule-with-archived-parent' },
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
