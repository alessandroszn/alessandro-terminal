// T06 — world economic calendar (Forex Factory weekly export), Worker side. Fixture in the export's format.
//   node test/calendar-world.test.mjs
import { app as worker } from "../src/worker.mjs";
import { normalizeFF, FF_URL, ffWeekKey, reactionFrom, computeReaction, reactKey } from "../src/calendar.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

const FF = [
  { title: "CPI m/m", country: "USD", date: "2026-10-07T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" },
  { title: "Main Refinancing Rate", country: "EUR", date: "2026-10-08T08:15:00-04:00", impact: "High", forecast: "2.15%", previous: "2.15%" },
  { title: "Retail Sales m/m", country: "AUD", date: "2026-10-06T21:30:00-04:00", impact: "Medium", forecast: "", previous: "0.4%" },
  { title: "Bank Holiday", country: "JPY", date: "2026-10-05T00:00:00-04:00", impact: "Holiday", forecast: "", previous: "" },
  { title: "CPI m/m", country: "USD", date: "2026-10-07T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" }, // duplicate
  { title: "broken", country: "EUR", date: "not a date", impact: "High" },
  { title: "unknown impact", country: "EUR", date: "2026-10-07T08:30:00-04:00", impact: "Huge" },
];
const ev = normalizeFF(FF, Date.parse("2026-10-07T10:00:00Z"));
ok("export → events: invalid and duplicate rows dropped, sorted by time", ev.length === 4 && ev[0].indicator === "Bank Holiday" && ev.at(-1).indicator === "Main Refinancing Rate");
const cpi = ev.find((e) => e.indicator === "CPI m/m");
ok("event fields: UTC time, ET date/time, region, currency, impact", cpi.datetime === "2026-10-07T12:30:00.000Z" && cpi.dateET === "2026-10-07" && cpi.timeET === "08:30" && cpi.region === "United States" && cpi.currency === "USD" && cpi.impact === "High");
ok("forecast / previous as published; empty → N/A; actual always N/A (not in the export)", cpi.forecast.value === "0.3%" && cpi.previous.value === "0.2%" && ev.find((e) => e.currency === "AUD").forecast.status === "N/A" && ev.every((e) => e.actual.status === "N/A" && e.actual.value === null));
ok("released flag from the clock", cpi.released === false && ev.find((e) => e.currency === "AUD").released === true);
ok("garbage export → no events", normalizeFF(null).length === 0 && normalizeFF({ x: 1 }).length === 0);

let ffMode = "ok";
globalThis.fetch = async (u) => {
  if (String(u) === FF_URL) return ffMode === "ok" ? new Response(JSON.stringify(FF)) : new Response("", { status: 429 });
  return new Response("", { status: 403 }); // BLS / BEA refused in this test
};
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com" }, ctx = { waitUntil: () => {} };
const call = async () => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com/api/calendar"), env, ctx); return { status: r.status, j: await r.json() }; };
let r = await call();
ok("calendar: world events from Forex Factory, source LIVE; US schedules reported N/A", r.status === 200 && r.j.world.length === 4 && r.j.sources[0].id === "FF" && r.j.sources[0].status === "LIVE" && r.j.errors.BLS && r.j.errors.BEA);
store = new Map(); ffMode = "down";
r = await call();
ok("Forex Factory unavailable → FF N/A, no world events invented", r.j.world.length === 0 && r.j.errors.FF.error === "rate_limited" && r.j.errors.FF.status === "N/A");

