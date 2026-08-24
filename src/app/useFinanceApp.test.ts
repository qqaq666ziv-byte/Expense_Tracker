import { describe, expect, it, vi } from 'vitest';
import type { RecurringRule, Transaction } from '../domain/model';
import {
  createInitialState,
  loadFinanceStateWithRecovery,
  putRecord,
  storageKey,
} from './state';
import {
  applyFinanceMutationUnlessRecovering,
  assertCurrentOwnerContext,
  clearSuccessfulRecoveryUiState,
  materializeRecurringTransactionsUnlessRecovering,
  resolveLegacyBootstrapState,
  restoreFinanceStateUnlessLegacyBootstrap,
} from './useFinanceApp';

function corruptedGuestLoad() {
  const raw = '{broken-json';
  const getItem = vi.fn((key: string) => key === storageKey('guest') ? raw : null);
  return {
    getItem,
    load: () => loadFinanceStateWithRecovery('guest', { getItem }),
  };
}

function readyLegacyState() {
  const state = createInitialState('user-a');
  state.initialBootstrap = undefined;
  state.outbox = [];
  const candidate = structuredClone(state.data);
  candidate.accounts[0] = {
    ...candidate.accounts[0],
    name: '舊版現金',
  };
  state.legacyBootstrap = {
    status: 'ready',
    candidate,
    unsyncedTransactionIds: [],
  };
  return state;
}

describe('authenticated legacy bootstrap decisions', () => {
  it('persists removal of the candidate before returning the keep-cloud state', () => {
    const state = readyLegacyState();
    const persisted: typeof state[] = [];

    const next = resolveLegacyBootstrapState(
      state,
      'keep-cloud',
      (value) => persisted.push(value),
      vi.fn(),
    );

    expect(persisted).toEqual([next]);
    expect(next.legacyBootstrap).toBeUndefined();
    expect(next.migratedFromLegacy).toBeUndefined();
    expect(next.data).toEqual(state.data);
    expect(state.legacyBootstrap?.status).toBe('ready');
  });

  it('imports the candidate through the durable restore path only after an explicit decision', () => {
    const state = readyLegacyState();
    const order: string[] = [];

    const next = resolveLegacyBootstrapState(
      state,
      'import-candidate',
      () => order.push('persist'),
      () => order.push('clear-recovery'),
    );

    expect(order).toEqual(['persist', 'clear-recovery']);
    expect(next.legacyBootstrap).toBeUndefined();
    expect(next.migratedFromLegacy).toBeUndefined();
    expect(next.data.accounts[0].name).toBe('舊版現金');
    expect(next.data.accounts[0].version).toBeGreaterThan(state.data.accounts[0].version);
    expect(next.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'accounts', recordId: state.data.accounts[0].id }),
    ]));
  });

  it('keeps the candidate and recovery lock when persistence fails', () => {
    const state = readyLegacyState();
    const clearRecovery = vi.fn();

    expect(() => resolveLegacyBootstrapState(
      state,
      'import-candidate',
      () => { throw new Error('quota exceeded'); },
      clearRecovery,
    )).toThrow(/quota exceeded/);

    expect(clearRecovery).not.toHaveBeenCalled();
    expect(state.legacyBootstrap?.status).toBe('ready');
  });

  it('rejects decisions until the cloud-first pull has completed', () => {
    const state = readyLegacyState();
    state.legacyBootstrap = { ...state.legacyBootstrap!, status: 'pending' };
    const persist = vi.fn();

    expect(() => resolveLegacyBootstrapState(
      state,
      'keep-cloud',
      persist,
      vi.fn(),
    )).toThrow(/cloud-first pull/i);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(['pending', 'ready'] as const)(
    'blocks an ordinary backup restore while the legacy candidate is %s',
    (status) => {
      const state = readyLegacyState();
      state.legacyBootstrap = { ...state.legacyBootstrap!, status };
      const persist = vi.fn();
      const clearRecovery = vi.fn();

      expect(() => restoreFinanceStateUnlessLegacyBootstrap(
        state,
        structuredClone(state.data),
        persist,
        clearRecovery,
      )).toThrow(/完成舊版候選資料決策/);

      expect(persist).not.toHaveBeenCalled();
      expect(clearRecovery).not.toHaveBeenCalled();
      expect(state.legacyBootstrap?.status).toBe(status);
    },
  );
});

