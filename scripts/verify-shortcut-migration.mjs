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
const shortcutSql = sources[files.findIndex((name) => name.endsWith('_finance_shortcut_inbox.sql'))];
assert.ok(shortcutSql, 'shortcut migration exists');
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
const configure = (owner, id, account = 'account-a', category = 'category-a', mode = 'review') => as('authenticated', owner,
  'select public.finance_shortcut_configure($1, $2, $3, $4) as result', [id, account, category, mode]);
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
  await db.exec(shortcutSql);
  equal((await one("select count(*)::integer count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'finance_shortcut_%' and c.relkind='r' and c.relrowsecurity")).count, 2, 'both public tables have RLS after retry');
  const permissions = await one(`select
    has_table_privilege('authenticated','public.finance_shortcut_connections','SELECT') as direct_connection_read,
    has_column_privilege('authenticated','public.finance_shortcut_connections','token_hash','SELECT') as token_hash_read,
    has_table_privilege('authenticated','public.finance_shortcut_inbox','INSERT') as direct_inbox_insert,
    has_function_privilege('anon','public.finance_shortcut_create(text,text)','EXECUTE') as anonymous_create,
    has_function_privilege('authenticated','public.finance_shortcut_authenticate(text)','EXECUTE') as owner_authenticate,
    has_function_privilege('service_role','public.finance_shortcut_authenticate(text)','EXECUTE') as service_authenticate,
    has_function_privilege('authenticated','finance_private.shortcut_post(uuid,text,text,numeric,text,timestamp with time zone)','EXECUTE') as direct_post`);
  equal(permissions, { direct_connection_read: false, token_hash_read: false, direct_inbox_insert: false,
    anonymous_create: false, owner_authenticate: false, service_authenticate: true, direct_post: false }, 'least privilege grants');

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
  const connectionB = await createConnection(B, hashB);
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
  const proof = await receive(strictEvent('proof'));
  await review(A, proof.id);
  equal((await listConnections(A))[0].verified_format, 'jkopay-single-debit-v1', 'real matching approval records exact parser version');
  await configure(A, connection.id, 'account-a', 'category-a', 'auto');
  const beforeAuto = await txCount();
  const auto = await receive(strictEvent('auto-1'));
  equal(auto.status, 'imported', 'proven format plus stable ID can auto post');
  equal(await txCount(), beforeAuto + 1, 'auto creates exactly one row');
  equal((await receive(strictEvent('auto-1'))).duplicate, true, 'auto retry remains idempotent');
  equal(await txCount(), beforeAuto + 1, 'auto retry does not create another row');
  await rejects(() => receive(strictEvent('auto-1', { fingerprint: sha('different-body') })), /event_id_payload_conflict/, 'same source ID with changed payload is rejected');

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
  equal(overlappingId.duplicate, false, 'device-local ID is not silently deduped across connections');
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

  // Resource bounds are shared across an owner's tokens and include retries.
  await db.query(`insert into finance_private.shortcut_rate_limits values($1,date_trunc('minute',clock_timestamp()),30,date_trunc('day',clock_timestamp()),30)
    on conflict(user_id) do update set minute_start=excluded.minute_start,minute_count=30,day_start=excluded.day_start,day_count=30`, [A]);
  await rejects(() => receive(event('rate-limit', { hash: sha('synthetic-second-credential') })), /shortcut_rate_limit/, 'minute quota enforced');
  await db.query(`update finance_private.shortcut_rate_limits set minute_start=date_trunc('minute',clock_timestamp()),minute_count=0,
    day_start=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC',day_count=300 where user_id=$1`, [A]);
  await rejects(() => receive(event('daily-limit', { hash: sha('synthetic-second-credential') })), /shortcut_rate_limit/, 'daily quota enforced');
  for (let i = 0; i < 4; i += 1) await createConnection(B, sha(`synthetic-b-${i}`));
  await rejects(() => createConnection(B, sha('synthetic-over-limit')), /connection_limit/, 'active connection quota enforced');

  await db.query(`insert into public.finance_shortcut_inbox(user_id,connection_id,event_key,fingerprint,payload,status,reason)
    select $1,$2,'fixture:' || n,repeat('a',64),'{"test":true}'::jsonb,'test','test_only' from generate_series(1,10000) n`, [B, connectionB.id]);
  await rejects(() => receive(event('inbox-quota', { hash: hashB })), /shortcut_inbox_limit/, 'inbox quota includes retained tests and history');
  equal((await as('authenticated', B, 'select public.finance_shortcut_list_inbox() as result')).length, 100, 'list result is bounded to one hundred rows');
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
  const reviewDef = (await one("select pg_get_functiondef('finance_private.shortcut_review(uuid,text,text,text,numeric,text,timestamptz)'::regprocedure) as body")).body;
  const postDef = (await one("select pg_get_functiondef('finance_private.shortcut_post(uuid,text,text,numeric,text,timestamptz)'::regprocedure) as body")).body;
  assert.match(intakeDef, /pg_advisory_xact_lock[\s\S]+revoked_at is null for update/); assertions += 1;
  assert.match(reviewDef, /pg_advisory_xact_lock[\s\S]+for update/); assertions += 1;
  equal((postDef.match(/for share/g) ?? []).length, 2, 'both financial parents are locked against archive');
  equal((await one("select count(*)::integer count from pg_constraint where conrelid='public.finance_shortcut_inbox'::regclass and contype='u'")).count, 1, 'owner/connection/event unique constraint closes duplicate race');
  equal((await one(`select count(*)::integer count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'finance_shortcut_%' and p.prosecdef`)).count, 0, 'all public wrappers are security invoker');
  console.log(`SHORTCUT_MIGRATION_OK: ${assertions} assertions; local PGlite only; no Production writes. Concurrent lock structure verified; no multi-session concurrency claim.`);
} finally {
  await db.close();
}
