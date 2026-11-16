/* The official account's Webhook: signed follow / unfollow events set the friend state at once; unsigned or wrongly signed ones are refused.   node test/linewebhook.api.test.mjs */
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';

const SECRET = 'oa-channel-secret-for-tests', line = await startFakeLine(9913);
const base = { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'webhook-test-secret-0123456789abcdef0123', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base, TEST_HOOKS: '1' };
const srv = await startServer(8791, { ...base, LINE_OA_CHANNEL_SECRET: SECRET }), B = srv.base;
const off = await startServer(8792, base);   // the same Worker without the secret
const sig = (body, secret = SECRET) => createHmac('sha256', secret).update(body).digest('base64');
const hook = (body, signature, server = B) => fetch(server + '/api/line/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Line-Signature': signature } : {}) }, body });
const friend = async sub => fetch(B + '/api/_test/friend?sub=' + encodeURIComponent(sub)).then(r => r.json());
const ev = (type, userId) => ({ type, timestamp: 1, source: { type: 'user', userId }, mode: 'active', webhookEventId: 'x' + Math.random(), deliveryContext: { isRedelivery: false } });
async function login(sub, name) {
  line.setIdentity(sub, name); const r = await fetch(B + '/api/auth/begin', { method: 'POST', headers: { Origin: B, 'Content-Type': 'application/json' }, body: '{}' }), b = await r.json();
  const s = await fetch(B + b.url, { redirect: 'manual' }), a = await fetch(s.headers.get('Location'), { redirect: 'manual' }); await fetch(a.headers.get('Location'), { redirect: 'manual' });
  const p = await fetch(B + '/api/auth/poll', { method: 'POST', headers: { Origin: B, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.id, secret: b.secret }) }); assert.strictEqual(p.status, 200);
}
try {
  await login('U-hook-a', 'エー');
  assert.strictEqual((await friend('U-hook-a')).friend_flag, 0, 'not a friend at first');
  let body = JSON.stringify({ destination: 'Uxxx', events: [] });
  assert.strictEqual((await hook(body, sig(body))).status, 200, 'the console "Verify" (no events) succeeds');
  body = JSON.stringify({ destination: 'Uxxx', events: [ev('follow', 'U-hook-a')] });
  assert.strictEqual((await hook(body, sig(body))).status, 200); assert.strictEqual((await friend('U-hook-a')).friend_flag, 1, 'follow: a friend now');
  body = JSON.stringify({ destination: 'Uxxx', events: [ev('unfollow', 'U-hook-a')] });
  assert.strictEqual((await hook(body, sig(body))).status, 200); assert.strictEqual((await friend('U-hook-a')).friend_flag, 0, 'unfollow: not a friend');
  // two events in one call; a person who never logged in; other kinds of events and group sources are ignored
  await login('U-hook-b', 'ビー');
  body = JSON.stringify({ events: [ev('follow', 'U-hook-a'), ev('follow', 'U-hook-b'), ev('follow', 'U-never-logged-in'), { type: 'message', source: { type: 'user', userId: 'U-hook-b' }, message: { type: 'text', text: 'hi' } }, { type: 'unfollow', source: { type: 'group', groupId: 'G1', userId: 'U-hook-b' } }] });
  assert.strictEqual((await hook(body, sig(body))).status, 200); assert.deepStrictEqual([(await friend('U-hook-a')).friend_flag, (await friend('U-hook-b')).friend_flag, (await friend('U-never-logged-in'))], [1, 1, {}], 'only logged-in users, only follow / unfollow from a person');
  // refused: no signature, wrong signature, signed with the other secret, a body that was changed after signing, bad JSON, wrong method, too large
  body = JSON.stringify({ events: [ev('unfollow', 'U-hook-b')] });
  for (const [name, s] of [['no signature', null], ['wrong signature', 'AAAA'], ['signed with another secret', sig(body, 'other')], ['the login channel secret', sig(body, line.clientSecret)]]) assert.strictEqual((await hook(body, s)).status, 401, name);
  assert.strictEqual((await hook(body + ' ', sig(body))).status, 401, 'a body changed after signing');
  assert.strictEqual((await friend('U-hook-b')).friend_flag, 1, 'nothing changed by the refused ones');
  const junk = 'not json'; assert.strictEqual((await hook(junk, sig(junk))).status, 400);
  assert.strictEqual((await fetch(B + '/api/line/webhook')).status, 405);
  const big = JSON.stringify({ events: [], pad: 'x'.repeat(70000) }); assert.strictEqual((await hook(big, sig(big))).status, 413);
  // without the secret set, everything is refused (even a "valid" signature of the empty secret)
  body = JSON.stringify({ events: [ev('follow', 'U-hook-b')] });
  assert.strictEqual((await hook(body, sig(body, ''), off.base)).status, 503); assert.strictEqual((await hook(body, null, off.base)).status, 503);
  console.log('line webhook tests passed');
} finally { srv.stop(); off.stop(); line.stop && line.stop(); process.exit(0); }
