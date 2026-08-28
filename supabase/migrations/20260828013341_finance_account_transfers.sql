-- Expense Tracker: first-class atomic account-to-account transfers.
--
-- A transfer is one owner-scoped sync record. It is never represented as two
-- independently mutable transactions, so offline replay cannot apply only one
-- side. This migration is additive and does not rewrite existing records.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';

create table if not exists public.transfers (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  amount numeric not null,
  source_account_id text not null,
  source_account_name text not null,
  destination_account_id text not null,
  destination_account_name text not null,
  occurred_at text not null,
  note text,
  version bigint not null default 1,
  updated_at timestamptz not null default transaction_timestamp(),
  last_operation_id text not null,
  deleted_at timestamptz,
  primary key (user_id, id),
  constraint finance_v3_transfers_amount_check check (amount > 0),
  constraint finance_v3_transfers_distinct_accounts_check
    check (source_account_id <> destination_account_id),
  constraint finance_v3_transfers_relations_check check (
    nullif(btrim(source_account_id), '') is not null
    and nullif(btrim(source_account_name), '') is not null
    and nullif(btrim(destination_account_id), '') is not null
    and nullif(btrim(destination_account_name), '') is not null
    and nullif(btrim(occurred_at), '') is not null
  ),
  constraint finance_v3_transfers_version_check check (version >= 1),
  constraint finance_v3_transfers_operation_check check (last_operation_id <> ''),
  constraint finance_v3_transfers_id_len_chk
    check (pg_catalog.octet_length(id) <= 4096),
  constraint finance_v3_transfers_source_account_id_len_chk
    check (pg_catalog.octet_length(source_account_id) <= 4096),
  constraint finance_v3_transfers_source_account_name_len_chk
    check (pg_catalog.octet_length(source_account_name) <= 512),
  constraint finance_v3_transfers_destination_account_id_len_chk
    check (pg_catalog.octet_length(destination_account_id) <= 4096),
  constraint finance_v3_transfers_destination_account_name_len_chk
    check (pg_catalog.octet_length(destination_account_name) <= 512),
  constraint finance_v3_transfers_occurred_at_len_chk
    check (pg_catalog.octet_length(occurred_at) <= 128),
  constraint finance_v3_transfers_note_len_chk
    check (note is null or pg_catalog.octet_length(note) <= 4096),
  constraint finance_v3_transfers_last_operation_id_len_chk
    check (pg_catalog.octet_length(last_operation_id) <= 4096),
  constraint finance_v3_transfers_amount_numeric_chk check (
    pg_catalog.pg_column_size(amount) <= 32
    and pg_catalog.abs(amount) <= 100000000
    and amount = pg_catalog.round(amount, 6)
  ),
  constraint finance_v3_transfers_source_account_fk
    foreign key (user_id, source_account_id)
    references public.accounts (user_id, id),
  constraint finance_v3_transfers_destination_account_fk
    foreign key (user_id, destination_account_id)
    references public.accounts (user_id, id)
);

create unique index if not exists finance_v3_transfers_user_id_id_uidx
  on public.transfers (user_id, id);
create index if not exists finance_v3_transfers_user_id_idx
  on public.transfers (user_id);
create index if not exists finance_v3_transfers_source_account_idx
  on public.transfers (user_id, source_account_id, occurred_at desc);
create index if not exists finance_v3_transfers_destination_account_idx
  on public.transfers (user_id, destination_account_id, occurred_at desc);

-- Preserve historical endpoints, but require active owner-scoped accounts and
-- exact account-name snapshots when a transfer is first created or retargeted.
-- PostgREST UPSERT executes BEFORE INSERT before discovering an existing key,
-- so the trigger recognizes an unchanged endpoint pair before enforcing the
-- new-transfer checks. The conflict-clock trigger remains authoritative later.
create or replace function finance_private.validate_transfer_accounts()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  existing_transfer public.transfers%rowtype;
  historical_transfer public.transfers%rowtype;
  source_account public.accounts%rowtype;
  destination_account public.accounts%rowtype;
  endpoints_unchanged boolean := false;
  has_existing boolean := false;
