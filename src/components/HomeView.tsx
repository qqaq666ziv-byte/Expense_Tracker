import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import type { FinanceData, Transaction } from "../domain/model";
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
import { FinanceIcon } from "./FinanceIcon";

interface HomeViewProps {
  data: FinanceData;
  ownerId: string;
  put(entity: "transactions", record: Transaction): boolean;
  deleteTransaction(record: Transaction): boolean;
}

const ledgerPageSize = 30;

export function HomeView({
  data,
  ownerId,
  put,
  deleteTransaction,
}: HomeViewProps) {
  const amountRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [occurredAt, setOccurredAt] = useState(toLocalInput());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [historyLimit, setHistoryLimit] = useState(ledgerPageSize);
  const [query, setQuery] = useState("");

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
  const resolvedCategoryId = categories.some((item) => item.id === categoryId)
    ? categoryId
    : (categories[0]?.id ?? "");
  const resolvedAccountId = accounts.some((item) => item.id === accountId)
    ? accountId
    : (accounts[0]?.id ?? "");

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

  const today = useMemo(
    () =>
      calculateInsights(data, { period: "month", reference: new Date() }).today,
    [data],
  );
  const history = useMemo(() => buildLedgerHistory(data), [data]);
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
    setError("");
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const switchType = (next: "expense" | "income") => {
    setType(next);
    setCategoryId("");
    setError("");
    setSuccess("");
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const numericAmount = parseRequiredNumberInput(amount);
    const category = data.categories.find(
      (item) => item.id === resolvedCategoryId,
    );
    const account = accounts.find((item) => item.id === resolvedAccountId);
    if (numericAmount === null || numericAmount <= 0)
      return setError("請輸入大於 0、最多兩位小數的金額");
    if (!category || !account) return setError("請先建立可用的資產帳戶與分類");
    if (!occurredAt) return setError("請選擇交易時間");

    const record: Transaction = editing
      ? {
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
          note: note.trim() || undefined,
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
        resetForm();
      },
      setError,
    );
  };

  const beginEdit = (transaction: Transaction) => {
    setEditing(transaction);
    setType(transaction.type);
    setAmount(String(transaction.amount));
    setCategoryId(transaction.categoryId);
    setAccountId(transaction.accountId);
    setOccurredAt(transaction.occurredAt.slice(0, 16).replace(" ", "T"));
    setNote(transaction.note ?? "");
    setSuccess("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="quick-layout">
      <section className="quick-book" aria-labelledby="quick-entry-title">
        <div className="quick-book-header">
          <div>
            <p className="section-kicker">剛剛花了多少？</p>
            <h1 id="quick-entry-title">
              {editing ? "修改這筆紀錄" : "極速記帳"}
            </h1>
          </div>
          <div
            className="today-mini"
            aria-label={`今日支出 ${displayMoney(today.expense)}`}
          >
            <span>今日支出</span>
            <strong>{displayMoney(today.expense, true)}</strong>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="entry-type-switch" role="group" aria-label="收支類型">
            <button
              type="button"
              className={type === "expense" ? "active expense" : ""}
              aria-pressed={type === "expense"}
              onClick={() => switchType("expense")}
            >
              記支出
            </button>
            <button
              type="button"
              className={type === "income" ? "active income" : ""}
              aria-pressed={type === "income"}
              onClick={() => switchType("income")}
            >
              記收入
            </button>
          </div>

          <label className={`amount-stage ${type}`}>
            <span>{type === "expense" ? "支出金額" : "收入金額"}</span>
            <span className="amount-input-wrap">
              <b>NT$</b>
              <input
                ref={amountRef}
                autoFocus
                aria-label="金額"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value.replace(/[^0-9.]/g, ""));
                  setError("");
                  setSuccess("");
                }}
              />
            </span>
          </label>

          <fieldset className="choice-section">
            <legend>選擇分類</legend>
            <div className="category-grid">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  className={`category-choice ${resolvedCategoryId === category.id ? "selected" : ""}`}
                  aria-pressed={resolvedCategoryId === category.id}
                  onClick={() => setCategoryId(category.id)}
                >
                  <span>
                    <FinanceIcon icon={category.icon} />
                  </span>
                  <b>{category.name}</b>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="choice-section account-choices">
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
                  onClick={() => setAccountId(account.id)}
                >
                  <FinanceIcon icon={account.icon} />
                  {account.name}
                </button>
              ))}
            </div>
          </fieldset>

          <details className="optional-details" open={Boolean(editing)}>
            <summary>
              <ChevronDown className="h-4 w-4" />
              補充時間或備註
            </summary>
            <div className="optional-grid">
              <label className="field-label">
                <CalendarClock className="h-4 w-4" />
                交易時間
                <input
                  aria-label="交易時間"
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
            <button className={`save-entry ${type}`} type="submit">
              {editing
                ? "儲存修改"
                : `記下這筆${type === "expense" ? "支出" : "收入"}`}
            </button>
            {editing && (
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

      <section className="ledger-paper" aria-labelledby="history-title">
        <div className="ledger-heading">
          <div>
            <p className="section-kicker">我的生活帳本</p>
            <h2 id="history-title">最近紀錄</h2>
          </div>
          <label className="ledger-search">
            <Search className="h-4 w-4" />
            <input
              aria-label="搜尋交易"
              placeholder="搜尋分類、帳戶、備註"
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
              const transaction = entry.record;
              const category = data.categories.find(
                (item) => item.id === transaction.categoryId,
              );
              const account = data.accounts.find(
                (item) => item.id === transaction.accountId,
              );
              return (
                <article
                  className="ledger-row"
                  key={transaction.id}
                  data-testid="transaction-row"
                >
                  <span className="record-icon">
                    <FinanceIcon
                      icon={category?.icon ?? { type: "emoji", value: "🧾" }}
                    />
                  </span>
                  <div>
                    <strong>
                      {category?.name ?? transaction.categoryName}
                    </strong>
                    <small>
                      {account?.name ?? transaction.accountName} ·{" "}
                      {shortDate(transaction.occurredAt)}
                      {transaction.note ? ` · ${transaction.note}` : ""}
                    </small>
                  </div>
                  <b className={transaction.type}>
                    {transaction.type === "income" ? "+" : "−"}
                    {displayMoney(transaction.amount)}
                  </b>
                  <span className="row-actions">
                    <button
                      type="button"
                      aria-label={`編輯 ${category?.name ?? transaction.categoryName}`}
                      onClick={() => beginEdit(transaction)}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`刪除 ${category?.name ?? transaction.categoryName}`}
                      onClick={() => {
                        if (
                          window.confirm("刪除這筆紀錄？它不會再出現在帳本中。")
                        )
                          deleteTransaction(transaction);
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
