// T04 — Data Integrity & Trust Layer: Worker-side tests.
// Mocked provider (fetch), mocked shared cache (caches.default) and a controllable clock.
//   node test/integrity.test.mjs
import { app as worker,  buildInstrument, normalizeQuote, QUOTE_FIELDS, STATUS, __stats, __resetForTests } from "../src/worker.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

// ---------- controllable clock ----------
const realNow = Date.now;
let clock = Date.parse("2026-10-06T15:00:00Z");
Date.now = () => clock;

// ---------- shared cache mock (stores text, returns a fresh Response each time) ----------
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

// ---------- provider mock ----------
const KEY = "TESTKEY_never_returned";
const tdQuote = (s, px, open = true) => ({
  symbol: s, name: s + " Inc", exchange: "NASDAQ", currency: "USD", datetime: "2026-10-06",
  timestamp: 1791297000, last_quote_at: 1791300000,
  open: "100", high: "102", low: "99", close: String(px), volume: "537842",
  previous_close: "100", change: String(px - 100), percent_change: String(px - 100),
  is_market_open: open, fifty_two_week: { low: "80", high: "120" },
});
let mode = "ok", delayMs = 0, providerUrls = [], marketOpen = true;
const UNKNOWN = new Set(["ZQXJ9W", "NOPE"]);
globalThis.fetch = async (u, opts) => {
  providerUrls.push(String(u));
  const url = new URL(u);
  if (mode === "hang") return new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  if (mode === "unreachable") throw new TypeError("network down");
  if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  if (mode === "ratelimit") return new Response(JSON.stringify({ code: 429, message: "You have run out of API credits for the current minute.", status: "error" }));
  if (mode === "empty") return new Response("");
  if (mode === "html") return new Response("<html>bad gateway</html>");
  if (url.pathname === "/time_series") {
    if (mode === "hist-today") return new Response(JSON.stringify({ meta: { exchange_timezone: "America/New_York", currency: "USD" }, values: [{ datetime: "2026-10-05", close: "330" }, { datetime: new Date(clock).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), close: "332" }], status: "ok" }));
    if (url.searchParams.get("interval") === "5min") return new Response(JSON.stringify({ meta: { exchange_timezone: "America/New_York" }, values: [{ datetime: "2026-10-06 14:55:00", close: "331" }, { datetime: "2026-10-06 15:00:00", close: "332" }], status: "ok" }));
    return new Response(JSON.stringify({ meta: { exchange_timezone: "America/New_York", currency: "USD" }, values: [{ datetime: "2026-10-01", close: "320" }, { datetime: "2026-10-02", close: "321" }], status: "ok" }));
  }
  const syms = url.searchParams.get("symbol").split(",");
  const one = (s) => UNKNOWN.has(s) ? { code: 404, message: `symbol ${s} not found`, status: "error" } : tdQuote(s, 101, marketOpen);
  if (syms.length === 1) return new Response(JSON.stringify(one(syms[0])));
  const body = {};
  for (const s of syms) if (!(mode === "drop-msft" && s === "MSFT")) body[s] = one(s);
  return new Response(JSON.stringify(body));
};

const env = { TWELVEDATA_KEY: KEY };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
async function call(path) {
  const res = await worker.fetch(new Request(`https://alessandrozanichelli.com${path}`), env, ctx);
  await Promise.all(pending.splice(0));
  const text = await res.clone().text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { res, body, text, xc: res.headers.get("x-cache") };
}
function reset() { store = new Map(); globalThis.caches.default.store = store; __resetForTests(); mode = "ok"; delayMs = 0; providerUrls = []; marketOpen = true; clock = Date.parse("2026-10-06T15:00:00Z"); }
// the cache mock closes over `store` by reference at call time
globalThis.caches.default.match = async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; };
globalThis.caches.default.put = async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); };

// =============== 1. live data -> LIVE ===============
reset();
let r = await call("/api/quote?symbols=AAPL");
let a = r.body.quotes.AAPL;
ok("[1 live] instrument status LIVE", a && a.status === STATUS.LIVE, JSON.stringify(a && a.status));
ok("[1 live] price field LIVE with value", a.fields.price.status === "LIVE" && a.fields.price.value === 101);
ok("[1 live] InstrumentData contract: symbol/source/timestamp/fetchedAt/staleAt", a.symbol === "AAPL" && a.source === "twelvedata" && !!Date.parse(a.timestamp) && !!Date.parse(a.fetchedAt) && Date.parse(a.staleAt) - Date.parse(a.fetchedAt) === 10 * 60_000);
ok("[1 live] timestamp = provider data time (last_quote_at), not fetch time", a.timestamp === new Date(1791300000 * 1000).toISOString(), a.timestamp);
ok("[1 live] prevClose and 52W are LIVE", a.fields.prevClose.status === "LIVE" && a.fields.fiftyTwoWeekHigh.status === "LIVE");

