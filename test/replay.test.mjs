// The public replay (src/replay.mjs): which routes may be recorded, what is filtered out of them, how a recording is
// made (owner only, the Worker re-reads every route itself) and what the public paths serve. KV, the static assets and
// the Worker's router are stand-ins here (test fixtures, never shipped).
//   node test/replay.test.mjs
import { recordable, sanitizeRecorded, injectReplay, handleRecording, handleReplayPublic, REPLAY_ROUTES, REC_KEYS, NOT_PUBLIC_CURVES } from "../src/replay.mjs";
import worker from "../src/worker.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const json = (b, H, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { ...H, "content-type": "application/json" } });

// ---------- routes ----------
ok("recordable: the official routes only, with their query", recordable("/api/cb/world") === "/api/cb/world" && recordable("/api/yields?ids=US,DE") === "/api/yields?ids=US,DE" && recordable("/api/cot") === "/api/cot" && recordable("/api/calendar") === "/api/calendar");
ok("not recordable: market data, quotes, the owner's own data, other sites, odd paths", ["/api/quote?symbols=AAPL", "/api/yields/market", "/api/history?symbol=SPY", "/api/portfolio", "/api/user/plab", "/api/alerts", "/api/status", "/api/nasdaq/movers", "/api/cnbc/implied", "/api/news", "https://evil.example/api/cot", "//evil.example/api/cot", "/terminal/", "", null].every((p) => recordable(p) === null));
ok("not recordable: the history of a curve kept private (CN, PT, NZ, MY)", recordable("/api/yields/history?id=PT&tenor=10Y") === null && recordable("/api/yields/history?id=pt&tenor=10Y") === null && recordable("/api/yields/history?id=US&tenor=10Y") === "/api/yields/history?id=US&tenor=10Y");
ok("the allow-list is the documented one", Object.keys(REPLAY_ROUTES).sort().join() === "/api/bonds,/api/calendar,/api/cb,/api/cb/history,/api/cb/world,/api/cot,/api/sprd,/api/yields,/api/yields/catalog,/api/yields/history");

// ---------- filters ----------
const Y = { curves: { US: { id: "US", spreads: { DE: { bp: 1 }, PT: { bp: 2 } } }, PT: { id: "PT" }, CN: { id: "CN" }, DE: { id: "DE" } }, errors: { NZ: "x", UK: "y" }, catalog: [{ id: "US" }, { id: "MY" }, { id: "DE" }] };
const y = sanitizeRecorded("/api/yields", Y);
ok("yields: the curves of Portugal, China, New Zealand and Malaysia left out, also as spread partners, errors and catalog", Object.keys(y.curves).join() === "US,DE" && Object.keys(y.curves.US.spreads).join() === "DE" && Object.keys(y.errors).join() === "UK" && y.catalog.map((c) => c.id).join() === "US,DE");
ok("filters do not change what they were given", Object.keys(Y.curves).length === 4 && Y.catalog.length === 3);
const B = { countries: [{ id: "US" }, { id: "NZ" }], spreads: [{ id: "IT" }, { id: "PT" }], fred: { groups: [{ group: "Inflation", rows: [{ id: "DFII10" }] }, { group: "Credit", rows: [{ id: "BAMLC0A0CM" }, { id: "BAMLH0A0HYM2" }] }, { group: "Money and mortgages", rows: [{ id: "SOFR" }, { id: "MORTGAGE30US" }] }] } };
const bd = sanitizeRecorded("/api/bonds", B);
ok("bonds: no ICE BofA index, no mortgage survey (an empty group goes), no private curve", bd.countries.map((c) => c.id).join() === "US" && bd.spreads.map((s) => s.id).join() === "IT" && bd.fred.groups.map((g) => g.group).join() === "Inflation,Money and mortgages" && bd.fred.groups[1].rows.map((r) => r.id).join() === "SOFR");
const C = { world: [{ title: "CPI", source: "FF" }], events: [{ source: "BLS" }, { source: "BEA" }, { source: "NQ" }], sources: [{ id: "FF" }, { id: "BLS" }, { id: "BEA" }], errors: { FF: "x", BLS: "y" }, worldBackup: { kind: "nasdaq" }, fields: { forecast: "Forex Factory" } };
const cl = sanitizeRecorded("/api/calendar", C);
ok("calendar: the BLS and BEA schedules only — no Forex Factory or Nasdaq event, source or wording", cl.world.length === 0 && cl.events.map((e) => e.source).join() === "BLS,BEA" && cl.sources.map((s) => s.id).join() === "BLS,BEA" && Object.keys(cl.errors).join() === "BLS" && cl.worldBackup === null && !/Forex|Nasdaq/.test(JSON.stringify(cl)));
ok("central banks: the note no longer points to a commercial calendar", !/Forex/.test(sanitizeRecorded("/api/cb", { banks: [], note: "Meetings: see the calendar (Forex Factory)." }).note));
ok("sanitizeRecorded refuses a route not on the list", sanitizeRecorded("/api/quote?symbols=AAPL", { a: 1 }) === null);
ok("the private curves are named", [...NOT_PUBLIC_CURVES].sort().join() === "CN,MY,NZ,PT");

