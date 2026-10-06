// T05 — symbol discovery + venue-specific quotes/history (Worker side).
// Provider responses below are test fixtures with the provider's real response shape
// (copied from live /symbol_search answers, trimmed). Mocked fetch + cache.
//   node test/search.test.mjs
import { app as worker,  mapProviderError, buildHistoryQuery, buildInstrument, normalizeQuote, __resetForTests } from "../src/worker.mjs";
import { normalizeSearch, instrumentId, splitId } from "../src/search.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

const row = (symbol, name, exchange, mic, type, country, currency, plan) => ({ symbol, instrument_name: name, exchange, mic_code: mic, exchange_timezone: "UTC", instrument_type: type, country, currency, access: plan ? { global: plan, plan, plan_business: plan } : undefined });
const SEARCH = {
  microsoft: [
    row("MSETNQ", "Leverage Shares Microsoft ETP", "JSE", "XJSE", "ETF", "South Africa", "ZAc", "Pro"),
    row("SMSF", "Leverage Shares -1x Short Microsoft ETP", "LSE", "XLON", "ETF", "United Kingdom", "GBp", "Grow"),
    row("4MSFT", "Microsoft Corporation", "MTA", "XMIL", "Common Stock", "Italy", "EUR", "Pro"),
    row("MSFT", "Microsoft Corp.", "BCBA", "XBUE", "Depositary Receipt", "Argentina", "ARS", "Pro"),
    row("MSFT", "Microsoft Corporation Common Stock", "NASDAQ", "XNGS", "Common Stock", "United States", "USD", "Basic"),
    row("MSFT", "Microsoft Corporation Common Stock", "IEX", "IEXG", "Common Stock", "United States", "USD", "Basic"),
  ],
  nvidia: [
    row("4NVDA", "NVIDIA Corporation", "MTA", "XMIL", "Common Stock", "Italy", "EUR", "Pro"),
    row("FD0DLR", "Vontobel Call Warrant on NVIDIA", "EuroTLX", "XMIL", "Warrant", "Italy", "EUR", "Pro"),
    row("11090", "UBS Warrant on NVIDIA", "HKEX", "XHKG", "Warrant", "Hong Kong", "HKD", "Pro"),
    row("NVDA", "NVIDIA Corporation", "NASDAQ", "XNGS", "Common Stock", "United States", "USD", "Basic"),
  ],
  roche: [
    row("ROCH", "Roche Holding Ltd.", "NEO", "NEOE", "Depositary Receipt", "Canada", "CAD", "Grow"),
    row("ROP", "Roche Holding AG", "SIX", "XSWX", "Common Stock", "Switzerland", "CHF", "Pro"),
    row("RO", "Roche Holding AG", "SIX", "XSWX", "Common Stock", "Switzerland", "CHF", "Pro"),
    row("RHHBY", "Roche Holding AG", "OTC", "OTCQ", "American Depositary Receipt", "United States", "USD", "Basic"),
  ],
  "eur/usd": [
    row("EUR/USD", "Euro / US Dollar", undefined, "PHYSICAL_CURRENCY", "Physical Currency", undefined, undefined, "Basic"),
    row("F93636", "Bank Vontobel Put Warrant", "EuroTLX", "XMIL", "Warrant", "Italy", "EUR", "Pro"),
  ],
};

// ---------- pure functions ----------
ok("id: US listing → plain ticker", instrumentId(row("AAPL", "Apple Inc.", "NASDAQ", "XNGS", "Common Stock", "United States", "USD")) === "AAPL");
ok("id: other venues → SYMBOL:MIC", instrumentId(row("NOVN", "Novartis AG", "SIX", "XSWX", "Common Stock", "Switzerland", "CHF")) === "NOVN:XSWX");
ok("id: FX / crypto / metal → plain pair", instrumentId(SEARCH["eur/usd"][0]) === "EUR/USD" && instrumentId(row("BTC/USD", "Bitcoin US Dollar", undefined, "DIGITAL_CURRENCY", "Digital Currency")) === "BTC/USD" && instrumentId(row("XAU/USD", "Gold Spot", undefined, "COMMODITY", "Precious Metal")) === "XAU/USD");
ok("splitId", JSON.stringify(splitId("NOVN:XSWX")) === '{"symbol":"NOVN","mic":"XSWX"}' && splitId("EUR/USD").mic === null && splitId("AAPL").mic === null && splitId("7203:XJPX").symbol === "7203");

