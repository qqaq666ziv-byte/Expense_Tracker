import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(
  scriptDirectory,
  '..',
  'supabase',
  'migrations',
);
const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const migrationSources = await Promise.all(
  migrationFiles.map((name) => readFile(resolve(migrationDirectory, name), 'utf8')),
);
const migrationSql = migrationSources.join('\n\n');
const cloudConsistencyMigrationIndex = migrationFiles.findIndex((name) => (
  name.endsWith('_finance_cloud_consistency.sql')
));
assert.notEqual(
  cloudConsistencyMigrationIndex,
  -1,
  'Expected an additive finance_cloud_consistency migration',
);
const cloudConsistencyMigrationSql = migrationSources[cloudConsistencyMigrationIndex];

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const OWNER_C = '33333333-3333-4333-8333-333333333333';
const OWNER_D = '44444444-4444-4444-8444-444444444444';
const OWNER_E = '55555555-5555-4555-8555-555555555555';
const OWNER_F = '66666666-6666-4666-8666-666666666666';
const EXPECTED_TABLES = [
  'accounts',
  'adjustments',
  'budgets',
  'categories',
  'goals',
  'recurring_rules',
  'savings_allocations',
  'settings',
  'subscriptions',
  'transactions',
  'transfers',
];

function base64Url(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function stableLegacyId(prefix, ...parts) {
  return `${prefix}-${parts.map(base64Url).join('.')}`;
}

function numeric(value) {
  const result = Number(value);
  assert.ok(Number.isFinite(result), `Expected a finite numeric value, received ${String(value)}`);
  return result;
}

async function one(db, sql, parameters = []) {
  const result = await db.query(sql, parameters);
  assert.equal(result.rows.length, 1, `Expected one row, received ${result.rows.length}`);
  return result.rows[0];
}

async function bootstrapSupabaseAuth(db) {
  // PGlite is PostgreSQL without Supabase's managed auth schema/roles. This
  // local-only wrapper supplies the minimum contract used by the migration and
  // owner-scoped RLS policies; it never connects to an external database.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;

    create schema auth;
    create table auth.users (
      id uuid primary key
    );

    create function auth.uid()
    returns uuid
    language sql
    stable
    set search_path = pg_catalog
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    revoke all on schema auth from public, anon, authenticated;
    grant usage on schema auth to authenticated, service_role;
    revoke all on function auth.uid() from public, anon;
    grant execute on function auth.uid() to authenticated, service_role;

    -- Existing Supabase projects historically auto-granted new public objects
    -- to Data API roles. Reproduce that baseline so the migration must prove it
    -- really changes future exposure to explicit opt-in.
    alter default privileges for role postgres in schema public
      grant select, insert, update, delete on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public
      grant execute on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public
      grant usage, select on sequences to anon, authenticated, service_role;
  `);
}

async function verifyFreshAndRetry() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseAuth(db);
    await db.exec(migrationSql);

    const tableResult = await db.query(`
      select tablename
      from pg_tables
      where schemaname = 'public'
      order by tablename
    `);
    assert.deepEqual(tableResult.rows.map(({ tablename }) => tablename), EXPECTED_TABLES);

    // Reapplying the exact migration must not duplicate policies, triggers,
    // constraints, settings, or backfill rows.
    await db.exec(migrationSql);

    const policyCount = await one(db, `
      select count(*)::integer as count
      from pg_policies
      where schemaname = 'public'
        and policyname like 'finance_owner_%'
    `);
    assert.equal(
      numeric(policyCount.count),
      37,
      'Expected owner CRUD policies plus DELETE only where a tombstone bridge exists',
    );
    const deletePolicyCount = await one(db, `
      select count(*)::integer as count
      from pg_policies
      where schemaname = 'public'
        and policyname = 'finance_owner_delete'
    `);
    assert.equal(
      numeric(deletePolicyCount.count),
      4,
      'Only the four legacy tables may expose DELETE through a tombstone bridge',
    );

    const triggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname = 'finance_v3_conflict_clock'
        and not tgisinternal
    `);
    assert.equal(numeric(triggerCount.count), 9, 'Expected one conflict-clock trigger per sync entity');

    const allocationCapacityTriggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname = 'finance_v3_validate_allocation_capacity'
        and not tgisinternal
    `);
    assert.equal(
      numeric(allocationCapacityTriggerCount.count),
      1,
      'Expected one atomic capacity trigger on savings allocations',
    );

    const compatibilityTriggerCounts = await one(db, `
      select
        count(*) filter (where tgname = 'finance_v3_mirror_allocation_total')::integer
          as allocation_mirror,
        count(*) filter (where tgname = 'finance_v3_mirror_recurring_rule')::integer
          as recurring_mirror,
        count(*) filter (where tgname = 'finance_v3_pause_rules_on_parent_archive')::integer
          as parent_pause,
        count(*) filter (where tgname = 'finance_v3_validate_recurring_parents')::integer
          as recurring_parent_guard
      from pg_trigger
      where not tgisinternal
    `);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(compatibilityTriggerCounts).map(([key, value]) => [key, numeric(value)]),
      ),
      {
        allocation_mirror: 1,
        recurring_mirror: 1,
        parent_pause: 2,
        recurring_parent_guard: 1,
      },
      'Expected one retry-safe compatibility trigger per invariant and parent table',
    );

    const bridgeTriggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname = 'finance_v3_00_legacy_bridge'
        and not tgisinternal
    `);
    assert.equal(
      numeric(bridgeTriggerCount.count),
      4,
      'Expected legacy bridges on transactions, budgets, goals, and subscriptions',
    );

    const deleteTombstoneTriggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname = 'finance_v3_legacy_delete_tombstone'
        and not tgisinternal
    `);
    assert.equal(
      numeric(deleteTombstoneTriggerCount.count),
      4,
      'Expected one legacy DELETE tombstone bridge on each legacy finance table',
    );

    const goalAuditTriggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname = 'finance_v3_legacy_goal_allocation'
        and not tgisinternal
    `);
    assert.equal(numeric(goalAuditTriggerCount.count), 1, 'Expected one atomic legacy-goal allocation trigger');

    const goalInsertContextTriggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname in (
        'finance_v3_00_goal_insert_context',
        'finance_v3_99_goal_insert_context'
      )
        and not tgisinternal
    `);
    assert.equal(
      numeric(goalInsertContextTriggerCount.count),
      2,
      'Expected statement context to bracket goal INSERT/UPSERT execution',
    );

    const operationCheckCount = await one(db, `
      select count(*)::integer as count
      from pg_constraint
      where conname ~ '^finance_v3_.*_operation_check$'
    `);
    assert.equal(numeric(operationCheckCount.count), 11, 'Expected a stable operation check on every finance table');

    const resourceGuardCounts = await one(db, `
      select
        (select count(*)::integer
          from pg_trigger
          where tgname = 'finance_v3_10_owner_resource_limit'
            and not tgisinternal) as triggers,
        (select count(*)::integer
          from pg_constraint
          where conname ~ '^finance_v3_.*_numeric_chk$') as numeric_checks,
        (select count(*)::integer
          from pg_constraint
          where conname ~ '^finance_v3_.*_len_chk$') as text_checks
    `);
    assert.equal(numeric(resourceGuardCounts.triggers), 10, 'Expected one row quota trigger per owner-scoped entity table');
    assert.equal(numeric(resourceGuardCounts.numeric_checks), 10, 'Expected one future-write check per finance numeric column');
    assert.equal(numeric(resourceGuardCounts.text_checks), 78, 'Expected a future-write check on every persisted text field');

    const domainCheckCount = await one(db, `
      select count(*)::integer as count
      from pg_constraint
      where conname in (
        'finance_v3_transactions_amount_check',
        'finance_v3_transactions_type_check',
        'finance_v3_transactions_relations_check',
        'finance_v3_goals_target_amount_check',
        'finance_v3_budgets_amount_check',
        'finance_v3_budgets_period_check',
        'finance_v3_budgets_scope_check',
        'finance_v3_budgets_relation_check',
        'finance_v3_accounts_name_check',
        'finance_v3_categories_name_check'
        ,'finance_v3_transfers_amount_check'
        ,'finance_v3_transfers_distinct_accounts_check'
        ,'finance_v3_transfers_relations_check'
      )
    `);
    assert.equal(numeric(domainCheckCount.count), 13, 'Expected future-write domain checks');

    const recurrenceIndex = await one(db, `
      select count(*)::integer as count
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'finance_v3_transactions_recurring_occurrence_uidx'
    `);
    assert.equal(numeric(recurrenceIndex.count), 1, 'Expected the recurrence-occurrence uniqueness index');

    await db.exec(`
      create table public.future_private_by_default (id bigint generated always as identity primary key);
      create function public.future_private_function() returns integer language sql as $$ select 1 $$;
      create sequence public.future_private_sequence;
    `);
    const futurePrivileges = await one(db, `
      select
        has_table_privilege('anon', 'public.future_private_by_default', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.future_private_by_default', 'select') as authenticated_table,
        has_table_privilege('service_role', 'public.future_private_by_default', 'select') as service_table,
        has_function_privilege('anon', 'public.future_private_function()', 'execute') as anon_function,
        has_function_privilege('authenticated', 'public.future_private_function()', 'execute') as authenticated_function,
        has_function_privilege('service_role', 'public.future_private_function()', 'execute') as service_function,
        has_sequence_privilege('anon', 'public.future_private_sequence', 'usage') as anon_sequence,
        has_sequence_privilege('authenticated', 'public.future_private_sequence', 'usage') as authenticated_sequence,
        has_sequence_privilege('service_role', 'public.future_private_sequence', 'usage') as service_sequence,
        has_table_privilege('authenticated', 'public.accounts', 'select') as explicit_finance_grant,
        has_table_privilege('authenticated', 'public.transactions', 'delete') as legacy_delete_grant,
        has_table_privilege('authenticated', 'public.savings_allocations', 'delete') as allocation_delete_grant,
        has_table_privilege('authenticated', 'public.recurring_rules', 'delete') as recurring_delete_grant,
        has_function_privilege('authenticated', 'finance_private.finance_v3_part(text)', 'execute') as stable_id_helper,
        has_function_privilege('authenticated', 'finance_private.bridge_legacy_finance_write()', 'execute') as mutation_helper,
        has_function_privilege('authenticated', 'finance_private.set_goal_insert_statement_context()', 'execute') as context_helper,
        has_function_privilege(
          'authenticated',
          'finance_private.tombstone_legacy_finance_delete()',
          'execute'
        ) as delete_helper,
        has_function_privilege(
          'authenticated',
          'finance_private.enforce_allocation_capacity()',
          'execute'
        ) as allocation_capacity_helper,
        has_function_privilege(
          'authenticated',
          'finance_private.mirror_allocation_total_to_goal()',
          'execute'
        ) as allocation_mirror_helper,
        has_function_privilege(
          'authenticated',
          'finance_private.mirror_recurring_rule_to_subscription()',
          'execute'
        ) as recurring_mirror_helper,
        has_function_privilege(
          'authenticated',
          'finance_private.pause_rules_for_archived_parent()',
          'execute'
        ) as parent_pause_helper,
        has_function_privilege(
          'authenticated',
          'finance_private.enforce_recurring_parent_active()',
          'execute'
        ) as recurring_parent_helper
    `);
    assert.deepEqual(futurePrivileges, {
      anon_table: false,
      authenticated_table: false,
      service_table: false,
      anon_function: false,
      authenticated_function: false,
      service_function: false,
      anon_sequence: false,
      authenticated_sequence: false,
      service_sequence: false,
      explicit_finance_grant: true,
      legacy_delete_grant: true,
      allocation_delete_grant: false,
      recurring_delete_grant: false,
      stable_id_helper: true,
      mutation_helper: false,
      context_helper: false,
      delete_helper: false,
      allocation_capacity_helper: false,
      allocation_mirror_helper: false,
      recurring_mirror_helper: false,
      parent_pause_helper: false,
      recurring_parent_helper: false,
    }, 'Future public objects must be private until an explicit reviewed grant');

    await db.query('insert into auth.users (id) values ($1)', [OWNER_A]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values ($1, 'capacity-cash', '現金', 'emoji', '💵', 100,
        true, true, 0, 1, now(), 'capacity-account')
    `, [OWNER_A]);
    await db.query(`
      insert into public.goals (
        user_id, id, name, target_amount, current_amount, unit, is_active,
        version, updated_at, last_operation_id
      ) values ($1, 'capacity-goal', '併發配置', 1000, 0, '元', true,
        1, now(), 'capacity-goal')
    `, [OWNER_A]);

    await db.exec('set role authenticated');
    try {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
      const insertAllocation = (id, operationId) => db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at, version,
          updated_at, last_operation_id
        ) values ($1, $2, 'capacity-goal', 80, '2026-08-23 11:00', 1,
          now(), $3)
      `, [OWNER_A, id, operationId]);

      await insertAllocation('capacity-device-a', 'capacity-op-a');
      const goalAfterFirstAllocation = await one(db, `
        select current_amount, version
        from public.goals
        where user_id = $1 and id = 'capacity-goal'
      `, [OWNER_A]);
      assert.deepEqual(
        {
          currentAmount: numeric(goalAfterFirstAllocation.current_amount),
          version: numeric(goalAfterFirstAllocation.version),
        },
        { currentAmount: 80, version: 1 },
        'A v3 allocation must update only the rollback-readable total, not the goal sync clock',
      );

      const offlineGoalEditAfterAllocation = await one(db, `
        update public.goals
        set name = '配置後的離線目標編輯', version = 2,
          updated_at = now(), last_operation_id = 'capacity-goal-edit-2'
        where user_id = $1 and id = 'capacity-goal'
        returning name, current_amount, version, last_operation_id
      `, [OWNER_A]);
      assert.deepEqual(
        {
          name: offlineGoalEditAfterAllocation.name,
          currentAmount: numeric(offlineGoalEditAfterAllocation.current_amount),
          version: numeric(offlineGoalEditAfterAllocation.version),
          lastOperationId: offlineGoalEditAfterAllocation.last_operation_id,
        },
        {
          name: '配置後的離線目標編輯',
          currentAmount: 80,
          version: 2,
          lastOperationId: 'capacity-goal-edit-2',
        },
        'Allocation projection must not make a later legitimate goal edit look stale',
      );
      await assert.rejects(
        insertAllocation('capacity-device-b', 'capacity-op-b'),
        /new savings allocation exceeds available assets/i,
        'A second offline device must not atomically over-allocate the same available assets',
      );

      const afterRejectedWrite = await one(db, `
        select count(*)::integer as count, sum(amount_delta) as total
        from public.savings_allocations
        where user_id = $1 and deleted_at is null
      `, [OWNER_A]);
      assert.deepEqual(
        { count: numeric(afterRejectedWrite.count), total: numeric(afterRejectedWrite.total) },
        { count: 1, total: 80 },
        'A rejected concurrent allocation must leave the accepted server state unchanged',
      );

      await db.query(`
        update public.savings_allocations
        set deleted_at = now(), version = 2, last_operation_id = 'capacity-release-a'
        where user_id = $1 and id = 'capacity-device-a'
      `, [OWNER_A]);
      await insertAllocation('capacity-device-b', 'capacity-op-b');

      const goalAfterReleaseAndRetry = await one(db, `
        select current_amount, version
        from public.goals
        where user_id = $1 and id = 'capacity-goal'
      `, [OWNER_A]);
      assert.deepEqual(
        {
          currentAmount: numeric(goalAfterReleaseAndRetry.current_amount),
          version: numeric(goalAfterReleaseAndRetry.version),
        },
        { currentAmount: 80, version: 2 },
        'Allocation changes must keep the legacy total equal without consuming the goal clock',
      );

      const legacyGoalEdit = await one(db, `
        update public.goals
        set current_amount = 70
        where user_id = $1 and id = 'capacity-goal'
        returning current_amount, version, last_operation_id
      `, [OWNER_A]);
      assert.equal(numeric(legacyGoalEdit.current_amount), 70);
      assert.equal(numeric(legacyGoalEdit.version), 3);
      assert.match(legacyGoalEdit.last_operation_id, /^legacy-update-/);
      const afterLegacyGoalEdit = await one(db, `
        select count(*) filter (where deleted_at is null)::integer as live_count,
          sum(amount_delta) filter (where deleted_at is null) as live_total
        from public.savings_allocations
        where user_id = $1 and goal_id = 'capacity-goal'
      `, [OWNER_A]);
      assert.deepEqual(
        {
          liveCount: numeric(afterLegacyGoalEdit.live_count),
          liveTotal: numeric(afterLegacyGoalEdit.live_total),
        },
        { liveCount: 2, liveTotal: 70 },
        'A legacy goal edit must append only the delta and never double-count the mirrored total',
      );

      const exactLegacyGoalRetry = await one(db, `
        update public.goals
        set current_amount = 70
        where user_id = $1 and id = 'capacity-goal'
        returning version, last_operation_id
      `, [OWNER_A]);
      assert.deepEqual(
        exactLegacyGoalRetry,
        { version: 3, last_operation_id: legacyGoalEdit.last_operation_id },
        'An exact legacy goal retry must not append another allocation delta',
      );

      await assert.rejects(
        db.query(`
          update public.savings_allocations
          set amount_delta = 79, version = 2,
            updated_at = now(), last_operation_id = 'capacity-rewrite-economic-event'
          where user_id = $1 and id = 'capacity-device-b'
        `, [OWNER_A]),
        /savings allocation economic fields are immutable/i,
        'A persisted allocation must be corrected with a new delta, not rewritten in place',
      );
      await assert.rejects(
        db.query(`
          insert into public.savings_allocations (
            user_id, id, goal_id, amount_delta, occurred_at, version,
            updated_at, last_operation_id
          ) values ($1, 'capacity-over-release', 'capacity-goal', -71,
            '2026-08-23 12:00', 1, now(), 'capacity-over-release-op')
        `, [OWNER_A]),
        /savings allocation cannot make a goal total negative/i,
        'A new release delta must not make one goal allocation total negative',
      );
      const totalAfterRejectedAllocationRewrites = await one(db, `
        select current_amount
        from public.goals
        where user_id = $1 and id = 'capacity-goal'
      `, [OWNER_A]);
      assert.equal(
        numeric(totalAfterRejectedAllocationRewrites.current_amount),
        70,
        'Rejected allocation rewrites must leave the rollback-readable goal total unchanged',
      );

      await db.query(`
        insert into public.categories (
          user_id, id, kind, name, icon_type, icon_value, is_active,
          sort_order, version, updated_at, last_operation_id
        ) values ($1, 'capacity-category', 'expense', '訂閱', 'vector', 'tag', true,
          0, 1, now(), 'capacity-category')
      `, [OWNER_A]);
      await db.query(`
        insert into public.recurring_rules (
          user_id, id, name, type, amount, category_id, category_name,
          account_id, account_name, frequency, start_date, anchor_day,
          next_occurrence_date, is_active, version, updated_at, last_operation_id
        ) values (
          $1, 'capacity-rule', '月費', 'expense', 10,
          'capacity-category', '訂閱', 'capacity-cash', '現金',
          'monthly', '2026-09-01', 1, '2026-09-01', true,
          1, now(), 'capacity-rule-op-1'
        )
      `, [OWNER_A]);
      const initialLegacyRuleMirror = await one(db, `
        select is_active, deleted_at, version
        from public.subscriptions
        where user_id = $1 and id = 'capacity-rule'
      `, [OWNER_A]);
      assert.deepEqual(
        {
          isActive: initialLegacyRuleMirror.is_active,
          deletedAt: initialLegacyRuleMirror.deleted_at,
          version: numeric(initialLegacyRuleMirror.version),
        },
        { isActive: true, deletedAt: null, version: 1 },
        'A v3 monthly rule must materialize as one legacy-visible subscription',
      );

      await assert.rejects(
        db.query(`
          update public.categories
          set kind = 'income', version = 2,
            updated_at = now(), last_operation_id = 'capacity-category-kind-drift-2'
          where user_id = $1 and id = 'capacity-category'
        `, [OWNER_A]),
        /finance category kind is immutable/i,
        'A category kind change must not strand an active recurring rule with a mismatched type',
      );
      const ruleAfterRejectedCategoryKindDrift = await one(db, `
        select is_active, type
        from public.recurring_rules
        where user_id = $1 and id = 'capacity-rule'
      `, [OWNER_A]);
      assert.deepEqual(ruleAfterRejectedCategoryKindDrift, { is_active: true, type: 'expense' });

      await assert.rejects(
        db.query(`delete from public.savings_allocations
          where user_id = $1 and id = 'capacity-device-b'`, [OWNER_A]),
        /permission denied/i,
        'Authenticated v3 callers must tombstone allocations instead of physically deleting them',
      );
      await assert.rejects(
        db.query(`delete from public.recurring_rules
          where user_id = $1 and id = 'capacity-rule'`, [OWNER_A]),
        /permission denied/i,
        'Authenticated v3 callers must tombstone recurring rules instead of bypassing their mirror',
      );

      await db.query(`
        update public.accounts
        set is_active = false, version = 2,
          updated_at = now(), last_operation_id = 'capacity-account-archive-2'
        where user_id = $1 and id = 'capacity-cash'
      `, [OWNER_A]);
      const pausedRule = await one(db, `
        select is_active, deleted_at, version, last_operation_id
        from public.recurring_rules
        where user_id = $1 and id = 'capacity-rule'
      `, [OWNER_A]);
      assert.equal(pausedRule.is_active, false);
      assert.equal(pausedRule.deleted_at, null);
      assert.equal(numeric(pausedRule.version), 2);
      assert.match(pausedRule.last_operation_id, /^parent-archive-pause-/);
      const legacyHiddenAfterParentArchive = await one(db, `
        select count(*)::integer as count
        from public.subscriptions
        where user_id = $1 and id = 'capacity-rule'
      `, [OWNER_A]);
      assert.equal(
        numeric(legacyHiddenAfterParentArchive.count),
        0,
        'Archiving a recurrence parent must atomically hide the paused rule from old clients',
      );

      await db.query(
        "select set_config('request.headers', '{\"x-shiba-finance-client\":\"v3\"}', false)",
      );
      const pausedMirror = await one(db, `
        select is_active, deleted_at, version, last_operation_id
        from public.subscriptions
        where user_id = $1 and id = 'capacity-rule'
      `, [OWNER_A]);
      assert.equal(pausedMirror.is_active, false);
      assert.equal(pausedMirror.deleted_at, null);
      assert.equal(numeric(pausedMirror.version), 2);
      assert.match(pausedMirror.last_operation_id, /^parent-archive-subscription-pause-/);

      await db.query(`
        update public.accounts
        set is_active = false, version = 2,
          last_operation_id = 'capacity-account-archive-2'
        where user_id = $1 and id = 'capacity-cash'
      `, [OWNER_A]);
      const exactParentRetrySnapshot = await one(db, `
        select
          (select version from public.recurring_rules
            where user_id = $1 and id = 'capacity-rule') as rule_version,
          (select version from public.subscriptions
            where user_id = $1 and id = 'capacity-rule') as subscription_version
      `, [OWNER_A]);
      assert.deepEqual(
        {
          ruleVersion: numeric(exactParentRetrySnapshot.rule_version),
          subscriptionVersion: numeric(exactParentRetrySnapshot.subscription_version),
        },
        { ruleVersion: 2, subscriptionVersion: 2 },
        'Retrying a parent archive must not manufacture recurring compatibility clocks',
      );

      await assert.rejects(
        db.query(`
          update public.recurring_rules
          set is_active = true, version = 3,
            updated_at = now(), last_operation_id = 'capacity-rule-resume-blocked-3'
          where user_id = $1 and id = 'capacity-rule'
        `, [OWNER_A]),
        /active recurring rule requires an active account/i,
        'An active rule must not be resumable while its account is archived',
      );

      await db.query(`
        update public.accounts
        set is_active = true, version = 3,
          updated_at = now(), last_operation_id = 'capacity-account-resume-3'
        where user_id = $1 and id = 'capacity-cash'
      `, [OWNER_A]);
      await db.query(`
        update public.recurring_rules
        set is_active = true, version = 3,
          updated_at = now(), last_operation_id = 'capacity-rule-resume-3'
        where user_id = $1 and id = 'capacity-rule'
      `, [OWNER_A]);
      await db.query("select set_config('request.headers', '{}', false)");
      const legacyVisibleAfterRuleResume = await one(db, `
        select is_active, deleted_at, version
        from public.subscriptions
        where user_id = $1 and id = 'capacity-rule'
      `, [OWNER_A]);
      assert.deepEqual(
        {
          isActive: legacyVisibleAfterRuleResume.is_active,
          deletedAt: legacyVisibleAfterRuleResume.deleted_at,
          version: numeric(legacyVisibleAfterRuleResume.version),
        },
        { isActive: true, deletedAt: null, version: 3 },
        'Restoring the parent and rule must restore exactly one old-client-visible mirror',
      );

      await db.query(`
        insert into public.goals (
          user_id, id, name, target_amount, current_amount, unit,
          is_active, version, updated_at, last_operation_id
        ) values ($1, 'archived-goal', '封存目標', 100, 0, '元',
          true, 1, now(), 'archived-goal-op-1')
      `, [OWNER_A]);
      await db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'archived-goal-allocation', 'archived-goal', 10,
          '2026-08-23 15:00', 1, now(), 'archived-goal-allocation-op-1')
      `, [OWNER_A]);
      await db.query(
        "select set_config('request.headers', '{\"x-shiba-finance-client\":\"v3\"}', false)",
      );
      await db.query(`
        update public.goals
        set is_active = false, version = 2,
          updated_at = now(), last_operation_id = 'archived-goal-op-2'
        where user_id = $1 and id = 'archived-goal'
      `, [OWNER_A]);
      await db.query("select set_config('request.headers', '{}', false)");
      await assert.rejects(
        db.query(`
          insert into public.savings_allocations (
            user_id, id, goal_id, amount_delta, occurred_at,
            version, updated_at, last_operation_id
          ) values ($1, 'archived-goal-new-allocation', 'archived-goal', 1,
            '2026-08-23 15:01', 1, now(), 'archived-goal-new-allocation-op-1')
        `, [OWNER_A]),
        /new savings allocation requires an active goal/i,
        'A newly increased allocation must not target an archived goal',
      );
      await db.query(`
        update public.savings_allocations
        set deleted_at = now(), version = 2,
          updated_at = now(), last_operation_id = 'archived-goal-allocation-release-2'
        where user_id = $1 and id = 'archived-goal-allocation'
      `, [OWNER_A]);
      await db.query(`
        insert into public.budgets (
          user_id, id, scope, category_id, category_name, period, amount,
          is_active, version, updated_at, last_operation_id
        ) values ($1, 'archived-budget', 'overall', null, null, 'monthly', 100,
          false, 1, now(), 'archived-budget-op-1')
      `, [OWNER_A]);
      const headerlessArchivedRows = await one(db, `
        select
          (select count(*)::integer from public.goals
            where user_id = $1 and id = 'archived-goal') as goals,
          (select count(*)::integer from public.budgets
            where user_id = $1 and id = 'archived-budget') as budgets
      `, [OWNER_A]);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(headerlessArchivedRows).map(([key, value]) => [key, numeric(value)]),
        ),
        { goals: 0, budgets: 0 },
        'Headerless old clients must not reload archived planning rows as active data',
      );
      await db.query(
        "select set_config('request.headers', '{\"x-shiba-finance-client\":\"v3\"}', false)",
      );
      const v3ArchivedRows = await one(db, `
        select
          (select count(*)::integer from public.goals
            where user_id = $1 and id = 'archived-goal' and not is_active) as goals,
          (select count(*)::integer from public.budgets
            where user_id = $1 and id = 'archived-budget' and not is_active) as budgets,
          (select current_amount from public.goals
            where user_id = $1 and id = 'archived-goal') as goal_current_amount,
          (select version from public.goals
            where user_id = $1 and id = 'archived-goal') as goal_version,
          (select last_operation_id from public.goals
            where user_id = $1 and id = 'archived-goal') as goal_operation
      `, [OWNER_A]);
      assert.deepEqual(
        {
          goals: numeric(v3ArchivedRows.goals),
          budgets: numeric(v3ArchivedRows.budgets),
          goalCurrentAmount: numeric(v3ArchivedRows.goal_current_amount),
          goalVersion: numeric(v3ArchivedRows.goal_version),
          goalOperation: v3ArchivedRows.goal_operation,
        },
        {
          goals: 1,
          budgets: 1,
          goalCurrentAmount: 0,
          goalVersion: 2,
          goalOperation: 'archived-goal-op-2',
        },
        'v3 retains archived rows while an internal allocation tombstone updates only the legacy total',
      );
      await db.query("select set_config('request.headers', '{}', false)");
    } finally {
      await db.exec('reset role');
    }
  } finally {
    await db.close();
  }
}

