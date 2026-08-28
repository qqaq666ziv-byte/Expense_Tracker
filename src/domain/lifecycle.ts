import type { Category, FinanceData } from './model';

export interface CategoryReferences {
  transactions: number;
  budgets: number;
  recurringRules: number;
  total: number;
}

export type CategoryDisplayStatus = 'in-use' | 'archived' | 'unused';
export type CategoryAction = 'archive' | 'delete' | 'restore';
export type CategoryActionBlockCode =
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_DELETED'
  | 'CATEGORY_REFERENCED'
  | 'DUPLICATE_CATEGORY_NAME'
  | 'LAST_ACTIVE_CATEGORY';

export interface CategoryActionBlock {
  code: CategoryActionBlockCode;
  message: string;
  references?: CategoryReferences;
}

/** Compare user-facing category names without treating typography as meaning. */
export function normalizeCategoryName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-TW');
}

export function findCategoryNameConflict(
  categories: readonly Category[],
  kind: Category['kind'],
  name: string,
  excludeId?: string,
): Category | undefined {
  const normalized = normalizeCategoryName(name);
  return categories.find((category) => (
    !category.deletedAt
    && category.id !== excludeId
    && category.kind === kind
    && normalizeCategoryName(category.name) === normalized
  ));
}

/**
 * Count every financial record that retains this category id. Tombstones are
 * deliberately included because they remain part of backup and sync history.
 */
export function getCategoryReferences(
  data: Pick<FinanceData, 'transactions' | 'budgets' | 'recurringRules'>,
  categoryId: string,
): CategoryReferences {
  const transactions = data.transactions.filter((record) => record.categoryId === categoryId).length;
  const budgets = data.budgets.filter((record) => record.categoryId === categoryId).length;
  const recurringRules = data.recurringRules.filter((record) => record.categoryId === categoryId).length;
  return {
    transactions,
    budgets,
    recurringRules,
    total: transactions + budgets + recurringRules,
  };
}

/** Archived status takes precedence; an active category is in use only when referenced. */
export function getCategoryDisplayStatus(
  data: Pick<FinanceData, 'transactions' | 'budgets' | 'recurringRules'>,
  category: Category,
): CategoryDisplayStatus {
  if (!category.isActive) return 'archived';
  return getCategoryReferences(data, category.id).total > 0 ? 'in-use' : 'unused';
}

/**
 * Validate a category create/update at the domain boundary. Existing category
 * kind is immutable and semantic duplicates are scoped to owner and kind.
 */
export function assertCategoryUpsert(
  data: Pick<FinanceData, 'categories'>,
  candidate: Category,
): void {
  if (!normalizeCategoryName(candidate.name)) {
    throw new Error('請輸入分類名稱');
  }
  const existing = data.categories.find((category) => (
    category.id === candidate.id && category.ownerId === candidate.ownerId
  ));
  if (existing?.deletedAt && !candidate.deletedAt) {
    throw new Error('此分類已有同步刪除紀錄，不能以新增或編輯操作重新啟用。');
  }
  if (
    existing
    && candidate.version <= existing.version
    && candidate.lastOperationId !== existing.lastOperationId
  ) {
    throw new Error('已有相同分類紀錄，請重新整理後編輯或重新啟用既有分類。');
  }
  if (existing && existing.kind !== candidate.kind) {
    throw new Error('既有分類的收支類型不可變更');
  }
  const nameChanged = !existing
    || normalizeCategoryName(existing.name) !== normalizeCategoryName(candidate.name);
  if (nameChanged && findCategoryNameConflict(
    data.categories.filter((category) => category.ownerId === candidate.ownerId),
    candidate.kind,
    candidate.name,
    candidate.id,
  )) {
    throw new Error(`同一收支類型已有同名分類「${candidate.name.trim()}」`);
  }
}

function kindLabel(kind: Category['kind']): string {
  return kind === 'expense' ? '支出' : '收入';
}

