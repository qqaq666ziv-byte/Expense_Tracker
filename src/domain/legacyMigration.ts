import type {
  AssetAccount,
  Budget,
  Category,
  FinanceData,
  IconRef,
  OwnerId,
  RecurringRule,
  SavingsAllocation,
  SavingsGoal,
  Transaction,
} from './model';
import { createFinanceBackup } from './backup';

export interface LegacyMigrationOptions {
  ownerId: OwnerId;
  migratedAt?: string | Date;
}

export class LegacyMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyMigrationError';
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function utf8Base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >> 2];
    encoded += BASE64URL_ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 0b111111];
  }
  return encoded;
}

/**
 * Creates a collision-free legacy relation ID from independently base64url-encoded UTF-8 parts.
 * SQL can reproduce each part with `rtrim(translate(encode(convert_to(part, 'UTF8'), 'base64'), '+/', '-_'), '=')`.
 */
export function stableLegacyId(prefix: string, ...parts: Array<string | number>): string {
  const normalizedPrefix = prefix.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalizedPrefix) throw new LegacyMigrationError('stableLegacyId prefix must not be empty.');
  if (parts.length === 0) throw new LegacyMigrationError('stableLegacyId requires at least one identity part.');
  return `${normalizedPrefix}-${parts.map((part) => utf8Base64Url(String(part))).join('.')}`;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new LegacyMigrationError(`${path} ${message}.`);
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value;
}

function optionalArray(source: UnknownRecord, snakeCase: string, camelCase?: string): unknown[] {
  const values: unknown[] = [];
  for (const key of [snakeCase, camelCase].filter((entry): entry is string => entry !== undefined)) {
    const value = source[key];
    if (value === undefined) continue;
    if (value === null) fail(key, 'must be an array, not null');
    values.push(...asArray(value, key));
  }
  return values;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(path, 'must be a string');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  const converted = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof converted !== 'number' || !Number.isFinite(converted)) fail(path, 'must be a finite number');
  return converted;
}

function positiveAmount(value: unknown, path: string): number {
  const amount = finiteNumber(value, path);
  if (amount <= 0) fail(path, 'must be greater than zero');
  return amount;
}

