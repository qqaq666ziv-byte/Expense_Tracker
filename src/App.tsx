import { lazy, Suspense, useEffect, useState } from 'react';
import { BarChart3, Cloud, CloudOff, Download, Home, LogIn, LogOut, RefreshCw, Settings, Target } from 'lucide-react';
import { useTheme } from './context/ThemeContext';
import { useFinanceApp } from './app/useFinanceApp';
import { changedRecordMeta } from './app/state';
import type { FinanceData, LegacyAuthenticatedBootstrap } from './domain/model';
import { exportFinanceBackup } from './domain/backup';
import { calculateFinancials } from './domain/financeEngine';
import { money } from './app/format';
import { HomeView } from './components/HomeView';

const InsightsView = lazy(() => import('./components/InsightsView').then((module) => ({ default: module.InsightsView })));
const PlanningView = lazy(() => import('./components/PlanningView').then((module) => ({ default: module.PlanningView })));
const SettingsView = lazy(() => import('./components/SettingsView').then((module) => ({ default: module.SettingsView })));

type Tab = 'home' | 'insights' | 'planning' | 'settings';

interface LegacyBootstrapPanelProps {
  bootstrap: LegacyAuthenticatedBootstrap;
  syncBusy: boolean;
  onSync(): void;
  onDownload(): void;
  onImport(): void;
  onKeepCloud(): void;
}

function candidateRecordCount(data: FinanceData): number {
  return data.accounts.length
    + data.categories.length
    + data.transactions.length
    + data.adjustments.length
    + data.goals.length
    + data.allocations.length
    + data.budgets.length
    + data.recurringRules.length;
}

export function LegacyBootstrapPanel({
  bootstrap,
  syncBusy,
  onSync,
  onDownload,
  onImport,
  onKeepCloud,
}: LegacyBootstrapPanelProps) {
  if (bootstrap.status === 'pending') {
    return <section className="warning-banner" role="status" aria-live="polite"><div><strong>舊版本機資料正在先讀取雲端</strong><p>為避免將這台裝置的過期快取重新上傳，完成雲端對齊前已停止帳本新增、修改、刪除與備份還原。</p></div><button type="button" className="secondary-button" disabled={syncBusy} onClick={onSync}>{syncBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}{syncBusy ? '正在讀取雲端' : '立即讀取雲端'}</button></section>;
  }

  const recordCount = candidateRecordCount(bootstrap.candidate);
  const unsyncedCount = bootstrap.unsyncedTransactionIds.length;
  return <section className="warning-banner" aria-labelledby="legacy-candidate-title"><div className="min-w-0 flex-1"><strong id="legacy-candidate-title">找到舊版本機候選資料</strong><p>雲端帳本已安全讀取。本機候選共 {recordCount} 筆，其中 {unsyncedCount} 筆舊交易曾標記為未同步；目前尚未上傳。請先下載備份審閱，再明確選擇匯入或保留雲端。</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className="secondary-button" onClick={onDownload}><Download className="h-4 w-4" />下載候選備份</button><button type="button" className="primary-button" disabled={syncBusy} onClick={() => {
    if (window.confirm('匯入會以舊版候選帳本明確取代目前讀取的雲端帳本，並建立待同步新增、更新與刪除作業。這可能重新加入曾在其他裝置刪除的記錄。確定匯入候選資料？')) onImport();
  }}>匯入候選資料</button><button type="button" className="secondary-button" disabled={syncBusy} onClick={() => {
    if (window.confirm('將保留目前雲端帳本並移除這份候選提示；舊版候選不會上傳。若尚未下載備份，建議先取得備份。確定保留雲端資料？')) onKeepCloud();
  }}>保留雲端資料</button></div></div></section>;
}

