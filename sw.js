// sw.js — FlightBag
// v1.12.6 — network-first for HTML, auto-update support
const CACHE_NAME = "flightbag-v1.12.6";

const OCR_FILES = [
    "./tesseract.min.js",
    "./worker.min.js",
    "./tesseract-core.wasm.js",
    "./eng.traineddata.gz",
];

// ── INSTALL ──────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
    // skipWaiting = activate immediately, don't wait for old tabs to close
    self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            // Delete ALL old caches
            const allKeys = await caches.keys();
            await Promise.all(
                allKeys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            );
            // Take control of all open tabs immediately
            await self.clients.claim();
        })()
    );
});

// ── MESSAGE ──────────────────────────────────────────────────────────────
// Listen for skip-waiting and cache-clear messages from the app
self.addEventListener("message", (event) => {
    if (event.data === "skipWaiting") {
        self.skipWaiting();
    }
    if (event.data === "clearAll") {
        event.waitUntil(
            caches.keys().then((keys) =>
                Promise.all(keys.map((k) => caches.delete(k)))
            )
        );
    }
});

// ── FETCH ────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
    const req = event.request;

    // Only handle GET requests from same origin
    if (req.method !== "GET") return;
    if (!req.url.startsWith(self.location.origin)) return;

    // NAVIGATION (index.html): NETWORK-FIRST — always get latest
    if (req.mode === "navigate") {
        event.respondWith(networkFirst(req));
        return;
    }

    // OCR engine: cache-first (large files, rarely change)
    if (
        req.url.includes("tesseract") ||
        req.url.includes("worker.min.js") ||
        req.url.includes("traineddata")
    ) {
        event.respondWith(cacheFirst(req));
        return;
    }

    // Other same-origin assets (manifest, icons): network-first
    event.respondWith(networkFirst(req));
});

// ── STRATEGIES ───────────────────────────────────────────────────────────

async function networkFirst(req) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
            // Store in cache for offline use
            cache.put(req, resp.clone()).catch(() => {});
            // Also store as index.html for navigation fallback
            if (req.mode === "navigate") {
                cache.put(
                    new URL("./index.html", self.location).href,
                    resp.clone()
                ).catch(() => {});
            }
        }
        return resp;
    } catch (e) {
        // Network failed — try cache
        const opts = { ignoreSearch: true, ignoreVary: true };
        const cached =
            (await cache.match(req, opts)) ||
            (await cache.match("./index.html", opts)) ||
            (await cache.match("./", opts));
        if (cached) return cached;
        // Nothing in cache either
        if (req.mode === "navigate") return offlinePage();
        return new Response("", { status: 408 });
    }
}

async function cacheFirst(req) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (cached) return cached;
    try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
            cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
    } catch (e) {
        return new Response("", { status: 408 });
    }
}

function offlinePage() {
    return new Response(
        `<!DOCTYPE html><html lang="pt"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>FlightBag</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#050607;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
  .box{padding:32px;max-width:360px;}
  .icon{font-size:52px;margin-bottom:18px;}
  h2{font-size:18px;margin:0 0 10px;color:#fff;}
  p{color:#6a7f9a;font-size:13px;line-height:1.7;margin:0 0 6px;}
  strong{color:#94a3b8;}
  button{margin-top:22px;padding:14px 28px;border:none;border-radius:12px;
         background:#28c3ff;color:#050607;font-size:15px;font-weight:800;cursor:pointer;width:100%;}
</style></head>
<body><div class="box">
  <div class="icon">&#9992;</div>
  <h2>FlightBag — Sem conexao</h2>
  <p>O aplicativo precisa ser carregado ao menos uma vez <strong>com internet</strong>.</p>
  <p>Se ja fez isso, abra o app com internet para sincronizar o cache.</p>
  <button onclick="location.reload()">Tentar novamente</button>
</div></body></html>`,
        { headers: { "Content-Type": "text/html;charset=utf-8" } }
    );
}
