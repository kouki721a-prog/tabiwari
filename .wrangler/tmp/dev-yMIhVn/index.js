var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/util.js
var hex = /* @__PURE__ */ __name((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var sha256hex = /* @__PURE__ */ __name(async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), "sha256hex");
var b64u = /* @__PURE__ */ __name((bytes) => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}, "b64u");
var unb64u = /* @__PURE__ */ __name((str) => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), "unb64u");
var randomToken = /* @__PURE__ */ __name((bytes) => b64u(crypto.getRandomValues(new Uint8Array(bytes))), "randomToken");
var reply = /* @__PURE__ */ __name((obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } }), "reply");
async function limited(env, req, bucket, limit, windowSec) {
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const k = bucket + ":" + (await sha256hex(ip)).slice(0, 16), now = Math.floor(Date.now() / 1e3), w = Math.floor(now / windowSec);
  const r = await env.DB.prepare("INSERT INTO hits(k,w,n,t) VALUES (?1,?2,1,?3) ON CONFLICT(k,w) DO UPDATE SET n=n+1, t=?3 RETURNING n").bind(k, w, now).first();
  return r.n > limit;
}
__name(limited, "limited");

// worker/seal.js
async function aesKey(env) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("tabiwari-backup"), info: new TextEncoder().encode("v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
__name(aesKey, "aesKey");
async function seal(env, aad, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(env), new TextEncoder().encode(JSON.stringify(obj)));
  return b64u(iv) + "." + b64u(ct);
}
__name(seal, "seal");
async function open(env, aad, data) {
  const [iv, ct] = data.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv), additionalData: new TextEncoder().encode(aad) }, await aesKey(env), unb64u(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
__name(open, "open");

// worker/push.js
var te = new TextEncoder();
var concat = /* @__PURE__ */ __name((...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}, "concat");
var PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
function allowedEndpoint(endpoint, env = {}) {
  let u;
  try {
    u = new URL(endpoint);
  } catch (e) {
    return false;
  }
  if (env.TEST_HOOKS === "1" && env.PUSH_TEST_HOST && u.host === env.PUSH_TEST_HOST) return true;
  return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname)) && endpoint.length <= 600;
}
__name(allowedEndpoint, "allowedEndpoint");
var validKeys = /* @__PURE__ */ __name((k) => !!k && typeof k.p256dh === "string" && typeof k.auth === "string" && k.p256dh.length === 87 && k.auth.length === 22 && /^[A-Za-z0-9_-]+$/.test(k.p256dh + k.auth), "validKeys");
var vapidCache = null;
async function getVapid(env) {
  if (vapidCache) return vapidCache;
  const read = /* @__PURE__ */ __name(async (k) => await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first(), "read");
  let pub = await read("vapid_pub"), priv = await read("vapid_priv");
  if (!pub || !priv) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const rawPub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)").bind("vapid_pub", rawPub),
      env.DB.prepare("INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)").bind("vapid_priv", await seal(env, "vapid", jwk))
    ]);
    pub = await read("vapid_pub");
    priv = await read("vapid_priv");
  }
  const privateKey = await crypto.subtle.importKey("jwk", await open(env, "vapid", priv.v), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return vapidCache = { publicKey: pub.v, privateKey };
}
__name(getVapid, "getVapid");
async function vapidHeader(vapid, audience, subject, nowSec2 = Math.floor(Date.now() / 1e3)) {
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud: audience, exp: nowSec2 + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, te.encode(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + vapid.publicKey;
}
__name(vapidHeader, "vapidHeader");
var hkdf = /* @__PURE__ */ __name(async (ikm, salt, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bytes * 8)), "hkdf");
async function encryptPayload(p256dhB64, authB64, plaintext) {
  const ua = unb64u(p256dhB64), auth = unb64u(authB64);
  if (ua.length !== 65 || ua[0] !== 4 || auth.length !== 16) throw new Error("bad subscription keys");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(shared, auth, concat(te.encode("WebPush: info\0"), ua, asPub), 32);
  const cek = await hkdf(ikm, salt, te.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(ikm, salt, te.encode("Content-Encoding: nonce\0"), 12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), concat(plaintext, new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);
}
__name(encryptPayload, "encryptPayload");
async function sendPush(env, vapid, subject, sub, message) {
  const body = await encryptPayload(sub.p256dh, sub.auth, te.encode(JSON.stringify(message)));
  const res = await fetch(sub.endpoint, { method: "POST", body, headers: {
    Authorization: await vapidHeader(vapid, new URL(sub.endpoint).origin, subject),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: "21600",
    Urgency: "normal"
  } });
  return res.status;
}
__name(sendPush, "sendPush");
function reminderMessage(kind, tripName) {
  const n = "\u300C" + tripName + "\u300D";
  if (kind === "eve") return { title: "\u660E\u65E5\u304B\u3089 " + n, body: "\u4E88\u7B97\u3068\u30E1\u30F3\u30D0\u30FC\u3092\u3001\u3082\u3046\u4E00\u5EA6\u78BA\u8A8D\u3057\u3066\u304A\u304D\u307E\u3057\u3087\u3046\u3002" };
  if (kind === "daily") return { title: "\u4ECA\u65E5\u306E\u652F\u51FA\u3092\u8A18\u9332\u3057\u307E\u3057\u3087\u3046", body: n + " \u2014 \u4F7F\u3063\u305F\u5206\u3092\u3001\u5FD8\u308C\u306A\u3044\u3046\u3061\u306B\u3002" };
  if (kind === "settle") return { title: "\u7CBE\u7B97\u3092\u6E08\u307E\u305B\u307E\u3057\u3087\u3046", body: n + " \u306E\u9001\u91D1\u306F\u3001\u304A\u6E08\u307F\u3067\u3059\u304B\uFF1F" };
  return null;
}
__name(reminderMessage, "reminderMessage");

// worker/settlenotify.js
var MAX_SENDS = 15;
var lineApi = /* @__PURE__ */ __name((env) => env.LINE_API_BASE || "https://api.line.me", "lineApi");
var yen = /* @__PURE__ */ __name((n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "\u5186", "yen");
var messages = {
  settle: /* @__PURE__ */ __name((trip, to, amount) => ({ title: "\u7CBE\u7B97\u306E\u304A\u77E5\u3089\u305B", body: trip + "\u306E\u7CBE\u7B97\u304C\u3067\u304D\u307E\u3057\u305F\u3002" + to + "\u3055\u3093\u306B " + yen(amount) + " \u3092\u9001\u3063\u3066\u304F\u3060\u3055\u3044\u3002" }), "settle"),
  paid: /* @__PURE__ */ __name((from, amount) => ({ title: "\u652F\u6255\u3044\u306E\u304A\u77E5\u3089\u305B", body: from + "\u3055\u3093\u304C " + yen(amount) + " \u3092\u652F\u6255\u3044\u307E\u3057\u305F\u3002" }), "paid"),
  again: /* @__PURE__ */ __name((trip, to, amount) => ({ title: "\u7CBE\u7B97\u306E\u304A\u77E5\u3089\u305B", body: trip + "\u306E\u7CBE\u7B97\u306E\u3001" + to + "\u3055\u3093\u3078\u306E " + yen(amount) + " \u306F\u3001\u304A\u6E08\u307F\u3067\u3059\u304B\u3002" }), "again")
};
function parsePaidKey(key, memberIds) {
  const m = /^(?:\d+:)?(.+)-(\d+)$/.exec(key);
  if (!m) return null;
  for (const a of memberIds) if (m[1].startsWith(a + "-")) {
    const b = m[1].slice(a.length + 1);
    if (memberIds.indexOf(b) >= 0) return { from: a, to: b, amount: Number(m[2]) };
  }
  return null;
}
__name(parsePaidKey, "parsePaidKey");
var payKey = /* @__PURE__ */ __name((n, x) => {
  const b = x.from + "-" + x.to + "-" + x.amount;
  return n === 1 ? b : n + ":" + b;
}, "payKey");
async function recipients(env, tripId) {
  const rows = (await env.DB.prepare("SELECT l.member_id, l.user_id, u.line_sub, u.friend_flag, p.endpoint, p.p256dh, p.auth FROM member_links l JOIN users u ON u.id = l.user_id AND u.settle_notif = 1 LEFT JOIN push_subs p ON p.user_id = l.user_id WHERE l.trip_id = ?1").bind(tripId).all()).results;
  const out = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (!out.has(r.member_id)) out.set(r.member_id, { userId: r.user_id, lineSub: r.line_sub, friend: r.friend_flag === 1 && !!env.LINE_OA_ACCESS_TOKEN, subs: [] });
    if (r.endpoint && allowedEndpoint(r.endpoint, env)) out.get(r.member_id).subs.push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth });
  }
  for (const [k, v] of out) if (!v.subs.length && !v.friend) out.delete(k);
  return out;
}
__name(recipients, "recipients");
async function reachable(env, tripId) {
  return [...(await recipients(env, tripId)).keys()];
}
__name(reachable, "reachable");
async function linePush(env, to, text, retryKey) {
  try {
    const r = await fetch(lineApi(env) + "/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.LINE_OA_ACCESS_TOKEN, "Content-Type": "application/json", "X-Line-Retry-Key": retryKey },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] })
    });
    if (r.ok || r.status === 409) return "ok";
    return r.status === 400 || r.status === 403 ? "not_friend" : "retry";
  } catch (e) {
    return "retry";
  }
}
__name(linePush, "linePush");
var uuidFrom = /* @__PURE__ */ __name(async (s) => {
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);
}, "uuidFrom");
async function deliver(env, tripId, events, nowSec2 = Math.floor(Date.now() / 1e3)) {
  if (!events.length) return 0;
  const rc = await recipients(env, tripId);
  if (!rc.size) return 0;
  const origin = await env.DB.prepare("SELECT v FROM meta WHERE k = 'origin'").first();
  if (!origin) return 0;
  const mine = events.filter((e) => rc.has(e.member)).slice(0, 40);
  if (!mine.length) return 0;
  const res = await env.DB.batch(mine.map((e) => env.DB.prepare("INSERT OR IGNORE INTO notif_log(user_id, trip_id, kind, day, t) VALUES (?1, ?2, ?3, '-', ?4)").bind(rc.get(e.member).userId, tripId, e.kind, nowSec2)));
  const vapid = await getVapid(env);
  let budget = MAX_SENDS, sent = 0;
  for (let i = 0; i < mine.length; i++) {
    if (!res[i].meta.changes) continue;
    const e = mine[i], who = rc.get(e.member);
    const release = /* @__PURE__ */ __name(() => env.DB.prepare("DELETE FROM notif_log WHERE user_id = ?1 AND trip_id = ?2 AND kind = ?3 AND day = '-'").bind(who.userId, tripId, e.kind).run(), "release");
    const viaLine = e.kind.startsWith("s:") && who.friend;
    if (who.subs.length + (viaLine ? 1 : 0) > budget) {
      await release();
      continue;
    }
    let delivered = false;
    for (const s of who.subs) {
      budget--;
      try {
        const st = await sendPush(env, vapid, origin.v, s, { ...e.msg, url: "./?trip=" + tripId + "&tab=settle" });
        if (st >= 200 && st < 300) {
          delivered = true;
          sent++;
        } else if (st === 404 || st === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(s.endpoint).run();
      } catch (err) {
      }
    }
    if (!delivered && viaLine) {
      budget--;
      const st = await linePush(env, who.lineSub, "\u3010\u305F\u3073\u308F\u308A\u3011" + e.msg.body, await uuidFrom(tripId + "|" + e.kind + "|" + who.userId));
      if (st === "ok") {
        delivered = true;
        sent++;
      } else if (st === "not_friend") await env.DB.prepare("UPDATE users SET friend_flag = 0 WHERE id = ?1").bind(who.userId).run();
    }
    if (!delivered) await release();
  }
  return sent;
}
__name(deliver, "deliver");
async function notifyOps(env, tripId, ins) {
  if (!(ins.settlements && ins.settlements.length) && !(ins.paid && ins.paid.length)) return 0;
  const [tr, ms] = await Promise.all([env.DB.prepare("SELECT name FROM trips WHERE id = ?1").bind(tripId).first(), env.DB.prepare("SELECT id, name FROM members WHERE trip_id = ?1").bind(tripId).all()]);
  if (!tr) return 0;
  const name = /* @__PURE__ */ __name((id) => {
    const m = ms.results.find((x) => x.id === id);
    return m ? m.name : "\u8AB0\u304B";
  }, "name"), ids = ms.results.map((m) => m.id), ev = [];
  for (const st of ins.settlements || []) for (const x of st.transfers) ev.push({ member: x.from, kind: "s:" + st.id + ":" + x.from + ":" + x.to, msg: messages.settle(tr.name, name(x.to), x.amount) });
  for (const p of ins.paid || []) {
    const k = parsePaidKey(p.key, ids);
    if (k) ev.push({ member: k.to, kind: "p:" + p.key, msg: messages.paid(name(k.from), k.amount) });
  }
  return deliver(env, tripId, ev);
}
__name(notifyOps, "notifyOps");
async function runSettleReminders(env, today, hour) {
  if (hour < 10) return 0;
  const day = /* @__PURE__ */ __name((n) => new Date(Date.parse(today + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10), "day");
  const rows = (await env.DB.prepare("SELECT s.trip_id, s.id, s.n, s.transfers, t.name FROM settlements s JOIN trips t ON t.id = s.trip_id WHERE s.at >= ?1 AND s.at <= ?2 AND s.trip_id IN (SELECT trip_id FROM member_links) LIMIT 60").bind(day(3), day(2)).all()).results;
  if (!rows.length) return 0;
  const tripIds = [...new Set(rows.map((r) => r.trip_id))], J2 = JSON.stringify(tripIds);
  const [paid, mem] = await Promise.all([env.DB.prepare("SELECT trip_id, key FROM paid WHERE trip_id IN (SELECT value FROM json_each(?1))").bind(J2).all(), env.DB.prepare("SELECT trip_id, id, name FROM members WHERE trip_id IN (SELECT value FROM json_each(?1))").bind(J2).all()]);
  const done = new Set(paid.results.map((r) => r.trip_id + "\n" + r.key));
  let sent = 0;
  for (const tid of tripIds) {
    const name = /* @__PURE__ */ __name((id) => {
      const m = mem.results.find((x) => x.trip_id === tid && x.id === id);
      return m ? m.name : "\u8AB0\u304B";
    }, "name"), ev = [];
    for (const r of rows.filter((x) => x.trip_id === tid)) {
      let transfers = [];
      try {
        transfers = JSON.parse(r.transfers);
      } catch (e) {
      }
      for (const x of transfers) if (!done.has(tid + "\n" + payKey(r.n, x))) ev.push({ member: x.from, kind: "r:" + r.id + ":" + x.from + ":" + x.to, msg: messages.again(r.name, name(x.to), x.amount) });
    }
    sent += await deliver(env, tid, ev);
    if (sent >= MAX_SENDS) break;
  }
  return sent;
}
__name(runSettleReminders, "runSettleReminders");

// worker/reminders.js
var MAX_CLAIMS = 40;
var MAX_SENDS2 = 30;
var ymd = /* @__PURE__ */ __name((d) => d.toISOString().slice(0, 10), "ymd");
function jstParts(nowMs) {
  const j = new Date(nowMs + 9 * 3600 * 1e3);
  return { today: ymd(j), tomorrow: ymd(new Date(j.getTime() + 864e5)), yesterday: ymd(new Date(j.getTime() - 864e5)), hour: j.getUTCHours() };
}
__name(jstParts, "jstParts");
function dueKinds(trip, t, ex) {
  const kinds = [];
  if (t.hour >= 18 && trip.start === t.tomorrow) kinds.push("eve");
  if (t.hour >= 20 && trip.start <= t.today && t.today <= trip.end && ex.onToday === 0) kinds.push("daily");
  if (t.hour >= 10 && trip.end === t.yesterday && ex.total > 0) kinds.push("settle");
  return kinds;
}
__name(dueKinds, "dueKinds");
var isDay = /* @__PURE__ */ __name((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v), "isDay");
async function findDue(env, t, userIds, all = false) {
  const DB = env.DB, rows = userIds ? (await DB.prepare("SELECT user_id, trip_id, data FROM backups WHERE user_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(userIds)).all()).results : (await DB.prepare("SELECT user_id, trip_id, data FROM backups WHERE user_id IN (SELECT DISTINCT user_id FROM push_subs)").all()).results;
  const trips = [];
  for (const r of rows) {
    let item;
    try {
      item = await open(env, r.user_id + "|" + r.trip_id, r.data);
    } catch (e) {
      if (all) trips.push({ userId: r.user_id, tripId: r.trip_id, unreadable: true });
      continue;
    }
    if (item.deleted && !all) continue;
    const src = item.kind === "shared" ? item : item.trip;
    if (!src || !isDay(src.start) || !isDay(src.end) || typeof src.name !== "string") continue;
    if (!all && !(src.start === t.tomorrow || src.start <= t.today && t.today <= src.end || src.end === t.yesterday)) continue;
    if (!all && trips.some((x) => x.userId === r.user_id && x.name === src.name && x.start === src.start && x.end === src.end)) continue;
    trips.push({
      userId: r.user_id,
      tripId: r.trip_id,
      name: src.name,
      start: src.start,
      end: src.end,
      deleted: !!item.deleted,
      hash: item.kind === "shared" && typeof item.token === "string" ? await sha256hex(item.token) : null,
      local: item.kind === "local" ? Array.isArray(item.trip.expenses) ? item.trip.expenses : [] : null
    });
  }
  const hashes = trips.filter((x) => x.hash).map((x) => x.hash), counts = {};
  if (hashes.length) {
    const q = await DB.prepare("SELECT trip_id, COUNT(*) AS total, SUM(spent_on = ?1) AS on_today FROM expenses WHERE trip_id IN (SELECT value FROM json_each(?2)) GROUP BY trip_id").bind(t.today, JSON.stringify(hashes)).all();
    for (const r of q.results) counts[r.trip_id] = { total: r.total, onToday: r.on_today || 0 };
  }
  const due = [];
  for (const x of trips) {
    if (x.unreadable) {
      due.push(x);
      continue;
    }
    const ex = x.hash ? counts[x.hash] || { total: 0, onToday: 0 } : { total: x.local.length, onToday: x.local.filter((e) => e && e.date === t.today).length };
    const kinds = dueKinds(x, t, ex);
    if (all) due.push({ u: x.userId, t: x.tripId, name: x.name, start: x.start, end: x.end, kinds: x.deleted ? [] : kinds, shared: !!x.hash, expenses: ex.total, deleted: !!x.deleted });
    else for (const kind of kinds) due.push({ u: x.userId, t: x.tripId, k: kind, name: x.name });
  }
  return due;
}
__name(findDue, "findDue");
async function reminderReport(env, userId, nowMs = Date.now()) {
  const t = jstParts(nowMs), DB = env.DB;
  const devices = (await DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?1").bind(userId).first()).n;
  const log = (await DB.prepare("SELECT trip_id, kind, day, t FROM notif_log WHERE user_id = ?1 ORDER BY t DESC LIMIT 8").bind(userId).all()).results;
  const last = await DB.prepare("SELECT v FROM meta WHERE k = 'last_cron'").first();
  let lastCron = null;
  try {
    lastCron = last ? JSON.parse(last.v) : null;
  } catch (e) {
  }
  const trips = await findDue(env, t, [userId], true);
  return {
    now: nowMs,
    jst: t,
    devices,
    lastCron,
    trips: trips.map((x) => x.unreadable ? { unreadable: true } : { name: x.name, start: x.start, end: x.end, kinds: x.kinds, shared: x.shared, expenses: x.expenses, deleted: x.deleted }),
    sent: log.map((x) => ({ kind: x.kind, day: x.day, at: x.t, tripId: x.trip_id }))
  };
}
__name(reminderReport, "reminderReport");
async function runReminders(env, nowMs = Date.now()) {
  const out = await runDaily(env, nowMs), t = jstParts(nowMs);
  try {
    const n = await runSettleReminders(env, t.today, t.hour);
    if (n) out.again = n;
  } catch (e) {
    console.error("settle reminders failed", e && e.message);
  }
  return out;
}
__name(runReminders, "runReminders");
async function runDaily(env, nowMs) {
  const t = jstParts(nowMs), out = { claimed: 0, sent: 0, gone: 0, failed: 0, released: 0 };
  if (t.hour < 10) return out;
  const DB = env.DB;
  const subs = (await DB.prepare("SELECT endpoint, p256dh, auth, user_id FROM push_subs").all()).results;
  if (!subs.length) return out;
  const origin = await DB.prepare("SELECT v FROM meta WHERE k = 'origin'").first();
  if (!origin) return out;
  const byUser = /* @__PURE__ */ new Map();
  for (const s of subs) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  const due = await findDue(env, t, null);
  if (!due.length) return out;
  const claimed = (await DB.prepare("INSERT OR IGNORE INTO notif_log(user_id, trip_id, kind, day, t) SELECT json_extract(value, '$.u'), json_extract(value, '$.t'), json_extract(value, '$.k'), ?1, ?2 FROM json_each(?3) RETURNING user_id, trip_id, kind").bind(t.today, Math.floor(nowMs / 1e3), JSON.stringify(due.slice(0, MAX_CLAIMS))).all()).results;
  out.claimed = claimed.length;
  const vapid = await getVapid(env);
  const release = /* @__PURE__ */ __name((c) => DB.prepare("DELETE FROM notif_log WHERE user_id = ?1 AND trip_id = ?2 AND kind = ?3 AND day = ?4").bind(c.user_id, c.trip_id, c.kind, t.today).run(), "release");
  let budget = MAX_SENDS2;
  for (const c of claimed) {
    const mine = (byUser.get(c.user_id) || []).filter((s) => allowedEndpoint(s.endpoint, env)), name = due.find((d) => d.u === c.user_id && d.t === c.trip_id && d.k === c.kind).name;
    if (!mine.length || mine.length > budget) {
      await release(c);
      out.released++;
      continue;
    }
    const msg = reminderMessage(c.kind, name);
    let delivered = false, transient = false;
    for (const s of mine) {
      budget--;
      try {
        const st = await sendPush(env, vapid, origin.v, s, { ...msg, url: "./", tag: c.kind + "-" + c.trip_id });
        if (st >= 200 && st < 300) {
          delivered = true;
          out.sent++;
        } else if (st === 404 || st === 410) {
          out.gone++;
          await DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run();
        } else {
          transient = true;
          out.failed++;
        }
      } catch (e) {
        transient = true;
        out.failed++;
      }
    }
    if (!delivered && transient) {
      await release(c);
      out.released++;
    }
  }
  return out;
}
__name(runDaily, "runDaily");

// worker/account.js
var ACCOUNT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, line_sub TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_login INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS backups (user_id TEXT NOT NULL, trip_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, trip_id))`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id)`,
  `CREATE TABLE IF NOT EXISTS member_links (trip_id TEXT NOT NULL, member_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (trip_id, member_id))`,
  // which signed-in person is which member of a shared trip (so 精算のお知らせ can reach them)
  `CREATE INDEX IF NOT EXISTS member_links_user ON member_links(user_id)`,
  `CREATE TABLE IF NOT EXISTS notif_log (user_id TEXT NOT NULL, trip_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (user_id, trip_id, kind, day))`
];
var SESSION_SECONDS = 90 * 86400;
var ATTEMPT_SECONDS = 600;
var INACTIVE_ACCOUNT_DAYS = 400;
var BACKUP = { items: 100, itemBytes: 2e5, bodyBytes: 6e5, perRequest: 20 };
var TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
var isId = /* @__PURE__ */ __name((v) => typeof v === "string" && /^[\w.-]{1,64}$/.test(v), "isId");
var nowSec = /* @__PURE__ */ __name(() => Math.floor(Date.now() / 1e3), "nowSec");
var configured = /* @__PURE__ */ __name((env) => !!(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET && typeof env.AUTH_SECRET === "string" && env.AUTH_SECRET.length >= 32), "configured");
var lineAuth = /* @__PURE__ */ __name((env) => env.LINE_AUTH_BASE || "https://access.line.me", "lineAuth");
var lineApi2 = /* @__PURE__ */ __name((env) => env.LINE_API_BASE || "https://api.line.me", "lineApi");
var page = /* @__PURE__ */ __name((title, msg, status = 200) => new Response(
  `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;background:#eef2f7;color:#0e2238;margin:0;padding:48px 20px;text-align:center;line-height:1.7"><h1 style="font-size:20px">${title}</h1><p style="color:#5b6b80">${msg}</p><p><a href="/" style="display:inline-block;background:#ffc83d;color:#2a1d00;font-weight:700;padding:12px 24px;border-radius:14px;text-decoration:none">\u305F\u3073\u308F\u308A\u306B\u623B\u308B</a></p></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }
), "page");
var cookieHeader = /* @__PURE__ */ __name((token, req, maxAge) => "tw_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + (new URL(req.url).protocol === "https:" ? "; Secure" : ""), "cookieHeader");
async function userFrom(req, env) {
  const m = /(?:^|;\s*)tw_session=([A-Za-z0-9_-]{20,80})/.exec(req.headers.get("Cookie") || "");
  if (!m) return null;
  return env.DB.prepare("SELECT u.id, u.name, u.settle_notif FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1 AND s.expires_at > ?2").bind(await sha256hex(m[1]), nowSec()).first();
}
__name(userFrom, "userFrom");
function validItem(item) {
  if (!item || typeof item !== "object" || JSON.stringify(item).length > BACKUP.itemBytes) return false;
  if (item.kind === "shared") return typeof item.token === "string" && TOKEN.test(item.token) && typeof item.name === "string";
  if (item.kind === "local") {
    const t = item.trip;
    return !!t && typeof t === "object" && typeof t.name === "string" && Array.isArray(t.members) && Array.isArray(t.expenses);
  }
  return false;
}
__name(validItem, "validItem");
async function backupGet(env, user) {
  const rows = await env.DB.prepare("SELECT trip_id, data, updated_at FROM backups WHERE user_id = ? ORDER BY updated_at DESC").bind(user.id).all();
  const items = [];
  for (const r of rows.results) {
    try {
      items.push({ id: r.trip_id, updated_at: r.updated_at, item: await open(env, user.id + "|" + r.trip_id, r.data) });
    } catch (e) {
    }
  }
  return reply({ items });
}
__name(backupGet, "backupGet");
async function backupPut(req, env, user) {
  const text = await req.text();
  if (text.length > BACKUP.bodyBytes) return reply({ error: "too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return reply({ error: "invalid" }, 400);
  }
  const up = Array.isArray(body && body.upsert) ? body.upsert : [], rm = Array.isArray(body && body.remove) ? body.remove : [], gone = Array.isArray(body && body.deleted) ? body.deleted : [];
  if (!up.length && !rm.length && !gone.length) return reply({ error: "invalid" }, 400);
  if (up.length > BACKUP.perRequest || rm.length > BACKUP.perRequest || gone.length > BACKUP.perRequest) return reply({ error: "invalid" }, 400);
  if (!up.every((x) => x && isId(x.id) && validItem(x.item)) || !rm.every(isId) || !gone.every(isId)) return reply({ error: "invalid" }, 400);
  if (await limited(env, req, "b", 120, 600)) return reply({ error: "rate_limited" }, 429);
  const have = new Set((await env.DB.prepare("SELECT trip_id FROM backups WHERE user_id = ?").bind(user.id).all()).results.map((r) => r.trip_id));
  rm.forEach((id) => have.delete(id));
  up.forEach((x) => have.add(x.id));
  if (have.size > BACKUP.items) return reply({ error: "limit" }, 413);
  const now = nowSec(), S = [];
  for (const x of up) S.push(env.DB.prepare("INSERT INTO backups(user_id,trip_id,data,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id,trip_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").bind(user.id, x.id, await seal(env, user.id + "|" + x.id, x.item), now));
  for (const id of rm) S.push(env.DB.prepare("DELETE FROM backups WHERE user_id = ?1 AND trip_id = ?2").bind(user.id, id));
  for (const id of gone) {
    const row = await env.DB.prepare("SELECT data FROM backups WHERE user_id = ?1 AND trip_id = ?2").bind(user.id, id).first();
    if (!row || up.some((x) => x.id === id)) continue;
    let item;
    try {
      item = await open(env, user.id + "|" + id, row.data);
    } catch (e) {
      continue;
    }
    item.deleted = true;
    S.push(env.DB.prepare("UPDATE backups SET data = ?3, updated_at = ?4 WHERE user_id = ?1 AND trip_id = ?2").bind(user.id, id, await seal(env, user.id + "|" + id, item), now));
  }
  await env.DB.batch(S);
  return reply({ ok: true, count: have.size });
}
__name(backupPut, "backupPut");
async function saveFriendState(env, userId, accessToken, changedParam, now) {
  const changed = changedParam === "true" ? 1 : changedParam === "false" ? 0 : null;
  try {
    let flag = null;
    if (accessToken) {
      const r = await fetch(lineApi2(env) + "/friendship/v1/status", { headers: { Authorization: "Bearer " + accessToken } });
      if (r.ok) {
        const d = await r.json();
        if (typeof d.friendFlag === "boolean") flag = d.friendFlag ? 1 : 0;
      }
    }
    if (flag === null && changed === null) return;
    if (flag === null) await env.DB.prepare("UPDATE users SET friend_changed = ?2 WHERE id = ?1").bind(userId, changed).run();
    else await env.DB.prepare("UPDATE users SET friend_flag = ?2, friend_changed = ?3, friend_checked_at = ?4 WHERE id = ?1").bind(userId, flag, changed, now).run();
  } catch (e) {
    console.error("friend state failed", e && e.message);
  }
}
__name(saveFriendState, "saveFriendState");
async function lineCallback(url, env) {
  const code = url.searchParams.get("code"), id = url.searchParams.get("state");
  if (!isId(id)) return page("\u30ED\u30B0\u30A4\u30F3\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F", "\u3082\u3046\u4E00\u5EA6\u3001\u30A2\u30D7\u30EA\u304B\u3089\u3084\u308A\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002", 400);
  const att = await env.DB.prepare("SELECT * FROM attempts WHERE id = ?").bind(id).first();
  if (!att || att.status !== "pending" || att.created_at < nowSec() - ATTEMPT_SECONDS) return page("\u30ED\u30B0\u30A4\u30F3\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F", "\u6642\u9593\u304C\u904E\u304E\u305F\u304B\u3001\u3059\u3067\u306B\u4F7F\u308F\u308C\u3066\u3044\u307E\u3059\u3002\u30A2\u30D7\u30EA\u304B\u3089\u3084\u308A\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002", 400);
  if (url.searchParams.get("error") || !code) {
    await env.DB.prepare("UPDATE attempts SET status='denied' WHERE id=?").bind(id).run();
    return page("\u30ED\u30B0\u30A4\u30F3\u3092\u3084\u3081\u307E\u3057\u305F", "LINE\u3067\u306E\u8A31\u53EF\u304C\u3042\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002", 200);
  }
  try {
    const redirect = url.origin + "/api/auth/line/callback";
    const tok = await fetch(lineApi2(env) + "/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET })
    });
    if (!tok.ok) throw new Error("token " + tok.status);
    const { id_token, access_token } = await tok.json();
    const ver = await fetch(lineApi2(env) + "/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token, client_id: env.LINE_CHANNEL_ID, nonce: att.nonce })
    });
    if (!ver.ok) throw new Error("verify " + ver.status);
    const c = await ver.json();
    if (typeof c.sub !== "string" || !c.sub || String(c.aud) !== String(env.LINE_CHANNEL_ID)) throw new Error("claims");
    const name = typeof c.name === "string" ? c.name.slice(0, 60) : "", picture = "", now = nowSec();
    let u = await env.DB.prepare("SELECT id FROM users WHERE line_sub = ?").bind(c.sub).first();
    if (!u) {
      u = { id: randomToken(16) };
      await env.DB.prepare("INSERT INTO users(id,line_sub,name,picture,created_at,last_login) VALUES (?,?,?,?,?,?)").bind(u.id, c.sub, name, picture, now, now).run();
    } else await env.DB.prepare("UPDATE users SET name=?, picture=?, last_login=? WHERE id=?").bind(name, picture, now, u.id).run();
    await saveFriendState(env, u.id, access_token, url.searchParams.get("friendship_status_changed"), now);
    await env.DB.prepare("UPDATE attempts SET status='done', user_id=? WHERE id=? AND status='pending'").bind(u.id, id).run();
    return page("\u30ED\u30B0\u30A4\u30F3\u3067\u304D\u307E\u3057\u305F", "\u3053\u306E\u30DA\u30FC\u30B8\u3092\u9589\u3058\u3066\u3001\u305F\u3073\u308F\u308A\u306E\u30A2\u30D7\u30EA\u306B\u623B\u3063\u3066\u304F\u3060\u3055\u3044\u3002\u81EA\u52D5\u3067\u3001\u30ED\u30B0\u30A4\u30F3\u304C\u5B8C\u4E86\u3057\u307E\u3059\u3002");
  } catch (e) {
    console.error("line login failed", e && e.message);
    return page("\u30ED\u30B0\u30A4\u30F3\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F", "LINE\u3068\u306E\u901A\u4FE1\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002\u3057\u3070\u3089\u304F\u3057\u3066\u304B\u3089\u3001\u3082\u3046\u4E00\u5EA6\u304A\u8A66\u3057\u304F\u3060\u3055\u3044\u3002", 502);
  }
}
__name(lineCallback, "lineCallback");
async function handleAccount(req, env, url) {
  const p = url.pathname;
  if (!(p === "/api/me" || p.startsWith("/api/auth/") || p.startsWith("/api/push/") || p === "/api/backup" || p === "/api/account")) return null;
  const method = req.method;
  if (method !== "GET" && method !== "HEAD" && req.headers.get("Origin") !== url.origin) return reply({ error: "origin" }, 403);
  const on = configured(env);
  if (p === "/api/me" && method === "GET") {
    const u = on ? await userFrom(req, env) : null;
    return reply({ login: on, user: u ? { name: u.name, settle: u.settle_notif !== 0 } : null, push: u ? (await getVapid(env)).publicKey : null });
  }
  if (!on) return reply({ error: "not_configured" }, 503);
  if (p === "/api/auth/begin" && method === "POST") {
    if (await limited(env, req, "a", 20, 3600)) return reply({ error: "rate_limited" }, 429);
    const id = randomToken(18), secret = randomToken(24), nonce = randomToken(18);
    await env.DB.prepare("INSERT INTO attempts(id,secret_hash,nonce,status,created_at) VALUES (?,?,?,'pending',?)").bind(id, await sha256hex(secret), nonce, nowSec()).run();
    return reply({ id, secret, url: "/api/auth/line/start?a=" + id });
  }
  if (p === "/api/auth/line/start" && method === "GET") {
    const id = url.searchParams.get("a");
    const att = isId(id) ? await env.DB.prepare("SELECT * FROM attempts WHERE id = ?").bind(id).first() : null;
    if (!att || att.status !== "pending" || att.created_at < nowSec() - ATTEMPT_SECONDS) return page("\u30ED\u30B0\u30A4\u30F3\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F", "\u6642\u9593\u304C\u904E\u304E\u305F\u304B\u3001\u3059\u3067\u306B\u4F7F\u308F\u308C\u3066\u3044\u307E\u3059\u3002\u30A2\u30D7\u30EA\u304B\u3089\u3084\u308A\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002", 400);
    const q = new URLSearchParams({ response_type: "code", client_id: env.LINE_CHANNEL_ID, redirect_uri: url.origin + "/api/auth/line/callback", state: id, scope: "profile openid", nonce: att.nonce, bot_prompt: "normal" });
    return new Response(null, { status: 302, headers: { Location: lineAuth(env) + "/oauth2/v2.1/authorize?" + q, "Cache-Control": "no-store" } });
  }
  if (p === "/api/auth/line/callback" && method === "GET") return lineCallback(url, env);
  if (p === "/api/auth/poll" && method === "POST") {
    let b;
    try {
      b = await req.json();
    } catch (e) {
      return reply({ error: "invalid" }, 400);
    }
    if (!b || !isId(b.id) || typeof b.secret !== "string" || b.secret.length > 100) return reply({ error: "invalid" }, 400);
    const att = await env.DB.prepare("SELECT * FROM attempts WHERE id = ?").bind(b.id).first();
    if (!att || att.secret_hash !== await sha256hex(b.secret) || att.created_at < nowSec() - ATTEMPT_SECONDS || att.status === "denied") return reply({ error: "gone" }, 410);
    if (att.status === "pending") return reply({ pending: true });
    const token = randomToken(32);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,?)").bind(await sha256hex(token), att.user_id, nowSec() + SESSION_SECONDS),
      env.DB.prepare("DELETE FROM attempts WHERE id = ?").bind(b.id)
    ]);
    return reply({ ok: true }, 200, { "Set-Cookie": cookieHeader(token, req, SESSION_SECONDS) });
  }
  if (p === "/api/auth/logout" && method === "POST") {
    const m = /(?:^|;\s*)tw_session=([A-Za-z0-9_-]{20,80})/.exec(req.headers.get("Cookie") || "");
    if (m) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256hex(m[1])).run();
    return reply({ ok: true }, 200, { "Set-Cookie": cookieHeader("", req, 0) });
  }
  const user = await userFrom(req, env);
  if (!user) return reply({ error: "unauthorized" }, 401);
  if (p === "/api/backup" && method === "GET") return backupGet(env, user);
  if (p === "/api/backup" && method === "PUT") return backupPut(req, env, user);
  if (p === "/api/push/subscribe" && method === "POST") {
    let b;
    try {
      b = await req.json();
    } catch (e) {
      return reply({ error: "invalid" }, 400);
    }
    if (!b || !allowedEndpoint(b.endpoint, env) || !validKeys(b.keys)) return reply({ error: "invalid" }, 400);
    if (await limited(env, req, "p", 60, 600)) return reply({ error: "rate_limited" }, 429);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?1 AND endpoint != ?2").bind(user.id, b.endpoint).first();
    if (n.n >= 10) return reply({ error: "limit" }, 413);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO push_subs(endpoint, user_id, p256dh, auth, created_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth").bind(b.endpoint, user.id, b.keys.p256dh, b.keys.auth, nowSec()),
      env.DB.prepare("INSERT INTO meta(k, v) VALUES ('origin', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(url.origin)
    ]);
    return reply({ ok: true });
  }
  if (p === "/api/push/test" && method === "POST") {
    if (await limited(env, req, "t", 10, 600)) return reply({ error: "rate_limited" }, 429);
    const subs = (await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?1").bind(user.id).all()).results.filter((x) => allowedEndpoint(x.endpoint, env));
    if (!subs.length) return reply({ error: "no_device" }, 404);
    const vapid = await getVapid(env), origin = await env.DB.prepare("SELECT v FROM meta WHERE k = 'origin'").first();
    const out = { sent: 0, failed: 0, gone: 0 };
    for (const x of subs) {
      try {
        const st = await sendPush(env, vapid, origin ? origin.v : url.origin, x, { title: "\u305F\u3073\u308F\u308A\uFF1A\u30C6\u30B9\u30C8\u901A\u77E5", body: "\u3053\u306E\u901A\u77E5\u304C\u898B\u3048\u3066\u3044\u308C\u3070\u3001\u901A\u77E5\u306F\u6B63\u3057\u304F\u5C4A\u3044\u3066\u3044\u307E\u3059\u3002", url: "./", tag: "test" });
        if (st >= 200 && st < 300) out.sent++;
        else if (st === 404 || st === 410) {
          out.gone++;
          await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(x.endpoint).run();
        } else out.failed++;
      } catch (e) {
        out.failed++;
      }
    }
    return reply(out);
  }
  if (p === "/api/push/diagnose" && method === "POST") {
    if (await limited(env, req, "t", 10, 600)) return reply({ error: "rate_limited" }, 429);
    return reply(await reminderReport(env, user.id));
  }
  if (p === "/api/push/settings" && method === "POST") {
    let b;
    try {
      b = await req.json();
    } catch (e) {
      return reply({ error: "invalid" }, 400);
    }
    if (!b || typeof b.settle !== "boolean") return reply({ error: "invalid" }, 400);
    await env.DB.prepare("UPDATE users SET settle_notif = ?2 WHERE id = ?1").bind(user.id, b.settle ? 1 : 0).run();
    return reply({ ok: true, settle: b.settle });
  }
  if (p === "/api/push/link" && method === "POST") {
    let b;
    try {
      b = await req.json();
    } catch (e) {
      return reply({ error: "invalid" }, 400);
    }
    if (!b || typeof b.token !== "string" || !TOKEN.test(b.token) || !isId(b.member)) return reply({ error: "invalid" }, 400);
    if (await limited(env, req, "p", 60, 600)) return reply({ error: "rate_limited" }, 429);
    const trip = await sha256hex(b.token);
    if (!await env.DB.prepare("SELECT 1 AS x FROM members WHERE trip_id = ?1 AND id = ?2").bind(trip, b.member).first()) return reply({ error: "not_found" }, 404);
    const owner = await env.DB.prepare("SELECT user_id FROM member_links WHERE trip_id = ?1 AND member_id = ?2").bind(trip, b.member).first();
    if (owner && owner.user_id !== user.id) return reply({ error: "taken" }, 409);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM member_links WHERE trip_id = ?1 AND user_id = ?2 AND member_id != ?3").bind(trip, user.id, b.member),
      // one member per person per trip
      env.DB.prepare("INSERT OR IGNORE INTO member_links(trip_id, member_id, user_id) VALUES (?1,?2,?3)").bind(trip, b.member, user.id)
    ]);
    return reply({ ok: true });
  }
  if (p === "/api/push/unsubscribe" && method === "POST") {
    let b;
    try {
      b = await req.json();
    } catch (e) {
      return reply({ error: "invalid" }, 400);
    }
    if (!b || typeof b.endpoint !== "string") return reply({ error: "invalid" }, 400);
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1 AND user_id = ?2").bind(b.endpoint, user.id).run();
    return reply({ ok: true });
  }
  if (p === "/api/account" && method === "DELETE") {
    await env.DB.batch(["backups", "sessions", "attempts", "push_subs", "notif_log", "member_links"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)).concat(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id)));
    return reply({ ok: true }, 200, { "Set-Cookie": cookieHeader("", req, 0) });
  }
  return reply({ error: "not_found" }, 404);
}
__name(handleAccount, "handleAccount");
async function purgeAccountData(env, now) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM attempts WHERE created_at < ?").bind(now - 86400),
    env.DB.prepare("DELETE FROM notif_log WHERE t < ?").bind(now - 3 * 86400),
    env.DB.prepare("DELETE FROM push_subs WHERE user_id IN (SELECT id FROM users WHERE last_login < ?1)").bind(now - INACTIVE_ACCOUNT_DAYS * 86400),
    env.DB.prepare("DELETE FROM backups WHERE user_id IN (SELECT id FROM users WHERE last_login < ?1)").bind(now - INACTIVE_ACCOUNT_DAYS * 86400),
    env.DB.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE last_login < ?1)").bind(now - INACTIVE_ACCOUNT_DAYS * 86400),
    env.DB.prepare("DELETE FROM member_links WHERE user_id IN (SELECT id FROM users WHERE last_login < ?1)").bind(now - INACTIVE_ACCOUNT_DAYS * 86400),
    env.DB.prepare("DELETE FROM users WHERE last_login < ?1").bind(now - INACTIVE_ACCOUNT_DAYS * 86400)
  ]);
}
__name(purgeAccountData, "purgeAccountData");

// worker/index.js
var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
     budget INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (trip_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS expenses (trip_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, payer TEXT NOT NULL,
     cat TEXT NOT NULL, spent_on TEXT NOT NULL, split TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS settlements (trip_id TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL, at TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, transfers TEXT NOT NULL, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS adjustments (trip_id TEXT NOT NULL, id TEXT NOT NULL, settle_id TEXT, nets TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, PRIMARY KEY (trip_id, id))`,
  `CREATE TABLE IF NOT EXISTS paid (trip_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (trip_id, key))`,
  `CREATE TABLE IF NOT EXISTS savings (trip_id TEXT NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (trip_id, member_id))`,
  `CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, w INTEGER NOT NULL, n INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (k, w))`,
  ...ACCOUNT_SCHEMA
];
var ready = null;
var ensure = /* @__PURE__ */ __name((env) => ready || (ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).then(() => env.DB.prepare("ALTER TABLE expenses ADD COLUMN settle_id TEXT").run().catch(() => {
})).then(() => env.DB.prepare("ALTER TABLE users ADD COLUMN settle_notif INTEGER NOT NULL DEFAULT 1").run().catch(() => {
})).then(() => Promise.all(["friend_flag INTEGER NOT NULL DEFAULT 0", "friend_changed INTEGER", "friend_checked_at INTEGER"].map((c) => env.DB.prepare("ALTER TABLE users ADD COLUMN " + c).run().catch(() => {
})))).catch((e) => {
  ready = null;
  throw e;
})), "ensure");
var LIMITS = { members: 12, expenses: 2e3, settlements: 100, adjustments: 2e3, paid: 500, body: 256 * 1024, opsPerRequest: 400 };
var WRITES_PER_10MIN = 300;
var CREATES_PER_DAY = 20;
var RETENTION_DAYS = 400;
var CATS = /* @__PURE__ */ new Set(["transport", "stay", "food", "sight", "gift", "other"]);
var isStr = /* @__PURE__ */ __name((v, max) => typeof v === "string" && v.length <= max, "isStr");
var isId2 = /* @__PURE__ */ __name((v) => typeof v === "string" && /^[\w.-]{1,64}$/.test(v), "isId");
var isInt = /* @__PURE__ */ __name((v, min, max) => Number.isInteger(v) && v >= min && v <= max, "isInt");
var isDate = /* @__PURE__ */ __name((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)), "isDate");
var nonEmpty = /* @__PURE__ */ __name((v) => typeof v === "string" && v.trim().length > 0, "nonEmpty");
var CLEAN = {
  trips: /* @__PURE__ */ __name((r) => isStr(r.name, 100) && nonEmpty(r.name) && isDate(r.start_date) && isDate(r.end_date) && r.end_date >= r.start_date && isInt(r.budget, 1, 1e9) ? { name: r.name.trim(), start_date: r.start_date, end_date: r.end_date, budget: r.budget } : null, "trips"),
  members: /* @__PURE__ */ __name((r) => isId2(r.id) && isStr(r.name, 50) && nonEmpty(r.name) && isInt(r.position, 0, 1e6) ? { id: r.id, name: r.name.trim(), position: r.position } : null, "members"),
  expenses: /* @__PURE__ */ __name((r) => {
    const title = r.title == null ? "" : r.title;
    return isId2(r.id) && isStr(title, 100) && isInt(r.amount, 1, 1e9) && isId2(r.payer) && CATS.has(r.cat) && isDate(r.spent_on) && Array.isArray(r.split) && r.split.length >= 1 && r.split.length <= 12 && r.split.every(isId2) && (r.settle_id == null || isId2(r.settle_id)) ? { id: r.id, title, amount: r.amount, payer: r.payer, cat: r.cat, spent_on: r.spent_on, split: r.split, settle_id: r.settle_id == null ? null : r.settle_id, has_settle: "settle_id" in r } : null;
  }, "expenses"),
  settlements: /* @__PURE__ */ __name((r) => isId2(r.id) && isInt(r.n, 1, 1e5) && isDate(r.at) && isInt(r.total == null ? 0 : r.total, 0, 1e11) && Array.isArray(r.transfers) && r.transfers.length <= 100 && r.transfers.every((x) => x && isId2(x.from) && isId2(x.to) && isInt(x.amount, 1, 1e9)) ? { id: r.id, n: r.n, at: r.at, total: r.total == null ? 0 : r.total, transfers: r.transfers.map((x) => ({ from: x.from, to: x.to, amount: x.amount })) } : null, "settlements"),
  adjustments: /* @__PURE__ */ __name((r) => {
    const nets = r.nets, ks = nets && typeof nets === "object" && !Array.isArray(nets) ? Object.keys(nets) : null, note = r.note == null ? "" : r.note;
    return isId2(r.id) && (r.settle_id == null || isId2(r.settle_id)) && isStr(note, 100) && isDate(r.at) && ks && ks.length <= 12 && ks.every((k) => isId2(k) && isInt(nets[k], -1e9, 1e9)) ? { id: r.id, settle_id: r.settle_id == null ? null : r.settle_id, nets: Object.fromEntries(ks.map((k) => [k, nets[k]])), note, at: r.at } : null;
  }, "adjustments"),
  paid: /* @__PURE__ */ __name((r) => isStr(r.key, 200) && r.key.length > 0 ? { key: r.key } : null, "paid"),
  savings: /* @__PURE__ */ __name((r) => isId2(r.member_id) && isInt(r.amount, 0, 1e9) ? { member_id: r.member_id, amount: r.amount } : null, "savings")
};
var UPDATABLE = /* @__PURE__ */ new Set(["trips", "expenses", "savings", "adjustments"]);
var KEYCOL = { trips: "id", members: "id", expenses: "id", settlements: "id", adjustments: "id", paid: "key", savings: "member_id" };
function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > LIMITS.opsPerRequest) return null;
  const out = { ins: {}, upd: {}, del: {} };
  for (const op of ops) {
    if (!op || !CLEAN[op.table]) return null;
    const bucket = op.kind === "insert" ? out.ins : op.kind === "update" ? out.upd : op.kind === "delete" ? out.del : null;
    if (!bucket || op.kind === "update" && !UPDATABLE.has(op.table)) return null;
    const rows = op.kind === "insert" ? op.rows : [op.row];
    if (!Array.isArray(rows) || rows.length > 2500) return null;
    for (const r of rows) {
      if (!r || typeof r !== "object") return null;
      const c = op.kind === "delete" ? isStr(r[KEYCOL[op.table]], 200) ? { [KEYCOL[op.table]]: r[KEYCOL[op.table]] } : null : CLEAN[op.table](r);
      if (!c) return null;
      (bucket[op.table] = bucket[op.table] || []).push(c);
    }
  }
  return out;
}
__name(validateOps, "validateOps");
var J = JSON.stringify;
var TOKEN2 = /^[A-Za-z0-9_-]{32,64}$/;
async function getTrip(env, id, rev) {
  const tr = await env.DB.prepare("SELECT * FROM trips WHERE id=?").bind(id).first();
  if (!tr) return reply({ error: "not_found" }, 404);
  if (rev && Number(rev) === tr.rev) return reply({ unchanged: true, rev: tr.rev });
  const [m, e, p, s, st, ad] = await env.DB.batch([
    env.DB.prepare("SELECT id,name,position FROM members WHERE trip_id=? ORDER BY position, id").bind(id),
    env.DB.prepare("SELECT id,title,amount,payer,cat,spent_on,split,settle_id,created_at FROM expenses WHERE trip_id=? ORDER BY created_at, id").bind(id),
    env.DB.prepare("SELECT key FROM paid WHERE trip_id=?").bind(id),
    env.DB.prepare("SELECT member_id,amount FROM savings WHERE trip_id=?").bind(id),
    env.DB.prepare("SELECT id,n,at,total,transfers FROM settlements WHERE trip_id=? ORDER BY n, id").bind(id),
    env.DB.prepare("SELECT id,settle_id,nets,note,at FROM adjustments WHERE trip_id=? ORDER BY at, id").bind(id)
  ]);
  return reply({ rev: tr.rev, trip: {
    id,
    name: tr.name,
    start_date: tr.start_date,
    end_date: tr.end_date,
    budget: tr.budget,
    owner: null,
    trip_members: m.results.map((r) => ({ id: r.id, name: r.name, position: r.position, user_id: null, status: "joined" })),
    expenses: e.results.map((r) => ({ id: r.id, title: r.title, amount: r.amount, payer: r.payer, cat: r.cat, spent_on: r.spent_on, split: JSON.parse(r.split), settle_id: r.settle_id || null, created_at: r.created_at })),
    settlements: st.results.map((r) => ({ id: r.id, n: r.n, at: r.at, total: r.total, transfers: JSON.parse(r.transfers) })),
    adjustments: ad.results.map((r) => ({ id: r.id, settle_id: r.settle_id || null, nets: JSON.parse(r.nets), note: r.note, at: r.at })),
    paid: p.results.map((r) => ({ trip_id: id, key: r.key })),
    savings: s.results.map((r) => ({ trip_id: id, member_id: r.member_id, amount: r.amount }))
  } });
}
__name(getTrip, "getTrip");
async function applyOps(env, req, id, ctx) {
  const text = await req.text();
  if (text.length > LIMITS.body) return reply({ error: "too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return reply({ error: "invalid" }, 400);
  }
  const v = validateOps(body && body.ops);
  if (!v) return reply({ error: "invalid" }, 400);
  const { ins, upd, del } = v;
  const DB = env.DB, now = Date.now();
  const tr = await DB.prepare("SELECT rev FROM trips WHERE id=?").bind(id).first();
  if (!tr && !ins.trips) return reply({ error: "not_found" }, 404);
  if (!tr && await limited(env, req, "c", CREATES_PER_DAY, 86400)) return reply({ error: "rate_limited" }, 429);
  if (await limited(env, req, "w", WRITES_PER_10MIN, 600)) return reply({ error: "rate_limited" }, 429);
  if (tr) {
    const c = await DB.prepare(`SELECT (SELECT COUNT(*) FROM members WHERE trip_id=?1) m, (SELECT COUNT(*) FROM expenses WHERE trip_id=?1) e, (SELECT COUNT(*) FROM paid WHERE trip_id=?1) p, (SELECT COUNT(*) FROM settlements WHERE trip_id=?1) s, (SELECT COUNT(*) FROM adjustments WHERE trip_id=?1) a`).bind(id).first();
    if (c.m + (ins.members || []).length > LIMITS.members || c.e + (ins.expenses || []).length > LIMITS.expenses || c.p + (ins.paid || []).length > LIMITS.paid || c.s + (ins.settlements || []).length > LIMITS.settlements || c.a + (ins.adjustments || []).length > LIMITS.adjustments) return reply({ error: "limit" }, 413);
  } else if ((ins.members || []).length > LIMITS.members || (ins.expenses || []).length > LIMITS.expenses || (ins.paid || []).length > LIMITS.paid || (ins.settlements || []).length > LIMITS.settlements || (ins.adjustments || []).length > LIMITS.adjustments) return reply({ error: "limit" }, 413);
  const S = [], P = /* @__PURE__ */ __name((s) => DB.prepare(s), "P");
  if (ins.trips) {
    const t = ins.trips[0];
    S.push(P("INSERT OR IGNORE INTO trips(id,name,start_date,end_date,budget,rev,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)").bind(id, t.name, t.start_date, t.end_date, t.budget, now, now));
  }
  if (ins.members) S.push(P(`INSERT OR IGNORE INTO members(trip_id,id,name,position) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.name'), json_extract(value,'$.position') FROM json_each(?2)`).bind(id, J(ins.members)));
  if (ins.expenses) S.push(P(`INSERT OR IGNORE INTO expenses(trip_id,id,title,amount,payer,cat,spent_on,split,settle_id,created_at)
      SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.title'), json_extract(value,'$.amount'), json_extract(value,'$.payer'), json_extract(value,'$.cat'),
             json_extract(value,'$.spent_on'), json_extract(value,'$.split'), json_extract(value,'$.settle_id'), ?3 * 1000 + CAST(key AS INTEGER) FROM json_each(?2)`).bind(id, J(ins.expenses), now));
  if (ins.settlements) S.push(P(`INSERT OR IGNORE INTO settlements(trip_id,id,n,at,total,transfers) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.n'), json_extract(value,'$.at'), json_extract(value,'$.total'), json_extract(value,'$.transfers') FROM json_each(?2)`).bind(id, J(ins.settlements)));
  if (ins.adjustments) S.push(P(`INSERT OR IGNORE INTO adjustments(trip_id,id,settle_id,nets,note,at) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.settle_id'), json_extract(value,'$.nets'), json_extract(value,'$.note'), json_extract(value,'$.at') FROM json_each(?2)`).bind(id, J(ins.adjustments)));
  if (ins.paid) S.push(P(`INSERT OR IGNORE INTO paid(trip_id,key) SELECT ?1, json_extract(value,'$.key') FROM json_each(?2)`).bind(id, J(ins.paid)));
  if (ins.savings) S.push(P(`INSERT OR IGNORE INTO savings(trip_id,member_id,amount) SELECT ?1, json_extract(value,'$.member_id'), json_extract(value,'$.amount') FROM json_each(?2)`).bind(id, J(ins.savings)));
  if (upd.trips) {
    const t = upd.trips[upd.trips.length - 1];
    S.push(P("UPDATE trips SET name=?1, start_date=?2, end_date=?3, budget=?4 WHERE id=?5").bind(t.name, t.start_date, t.end_date, t.budget, id));
  }
  if (upd.expenses) S.push(P(`UPDATE expenses SET title=j.title, amount=j.amount, payer=j.payer, cat=j.cat, spent_on=j.spent_on, split=j.split,
      settle_id = CASE WHEN j.has_settle = 1 THEN j.settle_id ELSE expenses.settle_id END   -- an older app that does not know about rounds must not wipe it
      FROM (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.title') AS title, json_extract(value,'$.amount') AS amount, json_extract(value,'$.payer') AS payer,
                   json_extract(value,'$.cat') AS cat, json_extract(value,'$.spent_on') AS spent_on, json_extract(value,'$.split') AS split,
                   json_extract(value,'$.settle_id') AS settle_id, json_extract(value,'$.has_settle') AS has_settle FROM json_each(?2)) AS j
      WHERE expenses.trip_id=?1 AND expenses.id=j.id`).bind(id, J(upd.expenses)));
  if (upd.adjustments) S.push(P(`UPDATE adjustments SET settle_id=j.settle_id
      FROM (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.settle_id') AS settle_id FROM json_each(?2)) AS j
      WHERE adjustments.trip_id=?1 AND adjustments.id=j.id`).bind(id, J(upd.adjustments)));
  if (upd.savings) S.push(P(`UPDATE savings SET amount=j.amount
      FROM (SELECT json_extract(value,'$.member_id') AS member_id, json_extract(value,'$.amount') AS amount FROM json_each(?2)) AS j
      WHERE savings.trip_id=?1 AND savings.member_id=j.member_id`).bind(id, J(upd.savings)));
  if (del.paid) S.push(P(`DELETE FROM paid WHERE trip_id=?1 AND key IN (SELECT json_extract(value,'$.key') FROM json_each(?2))`).bind(id, J(del.paid)));
  if (del.savings) S.push(P(`DELETE FROM savings WHERE trip_id=?1 AND member_id IN (SELECT json_extract(value,'$.member_id') FROM json_each(?2))`).bind(id, J(del.savings)));
  if (del.expenses) S.push(P(`DELETE FROM expenses WHERE trip_id=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))`).bind(id, J(del.expenses)));
  if (del.members) S.push(P(`DELETE FROM members WHERE trip_id=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))`).bind(id, J(del.members)));
  if (del.trips) S.push(...wipe(DB, id));
  S.push(P("UPDATE trips SET rev = rev + 1, updated_at = ?2 WHERE id = ?1").bind(id, now));
  await DB.batch(S);
  if (ctx && ctx.waitUntil && (ins.settlements || ins.paid)) ctx.waitUntil(notifyOps(env, id, ins).catch((e) => console.error("settle notify failed", e && e.message)));
  const after = await DB.prepare("SELECT rev FROM trips WHERE id=?").bind(id).first();
  return reply({ ok: true, rev: after ? after.rev : 0 });
}
__name(applyOps, "applyOps");
var wipe = /* @__PURE__ */ __name((DB, id) => ["member_links", "paid", "savings", "expenses", "settlements", "adjustments", "members"].map((t) => DB.prepare(`DELETE FROM ${t} WHERE trip_id=?`).bind(id)).concat(DB.prepare("DELETE FROM trips WHERE id=?").bind(id)), "wipe");
var worker_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("not found", { status: 404 });
    try {
      await ensure(env);
      if (env.TEST_HOOKS === "1" && url.pathname === "/api/_test/reminders" && req.method === "POST") {
        const b = await req.json();
        return reply(await runReminders(env, b.now));
      }
      const acct = await handleAccount(req, env, url);
      if (acct) return acct;
      const m = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") || "");
      if (!m || !TOKEN2.test(m[1])) return reply({ error: "unauthorized" }, 401);
      const id = await sha256hex(m[1]);
      if (url.pathname === "/api/trip" && req.method === "GET") return await getTrip(env, id, url.searchParams.get("rev"));
      if (url.pathname === "/api/ops" && req.method === "POST") return await applyOps(env, req, id, ctx);
      if (url.pathname === "/api/reach" && req.method === "GET") {
        if (!await env.DB.prepare("SELECT 1 AS x FROM trips WHERE id=?").bind(id).first()) return reply({ error: "not_found" }, 404);
        return reply({ reachable: await reachable(env, id) });
      }
      if (url.pathname === "/api/trip" && req.method === "DELETE") {
        if (await limited(env, req, "w", WRITES_PER_10MIN, 600)) return reply({ error: "rate_limited" }, 429);
        await env.DB.batch(wipe(env.DB, id));
        return reply({ ok: true });
      }
      return reply({ error: "not_found" }, 404);
    } catch (e) {
      console.error("api error", e && e.message);
      return reply({ error: "server" }, 500);
    }
  },
  /* hourly: send reminders. Once a day (03:00 Japan time): forget old counters and expired data. */
  async scheduled(event, env) {
    await ensure(env);
    const at = event.scheduledTime || Date.now();
    let out = null, err = null;
    try {
      out = await runReminders(env, at);
    } catch (e) {
      err = String(e && e.message || e).slice(0, 200);
      console.error("reminders failed", err);
    }
    try {
      await env.DB.prepare("INSERT INTO meta(k, v) VALUES ('last_cron', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ at, out, err })).run();
    } catch (e) {
    }
    if (new Date(at).getUTCHours() !== 18) return;
    const now = Date.now();
    await env.DB.prepare("DELETE FROM hits WHERE t < ?").bind(Math.floor(now / 1e3) - 2 * 86400).run();
    await purgeAccountData(env, Math.floor(now / 1e3));
    const old = await env.DB.prepare("SELECT id FROM trips WHERE updated_at < ? LIMIT 200").bind(now - RETENTION_DAYS * 864e5).all();
    for (const r of old.results) await env.DB.batch(wipe(env.DB, r.id));
  }
};

// ../../../root/.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../root/.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-3CggDS/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../root/.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-3CggDS/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default,
  validateOps
};
//# sourceMappingURL=index.js.map
