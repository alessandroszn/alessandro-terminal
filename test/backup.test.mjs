// Backups (src/backup.mjs and the quote / history paths of src/worker.mjs): when Twelve Data does not answer, CNBC, then
// Finnhub, then Alpha Vantage, then the last real quote — each value labelled with the provider that gave it and why the
// first one did not; CNBC's daily bars backed by FRED (FX) and Alpaca (U.S.). Providers mocked in their formats.
//   node test/backup.test.mjs
import { app as worker } from "../src/worker.mjs";
import { stateFromIndices, handleExchanges } from "../src/exchanges.mjs";
import { nqWorldEvents, handleCalendar } from "../src/calendar.mjs";
import { finnhubRec, avTarget, avError, avQuoteRec, avFxRec, avDailyPoints, alpacaPoints, cnbcAnyCode, backupDaily, cnbcDailyB, avQuote, AV_DAILY_MAX, BACKUP_ERRORS, avIdOfCnbc, keptCopy, AV_PACE, avMessage } from "../src/backup.mjs";
import { mapLimit, siteHeaders } from "../src/lib.mjs";
import { barsBlocked, noteBarsRefused, noteBarsOk, cnbcDaily } from "../src/cnbc.mjs";

let pass = 0, fail = 0;
AV_PACE.ms = 0; // no 1.2 s spacing between Alpha Vantage requests in the tests (tested on its own below)
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };

// ---------- parsers and mappings ----------
ok("CNBC codes for a backup: AAPL, EUR/USD → EUR=, USD/JPY → JPY=, BTC/USD → BTC.CM=, XAU/USD → XAU=, ISP:XMIL → ISP-IT", cnbcAnyCode("AAPL") === "AAPL" && cnbcAnyCode("EUR/USD") === "EUR=" && cnbcAnyCode("USD/JPY") === "JPY=" && cnbcAnyCode("BTC/USD") === "BTC.CM=" && cnbcAnyCode("XAU/USD") === "XAU=" && cnbcAnyCode("ISP:XMIL") === "ISP-IT" && cnbcAnyCode("IDX:SPX") === null);
ok("Finnhub quote: c / d / dp / pc / t; an unknown symbol answers zeros → nothing", finnhubRec("AAPL", { c: 251.2, d: 1.2, dp: 0.48, h: 252, l: 249, o: 250, pc: 250, t: 1792000000 }).price === 251.2 && finnhubRec("ZZZ", { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }) === null);
ok("Alpha Vantage ids: U.S. as is, Xetra .DEX, London .LON, FX from/to; Milan not offered", avTarget("AAPL").symbol === "AAPL" && avTarget("SAP:XETR").symbol === "SAP.DEX" && avTarget("VOD:XLON").symbol === "VOD.LON" && avTarget("EUR/USD").fx && avTarget("ISP:XMIL") === null);
ok("Alpha Vantage's real refusal texts: the daily limit (it mentions premium plans) → daily_limit, a burst → rate_limited, a premium endpoint → plan_required, a bad key → provider_auth; its words kept, the key masked",
  avError({ Information: "We have detected your API key as KEY123 and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits." }) === "daily_limit"
  && avError({ Information: "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly access all premium endpoints" }) !== "plan_required"
  && avError({ Information: "Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints" }) === "plan_required"
  && avError({ Information: "the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key)." }) === "provider_auth"
  && avMessage({ Information: "We have detected your API key as KEY123 and ..." }, "KEY123") === "We have detected your API key as *** and ...");
