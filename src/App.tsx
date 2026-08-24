import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  BarChart3,
  BookOpenCheck,
  Cloud,
  CloudOff,
  Download,
  HelpCircle,
  LogIn,
  LogOut,
  Menu,
  Palette,
  PieChart,
  RefreshCw,
  Settings,
  Target,
  X,
} from "lucide-react";
import { useTheme } from "./context/ThemeContext";
import { useFinanceApp } from "./app/useFinanceApp";
import { changedRecordMeta } from "./app/state";
import type { FinanceData, LegacyAuthenticatedBootstrap } from "./domain/model";
import { exportFinanceBackup } from "./domain/backup";
import { calculateFinancials } from "./domain/financeEngine";
import { isFinancialTransaction } from "./domain/tutorialRecord";
import { displayMoney } from "./app/presentation";
import {
  TUTORIAL_STORAGE_KEY,
  isTutorialTransaction,
  parseTutorialProgress,
  prepareTutorialResume,
  startTutorial,
  transitionTutorial,
  type TutorialChapter,
  type TutorialEvent,
  type TutorialProgress,
} from "./app/tutorial";
import { HomeView } from "./components/HomeView";
import { BrandMark } from "./components/BrandMark";
import { Onboarding } from "./components/Onboarding";
import { ContextHint } from "./components/ContextHint";

const InsightsView = lazy(() =>
  import("./components/InsightsView").then((module) => ({
    default: module.InsightsView,
  })),
);
const AssetsView = lazy(() =>
  import("./components/AssetsView").then((module) => ({
    default: module.AssetsView,
  })),
);
const PlanningView = lazy(() =>
  import("./components/PlanningView").then((module) => ({
    default: module.PlanningView,
  })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);

type Tab = "record" | "insights" | "assets" | "planning";

function initialTutorialProgress(): TutorialProgress | null {
  try {
    const saved = parseTutorialProgress(
      localStorage.getItem(TUTORIAL_STORAGE_KEY),
    );
    if (saved) return saved;
    // People who completed the previous tour should not be interrupted again;
    // the new interactive chapters remain available from Help & Tutorials.
    if (localStorage.getItem("shiba-finance:onboarding:v1")) return null;
    return startTutorial("full");
  } catch {
    return null;
  }
}

interface LegacyBootstrapPanelProps {
  bootstrap: LegacyAuthenticatedBootstrap;
  syncBusy: boolean;
  onSync(): void;
  onDownload(): void;
  onImport(): void;
  onKeepCloud(): void;
}

function candidateRecordCount(data: FinanceData): number {
  return (
    data.accounts.length +
    data.categories.length +
    data.transactions.length +
    data.adjustments.length +
    data.goals.length +
    data.allocations.length +
    data.budgets.length +
    data.recurringRules.length
  );
}

export function LegacyBootstrapPanel({
  bootstrap,
  syncBusy,
  onSync,
  onDownload,
  onImport,
  onKeepCloud,
}: LegacyBootstrapPanelProps) {
  if (bootstrap.status === "pending")
    return (
      <section className="warning-banner" role="status" aria-live="polite">
        <div>
          <strong>正在安全讀取你的雲端帳本</strong>
          <p>完成前會暫停修改，避免這台裝置的舊資料蓋過較新的紀錄。</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={syncBusy}
          onClick={onSync}
        >
          {syncBusy ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Cloud className="h-4 w-4" />
          )}
          {syncBusy ? "正在讀取" : "重新讀取"}
        </button>
      </section>
    );
  const recordCount = candidateRecordCount(bootstrap.candidate);
  const unsyncedCount = bootstrap.unsyncedTransactionIds.length;
  return (
    <section
      className="warning-banner"
      aria-labelledby="legacy-candidate-title"
    >
      <div className="min-w-0 flex-1">
        <strong id="legacy-candidate-title">找到這台裝置上的舊版資料</strong>
        <p>
          雲端帳本已安全讀取；這台裝置另有 {recordCount} 筆舊資料，其中{" "}
          {unsyncedCount} 筆交易可能還沒上傳。先下載備份，再決定是否匯入最安心。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="secondary-button"
            onClick={onDownload}
          >
            <Download className="h-4 w-4" />
            下載備份
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={syncBusy}
            onClick={() => {
              if (
                window.confirm(
                  "要把這台裝置上的舊版資料匯入目前帳本嗎？建議先下載備份。",
                )
              )
                onImport();
            }}
          >
            匯入這份資料
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={syncBusy}
            onClick={() => {
              if (
                window.confirm(
                  "要保留目前雲端帳本，並略過這台裝置上的舊版資料嗎？",
                )
              )
                onKeepCloud();
            }}
          >
            保留雲端版本
          </button>
        </div>
      </div>
    </section>
  );
}

