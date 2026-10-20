// Twelve Data credits (20 Oct 2026): the daily limit is recognised and pauses provider calls until 00:00 UTC;
// a quote taken while its market was closed is kept until that market opens again (no credits spent on the same close).
// Fixtures are test data only.
//   node test/credits.test.mjs
import { app as worker, mapProviderError, closedUntil, fxNextOpen, nextUtcMidnight, buildInstrument } from "../src/worker.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
const at = (s) => Date.parse(s);

ok("429 'for the day' → daily_limit; other 429 → rate_limited", mapProviderError({ code: 429, message: "You have run out of API credits for the day. 865 API credits were used" }).error === "daily_limit" && mapProviderError({ code: 429, message: "You have run out of API credits for the current minute" }).error === "rate_limited");
ok("reset: next 00:00 UTC", nextUtcMidnight(at("2026-10-07T20:31:00Z")) === at("2026-10-08T00:00:00Z"));
ok("FX weekend: closed from Friday 22:00 UTC until Sunday 21:00 UTC; on weekdays no hold", fxNextOpen(at("2026-10-24T12:00:00Z")) === at("2026-10-25T21:00:00Z") && fxNextOpen(at("2026-10-23T22:30:00Z")) === at("2026-10-25T21:00:00Z") && fxNextOpen(at("2026-10-21T12:00:00Z")) === null && fxNextOpen(at("2026-10-25T21:30:00Z")) === null);
const us = { symbol: "AAPL", mic: "XNGS", marketOpen: false }, fx = { symbol: "EUR/USD", marketOpen: false };
const nyOpen = at("2026-10-21T13:30:00Z");
ok("U.S. close kept until New York's next open (from the exchange status), not after it", closedUntil(us, at("2026-10-20T21:00:00Z"), at("2026-10-21T08:00:00Z"), nyOpen) === nyOpen && closedUntil(us, at("2026-10-20T21:00:00Z"), at("2026-10-21T13:31:00Z"), nyOpen) === null && closedUntil(us, at("2026-10-20T21:00:00Z"), at("2026-10-21T08:00:00Z"), null) === null && closedUntil({ ...us, marketOpen: true }, 0, 0, nyOpen) === null);
ok("a non-U.S. listing is not held (its own exchange's open is not looked up)", closedUntil({ symbol: "NESN:XSWX", mic: "XSWX", marketOpen: false }, at("2026-10-20T21:00:00Z"), at("2026-10-21T08:00:00Z"), nyOpen) === null);
ok("FX quote taken on Saturday held until Sunday 21:00 UTC", closedUntil(fx, at("2026-10-24T10:00:00Z"), at("2026-10-25T08:00:00Z"), null) === at("2026-10-25T21:00:00Z"));
const inst = buildInstrument({ symbol: "AAPL", mic: "XNGS", price: 250, marketOpen: false, provider: "x" }, { fetchedAt: at("2026-10-20T21:00:00Z"), now: at("2026-10-21T08:00:00Z"), closedUntil: nyOpen });
ok("instrument: staleAt = the next open, so the last close is not shown as STALE overnight", inst.staleAt === new Date(nyOpen).toISOString() && inst.status !== "STALE", JSON.stringify({ staleAt: inst.staleAt, status: inst.status }));

// ---------- endpoint ----------
const store = new Map();
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
let tdCalls = 0, mode = "ok";
const realNow = Date.now;
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.startsWith("https://api.twelvedata.com/quote")) {
    tdCalls++;
    if (mode === "daily") return new Response(JSON.stringify({ code: 429, message: "You have run out of API credits for the day. 801 API credits were used, with the current limit being 800.", status: "error" }));
    const syms = new URL(u).searchParams.get("symbol").split(",");
    const one = (s) => ({ symbol: s, name: s, exchange: "NASDAQ", mic_code: "XNGS", currency: "USD", close: "250", previous_close: "249", is_market_open: false, last_quote_at: Math.floor(Date.now() / 1000) - 60 });
    return new Response(JSON.stringify(syms.length === 1 ? one(syms[0]) : Object.fromEntries(syms.map((s) => [s, one(s)]))));
  }
  if (u.startsWith("https://api.twelvedata.com/time_series")) { tdCalls++; return new Response(JSON.stringify({ code: 429, message: "You have run out of API credits for the day.", status: "error" })); }
  return new Response("", { status: 404 });
};
const ctx = { waitUntil: () => {} };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", TWELVEDATA_KEY: "td-test-key-555" };
const call = async (path) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); return { status: r.status, j: await r.json(), xc: r.headers.get("x-cache") }; };

// exchange status cached by /api/exchanges: New York closed, opens 21 Oct 13:30 UTC
store.set("https://alessandrozanichelli.com/__cache/exchanges/state", JSON.stringify({ data: [{ code: "XNYS", open: false, opensAt: nyOpen }], fetchedAt: at("2026-10-20T21:00:00Z") }));
Date.now = () => at("2026-10-20T21:05:00Z");
let r = await call("/api/quote?symbols=AAPL");
const n1 = tdCalls;
Date.now = () => at("2026-10-21T06:00:00Z");
r = await call("/api/quote?symbols=AAPL");
ok("overnight: the close fetched after the close is served from the cache (no credit) and stays LIVE", n1 === 1 && tdCalls === 1 && r.j.meta.cache.hit === 1 && r.j.quotes.AAPL.status !== "STALE", JSON.stringify(r.j.meta));
Date.now = () => at("2026-10-21T13:31:00Z");
mode = "daily";
r = await call("/api/quote?symbols=AAPL,MSFT");
const n2 = tdCalls;
ok("daily limit: AAPL served STALE with the reason, MSFT N/A daily_limit, the reset time in meta", r.j.quotes.AAPL && r.j.quotes.AAPL.status === "STALE" && r.j.quotes.AAPL.staleReason === "daily_limit" && r.j.errors.MSFT.error === "daily_limit" && r.j.meta.dailyLimitUntil === "2026-10-22T00:00:00.000Z", JSON.stringify(r.j).slice(0, 300));
r = await call("/api/quote?symbols=NVDA");
ok("after the daily limit no provider call until 00:00 UTC (429 daily_limit at once)", tdCalls === n2 && r.status === 429 && r.j.errors.NVDA.error === "daily_limit");
const h = await call("/api/history?symbol=NVDA&range=1Y");
ok("history too: no provider call, the reason and when it resumes", tdCalls === n2 && h.status === 429 && h.j.error === "daily_limit" && /resumes at 2026-10-22T00:00/.test(h.j.detail || ""), JSON.stringify(h.j));
Date.now = () => at("2026-10-22T00:01:00Z"); mode = "ok";
r = await call("/api/quote?symbols=NVDA");
ok("after 00:00 UTC the provider is called again", tdCalls === n2 + 1 && r.j.quotes.NVDA && !r.j.meta.dailyLimitUntil);
Date.now = realNow;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
