import { isBrowserSafeSupabaseKey, supabase } from '../../lib/supabaseClient';
import type { ShortcutApi, ShortcutConnection, ShortcutInboxItem, ShortcutInboxStatus, ShortcutPendingPage, ShortcutPendingCursor } from './types';

export class ShortcutApiError extends Error {
  constructor(readonly kind: 'unavailable' | 'auth' | 'network' | 'request' | 'stable-event-id-required' | 'active-auto-connection') {
    super(kind === 'unavailable'
      ? '此環境尚未啟用捷徑接收服務。仍可先測試通知文字。'
      : kind === 'auth'
        ? '登入狀態已變更，請重新登入後再試。'
        : kind === 'network'
          ? '目前無法連線。請恢復網路後重新整理，確認雲端結果再重試。'
          : kind === 'stable-event-id-required'
            ? '請先在 iPhone 重送測試，確認同一通知的來源 ID 不變，再勾選確認以儲存自動入帳設定。'
            : kind === 'active-auto-connection'
              ? '已有另一個啟用自動入帳的連線。請先將該連線改為待確認，再啟用目前連線；不會自動停用其他連線。'
              : '這次操作未完成。請重新整理確認狀態，並檢查帳戶、分類及通知內容。');
    this.name = 'ShortcutApiError';
  }
}

type SessionResult = { data: { session: { access_token: string; user: { id: string } } | null } };
interface ApiDependencies {
  url?: string;
  anonKey?: string;
  getSession: () => Promise<SessionResult>;
  fetcher: typeof fetch;
}

function serviceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShortcutApiError('request');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string') throw new ShortcutApiError('request');
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value);
}

function connection(value: unknown): ShortcutConnection {
  const row = record(value);
  if (row.mode !== 'review' && row.mode !== 'auto') throw new ShortcutApiError('request');
  return {
    id: requiredText(row.id), label: requiredText(row.label), mode: row.mode,
    account_id: nullableText(row.account_id), category_id: nullableText(row.category_id),
    verified_at: nullableText(row.verified_at), verified_format: nullableText(row.verified_format),
    revoked_at: nullableText(row.revoked_at), created_at: requiredText(row.created_at),
  };
}

function status(value: unknown): ShortcutInboxStatus {
  if (value === 'pending' || value === 'imported' || value === 'ignored' || value === 'test') return value;
  throw new ShortcutApiError('request');
}

function inbox(value: unknown): ShortcutInboxItem {
  const row = record(value);
  const payload = record(row.payload ?? {});
  const amount = row.amount === null || row.amount === undefined ? null : Number(row.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000)) throw new ShortcutApiError('request');
  return {
    id: requiredText(row.id), connection_id: requiredText(row.connection_id), amount,
    merchant: nullableText(row.merchant) ?? '', occurred_at: nullableText(row.occurred_at),
    status: status(row.status), transaction_id: nullableText(row.transaction_id),
    reason: nullableText(row.reason) ?? '', created_at: requiredText(row.created_at),
    payload: { title: nullableText(payload.title) ?? undefined, text: nullableText(payload.text) ?? undefined },
  };
}

