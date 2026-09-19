// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createInitialState } from '../app/state';
import { InsightsView } from './InsightsView';

vi.mock('../app/useCalendarReference', () => ({ useCalendarReference: () => new Date(2026, 7, 21, 15) }));
afterEach(cleanup);

it('shows the transfer fee in category drilldown without creating a transaction', () => {
  const data = createInitialState('guest').data;
  data.transactions = [];
  data.transfers = [{
    id: 'fee-transfer', ownerId: 'guest', amount: 500, fee: 15,
    sourceAccountId: data.accounts[0].id, sourceAccountName: '現金',
    destinationAccountId: 'bank', destinationAccountName: '銀行',
    occurredAt: '2026-08-21 12:00', version: 1,
    updatedAt: '2026-08-21T04:00:00.000Z', lastOperationId: 'fixture',
  }];
  render(<InsightsView data={data} onOpenLedger={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /手續費/ }));
  expect(screen.getByRole('heading', { name: '手續費明細' })).toBeInTheDocument();
  expect(screen.getByText('轉帳手續費：現金 → 銀行')).toBeInTheDocument();
  expect(data.transactions).toEqual([]);
});
