export interface Transaction {
  id: string;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  note?: string;
  date: string;
  account: string;
  icon: string;
  synced?: boolean; // 雲端同步狀態標籤
}

export interface Goal {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  unit: string;
  targetDate?: string; // 預計達成日期 (選填)
}

export interface VaultState {
  totalAmount: number;
  monthlyAdded: number;
}

export interface Subscription {
  id: string;
  name: string;
  amount: number;
  category: string;
  account: string;
  recurringDate: number; // 扣款日 (1-31)
}

export interface Budget {
  id: string;
  category: string;
  period: 'weekly' | 'monthly';
  amount: number;
}

