import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Copy, Inbox, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { money, shortDate } from '../../app/format';
import type { FinanceData } from '../../domain/model';
import type { FinanceSyncOutcome } from '../../app/useFinanceApp';
import { parseShortcutNotification } from '../../../supabase/functions/_shared/shortcutNotification';
import { createShortcutSecret, shortcutApi, ShortcutApiError } from './api';
import { parseShortcutReviewAmount, reviewTimeInput, reviewTimeIso, shortcutParents, shortcutReason, SHORTCUT_TEST_TEMPLATE } from './model';
import type { ShortcutApi, ShortcutConfiguration, ShortcutConnection, ShortcutInboxItem, ShortcutPendingCursor, ShortcutReview } from './types';
import './shortcuts.css';

export interface ShortcutsPanelProps {
  ownerId: string;
  data: FinanceData;
  onSync: (transactionIds?: readonly string[]) => Promise<FinanceSyncOutcome>;
  onSignIn?: () => void;
  locked?: boolean;
  lockedAccountIds?: ReadonlySet<string>;
  lockedCategoryIds?: ReadonlySet<string>;
  api?: ShortcutApi;
}

type Section = 'setup' | 'test' | 'inbox' | 'connections';
const sections: { value: Section; label: string }[] = [
  { value: 'setup', label: '連接 iPhone' }, { value: 'test', label: '通知測試' },
  { value: 'inbox', label: '通知收件匣' }, { value: 'connections', label: '連線管理' },
];

/** Remount synchronously on an owner change: secrets, drafts and outstanding results cannot cross accounts. */
export function ShortcutsPanel(props: ShortcutsPanelProps) {
  return <Fragment key={props.ownerId}><OwnerShortcutsPanel {...props} /></Fragment>;
}

