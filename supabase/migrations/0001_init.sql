-- たびわり: shared trips. Run in the Supabase SQL editor (or `supabase db push`).
-- IDs are client-generated text so the app can create rows offline-first and migrate local data.

create table public.trips (
  id          text primary key,
  name        text not null check (char_length(name) between 1 and 100),
  start_date  date not null,
  end_date    date not null check (end_date >= start_date),
  budget      integer not null check (budget > 0),
  owner       uuid not null default auth.uid() references auth.users(id),
  created_at  timestamptz not null default now()
);

create table public.trip_members (
  id        text primary key,
  trip_id   text not null references public.trips(id) on delete cascade,
  user_id   uuid references auth.users(id),           -- null until the invitee joins
  name      text not null check (char_length(name) between 1 and 50),
  status    text not null default 'invited' check (status in ('invited','joined')),
  position  integer not null default 0,
  check ((status = 'joined') = (user_id is not null))
);
create unique index trip_members_user_once on public.trip_members(trip_id, user_id) where user_id is not null;
create index trip_members_user on public.trip_members(user_id);

create table public.invites (
  token       text primary key,
  trip_id     text not null references public.trips(id) on delete cascade,
  member_id   text not null references public.trip_members(id) on delete cascade,
  expires_at  timestamptz not null,
  created_by  uuid not null default auth.uid()
);
create index invites_member on public.invites(member_id);

create table public.expenses (
  id          text primary key,
  trip_id     text not null references public.trips(id) on delete cascade,
  title       text not null default '' check (char_length(title) <= 100),
  amount      integer not null check (amount > 0),
  payer       text not null,                                     -- trip_members.id
  cat         text not null check (cat in ('transport','stay','food','sight','gift','other')),
  spent_on    date not null,
  split       text[] not null check (cardinality(split) > 0),   -- trip_members.id, in member order
  created_at  timestamptz not null default now()
);
create index expenses_trip on public.expenses(trip_id);

create table public.paid (
  trip_id  text not null references public.trips(id) on delete cascade,
  key      text not null,                                        -- from-to-amount
  primary key (trip_id, key)
);

create table public.savings (
  trip_id    text not null references public.trips(id) on delete cascade,
  member_id  text not null references public.trip_members(id) on delete cascade,
  amount     integer not null check (amount >= 0),
  primary key (trip_id, member_id)
);

-- Membership check. SECURITY DEFINER so policies on trip_members do not recurse into themselves.
create function public.is_trip_member(p_trip text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trip_members where trip_id = p_trip and user_id = auth.uid())
      or exists (select 1 from trips where id = p_trip and owner = auth.uid());
$$;
create function public.is_trip_owner(p_trip text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trips where id = p_trip and owner = auth.uid());
$$;

alter table public.trips        enable row level security;
alter table public.trip_members enable row level security;
alter table public.invites      enable row level security;
alter table public.expenses     enable row level security;
alter table public.paid         enable row level security;
alter table public.savings      enable row level security;

create policy trips_select on public.trips for select to authenticated using (public.is_trip_member(id));
create policy trips_insert on public.trips for insert to authenticated with check (owner = auth.uid());
create policy trips_update on public.trips for update to authenticated using (public.is_trip_member(id)) with check (public.is_trip_member(id));
revoke update on public.trips from authenticated;
grant update (name, start_date, end_date, budget) on public.trips to authenticated;   -- owner can never be reassigned
create policy trips_delete on public.trips for delete to authenticated using (owner = auth.uid());

-- Members: anyone in the trip may add an invited slot; only the owner's own first row may carry a user_id on insert.
create policy members_select on public.trip_members for select to authenticated using (public.is_trip_member(trip_id));
create policy members_insert on public.trip_members for insert to authenticated with check (
  public.is_trip_member(trip_id) and (user_id is null or (user_id = auth.uid() and public.is_trip_owner(trip_id)))
);
create policy members_update on public.trip_members for update to authenticated
  using (public.is_trip_member(trip_id) and user_id is null) with check (user_id is null);   -- rename an unclaimed slot only
create policy members_delete on public.trip_members for delete to authenticated
  using (public.is_trip_member(trip_id) and user_id is null);                                 -- joined people leave via leave_trip()

-- Invites are managed only through the RPCs below.
create policy invites_select on public.invites for select to authenticated using (public.is_trip_owner(trip_id));

create policy expenses_all on public.expenses for all to authenticated
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));
create policy paid_all on public.paid for all to authenticated
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));
create policy savings_all on public.savings for all to authenticated
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

-- ---- invitations ----
-- Owner issues a one-time link for an unclaimed slot; any previous link for that slot is replaced.
create function public.create_invite(p_member text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_trip text; v_user uuid; v_token text;
begin
  select trip_id, user_id into v_trip, v_user from trip_members where id = p_member;
  if v_trip is null or not is_trip_owner(v_trip) then raise exception 'not_allowed'; end if;
  if v_user is not null then raise exception 'already_joined'; end if;
  delete from invites where member_id = p_member;
  v_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
  insert into invites(token, trip_id, member_id, expires_at) values (v_token, v_trip, p_member, now() + interval '7 days');
  return v_token;
end $$;

-- Shown on the "join" screen before accepting.
create function public.invite_info(p_token text) returns table(trip_name text, member_name text)
language sql stable security definer set search_path = public as $$
  select t.name, m.name from invites i join trips t on t.id = i.trip_id join trip_members m on m.id = i.member_id
  where i.token = p_token and i.expires_at > now() and auth.uid() is not null;
$$;

create function public.accept_invite(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare v_inv invites%rowtype;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select * into v_inv from invites where token = p_token for update;
  if not found then raise exception 'invite_not_found'; end if;
  if v_inv.expires_at <= now() then raise exception 'invite_expired'; end if;
  if exists (select 1 from trip_members where trip_id = v_inv.trip_id and user_id = auth.uid()) then raise exception 'already_member'; end if;
  update trip_members set user_id = auth.uid(), status = 'joined' where id = v_inv.member_id and user_id is null;
  if not found then raise exception 'invite_not_found'; end if;
  delete from invites where member_id = v_inv.member_id;
  return v_inv.trip_id;
end $$;

-- A joined member leaves; their slot becomes an unclaimed one again (past expenses keep their name). The owner cannot leave.
create function public.leave_trip(p_trip text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if is_trip_owner(p_trip) then raise exception 'owner_cannot_leave'; end if;
  update trip_members set user_id = null, status = 'invited' where trip_id = p_trip and user_id = auth.uid();
end $$;

revoke all on function public.create_invite(text), public.invite_info(text), public.accept_invite(text), public.leave_trip(text) from public, anon;
grant execute on function public.create_invite(text), public.invite_info(text), public.accept_invite(text), public.leave_trip(text) to authenticated;
revoke all on all tables in schema public from anon;

-- Realtime (Supabase): push changes to open clients; RLS still applies.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.trips, public.trip_members, public.expenses, public.paid, public.savings;
  end if;
end $$;
