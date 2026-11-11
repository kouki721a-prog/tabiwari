/* Settlement notices end to end: link LINE accounts to members, notice on a confirmed round / a paid mark, one reminder after 2 days, switch, reach.   node test/settlenotify.api.test.mjs */
import assert from 'node:assert';
import http from 'node:http';
import { createECDH, hkdfSync, createDecipheriv, randomBytes } from 'node:crypto';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';
import { b64u, unb64u } from '../worker/util.js';

// ---- a stand-in push service: records every delivery, answers with a status we choose
const inbox = []; let status = 201;
const pushSrv = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { inbox.push({ url: req.url, headers: req.headers, body: Buffer.concat(c) }); res.writeHead(status); res.end(); }); });
await new Promise(r => pushSrv.listen(9923, r));
const line = await startFakeLine(9912);
const srv = await startServer(8789, { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'notify-test-secret-0123456789abcdef0123', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base, TEST_HOOKS: '1', PUSH_TEST_HOST: 'localhost:9923' });
const B = srv.base;
const j = async (p, { cookie, method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(B + p, { method, headers: { ...(method !== 'GET' ? { Origin: B } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {} return { status: r.status, data, headers: r.headers };
};
async function login(sub, name) {
  line.setIdentity(sub, name); const b = await j('/api/auth/begin', { method: 'POST', body: {} });
  const s = await fetch(B + b.data.url, { redirect: 'manual' }); const a = await fetch(s.headers.get('Location'), { redirect: 'manual' }); await fetch(a.headers.get('Location'), { redirect: 'manual' });
  const p = await j('/api/auth/poll', { method: 'POST', body: { id: b.data.id, secret: b.data.secret } }); assert.strictEqual(p.status, 200); return p.headers.get('set-cookie').split(';')[0];
}
const newSub = (n) => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16); return { ecdh, auth, endpoint: 'http://localhost:9923/push/' + n, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } }; };
function decrypt(sub, body) {
  const salt = body.subarray(0, 16), idlen = body[20], keyid = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ikm = Buffer.from(hkdfSync('sha256', sub.ecdh.computeSecret(keyid), sub.auth, Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), keyid]), 32));
  const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16)); const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]); return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}
const run = async iso => (await j('/api/_test/reminders', { method: 'POST', body: { now: Date.parse(iso) } })).data;
const take = (sub) => { const path = new URL(sub.endpoint).pathname, mine = inbox.filter(m => m.url === path); for (const m of mine) inbox.splice(inbox.indexOf(m), 1); return mine.map(m => ({ ...decrypt(sub, m.body), _h: m.headers })); };   // takes only this device's deliveries
const local = (id, name, start, end, expenses = []) => ({ id, item: { kind: 'local', trip: { id, name, start, end, budget: 10000, members: [{ id: 'a', name: 'あおい' }], expenses: expenses.map((d, i) => ({ id: 'e' + i, amount: 100, payer: 'a', cat: 'food', date: d, split: ['a'] })) } } });
const shared = (token, name, start, end) => ({ id: 'h-' + token.slice(0, 8), item: { kind: 'shared', token, me: 'a', name, start, end } });

const T = 'S'.repeat(40), TID = await (async () => { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(T)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); })();
const ops = (token, o) => fetch(B + '/api/ops', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: o }) });
const link = (cookie, token, member) => j('/api/push/link', { cookie, method: 'POST', body: { token, member } });
const reach = async () => (await fetch(B + '/api/reach', { headers: { Authorization: 'Bearer ' + T } }).then(r => r.json())).reachable.sort();
const settleAt = '2026-11-20', settlement = { id: 'r1', n: 1, at: settleAt, total: 9000, transfers: [{ from: 'm-kenta', to: 'm-aoi', amount: 3500 }, { from: 'm-miku', to: 'm-aoi', amount: 1500 }] };
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (sub, n = 1) => { for (let i = 0; i < 40; i++) { if (inbox.filter(m => m.url === new URL(sub.endpoint).pathname).length >= n) break; await wait(100); } return take(sub); };

