import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabaseClient';
import type {
  FinanceData,
  FinanceEntityName,
  PersistedFinanceState,
  SyncRecord,
} from '../domain/model';
import { catchUpRecurringTransactions } from '../domain/recurrence';
import { syncFinanceState, type SyncReport } from '../domain/syncEngine';
import { createSupabaseRemoteAdapter } from '../data/supabaseRemote';
import {
  applySyncCompletion,
  applyRestoredData,
  canAutoSaveFinanceState,
  changedRecordMeta,
  guestSnapshotFingerprint,
  hasUserContent,
  loadFinanceStateWithRecovery,
  persistGuestImportState,
  planGuestImport,
  type LocalStateRecovery,
  putRecord,
  remapOwner,
  saveFinanceState,
} from './state';

export interface FinanceAppController {
  state: PersistedFinanceState;
  user: User | null;
  authLoading: boolean;
  cloudEnabled: boolean;
  syncBusy: boolean;
  syncReport: SyncReport | null;
  storageError?: string;
  storageRecovery?: LocalStateRecovery;
  guestImportNotice?: string;
  hasSeparateGuestData: boolean;
  dismissGuestImport(): void;
  importGuestData(): void;
  setData(data: FinanceData): void;
  put<E extends FinanceEntityName>(entity: E, record: FinanceData[E][number]): void;
  softDelete<E extends FinanceEntityName>(entity: E, record: FinanceData[E][number]): void;
  syncNow(): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
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
  const [calendarDay, setCalendarDay] = useState(() => localDateString());
  const stateRef = useRef(state);
  const activeOwnerRef = useRef(state.ownerId);
  const ownerGenerationRef = useRef(0);
  const syncTokenRef = useRef<{ generation: number; ownerId: string; id: symbol } | null>(null);

  useEffect(() => { stateRef.current = state; }, [state]);

  const commitState = useCallback((update: (current: PersistedFinanceState) => PersistedFinanceState) => {
    setState((current) => {
      const next = update(current);
      stateRef.current = next;
      return next;
    });
  }, []);

  const activateOwner = useCallback((nextOwnerId: string) => {
    if (activeOwnerRef.current === nextOwnerId && stateRef.current.ownerId === nextOwnerId) return;
    ownerGenerationRef.current += 1;
    activeOwnerRef.current = nextOwnerId;
    const loaded = loadFinanceStateWithRecovery(nextOwnerId);
    stateRef.current = loaded.state;
    setState(loaded.state);
    setStorageRecovery(loaded.recovery);
    setStorageError(loaded.recovery?.message);
    setSyncReport(null);
    setSyncBusy(false);
    setGuestPromptDismissed(false);
    setGuestImportNotice(undefined);
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
      const remote = createSupabaseRemoteAdapter(supabase);
      const result = await syncFinanceState(started, ownerId, remote);
      if (ownerGenerationRef.current !== generation || activeOwnerRef.current !== ownerId) return;
      commitState((current) => applySyncCompletion(started, current, result.state, ownerId));
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
    commitState((current) => putRecord(current, entity, record));
  }, [commitState]);

  const softDelete = useCallback(<E extends FinanceEntityName>(
    entity: E,
    record: FinanceData[E][number],
  ) => {
    const deleted = {
      ...record,
      ...changedRecordMeta(record as SyncRecord),
      deletedAt: new Date().toISOString(),
      ...('isActive' in record ? { isActive: false } : {}),
    } as FinanceData[E][number];
    commitState((current) => putRecord(current, entity, deleted));
  }, [commitState]);

  const setData = useCallback((data: FinanceData) => {
    setStorageRecovery(undefined);
    commitState((current) => applyRestoredData(current, data));
  }, [commitState]);

  useEffect(() => {
    commitState((current) => {
      let next = current;
      let changed = false;
      for (const rule of current.data.recurringRules.filter((item) => !item.deletedAt && item.isActive)) {
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
  }, [state.ownerId, recurrenceCursorKey, calendarDay, commitState]);

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
    if (stateRef.current.ownerId === 'guest') return;
    setGuestImportNotice(undefined);
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
  }, [commitState, guestDecisionKey, guestFingerprint, storageRecovery]);

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

  return {
    state: exposedState,
    user,
    authLoading,
    cloudEnabled: supabaseConfigured,
    syncBusy,
    syncReport,
    storageError,
    storageRecovery,
    guestImportNotice,
    hasSeparateGuestData,
    dismissGuestImport,
    importGuestData,
    setData,
    put,
    softDelete,
    syncNow,
    signIn,
    signOut,
  };
}
