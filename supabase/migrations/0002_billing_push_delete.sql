-- Phase 3: subscriptions (Stripe), free-plan limit, Web Push reminders, account deletion.

-- ---- subscriptions: written only by the Stripe webhook (service role); users may read their own row ----
create table public.subscriptions (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id      text not null unique,
  stripe_subscription_id  text unique,
  status                  text not null default 'incomplete',
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy subscriptions_own on public.subscriptions for select to authenticated using (user_id = auth.uid());

-- Premium while Stripe says the subscription is live and the paid period has not ended.
create function public.is_premium(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from subscriptions
    where user_id = p_user and status in ('active', 'trialing', 'past_due') and coalesce(current_period_end, now()) >= now());
$$;
revoke all on function public.is_premium(uuid) from public, anon;
grant execute on function public.is_premium(uuid) to authenticated;

-- Free plan: up to 3 trips you own. (Keep in sync with FREE_TRIP_LIMIT in index.html.)
-- A retried idempotent insert of an existing trip must not trip the limit, so skip when the row exists.
create function public.enforce_trip_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from trips where id = new.id) then return new; end if;
  if not is_premium(new.owner) and (select count(*) from trips where owner = new.owner) >= 3 then
    raise exception 'trip_limit';
  end if;
  return new;
end $$;
create trigger trips_limit before insert on public.trips for each row execute function public.enforce_trip_limit();

-- ---- Web Push ----
create table public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index push_subscriptions_user on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;   -- no policies: only the RPCs below touch it

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  insert into push_subscriptions(endpoint, user_id, p256dh, auth) values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth;   -- a shared device switches owner
end $$;
create function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;
revoke all on function public.save_push_subscription(text, text, text), public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text), public.remove_push_subscription(text) to authenticated;

create table public.notification_log (
  trip_id  text not null references public.trips(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  kind     text not null,
  day      date not null,
  primary key (trip_id, user_id, kind, day)
);
alter table public.notification_log enable row level security;

-- Called hourly by the send-reminders Edge Function (service role). Records what it hands out, so each
-- (trip, person, kind, day) is sent once even if the job runs again. Times are Japan time.
--   eve    : the evening (>=18h) before the trip starts
--   daily  : during the trip, from 20h, if nobody has logged an expense dated today
--   settle : the morning (>=10h) after the trip ends, if there were expenses
create function public.claim_notifications(p_now timestamptz default now())
returns table(user_id uuid, endpoint text, p256dh text, auth text, kind text, trip_id text, trip_name text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_today date := (p_now at time zone 'Asia/Tokyo')::date; v_hour int := extract(hour from (p_now at time zone 'Asia/Tokyo'));
begin
  return query
  with cand as (
    select m.user_id as uid, t.id as tid, 'eve'::text as k from trips t join trip_members m on m.trip_id = t.id
      where m.user_id is not null and v_hour >= 18 and t.start_date = v_today + 1
    union all
    select m.user_id, t.id, 'daily' from trips t join trip_members m on m.trip_id = t.id
      where m.user_id is not null and v_hour >= 20 and v_today between t.start_date and t.end_date
        and not exists (select 1 from expenses e where e.trip_id = t.id and e.spent_on = v_today)
    union all
    select m.user_id, t.id, 'settle' from trips t join trip_members m on m.trip_id = t.id
      where m.user_id is not null and v_hour >= 10 and t.end_date = v_today - 1
        and exists (select 1 from expenses e where e.trip_id = t.id)
  ), eligible as (
    select distinct c.uid, c.tid, c.k from cand c where exists (select 1 from push_subscriptions s where s.user_id = c.uid)
  ), ins as (
    insert into notification_log(trip_id, user_id, kind, day) select tid, uid, k, v_today from eligible
    on conflict do nothing returning notification_log.user_id as uid, notification_log.trip_id as tid, notification_log.kind as k
  )
  select i.uid, s.endpoint, s.p256dh, s.auth, i.k, i.tid, (select name from trips where id = i.tid)
  from ins i join push_subscriptions s on s.user_id = i.uid;
end $$;
revoke all on function public.claim_notifications(timestamptz) from public, anon, authenticated;
grant execute on function public.claim_notifications(timestamptz) to service_role;

-- A push service said the endpoint is gone (404/410).
create function public.drop_push_endpoint(p_endpoint text) returns void
language sql security definer set search_path = public as $$ delete from push_subscriptions where endpoint = p_endpoint; $$;
revoke all on function public.drop_push_endpoint(text) from public, anon, authenticated;
grant execute on function public.drop_push_endpoint(text) to service_role;

-- ---- account deletion ----
-- Trips you own pass to the earliest-joined other member; with nobody else, they are deleted.
-- Your slots in other trips become unclaimed names again (past expenses keep the name). Needs any
-- subscription to be cancelled first, so nobody is billed for an account that no longer exists.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); r record; v_next uuid;
begin
  if v_me is null then raise exception 'not_signed_in'; end if;
  if exists (select 1 from subscriptions where user_id = v_me and status in ('active', 'trialing', 'past_due') and not cancel_at_period_end) then
    raise exception 'subscription_active';
  end if;
  for r in select id from trips where owner = v_me loop
    select user_id into v_next from trip_members where trip_id = r.id and user_id is not null and user_id <> v_me order by position, id limit 1;
    if v_next is null then delete from trips where id = r.id; else update trips set owner = v_next where id = r.id; end if;
  end loop;
  update trip_members set user_id = null, status = 'invited' where user_id = v_me;
  delete from invites where created_by = v_me;
  delete from auth.users where id = v_me;   -- cascades to push_subscriptions, notification_log, subscriptions
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
