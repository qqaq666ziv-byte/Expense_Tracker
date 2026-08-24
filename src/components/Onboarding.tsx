import { useEffect } from "react";
import { ArrowRight, Check, CircleHelp, Pause, X } from "lucide-react";
import type {
  TutorialEvent,
  TutorialProgress,
  TutorialStep,
} from "../app/tutorial";
import { BrandMark } from "./BrandMark";

interface StepCopy {
  kicker: string;
  title: string;
  body: string;
  target?: string;
  continueLabel?: string;
}

const COPY: Record<TutorialStep, StepCopy> = {
  welcome: {
    kicker: "互動教學 · 約 2 分鐘",
    title: "柴柴陪你完成第一筆記帳",
    body: "你會直接操作現在看到的產品介面。教學紀錄會明確標記、完成後安全刪除，而且不會計入你的資產或分析。",
    continueLabel: "開始第一筆",
  },
  amount: {
    kicker: "第一筆 · 1/9",
    title: "先輸入一個教學金額",
    body: "在亮起的金額欄輸入任意正數，例如 100。點選下一個介面項目時，柴柴會繼續帶路。",
    target: "amount",
  },
  category: {
    kicker: "第一筆 · 2/9",
    title: "這筆錢花到哪裡？",
    body: "直接點一個分類。分類描述花錢的原因，例如餐飲或交通。",
    target: "category",
  },
  account: {
    kicker: "第一筆 · 3/9",
    title: "錢從哪個帳戶出去？",
    body: "直接選擇現金、銀行或其他資產帳戶。它決定哪個帳戶餘額會改變。",
    target: "account",
  },
  create: {
    kicker: "第一筆 · 4/9",
    title: "用真正的建立流程記下它",
    body: "點擊亮起的「記下這筆支出」。這會建立一筆真實、但不計入財務數字的教學紀錄。",
    target: "create",
  },
  locate: {
    kicker: "第一筆 · 5/9",
    title: "這就是剛建立的紀錄",
    body: "柴柴已把畫面定位到它。教學標籤提醒你：這筆資料稍後會安全清除。",
    target: "tutorial-record",
    continueLabel: "我看到了",
  },
  "open-edit": {
    kicker: "第一筆 · 6/9",
    title: "試著打開編輯",
    body: "點這筆紀錄右側的鉛筆。日後分類、帳戶、時間或金額有誤，都從這裡修改。",
    target: "tutorial-record",
  },
  "edit-amount": {
    kicker: "第一筆 · 7/9",
    title: "改一下金額",
    body: "在亮起的金額欄修改數字。教學仍使用正式交易編輯流程。",
    target: "amount",
  },
  "save-edit": {
    kicker: "第一筆 · 8/9",
    title: "儲存剛才的修改",
    body: "點「儲存修改」，帳本會更新同一筆紀錄，不會另外新增重複資料。",
    target: "create",
  },
  delete: {
    kicker: "第一筆 · 9/9",
    title: "最後，使用真正的刪除功能",
    body: "點垃圾桶並確認刪除。必要的同步 tombstone 會保留，但紀錄不會再出現在正常帳本或財務數字中。",
    target: "tutorial-record",
  },
  "cleanup-confirmed": {
    kicker: "第一筆完成",
    title: "教學紀錄已安全清除",
    body: "已確認它不在正常帳本、資產、預算與分析中。你可以今天先到這裡，之後再從幫助中心繼續。",
    target: "ledger",
    continueLabel: "繼續看財務快照",
  },
  "snapshot-summary": {
    kicker: "今日快照 · 摘要",
    title: "先回答：今天花了多少？",
    body: "極速記帳右上方會一直顯示今日支出。它是最快的摘要，不需要先打開報表。",
    target: "today-summary",
    continueLabel: "再看分類",
  },
  "snapshot-category": {
    kicker: "今日快照 · 分類",
    title: "接著看錢花到哪裡",
    body: "洞察頁可以切到「今日」，再從分類環圖看出支出組成；有資料時可直接點分類。",
    target: "insights-categories",
    continueLabel: "最後看明細",
  },
  "snapshot-detail": {
    kicker: "今日快照 · 明細",
    title: "分類之後，回到每一筆交易",
    body: "點分類可展開明細；「查看今天與最近的交易」則會回到帳本。記住順序：摘要 → 分類 → 明細。",
    target: "today-snapshot",
    continueLabel: "認識其他功能",
  },
  "tour-assets": {
    kicker: "功能速覽 · 資產",
    title: "資產是錢現在放在哪裡",
    body: "在這裡建立現金、銀行、電子支付等帳戶，也能用餘額調整留下可追溯的對帳紀錄。",
    target: "assets-overview",
    continueLabel: "看財務分析",
  },
  "tour-insights": {
    kicker: "功能速覽 · 洞察",
    title: "洞察把交易整理成趨勢",
    body: "切換今日、本週、本月、本年或自訂期間，再從總覽一路看進分類與明細。",
    target: "insights-overview",
    continueLabel: "看生活規劃",
  },
  "tour-planning": {
    kicker: "功能速覽 · 規劃",
    title: "把預算、目標與固定收支放在一起",
    body: "儲蓄目標回答想留下多少，預算控制可花多少，固定收支則協助處理規律發生的交易。",
    target: "planning-overview",
    continueLabel: "了解帳號與同步",
  },
  "tour-sync": {
    kicker: "功能速覽 · 帳號與同步",
    title: "先知道資料現在放在哪裡",
    body: "訪客資料只在這台裝置；Google 登入後才會跨裝置同步。遇到需要處理的狀態，這裡會明確提醒。",
    target: "sync-panel",
    continueLabel: "完成教學",
  },
  complete: {
    kicker: "互動教學完成",
    title: "你已經會用柴柴記帳了",
    body: "之後可在「幫助與教學」重跑完整流程或單獨章節。",
  },
};

