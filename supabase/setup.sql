-- Flock cloud schema for a fresh Supabase project.
-- Run once in the SQL Editor. Client access is controlled by Supabase Auth + RLS.
-- Never expose a service_role key in the desktop, web or Android application.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.flock_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[a-z0-9_.-]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  avatar_path text,
  background_path text,
  background_type text check (background_type is null or background_type in ('image','video')),
  bio text not null default '' check (char_length(bio) <= 180),
  friend_code text not null unique check (friend_code ~ '^[0-9]{10}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index flock_profiles_username_lower_uq on public.flock_profiles(lower(username));
create index flock_profiles_friend_code_idx on public.flock_profiles(friend_code);

create table public.flock_friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.flock_profiles(id) on delete cascade,
  addressee_id uuid not null references public.flock_profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flock_friendships_no_self check (requester_id <> addressee_id),
  constraint flock_friendships_direction_uq unique (requester_id,addressee_id)
);
create index flock_friendships_requester_status_idx on public.flock_friendships(requester_id,status);
create index flock_friendships_addressee_status_idx on public.flock_friendships(addressee_id,status);

create table public.flock_conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct','group')),
  name text check (name is null or char_length(name) between 1 and 80),
  owner_id uuid not null references public.flock_profiles(id) on delete cascade,
  group_avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index flock_conversations_owner_idx on public.flock_conversations(owner_id,created_at desc);

create table public.flock_conversation_members (
  conversation_id uuid not null references public.flock_conversations(id) on delete cascade,
  user_id uuid not null references public.flock_profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','co_admin','member')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id,user_id)
);
create index flock_conversation_members_user_idx on public.flock_conversation_members(user_id,joined_at desc);

create table public.flock_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.flock_conversations(id) on delete cascade,
  sender_id uuid not null references public.flock_profiles(id) on delete cascade,
  kind text not null default 'text' check (kind in ('text','image','video','voice','video_note','file','youtube')),
  body text not null default '' check (char_length(body) <= 10000),
  media_path text,
  media_name text,
  media_type text,
  media_size bigint check (media_size is null or media_size >= 0),
  youtube_id text check (youtube_id is null or youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  reply_to uuid references public.flock_messages(id) on delete set null,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint flock_message_payload check (
    kind <> 'text' or char_length(btrim(body)) > 0 or deleted_at is not null
    or media_path is not null or youtube_id is not null
  )
);
create index flock_messages_conversation_created_idx on public.flock_messages(conversation_id,created_at desc);
create index flock_messages_sender_created_idx on public.flock_messages(sender_id,created_at desc);

create table public.flock_message_receipts (
  message_id uuid not null references public.flock_messages(id) on delete cascade,
  user_id uuid not null references public.flock_profiles(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (message_id,user_id)
);
create index flock_message_receipts_user_read_idx on public.flock_message_receipts(user_id,read_at);

create table public.flock_statuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.flock_profiles(id) on delete cascade,
  kind text not null check (kind in ('image','video','text')),
  body text not null default '' check (char_length(body) <= 500),
  media_path text,
  media_type text,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  constraint flock_status_expiry_window check (expires_at > created_at and expires_at <= created_at + interval '24 hours 5 minutes'),
  constraint flock_status_content check (kind = 'text' or media_path is not null)
);
create index flock_statuses_user_created_idx on public.flock_statuses(user_id,created_at desc);
create index flock_statuses_expires_idx on public.flock_statuses(expires_at);

create table public.flock_status_views (
  status_id uuid not null references public.flock_statuses(id) on delete cascade,
  viewer_id uuid not null references public.flock_profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (status_id,viewer_id)
);
create index flock_status_views_viewer_idx on public.flock_status_views(viewer_id,viewed_at desc);

create table public.flock_message_reactions (
  message_id uuid not null references public.flock_messages(id) on delete cascade,
  user_id uuid not null references public.flock_profiles(id) on delete cascade,
  emoji text not null check (emoji in ('❤️','😂','👍','😮','😢','🔥','🎉')),
  created_at timestamptz not null default now(),
  primary key (message_id,user_id)
);

