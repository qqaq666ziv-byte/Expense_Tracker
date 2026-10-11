-- Additive, opt-in shortcut intake. No existing financial row is changed.
-- Scoped bearer credentials can only submit; only a signed-in owner can review.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';

create table if not exists public.finance_shortcut_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 64 and octet_length(label) <= 256),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  mode text not null default 'review' check (mode in ('review', 'auto')),
  account_id text,
  category_id text,
  verified_at timestamptz,
  verified_format text check (verified_format = 'jkopay-single-debit-v1'),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id),
  foreign key (user_id, category_id) references public.categories(user_id, id),
  check (mode <> 'auto' or (verified_at is not null and verified_format is not null and account_id is not null and category_id is not null))
);

create table if not exists public.finance_shortcut_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  event_key text not null check (octet_length(event_key) <= 80),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192),
  amount numeric check (amount > 0 and amount <= 100000000 and amount = round(amount, 2)),
  merchant text check (char_length(merchant) <= 160 and octet_length(merchant) <= 640),
  occurred_at timestamptz check (occurred_at >= '2000-01-01' and occurred_at < '2101-01-01'),
  status text not null default 'pending' check (status in ('pending', 'imported', 'ignored', 'test')),
  transaction_id text,
  reason text not null check (octet_length(reason) <= 100),
  parser_format text check (parser_format = 'jkopay-single-debit-v1'),
  auto_eligible boolean not null default false,
  duplicate_event boolean not null default false,
  ambiguous_of uuid references public.finance_shortcut_inbox(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, connection_id, event_key),
  foreign key (user_id, connection_id) references public.finance_shortcut_connections(user_id, id),
  check ((status = 'imported') = (transaction_id is not null)),
  check (not auto_eligible or parser_format is not null)
);

-- Keep compact replay keys after aging out reviewed inbox payloads. This table
-- is private and has no Data API grants; rows are never pruned automatically.
create table if not exists finance_private.shortcut_inbox_receipts (
  inbox_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  event_key text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  original_status text not null check (original_status in ('imported', 'ignored', 'test')),
  archived_at timestamptz not null default clock_timestamp(),
  primary key (user_id, connection_id, event_key),
  foreign key (user_id, connection_id) references public.finance_shortcut_connections(user_id, id)
);

create index if not exists finance_shortcut_connections_owner_idx on public.finance_shortcut_connections(user_id, created_at desc);
-- The only supported source is jkopay. Extend this key with source if another
-- provider is introduced; each owner currently has at most one live auto feed.
create unique index if not exists finance_shortcut_one_active_auto_idx
  on public.finance_shortcut_connections(user_id) where mode = 'auto' and revoked_at is null;
create index if not exists finance_shortcut_inbox_owner_idx on public.finance_shortcut_inbox(user_id, created_at desc);
create index if not exists finance_shortcut_inbox_fingerprint_idx on public.finance_shortcut_inbox(user_id, fingerprint);
create index if not exists finance_shortcut_inbox_owner_event_idx on public.finance_shortcut_inbox(user_id, event_key);
create index if not exists finance_shortcut_inbox_capacity_idx
  on public.finance_shortcut_inbox(user_id, created_at, id)
  where status in ('imported', 'ignored', 'test');

-- Bounded counters avoid scanning historical financial rows on each request.
create table if not exists finance_private.shortcut_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  minute_start timestamptz not null,
  minute_count integer not null,
  day_start timestamptz not null,
  day_count integer not null
);
alter table public.finance_shortcut_connections enable row level security;
alter table public.finance_shortcut_inbox enable row level security;
alter table finance_private.shortcut_rate_limits enable row level security;
revoke all on public.finance_shortcut_connections, public.finance_shortcut_inbox,
  finance_private.shortcut_rate_limits from public, anon, authenticated, service_role;
revoke all on finance_private.shortcut_inbox_receipts from public, anon, authenticated, service_role;
-- No direct Data API grants: list RPCs are bounded and never expose token_hash.
drop policy if exists shortcut_owner_select on public.finance_shortcut_connections;
create policy shortcut_owner_select on public.finance_shortcut_connections for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists shortcut_owner_select on public.finance_shortcut_inbox;
create policy shortcut_owner_select on public.finance_shortcut_inbox for select to authenticated using ((select auth.uid()) = user_id);