const PASSIVE_STEPS = new Set<TutorialStep>([
  "welcome",
  "locate",
  "cleanup-confirmed",
  "snapshot-summary",
  "snapshot-category",
  "snapshot-detail",
  "tour-assets",
  "tour-insights",
  "tour-planning",
  "tour-sync",
]);

export function Onboarding({
  progress,
  onEvent,
  onPause,
  onSkip,
}: {
  progress: TutorialProgress;
  onEvent(event: TutorialEvent): void;
  onPause(): void;
  onSkip(): void;
}) {
  const copy = COPY[progress.step];

  useEffect(() => {
    if (copy.target) document.body.dataset.tutorialTarget = copy.target;
    else delete document.body.dataset.tutorialTarget;
    const target = copy.target
      ? document.querySelector<HTMLElement>(`[data-tutorial="${copy.target}"]`)
      : null;
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    return () => delete document.body.dataset.tutorialTarget;
  }, [copy.target]);

  return (
    <aside
      className="tutorial-coach"
      role="dialog"
      aria-modal="false"
      aria-labelledby="tutorial-title"
      aria-live="polite"
    >
      <div className="tutorial-coach-head">
        <BrandMark className="h-11 w-11" />
        <button type="button" aria-label="中途離開教學" onClick={onPause}>
          <X />
        </button>
      </div>
      <p className="section-kicker">{copy.kicker}</p>
      <h2 id="tutorial-title">{copy.title}</h2>
      <p>{copy.body}</p>

      {!PASSIVE_STEPS.has(progress.step) && (
        <div className="tutorial-do-this">
          <CircleHelp />
          <span>請直接操作亮起的正式介面，完成後會自動前進。</span>
        </div>
      )}

      <div className="tutorial-coach-actions">
        <button type="button" className="text-button" onClick={onPause}>
          <Pause />
          今天先到這裡
        </button>
        {PASSIVE_STEPS.has(progress.step) && (
          <button
            type="button"
            className="primary-button"
            onClick={() => onEvent({ type: "continue" })}
          >
            {progress.step === "tour-sync" && <Check />}
            {copy.continueLabel ?? "繼續"}
            {progress.step !== "tour-sync" && <ArrowRight />}
          </button>
        )}
      </div>
      <button type="button" className="tutorial-skip" onClick={onSkip}>
        跳過並結束完整教學
      </button>
    </aside>
  );
}
