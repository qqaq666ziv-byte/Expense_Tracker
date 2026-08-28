import { describe, expect, it } from 'vitest';
import type { AssetAccount } from './model';
import { isEditorSnapshotStale } from './staleEditor';

const opened: AssetAccount = {
  id: 'cash',
  ownerId: 'guest',
  version: 2,
  updatedAt: '2026-08-27T00:00:00.000Z',
  lastOperationId: 'account-opened',
  name: '現金',
  icon: { type: 'emoji', value: '💵' },
  openingBalance: 1_000,
  includeInTotalAssets: true,
  isActive: true,
  sortOrder: 0,
};

describe('stale editor snapshot guard', () => {
  it.each([
    ['missing', undefined],
    ['different id', { ...opened, id: 'bank' }],
    ['tombstoned', { ...opened, deletedAt: '2026-08-27T01:00:00.000Z' }],
    ['archived', { ...opened, isActive: false }],
    ['newer version', { ...opened, version: 3 }],
    ['different operation', { ...opened, lastOperationId: 'account-background-update' }],
  ])('fails closed when the current record is %s', (_case, current) => {
    expect(isEditorSnapshotStale(opened, current, { requireActive: true })).toBe(true);
  });

  it('accepts the exact editable clock and can allow paused recurring rules', () => {
    expect(isEditorSnapshotStale(opened, { ...opened }, { requireActive: true })).toBe(false);
    expect(isEditorSnapshotStale(opened, { ...opened, isActive: false })).toBe(false);
  });

  it('allows an exact soft-deleted snapshot only when the caller opts into historical semantics', () => {
    const deleted = { ...opened, isActive: false, deletedAt: '2026-08-27T01:00:00.000Z' };
    expect(isEditorSnapshotStale(deleted, deleted)).toBe(true);
    expect(isEditorSnapshotStale(deleted, deleted, { allowDeleted: true })).toBe(false);
    expect(isEditorSnapshotStale(deleted, { ...deleted, version: 3 }, {
      allowDeleted: true,
    })).toBe(true);
  });

  it('fails closed when the same record key has an unresolved payload conflict', () => {
    expect(isEditorSnapshotStale(opened, { ...opened }, {
      hasUnresolvedConflict: true,
    })).toBe(true);
  });
});
