// Alessandro Terminal — service worker of the installable app (iPhone home screen).
// It keeps only the interface (this page, its scripts, the chart library, icons) so the app opens without a network
// or on a slow one. It never touches /api/*: market data is always fetched live, and without a network the
// terminal shows N/A, never an old value as if it were current.
// Network first: the interface on the server wins whenever it answers within SHELL_TIMEOUT_MS. A redirect (the
// Cloudflare Access sign-in when the session has expired) is passed through and never cached.
const VERSION = "shell-v3";
const SHELL_TIMEOUT_MS = 3500;
const SHELL = ["/terminal/", "/terminal/i18n.js", "/terminal/provenance.js", "/terminal/qmath.js", "/terminal/vendor/lightweight-charts.js", "/terminal/manifest.webmanifest", "/terminal/app/icon-180.png", "/terminal/app/icon-192.png"];

const isShell = (url) => url.origin === self.location.origin && url.pathname.startsWith("/terminal/") && !url.pathname.startsWith("/terminal/sw.js");
const cacheable = (r) => !!(r && r.ok && r.type === "basic" && !r.redirected);

self.addEventListener("install", (event) => {
  // best effort: a file that cannot be fetched now (e.g. signed out) is cached the next time it is loaded
  event.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => fetch(u, { credentials: "same-origin", redirect: "manual" }).then((r) => (cacheable(r) ? c.put(u, r) : null)).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// the network, or after SHELL_TIMEOUT_MS / on failure the cached copy (when there is one)
async function networkFirst(request, key) {
  const cache = await caches.open(VERSION);
  const net = fetch(request).then((r) => { if (cacheable(r)) cache.put(key, r.clone()); return r; });
  net.catch(() => null); // a failure after the cached copy was served is not an error
  const cached = await cache.match(key);
  if (!cached) return net;
  const timeout = new Promise((res) => setTimeout(() => res(null), SHELL_TIMEOUT_MS));
  try { const r = await Promise.race([net, timeout]); return r || cached; } catch { return cached; }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!isShell(url)) return; // /api/* and every other origin: straight to the network, never cached
  // a navigation is keyed on the page itself (query strings ignored): one copy of the interface
  const key = req.mode === "navigate" ? "/terminal/" : url.origin + url.pathname;
  event.respondWith(networkFirst(req, key));
});

// tests (Node) import the decision functions; in the browser `module` is undefined
if (typeof module !== "undefined") module.exports = { isShell, cacheable, networkFirst, SHELL, VERSION };