begin
  if tg_op = 'UPDATE' then
    has_existing := true;
    historical_transfer := old;
    endpoints_unchanged := new.source_account_id = old.source_account_id
      and new.destination_account_id = old.destination_account_id;
  else
    select * into existing_transfer
    from public.transfers
    where user_id = new.user_id and id = new.id;
    if found then
      has_existing := true;
      historical_transfer := existing_transfer;
      endpoints_unchanged := new.source_account_id = existing_transfer.source_account_id
        and new.destination_account_id = existing_transfer.destination_account_id;
    end if;
  end if;

  -- Account validation runs before the generic conflict-clock trigger. Do not
  -- let an unavailable historical endpoint turn a stale/idempotent UPSERT into
  -- a new domain error; the later trigger will retain OLD or reject a divergent
  -- equal-clock payload exactly as it does for every other sync entity.
  if has_existing and (
    historical_transfer.version > new.version
    or (
      historical_transfer.version = new.version
      and historical_transfer.last_operation_id >= new.last_operation_id
    )
  ) then
    return new;
  end if;

  if endpoints_unchanged then
    if new.source_account_name is distinct from historical_transfer.source_account_name
      or new.destination_account_name is distinct from historical_transfer.destination_account_name
    then
      raise exception 'historical transfer account snapshots are immutable'
        using errcode = '23514', constraint = 'finance_v3_transfer_snapshot_immutable';
    end if;
    return new;
  end if;

  if new.deleted_at is not null then
    return new;
  end if;

  select * into source_account
  from public.accounts
  where user_id = new.user_id and id = new.source_account_id;
  select * into destination_account
  from public.accounts
  where user_id = new.user_id and id = new.destination_account_id;

  if source_account.id is null or source_account.deleted_at is not null or not source_account.is_active then
    raise exception 'transfer source account must be active'
      using errcode = '23514', constraint = 'finance_v3_transfer_active_source';
  end if;
  if destination_account.id is null
    or destination_account.deleted_at is not null
    or not destination_account.is_active
  then
    raise exception 'transfer destination account must be active'
      using errcode = '23514', constraint = 'finance_v3_transfer_active_destination';
  end if;
  if new.source_account_name is distinct from source_account.name
    or new.destination_account_name is distinct from destination_account.name
  then
    raise exception 'transfer account snapshot name does not match its account'
      using errcode = '23514', constraint = 'finance_v3_transfer_account_snapshot';
  end if;

  return new;
end
$function$;

revoke all on function finance_private.validate_transfer_accounts()
  from public, anon, authenticated;

drop trigger if exists finance_v3_20_validate_transfer_accounts on public.transfers;
create trigger finance_v3_20_validate_transfer_accounts
before insert or update on public.transfers
for each row execute function finance_private.validate_transfer_accounts();

drop trigger if exists finance_v3_conflict_clock on public.transfers;
create trigger finance_v3_conflict_clock
before update on public.transfers
for each row execute function finance_private.keep_newest_sync_record();

-- Extend the existing per-owner abuse guard to cover transfer tombstones too.
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
    when 'transfers' then 25000
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
      tg_table_name using errcode = '55000';
  end if;

  request_owner := auth.uid();
  if pg_catalog.current_setting('role', true) = 'authenticated'
    and (request_owner is null or new.user_id is distinct from request_owner)
  then
    raise exception 'row-level security owner guard rejected a foreign-owner write'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text || ':' || tg_table_name, 0)
  );

  execute pg_catalog.format(
    'select exists (select 1 from public.%I where user_id = $1 and id = $2)',
    tg_table_name
  ) into record_exists using new.user_id, new.id;
  if record_exists then return new; end if;

  execute pg_catalog.format(
    'select count(*) from public.%I where user_id = $1', tg_table_name
  ) into existing_rows using new.user_id;
  if existing_rows >= maximum_rows then
    raise exception 'owner resource limit exceeded for public.% (maximum % rows)',
      tg_table_name, maximum_rows
      using errcode = '54000',
        constraint = 'finance_v3_owner_resource_limit',
        hint = 'Archive cleanup does not release quota; contact support for reviewed recovery.';
  end if;
  return new;
end
$function$;

revoke all on function finance_private.enforce_owner_resource_limit()
  from public, anon, authenticated;

drop trigger if exists finance_v3_10_owner_resource_limit on public.transfers;
create trigger finance_v3_10_owner_resource_limit
before insert on public.transfers
for each row execute function finance_private.enforce_owner_resource_limit();

