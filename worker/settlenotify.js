/* Settlement notifications: tell the person who owes (a round was confirmed, and again once after two days if still unpaid)
   and the person who is owed (a transfer was marked paid). A shared-trip member can be reached only after a signed-in person
   linked their LINE account to that member (member_links) and turned notifications on for a device (push_subs).
   Every (person, notification) is claimed in notif_log before sending, so it goes out once. */
import { getVapid, sendPush, allowedEndpoint } from './push.js';
import { splitShares } from './split.js';

const MAX_SENDS = 15, ADV_PER_DAY = 5;   // 立て替えのお知らせ: at most this many per person per (Japan) day
const lineApi = env => env.LINE_API_BASE || 'https://api.line.me';   // outgoing requests per call; the free plan allows ~50 per invocation and the hourly job has its own share
const yen = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
export const messages = {
  settle: (trip, to, amount) => ({ title: '精算のお知らせ', body: trip + 'の精算ができました。' + to + 'さんに ' + yen(amount) + ' を送ってください。' }),
  paid: (from, amount) => ({ title: '支払いのお知らせ', body: from + 'さんが ' + yen(amount) + ' を支払いました。' }),
  advance: (trip, payer, amount, share) => ({ title: '立て替えのお知らせ', body: trip + '：' + payer + 'さんが ' + yen(amount) + ' を立て替えました。あなたの分は ' + yen(share) + ' です。' }),
  again: (trip, to, amount) => ({ title: '精算のお知らせ', body: trip + 'の精算の、' + to + 'さんへの ' + yen(amount) + ' は、お済みですか。' })
};

/* "<round>:<from>-<to>-<amount>" (round 1 has no prefix). Member ids may contain '-', so match against the real ids. */
export function parsePaidKey(key, memberIds) {
  const m = /^(?:\d+:)?(.+)-(\d+)$/.exec(key);
  if (!m) return null;
  for (const a of memberIds) if (m[1].startsWith(a + '-')) { const b = m[1].slice(a.length + 1); if (memberIds.indexOf(b) >= 0) return { from: a, to: b, amount: Number(m[2]) }; }
  return null;
}
export const payKey = (n, x) => { const b = x.from + '-' + x.to + '-' + x.amount; return n === 1 ? b : n + ':' + b; };

/* member id -> { userId, lineSub, friend, subs[] } for the members who have 精算のお知らせ on and can be reached by an app notification or, as a friend of the official account, by LINE */
async function recipients(env, tripId) {
  const rows = (await env.DB.prepare('SELECT l.member_id, l.user_id, u.line_sub, u.friend_flag, u.settle_notif, u.adv_notif, p.endpoint, p.p256dh, p.auth FROM member_links l JOIN users u ON u.id = l.user_id LEFT JOIN push_subs p ON p.user_id = l.user_id WHERE l.trip_id = ?1').bind(tripId).all()).results;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.member_id)) out.set(r.member_id, { userId: r.user_id, lineSub: r.line_sub, settle: r.settle_notif !== 0, adv: r.adv_notif === 1, friend: r.friend_flag === 1 && !!env.LINE_OA_ACCESS_TOKEN, subs: [] });
    if (r.endpoint && allowedEndpoint(r.endpoint, env)) out.get(r.member_id).subs.push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth });
  }
  for (const [k, v] of out) if (!v.subs.length && !v.friend) out.delete(k);
  return out;
}
export async function reachable(env, tripId) { return [...(await recipients(env, tripId)).entries()].filter(([, v]) => v.settle).map(([k]) => k); }
/* member id -> LINE profile picture URL, for the members of a shared trip who signed in with LINE and share their picture (an account setting, on by default) */
export async function pictures(env, tripId) {
  const rows = (await env.DB.prepare("SELECT l.member_id, u.picture FROM member_links l JOIN users u ON u.id = l.user_id WHERE l.trip_id = ?1 AND u.picture != '' AND u.pic_share != 0").bind(tripId).all()).results || [];
  const out = {}; for (const r of rows) out[r.member_id] = r.picture; return out;
}

