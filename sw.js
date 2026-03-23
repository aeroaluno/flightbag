// sw.js — FlightBag
// v3.0.0 — Cache-first navigation (matching Angular NGSW "performance" mode)
// Key: ALWAYS serve index.html from cache, update in background on idle

const SW_VERSION = "v3.0.0";
const CACHE_CORE = "fb-core-v16";
const CACHE_OCR  = "fb-ocr-v1";
const CACHE_CDN  = "fb-cdn-v3";

const CORE_FILES = [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./icon-180.png",
];

const OCR_FILES = [
    "./tesseract.min.js",
    "./worker.min.js",
    "./tesseract-core.wasm.js",
    "./eng.traineddata.gz",
];

const FONT_CSS_URL = "https://fonts.googleapis.com/css2?family=B612:ital,wght@0,400;0,700;1,400;1,700&family=B612+Mono:wght@400;700&display=swap";

const CDN_PATTERNS = ["fonts.googleapis.com", "fonts.gstatic.com"];

// ── INSTALL ──────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            // Core files — must succeed
            const core = await caches.open(CACHE_CORE);
            try {
                await core.addAll(CORE_FILES);
            } catch (e) {
                // Individual fallback
                await Promise.allSettled(
                    CORE_FILES.map((u) =>
                        fetch(u).then((r) => r.ok ? core.put(u, r) : null).catch(() => {})
                    )
                );
            }

            // OCR files — skip if already cached (large files)
            const ocr = await caches.open(CACHE_OCR);
            await Promise.allSettled(
                OCR_FILES.map((u) =>
                    ocr.match(u, { ignoreVary: true }).then((ex) => {
                        if (ex) return;
                        return fetch(u).then((r) => r.ok ? ocr.put(u, r) : null);
                    }).catch(() => {})
                )
            );

            // Google Fonts — prefetch CSS + WOFF2
            try {
                const cdn = await caches.open(CACHE_CDN);
                const cssResp = await fetch(FONT_CSS_URL);
                if (cssResp.ok) {
                    const cssText = await cssResp.clone().text();
                    await cdn.put(FONT_CSS_URL, cssResp);
                    const woff2 = cssText.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g);
                    if (woff2) {
                        await Promise.allSettled(
                            woff2.map((m) => {
                                const url = m.slice(4, -1);
                                return cdn.match(url, { ignoreVary: true }).then((ex) => {
                                    if (ex) return;
                                    return fetch(url, { mode: "cors" }).then((r) =>
                                        r.ok ? cdn.put(url, r) : null
                                    );
                                });
                            })
                        );
                    }
                }
            } catch (e) {}

            self.skipWaiting();
        })()
    );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            // Delete ALL caches that don't match current version
            const valid = new Set([CACHE_CORE, CACHE_OCR, CACHE_CDN]);
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => !valid.has(k)).map((k) => caches.delete(k)));
            // Take control immediately
            await self.clients.claim();
        })()
    );
});

