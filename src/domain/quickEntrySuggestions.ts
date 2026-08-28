import type { FinanceData } from './model';
import { isTutorialTransaction } from './tutorialRecord';

export type QuickEntryMode = 'expense' | 'income' | 'transfer';

export interface NoteSuggestionOptions {
  mode: QuickEntryMode;
  ownerId: string;
  now?: Date;
  categoryId?: string;
  accountId?: string;
  query?: string;
  limit?: number;
  excludeNormalizedNotes?: Iterable<string>;
}

export interface QuickReentryOptions extends Omit<NoteSuggestionOptions, 'query' | 'excludeNormalizedNotes'> {
  mode: 'expense' | 'income';
  lockedRecordKeys?: ReadonlySet<string>;
}

export interface QuickReentryCandidate {
  sourceTransactionId: string;
  note: string;
  amount: number;
  categoryId: string;
  categoryName: string;
  accountId: string;
  accountName: string;
}

interface NoteEvidence {
  note: string;
  count: number;
  latestAt: number;
  categoryMatches: number;
  accountMatches: number;
}

/** Preserve the user's wording while removing accidental spacing differences. */
export function normalizeLedgerNote(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function timestamp(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function collectNoteEvidence(data: FinanceData, options: NoteSuggestionOptions): NoteEvidence[] {
  const grouped = new Map<string, NoteEvidence>();
  const add = (rawNote: string, occurredAt: string, categoryId?: string, accountId?: string) => {
    const note = normalizeLedgerNote(rawNote);
    const usedAt = timestamp(occurredAt);
    if (!note || usedAt === null) return;
    const current = grouped.get(note) ?? {
      note, count: 0, latestAt: Number.NEGATIVE_INFINITY, categoryMatches: 0, accountMatches: 0,
    };
    current.count += 1;
    current.latestAt = Math.max(current.latestAt, usedAt);
    if (options.categoryId && categoryId === options.categoryId) current.categoryMatches += 1;
    if (options.accountId && accountId === options.accountId) current.accountMatches += 1;
    grouped.set(note, current);
  };

  if (options.mode === 'transfer') {
    for (const transfer of data.transfers) {
      if (transfer.ownerId !== options.ownerId || transfer.deletedAt
        || !Number.isFinite(transfer.amount) || transfer.amount <= 0
        || !transfer.sourceAccountId || !transfer.destinationAccountId
        || typeof transfer.note !== 'string') continue;
      add(transfer.note, transfer.occurredAt);
    }
  } else {
    for (const transaction of data.transactions) {
      if (transaction.ownerId !== options.ownerId || transaction.deletedAt
        || transaction.type !== options.mode || isTutorialTransaction(transaction)
        || !Number.isFinite(transaction.amount) || transaction.amount <= 0
        || !transaction.categoryId || !transaction.accountId
        || typeof transaction.note !== 'string') continue;
      add(transaction.note, transaction.occurredAt, transaction.categoryId, transaction.accountId);
    }
  }
  return [...grouped.values()];
}

function evidenceScore(evidence: NoteEvidence, options: NoteSuggestionOptions): number {
  const now = (options.now ?? new Date()).getTime();
  const ageDays = Math.max(0, (now - evidence.latestAt) / 86_400_000);
  const frequency = Math.min(evidence.count, 5) * 20;
  const recency = Math.max(0, 72 - ageDays * 2);
  const categoryContext = Math.min(evidence.categoryMatches, 3) * 10;
  const accountContext = Math.min(evidence.accountMatches, 3) * 7;
  return frequency + recency + categoryContext + accountContext;
}

/** Derive small, deterministic note suggestions from the current ledger only. */
export function deriveCommonNoteSuggestions(
  data: FinanceData,
  options: NoteSuggestionOptions,
): string[] {
  const query = normalizeLedgerNote(options.query ?? '').toLocaleLowerCase('zh-TW');
  const excluded = new Set([...options.excludeNormalizedNotes ?? []].map(normalizeLedgerNote));
  return collectNoteEvidence(data, options)
    .filter((evidence) => evidence.count >= 2 && !excluded.has(evidence.note))
    .filter((evidence) => {
      if (!query) return true;
      const comparableNote = evidence.note.toLocaleLowerCase('zh-TW');
      return comparableNote !== query && comparableNote.includes(query);
    })
    .sort((left, right) => (
      evidenceScore(right, options) - evidenceScore(left, options)
      || right.latestAt - left.latestAt
      || right.count - left.count
      || left.note.localeCompare(right.note, 'zh-TW')
    ))
    .slice(0, Math.max(0, Math.min(options.limit ?? 4, 8)))
    .map((evidence) => evidence.note);
}

interface QuickReentryEvidence extends QuickReentryCandidate {
  count: number;
  latestAt: number;
  categoryMatches: number;
  accountMatches: number;
}

/**
 * Derive repeated ordinary-transaction templates. Parent resolution fails
 * closed: unavailable or conflicted parents hide the full template while the
 * independent note suggestion may remain available.
 */
export function deriveQuickReentryCandidates(
  data: FinanceData,
  options: QuickReentryOptions,
): QuickReentryCandidate[] {
  const locked = options.lockedRecordKeys ?? new Set<string>();
  const grouped = new Map<string, QuickReentryEvidence>();

  for (const transaction of data.transactions) {
    const note = typeof transaction.note === 'string' ? normalizeLedgerNote(transaction.note) : '';
    const usedAt = timestamp(transaction.occurredAt);
    if (transaction.ownerId !== options.ownerId || transaction.deletedAt
      || transaction.type !== options.mode || isTutorialTransaction(transaction)
      || !Number.isFinite(transaction.amount) || transaction.amount <= 0
      || !note || !transaction.categoryId || !transaction.accountId || usedAt === null
      || locked.has(`transactions:${transaction.id}`)) continue;

    const key = JSON.stringify([note, transaction.amount, transaction.categoryId, transaction.accountId]);
    const current = grouped.get(key) ?? {
      sourceTransactionId: transaction.id,
      note,
      amount: transaction.amount,
      categoryId: transaction.categoryId,
      categoryName: transaction.categoryName,
      accountId: transaction.accountId,
      accountName: transaction.accountName,
      count: 0,
      latestAt: Number.NEGATIVE_INFINITY,
      categoryMatches: 0,
      accountMatches: 0,
    };
    current.count += 1;
    if (usedAt > current.latestAt || (usedAt === current.latestAt
      && transaction.id.localeCompare(current.sourceTransactionId) > 0)) {
      current.latestAt = usedAt;
      current.sourceTransactionId = transaction.id;
    }
    if (options.categoryId && transaction.categoryId === options.categoryId) current.categoryMatches += 1;
    if (options.accountId && transaction.accountId === options.accountId) current.accountMatches += 1;
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .filter((candidate) => candidate.count >= 2)
    .flatMap((candidate) => {
      const category = data.categories.find((item) => item.id === candidate.categoryId);
      const account = data.accounts.find((item) => item.id === candidate.accountId);
      if (!category || !account
        || category.ownerId !== options.ownerId || account.ownerId !== options.ownerId
        || category.deletedAt || account.deletedAt || !category.isActive || !account.isActive
        || category.kind !== options.mode
        || locked.has(`categories:${category.id}`) || locked.has(`accounts:${account.id}`)) return [];
      return [{
        ...candidate,
        categoryName: category.name,
        accountName: account.name,
      }];
    })
    .sort((left, right) => {
      const leftScore = evidenceScore(left, options);
      const rightScore = evidenceScore(right, options);
      return rightScore - leftScore
        || right.latestAt - left.latestAt
        || right.count - left.count
        || left.note.localeCompare(right.note, 'zh-TW')
        || left.sourceTransactionId.localeCompare(right.sourceTransactionId);
    })
    .slice(0, Math.max(0, Math.min(options.limit ?? 3, 6)))
    .map(({ count: _count, latestAt: _latestAt, categoryMatches: _categoryMatches,
      accountMatches: _accountMatches, ...candidate }) => candidate);
}
