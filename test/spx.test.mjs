// T06 — S&P 500 heat map data (Worker side). Provider responses are test fixtures in the providers'
// real formats (iShares holdings CSV, Alpaca bars / latest trades); fetch and cache mocked.
//   node test/spx.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseHoldings, refTarget, livePhase, todayBarFinal, barDate } from "../src/spx.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

// ---------- iShares holdings file (real layout: preamble, header, equity + cash/futures rows, footer) ----------
const HEAD = `iShares Core S&P 500 ETF
Fund Holdings as of,"Oct 05, 2026"
Inception Date,"May 15, 2000"
Shares Outstanding,"1,152,900,000.00"
Stock,"-"
Bond,"-"
Cash,"-"
Other,"-"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date
`;
const row = (t, n, s, a, w) => `"${t}","${n}","${s}","${a}","1,000,000.00","${w}","1,000,000.00","1,000.00","100.00","United States","NASDAQ","USD","1.00","USD","-"`;
function holdings(n = 420) {
  const rows = [row("NVDA", "NVIDIA", "Information Technology", "Equity", "8.62"), row("AAPL", "APPLE", "Information Technology", "Equity", "7.24"),
    row("BRK B", "BERKSHIRE HATHAWAY INC CLASS B", "Financials", "Equity", "1.60"), row("BF B", "BROWN FORMAN CLASS B", "Consumer Staples", "Equity", "0.01"),
    row("XTSLA", "BLK CSH FND TREASURY SL AGENCY", "Cash and/or Derivatives", "Money Market", "0.20"), row("ESZ6", "S&P500 EMINI DEC 26", "Cash and/or Derivatives", "Futures", "0.00"),
    row("USD", "USD CASH", "Cash and/or Derivatives", "Cash", "-0.02")];
  for (let i = 0; rows.length < n; i++) rows.push(row(`T${i}`, `COMPANY ${i}`, i % 2 ? "Industrials" : "Health Care", "Equity", "0.10"));
  return HEAD + rows.join("\n") + `\n \n"The content contained herein is owned or licensed by BlackRock and/or its third-party information providers."\n`;
}
const p = parseHoldings(holdings());
ok("holdings: date parsed from 'Fund Holdings as of'", p.asOf === "2026-10-05");
ok("holdings: equities only (cash, money market, futures excluded)", !p.items.some((x) => ["XTSLA", "ESZ6", "USD"].includes(x.sym)) && p.items.length === 420 - 3);
ok("holdings: share-class tickers mapped to provider symbols (BRK B → BRK.B, BF B → BF.B)", p.items.some((x) => x.sym === "BRK.B") && p.items.some((x) => x.sym === "BF.B"));
ok("holdings: sector and weight kept as published", p.items[0].sym === "NVDA" && p.items[0].sector === "Information Technology" && p.items[0].weight === 8.62);
ok("holdings: garbage → no items", parseHoldings("<html>blocked</html>").items.length === 0 && parseHoldings("").items.length === 0);

// ---------- reference dates ----------
ok("ref dates: 1W, 1M, 3M, 6M, YTD, 1Y", refTarget("1W", "2026-10-06") === "2026-09-29" && refTarget("1M", "2026-10-06") === "2026-09-06" && refTarget("3M", "2026-10-06") === "2026-07-06" && refTarget("6M", "2026-10-06") === "2026-04-06" && refTarget("YTD", "2026-10-06") === "2025-12-31" && refTarget("1Y", "2026-10-06") === "2025-10-06");
ok("ref dates: month end clamps (31 Mar − 1M → 28 Feb)", refTarget("1M", "2026-03-31") === "2026-02-28");
ok("bar date = session date of the midnight-ET timestamp", barDate("2026-10-05T04:00:00Z") === "2026-10-05" && barDate("2026-01-05T05:00:00Z") === "2026-01-05");

// ---------- live phase ----------
const at = (iso) => Date.parse(iso);
const fresh = (now) => Object.fromEntries(["A", "B", "C"].map((s) => [s, [100, new Date(now - 30_000).toISOString()]]));
let now = at("2026-10-06T15:00:00Z"); // 11:00 ET Tuesday
ok("live during the session with recent trades", livePhase(fresh(now), now).live === true);
ok("not live when trades are old (holiday)", livePhase(Object.fromEntries(["A", "B"].map((s) => [s, [1, new Date(now - 18 * 3600_000).toISOString()]])), now).live === false);
now = at("2026-10-06T12:00:00Z"); // 08:00 ET
ok("not live before the open", livePhase(fresh(now), now).live === false);
now = at("2026-10-10T15:00:00Z"); // Saturday
ok("not live on Saturday", livePhase(fresh(now), now).live === false);
ok("today's daily bar final only after 16:30 ET", todayBarFinal(at("2026-10-06T19:00:00Z")) === false && todayBarFinal(at("2026-10-06T20:45:00Z")) === true);

