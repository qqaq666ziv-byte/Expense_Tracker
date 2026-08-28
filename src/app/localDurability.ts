import type { OwnerId, PersistedFinanceState } from '../domain/model';
import {
  createInitialState,
  legacyStorageKeys,
  loadFinanceStateWithRecovery,
  storageKey,
  type LoadedFinanceState,
  type LocalStateRecovery,
} from './state';

const DATABASE_NAME = 'shiba-finance-durable-v1';
const DATABASE_VERSION = 1;
const OWNER_STATE_STORE = 'ownerStates';
const TRANSACTION_TIMEOUT_MS = 15_000;

interface StoredOwnerState {
  ownerId: OwnerId;
  revision: number;
  state: PersistedFinanceState;
  appliedAttemptIds: string[];
  /** Exact v4 and pre-v3 localStorage sources retained to detect an older PWA writer. */
  legacySourceRaw: string | null;
}

export interface OwnerStateStore {
  transact(
    ownerId: OwnerId,
    update: (current: StoredOwnerState | undefined) => StoredOwnerState,
  ): Promise<StoredOwnerState>;
}

export interface InMemoryOwnerStateStore extends OwnerStateStore {
  failNextWrite(error: unknown): void;
}

export type DurableCommitResult =
  | {
      ok: true;
      state: PersistedFinanceState;
      revision: number;
      replayed: boolean;
    }
  | {
      ok: false;
      code: 'DOMAIN_REJECTED' | 'RECOVERY_LOCKED' | 'DURABILITY_FAILED';
      message: string;
      lockWrites: boolean;
    };

export interface FinancePersistence {
  load(ownerId: OwnerId): Promise<LoadedFinanceState>;
  commit(
    ownerId: OwnerId,
    attemptId: string,
    update: (latest: PersistedFinanceState) => PersistedFinanceState,
  ): Promise<DurableCommitResult>;
  recover(
    ownerId: OwnerId,
    attemptId: string,
    expectedRecoveryRaw: string,
    replacement: PersistedFinanceState,
  ): Promise<DurableCommitResult>;
}

class RecoveryLockedError extends Error {
  constructor(readonly loaded: LoadedFinanceState) {
    super(loaded.recovery?.message ?? '本機財務資料仍在復原保護中');
    this.name = 'RecoveryLockedError';
  }
}

class DomainRejectedError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'DomainRejectedError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRecoveryRevision(value: StoredOwnerState | undefined): number {
  return value && Number.isSafeInteger(value.revision) && value.revision >= 0
    ? value.revision
    : 0;
}

function safeRecoveryAttemptIds(value: StoredOwnerState | undefined): string[] {
  if (!value || !Array.isArray(value.appliedAttemptIds)) return [];
  const ids = value.appliedAttemptIds.filter(
    (attemptId): attemptId is string => typeof attemptId === 'string' && attemptId.length > 0,
  );
  return [...new Set(ids)];
}

function cloneEnvelope(value: StoredOwnerState | undefined): StoredOwnerState | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function assertStoredEnvelope(ownerId: OwnerId, value: StoredOwnerState): StoredOwnerState {
  if (!value || value.ownerId !== ownerId || value.state.ownerId !== ownerId) {
    throw new RecoveryLockedError({
      state: createInitialState(ownerId),
      recovery: {
        key: storageKey(ownerId),
        raw: JSON.stringify(value ?? null),
        message: 'IndexedDB 本機帳本的 owner 驗證失敗；已停止寫入。',
      },
    });
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.appliedAttemptIds)
    || value.appliedAttemptIds.some((attemptId) => typeof attemptId !== 'string' || !attemptId)
    || new Set(value.appliedAttemptIds).size !== value.appliedAttemptIds.length
    || (value.legacySourceRaw !== null && typeof value.legacySourceRaw !== 'string')) {
    throw new RecoveryLockedError({
      state: createInitialState(ownerId),
      recovery: {
        key: storageKey(ownerId),
        raw: JSON.stringify(value),
        message: 'IndexedDB 本機帳本的 revision 或重試收據無法驗證；已停止寫入。',
      },
    });
  }
  const serialized = JSON.stringify(value.state);
  const loaded = loadFinanceStateWithRecovery(ownerId, {
    getItem: (key) => key === storageKey(ownerId) ? serialized : null,
  });
  if (loaded.recovery) throw new RecoveryLockedError(loaded);
  return {
    ...value,
    state: loaded.state,
  };
}

