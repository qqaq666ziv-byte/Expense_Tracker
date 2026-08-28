import { parseLocalDateTime } from './dateRange';
import type { FinanceData, SyncRecord, Transfer } from './model';
import {
  MAX_LEGACY_MONEY_DECIMAL_PLACES,
  MAX_SAFE_MONEY,
  moneyDecimalPlaces,
} from './money';

export interface TransferDraft {
  amount: number;
  sourceAccountId: string;
  destinationAccountId: string;
  occurredAt: string;
  note?: string;
}

function resolveEndpoint(
  data: FinanceData,
  accountId: string,
  ownerId: string,
  label: '來源帳戶' | '目的帳戶',
  unchangedHistoricalId?: string,
): FinanceData['accounts'][number] {
  const account = data.accounts.find((candidate) => candidate.id === accountId);
  if (!account || account.ownerId !== ownerId) throw new Error(`${label}不存在或不屬於目前帳本`);
  const remainsHistoricalEndpoint = accountId === unchangedHistoricalId;
  if ((!account.isActive || account.deletedAt) && !remainsHistoricalEndpoint) {
    throw new Error(`${label}已封存、刪除或不可用`);
  }
  return account;
}

/**
 * Validate both endpoints and construct one atomic transfer payload. Passing a
 * previous record permits unchanged historical endpoints to remain selected;
 * changing either endpoint still requires a currently usable account.
 */
export function buildTransferRecord(
  data: FinanceData,
  draft: TransferDraft,
  metadata: SyncRecord,
  previous?: Transfer,
): Transfer {
  if (previous && (previous.id !== metadata.id || previous.ownerId !== metadata.ownerId)) {
    throw new Error('轉帳編輯快照與目前紀錄不一致');
  }
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
    throw new Error('轉帳金額必須大於零');
  }
  if (Math.abs(draft.amount) > MAX_SAFE_MONEY) throw new Error('轉帳超過安全金額上限');
  if (moneyDecimalPlaces(draft.amount) > MAX_LEGACY_MONEY_DECIMAL_PLACES) {
    throw new Error(`轉帳金額小數位最多 ${MAX_LEGACY_MONEY_DECIMAL_PLACES} 位`);
  }
  if (draft.sourceAccountId === draft.destinationAccountId) {
    throw new Error('來源帳戶與目的帳戶必須不同');
  }
  try {
    parseLocalDateTime(draft.occurredAt);
  } catch {
    throw new Error('轉帳日期格式無效');
  }

  const source = resolveEndpoint(
    data,
    draft.sourceAccountId,
    metadata.ownerId,
    '來源帳戶',
    previous?.sourceAccountId,
  );
  const destination = resolveEndpoint(
    data,
    draft.destinationAccountId,
    metadata.ownerId,
    '目的帳戶',
    previous?.destinationAccountId,
  );

  return {
    ...metadata,
    amount: draft.amount,
    sourceAccountId: source.id,
    sourceAccountName: previous?.sourceAccountId === source.id
      ? previous.sourceAccountName
      : source.name,
    destinationAccountId: destination.id,
    destinationAccountName: previous?.destinationAccountId === destination.id
      ? previous.destinationAccountName
      : destination.name,
    occurredAt: draft.occurredAt,
    ...(draft.note ? { note: draft.note } : {}),
  };
}
