import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, CalendarDays, Minus, TrendingUp } from 'lucide-react';
import type { FinanceData } from '../domain/model';
import type { PeriodKey } from '../domain/dateRange';
import { validateCustomRangeInput } from '../domain/dateRange';
import { calculateBudgetUsage } from '../domain/budgetEngine';
import { calculateFinancials, calculateInsights, calculateSpendingTrend } from '../domain/financeEngine';
import { localDate, money } from '../app/format';
import { useCalendarReference } from '../app/useCalendarReference';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'week', label: '本週' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '本年' },
  { key: 'custom', label: '自訂' },
];

function Delta({ value }: { value: number }) {
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return <span className={`inline-flex items-center gap-1 text-xs font-bold ${value > 0 ? 'text-emerald-600' : value < 0 ? 'text-rose-600' : 'text-zinc-500'}`}><Icon className="h-3 w-3" />較上期 {money.format(Math.abs(value))}</span>;
}

function Metric({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong>{delta !== undefined && <Delta value={delta} />}</div>;
}

export function InsightsView({ data, onOpenLedger }: { data: FinanceData; onOpenLedger(): void }) {
  const reference = useCalendarReference();
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [customStart, setCustomStart] = useState(() => localDate(new Date(reference.getFullYear(), reference.getMonth(), 1)));
  const [customEnd, setCustomEnd] = useState(() => localDate(reference));
  const customRange = { start: customStart, end: customEnd };
  const customValidation = validateCustomRangeInput(customRange);
  const customError = 'message' in customValidation ? customValidation.message : undefined;
  const periodReady = period !== 'custom' || customValidation.valid;
  // A valid fallback keeps the always-visible Today snapshot renderable while
  // the user is midway through editing (or clearing) a custom date.
  const options = period === 'custom' && customValidation.valid
    ? { period, reference, custom: customRange }
    : { period: period === 'custom' ? 'month' as const : period, reference };
  const insights = useMemo(() => calculateInsights(data, options), [data, period, customStart, customEnd, reference]);
  const summary = useMemo(() => calculateFinancials(data), [data]);
  const budgets = useMemo(() => calculateBudgetUsage(data, reference), [data, reference]);
  const trend = useMemo(
    () => calculateSpendingTrend(data, insights.period.range),
    [data, insights.period.range],
  );
  const trendMax = Math.max(...trend.map(([, amount]) => amount), 1);
  const categoryMax = Math.max(...insights.period.expenseByCategory.map((item) => item.amount), 1);

  return (
    <div className="space-y-5">
      <section className="card" aria-labelledby="today-title">
        <div className="section-heading"><div><p className="eyebrow">固定顯示</p><h2 id="today-title">今日財務快照</h2></div><CalendarDays className="h-7 w-7 text-amber-600" /></div>
        <button type="button" className="grid w-full grid-cols-2 gap-3 text-left sm:grid-cols-4" onClick={onOpenLedger} aria-label="前往今日交易明細">
          <Metric label="今日收入" value={money.format(insights.today.income)} />
          <Metric label="今日支出" value={money.format(insights.today.expense)} />
          <Metric label="今日淨收支" value={money.format(insights.today.net)} />
          <Metric label="支出最多分類" value={insights.today.topExpenseCategory ? `${insights.today.topExpenseCategory.name} ${money.format(insights.today.topExpenseCategory.amount)}` : '尚無支出'} />
        </button>
      </section>

      <section className="card" aria-labelledby="period-title">
        <div className="section-heading"><div><p className="eyebrow">日曆區間</p><h2 id="period-title">期間分析</h2></div><TrendingUp className="h-7 w-7 text-amber-600" /></div>
        <div className="grid grid-cols-4 rounded-2xl bg-amber-50 p-1 dark:bg-zinc-800" role="group" aria-label="分析期間">
          {PERIODS.map((item) => <button className={`tab-button ${period === item.key ? 'tab-button-active' : ''}`} type="button" key={item.key} onClick={() => setPeriod(item.key)}>{item.label}</button>)}
        </div>
        {period === 'custom' && <div className="mt-3 grid grid-cols-2 gap-3"><label className="field-label">開始日<input aria-label="自訂開始日" type="date" className="field mt-1" value={customStart} max={customEnd} onChange={(event) => setCustomStart(event.target.value)} /></label><label className="field-label">結束日（含當日）<input aria-label="自訂結束日" type="date" className="field mt-1" value={customEnd} min={customStart} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}
        {period === 'custom' && customError && <p className="error-message mt-3" role="alert">{customError}</p>}
        {periodReady && <>
          <p className="mt-3 text-xs text-zinc-500">{insights.period.range.start.toLocaleDateString('zh-TW')}－{insights.period.range.end.toLocaleDateString('zh-TW')}（本週為週一至週日）</p>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="期間收入" value={money.format(insights.period.income)} delta={insights.comparison.incomeDelta} />
            <Metric label="期間支出" value={money.format(insights.period.expense)} delta={insights.comparison.expenseDelta} />
            <Metric label="淨現金流" value={money.format(insights.period.net)} delta={insights.comparison.netDelta} />
            <Metric label="平均每日支出" value={money.format(insights.period.averageDailyExpense)} />
            <Metric label="儲蓄率" value={insights.period.savingsRate === null ? 'N/A' : `${(insights.period.savingsRate * 100).toFixed(1)}%`} />
            <Metric label="最大單筆支出" value={insights.period.largestExpense ? money.format(insights.period.largestExpense.amount) : '尚無支出'} />
            <Metric label="總資產" value={money.format(summary.totalAssets)} />
            <Metric label="可配置資產" value={money.format(summary.availableAssets)} />
          </div>
        </>}
      </section>

      {periodReady && <div className="grid gap-5 lg:grid-cols-2">
        <section className="card" aria-labelledby="composition-title">
          <div className="section-heading"><div><p className="eyebrow">用途</p><h2 id="composition-title">支出分類組成</h2></div></div>
          {insights.period.expenseByCategory.length === 0 ? <p className="empty-state">選定期間沒有支出。</p> : <div className="space-y-3">{insights.period.expenseByCategory.map((item) => <div key={item.categoryId}><div className="mb-1 flex justify-between text-sm"><span>{item.name}</span><strong>{money.format(item.amount)}</strong></div><div className="progress-track"><span style={{ width: `${Math.max(3, item.amount / categoryMax * 100)}%` }} /></div></div>)}</div>}
        </section>
        <section className="card" aria-labelledby="trend-title">
          <div className="section-heading"><div><p className="eyebrow">時間</p><h2 id="trend-title">支出趨勢</h2></div></div>
          {trend.length === 0 ? <p className="empty-state">選定期間尚無趨勢資料。</p> : <div className="flex h-48 items-end gap-2 overflow-x-auto pt-4">{trend.map(([date, amount]) => <div className="flex min-w-10 flex-1 flex-col items-center gap-1" key={date}><span className="text-[10px] font-bold">{money.format(amount).replace('$', '')}</span><span className="w-full rounded-t-xl bg-gradient-to-t from-amber-600 to-orange-400" style={{ height: `${Math.max(8, amount / trendMax * 130)}px` }} /><span className="text-[10px] text-zinc-500">{date.slice(5)}</span></div>)}</div>}
        </section>
      </div>}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card" aria-labelledby="account-insight-title"><div className="section-heading"><div><p className="eyebrow">持有位置</p><h2 id="account-insight-title">帳戶資產分布</h2></div></div><div className="space-y-2">{summary.accountBalances.filter((item) => item.isActive && item.includeInTotalAssets).map((item) => <div className="flex justify-between rounded-xl bg-amber-50 p-3 dark:bg-zinc-800" key={item.accountId}><span>{item.name}</span><strong>{money.format(item.balance)}</strong></div>)}</div></section>
        <section className="card" aria-labelledby="budget-insight-title"><div className="section-heading"><div><p className="eyebrow">目前週期</p><h2 id="budget-insight-title">預算使用</h2></div></div>{budgets.length === 0 ? <p className="empty-state">尚未設定預算。</p> : <div className="space-y-3">{budgets.map((budget) => <div key={budget.budgetId}><div className="mb-1 flex justify-between text-sm"><span>{budget.name} · {budget.period === 'weekly' ? '本週' : '本月'}</span><strong className={budget.overBy > 0 ? 'text-rose-600' : ''}>{Math.round(budget.usageRatio * 100)}%</strong></div><div className={`progress-track ${budget.overBy > 0 ? 'progress-danger' : ''}`}><span style={{ width: `${Math.min(100, budget.usageRatio * 100)}%` }} /></div><p className="mt-1 text-xs text-zinc-500">已用 {money.format(budget.used)}；{budget.overBy > 0 ? `超支 ${money.format(budget.overBy)}` : `剩餘 ${money.format(budget.remaining)}`}</p></div>)}</div>}</section>
      </div>
    </div>
  );
}
