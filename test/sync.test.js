const assert = require('assert'), S = require('../sync.js');
const trip = () => ({ id: 't1', name: '箱根', start: '2026-11-09', end: '2026-11-11', budget: 80000, paid: { 'b-a-100': true }, savings: { a: 5000 },
  members: [{ id: 'a', name: 'あおい', userId: 'U1' }, { id: 'b', name: 'けんた', pending: true }],
  expenses: [{ id: 'e1', title: '新幹線', amount: 9600, payer: 'a', cat: 'transport', date: '2026-11-09', split: ['a', 'b'] }] });

// new trip: inserts only, parents before children, owner's own row carries user_id
let ops = S.diff(null, S.flatten([trip()]));
assert.deepStrictEqual(ops.map(o => o.table + ':' + o.kind), ['trips:insert', 'members:insert', 'expenses:insert', 'paid:insert', 'savings:insert']);
const mem = ops[1].rows; assert.strictEqual(mem[0].user_id, 'U1'); assert.strictEqual(mem[0].status, 'joined');
assert.strictEqual(mem[1].user_id, null); assert.strictEqual(mem[1].status, 'invited'); assert.strictEqual(mem[1].position, 1);

// unchanged -> nothing to send
const snap = S.flatten([trip()]);
assert.strictEqual(S.diff(snap, S.flatten([trip()])).length, 0);

// editing an expense and savings -> two updates; toggling paid -> delete + insert
let t = trip(); t.expenses[0].amount = 10000; t.savings.a = 6000; t.paid = { 'b-a-100': false, 'a-b-5': true };
ops = S.diff(snap, S.flatten([t]));
assert.deepStrictEqual(ops.map(o => o.table + ':' + o.kind), ['paid:insert', 'expenses:update', 'savings:update', 'paid:delete']);

// removing an unclaimed member + its expense: children deleted before parents
t = trip(); t.members.pop(); t.expenses = []; t.paid = {};
ops = S.diff(snap, S.flatten([t]));
assert.deepStrictEqual(ops.map(o => o.table), ['paid', 'expenses', 'members']);

// deleting a trip: just the trip row (rest cascades)
ops = S.diff(snap, S.flatten([]));
assert.deepStrictEqual(ops.map(o => o.table + ':' + o.kind), ['trips:delete']);

// member rows are never "updated" (joined members are protected server-side)
t = trip(); t.members[0].name = 'x'; assert.strictEqual(S.diff(snap, S.flatten([t])).length, 0);

// server rows -> app state -> same rows again (no phantom diff after a refresh)
const rows = [{ id: 't1', name: '箱根', start_date: '2026-11-09', end_date: '2026-11-11', budget: 80000, owner: 'U1',
  trip_members: [{ id: 'b', name: 'けんた', position: 1, user_id: null, status: 'invited' }, { id: 'a', name: 'あおい', position: 0, user_id: 'U1', status: 'joined' }],
  expenses: [{ id: 'e2', title: '', amount: 1, payer: 'a', cat: 'food', spent_on: '2026-11-10', split: ['a'], created_at: '2026-11-09T10:00:00Z' },
             { id: 'e1', title: '新幹線', amount: 9600, payer: 'a', cat: 'transport', spent_on: '2026-11-09', split: ['a', 'b'], created_at: '2026-11-09T09:00:00Z' }],
  paid: [{ trip_id: 't1', key: 'b-a-100' }], savings: [{ trip_id: 't1', member_id: 'a', amount: 5000 }] }];
const st = S.assemble(rows);
assert.deepStrictEqual(st[0].members.map(m => m.id), ['a', 'b']);
assert.deepStrictEqual(st[0].expenses.map(e => e.id), ['e1', 'e2']);
assert.strictEqual(st[0].members[1].pending, true); assert.strictEqual(st[0].members[0].pending, false);
assert.strictEqual(S.diff(S.flatten(st), S.flatten(S.assemble(rows))).length, 0);

// rounds of settlement: confirming = one settlement row + the expenses' settle_id (+ adjustments' settle_id), inserts before updates
{
  const base = trip(); base.settlements = []; base.adjustments = [{ id: 'j1', settleId: null, nets: { a: 100, b: -100 }, note: '「新幹線」の変更', at: '2026-11-10' }];
  const snap0 = S.flatten([base]);
  const done = JSON.parse(JSON.stringify(base)); done.settlements = [{ id: 'r1', n: 1, at: '2026-11-10', total: 9600, transfers: [{ from: 'b', to: 'a', amount: 4800 }] }];
  done.expenses.forEach(e => { e.settleId = 'r1'; }); done.adjustments[0].settleId = 'r1';
  const ops2 = S.diff(snap0, S.flatten([done]));
  assert.deepStrictEqual(ops2.map(o => o.table + ':' + o.kind), ['settlements:insert', 'expenses:update', 'adjustments:update']);
  assert.strictEqual(ops2[0].rows[0].transfers[0].amount, 4800); assert.strictEqual(ops2[1].row.settle_id, 'r1'); assert.strictEqual(ops2[2].row.settle_id, 'r1');
  // a brand-new trip with an adjustment sends the adjustment after the expenses
  assert.deepStrictEqual(S.diff(null, snap0).map(o => o.table), ['trips', 'members', 'expenses', 'adjustments', 'paid', 'savings']);
  // server rows -> app state -> same rows (no phantom diff after a refresh)
  const srv = [{ id: 't1', name: '箱根', start_date: '2026-11-09', end_date: '2026-11-11', budget: 80000, owner: null,
    trip_members: [{ id: 'a', name: 'あおい', position: 0, user_id: null, status: 'joined' }, { id: 'b', name: 'けんた', position: 1, user_id: null, status: 'joined' }],
    expenses: [{ id: 'e1', title: '新幹線', amount: 9600, payer: 'a', cat: 'transport', spent_on: '2026-11-09', split: ['a', 'b'], settle_id: 'r1', created_at: 1 }, { id: 'e2', title: '', amount: 1, payer: 'a', cat: 'food', spent_on: '2026-11-10', split: ['a'], settle_id: null, created_at: 2 }],
    settlements: [{ id: 'r2', n: 2, at: '2026-11-12', total: 1, transfers: [] }, { id: 'r1', n: 1, at: '2026-11-10', total: 9600, transfers: [{ from: 'b', to: 'a', amount: 4800 }] }],
    adjustments: [{ id: 'j1', settle_id: 'r1', nets: { a: 100, b: -100 }, note: 'x', at: '2026-11-10' }], paid: [], savings: [] }];
  const st2 = S.assemble(srv)[0];
  assert.deepStrictEqual(st2.settlements.map(x => x.id), ['r1', 'r2'], 'rounds come back in order'); assert.strictEqual(st2.expenses[0].settleId, 'r1'); assert.strictEqual(st2.expenses[1].settleId, undefined);
  assert.strictEqual(S.diff(S.flatten([st2]), S.flatten(S.assemble(srv))).length, 0);
}
console.log('sync tests passed');
