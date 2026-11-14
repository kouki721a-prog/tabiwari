/* Offline cache for the app shell. Bump VERSION when any cached file changes. API calls are never cached. */
const VERSION = 'tabiwari-v60';
const FILES = ['./', './index.html', './config.js', './sync.js', './share.js', './line.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon-maskable-512.png', './icons/line-login-icon.png'];
const OPTIONAL = ['./terms.html', './privacy.html', './legal.css'];   // optional: a missing one must not break the install
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))).then(() => Promise.all(OPTIONAL.map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => {}))))).then(() => self.skipWaiting()));   // 'reload': never save a stale copy from the browser's own cache
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Cache first: the app opens at once from the copy saved by the newest service worker (all files of one version are saved together, so they always match).
   A new release is picked up in the background (the browser re-checks sw.js on a launch, installs it and fills a new cache); it shows on the NEXT open.
   Server calls (/api/) never go through here, so nothing from them is saved. */
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit.redirected ? new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers: hit.headers }) : hit;   // a saved copy that came through a redirect (terms.html -> /terms) is refused by the browser for a page load: hand out a plain copy
    const res = await fetch(e.request);   // not saved yet (for example a page that was never opened): from the network
    if (res && res.ok) cache.put(e.request, res.clone());
    return res;
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
