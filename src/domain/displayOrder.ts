export interface DisplayOrderedRecord {
  id: string;
  name: string;
  sortOrder: number;
}

/** Return a copy in the user-persisted order with stable deterministic ties. */
export function sortByDisplayOrder<T extends DisplayOrderedRecord>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, 'zh-Hant')
    || left.id.localeCompare(right.id)
  ));
}

/** Preserve sparse/imported order ranges by appending after the current max. */
export function nextDisplayOrder<T extends Pick<DisplayOrderedRecord, 'sortOrder'>>(items: readonly T[]): number {
  return items.reduce((maximum, item) => Math.max(maximum, item.sortOrder), -1) + 1;
}
