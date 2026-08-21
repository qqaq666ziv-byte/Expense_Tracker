-- Expense Tracker finance schema v3
--
-- This migration is intentionally additive. Legacy display/string columns remain
-- available so the pre-v3 application can still read its records while the v3
-- client moves to stable relations and tombstone-based synchronization.
-- Do not run this file directly against production; deploy it through reviewed
-- Supabase migration tooling after an independent database backup is verified.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';

create schema if not exists finance_private;
revoke all on schema finance_private from public, anon, authenticated;

-- Bootstrap the four legacy tables for reproducible fresh/local databases. On an
-- existing project CREATE TABLE IF NOT EXISTS leaves every legacy column intact.
create table if not exists public.transactions (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric not null,
  type text not null,
  category text,
  note text,
  date text,
  account text,
  icon text,
  primary key (user_id, id)
);

create table if not exists public.goals (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  target_amount numeric not null,
  current_amount numeric not null default 0,
  unit text not null default '元',
  target_date text,
  primary key (user_id, id)
);

create table if not exists public.subscriptions (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  amount numeric not null,
  category text,
  account text,
  recurring_date integer,
  primary key (user_id, id)
);

create table if not exists public.budgets (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  category text,
  period text not null,
  amount numeric not null,
  primary key (user_id, id)
);

-- Evolve legacy records in place. Dates that historically represented local text
-- remain text; this avoids inventing timezone offsets for financial history.
alter table public.transactions
  add column if not exists category_id text,
  add column if not exists category_name text,
  add column if not exists account_id text,
  add column if not exists account_name text,
  add column if not exists occurred_at text,
  add column if not exists recurring_rule_id text,
  add column if not exists occurrence_date date,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default transaction_timestamp(),
  add column if not exists last_operation_id text not null default 'legacy-unversioned',
  add column if not exists deleted_at timestamptz;

alter table public.goals
  add column if not exists is_active boolean not null default true,
  add column if not exists legacy_unit text,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default transaction_timestamp(),
  add column if not exists last_operation_id text not null default 'legacy-unversioned',
  add column if not exists deleted_at timestamptz;

alter table public.goals alter column current_amount set default 0;
alter table public.goals alter column unit set default '元';

alter table public.subscriptions
  add column if not exists is_active boolean not null default true,
  add column if not exists migrated_recurring_rule_id text,
  add column if not exists requires_review boolean not null default false,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default transaction_timestamp(),
  add column if not exists last_operation_id text not null default 'legacy-unversioned',
  add column if not exists deleted_at timestamptz;

alter table public.budgets
  add column if not exists scope text,
  add column if not exists category_id text,
  add column if not exists category_name text,
  add column if not exists is_active boolean not null default true,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default transaction_timestamp(),
  add column if not exists last_operation_id text not null default 'legacy-unversioned',
  add column if not exists deleted_at timestamptz;

-- New v3 entity tables use user-scoped composite keys. IDs remain text because
-- deterministic migrated and recurring IDs are intentionally human-auditable.
create table if not exists public.accounts (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  name text not null,
  icon_type text not null check (icon_type in ('emoji', 'vector')),
  icon_value text not null,
  opening_balance numeric not null default 0,
  include_in_total_assets boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  legacy_key text,
  requires_review boolean not null default false,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default transaction_timestamp(),
  last_operation_id text not null,
  deleted_at timestamptz,
  primary key (user_id, id)
);

create table if not exists public.categories (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  kind text not null check (kind in ('income', 'expense')),
  name text not null,
  icon_type text not null check (icon_type in ('emoji', 'vector')),
  icon_value text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  legacy_key text,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default transaction_timestamp(),
  last_operation_id text not null,
  deleted_at timestamptz,
  primary key (user_id, id)
);

create table if not exists public.adjustments (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  account_id text not null,
  amount_delta numeric not null check (amount_delta <> 0),
  occurred_at text not null,
  reason text,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default transaction_timestamp(),
  last_operation_id text not null,
  deleted_at timestamptz,
  primary key (user_id, id)
);

create table if not exists public.savings_allocations (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  goal_id text not null,
  amount_delta numeric not null check (amount_delta <> 0),
  occurred_at text not null,
  note text,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default transaction_timestamp(),
  last_operation_id text not null,
  deleted_at timestamptz,
  primary key (user_id, id)
);

create table if not exists public.recurring_rules (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  name text not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric not null check (amount > 0),
  category_id text not null,
  category_name text not null,
  account_id text not null,
  account_name text not null,
  frequency text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  start_date date not null,
  anchor_day integer check (anchor_day between 1 and 31),
  next_occurrence_date date not null,
  is_active boolean not null default true,
  note text,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default transaction_timestamp(),
  last_operation_id text not null,
  deleted_at timestamptz,
  primary key (user_id, id)
);

create table if not exists public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  currency text not null default 'TWD' check (currency = 'TWD'),
  locale text not null default 'zh-TW' check (locale = 'zh-TW'),
  active_goal_id text,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default transaction_timestamp(),
  last_operation_id text not null,
  deleted_at timestamptz
);

-- Required conflict targets and RLS/filter indexes. Read-only production
-- information_schema inspection on 2026-08-21 confirmed the four legacy `id`
-- columns are text and `user_id` columns are uuid, so deterministic text IDs and
-- `(user_id,id)` PostgREST conflict targets are type-compatible. Distinct index
-- names avoid treating an unrelated legacy index as the v3 contract.
create unique index if not exists finance_v3_transactions_user_id_id_uidx
  on public.transactions (user_id, id);
