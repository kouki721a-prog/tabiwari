-- Run after stub.sql + migrations. Raises on the first failed expectation.
\set ON_ERROR_STOP on
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', case when u = 'anon' then '' else '00000000-0000-0000-0000-00000000000' || u end, false);
end $$;
create function pg_temp.fails(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
create function pg_temp.ok(c boolean, msg text) returns void language plpgsql as $$ begin if not c then raise exception 'FAILED: %', msg; end if; end $$;
create function pg_temp.n(q text) returns bigint language plpgsql as $$ declare r bigint; begin execute q into r; return r; end $$;

set role authenticated;
-- Alice (a) creates a trip with herself + an unclaimed slot, adds expenses.
select pg_temp.as_user('a');
insert into trips(id, name, start_date, end_date, budget) values ('t1', '箱根', '2026-11-09', '2026-11-11', 80000);
insert into trip_members(id, trip_id, user_id, name, status, position) values ('m1', 't1', '00000000-0000-0000-0000-00000000000a', 'あおい', 'joined', 0);
insert into trip_members(id, trip_id, name, position) values ('m2', 't1', 'けんた', 1);
insert into expenses(id, trip_id, title, amount, payer, cat, spent_on, split) values ('e1', 't1', '新幹線', 9600, 'm1', 'transport', '2026-11-09', '{m1,m2}');
insert into paid values ('t1', 'm2-m1-4800');
insert into savings values ('t1', 'm1', 20000);
select pg_temp.ok(pg_temp.n('select count(*) from expenses') = 1, 'owner sees expense');

-- Cannot create a trip in someone else's name, nor claim another user in a member row.
select pg_temp.ok(pg_temp.fails($$insert into trips(id,name,start_date,end_date,budget,owner) values ('tx','x','2026-01-01','2026-01-02',1,'00000000-0000-0000-0000-00000000000b')$$), 'cannot spoof owner');
select pg_temp.ok(pg_temp.fails($$insert into trip_members(id,trip_id,user_id,name,status) values ('mx','t1','00000000-0000-0000-0000-00000000000b','x','joined')$$), 'cannot add joined user directly');
-- Owner cannot be reassigned.
select pg_temp.ok(pg_temp.fails($$update trips set owner = '00000000-0000-0000-0000-00000000000b' where id='t1'$$), 'owner immutable');

-- Outsiders (c) and anon see and change nothing.
select pg_temp.as_user('c');
select pg_temp.ok(pg_temp.n('select count(*) from trips') = 0, 'outsider sees no trips');
select pg_temp.ok(pg_temp.n('select count(*) from expenses') = 0, 'outsider sees no expenses');
select pg_temp.ok(pg_temp.fails($$insert into expenses(id,trip_id,amount,payer,cat,spent_on,split) values ('ex','t1',1,'m1','food','2026-11-09','{m1}')$$), 'outsider cannot write expense');
select pg_temp.ok(pg_temp.n($$with d as (delete from trips where id='t1' returning 1) select count(*) from d$$) = 0, 'outsider cannot delete trip');
select pg_temp.ok(pg_temp.fails($$select accept_invite('nope')$$), 'bad token rejected');
select pg_temp.ok(pg_temp.fails($$select create_invite('m2')$$), 'outsider cannot invite');
reset role; set role anon;
select pg_temp.ok(pg_temp.fails($$select count(*) from trips$$), 'anon has no table access');
select pg_temp.ok(pg_temp.fails($$select accept_invite('x')$$), 'anon cannot call rpc');
reset role; set role authenticated;

-- Invite flow: Alice issues a link for Kenta's slot; Bob (b) accepts.
select pg_temp.as_user('a');
create temp table tok as select create_invite('m2') as t;
grant all on tok to authenticated;
select pg_temp.ok((select length(t) from tok) >= 30, 'token is long');
select pg_temp.ok(pg_temp.n($$select count(*) from invites$$) = 1, 'owner sees invite');
create temp table tok2 as select create_invite('m2') as t;  -- reissue replaces the old one
select pg_temp.ok(pg_temp.n($$select count(*) from invites$$) = 1, 'reissue replaces old link');
select pg_temp.as_user('b');
select pg_temp.ok(pg_temp.n($$select count(*) from invites$$) = 0, 'non-owner cannot read tokens');
select pg_temp.ok(pg_temp.fails(format('select accept_invite(%L)', (select t from tok))), 'old token dead');
select pg_temp.ok((select count(*) from invite_info((select t from tok2))) = 1, 'invite_info works');
select accept_invite((select t from tok2));
select pg_temp.ok(pg_temp.n('select count(*) from expenses') = 1, 'member sees expenses after joining');
select pg_temp.ok(pg_temp.n($$select count(*) from trip_members where status='joined'$$) = 2, 'slot joined');
select pg_temp.ok(pg_temp.fails(format('select accept_invite(%L)', (select t from tok2))), 'token is single-use');
-- Members can edit shared data but not delete the trip or the joined people.
insert into expenses(id, trip_id, amount, payer, cat, spent_on, split) values ('e2', 't1', 3000, 'm2', 'food', '2026-11-09', '{m1,m2}');
update trips set budget = 90000 where id = 't1';
select pg_temp.ok(pg_temp.n($$with d as (delete from trips where id='t1' returning 1) select count(*) from d$$) = 0, 'member cannot delete trip');
select pg_temp.ok(pg_temp.n($$with d as (delete from trip_members where id='m1' returning 1) select count(*) from d$$) = 0, 'cannot remove joined member');
select pg_temp.ok(pg_temp.n($$with u as (update trip_members set user_id = null, status='invited' where id='m2' returning 1) select count(*) from u$$) = 0, 'cannot unjoin via table');
select leave_trip('t1');
select pg_temp.ok(pg_temp.n($$select count(*) from trips$$) = 0, 'left member sees nothing');
select pg_temp.as_user('a');
select pg_temp.ok(pg_temp.fails($$select leave_trip('t1')$$), 'owner cannot leave');
select pg_temp.ok(pg_temp.n($$select count(*) from trip_members where user_id is null$$) = 1, 'slot is unclaimed again');
-- Expired invite.
create temp table tok3 as select create_invite('m2') as t; grant all on tok3 to authenticated;
reset role; update invites set expires_at = now() - interval '1 minute'; set role authenticated;
select pg_temp.as_user('c');
select pg_temp.ok(pg_temp.fails(format('select accept_invite(%L)', (select t from tok3))), 'expired invite rejected');
-- Owner deletes trip: everything cascades.
select pg_temp.as_user('a');
delete from trips where id = 't1';
reset role;
select pg_temp.ok((select count(*) from expenses) + (select count(*) from trip_members) + (select count(*) from invites) + (select count(*) from paid) + (select count(*) from savings) = 0, 'cascade delete');
\echo RLS tests passed
