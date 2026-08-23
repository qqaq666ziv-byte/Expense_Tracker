import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Archive, PiggyBank, Plus, Target } from 'lucide-react';
import type { Budget, FinanceData, SavingsAllocation, SavingsGoal } from '../domain/model';
import { calculateBudgetUsage, normalizeBudgetScope } from '../domain/budgetEngine';
import { calculateFinancials } from '../domain/financeEngine';
import { sortByDisplayOrder } from '../domain/displayOrder';
import { changedRecordMeta, newRecordMeta, releaseGoalAllocations } from '../app/state';
import { localDate, money, parseRequiredNumberInput, shortDate, toLocalInput } from '../app/format';
import { useCalendarReference } from '../app/useCalendarReference';

interface PlanningViewProps {
  data: FinanceData;
  ownerId: string;
  putGoal(record: SavingsGoal): void;
  putAllocation(record: SavingsAllocation): void;
  putBudget(record: Budget): void;
  archiveGoal(record: SavingsGoal): void;
  archiveBudget(record: Budget): void;
}

export function PlanningView(props: PlanningViewProps) {
  const reference = useCalendarReference();
  const [tab, setTab] = useState<'savings' | 'budgets'>('savings');
  return <div className="space-y-5"><div className="grid grid-cols-2 rounded-2xl bg-white p-1 shadow-sm dark:bg-zinc-900"><button type="button" className={`tab-button ${tab === 'savings' ? 'tab-button-active' : ''}`} onClick={() => setTab('savings')}>儲蓄目標</button><button type="button" className={`tab-button ${tab === 'budgets' ? 'tab-button-active' : ''}`} onClick={() => setTab('budgets')}>預算規劃</button></div>{tab === 'savings' ? <SavingsPanel {...props} reference={reference} /> : <BudgetPanel {...props} reference={reference} />}</div>;
}

interface PlanningPanelProps extends PlanningViewProps {
  reference: Date;
}