function referenceMessage(references: CategoryReferences, isLastActive: boolean): string {
  const parts: string[] = [];
  if (references.transactions > 0) parts.push(`${references.transactions} 筆交易`);
  if (references.budgets > 0) parts.push(`${references.budgets} 個預算`);
  if (references.recurringRules > 0) parts.push(`${references.recurringRules} 個週期收支`);
  return isLastActive
    ? `此分類仍被 ${parts.join('、')}引用，不能刪除；請先建立另一個可用的同類分類，再封存此分類以保留過去資料。`
    : `此分類仍被 ${parts.join('、')}引用，不能刪除；請改用封存來保留過去資料。`;
}

/** Return a user-facing reason when a requested lifecycle action must fail closed. */
export function getCategoryActionBlock(
  data: Pick<FinanceData, 'categories' | 'transactions' | 'budgets' | 'recurringRules'>,
  category: Category,
  action: CategoryAction,
): CategoryActionBlock | undefined {
  const current = data.categories.find((candidate) => (
    candidate.id === category.id && candidate.ownerId === category.ownerId
  ));
  if (!current) {
    return { code: 'CATEGORY_NOT_FOUND', message: '找不到分類，本次操作未執行。' };
  }
  if (current.deletedAt) {
    return { code: 'CATEGORY_DELETED', message: '此分類已刪除，本次操作未執行。' };
  }

  if (action === 'restore') {
    const conflict = findCategoryNameConflict(
      data.categories.filter((candidate) => candidate.ownerId === current.ownerId),
      current.kind,
      current.name,
      current.id,
    );
    return conflict
      ? {
          code: 'DUPLICATE_CATEGORY_NAME',
          message: `同一收支類型已有同名分類「${conflict.name}」，無法重新啟用。`,
        }
      : undefined;
  }

  if (action === 'delete') {
    const references = getCategoryReferences(data, current.id);
    if (references.total > 0) {
      const activeOfKind = data.categories.filter((candidate) => (
        candidate.ownerId === current.ownerId
        && candidate.kind === current.kind
        && candidate.isActive
        && !candidate.deletedAt
      )).length;
      return {
        code: 'CATEGORY_REFERENCED',
        message: referenceMessage(references, current.isActive && activeOfKind <= 1),
        references,
      };
    }
  }

  if (current.isActive) {
    const activeOfKind = data.categories.filter((candidate) => (
      candidate.ownerId === current.ownerId
      && candidate.kind === current.kind
      && candidate.isActive
      && !candidate.deletedAt
    )).length;
    if (activeOfKind <= 1) {
      return {
        code: 'LAST_ACTIVE_CATEGORY',
        message: `至少保留一個可用的${kindLabel(current.kind)}分類。`,
      };
    }
  }

  return undefined;
}

/** Reject restore/sync transitions that rewrite meaning or remove every usable category. */
export function assertLifecycleTransition(current: FinanceData, next: FinanceData): void {
  const currentCategories = new Map(current.categories.map((record) => [
    `${record.ownerId}\u0000${record.id}`,
    record,
  ]));
  for (const category of next.categories) {
    const existing = currentCategories.get(`${category.ownerId}\u0000${category.id}`);
    if (existing && existing.kind !== category.kind) {
      throw new Error(`分類「${existing.name}」的收支類型不可由還原或同步變更。`);
    }
  }

  const owners = new Set([
    ...current.categories.map((record) => record.ownerId),
    ...next.categories.map((record) => record.ownerId),
  ]);
  for (const ownerId of owners) {
    for (const kind of ['expense', 'income'] as const) {
      const activeCount = (data: FinanceData) => data.categories.filter((record) => (
        record.ownerId === ownerId && record.kind === kind && record.isActive && !record.deletedAt
      )).length;
      if (activeCount(current) > 0 && activeCount(next) === 0) {
        throw new Error(`還原或同步後至少必須保留一個可用的${kindLabel(kind)}分類。`);
      }
    }
  }
}
