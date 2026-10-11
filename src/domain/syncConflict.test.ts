import { describe, expect, it } from 'vitest';
import type { PendingOperation, Transfer } from './model';
import {
  readPendingSyncConflict,
  TRANSFER_DEPENDENCY_CONFLICT_PREFIX,
  UNRESOLVED_PAYLOAD_CONFLICT_PREFIX,
} from './syncConflict';

function pendingTransfer(): PendingOperation {
  const record: Transfer = {
    id: 'transfer', ownerId: 'user-a', version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z', lastOperationId: 'transfer-create',
    sourceAccountId: 'bank', sourceAccountName: '銀行',
    destinationAccountId: 'cash', destinationAccountName: '現金',
    amount: 100, occurredAt: '2026-09-01 08:00',
  };
  return {
    id: record.lastOperationId, entity: 'transfers', recordId: record.id, record,
    attempts: 0, queuedAt: record.updatedAt,
  };
}

describe('persisted sync conflict adapter', () => {
  it('gives explicit metadata precedence over legacy diagnostic text', () => {
    const legacy = {
      ...pendingTransfer(),
      lastError: `${TRANSFER_DEPENDENCY_CONFLICT_PREFIX}: accounts=bank,cash; confirm`,
    };
    expect(readPendingSyncConflict(legacy)).toEqual({
      kind: 'transfer-dependency', accountIds: ['bank', 'cash'],
    });
    expect(readPendingSyncConflict({ ...legacy, conflict: { kind: 'payload' } }))
      .toEqual({ kind: 'payload' });
    expect(readPendingSyncConflict({ ...legacy, conflict: null })).toBeNull();
  });

  it.each([
    [UNRESOLVED_PAYLOAD_CONFLICT_PREFIX, { kind: 'payload' }],
    ['pending local mutation for transfers/transfer requires review', { kind: 'unresolved' }],
    ['unresolved sync conflict for transfers/transfer; pending write was not sent', { kind: 'unresolved' }],
    ['offline before apply', null],
  ])('reads legacy diagnostic %s only for an operation without metadata', (lastError, expected) => {
    expect(readPendingSyncConflict({ ...pendingTransfer(), lastError })).toEqual(expected);
  });

  it('recognizes a legacy batch conflict only while the operation belongs to a batch', () => {
    const pending = { ...pendingTransfer(), lastError: 'batch conflict for transfers/transfer' };
    expect(readPendingSyncConflict(pending)).toBeNull();
    expect(readPendingSyncConflict({ ...pending, batchId: 'batch' })).toEqual({ kind: 'batch' });
  });

  it('decodes only legacy endpoint data, including delimiters and non-ASCII account ids', () => {
    const pending = pendingTransfer();
    const source = 'bank,;銀行';
    const destination = 'cash%現金';
    pending.record = { ...pending.record, sourceAccountId: source, destinationAccountId: destination } as Transfer;
    pending.lastError = `${TRANSFER_DEPENDENCY_CONFLICT_PREFIX}: accounts=${encodeURIComponent(source)},${encodeURIComponent(destination)}; diagnostic`;
    expect(readPendingSyncConflict(pending)).toEqual({
      kind: 'transfer-dependency', accountIds: [source, destination],
    });
    expect(readPendingSyncConflict({
      ...pending,
      conflict: { kind: 'transfer-dependency', accountIds: [destination] },
      lastError: '已翻譯顯示文字',
    })).toEqual({ kind: 'transfer-dependency', accountIds: [destination] });
  });

  it('requires both endpoints to be reconfirmed for a legacy marker without endpoint ids', () => {
    expect(readPendingSyncConflict({
      ...pendingTransfer(), lastError: TRANSFER_DEPENDENCY_CONFLICT_PREFIX,
    })).toEqual({ kind: 'transfer-dependency', accountIds: ['bank', 'cash'] });
  });

  it.each([
    false,
    [],
    {},
    { kind: 'future-kind' },
    { kind: 'batch' },
    { kind: 'transfer-dependency' },
    { kind: 'transfer-dependency', accountIds: [] },
    { kind: 'transfer-dependency', accountIds: ['bank', 'bank'] },
    { kind: 'transfer-dependency', accountIds: ['foreign'] },
    { kind: 'transfer-dependency', accountIds: [1] },
  ])('rejects malformed metadata instead of falling back to a recognized display prefix: %j', (conflict) => {
    const malformed = {
      ...pendingTransfer(), conflict, lastError: UNRESOLVED_PAYLOAD_CONFLICT_PREFIX,
    } as unknown as PendingOperation;
    expect(() => readPendingSyncConflict(malformed)).toThrow(/Invalid persisted sync conflict metadata/);
  });

  it('rejects transfer dependency metadata on another entity', () => {
    const malformed = {
      ...pendingTransfer(), entity: 'accounts',
      conflict: { kind: 'transfer-dependency', accountIds: ['bank'] },
    } as PendingOperation;
    expect(() => readPendingSyncConflict(malformed)).toThrow(/Invalid persisted sync conflict metadata/);
  });

  it.each(['%', 'unrelated-account', ''])('rejects unsafe legacy endpoint data %j', (serialized) => {
    expect(() => readPendingSyncConflict({
      ...pendingTransfer(), lastError: `${TRANSFER_DEPENDENCY_CONFLICT_PREFIX}: accounts=${serialized}; confirm`,
    })).toThrow(/Invalid persisted sync conflict metadata/);
  });

  it('rejects a non-string persisted diagnostic even with explicit null metadata', () => {
    const malformed = { ...pendingTransfer(), conflict: null, lastError: 42 } as unknown as PendingOperation;
    expect(() => readPendingSyncConflict(malformed)).toThrow(/Invalid persisted sync conflict metadata/);
  });
});
