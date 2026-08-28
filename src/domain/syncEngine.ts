import type {
  Budget,
  FinanceData,
  FinanceEntityName,
  OwnerId,
  PendingOperation,
  PersistedFinanceState,
} from './model';
import { validateFinanceData } from './backup';
import { hasSameBudgetSemantics } from './budgetEngine';
import { assertLifecycleTransition } from './lifecycle';

export type SyncEntityRecord = FinanceData[FinanceEntityName][number];

/**
 * Active updates must sort below every canonical legacy UUID. This makes an
 * equal-version delete win even when it reaches the server between the
 * preflight pull and this write. `0-` is lower than the first two characters
 * of any canonical v4 UUID. Even if a locale ignores punctuation, the all-zero
 * UUID shape sorts below the mandatory v4 version nibble (`0` versus `4`).
 */
export function activeOperationId(operationId: string = crypto.randomUUID()): string {
  return `00000000-0000-0000-0000-000000000000:active:${operationId}`;
}

const BUDGET_CONFLICT_ROLLBACK_MARKER = 'budget-conflict-rollback:';
export const UNRESOLVED_PAYLOAD_CONFLICT_PREFIX = 'unresolved same-clock payload conflict';
export const TRANSFER_DEPENDENCY_CONFLICT_PREFIX = 'transfer account changed before first cloud write';

export function hasTransferDependencyConflict(
  operation: PendingOperation,
): boolean {
  return operation.entity === 'transfers'
    && operation.lastError?.startsWith(TRANSFER_DEPENDENCY_CONFLICT_PREFIX) === true;
}

function budgetConflictRollbackOperationId(): string {
  return activeOperationId(`${BUDGET_CONFLICT_ROLLBACK_MARKER}${crypto.randomUUID()}`);
}

function isBudgetConflictRollback(operation: PendingOperation): boolean {
  return operation.record.lastOperationId.includes(`:${BUDGET_CONFLICT_ROLLBACK_MARKER}`);
}

async function batchCompensationOperationId(
  operation: PendingOperation,
): Promise<string | undefined> {
  if (!operation.batchId || operation.batchBeforeRecord === undefined) return undefined;
  const identity = JSON.stringify([
    operation.batchId,
    operation.entity,
    operation.recordId,
    operation.id,
    operation.record.ownerId,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, '0')
  )).join('');
  return operation.batchBeforeRecord === null || operation.batchBeforeRecord.deletedAt
    ? `tombstone:batch-compensation:${fingerprint}`
    : activeOperationId(`batch-compensation:${fingerprint}`);
}

async function batchCompensationOperation(
  operation: PendingOperation,
  remoteRecord: SyncEntityRecord,
  timestamp: string,
): Promise<PendingOperation | undefined> {
  const operationId = await batchCompensationOperationId(operation);
  if (!operationId) return undefined;
  const before = operation.batchBeforeRecord;
  const record = before === null
    ? {
        ...operation.record,
        version: remoteRecord.version + 1,
        updatedAt: timestamp,
        lastOperationId: operationId,
        deletedAt: timestamp,
        ...('isActive' in operation.record ? { isActive: false } : {}),
      }
    : {
        ...before,
        version: remoteRecord.version + 1,
        updatedAt: timestamp,
        lastOperationId: operationId,
      };
  return {
    ...operation,
    id: record.lastOperationId,
    record,
    attempts: 0,
    queuedAt: timestamp,
    lastError: '批次遇到同步衝突；已將先完成的成員安全補償回操作前狀態，等待整批採用雲端版本。',
  };
}

function batchRetryOperation(
  operation: PendingOperation,
  compensation: PendingOperation,
  timestamp: string,
): PendingOperation {
  const desired = {
    ...operation.record,
    version: compensation.record.version + 1,
    updatedAt: timestamp,
    lastOperationId: operation.record.deletedAt
      ? `tombstone:${crypto.randomUUID()}`
      : activeOperationId(`batch-retry:${crypto.randomUUID()}`),
  };
  return {
    ...operation,
    id: desired.lastOperationId,
    record: desired,
    attempts: 0,
    queuedAt: timestamp,
    batchBeforeRecord: structuredClone(compensation.record),
    lastError: '批次尚未完整套用；遠端已回復前態，本機完整意圖會在下次同步整批重試。',
  };
}

async function recoveredBatchRetryOperation(
  operation: PendingOperation,
  remoteRecord: RemoteRecord,
  timestamp: string,
): Promise<PendingOperation | undefined> {
  const expectedCompensationId = await batchCompensationOperationId(operation);
  if (!expectedCompensationId
    || remoteRecord.record.lastOperationId !== expectedCompensationId
    || remoteRecord.record.version <= operation.record.version) return undefined;
  const expectedPayload = operation.batchBeforeRecord === null
    ? {
        ...operation.record,
        version: remoteRecord.record.version,
        updatedAt: remoteRecord.record.updatedAt,
        lastOperationId: remoteRecord.record.lastOperationId,
        deletedAt: remoteRecord.record.deletedAt,
        ...('isActive' in operation.record ? { isActive: false } : {}),
      }
    : {
        ...operation.batchBeforeRecord,
        version: remoteRecord.record.version,
        updatedAt: remoteRecord.record.updatedAt,
        lastOperationId: remoteRecord.record.lastOperationId,
      };
  if (operation.batchBeforeRecord === null && !remoteRecord.record.deletedAt) return undefined;
  if (differingSyncRecordFields(
    operation.entity,
    expectedPayload,
    remoteRecord.record,
  ).length > 0) return undefined;
  return batchRetryOperation(operation, {
    ...operation,
    id: remoteRecord.record.lastOperationId,
    record: remoteRecord.record,
  }, timestamp);
}

export type RemoteRecord = {
  [Entity in FinanceEntityName]: {
    entity: Entity;
    record: FinanceData[Entity][number];
  };
}[FinanceEntityName];

export interface RemotePullIssue {
  stage: 'validation' | 'pull';
  message: string;
  entity: FinanceEntityName;
  recordId?: string;
}

export interface RemotePullResult {
  records: readonly RemoteRecord[];
  issues: readonly RemotePullIssue[];
}

export type RemotePullResponse = readonly RemoteRecord[] | RemotePullResult;

/**
 * External persistence seam. `apply` must durably and idempotently apply by
 * `(ownerId, operation.id)` and must not overwrite a record with a higher conflict clock.
 */
export interface RemoteAdapter {
  pull(ownerId: string): Promise<RemotePullResponse>;
  apply(ownerId: string, operation: PendingOperation): Promise<void>;
  /** Atomically replace `expected` only while its conflict clock is unchanged. */
  compareAndSwap?(
    ownerId: string,
    expected: RemoteRecord,
    replacement: PendingOperation,
  ): Promise<RemoteRecord | undefined>;
}

export interface SyncPending {
  operationId: string;
  entity: FinanceEntityName;
  recordId: string;
  attempts: number;
  lastError?: string;
}

export interface SyncFailure {
  stage: 'validation' | 'apply' | 'pull' | 'conflict';
  message: string;
  operationId?: string;
  entity?: FinanceEntityName;
  recordId?: string;
}

export interface SyncConflict {
  entity: FinanceEntityName;
  recordId: string;
  winner: 'local' | 'remote' | 'unresolved';
  reason: 'pending-local' | 'version' | 'operation-id' | 'payload';
  local: { version: number; lastOperationId: string };
  remote: { version: number; lastOperationId: string };
}

export interface SyncReport {
  ownerId: OwnerId;
  status: 'synced' | 'partial' | 'rejected';
  applied: number;
  pulled: number;
  pending: SyncPending[];
  failures: SyncFailure[];
  conflicts: SyncConflict[];
}

export interface SyncResult {
  state: PersistedFinanceState;
  report: SyncReport;
}

export function syncRecordKey(entity: FinanceEntityName, recordId: string): string {
  return `${entity}:${recordId}`;
}

/**
 * Complete the explicit user-confirmation path for a transfer that was held
 * back because one of its account dependencies changed before its first cloud
 * write. The caller must rebuild the record from the current, explicitly
 * selected accounts so both denormalized names and the conflict clock advance.
 */
