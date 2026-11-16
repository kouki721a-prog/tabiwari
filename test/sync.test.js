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

// member rows never change except their 受け取り方のメモ (joined members' names are protected server-side)
t = trip(); t.members[0].name = 'x'; assert.strictEqual(S.diff(snap, S.flatten([t])).length, 0);
t = trip(); t.members[0].userId = 'U9'; assert.strictEqual(S.diff(snap, S.flatten([t])).length, 0, 'logging in changes no member row');
t = trip(); t.members[0].note = 'PayPay：aoi'; ops = S.diff(snap, S.flatten([t]));
assert.deepStrictEqual(ops.map(o => o.table + ':' + o.kind), ['members:update']); assert.strictEqual(ops[0].row.note, 'PayPay：aoi'); assert.strictEqual(ops[0].row.id, 'a');
const withNote = S.flatten([t]); t = trip(); ops = S.diff(withNote, S.flatten([t]));
assert.deepStrictEqual(ops.map(o => o.table + ':' + o.kind), ['members:update']); assert.strictEqual(ops[0].row.note, '', 'taking the memo away sends an empty one');
assert.strictEqual(S.diff(S.flatten([trip()]), S.flatten([trip()])).length, 0, 'no memo, no change');
assert.strictEqual(S.assemble([{ id: 't', name: 'n', start_date: '2026-11-09', end_date: '2026-11-10', budget: 1, trip_members: [{ id: 'a', name: 'あおい', position: 0, note: '現金', user_id: null, status: 'joined' }] }])[0].members[0].note, '現金');

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
{
  // weights per person: written only when set (old rows stay equal), sent as an update, taken away with an explicit null, read back from the server
  const t0 = { id: 't1', name: '箱根', start: '2026-11-09', end: '2026-11-11', budget: 80000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }], paid: {}, savings: {}, settlements: [], adjustments: [],
    expenses: [{ id: 'e1', title: '夕食', amount: 3000, payer: 'a', cat: 'food', date: '2026-11-09', split: ['a', 'b'] }] };
  const f0 = S.flatten([t0]); assert.ok(!('parts' in f0.expenses.e1), 'no weights: no key, so rows saved before weights existed stay equal');
  const t1 = JSON.parse(JSON.stringify(t0)); t1.expenses[0].parts = { a: 2, b: 1 };
  const up = S.diff(f0, S.flatten([t1])); assert.deepStrictEqual(up.map(o => [o.kind, o.table]), [['update', 'expenses']]); assert.deepStrictEqual(up[0].row.parts, { a: 2, b: 1 });
  const down = S.diff(S.flatten([t1]), f0); assert.strictEqual(down.length, 1); assert.strictEqual(down[0].row.parts, null, 'taken away: an explicit null (a missing key means "leave it" to the server)');
  assert.strictEqual(S.diff(S.flatten([t1]), S.flatten([t1])).length, 0);
  const srv = [{ id: 't1', name: '箱根', start_date: '2026-11-09', end_date: '2026-11-11', budget: 80000, owner: null, trip_members: [{ id: 'a', name: 'あおい', position: 0, user_id: null, status: 'joined' }, { id: 'b', name: 'けんた', position: 1, user_id: null, status: 'joined' }],
    expenses: [{ id: 'e1', title: '夕食', amount: 3000, payer: 'a', cat: 'food', spent_on: '2026-11-09', split: ['a', 'b'], settle_id: null, parts: { a: 2, b: 1 }, created_at: 1 }, { id: 'e2', title: '', amount: 100, payer: 'a', cat: 'food', spent_on: '2026-11-09', split: ['a'], settle_id: null, parts: null, created_at: 2 }], settlements: [], adjustments: [], paid: [], savings: [] }];
  const back = S.assemble(srv)[0]; assert.deepStrictEqual(back.expenses[0].parts, { a: 2, b: 1 }); assert.ok(!('parts' in back.expenses[1]));
  assert.strictEqual(S.diff(S.flatten([back]), S.flatten(S.assemble(srv))).length, 0, 'no phantom diff after a refresh');
  console.log('sync weights tests passed');
}

// 金額の指定: rows carry `fixed` only when set; taking it away is an explicit null
{ const t0 = { id: 't', name: 'n', start: '2026-11-09', end: '2026-11-10', budget: 1, paid: {}, savings: {}, members: [{ id: 'a', name: 'あ' }, { id: 'b', name: 'い' }],
    expenses: [{ id: 'e1', title: 'x', amount: 3000, payer: 'a', cat: 'food', date: '2026-11-09', split: ['a', 'b'] }] };
  const f0 = S.flatten([t0]); assert.ok(!('fixed' in f0.expenses.e1), 'no fixed amounts: no key');
  const t1 = JSON.parse(JSON.stringify(t0)); t1.expenses[0].fixed = { b: 500 };
  const up = S.diff(f0, S.flatten([t1])); assert.deepStrictEqual(up.map(o => [o.kind, o.table]), [['update', 'expenses']]); assert.deepStrictEqual(up[0].row.fixed, { b: 500 });
  const down = S.diff(S.flatten([t1]), f0); assert.strictEqual(down.length, 1); assert.strictEqual(down[0].row.fixed, null, 'taken away: an explicit null');
  const both = JSON.parse(JSON.stringify(t1)); both.expenses[0].parts = { a: 2, b: 1 }; const d2 = S.diff(S.flatten([both]), f0); assert.deepStrictEqual([d2[0].row.fixed, d2[0].row.parts], [null, null]);
  const rows = [{ id: 't', name: 'n', start_date: '2026-11-09', end_date: '2026-11-10', budget: 1, owner: null, trip_members: [{ id: 'a', name: 'あ', position: 0, user_id: null, status: 'joined' }, { id: 'b', name: 'い', position: 1, user_id: null, status: 'joined' }],
    expenses: [{ id: 'e1', title: 'x', amount: 3000, payer: 'a', cat: 'food', spent_on: '2026-11-09', split: ['a', 'b'], settle_id: null, parts: null, fixed: { b: 500 }, created_at: 1 }], settlements: [], adjustments: [], paid: [], savings: [] }];
  assert.deepStrictEqual(S.assemble(rows)[0].expenses[0].fixed, { b: 500 });
  console.log('sync fixed amount tests passed'); }