create or replace function private.flock_set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.flock_set_updated_at() from public, anon, authenticated;

create or replace function private.flock_handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_username text;
  v_display_name text;
  v_friend_code text;
  v_attempt integer;
begin
  v_username := pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.coalesce(new.raw_user_meta_data ->> 'username', pg_catalog.split_part(pg_catalog.coalesce(new.email,''),'@',1), 'player'),
    '[^a-zA-Z0-9_.-]', '', 'g'
  ));
  if pg_catalog.char_length(v_username) < 3 then
    v_username := 'user_' || pg_catalog.substr(pg_catalog.replace(new.id::text,'-',''),1,12);
  end if;
  v_username := pg_catalog.substr(v_username,1,24);
  v_display_name := pg_catalog.left(pg_catalog.coalesce(nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name'),''),v_username),80);
  for v_attempt in 1..50 loop
    v_friend_code := pg_catalog.lpad((pg_catalog.floor(pg_catalog.random() * 10000000000)::bigint)::text,10,'0');
    begin
      insert into public.flock_profiles(id,username,display_name,friend_code)
      values(new.id,v_username,v_display_name,v_friend_code);
      return new;
    exception when unique_violation then
      if exists(select 1 from public.flock_profiles p where p.id=new.id) then return new; end if;
      if exists(select 1 from public.flock_profiles p where pg_catalog.lower(p.username)=v_username) then
        raise exception 'This username is already in use.';
      end if;
      if v_attempt = 50 then raise; end if;
    end;
  end loop;
  return new;
end;
$$;
revoke all on function private.flock_handle_new_user() from public, anon, authenticated;
drop trigger if exists flock_auth_user_created on auth.users;
create trigger flock_auth_user_created after insert on auth.users
for each row execute function private.flock_handle_new_user();

create or replace function private.flock_is_member(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.flock_conversation_members m
    where m.conversation_id=p_conversation_id and m.user_id=(select auth.uid()));
$$;
create or replace function private.flock_is_admin(p_conversation_id uuid,p_roles text[] default array['owner','admin','co_admin']::text[])
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.flock_conversation_members m
    where m.conversation_id=p_conversation_id and m.user_id=(select auth.uid()) and m.role=any(p_roles));
$$;
create or replace function private.flock_are_friends(p_a uuid,p_b uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.flock_friendships f where f.status='accepted'
    and ((f.requester_id=p_a and f.addressee_id=p_b) or (f.requester_id=p_b and f.addressee_id=p_a)));
$$;
grant execute on function private.flock_is_member(uuid) to authenticated;
grant execute on function private.flock_is_admin(uuid,text[]) to authenticated;
grant execute on function private.flock_are_friends(uuid,uuid) to authenticated;

create or replace function public.flock_create_direct_conversation(p_other_user uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid()); v_conversation uuid;
begin
  if v_me is null then raise exception 'Sign in to start a chat.'; end if;
  if p_other_user is null or p_other_user=v_me then raise exception 'Choose another user.'; end if;
  if not private.flock_are_friends(v_me,p_other_user) then raise exception 'Add this person as a friend before starting a chat.'; end if;
  select c.id into v_conversation from public.flock_conversations c
  where c.kind='direct'
    and exists(select 1 from public.flock_conversation_members a where a.conversation_id=c.id and a.user_id=v_me)
    and exists(select 1 from public.flock_conversation_members b where b.conversation_id=c.id and b.user_id=p_other_user)
    and (select count(*) from public.flock_conversation_members x where x.conversation_id=c.id)=2
  limit 1;
  if v_conversation is not null then return v_conversation; end if;
  insert into public.flock_conversations(kind,owner_id) values('direct',v_me) returning id into v_conversation;
  insert into public.flock_conversation_members(conversation_id,user_id,role) values
    (v_conversation,v_me,'owner'),(v_conversation,p_other_user,'member');
  return v_conversation;
end;
$$;
revoke all on function public.flock_create_direct_conversation(uuid) from public, anon;
grant execute on function public.flock_create_direct_conversation(uuid) to authenticated;

create or replace function public.flock_create_group(p_name text,p_member_ids uuid[] default array[]::uuid[])
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid()); v_name text := pg_catalog.btrim(p_name); v_group uuid; v_member uuid;
begin
  if v_me is null then raise exception 'Sign in to create a group.'; end if;
  if pg_catalog.char_length(v_name) not between 1 and 80 then raise exception 'Group names must be 1 to 80 characters.'; end if;
  if pg_catalog.cardinality(coalesce(p_member_ids,array[]::uuid[])) > 100 then raise exception 'Groups can have at most 100 additional members.'; end if;
  for v_member in select distinct unnest(coalesce(p_member_ids,array[]::uuid[])) loop
    if v_member=v_me then continue; end if;
    if not private.flock_are_friends(v_me,v_member) then raise exception 'Groups can only be created with accepted friends.'; end if;
  end loop;
  insert into public.flock_conversations(kind,name,owner_id) values('group',v_name,v_me) returning id into v_group;
  insert into public.flock_conversation_members(conversation_id,user_id,role) values(v_group,v_me,'owner');
  for v_member in select distinct unnest(coalesce(p_member_ids,array[]::uuid[])) loop
    if v_member<>v_me then insert into public.flock_conversation_members(conversation_id,user_id,role)
      values(v_group,v_member,'member') on conflict do nothing; end if;
  end loop;
  return v_group;
