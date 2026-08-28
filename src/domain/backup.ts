import type { FinanceData, OwnerId } from './model';
import { assertLifecycleTransition } from './lifecycle';
import { isTutorialTransaction } from './tutorialRecord';
import {
  MAX_LEGACY_MONEY_DECIMAL_PLACES,
  MAX_SAFE_MONEY,
  moneyDecimalPlaces,
  moneyLexemeDecimalPlaces,
} from './money';

export const FINANCE_BACKUP_SCHEMA_VERSION = 2 as const;
const LEGACY_FINANCE_BACKUP_SCHEMA_VERSION = 1 as const;
export const MAX_BACKUP_BYTES = 5_000_000;
const MAX_COLLECTION_RECORDS = 50_000;
const MAX_BACKUP_STRING_LENGTH = 20_000;

export interface FinanceBackup {
  schemaVersion: typeof FINANCE_BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  data: FinanceData;
}

export interface RestoreFinanceBackupOptions {
  mode?: 'merge' | 'replace';
  confirmReplace?: boolean;
  ownerId?: OwnerId;
}

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

export class BackupSizeLimitError extends BackupValidationError {
  readonly limitBytes = MAX_BACKUP_BYTES;
  readonly operation: 'export' | 'import';

  constructor(operation: 'export' | 'import') {
    super(operation === 'export'
      ? `Backup exceeds the ${MAX_BACKUP_BYTES} byte safety limit and was not exported.`
      : `Backup exceeds the ${MAX_BACKUP_BYTES} byte safety limit.`);
    this.name = 'BackupSizeLimitError';
    this.operation = operation;
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function createFinanceBackup(
  data: FinanceData,
  exportedAt: string | Date = new Date(),
): FinanceBackup {
  validateFinanceData(data, 'data');
  let normalizedExportedAt: string;
  try {
    normalizedExportedAt = exportedAt instanceof Date ? exportedAt.toISOString() : exportedAt;
  } catch {
    throw new BackupValidationError('exportedAt must be a valid date-time.');
  }
  assertDateTime(normalizedExportedAt, 'exportedAt');

  return {
    schemaVersion: FINANCE_BACKUP_SCHEMA_VERSION,
    exportedAt: normalizedExportedAt,
    data: clone(data),
  };
}

export function exportFinanceBackup(
  data: FinanceData,
  exportedAt: string | Date = new Date(),
): string {
  const serialized = JSON.stringify(createFinanceBackup(data, exportedAt), null, 2);
  if (utf8ByteLength(serialized) > MAX_BACKUP_BYTES) {
    throw new BackupSizeLimitError('export');
  }
  return serialized;
}

const TRANSACTION_CSV_HEADERS = [
  'id',
  'owner_id',
  'type',
  'amount',
  'occurred_at',
  'category_id',
  'category_name',
  'account_id',
  'account_name',
  'note',
  'recurring_rule_id',
  'occurrence_date',
  'deleted_at',
] as const;

function csvCell(value: string | number | undefined, protectFormula = true): string {
  let text = value === undefined ? '' : String(value);
  text = text.replace(/\r\n|\r|\n/g, '\r\n');
  if (protectFormula && /^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportTransactionsCsv(data: FinanceData): string {
  validateFinanceData(data, 'data');
  const rows = data.transactions
    .filter((transaction) => !isTutorialTransaction(transaction))
    .map((transaction) => [
    csvCell(transaction.id),
    csvCell(transaction.ownerId),
    csvCell(transaction.type),
    csvCell(transaction.amount, false),
    csvCell(transaction.occurredAt),
    csvCell(transaction.categoryId),
    csvCell(transaction.categoryName),
    csvCell(transaction.accountId),
    csvCell(transaction.accountName),
    csvCell(transaction.note),
    csvCell(transaction.recurringRuleId),
    csvCell(transaction.occurrenceDate),
    csvCell(transaction.deletedAt),
    ].join(','));

  return `${TRANSACTION_CSV_HEADERS.join(',')}\r\n${rows.join('\r\n')}${rows.length > 0 ? '\r\n' : ''}`;
}

const TRANSFER_CSV_HEADERS = [
  'id', 'owner_id', 'amount', 'occurred_at', 'source_account_id',
  'source_account_name', 'destination_account_id', 'destination_account_name',
  'note', 'deleted_at',
] as const;

/** Separate export preserves the established transaction CSV contract. */
export function exportTransfersCsv(data: FinanceData): string {
  validateFinanceData(data, 'data');
  const rows = data.transfers.map((transfer) => [
    csvCell(transfer.id),
    csvCell(transfer.ownerId),
    csvCell(transfer.amount, false),
    csvCell(transfer.occurredAt),
    csvCell(transfer.sourceAccountId),
    csvCell(transfer.sourceAccountName),
    csvCell(transfer.destinationAccountId),
    csvCell(transfer.destinationAccountName),
    csvCell(transfer.note),
    csvCell(transfer.deletedAt),
  ].join(','));
  return `${TRANSFER_CSV_HEADERS.join(',')}\r\n${rows.join('\r\n')}${rows.length > 0 ? '\r\n' : ''}`;
}

export function parseFinanceBackup(input: string | unknown): FinanceBackup {
  if (typeof input === 'string'
    && (input.length > MAX_BACKUP_BYTES || utf8ByteLength(input) > MAX_BACKUP_BYTES)) {
    throw new BackupSizeLimitError('import');
  }
  let parsed: unknown;
  try {
    parsed = typeof input === 'string' ? parseFinanceJson(input) : input;
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError('Invalid backup JSON.');
  }

  if (!isRecord(parsed)) {
    throw new BackupValidationError('Backup must be a JSON object.');
  }
  if (parsed.schemaVersion !== FINANCE_BACKUP_SCHEMA_VERSION
    && parsed.schemaVersion !== LEGACY_FINANCE_BACKUP_SCHEMA_VERSION) {
    throw new BackupValidationError(
      `Unsupported schemaVersion; expected ${LEGACY_FINANCE_BACKUP_SCHEMA_VERSION} or ${FINANCE_BACKUP_SCHEMA_VERSION}.`,
    );
  }
  if (parsed.schemaVersion === LEGACY_FINANCE_BACKUP_SCHEMA_VERSION
    && isRecord(parsed.data)
    && Object.hasOwn(parsed.data, 'transfers')) {
    throw new BackupValidationError('Legacy schemaVersion 1 must not contain a transfers collection.');
  }
  const normalized = parsed.schemaVersion === LEGACY_FINANCE_BACKUP_SCHEMA_VERSION
    ? {
        ...parsed,
        schemaVersion: FINANCE_BACKUP_SCHEMA_VERSION,
        data: isRecord(parsed.data) ? { ...parsed.data, transfers: [] } : parsed.data,
      }
    : parsed;
  assertDateTime(normalized.exportedAt, 'exportedAt');
  validateFinanceData(normalized.data, 'data');

  return clone(normalized) as unknown as FinanceBackup;
}

const MONEY_JSON_KEYS = new Set(['amount', 'amountDelta', 'openingBalance', 'targetAmount']);

interface JsonParseSourceContext {
  source?: string;
}

function parseFinanceJson(input: string): unknown {
  const parser = JSON.parse as (
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context?: JsonParseSourceContext) => unknown,
  ) => unknown;
  return parser(input, (_key, value, context) => {
    if (typeof value !== 'number' || !MONEY_JSON_KEYS.has(_key)) return value;
    if (context?.source === undefined) {
      throw new BackupValidationError(
        'This browser cannot validate raw monetary precision; update it before restoring JSON.',
      );
    }
    if (moneyLexemeDecimalPlaces(context.source) > MAX_LEGACY_MONEY_DECIMAL_PLACES) {
      throw new BackupValidationError(
        `${_key} must use at most ${MAX_LEGACY_MONEY_DECIMAL_PLACES} legacy decimal places.`,
      );
    }
    const exactValue = Number(context.source);
    if (!Number.isFinite(exactValue) || Math.abs(exactValue) > MAX_SAFE_MONEY) {
      throw new BackupValidationError(`${_key} must be within the safe monetary range.`);
    }
    return value;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expectation: string): never {
  throw new BackupValidationError(`${path} ${expectation}.`);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object');
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (value.length > MAX_COLLECTION_RECORDS) fail(path, `must contain at most ${MAX_COLLECTION_RECORDS} records`);
}

function assertString(value: unknown, path: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    fail(path, allowEmpty ? 'must be a string' : 'must be a non-empty string');
  }
  if (value.length > MAX_BACKUP_STRING_LENGTH) {
    fail(path, `must be at most ${MAX_BACKUP_STRING_LENGTH} characters`);
  }
}

function assertOptionalString(value: unknown, path: string): void {
  if (value !== undefined) assertString(value, path, true);
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) fail(path, 'must be within the safe numeric range');
}

function assertMoneyAmount(value: unknown, path: string): asserts value is number {
  assertFiniteNumber(value, path);
  if (Math.abs(value) > MAX_SAFE_MONEY) fail(path, 'must be within the safe monetary range');
  if (moneyDecimalPlaces(value) > MAX_LEGACY_MONEY_DECIMAL_PLACES) {
    fail(path, `must use at most ${MAX_LEGACY_MONEY_DECIMAL_PLACES} legacy decimal places`);
  }
}

function assertPositiveAmount(value: unknown, path: string): asserts value is number {
  assertMoneyAmount(value, path);
  if (value <= 0) fail(path, 'must be greater than zero');
}

function assertNonZeroAmount(value: unknown, path: string): asserts value is number {
  assertMoneyAmount(value, path);
  if (value === 0) fail(path, 'must not be zero');
}

function assertInteger(value: unknown, path: string, minimum?: number): asserts value is number {
  assertFiniteNumber(value, path);
  if (!Number.isInteger(value) || (minimum !== undefined && value < minimum)) {
    fail(path, minimum === undefined ? 'must be an integer' : `must be an integer >= ${minimum}`);
  }
}

function assertOneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  path: string,
): asserts value is T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    fail(path, `must be one of ${choices.join(', ')}`);
  }
}