ok("Alpha Vantage refusals: the 25-a-day limit → daily_limit; premium → plan_required; Error Message → symbol_not_found", avError({ Information: "Our standard API rate limit is 25 requests per day." }) === "daily_limit" && avError({ Information: "This is a premium endpoint." }) === "plan_required" && avError({ "Error Message": "Invalid API call." }) === "symbol_not_found" && avError({ "Global Quote": {} }) === null);
const GQ = { "Global Quote": { "01. symbol": "AAPL", "02. open": "250.00", "03. high": "252.00", "04. low": "249.00", "05. price": "251.10", "06. volume": "1000", "07. latest trading day": "2026-10-21", "08. previous close": "250.00", "09. change": "1.10", "10. change percent": "0.44%" } };
ok("Alpha Vantage quote: the last session's price and date (no time)", avQuoteRec("AAPL", GQ).price === 251.1 && avQuoteRec("AAPL", GQ).changePct === 0.44 && avQuoteRec("AAPL", GQ).dateOnly === "2026-10-21" && avQuoteRec("AAPL", { "Global Quote": {} }) === null);
ok("Alpha Vantage FX: the rate and its UTC time", avFxRec("EUR/USD", { "Realtime Currency Exchange Rate": { "3. To_Currency Code": "USD", "5. Exchange Rate": "1.16100000", "6. Last Refreshed": "2026-10-22 12:00:01", "7. Time Zone": "UTC" } }).asOf === "2026-10-22T12:00:01.000Z");
ok("Alpha Vantage daily: oldest first", avDailyPoints({ "Time Series (Daily)": { "2026-10-21": { "4. close": "2" }, "2026-10-20": { "4. close": "1" } } }).map((p) => p.t).join() === "2026-10-20,2026-10-21");
ok("Alpaca daily bars → points", alpacaPoints([{ t: "2026-10-20T04:00:00Z", o: 1, h: 2, l: 1, c: 2, v: 10 }])[0].t === "2026-10-20");
ok("a backup stands in for credits, limits, refusals, outages and no key — never for an invalid symbol", ["daily_limit", "rate_limited", "provider_timeout", "provider_unreachable", "not_configured"].every((e) => BACKUP_ERRORS.has(e)) && !BACKUP_ERRORS.has("invalid_symbol"));

