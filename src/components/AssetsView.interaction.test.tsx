// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../app/state';
import type { AssetAccount } from '../domain/model';
import { AssetsView } from './AssetsView';

beforeEach(() => {
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

describe('AssetsView account form interactions', () => {
  it('shows the outgoing principal plus fee in account history', async () => {
    const user = userEvent.setup();
    const data = createInitialState('guest').data;
    const source = data.accounts[0];
    data.accounts.push({ ...source, id: 'destination', name: '銀行' });
    data.transfers = [{
      id: 'fee-transfer', ownerId: 'guest', version: 1,
      updatedAt: source.updatedAt, lastOperationId: 'fee-create',
      amount: 1000, fee: 15, sourceAccountId: source.id, sourceAccountName: source.name,
      destinationAccountId: 'destination', destinationAccountName: '銀行', occurredAt: '2026-09-19T10:00',
    }];
    render(<AssetsView data={data} ownerId="guest" putAccount={() => true}
      putAdjustment={() => true} archiveAccount={() => true} />);
    await user.click(screen.getByRole('button', { name: /現金.*1,015/ }));
    expect(screen.getByText('−NT$1,015')).toBeInTheDocument();
    expect(screen.getByText(/含手續費 NT\$15/)).toBeInTheDocument();
  });

  it('keeps a writable current-amount money input when creating an account', async () => {
    const user = userEvent.setup();
    const state = createInitialState('guest');
    render(
      <AssetsView
        data={state.data}
        ownerId="guest"
        putAccount={() => true}
        putAdjustment={() => true}
        archiveAccount={() => true}
      />,
    );

    await user.click(screen.getByRole('button', { name: '新增帳戶' }));

    expect(screen.getByText('目前金額')).toBeInTheDocument();
    const amount = screen.getByRole('textbox', { name: '目前金額' });
    expect(amount).not.toHaveAttribute('readonly');
    await user.clear(amount);
    await user.type(amount, '1234');
    expect(amount).toHaveValue('1,234');
  });

  it('hides opening balance while editing and preserves it when metadata changes', async () => {
    const user = userEvent.setup();
    const state = createInitialState('guest');
    const account = {
      ...state.data.accounts[0],
      name: '舊錢包',
      openingBalance: 4_321,
    };
    state.data.accounts[0] = account;
    const putAccount = vi.fn(() => true);
    render(
      <AssetsView
        data={state.data}
        ownerId="guest"
        putAccount={putAccount}
        putAdjustment={() => true}
        archiveAccount={() => true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /舊錢包/ }));
    await user.click(screen.getByRole('button', { name: '編輯帳戶' }));

    expect(screen.getByRole('heading', { name: '編輯帳戶' })).toBeInTheDocument();
    expect(screen.queryByText('期初餘額')).not.toBeInTheDocument();
    expect(screen.queryByText(/期初餘額建立後不會改寫/)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '期初餘額' })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: '帳戶名稱' }));
    await user.type(screen.getByRole('textbox', { name: '帳戶名稱' }), '新錢包');
    const kinds = screen.getByRole('group', { name: '帳戶類型' });
    await user.click(within(kinds).getByRole('button', { name: /銀行/ }));
    await user.click(screen.getByRole('checkbox', { name: '納入總資產' }));
    await user.click(screen.getByRole('button', { name: '儲存帳戶' }));

    expect(putAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: account.id,
      name: '新錢包',
      icon: { type: 'emoji', value: '🏦' },
      includeInTotalAssets: false,
      openingBalance: 4_321,
    } satisfies Partial<AssetAccount>));
  });
});
