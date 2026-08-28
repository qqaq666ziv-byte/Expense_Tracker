// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../app/state';
import { TUTORIAL_RECORD_NOTE, startTutorial } from '../app/tutorial';
import type { AssetAccount, FinanceData, Transaction, Transfer } from '../domain/model';
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

function dataWithQuickHistory(): FinanceData {
  const data = dataWithTwoAccounts();
  const category = data.categories.find((item) => item.kind === 'expense')!;
  const makeTransaction = (id: string, occurredAt: string): Transaction => ({
    id,
    ownerId: 'guest',
    version: 1,
    updatedAt: `${occurredAt}Z`,
    lastOperationId: `${id}-create`,
    amount: 60,
    type: 'expense',
    categoryId: category.id,
    categoryName: category.name,
    accountId: data.accounts[0].id,
    accountName: data.accounts[0].name,
    occurredAt,
    note: '滷肉飯',
  });
  data.transactions = [
    makeTransaction('meal-1', '2026-08-27T12:00:00.000'),
    makeTransaction('meal-2', '2026-08-28T12:00:00.000'),
  ];
  return data;
}

function dataWithQuickHistoryForOwner(ownerId: string): FinanceData {
  const data = createInitialState(ownerId).data;
  const category = data.categories.find((item) => item.kind === 'expense')!;
  const account = data.accounts[0];
  data.transactions = [1, 2].map((index) => ({
    id: `${ownerId}-meal-${index}`,
    ownerId,
    version: 1,
    updatedAt: `2026-08-2${6 + index}T12:00:00.000Z`,
    lastOperationId: `${ownerId}-meal-${index}-create`,
    amount: 60,
    type: 'expense',
    categoryId: category.id,
    categoryName: category.name,
    accountId: account.id,
    accountName: account.name,
    occurredAt: `2026-08-2${6 + index}T12:00:00.000`,
    note: '滷肉飯',
  }));
  return data;
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
  it('keeps historical transfers visible while disabling create, edit, and delete in emergency mode', () => {
    const data = dataWithTwoAccounts();
    const historical = transferFor(data);
    data.accounts[0] = { ...data.accounts[0], isActive: false };
    data.transfers = [historical];

    render(
      <HomeView
        data={data}
        ownerId="guest"
        put={() => true}
        deleteTransaction={() => true}
        deleteTransfer={() => true}
        transferMutationsEnabled={false}
      />,
    );

    expect(screen.getByTestId('transfer-row')).toHaveTextContent('測試轉帳');
    expect(screen.getByTestId('transfer-row')).toHaveTextContent('現金 轉至 很長的主要日常轉帳銀行帳戶');
    expect(screen.getByRole('button', { name: '記轉帳' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /編輯轉帳/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /刪除轉帳/ })).toBeDisabled();
  });

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

  it('keeps a soft-deleted unchanged endpoint when reconfirming a transfer dependency', async () => {
    const user = userEvent.setup();
    const data = dataWithTwoAccounts();
    const existing = {
      ...transferFor(data),
      sourceAccountName: '建立轉帳時的銀行名稱',
    };
    data.accounts[0] = {
      ...data.accounts[0],
      name: '封存後的銀行名稱',
      isActive: false,
      deletedAt: '2026-08-28T02:30:00.000Z',
      version: data.accounts[0].version + 1,
      lastOperationId: 'account-archived',
    };
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

    await user.click(screen.getByRole('button', { name: '重新選擇並確認' }));
    expect(screen.getByRole('button', { name: '儲存轉帳修改' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '儲存轉帳修改' }));

    expect(confirmTransferAccounts).toHaveBeenCalledWith(expect.objectContaining({
      id: existing.id,
      sourceAccountId: existing.sourceAccountId,
      sourceAccountName: existing.sourceAccountName,
      destinationAccountId: existing.destinationAccountId,
    }));
    expect(screen.getByText(/已重新確認轉帳/)).toBeInTheDocument();
  });
});