function readLegacySourceRaw(
  ownerId: OwnerId,
  legacyStorage: Pick<Storage, 'getItem'>,
): string | null {
  return JSON.stringify(Object.fromEntries([
    storageKey(ownerId),
    ...legacyStorageKeys(ownerId),
  ].map((key) => [key, legacyStorage.getItem(key)])));
}

function assertLegacySourceUnchanged(
  ownerId: OwnerId,
  value: StoredOwnerState,
  legacyStorage: Pick<Storage, 'getItem'>,
): StoredOwnerState {
  let currentRaw: string | null;
  try {
    currentRaw = readLegacySourceRaw(ownerId, legacyStorage);
  } catch (error) {
    throw new RecoveryLockedError({
      state: structuredClone(value.state),
      recovery: {
        key: storageKey(ownerId),
        raw: '',
        message: `無法確認 localStorage migration source 是否被舊版程式改寫：${errorMessage(error)}`,
      },
    });
  }
  if (currentRaw !== value.legacySourceRaw) {
    throw new RecoveryLockedError({
      state: structuredClone(value.state),
      recovery: {
        key: storageKey(ownerId),
        raw: currentRaw ?? '',
        message: '偵測到舊版 PWA 或其他分頁在 IndexedDB migration 後改寫 localStorage；已保留兩邊資料並停止自動合併。',
      },
    });
  }
  return value;
}

function initialEnvelope(
  ownerId: OwnerId,
  legacyStorage: Pick<Storage, 'getItem'>,
): StoredOwnerState {
  const sourceRaw = readLegacySourceRaw(ownerId, legacyStorage);
  const loaded = loadFinanceStateWithRecovery(ownerId, legacyStorage);
  if (loaded.recovery) throw new RecoveryLockedError(loaded);
  const afterRaw = readLegacySourceRaw(ownerId, legacyStorage);
  if (afterRaw !== sourceRaw) {
    throw new RecoveryLockedError({
      state: loaded.state,
      recovery: {
        key: storageKey(ownerId),
        raw: afterRaw ?? '',
        message: 'localStorage 在 IndexedDB migration 期間被其他分頁改寫；已停止匯入以避免遺失資料。',
      },
    });
  }
  return {
    ownerId,
    revision: 0,
    state: loaded.state,
    appliedAttemptIds: [],
    legacySourceRaw: sourceRaw,
  };
}

