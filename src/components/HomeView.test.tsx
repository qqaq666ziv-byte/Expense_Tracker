import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import { HomeView } from './HomeView';

describe('HomeView ledger access', () => {
  it('offers access beyond the first 30 auditable ledger entries', () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.transactions = Array.from({ length: 31 }, (_, index) => ({
      id: `transaction-${index}`,
      ownerId: 'guest' as const,
      version: 1,
      updatedAt: `2026-08-21T10:${String(index).padStart(2, '0')}:00.000Z`,
      lastOperationId: `operation-${index}`,
      amount: index + 1,
      type: 'expense' as const,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      occurredAt: `2026-08-21 10:${String(index).padStart(2, '0')}`,
    }));

    const html = renderToStaticMarkup(
      <HomeView
        data={state.data}
        ownerId="guest"
        put={() => undefined}
        putAdjustment={() => undefined}
        deleteTransaction={() => undefined}
      />,
    );

    expect(html.match(/data-testid="transaction-row"/g)).toHaveLength(30);
    expect(html).toContain('載入更多歷史（剩餘 1 筆）');
  });
});
