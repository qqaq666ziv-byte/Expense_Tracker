import { useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Archive,
  Pencil,
  PiggyBank,
  Plus,
  RotateCcw,
  Target,
  X,
} from "lucide-react";
import type {
  Budget,
  FinanceData,
  RecurringRule,
  SavingsAllocation,
  SavingsGoal,
} from "../domain/model";
import {
  calculateBudgetUsage,
  budgetSemanticId,
  findActiveBudgetConflict,
  findBudgetCreationCollision,
  normalizeBudgetScope,
} from "../domain/budgetEngine";
import { calculateFinancials } from "../domain/financeEngine";
import { sortByDisplayOrder } from "../domain/displayOrder";
import { compareMoney, sumMoney } from "../domain/money";
import {
  changedRecordMeta,
  newRecordMeta,
} from "../app/state";
import { activeOperationId, syncRecordKey } from "../domain/syncEngine";
import {
  assertFreshEditorSnapshot,
  isEditorSnapshotStale,
} from "../domain/staleEditor";
import {
  localDate,
  money,
  parseRequiredNumberInput,
  shortDate,
  toLocalInput,
} from "../app/format";
import { completeAppliedMutation } from "../app/mutationResult";
import { useCalendarReference } from "../app/useCalendarReference";
import { RecurringPanel } from "./SettingsView";
import { MoneyInput } from "./MoneyInput";

interface PlanningViewProps {
  data: FinanceData;
  ownerId: string;
  putGoal(record: SavingsGoal): boolean;
  putAllocation(record: SavingsAllocation): boolean;
  putBudget(record: Budget): boolean;
  putRecurring(record: RecurringRule): boolean;
  deleteRecurring(record: RecurringRule): boolean;
  archiveGoal(record: SavingsGoal): boolean;
  releaseGoalAllocations?(record: SavingsGoal): boolean;
  archiveBudget(record: Budget): boolean;
  unresolvedSyncRecordKeys?: ReadonlySet<string>;
}

export interface SavingsGoalEditDraft {
  name: string;
  targetAmount: number;
  targetDate?: string;
}

export function buildEditedSavingsGoal(
  opened: SavingsGoal,
  current: SavingsGoal | undefined,
  draft: SavingsGoalEditDraft,
  now = new Date(),
  operationId: string = crypto.randomUUID(),
  hasUnresolvedConflict = false,
): SavingsGoal {
  assertFreshEditorSnapshot(opened, current, "此儲蓄目標", { hasUnresolvedConflict });
  const edited: SavingsGoal = {
    ...current,
    version: current.version + 1,
    updatedAt: now.toISOString(),
    lastOperationId: activeOperationId(operationId),
    name: draft.name.trim(),
    targetAmount: draft.targetAmount,
  };
  if (draft.targetDate) edited.targetDate = draft.targetDate;
  else delete edited.targetDate;
  return edited;
}

export interface BudgetEditDraft {
  scope: Budget["scope"];
  period: Budget["period"];
  amount: number;
  categoryId?: string;
  categoryName?: string;
}

export function selectableBudgetCategories(
  data: FinanceData,
  mutationLockedRecordKeys: ReadonlySet<string>,
) {
  return sortByDisplayOrder(data.categories.filter((item) => (
    item.kind === "expense"
    && item.isActive
    && !item.deletedAt
    && !mutationLockedRecordKeys.has(syncRecordKey("categories", item.id))
  )));
}

export function buildEditedBudget(
  opened: Budget,
  current: Budget | undefined,
  draft: BudgetEditDraft,
  now = new Date(),
  operationId: string = crypto.randomUUID(),
  hasUnresolvedConflict = false,
): Budget {
  assertFreshEditorSnapshot(opened, current, "此預算", {
    requireActive: true,
    hasUnresolvedConflict,
  });
  const edited: Budget = {
    ...current,
    version: current.version + 1,
    updatedAt: now.toISOString(),
    lastOperationId: activeOperationId(operationId),
    scope: draft.scope,
    period: draft.period,
    amount: draft.amount,
  };
  if (draft.scope === "category" && draft.categoryId && draft.categoryName) {
    edited.categoryId = draft.categoryId;
    edited.categoryName = draft.categoryName;
  } else {
    delete edited.categoryId;
    delete edited.categoryName;
  }
  return edited;
}

