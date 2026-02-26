/* FlightBag v2 — Service Worker (GitHub Pages) */
const CACHE_NAME = "flightbag-v2-20260226-01";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./sw.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if(event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin (GitHub Pages)
  if(url.origin !== self.location.origin) return;

  // Navigation requests: serve cached index.html first (offline)
  if(req.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then((cached) => cached || fetch(req).catch(() => cached))
    );
    return;
  }

  // Cache-first for other same-origin assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if(cached) return cached;
      return fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => cached);
    })
  );
});
