// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../app/state';
import type { FinanceSyncOutcome } from '../../app/useFinanceApp';
import type { ShortcutApi, ShortcutConnection, ShortcutInboxItem } from './types';
import { ShortcutsPanel } from './ShortcutsPanel';

vi.mock('../../lib/supabaseClient', () => ({
  supabase: null,
  isBrowserSafeSupabaseKey: (key: string | undefined) => !!key && !key.startsWith('sb_secret_'),
}));

const successfulSync = (...ids: string[]) => vi.fn(async (): Promise<FinanceSyncOutcome> => ({ status: 'synced', confirmedTransactionIds: ids }));

const connection: ShortcutConnection = {
  id: 'connection-a', label: '測試手機', mode: 'review', account_id: null, category_id: null,
  verified_at: null, revoked_at: null, created_at: '2026-01-02T00:00:00.000Z',
};
const notice: ShortcutInboxItem = {
  id: 'notice-a', connection_id: connection.id, amount: 125.5, merchant: 'Example Services',
  occurred_at: '2026-01-02T07:47:00+08:00', status: 'pending', transaction_id: null,
  reason: 'multiple_amounts', payload: { title: '扣款通知', text: '合成測試通知，含折抵，需人工確認' },
  created_at: '2026-01-02T00:00:00.000Z',
};

function makeApi(connections = [connection], notices: ShortcutInboxItem[] = [notice]) {
  return {
    endpoint: 'https://example.invalid/functions/v1/finance-shortcut-receive',
    listConnections: vi.fn(async () => connections),
    listInbox: vi.fn(async () => notices),
    listPending: vi.fn(async () => ({ items: notices.filter((item) => item.status === 'pending'), pending_count: notices.filter((item) => item.status === 'pending').length,
      has_more: false, next_created_at: null, next_id: null })),
    create: vi.fn(async () => connection),
    revoke: vi.fn(async () => undefined),
    configure: vi.fn(async () => connection),
    review: vi.fn(async () => ({ status: 'imported' as const, transaction_id: 'transaction-a' })),
  } satisfies ShortcutApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openInbox(api = makeApi(), onSync = successfulSync('transaction-a')) {
  const data = createInitialState('owner-a').data;
  const user = userEvent.setup();
  const view = render(<ShortcutsPanel ownerId="owner-a" data={data} api={api} onSync={onSync} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /通知收件匣/ }));
  await screen.findByText('Example Services', { selector: 'h3' });
  return { api, onSync, data, user, view };
}

