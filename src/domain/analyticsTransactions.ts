import type { FinanceData, Transaction } from './model';
import { isFinancialTransaction } from './tutorialRecord';
import { getTodayRange, parseLocalDateTime } from './dateRange';

/** Read-only analytics projection. Never persist these records or use them for account balances. */
export function getAnalyticsTransactions(data: FinanceData, throughDate?: Date): Transaction[] {
  const transactions = data.transactions.filter(isFinancialTransaction);
  const categoryIds = new Set([
    ...data.categories.map((category) => category.id),
    ...data.transactions.map((transaction) => transaction.categoryId),
  ]);
  let feeCategoryId = 'system:transfer-fee';
  while (categoryIds.has(feeCategoryId)) feeCategoryId += ':';
  const fees: Transaction[] = data.transfers
    .filter((transfer) => !transfer.deletedAt && (transfer.fee ?? 0) > 0)
    .map((transfer) => ({
      id: `transfer-fee:${transfer.id}`,
      ownerId: transfer.ownerId,
      version: transfer.version,
      updatedAt: transfer.updatedAt,
      lastOperationId: transfer.lastOperationId,
      amount: transfer.fee ?? 0,
      type: 'expense',
      categoryId: feeCategoryId,
      categoryName: '手續費',
      accountId: transfer.feeMode === 'destination-net'
        ? transfer.destinationAccountId : transfer.sourceAccountId,
      accountName: transfer.feeMode === 'destination-net'
        ? transfer.destinationAccountName : transfer.sourceAccountName,
      occurredAt: transfer.occurredAt,
      note: `轉帳手續費：${transfer.sourceAccountName} → ${transfer.destinationAccountName}`,
    }));
  const projected = [...transactions, ...fees];
  if (!throughDate) return projected;
  // Calendar reports include the whole local day, never tomorrow's planned records.
  const cutoff = getTodayRange(throughDate).end.getTime();
  return projected.filter((record) => parseLocalDateTime(record.occurredAt).getTime() <= cutoff);
}
