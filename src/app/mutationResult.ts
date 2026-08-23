export const MUTATION_NOT_APPLIED_MESSAGE = '操作未執行；若非自行取消，請先處理畫面上方的復原保護或帳號安全提示。';

/**
 * Keep form state intact unless the controller confirms that the mutation was
 * applied to memory (and therefore eligible for durable persistence).
 */
export function completeAppliedMutation(
  applied: boolean,
  onApplied: () => void,
  onNotApplied: (message: string) => void,
): boolean {
  if (!applied) {
    onNotApplied(MUTATION_NOT_APPLIED_MESSAGE);
    return false;
  }
  onApplied();
  return true;
}