export function confirmTransferDependencyConflict(
  state: PersistedFinanceState,
  replacement: FinanceData['transfers'][number],
): PersistedFinanceState {
  const key = syncRecordKey('transfers', replacement.id);
  const pending = state.outbox.find((operation) => (
    operation.entity === 'transfers' && operation.recordId === replacement.id
  ));
  const current = state.data.transfers.find((transfer) => transfer.id === replacement.id);
  if (!pending || !hasTransferDependencyConflict(pending)
    || !state.unresolvedSyncRecordKeys?.includes(key)) {
    throw new Error('這筆轉帳目前沒有待重新確認的帳戶變更。');
  }
  if (!current || current.ownerId !== state.ownerId || replacement.ownerId !== state.ownerId) {
    throw new Error('轉帳不屬於目前帳本，帳戶確認未套用。');
  }
  if (replacement.version <= current.version
    || replacement.lastOperationId === current.lastOperationId) {
    throw new Error('重新確認必須建立較新的轉帳版本。');
  }
  const source = state.data.accounts.find((account) => account.id === replacement.sourceAccountId);
  const destination = state.data.accounts.find(
    (account) => account.id === replacement.destinationAccountId,
  );
  if (!source || !destination || source.ownerId !== state.ownerId || destination.ownerId !== state.ownerId
    || source.deletedAt || destination.deletedAt || !source.isActive || !destination.isActive) {
    throw new Error('請重新選擇兩個目前可用的帳戶。');
  }
  if (source.id === destination.id
    || replacement.sourceAccountName !== source.name
    || replacement.destinationAccountName !== destination.name) {
    throw new Error('帳戶選擇或名稱快照不是目前明確確認的版本。');
  }

  const data = replaceRecord(state.data, { entity: 'transfers', record: replacement });
  validateFinanceData(data, 'confirmed transfer account dependency');
  const outbox = state.outbox.map((operation) => (
    operation === pending
      ? {
          ...operation,
          id: replacement.lastOperationId,
          record: replacement,
          attempts: 0,
          queuedAt: replacement.updatedAt,
          lastError: undefined,
        }
      : operation
  ));
  const unresolvedSyncRecordKeys = state.unresolvedSyncRecordKeys.filter(
    (candidate) => candidate !== key,
  );
  const remainingErrors = outbox.flatMap((operation) => (
    operation.lastError ? [operation.lastError] : []
  ));
  return {
    ...state,
    data,
    outbox,
    unresolvedSyncRecordKeys: unresolvedSyncRecordKeys.length > 0
      ? unresolvedSyncRecordKeys
      : undefined,
    lastSyncError: remainingErrors.length > 0 ? [...new Set(remainingErrors)].join('; ') : undefined,
  };
}

export function hasUnresolvedPayloadConflict(
  operations: readonly PendingOperation[],
  entity: FinanceEntityName,
  recordId: string,
  persistedKeys: readonly string[] = [],
): boolean {
  const key = syncRecordKey(entity, recordId);
  const directlyLocked = new Set([
    ...persistedKeys,
    ...operations
      .filter((operation) => operation.lastError?.startsWith(UNRESOLVED_PAYLOAD_CONFLICT_PREFIX))
      .map((operation) => syncRecordKey(operation.entity, operation.recordId)),
  ]);
  if (directlyLocked.has(key)) return true;
  const lockedBatchIds = new Set(operations.flatMap((operation) => (
    operation.batchId
      ? [operation.batchId]
      : []
  )));
  return operations.some((operation) => (
    syncRecordKey(operation.entity, operation.recordId) === key
    && operation.batchId !== undefined
    && lockedBatchIds.has(operation.batchId)
  ));
}

export function unresolvedPayloadConflictKeys(
  operations: readonly PendingOperation[],
  conflicts: readonly SyncConflict[] = [],
  persistedKeys: readonly string[] = [],
): ReadonlySet<string> {
  const keys = new Set([
    ...persistedKeys,
    ...operations
      .filter((operation) => operation.lastError?.startsWith(UNRESOLVED_PAYLOAD_CONFLICT_PREFIX))
      .map((operation) => syncRecordKey(operation.entity, operation.recordId)),
    ...conflicts
      .filter((conflict) => conflict.winner === 'unresolved')
      .map((conflict) => syncRecordKey(conflict.entity, conflict.recordId)),
  ]);
  const lockedBatchIds = new Set(operations.flatMap((operation) => (
    operation.batchId && keys.has(syncRecordKey(operation.entity, operation.recordId))
      ? [operation.batchId]
      : []
  )));
  for (const operation of operations) {
    if (operation.batchId && lockedBatchIds.has(operation.batchId)) {
      keys.add(syncRecordKey(operation.entity, operation.recordId));
    }
  }
  return keys;
}

/**
 * Resolve a record-level conflict by explicitly accepting the last validated
 * cloud record. This is the only path that clears a persisted conflict lock;
 * ordinary pulls may change clocks but cannot infer the user's intent.
 */
export function acceptRemoteConflictRecord(
  state: PersistedFinanceState,
  remoteRecord: RemoteRecord,
  remoteRecords: readonly RemoteRecord[] = [remoteRecord],
): PersistedFinanceState {
  const key = syncRecordKey(remoteRecord.entity, remoteRecord.record.id);
  const targetOperation = state.outbox.find((operation) => (
    syncRecordKey(operation.entity, operation.recordId) === key
  ));
  const targetBatchHasConflict = targetOperation?.batchId !== undefined
    && state.outbox.some((operation) => (
      operation.batchId === targetOperation.batchId
      && state.unresolvedSyncRecordKeys?.includes(
        syncRecordKey(operation.entity, operation.recordId),
      )
    ));
  if (!state.unresolvedSyncRecordKeys?.includes(key) && !targetBatchHasConflict) {
    throw new Error('這筆資料目前沒有可解除的同步衝突。');
  }
  if (remoteRecord.record.ownerId !== state.ownerId) {
    throw new Error('雲端資料不屬於目前使用者，衝突未解除。');
  }
  const acceptedOperations = targetOperation?.batchId
    ? state.outbox.filter((operation) => operation.batchId === targetOperation.batchId)
    : targetOperation ? [targetOperation] : [];
  const acceptedKeys = new Set([
    key,
    ...acceptedOperations.map((operation) => syncRecordKey(operation.entity, operation.recordId)),
  ]);
  const remoteByKey = new Map(remoteRecords.map((candidate) => [
    syncRecordKey(candidate.entity, candidate.record.id),
    candidate,
  ]));
  const preservedBeforeByKey = new Map<string, SyncEntityRecord>();
  const acceptedRemoteRecords = [...acceptedKeys].flatMap((acceptedKey) => {
    const accepted = remoteByKey.get(acceptedKey);
    if (!accepted) {
      const relatedOperation = acceptedOperations.find((operation) => (
        syncRecordKey(operation.entity, operation.recordId) === acceptedKey
      ));
      if (acceptedKey !== key && relatedOperation?.batchBeforeRecord) {
        // No cloud row cannot acknowledge an independently queued create/edit
        // that existed before the lifecycle batch absorbed this member.
        preservedBeforeByKey.set(
          acceptedKey,
          structuredClone(relatedOperation.batchBeforeRecord),
        );
      }
      return [];
    }
    if (accepted.record.ownerId !== state.ownerId) {
      throw new Error('關聯雲端資料不屬於目前使用者，衝突未解除。');
    }
    const current = (state.data[accepted.entity] as SyncEntityRecord[])
      .find((candidate) => candidate.id === accepted.record.id);
    if (!current || (
      acceptedKey === key && compareSyncRecords(accepted.record, current) < 0
    )) {
      throw new Error('雲端版本比本機舊，為避免資料回滾，衝突未解除。');
    }
    const relatedOperation = acceptedOperations.find((operation) => (
      syncRecordKey(operation.entity, operation.recordId) === acceptedKey
    ));
    const before = relatedOperation?.batchBeforeRecord;
    if (acceptedKey !== key && before) {
      const comparison = compareSyncRecords(accepted.record, before);
      const sameClockExactPayload = comparison === 0
        && differingSyncRecordFields(accepted.entity, accepted.record, before).length === 0;
      if (comparison < 0 || (comparison === 0 && !sameClockExactPayload)) {
        // A lifecycle batch may have absorbed an independently queued edit.
        // Accepting the conflicted parent must not discard that earlier intent;
        // restore it as a standalone operation and let normal sync reconcile it.
        preservedBeforeByKey.set(acceptedKey, structuredClone(before));
        return [];
      }
    }
    return [accepted];
  });
  if (!remoteByKey.has(key)) {
    throw new Error('雲端回應中找不到衝突主體，衝突未解除。');
  }
  const acceptedRemoteKeys = new Set(acceptedRemoteRecords.map((accepted) => (
    syncRecordKey(accepted.entity, accepted.record.id)
  )));

  let data = state.data;
  for (const accepted of acceptedRemoteRecords) data = replaceRecord(data, accepted);
  let outbox = state.outbox.filter((operation) => (
    !acceptedRemoteKeys.has(syncRecordKey(operation.entity, operation.recordId))
  ));
  for (const operation of acceptedOperations) {
    const operationKey = syncRecordKey(operation.entity, operation.recordId);
    const acceptedRelatedRecord = acceptedRemoteKeys.has(operationKey)
      ? remoteByKey.get(operationKey)?.record
      : undefined;
    const preservedBefore = preservedBeforeByKey.get(operationKey);
    let record = preservedBefore ?? acceptedRelatedRecord ?? operation.record;
    let requiresStandaloneOperation = !acceptedRelatedRecord;
    if (operation.entity === 'recurringRules') {
      const rule = record as FinanceData['recurringRules'][number];
      if (remoteRecord.entity === 'accounts' && rule.accountId === remoteRecord.record.id) {
        const account = remoteRecord.record as FinanceData['accounts'][number];
        const mustPause = Boolean(
          !rule.deletedAt && (!account.isActive || account.deletedAt) && rule.isActive,
        );
        const mustRefreshMirror = Boolean(
          !rule.deletedAt && !preservedBefore && rule.accountName !== account.name,
        );
        if (mustPause || mustRefreshMirror) {
          record = {
            ...rule,
            ...(mustRefreshMirror ? { accountName: account.name } : {}),
            ...(mustPause ? { isActive: false } : {}),
            version: Math.max(rule.version, operation.record.version) + 1,
            updatedAt: new Date().toISOString(),
            lastOperationId: activeOperationId(`accept-cloud-parent:${crypto.randomUUID()}`),
          };
          requiresStandaloneOperation = true;
        }
      }
      if (remoteRecord.entity === 'categories' && rule.categoryId === remoteRecord.record.id) {
        const category = remoteRecord.record as FinanceData['categories'][number];
        const mustPause = Boolean(
          !rule.deletedAt && (!category.isActive || category.deletedAt) && rule.isActive,
        );
        const mustRefreshMirror = Boolean(
          !rule.deletedAt && !preservedBefore && rule.categoryName !== category.name,
        );
        if (mustPause || mustRefreshMirror) {
          record = {
            ...rule,
            ...(mustRefreshMirror ? { categoryName: category.name } : {}),
            ...(mustPause ? { isActive: false } : {}),
            version: Math.max(rule.version, operation.record.version) + 1,
            updatedAt: new Date().toISOString(),
            lastOperationId: activeOperationId(`accept-cloud-parent:${crypto.randomUUID()}`),
          };
          requiresStandaloneOperation = true;
        }
      }
    }
    if (!requiresStandaloneOperation) continue;
    data = replaceRecord(data, { entity: operation.entity, record } as RemoteRecord);
    const pending = outbox.find((candidate) => (
      candidate.entity === operation.entity && candidate.recordId === operation.recordId
    )) ?? operation;
    outbox = [
      ...outbox.filter((candidate) => (
        candidate.entity !== operation.entity || candidate.recordId !== operation.recordId
      )),
      {
        ...pending,
        id: record.lastOperationId,
        record,
        attempts: preservedBefore || acceptedRelatedRecord ? 0 : pending.attempts,
        queuedAt: preservedBefore || acceptedRelatedRecord ? record.updatedAt : pending.queuedAt,
        batchId: undefined,
        batchBeforeRecord: undefined,
        lastError: preservedBefore
          ? '已採用批次的雲端版本；批次前已排隊的獨立修改仍保留等待同步。'
          : pending.lastError,
      },
    ];
  }
  validateFinanceData(data, 'accepted remote conflict record');
  assertLifecycleTransition(state.data, data);
  const unresolvedSyncRecordKeys = (state.unresolvedSyncRecordKeys ?? []).filter((candidate) => (
    !acceptedRemoteKeys.has(candidate)
  ));
  const remainingErrors = new Set(outbox.flatMap((operation) => (
    operation.lastError ? [operation.lastError] : []
  )));
  for (const unresolvedKey of unresolvedSyncRecordKeys) {
    remainingErrors.add(`unresolved sync conflict for ${unresolvedKey}`);
  }
  return {
    ...state,
    data,
    outbox,
    unresolvedSyncRecordKeys: unresolvedSyncRecordKeys.length > 0
      ? unresolvedSyncRecordKeys
      : undefined,
    lastSyncError: remainingErrors.size > 0 ? [...remainingErrors].join('; ') : undefined,
  };
}

