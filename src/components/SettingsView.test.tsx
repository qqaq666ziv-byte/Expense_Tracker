import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import { MAX_BACKUP_BYTES, parseFinanceBackup } from '../domain/backup';
import { MAX_RECURRING_CATCH_UP_OCCURRENCES } from '../domain/recurrence';
import {
  isFullBackupFileWithinLimit,
  getRecurringResumeBlock,
  includeCurrentInactiveOption,
  isRecurringEditStale,
  prepareFullBackupDownload,
  RecurringPanel,
  SettingsView,
} from './SettingsView';

describe('SettingsView category lifecycle', () => {
  it('renders explicit edit, archive, delete and understandable status controls', () => {
    const state = createInitialState('guest');
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    const html = renderToStaticMarkup(
      <SettingsView
        data={state.data}
        ownerId="guest"
        putCategory={() => true}
        putRecurring={() => true}
        categoryLifecycle={() => true}
        deleteRecurring={() => true}
        restore={() => undefined}
      />,
    );

    expect(html).toContain(`編輯 ${category.name}`);
    expect(html).toContain(`封存 ${category.name}`);
    expect(html).toContain(`刪除 ${category.name}`);
    expect(html).toContain('未使用');
    expect(html).toContain('分類顯示順序');
    expect(html).not.toContain('新增資產帳戶');
  });
});

describe('SettingsView backup safety', () => {
  it('returns a visible Traditional Chinese error instead of throwing for an oversized full backup', () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.transactions = Array.from(
      { length: Math.ceil(MAX_BACKUP_BYTES / 20_000) + 1 },
      (_, index) => ({
        id: `oversized-transaction-${index}`,
        ownerId: 'guest',
        version: 1,
        updatedAt: '2026-08-23T00:00:00.000Z',
        lastOperationId: `oversized-operation-${index}`,
        amount: 1,
        type: 'expense' as const,
        categoryId: category.id,
        categoryName: category.name,
        accountId: account.id,
        accountName: account.name,
        occurredAt: '2026-08-23T08:00:00',
        note: 'x'.repeat(20_000),
      }),
    );

    const result = prepareFullBackupDownload(state.data, '2026-08-23');

    expect(result).toEqual({
      ok: false,
      reason: 'size-limit',
      message: expect.stringMatching(/^\u5b8c\u6574 JSON \u5099\u4efd\u672a\u532f\u51fa\uff1a.*5,000,000.*UTF-8 \u4f4d\u5143\u7d44\u5b89\u5168\u4e0a\u9650/),
    });
  });

  it('round-trips Chinese and emoji content through export, the file-size gate, and parsing', async () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.transactions = [{
      id: 'multibyte-round-trip',
      ownerId: 'guest',
      version: 1,
      updatedAt: '2026-08-23T00:00:00.000Z',
      lastOperationId: 'multibyte-round-trip-created',
      amount: 188,
      type: 'expense',
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      occurredAt: '2026-08-23T08:00:00',
      note: '早餐與咖啡 ☕🙂',
    }];

    const result = prepareFullBackupDownload(state.data, '2026-08-23');
    expect(result.ok).toBe(true);
    if ('message' in result) throw new Error(result.message);
    const file = new Blob([result.content], { type: 'application/json' });

    expect(file.size).toBe(new TextEncoder().encode(result.content).byteLength);
    expect(isFullBackupFileWithinLimit(file)).toBe(true);
    expect(parseFinanceBackup(await file.text()).data).toEqual(state.data);
  });

  it('accepts the exact byte limit and rejects a file one byte over it', () => {
    expect(isFullBackupFileWithinLimit({ size: MAX_BACKUP_BYTES })).toBe(true);
    expect(isFullBackupFileWithinLimit({ size: MAX_BACKUP_BYTES + 1 })).toBe(false);
  });
});

describe('SettingsView recurring safety', () => {
  it('preserves archived parents while editing and blocks resume until they are active', () => {
    const state = createInitialState('guest');
    const account = { ...state.data.accounts[0], isActive: false };
    const category = { ...state.data.categories.find((item) => item.kind === 'expense')!, isActive: false };
    state.data.accounts[0] = account;
    state.data.categories = state.data.categories.map((item) => item.id === category.id ? category : item);
    const rule = {
      id: 'paused-rule', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'paused-rule-op',
      name: '已暫停規則', type: 'expense' as const, amount: 100,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly' as const, startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: false,
    };

    expect(includeCurrentInactiveOption([], category)).toEqual([category]);
    expect(includeCurrentInactiveOption([], account)).toEqual([account]);
    expect(getRecurringResumeBlock(state.data, rule)).toMatch(/先重新啟用/);
    expect(isRecurringEditStale(rule, { ...rule, version: 3, lastOperationId: 'newer-rule-op' })).toBe(true);
    expect(isRecurringEditStale(rule, { ...rule })).toBe(false);
    expect(isRecurringEditStale(rule, { ...rule, deletedAt: '2026-08-27T02:00:00.000Z' })).toBe(true);
    expect(isRecurringEditStale(rule, undefined)).toBe(true);
  });

  it('shows an explicit recurring-rule edit action', () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.recurringRules = [{
      id: 'monthly-rent', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'monthly-rent-created',
      name: '房租', type: 'expense', amount: 12000,
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name,
      frequency: 'monthly', startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    }];

    const html = renderToStaticMarkup(
      <RecurringPanel data={state.data} ownerId="guest" putRecurring={() => true} deleteRecurring={() => true} />,
    );

    expect(html).toContain('編輯 房租');
  });

  it('shows a recovery path when an active rule exceeds the catch-up limit', () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.recurringRules = [{
      id: 'ancient-weekly',
      ownerId: 'guest',
      version: 1,
      updatedAt: '2026-08-23T00:00:00.000Z',
      lastOperationId: 'ancient-weekly-created',
      name: '遠古週期規則',
      type: 'expense',
      amount: 100,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      frequency: 'weekly',
      startDate: '0001-01-01',
      nextOccurrenceDate: '0001-01-01',
      isActive: true,
    }];

    const html = renderToStaticMarkup(
      <RecurringPanel
        data={state.data}
        ownerId="guest"
        putRecurring={() => true}
        deleteRecurring={() => true}
      />,
    );

    expect(html).toContain(`超過 ${MAX_RECURRING_CATCH_UP_OCCURRENCES} 筆安全上限`);
    expect(html).toContain('已停止自動補登且未推進日期');
    expect(html).toContain('先暫停再恢復');
  });
});
