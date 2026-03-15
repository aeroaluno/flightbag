// sw.js - FlightBag offline
// v1.10.25 - cache-first navigation with robust fallback
const CACHE_NAME = "flightbag-cache-v1.10.25";

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

    // Navigation: CACHE FIRST — tries multiple keys, updates in background
    if (req.mode === "navigate") {
        event.respondWith(
            (async () => {
                try {
                    const cache = await caches.open(CACHE_NAME);

                    // Try multiple cache keys (handles GitHub Pages root vs /index.html)
                    const cached = await cache.match(req)
                                || await cache.match("./index.html")
                                || await cache.match("./")
                                || await caches.match(req)
                                || await caches.match("./index.html");

                    // Stale-while-revalidate: update cache in background
                    fetch(req).then((resp) => {
                        if (resp && resp.ok) {
                            cache.put(req, resp.clone());
                            cache.put("./index.html", resp.clone());
                        }
                    }).catch(() => {});

                    if (cached) return cached;

                    // Nothing in cache — try network
                    const netResp = await fetch(req);
                    if (netResp.ok) {
                        cache.put(req, netResp.clone());
                        cache.put("./index.html", netResp.clone());
                    }
                    return netResp;

                } catch (err) {
                    // Offline and nothing cached — friendly fallback page
                    return new Response(
                        `<!DOCTYPE html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlightBag</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;}
  .box{padding:32px;max-width:360px;}
  h2{font-size:22px;margin-bottom:8px;}
  p{color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 8px;}
  button{margin-top:20px;padding:12px 28px;border:none;border-radius:10px;
         background:#3b82f6;color:#fff;font-size:15px;cursor:pointer;}
  .icon{font-size:48px;margin-bottom:16px;}
</style></head>
<body><div class="box">
  <div class="icon">&#9992;</div>
  <h2>FlightBag &mdash; Sem conexao</h2>
  <p>O app nao esta armazenado em cache neste dispositivo.</p>
  <p>Conecte-se a internet e abra o app uma vez para ativar o modo offline.</p>
  <button onclick="location.reload()">Tentar novamente</button>
</div></body></html>`,
                        { headers: { "Content-Type": "text/html;charset=utf-8" } }
                    );
                }
            })()
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

    // All other assets: CACHE FIRST with network fallback
    event.respondWith(
        caches.match(req).then((cached) => {
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