const ENTITY_NAMES: readonly FinanceEntityName[] = [
  'accounts',
  'categories',
  'transactions',
  'transfers',
  'adjustments',
  'goals',
  'allocations',
  'budgets',
  'recurringRules',
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaceRecord(data: FinanceData, { entity, record }: RemoteRecord): FinanceData {
  const records = data[entity] as SyncEntityRecord[];
  const index = records.findIndex((candidate) => candidate.id === record.id);
  const nextRecords = [...records];

  if (index === -1) {
    nextRecords.push(record);
  } else {
    nextRecords[index] = record;
  }

  return { ...data, [entity]: nextRecords } as FinanceData;
}

function findRecord(data: FinanceData, { entity, record }: RemoteRecord): SyncEntityRecord | undefined {
  return (data[entity] as SyncEntityRecord[]).find((candidate) => candidate.id === record.id);
}

/** Compare the documented conflict clock: version first, then operation id. */
export function compareSyncRecords(left: SyncEntityRecord, right: SyncEntityRecord): number {
  if (left.version !== right.version) {
    return left.version > right.version ? 1 : -1;
  }
  if (left.lastOperationId === right.lastOperationId) {
    return 0;
  }
  return left.lastOperationId > right.lastOperationId ? 1 : -1;
}

function canonicalTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? value : timestamp;
}

