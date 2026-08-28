import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabaseClient';
import type {
  FinanceData,
  FinanceEntityName,
  AssetAccount,
  Category,
  SavingsAllocation,
  SavingsGoal,
  PersistedFinanceState,
  SyncRecord,
} from '../domain/model';
import { catchUpRecurringTransactions } from '../domain/recurrence';
import { recurringRuleParentIssue } from '../domain/recurringSafety';
import {
  acceptRemoteConflictRecord,
  hasUnresolvedPayloadConflict,
  syncRecordKey,
  unresolvedPayloadConflictKeys,
  type SyncReport,
} from '../domain/syncEngine';
import { createSupabaseRemoteAdapter } from '../data/supabaseRemote';
import {
  restoreFinanceStateAndClearRecovery,
  syncFinanceStateUnlessRecovering,
} from './safeSync';
import {
  applySyncCompletion,
  applyAccountArchiveMutation,
  applyGoalAllocationReleaseMutation,
  applyCategoryLifecycleMutation,
  advanceFinanceStateRef,
  canAutoSaveFinanceState,
  changedRecordMeta,
  guestSnapshotFingerprint,
  hasUserContent,
  loadFinanceStateWithRecovery,
  persistGuestImportState,
  planGuestImport,
  type LocalStateRecovery,
  putRecord,
  putCategoryWithDependents,
  putAccountWithDependents,
  remapOwner,
  saveFinanceState,
  tombstoneRecordMeta,
} from './state';
import { assertCategoryUpsert, type CategoryAction } from '../domain/lifecycle';

