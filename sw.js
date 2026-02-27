/* FlightBag v2 Service Worker
   Bump CACHE_NAME on every deploy to force update.
*/
const CACHE_NAME = 'flightbag-v2-20260226-01';
const ASSETS = [
  './',
  './index.html',
  './sw.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      // Cache same-origin html/js/css/images
      const url = new URL(req.url);
      if (url.origin === self.location.origin) {
        const ct = fresh.headers.get('content-type') || '';
        if (ct.includes('text/html') || ct.includes('javascript') || ct.includes('text/css') || ct.includes('image/')) {
          cache.put(req, fresh.clone());
        }
      }
      return fresh;
    } catch (e) {
      // Offline fallback: try root
      return (await cache.match('./')) || cached;
    }
  })());
});
