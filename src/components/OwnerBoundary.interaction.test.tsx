// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceOwnerBoundary } from '../App';
import { createInitialState } from '../app/state';
import type { SavingsGoal } from '../domain/model';
import { AssetsView } from './AssetsView';
import { PlanningView } from './PlanningView';
import { SettingsView } from './SettingsView';

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

describe('finance owner boundary', () => {
  it('discards an Assets draft before owner B can observe or submit owner A values', async () => {
    const user = userEvent.setup();
    const ownerA = createInitialState('owner-a').data;
    const ownerB = createInitialState('owner-b').data;
    const putOwnerA = vi.fn(() => true);
    const putOwnerB = vi.fn(() => true);
    const view = render(
      <FinanceOwnerBoundary ownerId="owner-a">
        <AssetsView
          data={ownerA}
          ownerId="owner-a"
          putAccount={putOwnerA}
          putAdjustment={() => true}
          archiveAccount={() => true}
        />
      </FinanceOwnerBoundary>,
    );

    await user.click(screen.getByRole('button', { name: '新增帳戶' }));
    await user.type(screen.getByRole('textbox', { name: '帳戶名稱' }), 'A 的私人帳戶');
    expect(screen.getByRole('textbox', { name: '帳戶名稱' })).toHaveValue('A 的私人帳戶');

    view.rerender(
      <FinanceOwnerBoundary ownerId="owner-b">
        <AssetsView
          data={ownerB}
          ownerId="owner-b"
          putAccount={putOwnerB}
          putAdjustment={() => true}
          archiveAccount={() => true}
        />
      </FinanceOwnerBoundary>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新增帳戶' }));
    expect(screen.getByRole('textbox', { name: '帳戶名稱' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: '儲存帳戶' }));
    expect(putOwnerB).not.toHaveBeenCalled();
    expect(putOwnerA).not.toHaveBeenCalled();
  });

  it('closes an Assets editor and cannot submit owner A account fields after switching to B', async () => {
    const user = userEvent.setup();
    const ownerA = createInitialState('owner-a').data;
    ownerA.accounts[0] = { ...ownerA.accounts[0], name: 'A 的薪資帳戶' };
    const ownerB = createInitialState('owner-b').data;
    ownerB.accounts[0] = { ...ownerB.accounts[0], name: 'B 的日用帳戶' };
    const putOwnerA = vi.fn(() => true);
    const putOwnerB = vi.fn(() => true);
    const view = render(
      <FinanceOwnerBoundary ownerId="owner-a">
        <AssetsView
          data={ownerA}
          ownerId="owner-a"
          putAccount={putOwnerA}
          putAdjustment={() => true}
          archiveAccount={() => true}
        />
      </FinanceOwnerBoundary>,
    );

    await user.click(screen.getByRole('button', { name: /A 的薪資帳戶/ }));
    await user.click(screen.getByRole('button', { name: '編輯帳戶' }));
    await user.clear(screen.getByRole('textbox', { name: '帳戶名稱' }));
    await user.type(screen.getByRole('textbox', { name: '帳戶名稱' }), 'A 尚未儲存的名稱');

    view.rerender(
      <FinanceOwnerBoundary ownerId="owner-b">
        <AssetsView
          data={ownerB}
          ownerId="owner-b"
          putAccount={putOwnerB}
          putAdjustment={() => true}
          archiveAccount={() => true}
        />
      </FinanceOwnerBoundary>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('A 尚未儲存的名稱')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /B 的日用帳戶/ }));
    await user.click(screen.getByRole('button', { name: '編輯帳戶' }));
    expect(screen.getByRole('textbox', { name: '帳戶名稱' })).toHaveValue('B 的日用帳戶');
    expect(putOwnerA).not.toHaveBeenCalled();
    expect(putOwnerB).not.toHaveBeenCalled();
  });

  it('discards a Planning editor draft on authenticated to guest owner switch', async () => {
    const user = userEvent.setup();
    const ownerA = createInitialState('owner-a').data;
    ownerA.goals = [{
      id: 'owner-a-goal',
      ownerId: 'owner-a',
      version: 1,
      updatedAt: '2026-08-28T10:00:00.000Z',
      lastOperationId: 'owner-a-goal-create',
      name: 'A 的留學基金',
      targetAmount: 100_000,
      isActive: true,
    }];
    const guest = createInitialState('guest').data;
    const putOwnerAGoal = vi.fn(() => true);
    const putGuestGoal = vi.fn(() => true);
    const planning = (
      data: typeof ownerA,
      ownerId: string,
      putGoal: (record: SavingsGoal) => boolean,
    ) => (
      <PlanningView
        data={data}
        ownerId={ownerId}
        putGoal={putGoal}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
      />
    );
    const view = render(
      <FinanceOwnerBoundary ownerId="owner-a">
        {planning(ownerA, 'owner-a', putOwnerAGoal)}
      </FinanceOwnerBoundary>,
    );

    await user.click(screen.getByRole('button', { name: '編輯A 的留學基金' }));
    await user.clear(screen.getByRole('textbox', { name: '目標名稱' }));
    await user.type(screen.getByRole('textbox', { name: '目標名稱' }), 'A 尚未儲存的目標');

    view.rerender(
      <FinanceOwnerBoundary ownerId="guest">
        {planning(guest, 'guest', putGuestGoal)}
      </FinanceOwnerBoundary>,
    );

    expect(screen.getByRole('textbox', { name: '目標名稱' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '建立目標' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '建立目標' }));
    expect(putOwnerAGoal).not.toHaveBeenCalled();
    expect(putGuestGoal).not.toHaveBeenCalled();
  });

  it('clears Settings backup JSON before another owner can restore it', async () => {
    const user = userEvent.setup();
    const ownerA = createInitialState('owner-a').data;
    const ownerB = createInitialState('owner-b').data;
    const restoreOwnerA = vi.fn();
    const restoreOwnerB = vi.fn();
    const settings = (data: typeof ownerA, ownerId: string, restore: typeof restoreOwnerA) => (
      <SettingsView
        data={data}
        ownerId={ownerId}
        putCategory={() => true}
        putRecurring={() => true}
        categoryLifecycle={() => true}
        deleteRecurring={() => true}
        restore={restore}
      />
    );
    const view = render(
      <FinanceOwnerBoundary ownerId="owner-a">
        {settings(ownerA, 'owner-a', restoreOwnerA)}
      </FinanceOwnerBoundary>,
    );

    await user.click(screen.getByRole('button', { name: '資料備份' }));
    await user.upload(
      screen.getByLabelText('選擇 JSON 備份檔'),
      new File(['{"private":"owner-a"}'], 'owner-a.json', { type: 'application/json' }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '驗證後還原' })).toBeEnabled());

    view.rerender(
      <FinanceOwnerBoundary ownerId="owner-b">
        {settings(ownerB, 'owner-b', restoreOwnerB)}
      </FinanceOwnerBoundary>,
    );

    await user.click(screen.getByRole('button', { name: '資料備份' }));
    expect(screen.getByRole('button', { name: '驗證後還原' })).toBeDisabled();
    expect(restoreOwnerA).not.toHaveBeenCalled();
    expect(restoreOwnerB).not.toHaveBeenCalled();
  });
});
