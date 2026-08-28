import { normalizeLedgerNote } from '../domain/quickEntrySuggestions';

export const MAX_PINNED_NOTE_SHORTCUTS = 12;
export const MAX_PINNED_NOTE_UTF8_BYTES = 160;

const SCHEMA_VERSION = 1;
const KEY_PREFIX = 'shiba-finance:note-shortcuts:v1:';

interface PinnedNotePayload {
  schemaVersion: 1;
  shortcuts: string[];
}

type ShortcutStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type PinnedNoteShortcutChange =
  | { type: 'add'; note: string }
  | { type: 'remove'; note: string };

export interface PinnedNoteShortcutChangeResult {
  shortcuts: string[];
  persisted: boolean;
  error?: 'empty' | 'duplicate' | 'count-limit' | 'size-limit' | 'storage';
}

function storageKey(ownerId: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(ownerId)}`;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validatePayload(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Partial<PinnedNotePayload>;
  if (payload.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.shortcuts)
    || payload.shortcuts.length > MAX_PINNED_NOTE_SHORTCUTS) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const shortcut of payload.shortcuts) {
    if (typeof shortcut !== 'string') return null;
    const note = normalizeLedgerNote(shortcut);
    if (!note || note !== shortcut || utf8Length(note) > MAX_PINNED_NOTE_UTF8_BYTES || seen.has(note)) return null;
    seen.add(note);
    normalized.push(note);
  }
  return normalized;
}

/** Malformed or inaccessible convenience preferences fail to an empty list only. */
export function loadPinnedNoteShortcuts(storage: Pick<Storage, 'getItem'>, ownerId: string): string[] {
  try {
    const raw = storage.getItem(storageKey(ownerId));
    if (!raw) return [];
    return validatePayload(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

/** Change one owner-scoped device preference without touching FinanceData. */
export function changePinnedNoteShortcuts(
  storage: ShortcutStorage,
  ownerId: string,
  change: PinnedNoteShortcutChange,
): PinnedNoteShortcutChangeResult {
  const current = loadPinnedNoteShortcuts(storage, ownerId);
  const note = normalizeLedgerNote(change.note);
  if (!note) return { shortcuts: current, persisted: false, error: 'empty' };
  if (utf8Length(note) > MAX_PINNED_NOTE_UTF8_BYTES) {
    return { shortcuts: current, persisted: false, error: 'size-limit' };
  }

  let next: string[];
  if (change.type === 'add') {
    if (current.includes(note)) return { shortcuts: current, persisted: false, error: 'duplicate' };
    if (current.length >= MAX_PINNED_NOTE_SHORTCUTS) {
      return { shortcuts: current, persisted: false, error: 'count-limit' };
    }
    next = [...current, note];
  } else {
    next = current.filter((shortcut) => shortcut !== note);
  }

  try {
    storage.setItem(storageKey(ownerId), JSON.stringify({ schemaVersion: SCHEMA_VERSION, shortcuts: next }));
    return { shortcuts: next, persisted: true };
  } catch {
    return { shortcuts: current, persisted: false, error: 'storage' };
  }
}