function OwnerShortcutsPanel({
  ownerId, data, onSync, onSignIn, locked = false,
  lockedAccountIds, lockedCategoryIds, api = shortcutApi,
}: ShortcutsPanelProps) {
  const guest = !ownerId || ownerId === 'guest';
  const [section, setSection] = useState<Section>('setup');
  const [connections, setConnections] = useState<ShortcutConnection[]>([]);
  const [inbox, setInbox] = useState<ShortcutInboxItem[]>([]);
  const [pendingCursor, setPendingCursor] = useState<ShortcutPendingCursor | null>(null);
  const [pendingHasMore, setPendingHasMore] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [label, setLabel] = useState('我的 iPhone');
  const [secret, setSecret] = useState<{ connectionId: string; token: string } | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{ label: string; token: string; tokenHash: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const syncedImportsRef = useRef(new Set<string>());
  const syncingImportsRef = useRef(new Set<string>());
  const locksRef = useRef(locked);
  locksRef.current = locked;
  const parents = shortcutParents(data, ownerId, lockedAccountIds, lockedCategoryIds);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const syncImported = useCallback(async (items: ShortcutInboxItem[]) => {
    const transactionIds = [...new Set(items.filter((item) => item.status === 'imported' && item.transaction_id)
      .map((item) => item.transaction_id!))].filter((id) => !data.transactions.some((row) => row.id === id)
        && !syncedImportsRef.current.has(id) && !syncingImportsRef.current.has(id));
    if (!transactionIds.length) return;
    transactionIds.forEach((id) => syncingImportsRef.current.add(id));
    try {
      const outcome = await onSync(transactionIds);
      const confirmed = new Set(outcome.status === 'synced' ? outcome.confirmedTransactionIds : []);
      transactionIds.filter((id) => confirmed.has(id)).forEach((id) => syncedImportsRef.current.add(id));
      if (transactionIds.some((id) => !confirmed.has(id))) throw new Error('finance_sync_not_confirmed');
    } finally {
      transactionIds.forEach((id) => syncingImportsRef.current.delete(id));
    }
  }, [data.transactions, onSync]);

  const refreshData = useCallback(async () => {
    const [nextConnections, nextInbox, pending] = await Promise.all([
      api.listConnections(ownerId), api.listInbox(ownerId), api.listPending(ownerId, null),
    ]);
    if (!alive.current) return;
    setConnections(nextConnections);
    const combined = [...new Map([...pending.items, ...nextInbox].map((item) => [item.id, item])).values()];
    setInbox(combined);
    setPendingCount(pending.pending_count);
    setPendingHasMore(pending.has_more);
    setPendingCursor(pending.has_more && pending.next_created_at && pending.next_id
      ? { created_at: pending.next_created_at, id: pending.next_id } : null);
    setLoaded(true);
    await syncImported(nextInbox);
  }, [api, ownerId, syncImported]);

  const loadMorePending = useCallback(async () => {
    if (!pendingCursor || !pendingHasMore) return;
    const page = await api.listPending(ownerId, pendingCursor);
    if (!alive.current) return;
    setInbox((previous) => [...new Map([...previous, ...page.items].map((item) => [item.id, item])).values()]);
    setPendingCount(page.pending_count);
    setPendingHasMore(page.has_more);
    setPendingCursor(page.has_more && page.next_created_at && page.next_id
      ? { created_at: page.next_created_at, id: page.next_id } : null);
  }, [api, ownerId, pendingCursor, pendingHasMore]);

  const run = useCallback(async (action: () => Promise<void>, mutation = true) => {
    if (guest || busyRef.current || (mutation && locksRef.current) || !alive.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (caught) {
      if (alive.current) setError(caught instanceof ShortcutApiError ? caught.message : '操作結果尚未確認。請重新整理雲端狀態後再試。');
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [guest]);

  useEffect(() => {
    if (!guest) void run(refreshData, false);
  }, [guest, refreshData, run]);

  const copy = async (value: string, feedback: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (alive.current) { setMessage(feedback); setError(''); }
    } catch {
      if (alive.current) setError('無法自動複製，請選取欄位內容手動複製。');
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!pendingCreate && !label.trim()) { setError('請輸入連線名稱。'); return; }
    void run(async () => {
      const pending = pendingCreate ?? { label: label.trim(), ...await createShortcutSecret() };
      if (!alive.current || locksRef.current) return;
      setPendingCreate(pending);
      const connection = await api.create(ownerId, pending.label, pending.tokenHash);
      if (!alive.current) return;
      setPendingCreate(null);
      setSecret({ connectionId: connection.id, token: pending.token });
      setConnections((previous) => [connection, ...previous]);
      setMessage('連線已建立。請現在複製金鑰；離開此頁後將無法再次查看。');
    });
  };

  const configure = (configuration: ShortcutConfiguration) => run(async () => {
    const updated = await api.configure(ownerId, configuration);
    if (!alive.current) return;
    setConnections((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    setMessage('連線設定已儲存。');
  });

  const revoke = (id: string) => run(async () => {
    await api.revoke(ownerId, id);
    if (!alive.current) return;
    setSecret((previous) => previous?.connectionId === id ? null : previous);
    setConnections((previous) => previous.map((item) => item.id === id ? { ...item, revoked_at: new Date().toISOString() } : item));
    setMessage('連線已停用，舊金鑰無法再傳入通知。需要重連時可建立新連線。');
  }, false);

  const review = (draft: ShortcutReview) => run(async () => {
    const result = await api.review(ownerId, draft);
    if (!alive.current) return;
    setInbox((previous) => previous.map((item) => item.id === draft.id ? { ...item, ...result } : item));
    if (result.status === 'imported') {
      try {
        const outcome = await onSync(result.transaction_id ? [result.transaction_id] : []);
        if (result.transaction_id && (outcome.status !== 'synced' || !outcome.confirmedTransactionIds.includes(result.transaction_id))) {
          throw new Error('finance_sync_not_confirmed');
        }
        if (result.transaction_id) syncedImportsRef.current.add(result.transaction_id);
      } catch {
        if (alive.current) setMessage('此筆已在雲端入帳；本機帳本尚未更新，請恢復連線後同步，勿另行新增同一筆。');
        return;
      }
      if (!alive.current) return;
      setMessage('此筆已在雲端入帳，已要求更新帳本。');
    } else {
      setMessage('此通知已略過，不會影響帳戶餘額。');
    }
    await refreshData();
  });

  return (
    <div className="shortcut-panel">
      <section className="card shortcut-intro">
        <div className="section-heading">
          <div><p className="eyebrow">從通知開始，先確認再入帳</p><h2><Smartphone size={21} aria-hidden="true" /> iPhone 捷徑記帳</h2></div>
          <span className="shortcut-badge">街口支付</span>
        </div>
        <p>把消費通知送進收件匣，確認實際扣款帳戶與金額。先核對含來源 ID 的相容通知，再自行於 iPhone 重送測試，確認同一通知的 ID 不變，才能開啟自動入帳。</p>
        <p className="shortcut-muted">目前仍需在你的 iPhone 驗證通知內容與背景執行。App 內的通知截圖，不能證明捷徑能取得同樣的文字。此連線確認的是通知文字格式，並非街口提供的交易簽章。</p>
        {guest && <div className="info-banner"><span>登入後才能將捷徑連接到你的雲端帳本；現在可先做本機通知測試。</span>{onSignIn && <button type="button" className="secondary-button" onClick={onSignIn}>前往登入</button>}</div>}
        {locked && !guest && <p className="warning-message">請先完成帳本同步或處理待確認的資料，再變更連線或入帳。</p>}
      </section>
      <div className="shortcut-tabs" aria-label="捷徑記帳功能">
        {sections.map((item) => <button type="button" key={item.value} className={`tab-button ${section === item.value ? 'tab-button-active' : ''}`} aria-pressed={section === item.value} onClick={() => setSection(item.value)}>{item.label}{item.value === 'inbox' && pendingCount > 0 ? ` (${pendingCount})` : ''}</button>)}
      </div>
      {message && <p className="success-message" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {section === 'setup' && <section className="card shortcut-stack">
        <div><h3>1. 建立你的連線</h3><p className="shortcut-muted">金鑰只用於此連線的通知接收，可隨時在連線管理停用。不要把金鑰貼進網址、公開捷徑或聊天。</p></div>
        <form className="shortcut-inline-form" onSubmit={create}>
          <label className="field-label">連線名稱<input className="field" maxLength={64} autoComplete="off" value={pendingCreate?.label ?? label} onChange={(event) => setLabel(event.target.value)} disabled={guest || busy || locked || !!pendingCreate} /></label>
          <button className="primary-button" disabled={guest || busy || locked || !api.endpoint || !!secret} type="submit">{busy ? '處理中…' : pendingCreate ? '以相同金鑰重試' : '建立連線與金鑰'}</button>
        </form>
        {pendingCreate && <p className="warning-message">連線結果尚未確認。恢復網路後，請留在此頁並以相同金鑰重試；這個金鑰只暫存在目前頁面，離開頁面後無法恢復。</p>}
        {secret && <div className="shortcut-secret shortcut-stack">
          <label className="field-label">一次性顯示的捷徑金鑰<textarea className="field shortcut-code" readOnly value={secret.token} rows={2} spellCheck={false} autoComplete="off" /></label>
          <p>請貼入 iPhone 捷徑的 Authorization 標頭，格式為 <code>Bearer 金鑰</code>。複製後請妥善保管；忘記時需停用舊連線再建立新的。</p>
          <div className="shortcut-actions"><button type="button" className="secondary-button" onClick={() => void copy(`Bearer ${secret.token}`, 'Authorization 標頭已複製，請貼到你的私人捷徑。')}><Copy size={16} aria-hidden="true" />複製 Authorization</button><button type="button" className="secondary-button" onClick={() => setSecret(null)}>已保存，隱藏金鑰</button></div>
        </div>}
        <div><h3>2. 在 iPhone 建立通知自動化</h3>
          <ol className="shortcut-steps">
            <li>打開「捷徑」→「自動化」，選擇街口支付的通知觸發。先檢查捷徑是否真的能取得通知標題及內文；若拿不到內文，先停在通知測試，不要開啟自動入帳。</li>
            <li>加入「取得 URL 的內容」，方法選 POST，將下方接收網址貼入 URL。</li>
            <li>標頭加入 <code>Content-Type: application/json</code> 及剛才複製的 <code>Authorization: Bearer 金鑰</code>。</li>
            <li>要求本文選 JSON，依下方範本加入欄位。title 與 text 要插入真正的通知變數，test 要用布林值「真」，不是文字。</li>
            <li>用真實通知執行一次，回到「通知收件匣」重新整理。測試只留下接收結果，不會記帳。確認欄位完整後，把 test 改成布林值「假」；新通知會先待確認。</li>
          </ol>
        </div>
        <label className="field-label">捷徑接收網址<input className="field shortcut-code" readOnly value={api.endpoint ?? ''} placeholder="此環境尚未設定接收網址" /></label>
        <div className="shortcut-actions"><button type="button" className="secondary-button" disabled={!api.endpoint} onClick={() => void copy(api.endpoint!, '接收網址已複製。')}>複製接收網址</button><button type="button" className="secondary-button" onClick={() => void copy(SHORTCUT_TEST_TEMPLATE, '測試 JSON 範本已複製，請將標題與內文替換為捷徑通知變數。')}>複製測試 JSON</button></div>
        <details><summary>查看測試 JSON 範本</summary><pre className="shortcut-code">{SHORTCUT_TEST_TEMPLATE}</pre></details>
        <p className="shortcut-muted">這份範本先使用收件匣確認。只有通知來源提供同一筆消費重送時不變的識別碼，才可加入 eventId；沒有就省略。不要用每次產生的 UUID 或目前時間代替交易識別碼。</p>
        <p className="warning-message">通知沒有銀行實際扣款來源時，需要你指定帳戶。儲值、折抵、退款與多金額通知會保留給你確認；不會把儲值再算一次支出。</p>
      </section>}
      {section === 'test' && <LocalNotificationTest />}
      {section === 'inbox' && <section className="card shortcut-stack">
        <div className="section-heading"><div><p className="eyebrow">先核對，餘額才會改變</p><h2><Inbox size={21} aria-hidden="true" /> 通知收件匣</h2></div><button type="button" className="secondary-button" disabled={guest || busy} onClick={() => void run(refreshData, false)}><RefreshCw size={16} aria-hidden="true" />重新整理</button></div>
        <p className="shortcut-muted">顯示最近 100 筆接收結果及所有待確認項目（每頁最多 100 筆）。只有「已入帳」會影響帳本；未收到通知或捷徑失敗時，請比對支付明細補記。</p>
        {guest ? <p className="empty-state">登入後即可查看你的通知收件匣。</p> : !loaded ? <p className="empty-state">{busy ? '正在讀取通知…' : '尚未取得收件匣，請重新整理。'}</p> : inbox.length === 0 ? <p className="empty-state">還沒有通知。先從 iPhone 傳入一則測試，再按重新整理。</p> : inbox.map((item) => <Fragment key={`${item.id}:${item.status}`}><InboxCard item={item} parents={parents} disabled={busy || locked} onReview={review} /></Fragment>)}
        {pendingHasMore && <button type="button" className="secondary-button" disabled={busy || guest} onClick={() => void run(loadMorePending, false)}>載入更多待確認項目</button>}
      </section>}
      {section === 'connections' && <section className="card shortcut-stack">
        <div className="section-heading"><div><p className="eyebrow">每支手機各用一組金鑰</p><h2><ShieldCheck size={21} aria-hidden="true" /> 連線管理</h2></div><button type="button" className="secondary-button" disabled={guest || busy} onClick={() => void run(refreshData, false)}><RefreshCw size={16} aria-hidden="true" />重新整理</button></div>
        <p className="shortcut-muted">只可有一個啟用自動入帳的連線，其他連線使用待確認。要更換手機，請先把舊連線改為「先確認再入帳」，不會替你停用其他連線。</p>
        {guest ? <p className="empty-state">請登入後建立連線。</p> : connections.length === 0 ? <p className="empty-state">{busy ? '正在讀取連線…' : '尚無可顯示的連線，可從「連接 iPhone」開始。'}</p> : connections.map((item) => <Fragment key={`${item.id}:${item.account_id}:${item.category_id}:${item.mode}:${item.verified_at}:${item.revoked_at}`}><ConnectionCard item={item} parents={parents} disabled={busy || locked} revokeDisabled={busy} anotherAutoConnection={connections.some((other) => other.id !== item.id && !other.revoked_at && other.mode === 'auto')} onConfigure={configure} onRevoke={revoke} /></Fragment>)}
      </section>}
    </div>
  );
}

type Parents = ReturnType<typeof shortcutParents>;

function ParentFields({ parents, account, category, setAccount, setCategory, disabled }: {
  parents: Parents; account: string; category: string; setAccount: (value: string) => void;
  setCategory: (value: string) => void; disabled: boolean;
}) {
  return <div className="shortcut-fields">
    <label className="field-label">扣款帳戶<select className="field" value={parents.accounts.some((item) => item.id === account) ? account : ''} onChange={(event) => setAccount(event.target.value)} disabled={disabled}><option value="">請選擇實際扣款帳戶</option>{parents.accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label className="field-label">支出分類<select className="field" value={parents.categories.some((item) => item.id === category) ? category : ''} onChange={(event) => setCategory(event.target.value)} disabled={disabled}><option value="">請選擇分類</option>{parents.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
  </div>;
}

function ConnectionCard({ item, parents, disabled, revokeDisabled, anotherAutoConnection, onConfigure, onRevoke }: {
  item: ShortcutConnection; parents: Parents; disabled: boolean; revokeDisabled: boolean; anotherAutoConnection: boolean;
  onConfigure: (configuration: ShortcutConfiguration) => Promise<void>; onRevoke: (id: string) => Promise<void>;
}) {
  const [account, setAccount] = useState(item.account_id ?? '');
  const [category, setCategory] = useState(item.category_id ?? '');
  const [mode, setMode] = useState(item.mode);
  const [stableEventIdConfirmed, setStableEventIdConfirmed] = useState(false);
  const [error, setError] = useState('');
  const canAuto = !!item.verified_at && !!item.verified_format;
  const validAccount = parents.accounts.some((row) => row.id === account);
  const validCategory = parents.categories.some((row) => row.id === category);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if ((account && !validAccount) || (category && !validCategory)) { setError('帳戶或分類已不可用，請重新選擇。'); return; }
    if (mode === 'auto' && (!canAuto || !validAccount || !validCategory)) { setError('自動入帳需要已人工核對的相容通知、扣款帳戶與分類。'); return; }
    if (mode === 'auto' && anotherAutoConnection) { setError('已有另一個啟用自動入帳的連線，請先將該連線改為待確認。'); return; }
    if (mode === 'auto' && !stableEventIdConfirmed) { setError('請先在 iPhone 重送測試，確認同一通知的來源 ID 不變，並勾選確認。'); return; }
    setError('');
    setStableEventIdConfirmed(false);
    void onConfigure({ id: item.id, accountId: account || null, categoryId: category || null, mode, stableEventIdConfirmed: mode === 'auto' && stableEventIdConfirmed });
  };
  return <article className="shortcut-item shortcut-stack">
    <div className="shortcut-item-title"><h3>{item.label}</h3><span className="shortcut-badge">{item.revoked_at ? '已停用' : item.mode === 'auto' ? '相容通知自動入帳' : '先確認再入帳'}</span></div>
    <p className="shortcut-muted">建立於 {shortDate(item.created_at)}</p>
    {!item.revoked_at && <form className="shortcut-stack" onSubmit={save}>
      <ParentFields parents={parents} account={account} category={category} setAccount={setAccount} setCategory={setCategory} disabled={disabled} />
      <label className="field-label">入帳方式<select className="field" value={mode} disabled={disabled} onChange={(event) => { setMode(event.target.value as 'review' | 'auto'); setStableEventIdConfirmed(false); }}><option value="review">先確認再入帳</option><option value="auto" disabled={!canAuto || anotherAutoConnection}>相容通知自動入帳</option></select></label>
      <p className="shortcut-muted">{canAuto ? '你已核對含來源 ID 的相容通知。ID 重送時是否不變，仍需由你在 iPhone 測試確認；本網站無法替街口驗證來源 ID 的穩定性。缺少 ID、不同格式、儲值、折抵或疑似重複仍會待確認。' : '尚未從收件匣確認含來源 ID 的相容通知。請先從 iPhone 傳入通知並人工核對；測試、多金額或沒有來源 ID 的通知不會解鎖自動入帳。'}</p>
      {anotherAutoConnection && <p className="warning-message">另一個連線正在自動入帳。目前連線可先使用待確認。</p>}
      {mode === 'auto' && <label className="shortcut-confirmation"><input type="checkbox" checked={stableEventIdConfirmed} disabled={disabled || !canAuto || anotherAutoConnection} onChange={(event) => setStableEventIdConfirmed(event.target.checked)} /><span>我已在 iPhone 重送測試，確認同一通知的來源 ID 不變<small>每次儲存自動入帳設定都需重新勾選。這是你的實機確認，不代表街口或本網站已驗證 ID。</small></span></label>}
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="shortcut-actions"><button type="submit" className="primary-button" disabled={disabled}>儲存連線設定</button><button type="button" className="secondary-button" disabled={revokeDisabled} onClick={() => void onRevoke(item.id)}>停用此連線</button></div>
    </form>}
  </article>;
}

function InboxCard({ item, parents, disabled, onReview }: {
  item: ShortcutInboxItem; parents: Parents; disabled: boolean; onReview: (review: ShortcutReview) => Promise<void>;
}) {
  const [account, setAccount] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState(item.amount === null ? '' : String(item.amount));
  const [merchant, setMerchant] = useState(item.merchant);
  const [time, setTime] = useState(reviewTimeInput(item.occurred_at));
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedAmount = parseShortcutReviewAmount(amount);
    const occurredAt = reviewTimeIso(time, item.occurred_at);
    if (!parents.accounts.some((row) => row.id === account) || !parents.categories.some((row) => row.id === category)) { setError('請明確選擇目前可用的扣款帳戶與支出分類。'); return; }
    if (parsedAmount === null) { setError('請輸入大於 0 且最多兩位小數的金額，不要包含逗號或貨幣符號。'); return; }
    if (!occurredAt) { setError('請填入有效的消費日期與時間。'); return; }
    if (!merchant.trim() || merchant.trim().length > 160) { setError('請填入 160 字以內的商家或用途。'); return; }
    setError('');
    void onReview({ id: item.id, action: 'approve', accountId: account, categoryId: category, amount: parsedAmount, merchant: merchant.trim(), occurredAt });
  };
  const labels = { pending: '待確認', imported: '已入帳', ignored: '已略過', test: '測試，未入帳' };
  return <article className="shortcut-item shortcut-stack">
    <div className="shortcut-item-title"><h3>{item.merchant || item.payload.title || '街口通知'}</h3><span className={`shortcut-badge shortcut-badge-${item.status}`}>{labels[item.status]}</span></div>
    <p>{item.amount !== null ? <strong>{money.format(item.amount)}</strong> : '金額待確認'}{item.occurred_at ? ` · ${shortDate(item.occurred_at)}` : ' · 消費時間待確認'}</p>
    <p className="shortcut-muted">{item.status === 'test' ? '接收測試已抵達，這筆不能轉為正式交易。確認內容後，請讓捷徑以 test=false 傳送新通知。' : item.status === 'imported' ? '此筆已寫入雲端帳本，請勿另行新增同一筆。' : item.status === 'ignored' ? '你已略過這筆通知，帳戶餘額不受影響。' : shortcutReason(item.reason)}</p>
    <details><summary>查看原始通知</summary><div className="shortcut-notice"><strong>{item.payload.title}</strong><p>{item.payload.text || '未提供通知內文'}</p></div></details>
    {item.status === 'pending' && <form className="shortcut-stack" onSubmit={submit}>
      <ParentFields parents={parents} account={account} category={category} setAccount={setAccount} setCategory={setCategory} disabled={disabled} />
      <div className="shortcut-fields"><label className="field-label">確認支出金額（TWD）<input className="field" inputMode="decimal" type="text" maxLength={24} value={amount} onChange={(event) => setAmount(event.target.value)} disabled={disabled} /></label><label className="field-label">消費時間（本機時區）<input className="field" type="datetime-local" value={time} onChange={(event) => setTime(event.target.value)} disabled={disabled} /></label></div>
      <label className="field-label">商家／用途<input className="field" maxLength={160} value={merchant} onChange={(event) => setMerchant(event.target.value)} disabled={disabled} /></label>
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="shortcut-actions"><button type="submit" className="primary-button" disabled={disabled}>確認入帳</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => void onReview({ id: item.id, action: 'ignore', accountId: null, categoryId: null, amount: null, merchant: null, occurredAt: null })}>略過，不入帳</button></div>
    </form>}
  </article>;
}

function LocalNotificationTest() {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ReturnType<typeof parseShortcutNotification> | null>(null);
  const test = (event: FormEvent) => {
    event.preventDefault();
    setResult(parseShortcutNotification({ source: 'jkopay', title, text }));
  };
  return <section className="card shortcut-stack">
    <div className="section-heading"><div><p className="eyebrow">不必登入，也不會上傳</p><h2>先看看通知能讀到什麼</h2></div></div>
    <p className="shortcut-muted">貼上通知文字即可在此裝置解析。可先遮掉姓名、帳號等資訊；保留金額格式與固定文字。這個測試不會寫入帳本，也不會解鎖自動入帳。</p>
    <form className="shortcut-stack" onSubmit={test}>
      <label className="field-label">通知標題<input className="field" value={title} maxLength={256} autoComplete="off" onChange={(event) => { setTitle(event.target.value); setResult(null); }} placeholder="例如：扣款通知" /></label>
      <label className="field-label">通知內文<textarea className="field" value={text} maxLength={2000} rows={6} onChange={(event) => { setText(event.target.value); setResult(null); }} placeholder="貼上街口支付通知的文字" /></label>
      <button type="submit" className="primary-button" disabled={!text.trim()}>在此裝置測試</button>
    </form>
    {result && <div className="shortcut-test-result shortcut-stack" role="status">
      <h3>{result.autoEligible ? '文字符合可辨識格式' : '需要人工確認'}</h3>
      <dl><div><dt>建議金額</dt><dd>{result.amount ? `NT$ ${result.amount}` : '無法確認'}</dd></div><div><dt>商家</dt><dd>{result.merchant || '無法確認'}</dd></div><div><dt>消費時間</dt><dd>{result.occurredAt ? shortDate(result.occurredAt) : '無法確認'}</dd></div></dl>
      <p>{result.autoEligible ? '仍需從你的 iPhone 傳送真實通知並確認入帳，才能驗證整段流程。' : shortcutReason(result.reason)}</p>
      <p className="shortcut-muted">僅本機解析，未上傳、未入帳。</p>
    </div>}
  </section>;
}