const ms = normalizeSearch({ data: SEARCH.microsoft }, "Microsoft");
ok("rank: 'Microsoft' → MSFT (Nasdaq) first although the provider listed it 5th", ms[0].id === "MSFT" && ms[0].quotable === true, ms.map((x) => x.id).join());
ok("dedupe: MSFT on Nasdaq and on IEX = one US instrument", ms.filter((x) => x.id === "MSFT").length === 1 && ms.find((x) => x.id === "MSFT").mic === "XNGS");
ok("other venues kept with their MIC", ms.some((x) => x.id === "4MSFT:XMIL") && ms.some((x) => x.id === "MSFT:XBUE"));
const nv = normalizeSearch({ data: SEARCH.nvidia }, "NVIDIA");
ok("rank: 'NVIDIA' → NVDA first, warrants last", nv[0].id === "NVDA" && /Warrant/.test(nv.at(-1).type) && /Warrant/.test(nv.at(-2).type), nv.map((x) => x.id).join());
const ro = normalizeSearch({ data: SEARCH.roche }, "Roche");
ok("'Roche': SIX listings found, flagged as needing the Pro plan", ro.filter((x) => x.mic === "XSWX").every((x) => x.planRequired === "Pro" && x.quotable === false) && ro.some((x) => x.id === "RO:XSWX"));
ok("'Roche': SIX listings first, then the US ADR the current plan can quote", ro[0].mic === "XSWX" && ro[1].mic === "XSWX" && ro[2].id === "RHHBY" && ro[2].quotable === true, ro.map((x) => x.id).join());
ok("result fields: id, symbol, name, exchange, mic, country, currency, type, plan", ["id", "symbol", "name", "exchange", "mic", "country", "currency", "type", "planRequired", "quotable"].every((k) => k in ro[0]));
const ro2 = normalizeSearch({ data: [row("RCCB", "Rochester New York Community Baseball Inc.", "OTC", "OTCM", "Common Stock", "United States", "USD", "Basic"), row("RHHBF", "Roche Holding AG", "OTC", "PINX", "Common Stock", "United States", "USD", "Basic"), ...SEARCH.roche] }, "Roche");
ok("'Roche' matches the word, not 'Rochester'", ro2.at(-1).id === "RCCB" || ro2.findIndex((x) => x.id === "RCCB") > ro2.findIndex((x) => x.id === "RHHBF"), ro2.map((x) => x.id).join());
ok("regulated exchange listing ranked before the OTC line of the same company", ro2.findIndex((x) => x.id === "RO:XSWX") < ro2.findIndex((x) => x.id === "RHHBF"), ro2.map((x) => x.id).join());
ok("accents folded: 'Nestle' finds 'Nestlé S.A.' by name", normalizeSearch({ data: [row("NSRGY", "Nestlé S.A. ADR", "OTC", "OTCQ", "American Depositary Receipt", "United States", "USD", "Basic"), row("NESN", "Nestlé S.A.", "SIX", "XSWX", "Common Stock", "Switzerland", "CHF", "Pro"), row("NEST", "Some Nest Fund", "NYSE", "XNYS", "ETF", "United States", "USD", "Basic")] }, "Nestle")[0].id === "NESN:XSWX");
const fx = normalizeSearch({ data: SEARCH["eur/usd"] }, "EUR/USD");
ok("'EUR/USD' → the currency pair first, no venue", fx[0].id === "EUR/USD" && fx[0].mic === null && fx[0].quotable === true);
ok("no plan info → quotable unknown (null), not assumed", normalizeSearch({ data: [row("X", "X Corp", "NYSE", "XNYS", "Common Stock", "United States", "USD")] }, "X")[0].quotable === null);
ok("empty / malformed provider data → no results", normalizeSearch({}, "x").length === 0 && normalizeSearch(null, "x").length === 0);

// ---------- provider error mapping ----------
ok("plan error → plan_required", mapProviderError({ code: 403, message: "NOVN is available starting with the Pro plan. Consider upgrading your API key." }).error === "plan_required");
ok("plan error with code 404 → plan_required", mapProviderError({ code: 404, message: "This symbol is not available with your plan" }).error === "plan_required");
ok("per-minute limit (mentions 'plan') stays rate_limited", mapProviderError({ code: 429, message: "You have run out of API credits for the current minute. Consider switching to a higher tier plan." }).error === "rate_limited");
ok("bad key stays provider_auth", mapProviderError({ code: 401, message: "apikey parameter is incorrect. Get a key on the pricing plan page" }).error === "provider_auth");
ok("unknown symbol stays symbol_not_found", mapProviderError({ code: 404, message: "symbol not found" }).error === "symbol_not_found");