// ---------- the providers, mocked by host ----------
let store = new Map();
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const AV_KEY = "AVKEY_secret_never_shown", FH_KEY = "FHKEY_secret";
let down = new Set(), asked = [];
const cnq = (symbol, last, ccy = "USD") => ({ symbol, code: 0, name: symbol + " name", last: String(last), last_time: "2026-10-22T14:30:00.000-0400", previous_day_closing: String(last - 1), change: "+1", change_pct: "+0.40%", open: String(last), high: String(last), low: String(last), currencyCode: ccy, exchange: "NASDAQ", realTime: "true", countryCode: "US" });
const sentHeaders = {};
globalThis.fetch = async (u, opts = {}) => {
  const url = new URL(String(u)), h = url.hostname; asked.push(h); sentHeaders[h] = opts.headers || {};
  if (down.has(h)) return new Response("<html>down</html>", { status: 503 });
  if (h === "api.twelvedata.com") return new Response(JSON.stringify({ code: 429, message: "You have run out of API credits for the day.", status: "error" }));
  if (h === "quote.cnbc.com") { const syms = decodeURIComponent(/symbols=([^&]+)/.exec(String(u))[1]).split("|"); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((s) => (s === "AAPL" ? cnq(s, 250) : s === "EUR=" ? cnq(s, 1.16) : s === "BTC.CM=" ? cnq(s, 90000) : { symbol: s, code: 1 })) } })); }
  if (h === "finnhub.io") return new Response(JSON.stringify(url.searchParams.get("symbol") === "AAPL" ? { c: 251, d: 1, dp: 0.4, h: 252, l: 249, o: 250, pc: 250, t: 1792000000 } : { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }));
  if (h === "www.alphavantage.co") { const f = url.searchParams.get("function"); return new Response(JSON.stringify(f === "GLOBAL_QUOTE" ? GQ : f === "CURRENCY_EXCHANGE_RATE" ? { "Realtime Currency Exchange Rate": { "3. To_Currency Code": "USD", "5. Exchange Rate": "1.161", "6. Last Refreshed": "2026-10-22 12:00:01", "7. Time Zone": "UTC" } } : { "Time Series (Daily)": { "2026-10-20": { "1. open": "1", "2. high": "1", "3. low": "1", "4. close": "240", "5. volume": "1" }, "2026-10-21": { "1. open": "1", "2. high": "1", "3. low": "1", "4. close": "241", "5. volume": "1" } } })); }
  if (h === "ts-api.cnbc.com") { const bars = []; for (let i = 0; i < 30; i++) { const d = new Date(Date.UTC(2026, 8, 1 + i)); if (d.getUTCDay() % 6) bars.push({ tradeTime: d.toISOString().slice(0, 10).replace(/-/g, "") + "000000", tradeTimeinMills: String(d.getTime()), open: "1", high: "1", low: "1", close: String(200 + i), volume: "1" }); } return new Response(JSON.stringify({ barData: { priceBars: bars } })); }
  if (h === "data.alpaca.markets") return new Response(JSON.stringify({ bars: { [url.searchParams.get("symbols")]: [{ t: "2026-10-20T04:00:00Z", o: 1, h: 1, l: 1, c: 230, v: 1 }, { t: "2026-10-21T04:00:00Z", o: 1, h: 1, l: 1, c: 231, v: 1 }] }, next_page_token: null }));
  if (h === "api.stlouisfed.org") return new Response(JSON.stringify({ observations: [{ date: "2026-10-20", value: "1.1601" }, { date: "2026-10-21", value: "." }, { date: "2026-10-22", value: "1.1612" }] }));
  return new Response("", { status: 404 });
};
const env = { TWELVEDATA_KEY: "TDKEY", FINNHUB_KEY: FH_KEY, ALPHAVANTAGE_KEY: AV_KEY, ALPACA_KEY_ID: "A", ALPACA_SECRET_KEY: "B", FRED_KEY: "F" };
const pending = [], ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, e = env) => { const res = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), e, ctx); await Promise.all(pending.splice(0)); const text = await res.text(); return { res, text, body: JSON.parse(text) }; };

// Twelve Data out of credits → CNBC
let r = await call("/api/quote?symbols=AAPL,EUR/USD,BTC/USD");
const a = r.body.quotes.AAPL;
ok("Twelve Data out of credits → CNBC for a U.S. stock, FX and crypto, each LIVE and labelled: backup for Twelve Data (daily_limit)", r.res.status === 200 && a.source === "cnbc" && a.backupFor === "twelvedata" && a.primaryError === "daily_limit" && a.fields.price.value === 250 && r.body.quotes["EUR/USD"].fields.price.value === 1.16 && r.body.quotes["BTC/USD"].fields.price.value === 90000 && r.body.meta.backups === 3, r.text.slice(0, 400));
// CNBC down too → Finnhub (U.S. stocks), Alpha Vantage (FX)
store = new Map(); down = new Set(["quote.cnbc.com"]); asked = [];
r = await call("/api/quote?symbols=AAPL,EUR/USD");
ok("…CNBC down too → Finnhub for the U.S. stock, Alpha Vantage for the FX pair; labelled", r.body.quotes.AAPL.source === "finnhub" && r.body.quotes.AAPL.backupFor === "twelvedata" && r.body.quotes.AAPL.fields.price.value === 251 && r.body.quotes["EUR/USD"].source === "alphavantage" && r.body.quotes["EUR/USD"].fields.price.value === 1.161, r.text.slice(0, 400));
ok("…the keys never in the answer", !r.text.includes(AV_KEY) && !r.text.includes(FH_KEY) && !r.text.includes("TDKEY"));
store = new Map(); down = new Set(["quote.cnbc.com", "finnhub.io"]);
r = await call("/api/quote?symbols=AAPL");
ok("…Finnhub down too → Alpha Vantage (the last session's price, date only)", r.body.quotes.AAPL.source === "alphavantage" && r.body.quotes.AAPL.dateOnly === "2026-10-21" && r.body.quotes.AAPL.fields.price.value === 251.1);
store = new Map(); down = new Set(["quote.cnbc.com", "finnhub.io", "www.alphavantage.co"]);
r = await call("/api/quote?symbols=AAPL");
ok("…every backup down, nothing cached → N/A with Twelve Data's error and what was tried, never a value made up", !r.body.quotes.AAPL && r.body.errors.AAPL.error === "daily_limit" && /CNBC: .*Finnhub: .*Alpha Vantage: /.test(r.body.errors.AAPL.detail) && !r.text.includes(AV_KEY), r.text);
r = await call("/api/quote?symbols=AAPL", { TWELVEDATA_KEY: "TDKEY" });
ok("…a backup without its key is skipped (not configured), said", /Finnhub: not_configured · Alpha Vantage: not_configured/.test(r.body.errors.AAPL.detail));
down = new Set(); store = new Map();
r = await call("/api/quote?symbols=ZZZZ1");
ok("an invalid symbol is never sent to a backup", r.body.errors.ZZZZ1 && !Object.keys(r.body.quotes).length);

