// T06 — heat maps beyond the S&P 500 (Nasdaq-100, Dow 30, sector / country ETFs, crypto), world exchanges
// and the portfolio, Worker side. Provider responses are test fixtures in the providers' formats
// (Invesco holdings JSON, SPDR .xlsx, Alpaca bars / trades, Twelve Data market_state, ECB EXR CSV).
//   node test/maps.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseQqq, parseSpdrRows, UNIVERSES, COUNTRY_ETFS, SECTOR_ETFS, alpacaCryptoBars, cryptoPhase } from "../src/spx.mjs";
import { xlsxRows } from "../src/lib.mjs";
import { durSec, normalizeMarketState, nextChange } from "../src/exchanges.mjs";
import { validateTx, buildPositions, parseEcbFx, eurPer } from "../src/portfolio.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

// ---------- holdings parsers ----------
const QQQ = { effectiveDate: "2026-10-05", holdings: [
  { ticker: "NVDA", issuerName: "NVIDIA Corp", percentageOfTotalNetAssets: 9.1, securityTypeName: "Common Stock" },
  { ticker: "ASML", issuerName: "ASML Holding NV ADR", percentageOfTotalNetAssets: 1.4, securityTypeName: "American Depositary Receipt" },
  { ticker: "USD", issuerName: "US Dollar", percentageOfTotalNetAssets: 0.02, securityTypeName: "Cash" },
  { ticker: "NQZ6", issuerName: "NASDAQ 100 E-MINI DEC26", percentageOfTotalNetAssets: 0.1, securityTypeName: "Futures" },
  { ticker: "NVDA", issuerName: "dup", percentageOfTotalNetAssets: 1, securityTypeName: "Common Stock" },
] };
const q = parseQqq(QQQ);
ok("Invesco QQQ: equities and ADRs with weights; cash, futures, duplicates out; date kept", q.asOf === "2026-10-05" && q.items.map((x) => x.sym).join() === "NVDA,ASML" && q.items[0].weight === 9.1 && q.items[0].sector === null);
const rows = [["SPDR® Dow Jones Industrial Average ETF Trust"], ["Ticker Symbol:", "DIA"], ["Holdings:", "As of 06-Oct-2026"], [], ["Name", "Ticker", "Identifier", "SEDOL", "Weight", "Sector", "Shares Held", "Local Currency"],
  ["GOLDMAN SACHS GROUP INC", "GS", "38141G104", "2407966", "11.2", "Financials", "1", "USD"], ["CASH", "", "", "", "0.01", "", "", "USD"], ["UNITEDHEALTH GROUP INC", "UNH", "x", "y", "6.1", "Health Care", "1", "USD"], ["CATERPILLAR INC", "CAT", "x", "y", "9.9", "-", "1", "USD"]];
const dj = parseSpdrRows(rows);
ok("SPDR DIA sheet: header found, as-of date, tickers with weight and sector; blank ticker rows skipped", dj.asOf === "2026-10-06" && dj.items.map((x) => x.sym).join() === "GS,UNH,CAT" && dj.items[0].sector === "Financials" && dj.items[2].sector === null && dj.items[0].weight === 11.2);

// a real .xlsx is a ZIP of XML parts: build one (deflated shared strings, stored sheet) and read it back
async function zip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  for (const [name, text, deflate] of files) {
    const raw = enc.encode(text), data = deflate ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()) : raw, nb = enc.encode(name);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, deflate ? 8 : 0, true); lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, nb.length, true);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, deflate ? 8 : 0, true); ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), nb, data); central.push(new Uint8Array(ch.buffer), nb); off += 30 + nb.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]).arrayBuffer();
}
const SST = `<sst><si><t>Name</t></si><si><t>Ticker</t></si><si><t>Weight</t></si><si><t>Sector</t></si><si><t>GOLDMAN SACHS &amp; CO</t></si><si><r><t>Finan</t></r><r><t>cials</t></r></si><si><t>Holdings:</t></si><si><t>As of 06-Oct-2026</t></si></sst>`;
const SHEET = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>6</v></c><c r="B1" t="s"><v>7</v></c></row><row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="E3" t="s"><v>2</v></c><c r="F3" t="s"><v>3</v></c></row><row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4" t="inlineStr"><is><t>GS</t></is></c><c r="E4"><v>11.25</v></c><c r="F4" t="s"><v>5</v></c></row></sheetData></worksheet>`;
const XLSX = await zip([["xl/sharedStrings.xml", SST, true], ["xl/worksheets/sheet1.xml", SHEET, false]]);
const xr = await xlsxRows(XLSX);
const xd = parseSpdrRows(xr);
ok("xlsx reader: deflated shared strings (rich text, entities), stored sheet, inline strings, column letters", xr[1][4] === "Weight" && xd.items.length === 1 && xd.items[0].name === "GOLDMAN SACHS & CO" && xd.items[0].sector === "Financials" && xd.items[0].weight === 11.25 && xd.asOf === "2026-10-06", JSON.stringify(xr));