// ---------- archive, past releases, market reaction ----------
ok("week key: Sunday (New York) of the export's week", ffWeekKey(FF) === "2026-10-04" && ffWeekKey([]) === null);
const kv = new Map(), BRIEFS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
const PREV = [{ title: "CPI m/m", country: "USD", date: "2026-10-02T08:30:00-04:00", impact: "High", forecast: "0.2%", previous: "0.1%" }, { title: "Old event", country: "EUR", date: "2026-09-28T08:00:00-04:00", impact: "High", forecast: "", previous: "" }];
kv.set("cal/ff/2026-09-27", JSON.stringify(PREV));
store = new Map(); ffMode = "ok";
const realNow = Date.now; Date.now = () => Date.parse("2026-10-05T12:00:00Z");
const pending = []; const ctx2 = { waitUntil: (p) => pending.push(p) };
let res = await worker.fetch(new Request("https://alessandrozanichelli.com/api/calendar"), { ...env, BRIEFS }, ctx2); await Promise.all(pending);
let jj = await res.json();
ok("calendar: fresh export archived in KV by week; last 4 days of the previous week added from the archive (older ones not)", kv.has("cal/ff/2026-10-04") && jj.world.some((e) => e.indicator === "CPI m/m" && e.archived && e.datetime === "2026-10-02T12:30:00.000Z") && !jj.world.some((e) => e.indicator === "Old event") && jj.backDays === 4);
res = await worker.fetch(new Request("https://alessandrozanichelli.com/api/calendar/history?ccy=USD&title=CPI%20m%2Fm"), { ...env, BRIEFS }, ctx2);
jj = await res.json();
ok("past releases: every archived week, newest first, one row per release, forecast / previous as published", jj.releases.length === 2 && jj.releases[0].datetime === "2026-10-07T12:30:00.000Z" && jj.releases[1].previous === "0.1%" && /previous/.test(jj.note));
Date.now = realNow;
const T0 = Date.parse("2026-10-07T12:30:00Z"), min = (m) => T0 + m * 60_000;
const pts = [[min(-3), 1.1], [min(-1), 1.1], [min(0), 1.101], [min(14), 1.1022], [min(59), 1.0989]];
const re = reactionFrom(pts, T0);
ok("reaction: last price before the time vs 15 and 60 minutes after", re.before === 1.1 && Math.abs(re.m15.chg - 0.2) < 1e-9 && Math.abs(re.m60.chg + 0.1) < 1e-9);
ok("reaction: no price just before the time (market closed) → none", reactionFrom([[min(-30), 1.1], [min(14), 1.2]], T0) === null && reactionFrom([], T0) === null);
let calls = [];
globalThis.fetch = async (u) => { u = String(u); calls.push(u);
  if (u.includes("api.twelvedata.com/time_series")) return new Response(JSON.stringify({ status: "ok", values: [{ datetime: "2026-10-07 12:29:00", close: "1.1" }, { datetime: "2026-10-07 12:44:00", close: "1.1011" }, { datetime: "2026-10-07 13:29:00", close: "1.1022" }] }));
  if (u.includes("data.alpaca.markets/v2/stocks/bars")) return new Response(JSON.stringify({ bars: { SPY: [{ t: "2026-10-07T12:29:00Z", c: 600 }, { t: "2026-10-07T12:44:00Z", c: 597 }], TLT: [] } }));
  return new Response("", { status: 404 }); };
const evU = { id: "x", currency: "USD", indicator: "CPI m/m", datetime: "2026-10-07T12:30:00.000Z", impact: "High" };
const cr = await computeReaction({ TWELVEDATA_KEY: "TESTKEY_never_returned", ALPACA_KEY_ID: "a", ALPACA_SECRET_KEY: "b" }, evU, min(90));
const usd = cr.items.find((i) => i.symbol === "USD vs EUR"), spy = cr.items.find((i) => i.symbol === "SPY");
ok("reaction for a USD event: dollar vs euro (EUR/USD inverted), SPY from Alpaca; TLT without bars omitted; final after 77 min", !!usd && Math.abs(usd.m15.chg - (100 / 1.001 - 100)) < 1e-9 && !!spy && Math.abs(spy.m15.chg + 0.5) < 1e-9 && !cr.items.some((i) => i.symbol === "TLT") && cr.final === true);
ok("reaction: provider key only in headers; keyed per event", !calls.some((u) => /TESTKEY|apikey=/.test(u)) && reactKey(evU) === "cal/react/USD/" + T0 + "/cpi-m-m");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