// ---------- handlers through the Worker app ----------
const KEYID = "ALPACA_TEST_ID_never_returned", SECRET = "ALPACA_TEST_SECRET_never_returned";
const env = { ALPACA_KEY_ID: KEYID, ALPACA_SECRET_KEY: SECRET, ALLOWED_ORIGIN: "https://alessandrozanichelli.com" };
const ctx = { waitUntil: () => {} };
let calls = [], mode = "ok";
const bar = (d, c) => ({ t: `${d}T04:00:00Z`, o: c, h: c, l: c, c, v: 1000, n: 10, vw: c });
globalThis.fetch = async (u, opts = {}) => {
  const url = new URL(u); calls.push({ url: String(u), headers: opts.headers || {} });
  if (url.hostname === "www.ishares.com") return mode === "ishares-blocked" ? new Response("<html>Access Denied</html>", { status: 403 }) : new Response(holdings());
  if (mode === "auth") return new Response(JSON.stringify({ message: "forbidden." }), { status: 403 });
  if (url.pathname === "/v2/stocks/bars") {
    const syms = url.searchParams.get("symbols").split(","), end = url.searchParams.get("end").slice(0, 10);
    if (!url.searchParams.get("page_token")) {
      // page 1: NVDA + AAPL; page 2: BRK.B (pagination)
      const days = ["2026-08-31", "2026-09-04", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"].filter((d) => d <= end);
      return new Response(JSON.stringify({ bars: { NVDA: days.map((d, i) => bar(d, 200 + i)), AAPL: days.map((d, i) => bar(d, 300 + i)) }, next_page_token: syms.includes("BRK.B") ? "p2" : null }));
    }
    return new Response(JSON.stringify({ bars: { "BRK.B": [bar("2026-10-02", 480)] }, next_page_token: null }));
  }
  if (url.pathname === "/v2/stocks/trades/latest") {
    const syms = url.searchParams.get("symbols").split(",");
    return new Response(JSON.stringify({ trades: Object.fromEntries(syms.filter((s) => ["NVDA", "AAPL"].includes(s)).map((s) => [s, { t: new Date(Date.now() - 20_000).toISOString(), x: "V", p: s === "NVDA" ? 240.5 : 330.25, s: 100, c: ["@"], i: 1, z: "C" }])) }));
  }
  return new Response("", { status: 404 });
};
const call = async (path, e = env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), e, ctx); const t = await r.text(); return { status: r.status, t, j: JSON.parse(t), xc: r.headers.get("x-cache") }; };

let r = await call("/api/spx/universe");
ok("universe: 417 constituents with source, holdings date, LIVE", r.status === 200 && r.j.count === 417 && r.j.holdingsAsOf === "2026-10-05" && r.j.status === "LIVE" && /iShares/.test(r.j.source) && /proxy/.test(r.j.weightBasis));
calls = [];
r = await call("/api/spx/universe");
ok("universe: cached (no new download)", r.xc === "HIT" && calls.length === 0);

r = await call("/api/spx/live", { ALLOWED_ORIGIN: env.ALLOWED_ORIGIN });
ok("prices without Alpaca keys → 503 N/A, no provider call", r.status === 503 && r.j.error === "alpaca_not_configured" && r.j.status === "N/A" && !calls.some((c) => /alpaca/.test(c.url)));

calls = [];
r = await call("/api/spx/live");
ok("live: latest IEX trades for the whole universe, in chunks of ≤ 200 symbols", r.status === 200 && r.j.trades.NVDA[0] === 240.5 && r.j.count === 2 && calls.length === 3 && calls.every((c) => c.url.includes("feed=iex") && c.url.split("symbols=")[1].split("&")[0].split("%2C").length <= 200));
ok("live: keys only in the request headers, never in URLs or the response", calls.every((c) => c.headers["APCA-API-KEY-ID"] === KEYID && c.headers["APCA-API-SECRET-KEY"] === SECRET && !c.url.includes(KEYID) && !c.url.includes(SECRET)) && !r.t.includes(KEYID) && !r.t.includes(SECRET));
ok("live: phase reported (live flag, median trade age)", typeof r.j.live === "boolean" && Number.isFinite(r.j.medianTradeAgeSec));

calls = [];
r = await call("/api/spx/closes?ref=recent");
ok("recent closes: consolidated (SIP) split-adjusted daily bars, ≤ 3 per symbol, pages followed", r.status === 200 && r.j.closes.NVDA.length === 3 && r.j.closes["BRK.B"][0][1] === 480 && calls.filter((c) => c.url.includes("/bars")).length === 2 && calls.every((c) => !c.url.includes("/bars") || (c.url.includes("feed=sip") && c.url.includes("adjustment=split"))));
ok("recent closes: end ≥ 15 minutes ago (free-plan rule)", (() => { const e = new URL(calls[0].url).searchParams.get("end"); return Date.now() - Date.parse(e) >= 15 * 60_000; })());
r = await call("/api/spx/closes?ref=1M");
ok("1M reference: last consolidated close on or before the target date", r.status === 200 && r.j.target === refTarget("1M", r.j.todayET) && Object.values(r.j.closes).every(([d]) => d <= r.j.target));
r = await call("/api/spx/closes?ref=5D");
ok("unknown reference → 400", r.status === 400);

store = new Map(); mode = "auth";
r = await call("/api/spx/live");
ok("Alpaca refuses the keys → provider_auth N/A (nothing invented)", r.status === 502 && r.j.error === "provider_auth" && r.j.status === "N/A");
store = new Map(); mode = "ishares-blocked";
r = await call("/api/spx/universe");
ok("holdings file unavailable → N/A, no fallback list", r.status === 502 && r.j.status === "N/A" && !r.j.items);
r = await call("/api/spx/closes?ref=recent");
ok("prices need the real constituent list → N/A without it", r.status === 502 && r.j.error === "universe_unavailable");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
