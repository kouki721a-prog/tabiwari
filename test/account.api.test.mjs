/* LINE login + backup API against a real local Worker + D1, with a stand-in for LINE.   node test/account.api.test.mjs */
import assert from 'node:assert';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';

// ---- 1. not configured: nothing is offered
let srv = await startServer(8788);
try {
  const me = await (await fetch(srv.base + '/api/me')).json();
  assert.deepStrictEqual(me, { login: false, user: null, push: null });
  const r = await fetch(srv.base + '/api/auth/begin', { method: 'POST', headers: { Origin: srv.base } });
  assert.strictEqual(r.status, 503);
  assert.strictEqual((await fetch(srv.base + '/api/backup')).status, 503);
} finally { srv.stop(); }

// ---- 2. configured
const line = await startFakeLine(9911);
srv = await startServer(8788, { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'x'.repeat(8) + 'unit-test-secret-0123456789abcdef', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base });
const B = srv.base, O = { Origin: B };
const j = async (p, { cookie, method = 'GET', body, origin = true, headers = {} } = {}) => {
  const r = await fetch(B + p, { method, redirect: 'manual', headers: { ...(origin && method !== 'GET' ? O : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { status: r.status, data, text, headers: r.headers };
};
/* run the whole login as the person with the given LINE identity; returns the session cookie */
async function login(sub, name, { secret: wrongSecret } = {}) {
  line.setIdentity(sub, name);
  const b = await j('/api/auth/begin', { method: 'POST', body: {} });
  assert.strictEqual(b.status, 200); const { id, secret, url } = b.data;
  assert.deepStrictEqual(await j('/api/auth/poll', { method: 'POST', body: { id, secret } }).then(r => r.data), { pending: true }, 'pending until LINE is done');
  const s = await fetch(B + url, { redirect: 'manual' }); assert.strictEqual(s.status, 302);
  const toLine = new URL(s.headers.get('Location')); assert.ok(toLine.href.startsWith(line.base + '/oauth2/v2.1/authorize'));
  const a = await fetch(toLine, { redirect: 'manual' }); assert.strictEqual(a.status, 302);
  const cb = await fetch(a.headers.get('Location'), { redirect: 'manual' }); const html = await cb.text();
  assert.strictEqual(cb.status, 200); assert.ok(html.includes('ログインできました'));
  assert.strictEqual((await j('/api/auth/poll', { method: 'POST', body: { id, secret: wrongSecret || 'wrong-secret' } })).status, 410, 'a wrong secret gets nothing');
  const p = await j('/api/auth/poll', { method: 'POST', body: { id, secret } });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.data.ok, true);
  const sc = p.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  assert.strictEqual((await j('/api/auth/poll', { method: 'POST', body: { id, secret } })).status, 410, 'the attempt is single use');
  assert.strictEqual((await fetch(a.headers.get('Location'), { redirect: 'manual' })).status, 400, 'the callback cannot be replayed');
  return sc.split(';')[0];
}
const shared = { id: 'a'.repeat(64), item: { kind: 'shared', token: 'T'.repeat(32), me: 'm1', name: '箱根', start: '2026-11-09', end: '2026-11-11' } };
const local = { id: 'trip-local-1', item: { kind: 'local', trip: { id: 'trip-local-1', name: 'ローカル旅', members: [{ id: 'm1', name: 'あおい' }], expenses: [{ id: 'e1', title: '夕食', amount: 3000 }] } } };

try {
  assert.deepStrictEqual((await j('/api/me')).data, { login: true, user: null, push: null });
  assert.strictEqual((await j('/api/auth/begin', { method: 'POST', body: {}, origin: false })).status, 403, 'cross-site posts are refused');
  assert.strictEqual((await j('/api/backup')).status, 401);
  assert.strictEqual((await j('/api/auth/poll', { method: 'POST', body: { id: 'nope', secret: 'x' } })).status, 410);
  assert.strictEqual((await fetch(B + '/api/auth/line/callback?code=x&state=unknown')).status, 400, 'unknown state');
  assert.strictEqual((await fetch(B + '/api/auth/line/start?a=unknown', { redirect: 'manual' })).status, 400);

  // --- login as U1
  const c1 = await login('U-one', 'テスト太郎');
  { const me = (await j('/api/me', { cookie: c1 })).data; assert.deepStrictEqual([me.login, me.user], [true, { name: 'テスト太郎' }]); assert.strictEqual(me.push.length, 87, 'logged-in people are offered the push key'); }
  assert.ok(!JSON.stringify((await j('/api/me', { cookie: c1 })).data).includes('U-one'), 'the LINE user id is never sent to the app');
  assert.strictEqual((await j('/api/me', { cookie: 'tw_session=' + 'z'.repeat(43) })).data.user, null, 'a made-up cookie is nobody');

  // --- backup round trip
  assert.deepStrictEqual((await j('/api/backup', { cookie: c1 })).data, { items: [] });
  assert.strictEqual((await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [shared, local] }, origin: false })).status, 403);
  let put = await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [shared, local] } });
  assert.deepStrictEqual([put.status, put.data.count], [200, 2]);
  let got = (await j('/api/backup', { cookie: c1 })).data.items;
  assert.deepStrictEqual(got.map(x => x.id).sort(), [local.id, shared.id].sort());
  assert.deepStrictEqual(got.find(x => x.id === local.id).item, local.item, 'what comes back is what went in');
  // update one, remove one
  const edited = { id: local.id, item: { ...local.item, trip: { ...local.item.trip, name: 'ローカル旅 改' } } };
  assert.strictEqual((await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [edited], remove: [shared.id] } })).status, 200);
  got = (await j('/api/backup', { cookie: c1 })).data.items;
  assert.deepStrictEqual([got.length, got[0].item.trip.name], [1, 'ローカル旅 改']);
  // a trip deleted on the device is marked, not removed: the content stays (so it can still be restored), and it is flagged
  assert.strictEqual((await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [], remove: [], deleted: [local.id, 'does-not-exist'] } })).status, 200);
  got = (await j('/api/backup', { cookie: c1 })).data.items;
  assert.deepStrictEqual([got.length, got[0].item.deleted, got[0].item.trip.name], [1, true, 'ローカル旅 改'], 'marked as deleted, content kept');
  assert.strictEqual((await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [edited] } })).status, 200);
  assert.strictEqual((await j('/api/backup', { cookie: c1 })).data.items[0].item.deleted, undefined, 'a normal backup of the trip clears the mark');
  assert.strictEqual((await j('/api/backup', { cookie: c1, method: 'PUT', body: { deleted: ['x y'] } })).status, 400, 'bad ids are refused');
  // validation
  for (const bad of [{ upsert: [{ id: 'x y', item: local.item }] }, { upsert: [{ id: 'ok', item: { kind: 'shared', token: 'short', name: 'x' } }] }, { upsert: [{ id: 'ok', item: { kind: 'other' } }] },
    { upsert: [{ id: 'ok', item: { kind: 'local', trip: { name: 'x', members: 'no', expenses: [] } } }] }, {}, { upsert: Array.from({ length: 21 }, (_, i) => ({ id: 'i' + i, item: local.item })) },
    { upsert: [{ id: 'big', item: { kind: 'local', trip: { name: 'x', members: [], expenses: [], pad: 'x'.repeat(210000) } } }] }]) {
    assert.ok([400, 413].includes((await j('/api/backup', { cookie: c1, method: 'PUT', body: bad })).status), JSON.stringify(bad).slice(0, 80));
  }

  // --- U2 sees nothing of U1; the per-account limit holds
  const c2 = await login('U-two', 'もう一人');
  assert.deepStrictEqual((await j('/api/backup', { cookie: c2 })).data, { items: [] });
  for (let k = 0; k < 5; k++) assert.strictEqual((await j('/api/backup', { cookie: c2, method: 'PUT', body: { upsert: Array.from({ length: 20 }, (_, i) => ({ id: `t${k}-${i}`, item: local.item })) } })).status, k < 5 ? 200 : 413);
  assert.strictEqual((await j('/api/backup', { cookie: c2, method: 'PUT', body: { upsert: [{ id: 'one-too-many', item: local.item }] } })).status, 413, '100 trips per account');
  assert.strictEqual((await j('/api/backup', { cookie: c1 })).data.items.length, 1, 'U1 is untouched');

  // --- same LINE person on another "device" -> same account, same backup
  const c1b = await login('U-one', 'テスト太郎');
  assert.deepStrictEqual((await j('/api/backup', { cookie: c1b })).data.items.map(x => x.id), [local.id]);

  // --- denied at LINE
  line.denyNext(); line.setIdentity('U-three', 'x');
  const b3 = await j('/api/auth/begin', { method: 'POST', body: {} });
  const s3 = await fetch(B + b3.data.url, { redirect: 'manual' }); const a3 = await fetch(s3.headers.get('Location'), { redirect: 'manual' });
  const cb3 = await fetch(a3.headers.get('Location'), { redirect: 'manual' }); assert.ok((await cb3.text()).includes('ログインをやめました'));
  assert.strictEqual((await j('/api/auth/poll', { method: 'POST', body: { id: b3.data.id, secret: b3.data.secret } })).status, 410);

  // --- logout ends only that session
  assert.strictEqual((await j('/api/auth/logout', { cookie: c1, method: 'POST', body: {} })).status, 200);
  assert.strictEqual((await j('/api/me', { cookie: c1 })).data.user, null); assert.strictEqual((await j('/api/backup', { cookie: c1 })).status, 401);
  assert.strictEqual((await j('/api/backup', { cookie: c1b })).status, 200, 'the other device stays signed in');

  // --- deleting the account removes it, its sessions and its backups; others are untouched
  assert.strictEqual((await j('/api/account', { cookie: c2, method: 'DELETE', origin: false })).status, 403);
  assert.strictEqual((await j('/api/account', { cookie: c2, method: 'DELETE' })).status, 200);
  assert.strictEqual((await j('/api/me', { cookie: c2 })).data.user, null);
  const c2again = await login('U-two', 'もう一人');
  assert.deepStrictEqual((await j('/api/backup', { cookie: c2again })).data.items, [], 'a deleted account starts empty');
  assert.strictEqual((await j('/api/backup', { cookie: c1b })).data.items.length, 1);

  // --- link sharing still works next to accounts
  const tok = 'S'.repeat(40), r = await fetch(B + '/api/ops', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [{ kind: 'insert', table: 'trips', rows: [{ id: 'x', name: 'x', start_date: '2026-01-01', end_date: '2026-01-02', budget: 1 }] }] }) });
  assert.strictEqual(r.status, 200);

  console.log('account api tests passed');
} finally { srv.stop(); line.stop(); }