// ── MESSAGE ──────────────────────────────────────────────────────────────
self.addEventListener("message", (event) => {
    if (event.data === "skipWaiting") self.skipWaiting();
    if (event.data === "clearAll") {
        event.waitUntil(
            caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
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

    // ── NAVIGATION ─────────────────────────────────────────────────────
    // CACHE-FIRST (like Angular NGSW "performance" mode):
    // Always return cached index.html instantly. Update in background.
    if (req.mode === "navigate") {
        event.respondWith(serveNavigation(event));
        return;
    }

    // ── SAME-ORIGIN ────────────────────────────────────────────────────
    if (url.origin === self.location.origin) {
        if (isOcr(url.pathname)) {
            event.respondWith(cacheFirst(req, CACHE_OCR));
        } else {
            event.respondWith(cacheFirst(req, CACHE_CORE));
        }
        return;
    }

    // ── CDN (fonts) ────────────────────────────────────────────────────
    if (CDN_PATTERNS.some((p) => url.hostname.includes(p))) {
        event.respondWith(cacheFirst(req, CACHE_CDN));
        return;
    }

    // ── EXTERNAL APIs — pass through (no caching) ──────────────────────
});

// ══════════════════════════════════════════════════════════════════════════
// STRATEGIES
// ══════════════════════════════════════════════════════════════════════════

/**
 * Navigation: pure cache-first, background update.
 * This is the #1 reason the reference app works offline perfectly.
 */
async function serveNavigation(event) {
    const cache = await caches.open(CACHE_CORE);

    // 1) Try cache — multiple URL patterns (GitHub Pages quirk)
    const cached = await matchHtml(cache);

    // 2) Schedule background update (non-blocking, like NGSW idle scheduler)
    scheduleBackgroundUpdate(event.request, cache, cached);

    // 3) If cached, return immediately — DONE
    if (cached) return cached;

    // 4) No cache — first visit, must use network
    try {
        const resp = await fetch(event.request);
        if (resp && resp.ok) {
            await storeHtml(cache, resp.clone());
            return resp;
        }
    } catch (e) {}

    // 5) Total failure — show offline page
    return offlinePage();
}

/**
 * Try to find cached HTML under any URL variant.
 * Safari/iOS can request the page under different URLs.
 */
async function matchHtml(cache) {
    const opts = { ignoreSearch: true, ignoreVary: true };
    const urls = [
        new URL("./index.html", self.location).href,
        new URL("./", self.location).href,
        "./index.html",
        "./",
    ];
    for (const u of urls) {
        const m = await cache.match(u, opts);
        if (m) return m;
    }
    return null;
}

/**
 * Store HTML under all URL patterns for maximum cache-hit rate.
 */
async function storeHtml(cache, resp) {
    const urls = [
        new URL("./index.html", self.location).href,
        new URL("./", self.location).href,
    ];
    for (const u of urls) {
        await cache.put(u, resp.clone()).catch(() => {});
    }
}

/**
 * Background update — fetch fresh index.html and notify if changed.
 * Like NGSW's idle.schedule("check-updates-on-navigation").
 */
function scheduleBackgroundUpdate(req, cache, oldCached) {
    // Use setTimeout to avoid blocking the response
    setTimeout(async () => {
        try {
            const resp = await fetch(req);
            if (!resp || !resp.ok) return;

            await storeHtml(cache, resp.clone());
            // Also store under the request URL itself
            await cache.put(req, resp.clone()).catch(() => {});

            // Detect changes and notify
            if (oldCached) {
                const changed =
                    (oldCached.headers.get("etag") || "") !== (resp.headers.get("etag") || "") ||
                    (oldCached.headers.get("content-length") || "") !== (resp.headers.get("content-length") || "");
                if (changed) {
                    const clients = await self.clients.matchAll();
                    clients.forEach((c) =>
                        c.postMessage({ type: "UPDATE_AVAILABLE", version: SW_VERSION })
                    );
                }
            }
        } catch (e) {
            // Offline — silently ignore
        }
    }, 100);
}

/**
 * Cache-First: return cache if available, else fetch + cache.
 * Used for ALL same-origin assets (not just OCR/fonts).
 * This matches NGSW's "prefetch" installMode behavior.
 */
async function cacheFirst(req, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (cached) return cached;
    try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
            await cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
    } catch (e) {
        return new Response("", { status: 408 });
    }
}

// ── HELPERS ──────────────────────────────────────────────────────────────

function isOcr(p) {
    return p.includes("tesseract") || p.includes("worker.min.js") || p.includes("traineddata");
}

function offlinePage() {
    return new Response(
        `<!DOCTYPE html><html lang="pt"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>FlightBag — Offline</title>
<style>
body{margin:0;font-family:'B612',system-ui,sans-serif;background:#040506;color:#dce4ed;
     display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
.b{padding:32px;max-width:340px;}
.i{font-size:48px;margin-bottom:16px;}
h2{font-size:17px;margin:0 0 8px;color:#fff;}
p{color:#8494a7;font-size:13px;line-height:1.6;margin:0 0 4px;}
button{margin-top:20px;padding:12px 24px;border:none;border-radius:10px;
       background:#38bdf8;color:#040506;font-size:14px;font-weight:700;cursor:pointer;width:100%;}
</style></head>
<body><div class="b">
<div class="i">&#9992;</div>
<h2>FlightBag — Offline</h2>
<p>Carregue o app uma vez com internet.</p>
<p>Depois feche e abra novamente.</p>
<button onclick="location.reload()">Tentar novamente</button>
</div></body></html>`,
        { headers: { "Content-Type": "text/html;charset=utf-8" } }
    );
}