// ---------- the page ----------
const page = "<!doctype html>\n<html><head>\n<meta charset=\"utf-8\"><title>t</title></head><body><script>boot()</script></body></html>";
const inj = injectReplay(page, { t0: "2026-10-22T16:40:00.000Z", at: "2026-10-22T16:41:00.000Z", n: 9, bytes: 1, paths: ["/api/cot"] });
ok("the page: the recording's summary and the player before every other script", inj.indexOf("window.AZ_REC=") < inj.indexOf("/terminal/replay/player.js") && inj.indexOf("/terminal/replay/player.js") < inj.indexOf("<meta charset") && /"n":9/.test(inj) && !/paths/.test(inj));
ok("the page: no recording → AZ_REC null; a '<' in the summary cannot close the script", /AZ_REC=null/.test(injectReplay(page, null)) && !/<\/script><script>alert/.test(injectReplay(page, { t0: "</script><script>alert(1)", at: "x", n: 1 })));

// ---------- making a recording (owner) ----------
const kv = new Map(), puts = [];
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", BRIEFS: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v, o) => { kv.set(k, v); puts.push([k, o]); } } };
const ORIGIN = "https://alessandrozanichelli.com";
const asked = [];
const appFetch = async (req) => { const u = new URL(req.url); asked.push(u.pathname + u.search);
  if (u.pathname === "/api/cot") return json({ contracts: [{ name: "E-mini S&P 500" }], source: "U.S. Commodity Futures Trading Commission", status: "LIVE" }, {});
  if (u.pathname === "/api/yields") return json(Y, {});
  if (u.pathname === "/api/calendar") return json(C, {});
  return json({ error: "not found" }, {}, 404); };
const post = (path, body, headers = {}) => handleRecording(new URL(ORIGIN + path), env, {}, {}, json, new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) }), appFetch);
const get = (path) => handleRecording(new URL(ORIGIN + path), env, {}, {}, json, new Request(ORIGIN + path), appFetch);

