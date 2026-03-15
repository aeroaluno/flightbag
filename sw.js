// sw.js - FlightBag offline
// v1.10.26 - iOS PWA support + robust cache-first navigation
const CACHE_NAME = "flightbag-cache-v1.10.26";

// Core shell — must all be cached for offline to work
const CORE = [
    "./",
    "./index.html",
    "./sw.js",
    "./manifest.json",
    "./icon.svg",
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

    // Navigation requests: CACHE FIRST
    // iOS Safari needs this path to work reliably for offline PWA support
    if (req.mode === "navigate") {
        event.respondWith(
            (async () => {
                try {
                    const cache = await caches.open(CACHE_NAME);

                    // Try multiple keys — ignoreSearch handles ?v=timestamp redirects
                    const cached =
                        await cache.match(req, { ignoreSearch: true }) ||
                        await cache.match("./index.html", { ignoreSearch: true }) ||
                        await cache.match("./", { ignoreSearch: true }) ||
                        await caches.match(req, { ignoreSearch: true }) ||
                        await caches.match("./index.html", { ignoreSearch: true });

                    // Update cache silently in background (stale-while-revalidate)
                    fetch(req).then((resp) => {
                        if (resp && resp.ok) {
                            cache.put(req, resp.clone());
                            cache.put("./index.html", resp.clone());
                        }
                    }).catch(() => { /* offline — no update needed */ });

                    if (cached) return cached;

                    // Not cached yet — must go to network
                    const netResp = await fetch(req);
                    if (netResp.ok) {
                        cache.put(req, netResp.clone());
                        cache.put("./index.html", netResp.clone());
                    }
                    return netResp;

                } catch (err) {
                    // Offline AND nothing in cache (first ever visit) — friendly error page
                    return new Response(
                        `<!DOCTYPE html><html lang="pt"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>FlightBag</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
  .box{padding:32px;max-width:380px;}
  .icon{font-size:56px;margin-bottom:20px;}
  h2{font-size:20px;margin:0 0 12px;}
  p{color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 8px;}
  button{margin-top:24px;padding:14px 32px;border:none;border-radius:12px;
         background:#3b82f6;color:#fff;font-size:16px;cursor:pointer;width:100%;}
</style></head>
<body><div class="box">
  <div class="icon">&#9992;</div>
  <h2>FlightBag &mdash; Sem conexao</h2>
  <p>Para usar offline, abra o app pelo menos uma vez com internet.</p>
  <p>Se ja fez isso, tente: <strong>Settings &rsaquo; Safari &rsaquo; Clear History</strong> e reabra o app com internet.</p>
  <button onclick="location.reload()">Tentar novamente</button>
</div></body></html>`,
                        { headers: { "Content-Type": "text/html;charset=utf-8" } }
                    );
                }
            })()
        );
        return;
    }

    // OCR engine files: CACHE FIRST (large files — always serve from cache)
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

    // All other assets: CACHE FIRST with network fallback
    event.respondWith(
        caches.match(req, { ignoreSearch: true }).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((resp) => {
                if (resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return resp;
            }).catch(() => new Response("", { status: 408 }));
        })
    );
});
