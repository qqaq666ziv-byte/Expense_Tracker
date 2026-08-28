import { describe, expect, it } from 'vitest';
import {
  MAX_PINNED_NOTE_SHORTCUTS,
  changePinnedNoteShortcuts,
  loadPinnedNoteShortcuts,
} from './noteShortcutPreferences';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('device-local pinned note shortcuts', () => {
  it('adds a shortcut and persists it for the same owner reload', () => {
    const storage = new MemoryStorage();

    expect(changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '  滷肉飯  ' }))
      .toEqual({ shortcuts: ['滷肉飯'], persisted: true });
    expect(loadPinnedNoteShortcuts(storage, 'guest')).toEqual(['滷肉飯']);
  });

  it('removes a shortcut explicitly', () => {
    const storage = new MemoryStorage();
    changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '早餐' });
    changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '滷肉飯' });

    expect(changePinnedNoteShortcuts(storage, 'guest', { type: 'remove', note: '早餐' }))
      .toEqual({ shortcuts: ['滷肉飯'], persisted: true });
  });

  it('isolates guest and authenticated owner namespaces', () => {
    const storage = new MemoryStorage();
    changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '訪客早餐' });
    changePinnedNoteShortcuts(storage, 'user-a', { type: 'add', note: '登入早餐' });

    expect(loadPinnedNoteShortcuts(storage, 'guest')).toEqual(['訪客早餐']);
    expect(loadPinnedNoteShortcuts(storage, 'user-a')).toEqual(['登入早餐']);
    expect(loadPinnedNoteShortcuts(storage, 'user-b')).toEqual([]);
  });

  it('fails safely to empty for malformed local payloads without touching finance storage', () => {
    const storage = new MemoryStorage();
    changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '早餐' });
    const shortcutKey = [...storage.values.keys()][0];
    storage.values.set('shiba-finance:v3:guest', '{"ledger":"untouched"}');

    for (const malformed of [
      '{broken',
      JSON.stringify({ schemaVersion: 2, shortcuts: ['早餐'] }),
      JSON.stringify({ schemaVersion: 1, shortcuts: ['早餐', 123] }),
      JSON.stringify({ schemaVersion: 1, shortcuts: [' 早餐 '] }),
    ]) {
      storage.values.set(shortcutKey, malformed);
      expect(loadPinnedNoteShortcuts(storage, 'guest')).toEqual([]);
      expect(storage.values.get('shiba-finance:v3:guest')).toBe('{"ledger":"untouched"}');
    }
  });

  it('normalizes duplicates and rejects whitespace-only shortcuts', () => {
    const storage = new MemoryStorage();
    changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '滷肉飯  加蛋' });

    expect(changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: ' 滷肉飯\t加蛋 ' }))
      .toEqual({ shortcuts: ['滷肉飯 加蛋'], persisted: false, error: 'duplicate' });
    expect(changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: ' \n\t ' }))
      .toEqual({ shortcuts: ['滷肉飯 加蛋'], persisted: false, error: 'empty' });
  });

  it('supports Chinese and emoji while enforcing UTF-8 size and count limits', () => {
    const storage = new MemoryStorage();
    expect(changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '🍙 早餐' }))
      .toEqual({ shortcuts: ['🍙 早餐'], persisted: true });
    expect(changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '🍙'.repeat(41) }))
      .toEqual({ shortcuts: ['🍙 早餐'], persisted: false, error: 'size-limit' });

    for (let index = 1; index < MAX_PINNED_NOTE_SHORTCUTS; index += 1) {
      changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: `快捷 ${index}` });
    }
    expect(changePinnedNoteShortcuts(storage, 'guest', { type: 'add', note: '超出上限' }))
      .toEqual({
        shortcuts: ['🍙 早餐', ...Array.from({ length: MAX_PINNED_NOTE_SHORTCUTS - 1 }, (_, index) => `快捷 ${index + 1}`)],
        persisted: false,
        error: 'count-limit',
      });
  });
});