let r = await (await get("/api/user/recording")).json();
ok("summary before any recording: none, and the routes a recording may hold", r.meta === null && r.routes.includes("/api/cot") && !r.routes.includes("/api/quote"));
r = await (await post("/api/user/recording/take", { rid: "abc123xy", i: 0, path: "/api/cot" })).json();
ok("take: the Worker re-reads the route itself and keeps it a day", r.ok === true && r.path === "/api/cot" && kv.has(REC_KEYS.part("abc123xy", 0)) && puts.find(([k]) => k === REC_KEYS.part("abc123xy", 0))[1].expirationTtl === 86400 && asked.join() === "/api/cot");
r = await (await post("/api/user/recording/take", { rid: "abc123xy", i: 1, path: "/api/yields" })).json();
const part1 = JSON.parse(kv.get(REC_KEYS.part("abc123xy", 1)));
ok("take: kept filtered", r.ok && !part1.b.curves.PT && part1.b.curves.US);
r = await (await post("/api/user/recording/take", { rid: "abc123xy", i: 2, path: "/api/quote?symbols=AAPL" })).json();
ok("take: a route not on the list is skipped and never read", r.skipped === "not_official" && !asked.includes("/api/quote?symbols=AAPL") && !kv.has(REC_KEYS.part("abc123xy", 2)));
r = await (await post("/api/user/recording/take", { rid: "abc123xy", i: 2, path: "/api/cb/history?ids=US" })).json();
ok("take: a route that answers nothing usable is skipped", r.skipped === "no_data" && !kv.has(REC_KEYS.part("abc123xy", 2)));
const bad = await Promise.all([post("/api/user/recording/take", { rid: "x", i: 0, path: "/api/cot" }), post("/api/user/recording/take", { rid: "abc123xy", i: 99, path: "/api/cot" }), post("/api/user/recording/take", { rid: "abc123xy", i: 0, path: "/api/cot" }, { origin: "https://evil.example" }), handleRecording(new URL(ORIGIN + "/api/user/recording/take"), env, {}, {}, json, new Request(ORIGIN + "/api/user/recording/take", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), appFetch)]);
ok("take refuses a bad id, a bad index, another site, a body that is not JSON", bad.map((x) => x.status).join() === "400,400,403,415");
kv.set(REC_KEYS.part("abc123xy", 2), JSON.stringify({ path: "/api/quote?symbols=AAPL", s: 200, b: { price: 1 } }));
r = await (await post("/api/user/recording/commit", { rid: "abc123xy", n: 3 })).json();
const rec = JSON.parse(kv.get(REC_KEYS.current)), meta = JSON.parse(kv.get(REC_KEYS.meta));
ok("commit: the parts become the recording; a part that is not an official route is left out even if it is in storage", r.ok && Object.keys(rec.r).sort().join() === "/api/cot,/api/yields" && rec.n === 2 && meta.n === 2 && meta.bytes === kv.get(REC_KEYS.current).length && !/AAPL/.test(kv.get(REC_KEYS.current)));
ok("commit: the recording carries its time (the first answer kept) and what it holds", rec.t0 <= rec.at && /official sources only/.test(rec.sources) && meta.paths.join() === "/api/cot,/api/yields");
r = await post("/api/user/recording/commit", { rid: "zzzzzzzz", n: 2 });
ok("commit with no part kept: refused, the last recording stays", r.status === 409 && JSON.parse(kv.get(REC_KEYS.meta)).n === 2);
r = await (await get("/api/user/recording")).json();
ok("summary after a recording", r.meta && r.meta.n === 2 && r.meta.at === meta.at);

// ---------- the public paths ----------
const assets = { fetch: async (req) => (new URL(req.url).pathname === "/terminal/desk/" ? new Response(page, { headers: { "content-type": "text/html" } }) : new Response("nf", { status: 404 })) };
const pub = (path, method = "GET") => handleReplayPublic(new URL(ORIGIN + path), { ...env, ASSETS: assets }, new Request(ORIGIN + path, { method }));
let res = await pub("/terminal/replay/");
let txt = await res.text();
ok("/terminal/replay/: the terminal page with the player and the summary, not indexed, framed only by this site", res.status === 200 && /text\/html/.test(res.headers.get("content-type")) && /player\.js/.test(txt) && /"n":2/.test(txt) && /noindex/.test(res.headers.get("x-robots-tag")) && /frame-ancestors 'self'/.test(res.headers.get("content-security-policy")));
res = await pub("/terminal/replay/recording.json");
ok("/terminal/replay/recording.json: the recording", res.status === 200 && (await res.json()).r["/api/cot"].b.source === "U.S. Commodity Futures Trading Commission");
res = await pub("/terminal/replay");
ok("/terminal/replay → /terminal/replay/", res.status === 301 && res.headers.get("location") === "/terminal/replay/");
const nf = await Promise.all([pub("/terminal/replay/x"), pub("/terminal/replay/", "POST")]);
ok("anything else there: 404; writes: 405", nf.map((x) => x.status).join() === "404,405");
kv.delete(REC_KEYS.current);
res = await pub("/terminal/replay/recording.json");
ok("no recording: 404 no_recording", res.status === 404 && (await res.json()).error === "no_recording");

// ---------- the Worker: public replay without sign-in, the recording routes behind Access ----------
res = await worker.fetch(new Request(ORIGIN + "/terminal/replay/recording.json"), { ...env, ASSETS: assets }, { waitUntil() {} });
ok("Worker: /terminal/replay/* answers without a Cloudflare Access token", res.status === 404 && (await res.json()).error === "no_recording");
res = await worker.fetch(new Request(ORIGIN + "/api/user/recording"), { ...env, ASSETS: assets, ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com", ACCESS_AUD: "aud" }, { waitUntil() {} });
ok("Worker: /api/user/recording needs the Access token", res.status === 401 || res.status === 403);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
