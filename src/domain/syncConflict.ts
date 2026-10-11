import type { PendingOperation, PendingSyncConflict } from './model';

export const UNRESOLVED_PAYLOAD_CONFLICT_PREFIX = 'unresolved same-clock payload conflict';
export const TRANSFER_DEPENDENCY_CONFLICT_PREFIX = 'transfer selected account changed before cloud write';

function invalidConflict(): never {
  throw new Error('Invalid persisted sync conflict metadata');
}

function transferEndpoints(operation: PendingOperation): string[] {
  const record = operation.record;
  if (operation.entity !== 'transfers'
    || !('sourceAccountId' in record) || typeof record.sourceAccountId !== 'string'
    || !('destinationAccountId' in record) || typeof record.destinationAccountId !== 'string') {
    return invalidConflict();
  }
  return [record.sourceAccountId, record.destinationAccountId];
}

function validateConflict(operation: PendingOperation, value: unknown): PendingSyncConflict | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value)) {
    return invalidConflict();
  }
  switch (value.kind) {
    case 'payload': return { kind: 'payload' };
    case 'unresolved': return { kind: 'unresolved' };
    case 'batch':
      if (typeof operation.batchId !== 'string' || operation.batchId.length === 0) {
        return invalidConflict();
      }
      return { kind: 'batch' };
    case 'transfer-dependency': {
      const endpoints = new Set(transferEndpoints(operation));
      if (!('accountIds' in value) || !Array.isArray(value.accountIds)
        || value.accountIds.length === 0 || value.accountIds.length > 2
        || !value.accountIds.every((id): id is string => typeof id === 'string' && endpoints.has(id))
        || new Set(value.accountIds).size !== value.accountIds.length) {
        return invalidConflict();
      }
      return { kind: 'transfer-dependency', accountIds: [...value.accountIds] };
    }
    default: return invalidConflict();
  }
}

/** The only adapter that interprets error text written before conflict metadata existed. */
function legacyConflict(operation: PendingOperation): PendingSyncConflict | null {
  const message = operation.lastError;
  if (!message) return null;
  if (operation.entity === 'transfers' && message.startsWith(TRANSFER_DEPENDENCY_CONFLICT_PREFIX)) {
    const marker = `${TRANSFER_DEPENDENCY_CONFLICT_PREFIX}: accounts=`;
    // Early snapshots did not identify changed endpoints. Reconfirm both rather
    // than treating either unknown endpoint as a trusted historical reference.
    let accountIds = transferEndpoints(operation);
    if (message.startsWith(marker)) {
      const serialized = message.slice(marker.length).split(';', 1)[0];
      try {
        accountIds = [...new Set(serialized.split(',').filter(Boolean).map(decodeURIComponent))];
      } catch {
        return invalidConflict();
      }
    }
    return validateConflict(operation, { kind: 'transfer-dependency', accountIds });
  }
  if (message.startsWith(UNRESOLVED_PAYLOAD_CONFLICT_PREFIX)) return { kind: 'payload' };
  if (operation.batchId && message.includes('batch conflict')) return { kind: 'batch' };
  if (message.startsWith('pending local mutation for ') || message.startsWith('unresolved sync conflict for ')) {
    return { kind: 'unresolved' };
  }
  return null;
}

/** Explicit null and typed metadata always win over diagnostic wording. Invalid data never falls back. */
export function readPendingSyncConflict(operation: PendingOperation): PendingSyncConflict | null {
  if (operation.lastError !== undefined && typeof operation.lastError !== 'string') {
    return invalidConflict();
  }
  return operation.conflict === undefined
    ? legacyConflict(operation)
    : validateConflict(operation, operation.conflict);
}
