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
  historical_import_batch text := coalesce(
    pg_catalog.current_setting('finance_private.historical_transfer_import', true),
    ''
  );
  source_unchanged boolean := false;
  destination_unchanged boolean := false;
  has_existing boolean := false;
begin
  if tg_op = 'UPDATE' then
    has_existing := true;
    historical_transfer := old;
    source_unchanged := new.source_account_id = old.source_account_id;
    destination_unchanged := new.destination_account_id = old.destination_account_id;
  else
    select * into existing_transfer
    from public.transfers
    where user_id = new.user_id and id = new.id;
    if found then
      has_existing := true;
      historical_transfer := existing_transfer;
      source_unchanged := new.source_account_id = existing_transfer.source_account_id;
      destination_unchanged := new.destination_account_id = existing_transfer.destination_account_id;
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

  if has_existing and source_unchanged
    and new.source_account_name is distinct from historical_transfer.source_account_name
  then
    raise exception 'historical transfer source snapshot is immutable'
      using errcode = '23514', constraint = 'finance_v3_transfer_snapshot_immutable';
  end if;
  if has_existing and destination_unchanged
    and new.destination_account_name is distinct from historical_transfer.destination_account_name
  then
    raise exception 'historical transfer destination snapshot is immutable'
      using errcode = '23514', constraint = 'finance_v3_transfer_snapshot_immutable';
  end if;

  if new.deleted_at is not null then
    if has_existing and (not source_unchanged or not destination_unchanged) then
      raise exception 'historical transfer account snapshots are immutable'
        using errcode = '23514', constraint = 'finance_v3_transfer_snapshot_immutable';
    end if;
    return new;
  end if;

  -- The service-role-only import RPC validates and commits the complete
  -- owner-scoped endpoint manifest and transfer rows in this same database
  -- transaction. Browser roles cannot execute that RPC or activate this
  -- transaction-local context through an ordinary table write. Existing
  -- transfer updates still use the normal historical/retarget rules.
  if not has_existing and historical_import_batch like 'historical-import:%' then
    if current_user <> 'service_role' then
      raise exception 'historical transfer import requires trusted server authorization'
        using errcode = '42501';
    end if;
    select * into source_account
    from public.accounts
    where user_id = new.user_id and id = new.source_account_id;
    if source_account.id is null then
      raise exception 'historical transfer import source account is missing'
        using errcode = '23503';
    end if;
    select * into destination_account
    from public.accounts
    where user_id = new.user_id and id = new.destination_account_id;
    if destination_account.id is null then
      raise exception 'historical transfer import destination account is missing'
        using errcode = '23503';
    end if;
    return new;
  end if;

  if not source_unchanged then
    select * into source_account
    from public.accounts
    where user_id = new.user_id and id = new.source_account_id;
    if source_account.id is null
      or source_account.deleted_at is not null
      or not source_account.is_active
    then
      raise exception 'transfer source account must be active'
        using errcode = '23514', constraint = 'finance_v3_transfer_active_source';
    end if;
    if new.source_account_name is distinct from source_account.name then
      raise exception 'transfer source snapshot name does not match its account'
        using errcode = '23514', constraint = 'finance_v3_transfer_account_snapshot';
    end if;
  end if;

  if not destination_unchanged then
    select * into destination_account
    from public.accounts
    where user_id = new.user_id and id = new.destination_account_id;
    if destination_account.id is null
      or destination_account.deleted_at is not null
      or not destination_account.is_active
    then
      raise exception 'transfer destination account must be active'
        using errcode = '23514', constraint = 'finance_v3_transfer_active_destination';
    end if;
    if new.destination_account_name is distinct from destination_account.name then
      raise exception 'transfer destination snapshot name does not match its account'
        using errcode = '23514', constraint = 'finance_v3_transfer_account_snapshot';
    end if;
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

