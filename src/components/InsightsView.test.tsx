import { describe, expect, it } from 'vitest';
import { deltaTone } from './InsightsView';

describe('InsightsView comparison sentiment', () => {
  it('treats higher expense as unfavorable while preserving normal income and net sentiment', () => {
    expect(deltaTone(80, false)).toBe('text-rose-600');
    expect(deltaTone(-80, false)).toBe('text-emerald-600');
    expect(deltaTone(80, true)).toBe('text-emerald-600');
    expect(deltaTone(-80, true)).toBe('text-rose-600');
    expect(deltaTone(0, false)).toBe('text-zinc-500');
  });
});
