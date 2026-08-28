export const MUTATION_NOT_APPLIED_MESSAGE = '操作未執行；若非自行取消，請先處理畫面上方的復原保護或帳號安全提示。';

export type MutationApplication = boolean | Promise<boolean>;

/**
 * Keep form state intact unless the controller confirms that the mutation and
 * its authenticated outbox entry crossed the durable local commit boundary.
 */
export function completeAppliedMutation(
  applied: MutationApplication,
  onApplied: () => void,
  onNotApplied: (message: string) => void,
): MutationApplication {
  if (typeof applied !== 'boolean') {
    return applied.then(
      (resolved) => completeAppliedMutation(resolved, onApplied, onNotApplied) as boolean,
      () => completeAppliedMutation(false, onApplied, onNotApplied) as boolean,
    );
  }
  if (!applied) {
    onNotApplied(MUTATION_NOT_APPLIED_MESSAGE);
    return false;
  }
  onApplied();
  return true;
}
