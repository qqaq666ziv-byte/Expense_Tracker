import type { AssetAccount } from '../domain/model';

const preciseMoney = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const compactMoney = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});

/** Keep exact values for actions and details; compact only dashboard-scale summaries. */
export function displayMoney(value: number, compact = false): string {
  const formatted = compact && Math.abs(value) >= 10_000 ? compactMoney.format(value) : preciseMoney.format(value);
  return formatted.replace('$', 'NT$');
}

export type AccountKind = 'cash' | 'bank' | 'ewallet' | 'stored-value' | 'other';

export const ACCOUNT_PRESETS: { kind: AccountKind; label: string; name: string; emoji: string; hint: string }[] = [
  { kind: 'cash', label: '現金', name: '現金', emoji: '💵', hint: '錢包裡的現金' },
  { kind: 'bank', label: '銀行', name: '銀行帳戶', emoji: '🏦', hint: '活存、薪轉帳戶' },
  { kind: 'ewallet', label: '電子支付', name: '街口支付', emoji: '📱', hint: '街口、LINE Pay 等' },
  { kind: 'stored-value', label: '儲值卡', name: '悠遊卡', emoji: '💳', hint: '悠遊卡、禮物卡等' },
  { kind: 'other', label: '其他', name: '其他資產', emoji: '🪙', hint: '自行命名的資產' },
];

export function inferAccountKind(account: Pick<AssetAccount, 'name' | 'icon'>): AccountKind {
  const name = account.name.toLowerCase();
  if (/銀行|bank|存摺|郵局/.test(name) || account.icon.value === '🏦') return 'bank';
  if (/街口|line pay|支付|錢包|wallet/.test(name) || account.icon.value === '📱') return 'ewallet';
  if (/悠遊|一卡通|儲值|禮物卡/.test(name) || account.icon.value === '💳') return 'stored-value';
  if (/現金|cash/.test(name) || account.icon.value === '💵') return 'cash';
  return 'other';
}

export function accountKindLabel(account: Pick<AssetAccount, 'name' | 'icon'>): string {
  return ACCOUNT_PRESETS.find((item) => item.kind === inferAccountKind(account))?.label ?? '其他';
}
