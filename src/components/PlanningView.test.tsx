import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import { resolveExplicitSelection } from '../app/explicitSelection';
import {
  BudgetPanel,
  buildEditedBudget,
  buildEditedSavingsGoal,
  PlanningView,
  resolveBudgetCategoryId,
  selectableBudgetCategories,
} from './PlanningView';

describe('PlanningView goal lifecycle', () => {
  it('fails closed instead of allocating to another goal when the selected goal becomes unavailable', () => {
    const state = createInitialState('guest');
    state.data.accounts = [{ ...state.data.accounts[0], openingBalance: 10_000 }];
    const goalA = {
      id: 'goal-a', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-28T00:00:00.000Z', lastOperationId: 'goal-a-create',
      name: '目標 A', targetAmount: 5_000, isActive: true,
    } as const;
    const goalB = {
      ...goalA,
      id: 'goal-b',
      lastOperationId: 'goal-b-create',
      name: '目標 B',
    };
    state.data.goals = [goalA, goalB];

    expect(resolveExplicitSelection(goalA.id, [goalA, goalB])).toBe(goalA.id);
    expect(resolveExplicitSelection(goalA.id, [goalB])).toBe('');
    expect(resolveExplicitSelection(goalB.id, [goalB])).toBe(goalB.id);

    const html = renderToStaticMarkup(
      <PlanningView
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
        unresolvedSyncRecordKeys={new Set([`goals:${goalA.id}`])}
      />,
    );
    expect(html).toContain('<option value="" disabled="" selected="">請選擇目標</option>');
    expect(html.match(/<button class="primary-button w-full"[^>]*>配置到目標<\/button>/)?.[0])
      .toContain('disabled=""');
  });

  it('edits the goal record without changing its allocation history', () => {
    const state = createInitialState('guest');
    const goal = {
      id: 'goal-trip', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'goal-create',
      name: '旅行基金', targetAmount: 5_000, targetDate: '2026-12-31', isActive: true,
    } as const;
    state.data.goals = [goal];
    state.data.allocations = [{
      id: 'allocation-trip', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-21T11:00:00.000Z', lastOperationId: 'allocation-create',
      goalId: goal.id, amountDelta: 800, occurredAt: '2026-08-21 11:00',
    }];
    const allocationsBefore = structuredClone(state.data.allocations);

    state.data.goals[0] = buildEditedSavingsGoal(goal, goal, {
      name: '日本旅行',
      targetAmount: 8_000,
      targetDate: undefined,
    }, new Date('2026-08-22T00:00:00.000Z'), 'goal-edit');

    expect(state.data.goals[0]).toMatchObject({
      id: 'goal-trip', ownerId: 'guest', version: 3,
      lastOperationId: '00000000-0000-0000-0000-000000000000:active:goal-edit',
      name: '日本旅行', targetAmount: 8_000, isActive: true,
    });
    expect(state.data.goals[0].targetDate).toBeUndefined();
    expect(state.data.allocations).toEqual(allocationsBefore);
  });

  it('rejects a stale goal editor without overwriting the N+1 record', () => {
    const opened = {
      id: 'goal-trip', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'goal-opened',
      name: '旅行基金', targetAmount: 5_000, isActive: true,
    };
    const current = {
      ...opened,
      version: 3,
      lastOperationId: 'goal-background-update',
      name: '雲端旅行基金',
    };
    const before = structuredClone(current);

    expect(() => buildEditedSavingsGoal(opened, current, {
      name: '舊表單名稱',
      targetAmount: 8_000,
    })).toThrow(/背景更新/);
    expect(current).toEqual(before);
  });

  it('rejects a goal editor while its same-clock payload conflict is unresolved', () => {
    const goal = {
      id: 'goal-conflict', ownerId: 'guest', version: 3,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'same-clock',
      name: '本機目標', targetAmount: 5_000, isActive: true,
    };

    expect(() => buildEditedSavingsGoal(goal, goal, {
      name: '不應儲存',
      targetAmount: 8_000,
    }, new Date(), 'blocked-goal-edit', true)).toThrow(/未解同步衝突/);
  });

  it('allows editing a goal that was already archived when the editor opened', () => {
    const archived = {
      id: 'goal-archived', ownerId: 'guest', version: 3,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'goal-archive',
      name: '舊名稱', targetAmount: 5_000, isActive: false,
    };

    const edited = buildEditedSavingsGoal(archived, archived, {
      name: '封存後整理名稱',
      targetAmount: 6_000,
    }, new Date('2026-08-27T02:00:00.000Z'), 'archived-goal-edit');

    expect(edited).toMatchObject({
      name: '封存後整理名稱',
      targetAmount: 6_000,
      isActive: false,
      version: 4,
    });
  });

  it('disables the goal edit action while a same-clock payload conflict is unresolved', () => {
    const state = createInitialState('guest');
    state.data.goals = [{
      id: 'goal-conflict', ownerId: 'guest', version: 3,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'same-clock',
      name: '同步衝突目標', targetAmount: 5_000, isActive: true,
    }];

    const html = renderToStaticMarkup(
      <PlanningView
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
        unresolvedSyncRecordKeys={new Set(['goals:goal-conflict'])}
      />,
    );

    const editButton = html.match(/<button[^>]*aria-label="編輯同步衝突目標"[^>]*>/)?.[0];
    expect(editButton).toContain('disabled=""');
    expect(html).toContain('此儲蓄目標有未解同步衝突');
  });

  it('disables goal lifecycle actions when one child allocation has an unresolved conflict', () => {
    const state = createInitialState('guest');
    state.data.goals = [{
      id: 'goal-child-conflict', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'goal-create',
      name: '子配置衝突目標', targetAmount: 5_000, isActive: true,
    }];
    state.data.allocations = [{
      id: 'allocation-conflict', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-27T00:00:00.000Z', lastOperationId: 'same-clock',
      goalId: 'goal-child-conflict', amountDelta: 500, occurredAt: '2026-08-27 08:00',
    }];

    const html = renderToStaticMarkup(
      <PlanningView
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
        releaseGoalAllocations={() => true}
        unresolvedSyncRecordKeys={new Set(['allocations:allocation-conflict'])}
      />,
    );

    expect(html.match(/<button[^>]*aria-label="釋放子配置衝突目標配置"[^>]*>/)?.[0])
      .toContain('disabled=""');
    expect(html.match(/<button[^>]*aria-label="封存 子配置衝突目標"[^>]*>/)?.[0])
      .toContain('disabled=""');
    expect(html.match(/<button[^>]*>配置到目標<\/button>/)?.[0])
      .toContain('disabled=""');
    expect(html).toContain('子配置衝突目標（同步衝突）');
  });
});

