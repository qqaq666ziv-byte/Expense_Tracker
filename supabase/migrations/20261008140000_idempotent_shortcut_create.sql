-- A client may lose the RPC response after the insert committed. Repeating the
-- same create request (same random token hash) returns the existing connection
-- to its owner, so the UI can safely recover the one-time token in memory.
-- No raw token is stored and no credential/authentication semantics change.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';

create or replace function finance_private.shortcut_create(p_label text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  created public.finance_shortcut_connections;
begin
  if owner_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_label is null or char_length(btrim(p_label)) not between 1 and 64 or octet_length(p_label) > 256
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
  then raise exception 'invalid_connection' using errcode = '22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance-shortcut:' || owner_id::text, 0));

  select * into created from public.finance_shortcut_connections
  where user_id = owner_id and token_hash = p_token_hash;
  if found then
    if created.label <> btrim(p_label) then
      raise exception 'connection_create_conflict' using errcode = '23505';
    end if;
    return finance_private.shortcut_connection_json(created);
  end if;

  if (select count(*) from public.finance_shortcut_connections where user_id = owner_id and revoked_at is null) >= 5
    or (select count(*) from public.finance_shortcut_connections where user_id = owner_id) >= 100
  then raise exception 'connection_limit' using errcode = '54000'; end if;
  insert into public.finance_shortcut_connections(user_id, label, token_hash)
  values (owner_id, btrim(p_label), p_token_hash) returning * into created;
  return finance_private.shortcut_connection_json(created);
end $$;

revoke all on function finance_private.shortcut_create(text, text) from public, anon, authenticated, service_role;
grant execute on function finance_private.shortcut_create(text, text) to authenticated;
revoke all on function public.finance_shortcut_create(text, text) from public, anon, authenticated, service_role;
grant execute on function public.finance_shortcut_create(text, text) to authenticated;

commit;