// Alpha Vantage's 25 a day, counted
store = new Map(); let n = 0;
for (let i = 0; i < AV_DAILY_MAX + 2; i++) { const q = await avQuote(env, "AAPL", { origin: "https://alessandrozanichelli.com", ctx, now: Date.parse("2026-10-22T12:00:00Z") }); await Promise.all(pending.splice(0)); if (q.rec) n++; else if (q.err === "daily_limit") break; }
ok("Alpha Vantage: 25 requests a day, then daily_limit without asking", n === AV_DAILY_MAX);

// history: Twelve Data out of credits → CNBC bars; CNBC down → Alpaca; then Alpha Vantage
store = new Map(); down = new Set();
r = await call("/api/history?symbol=AAPL&range=1M");
ok("chart history: Twelve Data out of credits → CNBC's bars, labelled backup (daily_limit)", r.res.status === 200 && r.body.source === "cnbc" && r.body.backupFor === "twelvedata" && r.body.primaryError === "daily_limit" && r.body.points.length > 10, r.text.slice(0, 300));
store = new Map(); down = new Set(["ts-api.cnbc.com"]);
r = await call("/api/history?symbol=AAPL&range=1M");
ok("…CNBC's bars down → Alpaca's daily bars (U.S.), labelled", r.res.status === 200 && r.body.source === "alpaca" && r.body.backupFor === "twelvedata" && r.body.points.at(-1).c === 231, r.text.slice(0, 300));
store = new Map(); down = new Set(["ts-api.cnbc.com", "data.alpaca.markets"]);
r = await call("/api/history?symbol=AAPL&range=1M");
ok("…Alpaca down too → Alpha Vantage (the last 100 sessions, said)", r.res.status === 200 && r.body.source === "alphavantage" && /last 100 sessions/.test(r.body.note), r.text.slice(0, 300));
store = new Map(); down = new Set(["ts-api.cnbc.com", "data.alpaca.markets", "www.alphavantage.co"]);
r = await call("/api/history?symbol=AAPL&range=1M");
ok("…all down → N/A, what was tried said", r.res.status === 429 && r.body.error === "daily_limit" && /no backup answered \(CNBC, Alpaca: .*Alpha Vantage: /.test(r.body.detail), r.text);

// CNBC's daily bars (PLAB, EFC, FACT) backed by FRED and Alpaca
store = new Map(); down = new Set(["ts-api.cnbc.com"]);
const now = Date.parse("2026-10-22T12:00:00Z");
let d = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "EUR=", 400, now, { env });
ok("CNBC bars down → EUR= from FRED (DEXUSEU, USD per euro; days without a rate left out), labelled", d.data && d.data.length === 2 && d.data[1][1] === 1.1612 && d.source === "FRED DEXUSEU" && d.backupFor === "CNBC", JSON.stringify(d));
d = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "NVDA", 400, now, { env });
ok("…a U.S. symbol from Alpaca", d.data && d.data[1][1] === 231 && d.source === "Alpaca");
d = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "EUNL-DE", 400, now, { env });
ok("…a Xetra line (VWCE-DE, EUNL-DE …) from Alpha Vantage (EUNL.DEX, the last 100 sessions), labelled", d.data && d.data.length >= 1 && d.source === "Alpha Vantage (last 100 sessions)" && d.backupFor === "CNBC" && d.primaryError, JSON.stringify(d).slice(0, 300));
ok("CNBC code → Alpha Vantage id: Xetra, London, Toronto; Milan / Paris none", avIdOfCnbc("VWCE-DE") === "VWCE:XETR" && avIdOfCnbc("VOD-GB") === "VOD:XLON" && avIdOfCnbc("RY-CA") === "RY:XTSE" && avIdOfCnbc("ISP-IT") === null && avIdOfCnbc("MC-FR") === null && avIdOfCnbc("EUR=") === null);
store = new Map(); down = new Set(["ts-api.cnbc.com", "www.alphavantage.co"]);
d = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "SXR8-DE", 400, now, { env });
ok("…no kept copy and every backup down: CNBC's error stays (N/A upstream)", !d.data && d.err && d.backupErr, JSON.stringify(d));
ok("backupDaily: CHF= is DEXSZUS, JPY= DEXJPUS; GBP= DEXUSUK", (await backupDaily("CHF=", 30, now, env)).source === "FRED DEXSZUS" && (await backupDaily("GBP=", 30, now, env)).source === "FRED DEXUSUK");
store = new Map(); down = new Set();
d = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "EUNL-DE", 400, now, { env });
ok("…CNBC answering: CNBC, no backup asked", d.data && !d.backupFor);

