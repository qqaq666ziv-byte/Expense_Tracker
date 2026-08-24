import { describe, expect, it, vi } from 'vitest';
import type { RemoteAdapter } from '../domain/syncEngine';
import { createInitialState, storageKey } from './state';
import {
  restoreFinanceStateAndClearRecovery,
  syncFinanceStateUnlessRecovering,
} from './safeSync';

describe('recovery-protected remote sync', () => {
  it('does not create or call a remote adapter while the owner snapshot needs recovery', async () => {
    const state = createInitialState('user-a');
    const pull = vi.fn<RemoteAdapter['pull']>();
    const apply = vi.fn<RemoteAdapter['apply']>();
    const createRemote = vi.fn((): RemoteAdapter => ({ pull, apply }));

    const result = await syncFinanceStateUnlessRecovering(
      state,
      'user-a',
      {
        key: storageKey('user-a'),
        raw: '{broken-json',
        message: '本機財務快照無法驗證',
      },
      createRemote,
    );

    expect(result).toBeUndefined();
    expect(createRemote).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not clear recovery when restored data fails validation', () => {
    const state = createInitialState('user-a');
    const invalidData = structuredClone(state.data);
    invalidData.accounts[0].openingBalance = Number.NaN;
    const persist = vi.fn();
    const clearRecovery = vi.fn();

    expect(() => restoreFinanceStateAndClearRecovery(
      state,
      invalidData,
      persist,
      clearRecovery,
    )).toThrow(/openingBalance/);

    expect(persist).not.toHaveBeenCalled();
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it('keeps recovery locked when the validated restore cannot be durably persisted', () => {
    const state = createInitialState('user-a');
    const persist = vi.fn(() => {
      throw new Error('local storage quota exceeded');
    });
    const clearRecovery = vi.fn();

    expect(() => restoreFinanceStateAndClearRecovery(
      state,
      state.data,
      persist,
      clearRecovery,
    )).toThrow(/quota exceeded/);

    expect(persist).toHaveBeenCalledOnce();
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it('persists a valid restore before clearing recovery protection', () => {
    const state = createInitialState('user-a');
    const order: string[] = [];

    const restored = restoreFinanceStateAndClearRecovery(
      state,
      state.data,
      () => order.push('persist'),
      () => order.push('clear'),
    );

    expect(restored.data.accounts.map(({ id, name }) => ({ id, name })))
      .toEqual(state.data.accounts.map(({ id, name }) => ({ id, name })));
    expect(restored.data.categories.map(({ id, name }) => ({ id, name })))
      .toEqual(state.data.categories.map(({ id, name }) => ({ id, name })));
    expect(restored.initialBootstrap).toBeUndefined();
    expect(restored.outbox).toHaveLength(15);
    expect(restored.outbox.every(({ record }) => (
      record.version === 2 && !record.lastOperationId.startsWith('seed-')
    ))).toBe(true);
    expect(order).toEqual(['persist', 'clear']);
  });
});
