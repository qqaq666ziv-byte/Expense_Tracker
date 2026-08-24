-- Expense Tracker finance schema v3: authenticated write-abuse guards
--
-- This migration is intentionally additive and preserves every existing row.
-- NOT VALID checks protect all future writes without refusing deployment when
-- an older record needs an explicit, reviewed cleanup. Per-owner row ceilings
-- include tombstones so clients cannot evade quotas by repeatedly archiving
-- records. The limits are safety ceilings, not product-plan entitlements.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';

do $text_length_constraints$
declare
  constraint_spec record;
begin
  for constraint_spec in
    select *
    from (values
      ('transactions', 'id', 4096),
      ('transactions', 'type', 64),
      ('transactions', 'category', 512),
      ('transactions', 'note', 4096),
      ('transactions', 'date', 128),
      ('transactions', 'account', 512),
      ('transactions', 'icon', 256),
      ('transactions', 'category_id', 4096),
      ('transactions', 'category_name', 512),
      ('transactions', 'account_id', 4096),
      ('transactions', 'account_name', 512),
      ('transactions', 'occurred_at', 128),
      ('transactions', 'recurring_rule_id', 4096),
      ('transactions', 'last_operation_id', 4096),
      ('goals', 'id', 4096),
      ('goals', 'name', 512),
      ('goals', 'unit', 64),
      ('goals', 'target_date', 128),
      ('goals', 'legacy_unit', 64),
      ('goals', 'last_operation_id', 4096),
      ('subscriptions', 'id', 4096),
      ('subscriptions', 'name', 512),
      ('subscriptions', 'category', 512),
      ('subscriptions', 'account', 512),
      ('subscriptions', 'migrated_recurring_rule_id', 4096),
      ('subscriptions', 'last_operation_id', 4096),
      ('budgets', 'id', 4096),
      ('budgets', 'category', 512),
      ('budgets', 'period', 64),
      ('budgets', 'scope', 64),
      ('budgets', 'category_id', 4096),
      ('budgets', 'category_name', 512),
      ('budgets', 'last_operation_id', 4096),
      ('accounts', 'id', 4096),
      ('accounts', 'name', 512),
      ('accounts', 'icon_type', 64),
      ('accounts', 'icon_value', 256),
      ('accounts', 'legacy_key', 4096),
      ('accounts', 'last_operation_id', 4096),
      ('categories', 'id', 4096),
      ('categories', 'kind', 64),
      ('categories', 'name', 512),
      ('categories', 'icon_type', 64),
      ('categories', 'icon_value', 256),
      ('categories', 'legacy_key', 4096),
      ('categories', 'last_operation_id', 4096),
      ('adjustments', 'id', 4096),
      ('adjustments', 'account_id', 4096),
      ('adjustments', 'occurred_at', 128),
      ('adjustments', 'reason', 4096),
      ('adjustments', 'last_operation_id', 4096),
      ('savings_allocations', 'id', 4096),
      ('savings_allocations', 'goal_id', 4096),
      ('savings_allocations', 'occurred_at', 128),
      ('savings_allocations', 'note', 4096),
      ('savings_allocations', 'last_operation_id', 4096),
      ('recurring_rules', 'id', 4096),
      ('recurring_rules', 'name', 512),
      ('recurring_rules', 'type', 64),
      ('recurring_rules', 'category_id', 4096),
      ('recurring_rules', 'category_name', 512),
      ('recurring_rules', 'account_id', 4096),
      ('recurring_rules', 'account_name', 512),
      ('recurring_rules', 'frequency', 64),
      ('recurring_rules', 'note', 4096),
      ('recurring_rules', 'last_operation_id', 4096),
      ('settings', 'currency', 64),
      ('settings', 'locale', 64),
      ('settings', 'active_goal_id', 4096),
      ('settings', 'last_operation_id', 4096)
    ) as checks(table_name, column_name, maximum_bytes)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = pg_catalog.format(
        'finance_v3_%s_%s_len_chk',
        constraint_spec.table_name,
        constraint_spec.column_name
      )
        and conrelid = pg_catalog.format(
          'public.%I',
          constraint_spec.table_name
        )::pg_catalog.regclass
    ) then
      execute pg_catalog.format(
        'alter table public.%I add constraint %I '
        || 'check (%I is null or pg_catalog.octet_length(%I) <= %s) not valid',
        constraint_spec.table_name,
        pg_catalog.format(
          'finance_v3_%s_%s_len_chk',
          constraint_spec.table_name,
          constraint_spec.column_name
        ),
        constraint_spec.column_name,
        constraint_spec.column_name,
        constraint_spec.maximum_bytes
      );
    end if;
  end loop;
