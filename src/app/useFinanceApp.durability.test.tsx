// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../domain/model';
import {
  createFinancePersistence,
  createInMemoryOwnerStateStore,
} from './localDurability';
import { createInitialState, saveFinanceState } from './state';
import { useFinanceApp } from './useFinanceApp';
import type { FinancePersistence } from './localDurability';
import { HomeView } from '../components/HomeView';

beforeEach(() => localStorage.clear());

describe('useFinanceApp durable commit boundary', () => {
  it('returns failure, preserves authoritative memory, and locks later writes after a storage failure', async () => {
    const initial = createInitialState('guest');
    saveFinanceState(initial);
    const store = createInMemoryOwnerStateStore();
    const basePersistence = createFinancePersistence(store, localStorage);
    const persistence = {
      load: vi.fn(basePersistence.load),
      commit: vi.fn(basePersistence.commit),
      recover: vi.fn(basePersistence.recover),
    };
    const { result } = renderHook(() => useFinanceApp(persistence));
    await waitFor(() => expect(persistence.load).toHaveBeenCalledWith('guest'));
    const before = structuredClone(result.current.state);
    const category = before.data.categories.find((candidate) => candidate.kind === 'expense')!;
    const account = before.data.accounts[0];
    const record: Transaction = {
      id: 'hook-write-failure',
      ownerId: 'guest',
      amount: 99,
      type: 'expense',
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      occurredAt: '2026-08-28 12:00',
      version: 1,
      updatedAt: '2026-08-28T04:00:00.000Z',
      lastOperationId: 'operation-hook-write-failure',
    };
    store.failNextWrite(new DOMException('quota exhausted', 'QuotaExceededError'));

    let firstApplied = true;
    await act(async () => {
      firstApplied = await result.current.put('transactions', record);
    });
    let secondApplied = true;
    await act(async () => {
      secondApplied = await result.current.put('transactions', {
        ...record,
        id: 'blocked-after-failure',
        lastOperationId: 'operation-blocked-after-failure',
      });
    });

    expect(firstApplied).toBe(false);
    expect(secondApplied).toBe(false);
    expect(result.current.state).toEqual(before);
    expect(result.current.storageError).toMatch(/quota exhausted/);
    expect(persistence.commit).toHaveBeenCalledOnce();
  });

  it('propagates a real durable write failure through the controller without clearing the form', async () => {
    const user = userEvent.setup();
    const initial = createInitialState('guest');
    saveFinanceState(initial);
    const store = createInMemoryOwnerStateStore();
    const persistence = createFinancePersistence(store, localStorage);
    function DurableHome({ adapter }: { adapter: FinancePersistence }) {
      const app = useFinanceApp(adapter);
      if (app.authLoading) return <div>loading durable state</div>;
      return (
        <HomeView
          data={app.state.data}
          ownerId={app.state.ownerId}
          put={app.put}
          deleteTransaction={(record) => app.softDelete('transactions', record)}
        />
      );
    }
    render(<DurableHome adapter={persistence} />);
    const amount = await screen.findByRole('textbox', { name: '金額' });
    const note = screen.getByRole('textbox', { name: '備註' });
    await user.type(amount, '96');
    await user.type(note, 'controller integration failure');
    await user.click(screen.getByRole('button', { name: '餐飲' }));
    await user.click(screen.getByRole('button', { name: '現金' }));
    store.failNextWrite(new DOMException('quota exhausted', 'QuotaExceededError'));

    await user.click(screen.getByRole('button', { name: '記下這筆支出' }));

    expect(await screen.findByText(/操作未執行/)).toBeTruthy();
    expect((amount as HTMLInputElement).value).toBe('96');
    expect((note as HTMLInputElement).value).toBe('controller integration failure');
    expect(screen.queryByText(/已記下.*96/)).toBeNull();
    expect((await persistence.load('guest')).state.data.transactions).toEqual([]);
  });

  it('rejects a stale delete after another context edited the record', async () => {
    const initial = createInitialState('guest');
    const category = initial.data.categories.find((candidate) => candidate.kind === 'expense')!;
    const account = initial.data.accounts[0];
    const original: Transaction = {
      id: 'stale-delete-record', ownerId: 'guest', amount: 70, type: 'expense',
      categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-28 12:00',
      version: 1, updatedAt: '2026-08-28T04:00:00.000Z', lastOperationId: 'create-stale-delete-record',
    };
    initial.data.transactions = [original];
    saveFinanceState(initial);
    const store = createInMemoryOwnerStateStore();
    const persistence = createFinancePersistence(store, localStorage);
    const { result } = renderHook(() => useFinanceApp(persistence));
    await waitFor(() => expect(result.current.state.data.transactions).toContainEqual(original));
    const edited = {
      ...original,
      amount: 85,
      version: 2,
      updatedAt: '2026-08-28T05:00:00.000Z',
      lastOperationId: 'edit-before-stale-delete',
    };
    await persistence.commit('guest', edited.lastOperationId, (latest) => ({
      ...latest,
      data: { ...latest.data, transactions: [edited] },
    }));

    let deleted = true;
    await act(async () => {
      deleted = await result.current.softDelete('transactions', original);
    });
    const finalState = (await persistence.load('guest')).state;

    expect(deleted).toBe(false);
    expect(finalState.data.transactions).toContainEqual(edited);
    expect(finalState.data.transactions[0].deletedAt).toBeUndefined();
  });
});
