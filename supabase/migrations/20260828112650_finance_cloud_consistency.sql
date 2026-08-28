-- Align server allocation capacity with the client's per-record minor-unit
-- arithmetic, and make authoritative bootstrap scans reject mixed remote views.
-- This migration is additive and does not rewrite persisted financial values.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';

-- Legacy values retain up to six decimals at rest. Capacity arithmetic rounds
-- every contributing value to cents before summing, matching toMinorUnits().
-- PostgreSQL numeric round breaks exact half-way ties away from zero.
create or replace function finance_private.enforce_allocation_capacity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  existing_allocation public.savings_allocations%rowtype;
  existing_contribution_minor_units numeric := 0;
  new_contribution_minor_units numeric := 0;
  goal_allocated_elsewhere_minor_units numeric := 0;
  existing_goal_total_minor_units numeric := 0;
  proposed_goal_total_minor_units numeric := 0;
  total_assets_minor_units numeric := 0;
  allocated_elsewhere_minor_units numeric := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('finance-v3-allocation:' || new.user_id::text, 0)
  );

  select * into existing_allocation
  from public.savings_allocations
  where user_id = new.user_id and id = new.id;

  if found then
    if existing_allocation.version > new.version
      or (existing_allocation.version = new.version
        and existing_allocation.last_operation_id >= new.last_operation_id)
    then
      return new;
    end if;
    if new.goal_id is distinct from existing_allocation.goal_id
      or new.amount_delta is distinct from existing_allocation.amount_delta
      or new.occurred_at is distinct from existing_allocation.occurred_at
    then
      raise exception 'savings allocation economic fields are immutable'
        using errcode = '23514', constraint = 'finance_v3_allocation_immutable';
    end if;
    if existing_allocation.deleted_at is null then
      existing_contribution_minor_units := pg_catalog.round(
        existing_allocation.amount_delta * 100,
        0
      );
    end if;
  end if;

  if tg_op = 'UPDATE' and new.deleted_at is not null and coalesce(
    pg_catalog.current_setting('finance_private.legacy_delete_tombstone', true), 'off'
  ) = 'on' then
    return new;
  end if;

  if new.deleted_at is null then
    new_contribution_minor_units := pg_catalog.round(new.amount_delta * 100, 0);
  end if;

  if new_contribution_minor_units > existing_contribution_minor_units and not exists (
    select 1 from public.goals as goal
    where goal.user_id = new.user_id and goal.id = new.goal_id
      and goal.deleted_at is null and goal.is_active
  ) then
    raise exception 'new savings allocation requires an active goal'
      using errcode = '23514', constraint = 'finance_v3_allocation_active_goal';
  end if;

  select coalesce(sum(pg_catalog.round(allocation.amount_delta * 100, 0)), 0)
  into goal_allocated_elsewhere_minor_units
  from public.savings_allocations as allocation
  where allocation.user_id = new.user_id and allocation.goal_id = new.goal_id
    and allocation.id <> new.id and allocation.deleted_at is null;
  existing_goal_total_minor_units := goal_allocated_elsewhere_minor_units
    + existing_contribution_minor_units;
  proposed_goal_total_minor_units := goal_allocated_elsewhere_minor_units
    + new_contribution_minor_units;
  if new.deleted_at is null and proposed_goal_total_minor_units < 0
    and proposed_goal_total_minor_units < existing_goal_total_minor_units
  then
    raise exception 'savings allocation cannot make a goal total negative'
      using errcode = '23514', constraint = 'finance_v3_allocation_nonnegative_total';
  end if;
  if new_contribution_minor_units <= existing_contribution_minor_units then return new; end if;

  select coalesce(sum(pg_catalog.round(account.opening_balance * 100, 0)), 0)
  into total_assets_minor_units
  from public.accounts as account
  where account.user_id = new.user_id and account.deleted_at is null
    and account.is_active and account.include_in_total_assets;

  total_assets_minor_units := total_assets_minor_units + coalesce((
    select sum(case when transaction.type = 'income'
      then pg_catalog.round(transaction.amount * 100, 0)
      else -pg_catalog.round(transaction.amount * 100, 0) end)
    from public.transactions as transaction
    join public.accounts as account
      on account.user_id = transaction.user_id and account.id = transaction.account_id
      and account.deleted_at is null and account.is_active
      and account.include_in_total_assets
    where transaction.user_id = new.user_id and transaction.deleted_at is null
      and transaction.note is distinct from
        '🐕 柴柴互動教學紀錄（教學完成後會安全刪除）'
  ), 0);

  total_assets_minor_units := total_assets_minor_units + coalesce((
    select sum(pg_catalog.round(adjustment.amount_delta * 100, 0))
    from public.adjustments as adjustment
    join public.accounts as account
      on account.user_id = adjustment.user_id and account.id = adjustment.account_id
      and account.deleted_at is null and account.is_active
      and account.include_in_total_assets
    where adjustment.user_id = new.user_id and adjustment.deleted_at is null
  ), 0);

  total_assets_minor_units := total_assets_minor_units + coalesce((
    select sum(
      case when exists (
        select 1 from public.accounts as source_account
        where source_account.user_id = transfer.user_id
          and source_account.id = transfer.source_account_id
          and source_account.deleted_at is null and source_account.is_active
          and source_account.include_in_total_assets
      ) then -pg_catalog.round(transfer.amount * 100, 0) else 0 end
      + case when exists (
        select 1 from public.accounts as destination_account
        where destination_account.user_id = transfer.user_id
          and destination_account.id = transfer.destination_account_id
          and destination_account.deleted_at is null and destination_account.is_active
          and destination_account.include_in_total_assets
      ) then pg_catalog.round(transfer.amount * 100, 0) else 0 end
    )
    from public.transfers as transfer
    where transfer.user_id = new.user_id and transfer.deleted_at is null
  ), 0);

  select coalesce(sum(pg_catalog.round(allocation.amount_delta * 100, 0)), 0)
  into allocated_elsewhere_minor_units
  from public.savings_allocations as allocation
  where allocation.user_id = new.user_id and allocation.id <> new.id
    and allocation.deleted_at is null;

  if allocated_elsewhere_minor_units + new_contribution_minor_units
    > total_assets_minor_units
  then
    raise exception 'new savings allocation exceeds available assets'
      using errcode = '23514', constraint = 'finance_v3_allocation_capacity',
        hint = 'Release an existing allocation or increase total assets before retrying.';
  end if;
  return new;
