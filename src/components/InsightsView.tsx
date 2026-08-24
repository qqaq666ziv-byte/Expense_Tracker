import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Minus,
  TrendingUp,
} from "lucide-react";
import type { FinanceData, Transaction } from "../domain/model";
import type { PeriodKey } from "../domain/dateRange";
import {
  parseLocalDateTime,
  validateCustomRangeInput,
} from "../domain/dateRange";
import { calculateBudgetUsage } from "../domain/budgetEngine";
import {
  calculateInsights,
  calculateSpendingTrend,
} from "../domain/financeEngine";
import { localDate, shortDate } from "../app/format";
import { displayMoney } from "../app/presentation";
import { useCalendarReference } from "../app/useCalendarReference";
import { FinanceIcon } from "./FinanceIcon";

type AnalysisPeriod = "day" | PeriodKey;
const PERIODS: { key: AnalysisPeriod; label: string }[] = [
  { key: "day", label: "今日" },
  { key: "week", label: "本週" },
  { key: "month", label: "本月" },
  { key: "year", label: "本年" },
  { key: "custom", label: "自訂" },
];
const COLORS = [
  "#9a5800",
  "#e9852b",
  "#f5b25c",
  "#c9c2b4",
  "#686158",
  "#e94068",
  "#0f766e",
];

export function deltaTone(value: number, increaseIsFavorable: boolean): string {
  if (value === 0) return "text-zinc-500";
  const favorable = increaseIsFavorable ? value > 0 : value < 0;
  return favorable ? "text-emerald-600" : "text-rose-600";
}

function Delta({
  value,
  increaseIsFavorable = true,
}: {
  value: number;
  increaseIsFavorable?: boolean;
}) {
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span className={`metric-delta ${deltaTone(value, increaseIsFavorable)}`}>
      <Icon className="h-3 w-3" />
      比上期 {value === 0 ? "沒有變化" : displayMoney(Math.abs(value), true)}
    </span>
  );
}

