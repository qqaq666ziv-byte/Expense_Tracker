import type {
  FinanceData,
  FinanceEntityName,
  OwnerId,
  PendingOperation,
  PersistedFinanceState,
} from './model';

export type SyncEntityRecord = FinanceData[FinanceEntityName][number];

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

const ENTITY_NAMES: readonly FinanceEntityName[] = [
  'accounts',
  'categories',
  'transactions',
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
function compareRecords(left: SyncEntityRecord, right: SyncEntityRecord): number {
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

function recordKey(entity: FinanceEntityName, recordId: string): string {
  return `${entity}:${recordId}`;
}

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

  const comparison = compareRecords(localRecord, remoteRecord.record);
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
        message: `unresolved same-clock payload conflict for ${remoteRecord.entity}/${remoteRecord.record.id} at fields: ${differingFields.join(', ')}`,
        entity: remoteRecord.entity,
        recordId: remoteRecord.record.id,
      });
    }
    return data;
  }

  const localWins = comparison > 0;
  conflicts.push({
    entity: remoteRecord.entity,
    recordId: remoteRecord.record.id,
    winner: localWins ? 'local' : 'remote',
    reason: localWins && pendingKeys.has(recordKey(remoteRecord.entity, remoteRecord.record.id))
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
  }
  return failures;
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
): PersistedFinanceState {
  if (state.ownerId === 'guest') {
    throw new Error('guest state is local-only and cannot enqueue remote sync operations');
  }
  if (record.ownerId !== state.ownerId) {
    throw new Error(`record ${record.id} belongs to ${record.ownerId}, not ${state.ownerId}`);
  }
  if (record.lastOperationId.length === 0) {
    throw new Error('lastOperationId is required for an idempotent sync operation');
  }

  const syncRecord = record as SyncEntityRecord;
  const nextOperation: PendingOperation = {
    id: syncRecord.lastOperationId,
    entity,
    recordId: syncRecord.id,
    record: syncRecord,
    attempts: 0,
    queuedAt,
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

  let failures: SyncFailure[] = [];
  const conflicts: SyncConflict[] = [];
  const remaining: PendingOperation[] = [];
  let applied = 0;

  for (const operation of state.outbox) {
    try {
      await remote.apply(authenticatedOwnerId, operation);
      applied += 1;
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
      remaining.map((operation) => recordKey(operation.entity, operation.recordId)),
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
    const unresolvedPayloadKeys = new Set(
      conflicts
        .filter((conflict) => conflict.winner === 'unresolved' && conflict.reason === 'payload')
        .map((conflict) => recordKey(conflict.entity, conflict.recordId)),
    );
    if (unresolvedPayloadKeys.size > 0) {
      const retainedByKey = new Map(
        remaining.map((operation) => [recordKey(operation.entity, operation.recordId), operation]),
      );
      let requeuedSuccessful = 0;
      for (const operation of state.outbox) {
        const key = recordKey(operation.entity, operation.recordId);
        if (!unresolvedPayloadKeys.has(key) || retainedByKey.has(key)) continue;
        retainedByKey.set(key, {
          ...operation,
          attempts: operation.attempts + 1,
          lastError: `unresolved same-clock payload conflict for ${operation.entity}/${operation.recordId}`,
        });
        requeuedSuccessful += 1;
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
        (operation) => !remoteWinnerKeys.has(recordKey(operation.entity, operation.recordId)),
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
  } catch (error) {
    failures.push({ stage: 'pull', message: errorMessage(error) });
  }

  const lastSyncError = failures.map((failure) => failure.message).join('; ') || undefined;
  const nextState: PersistedFinanceState = {
    ...state,
    data,
    outbox: finalRemaining,
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
