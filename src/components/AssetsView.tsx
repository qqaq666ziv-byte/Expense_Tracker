import { useMemo, useState, type FormEvent } from "react";
import { Archive, ChevronDown, Pencil, Plus, Scale, X } from "lucide-react";
import type {
  AssetAccount,
  BalanceAdjustment,
  FinanceData,
} from "../domain/model";
import { calculateFinancials } from "../domain/financeEngine";
import { changedRecordMeta, newRecordMeta } from "../app/state";
import {
  ACCOUNT_PRESETS,
  accountKindLabel,
  displayMoney,
  inferAccountKind,
  type AccountKind,
} from "../app/presentation";
import {
  parseRequiredNumberInput,
  shortDate,
  toLocalInput,
} from "../app/format";
import { subtractMoney } from "../domain/money";
import { completeAppliedMutation } from "../app/mutationResult";
import { FinanceIcon, IconPicker } from "./FinanceIcon";

interface AssetsViewProps {
  data: FinanceData;
  ownerId: string;
  putAccount(record: AssetAccount): boolean;
  putAdjustment(record: BalanceAdjustment): boolean;
  archiveAccount(record: AssetAccount): boolean;
}

const COLORS = [
  "#b45309",
  "#f59e0b",
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#db2777",
];

export function AssetsView({
  data,
  ownerId,
  putAccount,
  putAdjustment,
  archiveAccount,
}: AssetsViewProps) {
  const financials = useMemo(() => calculateFinancials(data), [data]);
  const accounts = data.accounts.filter((item) => !item.deletedAt);
  const visibleBalances = financials.accountBalances.filter(
    (item) => item.isActive && item.includeInTotalAssets,
  );
  const positiveTotal = visibleBalances.reduce(
    (sum, item) => sum + Math.max(0, item.balance),
    0,
  );
  let cursor = 0;
  const gradient =
    positiveTotal > 0
      ? visibleBalances
          .map((item, index) => {
            const start = cursor;
            cursor += (Math.max(0, item.balance) / positiveTotal) * 100;
            return `${COLORS[index % COLORS.length]} ${start}% ${cursor}%`;
          })
          .join(", ")
      : "#e7e5e4 0 100%";
  const [editing, setEditing] = useState<AssetAccount | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [opening, setOpening] = useState("0");
  const [included, setIncluded] = useState(true);
  const [kind, setKind] = useState<AccountKind>("cash");
  const [icon, setIcon] = useState<AssetAccount["icon"]>({
    type: "emoji",
    value: "💵",
  });
  const [message, setMessage] = useState("");
  const [expandedId, setExpandedId] = useState<string>();
  const [adjusting, setAdjusting] = useState<AssetAccount | null>(null);
  const [actualBalance, setActualBalance] = useState("");
  const [reason, setReason] = useState("盤點調整");

  const openNew = () => {
    setEditing(null);
    setName("");
    setOpening("0");
    setIncluded(true);
    setKind("cash");
    setIcon({ type: "emoji", value: "💵" });
    setMessage("");
    setShowForm(true);
  };
  const openEdit = (account: AssetAccount) => {
    setEditing(account);
    setName(account.name);
    setOpening(String(account.openingBalance));
    setIncluded(account.includeInTotalAssets);
    setKind(inferAccountKind(account));
    setIcon(account.icon);
    setMessage("");
    setShowForm(true);
  };
  const selectPreset = (next: AccountKind) => {
    const preset = ACCOUNT_PRESETS.find((item) => item.kind === next)!;
    setKind(next);
    if (
      !editing ||
      name === ACCOUNT_PRESETS.find((item) => item.kind === kind)?.name
    )
      setName(preset.name);
    setIcon({ type: "emoji", value: preset.emoji });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseRequiredNumberInput(opening);
    if (!name.trim() || amount === null)
      return setMessage("請輸入帳戶名稱與有效的起始金額");
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
          sortOrder: accounts.length,
        };
    completeAppliedMutation(
      putAccount(record),
      () => {
        setShowForm(false);
        setMessage("");
      },
      setMessage,
    );
  };
  const submitAdjustment = (event: FormEvent) => {
    event.preventDefault();
    if (!adjusting) return;
    const balance =
      visibleBalances.find((item) => item.accountId === adjusting.id)
        ?.balance ?? 0;
    const target = parseRequiredNumberInput(actualBalance);
    if (target === null) return setMessage("請輸入有效的實際餘額");
    const delta = subtractMoney(target, balance);
    if (delta === 0) return setMessage("實際餘額與目前餘額相同");
    completeAppliedMutation(
      putAdjustment({
        ...newRecordMeta(ownerId),
        accountId: adjusting.id,
        amountDelta: delta,
        occurredAt: toLocalInput(),
        reason: reason.trim() || "盤點調整",
      }),
      () => {
        setAdjusting(null);
        setActualBalance("");
        setMessage("餘額已調整");
      },
      setMessage,
    );
  };

  return (
    <div className="assets-page">
      <header className="page-intro">
        <div>
          <p className="section-kicker">我的錢在哪裡？</p>
          <h1>資產分配</h1>
          <p>把現金、銀行、電子支付和儲值卡放在同一張生活地圖上。</p>
        </div>
        <button type="button" className="primary-button" onClick={openNew}>
          <Plus className="h-4 w-4" />
          新增帳戶
        </button>
      </header>

      <section className="asset-overview" aria-labelledby="asset-total-title">
        <div>
          <p id="asset-total-title">目前總資產</p>
          <strong className="responsive-money">
            {displayMoney(financials.totalAssets)}
          </strong>
          <small>
            已配置給目標 {displayMoney(financials.allocatedSavings)} ·
            可自由安排 {displayMoney(financials.availableAssets)}
          </small>
        </div>
        <div
          className="asset-donut"
          style={{ background: `conic-gradient(${gradient})` }}
          role="img"
          aria-label="各資產帳戶占比"
        >
          <span>
            <b>{visibleBalances.length}</b>
            <small>個帳戶</small>
          </span>
        </div>
      </section>

      <section className="asset-list-section">
        <div className="plain-heading">
          <div>
            <p className="section-kicker">資產地圖</p>
            <h2>帳戶餘額</h2>
          </div>
          <span>點開可看帳戶明細</span>
        </div>
        <div className="asset-account-grid">
          {accounts.map((account) => {
            const balance =
              financials.accountBalances.find(
                (item) => item.accountId === account.id,
              )?.balance ?? 0;
            const related = data.transactions
              .filter(
                (item) => !item.deletedAt && item.accountId === account.id,
              )
              .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
            const colorIndex = Math.max(
              0,
              visibleBalances.findIndex(
                (item) => item.accountId === account.id,
              ),
            );
            return (
              <article
                className={`asset-account ${account.isActive ? "" : "archived"}`}
                key={account.id}
              >
                <button
                  className="asset-account-main"
                  type="button"
                  aria-expanded={expandedId === account.id}
                  onClick={() =>
                    setExpandedId((value) =>
                      value === account.id ? undefined : account.id,
                    )
                  }
                >
                  <span
                    className="asset-icon"
                    style={{
                      background: `${COLORS[colorIndex % COLORS.length]}18`,
                      color: COLORS[colorIndex % COLORS.length],
                    }}
                  >
                    <FinanceIcon icon={account.icon} />
                  </span>
                  <span>
                    <small>
                      {accountKindLabel(account)}
                      {!account.includeInTotalAssets ? " · 不計入總資產" : ""}
                    </small>
                    <strong>{account.name}</strong>
                  </span>
                  <b className="responsive-money">{displayMoney(balance)}</b>
                  <ChevronDown className="h-4 w-4" />
                </button>
                {expandedId === account.id && (
                  <div className="asset-detail">
                    <div className="asset-detail-actions">
                      <button type="button" onClick={() => openEdit(account)}>
                        <Pencil className="h-4 w-4" />
                        編輯帳戶
                      </button>
                      {account.isActive && (
                        <button
                          type="button"
                          onClick={() => {
                            setAdjusting(account);
                            setActualBalance(String(balance));
                          }}
                        >
                          <Scale className="h-4 w-4" />
                          調整餘額
                        </button>
                      )}
                      {account.isActive ? (
                        <button
                          type="button"
                          disabled={
                            accounts.filter((item) => item.isActive).length <= 1
                          }
                          onClick={() => archiveAccount(account)}
                        >
                          <Archive className="h-4 w-4" />
                          封存
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            putAccount({
                              ...account,
                              ...changedRecordMeta(account),
                              isActive: true,
                            })
                          }
                        >
                          重新啟用
                        </button>
                      )}
                    </div>
                    <div className="account-recent">
                      <h3>最近紀錄</h3>
                      {related.length === 0 ? (
                        <p>這個帳戶還沒有收支紀錄。</p>
                      ) : (
                        related.slice(0, 5).map((transaction) => (
                          <div key={transaction.id}>
                            <span>
                              {transaction.categoryName}
                              <small>{shortDate(transaction.occurredAt)}</small>
                            </span>
                            <b className={transaction.type}>
                              {transaction.type === "income" ? "+" : "−"}
                              {displayMoney(transaction.amount)}
                            </b>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {showForm && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-form-title"
          >
            <button
              className="sheet-close"
              type="button"
              aria-label="關閉"
              onClick={() => setShowForm(false)}
            >
              <X />
            </button>
            <p className="section-kicker">資產帳戶</p>
            <h2 id="account-form-title">
              {editing ? "編輯帳戶" : "新增錢的位置"}
            </h2>
            <p className="sheet-lead">
              先選最接近的類型，再填入你習慣看到的名稱。
            </p>
            <form onSubmit={submit} className="account-form">
              <fieldset>
                <legend>帳戶類型</legend>
                <div className="preset-grid">
                  {ACCOUNT_PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.kind}
                      className={kind === preset.kind ? "selected" : ""}
                      onClick={() => selectPreset(preset.kind)}
                    >
                      <span>{preset.emoji}</span>
                      <b>{preset.label}</b>
                      <small>{preset.hint}</small>
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="field-label">
                帳戶名稱
                <input
                  aria-label="帳戶名稱"
                  className="field mt-1"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="field-label">
                目前金額
                {editing && (
                  <small>若只是盤點後不同，請從帳戶明細使用「調整餘額」</small>
                )}
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
              <label className="friendly-check">
                <input
                  aria-label="納入總資產"
                  type="checkbox"
                  checked={included}
                  onChange={(event) => setIncluded(event.target.checked)}
                />
                <span>
                  <strong>計入我的總資產</strong>
                  <small>現金、銀行與儲值金通常要勾選。</small>
                </span>
              </label>
              <details className="optional-details">
                <summary>
                  <ChevronDown className="h-4 w-4" />
                  自訂帳戶圖案
                </summary>
                <IconPicker value={icon} onChange={setIcon} />
              </details>
              {message && <p className="error-message">{message}</p>}
              <button className="primary-button w-full" type="submit">
                儲存帳戶
              </button>
            </form>
          </section>
        </div>
      )}

      {adjusting && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="sheet compact-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="adjust-title"
          >
            <button
              className="sheet-close"
              type="button"
              aria-label="關閉"
              onClick={() => setAdjusting(null)}
            >
              <X />
            </button>
            <p className="section-kicker">盤點一下</p>
            <h2 id="adjust-title">調整「{adjusting.name}」餘額</h2>
            <p className="sheet-lead">
              輸入你現在實際看到的金額，柴柴會補上一筆調整紀錄，不會把它算成收入或支出。
            </p>
            <form className="account-form" onSubmit={submitAdjustment}>
              <label className="field-label">
                實際餘額
                <input
                  autoFocus
                  aria-label="實際餘額"
                  className="field mt-1"
                  inputMode="decimal"
                  value={actualBalance}
                  onChange={(event) => setActualBalance(event.target.value)}
                />
              </label>
              <label className="field-label">
                備註
                <input
                  className="field mt-1"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              {message && <p className="error-message">{message}</p>}
              <button className="primary-button w-full" type="submit">
                確認調整
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
