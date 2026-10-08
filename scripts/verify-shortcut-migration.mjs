import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { handleShortcutRequest } from '../supabase/functions/_shared/shortcutHandler.ts';

// In-memory PostgreSQL only: no URLs, credentials or Production connection.
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const files = (await readdir(migrationDirectory)).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
const sources = await Promise.all(files.map((name) => readFile(resolve(migrationDirectory, name), 'utf8')));
assert.ok(files.some((name) => name.endsWith('_finance_shortcut_inbox.sql')), 'shortcut migration exists');
assert.ok(files.some((name) => name.endsWith('_idempotent_shortcut_create.sql')), 'idempotent create migration exists');
const ambiguityMigrationIndex = files.findIndex((name) => name.endsWith('_shortcut_archive_ambiguity_leaves.sql'));
assert.notEqual(ambiguityMigrationIndex, -1, 'ambiguity capacity migration exists');
const ambiguityMigrationSql = sources[ambiguityMigrationIndex];
const validationMeterMigrationIndex = files.findIndex((name) => name.endsWith('_shortcut_meter_validation_failures.sql'));
assert.notEqual(validationMeterMigrationIndex, -1, 'HTTP validation quota migration exists');
const validationMeterMigrationSql = sources[validationMeterMigrationIndex];
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';
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
  // First verify the previous PR schema, then upgrade a populated 10,000-row
  // reproduction below. This tests migration safety rather than only empty DBs.
  await db.exec(sources.filter((_, index) => index !== ambiguityMigrationIndex && index !== validationMeterMigrationIndex).join('\n'));
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
  const revokedRetry = await createConnection(A, hashA);
  equal(revokedRetry.id, connection.id, 'revoked create retry resolves only to the existing revoked row');
  equal(revokedRetry.revoked_at !== null, true, 'idempotent create retry does not clear revocation');
  equal(revokedRetry.mode, 'review', 'idempotent create retry does not re-enable auto mode');
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

  // Reproduce the production-sized dead end: one no-ID root and 9,999 same
  // fingerprint arrivals, all ignored. RPCs seed the actual ambiguity shape;
  // synthetic SQL fills out the remaining equivalent arrivals without making
  // 10,000 network requests or bypassing production rate limits.
  await db.query('insert into auth.users(id) values($1),($2),($3),($4)', [C, D, E, F]);
  const hashC = sha('synthetic-ambiguity-capacity');
  const connectionC = await createConnection(C, hashC);
  const contentFingerprint = sha(JSON.stringify(['jkopay', '扣款通知',
    'Synthetic notification for database verification', null, null, null, null, false]));
  const sameContent = event('terminal-no-id-group', {
    hash: hashC, key: `fp:${contentFingerprint}`, fingerprint: contentFingerprint,
  });
  const root = await receive(sameContent);
  const leaf = await receive(sameContent);
  await review(C, root.id, 'ignore');
  await review(C, leaf.id, 'ignore');
  await db.query(`insert into public.finance_shortcut_inbox
    (user_id,connection_id,event_key,fingerprint,payload,status,reason,duplicate_event,ambiguous_of)
    select $1,$2,'amb:' || gen_random_uuid()::text,$3,$4,'ignored','ignored_by_owner',true,$5
    from generate_series(1,9998)`, [C, connectionC.id, sameContent.fingerprint, sameContent.payload, root.id]);
  equal(await one(`select count(*)::integer total, count(*) filter (where status='pending')::integer pending
    from public.finance_shortcut_inbox where user_id=$1`, [C]), { total: 10000, pending: 0 },
  'regression fixture has exactly 10,000 ignored no-ID arrivals and no pending work');
  equal((await one(`select count(*)::integer count from public.finance_shortcut_inbox i
    where i.user_id=$1 and i.status in ('imported','ignored','test')
      and not exists(select 1 from public.finance_shortcut_inbox child where child.ambiguous_of=i.id)
      and (i.event_key like 'id:%' or not exists(select 1 from public.finance_shortcut_inbox other
        where other.user_id=i.user_id and other.id<>i.id and other.fingerprint=i.fingerprint))`, [C])).count,
  0, 'old archive rules have no eligible row despite every arrival being terminal');
  const recoveryInput = event('new-after-terminal-ambiguity', { hash: hashC });
  equal(await receive(recoveryInput), { error: 'shortcut_inbox_limit' }, 'previous RPC reproduces the permanent capacity rejection');
  equal(await one('select minute_count,day_count from finance_private.shortcut_rate_limits where user_id=$1', [C]),
    { minute_count: 3, day_count: 3 }, 'reproduction is not a rate-limit denial');

  // The previous RPC could forget a lone archived fingerprint and accept a
  // later arrival under the same fp: key. Build that real pre-upgrade overlap
  // through RPCs, so recovery must preserve both arrivals instead of upserting
  // over the original receipt.
  const hashE = sha('synthetic-legacy-fingerprint-overlap');
  const connectionE = await createConnection(E, hashE);
  const legacyContent = { ...sameContent, hash: hashE };
  const legacyFirst = await receive(legacyContent);
  await review(E, legacyFirst.id, 'ignore');
  await db.query(`insert into public.finance_shortcut_inbox
    (user_id,connection_id,event_key,fingerprint,payload,status,reason)
    select $1,$2,'id:' || md5('legacy-filler-' || n::text) || md5('legacy-filler-' || n::text),$3,$4,'pending','pending_fixture'
    from generate_series(1,9999) n`, [E, connectionE.id, sha('legacy-pending-filler'), sameContent.payload]);
  const legacyReplacement = await receive(event('legacy-archive-original', { hash: hashE }));
  equal(legacyReplacement.status, 'pending', 'legacy RPC archives its lone terminal no-ID root');
  await review(E, legacyReplacement.id, 'ignore');
  const legacyLater = await receive(legacyContent);
  equal(legacyLater.duplicate, false, 'old RPC really reuses an archived fp key without its duplicate flag');
  await review(E, legacyLater.id, 'ignore');
  equal((await one(`select inbox_id from finance_private.shortcut_inbox_receipts
    where user_id=$1 and connection_id=$2 and event_key=$3`, [E, connectionE.id, legacyContent.key])).inbox_id,
  legacyFirst.id, 'legacy overlapping fixture retains the original receipt before upgrade');
  const preservedSnapshot = () => one(`select
    (select md5(string_agg(to_jsonb(i)::text,'' order by id)) from public.finance_shortcut_inbox i) inbox,
    (select md5(string_agg(concat_ws('|',inbox_id,user_id,connection_id,event_key,fingerprint,original_status,archived_at)::text,
      '' order by user_id,connection_id,event_key)) from finance_private.shortcut_inbox_receipts) receipts,
    (select md5(string_agg(to_jsonb(t)::text,'' order by user_id,id)) from public.transactions t) finance`);
  const beforeUpgrade = await preservedSnapshot();
  await db.exec(ambiguityMigrationSql);
  equal(await preservedSnapshot(), beforeUpgrade, 'populated upgrade preserves every inbox, replay key and financial row');
  await db.exec(ambiguityMigrationSql);
  equal(await preservedSnapshot(), beforeUpgrade, 'migration reapplication is idempotent on populated data');
  equal((await one(`select count(*)::integer count from finance_private.shortcut_inbox_receipts
    where user_id=$1 and ambiguous_of is null and duplicate_event is null`, [B])).count,
  Number((await one('select count(*)::integer count from finance_private.shortcut_inbox_receipts where user_id=$1', [B])).count),
  'upgrade preserves old receipts without inventing historical ambiguity flags');
  await db.exec(`create function pg_temp.fail_shortcut_insert() returns trigger language plpgsql as $$
    begin raise exception 'synthetic intake insert failure'; end $$;
    create trigger fail_shortcut_insert before insert on public.finance_shortcut_inbox
    for each row execute function pg_temp.fail_shortcut_insert();`);
  await rejects(() => receive(recoveryInput), /synthetic intake insert failure/, 'downstream intake failure aborts archive and insert together');
  equal(await preservedSnapshot(), beforeUpgrade, 'failed intake rolls back receipt creation and terminal deletion');
  await db.exec('drop trigger fail_shortcut_insert on public.finance_shortcut_inbox');
  const beforeAmbiguityCapacity = await txCount();
  const recoveredNewEvent = await receive(recoveryInput);
  equal(recoveredNewEvent.status, 'pending', 'terminal ambiguity leaves allow a new event to recover capacity');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where user_id=$1', [C])).count,
    10000, 'duplicate-only inbox remains bounded after capacity recovery');
  equal((await one(`select count(*)::integer count from finance_private.shortcut_inbox_receipts
    where user_id=$1 and fingerprint=$2`, [C, sameContent.fingerprint])).count, 1,
  'one ambiguity leaf is retained as a permanent receipt');
  equal(await one(`select ambiguous_of,duplicate_event,original_status from finance_private.shortcut_inbox_receipts
    where user_id=$1 and fingerprint=$2`, [C, sameContent.fingerprint]),
  { ambiguous_of: root.id, duplicate_event: true, original_status: 'ignored' },
  'archive retains the leaf parent, duplicate flag, and reviewed outcome');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where id=$1', [root.id])).count,
    1, 'root remains available for all existing and newly pending references');
  const recoveredSameContent = await receive(sameContent);
  equal(recoveredSameContent.status, 'pending', 'repeated no-ID content remains a distinct reviewable arrival');
  equal(recoveredSameContent.duplicate, true, 'recovery does not forget the duplicate content');
  equal(await txCount(), beforeAmbiguityCapacity, 'capacity recovery never changes financial rows');
  const recoveredLegacy = await receive(event('legacy-overlap-recovery', { hash: hashE }));
  equal(recoveredLegacy.status, 'pending', 'capacity recovers even with an overlapping legacy fp receipt');
  equal((await one(`select count(*)::integer count from finance_private.shortcut_inbox_receipts
    where user_id=$1 and fingerprint=$2 and inbox_id=any($3::uuid[])`,
  [E, contentFingerprint, [legacyFirst.id, legacyLater.id]])).count,
  2, 'both distinct no-ID arrivals keep permanent receipts instead of overwriting evidence');
  equal(await one(`select event_key,original_event_key from finance_private.shortcut_inbox_receipts where inbox_id=$1`,
    [legacyLater.id]), { event_key: `amb:${legacyLater.id}`, original_event_key: legacyContent.key },
  'per-arrival archive key retains the original reused event key as evidence');

  // A 10,000-row fixture with a cross-connection root, a terminal middle/leaf
  // chain, and a pending child. Archive leaves before their parents; preserve
  // the pending child and its root until the owner explicitly ignores it.
  const hashD = sha('synthetic-ambiguity-chain-a');
  const hashD2 = sha('synthetic-ambiguity-chain-b');
  const connectionD = await createConnection(D, hashD);
  const connectionD2 = await createConnection(D, hashD2);
  const groupKey = `id:${sha('synthetic-cross-connection-chain')}`;
  const groupFingerprint = sha('synthetic-chain-payload');
  const chainRoot = await one(`insert into public.finance_shortcut_inbox
    (user_id,connection_id,event_key,fingerprint,payload,status,reason,created_at)
    values($1,$2,$3,$4,$5,'ignored','ignored_by_owner','2000-01-01') returning id`,
  [D, connectionD.id, groupKey, groupFingerprint, sameContent.payload]);
  const chainMiddle = await one(`insert into public.finance_shortcut_inbox
    (user_id,connection_id,event_key,fingerprint,payload,status,reason,duplicate_event,ambiguous_of,created_at)
    values($1,$2,$3,$4,$5,'ignored','ignored_by_owner',true,$6,'2000-01-02') returning id`,
  [D, connectionD2.id, groupKey, groupFingerprint, sameContent.payload, chainRoot.id]);
  const chainLeaf = await one(`insert into public.finance_shortcut_inbox
    (user_id,connection_id,event_key,fingerprint,payload,status,reason,duplicate_event,ambiguous_of,created_at)
    values($1,$2,'amb:' || gen_random_uuid()::text,$3,$4,'ignored','ignored_by_owner',true,$5,'2000-01-03') returning id`,
  [D, connectionD2.id, groupFingerprint, sameContent.payload, chainMiddle.id]);
  const pendingChild = await one(`insert into public.finance_shortcut_inbox
    (user_id,connection_id,event_key,fingerprint,payload,status,reason,duplicate_event,ambiguous_of,created_at)
    values($1,$2,'amb:' || gen_random_uuid()::text,$3,$4,'pending','possible_duplicate',true,$5,'2000-01-04') returning id`,
  [D, connectionD.id, groupFingerprint, sameContent.payload, chainRoot.id]);
  await db.query(`insert into public.finance_shortcut_inbox
    (user_id,connection_id,event_key,fingerprint,payload,status,reason)
    select $1,$2,'id:' || md5('chain-filler-' || n::text) || md5('chain-filler-' || n::text),$3,$4,'pending','pending_fixture'
    from generate_series(1,9996) n`, [D, connectionD.id, sha('pending-chain-filler'), sameContent.payload]);
  for (const [seed, expectedArchived] of [['peel-leaf', chainLeaf.id], ['peel-middle', chainMiddle.id]]) {
    equal((await receive(event(seed, { hash: hashD }))).status, 'pending', 'terminal chain frees one slot per receive');
    equal((await one('select count(*)::integer count from finance_private.shortcut_inbox_receipts where inbox_id=$1',
      [expectedArchived])).count, 1, 'chain is archived from leaves toward the root');
  }
  equal(await receive(event('pending-reference-protects-root', { hash: hashD })), { error: 'shortcut_inbox_limit' },
    'backpressure preserves a terminal root referenced by pending work');
  equal((await one('select status,ambiguous_of from public.finance_shortcut_inbox where id=$1', [pendingChild.id])),
    { status: 'pending', ambiguous_of: chainRoot.id }, 'pending child and its comparison reference are untouched');
  await review(D, pendingChild.id, 'ignore');
  equal((await receive(event('peel-reviewed-child', { hash: hashD }))).status, 'pending', 'reviewed child can now be archived');
  equal((await receive(event('peel-final-root', { hash: hashD }))).status, 'pending', 'final terminal root can be archived after all its children');
  equal((await one(`select count(*)::integer count from finance_private.shortcut_inbox_receipts
    where user_id=$1 and inbox_id=any($2::uuid[])`, [D, [chainRoot.id, chainMiddle.id, chainLeaf.id, pendingChild.id]])).count,
    4, 'every row of the terminal chain is retained as evidence');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where user_id=$1', [D])).count,
    10000, 'chain recovery retains all 9,996 unrelated pending items and four new pending arrivals');
  equal(await receive(event('archived-chain-replay', { hash: hashD, key: groupKey, fingerprint: groupFingerprint })),
    { status: 'ignored', id: chainRoot.id, duplicate: true, archived: true }, 'archived chain root still deduplicates a stable ID');
  equal(await receive(event('archived-chain-other-connection', { hash: hashD2, key: groupKey, fingerprint: groupFingerprint })),
    { status: 'ignored', id: chainMiddle.id, duplicate: true, archived: true }, 'cross-connection stable ID history remains independently deduplicated');
  const replayContentAfterArchive = await receive(event('no-id-after-chain-archive', {
    hash: hashD2, key: `fp:${groupFingerprint}`, fingerprint: groupFingerprint,
  }));
  equal(replayContentAfterArchive, { error: 'shortcut_inbox_limit' }, 'all-pending inbox still refuses to discard pending work');
  const pendingReplacement = await one(`select id from public.finance_shortcut_inbox
    where user_id=$1 and event_key=$2`, [D, event('peel-final-root').key]);
  await review(D, pendingReplacement.id, 'ignore');
  const recoveredArchivedContent = await receive(event('no-id-after-chain-archive', {
    hash: hashD2, key: `fp:${groupFingerprint}`, fingerprint: groupFingerprint,
  }));
  equal(recoveredArchivedContent.status, 'pending', 'ignoring one pending replacement restores a slot');
  equal(recoveredArchivedContent.duplicate, true, 'no-ID duplicate detection includes archived fingerprint receipts');
  equal(await one('select reason,duplicate_event,ambiguous_of from public.finance_shortcut_inbox where id=$1',
    [recoveredArchivedContent.id]), { reason: 'possible_duplicate', duplicate_event: true, ambiguous_of: null },
  'archived duplicate remains reviewable without a dangling foreign key');
  equal((await one(`select count(*)::integer count from finance_private.shortcut_inbox_receipts
    where user_id=$1 and ambiguous_of=any($2::uuid[]) and duplicate_event`,
  [D, [chainRoot.id, chainMiddle.id]])).count, 3, 'all archived chain edges and duplicate flags remain available');
  const hashF = sha('synthetic-receipt-owner-isolation');
  await createConnection(F, hashF);
  const otherOwnerArrival = await receive(event('other-owner-archived-content', {
    hash: hashF, key: `fp:${groupFingerprint}`, fingerprint: groupFingerprint,
  }));
  equal(otherOwnerArrival.duplicate, false, 'another owner archived fingerprint cannot mark an arrival duplicate');
  const hashE2 = sha('synthetic-receipt-connection-isolation');
  await createConnection(E, hashE2);
  await review(E, recoveredLegacy.id, 'ignore');
  const otherConnectionArrival = await receive({ ...legacyContent, hash: hashE2 });
  equal(otherConnectionArrival.status, 'pending', 'another connection fingerprint arrival remains reviewable at capacity');
  equal(otherConnectionArrival.duplicate, false, 'same-owner receipts from another connection cannot mark no-ID content duplicate');
  equal(await txCount(), beforeAmbiguityCapacity, 'isolated duplicate checks leave financial data unchanged');
  await rejects(() => receive(event('new-migration-owner-intake'), 'authenticated', A), /permission denied/,
    'updated intake remains inaccessible to authenticated Data API users');
  await rejects(() => receive(event('new-migration-anonymous-intake'), 'anon', null), /permission denied/,
    'updated intake remains inaccessible to anonymous Data API users');
  equal((await one(`select has_table_privilege('authenticated','finance_private.shortcut_inbox_receipts','SELECT') granted`)).granted,
    false, 'new receipt evidence does not gain client table access');

  const intakeDef = (await one("select pg_get_functiondef('finance_private.shortcut_receive(text,text,text,jsonb,numeric,text,timestamptz,text,boolean,text)'::regprocedure) as body")).body;
  const listInboxDef = (await one("select pg_get_functiondef('finance_private.shortcut_list_inbox()'::regprocedure) as body")).body;
  const reviewDef = (await one("select pg_get_functiondef('finance_private.shortcut_review(uuid,text,text,text,numeric,text,timestamptz)'::regprocedure) as body")).body;
  const postDef = (await one("select pg_get_functiondef('finance_private.shortcut_post(uuid,text,text,numeric,text,timestamptz)'::regprocedure) as body")).body;
  assert.match(intakeDef, /pg_advisory_xact_lock[\s\S]+revoked_at is null for update/); assertions += 1;
  assert.match(intakeDef, /status in \('imported', 'ignored', 'test'\)[\s\S]+for update skip locked/); assertions += 1;
  assert.match(intakeDef, /insert into finance_private\.shortcut_inbox_receipts[\s\S]+delete from public\.finance_shortcut_inbox/); assertions += 1;
  assert.match(intakeDef, /reference_row\.ambiguous_of = finance_shortcut_inbox\.id/); assertions += 1;
  assert.match(reviewDef, /not item\.duplicate_event/); assertions += 1;
  assert.match(intakeDef, /perform 1 from finance_private\.shortcut_inbox_receipts[\s\S]+fingerprint = p_fingerprint/); assertions += 1;
  assert.doesNotMatch(intakeDef, /other\.fingerprint = finance_shortcut_inbox\.fingerprint/); assertions += 1;
  assert.match(listInboxDef, /order by created_at desc, id desc limit 100/); assertions += 1;
  assert.match(listInboxDef, /jsonb_agg[\s\S]+order by i\.created_at desc, i\.id desc/); assertions += 1;
  assert.match(reviewDef, /pg_advisory_xact_lock[\s\S]+for update/); assertions += 1;
  equal((postDef.match(/for share/g) ?? []).length, 2, 'both financial parents are locked against archive');
  equal((await one("select count(*)::integer count from pg_constraint where conrelid='public.finance_shortcut_inbox'::regclass and contype='u'")).count, 1, 'owner/connection/event unique constraint closes duplicate race');
  equal((await one("select to_regprocedure('public.finance_shortcut_configure(uuid,text,text,text)') is null as absent")).absent,
    true, 'old four-argument configure overload cannot bypass explicit confirmation');

  // Upgrade the populated database without changing the previous capacity RPC
  // or retaining validation bodies. Exercise the real HTTP handler against the
  // local PostgreSQL RPCs instead of using a mocked quota counter.
  const beforeMeterUpgrade = await preservedSnapshot();
  const beforeMeterMetadata = await one(`select
    (select md5(string_agg(to_jsonb(c)::text,'' order by id)) from public.finance_shortcut_connections c) connections,
    (select md5(string_agg(to_jsonb(r)::text,'' order by user_id)) from finance_private.shortcut_rate_limits r) rates`);
  await db.exec(validationMeterMigrationSql);
  await db.exec(validationMeterMigrationSql);
  equal(await preservedSnapshot(), beforeMeterUpgrade, 'validation meter upgrade/reapplication preserves inbox, receipts and financial rows');
  equal(await one(`select
    (select md5(string_agg(to_jsonb(c)::text,'' order by id)) from public.finance_shortcut_connections c) connections,
    (select md5(string_agg(to_jsonb(r)::text,'' order by user_id)) from finance_private.shortcut_rate_limits r) rates`),
  beforeMeterMetadata, 'validation meter upgrade/reapplication preserves credentials, connection limits and quotas');
  equal((await one("select pg_get_functiondef('finance_private.shortcut_receive(text,text,text,jsonb,numeric,text,timestamptz,text,boolean,text)'::regprocedure) as body")).body,
    intakeDef, 'validation migration preserves the existing ambiguity capacity fix exactly');
  equal(await one(`select
    has_function_privilege('anon','public.finance_shortcut_meter_rejection(text)','EXECUTE') anon,
    has_function_privilege('authenticated','public.finance_shortcut_meter_rejection(text)','EXECUTE') owner,
    has_function_privilege('service_role','public.finance_shortcut_meter_rejection(text)','EXECUTE') service,
    has_function_privilege('anon','finance_private.shortcut_meter_rejection(text)','EXECUTE') private_anon,
    has_function_privilege('authenticated','finance_private.shortcut_meter_rejection(text)','EXECUTE') private_owner,
    has_function_privilege('service_role','finance_private.shortcut_meter_rejection(text)','EXECUTE') private_service`),
  { anon: false, owner: false, service: true, private_anon: false, private_owner: false, private_service: true },
  'public/private validation meter functions are service-only despite permissive default grants');

  const G = '77777777-7777-4777-8777-777777777777';
  const H = '88888888-8888-4888-8888-888888888888';
  await db.query('insert into auth.users(id) values($1),($2)', [G, H]);
  const tokenG = `shiba_sc_${'b'.repeat(64)}`;
  const tokenG2 = `shiba_sc_${'c'.repeat(64)}`;
  const tokenG3 = `shiba_sc_${'d'.repeat(64)}`;
  const tokenH = `shiba_sc_${'e'.repeat(64)}`;
  const connectionG = await createConnection(G, sha(tokenG));
  await createConnection(G, sha(tokenG2));
  const connectionG3 = await createConnection(G, sha(tokenG3));
  const connectionH = await createConnection(H, sha(tokenH));
  const meter = (hash, role = 'service_role', owner = null) => as(role, owner,
    'select public.finance_shortcut_meter_rejection($1) as result', [hash]);
  const quota = (owner) => one('select minute_count,day_count from finance_private.shortcut_rate_limits where user_id=$1', [owner]);
  const resetQuota = (owner, minuteCount = 0, dayCount = 0) => db.query(`
    insert into finance_private.shortcut_rate_limits(user_id,minute_start,minute_count,day_start,day_count)
    values($1,date_trunc('minute',clock_timestamp()),$2,date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC',$3)
    on conflict(user_id) do update set minute_start=excluded.minute_start,minute_count=excluded.minute_count,
      day_start=excluded.day_start,day_count=excluded.day_count`, [owner, minuteCount, dayCount]);
  async function rpcResult(action) {
    try { return { data: await action(), error: null }; }
    catch (error) { return { data: null, error: { code: error.code } }; }
  }
  function httpDependencies(afterAuthentication = null) {
    const calls = { authenticate: 0, meter: 0, receive: 0 };
    return {
      calls,
      authenticate: async (hash) => {
        calls.authenticate += 1;
        const result = await rpcResult(() => as('service_role', null,
          'select public.finance_shortcut_authenticate($1) as result', [hash]));
        if (afterAuthentication && result.data === true) await afterAuthentication(hash);
        return result;
      },
      meterRejection: async (hash) => { calls.meter += 1; return rpcResult(() => meter(hash)); },
      receive: async (p) => {
        calls.receive += 1;
        return rpcResult(() => as('service_role', null,
          'select public.finance_shortcut_receive($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',
          [p.p_token_hash,p.p_event_key,p.p_fingerprint,p.p_payload,p.p_amount,p.p_merchant,
            p.p_occurred_at,p.p_format,p.p_auto_eligible,p.p_reason]));
      },
    };
  }
  function httpRequest(token, body = '{', mime = 'application/json', extraHeaders = {}) {
    return new Request('https://example.invalid/synthetic-shortcut', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': mime, ...extraHeaders }, body,
    });
  }
  const validHttpBody = JSON.stringify({ version: 1, source: 'jkopay', title: 'Synthetic',
    text: 'Synthetic HTTP to local PostgreSQL verification', test: false, eventId: 'synthetic-http-event' });
  const httpDeps = httpDependencies();
  const beforeHttpFinancialCount = await txCount();
  const beforeHttpInboxCount = Number((await one('select count(*)::integer count from public.finance_shortcut_inbox')).count);
  for (const [body, mime, extraHeaders, expectedStatus] of [
    ['{', 'application/json', {}, 400],
    ['{}', 'application/json', {}, 400],
    [new Uint8Array([255]), 'application/json', {}, 400],
    ['x', 'application/json', { 'content-length': '8193' }, 413],
    ['x'.repeat(8193), 'application/json', {}, 413],
    ['Synthetic non-JSON body', 'text/plain', {}, 415],
  ]) {
    const res = await handleShortcutRequest(httpRequest(tokenG, body, mime, extraHeaders), httpDeps);
    equal(res.status, expectedStatus, 'actual authenticated HTTP validation failure retains its status below quota');
    equal(await res.json(), { error: expectedStatus === 415 ? 'json_content_type_required' : 'invalid_shortcut_payload' },
      'validation response contains no body, owner or credential data');
  }
  equal(await quota(G), { minute_count: 6, day_count: 6 }, 'six actual HTTP validation failures commit six shared quota charges');
  equal(httpDeps.calls, { authenticate: 6, meter: 6, receive: 0 }, 'HTTP validation failures call only the hash-only rejection RPC');
  equal(Number((await one('select count(*)::integer count from public.finance_shortcut_inbox')).count), beforeHttpInboxCount,
    'authenticated invalid HTTP bodies create no inbox rows');
  equal(await txCount(), beforeHttpFinancialCount, 'authenticated invalid HTTP bodies create no financial rows');

  const normalResponse = await handleShortcutRequest(httpRequest(tokenG, validHttpBody), httpDeps);
  equal(normalResponse.status, 200, 'normal HTTP intake still succeeds');
  const normalResult = await normalResponse.json();
  equal(await quota(G), { minute_count: 7, day_count: 7 }, 'normal HTTP intake increments shared quota exactly once');
  equal(httpDeps.calls.meter, 6, 'normal HTTP intake does not double-charge via rejection meter');
  const replayResponse = await handleShortcutRequest(httpRequest(tokenG, validHttpBody), httpDeps);
  equal(await replayResponse.json(), { status: 'pending', id: normalResult.id, duplicate: true }, 'normal HTTP replay remains idempotent');
  equal(await quota(G), { minute_count: 8, day_count: 8 }, 'normal replay is charged exactly once');
  const conflictResponse = await handleShortcutRequest(httpRequest(tokenG, validHttpBody.replace('verification', 'conflict')), httpDeps);
  equal(conflictResponse.status, 409, 'normal HTTP payload conflict keeps its status');
  equal(await quota(G), { minute_count: 9, day_count: 9 }, 'committed normal conflict is charged exactly once');
  equal(httpDeps.calls.meter, 6, 'replay and conflict use the existing receive quota path');

  // A database constraint failure aborts the complete receive statement. The
  // handler's new validation meter restores exactly one committed charge.
  await db.exec(`create function pg_temp.reject_shortcut_validation() returns trigger language plpgsql as $$
    begin raise exception 'synthetic constraint validation failure' using errcode='23514'; end $$;
    create trigger reject_shortcut_validation before insert on public.finance_shortcut_inbox
      for each row execute function pg_temp.reject_shortcut_validation();`);
  const sqlFailure = await handleShortcutRequest(httpRequest(tokenG, validHttpBody.replace('synthetic-http-event', 'synthetic-sql-failure')), httpDeps);
  await db.exec('drop trigger reject_shortcut_validation on public.finance_shortcut_inbox');
  equal(sqlFailure.status, 400, 'HTTP SQL validation failure stays a sanitized 400');
  equal(await quota(G), { minute_count: 10, day_count: 10 }, 'rolled-back SQL validation failure receives exactly one committed replacement charge');
  equal(Number((await one('select count(*)::integer count from public.finance_shortcut_inbox where user_id=$1', [G])).count), 1,
    'failed SQL validation leaves only the one previously accepted event');

  const parallelFailures = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    handleShortcutRequest(httpRequest(index % 2 ? tokenG2 : tokenG), httpDeps)));
  equal(parallelFailures.map((res) => res.status), Array(20).fill(400), 'interleaved malformed HTTP requests from both connections exhaust one owner quota');
  equal(await quota(G), { minute_count: 30, day_count: 30 }, 'shared owner row records every interleaved failure without lost or double charges');
  for (const [body, mime] of [['{', 'application/json'], ['x'.repeat(8193), 'application/json'], ['Synthetic', 'text/plain']]) {
    const res = await handleShortcutRequest(httpRequest(tokenG2, body, mime), httpDeps);
    equal(res.status, 429, 'malformed, oversize and MIME failures become 429 after shared quota drains');
    equal(await res.json(), { error: 'shortcut_limit_reached' }, 'quota denial is sanitized');
  }
  equal(await quota(G), { minute_count: 31, day_count: 33 }, 'denied malformed attempts commit bounded quota counts');
  const limitedNormal = await handleShortcutRequest(httpRequest(tokenG, validHttpBody), httpDeps);
  equal(limitedNormal.status, 429, 'malformed HTTP traffic drains quota used by normal intake');
  equal(await quota(G), { minute_count: 32, day_count: 34 }, 'denied normal receive keeps its existing single quota charge');
  equal((await handleShortcutRequest(httpRequest(tokenH), httpDeps)).status, 400, 'another owner retains independent quota');
  equal(await quota(H), { minute_count: 1, day_count: 1 }, 'another owner has only its own validation charge');

  await resetQuota(G, 0, 300);
  equal((await handleShortcutRequest(httpRequest(tokenG), httpDeps)).status, 429, 'daily quota also applies to malformed HTTP');
  equal(await quota(G), { minute_count: 1, day_count: 301 }, 'daily denial commits its threshold charge');
  equal(await meter(sha(tokenG2)), { error: 'shortcut_rate_limit' }, 'another same-owner connection cannot bypass daily denial');
  equal(await quota(G), { minute_count: 2, day_count: 301 }, 'daily validation counter saturates rather than growing forever');
  await resetQuota(G, 2147483647, 2147483647);
  equal(await meter(sha(tokenG)), { error: 'shortcut_rate_limit' }, 'legacy maximal integer counts deny safely without overflow');
  equal(await quota(G), { minute_count: 31, day_count: 301 }, 'maximal counters are safely bounded at denial sentinels');
  await db.query("update finance_private.shortcut_rate_limits set minute_start='2000-01-01',day_start='2000-01-01' where user_id=$1", [G]);
  equal(await meter(sha(tokenG2)), { status: 'metered' }, 'new minute/UTC-day windows reset saturated counters');
  equal(await quota(G), { minute_count: 1, day_count: 1 }, 'new time windows start at one charge');

  const beforeRevocationQuota = await quota(H);
  const revokeRaceDeps = httpDependencies(async () => {
    await as('authenticated', H, 'select public.finance_shortcut_revoke($1) as result', [connectionH.id]);
  });
  const revokedFailure = await handleShortcutRequest(httpRequest(tokenH), revokeRaceDeps);
  equal(revokedFailure.status, 401, 'revocation between preliminary auth and validation meter wins');
  equal(await revokedFailure.json(), { error: 'invalid_shortcut_token' }, 'revocation race response reveals no owner or credential');
  equal(revokeRaceDeps.calls, { authenticate: 1, meter: 1, receive: 0 }, 'validation race reaches only the locked rejection meter');
  equal(await quota(H), beforeRevocationQuota, 'revoked validation request cannot mutate quota');
  const normalRaceDeps = httpDependencies(async () => {
    await as('authenticated', G, 'select public.finance_shortcut_revoke($1) as result', [connectionG3.id]);
  });
  equal((await handleShortcutRequest(httpRequest(tokenG3, validHttpBody), normalRaceDeps)).status, 401,
    'revocation between preliminary auth and normal receive still wins');
  equal(normalRaceDeps.calls, { authenticate: 1, meter: 0, receive: 1 }, 'normal revocation race never uses rejection meter');
  equal(await quota(G), { minute_count: 1, day_count: 1 }, 'revoked normal receive leaves quota unchanged');
  const invalidDeps = httpDependencies();
  for (const invalidToken of [tokenH, `shiba_sc_${'f'.repeat(64)}`]) {
    equal((await handleShortcutRequest(httpRequest(invalidToken), invalidDeps)).status, 401, 'already revoked and unknown tokens stay 401');
  }
  equal(invalidDeps.calls, { authenticate: 2, meter: 0, receive: 0 }, 'unauthorized credentials consume no owner quota');

  for (const invalidHash of [null, '', 'A'.repeat(64), 'a'.repeat(65), sha('synthetic-unknown-rejection-hash'), sha(tokenH)]) {
    await rejects(() => meter(invalidHash), /invalid_shortcut_token/, 'invalid/unknown/revoked hash fails closed before metering');
  }
  equal(await quota(G), { minute_count: 1, day_count: 1 }, 'invalid hash probes cannot charge another owner');
  equal(await quota(H), beforeRevocationQuota, 'invalid hash probes cannot charge revoked owner');
  await rejects(() => meter(sha(tokenG), 'authenticated', G), /permission denied/, 'owner cannot directly call rejection meter');
  await rejects(() => meter(sha(tokenG), 'anon'), /permission denied/, 'anonymous caller cannot directly call rejection meter');
  equal((await one("select pg_get_function_arguments('public.finance_shortcut_meter_rejection(text)'::regprocedure) arguments")).arguments,
    'p_token_hash text', 'meter RPC accepts only the fixed-size hash with no payload or owner arguments');
  const meterDef = (await one("select pg_get_functiondef('finance_private.shortcut_meter_rejection(text)'::regprocedure) body")).body;
  assert.match(meterDef, /pg_advisory_xact_lock[\s\S]+revoked_at is null for update/); assertions += 1;
  assert.match(meterDef, /least\(shortcut_rate_limits.minute_count, 30\) \+ 1/); assertions += 1;
  assert.match(meterDef, /least\(shortcut_rate_limits.day_count, 300\) \+ 1/); assertions += 1;
  assert.doesNotMatch(meterDef, /insert into public\.finance_shortcut_inbox|update public\.finance_shortcut_connections|p_payload/); assertions += 1;
  equal(await txCount(), beforeHttpFinancialCount, 'validation metering and revocation tests leave all financial rows unchanged');
  equal((await one('select count(*)::integer count from public.finance_shortcut_inbox where user_id=$1 and connection_id=$2',
    [G, connectionG.id])).count, 1, 'only accepted normal intake stores a body; malformed traffic never does');
  const createDef = (await one("select pg_get_functiondef('finance_private.shortcut_create(text,text)'::regprocedure) body")).body;
  assert.match(createDef, /user_id = owner_id\) >= 100/); assertions += 1;
  equal((await one(`select count(*)::integer count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'finance_shortcut_%' and p.prosecdef`)).count, 0, 'all public wrappers are security invoker');
  console.log(`SHORTCUT_MIGRATION_OK: ${assertions} assertions; local PGlite only; no Production writes. Concurrent lock structure verified; no multi-session concurrency claim.`);
} finally {
  await db.close();
}