// the last real copy kept in KV: written once a day when CNBC answers, served STALE (with its date) when CNBC refuses
const kv = new Map(), kvPuts = [];
const envK = { ...env, BRIEFS: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); kvPuts.push(k); } } };
store = new Map(); down = new Set();
d = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "VWCE-DE", 1900, now, { env: envK });
await Promise.all(pending.splice(0));
const d2 = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "VWCE-DE", 1900, now, { env: envK });
await Promise.all(pending.splice(0));
ok("kept copy: written when CNBC answers, once a day (not again on the next request)", d.data && !d.backupFor && kvPuts.filter((k) => k === "last/d1900/VWCE-DE").length === 1 && (await keptCopy("d1900", "VWCE-DE", envK)).data.length === d.data.length, kvPuts.join());
store = new Map(); down = new Set(["ts-api.cnbc.com"]);
d = await cnbcDailyB("https://alessandrozanichelli.com", ctx, "VWCE-DE", 1900, now, { env: envK });
ok("…CNBC refusing: the kept copy, STALE, its date and CNBC's error said — before Alpha Vantage's 100 sessions", d.data && d.cache === "STALE" && d.kept && /last copy kept \d{4}-\d{2}-\d{2}/.test(d.source) && d.backupFor === "CNBC" && d.primaryError && d.data.length === d2.data.length, JSON.stringify(d).slice(0, 300));
const scheduled = { ...ctx, store: { get: async () => null, put: async () => {} } };
kvPuts.length = 0; store = new Map(); down = new Set();
await cnbcDailyB("https://alessandrozanichelli.com", scheduled, "EUNL-DE", 1900, now, { env: envK });
ok("…never written by a scheduled run (KV writes are counted)", kvPuts.length === 0, kvPuts.join());