describe('authenticated initial bootstrap gate', () => {
  it('blocks ordinary mutations and backup restore until the cloud-first pull completes', () => {
    const state = createInitialState('user-a');
    const account = {
      ...state.data.accounts[0],
      id: 'blocked-before-pull',
      lastOperationId: 'blocked-before-pull-create',
    };
    const persist = vi.fn();
    const clearRecovery = vi.fn();

    expect(() => putRecord(state, 'accounts', account)).toThrow(/initial bootstrap/i);
    expect(() => restoreFinanceStateUnlessLegacyBootstrap(
      state,
      structuredClone(state.data),
      persist,
      clearRecovery,
    )).toThrow(/authoritative pull/i);
    expect(materializeRecurringTransactionsUnlessRecovering(
      state,
      '2026-08-24',
      undefined,
    )).toBe(state);
    expect(persist).not.toHaveBeenCalled();
    expect(clearRecovery).not.toHaveBeenCalled();
    expect(state.outbox).toEqual([]);
  });

  it('allows an explicit valid backup to durably recover a malformed authenticated snapshot', () => {
    const storage = {
      getItem: (key: string) => key === storageKey('user-a') ? '{broken-json' : null,
    };
    const loaded = loadFinanceStateWithRecovery('user-a', storage);
    const backup = structuredClone(createInitialState('user-a').data);
    const order: string[] = [];

    const restored = restoreFinanceStateUnlessLegacyBootstrap(
      loaded.state,
      backup,
      () => order.push('persist'),
      () => order.push('clear-recovery'),
      true,
    );

    expect(loaded.recovery).toBeDefined();
    expect(order).toEqual(['persist', 'clear-recovery']);
    expect(restored.initialBootstrap).toBeUndefined();
    expect(restored.outbox).toHaveLength(15);
    expect(restored.outbox.every(({ record }) => record.deletedAt === undefined)).toBe(true);
    expect(restored.data.accounts).toHaveLength(1);
    expect(restored.data.categories).toHaveLength(14);
  });

  it('keeps recurrence materialization blocked throughout partial default seeding', () => {
    const state = createInitialState('user-a');
    const account = state.data.accounts[0];
    const category = state.data.categories.find((item) => item.kind === 'income')!;
    state.data.recurringRules = [{
      id: 'seeding-weekly-income',
      ownerId: 'user-a',
      version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastOperationId: 'seeding-weekly-income-create',
      name: '每週收入',
      type: 'income',
      amount: 1_000,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      frequency: 'weekly',
      startDate: '2026-08-03',
      nextOccurrenceDate: '2026-08-03',
      isActive: true,
    }];
    state.initialBootstrap = { ...state.initialBootstrap!, status: 'seeding' };

    expect(materializeRecurringTransactionsUnlessRecovering(
      state,
      '2026-08-24',
      undefined,
    )).toBe(state);
    expect(state.outbox).toEqual([]);
  });
});

describe('owner-bound controller actions', () => {
  it('accepts the exact owner and activation generation rendered with the action', () => {
    expect(() => assertCurrentOwnerContext(
      { ownerId: 'user-a', generation: 3 },
      'user-a',
      'user-a',
      3,
    )).not.toThrow();
  });

  it('rejects a stale action after switching to another owner', () => {
    expect(() => assertCurrentOwnerContext(
      { ownerId: 'user-a', generation: 3 },
      'user-b',
      'user-b',
      4,
    )).toThrow(/帳號已切換/);
  });

  it('rejects a stale action after reactivating the same owner', () => {
    expect(() => assertCurrentOwnerContext(
      { ownerId: 'user-a', generation: 3 },
      'user-a',
      'user-a',
      4,
    )).toThrow(/帳號已切換/);
  });
});

describe('local snapshot recovery mutation lock', () => {
  it('clears the stale safety notice together with the recovery lock after a durable restore', () => {
    const loaded = corruptedGuestLoad().load();
    const recoveryRef = { current: loaded.recovery };
    const setRecovery = vi.fn();
    const setSafetyNotice = vi.fn();

    clearSuccessfulRecoveryUiState(recoveryRef, setRecovery, setSafetyNotice);

    expect(recoveryRef.current).toBeUndefined();
    expect(setRecovery).toHaveBeenCalledOnce();
    expect(setRecovery).toHaveBeenCalledWith(undefined);
    expect(setSafetyNotice).toHaveBeenCalledOnce();
    expect(setSafetyNotice).toHaveBeenCalledWith(undefined);
  });

  it('does not enqueue or expose an ordinary mutation that would disappear on reload', () => {
    const storage = corruptedGuestLoad();
    const loaded = storage.load();
    const account = loaded.state.data.accounts[0];
    const category = loaded.state.data.categories.find((item) => item.kind === 'expense')!;
    const transaction: Transaction = {
      id: 'blocked-expense',
      ownerId: 'guest',
      version: 1,
      updatedAt: '2026-08-23T00:00:00.000Z',
      lastOperationId: 'blocked-expense-create',
      amount: 100,
      type: 'expense',
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      occurredAt: '2026-08-23T00:00:00.000Z',
    };
    const mutate = vi.fn((current: typeof loaded.state) => (
      putRecord(current, 'transactions', transaction)
    ));

    const next = applyFinanceMutationUnlessRecovering(
      loaded.state,
      loaded.recovery,
      mutate,
    );

    expect(loaded.recovery).toBeDefined();
    expect(mutate).not.toHaveBeenCalled();
    expect(next).toBe(loaded.state);
    expect(next.data.transactions).toEqual([]);
    expect(next.outbox).toEqual([]);

    const reloaded = storage.load();
    expect(reloaded.recovery?.raw).toBe('{broken-json');
    expect(reloaded.state.data.transactions).toEqual([]);
    expect(reloaded.state.outbox).toEqual([]);
  });

  it('does not materialize recurring transactions or advance their cursor during recovery', () => {
    const storage = corruptedGuestLoad();
    const loaded = storage.load();
    const account = loaded.state.data.accounts[0];
    const category = loaded.state.data.categories.find((item) => item.kind === 'income')!;
    const rule: RecurringRule = {
      id: 'blocked-weekly-income',
      ownerId: 'guest',
      version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastOperationId: 'blocked-weekly-income-create',
      name: '每週收入',
      type: 'income',
      amount: 1_000,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      frequency: 'weekly',
      startDate: '2026-08-03',
      nextOccurrenceDate: '2026-08-03',
      isActive: true,
    };
    const state = {
      ...loaded.state,
      data: {
        ...loaded.state.data,
        recurringRules: [rule],
      },
    };

    const next = materializeRecurringTransactionsUnlessRecovering(
      state,
      '2026-08-23',
      loaded.recovery,
    );

    expect(next).toBe(state);
    expect(next.data.transactions).toEqual([]);
    expect(next.data.recurringRules[0]).toBe(rule);
    expect(next.data.recurringRules[0].nextOccurrenceDate).toBe('2026-08-03');
    expect(next.outbox).toEqual([]);
    expect(storage.load().recovery?.raw).toBe('{broken-json');
  });
});