// =============== 5. partial data -> PARTIAL ===============
ok("[5 partial] volume PARTIAL, value kept, with venue note", a.fields.volume.status === "PARTIAL" && a.fields.volume.value === 537842 && /5%/.test(a.fields.volume.note));
ok("[5 partial] open/high/low PARTIAL", ["open", "high", "low"].every(k => a.fields[k].status === "PARTIAL"));

// =============== 7. missing fundamentals -> N/A ===============
const FUND = ["marketCap", "pe", "eps", "dividendYield", "sharesOutstanding"];
ok("[7 fundamentals] all N/A with null value", FUND.every(k => a.fields[k].status === "N/A" && a.fields[k].value === null), JSON.stringify(FUND.map(k => a.fields[k])));
ok("[7 fundamentals] N/A carries a reason", FUND.every(k => /not provided/.test(a.fields[k].note)));
ok("[7 fundamentals] contract has no source for fundamentals", FUND.every(k => QUOTE_FIELDS[k].from === null));
const rec = normalizeQuote("X", { close: "10", previous_close: null, volume: "" });
const inst = buildInstrument(rec, { fetchedAt: clock, now: clock });
ok("[7 fundamentals] a field the provider omits becomes N/A (never estimated)", inst.fields.volume.status === "N/A" && inst.fields.volume.value === null && inst.fields.prevClose.status === "N/A");

// =============== 10. cache miss ===============
ok("[10 miss] first call x-cache MISS and 1 provider call", r.xc === "MISS" && __stats.providerQuoteCalls === 1, `${r.xc} ${__stats.providerQuoteCalls}`);
ok("[10 miss] meta.cache counts the miss", r.body.meta.cache.miss === 1 && r.body.meta.cache.hit === 0);

// =============== 9. cache hit ===============
clock += 30_000;
r = await call("/api/quote?symbols=AAPL");
ok("[9 hit] second call within 60 s -> HIT, no provider call", r.xc === "HIT" && __stats.providerQuoteCalls === 1, `${r.xc} ${__stats.providerQuoteCalls}`);
ok("[9 hit] cached answer still LIVE with ORIGINAL fetchedAt", r.body.quotes.AAPL.status === "LIVE" && Date.parse(r.body.quotes.AAPL.fetchedAt) === clock - 30_000);
clock += 31_000;
r = await call("/api/quote?symbols=AAPL");
ok("[9 hit] after 60 s the entry is refreshed from the provider", r.xc === "MISS" && __stats.providerQuoteCalls === 2);
r = await call("/api/quote?symbols=AAPL,MSFT");
ok("[9 hit] mixed request -> PARTIAL-HIT, only MSFT fetched", r.xc === "PARTIAL-HIT" && /symbol=MSFT$/.test(providerUrls.at(-1)), providerUrls.at(-1).replace(KEY, "***"));

// market closed: 15-minute freshness
reset(); marketOpen = false;
await call("/api/quote?symbols=AAPL");
clock += 10 * 60_000;
r = await call("/api/quote?symbols=AAPL");
ok("[9 hit] market closed -> 15 min freshness (HIT after 10 min)", r.xc === "HIT" && r.body.quotes.AAPL.marketOpen === false);

