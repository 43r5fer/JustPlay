-- Apply this after supabase/setup.sql to switch Flock to its own username/password sessions.
-- User passwords are PBKDF2-SHA256 hashes created by supabase/functions/flock-auth.
-- The service-role key is used only inside that Edge Function and is never shipped to clients.

begin;

drop trigger if exists flock_auth_user_created on auth.users;
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid='public.flock_profiles'::regclass
      and contype='f'
      and confrelid='auth.users'::regclass
  loop
    execute format('alter table public.flock_profiles drop constraint %I',r.conname);
  end loop;
end $$;
alter table public.flock_profiles alter column id set default gen_random_uuid();
drop function if exists private.flock_handle_new_user() cascade;

create table if not exists public.flock_credentials (
  user_id uuid primary key references public.flock_profiles(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.-]{3,24}$'),
  password_salt text not null check (password_salt ~ '^[a-f0-9]{32,128}$'),
  password_hash text not null check (password_hash ~ '^[a-f0-9]{64}$'),
  password_iterations integer not null default 310000 check (password_iterations between 200000 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists flock_credentials_username_lower_uq on public.flock_credentials(lower(username));

create table if not exists public.flock_auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.flock_profiles(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  remembered boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists flock_auth_sessions_user_expiry_idx on public.flock_auth_sessions(user_id,expires_at desc);
create index if not exists flock_auth_sessions_expiry_idx on public.flock_auth_sessions(expires_at) where revoked_at is null;

create table if not exists public.flock_auth_rate_limits (
  bucket_key text primary key check (bucket_key ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  updated_at timestamptz not null default now()
);

alter table public.flock_credentials enable row level security;
alter table public.flock_auth_sessions enable row level security;
alter table public.flock_auth_rate_limits enable row level security;
revoke all on public.flock_credentials from public, anon, authenticated;
revoke all on public.flock_auth_sessions from public, anon, authenticated;
revoke all on public.flock_auth_rate_limits from public, anon, authenticated;
grant all on public.flock_credentials to service_role;
grant all on public.flock_auth_sessions to service_role;
grant all on public.flock_auth_rate_limits to service_role;

create or replace function private.flock_session_user_id()
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare v_headers jsonb; v_token text; v_user_id uuid;
begin
  begin
    v_headers := coalesce(nullif(pg_catalog.current_setting('request.headers',true),''),'{}')::jsonb;
  exception when others then return null;
  end;
  v_token := coalesce(v_headers ->> 'x-flock-session','');
  if v_token !~ '^[a-f0-9]{64}$' then return null; end if;
  select s.user_id into v_user_id
  from public.flock_auth_sessions s
  where s.token_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token,'UTF8')),'hex')
    and s.revoked_at is null and s.expires_at>pg_catalog.now()
  limit 1;
  return v_user_id;
end;
$$;
revoke all on function private.flock_session_user_id() from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.flock_session_user_id() to anon, authenticated;

create or replace function public.flock_auth_take_attempt(p_bucket_key text,p_limit integer default 8,p_window_seconds integer default 900)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_attempts integer;
begin
  if p_bucket_key is null or p_bucket_key !~ '^[a-f0-9]{64}$' or p_limit<1 or p_window_seconds<1 then return false; end if;
  insert into public.flock_auth_rate_limits(bucket_key,window_started_at,attempts,updated_at)
  values(p_bucket_key,pg_catalog.now(),1,pg_catalog.now())
  on conflict (bucket_key) do update
  set window_started_at=case when public.flock_auth_rate_limits.window_started_at+pg_catalog.make_interval(secs=>p_window_seconds)<=pg_catalog.now() then pg_catalog.now() else public.flock_auth_rate_limits.window_started_at end,
      attempts=case when public.flock_auth_rate_limits.window_started_at+pg_catalog.make_interval(secs=>p_window_seconds)<=pg_catalog.now() then 1 else public.flock_auth_rate_limits.attempts+1 end,
      updated_at=pg_catalog.now()
  returning attempts into v_attempts;
  return v_attempts<=p_limit;
end;
$$;
revoke all on function public.flock_auth_take_attempt(text,integer,integer) from public, anon, authenticated;
grant execute on function public.flock_auth_take_attempt(text,integer,integer) to service_role;

-- Only alter functions explicitly belonging to Flock; unrelated apps in the same Supabase project are left untouched.
do $$
declare r record; definition text;
begin
  for r in
    select p.oid
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and p.proname like 'flock_%'
      and p.prokind='f'
      and pg_catalog.pg_get_functiondef(p.oid) like '%auth.uid()%'
  loop
    definition := pg_catalog.pg_get_functiondef(r.oid);
    definition := replace(definition,'auth.uid()','private.flock_session_user_id()');
    execute definition;
  end loop;
end $$;

-- Recreate only Flock policies, adding the anon PostgREST role and swapping auth.uid() for validated session identity.
do $$
declare r record; roles_sql text; using_sql text; check_sql text;
begin
  for r in
    select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
    from pg_policies
    where (schemaname='public' and tablename like 'flock_%'
           and tablename not in ('flock_credentials','flock_auth_sessions','flock_auth_rate_limits'))
       or (schemaname='storage' and tablename='objects' and policyname like 'flock_media_%')
  loop
    execute format('drop policy if exists %I on %I.%I',r.policyname,r.schemaname,r.tablename);
    select string_agg(format('%I',role_name),', ' order by role_name)
      into roles_sql
    from (select distinct unnest(r.roles || array['anon']::name[]) as role_name) as role_list;
    using_sql := case when r.qual is null then null else replace(r.qual,'auth.uid()','private.flock_session_user_id()') end;
    check_sql := case when r.with_check is null then null else replace(r.with_check,'auth.uid()','private.flock_session_user_id()') end;
    execute format(
      'create policy %I on %I.%I as %s for %s to %s%s%s',
      r.policyname,r.schemaname,r.tablename,
      case when r.permissive='PERMISSIVE' then 'PERMISSIVE' else 'RESTRICTIVE' end,
      r.cmd,roles_sql,
      case when using_sql is null then '' else ' using ('||using_sql||')' end,
      case when check_sql is null then '' else ' with check ('||check_sql||')' end
    );
  end loop;
end $$;

-- Rest calls run under anon plus x-flock-session. RLS, not a trusted client flag, decides which rows are visible.
grant select on public.flock_profiles to anon;
grant update(display_name,avatar_path,background_path,background_type,bio) on public.flock_profiles to anon;
grant select,insert,update,delete on public.flock_friendships to anon;
grant select,insert,update on public.flock_conversations to anon;
grant select,insert,update,delete on public.flock_conversation_members to anon;
grant select,insert,update,delete on public.flock_messages to anon;
grant select,insert,update on public.flock_message_receipts to anon;
grant select,insert,delete on public.flock_statuses to anon;
grant select,insert on public.flock_status_views to anon;
grant select,insert,delete on public.flock_message_reactions to anon;

revoke all on function public.flock_create_direct_conversation(uuid) from public, authenticated;
revoke all on function public.flock_create_group(text,uuid[]) from public, authenticated;
revoke all on function public.flock_add_group_member(uuid,uuid) from public, authenticated;
revoke all on function public.flock_set_group_role(uuid,uuid,text) from public, authenticated;
revoke all on function public.flock_remove_group_member(uuid,uuid) from public, authenticated;
revoke all on function public.flock_mark_conversation_read(uuid) from public, authenticated;
revoke all on function public.flock_find_friend_code(text) from public, authenticated;
grant execute on function public.flock_create_direct_conversation(uuid) to anon;
grant execute on function public.flock_create_group(text,uuid[]) to anon;
grant execute on function public.flock_add_group_member(uuid,uuid) to anon;
grant execute on function public.flock_set_group_role(uuid,uuid,text) to anon;
grant execute on function public.flock_remove_group_member(uuid,uuid) to anon;
grant execute on function public.flock_mark_conversation_read(uuid) to anon;
grant execute on function public.flock_find_friend_code(text) to anon;
grant execute on function private.flock_is_member(uuid) to anon;
grant execute on function private.flock_is_admin(uuid,text[]) to anon;
grant execute on function private.flock_are_friends(uuid,uuid) to anon;
grant execute on function private.flock_can_view_profile(uuid) to anon;
grant execute on function private.flock_can_send_friend_request(uuid) to anon;

commit;
