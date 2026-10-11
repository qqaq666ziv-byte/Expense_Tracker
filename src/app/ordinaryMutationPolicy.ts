import type { PersistedFinanceState } from '../domain/model';
import type { LocalStateRecovery } from './state';

export type OrdinaryMutationAction = 'write' | 'delete' | 'archive' | 'release' | 'confirm-transfer';
type BlockReason = 'legacy-pending' | 'initial-bootstrap' | 'recovery';
export interface OrdinaryMutationBlock {
  reason: BlockReason;
  message: string;
}

const writeMessages: Record<BlockReason, string> = {
  'legacy-pending': '舊版本機資料尚在先讀取雲端；完成前已停止所有帳本修改。',
  'initial-bootstrap': '正在先讀取雲端帳本；完成前本次修改未執行。',
  recovery: '本機快照仍在復原保護中；完成有效備份還原前，本次帳本修改未執行。',
};
const messages: Record<OrdinaryMutationAction, Record<BlockReason, string>> = {
  write: writeMessages,
  delete: {
    'legacy-pending': writeMessages['legacy-pending'],
    'initial-bootstrap': '正在先讀取雲端帳本；完成前本次刪除未執行。',
    recovery: '本機快照仍在復原保護中；完成有效備份還原前，本次刪除未執行。',
  },
  archive: {
    'legacy-pending': '雲端帳本尚在安全讀取；完成前本次封存未執行。',
    'initial-bootstrap': '雲端帳本尚在安全讀取；完成前本次封存未執行。',
    recovery: '本機快照仍在復原保護中；本次封存未執行。',
  },
  release: {
    'legacy-pending': '雲端帳本尚在安全讀取；完成前本次釋放未執行。',
    'initial-bootstrap': '雲端帳本尚在安全讀取；完成前本次釋放未執行。',
    recovery: '本機快照仍在復原保護中；本次釋放未執行。',
  },
  'confirm-transfer': {
    'legacy-pending': '雲端帳本尚在安全讀取；完成前無法重新確認轉帳帳戶。',
    'initial-bootstrap': '雲端帳本尚在安全讀取；完成前無法重新確認轉帳帳戶。',
    recovery: '本機快照仍在復原保護中；無法重新確認轉帳帳戶。',
  },
};

/** Ordinary controller preflight only; restore, conflict resolution and legacy decisions have separate policies. */
export function getOrdinaryMutationBlock(
  state: Pick<PersistedFinanceState, 'legacyBootstrap' | 'initialBootstrap'>,
  recovery: LocalStateRecovery | undefined,
  action: OrdinaryMutationAction,
): OrdinaryMutationBlock | undefined {
  const reason = state.legacyBootstrap?.status === 'pending' ? 'legacy-pending'
    : state.initialBootstrap ? 'initial-bootstrap'
    : recovery ? 'recovery'
    : undefined;
  return reason ? { reason, message: messages[action][reason] } : undefined;
}

export function assertOrdinaryMutationWritable(
  state: Pick<PersistedFinanceState, 'legacyBootstrap' | 'initialBootstrap'>,
  recovery: LocalStateRecovery | undefined,
  action: OrdinaryMutationAction,
): void {
  const block = getOrdinaryMutationBlock(state, recovery, action);
  if (block) throw new Error(block.message);
}