// ---------- history query for a venue id ----------
const hq = buildHistoryQuery({ symbol: "NOVN:XSWX", range: "6M" }, new Date("2026-10-06T12:00:00Z"));
ok("history: SYMBOL:MIC → symbol + mic_code sent to the provider", hq.q.symbol === "NOVN" && hq.q.mic_code === "XSWX" && hq.id === "NOVN:XSWX");
ok("history: plain id → no mic_code", !("mic_code" in buildHistoryQuery({ symbol: "AAPL", range: "6M" }).q));

// ---------- field notes by market ----------
const base = { close: "100", previous_close: "99", open: "99", high: "101", low: "98", volume: "1000", is_market_open: true, last_quote_at: 1791300000 };
const us = buildInstrument(normalizeQuote("AAPL", { ...base, currency: "USD", exchange: "NASDAQ", mic_code: "XNGS" }), { fetchedAt: Date.now() });
const ch = buildInstrument(normalizeQuote("NOVN:XSWX", { ...base, currency: "CHF", exchange: "SIX", mic_code: "XSWX" }), { fetchedAt: Date.now() });
const eur = buildInstrument(normalizeQuote("EUR/USD", { ...base, volume: "" }), { fetchedAt: Date.now() });
ok("US equity: open/high/low/volume PARTIAL with the venue-subset note", ["open", "high", "low", "volume"].every((k) => us.fields[k].status === "PARTIAL" && /5%/.test(us.fields[k].note)));
ok("non-US listing: no US venue claim; provider values labelled as such", ["open", "high", "low", "volume"].every((k) => ch.fields[k].status === "LIVE" && !/5%/.test(ch.fields[k].note)) && ch.currency === "CHF" && ch.mic === "XSWX");
ok("FX: no US venue claim", ["open", "high", "low"].every((k) => !/5%/.test(eur.fields[k].note || "")) && eur.fields.volume.status === "N/A");
ok("currency is never assumed (missing → null, not USD)", normalizeQuote("X", { close: "1" }).currency === null);

// ---------- /api/search through the Worker ----------
const KEY = "TESTKEY_never_returned";
const env = { TWELVEDATA_KEY: KEY, ALLOWED_ORIGIN: "https://alessandrozanichelli.com" };
const ctx = { waitUntil: () => {} };
let urls = [], auths = [], mode = "ok";
const PLAN_ERR = { code: 403, message: "NOVN is available starting with the Pro plan. Consider upgrading.", status: "error" };
globalThis.fetch = async (u, opts = {}) => {
  urls.push(String(u)); const url = new URL(u);
  const auth = (opts.headers && (opts.headers.authorization || opts.headers.Authorization)) || null;
  auths.push(auth);
  if (url.pathname === "/symbol_search") {
    if (mode === "keyless-refused" && !auth) return new Response(JSON.stringify({ code: 429, message: "too many requests", status: "error" }));
    if (mode === "down") return new Response("", { status: 500 });
    return new Response(JSON.stringify({ data: SEARCH[url.searchParams.get("symbol").toLowerCase()] || [], status: "ok" }));
  }
  if (url.pathname === "/quote") {
    const s = url.searchParams.get("symbol"), mic = url.searchParams.get("mic_code");
    if (mic) return new Response(JSON.stringify(PLAN_ERR));
    const one = (x) => ({ symbol: x, name: x + " Inc", exchange: "NASDAQ", mic_code: "XNGS", currency: "USD", ...base });
    const list = s.split(",");
    return new Response(JSON.stringify(list.length === 1 ? one(list[0]) : Object.fromEntries(list.map((x) => [x, one(x)]))));
  }
  if (url.pathname === "/time_series") return new Response(JSON.stringify(url.searchParams.get("mic_code") ? PLAN_ERR : { meta: {}, values: [{ datetime: "2026-10-05", close: "1" }], status: "ok" }));
  return new Response("", { status: 404 });
};
const call = async (path) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const t = await r.text(); return { status: r.status, xc: r.headers.get("x-cache"), text: t, j: JSON.parse(t) }; };

