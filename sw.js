// sw.js — FlightBag
// v3.1.0 — Cache-first + IndexedDB backup (survives iOS cache eviction)
// Triple storage: Cache API (fast) → IndexedDB (persistent) → Network (fallback)

const SW_VERSION = "v3.1.0";
const CACHE_CORE = "fb-core-v16";
const CACHE_OCR  = "fb-ocr-v1";
const CACHE_CDN  = "fb-cdn-v3";
const IDB_NAME   = "fb-offline";
const IDB_STORE  = "html";
const IDB_KEY    = "index";

const CORE_FILES = [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./manifest.json",
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

// ══════════════════════════════════════════════════════════════════════════
// IndexedDB helpers — backup storage that survives iOS cache eviction
// ══════════════════════════════════════════════════════════════════════════

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbPut(key, value) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    })).catch(() => {});
}

function idbGet(key) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); resolve(null); };
    })).catch(() => null);
}

// ══════════════════════════════════════════════════════════════════════════
// INSTALL
// ══════════════════════════════════════════════════════════════════════════

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            // 1. Core files → Cache API
            const core = await caches.open(CACHE_CORE);
            try {
                await core.addAll(CORE_FILES);
            } catch (e) {
                await Promise.allSettled(
                    CORE_FILES.map(u =>
                        fetch(u).then(r => r.ok ? core.put(u, r) : null).catch(() => {})
                    )
                );
            }

            // 2. Save index.html to IndexedDB as backup
            try {
                const htmlResp = await core.match("./index.html", { ignoreVary: true });
                if (htmlResp) {
                    const htmlText = await htmlResp.clone().text();
                    await idbPut(IDB_KEY, htmlText);
                }
            } catch (e) {}

            // 3. OCR files (skip if cached)
            const ocr = await caches.open(CACHE_OCR);
            await Promise.allSettled(
                OCR_FILES.map(u =>
                    ocr.match(u, { ignoreVary: true }).then(ex => {
                        if (ex) return;
                        return fetch(u).then(r => r.ok ? ocr.put(u, r) : null);
                    }).catch(() => {})
                )
            );

            // 4. Google Fonts
            try {
                const cdn = await caches.open(CACHE_CDN);
                const cssResp = await fetch(FONT_CSS_URL);
                if (cssResp.ok) {
                    const cssText = await cssResp.clone().text();
                    await cdn.put(FONT_CSS_URL, cssResp);
                    const woff2 = cssText.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g);
                    if (woff2) {
                        await Promise.allSettled(
                            woff2.map(m => {
                                const url = m.slice(4, -1);
                                return cdn.match(url, { ignoreVary: true }).then(ex => {
                                    if (ex) return;
                                    return fetch(url, { mode: "cors" }).then(r =>
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

// ══════════════════════════════════════════════════════════════════════════
// ACTIVATE
// ══════════════════════════════════════════════════════════════════════════

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const valid = new Set([CACHE_CORE, CACHE_OCR, CACHE_CDN]);
            const keys = await caches.keys();
            await Promise.all(keys.filter(k => !valid.has(k)).map(k => caches.delete(k)));
            await self.clients.claim();

            // Verify cache integrity — restore from IDB if Cache API was evicted
            try {
                const core = await caches.open(CACHE_CORE);
                const cached = await core.match("./index.html", { ignoreVary: true });
                if (!cached) {
                    // Cache API was evicted! Restore from IndexedDB
                    const htmlText = await idbGet(IDB_KEY);
                    if (htmlText) {
                        const resp = new Response(htmlText, {
                            headers: { "Content-Type": "text/html;charset=utf-8" }
                        });
                        await core.put("./index.html", resp.clone());
                        await core.put(new URL("./", self.location).href, resp.clone());
                        await core.put(new URL("./index.html", self.location).href, resp);
                    }
                }
            } catch (e) {}
        })()
    );
});

// ══════════════════════════════════════════════════════════════════════════
// MESSAGE
// ══════════════════════════════════════════════════════════════════════════

self.addEventListener("message", (event) => {
    if (event.data === "skipWaiting") self.skipWaiting();
    if (event.data === "clearAll") {
        event.waitUntil(
            (async () => {
                const ks = await caches.keys();
                await Promise.all(ks.map(k => caches.delete(k)));
                // Also clear IDB backup
                try {
                    const db = await idbOpen();
                    const tx = db.transaction(IDB_STORE, "readwrite");
                    tx.objectStore(IDB_STORE).clear();
                    tx.oncomplete = () => db.close();
                } catch (e) {}
            })()
        );
    }
    if (event.data === "getVersion") {
        event.source.postMessage({ type: "version", version: SW_VERSION });
    }
});

// ══════════════════════════════════════════════════════════════════════════
// FETCH
// ══════════════════════════════════════════════════════════════════════════

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);

    // Navigation → cache-first with IDB fallback
    if (req.mode === "navigate") {
        event.respondWith(serveNavigation(event));
        return;
    }

    // Same-origin assets → cache-first
    if (url.origin === self.location.origin) {
        event.respondWith(cacheFirst(req, isOcr(url.pathname) ? CACHE_OCR : CACHE_CORE));
        return;
    }

    // CDN (fonts) → cache-first
    if (CDN_PATTERNS.some(p => url.hostname.includes(p))) {
        event.respondWith(cacheFirst(req, CACHE_CDN));
        return;
    }

    // External APIs → pass through
});

