-- Recover capacity from terminal ambiguity groups without dropping replay evidence.
-- No financial rows or pending inbox items are rewritten by this migration.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';

-- Archived parent IDs are evidence, not active-row foreign keys. Existing
-- receipts retain all their original fields; unknown old ambiguity stays NULL.
alter table finance_private.shortcut_inbox_receipts
  add column if not exists ambiguous_of uuid,
  add column if not exists duplicate_event boolean,
  add column if not exists original_event_key text;
create index if not exists shortcut_receipts_fingerprint_idx
  on finance_private.shortcut_inbox_receipts(user_id, connection_id, fingerprint);
create index if not exists shortcut_receipts_owner_event_idx
  on finance_private.shortcut_inbox_receipts(user_id, event_key);
create index if not exists finance_shortcut_inbox_ambiguity_reference_idx
  on public.finance_shortcut_inbox(ambiguous_of) where ambiguous_of is not null;

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
    if not found then
      -- Archived content cannot prove whether this is a retry or a new identical
      -- purchase. Preserve the arrival for review with no active-row FK.
      perform 1 from finance_private.shortcut_inbox_receipts
      where user_id = owner_id and connection_id = connection.id and fingerprint = p_fingerprint
      limit 1;
    end if;
    if found then
      is_duplicate := true; key_to_insert := 'amb:' || gen_random_uuid()::text;
    end if;
  end if;
  if (select count(*) from public.finance_shortcut_inbox where user_id = owner_id) >= 10000
  then
    -- Only terminal, already reviewed rows can leave the active inbox. Their
    -- payloads are replaced by a compact replay receipt in the same transaction.
    -- Pending items are never removed and no receipt is ever pruned. Terminal
    -- ambiguity leaves may be archived even when their fingerprint is shared.
    -- Incoming references keep parents live; future requests consult receipts.
    -- Repeated intake peels a terminal DAG from its leaves toward its roots.
    with eligible as materialized (
      select id, user_id, connection_id, event_key, fingerprint, status, ambiguous_of, duplicate_event
      from public.finance_shortcut_inbox
      where user_id = owner_id and status in ('imported', 'ignored', 'test')
        and id is distinct from duplicate_id
        and not exists (
          select 1 from public.finance_shortcut_inbox reference_row
          where reference_row.ambiguous_of = finance_shortcut_inbox.id
        )
      order by created_at, id
      limit 1
      for update skip locked
    ), retained as (
      insert into finance_private.shortcut_inbox_receipts
        (inbox_id, user_id, connection_id, event_key, fingerprint, original_status, ambiguous_of, duplicate_event, original_event_key)
      -- Stable IDs identify replay outcomes; no-ID rows identify arrivals. The
      -- old RPC could reuse an fp: key after its first row had been archived.
      -- Per-arrival keys retain both that legacy receipt and the later row.
      select id, user_id, connection_id,
        case when event_key like 'id:%' then event_key else 'amb:' || id::text end,
        fingerprint, status, ambiguous_of, duplicate_event, event_key from eligible
      on conflict (user_id, connection_id, event_key) do nothing
      returning inbox_id
    ), removed as (
      delete from public.finance_shortcut_inbox i using retained r
      where i.id = r.inbox_id and i.user_id = owner_id
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

-- Preserve the existing bounded service-only intake contract.
revoke all on function finance_private.shortcut_receive(text,text,text,jsonb,numeric,text,timestamptz,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function finance_private.shortcut_receive(text,text,text,jsonb,numeric,text,timestamptz,text,boolean,text)
  to service_role;
revoke all on function public.finance_shortcut_receive(text,text,text,jsonb,numeric,text,timestamptz,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.finance_shortcut_receive(text,text,text,jsonb,numeric,text,timestamptz,text,boolean,text)
  to service_role;
commit;