export function createFinancePersistence(
  store: OwnerStateStore,
  legacyStorage: Pick<Storage, 'getItem'>,
): FinancePersistence {
  const durabilityFailure = (error: unknown): DurableCommitResult => ({
    ok: false,
    code: 'DURABILITY_FAILED',
    message: errorMessage(error),
    lockWrites: true,
  });
  return {
    async load(ownerId) {
      try {
        const stored = await store.transact(ownerId, (current) => (
          current
            ? assertLegacySourceUnchanged(
              ownerId,
              assertStoredEnvelope(ownerId, current),
              legacyStorage,
            )
            : initialEnvelope(ownerId, legacyStorage)
        ));
        return { state: structuredClone(stored.state) };
      } catch (error) {
        if (error instanceof RecoveryLockedError) return error.loaded;
        throw error;
      }
    },
    async commit(ownerId, attemptId, update) {
      if (!attemptId) {
        return {
          ok: false,
          code: 'DOMAIN_REJECTED',
          message: '本機寫入缺少不可重複的操作識別碼。',
          lockWrites: false,
        };
      }
      let replayed = false;
      try {
        const stored = await store.transact(ownerId, (current) => {
          const envelope = current
            ? assertLegacySourceUnchanged(
              ownerId,
              assertStoredEnvelope(ownerId, current),
              legacyStorage,
            )
            : initialEnvelope(ownerId, legacyStorage);
          if (envelope.appliedAttemptIds.includes(attemptId)) {
            replayed = true;
            return envelope;
          }
          let next: PersistedFinanceState;
          try {
            next = update(structuredClone(envelope.state));
          } catch (error) {
            throw new DomainRejectedError(error);
          }
          // A temporary guard may deliberately return the current state (for
          // example recurrence while sync begins). Do not consume the retry
          // receipt until the logical operation actually changes durable data.
          if (JSON.stringify(next) === JSON.stringify(envelope.state)) return envelope;
          let validated: StoredOwnerState;
          try {
            validated = assertStoredEnvelope(ownerId, {
              ownerId,
              revision: envelope.revision + 1,
              state: next,
              appliedAttemptIds: [...envelope.appliedAttemptIds, attemptId],
              legacySourceRaw: envelope.legacySourceRaw,
            });
          } catch (error) {
            if (error instanceof RecoveryLockedError) {
              throw new DomainRejectedError(error.loaded.recovery?.message ?? error.message);
            }
            throw error;
          }
          return validated;
        });
        return {
          ok: true,
          state: structuredClone(stored.state),
          revision: stored.revision,
          replayed,
        };
      } catch (error) {
        if (error instanceof DomainRejectedError) {
          return {
            ok: false,
            code: 'DOMAIN_REJECTED',
            message: error.message,
            lockWrites: false,
          };
        }
        if (error instanceof RecoveryLockedError) {
          return {
            ok: false,
            code: 'RECOVERY_LOCKED',
            message: error.message,
            lockWrites: true,
          };
        }
        return durabilityFailure(error);
      }
    },
    async recover(ownerId, attemptId, expectedRecoveryRaw, replacement) {
      if (!attemptId || replacement.ownerId !== ownerId) {
        return {
          ok: false,
          code: 'DOMAIN_REJECTED',
          message: '復原 replacement 的 owner 或操作識別碼無效。',
          lockWrites: false,
        };
      }
      try {
        const stored = await store.transact(ownerId, (current) => {
          let observedRecovery: LocalStateRecovery | undefined;
          if (current) {
            try {
              assertLegacySourceUnchanged(
                ownerId,
                assertStoredEnvelope(ownerId, current),
                legacyStorage,
              );
            } catch (error) {
              if (error instanceof RecoveryLockedError) observedRecovery = error.loaded.recovery;
              else throw error;
            }
            if (!observedRecovery) {
              throw new DomainRejectedError('本機帳本已被其他分頁修復；請重新載入後再決定。');
            }
          } else {
            observedRecovery = loadFinanceStateWithRecovery(ownerId, legacyStorage).recovery;
          }
          if (!observedRecovery || observedRecovery.raw !== expectedRecoveryRaw) {
            throw new DomainRejectedError('復原來源已變更；本次 replacement 未寫入。');
          }
          try {
            return assertStoredEnvelope(ownerId, {
              ownerId,
              revision: safeRecoveryRevision(current) + 1,
              state: replacement,
              appliedAttemptIds: [...safeRecoveryAttemptIds(current), attemptId],
              legacySourceRaw: readLegacySourceRaw(ownerId, legacyStorage),
            });
          } catch (error) {
            throw new DomainRejectedError(error);
          }
        });
        return {
          ok: true,
          state: structuredClone(stored.state),
          revision: stored.revision,
          replayed: false,
        };
      } catch (error) {
        if (error instanceof DomainRejectedError) {
          return {
            ok: false,
            code: 'DOMAIN_REJECTED',
            message: error.message,
            lockWrites: false,
          };
        }
        return durabilityFailure(error);
      }
    },
  };
}

