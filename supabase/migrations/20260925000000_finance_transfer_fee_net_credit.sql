-- Keep existing fee transfers under their original source-extra rule.
-- New transfers can store the destination-net rule without rewriting history.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';
alter table public.transfers add column if not exists fee_mode text;
alter table public.transfers drop constraint if exists finance_v3_transfers_fee_mode_chk;
alter table public.transfers add constraint finance_v3_transfers_fee_mode_chk check (
  fee_mode is null or fee_mode in ('source-extra', 'destination-net')
);
alter table public.transfers drop constraint if exists finance_v3_transfers_net_fee_chk;
alter table public.transfers add constraint finance_v3_transfers_net_fee_chk check (
  fee_mode is distinct from 'destination-net'
  or pg_catalog.round(fee * 100, 0) < pg_catalog.round(amount * 100, 0)
);

create or replace function finance_private.preserve_omitted_transfer_fee_mode()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if new.fee_mode is null then
    if tg_op = 'UPDATE' then
      new.fee_mode := old.fee_mode;
    else
      select fee_mode into new.fee_mode from public.transfers
      where user_id = new.user_id and id = new.id
      for update;
    end if;
  end if;
  return new;
end
$function$;
revoke all on function finance_private.preserve_omitted_transfer_fee_mode()
  from public, anon, authenticated;
drop trigger if exists finance_v3_06_transfer_fee_mode on public.transfers;
create trigger finance_v3_06_transfer_fee_mode before insert or update on public.transfers
for each row execute function finance_private.preserve_omitted_transfer_fee_mode();
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
      user_id, id, amount, fee, fee_mode, source_account_id, source_account_name,
      destination_account_id, destination_account_name, occurred_at, note,
      version, updated_at, last_operation_id, deleted_at
    ) values (
      payload_owner,
      payload_id,
      (transfer_payload ->> 'amount')::numeric,
      (transfer_payload ->> 'fee')::numeric,
      transfer_payload ->> 'fee_mode',
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
      fee = excluded.fee,
      fee_mode = excluded.fee_mode,
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
      or ((transfer_payload ->> 'fee') is not null
        and persisted_transfer.fee is distinct from (transfer_payload ->> 'fee')::numeric)
      or ((transfer_payload ->> 'fee_mode') is not null
        and persisted_transfer.fee_mode is distinct from transfer_payload ->> 'fee_mode')
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
      ) then -pg_catalog.round(transfer.amount * 100, 0)
        - case when transfer.fee_mode = 'destination-net' then 0
          else pg_catalog.round(transfer.fee * 100, 0) end else 0 end
      + case when exists (
        select 1 from public.accounts as destination_account
        where destination_account.user_id = transfer.user_id
          and destination_account.id = transfer.destination_account_id
          and destination_account.deleted_at is null and destination_account.is_active
          and destination_account.include_in_total_assets
      ) then pg_catalog.round(transfer.amount * 100, 0)
        - case when transfer.fee_mode = 'destination-net'
          then pg_catalog.round(transfer.fee * 100, 0) else 0 end else 0 end
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

commit;
