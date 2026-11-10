/* LINE Login + encrypted trip backups for the Worker.
   Secrets (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets, all as "Secret"):
     LINE_CHANNEL_ID, LINE_CHANNEL_SECRET   from the LINE Developers console (LINE Login channel)
     AUTH_SECRET                            any random string of 32+ characters; signs nothing, but is the root of the backup encryption key
   Nothing here runs until all three are set: /api/me then reports { login: false } and the app hides the login UI.

   Login uses a polling hand-off: the app asks for an "attempt", sends the person to LINE, and keeps polling with a secret only it holds.
   That works even when LINE opens in a different browser context than the home-screen app (common on iPhone). */
import { reply, sha256hex, limited, randomToken } from './util.js';
import { seal, open } from './seal.js';
import { getVapid, allowedEndpoint, validKeys } from './push.js';

export const ACCOUNT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, line_sub TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_login INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS backups (user_id TEXT NOT NULL, trip_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, trip_id))`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id)`,
  `CREATE TABLE IF NOT EXISTS notif_log (user_id TEXT NOT NULL, trip_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (user_id, trip_id, kind, day))`
];

const SESSION_SECONDS = 90 * 86400, ATTEMPT_SECONDS = 600, INACTIVE_ACCOUNT_DAYS = 400;
const BACKUP = { items: 100, itemBytes: 200000, bodyBytes: 600000, perRequest: 20 };
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const isId = v => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v);
const nowSec = () => Math.floor(Date.now() / 1000);

export const configured = env => !!(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET && typeof env.AUTH_SECRET === 'string' && env.AUTH_SECRET.length >= 32);
const lineAuth = env => env.LINE_AUTH_BASE || 'https://access.line.me';   // overridable so tests can use a stand-in
const lineApi = env => env.LINE_API_BASE || 'https://api.line.me';

