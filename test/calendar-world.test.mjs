// T06 — world economic calendar (Forex Factory weekly export), Worker side. Fixture in the export's format.
//   node test/calendar-world.test.mjs
import { app as worker } from "../src/worker.mjs";
import { normalizeFF, FF_URL } from "../src/calendar.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
