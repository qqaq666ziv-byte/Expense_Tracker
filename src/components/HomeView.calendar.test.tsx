// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../app/state';
import { HomeView } from './HomeView';

function renderDailyLedger() {
  const data = createInitialState('guest').data;
  const account = data.accounts[0];
  const category = data.categories.find((item) => item.kind === 'expense')!;
  data.transactions = [
    { day: '2026-09-27', amount: 50 },
    { day: '2026-09-28', amount: 70 },
  ].map(({ day, amount }) => ({
    id: `expense-${day}`, ownerId: 'guest', version: 1,
    updatedAt: `${day}T12:00:00.000Z`, lastOperationId: `create-${day}`,
    type: 'expense' as const, amount,
    categoryId: category.id, categoryName: category.name,
    accountId: account.id, accountName: account.name,
    occurredAt: `${day}T12:00`,
  }));
  const put = vi.fn(() => true);
  render(<HomeView data={data} ownerId="guest" put={put} deleteTransaction={() => true} />);
  return put;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('HomeView daily summary clock', () => {
  it('refreshes at local midnight without a ledger mutation or clearing the entry draft', () => {
    vi.setSystemTime(new Date(2026, 8, 27, 23, 59, 59, 900));
    const put = renderDailyLedger();
    const amount = screen.getByRole('textbox', { name: '金額' });
    fireEvent.change(amount, { target: { value: '42' } });
    expect(screen.getByLabelText('今日支出 NT$50')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(200); });

    expect(screen.getByLabelText('今日支出 NT$70')).toBeInTheDocument();
    expect(amount).toHaveValue('42');
    expect(put).not.toHaveBeenCalled();
  });

  it('refreshes after returning to the app on another day before a suspended timer fires', () => {
    vi.setSystemTime(new Date(2026, 8, 27, 12));
    const put = renderDailyLedger();
    expect(screen.getByLabelText('今日支出 NT$50')).toBeInTheDocument();

    vi.setSystemTime(new Date(2026, 8, 28, 12));
    fireEvent.focus(window);

    expect(screen.getByLabelText('今日支出 NT$70')).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });
});
