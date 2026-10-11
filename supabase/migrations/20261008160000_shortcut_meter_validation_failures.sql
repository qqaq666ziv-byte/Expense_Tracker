-- Meter authenticated HTTP validation failures without retaining request data.
-- Valid requests keep the existing receive RPC, including its capacity fix.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';

create or replace function finance_private.shortcut_meter_rejection(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare owner_id uuid; rate finance_private.shortcut_rate_limits; received_time timestamptz;
begin
  -- The only input is a fixed-size credential digest, never a rejected body.
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
  then raise exception 'invalid_shortcut_token' using errcode = '42501'; end if;
  select user_id into owner_id from public.finance_shortcut_connections
  where token_hash = p_token_hash and revoked_at is null;
  if not found then raise exception 'invalid_shortcut_token' using errcode = '42501'; end if;

  -- Use the same owner lock and lock order as receive/revoke. Recheck after
  -- acquiring it: a revocation between edge authentication and metering wins.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance-shortcut:' || owner_id::text, 0));
  perform 1 from public.finance_shortcut_connections
  where token_hash = p_token_hash and revoked_at is null for update;
  if not found then raise exception 'invalid_shortcut_token' using errcode = '42501'; end if;
  received_time := clock_timestamp();
  insert into finance_private.shortcut_rate_limits(user_id, minute_start, minute_count, day_start, day_count)
  values(owner_id, date_trunc('minute', received_time), 1,
    date_trunc('day', received_time at time zone 'UTC') at time zone 'UTC', 1)
  on conflict (user_id) do update set
    minute_start = excluded.minute_start,
    minute_count = case when shortcut_rate_limits.minute_start = excluded.minute_start
      then least(shortcut_rate_limits.minute_count, 30) + 1 else 1 end,
    day_start = excluded.day_start,
    day_count = case when shortcut_rate_limits.day_start = excluded.day_start
      then least(shortcut_rate_limits.day_count, 300) + 1 else 1 end
  returning * into rate;
  -- Return the denial to commit its quota update. Saturating counters prevent
  -- repeated invalid requests from overflowing an integer or allocating rows.
  if rate.minute_count > 30 or rate.day_count > 300
  then return jsonb_build_object('error', 'shortcut_rate_limit'); end if;
  return jsonb_build_object('status', 'metered');
end $$;

create or replace function public.finance_shortcut_meter_rejection(p_token_hash text)
returns jsonb language sql security invoker set search_path = ''
as $$ select finance_private.shortcut_meter_rejection(p_token_hash) $$;

revoke all on function finance_private.shortcut_meter_rejection(text)
  from public, anon, authenticated, service_role;
grant execute on function finance_private.shortcut_meter_rejection(text) to service_role;
revoke all on function public.finance_shortcut_meter_rejection(text)
  from public, anon, authenticated, service_role;
grant execute on function public.finance_shortcut_meter_rejection(text) to service_role;
commit;