async function createLegacyFixture(db) {
  // These are the deployed legacy shapes: text IDs with a global id primary key
  // and UUID ownership. The v3 migration must evolve them in place.
  await db.exec(`
    create table public.transactions (
      id text primary key,
      user_id uuid not null references auth.users (id) on delete cascade,
      amount numeric not null,
      type text not null,
      category text,
      note text,
      date text,
      account text,
      icon text
    );

    create table public.goals (
      id text primary key,
      user_id uuid not null references auth.users (id) on delete cascade,
      name text not null,
      target_amount numeric not null,
      current_amount numeric not null,
      unit text not null,
      target_date text
    );

    create table public.subscriptions (
      id text primary key,
      user_id uuid not null references auth.users (id) on delete cascade,
      name text not null,
      amount numeric not null,
      category text,
      account text,
      recurring_date integer
    );

    create table public.budgets (
      id text primary key,
      user_id uuid not null references auth.users (id) on delete cascade,
      category text,
      period text not null,
      amount numeric not null
    );
  `);

  await db.query('insert into auth.users (id) values ($1), ($2)', [OWNER_A, OWNER_B]);

  await db.query(`
    insert into public.transactions
      (id, user_id, amount, type, category, note, date, account, icon)
    values
      ('txn-a', $1, 125.50, 'expense', '餐飲', '午餐', '2026-08-20T12:34:56', '現金', 'UTENSILS'),
      ('txn-b', $2, 800, 'income', '薪資', '別人的資料', '2026-08-20T08:00:00', '銀行', 'SPARKLES'),
      ('txn-card', $1, 10, 'expense', '測試', null, '2026-08-20', 'Card', 'SPARKLES')
  `, [OWNER_A, OWNER_B]);

  const longAccountName = '長帳戶'.repeat(40);
  await db.query(`
    insert into public.transactions
      (id, user_id, amount, type, category, note, date, account, icon)
    values ('txn-long', $1, 1, 'expense', '測試', null, '2026-08-20', $2, 'SPARKLES')
  `, [OWNER_A, longAccountName]);

  await db.query(`
    insert into public.goals
      (id, user_id, name, target_amount, current_amount, unit, target_date)
    values ('goal-a', $1, '旅行', 10000, 1500, '元', '2026-12-31')
  `, [OWNER_A]);

  await db.query(`
    insert into public.subscriptions
      (id, user_id, name, amount, category, account, recurring_date)
    values
      ('sub-31', $1, '串流娛樂', 399, '娛樂', '街口支付', 31),
      ('sub-invalid', $1, '待人工檢查', -1, '', '', 32),
      ('sub-null-date', $1, '缺少扣款日', 199, '娛樂', '現金', null)
  `, [OWNER_A]);

  await db.query(`
    insert into public.budgets (id, user_id, category, period, amount)
    values ('budget-a', $1, '餐飲', 'monthly', 5000)
  `, [OWNER_A]);

  return { longAccountName };
}