function downloadJson(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const app = useFinanceApp();
  const data = app.state.data;
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState<Tab>("record");
  const [online, setOnline] = useState(navigator.onLine);
  const [authMessage, setAuthMessage] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tutorial, setTutorial] = useState<TutorialProgress | null>(
    initialTutorialProgress,
  );
  const tutorialResumeChecked = useRef(false);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!tutorial) return;
    try {
      localStorage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(tutorial));
    } catch {
      /* UI preference only */
    }
  }, [tutorial]);

  const activeTutorial = tutorial?.status === "active" ? tutorial : null;

  const tutorialRecordState = (
    progress: TutorialProgress,
  ): "active" | "deleted" | "missing" => {
    if (!progress.recordId) return "missing";
    const record = data.transactions.find(
      (item) => item.id === progress.recordId && isTutorialTransaction(item),
    );
    if (!record) return "missing";
    return record.deletedAt ? "deleted" : "active";
  };

  useEffect(() => {
    if (tutorialResumeChecked.current || app.authLoading) return;
    tutorialResumeChecked.current = true;
    setTutorial((current) =>
      current?.status === "active"
        ? prepareTutorialResume(current, tutorialRecordState(current))
        : current,
    );
  }, [app.authLoading]);

  const handleTutorialEvent = (event: TutorialEvent) =>
    setTutorial((current) =>
      current ? transitionTutorial(current, event) : current,
    );

  const cleanupTutorialRecords = (): boolean =>
    data.transactions
      .filter((record) => !record.deletedAt && isTutorialTransaction(record))
      .every((record) => app.softDelete("transactions", record));

  const startTutorialChapter = (chapter: TutorialChapter) => {
    if (!cleanupTutorialRecords()) {
      setAuthMessage("教學紀錄尚未安全清除，請稍後再重新開始教學。");
      return;
    }
    setShowSettings(false);
    setShowSystem(false);
    setTutorial(startTutorial(chapter));
  };

  const pauseTutorial = () => handleTutorialEvent({ type: "pause" });
  const skipTutorial = () => {
    if (!cleanupTutorialRecords()) {
      setAuthMessage("教學紀錄尚未安全清除，因此沒有結束教學。");
      return;
    }
    handleTutorialEvent({ type: "skip" });
  };

  const resumeTutorial = () => {
    setShowSettings(false);
    setShowSystem(false);
    setTutorial((current) =>
      current
        ? prepareTutorialResume(current, tutorialRecordState(current))
        : current,
    );
  };

  useEffect(() => {
    if (!activeTutorial) return;
    const step = activeTutorial.step;
    if (
      [
        "welcome",
        "amount",
        "category",
        "account",
        "create",
        "locate",
        "open-edit",
        "edit-amount",
        "save-edit",
        "delete",
        "cleanup-confirmed",
        "snapshot-summary",
      ].includes(step)
    ) {
      setTab("record");
      setShowSystem(false);
    } else if (
      ["snapshot-category", "snapshot-detail", "tour-insights"].includes(step)
    ) {
      setTab("insights");
      setShowSystem(false);
    } else if (step === "tour-assets") {
      setTab("assets");
      setShowSystem(false);
    } else if (step === "tour-planning") {
      setTab("planning");
      setShowSystem(false);
    } else if (step === "tour-sync") {
      setShowSystem(true);
    }
  }, [activeTutorial?.step]);

  const pending = app.state.outbox.length;
  const legacyBootstrap = app.state.legacyBootstrap;
  const legacyPending = legacyBootstrap?.status === "pending";
  const syncLabel =
    app.state.ownerId === "guest"
      ? "只存在這台裝置"
      : legacyPending
        ? "正在確認雲端資料"
        : !online
          ? `離線${pending ? ` · ${pending} 筆待同步` : ""}`
          : pending > 0
            ? `${pending} 筆等待同步`
            : "資料已同步";
  const syncTone =
    app.state.ownerId === "guest"
      ? "local"
      : !online || pending > 0 || app.state.lastSyncError
        ? "attention"
        : "synced";

  const downloadLegacyCandidate = () => {
    if (!legacyBootstrap) return;
    try {
      downloadJson(
        `shiba-finance-old-data-${Date.now()}.json`,
        exportFinanceBackup(legacyBootstrap.candidate),
      );
      setAuthMessage("");
    } catch (error) {
      setAuthMessage(
        `備份未下載：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const archiveAccount = (record: FinanceData["accounts"][number]) => {
    const balance =
      calculateFinancials(data).accountBalances.find(
        (item) => item.accountId === record.id,
      )?.balance ?? 0;
    const transactionCount = data.transactions.filter(
      (item) => isFinancialTransaction(item) && item.accountId === record.id,
    ).length;
    const recurring = data.recurringRules.filter(
      (rule) =>
        !rule.deletedAt && rule.isActive && rule.accountId === record.id,
    );
    if (
      !window.confirm(
        `封存「${record.name}」後，${record.includeInTotalAssets ? `總資產會少計 ${displayMoney(balance)}；` : ""}${transactionCount} 筆過去紀錄仍會保留${recurring.length ? `，並暫停 ${recurring.length} 個週期收支` : ""}。確定繼續？`,
      )
    )
      return false;
    for (const rule of recurring)
      if (
        !app.put("recurringRules", {
          ...rule,
          ...changedRecordMeta(rule),
          isActive: false,
        })
      )
        return false;
    return app.put("accounts", {
      ...record,
      ...changedRecordMeta(record),
      isActive: false,
    });
  };
  const archiveCategory = (record: FinanceData["categories"][number]) => {
    const recurring = data.recurringRules.filter(
      (rule) =>
        !rule.deletedAt && rule.isActive && rule.categoryId === record.id,
    );
    if (
      recurring.length > 0 &&
      !window.confirm(
        `封存「${record.name}」也會暫停 ${recurring.length} 個週期收支；過去紀錄仍會保留。要繼續嗎？`,
      )
    )
      return false;
    for (const rule of recurring)
      if (
        !app.put("recurringRules", {
          ...rule,
          ...changedRecordMeta(rule),
          isActive: false,
        })
      )
        return false;
    return app.put("categories", {
      ...record,
      ...changedRecordMeta(record),
      isActive: false,
    });
  };
  const nav = [
    { key: "record" as const, label: "記帳", icon: BookOpenCheck },
    { key: "insights" as const, label: "洞察", icon: BarChart3 },
    { key: "assets" as const, label: "資產", icon: PieChart },
    { key: "planning" as const, label: "規劃", icon: Target },
  ];

  const settings = (
    <SettingsView
      data={data}
      ownerId={app.state.ownerId}
      putAccount={(record) => app.put("accounts", record)}
      putCategory={(record) => app.put("categories", record)}
      putRecurring={(record) => app.put("recurringRules", record)}
      archiveAccount={archiveAccount}
      archiveCategory={archiveCategory}
      deleteRecurring={(record) => app.softDelete("recurringRules", record)}
      restore={app.setData}
    />
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <button
            type="button"
            className="brand-lockup"
            onClick={() => setTab("record")}
            aria-label="回到極速記帳"
          >
            <BrandMark />
            <span>
              <strong>柴柴記帳</strong>
              <small>日子有跡，心裡有底</small>
            </span>
          </button>
          <button
            type="button"
            className={`system-button ${syncTone}`}
            onClick={() => setShowSystem(true)}
            aria-label={`帳戶與同步：${syncLabel}`}
          >
            <i />
            <span className="system-copy">
              <b>
                {app.user
                  ? app.user.email?.split("@")[0] || "我的帳戶"
                  : "訪客模式"}
              </b>
              <small>{syncLabel}</small>
            </span>
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="app-main">
        {authMessage && <div className="error-message mb-4">{authMessage}</div>}
        {app.storageRecovery ? (
          <div className="warning-banner">
            <div>
              <strong>你的本機資料需要復原</strong>
              <p>
                為避免資料受損，目前已暫停修改。請先下載原始資料，再到「設定與說明
                → 資料備份」還原有效備份。
              </p>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([app.storageRecovery!.raw], {
                    type: "application/json",
                  }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = `shiba-finance-recovery-${Date.now()}.json`;
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              下載原始資料
            </button>
          </div>
        ) : (
          app.storageError && (
            <div className="warning-banner">
              <div>
                <strong>這次變更可能尚未保存</strong>
                <p>請到「設定與說明 → 資料備份」下載完整備份後再關閉頁面。</p>
              </div>
            </div>
          )
        )}
        {app.guestImportNotice && (
          <div className="info-banner">
            <span>
              <strong>訪客資料處理結果</strong>
              <br />
              {app.guestImportNotice}
            </span>
          </div>
        )}
        {app.legacyBootstrapNotice && (
          <div className="info-banner" aria-live="polite">
            <span>
              <strong>舊版資料處理結果</strong>
              <br />
              {app.legacyBootstrapNotice}
            </span>
          </div>
        )}
        {app.safetyNotice && (
          <div className="warning-banner" role="alert">
            <div>
              <strong>這次操作沒有執行</strong>
              <p>請確認目前帳戶後再試一次。</p>
            </div>
          </div>
        )}
        {legacyBootstrap && (
          <LegacyBootstrapPanel
            bootstrap={legacyBootstrap}
            syncBusy={app.syncBusy}
            onSync={() => void app.syncNow()}
            onDownload={downloadLegacyCandidate}
            onImport={app.importLegacyCandidate}
            onKeepCloud={app.keepCloudData}
          />
        )}
        {app.hasSeparateGuestData && (
          <div className="warning-banner">
            <div>
              <strong>這台裝置還有訪客資料</strong>
              <p>
                登入不會自動混入訪客帳本。你可以匯入目前帳戶，或繼續分開保留。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="primary-button"
                onClick={app.importGuestData}
              >
                匯入目前帳戶
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={app.dismissGuestImport}
              >
                保持分開
              </button>
            </div>
          </div>
        )}
        {app.state.lastSyncError && (
          <div className="warning-banner">
            <div>
              <strong>部分資料還在這台裝置</strong>
              <p>同步尚未完成，但本機紀錄仍保留。連線正常後可再試一次。</p>
              <details>
                <summary>查看詳細資訊</summary>
                <code>{app.state.lastSyncError}</code>
              </details>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void app.syncNow()}
            >
              重新同步
            </button>
          </div>
        )}

        {!legacyPending && (
          <Suspense
            fallback={
              <div className="friendly-inline">柴柴正在把頁面準備好…</div>
            }
          >
            {!activeTutorial && tab === "insights" && (
              <ContextHint id="insights" title="先總覽，再往下看">
                先選期間，再看摘要與分類；點分類就能展開對應明細。看過一次後不會再打擾你。
              </ContextHint>
            )}
            {!activeTutorial && tab === "assets" && (
              <ContextHint id="assets" title="帳戶不是分類">
                資產帳戶回答錢放在哪裡。對帳不一致時用「調整餘額」，不要補一筆假收入或假支出。
              </ContextHint>
            )}
            {!activeTutorial && tab === "planning" && (
              <ContextHint id="planning" title="三種規劃，各做一件事">
                儲蓄目標留下錢、預算控制支出、固定收支處理規律交易。
              </ContextHint>
            )}
            {tab === "record" && (
              <HomeView
                data={data}
                ownerId={app.state.ownerId}
                put={(_entity, record) => app.put("transactions", record)}
                deleteTransaction={(record) =>
                  app.softDelete("transactions", record)
                }
                tutorial={activeTutorial}
                onTutorialEvent={handleTutorialEvent}
              />
            )}
            {tab === "insights" && (
              <InsightsView data={data} onOpenLedger={() => setTab("record")} />
            )}
            {tab === "assets" && (
              <AssetsView
                data={data}
                ownerId={app.state.ownerId}
                putAccount={(record) => app.put("accounts", record)}
                putAdjustment={(record) => app.put("adjustments", record)}
                archiveAccount={archiveAccount}
              />
            )}
            {tab === "planning" && (
              <PlanningView
                data={data}
                ownerId={app.state.ownerId}
                putGoal={(record) => app.put("goals", record)}
                putAllocation={(record) => app.put("allocations", record)}
                putBudget={(record) => app.put("budgets", record)}
                putRecurring={(record) => app.put("recurringRules", record)}
                deleteRecurring={(record) =>
                  app.softDelete("recurringRules", record)
                }
                archiveGoal={(record) =>
                  app.put("goals", {
                    ...record,
                    ...changedRecordMeta(record),
                    isActive: false,
                  })
                }
                archiveBudget={(record) =>
                  app.put("budgets", {
                    ...record,
                    ...changedRecordMeta(record),
                    isActive: false,
                  })
                }
              />
            )}
          </Suspense>
        )}
      </main>

      <nav className="bottom-nav" aria-label="主要導覽">
        <div>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.key}
                className={tab === item.key ? "active" : ""}
                aria-current={tab === item.key ? "page" : undefined}
                aria-pressed={tab === item.key}
                disabled={legacyPending}
                onClick={() => setTab(item.key)}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {showSystem && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowSystem(false);
          }}
        >
          <aside
            className="system-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="system-title"
          >
            <button
              className="sheet-close"
              type="button"
              aria-label="關閉帳戶選單"
              onClick={() => setShowSystem(false)}
            >
              <X />
            </button>
            <BrandMark className="h-14 w-14" />
            <p className="section-kicker">帳戶與資料</p>
            <h2 id="system-title">
              {app.user
                ? app.user.email || "我的 Google 帳戶"
                : "目前是訪客模式"}
            </h2>
            {!activeTutorial && (
              <ContextHint id="sync" title="先確認資料位置">
                訪客只存在這台裝置；登入後才會同步。狀態正常時不需要手動操作。
              </ContextHint>
            )}
            <div className={`sync-card ${syncTone}`} data-tutorial="sync-panel">
              <span>
                <i />
                {syncLabel}
              </span>
              <p>
                {app.state.ownerId === "guest"
                  ? "資料只保存在這台裝置。定期下載備份，或登入後開啟跨裝置同步。"
                  : app.state.lastSyncError
                    ? "資料仍留在這台裝置，修復連線後可重新同步。"
                    : "你的資料狀態正常；沒有需要處理的事。"}
              </p>
              {app.state.ownerId !== "guest" && (
                <button
                  type="button"
                  disabled={app.syncBusy}
                  onClick={() => void app.syncNow()}
                >
                  <RefreshCw className={app.syncBusy ? "animate-spin" : ""} />
                  {app.syncBusy ? "同步中" : "立即同步"}
                </button>
              )}
            </div>
            <div className="system-actions">
              {app.user ? (
                <button
                  type="button"
                  onClick={() =>
                    void app
                      .signOut()
                      .then(() => setShowSystem(false))
                      .catch((error) => setAuthMessage(String(error)))
                  }
                >
                  <LogOut />
                  登出 Google 帳戶<small>切回這台裝置的訪客帳本</small>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!app.cloudEnabled || app.authLoading}
                  onClick={() =>
                    void app
                      .signIn()
                      .catch((error) => setAuthMessage(String(error)))
                  }
                >
                  <LogIn />
                  使用 Google 登入
                  <small>
                    {app.cloudEnabled
                      ? "跨裝置同步你的資料"
                      : "目前未開啟雲端同步"}
                  </small>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowSystem(false);
                  setShowSettings(true);
                }}
              >
                <Settings />
                設定與說明<small>分類、週期收支、備份與重要說明</small>
              </button>
              <button
                type="button"
                onClick={() => {
                  toggleTheme();
                }}
              >
                <Palette />
                切換成{theme.id === "shiba" ? "米克斯" : "柴犬"}風格
                <small>只改變這台裝置的外觀</small>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSystem(false);
                  setShowSettings(true);
                }}
              >
                <HelpCircle />
                幫助與互動教學<small>續跑、重跑完整流程或選擇單一章節</small>
              </button>
            </div>
          </aside>
        </div>
      )}

      {showSettings && (
        <div className="settings-overlay">
          <header>
            <button type="button" onClick={() => setShowSettings(false)}>
              <X />
              關閉
            </button>
            <div>
              <p className="section-kicker">需要時再來</p>
              <h1>設定與說明</h1>
            </div>
          </header>
          <div className="settings-content">
            <section
              className="tutorial-center"
              aria-labelledby="tutorial-center-title"
            >
              <div className="plain-heading">
                <div>
                  <p className="section-kicker">幫助與教學</p>
                  <h2 id="tutorial-center-title">跟著柴柴實際操作一次</h2>
                </div>
                <HelpCircle />
              </div>
              <p>
                互動教學直接使用正式介面；第一筆教學紀錄會被排除於財務數字，並在教學中安全刪除。
              </p>
              <div className="tutorial-center-actions">
                {tutorial?.status === "paused" && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={resumeTutorial}
                  >
                    繼續上次進度
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => startTutorialChapter("full")}
                >
                  從頭跑完整教學
                </button>
              </div>
              <div className="tutorial-chapters" aria-label="單獨重跑教學章節">
                {(
                  [
                    ["first-record", "第一筆記帳"],
                    ["snapshot", "今日財務快照"],
                    ["assets", "資產帳戶"],
                    ["insights", "財務洞察"],
                    ["planning", "生活規劃"],
                    ["sync", "帳號與同步"],
                  ] as const
                ).map(([chapter, label]) => (
                  <button
                    type="button"
                    key={chapter}
                    onClick={() => startTutorialChapter(chapter)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
            <section className="help-strip">
              <div>
                <HelpCircle />
                <span>
                  <strong>怎麼開始？</strong>
                  <small>
                    分類是「為什麼花」，資產帳戶是「錢從哪裡進出」。平常照名稱選就好。
                  </small>
                </span>
              </div>
              <div>
                <Cloud />
                <span>
                  <strong>資料在哪裡？</strong>
                  <small>
                    訪客資料只在這台裝置；登入才會同步。JSON
                    備份可以完整還原，CSV 適合自行整理交易。
                  </small>
                </span>
              </div>
            </section>
            <section className="faq-panel" aria-labelledby="faq-title">
              <div className="plain-heading">
                <div>
                  <p className="section-kicker">常見問題</p>
                  <h2 id="faq-title">使用說明與資料安心指南</h2>
                </div>
              </div>
              <details>
                <summary>分類和資產帳戶有什麼不同？</summary>
                <p>
                  分類回答「這筆錢為什麼增加或減少」，例如餐飲；資產帳戶回答「錢實際從哪裡進出」，例如現金或街口支付。
                </p>
              </details>
              <details>
                <summary>離線時可以記帳嗎？</summary>
                <p>
                  可以。紀錄會先安全保存在這台裝置；已登入時，恢復連線後再同步。右上角帳戶選單會告訴你是否還有資料等待同步。
                </p>
              </details>
              <details>
                <summary>Google 登入會自動混合訪客資料嗎？</summary>
                <p>
                  不會。登入後如果偵測到訪客帳本，柴柴會讓你明確選擇匯入或保持分開，不會偷偷合併。
                </p>
              </details>
              <details>
                <summary>怎麼備份或換裝置？</summary>
                <p>
                  使用下方「資料備份」下載完整 JSON；它可以安全合併或還原。交易
                  CSV 適合試算表整理，但不能用來完整還原設定。
                </p>
              </details>
              <details>
                <summary>帳戶金額對不上時怎麼辦？</summary>
                <p>
                  到「資產」點開該帳戶，再選「調整餘額」。這會保留一筆調整紀錄，但不會被誤算成收入或支出。
                </p>
              </details>
            </section>
            <Suspense
              fallback={<div className="friendly-inline">設定載入中…</div>}
            >
              {settings}
            </Suspense>
          </div>
        </div>
      )}
      {activeTutorial && (
        <Onboarding
          progress={activeTutorial}
          onEvent={handleTutorialEvent}
          onPause={pauseTutorial}
          onSkip={skipTutorial}
        />
      )}
    </div>
  );
}