describe('HomeView smart quick entry interactions', () => {
  it('rejects a transaction edit when background sync advances its version and preserves the form', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    data.transactions = [data.transactions[0]];
    const put = vi.fn(() => true);
    const view = render(
      <HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />,
    );

    await user.click(screen.getAllByRole('button', { name: '編輯 餐飲' })[0]);
    const amount = screen.getByRole('textbox', { name: '金額' });
    await user.clear(amount);
    await user.type(amount, '77');

    const backgroundVersion = {
      ...data.transactions[0],
      amount: 65,
      version: 2,
      updatedAt: '2026-08-28T13:00:00.000Z',
      lastOperationId: 'meal-1-background-update',
    };
    view.rerender(
      <HomeView
        data={{ ...data, transactions: [backgroundVersion] }}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
      />,
    );
    await user.click(screen.getByRole('button', { name: '儲存修改' }));

    expect(screen.getByRole('alert')).toHaveTextContent('這筆交易已在背景更新');
    expect(amount).toHaveValue('77');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a transaction edit when background sync removes the current record', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    data.transactions = [data.transactions[0]];
    const put = vi.fn(() => true);
    const view = render(
      <HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />,
    );

    await user.click(screen.getByRole('button', { name: '編輯 餐飲' }));
    const note = screen.getByRole('textbox', { name: '備註' });
    await user.clear(note);
    await user.type(note, '使用者尚未儲存的內容');
    view.rerender(
      <HomeView
        data={{ ...data, transactions: [] }}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
      />,
    );
    await user.click(screen.getByRole('button', { name: '儲存修改' }));

    expect(screen.getByRole('alert')).toHaveTextContent('這筆交易已在背景更新、刪除');
    expect(note).toHaveValue('使用者尚未儲存的內容');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a transaction edit when background sync tombstones the record', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    data.transactions = [data.transactions[0]];
    const put = vi.fn(() => true);
    const view = render(
      <HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />,
    );

    await user.click(screen.getByRole('button', { name: '編輯 餐飲' }));
    const amount = screen.getByRole('textbox', { name: '金額' });
    await user.clear(amount);
    await user.type(amount, '91');
    view.rerender(
      <HomeView
        data={{
          ...data,
          transactions: [{
            ...data.transactions[0],
            version: 2,
            deletedAt: '2026-08-28T13:15:00.000Z',
            updatedAt: '2026-08-28T13:15:00.000Z',
            lastOperationId: 'meal-1-background-delete',
          }],
        }}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
      />,
    );
    await user.click(screen.getByRole('button', { name: '儲存修改' }));

    expect(screen.getByRole('alert')).toHaveTextContent('這筆交易已在背景更新、刪除');
    expect(amount).toHaveValue('91');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a transaction editor that gains an unresolved conflict after opening', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    data.transactions = [data.transactions[0]];
    const put = vi.fn(() => true);
    const view = render(
      <HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />,
    );

    await user.click(screen.getByRole('button', { name: '編輯 餐飲' }));
    const note = screen.getByRole('textbox', { name: '備註' });
    await user.clear(note);
    await user.type(note, '衝突期間保留的輸入');
    view.rerender(
      <HomeView
        data={data}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
        unresolvedSyncRecordKeys={new Set([`transactions:${data.transactions[0].id}`])}
      />,
    );
    fireEvent.submit(screen.getByRole('button', { name: '儲存修改' }).closest('form')!);

    expect(screen.getByRole('alert')).toHaveTextContent('發生同步衝突');
    expect(note).toHaveValue('衝突期間保留的輸入');
    expect(put).not.toHaveBeenCalled();
  });

  it('updates an unchanged transaction from the current record clock', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    data.transactions = [{
      ...data.transactions[0],
      version: 4,
      lastOperationId: 'meal-1-current-clock',
    }];
    const put = vi.fn(() => true);
    const view = render(
      <HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />,
    );

    await user.click(screen.getByRole('button', { name: '編輯 餐飲' }));
    const amount = screen.getByRole('textbox', { name: '金額' });
    await user.clear(amount);
    await user.type(amount, '88');
    view.rerender(
      <HomeView
        data={{ ...data, transactions: [{ ...data.transactions[0] }] }}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
      />,
    );
    await user.click(screen.getByRole('button', { name: '儲存修改' }));

    expect(put).toHaveBeenCalledWith('transactions', expect.objectContaining({
      id: data.transactions[0].id,
      ownerId: 'guest',
      amount: 88,
      version: 5,
    }));
  });

  it('preserves tutorial transaction markers and events for a valid unchanged edit', async () => {
    const user = userEvent.setup();
    const data = createInitialState('guest').data;
    const category = data.categories.find((item) => item.kind === 'expense')!;
    const tutorialRecord: Transaction = {
      id: 'tutorial-record',
      ownerId: 'guest',
      version: 1,
      updatedAt: '2026-08-28T14:00:00.000Z',
      lastOperationId: 'tutorial-record-create',
      amount: 100,
      type: 'expense',
      categoryId: category.id,
      categoryName: category.name,
      accountId: data.accounts[0].id,
      accountName: data.accounts[0].name,
      occurredAt: '2026-08-28T14:00:00.000',
      note: TUTORIAL_RECORD_NOTE,
    };
    data.transactions = [tutorialRecord];
    const put = vi.fn(() => true);
    const onTutorialEvent = vi.fn();
    render(
      <HomeView
        data={data}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
        tutorial={{ ...startTutorial('first-record'), step: 'locate', recordId: tutorialRecord.id }}
        onTutorialEvent={onTutorialEvent}
      />,
    );

    await user.click(screen.getByRole('button', { name: '編輯 餐飲' }));
    const amount = screen.getByRole('textbox', { name: '金額' });
    await user.clear(amount);
    await user.type(amount, '120');
    await user.click(screen.getByRole('button', { name: '儲存修改' }));

    expect(put).toHaveBeenCalledWith('transactions', expect.objectContaining({
      id: tutorialRecord.id,
      amount: 120,
      note: TUTORIAL_RECORD_NOTE,
      version: 2,
    }));
    expect(onTutorialEvent).toHaveBeenCalledWith({ type: 'edit-opened' });
    expect(onTutorialEvent).toHaveBeenCalledWith({ type: 'transaction-updated' });
  });

  it('discards every owner-derived entry state before another owner can observe or save it', async () => {
    const user = userEvent.setup();
    const ownerAData = dataWithQuickHistoryForOwner('owner-a');
    const ownerACategory = ownerAData.categories.find((item) => item.kind === 'expense')!;
    const ownerAAccount = ownerAData.accounts[0];
    const ownerBData = createInitialState('owner-b').data;
    const ownerBCategory = ownerBData.categories.find((item) => item.kind === 'expense')!;
    const ownerBAccount = ownerBData.accounts[0];
    const put = vi.fn(() => true);
    const view = render(
      <HomeView data={ownerAData} ownerId="owner-a" put={put} deleteTransaction={() => true} />,
    );

    await user.click(screen.getByRole('button', { name: '新增快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '新的快捷備註' }), 'A 的私人早餐');
    await user.click(screen.getByRole('button', { name: '加入快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '搜尋帳本' }), '滷肉');
    await user.click(screen.getByRole('button', { name: '再記一次 滷肉飯 NT$60' }));

    expect(screen.getByRole('textbox', { name: '金額' })).toHaveValue('60');
    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('滷肉飯');
    expect(screen.getByRole('button', { name: ownerACategory.name })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: ownerAAccount.name })).toHaveAttribute('aria-pressed', 'true');

    view.rerender(
      <HomeView data={ownerBData} ownerId="owner-b" put={put} deleteTransaction={() => true} />,
    );

    expect(screen.getByRole('textbox', { name: '金額' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '搜尋帳本' })).toHaveValue('');
    expect(screen.getByRole('heading', { name: '極速記帳' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '使用我的快捷 A 的私人早餐' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: ownerBCategory.name })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: ownerBAccount.name })).toHaveAttribute('aria-pressed', 'false');

    await user.type(screen.getByRole('textbox', { name: '金額' }), '25');
    await user.click(screen.getByRole('button', { name: ownerBCategory.name }));
    await user.click(screen.getByRole('button', { name: ownerBAccount.name }));
    await user.click(screen.getByText('補充時間或備註'));
    await user.type(screen.getByRole('textbox', { name: '備註' }), 'B 手動輸入');
    await user.click(screen.getByRole('button', { name: '記下這筆支出' }));

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('transactions', expect.objectContaining({
      ownerId: 'owner-b',
      amount: 25,
      note: 'B 手動輸入',
      categoryId: ownerBCategory.id,
      accountId: ownerBAccount.id,
    }));
    expect(put).not.toHaveBeenCalledWith('transactions', expect.objectContaining({
      amount: 60,
      note: '滷肉飯',
    }));

    view.rerender(
      <HomeView data={ownerAData} ownerId="owner-a" put={put} deleteTransaction={() => true} />,
    );
    await user.click(screen.getAllByRole('button', { name: `編輯 ${ownerACategory.name}` })[0]);
    expect(screen.getByRole('button', { name: '儲存修改' })).toBeInTheDocument();

    view.rerender(
      <HomeView data={ownerBData} ownerId="owner-b" put={put} deleteTransaction={() => true} />,
    );
    expect(screen.queryByRole('button', { name: '儲存修改' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '極速記帳' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '金額' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('');
  });

  it('fills only the editable note when a common note chip is tapped', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    const put = vi.fn(() => true);
    render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);

    await user.type(screen.getByRole('textbox', { name: '金額' }), '88');
    await user.click(screen.getByRole('button', { name: '使用常用備註 滷肉飯' }));

    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('滷肉飯');
    expect(screen.getByRole('textbox', { name: '金額' })).toHaveValue('88');
    expect(screen.getByRole('button', { name: '餐飲' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '現金' })).toHaveAttribute('aria-pressed', 'false');
    expect(put).not.toHaveBeenCalled();
  });

  it('populates a safe quick re-entry without submitting and saves through fresh-record creation', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    const category = data.categories.find((item) => item.kind === 'expense')!;
    const put = vi.fn(() => true);
    render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);

    await user.click(screen.getByRole('button', { name: '再記一次 滷肉飯 NT$60' }));

    expect(screen.getByRole('textbox', { name: '金額' })).toHaveValue('60');
    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('滷肉飯');
    expect(screen.getByRole('button', { name: category.name })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: data.accounts[0].name })).toHaveAttribute('aria-pressed', 'true');
    expect(put).not.toHaveBeenCalled();

    await user.clear(screen.getByRole('textbox', { name: '金額' }));
    await user.type(screen.getByRole('textbox', { name: '金額' }), '65');
    await user.clear(screen.getByRole('textbox', { name: '備註' }));
    await user.type(screen.getByRole('textbox', { name: '備註' }), '滷肉飯 加蛋');
    await user.click(screen.getByRole('button', { name: '記下這筆支出' }));

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('transactions', expect.objectContaining({
      amount: 65,
      note: '滷肉飯 加蛋',
      categoryId: category.id,
      accountId: data.accounts[0].id,
      version: 1,
    }));
    const saved = (put.mock.calls as unknown as Array<[string, Transaction]>)[0][1];
    expect(saved.id).not.toBe('meal-1');
    expect(saved.id).not.toBe('meal-2');
    expect(saved.lastOperationId).not.toBe('meal-1-create');
    expect(saved.lastOperationId).not.toBe('meal-2-create');
  });

  it('adds, uses, reloads, and explicitly removes a device-local note shortcut', async () => {
    const user = userEvent.setup();
    const data = createInitialState('guest').data;
    const put = vi.fn(() => true);
    const view = render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);

    await user.click(screen.getByText('補充時間或備註'));
    await user.click(screen.getByRole('button', { name: '新增快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '新的快捷備註' }), '🍙 早餐');
    await user.click(screen.getByRole('button', { name: '加入快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '金額' }), '88');
    await user.click(screen.getByRole('button', { name: '使用我的快捷 🍙 早餐' }));

    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('🍙 早餐');
    expect(screen.getByRole('textbox', { name: '金額' })).toHaveValue('88');
    expect(put).not.toHaveBeenCalled();

    view.unmount();
    render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);
    expect(screen.getByRole('button', { name: '使用我的快捷 🍙 早餐' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '移除快捷備註 🍙 早餐' }));
    expect(screen.queryByRole('button', { name: '使用我的快捷 🍙 早餐' })).not.toBeInTheDocument();
  });

  it('keeps a pinned shortcut predictable and suppresses its automatic duplicate', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);

    expect(screen.getByRole('button', { name: '使用常用備註 滷肉飯' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新增快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '新的快捷備註' }), ' 滷肉飯 ');
    await user.click(screen.getByRole('button', { name: '加入快捷備註' }));

    expect(screen.getByRole('button', { name: '使用我的快捷 滷肉飯' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '使用常用備註 滷肉飯' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再記一次 滷肉飯 NT$60' })).toBeInTheDocument();
  });

  it('hides full quick re-entry while editing but still allows note-only shortcuts', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    const put = vi.fn(() => true);
    render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);
    await user.click(screen.getByRole('button', { name: '新增快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '新的快捷備註' }), '晚餐');
    await user.click(screen.getByRole('button', { name: '加入快捷備註' }));
    await user.click(screen.getAllByRole('button', { name: '編輯 餐飲' })[0]);

    expect(screen.queryByRole('button', { name: /再記一次 滷肉飯/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '使用我的快捷 晚餐' }));
    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('晚餐');
    expect(screen.getByRole('button', { name: '儲存修改' })).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it('fails closed if a quick-reentry parent changes after fields are populated', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    const put = vi.fn(() => true);
    const view = render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);
    await user.click(screen.getByRole('button', { name: '再記一次 滷肉飯 NT$60' }));

    const changedAccount = {
      ...data.accounts[0],
      version: data.accounts[0].version + 1,
      updatedAt: '2026-08-28T15:00:00.000Z',
      lastOperationId: 'account-background-change',
    };
    view.rerender(
      <HomeView
        data={{ ...data, accounts: [changedAccount, data.accounts[1]] }}
        ownerId="guest"
        put={put}
        deleteTransaction={() => true}
      />,
    );
    await user.click(screen.getByRole('button', { name: '餐飲' }));
    await user.click(screen.getByRole('button', { name: '記下這筆支出' }));

    expect(screen.getByRole('alert')).toHaveTextContent('快捷重填的分類或帳戶已在背景更新');
    expect(put).not.toHaveBeenCalled();
  });

  it('hides unsafe full candidates without a fallback while retaining note-only suggestions', () => {
    const data = dataWithQuickHistory();
    data.accounts[0] = { ...data.accounts[0], isActive: false };
    render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);

    expect(screen.queryByRole('button', { name: /再記一次 滷肉飯/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '使用常用備註 滷肉飯' })).toBeInTheDocument();
  });

  it('keeps expense, income, and transfer notes separated and never offers transfer full templates', async () => {
    const user = userEvent.setup();
    const data = dataWithQuickHistory();
    data.transfers = [
      transferFor(data),
      { ...transferFor(data), id: 'transfer-ui-2', lastOperationId: 'transfer-ui-2-create' },
    ];
    render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);

    expect(screen.getByRole('button', { name: '使用常用備註 滷肉飯' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '記收入' }));
    expect(screen.queryByRole('button', { name: '使用常用備註 滷肉飯' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /再記一次/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '記轉帳' }));
    expect(screen.getByRole('button', { name: '使用常用備註 測試轉帳' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /再記一次/ })).not.toBeInTheDocument();
  });

  it('never exposes one owner shortcut namespace while switching owners', async () => {
    const user = userEvent.setup();
    const data = createInitialState('guest').data;
    const view = render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);
    await user.click(screen.getByText('補充時間或備註'));
    await user.click(screen.getByRole('button', { name: '新增快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '新的快捷備註' }), '訪客早餐');
    await user.click(screen.getByRole('button', { name: '加入快捷備註' }));

    view.rerender(<HomeView data={{ ...data, accounts: [], categories: [] }} ownerId="user-a" put={() => true} deleteTransaction={() => true} />);
    expect(screen.queryByRole('button', { name: '使用我的快捷 訪客早餐' })).not.toBeInTheDocument();
  });

  it('does not render an empty common-note panel for a new ledger', () => {
    const data = createInitialState('guest').data;
    render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);

    expect(screen.queryByLabelText('常用備註')).not.toBeInTheDocument();
    expect(screen.getByLabelText('我的快捷備註')).toBeInTheDocument();
  });

  it('supports keyboard creation and activation of a note shortcut', async () => {
    const user = userEvent.setup();
    const data = createInitialState('guest').data;
    render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);
    await user.click(screen.getByText('補充時間或備註'));
    await user.click(screen.getByRole('button', { name: '新增快捷備註' }));
    await user.type(screen.getByRole('textbox', { name: '新的快捷備註' }), '鍵盤早餐{Enter}');

    const shortcut = screen.getByRole('button', { name: '使用我的快捷 鍵盤早餐' });
    shortcut.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('鍵盤早餐');
  });

  it('does not treat an IME composition Enter as shortcut submission', async () => {
    const user = userEvent.setup();
    const data = createInitialState('guest').data;
    render(<HomeView data={data} ownerId="guest" put={() => true} deleteTransaction={() => true} />);
    await user.click(screen.getByText('補充時間或備註'));
    await user.click(screen.getByRole('button', { name: '新增快捷備註' }));
    const input = screen.getByRole('textbox', { name: '新的快捷備註' });
    fireEvent.change(input, { target: { value: '滷肉飯' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.queryByRole('button', { name: '使用我的快捷 滷肉飯' })).not.toBeInTheDocument();
    expect(input).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    expect(screen.getByRole('button', { name: '使用我的快捷 滷肉飯' })).toBeInTheDocument();
  });
});
