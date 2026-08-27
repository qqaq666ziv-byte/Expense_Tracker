import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import {
  AccountOpeningBalanceField,
  AssetsView,
  calculateBalanceAdjustmentDelta,
  resolveAccountOpeningBalance,
} from './AssetsView';

describe('AssetsView product language', () => {
  it('shows account type, precise balance and clear asset location language', () => {
    const state = createInitialState('guest');
    state.data.accounts.push({
      id: 'jkopay', ownerId: 'guest', version: 1, updatedAt: '2026-08-24T00:00:00.000Z',
      lastOperationId: 'seed-jkopay', name: '街口支付', icon: { type: 'emoji', value: '📱' },
      openingBalance: 1000, includeInTotalAssets: true, isActive: true, sortOrder: 1,
    });

    const html = renderToStaticMarkup(<AssetsView data={state.data} ownerId="guest" putAccount={() => true} putAdjustment={() => true} archiveAccount={() => true} />);

    expect(html).toContain('我的錢在哪裡？');
    expect(html).toContain('電子支付');
    expect(html).toContain('NT$1,000');
    expect(html).toContain('新增帳戶');
  });

  it('keeps an existing opening balance read-only and directs corrections to adjustments', () => {
    const account = createInitialState('guest').data.accounts[0];
    const html = renderToStaticMarkup(
      <AccountOpeningBalanceField
        editing={account}
        opening="999999"
        onOpeningChange={() => undefined}
      />,
    );

    expect(html).toContain('期初餘額建立後不會改寫');
    expect(html).toContain('調整餘額');
    expect(html).toContain('readOnly');
    expect(resolveAccountOpeningBalance(account, '999999')).toBe(account.openingBalance);
  });

  it('calculates corrections from the full account balance even when it is excluded from total assets', () => {
    expect(calculateBalanceAdjustmentDelta(500, 450)).toBe(-50);
    expect(calculateBalanceAdjustmentDelta(0.3, 0.1)).toBe(-0.2);
  });
});