export function PlanningView(props: PlanningViewProps) {
  const reference = useCalendarReference();
  const [tab, setTab] = useState<"savings" | "budgets" | "recurring">(
    "savings",
  );
  return (
    <div className="space-y-5" data-tutorial="planning-overview">
      <header className="page-intro">
        <div>
          <p className="section-kicker">把未來慢慢安排好</p>
          <h1>生活規劃</h1>
          <p>儲蓄目標、預算與固定收支，各自照顧不同的日常。</p>
        </div>
      </header>
      <div className="grid grid-cols-3 rounded-2xl bg-white p-1 shadow-sm dark:bg-zinc-900">
        <button
          type="button"
          className={`tab-button ${tab === "savings" ? "tab-button-active" : ""}`}
          onClick={() => setTab("savings")}
        >
          儲蓄目標
        </button>
        <button
          type="button"
          className={`tab-button ${tab === "budgets" ? "tab-button-active" : ""}`}
          onClick={() => setTab("budgets")}
        >
          預算規劃
        </button>
        <button
          type="button"
          className={`tab-button ${tab === "recurring" ? "tab-button-active" : ""}`}
          onClick={() => setTab("recurring")}
        >
          固定收支
        </button>
      </div>
      {tab === "savings" ? (
        <SavingsPanel {...props} reference={reference} />
      ) : tab === "budgets" ? (
        <BudgetPanel {...props} reference={reference} />
      ) : (
        <RecurringPanel
          data={props.data}
          ownerId={props.ownerId}
          putRecurring={props.putRecurring}
          deleteRecurring={props.deleteRecurring}
          unresolvedSyncRecordKeys={props.unresolvedSyncRecordKeys}
        />
      )}
    </div>
  );
}

interface PlanningPanelProps extends PlanningViewProps {
  reference: Date;
}