async function verifyLegacyOwnerScopedPrimaryKeys(db, exerciseCollision = false) {
  const result = await db.query(`
    select table_class.relname as table_name, attribute.attname as column_name,
      key_column.ordinality::integer as position
    from pg_constraint as constraint_record
    join pg_class as table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace as table_schema on table_schema.oid = table_class.relnamespace
    cross join lateral unnest(constraint_record.conkey)
      with ordinality as key_column(attnum, ordinality)
    join pg_attribute as attribute
      on attribute.attrelid = table_class.oid
      and attribute.attnum = key_column.attnum
    where constraint_record.contype = 'p'
      and table_schema.nspname = 'public'
      and table_class.relname in ('transactions', 'budgets', 'goals', 'subscriptions')
    order by table_class.relname, key_column.ordinality
  `);
  const primaryKeys = Object.fromEntries(
    ['transactions', 'budgets', 'goals', 'subscriptions'].map((table) => [
      table,
      result.rows
        .filter((row) => row.table_name === table)
        .map((row) => row.column_name),
    ]),
  );
  assert.deepEqual(primaryKeys, {
    transactions: ['user_id', 'id'],
    budgets: ['user_id', 'id'],
    goals: ['user_id', 'id'],
    subscriptions: ['user_id', 'id'],
  }, 'Every migrated legacy primary key must be owner-scoped');

  if (!exerciseCollision) return;

  await db.exec('set role authenticated');
  try {
    for (const [ownerId, note] of [
      [OWNER_A, 'owner A shared ID'],
      [OWNER_B, 'owner B shared ID'],
    ]) {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
      await db.query(`
        insert into public.transactions
          (id, user_id, amount, type, category, note, date, account, icon)
        values
          ('same-id-across-owners', $1, 1, 'expense', '測試', $2,
            '2026-08-23', '現金', 'SPARKLES')
      `, [ownerId, note]);
    }
  } finally {
    await db.exec('reset role');
  }

  const collisionRows = await one(db, `
    select count(*)::integer as count, count(distinct user_id)::integer as owners
    from public.transactions
    where id = 'same-id-across-owners'
  `);
  assert.deepEqual(
    { count: numeric(collisionRows.count), owners: numeric(collisionRows.owners) },
    { count: 2, owners: 2 },
    'Two owners must be able to reuse the same legacy client-generated ID',
  );
}

async function verifyUnexpectedIncomingLegacyForeignKeyFailsClosed() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseAuth(db);
    await createLegacyFixture(db);
    await db.exec(`
      create table public.external_transaction_links (
        id text primary key,
        transaction_id text not null references public.transactions (id)
      );
      insert into public.external_transaction_links (id, transaction_id)
      values ('external-link', 'txn-a');
    `);

    try {
      await assert.rejects(
        db.exec(migrationSql),
        /cannot owner-scope public\.transactions primary key while incoming foreign keys exist: public\.external_transaction_links/i,
        'An unknown incoming FK must stop owner-scoping instead of being dropped or cascaded',
      );
    } finally {
      await db.exec('rollback');
    }

    const preserved = await one(db, `
      select
        (select count(*)::integer from public.transactions) as transaction_count,
        (select count(*)::integer from public.external_transaction_links) as external_link_count,
        (select array_agg(attribute.attname order by key_column.ordinality)
          from pg_constraint as constraint_record
          cross join lateral unnest(constraint_record.conkey)
            with ordinality as key_column(attnum, ordinality)
          join pg_attribute as attribute
            on attribute.attrelid = constraint_record.conrelid
            and attribute.attnum = key_column.attnum
          where constraint_record.conrelid = 'public.transactions'::regclass
            and constraint_record.contype = 'p') as primary_key_columns
    `);
    assert.deepEqual(
      {
        transactionCount: numeric(preserved.transaction_count),
        externalLinkCount: numeric(preserved.external_link_count),
        primaryKeyColumns: preserved.primary_key_columns,
      },
      { transactionCount: 4, externalLinkCount: 1, primaryKeyColumns: ['id'] },
      'A blocked conversion must roll back without changing legacy data or dependencies',
    );
  } finally {
    if (!db.closed) await db.close();
  }
}

async function verifyLegacyBackfill(db, longAccountName) {
  const transaction = await one(db, `
    select amount, type, category, note, date, account, category_id, account_id, occurred_at
    from public.transactions
    where user_id = $1 and id = 'txn-a'
  `, [OWNER_A]);
  assert.equal(numeric(transaction.amount), 125.5);
  assert.equal(transaction.type, 'expense');
  assert.equal(transaction.category, '餐飲');
  assert.equal(transaction.note, '午餐');
  assert.equal(transaction.date, '2026-08-20T12:34:56');
  assert.equal(transaction.account, '現金');
  assert.equal(transaction.occurred_at, transaction.date, 'Legacy local date text must remain exact');
  assert.equal(transaction.category_id, stableLegacyId('category', OWNER_A, 'expense', '餐飲'));
  assert.equal(transaction.account_id, stableLegacyId('account', OWNER_A, '現金'));

  const assertAccountClassification = async (name, includeInTotalAssets, requiresReview) => {
    const account = await one(db, `
      select include_in_total_assets, requires_review
      from public.accounts
      where user_id = $1 and id = $2
    `, [OWNER_A, stableLegacyId('account', OWNER_A, name)]);
    assert.equal(account.include_in_total_assets, includeInTotalAssets, `${name} asset classification`);
    assert.equal(account.requires_review, requiresReview, `${name} review classification`);
  };
  await assertAccountClassification('現金', true, false);
  await assertAccountClassification('街口支付', true, false);
  await assertAccountClassification('Card', false, true);

  const longTransaction = await one(db, `
    select account_id
    from public.transactions
    where user_id = $1 and id = 'txn-long'
  `, [OWNER_A]);
  assert.equal(
    longTransaction.account_id,
    stableLegacyId('account', OWNER_A, longAccountName),
    'SQL and browser base64url IDs must match even when PostgreSQL wraps base64 output',
  );

  const goal = await one(db, `
    select current_amount, unit
    from public.goals
    where user_id = $1 and id = 'goal-a'
  `, [OWNER_A]);
  assert.equal(numeric(goal.current_amount), 1500, 'Rollback-readable legacy goal total must remain');
  assert.equal(goal.unit, '元');

  const allocation = await one(db, `
    select id, goal_id, amount_delta
    from public.savings_allocations
    where user_id = $1
  `, [OWNER_A]);
  assert.equal(allocation.id, stableLegacyId('allocation', OWNER_A, 'goal-a', 'legacy-current-amount'));
  assert.equal(allocation.goal_id, 'goal-a');
  assert.equal(numeric(allocation.amount_delta), 1500);

  const recurringRule = await one(db, `
    select id, frequency, anchor_day, start_date, next_occurrence_date,
      next_occurrence_date > current_date as starts_in_future
    from public.recurring_rules
    where user_id = $1 and id = 'sub-31'
  `, [OWNER_A]);
  assert.equal(recurringRule.frequency, 'monthly');
  assert.equal(numeric(recurringRule.anchor_day), 31);
  assert.equal(String(recurringRule.next_occurrence_date), String(recurringRule.start_date));
  assert.equal(recurringRule.starts_in_future, true, 'A migrated subscription must not catch up historical dates');

  const generatedPastTransactions = await one(db, `
    select count(*)::integer as count
    from public.transactions
    where user_id = $1 and recurring_rule_id is not null
  `, [OWNER_A]);
  assert.equal(numeric(generatedPastTransactions.count), 0, 'Subscription migration must not synthesize transactions');

  const invalidSubscription = await one(db, `
    select requires_review,
      (select count(*)::integer from public.recurring_rules as rule
        where rule.user_id = subscription.user_id and rule.id = subscription.id) as rule_count
    from public.subscriptions as subscription
    where user_id = $1 and id = 'sub-invalid'
  `, [OWNER_A]);
  assert.equal(invalidSubscription.requires_review, true);
  assert.equal(numeric(invalidSubscription.rule_count), 0, 'Invalid legacy data must be preserved for review, not reinterpreted');

  const nullDateSubscription = await one(db, `
    select requires_review,
      (select count(*)::integer from public.recurring_rules as rule
        where rule.user_id = subscription.user_id and rule.id = subscription.id) as rule_count
    from public.subscriptions as subscription
    where user_id = $1 and id = 'sub-null-date'
  `, [OWNER_A]);
  assert.equal(nullDateSubscription.requires_review, true);
  assert.equal(
    numeric(nullDateSubscription.rule_count),
    0,
    'A NULL legacy recurrence date must be preserved for review without aborting migration',
  );

  const settings = await one(db, `
    select currency, locale, active_goal_id
    from public.settings
    where user_id = $1
  `, [OWNER_A]);
  assert.deepEqual(settings, { currency: 'TWD', locale: 'zh-TW', active_goal_id: 'goal-a' });
}