function downloadJson(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const app = useFinanceApp();
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState<Tab>('home');
  const [online, setOnline] = useState(navigator.onLine);
  const [authMessage, setAuthMessage] = useState('');

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  const data = app.state.data;
  const pending = app.state.outbox.length;
  const legacyBootstrap = app.state.legacyBootstrap;
  const legacyPending = legacyBootstrap?.status === 'pending';
  const downloadLegacyCandidate = () => {
    if (!legacyBootstrap) return;
    try {
      downloadJson(
        `shiba-finance-legacy-candidate-${Date.now()}.json`,
        exportFinanceBackup(legacyBootstrap.candidate),
      );
      setAuthMessage('');
    } catch (error) {
      setAuthMessage(`候選備份未匯出：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const syncLabel = app.state.ownerId === 'guest'
    ? '僅此裝置'
    : legacyPending
      ? app.syncBusy ? '正在先讀取雲端' : '先讀取雲端'
      : !online
        ? `離線 · 待傳 ${pending}`
        : pending > 0 ? `待同步 ${pending}` : '已同步';
  const archiveAccount = (record: FinanceData['accounts'][number]) => {
    const balance = calculateFinancials(data).accountBalances.find((item) => item.accountId === record.id)?.balance ?? 0;
    const transactionCount = data.transactions.filter((item) => !item.deletedAt && item.accountId === record.id).length;
    const recurringCount = data.recurringRules.filter((rule) => !rule.deletedAt && rule.isActive && rule.accountId === record.id).length;
    const impact = [
      record.includeInTotalAssets ? `總資產將排除目前餘額 ${money.format(balance)}` : '此帳戶原本未納入總資產',
      `${transactionCount} 筆歷史交易仍會保留`,
      recurringCount > 0 ? `${recurringCount} 條進行中的週期規則會一併暫停` : '沒有進行中的週期規則',
    ].join('；');
    if (!window.confirm(`確定封存「${record.name}」？${impact}。`)) return false;
    // Queue dependent pauses first. If connectivity drops between operations,
    // the safe partial state is an active parent with paused rules.
    for (const rule of data.recurringRules
      .filter((item) => !item.deletedAt && item.isActive && item.accountId === record.id)) {
      if (!app.put('recurringRules', { ...rule, ...changedRecordMeta(rule), isActive: false })) return false;
    }
    return app.put('accounts', { ...record, ...changedRecordMeta(record), isActive: false });
  };
  const archiveCategory = (record: FinanceData['categories'][number]) => {
    const recurringCount = data.recurringRules.filter((rule) => !rule.deletedAt && rule.isActive && rule.categoryId === record.id).length;
    if (recurringCount > 0 && !window.confirm(`封存「${record.name}」會同時暫停 ${recurringCount} 條週期規則；歷史交易仍會保留。是否繼續？`)) return false;
    for (const rule of data.recurringRules
      .filter((item) => !item.deletedAt && item.isActive && item.categoryId === record.id)) {
      if (!app.put('recurringRules', { ...rule, ...changedRecordMeta(rule), isActive: false })) return false;
    }
    return app.put('categories', { ...record, ...changedRecordMeta(record), isActive: false });
  };
  const nav: { key: Tab; label: string; icon: typeof Home }[] = [
    { key: 'home', label: '首頁', icon: Home },
    { key: 'insights', label: '分析', icon: BarChart3 },
    { key: 'planning', label: '規劃', icon: Target },
    { key: 'settings', label: '管理', icon: Settings },
  ];

  return (
    <div className="min-h-screen pb-24 text-zinc-900 dark:text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-amber-100/80 bg-[#fffaf0]/90 backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <button type="button" className="flex min-w-0 items-center gap-3 text-left" onClick={toggleTheme} aria-label="切換柴犬或米克斯主題">
            <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-amber-300 to-orange-500 text-2xl shadow-sm">{theme.mascotAvatarType === 'image' ? <img className="h-full w-full object-cover" src={theme.mascotAvatar} alt="" /> : theme.mascotAvatar}</span>
            <span className="min-w-0"><strong className="block truncate text-lg">{theme.welcomeTitle}</strong><span className="block truncate text-xs text-zinc-500">總資產由真實資產帳戶帳本衍生</span></span>
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className="status-pill" disabled={app.state.ownerId === 'guest' || app.syncBusy} onClick={() => void app.syncNow()} title={app.state.lastSyncError ?? '同步狀態'} aria-label={syncLabel}>
              {!online ? <CloudOff className="h-4 w-4" /> : app.syncBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
              {pending > 0 && <span className="sm:hidden">{pending}</span>}
              <span className="hidden sm:inline">{syncLabel}</span>
            </button>
            {app.user ? <button type="button" className="icon-button" aria-label="登出" onClick={() => void app.signOut().catch((error) => setAuthMessage(String(error)))}><LogOut className="h-5 w-5" /></button> : <button type="button" className="icon-button" aria-label="使用 Google 登入" disabled={!app.cloudEnabled || app.authLoading} onClick={() => void app.signIn().catch((error) => setAuthMessage(String(error)))}><LogIn className="h-5 w-5" /></button>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        {!app.cloudEnabled && <div className="info-banner"><CloudOff className="h-5 w-5" /><span><strong>訪客離線模式</strong><br />尚未設定 Supabase 公開環境變數；資料仍會依訪客身分保存在這台裝置。</span></div>}
        {authMessage && <div className="error-message mb-4">{authMessage}</div>}
        {app.storageRecovery ? <div className="warning-banner"><div><strong>本機快照已進入復原保護</strong><p>{app.storageError} 請先下載原始快照，再從「管理 → 備份」還原有效備份；成功還原前已封鎖帳本修改、週期補登與遠端同步，且不會覆寫原始 key。</p></div><button type="button" className="secondary-button" onClick={() => {
          const url = URL.createObjectURL(new Blob([app.storageRecovery!.raw], { type: 'application/json' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = `shiba-finance-recovery-${Date.now()}.json`;
          link.click();
          URL.revokeObjectURL(url);
        }}>下載原始快照</button></div> : app.storageError && <div className="warning-banner"><div><strong>本機儲存失敗</strong><p>{app.storageError}。請立即從「管理 → 備份」匯出 JSON，避免關閉頁面後遺失尚未落盤的變更。</p></div></div>}
        {app.guestImportNotice && <div className="info-banner"><span><strong>訪客資料匯入結果</strong><br />{app.guestImportNotice}</span></div>}
        {app.legacyBootstrapNotice && <div className="info-banner" aria-live="polite"><span><strong>舊版資料處理結果</strong><br />{app.legacyBootstrapNotice}</span></div>}
        {app.safetyNotice && <div className="warning-banner" role="alert"><div><strong>操作未執行</strong><p>{app.safetyNotice}。請確認目前帳號後重試。</p></div></div>}
        {legacyBootstrap && <LegacyBootstrapPanel bootstrap={legacyBootstrap} syncBusy={app.syncBusy} onSync={() => void app.syncNow()} onDownload={downloadLegacyCandidate} onImport={app.importLegacyCandidate} onKeepCloud={app.keepCloudData} />}
        {app.hasSeparateGuestData && <div className="warning-banner"><div><strong>偵測到分離的訪客資料</strong><p>登入不會自動混入訪客帳本。你可以明確匯入，或保持分離。</p></div><div className="flex gap-2"><button type="button" className="primary-button" onClick={app.importGuestData}>匯入此帳號</button><button type="button" className="secondary-button" onClick={app.dismissGuestImport}>保持分離</button></div></div>}
        {app.state.lastSyncError && <div className="warning-banner"><div><strong>部分資料尚未同步</strong><p>{app.state.lastSyncError}</p></div><button type="button" className="secondary-button" onClick={() => void app.syncNow()}>重試</button></div>}

        {!legacyPending && <Suspense fallback={<div className="card text-center text-sm text-zinc-500">載入功能中…</div>}>
          {tab === 'home' && <HomeView data={data} ownerId={app.state.ownerId} put={(_entity, record) => app.put('transactions', record)} putAdjustment={(record) => app.put('adjustments', record)} deleteTransaction={(record) => app.softDelete('transactions', record)} />}
          {tab === 'insights' && <InsightsView data={data} onOpenLedger={() => setTab('home')} />}
          {tab === 'planning' && <PlanningView data={data} ownerId={app.state.ownerId} putGoal={(record) => app.put('goals', record)} putAllocation={(record) => app.put('allocations', record)} putBudget={(record) => app.put('budgets', record)} archiveGoal={(record) => app.put('goals', { ...record, ...changedRecordMeta(record), isActive: false })} archiveBudget={(record) => app.put('budgets', { ...record, ...changedRecordMeta(record), isActive: false })} />}
          {tab === 'settings' && <SettingsView data={data} ownerId={app.state.ownerId} putAccount={(record) => app.put('accounts', record)} putCategory={(record) => app.put('categories', record)} putRecurring={(record) => app.put('recurringRules', record)} archiveAccount={archiveAccount} archiveCategory={archiveCategory} deleteRecurring={(record) => app.softDelete('recurringRules', record)} restore={app.setData} />}
        </Suspense>}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-amber-100 bg-white/95 px-3 pb-[max(0.7rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_30px_rgba(120,72,0,0.08)] backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-950/95" aria-label="主要導覽">
        <div className="mx-auto grid max-w-xl grid-cols-4 gap-1">{nav.map((item) => { const Icon = item.icon; return <button type="button" key={item.key} className={`nav-button ${tab === item.key ? 'nav-button-active' : ''}`} aria-current={tab === item.key ? 'page' : undefined} aria-pressed={tab === item.key} disabled={legacyPending} onClick={() => setTab(item.key)}><Icon className="h-5 w-5" /><span>{item.label}</span></button>; })}</div>
      </nav>
    </div>
  );
}