function assertDate(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  const match = DATE_PATTERN.exec(value);
  if (!match) fail(path, 'must be a valid ISO/local date or date-time');

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const maxDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > maxDay) {
    fail(path, 'contains an impossible calendar date');
  }
  if (hourText !== undefined) {
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = secondText === undefined ? 0 : Number(secondText);
    if (hour > 23 || minute > 59 || second > 59) fail(path, 'contains an invalid time');
  }
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) {
    fail(path, 'contains an invalid timezone offset');
  }
}

function assertDateOnly(value: unknown, path: string): asserts value is string {
  assertDate(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, 'must be a date-only value (YYYY-MM-DD)');
  }
}

function assertOptionalDateOnly(value: unknown, path: string): void {
  if (value !== undefined) assertDateOnly(value, path);
}

function assertDateTime(value: unknown, path: string): asserts value is string {
  assertDate(value, path);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) {
    fail(path, 'must be a date-time, not a date-only value');
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(path, 'must include an explicit timezone (Z or offset)');
  }
}

function assertOptionalDateTime(value: unknown, path: string): void {
  if (value !== undefined) assertDateTime(value, path);
}

function validateSyncRecord(record: Record<string, unknown>, path: string): void {
  assertString(record.id, `${path}.id`);
  assertString(record.ownerId, `${path}.ownerId`);
  assertInteger(record.version, `${path}.version`, 1);
  assertDateTime(record.updatedAt, `${path}.updatedAt`);
  assertString(record.lastOperationId, `${path}.lastOperationId`);
  assertOptionalDateTime(record.deletedAt, `${path}.deletedAt`);
}

