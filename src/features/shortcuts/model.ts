import { parseRequiredNumberInput, toLocalInput } from '../../app/format';
import { parseLocalDateTime } from '../../domain/dateRange';
import type { FinanceData } from '../../domain/model';

export function shortcutParents(
  data: FinanceData,
  ownerId: string,
  lockedAccounts: ReadonlySet<string> = new Set(),
  lockedCategories: ReadonlySet<string> = new Set(),
) {
  return {
    accounts: data.accounts.filter((row) => row.ownerId === ownerId && row.isActive && !row.deletedAt && !row.requiresReview && !lockedAccounts.has(row.id)),
    categories: data.categories.filter((row) => row.ownerId === ownerId && row.kind === 'expense' && row.isActive && !row.deletedAt && !lockedCategories.has(row.id)),
  };
}

export function parseShortcutReviewAmount(value: string): number | null {
  const amount = parseRequiredNumberInput(value);
  return amount !== null && amount > 0 ? amount : null;
}

export function reviewTimeInput(value: string | null): string {
  if (!value) return '';
  try {
    return toLocalInput(parseLocalDateTime(value));
  } catch {
    return '';
  }
}

export function reviewTimeIso(value: string, original: string | null = null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  try {
    // The editor displays minutes. Preserve the exact received instant until the user changes it.
    if (original && value === reviewTimeInput(original)) return parseLocalDateTime(original).toISOString();
    return parseLocalDateTime(value).toISOString();
  } catch {
    return null;
  }
}

const reasonLabels: Record<string, string> = {
  possible_duplicate: '可能與既有通知重複，請先比對帳本。',
  cross_connection_duplicate: '其他連線已收到相同來源 ID 的通知，這筆不會自動入帳。請先比對收件匣與帳本，避免重複記帳。',
  no_timestamp: '通知缺少可確認的消費時間。',
  unrecognized_format: '目前無法可靠辨識這種通知格式。',
  structured_requires_review: '手動提供的欄位需要先確認。',
  topup_requires_review: '通知同時包含儲值與扣款，請核對真正扣款的帳戶及金額；儲值不另算支出。',
  multiple_amounts: '通知含有多個金額或折抵，請核對實際支出，不會自行加總或扣除。',
  non_expense_notice: '這可能是儲值、退款或轉帳通知，請先確認是否應列為支出。',
  parent_unavailable: '原本指定的帳戶或分類已不可用，請重新選擇。',
  unverified_format: '這種通知格式尚未完成實際消費確認。',
  missing_event_id: '通知沒有來源穩定識別碼，請人工確認；這類通知不會自動入帳。',
  auto_requires_review: '這筆通知未符合自動入帳條件，請核對後手動確認。',
  review_mode: '此連線設定為先確認再入帳。',
  test: '測試通知不會寫入帳本。',
};

export function shortcutReason(reason: string): string {
  return reasonLabels[reason] ?? '請核對通知內容與實際消費後再入帳。';
}

export const SHORTCUT_TEST_TEMPLATE = JSON.stringify({
  version: 1,
  source: 'jkopay',
  title: '[通知標題變數]',
  text: '[通知內文變數]',
  test: true,
}, null, 2);
