/* A cold start on a database that already has data must be cheap and must not break anything: the schema (CREATE + ALTER, ~40 queries) is not redone when its fingerprint
   is already in meta.   node test/schema.api.test.mjs */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from './wrangler-dev.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'tabiwari-schema-'));
const T = 'Q'.repeat(40), PORT = 8795;
const call = (base, method, p, body, token = T) => fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
let srv = await startServer(PORT, {}, dir);
try {
  const ops = [{ kind: 'insert', table: 'trips', rows: [{ id: 'x', name: '箱根', start_date: '2026-11-18', end_date: '2026-11-19', budget: 50000 }] },
    { kind: 'insert', table: 'members', rows: [{ id: 'm1', name: 'あおい', position: 0 }] },
    { kind: 'insert', table: 'expenses', rows: [{ id: 'e1', title: '夕食', amount: 3000, payer: 'm1', cat: 'food', spent_on: '2026-11-18', split: ['m1'], author: 'm1', made_at: 1700000000000, editor: 'm1', edited_at: 1700000100000, prev: { amount: 2500, payer: 'm1', split: ['m1'] } }] }];
  assert.equal((await call(srv.base, 'POST', '/api/ops', { ops })).status, 200, 'the first start builds the schema and takes the write');
  srv.stop(true); await new Promise(r => setTimeout(r, 1500));
  srv = await startServer(PORT, {}, dir);   // a new process = a cold start on the same data: the fast path
  const g = await call(srv.base, 'GET', '/api/trip');
  assert.equal(g.status, 200, 'a cold start on an existing database answers');
  const e = g.body.trip.expenses[0]; assert.deepEqual([e.author, e.made_at, e.editor, e.prev.amount], ['m1', 1700000000000, 'm1', 2500], 'and the data (with its history columns) is all there');
  assert.equal((await call(srv.base, 'POST', '/api/ops', { ops: [{ kind: 'insert', table: 'expenses', rows: [{ id: 'e2', title: '昼食', amount: 900, payer: 'm1', cat: 'food', spent_on: '2026-11-18', split: ['m1'] }] }] })).status, 200, 'and it takes writes too');
  console.log('schema cold-start tests passed');
} finally { srv.stop(); rmSync(dir, { recursive: true, force: true }); }