function canonicalValue(key: string, value: unknown): unknown {
  if (key === 'updatedAt' || key === 'deletedAt') return canonicalTimestamp(value);
  if (Array.isArray(value)) return value.map((item) => canonicalValue('', item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, canonicalValue(childKey, child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function normalizedRecord(entity: FinanceEntityName, record: SyncEntityRecord): Record<string, unknown> {
  const normalized = { ...record } as Record<string, unknown>;
  // The database stores this optional migration-review flag with DEFAULT false.
  // Absence in an older local snapshot and an explicit false from PostgREST are
  // therefore the same logical payload.
  if (entity === 'accounts' && normalized.requiresReview === undefined) {
    normalized.requiresReview = false;
  }
  return normalized;
}

export function differingSyncRecordFields(
  entity: FinanceEntityName,
  left: SyncEntityRecord,
  right: SyncEntityRecord,
): string[] {
  const leftRecord = normalizedRecord(entity, left);
  const rightRecord = normalizedRecord(entity, right);
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].filter((key) => (
    JSON.stringify(canonicalValue(key, leftRecord[key]))
    !== JSON.stringify(canonicalValue(key, rightRecord[key]))
  )).sort();
}

const recordKey = syncRecordKey;

function normalizePullResponse(response: RemotePullResponse): RemotePullResult {
  if (Array.isArray(response)) return { records: response, issues: [] };
  return response as RemotePullResult;
}

function reconcileRecord(
  data: FinanceData,
  remoteRecord: RemoteRecord,
  pendingKeys: ReadonlySet<string>,
  conflicts: SyncConflict[],
  failures: SyncFailure[],
): FinanceData {
  const localRecord = findRecord(data, remoteRecord);
  if (localRecord === undefined) {
    return replaceRecord(data, remoteRecord);
  }

  const comparison = compareSyncRecords(localRecord, remoteRecord.record);
  if (comparison === 0) {
    const differingFields = differingSyncRecordFields(
      remoteRecord.entity,
      localRecord,
      remoteRecord.record,
    );
    if (differingFields.length > 0) {
      conflicts.push({
        entity: remoteRecord.entity,
        recordId: remoteRecord.record.id,
        winner: 'unresolved',
        reason: 'payload',
        local: {
          version: localRecord.version,
          lastOperationId: localRecord.lastOperationId,
        },
        remote: {
          version: remoteRecord.record.version,
          lastOperationId: remoteRecord.record.lastOperationId,
        },
      });
      failures.push({
        stage: 'conflict',
        message: `${UNRESOLVED_PAYLOAD_CONFLICT_PREFIX} for ${remoteRecord.entity}/${remoteRecord.record.id} at fields: ${differingFields.join(', ')}`,
        entity: remoteRecord.entity,
        recordId: remoteRecord.record.id,
      });
    }
    return data;
  }

  const localWins = comparison > 0;
  const hasPendingLocalMutation = pendingKeys.has(
    recordKey(remoteRecord.entity, remoteRecord.record.id),
  );
  if (remoteRecord.record.deletedAt && !localRecord.deletedAt && hasPendingLocalMutation) {
    conflicts.push({
      entity: remoteRecord.entity,
      recordId: remoteRecord.record.id,
      winner: 'remote',
      reason: localRecord.version === remoteRecord.record.version ? 'operation-id' : 'version',
      local: {
        version: localRecord.version,
        lastOperationId: localRecord.lastOperationId,
      },
      remote: {
        version: remoteRecord.record.version,
        lastOperationId: remoteRecord.record.lastOperationId,
      },
    });
    return replaceRecord(data, remoteRecord);
  }
  if (!localWins && hasPendingLocalMutation) {
    conflicts.push({
      entity: remoteRecord.entity,
      recordId: remoteRecord.record.id,
      winner: 'unresolved',
      reason: 'pending-local',
      local: {
        version: localRecord.version,
        lastOperationId: localRecord.lastOperationId,
      },
      remote: {
        version: remoteRecord.record.version,
        lastOperationId: remoteRecord.record.lastOperationId,
      },
    });
    failures.push({
      stage: 'conflict',
      message: `pending local mutation for ${remoteRecord.entity}/${remoteRecord.record.id} was superseded by the remote clock; the local edit or deletion remains pending for explicit review`,
      entity: remoteRecord.entity,
      recordId: remoteRecord.record.id,
    });
    // A queued edit/delete is user intent. Keep both its local snapshot and
    // outbox entry instead of silently replacing it with the remote record.
    return data;
  }
  conflicts.push({
    entity: remoteRecord.entity,
    recordId: remoteRecord.record.id,
    winner: localWins ? 'local' : 'remote',
    reason: localWins && hasPendingLocalMutation
      ? 'pending-local'
      : localRecord.version === remoteRecord.record.version
        ? 'operation-id'
        : 'version',
    local: {
      version: localRecord.version,
      lastOperationId: localRecord.lastOperationId,
    },
    remote: {
      version: remoteRecord.record.version,
      lastOperationId: remoteRecord.record.lastOperationId,
    },
  });

  return localWins ? data : replaceRecord(data, remoteRecord);
}

function pendingReport(outbox: readonly PendingOperation[]): SyncPending[] {
  return outbox.map((operation) => ({
    operationId: operation.id,
    entity: operation.entity,
    recordId: operation.recordId,
    attempts: operation.attempts,
    ...(operation.lastError === undefined ? {} : { lastError: operation.lastError }),
  }));
}

function emptyRemoteData(settings: FinanceData['settings']): FinanceData {
  return {
    accounts: [],
    categories: [],
    transactions: [],
    transfers: [],
    adjustments: [],
    goals: [],
    allocations: [],
    budgets: [],
    recurringRules: [],
    settings: structuredClone(settings),
  };
}

function validateOwnership(
  state: PersistedFinanceState,
  authenticatedOwnerId: string,
): SyncFailure[] {
  if (state.ownerId === 'guest') {
    return [{
      stage: 'validation',
      message: 'guest state is local-only and cannot be synchronized to an authenticated account',
    }];
  }

  if (authenticatedOwnerId === 'guest' || state.ownerId !== authenticatedOwnerId) {
    return [{
      stage: 'validation',
      message: `state owner ${state.ownerId} does not match authenticated owner ${authenticatedOwnerId}`,
    }];
  }

  let failures: SyncFailure[] = [];
  for (const entity of ENTITY_NAMES) {
    for (const record of state.data[entity] as SyncEntityRecord[]) {
      if (record.ownerId !== state.ownerId) {
        failures.push({
          stage: 'validation',
          message: `${entity}/${record.id} belongs to ${record.ownerId}, not ${state.ownerId}`,
          entity,
          recordId: record.id,
        });
      }
    }
  }

  for (const operation of state.outbox) {
    if (operation.record.ownerId !== state.ownerId) {
      failures.push({
        stage: 'validation',
        message: `operation ${operation.id} belongs to ${operation.record.ownerId}, not ${state.ownerId}`,
        operationId: operation.id,
        entity: operation.entity,
        recordId: operation.recordId,
      });
    }
    if (operation.recordId !== operation.record.id) {
      failures.push({
        stage: 'validation',
        message: `operation ${operation.id} recordId ${operation.recordId} does not match record ${operation.record.id}`,
        operationId: operation.id,
        entity: operation.entity,
        recordId: operation.recordId,
      });
    }
    if (operation.id !== operation.record.lastOperationId) {
      failures.push({
        stage: 'validation',
        message: `operation ${operation.id} does not match lastOperationId ${operation.record.lastOperationId}`,
        operationId: operation.id,
        entity: operation.entity,
        recordId: operation.recordId,
      });
    }
    if (operation.batchBeforeRecord !== undefined
      && operation.batchBeforeRecord !== null
      && (operation.batchBeforeRecord.ownerId !== state.ownerId
        || operation.batchBeforeRecord.id !== operation.recordId)) {
      failures.push({
        stage: 'validation',
        message: `operation ${operation.id} has an invalid batch before-record`,
        operationId: operation.id,
        entity: operation.entity,
        recordId: operation.recordId,
      });
    }
    if ((operation.batchId === undefined) !== (operation.batchBeforeRecord === undefined)) {
      failures.push({
        stage: 'validation',
        message: `operation ${operation.id} has incomplete batch recovery metadata`,
        operationId: operation.id,
        entity: operation.entity,
        recordId: operation.recordId,
      });
    }
  }
  const bootstrap = state.legacyBootstrap;
  if (bootstrap !== undefined) {
    try {
      validateFinanceData(bootstrap.candidate, 'authenticated legacy candidate');
    } catch (error) {
      failures.push({
        stage: 'validation',
        message: `Invalid authenticated legacy candidate: ${errorMessage(error)}`,
      });
    }
    for (const entity of ENTITY_NAMES) {
      for (const record of bootstrap.candidate[entity] as SyncEntityRecord[]) {
        if (record.ownerId !== state.ownerId) {
          failures.push({
            stage: 'validation',
            message: `authenticated legacy candidate ${entity}/${record.id} belongs to ${record.ownerId}, not ${state.ownerId}`,
            entity,
            recordId: record.id,
          });
        }
      }
    }
    const candidateTransactionIds = new Set(
      bootstrap.candidate.transactions.map((record) => record.id),
    );
    const seenUnsyncedIds = new Set<string>();
    for (const id of bootstrap.unsyncedTransactionIds) {
      if (!candidateTransactionIds.has(id) || seenUnsyncedIds.has(id)) {
        failures.push({
          stage: 'validation',
          message: `authenticated legacy candidate has invalid unsynced transaction ${id}`,
          entity: 'transactions',
          recordId: id,
        });
      }
      seenUnsyncedIds.add(id);
    }
    if (bootstrap.status === 'pending' && state.outbox.length > 0) {
      failures.push({
        stage: 'validation',
        message: 'pending authenticated legacy bootstrap cannot contain remote operations',
      });
    }
  }
  const initialBootstrap = state.initialBootstrap;
  if (initialBootstrap !== undefined) {
    try {
      validateFinanceData(initialBootstrap.candidate, 'authenticated initial bootstrap candidate');
    } catch (error) {
      failures.push({
        stage: 'validation',
        message: `Invalid authenticated initial bootstrap: ${errorMessage(error)}`,
      });
    }
    for (const entity of ENTITY_NAMES) {
      for (const record of initialBootstrap.candidate[entity] as SyncEntityRecord[]) {
        if (record.ownerId !== state.ownerId) {
          failures.push({
            stage: 'validation',
            message: `authenticated initial bootstrap ${entity}/${record.id} belongs to ${record.ownerId}, not ${state.ownerId}`,
            entity,
            recordId: record.id,
          });
        }
      }
    }
    const operationKeys = new Set<string>();
    for (const operation of initialBootstrap.pendingOperations) {
      const key = recordKey(operation.entity, operation.recordId);
      if (operation.record.ownerId !== state.ownerId
        || operation.recordId !== operation.record.id
        || operation.id !== operation.record.lastOperationId
        || operationKeys.has(key)) {
        failures.push({
          stage: 'validation',
          message: `invalid preserved operation ${operation.id} in authenticated initial bootstrap`,
          operationId: operation.id,
          entity: operation.entity,
          recordId: operation.recordId,
        });
      }
      operationKeys.add(key);
    }
    if (initialBootstrap.status === 'pending' && state.outbox.length > 0) {
      failures.push({
        stage: 'validation',
        message: 'authenticated initial bootstrap must quarantine operations until cloud pull',
      });
    }
    if (initialBootstrap.status === 'seeding'
      && initialBootstrap.pendingOperations.length > 0) {
      failures.push({
        stage: 'validation',
        message: 'authenticated seeding bootstrap must keep retryable operations in the outbox',
      });
    }
  }
  return failures;
}

async function syncAuthenticatedLegacyBootstrap(
  state: PersistedFinanceState,
  authenticatedOwnerId: string,
  remote: RemoteAdapter,
  now: () => string,
): Promise<SyncResult> {
  const bootstrap = state.legacyBootstrap;
  if (bootstrap?.status !== 'pending') {
    throw new Error('authenticated legacy bootstrap is not pending');
  }

  let pulled = 0;
  const failures: SyncFailure[] = [];
  let remoteData = emptyRemoteData(state.data.settings);
  try {
    const pullResult = normalizePullResponse(await remote.pull(authenticatedOwnerId));
    pulled = pullResult.records.length;
    failures.push(...pullResult.issues.map((issue) => ({ ...issue })));
    for (const remoteRecord of pullResult.records) {
      if (remoteRecord.record.ownerId !== authenticatedOwnerId) {
        failures.push({
          stage: 'validation',
          message: `${remoteRecord.entity}/${remoteRecord.record.id} belongs to ${remoteRecord.record.ownerId}, not ${authenticatedOwnerId}`,
          entity: remoteRecord.entity,
          recordId: remoteRecord.record.id,
        });
        continue;
      }
      remoteData = replaceRecord(remoteData, remoteRecord);
    }
  } catch (error) {
    failures.push({
      stage: 'pull',
      message: errorMessage(error),
    });
  }
  if (failures.length === 0) {
    try {
      validateFinanceData(remoteData, 'authenticated legacy remote bootstrap graph');
    } catch (error) {
      failures.push({
        stage: 'validation',
        message: errorMessage(error),
      });
    }
  }

  if (failures.length > 0) {
    const lastSyncError = failures.map((failure) => failure.message).join('; ');
    return {
      state: {
        ...state,
        lastSyncedAt: undefined,
        lastSyncError,
      },
      report: {
        ownerId: state.ownerId,
        status: 'partial',
        applied: 0,
        pulled,
        pending: [],
        failures,
        conflicts: [],
      },
    };
  }

  return {
    state: {
      ...state,
      data: remoteData,
      outbox: [],
      legacyBootstrap: { ...bootstrap, status: 'ready' },
      lastSyncedAt: now(),
      lastSyncError: undefined,
    },
    report: {
      ownerId: state.ownerId,
      status: 'synced',
      applied: 0,
      pulled,
      pending: [],
      failures: [],
      conflicts: [],
    },
  };
}

function operationsForData(data: FinanceData): PendingOperation[] {
  return ENTITY_NAMES.flatMap((entity) => (
    (data[entity] as SyncEntityRecord[]).map((record) => ({
      id: record.lastOperationId,
      entity,
      recordId: record.id,
      record,
      attempts: 0,
      queuedAt: record.updatedAt,
    }))
  ));
}

async function syncInitialAuthenticatedBootstrap(
  state: PersistedFinanceState,
  authenticatedOwnerId: string,
  remote: RemoteAdapter,
  now: () => string,
): Promise<SyncResult> {
  const bootstrap = state.initialBootstrap;
  if (bootstrap?.status !== 'pending') {
    throw new Error('authenticated initial bootstrap is not pending');
  }

  let pulled = 0;
  const failures: SyncFailure[] = [];
  let remoteData = emptyRemoteData(state.data.settings);
  let remoteHasRows = false;
  try {
    const pullResult = normalizePullResponse(await remote.pull(authenticatedOwnerId));
    pulled = pullResult.records.length;
    remoteHasRows = pullResult.records.length > 0;
    failures.push(...pullResult.issues.map((issue) => ({ ...issue })));
    for (const remoteRecord of pullResult.records) {
      if (remoteRecord.record.ownerId !== authenticatedOwnerId) {
        failures.push({
          stage: 'validation',
          message: `${remoteRecord.entity}/${remoteRecord.record.id} belongs to ${remoteRecord.record.ownerId}, not ${authenticatedOwnerId}`,
          entity: remoteRecord.entity,
          recordId: remoteRecord.record.id,
        });
        continue;
      }
      remoteData = replaceRecord(remoteData, remoteRecord);
    }
  } catch (error) {
    failures.push({ stage: 'pull', message: errorMessage(error) });
  }

  if (failures.length === 0) {
    try {
      validateFinanceData(remoteData, 'authenticated initial remote bootstrap graph');
    } catch (error) {
      failures.push({ stage: 'validation', message: errorMessage(error) });
    }
  }
  if (failures.length > 0) {
    const lastSyncError = failures.map((failure) => failure.message).join('; ');
    return {
      state: { ...state, lastSyncedAt: undefined, lastSyncError },
      report: {
        ownerId: state.ownerId,
        status: 'partial',
        applied: 0,
        pulled,
        pending: pendingReport(bootstrap.pendingOperations),
        failures,
        conflicts: [],
      },
    };
  }

  if (remoteHasRows && bootstrap.pendingOperations.length === 0) {
    return {
      state: {
        ...state,
        data: remoteData,
        outbox: [],
        initialBootstrap: undefined,
        lastSyncedAt: now(),
        lastSyncError: undefined,
      },
      report: {
        ownerId: state.ownerId,
        status: 'synced',
        applied: 0,
        pulled,
        pending: [],
        failures: [],
        conflicts: [],
      },
    };
  }

  let stagedData = structuredClone(remoteHasRows ? remoteData : bootstrap.candidate);
  let stagedOutbox = remoteHasRows ? [] : operationsForData(bootstrap.candidate);
  for (const operation of bootstrap.pendingOperations) {
    stagedData = replaceRecord(stagedData, {
      entity: operation.entity,
      record: operation.record,
    } as RemoteRecord);
    const key = recordKey(operation.entity, operation.recordId);
    stagedOutbox = [
      ...stagedOutbox.filter((candidate) => recordKey(candidate.entity, candidate.recordId) !== key),
      structuredClone(operation),
    ];
  }
  try {
    validateFinanceData(stagedData, 'authenticated initial bootstrap replay graph');
  } catch (error) {
    const failure: SyncFailure = {
      stage: 'validation',
      message: `Preserved local mutations require review after cloud hydration: ${errorMessage(error)}`,
    };
    return {
      state: { ...state, lastSyncedAt: undefined, lastSyncError: failure.message },
      report: {
        ownerId: state.ownerId,
        status: 'partial',
        applied: 0,
        pulled,
        pending: pendingReport(bootstrap.pendingOperations),
        failures: [failure],
        conflicts: [],
      },
    };
  }

  const staged: PersistedFinanceState = {
    ...state,
    data: stagedData,
    outbox: stagedOutbox,
    initialBootstrap: undefined,
    lastSyncedAt: undefined,
    lastSyncError: undefined,
  };
  const synced = await syncFinanceState(staged, authenticatedOwnerId, remote, now);
  const initialBootstrap = synced.state.outbox.length > 0
    ? { ...bootstrap, status: 'seeding' as const, pendingOperations: [] }
    : undefined;
  return {
    state: { ...synced.state, initialBootstrap },
    report: { ...synced.report, pulled: pulled + synced.report.pulled },
  };
}

/**
 * Store the latest local snapshot and its retryable operation in one step.
 * A delete uses the same record shape with `deletedAt` set (a tombstone).
 */
export function enqueueSyncRecord<E extends FinanceEntityName>(
  state: PersistedFinanceState,
  entity: E,
  record: FinanceData[E][number],
  queuedAt: string = record.updatedAt,
  batchId?: string,
): PersistedFinanceState {
  if (state.ownerId === 'guest') {
    throw new Error('guest state is local-only and cannot enqueue remote sync operations');
  }
  if (state.legacyBootstrap?.status === 'pending') {
    throw new Error('authenticated legacy bootstrap must finish its remote pull before local mutations');
  }
  if (state.initialBootstrap) {
    throw new Error('authenticated initial bootstrap must finish its remote pull before local mutations');
  }
  if (record.ownerId !== state.ownerId) {
    throw new Error(`record ${record.id} belongs to ${record.ownerId}, not ${state.ownerId}`);
  }
  if (record.lastOperationId.length === 0) {
    throw new Error('lastOperationId is required for an idempotent sync operation');
  }

  const syncRecord = record as SyncEntityRecord;
  const existingRecord = (state.data[entity] as SyncEntityRecord[])
    .find((candidate) => candidate.id === syncRecord.id);
  const existingOperation = state.outbox.find((operation) => (
    operation.entity === entity && operation.recordId === syncRecord.id
  ));
  const effectiveBatchId = existingOperation?.batchId ?? batchId;
  const nextOperation: PendingOperation = {
    id: syncRecord.lastOperationId,
    entity,
    recordId: syncRecord.id,
    record: syncRecord,
    attempts: 0,
    queuedAt,
    ...(effectiveBatchId ? {
      batchId: effectiveBatchId,
      batchBeforeRecord: existingOperation?.batchBeforeRecord
        ?? (existingRecord ? structuredClone(existingRecord) : null),
    } : {}),
  };

  return {
    ...state,
    data: replaceRecord(state.data, { entity, record: syncRecord } as RemoteRecord),
    outbox: [
      ...state.outbox.filter(
        (operation) => operation.entity !== entity || operation.recordId !== syncRecord.id,
      ),
      nextOperation,
    ],
  };
}

export async function syncFinanceState(
  state: PersistedFinanceState,
  authenticatedOwnerId: string,
  remote: RemoteAdapter,
  now: () => string = () => new Date().toISOString(),
): Promise<SyncResult> {
  const validationFailures = validateOwnership(state, authenticatedOwnerId);
  if (validationFailures.length > 0) {
    return {
      state,
      report: {
        ownerId: state.ownerId,
        status: 'rejected',
        applied: 0,
        pulled: 0,
        pending: pendingReport(state.outbox),
        failures: validationFailures,
        conflicts: [],
      },
    };
  }
  if (state.legacyBootstrap?.status === 'pending') {
    return syncAuthenticatedLegacyBootstrap(state, authenticatedOwnerId, remote, now);
  }
  if (state.initialBootstrap?.status === 'pending') {
    return syncInitialAuthenticatedBootstrap(state, authenticatedOwnerId, remote, now);
  }

  let failures: SyncFailure[] = [];
  const conflicts: SyncConflict[] = [];
  const remaining: PendingOperation[] = [];
  const appliedActiveBudgetOperations: PendingOperation[] = [];
  const unresolvedKeys = new Set(state.unresolvedSyncRecordKeys ?? []);
  const unresolvedBatchIds = new Set(state.outbox.flatMap((operation) => (
    operation.batchId && unresolvedKeys.has(recordKey(operation.entity, operation.recordId))
      ? [operation.batchId]
      : []
  )));
  let applied = 0;

  // Pull before active writes to resolve known tombstones and legacy semantic
  // budget conflicts. The low active-operation prefix separately closes the
  // race where a legacy UUID tombstone arrives after this preflight.
  let preflightBlockedKeys = new Set<string>();
  const preflightBlockedReasons = new Map<string, string>();
  const preflightDeactivatedBudgetKeys = new Set<string>();
  const preflightBudgetOverrides = new Map<string, PendingOperation>();
  const preflightApplyOverrides = new Map<string, PendingOperation>();
  const preflightOptimisticBudgets = new Map<string, Budget>();
  const preflightOptimisticRecords = new Map<string, RemoteRecord>();
  if (state.outbox.length > 0) {
    try {
      const preflight = normalizePullResponse(await remote.pull(authenticatedOwnerId));
      const blockEveryActiveWrite = preflight.issues.some((issue) => !issue.recordId)
        || preflight.records.some((entry) => entry.record.ownerId !== authenticatedOwnerId);
      preflightBlockedKeys = new Set([
        ...preflight.records
          .filter((entry) => entry.record.ownerId === authenticatedOwnerId && Boolean(entry.record.deletedAt))
          .map((entry) => recordKey(entry.entity, entry.record.id)),
        ...preflight.issues
          .filter((issue) => issue.recordId)
          .map((issue) => recordKey(issue.entity, issue.recordId!)),
        ...(blockEveryActiveWrite
          ? state.outbox.map((operation) => recordKey(operation.entity, operation.recordId))
          : []),
      ]);
      for (const issue of preflight.issues) {
        if (!issue.recordId) continue;
        preflightBlockedReasons.set(
          recordKey(issue.entity, issue.recordId),
          issue.message,
        );
      }
      if (blockEveryActiveWrite) {
        for (const operation of state.outbox) {
          preflightBlockedReasons.set(
            recordKey(operation.entity, operation.recordId),
            '雲端回應未通過擁有者或資料完整性驗證；待同步資料未上傳。',
          );
        }
      }
      const preflightByKey = new Map(preflight.records
        .filter((entry) => entry.record.ownerId === authenticatedOwnerId)
        .map((entry) => [recordKey(entry.entity, entry.record.id), entry]));
      for (const [transferIndex, operation] of state.outbox.entries()) {
        if (operation.entity !== 'transfers' || operation.record.deletedAt) continue;
        const transferKey = recordKey('transfers', operation.recordId);
        // Existing cloud transfers use the ordinary record conflict clock. This
        // dependency gate is specifically for a local create whose account
        // context changed before its first durable cloud write.
        if (preflightByKey.has(transferKey)) continue;
        const transfer = operation.record as FinanceData['transfers'][number];
        const changedEndpoint = [transfer.sourceAccountId, transfer.destinationAccountId]
          .find((accountId) => {
            const accountKey = recordKey('accounts', accountId);
            const localAccount = state.data.accounts.find((account) => account.id === accountId);
            const remoteAccount = preflightByKey.get(accountKey);
            if (localAccount && remoteAccount?.entity === 'accounts'
              && differingSyncRecordFields('accounts', localAccount, remoteAccount.record).length === 0) {
              return false;
            }
            const parentOperationIndex = state.outbox.findIndex((candidate) => (
              candidate.entity === 'accounts' && candidate.recordId === accountId
            ));
            const parentOperation = parentOperationIndex >= 0
              ? state.outbox[parentOperationIndex]
              : undefined;
            const parentWillEstablishExactLocalState = Boolean(
              localAccount
              && parentOperation
              && parentOperationIndex < transferIndex
              && !unresolvedKeys.has(accountKey)
              && !preflightBlockedKeys.has(accountKey)
              && differingSyncRecordFields('accounts', parentOperation.record, localAccount).length === 0
              && (!remoteAccount || compareSyncRecords(parentOperation.record, remoteAccount.record) > 0),
            );
            return !parentWillEstablishExactLocalState;
          });
        if (!changedEndpoint) continue;
        const reason = `${TRANSFER_DEPENDENCY_CONFLICT_PREFIX}: account/${changedEndpoint}; `
          + '請重新開啟轉帳並明確確認來源與目的帳戶。';
        preflightBlockedKeys.add(transferKey);
        preflightBlockedReasons.set(transferKey, reason);
      }
      for (const operation of state.outbox.filter((candidate) => candidate.batchId)) {
        const key = recordKey(operation.entity, operation.recordId);
        const remoteRecord = preflightByKey.get(key);
        if (!remoteRecord) continue;
        const recoveredRetry = await recoveredBatchRetryOperation(operation, remoteRecord, now());
        if (recoveredRetry) {
          preflightBlockedKeys.delete(key);
          preflightBlockedReasons.delete(key);
          preflightApplyOverrides.set(key, recoveredRetry);
          preflightOptimisticRecords.set(key, {
            entity: recoveredRetry.entity,
            record: recoveredRetry.record,
          } as RemoteRecord);
          continue;
        }
        const comparison = compareSyncRecords(operation.record, remoteRecord.record);
        const divergentSameClock = comparison === 0 && differingSyncRecordFields(
          operation.entity,
          operation.record,
          remoteRecord.record,
        ).length > 0;
        if (comparison < 0 || divergentSameClock) {
          preflightBlockedKeys.add(key);
          preflightBlockedReasons.set(
            key,
            `同一批次的 ${operation.entity}/${operation.recordId} 與雲端版本衝突；整批未上傳。`,
          );
        }
      }
      const remoteBudgets = preflight.records
        .filter((entry): entry is Extract<RemoteRecord, { entity: 'budgets' }> => (
          entry.entity === 'budgets'
          && entry.record.ownerId === authenticatedOwnerId
          && !entry.record.deletedAt
        ))
        .map((entry) => entry.record);
      const remoteActiveBudgets = remoteBudgets.filter((budget) => budget.isActive);
      for (const operation of state.outbox) {
        if (
          operation.entity !== 'budgets'
          || operation.record.deletedAt
        ) continue;
        const candidate = operation.record as Budget;
        const key = recordKey(operation.entity, operation.recordId);
        if (state.unresolvedSyncRecordKeys?.includes(key)) continue;
        if (!candidate.isActive) {
          const sameRemoteRecord = remoteBudgets.find((budget) => budget.id === candidate.id);
          if (!sameRemoteRecord) continue;
          const candidateComparison = compareSyncRecords(candidate, sameRemoteRecord);
          if (candidateComparison > 0) {
            // The queued inactive edit owns the newer clock. Send its complete
            // payload instead of replacing it merely because both sides happen
            // to be inactive.
            continue;
          }
          if (candidateComparison === 0) {
            const differingFields = differingSyncRecordFields(
              'budgets',
              candidate,
              sameRemoteRecord,
            );
            if (differingFields.length > 0) {
              // Same-clock payload divergence must remain pending for the
              // ordinary reconciliation path to expose as unresolved.
              continue;
            }
          }
          const timestamp = now();
          const semanticConflictStillActive = remoteActiveBudgets.some((budget) => (
            budget.id !== sameRemoteRecord.id && hasSameBudgetSemantics(budget, sameRemoteRecord)
          ));
          if (
            !sameRemoteRecord.isActive
            || !isBudgetConflictRollback(operation)
            || !semanticConflictStillActive
          ) {
            const exact: PendingOperation = {
              id: sameRemoteRecord.lastOperationId,
              entity: 'budgets',
              recordId: sameRemoteRecord.id,
              record: sameRemoteRecord,
              attempts: 0,
              queuedAt: timestamp,
            };
            preflightApplyOverrides.set(key, exact);
            preflightOptimisticBudgets.set(key, sameRemoteRecord);
            continue;
          }
          const rollbackId = budgetConflictRollbackOperationId();
          const archived: Budget = {
            ...sameRemoteRecord,
            version: sameRemoteRecord.version + 1,
            updatedAt: timestamp,
            lastOperationId: rollbackId,
            isActive: false,
          };
          preflightApplyOverrides.set(key, {
            id: rollbackId,
            entity: 'budgets',
            recordId: archived.id,
            record: archived,
            attempts: 0,
            queuedAt: timestamp,
          });
          preflightOptimisticBudgets.set(key, archived);
          continue;
        }
        const conflict = remoteActiveBudgets.find((budget) => (
          budget.id !== candidate.id && hasSameBudgetSemantics(budget, candidate)
        ));
        if (!conflict) continue;
        preflightBlockedKeys.add(key);
        preflightBlockedReasons.set(
          key,
          `雲端有效預算 ${conflict.id} 已使用相同範圍、週期與分類；本機預算未啟用。`,
        );
        const sameRemoteRecord = remoteActiveBudgets.find((budget) => budget.id === candidate.id);
        if (!sameRemoteRecord) {
          // This local create has never reached the server. Reject only the
          // attempted activation and preserve its fields as an archived,
          // retryable record; never alter an existing remote duplicate here.
          preflightDeactivatedBudgetKeys.add(key);
        } else if (
          sameRemoteRecord.version === candidate.version
          && sameRemoteRecord.lastOperationId === operation.id
        ) {
          // A previous apply succeeded but its semantic confirmation pull did
          // not. We may safely roll back only this exact pending activation;
          // unrelated pre-existing Production duplicates remain untouched.
          const timestamp = now();
          const rollbackId = budgetConflictRollbackOperationId();
          const archived: Budget = {
            ...sameRemoteRecord,
            version: sameRemoteRecord.version + 1,
            updatedAt: timestamp,
            lastOperationId: rollbackId,
            isActive: false,
          };
          preflightDeactivatedBudgetKeys.add(key);
          preflightBudgetOverrides.set(key, {
            id: rollbackId,
            entity: 'budgets',
            recordId: archived.id,
            record: archived,
            attempts: 0,
            queuedAt: timestamp,
            lastError: preflightBlockedReasons.get(key),
          });
        }
      }
      const preflightBlockedBatchIds = new Set(state.outbox.flatMap((operation) => {
        const key = recordKey(operation.entity, operation.recordId);
        const blocksThisOperation = preflightBlockedKeys.has(key)
          && (!operation.record.deletedAt || preflightBlockedReasons.has(key));
        return operation.batchId && blocksThisOperation
          ? [operation.batchId]
          : [];
      }));
      for (const operation of state.outbox) {
        if (!operation.batchId || !preflightBlockedBatchIds.has(operation.batchId)) continue;
        const key = recordKey(operation.entity, operation.recordId);
        preflightBlockedKeys.add(key);
        if (!preflightBlockedReasons.has(key)) {
          preflightBlockedReasons.set(key, '同一批次的另一筆資料有同步衝突；為避免部分套用，整批未上傳。');
        }
      }
    } catch (error) {
      return {
        state: {
          ...state,
          lastSyncError: `preflight pull failed; no pending writes were sent: ${errorMessage(error)}`,
        },
        report: {
          ownerId: state.ownerId,
          status: 'partial',
          applied: 0,
          pulled: 0,
          pending: pendingReport(state.outbox),
          failures: [{ stage: 'pull', message: `preflight pull failed; no pending writes were sent: ${errorMessage(error)}` }],
          conflicts: [],
        },
      };
    }
  }

  for (const queuedOperation of state.outbox) {
    const key = recordKey(queuedOperation.entity, queuedOperation.recordId);
    const operation = preflightApplyOverrides.get(key) ?? queuedOperation;
    if (
      unresolvedKeys.has(key)
      || (queuedOperation.batchId !== undefined && unresolvedBatchIds.has(queuedOperation.batchId))
    ) {
      const message = hasTransferDependencyConflict(queuedOperation)
        ? queuedOperation.lastError!
        : `unresolved sync conflict for ${operation.entity}/${operation.recordId}; pending write was not sent`;
      remaining.push({ ...operation, lastError: message });
      failures.push({
        stage: 'conflict',
        message,
        operationId: operation.id,
        entity: operation.entity,
        recordId: operation.recordId,
      });
      continue;
    }
    if (
      preflightBlockedKeys.has(key)
      && (!operation.record.deletedAt || preflightBlockedReasons.has(key))
    ) {
      const reason = preflightBlockedReasons.get(key);
      if (reason === undefined) {
        remaining.push(operation);
      } else {
        const override = preflightBudgetOverrides.get(key);
        const safeRecord = preflightDeactivatedBudgetKeys.has(key)
          ? { ...operation.record, isActive: false }
          : operation.record;
        remaining.push(override ?? {
          ...operation,
          record: safeRecord,
          attempts: operation.attempts + 1,
          lastError: reason,
        });
      }
      if (reason !== undefined) {
        failures.push({
          stage: 'apply',
          message: reason,
          operationId: operation.id,
          entity: operation.entity,
          recordId: operation.recordId,
        });
      }
      continue;
    }
    try {
      await remote.apply(authenticatedOwnerId, operation);
      applied += 1;
      if (
        operation.entity === 'budgets'
        && !operation.record.deletedAt
        && (operation.record as Budget).isActive
      ) {
        appliedActiveBudgetOperations.push(operation);
      }
    } catch (error) {
      const message = errorMessage(error);
      remaining.push({
        ...operation,
        attempts: operation.attempts + 1,
        lastError: message,
      });
      failures.push({
        stage: 'apply',
        message,
        operationId: operation.id,
        entity: operation.entity,
        recordId: operation.recordId,
      });
    }
  }

  let data = state.data;
  for (const [key, budget] of preflightOptimisticBudgets) {
    if (!state.outbox.some((operation) => recordKey(operation.entity, operation.recordId) === key)) continue;
    data = replaceRecord(data, { entity: 'budgets', record: budget });
  }
  for (const [key, record] of preflightOptimisticRecords) {
    if (!state.outbox.some((operation) => recordKey(operation.entity, operation.recordId) === key)) continue;
    data = replaceRecord(data, record);
  }

  // A lifecycle batch is acknowledged only as a unit. If one member was
  // blocked or failed, retain every original member (including idempotently
  // applied members) so a retry or explicit cloud resolution still has the
  // complete manifest.
  const incompleteBatchIds = new Set(remaining.flatMap((operation) => (
    operation.batchId ? [operation.batchId] : []
  )));
  if (incompleteBatchIds.size > 0) {
    const retainedByKey = new Map(
      remaining.map((operation) => [recordKey(operation.entity, operation.recordId), operation]),
    );
    for (const operation of state.outbox) {
      if (!operation.batchId || !incompleteBatchIds.has(operation.batchId)) continue;
      const key = recordKey(operation.entity, operation.recordId);
      if (!retainedByKey.has(key)) {
        const retryableOperation = preflightApplyOverrides.get(key) ?? operation;
        retainedByKey.set(key, {
          ...retryableOperation,
          lastError: '同一批次的另一筆資料尚未完成；本筆將安全重試。',
        });
        applied = Math.max(0, applied - 1);
      }
    }
    remaining.splice(0, remaining.length, ...state.outbox.flatMap((operation) => {
      const retained = retainedByKey.get(recordKey(operation.entity, operation.recordId));
      return retained ? [retained] : [];
    }));
  }
  for (const operation of remaining) {
    const key = recordKey(operation.entity, operation.recordId);
    if (!preflightDeactivatedBudgetKeys.has(key) || operation.entity !== 'budgets') continue;
    data = replaceRecord(data, { entity: 'budgets', record: operation.record as Budget });
  }
  let finalRemaining = remaining;
  let pulled = 0;
  let pullSucceeded = false;

  try {
    const pullResult = normalizePullResponse(await remote.pull(authenticatedOwnerId));
    const remoteRecords = pullResult.records;
    for (const issue of pullResult.issues) failures.push({ ...issue });
    pulled = remoteRecords.length;
    pullSucceeded = true;
    const pendingKeys = new Set(
      state.outbox.map((operation) => recordKey(operation.entity, operation.recordId)),
    );
    for (const remoteRecord of remoteRecords) {
      if (remoteRecord.record.ownerId !== authenticatedOwnerId) {
        failures.push({
          stage: 'validation',
          message: `${remoteRecord.entity}/${remoteRecord.record.id} belongs to ${remoteRecord.record.ownerId}, not ${authenticatedOwnerId}`,
          entity: remoteRecord.entity,
          recordId: remoteRecord.record.id,
        });
        continue;
      }
      data = reconcileRecord(data, remoteRecord, pendingKeys, conflicts, failures);
    }
    const unresolvedByKey = new Map(
      conflicts
        .filter((conflict) => conflict.winner === 'unresolved')
        .map((conflict) => [recordKey(conflict.entity, conflict.recordId), conflict] as const),
    );
    const conflictedBatchIds = new Set(state.outbox.flatMap((operation) => {
      const conflict = conflicts.find((candidate) => (
        candidate.entity === operation.entity && candidate.recordId === operation.recordId
      ));
      return operation.batchId && conflict && conflict.winner !== 'local'
        ? [operation.batchId]
        : [];
    }));
    if (unresolvedByKey.size > 0 || conflictedBatchIds.size > 0) {
      const retainedByKey = new Map(
        remaining.map((operation) => [recordKey(operation.entity, operation.recordId), operation]),
      );
      let requeuedSuccessful = 0;
      for (const operation of state.outbox) {
        const key = recordKey(operation.entity, operation.recordId);
        const conflict = unresolvedByKey.get(key);
        const batchConflict = operation.batchId && conflictedBatchIds.has(operation.batchId);
        if (!conflict && !batchConflict) continue;
        const retained = retainedByKey.get(key);
        const lastError = conflict?.reason === 'payload'
          ? `${UNRESOLVED_PAYLOAD_CONFLICT_PREFIX} for ${operation.entity}/${operation.recordId}`
          : batchConflict
            ? `batch conflict for ${operation.entity}/${operation.recordId} requires explicit cloud resolution as one unit`
            : `pending local mutation for ${operation.entity}/${operation.recordId} requires explicit review after the remote clock won`;
        retainedByKey.set(key, {
          ...(retained ?? operation),
          attempts: retained?.attempts ?? operation.attempts + 1,
          lastError,
        });
        if (!retained) requeuedSuccessful += 1;
      }
      finalRemaining = state.outbox.flatMap((operation) => {
        const retained = retainedByKey.get(recordKey(operation.entity, operation.recordId));
        return retained === undefined ? [] : [retained];
      });
      applied = Math.max(0, applied - requeuedSuccessful);
    }
    const remoteWinnerKeys = new Set(
      conflicts
        .filter((conflict) => conflict.winner === 'remote')
        .map((conflict) => recordKey(conflict.entity, conflict.recordId)),
    );
    if (remoteWinnerKeys.size > 0) {
      finalRemaining = finalRemaining.filter(
        (operation) => !remoteWinnerKeys.has(recordKey(operation.entity, operation.recordId))
          || (operation.batchId !== undefined && conflictedBatchIds.has(operation.batchId)),
      );
      // The pull proved that the server clock superseded this stale operation.
      // Treat it as a resolved conflict rather than an endlessly retrying error.
      failures = failures.filter((failure) => !(
        failure.stage === 'apply'
        && failure.entity !== undefined
        && failure.recordId !== undefined
        && remoteWinnerKeys.has(recordKey(failure.entity, failure.recordId))
      ));
    }

    const batchesRequiringCompensation = new Set([
      ...incompleteBatchIds,
      ...conflictedBatchIds,
    ]);
    if (batchesRequiringCompensation.size > 0) {
      const retainedByKey = new Map(
        finalRemaining.map((operation) => [recordKey(operation.entity, operation.recordId), operation]),
      );
      const remoteByKey = new Map(remoteRecords.map((entry) => [
        recordKey(entry.entity, entry.record.id),
        entry,
      ]));
      for (const operation of state.outbox) {
        if (!operation.batchId || !batchesRequiringCompensation.has(operation.batchId)) continue;
        const key = recordKey(operation.entity, operation.recordId);
        const effectiveOperation = preflightApplyOverrides.get(key) ?? operation;
        if (effectiveOperation.record.lastOperationId.includes(':batch-compensation:')) continue;
        const currentRemote = remoteByKey.get(key);
        if (!currentRemote) continue;
        const isExactAppliedMember = compareSyncRecords(effectiveOperation.record, currentRemote.record) === 0
          && differingSyncRecordFields(
            effectiveOperation.entity,
            effectiveOperation.record,
            currentRemote.record,
          ).length === 0;
        if (!isExactAppliedMember) continue;
        const compensation = await batchCompensationOperation(
          effectiveOperation,
          currentRemote.record,
          now(),
        );
        if (!compensation) {
          failures.push({
            stage: 'conflict',
            message: `舊版批次 ${operation.batchId} 缺少可驗證前態；未自動補償 ${operation.entity}/${operation.recordId}。`,
            operationId: operation.id,
            entity: operation.entity,
            recordId: operation.recordId,
          });
          continue;
        }
        try {
          if (!remote.compareAndSwap) {
            throw new Error('遠端不支援具 expected-clock 條件的安全補償');
          }
          const persistedCompensation = await remote.compareAndSwap(
            authenticatedOwnerId,
            currentRemote,
            compensation,
          );
          if (!persistedCompensation) throw new Error('補償前遠端版本已再次變更');
          if (compareSyncRecords(compensation.record, persistedCompensation.record) !== 0
            || differingSyncRecordFields(
              compensation.entity,
              compensation.record,
              persistedCompensation.record,
            ).length > 0) {
            throw new Error('條件式補償未回傳相同版本');
          }
          const retry = batchRetryOperation(effectiveOperation, compensation, now());
          retainedByKey.set(key, retry);
          data = replaceRecord(data, {
            entity: retry.entity,
            record: retry.record,
          } as RemoteRecord);
          failures.push({
            stage: 'conflict',
            message: `批次未完整套用，已安全補償 ${operation.entity}/${operation.recordId} 的遠端狀態；本機完整意圖仍保留等待重試或明確採用雲端版本。`,
            operationId: compensation.id,
            entity: compensation.entity,
            recordId: compensation.recordId,
          });
        } catch (error) {
          failures.push({
            stage: 'apply',
            message: `批次競態補償尚未確認：${errorMessage(error)}`,
            operationId: compensation.id,
            entity: compensation.entity,
            recordId: compensation.recordId,
          });
        }
      }
      finalRemaining = state.outbox.flatMap((operation) => {
        const retained = retainedByKey.get(recordKey(operation.entity, operation.recordId));
        return retained ? [retained] : [];
      });
    }
  } catch (error) {
    failures.push({ stage: 'pull', message: errorMessage(error) });
  }

  if (!pullSucceeded) {
    const retainedByKey = new Map(
      finalRemaining.map((operation) => [recordKey(operation.entity, operation.recordId), operation]),
    );
    for (const operation of state.outbox) {
      if (!operation.batchId || retainedByKey.has(recordKey(operation.entity, operation.recordId))) continue;
      retainedByKey.set(recordKey(operation.entity, operation.recordId), {
        ...operation,
        lastError: '批次寫入後尚未完成雲端確認；本筆將安全重試。',
      });
      applied = Math.max(0, applied - 1);
    }
    finalRemaining = state.outbox.flatMap((operation) => {
      const retained = retainedByKey.get(recordKey(operation.entity, operation.recordId));
      return retained ? [retained] : [];
    });
  }

  if (!pullSucceeded && appliedActiveBudgetOperations.length > 0) {
    const retained = new Map(
      finalRemaining.map((operation) => [recordKey(operation.entity, operation.recordId), operation]),
    );
    for (const operation of appliedActiveBudgetOperations) {
      retained.set(recordKey(operation.entity, operation.recordId), {
        ...operation,
        lastError: '有效預算已寫入，但尚未完成雲端語義衝突確認。',
      });
    }
    finalRemaining = [...retained.values()];
  }

  if (pullSucceeded) {
    for (const operation of appliedActiveBudgetOperations) {
      const candidate = data.budgets.find((budget) => (
        budget.id === operation.recordId
        && budget.isActive
        && !budget.deletedAt
        && budget.version === operation.record.version
        && budget.lastOperationId === operation.id
      ));
      if (!candidate) continue;
      const conflict = data.budgets.find((budget) => (
        budget.id !== candidate.id
        && budget.isActive
        && !budget.deletedAt
        && hasSameBudgetSemantics(budget, candidate)
      ));
      if (!conflict) continue;

      const timestamp = now();
      const rollbackId = budgetConflictRollbackOperationId();
      const archived: Budget = {
        ...candidate,
        version: candidate.version + 1,
        updatedAt: timestamp,
        lastOperationId: rollbackId,
        isActive: false,
      };
      const rollback: PendingOperation = {
        id: rollbackId,
        entity: 'budgets',
        recordId: archived.id,
        record: archived,
        attempts: 0,
        queuedAt: timestamp,
      };
      data = replaceRecord(data, { entity: 'budgets', record: archived });
      try {
        await remote.apply(authenticatedOwnerId, rollback);
        applied += 1;
        failures.push({
          stage: 'conflict',
          message: `同步期間出現同語義雲端預算 ${conflict.id}；本次新增已安全保留為封存。`,
          operationId: rollback.id,
          entity: 'budgets',
          recordId: archived.id,
        });
      } catch (error) {
        const message = `預算衝突回滾尚未同步：${errorMessage(error)}`;
        finalRemaining = [
          ...finalRemaining.filter((pending) => (
            pending.entity !== 'budgets' || pending.recordId !== archived.id
          )),
          { ...rollback, attempts: 1, lastError: message },
        ];
        failures.push({
          stage: 'apply',
          message,
          operationId: rollback.id,
          entity: 'budgets',
          recordId: archived.id,
        });
      }
    }
  }

  // Persisted snapshots require every outbox payload to match the visible
  // local record exactly. A late remote tombstone can otherwise replace one
  // batch member during reconciliation while the complete local batch is
  // intentionally retained for explicit resolution.
  for (const operation of finalRemaining) {
    data = replaceRecord(data, {
      entity: operation.entity,
      record: operation.record,
    } as RemoteRecord);
  }

  if (pullSucceeded) {
    try {
      validateFinanceData(data, 'final reconciled graph');
      assertLifecycleTransition(state.data, data);
    } catch (error) {
      failures.push({
        stage: 'validation',
        message: `Refused final reconciled graph: ${errorMessage(error)}`,
      });
      // A server write may already have succeeded, so retain every original
      // operation for an idempotent retry instead of acknowledging a snapshot
      // that cannot be safely loaded on the next launch.
      data = state.data;
      finalRemaining = state.outbox;
      applied = 0;
      pullSucceeded = false;
    }
  }

  const lastSyncError = failures.map((failure) => failure.message).join('; ') || undefined;
  const currentUnresolvedKeys = new Set(
    conflicts
      .filter((conflict) => conflict.winner === 'unresolved')
      .map((conflict) => recordKey(conflict.entity, conflict.recordId)),
  );
  for (const operation of state.outbox) {
    if (!operation.batchId || !finalRemaining.some((pending) => (
      pending.batchId === operation.batchId
      && pending.lastError?.includes('batch conflict')
    ))) continue;
    const conflict = conflicts.find((candidate) => (
      candidate.entity === operation.entity && candidate.recordId === operation.recordId
      && candidate.winner !== 'local'
    ));
    if (conflict) currentUnresolvedKeys.add(recordKey(operation.entity, operation.recordId));
  }
  const unresolvedSyncRecordKeys = new Set(state.unresolvedSyncRecordKeys ?? []);
  // A later pull can change the conflict shape without proving which payload
  // the user intended to keep. Persist the lock until the explicit
  // accept-remote resolution path clears it.
  for (const key of currentUnresolvedKeys) unresolvedSyncRecordKeys.add(key);
  for (const operation of finalRemaining.filter(hasTransferDependencyConflict)) {
    unresolvedSyncRecordKeys.add(recordKey(operation.entity, operation.recordId));
  }
  const nextState: PersistedFinanceState = {
    ...state,
    data,
    outbox: finalRemaining,
    unresolvedSyncRecordKeys: unresolvedSyncRecordKeys.size > 0
      ? [...unresolvedSyncRecordKeys].sort()
      : undefined,
    ...(state.initialBootstrap?.status === 'seeding' && finalRemaining.length === 0
      ? { initialBootstrap: undefined }
      : {}),
    ...(pullSucceeded ? { lastSyncedAt: now() } : {}),
    ...(lastSyncError === undefined ? { lastSyncError: undefined } : { lastSyncError }),
  };

  return {
    state: nextState,
    report: {
      ownerId: state.ownerId,
      status: failures.length === 0 ? 'synced' : 'partial',
      applied,
      pulled,
      pending: pendingReport(finalRemaining),
      failures,
      conflicts,
    },
  };
}