function validateIcon(value: unknown, path: string): void {
  assertRecord(value, path);
  assertOneOf(value.type, ['emoji', 'vector'] as const, `${path}.type`);
  assertString(value.value, `${path}.value`);
}

function collectionRecords(value: unknown, path: string): Record<string, unknown>[] {
  assertArray(value, path);
  return value.map((entry, index) => {
    assertRecord(entry, `${path}[${index}]`);
    return entry;
  });
}

function assertUniqueIds(records: Record<string, unknown>[], path: string): void {
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    const id = record.id as string;
    if (seen.has(id)) fail(`${path}[${index}].id`, `duplicates ${id}`);
    seen.add(id);
  }
}

function assertReference(
  id: unknown,
  ids: Set<string>,
  path: string,
  entityName: string,
): asserts id is string {
  assertString(id, path);
  if (!ids.has(id)) fail(path, `references a missing ${entityName}`);
}

export function validateFinanceData(value: unknown, path: string): asserts value is FinanceData {
  assertRecord(value, path);
  const accounts = collectionRecords(value.accounts, `${path}.accounts`);
  const categories = collectionRecords(value.categories, `${path}.categories`);
  const transactions = collectionRecords(value.transactions, `${path}.transactions`);
  const transfers = collectionRecords(value.transfers, `${path}.transfers`);
  const adjustments = collectionRecords(value.adjustments, `${path}.adjustments`);
  const goals = collectionRecords(value.goals, `${path}.goals`);
  const allocations = collectionRecords(value.allocations, `${path}.allocations`);
  const budgets = collectionRecords(value.budgets, `${path}.budgets`);
  const recurringRules = collectionRecords(value.recurringRules, `${path}.recurringRules`);

  const collections = {
    accounts, categories, transactions, transfers, adjustments, goals, allocations, budgets, recurringRules,
  };
  for (const [name, records] of Object.entries(collections)) {
    assertUniqueIds(records, `${path}.${name}`);
    records.forEach((record, index) => validateSyncRecord(record, `${path}.${name}[${index}]`));
  }

  accounts.forEach((account, index) => {
    const itemPath = `${path}.accounts[${index}]`;
    assertString(account.name, `${itemPath}.name`);
    validateIcon(account.icon, `${itemPath}.icon`);
    assertMoneyAmount(account.openingBalance, `${itemPath}.openingBalance`);
    assertBoolean(account.includeInTotalAssets, `${itemPath}.includeInTotalAssets`);
    assertBoolean(account.isActive, `${itemPath}.isActive`);
    assertInteger(account.sortOrder, `${itemPath}.sortOrder`);
    assertOptionalString(account.legacyKey, `${itemPath}.legacyKey`);
    if (account.requiresReview !== undefined) assertBoolean(account.requiresReview, `${itemPath}.requiresReview`);
  });

  categories.forEach((category, index) => {
    const itemPath = `${path}.categories[${index}]`;
    assertOneOf(category.kind, ['income', 'expense'] as const, `${itemPath}.kind`);
    assertString(category.name, `${itemPath}.name`);
    validateIcon(category.icon, `${itemPath}.icon`);
    assertBoolean(category.isActive, `${itemPath}.isActive`);
    assertInteger(category.sortOrder, `${itemPath}.sortOrder`);
    assertOptionalString(category.legacyKey, `${itemPath}.legacyKey`);
  });

  const accountById = new Map(accounts.map((record) => [record.id as string, record]));
  const categoryById = new Map(categories.map((record) => [record.id as string, record]));
  const goalById = new Map(goals.map((record) => [record.id as string, record]));
  const recurringById = new Map(recurringRules.map((record) => [record.id as string, record]));
  const accountIds = new Set(accountById.keys());
  const categoryIds = new Set(categoryById.keys());
  const goalIds = new Set(goalById.keys());
  const recurringIds = new Set(recurringById.keys());

  transactions.forEach((transaction, index) => {
    const itemPath = `${path}.transactions[${index}]`;
    assertPositiveAmount(transaction.amount, `${itemPath}.amount`);
    assertOneOf(transaction.type, ['income', 'expense'] as const, `${itemPath}.type`);
    assertReference(transaction.categoryId, categoryIds, `${itemPath}.categoryId`, 'category');
    assertString(transaction.categoryName, `${itemPath}.categoryName`);
    assertReference(transaction.accountId, accountIds, `${itemPath}.accountId`, 'account');
    assertString(transaction.accountName, `${itemPath}.accountName`);
    assertDate(transaction.occurredAt, `${itemPath}.occurredAt`);
    assertOptionalString(transaction.note, `${itemPath}.note`);
    if (transaction.recurringRuleId !== undefined) {
      assertReference(transaction.recurringRuleId, recurringIds, `${itemPath}.recurringRuleId`, 'recurring rule');
    }
    assertOptionalDateOnly(transaction.occurrenceDate, `${itemPath}.occurrenceDate`);
    const category = categoryById.get(transaction.categoryId as string);
    if (category?.kind !== transaction.type) fail(`${itemPath}.categoryId`, 'has the wrong category kind');
  });

  transfers.forEach((transfer, index) => {
    const itemPath = `${path}.transfers[${index}]`;
    assertPositiveAmount(transfer.amount, `${itemPath}.amount`);
    assertReference(transfer.sourceAccountId, accountIds, `${itemPath}.sourceAccountId`, 'account');
    assertString(transfer.sourceAccountName, `${itemPath}.sourceAccountName`);
    assertReference(
      transfer.destinationAccountId,
      accountIds,
      `${itemPath}.destinationAccountId`,
      'account',
    );
    assertString(transfer.destinationAccountName, `${itemPath}.destinationAccountName`);
    if (transfer.sourceAccountId === transfer.destinationAccountId) {
      fail(itemPath, 'must use different source and destination accounts');
    }
    assertDate(transfer.occurredAt, `${itemPath}.occurredAt`);
    assertOptionalString(transfer.note, `${itemPath}.note`);
  });

  adjustments.forEach((adjustment, index) => {
    const itemPath = `${path}.adjustments[${index}]`;
    assertReference(adjustment.accountId, accountIds, `${itemPath}.accountId`, 'account');
    assertNonZeroAmount(adjustment.amountDelta, `${itemPath}.amountDelta`);
    assertDate(adjustment.occurredAt, `${itemPath}.occurredAt`);
    assertOptionalString(adjustment.reason, `${itemPath}.reason`);
  });

  goals.forEach((goal, index) => {
    const itemPath = `${path}.goals[${index}]`;
    assertString(goal.name, `${itemPath}.name`);
    assertPositiveAmount(goal.targetAmount, `${itemPath}.targetAmount`);
    assertOptionalDateOnly(goal.targetDate, `${itemPath}.targetDate`);
    assertBoolean(goal.isActive, `${itemPath}.isActive`);
    assertOptionalString(goal.legacyUnit, `${itemPath}.legacyUnit`);
  });

  allocations.forEach((allocation, index) => {
    const itemPath = `${path}.allocations[${index}]`;
    assertReference(allocation.goalId, goalIds, `${itemPath}.goalId`, 'goal');
    assertNonZeroAmount(allocation.amountDelta, `${itemPath}.amountDelta`);
    assertDate(allocation.occurredAt, `${itemPath}.occurredAt`);
    assertOptionalString(allocation.note, `${itemPath}.note`);
  });

  budgets.forEach((budget, index) => {
    const itemPath = `${path}.budgets[${index}]`;
    assertOneOf(budget.scope, ['overall', 'category'] as const, `${itemPath}.scope`);
    if (budget.scope === 'category') {
      assertReference(budget.categoryId, categoryIds, `${itemPath}.categoryId`, 'category');
      if (categoryById.get(budget.categoryId as string)?.kind !== 'expense') {
        fail(`${itemPath}.categoryId`, 'must reference an expense category');
      }
      assertString(budget.categoryName, `${itemPath}.categoryName`);
    } else {
      if (budget.categoryId !== undefined || budget.categoryName !== undefined) {
        fail(itemPath, 'overall budget must not have categoryId or categoryName');
      }
    }
    assertOneOf(budget.period, ['weekly', 'monthly'] as const, `${itemPath}.period`);
    assertPositiveAmount(budget.amount, `${itemPath}.amount`);
    assertBoolean(budget.isActive, `${itemPath}.isActive`);
  });

  recurringRules.forEach((rule, index) => {
    const itemPath = `${path}.recurringRules[${index}]`;
    assertString(rule.name, `${itemPath}.name`);
    assertOneOf(rule.type, ['income', 'expense'] as const, `${itemPath}.type`);
    assertPositiveAmount(rule.amount, `${itemPath}.amount`);
    assertReference(rule.categoryId, categoryIds, `${itemPath}.categoryId`, 'category');
    assertString(rule.categoryName, `${itemPath}.categoryName`);
    assertReference(rule.accountId, accountIds, `${itemPath}.accountId`, 'account');
    assertString(rule.accountName, `${itemPath}.accountName`);
    assertOneOf(rule.frequency, ['weekly', 'monthly', 'yearly'] as const, `${itemPath}.frequency`);
    assertDateOnly(rule.startDate, `${itemPath}.startDate`);
    if (rule.anchorDay !== undefined) {
      assertInteger(rule.anchorDay, `${itemPath}.anchorDay`, 1);
      if ((rule.anchorDay as number) > 31) fail(`${itemPath}.anchorDay`, 'must be <= 31');
    }
    assertDateOnly(rule.nextOccurrenceDate, `${itemPath}.nextOccurrenceDate`);
    assertBoolean(rule.isActive, `${itemPath}.isActive`);
    assertOptionalString(rule.note, `${itemPath}.note`);
    if (categoryById.get(rule.categoryId as string)?.kind !== rule.type) {
      fail(`${itemPath}.categoryId`, 'has the wrong category kind');
    }
  });

  assertRecord(value.settings, `${path}.settings`);
  assertOneOf(value.settings.currency, ['TWD'] as const, `${path}.settings.currency`);
  assertOneOf(value.settings.locale, ['zh-TW'] as const, `${path}.settings.locale`);
  if (value.settings.activeGoalId !== undefined) {
    assertReference(value.settings.activeGoalId, goalIds, `${path}.settings.activeGoalId`, 'goal');
  }

  const ownerIds = new Set(
    Object.values(collections).flatMap((records) => records.map((record) => record.ownerId as string)),
  );
  if (ownerIds.size > 1) fail(path, 'must contain records for exactly one owner');

  const byIdOwner = (record: Record<string, unknown> | undefined): unknown => record?.ownerId;
  transactions.forEach((transaction, index) => {
    if (byIdOwner(accountById.get(transaction.accountId as string)) !== transaction.ownerId
      || byIdOwner(categoryById.get(transaction.categoryId as string)) !== transaction.ownerId) {
      fail(`${path}.transactions[${index}]`, 'must reference records owned by the same owner');
    }
  });
  transfers.forEach((transfer, index) => {
    if (byIdOwner(accountById.get(transfer.sourceAccountId as string)) !== transfer.ownerId
      || byIdOwner(accountById.get(transfer.destinationAccountId as string)) !== transfer.ownerId) {
      fail(`${path}.transfers[${index}]`, 'must reference accounts owned by the same owner');
    }
  });
  adjustments.forEach((adjustment, index) => {
    if (byIdOwner(accountById.get(adjustment.accountId as string)) !== adjustment.ownerId) {
      fail(`${path}.adjustments[${index}]`, 'must reference an account owned by the same owner');
    }
  });
  allocations.forEach((allocation, index) => {
    if (byIdOwner(goalById.get(allocation.goalId as string)) !== allocation.ownerId) {
      fail(`${path}.allocations[${index}]`, 'must reference a goal owned by the same owner');
    }
  });
  budgets.forEach((budget, index) => {
    if (budget.categoryId !== undefined
      && byIdOwner(categoryById.get(budget.categoryId as string)) !== budget.ownerId) {
      fail(`${path}.budgets[${index}]`, 'must reference a category owned by the same owner');
    }
  });
  recurringRules.forEach((rule, index) => {
    if (byIdOwner(accountById.get(rule.accountId as string)) !== rule.ownerId
      || byIdOwner(categoryById.get(rule.categoryId as string)) !== rule.ownerId) {
      fail(`${path}.recurringRules[${index}]`, 'must reference records owned by the same owner');
    }
  });
}

