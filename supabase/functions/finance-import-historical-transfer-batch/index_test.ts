import { validateManifest } from './index.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';

function validBody(): Record<string, unknown> {
  const source = { id: 'archived-bank', user_id: OWNER, name: '目前銀行名' };
  const destination = { id: 'cash', user_id: OWNER, name: '現金' };
  return {
    intent: 'backup-restore',
    batch_id: 'historical-import:restore:test',
    account_operations: [source, destination],
    endpoint_accounts: [source, destination],
    transfer_operations: [{
      id: 'historical-transfer',
      user_id: OWNER,
      source_account_id: source.id,
      destination_account_id: destination.id,
      source_account_name: '舊銀行名',
      destination_account_name: '現金',
    }],
  };
}

function assertThrows(callback: () => unknown, pattern: RegExp): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && pattern.test(error.message)) return;
    throw error;
  }
  throw new Error(`Expected error matching ${pattern}`);
}

Deno.test('accepts only the explicit owner-scoped import/restore manifest', () => {
  const result = validateManifest(validBody(), OWNER);
  if (result.batchId !== 'historical-import:restore:test') {
    throw new Error('Expected the validated restore batch id');
  }
});

Deno.test('rejects a generic browser claim that lacks an authorized intent prefix', () => {
  const body = validBody();
  body.intent = 'ordinary-transfer';
  body.batch_id = 'historical-import:claimed';
  assertThrows(() => validateManifest(body, OWNER), /intent or batch id/);
});

Deno.test('rejects foreign-owner and incomplete endpoint manifests', () => {
  const foreign = validBody();
  (foreign.transfer_operations as Record<string, unknown>[])[0].user_id =
    '22222222-2222-4222-8222-222222222222';
  assertThrows(() => validateManifest(foreign, OWNER), /foreign transfer operation/);

  const incomplete = validBody();
  (incomplete.endpoint_accounts as Record<string, unknown>[]).pop();
  assertThrows(() => validateManifest(incomplete, OWNER), /incomplete/);
});
