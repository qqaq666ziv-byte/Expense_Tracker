import type { FinanceEntityName, Transfer } from '../domain/model';
import type { RemoteAdapter } from '../domain/syncEngine';

export const TRANSFER_READ_ONLY_MESSAGE = '緊急模式已啟用 transfer read-only；轉帳仍會讀取與計算，但不會新增、編輯、刪除或上傳。';

export function transferMutationsEnabled(
  mode: string,
  configuredValue?: string,
): boolean {
  return mode !== 'transfer-read-only' && configuredValue !== 'false';
}

export function assertTransferMutationAllowed(
  entity: FinanceEntityName,
  enabled: boolean,
): void {
  if (entity === 'transfers' && !enabled) throw new Error(TRANSFER_READ_ONLY_MESSAGE);
}

export function assertTransferCollectionMutationAllowed(
  current: readonly Transfer[],
  replacement: readonly Transfer[],
  enabled: boolean,
): void {
  if (!enabled && JSON.stringify(current) !== JSON.stringify(replacement)) {
    throw new Error(TRANSFER_READ_ONLY_MESSAGE);
  }
}

/**
 * Preserve schema-v4 pulls and every non-transfer sync path while keeping any
 * already queued transfer mutation durable in the outbox for a later repair.
 */
export function createTransferReadOnlyRemoteAdapter(remote: RemoteAdapter): RemoteAdapter {
  return {
    pull: (ownerId, options) => remote.pull(ownerId, options),
    apply: async (ownerId, operation) => {
      assertTransferMutationAllowed(operation.entity, false);
      return remote.apply(ownerId, operation);
    },
    applyHistoricalImportBatch: async () => {
      throw new Error(TRANSFER_READ_ONLY_MESSAGE);
    },
    ...(remote.compareAndSwap ? {
      compareAndSwap: async (ownerId, expected, replacement) => {
        assertTransferMutationAllowed(replacement.entity, false);
        return remote.compareAndSwap!(ownerId, expected, replacement);
      },
    } : {}),
  };
}

export const TRANSFER_MUTATIONS_ENABLED = transferMutationsEnabled(
  import.meta.env.MODE,
  import.meta.env.VITE_TRANSFER_MUTATIONS_ENABLED,
);
