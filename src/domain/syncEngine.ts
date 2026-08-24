import type {
  FinanceData,
  FinanceEntityName,
  OwnerId,
  PendingOperation,
  PersistedFinanceState,
} from './model';
import { validateFinanceData } from './backup';

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
  const hasPendingLocalMutation = pendingKeys.has(
    recordKey(remoteRecord.entity, remoteRecord.record.id),
  );
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
  if (state.legacyBootstrap?.status === 'pending') {
    return syncAuthenticatedLegacyBootstrap(state, authenticatedOwnerId, remote, now);
  }
  if (state.initialBootstrap?.status === 'pending') {
    return syncInitialAuthenticatedBootstrap(state, authenticatedOwnerId, remote, now);
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
    if (unresolvedByKey.size > 0) {
      const retainedByKey = new Map(
        remaining.map((operation) => [recordKey(operation.entity, operation.recordId), operation]),
      );
      let requeuedSuccessful = 0;
      for (const operation of state.outbox) {
        const key = recordKey(operation.entity, operation.recordId);
        const conflict = unresolvedByKey.get(key);
        if (!conflict || retainedByKey.has(key)) continue;
        const lastError = conflict.reason === 'payload'
          ? `unresolved same-clock payload conflict for ${operation.entity}/${operation.recordId}`
          : `pending local mutation for ${operation.entity}/${operation.recordId} requires explicit review after the remote clock won`;
        retainedByKey.set(key, {
          ...operation,
          attempts: operation.attempts + 1,
          lastError,
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

  if (pullSucceeded) {
    try {
      validateFinanceData(data, 'final reconciled graph');
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
  const nextState: PersistedFinanceState = {
    ...state,
    data,
    outbox: finalRemaining,
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
