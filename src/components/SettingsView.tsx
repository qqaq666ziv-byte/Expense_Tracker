import { useState, type ChangeEvent, type FormEvent } from "react";
import {
  Archive,
  Download,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  Category,
  FinanceData,
  IconRef,
  RecurringRule,
} from "../domain/model";
import { isEditorSnapshotStale } from "../domain/staleEditor";
import { syncRecordKey } from "../domain/syncEngine";
import {
  BackupSizeLimitError,
  exportFinanceBackup,
  exportTransactionsCsv,
  MAX_BACKUP_BYTES,
  restoreFinanceBackup,
} from "../domain/backup";
import {
  getRecurringEditCursor,
  getNextOccurrenceDate,
  getRecurringCatchUpStatus,
  MAX_RECURRING_CATCH_UP_OCCURRENCES,
} from "../domain/recurrence";
import { nextDisplayOrder, sortByDisplayOrder } from "../domain/displayOrder";
import { stableLegacyId } from "../domain/legacyMigration";
import { changedRecordMeta, newRecordMeta } from "../app/state";
import { localDate, money, parseRequiredNumberInput } from "../app/format";
import { completeAppliedMutation } from "../app/mutationResult";
import { resolveExplicitSelection } from "../app/explicitSelection";
import { FinanceIcon, IconPicker } from "./FinanceIcon";
import { MoneyInput } from "./MoneyInput";
import {
  assertCategoryUpsert,
  findCategoryNameConflict,
  getCategoryActionBlock,
  getCategoryDisplayStatus,
  normalizeCategoryName,
  type CategoryAction,
} from "../domain/lifecycle";

interface SettingsViewProps {
  data: FinanceData;
  ownerId: string;
  putCategory(record: Category): boolean;
  putRecurring(record: RecurringRule): boolean;
  categoryLifecycle(record: Category, action: CategoryAction): boolean;
  deleteRecurring(record: RecurringRule): boolean;
  restore(data: FinanceData): void;
  unresolvedSyncRecordKeys?: ReadonlySet<string>;
}

type Section = "categories" | "recurring" | "backup";

