import { reply } from './util.js';

/* The official account's Webhook: LINE calls this when somebody adds the account as a friend (follow) or blocks / removes it (unfollow), so a person's friend state
   is right at once, not only at the next login. LINE signs the body with the Messaging API channel secret (HMAC-SHA256, base64, in X-Line-Signature); anything
   that is not signed that way is refused. Without the secret set, everything is refused (nothing is trusted). Only people who have logged in are touched. */
const MAX_BODY = 64 * 1024, MAX_EVENTS = 100;

async function sign(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  let s = ''; for (const b of sig) s += String.fromCharCode(b); return btoa(s);
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export async function lineWebhook(req, env) {
  if (req.method !== 'POST') return reply({ error: 'method' }, 405);
  if (!env.LINE_OA_CHANNEL_SECRET) return reply({ error: 'not_configured' }, 503);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > MAX_BODY) return reply({ error: 'too_large' }, 413);
  const given = req.headers.get('X-Line-Signature') || '';
  if (!given || !same(given, await sign(env.LINE_OA_CHANNEL_SECRET, body))) return reply({ error: 'bad_signature' }, 401);
  let data; try { data = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return reply({ error: 'invalid' }, 400); }
  const events = Array.isArray(data && data.events) ? data.events.slice(0, MAX_EVENTS) : [], now = Math.floor(Date.now() / 1000), S = [];
  for (const e of events) {
    const uid = e && e.source && e.source.type === 'user' && typeof e.source.userId === 'string' && e.source.userId.length <= 64 ? e.source.userId : null;
    if (!uid || (e.type !== 'follow' && e.type !== 'unfollow')) continue;
    S.push(env.DB.prepare('UPDATE users SET friend_flag = ?2, friend_changed = ?2, friend_checked_at = ?3 WHERE line_sub = ?1').bind(uid, e.type === 'follow' ? 1 : 0, now));
  }
  if (S.length) await env.DB.batch(S);
  return reply({ ok: true });   // LINE only needs a 200 (the "Verify" button in the console sends no events at all)
}