const page = (title, msg, status = 200) => new Response(
  `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;background:#eef2f7;color:#0e2238;margin:0;padding:48px 20px;text-align:center;line-height:1.7">` +
  `<h1 style="font-size:20px">${title}</h1><p style="color:#5b6b80">${msg}</p>` +
  `<p><a href="/" style="display:inline-block;background:#ffc83d;color:#2a1d00;font-weight:700;padding:12px 24px;border-radius:14px;text-decoration:none">たびわりに戻る</a></p></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

const cookieHeader = (token, req, maxAge) => 'tw_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (new URL(req.url).protocol === 'https:' ? '; Secure' : '');

async function userFrom(req, env) {
  const m = /(?:^|;\s*)tw_session=([A-Za-z0-9_-]{20,80})/.exec(req.headers.get('Cookie') || '');
  if (!m) return null;
  return env.DB.prepare('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1 AND s.expires_at > ?2').bind(await sha256hex(m[1]), nowSec()).first();
}

function validItem(item) {
  if (!item || typeof item !== 'object' || JSON.stringify(item).length > BACKUP.itemBytes) return false;
  if (item.kind === 'shared') return typeof item.token === 'string' && TOKEN.test(item.token) && typeof item.name === 'string';
  if (item.kind === 'local') { const t = item.trip; return !!t && typeof t === 'object' && typeof t.name === 'string' && Array.isArray(t.members) && Array.isArray(t.expenses); }
  return false;
}

async function backupGet(env, user) {
  const rows = await env.DB.prepare('SELECT trip_id, data, updated_at FROM backups WHERE user_id = ? ORDER BY updated_at DESC').bind(user.id).all();
  const items = [];
  for (const r of rows.results) { try { items.push({ id: r.trip_id, updated_at: r.updated_at, item: await open(env, user.id + '|' + r.trip_id, r.data) }); } catch (e) { /* unreadable row (e.g. AUTH_SECRET was changed): skip */ } }
  return reply({ items });
}

async function backupPut(req, env, user) {
  const text = await req.text();
  if (text.length > BACKUP.bodyBytes) return reply({ error: 'too_large' }, 413);
  let body; try { body = JSON.parse(text); } catch (e) { return reply({ error: 'invalid' }, 400); }
  const up = Array.isArray(body && body.upsert) ? body.upsert : [], rm = Array.isArray(body && body.remove) ? body.remove : [];
  if (!up.length && !rm.length) return reply({ error: 'invalid' }, 400);
  if (up.length > BACKUP.perRequest || rm.length > BACKUP.perRequest) return reply({ error: 'invalid' }, 400);
  if (!up.every(x => x && isId(x.id) && validItem(x.item)) || !rm.every(isId)) return reply({ error: 'invalid' }, 400);
  if (await limited(env, req, 'b', 120, 600)) return reply({ error: 'rate_limited' }, 429);

  const have = new Set((await env.DB.prepare('SELECT trip_id FROM backups WHERE user_id = ?').bind(user.id).all()).results.map(r => r.trip_id));
  rm.forEach(id => have.delete(id)); up.forEach(x => have.add(x.id));
  if (have.size > BACKUP.items) return reply({ error: 'limit' }, 413);

  const now = nowSec(), S = [];
  for (const x of up) S.push(env.DB.prepare('INSERT INTO backups(user_id,trip_id,data,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id,trip_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
    .bind(user.id, x.id, await seal(env, user.id + '|' + x.id, x.item), now));
  for (const id of rm) S.push(env.DB.prepare('DELETE FROM backups WHERE user_id = ?1 AND trip_id = ?2').bind(user.id, id));
  await env.DB.batch(S);
  return reply({ ok: true, count: have.size });
}

async function lineCallback(url, env) {
  const code = url.searchParams.get('code'), id = url.searchParams.get('state');
  if (!isId(id)) return page('ログインできませんでした', 'もう一度、アプリからやり直してください。', 400);
  const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first();
  if (!att || att.status !== 'pending' || att.created_at < nowSec() - ATTEMPT_SECONDS) return page('ログインできませんでした', '時間が過ぎたか、すでに使われています。アプリからやり直してください。', 400);
  if (url.searchParams.get('error') || !code) { await env.DB.prepare("UPDATE attempts SET status='denied' WHERE id=?").bind(id).run(); return page('ログインをやめました', 'LINEでの許可がありませんでした。', 200); }
  try {
    const redirect = url.origin + '/api/auth/line/callback';
    const tok = await fetch(lineApi(env) + '/oauth2/v2.1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET }) });
    if (!tok.ok) throw new Error('token ' + tok.status);
    const { id_token } = await tok.json();
    const ver = await fetch(lineApi(env) + '/oauth2/v2.1/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token, client_id: env.LINE_CHANNEL_ID, nonce: att.nonce }) });
    if (!ver.ok) throw new Error('verify ' + ver.status);
    const c = await ver.json();
    if (typeof c.sub !== 'string' || !c.sub || String(c.aud) !== String(env.LINE_CHANNEL_ID)) throw new Error('claims');
    const name = typeof c.name === 'string' ? c.name.slice(0, 60) : '', picture = '', now = nowSec();   // the profile picture is not kept: the app does not use it
    let u = await env.DB.prepare('SELECT id FROM users WHERE line_sub = ?').bind(c.sub).first();
    if (!u) { u = { id: randomToken(16) }; await env.DB.prepare('INSERT INTO users(id,line_sub,name,picture,created_at,last_login) VALUES (?,?,?,?,?,?)').bind(u.id, c.sub, name, picture, now, now).run(); }
    else await env.DB.prepare('UPDATE users SET name=?, picture=?, last_login=? WHERE id=?').bind(name, picture, now, u.id).run();
    await env.DB.prepare("UPDATE attempts SET status='done', user_id=? WHERE id=? AND status='pending'").bind(u.id, id).run();
    return page('ログインできました', 'このページを閉じて、たびわりのアプリに戻ってください。自動で、ログインが完了します。');
  } catch (e) {
    console.error('line login failed', e && e.message);
    return page('ログインできませんでした', 'LINEとの通信に失敗しました。しばらくしてから、もう一度お試しください。', 502);
  }
}

export async function handleAccount(req, env, url) {
  const p = url.pathname;
  if (!(p === '/api/me' || p.startsWith('/api/auth/') || p.startsWith('/api/push/') || p === '/api/backup' || p === '/api/account')) return null;
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD' && req.headers.get('Origin') !== url.origin) return reply({ error: 'origin' }, 403);   // blocks cross-site form posts
  const on = configured(env);

  if (p === '/api/me' && method === 'GET') { const u = on ? await userFrom(req, env) : null; return reply({ login: on, user: u ? { name: u.name } : null, push: u ? (await getVapid(env)).publicKey : null }); }
  if (!on) return reply({ error: 'not_configured' }, 503);

  if (p === '/api/auth/begin' && method === 'POST') {
    if (await limited(env, req, 'a', 20, 3600)) return reply({ error: 'rate_limited' }, 429);
    const id = randomToken(18), secret = randomToken(24), nonce = randomToken(18);
    await env.DB.prepare("INSERT INTO attempts(id,secret_hash,nonce,status,created_at) VALUES (?,?,?,'pending',?)").bind(id, await sha256hex(secret), nonce, nowSec()).run();
    return reply({ id, secret, url: '/api/auth/line/start?a=' + id });
  }
  if (p === '/api/auth/line/start' && method === 'GET') {
    const id = url.searchParams.get('a');
    const att = isId(id) ? await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first() : null;
    if (!att || att.status !== 'pending' || att.created_at < nowSec() - ATTEMPT_SECONDS) return page('ログインできませんでした', '時間が過ぎたか、すでに使われています。アプリからやり直してください。', 400);
    const q = new URLSearchParams({ response_type: 'code', client_id: env.LINE_CHANNEL_ID, redirect_uri: url.origin + '/api/auth/line/callback', state: id, scope: 'profile openid', nonce: att.nonce });
    return new Response(null, { status: 302, headers: { Location: lineAuth(env) + '/oauth2/v2.1/authorize?' + q, 'Cache-Control': 'no-store' } });
  }
  if (p === '/api/auth/line/callback' && method === 'GET') return lineCallback(url, env);
  if (p === '/api/auth/poll' && method === 'POST') {
    let b; try { b = await req.json(); } catch (e) { return reply({ error: 'invalid' }, 400); }
    if (!b || !isId(b.id) || typeof b.secret !== 'string' || b.secret.length > 100) return reply({ error: 'invalid' }, 400);
    const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(b.id).first();
    if (!att || att.secret_hash !== await sha256hex(b.secret) || att.created_at < nowSec() - ATTEMPT_SECONDS || att.status === 'denied') return reply({ error: 'gone' }, 410);
    if (att.status === 'pending') return reply({ pending: true });
    const token = randomToken(32);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,?)').bind(await sha256hex(token), att.user_id, nowSec() + SESSION_SECONDS),
      env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(b.id)]);
    return reply({ ok: true }, 200, { 'Set-Cookie': cookieHeader(token, req, SESSION_SECONDS) });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    const m = /(?:^|;\s*)tw_session=([A-Za-z0-9_-]{20,80})/.exec(req.headers.get('Cookie') || '');
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256hex(m[1])).run();
    return reply({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', req, 0) });
  }

  const user = await userFrom(req, env);
  if (!user) return reply({ error: 'unauthorized' }, 401);
  if (p === '/api/backup' && method === 'GET') return backupGet(env, user);
  if (p === '/api/backup' && method === 'PUT') return backupPut(req, env, user);
  if (p === '/api/push/subscribe' && method === 'POST') {
    let b; try { b = await req.json(); } catch (e) { return reply({ error: 'invalid' }, 400); }
    if (!b || !allowedEndpoint(b.endpoint, env) || !validKeys(b.keys)) return reply({ error: 'invalid' }, 400);
    if (await limited(env, req, 'p', 60, 600)) return reply({ error: 'rate_limited' }, 429);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?1 AND endpoint != ?2').bind(user.id, b.endpoint).first();
    if (n.n >= 10) return reply({ error: 'limit' }, 413);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO push_subs(endpoint, user_id, p256dh, auth, created_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')   // a shared device switches owner
        .bind(b.endpoint, user.id, b.keys.p256dh, b.keys.auth, nowSec()),
      env.DB.prepare("INSERT INTO meta(k, v) VALUES ('origin', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(url.origin)]);
    return reply({ ok: true });
  }
  if (p === '/api/push/unsubscribe' && method === 'POST') {
    let b; try { b = await req.json(); } catch (e) { return reply({ error: 'invalid' }, 400); }
    if (!b || typeof b.endpoint !== 'string') return reply({ error: 'invalid' }, 400);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?1 AND user_id = ?2').bind(b.endpoint, user.id).run();
    return reply({ ok: true });
  }
  if (p === '/api/account' && method === 'DELETE') {
    await env.DB.batch(['backups', 'sessions', 'attempts', 'push_subs', 'notif_log'].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)).concat(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)));
    return reply({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', req, 0) });
  }
  return reply({ error: 'not_found' }, 404);
}

/* daily cleanup: expired sessions, stale login attempts, accounts nobody has used for INACTIVE_ACCOUNT_DAYS (with their backups) */
export async function purgeAccountData(env, now) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM attempts WHERE created_at < ?').bind(now - 86400),
    env.DB.prepare('DELETE FROM notif_log WHERE t < ?').bind(now - 3 * 86400),
    env.DB.prepare('DELETE FROM push_subs WHERE user_id IN (SELECT id FROM users WHERE last_login < ?1)').bind(now - INACTIVE_ACCOUNT_DAYS * 86400),
    env.DB.prepare('DELETE FROM backups WHERE user_id IN (SELECT id FROM users WHERE last_login < ?1)').bind(now - INACTIVE_ACCOUNT_DAYS * 86400),
    env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE last_login < ?1)').bind(now - INACTIVE_ACCOUNT_DAYS * 86400),
    env.DB.prepare('DELETE FROM users WHERE last_login < ?1').bind(now - INACTIVE_ACCOUNT_DAYS * 86400)
  ]);
}
