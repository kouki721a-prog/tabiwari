/* お問い合わせ (v147) end to end on the Worker: the form's checks, the operator role, the list, the LINE notice, the limits.   node test/contact.api.test.mjs */
import assert from 'node:assert';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';

const line = await startFakeLine(9951);
const srv = await startServer(8801, { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'contact-test-secret-0123456789abcdef0123', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base, TEST_HOOKS: '1', LINE_OA_ACCESS_TOKEN: 'oa-test-token', ADMIN_TOKEN: 'test-admin-passphrase-123' });
const B = srv.base;
let ipN = 0; const newIp = () => '10.9.8.' + (++ipN);
const j = async (p, { cookie, method = 'GET', body, ip, origin = true } = {}) => {
  const r = await fetch(B + p, { method, headers: { ...(method !== 'GET' && origin ? { Origin: B } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {} return { status: r.status, data, headers: r.headers };
};
async function login(sub, name) {
  line.setIdentity(sub, name); const b = await j('/api/auth/begin', { method: 'POST', body: {} });
  const s = await fetch(B + b.data.url, { redirect: 'manual' }); const a = await fetch(s.headers.get('Location'), { redirect: 'manual' }); await fetch(a.headers.get('Location'), { redirect: 'manual' });
  const p = await j('/api/auth/poll', { method: 'POST', body: { id: b.data.id, secret: b.data.secret } }); assert.strictEqual(p.status, 200); return p.headers.get('set-cookie').split(';')[0];
}
const send = (body, o = {}) => j('/api/contact', { method: 'POST', ip: newIp(), ...o, body: { kind: 'bug', body: '精算の金額が合いません。', reply: 'none', ...body } });
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  // ---- the form's checks
  assert.strictEqual((await send({ kind: 'nope' })).status, 400, 'an unknown kind');
  assert.strictEqual((await send({ body: '   ' })).status, 400, 'an empty message');
  assert.strictEqual((await send({ body: 'あ'.repeat(1001) })).status, 400, 'too long (1000 characters at most)');
  assert.strictEqual((await send({ body: 'あ'.repeat(1000) })).status, 200, '1000 characters are fine');
  assert.strictEqual((await send({ reply: 'mail', contact: 'not-an-address' })).status, 400, 'a reply by mail needs an address');
  assert.strictEqual((await send({ reply: 'mail', contact: 'a@example.com' })).status, 200);
  assert.strictEqual((await send({ reply: 'line' })).status, 401, 'a reply by LINE needs a signed-in person');
  assert.strictEqual((await send({ reply: 'sms' })).status, 400, 'an unknown way to reply');
  assert.strictEqual((await j('/api/contact', { method: 'POST', ip: newIp(), origin: false, body: { kind: 'bug', body: 'x', reply: 'none' } })).status, 403, 'a post from another site is refused');
  assert.strictEqual((await fetch(B + '/api/contact', { method: 'POST', headers: { Origin: B, 'CF-Connecting-IP': newIp() }, body: 'x'.repeat(9000) })).status, 400, 'a huge body is refused');

  // ---- nobody is the operator yet: no list, no LINE notice (the message is still kept)
  assert.strictEqual((await j('/api/contact/list')).status, 403, 'the list needs the operator');
  const cA = await login('U-admin', '運営者'), cB = await login('U-other', 'ほかの人');
  assert.strictEqual((await j('/api/contact/list', { cookie: cA })).status, 403, 'signed in is not enough');
  assert.strictEqual((await j('/api/me', { cookie: cA })).data.user.admin, false);
  line.setFriend('U-admin', true); await login('U-admin', '運営者');   // friendship is learnt at login
  await send({ body: 'まだ運営者がいないとき' }); await wait(300); assert.strictEqual(line.pushes.length, 0, 'no operator: no LINE notice');

  // ---- becoming the operator
  assert.strictEqual((await j('/api/admin/claim', { method: 'POST', body: { token: 'test-admin-passphrase-123' }, ip: newIp() })).status, 401, 'signed in first');
  assert.strictEqual((await j('/api/admin/claim', { cookie: cB, method: 'POST', body: { token: 'wrong-passphrase-xx' }, ip: newIp() })).status, 403, 'a wrong passphrase');
  assert.strictEqual((await j('/api/me', { cookie: cB })).data.user.admin, false);
  assert.strictEqual((await j('/api/admin/claim', { cookie: cA, method: 'POST', body: { token: 'test-admin-passphrase-123' }, ip: newIp() })).status, 200, 'the right passphrase');
  assert.strictEqual((await j('/api/me', { cookie: cA })).data.user.admin, true); assert.strictEqual((await j('/api/me', { cookie: cB })).data.user.admin, false, 'only that account');
  // brute force: a few tries per hour from one place
  { const ip = newIp(); let last = 0; for (let i = 0; i < 7; i++) last = (await j('/api/admin/claim', { cookie: cB, method: 'POST', body: { token: 'guess-' + i + '-xxxxxxxx' }, ip })).status; assert.strictEqual(last, 429, 'the passphrase cannot be guessed over and over'); }

  // ---- a message reaches the operator: LINE notice + the list
  const before = line.pushes.length;
  assert.strictEqual((await send({ kind: 'idea', body: '積立の目標を、人ごとに変えたい。\u0007制御文字は消える', reply: 'mail', contact: 'me@example.com', ver: 'v147', device: 'iPhone' })).status, 200);
  for (let i = 0; i < 40 && line.pushes.length === before; i++) await wait(100);
  const p1 = line.pushes[line.pushes.length - 1]; assert.ok(p1 && p1.to === 'U-admin', 'the notice goes to the operator: ' + JSON.stringify(p1));
  assert.strictEqual(p1.text, '【Tabiflow】新しいお問い合わせ（ご要望）\n積立の目標を、人ごとに変えたい。制御文字は消える\n返信：メール', p1.text);
  assert.ok(!/[！]|催促|至急/.test(p1.text) && !p1.text.includes('me@example.com'), 'no address in the LINE message');
  const l = await j('/api/contact/list', { cookie: cA }); assert.strictEqual(l.status, 200);
  const top = l.data.items[0]; assert.deepStrictEqual([top.kind, top.reply, top.contact, top.ver, top.device], ['idea', 'mail', 'me@example.com', 'v147', 'iPhone']); assert.ok(!top.body.includes('\u0007'));
  assert.ok(l.data.items.length >= 4 && l.data.items.every((x, i, a) => i === 0 || a[i - 1].at >= x.at), 'newest first');
  assert.strictEqual((await j('/api/contact/list', { cookie: cB })).status, 403, 'another account cannot read the list');
  // a reply by LINE keeps the person's LINE name (so the operator knows who to answer)
  assert.strictEqual((await send({ reply: 'line', body: 'LINEで返事がほしい' }, { cookie: cB })).status, 200);
  const l2 = (await j('/api/contact/list', { cookie: cA })).data.items[0]; assert.deepStrictEqual([l2.reply, l2.contact], ['line', 'ほかの人']);
  // long text is shortened in the LINE message
  const n0 = line.pushes.length; await send({ body: 'あ'.repeat(200) }); for (let i = 0; i < 40 && line.pushes.length === n0; i++) await wait(100);
  assert.ok(line.pushes[n0].text.split('\n')[1].endsWith('…') && Array.from(line.pushes[n0].text.split('\n')[1]).length <= 81, 'shortened: ' + line.pushes[n0].text);
  // the operator unfriended the official account: no notice, the list still has it
  line.setFriend('U-admin', false); await login('U-admin', '運営者'); const n1 = line.pushes.length; await send({ body: '友だちでないとき' }); await wait(400);
  assert.strictEqual(line.pushes.length, n1, 'not a friend: no LINE notice'); assert.strictEqual((await j('/api/contact/list', { cookie: cA })).data.items[0].body, '友だちでないとき');
  // delete one
  const id = (await j('/api/contact/list', { cookie: cA })).data.items[0].id;
  assert.strictEqual((await j('/api/contact/delete', { cookie: cB, method: 'POST', body: { id } })).status, 403); assert.strictEqual((await j('/api/contact/delete', { cookie: cA, method: 'POST', body: { id: 'zz' } })).status, 400);
  assert.strictEqual((await j('/api/contact/delete', { cookie: cA, method: 'POST', body: { id } })).status, 200); assert.ok(!(await j('/api/contact/list', { cookie: cA })).data.items.some(x => x.id === id), 'deleted');

  // ---- limits: a few messages a day from one place
  { const ip = newIp(); const codes = []; for (let i = 0; i < 5; i++) codes.push((await send({ body: 'また' + i }, { ip })).status); assert.deepStrictEqual(codes, [200, 200, 200, 429, 429], 'three a day from one place: ' + codes); }
  // deleting the account removes the messages that came with it
  assert.strictEqual((await j('/api/account', { cookie: cB, method: 'DELETE' })).status, 200, 'delete the account');
  assert.ok(!(await j('/api/contact/list', { cookie: cA })).data.items.some(x => x.contact === 'ほかの人'), 'the account\'s own messages are removed with it');
  console.log('contact api tests passed');
} finally { srv.stop(); line.stop(); }