function single(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function rows<T>(value: unknown, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new ShortcutApiError('request');
  return value.map(decode);
}

function pendingPage(value: unknown): ShortcutPendingPage {
  const row = record(value);
  const count = Number(row.pending_count);
  if (!Number.isSafeInteger(count) || count < 0 || typeof row.has_more !== 'boolean') throw new ShortcutApiError('request');
  const nextCreated = nullableText(row.next_created_at);
  const nextId = nullableText(row.next_id);
  if (row.has_more && (!nextCreated || !nextId)) throw new ShortcutApiError('request');
  return { items: rows(row.items, inbox), pending_count: count, has_more: row.has_more,
    next_created_at: nextCreated, next_id: nextId };
}

export function createShortcutApi(dependencies: ApiDependencies): ShortcutApi {
  const baseUrl = serviceUrl(dependencies.url);
  async function call(ownerId: string, name: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
    const anonKey = dependencies.anonKey;
    if (!baseUrl || typeof anonKey !== 'string' || !isBrowserSafeSupabaseKey(anonKey)) {
      throw new ShortcutApiError('unavailable');
    }
    if (!ownerId || ownerId === 'guest') throw new ShortcutApiError('auth');
    let session: SessionResult['data']['session'];
    try {
      session = (await dependencies.getSession()).data.session;
    } catch (error) {
      if (error instanceof ShortcutApiError && error.kind === 'unavailable') throw error;
      throw new ShortcutApiError('auth');
    }
    if (!session || session.user.id !== ownerId || !session.access_token) throw new ShortcutApiError('auth');

    // Capture the bearer for this call. A later account switch cannot rebind an old form to the new owner.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await dependencies.fetcher(`${baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', apikey: anonKey,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(parameters), signal: controller.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { code?: unknown; message?: unknown };
        if (response.status === 401) throw new ShortcutApiError('auth');
        if (response.status === 404 || ['PGRST202', '42883', '42P01'].includes(String(error.code))) throw new ShortcutApiError('unavailable');
        if (error.code === '23514' && error.message === 'stable_event_id_confirmation_required') throw new ShortcutApiError('stable-event-id-required');
        if (error.code === '23514' && error.message === 'active_auto_connection_exists') throw new ShortcutApiError('active-auto-connection');
        throw new ShortcutApiError('request');
      }
      const body = await response.text();
      return body ? JSON.parse(body) : null;
    } catch (error) {
      if (error instanceof ShortcutApiError) throw error;
      throw new ShortcutApiError('network');
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    endpoint: baseUrl ? `${baseUrl}/functions/v1/finance-shortcut-receive` : null,
    listConnections: async (ownerId) => rows(await call(ownerId, 'finance_shortcut_list_connections'), connection),
    listInbox: async (ownerId) => rows(await call(ownerId, 'finance_shortcut_list_inbox'), inbox),
    listPending: async (ownerId, cursor: ShortcutPendingCursor | null) => pendingPage(await call(ownerId, 'finance_shortcut_list_pending', {
      p_before_created_at: cursor?.created_at ?? null, p_before_id: cursor?.id ?? null, p_limit: 100,
    })),
    create: async (ownerId, label, tokenHash) => connection(single(await call(ownerId, 'finance_shortcut_create', { p_label: label, p_token_hash: tokenHash }))),
    revoke: async (ownerId, id) => { await call(ownerId, 'finance_shortcut_revoke', { p_id: id }); },
    configure: async (ownerId, configuration) => {
      if (configuration.mode === 'auto' && configuration.stableEventIdConfirmed !== true) throw new ShortcutApiError('stable-event-id-required');
      return connection(single(await call(ownerId, 'finance_shortcut_configure', {
        p_id: configuration.id, p_account_id: configuration.accountId,
        p_category_id: configuration.categoryId, p_mode: configuration.mode,
        p_stable_event_id_confirmed: configuration.mode === 'auto' && configuration.stableEventIdConfirmed === true,
      })));
    },
    review: async (ownerId, review) => {
      const row = record(single(await call(ownerId, 'finance_shortcut_review', {
        p_id: review.id, p_action: review.action, p_account_id: review.accountId,
        p_category_id: review.categoryId, p_amount: review.amount, p_merchant: review.merchant,
        p_occurred_at: review.occurredAt,
      })));
      return { status: status(row.status), transaction_id: nullableText(row.transaction_id) };
    },
  };
}

export const shortcutApi = createShortcutApi({
  url: import.meta.env.VITE_SUPABASE_URL?.trim(),
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY?.trim(),
  getSession: async () => {
    if (!supabase) throw new ShortcutApiError('unavailable');
    return supabase.auth.getSession();
  },
  fetcher: (input, init) => globalThis.fetch(input, init),
});

export async function createShortcutSecret(): Promise<{ token: string; tokenHash: string }> {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) throw new ShortcutApiError('unavailable');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `shiba_sc_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return { token, tokenHash: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('') };
}
