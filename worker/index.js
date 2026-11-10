/* たびわり sharing API: Cloudflare Worker + D1.
   A shared trip is reachable only with its secret token (sent as `Authorization: Bearer <token>`).
   The database stores sha256(token) as the trip id, never the token itself, so a database leak does not
   reveal anyone's link. There are no accounts: whoever holds the link can read and write that one trip. */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
     budget INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (trip_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS expenses (trip_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, payer TEXT NOT NULL,
     cat TEXT NOT NULL, spent_on TEXT NOT NULL, split TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS paid (trip_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (trip_id, key))`,
  `CREATE TABLE IF NOT EXISTS savings (trip_id TEXT NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (trip_id, member_id))`,
  `CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, w INTEGER NOT NULL, n INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (k, w))`
];
let ready = null;   // schema is created on first use, so there is no separate migration step to run
const ensure = env => ready || (ready = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { ready = null; throw e; }));

const LIMITS = { members: 12, expenses: 2000, paid: 500, body: 256 * 1024, opsPerRequest: 400 };
const WRITES_PER_10MIN = 300, CREATES_PER_DAY = 20, RETENTION_DAYS = 400;

const CATS = new Set(['transport', 'stay', 'food', 'sight', 'gift', 'other']);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isId = v => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const nonEmpty = v => typeof v === 'string' && v.trim().length > 0;

/* Whitelist each row; anything unexpected rejects the whole request (nothing is applied). */
const CLEAN = {
  trips: r => isStr(r.name, 100) && nonEmpty(r.name) && isDate(r.start_date) && isDate(r.end_date) && r.end_date >= r.start_date && isInt(r.budget, 1, 1e9)
    ? { name: r.name.trim(), start_date: r.start_date, end_date: r.end_date, budget: r.budget } : null,
  members: r => isId(r.id) && isStr(r.name, 50) && nonEmpty(r.name) && isInt(r.position, 0, 1e6) ? { id: r.id, name: r.name.trim(), position: r.position } : null,
  expenses: r => { const title = r.title == null ? '' : r.title;
    return isId(r.id) && isStr(title, 100) && isInt(r.amount, 1, 1e9) && isId(r.payer) && CATS.has(r.cat) && isDate(r.spent_on) &&
      Array.isArray(r.split) && r.split.length >= 1 && r.split.length <= 12 && r.split.every(isId)
      ? { id: r.id, title, amount: r.amount, payer: r.payer, cat: r.cat, spent_on: r.spent_on, split: r.split } : null; },
  paid: r => isStr(r.key, 200) && r.key.length > 0 ? { key: r.key } : null,
  savings: r => isId(r.member_id) && isInt(r.amount, 0, 1e9) ? { member_id: r.member_id, amount: r.amount } : null
};
const UPDATABLE = new Set(['trips', 'expenses', 'savings']);
const KEYCOL = { trips: 'id', members: 'id', expenses: 'id', paid: 'key', savings: 'member_id' };

export function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > LIMITS.opsPerRequest) return null;
  const out = { ins: {}, upd: {}, del: {} };
  for (const op of ops) {
    if (!op || !CLEAN[op.table]) return null;
    const bucket = op.kind === 'insert' ? out.ins : op.kind === 'update' ? out.upd : op.kind === 'delete' ? out.del : null;
    if (!bucket || (op.kind === 'update' && !UPDATABLE.has(op.table))) return null;
    const rows = op.kind === 'insert' ? op.rows : [op.row];
    if (!Array.isArray(rows) || rows.length > 2500) return null;
    for (const r of rows) {
      if (!r || typeof r !== 'object') return null;
      // deletes only need the key; inserts and updates need the whole row
      const c = op.kind === 'delete' ? (isStr(r[KEYCOL[op.table]], 200) ? { [KEYCOL[op.table]]: r[KEYCOL[op.table]] } : null) : CLEAN[op.table](r);
      if (!c) return null;
      (bucket[op.table] = bucket[op.table] || []).push(c);
    }
  }
  return out;
}

const J = JSON.stringify;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const reply = (obj, status = 200) => new Response(J(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function limited(env, req, bucket, limit, windowSec) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const k = bucket + ':' + (await sha256hex(ip)).slice(0, 16), now = Math.floor(Date.now() / 1000), w = Math.floor(now / windowSec);
  const r = await env.DB.prepare('INSERT INTO hits(k,w,n,t) VALUES (?1,?2,1,?3) ON CONFLICT(k,w) DO UPDATE SET n=n+1, t=?3 RETURNING n').bind(k, w, now).first();
  return r.n > limit;
}

async function getTrip(env, id, rev) {
  const tr = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(id).first();
  if (!tr) return reply({ error: 'not_found' }, 404);
  if (rev && Number(rev) === tr.rev) return reply({ unchanged: true, rev: tr.rev });
  const [m, e, p, s] = await env.DB.batch([
    env.DB.prepare('SELECT id,name,position FROM members WHERE trip_id=? ORDER BY position, id').bind(id),
    env.DB.prepare('SELECT id,title,amount,payer,cat,spent_on,split,created_at FROM expenses WHERE trip_id=? ORDER BY created_at, id').bind(id),
    env.DB.prepare('SELECT key FROM paid WHERE trip_id=?').bind(id),
    env.DB.prepare('SELECT member_id,amount FROM savings WHERE trip_id=?').bind(id)
  ]);
  // same shape the app's Sync.assemble() already reads
  return reply({ rev: tr.rev, trip: { id, name: tr.name, start_date: tr.start_date, end_date: tr.end_date, budget: tr.budget, owner: null,
    trip_members: m.results.map(r => ({ id: r.id, name: r.name, position: r.position, user_id: null, status: 'joined' })),
    expenses: e.results.map(r => ({ id: r.id, title: r.title, amount: r.amount, payer: r.payer, cat: r.cat, spent_on: r.spent_on, split: JSON.parse(r.split), created_at: r.created_at })),
    paid: p.results.map(r => ({ trip_id: id, key: r.key })), savings: s.results.map(r => ({ trip_id: id, member_id: r.member_id, amount: r.amount })) } });
}

async function applyOps(env, req, id) {
  const text = await req.text();
  if (text.length > LIMITS.body) return reply({ error: 'too_large' }, 413);
  let body; try { body = JSON.parse(text); } catch (e) { return reply({ error: 'invalid' }, 400); }
  const v = validateOps(body && body.ops);
  if (!v) return reply({ error: 'invalid' }, 400);
  const { ins, upd, del } = v;
  const DB = env.DB, now = Date.now();

  const tr = await DB.prepare('SELECT rev FROM trips WHERE id=?').bind(id).first();
  if (!tr && !ins.trips) return reply({ error: 'not_found' }, 404);
  if (!tr && await limited(env, req, 'c', CREATES_PER_DAY, 86400)) return reply({ error: 'rate_limited' }, 429);
  if (await limited(env, req, 'w', WRITES_PER_10MIN, 600)) return reply({ error: 'rate_limited' }, 429);

  if (tr) {   // size caps (a retried insert counts twice here; that only errs on the safe side)
    const c = await DB.prepare(`SELECT (SELECT COUNT(*) FROM members WHERE trip_id=?1) m, (SELECT COUNT(*) FROM expenses WHERE trip_id=?1) e, (SELECT COUNT(*) FROM paid WHERE trip_id=?1) p`).bind(id).first();
    if (c.m + (ins.members || []).length > LIMITS.members || c.e + (ins.expenses || []).length > LIMITS.expenses || c.p + (ins.paid || []).length > LIMITS.paid) return reply({ error: 'limit' }, 413);
  } else if ((ins.members || []).length > LIMITS.members || (ins.expenses || []).length > LIMITS.expenses || (ins.paid || []).length > LIMITS.paid) return reply({ error: 'limit' }, 413);

  const S = [], P = s => DB.prepare(s);
  if (ins.trips) { const t = ins.trips[0]; S.push(P('INSERT OR IGNORE INTO trips(id,name,start_date,end_date,budget,rev,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)').bind(id, t.name, t.start_date, t.end_date, t.budget, now, now)); }
  if (ins.members) S.push(P(`INSERT OR IGNORE INTO members(trip_id,id,name,position) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.name'), json_extract(value,'$.position') FROM json_each(?2)`).bind(id, J(ins.members)));
  if (ins.expenses) S.push(P(`INSERT OR IGNORE INTO expenses(trip_id,id,title,amount,payer,cat,spent_on,split,created_at)
      SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.title'), json_extract(value,'$.amount'), json_extract(value,'$.payer'), json_extract(value,'$.cat'),
             json_extract(value,'$.spent_on'), json_extract(value,'$.split'), ?3 * 1000 + CAST(key AS INTEGER) FROM json_each(?2)`).bind(id, J(ins.expenses), now));
  if (ins.paid) S.push(P(`INSERT OR IGNORE INTO paid(trip_id,key) SELECT ?1, json_extract(value,'$.key') FROM json_each(?2)`).bind(id, J(ins.paid)));
  if (ins.savings) S.push(P(`INSERT OR IGNORE INTO savings(trip_id,member_id,amount) SELECT ?1, json_extract(value,'$.member_id'), json_extract(value,'$.amount') FROM json_each(?2)`).bind(id, J(ins.savings)));

  if (upd.trips) { const t = upd.trips[upd.trips.length - 1]; S.push(P('UPDATE trips SET name=?1, start_date=?2, end_date=?3, budget=?4 WHERE id=?5').bind(t.name, t.start_date, t.end_date, t.budget, id)); }
  if (upd.expenses) S.push(P(`UPDATE expenses SET title=j.title, amount=j.amount, payer=j.payer, cat=j.cat, spent_on=j.spent_on, split=j.split
      FROM (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.title') AS title, json_extract(value,'$.amount') AS amount, json_extract(value,'$.payer') AS payer,
                   json_extract(value,'$.cat') AS cat, json_extract(value,'$.spent_on') AS spent_on, json_extract(value,'$.split') AS split FROM json_each(?2)) AS j
      WHERE expenses.trip_id=?1 AND expenses.id=j.id`).bind(id, J(upd.expenses)));
  if (upd.savings) S.push(P(`UPDATE savings SET amount=j.amount
      FROM (SELECT json_extract(value,'$.member_id') AS member_id, json_extract(value,'$.amount') AS amount FROM json_each(?2)) AS j
      WHERE savings.trip_id=?1 AND savings.member_id=j.member_id`).bind(id, J(upd.savings)));

  if (del.paid) S.push(P(`DELETE FROM paid WHERE trip_id=?1 AND key IN (SELECT json_extract(value,'$.key') FROM json_each(?2))`).bind(id, J(del.paid)));
  if (del.savings) S.push(P(`DELETE FROM savings WHERE trip_id=?1 AND member_id IN (SELECT json_extract(value,'$.member_id') FROM json_each(?2))`).bind(id, J(del.savings)));
  if (del.expenses) S.push(P(`DELETE FROM expenses WHERE trip_id=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))`).bind(id, J(del.expenses)));
  if (del.members) S.push(P(`DELETE FROM members WHERE trip_id=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))`).bind(id, J(del.members)));
  if (del.trips) S.push(...wipe(DB, id));
  S.push(P('UPDATE trips SET rev = rev + 1, updated_at = ?2 WHERE id = ?1').bind(id, now));
  await DB.batch(S);   // one transaction: all of it or none of it
  const after = await DB.prepare('SELECT rev FROM trips WHERE id=?').bind(id).first();
  return reply({ ok: true, rev: after ? after.rev : 0 });
}