create or replace function finance_private.shortcut_connection_json(p_row public.finance_shortcut_connections)
returns jsonb language sql immutable security invoker set search_path = ''
as $$ select pg_catalog.to_jsonb(p_row) - 'token_hash' - 'user_id' $$;

create or replace function finance_private.shortcut_list_connections()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare owner_id uuid := auth.uid(); result jsonb;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(finance_private.shortcut_connection_json(c) order by c.created_at desc), '[]'::jsonb)
  into result from public.finance_shortcut_connections c where c.user_id = owner_id;
  return result;
end $$;

create or replace function finance_private.shortcut_create(p_label text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare owner_id uuid := auth.uid(); created public.finance_shortcut_connections;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_label is null or char_length(btrim(p_label)) not between 1 and 64 or octet_length(p_label) > 256
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
  then raise exception 'invalid_connection' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance-shortcut:' || owner_id::text, 0));
  if (select count(*) from public.finance_shortcut_connections where user_id = owner_id and revoked_at is null) >= 5
    or (select count(*) from public.finance_shortcut_connections where user_id = owner_id) >= 100
  then raise exception 'connection_limit' using errcode = '54000'; end if;
  insert into public.finance_shortcut_connections(user_id, label, token_hash)
  values (owner_id, btrim(p_label), p_token_hash) returning * into created;
  return finance_private.shortcut_connection_json(created);
end $$;

create or replace function finance_private.shortcut_revoke(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare owner_id uuid := auth.uid();
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance-shortcut:' || owner_id::text, 0));
  update public.finance_shortcut_connections set revoked_at = coalesce(revoked_at, clock_timestamp()), mode = 'review'
  where user_id = owner_id and id = p_id;
  if not found then raise exception 'connection_not_found' using errcode = '42501'; end if;
end $$;

-- Remove the prior four-argument signature so it cannot bypass explicit owner
-- confirmation. Omitted fifth arguments resolve to the fail-closed default.
drop function if exists public.finance_shortcut_configure(uuid, text, text, text);
drop function if exists finance_private.shortcut_configure(uuid, text, text, text);
create or replace function finance_private.shortcut_configure(p_id uuid, p_account_id text, p_category_id text, p_mode text,
  p_stable_event_id_confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare owner_id uuid := auth.uid(); connection public.finance_shortcut_connections;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('review', 'auto') then raise exception 'invalid_mode' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance-shortcut:' || owner_id::text, 0));
  select * into connection from public.finance_shortcut_connections where user_id = owner_id and id = p_id for update;
  if not found or connection.revoked_at is not null then raise exception 'connection_not_found' using errcode = '42501'; end if;
  if p_account_id is not null then
    perform 1 from public.accounts where user_id = owner_id and id = p_account_id and is_active and deleted_at is null and not requires_review for share;
    if not found then raise exception 'active_account_required' using errcode = '23514'; end if;
  end if;
  if p_category_id is not null then
    perform 1 from public.categories where user_id = owner_id and id = p_category_id and kind = 'expense' and is_active and deleted_at is null for share;
    if not found then raise exception 'active_expense_category_required' using errcode = '23514'; end if;
  end if;
  if p_mode = 'auto' and (connection.verified_at is null or connection.verified_format is null or p_account_id is null or p_category_id is null)
  then raise exception 'verified_notification_required' using errcode = '23514'; end if;
  if p_mode = 'auto' and p_stable_event_id_confirmed is distinct from true
  then raise exception 'stable_event_id_confirmation_required' using errcode = '23514'; end if;
  if p_mode = 'auto' and exists (
    select 1 from public.finance_shortcut_connections
    where user_id = owner_id and id <> p_id and mode = 'auto' and revoked_at is null
  ) then raise exception 'active_auto_connection_exists' using errcode = '23514'; end if;
  update public.finance_shortcut_connections set mode = p_mode, account_id = p_account_id, category_id = p_category_id
  where id = p_id returning * into connection;
  return finance_private.shortcut_connection_json(connection);
end $$;

create or replace function finance_private.shortcut_list_inbox()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare owner_id uuid := auth.uid(); result jsonb;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(i) - 'user_id' - 'fingerprint' - 'event_key' order by i.created_at desc, i.id desc), '[]'::jsonb)
  into result from (
    select * from public.finance_shortcut_inbox where user_id = owner_id
    order by created_at desc, id desc limit 100
  ) i;
  return result;
end $$;

-- Internal atomic post. The caller holds the owner + connection + inbox locks.
-- FOR SHARE holds canonical parent snapshots against concurrent archive/rename.
create or replace function finance_private.shortcut_post(p_inbox_id uuid, p_account_id text, p_category_id text,
  p_amount numeric, p_merchant text, p_occurred_at timestamptz)
returns text language plpgsql security definer set search_path = ''
as $$
declare item public.finance_shortcut_inbox; account_row public.accounts; category_row public.categories;
  posted_id text; canonical_time text;
begin
  select * into item from public.finance_shortcut_inbox where id = p_inbox_id for update;
  if not found or item.status <> 'pending' then raise exception 'pending_notification_required' using errcode = '23514'; end if;
  if p_amount is null or not (p_amount > 0 and p_amount <= 100000000 and p_amount = round(p_amount, 2))
    or p_occurred_at is null or not isfinite(p_occurred_at) or p_occurred_at < '2000-01-01' or p_occurred_at >= '2101-01-01'
    or p_occurred_at > clock_timestamp() + interval '1 day'
    or p_merchant is null or char_length(btrim(p_merchant)) not between 1 and 160 or octet_length(p_merchant) > 640
  then raise exception 'valid_expense_fields_required' using errcode = '22023'; end if;
  select * into account_row from public.accounts where user_id = item.user_id and id = p_account_id for share;
  if not found or not account_row.is_active or account_row.deleted_at is not null or account_row.requires_review
  then raise exception 'active_account_required' using errcode = '23514'; end if;
  select * into category_row from public.categories where user_id = item.user_id and id = p_category_id for share;
  if not found or not category_row.is_active or category_row.deleted_at is not null or category_row.kind <> 'expense'
  then raise exception 'active_expense_category_required' using errcode = '23514'; end if;
  posted_id := 'shortcut-' || item.id::text;
  canonical_time := to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- Never UPSERT or resurrect an existing/tombstoned financial record.
  if exists (select 1 from public.transactions where user_id = item.user_id and id = posted_id)
  then raise exception 'transaction_identity_conflict' using errcode = '23505'; end if;
  insert into public.transactions(id, user_id, amount, type, category_id, category_name, category,
    account_id, account_name, account, note, icon, occurred_at, date, version, updated_at, last_operation_id)
  values (posted_id, item.user_id, p_amount, 'expense', category_row.id, category_row.name, category_row.name,
    account_row.id, account_row.name, account_row.name, btrim(p_merchant) || ' · 街口捷徑', category_row.icon_value,
    canonical_time, canonical_time, 1, clock_timestamp(), 'shortcut-import-' || item.id::text);
  update public.finance_shortcut_inbox set status = 'imported', transaction_id = posted_id,
    amount = p_amount, merchant = btrim(p_merchant), occurred_at = p_occurred_at, reason = 'imported'
  where id = item.id;
  return posted_id;
end $$;

create or replace function finance_private.shortcut_review(p_id uuid, p_action text,
  p_account_id text default null, p_category_id text default null, p_amount numeric default null,
  p_merchant text default null, p_occurred_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare owner_id uuid := auth.uid(); item public.finance_shortcut_inbox;
  connection public.finance_shortcut_connections; posted_id text; chosen_amount numeric; chosen_merchant text; chosen_time timestamptz;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('approve', 'ignore') then raise exception 'invalid_action' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance-shortcut:' || owner_id::text, 0));
  select * into item from public.finance_shortcut_inbox where user_id = owner_id and id = p_id;
  if not found then raise exception 'notification_not_found' using errcode = '42501'; end if;
  select * into connection from public.finance_shortcut_connections where user_id = owner_id and id = item.connection_id for update;
  select * into item from public.finance_shortcut_inbox where user_id = owner_id and id = p_id for update;
  -- Exact review retries report the prior outcome, even after a finance tombstone.
  if item.status = 'imported' and p_action = 'approve' or item.status = 'ignored' and p_action = 'ignore' then
    return jsonb_build_object('status', item.status, 'transaction_id', item.transaction_id);
  end if;
  if item.status <> 'pending' then raise exception 'pending_notification_required' using errcode = '23514'; end if;
  if p_action = 'ignore' then
    update public.finance_shortcut_inbox set status = 'ignored', reason = 'ignored_by_owner' where id = item.id;
    return jsonb_build_object('status', 'ignored', 'transaction_id', null);
  end if;
  chosen_amount := coalesce(p_amount, item.amount);
  chosen_merchant := coalesce(p_merchant, item.merchant);
  chosen_time := coalesce(p_occurred_at, item.occurred_at);
  posted_id := finance_private.shortcut_post(item.id, coalesce(p_account_id, connection.account_id),
    coalesce(p_category_id, connection.category_id), chosen_amount, chosen_merchant, chosen_time);
  -- Manual corrections do not prove that the parser understood the notification.
  -- Tests, duplicates and revoked connections can never enable auto mode.
  if item.auto_eligible and not item.duplicate_event
    and item.parser_format = 'jkopay-single-debit-v1' and item.ambiguous_of is null
    and item.event_key like 'id:%'
    and connection.revoked_at is null and item.payload ->> 'test' = 'false'
    and chosen_amount = item.amount and btrim(chosen_merchant) = item.merchant and chosen_time = item.occurred_at
  then
    update public.finance_shortcut_connections set verified_at = clock_timestamp(), verified_format = item.parser_format
    where id = connection.id;
  end if;
  return jsonb_build_object('status', 'imported', 'transaction_id', posted_id);
end $$;

create or replace function finance_private.shortcut_authenticate(p_token_hash text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.finance_shortcut_connections where token_hash = p_token_hash and revoked_at is null) $$;

create or replace function finance_private.shortcut_receive(p_token_hash text, p_event_key text, p_fingerprint text,
  p_payload jsonb, p_amount numeric, p_merchant text, p_occurred_at timestamptz,
  p_format text, p_auto_eligible boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare owner_id uuid; connection public.finance_shortcut_connections; previous public.finance_shortcut_inbox;
  created public.finance_shortcut_inbox; rate finance_private.shortcut_rate_limits;
  received_time timestamptz := clock_timestamp(); key_to_insert text := p_event_key;
  receipt finance_private.shortcut_inbox_receipts; duplicate_id uuid; is_test boolean;
  is_duplicate boolean := false; cross_connection boolean := false; posted_id text; archived_count integer;
begin
  select user_id into owner_id from public.finance_shortcut_connections where token_hash = p_token_hash and revoked_at is null;
  if not found then raise exception 'invalid_shortcut_token' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance-shortcut:' || owner_id::text, 0));
  select * into connection from public.finance_shortcut_connections where token_hash = p_token_hash and revoked_at is null for update;
  if not found then raise exception 'invalid_shortcut_token' using errcode = '42501'; end if;
  if p_event_key is null or p_event_key !~ '^(id|fp):[0-9a-f]{64}$' or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 8192
    or p_payload ->> 'source' is distinct from 'jkopay' or p_payload ->> 'version' is distinct from '1'
    or jsonb_typeof(p_payload -> 'test') is distinct from 'boolean'
    or jsonb_typeof(p_payload -> 'title') is distinct from 'string' or jsonb_typeof(p_payload -> 'text') is distinct from 'string'
    or octet_length(p_payload ->> 'title') > 1024 or octet_length(p_payload ->> 'text') > 6000
    or p_reason is null or octet_length(p_reason) > 100 or p_auto_eligible is null
    or (p_auto_eligible and (p_format is distinct from 'jkopay-single-debit-v1' or p_amount is null or p_merchant is null or p_occurred_at is null))
  then raise exception 'invalid_shortcut_payload' using errcode = '22023'; end if;
  is_test := (p_payload ->> 'test')::boolean;
  -- Count requests, including replays; every connection for one owner shares quota.
  insert into finance_private.shortcut_rate_limits(user_id, minute_start, minute_count, day_start, day_count)
  values(owner_id, date_trunc('minute', received_time), 1, date_trunc('day', received_time at time zone 'UTC') at time zone 'UTC', 1)
  on conflict (user_id) do update set
    minute_start = excluded.minute_start,
    minute_count = case when shortcut_rate_limits.minute_start = excluded.minute_start then shortcut_rate_limits.minute_count + 1 else 1 end,
    day_start = excluded.day_start,
    day_count = case when shortcut_rate_limits.day_start = excluded.day_start then shortcut_rate_limits.day_count + 1 else 1 end
  returning * into rate;
  if rate.minute_count > 30 or rate.day_count > 300 then raise exception 'shortcut_rate_limit' using errcode = '53300'; end if;

  if p_event_key like 'id:%' then
    select * into previous from public.finance_shortcut_inbox where user_id = owner_id and connection_id = connection.id and event_key = p_event_key;
    if found then
      if previous.fingerprint <> p_fingerprint then raise exception 'event_id_payload_conflict' using errcode = '23505'; end if;
      return jsonb_build_object('status', previous.status, 'id', previous.id, 'duplicate', true);
    end if;
    select * into receipt from finance_private.shortcut_inbox_receipts
    where user_id = owner_id and connection_id = connection.id and event_key = p_event_key;
    if found then
      if receipt.fingerprint <> p_fingerprint then raise exception 'event_id_payload_conflict' using errcode = '23505'; end if;
      return jsonb_build_object('status', receipt.original_status, 'id', receipt.inbox_id, 'duplicate', true, 'archived', true);
    end if;
    -- A source/device ID may collide across connections. Keep the new proposal
    -- for manual comparison even when the payload differs; do not silently drop
    -- a different purchase or auto-post an old event after switching feeds.
    select id into duplicate_id from public.finance_shortcut_inbox
    where user_id = owner_id and connection_id <> connection.id and event_key = p_event_key
    order by created_at, id limit 1;
    if found then is_duplicate := true; cross_connection := true;
    else
      select null::uuid into duplicate_id from finance_private.shortcut_inbox_receipts
      where user_id = owner_id and connection_id <> connection.id and event_key = p_event_key
      limit 1;
      if found then is_duplicate := true; cross_connection := true; end if;
    end if;
  else
    -- A content hash cannot distinguish a retry from two identical purchases.
    -- Preserve the additional arrival for explicit review instead of losing it.
    select id into duplicate_id from public.finance_shortcut_inbox
    where user_id = owner_id and connection_id = connection.id and fingerprint = p_fingerprint order by created_at, id limit 1;
    if found then
      is_duplicate := true; key_to_insert := 'amb:' || gen_random_uuid()::text;
    end if;
  end if;
  if (select count(*) from public.finance_shortcut_inbox where user_id = owner_id) >= 10000
  then
    -- Only terminal, already reviewed rows can leave the active inbox. Their
    -- payloads are replaced by a compact replay receipt in the same transaction.
    -- Pending items are never removed and no receipt is ever pruned.
    with eligible as materialized (
      select id, user_id, connection_id, event_key, fingerprint, status
      from public.finance_shortcut_inbox
      where user_id = owner_id and status in ('imported', 'ignored', 'test')
        and id is distinct from duplicate_id
        and not exists (
          select 1 from public.finance_shortcut_inbox reference_row
          where reference_row.ambiguous_of = finance_shortcut_inbox.id
        )
        and (event_key like 'id:%' or not exists (
          select 1 from public.finance_shortcut_inbox other
          where other.user_id = owner_id and other.id <> finance_shortcut_inbox.id
            and other.fingerprint = finance_shortcut_inbox.fingerprint
        ))
      order by created_at, id
      limit 1
      for update skip locked
    ), retained as (
      insert into finance_private.shortcut_inbox_receipts
        (inbox_id, user_id, connection_id, event_key, fingerprint, original_status)
      select id, user_id, connection_id, event_key, fingerprint, status from eligible
      on conflict (user_id, connection_id, event_key) do update
        set inbox_id = excluded.inbox_id, fingerprint = excluded.fingerprint, original_status = excluded.original_status,
            archived_at = clock_timestamp()
      returning user_id, connection_id, event_key
    ), removed as (
      delete from public.finance_shortcut_inbox i using retained r
      where i.user_id = r.user_id and i.connection_id = r.connection_id and i.event_key = r.event_key
      returning 1
    ) select count(*)::integer into archived_count from removed;
    if archived_count <> 1 then raise exception 'shortcut_inbox_limit' using errcode = '54000'; end if;
  end if;
  insert into public.finance_shortcut_inbox(user_id, connection_id, event_key, fingerprint, payload,
    amount, merchant, occurred_at, status, reason, parser_format, auto_eligible, duplicate_event, ambiguous_of)
  values(owner_id, connection.id, key_to_insert, p_fingerprint, p_payload,
    p_amount, p_merchant, p_occurred_at, case when is_test then 'test' else 'pending' end,
    case when is_test then 'test_only' when cross_connection then 'cross_connection_duplicate'
      when is_duplicate then 'possible_duplicate'
      when p_event_key like 'fp:%' and p_auto_eligible then 'missing_event_id' else p_reason end,
    p_format, p_auto_eligible, is_duplicate, duplicate_id)
  returning * into created;

  if connection.mode = 'auto' and connection.verified_at is not null and connection.verified_format = p_format
    and p_event_key like 'id:%' and p_auto_eligible and not is_test and not is_duplicate
  then
    begin
      posted_id := finance_private.shortcut_post(created.id, connection.account_id, connection.category_id, p_amount, p_merchant, p_occurred_at);
      created.status := 'imported';
    exception when check_violation or invalid_parameter_value or program_limit_exceeded or unique_violation then
      -- Finance insert and sync revision are rolled back together by this block.
      -- Retain the raw event for owner review; never silently retarget parents.
      update public.finance_shortcut_inbox set reason = 'auto_requires_review' where id = created.id;
      update public.finance_shortcut_connections set mode = 'review' where id = connection.id;
    end;
  end if;
  return jsonb_build_object('status', created.status, 'id', created.id, 'duplicate', is_duplicate);
end $$;

-- Definer implementations live outside exposed schemas. Thin invoker wrappers
-- expose only the intended contract and cannot accept a caller-selected owner.
create or replace function public.finance_shortcut_list_connections() returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_list_connections() $$;
create or replace function public.finance_shortcut_create(p_label text, p_token_hash text) returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_create(p_label, p_token_hash) $$;
create or replace function public.finance_shortcut_revoke(p_id uuid) returns void language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_revoke(p_id) $$;
create or replace function public.finance_shortcut_configure(p_id uuid, p_account_id text, p_category_id text, p_mode text,
  p_stable_event_id_confirmed boolean default false) returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_configure(p_id, p_account_id, p_category_id, p_mode, p_stable_event_id_confirmed) $$;
create or replace function public.finance_shortcut_list_inbox() returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_list_inbox() $$;
create or replace function public.finance_shortcut_review(p_id uuid, p_action text, p_account_id text default null,
  p_category_id text default null, p_amount numeric default null, p_merchant text default null, p_occurred_at timestamptz default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_review(p_id, p_action, p_account_id, p_category_id, p_amount, p_merchant, p_occurred_at) $$;
create or replace function public.finance_shortcut_authenticate(p_token_hash text) returns boolean language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_authenticate(p_token_hash) $$;
create or replace function public.finance_shortcut_receive(p_token_hash text, p_event_key text, p_fingerprint text,
  p_payload jsonb, p_amount numeric, p_merchant text, p_occurred_at timestamptz,
  p_format text, p_auto_eligible boolean, p_reason text) returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_receive(p_token_hash, p_event_key, p_fingerprint, p_payload, p_amount, p_merchant, p_occurred_at, p_format, p_auto_eligible, p_reason) $$;

-- Explicit grants also override a project's legacy automatic default grants.
do $grants$
declare fn record; intended_role text;
begin
  for fn in select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'finance_private' and p.proname like 'shortcut_%')
       or (n.nspname = 'public' and p.proname like 'finance_shortcut_%')
  loop
    execute format('revoke all on function %I.%I(%s) from public, anon, authenticated, service_role', fn.nspname, fn.proname, fn.args);
    intended_role := case
      when fn.proname in ('shortcut_authenticate', 'shortcut_receive', 'finance_shortcut_authenticate', 'finance_shortcut_receive') then 'service_role'
      when fn.proname in ('shortcut_connection_json', 'shortcut_post') then null
      else 'authenticated' end;
    if intended_role is not null then execute format('grant execute on function %I.%I(%s) to %I', fn.nspname, fn.proname, fn.args, intended_role); end if;
  end loop;
end $grants$;
comment on table public.finance_shortcut_connections is 'Revocable write-only shortcut credentials; hashes are accessible only to private definer functions.';
comment on table public.finance_shortcut_inbox is 'Notification proposals, not authenticated payment-provider receipts. Tests and ambiguous messages cannot automatically affect finances.';
commit;
