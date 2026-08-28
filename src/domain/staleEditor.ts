import type { SyncRecord } from './model';

type EditableSyncRecord = SyncRecord & { isActive?: boolean };

export interface EditorSnapshotOptions {
  requireActive?: boolean;
  hasUnresolvedConflict?: boolean;
}

/**
 * Compare the immutable snapshot captured when an editor opened with the latest
 * record from FinanceData. Missing, deleted, archived, or changed records fail
 * closed so a stale form cannot manufacture a new conflict-clock winner.
 */
export function isEditorSnapshotStale<T extends EditableSyncRecord>(
  opened: T,
  current: T | undefined,
  options: EditorSnapshotOptions = {},
): boolean {
  if (options.hasUnresolvedConflict) return true;
  if (!current || current.id !== opened.id || current.deletedAt) return true;
  if (options.requireActive && current.isActive !== true) return true;
  return current.version !== opened.version
    || current.lastOperationId !== opened.lastOperationId;
}

export function assertFreshEditorSnapshot<T extends EditableSyncRecord>(
  opened: T,
  current: T | undefined,
  label: string,
  options: EditorSnapshotOptions = {},
): asserts current is T {
  if (options.hasUnresolvedConflict) {
    throw new Error(`${label}有未解同步衝突；資料未變更，請先在同步狀態完成處理`);
  }
  if (isEditorSnapshotStale(opened, current, options)) {
    throw new Error(`${label}已在背景更新、封存或刪除；資料未變更，請重新開啟編輯`);
  }
}
