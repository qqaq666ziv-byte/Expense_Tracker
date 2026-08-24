import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Pencil, Plus, Scale, Trash2, WalletCards } from 'lucide-react';
import type { BalanceAdjustment, FinanceData, Transaction } from '../domain/model';
import { buildLedgerHistory, calculateFinancials } from '../domain/financeEngine';
import { sortByDisplayOrder } from '../domain/displayOrder';
import { subtractMoney } from '../domain/money';
import { changedRecordMeta, newRecordMeta } from '../app/state';
import { money, parseRequiredNumberInput, shortDate, toLocalInput } from '../app/format';
import { completeAppliedMutation } from '../app/mutationResult';
import { FinanceIcon } from './FinanceIcon';

interface HomeViewProps {
  data: FinanceData;
  ownerId: string;
  put(entity: 'transactions', record: Transaction): boolean;
  putAdjustment(record: BalanceAdjustment): boolean;
  deleteTransaction(record: Transaction): boolean;
}

export function HomeView({ data, ownerId, put, putAdjustment, deleteTransaction }: HomeViewProps) {
  const ledgerPageSize = 30;
  const summary = useMemo(() => calculateFinancials(data), [data]);
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [occurredAt, setOccurredAt] = useState(toLocalInput());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [showAdjustment, setShowAdjustment] = useState(false);
  const [actualBalance, setActualBalance] = useState('');
  const [adjustmentAccount, setAdjustmentAccount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('盤點校正');
  const [adjustmentError, setAdjustmentError] = useState('');
  const [historyLimit, setHistoryLimit] = useState(ledgerPageSize);

  const activeAccounts = sortByDisplayOrder(data.accounts.filter((item) => item.isActive && !item.deletedAt));
  const accounts = sortByDisplayOrder(data.accounts.filter((item) => !item.deletedAt && (
    item.isActive || editing?.accountId === item.id
  )));
  const categories = sortByDisplayOrder(data.categories.filter((item) => !item.deletedAt && item.kind === type && (
    item.isActive || editing?.categoryId === item.id
  )));

  const resolvedCategoryId = categories.some((item) => item.id === categoryId) ? categoryId : categories[0]?.id ?? '';
  const resolvedAccountId = accounts.some((item) => item.id === accountId) ? accountId : accounts[0]?.id ?? '';

  const resetForm = () => {
    setAmount('');
    setNote('');
    setOccurredAt(toLocalInput());
    setEditing(null);
    setError('');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const numericAmount = parseRequiredNumberInput(amount);
    const category = data.categories.find((item) => item.id === resolvedCategoryId);
    const account = accounts.find((item) => item.id === resolvedAccountId);
    if (numericAmount === null || numericAmount <= 0) return setError('金額必須大於 0、最多兩位小數，且須在可安全精確處理的範圍內');
    if (!category || !account) return setError('請先建立可用的帳戶與分類');
    if (!occurredAt) return setError('請選擇交易時間');

    const record: Transaction = editing ? {
      ...editing,
      ...changedRecordMeta(editing),
      amount: numericAmount,
      type,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      occurredAt,
      note: note.trim() || undefined,
    } : {
      ...newRecordMeta(ownerId),
      amount: numericAmount,
      type,
      categoryId: category.id,
      categoryName: category.name,
      accountId: account.id,
      accountName: account.name,
      occurredAt,
      note: note.trim() || undefined,
    };
    completeAppliedMutation(put('transactions', record), resetForm, setError);
  };

  const beginEdit = (transaction: Transaction) => {
    setEditing(transaction);
    setType(transaction.type);
    setAmount(String(transaction.amount));
    setCategoryId(transaction.categoryId);
    setAccountId(transaction.accountId);
    setOccurredAt(transaction.occurredAt.slice(0, 16));
    setNote(transaction.note ?? '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submitAdjustment = (event: FormEvent) => {
    event.preventDefault();
    const accountIdToAdjust = adjustmentAccount || activeAccounts[0]?.id;
    const account = summary.accountBalances.find((item) => item.accountId === accountIdToAdjust);
    const target = parseRequiredNumberInput(actualBalance);
    if (!account || target === null) return setAdjustmentError('請輸入有效的實際餘額');
    const delta = subtractMoney(target, account.balance);
    if (delta === 0) return setAdjustmentError('實際餘額與系統餘額相同，不需校正');
    const applied = putAdjustment({
      ...newRecordMeta(ownerId),
      accountId: account.accountId,
      amountDelta: delta,
      occurredAt: toLocalInput(),
      reason: adjustmentReason.trim() || '餘額校正',
    });
    completeAppliedMutation(applied, () => {
      setActualBalance('');
      setShowAdjustment(false);
      setAdjustmentError('');
    }, setAdjustmentError);
  };

  const history = buildLedgerHistory(data);

  return (
    <div className="space-y-5">
      <section className="hero-card" aria-labelledby="total-assets-title">
        <div className="relative z-10">
          <p id="total-assets-title" className="text-sm font-bold text-white/75">總資產</p>
          <p className="mt-1 text-4xl font-black tracking-tight" data-testid="total-assets">{money.format(summary.totalAssets)}</p>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-2xl bg-white/12 p-3"><span className="block text-white/70">已配置儲蓄</span><strong>{money.format(summary.allocatedSavings)}</strong></div>
            <div className="rounded-2xl bg-white/12 p-3"><span className="block text-white/70">可配置資產</span><strong>{money.format(summary.availableAssets)}</strong></div>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="account-breakdown-title">
        <div className="section-heading">
          <div><p className="eyebrow">資產帳戶</p><h2 id="account-breakdown-title">帳戶餘額</h2></div>
          <button type="button" className="secondary-button" onClick={() => { setShowAdjustment((value) => !value); setAdjustmentError(''); }}><Scale className="h-4 w-4" />餘額校正</button>
        </div>
        <div className="divide-y divide-amber-100 dark:divide-zinc-800">
          {summary.accountBalances.filter((item) => item.isActive && item.includeInTotalAssets).map((item) => {
            const source = data.accounts.find((account) => account.id === item.accountId)!;
            return <div className="flex items-center justify-between py-3" key={item.accountId}><span className="flex items-center gap-3"><span className="icon-badge"><FinanceIcon icon={source.icon} /></span>{item.name}</span><strong>{money.format(item.balance)}</strong></div>;
          })}
        </div>
        {showAdjustment && (
          <form className="mt-3 grid gap-3 rounded-2xl bg-amber-50 p-4 dark:bg-zinc-800 sm:grid-cols-3" onSubmit={submitAdjustment}>
            <label className="field-label">帳戶<select aria-label="校正帳戶" className="field mt-1" value={adjustmentAccount || activeAccounts[0]?.id || ''} onChange={(event) => setAdjustmentAccount(event.target.value)}>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            <label className="field-label">實際餘額<input aria-label="實際餘額" aria-describedby="adjustment-error" aria-invalid={Boolean(adjustmentError)} className="field mt-1" inputMode="decimal" value={actualBalance} onChange={(event) => setActualBalance(event.target.value)} /></label>
            <label className="field-label">原因<input className="field mt-1" value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} /></label>
            <div id="adjustment-error" className="sm:col-span-3" aria-live="polite">{adjustmentError && <p className="error-message"><AlertTriangle className="h-4 w-4" />{adjustmentError}</p>}</div>
            <button className="primary-button sm:col-span-3" type="submit">建立可稽核校正紀錄</button>
          </form>
        )}
      </section>

      <section className="card" aria-labelledby="transaction-form-title">
        <div className="section-heading"><div><p className="eyebrow">快速記帳</p><h2 id="transaction-form-title">{editing ? '編輯交易' : '新增收支'}</h2></div><WalletCards className="h-7 w-7 text-amber-600" /></div>
        <div className="mb-4 grid grid-cols-2 rounded-2xl bg-amber-50 p-1 dark:bg-zinc-800" role="group" aria-label="交易類型">
          {(['expense', 'income'] as const).map((item) => <button key={item} type="button" className={`tab-button ${type === item ? 'tab-button-active' : ''}`} onClick={() => { setType(item); setCategoryId(''); }}>{item === 'expense' ? '支出' : '收入'}</button>)}
        </div>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <label className="field-label">金額<input aria-label="金額" className="field mt-1" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} /></label>
          <label className="field-label">日期時間<input aria-label="日期時間" type="datetime-local" className="field mt-1" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
          <label className="field-label">分類<select aria-label="分類" className="field mt-1" value={resolvedCategoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.icon.type === 'emoji' ? category.icon.value : '◈'} {category.name}</option>)}</select></label>
          <label className="field-label">資產帳戶<select aria-label="資產帳戶" className="field mt-1" value={resolvedAccountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.icon.type === 'emoji' ? account.icon.value : '◈'} {account.name}</option>)}</select></label>
          <label className="field-label sm:col-span-2">備註（選填）<input aria-label="備註" className="field mt-1" value={note} onChange={(event) => setNote(event.target.value)} /></label>
          {error && <p className="error-message sm:col-span-2"><AlertTriangle className="h-4 w-4" />{error}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <button className="primary-button flex-1" type="submit"><Plus className="h-4 w-4" />{editing ? '儲存交易' : '新增交易'}</button>
            {editing && <button className="secondary-button" type="button" onClick={resetForm}>取消</button>}
          </div>
        </form>
      </section>

      <section className="card" aria-labelledby="history-title">
        <div className="section-heading"><div><p className="eyebrow">完整帳本</p><h2 id="history-title">最近交易與校正</h2></div><span className="count-badge">{history.length}</span></div>
        {history.length === 0 ? <p className="empty-state">🐕 還沒有交易或校正，從上方記下第一筆吧。</p> : (
          <div className="space-y-2">
            {history.slice(0, historyLimit).map((entry) => {
              if (entry.kind === 'adjustment') {
                const adjustment = entry.record;
                const account = data.accounts.find((item) => item.id === adjustment.accountId);
                const sign = adjustment.amountDelta > 0 ? '+' : '−';
                return (
                  <article className="transaction-row" key={`adjustment:${adjustment.id}`} data-testid="adjustment-row">
                    <span className="icon-badge"><Scale className="h-5 w-5" aria-hidden="true" /></span>
                    <div className="min-w-0 flex-1"><p className="truncate font-bold">餘額校正 <span className="ml-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-700 dark:bg-sky-950 dark:text-sky-300">非收支</span></p><p className="truncate text-xs text-zinc-500">{account?.name ?? '未知帳戶'} · {shortDate(adjustment.occurredAt)}{adjustment.reason ? ` · ${adjustment.reason}` : ''}</p></div>
                    <strong className="text-sky-700 dark:text-sky-300">{sign}{money.format(Math.abs(adjustment.amountDelta))}</strong>
                  </article>
                );
              }
              const transaction = entry.record;
              const category = data.categories.find((item) => item.id === transaction.categoryId);
              const account = data.accounts.find((item) => item.id === transaction.accountId);
              return (
                <article className="transaction-row" key={transaction.id} data-testid="transaction-row">
                  <span className="icon-badge"><FinanceIcon icon={category?.icon ?? { type: 'emoji', value: '🧾' }} /></span>
                  <div className="min-w-0 flex-1"><p className="truncate font-bold">{category?.name ?? transaction.categoryName}</p><p className="truncate text-xs text-zinc-500">{account?.name ?? transaction.accountName} · {shortDate(transaction.occurredAt)}{transaction.note ? ` · ${transaction.note}` : ''}</p></div>
                  <strong className={transaction.type === 'income' ? 'text-emerald-600' : 'text-rose-600'}>{transaction.type === 'income' ? '+' : '-'}{money.format(transaction.amount)}</strong>
                  <button className="icon-button" type="button" aria-label={`編輯 ${category?.name ?? transaction.categoryName}`} onClick={() => beginEdit(transaction)}><Pencil className="h-4 w-4" /></button>
                  <button className="icon-button danger" type="button" aria-label={`刪除 ${category?.name ?? transaction.categoryName}`} onClick={() => { if (window.confirm('刪除此交易？同步完成後仍會保留 tombstone 防止復活。')) deleteTransaction(transaction); }}><Trash2 className="h-4 w-4" /></button>
                </article>
              );
            })}
            {historyLimit < history.length && (
              <button
                type="button"
                className="secondary-button w-full justify-center"
                onClick={() => setHistoryLimit((current) => Math.min(history.length, current + ledgerPageSize))}
              >
                載入更多歷史（剩餘 {history.length - historyLimit} 筆）
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