create unique index if not exists finance_v3_goals_user_id_id_uidx
  on public.goals (user_id, id);
create unique index if not exists finance_v3_subscriptions_user_id_id_uidx
  on public.subscriptions (user_id, id);
create unique index if not exists finance_v3_budgets_user_id_id_uidx
  on public.budgets (user_id, id);
create unique index if not exists finance_v3_accounts_user_id_id_uidx
  on public.accounts (user_id, id);
create unique index if not exists finance_v3_categories_user_id_id_uidx
  on public.categories (user_id, id);
create unique index if not exists finance_v3_adjustments_user_id_id_uidx
  on public.adjustments (user_id, id);
create unique index if not exists finance_v3_allocations_user_id_id_uidx
  on public.savings_allocations (user_id, id);
create unique index if not exists finance_v3_recurring_rules_user_id_id_uidx
  on public.recurring_rules (user_id, id);

create index if not exists finance_v3_transactions_user_id_idx on public.transactions (user_id);
create index if not exists finance_v3_goals_user_id_idx on public.goals (user_id);
create index if not exists finance_v3_subscriptions_user_id_idx on public.subscriptions (user_id);
create index if not exists finance_v3_budgets_user_id_idx on public.budgets (user_id);
create index if not exists finance_v3_accounts_user_id_idx on public.accounts (user_id);
create index if not exists finance_v3_categories_user_id_idx on public.categories (user_id);
create index if not exists finance_v3_adjustments_user_id_idx on public.adjustments (user_id);
create index if not exists finance_v3_allocations_user_id_idx on public.savings_allocations (user_id);
create index if not exists finance_v3_recurring_rules_user_id_idx on public.recurring_rules (user_id);
create index if not exists finance_v3_settings_user_id_idx on public.settings (user_id);