export function SettingsView(props: SettingsViewProps) {
  const [section, setSection] = useState<Section>("categories");
  const items: { key: Section; label: string }[] = [
    { key: "categories", label: "分類" },
    { key: "recurring", label: "週期收支" },
    { key: "backup", label: "資料備份" },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 rounded-2xl bg-white p-1 shadow-sm dark:bg-zinc-900">
        {items.map((item) => (
          <button
            type="button"
            className={`tab-button ${section === item.key ? "tab-button-active" : ""}`}
            key={item.key}
            aria-pressed={section === item.key}
            onClick={() => setSection(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {section === "categories" && <CategoriesPanel {...props} />}
      {section === "recurring" && <RecurringPanel {...props} />}
      {section === "backup" && <BackupPanel {...props} />}
    </div>
  );
}

function CategoriesPanel({
  data,
  ownerId,
  putCategory,
  categoryLifecycle,
  unresolvedSyncRecordKeys = new Set(),
}: SettingsViewProps) {
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [editing, setEditing] = useState<Category | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<IconRef>({ type: "emoji", value: "🍜" });
  const [sortOrder, setSortOrder] = useState(() => String(
    nextDisplayOrder(data.categories.filter((item) => item.kind === "expense" && !item.deletedAt)) + 1,
  ));
  const [message, setMessage] = useState("");
  const categories = sortByDisplayOrder(
    data.categories.filter((item) => !item.deletedAt),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setMessage("請輸入分類名稱");
      return;
    }
    const parsedOrder = Number(sortOrder);
    if (!Number.isInteger(parsedOrder) || parsedOrder < 1) {
      setMessage("顯示順序必須是大於 0 的整數");
      return;
    }
    if (editing && unresolvedSyncRecordKeys.has(syncRecordKey("categories", editing.id))) {
      setMessage("此分類有未解同步衝突；資料未變更，請先從同步狀態完成處理");
      return;
    }
    const record: Category = editing
      ? { ...editing, ...changedRecordMeta(editing), name: name.trim(), icon }
      : {
          ...newRecordMeta(ownerId),
          id: stableLegacyId("category", ownerId, "semantic-v1", kind, normalizeCategoryName(name)),
          kind,
          name: name.trim(),
          icon,
          isActive: true,
          sortOrder: parsedOrder - 1,
        };
    record.sortOrder = parsedOrder - 1;
    try {
      assertCategoryUpsert(data, record);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    completeAppliedMutation(
      putCategory(record),
      () => {
        const groupCount = categories.filter((item) => item.kind === kind).length;
        setEditing(null);
        setName("");
        setSortOrder(String(groupCount + (editing ? 1 : 2)));
        setIcon({ type: "emoji", value: kind === "expense" ? "🍜" : "💰" });
        setMessage(editing ? "分類已更新" : "分類已建立");
      },
      setMessage,
    );
  };
  const edit = (category: Category) => {
    setMessage("");
    setEditing(category);
    setKind(category.kind);
    setName(category.name);
    setIcon(category.icon);
    setSortOrder(String(category.sortOrder + 1));
  };
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">選一個喜歡的圖案</p>
            <h2>{editing ? "編輯分類" : "新增分類"}</h2>
          </div>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <label className="field-label">
            收支類型
            <select
              aria-label="分類收支類型"
              disabled={Boolean(editing)}
              className="field mt-1"
              value={kind}
              onChange={(event) => {
                const nextKind = event.target.value as typeof kind;
                setKind(nextKind);
                setSortOrder(String(nextDisplayOrder(categories.filter((item) => item.kind === nextKind)) + 1));
              }}
            >
              <option value="expense">支出</option>
              <option value="income">收入</option>
            </select>
          </label>
          <label className="field-label">
            名稱
            <input
              aria-label="分類名稱"
              className="field mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field-label">
            顯示順序
            <input
              aria-label="分類顯示順序"
              className="field mt-1"
              type="number"
              min="1"
              step="1"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </label>
          <IconPicker value={icon} onChange={setIcon} />
          <div className="flex gap-2">
            <button className="primary-button flex-1" type="submit">
              <Save className="h-4 w-4" />
              儲存分類
            </button>
            {editing && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setEditing(null);
                  setName("");
                  setSortOrder(String(categories.filter((item) => item.kind === kind).length + 1));
                }}
              >
                取消
              </button>
            )}
          </div>
          {message && (
            <p aria-live="polite" className="text-sm text-zinc-500">
              {message}
            </p>
          )}
        </form>
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">過去紀錄不受影響</p>
            <h2>分類清單</h2>
          </div>
        </div>
        {(["expense", "income"] as const).map((group) => (
          <div className="mb-4" key={group}>
            <p className="mb-2 text-xs font-black text-zinc-400">
              {group === "expense" ? "支出分類" : "收入分類"}
            </p>
            <div className="space-y-2">
              {categories
                .filter((item) => item.kind === group)
                .map((category) => {
                  const status = getCategoryDisplayStatus(data, category);
                  const duplicate = findCategoryNameConflict(categories, category.kind, category.name, category.id);
                  const archiveBlock = getCategoryActionBlock(data, category, "archive");
                  const deleteBlock = getCategoryActionBlock(data, category, "delete");
                  const conflictBlocked = unresolvedSyncRecordKeys.has(
                    syncRecordKey("categories", category.id),
                  );
                  return <article
                    className={`settings-row ${category.isActive ? "" : "opacity-55"}`}
                    key={category.id}
                  >
                    <span className="icon-badge">
                      <FinanceIcon icon={category.icon} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate">{category.name}</strong>
                      <span className="text-xs text-zinc-500">
                        {status === "archived" ? "已封存" : status === "unused" ? "未使用" : "使用中"}
                        {duplicate ? " · 名稱重複，請手動處理" : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`編輯 ${category.name}`}
                      disabled={conflictBlocked}
                      title={conflictBlocked
                        ? "此分類有未解同步衝突，請先完成同步後再編輯。"
                        : undefined}
                      onClick={() => edit(category)}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    {category.isActive ? (
                      <button
                        className="icon-button"
                        type="button"
                        disabled={Boolean(archiveBlock) || conflictBlocked}
                        aria-label={`封存 ${category.name}`}
                        title={conflictBlocked
                          ? "此分類有未解同步衝突，請先選擇雲端版本。"
                          : archiveBlock?.message ?? "封存"}
                        onClick={() => {
                          if (archiveBlock) return setMessage(archiveBlock.message);
                          completeAppliedMutation(
                            categoryLifecycle(category, "archive"),
                            () => setMessage(`已封存「${category.name}」；過去資料完整保留`),
                            setMessage,
                          );
                        }}
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        aria-label={`重新啟用 ${category.name}`}
                        disabled={conflictBlocked}
                        title={conflictBlocked
                          ? "此分類有未解同步衝突，請先選擇雲端版本。"
                          : undefined}
                        onClick={() => completeAppliedMutation(
                          categoryLifecycle(category, "restore"),
                          () => setMessage(`已重新啟用「${category.name}」`),
                          setMessage,
                        )}
                      >
                        啟用
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`刪除 ${category.name}`}
                      disabled={Boolean(deleteBlock) || conflictBlocked}
                      title={conflictBlocked
                        ? "此分類有未解同步衝突，請先選擇雲端版本。"
                        : deleteBlock?.message ?? "刪除未使用分類"}
                      onClick={() => {
                        if (deleteBlock) return setMessage(deleteBlock.message);
                        if (!window.confirm(`刪除未使用分類「${category.name}」？此操作會以同步刪除標記保留防復活紀錄，不代表立即永久抹除。`)) return;
                        completeAppliedMutation(
                          categoryLifecycle(category, "delete"),
                          () => setMessage(`已刪除未使用分類「${category.name}」`),
                          setMessage,
                        );
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </article>
                })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

export interface RecurringPanelProps {
  data: FinanceData;
  ownerId: string;
  putRecurring(record: RecurringRule): boolean;
  deleteRecurring(record: RecurringRule): boolean;
  unresolvedSyncRecordKeys?: ReadonlySet<string>;
}

export function includeCurrentInactiveOption<T extends { id: string }>(
  active: readonly T[],
  current?: T,
): T[] {
  return current && !active.some((item) => item.id === current.id)
    ? [current, ...active]
    : [...active];
}

export function getRecurringResumeBlock(
  data: Pick<FinanceData, "categories" | "accounts">,
  rule: RecurringRule,
): string | undefined {
  const category = data.categories.find((item) => (
    item.id === rule.categoryId && item.kind === rule.type && item.isActive && !item.deletedAt
  ));
  const account = data.accounts.find((item) => (
    item.id === rule.accountId && item.isActive && !item.deletedAt
  ));
  return category && account
    ? undefined
    : "分類或帳戶目前已封存；請先重新啟用後再恢復週期規則";
}

export function isRecurringEditStale(
  opened: RecurringRule,
  current: RecurringRule | undefined,
  hasUnresolvedConflict = false,
): boolean {
  return isEditorSnapshotStale(opened, current, { hasUnresolvedConflict });
}

export function RecurringPanel({
  data,
  ownerId,
  putRecurring,
  deleteRecurring,
  unresolvedSyncRecordKeys = new Set(),
}: RecurringPanelProps) {
  const [editing, setEditing] = useState<RecurringRule | null>(null);
  const [type, setType] = useState<"expense" | "income">("expense");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [frequency, setFrequency] = useState<"weekly" | "monthly" | "yearly">(
    "monthly",
  );
  const [startDate, setStartDate] = useState(localDate());
  const [message, setMessage] = useState("");
  const activeCategories = sortByDisplayOrder(
    data.categories.filter(
      (item) => item.kind === type && item.isActive && !item.deletedAt,
    ),
  );
  const editingCategory = editing && editing.type === type
    ? data.categories.find((item) => item.id === editing.categoryId && !item.deletedAt)
    : undefined;
  const categories = includeCurrentInactiveOption(activeCategories, editingCategory);
  const activeAccounts = sortByDisplayOrder(
    data.accounts.filter((item) => item.isActive && !item.deletedAt),
  );
  const editingAccount = editing
    ? data.accounts.find((item) => item.id === editing.accountId && !item.deletedAt)
    : undefined;
  const accounts = includeCurrentInactiveOption(activeAccounts, editingAccount);
  const selectableCategories = categories.filter((item) => (
    !unresolvedSyncRecordKeys.has(syncRecordKey("categories", item.id))
  ));
  const selectableAccounts = accounts.filter((item) => (
    !unresolvedSyncRecordKeys.has(syncRecordKey("accounts", item.id))
  ));
  const resolvedCategoryId = resolveExplicitSelection(categoryId, selectableCategories);
  const resolvedAccountId = resolveExplicitSelection(accountId, selectableAccounts);
  const resolvedCategory = selectableCategories.find((item) => item.id === resolvedCategoryId);
  const resolvedAccount = selectableAccounts.find((item) => item.id === resolvedAccountId);
  const selectedCategoryUnavailable = Boolean(categoryId && !resolvedCategoryId);
  const selectedAccountUnavailable = Boolean(accountId && !resolvedAccountId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const numeric = parseRequiredNumberInput(amount);
    if (selectedCategoryUnavailable || selectedAccountUnavailable) {
      setMessage("原先選取的分類或帳戶目前不可用；資料未變更，請明確選擇其他可用項目");
      return;
    }
    if (
      !name.trim() ||
      !resolvedCategory ||
      !resolvedAccount ||
      numeric === null ||
      numeric <= 0 ||
      !startDate
    ) {
      setMessage(
        "請完整輸入名稱、正數且最多兩位小數、可安全精確處理的金額、分類、帳戶與開始日",
      );
      return;
    }
    const currentRule = editing
      ? data.recurringRules.find((item) => item.id === editing.id && !item.deletedAt)
      : undefined;
    const hasUnresolvedConflict = editing
      ? unresolvedSyncRecordKeys.has(syncRecordKey("recurringRules", editing.id))
        || unresolvedSyncRecordKeys.has(syncRecordKey("accounts", editing.accountId))
        || unresolvedSyncRecordKeys.has(syncRecordKey("categories", editing.categoryId))
      : false;
    if (hasUnresolvedConflict) {
      setMessage("此週期規則有未解同步衝突；資料未變更，請先從同步狀態完成處理");
      return;
    }
    if (editing && !currentRule) {
      setMessage("找不到要編輯的週期規則；資料未變更");
      return;
    }
    if (editing && currentRule && isRecurringEditStale(
      editing,
      currentRule,
      hasUnresolvedConflict,
    )) {
      setMessage("此週期規則已在背景更新；為避免覆蓋較新排程，請取消後重新開啟編輯");
      return;
    }
    const baseRule: RecurringRule = {
      ...(currentRule ?? newRecordMeta(ownerId)),
      ...(currentRule ? changedRecordMeta(currentRule) : {}),
      name: name.trim(),
      type,
      amount: numeric,
      categoryId: resolvedCategory.id,
      categoryName: resolvedCategory.name,
      accountId: resolvedAccount.id,
      accountName: resolvedAccount.name,
      frequency,
      startDate,
      anchorDay: currentRule && currentRule.startDate === startDate
        ? currentRule.anchorDay
        : Number(startDate.slice(8, 10)),
      nextOccurrenceDate: currentRule?.nextOccurrenceDate ?? startDate,
      isActive: currentRule?.isActive ?? true,
    };
    const rule = currentRule
      ? {
          ...baseRule,
          nextOccurrenceDate: getRecurringEditCursor(currentRule, baseRule, data.transactions),
        }
      : baseRule;
    if (getRecurringCatchUpStatus(rule, localDate()).blocked) {
      setMessage(
        `截至今天待補期數超過 ${MAX_RECURRING_CATCH_UP_OCCURRENCES} 筆安全上限；規則未建立，也未略過任何期數。請選擇較近的開始日。`,
      );
      return;
    }
    completeAppliedMutation(
      putRecurring(rule),
      () => {
        setEditing(null);
        setName("");
        setAmount("");
        setMessage(editing ? "週期規則已更新；歷史交易未改寫" : "週期規則已建立");
      },
      setMessage,
    );
  };
  const edit = (rule: RecurringRule) => {
    setEditing(rule);
    setType(rule.type);
    setName(rule.name);
    setAmount(String(rule.amount));
    setCategoryId(rule.categoryId);
    setAccountId(rule.accountId);
    setFrequency(rule.frequency);
    setStartDate(rule.startDate);
    setMessage("");
  };
  const toggle = (rule: RecurringRule) => {
    if (rule.isActive) {
      completeAppliedMutation(
        putRecurring({ ...rule, ...changedRecordMeta(rule), isActive: false }),
        () => setMessage("週期規則已暫停"),
        setMessage,
      );
    } else {
      const resumeBlock = getRecurringResumeBlock(data, rule);
      if (resumeBlock) {
        setMessage(resumeBlock);
        return;
      }
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      completeAppliedMutation(
        putRecurring({
          ...rule,
          ...changedRecordMeta(rule),
          isActive: true,
          nextOccurrenceDate: getNextOccurrenceDate(rule, localDate(yesterday)),
        }),
        () => setMessage("週期規則已恢復"),
        setMessage,
      );
    }
  };
  const rules = data.recurringRules.filter((item) => !item.deletedAt);
  const today = localDate();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">固定收支不會重複</p>
            <h2>{editing ? "編輯週期收支" : "新增週期收支"}</h2>
          </div>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <label className="field-label">
            名稱
            <input
              aria-label="週期名稱"
              className="field mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="field-label">
              類型
              <select
                aria-label="週期類型"
                className="field mt-1"
                value={type}
                onChange={(event) => {
                  setType(event.target.value as typeof type);
                  setCategoryId("");
                }}
              >
                <option value="expense">支出</option>
                <option value="income">收入</option>
              </select>
            </label>
            <label className="field-label">
              金額
              <MoneyInput
                aria-label="週期金額"
                className="field mt-1"
                value={amount}
                allowDecimal
                onValueChange={setAmount}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="field-label">
              分類
              <select
                aria-label="週期分類"
                className="field mt-1"
                value={resolvedCategoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                <option value="" disabled>請選擇分類</option>
                {categories.map((item) => (
                  <option
                    value={item.id}
                    key={item.id}
                    disabled={unresolvedSyncRecordKeys.has(syncRecordKey("categories", item.id))}
                  >
                    {item.name}{!item.isActive ? "（已封存）" : ""}
                    {unresolvedSyncRecordKeys.has(syncRecordKey("categories", item.id)) ? "（同步批次待完成）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              帳戶
              <select
                aria-label="週期帳戶"
                className="field mt-1"
                value={resolvedAccountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="" disabled>請選擇帳戶</option>
                {accounts.map((item) => (
                  <option
                    value={item.id}
                    key={item.id}
                    disabled={unresolvedSyncRecordKeys.has(syncRecordKey("accounts", item.id))}
                  >
                    {item.name}{!item.isActive ? "（已封存）" : ""}
                    {unresolvedSyncRecordKeys.has(syncRecordKey("accounts", item.id)) ? "（同步批次待完成）" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(selectedCategoryUnavailable || selectedAccountUnavailable) && (
            <p className="error-message" role="alert">
              原先選取的{selectedCategoryUnavailable ? "分類" : "帳戶"}目前不可用，請明確選擇其他可用項目。
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="field-label">
              頻率
              <select
                aria-label="週期頻率"
                className="field mt-1"
                value={frequency}
                onChange={(event) =>
                  setFrequency(event.target.value as typeof frequency)
                }
              >
                <option value="weekly">每週</option>
                <option value="monthly">每月</option>
                <option value="yearly">每年</option>
              </select>
            </label>
            <label className="field-label">
              開始日
              <input
                aria-label="週期開始日"
                type="date"
                className="field mt-1"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-zinc-500">
            29/30/31
            日規則遇短月會夾到月底，之後月份會回復原始日期；只補啟用範圍內截至今天的缺漏。單次最多自動補登{" "}
            {MAX_RECURRING_CATCH_UP_OCCURRENCES}{" "}
            筆，超過時不會建立或跳過任何期數。
          </p>
          <div className="flex gap-2">
            <button
              className="primary-button flex-1"
              type="submit"
              disabled={!resolvedCategory || !resolvedAccount}
              title={selectedCategoryUnavailable || selectedAccountUnavailable
                ? "原先選取的分類或帳戶目前不可用，請明確選擇其他可用項目。"
                : !resolvedCategory || !resolvedAccount
                ? "請先明確選擇分類與帳戶。"
                : undefined}
            >
              {editing ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {editing ? "儲存週期規則" : "建立週期規則"}
            </button>
            {editing && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setEditing(null);
                  setName("");
                  setAmount("");
                  setMessage("已取消編輯");
                }}
              >
                取消編輯
              </button>
            )}
          </div>
          {message && (
            <p aria-live="polite" className="text-sm text-zinc-500">
              {message}
            </p>
          )}
        </form>
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">暫停期間不補扣</p>
            <h2>週期規則</h2>
          </div>
        </div>
        {rules.length === 0 ? (
          <p className="empty-state">尚無週期收支。</p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => {
              const catchUpBlocked = getRecurringCatchUpStatus(
                rule,
                today,
              ).blocked;
              const conflictBlocked = unresolvedSyncRecordKeys.has(
                syncRecordKey("recurringRules", rule.id),
              ) || unresolvedSyncRecordKeys.has(
                syncRecordKey("accounts", rule.accountId),
              ) || unresolvedSyncRecordKeys.has(
                syncRecordKey("categories", rule.categoryId),
              );
              return (
                <article
                  className={`settings-row ${rule.isActive ? "" : "opacity-60"}`}
                  key={rule.id}
                >
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate">
                      {rule.name} · {money.format(rule.amount)}
                    </strong>
                    <span className="text-xs text-zinc-500">
                      {rule.type === "expense" ? "支出" : "收入"} ·{" "}
                      {rule.frequency === "weekly"
                        ? "每週"
                        : rule.frequency === "monthly"
                          ? "每月"
                          : "每年"}{" "}
                      · 下次 {rule.nextOccurrenceDate}
                    </span>
                    {catchUpBlocked && (
                      <span
                        role="alert"
                        className="mt-1 block text-xs font-bold text-rose-700"
                      >
                        待補期數超過 {MAX_RECURRING_CATCH_UP_OCCURRENCES}{" "}
                        筆安全上限；已停止自動補登且未推進日期。若要略過過久的待補區間，請先暫停再恢復，或刪除後重建。
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`編輯 ${rule.name}`}
                    disabled={conflictBlocked}
                    title={conflictBlocked
                      ? "此週期規則有未解同步衝突，請先完成同步後再編輯。"
                      : undefined}
                    onClick={() => edit(rule)}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={
                      rule.isActive ? `暫停 ${rule.name}` : `恢復 ${rule.name}`
                    }
                    disabled={conflictBlocked}
                    title={conflictBlocked
                      ? "此週期規則有未解同步衝突，請先選擇雲端版本。"
                      : undefined}
                    onClick={() => toggle(rule)}
                  >
                    {rule.isActive ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`刪除 ${rule.name}`}
                    disabled={conflictBlocked}
                    title={conflictBlocked
                      ? "此週期規則有未解同步衝突，請先選擇雲端版本。"
                      : undefined}
                    onClick={() => {
                      if (
                        window.confirm(
                          `刪除週期規則「${rule.name}」？已產生的歷史交易會保留。`,
                        )
                      )
                        deleteRecurring(rule);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export type FullBackupDownloadPreparation =
  | { ok: true; name: string; content: string }
  | { ok: false; reason: "size-limit" | "validation"; message: string };

export function isFullBackupFileWithinLimit(file: { size: number }): boolean {
  return file.size <= MAX_BACKUP_BYTES;
}

/** Prepare a round-trippable backup without allowing a click handler to throw. */
export function prepareFullBackupDownload(
  data: FinanceData,
  fileDate = localDate(),
): FullBackupDownloadPreparation {
  try {
    return {
      ok: true,
      name: `shiba-finance-${fileDate}.json`,
      content: exportFinanceBackup(data),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof BackupSizeLimitError) {
      return {
        ok: false,
        reason: "size-limit",
        message: `完整 JSON 備份未匯出：內容超過 ${MAX_BACKUP_BYTES.toLocaleString()} UTF-8 位元組安全上限，不會下載無法重新匯入的檔案。`,
      };
    }
    return {
      ok: false,
      reason: "validation",
      message: `完整 JSON 備份未匯出：${detail}`,
    };
  }
}

function BackupPanel({ data, ownerId, restore }: SettingsViewProps) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [confirmText, setConfirmText] = useState("");
  const [message, setMessage] = useState<{
    text: string;
    tone: "success" | "error";
  }>();
  const setSuccess = (text: string) => setMessage({ text, tone: "success" });
  const setFailure = (text: string) => setMessage({ text, tone: "error" });
  const exportFullBackup = () => {
    const result = prepareFullBackupDownload(data);
    if ("message" in result) {
      setFailure(result.message);
      return;
    }
    try {
      download(result.name, result.content, "application/json");
      setSuccess("完整 JSON 備份已下載");
    } catch (error) {
      setFailure(
        `完整 JSON 備份未匯出：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const runRestore = () => {
    try {
      const restored = restoreFinanceBackup(data, input, {
        mode,
        confirmReplace: mode === "replace" && confirmText === "REPLACE",
        ownerId,
      });
      restore(restored);
      setSuccess(`還原完成（${mode === "merge" ? "安全合併" : "明確取代"}）`);
    } catch (error) {
      setFailure(
        `未變更任何資料：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const selectBackupFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isFullBackupFileWithinLimit(file)) {
      setInput("");
      setFailure(
        `未變更任何資料：備份檔超過 ${MAX_BACKUP_BYTES.toLocaleString()} UTF-8 位元組安全上限`,
      );
      return;
    }
    void file
      .text()
      .then(setInput)
      .catch(() => {
        setInput("");
        setFailure("未變更任何資料：無法讀取備份檔");
      });
  };
  return (
    <section className="card" aria-labelledby="backup-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">帶著走，也能救回來</p>
          <h2 id="backup-title">備份、匯出與還原</h2>
        </div>
        <RotateCcw className="h-7 w-7 text-amber-600" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          className="primary-button"
          onClick={exportFullBackup}
        >
          <Download className="h-4 w-4" />
          完整 JSON 備份
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            download(
              `transactions-${localDate()}.csv`,
              `\uFEFF${exportTransactionsCsv(data)}`,
              "text/csv;charset=utf-8",
            )
          }
        >
          <Download className="h-4 w-4" />
          交易 CSV
        </button>
      </div>
      <div className="my-5 border-t border-amber-100 dark:border-zinc-800" />
      <label className="field-label">
        選擇 JSON 備份檔
        <input
          aria-label="選擇 JSON 備份檔"
          type="file"
          accept="application/json,.json"
          className="field mt-1"
          onChange={selectBackupFile}
        />
      </label>
      <label className="field-label mt-3 block">
        還原方式
        <select
          aria-label="還原方式"
          className="field mt-1"
          value={mode}
          onChange={(event) => setMode(event.target.value as typeof mode)}
        >
          <option value="merge">安全合併（預設，不製造重複 ID）</option>
          <option value="replace">取代目前資料（具破壞性）</option>
        </select>
      </label>
      {mode === "replace" && (
        <label className="field-label mt-3 block">
          輸入 REPLACE 確認取代
          <input
            aria-label="取代確認"
            className="field mt-1"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </label>
      )}
      <button
        type="button"
        className="primary-button mt-4 w-full"
        disabled={!input || (mode === "replace" && confirmText !== "REPLACE")}
        onClick={runRestore}
      >
        <Upload className="h-4 w-4" />
        驗證後還原
      </button>
      <p className="mt-3 text-xs text-zinc-500">
        匯入前會先完整檢查備份內容與資料關係；只要有問題就不會變更目前資料。
      </p>
      {message && (
        <p
          aria-live="polite"
          className={`mt-3 rounded-xl p-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
