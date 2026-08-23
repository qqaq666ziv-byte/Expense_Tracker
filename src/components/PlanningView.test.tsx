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
        putGoal={() => undefined}
        putAllocation={() => undefined}
        putBudget={() => undefined}
        archiveGoal={() => undefined}
        archiveBudget={() => undefined}
      />,
    );

    expect(html).toContain('旅行基金');
    expect(html).toContain('已封存');
    expect(html).toContain('釋放旅行基金配置');
    expect(html).toContain('重新啟用旅行基金');
    expect(html).toContain('1 筆已釋放配置保留 tombstone 稽核');
  });
});