-- Same algorithm as stableLegacyId() in src/domain/legacyMigration.ts: each
-- UTF-8 identity part is independently base64url encoded, then joined by '.'.
create or replace function pg_temp.finance_v3_part(value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
  select rtrim(
    translate(
      replace(replace(encode(convert_to(value, 'UTF8'), 'base64'), chr(10), ''), chr(13), ''),
      '+/',
      '-_'
    ),
    '='
  )
$function$;

-- Runtime legacy-write bridges need the same stable-ID codec after the
-- migration session (and its pg_temp schema) has ended. Only this pure helper
-- is executable by Data API roles; all mutation trigger functions below remain
-- private and are invoked only by PostgreSQL triggers.
create or replace function finance_private.finance_v3_part(value text)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $function$
  select rtrim(
    translate(
      replace(replace(encode(convert_to(value, 'UTF8'), 'base64'), chr(10), ''), chr(13), ''),
      '+/',
      '-_'
    ),
    '='
  )
$function$;

revoke all on function finance_private.finance_v3_part(text) from public, anon, authenticated;

-- Deterministically materialize stable account entities from every legacy use.
with account_sources as (
  select user_id, btrim(account) as name
  from public.transactions
  where user_id is not null and deleted_at is null and nullif(btrim(account), '') is not null
  union
  select user_id, btrim(account) as name
  from public.subscriptions
  where user_id is not null and deleted_at is null and nullif(btrim(account), '') is not null
), prepared as (
  select
    user_id,
    name,
    'account-' || pg_temp.finance_v3_part(user_id::text) || '.' || pg_temp.finance_v3_part(name) as id,
    row_number() over (partition by user_id order by name) - 1 as sort_order
  from account_sources
)
insert into public.accounts (
  user_id, id, name, icon_type, icon_value, opening_balance,
  include_in_total_assets, is_active, sort_order, legacy_key,
  requires_review, version, updated_at, last_operation_id
)
select
  user_id,
  id,
  name,
  case when name ~* '(現金|cash)' then 'emoji' else 'vector' end,
  case
    when name ~* '(現金|cash)' then '💵'
    when name ~* '(支付|錢包|wallet|pay)' then 'wallet-cards'
    else 'wallet'
  end,
  0,
  name ~* '(現金|cash|支付|街口|錢包|wallet|e-?wallet|悠遊|一卡通|pay)',
  true,
  sort_order::integer,
  name,
  not (name ~* '(現金|cash|支付|街口|錢包|wallet|e-?wallet|悠遊|一卡通|pay)'),
  1,
  transaction_timestamp(),
  'operation-' || pg_temp.finance_v3_part(user_id::text) || '.'
    || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(id)
from prepared
on conflict (user_id, id) do nothing;

-- Deterministically materialize income/expense categories. Legacy icon tokens
-- are mapped to the same generic vector keys used by the local migration.
with category_sources as (
  select user_id, type as kind, btrim(category) as name, nullif(icon, '') as icon
  from public.transactions
  where user_id is not null
    and deleted_at is null
    and type in ('income', 'expense')
    and nullif(btrim(category), '') is not null
  union all
  select user_id, 'expense', btrim(category), null
  from public.subscriptions
  where user_id is not null and deleted_at is null and nullif(btrim(category), '') is not null
  union all
  select user_id, 'expense', btrim(category), null
  from public.budgets
  where user_id is not null and deleted_at is null and nullif(btrim(category), '') is not null
), grouped as (
  select user_id, kind, name, min(icon) as icon
  from category_sources
  group by user_id, kind, name
), prepared as (
  select
    user_id,
    kind,
    name,
    icon,
    'category-' || pg_temp.finance_v3_part(user_id::text) || '.'
      || pg_temp.finance_v3_part(kind) || '.' || pg_temp.finance_v3_part(name) as id,
    row_number() over (partition by user_id, kind order by name) - 1 as sort_order
  from grouped
)
insert into public.categories (
  user_id, id, kind, name, icon_type, icon_value, is_active,
  sort_order, legacy_key, version, updated_at, last_operation_id
)
select
  user_id,
  id,
  kind,
  name,
  case
    when icon is not null and octet_length(icon) <> char_length(icon) then 'emoji'
    else 'vector'
  end,
  case icon
    when 'UTENSILS' then 'utensils'
    when 'CAR' then 'car'
    when 'BAG' then 'shopping-bag'
    when 'SPARKLES' then 'sparkles'
    else case
      when icon is not null and octet_length(icon) <> char_length(icon) then icon
      when kind = 'expense' then 'tag'
      else 'badge-dollar-sign'
    end
  end,
  true,
  sort_order::integer,
  kind || ':' || name,
  1,
  transaction_timestamp(),
  'operation-' || pg_temp.finance_v3_part(user_id::text) || '.'
    || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(id)
from prepared
on conflict (user_id, id) do nothing;

-- Preserve every legacy transaction value while adding stable relations. No date
-- conversion is performed; occurred_at keeps the original local text exactly.
update public.transactions as transaction_row
set
  category_name = coalesce(nullif(transaction_row.category_name, ''), nullif(btrim(transaction_row.category), '')),
  category_id = coalesce(
    nullif(transaction_row.category_id, ''),
    case when transaction_row.type in ('income', 'expense') and nullif(btrim(transaction_row.category), '') is not null
      then 'category-' || pg_temp.finance_v3_part(transaction_row.user_id::text) || '.'
        || pg_temp.finance_v3_part(transaction_row.type) || '.'
        || pg_temp.finance_v3_part(btrim(transaction_row.category))
    end
  ),
  account_name = coalesce(nullif(transaction_row.account_name, ''), nullif(btrim(transaction_row.account), '')),
  account_id = coalesce(
    nullif(transaction_row.account_id, ''),
    case when nullif(btrim(transaction_row.account), '') is not null
      then 'account-' || pg_temp.finance_v3_part(transaction_row.user_id::text) || '.'
        || pg_temp.finance_v3_part(btrim(transaction_row.account))
    end
  ),
  occurred_at = coalesce(nullif(transaction_row.occurred_at, ''), transaction_row.date),
  version = greatest(coalesce(transaction_row.version, 1), 1),
  updated_at = coalesce(transaction_row.updated_at, transaction_timestamp()),
  last_operation_id = case
    when nullif(transaction_row.last_operation_id, '') is null
      or transaction_row.last_operation_id = 'legacy-unversioned'
    then 'operation-' || pg_temp.finance_v3_part(transaction_row.user_id::text) || '.'
      || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(transaction_row.id)
    else transaction_row.last_operation_id
  end
where transaction_row.user_id is not null
  and (
    transaction_row.last_operation_id is null
    or transaction_row.last_operation_id = 'legacy-unversioned'
  );

update public.goals as goal
set
  is_active = coalesce(goal.is_active, true),
  legacy_unit = coalesce(nullif(goal.legacy_unit, ''), nullif(goal.unit, '')),
  version = greatest(coalesce(goal.version, 1), 1),
  updated_at = coalesce(goal.updated_at, transaction_timestamp()),
  last_operation_id = case
    when nullif(goal.last_operation_id, '') is null or goal.last_operation_id = 'legacy-unversioned'
    then 'operation-' || pg_temp.finance_v3_part(goal.user_id::text) || '.'
      || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(goal.id)
    else goal.last_operation_id
  end
where goal.user_id is not null
  and (goal.last_operation_id is null or goal.last_operation_id = 'legacy-unversioned');

-- A legacy goal's current_amount becomes one auditable allocation. The legacy
-- value remains untouched for rollback/read compatibility; deterministic IDs
-- make this INSERT safe to retry without doubling allocated savings.
with prepared as (
  select
    goal.user_id,
    goal.id as goal_id,
    goal.current_amount as amount_delta,
    'allocation-' || pg_temp.finance_v3_part(goal.user_id::text) || '.'
      || pg_temp.finance_v3_part(goal.id) || '.'
      || pg_temp.finance_v3_part('legacy-current-amount') as id
  from public.goals as goal
  where goal.user_id is not null
    and goal.deleted_at is null
    and coalesce(goal.current_amount, 0) <> 0
    and goal.last_operation_id like 'operation-%'
)
insert into public.savings_allocations (
  user_id, id, goal_id, amount_delta, occurred_at, note,
  version, updated_at, last_operation_id
)
select
  user_id,
  id,
  goal_id,
  amount_delta,
  to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  '由舊版目標累計金額遷移',
  1,
  transaction_timestamp(),
  'operation-' || pg_temp.finance_v3_part(user_id::text) || '.'
    || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(id)
from prepared
on conflict (user_id, id) do nothing;

update public.budgets as budget
set
  scope = coalesce(
    nullif(budget.scope, ''),
    case when nullif(btrim(budget.category), '') is null then 'overall' else 'category' end
  ),
  category_name = coalesce(nullif(budget.category_name, ''), nullif(btrim(budget.category), '')),
  category_id = coalesce(
    nullif(budget.category_id, ''),
    case when nullif(btrim(budget.category), '') is not null
      then 'category-' || pg_temp.finance_v3_part(budget.user_id::text) || '.'
        || pg_temp.finance_v3_part('expense') || '.' || pg_temp.finance_v3_part(btrim(budget.category))
    end
  ),
  is_active = coalesce(budget.is_active, true),
  version = greatest(coalesce(budget.version, 1), 1),
  updated_at = coalesce(budget.updated_at, transaction_timestamp()),
  last_operation_id = case
    when nullif(budget.last_operation_id, '') is null or budget.last_operation_id = 'legacy-unversioned'
    then 'operation-' || pg_temp.finance_v3_part(budget.user_id::text) || '.'
      || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(budget.id)
    else budget.last_operation_id
  end
where budget.user_id is not null
  and (budget.last_operation_id is null or budget.last_operation_id = 'legacy-unversioned');

update public.subscriptions as subscription
set
  is_active = coalesce(subscription.is_active, true),
  requires_review = not (
    subscription.amount > 0
    and subscription.recurring_date between 1 and 31
    and nullif(btrim(subscription.name), '') is not null
    and nullif(btrim(subscription.category), '') is not null
    and nullif(btrim(subscription.account), '') is not null
  ),
  version = greatest(coalesce(subscription.version, 1), 1),
  updated_at = coalesce(subscription.updated_at, transaction_timestamp()),
  last_operation_id = case
    when nullif(subscription.last_operation_id, '') is null
      or subscription.last_operation_id = 'legacy-unversioned'
    then 'operation-' || pg_temp.finance_v3_part(subscription.user_id::text) || '.'
      || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(subscription.id)
    else subscription.last_operation_id
  end
where subscription.user_id is not null;

-- Migrate valid subscriptions to monthly expense rules. The first cursor is the
-- first legal billing date strictly after the database migration day. Using the
-- next date as a conservative cutoff cannot duplicate a same-day legacy auto
-- transaction and cannot become past-due because of the database/user timezone
-- boundary. Invalid subscriptions remain preserved/reviewable.
with migration_source as (
  select
    subscription.*,
    subscription.recurring_date::integer as anchor_day,
    current_date + 1 as migration_cutoff
  from public.subscriptions as subscription
  where subscription.user_id is not null
    and subscription.deleted_at is null
    and not subscription.requires_review
), eligible as (
  select
    migration_source.*,
    make_date(
      extract(year from migration_cutoff)::integer,
      extract(month from migration_cutoff)::integer,
      least(
        anchor_day,
        extract(day from (date_trunc('month', migration_cutoff) + interval '1 month - 1 day'))::integer
      )
    ) as this_month_date
  from migration_source
), scheduled as (
  select
    eligible.*,
    case
      when this_month_date >= migration_cutoff then this_month_date
      else make_date(
        extract(year from (date_trunc('month', migration_cutoff) + interval '1 month'))::integer,
        extract(month from (date_trunc('month', migration_cutoff) + interval '1 month'))::integer,
        least(
          anchor_day,
          extract(day from (date_trunc('month', migration_cutoff) + interval '2 months - 1 day'))::integer
        )
      )
    end as first_occurrence
  from eligible
)
insert into public.recurring_rules (
  user_id, id, name, type, amount, category_id, category_name,
  account_id, account_name, frequency, start_date, anchor_day,
  next_occurrence_date, is_active, note, version, updated_at,
  last_operation_id
)
select
  user_id,
  id,
  name,
  'expense',
  amount,
  'category-' || pg_temp.finance_v3_part(user_id::text) || '.'
    || pg_temp.finance_v3_part('expense') || '.' || pg_temp.finance_v3_part(btrim(category)),
  btrim(category),
  'account-' || pg_temp.finance_v3_part(user_id::text) || '.' || pg_temp.finance_v3_part(btrim(account)),
  btrim(account),
  'monthly',
  first_occurrence,
  anchor_day,
  first_occurrence,
  is_active,
  '由舊版固定開銷遷移；不回補遷移日前期數',
  1,
  transaction_timestamp(),
  'operation-' || pg_temp.finance_v3_part(user_id::text) || '.'
    || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part(id)
from scheduled
on conflict (user_id, id) do nothing;

update public.subscriptions as subscription
set migrated_recurring_rule_id = subscription.id
where subscription.user_id is not null
  and subscription.deleted_at is null
  and not subscription.requires_review
  and exists (
    select 1 from public.recurring_rules as rule
    where rule.user_id = subscription.user_id and rule.id = subscription.id
  );

-- Seed one settings row per known authenticated owner without overwriting an
-- existing preference. The first active goal is deterministic by stable ID.
with owners as (
  select user_id from public.transactions
  union select user_id from public.goals
  union select user_id from public.subscriptions
  union select user_id from public.budgets
  union select user_id from public.accounts
  union select user_id from public.categories
), prepared as (
  select
    owner.user_id,
    (
      select goal.id from public.goals as goal
      where goal.user_id = owner.user_id and goal.deleted_at is null and goal.is_active
      order by goal.id
      limit 1
    ) as active_goal_id
  from owners as owner
  where owner.user_id is not null
)
insert into public.settings (
  user_id, currency, locale, active_goal_id, version, updated_at, last_operation_id
)
select
  user_id,
  'TWD',
  'zh-TW',
  active_goal_id,
  1,
  transaction_timestamp(),
  'operation-' || pg_temp.finance_v3_part(user_id::text) || '.'
    || pg_temp.finance_v3_part('legacy-migration-v1') || '.' || pg_temp.finance_v3_part('settings')
from prepared
on conflict (user_id) do nothing;

-- Make the common sync clock contract explicit on evolved tables as well as new
-- tables. Named NOT VALID checks preserve any reviewable legacy inconsistency
-- while enforcing positive versions/non-empty operation IDs for future writes.
do $sync_constraints$
declare
  table_name text;
  version_constraint text;
  operation_constraint text;
begin
  foreach table_name in array array[
    'transactions', 'goals', 'subscriptions', 'budgets', 'accounts',
    'categories', 'adjustments', 'savings_allocations', 'recurring_rules', 'settings'
  ]
  loop
    version_constraint := 'finance_v3_' || table_name || '_version_check';
    operation_constraint := 'finance_v3_' || table_name || '_operation_check';

    if not exists (
      select 1 from pg_constraint
      where conname = version_constraint
        and conrelid = format('public.%I', table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (version >= 1) not valid',
        table_name,
        version_constraint
      );
    end if;

    if not exists (
      select 1 from pg_constraint
      where conname = operation_constraint
        and conrelid = format('public.%I', table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (last_operation_id <> '''') not valid',
        table_name,
        operation_constraint
      );
    end if;
  end loop;
end
$sync_constraints$;

-- Preserve reviewable legacy inconsistencies while preventing any new browser
-- write from creating records the v3 client cannot safely decode. NOT VALID
-- skips the historical validation scan but PostgreSQL enforces each check for
-- every row inserted or changed after this migration.
do $domain_constraints$
declare
  constraint_spec record;
begin
  for constraint_spec in
    select * from (values
      ('transactions', 'finance_v3_transactions_amount_check', 'amount > 0'),
      ('transactions', 'finance_v3_transactions_type_check', 'type in (''income'', ''expense'')'),
      ('transactions', 'finance_v3_transactions_relations_check',
        'category_id is not null and nullif(btrim(category_name), '''') is not null '
        || 'and account_id is not null and nullif(btrim(account_name), '''') is not null '
        || 'and nullif(btrim(occurred_at), '''') is not null'),
      ('goals', 'finance_v3_goals_target_amount_check', 'target_amount > 0'),
      ('budgets', 'finance_v3_budgets_amount_check', 'amount > 0'),
      ('budgets', 'finance_v3_budgets_period_check', 'period in (''weekly'', ''monthly'')'),
      ('budgets', 'finance_v3_budgets_scope_check', 'scope in (''overall'', ''category'')'),
      ('budgets', 'finance_v3_budgets_relation_check',
        '(scope = ''overall'' and category_id is null) or '
        || '(scope = ''category'' and category_id is not null '
        || 'and nullif(btrim(category_name), '''') is not null)'),
      ('accounts', 'finance_v3_accounts_name_check', 'nullif(btrim(name), '''') is not null'),
      ('categories', 'finance_v3_categories_name_check', 'nullif(btrim(name), '''') is not null')
    ) as checks(table_name, constraint_name, expression)
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = constraint_spec.constraint_name
        and conrelid = format('public.%I', constraint_spec.table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (%s) not valid',
        constraint_spec.table_name,
        constraint_spec.constraint_name,
        constraint_spec.expression
      );
    end if;
  end loop;
end
$domain_constraints$;

-- Referential checks are NOT VALID so inconsistent legacy rows remain available
-- for review. PostgreSQL still enforces each constraint for new/changed v3 rows.
do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_transactions_account_fk'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint finance_v3_transactions_account_fk
      foreign key (user_id, account_id) references public.accounts (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_transactions_category_fk'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint finance_v3_transactions_category_fk
      foreign key (user_id, category_id) references public.categories (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_transactions_recurring_rule_fk'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint finance_v3_transactions_recurring_rule_fk
      foreign key (user_id, recurring_rule_id) references public.recurring_rules (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_adjustments_account_fk'
      and conrelid = 'public.adjustments'::regclass
  ) then
    alter table public.adjustments
      add constraint finance_v3_adjustments_account_fk
      foreign key (user_id, account_id) references public.accounts (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_allocations_goal_fk'
      and conrelid = 'public.savings_allocations'::regclass
  ) then
    alter table public.savings_allocations
      add constraint finance_v3_allocations_goal_fk
      foreign key (user_id, goal_id) references public.goals (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_budgets_category_fk'
      and conrelid = 'public.budgets'::regclass
  ) then
    alter table public.budgets
      add constraint finance_v3_budgets_category_fk
      foreign key (user_id, category_id) references public.categories (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_recurring_rules_account_fk'
      and conrelid = 'public.recurring_rules'::regclass
  ) then
    alter table public.recurring_rules
      add constraint finance_v3_recurring_rules_account_fk
      foreign key (user_id, account_id) references public.accounts (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_recurring_rules_category_fk'
      and conrelid = 'public.recurring_rules'::regclass
  ) then
    alter table public.recurring_rules
      add constraint finance_v3_recurring_rules_category_fk
      foreign key (user_id, category_id) references public.categories (user_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'finance_v3_settings_goal_fk'
      and conrelid = 'public.settings'::regclass
  ) then
    alter table public.settings
      add constraint finance_v3_settings_goal_fk
      foreign key (user_id, active_goal_id) references public.goals (user_id, id) not valid;
  end if;
end
$constraints$;

-- PostgreSQL exposes an ON CONFLICT row to BEFORE UPDATE triggers as an UPDATE,
-- which is otherwise indistinguishable from a pre-v3 UPDATE that deliberately
-- changes current_amount without advancing the sync clock. Mark only the
-- enclosing INSERT statement so an acknowledged v3 UPSERT retry can preserve
-- rollback-readable legacy goal columns while a genuine legacy UPDATE remains
-- auditable. The transaction-local flag is reset after every INSERT statement.
create or replace function finance_private.set_goal_insert_statement_context()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  perform pg_catalog.set_config(
    'finance_private.goal_insert_statement_context',
    case when tg_when = 'BEFORE' then 'on' else 'off' end,
    true
  );
  return null;
end
$function$;

revoke all on function finance_private.set_goal_insert_statement_context()
  from public, anon, authenticated;

-- A pre-v3 client knows only the legacy display columns. Without a bridge, a
-- transaction or budget written after the one-time backfill would contain NULL
-- stable relations and make a v3 pull fail. This invoker-rights trigger creates
-- only same-owner account/category rows, so the ordinary RLS policies remain
-- authoritative. Legacy edits are assigned a fresh conflict clock before the
-- strict clock trigger runs.
create or replace function finance_private.bridge_legacy_finance_write()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  is_legacy_write boolean := false;
  category_display text;
  account_display text;
  category_stable_id text;
  account_stable_id text;
  operation_seed text;
  incoming_v3_clock boolean := false;
  goal_insert_statement boolean := false;
begin
  if tg_table_name = 'transactions' then
    if tg_op = 'INSERT' then
      is_legacy_write := new.category_id is null
        or new.account_id is null
        or nullif(btrim(new.occurred_at), '') is null;
    else
      is_legacy_write := new.version = old.version
        and new.last_operation_id = old.last_operation_id
        and to_jsonb(new) <> to_jsonb(old)
        and (
          old.last_operation_id like 'operation-%'
          or old.last_operation_id like 'legacy-%'
          or (
            new.category is distinct from old.category
            and new.category_id is not distinct from old.category_id
            and new.category_name is not distinct from old.category_name
          )
          or (
            new.account is distinct from old.account
            and new.account_id is not distinct from old.account_id
            and new.account_name is not distinct from old.account_name
          )
          or (
            new.date is distinct from old.date
            and new.occurred_at is not distinct from old.occurred_at
          )
        );
    end if;

    if not is_legacy_write then
      return new;
    end if;

    if new.type not in ('income', 'expense') then
      raise exception 'legacy transaction type must be income or expense' using errcode = '23514';
    end if;
    category_display := nullif(btrim(new.category), '');
    account_display := nullif(btrim(new.account), '');
    if category_display is null or account_display is null or nullif(btrim(new.date), '') is null then
      raise exception 'legacy transaction requires category, account, and date' using errcode = '23514';
    end if;

    category_stable_id := 'category-'
      || finance_private.finance_v3_part(new.user_id::text) || '.'
      || finance_private.finance_v3_part(new.type) || '.'
      || finance_private.finance_v3_part(category_display);
    account_stable_id := 'account-'
      || finance_private.finance_v3_part(new.user_id::text) || '.'
      || finance_private.finance_v3_part(account_display);

    insert into public.accounts (
      user_id, id, name, icon_type, icon_value, opening_balance,
      include_in_total_assets, is_active, sort_order, legacy_key,
      requires_review, version, updated_at, last_operation_id
    ) values (
      new.user_id,
      account_stable_id,
      account_display,
      case when account_display ~* '(現金|cash)' then 'emoji' else 'vector' end,
      case
        when account_display ~* '(現金|cash)' then '💵'
        when account_display ~* '(支付|錢包|wallet|pay)' then 'wallet-cards'
        else 'wallet'
      end,
      0,
      account_display ~* '(現金|cash|支付|街口|錢包|wallet|e-?wallet|悠遊|一卡通|pay)',
      true,
      0,
      account_display,
      not (account_display ~* '(現金|cash|支付|街口|錢包|wallet|e-?wallet|悠遊|一卡通|pay)'),
      1,
      clock_timestamp(),
      'legacy-bridge-account-' || md5(new.user_id::text || account_stable_id)
    ) on conflict (user_id, id) do nothing;

    insert into public.categories (
      user_id, id, kind, name, icon_type, icon_value, is_active,
      sort_order, legacy_key, version, updated_at, last_operation_id
    ) values (
      new.user_id,
      category_stable_id,
      new.type,
      category_display,
      'vector',
      case when new.type = 'expense' then 'tag' else 'badge-dollar-sign' end,
      true,
      0,
      new.type || ':' || category_display,
      1,
      clock_timestamp(),
      'legacy-bridge-category-' || md5(new.user_id::text || category_stable_id)
    ) on conflict (user_id, id) do nothing;

    new.category_id := category_stable_id;
    new.category_name := category_display;
    new.account_id := account_stable_id;
    new.account_name := account_display;
    new.occurred_at := new.date;
  elsif tg_table_name = 'budgets' then
    if tg_op = 'INSERT' then
      is_legacy_write := new.scope is null
        or (new.scope = 'category' and new.category_id is null);
    else
      is_legacy_write := new.version = old.version
        and new.last_operation_id = old.last_operation_id
        and to_jsonb(new) <> to_jsonb(old)
        and (
          old.last_operation_id like 'operation-%'
          or old.last_operation_id like 'legacy-%'
          or (
            new.category is distinct from old.category
            and new.category_id is not distinct from old.category_id
            and new.category_name is not distinct from old.category_name
          )
        );
    end if;

    if not is_legacy_write then
      return new;
    end if;

    category_display := nullif(btrim(new.category), '');
    if category_display is null then
      new.scope := 'overall';
      new.category_id := null;
      new.category_name := null;
    else
      category_stable_id := 'category-'
        || finance_private.finance_v3_part(new.user_id::text) || '.'
        || finance_private.finance_v3_part('expense') || '.'
        || finance_private.finance_v3_part(category_display);
      insert into public.categories (
        user_id, id, kind, name, icon_type, icon_value, is_active,
        sort_order, legacy_key, version, updated_at, last_operation_id
      ) values (
        new.user_id,
        category_stable_id,
        'expense',
        category_display,
        'vector',
        'tag',
        true,
        0,
        'expense:' || category_display,
        1,
        clock_timestamp(),
        'legacy-bridge-category-' || md5(new.user_id::text || category_stable_id)
      ) on conflict (user_id, id) do nothing;
      new.scope := 'category';
      new.category_id := category_stable_id;
      new.category_name := category_display;
    end if;
  elsif tg_table_name = 'goals' then
    if tg_op = 'INSERT' then
      is_legacy_write := new.last_operation_id = 'legacy-unversioned';
    else
      goal_insert_statement := coalesce(
        pg_catalog.current_setting('finance_private.goal_insert_statement_context', true),
        'off'
      ) = 'on';
      incoming_v3_clock := new.version > old.version
        or (
          new.version = old.version
          and new.last_operation_id > old.last_operation_id
        );

      -- PostgREST generic UPSERT may materialize omitted legacy-only columns as
      -- their INSERT defaults in EXCLUDED. Allocations are authoritative in v3,
      -- so a newer v3 clock must never reset the rollback-readable legacy total
      -- or manufacture an allocation delta. A pre-v3 update has the same clock
      -- and therefore continues through the legacy bridge below.
      if incoming_v3_clock or (
        goal_insert_statement
        and new.version = old.version
        and new.last_operation_id = old.last_operation_id
        and new.last_operation_id <> 'legacy-unversioned'
        and new.last_operation_id not like 'legacy-%'
      ) then
        new.current_amount := old.current_amount;
        new.unit := old.unit;
      end if;

      is_legacy_write := new.version = old.version
        and new.last_operation_id = old.last_operation_id
        and to_jsonb(new) <> to_jsonb(old)
        and (
          old.last_operation_id like 'operation-%'
          or old.last_operation_id like 'legacy-%'
          or new.current_amount is distinct from old.current_amount
        );
    end if;

    if not is_legacy_write then
      return new;
    end if;
  end if;

  if is_legacy_write then
    operation_seed := new.user_id::text || ':' || tg_table_name || ':'
      || new.id::text || ':' || clock_timestamp()::text || ':' || txid_current()::text;
    if tg_op = 'UPDATE' then
      new.version := greatest(old.version + 1, 1);
      new.last_operation_id := 'legacy-update-' || md5(operation_seed);
    elsif new.last_operation_id is null or new.last_operation_id = 'legacy-unversioned' then
      new.version := greatest(coalesce(new.version, 1), 1);
      new.last_operation_id := 'legacy-insert-'
        || md5(new.user_id::text || ':' || tg_table_name || ':' || new.id::text);
    end if;
    new.updated_at := clock_timestamp();
  end if;

  return new;
end
$function$;

revoke all on function finance_private.bridge_legacy_finance_write() from public, anon, authenticated;

-- Convert every post-migration legacy goal total change into one auditable delta.
-- The goal write and allocation insert share a transaction, so an RLS/FK failure
-- rolls both back rather than leaving the two accounting representations apart.
create or replace function finance_private.audit_legacy_goal_total()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  amount_change numeric;
  allocation_id text;
begin
  amount_change := new.current_amount - case when tg_op = 'INSERT' then 0 else old.current_amount end;
  if amount_change = 0 then
    return new;
  end if;

  allocation_id := 'allocation-'
    || finance_private.finance_v3_part(new.user_id::text) || '.'
    || finance_private.finance_v3_part(new.id::text) || '.'
    || finance_private.finance_v3_part('legacy-write-' || new.last_operation_id);

  insert into public.savings_allocations (
    user_id, id, goal_id, amount_delta, occurred_at, note,
    version, updated_at, last_operation_id
  ) values (
    new.user_id,
    allocation_id,
    new.id,
    amount_change,
    to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    '由舊版目標累計金額變更自動建立',
    1,
    clock_timestamp(),
    'legacy-goal-allocation-' || md5(new.user_id::text || allocation_id)
  ) on conflict (user_id, id) do nothing;

  return new;
end
$function$;

revoke all on function finance_private.audit_legacy_goal_total() from public, anon, authenticated;

do $legacy_bridge_triggers$
declare
  table_name text;
begin
  drop trigger if exists finance_v3_00_goal_insert_context on public.goals;
  create trigger finance_v3_00_goal_insert_context
    before insert on public.goals
    for each statement execute function finance_private.set_goal_insert_statement_context();

  drop trigger if exists finance_v3_99_goal_insert_context on public.goals;
  create trigger finance_v3_99_goal_insert_context
    after insert on public.goals
    for each statement execute function finance_private.set_goal_insert_statement_context();

  foreach table_name in array array['transactions', 'budgets', 'goals']
  loop
    execute format(
      'drop trigger if exists finance_v3_00_legacy_bridge on public.%I',
      table_name
    );
    execute format(
      'create trigger finance_v3_00_legacy_bridge before insert or update on public.%I '
      || 'for each row execute function finance_private.bridge_legacy_finance_write()',
      table_name
    );
  end loop;

  drop trigger if exists finance_v3_legacy_goal_allocation on public.goals;
  create trigger finance_v3_legacy_goal_allocation
    after insert or update on public.goals
    for each row execute function finance_private.audit_legacy_goal_total();
end
$legacy_bridge_triggers$;

-- A recurring occurrence remains unique even after a tombstone, preventing a
-- retry/reconciliation pass from resurrecting a user-deleted occurrence.
create unique index if not exists finance_v3_transactions_recurring_occurrence_uidx
  on public.transactions (user_id, recurring_rule_id, occurrence_date)
  where recurring_rule_id is not null and occurrence_date is not null;

-- Atomic conflict-clock enforcement for PostgREST UPSERT. This trigger runs in
-- the caller's privileges, never bypasses RLS, and returns OLD for a stale retry.
create or replace function finance_private.keep_newest_sync_record()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'finance record owner is immutable' using errcode = '42501';
  end if;

  if new.version < old.version
    or (new.version = old.version and new.last_operation_id < old.last_operation_id)
  then
    return old;
  end if;

  if new.version = old.version and new.last_operation_id = old.last_operation_id then
    if to_jsonb(new) = to_jsonb(old) then
      return old;
    end if;

    raise exception 'conflicting payload for identical finance sync clock'
      using errcode = '40001';
  end if;

  return new;
end
$function$;

revoke all on function finance_private.keep_newest_sync_record() from public, anon, authenticated;

do $triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'accounts', 'categories', 'transactions', 'adjustments', 'goals',
    'savings_allocations', 'budgets', 'recurring_rules'
  ]
  loop
    execute format(
      'drop trigger if exists finance_v3_conflict_clock on public.%I',
      table_name
    );
    execute format(
      'create trigger finance_v3_conflict_clock before update on public.%I '
      || 'for each row execute function finance_private.keep_newest_sync_record()',
      table_name
    );
  end loop;
end
$triggers$;

-- Replace every legacy policy on finance-owned tables. PostgreSQL policies are
-- permissive by default, so leaving one broad historical policy would defeat a
-- newly added owner policy through OR semantics.
do $rls$
declare
  table_name text;
  policy_record record;
begin
  foreach table_name in array array[
    'transactions', 'goals', 'subscriptions', 'budgets', 'accounts',
    'categories', 'adjustments', 'savings_allocations', 'recurring_rules', 'settings'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);

    for policy_record in
      select policyname
      from pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute format('drop policy %I on public.%I', policy_record.policyname, table_name);
    end loop;

    execute format(
      'create policy finance_owner_select on public.%I for select to authenticated '
      || 'using ((select auth.uid()) = user_id)',
      table_name
    );
    execute format(
      'create policy finance_owner_insert on public.%I for insert to authenticated '
      || 'with check ((select auth.uid()) = user_id)',
      table_name
    );
    execute format(
      'create policy finance_owner_update on public.%I for update to authenticated '
      || 'using ((select auth.uid()) = user_id) '
      || 'with check ((select auth.uid()) = user_id)',
      table_name
    );
    execute format(
      'create policy finance_owner_delete on public.%I for delete to authenticated '
      || 'using ((select auth.uid()) = user_id)',
      table_name
    );

    execute format('revoke all privileges on table public.%I from anon, public', table_name);
    execute format('revoke all privileges on table public.%I from authenticated', table_name);
    execute format(
      'grant select, insert, update, delete on table public.%I to authenticated',
      table_name
    );
    execute format('grant all privileges on table public.%I to service_role', table_name);
  end loop;
end
$rls$;

-- The bridge runs with caller privileges and therefore still relies on the
-- ordinary table grants/RLS above. Authenticated callers may execute only the
-- pure stable-ID helper; trigger mutation functions remain inaccessible.
grant usage on schema finance_private to authenticated, service_role;
grant execute on function finance_private.finance_v3_part(text) to authenticated, service_role;

-- Opt out of legacy automatic exposure for future public objects created by the
-- postgres migration owner. Every future Data API table/function must be granted
-- deliberately together with its RLS/security review.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
-- PostgreSQL's built-in function default is EXECUTE for PUBLIC. The global
-- revoke is required in addition to clearing legacy schema-specific role ACLs.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;

commit;
