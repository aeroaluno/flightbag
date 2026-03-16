// sw.js — FlightBag
// v1.10.35 — iOS offline: skipWaiting dentro do waitUntil, recupera cache antigo,
//             múltiplos fallbacks de URL, ignoreVary no match
const CACHE_NAME = "flightbag-cache-v1.10.35";

const CORE = [
    "./",
    "./index.html",
    "./sw.js",
    "./manifest.json",
    "./icon-180.png",
];

const OCR_FILES = [
    "./tesseract.min.js",
    "./worker.min.js",
    "./tesseract-core.wasm.js",
    "./eng.traineddata.gz",
];

// ── INSTALL ────────────────────────────────────────────────────────────────
// skipWaiting() DENTRO do waitUntil() — garante que o SW ativo imediatamente
// Se a rede falhar (offline no momento do install), copia do cache antigo
self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);

            // Tenta cachear pela rede
            let networkOk = false;
            try {
                await cache.addAll(CORE);
                networkOk = true;
                // OCR files: best-effort
                await Promise.allSettled(
                    OCR_FILES.map((url) =>
                        cache.add(url).catch(() => {})
                    )
                );
            } catch (e) {
                // Rede indisponível durante install (ex: offline)
                // Copia tudo dos caches anteriores como fallback
                const oldKeys = await caches.keys();
                for (const oldName of oldKeys) {
                    if (oldName === CACHE_NAME) continue;
                    try {
                        const oldCache = await caches.open(oldName);
                        const requests = await oldCache.keys();
                        for (const req of requests) {
                            const resp = await oldCache.match(req);
                            if (resp) {
                                await cache.put(req, resp).catch(() => {});
                            }
                        }
                    } catch (e2) {}
                }
            }

            // skipWaiting aqui dentro = SW ativa imediatamente, sem esperar tabs fecharem
            await self.skipWaiting();
        })()
    );
});

// ── ACTIVATE ───────────────────────────────────────────────────────────────
// clients.claim() = assume controle de todas as tabs abertas imediatamente
// Só apaga caches antigos DEPOIS de verificar que o novo tem o conteúdo principal
self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            // Verifica se o cache novo tem index.html
            const cache = await caches.open(CACHE_NAME);
            const hasIndex = await cache.match("./index.html");

            if (!hasIndex) {
                // Cache novo vazio — copia de caches antigos antes de deletar
                const oldKeys = await caches.keys();
                for (const oldName of oldKeys) {
                    if (oldName === CACHE_NAME) continue;
                    try {
                        const oldCache = await caches.open(oldName);
                        const requests = await oldCache.keys();
                        for (const req of requests) {
                            const resp = await oldCache.match(req);
                            if (resp) await cache.put(req, resp).catch(() => {});
                        }
                    } catch (e) {}
                }
            }

            // Agora apaga os caches antigos
            const allKeys = await caches.keys();
            await Promise.all(
                allKeys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            );

            await self.clients.claim();
        })()
    );
});

// ── FETCH ──────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
    const req = event.request;

    // Ignora requisições non-GET
    if (req.method !== "GET") return;

    // Ignora cross-origin (analytics, CDN externo, etc.)
    if (!req.url.startsWith(self.location.origin)) return;

    // NAVEGAÇÃO: cache-first com múltiplos fallbacks de URL
    if (req.mode === "navigate") {
        event.respondWith(handleNavigation(req));
        return;
    }

    // OCR engine: cache-first estrito (arquivos grandes)
    if (
        req.url.includes("tesseract") ||
        req.url.includes("worker.min.js") ||
        req.url.includes("traineddata")
    ) {
        event.respondWith(cacheFirst(req));
        return;
    }

    // Demais assets: cache-first com fallback de rede
    event.respondWith(cacheFirst(req));
});

async function handleNavigation(req) {
    const cache = await caches.open(CACHE_NAME);

    // Tentativas em ordem: URL exata → sem query → index.html → raiz → qualquer cache
    const opts = { ignoreSearch: true, ignoreVary: true };
    const candidates = [
        () => cache.match(req, opts),
        () => cache.match(new URL("./index.html", self.location).href, opts),
        () => cache.match(new URL("./", self.location).href, opts),
        () => cache.match("./index.html", opts),
        () => cache.match("./", opts),
        () => caches.match(req, opts),
        () => caches.match("./index.html", opts),
    ];

    for (const fn of candidates) {
        try {
            const cached = await fn();
            if (cached) {
                // Atualiza em background (stale-while-revalidate)
                refreshInBackground(req, cache);
                return cached;
            }
        } catch (e) {}
    }

    // Nada no cache — tenta rede
    try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
            // Guarda com múltiplas chaves para cobrir todas as variantes de URL
            await Promise.allSettled([
                cache.put(req, resp.clone()),
                cache.put(new URL("./index.html", self.location).href, resp.clone()),
                cache.put(new URL("./", self.location).href, resp.clone()),
            ]);
        }
        return resp;
    } catch (e) {
        return offlinePage();
    }
}

async function cacheFirst(req) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (cached) {
        refreshInBackground(req, cache);
        return cached;
    }
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

function refreshInBackground(req, cache) {
    fetch(req).then((resp) => {
        if (resp && resp.ok) {
            cache.put(req, resp.clone()).catch(() => {});
            // Para navegação, também actualiza index.html
            if (req.mode === "navigate") {
                cache.put(new URL("./index.html", self.location).href, resp.clone()).catch(() => {});
            }
        }
    }).catch(() => {});
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