end;
$$;
revoke all on function public.flock_create_group(text,uuid[]) from public, anon;
grant execute on function public.flock_create_group(text,uuid[]) to authenticated;

create or replace function public.flock_add_group_member(p_conversation_id uuid,p_user_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid()); v_kind text;
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  select kind into v_kind from public.flock_conversations where id=p_conversation_id;
  if v_kind is distinct from 'group' then raise exception 'Members can only be added to groups.'; end if;
  if not private.flock_is_admin(p_conversation_id,array['owner','admin','co_admin']::text[]) then raise exception 'You do not have permission to add group members.'; end if;
  if not private.flock_are_friends(v_me,p_user_id) then raise exception 'You can only add accepted friends.'; end if;
  insert into public.flock_conversation_members(conversation_id,user_id,role) values(p_conversation_id,p_user_id,'member') on conflict do nothing;
  return true;
end;
$$;
revoke all on function public.flock_add_group_member(uuid,uuid) from public, anon;
grant execute on function public.flock_add_group_member(uuid,uuid) to authenticated;

create or replace function public.flock_set_group_role(p_conversation_id uuid,p_user_id uuid,p_role text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid()); v_actor_role text; v_kind text;
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  select c.kind,m.role into v_kind,v_actor_role from public.flock_conversations c
  join public.flock_conversation_members m on m.conversation_id=c.id
  where c.id=p_conversation_id and m.user_id=v_me;
  if v_kind is distinct from 'group' then raise exception 'Role changes are only available in groups.'; end if;
  if p_role not in ('admin','co_admin','member') then raise exception 'Choose admin, co-admin, or member.'; end if;
  if v_actor_role='owner' then null;
  elsif v_actor_role='admin' and p_role in ('co_admin','member') then null;
  else raise exception 'You do not have permission to change this role.'; end if;
  if not exists(select 1 from public.flock_conversation_members where conversation_id=p_conversation_id and user_id=p_user_id) then raise exception 'That user is not in this group.'; end if;
  if exists(select 1 from public.flock_conversation_members where conversation_id=p_conversation_id and user_id=p_user_id and role='owner') then raise exception 'The group owner role cannot be reassigned here.'; end if;
  update public.flock_conversation_members set role=p_role where conversation_id=p_conversation_id and user_id=p_user_id;
  return true;
end;
$$;
revoke all on function public.flock_set_group_role(uuid,uuid,text) from public, anon;
grant execute on function public.flock_set_group_role(uuid,uuid,text) to authenticated;

