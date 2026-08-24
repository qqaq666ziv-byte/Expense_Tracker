import { describe, expect, it } from 'vitest';
import type {
  AssetAccount,
  Category,
  FinanceData,
  PendingOperation,
  PersistedFinanceState,
  SavingsAllocation,
  SavingsGoal,
  Transaction,
} from './model';
import type { RemoteAdapter, RemoteRecord } from './syncEngine';
import { enqueueSyncRecord, syncFinanceState } from './syncEngine';

const NOW = '2026-08-21T10:00:00.000Z';

function emptyData(): FinanceData {
  return {
    accounts: [],
    categories: [],
    transactions: [],
    adjustments: [],
    goals: [],
    allocations: [],
    budgets: [],
    recurringRules: [],
    settings: { currency: 'TWD', locale: 'zh-TW' },
  };
}

function account(
  id: string,
  ownerId: string,
  version: number,
  lastOperationId: string,
  deletedAt?: string,
): AssetAccount {
  return {
    id,
    ownerId,
    name: id,
    icon: { type: 'emoji', value: '💵' },
    openingBalance: 0,
    includeInTotalAssets: true,
    isActive: true,
    sortOrder: 0,
    version,
    updatedAt: NOW,
    lastOperationId,
    deletedAt,
  };
}

function operation(record: AssetAccount): PendingOperation {
  return {
    id: record.lastOperationId,
    entity: 'accounts',
    recordId: record.id,
    record,
    attempts: 0,
    queuedAt: NOW,
  };
}

function allocationOperation(record: SavingsAllocation): PendingOperation {
  return {
    id: record.lastOperationId,
    entity: 'allocations',
    recordId: record.id,
    record,
    attempts: 0,
    queuedAt: NOW,
  };
}

function state(
  ownerId: string,
  records: AssetAccount[],
  outbox: PendingOperation[],
): PersistedFinanceState {
  return {
    schemaVersion: 3,
    ownerId,
    data: { ...emptyData(), accounts: records },
    outbox,
  };
}

class InMemoryRemote implements RemoteAdapter {
  private readonly records = new Map<string, RemoteRecord>();
  private readonly acceptedOperationIds = new Set<string>();
  readonly failBeforeApplyOnce = new Set<string>();
  readonly failAfterApplyOnce = new Set<string>();

  constructor(records: RemoteRecord[] = []) {
    for (const record of records) {
      this.records.set(this.key(record), record);
    }
  }

  async pull(ownerId: string): Promise<RemoteRecord[]> {
    return [...this.records.values()].filter(({ record }) => record.ownerId === ownerId);
  }

  async apply(ownerId: string, pending: PendingOperation): Promise<void> {
    if (pending.record.ownerId !== ownerId) {
      throw new Error('owner mismatch');
    }

    if (this.failBeforeApplyOnce.delete(pending.id)) {
      throw new Error('offline before apply');
    }

    const ownerOperationId = `${ownerId}:${pending.id}`;
    if (!this.acceptedOperationIds.has(ownerOperationId)) {
      const envelope = { entity: pending.entity, record: pending.record } as RemoteRecord;
      const existing = this.records.get(this.key(envelope));
      const operationWins = existing === undefined
        || pending.record.version > existing.record.version
        || (
          pending.record.version === existing.record.version
          && pending.record.lastOperationId > existing.record.lastOperationId
        );
      if (operationWins) {
        this.records.set(this.key(envelope), envelope);
      }
      this.acceptedOperationIds.add(ownerOperationId);
    }

    if (this.failAfterApplyOnce.delete(pending.id)) {
      throw new Error('connection dropped after apply');
    }
  }

  private key({ entity, record }: RemoteRecord): string {
    return `${entity}:${record.id}`;
  }
}

