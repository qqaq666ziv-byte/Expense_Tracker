// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../app/state';
import type { FinanceData } from '../domain/model';
import { InsightsView } from './InsightsView';

const clock = vi.hoisted(() => ({ now: new Date(2026, 9, 13, 12) }));
vi.mock('../app/useCalendarReference', () => ({ useCalendarReference: () => clock.now }));
afterEach(cleanup);
beforeEach(() => { clock.now = new Date(2026, 9, 13, 12); });

function fixture(): FinanceData {
  const data = createInitialState('guest').data;
  const account = data.accounts[0];
  data.accounts.push({ ...account, id: 'synthetic-bank', name: '銀行', sortOrder: 1 });
  const category = data.categories.find((item) => item.kind === 'expense')!;
  data.transactions = [
    ['2026-09-30 23:59:59.999', 31, 'outside-start'],
    ['2026-10-01 00:00', 100, 'october-start'],
    ['2026-10-13 12:00', 13, 'today'],
    ['2024-12-29 23:59:59.999', 19, 'outside-week'],
    ['2024-12-30 00:00', 70, 'week-start'],
    ['2025-01-05 23:59:59.999', 140, 'week-end'],
    ['2025-01-06 00:00', 500, 'after-week'],
    ['2024-02-29 23:59:59.999', 290, 'leap-day'],
    ['2024-03-01 00:00', 300, 'after-leap-day'],
  ].map(([occurredAt, amount, note], index) => ({
    id: `synthetic-${index}`, ownerId: 'guest', version: 1,
    updatedAt: '2026-10-13T00:00:00.000Z', lastOperationId: `synthetic-${index}`,
    occurredAt: String(occurredAt), amount: Number(amount), note: String(note), type: 'expense',
    categoryId: category.id, categoryName: category.name,
    accountId: account.id, accountName: account.name,
  }));
  data.budgets = [{
    id: 'synthetic-budget', ownerId: 'guest', version: 1,
    updatedAt: '2026-10-13T00:00:00.000Z', lastOperationId: 'synthetic-budget',
    scope: 'overall', period: 'monthly', amount: 1000, isActive: true,
  }];
  return data;
}

const summary = () => screen.getByRole('region', { name: '這段時間的收支' });
const expense = () => summary().querySelector('.insight-metric.expense strong');
const picker = () => screen.getByText(/週一至週日/).parentElement!;