export function restoreFinanceBackup(
  current: FinanceData,
  input: string | unknown,
  options: RestoreFinanceBackupOptions = {},
): FinanceData {
  validateFinanceData(current, 'current');
  const incoming = parseFinanceBackup(input).data;
  assertRestoreOwner(current, incoming, options.ownerId);

  if (options.mode === 'replace') {
    if (options.confirmReplace !== true) {
      throw new BackupValidationError('Replacement restore requires confirmReplace: true.');
    }
    assertLifecycleTransition(current, incoming);
    return clone(incoming);
  }

  const merged: FinanceData = {
    accounts: mergeById(current.accounts, incoming.accounts),
    categories: mergeById(current.categories, incoming.categories),
    transactions: mergeById(current.transactions, incoming.transactions),
    transfers: mergeById(current.transfers, incoming.transfers),
    adjustments: mergeById(current.adjustments, incoming.adjustments),
    goals: mergeById(current.goals, incoming.goals),
    allocations: mergeById(current.allocations, incoming.allocations),
    budgets: mergeById(current.budgets, incoming.budgets),
    recurringRules: mergeById(current.recurringRules, incoming.recurringRules),
    settings: mergeSettings(current, incoming),
  };
  validateFinanceData(merged, 'restored data');
  assertLifecycleTransition(current, merged);
  return clone(merged);
}