export interface FinanceAppController {
  state: PersistedFinanceState;
  user: User | null;
  authLoading: boolean;
  cloudEnabled: boolean;
  syncBusy: boolean;
  syncReport: SyncReport | null;
  unresolvedSyncRecordKeys: ReadonlySet<string>;
  mutationLockedRecordKeys: ReadonlySet<string>;
  conflictResolutionImpact: ReadonlyMap<string, number>;
  storageError?: string;
  storageRecovery?: LocalStateRecovery;
  guestImportNotice?: string;
  legacyBootstrapNotice?: string;
  safetyNotice?: string;
  hasSeparateGuestData: boolean;
  dismissGuestImport(): void;
  importGuestData(): void;
  importLegacyCandidate(): void;
  keepCloudData(): void;
  setData(data: FinanceData): void;
  put<E extends FinanceEntityName>(entity: E, record: FinanceData[E][number]): boolean;
  categoryLifecycle(record: Category, action: CategoryAction): boolean;
  archiveAccount(record: AssetAccount): boolean;
  releaseGoalAllocations(goal: SavingsGoal): boolean;
  softDelete<E extends FinanceEntityName>(entity: E, record: FinanceData[E][number]): boolean;
  acceptRemoteConflict(entity: FinanceEntityName, recordId: string): Promise<boolean>;
  syncNow(): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export type LegacyBootstrapDecision = 'import-candidate' | 'keep-cloud';

export interface OwnerActionContext {
  ownerId: string;
  generation: number;
}

/** Clear every recovery-only UI signal after the replacement snapshot is durably persisted. */
export function clearSuccessfulRecoveryUiState(
  recoveryRef: { current: LocalStateRecovery | undefined },
  setRecovery: (value: LocalStateRecovery | undefined) => void,
  setSafetyNotice: (value: string | undefined) => void,
): void {
  recoveryRef.current = undefined;
  setRecovery(undefined);
  setSafetyNotice(undefined);
}

/** Reject callbacks retained by a render that is no longer the active owner. */
export function assertCurrentOwnerContext(
  expected: OwnerActionContext,
  activeOwnerId: string,
  stateOwnerId: string,
  currentGeneration: number,
): void {
  if (
    expected.ownerId !== activeOwnerId
    || expected.ownerId !== stateOwnerId
    || expected.generation !== currentGeneration
  ) {
    throw new Error('帳號已切換；舊畫面的操作未執行');
  }
}

/**
 * Resolve a reviewed legacy candidate only after its cloud-first pull. Both
 * decisions durably remove the bootstrap marker before callers update React
 * memory; import additionally uses the same restore path as a JSON backup so
 * every accepted record receives a fresh, retryable operation clock.
 */
export function resolveLegacyBootstrapState(
  state: PersistedFinanceState,
  decision: LegacyBootstrapDecision,
  persist: (next: PersistedFinanceState) => void,
  clearRecovery: () => void,
): PersistedFinanceState {
  const bootstrap = state.legacyBootstrap;
  if (bootstrap?.status !== 'ready') {
    throw new Error('legacy candidate decisions require a completed cloud-first pull');
  }
  const resolvedBase: PersistedFinanceState = {
    ...state,
    migratedFromLegacy: undefined,
    legacyBootstrap: undefined,
  };
  if (decision === 'keep-cloud') {
    persist(resolvedBase);
    return resolvedBase;
  }
  return restoreFinanceStateAndClearRecovery(
    resolvedBase,
    bootstrap.candidate,
    persist,
    clearRecovery,
  );
}

/**
 * An ordinary JSON restore is a separate destructive decision. Do not let it
 * race with, or be silently superseded by, an unresolved legacy candidate.
 */
export function restoreFinanceStateUnlessLegacyBootstrap(
  state: PersistedFinanceState,
  data: FinanceData,
  persist: (next: PersistedFinanceState) => void,
  clearRecovery: () => void,
  allowInitialBootstrapRecovery = false,
): PersistedFinanceState {
  if (state.initialBootstrap && !allowInitialBootstrapRecovery) {
    throw new Error('雲端帳本尚在初始化；完成 authoritative pull 前不會執行備份還原');
  }
  if (state.legacyBootstrap) {
    throw new Error('請先完成舊版候選資料決策，再執行一般備份還原');
  }
  if ((state.unresolvedSyncRecordKeys?.length ?? 0) > 0) {
    throw new Error('仍有未解同步衝突；請先在衝突提示中明確選擇雲端版本，再還原備份。');
  }
  return restoreFinanceStateAndClearRecovery(state, data, persist, clearRecovery);
}

/**
 * A malformed local snapshot is the recoverable source of truth until the
 * user completes a durable restore. Never expose an in-memory mutation that
 * autosave is intentionally forbidden to persist while that lock is active.
 */
export function applyFinanceMutationUnlessRecovering(
  state: PersistedFinanceState,
  recovery: LocalStateRecovery | undefined,
  mutate: (current: PersistedFinanceState) => PersistedFinanceState,
): PersistedFinanceState {
  return recovery ? state : mutate(state);
}

export function assertSyncRecordMutationAllowed(
  state: PersistedFinanceState,
  entity: FinanceEntityName,
  recordId: string,
): void {
  if (hasUnresolvedPayloadConflict(
    state.outbox,
    entity,
    recordId,
    state.unresolvedSyncRecordKeys,
  )) {
    throw new Error(`此筆${entity}資料有未解同步衝突；為避免覆蓋另一裝置內容，本次操作未執行。`);
  }
}

export function assertSyncRecordMutationsAllowed(
  state: PersistedFinanceState,
  targets: readonly { entity: FinanceEntityName; recordId: string }[],
): void {
  for (const target of targets) {
    assertSyncRecordMutationAllowed(state, target.entity, target.recordId);
  }
}

export function assertFinanceMutationNotSyncing(syncInProgress: boolean): void {
  if (syncInProgress) {
    throw new Error('同步正在比對另一台裝置的版本；請等同步完成後再操作。');
  }
}

export function syncMutationTargets<E extends FinanceEntityName>(
  state: PersistedFinanceState,
  entity: E,
  record: FinanceData[E][number],
): { entity: FinanceEntityName; recordId: string }[] {
  const targets: { entity: FinanceEntityName; recordId: string }[] = [
    { entity, recordId: record.id },
  ];
  if (entity === 'categories') {
    const category = record as Category;
    const existing = state.data.categories.find((candidate) => candidate.id === category.id);
    const siblings = state.data.categories
      .filter((candidate) => (
        !candidate.deletedAt && candidate.kind === category.kind && candidate.id !== category.id
      ))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
    const desiredIndex = Math.max(0, Math.min(category.sortOrder, siblings.length));
    const ordered = [...siblings];
    ordered.splice(desiredIndex, 0, category);
    targets.push(...ordered.flatMap((candidate, sortOrder) => (
      candidate.id !== category.id && candidate.sortOrder !== sortOrder
        ? [{ entity: 'categories' as const, recordId: candidate.id }]
        : []
    )));
    if (existing && existing.name !== category.name) {
      targets.push(...state.data.recurringRules
        .filter((rule) => !rule.deletedAt && rule.categoryId === category.id)
        .map((rule) => ({ entity: 'recurringRules' as const, recordId: rule.id })));
    }
  }
  if (entity === 'accounts') {
    const account = record as AssetAccount;
    const existing = state.data.accounts.find((candidate) => candidate.id === account.id);
    if (existing && existing.name !== account.name) {
      targets.push(...state.data.recurringRules
        .filter((rule) => !rule.deletedAt && rule.accountId === account.id)
        .map((rule) => ({ entity: 'recurringRules' as const, recordId: rule.id })));
    }
  }
  if (entity === 'allocations') {
    const allocation = record as SavingsAllocation;
    const existing = state.data.allocations.find((candidate) => candidate.id === allocation.id);
    const goalIds = new Set([allocation.goalId, existing?.goalId].filter(Boolean) as string[]);
    targets.push(...[...goalIds].map((goalId) => ({ entity: 'goals' as const, recordId: goalId })));
    targets.push(...state.data.allocations
      .filter((candidate) => (
        !candidate.deletedAt
        && goalIds.has(candidate.goalId)
        && candidate.id !== allocation.id
      ))
      .map((candidate) => ({ entity: 'allocations' as const, recordId: candidate.id })));
  }
  if (entity === 'transactions') {
    const transaction = record as FinanceData['transactions'][number];
    const existing = state.data.transactions.find((candidate) => candidate.id === transaction.id);
    for (const candidate of [transaction, existing].filter(Boolean) as FinanceData['transactions']) {
      targets.push(
        { entity: 'accounts', recordId: candidate.accountId },
        { entity: 'categories', recordId: candidate.categoryId },
      );
      if (candidate.recurringRuleId) {
        targets.push({ entity: 'recurringRules', recordId: candidate.recurringRuleId });
      }
    }
  }
  if (entity === 'adjustments') {
    const adjustment = record as FinanceData['adjustments'][number];
    const existing = state.data.adjustments.find((candidate) => candidate.id === adjustment.id);
    targets.push(...[...new Set([adjustment.accountId, existing?.accountId]
      .filter(Boolean) as string[])]
      .map((accountId) => ({ entity: 'accounts' as const, recordId: accountId })));
  }
  if (entity === 'budgets') {
    const budget = record as FinanceData['budgets'][number];
    const existing = state.data.budgets.find((candidate) => candidate.id === budget.id);
    for (const candidate of [budget, existing].filter(Boolean) as FinanceData['budgets']) {
      if (candidate.scope === 'category' && candidate.categoryId) {
        targets.push({ entity: 'categories', recordId: candidate.categoryId });
      }
    }
  }
  if (entity === 'recurringRules') {
    const rule = record as FinanceData['recurringRules'][number];
    const existing = state.data.recurringRules.find((candidate) => candidate.id === rule.id);
    for (const candidate of [rule, existing].filter(Boolean) as FinanceData['recurringRules']) {
      targets.push(
        { entity: 'accounts', recordId: candidate.accountId },
        { entity: 'categories', recordId: candidate.categoryId },
      );
    }
  }
  return [...new Map(targets.map((target) => [
    syncRecordKey(target.entity, target.recordId),
    target,
  ])).values()];
}

export function materializeRecurringTransactionsUnlessRecovering(
  state: PersistedFinanceState,
  calendarDay: string,
  recovery: LocalStateRecovery | undefined,
): PersistedFinanceState {
  return applyFinanceMutationUnlessRecovering(state, recovery, (current) => {
    if (current.legacyBootstrap?.status === 'pending'
      || current.initialBootstrap) return current;
    let next = current;
    let changed = false;
    for (const rule of current.data.recurringRules.filter((item) => !item.deletedAt && item.isActive)) {
      if ([
        ['recurringRules', rule.id],
        ['accounts', rule.accountId],
        ['categories', rule.categoryId],
      ].some(([entity, recordId]) => hasUnresolvedPayloadConflict(
        current.outbox,
        entity as FinanceEntityName,
        recordId,
        current.unresolvedSyncRecordKeys,
      ))) continue;
      if (recurringRuleParentIssue(next.data, rule)) {
        next = putRecord(next, 'recurringRules', {
          ...rule,
          ...changedRecordMeta(rule),
          isActive: false,
        });
        changed = true;
        continue;
      }
      const result = catchUpRecurringTransactions(rule, calendarDay, next.data.transactions);
      for (const transaction of result.transactions) {
        next = putRecord(next, 'transactions', transaction);
        changed = true;
      }
      if (result.nextOccurrenceDate !== rule.nextOccurrenceDate) {
        next = putRecord(next, 'recurringRules', {
          ...rule,
          ...changedRecordMeta(rule),
          nextOccurrenceDate: result.nextOccurrenceDate,
        });
        changed = true;
      }
    }
    return changed ? next : current;
  });
}

export function materializeRecurringTransactionsUnlessSyncing(
  state: PersistedFinanceState,
  calendarDay: string,
  recovery: LocalStateRecovery | undefined,
  syncInProgress: () => boolean,
): PersistedFinanceState {
  if (syncInProgress()) return state;
  return materializeRecurringTransactionsUnlessRecovering(state, calendarDay, recovery);
}

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function useFinanceApp(): FinanceAppController {
  const [initialLoad] = useState(() => loadFinanceStateWithRecovery('guest'));
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(supabaseConfigured);
  const [state, setState] = useState(initialLoad.state);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [guestPromptDismissed, setGuestPromptDismissed] = useState(false);
  const [storageError, setStorageError] = useState<string>();
  const [storageRecovery, setStorageRecovery] = useState<LocalStateRecovery | undefined>(initialLoad.recovery);
  const [guestImportNotice, setGuestImportNotice] = useState<string>();
  const [legacyBootstrapNotice, setLegacyBootstrapNotice] = useState<string>();
  const [safetyNotice, setSafetyNotice] = useState<string>();
  const [calendarDay, setCalendarDay] = useState(() => localDateString());
  const stateRef = useRef(state);
  const activeOwnerRef = useRef(state.ownerId);
  const storageRecoveryRef = useRef<LocalStateRecovery | undefined>(initialLoad.recovery);
  const ownerGenerationRef = useRef(0);
  const syncTokenRef = useRef<{ generation: number; ownerId: string; id: symbol } | null>(null);
  const renderedOwnerId = state.ownerId;
  const renderedOwnerGeneration = ownerGenerationRef.current;

  const assertRenderedOwnerContext = useCallback(() => {
    assertCurrentOwnerContext(
      { ownerId: renderedOwnerId, generation: renderedOwnerGeneration },
      activeOwnerRef.current,
      stateRef.current.ownerId,
      ownerGenerationRef.current,
    );
  }, [renderedOwnerGeneration, renderedOwnerId]);

  const commitState = useCallback((update: (current: PersistedFinanceState) => PersistedFinanceState) => {
    const next = advanceFinanceStateRef(stateRef, update);
    setState(next);
  }, []);

  const activateOwner = useCallback((nextOwnerId: string) => {
    if (activeOwnerRef.current === nextOwnerId && stateRef.current.ownerId === nextOwnerId) return;
    ownerGenerationRef.current += 1;
    activeOwnerRef.current = nextOwnerId;
    const loaded = loadFinanceStateWithRecovery(nextOwnerId);
    storageRecoveryRef.current = loaded.recovery;
    stateRef.current = loaded.state;
    setState(loaded.state);
    setStorageRecovery(loaded.recovery);
    setStorageError(loaded.recovery?.message);
    setSyncReport(null);
    setSyncBusy(false);
    setGuestPromptDismissed(false);
    setGuestImportNotice(undefined);
    setLegacyBootstrapNotice(undefined);
    setSafetyNotice(undefined);
  }, []);

  useEffect(() => {
    const refreshDay = () => setCalendarDay(localDateString());
    const timer = window.setInterval(refreshDay, 60_000);
    window.addEventListener('focus', refreshDay);
    document.addEventListener('visibilitychange', refreshDay);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshDay);
      document.removeEventListener('visibilitychange', refreshDay);
    };
  }, []);

  const recurrenceCursorKey = state.data.recurringRules
    .map((rule) => `${rule.id}:${rule.version}:${rule.isActive}:${rule.nextOccurrenceDate}:${rule.deletedAt ?? ''}`)
    .join('|');

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      activateOwner(data.session?.user.id ?? 'guest');
      setUser(data.session?.user ?? null);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      activateOwner(session?.user.id ?? 'guest');
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [activateOwner]);

  useEffect(() => {
    if (!canAutoSaveFinanceState(state, activeOwnerRef.current, storageRecovery)) {
      if (state.ownerId !== activeOwnerRef.current) return;
      if (storageRecovery) {
        setStorageError(`${storageRecovery.message}。原始內容仍保留，修復前已停止自動覆寫。`);
      }
      return;
    }
    try {
      saveFinanceState(state);
      setStorageError(undefined);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }, [state, storageRecovery]);

  const syncNow = useCallback(async () => {
    if (!supabase) return;
    const started = stateRef.current;
    const generation = ownerGenerationRef.current;
    const ownerId = activeOwnerRef.current;
    if (started.ownerId === 'guest' || started.ownerId !== ownerId) return;
    if (syncTokenRef.current?.generation === generation) return;
    const token = { generation, ownerId, id: Symbol('sync') };
    syncTokenRef.current = token;
    setSyncBusy(true);
    try {
      const result = await syncFinanceStateUnlessRecovering(
        started,
        ownerId,
        storageRecoveryRef.current,
        () => createSupabaseRemoteAdapter(supabase),
      );
      if (!result) return;
      if (ownerGenerationRef.current !== generation || activeOwnerRef.current !== ownerId) return;
      commitState((current) => {
        const merged = applySyncCompletion(started, current, result.state, ownerId);
        // A durable legacy decision made while this sync was in flight wins
        // over bootstrap metadata captured by the older response.
        if (started.legacyBootstrap && !current.legacyBootstrap) {
          return {
            ...merged,
            migratedFromLegacy: undefined,
            legacyBootstrap: undefined,
          };
        }
        return merged;
      });
      setSyncReport(result.report);
    } finally {
      if (syncTokenRef.current === token) {
        syncTokenRef.current = null;
        setSyncBusy(false);
      }
    }
  }, [commitState]);

  useEffect(() => {
    if (state.ownerId === 'guest' || authLoading) return;
    void syncNow();
    const onOnline = () => { void syncNow(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // A first pull is required after every owner switch. Retries thereafter use the online/manual triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ownerId, authLoading]);

  const outboxKey = state.outbox.map((operation) => operation.id).join('|');
  useEffect(() => {
    if (state.ownerId === 'guest' || !navigator.onLine || outboxKey.length === 0) return;
    const timer = window.setTimeout(() => { void syncNow(); }, 350);
    return () => window.clearTimeout(timer);
    // Attempts do not change this key, so a persistent failure waits for reconnect/manual retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ownerId, outboxKey]);

  const put = useCallback(<E extends FinanceEntityName>(
    entity: E,
    record: FinanceData[E][number],
  ) => {
    try {
      assertRenderedOwnerContext();
    } catch (error) {
      setSafetyNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
    if (stateRef.current.legacyBootstrap?.status === 'pending') {
      setLegacyBootstrapNotice('舊版本機資料尚在先讀取雲端；完成前已停止所有帳本修改。');
      return false;
    }
    if (stateRef.current.initialBootstrap) {
      setSafetyNotice('正在先讀取雲端帳本；完成前本次修改未執行。');
      return false;
    }
    if (storageRecoveryRef.current) {
      setSafetyNotice('本機快照仍在復原保護中；完成有效備份還原前，本次帳本修改未執行。');
      return false;
    }
    try {
      assertFinanceMutationNotSyncing(syncTokenRef.current !== null);
      assertSyncRecordMutationsAllowed(
        stateRef.current,
        syncMutationTargets(stateRef.current, entity, record),
      );
      if (entity === 'categories') {
        assertCategoryUpsert(stateRef.current.data, record as Category);
      }
      commitState((current) => applyFinanceMutationUnlessRecovering(
        current,
        storageRecoveryRef.current,
        (recoverable) => entity === 'categories'
          ? putCategoryWithDependents(recoverable, record as Category)
          : entity === 'accounts'
            ? putAccountWithDependents(recoverable, record as AssetAccount)
            : putRecord(recoverable, entity, record),
      ));
      return true;
    } catch (error) {
      setSafetyNotice(`資料未儲存：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [assertRenderedOwnerContext, commitState]);

  const categoryLifecycle = useCallback((record: Category, action: CategoryAction) => {
    try {
      assertRenderedOwnerContext();
      assertFinanceMutationNotSyncing(syncTokenRef.current !== null);
      if (stateRef.current.legacyBootstrap?.status === 'pending') {
        throw new Error('舊版本機資料尚在先讀取雲端；完成前已停止所有帳本修改。');
      }
      if (stateRef.current.initialBootstrap) {
        throw new Error('正在先讀取雲端帳本；完成前本次修改未執行。');
      }
      if (storageRecoveryRef.current) {
        throw new Error('本機快照仍在復原保護中；完成有效備份還原前，本次帳本修改未執行。');
      }
      const targets = [
        { entity: 'categories' as const, recordId: record.id },
        ...(action === 'archive'
          ? stateRef.current.data.recurringRules
            .filter((rule) => !rule.deletedAt && rule.isActive && rule.categoryId === record.id)
            .map((rule) => ({ entity: 'recurringRules' as const, recordId: rule.id }))
          : []),
      ];
      assertSyncRecordMutationsAllowed(stateRef.current, targets);
      commitState((current) => applyCategoryLifecycleMutation(current, record.id, action));
      return true;
    } catch (error) {
      setSafetyNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [assertRenderedOwnerContext, commitState]);

  const archiveAccount = useCallback((record: AssetAccount) => {
    try {
      assertRenderedOwnerContext();
      assertFinanceMutationNotSyncing(syncTokenRef.current !== null);
      const current = stateRef.current;
      if (current.legacyBootstrap?.status === 'pending' || current.initialBootstrap) {
        throw new Error('雲端帳本尚在安全讀取；完成前本次封存未執行。');
      }
      if (storageRecoveryRef.current) {
        throw new Error('本機快照仍在復原保護中；本次封存未執行。');
      }
      const targets = [
        { entity: 'accounts' as const, recordId: record.id },
        ...current.data.recurringRules
          .filter((rule) => !rule.deletedAt && rule.isActive && rule.accountId === record.id)
          .map((rule) => ({ entity: 'recurringRules' as const, recordId: rule.id })),
      ];
      assertSyncRecordMutationsAllowed(current, targets);
      commitState((latest) => {
        assertSyncRecordMutationsAllowed(latest, targets);
        return applyAccountArchiveMutation(latest, record.id);
      });
      return true;
    } catch (error) {
      setSafetyNotice(`帳戶未封存：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [assertRenderedOwnerContext, commitState]);

  const releaseGoalAllocationRecords = useCallback((goal: SavingsGoal) => {
    try {
      assertRenderedOwnerContext();
      assertFinanceMutationNotSyncing(syncTokenRef.current !== null);
      const current = stateRef.current;
      if (current.legacyBootstrap?.status === 'pending' || current.initialBootstrap) {
        throw new Error('雲端帳本尚在安全讀取；完成前本次釋放未執行。');
      }
      if (storageRecoveryRef.current) {
        throw new Error('本機快照仍在復原保護中；本次釋放未執行。');
      }
      const targets = [
        { entity: 'goals' as const, recordId: goal.id },
        ...current.data.allocations
          .filter((allocation) => !allocation.deletedAt && allocation.goalId === goal.id)
          .map((allocation) => ({ entity: 'allocations' as const, recordId: allocation.id })),
      ];
      assertSyncRecordMutationsAllowed(current, targets);
      commitState((latest) => {
        assertSyncRecordMutationsAllowed(latest, targets);
        return applyGoalAllocationReleaseMutation(latest, goal.id);
      });
      return true;
    } catch (error) {
      setSafetyNotice(`目標配置未釋放：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [assertRenderedOwnerContext, commitState]);

  const softDelete = useCallback(<E extends FinanceEntityName>(
    entity: E,
    record: FinanceData[E][number],
  ) => {
    try {
      assertRenderedOwnerContext();
    } catch (error) {
      setSafetyNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
    if (stateRef.current.legacyBootstrap?.status === 'pending') {
      setLegacyBootstrapNotice('舊版本機資料尚在先讀取雲端；完成前已停止所有帳本修改。');
      return false;
    }
    if (stateRef.current.initialBootstrap) {
      setSafetyNotice('正在先讀取雲端帳本；完成前本次刪除未執行。');
      return false;
    }
    if (storageRecoveryRef.current) {
      setSafetyNotice('本機快照仍在復原保護中；完成有效備份還原前，本次刪除未執行。');
      return false;
    }
    try {
      assertFinanceMutationNotSyncing(syncTokenRef.current !== null);
      assertSyncRecordMutationsAllowed(
        stateRef.current,
        syncMutationTargets(stateRef.current, entity, record),
      );
      commitState((current) => applyFinanceMutationUnlessRecovering(
        current,
        storageRecoveryRef.current,
        (recoverable) => {
          const currentRecord = (recoverable.data[entity] as FinanceData[E][number][])
            .find((candidate) => candidate.id === record.id);
          if (!currentRecord || currentRecord.deletedAt) {
            throw new Error('找不到可刪除的最新資料，本次刪除未執行。');
          }
          assertSyncRecordMutationsAllowed(
            recoverable,
            syncMutationTargets(recoverable, entity, currentRecord),
          );
          const deleted = {
            ...currentRecord,
            ...tombstoneRecordMeta(currentRecord as SyncRecord),
            ...('isActive' in currentRecord ? { isActive: false } : {}),
          } as FinanceData[E][number];
          return putRecord(recoverable, entity, deleted);
        },
      ));
      return true;
    } catch (error) {
      setSafetyNotice(`資料未刪除：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [assertRenderedOwnerContext, commitState]);

  const setData = useCallback((data: FinanceData) => {
    try {
      assertRenderedOwnerContext();
      assertFinanceMutationNotSyncing(syncTokenRef.current !== null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSafetyNotice(message);
      throw error;
    }
    if (stateRef.current.legacyBootstrap) {
      setLegacyBootstrapNotice('請先對舊版候選資料選擇「匯入候選」或「保留雲端」，本次一般備份還原未執行。');
    }
    if (stateRef.current.initialBootstrap) {
      setSafetyNotice('正在先讀取雲端帳本；完成前本次一般備份還原未執行。');
    }
    const restored = restoreFinanceStateUnlessLegacyBootstrap(
      stateRef.current,
      data,
      saveFinanceState,
      () => clearSuccessfulRecoveryUiState(
        storageRecoveryRef,
        setStorageRecovery,
        setSafetyNotice,
      ),
      storageRecoveryRef.current !== undefined,
    );
    commitState(() => restored);
  }, [assertRenderedOwnerContext, commitState]);

  const acceptRemoteConflict = useCallback(async (
    entity: FinanceEntityName,
    recordId: string,
  ): Promise<boolean> => {
    let resolutionToken: { generation: number; ownerId: string; id: symbol } | undefined;
    try {
      assertRenderedOwnerContext();
      if (!supabase || stateRef.current.ownerId === 'guest') {
        throw new Error('目前沒有可用的雲端帳本。');
      }
      if (syncTokenRef.current) throw new Error('同步進行中，請稍後再選擇雲端版本。');
      const startedOwnerId = stateRef.current.ownerId;
      const generation = ownerGenerationRef.current;
      resolutionToken = { generation, ownerId: startedOwnerId, id: Symbol('resolve-sync-conflict') };
      syncTokenRef.current = resolutionToken;
      setSyncBusy(true);
      const response = await createSupabaseRemoteAdapter(supabase).pull(startedOwnerId);
      const pull = 'records' in response
        ? response
        : { records: [...response], issues: [] };
      const broadIssue = pull.issues.find((candidate) => candidate.recordId === undefined);
      if (broadIssue) throw new Error(broadIssue.message);
      const requestedOperation = stateRef.current.outbox.find((operation) => (
        operation.entity === entity && operation.recordId === recordId
      ));
      const directResolutionOperation = requestedOperation?.batchId
        ? stateRef.current.outbox.find((operation) => (
            operation.batchId === requestedOperation.batchId
            && stateRef.current.unresolvedSyncRecordKeys?.includes(
              syncRecordKey(operation.entity, operation.recordId),
            )
          ))
        : undefined;
      const resolutionEntity = directResolutionOperation?.entity ?? entity;
      const resolutionRecordId = directResolutionOperation?.recordId ?? recordId;
      const remoteRecord = pull.records.find((candidate) => (
        candidate.entity === resolutionEntity && candidate.record.id === resolutionRecordId
      ));
      if (!remoteRecord) throw new Error('雲端回應中找不到這筆資料，衝突未解除。');
      const resolutionBatchId = directResolutionOperation?.batchId ?? requestedOperation?.batchId;
      const batchIssue = resolutionBatchId
        ? pull.issues.find((candidate) => stateRef.current.outbox.some((operation) => (
            operation.batchId === resolutionBatchId
            && operation.entity === candidate.entity
            && operation.recordId === candidate.recordId
          )))
        : undefined;
      if (batchIssue) throw new Error(batchIssue.message);
      const recordIssue = pull.issues.find((candidate) => (
        candidate.entity === remoteRecord.entity && candidate.recordId === remoteRecord.record.id
      ));
      if (recordIssue) throw new Error(recordIssue.message);
      if (ownerGenerationRef.current !== generation || activeOwnerRef.current !== startedOwnerId) {
        throw new Error('帳戶已切換，衝突未解除。');
      }
      commitState((current) => acceptRemoteConflictRecord(
        current,
        remoteRecord,
        pull.records,
      ));
      setSafetyNotice(undefined);
      setSyncReport(null);
      return true;
    } catch (error) {
      setSafetyNotice(`同步衝突未解除：${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      if (resolutionToken && syncTokenRef.current === resolutionToken) {
        syncTokenRef.current = null;
        setSyncBusy(false);
      }
    }
  }, [assertRenderedOwnerContext, commitState]);

  useEffect(() => {
    if (storageRecovery
      || syncBusy
      || syncTokenRef.current !== null
      || state.legacyBootstrap?.status === 'pending'
      || state.initialBootstrap) return;
    commitState((current) => {
      if (syncTokenRef.current !== null) return current;
      return materializeRecurringTransactionsUnlessSyncing(
        current,
        calendarDay,
        storageRecoveryRef.current,
        () => syncTokenRef.current !== null,
      );
    });
  }, [state.ownerId, state.legacyBootstrap?.status, state.initialBootstrap?.status, recurrenceCursorKey, calendarDay, commitState, storageRecovery, syncBusy]);

  const guestLoad = useMemo(() => loadFinanceStateWithRecovery('guest'), [state.ownerId, state.data.transactions.length]);
  const guestFingerprint = guestSnapshotFingerprint(guestLoad.state.data);
  const guestDecisionKey = state.ownerId === 'guest'
    ? undefined
    : `shiba-finance:v3:guest-decision:${state.ownerId}`;
  let rememberedGuestFingerprint: string | null = null;
  if (guestDecisionKey) {
    try { rememberedGuestFingerprint = localStorage.getItem(guestDecisionKey); } catch { /* surfaced when persisting */ }
  }
  const hasSeparateGuestData = state.ownerId !== 'guest'
    && !guestPromptDismissed
    && !guestLoad.recovery
    && !storageRecovery
    && !state.legacyBootstrap
    && !state.initialBootstrap
    && rememberedGuestFingerprint !== guestFingerprint
    && hasUserContent(guestLoad.state.data);

  const rememberGuestDecision = useCallback((key: string | undefined, fingerprint: string) => {
    if (!key) return;
    try {
      localStorage.setItem(key, fingerprint);
      setGuestPromptDismissed(true);
    } catch (error) {
      setStorageError(`無法記住訪客資料決策：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const importGuestData = useCallback(() => {
    try {
      assertRenderedOwnerContext();
    } catch (error) {
      setSafetyNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    if (stateRef.current.ownerId === 'guest') return;
    setGuestImportNotice(undefined);
    if (syncTokenRef.current) {
      setGuestImportNotice('同步正在比對雲端版本；完成前不會匯入訪客資料。');
      return;
    }
    if (stateRef.current.legacyBootstrap) {
      setGuestImportNotice('請先完成舊版帳本候選資料的匯入或保留雲端決定，再處理訪客資料。');
      return;
    }
    if (stateRef.current.initialBootstrap) {
      setGuestImportNotice('正在先讀取雲端帳本；完成前不會匯入訪客資料。');
      return;
    }
    if (storageRecovery) {
      setGuestImportNotice('目前帳號的本機快照仍在復原保護中；為避免覆寫可救援原始資料，請先完成備份還原或明確重設，再匯入訪客資料。');
      return;
    }
    const loadedGuest = loadFinanceStateWithRecovery('guest');
    if (loadedGuest.recovery) {
      setStorageError('訪客資料快照無法驗證，因此未匯入；原始內容仍保持不變。');
      return;
    }
    const imported = remapOwner(loadedGuest.state.data, stateRef.current.ownerId);
    const plan = planGuestImport(stateRef.current, imported);
    if (plan.conflicts.length > 0) {
      setGuestImportNotice(`訪客匯入已中止：${plan.conflicts.length} 筆同來源資料在兩邊內容不同，本次未修改任何帳號資料，也未把此快照標記為已處理。請先下載兩邊 JSON 備份，再選擇保持分離或以備份還原流程明確合併。`);
      return;
    }
    if (!guestDecisionKey) return;
    let persistence;
    try {
      persistence = persistGuestImportState(
        plan.state,
        guestDecisionKey,
        guestFingerprint,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStorageError(`訪客資料匯入無法安全寫入：${message}`);
      setGuestImportNotice('訪客匯入已中止：帳號快照未能持久化，因此目前資料未變更，且此訪客快照未標記為已處理。');
      return;
    }
    commitState(() => plan.state);
    if (persistence.decisionRemembered) {
      setGuestPromptDismissed(true);
      setGuestImportNotice(`訪客資料匯入完成：新增 ${plan.addedCount} 筆，略過 ${plan.skippedCount} 筆內容相同的既有資料。`);
    } else {
      setStorageError(`訪客資料已匯入，但無法記住匯入決策：${persistence.decisionError}`);
      setGuestImportNotice(`訪客資料已安全匯入：新增 ${plan.addedCount} 筆，略過 ${plan.skippedCount} 筆；但瀏覽器未能記住此決策，下次可能再次提示。`);
    }
  }, [assertRenderedOwnerContext, commitState, guestDecisionKey, guestFingerprint, storageRecovery]);

  const decideLegacyBootstrap = useCallback((decision: LegacyBootstrapDecision) => {
    setLegacyBootstrapNotice(undefined);
    try {
      assertRenderedOwnerContext();
    } catch (error) {
      setSafetyNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    if (storageRecoveryRef.current) {
      setLegacyBootstrapNotice('目前帳號快照仍在復原保護中；未修復前不會處理舊版候選資料。');
      return;
    }
    try {
      const next = resolveLegacyBootstrapState(
        stateRef.current,
        decision,
        saveFinanceState,
        () => {
          storageRecoveryRef.current = undefined;
          setStorageRecovery(undefined);
        },
      );
      commitState(() => next);
      setStorageError(undefined);
      setLegacyBootstrapNotice(decision === 'import-candidate'
        ? '舊版候選資料已明確匯入，並已建立可重試的待同步作業。'
        : '已保留目前雲端帳本；舊版候選資料不會上傳。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStorageError(`無法安全完成舊版資料決定：${message}`);
      setLegacyBootstrapNotice('本次決定未生效；候選資料與現有帳本都保持不變。');
    }
  }, [assertRenderedOwnerContext, commitState]);

  const importLegacyCandidate = useCallback(() => {
    decideLegacyBootstrap('import-candidate');
  }, [decideLegacyBootstrap]);

  const keepCloudData = useCallback(() => {
    decideLegacyBootstrap('keep-cloud');
  }, [decideLegacyBootstrap]);

  const dismissGuestImport = useCallback(() => {
    rememberGuestDecision(guestDecisionKey, guestFingerprint);
  }, [guestDecisionKey, guestFingerprint, rememberGuestDecision]);

  const signIn = useCallback(async () => {
    if (!supabase) throw new Error('尚未設定 Supabase');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }, []);

  const exposedState = state.ownerId === activeOwnerRef.current ? state : stateRef.current;
  const unresolvedSyncRecordKeys = useMemo(() => unresolvedPayloadConflictKeys(
    exposedState.outbox,
    syncReport?.conflicts,
    exposedState.unresolvedSyncRecordKeys,
  ), [exposedState.outbox, exposedState.unresolvedSyncRecordKeys, syncReport]);
  const conflictResolutionImpact = useMemo(() => {
    const result = new Map<string, number>();
    for (const key of unresolvedSyncRecordKeys) {
      const operation = exposedState.outbox.find((candidate) => (
        syncRecordKey(candidate.entity, candidate.recordId) === key
      ));
      result.set(key, operation?.batchId
        ? exposedState.outbox.filter((candidate) => candidate.batchId === operation.batchId).length
        : 1);
    }
    return result;
  }, [exposedState.outbox, unresolvedSyncRecordKeys]);
  const mutationLockedRecordKeys = useMemo(() => {
    const keys = new Set(unresolvedSyncRecordKeys);
    const pendingBatchIds = new Set(exposedState.outbox.flatMap((operation) => (
      operation.batchId ? [operation.batchId] : []
    )));
    for (const operation of exposedState.outbox) {
      if (operation.batchId && pendingBatchIds.has(operation.batchId)) {
        keys.add(syncRecordKey(operation.entity, operation.recordId));
      }
    }
    return keys;
  }, [exposedState.outbox, unresolvedSyncRecordKeys]);

  return {
    state: exposedState,
    user,
    authLoading,
    cloudEnabled: supabaseConfigured,
    syncBusy,
    syncReport,
    unresolvedSyncRecordKeys,
    mutationLockedRecordKeys,
    conflictResolutionImpact,
    storageError,
    storageRecovery,
    guestImportNotice,
    legacyBootstrapNotice,
    safetyNotice,
    hasSeparateGuestData,
    dismissGuestImport,
    importGuestData,
    importLegacyCandidate,
    keepCloudData,
    setData,
    put,
    categoryLifecycle,
    archiveAccount,
    releaseGoalAllocations: releaseGoalAllocationRecords,
    softDelete,
    acceptRemoteConflict,
    syncNow,
    signIn,
    signOut,
  };
}
