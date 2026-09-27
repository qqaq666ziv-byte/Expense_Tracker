import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../app/state';
import { parseShortcutReviewAmount, reviewTimeInput, reviewTimeIso, shortcutParents, SHORTCUT_TEST_TEMPLATE } from './model';

describe('shortcut review safety', () => {
  it('keeps pasted decimal values exact and rejects coercion, ambiguous formatting and overflow', () => {
    expect(parseShortcutReviewAmount('125.5')).toBe(125.5);
    expect(parseShortcutReviewAmount('0.01')).toBe(0.01);
    expect(parseShortcutReviewAmount('100000000')).toBe(100000000);
    for (const value of ['', '0', '-1', '1,255', '$125.5', '1e3', '1.234', 'Infinity', '100000000.01']) {
      expect(parseShortcutReviewAmount(value), value).toBeNull();
    }
  });

  it('rejects empty and rolled-over calendar dates before approval', () => {
    expect(reviewTimeIso('')).toBeNull();
    expect(reviewTimeIso('2026-02-30T07:47')).toBeNull();
    expect(reviewTimeIso('2026-01-02T25:00')).toBeNull();
    expect(reviewTimeIso('2026-01-02T07:47')).toMatch(/^2026-01-0[12]T/);
  });

  it('preserves source seconds and milliseconds until the displayed time is edited', () => {
    const original = '2026-01-01T23:47:42.123Z';
    const displayed = reviewTimeInput(original);
    expect(reviewTimeIso(displayed, original)).toBe(original);
    const edited = `${displayed.slice(0, 14)}48`;
    expect(reviewTimeIso(edited, original)).toBe(new Date(edited).toISOString());
    expect(reviewTimeIso(edited, original)).not.toBe(original);
  });

  it('excludes foreign, archived, deleted, review-required and conflicted parents', () => {
    const data = createInitialState('owner-a').data;
    const account = data.accounts[0];
    const category = data.categories.find((row) => row.kind === 'expense')!;
    data.accounts = [account,
      { ...account, id: 'foreign', ownerId: 'owner-b' }, { ...account, id: 'archived', isActive: false },
      { ...account, id: 'deleted', deletedAt: '2026-01-02' }, { ...account, id: 'review', requiresReview: true },
      { ...account, id: 'conflicted' },
    ];
    data.categories = [category,
      { ...category, id: 'foreign', ownerId: 'owner-b' }, { ...category, id: 'income', kind: 'income' },
      { ...category, id: 'archived', isActive: false }, { ...category, id: 'deleted', deletedAt: '2026-01-02' },
      { ...category, id: 'conflicted' },
    ];
    const parents = shortcutParents(data, 'owner-a', new Set(['conflicted']), new Set(['conflicted']));
    expect(parents.accounts.map((row) => row.id)).toEqual([account.id]);
    expect(parents.categories.map((row) => row.id)).toEqual([category.id]);
  });

  it('starts shortcut installation in test mode without invented event IDs or credentials', () => {
    const template = JSON.parse(SHORTCUT_TEST_TEMPLATE);
    expect(template).toMatchObject({ version: 1, source: 'jkopay', test: true });
    expect(template).not.toHaveProperty('eventId');
    expect(template).not.toHaveProperty('token');
    expect(template).not.toHaveProperty('occurredAt');
  });
});
