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
  const appliedActiveBudgetOperations: PendingOperation[] = [];
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
  if (state.outbox.some((operation) => !operation.record.deletedAt)) {
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
          ? state.outbox.filter((operation) => !operation.record.deletedAt)
            .map((operation) => recordKey(operation.entity, operation.recordId))
          : []),
      ]);
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
        if (!candidate.isActive) {
          const sameRemoteRecord = remoteBudgets.find((budget) => budget.id === candidate.id);
          if (!sameRemoteRecord) continue;
          const timestamp = now();
          if (!sameRemoteRecord.isActive) {
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
          const rollbackId = activeOperationId();
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
          const rollbackId = activeOperationId();
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
    if (!operation.record.deletedAt && preflightBlockedKeys.has(key)) {
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
      const rollbackId = activeOperationId();
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