create or replace function public.flock_remove_group_member(p_conversation_id uuid,p_user_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid()); v_actor_role text; v_target_role text;
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  select role into v_actor_role from public.flock_conversation_members where conversation_id=p_conversation_id and user_id=v_me;
  select role into v_target_role from public.flock_conversation_members where conversation_id=p_conversation_id and user_id=p_user_id;
  if v_target_role is null then return true; end if;
  if v_target_role='owner' then raise exception 'The owner cannot be removed. Transfer ownership or delete the group instead.'; end if;
  if p_user_id=v_me then
    if v_actor_role='owner' then raise exception 'The owner must transfer ownership before leaving.'; end if;
  elsif v_actor_role='owner' then null;
  elsif v_actor_role='admin' and v_target_role in ('co_admin','member') then null;
  elsif v_actor_role='co_admin' and v_target_role='member' then null;
  else raise exception 'You do not have permission to remove this member.'; end if;
  delete from public.flock_conversation_members where conversation_id=p_conversation_id and user_id=p_user_id;
  return true;
end;
$$;
revoke all on function public.flock_remove_group_member(uuid,uuid) from public, anon;
grant execute on function public.flock_remove_group_member(uuid,uuid) to authenticated;

create or replace function public.flock_mark_conversation_read(p_conversation_id uuid)
returns integer language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid()); v_count integer;
begin
  if v_me is null or not private.flock_is_member(p_conversation_id) then raise exception 'You are not a member of this chat.'; end if;
  insert into public.flock_message_receipts(message_id,user_id,delivered_at,read_at)
    select m.id,v_me,pg_catalog.now(),pg_catalog.now() from public.flock_messages m
    where m.conversation_id=p_conversation_id and m.sender_id<>v_me and m.deleted_at is null
  on conflict (message_id,user_id) do update set read_at=excluded.read_at;
  get diagnostics v_count = row_count;
  update public.flock_conversation_members set last_read_at=pg_catalog.now() where conversation_id=p_conversation_id and user_id=v_me;
  return v_count;
end;
$$;
revoke all on function public.flock_mark_conversation_read(uuid) from public, anon;
grant execute on function public.flock_mark_conversation_read(uuid) to authenticated;

create or replace function private.flock_bump_conversation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.flock_conversations set updated_at=pg_catalog.now()
  where id=coalesce(new.conversation_id,old.conversation_id);
  return coalesce(new,old);
end;
$$;
revoke all on function private.flock_bump_conversation() from public, anon, authenticated;

create trigger flock_profiles_set_updated_at before update on public.flock_profiles for each row execute function private.flock_set_updated_at();
create trigger flock_friendships_set_updated_at before update on public.flock_friendships for each row execute function private.flock_set_updated_at();
create trigger flock_conversations_set_updated_at before update on public.flock_conversations for each row execute function private.flock_set_updated_at();
create trigger flock_messages_bump_conversation after insert or update on public.flock_messages for each row execute function private.flock_bump_conversation();

alter table public.flock_profiles enable row level security;
alter table public.flock_friendships enable row level security;
alter table public.flock_conversations enable row level security;
alter table public.flock_conversation_members enable row level security;
alter table public.flock_messages enable row level security;
alter table public.flock_message_receipts enable row level security;
alter table public.flock_statuses enable row level security;
alter table public.flock_status_views enable row level security;
alter table public.flock_message_reactions enable row level security;

grant usage on schema public to authenticated;
grant usage on schema private to authenticated;

grant select on public.flock_profiles to authenticated;
grant update(display_name,avatar_path,background_path,background_type,bio) on public.flock_profiles to authenticated;
grant select,insert,update,delete on public.flock_friendships to authenticated;
grant select,insert,update on public.flock_conversations to authenticated;
grant select,insert,update,delete on public.flock_conversation_members to authenticated;
grant select,insert,update,delete on public.flock_messages to authenticated;
grant select,insert,update on public.flock_message_receipts to authenticated;
grant select,insert,delete on public.flock_statuses to authenticated;
grant select,insert on public.flock_status_views to authenticated;
grant select,insert,delete on public.flock_message_reactions to authenticated;

