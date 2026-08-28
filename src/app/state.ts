import type {
  FinanceData,
  FinanceEntityName,
  AssetAccount,
  Category,
  OwnerId,
  PendingOperation,
  PersistedFinanceState,
  SavingsAllocation,
  SyncRecord,
} from '../domain/model';
import { activeOperationId, enqueueSyncRecord } from '../domain/syncEngine';
import { migrateLegacyData, stableLegacyId } from '../domain/legacyMigration';
import { validateFinanceData } from '../domain/backup';
import { isTutorialTransaction } from '../domain/tutorialRecord';
import { assertCategoryUpsert, getCategoryActionBlock, type CategoryAction } from '../domain/lifecycle';
import {
  assertFinanceOwnerRowLimit,
  assertFinanceRecordWithinWriteLimits,
} from '../domain/resourceLimits';

export const LOCAL_STATE_PREFIX = 'shiba-finance:v3:';

const DEFAULT_CATEGORIES = [
  ['expense', '餐飲', '🍖'],
  ['expense', '交通', '🚗'],
  ['expense', '購物', '🛍️'],
  ['expense', '娛樂', '✨'],
  ['expense', '居家', '🏠'],
  ['expense', '醫療', '🩹'],
  ['expense', '學習', '📚'],
  ['expense', '人情', '🎁'],
  ['expense', '其他支出', '🧾'],
  ['income', '薪資', '💰'],
  ['income', '零用錢', '🪙'],
  ['income', '獎金', '🎁'],
  ['income', '投資', '📈'],
  ['income', '其他收入', '✨'],
] as const;

function seedMeta(id: string, ownerId: OwnerId): SyncRecord {
  return {
    id,
    ownerId,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastOperationId: `seed-${id}`,
  };
}

export function createInitialData(ownerId: OwnerId): FinanceData {
  return {
    accounts: [{
      ...seedMeta(stableLegacyId('account', ownerId, '現金'), ownerId),
      name: '現金',
      icon: { type: 'emoji', value: '💵' },
      openingBalance: 0,
      includeInTotalAssets: true,
      isActive: true,
      sortOrder: 0,
    }],
    categories: DEFAULT_CATEGORIES.map(([kind, name, emoji], index) => ({
      ...seedMeta(stableLegacyId('category', ownerId, kind, name), ownerId),
      kind,
      name,
      icon: { type: 'emoji' as const, value: emoji },
      isActive: true,
      sortOrder: index,
    })),
    transactions: [],
    transfers: [],
    adjustments: [],
    goals: [],
    allocations: [],
    budgets: [],
    recurringRules: [],
    settings: { currency: 'TWD', locale: 'zh-TW' },
  };
}

function createEmptyData(): FinanceData {
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
    settings: { currency: 'TWD', locale: 'zh-TW' },
  };
}

export function createInitialState(ownerId: OwnerId): PersistedFinanceState {
  const data = createInitialData(ownerId);
  return {
    schemaVersion: 4,
    ownerId,
    data,
    outbox: [],
    ...(ownerId === 'guest' ? {} : {
      initialBootstrap: {
        status: 'pending' as const,
        candidate: structuredClone(data),
        pendingOperations: [],
      },
    }),
  };
}

function isExactSyntheticDefaultOperation(
  operation: PendingOperation,
  defaults: FinanceData,
): boolean {
  if (operation.entity !== 'accounts' && operation.entity !== 'categories') return false;
  const expected = (defaults[operation.entity] as SyncRecord[])
    .find((record) => record.id === operation.recordId);
  return expected !== undefined
    && operation.id === expected.lastOperationId
    && JSON.stringify(operation.record) === JSON.stringify(expected);
}

export function storageKey(ownerId: OwnerId): string {
  return `${LOCAL_STATE_PREFIX}${ownerId === 'guest' ? 'guest' : `user:${ownerId}`}`;
}

export interface LocalStateRecovery {
  key: string;
  raw: string;
  message: string;
}

export interface LoadedFinanceState {
  state: PersistedFinanceState;
  recovery?: LocalStateRecovery;
}

function addTransferCollection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, 'transfers') ? record : { ...record, transfers: [] };
}

/** Upgrade the last local envelope in memory while keeping its raw JSON untouched for recovery. */
function upgradePersistedFinanceState(value: unknown): PersistedFinanceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value as PersistedFinanceState;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.schemaVersion !== 3) return envelope as unknown as PersistedFinanceState;
  const upgradeBootstrap = (bootstrap: unknown): unknown => {
    if (!bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)) return bootstrap;
    const record = bootstrap as Record<string, unknown>;
    return { ...record, candidate: addTransferCollection(record.candidate) };
  };
  return {
    ...envelope,
    schemaVersion: 4,
    data: addTransferCollection(envelope.data),
    ...(envelope.legacyBootstrap === undefined
      ? {}
      : { legacyBootstrap: upgradeBootstrap(envelope.legacyBootstrap) }),
    ...(envelope.initialBootstrap === undefined
      ? {}
      : { initialBootstrap: upgradeBootstrap(envelope.initialBootstrap) }),
  } as unknown as PersistedFinanceState;
}

/**
 * Load an owner-scoped snapshot without destroying malformed input. Callers
 * that persist automatically must honor `recovery` and suppress writes until
 * the user restores a valid backup or explicitly resets the ledger.
 */
