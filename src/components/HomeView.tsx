import { createElement, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Search,
  ArrowLeftRight,
  Trash2,
  X,
} from "lucide-react";
import type { AssetAccount, Category, FinanceData, Transaction, Transfer } from "../domain/model";
import { buildLedgerHistory, calculateInsights } from "../domain/financeEngine";
import { sortByDisplayOrder } from "../domain/displayOrder";
import { changedRecordMeta, newRecordMeta } from "../app/state";
import { displayMoney } from "../app/presentation";
import {
  parseRequiredNumberInput,
  shortDate,
  toLocalInput,
} from "../app/format";
import { completeAppliedMutation } from "../app/mutationResult";
import { resolveExplicitSelection } from "../app/explicitSelection";
import {
  TUTORIAL_RECORD_NOTE,
  isTutorialTransaction,
  type TutorialEvent,
  type TutorialProgress,
} from "../app/tutorial";
import { FinanceIcon } from "./FinanceIcon";
import { MoneyInput } from "./MoneyInput";
import { syncRecordKey } from "../domain/syncEngine";
import { buildTransferRecord } from "../domain/transfer";
import { isEditorSnapshotStale } from "../domain/staleEditor";
import {
  deriveCommonNoteSuggestions,
  deriveQuickReentryCandidates,
} from "../domain/quickEntrySuggestions";
import {
  changePinnedNoteShortcuts,
  loadPinnedNoteShortcuts,
} from "../app/noteShortcutPreferences";

interface HomeViewProps {
  data: FinanceData;
  ownerId: string;
  put(entity: "transactions", record: Transaction): boolean;
  put(entity: "transfers", record: Transfer): boolean;
  deleteTransaction(record: Transaction): boolean;
  deleteTransfer?(record: Transfer): boolean;
  tutorial?: TutorialProgress | null;
  onTutorialEvent?(event: TutorialEvent): void;
  unresolvedSyncRecordKeys?: ReadonlySet<string>;
  acceptRemoteConflict?(recordId: string): void;
  acceptRemoteTransferConflict?(recordId: string): void;
  transferDependencyConflictIds?: ReadonlySet<string>;
  confirmTransferAccounts?(record: Transfer): boolean;
  transferMutationsEnabled?: boolean;
}

const ledgerPageSize = 30;

export function HomeView(props: HomeViewProps) {
  return createElement(OwnerScopedHomeView, { ...props, key: props.ownerId });
}

