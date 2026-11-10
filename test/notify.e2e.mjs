/* Browser test for notifications: the toggle in the account sheet, the subscription reaching the server, a reminder arriving encrypted.
   The browser's own push registration (which needs Google's/Apple's servers) is replaced by a stand-in; everything else is real.
   Needs playwright and a built dist/.   node test/notify.e2e.mjs */
import assert from 'node:assert';
import http from 'node:http';
import { createECDH, hkdfSync, createDecipheriv } from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const inbox = []; const pushSrv = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { inbox.push({ url: req.url, body: Buffer.concat(c) }); res.writeHead(201); res.end(); }); });
await new Promise(r => pushSrv.listen(9922, r));
const line = await startFakeLine(9911);
const srv = await startServer(8788, { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'notify-e2e-secret-0123456789abcdef012345', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base, TEST_HOOKS: '1', PUSH_TEST_HOST: 'localhost:9922' });
const base = srv.base, b = await chromium.launch(), errs = [];
const see = (p, t, ms = 9000) => p.waitForSelector('text=' + t, { timeout: ms });
const run = async iso => (await fetch(base + '/api/_test/reminders', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ now: Date.parse(iso) }) })).json();

/* a stand-in for the browser's push registration: real P-256 keys, so what the Worker encrypts can be decrypted here */
const fakePush = () => {
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  Object.defineProperty(Notification, 'permission', { get: () => (window.__denied ? 'denied' : 'granted') }); Notification.requestPermission = async () => 'granted';   // headless Chromium reports 'denied'; a real browser asks the person
  PushManager.prototype.getSubscription = async function () { return window.__sub || null; };
  PushManager.prototype.subscribe = async function (opts) {
    window.__subscribeOptions = { userVisibleOnly: opts.userVisibleOnly, keyLength: opts.applicationServerKey.byteLength };
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']), auth = crypto.getRandomValues(new Uint8Array(16));
    const keys = { p256dh: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), auth: b64u(auth) }; window.__jwk = await crypto.subtle.exportKey('jwk', kp.privateKey); window.__auth = keys.auth;
    window.__sub = { endpoint: 'http://localhost:9922/push/e2e', toJSON() { return { endpoint: this.endpoint, keys }; }, async unsubscribe() { window.__sub = null; return true; } };
    return window.__sub;
  };
};
const decrypt = (jwk, authB64, body) => {
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(jwk.d, 'base64url')); const auth = Buffer.from(authB64, 'base64url');
  const salt = body.subarray(0, 16), idlen = body[20], keyid = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(keyid), auth, Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(jwk.x ? Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]) : []), keyid]), 32));
  const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16)); const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]); return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
};
const device = async (opts = {}) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ['notifications'], serviceWorkers: 'allow', ...opts }), p = await ctx.newPage();
  await p.addInitScript(fakePush);
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  return { ctx, p };
};
const login = async p => { await p.goto(base + '/'); await p.click('[data-a=line-login]'); await p.waitForURL(/\/api\/auth\/line\/callback/); await p.click('a[href="/"]'); await see(p, 'でログイン中'); };
const newTrip = async (p, name, start, end) => { await p.click('[data-a=new]'); await p.fill('#d-name', name); await p.fill('#d-start', start); await p.fill('#d-end', end); await p.fill('#d-budget', '30000'); await p.fill('#d-me', 'あおい'); await p.click('[data-a=save-trip]'); await p.click('[data-a=home]'); };