async function verifyPostMigrationLegacyWrites(db) {
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
  try {
    const insertedTransaction = await one(db, `
      insert into public.transactions
        (id, user_id, amount, type, category, note, date, account, icon)
      values
        ('legacy-after-migration', $1, 90, 'expense', '點心', '舊版新增',
          '2026-08-22 15:30', '新錢包', 'UTENSILS')
      returning category_id, category_name, account_id, account_name, occurred_at,
        version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(insertedTransaction, {
      category_id: stableLegacyId('category', OWNER_A, 'expense', '點心'),
      category_name: '點心',
      account_id: stableLegacyId('account', OWNER_A, '新錢包'),
      account_name: '新錢包',
      occurred_at: '2026-08-22 15:30',
      version: 1,
      last_operation_id: insertedTransaction.last_operation_id,
    });
    assert.match(insertedTransaction.last_operation_id, /^legacy-insert-/);

    const exactLegacyRetry = await one(db, `
      update public.transactions
      set amount = amount, category = category, account = account,
        date = date, note = note
      where user_id = $1 and id = 'legacy-after-migration'
      returning version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        version: numeric(exactLegacyRetry.version),
        lastOperationId: exactLegacyRetry.last_operation_id,
      },
      { version: 1, lastOperationId: insertedTransaction.last_operation_id },
      'An exact legacy retry must not invent a new conflict clock',
    );

    const updatedTransaction = await one(db, `
      update public.transactions
      set amount = 120, category = '交通', account = '街口支付',
        date = '2026-08-22 16:45', note = '舊版編輯'
      where user_id = $1 and id = 'legacy-after-migration'
      returning amount, category_id, category_name, account_id, account_name,
        occurred_at, version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        amount: numeric(updatedTransaction.amount),
        categoryId: updatedTransaction.category_id,
        categoryName: updatedTransaction.category_name,
        accountId: updatedTransaction.account_id,
        accountName: updatedTransaction.account_name,
        occurredAt: updatedTransaction.occurred_at,
        version: numeric(updatedTransaction.version),
      },
      {
        amount: 120,
        categoryId: stableLegacyId('category', OWNER_A, 'expense', '交通'),
        categoryName: '交通',
        accountId: stableLegacyId('account', OWNER_A, '街口支付'),
        accountName: '街口支付',
        occurredAt: '2026-08-22 16:45',
        version: 2,
      },
      'A pre-v3 transaction edit must refresh stable relations and its conflict clock',
    );
    assert.match(updatedTransaction.last_operation_id, /^legacy-update-/);

    const insertedBudget = await one(db, `
      insert into public.budgets (id, user_id, category, period, amount)
      values ('legacy-budget-after-migration', $1, '交通', 'monthly', 3000)
      returning scope, category_id, category_name, version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        scope: insertedBudget.scope,
        categoryId: insertedBudget.category_id,
        categoryName: insertedBudget.category_name,
        version: numeric(insertedBudget.version),
      },
      {
        scope: 'category',
        categoryId: stableLegacyId('category', OWNER_A, 'expense', '交通'),
        categoryName: '交通',
        version: 1,
      },
    );
    assert.match(insertedBudget.last_operation_id, /^legacy-insert-/);

    const overallBudget = await one(db, `
      update public.budgets
      set category = null
      where user_id = $1 and id = 'legacy-budget-after-migration'
      returning scope, category_id, category_name, version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        scope: overallBudget.scope,
        categoryId: overallBudget.category_id,
        categoryName: overallBudget.category_name,
        version: numeric(overallBudget.version),
      },
      { scope: 'overall', categoryId: null, categoryName: null, version: 2 },
    );
    assert.match(overallBudget.last_operation_id, /^legacy-update-/);

    const insertedGoal = await one(db, `
      insert into public.goals
        (id, user_id, name, target_amount, current_amount, unit, target_date)
      values ('legacy-goal-after-migration', $1, '舊版目標', 5000, 250, '元', '2027-01-01')
      returning version, last_operation_id
    `, [OWNER_A]);
    assert.equal(numeric(insertedGoal.version), 1);
    assert.match(insertedGoal.last_operation_id, /^legacy-insert-/);

    const updatedGoal = await one(db, `
      update public.goals
      set current_amount = 350
      where user_id = $1 and id = 'legacy-goal-after-migration'
      returning current_amount, version, last_operation_id
    `, [OWNER_A]);
    assert.equal(numeric(updatedGoal.current_amount), 350);
    assert.equal(numeric(updatedGoal.version), 2);
    assert.match(updatedGoal.last_operation_id, /^legacy-update-/);

    const legacyGoalAudit = await one(db, `
      select count(*)::integer as count, sum(amount_delta) as total,
        bool_and(occurred_at ~ 'Z$') as portable_timestamp
      from public.savings_allocations
      where user_id = $1 and goal_id = 'legacy-goal-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        count: numeric(legacyGoalAudit.count),
        total: numeric(legacyGoalAudit.total),
        portableTimestamp: legacyGoalAudit.portable_timestamp,
      },
      { count: 2, total: 350, portableTimestamp: true },
      'Legacy goal totals must become atomic, auditable allocation deltas',
    );

    const insertedSubscription = await one(db, `
      insert into public.subscriptions
        (id, user_id, name, amount, category, account, recurring_date)
      values
        ('legacy-subscription-after-migration', $1, '新版前固定開銷', 299, '娛樂', '街口支付', 31)
      returning requires_review, version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        requiresReview: insertedSubscription.requires_review,
        version: numeric(insertedSubscription.version),
      },
      { requiresReview: false, version: 1 },
    );
    assert.match(insertedSubscription.last_operation_id, /^legacy-insert-/);

    const bridgedSubscriptionRule = await one(db, `
      select name, amount, type, category_id, category_name, account_id,
        account_name, frequency, anchor_day, start_date, next_occurrence_date,
        is_active, version, last_operation_id,
        next_occurrence_date > current_date as starts_in_future
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        name: bridgedSubscriptionRule.name,
        amount: numeric(bridgedSubscriptionRule.amount),
        type: bridgedSubscriptionRule.type,
        categoryId: bridgedSubscriptionRule.category_id,
        categoryName: bridgedSubscriptionRule.category_name,
        accountId: bridgedSubscriptionRule.account_id,
        accountName: bridgedSubscriptionRule.account_name,
        frequency: bridgedSubscriptionRule.frequency,
        anchorDay: numeric(bridgedSubscriptionRule.anchor_day),
        sameCursor: String(bridgedSubscriptionRule.start_date)
          === String(bridgedSubscriptionRule.next_occurrence_date),
        isActive: bridgedSubscriptionRule.is_active,
        version: numeric(bridgedSubscriptionRule.version),
        startsInFuture: bridgedSubscriptionRule.starts_in_future,
      },
      {
        name: '新版前固定開銷',
        amount: 299,
        type: 'expense',
        categoryId: stableLegacyId('category', OWNER_A, 'expense', '娛樂'),
        categoryName: '娛樂',
        accountId: stableLegacyId('account', OWNER_A, '街口支付'),
        accountName: '街口支付',
        frequency: 'monthly',
        anchorDay: 31,
        sameCursor: true,
        isActive: true,
        version: 1,
        startsInFuture: true,
      },
      'A post-migration legacy subscription insert must become one owner-scoped v3 rule',
    );
    assert.match(bridgedSubscriptionRule.last_operation_id, /^legacy-subscription-rule-/);

    const v3AdvancedSubscriptionRule = await one(db, `
      update public.recurring_rules
      set name = 'v3 裝置上的名稱', next_occurrence_date = '2027-01-31',
        version = 2, updated_at = '2026-08-23T12:00:00Z',
        last_operation_id = 'v3-subscription-rule-clock-2'
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning version, last_operation_id, next_occurrence_date
    `, [OWNER_A]);
    assert.equal(numeric(v3AdvancedSubscriptionRule.version), 2);

    const updatedSubscription = await one(db, `
      update public.subscriptions
      set amount = 349
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning amount, version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        amount: numeric(updatedSubscription.amount),
        version: numeric(updatedSubscription.version),
      },
      { amount: 349, version: 3 },
      'A real legacy subscription edit must advance its own conflict clock',
    );
    assert.match(updatedSubscription.last_operation_id, /^legacy-update-/);

    const selectivelyUpdatedRule = await one(db, `
      select name, amount,
        to_char(next_occurrence_date, 'YYYY-MM-DD') as next_occurrence_date,
        version, last_operation_id
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        name: selectivelyUpdatedRule.name,
        amount: numeric(selectivelyUpdatedRule.amount),
        nextOccurrenceDate: String(selectivelyUpdatedRule.next_occurrence_date),
        version: numeric(selectivelyUpdatedRule.version),
      },
      {
        name: 'v3 裝置上的名稱',
        amount: 349,
        nextOccurrenceDate: '2027-01-31',
        version: 3,
      },
      'A legacy partial edit must not rewind the cursor or overwrite unrelated newer v3 fields',
    );
    assert.match(selectivelyUpdatedRule.last_operation_id, /^legacy-subscription-rule-/);

    const exactSubscriptionRetry = await one(db, `
      update public.subscriptions
      set amount = 349
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning version, last_operation_id
    `, [OWNER_A]);
    const ruleAfterExactSubscriptionRetry = await one(db, `
      select version, last_operation_id
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        subscriptionVersion: numeric(exactSubscriptionRetry.version),
        subscriptionOperation: exactSubscriptionRetry.last_operation_id,
        ruleVersion: numeric(ruleAfterExactSubscriptionRetry.version),
        ruleOperation: ruleAfterExactSubscriptionRetry.last_operation_id,
      },
      {
        subscriptionVersion: 3,
        subscriptionOperation: updatedSubscription.last_operation_id,
        ruleVersion: 3,
        ruleOperation: selectivelyUpdatedRule.last_operation_id,
      },
      'An exact legacy subscription retry must not manufacture another rule version',
    );

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_B]);
    const otherOwnerSubscription = await one(db, `
      insert into public.subscriptions
        (id, user_id, name, amount, category, account, recurring_date)
      values
        ('legacy-subscription-after-migration', $1, '另一位使用者', 88, '娛樂', '銀行', 8)
      returning version, last_operation_id
    `, [OWNER_B]);
    const otherOwnerRuleBeforeInvalidation = await one(db, `
      select version, last_operation_id, is_active, deleted_at
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_B]);
    assert.equal(numeric(otherOwnerSubscription.version), 1);

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    const pausedV3Rule = await one(db, `
      update public.recurring_rules
      set is_active = false, version = 4,
        updated_at = '2026-08-23T13:00:00Z',
        last_operation_id = 'v3-subscription-rule-paused-clock-4'
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning version, is_active, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        version: numeric(pausedV3Rule.version),
        isActive: pausedV3Rule.is_active,
      },
      { version: 4, isActive: false },
    );

    const hiddenPausedSubscription = await one(db, `
      select count(*)::integer as count
      from public.subscriptions
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.equal(
      numeric(hiddenPausedSubscription.count),
      0,
      'A paused v3 recurring rule must disappear from headerless legacy subscription reads',
    );
    await db.query(
      "select set_config('request.headers', '{\"x-shiba-finance-client\":\"v3\"}', false)",
    );
    const v3VisiblePausedSubscription = await one(db, `
      select count(*)::integer as count
      from public.subscriptions
      where user_id = $1 and id = 'legacy-subscription-after-migration'
        and not is_active
    `, [OWNER_A]);
    assert.equal(
      numeric(v3VisiblePausedSubscription.count),
      1,
      'The v3 capability must retain the paused legacy mirror for reconciliation',
    );

    const invalidatedSubscription = await one(db, `
      update public.subscriptions
      set account = '   '
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning requires_review, version, last_operation_id
    `, [OWNER_A]);
    const ruleAfterInvalidation = await one(db, `
      select name, amount,
        to_char(next_occurrence_date, 'YYYY-MM-DD') as next_occurrence_date,
        is_active, deleted_at is not null as deleted, version, last_operation_id
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        requiresReview: invalidatedSubscription.requires_review,
        subscriptionVersion: numeric(invalidatedSubscription.version),
        ruleName: ruleAfterInvalidation.name,
        ruleAmount: numeric(ruleAfterInvalidation.amount),
        nextOccurrenceDate: String(ruleAfterInvalidation.next_occurrence_date),
        ruleActive: ruleAfterInvalidation.is_active,
        ruleDeleted: ruleAfterInvalidation.deleted,
        ruleVersion: numeric(ruleAfterInvalidation.version),
      },
      {
        requiresReview: true,
        subscriptionVersion: 5,
        ruleName: 'v3 裝置上的名稱',
        ruleAmount: 349,
        nextOccurrenceDate: '2027-01-31',
        ruleActive: false,
        ruleDeleted: true,
        ruleVersion: 5,
      },
      'Invalid legacy subscription data must be preserved for review while its rule fails closed',
    );
    assert.match(invalidatedSubscription.last_operation_id, /^legacy-update-/);
    assert.match(ruleAfterInvalidation.last_operation_id, /^legacy-subscription-invalid-paused-/);

    const invalidRetry = await one(db, `
      update public.subscriptions
      set account = '   '
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning version, last_operation_id
    `, [OWNER_A]);
    const ruleAfterInvalidRetry = await one(db, `
      select version, last_operation_id
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        subscriptionVersion: numeric(invalidRetry.version),
        subscriptionOperation: invalidRetry.last_operation_id,
        ruleVersion: numeric(ruleAfterInvalidRetry.version),
        ruleOperation: ruleAfterInvalidRetry.last_operation_id,
      },
      {
        subscriptionVersion: 5,
        subscriptionOperation: invalidatedSubscription.last_operation_id,
        ruleVersion: 5,
        ruleOperation: ruleAfterInvalidation.last_operation_id,
      },
      'Retrying the same invalid legacy payload must not advance either clock',
    );

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_B]);
    const otherOwnerRuleAfterInvalidation = await one(db, `
      select version, last_operation_id, is_active, deleted_at
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_B]);
    assert.deepEqual(
      otherOwnerRuleAfterInvalidation,
      otherOwnerRuleBeforeInvalidation,
      'Invalidating one owner subscription must not touch a same-ID rule owned by another user',
    );

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    const repairedSubscription = await one(db, `
      update public.subscriptions
      set account = '街口支付'
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning requires_review, version, last_operation_id
    `, [OWNER_A]);
    const repairedRule = await one(db, `
      select account_id, account_name,
        to_char(next_occurrence_date, 'YYYY-MM-DD') as next_occurrence_date,
        is_active, deleted_at, version, last_operation_id
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        requiresReview: repairedSubscription.requires_review,
        subscriptionVersion: numeric(repairedSubscription.version),
        accountId: repairedRule.account_id,
        accountName: repairedRule.account_name,
        nextOccurrenceDate: String(repairedRule.next_occurrence_date),
        isActive: repairedRule.is_active,
        deletedAt: repairedRule.deleted_at,
        ruleVersion: numeric(repairedRule.version),
      },
      {
        requiresReview: false,
        subscriptionVersion: 6,
        accountId: stableLegacyId('account', OWNER_A, '街口支付'),
        accountName: '街口支付',
        nextOccurrenceDate: '2027-01-31',
        isActive: false,
        deletedAt: null,
        ruleVersion: 6,
      },
      'Repairing invalid legacy data must restore the rule without reviving a newer v3 pause',
    );
    assert.match(repairedRule.last_operation_id, /^legacy-subscription-rule-/);

    const repairedRetry = await one(db, `
      update public.subscriptions
      set account = '街口支付'
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning version, last_operation_id
    `, [OWNER_A]);
    const ruleAfterRepairedRetry = await one(db, `
      select version, last_operation_id
      from public.recurring_rules
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        subscriptionVersion: numeric(repairedRetry.version),
        subscriptionOperation: repairedRetry.last_operation_id,
        ruleVersion: numeric(ruleAfterRepairedRetry.version),
        ruleOperation: ruleAfterRepairedRetry.last_operation_id,
      },
      {
        subscriptionVersion: 6,
        subscriptionOperation: repairedSubscription.last_operation_id,
        ruleVersion: 6,
        ruleOperation: repairedRule.last_operation_id,
      },
      'Retrying a repaired legacy payload must remain clock-idempotent',
    );

    const resumedV3Rule = await one(db, `
      update public.recurring_rules
      set is_active = true, version = 7,
        updated_at = '2026-08-23T14:00:00Z',
        last_operation_id = 'v3-subscription-rule-resumed-clock-7'
      where user_id = $1 and id = 'legacy-subscription-after-migration'
      returning version, is_active, deleted_at
    `, [OWNER_A]);
    const resumedLegacyMirror = await one(db, `
      select version, is_active, deleted_at
      from public.subscriptions
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.deepEqual(
      {
        ruleVersion: numeric(resumedV3Rule.version),
        ruleActive: resumedV3Rule.is_active,
        ruleDeletedAt: resumedV3Rule.deleted_at,
        subscriptionVersion: numeric(resumedLegacyMirror.version),
        subscriptionActive: resumedLegacyMirror.is_active,
        subscriptionDeletedAt: resumedLegacyMirror.deleted_at,
      },
      {
        ruleVersion: 7,
        ruleActive: true,
        ruleDeletedAt: null,
        subscriptionVersion: 7,
        subscriptionActive: true,
        subscriptionDeletedAt: null,
      },
      'Resuming a monthly v3 rule must restore exactly one legacy-visible subscription mirror',
    );
    await db.query("select set_config('request.headers', '{}', false)");
    const legacyVisibleResumedSubscription = await one(db, `
      select count(*)::integer as count
      from public.subscriptions
      where user_id = $1 and id = 'legacy-subscription-after-migration'
    `, [OWNER_A]);
    assert.equal(numeric(legacyVisibleResumedSubscription.count), 1);

    await assert.rejects(
      db.query(`
        insert into public.transactions
          (id, user_id, amount, type, category, date, account)
        values ('invalid-future-transaction', $1, -1, 'expense', '餐飲', '2026-08-22', '現金')
      `, [OWNER_A]),
      /finance_v3_transactions_amount_check|check constraint/i,
      'NOT VALID must still reject an invalid future transaction',
    );
    await assert.rejects(
      db.query(`
        insert into public.budgets (id, user_id, category, period, amount)
        values ('invalid-future-budget', $1, null, 'rolling', 100)
      `, [OWNER_A]),
      /finance_v3_budgets_period_check|check constraint/i,
      'NOT VALID must still reject an invalid future budget',
    );
  } finally {
    await db.exec('reset role');
  }
}

async function verifyV3GoalUpsertPreservesLegacyTotal(db) {
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
  try {
    const upsertV3GoalProposal = (name = '旅行 v3 updated') => one(db, `
      insert into public.goals (
        id, user_id, name, target_amount, current_amount, unit, target_date,
        is_active, legacy_unit, version, updated_at, last_operation_id, deleted_at
      ) values (
        'goal-a', $1, $2, 12000, 0, '元', '2027-01-01',
        true, '元', 2, '2026-08-21T11:00:00Z', 'v3-goal-clock-2', null
      )
      on conflict (user_id, id) do update set
        name = excluded.name,
        target_amount = excluded.target_amount,
        current_amount = excluded.current_amount,
        unit = excluded.unit,
        target_date = excluded.target_date,
        is_active = excluded.is_active,
        legacy_unit = excluded.legacy_unit,
        version = excluded.version,
        updated_at = excluded.updated_at,
        last_operation_id = excluded.last_operation_id,
        deleted_at = excluded.deleted_at
      returning name, current_amount, unit, version, last_operation_id
    `, [OWNER_A, name]);

    const updatedGoal = await upsertV3GoalProposal();
    assert.deepEqual(
      {
        name: updatedGoal.name,
        currentAmount: numeric(updatedGoal.current_amount),
        unit: updatedGoal.unit,
        version: numeric(updatedGoal.version),
        lastOperationId: updatedGoal.last_operation_id,
      },
      {
        name: '旅行 v3 updated',
        currentAmount: 1500,
        unit: '元',
        version: 2,
        lastOperationId: 'v3-goal-clock-2',
      },
      'A newer v3 UPSERT must not apply INSERT defaults to legacy-only goal columns',
    );

    const afterV3Update = await one(db, `
      select count(*)::integer as count, sum(amount_delta) as total
      from public.savings_allocations
      where user_id = $1 and goal_id = 'goal-a'
    `, [OWNER_A]);
    assert.deepEqual(
      { count: numeric(afterV3Update.count), total: numeric(afterV3Update.total) },
      { count: 1, total: 1500 },
      'A v3 goal UPSERT must not manufacture an allocation from legacy-column defaults',
    );

    const exactRetry = await upsertV3GoalProposal();
    assert.deepEqual(
      {
        currentAmount: numeric(exactRetry.current_amount),
        unit: exactRetry.unit,
        version: numeric(exactRetry.version),
        lastOperationId: exactRetry.last_operation_id,
      },
      {
        currentAmount: 1500,
        unit: '元',
        version: 2,
        lastOperationId: 'v3-goal-clock-2',
      },
      'An acknowledged v3 goal UPSERT must be safe to retry with the same proposal',
    );

    await assert.rejects(
      upsertV3GoalProposal('same clock divergent payload'),
      /conflicting payload for identical finance sync clock/i,
      'The statement-context bridge must not hide a divergent payload at the same v3 clock',
    );

    const legacyUpdate = await one(db, `
      update public.goals
      set current_amount = 1600
      where user_id = $1 and id = 'goal-a'
      returning current_amount, unit, version, last_operation_id
    `, [OWNER_A]);
    assert.equal(numeric(legacyUpdate.current_amount), 1600);
    assert.equal(legacyUpdate.unit, '元');
    assert.equal(numeric(legacyUpdate.version), 3);
    assert.match(legacyUpdate.last_operation_id, /^legacy-update-/);

    const afterLegacyUpdate = await one(db, `
      select count(*)::integer as count, sum(amount_delta) as total
      from public.savings_allocations
      where user_id = $1 and goal_id = 'goal-a'
    `, [OWNER_A]);
    assert.deepEqual(
      { count: numeric(afterLegacyUpdate.count), total: numeric(afterLegacyUpdate.total) },
      { count: 2, total: 1600 },
      'A same-clock pre-v3 current_amount UPDATE must remain an auditable allocation delta',
    );
  } finally {
    await db.exec('reset role');
  }
}

