export type OwnerId = 'guest' | string;

export interface IconRef {
  type: 'emoji' | 'vector';
  value: string;
}

export interface SyncRecord {
  id: string;
  ownerId: OwnerId;
  version: number;
  updatedAt: string;
  lastOperationId: string;
  deletedAt?: string;
}

export interface AssetAccount extends SyncRecord {
  name: string;
  icon: IconRef;
  openingBalance: number;
  includeInTotalAssets: boolean;
  isActive: boolean;
  sortOrder: number;
  legacyKey?: string;
  requiresReview?: boolean;
}

export interface Category extends SyncRecord {
  kind: 'income' | 'expense';
  name: string;
  icon: IconRef;
  isActive: boolean;
  sortOrder: number;
  legacyKey?: string;
}

export interface Transaction extends SyncRecord {
  amount: number;
  type: 'income' | 'expense';
  categoryId: string;
  categoryName: string;
  accountId: string;
  accountName: string;
  occurredAt: string;
  note?: string;
  recurringRuleId?: string;
  occurrenceDate?: string;
}

export interface BalanceAdjustment extends SyncRecord {
  accountId: string;
  amountDelta: number;
  occurredAt: string;
  reason?: string;
}

export interface SavingsGoal extends SyncRecord {
  name: string;
  targetAmount: number;
  targetDate?: string;
  isActive: boolean;
  /** Preserved only when a legacy goal used a display unit other than TWD. */
  legacyUnit?: string;
}

export interface SavingsAllocation extends SyncRecord {
  goalId: string;
  amountDelta: number;
  occurredAt: string;
  note?: string;
}

export interface Budget extends SyncRecord {
  scope: 'overall' | 'category';
  categoryId?: string;
  categoryName?: string;
  period: 'weekly' | 'monthly';
  amount: number;
  isActive: boolean;
}

export interface RecurringRule extends SyncRecord {
  name: string;
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  categoryName: string;
  accountId: string;
  accountName: string;
  frequency: 'weekly' | 'monthly' | 'yearly';
  startDate: string;
  /** Original day-of-month anchor so a 31st rule can recover after short months. */
  anchorDay?: number;
  nextOccurrenceDate: string;
  isActive: boolean;
  note?: string;
}

export interface FinanceSettings {
  currency: 'TWD';
  locale: 'zh-TW';
  activeGoalId?: string;
}

export interface FinanceData {
  accounts: AssetAccount[];
  categories: Category[];
  transactions: Transaction[];
  adjustments: BalanceAdjustment[];
  goals: SavingsGoal[];
  allocations: SavingsAllocation[];
  budgets: Budget[];
  recurringRules: RecurringRule[];
  settings: FinanceSettings;
}

export type FinanceEntityName = Exclude<keyof FinanceData, 'settings'>;

/**
 * An authenticated v2 localStorage snapshot is only a cache, not a durable
 * mutation log. Keep its validated graph available for explicit review while
 * the active v3 graph performs a remote-authoritative first pull.
 */
export interface LegacyAuthenticatedBootstrap {
  status: 'pending' | 'ready';
  candidate: FinanceData;
  /** Legacy transactions whose last acknowledged UI state was `synced:false`. */
  unsyncedTransactionIds: string[];
}

export interface PendingOperation {
  id: string;
  entity: FinanceEntityName;
  recordId: string;
  record: FinanceData[FinanceEntityName][number];
  attempts: number;
  queuedAt: string;
  lastError?: string;
}

export interface PersistedFinanceState {
  schemaVersion: 3;
  ownerId: OwnerId;
  data: FinanceData;
  outbox: PendingOperation[];
  lastSyncedAt?: string;
  lastSyncError?: string;
  migratedFromLegacy?: boolean;
  legacyBootstrap?: LegacyAuthenticatedBootstrap;
}
