// The installable app's service worker (public/terminal/sw.js): keeps the interface only, never /api data;
// network first; a sign-in redirect passes through and is never cached; offline → the cached interface.
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };

const ORIGIN = "https://alessandrozanichelli.com";
const stores = new Map(), listeners = {};
const keyOf = (k) => (typeof k === "string" ? new URL(k, ORIGIN + "/terminal/sw.js").href : k.url);
const caches = {
  async open(name) { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name);
    return { async put(k, r) { m.set(keyOf(k), r); }, async match(k) { return m.get(keyOf(k)) || undefined; } }; },
  async keys() { return [...stores.keys()]; }, async delete(n) { return stores.delete(n); },
};
let net = async () => { throw new TypeError("offline"); };
const resp = (body, { status = 200, type = "basic", redirected = false } = {}) => ({ ok: status >= 200 && status < 300, status, type, redirected, body, clone() { return resp(body, { status, type, redirected }); } });
const ctx = { self: { location: new URL(ORIGIN + "/terminal/sw.js"), addEventListener: (t, f) => (listeners[t] = f), skipWaiting: () => null, clients: { claim: () => null } },
  caches, fetch: (...a) => net(...a), URL, Promise, setTimeout, module: { exports: {} } };
ctx.module.exports = {}; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync("public/terminal/sw.js", "utf8"), ctx);
const SW = ctx.module.exports;

// the fetch handler: what it answers, or that it let the request go to the network untouched
const dispatch = async (url, { method = "GET", mode = "cors" } = {}) => {
  let answered = null; const ev = { request: { url, method, mode }, respondWith: (p) => (answered = p) };
  listeners.fetch(ev); return answered ? await answered : "passthrough";
};

ok("scope: /terminal/ files only; /api/*, the worker itself and other origins are left alone",
  SW.isShell(new URL(ORIGIN + "/terminal/desk/")) && SW.isShell(new URL(ORIGIN + "/terminal/i18n.js")) && !SW.isShell(new URL(ORIGIN + "/terminal/")) && !SW.isShell(new URL(ORIGIN + "/terminal/replay/")) && !SW.isShell(new URL(ORIGIN + "/api/quote?symbols=NVDA")) && !SW.isShell(new URL(ORIGIN + "/terminal/sw.js")) && !SW.isShell(new URL("https://quote.cnbc.com/terminal/x")));
ok("the cached interface contains no /api path", SW.SHELL.every((u) => u.startsWith("/terminal/") && !u.includes("/api/")));

net = async () => resp("live data");
ok("/api requests never go through the worker (no cache, no answer from it)", (await dispatch(ORIGIN + "/api/quote?symbols=NVDA")) === "passthrough" && (await dispatch(ORIGIN + "/api/energy/stocks")) === "passthrough");
ok("POST is never handled", (await dispatch(ORIGIN + "/terminal/desk/", { method: "POST" })) === "passthrough");

// first visit online: the page comes from the network and is kept
net = async () => resp("<html>v1</html>");
let r = await dispatch(ORIGIN + "/terminal/desk/?x=1", { mode: "navigate" });
await new Promise((res) => setTimeout(res, 5));
const kept = await (await caches.open(SW.VERSION)).match("/terminal/desk/");
ok("online: the page from the network, kept as the one copy of the interface (query string ignored)", r.body === "<html>v1</html>" && kept && kept.body === "<html>v1</html>");

// a newer page on the server wins
net = async () => resp("<html>v2</html>");
r = await dispatch(ORIGIN + "/terminal/desk/", { mode: "navigate" });
await new Promise((res) => setTimeout(res, 5));
ok("online again: the newer page wins and replaces the copy", r.body === "<html>v2</html>" && (await (await caches.open(SW.VERSION)).match("/terminal/desk/")).body === "<html>v2</html>");

// Access session expired: the redirect to the sign-in is passed to the browser and never cached
net = async () => resp(null, { status: 0, type: "opaqueredirect" });
r = await dispatch(ORIGIN + "/terminal/desk/", { mode: "navigate" });
await new Promise((res) => setTimeout(res, 5));
ok("signed out: the redirect to the Access sign-in goes through; the cached page is not replaced by it", r.type === "opaqueredirect" && (await (await caches.open(SW.VERSION)).match("/terminal/desk/")).body === "<html>v2</html>");
ok("a redirect, an error page or a cross-origin answer is never cached", !SW.cacheable(resp("x", { redirected: true })) && !SW.cacheable(resp("x", { status: 500 })) && !SW.cacheable(resp("x", { type: "opaque" })) && SW.cacheable(resp("x")));

// no network: the interface still opens (data then N/A in the page)
net = async () => { throw new TypeError("offline"); };
r = await dispatch(ORIGIN + "/terminal/desk/", { mode: "navigate" });
ok("offline: the kept interface opens", r.body === "<html>v2</html>");

// a network slower than the timeout: the kept interface, the network copy still stored when it arrives
net = () => new Promise((res) => setTimeout(() => res(resp("<html>v3</html>")), 3800));
const t0 = Date.now(); r = await dispatch(ORIGIN + "/terminal/desk/", { mode: "navigate" });
ok("slow network (> 3.5 s): the kept interface without waiting longer", r.body === "<html>v2</html>" && Date.now() - t0 < 3700, String(Date.now() - t0));
await new Promise((res) => setTimeout(res, 400));
ok("…and the newer page is stored for the next launch", (await (await caches.open(SW.VERSION)).match("/terminal/desk/")).body === "<html>v3</html>");

// nothing kept yet and no network: the error reaches the browser (nothing invented)
stores.clear(); net = async () => { throw new TypeError("offline"); };
let threw = false; try { await dispatch(ORIGIN + "/terminal/i18n.js"); } catch { threw = true; }
ok("first launch offline with nothing kept: the browser's own error, nothing made up", threw);

// activation removes the caches of older versions
stores.set("shell-v0", new Map()); stores.set(SW.VERSION, new Map());
let waited = null; listeners.activate({ waitUntil: (p) => (waited = p) }); await waited;
ok("activate: older interface caches are deleted", !stores.has("shell-v0") && stores.has(SW.VERSION));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
