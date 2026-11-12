/* Notifications end to end on a real local Worker + D1: subscribe, hourly job, encrypted delivery to a stand-in push service.   node test/notify.api.test.mjs */
import assert from 'node:assert';
import http from 'node:http';
import { createECDH, hkdfSync, createDecipheriv, randomBytes } from 'node:crypto';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';
import { b64u, unb64u } from '../worker/util.js';

// ---- a stand-in push service: records every delivery, answers with a status we choose
const inbox = []; let status = 201;
const pushSrv = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { inbox.push({ url: req.url, headers: req.headers, body: Buffer.concat(c) }); res.writeHead(status); res.end(); }); });
await new Promise(r => pushSrv.listen(9922, r));
const line = await startFakeLine(9911);
const srv = await startServer(8788, { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'notify-test-secret-0123456789abcdef0123', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base, TEST_HOOKS: '1', PUSH_TEST_HOST: 'localhost:9922' });
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
const newSub = (n) => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16); return { ecdh, auth, endpoint: 'http://localhost:9922/push/' + n, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } }; };
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
const putTripWithExpenses = async (token, dates) => fetch(B + '/api/ops', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [
  { kind: 'insert', table: 'trips', rows: [{ id: 'x', name: 'srv', start_date: '2026-11-01', end_date: '2026-12-31', budget: 1000 }] }, { kind: 'insert', table: 'members', rows: [{ id: 'a', name: 'あおい', position: 0 }] },
  ...(dates.length ? [{ kind: 'insert', table: 'expenses', rows: dates.map((d, i) => ({ id: 'e' + i, amount: 100, payer: 'a', cat: 'food', spent_on: d, split: ['a'] })) }] : [])] }) });