/* What this person's own account looks like to the settlement notices: friend state, the switch, the members they are linked to, and whether the official account can send at all. Own data only. */
export async function notifyReport(env, userId) {
  const u = await env.DB.prepare('SELECT friend_flag, settle_notif FROM users WHERE id = ?1').bind(userId).first();
  const links = (await env.DB.prepare('SELECT t.name AS trip, m.name AS me FROM member_links l JOIN trips t ON t.id = l.trip_id LEFT JOIN members m ON m.trip_id = l.trip_id AND m.id = l.member_id WHERE l.user_id = ?1 ORDER BY t.name LIMIT 8').bind(userId).all()).results || [];
  const lp = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_line_push'").first(); let last = null; try { last = lp ? JSON.parse(lp.v) : null; } catch (e) { /* ignore */ }
  return { last, friend: !!u && u.friend_flag === 1, settle: !u || u.settle_notif !== 0, oa: !!env.LINE_OA_ACCESS_TOKEN, links: links.map(x => ({ trip: x.trip, me: x.me || '' })) };
}

/* The last answer of the official account's push API (the status number and the time only), so "why did no LINE message arrive" can be answered from the app. */
async function noteLinePush(env, status) {
  try { await env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('last_line_push', ?1)").bind(JSON.stringify({ at: Math.floor(Date.now() / 1000), status })).run(); } catch (e) { /* diagnostics only */ }
}

/* Push from the official account to a friend. 'ok' | 'not_friend' (blocked or never added: stop trying) | 'retry' */
async function linePush(env, to, text, retryKey) {
  try {
    const r = await fetch(lineApi(env) + '/v2/bot/message/push', { method: 'POST', headers: { Authorization: 'Bearer ' + env.LINE_OA_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }) });
    await noteLinePush(env, r.status);
    if (r.ok || r.status === 409) return 'ok';   // 409: this retry key was already accepted
    return r.status === 400 || r.status === 403 ? 'not_friend' : 'retry';
  } catch (e) { await noteLinePush(env, 0); return 'retry'; }
}
const uuidFrom = async s => { const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32); };