function OwnerScopedHomeView({
  data,
  ownerId,
  put,
  deleteTransaction,
  deleteTransfer = () => false,
  tutorial,
  onTutorialEvent,
  unresolvedSyncRecordKeys = new Set(),
  acceptRemoteConflict,
  acceptRemoteTransferConflict,
  transferDependencyConflictIds = new Set(),
  confirmTransferAccounts,
  transferMutationsEnabled = true,
}: HomeViewProps) {
  const amountRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<"expense" | "income">("expense");
  const [mode, setMode] = useState<"expense" | "income" | "transfer">("expense");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [occurredAt, setOccurredAt] = useState(toLocalInput());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [editingTransfer, setEditingTransfer] = useState<Transfer | null>(null);
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [destinationAccountId, setDestinationAccountId] = useState("");
  const [openedTransferAccounts, setOpenedTransferAccounts] = useState<{
    source?: AssetAccount;
    destination?: AssetAccount;
  }>({});
  const [quickReentryParents, setQuickReentryParents] = useState<{
    category?: Category;
    account?: AssetAccount;
  } | null>(null);
  const [historyLimit, setHistoryLimit] = useState(ledgerPageSize);
  const [query, setQuery] = useState("");
  const [pinnedNotePreference, setPinnedNotePreference] = useState<{
    ownerId: string;
    shortcuts: string[];
  }>({ ownerId, shortcuts: [] });
  const pinnedNoteShortcuts = pinnedNotePreference.ownerId === ownerId
    ? pinnedNotePreference.shortcuts
    : [];
  const [addingNoteShortcut, setAddingNoteShortcut] = useState(false);
  const [noteShortcutDraft, setNoteShortcutDraft] = useState("");
  const [noteShortcutError, setNoteShortcutError] = useState("");

  const accounts = sortByDisplayOrder(
    data.accounts.filter(
      (item) =>
        !item.deletedAt && (item.isActive || editing?.accountId === item.id),
    ),
  );
  const categories = sortByDisplayOrder(
    data.categories.filter(
      (item) =>
        !item.deletedAt &&
        item.kind === type &&
        (item.isActive || editing?.categoryId === item.id),
    ),
  );
  const selectableCategories = categories.filter((item) => !unresolvedSyncRecordKeys.has(
    syncRecordKey("categories", item.id),
  ));
  const selectableAccounts = accounts.filter((item) => !unresolvedSyncRecordKeys.has(
    syncRecordKey("accounts", item.id),
  ));
  const resolvedCategoryId = resolveExplicitSelection(categoryId, selectableCategories);
  const resolvedAccountId = resolveExplicitSelection(accountId, selectableAccounts);
  const selectedCategoryUnavailable = Boolean(categoryId && !resolvedCategoryId);
  const selectedAccountUnavailable = Boolean(accountId && !resolvedAccountId);
  const transferAccounts = sortByDisplayOrder(data.accounts.filter((item) => (
    (!item.deletedAt && item.isActive)
    || editingTransfer?.sourceAccountId === item.id
    || editingTransfer?.destinationAccountId === item.id
  )));
  const selectableTransferAccounts = transferAccounts.filter((item) => (
    !unresolvedSyncRecordKeys.has(syncRecordKey("accounts", item.id))
    && (item.isActive
      || editingTransfer?.sourceAccountId === item.id
      || editingTransfer?.destinationAccountId === item.id)
  ));
  const resolvedSourceAccountId = resolveExplicitSelection(sourceAccountId, selectableTransferAccounts);
  const resolvedDestinationAccountId = resolveExplicitSelection(
    destinationAccountId,
    selectableTransferAccounts,
  );
  const selectedTransferAccountUnavailable = Boolean(
    (sourceAccountId && !resolvedSourceAccountId)
    || (destinationAccountId && !resolvedDestinationAccountId),
  );
  const usableTransferAccounts = data.accounts.filter((item) => (
    !item.deletedAt
    && item.isActive
    && !unresolvedSyncRecordKeys.has(syncRecordKey("accounts", item.id))
  ));
  const commonNoteSuggestions = useMemo(() => deriveCommonNoteSuggestions(data, {
    mode,
    ownerId,
    categoryId: mode === "transfer" ? undefined : resolvedCategoryId || undefined,
    accountId: mode === "transfer" ? undefined : resolvedAccountId || undefined,
    query: note,
    excludeNormalizedNotes: pinnedNoteShortcuts,
  }), [data, mode, note, ownerId, pinnedNoteShortcuts, resolvedAccountId, resolvedCategoryId]);
  const quickReentryCandidates = useMemo(() => (
    mode === "transfer" || editing || editingTransfer || tutorial
      ? []
      : deriveQuickReentryCandidates(data, {
          mode,
          ownerId,
          categoryId: resolvedCategoryId || undefined,
          accountId: resolvedAccountId || undefined,
          lockedRecordKeys: unresolvedSyncRecordKeys,
        })
  ), [data, editing, editingTransfer, mode, ownerId, resolvedAccountId,
    resolvedCategoryId, tutorial, unresolvedSyncRecordKeys]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(
        `shiba-finance:quick-picks:${ownerId}:${type}`,
      );
      if (!saved) return;
      const picks = JSON.parse(saved) as {
        categoryId?: string;
        accountId?: string;
      };
      if (picks.categoryId) setCategoryId(picks.categoryId);
      if (picks.accountId) setAccountId(picks.accountId);
    } catch {
      /* Recent picks are a convenience, never financial state. */
    }
  }, [ownerId, type]);

  useEffect(() => {
    setPinnedNotePreference({
      ownerId,
      shortcuts: loadPinnedNoteShortcuts(localStorage, ownerId),
    });
    setAddingNoteShortcut(false);
    setNoteShortcutDraft("");
    setNoteShortcutError("");
  }, [ownerId]);

  const changeNoteShortcut = (change: { type: "add" | "remove"; note: string }) => {
    const result = changePinnedNoteShortcuts(localStorage, ownerId, change);
    setPinnedNotePreference({ ownerId, shortcuts: result.shortcuts });
    if (result.persisted) {
      setNoteShortcutError("");
      if (change.type === "add") {
        setAddingNoteShortcut(false);
        setNoteShortcutDraft("");
      }
      return;
    }
    setNoteShortcutError({
      empty: "請輸入快捷備註。",
      duplicate: "這個快捷備註已經存在。",
      "count-limit": "我的快捷已達數量上限，請先移除不需要的項目。",
      "size-limit": "快捷備註太長，請縮短後再加入。",
      storage: "瀏覽器無法儲存快捷備註；帳本資料未受影響。",
    }[result.error ?? "storage"]);
  };

  const today = useMemo(
    () =>
      calculateInsights(data, { period: "month", reference: new Date() }).today,
    [data],
  );
  const history = useMemo(() => {
    const normalHistory = buildLedgerHistory(data);
    const tutorialRecord = tutorial?.recordId
      ? data.transactions.find(
          (record) =>
            record.id === tutorial.recordId &&
            !record.deletedAt &&
            isTutorialTransaction(record),
        )
      : undefined;
    return tutorialRecord
      ? [
          { kind: "transaction" as const, record: tutorialRecord },
          ...normalHistory,
        ]
      : normalHistory;
  }, [data, tutorial?.recordId]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  const filteredHistory = history.filter((entry) => {
    if (!normalizedQuery) return true;
    if (entry.kind === "adjustment") {
      const account = data.accounts.find(
        (item) => item.id === entry.record.accountId,
      );
      return `${account?.name ?? ""} ${entry.record.reason ?? ""}`
        .toLocaleLowerCase("zh-TW")
        .includes(normalizedQuery);
    }
    if (entry.kind === "transfer") {
      const source = data.accounts.find((item) => item.id === entry.record.sourceAccountId);
      const destination = data.accounts.find((item) => item.id === entry.record.destinationAccountId);
      return `${source?.name ?? ""} ${entry.record.sourceAccountName} ${destination?.name ?? ""} ${entry.record.destinationAccountName} ${entry.record.note ?? ""}`
        .toLocaleLowerCase("zh-TW")
        .includes(normalizedQuery);
    }
    const category = data.categories.find(
      (item) => item.id === entry.record.categoryId,
    );
    const account = data.accounts.find(
      (item) => item.id === entry.record.accountId,
    );
    return `${category?.name ?? entry.record.categoryName} ${account?.name ?? entry.record.accountName} ${entry.record.note ?? ""}`
      .toLocaleLowerCase("zh-TW")
      .includes(normalizedQuery);
  });

  const resetForm = () => {
    setAmount("");
    setNote("");
    setOccurredAt(toLocalInput());
    setEditing(null);
    setEditingTransfer(null);
    setQuickReentryParents(null);
    setOpenedTransferAccounts({
      source: data.accounts.find((account) => account.id === sourceAccountId),
      destination: data.accounts.find((account) => account.id === destinationAccountId),
    });
    setError("");
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const switchType = (next: "expense" | "income") => {
    setMode(next);
    setType(next);
    setEditingTransfer(null);
    setQuickReentryParents(null);
    setOpenedTransferAccounts({});
    setSourceAccountId("");
    setDestinationAccountId("");
    setCategoryId("");
    setError("");
    setSuccess("");
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const switchToTransfer = () => {
    setMode("transfer");
    setEditing(null);
    setQuickReentryParents(null);
    setCategoryId("");
    setError("");
    setSuccess("");
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "transfer") {
      const numericAmount = parseRequiredNumberInput(amount);
      if (numericAmount === null || numericAmount <= 0) {
        setError("請輸入大於 0、最多兩位小數的轉帳金額");
        return;
      }
      if (usableTransferAccounts.length < 2 && !editingTransfer) {
        setError("至少需要兩個可用的資產帳戶才能轉帳");
        return;
      }
      if (selectedTransferAccountUnavailable) {
        setError("原先選取的來源或目的帳戶目前不可用；請明確選擇可用帳戶。");
        return;
      }
      if (!resolvedSourceAccountId || !resolvedDestinationAccountId) {
        setError("請明確選擇來源帳戶與目的帳戶");
        return;
      }
      if (resolvedSourceAccountId === resolvedDestinationAccountId) {
        setError("來源帳戶與目的帳戶必須不同");
        return;
      }
      if (!occurredAt) {
        setError("請選擇轉帳時間");
        return;
      }
      const currentTransfer = editingTransfer
        ? data.transfers.find((record) => record.id === editingTransfer.id)
        : undefined;
      const resolvingTransferDependency = Boolean(
        editingTransfer && transferDependencyConflictIds.has(editingTransfer.id),
      );
      if (editingTransfer && isEditorSnapshotStale(editingTransfer, currentTransfer, {
        hasUnresolvedConflict: !resolvingTransferDependency && unresolvedSyncRecordKeys.has(
          syncRecordKey("transfers", editingTransfer.id),
        ),
      })) {
        setError("這筆轉帳已在背景更新、刪除或發生同步衝突；請重新開啟編輯。");
        return;
      }
      for (const [label, openedAccount] of [
        ["來源帳戶", openedTransferAccounts.source],
        ["目的帳戶", openedTransferAccounts.destination],
      ] as const) {
        if (!openedAccount) continue;
        const currentAccount = data.accounts.find((account) => account.id === openedAccount.id);
        if (isEditorSnapshotStale(openedAccount, currentAccount, {
          requireActive: openedAccount.isActive,
          allowDeleted: resolvingTransferDependency && Boolean(
            editingTransfer
            && (openedAccount.id === editingTransfer.sourceAccountId
              || openedAccount.id === editingTransfer.destinationAccountId),
          ),
          hasUnresolvedConflict: unresolvedSyncRecordKeys.has(
            syncRecordKey("accounts", openedAccount.id),
          ),
        })) {
          setError(`${label}已在背景更新、封存、刪除或發生同步衝突；請重新開啟編輯。`);
          return;
        }
      }

      try {
        const metadata = editingTransfer
          ? {
              id: editingTransfer.id,
              ownerId: editingTransfer.ownerId,
              ...changedRecordMeta(editingTransfer),
            }
          : newRecordMeta(ownerId);
        const record = buildTransferRecord(data, {
          amount: numericAmount,
          sourceAccountId: resolvedSourceAccountId,
          destinationAccountId: resolvedDestinationAccountId,
          occurredAt,
          note: note.trim() || undefined,
        }, metadata, editingTransfer ?? undefined);
        completeAppliedMutation(
          resolvingTransferDependency
            ? Boolean(confirmTransferAccounts?.(record))
            : put("transfers", record),
          () => {
            setSuccess(`${resolvingTransferDependency ? "已重新確認" : editingTransfer ? "已更新" : "已記下"}轉帳 ${displayMoney(numericAmount)}`);
            resetForm();
          },
          setError,
        );
      } catch (transferError) {
        setError(transferError instanceof Error ? transferError.message : String(transferError));
      }
      return;
    }
    const currentTransaction = editing
      ? data.transactions.find((record) => record.id === editing.id)
      : undefined;
    if (editing && isEditorSnapshotStale(editing, currentTransaction, {
      hasUnresolvedConflict: unresolvedSyncRecordKeys.has(
        syncRecordKey("transactions", editing.id),
      ),
    })) {
      setError("這筆交易已在背景更新、刪除或發生同步衝突；請重新開啟編輯。");
      return;
    }
    if (quickReentryParents) {
      const staleCategory = quickReentryParents.category && isEditorSnapshotStale(
        quickReentryParents.category,
        data.categories.find((item) => item.id === quickReentryParents.category!.id),
        {
          requireActive: true,
          hasUnresolvedConflict: unresolvedSyncRecordKeys.has(
            syncRecordKey("categories", quickReentryParents.category.id),
          ),
        },
      );
      const staleAccount = quickReentryParents.account && isEditorSnapshotStale(
        quickReentryParents.account,
        data.accounts.find((item) => item.id === quickReentryParents.account!.id),
        {
          requireActive: true,
          hasUnresolvedConflict: unresolvedSyncRecordKeys.has(
            syncRecordKey("accounts", quickReentryParents.account.id),
          ),
        },
      );
      if (staleCategory || staleAccount) {
        setError("快捷重填的分類或帳戶已在背景更新、封存、刪除或發生同步衝突；請重新選擇。");
        return;
      }
    }
    if (selectedCategoryUnavailable || selectedAccountUnavailable) {
      setError("原先選取的帳戶或分類目前不可用；本次交易未儲存，請明確選擇其他可用項目。");
      return;
    }
    const numericAmount = parseRequiredNumberInput(amount);
    const category = data.categories.find(
      (item) => item.id === resolvedCategoryId,
    );
    const account = accounts.find((item) => item.id === resolvedAccountId);
    if (numericAmount === null || numericAmount <= 0)
      return setError("請輸入大於 0、最多兩位小數的金額");
    if (!category || !account) return setError("請先建立可用的資產帳戶與分類");
    if (
      unresolvedSyncRecordKeys.has(syncRecordKey("categories", category.id))
      || unresolvedSyncRecordKeys.has(syncRecordKey("accounts", account.id))
    ) {
      return setError("所選帳戶或分類有未解同步衝突；請先選擇雲端版本，本次交易未儲存。");
    }
    if (!occurredAt) return setError("請選擇交易時間");

    const editingTutorial = Boolean(editing && isTutorialTransaction(editing));
    const creatingTutorial = tutorial?.step === "create" && !editing;
    const tutorialNote = editingTutorial || creatingTutorial;

    const record: Transaction = editing && currentTransaction
      ? {
          ...currentTransaction,
          ...changedRecordMeta(currentTransaction),
          amount: numericAmount,
          type,
          categoryId: category.id,
          categoryName: category.name,
          accountId: account.id,
          accountName: account.name,
          occurredAt,
          note: tutorialNote ? TUTORIAL_RECORD_NOTE : note.trim() || undefined,
        }
      : {
          ...newRecordMeta(ownerId),
          amount: numericAmount,
          type,
          categoryId: category.id,
          categoryName: category.name,
          accountId: account.id,
          accountName: account.name,
          occurredAt,
          note: tutorialNote ? TUTORIAL_RECORD_NOTE : note.trim() || undefined,
        };

    completeAppliedMutation(
      put("transactions", record),
      () => {
        try {
          localStorage.setItem(
            `shiba-finance:quick-picks:${ownerId}:${type}`,
            JSON.stringify({ categoryId: category.id, accountId: account.id }),
          );
        } catch {
          /* preference only */
        }
        setSuccess(
          `${editing ? "已更新" : "已記下"} ${type === "expense" ? "支出" : "收入"} ${displayMoney(numericAmount)}`,
        );
        if (tutorialNote) {
          onTutorialEvent?.(
            editing
              ? { type: "transaction-updated" }
              : { type: "transaction-created", recordId: record.id },
          );
        }
        resetForm();
      },
      setError,
    );
  };

  const beginEdit = (transaction: Transaction) => {
    setMode(transaction.type);
    setEditing(transaction);
    setEditingTransfer(null);
    setOpenedTransferAccounts({});
    setQuickReentryParents(null);
    setSourceAccountId("");
    setDestinationAccountId("");
    setType(transaction.type);
    setAmount(String(transaction.amount));
    setCategoryId(transaction.categoryId);
    setAccountId(transaction.accountId);
    setOccurredAt(transaction.occurredAt.slice(0, 16).replace(" ", "T"));
    setNote(isTutorialTransaction(transaction) ? "" : (transaction.note ?? ""));
    setSuccess("");
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (isTutorialTransaction(transaction))
      onTutorialEvent?.({ type: "edit-opened" });
  };

  const beginEditTransfer = (transfer: Transfer) => {
    setMode("transfer");
    setEditing(null);
    setEditingTransfer(transfer);
    setQuickReentryParents(null);
    setAmount(String(transfer.amount));
    setSourceAccountId(transfer.sourceAccountId);
    setDestinationAccountId(transfer.destinationAccountId);
    setOccurredAt(transfer.occurredAt.slice(0, 16).replace(" ", "T"));
    setNote(transfer.note ?? "");
    setOpenedTransferAccounts({
      source: data.accounts.find((account) => account.id === transfer.sourceAccountId),
      destination: data.accounts.find((account) => account.id === transfer.destinationAccountId),
    });
    setSuccess("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="quick-layout">
      <section className="quick-book" aria-labelledby="quick-entry-title">
        <div className="quick-book-header">
          <div>
            <p className="section-kicker">剛剛花了多少？</p>
            <h1 id="quick-entry-title">
              {editing || editingTransfer ? "修改這筆紀錄" : "極速記帳"}
            </h1>
          </div>
          <div
            className="today-mini"
            data-tutorial="today-summary"
            aria-label={`今日支出 ${displayMoney(today.expense)}`}
          >
            <span>今日支出</span>
            <strong>{displayMoney(today.expense, true)}</strong>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="entry-type-switch" role="group" aria-label="紀錄類型">
            <button
              type="button"
              className={mode === "expense" ? "active expense" : ""}
              aria-pressed={mode === "expense"}
              onClick={() => switchType("expense")}
            >
              記支出
            </button>
            <button
              type="button"
              className={mode === "income" ? "active income" : ""}
              aria-pressed={mode === "income"}
              onClick={() => switchType("income")}
            >
              記收入
            </button>
            <button
              type="button"
              className={mode === "transfer" ? "active transfer" : ""}
              aria-pressed={mode === "transfer"}
              disabled={Boolean(tutorial) || !transferMutationsEnabled}
              title={tutorial
                ? "互動教學期間先完成支出流程"
                : !transferMutationsEnabled
                  ? "緊急唯讀模式：仍會顯示與計算轉帳，但已停用轉帳寫入。"
                  : undefined}
              onClick={switchToTransfer}
            >
              記轉帳
            </button>
          </div>

          {quickReentryCandidates.length > 0 && (
            <section className="quick-reentry" aria-labelledby="quick-reentry-title">
              <div className="quick-reentry-heading">
                <span id="quick-reentry-title">再記一次</span>
                <small>帶入後仍可修改，確認儲存才會新增</small>
              </div>
              <div className="quick-reentry-list">
                {quickReentryCandidates.map((candidate) => (
                  <button
                    key={`${candidate.note}:${candidate.amount}:${candidate.categoryId}:${candidate.accountId}`}
                    type="button"
                    className="quick-reentry-card"
                    aria-label={`再記一次 ${candidate.note} ${displayMoney(candidate.amount)}`}
                    onClick={() => {
                      const category = data.categories.find((item) => item.id === candidate.categoryId);
                      const account = data.accounts.find((item) => item.id === candidate.accountId);
                      if (!category || !account) return;
                      setAmount(String(candidate.amount));
                      setNote(candidate.note);
                      setCategoryId(candidate.categoryId);
                      setAccountId(candidate.accountId);
                      setQuickReentryParents({ category, account });
                      setError("");
                      setSuccess("");
                      requestAnimationFrame(() => amountRef.current?.focus());
                    }}
                  >
                    <strong>{candidate.note} · {displayMoney(candidate.amount)}</strong>
                    <small>{candidate.categoryName} · {candidate.accountName}</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          <label className={`amount-stage ${mode}`} data-tutorial="amount">
            <span>{mode === "transfer" ? "轉帳金額" : type === "expense" ? "支出金額" : "收入金額"}</span>
            <MoneyInput
              ref={amountRef}
              className="amount-input-wrap"
              autoFocus
              aria-label="金額"
              placeholder="0"
              value={amount}
              allowDecimal
              onBlur={() => {
                const numeric = parseRequiredNumberInput(amount);
                if (tutorial?.step === "amount" && numeric && numeric > 0)
                  onTutorialEvent?.({ type: "amount-ready" });
              }}
              onValueChange={(value) => {
                setAmount(value);
                setError("");
                setSuccess("");
                if (
                  tutorial?.step === "edit-amount" &&
                  editing &&
                  isTutorialTransaction(editing) &&
                  value !== String(editing.amount)
                )
                  onTutorialEvent?.({ type: "amount-changed" });
              }}
            />
          </label>

          {mode !== "transfer" && <fieldset className="choice-section" data-tutorial="category">
            <legend>選擇分類</legend>
            <div className="category-grid">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  className={`category-choice ${resolvedCategoryId === category.id ? "selected" : ""}`}
                  aria-pressed={resolvedCategoryId === category.id}
                  disabled={unresolvedSyncRecordKeys.has(syncRecordKey("categories", category.id))}
                  title={unresolvedSyncRecordKeys.has(syncRecordKey("categories", category.id))
                    ? "此分類有未解同步衝突，暫時無法用於新交易。"
                    : undefined}
                  onClick={() => {
                    setCategoryId(category.id);
                    setQuickReentryParents((current) => current?.account
                      ? { account: current.account }
                      : null);
                    onTutorialEvent?.({ type: "category-selected" });
                  }}
                >
                  <span>
                    <FinanceIcon icon={category.icon} />
                  </span>
                  <b>{category.name}</b>
                </button>
              ))}
            </div>
          </fieldset>}

          {mode !== "transfer" ? <fieldset
            className="choice-section account-choices"
            data-tutorial="account"
          >
            <legend>
              從哪個資產帳戶{type === "expense" ? "付款" : "存入"}？
            </legend>
            <div className="chip-row">
              {accounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  className={`account-chip ${resolvedAccountId === account.id ? "selected" : ""}`}
                  aria-pressed={resolvedAccountId === account.id}
                  disabled={unresolvedSyncRecordKeys.has(syncRecordKey("accounts", account.id))}
                  title={unresolvedSyncRecordKeys.has(syncRecordKey("accounts", account.id))
                    ? "此帳戶有未解同步衝突，暫時無法用於新交易。"
                    : undefined}
                  onClick={() => {
                    setAccountId(account.id);
                    setQuickReentryParents((current) => current?.category
                      ? { category: current.category }
                      : null);
                    onTutorialEvent?.({ type: "account-selected" });
                  }}
                >
                  <FinanceIcon icon={account.icon} />
                  {account.name}
                </button>
              ))}
            </div>
          </fieldset> : (
            <div className="transfer-accounts" aria-label="轉帳帳戶">
              {usableTransferAccounts.length < 2 && !editingTransfer && (
                <p className="error-message" role="status">
                  至少需要兩個可用的資產帳戶才能建立轉帳。
                </p>
              )}
              <fieldset className="choice-section account-choices">
                <legend>從哪個資產帳戶轉出？</legend>
                <div className="chip-row">
                  {transferAccounts.map((account) => {
                    const locked = unresolvedSyncRecordKeys.has(syncRecordKey("accounts", account.id));
                    return (
                      <button
                        type="button"
                        key={`source:${account.id}`}
                        className={`account-chip ${resolvedSourceAccountId === account.id ? "selected" : ""}`}
                        aria-pressed={resolvedSourceAccountId === account.id}
                        disabled={locked || Boolean(account.deletedAt)}
                        onClick={() => {
                          setSourceAccountId(account.id);
                          setOpenedTransferAccounts((current) => ({ ...current, source: account }));
                          setError("");
                        }}
                      >
                        <FinanceIcon icon={account.icon} />
                        {account.name}{!account.isActive ? "（已封存）" : ""}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <button
                type="button"
                className="secondary-button transfer-swap"
                aria-label="交換來源與目的帳戶"
                onClick={() => {
                  setSourceAccountId(destinationAccountId);
                  setDestinationAccountId(sourceAccountId);
                  setOpenedTransferAccounts((current) => ({
                    source: current.destination,
                    destination: current.source,
                  }));
                  setError("");
                }}
              >
                <ArrowLeftRight className="h-4 w-4" />
                交換帳戶
              </button>
              <fieldset className="choice-section account-choices">
                <legend>要轉入哪個資產帳戶？</legend>
                <div className="chip-row">
                  {transferAccounts.map((account) => {
                    const locked = unresolvedSyncRecordKeys.has(syncRecordKey("accounts", account.id));
                    return (
                      <button
                        type="button"
                        key={`destination:${account.id}`}
                        className={`account-chip ${resolvedDestinationAccountId === account.id ? "selected" : ""}`}
                        aria-pressed={resolvedDestinationAccountId === account.id}
                        disabled={locked || Boolean(account.deletedAt)}
                        onClick={() => {
                          setDestinationAccountId(account.id);
                          setOpenedTransferAccounts((current) => ({ ...current, destination: account }));
                          setError("");
                        }}
                      >
                        <FinanceIcon icon={account.icon} />
                        {account.name}{!account.isActive ? "（已封存）" : ""}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </div>
          )}

          {mode !== "transfer" && (selectedCategoryUnavailable || selectedAccountUnavailable) && (
            <p className="error-message" role="alert">
              原先選取的{selectedCategoryUnavailable ? "分類" : "帳戶"}目前不可用，請明確選擇其他可用項目。
            </p>
          )}
          {mode === "transfer" && selectedTransferAccountUnavailable && (
            <p className="error-message" role="alert">
              原先選取的來源或目的帳戶目前不可用，請明確選擇可用帳戶。
            </p>
          )}

          <details
            className="optional-details"
            open={Boolean(editing || editingTransfer || addingNoteShortcut
              || note.length > 0 || pinnedNoteShortcuts.length > 0
              || commonNoteSuggestions.length > 0)}
          >
            <summary>
              <ChevronDown className="h-4 w-4" />
              補充時間或備註
            </summary>
            <div className="optional-grid">
              <label className="field-label">
                <CalendarClock className="h-4 w-4" />
                {mode === "transfer" ? "轉帳時間" : "交易時間"}
                <input
                  aria-label={mode === "transfer" ? "轉帳時間" : "交易時間"}
                  type="datetime-local"
                  className="field mt-1"
                  value={occurredAt}
                  onChange={(event) => setOccurredAt(event.target.value)}
                />
              </label>
              <label className="field-label">
                備註（選填）
                <input
                  aria-label="備註"
                  className="field mt-1"
                  placeholder="例如：早餐、全聯採買"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
            </div>
            <div className="note-suggestion-group pinned-note-shortcuts" aria-label="我的快捷備註">
              <div className="note-suggestion-heading">
                <span>我的快捷</span>
                <small>只保存在這台裝置</small>
              </div>
              <div className="chip-row">
                {pinnedNoteShortcuts.map((shortcut) => (
                  <span className="pinned-note-item" key={shortcut}>
                    <button
                      type="button"
                      className="note-suggestion-chip pinned"
                      aria-label={`使用我的快捷 ${shortcut}`}
                      onClick={() => setNote(shortcut)}
                    >
                      {shortcut}
                    </button>
                    <button
                      type="button"
                      className="remove-note-shortcut"
                      aria-label={`移除快捷備註 ${shortcut}`}
                      onClick={() => changeNoteShortcut({ type: "remove", note: shortcut })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="note-suggestion-chip add"
                  aria-label="新增快捷備註"
                  onClick={() => {
                    setAddingNoteShortcut(true);
                    setNoteShortcutError("");
                  }}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {addingNoteShortcut && (
                <div className="add-note-shortcut-row">
                  <input
                    className="field"
                    aria-label="新的快捷備註"
                    placeholder="例如：滷肉飯"
                    value={noteShortcutDraft}
                    onChange={(event) => {
                      setNoteShortcutDraft(event.target.value);
                      setNoteShortcutError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        changeNoteShortcut({ type: "add", note: noteShortcutDraft });
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => changeNoteShortcut({ type: "add", note: noteShortcutDraft })}
                  >
                    加入快捷備註
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setAddingNoteShortcut(false);
                      setNoteShortcutDraft("");
                      setNoteShortcutError("");
                    }}
                  >
                    取消新增
                  </button>
                </div>
              )}
              {noteShortcutError && <small role="status">{noteShortcutError}</small>}
            </div>
            {commonNoteSuggestions.length > 0 && (
              <div className="note-suggestion-group" aria-label="常用備註">
                <span>常用：</span>
                <div className="chip-row">
                  {commonNoteSuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="note-suggestion-chip"
                      aria-label={`使用常用備註 ${suggestion}`}
                      onClick={() => setNote(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </details>

          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {success && (
            <p className="success-message" role="status">
              <Check className="h-4 w-4" />
              {success}
            </p>
          )}
          <div className="entry-actions">
            <button
              className={`save-entry ${mode}`}
              type="submit"
              data-tutorial="create"
              disabled={mode === "transfer"
                ? Boolean(
                    (editingTransfer
                      && !transferDependencyConflictIds.has(editingTransfer.id)
                      && unresolvedSyncRecordKeys.has(
                      syncRecordKey("transfers", editingTransfer.id),
                    ))
                    || !resolvedSourceAccountId
                    || !resolvedDestinationAccountId
                    || resolvedSourceAccountId === resolvedDestinationAccountId
                    || (usableTransferAccounts.length < 2 && !editingTransfer)
                    || unresolvedSyncRecordKeys.has(
                      syncRecordKey("accounts", resolvedSourceAccountId),
                    )
                    || unresolvedSyncRecordKeys.has(
                      syncRecordKey("accounts", resolvedDestinationAccountId),
                    ),
                  )
                : Boolean(editing && unresolvedSyncRecordKeys.has(
                    syncRecordKey("transactions", editing.id),
                  )) || !resolvedCategoryId || !resolvedAccountId
                    || unresolvedSyncRecordKeys.has(syncRecordKey("categories", resolvedCategoryId))
                    || unresolvedSyncRecordKeys.has(syncRecordKey("accounts", resolvedAccountId))}
              title={mode === "transfer"
                ? selectedTransferAccountUnavailable
                  ? "原先選取的來源或目的帳戶目前不可用，請明確選擇可用帳戶。"
                  : undefined
                : selectedCategoryUnavailable || selectedAccountUnavailable
                  ? "原先選取的帳戶或分類目前不可用，請明確選擇其他可用項目。"
                  : undefined}
            >
              {editingTransfer
                ? "儲存轉帳修改"
                : mode === "transfer"
                  ? "記下這筆轉帳"
                  : editing
                    ? "儲存修改"
                    : `記下這筆${type === "expense" ? "支出" : "收入"}`}
            </button>
            {(editing || editingTransfer) && (
              <button
                className="secondary-button"
                type="button"
                onClick={resetForm}
              >
                取消
              </button>
            )}
          </div>
        </form>
      </section>

      <section
        className="ledger-paper"
        aria-labelledby="history-title"
        data-tutorial="ledger"
      >
        <div className="ledger-heading">
          <div>
            <p className="section-kicker">我的生活帳本</p>
            <h2 id="history-title">最近紀錄</h2>
          </div>
          <label className="ledger-search">
            <Search className="h-4 w-4" />
            <input
              aria-label="搜尋帳本"
              placeholder="搜尋分類、帳戶、轉帳、備註"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {filteredHistory.length === 0 ? (
          <div className="friendly-empty">
            <span>🐕</span>
            <strong>
              {query ? "沒有符合的紀錄" : "從第一筆開始，慢慢看見生活的樣子。"}
            </strong>
            <p>
              {query
                ? "換個關鍵字再找找看。"
                : "上方只要輸入金額、選分類和帳戶，就完成了。"}
            </p>
          </div>
        ) : (
          <div className="ledger-list">
            {filteredHistory.slice(0, historyLimit).map((entry) => {
              if (entry.kind === "adjustment") {
                const account = data.accounts.find(
                  (item) => item.id === entry.record.accountId,
                );
                return (
                  <article
                    className="ledger-row"
                    key={`adjustment:${entry.record.id}`}
                    data-testid="adjustment-row"
                  >
                    <span className="record-icon">⚖️</span>
                    <div>
                      <strong>帳戶餘額調整</strong>
                      <small>
                        {account?.name ?? "未知帳戶"} ·{" "}
                        {shortDate(entry.record.occurredAt)}
                        {entry.record.reason ? ` · ${entry.record.reason}` : ""}
                      </small>
                    </div>
                    <b className="adjustment">
                      {entry.record.amountDelta > 0 ? "+" : "−"}
                      {displayMoney(Math.abs(entry.record.amountDelta))}
                    </b>
                  </article>
                );
              }
              if (entry.kind === "transfer") {
                const transfer = entry.record;
                const source = data.accounts.find(
                  (item) => item.id === transfer.sourceAccountId,
                );
                const destination = data.accounts.find(
                  (item) => item.id === transfer.destinationAccountId,
                );
                const hasUnresolvedConflict = unresolvedSyncRecordKeys.has(
                  syncRecordKey("transfers", transfer.id),
                );
                const hasDependencyConflict = transferDependencyConflictIds.has(transfer.id);
                const hasParentConflict = unresolvedSyncRecordKeys.has(
                  syncRecordKey("accounts", transfer.sourceAccountId),
                ) || unresolvedSyncRecordKeys.has(
                  syncRecordKey("accounts", transfer.destinationAccountId),
                );
                const mutationBlocked = (hasUnresolvedConflict && !hasDependencyConflict)
                  || hasParentConflict;
                const transferLabel = `${source?.name ?? transfer.sourceAccountName} 轉至 ${destination?.name ?? transfer.destinationAccountName}`;
                return (
                  <article
                    className="ledger-row transfer-row"
                    key={`transfer:${transfer.id}`}
                    data-testid="transfer-row"
                  >
                    <span className="record-icon transfer"><ArrowLeftRight className="h-4 w-4" /></span>
                    <div>
                      <strong>{transferLabel}</strong>
                      <small>
                        {shortDate(transfer.occurredAt)}
                        {transfer.note ? ` · ${transfer.note}` : ""}
                      </small>
                      {hasDependencyConflict && (
                        <small role="status">
                          所選帳戶已在轉帳上傳前變更；請重新選擇並確認兩個帳戶。
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={!transferMutationsEnabled}
                            onClick={() => beginEditTransfer(transfer)}
                          >
                            重新選擇並確認
                          </button>
                        </small>
                      )}
                      {hasUnresolvedConflict && !hasDependencyConflict && (
                        <small role="status">
                          同步衝突：編輯與刪除已暫停。
                          {acceptRemoteTransferConflict && (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => acceptRemoteTransferConflict(transfer.id)}
                            >
                              使用雲端版本
                            </button>
                          )}
                        </small>
                      )}
                      {!hasUnresolvedConflict && hasParentConflict && (
                        <small role="status">來源或目的帳戶有同步衝突：編輯與刪除已暫停。</small>
                      )}
                    </div>
                    <b className="transfer">{displayMoney(transfer.amount)}</b>
                    <span className="row-actions">
                      <button
                        type="button"
                        aria-label={`編輯轉帳 ${transferLabel}`}
                        disabled={mutationBlocked || !transferMutationsEnabled}
                        title={!transferMutationsEnabled
                          ? "緊急唯讀模式已停用轉帳編輯。"
                          : mutationBlocked ? "此轉帳或其帳戶有未解同步衝突，請先完成處理。" : undefined}
                        onClick={() => beginEditTransfer(transfer)}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`刪除轉帳 ${transferLabel}`}
                        disabled={mutationBlocked || !transferMutationsEnabled}
                        title={!transferMutationsEnabled
                          ? "緊急唯讀模式已停用轉帳刪除。"
                          : mutationBlocked ? "此轉帳或其帳戶有未解同步衝突，請先完成處理。" : undefined}
                        onClick={() => {
                          if (window.confirm("刪除這筆轉帳？兩個帳戶的餘額都會一併回復。")) {
                            deleteTransfer(transfer);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  </article>
                );
              }
              const transaction = entry.record;
              const hasUnresolvedConflict = unresolvedSyncRecordKeys.has(
                syncRecordKey("transactions", transaction.id),
              );
              const hasParentConflict = unresolvedSyncRecordKeys.has(
                syncRecordKey("accounts", transaction.accountId),
              ) || unresolvedSyncRecordKeys.has(
                syncRecordKey("categories", transaction.categoryId),
              ) || Boolean(transaction.recurringRuleId && unresolvedSyncRecordKeys.has(
                syncRecordKey("recurringRules", transaction.recurringRuleId),
              ));
              const mutationBlocked = hasUnresolvedConflict || hasParentConflict;
              const tutorialRow = isTutorialTransaction(transaction);
              const category = data.categories.find(
                (item) => item.id === transaction.categoryId,
              );
              const account = data.accounts.find(
                (item) => item.id === transaction.accountId,
              );
              return (
                <article
                  className={`ledger-row ${tutorialRow ? "tutorial-record-row" : ""}`}
                  key={transaction.id}
                  data-testid="transaction-row"
                  data-tutorial={tutorialRow ? "tutorial-record" : undefined}
                >
                  <span className="record-icon">
                    <FinanceIcon
                      icon={category?.icon ?? { type: "emoji", value: "🧾" }}
                    />
                  </span>
                  <div>
                    <strong>
                      {category?.name ?? transaction.categoryName}
                      {tutorialRow && (
                        <em className="tutorial-record-badge">
                          教學紀錄 · 完成後刪除
                        </em>
                      )}
                    </strong>
                    <small>
                      {account?.name ?? transaction.accountName} ·{" "}
                      {shortDate(transaction.occurredAt)}
                      {!tutorialRow && transaction.note
                        ? ` · ${transaction.note}`
                        : ""}
                    </small>
                    {hasUnresolvedConflict && (
                      <small role="status">
                        同步衝突：編輯與刪除已暫停。
                        {acceptRemoteConflict && (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => acceptRemoteConflict(transaction.id)}
                          >
                            使用雲端版本
                          </button>
                        )}
                      </small>
                    )}
                    {!hasUnresolvedConflict && hasParentConflict && (
                      <small role="status">關聯帳戶、分類或週期規則有同步衝突：編輯與刪除已暫停。</small>
                    )}
                  </div>
                  <b className={transaction.type}>
                    {transaction.type === "income" ? "+" : "−"}
                    {displayMoney(transaction.amount)}
                  </b>
                  <span className="row-actions">
                    <button
                      type="button"
                      aria-label={`編輯 ${category?.name ?? transaction.categoryName}`}
                      disabled={mutationBlocked}
                      title={mutationBlocked
                        ? "此交易或其關聯資料有未解同步衝突，請先完成處理。"
                        : undefined}
                      onClick={() => beginEdit(transaction)}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`刪除 ${category?.name ?? transaction.categoryName}`}
                      disabled={mutationBlocked}
                      title={mutationBlocked
                        ? "此交易或其關聯資料有未解同步衝突，請先完成處理。"
                        : undefined}
                      onClick={() => {
                        if (
                          window.confirm("刪除這筆紀錄？它不會再出現在帳本中。")
                        ) {
                          const deleted = deleteTransaction(transaction);
                          if (deleted && tutorialRow)
                            onTutorialEvent?.({ type: "transaction-deleted" });
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </article>
              );
            })}
            {filteredHistory.length > historyLimit && (
              <button
                type="button"
                className="load-more"
                onClick={() =>
                  setHistoryLimit((value) => value + ledgerPageSize)
                }
              >
                載入更多歷史（剩餘 {filteredHistory.length - historyLimit} 筆）
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
