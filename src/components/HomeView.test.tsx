import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import { TUTORIAL_RECORD_NOTE, startTutorial } from '../app/tutorial';
import { HomeView } from './HomeView';

describe('HomeView ledger access', () => {
  it('keeps the primary entry path in amount, category, account order', () => {
    const state = createInitialState('guest');
    const html = renderToStaticMarkup(
      <HomeView data={state.data} ownerId="guest" put={() => true} deleteTransaction={() => true} />,
    );

    expect(html).toContain('極速記帳');
    expect(html).toContain('記支出');
    expect(html).toContain('餐飲');
    expect(html).toContain('從哪個資產帳戶付款？');
    expect(html.indexOf('aria-label="金額"')).toBeLessThan(html.indexOf('選擇分類'));
    expect(html.indexOf('選擇分類')).toBeLessThan(html.indexOf('從哪個資產帳戶付款？'));
  });

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
        put={() => true}
        deleteTransaction={() => true}
      />,
    );

    expect(html.match(/data-testid="transaction-row"/g)).toHaveLength(30);
    expect(html).toContain('載入更多歷史（剩餘 1 筆）');
  });

  it('shows the excluded tutorial record only while its real CRUD walkthrough is active', () => {
    const state = createInitialState('guest');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.transactions = [{
      id: 'tutorial-record', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-24T09:00:00.000Z', lastOperationId: 'tutorial-create',
      amount: 100, type: 'expense', categoryId: category.id, categoryName: category.name,
      accountId: account.id, accountName: account.name, occurredAt: '2026-08-24 17:00',
      note: TUTORIAL_RECORD_NOTE,
    }];

    const normalHtml = renderToStaticMarkup(
      <HomeView data={state.data} ownerId="guest" put={() => true} deleteTransaction={() => true} />,
    );
    const tutorialHtml = renderToStaticMarkup(
      <HomeView
        data={state.data}
        ownerId="guest"
        put={() => true}
        deleteTransaction={() => true}
        tutorial={{ ...startTutorial('first-record'), step: 'locate', recordId: 'tutorial-record' }}
      />,
    );

    expect(normalHtml).not.toContain('教學紀錄 · 完成後刪除');
    expect(tutorialHtml).toContain('教學紀錄 · 完成後刪除');
    expect(tutorialHtml).toContain('data-tutorial="tutorial-record"');
  });
});
