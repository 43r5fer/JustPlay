begin;

create or replace function private.flock_is_user_blocked(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.flock_user_blocks b
    where (b.blocker_id = private.flock_session_user_id() and b.blocked_id = p_user_id)
       or (b.blocker_id = p_user_id and b.blocked_id = private.flock_session_user_id())
  );
$$;

create or replace function private.flock_conversation_is_blocked(p_conversation_id uuid)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare v_me uuid := private.flock_session_user_id(); v_peer uuid; v_kind text;
begin
  if v_me is null then return true; end if;
  select c.kind into v_kind from public.flock_conversations c where c.id = p_conversation_id;
  if v_kind is null then return true; end if;
  if v_kind <> 'direct' then return false; end if;
  if not exists (select 1 from public.flock_conversation_members m where m.conversation_id = p_conversation_id and m.user_id = v_me) then return true; end if;
  select m.user_id into v_peer from public.flock_conversation_members m where m.conversation_id = p_conversation_id and m.user_id <> v_me limit 1;
  if v_peer is null then return false; end if;
  return exists (select 1 from public.flock_user_blocks b
    where (b.blocker_id = v_me and b.blocked_id = v_peer) or (b.blocker_id = v_peer and b.blocked_id = v_me));
end;
$$;

create or replace function private.flock_can_send_friend_request(p_addressee_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select private.flock_session_user_id() is not null
    and p_addressee_id is not null
    and p_addressee_id <> private.flock_session_user_id()
    and not exists (select 1 from public.flock_friendships f
      where (f.requester_id = private.flock_session_user_id() and f.addressee_id = p_addressee_id)
         or (f.addressee_id = private.flock_session_user_id() and f.requester_id = p_addressee_id))
    and not private.flock_is_user_blocked(p_addressee_id);
$$;

create or replace function public.flock_find_friend_code(p_friend_code text)
returns table(id uuid, username text, display_name text, friend_code text)
language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := private.flock_session_user_id();
begin
  if v_me is null then raise exception 'Sign in to look up a friend code.'; end if;
  if p_friend_code is null or p_friend_code !~ '^[0-9]{10}$' then raise exception 'Enter the full 10-digit friend code.'; end if;
  return query select p.id, p.username, p.display_name, p.friend_code
    from public.flock_profiles p where p.friend_code = p_friend_code and p.id <> v_me
      and not private.flock_is_user_blocked(p.id) limit 1;
end;
$$;

drop policy if exists flock_call_signals_participant_read on public.flock_call_signals;
drop policy if exists flock_call_signals_member_insert on public.flock_call_signals;
drop policy if exists flock_conversations_respect_blocks on public.flock_conversations;
drop policy if exists flock_messages_respect_blocks_read on public.flock_messages;
drop policy if exists flock_messages_respect_blocks_insert on public.flock_messages;
drop policy if exists flock_messages_respect_blocks_update on public.flock_messages;
drop policy if exists flock_messages_respect_blocks_delete on public.flock_messages;
drop policy if exists flock_friendships_respect_blocks_insert on public.flock_friendships;

create policy flock_call_signals_participant_read on public.flock_call_signals for select to anon, authenticated
  using ((sender_id = private.flock_session_user_id() or recipient_id = private.flock_session_user_id())
    and not private.flock_conversation_is_blocked(conversation_id));
create policy flock_call_signals_member_insert on public.flock_call_signals for insert to anon, authenticated
  with check (
    sender_id = private.flock_session_user_id()
    and recipient_id <> private.flock_session_user_id()
    and not private.flock_conversation_is_blocked(conversation_id)
    and exists (
      select 1 from public.flock_conversations c
      join public.flock_conversation_members sender on sender.conversation_id = c.id
      join public.flock_conversation_members recipient on recipient.conversation_id = c.id
      where c.id = flock_call_signals.conversation_id and c.kind = 'direct'
        and sender.user_id = private.flock_session_user_id()
        and recipient.user_id = flock_call_signals.recipient_id
    )
  );
create policy flock_conversations_respect_blocks on public.flock_conversations as restrictive for select to anon, authenticated
  using (not private.flock_conversation_is_blocked(id));
create policy flock_messages_respect_blocks_read on public.flock_messages as restrictive for select to anon, authenticated
  using (not private.flock_conversation_is_blocked(conversation_id));
create policy flock_messages_respect_blocks_insert on public.flock_messages as restrictive for insert to anon, authenticated
  with check (not private.flock_conversation_is_blocked(conversation_id));
create policy flock_messages_respect_blocks_update on public.flock_messages as restrictive for update to anon, authenticated
  using (not private.flock_conversation_is_blocked(conversation_id))
  with check (not private.flock_conversation_is_blocked(conversation_id));
create policy flock_messages_respect_blocks_delete on public.flock_messages as restrictive for delete to anon, authenticated
  using (not private.flock_conversation_is_blocked(conversation_id));
create policy flock_friendships_respect_blocks_insert on public.flock_friendships as restrictive for insert to anon, authenticated
  with check (not private.flock_is_user_blocked(addressee_id));

drop policy if exists flock_media_conversation_read on storage.objects;
create policy flock_media_conversation_read on storage.objects for select to anon, authenticated using (
  bucket_id = 'flock-media' and exists (
    select 1 from public.flock_messages m
    where m.media_path = name and m.deleted_at is null
      and private.flock_is_member(m.conversation_id)
      and not private.flock_conversation_is_blocked(m.conversation_id)
  )
);

revoke all on function public.flock_is_user_blocked(uuid) from public, anon, authenticated;
revoke all on function public.flock_conversation_is_blocked(uuid) from public, anon, authenticated;
revoke all on function private.flock_is_user_blocked(uuid) from public;
revoke all on function private.flock_conversation_is_blocked(uuid) from public;
grant execute on function private.flock_is_user_blocked(uuid) to anon, authenticated;
grant execute on function private.flock_conversation_is_blocked(uuid) to anon, authenticated;

drop function public.flock_is_user_blocked(uuid);
drop function public.flock_conversation_is_blocked(uuid);

create index if not exists flock_call_signals_conversation_idx on public.flock_call_signals(conversation_id);
create index if not exists flock_call_signals_sender_idx on public.flock_call_signals(sender_id);

commit;