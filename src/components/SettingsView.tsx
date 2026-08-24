import { useState, type ChangeEvent, type FormEvent } from "react";
import {
  Archive,
  Download,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Upload,
} from "lucide-react";
import type {
  AssetAccount,
  Category,
  FinanceData,
  IconRef,
  RecurringRule,
} from "../domain/model";
import {
  BackupSizeLimitError,
  exportFinanceBackup,
  exportTransactionsCsv,
  MAX_BACKUP_BYTES,
  restoreFinanceBackup,
} from "../domain/backup";
import {
  getNextOccurrenceDate,
  getRecurringCatchUpStatus,
  MAX_RECURRING_CATCH_UP_OCCURRENCES,
} from "../domain/recurrence";
import { nextDisplayOrder, sortByDisplayOrder } from "../domain/displayOrder";
import { changedRecordMeta, newRecordMeta } from "../app/state";
import { localDate, money, parseRequiredNumberInput } from "../app/format";
import { completeAppliedMutation } from "../app/mutationResult";
import { FinanceIcon, IconPicker } from "./FinanceIcon";

interface SettingsViewProps {
  data: FinanceData;
  ownerId: string;
  putAccount(record: AssetAccount): boolean;
  putCategory(record: Category): boolean;
  putRecurring(record: RecurringRule): boolean;
  archiveAccount(record: AssetAccount): boolean;
  archiveCategory(record: Category): boolean;
  deleteRecurring(record: RecurringRule): boolean;
  restore(data: FinanceData): void;
}

type Section = "accounts" | "categories" | "recurring" | "backup";

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
      {section === "accounts" && <AccountsPanel {...props} />}
      {section === "categories" && <CategoriesPanel {...props} />}
      {section === "recurring" && <RecurringPanel {...props} />}
      {section === "backup" && <BackupPanel {...props} />}
    </div>
  );
}