-- Trusted import/restore transaction for first-class historical transfers.
-- Browser roles cannot execute it. The verified Edge Function derives the
-- owner from the caller's JWT and invokes this function with service_role. The
-- function accepts a full endpoint manifest rather than an import boolean,
-- locks and verifies every persisted account/clock, and applies transfers in
-- the same SQL transaction. Any rejection rolls back all stages.
drop function if exists public.finance_import_historical_transfer_batch(text, jsonb, jsonb, jsonb);
create or replace function public.finance_import_historical_transfer_batch(
  p_owner_id uuid,
  p_batch_id text,
  p_account_operations jsonb,
  p_endpoint_accounts jsonb,
  p_transfer_operations jsonb
)
returns table(entity text, id text, version bigint, last_operation_id text)
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
#variable_conflict use_column
declare
  caller_id uuid := p_owner_id;
  account_payload jsonb;
  transfer_payload jsonb;
  persisted_account public.accounts%rowtype;
  persisted_transfer public.transfers%rowtype;
  endpoint_ids text[] := array[]::text[];
  payload_owner uuid;
  payload_id text;
begin
  if current_user <> 'service_role' or caller_id is null then
    raise exception 'historical transfer import requires trusted server authorization'
      using errcode = '42501';
  end if;
  if p_batch_id is null
    or (p_batch_id not like 'historical-import:guest:%'
      and p_batch_id not like 'historical-import:restore:%')
    or pg_catalog.octet_length(p_batch_id) > 512
  then
    raise exception 'invalid historical transfer import batch id'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_account_operations) <> 'array'
    or pg_catalog.jsonb_typeof(p_endpoint_accounts) <> 'array'
    or pg_catalog.jsonb_typeof(p_transfer_operations) <> 'array'
    or pg_catalog.jsonb_array_length(p_account_operations) > 25000
    or pg_catalog.jsonb_array_length(p_endpoint_accounts) > 50000
    or pg_catalog.jsonb_array_length(p_transfer_operations) > 25000
  then
    raise exception 'invalid historical transfer import manifest'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_transfer_operations) = 0 then
    raise exception 'historical transfer import requires at least one transfer'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('finance-historical-import:' || caller_id::text, 0)
  );

  for account_payload in
    select value from pg_catalog.jsonb_array_elements(p_account_operations)
  loop
    payload_owner := (account_payload ->> 'user_id')::uuid;
    payload_id := account_payload ->> 'id';
    if payload_owner is distinct from caller_id or payload_id is null then
      raise exception 'historical transfer import account owner mismatch'
        using errcode = '42501';
    end if;

    insert into public.accounts (
      user_id, id, name, icon_type, icon_value, opening_balance,
      include_in_total_assets, is_active, sort_order, legacy_key,
      requires_review, version, updated_at, last_operation_id, deleted_at
    ) values (
      payload_owner,
      payload_id,
      account_payload ->> 'name',
      account_payload ->> 'icon_type',
      account_payload ->> 'icon_value',
      (account_payload ->> 'opening_balance')::numeric,
      (account_payload ->> 'include_in_total_assets')::boolean,
      (account_payload ->> 'is_active')::boolean,
      (account_payload ->> 'sort_order')::integer,
      account_payload ->> 'legacy_key',
      coalesce((account_payload ->> 'requires_review')::boolean, false),
      (account_payload ->> 'version')::bigint,
      (account_payload ->> 'updated_at')::timestamptz,
      account_payload ->> 'last_operation_id',
      (account_payload ->> 'deleted_at')::timestamptz
    )
    on conflict (user_id, id) do update set
      name = excluded.name,
      icon_type = excluded.icon_type,
      icon_value = excluded.icon_value,
      opening_balance = excluded.opening_balance,
      include_in_total_assets = excluded.include_in_total_assets,
      is_active = excluded.is_active,
      sort_order = excluded.sort_order,
      legacy_key = excluded.legacy_key,
      requires_review = excluded.requires_review,
      version = excluded.version,
      updated_at = excluded.updated_at,
      last_operation_id = excluded.last_operation_id,
      deleted_at = excluded.deleted_at;

    select * into persisted_account
    from public.accounts
    where user_id = caller_id and public.accounts.id = payload_id;
    if persisted_account.id is null
      or persisted_account.name is distinct from account_payload ->> 'name'
      or persisted_account.icon_type is distinct from account_payload ->> 'icon_type'
      or persisted_account.icon_value is distinct from account_payload ->> 'icon_value'
      or persisted_account.opening_balance is distinct from (account_payload ->> 'opening_balance')::numeric
      or persisted_account.include_in_total_assets is distinct from (account_payload ->> 'include_in_total_assets')::boolean
      or persisted_account.is_active is distinct from (account_payload ->> 'is_active')::boolean
      or persisted_account.sort_order is distinct from (account_payload ->> 'sort_order')::integer
      or persisted_account.legacy_key is distinct from account_payload ->> 'legacy_key'
      or persisted_account.requires_review is distinct from coalesce((account_payload ->> 'requires_review')::boolean, false)
      or persisted_account.version is distinct from (account_payload ->> 'version')::bigint
      or persisted_account.updated_at is distinct from (account_payload ->> 'updated_at')::timestamptz
      or persisted_account.last_operation_id is distinct from account_payload ->> 'last_operation_id'
      or persisted_account.deleted_at is distinct from (account_payload ->> 'deleted_at')::timestamptz
    then
      raise exception 'historical transfer import account conflict clock mismatch'
        using errcode = '40001';
    end if;
    return query select 'accounts'::text, persisted_account.id,
      persisted_account.version, persisted_account.last_operation_id;
  end loop;

  for account_payload in
    select value from pg_catalog.jsonb_array_elements(p_endpoint_accounts)
  loop
    payload_owner := (account_payload ->> 'user_id')::uuid;
    payload_id := account_payload ->> 'id';
    if payload_owner is distinct from caller_id or payload_id is null then
      raise exception 'historical transfer import endpoint owner mismatch'
        using errcode = '42501';
    end if;
    if payload_id = any(endpoint_ids) then
      raise exception 'historical transfer import contains duplicate endpoint manifests'
        using errcode = '22023';
    end if;
    endpoint_ids := pg_catalog.array_append(endpoint_ids, payload_id);
  end loop;

  -- Lock every endpoint in one deterministic order and retain those locks
  -- until the transfer stage commits. Concurrent ordinary account writes must
  -- therefore finish before manifest validation or wait until this batch ends.
  perform 1
  from public.accounts
  where user_id = caller_id and public.accounts.id = any(endpoint_ids)
  order by public.accounts.id
  for update;

  for account_payload in
    select value from pg_catalog.jsonb_array_elements(p_endpoint_accounts)
  loop
    payload_id := account_payload ->> 'id';
    select * into persisted_account
    from public.accounts
    where user_id = caller_id and public.accounts.id = payload_id;
    if persisted_account.id is null
      or persisted_account.name is distinct from account_payload ->> 'name'
      or persisted_account.icon_type is distinct from account_payload ->> 'icon_type'
      or persisted_account.icon_value is distinct from account_payload ->> 'icon_value'
      or persisted_account.opening_balance is distinct from (account_payload ->> 'opening_balance')::numeric
      or persisted_account.include_in_total_assets is distinct from (account_payload ->> 'include_in_total_assets')::boolean
      or persisted_account.is_active is distinct from (account_payload ->> 'is_active')::boolean
      or persisted_account.sort_order is distinct from (account_payload ->> 'sort_order')::integer
      or persisted_account.legacy_key is distinct from account_payload ->> 'legacy_key'
      or persisted_account.requires_review is distinct from coalesce((account_payload ->> 'requires_review')::boolean, false)
      or persisted_account.version is distinct from (account_payload ->> 'version')::bigint
      or persisted_account.updated_at is distinct from (account_payload ->> 'updated_at')::timestamptz
      or persisted_account.last_operation_id is distinct from account_payload ->> 'last_operation_id'
      or persisted_account.deleted_at is distinct from (account_payload ->> 'deleted_at')::timestamptz
    then
      raise exception 'historical transfer import endpoint manifest does not match cloud account'
        using errcode = '40001';
    end if;
  end loop;

  perform pg_catalog.set_config(
    'finance_private.historical_transfer_import',
    p_batch_id,
    true
  );
  for transfer_payload in
    select value from pg_catalog.jsonb_array_elements(p_transfer_operations)
  loop
    payload_owner := (transfer_payload ->> 'user_id')::uuid;
    payload_id := transfer_payload ->> 'id';
    if payload_owner is distinct from caller_id or payload_id is null then
      raise exception 'historical transfer import transfer owner mismatch'
        using errcode = '42501';
    end if;
    if not ((transfer_payload ->> 'source_account_id') = any(endpoint_ids))
      or not ((transfer_payload ->> 'destination_account_id') = any(endpoint_ids))
    then
      raise exception 'historical transfer import endpoint manifest is incomplete'
        using errcode = '22023';
    end if;

    insert into public.transfers (
      user_id, id, amount, source_account_id, source_account_name,
      destination_account_id, destination_account_name, occurred_at, note,
      version, updated_at, last_operation_id, deleted_at
    ) values (
      payload_owner,
      payload_id,
      (transfer_payload ->> 'amount')::numeric,
      transfer_payload ->> 'source_account_id',
      transfer_payload ->> 'source_account_name',
      transfer_payload ->> 'destination_account_id',
      transfer_payload ->> 'destination_account_name',
      transfer_payload ->> 'occurred_at',
      transfer_payload ->> 'note',
      (transfer_payload ->> 'version')::bigint,
      (transfer_payload ->> 'updated_at')::timestamptz,
      transfer_payload ->> 'last_operation_id',
      (transfer_payload ->> 'deleted_at')::timestamptz
    )
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
      last_operation_id = excluded.last_operation_id,
      deleted_at = excluded.deleted_at;

    select * into persisted_transfer
    from public.transfers
    where user_id = caller_id and public.transfers.id = payload_id;
    if persisted_transfer.id is null
      or persisted_transfer.amount is distinct from (transfer_payload ->> 'amount')::numeric
      or persisted_transfer.source_account_id is distinct from transfer_payload ->> 'source_account_id'
      or persisted_transfer.source_account_name is distinct from transfer_payload ->> 'source_account_name'
      or persisted_transfer.destination_account_id is distinct from transfer_payload ->> 'destination_account_id'
      or persisted_transfer.destination_account_name is distinct from transfer_payload ->> 'destination_account_name'
      or persisted_transfer.occurred_at is distinct from transfer_payload ->> 'occurred_at'
      or persisted_transfer.note is distinct from transfer_payload ->> 'note'
      or persisted_transfer.version is distinct from (transfer_payload ->> 'version')::bigint
      or persisted_transfer.updated_at is distinct from (transfer_payload ->> 'updated_at')::timestamptz
      or persisted_transfer.last_operation_id is distinct from transfer_payload ->> 'last_operation_id'
      or persisted_transfer.deleted_at is distinct from (transfer_payload ->> 'deleted_at')::timestamptz
    then
      raise exception 'historical transfer import transfer conflict clock mismatch'
        using errcode = '40001';
    end if;
    return query select 'transfers'::text, persisted_transfer.id,
      persisted_transfer.version, persisted_transfer.last_operation_id;
  end loop;
  perform pg_catalog.set_config('finance_private.historical_transfer_import', '', true);
end
$function$;

revoke all on function public.finance_import_historical_transfer_batch(uuid, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.finance_import_historical_transfer_batch(uuid, text, jsonb, jsonb, jsonb)
  to service_role;

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
