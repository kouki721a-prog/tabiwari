/* Offline cache for the app shell. Bump VERSION when any cached file changes. API calls are never cached. */
const VERSION = 'tabiwari-v49';
const FILES = ['./', './index.html', './config.js', './sync.js', './share.js', './line.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon-maskable-512.png', './icons/line-login-icon.png'];
const OPTIONAL = ['./terms.html', './privacy.html', './legal.css'];   // optional: a missing one must not break the install
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES).then(() => Promise.all(OPTIONAL.map(f => c.add(f).catch(() => {}))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Network first, so a new release shows up on the next open; the cached copy is used only when offline or slow (>4s). */
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const fromCache = () => cache.match(e.request, { ignoreSearch: true });
    try {
      const res = await Promise.race([fetch(e.request), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await fromCache();
      if (hit) return hit;
      throw err;
    }
  })());
});

/* Web Push: reminders sent by the send-reminders Edge Function. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'たびわり', { body: d.body || '', icon: 'icons/icon-192.png', tag: d.tag, data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws.find(c => c.url.indexOf(self.registration.scope) === 0);
    if (!w) return clients.openWindow(url);
    w.postMessage({ open: url });   // the open app switches to that trip
    return w.focus();
  }));
});
