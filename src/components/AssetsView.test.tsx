import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import {
  AssetsView,
  buildEditedAccount,
  calculateBalanceAdjustmentDelta,
  isAccountEditable,
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

  it('keeps an existing opening balance immutable in account edits', () => {
    const account = createInitialState('guest').data.accounts[0];
    expect(resolveAccountOpeningBalance(account, '999999')).toBe(account.openingBalance);
  });

  it('calculates corrections from the full account balance even when it is excluded from total assets', () => {
    expect(calculateBalanceAdjustmentDelta(500, 450)).toBe(-50);
    expect(calculateBalanceAdjustmentDelta(0.3, 0.1)).toBe(-0.2);
  });

  it('rejects a stale account editor and preserves the latest balance fields', () => {
    const opened = createInitialState('guest').data.accounts[0];
    const current = {
      ...opened,
      version: opened.version + 1,
      lastOperationId: 'account-background-update',
      name: '雲端帳戶名稱',
      openingBalance: 12_345,
    };
    const before = structuredClone(current);

    expect(() => buildEditedAccount(opened, current, {
      name: '舊表單名稱',
      icon: opened.icon,
      includeInTotalAssets: false,
    })).toThrow(/背景更新/);
    expect(current).toEqual(before);
    expect(current.openingBalance).toBe(12_345);
  });

  it('rejects an account editor while its same-clock payload conflict is unresolved', () => {
    const account = createInitialState('guest').data.accounts[0];

    expect(() => buildEditedAccount(account, account, {
      name: '不應儲存',
      icon: account.icon,
      includeInTotalAssets: account.includeInTotalAssets,
    }, new Date(), true)).toThrow(/未解同步衝突/);
  });

  it('edits from the latest account while keeping opening balance and adjustment history immutable', () => {
    const state = createInitialState('guest');
    const opened = state.data.accounts[0];
    const adjustmentsBefore = structuredClone(state.data.adjustments);

    const edited = buildEditedAccount(opened, opened, {
      name: '日常現金',
      icon: { type: 'emoji', value: '👛' },
      includeInTotalAssets: false,
    }, new Date('2026-08-27T02:00:00.000Z'));

    expect(edited).toMatchObject({
      id: opened.id,
      name: '日常現金',
      openingBalance: opened.openingBalance,
      version: opened.version + 1,
      includeInTotalAssets: false,
    });
    expect(state.data.adjustments).toEqual(adjustmentsBefore);
  });

  it('requires an archived account to be restored before editing', () => {
    const state = createInitialState('guest');
    state.data.accounts[0] = { ...state.data.accounts[0], isActive: false };

    const html = renderToStaticMarkup(
      <AssetsView
        data={state.data}
        ownerId="guest"
        putAccount={() => true}
        putAdjustment={() => true}
        archiveAccount={() => true}
      />,
    );

    expect(html).not.toContain('編輯帳戶');
    expect(isAccountEditable(state.data.accounts[0])).toBe(false);
    expect(isAccountEditable({ ...state.data.accounts[0], isActive: true })).toBe(true);
  });
});
