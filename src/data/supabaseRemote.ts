import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AssetAccount,
  BalanceAdjustment,
  Budget,
  Category,
  FinanceEntityName,
  PendingOperation,
  RecurringRule,
  SavingsAllocation,
  SavingsGoal,
  SyncRecord,
  Transaction,
} from '../domain/model';
import type {
  RemoteAdapter,
  RemotePullIssue,
  RemotePullResult,
  RemoteRecord,
  SyncEntityRecord,
} from '../domain/syncEngine';

type DatabaseRow = Record<string, unknown>;

const PAGE_SIZE = 500;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/;

const TABLE_BY_ENTITY: Record<FinanceEntityName, string> = {
  accounts: 'accounts',
  categories: 'categories',
  transactions: 'transactions',
  adjustments: 'adjustments',
  goals: 'goals',
  allocations: 'savings_allocations',
  budgets: 'budgets',
  recurringRules: 'recurring_rules',
};

const ENTITY_NAMES = Object.keys(TABLE_BY_ENTITY) as FinanceEntityName[];

interface SupabaseErrorDiagnostic {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  constraint?: string;
}

function errorText(error: SupabaseErrorDiagnostic | null, context: string): string {
  const details = [error?.code, error?.message].filter(Boolean).join(': ');
  return details ? `${context}: ${details}` : context;
}

function applyErrorText(
  error: SupabaseErrorDiagnostic | null,
  operation: PendingOperation,
): string {
  const constraintDiagnostics = [
    error?.constraint,
    error?.message,
    error?.details,
    error?.hint,
  ];
  if (
    operation.entity === 'allocations'
    && error?.code === '23514'
    && constraintDiagnostics.some((value) => (
      value?.includes('finance_v3_allocation_capacity')
      || value?.includes('new savings allocation exceeds available assets')
    ))
  ) {
    return '雲端可配置資產不足。請先釋放既有儲蓄配置或增加資產後再重試。';
  }
  return errorText(
    error,
    `Unable to apply ${operation.entity}/${operation.recordId} to Supabase`,
  );
}

function requiredString(row: DatabaseRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Supabase row is missing required text column ${column}`);
  }
  return value;
}

function optionalString(row: DatabaseRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Supabase row has invalid text column ${column}`);
  }
  return value;
}

function requiredNumber(row: DatabaseRow, column: string): number {
  const raw = row[column];
  if ((typeof raw !== 'number' && typeof raw !== 'string')
    || (typeof raw === 'string' && raw.trim() === '')) {
    throw new Error(`Supabase row has invalid numeric column ${column}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Supabase row has invalid numeric column ${column}`);
  }
  return value;
}

function requiredPositiveNumber(row: DatabaseRow, column: string): number {
  const value = requiredNumber(row, column);
  if (value <= 0) {
    throw new Error(`Supabase row requires positive numeric column ${column}`);
  }
  return value;
}

function requiredNonZeroNumber(row: DatabaseRow, column: string): number {
  const value = requiredNumber(row, column);
  if (value === 0) {
    throw new Error(`Supabase row requires non-zero numeric column ${column}`);
  }
  return value;
}

function requiredInteger(
  row: DatabaseRow,
  column: string,
  minimum?: number,
  maximum?: number,
): number {
  const value = requiredNumber(row, column);
  if (!Number.isInteger(value)
    || (minimum !== undefined && value < minimum)
    || (maximum !== undefined && value > maximum)) {
    throw new Error(`Supabase row has invalid integer column ${column}`);
  }
  return value;
}

function validateDateText(value: string, column: string, requireExplicitTimezone: boolean): string {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new Error(`Supabase row has invalid date column ${column}`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const maxDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (year < 1 || day < 1 || day > maxDay) {
    throw new Error(`Supabase row has invalid date column ${column}`);
  }
  if (hourText !== undefined
    && (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? 0) > 59)) {
    throw new Error(`Supabase row has invalid date column ${column}`);
  }
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) {
    throw new Error(`Supabase row has invalid date column ${column}`);
  }
  if (requireExplicitTimezone
    && (hourText === undefined || (!value.endsWith('Z') && match[8] === undefined))) {
    throw new Error(`Supabase row has invalid sync timestamp column ${column}`);
  }
  return value;
}

function requiredDate(row: DatabaseRow, column: string): string {
  return validateDateText(requiredString(row, column), column, false);
}