describe('offline sync engine', () => {
  it('uses an authenticated legacy cache only as a candidate when the remote row was deleted', async () => {
    const legacyAccount = account('legacy-cash', 'user-a', 1, 'op-legacy-cash');
    const legacyCategory: Category = {
      id: 'legacy-food',
      ownerId: 'user-a',
      version: 1,
      updatedAt: NOW,
      lastOperationId: 'op-legacy-food',
      kind: 'expense',
      name: '餐飲',
      icon: { type: 'emoji', value: '🍜' },
      isActive: true,
      sortOrder: 0,
    };
    const staleCachedTransaction: Transaction = {
      id: 'remote-deleted-transaction',
      ownerId: 'user-a',
      version: 1,
      updatedAt: NOW,
      lastOperationId: 'op-legacy-transaction',
      amount: 120,
      type: 'expense',
      categoryId: legacyCategory.id,
      categoryName: legacyCategory.name,
      accountId: legacyAccount.id,
      accountName: legacyAccount.name,
      occurredAt: '2026-08-20 12:00',
    };
    const candidate: FinanceData = {
      ...emptyData(),
      accounts: [legacyAccount],
      categories: [legacyCategory],
      transactions: [staleCachedTransaction],
    };
    const bootstrap: PersistedFinanceState = {
      schemaVersion: 3,
      ownerId: 'user-a',
      data: emptyData(),
      outbox: [],
      migratedFromLegacy: true,
      legacyBootstrap: {
        status: 'pending',
        candidate,
        unsyncedTransactionIds: [],
      },
    };
    let applyCount = 0;
    const remote: RemoteAdapter = {
      apply: async () => { applyCount += 1; },
      pull: async () => [],
    };

    const result = await syncFinanceState(bootstrap, 'user-a', remote, () => NOW);

    expect(applyCount).toBe(0);
    expect(result.report).toMatchObject({ status: 'synced', applied: 0, pulled: 0 });
    expect(result.state.data.transactions).toEqual([]);
    expect(result.state.outbox).toEqual([]);
    expect(result.state.legacyBootstrap).toEqual({
      status: 'ready',
      candidate,
      unsyncedTransactionIds: [],
    });
  });

  it('keeps the authenticated legacy bootstrap gated when pull reports any issue', async () => {
    const legacyAccount = account('legacy-cash', 'user-a', 1, 'op-legacy-cash');
    const candidate: FinanceData = { ...emptyData(), accounts: [legacyAccount] };
    const bootstrap: PersistedFinanceState = {
      schemaVersion: 3,
      ownerId: 'user-a',
      data: emptyData(),
      outbox: [],
      migratedFromLegacy: true,
      legacyBootstrap: {
        status: 'pending',
        candidate,
        unsyncedTransactionIds: [],
      },
    };
    let applyCount = 0;
    const remoteAccount = account('cloud-cash', 'user-a', 2, 'op-cloud-cash');
    const remote: RemoteAdapter = {
      apply: async () => { applyCount += 1; },
      pull: async () => ({
        records: [{ entity: 'accounts', record: remoteAccount }],
        issues: [{
          stage: 'validation',
          entity: 'transactions',
          recordId: 'malformed-row',
          message: 'Skipped inconsistent transactions/malformed-row',
        }],
      }),
    };

    const result = await syncFinanceState(bootstrap, 'user-a', remote, () => NOW);

    expect(applyCount).toBe(0);
    expect(result.report).toMatchObject({ status: 'partial', applied: 0, pulled: 1 });
    expect(result.state.data).toEqual(bootstrap.data);
    expect(result.state.outbox).toEqual([]);
    expect(result.state.lastSyncedAt).toBeUndefined();
    expect(result.state.legacyBootstrap).toEqual(bootstrap.legacyBootstrap);
  });

  it('does not allow a local operation to enter a pending authenticated legacy bootstrap', () => {
    const legacyAccount = account('legacy-cash', 'user-a', 1, 'op-legacy-cash');
    const bootstrap: PersistedFinanceState = {
      schemaVersion: 3,
      ownerId: 'user-a',
      data: emptyData(),
      outbox: [],
      migratedFromLegacy: true,
      legacyBootstrap: {
        status: 'pending',
        candidate: { ...emptyData(), accounts: [legacyAccount] },
        unsyncedTransactionIds: [],
      },
    };

    expect(() => enqueueSyncRecord(bootstrap, 'accounts', legacyAccount)).toThrow(
      /legacy bootstrap/i,
    );
    expect(bootstrap.outbox).toEqual([]);
  });

  it('keeps the candidate and pending gate when the authenticated legacy pull fails', async () => {
    const legacyAccount = account('legacy-cash', 'user-a', 1, 'op-legacy-cash');
    const bootstrap: PersistedFinanceState = {
      schemaVersion: 3,
      ownerId: 'user-a',
      data: emptyData(),
      outbox: [],
      migratedFromLegacy: true,
      legacyBootstrap: {
        status: 'pending',
        candidate: { ...emptyData(), accounts: [legacyAccount] },
        unsyncedTransactionIds: [],
      },
    };
    let applyCount = 0;
    const remote: RemoteAdapter = {
      apply: async () => { applyCount += 1; },
      pull: async () => { throw new Error('offline during bootstrap pull'); },
    };

    const result = await syncFinanceState(bootstrap, 'user-a', remote, () => NOW);

    expect(applyCount).toBe(0);
    expect(result.report).toMatchObject({ status: 'partial', applied: 0, pulled: 0 });
    expect(result.report.failures).toEqual([
      expect.objectContaining({ stage: 'pull', message: 'offline during bootstrap pull' }),
    ]);
    expect(result.state.data).toEqual(bootstrap.data);
    expect(result.state.legacyBootstrap).toEqual(bootstrap.legacyBootstrap);
    expect(result.state.lastSyncedAt).toBeUndefined();
  });

  it('keeps the bootstrap gated when a nominally successful pull has an invalid graph', async () => {
    const legacyAccount = account('legacy-cash', 'user-a', 1, 'op-legacy-cash');
    const bootstrap: PersistedFinanceState = {
      schemaVersion: 3,
      ownerId: 'user-a',
      data: emptyData(),
      outbox: [],
      migratedFromLegacy: true,
      legacyBootstrap: {
        status: 'pending',
        candidate: { ...emptyData(), accounts: [legacyAccount] },
        unsyncedTransactionIds: [],
      },
    };
    const invalidRemoteTransaction: Transaction = {
      id: 'orphan-transaction',
      ownerId: 'user-a',
      version: 1,
      updatedAt: NOW,
      lastOperationId: 'op-orphan',
      amount: 88,
      type: 'expense',
      categoryId: 'missing-category',
      categoryName: '餐飲',
      accountId: 'missing-account',
      accountName: '現金',
      occurredAt: '2026-08-20 12:00',
    };
    const remote: RemoteAdapter = {
      apply: async () => { throw new Error('bootstrap must never apply'); },
      pull: async () => [{ entity: 'transactions', record: invalidRemoteTransaction }],
    };

    const result = await syncFinanceState(bootstrap, 'user-a', remote, () => NOW);

    expect(result.report.status).toBe('partial');
    expect(result.report.failures).toEqual([
      expect.objectContaining({ stage: 'validation', message: expect.stringContaining('remote bootstrap graph') }),
    ]);
    expect(result.state.data).toEqual(bootstrap.data);
    expect(result.state.legacyBootstrap).toEqual(bootstrap.legacyBootstrap);
  });

  it('queues create, update, and delete as idempotent record snapshots and tombstones', () => {
    const created = account('cash', 'user-a', 1, 'op-create');
    const updated = { ...created, name: 'wallet', version: 2, lastOperationId: 'op-update' };
    const deleted = {
      ...updated,
      version: 3,
      lastOperationId: 'op-delete',
      deletedAt: NOW,
    };

    const afterCreate = enqueueSyncRecord(state('user-a', [], []), 'accounts', created, NOW);
    expect(afterCreate.data.accounts).toEqual([created]);
    expect(afterCreate.outbox).toEqual([operation(created)]);

    const afterUpdate = enqueueSyncRecord(afterCreate, 'accounts', updated, NOW);
    expect(afterUpdate.data.accounts).toEqual([updated]);
    expect(afterUpdate.outbox).toEqual([operation(updated)]);

    const afterDelete = enqueueSyncRecord(afterUpdate, 'accounts', deleted, NOW);
    expect(afterDelete.data.accounts).toEqual([deleted]);
    expect(afterDelete.outbox).toEqual([operation(deleted)]);
  });

  it('retries an acknowledged create idempotently and clears it only after success', async () => {
    const created = account('cash', 'user-a', 1, 'op-create-cash');
    const remote = new InMemoryRemote();
    remote.failAfterApplyOnce.add(created.lastOperationId);

    const first = await syncFinanceState(
      state('user-a', [created], [operation(created)]),
      'user-a',
      remote,
      () => NOW,
    );

    expect(first.report).toMatchObject({ status: 'partial', applied: 0 });
    expect(first.report.pending).toEqual([{
      operationId: 'op-create-cash',
      entity: 'accounts',
      recordId: 'cash',
      attempts: 1,
      lastError: 'connection dropped after apply',
    }]);
    expect(first.report.failures).toHaveLength(1);

    const second = await syncFinanceState(first.state, 'user-a', remote, () => NOW);

    expect(second.report).toMatchObject({
      status: 'synced',
      applied: 1,
      pending: [],
      failures: [],
    });
    expect(second.state.outbox).toEqual([]);
    expect(await remote.pull('user-a')).toEqual([{ entity: 'accounts', record: created }]);
  });

  it('retries offline updates and deletes without letting stale cloud records overwrite them', async () => {
    const oldEdited = account('wallet', 'user-a', 1, 'op-create-wallet');
    const oldDeleted = account('obsolete', 'user-a', 1, 'op-create-obsolete');
    const edited = {
      ...oldEdited,
      name: 'renamed wallet',
      version: 2,
      lastOperationId: 'op-update-wallet',
    };
    const deleted = {
      ...oldDeleted,
      version: 2,
      lastOperationId: 'op-delete-obsolete',
      deletedAt: NOW,
    };
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: oldEdited },
      { entity: 'accounts', record: oldDeleted },
    ]);
    remote.failBeforeApplyOnce.add(edited.lastOperationId);
    remote.failBeforeApplyOnce.add(deleted.lastOperationId);

    const first = await syncFinanceState(
      state('user-a', [edited, deleted], [operation(edited), operation(deleted)]),
      'user-a',
      remote,
      () => NOW,
    );

    expect(first.state.data.accounts).toEqual([edited, deleted]);
    expect(first.state.outbox.map(({ attempts, lastError }) => ({ attempts, lastError }))).toEqual([
      { attempts: 1, lastError: 'offline before apply' },
      { attempts: 1, lastError: 'offline before apply' },
    ]);
    expect(first.report.conflicts).toEqual([
      expect.objectContaining({ recordId: 'wallet', winner: 'local', reason: 'pending-local' }),
      expect.objectContaining({ recordId: 'obsolete', winner: 'local', reason: 'pending-local' }),
    ]);

    const second = await syncFinanceState(first.state, 'user-a', remote, () => NOW);

    expect(second.report).toMatchObject({ status: 'synced', applied: 2, pending: [], failures: [] });
    expect(second.state.outbox).toEqual([]);
    expect(await remote.pull('user-a')).toEqual([
      { entity: 'accounts', record: edited },
      { entity: 'accounts', record: deleted },
    ]);
  });

  it('keeps guest, user A, and user B state in separate ownership partitions', async () => {
    const guestAccount = account('guest-cash', 'guest', 1, 'op-guest-cash');
    const userACloudAccount = account('user-a-cash', 'user-a', 1, 'op-user-a-cloud');
    const remote = new InMemoryRemote([{ entity: 'accounts', record: userACloudAccount }]);

    const guestAttempt = await syncFinanceState(
      state('guest', [guestAccount], [operation(guestAccount)]),
      'user-a',
      remote,
      () => NOW,
    );

    expect(guestAttempt.report).toMatchObject({
      status: 'rejected',
      applied: 0,
      pulled: 0,
      conflicts: [],
    });
    expect(guestAttempt.report.failures[0]).toMatchObject({ stage: 'validation' });
    expect(guestAttempt.state.data.accounts).toEqual([guestAccount]);
    expect(await remote.pull('user-a')).toEqual([{ entity: 'accounts', record: userACloudAccount }]);

    const userAAccount = account('user-a-local', 'user-a', 1, 'op-user-a-local');
    const wrongSession = await syncFinanceState(
      state('user-a', [userAAccount], [operation(userAAccount)]),
      'user-b',
      remote,
      () => NOW,
    );

    expect(wrongSession.report.status).toBe('rejected');
    expect(wrongSession.state.data.accounts).toEqual([userAAccount]);
    expect(await remote.pull('user-b')).toEqual([]);

    const userBRecord = account('foreign', 'user-b', 1, 'op-user-b-foreign');
    const contaminatedState = await syncFinanceState(
      state('user-a', [userAAccount, userBRecord], []),
      'user-a',
      remote,
      () => NOW,
    );

    expect(contaminatedState.report.status).toBe('rejected');
    expect(contaminatedState.report.failures[0]?.message).toContain('user-b');
    expect(contaminatedState.state.data.accounts).toEqual([userAAccount, userBRecord]);
  });

  it('scopes idempotency keys by owner so two users may use the same operation id', async () => {
    const userAAccount = account('cash-a', 'user-a', 1, 'op-shared');
    const userBAccount = account('cash-b', 'user-b', 1, 'op-shared');
    const remote = new InMemoryRemote();

    const userAResult = await syncFinanceState(
      state('user-a', [userAAccount], [operation(userAAccount)]),
      'user-a',
      remote,
      () => NOW,
    );
    const userBResult = await syncFinanceState(
      state('user-b', [userBAccount], [operation(userBAccount)]),
      'user-b',
      remote,
      () => NOW,
    );

    expect(userAResult.report.status).toBe('synced');
    expect(userBResult.report.status).toBe('synced');
    expect(await remote.pull('user-a')).toEqual([{ entity: 'accounts', record: userAAccount }]);
    expect(await remote.pull('user-b')).toEqual([{ entity: 'accounts', record: userBAccount }]);
  });

  it('rejects foreign records returned by the remote adapter', async () => {
    const userAAccount = account('local-a', 'user-a', 1, 'op-local-a');
    const userBAccount = account('foreign-b', 'user-b', 1, 'op-foreign-b');
    const contaminatedRemote: RemoteAdapter = {
      async apply() {},
      async pull() {
        return [{ entity: 'accounts', record: userBAccount }];
      },
    };

    const result = await syncFinanceState(
      state('user-a', [userAAccount], []),
      'user-a',
      contaminatedRemote,
      () => NOW,
    );

    expect(result.state.data.accounts).toEqual([userAAccount]);
    expect(result.report.status).toBe('partial');
    expect(result.report.failures).toEqual([
      expect.objectContaining({
        stage: 'validation',
        entity: 'accounts',
        recordId: 'foreign-b',
        message: expect.stringContaining('user-b'),
      }),
    ]);
  });

  it('rejects a corrupted outbox identity before remote mutation', async () => {
    const userAAccount = account('cash', 'user-a', 2, 'op-record-version');
    const corruptedOperation: PendingOperation = {
      ...operation(userAAccount),
      id: 'op-wrong-idempotency-key',
      recordId: 'wrong-record-id',
    };
    const remote = new InMemoryRemote();

    const result = await syncFinanceState(
      state('user-a', [userAAccount], [corruptedOperation]),
      'user-a',
      remote,
      () => NOW,
    );

    expect(result.report.status).toBe('rejected');
    expect(result.report.failures.map(({ message }) => message)).toEqual([
      expect.stringContaining('recordId'),
      expect.stringContaining('lastOperationId'),
    ]);
    expect(result.state.outbox).toEqual([corruptedOperation]);
    expect(await remote.pull('user-a')).toEqual([]);
  });

  it('resolves conflicts by version and then operation id deterministically', async () => {
    const localOperationWinner = account('same-version-local', 'user-a', 2, 'op-z');
    const remoteOperationWinner = account('same-version-remote', 'user-a', 2, 'op-a');
    const localVersionWinner = account('higher-local-version', 'user-a', 3, 'op-a');
    const remote = new InMemoryRemote([
      {
        entity: 'accounts',
        record: { ...localOperationWinner, name: 'remote loser', lastOperationId: 'op-a' },
      },
      {
        entity: 'accounts',
        record: { ...remoteOperationWinner, name: 'remote winner', lastOperationId: 'op-z' },
      },
      {
        entity: 'accounts',
        record: { ...localVersionWinner, name: 'remote lower version', version: 2, lastOperationId: 'op-z' },
      },
    ]);

    const result = await syncFinanceState(
      state(
        'user-a',
        [localOperationWinner, remoteOperationWinner, localVersionWinner],
        [],
      ),
      'user-a',
      remote,
      () => NOW,
    );

    expect(result.state.data.accounts.map(({ id, name, lastOperationId, version }) => ({
      id,
      name,
      lastOperationId,
      version,
    }))).toEqual([
      { id: 'same-version-local', name: 'same-version-local', lastOperationId: 'op-z', version: 2 },
      { id: 'same-version-remote', name: 'remote winner', lastOperationId: 'op-z', version: 2 },
      { id: 'higher-local-version', name: 'higher-local-version', lastOperationId: 'op-a', version: 3 },
    ]);
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({
        recordId: 'same-version-local', winner: 'local', reason: 'operation-id',
      }),
      expect.objectContaining({
        recordId: 'same-version-remote', winner: 'remote', reason: 'operation-id',
      }),
      expect.objectContaining({
        recordId: 'higher-local-version', winner: 'local', reason: 'version',
      }),
    ]);
  });

  it('converges concurrent releases of one source allocation to one tombstone', async () => {
    const goal: SavingsGoal = {
      id: 'goal-a',
      ownerId: 'user-a',
      version: 1,
      updatedAt: '2026-08-21T09:00:00.000Z',
      lastOperationId: 'op-goal',
      name: '緊急預備金',
      targetAmount: 10_000,
      isActive: true,
    };
    const source: SavingsAllocation = {
      id: 'allocation-source',
      ownerId: 'user-a',
      version: 1,
      updatedAt: '2026-08-21T09:00:00.000Z',
      lastOperationId: 'op-create-allocation',
      goalId: 'goal-a',
      amountDelta: 800,
      occurredAt: '2026-08-21 09:00',
    };
    const releasedA: SavingsAllocation = {
      ...source,
      version: 2,
      updatedAt: '2026-08-21T10:00:00.000Z',
      lastOperationId: 'op-release-a',
      deletedAt: '2026-08-21T10:00:00.000Z',
    };
    const releasedB: SavingsAllocation = {
      ...source,
      version: 2,
      updatedAt: '2026-08-21T10:01:00.000Z',
      lastOperationId: 'op-release-z',
      deletedAt: '2026-08-21T10:01:00.000Z',
    };
    const releaseState = (record: SavingsAllocation): PersistedFinanceState => ({
      schemaVersion: 3,
      ownerId: 'user-a',
      data: { ...emptyData(), goals: [goal], allocations: [record] },
      outbox: [allocationOperation(record)],
    });
    const remote = new InMemoryRemote([
      { entity: 'goals', record: goal },
      { entity: 'allocations', record: source },
    ]);

    const afterA = await syncFinanceState(releaseState(releasedA), 'user-a', remote, () => NOW);
    const afterB = await syncFinanceState(releaseState(releasedB), 'user-a', remote, () => NOW);
    const convergedA = await syncFinanceState(afterA.state, 'user-a', remote, () => NOW);
    const remoteAllocations = (await remote.pull('user-a'))
      .filter((entry) => entry.entity === 'allocations');

    expect(remoteAllocations).toEqual([{ entity: 'allocations', record: releasedB }]);
    expect(afterB.state.data.allocations).toEqual([releasedB]);
    expect(convergedA.state.data.allocations).toEqual([releasedB]);
    expect(convergedA.state.data.allocations.filter((record) => !record.deletedAt)).toEqual([]);
  });

  it('keeps a queued stale edit visible and pending when the remote clock is newer', async () => {
    const remoteNewer = {
      ...account('wallet', 'user-a', 3, 'op-remote-newer'),
      name: 'remote current value',
    };
    const localStale = {
      ...remoteNewer,
      name: 'local stale value',
      version: 2,
      lastOperationId: 'op-local-stale',
    };
    const remote = new InMemoryRemote([{ entity: 'accounts', record: remoteNewer }]);

    const result = await syncFinanceState(
      state('user-a', [localStale], [operation(localStale)]),
      'user-a',
      remote,
      () => NOW,
    );

    expect(result.state.data.accounts).toEqual([localStale]);
    expect(result.state.outbox).toEqual([
      expect.objectContaining({
        id: 'op-local-stale',
        attempts: 1,
        lastError: expect.stringContaining('pending local mutation'),
      }),
    ]);
    expect(result.state.lastSyncError).toMatch(/pending local mutation/i);
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({ recordId: 'wallet', winner: 'unresolved', reason: 'pending-local' }),
    ]);
    expect(await remote.pull('user-a')).toEqual([{ entity: 'accounts', record: remoteNewer }]);
  });

  it('does not silently resurrect a locally deleted record when the remote clock is newer', async () => {
    const remoteNewer = {
      ...account('wallet', 'user-a', 3, 'op-remote-newer'),
      name: 'remote current value',
    };
    const localStale = {
      ...remoteNewer,
      version: 2,
      lastOperationId: 'op-local-stale',
      deletedAt: NOW,
    };
    const rejectingRemote: RemoteAdapter = {
      apply: async () => { throw new Error('persisted conflict clock does not match operation'); },
      pull: async () => [{ entity: 'accounts', record: remoteNewer }],
    };

    const result = await syncFinanceState(
      state('user-a', [localStale], [operation(localStale)]),
      'user-a',
      rejectingRemote,
      () => NOW,
    );

    expect(result.state.data.accounts).toEqual([localStale]);
    expect(result.state.outbox).toEqual([
      expect.objectContaining({ id: 'op-local-stale', attempts: 1 }),
    ]);
    expect(result.state.lastSyncError).toMatch(/pending local mutation/i);
    expect(result.report).toMatchObject({ status: 'partial' });
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({ recordId: 'wallet', winner: 'unresolved', reason: 'pending-local' }),
    ]);
  });

  it('keeps a same-clock divergent payload pending as a visible unresolved conflict', async () => {
    const local = {
      ...account('wallet', 'user-a', 3, 'op-same-clock'),
      name: 'local value',
    };
    const remoteDivergent = { ...local, name: 'remote value' };
    const rejectingRemote: RemoteAdapter = {
      apply: async () => { throw new Error('Supabase persisted payload differs at columns: name'); },
      pull: async () => [{ entity: 'accounts', record: remoteDivergent }],
    };

    const result = await syncFinanceState(
      state('user-a', [local], [operation(local)]),
      'user-a',
      rejectingRemote,
      () => NOW,
    );

    expect(result.state.data.accounts).toEqual([local]);
    expect(result.state.outbox).toHaveLength(1);
    expect(result.state.outbox[0]).toMatchObject({
      id: 'op-same-clock',
      attempts: 1,
    });
    expect(result.report.status).toBe('partial');
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({
        recordId: 'wallet',
        winner: 'unresolved',
        reason: 'payload',
      }),
    ]);
    expect(result.report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'apply', recordId: 'wallet' }),
      expect.objectContaining({ stage: 'conflict', recordId: 'wallet' }),
    ]));
  });

  it('requeues an operation when apply claims success but pull returns a divergent same clock', async () => {
    const local = {
      ...account('wallet', 'user-a', 3, 'op-same-clock'),
      name: 'local value',
    };
    const lyingRemote: RemoteAdapter = {
      apply: async () => {},
      pull: async () => [{
        entity: 'accounts',
        record: { ...local, name: 'remote divergent value' },
      }],
    };

    const result = await syncFinanceState(
      state('user-a', [local], [operation(local)]),
      'user-a',
      lyingRemote,
      () => NOW,
    );

    expect(result.report).toMatchObject({ status: 'partial', applied: 0 });
    expect(result.state.data.accounts).toEqual([local]);
    expect(result.state.outbox).toEqual([
      expect.objectContaining({
        id: 'op-same-clock',
        attempts: 1,
        lastError: expect.stringContaining('same-clock payload conflict'),
      }),
    ]);
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({ winner: 'unresolved', reason: 'payload' }),
    ]);
  });

  it('keeps valid pulled records when the adapter isolates a malformed row and exposes its diagnostic', async () => {
    const valid = account('cloud-cash', 'user-a', 1, 'op-cloud-cash');
    const remote: RemoteAdapter = {
      async apply() {},
      async pull() {
        return {
          records: [{ entity: 'accounts', record: valid }],
          issues: [{
            stage: 'pull',
            entity: 'transactions',
            recordId: 'legacy-incomplete',
            message: 'Skipped malformed transactions/legacy-incomplete: missing category_id',
          }],
        };
      },
    };

    const result = await syncFinanceState(
      state('user-a', [], []),
      'user-a',
      remote,
      () => NOW,
    );

    expect(result.state.data.accounts).toEqual([valid]);
    expect(result.state.lastSyncedAt).toBe(NOW);
    expect(result.report).toMatchObject({ status: 'partial', pulled: 1 });
    expect(result.report.failures).toEqual([
      expect.objectContaining({
        stage: 'pull',
        entity: 'transactions',
        recordId: 'legacy-incomplete',
      }),
    ]);
    expect(result.state.lastSyncError).toContain('missing category_id');
  });

  it('does not persist a mixed local and remote graph that violates category kind references', async () => {
    const cash = account('cash', 'user-a', 1, 'op-cash');
    const localCategory: Category = {
      id: 'food',
      ownerId: 'user-a',
      version: 1,
      updatedAt: '2026-08-21T09:00:00.000Z',
      lastOperationId: 'op-food-expense',
      kind: 'expense',
      name: '餐飲',
      icon: { type: 'emoji', value: '🍜' },
      isActive: true,
      sortOrder: 0,
    };
    const localTransaction: Transaction = {
      id: 'lunch',
      ownerId: 'user-a',
      version: 1,
      updatedAt: '2026-08-21T09:30:00.000Z',
      lastOperationId: 'op-lunch',
      type: 'expense',
      amount: 120,
      accountId: cash.id,
      accountName: cash.name,
      categoryId: localCategory.id,
      categoryName: localCategory.name,
      occurredAt: '2026-08-21 09:30',
    };
    const original: PersistedFinanceState = {
      schemaVersion: 3,
      ownerId: 'user-a',
      data: {
        ...emptyData(),
        accounts: [cash],
        categories: [localCategory],
        transactions: [localTransaction],
      },
      outbox: [{
        id: localTransaction.lastOperationId,
        entity: 'transactions',
        recordId: localTransaction.id,
        record: localTransaction,
        attempts: 0,
        queuedAt: NOW,
      }],
    };
    const remoteCategory: Category = {
      ...localCategory,
      version: 2,
      updatedAt: '2026-08-21T10:00:00.000Z',
      lastOperationId: 'op-food-income',
      kind: 'income',
    };
    const remote: RemoteAdapter = {
      apply: async () => {},
      pull: async () => ({
        records: [{ entity: 'categories', record: remoteCategory }],
        issues: [{
          stage: 'validation',
          entity: 'transactions',
          recordId: localTransaction.id,
          message: 'Skipped inconsistent transactions/lunch: references a category with the wrong kind',
        }],
      }),
    };

    const result = await syncFinanceState(original, 'user-a', remote, () => NOW);

    expect(result.state.data).toEqual(original.data);
    expect(result.state.outbox).toEqual(original.outbox);
    expect(result.state.lastSyncedAt).toBeUndefined();
    expect(result.report).toMatchObject({ status: 'partial', applied: 0 });
    expect(result.report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'validation', message: expect.stringContaining('final reconciled graph') }),
    ]));
  });
});