try {
  const cAoi = await login('U-aoi', 'あおい'), cKenta = await login('U-kenta', 'けんた'), cMiku = await login('U-miku', 'みく');
  const dAoi = newSub('aoi'), dKenta = newSub('kenta'), dMiku = newSub('miku');
  const sub = (cookie, s) => j('/api/push/subscribe', { cookie, method: 'POST', body: { endpoint: s.endpoint, keys: s.keys } });
  await sub(cKenta, dKenta); await sub(cAoi, dAoi);   // みく has no device yet

  // a shared trip with three members and one expense
  assert.strictEqual((await ops(T, [{ kind: 'insert', table: 'trips', rows: [{ id: 'x', name: '箱根', start_date: '2026-11-18', end_date: '2026-11-19', budget: 50000 }] },
    { kind: 'insert', table: 'members', rows: [{ id: 'm-aoi', name: 'あおい', position: 0 }, { id: 'm-kenta', name: 'けんた', position: 1 }, { id: 'm-miku', name: 'みく', position: 2 }] },
    { kind: 'insert', table: 'expenses', rows: [{ id: 'e1', title: '宿', amount: 9000, payer: 'm-aoi', cat: 'stay', spent_on: '2026-11-18', split: ['m-aoi', 'm-kenta', 'm-miku'] }] }])).status, 200);
  assert.deepStrictEqual(await reach(), [], 'nobody is linked yet');

  // linking: needs a login and the trip's link; the member must exist; the first claim wins
  assert.strictEqual((await link(undefined, T, 'm-aoi')).status, 401);
  assert.strictEqual((await link(cAoi, 'bad', 'm-aoi')).status, 400);
  assert.strictEqual((await link(cAoi, 'Z'.repeat(40), 'm-aoi')).status, 404, 'unknown trip');
  assert.strictEqual((await link(cAoi, T, 'nobody')).status, 404, 'unknown member');
  assert.strictEqual((await link(cAoi, T, 'm-aoi')).status, 200); assert.strictEqual((await link(cKenta, T, 'm-kenta')).status, 200); assert.strictEqual((await link(cMiku, T, 'm-miku')).status, 200);
  assert.strictEqual((await link(cMiku, T, 'm-aoi')).status, 409, 'あおい is already taken'); assert.strictEqual((await link(cKenta, T, 'm-kenta')).status, 200, 'the same person again is fine');
  assert.deepStrictEqual(await reach(), ['m-aoi', 'm-kenta'], 'linked and with a device; みく has no device; the claim on あおい by みく was refused and left her own link alone');
  assert.strictEqual((await fetch(B + '/api/reach', { headers: { Authorization: 'Bearer ' + 'Y'.repeat(40) } })).status, 404);

  // a confirmed round: who owes is told
  assert.strictEqual((await ops(T, [{ kind: 'insert', table: 'settlements', rows: [settlement] }, { kind: 'update', table: 'expenses', row: { id: 'e1', title: '宿', amount: 9000, payer: 'm-aoi', cat: 'stay', spent_on: '2026-11-18', split: ['m-aoi', 'm-kenta', 'm-miku'], settle_id: 'r1' } }])).status, 200);
  const k1 = await waitFor(dKenta);
  assert.strictEqual(k1.length, 1, JSON.stringify(k1)); assert.strictEqual(k1[0].body, '箱根の精算ができました。あおいさんに 3,500円 を送ってください。');
  assert.ok(k1[0].url.includes('trip=' + TID) && k1[0].url.includes('tab=settle'), k1[0].url);
  for (const m of [k1[0]]) assert.ok(!/[！]|催促|至急/.test(m.title + m.body));
  await wait(400); assert.strictEqual(take(dAoi).length, 0, 'the person who is owed is not told about the round'); assert.strictEqual(inbox.length, 0, 'みく has no device: nothing');
  // the same op sent again (a retry) does not notify twice
  await ops(T, [{ kind: 'insert', table: 'settlements', rows: [settlement] }]); await wait(600); assert.strictEqual(take(dKenta).length, 0, 'once per transfer');

  // a paid mark: who is owed is told
  await ops(T, [{ kind: 'insert', table: 'paid', rows: [{ key: 'm-kenta-m-aoi-3500' }] }]);
  const a1 = await waitFor(dAoi); assert.strictEqual(a1.length, 1, JSON.stringify(a1)); assert.strictEqual(a1[0].body, 'けんたさんが 3,500円 を支払いました。');
  await ops(T, [{ kind: 'delete', table: 'paid', row: { key: 'm-kenta-m-aoi-3500' } }]); await ops(T, [{ kind: 'insert', table: 'paid', rows: [{ key: 'm-kenta-m-aoi-3500' }] }]);
  await wait(600); assert.strictEqual(take(dAoi).length, 0, 'un-checking and checking again does not repeat it');

  // みく turns notifications on later: reachable now, and the 2-day reminder (settled 11-20, so 11-22 from 10:00) goes to her only (けんた already paid)
  await sub(cMiku, dMiku); assert.deepStrictEqual(await reach(), ['m-aoi', 'm-kenta', 'm-miku']);
  assert.strictEqual((await run('2026-11-22T00:30:00Z')).again || 0, 0, '09:30 in Japan: too early');   // JST 09:30
  assert.strictEqual((await run('2026-11-21T10:30:00Z')).again || 0, 0, 'only 1 day after the round');
  const r = await run('2026-11-22T01:30:00Z'); assert.strictEqual(r.again, 1, JSON.stringify(r));   // JST 10:30 on 11-22
  const m1 = take(dMiku); assert.strictEqual(m1.length, 1); assert.strictEqual(m1[0].body, '箱根の精算の、あおいさんへの 1,500円 は、お済みですか。');
  assert.strictEqual(take(dKenta).length, 0, 'けんた has paid: no reminder');
  assert.strictEqual((await run('2026-11-22T02:30:00Z')).again || 0, 0, 'only once'); assert.strictEqual((await run('2026-11-23T02:30:00Z')).again || 0, 0, 'and not the next day either'); assert.strictEqual(inbox.length, 0);

  // 精算のお知らせ off: nothing is sent and the person is not "reachable"
  assert.strictEqual((await j('/api/me', { cookie: cAoi })).data.user.settle, true);
  assert.strictEqual((await j('/api/push/settings', { cookie: cAoi, method: 'POST', body: { settle: 'x' } })).status, 400);
  assert.strictEqual((await j('/api/push/settings', { method: 'POST', body: { settle: false } })).status, 401);
  assert.strictEqual((await j('/api/push/settings', { cookie: cAoi, method: 'POST', body: { settle: false } })).status, 200);
  assert.strictEqual((await j('/api/me', { cookie: cAoi })).data.user.settle, false); assert.deepStrictEqual(await reach(), ['m-kenta', 'm-miku']);
  await ops(T, [{ kind: 'insert', table: 'paid', rows: [{ key: 'm-miku-m-aoi-1500' }] }]); await wait(800); assert.strictEqual(take(dAoi).length, 0, 'switched off');
  // other kinds of reminders are not affected by the switch (they are not 精算のお知らせ), and a round 2 uses the "2:" key
  await j('/api/push/settings', { cookie: cAoi, method: 'POST', body: { settle: true } });
  await ops(T, [{ kind: 'insert', table: 'paid', rows: [{ key: '2:m-miku-m-aoi-100' }, { key: 'garbage' }] }]); const a2 = await waitFor(dAoi); assert.strictEqual(a2.length, 1, JSON.stringify(a2)); assert.strictEqual(a2[0].body, 'みくさんが 100円 を支払いました。');

  // a failing push service never breaks the write, and ending the share forgets the links
  status = 500; assert.strictEqual((await ops(T, [{ kind: 'insert', table: 'paid', rows: [{ key: '3:m-kenta-m-aoi-5' }] }])).status, 200); await wait(600); status = 201; inbox.splice(0);
  assert.strictEqual((await fetch(B + '/api/trip', { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } })).status, 200);
  assert.strictEqual((await fetch(B + '/api/reach', { headers: { Authorization: 'Bearer ' + T } })).status, 404);

  console.log('settle notify api tests passed');
} finally { srv.stop(); line.stop(); pushSrv.close(); }