describe('PlanningView archived allocations', () => {
  it('keeps an archived funded goal visible with auditable release and restore actions', () => {
    const state = createInitialState('guest');
    state.data.goals = [{
      id: 'goal-archived', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'archive-goal',
      name: '旅行基金', targetAmount: 5_000, isActive: false,
    }];
    state.data.allocations = [{
      id: 'allocation-1', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-21T09:00:00.000Z', lastOperationId: 'allocate-goal',
      goalId: 'goal-archived', amountDelta: 800, occurredAt: '2026-08-21 09:00',
    }, {
      id: 'allocation-released', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-21T09:30:00.000Z', lastOperationId: 'release-goal',
      deletedAt: '2026-08-21T09:30:00.000Z',
      goalId: 'goal-archived', amountDelta: 200, occurredAt: '2026-08-21 08:00',
    }];

    const html = renderToStaticMarkup(
      <PlanningView
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
      />,
    );

    expect(html).toContain('旅行基金');
    expect(html).toContain('已封存');
    expect(html).toContain('編輯旅行基金');
    expect(html).toContain('釋放旅行基金配置');
    expect(html).toContain('重新啟用旅行基金');
    expect(html).toContain('1 筆已釋放的過去配置仍安全保留');
  });

  it('does not treat 0.10 plus 0.20 as exceeding 0.30 of assets', () => {
    const state = createInitialState('guest');
    state.data.accounts = [{ ...state.data.accounts[0], openingBalance: 0.3 }];
    state.data.goals = [{
      id: 'goal-decimal', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'goal-decimal',
      name: '零錢目標', targetAmount: 1, isActive: true,
    }];
    state.data.allocations = [0.1, 0.2].map((amountDelta, index) => ({
      id: `allocation-${index}`, ownerId: 'guest', version: 1,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: `allocation-${index}`,
      goalId: 'goal-decimal', amountDelta, occurredAt: '2026-08-21 10:00',
    }));

    const html = renderToStaticMarkup(
      <PlanningView
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
      />,
    );

    expect(html).not.toMatch(/高於(?:目前)?資產/);
    const allocationButton = html.match(/<button[^>]*>配置到目標<\/button>/)?.[0];
    expect(allocationButton).toBeDefined();
    expect(allocationButton).toContain('disabled');
  });

  it('explains that over-allocation can follow sync or asset changes and points to release', () => {
    const state = createInitialState('guest');
    state.data.accounts = [{ ...state.data.accounts[0], openingBalance: 0.2 }];
    state.data.goals = [{
      id: 'goal-over', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'goal-over',
      name: '超額目標', targetAmount: 1, isActive: true,
    }];
    state.data.allocations = [{
      id: 'allocation-over', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'allocation-over',
      goalId: 'goal-over', amountDelta: 0.3, occurredAt: '2026-08-21 10:00',
    }];

    const html = renderToStaticMarkup(
      <PlanningView
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
      />,
    );

    expect(html).toContain('離線同步或資產變動');
    expect(html).toContain('釋放部分配置');
  });
});