// ---------- fixed lists ----------
ok("sector map: the 11 SPDR Select Sector ETFs", SECTOR_ETFS.length === 11 && SECTOR_ETFS.every((x) => /^XL[A-Z]{1,2}$/.test(x.sym)));
ok("country map: country ETFs grouped by region, named by country, no weights invented", COUNTRY_ETFS.length >= 30 && COUNTRY_ETFS.find((x) => x.sym === "EWI").short === "ITALY" && COUNTRY_ETFS.every((x) => x.weight === null && x.sector));
ok("universes: SPX, NDX, DJI, SECT, CTRY, CRYPTO", Object.keys(UNIVERSES).join() === "SPX,NDX,DJI,SECT,CTRY,CRYPTO");

// ---------- crypto: only completed UTC days are closes ----------
const NOW = Date.parse("2026-10-07T10:00:00Z");
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes("/v1beta3/crypto/us/bars")) return new Response(JSON.stringify({ bars: { "BTC/USD": [{ t: "2026-10-05T00:00:00Z", c: 60000, v: 10 }, { t: "2026-10-06T00:00:00Z", c: 61000, v: 12 }, { t: "2026-10-07T00:00:00Z", c: 62000, v: 1 }] } }));
  if (u.includes("/v1beta3/crypto/us/latest/trades")) return new Response(JSON.stringify({ trades: { "BTC/USD": { p: 61500, t: new Date(Date.now() - 60_000).toISOString() } } }));
  if (u.includes("dng-api.invesco.com")) return new Response(JSON.stringify({ effectiveDate: "2026-10-05", holdings: Array.from({ length: 100 }, (_, i) => ({ ticker: `Q${i}`, issuerName: `Co ${i}`, percentageOfTotalNetAssets: 1, securityTypeName: "Common Stock" })) }));
  if (u.includes("data.alpaca.markets/v2/stocks/bars")) { const syms = new URL(u).searchParams.get("symbols").split(","); return new Response(JSON.stringify({ bars: Object.fromEntries(syms.map((s) => [s, [{ t: "2026-10-05T04:00:00Z", c: 50, v: 1000 }, { t: "2026-10-06T04:00:00Z", c: 51, v: 2000 }]])) })); }
  if (u.includes("data.alpaca.markets/v2/stocks/trades/latest")) return new Response(JSON.stringify({ trades: {} }));
  return new Response("", { status: 404 });
};
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", ALPACA_KEY_ID: "id", ALPACA_SECRET_KEY: "secret" }, ctx = { waitUntil: () => {} };
const cb = await alpacaCryptoBars(env, ["BTC/USD"], "2026-10-01", new Date(NOW).toISOString(), NOW);
ok("crypto bars: the running UTC day is not a close; traded value = close × volume", cb.data["BTC/USD"].length === 2 && cb.data["BTC/USD"][1][0] === "2026-10-06" && cb.data["BTC/USD"][1][2] === 732000);
ok("crypto live phase: 24/7, live when the most traded quarter traded recently (thin pairs do not block it)", cryptoPhase({ A: [1, new Date(NOW - 60_000).toISOString()], B: [1, new Date(NOW - 5 * 3600_000).toISOString()], C: [1, new Date(NOW - 6 * 3600_000).toISOString()], D: [1, new Date(NOW - 7 * 3600_000).toISOString()] }, NOW).live === true && cryptoPhase({ A: [1, new Date(NOW - 3600_000).toISOString()] }, NOW).live === false);
const call = async (path, init, e = env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path, init), e, ctx); return { status: r.status, j: await r.json() }; };
let r = await call("/api/spx/universe?u=CTRY");
ok("/api/spx/universe?u=CTRY: fixed ETF list, labelled, source named", r.status === 200 && r.j.universe === "CTRY" && r.j.items.length === COUNTRY_ETFS.length && /ETFs/.test(r.j.source));
r = await call("/api/spx/closes?u=SECT&ref=recent");
ok("/api/spx/closes?u=SECT: Alpaca closes with traded value (third value)", r.status === 200 && r.j.closes.XLK[1][2] === 102000 && r.j.universe === "SECT");
r = await call("/api/spx/closes?u=CRYPTO&ref=recent");
ok("/api/spx/closes?u=CRYPTO: completed days only, todayBarFinal true, UTC day basis", r.status === 200 && r.j.closes["BTC/USD"].length === 2 && r.j.todayBarFinal === true && /UTC/.test(r.j.dayBasis));
r = await call("/api/spx/live?u=CRYPTO");
ok("/api/spx/live?u=CRYPTO: latest crypto trade, live", r.status === 200 && r.j.live === true && r.j.trades["BTC/USD"][0] === 61500);
r = await call("/api/spx/universe?u=NDX");
ok("/api/spx/universe?u=NDX: Invesco holdings, weight basis named, cached", r.status === 200 && r.j.count === 100 && /QQQ/.test(r.j.weightBasis) && store.has("https://alessandrozanichelli.com/__cache/map/NDX/universe"));
r = await call("/api/spx/universe?u=FOO");
ok("unknown universe → 400", r.status === 400);

