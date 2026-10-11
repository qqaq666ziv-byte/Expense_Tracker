-- Add owner-scoped pending keyset paging and commit quota for rejected authenticated events.
-- Existing inbox rows and dedupe receipts are retained; no financial data is deleted or rewritten.
begin;
create index if not exists finance_shortcut_inbox_pending_idx
  on public.finance_shortcut_inbox(user_id, created_at, id) where status = 'pending';
-- Pending work is paged oldest-first so new traffic cannot hide unresolved items.
create or replace function finance_private.shortcut_list_pending(p_before_created_at timestamptz default null,
  p_before_id uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare owner_id uuid := auth.uid(); bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  items jsonb; pending_count bigint; has_more boolean; next_created_at timestamptz; next_id uuid;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if (p_before_created_at is null) <> (p_before_id is null) then raise exception 'invalid_pending_cursor' using errcode = '22023'; end if;
  select count(*) into pending_count from public.finance_shortcut_inbox where user_id = owner_id and status = 'pending';
  with page as materialized (
    select i.* from public.finance_shortcut_inbox i
    where i.user_id = owner_id and i.status = 'pending'
      and (p_before_created_at is null or (i.created_at, i.id) > (p_before_created_at, p_before_id))
    order by i.created_at asc, i.id asc limit bounded_limit + 1
  )
  select coalesce(jsonb_agg(to_jsonb(q) - 'user_id' - 'fingerprint' - 'event_key' order by q.created_at, q.id), '[]'::jsonb),
    coalesce(bool_or(more.has_more), false)
  into items, has_more from (select * from page limit bounded_limit) q
  cross join (select count(*) > bounded_limit as has_more from page) more;
  if has_more then
    select created_at, id into next_created_at, next_id from public.finance_shortcut_inbox
      where id = (select (item->>'id')::uuid from jsonb_array_elements(items) with ordinality e(item, n) order by n desc limit 1)
        and user_id = owner_id;
  end if;
  return jsonb_build_object('items', items, 'pending_count', pending_count, 'has_more', has_more,
    'next_created_at', case when has_more then next_created_at else null end,
    'next_id', case when has_more then next_id else null end);
end $$;


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
  if rate.minute_count > 30 or rate.day_count > 300 then return jsonb_build_object('error', 'shortcut_rate_limit'); end if;

  if p_event_key like 'id:%' then
    select * into previous from public.finance_shortcut_inbox where user_id = owner_id and connection_id = connection.id and event_key = p_event_key;
    if found then
      if previous.fingerprint <> p_fingerprint then return jsonb_build_object('error', 'event_id_payload_conflict'); end if;
      return jsonb_build_object('status', previous.status, 'id', previous.id, 'duplicate', true);
    end if;
    select * into receipt from finance_private.shortcut_inbox_receipts
    where user_id = owner_id and connection_id = connection.id and event_key = p_event_key;
    if found then
      if receipt.fingerprint <> p_fingerprint then return jsonb_build_object('error', 'event_id_payload_conflict'); end if;
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
    if archived_count <> 1 then return jsonb_build_object('error', 'shortcut_inbox_limit'); end if;
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


create or replace function public.finance_shortcut_list_pending(p_before_created_at timestamptz default null, p_before_id uuid default null, p_limit integer default 100) returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_list_pending(p_before_created_at, p_before_id, p_limit) $$;

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
commit;