function SavingsPanel({ data, ownerId, putGoal, putAllocation, archiveGoal, reference }: PlanningPanelProps) {
  const financials = useMemo(() => calculateFinancials(data), [data]);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [goalId, setGoalId] = useState('');
  const [allocation, setAllocation] = useState('');
  const [message, setMessage] = useState('');
  const visibleGoals = data.goals.filter((item) => !item.deletedAt);
  const goals = visibleGoals.filter((item) => item.isActive);
  const resolvedGoalId = goals.some((goal) => goal.id === goalId) ? goalId : goals[0]?.id ?? '';
  const allocatedToGoal = (id: string) => data.allocations
    .filter((item) => !item.deletedAt && item.goalId === id)
    .reduce((sum, item) => sum + item.amountDelta, 0);
  const releasedFromGoal = (id: string) => data.allocations
    .filter((item) => item.deletedAt && item.goalId === id).length;

  const createGoal = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseRequiredNumberInput(target);
    if (!name.trim() || amount === null || amount <= 0) return setMessage('請輸入目標名稱與大於 0、最多兩位小數的金額');
    putGoal({ ...newRecordMeta(ownerId), name: name.trim(), targetAmount: amount, targetDate: targetDate || undefined, isActive: true });
    setName(''); setTarget(''); setTargetDate(''); setMessage('目標已建立');
  };

  const allocate = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseRequiredNumberInput(allocation);
    if (!resolvedGoalId || amount === null || amount <= 0) return setMessage('請選擇目標並輸入大於 0、最多兩位小數的金額');
    if (amount > financials.availableAssets) return setMessage(`可配置資產僅有 ${money.format(financials.availableAssets)}，未建立配置`);
    putAllocation({ ...newRecordMeta(ownerId), goalId: resolvedGoalId, amountDelta: amount, occurredAt: toLocalInput(), note: '手動配置' });
    setAllocation(''); setMessage('已配置；總資產不會因此減少');
  };

  const releaseGoalAllocation = (goal: SavingsGoal, allocated: number) => {
    if (allocated <= 0) return;
    if (!window.confirm(`釋放「${goal.name}」目前配置的 ${money.format(allocated)}？原配置會保留為可同步、可稽核的釋放紀錄，總資產不變。`)) return;
    const releases = releaseGoalAllocations(data.allocations, goal.id);
    releases.forEach(putAllocation);
    setMessage(`已釋放「${goal.name}」的 ${releases.length} 筆配置；總資產不變`);
  };

  return (
    <>
      <section className="hero-card hero-card-savings" aria-labelledby="savings-overview-title"><div className="relative z-10"><p id="savings-overview-title" className="text-sm font-bold text-white/75">資產配置</p><p className="mt-1 text-3xl font-black">已配置 {money.format(financials.allocatedSavings)}</p><p className="mt-2 text-sm text-white/80">總資產 {money.format(financials.totalAssets)} · 可配置 {money.format(financials.availableAssets)}</p>{financials.availableAssets < 0 && <p className="mt-3 flex items-center gap-2 rounded-xl bg-rose-950/30 p-2 text-sm"><AlertTriangle className="h-4 w-4" />舊資料配置高於資產，資料已保留；新增配置暫停。</p>}</div></section>
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card" aria-labelledby="new-goal-title"><div className="section-heading"><div><p className="eyebrow">真實資料</p><h2 id="new-goal-title">建立儲蓄目標</h2></div><Target className="h-7 w-7 text-amber-600" /></div><form className="space-y-3" onSubmit={createGoal}><label className="field-label">目標名稱<input aria-label="目標名稱" className="field mt-1" value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field-label">目標金額<input aria-label="目標金額" className="field mt-1" inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value.replace(/[^0-9.]/g, ''))} /></label><label className="field-label">目標日期（選填）<input aria-label="目標日期" type="date" min={localDate(reference)} className="field mt-1" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label><button className="primary-button w-full" type="submit"><Plus className="h-4 w-4" />建立目標</button></form></section>
        <section className="card" aria-labelledby="allocation-title"><div className="section-heading"><div><p className="eyebrow">不減少總資產</p><h2 id="allocation-title">配置儲蓄</h2></div><PiggyBank className="h-7 w-7 text-amber-600" /></div><form className="space-y-3" onSubmit={allocate}><label className="field-label">目標<select aria-label="配置目標" className="field mt-1" value={resolvedGoalId} onChange={(event) => setGoalId(event.target.value)}>{goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select></label><label className="field-label">配置金額<input aria-label="配置金額" className="field mt-1" inputMode="decimal" value={allocation} onChange={(event) => setAllocation(event.target.value.replace(/[^0-9.]/g, ''))} /></label><button className="primary-button w-full" type="submit" disabled={goals.length === 0 || financials.availableAssets <= 0}>配置到目標</button></form>{message && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm dark:bg-zinc-800">{message}</p>}</section>
      </div>
      <section className="card" aria-labelledby="goal-list-title">
        <div className="section-heading"><div><p className="eyebrow">進度與可稽核配置</p><h2 id="goal-list-title">目標清單</h2></div></div>
        {visibleGoals.length === 0 ? <p className="empty-state">沒有示範數字；建立目標後才會顯示進度。</p> : (
          <div className="space-y-4">{visibleGoals.map((goal) => {
            const current = allocatedToGoal(goal.id);
            const releasedCount = releasedFromGoal(goal.id);
            const ratio = goal.targetAmount > 0 ? current / goal.targetAmount : 0;
            return (
              <article className={goal.isActive ? '' : 'rounded-2xl bg-zinc-50 p-3 opacity-75 dark:bg-zinc-800'} key={goal.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <strong>{goal.name}</strong>{!goal.isActive && <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] dark:bg-zinc-700">已封存</span>}
                    <p className="text-xs text-zinc-500">{money.format(current)} / {money.format(goal.targetAmount)}{goal.targetDate ? ` · ${shortDate(goal.targetDate)}` : ''}</p>
                    {releasedCount > 0 && <p className="text-[11px] text-zinc-500">{releasedCount} 筆已釋放配置保留 tombstone 稽核</p>}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {current > 0 && <button className="secondary-button" type="button" aria-label={`釋放${goal.name}配置`} onClick={() => releaseGoalAllocation(goal, current)}>釋放配置</button>}
                    {goal.isActive
                      ? <button className="icon-button" type="button" aria-label={`封存 ${goal.name}`} onClick={() => archiveGoal(goal)}><Archive className="h-4 w-4" /></button>
                      : <button className="secondary-button" type="button" aria-label={`重新啟用${goal.name}`} onClick={() => putGoal({ ...goal, ...changedRecordMeta(goal), isActive: true })}>重新啟用</button>}
                  </div>
                </div>
                <div className="progress-track mt-2"><span style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }} /></div>
              </article>
            );
          })}</div>
        )}
      </section>
    </>
  );
}