function MoneyMetric({
  label,
  value,
  tone,
  delta,
  increaseIsFavorable,
}: {
  label: string;
  value: number;
  tone?: string;
  delta?: number;
  increaseIsFavorable?: boolean;
}) {
  return (
    <div className={`insight-metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong className="responsive-money">{displayMoney(value)}</strong>
      {delta !== undefined && (
        <Delta value={delta} increaseIsFavorable={increaseIsFavorable} />
      )}
    </div>
  );
}

function within(transaction: Transaction, start: Date, end: Date): boolean {
  if (transaction.deletedAt) return false;
  try {
    const value = parseLocalDateTime(transaction.occurredAt);
    return value >= start && value <= end;
  } catch {
    return false;
  }
}

export function InsightsView({
  data,
  onOpenLedger,
}: {
  data: FinanceData;
  onOpenLedger(): void;
}) {
  const reference = useCalendarReference();
  const [period, setPeriod] = useState<AnalysisPeriod>("month");
  const [customStart, setCustomStart] = useState(() =>
    localDate(new Date(reference.getFullYear(), reference.getMonth(), 1)),
  );
  const [customEnd, setCustomEnd] = useState(() => localDate(reference));
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>();
  const customRange = { start: customStart, end: customEnd };
  const customValidation = validateCustomRangeInput(customRange);
  const customError =
    "message" in customValidation ? customValidation.message : undefined;
  const periodReady = period !== "custom" || customValidation.valid;
  const options =
    period === "day"
      ? {
          period: "custom" as const,
          reference,
          custom: { start: localDate(reference), end: localDate(reference) },
        }
      : period === "custom" && customValidation.valid
        ? { period, reference, custom: customRange }
        : {
            period: period === "custom" ? ("month" as const) : period,
            reference,
          };
  const insights = useMemo(
    () => calculateInsights(data, options),
    [data, period, customStart, customEnd, reference],
  );
  const budgets = useMemo(
    () => calculateBudgetUsage(data, reference),
    [data, reference],
  );
  const trend = useMemo(
    () => calculateSpendingTrend(data, insights.period.range),
    [data, insights.period.range],
  );
  const periodTransactions = data.transactions.filter((item) =>
    within(item, insights.period.range.start, insights.period.range.end),
  );
  const selectedTransactions = selectedCategoryId
    ? periodTransactions.filter(
        (item) => item.categoryId === selectedCategoryId,
      )
    : [];
  const categoryTotal = Math.max(insights.period.expense, 1);
  let cursor = 0;
  const donutGradient = insights.period.expenseByCategory.length
    ? insights.period.expenseByCategory
        .map((item, index) => {
          const start = cursor;
          cursor += (item.amount / categoryTotal) * 100;
          return `${COLORS[index % COLORS.length]} ${start}% ${cursor}%`;
        })
        .join(", ")
    : "#e7e5e4 0 100%";

  const maxTrend = Math.max(...trend.map(([, value]) => value), 1);
  const points = trend.map(([, value], index) => ({
    x: trend.length <= 1 ? 50 : (index / (trend.length - 1)) * 100,
    y: 88 - (value / maxTrend) * 72,
  }));
  const path = points
    .map(
      (point, index) =>
        `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(" ");
  const areaPath = points.length ? `${path} L 100 92 L 0 92 Z` : "";

  return (
    <div className="insights-page">
      <header className="page-intro">
        <div>
          <p className="section-kicker">把數字看懂一點</p>
          <h1>財務洞察</h1>
          <p>從今天的每一筆，到長期的生活節奏。</p>
        </div>
      </header>

      <div className="period-switch" role="group" aria-label="分析期間">
        {PERIODS.map((item) => (
          <button
            className={period === item.key ? "active" : ""}
            type="button"
            key={item.key}
            aria-pressed={period === item.key}
            onClick={() => {
              setPeriod(item.key);
              setSelectedCategoryId(undefined);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {period === "custom" && (
        <div className="custom-range">
          <label>
            開始日
            <input
              aria-label="自訂開始日"
              type="date"
              value={customStart}
              max={customEnd}
              onChange={(event) => setCustomStart(event.target.value)}
            />
          </label>
          <span>至</span>
          <label>
            結束日（含當日）
            <input
              aria-label="自訂結束日"
              type="date"
              value={customEnd}
              min={customStart}
              onChange={(event) => setCustomEnd(event.target.value)}
            />
          </label>
        </div>
      )}
      {period === "custom" && customError && (
        <p className="error-message" role="alert">
          {customError}
        </p>
      )}

      {periodReady && (
        <>
          <section
            className="insight-summary"
            aria-labelledby="period-summary-title"
          >
            <div className="plain-heading">
              <div>
                <p className="section-kicker">
                  {insights.period.range.start.toLocaleDateString("zh-TW")} —{" "}
                  {insights.period.range.end.toLocaleDateString("zh-TW")}
                </p>
                <h2 id="period-summary-title">這段時間的收支</h2>
              </div>
            </div>
            <div className="metric-grid">
              <MoneyMetric
                label="支出"
                value={insights.period.expense}
                tone="expense"
                delta={insights.comparison.expenseDelta}
                increaseIsFavorable={false}
              />
              <MoneyMetric
                label="收入"
                value={insights.period.income}
                tone="income"
                delta={insights.comparison.incomeDelta}
              />
              <MoneyMetric
                label="淨收支"
                value={insights.period.net}
                tone="net"
                delta={insights.comparison.netDelta}
              />
              <div className="insight-metric">
                <span>平均每日支出</span>
                <strong className="responsive-money">
                  {displayMoney(insights.period.averageDailyExpense)}
                </strong>
                <small>
                  {insights.period.largestExpense
                    ? `最大一筆 ${displayMoney(insights.period.largestExpense.amount)}`
                    : "這段時間尚無支出"}
                </small>
              </div>
            </div>
          </section>

          <div className="analysis-grid">
            <section
              className="analysis-panel"
              aria-labelledby="composition-title"
            >
              <div className="plain-heading">
                <div>
                  <p className="section-kicker">花到哪裡</p>
                  <h2 id="composition-title">支出分類占比</h2>
                </div>
                <span>點選分類查看明細</span>
              </div>
              {insights.period.expenseByCategory.length === 0 ? (
                <div className="friendly-empty">
                  <span>🍵</span>
                  <strong>這段時間沒有支出</strong>
                  <p>很安靜的一段日子。</p>
                </div>
              ) : (
                <div className="donut-layout">
                  <div
                    className="category-donut"
                    style={{ background: `conic-gradient(${donutGradient})` }}
                    role="img"
                    aria-label={`總支出 ${displayMoney(insights.period.expense)}`}
                  >
                    <span>
                      <small>總支出</small>
                      <b>{displayMoney(insights.period.expense, true)}</b>
                    </span>
                  </div>
                  <div className="donut-legend">
                    {insights.period.expenseByCategory.map((item, index) => {
                      const category = data.categories.find(
                        (value) => value.id === item.categoryId,
                      );
                      const ratio = (item.amount / categoryTotal) * 100;
                      return (
                        <button
                          type="button"
                          key={item.categoryId}
                          className={
                            selectedCategoryId === item.categoryId
                              ? "selected"
                              : ""
                          }
                          aria-pressed={selectedCategoryId === item.categoryId}
                          onClick={() =>
                            setSelectedCategoryId((value) =>
                              value === item.categoryId
                                ? undefined
                                : item.categoryId,
                            )
                          }
                        >
                          <i
                            style={{
                              background: COLORS[index % COLORS.length],
                            }}
                          />
                          <span>
                            <b>
                              {category && <FinanceIcon icon={category.icon} />}{" "}
                              {item.name}
                            </b>
                            <small>
                              {ratio.toFixed(ratio >= 10 ? 0 : 1)}% ·{" "}
                              {displayMoney(item.amount)}
                            </small>
                          </span>
                          <ArrowRight className="h-4 w-4" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {selectedCategoryId && (
                <div className="drilldown">
                  <div className="plain-heading">
                    <h3>
                      {
                        insights.period.expenseByCategory.find(
                          (item) => item.categoryId === selectedCategoryId,
                        )?.name
                      }
                      明細
                    </h3>
                    <button
                      type="button"
                      onClick={() => setSelectedCategoryId(undefined)}
                    >
                      收起
                    </button>
                  </div>
                  {selectedTransactions.map((transaction) => (
                    <article key={transaction.id}>
                      <span>
                        {transaction.note || transaction.accountName}
                        <small>
                          {shortDate(transaction.occurredAt)} ·{" "}
                          {transaction.accountName}
                        </small>
                      </span>
                      <b>{displayMoney(transaction.amount)}</b>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section
              className="analysis-panel trend-panel"
              aria-labelledby="trend-title"
            >
              <div className="plain-heading">
                <div>
                  <p className="section-kicker">生活節奏</p>
                  <h2 id="trend-title">支出趨勢</h2>
                </div>
                <TrendingUp className="h-6 w-6" />
              </div>
              {trend.length === 0 ? (
                <div className="friendly-empty">
                  <span>📈</span>
                  <strong>還沒有趨勢資料</strong>
                  <p>記下幾筆後就能看見起伏。</p>
                </div>
              ) : (
                <div className="trend-chart">
                  <svg
                    viewBox="0 0 100 100"
                    role="img"
                    aria-label="支出趨勢折線圖"
                    preserveAspectRatio="none"
                  >
                    <defs>
                      <linearGradient
                        id="trendFill"
                        x1="0"
                        x2="0"
                        y1="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="#d97706"
                          stopOpacity=".28"
                        />
                        <stop
                          offset="100%"
                          stopColor="#d97706"
                          stopOpacity=".03"
                        />
                      </linearGradient>
                    </defs>
                    <path
                      className="trend-grid-line"
                      d="M0 20 H100 M0 44 H100 M0 68 H100 M0 92 H100"
                    />
                    <path className="trend-area" d={areaPath} />
                    <path className="trend-line" d={path} />
                    {points.map((point, index) => (
                      <circle
                        key={trend[index][0]}
                        cx={point.x}
                        cy={point.y}
                        r="1.8"
                      >
                        <title>
                          {trend[index][0]}：{displayMoney(trend[index][1])}
                        </title>
                      </circle>
                    ))}
                  </svg>
                  <div className="trend-labels">
                    {trend.map(([date], index) => (
                      <span
                        key={date}
                        style={{
                          left: `${trend.length <= 1 ? 50 : (index / (trend.length - 1)) * 100}%`,
                        }}
                        className={
                          trend.length > 8 &&
                          index % Math.ceil(trend.length / 6) !== 0 &&
                          index !== trend.length - 1
                            ? "hidden-label"
                            : ""
                        }
                      >
                        {date.slice(5)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      <section className="today-snapshot" aria-labelledby="today-title">
        <div className="plain-heading">
          <div>
            <p className="section-kicker">不用計算，直接回答</p>
            <h2 id="today-title">我今天花了多少？</h2>
          </div>
          <CalendarDays className="h-6 w-6" />
        </div>
        <div className="today-answer">
          <strong>{displayMoney(insights.today.expense)}</strong>
          <span>
            收入 {displayMoney(insights.today.income)} · 淨收支{" "}
            {displayMoney(insights.today.net)}
          </span>
        </div>
        <button type="button" className="ledger-link" onClick={onOpenLedger}>
          查看今天與最近的交易 <ArrowRight className="h-4 w-4" />
        </button>
      </section>

      <section className="budget-glance" aria-labelledby="budget-title">
        <div className="plain-heading">
          <div>
            <p className="section-kicker">這個週期</p>
            <h2 id="budget-title">預算進度</h2>
          </div>
        </div>
        {budgets.length === 0 ? (
          <p className="friendly-inline">
            尚未設定預算；需要時可到「規劃」建立。
          </p>
        ) : (
          budgets.map((budget) => (
            <div className="budget-line" key={budget.budgetId}>
              <span>
                <b>{budget.name}</b>
                <small>
                  已用 {displayMoney(budget.used)} /{" "}
                  {displayMoney(budget.limit)}
                </small>
              </span>
              <b className={budget.overBy > 0 ? "over" : ""}>
                {Math.round(budget.usageRatio * 100)}%
              </b>
              <i>
                <span
                  style={{
                    width: `${Math.min(100, budget.usageRatio * 100)}%`,
                  }}
                />
              </i>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