describe('iPhone shortcuts panel', () => {
  it('lets guests diagnose mixed-amount notices locally without network or persistence', async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="guest" data={createInitialState('guest').data} api={api} onSync={successfulSync()} />);
    expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '通知測試' }));
    await user.type(screen.getByLabelText('通知標題'), '扣款通知');
    fireEvent.change(screen.getByLabelText('通知內文'), { target: { value: '您有一筆來自Example Services的授權扣款$1234訂單，已於2026/01/02 07:47 自動儲值 $1234 至您的街口帳戶，並已於2026/01/02 07:47 使用街口幣折抵 $8 元、街口券折抵 $50 元成功扣款 $1234' } });
    await user.click(screen.getByRole('button', { name: '在此裝置測試' }));
    expect(screen.getByText('需要人工確認')).toBeInTheDocument();
    expect(screen.getByText('NT$ 1234.00')).toBeInTheDocument();
    expect(screen.getByText(/儲值不另算支出/)).toBeInTheDocument();
    expect(api.listConnections).not.toHaveBeenCalled();
    expect(api.listInbox).not.toHaveBeenCalled();
    expect(api.review).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('creates a transient secret, sends only its hash and clears it synchronously on an owner switch', async () => {
    const api = makeApi([], []);
    const user = userEvent.setup();
    const view = render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    const field = await screen.findByLabelText('一次性顯示的捷徑金鑰');
    const secret = (field as HTMLTextAreaElement).value;
    expect(secret).toMatch(/^shiba_sc_[a-f0-9]{64}$/);
    expect(api.create).toHaveBeenCalledWith('owner-a', '我的 iPhone', expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(JSON.stringify(api.create.mock.calls)).not.toContain(secret);
    expect(localStorage.length).toBe(0);
    view.rerender(<ShortcutsPanel ownerId="guest" data={createInitialState('guest').data} api={api} onSync={successfulSync()} />);
    expect(screen.queryByLabelText('一次性顯示的捷徑金鑰')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secret);
  });

  it('ignores previous-owner fetch results after an account change', async () => {
    const first = deferred<ShortcutInboxItem[]>();
    const api = makeApi();
    api.listInbox.mockImplementationOnce(() => first.promise).mockResolvedValue([]);
    api.listPending.mockResolvedValue({ items: [], pending_count: 0, has_more: false, next_created_at: null, next_id: null });
    const user = userEvent.setup();
    const view = render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    view.rerender(<ShortcutsPanel ownerId="owner-b" data={createInitialState('owner-b').data} api={api} onSync={successfulSync()} />);
    await act(async () => first.resolve([{ ...notice, merchant: 'A 的私人資料' }]));
    await user.click(screen.getByRole('button', { name: /通知收件匣/ }));
    expect(screen.queryByText('A 的私人資料')).not.toBeInTheDocument();
    expect(await screen.findByText(/還沒有通知/)).toBeInTheDocument();
  });

  it('discards an in-flight create result after switching owners', async () => {
    const pending = deferred<ShortcutConnection>();
    const api = makeApi([], []);
    api.create.mockImplementation(() => pending.promise);
    const user = userEvent.setup();
    const view = render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    view.rerender(<ShortcutsPanel ownerId="owner-b" data={createInitialState('owner-b').data} api={api} onSync={successfulSync()} />);
    await act(async () => pending.resolve({ ...connection, label: 'A 的私人連線' }));
    expect(screen.queryByLabelText('一次性顯示的捷徑金鑰')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    expect(screen.queryByText('A 的私人連線')).not.toBeInTheDocument();
  });

  it('requires explicit parents and preserves pasted decimal money for a single approval', async () => {
    const pending = deferred<{ status: 'imported'; transaction_id: string }>();
    const api = makeApi();
    api.review.mockImplementation(() => pending.promise);
    const { user, data, onSync } = await openInbox(api);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    expect(api.review).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('請明確選擇');
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find((row) => row.kind === 'expense')!.id);
    const amount = screen.getByLabelText('確認支出金額（TWD）');
    await user.clear(amount);
    await user.click(amount);
    await user.paste('125.5');
    const approve = screen.getByRole('button', { name: '確認入帳' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(api.review).toHaveBeenCalledTimes(1);
    expect(api.review).toHaveBeenCalledWith('owner-a', expect.objectContaining({ amount: 125.5, accountId: data.accounts[0].id, action: 'approve' }));
    expect(onSync).not.toHaveBeenCalled();
    api.listInbox.mockResolvedValue([{ ...notice, status: 'imported', transaction_id: 'transaction-a' }]);
    await act(async () => pending.resolve({ status: 'imported', transaction_id: 'transaction-a' }));
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '確認入帳' })).not.toBeInTheDocument();
    expect(screen.getByText('已入帳', { selector: 'span' })).toBeInTheDocument();
  });

  it('never offers approval for test notifications', async () => {
    await openInbox(makeApi([connection], [{ ...notice, status: 'test' }]));
    expect(screen.getByText('測試，未入帳')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確認入帳' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '略過，不入帳' })).not.toBeInTheDocument();
  });

  it('submits the original second and millisecond precision when the user leaves time unchanged', async () => {
    const exactTime = '2026-01-01T23:47:42.123Z';
    const api = makeApi([connection], [{ ...notice, occurred_at: exactTime }]);
    const { user, data } = await openInbox(api);
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find((row) => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    expect(api.review).toHaveBeenCalledWith('owner-a', expect.objectContaining({ occurredAt: exactTime }));
  });

  it('keeps auto mode disabled before a compatible real event is reviewed', async () => {
    const { user } = await openInbox();
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    expect(screen.getByRole('option', { name: '相容通知自動入帳' })).toBeDisabled();
    expect(screen.getByText(/尚未從收件匣確認含來源 ID 的相容通知/)).toBeInTheDocument();
  });

  it('requires a fresh explicit checkbox confirmation for every auto save', async () => {
    const data = createInitialState('owner-a').data;
    const eligible: ShortcutConnection = {
      ...connection, account_id: data.accounts[0].id, category_id: data.categories.find((row) => row.kind === 'expense')!.id,
      verified_at: '2026-01-02T00:00:00Z', verified_format: 'jkopay-single-debit-v1',
    };
    const api = makeApi([eligible], []);
    api.configure.mockResolvedValue({ ...eligible, mode: 'auto' });
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={data} api={api} onSync={successfulSync()} />);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    const mode = await screen.findByLabelText('入帳方式');
    await user.selectOptions(mode, 'auto');
    expect(screen.getByRole('checkbox', { name: /我已在 iPhone 重送測試/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: '儲存連線設定' }));
    expect(api.configure).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('勾選確認');
    await user.click(screen.getByRole('checkbox', { name: /我已在 iPhone 重送測試/ }));
    await user.click(screen.getByRole('button', { name: '儲存連線設定' }));
    expect(api.configure).toHaveBeenCalledTimes(1);
    expect(api.configure).toHaveBeenCalledWith('owner-a', {
      id: eligible.id, accountId: eligible.account_id, categoryId: eligible.category_id, mode: 'auto', stableEventIdConfirmed: true,
    });
    await screen.findByText('連線設定已儲存。');
    expect(screen.getByRole('checkbox', { name: /我已在 iPhone 重送測試/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: '儲存連線設定' }));
    expect(api.configure).toHaveBeenCalledTimes(1);
    // Saving an already-auto connection keeps the same component key; it still consumes the confirmation.
    await user.click(screen.getByRole('checkbox', { name: /我已在 iPhone 重送測試/ }));
    await user.click(screen.getByRole('button', { name: '儲存連線設定' }));
    expect(api.configure).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('checkbox', { name: /我已在 iPhone 重送測試/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: '儲存連線設定' }));
    expect(api.configure).toHaveBeenCalledTimes(2);
  });

  it('does not require ID confirmation to return a connection to review mode', async () => {
    const data = createInitialState('owner-a').data;
    const automatic: ShortcutConnection = {
      ...connection, mode: 'auto', account_id: data.accounts[0].id, category_id: data.categories.find((row) => row.kind === 'expense')!.id,
      verified_at: '2026-01-02T00:00:00Z', verified_format: 'jkopay-single-debit-v1',
    };
    const api = makeApi([automatic], []);
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={data} api={api} onSync={successfulSync()} />);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await user.selectOptions(await screen.findByLabelText('入帳方式'), 'review');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '儲存連線設定' }));
    expect(api.configure).toHaveBeenCalledWith('owner-a', expect.objectContaining({ mode: 'review', stableEventIdConfirmed: false }));
  });

  it('clears stable-ID confirmation when switching owners', async () => {
    const automatic: ShortcutConnection = {
      ...connection, mode: 'auto', verified_at: '2026-01-02T00:00:00Z', verified_format: 'jkopay-single-debit-v1',
    };
    const api = makeApi([automatic], []);
    const user = userEvent.setup();
    const view = render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    const checkbox = await screen.findByRole('checkbox', { name: /我已在 iPhone 重送測試/ });
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    view.rerender(<ShortcutsPanel ownerId="owner-b" data={createInitialState('owner-b').data} api={api} onSync={successfulSync()} />);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    expect(await screen.findByRole('checkbox', { name: /我已在 iPhone 重送測試/ })).not.toBeChecked();
    expect(api.configure).not.toHaveBeenCalled();
  });

  it('blocks a second active auto connection without reconfiguring or revoking the first', async () => {
    const data = createInitialState('owner-a').data;
    const eligible: ShortcutConnection = {
      ...connection, account_id: data.accounts[0].id, category_id: data.categories.find((row) => row.kind === 'expense')!.id,
      verified_at: '2026-01-02T00:00:00Z', verified_format: 'jkopay-single-debit-v1',
    };
    const api = makeApi([{ ...eligible, mode: 'auto', label: '主要手機' }, { ...eligible, id: 'connection-b', label: '第二支手機' }], []);
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={data} api={api} onSync={successfulSync()} />);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    const second = (await screen.findByRole('heading', { name: '第二支手機' })).closest('article')!;
    expect(within(second).getByRole('option', { name: '相容通知自動入帳' })).toBeDisabled();
    expect(screen.getByText(/只可有一個啟用自動入帳的連線/)).toBeInTheDocument();
    // The submit guard remains effective even if a synthetic event bypasses the disabled option.
    fireEvent.change(within(second).getByLabelText('入帳方式'), { target: { value: 'auto' } });
    await user.click(within(second).getByRole('button', { name: '儲存連線設定' }));
    expect(within(second).getByRole('alert')).toHaveTextContent('已有另一個啟用自動入帳的連線');
    expect(api.configure).not.toHaveBeenCalled();
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it('can revoke a credential during a financial lock while financial edits stay disabled', async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} locked />);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '停用此連線' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '儲存連線設定' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '停用此連線' }));
    expect(api.revoke).toHaveBeenCalledWith('owner-a', connection.id);
    expect(await screen.findByText('已停用', { selector: 'span' })).toBeInTheDocument();
  });

  it('reports a committed cloud import separately when refreshing the local ledger fails', async () => {
    const onSync = vi.fn(async () => { throw new Error('private sync details'); });
    const { user, data } = await openInbox(makeApi(), onSync);
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find((row) => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    expect(await screen.findByText(/此筆已在雲端入帳；本機帳本尚未更新/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確認入帳' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private sync details');
  });

  it('syncs imported notifications discovered by refresh once and coalesces repeated refreshes', async () => {
    const imported = { ...notice, status: 'imported' as const, transaction_id: 'transaction-refresh' };
    const api = makeApi([], [imported]);
    const onSync = successfulSync('transaction-refresh');
    const { user } = await openInbox(api, onSync);
    expect(onSync).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(api.listPending).toHaveBeenCalled();
  });

  it('retries after partial or skipped sync outcomes and only suppresses a confirmed import', async () => {
    const imported = { ...notice, status: 'imported' as const, transaction_id: 'transaction-retry' };
    const api = makeApi([], [imported]);
    const onSync = vi.fn()
      .mockResolvedValueOnce({ status: 'partial', confirmedTransactionIds: ['transaction-retry'] })
      .mockResolvedValueOnce({ status: 'skipped', confirmedTransactionIds: [] })
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: [] })
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: ['transaction-retry'] });
    const { user } = await openInbox(api, onSync);
    expect(onSync).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(4);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(4);
  });

  it('keeps imported recent results and exposes older pending items with a server exact count', async () => {
    const recentImported = { ...notice, id: 'recent-import', status: 'imported' as const, transaction_id: 'tx-recent' };
    const oldPending = { ...notice, id: 'old-pending', merchant: 'Old pending service' };
    const api = makeApi([], [recentImported]);
    api.listPending.mockResolvedValueOnce({ items: [oldPending], pending_count: 127, has_more: true,
      next_created_at: oldPending.created_at, next_id: oldPending.id }).mockResolvedValueOnce({
      items: [{ ...oldPending, id: 'older-pending', merchant: 'Older service' }], pending_count: 127, has_more: false,
      next_created_at: null, next_id: null,
    });
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await user.click(screen.getByRole('button', { name: /通知收件匣/ }));
    expect(await screen.findByText('Example Services', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /通知收件匣 \(127\)/ })).toBeInTheDocument();
    expect(screen.getByText('Old pending service', { selector: 'h3' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '載入更多待確認項目' }));
    expect(screen.getByText('Older service', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Example Services', { selector: 'h3' })).toBeInTheDocument();
  });

  it('does not sync an old owner after their in-flight approval completes', async () => {
    const pending = deferred<{ status: 'imported'; transaction_id: string }>();
    const api = makeApi();
    api.review.mockImplementation(() => pending.promise);
    const { user, data, view, onSync } = await openInbox(api);
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find((row) => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    view.rerender(<ShortcutsPanel ownerId="guest" data={createInitialState('guest').data} api={api} onSync={onSync} />);
    await act(async () => pending.resolve({ status: 'imported', transaction_id: 'transaction-a' }));
    expect(onSync).not.toHaveBeenCalled();
    expect(screen.queryByText(/此筆已在雲端入帳/)).not.toBeInTheDocument();
  });
});
