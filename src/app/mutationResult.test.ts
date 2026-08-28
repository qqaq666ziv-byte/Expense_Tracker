import { describe, expect, it, vi } from 'vitest';
import {
  completeAppliedMutation,
  MUTATION_NOT_APPLIED_MESSAGE,
} from './mutationResult';

describe('applied mutation UI contract', () => {
  it('preserves form input and reports recovery protection when the mutation was not applied', () => {
    let input = '尚未落盤的輸入';
    let message = '';
    const reset = vi.fn(() => { input = ''; });

    const applied = completeAppliedMutation(false, reset, (next) => { message = next; });

    expect(applied).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(input).toBe('尚未落盤的輸入');
    expect(message).toBe(MUTATION_NOT_APPLIED_MESSAGE);
    expect(message).toMatch(/操作未執行.*復原保護/);
  });

  it('runs the existing success cleanup only after an applied mutation', () => {
    const reset = vi.fn();
    const reject = vi.fn();

    const applied = completeAppliedMutation(true, reset, reject);

    expect(applied).toBe(true);
    expect(reset).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });

  it('waits for durable persistence before running success cleanup', async () => {
    const reset = vi.fn();
    const reject = vi.fn();

    const pending = completeAppliedMutation(Promise.resolve(false), reset, reject);

    expect(reset).not.toHaveBeenCalled();
    expect(await pending).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(MUTATION_NOT_APPLIED_MESSAGE);
  });
});
