/* Web Push building blocks: payload encryption (RFC 8291), VAPID header (RFC 8292), endpoint allow-list.   node test/push.test.mjs
   The receiver side below is written separately, with Node's own crypto, the way a browser's push client does it. */
import assert from 'node:assert';
import { createECDH, hkdfSync, createDecipheriv, randomBytes } from 'node:crypto';
import { encryptPayload, vapidHeader, allowedEndpoint, validKeys, reminderMessage } from '../worker/push.js';
import { b64u, unb64u } from '../worker/util.js';
import { dueKinds, jstParts } from '../worker/reminders.js';

const subscriber = () => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16); return { ecdh, auth, p256dh: b64u(ecdh.getPublicKey()), authB64: b64u(auth) }; };
function receive(sub, body) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], keyid = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.strictEqual(rs, 4096); assert.strictEqual(idlen, 65);
  const shared = sub.ecdh.computeSecret(keyid), ua = sub.ecdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync('sha256', shared, sub.auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, keyid]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, 'last-record delimiter'); return plain.subarray(0, plain.length - 1).toString('utf8');
}

// ---- payload round trip, including Japanese text and a payload near the single-record limit
const s = subscriber(), msg = JSON.stringify(reminderMessage('eve', '箱根 紅葉旅行'));
assert.strictEqual(receive(s, Buffer.from(await encryptPayload(s.p256dh, s.authB64, new TextEncoder().encode(msg)))), msg);
const big = 'あ'.repeat(1200);                                                  // 3600 bytes
assert.strictEqual(receive(s, Buffer.from(await encryptPayload(s.p256dh, s.authB64, new TextEncoder().encode(big)))), big);
// a different subscriber cannot read it
const other = subscriber(); const body = Buffer.from(await encryptPayload(s.p256dh, s.authB64, new TextEncoder().encode(msg)));
assert.throws(() => receive(other, body));
// every message is encrypted with fresh randomness
assert.notDeepStrictEqual(await encryptPayload(s.p256dh, s.authB64, new Uint8Array([1])), await encryptPayload(s.p256dh, s.authB64, new Uint8Array([1])));
// bad keys are refused
await assert.rejects(() => encryptPayload('AAAA', s.authB64, new Uint8Array([1]))); await assert.rejects(() => encryptPayload(s.p256dh, 'AAAA', new Uint8Array([1])));

// ---- VAPID header: ES256 signature that verifies with the advertised public key, correct claims
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapid = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateKey: kp.privateKey };
const h = await vapidHeader(vapid, 'https://fcm.googleapis.com', 'https://tabiwari.example', 1_800_000_000);
const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h); assert.ok(m, h);
const [, head, claims, sig, k] = m; assert.strictEqual(k, vapid.publicKey);
assert.deepStrictEqual(JSON.parse(Buffer.from(unb64u(head)).toString()), { typ: 'JWT', alg: 'ES256' });
assert.deepStrictEqual(JSON.parse(Buffer.from(unb64u(claims)).toString()), { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'https://tabiwari.example' });
assert.strictEqual(unb64u(sig).length, 64, 'raw r||s, not DER');
const pub = await crypto.subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(sig), new TextEncoder().encode(head + '.' + claims)));
assert.ok(!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(sig), new TextEncoder().encode(head + '.' + claims + 'x'))));

// ---- only real push services are ever contacted
for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QAbc', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.ok(allowedEndpoint(ok), ok);
for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://localhost:8080/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com:8443/x', 'not a url', 'https://notify.windows.com.evil.io/x']) assert.ok(!allowedEndpoint(bad), bad);
assert.ok(allowedEndpoint('http://localhost:9922/p', { TEST_HOOKS: '1', PUSH_TEST_HOST: 'localhost:9922' })); assert.ok(!allowedEndpoint('http://localhost:9922/p', { PUSH_TEST_HOST: 'localhost:9922' }), 'test host needs TEST_HOOKS');
assert.ok(validKeys({ p256dh: s.p256dh, auth: s.authB64 })); assert.ok(!validKeys({ p256dh: 'x', auth: 'y' })); assert.ok(!validKeys(null));
assert.strictEqual(reminderMessage('nope', 'x'), null); assert.match(reminderMessage('daily', 'A').title, /記録/); assert.match(reminderMessage('settle', 'A').title, /精算/);

// ---- when each reminder is due (Japan time)
{
  const at = iso => jstParts(Date.parse(iso));
  assert.deepStrictEqual(at('2026-12-01T09:30:00Z'), { today: '2026-12-01', tomorrow: '2026-12-02', yesterday: '2026-11-30', hour: 18 }, '09:30Z is 18:30 in Japan');
  assert.deepStrictEqual(at('2026-12-31T15:30:00Z'), { today: '2027-01-01', tomorrow: '2027-01-02', yesterday: '2026-12-31', hour: 0 }, 'the day rolls over at 15:00Z');
  const none = { total: 0, onToday: 0 }, some = { total: 3, onToday: 0 }, today = { total: 3, onToday: 1 };
  const T = (iso) => at(iso), trip = (start, end) => ({ start, end });
  assert.deepStrictEqual(dueKinds(trip('2026-12-02', '2026-12-04'), T('2026-12-01T09:00:00Z'), none), ['eve'], 'the evening before, from 18:00');
  assert.deepStrictEqual(dueKinds(trip('2026-12-02', '2026-12-04'), T('2026-12-01T08:59:00Z'), none), [], 'not before 18:00');
  assert.deepStrictEqual(dueKinds(trip('2026-12-02', '2026-12-04'), T('2026-12-02T09:00:00Z'), none), [], 'not on the first day as an "eve"');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-01T11:00:00Z'), some), ['daily'], 'during the trip from 20:00, nothing logged today');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-01T11:00:00Z'), today), [], 'something is logged today: no nagging');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-01T10:59:00Z'), none), [], 'not before 20:00');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-03T11:00:00Z'), none), ['daily'], 'also on the last day');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-04T01:00:00Z'), some), ['settle'], 'the morning after the trip, from 10:00');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-04T00:59:00Z'), some), [], 'not before 10:00');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-04T01:00:00Z'), none), [], 'no settling when nothing was spent');
  assert.deepStrictEqual(dueKinds(trip('2026-12-01', '2026-12-03'), T('2026-12-05T01:00:00Z'), some), [], 'nothing two days after');
}
console.log('push tests passed');