function mergeById<T extends {
  id: string;
  version: number;
  updatedAt: string;
  lastOperationId: string;
  deletedAt?: string;
}>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const merged = current.map(clone);
  const indexById = new Map(merged.map((record, index) => [record.id, index]));
  for (const sourceRecord of incoming) {
    const record = clone(sourceRecord);
    const existingIndex = indexById.get(record.id);
    if (existingIndex === undefined) {
      indexById.set(record.id, merged.length);
      merged.push(record);
      continue;
    }
    const existing = merged[existingIndex];
    const updateOrder = record.version === existing.version
      ? compareMergeOrder(record, existing)
      : 0;
    if (record.version > existing.version
      || (record.version === existing.version && updateOrder > 0)) {
      merged[existingIndex] = record;
    } else if (record.version === existing.version
      && updateOrder === 0
      && canonicalJson(record) !== canonicalJson(existing)) {
      throw new BackupValidationError(
        `Backup contains conflicting data for record ${record.id} with identical version metadata.`,
      );
    }
  }
  return merged;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function mergeSettings(current: FinanceData, incoming: FinanceData): FinanceData['settings'] {
  const activeGoalId = current.settings.activeGoalId ?? incoming.settings.activeGoalId;
  return {
    ...clone(incoming.settings),
    ...clone(current.settings),
    ...(activeGoalId === undefined ? {} : { activeGoalId }),
  };
}