// ---------- world exchanges ----------
ok("durations: HH:MM:SS (hours may exceed 24) → seconds", durSec("02:15:00") === 8100 && durSec("62:00:30") === 223230 && durSec("") === null && durSec("1 day") === null);
const MS = [
  { name: "NYSE", code: "XNYS", country: "United States", is_market_open: false, time_after_open: "00:00:00", time_to_open: "02:15:00", time_to_close: "00:00:00" },
  { name: "LSE", code: "XLON", country: "United Kingdom", is_market_open: true, time_after_open: "05:00:00", time_to_open: "00:00:00", time_to_close: "03:30:00" },
  { name: "Somewhere", code: "XSOM", country: "Nowhere", is_market_open: true, time_after_open: "01:00:00", time_to_open: "00:00:00", time_to_close: "00:10:00" },
  { name: "broken", code: "", is_market_open: true },
];
const ex = normalizeMarketState(MS, NOW);
ok("market_state: instants from the fetch time; major markets labelled with city and time zone", ex.length === 3 && ex[0].opensAt === NOW + 8100e3 && ex[0].closesAt === null && ex[1].closesAt === NOW + 12600e3 && ex[1].openedAt === NOW - 18000e3 && ex[1].tz === "Europe/London" && ex[2].major === false && ex[2].tz === null);
ok("market_state: next change among the major markets only (a minor one closing sooner is ignored)", nextChange(ex) === NOW + 8100e3);
let mode = "ok", tdCalls = 0;
globalThis.fetch = async (u, o = {}) => { if (String(u).includes("market_state")) { tdCalls++; if (!/^apikey /.test(o.headers.authorization)) return new Response("", { status: 401 }); return mode === "ok" ? new Response(JSON.stringify(MS)) : new Response(JSON.stringify({ code: 429, message: "limit", status: "error" })); } return new Response("", { status: 404 }); };
const envTD = { ...env, TWELVEDATA_KEY: "TESTKEY_never_returned" };
store = new Map();
r = await call("/api/exchanges", undefined, envTD);
ok("/api/exchanges: LIVE, major open count, missing majors listed, key only in the header (never in the body)", r.status === 200 && r.j.status === "LIVE" && r.j.majorOpen === 1 && r.j.missingMajor.includes("XJPX") && !JSON.stringify(r.j).includes("TESTKEY"));
await call("/api/exchanges", undefined, envTD);
ok("/api/exchanges: cached (one provider credit) until the next open/close", tdCalls === 1);
const realNow = Date.now; Date.now = () => realNow() + 3 * 3600_000; mode = "limit";
r = await call("/api/exchanges", undefined, envTD);
ok("/api/exchanges: after a predicted change the state is refetched; provider refused → last real state served STALE", tdCalls === 2 && r.j.status === "STALE" && r.j.staleReason === "rate_limited");
Date.now = realNow; store = new Map();
r = await call("/api/exchanges", undefined, envTD);
ok("/api/exchanges: nothing cached and provider refused → 429 N/A, no state guessed", r.status === 429 && r.j.status === "N/A");
r = await call("/api/exchanges", undefined, env);
ok("/api/exchanges: no key configured → N/A", r.status === 502 && r.j.error === "server_not_configured");