// chart history of a Xetra listing: CNBC refusing → the kept copy of that chart, else Alpha Vantage
store = new Map(); down = new Set(); kv.clear();
r = await call("/api/history?symbol=VWCE:XETR&range=6M", envK);
await Promise.all(pending.splice(0));
ok("chart history of VWCE:XETR from CNBC's bars; a copy of the chart kept", r.res.status === 200 && r.body.source === "cnbc" && kv.has("last/h/6M/1day/VWCE-DE"), r.text.slice(0, 300) + " " + [...kv.keys()].join());
store = new Map(); down = new Set(["ts-api.cnbc.com"]);
r = await call("/api/history?symbol=VWCE:XETR&range=6M", envK);
ok("…CNBC refusing: the kept chart, STALE with its date and the reason — not N/A", r.res.status === 200 && r.body.status === "STALE" && r.body.staleReason && /kept copy/.test(r.body.note) && r.body.points.length > 10, r.text.slice(0, 400));
store = new Map(); kv.clear();
r = await call("/api/history?symbol=C:VWCE-DE&range=6M", envK);
ok("…nothing kept (a CNBC listing typed as C:VWCE-DE): Alpha Vantage's daily bars (VWCE.DEX), labelled backup for CNBC", r.res.status === 200 && r.body.source === "alphavantage" && r.body.backupFor === "cnbc" && r.body.primaryError && r.body.symbol === "C:VWCE-DE", r.text.slice(0, 400));

// CNBC's pause after a refusal: one request a minute goes through; an answer lifts the pause
store = new Map();
const O = "https://alessandrozanichelli.com";
await noteBarsRefused(O, "provider_forbidden", ctx); await Promise.all(pending.splice(0));
const b1 = await barsBlocked(O, ctx); await Promise.all(pending.splice(0));
const b2 = await barsBlocked(O, ctx); await Promise.all(pending.splice(0));
ok("pause: just refused → paused; after a minute one request is let through (a probe), the next one paused again", b1 && b1.err === "provider_forbidden" && !await (async () => { const real = Date.now; Date.now = () => real() + 61_000; const x = await barsBlocked(O, ctx); Date.now = real; return x; })() && !!b2);
await noteBarsOk(O, ctx); await Promise.all(pending.splice(0));
ok("…an answer lifts it", !(await barsBlocked(O, ctx)));
// headers and bursts
store = new Map(); down = new Set();
await cnbcDaily(O, ctx, "SAP-DE", 400, now);
const hh = sentHeaders["ts-api.cnbc.com"] || {};
ok("CNBC's services get a cnbc.com page's headers (a browser's user agent, origin, referer); other providers keep the terminal's own", /Mozilla\/5\.0/.test(hh["user-agent"]) && hh.origin === "https://www.cnbc.com" && hh.referer === "https://www.cnbc.com/" && siteHeaders("https://quote.cnbc.com/x") && !siteHeaders("https://api.stlouisfed.org/x"), JSON.stringify(hh));
let live = 0, peak = 0;
const lim = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (x) => { live++; peak = Math.max(peak, live); await new Promise((res) => setTimeout(res, 5)); live--; return x * 2; });
store = new Map(); down = new Set();
r = await call("/api/status?test=alphavantage");
ok("SYS check of Alpha Vantage: one quote and one daily series of VWCE.DEX, what came back — never the key", r.res.status === 200 && r.body.configured && r.body.quote.ok && r.body.daily.ok && r.body.daily.sessions >= 1 && !r.text.includes(AV_KEY) && !/apikey/i.test(r.text), r.text);
r = await call("/api/status?test=alphavantage", { ...env, ALPHAVANTAGE_KEY: undefined });
ok("…without the key: not configured, said", r.body.configured === false && r.body.quote.error === "not_configured" && r.body.daily.error === "not_configured");
ok("bar requests of one page request: 4 at a time, results in order", peak === 4 && lim.join() === "2,4,6,8,10,12,14,16,18,20");

