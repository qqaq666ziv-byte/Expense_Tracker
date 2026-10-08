import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

// In-memory PostgreSQL only: no URLs, credentials or Production connection.
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const files = (await readdir(migrationDirectory)).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
const sources = await Promise.all(files.map((name) => readFile(resolve(migrationDirectory, name), 'utf8')));
assert.ok(files.some((name) => name.endsWith('_finance_shortcut_inbox.sql')), 'shortcut migration exists');
assert.ok(files.some((name) => name.endsWith('_idempotent_shortcut_create.sql')), 'idempotent create migration exists');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const hashA = sha('synthetic-only-secret-a');
const hashB = sha('synthetic-only-secret-b');
let assertions = 0;
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); assertions += 1; }
async function rejects(action, pattern, label) { await assert.rejects(action, pattern, label); assertions += 1; }
const db = new PGlite();

async function one(sql, parameters = [], client = db) {
  const result = await client.query(sql, parameters);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}
async function as(role, owner, sql, parameters = []) {
  // Test isolation also proves a rejected RPC rolls its statement back.
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [owner ?? '']);
    const result = await one(sql, parameters, tx);
    return result.result;
  });
}
const createConnection = (owner, tokenHash) => as('authenticated', owner,
  'select public.finance_shortcut_create($1, $2) as result', ['測試手機', tokenHash]);
const configure = (owner, id, account = 'account-a', category = 'category-a', mode = 'review', stableIdConfirmed = false) => as('authenticated', owner,
  'select public.finance_shortcut_configure($1, $2, $3, $4, $5) as result', [id, account, category, mode, stableIdConfirmed]);
const review = (owner, id, action = 'approve', account = 'account-a', category = 'category-a', amount = null, merchant = null, date = null) => as('authenticated', owner,
  'select public.finance_shortcut_review($1,$2,$3,$4,$5,$6,$7) as result', [id, action, account, category, amount, merchant, date]);
const listConnections = (owner) => as('authenticated', owner, 'select public.finance_shortcut_list_connections() as result');
const txCount = async () => Number((await one('select count(*) as count from public.transactions')).count);

function event(seed, overrides = {}) {
  return {
    hash: hashA, key: `id:${sha(seed)}`, fingerprint: sha(`payload:${seed}`),
    payload: { version: 1, source: 'jkopay', title: '扣款通知', text: 'Synthetic notification for database verification', test: false },
    amount: '1234.00', merchant: 'Example Services', date: '2026-01-01T23:47:00Z',
    format: null, auto: false, reason: 'topup_requires_review', ...overrides,
  };
}
function receive(input, role = 'service_role', owner = null) {
  return as(role, owner, 'select public.finance_shortcut_receive($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',
    [input.hash, input.key, input.fingerprint, input.payload, input.amount, input.merchant, input.date, input.format, input.auto, input.reason]);
}
const strictEvent = (seed, overrides = {}) => event(seed, { format: 'jkopay-single-debit-v1', auto: true, reason: 'ready_for_review', ...overrides });

