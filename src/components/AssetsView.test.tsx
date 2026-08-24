import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import { AssetsView } from './AssetsView';

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
});
