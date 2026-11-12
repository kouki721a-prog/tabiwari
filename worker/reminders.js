/* Hourly reminder job. For every device that turned notifications on, look at the owner's (encrypted) trip backups and send:
     eve    the evening (from 18:00 Japan time) before the trip starts
     daily  during the trip, from 20:00, when nothing has been logged for today yet
     settle the morning (from 10:00) after the trip ends, if there were expenses
   A (person, trip, kind, day) is claimed in D1 before sending, so it goes out once even if the job runs again. */
import { sha256hex } from './util.js';
import { open } from './seal.js';
import { getVapid, sendPush, reminderMessage, allowedEndpoint } from './push.js';
import { runSettleReminders } from './settlenotify.js';

const MAX_CLAIMS = 40, MAX_SENDS = 30;   // the free plan allows ~50 outgoing requests per run; what does not fit is picked up next hour
const ymd = d => d.toISOString().slice(0, 10);

export function jstParts(nowMs) {
  const j = new Date(nowMs + 9 * 3600 * 1000);   // shift so the UTC getters read Japan time
  return { today: ymd(j), tomorrow: ymd(new Date(j.getTime() + 86400000)), yesterday: ymd(new Date(j.getTime() - 86400000)), hour: j.getUTCHours() };
}
export function dueKinds(trip, t, ex) {
  const kinds = [];
  if (t.hour >= 18 && trip.start === t.tomorrow) kinds.push('eve');
  if (t.hour >= 10 && t.hour <= 22 && trip.start <= t.today && t.today <= trip.end && ex.budget > 0) {   // today's spending is over the day's allowance (the same rule as the red number in the app)
    const dl = Math.round((Date.parse(trip.end + 'T00:00:00Z') - Date.parse(t.today + 'T00:00:00Z')) / 86400000) + 1, per = Math.max(0, Math.floor((ex.budget - ex.sumAll) / dl));
    if (ex.sumToday > per) { kinds.push('over'); ex.per = per; }
  }
  if (t.hour >= 20 && trip.start <= t.today && t.today <= trip.end && ex.onToday === 0) kinds.push('daily');
  if (t.hour >= 10 && trip.end === t.yesterday && ex.total > 0) kinds.push('settle');
  return kinds;
}
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/* Everything that is due for these users right now (all = also list trips that are not due, for the diagnosis screen). */
async function findDue(env, t, userIds, all = false) {
  const DB = env.DB, rows = userIds
    ? (await DB.prepare('SELECT user_id, trip_id, data FROM backups WHERE user_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(userIds)).all()).results
    : (await DB.prepare('SELECT user_id, trip_id, data FROM backups WHERE user_id IN (SELECT DISTINCT user_id FROM push_subs)').all()).results;
  const trips = [];
  for (const r of rows) {
    let item; try { item = await open(env, r.user_id + '|' + r.trip_id, r.data); } catch (e) { if (all) trips.push({ userId: r.user_id, tripId: r.trip_id, unreadable: true }); continue; }
    if (item.deleted && !all) continue;   // deleted on the device: no reminders
    const src = item.kind === 'shared' ? item : item.trip;
    if (!src || !isDay(src.start) || !isDay(src.end) || typeof src.name !== 'string') continue;
    if (!all && !(src.start === t.tomorrow || (src.start <= t.today && t.today <= src.end) || src.end === t.yesterday)) continue;
    if (!all && trips.some(x => x.userId === r.user_id && x.name === src.name && x.start === src.start && x.end === src.end)) continue;   // the same trip saved twice: one reminder
    trips.push({ userId: r.user_id, tripId: r.trip_id, name: src.name, start: src.start, end: src.end, deleted: !!item.deleted,
      hash: item.kind === 'shared' && typeof item.token === 'string' ? await sha256hex(item.token) : null,
      local: item.kind === 'local' ? (Array.isArray(item.trip.expenses) ? item.trip.expenses : []) : null, budget: item.kind === 'local' ? item.trip.budget : null });
  }
  const hashes = trips.filter(x => x.hash).map(x => x.hash), counts = {};
  if (hashes.length) {
    const q = await DB.prepare('SELECT e.trip_id, COUNT(*) AS total, SUM(e.spent_on = ?1) AS on_today, SUM(e.amount) AS sum_all, SUM(CASE WHEN e.spent_on = ?1 THEN e.amount ELSE 0 END) AS sum_today, (SELECT budget FROM trips WHERE id = e.trip_id) AS budget FROM expenses e WHERE e.trip_id IN (SELECT value FROM json_each(?2)) GROUP BY e.trip_id').bind(t.today, JSON.stringify(hashes)).all();
    for (const r of q.results) counts[r.trip_id] = { total: r.total, onToday: r.on_today || 0, sumAll: r.sum_all || 0, sumToday: r.sum_today || 0, budget: r.budget || 0 };
  }
  const offOver = all ? new Set() : new Set((await DB.prepare('SELECT id FROM users WHERE over_notif = 0').all()).results.map(r => r.id));   // people who turned 今日の使いすぎのお知らせ off
  const due = [];
  for (const x of trips) {
    if (x.unreadable) { due.push(x); continue; }
    const amt = e => (e && Number.isFinite(e.amount) ? e.amount : 0);
    const ex = x.hash ? (counts[x.hash] || { total: 0, onToday: 0, sumAll: 0, sumToday: 0, budget: 0 }) : { total: x.local.length, onToday: x.local.filter(e => e && e.date === t.today).length, sumAll: x.local.reduce((a, e) => a + amt(e), 0), sumToday: x.local.filter(e => e && e.date === t.today).reduce((a, e) => a + amt(e), 0), budget: Number.isInteger(x.budget) ? x.budget : 0 };
    const kinds = dueKinds(x, t, ex);
    if (all) due.push({ u: x.userId, t: x.tripId, name: x.name, start: x.start, end: x.end, kinds: x.deleted ? [] : kinds, shared: !!x.hash, expenses: ex.total, deleted: !!x.deleted });
    else for (const kind of kinds) { if (kind === 'over' && offOver.has(x.userId)) continue; due.push({ u: x.userId, t: x.tripId, k: kind, name: x.name, x: kind === 'over' ? { today: ex.sumToday, per: ex.per } : undefined }); }
  }
  return due;
}

/* What the app's "通知の状態" screen shows for one signed-in user. Nothing here changes any data. */
export async function reminderReport(env, userId, nowMs = Date.now()) {
  const t = jstParts(nowMs), DB = env.DB;
  const devices = (await DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?1').bind(userId).first()).n;
  const log = (await DB.prepare('SELECT trip_id, kind, day, t FROM notif_log WHERE user_id = ?1 ORDER BY t DESC LIMIT 8').bind(userId).all()).results;
  const last = await DB.prepare("SELECT v FROM meta WHERE k = 'last_cron'").first();
  let lastCron = null; try { lastCron = last ? JSON.parse(last.v) : null; } catch (e) { /* ignore */ }
  const trips = await findDue(env, t, [userId], true);
  return { now: nowMs, jst: t, devices, lastCron, trips: trips.map(x => x.unreadable ? { unreadable: true } : { name: x.name, start: x.start, end: x.end, kinds: x.kinds, shared: x.shared, expenses: x.expenses, deleted: x.deleted }),
    sent: log.map(x => ({ kind: x.kind, day: x.day, at: x.t, tripId: x.trip_id })) };
}

export async function runReminders(env, nowMs = Date.now()) {
  const out = await runDaily(env, nowMs), t = jstParts(nowMs);
  try { const n = await runSettleReminders(env, t.today, t.hour); if (n) out.again = n; } catch (e) { console.error('settle reminders failed', e && e.message); }   // one more note about an unpaid transfer, 2-3 days after a round
  return out;
}
async function runDaily(env, nowMs) {
  const t = jstParts(nowMs), out = { claimed: 0, sent: 0, gone: 0, failed: 0, released: 0 };
  if (t.hour < 10) return out;
  const DB = env.DB;
  const subs = (await DB.prepare('SELECT endpoint, p256dh, auth, user_id FROM push_subs').all()).results;
  if (!subs.length) return out;
  const origin = await DB.prepare("SELECT v FROM meta WHERE k = 'origin'").first();
  if (!origin) return out;
  const byUser = new Map(); for (const s of subs) { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id).push(s); }

  const due = await findDue(env, t, null);
  if (!due.length) return out;

  const claimed = (await DB.prepare('INSERT OR IGNORE INTO notif_log(user_id, trip_id, kind, day, t) SELECT json_extract(value, \'$.u\'), json_extract(value, \'$.t\'), json_extract(value, \'$.k\'), ?1, ?2 FROM json_each(?3) RETURNING user_id, trip_id, kind')
    .bind(t.today, Math.floor(nowMs / 1000), JSON.stringify(due.slice(0, MAX_CLAIMS))).all()).results;
  out.claimed = claimed.length;
  const vapid = await getVapid(env);
  const release = c => DB.prepare('DELETE FROM notif_log WHERE user_id = ?1 AND trip_id = ?2 AND kind = ?3 AND day = ?4').bind(c.user_id, c.trip_id, c.kind, t.today).run();
  let budget = MAX_SENDS;
  for (const c of claimed) {
    const mine = (byUser.get(c.user_id) || []).filter(s => allowedEndpoint(s.endpoint, env)), dueItem = due.find(d => d.u === c.user_id && d.t === c.trip_id && d.k === c.kind), name = dueItem.name;
    if (!mine.length || mine.length > budget) { await release(c); out.released++; continue; }
    const msg = reminderMessage(c.kind, name, dueItem.x); let delivered = false, transient = false;
    for (const s of mine) {
      budget--;
      try {
        const st = await sendPush(env, vapid, origin.v, s, { ...msg, url: './', tag: c.kind + '-' + c.trip_id });
        if (st >= 200 && st < 300) { delivered = true; out.sent++; }
        else if (st === 404 || st === 410) { out.gone++; await DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run(); }
        else { transient = true; out.failed++; }
      } catch (e) { transient = true; out.failed++; }
    }
    if (!delivered && transient) { await release(c); out.released++; }   // try again next hour
  }
  return out;
}
