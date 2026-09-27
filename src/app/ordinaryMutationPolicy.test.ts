import { describe, expect, it } from 'vitest';
import { createInitialState, type LocalStateRecovery } from './state';
import {
  assertOrdinaryMutationWritable,
  getOrdinaryMutationBlock,
  type OrdinaryMutationAction,
} from './ordinaryMutationPolicy';

const actions: OrdinaryMutationAction[] = ['write', 'delete', 'archive', 'release', 'confirm-transfer'];
const recovery: LocalStateRecovery = { key: 'damaged-ledger', raw: '{broken', message: '保留原始資料' };

describe('ordinary mutation bootstrap and recovery policy', () => {
  it.each(actions)('allows %s after the authoritative pull even while a legacy decision is ready', (action) => {
    const state = createInitialState('user-a');
    state.initialBootstrap = undefined;
    state.legacyBootstrap = { status: 'ready', candidate: structuredClone(state.data), unsyncedTransactionIds: [] };

    expect(getOrdinaryMutationBlock(state, undefined, action)).toBeUndefined();
    expect(() => assertOrdinaryMutationWritable(state, undefined, action)).not.toThrow();
  });

  it.each(['pending', 'seeding'] as const)('blocks every ordinary action throughout initial bootstrap %s', (status) => {
    const state = createInitialState('user-a');
    state.initialBootstrap = { status, candidate: structuredClone(state.data), pendingOperations: [] };
    const before = structuredClone(state);

    for (const action of actions) {
      expect(getOrdinaryMutationBlock(state, undefined, action)?.reason).toBe('initial-bootstrap');
      expect(() => assertOrdinaryMutationWritable(state, undefined, action)).toThrow(/雲端帳本/);
    }
    expect(state).toEqual(before);
  });

  it('retains the pending legacy notice priority while initial bootstrap and recovery are also blocked', () => {
    const state = createInitialState('user-a');
    state.legacyBootstrap = { status: 'pending', candidate: structuredClone(state.data), unsyncedTransactionIds: [] };

    for (const action of ['write', 'delete'] as const) {
      expect(getOrdinaryMutationBlock(state, recovery, action)).toEqual({
        reason: 'legacy-pending',
        message: '舊版本機資料尚在先讀取雲端；完成前已停止所有帳本修改。',
      });
    }
  });

  it.each([
    ['write', '本機快照仍在復原保護中；完成有效備份還原前，本次帳本修改未執行。'],
    ['delete', '本機快照仍在復原保護中；完成有效備份還原前，本次刪除未執行。'],
    ['archive', '本機快照仍在復原保護中；本次封存未執行。'],
    ['release', '本機快照仍在復原保護中；本次釋放未執行。'],
    ['confirm-transfer', '本機快照仍在復原保護中；無法重新確認轉帳帳戶。'],
  ] as const)('keeps the existing recovery notice for %s', (action, message) => {
    const state = createInitialState('guest');

    expect(getOrdinaryMutationBlock(state, recovery, action)).toEqual({ reason: 'recovery', message });
    expect(() => assertOrdinaryMutationWritable(state, recovery, action)).toThrow(message);
  });
});