// ---------- portfolio ----------
ok("transaction validation: side, symbol, date, positive numbers, currency, no future date", validateTx({ side: "buy", sym: "aapl", qty: "10", price: 200, ccy: "USD", date: "2026-10-01" }, "2026-10-07").sym === "AAPL"
  && validateTx({ side: "HOLD", sym: "AAPL", qty: 1, price: 1, ccy: "USD", date: "2026-10-01" }, "2026-10-07") === "side must be BUY or SELL"
  && validateTx({ side: "BUY", sym: "AAPL", qty: -1, price: 1, ccy: "USD", date: "2026-10-01" }, "2026-10-07") === "quantity must be a positive number"
  && validateTx({ side: "BUY", sym: "AAPL", qty: 1, price: 1, ccy: "USD", date: "2026-10-09" }, "2026-10-07") === "date is in the future"
  && validateTx({ side: "BUY", sym: "AAPL", qty: 1, price: 1, ccy: "US", date: "2026-10-01" }, "2026-10-07") === "currency must be a 3-letter code");
const ECB_CSV = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-30,1.10\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-02,1.12\nEXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-10-01,0.85\n";
const ser = parseEcbFx(ECB_CSV);
ok("ECB rates: series per currency, rate on or before the date (weekend → Friday), minor units", ser.USD.length === 2 && Math.abs(eurPer(ser, "USD", "2026-10-01").v - 1 / 1.1) < 1e-12 && eurPer(ser, "USD", "2026-10-01").rateDate === "2026-09-30" && Math.abs(eurPer(ser, "GBp", "2026-10-03").v - 0.01 / 0.85) < 1e-12 && eurPer(ser, "USD", "2026-09-01") === null && eurPer(ser, "EUR", "2026-10-01").v === 1);
const T = (o) => ({ id: Math.random().toString(36), created: Date.now(), fees: 0, note: "", ...o });
let b = buildPositions([T({ side: "BUY", sym: "AAPL", qty: 10, price: 200, ccy: "USD", fees: 1, date: "2026-10-01" }), T({ side: "BUY", sym: "AAPL", qty: 10, price: 220, ccy: "USD", date: "2026-10-02" }), T({ side: "SELL", sym: "AAPL", qty: 5, price: 230, ccy: "USD", fees: 1, date: "2026-10-03" })], ser);
const a = b.positions[0];
// avg after buys: (2001 + 2200) / 20 = 210.05; sell 5 @ 230 − 1 fee: realized = 1149 − 1050.25 = 98.75
ok("positions: average cost incl. fees, partial sale, realised P&L in the listing currency", a.qty === 15 && Math.abs(a.avgCost - 210.05) < 1e-9 && Math.abs(a.realized - 98.75) < 1e-6 && a.open === true);
// EUR cost: 2001/1.10 + 2200/1.12 = 1819.0909 + 1964.2857 = 3783.3766; avg €189.1688/share; sold 5 at 1149/1.12 = 1025.8929 → realised €80.0487
ok("positions: EUR cost at each trade date's ECB rate; realised P&L in EUR includes the currency effect", Math.abs(a.costEur - 3783.376623 * 15 / 20) < 1e-3 && Math.abs(b.realized.eur - (1149 / 1.12 - 3783.376623 / 20 * 5)) < 1e-3);
b = buildPositions([T({ side: "BUY", sym: "X", qty: 1, price: 1, ccy: "USD", date: "2026-10-01" }), T({ side: "SELL", sym: "X", qty: 2, price: 1, ccy: "USD", date: "2026-10-02" })], ser);
ok("positions: selling more than held at that date is refused (no short positions invented)", /only 1 held/.test(b.error));
b = buildPositions([T({ side: "BUY", sym: "X", qty: 1, price: 1, ccy: "SAR", date: "2026-10-01" })], ser);
ok("positions: no ECB rate for the currency → EUR cost N/A (not estimated)", b.positions[0].costEur === null && b.positions[0].cost === 1);
b = buildPositions([T({ side: "BUY", sym: "X", qty: 1, price: 1, ccy: "USD", date: "2026-10-01" }), T({ side: "SELL", sym: "X", qty: 1, price: 2, ccy: "USD", date: "2026-10-02" })], ser);
ok("positions: a fully sold position is closed with its realised result", b.positions[0].open === false && b.positions[0].qty === 0 && b.positions[0].realized === 1);

