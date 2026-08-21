import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  scriptDirectory,
  '..',
  'supabase',
  'migrations',
  '20260821103249_finance_v3_additive_schema.sql',
);
const migrationSql = await readFile(migrationPath, 'utf8');

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
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
    assert.equal(numeric(policyCount.count), 40, 'Expected four owner policies on each finance table');

    const triggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname = 'finance_v3_conflict_clock'
        and not tgisinternal
    `);
    assert.equal(numeric(triggerCount.count), 8, 'Expected one conflict-clock trigger per sync entity');

    const bridgeTriggerCount = await one(db, `
      select count(*)::integer as count
      from pg_trigger
      where tgname = 'finance_v3_00_legacy_bridge'
        and not tgisinternal
    `);
    assert.equal(numeric(bridgeTriggerCount.count), 3, 'Expected legacy bridges on transactions, budgets, and goals');

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
    assert.equal(numeric(operationCheckCount.count), 10, 'Expected a stable operation check on every finance table');

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
      )
    `);
    assert.equal(numeric(domainCheckCount.count), 10, 'Expected future-write domain checks');

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
        has_function_privilege('authenticated', 'finance_private.finance_v3_part(text)', 'execute') as stable_id_helper,
        has_function_privilege('authenticated', 'finance_private.bridge_legacy_finance_write()', 'execute') as mutation_helper,
        has_function_privilege('authenticated', 'finance_private.set_goal_insert_statement_context()', 'execute') as context_helper
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
      stable_id_helper: true,
      mutation_helper: false,
      context_helper: false,
    }, 'Future public objects must be private until an explicit reviewed grant');
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
      ('sub-invalid', $1, '待人工檢查', -1, '', '', 32)
  `, [OWNER_A]);

  await db.query(`
    insert into public.budgets (id, user_id, category, period, amount)
    values ('budget-a', $1, '餐飲', 'monthly', 5000)
  `, [OWNER_A]);

  return { longAccountName };
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
    await verifyLegacyBackfill(db, longAccountName);

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

    await verifyV3GoalUpsertPreservesLegacyTotal(db);
    await verifyPostMigrationLegacyWrites(db);

    // A reviewed migration may be retried after old clients have continued to
    // write. The one-time backfill must not duplicate bridge-created goal
    // allocations or rewrite their conflict clocks.
    await db.exec(migrationSql);
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
        transactionVersion: 2,
        budgetVersion: 2,
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

await verifyFreshAndRetry();
console.log('[pass] fresh schema and retry-safe DDL');
console.log('[pass] future public objects require explicit grants');
console.log('[pass] NOT VALID checks protect future writes');

await verifyLegacyRetryRlsAndClock();
console.log('[pass] deterministic legacy backfill and retry safety');
console.log('[pass] v3 goal UPSERT preserves legacy total and retry safety');
console.log('[pass] post-migration legacy write bridges and goal allocation audit');
console.log('[pass] authenticated owner RLS isolation');
console.log('[pass] stale UPSERT conflict-clock retention');
console.log('[pass] exact retry accepted and same-clock divergent payload rejected');
console.log('Supabase migration verification passed without an external database.');