create policy flock_profiles_related_read on public.flock_profiles for select to authenticated using (private.flock_can_view_profile(id));
create policy flock_profiles_owner_update on public.flock_profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));

create policy flock_friendships_participant_read on public.flock_friendships for select to authenticated using (requester_id=(select auth.uid()) or addressee_id=(select auth.uid()));
create policy flock_friendships_request_create on public.flock_friendships for insert to authenticated with check (requester_id=(select auth.uid()) and status='pending' and private.flock_can_send_friend_request(addressee_id));
create policy flock_friendships_recipient_response on public.flock_friendships for update to authenticated using (addressee_id=(select auth.uid()) and status='pending') with check (addressee_id=(select auth.uid()) and status in ('accepted','declined','blocked'));
create policy flock_friendships_requester_cancel on public.flock_friendships for delete to authenticated using (requester_id=(select auth.uid()) and status='pending');

create policy flock_conversations_member_read on public.flock_conversations for select to authenticated using (private.flock_is_member(id));
create policy flock_conversations_group_settings on public.flock_conversations for update to authenticated using (kind='group' and private.flock_is_admin(id,array['owner','admin']::text[])) with check (kind='group' and private.flock_is_admin(id,array['owner','admin']::text[]));

create policy flock_members_member_read on public.flock_conversation_members for select to authenticated using (private.flock_is_member(conversation_id));
create policy flock_members_admin_insert on public.flock_conversation_members for insert to authenticated with check (
  (user_id=(select auth.uid()) and role='owner' and exists(select 1 from public.flock_conversations c where c.id=conversation_id and c.owner_id=(select auth.uid())))
  or private.flock_is_admin(conversation_id,array['owner','admin','co_admin']::text[])
);
create policy flock_members_admin_update on public.flock_conversation_members for update to authenticated using (private.flock_is_admin(conversation_id,array['owner','admin']::text[]) and role<>'owner') with check (private.flock_is_admin(conversation_id,array['owner','admin']::text[]) and role<>'owner');
create policy flock_members_self_or_admin_delete on public.flock_conversation_members for delete to authenticated using ((user_id=(select auth.uid()) and role<>'owner') or (private.flock_is_admin(conversation_id,array['owner','admin']::text[]) and role<>'owner'));

create policy flock_messages_member_read on public.flock_messages for select to authenticated using (private.flock_is_member(conversation_id));
create policy flock_messages_member_send on public.flock_messages for insert to authenticated with check (sender_id=(select auth.uid()) and private.flock_is_member(conversation_id));
create policy flock_messages_author_edit on public.flock_messages for update to authenticated using (sender_id=(select auth.uid()) and private.flock_is_member(conversation_id) and deleted_at is null) with check (sender_id=(select auth.uid()) and private.flock_is_member(conversation_id));

create policy flock_receipts_member_read on public.flock_message_receipts for select to authenticated using (exists(select 1 from public.flock_messages m where m.id=message_id and private.flock_is_member(m.conversation_id)));
create policy flock_receipts_self_insert on public.flock_message_receipts for insert to authenticated with check (user_id=(select auth.uid()) and exists(select 1 from public.flock_messages m where m.id=message_id and m.sender_id<>(select auth.uid()) and private.flock_is_member(m.conversation_id)));
create policy flock_receipts_self_update on public.flock_message_receipts for update to authenticated using (user_id=(select auth.uid()) and exists(select 1 from public.flock_messages m where m.id=message_id and private.flock_is_member(m.conversation_id))) with check (user_id=(select auth.uid()) and exists(select 1 from public.flock_messages m where m.id=message_id and private.flock_is_member(m.conversation_id)));