function optionalDate(row: DatabaseRow, column: string): string | undefined {
  const value = optionalString(row, column);
  return value === undefined ? undefined : validateDateText(value, column, false);
}

function requiredSyncTimestamp(row: DatabaseRow, column: string): string {
  return validateDateText(requiredString(row, column), column, true);
}

function optionalSyncTimestamp(row: DatabaseRow, column: string): string | undefined {
  const value = optionalString(row, column);
  return value === undefined ? undefined : validateDateText(value, column, true);
}

function requiredBoolean(row: DatabaseRow, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') {
    throw new Error(`Supabase row has invalid boolean column ${column}`);
  }
  return value;
}

function commonRecord(row: DatabaseRow): SyncRecord {
  const deletedAt = optionalSyncTimestamp(row, 'deleted_at');
  return {
    id: requiredString(row, 'id'),
    ownerId: requiredString(row, 'user_id'),
    version: requiredInteger(row, 'version', 1),
    updatedAt: requiredSyncTimestamp(row, 'updated_at'),
    lastOperationId: requiredString(row, 'last_operation_id'),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

function commonColumns(record: SyncRecord): DatabaseRow {
  return {
    id: record.id,
    user_id: record.ownerId,
    version: record.version,
    updated_at: record.updatedAt,
    last_operation_id: record.lastOperationId,
    deleted_at: record.deletedAt ?? null,
  };
}

function decodeAccount(row: DatabaseRow): AssetAccount {
  const iconType = requiredString(row, 'icon_type');
  const legacyKey = optionalString(row, 'legacy_key');
  if (iconType !== 'emoji' && iconType !== 'vector') {
    throw new Error(`Supabase account has unsupported icon_type ${iconType}`);
  }
  return {
    ...commonRecord(row),
    name: requiredString(row, 'name'),
    icon: { type: iconType, value: requiredString(row, 'icon_value') },
    openingBalance: requiredNumber(row, 'opening_balance'),
    includeInTotalAssets: requiredBoolean(row, 'include_in_total_assets'),
    isActive: requiredBoolean(row, 'is_active'),
    sortOrder: requiredInteger(row, 'sort_order'),
    ...(legacyKey === undefined ? {} : { legacyKey }),
    ...(row.requires_review === null || row.requires_review === undefined
      ? {}
      : { requiresReview: requiredBoolean(row, 'requires_review') }),
  };
}

function decodeCategory(row: DatabaseRow): Category {
  const kind = requiredString(row, 'kind');
  const iconType = requiredString(row, 'icon_type');
  if (kind !== 'income' && kind !== 'expense') {
    throw new Error(`Supabase category has unsupported kind ${kind}`);
  }
  if (iconType !== 'emoji' && iconType !== 'vector') {
    throw new Error(`Supabase category has unsupported icon_type ${iconType}`);
  }
  const legacyKey = optionalString(row, 'legacy_key');
  return {
    ...commonRecord(row),
    kind,
    name: requiredString(row, 'name'),
    icon: { type: iconType, value: requiredString(row, 'icon_value') },
    isActive: requiredBoolean(row, 'is_active'),
    sortOrder: requiredNumber(row, 'sort_order'),
    ...(legacyKey === undefined ? {} : { legacyKey }),
  };
}

function decodeTransaction(row: DatabaseRow): Transaction {
  const type = requiredString(row, 'type');
  if (type !== 'income' && type !== 'expense') {
    throw new Error(`Supabase transaction has unsupported type ${type}`);
  }
  const note = optionalString(row, 'note');
  const recurringRuleId = optionalString(row, 'recurring_rule_id');
  const occurrenceDate = optionalDate(row, 'occurrence_date');
  return {
    ...commonRecord(row),
    amount: requiredPositiveNumber(row, 'amount'),
    type,
    categoryId: requiredString(row, 'category_id'),
    categoryName: requiredString(row, 'category_name'),
    accountId: requiredString(row, 'account_id'),
    accountName: requiredString(row, 'account_name'),
    occurredAt: requiredDate(row, 'occurred_at'),
    ...(note === undefined ? {} : { note }),
    ...(recurringRuleId === undefined ? {} : { recurringRuleId }),
    ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
  };
}

function decodeAdjustment(row: DatabaseRow): BalanceAdjustment {
  const reason = optionalString(row, 'reason');
  return {
    ...commonRecord(row),
    accountId: requiredString(row, 'account_id'),
    amountDelta: requiredNonZeroNumber(row, 'amount_delta'),
    occurredAt: requiredDate(row, 'occurred_at'),
    ...(reason === undefined ? {} : { reason }),
  };
}

function decodeGoal(row: DatabaseRow): SavingsGoal {
  const targetDate = optionalDate(row, 'target_date');
  const legacyUnit = optionalString(row, 'legacy_unit');
  return {
    ...commonRecord(row),
    name: requiredString(row, 'name'),
    targetAmount: requiredPositiveNumber(row, 'target_amount'),
    ...(targetDate === undefined ? {} : { targetDate }),
    isActive: requiredBoolean(row, 'is_active'),
    ...(legacyUnit === undefined ? {} : { legacyUnit }),
  };
}

function decodeAllocation(row: DatabaseRow): SavingsAllocation {
  const note = optionalString(row, 'note');
  return {
    ...commonRecord(row),
    goalId: requiredString(row, 'goal_id'),
    amountDelta: requiredNonZeroNumber(row, 'amount_delta'),
    occurredAt: requiredDate(row, 'occurred_at'),
    ...(note === undefined ? {} : { note }),
  };
}

function decodeBudget(row: DatabaseRow): Budget {
  const scope = requiredString(row, 'scope');
  const period = requiredString(row, 'period');
  if (scope !== 'overall' && scope !== 'category') {
    throw new Error(`Supabase budget has unsupported scope ${scope}`);
  }
  if (period !== 'weekly' && period !== 'monthly') {
    throw new Error(`Supabase budget has unsupported period ${period}`);
  }
  const categoryId = optionalString(row, 'category_id');
  const categoryName = optionalString(row, 'category_name');
  if ((scope === 'overall' && (categoryId !== undefined || categoryName !== undefined))
    || (scope === 'category' && (categoryId === undefined || categoryName === undefined))) {
    throw new Error('Supabase budget has category columns inconsistent with scope');
  }
  return {
    ...commonRecord(row),
    scope,
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(categoryName === undefined ? {} : { categoryName }),
    period,
    amount: requiredPositiveNumber(row, 'amount'),
    isActive: requiredBoolean(row, 'is_active'),
  };
}

function decodeRecurringRule(row: DatabaseRow): RecurringRule {
  const type = requiredString(row, 'type');
  const frequency = requiredString(row, 'frequency');
  if (type !== 'income' && type !== 'expense') {
    throw new Error(`Supabase recurring rule has unsupported type ${type}`);
  }
  if (frequency !== 'weekly' && frequency !== 'monthly' && frequency !== 'yearly') {
    throw new Error(`Supabase recurring rule has unsupported frequency ${frequency}`);
  }
  const anchorDayValue = row.anchor_day;
  const anchorDay = anchorDayValue === null || anchorDayValue === undefined
    ? undefined
    : requiredInteger(row, 'anchor_day', 1, 31);
  const note = optionalString(row, 'note');
  return {
    ...commonRecord(row),
    name: requiredString(row, 'name'),
    type,
    amount: requiredPositiveNumber(row, 'amount'),
    categoryId: requiredString(row, 'category_id'),
    categoryName: requiredString(row, 'category_name'),
    accountId: requiredString(row, 'account_id'),
    accountName: requiredString(row, 'account_name'),
    frequency,
    startDate: requiredDate(row, 'start_date'),
    ...(anchorDay === undefined ? {} : { anchorDay }),
    nextOccurrenceDate: requiredDate(row, 'next_occurrence_date'),
    isActive: requiredBoolean(row, 'is_active'),
    ...(note === undefined ? {} : { note }),
  };
}

function decodeRemoteRecord(entity: FinanceEntityName, row: DatabaseRow): RemoteRecord {
  switch (entity) {
    case 'accounts': return { entity, record: decodeAccount(row) };
    case 'categories': return { entity, record: decodeCategory(row) };
    case 'transactions': return { entity, record: decodeTransaction(row) };
    case 'adjustments': return { entity, record: decodeAdjustment(row) };
    case 'goals': return { entity, record: decodeGoal(row) };
    case 'allocations': return { entity, record: decodeAllocation(row) };
    case 'budgets': return { entity, record: decodeBudget(row) };
    case 'recurringRules': return { entity, record: decodeRecurringRule(row) };
  }
}

function encodeRecord(entity: FinanceEntityName, record: SyncEntityRecord): DatabaseRow {
  const common = commonColumns(record);
  switch (entity) {
    case 'accounts': {
      const account = record as AssetAccount;
      return {
        ...common,
        name: account.name,
        icon_type: account.icon.type,
        icon_value: account.icon.value,
        opening_balance: account.openingBalance,
        include_in_total_assets: account.includeInTotalAssets,
        is_active: account.isActive,
        sort_order: account.sortOrder,
        legacy_key: account.legacyKey ?? null,
        requires_review: account.requiresReview ?? false,
      };
    }
    case 'categories': {
      const category = record as Category;
      return {
        ...common,
        kind: category.kind,
        name: category.name,
        icon_type: category.icon.type,
        icon_value: category.icon.value,
        is_active: category.isActive,
        sort_order: category.sortOrder,
        legacy_key: category.legacyKey ?? null,
      };
    }
    case 'transactions': {
      const transaction = record as Transaction;
      return {
        ...common,
        amount: transaction.amount,
        type: transaction.type,
        category_id: transaction.categoryId,
        category_name: transaction.categoryName,
        account_id: transaction.accountId,
        account_name: transaction.accountName,
        occurred_at: transaction.occurredAt,
        note: transaction.note ?? null,
        recurring_rule_id: transaction.recurringRuleId ?? null,
        occurrence_date: transaction.occurrenceDate ?? null,
        // Keep legacy columns populated until all previously deployed clients are retired.
        category: transaction.categoryName,
        account: transaction.accountName,
        date: transaction.occurredAt,
        icon: 'SPARKLES',
      };
    }
    case 'adjustments': {
      const adjustment = record as BalanceAdjustment;
      return {
        ...common,
        account_id: adjustment.accountId,
        amount_delta: adjustment.amountDelta,
        occurred_at: adjustment.occurredAt,
        reason: adjustment.reason ?? null,
      };
    }
    case 'goals': {
      const goal = record as SavingsGoal;
      return {
        ...common,
        name: goal.name,
        target_amount: goal.targetAmount,
        target_date: goal.targetDate ?? null,
        is_active: goal.isActive,
        legacy_unit: goal.legacyUnit ?? null,
        // current_amount/unit are deliberately omitted on updates: their legacy
        // values remain rollback-readable while v3 allocations are authoritative.
        // The additive migration supplies safe defaults for a newly inserted row.
      };
    }
    case 'allocations': {
      const allocation = record as SavingsAllocation;
      return {
        ...common,
        goal_id: allocation.goalId,
        amount_delta: allocation.amountDelta,
        occurred_at: allocation.occurredAt,
        note: allocation.note ?? null,
      };
    }
    case 'budgets': {
      const budget = record as Budget;
      return {
        ...common,
        scope: budget.scope,
        category_id: budget.categoryId ?? null,
        category_name: budget.categoryName ?? null,
        period: budget.period,
        amount: budget.amount,
        is_active: budget.isActive,
        category: budget.categoryName ?? '總預算',
      };
    }
    case 'recurringRules': {
      const rule = record as RecurringRule;
      return {
        ...common,
        name: rule.name,
        type: rule.type,
        amount: rule.amount,
        category_id: rule.categoryId,
        category_name: rule.categoryName,
        account_id: rule.accountId,
        account_name: rule.accountName,
        frequency: rule.frequency,
        start_date: rule.startDate,
        anchor_day: rule.anchorDay ?? null,
        next_occurrence_date: rule.nextOccurrenceDate,
        is_active: rule.isActive,
        note: rule.note ?? null,
      };
    }
  }
}

function canonicalDatabaseValue(column: string, value: unknown): unknown {
  // Postgres/PostgREST may return an equivalent timestamptz using a different
  // ISO spelling (for example `Z` versus `+00:00`). Conflict payload checks
  // compare the instant while local-text financial dates remain byte-exact.
  if ((column === 'updated_at' || column === 'deleted_at') && typeof value === 'string') {
    const timestamp = new Date(value).getTime();
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  // Optional domain fields are encoded as SQL NULL. Treat an omitted value as
  // the same representation, but do not coerce strings, booleans, or numbers.
  return value === undefined ? null : value;
}

function differingPayloadColumns(expected: DatabaseRow, persisted: DatabaseRow): string[] {
  const columns = new Set([...Object.keys(expected), ...Object.keys(persisted)]);
  return [...columns]
    .filter((column) => !Object.is(
      canonicalDatabaseValue(column, expected[column]),
      canonicalDatabaseValue(column, persisted[column]),
    ))
    .sort();
}

async function assertAuthenticatedOwner(client: SupabaseClient, ownerId: string): Promise<void> {
  if (!ownerId || ownerId === 'guest') {
    throw new Error('Guest finance data is local-only and cannot use the Supabase remote adapter');
  }
  const { data, error } = await client.auth.getUser();
  if (error) throw new Error(errorText(error, 'Unable to verify the authenticated Supabase user'));
  if (!data.user || data.user.id !== ownerId) {
    throw new Error('Supabase session owner does not match the requested finance-data owner');
  }
}

async function pullEntity(
  client: SupabaseClient,
  ownerId: string,
  entity: FinanceEntityName,
): Promise<RemotePullResult> {
  const table = TABLE_BY_ENTITY[entity];
  const records: RemoteRecord[] = [];
  const issues: RemotePullIssue[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select('*')
      .eq('user_id', ownerId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(errorText(error, `Unable to pull ${entity} from Supabase`));
    const rows = (data ?? []) as DatabaseRow[];
    for (const row of rows) {
      const recordId = typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
      try {
        if (requiredString(row, 'user_id') !== ownerId) {
          issues.push({
            stage: 'validation',
            entity,
            ...(recordId === undefined ? {} : { recordId }),
            message: `Supabase returned a foreign-owner row while pulling ${entity}${recordId ? `/${recordId}` : ''}`,
          });
          continue;
        }
        records.push(decodeRemoteRecord(entity, row));
      } catch (rowError) {
        issues.push({
          stage: 'pull',
          entity,
          ...(recordId === undefined ? {} : { recordId }),
          message: `Skipped malformed ${entity}${recordId ? `/${recordId}` : ''}: ${errorText(rowError instanceof Error ? rowError : null, 'invalid remote row')}`,
        });
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { records, issues };
}

/**
 * A row can be structurally valid while pointing at a row that was missing or
 * quarantined. Filter the decoded graph before reconciliation so one malformed
 * account/category/goal cannot admit dependent records that would make the
 * persisted FinanceData snapshot fail closed on its next reload.
 */
function validateRemoteGraph(records: readonly RemoteRecord[]): RemotePullResult {
  const accounts = new Map(
    records
      .filter((entry): entry is Extract<RemoteRecord, { entity: 'accounts' }> => entry.entity === 'accounts')
      .map((entry) => [entry.record.id, entry.record]),
  );
  const accountIds = new Set(accounts.keys());
  const categories = new Map(
    records
      .filter((entry): entry is Extract<RemoteRecord, { entity: 'categories' }> => entry.entity === 'categories')
      .map((entry) => [entry.record.id, entry.record]),
  );
  const goalIds = new Set(
    records.filter((entry) => entry.entity === 'goals').map((entry) => entry.record.id),
  );

  const invalidRecurringIds = new Set<string>();
  for (const entry of records) {
    if (entry.entity !== 'recurringRules') continue;
    const account = accounts.get(entry.record.accountId);
    const category = categories.get(entry.record.categoryId);
    if (!account || category?.kind !== entry.record.type
      || (entry.record.isActive && (
        account.deletedAt !== undefined
        || !account.isActive
        || category.deletedAt !== undefined
        || !category.isActive
      ))) {
      invalidRecurringIds.add(entry.record.id);
    }
  }
  const recurringIds = new Set(
    records
      .filter((entry) => entry.entity === 'recurringRules' && !invalidRecurringIds.has(entry.record.id))
      .map((entry) => entry.record.id),
  );

  const accepted: RemoteRecord[] = [];
  const issues: RemotePullIssue[] = [];
  for (const entry of records) {
    let reason: string | undefined;
    switch (entry.entity) {
      case 'transactions': {
        const category = categories.get(entry.record.categoryId);
        if (!accountIds.has(entry.record.accountId)) reason = 'references a missing account';
        else if (!category) reason = 'references a missing category';
        else if (category.kind !== entry.record.type) reason = 'references a category with the wrong kind';
        else if (entry.record.recurringRuleId && !recurringIds.has(entry.record.recurringRuleId)) {
          reason = 'references a missing or invalid recurring rule';
        }
        break;
      }
      case 'adjustments':
        if (!accountIds.has(entry.record.accountId)) reason = 'references a missing account';
        break;
      case 'allocations':
        if (!goalIds.has(entry.record.goalId)) reason = 'references a missing goal';
        break;
      case 'budgets':
        if (entry.record.scope === 'category'
          && categories.get(entry.record.categoryId)?.kind !== 'expense') {
          reason = 'references a missing or non-expense category';
        }
        break;
      case 'recurringRules': {
        const account = accounts.get(entry.record.accountId);
        const category = categories.get(entry.record.categoryId);
        if (!account) reason = 'references a missing account';
        else if (!category) reason = 'references a missing category';
        else if (category.kind !== entry.record.type) reason = 'references a category with the wrong kind';
        else if (entry.record.isActive && (account.deletedAt || !account.isActive)) {
          reason = 'is active while its account is unavailable';
        } else if (entry.record.isActive && (category.deletedAt || !category.isActive)) {
          reason = 'is active while its category is unavailable';
        }
        break;
      }
      case 'accounts':
      case 'categories':
      case 'goals':
        break;
    }
    if (!reason) {
      accepted.push(entry);
      continue;
    }
    issues.push({
      stage: 'validation',
      entity: entry.entity,
      recordId: entry.record.id,
      message: `Skipped inconsistent ${entry.entity}/${entry.record.id}: ${reason}`,
    });
  }
  return { records: accepted, issues };
}

function validateOperation(ownerId: string, operation: PendingOperation): void {
  if (operation.record.ownerId !== ownerId) {
    throw new Error('Pending operation owner does not match the requested Supabase owner');
  }
  if (operation.recordId !== operation.record.id) {
    throw new Error('Pending operation recordId does not match its record');
  }
  if (operation.id !== operation.record.lastOperationId) {
    throw new Error('Pending operation id does not match record.lastOperationId');
  }
  if (!Number.isInteger(operation.record.version) || operation.record.version < 1) {
    throw new Error('Pending operation version must be a positive integer');
  }
}

/**
 * Browser-safe Supabase persistence adapter. Pass the existing client created
 * with `VITE_SUPABASE_URL` and a publishable/legacy anon key; never a secret or
 * service-role client. RLS and the migration's conflict-clock trigger remain
 * authoritative even if a caller tampers with the browser payload.
 */
export function createSupabaseRemoteAdapter(client: SupabaseClient): RemoteAdapter {
  return {
    async pull(ownerId) {
      await assertAuthenticatedOwner(client, ownerId);
      const batches = await Promise.all(
        ENTITY_NAMES.map((entity) => pullEntity(client, ownerId, entity)),
      );
      const graph = validateRemoteGraph(batches.flatMap((batch) => batch.records));
      return {
        records: graph.records,
        issues: [...batches.flatMap((batch) => batch.issues), ...graph.issues],
      };
    },

    async apply(ownerId, operation) {
      await assertAuthenticatedOwner(client, ownerId);
      validateOperation(ownerId, operation);
      const table = TABLE_BY_ENTITY[operation.entity];
      const row = encodeRecord(operation.entity, operation.record);
      const { data, error } = await client
        .from(table)
        .upsert(row, { onConflict: 'user_id,id', ignoreDuplicates: false })
        .select('*')
        .single();
      if (error) {
        throw new Error(applyErrorText(error, operation));
      }
      if (!data || typeof data !== 'object') {
        throw new Error(`Supabase did not return the persisted ${operation.entity}/${operation.recordId}`);
      }

      // The database trigger returns OLD for a stale UPSERT. PostgREST still
      // reports that SQL statement as successful, so accepting only `error ===
      // null` would incorrectly remove the pending operation from the outbox.
      const persisted = decodeRemoteRecord(operation.entity, data as DatabaseRow).record;
      if (
        persisted.ownerId !== ownerId
        || persisted.id !== operation.recordId
        || persisted.version !== operation.record.version
        || persisted.lastOperationId !== operation.id
      ) {
        throw new Error(
          `Supabase retained a different conflict clock for ${operation.entity}/${operation.recordId}`,
        );
      }

      const differingColumns = differingPayloadColumns(
        encodeRecord(operation.entity, operation.record),
        encodeRecord(operation.entity, persisted),
      );
      if (differingColumns.length > 0) {
        // Do not include financial values in diagnostics. Column names are
        // enough to make the unresolved conflict visible without leaking data.
        throw new Error(
          `Supabase persisted payload differs for ${operation.entity}/${operation.recordId} at columns: ${differingColumns.join(', ')}`,
        );
      }
    },
  };
}
