// sw.js — FlightBag
// v2.0.0 — Aggressive prefetch + stale-while-revalidate (inspired by Angular NGSW)
// Strategy: cache everything on install, serve from cache, update in background

const SW_VERSION = "v2.0.0";
const CACHE_CORE = "fb-core-v14";
const CACHE_OCR  = "fb-ocr-v1";
const CACHE_CDN  = "fb-cdn-v1";

// ── FILES TO PREFETCH ON INSTALL ─────────────────────────────────────────
// These are downloaded immediately when the SW installs (before any user action)
const CORE_FILES = [
    "./",
    "./index.html",
    "./manifest.json",
    "./icon-180.png",
];

const OCR_FILES = [
    "./tesseract.min.js",
    "./worker.min.js",
    "./tesseract-core.wasm.js",
    "./eng.traineddata.gz",
];

// CDN resources that should be cached for offline use
const CDN_PATTERNS = [
    "fonts.googleapis.com",
    "fonts.gstatic.com",
];

// ── INSTALL ──────────────────────────────────────────────────────────────
// Prefetch all core files into cache immediately
self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            // Cache core files (index.html, manifest, icons)
            const coreCache = await caches.open(CACHE_CORE);
            await coreCache.addAll(CORE_FILES).catch((e) => {
                // If any file fails, try them individually
                return Promise.allSettled(
                    CORE_FILES.map((url) =>
                        fetch(url).then((r) => {
                            if (r.ok) return coreCache.put(url, r);
                        }).catch(() => {})
                    )
                );
            });

            // Cache OCR files (large, do individually so one failure doesn't block all)
            const ocrCache = await caches.open(CACHE_OCR);
            await Promise.allSettled(
                OCR_FILES.map((url) =>
                    ocrCache.match(url).then((existing) => {
                        // Only fetch if not already cached (these are large)
                        if (existing) return;
                        return fetch(url).then((r) => {
                            if (r.ok) return ocrCache.put(url, r);
                        });
                    }).catch(() => {})
                )
            );

            // Activate immediately
            self.skipWaiting();
        })()
    );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            // Clean up old caches that don't match current version
            const validCaches = [CACHE_CORE, CACHE_OCR, CACHE_CDN];
            const allKeys = await caches.keys();
            await Promise.all(
                allKeys
                    .filter((k) => !validCaches.includes(k))
                    .map((k) => caches.delete(k))
            );
            // Take control of all open tabs immediately
            await self.clients.claim();
        })()
    );
});

// ── MESSAGE ──────────────────────────────────────────────────────────────
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
    if (event.data === "getVersion") {
        event.source.postMessage({ type: "version", version: SW_VERSION });
    }
});

// ── FETCH ────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // ── NAVIGATION (index.html) ──────────────────────────────────────────
    // Stale-while-revalidate: serve cache instantly, update in background
    if (req.mode === "navigate") {
        event.respondWith(staleWhileRevalidate(req, CACHE_CORE));
        return;
    }

    // ── SAME-ORIGIN ASSETS ───────────────────────────────────────────────
    if (url.origin === self.location.origin) {
        // OCR files: cache-first (large, rarely change)
        if (isOcrFile(url.pathname)) {
            event.respondWith(cacheFirst(req, CACHE_OCR));
            return;
        }
        // Other same-origin: stale-while-revalidate
        event.respondWith(staleWhileRevalidate(req, CACHE_CORE));
        return;
    }

    // ── CDN RESOURCES (fonts, etc) ───────────────────────────────────────
    if (CDN_PATTERNS.some((p) => url.hostname.includes(p))) {
        event.respondWith(cacheFirst(req, CACHE_CDN));
        return;
    }

    // ── EXTERNAL APIs (CheckWX, Aviation Edge, Worker) ───────────────────
    // Don't cache API responses — let them pass through to network
});

// ── STRATEGIES ───────────────────────────────────────────────────────────

/**
 * Stale-While-Revalidate:
 * 1. Return cached version instantly (fast!)
 * 2. Fetch fresh version in background
 * 3. Update cache for next visit
 * 4. Notify app if new version found
 */
async function staleWhileRevalidate(req, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req, { ignoreSearch: true, ignoreVary: true });

    // Background update (don't await — fire and forget)
    const fetchPromise = fetch(req)
        .then(async (resp) => {
            if (resp && resp.ok) {
                await cache.put(req, resp.clone()).catch(() => {});
                // Also store as ./index.html for navigation fallback
                if (req.mode === "navigate") {
                    await cache.put(
                        new URL("./index.html", self.location).href,
                        resp.clone()
                    ).catch(() => {});
                }
                // If we had a cached version, check if content changed
                if (cached) {
                    const oldEtag = cached.headers.get("etag");
                    const newEtag = resp.headers.get("etag");
                    const oldLen = cached.headers.get("content-length");
                    const newLen = resp.headers.get("content-length");
                    if (
                        (oldEtag && newEtag && oldEtag !== newEtag) ||
                        (oldLen && newLen && oldLen !== newLen)
                    ) {
                        // Notify all clients that new content is available
                        const clients = await self.clients.matchAll();
                        clients.forEach((client) => {
                            client.postMessage({
                                type: "UPDATE_AVAILABLE",
                                version: SW_VERSION,
                            });
                        });
                    }
                }
            }
            return resp;
        })
        .catch(() => null);

    // If we have a cached version, return it immediately
    if (cached) return cached;

    // No cache — must wait for network
    const networkResp = await fetchPromise;
    if (networkResp) return networkResp;

    // Nothing — show offline page for navigation
    if (req.mode === "navigate") return offlinePage();
    return new Response("", { status: 408 });
}

/**
 * Cache-First:
 * Return cached version if available, otherwise fetch and cache.
 * Best for large static files (OCR, fonts) that rarely change.
 */
async function cacheFirst(req, cacheName) {
    const cache = await caches.open(cacheName);
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

// ── HELPERS ──────────────────────────────────────────────────────────────

function isOcrFile(pathname) {
    return (
        pathname.includes("tesseract") ||
        pathname.includes("worker.min.js") ||
        pathname.includes("traineddata")
    );
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
  body{margin:0;font-family:'B612',system-ui,sans-serif;background:#040506;color:#dce4ed;
       display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
  .box{padding:32px;max-width:360px;}
  .icon{font-size:52px;margin-bottom:18px;}
  h2{font-size:18px;margin:0 0 10px;color:#fff;}
  p{color:#8494a7;font-size:13px;line-height:1.7;margin:0 0 6px;}
  strong{color:#94a3b8;}
  button{margin-top:22px;padding:14px 28px;border:none;border-radius:12px;
         background:#38bdf8;color:#040506;font-size:15px;font-weight:700;cursor:pointer;width:100%;}
</style></head>
<body><div class="box">
  <div class="icon">&#9992;</div>
  <h2>FlightBag — Offline</h2>
  <p>O aplicativo precisa ser carregado ao menos uma vez <strong>com internet</strong>.</p>
  <p>Se ja fez isso, feche e abra o app novamente.</p>
  <button onclick="location.reload()">Tentar novamente</button>
</div></body></html>`,
        { headers: { "Content-Type": "text/html;charset=utf-8" } }
    );
}