function integerInRange(value: unknown, minimum: number, maximum: number, path: string): number {
  const number = finiteNumber(value, path);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function normalizeMigrationTime(value: string | Date | undefined): { timestamp: string; localDate: string } {
  const supplied = value ?? new Date();
  if (supplied instanceof Date) {
    if (Number.isNaN(supplied.getTime())) throw new LegacyMigrationError('migratedAt must be a valid date-time.');
    return {
      timestamp: supplied.toISOString(),
      localDate: `${supplied.getFullYear()}-${String(supplied.getMonth() + 1).padStart(2, '0')}-${String(supplied.getDate()).padStart(2, '0')}`,
    };
  }
  if (typeof supplied !== 'string') throw new LegacyMigrationError('migratedAt must be a date-time string.');
  const datePrefix = /^(\d{4}-\d{2}-\d{2})/.exec(supplied)?.[1];
  if (!datePrefix) throw new LegacyMigrationError('migratedAt must begin with YYYY-MM-DD.');
  return { timestamp: supplied, localDate: datePrefix };
}

function commonSync(ownerId: OwnerId, id: string, migratedAt: string) {
  return {
    id,
    ownerId,
    version: 1,
    updatedAt: migratedAt,
    lastOperationId: stableLegacyId('operation', ownerId, 'legacy-migration-v1', id),
  };
}

const LEGACY_VECTOR_ICONS: Record<string, string> = {
  UTENSILS: 'utensils',
  CAR: 'car',
  BAG: 'shopping-bag',
  SPARKLES: 'sparkles',
};

function legacyIcon(value: unknown, fallback: string): IconRef {
  if (typeof value !== 'string' || value.length === 0) return { type: 'vector', value: fallback };
  if (/\p{Extended_Pictographic}/u.test(value)) return { type: 'emoji', value };
  return { type: 'vector', value: LEGACY_VECTOR_ICONS[value] ?? fallback };
}

function accountIcon(name: string): IconRef {
  if (/\u73fe\u91d1|cash/i.test(name)) return { type: 'emoji', value: '💵' };
  if (/\u652f\u4ed8|\u9322\u5305|wallet|pay/i.test(name)) return { type: 'vector', value: 'wallet-cards' };
  return { type: 'vector', value: 'wallet' };
}

function isClearlyAssetAccount(name: string): boolean {
  return /(現金|cash|支付|街口|錢包|wallet|e-?wallet|悠遊|一卡通|pay)/i.test(name);
}

function sourceId(
  record: UnknownRecord,
  path: string,
  kind: string,
  ownerId: OwnerId,
  identityParts: Array<string | number>,
  duplicateLegacyIds: ReadonlySet<string>,
  explicitLegacyIds: ReadonlySet<string>,
  used: Set<string>,
): string {
  const legacyId = optionalString(record.id, `${path}.id`);
  const generated = legacyId === undefined || duplicateLegacyIds.has(legacyId);
  let preferred = !generated
    ? legacyId
    : stableLegacyId(
      kind,
      ownerId,
      ...(legacyId === undefined ? [] : ['duplicate-legacy-id', legacyId]),
      ...identityParts,
    );
  let collisionAttempt = 0;
  while (generated && explicitLegacyIds.has(preferred)) {
    collisionAttempt += 1;
    preferred = stableLegacyId(
      kind,
      ownerId,
      'generated-id-collision',
      collisionAttempt,
      ...(legacyId === undefined ? [] : ['duplicate-legacy-id', legacyId]),
      ...identityParts,
    );
  }
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let duplicateNumber = 1;
  let disambiguated = stableLegacyId(kind, ownerId, preferred, 'duplicate', ...identityParts);
  while (used.has(disambiguated) || explicitLegacyIds.has(disambiguated)) {
    duplicateNumber += 1;
    disambiguated = stableLegacyId(kind, ownerId, preferred, 'duplicate', duplicateNumber, ...identityParts);
  }
  used.add(disambiguated);
  return disambiguated;
}

function inspectLegacyIds(
  records: UnknownRecord[],
  path: string,
): { explicit: Set<string>; duplicates: Set<string> } {
  const counts = new Map<string, number>();
  records.forEach((record, index) => {
    const id = optionalString(record.id, `${path}[${index}].id`);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  return {
    explicit: new Set(counts.keys()),
    duplicates: new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id)),
  };
}

function nextMonthlyOccurrence(localDate: string, anchorDay: number): string {
  const [yearText, monthText, dayText] = localDate.split('-');
  let year = Number(yearText);
  let monthIndex = Number(monthText) - 1;
  const currentDay = Number(dayText);
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  let candidateDay = Math.min(anchorDay, lastDay);
  if (candidateDay < currentDay) {
    monthIndex += 1;
    if (monthIndex === 12) {
      monthIndex = 0;
      year += 1;
    }
    candidateDay = Math.min(anchorDay, new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate());
  }
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(candidateDay).padStart(2, '0')}`;
}

export function migrateLegacyData(source: unknown, options: LegacyMigrationOptions): FinanceData {
  const snapshot = asRecord(source, 'legacy data');
  const ownerId = nonEmptyString(options.ownerId, 'ownerId');
  const migrationTime = normalizeMigrationTime(options.migratedAt);
  const migratedAt = migrationTime.timestamp;
  const localMigrationDate = migrationTime.localDate;
  const rawTransactions = optionalArray(snapshot, 'transactions');
  const rawGoals = optionalArray(snapshot, 'goals');
  const rawSubscriptions = optionalArray(snapshot, 'subscriptions');
  const rawBudgets = optionalArray(snapshot, 'budgets');
  const rawPaymentMethods = optionalArray(snapshot, 'payment_methods', 'paymentMethods');
  const rawCustomCategories = optionalArray(snapshot, 'custom_categories', 'customCategories');

  const transactionRecords = rawTransactions.map((value, index) => asRecord(value, `transactions[${index}]`));
  const goalRecords = rawGoals.map((value, index) => asRecord(value, `goals[${index}]`));
  const subscriptionRecords = rawSubscriptions.map((value, index) => asRecord(value, `subscriptions[${index}]`));
  const budgetRecords = rawBudgets.map((value, index) => asRecord(value, `budgets[${index}]`));
  const transactionIds = inspectLegacyIds(transactionRecords, 'transactions');
  const goalIds = inspectLegacyIds(goalRecords, 'goals');
  const subscriptionIds = inspectLegacyIds(subscriptionRecords, 'subscriptions');
  const budgetIds = inspectLegacyIds(budgetRecords, 'budgets');

  const accountNames: string[] = [];
  const addAccountName = (name: string) => {
    if (!accountNames.includes(name)) accountNames.push(name);
  };
  rawPaymentMethods.forEach((value, index) => addAccountName(nonEmptyString(value, `payment_methods[${index}]`)));
  transactionRecords.forEach((record, index) => addAccountName(nonEmptyString(record.account, `transactions[${index}].account`)));
  subscriptionRecords.forEach((record, index) => addAccountName(nonEmptyString(record.account, `subscriptions[${index}].account`)));

  const accounts: AssetAccount[] = accountNames.map((name, index) => {
    const id = stableLegacyId('account', ownerId, name);
    const clearlyAsset = isClearlyAssetAccount(name);
    return {
      ...commonSync(ownerId, id, migratedAt),
      name,
      icon: accountIcon(name),
      openingBalance: 0,
      includeInTotalAssets: clearlyAsset,
      isActive: true,
      sortOrder: index,
      legacyKey: name,
      requiresReview: !clearlyAsset,
    };
  });
  const accountIdByName = new Map(accounts.map((account) => [account.name, account.id]));

  type CategorySeed = { kind: 'income' | 'expense'; name: string; icon?: unknown };
  const categorySeeds: CategorySeed[] = [];
  const categorySeedKeys = new Set<string>();
  const addCategorySeed = (seed: CategorySeed) => {
    const key = `${seed.kind}\u0000${seed.name}`;
    if (categorySeedKeys.has(key)) return;
    categorySeedKeys.add(key);
    categorySeeds.push(seed);
  };

  rawCustomCategories.forEach((value, index) => {
    const record = asRecord(value, `custom_categories[${index}]`);
    const type = nonEmptyString(record.type, `custom_categories[${index}].type`);
    if (type !== 'income' && type !== 'expense') fail(`custom_categories[${index}].type`, 'must be income or expense');
    addCategorySeed({
      kind: type,
      name: nonEmptyString(record.name, `custom_categories[${index}].name`),
      icon: record.icon,
    });
  });
  transactionRecords.forEach((record, index) => {
    const type = nonEmptyString(record.type, `transactions[${index}].type`);
    if (type !== 'income' && type !== 'expense') fail(`transactions[${index}].type`, 'must be income or expense');
    addCategorySeed({
      kind: type,
      name: nonEmptyString(record.category, `transactions[${index}].category`),
      icon: record.icon,
    });
  });
  subscriptionRecords.forEach((record, index) => addCategorySeed({
    kind: 'expense',
    name: nonEmptyString(record.category, `subscriptions[${index}].category`),
  }));
  budgetRecords.forEach((record, index) => addCategorySeed({
    kind: 'expense',
    name: nonEmptyString(record.category, `budgets[${index}].category`),
  }));

  const categories: Category[] = categorySeeds.map((seed, index) => {
    const id = stableLegacyId('category', ownerId, seed.kind, seed.name);
    return {
      ...commonSync(ownerId, id, migratedAt),
      kind: seed.kind,
      name: seed.name,
      icon: legacyIcon(seed.icon, seed.kind === 'expense' ? 'tag' : 'badge-dollar-sign'),
      isActive: true,
      sortOrder: index,
      legacyKey: `${seed.kind}:${seed.name}`,
    };
  });
  const categoryIdByKey = new Map(categories.map((category) => [
    `${category.kind}\u0000${category.name}`,
    category.id,
  ]));

  const usedTransactionIds = new Set<string>();
  const transactions: Transaction[] = transactionRecords.map((record, index) => {
    const path = `transactions[${index}]`;
    const type = nonEmptyString(record.type, `${path}.type`);
    if (type !== 'income' && type !== 'expense') fail(`${path}.type`, 'must be income or expense');
    const categoryName = nonEmptyString(record.category, `${path}.category`);
    const accountName = nonEmptyString(record.account, `${path}.account`);
    const amount = positiveAmount(record.amount, `${path}.amount`);
    const occurredAt = nonEmptyString(record.date, `${path}.date`);
    const id = sourceId(
      record,
      path,
      'transaction',
      ownerId,
      [type, amount, categoryName, accountName, occurredAt, optionalString(record.note, `${path}.note`) ?? ''],
      transactionIds.duplicates,
      transactionIds.explicit,
      usedTransactionIds,
    );
    return {
      ...commonSync(ownerId, id, migratedAt),
      amount,
      type,
      categoryId: categoryIdByKey.get(`${type}\u0000${categoryName}`) as string,
      categoryName,
      accountId: accountIdByName.get(accountName) as string,
      accountName,
      occurredAt,
      note: optionalString(record.note, `${path}.note`),
    };
  });

  const usedGoalIds = new Set<string>();
  const goals: SavingsGoal[] = goalRecords.map((record, index) => {
    const path = `goals[${index}]`;
    const name = nonEmptyString(record.name, `${path}.name`);
    const targetAmount = positiveAmount(record.targetAmount, `${path}.targetAmount`);
    const targetDate = optionalString(record.targetDate, `${path}.targetDate`);
    const currentAmount = finiteNumber(record.currentAmount ?? 0, `${path}.currentAmount`);
    const legacyUnit = optionalString(record.unit, `${path}.unit`);
    const id = sourceId(
      record,
      path,
      'goal',
      ownerId,
      [name, targetAmount, targetDate ?? '', currentAmount, legacyUnit ?? ''],
      goalIds.duplicates,
      goalIds.explicit,
      usedGoalIds,
    );
    return {
      ...commonSync(ownerId, id, migratedAt),
      name,
      targetAmount,
      targetDate,
      isActive: true,
      legacyUnit,
    };
  });

  const allocations: SavingsAllocation[] = goalRecords.flatMap((record, index) => {
    const currentAmount = finiteNumber(record.currentAmount ?? 0, `goals[${index}].currentAmount`);
    if (currentAmount === 0) return [];
    const goal = goals[index];
    const id = stableLegacyId('allocation', ownerId, goal.id, 'legacy-current-amount');
    return [{
      ...commonSync(ownerId, id, migratedAt),
      goalId: goal.id,
      amountDelta: currentAmount,
      occurredAt: migratedAt,
      note: '由舊版目標累計金額遷移',
    }];
  });

  const usedRecurringIds = new Set<string>();
  const recurringRules: RecurringRule[] = subscriptionRecords.map((record, index) => {
    const path = `subscriptions[${index}]`;
    const name = nonEmptyString(record.name, `${path}.name`);
    const amount = positiveAmount(record.amount, `${path}.amount`);
    const categoryName = nonEmptyString(record.category, `${path}.category`);
    const accountName = nonEmptyString(record.account, `${path}.account`);
    const anchorDay = integerInRange(record.recurringDate, 1, 31, `${path}.recurringDate`);
    const nextOccurrenceDate = nextMonthlyOccurrence(localMigrationDate, anchorDay);
    const id = sourceId(
      record,
      path,
      'recurring',
      ownerId,
      [name, amount, categoryName, accountName, anchorDay],
      subscriptionIds.duplicates,
      subscriptionIds.explicit,
      usedRecurringIds,
    );
    return {
      ...commonSync(ownerId, id, migratedAt),
      name,
      type: 'expense',
      amount,
      categoryId: categoryIdByKey.get(`expense\u0000${categoryName}`) as string,
      categoryName,
      accountId: accountIdByName.get(accountName) as string,
      accountName,
      frequency: 'monthly',
      startDate: nextOccurrenceDate,
      nextOccurrenceDate,
      anchorDay,
      isActive: true,
      note: '由舊版固定開銷遷移',
    };
  });

  const usedBudgetIds = new Set<string>();
  const budgets: Budget[] = budgetRecords.map((record, index) => {
    const path = `budgets[${index}]`;
    const categoryName = nonEmptyString(record.category, `${path}.category`);
    const period = nonEmptyString(record.period, `${path}.period`);
    if (period !== 'weekly' && period !== 'monthly') fail(`${path}.period`, 'must be weekly or monthly');
    const amount = positiveAmount(record.amount, `${path}.amount`);
    const id = sourceId(
      record,
      path,
      'budget',
      ownerId,
      [categoryName, period, amount],
      budgetIds.duplicates,
      budgetIds.explicit,
      usedBudgetIds,
    );
    return {
      ...commonSync(ownerId, id, migratedAt),
      scope: 'category',
      categoryId: categoryIdByKey.get(`expense\u0000${categoryName}`) as string,
      categoryName,
      period,
      amount,
      isActive: true,
    };
  });

  const data: FinanceData = {
    accounts,
    categories,
    transactions,
    transfers: [],
    adjustments: [],
    goals,
    allocations,
    budgets,
    recurringRules,
    settings: {
      currency: 'TWD',
      locale: 'zh-TW',
      activeGoalId: goals[0]?.id,
    },
  };

  try {
    return createFinanceBackup(data, migratedAt).data;
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    throw new LegacyMigrationError(
      `Legacy data cannot be migrated safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