// ══════════════════════════════════════════════════════════════════════════
// STRATEGIES
// ══════════════════════════════════════════════════════════════════════════

/**
 * Navigation: Triple fallback — Cache API → IndexedDB → Network → Offline page
 */
async function serveNavigation(event) {
    const cache = await caches.open(CACHE_CORE);

    // 1) Try Cache API (fastest)
    const cached = await matchHtml(cache);
    if (cached) {
        scheduleBackgroundUpdate(event.request, cache);
        return cached;
    }

    // 2) Cache API was evicted — try IndexedDB backup
    try {
        const htmlText = await idbGet(IDB_KEY);
        if (htmlText) {
            // Restore to Cache API for next time
            const resp = new Response(htmlText, {
                headers: { "Content-Type": "text/html;charset=utf-8" }
            });
            await storeHtml(cache, resp.clone());
            scheduleBackgroundUpdate(event.request, cache);
            return resp;
        }
    } catch (e) {}

    // 3) Nothing cached — must use network (first visit)
    try {
        const resp = await fetch(event.request);
        if (resp && resp.ok) {
            await storeHtml(cache, resp.clone());
            // Also backup to IndexedDB
            try {
                const text = await resp.clone().text();
                await idbPut(IDB_KEY, text);
            } catch (e) {}
            return resp;
        }
    } catch (e) {}

    // 4) Total failure
    return offlinePage();
}

/**
 * Match cached HTML under multiple URL patterns.
 */
async function matchHtml(cache) {
    const opts = { ignoreSearch: true, ignoreVary: true };
    const urls = [
        "./index.html",
        "./",
        new URL("./index.html", self.location).href,
        new URL("./", self.location).href,
    ];
    for (const u of urls) {
        const m = await cache.match(u, opts);
        if (m) return m;
    }
    return null;
}

/**
 * Store HTML under all URL patterns.
 */
async function storeHtml(cache, resp) {
    await Promise.all([
        cache.put("./index.html", resp.clone()).catch(() => {}),
        cache.put("./", resp.clone()).catch(() => {}),
        cache.put(new URL("./index.html", self.location).href, resp.clone()).catch(() => {}),
        cache.put(new URL("./", self.location).href, resp.clone()).catch(() => {}),
    ]);
}

/**
 * Background update — fetch new HTML, update cache + IDB, notify if changed.
 */
function scheduleBackgroundUpdate(req, cache) {
    setTimeout(async () => {
        try {
            const resp = await fetch(req);
            if (!resp || !resp.ok) return;

            // Check if content changed before updating
            const oldCached = await matchHtml(cache);
            const changed = oldCached && (
                (oldCached.headers.get("etag") || "") !== (resp.headers.get("etag") || "") ||
                (oldCached.headers.get("content-length") || "") !== (resp.headers.get("content-length") || "")
            );

            // Update Cache API
            await storeHtml(cache, resp.clone());
            await cache.put(req, resp.clone()).catch(() => {});

            // Update IndexedDB backup
            try {
                const text = await resp.clone().text();
                await idbPut(IDB_KEY, text);
            } catch (e) {}

            // Notify clients if content changed
            if (changed) {
                const clients = await self.clients.matchAll();
                clients.forEach(c =>
                    c.postMessage({ type: "UPDATE_AVAILABLE", version: SW_VERSION })
                );
            }
        } catch (e) {
            // Offline — silent
        }
    }, 200);
}

/**
 * Cache-First for all assets.
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

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

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