-- Recreate the allocation guard so available-assets validation includes the
-- net movement when exactly one side of a transfer counts toward total assets.
create or replace function finance_private.enforce_allocation_capacity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  existing_allocation public.savings_allocations%rowtype;
  existing_contribution numeric := 0;
  new_contribution numeric := 0;
  goal_allocated_elsewhere numeric := 0;
  existing_goal_total numeric := 0;
  proposed_goal_total numeric := 0;
  total_assets numeric := 0;
  allocated_elsewhere numeric := 0;
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
      existing_contribution := existing_allocation.amount_delta;
    end if;
  end if;

  if tg_op = 'UPDATE' and new.deleted_at is not null and coalesce(
    pg_catalog.current_setting('finance_private.legacy_delete_tombstone', true), 'off'
  ) = 'on' then
    return new;
  end if;

  if new.deleted_at is null then new_contribution := new.amount_delta; end if;

  if new_contribution > existing_contribution and not exists (
    select 1 from public.goals as goal
    where goal.user_id = new.user_id and goal.id = new.goal_id
      and goal.deleted_at is null and goal.is_active
  ) then
    raise exception 'new savings allocation requires an active goal'
      using errcode = '23514', constraint = 'finance_v3_allocation_active_goal';
  end if;

  select coalesce(sum(allocation.amount_delta), 0)
  into goal_allocated_elsewhere
  from public.savings_allocations as allocation
  where allocation.user_id = new.user_id and allocation.goal_id = new.goal_id
    and allocation.id <> new.id and allocation.deleted_at is null;
  existing_goal_total := goal_allocated_elsewhere + existing_contribution;
  proposed_goal_total := goal_allocated_elsewhere + new_contribution;
  if new.deleted_at is null and proposed_goal_total < 0
    and proposed_goal_total < existing_goal_total
  then
    raise exception 'savings allocation cannot make a goal total negative'
      using errcode = '23514', constraint = 'finance_v3_allocation_nonnegative_total';
  end if;
  if new_contribution <= existing_contribution then return new; end if;

  select coalesce(sum(account.opening_balance), 0)
  into total_assets
  from public.accounts as account
  where account.user_id = new.user_id and account.deleted_at is null
    and account.is_active and account.include_in_total_assets;

  total_assets := total_assets + coalesce((
    select sum(case when transaction.type = 'income'
      then transaction.amount else -transaction.amount end)
    from public.transactions as transaction
    join public.accounts as account
      on account.user_id = transaction.user_id and account.id = transaction.account_id
      and account.deleted_at is null and account.is_active
      and account.include_in_total_assets
    where transaction.user_id = new.user_id and transaction.deleted_at is null
  ), 0);

  total_assets := total_assets + coalesce((
    select sum(adjustment.amount_delta)
    from public.adjustments as adjustment
    join public.accounts as account
      on account.user_id = adjustment.user_id and account.id = adjustment.account_id
      and account.deleted_at is null and account.is_active
      and account.include_in_total_assets
    where adjustment.user_id = new.user_id and adjustment.deleted_at is null
  ), 0);

  total_assets := total_assets + coalesce((
    select sum(
      case when exists (
        select 1 from public.accounts as source_account
        where source_account.user_id = transfer.user_id
          and source_account.id = transfer.source_account_id
          and source_account.deleted_at is null and source_account.is_active
          and source_account.include_in_total_assets
      ) then -transfer.amount else 0 end
      + case when exists (
        select 1 from public.accounts as destination_account
        where destination_account.user_id = transfer.user_id
          and destination_account.id = transfer.destination_account_id
          and destination_account.deleted_at is null and destination_account.is_active
          and destination_account.include_in_total_assets
      ) then transfer.amount else 0 end
    )
    from public.transfers as transfer
    where transfer.user_id = new.user_id and transfer.deleted_at is null
  ), 0);

  select coalesce(sum(allocation.amount_delta), 0)
  into allocated_elsewhere
  from public.savings_allocations as allocation
  where allocation.user_id = new.user_id and allocation.id <> new.id
    and allocation.deleted_at is null;

  if allocated_elsewhere + new_contribution > total_assets then
    raise exception 'new savings allocation exceeds available assets'
      using errcode = '23514', constraint = 'finance_v3_allocation_capacity',
        hint = 'Release an existing allocation or increase total assets before retrying.';
  end if;
  return new;
end
$function$;

revoke all on function finance_private.enforce_allocation_capacity()
  from public, anon, authenticated;

alter table public.transfers enable row level security;
drop policy if exists finance_owner_select on public.transfers;
drop policy if exists finance_owner_insert on public.transfers;
drop policy if exists finance_owner_update on public.transfers;
create policy finance_owner_select on public.transfers for select to authenticated
  using ((select auth.uid()) = user_id);
create policy finance_owner_insert on public.transfers for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy finance_owner_update on public.transfers for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all privileges on table public.transfers from anon, public, authenticated;
grant select, insert, update on table public.transfers to authenticated;
grant all privileges on table public.transfers to service_role;

commit;
