// Writehaven's offline app shell. The writer's page registers it as /sw.js?v=<build>,
// the same build id every asset URL carries, so each deploy installs a fresh copy.
//   - Pages (navigations): network first; when offline, the cached page, so the
//     editor opens and its queue (IndexedDB) restores.
//   - Versioned assets (?v=<build>) and fonts: cache first; their URLs change when they do.
//   - Other scripts and styles: network first, the cached copy only when offline.
//   - /api/* and anything on another origin: never touched, never cached.
const V = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `wh-shell-${V}`;
// Every module is requested with the build version (the server adds ?v=<build> to import
// specifiers), so the shell caches those exact URLs.
const v = (u) => `${u}?v=${V}`;
// Push notifications (SPEC §22): their handlers live in sw-push.js, this build's copy. If it
// can't load, the offline shell must still install: the page then finds no push handler
// (it asks with wh-push-ping) and doesn't subscribe this device.
try {
  importScripts(v('/sw-push.js'));
} catch (e) { /* no pushes from this worker */ }
const SHELL = [
  v('/css/app.css'), v('/css/print.css'), v('/js/boot.js'), v('/js/preload.js'), v('/js/app.js'),
  '/fonts/fonts.css', '/favicon.svg',
  '/fonts/Newsreader-normal-latin.woff2', '/fonts/Newsreader-italic-latin.woff2', '/fonts/InstrumentSans-normal-latin.woff2',
  ...['ui', 'net', 'write', 'sync', 'editor', 'paste', 'text', 'interop', 'footnotes', 'brainstorm'].map((m) => v(`/js/${m}.js`)),
  v('/vendor/cm.js'), v('/vendor/interop.js'),
];
// Every other module the writer's page can load, cached when present (they ship separately;
// a missing one doesn't stop the install), so tools and forms work when it opens offline.
const OPTIONAL = ['help', 'richtext', 'images', 'image-worker', 'install', 'food', 'account', 'names', 'notify', 'update'].map((m) => v(`/js/${m}.js`));
const KEEP_BUILDS = 3; // earlier builds' caches stay a while: an open page of an earlier build can still load its own modules
const PAGE_TIMEOUT_MS = 8000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // The page must be this very build; if a newer deploy is already out, its own worker installs instead.
    const res = await fetch('/index.html', { cache: 'reload' });
    const html = await res.clone().text();
    if (!res.ok || !html.includes(`app.js?v=${V}`)) throw new Error('Writehaven: build changed during install');
    await cache.put('/index.html', res);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await Promise.all(OPTIONAL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Caches are listed oldest first; the newest few stay (pages of those builds may still be open).
    const shells = (await caches.keys()).filter((k) => k.startsWith('wh-shell-') && k !== CACHE);
    for (const k of shells.slice(0, Math.max(0, shells.length - (KEEP_BUILDS - 1)))) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable().catch(() => {});
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/sw.js' || p === '/healthz') return;
  if (req.mode === 'navigate') {
    event.respondWith(page(event));
    return;
  }
  if (url.searchParams.has('v') || p.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(req, url));
    return;
  }
  if (/\.(js|css|svg|woff2)$/.test(p)) event.respondWith(networkFirst(req));
});

async function fromCache(key) {
  const cache = await caches.open(CACHE);
  return cache.match(key);
}
// A versioned URL names one build's file: any build's cache that has it will do.
async function fromAnyCache(req) {
  return (await fromCache(req)) || caches.match(req);
}

async function page(event) {
  const net = fetch(event.request);
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PAGE_TIMEOUT_MS); });
  try {
    const res = await Promise.race([net, slow]);
    if (res) return res;
  } catch { /* offline */ } finally {
    clearTimeout(timer);
  }
  const cached = await fromCache('/index.html');
  return cached || net;
}

async function cacheFirst(req, url) {
  const hit = await fromAnyCache(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && (url.searchParams.get('v') === V || url.pathname.startsWith('/fonts/'))) {
    const cache = await caches.open(CACHE);
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}

async function networkFirst(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const hit = await fromCache(req);
    if (hit) return hit;
    throw err;
  }
}
