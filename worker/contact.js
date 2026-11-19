/* お問い合わせ (v147): the form in the app -> D1 -> one LINE message to the operator (the account that claimed the operator role) + a list for the operator.
   Anyone can send (no login needed); a LINE reply is offered only to signed-in people. Not synced, not in backups. */
import { reply, sha256hex, limited } from './util.js';
import { userFrom, isAdmin, ADMIN_KEY } from './account.js';
import { linePush, uuidFrom } from './settlenotify.js';

export const CONTACT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, reply TEXT NOT NULL DEFAULT 'none', contact TEXT NOT NULL DEFAULT '', ver TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', user_id TEXT, created_at INTEGER NOT NULL)`
];
const KINDS = { howto: '使い方', bug: '不具合', idea: 'ご要望', other: 'その他' }, REPLIES = { none: 'なし', line: 'LINE', mail: 'メール' };
const PER_CALLER_PER_DAY = 3, ALL_PER_DAY = 100, MAX_BODY = 1000, MAX_LIST = 50, KEEP_DAYS = 400;
const nowSec = () => Math.floor(Date.now() / 1000);
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

/* all callers together, per day: a ceiling against a flood */
async function overAll(env) {
  const now = nowSec(), w = Math.floor(now / 86400);
  const r = await env.DB.prepare("INSERT INTO hits(k,w,n,t) VALUES ('ct-all',?1,1,?2) ON CONFLICT(k,w) DO UPDATE SET n=n+1, t=?2 RETURNING n").bind(w, now).first();
  return r.n > ALL_PER_DAY;
}
const randomId = () => { const b = crypto.getRandomValues(new Uint8Array(9)); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };
const clean = (s, max) => Array.from(String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()).slice(0, max).join('');

async function notifyOperator(env, c) {
  try {
    const adm = await env.DB.prepare('SELECT u.id, u.line_sub, u.friend_flag FROM meta m JOIN users u ON u.id = m.v WHERE m.k = ?1').bind(ADMIN_KEY).first();
    if (!adm || adm.friend_flag !== 1 || !env.LINE_OA_ACCESS_TOKEN) return;   // not claimed yet / not a friend of the official account: the list in the app still has it
    const head = clean(c.body, 80).replace(/\s+/g, ' ');
    const text = '【Tabiflow】新しいお問い合わせ（' + KINDS[c.kind] + '）\n' + head + (Array.from(c.body).length > 80 ? '…' : '') + '\n返信：' + REPLIES[c.reply];
    const st = await linePush(env, adm.line_sub, text, await uuidFrom('contact|' + c.id));
    if (st === 'not_friend') await env.DB.prepare('UPDATE users SET friend_flag = 0 WHERE id = ?1').bind(adm.id).run();
  } catch (e) { console.error('contact notify failed', e && e.message); }
}

export async function handleContact(req, env, url) {
  const p = url.pathname;
  if (!(p === '/api/contact' || p.startsWith('/api/contact/') || p === '/api/admin/claim')) return null;
  const method = req.method;
  if (method !== 'GET' && req.headers.get('Origin') !== url.origin) return reply({ error: 'origin' }, 403);   // blocks cross-site form posts
  const body = async () => { const t = await req.text(); if (t.length > 8000) return null; try { const o = JSON.parse(t); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } };

  if (p === '/api/contact' && method === 'POST') {
    const b = await body(); if (!b) return reply({ error: 'bad_request' }, 400);
    if (!KINDS[b.kind] || !REPLIES[b.reply || 'none']) return reply({ error: 'bad_request' }, 400);
    const text = clean(b.body, MAX_BODY + 1); if (!text || Array.from(text).length > MAX_BODY) return reply({ error: 'bad_request' }, 400);
    const rep = b.reply || 'none', user = rep === 'line' ? await userFrom(req, env) : null;
    let contact = '';
    if (rep === 'mail') { contact = clean(b.contact, 254); if (!EMAIL.test(contact)) return reply({ error: 'bad_contact' }, 400); }
    if (rep === 'line') { if (!user) return reply({ error: 'login_required' }, 401); contact = clean(user.name, 40); }
    const ver = /^[\w.\-]{1,20}$/.test(b.ver || '') ? b.ver : '', device = ['iPhone', 'Android', 'PC'].includes(b.device) ? b.device : '';
    if (await limited(env, req, 'ct', PER_CALLER_PER_DAY, 86400) || await overAll(env)) return reply({ error: 'rate_limited' }, 429);
    const c = { id: randomId(), kind: b.kind, body: text, reply: rep, contact, ver, device, user_id: user ? user.id : null, created_at: nowSec() };
    await env.DB.prepare('INSERT INTO contacts(id,kind,body,reply,contact,ver,device,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(c.id, c.kind, c.body, c.reply, c.contact, c.ver, c.device, c.user_id, c.created_at).run();
    await notifyOperator(env, c);
    return reply({ ok: true });
  }

  /* the operator's own list: only the account that claimed the role */
  if (p === '/api/contact/list' && method === 'GET') {
    const u = await userFrom(req, env); if (!u || !(await isAdmin(env, u.id))) return reply({ error: 'forbidden' }, 403);
    const rows = (await env.DB.prepare('SELECT id, kind, body, reply, contact, ver, device, created_at FROM contacts ORDER BY created_at DESC, rowid DESC LIMIT ?1').bind(MAX_LIST).all()).results;
    return reply({ items: rows.map(r => ({ id: r.id, kind: r.kind, body: r.body, reply: r.reply, contact: r.contact, ver: r.ver, device: r.device, at: r.created_at })) });
  }
  if (p === '/api/contact/delete' && method === 'POST') {
    const u = await userFrom(req, env); if (!u || !(await isAdmin(env, u.id))) return reply({ error: 'forbidden' }, 403);
    const b = await body(); if (!b || typeof b.id !== 'string' || !/^[0-9a-f]{18}$/.test(b.id)) return reply({ error: 'bad_request' }, 400);
    await env.DB.prepare('DELETE FROM contacts WHERE id = ?1').bind(b.id).run(); return reply({ ok: true });
  }

  /* becoming the operator: signed in + the passphrase that was put into the ADMIN_TOKEN secret on Cloudflare */
  if (p === '/api/admin/claim' && method === 'POST') {
    if (!env.ADMIN_TOKEN || String(env.ADMIN_TOKEN).length < 12) return reply({ error: 'not_configured' }, 503);
    if (await limited(env, req, 'adm', 5, 3600)) return reply({ error: 'rate_limited' }, 429);
    const u = await userFrom(req, env); if (!u) return reply({ error: 'login_required' }, 401);
    const b = await body(); if (!b || typeof b.token !== 'string' || b.token.length > 200) return reply({ error: 'bad_request' }, 400);
    const [x, y] = await Promise.all([sha256hex(b.token), sha256hex(String(env.ADMIN_TOKEN))]);
    let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);   // constant-time compare of the two hashes
    if (d !== 0) return reply({ error: 'wrong_token' }, 403);
    await env.DB.prepare('INSERT INTO meta(k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(ADMIN_KEY, u.id).run();
    return reply({ ok: true });
  }
  return reply({ error: 'not_found' }, 404);
}

export const purgeContacts = (env, now) => env.DB.prepare('DELETE FROM contacts WHERE created_at < ?1').bind(now - KEEP_DAYS * 86400).run();