end
$function$;

revoke all on function finance_private.enforce_allocation_capacity()
  from public, anon, authenticated;

-- A revision changes in the same transaction as every authoritative remote-row
-- mutation. Bracketing a paged scan with the revision therefore proves that no
-- committed insert, update, or delete changed the owner's view mid-scan.
create table if not exists finance_private.bootstrap_revisions (
  user_id uuid primary key,
  revision bigint not null default 0,
  constraint finance_bootstrap_revision_nonnegative check (revision >= 0)
);

alter table finance_private.bootstrap_revisions enable row level security;
revoke all privileges on table finance_private.bootstrap_revisions
  from public, anon, authenticated, service_role;

create or replace function finance_private.bump_bootstrap_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  previous_owner uuid;
  next_owner uuid;
begin
  if tg_op = 'UPDATE' and pg_catalog.to_jsonb(old) = pg_catalog.to_jsonb(new) then
    return new;
  end if;

  if tg_op <> 'INSERT' then previous_owner := old.user_id; end if;
  if tg_op <> 'DELETE' then next_owner := new.user_id; end if;

  if previous_owner is not null then
    insert into finance_private.bootstrap_revisions (user_id, revision)
    values (previous_owner, 1)
    on conflict (user_id) do update
    set revision = finance_private.bootstrap_revisions.revision + 1;
  end if;

  if next_owner is not null and next_owner is distinct from previous_owner then
    insert into finance_private.bootstrap_revisions (user_id, revision)
    values (next_owner, 1)
    on conflict (user_id) do update
    set revision = finance_private.bootstrap_revisions.revision + 1;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

revoke all on function finance_private.bump_bootstrap_revision()
  from public, anon, authenticated, service_role;

do $revision_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'accounts', 'categories', 'transactions', 'transfers', 'adjustments',
    'goals', 'savings_allocations', 'budgets', 'recurring_rules'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists finance_v4_bump_bootstrap_revision on public.%I',
      table_name
    );
    execute pg_catalog.format(
      'create trigger finance_v4_bump_bootstrap_revision '
      || 'after insert or update or delete on public.%I '
      || 'for each row execute function finance_private.bump_bootstrap_revision()',
      table_name
    );
  end loop;
end
$revision_triggers$;

-- No owner argument is accepted: the only observable token belongs to auth.uid().
-- Text preserves bigint equality in JavaScript without IEEE-754 precision loss.
create or replace function public.finance_v4_bootstrap_revision()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_id uuid := auth.uid();
  caller_revision bigint;
begin
  if caller_id is null then
    raise exception 'authenticated finance owner required'
      using errcode = '42501';
  end if;

  select revision into caller_revision
  from finance_private.bootstrap_revisions
  where user_id = caller_id;

  return pg_catalog.jsonb_build_object(
    'owner_id', caller_id::text,
    'revision', coalesce(caller_revision, 0::bigint)::text
  );
end
$function$;

revoke all on function public.finance_v4_bootstrap_revision()
  from public, anon, authenticated, service_role;
grant execute on function public.finance_v4_bootstrap_revision()
  to authenticated;

commit;
