// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../app/state';
import type { AssetAccount, FinanceData, Transfer } from '../domain/model';
import { HomeView } from './HomeView';

function dataWithTwoAccounts(): FinanceData {
  const data = createInitialState('guest').data;
  const first = data.accounts[0];
  data.accounts.push({
    ...first,
    id: 'account-bank',
    name: '很長的主要日常轉帳銀行帳戶',
    openingBalance: 2_000,
    sortOrder: 1,
    lastOperationId: 'account-bank-create',
  });
  return data;
}

function transferFor(data: FinanceData): Transfer {
  return {
    id: 'transfer-ui',
    ownerId: 'guest',
    amount: 500,
    sourceAccountId: data.accounts[0].id,
    sourceAccountName: data.accounts[0].name,
    destinationAccountId: data.accounts[1].id,
    destinationAccountName: data.accounts[1].name,
    occurredAt: '2026-08-28 09:30',
    note: '測試轉帳',
    version: 1,
    updatedAt: '2026-08-28T01:30:00.000Z',
    lastOperationId: 'transfer-ui-create',
  };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomeView transfer interactions', () => {
  it('requires two accounts, hides categories, and never silently chooses endpoints', async () => {
    const user = userEvent.setup();
    const data = createInitialState('guest').data;
    render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);

    await user.click(screen.getByRole('button', { name: '記轉帳' }));

    expect(screen.queryByText('選擇分類')).not.toBeInTheDocument();
    expect(screen.getByText('至少需要兩個可用的資產帳戶才能建立轉帳。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '記下這筆轉帳' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '交換來源與目的帳戶' })).toBeInTheDocument();
  });

  it('supports explicit source/destination selection, one-tap swap, and clears stale selections on mode round trips', async () => {
    const user = userEvent.setup();
    const data = dataWithTwoAccounts();
    const put = vi.fn(() => true);
    render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);

    await user.click(screen.getByRole('button', { name: '記轉帳' }));
    const source = screen.getByRole('group', { name: '從哪個資產帳戶轉出？' });
    const destination = screen.getByRole('group', { name: '要轉入哪個資產帳戶？' });
    await user.click(within(source).getByRole('button', { name: data.accounts[0].name }));
    await user.click(within(destination).getByRole('button', { name: data.accounts[1].name }));
    await user.click(screen.getByRole('button', { name: '交換來源與目的帳戶' }));
    expect(within(source).getByRole('button', { name: data.accounts[1].name })).toHaveAttribute('aria-pressed', 'true');
    expect(within(destination).getByRole('button', { name: data.accounts[0].name })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '記支出' }));
    await user.click(screen.getByRole('button', { name: '記轉帳' }));
    expect(screen.getByRole('button', { name: '記下這筆轉帳' })).toBeDisabled();
    const reopenedSource = screen.getByRole('group', { name: '從哪個資產帳戶轉出？' });
    const reopenedDestination = screen.getByRole('group', { name: '要轉入哪個資產帳戶？' });
    expect(within(reopenedSource).getAllByRole('button').every(
      (button) => button.getAttribute('aria-pressed') === 'false',
    )).toBe(true);
    expect(within(reopenedDestination).getAllByRole('button').every(
      (button) => button.getAttribute('aria-pressed') === 'false',
    )).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it('fails closed when an endpoint changes after the transfer editor opens', async () => {
    const user = userEvent.setup();
    const data = dataWithTwoAccounts();
    const existing = transferFor(data);
    data.transfers = [existing];
    const put = vi.fn(() => true);
    const view = render(
      <HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />,
    );
    await user.click(screen.getByRole('button', { name: /編輯轉帳/ }));

    const changedAccount: AssetAccount = {
      ...data.accounts[0],
      includeInTotalAssets: !data.accounts[0].includeInTotalAssets,
      version: data.accounts[0].version + 1,
      updatedAt: '2026-08-28T02:00:00.000Z',
      lastOperationId: 'account-background-edit',
    };
    view.rerender(
      <HomeView
        data={{ ...data, accounts: [changedAccount, data.accounts[1]] }}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
      />,
    );
    await user.click(screen.getByRole('button', { name: '儲存轉帳修改' }));

    expect(screen.getByRole('alert')).toHaveTextContent('來源帳戶已在背景更新');
    expect(put).not.toHaveBeenCalled();
  });

  it('finds a transfer by note and performs explicit edit/delete actions', async () => {
    const user = userEvent.setup();
    const data = dataWithTwoAccounts();
    const existing = transferFor(data);
    data.transfers = [existing];
    const deleteTransfer = vi.fn(() => true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
    render(
      <HomeView
        data={data}
        ownerId="guest"
        put={() => true}
        deleteTransaction={() => true}
        deleteTransfer={deleteTransfer}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: '搜尋帳本' }), existing.note!);
    expect(screen.getByTestId('transfer-row')).toHaveTextContent(existing.note!);
    await user.click(screen.getByRole('button', { name: /編輯轉帳/ }));
    expect(screen.getByRole('button', { name: '儲存轉帳修改' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: /刪除轉帳/ }));
    expect(deleteTransfer).toHaveBeenCalledWith(existing);
  });

  it('offers an explicit reconfirmation path for a pending transfer dependency conflict', async () => {
    const user = userEvent.setup();
    const data = dataWithTwoAccounts();
    const existing = transferFor(data);
    data.transfers = [existing];
    const confirmTransferAccounts = vi.fn(() => true);
    render(
      <HomeView
        data={data}
        ownerId="guest"
        put={() => true}
        deleteTransaction={() => true}
        unresolvedSyncRecordKeys={new Set(['transfers:transfer-ui'])}
        transferDependencyConflictIds={new Set(['transfer-ui'])}
        confirmTransferAccounts={confirmTransferAccounts}
      />,
    );

    expect(screen.queryByRole('button', { name: '使用雲端版本' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新選擇並確認' }));
    await user.click(screen.getByRole('button', { name: '儲存轉帳修改' }));

    expect(confirmTransferAccounts).toHaveBeenCalledWith(expect.objectContaining({
      id: existing.id,
      sourceAccountName: data.accounts[0].name,
      destinationAccountName: data.accounts[1].name,
      version: 2,
    }));
    expect(screen.getByText(/已重新確認轉帳/)).toBeInTheDocument();
  });
});