try {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable set search_path = pg_catalog
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    revoke all on schema auth from public, anon, authenticated;
    grant usage on schema auth to authenticated, service_role;
    revoke all on function auth.uid() from public, anon;
    grant execute on function auth.uid() to authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(sources.join('\n'));
  equal((await one("select count(*)::integer count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'finance_shortcut_%' and c.relkind='r' and c.relrowsecurity")).count, 2, 'both public tables have RLS after retry');
  const permissions = await one(`select
    has_table_privilege('authenticated','public.finance_shortcut_connections','SELECT') as direct_connection_read,
    has_column_privilege('authenticated','public.finance_shortcut_connections','token_hash','SELECT') as token_hash_read,
    has_table_privilege('authenticated','public.finance_shortcut_inbox','INSERT') as direct_inbox_insert,
    has_function_privilege('anon','public.finance_shortcut_create(text,text)','EXECUTE') as anonymous_create,
    has_function_privilege('authenticated','public.finance_shortcut_authenticate(text)','EXECUTE') as owner_authenticate,
    has_function_privilege('service_role','public.finance_shortcut_authenticate(text)','EXECUTE') as service_authenticate,
    has_function_privilege('anon','public.finance_shortcut_configure(uuid,text,text,text,boolean)','EXECUTE') as anonymous_configure,
    has_function_privilege('authenticated','public.finance_shortcut_configure(uuid,text,text,text,boolean)','EXECUTE') as owner_configure,
    has_function_privilege('authenticated','finance_private.shortcut_post(uuid,text,text,numeric,text,timestamp with time zone)','EXECUTE') as direct_post`);
  equal(permissions, { direct_connection_read: false, token_hash_read: false, direct_inbox_insert: false,
    anonymous_create: false, owner_authenticate: false, service_authenticate: true, anonymous_configure: false,
    owner_configure: true, direct_post: false }, 'least privilege grants');

  await db.query('insert into auth.users(id) values($1),($2)', [A, B]);
  await db.query(`insert into public.accounts(user_id,id,name,icon_type,icon_value,last_operation_id,requires_review)
    values($1,'account-a','Owner A account','vector','wallet','fixture-a',false),
      ($2,'account-b','Owner B account','vector','wallet','fixture-b',false),
      ($1,'needs-review','Unconfirmed balance','vector','wallet','fixture-r',true)`, [A, B]);
  await db.query(`insert into public.categories(user_id,id,kind,name,icon_type,icon_value,last_operation_id)
    values($1,'category-a','expense','Owner A category','vector','utensils','fixture-a'),
      ($2,'category-b','expense','Owner B category','vector','tag','fixture-b'),
      ($1,'income-a','income','Income category','vector','wallet','fixture-i')`, [A, B]);
  await rejects(() => createConnection(null, hashA), /authentication_required/, 'missing owner fails closed');
  const connection = await createConnection(A, hashA);
  equal(await createConnection(A, hashA), connection, 'lost create response retry returns same connection');
  equal((await listConnections(A)).filter((row) => row.id === connection.id).length, 1, 'create retry does not add a connection');
  const connectionB = await createConnection(B, hashB);
  await rejects(() => as('authenticated', A, 'select public.finance_shortcut_create($1,$2) as result', ['different label', hashA]),
    /connection_create_conflict/, 'same token hash cannot be rebound to a different label');
  await rejects(() => as('authenticated', B, 'select public.finance_shortcut_create($1,$2) as result', ['測試手機', hashA]),
    /duplicate key/, 'existing credential hash cannot be disclosed to another owner');
  equal(connection.mode, 'review', 'new connection defaults to review');
  equal(connection.verified_at, null, 'new connection is unverified');
  equal('token_hash' in connection, false, 'create response never exposes credential hash');
  equal((await listConnections(B)).map((row) => row.id), [connectionB.id], 'list isolates owners');
  await rejects(() => configure(B, connection.id, 'account-b', 'category-b'), /connection_not_found/, 'foreign connection is unavailable');
  await rejects(() => configure(A, connection.id, 'account-b'), /active_account_required/, 'foreign account rejected');
  await rejects(() => configure(A, connection.id, 'needs-review'), /active_account_required/, 'unconfirmed account rejected');
  await rejects(() => configure(A, connection.id, 'account-a', 'income-a'), /active_expense_category_required/, 'income category rejected');
  await rejects(() => configure(A, connection.id, 'account-a', 'category-a', 'auto'), /verified_notification_required/, 'unproven auto rejected');
  await configure(A, connection.id);

  equal(await as('service_role', null, 'select public.finance_shortcut_authenticate($1) as result', [sha('wrong')]), false, 'unknown token does not authenticate');
  await rejects(() => receive(event('unauthorized'), 'authenticated', A), /permission denied/, 'authenticated cannot invoke service intake');
  await rejects(() => receive(event('anon'), 'anon', null), /permission denied/, 'anonymous cannot invoke intake');
  await rejects(() => receive(event('wrong-token', { hash: sha('wrong') })), /invalid_shortcut_token/, 'invalid token cannot intake');
  const testItem = await receive(strictEvent('test-only', { payload: { ...event('x').payload, test: true } }));
  equal(testItem.status, 'test', 'test request is isolated');
  equal(await txCount(), 0, 'test request creates no financial row');
  await rejects(() => review(A, testItem.id), /pending_notification_required/, 'test cannot be approved');
  equal((await listConnections(A))[0].verified_at, null, 'test cannot prove a format');

  const mixed = await receive(event('mixed'));
  equal(mixed.status, 'pending', 'topup message stays pending');
  await rejects(() => review(B, mixed.id, 'approve', 'account-b', 'category-b'), /notification_not_found/, 'foreign inbox cannot be approved');
  equal(await as('authenticated', B, 'select public.finance_shortcut_list_inbox() as result'), [], 'foreign inbox not listed');
  const approved = await review(A, mixed.id);
  equal(approved.status, 'imported', 'manual review posts expense');
  equal(await txCount(), 1, 'one reviewed expense');
  equal((await listConnections(A))[0].verified_at, null, 'mixed message does not prove auto parser');
  equal(await review(A, mixed.id), approved, 'review retry returns identical result');
  equal((await receive(event('mixed'))).duplicate, true, 'stable source ID is idempotent');
  equal(await txCount(), 1, 'intake and approval retries never duplicate finance');
  const snapshot = await one('select user_id, amount, account_name, category_name, occurred_at, date, version, last_operation_id from public.transactions where id=$1', [approved.transaction_id]);
  equal({ owner: snapshot.user_id, amount: Number(snapshot.amount), account: snapshot.account_name, category: snapshot.category_name,
    occurredAt: snapshot.occurred_at, date: snapshot.date, version: Number(snapshot.version) },
  { owner: A, amount: 1234, account: 'Owner A account', category: 'Owner A category', occurredAt: '2026-01-01T23:47:00.000Z', date: '2026-01-01T23:47:00.000Z', version: 1 }, 'canonical financial snapshot and sync metadata');
  assert.match(snapshot.last_operation_id, /^shortcut-import-/); assertions += 1;
  const revisionAfterImport = await as('authenticated', A, 'select public.finance_v4_bootstrap_revision() as result');
  assert.ok(Number(revisionAfterImport.revision) > 0); assertions += 1;
  await db.query('update public.transactions set deleted_at=clock_timestamp(), version=version+1, last_operation_id=$2 where id=$1', [approved.transaction_id, 'fixture-tombstone']);
  equal(await review(A, mixed.id), approved, 'replay after tombstone returns previous result');
  equal((await receive(event('mixed'))).status, 'imported', 'receive after tombstone does not resurrect expense');
  equal((await one('select deleted_at is not null as tombstone from public.transactions where id=$1', [approved.transaction_id])).tombstone, true, 'tombstone retained');

  const corrected = await receive(strictEvent('corrected'));
  await review(A, corrected.id, 'approve', 'account-a', 'category-a', '1300');
  equal((await listConnections(A))[0].verified_at, null, 'correcting parser output does not enable auto');
  const noIdProof = await receive(strictEvent('no-id-proof', {
    key: `fp:${sha('strict-without-source-id')}`, fingerprint: sha('strict-without-source-id'),
  }));
  await review(A, noIdProof.id);
  equal((await listConnections(A))[0].verified_at, null, 'manual approval of a strict no-ID message never verifies auto');
  equal((await listConnections(A))[0].verified_format, null, 'no-ID approval does not unlock the parser format');
  await rejects(() => configure(A, connection.id, 'account-a', 'category-a', 'auto', true),
    /verified_notification_required/, 'declaring ID stability cannot replace a reviewed source-ID event');
  const proof = await receive(strictEvent('proof'));
  await review(A, proof.id);
  equal((await listConnections(A))[0].verified_format, 'jkopay-single-debit-v1', 'real matching approval records exact parser version');
  await rejects(() => as('authenticated', A,
    'select public.finance_shortcut_configure($1,$2,$3,$4) as result', [connection.id, 'account-a', 'category-a', 'auto']),
  /stable_event_id_confirmation_required/, 'omitted stable-ID confirmation defaults to false');
  await rejects(() => configure(A, connection.id, 'account-a', 'category-a', 'auto', false),
    /stable_event_id_confirmation_required/, 'false confirmation cannot enable auto');
  await rejects(() => configure(A, connection.id, 'account-a', 'category-a', 'auto', null),
    /stable_event_id_confirmation_required/, 'null confirmation cannot enable auto');
  await configure(A, connection.id, 'account-a', 'category-a', 'auto', true);
  const beforeAuto = await txCount();
  const auto = await receive(strictEvent('auto-1'));
  equal(auto.status, 'imported', 'proven format plus stable ID can auto post');
  equal(await txCount(), beforeAuto + 1, 'auto creates exactly one row');
  equal((await receive(strictEvent('auto-1'))).duplicate, true, 'auto retry remains idempotent');
  equal(await txCount(), beforeAuto + 1, 'auto retry does not create another row');
  const activeConflictBefore = await one('select minute_count,day_count from finance_private.shortcut_rate_limits where user_id=$1', [A]);
  equal(await receive(strictEvent('auto-1', { fingerprint: sha('different-body') })), { error: 'event_id_payload_conflict' }, 'same source ID with changed payload returns a committed conflict');
  const activeConflictAfter = await one('select minute_count,day_count from finance_private.shortcut_rate_limits where user_id=$1', [A]);
  equal(Number(activeConflictAfter.minute_count), Number(activeConflictBefore.minute_count) + 1, 'active conflict consumes minute quota');
  equal(Number(activeConflictAfter.day_count), Number(activeConflictBefore.day_count) + 1, 'active conflict consumes daily quota');
  await db.query(`update finance_private.shortcut_rate_limits set minute_start=date_trunc('minute',clock_timestamp()),minute_count=28,
    day_start=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC',day_count=28 where user_id=$1`, [A]);
  equal((await receive(strictEvent('auto-1', { fingerprint: sha('conflict-near-minute-limit-1') }))).error,
    'event_id_payload_conflict', 'first repeated conflict below threshold remains a conflict');
  equal((await receive(strictEvent('auto-1', { fingerprint: sha('conflict-near-minute-limit-2') }))).error,
    'event_id_payload_conflict', 'second repeated conflict reaches but does not exceed threshold');
  equal((await receive(strictEvent('auto-1', { fingerprint: sha('conflict-near-minute-limit-3') }))).error,
    'shortcut_rate_limit', 'repeated conflicts consume quota and are eventually rate limited');
  await db.query(`update finance_private.shortcut_rate_limits set minute_start=date_trunc('minute',clock_timestamp()),minute_count=0,
    day_start=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC',day_count=0 where user_id=$1`, [A]);

  const noId = strictEvent('no-id', { key: `fp:${sha('same-content')}`, fingerprint: sha('same-content') });
  const noIdFirst = await receive(noId);
  const noIdRetry = await receive(noId);
  equal(noIdFirst.status, 'pending', 'no stable source ID never auto posts');
  equal(noIdRetry.status, 'pending', 'identical content remains a reviewable extra arrival');
  equal(noIdRetry.duplicate, true, 'identical content flags ambiguity');
  assert.notEqual(noIdFirst.id, noIdRetry.id); assertions += 1;
  equal((await one('select reason from public.finance_shortcut_inbox where id=$1', [noIdFirst.id])).reason, 'missing_event_id', 'missing source ID explained');
  equal((await one('select reason from public.finance_shortcut_inbox where id=$1', [noIdRetry.id])).reason, 'possible_duplicate', 'content collision is not silently lost');
  const changedArrival = await receive(strictEvent('no-id-arrival-clock', {
    key: `fp:${sha('same-content-different-arrival-time')}`, fingerprint: sha('same-content-different-arrival-time'),
    payload: { ...noId.payload, occurredAt: '2026-01-02T09:00:00Z' },
  }));
  equal(changedArrival.status, 'pending', 'changing caller arrival time cannot bypass no-ID auto gate');
  equal(await txCount(), beforeAuto + 1, 'all no-ID arrivals leave finances unchanged');
  const mixedAuto = await receive(event('mixed-while-auto'));
  equal(mixedAuto.status, 'pending', 'topup remains pending even after auto enabled');
  const autoTest = await receive(strictEvent('test-while-auto', { payload: { ...noId.payload, test: true } }));
  equal(autoTest.status, 'test', 'test remains isolated while auto is on');
  equal(await txCount(), beforeAuto + 1, 'mixed/test events never auto post');

  // Archive wins if committed before intake; FOR SHARE covers a concurrent
  // archive after intake has acquired the parent. PGlite is a single-session
  // engine, so lock structure is checked separately rather than claiming E2E.
  await db.query('update public.accounts set is_active=false,version=version+1,last_operation_id=$2 where user_id=$1 and id=$3', [A, 'fixture-archive', 'account-a']);
  const beforeRetired = await txCount();
  const retired = await receive(strictEvent('retired-parent'));
  equal(retired.status, 'pending', 'archived auto parent falls back to review');
  equal(await txCount(), beforeRetired, 'archived parent cannot receive finance');
  equal((await listConnections(A))[0].mode, 'review', 'auto disarmed after unavailable parent');
  await rejects(() => review(A, retired.id), /active_account_required/, 'manual approve rejects archived parent');
  equal((await one('select status from public.finance_shortcut_inbox where id=$1', [retired.id])).status, 'pending', 'failed approval leaves proposal intact');
  const revBefore = await as('authenticated', A, 'select public.finance_v4_bootstrap_revision() as result');
  await rejects(() => review(A, retired.id, 'approve', 'account-a', 'category-a', '0'), /valid_expense_fields_required/, 'invalid amount rejected');
  equal(await as('authenticated', A, 'select public.finance_v4_bootstrap_revision() as result'), revBefore, 'failed posting never advances sync revision');

  await rejects(() => as('authenticated', B, 'select public.finance_shortcut_revoke($1) as result', [connection.id]), /connection_not_found/, 'foreign owner cannot revoke');
  await as('authenticated', A, 'select public.finance_shortcut_revoke($1) as result', [connection.id]);
  equal(await as('service_role', null, 'select public.finance_shortcut_authenticate($1) as result', [hashA]), false, 'revoke invalidates scoped credential');
  await rejects(() => receive(event('after-revoke')), /invalid_shortcut_token/, 'intake rechecks revocation inside lock');
  await rejects(() => configure(A, connection.id), /connection_not_found/, 'revoked credential cannot be re-enabled');
  equal((await review(A, retired.id, 'ignore')).status, 'ignored', 'owner may clear pending item after revocation');
  equal((await review(A, retired.id, 'ignore')).status, 'ignored', 'ignore retry is idempotent');

  // Exercise fail-closed transaction rollback by a downstream constraint, not a
  // mocked return value. The forced trigger is confined to this in-memory DB.
  await db.query('update public.accounts set is_active=true,version=version+1,last_operation_id=$2 where user_id=$1 and id=$3', [A, 'fixture-reactivate', 'account-a']);
  const secondConnection = await createConnection(A, sha('synthetic-second-credential'));
  const overlappingId = await receive(event('mixed', { hash: sha('synthetic-second-credential') }));
  equal(overlappingId.status, 'pending', 'same owner local event ID on a second connection is a separate proposal');
  equal(overlappingId.duplicate, true, 'cross-connection ID collision is flagged but never silently dropped');
  assert.notEqual(overlappingId.id, mixed.id); assertions += 1;
  equal((await receive(event('mixed', { hash: sha('synthetic-second-credential') }))).id, overlappingId.id,
    'second connection has its own stable replay identity');
  const beforeOverlapping = await txCount();
  await review(A, overlappingId.id);
  equal(await txCount(), beforeOverlapping + 1, 'explicit review of second device proposal creates a distinct record');
  const failing = await receive(event('forced-failure', { hash: sha('synthetic-second-credential') }));
  const beforeFailure = await txCount();
  await db.exec(`create function pg_temp.shortcut_test_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic downstream failure'; end $$;
    create trigger shortcut_test_failure after insert on public.transactions for each row execute function pg_temp.shortcut_test_failure();`);
  await rejects(() => review(A, failing.id), /synthetic downstream failure/, 'downstream failure aborts whole review');
  equal(await txCount(), beforeFailure, 'failed financial insert rolled back');
  equal((await one('select status from public.finance_shortcut_inbox where id=$1', [failing.id])).status, 'pending', 'failed insert does not mark imported');
  await db.exec('drop trigger shortcut_test_failure on public.transactions');
  await review(A, failing.id);
  equal(await txCount(), beforeFailure + 1, 'retry after a repaired failure posts once');
  equal((await listConnections(A)).find((row) => row.id === secondConnection.id).verified_at, null, 'unrecognized format remains unproven');

  // Separate multi-feed safety scenario with a fresh rate-window fixture. The
  // dedicated rate-limit cases below exercise both ceilings explicitly.
  await db.query('delete from finance_private.shortcut_rate_limits where user_id=$1', [A]);
  const secondHash = sha('synthetic-second-credential');
  const switchHash = sha('synthetic-switch-credential');
  const switchConnection = await createConnection(A, switchHash);
  const secondProof = await receive(strictEvent('second-proof', { hash: secondHash }));
  await review(A, secondProof.id);
  await configure(A, secondConnection.id, 'account-a', 'category-a', 'auto', true);
  const switchProof = await receive(strictEvent('switch-proof', { hash: switchHash }));
  await review(A, switchProof.id);
  await configure(A, switchConnection.id);
  await rejects(() => configure(A, switchConnection.id, 'account-a', 'category-a', 'auto', true),
    /active_auto_connection_exists/, 'second active auto feed for the same owner is rejected');
  equal((await listConnections(A)).filter((row) => row.mode === 'auto').map((row) => row.id), [secondConnection.id],
    'failed second-auto configuration retains the original feed');
  await rejects(() => db.query("update public.finance_shortcut_connections set mode='auto' where id=$1", [switchConnection.id]),
    /finance_shortcut_one_active_auto_idx/, 'partial unique index independently closes a concurrent activation race');
  const firstFeedEvent = strictEvent('same-source-event-across-feeds', { hash: secondHash });
  const firstFeedChangedEvent = strictEvent('changed-source-event-across-feeds', { hash: secondHash });
  const beforeFeedEvents = await txCount();
  const firstFeedPosted = await receive(firstFeedEvent);
  const firstFeedChangedPosted = await receive(firstFeedChangedEvent);
  equal([firstFeedPosted.status, firstFeedChangedPosted.status], ['imported', 'imported'], 'first auto feed posts its two distinct source events');
  equal(await txCount(), beforeFeedEvents + 2, 'first feed creates one ledger row per source event');
  await configure(A, secondConnection.id);
  await configure(A, switchConnection.id, 'account-a', 'category-a', 'auto', true);
  const secondFeedReplay = await receive({ ...firstFeedEvent, hash: switchHash });
  equal(secondFeedReplay.status, 'pending', 'same source event stays pending after switching the auto feed');
  equal(secondFeedReplay.duplicate, true, 'cross-feed retry is explicitly flagged');
  equal(await txCount(), beforeFeedEvents + 2, 'switching feeds cannot auto-post an already seen source event');
  equal(await one('select reason, ambiguous_of from public.finance_shortcut_inbox where id=$1', [secondFeedReplay.id]),
    { reason: 'cross_connection_duplicate', ambiguous_of: firstFeedPosted.id }, 'cross-feed proposal identifies the previous event for review');
  equal((await one('select duplicate_event from public.finance_shortcut_inbox where id=$1', [secondFeedReplay.id])).duplicate_event,
    true, 'cross-feed duplicate state is persisted independently of its optional inbox reference');
  const secondFeedChanged = await receive({ ...firstFeedChangedEvent, hash: switchHash,
    fingerprint: sha('different-payload-on-another-feed'), amount: '99.00',
    payload: { ...firstFeedChangedEvent.payload, text: 'A different synthetic purchase sharing a source-local ID' },
  });
  equal(secondFeedChanged.status, 'pending', 'different payload sharing an ID across feeds is preserved for review');
  equal(secondFeedChanged.duplicate, true, 'different cross-feed payload still signals ambiguity');
  equal((await one('select reason from public.finance_shortcut_inbox where id=$1', [secondFeedChanged.id])).reason,
    'cross_connection_duplicate', 'different cross-feed payload is never treated as a verified unique event');
  equal(await txCount(), beforeFeedEvents + 2, 'different cross-feed payload also cannot auto-create finance');
  equal((await receive({ ...firstFeedEvent, hash: switchHash })).id, secondFeedReplay.id,
    'exact replay within the new connection returns its own prior pending proposal');
  equal(await receive({ ...firstFeedEvent, hash: switchHash, fingerprint: sha('changed-within-same-feed') }),
    { error: 'event_id_payload_conflict' }, 'same-connection changed payload remains a conflict rather than a new proposal');
  const ambiguousProofHash = sha('synthetic-ambiguous-proof');
  const ambiguousProofConnection = await createConnection(A, ambiguousProofHash);
  const ambiguousProof = await receive({ ...firstFeedEvent, hash: ambiguousProofHash });
  await review(A, ambiguousProof.id);
  equal((await listConnections(A)).find((row) => row.id === ambiguousProofConnection.id).verified_at, null,
    'manual approval of a cross-feed collision cannot establish format proof');
  await rejects(() => configure(A, ambiguousProofConnection.id, 'account-a', 'category-a', 'auto', true),
    /verified_notification_required/, 'ambiguous cross-feed approval cannot unlock automatic posting');

  // Resource bounds are shared across an owner's tokens and include retries.
  await db.query(`insert into finance_private.shortcut_rate_limits values($1,date_trunc('minute',clock_timestamp()),30,date_trunc('day',clock_timestamp()),30)
    on conflict(user_id) do update set minute_start=excluded.minute_start,minute_count=30,day_start=excluded.day_start,day_count=30`, [A]);
  equal(await receive(event('rate-limit', { hash: sha('synthetic-second-credential') })), { error: 'shortcut_rate_limit' }, 'minute quota enforced with a committed denial');
  equal(Number((await one('select minute_count from finance_private.shortcut_rate_limits where user_id=$1', [A])).minute_count), 31, 'rate-limited attempt is metered');
  await db.query(`update finance_private.shortcut_rate_limits set minute_start=date_trunc('minute',clock_timestamp()),minute_count=0,
    day_start=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC',day_count=300 where user_id=$1`, [A]);
  equal(await receive(event('daily-limit', { hash: sha('synthetic-second-credential') })), { error: 'shortcut_rate_limit' }, 'daily quota enforced with a committed denial');
  equal(Number((await one('select day_count from finance_private.shortcut_rate_limits where user_id=$1', [A])).day_count), 301, 'daily-denied attempt is metered');
  for (let i = 0; i < 4; i += 1) await createConnection(B, sha(`synthetic-b-${i}`));
  await rejects(() => createConnection(B, sha('synthetic-over-limit')), /connection_limit/, 'active connection quota enforced');

  await db.query(`insert into public.finance_shortcut_inbox(user_id,connection_id,event_key,fingerprint,payload,status,reason,created_at)
    select $1,$2,'id:' || repeat(lpad(to_hex(n), 8, '0'), 8),repeat('a',64),
      '{"version":1,"source":"jkopay","title":"fixture","text":"terminal","test":false}'::jsonb,
      case when n <= 4 then 'ignored' else 'pending' end,
      case when n <= 4 then 'terminal_fixture' else 'pending_fixture' end,
      clock_timestamp() - (10001 - n) * interval '1 second' from generate_series(1,10000) n`, [B, connectionB.id]);
  const blockedByReference = await one(`select id,event_key,fingerprint from public.finance_shortcut_inbox
    where user_id=$1 and connection_id=$2 and event_key='id:' || repeat(lpad(to_hex(1), 8, '0'), 8)`, [B, connectionB.id]);
  await db.query(`update public.finance_shortcut_inbox set ambiguous_of=$3
    where user_id=$1 and connection_id=$2 and event_key='id:' || repeat(lpad(to_hex(10000), 8, '0'), 8)`,
  [B, connectionB.id, blockedByReference.id]);
  const protectedDuplicate = await one(`select id,event_key,fingerprint from public.finance_shortcut_inbox
    where user_id=$1 and connection_id=$2 and event_key='id:' || repeat(lpad(to_hex(3), 8, '0'), 8)`, [B, connectionB.id]);
  const capacityRecovery = await receive(event('inbox-quota', {
    hash: sha('synthetic-b-0'), key: protectedDuplicate.event_key, fingerprint: protectedDuplicate.fingerprint,
    payload: { version: 1, source: 'jkopay', title: 'fixture', text: 'terminal', test: false },
  }));
  equal(capacityRecovery.status, 'pending', 'capacity recovers by retaining a new unprocessed event');
  equal(capacityRecovery.duplicate, true, 'cross-connection duplicate remains reviewable during capacity recovery');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where user_id=$1', [B])).count,
    10000, 'bounded inbox capacity is restored');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where user_id=$1 and status=\'pending\'', [B])).count,
    9997, 'capacity recovery leaves all existing pending items intact and stores the new pending event');
  equal((await one('select count(*)::integer count from finance_private.shortcut_inbox_receipts where user_id=$1', [B])).count,
    1, 'one terminal row is preserved as a compact replay receipt');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where id=$1', [blockedByReference.id])).count,
    1, 'terminal row referenced by ambiguous_of is not deleted');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where id=$1', [protectedDuplicate.id])).count, 1,
  'terminal duplicate source selected by this request is not deleted before ambiguous_of is stored');
  const archivedFixture = await one(`select inbox_id,event_key,fingerprint from finance_private.shortcut_inbox_receipts
    where user_id=$1 and connection_id=$2 limit 1`, [B, connectionB.id]);
  const replayReceipt = await receive(event('archived-replay', { hash: hashB, key: archivedFixture.event_key,
    fingerprint: archivedFixture.fingerprint,
    payload: { version: 1, source: 'jkopay', title: 'fixture', text: 'terminal', test: false } }));
  equal(replayReceipt, { status: 'ignored', id: archivedFixture.inbox_id, duplicate: true, archived: true },
    'replay of an archived reviewed event remains deduplicated');
  equal(await receive(event('archived-replay-conflict', { hash: hashB, key: archivedFixture.event_key,
    fingerprint: sha('changed archived payload') })), { error: 'event_id_payload_conflict' }, 'archived replay with changed payload is rejected and metered');
  const crossConnectionReplay = await receive(strictEvent('cross-connection-archived-replay', {
    hash: sha('synthetic-b-0'), key: archivedFixture.event_key, fingerprint: archivedFixture.fingerprint,
  }));
  equal(crossConnectionReplay.duplicate, true, 'archived source ID still marks a second connection proposal as duplicate');
  equal((await one('select duplicate_event from public.finance_shortcut_inbox where id=$1', [crossConnectionReplay.id])).duplicate_event,
    true, 'archived cross-connection ambiguity is durably recorded without an active-row foreign key');
  await review(B, crossConnectionReplay.id, 'approve', 'account-b', 'category-b');
  equal((await one('select verified_at from public.finance_shortcut_connections where token_hash=$1',
    [sha('synthetic-b-0')])).verified_at, null, 'review of an archived cross-connection duplicate cannot establish parser proof');
  const secondBConnection = await one('select id from public.finance_shortcut_connections where token_hash=$1',
    [sha('synthetic-b-1')]);
  await db.query(`insert into public.finance_shortcut_inbox(user_id,connection_id,event_key,fingerprint,payload,status,reason,created_at)
    values($1,$2,$3,$4,$5,'ignored','second_connection_terminal',timestamp '2000-01-01 00:00:00+00')`,
  [B, secondBConnection.id, archivedFixture.event_key, archivedFixture.fingerprint,
    { version: 1, source: 'jkopay', title: 'fixture', text: 'terminal', test: false }]);
  const secondRecovery = await receive(event('second-recovery', { hash: hashB }));
  equal(secondRecovery.status, 'pending', 'capacity still recovers after a duplicate ID was archived on another connection');
  equal((await one(`select count(*)::integer count from finance_private.shortcut_inbox_receipts
    where user_id=$1 and event_key=$2`, [B, archivedFixture.event_key])).count,
  2, 'same owner event ID retains independent dedupe receipts for both connections');
  equal((await as('authenticated', B, 'select public.finance_shortcut_list_inbox() as result')).length, 100, 'list result is bounded to one hundred rows');
  const pendingPage = await as('authenticated', B, 'select public.finance_shortcut_list_pending($1,$2,$3) as result', [null, null, 2]);
  equal(pendingPage.pending_count, Number((await one("select count(*)::integer count from public.finance_shortcut_inbox where user_id=$1 and status='pending'", [B])).count), 'pending list reports exact backlog count across the owner inbox');
  equal(pendingPage.items.length, 2, 'pending list page is bounded');
  equal(pendingPage.has_more, true, 'pending list exposes another page');
  equal(new Date(pendingPage.items[0].created_at).getTime(), new Date((await one("select min(created_at) created_at from public.finance_shortcut_inbox where user_id=$1 and status='pending'", [B])).created_at).getTime(),
    'pending page starts with the oldest actionable row');
  const secondPendingPage = await as('authenticated', B, 'select public.finance_shortcut_list_pending($1,$2,$3) as result', [pendingPage.next_created_at, pendingPage.next_id, 2]);
  assert.ok(new Date(secondPendingPage.items[0].created_at) >= new Date(pendingPage.items.at(-1).created_at)); assertions += 1;
  await rejects(() => as('authenticated', B, 'select public.finance_shortcut_list_pending($1,$2,$3) as result', [pendingPage.next_created_at, null, 2]),
    /invalid_pending_cursor/, 'partial keyset cursor is rejected');
  const ownerAPending = await as('authenticated', A, 'select public.finance_shortcut_list_pending($1,$2,$3) as result', [null, null, 100]);
  assert.ok(ownerAPending.items.every((item) => item.connection_id !== connectionB.id), 'pending pages remain scoped to authenticated owner'); assertions += 1;
  equal((await one("select has_function_privilege('authenticated','public.finance_shortcut_list_pending(timestamp with time zone,uuid,integer)','EXECUTE') as granted")).granted, true, 'pending RPC is explicitly granted to authenticated owners');
  await db.query(`insert into public.finance_shortcut_inbox(user_id,connection_id,event_key,fingerprint,payload,status,reason,created_at)
    values($1,$2,'fixture:new-imported',repeat('b',64),'{"test":true}'::jsonb,'pending','imported_fixture',clock_timestamp() + interval '1 day'),
      ($1,$2,'fixture:new-pending-tie-a',repeat('c',64),'{"test":true}'::jsonb,'pending','pending_fixture',timestamp '2099-01-01 00:00:00+00'),
      ($1,$2,'fixture:new-imported-tie',repeat('d',64),'{"test":true}'::jsonb,'pending','imported_fixture',timestamp '2099-01-01 00:00:00+00'),
      ($1,$2,'fixture:new-pending-tie-z',repeat('e',64),'{"test":true}'::jsonb,'pending','pending_fixture',timestamp '2099-01-01 00:00:00+00')`, [B, connectionB.id]);
  await db.query(`update public.finance_shortcut_inbox set status='imported', transaction_id='synthetic-transaction'
    where user_id=$1 and connection_id=$2 and event_key='fixture:new-imported'`, [B, connectionB.id]);
  await db.query(`update public.finance_shortcut_inbox set status='imported', transaction_id='synthetic-tied-transaction'
    where user_id=$1 and connection_id=$2 and event_key='fixture:new-imported-tie'`, [B, connectionB.id]);
  await db.query(`update public.finance_shortcut_inbox set created_at=$3
    where user_id=$1 and connection_id=$2 and event_key in ('fixture:new-pending-tie-a','fixture:new-imported-tie','fixture:new-pending-tie-z')`,
  [B, connectionB.id, '2099-01-01T00:00:00Z']);
  const newestInbox = await as('authenticated', B, 'select public.finance_shortcut_list_inbox() as result');
  equal(newestInbox.length, 100, 'list remains bounded when newer results exist');
  const newestTieIds = newestInbox.slice(0, 3).map((item) => item.id);
  const repeatedInbox = await as('authenticated', B, 'select public.finance_shortcut_list_inbox() as result');
  equal(repeatedInbox.slice(0, 3).map((item) => item.id), newestTieIds, 'same-time mixed-status rows have deterministic ordering');
  equal(newestInbox.some((item) => item.reason === 'imported_fixture' && item.status === 'imported'), true,
    'newer imported result remains visible with more than one hundred older pending rows');
  const directlyRead = () => as('authenticated', A,
    'select count(*) as result from public.finance_shortcut_connections');
  await rejects(directlyRead, /permission denied/, 'table access remains unavailable outside safe RPCs');
  // Grant only innocuous columns within this test database to demonstrate the
  // RLS ownership predicate independently of the stronger production ACL.
  await db.exec('grant select(id,user_id) on public.finance_shortcut_inbox to authenticated');
  equal(await as('authenticated', A, 'select count(id)::integer as result from public.finance_shortcut_inbox where user_id=$1', [B]), 0,
    'RLS prevents reading foreign inbox even with a test-only column grant');
  await db.exec('revoke select(id,user_id) on public.finance_shortcut_inbox from authenticated');

  const intakeDef = (await one("select pg_get_functiondef('finance_private.shortcut_receive(text,text,text,jsonb,numeric,text,timestamptz,text,boolean,text)'::regprocedure) as body")).body;
  const listInboxDef = (await one("select pg_get_functiondef('finance_private.shortcut_list_inbox()'::regprocedure) as body")).body;
  const reviewDef = (await one("select pg_get_functiondef('finance_private.shortcut_review(uuid,text,text,text,numeric,text,timestamptz)'::regprocedure) as body")).body;
  const postDef = (await one("select pg_get_functiondef('finance_private.shortcut_post(uuid,text,text,numeric,text,timestamptz)'::regprocedure) as body")).body;
  assert.match(intakeDef, /pg_advisory_xact_lock[\s\S]+revoked_at is null for update/); assertions += 1;
  assert.match(intakeDef, /status in \('imported', 'ignored', 'test'\)[\s\S]+for update skip locked/); assertions += 1;
  assert.match(intakeDef, /insert into finance_private\.shortcut_inbox_receipts[\s\S]+delete from public\.finance_shortcut_inbox/); assertions += 1;
  assert.match(intakeDef, /reference_row\.ambiguous_of = finance_shortcut_inbox\.id/); assertions += 1;
  assert.match(reviewDef, /not item\.duplicate_event/); assertions += 1;
  assert.match(intakeDef, /not exists \([\s\S]+other\.fingerprint = finance_shortcut_inbox\.fingerprint/); assertions += 1;
  assert.match(listInboxDef, /order by created_at desc, id desc limit 100/); assertions += 1;
  assert.match(listInboxDef, /jsonb_agg[\s\S]+order by i\.created_at desc, i\.id desc/); assertions += 1;
  assert.match(reviewDef, /pg_advisory_xact_lock[\s\S]+for update/); assertions += 1;
  equal((postDef.match(/for share/g) ?? []).length, 2, 'both financial parents are locked against archive');
  equal((await one("select count(*)::integer count from pg_constraint where conrelid='public.finance_shortcut_inbox'::regclass and contype='u'")).count, 1, 'owner/connection/event unique constraint closes duplicate race');
  equal((await one("select to_regprocedure('public.finance_shortcut_configure(uuid,text,text,text)') is null as absent")).absent,
    true, 'old four-argument configure overload cannot bypass explicit confirmation');
  equal((await one(`select count(*)::integer count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'finance_shortcut_%' and p.prosecdef`)).count, 0, 'all public wrappers are security invoker');
  console.log(`SHORTCUT_MIGRATION_OK: ${assertions} assertions; local PGlite only; no Production writes. Concurrent lock structure verified; no multi-session concurrency claim.`);
} finally {
  await db.close();
}
