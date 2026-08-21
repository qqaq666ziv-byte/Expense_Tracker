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