try {
  line.setIdentity('U-notify', 'ほしい人');
  const d = await device(); await login(d.p);

  // ---- turning notifications on
  await d.p.click('[data-a=line-account]'); await see(d.p, 'この端末への通知');
  try { await see(d.p, '受け取る', 4000); } catch (e) { console.log('DEBUG', await d.p.evaluate(async () => JSON.stringify({ state: await ntfState(), push: lineAcct.push && lineAcct.push.length, perm: Notification.permission, sw: !!(await navigator.serviceWorker.getRegistration()) })), (await d.p.locator('.sheet-body').innerText()).replace(/\n+/g, ' | ')); throw e; }
  await d.p.click('[data-a=ntf-toggle]'); await see(d.p, '止める');
  assert.deepStrictEqual(await d.p.evaluate(() => window.__subscribeOptions), { userVisibleOnly: true, keyLength: 65 }, 'subscribed with the site key, as a visible-notification subscription');
  await d.p.click('[data-a=close-sheet]');

  // ---- a trip that starts on Jan 11; its backup reaches the server by itself; at 18:30 on Jan 10 (Japan time) the reminder goes out
  await newTrip(d.p, '通知テスト旅行', '2027-01-11', '2027-01-12');
  const onServer = name => d.p.evaluate(async n => (await Line.backupGet()).items.some(x => x.item.trip && x.item.trip.name === n), name);
  for (let i = 0; i < 30 && !(await onServer('通知テスト旅行')); i++) await d.p.waitForTimeout(500);
  assert.ok(await onServer('通知テスト旅行'), 'the trip was backed up automatically');
  assert.strictEqual((await run('2027-01-10T08:30:00Z')).sent, 0, '17:30 in Japan: too early');
  const r = await run('2027-01-10T09:30:00Z');
  if (r.claimed !== 1) console.log('DEBUG', JSON.stringify(r), JSON.stringify(await d.p.evaluate(async () => (await Line.backupGet()).items.map(x => ({ k: x.item.kind, n: x.item.trip && x.item.trip.name, s: x.item.trip && x.item.trip.start, e: x.item.trip && x.item.trip.end })))), 'sub:', await d.p.evaluate(() => window.__sub && window.__sub.endpoint));
  assert.deepStrictEqual([r.claimed, r.sent], [1, 1], JSON.stringify(r));
  assert.strictEqual(inbox.length, 1);
  const jwk = await d.p.evaluate(() => window.__jwk), auth = await d.p.evaluate(() => window.__auth);
  const msg = decrypt(jwk, auth, inbox.splice(0)[0].body);
  assert.deepStrictEqual([msg.title, msg.url], ['明日から 「通知テスト旅行」', './']);

  // ---- turning it off: nothing more is sent
  await d.p.click('[data-a=line-account]'); await see(d.p, '止める'); await d.p.click('[data-a=ntf-toggle]'); await see(d.p, '受け取る');
  assert.strictEqual(await d.p.evaluate(() => window.__sub), null, 'the browser subscription is removed too'); await d.p.click('[data-a=close-sheet]');
  await newTrip(d.p, 'もう一つの旅', '2027-01-11', '2027-01-12');
  for (let i = 0; i < 30 && !(await onServer('もう一つの旅')); i++) await d.p.waitForTimeout(500);
  assert.ok(await onServer('もう一つの旅'));
  assert.strictEqual((await run('2027-01-10T09:40:00Z')).sent, 0); assert.strictEqual(inbox.length, 0);

  // ---- logging out also removes this device
  await d.p.click('[data-a=line-account]'); await d.p.click('[data-a=ntf-toggle]'); await see(d.p, '止める'); await d.p.click('[data-a=line-logout]'); await see(d.p, 'ログアウトしました');
  assert.strictEqual(await d.p.evaluate(() => window.__sub), null);

  // ---- if the person has blocked notifications in the system settings, the sheet says what to do
  await login(d.p); await d.p.evaluate(() => { window.__denied = true; });
  if (await d.p.locator('.sheet-bg').count()) console.log('DEBUG sheet open after login:', (await d.p.locator('.sheet').innerText()).replace(/\n+/g, ' | ').slice(0, 200));
  await d.p.click('[data-a=line-account]'); await see(d.p, '端末の設定で、通知を許可してください。');
  assert.strictEqual(await d.p.locator('[data-a=ntf-toggle]').count(), 0); await d.p.click('[data-a=close-sheet]'); await d.p.click('[data-a=line-account]'); await d.p.click('[data-a=line-logout]'); await see(d.p, 'ログアウトしました');

  // ---- an iPhone that has not been added to the home screen cannot receive Web Push: say so instead of showing a dead button
  const ios = await device({ ...devices['iPhone 13'], serviceWorkers: 'block' }); line.setIdentity('U-notify', 'ほしい人');
  await login(ios.p); await see(ios.p, '選んだ旅行を戻す'); await ios.p.click('[data-a=close-sheet]');   // a new device is offered the restore sheet first
  await ios.p.click('[data-a=line-account]'); await see(ios.p, 'ホーム画面に追加すると、通知を使えます。');
  assert.strictEqual(await ios.p.locator('[data-a=ntf-toggle]').count(), 0);

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('notify e2e passed');
} finally { await b.close(); srv.stop(); line.stop(); pushSrv.close(); }