export function createInMemoryOwnerStateStore(): InMemoryOwnerStateStore {
  const states = new Map<OwnerId, StoredOwnerState>();
  let nextFailure: unknown;
  let queue = Promise.resolve();
  return {
    failNextWrite(error) {
      nextFailure = error;
    },
    transact(ownerId, update) {
      const transaction = queue.then(() => {
        const current = cloneEnvelope(states.get(ownerId));
        const next = update(current);
        if (nextFailure !== undefined) {
          const error = nextFailure;
          nextFailure = undefined;
          throw error;
        }
        states.set(ownerId, structuredClone(next));
        return structuredClone(next);
      });
      queue = transaction.then(() => undefined, () => undefined);
      return transaction;
    },
  };
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OWNER_STATE_STORE)) {
        request.result.createObjectStore(OWNER_STATE_STORE);
      }
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error('IndexedDB 開啟失敗'));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('IndexedDB 升級被其他分頁阻擋'));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function strictReadWriteTransaction(database: IDBDatabase): IDBTransaction {
  try {
    return database.transaction(OWNER_STATE_STORE, 'readwrite', { durability: 'strict' });
  } catch {
    return database.transaction(OWNER_STATE_STORE, 'readwrite');
  }
}

export function createIndexedDbOwnerStateStore(
  factory: IDBFactory,
  databaseName = DATABASE_NAME,
): OwnerStateStore {
  let databasePromise: Promise<IDBDatabase> | undefined;
  const database = () => {
    databasePromise ??= openDatabase(factory, databaseName);
    return databasePromise;
  };
  return {
    async transact(ownerId, update) {
      const opened = await database();
      return new Promise<StoredOwnerState>((resolve, reject) => {
        let result: StoredOwnerState | undefined;
        let failure: unknown;
        let settled = false;
        const transaction = strictReadWriteTransaction(opened);
        const timeout = window.setTimeout(() => {
          if (settled) return;
          failure = new Error('IndexedDB 寫入逾時；已停止後續財務寫入。');
          try { transaction.abort(); } catch { /* transaction may already be finishing */ }
        }, TRANSACTION_TIMEOUT_MS);
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          callback();
        };
        transaction.oncomplete = () => finish(() => {
          if (!result) {
            reject(new Error('IndexedDB transaction completed without an owner state'));
            return;
          }
          resolve(structuredClone(result));
        });
        transaction.onabort = () => finish(() => reject(
          failure ?? transaction.error ?? new Error('IndexedDB transaction aborted'),
        ));
        transaction.onerror = () => {
          failure ??= transaction.error ?? new Error('IndexedDB transaction failed');
        };
        const objectStore = transaction.objectStore(OWNER_STATE_STORE);
        const read = objectStore.get(ownerId);
        read.onerror = () => {
          failure = read.error ?? new Error('IndexedDB owner state read failed');
        };
        read.onsuccess = () => {
          try {
            result = update(cloneEnvelope(read.result as StoredOwnerState | undefined));
            const write = objectStore.put(result, ownerId);
            write.onerror = () => {
              failure = write.error ?? new Error('IndexedDB owner state write failed');
            };
          } catch (error) {
            failure = error;
            try { transaction.abort(); } catch { /* already aborted */ }
          }
        };
      });
    },
  };
}

let browserPersistence: FinancePersistence | undefined;

export function getBrowserFinancePersistence(): FinancePersistence {
  if (browserPersistence) return browserPersistence;
  if (typeof indexedDB === 'undefined' || typeof localStorage === 'undefined') {
    const unavailableStore: OwnerStateStore = {
      transact: async () => { throw new Error('此瀏覽器無法使用 IndexedDB 本機帳本'); },
    };
    browserPersistence = createFinancePersistence(unavailableStore, {
      getItem: () => { throw new Error('此瀏覽器無法讀取既有本機帳本'); },
    });
    return browserPersistence;
  }
  browserPersistence = createFinancePersistence(
    createIndexedDbOwnerStateStore(indexedDB),
    localStorage,
  );
  return browserPersistence;
}

export function durabilityRecovery(
  ownerId: OwnerId,
  error: unknown,
): LocalStateRecovery {
  return {
    key: storageKey(ownerId),
    raw: '',
    message: `本機 durable storage 無法使用：${errorMessage(error)}`,
  };
}
