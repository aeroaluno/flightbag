// sw.js — FlightBag
// v2.1.0 — Bulletproof offline (inspired by Angular NGSW + reference app)
// Strategy: aggressive prefetch, cache-first for assets, stale-while-revalidate for HTML

const SW_VERSION = "v2.1.0";
const CACHE_CORE = "fb-core-v15";
const CACHE_OCR  = "fb-ocr-v1";
const CACHE_CDN  = "fb-cdn-v2";

// ── FILES TO PREFETCH ON INSTALL ─────────────────────────────────────────
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

// Google Fonts CSS URL to prefetch
const FONT_CSS_URL = "https://fonts.googleapis.com/css2?family=B612:ital,wght@0,400;0,700;1,400;1,700&family=B612+Mono:wght@400;700&display=swap";

// CDN patterns to cache opportunistically
const CDN_PATTERNS = [
    "fonts.googleapis.com",
    "fonts.gstatic.com",
];

// ── INSTALL ──────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            // 1. Cache core files
            const coreCache = await caches.open(CACHE_CORE);
            await coreCache.addAll(CORE_FILES).catch(() => {
                return Promise.allSettled(
                    CORE_FILES.map((url) =>
                        fetch(url).then((r) => {
                            if (r.ok) return coreCache.put(url, r);
                        }).catch(() => {})
                    )
                );
            });

            // 2. Cache OCR files (skip if already cached — they're large)
            const ocrCache = await caches.open(CACHE_OCR);
            await Promise.allSettled(
                OCR_FILES.map((url) =>
                    ocrCache.match(url).then((existing) => {
                        if (existing) return;
                        return fetch(url).then((r) => {
                            if (r.ok) return ocrCache.put(url, r);
                        });
                    }).catch(() => {})
                )
            );

            // 3. Prefetch Google Fonts (CSS + WOFF2 files)
            try {
                const cdnCache = await caches.open(CACHE_CDN);
                const fontCssResp = await fetch(FONT_CSS_URL);
                if (fontCssResp.ok) {
                    const cssText = await fontCssResp.clone().text();
                    await cdnCache.put(FONT_CSS_URL, fontCssResp);
                    // Extract woff2 URLs from CSS and prefetch them
                    const woff2Urls = cssText.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g);
                    if (woff2Urls) {
                        await Promise.allSettled(
                            woff2Urls.map((m) => {
                                const u = m.slice(4, -1);
                                return cdnCache.match(u).then((ex) => {
                                    if (ex) return;
                                    return fetch(u, { mode: "cors" }).then((r) => {
                                        if (r.ok) return cdnCache.put(u, r);
                                    });
                                });
                            })
                        );
                    }
                }
            } catch (e) { /* fonts are non-critical */ }

            self.skipWaiting();
        })()
    );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const validCaches = [CACHE_CORE, CACHE_OCR, CACHE_CDN];
            const allKeys = await caches.keys();
            await Promise.all(
                allKeys
                    .filter((k) => !validCaches.includes(k))
                    .map((k) => caches.delete(k))
            );
            await self.clients.claim();
        })()
    );
});

// ── MESSAGE ──────────────────────────────────────────────────────────────
self.addEventListener("message", (event) => {
    if (event.data === "skipWaiting") self.skipWaiting();
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

    // ── NAVIGATION (always serve index.html from cache) ────────────────
    if (req.mode === "navigate") {
        event.respondWith(handleNavigation(req));
        return;
    }

    // ── SAME-ORIGIN ASSETS ─────────────────────────────────────────────
    if (url.origin === self.location.origin) {
        if (isOcrFile(url.pathname)) {
            event.respondWith(cacheFirst(req, CACHE_OCR));
            return;
        }
        event.respondWith(staleWhileRevalidate(req, CACHE_CORE));
        return;
    }

    // ── CDN (fonts) — cache-first ──────────────────────────────────────
    if (CDN_PATTERNS.some((p) => url.hostname.includes(p))) {
        event.respondWith(cacheFirst(req, CACHE_CDN));
        return;
    }

    // ── EXTERNAL APIs — network only, no caching ───────────────────────
});

// ── STRATEGIES ───────────────────────────────────────────────────────────

/**
 * Navigation handler with multiple fallbacks.
 * The key to bulletproof offline: always have something to show.
 */
async function handleNavigation(req) {
    const cache = await caches.open(CACHE_CORE);

    // Try to get cached version first (for instant display)
    const cached = await findCachedHtml(cache);

    // Fire background update (don't block the response)
    const fetchPromise = fetchAndUpdate(req, cache, cached);

    // If we have cache, return it immediately
    if (cached) return cached;

    // No cache — must wait for network
    try {
        const networkResp = await fetchPromise;
        if (networkResp && networkResp.ok) return networkResp;
    } catch (e) { /* fall through to offline page */ }

    return offlinePage();
}

/**
 * Find cached HTML using multiple URL patterns.
 * GitHub Pages may cache under different URLs.
 */
async function findCachedHtml(cache) {
    // Try exact paths that GitHub Pages may use
    const candidates = [
        "./index.html",
        "./",
        new URL("./index.html", self.location).href,
        new URL("./", self.location).href,
    ];

    for (const url of candidates) {
        const match = await cache.match(url, { ignoreSearch: true, ignoreVary: true });
        if (match) return match;
    }

    // Last resort: find ANY cached HTML
    const keys = await cache.keys();
    for (const key of keys) {
        const resp = await cache.match(key);
        if (resp && resp.headers.get("content-type")?.includes("text/html")) {
            return resp;
        }
    }

    return null;
}

/**
 * Fetch fresh version and update cache + notify clients.
 */
async function fetchAndUpdate(req, cache, oldCached) {
    try {
        const resp = await fetch(req);
        if (!resp || !resp.ok) return resp;

        // Store under both the request URL and ./index.html
        await cache.put(req, resp.clone()).catch(() => {});
        await cache.put(
            new URL("./index.html", self.location).href,
            resp.clone()
        ).catch(() => {});
        await cache.put(
            new URL("./", self.location).href,
            resp.clone()
        ).catch(() => {});

        // Check if content actually changed
        if (oldCached) {
            const oldLen = oldCached.headers.get("content-length");
            const newLen = resp.headers.get("content-length");
            const oldEtag = oldCached.headers.get("etag");
            const newEtag = resp.headers.get("etag");
            if (
                (oldEtag && newEtag && oldEtag !== newEtag) ||
                (oldLen && newLen && oldLen !== newLen)
            ) {
                const clients = await self.clients.matchAll();
                clients.forEach((c) => {
                    c.postMessage({ type: "UPDATE_AVAILABLE", version: SW_VERSION });
                });
            }
        }

        return resp;
    } catch (e) {
        return null;
    }
}

/**
 * Stale-While-Revalidate for non-navigation requests.
 */
async function staleWhileRevalidate(req, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req, { ignoreSearch: true, ignoreVary: true });

    const fetchPromise = fetch(req)
        .then((resp) => {
            if (resp && resp.ok) {
                cache.put(req, resp.clone()).catch(() => {});
            }
            return resp;
        })
        .catch(() => null);

    if (cached) return cached;

    const networkResp = await fetchPromise;
    if (networkResp) return networkResp;

    return new Response("", { status: 408 });
}

/**
 * Cache-First for large static files (OCR, fonts).
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
<title>FlightBag — Offline</title>
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