function BudgetPanel({ data, ownerId, putBudget, archiveBudget, reference }: PlanningPanelProps) {
  const [scope, setScope] = useState<'overall' | 'category'>('overall');
  const [categoryId, setCategoryId] = useState('');
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('monthly');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const categories = sortByDisplayOrder(data.categories.filter((item) => item.kind === 'expense' && item.isActive && !item.deletedAt));
  const resolvedCategoryId = categories.some((item) => item.id === categoryId) ? categoryId : categories[0]?.id ?? '';
  const usages = useMemo(() => calculateBudgetUsage(data, reference), [data, reference]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const limit = parseRequiredNumberInput(amount);
    const category = categories.find((item) => item.id === resolvedCategoryId);
    if (limit === null || limit <= 0 || (scope === 'category' && !category)) return setMessage('請輸入大於 0、最多兩位小數的預算並選擇分類');
    const existing = data.budgets.find((item) => !item.deletedAt && item.isActive && item.scope === scope && item.period === period && (scope === 'overall' || item.categoryId === category?.id));
    const record: Budget = existing ? { ...existing, ...changedRecordMeta(existing), amount: limit, ...(category ? { categoryId: category.id, categoryName: category.name } : {}) } : { ...newRecordMeta(ownerId), scope, period, amount: limit, isActive: true, ...(category && scope === 'category' ? { categoryId: category.id, categoryName: category.name } : {}) };
    putBudget(normalizeBudgetScope(record)); setAmount(''); setMessage(existing ? '已更新相同範圍預算' : '預算已建立');
  };

  return <><section className="card" aria-labelledby="budget-form-title"><div className="section-heading"><div><p className="eyebrow">同一日曆引擎</p><h2 id="budget-form-title">設定預算</h2></div><Target className="h-7 w-7 text-amber-600" /></div><form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}><label className="field-label">範圍<select aria-label="預算範圍" className="field mt-1" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="overall">總預算</option><option value="category">分類預算</option></select></label><label className="field-label">週期<select aria-label="預算週期" className="field mt-1" value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}><option value="weekly">每週（週一至週日）</option><option value="monthly">每月</option></select></label>{scope === 'category' && <label className="field-label">支出分類<select aria-label="預算分類" className="field mt-1" value={resolvedCategoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}<label className="field-label">預算金額<input aria-label="預算金額" className="field mt-1" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} /></label><button className="primary-button sm:col-span-2" type="submit">儲存預算</button>{message && <p className="text-sm text-zinc-600 sm:col-span-2">{message}</p>}</form></section><section className="card" aria-labelledby="budget-list-title"><div className="section-heading"><div><p className="eyebrow">已用／剩餘／超支</p><h2 id="budget-list-title">目前預算</h2></div></div>{usages.length === 0 ? <p className="empty-state">尚未設定預算。</p> : <div className="space-y-4">{usages.map((usage) => { const budget = data.budgets.find((item) => item.id === usage.budgetId)!; return <article key={usage.budgetId}><div className="flex justify-between gap-3"><div><strong>{usage.name} · {usage.period === 'weekly' ? '每週' : '每月'}</strong><p className={`text-xs ${usage.overBy > 0 ? 'text-rose-600' : 'text-zinc-500'}`}>已用 {money.format(usage.used)} / {money.format(usage.limit)} · {usage.overBy > 0 ? `超支 ${money.format(usage.overBy)}` : `剩餘 ${money.format(usage.remaining)}`}</p></div><button type="button" className="icon-button" aria-label={`封存 ${usage.name} 預算`} onClick={() => archiveBudget(budget)}><Archive className="h-4 w-4" /></button></div><div className={`progress-track mt-2 ${usage.overBy > 0 ? 'progress-danger' : ''}`}><span style={{ width: `${Math.min(100, usage.usageRatio * 100)}%` }} /></div></article>; })}</div>}</section></>;
}
