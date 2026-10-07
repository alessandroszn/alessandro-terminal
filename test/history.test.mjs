// T03 tests: pure functions + the Worker handler with a mocked provider and cache.
import { app as worker,  buildHistoryQuery, normalizeHistory, mapProviderError, BadRequest, lastBarInProgress } from "../src/worker.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`);
  cond ? pass++ : fail++;
};
const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof BadRequest; } };

// ---------------- buildHistoryQuery ----------------
const NOW = new Date("2026-10-06T18:00:00Z");
const b6 = buildHistoryQuery({ symbol: "aapl", range: "6M" }, NOW);
ok("6M -> 1day", b6.interval === "1day");
ok("6M -> order asc", b6.q.order === "asc");
ok("6M -> adjust splits (default)", b6.q.adjust === "splits");
ok("6M -> start_date 6 months back", b6.q.start_date === "2026-04-06", b6.q.start_date);
ok("6M -> no timezone param (ignored by provider for daily)", b6.q.timezone === undefined);
ok("6M -> symbol upper-cased", b6.q.symbol === "AAPL");
ok("6M -> ttl 900", b6.ttl === 900);
const b1d = buildHistoryQuery({ symbol: "AAPL", range: "1D" }, NOW);
ok("1D -> 5min intraday", b1d.interval === "5min" && b1d.intraday);
ok("1D -> timezone UTC", b1d.q.timezone === "UTC");
ok("1D -> 78 bars", b1d.q.outputsize === "78");
ok("1W -> 7 calendar days back", buildHistoryQuery({ symbol: "AAPL", range: "1W" }, NOW).q.start_date === "2026-09-29");
ok("5Y -> 1week", buildHistoryQuery({ symbol: "AAPL", range: "5Y" }, NOW).interval === "1week");
const b5d = buildHistoryQuery({ symbol: "AAPL", range: "5D" }, NOW);
ok("5D -> 15min intraday, five sessions (130 bars), UTC", b5d.interval === "15min" && b5d.intraday && b5d.q.outputsize === "130" && b5d.q.timezone === "UTC" && b5d.ttl === 120);
ok("5D with 5min -> 390 bars", buildHistoryQuery({ symbol: "AAPL", range: "5D", interval: "5min" }, NOW).q.outputsize === "390");
ok("5D daily -> BadRequest", throws(() => buildHistoryQuery({ symbol: "AAPL", range: "5D", interval: "1day" }, NOW)));
const b10 = buildHistoryQuery({ symbol: "AAPL", range: "10Y" }, NOW);
ok("10Y -> weekly bars from 10 years back, ttl 1h", b10.interval === "1week" && b10.q.start_date === "2016-10-06" && b10.ttl === 3600, JSON.stringify(b10.q));
const bmax = buildHistoryQuery({ symbol: "AAPL", range: "MAX" }, NOW);
ok("MAX -> monthly bars over the whole history the provider has", bmax.interval === "1month" && bmax.q.start_date === "1970-01-01" && bmax.q.outputsize === "5000");
ok("5Y daily allowed (backtest, price chart)", buildHistoryQuery({ symbol: "AAPL", range: "5Y", interval: "1day" }, NOW).q.interval === "1day");
ok("monthly on 6M -> BadRequest", throws(() => buildHistoryQuery({ symbol: "AAPL", range: "6M", interval: "1month" }, NOW)));
ok("bar in progress: today's daily bar, this week's weekly bar, this month's monthly bar",
  lastBarInProgress("2026-10-06", "1day", "2026-10-06") && !lastBarInProgress("2026-10-05", "1day", "2026-10-06") &&
  lastBarInProgress("2026-10-05", "1week", "2026-10-07") && !lastBarInProgress("2026-09-28", "1week", "2026-10-07") &&
  lastBarInProgress("2026-10-01", "1month", "2026-10-07") && !lastBarInProgress("2026-09-01", "1month", "2026-10-07"));
ok("adjust=all accepted", buildHistoryQuery({ symbol: "AAPL", adjust: "all" }, NOW).q.adjust === "all");
ok("FX symbol accepted", buildHistoryQuery({ symbol: "EUR/USD", range: "1M" }, NOW).q.symbol === "EUR/USD");
ok("missing symbol -> BadRequest", throws(() => buildHistoryQuery({}, NOW)));
ok("bad range -> BadRequest", throws(() => buildHistoryQuery({ symbol: "AAPL", range: "7M" }, NOW)));
ok("bad symbol chars -> BadRequest", throws(() => buildHistoryQuery({ symbol: "AAPL;DROP", range: "6M" }, NOW)));
ok("bad adjust -> BadRequest", throws(() => buildHistoryQuery({ symbol: "AAPL", adjust: "x" }, NOW)));
ok("intraday on 6M -> BadRequest", throws(() => buildHistoryQuery({ symbol: "AAPL", range: "6M", interval: "5min" }, NOW)));
ok("daily on 1D -> BadRequest", throws(() => buildHistoryQuery({ symbol: "AAPL", range: "1D", interval: "1day" }, NOW)));

