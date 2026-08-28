import type { FinanceData, FinanceEntityName, SyncRecord } from './model';
import {
  MAX_LEGACY_MONEY_DECIMAL_PLACES,
  MAX_SAFE_MONEY,
  moneyDecimalPlaces,
} from './money';

export const FINANCE_WRITE_LIMITS = {
  identifier: 4096,
  displayText: 512,
  longText: 4096,
  enumText: 64,
  iconValue: 256,
  dateText: 128,
} as const;

export const FINANCE_OWNER_ROW_LIMITS: Readonly<Record<FinanceEntityName, number>> = {
  transactions: 25_000,
  transfers: 25_000,
  accounts: 250,
  categories: 500,
  adjustments: 5_000,
  allocations: 10_000,
  goals: 500,
  budgets: 2_000,
  recurringRules: 1_000,
};

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertTextLimit(path: string, value: string | undefined, maximumBytes: number): void {
  if (value === undefined) return;
  if (utf8ByteLength(value) > maximumBytes) {
    throw new Error(`${path} exceeds ${maximumBytes} UTF-8 bytes`);
  }
}

function assertSyncRecordLimits(entity: FinanceEntityName, record: SyncRecord): void {
  assertTextLimit(`${entity}.id`, record.id, FINANCE_WRITE_LIMITS.identifier);
  assertTextLimit(
    `${entity}.lastOperationId`,
    record.lastOperationId,
    FINANCE_WRITE_LIMITS.identifier,
  );
}

function assertMoneyWriteLimit(path: string, value: number): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE_MONEY) {
    throw new Error(`${path} exceeds the safe monetary range`);
  }
  if (moneyDecimalPlaces(value) > MAX_LEGACY_MONEY_DECIMAL_PLACES) {
    throw new Error(`${path} exceeds ${MAX_LEGACY_MONEY_DECIMAL_PLACES} legacy decimal places`);
  }
}