describe('PlanningView budget lifecycle', () => {
  it('excludes batch-locked categories from new budget choices', () => {
    const state = createInitialState('guest');
    const expenseCategories = state.data.categories.filter((item) => item.kind === 'expense');
    const locked = expenseCategories[0];

    const selectable = selectableBudgetCategories(
      state.data,
      new Set([`categories:${locked.id}`]),
    );

    expect(selectable.some((category) => category.id === locked.id)).toBe(false);
    expect(selectable.length).toBe(expenseCategories.length - 1);
    expect(resolveBudgetCategoryId(locked.id, selectable)).toBe('');
    expect(resolveBudgetCategoryId('', selectable)).toBe('');
    expect(resolveBudgetCategoryId(selectable[0].id, selectable)).toBe(selectable[0].id);
  });

  it('shows explicit edit actions and keeps archived budgets available for restore', () => {
    const state = createInitialState('guest');
    const category = state.data.categories.find((item) => item.kind === 'expense')!;
    state.data.budgets = [{
      id: 'budget-active', ownerId: 'guest', version: 1,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'budget-active-create',
      scope: 'overall', period: 'monthly', amount: 12_000, isActive: true,
    }, {
      id: 'budget-archived', ownerId: 'guest', version: 2,
      updatedAt: '2026-08-21T11:00:00.000Z', lastOperationId: 'budget-archive',
      scope: 'category', categoryId: category.id, categoryName: category.name,
      period: 'weekly', amount: 2_000, isActive: false,
    }];

    const html = renderToStaticMarkup(
      <BudgetPanel
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
        reference={new Date(2026, 7, 21, 12)}
      />,
    );

    expect(html).toContain('編輯總預算');
    expect(html).toContain('已封存預算');
    expect(html).toContain('重新啟用餐飲預算');
  });

  it('disables the budget edit action while a same-clock payload conflict is unresolved', () => {
    const state = createInitialState('guest');
    state.data.budgets = [{
      id: 'budget-conflict', ownerId: 'guest', version: 3,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'same-clock',
      scope: 'overall', period: 'monthly', amount: 12_000, isActive: true,
    }];

    const html = renderToStaticMarkup(
      <BudgetPanel
        data={state.data}
        ownerId="guest"
        putGoal={() => true}
        putAllocation={() => true}
        putBudget={() => true}
        putRecurring={() => true}
        deleteRecurring={() => true}
        archiveGoal={() => true}
        archiveBudget={() => true}
        unresolvedSyncRecordKeys={new Set(['budgets:budget-conflict'])}
        reference={new Date(2026, 7, 21, 12)}
      />,
    );

    const editButton = html.match(/<button[^>]*aria-label="編輯總預算"[^>]*>/)?.[0];
    expect(editButton).toContain('disabled=""');
    expect(html).toContain('此預算有未解同步衝突');
  });

  it('rejects a stale budget editor without overwriting the N+1 record', () => {
    const opened = {
      id: 'budget-monthly', ownerId: 'guest', version: 4,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'budget-opened',
      scope: 'overall' as const, period: 'monthly' as const, amount: 12_000, isActive: true,
    };
    const current = {
      ...opened,
      version: 5,
      lastOperationId: 'budget-background-update',
      amount: 15_000,
    };
    const before = structuredClone(current);

    expect(() => buildEditedBudget(opened, current, {
      scope: 'overall',
      period: 'monthly',
      amount: 9_000,
    })).toThrow(/背景更新/);
    expect(current).toEqual(before);
  });

  it('rejects a budget editor while its same-clock payload conflict is unresolved', () => {
    const budget = {
      id: 'budget-conflict', ownerId: 'guest', version: 3,
      updatedAt: '2026-08-21T10:00:00.000Z', lastOperationId: 'same-clock',
      scope: 'overall' as const, period: 'monthly' as const, amount: 12_000, isActive: true,
    };

    expect(() => buildEditedBudget(budget, budget, {
      scope: 'overall',
      period: 'monthly',
      amount: 15_000,
    }, new Date(), 'blocked-budget-edit', true)).toThrow(/未解同步衝突/);
  });
});
