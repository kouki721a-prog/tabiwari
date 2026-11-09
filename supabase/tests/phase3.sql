\set ON_ERROR_STOP on
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', case when u = 'anon' then '' else '00000000-0000-0000-0000-00000000000' || u end, false); end $$;
create function pg_temp.fails(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
create function pg_temp.ok(c boolean, msg text) returns void language plpgsql as $$ begin if not c then raise exception 'FAILED: %', msg; end if; end $$;
create function pg_temp.n(q text) returns bigint language plpgsql as $$ declare r bigint; begin execute q into r; return r; end $$;
create function pg_temp.mk(tid text, u text, s date, e date) returns void language plpgsql as $$ begin
  insert into trips(id, name, start_date, end_date, budget) values (tid, 'T-' || tid, s, e, 1000);
  insert into trip_members(id, trip_id, user_id, name, status, position) values (tid || 'm', tid, ('00000000-0000-0000-0000-00000000000' || u)::uuid, 'u' || u, 'joined', 0); end $$;
grant all on all functions in schema pg_temp to public;

set role authenticated;
-- ===== free plan limit =====
select pg_temp.as_user('a');
select pg_temp.mk('p1', 'a', '2030-01-01', '2030-01-02'), pg_temp.mk('p2', 'a', '2030-01-01', '2030-01-02'), pg_temp.mk('p3', 'a', '2030-01-01', '2030-01-02');
select pg_temp.ok(pg_temp.fails($$insert into trips(id,name,start_date,end_date,budget) values ('p4','x','2030-01-01','2030-01-02',1)$$), '4th trip refused on free plan');
select pg_temp.ok(not pg_temp.fails($$insert into trips(id,name,start_date,end_date,budget) values ('p3','x','2030-01-01','2030-01-02',1) on conflict do nothing$$), 'retry of an existing trip is not blocked');
select pg_temp.ok(not pg_temp.n('select count(*) from subscriptions') > 0, 'no subscription rows visible yet');
select pg_temp.ok(not (select is_premium('00000000-0000-0000-0000-00000000000a')), 'free user is not premium');
reset role;
insert into subscriptions(user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
  values ('00000000-0000-0000-0000-00000000000a', 'cus_a', 'sub_a', 'active', now() + interval '10 days');
set role authenticated; select pg_temp.as_user('a');
select pg_temp.ok(not pg_temp.fails($$insert into trips(id,name,start_date,end_date,budget) values ('p4','x','2030-01-01','2030-01-02',1)$$), 'premium can exceed the limit');
select pg_temp.ok(pg_temp.n('select count(*) from subscriptions') = 1, 'sees own subscription');
select pg_temp.as_user('b'); select pg_temp.ok(pg_temp.n('select count(*) from subscriptions') = 0, 'cannot see others subscription');
select pg_temp.ok(pg_temp.fails($$insert into subscriptions(user_id,stripe_customer_id,status) values ('00000000-0000-0000-0000-00000000000b','c','active')$$), 'users cannot grant themselves premium');
reset role; update subscriptions set current_period_end = now() - interval '1 day'; set role authenticated;
select pg_temp.as_user('a'); select pg_temp.ok(not (select is_premium('00000000-0000-0000-0000-00000000000a')), 'expired period is not premium');
select pg_temp.ok(pg_temp.fails($$insert into trips(id,name,start_date,end_date,budget) values ('p5','x','2030-01-01','2030-01-02',1)$$), 'limit applies again after lapse');
reset role; delete from trips; delete from subscriptions; set role authenticated;

-- ===== push subscriptions =====
select pg_temp.as_user('a'); select save_push_subscription('https://push/e1', 'k1', 'a1');
select pg_temp.ok(pg_temp.n('select count(*) from push_subscriptions') = 0, 'clients cannot read the table');
select pg_temp.as_user('b'); select save_push_subscription('https://push/e1', 'k2', 'a2');           -- same device, new owner
select remove_push_subscription('https://push/zzz');
reset role; select pg_temp.ok((select user_id from push_subscriptions where endpoint = 'https://push/e1') = '00000000-0000-0000-0000-00000000000b', 'device switches owner');
set role anon; select pg_temp.ok(pg_temp.fails($$select save_push_subscription('x','y','z')$$), 'anon cannot subscribe'); reset role;

-- ===== reminders (Asia/Tokyo) =====
-- trip R: 11/10-11/12 owned by a, b joined. both have a subscription.
set role authenticated; select pg_temp.as_user('a'); select pg_temp.mk('R', 'a', '2026-11-10', '2026-11-12'); select save_push_subscription('https://push/a', 'ka', 'aa');
reset role; insert into trip_members(id, trip_id, user_id, name, status, position) values ('Rb', 'R', '00000000-0000-0000-0000-00000000000b', 'b', 'joined', 1);
select pg_temp.ok(not exists (select 1 from claim_notifications('2026-11-09 08:59:00+00')), 'before 18:00 JST: no eve notice');   -- 17:59 JST
select pg_temp.ok((select count(*) from claim_notifications('2026-11-09 09:00:00+00')) = 2, 'eve: both members (a and b), 18:00 JST');
select pg_temp.ok(not exists (select 1 from claim_notifications('2026-11-09 10:00:00+00')), 'eve is sent once');
select pg_temp.ok((select count(*) from claim_notifications('2026-11-10 11:00:00+00') where kind = 'daily') = 2, 'daily: no expense today, 20:00 JST');
select pg_temp.ok(not exists (select 1 from claim_notifications('2026-11-10 12:00:00+00')), 'daily is sent once');
insert into expenses(id, trip_id, amount, payer, cat, spent_on, split) values ('x1', 'R', 100, 'Rm', 'food', '2026-11-11', '{Rm}');
select pg_temp.ok(not exists (select 1 from claim_notifications('2026-11-11 12:00:00+00')), 'daily skipped when an expense is logged today');
select pg_temp.ok((select count(*) from claim_notifications('2026-11-13 01:00:00+00') where kind = 'settle') = 2, 'settle: morning after the trip ends (10:00 JST)');
select pg_temp.ok(not exists (select 1 from claim_notifications('2026-11-14 01:00:00+00')), 'nothing two days after');
select pg_temp.ok((select count(*) from claim_notifications('2026-11-09 23:30:00+00')) = 0, 'nothing for a trip that already started/ended wrongly');
set role authenticated; select pg_temp.ok(pg_temp.fails($$select * from claim_notifications()$$), 'clients cannot claim'); reset role;
delete from trips; delete from push_subscriptions;

-- ===== account deletion =====
set role authenticated; select pg_temp.as_user('a');
select pg_temp.mk('D1', 'a', '2030-01-01', '2030-01-02'); select pg_temp.mk('D2', 'a', '2030-01-01', '2030-01-02');   -- D1 shared with b, D2 solo
reset role; insert into trip_members(id, trip_id, user_id, name, status, position) values ('D1b', 'D1', '00000000-0000-0000-0000-00000000000b', 'b', 'joined', 1);
insert into expenses(id, trip_id, amount, payer, cat, spent_on, split) values ('dx', 'D1', 100, 'D1m', 'food', '2030-01-01', '{D1m,D1b}');
insert into subscriptions(user_id, stripe_customer_id, status, current_period_end) values ('00000000-0000-0000-0000-00000000000a', 'cus_a', 'active', now() + interval '5 days');
set role authenticated; select pg_temp.as_user('a');
select pg_temp.ok(pg_temp.fails($$select delete_my_account()$$), 'blocked while a subscription is live');
reset role; update subscriptions set cancel_at_period_end = true; set role authenticated; select pg_temp.as_user('a');
select delete_my_account();
reset role;
select pg_temp.ok(not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000000a'), 'user removed');
select pg_temp.ok((select owner from trips where id = 'D1') = '00000000-0000-0000-0000-00000000000b', 'shared trip passed to b');
select pg_temp.ok(not exists (select 1 from trips where id = 'D2'), 'solo trip deleted');
select pg_temp.ok((select status from trip_members where id = 'D1m') = 'invited', 'slot is an unclaimed name again');
select pg_temp.ok((select count(*) from expenses where id = 'dx') = 1, 'expenses stay');
\echo phase3 tests passed
