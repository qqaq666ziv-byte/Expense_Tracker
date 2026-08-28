import { describe, expect, it, vi } from 'vitest';
import type {
  AssetAccount,
  Budget,
  Category,
  FinanceData,
  PendingOperation,
  PersistedFinanceState,
  SavingsAllocation,
  SavingsGoal,
  Transaction,
  Transfer,
} from './model';
import type { RemoteAdapter, RemoteRecord } from './syncEngine';
import {
  acceptRemoteConflictRecord,
  confirmTransferDependencyConflict,
  compareSyncRecords,
  enqueueSyncRecord,
  syncFinanceState,
  UNRESOLVED_PAYLOAD_CONFLICT_PREFIX,
} from './syncEngine';

const NOW = '2026-08-21T10:00:00.000Z';

function emptyData(): FinanceData {
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

function budgetOperation(record: Budget): PendingOperation {
  return {
    id: record.lastOperationId,
    entity: 'budgets',
    recordId: record.id,
    record,
    attempts: 0,
    queuedAt: NOW,
  };
}

function transfer(
  id: string,
  ownerId: string,
  version: number,
  lastOperationId: string,
  deletedAt?: string,
): Transfer {
  return {
    id,
    ownerId,
    amount: 250,
    sourceAccountId: 'bank',
    sourceAccountName: '銀行',
    destinationAccountId: 'cash',
    destinationAccountName: '現金',
    occurredAt: '2026-08-28 10:00',
    version,
    updatedAt: NOW,
    lastOperationId,
    deletedAt,
  };
}

function transferOperation(record: Transfer): PendingOperation {
  return {
    id: record.lastOperationId,
    entity: 'transfers',
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
    schemaVersion: 4,
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
  failAfterCompareAndSwapOnce = false;

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

  async compareAndSwap(
    ownerId: string,
    expected: RemoteRecord,
    replacement: PendingOperation,
  ): Promise<RemoteRecord | undefined> {
    if (expected.record.ownerId !== ownerId || replacement.record.ownerId !== ownerId) {
      throw new Error('owner mismatch');
    }
    const key = this.key(expected);
    const current = this.records.get(key);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return undefined;
    const persisted = {
      entity: replacement.entity,
      record: replacement.record,
    } as RemoteRecord;
    this.records.set(key, persisted);
    if (this.failAfterCompareAndSwapOnce) {
      this.failAfterCompareAndSwapOnce = false;
      throw new Error('connection dropped after conditional compensation');
    }
    return persisted;
  }

  private key({ entity, record }: RemoteRecord): string {
    return `${entity}:${record.id}`;
  }
}

describe('offline sync engine', () => {
  it('holds a first transfer write when an endpoint changed remotely until the user explicitly reconfirms it', async () => {
    const localBank = { ...account('bank', 'user-a', 1, 'bank-create'), name: '銀行' };
    const remoteBank = {
      ...localBank,
      name: '主要銀行',
      includeInTotalAssets: false,
      version: 2,
      updatedAt: '2026-08-28T02:00:00.000Z',
      lastOperationId: 'bank-remote-edit',
    };
    const cash = { ...account('cash', 'user-a', 1, 'cash-create'), name: '現金' };
    const pendingTransfer = transfer('pending-transfer', 'user-a', 1, 'transfer-create');
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: remoteBank },
      { entity: 'accounts', record: cash },
    ]);
    const initial: PersistedFinanceState = {
      ...state('user-a', [localBank, cash], []),
      data: { ...emptyData(), accounts: [localBank, cash], transfers: [pendingTransfer] },
      outbox: [transferOperation(pendingTransfer)],
    };

    const blocked = await syncFinanceState(initial, 'user-a', remote);
    expect((await remote.pull('user-a')).filter((item) => item.entity === 'transfers')).toEqual([]);
    expect(blocked.state.data.accounts.find((item) => item.id === 'bank')).toEqual(remoteBank);
    expect(blocked.state.outbox[0].lastError).toMatch(/^transfer selected account changed before cloud write/);
    expect(blocked.state.unresolvedSyncRecordKeys).toContain('transfers:pending-transfer');

    const reloaded = JSON.parse(JSON.stringify(blocked.state)) as PersistedFinanceState;
    const retried = await syncFinanceState(reloaded, 'user-a', remote);
    expect((await remote.pull('user-a')).filter((item) => item.entity === 'transfers')).toEqual([]);
    expect(retried.state.outbox[0].lastError).toMatch(/^transfer selected account changed before cloud write/);
    expect(retried.state.unresolvedSyncRecordKeys).toContain('transfers:pending-transfer');

    const refreshed = {
      ...pendingTransfer,
      sourceAccountName: remoteBank.name,
      version: 2,
      updatedAt: '2026-08-28T02:01:00.000Z',
      lastOperationId: 'transfer-reconfirmed',
    };
    expect(() => confirmTransferDependencyConflict({
      ...retried.state,
      unresolvedSyncRecordKeys: [
        ...(retried.state.unresolvedSyncRecordKeys ?? []),
        'accounts:bank',
      ],
    }, refreshed)).toThrow(/帳戶仍有未解同步衝突/);
    expect(() => confirmTransferDependencyConflict(retried.state, {
      ...refreshed,
      note: '字'.repeat(4_097),
    })).toThrow(/transfers.note exceeds 4096 UTF-8 bytes/);
    const confirmed = confirmTransferDependencyConflict(retried.state, refreshed);
    expect(confirmed.unresolvedSyncRecordKeys).toBeUndefined();
    expect(confirmed.outbox).toEqual([expect.objectContaining({
      id: 'transfer-reconfirmed',
      record: refreshed,
      attempts: 0,
      lastError: undefined,
    })]);

    const converged = await syncFinanceState(confirmed, 'user-a', remote);
    expect(converged.state.outbox).toEqual([]);
    expect((await remote.pull('user-a')).filter((item) => item.entity === 'transfers'))
      .toEqual([{ entity: 'transfers', record: refreshed }]);
  });

  it('holds an offline retarget when the newly selected endpoint changed remotely', async () => {
    const bank = { ...account('bank', 'user-a', 1, 'bank-create'), name: '銀行' };
    const cash = { ...account('cash', 'user-a', 1, 'cash-create'), name: '現金' };
    const localBroker = { ...account('broker', 'user-a', 1, 'broker-create'), name: '券商舊名' };
    const remoteBroker = {
      ...localBroker,
      name: '投資帳戶',
      version: 2,
      updatedAt: '2026-08-28T03:00:00.000Z',
      lastOperationId: 'broker-remote-rename',
    };
    const cloudTransfer = transfer('retarget-transfer', 'user-a', 1, 'transfer-cloud-create');
    const localRetarget = {
      ...cloudTransfer,
      destinationAccountId: localBroker.id,
      destinationAccountName: localBroker.name,
      version: 2,
      updatedAt: '2026-08-28T02:59:00.000Z',
      lastOperationId: 'transfer-local-retarget',
    };
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: bank },
      { entity: 'accounts', record: cash },
      { entity: 'accounts', record: remoteBroker },
      { entity: 'transfers', record: cloudTransfer },
    ]);
    const initial: PersistedFinanceState = {
      ...state('user-a', [bank, cash, localBroker], []),
      data: { ...emptyData(), accounts: [bank, cash, localBroker], transfers: [localRetarget] },
      outbox: [transferOperation(localRetarget)],
    };

    const blocked = await syncFinanceState(initial, 'user-a', remote);
    expect((await remote.pull('user-a')).find((item) => item.entity === 'transfers'))
      .toEqual({ entity: 'transfers', record: cloudTransfer });
    expect(blocked.state.outbox[0].lastError).toMatch(/^transfer selected account changed before cloud write/);
    expect(blocked.state.unresolvedSyncRecordKeys).toContain('transfers:retarget-transfer');

    const confirmed = confirmTransferDependencyConflict(blocked.state, {
      ...localRetarget,
      destinationAccountName: remoteBroker.name,
      version: 3,
      updatedAt: '2026-08-28T03:01:00.000Z',
      lastOperationId: 'transfer-retarget-reconfirmed',
    });
    const converged = await syncFinanceState(confirmed, 'user-a', remote);
    expect(converged.state.outbox).toEqual([]);
    expect((await remote.pull('user-a')).find((item) => item.entity === 'transfers'))
      .toEqual({ entity: 'transfers', record: confirmed.data.transfers[0] });
  });

  it('retries one atomic transfer row and converges create, edit, and tombstone without duplicates', async () => {
    const bank = account('bank', 'user-a', 1, 'bank-create');
    const cash = account('cash', 'user-a', 1, 'cash-create');
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: bank },
      { entity: 'accounts', record: cash },
    ]);
    const created = transfer('move-250', 'user-a', 1, 'transfer-create');
    remote.failAfterApplyOnce.add(created.lastOperationId);
    const createdState: PersistedFinanceState = {
      ...state('user-a', [bank, cash], []),
      data: { ...emptyData(), accounts: [bank, cash], transfers: [created] },
      outbox: [transferOperation(created)],
    };

    const uncertain = await syncFinanceState(createdState, 'user-a', remote);
    expect(uncertain.state.outbox).toHaveLength(1);
    const createdRetry = await syncFinanceState(uncertain.state, 'user-a', remote);
    expect(createdRetry.state.outbox).toEqual([]);
    expect((await remote.pull('user-a')).filter((item) => item.entity === 'transfers'))
      .toEqual([{ entity: 'transfers', record: created }]);

    const edited = { ...created, amount: 300, version: 2, lastOperationId: 'transfer-edit' };
    const editedState = enqueueSyncRecord(createdRetry.state, 'transfers', edited);
    const editedResult = await syncFinanceState(editedState, 'user-a', remote);
    expect(editedResult.state.data.transfers).toEqual([edited]);

    const tombstone = {
      ...edited,
      version: 3,
      lastOperationId: 'tombstone:transfer-delete',
      deletedAt: NOW,
    };
    const deletedResult = await syncFinanceState(
      enqueueSyncRecord(editedResult.state, 'transfers', tombstone),
      'user-a',
      remote,
    );
    expect(deletedResult.state.outbox).toEqual([]);
    expect(deletedResult.state.data.transfers).toEqual([tombstone]);
    expect((await remote.pull('user-a')).filter((item) => item.entity === 'transfers'))
      .toEqual([{ entity: 'transfers', record: tombstone }]);
  });

  it('keeps a divergent same-clock transfer locked until the cloud record is explicitly accepted', async () => {
    const local = { ...transfer('conflicted-transfer', 'user-a', 2, 'same-clock'), note: '本機' };
    const cloud = { ...local, note: '雲端' };
    const bank = account('bank', 'user-a', 1, 'bank-create');
    const cash = account('cash', 'user-a', 1, 'cash-create');
    const remote = new InMemoryRemote([{ entity: 'transfers', record: cloud }]);
    const initial: PersistedFinanceState = {
      ...state('user-a', [bank, cash], []),
      data: { ...emptyData(), accounts: [bank, cash], transfers: [local] },
      outbox: [transferOperation(local)],
    };

    const conflicted = await syncFinanceState(initial, 'user-a', remote);
    expect(conflicted.state.unresolvedSyncRecordKeys).toContain('transfers:conflicted-transfer');
    expect(conflicted.state.outbox).toHaveLength(1);

    const accepted = acceptRemoteConflictRecord(conflicted.state, {
      entity: 'transfers',
      record: cloud,
    });
    expect(accepted.outbox).toEqual([]);
    expect(accepted.unresolvedSyncRecordKeys).toBeUndefined();
    expect(accepted.data.transfers).toEqual([cloud]);
  });
  it('preserves the original batch manifest across a later offline edit', () => {
    const before = account('offline-batch-edit', 'user-a', 1, 'create');
    const first = { ...before, version: 2, lastOperationId: 'first-batch-edit', name: '第一次' };
    const later = { ...first, version: 3, lastOperationId: 'later-offline-edit', name: '第二次' };
    const batched = enqueueSyncRecord(
      state('user-a', [before], []),
      'accounts',
      first,
      NOW,
      'original-batch',
    );

    const updated = enqueueSyncRecord(batched, 'accounts', later, NOW);

    expect(updated.outbox).toEqual([expect.objectContaining({
      id: later.lastOperationId,
      batchId: 'original-batch',
      batchBeforeRecord: before,
      record: later,
    })]);
  });

  it('rejects incomplete batch recovery metadata before any remote write', async () => {
    const local = account('missing-before', 'user-a', 2, 'batched-edit');
    const apply = vi.fn(async () => undefined);
    const result = await syncFinanceState({
      ...state('user-a', [local], [{ ...operation(local), batchId: 'broken-batch' }]),
    }, 'user-a', { apply, pull: async () => [] }, () => NOW);

    expect(apply).not.toHaveBeenCalled();
    expect(result.report.status).toBe('rejected');
    expect(result.report.failures).toEqual([
      expect.objectContaining({ message: expect.stringContaining('incomplete batch recovery metadata') }),
    ]);
  });

  it('keeps an equal-version tombstone ahead of an active edit in either comparison direction', () => {
    const active = account('wallet', 'user-a', 2, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    const tombstone = { ...active, lastOperationId: 'tombstone:aaaa-delete', deletedAt: NOW };

    expect(compareSyncRecords(tombstone, active)).toBeGreaterThan(0);
    expect(compareSyncRecords(active, tombstone)).toBeLessThan(0);
  });

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
      schemaVersion: 4,
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
      schemaVersion: 4,
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
      schemaVersion: 4,
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
      schemaVersion: 4,
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
      schemaVersion: 4,
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
      schemaVersion: 4,
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
    expect(result.state.unresolvedSyncRecordKeys).toEqual(['accounts:wallet']);
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({ recordId: 'wallet', winner: 'unresolved', reason: 'pending-local' }),
    ]);
    expect(await remote.pull('user-a')).toEqual([{ entity: 'accounts', record: remoteNewer }]);

    const accepted = acceptRemoteConflictRecord(result.state, {
      entity: 'accounts',
      record: remoteNewer,
    });
    expect(accepted.data.accounts).toEqual([remoteNewer]);
    expect(accepted.outbox).toEqual([]);
    expect(accepted.unresolvedSyncRecordKeys).toBeUndefined();
  });

  it('removes a resolved conflict error while preserving an unrelated pending write', async () => {
    const remoteAccount = { ...account('conflict-account', 'user-a', 3, 'remote-winner'), name: '雲端' };
    const localAccount = { ...remoteAccount, version: 2, lastOperationId: 'local-stale', name: '本機' };
    const unrelated = account('unrelated-pending', 'user-a', 1, 'unrelated-create');
    const conflicted: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [localAccount, unrelated] },
      outbox: [{
        ...operation(localAccount),
        lastError: `${UNRESOLVED_PAYLOAD_CONFLICT_PREFIX} for accounts/conflict-account`,
      }, operation(unrelated)],
      unresolvedSyncRecordKeys: ['accounts:conflict-account'],
      lastSyncError: 'old resolved conflict detail',
    };

    const accepted = acceptRemoteConflictRecord(conflicted, {
      entity: 'accounts', record: remoteAccount,
    });

    expect(accepted.data.accounts).toEqual([remoteAccount, unrelated]);
    expect(accepted.outbox).toEqual([operation(unrelated)]);
    expect(accepted.lastSyncError).toBeUndefined();
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

  it('accepts a winning remote tombstone over a pending stale active edit', async () => {
    const localActive = account('wallet', 'user-a', 3, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    const remoteDeleted = {
      ...localActive,
      updatedAt: NOW,
      lastOperationId: '00000000-0000-4000-8000-000000000000',
      deletedAt: NOW,
      isActive: false,
    };
    const rejectingRemote: RemoteAdapter = {
      apply: async () => { throw new Error('remote tombstone already won'); },
      pull: async () => [{ entity: 'accounts', record: remoteDeleted }],
    };

    const result = await syncFinanceState(
      state('user-a', [localActive], [operation(localActive)]),
      'user-a',
      rejectingRemote,
      () => NOW,
    );

    expect(result.state.data.accounts).toEqual([remoteDeleted]);
    expect(result.state.outbox).toEqual([]);
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({ recordId: 'wallet', winner: 'remote' }),
    ]);
  });

  it('keeps a legacy UUID tombstone ahead when it arrives between preflight and apply', async () => {
    const localActive = account(
      'wallet-race',
      'user-a',
      2,
      '00000000-0000-0000-0000-000000000000:active:ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    const remoteDeleted = {
      ...localActive,
      isActive: false,
      lastOperationId: '00000000-0000-4000-8000-000000000000',
      deletedAt: NOW,
    };
    let pullCount = 0;
    let remoteRecord: AssetAccount | undefined;
    const racingRemote: RemoteAdapter = {
      async pull() {
        pullCount += 1;
        return remoteRecord ? [{ entity: 'accounts', record: remoteRecord }] : [];
      },
      async apply(_ownerId, pending) {
        remoteRecord = remoteDeleted;
        if (compareSyncRecords(pending.record, remoteRecord) > 0) {
          remoteRecord = pending.record as AssetAccount;
        }
      },
    };

    const result = await syncFinanceState(
      state('user-a', [localActive], [operation(localActive)]),
      'user-a',
      racingRemote,
      () => NOW,
    );

    expect(pullCount).toBe(2);
    expect(remoteRecord).toEqual(remoteDeleted);
    expect(result.state.data.accounts).toEqual([remoteDeleted]);
    expect(result.state.outbox).toEqual([]);
  });

  it('fails closed before applying a budget that conflicts with a remote legacy id', async () => {
    const remoteBudget: Budget = {
      id: 'legacy-random-budget-id', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'legacy-budget-create',
      scope: 'overall', period: 'monthly', amount: 5_000, isActive: true,
    };
    const localBudget: Budget = {
      ...remoteBudget,
      id: 'deterministic-budget-id',
      lastOperationId: 'local-budget-create',
      amount: 6_000,
    };
    const applied: PendingOperation[] = [];
    const remoteBudgets = [remoteBudget];
    const remote: RemoteAdapter = {
      async pull() {
        return remoteBudgets.map((record) => ({ entity: 'budgets' as const, record }));
      },
      async apply(_ownerId, pending) {
        applied.push(pending);
        remoteBudgets.push(pending.record as Budget);
      },
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localBudget] },
      outbox: [budgetOperation(localBudget)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(applied).toEqual([]);
    expect(result.report.status).toBe('partial');
    expect(result.state.outbox).toEqual([
      expect.objectContaining({
        recordId: localBudget.id,
        attempts: 1,
        lastError: expect.stringContaining('雲端有效預算'),
        record: expect.objectContaining({ isActive: false }),
      }),
    ]);
    expect(result.state.data.budgets.filter((budget) => budget.isActive)).toEqual([remoteBudget]);
    expect(result.state.data.budgets.find((budget) => budget.id === localBudget.id)).toMatchObject({
      amount: localBudget.amount,
      isActive: false,
    });
    expect(result.report.failures).toEqual([
      expect.objectContaining({ stage: 'apply', recordId: localBudget.id }),
    ]);

    const retried = await syncFinanceState(result.state, 'user-a', remote, () => NOW);
    expect(applied).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ isActive: false }) }),
    ]);
    expect(retried.state.outbox).toEqual([]);
    expect(retried.state.data.budgets.filter((budget) => budget.isActive)).toEqual([remoteBudget]);
  });

  it('rolls back only its own budget when a legacy semantic conflict arrives after preflight', async () => {
    const localBudget: Budget = {
      id: 'deterministic-budget-race', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'local-budget-race-create',
      scope: 'overall', period: 'monthly', amount: 6_000, isActive: true,
    };
    const legacyBudget: Budget = {
      ...localBudget,
      id: 'legacy-budget-race',
      lastOperationId: 'legacy-budget-race-create',
      amount: 5_000,
    };
    const remoteBudgets: Budget[] = [];
    const applied: PendingOperation[] = [];
    const remote: RemoteAdapter = {
      async pull() {
        return remoteBudgets.map((record) => ({ entity: 'budgets' as const, record }));
      },
      async apply(_ownerId, pending) {
        applied.push(pending);
        const budget = pending.record as Budget;
        if (budget.id === localBudget.id && budget.isActive) {
          remoteBudgets.push(legacyBudget, budget);
          return;
        }
        const index = remoteBudgets.findIndex((record) => record.id === budget.id);
        if (index >= 0) remoteBudgets[index] = budget;
        else remoteBudgets.push(budget);
      },
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localBudget] },
      outbox: [budgetOperation(localBudget)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ record: expect.objectContaining({ isActive: true }) });
    expect(applied[1]).toMatchObject({ record: expect.objectContaining({ isActive: false }) });
    expect(result.report.status).toBe('partial');
    expect(result.report.failures).toEqual([
      expect.objectContaining({ stage: 'conflict', recordId: localBudget.id }),
    ]);
    expect(result.state.outbox).toEqual([]);
    expect(result.state.data.budgets.filter((budget) => budget.isActive)).toEqual([legacyBudget]);
    expect(remoteBudgets.filter((budget) => budget.isActive)).toEqual([legacyBudget]);
  });

  it('retains an applied budget until a failed confirmation pull can be retried safely', async () => {
    const localBudget: Budget = {
      id: 'deterministic-budget-confirm', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'local-budget-confirm-create',
      scope: 'overall', period: 'weekly', amount: 1_500, isActive: true,
    };
    const legacyBudget: Budget = {
      ...localBudget,
      id: 'legacy-budget-confirm',
      lastOperationId: 'legacy-budget-confirm-create',
      amount: 1_200,
    };
    const remoteBudgets: Budget[] = [];
    let pullCount = 0;
    let failConfirmation = true;
    const remote: RemoteAdapter = {
      async pull() {
        pullCount += 1;
        if (failConfirmation && pullCount === 2) throw new Error('confirmation offline');
        return remoteBudgets.map((record) => ({ entity: 'budgets' as const, record }));
      },
      async apply(_ownerId, pending) {
        const budget = pending.record as Budget;
        const index = remoteBudgets.findIndex((record) => record.id === budget.id);
        if (index >= 0) remoteBudgets[index] = budget;
        else remoteBudgets.push(budget);
      },
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localBudget] },
      outbox: [budgetOperation(localBudget)],
    };

    const unconfirmed = await syncFinanceState(localState, 'user-a', remote, () => NOW);
    expect(unconfirmed.report.status).toBe('partial');
    expect(unconfirmed.state.outbox).toEqual([
      expect.objectContaining({
        id: localBudget.lastOperationId,
        lastError: expect.stringContaining('尚未完成雲端語義衝突確認'),
      }),
    ]);

    failConfirmation = false;
    remoteBudgets.push(legacyBudget);
    const deactivated = await syncFinanceState(unconfirmed.state, 'user-a', remote, () => NOW);
    expect(deactivated.report.status).toBe('partial');
    expect(deactivated.state.data.budgets.filter((budget) => budget.isActive)).toEqual([legacyBudget]);
    expect(deactivated.state.outbox).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ isActive: false }) }),
    ]);

    const converged = await syncFinanceState(deactivated.state, 'user-a', remote, () => NOW);
    expect(converged.state.outbox).toEqual([]);
    expect(converged.state.data.budgets.filter((budget) => budget.isActive)).toEqual([legacyBudget]);
    expect(remoteBudgets.filter((budget) => budget.isActive)).toEqual([legacyBudget]);
  });

  it('rebases a failed inactive rollback onto the latest remote budget clock', async () => {
    const localBudget: Budget = {
      id: 'deterministic-budget-rebase', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'local-budget-rebase-create',
      scope: 'overall', period: 'monthly', amount: 6_000, isActive: true,
    };
    const legacyBudget: Budget = {
      ...localBudget,
      id: 'legacy-budget-rebase',
      lastOperationId: 'legacy-budget-rebase-create',
      amount: 5_000,
    };
    const remoteBudgets: Budget[] = [];
    let rejectFirstRollback = true;
    const remote: RemoteAdapter = {
      async pull() {
        return remoteBudgets.map((record) => ({ entity: 'budgets' as const, record }));
      },
      async apply(_ownerId, pending) {
        const budget = pending.record as Budget;
        const index = remoteBudgets.findIndex((record) => record.id === budget.id);
        if (budget.id === localBudget.id && budget.isActive && index < 0) {
          remoteBudgets.push(legacyBudget, budget);
          return;
        }
        if (budget.id === localBudget.id && !budget.isActive && rejectFirstRollback) {
          rejectFirstRollback = false;
          remoteBudgets[index] = {
            ...remoteBudgets[index],
            version: budget.version,
            lastOperationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            isActive: true,
          };
          throw new Error('Supabase retained a different conflict clock');
        }
        if (index >= 0) remoteBudgets[index] = budget;
        else remoteBudgets.push(budget);
      },
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localBudget] },
      outbox: [budgetOperation(localBudget)],
    };

    const blocked = await syncFinanceState(localState, 'user-a', remote, () => NOW);
    const staleRollback = blocked.state.outbox[0];
    expect(staleRollback).toMatchObject({
      attempts: 1,
      record: expect.objectContaining({ version: 2, isActive: false }),
    });

    const converged = await syncFinanceState(blocked.state, 'user-a', remote, () => NOW);
    expect(converged.state.outbox).toEqual([]);
    expect(converged.state.data.budgets.filter((budget) => budget.isActive)).toEqual([legacyBudget]);
    expect(remoteBudgets.find((budget) => budget.id === localBudget.id)).toMatchObject({
      version: 3,
      isActive: false,
    });
    expect(remoteBudgets.filter((budget) => budget.isActive)).toEqual([legacyBudget]);
  });

  it('accepts a newer remote reactivation when the semantic budget conflict was already resolved', async () => {
    const staleRollback: Budget = {
      id: 'resolved-budget-conflict', ownerId: 'user-a', version: 2,
      updatedAt: NOW,
      lastOperationId: '00000000-0000-0000-0000-000000000000:active:budget-conflict-rollback:stale',
      scope: 'overall', period: 'monthly', amount: 6_000, isActive: false,
    };
    const remoteReactivation: Budget = {
      ...staleRollback,
      version: 4,
      lastOperationId: 'remote-user-reactivation',
      isActive: true,
    };
    const remote = new InMemoryRemote([{ entity: 'budgets', record: remoteReactivation }]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [staleRollback] },
      outbox: [budgetOperation(staleRollback)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.state.outbox).toEqual([]);
    expect(result.state.data.budgets).toEqual([remoteReactivation]);
    expect((await remote.pull('user-a'))[0]).toEqual({
      entity: 'budgets',
      record: remoteReactivation,
    });
  });

  it('evaluates a stale rollback against the latest remote budget semantics', async () => {
    const category: Category = {
      id: 'category-food', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'category-food-create',
      name: '餐飲', kind: 'expense', icon: { type: 'emoji', value: '🍚' },
      isActive: true, sortOrder: 0,
    };
    const staleRollback: Budget = {
      id: 'budget-semantic-change', ownerId: 'user-a', version: 2,
      updatedAt: NOW,
      lastOperationId: '00000000-0000-0000-0000-000000000000:active:budget-conflict-rollback:stale-semantics',
      scope: 'overall', period: 'monthly', amount: 6_000, isActive: false,
    };
    const remoteReactivation: Budget = {
      ...staleRollback,
      version: 4,
      lastOperationId: 'remote-category-weekly-reactivation',
      scope: 'category',
      period: 'weekly',
      categoryId: 'category-food',
      categoryName: '餐飲',
      isActive: true,
    };
    const oldSemanticBudget: Budget = {
      ...staleRollback,
      id: 'still-active-overall-monthly',
      version: 3,
      lastOperationId: 'other-active-budget',
      isActive: true,
    };
    const remote = new InMemoryRemote([
      { entity: 'categories', record: category },
      { entity: 'budgets', record: remoteReactivation },
      { entity: 'budgets', record: oldSemanticBudget },
    ]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: {
        ...emptyData(),
        categories: [category],
        budgets: [staleRollback, oldSemanticBudget],
      },
      outbox: [budgetOperation(staleRollback)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.state.outbox).toEqual([]);
    expect(result.state.data.budgets.find((budget) => budget.id === staleRollback.id))
      .toEqual(remoteReactivation);
  });

  it('accepts every still-pending record from the same local mutation batch atomically', () => {
    const category: Category = {
      id: 'category-food', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'category-create',
      name: '餐飲', kind: 'expense', icon: { type: 'emoji', value: '🍚' },
      isActive: true, sortOrder: 0,
    };
    const remoteAccount = account('wallet-batch', 'user-a', 4, 'remote-account-active');
    const localAccount = {
      ...remoteAccount,
      version: 3,
      lastOperationId: 'local-account-archive',
      isActive: false,
    };
    const remoteRule = {
      id: 'rule-batch', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'remote-rule-active',
      name: '月租', type: 'expense' as const, amount: 10_000,
      categoryId: category.id, categoryName: category.name,
      accountId: remoteAccount.id, accountName: remoteAccount.name,
      frequency: 'monthly' as const, startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    };
    const localRule = {
      ...remoteRule,
      version: 2,
      lastOperationId: 'local-rule-pause',
      isActive: false,
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: {
        ...emptyData(),
        accounts: [localAccount],
        categories: [category],
        recurringRules: [localRule],
      },
      outbox: [{ ...operation(localAccount), batchId: 'archive-account-batch' }, {
        id: localRule.lastOperationId,
        entity: 'recurringRules',
        recordId: localRule.id,
        record: localRule,
        attempts: 0,
        queuedAt: NOW,
        batchId: 'archive-account-batch',
      }],
      unresolvedSyncRecordKeys: ['accounts:wallet-batch'],
      lastSyncError: 'unresolved sync conflict for accounts/wallet-batch',
    };

    const accepted = acceptRemoteConflictRecord(
      localState,
      { entity: 'accounts', record: remoteAccount },
      [
        { entity: 'accounts', record: remoteAccount },
        { entity: 'recurringRules', record: remoteRule },
      ],
    );

    expect(accepted.data.accounts).toEqual([remoteAccount]);
    expect(accepted.data.recurringRules).toEqual([remoteRule]);
    expect(accepted.outbox).toEqual([]);
    expect(accepted.unresolvedSyncRecordKeys).toBeUndefined();
    expect(accepted.lastSyncError).toBeUndefined();
  });

  it('restores a pre-batch pending edit instead of discarding it when accepting a related cloud record', async () => {
    const category: Category = {
      id: 'category-pre-batch', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'category-create',
      name: '餐飲', kind: 'expense', icon: { type: 'emoji', value: '🍚' },
      isActive: true, sortOrder: 0,
    };
    const remoteAccount = account('account-pre-batch', 'user-a', 4, 'remote-account');
    const localAccount = {
      ...remoteAccount, name: '本機帳戶改名', version: 3,
      lastOperationId: 'local-account-rename',
    };
    const remoteRule = {
      id: 'rule-pre-batch', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'remote-rule',
      name: '月租', type: 'expense' as const, amount: 10_000,
      categoryId: category.id, categoryName: category.name,
      accountId: remoteAccount.id, accountName: remoteAccount.name,
      frequency: 'monthly' as const, startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    };
    const preBatchRule = {
      ...remoteRule, name: '月租（已校正）', amount: 12_000,
      accountName: '離線編輯時的帳戶名稱', version: 2,
      lastOperationId: 'offline-rule-edit',
    };
    const batchedRule = {
      ...preBatchRule, accountName: localAccount.name, version: 3,
      lastOperationId: 'rule-account-mirror',
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: {
        ...emptyData(), accounts: [localAccount], categories: [category], recurringRules: [batchedRule],
      },
      outbox: [{
        ...operation(localAccount), batchId: 'rename-account-batch',
        batchBeforeRecord: { ...remoteAccount, version: 2, lastOperationId: 'account-before-rename' },
      }, {
        id: batchedRule.lastOperationId,
        entity: 'recurringRules',
        recordId: batchedRule.id,
        record: batchedRule,
        attempts: 0,
        queuedAt: batchedRule.updatedAt,
        batchId: 'rename-account-batch',
        batchBeforeRecord: preBatchRule,
      }],
      unresolvedSyncRecordKeys: [`accounts:${localAccount.id}`],
    };

    const accepted = acceptRemoteConflictRecord(
      localState,
      { entity: 'accounts', record: remoteAccount },
      [
        { entity: 'accounts', record: remoteAccount },
        { entity: 'categories', record: category },
        { entity: 'recurringRules', record: remoteRule },
      ],
    );

    expect(accepted.data.accounts).toEqual([remoteAccount]);
    expect(accepted.data.recurringRules).toEqual([preBatchRule]);
    expect(accepted.outbox).toEqual([expect.objectContaining({
      id: preBatchRule.lastOperationId,
      entity: 'recurringRules',
      recordId: preBatchRule.id,
      record: preBatchRule,
      batchId: undefined,
      batchBeforeRecord: undefined,
    })]);
    expect(accepted.unresolvedSyncRecordKeys).toBeUndefined();

    const remote = new InMemoryRemote([
      { entity: 'accounts', record: remoteAccount },
      { entity: 'categories', record: category },
      { entity: 'recurringRules', record: remoteRule },
    ]);
    const synced = await syncFinanceState(accepted, 'user-a', remote, () => NOW);
    expect(synced.state.outbox).toEqual([]);
    expect((await remote.pull('user-a')).find((entry) => (
      entry.entity === 'recurringRules' && entry.record.id === preBatchRule.id
    ))?.record).toEqual(preBatchRule);

    const acceptedWithoutRemoteRule = acceptRemoteConflictRecord(
      localState,
      { entity: 'accounts', record: remoteAccount },
      [
        { entity: 'accounts', record: remoteAccount },
        { entity: 'categories', record: category },
      ],
    );
    expect(acceptedWithoutRemoteRule.data.recurringRules).toEqual([preBatchRule]);
    expect(acceptedWithoutRemoteRule.outbox).toEqual([expect.objectContaining({
      id: preBatchRule.lastOperationId,
      record: preBatchRule,
      batchId: undefined,
      batchBeforeRecord: undefined,
    })]);
    const missingRemote = new InMemoryRemote([
      { entity: 'accounts', record: remoteAccount },
      { entity: 'categories', record: category },
    ]);
    const created = await syncFinanceState(acceptedWithoutRemoteRule, 'user-a', missingRemote, () => NOW);
    expect(created.state.outbox).toEqual([]);
    expect((await missingRemote.pull('user-a')).find((entry) => (
      entry.entity === 'recurringRules' && entry.record.id === preBatchRule.id
    ))?.record).toEqual(preBatchRule);

    const archivedRemoteAccount = {
      ...remoteAccount, version: 5, lastOperationId: 'remote-account-archive', isActive: false,
    };
    const acceptedArchivedParent = acceptRemoteConflictRecord(
      localState,
      { entity: 'accounts', record: archivedRemoteAccount },
      [{ entity: 'accounts', record: archivedRemoteAccount }],
    );
    const safelyPaused = acceptedArchivedParent.data.recurringRules[0];
    expect(safelyPaused).toEqual(expect.objectContaining({
      ...preBatchRule,
      isActive: false,
      version: batchedRule.version + 1,
      updatedAt: expect.any(String),
      lastOperationId: expect.stringContaining('accept-cloud-parent:'),
    }));
    expect(safelyPaused.lastOperationId).not.toBe(preBatchRule.lastOperationId);
    expect(acceptedArchivedParent.outbox[0]).toEqual(expect.objectContaining({
      id: safelyPaused.lastOperationId,
      record: safelyPaused,
      batchId: undefined,
    }));

    const newerRemoteRule = {
      ...remoteRule,
      version: 4,
      lastOperationId: 'newer-cloud-rule',
    };
    const acceptedArchivedParentAndNewerRule = acceptRemoteConflictRecord(
      localState,
      { entity: 'accounts', record: archivedRemoteAccount },
      [
        { entity: 'accounts', record: archivedRemoteAccount },
        { entity: 'recurringRules', record: newerRemoteRule },
      ],
    );
    const cloudRuleSafelyPaused = acceptedArchivedParentAndNewerRule.data.recurringRules[0];
    expect(cloudRuleSafelyPaused).toEqual(expect.objectContaining({
      ...newerRemoteRule,
      isActive: false,
      version: newerRemoteRule.version + 1,
      updatedAt: expect.any(String),
      lastOperationId: expect.stringContaining('accept-cloud-parent:'),
    }));
    expect(acceptedArchivedParentAndNewerRule.outbox).toEqual([
      expect.objectContaining({
        id: cloudRuleSafelyPaused.lastOperationId,
        record: cloudRuleSafelyPaused,
        batchId: undefined,
      }),
    ]);

    const remoteRuleTombstone = {
      ...newerRemoteRule,
      version: 6,
      lastOperationId: 'tombstone:remote-rule-delete',
      accountName: '刪除當時的帳戶名稱',
      isActive: false,
      deletedAt: '2026-08-27T09:00:00.000Z',
    };
    const acceptedArchivedParentAndRuleTombstone = acceptRemoteConflictRecord(
      localState,
      { entity: 'accounts', record: archivedRemoteAccount },
      [
        { entity: 'accounts', record: archivedRemoteAccount },
        { entity: 'recurringRules', record: remoteRuleTombstone },
      ],
    );
    expect(acceptedArchivedParentAndRuleTombstone.data.recurringRules)
      .toEqual([remoteRuleTombstone]);
    expect(acceptedArchivedParentAndRuleTombstone.outbox).toEqual([]);
  });

  it('retains the complete batch manifest when a conflict appears after the first member applies', async () => {
    const goal: SavingsGoal = {
      id: 'goal-race', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'goal-create', name: '競態目標',
      targetAmount: 5_000, isActive: true,
    };
    const sourceA: SavingsAllocation = {
      id: 'allocation-race-a', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'create-a', goalId: 'goal-race',
      amountDelta: 300, occurredAt: '2026-08-27 08:00',
    };
    const sourceB: SavingsAllocation = {
      id: 'allocation-race-b', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'create-b', goalId: 'goal-race',
      amountDelta: 500, occurredAt: '2026-08-27 08:01',
    };
    const releasedA: SavingsAllocation = {
      ...sourceA, version: 2, updatedAt: '2026-08-27T10:00:00.000Z',
      lastOperationId: 'release-a', deletedAt: '2026-08-27T10:00:00.000Z',
    };
    const releasedB: SavingsAllocation = {
      ...sourceB, version: 2, updatedAt: '2026-08-27T10:00:00.000Z',
      lastOperationId: 'release-b', deletedAt: '2026-08-27T10:00:00.000Z',
    };
    const concurrentRemoteB: SavingsAllocation = {
      ...releasedB, amountDelta: 900, lastOperationId: 'release-z',
    };
    const records = new Map<string, RemoteRecord>([
      ['goals:goal-race', { entity: 'goals', record: goal }],
      ['allocations:allocation-race-a', { entity: 'allocations', record: sourceA }],
      ['allocations:allocation-race-b', { entity: 'allocations', record: sourceB }],
    ]);
    let applyCount = 0;
    const remote: RemoteAdapter = {
      pull: async () => [...records.values()],
      apply: async (_ownerId, pending) => {
        if (pending.record.lastOperationId.includes('batch-compensation:')) {
          records.set(`allocations:${pending.recordId}`, {
            entity: pending.entity,
            record: pending.record,
          } as RemoteRecord);
          return;
        }
        applyCount += 1;
        if (applyCount === 1) {
          records.set(`allocations:${pending.recordId}`, {
            entity: pending.entity,
            record: pending.record,
          } as RemoteRecord);
          return;
        }
        records.set('allocations:allocation-race-b', {
          entity: 'allocations', record: concurrentRemoteB,
        });
      },
      compareAndSwap: async (_ownerId, expected, replacement) => {
        const key = `${expected.entity}:${expected.record.id}`;
        if (JSON.stringify(records.get(key)) !== JSON.stringify(expected)) return undefined;
        const persisted = {
          entity: replacement.entity,
          record: replacement.record,
        } as RemoteRecord;
        records.set(key, persisted);
        return persisted;
      },
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), goals: [goal], allocations: [releasedA, releasedB] },
      outbox: [{
        ...allocationOperation(releasedA),
        batchId: 'release-race',
        batchBeforeRecord: sourceA,
      }, {
        ...allocationOperation(releasedB),
        batchId: 'release-race',
        batchBeforeRecord: sourceB,
      }],
    };

    const conflicted = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(conflicted.state.outbox).toHaveLength(2);
    expect(conflicted.state.outbox.every((operation) => operation.batchId === 'release-race')).toBe(true);
    expect(conflicted.state.unresolvedSyncRecordKeys).toContain('allocations:allocation-race-b');
    const retainedLocalA = conflicted.state.data.allocations.find((record) => record.id === sourceA.id)!;
    expect(retainedLocalA).toEqual(expect.objectContaining({
      id: releasedA.id,
      amountDelta: releasedA.amountDelta,
      version: 4,
      deletedAt: releasedA.deletedAt,
      lastOperationId: expect.stringContaining('tombstone:'),
    }));
    expect(conflicted.state.outbox.find((operation) => operation.recordId === sourceA.id)?.record)
      .toEqual(retainedLocalA);
    const compensatedA = records.get('allocations:allocation-race-a')?.record as SavingsAllocation;
    expect(compensatedA).toEqual(expect.objectContaining({
      id: sourceA.id,
      amountDelta: sourceA.amountDelta,
      version: 3,
      lastOperationId: expect.stringContaining('batch-compensation:'),
    }));
    expect(compensatedA.deletedAt).toBeUndefined();

    const accepted = acceptRemoteConflictRecord(
      conflicted.state,
      { entity: 'allocations', record: concurrentRemoteB },
      [...records.values()],
    );
    expect(accepted.outbox).toEqual([]);
    expect(accepted.unresolvedSyncRecordKeys).toBeUndefined();
    expect(accepted.data.allocations).toEqual([compensatedA, concurrentRemoteB]);
  });

  it('compensates a successful batch member when a later member fails transiently', async () => {
    const beforeA = account('transient-batch-a', 'user-a', 1, 'create-a');
    const beforeB = account('transient-batch-b', 'user-a', 1, 'create-b');
    const desiredA = { ...beforeA, version: 2, lastOperationId: 'archive-a', isActive: false };
    const desiredB = { ...beforeB, version: 2, lastOperationId: 'archive-b', isActive: false };
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: beforeA },
      { entity: 'accounts', record: beforeB },
    ]);
    remote.failBeforeApplyOnce.add(desiredB.lastOperationId);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [desiredA, desiredB] },
      outbox: [{
        ...operation(desiredA), batchId: 'transient-batch', batchBeforeRecord: beforeA,
      }, {
        ...operation(desiredB), batchId: 'transient-batch', batchBeforeRecord: beforeB,
      }],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);
    const compensatedRemoteAccounts = (await remote.pull('user-a'))
      .filter((entry): entry is Extract<RemoteRecord, { entity: 'accounts' }> => entry.entity === 'accounts')
      .map((entry) => entry.record);

    expect(result.state.outbox).toHaveLength(2);
    expect(result.state.data.accounts.find((record) => record.id === desiredA.id)).toEqual(expect.objectContaining({
      id: desiredA.id,
      isActive: false,
      version: 4,
      lastOperationId: expect.stringContaining('batch-retry:'),
    }));
    expect(compensatedRemoteAccounts.find((record) => record.id === beforeA.id)).toEqual(expect.objectContaining({
      id: beforeA.id,
      name: beforeA.name,
      isActive: true,
      version: 3,
      lastOperationId: expect.stringContaining('batch-compensation:'),
    }));
    expect(compensatedRemoteAccounts.find((record) => record.id === beforeB.id)).toEqual(beforeB);

    const retried = await syncFinanceState(result.state, 'user-a', remote, () => NOW);
    const completedRemoteAccounts = (await remote.pull('user-a'))
      .filter((entry): entry is Extract<RemoteRecord, { entity: 'accounts' }> => entry.entity === 'accounts')
      .map((entry) => entry.record);
    expect(retried.state.outbox).toEqual([]);
    expect(completedRemoteAccounts.every((record) => !record.isActive)).toBe(true);
  });

  it('does not compensate over a concurrent write that lands after the exact pull', async () => {
    const beforeA = account('cas-batch-a', 'user-a', 1, 'create-a');
    const beforeB = account('cas-batch-b', 'user-a', 1, 'create-b');
    const desiredA = { ...beforeA, version: 2, lastOperationId: 'archive-a', isActive: false };
    const desiredB = { ...beforeB, version: 2, lastOperationId: 'archive-b', isActive: false };
    const concurrentA = {
      ...beforeA, name: '另一裝置最新名稱', version: 3,
      lastOperationId: 'zzzz-concurrent-a',
    };
    const records = new Map<string, RemoteRecord>([
      [`accounts:${beforeA.id}`, { entity: 'accounts', record: beforeA }],
      [`accounts:${beforeB.id}`, { entity: 'accounts', record: beforeB }],
    ]);
    let applyCount = 0;
    const remote: RemoteAdapter = {
      pull: async () => [...records.values()],
      apply: async (_ownerId, pending) => {
        applyCount += 1;
        if (applyCount === 2) throw new Error('offline before second apply');
        records.set(`${pending.entity}:${pending.recordId}`, {
          entity: pending.entity, record: pending.record,
        } as RemoteRecord);
      },
      compareAndSwap: async () => {
        records.set(`accounts:${beforeA.id}`, { entity: 'accounts', record: concurrentA });
        return undefined;
      },
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [desiredA, desiredB] },
      outbox: [{
        ...operation(desiredA), batchId: 'cas-batch', batchBeforeRecord: beforeA,
      }, {
        ...operation(desiredB), batchId: 'cas-batch', batchBeforeRecord: beforeB,
      }],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(records.get(`accounts:${beforeA.id}`)).toEqual({ entity: 'accounts', record: concurrentA });
    expect(result.state.outbox).toHaveLength(2);
    expect(result.state.lastSyncError).toMatch(/補償前遠端版本已再次變更/);
  });

  it('recovers a committed compensation after its response is lost', async () => {
    const beforeA = account('lost-response-a', 'user-a', 1, 'create-a');
    const beforeB = account('lost-response-b', 'user-a', 1, 'create-b');
    const desiredA = { ...beforeA, version: 2, lastOperationId: 'archive-a', isActive: false };
    const desiredB = { ...beforeB, version: 2, lastOperationId: 'archive-b', isActive: false };
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: beforeA },
      { entity: 'accounts', record: beforeB },
    ]);
    remote.failBeforeApplyOnce.add(desiredB.lastOperationId);
    remote.failAfterCompareAndSwapOnce = true;
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [desiredA, desiredB] },
      outbox: [{
        ...operation(desiredA), batchId: 'lost-response-batch', batchBeforeRecord: beforeA,
      }, {
        ...operation(desiredB), batchId: 'lost-response-batch', batchBeforeRecord: beforeB,
      }],
    };

    const ambiguous = await syncFinanceState(localState, 'user-a', remote, () => NOW);
    expect(ambiguous.state.outbox.find((pending) => pending.recordId === desiredA.id)?.record.version)
      .toBe(2);
    expect(ambiguous.state.lastSyncError).toMatch(/connection dropped after conditional compensation/);

    const recovered = await syncFinanceState(ambiguous.state, 'user-a', remote, () => NOW);
    const remoteAccounts = (await remote.pull('user-a'))
      .filter((entry): entry is Extract<RemoteRecord, { entity: 'accounts' }> => entry.entity === 'accounts')
      .map((entry) => entry.record);
    expect(recovered.state.outbox).toEqual([]);
    expect(remoteAccounts.every((record) => !record.isActive)).toBe(true);
  });

  it('recovers a committed create compensation tombstone after its response is lost', async () => {
    const createdA = account('lost-create-a', 'user-a', 1, 'create-new-a');
    const beforeB = account('lost-create-b', 'user-a', 1, 'create-b');
    const desiredB = { ...beforeB, version: 2, lastOperationId: 'archive-b', isActive: false };
    const remote = new InMemoryRemote([{ entity: 'accounts', record: beforeB }]);
    remote.failBeforeApplyOnce.add(desiredB.lastOperationId);
    remote.failAfterCompareAndSwapOnce = true;
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [createdA, desiredB] },
      outbox: [{
        ...operation(createdA), batchId: 'lost-create-batch', batchBeforeRecord: null,
      }, {
        ...operation(desiredB), batchId: 'lost-create-batch', batchBeforeRecord: beforeB,
      }],
    };

    const ambiguous = await syncFinanceState(localState, 'user-a', remote, () => NOW);
    const compensatedCreate = (await remote.pull('user-a')).find((entry) => (
      entry.entity === 'accounts' && entry.record.id === createdA.id
    ));
    expect(compensatedCreate?.record).toEqual(expect.objectContaining({
      deletedAt: NOW,
      version: 2,
      lastOperationId: expect.stringContaining('tombstone:batch-compensation:'),
    }));
    expect(ambiguous.state.outbox).toHaveLength(2);

    const recovered = await syncFinanceState(ambiguous.state, 'user-a', remote, () => NOW);
    const remoteAccounts = (await remote.pull('user-a'))
      .filter((entry): entry is Extract<RemoteRecord, { entity: 'accounts' }> => entry.entity === 'accounts')
      .map((entry) => entry.record);
    expect(recovered.state.outbox).toEqual([]);
    expect(remoteAccounts.find((record) => record.id === createdA.id)?.deletedAt).toBeUndefined();
    expect(remoteAccounts.find((record) => record.id === beforeB.id)?.isActive).toBe(false);
  });

  it('compensates an effective recovered retry when another batch member fails again', async () => {
    const beforeA = account('lost-repeat-a', 'user-a', 1, 'create-a');
    const beforeB = account('lost-repeat-b', 'user-a', 1, 'create-b');
    const desiredA = { ...beforeA, version: 2, lastOperationId: 'archive-a', isActive: false };
    const desiredB = { ...beforeB, version: 2, lastOperationId: 'archive-b', isActive: false };
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: beforeA },
      { entity: 'accounts', record: beforeB },
    ]);
    remote.failBeforeApplyOnce.add(desiredB.lastOperationId);
    remote.failAfterCompareAndSwapOnce = true;
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [desiredA, desiredB] },
      outbox: [{
        ...operation(desiredA), batchId: 'lost-repeat-batch', batchBeforeRecord: beforeA,
      }, {
        ...operation(desiredB), batchId: 'lost-repeat-batch', batchBeforeRecord: beforeB,
      }],
    };

    const ambiguous = await syncFinanceState(localState, 'user-a', remote, () => NOW);
    remote.failBeforeApplyOnce.add(desiredB.lastOperationId);
    const failedAgain = await syncFinanceState(ambiguous.state, 'user-a', remote, () => NOW);
    const compensatedAgain = (await remote.pull('user-a')).find((entry) => (
      entry.entity === 'accounts' && entry.record.id === desiredA.id
    ));
    expect(failedAgain.state.outbox).toHaveLength(2);
    expect(compensatedAgain?.record).toEqual(expect.objectContaining({
      name: beforeA.name,
      isActive: true,
      lastOperationId: expect.stringContaining('batch-compensation:'),
    }));
    expect(compensatedAgain?.record.version).toBeGreaterThan(desiredA.version);

    const completed = await syncFinanceState(failedAgain.state, 'user-a', remote, () => NOW);
    expect(completed.state.outbox).toEqual([]);
    expect((await remote.pull('user-a')).filter((entry) => entry.entity === 'accounts')
      .every((entry) => !(entry.record as ReturnType<typeof account>).isActive)).toBe(true);
  });

  it('does not recover a compensation created for another batch intent', async () => {
    const beforeA = account('foreign-comp-a', 'user-a', 1, 'create-a');
    const beforeB = account('foreign-comp-b', 'user-a', 1, 'create-b');
    const foreignA = { ...beforeA, version: 2, lastOperationId: 'foreign-archive-a', isActive: false };
    const desiredA = { ...foreignA, lastOperationId: 'local-archive-a' };
    const desiredB = { ...beforeB, version: 2, lastOperationId: 'archive-b', isActive: false };
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: beforeA },
      { entity: 'accounts', record: beforeB },
    ]);
    remote.failBeforeApplyOnce.add(desiredB.lastOperationId);
    const foreignState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [foreignA, desiredB] },
      outbox: [{
        ...operation(foreignA), batchId: 'foreign-batch', batchBeforeRecord: beforeA,
      }, {
        ...operation(desiredB), batchId: 'foreign-batch', batchBeforeRecord: beforeB,
      }],
    };
    await syncFinanceState(foreignState, 'user-a', remote, () => NOW);
    const foreignCompensation = (await remote.pull('user-a')).find((entry) => (
      entry.entity === 'accounts' && entry.record.id === beforeA.id
    ));

    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [desiredA, desiredB] },
      outbox: [{
        ...operation(desiredA), batchId: 'local-batch', batchBeforeRecord: beforeA,
      }, {
        ...operation(desiredB), batchId: 'local-batch', batchBeforeRecord: beforeB,
      }],
    };
    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);
    const currentRemoteA = (await remote.pull('user-a')).find((entry) => (
      entry.entity === 'accounts' && entry.record.id === beforeA.id
    ));

    expect(result.state.outbox).toHaveLength(2);
    expect(result.state.data.accounts.find((record) => record.id === desiredA.id)?.version).toBe(2);
    expect(currentRemoteA).toEqual(foreignCompensation);
    expect(result.state.lastSyncError).toMatch(/整批未上傳|同步衝突/);
  });

  it('blocks every operation in a batch when one member has a persisted conflict lock', async () => {
    const category: Category = {
      id: 'category-batch-lock', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'category-create',
      name: '餐飲', kind: 'expense', icon: { type: 'emoji', value: '🍚' },
      isActive: true, sortOrder: 0,
    };
    const lockedAccount = { ...account('batch-locked-account', 'user-a', 3, 'account-archive'), isActive: false };
    const pausedRule = {
      id: 'batch-locked-rule', ownerId: 'user-a', version: 2,
      updatedAt: NOW, lastOperationId: 'rule-pause',
      name: '月租', type: 'expense' as const, amount: 10_000,
      categoryId: category.id, categoryName: category.name,
      accountId: lockedAccount.id, accountName: lockedAccount.name,
      frequency: 'monthly' as const, startDate: '2026-08-01', nextOccurrenceDate: '2026-09-01',
      isActive: false,
    };
    const apply = vi.fn(async () => undefined);
    const remote: RemoteAdapter = { apply, pull: async () => [] };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: {
        ...emptyData(),
        accounts: [lockedAccount],
        categories: [category],
        recurringRules: [pausedRule],
      },
      outbox: [{
        ...operation(lockedAccount),
        batchId: 'locked-batch',
        batchBeforeRecord: { ...lockedAccount, version: 2, lastOperationId: 'account-active', isActive: true },
      }, {
        id: pausedRule.lastOperationId,
        entity: 'recurringRules',
        recordId: pausedRule.id,
        record: pausedRule,
        attempts: 0,
        queuedAt: NOW,
        batchId: 'locked-batch',
        batchBeforeRecord: { ...pausedRule, version: 1, lastOperationId: 'rule-active', isActive: true },
      }],
      unresolvedSyncRecordKeys: ['accounts:batch-locked-account'],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(apply).not.toHaveBeenCalled();
    expect(result.state.outbox).toHaveLength(2);
    expect(result.report.failures.filter((failure) => failure.stage === 'conflict')).toHaveLength(2);
  });

  it('keeps retained batch payloads reload-safe when a remote tombstone wins', async () => {
    const beforeA = account('remote-deleted-batch-a', 'user-a', 1, 'create-a');
    const beforeB = account('remote-deleted-batch-b', 'user-a', 1, 'create-b');
    const localA = { ...beforeA, version: 2, lastOperationId: 'local-edit-a', name: '本機 A' };
    const localB = { ...beforeB, version: 2, lastOperationId: 'local-edit-b', name: '本機 B' };
    const remoteDeletedA = {
      ...beforeA, version: 3, lastOperationId: 'tombstone:remote-delete-a',
      deletedAt: NOW, isActive: false,
    };
    const remote = new InMemoryRemote([
      { entity: 'accounts', record: remoteDeletedA },
      { entity: 'accounts', record: beforeB },
    ]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), accounts: [localA, localB] },
      outbox: [{
        ...operation(localA), batchId: 'edit-batch', batchBeforeRecord: beforeA,
      }, {
        ...operation(localB), batchId: 'edit-batch', batchBeforeRecord: beforeB,
      }],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.state.outbox).toHaveLength(2);
    for (const pending of result.state.outbox) {
      expect(result.state.data.accounts.find((record) => record.id === pending.recordId))
        .toEqual(pending.record);
    }
    expect(result.state.data.accounts.find((record) => record.id === localA.id)).toEqual(localA);
    expect(result.state.unresolvedSyncRecordKeys).toContain(`accounts:${localA.id}`);
  });

  it('keeps a local-only dependent rule when accepting its parent cloud version', () => {
    const category: Category = {
      id: 'category-local-rule', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'category-create',
      name: '餐飲', kind: 'expense', icon: { type: 'emoji', value: '🍚' },
      isActive: true, sortOrder: 0,
    };
    const remoteAccount = { ...account('account-local-rule', 'user-a', 4, 'remote-account'), name: '雲端帳戶' };
    const localAccount = {
      ...remoteAccount,
      version: 3,
      lastOperationId: 'local-account-rename',
      name: '本機改名',
    };
    const localRule = {
      id: 'local-only-rule', ownerId: 'user-a', version: 1,
      updatedAt: NOW, lastOperationId: 'local-rule-create',
      name: '本機新規則', type: 'expense' as const, amount: 500,
      categoryId: category.id, categoryName: category.name,
      accountId: localAccount.id, accountName: localAccount.name,
      frequency: 'monthly' as const, startDate: '2026-09-01', nextOccurrenceDate: '2026-09-01',
      isActive: true,
    };
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: {
        ...emptyData(),
        accounts: [localAccount],
        categories: [category],
        recurringRules: [localRule],
      },
      outbox: [{ ...operation(localAccount), batchId: 'rename-parent-batch' }, {
        id: localRule.lastOperationId,
        entity: 'recurringRules',
        recordId: localRule.id,
        record: localRule,
        attempts: 0,
        queuedAt: NOW,
        batchId: 'rename-parent-batch',
      }],
      unresolvedSyncRecordKeys: ['accounts:account-local-rule'],
    };

    const accepted = acceptRemoteConflictRecord(
      localState,
      { entity: 'accounts', record: remoteAccount },
      [{ entity: 'accounts', record: remoteAccount }],
    );

    expect(accepted.data.accounts).toEqual([remoteAccount]);
    expect(accepted.data.recurringRules).toEqual([
      expect.objectContaining({ id: localRule.id, accountName: remoteAccount.name }),
    ]);
    expect(accepted.outbox).toEqual([
      expect.objectContaining({
        entity: 'recurringRules',
        recordId: localRule.id,
        batchId: undefined,
        record: expect.objectContaining({ accountName: remoteAccount.name }),
      }),
    ]);
    expect(accepted.unresolvedSyncRecordKeys).toBeUndefined();
  });

  it('preserves a newer queued inactive budget edit when an older remote budget is already inactive', async () => {
    const remoteBudget: Budget = {
      id: 'budget-offline-edit', ownerId: 'user-a', version: 2,
      updatedAt: NOW, lastOperationId: 'remote-archive',
      scope: 'overall', period: 'monthly', amount: 5_000, isActive: false,
    };
    const localBudget: Budget = {
      ...remoteBudget,
      version: 3,
      lastOperationId: 'local-offline-edit',
      amount: 8_000,
    };
    const remote = new InMemoryRemote([{ entity: 'budgets', record: remoteBudget }]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localBudget] },
      outbox: [budgetOperation(localBudget)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.state.outbox).toEqual([]);
    expect(result.state.data.budgets).toEqual([localBudget]);
    expect((await remote.pull('user-a'))[0]).toEqual({ entity: 'budgets', record: localBudget });
  });

  it('treats an exactly matching inactive remote budget as an idempotent confirmation', async () => {
    const inactive: Budget = {
      id: 'budget-confirmed-archive', ownerId: 'user-a', version: 3,
      updatedAt: NOW, lastOperationId: 'confirmed-archive',
      scope: 'overall', period: 'monthly', amount: 8_000, isActive: false,
    };
    const remote = new InMemoryRemote([{ entity: 'budgets', record: inactive }]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [inactive] },
      outbox: [budgetOperation(inactive)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.report.status).toBe('synced');
    expect(result.state.outbox).toEqual([]);
    expect(result.state.data.budgets).toEqual([inactive]);
  });

  it('keeps a same-clock divergent inactive budget pending for explicit conflict review', async () => {
    const localBudget: Budget = {
      id: 'budget-divergent-archive', ownerId: 'user-a', version: 3,
      updatedAt: NOW, lastOperationId: 'shared-archive-clock',
      scope: 'overall', period: 'monthly', amount: 8_000, isActive: false,
    };
    const remoteBudget: Budget = { ...localBudget, amount: 5_000 };
    const remote = new InMemoryRemote([{ entity: 'budgets', record: remoteBudget }]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localBudget] },
      outbox: [budgetOperation(localBudget)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.report.status).toBe('partial');
    expect(result.state.data.budgets).toEqual([localBudget]);
    expect(result.state.outbox).toEqual([
      expect.objectContaining({
        id: localBudget.lastOperationId,
        lastError: expect.stringContaining('same-clock payload conflict'),
      }),
    ]);
    expect(result.report.conflicts).toEqual([
      expect.objectContaining({ winner: 'unresolved', reason: 'payload' }),
    ]);
  });

  it('accepts an inactive remote budget only when its conflict clock wins', async () => {
    const localBudget: Budget = {
      id: 'budget-remote-winner', ownerId: 'user-a', version: 3,
      updatedAt: NOW, lastOperationId: 'local-archive',
      scope: 'overall', period: 'monthly', amount: 8_000, isActive: false,
    };
    const remoteBudget: Budget = {
      ...localBudget,
      version: 4,
      lastOperationId: 'remote-newer-archive',
      amount: 5_000,
    };
    const remote = new InMemoryRemote([{ entity: 'budgets', record: remoteBudget }]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localBudget] },
      outbox: [budgetOperation(localBudget)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.state.outbox).toEqual([]);
    expect(result.state.data.budgets).toEqual([remoteBudget]);
  });

  it('does not let an ordinary stale archive overwrite a newer remote reactivation', async () => {
    const localArchive: Budget = {
      id: 'budget-reactivated-remotely', ownerId: 'user-a', version: 3,
      updatedAt: NOW, lastOperationId: 'local-stale-archive',
      scope: 'overall', period: 'monthly', amount: 8_000, isActive: false,
    };
    const remoteReactivation: Budget = {
      ...localArchive,
      version: 4,
      lastOperationId: 'remote-reactivation',
      amount: 9_000,
      isActive: true,
    };
    const remote = new InMemoryRemote([{ entity: 'budgets', record: remoteReactivation }]);
    const localState: PersistedFinanceState = {
      schemaVersion: 4,
      ownerId: 'user-a',
      data: { ...emptyData(), budgets: [localArchive] },
      outbox: [budgetOperation(localArchive)],
    };

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(result.state.outbox).toEqual([]);
    expect(result.state.data.budgets).toEqual([remoteReactivation]);
    expect((await remote.pull('user-a'))[0]).toEqual({
      entity: 'budgets',
      record: remoteReactivation,
    });
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
      lastError: expect.stringContaining('unresolved same-clock payload conflict'),
    });
    expect(result.state.unresolvedSyncRecordKeys).toEqual(['accounts:wallet']);
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

  it('never sends a pending write whose persisted conflict lock is unresolved', async () => {
    const local = {
      ...account('wallet-locked', 'user-a', 4, 'local-after-conflict'),
      name: 'local winner that must remain blocked',
    };
    const remoteRecord = {
      ...local,
      version: 3,
      lastOperationId: 'remote-conflicted-value',
      name: 'remote value',
    };
    const apply = vi.fn(async () => undefined);
    const remote: RemoteAdapter = {
      apply,
      pull: async () => [{ entity: 'accounts', record: remoteRecord }],
    };
    const localState = state('user-a', [local], [operation(local)]);
    localState.unresolvedSyncRecordKeys = ['accounts:wallet-locked'];

    const result = await syncFinanceState(localState, 'user-a', remote, () => NOW);

    expect(apply).not.toHaveBeenCalled();
    expect(result.state.outbox).toHaveLength(1);
    expect(result.state.unresolvedSyncRecordKeys).toEqual(['accounts:wallet-locked']);
    expect(result.report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'conflict', recordId: 'wallet-locked' }),
    ]));
  });

  it('persists a pulled same-clock payload conflict until the user explicitly accepts the cloud record', async () => {
    const local = {
      ...account('wallet-no-outbox', 'user-a', 3, 'op-same-clock-no-outbox'),
      name: 'local value',
    };
    let remoteRecord = { ...local, name: 'remote divergent value' };
    const remote: RemoteAdapter = {
      apply: async () => {},
      pull: async () => [{ entity: 'accounts', record: remoteRecord }],
    };

    const conflicted = await syncFinanceState(
      state('user-a', [local], []),
      'user-a',
      remote,
      () => NOW,
    );

    expect(conflicted.state.outbox).toEqual([]);
    expect(conflicted.state.unresolvedSyncRecordKeys).toEqual(['accounts:wallet-no-outbox']);

    remoteRecord = local;
    const resolved = await syncFinanceState(
      conflicted.state,
      'user-a',
      remote,
      () => NOW,
    );

    expect(resolved.state.unresolvedSyncRecordKeys).toEqual(['accounts:wallet-no-outbox']);
    expect(resolved.report.conflicts).toEqual([]);

    remoteRecord = { ...local, name: 'explicitly accepted cloud value' };
    const accepted = acceptRemoteConflictRecord(resolved.state, {
      entity: 'accounts',
      record: remoteRecord,
    });
    expect(accepted.unresolvedSyncRecordKeys).toBeUndefined();
    expect(accepted.data.accounts).toEqual([remoteRecord]);
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
      schemaVersion: 4,
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
