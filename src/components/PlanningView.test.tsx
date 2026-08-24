import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../app/state';
import { PlanningView } from './PlanningView';

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
