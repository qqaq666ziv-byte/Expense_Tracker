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

  it('uses Unicode code-point ties instead of runtime ICU collation', () => {
    const concurrentRecords = [
      { id: 'record-umlaut', name: 'ä', sortOrder: 4 },
      { id: 'record-ascii', name: 'z', sortOrder: 4 },
    ];

    expect(sortByDisplayOrder(concurrentRecords).map((item) => item.id)).toEqual([
      'record-ascii',
      'record-umlaut',
    ]);
  });

  it('uses the raw opaque id when normalized display names are equivalent', () => {
    const canonicallyEquivalentNames = [
      { id: 'é', name: 'é', sortOrder: 2 },
      { id: 'e\u0301', name: 'e\u0301', sortOrder: 2 },
    ];

    expect(sortByDisplayOrder(canonicallyEquivalentNames).map((item) => item.id)).toEqual([
      'e\u0301',
      'é',
    ]);
  });
});