/* events: [{ member, kind, msg }]. Returns how many notifications went out. */
export async function deliver(env, tripId, events, nowSec = Math.floor(Date.now() / 1000)) {
  if (!events.length) return 0;
  const rc = await recipients(env, tripId); if (!rc.size) return 0;
  const origin = await env.DB.prepare("SELECT v FROM meta WHERE k = 'origin'").first(); if (!origin) return 0;
  const ok = e => { const w = rc.get(e.member); return !!w && (e.kind.startsWith('a:') ? w.adv : w.settle); };   // each kind has its own switch
  let mine = events.filter(ok).slice(0, 40);
  if (mine.some(e => e.kind.startsWith('a:'))) {   // 立て替え: a daily cap per person, so a busy day cannot flood anybody (or the official account's message allowance)
    const dayStart = nowSec - ((nowSec + 9 * 3600) % 86400), used = new Map();
    for (const r of (await env.DB.prepare("SELECT user_id, COUNT(*) AS n FROM notif_log WHERE kind LIKE 'a:%' AND t >= ?1 GROUP BY user_id").bind(dayStart).all()).results || []) used.set(r.user_id, r.n);
    mine = mine.filter(e => { if (!e.kind.startsWith('a:')) return true; const u = rc.get(e.member).userId, n = used.get(u) || 0; if (n >= ADV_PER_DAY) return false; used.set(u, n + 1); return true; });
  }
  if (!mine.length) return 0;
  const res = await env.DB.batch(mine.map(e => env.DB.prepare("INSERT OR IGNORE INTO notif_log(user_id, trip_id, kind, day, t) VALUES (?1, ?2, ?3, '-', ?4)").bind(rc.get(e.member).userId, tripId, e.kind, nowSec)));
  const vapid = await getVapid(env);
  let budget = MAX_SENDS, sent = 0;
  for (let i = 0; i < mine.length; i++) {
    if (!res[i].meta.changes) continue;   // already sent
    const e = mine[i], who = rc.get(e.member);
    const release = () => env.DB.prepare("DELETE FROM notif_log WHERE user_id = ?1 AND trip_id = ?2 AND kind = ?3 AND day = '-'").bind(who.userId, tripId, e.kind).run();
    const viaLine = (e.kind.startsWith('s:') || e.kind.startsWith('a:')) && who.friend;   // a confirmed round and an advance fall back to the official account
    if (who.subs.length + (viaLine ? 1 : 0) > budget) { await release(); continue; }
    let delivered = false;
    for (const s of who.subs) {
      budget--;
      try {
        const st = await sendPush(env, vapid, origin.v, s, { ...e.msg, url: './?trip=' + tripId + '&tab=settle' });
        if (st >= 200 && st < 300) { delivered = true; sent++; }
        else if (st === 404 || st === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(s.endpoint).run();
      } catch (err) { /* try the next device */ }
    }
    if (!delivered && viaLine) {   // no app notification got through: the official account, for people who added it as a friend
      budget--;
      const st = await linePush(env, who.lineSub, '【たびわり】' + e.msg.body, await uuidFrom(tripId + '|' + e.kind + '|' + who.userId));
      if (st === 'ok') { delivered = true; sent++; }
      else if (st === 'not_friend') await env.DB.prepare('UPDATE users SET friend_flag = 0 WHERE id = ?1').bind(who.userId).run();   // blocked or unfriended: ask again at the next login
    }
    if (!delivered) await release();
  }
  return sent;
}

/* After a write to a shared trip: a new round -> tell who owes; a new "paid" mark -> tell who is owed. */
export async function notifyOps(env, tripId, ins) {
  const adv = (ins.expenses || []).length >= 1 && ins.expenses.length <= 5 ? ins.expenses.filter(e => e && !e.settle_id && e.amount > 0 && Array.isArray(e.split)) : [];   // a bulk write (first sync, import) is not an advance
  if (!(ins.settlements && ins.settlements.length) && !(ins.paid && ins.paid.length) && !adv.length) return 0;
  const [tr, ms] = await Promise.all([env.DB.prepare('SELECT name FROM trips WHERE id = ?1').bind(tripId).first(), env.DB.prepare('SELECT id, name FROM members WHERE trip_id = ?1').bind(tripId).all()]);
  if (!tr) return 0;
  const name = id => { const m = ms.results.find(x => x.id === id); return m ? m.name : '誰か'; }, ids = ms.results.map(m => m.id), ev = [];
  for (const st of ins.settlements || []) for (const x of st.transfers) ev.push({ member: x.from, kind: 's:' + st.id + ':' + x.from + ':' + x.to, msg: messages.settle(tr.name, name(x.to), x.amount) });
  for (const x of adv) {
    const sh = splitShares(x.amount, x.split, x.id, x.parts || null, x.fixed || null);
    for (const [mid, amt] of sh) if (mid !== x.payer && amt > 0 && ids.indexOf(mid) >= 0) ev.push({ member: mid, kind: 'a:' + x.id, msg: messages.advance(tr.name, name(x.payer), x.amount, amt) });
  }
  for (const p of ins.paid || []) { const k = parsePaidKey(p.key, ids); if (k) ev.push({ member: k.to, kind: 'p:' + p.key, msg: messages.paid(name(k.from), k.amount) }); }
  return deliver(env, tripId, ev);
}

/* hourly: a round confirmed two to three days ago with transfers still unpaid -> one more note to the person who owes */
export async function runSettleReminders(env, today, hour) {
  if (hour < 10) return 0;
  const day = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const rows = (await env.DB.prepare('SELECT s.trip_id, s.id, s.n, s.transfers, t.name FROM settlements s JOIN trips t ON t.id = s.trip_id WHERE s.at >= ?1 AND s.at <= ?2 AND s.trip_id IN (SELECT trip_id FROM member_links) LIMIT 60').bind(day(3), day(2)).all()).results;
  if (!rows.length) return 0;
  const tripIds = [...new Set(rows.map(r => r.trip_id))], J = JSON.stringify(tripIds);
  const [paid, mem] = await Promise.all([env.DB.prepare('SELECT trip_id, key FROM paid WHERE trip_id IN (SELECT value FROM json_each(?1))').bind(J).all(), env.DB.prepare('SELECT trip_id, id, name FROM members WHERE trip_id IN (SELECT value FROM json_each(?1))').bind(J).all()]);
  const done = new Set(paid.results.map(r => r.trip_id + '\n' + r.key));
  let sent = 0;
  for (const tid of tripIds) {
    const name = id => { const m = mem.results.find(x => x.trip_id === tid && x.id === id); return m ? m.name : '誰か'; }, ev = [];
    for (const r of rows.filter(x => x.trip_id === tid)) {
      let transfers = []; try { transfers = JSON.parse(r.transfers); } catch (e) { /* skip */ }
      for (const x of transfers) if (!done.has(tid + '\n' + payKey(r.n, x))) ev.push({ member: x.from, kind: 'r:' + r.id + ':' + x.from + ':' + x.to, msg: messages.again(r.name, name(x.to), x.amount) });
    }
    sent += await deliver(env, tid, ev);
    if (sent >= MAX_SENDS) break;
  }
  return sent;
}
