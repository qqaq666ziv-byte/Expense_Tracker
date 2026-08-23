export interface DisplayOrderedRecord {
  id: string;
  name: string;
  sortOrder: number;
}

function compareCodePoints(left: string, right: string, normalize = false): number {
  const leftPoints = [...(normalize ? left.normalize('NFC') : left)];
  const rightPoints = [...(normalize ? right.normalize('NFC') : right)];
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/** Return a copy in the user-persisted order with stable deterministic ties. */
export function sortByDisplayOrder<T extends DisplayOrderedRecord>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => (
    left.sortOrder - right.sortOrder
    || compareCodePoints(left.name, right.name, true)
    || compareCodePoints(left.id, right.id)
  ));
}

/** Preserve sparse/imported order ranges by appending after the current max. */
export function nextDisplayOrder<T extends Pick<DisplayOrderedRecord, 'sortOrder'>>(items: readonly T[]): number {
  return items.reduce((maximum, item) => Math.max(maximum, item.sortOrder), -1) + 1;
}
