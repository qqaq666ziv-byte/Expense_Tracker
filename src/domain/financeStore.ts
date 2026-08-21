import { calculateFinancials } from './financeEngine';
import { parseLocalDateTime } from './dateRange';
import type { PersistedFinanceState, SavingsAllocation, Transaction } from './model';

export type FinanceCommand =
  | {
      type: 'allocateSavings';
      goalId: string;
      amount: number;
      note?: string;
    }
  | {
      type: 'addTransaction';
      amount: number;
      transactionType: 'income' | 'expense';
      categoryId: string;
      accountId: string;
      occurredAt: string;
      note?: string;
    }
  | {
      type: 'archiveCategory';
      categoryId: string;
    };

export type CommandResult =
  | { ok: true; recordId: string }
  | { ok: false; code: string; message: string };

export interface FinanceStoreDependencies {
  now?: () => Date;
  generateId?: () => string;
}

export interface FinanceStore {
  snapshot(): PersistedFinanceState;
  execute(command: FinanceCommand): CommandResult;
  subscribe(listener: () => void): () => void;
  replace(snapshot: PersistedFinanceState): void;
}

export function createFinanceStore(
  initialState: PersistedFinanceState,
  dependencies: FinanceStoreDependencies = {},
): FinanceStore {
  let state = structuredClone(initialState);
  const listeners = new Set<() => void>();
  const now = dependencies.now ?? (() => new Date());
  const generateId = dependencies.generateId ?? (() => crypto.randomUUID());

  const publish = () => listeners.forEach((listener) => listener());

  return {
    snapshot: () => structuredClone(state),
    execute: (command) => {
      if (command.type === 'archiveCategory') {
        const index = state.data.categories.findIndex(
          (category) => category.id === command.categoryId && !category.deletedAt,
        );
        if (index < 0) {
          return { ok: false, code: 'CATEGORY_NOT_FOUND', message: '找不到分類' };
        }
        const timestamp = now().toISOString();
        const operationId = generateId();
        const updated = {
          ...state.data.categories[index],
          isActive: false,
          version: state.data.categories[index].version + 1,
          updatedAt: timestamp,
          lastOperationId: operationId,
        };
        state.data.categories[index] = updated;
        if (state.ownerId !== 'guest') {
          state.outbox.push({
            id: operationId,
            entity: 'categories',
            recordId: updated.id,
            record: updated,
            attempts: 0,
            queuedAt: timestamp,
          });
        }
        publish();
        return { ok: true, recordId: updated.id };
      }

      if (command.type === 'addTransaction') {
        if (!Number.isFinite(command.amount) || command.amount <= 0) {
          return { ok: false, code: 'INVALID_AMOUNT', message: '交易金額必須大於零' };
        }
        const account = state.data.accounts.find(
          (candidate) => candidate.id === command.accountId && !candidate.deletedAt && candidate.isActive,
        );
        if (!account) {
          return { ok: false, code: 'ACCOUNT_NOT_FOUND', message: '找不到可用的資產帳戶' };
        }
        const category = state.data.categories.find(
          (candidate) => candidate.id === command.categoryId
            && !candidate.deletedAt
            && candidate.isActive
            && candidate.kind === command.transactionType,
        );
        if (!category) {
          return { ok: false, code: 'CATEGORY_NOT_FOUND', message: '找不到相符的收支分類' };
        }
        try {
          parseLocalDateTime(command.occurredAt);
        } catch {
          return { ok: false, code: 'INVALID_DATE', message: '交易日期格式無效' };
        }

        const timestamp = now().toISOString();
        const operationId = generateId();
        const transaction: Transaction = {
          id: generateId(),
          ownerId: state.ownerId,
          amount: command.amount,
          type: command.transactionType,
          categoryId: category.id,
          categoryName: category.name,
          accountId: account.id,
          accountName: account.name,
          occurredAt: command.occurredAt,
          ...(command.note ? { note: command.note } : {}),
          version: 1,
          updatedAt: timestamp,
          lastOperationId: operationId,
        };
        state.data.transactions.push(transaction);
        if (state.ownerId !== 'guest') {
          state.outbox.push({
            id: operationId,
            entity: 'transactions',
            recordId: transaction.id,
            record: transaction,
            attempts: 0,
            queuedAt: timestamp,
          });
        }
        publish();
        return { ok: true, recordId: transaction.id };
      }

      const goal = state.data.goals.find(
        (candidate) => candidate.id === command.goalId && !candidate.deletedAt && candidate.isActive,
      );
      if (!goal) {
        return { ok: false, code: 'GOAL_NOT_FOUND', message: '找不到可用的儲蓄目標' };
      }
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        return { ok: false, code: 'INVALID_AMOUNT', message: '配置金額必須大於零' };
      }
      if (command.amount > calculateFinancials(state.data).availableAssets) {
        return { ok: false, code: 'INSUFFICIENT_AVAILABLE_ASSETS', message: '可配置資產不足' };
      }

      const timestamp = now().toISOString();
      const operationId = generateId();
      const allocation: SavingsAllocation = {
        id: generateId(),
        ownerId: state.ownerId,
        goalId: command.goalId,
        amountDelta: command.amount,
        occurredAt: timestamp,
        ...(command.note ? { note: command.note } : {}),
        version: 1,
        updatedAt: timestamp,
        lastOperationId: operationId,
      };
      state.data.allocations.push(allocation);
      if (state.ownerId !== 'guest') {
        state.outbox.push({
          id: operationId,
          entity: 'allocations',
          recordId: allocation.id,
          record: allocation,
          attempts: 0,
          queuedAt: timestamp,
        });
      }
      publish();
      return { ok: true, recordId: allocation.id };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace: (snapshot) => {
      state = structuredClone(snapshot);
      publish();
    },
  };
}