function SavingsPanel({
  data,
  ownerId,
  putGoal,
  putAllocation,
  archiveGoal,
  releaseGoalAllocations = () => false,
  reference,
  unresolvedSyncRecordKeys = new Set(),
}: PlanningPanelProps) {
  const financials = useMemo(() => calculateFinancials(data), [data]);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [editingGoalSnapshot, setEditingGoalSnapshot] = useState<SavingsGoal | null>(null);
  const editingGoalId = editingGoalSnapshot?.id ?? "";
  const [goalId, setGoalId] = useState("");
  const [allocation, setAllocation] = useState("");
  const [message, setMessage] = useState("");
  const visibleGoals = data.goals.filter((item) => !item.deletedAt);
  const goals = visibleGoals.filter((item) => item.isActive);
  const goalHasUnresolvedConflict = (candidateGoalId: string) => (
    unresolvedSyncRecordKeys.has(syncRecordKey("goals", candidateGoalId))
    || data.allocations.some((candidate) => (
      !candidate.deletedAt
      && candidate.goalId === candidateGoalId
      && unresolvedSyncRecordKeys.has(syncRecordKey("allocations", candidate.id))
    ))
  );
  const allocatableGoals = goals.filter((goal) => !goalHasUnresolvedConflict(goal.id));
  const resolvedGoalId = allocatableGoals.some((goal) => goal.id === goalId)
    ? goalId
    : (allocatableGoals[0]?.id ?? "");
  const allocatedToGoal = (id: string) =>
    sumMoney(
      data.allocations
        .filter((item) => !item.deletedAt && item.goalId === id)
        .map((item) => item.amountDelta),
    );
  const releasedFromGoal = (id: string) =>
    data.allocations.filter((item) => item.deletedAt && item.goalId === id)
      .length;

  const resetGoalForm = () => {
    setName("");
    setTarget("");
    setTargetDate("");
    setEditingGoalSnapshot(null);
  };

  const startGoalEdit = (goal: SavingsGoal) => {
    setEditingGoalSnapshot({ ...goal });
    setName(goal.name);
    setTarget(String(goal.targetAmount));
    setTargetDate(goal.targetDate ?? "");
    setMessage(`正在編輯「${goal.name}」`);
  };

  const createGoal = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseRequiredNumberInput(target);
    if (!name.trim() || amount === null || amount <= 0)
      return setMessage(
        "請輸入目標名稱與大於 0、最多兩位小數且可安全精確處理的金額",
      );
    const editingGoal = editingGoalSnapshot
      ? data.goals.find((goal) => goal.id === editingGoalSnapshot.id)
      : undefined;
    const hasUnresolvedConflict = editingGoalSnapshot
      ? unresolvedSyncRecordKeys.has(syncRecordKey("goals", editingGoalSnapshot.id))
      : false;
    if (hasUnresolvedConflict) return setMessage(
      "此儲蓄目標有未解同步衝突；資料未變更，請先從同步狀態完成處理",
    );
    if (editingGoalSnapshot && isEditorSnapshotStale(
      editingGoalSnapshot,
      editingGoal,
    )) return setMessage(
      "此儲蓄目標已在其他裝置或背景更新、封存或刪除；資料未變更，請取消後重新開啟編輯",
    );
    const record = editingGoalSnapshot
      ? buildEditedSavingsGoal(editingGoalSnapshot, editingGoal, {
          name,
          targetAmount: amount,
          targetDate: targetDate || undefined,
        }, new Date(), crypto.randomUUID(), hasUnresolvedConflict)
      : {
          ...newRecordMeta(ownerId),
          name: name.trim(),
          targetAmount: amount,
          targetDate: targetDate || undefined,
          isActive: true,
        };
    const applied = putGoal(record);
    completeAppliedMutation(
      applied,
      () => {
        resetGoalForm();
        setMessage(editingGoalSnapshot ? "目標已更新；既有配置紀錄保持不變" : "目標已建立");
      },
      setMessage,
    );
  };

  const allocate = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseRequiredNumberInput(allocation);
    if (!resolvedGoalId || amount === null || amount <= 0)
      return setMessage(
        allocatableGoals.length === 0 && goals.length > 0
          ? "所有可用目標目前都有未解同步衝突；請先從同步狀態完成處理"
          : "請選擇目標並輸入大於 0、最多兩位小數且可安全精確處理的金額",
      );
    if (goalHasUnresolvedConflict(resolvedGoalId)) return setMessage(
      "此目標或既有配置有未解同步衝突；資料未變更，請先從同步狀態完成處理",
    );
    if (compareMoney(amount, financials.availableAssets) > 0)
      return setMessage(
        `可配置資產僅有 ${money.format(financials.availableAssets)}，未建立配置`,
      );
    const applied = putAllocation({
      ...newRecordMeta(ownerId),
      goalId: resolvedGoalId,
      amountDelta: amount,
      occurredAt: toLocalInput(),
      note: "手動配置",
    });
    completeAppliedMutation(
      applied,
      () => {
        setAllocation("");
        setMessage("已配置；總資產不會因此減少");
      },
      setMessage,
    );
  };

  const releaseGoalAllocation = (goal: SavingsGoal, allocated: number) => {
    if (compareMoney(allocated, 0) <= 0) return;
    if (
      !window.confirm(
        `釋放「${goal.name}」目前配置的 ${money.format(allocated)}？過去配置仍會安全保留，總資產不變。`,
      )
    )
      return;
    const releaseCount = data.allocations.filter((allocation) => (
      !allocation.deletedAt && allocation.goalId === goal.id
    )).length;
    const applied = releaseGoalAllocations(goal);
    completeAppliedMutation(
      applied,
      () => {
        setMessage(
          `已釋放「${goal.name}」的 ${releaseCount} 筆配置；總資產不變`,
        );
      },
      setMessage,
    );
  };

  return (
    <>
      <section
        className="hero-card hero-card-savings"
        aria-labelledby="savings-overview-title"
      >
        <div className="relative z-10">
          <p
            id="savings-overview-title"
            className="text-sm font-bold text-white/75"
          >
            資產配置
          </p>
          <p className="mt-1 text-3xl font-black">
            已配置 {money.format(financials.allocatedSavings)}
          </p>
          <p className="mt-2 text-sm text-white/80">
            總資產 {money.format(financials.totalAssets)} · 可配置{" "}
            {money.format(financials.availableAssets)}
          </p>
          {compareMoney(financials.availableAssets, 0) < 0 && (
            <p className="mt-3 flex items-center gap-2 rounded-xl bg-rose-950/30 p-2 text-sm">
              <AlertTriangle className="h-4 w-4" />
              配置可能因離線同步或資產變動而高於目前資產；請先釋放部分配置，再新增配置。
            </p>
          )}
        </div>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card" aria-labelledby="new-goal-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">想存下來的生活</p>
              <h2 id="new-goal-title">
                {editingGoalId ? "編輯儲蓄目標" : "建立儲蓄目標"}
              </h2>
            </div>
            <Target className="h-7 w-7 text-amber-600" />
          </div>
          <form className="space-y-3" onSubmit={createGoal}>
            <label className="field-label">
              目標名稱
              <input
                aria-label="目標名稱"
                className="field mt-1"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field-label">
              目標金額
              <MoneyInput
                aria-label="目標金額"
                className="field mt-1"
                value={target}
                allowDecimal
                onValueChange={setTarget}
              />
            </label>
            <label className="field-label">
              目標日期（選填）
              <input
                aria-label="目標日期"
                type="date"
                min={editingGoalId ? undefined : localDate(reference)}
                className="field mt-1"
                value={targetDate}
                onChange={(event) => setTargetDate(event.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <button className="primary-button flex-1" type="submit">
                {editingGoalId ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {editingGoalId ? "儲存目標" : "建立目標"}
              </button>
              {editingGoalId && (
                <button
                  className="secondary-button"
                  type="button"
                  aria-label="取消編輯目標"
                  onClick={() => {
                    resetGoalForm();
                    setMessage("已取消編輯目標");
                  }}
                >
                  <X className="h-4 w-4" />
                  取消
                </button>
              )}
            </div>
          </form>
        </section>
        <section className="card" aria-labelledby="allocation-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">總資產不會消失</p>
              <h2 id="allocation-title">配置儲蓄</h2>
            </div>
            <PiggyBank className="h-7 w-7 text-amber-600" />
          </div>
          <form className="space-y-3" onSubmit={allocate}>
            <label className="field-label">
              目標
              <select
                aria-label="配置目標"
                className="field mt-1"
                value={resolvedGoalId}
                onChange={(event) => setGoalId(event.target.value)}
              >
                {goals.map((goal) => (
                  <option
                    key={goal.id}
                    value={goal.id}
                    disabled={goalHasUnresolvedConflict(goal.id)}
                  >
                    {goal.name}{goalHasUnresolvedConflict(goal.id) ? "（同步衝突）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              配置金額
              <MoneyInput
                aria-label="配置金額"
                className="field mt-1"
                value={allocation}
                allowDecimal
                onValueChange={setAllocation}
              />
            </label>
            <button
              className="primary-button w-full"
              type="submit"
              disabled={
                !resolvedGoalId ||
                compareMoney(financials.availableAssets, 0) <= 0
              }
              title={!resolvedGoalId && goals.length > 0
                ? "目標或既有配置有未解同步衝突，請先完成同步處理。"
                : undefined}
            >
              配置到目標
            </button>
          </form>
          {message && (
            <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm dark:bg-zinc-800">
              {message}
            </p>
          )}
        </section>
      </div>
      <section className="card" aria-labelledby="goal-list-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">一步步靠近</p>
            <h2 id="goal-list-title">目標清單</h2>
          </div>
        </div>
        {visibleGoals.length === 0 ? (
          <p className="empty-state">沒有示範數字；建立目標後才會顯示進度。</p>
        ) : (
          <div className="space-y-4">
            {visibleGoals.map((goal) => {
              const current = allocatedToGoal(goal.id);
              const releasedCount = releasedFromGoal(goal.id);
              const targetAmount = sumMoney([goal.targetAmount]);
              const ratio = targetAmount > 0 ? current / targetAmount : 0;
              const conflictBlocked = unresolvedSyncRecordKeys.has(
                syncRecordKey("goals", goal.id),
              ) || data.allocations.some((allocation) => (
                !allocation.deletedAt
                && allocation.goalId === goal.id
                && unresolvedSyncRecordKeys.has(syncRecordKey("allocations", allocation.id))
              ));
              return (
                <article
                  className={
                    goal.isActive
                      ? ""
                      : "rounded-2xl bg-zinc-50 p-3 opacity-75 dark:bg-zinc-800"
                  }
                  key={goal.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <strong>{goal.name}</strong>
                      {!goal.isActive && (
                        <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] dark:bg-zinc-700">
                          已封存
                        </span>
                      )}
                      <p className="text-xs text-zinc-500">
                        {money.format(current)} /{" "}
                        {money.format(goal.targetAmount)}
                        {goal.targetDate
                          ? ` · ${shortDate(goal.targetDate)}`
                          : ""}
                      </p>
                      {releasedCount > 0 && (
                        <p className="text-[11px] text-zinc-500">
                          {releasedCount} 筆已釋放的過去配置仍安全保留
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`編輯${goal.name}`}
                        disabled={conflictBlocked}
                        title={conflictBlocked
                          ? "此儲蓄目標有未解同步衝突，請先完成同步後再編輯。"
                          : undefined}
                        onClick={() => startGoalEdit(goal)}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {current > 0 && (
                        <button
                          className="secondary-button"
                          type="button"
                          aria-label={`釋放${goal.name}配置`}
                          disabled={conflictBlocked}
                          title={conflictBlocked
                            ? "此儲蓄目標有未解同步衝突，請先選擇雲端版本。"
                            : undefined}
                          onClick={() => releaseGoalAllocation(goal, current)}
                        >
                          釋放配置
                        </button>
                      )}
                      {goal.isActive ? (
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`封存 ${goal.name}`}
                          disabled={conflictBlocked}
                          title={conflictBlocked
                            ? "此儲蓄目標有未解同步衝突，請先選擇雲端版本。"
                            : undefined}
                          onClick={() => completeAppliedMutation(
                            archiveGoal(goal),
                            () => {
                              if (editingGoalId === goal.id) resetGoalForm();
                              setMessage(`已封存「${goal.name}」`);
                            },
                            setMessage,
                          )}
                        >
                          <Archive className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          className="secondary-button"
                          type="button"
                          aria-label={`重新啟用${goal.name}`}
                          disabled={conflictBlocked}
                          title={conflictBlocked
                            ? "此儲蓄目標有未解同步衝突，請先選擇雲端版本。"
                            : undefined}
                          onClick={() => completeAppliedMutation(
                            putGoal({
                              ...goal,
                              ...changedRecordMeta(goal),
                              isActive: true,
                            }),
                            () => setMessage(`已重新啟用「${goal.name}」`),
                            setMessage,
                          )}
                        >
                          <RotateCcw className="h-4 w-4" />
                          重新啟用
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="progress-track mt-2">
                    <span
                      style={{
                        width: `${Math.max(0, Math.min(100, ratio * 100))}%`,
                      }}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

export function BudgetPanel({
  data,
  ownerId,
  putBudget,
  archiveBudget,
  reference,
  unresolvedSyncRecordKeys = new Set(),
}: PlanningPanelProps) {
  const [scope, setScope] = useState<"overall" | "category">("overall");
  const [categoryId, setCategoryId] = useState("");
  const [period, setPeriod] = useState<"weekly" | "monthly">("monthly");
  const [amount, setAmount] = useState("");
  const [editingBudgetSnapshot, setEditingBudgetSnapshot] = useState<Budget | null>(null);
  const editingBudgetId = editingBudgetSnapshot?.id ?? "";
  const [message, setMessage] = useState("");
  const categories = selectableBudgetCategories(data, unresolvedSyncRecordKeys);
  const visibleBudgets = data.budgets.filter((item) => !item.deletedAt);
  const archivedBudgets = visibleBudgets.filter((item) => !item.isActive);
  const editingBudget = editingBudgetSnapshot
    ? data.budgets.find((item) => item.id === editingBudgetSnapshot.id)
    : undefined;
  const editingCategory = editingBudgetSnapshot?.scope === "category"
    ? data.categories.find((item) => item.id === editingBudgetSnapshot.categoryId)
    : undefined;
  const categoryOptions = editingCategory && !categories.some((item) => item.id === editingCategory.id)
    ? [editingCategory, ...categories]
    : categories;
  const resolvedCategoryId = categoryOptions.some((item) => item.id === categoryId)
    ? categoryId
    : (categoryOptions[0]?.id ?? "");
  const selectedCategoryLocked = scope === "category" && Boolean(
    resolvedCategoryId
    && unresolvedSyncRecordKeys.has(syncRecordKey("categories", resolvedCategoryId)),
  );
  const usages = useMemo(
    () => calculateBudgetUsage(data, reference),
    [data, reference],
  );

  const budgetName = (budget: Budget) => budget.scope === "overall"
    ? "總預算"
    : data.categories.find((item) => item.id === budget.categoryId)?.name
      ?? budget.categoryName
      ?? "未知分類";

  const resetBudgetForm = () => {
    setScope("overall");
    setCategoryId("");
    setPeriod("monthly");
    setAmount("");
    setEditingBudgetSnapshot(null);
  };

  const startBudgetEdit = (budget: Budget) => {
    setEditingBudgetSnapshot({ ...budget });
    setScope(budget.scope);
    setCategoryId(budget.categoryId ?? "");
    setPeriod(budget.period);
    setAmount(String(budget.amount));
    setMessage(`正在編輯「${budgetName(budget)}」`);
  };

  const conflictMessage = (conflict: Budget) => (
    `已有相同範圍與週期的使用中預算「${budgetName(conflict)}」；請編輯既有預算或先封存它`
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const limit = parseRequiredNumberInput(amount);
    const category = categoryOptions.find((item) => item.id === resolvedCategoryId);
    if (selectedCategoryLocked) return setMessage(
      "此分類仍有待同步的生命週期操作；資料未變更，請完成同步後再設定預算",
    );
    if (limit === null || limit <= 0 || (scope === "category" && !category))
      return setMessage(
        "請輸入大於 0、最多兩位小數且可安全精確處理的預算並選擇分類",
      );
    const hasUnresolvedConflict = editingBudgetSnapshot
      ? unresolvedSyncRecordKeys.has(syncRecordKey("budgets", editingBudgetSnapshot.id))
      : false;
    if (hasUnresolvedConflict) return setMessage(
      "此預算有未解同步衝突；資料未變更，請先從同步狀態完成處理",
    );
    if (editingBudgetSnapshot && isEditorSnapshotStale(
      editingBudgetSnapshot,
      editingBudget,
      { requireActive: true },
    )) return setMessage(
      "此預算已在其他裝置或背景更新、封存或刪除；資料未變更，請取消後重新開啟編輯",
    );
    const record: Budget = editingBudgetSnapshot
      ? buildEditedBudget(editingBudgetSnapshot, editingBudget, {
          scope,
          period,
          amount: limit,
          categoryId: category?.id,
          categoryName: category?.name,
        }, new Date(), crypto.randomUUID(), hasUnresolvedConflict)
      : {
          ...newRecordMeta(ownerId),
          id: budgetSemanticId(ownerId, scope, period, category?.id),
          scope,
          period,
          amount: limit,
          isActive: true,
          ...(category && scope === "category"
            ? { categoryId: category.id, categoryName: category.name }
            : {}),
        };
    const normalized = normalizeBudgetScope(record);
    const semanticMatch = !editingBudgetSnapshot && findBudgetCreationCollision(data.budgets, normalized);
    if (semanticMatch) {
      return setMessage(semanticMatch.deletedAt
        ? `相同範圍與週期已有同步刪除紀錄；為避免舊資料復活，未建立新預算`
        : semanticMatch.isActive
        ? conflictMessage(semanticMatch)
        : `已有相同範圍與週期的已封存預算「${budgetName(semanticMatch)}」；請從已封存預算重新啟用`);
    }
    const conflict = findActiveBudgetConflict(data.budgets, normalized);
    if (conflict) return setMessage(conflictMessage(conflict));
    const applied = putBudget(normalized);
    completeAppliedMutation(
      applied,
      () => {
        resetBudgetForm();
        setMessage(editingBudgetSnapshot ? "預算已更新" : "預算已建立");
      },
      setMessage,
    );
  };

  const restoreBudget = (budget: Budget) => {
    if (budget.scope === "category") {
      const category = data.categories.find((item) => (
        item.id === budget.categoryId
        && item.kind === "expense"
        && item.isActive
        && !item.deletedAt
      ));
      if (!category) {
        setMessage(`「${budgetName(budget)}」分類目前不可用；請先重新啟用分類再恢復預算`);
        return;
      }
    }
    const restored = normalizeBudgetScope({
      ...budget,
      ...changedRecordMeta(budget),
      isActive: true,
    });
    const conflict = findActiveBudgetConflict(data.budgets, restored);
    if (conflict) {
      setMessage(conflictMessage(conflict));
      return;
    }
    completeAppliedMutation(
      putBudget(restored),
      () => setMessage(`已重新啟用「${budgetName(budget)}」`),
      setMessage,
    );
  };

  return (
    <>
      <section className="card" aria-labelledby="budget-form-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">掌握這段時間</p>
            <h2 id="budget-form-title">
              {editingBudgetId ? "編輯預算" : "設定預算"}
            </h2>
          </div>
          <Target className="h-7 w-7 text-amber-600" />
        </div>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <label className="field-label">
            範圍
            <select
              aria-label="預算範圍"
              className="field mt-1"
              disabled={Boolean(editingBudgetId)}
              value={scope}
              onChange={(event) => setScope(event.target.value as typeof scope)}
            >
              <option value="overall">總預算</option>
              <option value="category">分類預算</option>
            </select>
          </label>
          <label className="field-label">
            週期
            <select
              aria-label="預算週期"
              className="field mt-1"
              disabled={Boolean(editingBudgetId)}
              value={period}
              onChange={(event) =>
                setPeriod(event.target.value as typeof period)
              }
            >
              <option value="weekly">每週（週一至週日）</option>
              <option value="monthly">每月</option>
            </select>
          </label>
          {scope === "category" && (
            <label className="field-label">
              支出分類
              <select
                aria-label="預算分類"
                className="field mt-1"
                disabled={Boolean(editingBudgetId)}
                value={resolvedCategoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                {categoryOptions.map((category) => (
                  <option
                    key={category.id}
                    value={category.id}
                    disabled={unresolvedSyncRecordKeys.has(
                      syncRecordKey("categories", category.id),
                    )}
                  >
                    {category.name}{!category.isActive || category.deletedAt
                      ? "（已封存）"
                      : unresolvedSyncRecordKeys.has(syncRecordKey("categories", category.id))
                        ? "（同步處理中）"
                        : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field-label">
            預算金額
            <MoneyInput
              aria-label="預算金額"
              className="field mt-1"
              value={amount}
              allowDecimal
              onValueChange={setAmount}
            />
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button
              className="primary-button flex-1"
              type="submit"
              disabled={scope === "category" && (!resolvedCategoryId || selectedCategoryLocked)}
              title={selectedCategoryLocked
                ? "此分類仍在同步處理中，請完成同步後再設定預算。"
                : undefined}
            >
              {editingBudgetId ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {editingBudgetId ? "儲存修改" : "建立預算"}
            </button>
            {editingBudgetId && (
              <button
                className="secondary-button"
                type="button"
                aria-label="取消編輯預算"
                onClick={() => {
                  resetBudgetForm();
                  setMessage("已取消編輯預算");
                }}
              >
                <X className="h-4 w-4" />
                取消
              </button>
            )}
          </div>
          {message && (
            <p aria-live="polite" className="text-sm text-zinc-600 sm:col-span-2">
              {message}
            </p>
          )}
        </form>
      </section>
      <section className="card" aria-labelledby="budget-list-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">已用／剩餘／超支</p>
            <h2 id="budget-list-title">目前預算</h2>
          </div>
        </div>
        {usages.length === 0 ? (
          <p className="empty-state">尚未設定預算。</p>
        ) : (
          <div className="space-y-4">
            {usages.map((usage) => {
              const budget = data.budgets.find(
                (item) => item.id === usage.budgetId,
              )!;
              const conflictBlocked = unresolvedSyncRecordKeys.has(
                syncRecordKey("budgets", budget.id),
              ) || Boolean(budget.categoryId && unresolvedSyncRecordKeys.has(
                syncRecordKey("categories", budget.categoryId),
              ));
              return (
                <article key={usage.budgetId}>
                  <div className="flex justify-between gap-3">
                    <div>
                      <strong>
                        {usage.name} ·{" "}
                        {usage.period === "weekly" ? "每週" : "每月"}
                      </strong>
                      <p
                        className={`text-xs ${usage.overBy > 0 ? "text-rose-600" : "text-zinc-500"}`}
                      >
                        已用 {money.format(usage.used)} /{" "}
                        {money.format(usage.limit)} ·{" "}
                        {usage.overBy > 0
                          ? `超支 ${money.format(usage.overBy)}`
                          : `剩餘 ${money.format(usage.remaining)}`}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`編輯${usage.name.endsWith("預算") ? usage.name : `${usage.name}預算`}`}
                        disabled={conflictBlocked}
                        title={conflictBlocked
                          ? "此預算有未解同步衝突，請先完成同步後再編輯。"
                          : undefined}
                        onClick={() => startBudgetEdit(budget)}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`封存 ${usage.name} 預算`}
                        disabled={conflictBlocked}
                        title={conflictBlocked
                          ? "此預算有未解同步衝突，請先選擇雲端版本。"
                          : undefined}
                        onClick={() => completeAppliedMutation(
                          archiveBudget(budget),
                          () => {
                            if (editingBudgetId === budget.id) resetBudgetForm();
                            setMessage(`已封存「${usage.name}」預算`);
                          },
                          setMessage,
                        )}
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div
                    className={`progress-track mt-2 ${usage.overBy > 0 ? "progress-danger" : ""}`}
                  >
                    <span
                      style={{
                        width: `${Math.min(100, usage.usageRatio * 100)}%`,
                      }}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="archived-budget-list-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">保留過去設定</p>
            <h2 id="archived-budget-list-title">已封存預算</h2>
          </div>
        </div>
        {archivedBudgets.length === 0 ? (
          <p className="empty-state">目前沒有已封存預算。</p>
        ) : (
          <div className="space-y-2">
            {archivedBudgets.map((budget) => {
              const name = budgetName(budget);
              const conflictBlocked = unresolvedSyncRecordKeys.has(
                syncRecordKey("budgets", budget.id),
              ) || Boolean(budget.categoryId && unresolvedSyncRecordKeys.has(
                syncRecordKey("categories", budget.categoryId),
              ));
              return (
                <article className="settings-row opacity-75" key={budget.id}>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate">{name}</strong>
                    <span className="text-xs text-zinc-500">
                      {budget.period === "weekly" ? "每週" : "每月"} · {money.format(budget.amount)} · 已封存
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`重新啟用${name}預算`}
                    disabled={conflictBlocked}
                    title={conflictBlocked
                      ? "此預算有未解同步衝突，請先選擇雲端版本。"
                      : undefined}
                    onClick={() => restoreBudget(budget)}
                  >
                    <RotateCcw className="h-4 w-4" />
                    重新啟用
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
