/* Web Push from a Worker: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291), with WebCrypto only.
   The VAPID key pair is created on first use and kept in D1 (private half sealed with AUTH_SECRET), so there is nothing to set up by hand. */
import { b64u, unb64u } from './util.js';
import { seal, open } from './seal.js';

const te = new TextEncoder();
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/* The subscription's endpoint is a URL the Worker will POST to, so only the real push services are accepted. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function allowedEndpoint(endpoint, env = {}) {
  let u; try { u = new URL(endpoint); } catch (e) { return false; }
  if (env.TEST_HOOKS === '1' && env.PUSH_TEST_HOST && u.host === env.PUSH_TEST_HOST) return true;   // tests only
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some(r => r.test(u.hostname)) && endpoint.length <= 600;
}
export const validKeys = k => !!k && typeof k.p256dh === 'string' && typeof k.auth === 'string' && k.p256dh.length === 87 && k.auth.length === 22 && /^[A-Za-z0-9_-]+$/.test(k.p256dh + k.auth);

/* ---- VAPID key pair ---- */
let vapidCache = null;
export async function getVapid(env) {
  if (vapidCache) return vapidCache;
  const read = async k => (await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first());
  let pub = await read('vapid_pub'), priv = await read('vapid_priv');
  if (!pub || !priv) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const rawPub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)').bind('vapid_pub', rawPub),
      env.DB.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)').bind('vapid_priv', await seal(env, 'vapid', jwk))]);   // a concurrent first request may win; we re-read below
    pub = await read('vapid_pub'); priv = await read('vapid_priv');
  }
  const privateKey = await crypto.subtle.importKey('jwk', await open(env, 'vapid', priv.v), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return (vapidCache = { publicKey: pub.v, privateKey });
}

export async function vapidHeader(vapid, audience, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(te.encode(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, te.encode(head + '.' + body));   // raw r||s, which is what ES256 JWTs use
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

/* ---- aes128gcm (RFC 8291) ---- */
const hkdf = async (ikm, salt, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));
export async function encryptPayload(p256dhB64, authB64, plaintext) {
  const ua = unb64u(p256dhB64), auth = unb64u(authB64);
  if (ua.length !== 65 || ua[0] !== 4 || auth.length !== 16) throw new Error('bad subscription keys');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(shared, auth, concat(te.encode('WebPush: info\0'), ua, asPub), 32);
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']), concat(plaintext, new Uint8Array([2]))));   // 0x02 = last record
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);   // salt | record size 4096 | key id length | key id | ciphertext
}

/* Sends one notification. Returns the push service's HTTP status (201 = accepted, 404/410 = the subscription is gone). */
export async function sendPush(env, vapid, subject, sub, message) {
  const body = await encryptPayload(sub.p256dh, sub.auth, te.encode(JSON.stringify(message)));
  const res = await fetch(sub.endpoint, { method: 'POST', body, headers: {
    Authorization: await vapidHeader(vapid, new URL(sub.endpoint).origin, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '21600', Urgency: 'normal' } });
  return res.status;
}

export function reminderMessage(kind, tripName) {
  const n = '「' + tripName + '」';
  if (kind === 'eve') return { title: '明日から ' + n, body: '予算とメンバーを、もう一度確認しておきましょう。' };
  if (kind === 'daily') return { title: '今日の支出を記録しましょう', body: n + ' — 使った分を、忘れないうちに。' };
  if (kind === 'settle') return { title: '精算を済ませましょう', body: n + ' の送金は、お済みですか？' };
  return null;
}
