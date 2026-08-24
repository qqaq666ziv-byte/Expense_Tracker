import type { Transaction } from "./model";

export const TUTORIAL_RECORD_NOTE =
  "🐕 柴柴互動教學紀錄（教學完成後會安全刪除）";

export function isTutorialTransaction(
  transaction: Pick<Transaction, "note">,
): boolean {
  return transaction.note === TUTORIAL_RECORD_NOTE;
}

/** The single predicate used by ledgers, balances, budgets and analytics. */
export function isFinancialTransaction(
  transaction: Pick<Transaction, "note" | "deletedAt">,
): boolean {
  return !transaction.deletedAt && !isTutorialTransaction(transaction);
}