end
$text_length_constraints$;

do $numeric_domain_constraints$
declare
  constraint_spec record;
begin
  for constraint_spec in
    select *
    from (values
      ('transactions', 'amount'),
      ('goals', 'target_amount'),
      ('goals', 'current_amount'),
      ('subscriptions', 'amount'),
      ('budgets', 'amount'),
      ('accounts', 'opening_balance'),
      ('adjustments', 'amount_delta'),
      ('savings_allocations', 'amount_delta'),
      ('recurring_rules', 'amount')
    ) as checks(table_name, column_name)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = pg_catalog.format(
        'finance_v3_%s_%s_numeric_chk',
        constraint_spec.table_name,
        constraint_spec.column_name
      )
        and conrelid = pg_catalog.format(
          'public.%I',
          constraint_spec.table_name
        )::pg_catalog.regclass
    ) then
      execute pg_catalog.format(
        'alter table public.%I add constraint %I '
        || 'check (%I is null or ('
        || 'pg_catalog.pg_column_size(%I) <= 32 '
        || 'and pg_catalog.abs(%I) <= 100000000 '
        || 'and %I = pg_catalog.round(%I, 6)'
        || ')) not valid',
        constraint_spec.table_name,
        pg_catalog.format(
          'finance_v3_%s_%s_numeric_chk',
          constraint_spec.table_name,
          constraint_spec.column_name
        ),
        constraint_spec.column_name,
        constraint_spec.column_name,
        constraint_spec.column_name,
        constraint_spec.column_name,
        constraint_spec.column_name
      );
    end if;
  end loop;
end
$numeric_domain_constraints$;

create or replace function finance_private.enforce_owner_resource_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  maximum_rows bigint;
  existing_rows bigint;
  record_exists boolean;
  request_owner uuid;
begin
  maximum_rows := case tg_table_name
    when 'transactions' then 25000
    when 'accounts' then 250
    when 'categories' then 500
    when 'adjustments' then 5000
    when 'savings_allocations' then 10000
    when 'goals' then 500
    when 'budgets' then 2000
    when 'recurring_rules' then 1000
    when 'subscriptions' then 1000
    else null
  end;

  if maximum_rows is null then
    raise exception 'owner resource guard invoked for unsupported table public.%',
      tg_table_name
      using errcode = '55000';
  end if;

  request_owner := auth.uid();
  if pg_catalog.current_setting('role', true) = 'authenticated'
    and (request_owner is null or new.user_id is distinct from request_owner)
  then
    raise exception 'row-level security owner guard rejected a foreign-owner write'
      using errcode = '42501';
  end if;

  -- Serialize first inserts for one owner/table pair. Without this lock, two
  -- concurrent requests could both observe a count just below the ceiling.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text || ':' || tg_table_name, 0)
  );

  execute pg_catalog.format(
    'select exists ('
    || 'select 1 from public.%I where user_id = $1 and id = $2'
    || ')',
    tg_table_name
  )
  into record_exists
  using new.user_id, new.id;

  -- PostgREST UPSERT reaches BEFORE INSERT before resolving ON CONFLICT. An
  -- exact retry of an existing owner-scoped ID remains legal at capacity.
  if record_exists then
    return new;
  end if;

  execute pg_catalog.format(
    'select count(*) from public.%I where user_id = $1',
    tg_table_name
  )
  into existing_rows
  using new.user_id;

  if existing_rows >= maximum_rows then
    raise exception
      'owner resource limit exceeded for public.% (maximum % rows)',
      tg_table_name,
      maximum_rows
      using errcode = '54000',
        constraint = 'finance_v3_owner_resource_limit',
        hint = 'Archive cleanup does not release quota; contact support for reviewed recovery.';
  end if;

  return new;
end
$function$;

revoke all on function finance_private.enforce_owner_resource_limit()
  from public, anon, authenticated;

do $resource_limit_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'transactions',
    'accounts',
    'categories',
    'adjustments',
    'savings_allocations',
    'goals',
    'budgets',
    'recurring_rules',
    'subscriptions'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists finance_v3_10_owner_resource_limit on public.%I',
      table_name
    );
    execute pg_catalog.format(
      'create trigger finance_v3_10_owner_resource_limit '
      || 'before insert on public.%I for each row '
      || 'execute function finance_private.enforce_owner_resource_limit()',
      table_name
    );
  end loop;
end
$resource_limit_triggers$;

commit;
