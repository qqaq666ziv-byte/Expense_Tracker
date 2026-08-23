import { describe, expect, it } from 'vitest';
import { nextDisplayOrder, sortByDisplayOrder } from './displayOrder';

describe('display ordering', () => {
  it('uses persisted sortOrder instead of remote row or id order', () => {
    const remotelyIdOrdered = [
      { id: 'a-id', name: '第二個', sortOrder: 20 },
      { id: 'z-id', name: '第一個', sortOrder: 10 },
      { id: 'm-id', name: '同順位 B', sortOrder: 30 },
      { id: 'b-id', name: '同順位 A', sortOrder: 30 },
    ];

    expect(sortByDisplayOrder(remotelyIdOrdered).map((item) => item.id)).toEqual([
      'z-id',
      'a-id',
      'b-id',
      'm-id',
    ]);
    expect(remotelyIdOrdered.map((item) => item.id)).toEqual(['a-id', 'z-id', 'm-id', 'b-id']);
  });

  it('appends after the greatest persisted order instead of using record count', () => {
    expect(nextDisplayOrder([
      { id: 'income-a', name: '薪資', sortOrder: 6 },
      { id: 'income-b', name: '獎金', sortOrder: 9 },
    ])).toBe(10);
    expect(nextDisplayOrder([])).toBe(0);
  });
});
