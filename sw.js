// sw.js — FlightBag offline
// Version aligned with app v1.10.24
const CACHE_NAME = "flightbag-cache-v1.10.24";

const CORE = [
    "./",
    "./index.html",
    "./sw.js",
  ];

const OCR_FILES = [
    "./tesseract.min.js",
    "./worker.min.js",
    "./tesseract-core.wasm.js",
    "./eng.traineddata.gz",
  ];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(CORE).then(() => {
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

    // Navigation: CACHE FIRST — serve from cache instantly, update in background
    if (req.mode === "navigate") {
        event.respondWith(
            caches.match("./index.html").then((cached) => {
                const networkUpdate = fetch(req)
                    .then((resp) => {
                        if (resp.ok) {
                            const copy = resp.clone();
                            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
                        }
                        return resp;
                    })
                    .catch(() => null);
                return cached || networkUpdate;
            })
        );
        return;
    }

    // OCR engine files: CACHE FIRST
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