async function legacyDeleteSnapshot(db) {
  const snapshot = await one(db, `
    select
      (select version from public.transactions
        where user_id = $1 and id = 'legacy-after-migration') as transaction_version,
      (select last_operation_id from public.transactions
        where user_id = $1 and id = 'legacy-after-migration') as transaction_operation,
      (select deleted_at is not null from public.transactions
        where user_id = $1 and id = 'legacy-after-migration') as transaction_deleted,
      (select version from public.budgets
        where user_id = $1 and id = 'legacy-budget-after-migration') as budget_version,
      (select last_operation_id from public.budgets
        where user_id = $1 and id = 'legacy-budget-after-migration') as budget_operation,
      (select deleted_at is not null from public.budgets
        where user_id = $1 and id = 'legacy-budget-after-migration') as budget_deleted,
      (select version from public.goals
        where user_id = $1 and id = 'legacy-goal-after-migration') as goal_version,
      (select last_operation_id from public.goals
        where user_id = $1 and id = 'legacy-goal-after-migration') as goal_operation,
      (select deleted_at is not null and not is_active from public.goals
        where user_id = $1 and id = 'legacy-goal-after-migration') as goal_deleted,
      (select count(*)::integer from public.savings_allocations
        where user_id = $1 and goal_id = 'legacy-goal-after-migration') as allocation_count,
      (select count(*)::integer from public.savings_allocations
        where user_id = $1 and goal_id = 'legacy-goal-after-migration'
          and deleted_at is null) as live_allocation_count,
      (select min(version) from public.savings_allocations
        where user_id = $1 and goal_id = 'legacy-goal-after-migration') as allocation_min_version,
      (select version from public.subscriptions
        where user_id = $1 and id = 'legacy-subscription-after-migration') as subscription_version,
      (select last_operation_id from public.subscriptions
        where user_id = $1 and id = 'legacy-subscription-after-migration') as subscription_operation,
      (select deleted_at is not null and not is_active from public.subscriptions
        where user_id = $1 and id = 'legacy-subscription-after-migration') as subscription_deleted,
      (select version from public.recurring_rules
        where user_id = $1 and id = 'legacy-subscription-after-migration') as rule_version,
      (select last_operation_id from public.recurring_rules
        where user_id = $1 and id = 'legacy-subscription-after-migration') as rule_operation,
      (select deleted_at is not null and not is_active from public.recurring_rules
        where user_id = $1 and id = 'legacy-subscription-after-migration') as rule_deleted,
      (select deleted_at is null from public.transactions
        where user_id = $2 and id = 'txn-b') as other_owner_transaction_live
  `, [OWNER_A, OWNER_B]);
  return {
    transactionVersion: numeric(snapshot.transaction_version),
    transactionOperation: snapshot.transaction_operation,
    transactionDeleted: snapshot.transaction_deleted,
    budgetVersion: numeric(snapshot.budget_version),
    budgetOperation: snapshot.budget_operation,
    budgetDeleted: snapshot.budget_deleted,
    goalVersion: numeric(snapshot.goal_version),
    goalOperation: snapshot.goal_operation,
    goalDeleted: snapshot.goal_deleted,
    allocationCount: numeric(snapshot.allocation_count),
    liveAllocationCount: numeric(snapshot.live_allocation_count),
    allocationMinVersion: numeric(snapshot.allocation_min_version),
    subscriptionVersion: numeric(snapshot.subscription_version),
    subscriptionOperation: snapshot.subscription_operation,
    subscriptionDeleted: snapshot.subscription_deleted,
    ruleVersion: numeric(snapshot.rule_version),
    ruleOperation: snapshot.rule_operation,
    ruleDeleted: snapshot.rule_deleted,
    otherOwnerTransactionLive: snapshot.other_owner_transaction_live,
  };
}

async function verifyPostMigrationLegacyDeletes(db) {
  await db.exec('set role authenticated');
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_B]);
    const foreignDelete = await db.query(`
      delete from public.transactions
      where user_id = $1 and id = 'legacy-after-migration'
      returning id
    `, [OWNER_A]);
    assert.deepEqual(
      foreignDelete.rows,
      [],
      'RLS must prevent another owner from invoking the legacy delete bridge',
    );

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    for (const [table, id] of [
      ['transactions', 'legacy-after-migration'],
      ['budgets', 'legacy-budget-after-migration'],
      ['goals', 'legacy-goal-after-migration'],
      ['subscriptions', 'legacy-subscription-after-migration'],
    ]) {
      await db.query(`delete from public.${table} where user_id = $1 and id = $2`, [OWNER_A, id]);
    }

    const legacyVisibleAfterDelete = await one(db, `
      select
        (select count(*)::integer from public.transactions
          where user_id = $1 and id = 'legacy-after-migration') as transactions,
        (select count(*)::integer from public.budgets
          where user_id = $1 and id = 'legacy-budget-after-migration') as budgets,
        (select count(*)::integer from public.goals
          where user_id = $1 and id = 'legacy-goal-after-migration') as goals,
        (select count(*)::integer from public.subscriptions
          where user_id = $1 and id = 'legacy-subscription-after-migration') as subscriptions
    `, [OWNER_A]);
    assert.deepEqual(
      Object.fromEntries(Object.entries(legacyVisibleAfterDelete).map(([key, value]) => [key, numeric(value)])),
      { transactions: 0, budgets: 0, goals: 0, subscriptions: 0 },
      'A legacy client without the v3 capability header must not reload tombstones as live rows',
    );

    await db.query(
      "select set_config('request.headers', '{\"x-shiba-finance-client\":\"v3\"}', false)",
    );
    const v3VisibleTombstones = await one(db, `
      select
        (select count(*)::integer from public.transactions
          where user_id = $1 and id = 'legacy-after-migration' and deleted_at is not null) as transactions,
        (select count(*)::integer from public.budgets
          where user_id = $1 and id = 'legacy-budget-after-migration' and deleted_at is not null) as budgets,
        (select count(*)::integer from public.goals
          where user_id = $1 and id = 'legacy-goal-after-migration' and deleted_at is not null) as goals,
        (select count(*)::integer from public.subscriptions
          where user_id = $1 and id = 'legacy-subscription-after-migration' and deleted_at is not null) as subscriptions
    `, [OWNER_A]);
    assert.deepEqual(
      Object.fromEntries(Object.entries(v3VisibleTombstones).map(([key, value]) => [key, numeric(value)])),
      { transactions: 1, budgets: 1, goals: 1, subscriptions: 1 },
      'The v3 capability header must retain owner-scoped tombstones for reconciliation',
    );
    await db.query("select set_config('request.headers', '{}', false)");

    await db.exec('reset role');
    const first = await legacyDeleteSnapshot(db);
    assert.deepEqual(
      {
        transactionVersion: first.transactionVersion,
        transactionDeleted: first.transactionDeleted,
        budgetVersion: first.budgetVersion,
        budgetDeleted: first.budgetDeleted,
        goalVersion: first.goalVersion,
        goalDeleted: first.goalDeleted,
        allocationCount: first.allocationCount,
        liveAllocationCount: first.liveAllocationCount,
        allocationMinVersion: first.allocationMinVersion,
        subscriptionVersion: first.subscriptionVersion,
        subscriptionDeleted: first.subscriptionDeleted,
        ruleVersion: first.ruleVersion,
        ruleDeleted: first.ruleDeleted,
        otherOwnerTransactionLive: first.otherOwnerTransactionLive,
      },
      {
        transactionVersion: 3,
        transactionDeleted: true,
        budgetVersion: 3,
        budgetDeleted: true,
        goalVersion: 3,
        goalDeleted: true,
        allocationCount: 2,
        liveAllocationCount: 0,
        allocationMinVersion: 2,
        subscriptionVersion: 8,
        subscriptionDeleted: true,
        ruleVersion: 8,
        ruleDeleted: true,
        otherOwnerTransactionLive: true,
      },
      'Legacy deletes must become auditable tombstones without crossing owners',
    );
    assert.match(first.transactionOperation, /^legacy-delete-/);
    assert.match(first.budgetOperation, /^legacy-delete-/);
    assert.match(first.goalOperation, /^legacy-delete-/);
    assert.match(first.subscriptionOperation, /^legacy-delete-/);
    assert.match(first.ruleOperation, /^legacy-delete-rule-/);

    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    for (const [table, id] of [
      ['transactions', 'legacy-after-migration'],
      ['budgets', 'legacy-budget-after-migration'],
      ['goals', 'legacy-goal-after-migration'],
      ['subscriptions', 'legacy-subscription-after-migration'],
    ]) {
      await db.query(`delete from public.${table} where user_id = $1 and id = $2`, [OWNER_A, id]);
    }
    await db.exec('reset role');

    const exactRetry = await legacyDeleteSnapshot(db);
    assert.deepEqual(
      exactRetry,
      first,
      'Retrying an already tombstoned legacy delete must preserve every conflict clock',
    );
    return first;
  } finally {
    await db.exec('reset role');
  }
}