// =============== 4. stale data -> STALE ===============
reset();
await call("/api/quote?symbols=AAPL");
clock += 5 * 60_000; mode = "ratelimit";
r = await call("/api/quote?symbols=AAPL");
a = r.body.quotes.AAPL;
ok("[4 stale] provider fails after freshness window -> STALE (HTTP 200)", r.res.status === 200 && a.status === "STALE" && r.xc === "STALE");
ok("[4 stale] staleReason explains why", a.staleReason === "rate_limited");
ok("[4 stale] every real field STALE, fundamentals stay N/A", a.fields.price.status === "STALE" && a.fields.volume.status === "STALE" && a.fields.pe.status === "N/A");
ok("[4 stale] keeps the original fetchedAt (age is visible)", clock - Date.parse(a.fetchedAt) === 5 * 60_000);
const old = buildInstrument(rec, { fetchedAt: clock - 11 * 60_000, now: clock });
const young = buildInstrument(rec, { fetchedAt: clock - 5 * 60_000, now: clock });
ok("[4 stale] 5-minute-old value (one refresh cycle) is still LIVE", young.status === "LIVE");
ok("[4 stale] buildInstrument marks an over-age entry STALE even without an error", old.status === "STALE");
clock += 25 * 3600_000;
r = await call("/api/quote?symbols=AAPL");
ok("[4 stale] beyond 24 h the stale entry is NOT served -> error + N/A", !r.body.quotes.AAPL && r.body.errors.AAPL.error === "rate_limited" && r.body.errors.AAPL.status === "N/A" && r.res.status === 429);

// =============== 6. provider failure: no fake fallback ===============
reset(); mode = "ratelimit";
r = await call("/api/quote?symbols=AAPL,MSFT");
ok("[6 failure] no cache + provider error -> no quotes at all", Object.keys(r.body.quotes).length === 0);
ok("[6 failure] each symbol reported in errors with status N/A", r.body.errors.AAPL.error === "rate_limited" && r.body.errors.MSFT.status === "N/A");
ok("[6 failure] HTTP 429 propagated", r.res.status === 429);
ok("[6 failure] response contains no price-like value", !/"price"|"value"/.test(r.text));
reset(); mode = "unreachable";
r = await call("/api/quote?symbols=AAPL");
ok("[6 failure] network error -> 502 provider_unreachable", r.res.status === 502 && r.body.errors.AAPL.error === "provider_unreachable");

// =============== 11. concurrent identical requests ===============
reset(); delayMs = 60;
const many = await Promise.all(Array.from({ length: 6 }, () => call("/api/quote?symbols=AAPL")));
ok("[11 concurrent] 6 simultaneous AAPL requests -> 1 provider call", __stats.providerQuoteCalls === 1, String(__stats.providerQuoteCalls));
ok("[11 concurrent] all 6 got the same LIVE quote", many.every(x => x.body.quotes.AAPL && x.body.quotes.AAPL.status === "LIVE" && x.body.quotes.AAPL.fetchedAt === many[0].body.quotes.AAPL.fetchedAt));
reset(); delayMs = 60;
await Promise.all([call("/api/quote?symbols=AAPL,MSFT"), call("/api/quote?symbols=AAPL"), call("/api/quote?symbols=MSFT,AAPL")]);
const fetchedSyms = providerUrls.flatMap(u => new URL(u).searchParams.get("symbol").split(","));
ok("[11 concurrent] overlapping batches: each symbol fetched from the provider exactly once", fetchedSyms.filter(s => s === "AAPL").length === 1 && fetchedSyms.filter(s => s === "MSFT").length === 1, fetchedSyms.join());
r = await call("/api/quote?symbols=AAPL,aapl,AAPL");
ok("[11 concurrent] duplicate symbols in one request are de-duplicated", Object.keys(r.body.quotes).length === 1);

// =============== 12. provider timeout ===============
reset(); mode = "hang";
clock = realNow(); // the abort timer uses real time
const t0 = realNow();
r = await call("/api/quote?symbols=AAPL");
const took = realNow() - t0;
ok("[12 timeout] hung provider -> 504 provider_timeout", r.res.status === 504 && r.body.errors.AAPL.error === "provider_timeout", `${r.res.status} ${r.text}`);
ok("[12 timeout] aborted after ~8 s (not hanging)", took >= 7500 && took < 10000, `${took} ms`);
ok("[12 timeout] no value returned", Object.keys(r.body.quotes).length === 0);