export function loadFinanceStateWithRecovery(
  ownerId: OwnerId,
  storage: Pick<Storage, 'getItem'> = localStorage,
): LoadedFinanceState {
  const key = storageKey(ownerId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    console.warn('無法讀取本機財務快照；已停止自動覆寫。', error);
    return {
      state: createInitialState(ownerId),
      recovery: {
        key,
        raw: '',
        message: `瀏覽器拒絕讀取本機財務快照：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!raw) {
    try {
      return { state: loadLegacyState(ownerId, storage) ?? createInitialState(ownerId) };
    } catch (error) {
      let recoverableRaw: string;
      try {
        const entries = Object.fromEntries(legacyStorageKeys(ownerId).map((legacyKey) => [
          legacyKey,
          storage.getItem(legacyKey),
        ]));
        recoverableRaw = JSON.stringify({ format: 'legacy-localStorage-recovery', ownerId, entries }, null, 2);
      } catch (recoveryReadError) {
        recoverableRaw = JSON.stringify({
          format: 'legacy-localStorage-recovery-unavailable',
          ownerId,
          message: recoveryReadError instanceof Error
            ? recoveryReadError.message
            : String(recoveryReadError),
        }, null, 2);
      }
      console.warn('舊版資料遷移驗證失敗；原始 localStorage 保持不變。', error);
      return {
        state: createInitialState(ownerId),
        recovery: {
          key,
          raw: recoverableRaw,
          message: `舊版本機資料無法安全遷移：${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
  try {
    const parsed = upgradePersistedFinanceState(JSON.parse(raw));
    if (parsed.schemaVersion !== 4 || parsed.ownerId !== ownerId || !parsed.data || !Array.isArray(parsed.outbox)) {
      throw new Error('invalid local state envelope');
    }
    validateFinanceData(parsed.data, 'local state');
    for (const entity of entityNames) {
      if (parsed.data[entity].some((record) => record.ownerId !== ownerId)) {
        throw new Error(`foreign owner in ${entity}`);
      }
    }
    for (const operation of parsed.outbox) {
      if (!operation || typeof operation !== 'object'
        || operation.record.ownerId !== ownerId
        || operation.recordId !== operation.record.id
        || operation.id !== operation.record.lastOperationId
        || (operation.batchId !== undefined
          && (typeof operation.batchId !== 'string' || operation.batchId.length === 0))
        || (operation.batchId === undefined && operation.batchBeforeRecord !== undefined)
        || (operation.batchId !== undefined && operation.batchBeforeRecord === undefined)
        || (operation.batchBeforeRecord !== undefined
          && operation.batchBeforeRecord !== null
          && (operation.batchBeforeRecord.ownerId !== ownerId
            || operation.batchBeforeRecord.id !== operation.recordId))
        || (operation.historicalImportBatchId !== undefined
          && (typeof operation.historicalImportBatchId !== 'string'
            || !/^historical-import:(guest|restore):[A-Za-z0-9-]+$/.test(operation.historicalImportBatchId)
            || !['accounts', 'transfers'].includes(operation.entity)))
        || !entityNames.includes(operation.entity)) {
        throw new Error('invalid or foreign operation in outbox');
      }
      const currentRecord = (parsed.data[operation.entity] as SyncRecord[])
        .find((record) => record.id === operation.recordId);
      if (!currentRecord
        || currentRecord.lastOperationId !== operation.id
        || JSON.stringify(currentRecord) !== JSON.stringify(operation.record)) {
        throw new Error('outbox does not match the current local record');
      }
      validateBatchBeforeRecord(parsed.data, operation, 'local outbox batch before-record');
    }
    if (parsed.unresolvedSyncRecordKeys !== undefined) {
      if (!Array.isArray(parsed.unresolvedSyncRecordKeys)) {
        throw new Error('invalid unresolved sync record keys');
      }
      const validRecordKeys = new Set(entityNames.flatMap((entity) => (
        (parsed.data[entity] as SyncRecord[]).map((record) => `${entity}:${record.id}`)
      )));
      if (
        ownerId === 'guest'
        ||
        new Set(parsed.unresolvedSyncRecordKeys).size !== parsed.unresolvedSyncRecordKeys.length
        || parsed.unresolvedSyncRecordKeys.some((key) => (
          typeof key !== 'string' || !validRecordKeys.has(key)
        ))
      ) {
        throw new Error('invalid unresolved sync record keys');
      }
    }
    if (parsed.initialBootstrap !== undefined) {
      const bootstrap = parsed.initialBootstrap;
      if (!bootstrap || typeof bootstrap !== 'object'
        || (bootstrap.status !== 'pending' && bootstrap.status !== 'seeding')
        || !bootstrap.candidate
        || !Array.isArray(bootstrap.pendingOperations)
        || (bootstrap.status === 'pending' && parsed.outbox.length > 0)
        || (bootstrap.status === 'seeding' && bootstrap.pendingOperations.length > 0)
        || parsed.legacyBootstrap !== undefined) {
        throw new Error('invalid authenticated initial bootstrap');
      }
      validateFinanceData(bootstrap.candidate, 'authenticated initial bootstrap candidate');
      for (const entity of entityNames) {
        if (bootstrap.candidate[entity].some((record) => record.ownerId !== ownerId)) {
          throw new Error(`foreign owner in authenticated initial bootstrap candidate ${entity}`);
        }
      }
      const pendingKeys = new Set<string>();
      for (const operation of bootstrap.pendingOperations) {
        const key = `${operation.entity}:${operation.recordId}`;
        if (!operation || typeof operation !== 'object'
          || operation.record.ownerId !== ownerId
          || operation.recordId !== operation.record.id
          || operation.id !== operation.record.lastOperationId
          || (operation.batchId !== undefined
            && (typeof operation.batchId !== 'string' || operation.batchId.length === 0))
          || (operation.batchId === undefined && operation.batchBeforeRecord !== undefined)
          || (operation.batchId !== undefined && operation.batchBeforeRecord === undefined)
          || (operation.batchBeforeRecord !== undefined
            && operation.batchBeforeRecord !== null
            && (operation.batchBeforeRecord.ownerId !== ownerId
              || operation.batchBeforeRecord.id !== operation.recordId))
          || (operation.historicalImportBatchId !== undefined
            && (typeof operation.historicalImportBatchId !== 'string'
              || !/^historical-import:(guest|restore):[A-Za-z0-9-]+$/.test(operation.historicalImportBatchId)
              || !['accounts', 'transfers'].includes(operation.entity)))
          || !entityNames.includes(operation.entity)
          || pendingKeys.has(key)) {
          throw new Error('invalid or duplicate operation in authenticated initial bootstrap');
        }
        validateBatchBeforeRecord(
          bootstrap.candidate,
          operation,
          'authenticated initial bootstrap batch before-record',
        );
        pendingKeys.add(key);
      }
    }
    if (parsed.legacyBootstrap !== undefined) {
      const bootstrap = parsed.legacyBootstrap;
      if (!bootstrap || typeof bootstrap !== 'object'
        || (bootstrap.status !== 'pending' && bootstrap.status !== 'ready')
        || !Array.isArray(bootstrap.unsyncedTransactionIds)
        || !bootstrap.candidate) {
        throw new Error('invalid authenticated legacy bootstrap');
      }
      validateFinanceData(bootstrap.candidate, 'authenticated legacy candidate');
      for (const entity of entityNames) {
        if (bootstrap.candidate[entity].some((record) => record.ownerId !== ownerId)) {
          throw new Error(`foreign owner in authenticated legacy candidate ${entity}`);
        }
      }
      const transactionIds = new Set(bootstrap.candidate.transactions.map((record) => record.id));
      const unsyncedIds = new Set<string>();
      for (const id of bootstrap.unsyncedTransactionIds) {
        if (typeof id !== 'string' || id.length === 0 || !transactionIds.has(id) || unsyncedIds.has(id)) {
          throw new Error('invalid unsynced transaction in authenticated legacy candidate');
        }
        unsyncedIds.add(id);
      }
      if (bootstrap.status === 'pending' && parsed.outbox.length > 0) {
        throw new Error('pending authenticated legacy bootstrap cannot contain remote operations');
      }
    } else if (ownerId !== 'guest' && parsed.migratedFromLegacy === true) {
      // Recover snapshots produced by the pre-fix v3 migration path. Those
      // snapshots queued the entire legacy cache, so demote the graph back to a
      // review candidate before any subsequent launch can apply it remotely.
      return {
        state: {
          ...parsed,
          data: createEmptyData(),
          outbox: [],
          lastSyncedAt: undefined,
          legacyBootstrap: {
            status: 'pending',
            candidate: parsed.data,
            unsyncedTransactionIds: [],
          },
        },
      };
    }
    if (ownerId !== 'guest'
      && parsed.initialBootstrap === undefined
      && parsed.legacyBootstrap === undefined) {
      const defaults = createInitialData(ownerId);
      const syntheticOperations = parsed.outbox.filter((operation) => (
        isExactSyntheticDefaultOperation(operation, defaults)
      ));
      if (syntheticOperations.length > 0) {
        const syntheticKeys = new Set(syntheticOperations.map((operation) => (
          `${operation.entity}:${operation.recordId}`
        )));
        return {
          state: {
            ...parsed,
            outbox: [],
            lastSyncedAt: undefined,
            lastSyncError: undefined,
            initialBootstrap: {
              status: 'pending',
              candidate: defaults,
              pendingOperations: parsed.outbox.filter((operation) => (
                !syntheticKeys.has(`${operation.entity}:${operation.recordId}`)
              )),
            },
          },
        };
      }
    }
    return { state: parsed };
  } catch (error) {
    console.warn('已隔離無法讀取的本機財務快照；未覆寫原資料。', error);
    return {
      state: createInitialState(ownerId),
      recovery: {
        key,
        raw,
        message: `本機財務快照無法驗證：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export function loadFinanceState(
  ownerId: OwnerId,
  storage: Pick<Storage, 'getItem'> = localStorage,
): PersistedFinanceState {
  return loadFinanceStateWithRecovery(ownerId, storage).state;
}

function readLegacyArray(storage: Pick<Storage, 'getItem'>, key: string): unknown[] {
  const raw = storage.getItem(key);
  if (!raw) return [];
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error(`${key} is not an array`);
  return value;
}

function legacyStorageKeys(ownerId: OwnerId): string[] {
  const prefix = ownerId === 'guest' ? 'guest_' : 'user_';
  const suffix = ownerId === 'guest' ? '' : `_${ownerId}`;
  const keys = ['transactions', 'goals', 'subscriptions', 'budgets']
    .map((entity) => `${prefix}${entity}${suffix}`);
  return ownerId === 'guest' ? [...keys, 'payment_methods', 'custom_categories'] : keys;
}

function loadLegacyState(
  ownerId: OwnerId,
  storage: Pick<Storage, 'getItem'>,
): PersistedFinanceState | null {
  const legacyKey = (entity: string) => ownerId === 'guest'
    ? `guest_${entity}`
    : `user_${entity}_${ownerId}`;
  const source = {
    transactions: readLegacyArray(storage, legacyKey('transactions')),
    goals: readLegacyArray(storage, legacyKey('goals')),
    subscriptions: readLegacyArray(storage, legacyKey('subscriptions')),
    budgets: readLegacyArray(storage, legacyKey('budgets')),
    // Legacy configuration keys were device-global and have no provable authenticated owner.
    // Keep them in guest storage; authenticated migration derives relations only from that user's rows.
    payment_methods: ownerId === 'guest' ? readLegacyArray(storage, 'payment_methods') : [],
    custom_categories: ownerId === 'guest' ? readLegacyArray(storage, 'custom_categories') : [],
  };
  const ownerSpecificCount = source.transactions.length + source.goals.length
    + source.subscriptions.length + source.budgets.length;
  const hasLegacyData = ownerId === 'guest'
    ? ownerSpecificCount + source.payment_methods.length + source.custom_categories.length > 0
    : ownerSpecificCount > 0;
  if (!hasLegacyData) return null;

  const migrated = migrateLegacyData(source, { ownerId, migratedAt: new Date() });
  const unsyncedTransactionIds = source.transactions.flatMap((record, index) => (
    record !== null
      && typeof record === 'object'
      && !Array.isArray(record)
      && (record as Record<string, unknown>).synced === false
      ? [migrated.transactions[index].id]
      : []
  ));
  const state: PersistedFinanceState = {
    schemaVersion: 4,
    ownerId,
    data: ownerId === 'guest' ? migrated : createEmptyData(),
    outbox: [],
    migratedFromLegacy: true,
    ...(ownerId === 'guest' ? {} : {
      legacyBootstrap: {
        status: 'pending' as const,
        candidate: migrated,
        unsyncedTransactionIds,
      },
    }),
  };
  return state;
}

export function saveFinanceState(
  state: PersistedFinanceState,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(storageKey(state.ownerId), JSON.stringify(state));
}

export interface GuestImportPersistenceResult {
  decisionRemembered: boolean;
  decisionError?: string;
}

/**
 * Persist imported finance data before remembering the guest decision. If the
 * owner snapshot write fails, the decision write is never attempted, so a
 * reload cannot hide an import that was lost to quota/storage failure.
 */
export function persistGuestImportState(
  state: PersistedFinanceState,
  decisionKey: string,
  fingerprint: string,
  storage: Pick<Storage, 'setItem'> = localStorage,
): GuestImportPersistenceResult {
  saveFinanceState(state, storage);
  try {
    storage.setItem(decisionKey, fingerprint);
    return { decisionRemembered: true };
  } catch (error) {
    return {
      decisionRemembered: false,
      decisionError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function canAutoSaveFinanceState(
  state: PersistedFinanceState,
  activeOwnerId: OwnerId,
  recovery?: LocalStateRecovery,
): boolean {
  return state.ownerId === activeOwnerId && recovery?.key !== storageKey(state.ownerId);
}

/**
 * Advance the non-React mutation source before scheduling a render. React may
 * batch state setters, so using the last rendered value as the next mutation
 * base can otherwise lose an outbox operation when two commands run in one
 * event-loop turn (for example, a put immediately followed by restore).
 */
export function advanceFinanceStateRef(
  ref: { current: PersistedFinanceState },
  update: (current: PersistedFinanceState) => PersistedFinanceState,
): PersistedFinanceState {
  const next = update(ref.current);
  ref.current = next;
  return next;
}

export const entityNames: readonly FinanceEntityName[] = [
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

function validateBatchBeforeRecord(
  data: FinanceData,
  operation: PendingOperation,
  context: string,
): void {
  if (operation.batchBeforeRecord === undefined || operation.batchBeforeRecord === null) return;
  const records = [...data[operation.entity]] as SyncRecord[];
  const index = records.findIndex((record) => record.id === operation.recordId);
  if (index < 0) throw new Error(`${context} before-record target is missing`);
  records[index] = operation.batchBeforeRecord;
  validateFinanceData({ ...data, [operation.entity]: records } as FinanceData, context);
}

export function putRecord<E extends FinanceEntityName>(
  state: PersistedFinanceState,
  entity: E,
  record: FinanceData[E][number],
  batchId?: string,
  historicalImportBatchId?: string,
): PersistedFinanceState {
  if (record.ownerId !== state.ownerId) throw new Error('拒絕寫入其他使用者的資料');
  assertFinanceRecordWithinWriteLimits(entity, record);
  const records = state.data[entity] as FinanceData[E][number][];
  assertFinanceOwnerRowLimit(entity, records as FinanceData[E], record.id);
  if (state.ownerId !== 'guest') return enqueueSyncRecord(
    state,
    entity,
    record,
    record.updatedAt,
    batchId,
    historicalImportBatchId,
  );

  const index = records.findIndex((candidate) => candidate.id === record.id);
  const nextRecords = [...records];
  if (index < 0) nextRecords.push(record);
  else nextRecords[index] = record;
  return {
    ...state,
    data: { ...state.data, [entity]: nextRecords },
  };
}

export interface GuestImportConflict {
  entity: FinanceEntityName;
  id: string;
}

export interface GuestImportPlan {
  state: PersistedFinanceState;
  addedCount: number;
  skippedCount: number;
  conflicts: GuestImportConflict[];
}

function canonicalImportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalImportValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalImportValue(child)]),
    );
  }
  return value;
}

function guestImportContent(record: SyncRecord): string {
  const content = Object.fromEntries(
    Object.entries(record).filter(([key]) => ![
      'version',
      'updatedAt',
      'lastOperationId',
    ].includes(key)),
  );
  return JSON.stringify(canonicalImportValue(content));
}

/**
 * Prepare an explicit guest import without ever overwriting account-owned data.
 * Sync metadata is ignored for equality because remapping intentionally creates
 * a fresh operation clock each time. Any business-content collision aborts the
 * entire import so the UI can report it instead of silently losing one side.
 */
export function planGuestImport(
  state: PersistedFinanceState,
  imported: FinanceData,
): GuestImportPlan {
  if (state.ownerId === 'guest') throw new Error('訪客資料不需要匯入訪客帳號');
  validateFinanceData(imported, 'explicit guest import');

  const conflicts: GuestImportConflict[] = [];
  let skippedCount = 0;
  for (const entity of entityNames) {
    const currentById = new Map(
      (state.data[entity] as SyncRecord[]).map((record) => [record.id, record]),
    );
    for (const record of imported[entity] as SyncRecord[]) {
      if (record.ownerId !== state.ownerId) {
        throw new Error('訪客匯入資料的 owner remap 不完整');
      }
      const existing = currentById.get(record.id);
      if (!existing) continue;
      if (guestImportContent(existing) === guestImportContent(record)) skippedCount += 1;
      else conflicts.push({ entity, id: record.id });
    }
  }

  if (conflicts.length > 0) {
    return { state, addedCount: 0, skippedCount, conflicts };
  }

  let next = state;
  let addedCount = 0;
  const currentTransferIds = new Set(state.data.transfers.map((record) => record.id));
  const historicalImportBatchId = imported.transfers.some((record) => !currentTransferIds.has(record.id))
    ? `historical-import:guest:${crypto.randomUUID()}`
    : undefined;
  for (const entity of entityNames) {
    const existingIds = new Set((state.data[entity] as SyncRecord[]).map((record) => record.id));
    for (const record of imported[entity] as FinanceData[typeof entity][number][]) {
      if (existingIds.has(record.id)) continue;
      next = putRecord(
        next,
        entity,
        record,
        undefined,
        entity === 'accounts' || entity === 'transfers' ? historicalImportBatchId : undefined,
      );
      addedCount += 1;
    }
  }
  return { state: next, addedCount, skippedCount, conflicts: [] };
}

/**
 * Turn a validated backup restore into fresh local mutations. In particular,
 * an older backup clock must not be enqueued verbatim and then lose to the
 * cloud record it is intentionally replacing.
 */
export function applyRestoredData(
  state: PersistedFinanceState,
  restoredData: FinanceData,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
): PersistedFinanceState {
  validateFinanceData(restoredData, 'restored data');
  if (state.ownerId === 'guest') {
    return {
      ...state,
      data: structuredClone(restoredData),
    };
  }

  const timestamp = now.toISOString();
  const historicalImportBatchId = restoredData.transfers.some((record) => {
    const existing = state.data.transfers.find((candidate) => candidate.id === record.id);
    return !existing || JSON.stringify(existing) !== JSON.stringify(record);
  }) ? `historical-import:restore:${crypto.randomUUID()}` : undefined;
  let next: PersistedFinanceState = {
    ...state,
    data: { ...state.data, settings: structuredClone(restoredData.settings) },
  };
  for (const entity of entityNames) {
    const incoming = restoredData[entity] as SyncRecord[];
    const incomingIds = new Set(incoming.map((record) => record.id));
    for (const existing of state.data[entity] as SyncRecord[]) {
      if (!incomingIds.has(existing.id) && !existing.deletedAt) {
        next = putRecord(next, entity, {
          ...existing,
          ...tombstoneRecordMeta(existing, now, operationId),
          ...('isActive' in existing ? { isActive: false } : {}),
        } as FinanceData[typeof entity][number], undefined,
        entity === 'accounts' || entity === 'transfers' ? historicalImportBatchId : undefined);
      }
    }
    for (const record of incoming as FinanceData[typeof entity][number][]) {
      const existing = (state.data[entity] as SyncRecord[]).find((candidate) => candidate.id === record.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(record)) continue;
      next = putRecord(next, entity, {
        ...record,
        ownerId: state.ownerId,
        version: Math.max(existing?.version ?? 0, record.version) + 1,
        updatedAt: timestamp,
        lastOperationId: record.deletedAt
          ? `tombstone:${operationId()}`
          : activeOperationId(operationId()),
      } as FinanceData[typeof entity][number], undefined,
      entity === 'accounts' || entity === 'transfers' ? historicalImportBatchId : undefined);
    }
  }
  return next;
}

export function newRecordMeta(ownerId: OwnerId, now = new Date(), id = crypto.randomUUID()): SyncRecord {
  const operationId = crypto.randomUUID();
  return {
    id,
    ownerId,
    version: 1,
    updatedAt: now.toISOString(),
    lastOperationId: operationId,
  };
}

export function changedRecordMeta<T extends SyncRecord>(record: T, now = new Date()): Pick<SyncRecord, 'version' | 'updatedAt' | 'lastOperationId'> {
  return {
    version: record.version + 1,
    updatedAt: now.toISOString(),
    lastOperationId: record.deletedAt
      ? `tombstone:${crypto.randomUUID()}`
      : activeOperationId(),
  };
}

/** Keep future recurring snapshots aligned while preserving historical transactions. */
export function putCategoryWithDependents(
  state: PersistedFinanceState,
  category: Category,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
  batchId: string = crypto.randomUUID(),
): PersistedFinanceState {
  assertCategoryUpsert(state.data, category);
  const timestamp = now.toISOString();
  const existing = state.data.categories.find((candidate) => candidate.id === category.id);
  const siblings = state.data.categories
    .filter((candidate) => (
      candidate.id !== category.id
      && candidate.ownerId === category.ownerId
      && candidate.kind === category.kind
      && !candidate.deletedAt
    ))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const desiredIndex = Math.max(0, Math.min(category.sortOrder, siblings.length));
  const ordered = [...siblings];
  ordered.splice(desiredIndex, 0, category);
  let next = state;
  for (const [sortOrder, record] of ordered.entries()) {
    if (record.id === category.id) {
      next = putRecord(next, 'categories', { ...category, sortOrder }, batchId);
    } else if (record.sortOrder !== sortOrder) {
      next = putRecord(next, 'categories', {
        ...record,
        version: record.version + 1,
        updatedAt: timestamp,
        lastOperationId: activeOperationId(operationId()),
        sortOrder,
      }, batchId);
    }
  }
  if (existing && existing.name !== category.name) {
    for (const rule of state.data.recurringRules.filter((candidate) => (
      !candidate.deletedAt && candidate.categoryId === category.id
    ))) {
      next = putRecord(next, 'recurringRules', {
        ...rule,
        version: rule.version + 1,
        updatedAt: timestamp,
        lastOperationId: activeOperationId(operationId()),
        categoryName: category.name,
      }, batchId);
    }
  }
  return next;
}

/** Keep future recurring account snapshots aligned without touching transactions or adjustments. */
export function putAccountWithDependents(
  state: PersistedFinanceState,
  account: AssetAccount,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
  batchId: string = crypto.randomUUID(),
): PersistedFinanceState {
  const existing = state.data.accounts.find((candidate) => candidate.id === account.id);
  let next = putRecord(state, 'accounts', account, batchId);
  if (!existing || existing.name === account.name) return next;
  const timestamp = now.toISOString();
  for (const rule of state.data.recurringRules.filter((candidate) => (
    !candidate.deletedAt && candidate.accountId === account.id
  ))) {
    next = putRecord(next, 'recurringRules', {
      ...rule,
      version: rule.version + 1,
      updatedAt: timestamp,
      lastOperationId: activeOperationId(operationId()),
      accountName: account.name,
    }, batchId);
  }
  return next;
}

/**
 * Tombstones must win an equal-version race against legacy clients whose
 * operation IDs are UUIDs. The deployed database clock compares the operation
 * ID lexicographically after version, so keep this prefix stable.
 */
export function tombstoneRecordMeta<T extends SyncRecord>(
  record: T,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
): Pick<SyncRecord, 'version' | 'updatedAt' | 'lastOperationId' | 'deletedAt'> {
  const timestamp = now.toISOString();
  return {
    version: record.version + 1,
    updatedAt: timestamp,
    lastOperationId: `tombstone:${operationId()}`,
    deletedAt: timestamp,
  };
}

/** Apply category lifecycle changes atomically to the local snapshot/outbox. */
export function applyCategoryLifecycleMutation(
  state: PersistedFinanceState,
  categoryId: string,
  action: CategoryAction,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
  batchId: string = crypto.randomUUID(),
): PersistedFinanceState {
  const category = state.data.categories.find((candidate) => candidate.id === categoryId);
  if (!category) throw new Error('找不到分類，本次操作未執行。');
  const block = getCategoryActionBlock(state.data, category, action);
  if (block) throw new Error(block.message);

  const timestamp = now.toISOString();
  const changed = <T extends SyncRecord>(record: T) => ({
    version: record.version + 1,
    updatedAt: timestamp,
    lastOperationId: activeOperationId(operationId()),
  });
  let next = state;
  if (action === 'archive') {
    for (const rule of state.data.recurringRules.filter((candidate) => (
      !candidate.deletedAt && candidate.isActive && candidate.categoryId === category.id
    ))) {
      next = putRecord(next, 'recurringRules', { ...rule, ...changed(rule), isActive: false }, batchId);
    }
    return putRecord(next, 'categories', { ...category, ...changed(category), isActive: false }, batchId);
  }
  if (action === 'restore') {
    return putRecord(next, 'categories', { ...category, ...changed(category), isActive: true }, batchId);
  }
  return putRecord(next, 'categories', {
    ...category,
    ...tombstoneRecordMeta(category, now, operationId),
    isActive: false,
  }, batchId);
}

/** Pause future recurring writes and archive an account in one local commit. */
export function applyAccountArchiveMutation(
  state: PersistedFinanceState,
  accountId: string,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
  batchId: string = crypto.randomUUID(),
): PersistedFinanceState {
  const account = state.data.accounts.find((candidate) => candidate.id === accountId);
  if (!account || account.deletedAt) throw new Error('找不到帳戶，本次操作未執行。');
  if (!account.isActive) throw new Error('帳戶已封存，本次操作未執行。');
  const timestamp = now.toISOString();
  const changed = <T extends SyncRecord>(record: T) => ({
    version: record.version + 1,
    updatedAt: timestamp,
    lastOperationId: activeOperationId(operationId()),
  });
  let next = state;
  for (const rule of state.data.recurringRules.filter((candidate) => (
    !candidate.deletedAt && candidate.isActive && candidate.accountId === accountId
  ))) {
    next = putRecord(next, 'recurringRules', { ...rule, ...changed(rule), isActive: false }, batchId);
  }
  return putRecord(next, 'accounts', { ...account, ...changed(account), isActive: false }, batchId);
}

/**
 * Release a goal by tombstoning the exact source allocation records. Two
 * offline devices therefore update the same record IDs instead of creating
 * additive negative rows that could double-release after reconciliation.
 * Tombstones keep the original amount/date/note available for audit.
 */
export function releaseGoalAllocations(
  allocations: readonly SavingsAllocation[],
  goalId: string,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
): SavingsAllocation[] {
  const timestamp = now.toISOString();
  return allocations
    .filter((allocation) => allocation.goalId === goalId && !allocation.deletedAt)
    .map((allocation) => ({
      ...allocation,
      version: allocation.version + 1,
      updatedAt: timestamp,
      lastOperationId: `tombstone:${operationId()}`,
      deletedAt: timestamp,
    }));
}

/** Tombstone every active allocation for one goal in a single local batch. */
export function applyGoalAllocationReleaseMutation(
  state: PersistedFinanceState,
  goalId: string,
  now = new Date(),
  operationId: () => string = () => crypto.randomUUID(),
  batchId: string = crypto.randomUUID(),
): PersistedFinanceState {
  const goal = state.data.goals.find((candidate) => candidate.id === goalId && !candidate.deletedAt);
  if (!goal) throw new Error('找不到儲蓄目標，本次釋放未執行。');
  const releases = releaseGoalAllocations(state.data.allocations, goalId, now, operationId);
  let next = state;
  for (const allocation of releases) {
    next = putRecord(next, 'allocations', allocation, batchId);
  }
  return next;
}

export function hasUserContent(data: FinanceData): boolean {
  const baseline = createInitialData('guest');
  const comparableAccounts = (source: FinanceData['accounts']) => source.map((record) => ({
    id: record.id,
    name: record.name,
    icon: record.icon,
    openingBalance: record.openingBalance,
    includeInTotalAssets: record.includeInTotalAssets,
    isActive: record.isActive,
    deletedAt: record.deletedAt,
    sortOrder: record.sortOrder,
    legacyKey: record.legacyKey,
    requiresReview: record.requiresReview,
  }));
  const comparableCategories = (source: FinanceData['categories']) => source.map((record) => ({
    id: record.id,
    kind: record.kind,
    name: record.name,
    icon: record.icon,
    isActive: record.isActive,
    deletedAt: record.deletedAt,
    sortOrder: record.sortOrder,
    legacyKey: record.legacyKey,
  }));
  return data.transactions.some((transaction) => !isTutorialTransaction(transaction))
    || data.transfers.length > 0
    || data.adjustments.length > 0
    || data.goals.length > 0
    || data.allocations.length > 0
    || data.budgets.length > 0
    || data.recurringRules.length > 0
    || JSON.stringify(data.settings) !== JSON.stringify(baseline.settings)
    || JSON.stringify(comparableAccounts(data.accounts)) !== JSON.stringify(comparableAccounts(baseline.accounts))
    || JSON.stringify(comparableCategories(data.categories)) !== JSON.stringify(comparableCategories(baseline.categories));
}

/** Stable, non-secret fingerprint used only to remember a user's guest-import decision. */
export function guestSnapshotFingerprint(data: FinanceData): string {
  const text = JSON.stringify(data);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Remap a guest dataset only after the user explicitly asks to import it. */
export function remapOwner(data: FinanceData, ownerId: string): FinanceData {
  const accountIds = new Map(data.accounts.map((record) => [record.id, stableLegacyId('account', ownerId, 'guest-import', record.id)]));
  const categoryIds = new Map(data.categories.map((record) => [record.id, stableLegacyId('category', ownerId, 'guest-import', record.id)]));
  const goalIds = new Map(data.goals.map((record) => [record.id, stableLegacyId('goal', ownerId, 'guest-import', record.id)]));
  const recurringIds = new Map(data.recurringRules.map((record) => [record.id, stableLegacyId('recurring', ownerId, 'guest-import', record.id)]));
  const remap = <T extends SyncRecord>(record: T, id: string): T => ({
    ...record,
    id,
    ownerId,
    version: record.version + 1,
    updatedAt: new Date().toISOString(),
    lastOperationId: record.deletedAt
      ? `tombstone:${crypto.randomUUID()}`
      : activeOperationId(),
  });
  return {
    ...structuredClone(data),
    accounts: data.accounts.map((record) => remap(record, accountIds.get(record.id)!)),
    categories: data.categories.map((record) => remap(record, categoryIds.get(record.id)!)),
    transactions: data.transactions
      .filter((record) => !isTutorialTransaction(record))
      .map((record) => {
      const recurringRuleId = record.recurringRuleId ? recurringIds.get(record.recurringRuleId) : undefined;
      const id = recurringRuleId && record.occurrenceDate
        ? `rec-${recurringRuleId}-${record.occurrenceDate}`
        : stableLegacyId('transaction', ownerId, 'guest-import', record.id);
      return remap({
        ...record,
        accountId: accountIds.get(record.accountId)!,
        categoryId: categoryIds.get(record.categoryId)!,
        ...(recurringRuleId ? { recurringRuleId } : {}),
      }, id);
      }),
    transfers: data.transfers.map((record) => remap({
      ...record,
      sourceAccountId: accountIds.get(record.sourceAccountId)!,
      destinationAccountId: accountIds.get(record.destinationAccountId)!,
    }, stableLegacyId('transfer', ownerId, 'guest-import', record.id))),
    adjustments: data.adjustments.map((record) => remap({
      ...record,
      accountId: accountIds.get(record.accountId)!,
    }, stableLegacyId('adjustment', ownerId, 'guest-import', record.id))),
    goals: data.goals.map((record) => remap(record, goalIds.get(record.id)!)),
    allocations: data.allocations.map((record) => remap({
      ...record,
      goalId: goalIds.get(record.goalId)!,
    }, stableLegacyId('allocation', ownerId, 'guest-import', record.id))),
    budgets: data.budgets.map((record) => remap({
      ...record,
      ...(record.categoryId ? { categoryId: categoryIds.get(record.categoryId)! } : {}),
    }, stableLegacyId('budget', ownerId, 'guest-import', record.id))),
    recurringRules: data.recurringRules.map((record) => remap({
      ...record,
      accountId: accountIds.get(record.accountId)!,
      categoryId: categoryIds.get(record.categoryId)!,
    }, recurringIds.get(record.id)!)),
    settings: {
      ...data.settings,
      ...(data.settings.activeGoalId
        ? { activeGoalId: goalIds.get(data.settings.activeGoalId) }
        : {}),
    },
  };
}

/**
 * Preserve mutations made while an async sync was in flight. Remote/pulled data
 * forms the base; records and outbox operations whose clock changed after the
 * captured start snapshot are replayed on top.
 */
export function mergeConcurrentSync(
  started: PersistedFinanceState,
  latest: PersistedFinanceState,
  synced: PersistedFinanceState,
): PersistedFinanceState {
  if (started.ownerId !== latest.ownerId || latest.ownerId !== synced.ownerId) {
    throw new Error('Cannot merge concurrent sync snapshots for different owners');
  }
  let data = structuredClone(synced.data);
  for (const entity of entityNames) {
    const startedById = new Map((started.data[entity] as SyncRecord[]).map((record) => [record.id, record]));
    const merged = [...data[entity] as SyncRecord[]];
    const indexById = new Map(merged.map((record, index) => [record.id, index]));
    for (const record of latest.data[entity] as SyncRecord[]) {
      const before = startedById.get(record.id);
      const changedAfterStart = before === undefined
        || before.version !== record.version
        || before.lastOperationId !== record.lastOperationId
        || before.deletedAt !== record.deletedAt;
      if (!changedAfterStart) continue;
      const index = indexById.get(record.id);
      if (index === undefined) {
        indexById.set(record.id, merged.length);
        merged.push(structuredClone(record));
      } else {
        merged[index] = structuredClone(record);
      }
    }
    data = { ...data, [entity]: merged } as FinanceData;
  }
  if (JSON.stringify(latest.data.settings) !== JSON.stringify(started.data.settings)) {
    data.settings = structuredClone(latest.data.settings);
  }

  const operationKey = (operation: PersistedFinanceState['outbox'][number]) => `${operation.entity}:${operation.recordId}`;
  const startedByRecord = new Map(started.outbox.map((operation) => [operationKey(operation), operation]));
  const combined = new Map(synced.outbox.map((operation) => [operationKey(operation), operation]));
  for (const operation of latest.outbox) {
    const atStart = startedByRecord.get(operationKey(operation));
    if (!atStart || atStart.id !== operation.id) combined.set(operationKey(operation), structuredClone(operation));
  }
  return { ...synced, data, outbox: [...combined.values()] };
}

/** Fail closed when an async response belongs to an owner/session that is no longer active. */
export function applySyncCompletion(
  started: PersistedFinanceState,
  latest: PersistedFinanceState,
  synced: PersistedFinanceState,
  activeOwnerId: OwnerId,
): PersistedFinanceState {
  if (started.ownerId !== activeOwnerId
    || latest.ownerId !== activeOwnerId
    || synced.ownerId !== activeOwnerId) {
    return latest;
  }
  return mergeConcurrentSync(started, latest, synced);
}