let r = await call("/api/search?q=Microsoft");
ok("search: 200 LIVE, results ranked, source + fetchedAt", r.status === 200 && r.j.status === "LIVE" && r.j.results[0].id === "MSFT" && r.j.source === "Twelve Data symbol_search" && !!r.j.fetchedAt && r.j.count === r.j.results.length);
ok("search: plan of the key and count of quotable listings reported", r.j.plan === "Basic" && r.j.quotable === r.j.results.filter((x) => x.quotable).length);
ok("search: keyless provider call first (no credit spent)", urls.length === 1 && !urls[0].includes("apikey") && auths[0] === null && r.j.credits === 0);
ok("search: metadata only — no price fields", !/"(price|close|open|volume)"/.test(r.text));
urls = [];
r = await call("/api/search?q=microsoft");
ok("search: cached 24 h per query (case-insensitive) — no provider call", r.xc === "HIT" && urls.length === 0);
mode = "keyless-refused"; urls = []; auths = []; store = new Map();
r = await call("/api/search?q=NVIDIA");
ok("search: keyless refused → one retry with the server key (header), reported as 1 credit", r.status === 200 && urls.length === 2 && auths[1] === `apikey ${KEY}` && r.j.credits === 1 && r.j.results[0].id === "NVDA");
ok("search: the key is never in the response", !r.text.includes(KEY));
mode = "down"; store = new Map();
r = await call("/api/search?q=Roche");
ok("search: provider down → N/A error, no results invented", r.status === 502 && r.j.status === "N/A" && r.j.results.length === 0 && !!r.j.error);
mode = "ok";
r = await call("/api/search?q=" + encodeURIComponent("<script>"));
ok("search: invalid query refused (400)", r.status === 400);
r = await call("/api/search?q=");
ok("search: empty query refused (400)", r.status === 400);

// ---------- quotes: plain batch + venue ids ----------
__resetForTests(); urls = []; auths = []; store = new Map();
r = await call("/api/quote?symbols=AAPL,MSFT,NOVN:XSWX");
const qUrls = urls.filter((u) => u.includes("/quote"));
ok("quote: plain ids in one batched call, venue id in its own call with mic_code", qUrls.length === 2 && qUrls.some((u) => /symbol=AAPL%2CMSFT$/.test(u)) && qUrls.some((u) => /symbol=NOVN&mic_code=XSWX/.test(u)), qUrls.map((u) => u.replace(KEY, "***")).join(" "));
ok("quote: listing outside the plan → plan_required N/A, others LIVE", r.status === 200 && r.j.errors["NOVN:XSWX"].error === "plan_required" && r.j.errors["NOVN:XSWX"].status === "N/A" && r.j.quotes.AAPL.status === "LIVE" && !r.j.quotes["NOVN:XSWX"]);
r = await call("/api/quote?symbols=NOVN:XSWX");
ok("quote: only a plan-blocked listing → HTTP 403", r.status === 403 && r.j.errors["NOVN:XSWX"].error === "plan_required");
ok("quote: key never in the response", !r.text.includes(KEY));
ok("quote: the provider's reason is passed on, shortened, without links", /available starting with the Pro plan/.test(r.j.errors["NOVN:XSWX"].detail) && !/https?:/.test(r.j.errors["NOVN:XSWX"].detail));
const { providerDetail } = await import("../src/worker.mjs");
ok("providerDetail strips the key, links and apikey text", providerDetail({ message: `bad **apikey**=${KEY} see https://twelvedata.com/pricing` }, KEY) === "bad see");
r = await call("/api/history?symbol=NOVN:XSWX&range=6M");
ok("history: venue id outside the plan → 403 plan_required N/A", r.status === 403 && r.j.error === "plan_required" && r.j.symbol === "NOVN:XSWX" && r.j.status === "N/A");
r = await call("/api/history?symbol=AAPL&range=6M");
ok("history: plain id unchanged", r.status === 200 && r.j.symbol === "AAPL");

ok("key never in any provider URL; sent only as 'Authorization: apikey …' header", urls.length >= 4 && !urls.some((u) => u.includes(KEY) || /apikey/i.test(u)) && auths.filter(Boolean).every((a) => a === `apikey ${KEY}`) && auths.filter((a, i) => /\/(quote|time_series)/.test(urls[i])).every((a) => a === `apikey ${KEY}`));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