const wipe = (DB, id) => ['paid', 'savings', 'expenses', 'members'].map(t => DB.prepare(`DELETE FROM ${t} WHERE trip_id=?`).bind(id)).concat(DB.prepare('DELETE FROM trips WHERE id=?').bind(id));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 });
    try {
      await ensure(env);
      const m = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') || '');
      if (!m || !TOKEN.test(m[1])) return reply({ error: 'unauthorized' }, 401);
      const id = await sha256hex(m[1]);
      if (url.pathname === '/api/trip' && req.method === 'GET') return await getTrip(env, id, url.searchParams.get('rev'));
      if (url.pathname === '/api/ops' && req.method === 'POST') return await applyOps(env, req, id);
      if (url.pathname === '/api/trip' && req.method === 'DELETE') {
        if (await limited(env, req, 'w', WRITES_PER_10MIN, 600)) return reply({ error: 'rate_limited' }, 429);
        await env.DB.batch(wipe(env.DB, id)); return reply({ ok: true });
      }
      return reply({ error: 'not_found' }, 404);
    } catch (e) {
      console.error('api error', e && e.message);
      return reply({ error: 'server' }, 500);
    }
  },
  /* daily: forget old rate-limit counters, and trips nobody has touched for RETENTION_DAYS */
  async scheduled(_event, env) {
    await ensure(env);
    const now = Date.now();
    await env.DB.prepare('DELETE FROM hits WHERE t < ?').bind(Math.floor(now / 1000) - 2 * 86400).run();
    const old = await env.DB.prepare('SELECT id FROM trips WHERE updated_at < ? LIMIT 200').bind(now - RETENTION_DAYS * 86400000).all();
    for (const r of old.results) await env.DB.batch(wipe(env.DB, r.id));
  }
};
