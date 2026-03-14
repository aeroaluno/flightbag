// sw.js — FlightBag offline
// Version aligned with app v1.10.20
const CACHE_NAME = "flightbag-cache-v1.10.20";

// Core app shell — cached on install for guaranteed offline startup
const CORE = [
    "./",
    "./index.html",
    "./sw.js",
  ];

// OCR engine files — cached on install so OCR works fully offline
// These files are served locally (downloaded into the project folder)
const OCR_FILES = [
    "./tesseract.min.js",
    "./worker.min.js",
    "./tesseract-core.wasm.js",
    "./eng.traineddata.gz",
  ];

// All files to precache at install time
const PRECACHE = [...CORE, ...OCR_FILES];

self.addEventListener("install", (event) => {
    event.waitUntil(
          caches.open(CACHE_NAME).then((cache) => {
                  // Cache core files — these must succeed
                                             return cache.addAll(CORE).then(() => {
                                                       // Cache OCR files individually so a single failure doesn't break install
                                                                                    return Promise.allSettled(
                                                                                                OCR_FILES.map((url) =>
                                                                                                              cache.add(url).catch((err) => {
                                                                                                                              console.warn("[SW] Failed to precache OCR file:", url, err);
                                                                                                                })
                                                                                                                        )
                                                                                              );
                                             });
          })
        );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
          caches.keys().then((keys) =>
                  Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
                                 )
        );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const req = event.request;

                        // Navigation: NETWORK FIRST → get fresh app, fallback to cached for offline
                        if (req.mode === "navigate") {
                              event.respondWith(
                                      fetch(req)
                                        .then((resp) => {
                                                    const copy = resp.clone();
                                                    caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
                                                    return resp;
                                        })
                                        .catch(() => caches.match("./index.html"))
                                    );
                              return;
                        }

                        // OCR engine files: CACHE FIRST — large files, serve from cache immediately
                        // Falls back to network only if somehow missing from cache
                        const url = req.url;
    const isOcrFile = (
          url.includes("tesseract") ||
          url.includes("worker.min.js") ||
          url.includes("traineddata")
        );

                        if (isOcrFile) {
                              event.respondWith(
                                      caches.match(req).then((cached) => {
                                                if (cached) return cached;
                                                // Not in cache — fetch, cache, and return
                                                                     return fetch(req).then((resp) => {
                                                                                 if (resp.ok) {
                                                                                               const copy = resp.clone();
                                                                                               caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                                                                                 }
                                                                                 return resp;
                                                                     });
                                      })
                                    );
                              return;
                        }

                        // All other static assets: CACHE FIRST with network fallback
                        event.respondWith(
                              caches.match(req).then((cached) => {
                                      if (cached) return cached;
                                      return fetch(req).then((resp) => {
                                                if (resp.ok) {
                                                            const copy = resp.clone();
                                                            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                                                }
                                                return resp;
                                      });
                              })
                            );
});