export function assertFinanceRecordWithinWriteLimits<E extends FinanceEntityName>(
  entity: E,
  record: FinanceData[E][number],
): void {
  assertSyncRecordLimits(entity, record);

  switch (entity) {
    case 'accounts': {
      const account = record as FinanceData['accounts'][number];
      assertTextLimit('accounts.name', account.name, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('accounts.icon.type', account.icon.type, FINANCE_WRITE_LIMITS.enumText);
      assertTextLimit('accounts.icon.value', account.icon.value, FINANCE_WRITE_LIMITS.iconValue);
      assertTextLimit('accounts.legacyKey', account.legacyKey, FINANCE_WRITE_LIMITS.identifier);
      assertMoneyWriteLimit('accounts.openingBalance', account.openingBalance);
      break;
    }
    case 'categories': {
      const category = record as FinanceData['categories'][number];
      assertTextLimit('categories.kind', category.kind, FINANCE_WRITE_LIMITS.enumText);
      assertTextLimit('categories.name', category.name, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('categories.icon.type', category.icon.type, FINANCE_WRITE_LIMITS.enumText);
      assertTextLimit('categories.icon.value', category.icon.value, FINANCE_WRITE_LIMITS.iconValue);
      assertTextLimit('categories.legacyKey', category.legacyKey, FINANCE_WRITE_LIMITS.identifier);
      break;
    }
    case 'transactions': {
      const transaction = record as FinanceData['transactions'][number];
      assertTextLimit('transactions.type', transaction.type, FINANCE_WRITE_LIMITS.enumText);
      assertTextLimit('transactions.categoryId', transaction.categoryId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('transactions.categoryName', transaction.categoryName, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('transactions.accountId', transaction.accountId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('transactions.accountName', transaction.accountName, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('transactions.occurredAt', transaction.occurredAt, FINANCE_WRITE_LIMITS.dateText);
      assertTextLimit('transactions.note', transaction.note, FINANCE_WRITE_LIMITS.longText);
      assertTextLimit('transactions.recurringRuleId', transaction.recurringRuleId, FINANCE_WRITE_LIMITS.identifier);
      assertMoneyWriteLimit('transactions.amount', transaction.amount);
      break;
    }
    case 'transfers': {
      const transfer = record as FinanceData['transfers'][number];
      assertTextLimit('transfers.sourceAccountId', transfer.sourceAccountId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('transfers.sourceAccountName', transfer.sourceAccountName, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('transfers.destinationAccountId', transfer.destinationAccountId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('transfers.destinationAccountName', transfer.destinationAccountName, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('transfers.occurredAt', transfer.occurredAt, FINANCE_WRITE_LIMITS.dateText);
      assertTextLimit('transfers.note', transfer.note, FINANCE_WRITE_LIMITS.longText);
      assertMoneyWriteLimit('transfers.amount', transfer.amount);
      break;
    }
    case 'adjustments': {
      const adjustment = record as FinanceData['adjustments'][number];
      assertTextLimit('adjustments.accountId', adjustment.accountId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('adjustments.occurredAt', adjustment.occurredAt, FINANCE_WRITE_LIMITS.dateText);
      assertTextLimit('adjustments.reason', adjustment.reason, FINANCE_WRITE_LIMITS.longText);
      assertMoneyWriteLimit('adjustments.amountDelta', adjustment.amountDelta);
      break;
    }
    case 'goals': {
      const goal = record as FinanceData['goals'][number];
      assertTextLimit('goals.name', goal.name, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('goals.legacyUnit', goal.legacyUnit, FINANCE_WRITE_LIMITS.enumText);
      assertMoneyWriteLimit('goals.targetAmount', goal.targetAmount);
      break;
    }
    case 'allocations': {
      const allocation = record as FinanceData['allocations'][number];
      assertTextLimit('allocations.goalId', allocation.goalId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('allocations.occurredAt', allocation.occurredAt, FINANCE_WRITE_LIMITS.dateText);
      assertTextLimit('allocations.note', allocation.note, FINANCE_WRITE_LIMITS.longText);
      assertMoneyWriteLimit('allocations.amountDelta', allocation.amountDelta);
      break;
    }
    case 'budgets': {
      const budget = record as FinanceData['budgets'][number];
      assertTextLimit('budgets.scope', budget.scope, FINANCE_WRITE_LIMITS.enumText);
      assertTextLimit('budgets.categoryId', budget.categoryId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('budgets.categoryName', budget.categoryName, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('budgets.period', budget.period, FINANCE_WRITE_LIMITS.enumText);
      assertMoneyWriteLimit('budgets.amount', budget.amount);
      break;
    }
    case 'recurringRules': {
      const rule = record as FinanceData['recurringRules'][number];
      assertTextLimit('recurringRules.name', rule.name, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('recurringRules.type', rule.type, FINANCE_WRITE_LIMITS.enumText);
      assertTextLimit('recurringRules.categoryId', rule.categoryId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('recurringRules.categoryName', rule.categoryName, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('recurringRules.accountId', rule.accountId, FINANCE_WRITE_LIMITS.identifier);
      assertTextLimit('recurringRules.accountName', rule.accountName, FINANCE_WRITE_LIMITS.displayText);
      assertTextLimit('recurringRules.frequency', rule.frequency, FINANCE_WRITE_LIMITS.enumText);
      assertTextLimit('recurringRules.note', rule.note, FINANCE_WRITE_LIMITS.longText);
      assertMoneyWriteLimit('recurringRules.amount', rule.amount);
      break;
    }
  }
}

export function assertFinanceOwnerRowLimit<E extends FinanceEntityName>(
  entity: E,
  records: FinanceData[E],
  recordId: string,
): void {
  if (records.some((record) => record.id === recordId)) return;
  const maximumRows = FINANCE_OWNER_ROW_LIMITS[entity];
  if (records.length >= maximumRows) {
    throw new Error(`${entity} owner row limit of ${maximumRows} has been reached`);
  }
}