async function verifyOwnerRlsAndConflictClock(db) {
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);

  const visibleOwners = await db.query(`
    select distinct user_id::text as user_id
    from public.accounts
    order by user_id
  `);
  assert.deepEqual(visibleOwners.rows, [{ user_id: OWNER_A }], 'RLS must not return another owner');

  await assert.rejects(
    db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values ($1, 'foreign-write', 'forbidden', 'vector', 'wallet', 0,
        true, true, 0, 1, now(), 'foreign-op')
    `, [OWNER_B]),
    /row-level security/i,
    'Authenticated owner A must not insert owner B data',
  );

  const accountId = stableLegacyId('account', OWNER_A, '現金');
  const upsertAccount = async (name, version, operationId, updatedAt = '2026-08-21T10:00:00.000Z') => one(db, `
    insert into public.accounts (
      user_id, id, name, icon_type, icon_value, opening_balance,
      include_in_total_assets, is_active, sort_order, version,
      updated_at, last_operation_id
    ) values ($1, $2, $3, 'emoji', '💵', 0, true, true, 0, $4, $6, $5)
    on conflict (user_id, id) do update set
      name = excluded.name,
      version = excluded.version,
      updated_at = excluded.updated_at,
      last_operation_id = excluded.last_operation_id
    returning name, version, last_operation_id
  `, [OWNER_A, accountId, name, version, operationId, updatedAt]);

  const newest = await upsertAccount('newest value', 2, 'op-newer');
  assert.deepEqual(
    { name: newest.name, version: numeric(newest.version), lastOperationId: newest.last_operation_id },
    { name: 'newest value', version: 2, lastOperationId: 'op-newer' },
  );

  const exactRetry = await upsertAccount('newest value', 2, 'op-newer');
  assert.deepEqual(
    { name: exactRetry.name, version: numeric(exactRetry.version), lastOperationId: exactRetry.last_operation_id },
    { name: 'newest value', version: 2, lastOperationId: 'op-newer' },
    'An exact acknowledged retry must remain idempotently accepted',
  );

  await assert.rejects(
    upsertAccount('different payload with same clock', 2, 'op-newer'),
    /conflicting payload for identical finance sync clock/i,
    'The same conflict clock must never authorize a different payload',
  );

  const staleReturning = await upsertAccount('stale value', 1, 'op-older');
  assert.deepEqual(
    {
      name: staleReturning.name,
      version: numeric(staleReturning.version),
      lastOperationId: staleReturning.last_operation_id,
    },
    { name: 'newest value', version: 2, lastOperationId: 'op-newer' },
    'A stale UPSERT must return and retain the existing conflict clock',
  );

  await db.exec('reset role');
}

async function verifyLegacyRetryRlsAndClock() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseAuth(db);
    const { longAccountName } = await createLegacyFixture(db);
    await db.exec(migrationSql);
    await verifyLegacyOwnerScopedPrimaryKeys(db);
    await verifyLegacyBackfill(db, longAccountName);

    // The legacy fixture intentionally starts with no authoritative opening
    // balances. Give the mixed-version write exercises real available assets;
    // preserved legacy over-allocation itself remains covered by the backfill
    // assertions above, while future increases are subject to the new gate.
    await db.query(`
      update public.accounts
      set opening_balance = 20000,
        version = version + 1,
        updated_at = clock_timestamp(),
        last_operation_id = 'fixture-fund-mixed-version-writes'
      where user_id = $1 and legacy_key = '現金'
    `, [OWNER_A]);

    await db.exec(migrationSql);
    const repeatCounts = await one(db, `
      select
        (select count(*)::integer from public.savings_allocations where user_id = $1) as allocations,
        (select count(*)::integer from public.recurring_rules where user_id = $1) as recurring_rules,
        (select count(*)::integer from public.settings where user_id = $1) as settings
    `, [OWNER_A]);
    assert.deepEqual(
      {
        allocations: numeric(repeatCounts.allocations),
        recurringRules: numeric(repeatCounts.recurring_rules),
        settings: numeric(repeatCounts.settings),
      },
      { allocations: 1, recurringRules: 1, settings: 1 },
      'Retrying the migration must not duplicate deterministic data',
    );
    await verifyLegacyOwnerScopedPrimaryKeys(db, true);

    await verifyV3GoalUpsertPreservesLegacyTotal(db);
    await verifyPostMigrationLegacyWrites(db);
    const deleteSnapshot = await verifyPostMigrationLegacyDeletes(db);

    // A reviewed migration may be retried after old clients have continued to
    // write. The one-time backfill must not duplicate bridge-created goal
    // allocations or rewrite their conflict clocks.
    await db.exec(migrationSql);
    await verifyLegacyOwnerScopedPrimaryKeys(db);
    const bridgeRetry = await one(db, `
      select
        (select count(*)::integer from public.savings_allocations
          where user_id = $1 and goal_id = 'legacy-goal-after-migration') as allocation_count,
        (select sum(amount_delta) from public.savings_allocations
          where user_id = $1 and goal_id = 'legacy-goal-after-migration') as allocation_total,
        (select version from public.transactions
          where user_id = $1 and id = 'legacy-after-migration') as transaction_version,
        (select version from public.budgets
          where user_id = $1 and id = 'legacy-budget-after-migration') as budget_version,
        (select current_amount from public.goals
          where user_id = $1 and id = 'goal-a') as goal_a_current_amount,
        (select version from public.goals
          where user_id = $1 and id = 'goal-a') as goal_a_version,
        (select count(*)::integer from public.savings_allocations
          where user_id = $1 and goal_id = 'goal-a') as goal_a_allocation_count,
        (select sum(amount_delta) from public.savings_allocations
          where user_id = $1 and goal_id = 'goal-a') as goal_a_allocation_total
    `, [OWNER_A]);
    assert.deepEqual(
      {
        allocationCount: numeric(bridgeRetry.allocation_count),
        allocationTotal: numeric(bridgeRetry.allocation_total),
        transactionVersion: numeric(bridgeRetry.transaction_version),
        budgetVersion: numeric(bridgeRetry.budget_version),
        goalACurrentAmount: numeric(bridgeRetry.goal_a_current_amount),
        goalAVersion: numeric(bridgeRetry.goal_a_version),
        goalAAllocationCount: numeric(bridgeRetry.goal_a_allocation_count),
        goalAAllocationTotal: numeric(bridgeRetry.goal_a_allocation_total),
      },
      {
        allocationCount: 2,
        allocationTotal: 350,
        transactionVersion: deleteSnapshot.transactionVersion,
        budgetVersion: deleteSnapshot.budgetVersion,
        goalACurrentAmount: 1600,
        goalAVersion: 3,
        goalAAllocationCount: 2,
        goalAAllocationTotal: 1600,
      },
      'Retrying after mixed-version writes must not duplicate or rewrite bridged data',
    );

    await verifyOwnerRlsAndConflictClock(db);
  } finally {
    if (!db.closed) await db.close();
  }
}

async function verifyLegacyNegativeGoalDeleteTombstonesAtomically() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseAuth(db);
    await db.exec(`
      insert into auth.users (id) values ('${OWNER_A}');
      create table public.goals (
        id text primary key,
        user_id uuid not null references auth.users (id) on delete cascade,
        name text not null,
        target_amount numeric not null,
        current_amount numeric not null,
        unit text not null,
        target_date text
      );
      insert into public.goals (
        id, user_id, name, target_amount, current_amount, unit, target_date
      ) values (
        'legacy-negative-goal', '${OWNER_A}', '舊版負配置目標', 100, -50, '元', null
      );
    `);
    await db.exec(migrationSql);

    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values (
        $1, 'legacy-negative-cash', '現金', 'vector', 'wallet', 50,
        true, true, 0, 1, now(), 'legacy-negative-cash-op-1'
      )
    `, [OWNER_A]);
    await db.query(`
      insert into public.savings_allocations (
        user_id, id, goal_id, amount_delta, occurred_at,
        version, updated_at, last_operation_id
      ) values (
        $1, 'legacy-negative-positive-allocation', 'legacy-negative-goal', 100,
        '2026-08-23', 1, now(), 'legacy-negative-positive-allocation-op-1'
      )
    `, [OWNER_A]);

    await db.query(`
      delete from public.goals
      where user_id = $1 and id = 'legacy-negative-goal'
    `, [OWNER_A]);

    await db.query(
      "select set_config('request.headers', '{\"x-shiba-finance-client\":\"v3\"}', false)",
    );
    const tombstoned = await one(db, `
      select goal.deleted_at is not null as goal_deleted,
        goal.current_amount, goal.version, goal.last_operation_id,
        count(allocation.id)::integer as allocation_count,
        count(allocation.id) filter (where allocation.deleted_at is null)::integer
          as live_allocation_count
      from public.goals as goal
      left join public.savings_allocations as allocation
        on allocation.user_id = goal.user_id and allocation.goal_id = goal.id
      where goal.user_id = $1 and goal.id = 'legacy-negative-goal'
      group by goal.user_id, goal.id, goal.deleted_at, goal.current_amount,
        goal.version, goal.last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        goalDeleted: tombstoned.goal_deleted,
        currentAmount: numeric(tombstoned.current_amount),
        version: numeric(tombstoned.version),
        allocationCount: numeric(tombstoned.allocation_count),
        liveAllocationCount: numeric(tombstoned.live_allocation_count),
      },
      {
        goalDeleted: true,
        currentAmount: 0,
        version: 2,
        allocationCount: 2,
        liveAllocationCount: 0,
      },
      'Deleting a migrated negative goal must atomically tombstone every allocation without an order-dependent capacity failure',
    );
    assert.match(
      tombstoned.last_operation_id,
      /^legacy-delete-/,
      'The compatibility projection must not consume or replace the goal tombstone clock',
    );
  } finally {
    await db.exec('reset role');
    await db.close();
  }
}

async function verifyServerResourceAbuseGuards() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseAuth(db);
    await db.exec(`
      insert into auth.users (id) values ('${OWNER_A}'), ('${OWNER_B}');
    `);
    await db.exec(migrationSql);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);

    await assert.rejects(
      db.query(`
        insert into public.accounts (
          user_id, id, name, icon_type, icon_value, opening_balance,
          include_in_total_assets, is_active, sort_order, version,
          updated_at, last_operation_id
        ) values (
          $1, 'oversized-name', repeat('x', 513), 'vector', 'wallet', 0,
          true, true, 0, 1, now(), 'oversized-name-op'
        )
      `, [OWNER_A]),
      /text length|check constraint/i,
      'Server-side text limits must reject oversized authenticated writes',
    );

    await assert.rejects(
      db.query(`
        insert into public.accounts (
          user_id, id, name, icon_type, icon_value, opening_balance,
          include_in_total_assets, is_active, sort_order, version,
          updated_at, last_operation_id
        ) values (
          $1, 'oversized-numeric', 'Oversized numeric', 'vector', 'wallet',
          1e1000, true, true, 0, 1, now(), 'oversized-numeric-op'
        )
      `, [OWNER_A]),
      /numeric magnitude|check constraint/i,
      'Server-side numeric limits must reject values the client cannot safely decode',
    );

    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values (
        $1, 'legacy-precision', 'Legacy precision', 'vector', 'wallet',
        1.234, true, true, 0, 1, now(), 'legacy-precision-op'
      )
    `, [OWNER_A]);

    await assert.rejects(
      db.query(`
        insert into public.accounts (
          user_id, id, name, icon_type, icon_value, opening_balance,
          include_in_total_assets, is_active, sort_order, version,
          updated_at, last_operation_id
        ) values (
          $1, 'unsafe-money-bound', 'Unsafe money bound', 'vector', 'wallet',
          100000000.01, true, true, 0, 1, now(), 'unsafe-money-bound-op'
        )
      `, [OWNER_A]),
      /numeric magnitude|check constraint/i,
      'Server-side numeric limits must share the client safe monetary bound',
    );

    await assert.rejects(
      db.query(`
        insert into public.accounts (
          user_id, id, name, icon_type, icon_value, opening_balance,
          include_in_total_assets, is_active, sort_order, version,
          updated_at, last_operation_id
        ) values (
          $1, 'unsupported-precision', 'Unsupported precision', 'vector', 'wallet',
          1.2345678, true, true, 0, 1, now(), 'unsupported-precision-op'
        )
      `, [OWNER_A]),
      /numeric precision|check constraint/i,
      'Server-side numeric limits must reject values the client cannot decode losslessly',
    );

    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      )
      select $1, 'quota-account-' || item, 'Account ' || item, 'vector', 'wallet', 0,
        true, true, item, 1, now(), 'quota-account-op-' || item
      from generate_series(1, 249) as item
    `, [OWNER_A]);

    await assert.rejects(
      db.query(`
        insert into public.accounts (
          user_id, id, name, icon_type, icon_value, opening_balance,
          include_in_total_assets, is_active, sort_order, version,
          updated_at, last_operation_id
        ) values (
          $1, 'quota-account-251', 'Account 251', 'vector', 'wallet', 0,
          true, true, 251, 1, now(), 'quota-account-op-251'
        )
      `, [OWNER_A]),
      /owner resource limit/i,
      'One authenticated owner must not consume unbounded database rows',
    );

    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values (
        $1, 'quota-account-249', 'Updated Account 249', 'vector', 'wallet', 0,
        true, true, 249, 2, now(), 'quota-account-op-249-update'
      ) on conflict (user_id, id) do update set
        name = excluded.name,
        version = excluded.version,
        last_operation_id = excluded.last_operation_id
    `, [OWNER_A]);

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_B]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values (
        $1, 'owner-b-first-account', 'Owner B', 'vector', 'wallet', 0,
        true, true, 0, 1, now(), 'owner-b-first-account-op'
      )
    `, [OWNER_B]);

    await db.exec('reset role');
    await db.exec(`
      alter table public.budgets disable trigger finance_v3_10_owner_resource_limit;
      insert into public.budgets (
        user_id, id, scope, period, amount, is_active, version,
        updated_at, last_operation_id, deleted_at
      )
      select '${OWNER_A}', 'hidden-budget-' || item, 'overall', 'monthly', 1,
        false, 1, now(), 'hidden-budget-op-' || item, now()
      from generate_series(1, 2000) as item;
      alter table public.budgets enable trigger finance_v3_10_owner_resource_limit;
      set role authenticated;
      select set_config('request.jwt.claim.sub', '${OWNER_A}', false);
    `);
    await assert.rejects(
      db.query(`
        insert into public.budgets (
          user_id, id, scope, period, amount, is_active, version,
          updated_at, last_operation_id
        ) values (
          $1, 'hidden-budget-2001', 'overall', 'monthly', 1, true, 1,
          now(), 'hidden-budget-op-2001'
        )
      `, [OWNER_A]),
      /owner resource limit/i,
      'Quota counts must include tombstones hidden by legacy headerless RLS',
    );
  } finally {
    await db.exec('reset role');
    await db.close();
  }
}

async function verifyAtomicTransfers() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseAuth(db);
    await db.exec(`insert into auth.users (id) values ('${OWNER_A}'), ('${OWNER_B}')`);
    await db.exec(migrationSql);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);

    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values
        ($1, 'included-a', '計入 A', 'vector', 'wallet', 1000, true, true, 1, 1, now(), 'account-a-op'),
        ($1, 'included-b', '計入 B', 'vector', 'wallet', 1000, true, true, 2, 1, now(), 'account-b-op'),
        ($1, 'excluded-a', '排除 A', 'vector', 'wallet', 0, false, true, 3, 1, now(), 'account-c-op'),
        ($1, 'excluded-b', '排除 B', 'vector', 'wallet', 0, false, true, 4, 1, now(), 'account-d-op')
    `, [OWNER_A]);

    const historicalAccountRows = [{
      user_id: OWNER_A,
      id: 'historical-archived-source',
      name: '目前銀行名',
      icon_type: 'vector',
      icon_value: 'wallet',
      opening_balance: 500,
      include_in_total_assets: false,
      is_active: false,
      sort_order: 10,
      legacy_key: null,
      requires_review: false,
      version: 2,
      updated_at: '2026-08-28T01:00:00.000Z',
      last_operation_id: 'historical-source-archive-op',
      deleted_at: null,
    }, {
      user_id: OWNER_A,
      id: 'historical-active-destination',
      name: '現金',
      icon_type: 'vector',
      icon_value: 'wallet',
      opening_balance: 0,
      include_in_total_assets: false,
      is_active: true,
      sort_order: 11,
      legacy_key: null,
      requires_review: false,
      version: 1,
      updated_at: '2026-08-28T01:00:00.000Z',
      last_operation_id: 'historical-destination-op',
      deleted_at: null,
    }];
    const historicalTransferRows = [{
      user_id: OWNER_A,
      id: 'historical-imported-transfer',
      amount: 250,
      source_account_id: 'historical-archived-source',
      source_account_name: '舊銀行名',
      destination_account_id: 'historical-active-destination',
      destination_account_name: '現金',
      occurred_at: '2026-08-20 08:00',
      note: null,
      version: 1,
      updated_at: '2026-08-28T01:00:00.000Z',
      last_operation_id: 'historical-transfer-op',
      deleted_at: null,
    }];
    const trustedHistoricalImport = async (
      batchId,
      accountRows,
      endpointRows,
      transferRows,
      ownerId = OWNER_A,
    ) => {
      await db.exec('reset role; set role service_role');
      try {
        return await db.query(`
          select entity, id, version, last_operation_id
          from public.finance_import_historical_transfer_batch(
            $1::uuid, $2, $3::jsonb, $4::jsonb, $5::jsonb
          )
          order by entity, id
        `, [
          ownerId,
          batchId,
          JSON.stringify(accountRows),
          JSON.stringify(endpointRows),
          JSON.stringify(transferRows),
        ]);
      } finally {
        await db.exec('reset role; set role authenticated');
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
      }
    };
    await assert.rejects(
      db.query(`
        select * from public.finance_import_historical_transfer_batch(
          $1::uuid, $2, $3::jsonb, $4::jsonb, $5::jsonb
        )
      `, [
        OWNER_A,
        'historical-import:guest:ordinary-client',
        JSON.stringify(historicalAccountRows),
        JSON.stringify(historicalAccountRows),
        JSON.stringify(historicalTransferRows),
      ]),
      /permission denied|42501/i,
      'An ordinary authenticated browser must not execute the trusted import transaction',
    );
    const importHistorical = () => trustedHistoricalImport(
      'historical-import:guest:migration-verifier',
      historicalAccountRows,
      historicalAccountRows,
      historicalTransferRows,
    );
    const firstHistoricalImport = await importHistorical();
    assert.equal(firstHistoricalImport.rows.length, 3,
      'Historical import RPC must confirm both endpoint accounts and one transfer');
    const importedHistoricalAccount = await one(db, `
      select is_active, deleted_at from public.accounts
      where user_id = $1 and id = 'historical-archived-source'
    `, [OWNER_A]);
    assert.equal(importedHistoricalAccount.is_active, false,
      'Historical import must retain the endpoint archived state');
    assert.equal(importedHistoricalAccount.deleted_at, null,
      'Historical import must not invent a tombstone');
    const importedHistoricalTransfer = await one(db, `
      select source_account_id, source_account_name from public.transfers
      where user_id = $1 and id = 'historical-imported-transfer'
    `, [OWNER_A]);
    assert.equal(importedHistoricalTransfer.source_account_id, 'historical-archived-source');
    assert.equal(importedHistoricalTransfer.source_account_name, '舊銀行名',
      'Historical import must preserve the original endpoint name snapshot');
    const repeatedHistoricalImport = await importHistorical();
    assert.equal(repeatedHistoricalImport.rows.length, 3,
      'An exact historical import retry must be idempotently confirmed');
    const historicalTransferCount = await one(db, `
      select count(*)::integer as count from public.transfers
      where user_id = $1 and id = 'historical-imported-transfer'
    `, [OWNER_A]);
    assert.equal(numeric(historicalTransferCount.count), 1,
      'Historical import retry must not duplicate the atomic transfer row');

    const softDeletedAt = '2026-08-27T01:00:00.000Z';
    const softDeletedAccounts = historicalAccountRows.map((row, index) => ({
      ...row,
      id: index === 0 ? 'historical-deleted-source' : 'historical-deleted-destination',
      name: index === 0 ? '已刪除帳戶' : '保留帳戶',
      opening_balance: 0,
      is_active: index !== 0,
      version: index === 0 ? 3 : 1,
      last_operation_id: index === 0 ? 'historical-source-delete-op' : 'historical-destination-2-op',
      deleted_at: index === 0 ? softDeletedAt : null,
    }));
    const softDeletedTransfers = [{
      ...historicalTransferRows[0],
      id: 'historical-soft-deleted-transfer',
      source_account_id: 'historical-deleted-source',
      source_account_name: '刪除前舊名',
      destination_account_id: 'historical-deleted-destination',
      destination_account_name: '保留帳戶',
      last_operation_id: 'historical-soft-deleted-transfer-op',
    }];
    await trustedHistoricalImport(
      'historical-import:restore:soft-deleted',
      softDeletedAccounts,
      softDeletedAccounts,
      softDeletedTransfers,
    );
    const retainedSoftDelete = await one(db, `
      select is_active, deleted_at from public.accounts
      where user_id = $1 and id = 'historical-deleted-source'
    `, [OWNER_A]);
    assert.equal(retainedSoftDelete.is_active, false);
    assert.equal(retainedSoftDelete.deleted_at.toISOString(), softDeletedAt,
      'Historical import must retain a safely supported endpoint tombstone');
    const softDeletedTransferCount = await one(db, `
      select count(*)::integer as count from public.transfers
      where user_id = $1 and id = 'historical-soft-deleted-transfer' and deleted_at is null
    `, [OWNER_A]);
    assert.equal(numeric(softDeletedTransferCount.count), 1,
      'An active historical transfer may retain a soft-deleted endpoint through the explicit RPC');

    const partialFailureAccounts = historicalAccountRows.map((row, index) => ({
      ...row,
      id: index === 0 ? 'rolled-back-source' : 'rolled-back-destination',
      name: index === 0 ? '回滾來源' : '回滾目的',
      opening_balance: 0,
      is_active: true,
      last_operation_id: `rolled-back-account-${index}-op`,
    }));
    const invalidTransfer = [{
      ...historicalTransferRows[0],
      id: 'rolled-back-invalid-transfer',
      source_account_id: 'rolled-back-source',
      source_account_name: '回滾來源',
      destination_account_id: 'rolled-back-source',
      destination_account_name: '回滾來源',
      last_operation_id: 'rolled-back-invalid-transfer-op',
    }];
    await assert.rejects(
      trustedHistoricalImport(
        'historical-import:restore:must-roll-back',
        partialFailureAccounts,
        partialFailureAccounts,
        invalidTransfer,
      ),
      /distinct_accounts|check constraint/i,
      'A transfer-stage failure must roll back earlier account writes in the same RPC',
    );
    const rolledBackAccountCount = await one(db, `
      select count(*)::integer as count from public.accounts
      where user_id = $1 and id like 'rolled-back-%'
    `, [OWNER_A]);
    assert.equal(numeric(rolledBackAccountCount.count), 0,
      'A failed historical import must not leave misleading staged account rows');

    const foreignManifest = historicalAccountRows.map((row) => ({ ...row, user_id: OWNER_B }));
    await assert.rejects(
      trustedHistoricalImport(
        'historical-import:restore:foreign-owner',
        foreignManifest,
        foreignManifest,
        historicalTransferRows.map((row) => ({ ...row, user_id: OWNER_B })),
      ),
      /owner mismatch|row-level security|42501/i,
      'Historical import must reject a manifest owned by another user',
    );
    const rpcPrivileges = await one(db, `
      select
        has_function_privilege('anon',
          'public.finance_import_historical_transfer_batch(uuid,text,jsonb,jsonb,jsonb)', 'EXECUTE') as anon_executes,
        has_function_privilege('authenticated',
          'public.finance_import_historical_transfer_batch(uuid,text,jsonb,jsonb,jsonb)', 'EXECUTE') as authenticated_executes,
        has_function_privilege('service_role',
          'public.finance_import_historical_transfer_batch(uuid,text,jsonb,jsonb,jsonb)', 'EXECUTE') as service_executes
    `);
    assert.equal(rpcPrivileges.anon_executes, false,
      'Signed-out ordinary clients must not activate the historical import RPC');
    assert.equal(rpcPrivileges.authenticated_executes, false,
      'Ordinary signed-in browser clients must not activate the historical import RPC');
    assert.equal(rpcPrivileges.service_executes, true,
      'Only the trusted server role may execute the historical import transaction');
    const importFunction = await one(db, `
      select pg_get_functiondef(
        'public.finance_import_historical_transfer_batch(uuid,text,jsonb,jsonb,jsonb)'::regprocedure
      ) as definition
    `);
    assert.match(importFunction.definition, /order by public\.accounts\.id\s+for update/i,
      'Historical import must lock every endpoint in deterministic order until commit');

    await db.query(`
      insert into public.transfers (
        user_id, id, amount, source_account_id, source_account_name,
        destination_account_id, destination_account_name, occurred_at,
        version, updated_at, last_operation_id
      ) values
        ($1, 'included-to-included', 100, 'included-a', '計入 A', 'included-b', '計入 B', '2026-08-28 09:00', 1, now(), 'transfer-1-op'),
        ($1, 'included-to-excluded', 100, 'included-a', '計入 A', 'excluded-a', '排除 A', '2026-08-28 09:01', 1, now(), 'transfer-2-op'),
        ($1, 'excluded-to-included', 40, 'excluded-a', '排除 A', 'included-b', '計入 B', '2026-08-28 09:02', 1, now(), 'transfer-3-op'),
        ($1, 'excluded-to-excluded', 30, 'excluded-a', '排除 A', 'excluded-b', '排除 B', '2026-08-28 09:03', 1, now(), 'transfer-4-op')
    `, [OWNER_A]);

    const transferCount = await one(db, `
      select count(*)::integer as count from public.transfers
      where user_id = $1 and id in (
        'included-to-included', 'included-to-excluded',
        'excluded-to-included', 'excluded-to-excluded'
      )
    `, [OWNER_A]);
    assert.equal(numeric(transferCount.count), 4, 'Each transfer must persist as one atomic row');

    await assert.rejects(
      db.query(`
        insert into public.transfers (
          user_id, id, amount, source_account_id, source_account_name,
          destination_account_id, destination_account_name, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'same-account', 1, 'included-a', '計入 A', 'included-a', '計入 A',
          '2026-08-28 10:00', 1, now(), 'same-account-op')
      `, [OWNER_A]),
      /distinct_accounts|check constraint/i,
      'A transfer must not target the same account',
    );

    await db.query(`
      insert into public.goals (
        user_id, id, name, target_amount, current_amount, unit, is_active,
        version, updated_at, last_operation_id
      ) values ($1, 'transfer-capacity-goal', '轉帳容量', 5000, 0, '元', true,
        1, now(), 'transfer-capacity-goal-op')
    `, [OWNER_A]);
    await db.query(`
      insert into public.savings_allocations (
        user_id, id, goal_id, amount_delta, occurred_at,
        version, updated_at, last_operation_id
      ) values ($1, 'transfer-capacity-fit', 'transfer-capacity-goal', 1940,
        '2026-08-28', 1, now(), 'transfer-capacity-fit-op')
    `, [OWNER_A]);
    await assert.rejects(
      db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'transfer-capacity-over', 'transfer-capacity-goal', 0.01,
          '2026-08-28', 1, now(), 'transfer-capacity-over-op')
      `, [OWNER_A]),
      /allocation_capacity|exceeds available assets/i,
      'Allocation capacity must include transfer net effects across the total-assets boundary',
    );

    await db.query(`
      update public.accounts
      set is_active = false, version = 2, last_operation_id = 'archive-excluded-b-op'
      where user_id = $1 and id = 'excluded-b'
    `, [OWNER_A]);
    await db.query(`
      update public.transfers
      set note = '歷史端點仍可修改', version = 2, last_operation_id = 'transfer-4-edit-op'
      where user_id = $1 and id = 'excluded-to-excluded'
    `, [OWNER_A]);
    const staleRetarget = await one(db, `
      insert into public.transfers (
        user_id, id, amount, source_account_id, source_account_name,
        destination_account_id, destination_account_name, occurred_at, note,
        version, updated_at, last_operation_id
      ) values ($1, 'excluded-to-excluded', 999, 'included-a', '計入 A',
        'excluded-b', '排除 B', '2026-08-28 10:00', '較舊重試', 1, now(), 'older-transfer-op')
      on conflict (user_id, id) do update set
        amount = excluded.amount,
        source_account_id = excluded.source_account_id,
        source_account_name = excluded.source_account_name,
        destination_account_id = excluded.destination_account_id,
        destination_account_name = excluded.destination_account_name,
        occurred_at = excluded.occurred_at,
        note = excluded.note,
        version = excluded.version,
        updated_at = excluded.updated_at,
        last_operation_id = excluded.last_operation_id
      returning source_account_id, destination_account_id, note, version, last_operation_id
    `, [OWNER_A]);
    assert.deepEqual(
      {
        source: staleRetarget.source_account_id,
        destination: staleRetarget.destination_account_id,
        note: staleRetarget.note,
        version: numeric(staleRetarget.version),
        operation: staleRetarget.last_operation_id,
      },
      {
        source: 'excluded-a',
        destination: 'excluded-b',
        note: '歷史端點仍可修改',
        version: 2,
        operation: 'transfer-4-edit-op',
      },
      'A stale retarget retry must preserve the newer transfer before account availability checks',
    );
    const partialHistoricalRetarget = await one(db, `
      update public.transfers
      set source_account_id = 'included-a', source_account_name = '計入 A',
        version = 3, last_operation_id = 'transfer-4-retarget-source-op'
      where user_id = $1 and id = 'excluded-to-excluded'
      returning source_account_id, destination_account_id, destination_account_name, version
    `, [OWNER_A]);
    assert.deepEqual(
      {
        source: partialHistoricalRetarget.source_account_id,
        destination: partialHistoricalRetarget.destination_account_id,
        destinationName: partialHistoricalRetarget.destination_account_name,
        version: numeric(partialHistoricalRetarget.version),
      },
      {
        source: 'included-a',
        destination: 'excluded-b',
        destinationName: '排除 B',
        version: 3,
      },
      'Changing one endpoint must retain the other historical snapshot even after that account is archived',
    );
    await assert.rejects(
      db.query(`
        insert into public.transfers (
          user_id, id, amount, source_account_id, source_account_name,
          destination_account_id, destination_account_name, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'new-to-archived', 1, 'included-a', '計入 A', 'excluded-b', '排除 B',
          '2026-08-28 10:01', 1, now(), 'new-to-archived-op')
      `, [OWNER_A]),
      /destination account must be active|transfer_active_destination/i,
      'New transfers must not target an archived account',
    );
    await assert.rejects(
      db.query(`
        update public.transfers
        set destination_account_id = 'excluded-b',
          destination_account_name = '排除 B',
          version = 2,
          last_operation_id = 'retarget-to-archived-op'
        where user_id = $1 and id = 'included-to-included'
      `, [OWNER_A]),
      /destination account must be active|transfer_active_destination/i,
      'Ordinary retargeting must not select an archived account',
    );
    await assert.rejects(
      db.query(`
        update public.transfers
        set note = 'divergent same clock'
        where user_id = $1 and id = 'included-to-included'
      `, [OWNER_A]),
      /conflicting payload|40001/i,
      'A divergent same-clock transfer payload must fail closed',
    );

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_B]);
    const foreignCount = await one(db, `select count(*)::integer as count from public.transfers`);
    assert.equal(numeric(foreignCount.count), 0, 'Transfer RLS must isolate owners');
  } finally {
    await db.exec('reset role');
    await db.close();
  }
}

async function verifyMinorUnitAllocationCapacityParity() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseAuth(db);
    await db.exec(`insert into auth.users (id) values
      ('${OWNER_A}'), ('${OWNER_B}'), ('${OWNER_C}'), ('${OWNER_D}'),
      ('${OWNER_E}'), ('${OWNER_F}')`);
    await db.exec(migrationSql);
    await db.exec('set role authenticated');

    // Two included opening balances provide 0.02 after per-row rounding and
    // the income contributes another independently observable 0.01. The
    // client-only tutorial sentinel and large excluded/inactive values must
    // not contribute.
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values
        ($1, 'midpoint-included-a', '納入 A', 'vector', 'wallet', 0.005,
          true, true, 1, 1, now(), 'midpoint-included-a-op'),
        ($1, 'midpoint-included-b', '納入 B', 'vector', 'wallet', 0.005,
          true, true, 2, 1, now(), 'midpoint-included-b-op'),
        ($1, 'midpoint-excluded', '排除', 'vector', 'wallet', 1000.005,
          false, true, 3, 1, now(), 'midpoint-excluded-op'),
        ($1, 'midpoint-inactive', '停用', 'vector', 'wallet', 1000.005,
          true, false, 4, 1, now(), 'midpoint-inactive-op')
    `, [OWNER_A]);
    await db.query(`
      insert into public.categories (
        user_id, id, kind, name, icon_type, icon_value, is_active,
        sort_order, version, updated_at, last_operation_id
      ) values
        ($1, 'midpoint-income-category', 'income', '收入', 'vector', 'banknote',
          true, 1, 1, now(), 'midpoint-income-category-op'),
        ($1, 'midpoint-expense-category', 'expense', '支出', 'vector', 'tag',
          true, 2, 1, now(), 'midpoint-expense-category-op')
    `, [OWNER_A]);
    await db.query(`
      insert into public.transactions (
        user_id, id, amount, type, category_id, category_name,
        account_id, account_name, occurred_at, note, version, updated_at,
        last_operation_id
      ) values
        ($1, 'midpoint-income', 0.005, 'income', 'midpoint-income-category', '收入',
          'midpoint-included-a', '納入 A', '2026-08-28 10:00', null,
          1, now(), 'midpoint-income-op'),
        ($1, 'tutorial-expense', 500.005, 'expense', 'midpoint-expense-category', '支出',
          'midpoint-included-b', '納入 B', '2026-08-28 10:01',
          '🐕 柴柴互動教學紀錄（教學完成後會安全刪除）',
          1, now(), 'tutorial-expense-op'),
        ($1, 'excluded-income', 500.005, 'income', 'midpoint-income-category', '收入',
          'midpoint-excluded', '排除', '2026-08-28 10:02', null,
          1, now(), 'excluded-income-op')
    `, [OWNER_A]);
    await db.query(`
      insert into public.goals (
        user_id, id, name, target_amount, current_amount, unit, is_active,
        version, updated_at, last_operation_id
      ) values ($1, 'midpoint-ledger-goal', '逐筆金額', 10, 0, '元', true,
        1, now(), 'midpoint-ledger-goal-op')
    `, [OWNER_A]);
    await db.query(`
      insert into public.savings_allocations (
        user_id, id, goal_id, amount_delta, occurred_at,
        version, updated_at, last_operation_id
      ) values ($1, 'midpoint-ledger-capacity', 'midpoint-ledger-goal', 0.03,
        '2026-08-28 10:06', 1, now(), 'midpoint-ledger-capacity-op')
    `, [OWNER_A]);

    // Another owner may have abundant assets, but none can leak into A's
    // exhausted 0.03 capacity.
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_B]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values ($1, 'owner-b-assets', 'B 資產', 'vector', 'wallet', 100000,
        true, true, 1, 1, now(), 'owner-b-assets-op')
    `, [OWNER_B]);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    await assert.rejects(
      db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'owner-isolation-over-capacity', 'midpoint-ledger-goal', 0.01,
          '2026-08-28 10:07', 1, now(), 'owner-isolation-over-capacity-op')
      `, [OWNER_A]),
      /new savings allocation exceeds available assets/i,
      'Another owner assets must not increase this owner allocation capacity',
    );

    // The negative adjustment midpoint is independently observable: an exact
    // 0.02 opening balance minus -0.005 leaves 0.01 under minor-unit semantics,
    // while raw numeric arithmetic would leave 0.015.
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_E]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values
        ($1, 'adjustment-included', '調整納入', 'vector', 'wallet', 0.02,
          true, true, 1, 1, now(), 'adjustment-included-op'),
        ($1, 'adjustment-excluded', '調整排除', 'vector', 'wallet', 1000.005,
          false, true, 2, 1, now(), 'adjustment-excluded-op')
    `, [OWNER_E]);
    await db.query(`
      insert into public.adjustments (
        user_id, id, account_id, amount_delta, occurred_at,
        version, updated_at, last_operation_id
      ) values
        ($1, 'negative-midpoint-adjustment', 'adjustment-included', -0.005,
          '2026-08-28 10:10', 1, now(), 'negative-midpoint-adjustment-op'),
        ($1, 'excluded-adjustment', 'adjustment-excluded', 500.005,
          '2026-08-28 10:11', 1, now(), 'excluded-adjustment-op')
    `, [OWNER_E]);
    await db.query(`
      insert into public.goals (
        user_id, id, name, target_amount, current_amount, unit, is_active,
        version, updated_at, last_operation_id
      ) values ($1, 'adjustment-midpoint-goal', '調整負中點', 10, 0, '元', true,
        1, now(), 'adjustment-midpoint-goal-op')
    `, [OWNER_E]);
    await db.query(`
      insert into public.savings_allocations (
        user_id, id, goal_id, amount_delta, occurred_at,
        version, updated_at, last_operation_id
      ) values ($1, 'adjustment-midpoint-capacity', 'adjustment-midpoint-goal', 0.01,
        '2026-08-28 10:12', 1, now(), 'adjustment-midpoint-capacity-op')
    `, [OWNER_E]);
    await assert.rejects(
      db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'adjustment-midpoint-over-capacity', 'adjustment-midpoint-goal', 0.005,
          '2026-08-28 10:13', 1, now(), 'adjustment-midpoint-over-capacity-op')
      `, [OWNER_E]),
      /new savings allocation exceeds available assets/i,
      'Negative adjustment midpoint must remove one full minor unit',
    );

    // Allocation deltas themselves use the same legacy midpoint semantics.
    // 0.025 assets become 0.03; three 0.005 events fit exactly, a fourth does not.
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_C]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values ($1, 'allocation-midpoint-assets', '配置小數資產', 'vector', 'wallet', 0.025,
        true, true, 2, 1, now(), 'allocation-midpoint-assets-op')
    `, [OWNER_C]);
    await db.query(`
      insert into public.goals (
        user_id, id, name, target_amount, current_amount, unit, is_active,
        version, updated_at, last_operation_id
      ) values ($1, 'allocation-midpoint-goal', '配置逐筆進位', 10, 0, '元', true,
        1, now(), 'allocation-midpoint-goal-op')
    `, [OWNER_C]);
    for (let index = 1; index <= 3; index += 1) {
      await db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, $2, 'allocation-midpoint-goal', 0.005,
          '2026-08-28 11:00', 1, now(), $3)
      `, [OWNER_C, `allocation-midpoint-${index}`, `allocation-midpoint-${index}-op`]);
    }
    await assert.rejects(
      db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'allocation-midpoint-4', 'allocation-midpoint-goal', 0.005,
          '2026-08-28 11:01', 1, now(), 'allocation-midpoint-4-op')
      `, [OWNER_C]),
      /new savings allocation exceeds available assets/i,
      'Each legacy allocation midpoint must consume one full minor unit',
    );

    // Included-to-excluded is independently observable. Included-to-included
    // and excluded-to-excluded remain neutral.
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_D]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values
        ($1, 'transfer-included-source', '納入來源', 'vector', 'wallet', 0.03,
          true, true, 1, 1, now(), 'transfer-included-source-op'),
        ($1, 'transfer-included-destination', '納入目的', 'vector', 'wallet', 0,
          true, true, 2, 1, now(), 'transfer-included-destination-op'),
        ($1, 'transfer-excluded-source', '排除來源', 'vector', 'wallet', 100,
          false, true, 3, 1, now(), 'transfer-excluded-source-op'),
        ($1, 'transfer-excluded-destination', '排除目的', 'vector', 'wallet', 100,
          false, true, 4, 1, now(), 'transfer-excluded-destination-op')
    `, [OWNER_D]);
    await db.query(`
      insert into public.transfers (
        user_id, id, amount, source_account_id, source_account_name,
        destination_account_id, destination_account_name, occurred_at,
        version, updated_at, last_operation_id
      ) values
        ($1, 'midpoint-included-included', 0.005,
          'transfer-included-source', '納入來源',
          'transfer-included-destination', '納入目的',
          '2026-08-28 12:00', 1, now(), 'midpoint-included-included-op'),
        ($1, 'midpoint-excluded-excluded', 0.005,
          'transfer-excluded-source', '排除來源',
          'transfer-excluded-destination', '排除目的',
          '2026-08-28 12:01', 1, now(), 'midpoint-excluded-excluded-op'),
        ($1, 'midpoint-included-excluded', 0.005,
          'transfer-included-source', '納入來源',
          'transfer-excluded-destination', '排除目的',
          '2026-08-28 12:02', 1, now(), 'midpoint-included-excluded-op')
    `, [OWNER_D]);
    await db.query(`
      insert into public.goals (
        user_id, id, name, target_amount, current_amount, unit, is_active,
        version, updated_at, last_operation_id
      ) values ($1, 'transfer-midpoint-goal', '轉帳逐筆進位', 10, 0, '元', true,
        1, now(), 'transfer-midpoint-goal-op')
    `, [OWNER_D]);
    await db.query(`
      insert into public.savings_allocations (
        user_id, id, goal_id, amount_delta, occurred_at,
        version, updated_at, last_operation_id
      ) values ($1, 'transfer-midpoint-capacity', 'transfer-midpoint-goal', 0.02,
        '2026-08-28 12:04', 1, now(), 'transfer-midpoint-capacity-op')
    `, [OWNER_D]);
    await assert.rejects(
      db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'transfer-midpoint-over-capacity', 'transfer-midpoint-goal', 0.005,
          '2026-08-28 12:05', 1, now(), 'transfer-midpoint-over-capacity-op')
      `, [OWNER_D]),
      /new savings allocation exceeds available assets/i,
      'Included-to-excluded midpoint must remove one full minor unit',
    );

    // Excluded-to-included is tested on a separate owner, so omitting this
    // direction or using the raw numeric value cannot be hidden by cancellation.
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_F]);
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values
        ($1, 'inbound-included', '轉入納入', 'vector', 'wallet', 0.005,
          true, true, 1, 1, now(), 'inbound-included-op'),
        ($1, 'inbound-excluded', '轉入排除', 'vector', 'wallet', 100,
          false, true, 2, 1, now(), 'inbound-excluded-op')
    `, [OWNER_F]);
    await db.query(`
      insert into public.transfers (
        user_id, id, amount, source_account_id, source_account_name,
        destination_account_id, destination_account_name, occurred_at,
        version, updated_at, last_operation_id
      ) values ($1, 'midpoint-excluded-included', 0.005,
        'inbound-excluded', '轉入排除', 'inbound-included', '轉入納入',
        '2026-08-28 12:10', 1, now(), 'midpoint-excluded-included-op')
    `, [OWNER_F]);
    await db.query(`
      insert into public.goals (
        user_id, id, name, target_amount, current_amount, unit, is_active,
        version, updated_at, last_operation_id
      ) values ($1, 'inbound-midpoint-goal', '轉入逐筆進位', 10, 0, '元', true,
        1, now(), 'inbound-midpoint-goal-op')
    `, [OWNER_F]);
    await db.query(`
      insert into public.savings_allocations (
        user_id, id, goal_id, amount_delta, occurred_at,
        version, updated_at, last_operation_id
      ) values ($1, 'inbound-midpoint-capacity', 'inbound-midpoint-goal', 0.02,
        '2026-08-28 12:11', 1, now(), 'inbound-midpoint-capacity-op')
    `, [OWNER_F]);
    await assert.rejects(
      db.query(`
        insert into public.savings_allocations (
          user_id, id, goal_id, amount_delta, occurred_at,
          version, updated_at, last_operation_id
        ) values ($1, 'inbound-midpoint-over-capacity', 'inbound-midpoint-goal', 0.01,
          '2026-08-28 12:12', 1, now(), 'inbound-midpoint-over-capacity-op')
      `, [OWNER_F]),
      /new savings allocation exceeds available assets/i,
      'Excluded-to-included midpoint must add one full minor unit',
    );
  } finally {
    await db.exec('reset role');
    await db.close();
  }
}

