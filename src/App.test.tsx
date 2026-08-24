import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from './app/state';
import type { LegacyAuthenticatedBootstrap } from './domain/model';
import { LegacyBootstrapPanel } from './App';

function bootstrap(status: LegacyAuthenticatedBootstrap['status']): LegacyAuthenticatedBootstrap {
  const candidate = createInitialState('user-a').data;
  const account = candidate.accounts[0];
  const category = candidate.categories.find((item) => item.kind === 'expense')!;
  candidate.transactions.push({
    id: 'legacy-offline-transaction',
    ownerId: 'user-a',
    version: 1,
    updatedAt: '2026-08-23T12:00:00.000Z',
    lastOperationId: 'legacy-offline-operation',
    amount: 120,
    type: 'expense',
    categoryId: category.id,
    categoryName: category.name,
    accountId: account.id,
    accountName: account.name,
    occurredAt: '2026-08-23 12:00',
  });
  return {
    status,
    candidate,
    unsyncedTransactionIds: ['legacy-offline-transaction'],
  };
}

describe('authenticated legacy bootstrap panel', () => {
  it('explains the cloud-first pending gate and keeps manual sync available', () => {
    const html = renderToStaticMarkup(
      <LegacyBootstrapPanel
        bootstrap={bootstrap('pending')}
        syncBusy={false}
        onSync={() => {}}
        onDownload={() => {}}
        onImport={() => {}}
        onKeepCloud={() => {}}
      />,
    );

    expect(html).toContain('正在安全讀取你的雲端帳本');
    expect(html).toContain('重新讀取');
    expect(html).not.toContain('匯入這份資料');
  });

  it('shows candidate and unsynced transaction counts before any explicit decision', () => {
    const html = renderToStaticMarkup(
      <LegacyBootstrapPanel
        bootstrap={bootstrap('ready')}
        syncBusy={false}
        onSync={() => {}}
        onDownload={() => {}}
        onImport={() => {}}
        onKeepCloud={() => {}}
      />,
    );

    expect(html).toContain('16 筆舊資料');
    expect(html).toContain('1 筆交易可能還沒上傳');
    expect(html).toContain('下載備份');
    expect(html).toContain('匯入這份資料');
    expect(html).toContain('保留雲端版本');
  });
});