create policy flock_statuses_friend_read on public.flock_statuses for select to authenticated using (user_id=(select auth.uid()) or private.flock_are_friends((select auth.uid()),user_id));
create policy flock_statuses_owner_insert on public.flock_statuses for insert to authenticated with check (
  user_id=(select auth.uid()) and expires_at<=pg_catalog.now()+interval '24 hours 5 minutes' and expires_at>pg_catalog.now()
  and (kind='text' or (media_path is not null and (storage.foldername(media_path))[1]=(select auth.uid())::text))
);
create policy flock_statuses_owner_delete on public.flock_statuses for delete to authenticated using (user_id=(select auth.uid()));

create policy flock_status_views_friend_read on public.flock_status_views for select to authenticated using (viewer_id=(select auth.uid()) or exists(select 1 from public.flock_statuses s where s.id=status_id and s.user_id=(select auth.uid())));
create policy flock_status_views_self_insert on public.flock_status_views for insert to authenticated with check (
  viewer_id=(select auth.uid()) and exists(select 1 from public.flock_statuses s where s.id=status_id and s.user_id<>(select auth.uid()) and private.flock_are_friends((select auth.uid()),s.user_id) and s.expires_at>pg_catalog.now())
);

create policy flock_reactions_member_read on public.flock_message_reactions for select to authenticated using (exists(select 1 from public.flock_messages m where m.id=message_id and private.flock_is_member(m.conversation_id)));
create policy flock_reactions_self_insert on public.flock_message_reactions for insert to authenticated with check (user_id=(select auth.uid()) and exists(select 1 from public.flock_messages m where m.id=message_id and private.flock_is_member(m.conversation_id)));
create policy flock_reactions_self_delete on public.flock_message_reactions for delete to authenticated using (user_id=(select auth.uid()) and exists(select 1 from public.flock_messages m where m.id=message_id and private.flock_is_member(m.conversation_id)));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('flock-media','flock-media',false,104857600,array[
  'image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','audio/webm','audio/ogg','audio/mp4','audio/mpeg','application/pdf','text/plain'
]::text[])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create policy flock_media_owner_upload on storage.objects for insert to authenticated with check (bucket_id='flock-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy flock_media_owner_read on storage.objects for select to authenticated using (bucket_id='flock-media' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy flock_media_conversation_read on storage.objects for select to authenticated using (
  bucket_id='flock-media' and exists(select 1 from public.flock_messages m where m.media_path=name and m.deleted_at is null and private.flock_is_member(m.conversation_id))
);
create policy flock_media_friend_status_read on storage.objects for select to authenticated using (
  bucket_id='flock-media' and exists(select 1 from public.flock_statuses s where s.media_path=name and s.expires_at>pg_catalog.now() and private.flock_are_friends((select auth.uid()),s.user_id))
);
create policy flock_media_friend_profile_read on storage.objects for select to authenticated using (
  bucket_id='flock-media' and exists(select 1 from public.flock_profiles p where (p.avatar_path=name or p.background_path=name) and (p.id=(select auth.uid()) or private.flock_are_friends((select auth.uid()),p.id)))
);
create policy flock_media_owner_delete on storage.objects for delete to authenticated using (bucket_id='flock-media' and (storage.foldername(name))[1]=(select auth.uid())::text);

revoke update on public.flock_friendships from authenticated;
grant update(status) on public.flock_friendships to authenticated;
revoke update on public.flock_conversations from authenticated;
grant update(name,group_avatar_path,updated_at) on public.flock_conversations to authenticated;
revoke update on public.flock_conversation_members from authenticated;
grant update(role,last_read_at) on public.flock_conversation_members to authenticated;
revoke update on public.flock_messages from authenticated;
grant update(body,media_path,media_name,media_type,media_size,edited_at,deleted_at) on public.flock_messages to authenticated;
revoke update on public.flock_message_receipts from authenticated;
grant update(read_at,delivered_at) on public.flock_message_receipts to authenticated;

do $$
declare v_table text;
begin
  foreach v_table in array array['flock_messages','flock_message_receipts','flock_friendships','flock_conversation_members','flock_statuses','flock_status_views','flock_message_reactions'] loop
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=v_table) then
      execute pg_catalog.format('alter publication supabase_realtime add table public.%I',v_table);
    end if;
  end loop;
end $$;