function AccountsPanel({
  data,
  ownerId,
  putAccount,
  archiveAccount,
}: SettingsViewProps) {
  const [editing, setEditing] = useState<AssetAccount | null>(null);
  const [name, setName] = useState("");
  const [opening, setOpening] = useState("0");
  const [included, setIncluded] = useState(true);
  const [icon, setIcon] = useState<IconRef>({ type: "emoji", value: "💵" });
  const [message, setMessage] = useState("");
  const accounts = sortByDisplayOrder(
    data.accounts.filter((item) => !item.deletedAt),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseRequiredNumberInput(opening);
    if (!name.trim() || amount === null)
      return setMessage(
        "請輸入帳戶名稱與最多兩位小數、可安全精確處理的有效期初餘額",
      );
    if (
      editing &&
      editing.openingBalance !== amount &&
      data.transactions.some(
        (item) => !item.deletedAt && item.accountId === editing.id,
      ) &&
      !window.confirm(
        `修改「${editing.name}」起始金額會重新計算過去的帳戶餘額。若只是盤點後金額不同，請改用資產頁的「調整餘額」。確定繼續？`,
      )
    ) {
      setMessage("未修改期初餘額");
      return;
    }
    const record: AssetAccount = editing
      ? {
          ...editing,
          ...changedRecordMeta(editing),
          name: name.trim(),
          openingBalance: amount,
          icon,
          includeInTotalAssets: included,
          requiresReview: false,
        }
      : {
          ...newRecordMeta(ownerId),
          name: name.trim(),
          openingBalance: amount,
          icon,
          includeInTotalAssets: included,
          isActive: true,
          sortOrder: nextDisplayOrder(accounts),
        };
    completeAppliedMutation(
      putAccount(record),
      () => {
        setEditing(null);
        setName("");
        setOpening("0");
        setIncluded(true);
        setIcon({ type: "emoji", value: "💵" });
        setMessage(editing ? "帳戶已更新" : "帳戶已建立");
      },
      setMessage,
    );
  };
  const edit = (account: AssetAccount) => {
    setEditing(account);
    setName(account.name);
    setOpening(String(account.openingBalance));
    setIncluded(account.includeInTotalAssets);
    setIcon(account.icon);
  };
  const activeCount = accounts.filter((item) => item.isActive).length;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">我的錢放在哪裡</p>
            <h2>{editing ? "編輯資產帳戶" : "新增資產帳戶"}</h2>
          </div>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <label className="field-label">
            名稱
            <input
              aria-label="帳戶名稱"
              className="field mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field-label">
            期初餘額
            <input
              aria-label="期初餘額"
              className="field mt-1"
              inputMode="decimal"
              value={opening}
              onChange={(event) =>
                setOpening(event.target.value.replace(/[^0-9.-]/g, ""))
              }
            />
          </label>
          <label className="flex items-start gap-3 rounded-xl bg-amber-50 p-3 text-sm dark:bg-zinc-800">
            <input
              aria-label="納入總資產"
              className="mt-1 h-4 w-4 accent-amber-600"
              type="checkbox"
              checked={included}
              onChange={(event) => setIncluded(event.target.checked)}
            />
            <span>
              <strong className="block">納入總資產</strong>
              <span className="text-xs text-zinc-500">
                只勾選現金、電子錢包等真正持有資產；信用卡／債務不在本版本建模範圍。
              </span>
            </span>
          </label>
          {editing &&
            data.transactions.some(
              (item) => !item.deletedAt && item.accountId === editing.id,
            ) && (
              <p className="warning-message">
                此帳戶已有交易；修改起始金額會改變過去的帳戶餘額。若只是盤點後金額不同，請使用資產頁「調整餘額」。
              </p>
            )}
          <IconPicker value={icon} onChange={setIcon} />
          <div className="flex gap-2">
            <button className="primary-button flex-1" type="submit">
              <Save className="h-4 w-4" />
              儲存帳戶
            </button>
            {editing && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setEditing(null);
                  setName("");
                  setIncluded(true);
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
            <p className="eyebrow">暫時不用的帳戶</p>
            <h2>帳戶清單</h2>
          </div>
        </div>
        <div className="space-y-2">
          {accounts.map((account) => (
            <article
              className={`settings-row ${account.isActive ? "" : "opacity-55"}`}
              key={account.id}
            >
              <span className="icon-badge">
                <FinanceIcon icon={account.icon} />
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => edit(account)}
              >
                <strong className="block truncate">{account.name}</strong>
                <span className="text-xs text-zinc-500">
                  期初 {money.format(account.openingBalance)}
                  {!account.includeInTotalAssets ? " · 未納入總資產" : ""}
                  {account.requiresReview ? " · 待確認" : ""}
                </span>
              </button>
              {account.isActive ? (
                <button
                  className="icon-button"
                  type="button"
                  disabled={activeCount <= 1}
                  aria-label={`封存 ${account.name}`}
                  title={activeCount <= 1 ? "至少保留一個可用帳戶" : "封存"}
                  onClick={() => archiveAccount(account)}
                >
                  <Archive className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    putAccount({
                      ...account,
                      ...changedRecordMeta(account),
                      isActive: true,
                    })
                  }
                >
                  啟用
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function CategoriesPanel({
  data,
  ownerId,
  putCategory,
  archiveCategory,
}: SettingsViewProps) {
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [editing, setEditing] = useState<Category | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<IconRef>({ type: "emoji", value: "🍜" });
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
    const record: Category = editing
      ? { ...editing, ...changedRecordMeta(editing), name: name.trim(), icon }
      : {
          ...newRecordMeta(ownerId),
          kind,
          name: name.trim(),
          icon,
          isActive: true,
          sortOrder: nextDisplayOrder(
            categories.filter((item) => item.kind === kind),
          ),
        };
    completeAppliedMutation(
      putCategory(record),
      () => {
        setEditing(null);
        setName("");
        setIcon({ type: "emoji", value: kind === "expense" ? "🍜" : "💰" });
        setMessage(editing ? "分類已更新" : "分類已建立");
      },
      setMessage,
    );
  };
  const edit = (category: Category) => {
    setEditing(category);
    setKind(category.kind);
    setName(category.name);
    setIcon(category.icon);
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
              onChange={(event) => setKind(event.target.value as typeof kind)}
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
                .map((category) => (
                  <article
                    className={`settings-row ${category.isActive ? "" : "opacity-55"}`}
                    key={category.id}
                  >
                    <span className="icon-badge">
                      <FinanceIcon icon={category.icon} />
                    </span>
                    <button
                      type="button"
                      className="flex-1 text-left font-bold"
                      onClick={() => edit(category)}
                    >
                      {category.name}
                    </button>
                    {category.isActive ? (
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`封存 ${category.name}`}
                        onClick={() => archiveCategory(category)}
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          putCategory({
                            ...category,
                            ...changedRecordMeta(category),
                            isActive: true,
                          })
                        }
                      >
                        啟用
                      </button>
                    )}
                  </article>
                ))}
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
}

export function RecurringPanel({
  data,
  ownerId,
  putRecurring,
  deleteRecurring,
}: RecurringPanelProps) {
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
  const categories = sortByDisplayOrder(
    data.categories.filter(
      (item) => item.kind === type && item.isActive && !item.deletedAt,
    ),
  );
  const accounts = sortByDisplayOrder(
    data.accounts.filter((item) => item.isActive && !item.deletedAt),
  );
  const resolvedCategory =
    categories.find((item) => item.id === categoryId) ?? categories[0];
  const resolvedAccount =
    accounts.find((item) => item.id === accountId) ?? accounts[0];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const numeric = parseRequiredNumberInput(amount);
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
    const rule: RecurringRule = {
      ...newRecordMeta(ownerId),
      name: name.trim(),
      type,
      amount: numeric,
      categoryId: resolvedCategory.id,
      categoryName: resolvedCategory.name,
      accountId: resolvedAccount.id,
      accountName: resolvedAccount.name,
      frequency,
      startDate,
      anchorDay: Number(startDate.slice(8, 10)),
      nextOccurrenceDate: startDate,
      isActive: true,
    };
    if (getRecurringCatchUpStatus(rule, localDate()).blocked) {
      setMessage(
        `截至今天待補期數超過 ${MAX_RECURRING_CATCH_UP_OCCURRENCES} 筆安全上限；規則未建立，也未略過任何期數。請選擇較近的開始日。`,
      );
      return;
    }
    completeAppliedMutation(
      putRecurring(rule),
      () => {
        setName("");
        setAmount("");
        setMessage("週期規則已建立");
      },
      setMessage,
    );
  };
  const toggle = (rule: RecurringRule) => {
    if (rule.isActive) {
      completeAppliedMutation(
        putRecurring({ ...rule, ...changedRecordMeta(rule), isActive: false }),
        () => setMessage("週期規則已暫停"),
        setMessage,
      );
    } else {
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
            <h2>新增週期收支</h2>
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
              <input
                aria-label="週期金額"
                className="field mt-1"
                inputMode="decimal"
                value={amount}
                onChange={(event) =>
                  setAmount(event.target.value.replace(/[^0-9.]/g, ""))
                }
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="field-label">
              分類
              <select
                aria-label="週期分類"
                className="field mt-1"
                value={resolvedCategory?.id ?? ""}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                {categories.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              帳戶
              <select
                aria-label="週期帳戶"
                className="field mt-1"
                value={resolvedAccount?.id ?? ""}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
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
          <button className="primary-button w-full" type="submit">
            <Plus className="h-4 w-4" />
            建立週期規則
          </button>
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
                    aria-label={
                      rule.isActive ? `暫停 ${rule.name}` : `恢復 ${rule.name}`
                    }
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
                    onClick={() => {
                      if (
                        window.confirm(
                          `刪除週期規則「${rule.name}」？已產生的歷史交易會保留。`,
                        )
                      )
                        deleteRecurring(rule);
                    }}
                  >
                    <Archive className="h-4 w-4" />
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
