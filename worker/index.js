import { reply, sha256hex, limited } from './util.js';
import { ACCOUNT_SCHEMA, handleAccount, purgeAccountData } from './account.js';
import { runReminders } from './reminders.js';
import { notifyOps, reachable, pictures } from './settlenotify.js';
import { lineWebhook } from './linewebhook.js';
import { CONTACT_SCHEMA, handleContact, purgeContacts } from './contact.js';

/* Tabiflow sharing API: Cloudflare Worker + D1.
   A shared trip is reachable only with its secret token (sent as `Authorization: Bearer <token>`).
   The database stores sha256(token) as the trip id, never the token itself, so a database leak does not
   reveal anyone's link. There are no accounts: whoever holds the link can read and write that one trip. */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
     budget INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (trip_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS expenses (trip_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, payer TEXT NOT NULL,
     cat TEXT NOT NULL, spent_on TEXT NOT NULL, split TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS settlements (trip_id TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL, at TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, transfers TEXT NOT NULL, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS adjustments (trip_id TEXT NOT NULL, id TEXT NOT NULL, settle_id TEXT, nets TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS paid (trip_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (trip_id, key))`,
  `CREATE TABLE IF NOT EXISTS received (trip_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (trip_id, key))`,   // the receiver's 「受け取った」 (same key as paid)
  `CREATE TABLE IF NOT EXISTS savings (trip_id TEXT NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (trip_id, member_id))`,
  `CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, w INTEGER NOT NULL, n INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (k, w))`,
  ...ACCOUNT_SCHEMA,
  ...CONTACT_SCHEMA
];
/* Columns added after the first release (CREATE TABLE IF NOT EXISTS does not add columns to an existing table). The order is kept. */
const ALTERS = [
  ['expenses', 'settle_id TEXT'],   // which round of settlement an expense belongs to (NULL = not settled yet)
  ['expenses', 'parts TEXT'],   // per-person weights of an expense (JSON, NULL = equal)
  ['members', 'note TEXT'],   // how a member wants to be paid (free text, 60 chars)
  ['expenses', 'fixed TEXT'],   // exact amounts for some people of an expense (JSON, NULL = none)
  ['expenses', 'author TEXT'], ['expenses', 'made_at INTEGER'], ['expenses', 'editor TEXT'], ['expenses', 'edited_at INTEGER'], ['expenses', 'prev TEXT'],   // 変更履歴 (who / when recorded, who / when last changed, the values before that change as JSON)
  ['trips', 'caps TEXT'],   // limits per category (JSON, NULL = none)
  ['users', 'settle_notif INTEGER NOT NULL DEFAULT 1'],   // 精算のお知らせ on/off per account
  ['users', 'over_notif INTEGER NOT NULL DEFAULT 1'], ['users', 'pic_share INTEGER NOT NULL DEFAULT 1'], ['users', 'friend_flag INTEGER NOT NULL DEFAULT 0'], ['users', 'friend_changed INTEGER'], ['users', 'friend_checked_at INTEGER'],   // official-account friend state, saved at login
  ['users', 'adv_notif INTEGER NOT NULL DEFAULT 0'], ['users', 'sv_notif INTEGER NOT NULL DEFAULT 1'],
  ['savings', 'log TEXT']   // 積立の履歴 (JSON list of { id, a, d, by }); the total (amount) stays the truth. NULL = never logged (an older app only writes the total)
];
/* The schema is made on first use. It is NOT redone at every cold start: that was ~40 database queries, and a free-plan Worker may make only ~50 per request, so a cold start
   left too little for the request itself (sync failed). A fingerprint of SCHEMA + ALTERS is kept in meta; when it matches, one query is all a cold start costs. A changed list = a new fingerprint = the migration runs once. */
const schemaVersion = (() => { const t = JSON.stringify([SCHEMA, ALTERS]); let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return 's' + h.toString(16); })();
let ready = null;
const ensure = env => ready || (ready = (async () => {
  try { const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'schema_v'").first(); if (r && r.v === schemaVersion) return; } catch (e) { /* a new database: there is no meta table yet */ }
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  for (const [t, c] of ALTERS) await env.DB.prepare('ALTER TABLE ' + t + ' ADD COLUMN ' + c).run().catch(() => { /* the column already exists */ });
  await env.DB.prepare("INSERT INTO meta(k, v) VALUES ('schema_v', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(schemaVersion).run();
})().catch(e => { ready = null; throw e; }));

const LIMITS = { members: 12, expenses: 2000, settlements: 100, adjustments: 2000, paid: 500, received: 500, body: 256 * 1024, opsPerRequest: 400 };
const WRITES_PER_10MIN = 300, CREATES_PER_DAY = 20, RETENTION_DAYS = 400;

const CATS = new Set(['transport', 'stay', 'food', 'sight', 'gift', 'other']);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isId = v => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
/* weights of an expense (units of half: 1 = 0.5x ... 6 = 3x): null/absent, or an object over people who share it */
const validParts = (p, split) => p == null || (typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length >= 1 && Object.keys(p).length <= 12 && Object.keys(p).every(k => split.indexOf(k) >= 0 && isInt(p[k], 1, 6)));
/* fixed amounts of an expense (金額の指定): null/absent, or whole yen for people who share it; they must leave something for the others (or add up to the amount when everybody is fixed) */
const validPrev = (p, split) => p == null || (typeof p === 'object' && !Array.isArray(p) && isInt(p.amount, 1, 1e9) && isId(p.payer) && Array.isArray(p.split) && p.split.length >= 1 && p.split.length <= 12 && p.split.every(isId));
const validFixed = (f, split, amount) => { if (f == null) return true; if (typeof f !== 'object' || Array.isArray(f)) return false; const ks = Object.keys(f);
  if (ks.length < 1 || ks.length > 12 || !ks.every(k => split.indexOf(k) >= 0 && isInt(f[k], 0, 1e9))) return false;
  const sum = ks.reduce((a, k) => a + f[k], 0); return sum <= amount && (ks.length < split.length || sum === amount); };
/* limits per category of a trip (カテゴリごとの上限): null/absent, or whole yen (1 or more) for known categories */
const validCaps = c => c == null || (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length >= 1 && Object.keys(c).length <= 6 && Object.keys(c).every(k => CATS.has(k) && isInt(c[k], 1, 1e9)));
/* the history of one person's savings: null/absent, or a list of { id, a (yen, minus = a correction), d (date), by (who recorded it, optional) } */
const validLog = l => l == null || (Array.isArray(l) && l.length <= 300 && l.every(x => x && typeof x === 'object' && isId(x.id) && isInt(x.a, -1e9, 1e9) && x.a !== 0 && isDate(x.d) && (x.by == null || isId(x.by))) && new Set(l.map(x => x.id)).size === l.length);
const nonEmpty = v => typeof v === 'string' && v.trim().length > 0;

/* Whitelist each row; anything unexpected rejects the whole request (nothing is applied). */
const CLEAN = {
  trips: r => isStr(r.name, 100) && nonEmpty(r.name) && isDate(r.start_date) && isDate(r.end_date) && r.end_date >= r.start_date && isInt(r.budget, 1, 1e9) && validCaps(r.caps)
    ? { name: r.name.trim(), start_date: r.start_date, end_date: r.end_date, budget: r.budget, caps: r.caps == null ? null : r.caps, has_caps: 'caps' in r } : null,
  members: r => isId(r.id) && isStr(r.name, 50) && nonEmpty(r.name) && isInt(r.position, 0, 1e6) && (r.note == null || isStr(r.note, 60))
    ? { id: r.id, name: r.name.trim(), position: r.position, note: r.note == null ? '' : r.note.trim(), has_note: 'note' in r } : null,   // 受け取り方のメモ (60字まで)
  expenses: r => { const title = r.title == null ? '' : r.title;
    return isId(r.id) && isStr(title, 100) && isInt(r.amount, 1, 1e9) && isId(r.payer) && CATS.has(r.cat) && isDate(r.spent_on) &&
      Array.isArray(r.split) && r.split.length >= 1 && r.split.length <= 12 && r.split.every(isId)
      && (r.settle_id == null || isId(r.settle_id)) && validParts(r.parts, r.split) && validFixed(r.fixed, r.split, r.amount)
      && (r.author == null || isId(r.author)) && (r.editor == null || isId(r.editor)) && (r.made_at == null || isInt(r.made_at, 0, 1e14)) && (r.edited_at == null || isInt(r.edited_at, 0, 1e14)) && validPrev(r.prev)
      ? { id: r.id, title, amount: r.amount, payer: r.payer, cat: r.cat, spent_on: r.spent_on, split: r.split, settle_id: r.settle_id == null ? null : r.settle_id, has_settle: 'settle_id' in r, parts: r.parts == null ? null : r.parts, has_parts: 'parts' in r, fixed: r.fixed == null ? null : r.fixed, has_fixed: 'fixed' in r,
        author: r.author == null ? null : r.author, made_at: r.made_at == null ? null : r.made_at, editor: r.editor == null ? null : r.editor, edited_at: r.edited_at == null ? null : r.edited_at, prev: r.prev == null ? null : { amount: r.prev.amount, payer: r.prev.payer, split: r.prev.split },
        has_log: ['author', 'made_at', 'editor', 'edited_at', 'prev'].some(k => k in r) } : null; },
  settlements: r => isId(r.id) && isInt(r.n, 1, 100000) && isDate(r.at) && isInt(r.total == null ? 0 : r.total, 0, 1e11) &&
    Array.isArray(r.transfers) && r.transfers.length <= 100 && r.transfers.every(x => x && isId(x.from) && isId(x.to) && isInt(x.amount, 1, 1e9))
    ? { id: r.id, n: r.n, at: r.at, total: r.total == null ? 0 : r.total, transfers: r.transfers.map(x => ({ from: x.from, to: x.to, amount: x.amount })) } : null,
  adjustments: r => { const nets = r.nets, ks = nets && typeof nets === 'object' && !Array.isArray(nets) ? Object.keys(nets) : null, note = r.note == null ? '' : r.note;
    return isId(r.id) && (r.settle_id == null || isId(r.settle_id)) && isStr(note, 100) && isDate(r.at) && ks && ks.length <= 12 && ks.every(k => isId(k) && isInt(nets[k], -1e9, 1e9))
      ? { id: r.id, settle_id: r.settle_id == null ? null : r.settle_id, nets: Object.fromEntries(ks.map(k => [k, nets[k]])), note, at: r.at } : null; },
  paid: r => isStr(r.key, 200) && r.key.length > 0 ? { key: r.key } : null,
  received: r => isStr(r.key, 200) && r.key.length > 0 ? { key: r.key } : null,
  savings: r => isId(r.member_id) && isInt(r.amount, 0, 1e9) && validLog(r.log) ? { member_id: r.member_id, amount: r.amount, log: r.log == null ? null : r.log.map(x => ({ id: x.id, a: x.a, d: x.d, by: x.by == null ? null : x.by })) } : null
};
const UPDATABLE = new Set(['trips', 'expenses', 'savings', 'adjustments', 'members']);   // a member row only ever changes its memo (note)
const KEYCOL = { trips: 'id', members: 'id', expenses: 'id', settlements: 'id', adjustments: 'id', paid: 'key', received: 'key', savings: 'member_id' };

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
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

async function getTrip(env, id, rev) {
  const tr = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(id).first();
  if (!tr) return reply({ error: 'not_found' }, 404);
  if (rev && Number(rev) === tr.rev) return reply({ unchanged: true, rev: tr.rev });
  const [m, e, p, rc, s, st, ad] = await env.DB.batch([
    env.DB.prepare('SELECT id,name,position,note FROM members WHERE trip_id=? ORDER BY position, id').bind(id),
    env.DB.prepare('SELECT id,title,amount,payer,cat,spent_on,split,settle_id,parts,fixed,author,made_at,editor,edited_at,prev,created_at FROM expenses WHERE trip_id=? ORDER BY created_at, id').bind(id),
    env.DB.prepare('SELECT key FROM paid WHERE trip_id=?').bind(id),
    env.DB.prepare('SELECT key FROM received WHERE trip_id=?').bind(id),
    env.DB.prepare('SELECT member_id,amount,log FROM savings WHERE trip_id=?').bind(id),
    env.DB.prepare('SELECT id,n,at,total,transfers FROM settlements WHERE trip_id=? ORDER BY n, id').bind(id),
    env.DB.prepare('SELECT id,settle_id,nets,note,at FROM adjustments WHERE trip_id=? ORDER BY at, id').bind(id)
  ]);
  // same shape the app's Sync.assemble() already reads
  return reply({ rev: tr.rev, trip: { id, name: tr.name, start_date: tr.start_date, end_date: tr.end_date, budget: tr.budget, caps: tr.caps ? JSON.parse(tr.caps) : null, owner: null,
    trip_members: m.results.map(r => ({ id: r.id, name: r.name, position: r.position, note: r.note || '', user_id: null, status: 'joined' })),
    expenses: e.results.map(r => ({ id: r.id, title: r.title, amount: r.amount, payer: r.payer, cat: r.cat, spent_on: r.spent_on, split: JSON.parse(r.split), settle_id: r.settle_id || null, parts: r.parts ? JSON.parse(r.parts) : null, fixed: r.fixed ? JSON.parse(r.fixed) : null, author: r.author || null, made_at: r.made_at || null, editor: r.editor || null, edited_at: r.edited_at || null, prev: r.prev ? JSON.parse(r.prev) : null, created_at: r.created_at })),
    settlements: st.results.map(r => ({ id: r.id, n: r.n, at: r.at, total: r.total, transfers: JSON.parse(r.transfers) })),
    adjustments: ad.results.map(r => ({ id: r.id, settle_id: r.settle_id || null, nets: JSON.parse(r.nets), note: r.note, at: r.at })),
    paid: p.results.map(r => ({ trip_id: id, key: r.key })), received: rc.results.map(r => ({ trip_id: id, key: r.key })), savings: s.results.map(r => ({ trip_id: id, member_id: r.member_id, amount: r.amount, log: r.log ? JSON.parse(r.log) : null })) } });
}

async function applyOps(env, req, id, ctx) {
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
    const c = await DB.prepare(`SELECT (SELECT COUNT(*) FROM members WHERE trip_id=?1) m, (SELECT COUNT(*) FROM expenses WHERE trip_id=?1) e, (SELECT COUNT(*) FROM paid WHERE trip_id=?1) p, (SELECT COUNT(*) FROM received WHERE trip_id=?1) rc, (SELECT COUNT(*) FROM settlements WHERE trip_id=?1) s, (SELECT COUNT(*) FROM adjustments WHERE trip_id=?1) a`).bind(id).first();
    if (c.m + (ins.members || []).length > LIMITS.members || c.e + (ins.expenses || []).length > LIMITS.expenses || c.p + (ins.paid || []).length > LIMITS.paid || c.rc + (ins.received || []).length > LIMITS.received ||
      c.s + (ins.settlements || []).length > LIMITS.settlements || c.a + (ins.adjustments || []).length > LIMITS.adjustments) return reply({ error: 'limit' }, 413);
  } else if ((ins.members || []).length > LIMITS.members || (ins.expenses || []).length > LIMITS.expenses || (ins.paid || []).length > LIMITS.paid || (ins.received || []).length > LIMITS.received ||
      (ins.settlements || []).length > LIMITS.settlements || (ins.adjustments || []).length > LIMITS.adjustments) return reply({ error: 'limit' }, 413);

  const S = [], P = s => DB.prepare(s);
  if (ins.trips) { const t = ins.trips[0]; S.push(P('INSERT OR IGNORE INTO trips(id,name,start_date,end_date,budget,rev,created_at,updated_at,caps) VALUES (?,?,?,?,?,1,?,?,?)').bind(id, t.name, t.start_date, t.end_date, t.budget, now, now, t.caps ? J(t.caps) : null)); }
  if (ins.members) S.push(P(`INSERT OR IGNORE INTO members(trip_id,id,name,position,note) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.name'), json_extract(value,'$.position'), NULLIF(json_extract(value,'$.note'), '') FROM json_each(?2)`).bind(id, J(ins.members)));
  if (ins.expenses) S.push(P(`INSERT OR IGNORE INTO expenses(trip_id,id,title,amount,payer,cat,spent_on,split,settle_id,parts,fixed,author,made_at,editor,edited_at,prev,created_at)
      SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.title'), json_extract(value,'$.amount'), json_extract(value,'$.payer'), json_extract(value,'$.cat'),
             json_extract(value,'$.spent_on'), json_extract(value,'$.split'), json_extract(value,'$.settle_id'), json_extract(value,'$.parts'), json_extract(value,'$.fixed'), json_extract(value,'$.author'), json_extract(value,'$.made_at'), json_extract(value,'$.editor'), json_extract(value,'$.edited_at'), json_extract(value,'$.prev'), ?3 * 1000 + CAST(key AS INTEGER) FROM json_each(?2)`).bind(id, J(ins.expenses), now));
  if (ins.settlements) S.push(P(`INSERT OR IGNORE INTO settlements(trip_id,id,n,at,total,transfers) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.n'), json_extract(value,'$.at'), json_extract(value,'$.total'), json_extract(value,'$.transfers') FROM json_each(?2)`).bind(id, J(ins.settlements)));
  if (ins.adjustments) S.push(P(`INSERT OR IGNORE INTO adjustments(trip_id,id,settle_id,nets,note,at) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.settle_id'), json_extract(value,'$.nets'), json_extract(value,'$.note'), json_extract(value,'$.at') FROM json_each(?2)`).bind(id, J(ins.adjustments)));
  if (ins.paid) S.push(P(`INSERT OR IGNORE INTO paid(trip_id,key) SELECT ?1, json_extract(value,'$.key') FROM json_each(?2)`).bind(id, J(ins.paid)));
  if (ins.received) S.push(P(`INSERT OR IGNORE INTO received(trip_id,key) SELECT ?1, json_extract(value,'$.key') FROM json_each(?2)`).bind(id, J(ins.received)));
  if (ins.savings) S.push(P(`INSERT OR IGNORE INTO savings(trip_id,member_id,amount,log) SELECT ?1, json_extract(value,'$.member_id'), json_extract(value,'$.amount'), json_extract(value,'$.log') FROM json_each(?2)`).bind(id, J(ins.savings)));

  if (upd.trips) { const t = upd.trips[upd.trips.length - 1]; S.push(P('UPDATE trips SET name=?1, start_date=?2, end_date=?3, budget=?4, caps = CASE WHEN ?6 = 1 THEN ?7 ELSE caps END WHERE id=?5').bind(t.name, t.start_date, t.end_date, t.budget, id, t.has_caps ? 1 : 0, t.caps ? J(t.caps) : null)); }   // an older app that does not send caps must not wipe them
  if (upd.expenses) S.push(P(`UPDATE expenses SET title=j.title, amount=j.amount, payer=j.payer, cat=j.cat, spent_on=j.spent_on, split=j.split,
      settle_id = CASE WHEN j.has_settle = 1 THEN j.settle_id ELSE expenses.settle_id END,   -- an older app that does not know about rounds must not wipe it
      parts = CASE WHEN j.has_parts = 1 THEN j.parts ELSE expenses.parts END,                 -- nor weights
      fixed = CASE WHEN j.has_fixed = 1 THEN j.fixed ELSE expenses.fixed END,                 -- nor fixed amounts
      author = CASE WHEN j.has_log = 1 THEN j.author ELSE expenses.author END,                -- nor who recorded / changed it (the history)
      made_at = CASE WHEN j.has_log = 1 THEN j.made_at ELSE expenses.made_at END,
      editor = CASE WHEN j.has_log = 1 THEN j.editor ELSE expenses.editor END,
      edited_at = CASE WHEN j.has_log = 1 THEN j.edited_at ELSE expenses.edited_at END,
      prev = CASE WHEN j.has_log = 1 THEN j.prev ELSE expenses.prev END
      FROM (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.title') AS title, json_extract(value,'$.amount') AS amount, json_extract(value,'$.payer') AS payer,
                   json_extract(value,'$.cat') AS cat, json_extract(value,'$.spent_on') AS spent_on, json_extract(value,'$.split') AS split,
                   json_extract(value,'$.settle_id') AS settle_id, json_extract(value,'$.has_settle') AS has_settle, json_extract(value,'$.parts') AS parts, json_extract(value,'$.has_parts') AS has_parts, json_extract(value,'$.fixed') AS fixed, json_extract(value,'$.has_fixed') AS has_fixed,
                   json_extract(value,'$.author') AS author, json_extract(value,'$.made_at') AS made_at, json_extract(value,'$.editor') AS editor, json_extract(value,'$.edited_at') AS edited_at, json_extract(value,'$.prev') AS prev, json_extract(value,'$.has_log') AS has_log FROM json_each(?2)) AS j
      WHERE expenses.trip_id=?1 AND expenses.id=j.id`).bind(id, J(upd.expenses)));
  if (upd.members) S.push(P(`UPDATE members SET note = NULLIF(j.note, '')
      FROM (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.note') AS note, json_extract(value,'$.has_note') AS has_note FROM json_each(?2)) AS j
      WHERE members.trip_id=?1 AND members.id=j.id AND j.has_note = 1`).bind(id, J(upd.members)));   // only the memo; an older app that does not send one cannot wipe it
  if (upd.adjustments) S.push(P(`UPDATE adjustments SET settle_id=j.settle_id
      FROM (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.settle_id') AS settle_id FROM json_each(?2)) AS j
      WHERE adjustments.trip_id=?1 AND adjustments.id=j.id`).bind(id, J(upd.adjustments)));
  if (upd.savings) S.push(P(`UPDATE savings SET amount=j.amount, log=COALESCE(j.log, savings.log)
      FROM (SELECT json_extract(value,'$.member_id') AS member_id, json_extract(value,'$.amount') AS amount, json_extract(value,'$.log') AS log FROM json_each(?2)) AS j
      WHERE savings.trip_id=?1 AND savings.member_id=j.member_id`).bind(id, J(upd.savings)));

  if (del.paid) S.push(P(`DELETE FROM paid WHERE trip_id=?1 AND key IN (SELECT json_extract(value,'$.key') FROM json_each(?2))`).bind(id, J(del.paid)));
  if (del.received) S.push(P(`DELETE FROM received WHERE trip_id=?1 AND key IN (SELECT json_extract(value,'$.key') FROM json_each(?2))`).bind(id, J(del.received)));
  if (del.savings) S.push(P(`DELETE FROM savings WHERE trip_id=?1 AND member_id IN (SELECT json_extract(value,'$.member_id') FROM json_each(?2))`).bind(id, J(del.savings)));
  if (del.expenses) S.push(P(`DELETE FROM expenses WHERE trip_id=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))`).bind(id, J(del.expenses)));
  if (del.members) S.push(P(`DELETE FROM members WHERE trip_id=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))`).bind(id, J(del.members)));
  if (del.trips) S.push(...wipe(DB, id));
  S.push(P('UPDATE trips SET rev = rev + 1, updated_at = ?2 WHERE id = ?1').bind(id, now));
  await DB.batch(S);   // one transaction: all of it or none of it
  if (ctx && ctx.waitUntil && (ins.settlements || ins.paid || ins.received || ins.expenses)) ctx.waitUntil(notifyOps(env, id, ins).catch(e => console.error('settle notify failed', e && e.message)));   // after the reply: who owes / who is owed
  const after = await DB.prepare('SELECT rev FROM trips WHERE id=?').bind(id).first();
  return reply({ ok: true, rev: after ? after.rev : 0 });
}

const wipe = (DB, id) => ['member_links', 'paid', 'received', 'savings', 'expenses', 'settlements', 'adjustments', 'members'].map(t => DB.prepare(`DELETE FROM ${t} WHERE trip_id=?`).bind(id)).concat(DB.prepare('DELETE FROM trips WHERE id=?').bind(id));

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 });
    try {
      await ensure(env);
      if (env.TEST_HOOKS === '1' && url.pathname === '/api/_test/reminders' && req.method === 'POST') { const b = await req.json(); return reply(await runReminders(env, b.now)); }   // tests only: the variable is never set in production
      if (url.pathname === '/api/line/webhook') return await lineWebhook(req, env);   // called by LINE (signed), not by the app
      if (env.TEST_HOOKS === '1' && url.pathname === '/api/_test/friend' && req.method === 'GET') { const u = await env.DB.prepare('SELECT friend_flag, friend_changed FROM users WHERE line_sub = ?').bind(url.searchParams.get('sub')).first(); return reply(u || {}); }   // tests only
      const acct = await handleAccount(req, env, url);
      if (acct) return acct;
      const ct = await handleContact(req, env, url);
      if (ct) return ct;
      const m = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') || '');
      if (!m || !TOKEN.test(m[1])) return reply({ error: 'unauthorized' }, 401);
      const id = await sha256hex(m[1]);
      if (url.pathname === '/api/trip' && req.method === 'GET') return await getTrip(env, id, url.searchParams.get('rev'));
      if (url.pathname === '/api/ops' && req.method === 'POST') return await applyOps(env, req, id, ctx);
      if (url.pathname === '/api/reach' && req.method === 'GET') { if (!(await env.DB.prepare('SELECT 1 AS x FROM trips WHERE id=?').bind(id).first())) return reply({ error: 'not_found' }, 404); return reply({ reachable: await reachable(env, id) }); }   // which members can get 精算のお知らせ
      if (url.pathname === '/api/pics' && req.method === 'GET') { if (!(await env.DB.prepare('SELECT 1 AS x FROM trips WHERE id=?').bind(id).first())) return reply({ error: 'not_found' }, 404); return reply({ pics: await pictures(env, id) }); }   // LINE profile pictures of the members who are signed in and share theirs
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
  /* hourly: send reminders. Once a day (03:00 Japan time): forget old counters and expired data. */
  async scheduled(event, env) {
    await ensure(env);
    const at = event.scheduledTime || Date.now();
    let out = null, err = null;
    try { out = await runReminders(env, at); } catch (e) { err = String(e && e.message || e).slice(0, 200); console.error('reminders failed', err); }
    try { await env.DB.prepare("INSERT INTO meta(k, v) VALUES ('last_cron', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ at, out, err })).run(); } catch (e) { /* diagnosis only */ }
    if (new Date(at).getUTCHours() !== 18) return;
    const now = Date.now();
    await env.DB.prepare('DELETE FROM hits WHERE t < ?').bind(Math.floor(now / 1000) - 2 * 86400).run();
    await purgeAccountData(env, Math.floor(now / 1000));
    await purgeContacts(env, Math.floor(now / 1000)).catch(() => {});
    const old = await env.DB.prepare('SELECT id FROM trips WHERE updated_at < ? LIMIT 200').bind(now - RETENTION_DAYS * 86400000).all();
    for (const r of old.results) await env.DB.batch(wipe(env.DB, r.id));
  }
};
