import type { FinanceData, PersistedFinanceState } from '../domain/model';
import {
  syncFinanceState,
  type RemoteAdapter,
  type SyncResult,
} from '../domain/syncEngine';
import { applyRestoredData, type LocalStateRecovery } from './state';

/**
 * Validate, build, and durably persist the restored snapshot before recovery
 * protection is cleared. If any step fails, `clearRecovery` is never run and
 * remote synchronization therefore remains fail-closed.
 */
export function restoreFinanceStateAndClearRecovery(
  state: PersistedFinanceState,
  restoredData: FinanceData,
  persist: (restored: PersistedFinanceState) => void,
  clearRecovery: () => void,
): PersistedFinanceState {
  const restoreBase = state.initialBootstrap === undefined ? state : {
    ...state,
    data: {
      accounts: [],
      categories: [],
      transactions: [],
      adjustments: [],
      goals: [],
      allocations: [],
      budgets: [],
      recurringRules: [],
      settings: structuredClone(state.data.settings),
    },
    outbox: [],
    initialBootstrap: undefined,
  };
  const restored = applyRestoredData(restoreBase, restoredData);
  persist(restored);
  clearRecovery();
  return restored;
}

/**
 * Keep recovery protection fail-closed across every sync trigger. The remote
 * factory is deliberately lazy so a damaged owner snapshot cannot even create
 * a Supabase adapter before the user restores a valid backup.
 */
export async function syncFinanceStateUnlessRecovering(
  state: PersistedFinanceState,
  authenticatedOwnerId: string,
  recovery: LocalStateRecovery | undefined,
  createRemote: () => RemoteAdapter,
): Promise<SyncResult | undefined> {
  if (recovery
    || state.ownerId === 'guest'
    || state.ownerId !== authenticatedOwnerId) {
    return undefined;
  }

  return syncFinanceState(state, authenticatedOwnerId, createRemote());
}