try {
  const c1 = await login('U-one', 'ひとり'), c2 = await login('U-two', 'ふたり');
  assert.strictEqual((await j('/api/me', { cookie: c1 })).data.push.length, 87, 'the VAPID public key (65 bytes, base64url) is offered to logged-in users');
  assert.strictEqual((await j('/api/me', { cookie: c1 })).data.push, (await j('/api/me', { cookie: c2 })).data.push, 'one key for the whole site');
  assert.strictEqual((await j('/api/me')).data.push, null, 'not offered to strangers');

  // ---- subscribing: only real push services, valid keys, signed in, device limit
  const d1 = newSub('d1'), d2 = newSub('d2');
  const sub = (cookie, s) => j('/api/push/subscribe', { cookie, method: 'POST', body: { endpoint: s.endpoint, keys: s.keys } });
  assert.strictEqual((await j('/api/push/subscribe', { method: 'POST', body: { endpoint: d1.endpoint, keys: d1.keys } })).status, 401);
  assert.strictEqual((await j('/api/push/subscribe', { cookie: c1, method: 'POST', body: { endpoint: 'https://evil.example/x', keys: d1.keys } })).status, 400, 'arbitrary URLs are never contacted');
  assert.strictEqual((await j('/api/push/subscribe', { cookie: c1, method: 'POST', body: { endpoint: d1.endpoint, keys: { p256dh: 'x', auth: 'y' } } })).status, 400);
  assert.strictEqual((await j('/api/push/subscribe', { cookie: c1, method: 'POST', body: { endpoint: d1.endpoint, keys: d1.keys }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.strictEqual((await sub(c1, d1)).status, 200); assert.strictEqual((await sub(c2, d2)).status, 200);

  // ---- data: U1's backup has several trips; one shared trip lives in D1 under its token hash
  const F = 'F'.repeat(40), H = 'H'.repeat(40), I = 'I'.repeat(40);
  await putTripWithExpenses(F, ['2026-11-29', '2026-11-30']);   // F ended yesterday (11-30) with expenses  -> settle
  await putTripWithExpenses(H, ['2026-12-01']);                 // H is on a trip and logged today        -> no nagging
  await putTripWithExpenses(I, ['2026-11-30']);                 // I is on a trip, nothing logged today   -> daily
  const items = [
    local('A', '箱根', '2026-12-02', '2026-12-04'),                                  // starts tomorrow            -> eve
    local('E', '京都', '2026-11-28', '2026-11-30', ['2026-11-29']),                  // ended yesterday, spent     -> settle
    local('G', '奈良', '2026-11-28', '2026-11-30'),                                  // ended yesterday, no spend  -> nothing
    local('C', '熱海', '2026-11-30', '2026-12-02', ['2026-11-30']),                  // on a trip, none today      -> daily
    local('B', '草津', '2026-11-30', '2026-12-02', ['2026-12-01']),                  // on a trip, logged today    -> nothing
    local('Z', '遠い旅', '2027-03-01', '2027-03-03'),                                // far away                   -> nothing
    shared(F, '共有・終了', '2026-11-28', '2026-11-30'), shared(H, '共有・記録済み', '2026-11-30', '2026-12-02'), shared(I, '共有・未記録', '2026-11-30', '2026-12-02')];
  assert.strictEqual((await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: items.slice(0, 5) } })).status, 200);
  assert.strictEqual((await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: items.slice(5) } })).status, 200);
  const bystander = local('Q', '二人目の旅', '2026-12-02', '2026-12-04'); assert.strictEqual((await j('/api/backup', { cookie: c2, method: 'PUT', body: { upsert: [bystander] } })).status, 200);

  // ---- the hourly job
  assert.deepStrictEqual(await run('2026-12-01T00:30:00Z'), { claimed: 0, sent: 0, gone: 0, failed: 0, released: 0 }, '09:30 Japan time: too early for anything');
  const r1 = await run('2026-12-01T09:30:00Z');                                       // 18:30: evening reminders and morning-after settlements
  assert.deepStrictEqual([r1.claimed, r1.sent], [4, 4], JSON.stringify(r1));        // U1: eve(箱根) + settle(京都) + settle(共有・終了);  U2: eve(二人目の旅)
  const got1 = take(d1), got2 = take(d2);
  assert.deepStrictEqual(got1.map(m => m.title).sort(), ['明日から 「箱根」', '精算を済ませましょう', '精算を済ませましょう'].sort());
  assert.ok(got1.some(m => m.body.includes('京都')) && got1.some(m => m.body.includes('共有・終了')) && !got1.some(m => m.body.includes('奈良')), 'the trip with no expenses is not settled');
  assert.deepStrictEqual(got2.map(m => m.title), ['明日から 「二人目の旅」'], 'each person only gets their own trips');
  assert.ok(got1.every(m => m.url === './' && m.tag));
  // delivery details a push service needs
  const hd = got1[0]._h, vap = (await j('/api/me', { cookie: c1 })).data.push;
  assert.strictEqual(hd['content-encoding'], 'aes128gcm'); assert.strictEqual(hd.ttl, '21600'); assert.match(hd.authorization, new RegExp('^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=' + vap + '$'));
  const [, head, claims, sig] = /t=([\w-]+)\.([\w-]+)\.([\w-]+),/.exec(hd.authorization);
  const pubKey = await crypto.subtle.importKey('raw', unb64u(vap), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, unb64u(sig), new TextEncoder().encode(head + '.' + claims)), 'the push service can verify the VAPID signature');
  const cl = JSON.parse(Buffer.from(unb64u(claims)).toString()); assert.strictEqual(cl.aud, 'http://localhost:9922'); assert.ok(cl.exp > Date.now() / 1000 && cl.exp < Date.now() / 1000 + 86400); assert.strictEqual(cl.sub, B);

  assert.deepStrictEqual((await run('2026-12-01T09:45:00Z')).claimed, 0, 'the same reminders are not sent twice'); assert.strictEqual(inbox.length, 0);
  const r2 = await run('2026-12-01T11:30:00Z');                                       // 20:30: "log today's spending"
  assert.deepStrictEqual([r2.claimed, r2.sent], [2, 2], JSON.stringify(r2));        // 熱海 (none today) and 共有・未記録. The evening reminders were already sent, so they are not claimed again
  const got = take(d1); assert.deepStrictEqual(got.map(m => m.title), ['今日の支出を記録しましょう', '今日の支出を記録しましょう']); assert.ok(got.some(m => m.body.includes('熱海')) && got.some(m => m.body.includes('共有・未記録')) && !got.some(m => m.body.includes('草津') || m.body.includes('共有・記録済み')));
  void inbox.splice(0);

  // ---- a push service that is down: nothing is lost, the reminder is retried
  await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [local('K', '那須', '2026-12-03', '2026-12-04')] } });
  status = 500; const r3 = await run('2026-12-02T09:30:00Z'); assert.ok(r3.failed >= 1 && r3.sent === 0 && r3.released >= 1, JSON.stringify(r3)); inbox.splice(0);
  status = 201; const r4 = await run('2026-12-02T10:30:00Z'); assert.ok(r4.sent >= 1, 'retried the next hour: ' + JSON.stringify(r4));
  assert.ok(take(d1).some(m => m.title.includes('那須')), 'the evening reminder carries the trip name in its title');

  // ---- a subscription the push service says is gone is dropped, and then nothing is sent to it
  await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [local('L', '日光', '2026-12-04', '2026-12-05')] } });
  status = 410; const r5 = await run('2026-12-03T09:30:00Z'); assert.ok(r5.gone >= 1, JSON.stringify(r5)); inbox.splice(0); status = 201;
  await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [local('M', '軽井沢', '2026-12-05', '2026-12-06')] } });
  assert.strictEqual((await run('2026-12-04T09:30:00Z')).sent, 0, 'the dead device is no longer used');

  // ---- a trip deleted on the device gets no reminders, and the same trip saved twice gets one
  await j('/api/backup', { cookie: c2, method: 'PUT', body: { upsert: [local('DEL', '消した旅', '2026-12-20', '2026-12-21'), local('DUP1', '同じ旅', '2026-12-20', '2026-12-21'), local('DUP2', '同じ旅', '2026-12-20', '2026-12-21')] } });
  await j('/api/backup', { cookie: c2, method: 'PUT', body: { deleted: ['DEL'] } });
  inbox.splice(0); const rd = await run('2026-12-19T09:30:00Z');
  const titles = take(d2).map(m => m.title);
  assert.ok(!titles.some(t => t.includes('消した旅')), 'no reminder for a deleted trip: ' + titles.join(','));
  assert.strictEqual(titles.filter(t => t.includes('同じ旅')).length, 1, 'one reminder for a trip saved twice: ' + titles.join(','));

  // ---- "send a test notification" goes only to the caller's own devices, and needs a login
  inbox.splice(0);
  assert.strictEqual((await j('/api/push/test', { method: 'POST', body: {} })).status, 401, 'test push needs a login');
  const tp = await j('/api/push/test', { cookie: c2, method: 'POST', body: {} });
  assert.strictEqual(tp.status, 200); assert.strictEqual(tp.data.sent, 1, JSON.stringify(tp.data));
  assert.ok(take(d2).some(m => m.title.includes('テスト')), 'the test notification arrives on the caller\'s device');
  assert.strictEqual(take(d1).length, 0, 'and not on anybody else\'s');

  // ---- the diagnosis shows only the caller's own data, and changes nothing
  assert.strictEqual((await j('/api/push/diagnose', { method: 'POST', body: {} })).status, 401);
  const dg = await j('/api/push/diagnose', { cookie: c2, method: 'POST', body: {} });
  assert.strictEqual(dg.status, 200); assert.strictEqual(dg.data.devices, 1); assert.ok(Array.isArray(dg.data.trips) && Array.isArray(dg.data.sent) && dg.data.jst.today);
  assert.ok(dg.data.trips.every(x => x.name !== undefined || x.unreadable), JSON.stringify(dg.data.trips));
  assert.ok(!dg.data.trips.some(x => /那須|日光|軽井沢/.test(x.name || '')), 'no trips of other accounts');
  assert.ok(dg.data.trips.some(x => x.name === '二人目の旅' && Array.isArray(x.kinds)), JSON.stringify(dg.data.trips));
  assert.strictEqual((await run('2026-12-05T09:40:00Z')).sent, 0, 'diagnosing sent nothing and claimed nothing new');

  // ---- turning it off / deleting the account stops everything
  assert.strictEqual((await j('/api/push/unsubscribe', { cookie: c1, method: 'POST', body: { endpoint: d2.endpoint } })).status, 200, 'cannot remove someone else\'s device');
  await j('/api/backup', { cookie: c2, method: 'PUT', body: { upsert: [local('R', 'ふたりの旅', '2026-12-06', '2026-12-07')] } });
  assert.ok((await run('2026-12-05T09:30:00Z')).sent >= 1, 'U2 still subscribed'); take(d2);
  assert.strictEqual((await j('/api/push/unsubscribe', { cookie: c2, method: 'POST', body: { endpoint: d2.endpoint } })).status, 200);
  await j('/api/backup', { cookie: c2, method: 'PUT', body: { upsert: [local('S', 'もう一つ', '2026-12-07', '2026-12-08')] } });
  assert.strictEqual((await run('2026-12-06T09:30:00Z')).sent, 0, 'unsubscribed: nothing');
  assert.strictEqual((await sub(c2, d2)).status, 200); assert.strictEqual((await j('/api/account', { cookie: c2, method: 'DELETE' })).status, 200);
  assert.strictEqual((await run('2026-12-06T09:35:00Z')).sent, 0, 'deleted account: its devices are forgotten');

  // ---- 今日の使いすぎのお知らせ: a running trip whose spending today is over the day's allowance, once a day, off switch
  { assert.strictEqual((await sub(c1, d1)).status, 200); inbox.splice(0);
    const runTrip = (id, name, spent) => ({ id, item: { kind: 'local', trip: { id, name, start: '2027-02-10', end: '2027-02-12', budget: 30000, members: [{ id: 'a', name: 'あおい' }], expenses: spent.map((amount, i) => ({ id: id + i, amount, payer: 'a', cat: 'food', date: '2027-02-11', split: ['a'] })) } } });
    await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [runTrip('OV1', '使いすぎ旅', [12000, 8000]), runTrip('OK1', 'ふつうの旅', [3000])] } });
    assert.strictEqual((await run('2027-02-11T00:30:00Z')).sent, 0, '09:30 in Japan: too early'); assert.strictEqual(inbox.length, 0);
    const o1 = await run('2027-02-11T01:30:00Z'); assert.deepStrictEqual([o1.claimed, o1.sent], [1, 1], JSON.stringify(o1));   // 20,000 > floor((30,000 - 20,000) / 2) = 5,000 for OV1; 3,000 < floor(27,000 / 2) for OK1
    const om = take(d1); assert.strictEqual(om.length, 1); assert.deepStrictEqual([om[0].title, om[0].body], ['「使いすぎ旅」 今日の支出', '今日は 20,000円 使いました。1日の目安 5,000円 を超えています。']); assert.ok(!/[！]|催促|至急/.test(om[0].title + om[0].body));
    assert.strictEqual((await run('2027-02-11T02:30:00Z')).claimed, 0, 'once a day');
    assert.strictEqual((await run('2027-02-11T14:00:00Z')).claimed, 0, '23:00 in Japan: still the same one, and too late for a new one'); inbox.splice(0);
    assert.strictEqual((await j('/api/push/settings', { cookie: c1, method: 'POST', body: { over: 'x' } })).status, 400); assert.strictEqual((await j('/api/push/settings', { cookie: c1, method: 'POST', body: {} })).status, 400);
    assert.strictEqual((await j('/api/me', { cookie: c1 })).data.user.over, true);
    assert.strictEqual((await j('/api/push/settings', { cookie: c1, method: 'POST', body: { over: false } })).status, 200); assert.strictEqual((await j('/api/me', { cookie: c1 })).data.user.over, false);
    assert.strictEqual((await j('/api/me', { cookie: c1 })).data.user.settle, true, 'the other switch is untouched');
    await j('/api/backup', { cookie: c1, method: 'PUT', body: { upsert: [runTrip('OV2', '二つ目の旅', [29000])] } });
    assert.strictEqual((await run('2027-02-11T03:30:00Z')).claimed, 0, 'switched off: no over notice'); assert.strictEqual(inbox.length, 0);
    await j('/api/push/unsubscribe', { cookie: c1, method: 'POST', body: { endpoint: d1.endpoint } }); }

  // ---- device limit (per account)
  for (let k = 0; k < 10; k++) assert.strictEqual((await sub(c1, newSub('m' + k))).status, 200);
  assert.strictEqual((await sub(c1, newSub('m11'))).status, 413, '10 devices per account');

  console.log('notify api tests passed');
} finally { srv.stop(); line.stop(); pushSrv.close(); }
