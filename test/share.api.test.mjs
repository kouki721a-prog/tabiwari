/* API tests for worker/index.js against a real local Worker + D1.   node test/share.api.test.mjs */
import assert from 'node:assert';
import { startServer } from './wrangler-dev.mjs';

const srv = await startServer(8788);
const B = srv.base;
const tok = (c = 'a') => (c.repeat(8) + Math.random().toString(36).slice(2) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345').slice(0, 40).replace(/[^A-Za-z0-9]/g, 'x');
const call = async (t, method, p, body) => {
  const r = await fetch(B + p, { method, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ops = (t, list) => call(t, 'POST', '/api/ops', { ops: list });
const trip = { id: 'x', name: '箱根', start_date: '2026-11-09', end_date: '2026-11-11', budget: 50000 };
const mem = (id, name, position) => ({ id, name, position });
const exp = (id, o = {}) => ({ id, title: '夕食', amount: 3000, payer: 'm1', cat: 'food', spent_on: '2026-11-09', split: ['m1', 'm2'], ...o });
const make = async (t = tok()) => {
  const r = await ops(t, [{ kind: 'insert', table: 'trips', rows: [trip] }, { kind: 'insert', table: 'members', rows: [mem('m1', 'あおい', 0), mem('m2', 'けんた', 1)] },
    { kind: 'insert', table: 'expenses', rows: [exp('e1'), exp('e2', { title: '', amount: 500, payer: 'm2', cat: 'other', split: ['m2'] })] }]);
  assert.strictEqual(r.status, 200); return t;
};

try {
  // --- no token / malformed token
  assert.strictEqual((await call(null, 'GET', '/api/trip')).status, 401);
  assert.strictEqual((await call('short', 'GET', '/api/trip')).status, 401);
  assert.strictEqual((await call('bad token with spaces and symbols !!!!!!!!!!', 'GET', '/api/trip')).status, 401);
  assert.strictEqual((await call(tok(), 'GET', '/api/nothing')).status, 404);

  // --- create, read back (order, shape)
  const A = await make();
  let g = await call(A, 'GET', '/api/trip');
  assert.strictEqual(g.status, 200);
  assert.deepStrictEqual(g.body.trip.trip_members.map(m => m.name), ['あおい', 'けんた']);
  assert.deepStrictEqual(g.body.trip.expenses.map(e => e.id), ['e1', 'e2'], 'insertion order kept');
  assert.deepStrictEqual(g.body.trip.expenses[1].split, ['m2'], 'split comes back as an array');
  assert.strictEqual(g.body.trip.id.length, 64, 'trip id is the token hash, not the token');
  assert.ok(!JSON.stringify(g.body).includes(A), 'the token is never echoed back');
  const rev0 = g.body.rev;

  // --- unchanged short-circuit
  assert.strictEqual((await call(A, 'GET', '/api/trip?rev=' + rev0)).body.unchanged, true);

  // --- isolation: another token sees nothing and can change nothing
  const Z = tok('z');
  assert.strictEqual((await call(Z, 'GET', '/api/trip')).status, 404);
  assert.strictEqual((await ops(Z, [{ kind: 'insert', table: 'expenses', rows: [exp('evil')] }])).status, 404, 'cannot write to a trip that does not exist for this token');
  assert.strictEqual((await call(A, 'GET', '/api/trip')).body.trip.expenses.length, 2);

  // --- idempotent insert (a retry after a partial failure)
  assert.strictEqual((await ops(A, [{ kind: 'insert', table: 'expenses', rows: [exp('e1')] }])).status, 200);
  assert.strictEqual((await call(A, 'GET', '/api/trip')).body.trip.expenses.length, 2, 'no duplicate');

  // --- update / delete
  let r = await ops(A, [{ kind: 'update', table: 'expenses', row: exp('e1', { amount: 3600, title: '夕食 2軒目' }) },
    { kind: 'update', table: 'trips', row: { ...trip, name: '箱根 2泊', budget: 60000 } },
    { kind: 'insert', table: 'savings', rows: [{ member_id: 'm1', amount: 5000 }] }, { kind: 'insert', table: 'paid', rows: [{ key: 'm2-m1-1800' }] }]);
  assert.strictEqual(r.status, 200);
  g = await call(A, 'GET', '/api/trip');
  assert.deepStrictEqual([g.body.trip.name, g.body.trip.budget, g.body.trip.expenses[0].amount, g.body.trip.expenses[0].title], ['箱根 2泊', 60000, 3600, '夕食 2軒目']);
  assert.deepStrictEqual(g.body.trip.savings, [{ trip_id: g.body.trip.id, member_id: 'm1', amount: 5000 }]);
  assert.strictEqual(g.body.trip.paid.length, 1);
  assert.ok(g.body.rev > rev0, 'revision moves on every change');
  r = await ops(A, [{ kind: 'update', table: 'savings', row: { member_id: 'm1', amount: 7000 } }, { kind: 'delete', table: 'paid', row: { key: 'm2-m1-1800' } },
    { kind: 'delete', table: 'expenses', row: { id: 'e2' } }, { kind: 'delete', table: 'members', row: { id: 'm2' } }]);
  assert.strictEqual(r.status, 200);
  g = await call(A, 'GET', '/api/trip');
  assert.deepStrictEqual([g.body.trip.expenses.length, g.body.trip.trip_members.length, g.body.trip.paid.length, g.body.trip.savings[0].amount], [1, 1, 0, 7000]);

  // --- validation: one bad row rejects the whole request, nothing is applied
  const before = (await call(A, 'GET', '/api/trip')).body;
  for (const bad of [
    exp('e9', { cat: 'drugs' }), exp('e9', { amount: 0 }), exp('e9', { amount: 1.5 }), exp('e9', { split: [] }), exp('e9', { spent_on: '2026-13-45' }),
    exp('e9', { id: 'has space' }), exp('e9', { title: 'x'.repeat(101) }), exp('e9', { split: Array(13).fill('m1') }), { ...exp('e9'), amount: '3000' }
  ]) {
    const x = await ops(A, [{ kind: 'insert', table: 'members', rows: [mem('m9', 'ほか', 9)] }, { kind: 'insert', table: 'expenses', rows: [bad] }]);
    assert.strictEqual(x.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await ops(A, [{ kind: 'insert', table: 'users', rows: [{}] }])).status, 400, 'unknown table');
  assert.strictEqual((await ops(A, [{ kind: 'update', table: 'members', row: mem('m1', 'x', 0) }])).status, 400, 'members are not updatable');
  assert.strictEqual((await ops(A, [])).status, 400); assert.strictEqual((await call(A, 'POST', '/api/ops', { ops: 'nope' })).status, 400);
  const after = (await call(A, 'GET', '/api/trip')).body;
  assert.strictEqual(after.rev, before.rev, 'rejected requests change nothing'); assert.deepStrictEqual(after.trip.trip_members, before.trip.trip_members);

  // --- the trip id in the body never decides which trip is written (the token does)
  const Y = await make(tok('y'));
  await ops(Y, [{ kind: 'insert', table: 'expenses', rows: [exp('yy')] }]);
  assert.strictEqual((await call(A, 'GET', '/api/trip')).body.trip.expenses.some(e => e.id === 'yy'), false, 'no leakage between trips');
  assert.strictEqual((await call(Y, 'GET', '/api/trip')).body.trip.expenses.some(e => e.id === 'yy'), true);

  // --- same row ids in two trips do not collide
  assert.strictEqual((await call(A, 'GET', '/api/trip')).body.trip.expenses[0].id, 'e1'); assert.ok((await call(Y, 'GET', '/api/trip')).body.trip.expenses.some(e => e.id === 'e1'));

  // --- size limits
  const L = tok('l'); await make(L);
  const many = Array.from({ length: 11 }, (_, i) => mem('n' + i, 'N' + i, 10 + i));
  assert.strictEqual((await ops(L, [{ kind: 'insert', table: 'members', rows: many }])).status, 413, 'more than 12 members');
  assert.strictEqual((await call(L, 'POST', '/api/ops', { ops: [{ kind: 'insert', table: 'expenses', rows: [exp('big', { title: 'x'.repeat(100) })] }], pad: 'x'.repeat(300000) })).status, 413, 'oversized body');

  // --- whitespace-only names are refused; names are stored literally (no markup interpretation server-side)
  assert.strictEqual((await ops(L, [{ kind: 'insert', table: 'members', rows: [mem('w', '   ', 30)] }])).status, 400);
  await ops(L, [{ kind: 'insert', table: 'members', rows: [mem('xss', '<img src=x onerror=alert(1)>', 31)] }]);
  assert.ok((await call(L, 'GET', '/api/trip')).body.trip.trip_members.some(m => m.name === '<img src=x onerror=alert(1)>'));

  // --- delete the whole trip
  assert.strictEqual((await call(Y, 'DELETE', '/api/trip')).status, 200);
  assert.strictEqual((await call(Y, 'GET', '/api/trip')).status, 404);
  assert.strictEqual((await call(A, 'GET', '/api/trip')).status, 200, 'other trips untouched');
  assert.strictEqual((await ops(Y, [{ kind: 'insert', table: 'expenses', rows: [exp('late')] }])).status, 404, 'a deleted trip cannot be written to without re-creating it');

  // --- creating trips is rate limited (per day, per IP)
  let limited = false;
  for (let i = 0; i < 30 && !limited; i++) limited = (await make2(tok('r'))).status === 429;
  assert.ok(limited, 'creation is rate limited');
  async function make2(t) { return ops(t, [{ kind: 'insert', table: 'trips', rows: [trip] }]); }

  console.log('share api tests passed');
} finally { srv.stop(); }
