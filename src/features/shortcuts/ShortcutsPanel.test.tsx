// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../app/state';
import { calculateFinancials } from '../../domain/financeEngine';
import type { FinanceSyncOutcome } from '../../app/useFinanceApp';
import type { ShortcutApi, ShortcutConnection, ShortcutInboxItem } from './types';
import { ShortcutsPanel, type ShortcutsPanelProps } from './ShortcutsPanel';

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
      has_more: false, next_created_at: null as string | null, next_id: null as string | null })),
    create: vi.fn(async (_ownerId: string, _label: string, _tokenHash: string) => connection),
    revoke: vi.fn(async () => undefined),
    configure: vi.fn(async () => connection),
    review: vi.fn(async () => ({ status: 'imported' as const, transaction_id: 'transaction-a' })),
  } satisfies ShortcutApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
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

  it('provides an accessible, expandable setup guide with lifecycle and troubleshooting details', async () => {
    const api = makeApi([], []);
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    const guide = screen.getByText('展開完整教學與錯誤處理').closest('details');
    expect(guide).toBeInTheDocument();
    expect(guide).not.toHaveAttribute('open');
    await user.click(screen.getByText('展開完整教學與錯誤處理'));
    expect(guide).toHaveAttribute('open');
    expect(guide).toHaveTextContent('完成保存前，請留在本頁');
    expect(guide).toHaveTextContent('既有金鑰沒有閒置到期設定');
    expect(guide).toHaveTextContent('429');
    expect(guide).toHaveTextContent('503');
    expect(guide).toHaveTextContent('401');
    expect(guide).toHaveTextContent('100 筆累積連線紀錄');
    expect(guide).toHaveTextContent('尚未在 iPhone 真機驗證');
    expect(screen.getByText('展開完整教學與錯誤處理').closest('summary')?.tagName).toBe('SUMMARY');
  });

  it('teaches trigger fields in the same shortcut and starts with synthetic tests', () => {
    render(<ShortcutsPanel ownerId="guest" data={createInitialState('guest').data} api={makeApi()} onSync={successfulSync()} />);
    const steps = screen.getByText('2. 在 iPhone 建立通知自動化').parentElement!;
    expect(steps).toHaveTextContent('同一捷徑');
    expect(steps).toHaveTextContent('Notification.Title');
    expect(steps).toHaveTextContent('Notification.Subtitle');
    expect(steps).toHaveTextContent('Notification.Body');
    expect(steps).toHaveTextContent('不要假設「Shortcut Input／捷徑輸入」有通知內容');
    expect(steps).toHaveTextContent('只有一欄有值就使用該欄');
    expect(steps).toHaveTextContent('不要再加入 Title');
    expect(steps).toHaveTextContent('先使用下方合成範本');
    expect(steps).toHaveTextContent('通知時間或目前時間不能代替交易日期');
    expect(steps).toHaveTextContent('省略 eventId，保持待確認；不要產生 UUID');
    expect(screen.getByRole('link', { name: 'Spenvo 通知設定說明' })).toHaveAttribute('href', 'https://spenvo.app/setup/');
  });

  it('does not replace the revocation warning with a late key-copy completion', async () => {
    const api = makeApi([], []);
    const user = userEvent.setup();
    const writing = deferred<void>();
    const writeText = vi.fn(() => writing.promise);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    await screen.findByLabelText('一次性顯示的捷徑金鑰');
    await user.click(screen.getByRole('button', { name: '複製 Authorization' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    api.listConnections.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await screen.findByText(/已清除畫面中的金鑰/);
    await act(async () => writing.resolve());
    expect(screen.getByRole('status')).toHaveTextContent('已清除畫面中的金鑰');
    expect(screen.queryByText(/^Authorization 標頭已複製/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '連接 iPhone' }));
    expect(screen.queryByRole('button', { name: '複製 Authorization' })).not.toBeInTheDocument();
  });

  it('keeps an undisplayed create key and retry action when the setup guide is collapsed again', async () => {
    const api = makeApi([], []);
    api.create.mockRejectedValueOnce(new Error('simulated offline'));
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await user.click(screen.getByText('展開完整教學與錯誤處理'));
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    await screen.findByText(/^連線結果尚未確認。/);
    const hash = api.create.mock.calls[0][2];
    await user.click(screen.getByText('展開完整教學與錯誤處理'));
    expect(screen.getByRole('button', { name: '以相同金鑰重試' })).toBeInTheDocument();
    expect(api.create.mock.calls[0][2]).toBe(hash);
    expect(screen.queryByLabelText('一次性顯示的捷徑金鑰')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '以相同金鑰重試' }));
    expect(await screen.findByLabelText('一次性顯示的捷徑金鑰')).toBeInTheDocument();
  });

  it('keeps the one-time key when leaving and returning to setup within the same panel', async () => {
    const api = makeApi([], []);
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    const field = await screen.findByLabelText('一次性顯示的捷徑金鑰');
    const createdToken = (field as HTMLTextAreaElement).value;
    await user.click(screen.getByRole('button', { name: '通知測試' }));
    await user.click(screen.getByRole('button', { name: '連接 iPhone' }));
    expect((screen.getByLabelText('一次性顯示的捷徑金鑰') as HTMLTextAreaElement).value).toBe(createdToken);
    expect(api.create).toHaveBeenCalledTimes(1);
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

  it.each(['revoked', 'missing'])('clears the displayed key and copy action after a complete %s refresh', async (state) => {
    const api = makeApi([], []);
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    await screen.findByLabelText('一次性顯示的捷徑金鑰');
    api.listConnections.mockResolvedValue(state === 'revoked' ? [{ ...connection, revoked_at: '2026-10-11T00:00:00.000Z' }] : []);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新整理' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '連接 iPhone' }));
    expect(screen.queryByLabelText('一次性顯示的捷徑金鑰')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '複製 Authorization' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已清除畫面中的金鑰');
    expect(screen.queryByText(/^連線已建立。/)).not.toBeInTheDocument();
    expect(api.revoke).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'connections failure', 'inbox failure', 'pending failure'])('retains the displayed key on %s refresh', async (state) => {
    const api = makeApi([], []);
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    const shownValue = (await screen.findByLabelText('一次性顯示的捷徑金鑰') as HTMLTextAreaElement).value;
    api.listConnections.mockResolvedValue(state === 'active' ? [connection] : []);
    if (state === 'connections failure') api.listConnections.mockRejectedValueOnce(new Error('synthetic network failure'));
    if (state === 'inbox failure') api.listInbox.mockRejectedValueOnce(new Error('synthetic network failure'));
    if (state === 'pending failure') api.listPending.mockRejectedValueOnce(new Error('synthetic network failure'));
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新整理' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '連接 iPhone' }));
    expect((screen.getByLabelText('一次性顯示的捷徑金鑰') as HTMLTextAreaElement).value).toBe(shownValue);
    expect(screen.getByRole('button', { name: '複製 Authorization' })).toBeInTheDocument();
    expect(api.revoke).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('retries an uncertain create with the same in-memory token hash', async () => {
    const api = makeApi([], []);
    api.create.mockRejectedValueOnce(new Error('simulated network interruption'));
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    await screen.findByText(/^連線結果尚未確認。/);
    const firstHash = api.create.mock.calls[0][2];
    expect(screen.queryByLabelText('一次性顯示的捷徑金鑰')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    await user.click(screen.getByRole('button', { name: '以相同金鑰重試' }));
    const field = await screen.findByLabelText('一次性顯示的捷徑金鑰');
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[1][2]).toBe(firstHash);
    expect((field as HTMLTextAreaElement).value).toMatch(/^shiba_sc_[a-f0-9]{64}$/);
    expect(localStorage.length).toBe(0);
  });

  it('does not show a usable secret when an idempotent retry returns a revoked connection', async () => {
    const api = makeApi([], []);
    api.create.mockRejectedValueOnce(new Error('simulated lost response'));
    api.create.mockResolvedValueOnce({ ...connection, revoked_at: '2026-10-08T12:00:00.000Z' });
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    await screen.findByText(/^連線結果尚未確認。/);
    await user.click(screen.getByRole('button', { name: '以相同金鑰重試' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('這組金鑰所屬的連線已停用');
    expect(screen.queryByLabelText('一次性顯示的捷徑金鑰')).not.toBeInTheDocument();
  });

  it('replaces a refreshed connection row on a successful idempotent retry', async () => {
    const api = makeApi([], []);
    api.create.mockRejectedValueOnce(new Error('simulated lost response'));
    api.listConnections.mockResolvedValueOnce([]).mockResolvedValueOnce([connection]);
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={successfulSync()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '建立連線與金鑰' }));
    await screen.findByText(/^連線結果尚未確認。/);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(await screen.findByText('測試手機', { selector: 'h3' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '連接 iPhone' }));
    await user.click(screen.getByRole('button', { name: '以相同金鑰重試' }));
    await screen.findByLabelText('一次性顯示的捷徑金鑰');
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    expect(screen.getAllByText('測試手機', { selector: 'h3' })).toHaveLength(1);
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
    const api = makeApi();
    const { user, data } = await openInbox(api, onSync);
    api.listInbox.mockResolvedValue([{ ...notice, status: 'imported', transaction_id: 'transaction-a' }]);
    api.listPending.mockResolvedValue({ items: [], pending_count: 0, has_more: false, next_created_at: null, next_id: null });
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find((row) => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    expect(await screen.findByText(/此筆已在雲端入帳；本機帳本尚未更新/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確認入帳' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private sync details');
  });

  it.each(['throws', 'unconfirmed'] as const)('reconciles corrected committed review fields after a %s ledger pull, then retries only the ledger', async (failure) => {
    const api = makeApi();
    const corrected: ShortcutInboxItem = { ...notice, amount: 876.5, merchant: 'Synthetic Corrected Merchant',
      occurred_at: '2026-01-03T09:30:00', status: 'imported', transaction_id: 'transaction-a' };
    api.review.mockImplementationOnce(async () => {
      api.listInbox.mockResolvedValue([corrected]);
      api.listPending.mockResolvedValue({ items: [], pending_count: 0, has_more: false, next_created_at: null, next_id: null });
      return { status: 'imported', transaction_id: 'transaction-a' };
    });
    const onSync = vi.fn<ShortcutsPanelProps['onSync']>().mockImplementationOnce(async () => {
      if (failure === 'throws') throw new Error('synthetic private sync detail');
      return { status: 'synced', confirmedTransactionIds: [] };
    }).mockResolvedValue({ status: 'synced', confirmedTransactionIds: ['transaction-a'] });
    const { user, data } = await openInbox(api, onSync);
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find(row => row.kind === 'expense')!.id);
    fireEvent.change(screen.getByLabelText('確認支出金額（TWD）'), { target: { value: '876.5' } });
    fireEvent.change(screen.getByLabelText('商家／用途'), { target: { value: corrected.merchant } });
    fireEvent.change(screen.getByLabelText('消費時間（本機時區）'), { target: { value: '2026-01-03T09:30' } });
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    expect(await screen.findByText(corrected.merchant, { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('NT$876.5')).toBeInTheDocument();
    expect(screen.getByText(/1\/3.*09:30/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通知收件匣' })).toBeInTheDocument();
    expect(screen.queryByText('Example Services', { selector: 'h3' })).not.toBeInTheDocument();
    expect(screen.getByText(/此筆已在雲端入帳；本機帳本尚未更新/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('synthetic private sync detail');
    expect(onSync).toHaveBeenCalledExactlyOnceWith(['transaction-a']);
    expect(api.listInbox).toHaveBeenCalledTimes(2);
    expect(api.listConnections).toHaveBeenCalledTimes(2);
    expect(api.listPending).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(onSync).toHaveBeenCalledTimes(2));
    expect(onSync).toHaveBeenLastCalledWith(['transaction-a']);
    expect(api.review).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/本機帳本尚未更新/)).not.toBeInTheDocument();
  });

  it('reconciles a newly verified connection after an unchanged approval with an unconfirmed ledger', async () => {
    const eligible = { ...notice, reason: 'manual_review', payload: { title: '合成來源 ID 通知', text: 'Synthetic stable-ID payment' } };
    const api = makeApi([connection], [eligible]);
    api.review.mockImplementationOnce(async () => {
      api.listInbox.mockResolvedValue([{ ...eligible, status: 'imported', transaction_id: 'transaction-a' }]);
      api.listPending.mockResolvedValue({ items: [], pending_count: 0, has_more: false, next_created_at: null, next_id: null });
      api.listConnections.mockResolvedValue([{ ...connection, verified_at: '2026-01-03T09:31:00Z', verified_format: 'synthetic-format-v1' }]);
      return { status: 'imported', transaction_id: 'transaction-a' };
    });
    const onSync = vi.fn(async (): Promise<FinanceSyncOutcome> => ({ status: 'partial', confirmedTransactionIds: ['transaction-a'] }));
    const { user, data } = await openInbox(api, onSync);
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find(row => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    await waitFor(() => expect(api.listConnections).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/此筆已在雲端入帳；本機帳本尚未更新/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    expect(screen.getByText(/你已核對含來源 ID 的相容通知/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '相容通知自動入帳' })).toBeEnabled();
    expect(api.review).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledExactlyOnceWith(['transaction-a']);
  });

  it.each(['failed', 'confirmed'] as const)('retains the cloud commit and reports a failed state refresh after a %s ledger pull', async (ledger) => {
    const api = makeApi();
    const onSync = vi.fn<ShortcutsPanelProps['onSync']>().mockImplementationOnce(async () => {
      if (ledger === 'failed') throw new Error('synthetic private ledger detail');
      return { status: 'synced', confirmedTransactionIds: ['transaction-a'] };
    }).mockResolvedValue({ status: 'synced', confirmedTransactionIds: ['transaction-a'] });
    const { user, data } = await openInbox(api, onSync);
    api.review.mockImplementationOnce(async () => {
      api.listConnections.mockRejectedValueOnce(new Error('synthetic private refresh detail'));
      api.listInbox.mockResolvedValue([{ ...notice, status: 'imported', transaction_id: 'transaction-a' }]);
      api.listPending.mockResolvedValue({ items: [], pending_count: 0, has_more: false, next_created_at: null, next_id: null });
      return { status: 'imported', transaction_id: 'transaction-a' };
    });
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find(row => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    expect(await screen.findByText(/通知與連線狀態.*尚未更新/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確認入帳' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('synthetic private');
    if (ledger === 'failed') expect(screen.getByText(/本機帳本尚未更新/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(onSync).toHaveBeenCalledTimes(2));
    expect(onSync).toHaveBeenLastCalledWith(ledger === 'failed' ? ['transaction-a'] : []);
    expect(api.review).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/通知與連線狀態.*尚未更新/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通知收件匣' })).toBeInTheDocument();
  });

  it('does not refresh an old owner after their committed review ledger pull finishes', async () => {
    const api = makeApi();
    const pending = deferred<FinanceSyncOutcome>();
    const onSync = vi.fn(() => pending.promise);
    const { user, data, view } = await openInbox(api, onSync);
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find(row => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    await waitFor(() => expect(onSync).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => pending.resolve({ status: 'synced', confirmedTransactionIds: ['transaction-a'] }));
    expect(api.listInbox).toHaveBeenCalledTimes(1);
    expect(api.listConnections).toHaveBeenCalledTimes(1);
    expect(api.listPending).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('preserves a committed import warning when an earlier clipboard operation %s', async (outcome) => {
    const api = makeApi();
    api.review.mockImplementationOnce(async () => {
      api.listInbox.mockResolvedValue([{ ...notice, status: 'imported', transaction_id: 'transaction-a' }]);
      api.listPending.mockResolvedValue({ items: [], pending_count: 0, has_more: false, next_created_at: null, next_id: null });
      return { status: 'imported', transaction_id: 'transaction-a' };
    });
    const onSync = vi.fn(async () => { throw new Error('synthetic ledger failure'); });
    const { user, data } = await openInbox(api, onSync);
    const writing = deferred<void>();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => writing.promise) }, configurable: true });
    await user.click(screen.getByRole('button', { name: '連接 iPhone' }));
    await user.click(screen.getByRole('button', { name: '複製測試 JSON' }));
    await user.click(screen.getByRole('button', { name: /通知收件匣/ }));
    await user.selectOptions(screen.getByLabelText('扣款帳戶'), data.accounts[0].id);
    await user.selectOptions(screen.getByLabelText('支出分類'), data.categories.find(row => row.kind === 'expense')!.id);
    await user.click(screen.getByRole('button', { name: '確認入帳' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('本機帳本尚未更新');
    await waitFor(() => expect(api.listConnections).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (outcome === 'resolve') writing.resolve();
      else writing.reject(new Error('synthetic clipboard failure'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('本機帳本尚未更新');
    expect(api.review).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('clears only its own clipboard error after a successful copy retry', async () => {
    const { user } = await openInbox();
    const writeText = vi.fn().mockRejectedValueOnce(new Error('synthetic clipboard failure')).mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: '連接 iPhone' }));
    await user.click(screen.getByRole('button', { name: '複製測試 JSON' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('無法自動複製');
    await user.click(screen.getByRole('button', { name: '複製測試 JSON' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('合成測試 JSON 已複製');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('explicitly pulls an older cloud import outside the newest 100 notifications and updates the ledger', async () => {
    const data = createInitialState('owner-a').data;
    const recent = Array.from({ length: 100 }, (_, index): ShortcutInboxItem => ({
      ...notice, id: `newer-${index}`, status: index % 3 === 0 ? 'pending' : index % 3 === 1 ? 'test' : 'ignored',
      merchant: `Newer notification ${index}`, transaction_id: null,
    }));
    const api = makeApi([], recent);
    const oldTransaction = { ...data.transactions[0], id: 'older-cloud-import', accountId: data.accounts[0].id, amount: 125.5 };
    const initialBalance = calculateFinancials(data).accountBalances.find((row) => row.accountId === oldTransaction.accountId)!.balance;
    const onSync = vi.fn<ShortcutsPanelProps['onSync']>();
    function LedgerFixture() {
      const [ledger, setLedger] = useState(data);
      onSync.mockImplementation(async () => {
        setLedger({ ...data, transactions: [...data.transactions, oldTransaction] });
        return { status: 'synced', confirmedTransactionIds: [] };
      });
      return <><output aria-label="合成帳本支出">{ledger.transactions.filter((row) => row.id === oldTransaction.id).reduce((total, row) => total + row.amount, 0)}</output>
        <output aria-label="合成帳戶餘額">{calculateFinancials(ledger).accountBalances.find((row) => row.accountId === oldTransaction.accountId)!.balance}</output>
        <ShortcutsPanel ownerId="owner-a" data={ledger} api={api} onSync={onSync} /></>;
    }
    const user = userEvent.setup();
    render(<LedgerFixture />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    expect(onSync).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /通知收件匣/ }));
    expect(screen.getByLabelText('合成帳本支出')).toHaveTextContent('0');
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByLabelText('合成帳本支出')).toHaveTextContent('125.5'));
    expect(onSync).toHaveBeenCalledExactlyOnceWith([]);
    expect(screen.getByLabelText('合成帳戶餘額')).toHaveTextContent(String(initialBalance - oldTransaction.amount));
    expect(api.review).not.toHaveBeenCalled();
    expect(api.listInbox).toHaveBeenCalledTimes(2);
    expect(recent).toHaveLength(100);
  });

  it('syncs imported notifications discovered by refresh once and coalesces repeated refreshes', async () => {
    const imported = { ...notice, status: 'imported' as const, transaction_id: 'transaction-refresh' };
    const api = makeApi([], [imported]);
    const onSync = successfulSync('transaction-refresh');
    const { user } = await openInbox(api, onSync);
    expect(onSync).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(onSync).toHaveBeenLastCalledWith([]);
    expect(api.listPending).toHaveBeenCalled();
  });

  it.each(['partial', 'skipped', 'uncommitted'] as const)('keeps an explicit empty-ID %s outcome retryable', async (status) => {
    const api = makeApi([], []);
    const onSync = vi.fn().mockResolvedValueOnce({ status, confirmedTransactionIds: [] })
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: [] });
    const user = userEvent.setup();
    render(<ShortcutsPanel ownerId="owner-a" data={createInitialState('owner-a').data} api={api} onSync={onSync} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '連線管理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(await screen.findByText(/操作結果尚未確認/)).toBeInTheDocument();
    expect(onSync).toHaveBeenCalledExactlyOnceWith([]);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.queryByText(/操作結果尚未確認/)).not.toBeInTheDocument());
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(onSync).toHaveBeenLastCalledWith([]);
  });

  it('awaits a queued explicit refresh, coalesces clicks and does not start a render sync loop', async () => {
    const api = makeApi();
    const queued = deferred<FinanceSyncOutcome>();
    const onSync = vi.fn(() => queued.promise);
    const { data, user, view } = await openInbox(api, onSync);
    const refresh = screen.getByRole('button', { name: '重新整理' });
    await user.click(refresh);
    await waitFor(() => expect(onSync).toHaveBeenCalledExactlyOnceWith([]));
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh); fireEvent.click(refresh);
    expect(onSync).toHaveBeenCalledTimes(1);
    view.rerender(<ShortcutsPanel ownerId="owner-a" data={{ ...data, transactions: [...data.transactions] }} api={api} onSync={onSync} />);
    expect(api.listInbox).toHaveBeenCalledTimes(2);
    await act(async () => queued.resolve({ status: 'synced', confirmedTransactionIds: [] }));
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(api.listInbox).toHaveBeenCalledTimes(2);
  });

  it('does not start an old owner ledger pull after their explicit inbox refresh completes', async () => {
    const api = makeApi();
    const pending = deferred<ShortcutInboxItem[]>();
    const onSync = successfulSync();
    const { user, view } = await openInbox(api, onSync);
    api.listInbox.mockImplementationOnce(() => pending.promise);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    view.rerender(<ShortcutsPanel ownerId="owner-b" data={createInitialState('owner-b').data} api={api} onSync={onSync} />);
    await act(async () => pending.resolve([{ ...notice, status: 'imported', transaction_id: 'old-owner-tx' }]));
    await waitFor(() => expect(screen.getByRole('button', { name: '建立連線與金鑰' })).toBeEnabled());
    expect(onSync).not.toHaveBeenCalled();
  });

  it('keeps an explicit rejected ledger pull retryable without exposing private error details', async () => {
    const api = makeApi();
    const onSync = vi.fn().mockRejectedValueOnce(new Error('synthetic private failure detail'))
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: [] });
    const { user } = await openInbox(api, onSync);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(await screen.findByText(/操作結果尚未確認/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('synthetic private failure detail');
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(onSync).toHaveBeenLastCalledWith([]);
  });

  it('retains only confirmed imported IDs while retrying the remaining subset', async () => {
    const imports = ['one', 'two'].map((id) => ({ ...notice, id, merchant: id === 'one' ? notice.merchant : 'Second service',
      status: 'imported' as const, transaction_id: `tx-${id}` }));
    const api = makeApi([], imports);
    const onSync = vi.fn().mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: ['tx-one'] })
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: ['tx-two'] });
    const { user } = await openInbox(api, onSync);
    expect(onSync).toHaveBeenCalledExactlyOnceWith(['tx-one', 'tx-two']);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenLastCalledWith(['tx-two']);
    expect(api.review).not.toHaveBeenCalled();
  });

  it('retries after partial or skipped sync outcomes and only suppresses a confirmed import', async () => {
    const imported = { ...notice, status: 'imported' as const, transaction_id: 'transaction-retry' };
    const api = makeApi([], [imported]);
    const onSync = vi.fn()
      .mockResolvedValueOnce({ status: 'partial', confirmedTransactionIds: ['transaction-retry'] })
      .mockResolvedValueOnce({ status: 'skipped', confirmedTransactionIds: [] })
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: [] })
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: ['transaction-retry'] })
      .mockResolvedValueOnce({ status: 'synced', confirmedTransactionIds: [] });
    const { user } = await openInbox(api, onSync);
    expect(onSync).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(4);
    expect(onSync).toHaveBeenLastCalledWith(['transaction-retry']);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    expect(onSync).toHaveBeenCalledTimes(5);
    expect(onSync).toHaveBeenLastCalledWith([]);
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