// ---------------- normalizeHistory ----------------
const tdDaily = {
  meta: { symbol: "AAPL", interval: "1day", currency: "USD", exchange_timezone: "America/New_York", exchange: "NASDAQ", type: "Common Stock" },
  values: [ // deliberately DESC, with a duplicate and a bad row
    { datetime: "2026-10-06", open: "247", high: "249", low: "245", close: "248.5", volume: "50000000" },
    { datetime: "2026-10-03", open: "245", high: "247", low: "244", close: "246.1", volume: "42000000" },
    { datetime: "2026-10-03", open: "245", high: "247", low: "244", close: "246.1", volume: "42000000" },
    { datetime: "2026-10-02", open: "x",   high: "x",   low: "x",   close: "",      volume: "" },
    { datetime: "2026-10-01", open: "243", high: "245", low: "242", close: "244.0", volume: "40000000" },
  ],
  status: "ok",
};
const nd = normalizeHistory(tdDaily, { intraday: false });
ok("daily sorted oldest -> newest", nd.points.map(p => p.t).join() === "2026-10-01,2026-10-03,2026-10-06", nd.points.map(p => p.t).join());
ok("duplicate date removed", nd.points.length === 3);
ok("bad close row dropped", !nd.points.some(p => p.t === "2026-10-02"));
ok("daily t stays exchange date (no fake UTC)", nd.points[0].t === "2026-10-01");
ok("numbers parsed", nd.points[2].c === 248.5 && nd.points[2].v === 50000000);
ok("meta carried", nd.exchangeTimezone === "America/New_York" && nd.currency === "USD");
const ni = normalizeHistory({ values: [{ datetime: "2026-10-06 15:55:00", close: "248.1" }, { datetime: "2026-10-06 15:50:00", close: "248.0" }] }, { intraday: true });
ok("intraday -> ISO UTC", ni.points[0].t === "2026-10-06T15:50:00Z" && ni.points[1].t === "2026-10-06T15:55:00Z");
ok("missing volume -> null (FX)", ni.points[0].v === null);
ok("empty values -> no points", normalizeHistory({ values: [] }, { intraday: false }).points.length === 0);

// ---------------- mapProviderError ----------------
ok("TD 404 -> symbol_not_found", mapProviderError({ code: 404, message: "not found" }).status === 404);
ok("TD 400 symbol msg -> 404", mapProviderError({ code: 400, message: "**symbol** not found: XXX" }).error === "symbol_not_found");
ok("TD 429 -> rate_limited", mapProviderError({ code: 429 }).status === 429);
ok("TD 401 -> 502 provider_auth", mapProviderError({ code: 401 }).error === "provider_auth");
ok("TD other -> 502", mapProviderError({ code: 500 }).status === 502);

// ---------------- handler integration (mocked fetch + cache) ----------------
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const r = store.get(req.url); return r ? r.clone() : undefined; },
  put: async (req, res) => { store.set(req.url, res); },
} };
let providerCalls = 0, lastProviderUrl = "";
let mode = "ok";
globalThis.fetch = async (u, opts) => {
  providerCalls++; lastProviderUrl = String(u);
  if (mode === "ok") return new Response(JSON.stringify(tdDaily));
  if (mode === "notfound") return new Response(JSON.stringify({ code: 400, message: "**symbol** not found", status: "error" }));
  if (mode === "ratelimit") return new Response(JSON.stringify({ code: 429, message: "run out of API credits", status: "error" }));
  if (mode === "hang") return new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(new Error("aborted"))));
};
const env = { TWELVEDATA_KEY: "test-key-not-real", ALLOWED_ORIGIN: "*" };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (qs) => {
  const res = await worker.fetch(new Request(`https://alessandrozanichelli.com/api/history${qs}`), env, ctx);
  await Promise.all(waits.splice(0));
  return res;
};

let r = await call("?symbol=AAPL&range=6M");
let j = await r.json();
ok("handler 200", r.status === 200, r.status);
ok("handler x-cache MISS first", r.headers.get("x-cache") === "MISS");
ok("handler cache-control 900", r.headers.get("cache-control") === "public, max-age=900");
ok("handler CORS header", r.headers.get("access-control-allow-origin") === "*");
ok("handler schema", j.symbol === "AAPL" && j.range === "6M" && j.interval === "1day" && j.adjust === "splits" && j.timeBasis === "exchange_local_date" && j.count === 3 && j.provider === "twelvedata");
ok("provider called with order=asc & adjust=splits", /order=asc/.test(lastProviderUrl) && /adjust=splits/.test(lastProviderUrl));
ok("response body never contains the key", !JSON.stringify(j).includes("test-key-not-real"));
r = await call("?symbol=AAPL&range=6M");
ok("second call x-cache HIT", r.headers.get("x-cache") === "HIT");
ok("cache HIT did not call provider", providerCalls === 1, providerCalls);
mode = "notfound"; r = await call("?symbol=INVALID123&range=6M");
ok("invalid symbol -> 404 symbol_not_found", r.status === 404 && (await r.json()).error === "symbol_not_found");
mode = "ratelimit"; r = await call("?symbol=MSFT&range=6M");
ok("rate limit -> 429", r.status === 429);
r = await call("?range=6M");
ok("missing symbol -> 400", r.status === 400 && (await r.json()).error === "bad_request");
mode = "hang";
const t0 = Date.now(); r = await call("?symbol=NVDA&range=1M");
ok("timeout -> 504 within ~8s", r.status === 504 && Date.now() - t0 < 9500, `${r.status} ${Date.now() - t0}ms`);
const noKey = await worker.fetch(new Request("https://x/api/history?symbol=AAPL"), {}, ctx);
ok("no secret -> 500 explicit", noKey.status === 500);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