function compareMergeOrder(
  incoming: { lastOperationId: string; deletedAt?: string },
  current: { lastOperationId: string; deletedAt?: string },
): number {
  if (incoming.lastOperationId === current.lastOperationId) return 0;
  if (Boolean(incoming.deletedAt) !== Boolean(current.deletedAt)) {
    return incoming.deletedAt ? 1 : -1;
  }
  if (incoming.lastOperationId > current.lastOperationId) return 1;
  if (incoming.lastOperationId < current.lastOperationId) return -1;
  return 0;
}

function ownerIds(data: FinanceData): Set<string> {
  return new Set([
    ...data.accounts,
    ...data.categories,
    ...data.transactions,
    ...data.transfers,
    ...data.adjustments,
    ...data.goals,
    ...data.allocations,
    ...data.budgets,
    ...data.recurringRules,
  ].map((record) => record.ownerId));
}

function assertRestoreOwner(current: FinanceData, incoming: FinanceData, expected?: OwnerId): void {
  const currentOwners = ownerIds(current);
  const incomingOwners = ownerIds(incoming);
  if (expected !== undefined) {
    if ([...currentOwners, ...incomingOwners].some((ownerId) => ownerId !== expected)) {
      fail('restore ownerId', `must match ${expected}`);
    }
    return;
  }
  if (currentOwners.size > 0 && incomingOwners.size > 0
    && [...incomingOwners].some((ownerId) => !currentOwners.has(ownerId))) {
    fail('restore ownerId', 'cannot merge records from a different owner');
  }
}
