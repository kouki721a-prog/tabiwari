/* Settlement notifications: tell the person who owes (a round was confirmed, and again once after two days if still unpaid)
   and the person who is owed (a transfer was marked paid). A shared-trip member can be reached only after a signed-in person
   linked their LINE account to that member (member_links) and turned notifications on for a device (push_subs).
   Every (person, notification) is claimed in notif_log before sending, so it goes out once. */
import { getVapid, sendPush, allowedEndpoint } from './push.js';

const MAX_SENDS = 15;
const lineApi = env => env.LINE_API_BASE || 'https://api.line.me';   // outgoing requests per call; the free plan allows ~50 per invocation and the hourly job has its own share
const yen = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
export const messages = {
  settle: (trip, to, amount) => ({ title: '精算のお知らせ', body: trip + 'の精算ができました。' + to + 'さんに ' + yen(amount) + ' を送ってください。' }),
  paid: (from, amount) => ({ title: '支払いのお知らせ', body: from + 'さんが ' + yen(amount) + ' を支払いました。' }),
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
  const rows = (await env.DB.prepare('SELECT l.member_id, l.user_id, u.line_sub, u.friend_flag, p.endpoint, p.p256dh, p.auth FROM member_links l JOIN users u ON u.id = l.user_id AND u.settle_notif = 1 LEFT JOIN push_subs p ON p.user_id = l.user_id WHERE l.trip_id = ?1').bind(tripId).all()).results;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.member_id)) out.set(r.member_id, { userId: r.user_id, lineSub: r.line_sub, friend: r.friend_flag === 1 && !!env.LINE_OA_ACCESS_TOKEN, subs: [] });
    if (r.endpoint && allowedEndpoint(r.endpoint, env)) out.get(r.member_id).subs.push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth });
  }
  for (const [k, v] of out) if (!v.subs.length && !v.friend) out.delete(k);
  return out;
}
export async function reachable(env, tripId) { return [...(await recipients(env, tripId)).keys()]; }

/* Push from the official account to a friend. 'ok' | 'not_friend' (blocked or never added: stop trying) | 'retry' */
async function linePush(env, to, text, retryKey) {
  try {
    const r = await fetch(lineApi(env) + '/v2/bot/message/push', { method: 'POST', headers: { Authorization: 'Bearer ' + env.LINE_OA_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }) });
    if (r.ok || r.status === 409) return 'ok';   // 409: this retry key was already accepted
    return r.status === 400 || r.status === 403 ? 'not_friend' : 'retry';
  } catch (e) { return 'retry'; }
}
const uuidFrom = async s => { const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32); };

/* events: [{ member, kind, msg }]. Returns how many notifications went out. */
export async function deliver(env, tripId, events, nowSec = Math.floor(Date.now() / 1000)) {
  if (!events.length) return 0;
  const rc = await recipients(env, tripId); if (!rc.size) return 0;
  const origin = await env.DB.prepare("SELECT v FROM meta WHERE k = 'origin'").first(); if (!origin) return 0;
  const mine = events.filter(e => rc.has(e.member)).slice(0, 40);
  if (!mine.length) return 0;
  const res = await env.DB.batch(mine.map(e => env.DB.prepare("INSERT OR IGNORE INTO notif_log(user_id, trip_id, kind, day, t) VALUES (?1, ?2, ?3, '-', ?4)").bind(rc.get(e.member).userId, tripId, e.kind, nowSec)));
  const vapid = await getVapid(env);
  let budget = MAX_SENDS, sent = 0;
  for (let i = 0; i < mine.length; i++) {
    if (!res[i].meta.changes) continue;   // already sent
    const e = mine[i], who = rc.get(e.member);
    const release = () => env.DB.prepare("DELETE FROM notif_log WHERE user_id = ?1 AND trip_id = ?2 AND kind = ?3 AND day = '-'").bind(who.userId, tripId, e.kind).run();
    const viaLine = e.kind.startsWith('s:') && who.friend;   // only a confirmed round falls back to the official account
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
  if (!(ins.settlements && ins.settlements.length) && !(ins.paid && ins.paid.length)) return 0;
  const [tr, ms] = await Promise.all([env.DB.prepare('SELECT name FROM trips WHERE id = ?1').bind(tripId).first(), env.DB.prepare('SELECT id, name FROM members WHERE trip_id = ?1').bind(tripId).all()]);
  if (!tr) return 0;
  const name = id => { const m = ms.results.find(x => x.id === id); return m ? m.name : '誰か'; }, ids = ms.results.map(m => m.id), ev = [];
  for (const st of ins.settlements || []) for (const x of st.transfers) ev.push({ member: x.from, kind: 's:' + st.id + ':' + x.from + ':' + x.to, msg: messages.settle(tr.name, name(x.to), x.amount) });
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