async function verifyAuthoritativeBootstrapRevisions() {
  const db = new PGlite();
  const readRevision = async () => {
    const row = await one(db, `
      select public.finance_v4_bootstrap_revision() ->> 'owner_id' as owner_id,
        public.finance_v4_bootstrap_revision() ->> 'revision' as revision
    `);
    return { ownerId: row.owner_id, revision: BigInt(row.revision) };
  };
  try {
    await bootstrapSupabaseAuth(db);
    await db.exec(`insert into auth.users (id) values ('${OWNER_A}'), ('${OWNER_B}')`);
    await db.exec(migrationSql);

    const revisionStructure = await one(db, `
      select
        (select count(*)::integer
          from pg_trigger as trigger
          join pg_class as relation on relation.oid = trigger.tgrelid
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where not trigger.tgisinternal
            and trigger.tgname = 'finance_v4_bump_bootstrap_revision'
            and namespace.nspname = 'public') as trigger_count,
        has_table_privilege('anon',
          'finance_private.bootstrap_revisions', 'select') as anon_table,
        has_table_privilege('authenticated',
          'finance_private.bootstrap_revisions', 'select') as authenticated_table,
        has_table_privilege('service_role',
          'finance_private.bootstrap_revisions', 'select') as service_table,
        has_function_privilege('anon',
          'public.finance_v4_bootstrap_revision()', 'execute') as anon_function,
        has_function_privilege('authenticated',
          'public.finance_v4_bootstrap_revision()', 'execute') as authenticated_function,
        has_function_privilege('service_role',
          'public.finance_v4_bootstrap_revision()', 'execute') as service_function
    `);
    assert.deepEqual(revisionStructure, {
      trigger_count: 9,
      anon_table: false,
      authenticated_table: false,
      service_table: false,
      anon_function: false,
      authenticated_function: true,
      service_function: false,
    }, 'All pulled tables need revision triggers and the RPC needs least-privilege grants');

    await db.exec('set role anon');
    await assert.rejects(
      db.query('select public.finance_v4_bootstrap_revision()'),
      /permission denied/i,
      'Anonymous callers must not execute the bootstrap revision RPC',
    );
    await db.exec('reset role');
    await db.exec('set role authenticated');

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    assert.deepEqual(await readRevision(), { ownerId: OWNER_A, revision: 0n });
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values ($1, 'revision-a', 'A', 'vector', 'wallet', 0,
        true, true, 1, 1, now(), 'revision-a-op')
    `, [OWNER_A]);
    assert.deepEqual(await readRevision(), { ownerId: OWNER_A, revision: 1n });

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_B]);
    assert.deepEqual(await readRevision(), { ownerId: OWNER_B, revision: 0n });
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values ($1, 'revision-b', 'B', 'vector', 'wallet', 0,
        true, true, 1, 1, now(), 'revision-b-op')
    `, [OWNER_B]);
    assert.deepEqual(await readRevision(), { ownerId: OWNER_B, revision: 1n });
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    assert.deepEqual(
      await readRevision(),
      { ownerId: OWNER_A, revision: 1n },
      'Another owner mutation must not change this owner revision',
    );

    await db.exec('begin');
    await db.query(`
      insert into public.accounts (
        user_id, id, name, icon_type, icon_value, opening_balance,
        include_in_total_assets, is_active, sort_order, version,
        updated_at, last_operation_id
      ) values ($1, 'revision-rolled-back', 'Rollback', 'vector', 'wallet', 0,
        true, true, 2, 1, now(), 'revision-rolled-back-op')
    `, [OWNER_A]);
    assert.deepEqual(await readRevision(), { ownerId: OWNER_A, revision: 2n });
    await db.exec('rollback');
    assert.deepEqual(
      await readRevision(),
      { ownerId: OWNER_A, revision: 1n },
      'A rolled-back financial write must roll back its revision increment',
    );

    await assert.rejects(
      db.query('select * from finance_private.bootstrap_revisions'),
      /permission denied/i,
      'Authenticated callers must not read another owner private revision row',
    );

    await db.exec('reset role');
    await db.exec(cloudConsistencyMigrationSql);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_A]);
    assert.deepEqual(
      await readRevision(),
      { ownerId: OWNER_A, revision: 1n },
      'Retrying the additive migration must preserve existing revisions',
    );
    const triggerCountAfterRetry = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where not tgisinternal and tgname = 'finance_v4_bump_bootstrap_revision'
    `);
    assert.equal(
      numeric(triggerCountAfterRetry.count),
      9,
      'Retrying the migration must not duplicate revision triggers',
    );
  } finally {
    await db.exec('reset role');
    await db.close();
  }
}

await verifyFreshAndRetry();
console.log('[pass] fresh schema and retry-safe DDL');
console.log('[pass] future public objects require explicit grants');
console.log('[pass] NOT VALID checks protect future writes');

await verifyUnexpectedIncomingLegacyForeignKeyFailsClosed();
console.log('[pass] unexpected legacy FK dependencies fail closed without partial migration');

await verifyLegacyRetryRlsAndClock();
console.log('[pass] deterministic legacy backfill and retry safety');
console.log('[pass] v3 goal UPSERT preserves legacy total and retry safety');
console.log('[pass] post-migration legacy write bridges and goal allocation audit');
console.log('[pass] authenticated owner RLS isolation');
console.log('[pass] stale UPSERT conflict-clock retention');
console.log('[pass] exact retry accepted and same-clock divergent payload rejected');

await verifyLegacyNegativeGoalDeleteTombstonesAtomically();
console.log('[pass] legacy negative goal delete tombstones allocations atomically');

await verifyServerResourceAbuseGuards();
console.log('[pass] server-side text, numeric, and RLS-complete per-owner resource abuse guards');
await verifyAtomicTransfers();
console.log('[pass] atomic transfer constraints, RLS, sync clock, and allocation capacity');
await verifyMinorUnitAllocationCapacityParity();
console.log('[pass] client-parity minor-unit capacity across legacy midpoints and transfer boundaries');
await verifyAuthoritativeBootstrapRevisions();
console.log('[pass] authoritative bootstrap revisions, owner isolation, grants, rollback, and retry safety');
console.log('Supabase migration verification passed without an external database.');