const kv = new Map(), BRIEFS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
let ecbCalls = 0;
globalThis.fetch = async (u) => { if (String(u).includes("data-api.ecb.europa.eu/service/data/EXR")) { ecbCalls++; return new Response(ECB_CSV); } return new Response("", { status: 404 }); };
const envP = { ...env, BRIEFS };
const json = (b) => ({ method: "POST", headers: { "content-type": "application/json", origin: "https://alessandrozanichelli.com" }, body: JSON.stringify(b) });
r = await call("/api/portfolio", undefined, envP);
ok("portfolio: starts empty — no transactions, no positions", r.status === 200 && r.j.transactions.length === 0 && r.j.positions.length === 0 && r.j.baseCurrency === "EUR");
r = await call("/api/portfolio/tx", json({ side: "BUY", sym: "AAPL", qty: 10, price: 200, ccy: "USD", fees: 1, date: "2026-10-01" }), envP);
ok("portfolio: a trade is stored (KV) and the position derived, EUR cost at the ECB rate", r.status === 201 && JSON.parse(kv.get("pf/tx")).length === 1 && r.j.positions[0].qty === 10 && Math.abs(r.j.positions[0].costEur - 2001 / 1.1) < 1e-6 && r.j.costBasis.fx.status === "LIVE" && ecbCalls === 1);
r = await call("/api/portfolio/tx", json({ side: "SELL", sym: "AAPL", qty: 11, price: 210, ccy: "USD", date: "2026-10-02" }), envP);
ok("portfolio: a sale larger than the holding → 409, nothing stored", r.status === 409 && JSON.parse(kv.get("pf/tx")).length === 1);
r = await call("/api/portfolio/tx", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }, envP);
ok("portfolio: writes from another origin → 403", r.status === 403);
r = await call("/api/portfolio/tx", { method: "POST", headers: { "content-type": "text/plain" }, body: "side=BUY" }, envP);
ok("portfolio: non-JSON write (a cross-site form) → 415", r.status === 415);
const id = JSON.parse(kv.get("pf/tx"))[0].id;
await call("/api/portfolio/tx", json({ side: "SELL", sym: "AAPL", qty: 4, price: 210, ccy: "USD", date: "2026-10-02" }), envP);
r = await call(`/api/portfolio/tx?id=${id}`, { method: "DELETE" }, envP);
ok("portfolio: deleting the buy that a later sale needs → 409 (history stays consistent)", r.status === 409 && JSON.parse(kv.get("pf/tx")).length === 2);
const sellId = JSON.parse(kv.get("pf/tx"))[1].id;
r = await call(`/api/portfolio/tx?id=${sellId}`, { method: "DELETE" }, envP);
ok("portfolio: delete a transaction", r.status === 200 && r.j.transactions.length === 1 && r.j.positions[0].qty === 10);
r = await call("/api/portfolio", undefined, { ...env, BRIEFS: undefined });
ok("portfolio: no storage → 503 N/A", r.status === 503 && r.j.status === "N/A");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