// =============== 13. invalid ticker ===============
reset();
r = await call("/api/quote?symbols=ZQXJ9W");
ok("[13 invalid] unknown ticker -> 404 symbol_not_found, status N/A", r.res.status === 404 && r.body.errors.ZQXJ9W.error === "symbol_not_found" && r.body.errors.ZQXJ9W.status === "N/A");
r = await call("/api/quote?symbols=AAPL,NOPE");
ok("[13 invalid] mixed batch: AAPL LIVE + NOPE error, HTTP 200", r.res.status === 200 && r.body.quotes.AAPL.status === "LIVE" && r.body.errors.NOPE.error === "symbol_not_found");
const before = __stats.providerQuoteCalls;
r = await call("/api/quote?symbols=" + encodeURIComponent("AA PL;DROP"));
ok("[13 invalid] malformed ticker rejected without a provider call", r.res.status === 400 && r.body.errors["AA PL;DROP"].error === "invalid_symbol" && __stats.providerQuoteCalls === before);
r = await call("/api/quote?symbols=");
ok("[13 invalid] no symbols -> 400", r.res.status === 400);
// a cached entry must never be served for a symbol the provider says does not exist
reset();
store.set("https://alessandrozanichelli.com/__cache/quote/ZQXJ9W", JSON.stringify({ rec: normalizeQuote("ZQXJ9W", tdQuote("ZQXJ9W", 5)), fetchedAt: clock - 120_000 }));
r = await call("/api/quote?symbols=ZQXJ9W");
ok("[13 invalid] stale entry NOT served when provider says symbol_not_found", !r.body.quotes.ZQXJ9W && r.res.status === 404);

// =============== 14. missing provider response ===============
reset(); mode = "empty";
r = await call("/api/quote?symbols=AAPL");
ok("[14 missing] empty provider body -> 502 provider_error, N/A", r.res.status === 502 && r.body.errors.AAPL.error === "provider_error" && r.body.errors.AAPL.status === "N/A");
reset(); mode = "html";
r = await call("/api/quote?symbols=AAPL");
ok("[14 missing] non-JSON provider body -> 502 provider_error", r.res.status === 502 && r.body.errors.AAPL.error === "provider_error");
reset(); mode = "drop-msft";
r = await call("/api/quote?symbols=AAPL,MSFT,NVDA");
ok("[14 missing] symbol absent from a batch reply -> only that symbol errors", r.res.status === 200 && r.body.errors.MSFT && r.body.errors.MSFT.error === "provider_error" && r.body.quotes.AAPL && r.body.quotes.NVDA && !r.body.quotes.MSFT);
const bad = normalizeQuote("AAPL", { symbol: "AAPL", close: null });
ok("[14 missing] quote without a price is rejected (null), not filled", bad === null);

// =============== history: same trust rules ===============
reset();
r = await call("/api/history?symbol=AAPL&range=6M&interval=1d");
ok("[history] interval=1d accepted, LIVE envelope with fetchedAt/staleAt", r.res.status === 200 && r.body.interval === "1day" && r.body.status === "LIVE" && !!r.body.fetchedAt && !!r.body.staleAt && r.xc === "MISS");
ok("[history] completed sessions -> lastBarPartial false", r.body.lastBarPartial === false);
ok("[history] daily staleAt = fetchedAt + 24 h (completed bars do not age)", Date.parse(r.body.staleAt) - Date.parse(r.body.fetchedAt) === 24 * 3600_000);
const r1d = await call("/api/history?symbol=AAPL&range=1D");
ok("[history] intraday staleAt = fetchedAt + 15 min", Date.parse(r1d.body.staleAt) - Date.parse(r1d.body.fetchedAt) === 15 * 60_000);
clock += 16 * 60_000; mode = "ratelimit";
r = await call("/api/history?symbol=AAPL&range=6M&interval=1d");
ok("[history] provider fails after TTL -> STALE served with reason", r.res.status === 200 && r.body.status === "STALE" && r.body.staleReason === "rate_limited" && r.xc === "STALE");
reset(); mode = "ratelimit";
r = await call("/api/history?symbol=AAPL&range=6M");
ok("[history] no cache + provider error -> 429, no points", r.res.status === 429 && !r.body.points && r.body.status === "N/A");
reset(); mode = "hist-today";
r = await call("/api/history?symbol=AAPL&range=1M");
ok("[history] bar dated today (session in progress) -> lastBarPartial true", r.body.lastBarPartial === true);

// =============== security ===============
reset();
const all = [await call("/api/quote?symbols=AAPL,NOPE"), await call("/api/history?symbol=AAPL&range=1M")];
mode = "ratelimit"; clock += 26 * 3600_000; all.push(await call("/api/quote?symbols=AAPL"));
ok("[security] API key never appears in any response body or header", all.every(x => !x.text.includes(KEY) && ![...x.res.headers.values()].some(v => v.includes(KEY))));
ok("[security] quote responses are no-store for browsers", all[0].res.headers.get("cache-control") === "no-store");

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