describe('InsightsView selected calendar periods', () => {
  it('updates summaries, trend, fee drilldown and empty states for a chosen cross-year week', () => {
    const data = fixture();
    data.transfers = [{
      id: 'synthetic-fee', ownerId: 'guest', version: 1, updatedAt: '2026-10-13T00:00:00.000Z',
      lastOperationId: 'synthetic-fee', sourceAccountId: data.accounts[0].id, sourceAccountName: '現金',
      destinationAccountId: data.accounts[1].id, destinationAccountName: '銀行', amount: 1000, fee: 15,
      occurredAt: '2025-01-05 20:00',
    }];
    render(<InsightsView data={data} onOpenLedger={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '週' }));
    fireEvent.change(screen.getByLabelText('選擇週內日期'), { target: { value: '2025-01-05' } });
    expect(picker()).toHaveTextContent('2024/12/30 — 2025/1/5');
    expect(expense()).toHaveTextContent('225');
    expect(screen.getByText('已選日期：2025-01-05')).toBeVisible();
    expect(screen.getByLabelText('選擇週內日期')).toHaveAccessibleDescription(/已選日期：2025-01-05.*2024\/12\/30/);
    const trend = screen.getByRole('img', { name: '支出趨勢折線圖' });
    expect(trend).toHaveTextContent('2024-12-30：');
    expect(trend).toHaveTextContent('2025-01-05：');
    expect(trend).not.toHaveTextContent('2025-01-06');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(data.categories.find((item) => item.kind === 'expense')!.name) }));
    expect(screen.getByText('week-start')).toBeInTheDocument();
    expect(screen.getByText('week-end')).toBeInTheDocument();
    expect(screen.queryByText('after-week')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /手續費/ }));
    expect(screen.getByText('轉帳手續費：現金 → 銀行')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('選擇週內日期'), { target: { value: '2025-04-01' } });
    expect(screen.queryByRole('heading', { name: '手續費明細' })).not.toBeInTheDocument();
    expect(expense()).toHaveTextContent('0');
    expect(screen.getByText('這段時間沒有支出')).toBeInTheDocument();
    expect(screen.getByText('還沒有趨勢資料')).toBeInTheDocument();
  });

  it('keeps independent week/month choices across repeated switching and returns to the live current period', () => {
    render(<InsightsView data={fixture()} onOpenLedger={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('選擇月份'), { target: { value: '2024-02' } });
    expect(summary()).toHaveTextContent('2024/2/1 — 2024/2/29');
    expect(screen.getByText('已選月份：2024-02')).toBeVisible();
    expect(screen.getByLabelText('選擇月份')).toHaveAccessibleDescription(/已選月份：2024-02/);
    expect(expense()).toHaveTextContent('290');
    for (let index = 0; index < 3; index++) {
      fireEvent.click(screen.getByRole('button', { name: '週' }));
      if (index === 0) fireEvent.change(screen.getByLabelText('選擇週內日期'), { target: { value: '2025-01-05' } });
      expect(expense()).toHaveTextContent('210');
      fireEvent.click(screen.getByRole('button', { name: '月' }));
      expect(screen.getByLabelText('選擇月份')).toHaveValue('2024-02');
      expect(expense()).toHaveTextContent('290');
    }
    fireEvent.click(screen.getByRole('button', { name: '下一月' }));
    expect(expense()).toHaveTextContent('300');
    fireEvent.click(screen.getByRole('button', { name: '上一月' }));
    expect(expense()).toHaveTextContent('290');
    fireEvent.click(screen.getByRole('button', { name: '回本月' }));
    expect(screen.getByLabelText('選擇月份')).toHaveValue('2026-10');
    expect(expense()).toHaveTextContent('113');
    fireEvent.click(screen.getByRole('button', { name: '週' }));
    fireEvent.click(screen.getByRole('button', { name: '下一週' }));
    expect(screen.getByLabelText('選擇週內日期')).toHaveValue('2025-01-06');
    fireEvent.click(screen.getByRole('button', { name: '上一週' }));
    expect(screen.getByLabelText('選擇週內日期')).toHaveValue('2024-12-30');
    fireEvent.click(screen.getByRole('button', { name: '回本週' }));
    expect(picker()).toHaveTextContent('2026/10/12 — 2026/10/18');
  });

  it('keeps today and current budgets tied to the live clock while browsing another month', () => {
    render(<InsightsView data={fixture()} onOpenLedger={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('選擇月份'), { target: { value: '2024-02' } });
    const today = screen.getByRole('region', { name: '我今天花了多少？' });
    expect(today.querySelector('.today-answer strong')).toHaveTextContent('13');
    expect(screen.getByRole('region', { name: '預算進度' })).toHaveTextContent('已用 NT$113');
  });

  it('shows an inline error for a cleared input and recovers through return-to-current', () => {
    render(<InsightsView data={fixture()} onOpenLedger={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('選擇月份'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('請選擇有效的月份');
    expect(screen.queryByText(/^已選月份：/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '這段時間的收支' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一月' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '回本月' }));
    expect(summary()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '週' }));
    fireEvent.change(screen.getByLabelText('選擇週內日期'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('請選擇有效的週內日期');
    fireEvent.click(screen.getByRole('button', { name: '回本週' }));
    expect(summary()).toBeInTheDocument();
  });

  it('retains custom, today and year flows after choosing a historical month', () => {
    const openLedger = vi.fn();
    render(<InsightsView data={fixture()} onOpenLedger={openLedger} />);
    fireEvent.change(screen.getByLabelText('選擇月份'), { target: { value: '2025-01' } });
    fireEvent.click(screen.getByRole('button', { name: '今日' }));
    expect(expense()).toHaveTextContent('13');
    fireEvent.click(screen.getByRole('button', { name: '本年' }));
    expect(summary()).toHaveTextContent('2026/1/1 — 2026/12/31');
    fireEvent.click(screen.getByRole('button', { name: '自訂' }));
    fireEvent.change(screen.getByLabelText('自訂開始日'), { target: { value: '2024-12-30' } });
    fireEvent.change(screen.getByLabelText('自訂結束日'), { target: { value: '2025-01-05' } });
    expect(expense()).toHaveTextContent('210');
    fireEvent.click(within(screen.getByRole('region', { name: '我今天花了多少？' })).getByRole('button'));
    expect(openLedger).toHaveBeenCalledOnce();
  });

  it('follows midnight in current mode, preserves pinned choices and resumes following after reset', () => {
    const data = fixture();
    clock.now = new Date(2026, 9, 31, 23, 59);
    const { rerender } = render(<InsightsView data={data} onOpenLedger={vi.fn()} />);
    expect(screen.getByLabelText('選擇月份')).toHaveValue('2026-10');
    clock.now = new Date(2026, 10, 1, 0, 1);
    rerender(<InsightsView data={data} onOpenLedger={vi.fn()} />);
    expect(screen.getByLabelText('選擇月份')).toHaveValue('2026-11');
    fireEvent.change(screen.getByLabelText('選擇月份'), { target: { value: '2024-02' } });
    clock.now = new Date(2026, 11, 1);
    rerender(<InsightsView data={data} onOpenLedger={vi.fn()} />);
    expect(screen.getByLabelText('選擇月份')).toHaveValue('2024-02');
    fireEvent.click(screen.getByRole('button', { name: '回本月' }));
    expect(screen.getByLabelText('選擇月份')).toHaveValue('2026-12');
    clock.now = new Date(2027, 0, 1);
    rerender(<InsightsView data={data} onOpenLedger={vi.fn()} />);
    expect(screen.getByLabelText('選擇月份')).toHaveValue('2027-01');
  });

  it('reinterprets pinned calendar choices in the new device timezone after a clock refresh', () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Taipei';
      const data = fixture();
      const { rerender } = render(<InsightsView data={data} onOpenLedger={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('選擇月份'), { target: { value: '2024-02' } });
      expect(expense()).toHaveTextContent('290');
      process.env.TZ = 'America/Los_Angeles';
      clock.now = new Date(clock.now.getTime());
      rerender(<InsightsView data={data} onOpenLedger={vi.fn()} />);
      expect(screen.getByLabelText('選擇月份')).toHaveValue('2024-02');
      expect(summary()).toHaveTextContent('2024/2/1 — 2024/2/29');
      expect(expense()).toHaveTextContent('290');

      process.env.TZ = 'Asia/Taipei';
      fireEvent.click(screen.getByRole('button', { name: '週' }));
      fireEvent.change(screen.getByLabelText('選擇週內日期'), { target: { value: '2025-01-06' } });
      process.env.TZ = 'America/Los_Angeles';
      clock.now = new Date(clock.now.getTime());
      rerender(<InsightsView data={data} onOpenLedger={vi.fn()} />);
      expect(summary()).toHaveTextContent('2025/1/6 — 2025/1/12');
      expect(expense()).toHaveTextContent('500');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
  it('keeps future transactions and fees out of every visible report until the local day arrives', () => {
    const data = fixture();
    data.transactions.push({ ...data.transactions[0], id: 'future-expense', amount: 777,
      occurredAt: '2026-10-14 00:00', note: 'tomorrow-only' });
    data.transfers = [{ id: 'future-fee', ownerId: 'guest', version: 1,
      updatedAt: '2026-10-13T00:00:00Z', lastOperationId: 'future-fee', amount: 100, fee: 15,
      sourceAccountId: data.accounts[0].id, sourceAccountName: '現金',
      destinationAccountId: 'synthetic-bank', destinationAccountName: '銀行', occurredAt: '2026-10-14 00:00' }];
    const original = structuredClone(data);
    const { rerender } = render(<InsightsView data={data} onOpenLedger={vi.fn()} />);
    expect(expense()).toHaveTextContent('113');
    expect(screen.getByRole('region', { name: '預算進度' })).toHaveTextContent('已用 NT$113');
    expect(screen.getByRole('img', { name: '支出趨勢折線圖' })).not.toHaveTextContent('2026-10-14');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(data.categories.find(c => c.kind === 'expense')!.name) }));
    expect(screen.queryByText('tomorrow-only')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /手續費/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '週' }));
    expect(expense()).toHaveTextContent('13');
    expect(summary()).toHaveTextContent('NT$6.5');
    clock.now = new Date(2026, 9, 14, 0);
    rerender(<InsightsView data={data} onOpenLedger={vi.fn()} />);
    expect(expense()).toHaveTextContent('805');
    expect(screen.getByRole('img', { name: '支出趨勢折線圖' })).toHaveTextContent('2026-10-14');
    expect(screen.getByRole('region', { name: '預算進度' })).toHaveTextContent('已用 NT$905');
    fireEvent.click(screen.getByRole('button', { name: /手續費/ }));
    expect(screen.getByText('轉帳手續費：現金 → 銀行')).toBeInTheDocument();
    expect(data).toEqual(original);
  });

});
