export type ShortcutMode = 'review' | 'auto';
export type ShortcutInboxStatus = 'pending' | 'imported' | 'ignored' | 'test';

export interface ShortcutConnection {
  id: string;
  label: string;
  mode: ShortcutMode;
  account_id: string | null;
  category_id: string | null;
  verified_at: string | null;
  verified_format?: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ShortcutInboxItem {
  id: string;
  connection_id: string;
  amount: number | null;
  merchant: string;
  occurred_at: string | null;
  status: ShortcutInboxStatus;
  transaction_id: string | null;
  reason: string;
  payload: { title?: string; text?: string };
  created_at: string;
}

export interface ShortcutConfiguration {
  id: string;
  accountId: string | null;
  categoryId: string | null;
  mode: ShortcutMode;
}

export interface ShortcutReview {
  id: string;
  action: 'approve' | 'ignore';
  accountId: string | null;
  categoryId: string | null;
  amount: number | null;
  merchant: string | null;
  occurredAt: string | null;
}

/** Inject a deterministic adapter in tests; the normal adapter binds every call to its owner. */
export interface ShortcutApi {
  endpoint: string | null;
  listConnections(ownerId: string): Promise<ShortcutConnection[]>;
  listInbox(ownerId: string): Promise<ShortcutInboxItem[]>;
  create(ownerId: string, label: string, tokenHash: string): Promise<ShortcutConnection>;
  revoke(ownerId: string, id: string): Promise<void>;
  configure(ownerId: string, configuration: ShortcutConfiguration): Promise<ShortcutConnection>;
  review(ownerId: string, review: ShortcutReview): Promise<{ status: ShortcutInboxStatus; transaction_id: string | null }>;
}