// ---------- sections ----------
// world exchanges: Twelve Data's market_state not answering → each market's main index on CNBC
const nowX = Date.parse("2026-10-22T13:00:00Z");
const qx = { ".SPX": { session: "REG_MKT", time: nowX - 60_000 }, ".FTSE": { session: "REG_MKT", time: nowX - 120_000 }, ".N225": { session: "POST_MKT", time: nowX - 6 * 3600_000 }, ".GDAXI": { session: "REG_MKT", time: nowX - 2 * 3600_000 } };
const st = stateFromIndices(qx, nowX), byC = (c) => st.find((e) => e.code === c);
ok("exchanges backup: open when the main index is in its regular session and printed in the last 30 minutes; no countdown", byC("XNYS").open && byC("XNAS").open && byC("XLON").open && !byC("XJPX").open && !byC("XETR").open && byC("XNYS").opensAt === null && byC("XLON").via === ".FTSE" && !byC("XMIL"));
const jsonR = (b, H, st2 = 200) => new Response(JSON.stringify(b), { status: st2, headers: { "content-type": "application/json" } });
store = new Map();
let rx = await handleExchanges(new URL("https://alessandrozanichelli.com/api/exchanges"), {}, ctx, {}, jsonR, { loadQuotes: async () => ({ data: qx }), now: nowX });
let jx = await rx.json();
ok("…served as LIVE, labelled BACKUP with Twelve Data's error (no key here)", jx.status === "LIVE" && jx.backupFor === "twelvedata" && jx.primaryError === "server_not_configured" && /BACKUP/.test(jx.source) && jx.majorOpen >= 3, JSON.stringify(jx).slice(0, 300));
// world calendar: Forex Factory not answering, no archived copy → the Nasdaq economic calendar of the week
const nqRows = [{ date: "2026-10-22", time: "12:30", at: "2026-10-22T12:30:00.000Z", country: "United States", event: "Initial Jobless Claims", actual: "230K", consensus: "225K", previous: "228K" }, { date: "2026-10-22", time: "08:00", at: "2026-10-22T08:00:00.000Z", country: "Germany", event: "Ifo Business Climate", actual: null, consensus: "87.5", previous: "87.1" }, { date: "2026-10-22", time: "02:00", at: "2026-10-22T02:00:00.000Z", country: "Poland", event: "Retail Sales", actual: "1%", consensus: null, previous: null }];
const ev = nqWorldEvents(nqRows, nowX);
ok("calendar backup: Nasdaq rows of the Forex Factory currencies (Germany → EUR, named); actual / consensus / previous; impact N/A", ev.length === 2 && ev[0].currency === "EUR" && ev[0].region === "Germany" && ev[0].impact === null && ev[1].actual.value === "230K" && ev[1].forecast.value === "225K" && ev[0].source === "NQ");
let rc = await handleCalendar(new URL("https://alessandrozanichelli.com/api/calendar"), { BRIEFS: { get: async () => null } }, ctx, {}, jsonR, { world: async () => ({ err: "provider_forbidden", events: [] }), calDay: async (o, c, d) => ({ data: d === "2026-10-22" ? nqRows : [] }) });
let jc = await rc.json();
ok("…served with its source (backup for Forex Factory: its error) and said in the answer", jc.worldBackup && jc.worldBackup.kind === "nasdaq" && jc.worldBackup.primaryError === "provider_forbidden" && jc.sources[0].id === "NQ" && jc.world.length === 2 && /rates no importance/.test(jc.fields.impact), JSON.stringify(jc).slice(0, 400));
const archived = [{ title: "CPI m/m", country: "USD", date: "2026-10-22T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" }];
rc = await handleCalendar(new URL("https://alessandrozanichelli.com/api/calendar"), {}, ctx, {}, jsonR, { world: async () => ({ err: "provider_forbidden", events: [] }), archived: async () => ({ raw: archived, at: nowX - 3600_000, week: "2026-10-18" }) });
jc = await rc.json();
ok("…an archived copy of this week's export first (STALE, its time)", jc.worldBackup.kind === "archive" && jc.sources[0].status === "STALE" && jc.world[0].impact === "High");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
