import type { Category } from '../domain/model';

/** Share the exact category write set with the sync-conflict guard. */
export function planCategoryReorder(
  categories: readonly Category[],
  category: Category,
): { record: Category; sortOrder: number }[] {
  const siblings = categories
    .filter((candidate) => (
      candidate.id !== category.id
      && candidate.ownerId === category.ownerId
      && candidate.kind === category.kind
      && !candidate.deletedAt
    ))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const desiredIndex = Math.max(0, Math.min(category.sortOrder, siblings.length));
  const ordered = [...siblings];
  ordered.splice(desiredIndex, 0, category);
  return ordered.flatMap((record, sortOrder) => (
    record.id === category.id || record.sortOrder !== sortOrder
      ? [{ record, sortOrder }]
      : []
  ));
}
