interface SelectableRecord {
  id: string;
}

export function resolveExplicitSelection<T extends SelectableRecord>(
  requestedId: string,
  safeOptions: readonly T[],
): string {
  if (!requestedId) return "";
  return safeOptions.some((option) => option.id === requestedId)
    ? requestedId
    : "";
}
