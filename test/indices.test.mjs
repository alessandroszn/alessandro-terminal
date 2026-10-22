// World indices (approved 7 Oct 2026): parsers on fixtures in each source's own format (copied from real responses),
// the /api/indices endpoints with mocked sources, the FRED stand-in when Cboe does not answer.
// Fixtures are test data only; nothing here is shown in the terminal.
//   node test/indices.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseCboeQuote, parseCboeHist, parseStoxx, parseNikkei, closeRow, cboeTime, tooOld, INDICES, NOT_CONNECTED, GROUPS, parseSixSnap, parseSixHist, parseSseSnap, parseSseDayk, parseB3Year, parseAsx, zonedToUtc } from "../src/indices.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

// ---------- Cboe delayed quote (cdn-api.cboe.com …/quotes/_SPX.json) ----------
const Q = { timestamp: "2026-10-07 17:45:37", data: { symbol: "^SPX", security_type: "index", current_price: 7801.6401, price_change: -17.29, price_change_percent: -0.2211, open: 7792.98, high: 7804.3198, low: 7763.3398, close: 7801.6401, prev_day_close: 7818.9302, volume: 0, last_trade_time: "2026-10-07T13:30:37", tick: "up" } };
const q = parseCboeQuote(Q);
ok("Cboe quote: level, change, day range; the last trade time is New York time (13:30 EDT = 17:30 UTC)", q.last === 7801.6401 && q.chg === -17.29 && q.chgPct === -0.2211 && q.open === 7792.98 && q.prev === 7818.9302 && q.asOf === "2026-10-07T17:30:37.000Z" && q.date === "2026-10-07");
const dj = parseCboeQuote({ timestamp: "2026-10-07 17:45:37", data: { current_price: 512.32, price_change: -2.89, price_change_percent: -0.5609, open: 515.04, high: 516.1, low: 511.2, prev_day_close: 515.21, last_trade_time: "2026-10-07T13:30:37" } }, 100);
ok("Cboe DJX × 100 = the Dow in points (change % unchanged)", dj.last === 51232 && dj.prev === 51521 && dj.chg === -289 && dj.chgPct === -0.5609 && dj.open === 51504);
const ms = parseCboeQuote({ timestamp: "2026-10-07 17:45:16", data: { current_price: 638.04, price_change: -3.59, price_change_percent: -0.5595, open: 0, high: 0, low: 0, prev_day_close: 641.63, last_trade_time: "2026-10-07T12:45:00.080000-05:00" } });
ok("Cboe: a zero open/high/low is missing (never 0); a time with its own offset is read as such", ms.open === null && ms.high === null && ms.asOf === "2026-10-07T17:45:00.080Z");
const pre = parseCboeQuote({ timestamp: "2026-10-08 12:00:00", data: { current_price: 7801.64, price_change: 0, price_change_percent: 0, open: 0, high: 0, low: 0, prev_day_close: 7801.64, last_trade_time: "2026-10-07T17:15:00" } });
ok("Cboe before the session (no open, zero change): no change is reported", pre.chg === null && pre.chgPct === null && /before the session/.test(pre.note));
ok("Cboe: no price → nothing", parseCboeQuote({ data: { current_price: 0 } }) === null && parseCboeQuote({}) === null && parseCboeQuote(null) === null);
ok("Cboe times: top-level timestamp is UTC; EST in winter", cboeTime("2026-10-07 17:45:37", true) === Date.UTC(2026, 9, 7, 17, 45, 37) && cboeTime("2026-01-07T13:30:37") === Date.UTC(2026, 0, 7, 18, 30, 37));

// ---------- Cboe daily history (…/charts/historical/_SPX.json, 1975 →) ----------
const rows = [{ date: "1975-01-02", volume: "0.0", open: "0.000000", high: "70.920000", low: "68.650000", close: "70.230000" }];
for (let i = 0; i < 30; i++) rows.push({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, volume: "0.0", open: String(7700 + i), high: String(7710 + i), low: String(7690 + i), close: String(7705 + i) });
const HJ = JSON.stringify({ timestamp: "2026-10-07 17:01:23", data: rows, symbol: "_SPX" });
const h10 = parseCboeHist(HJ, 10);
ok("Cboe history: only the tail is parsed, oldest first, as [date, open, high, low, close]", h10.length === 10 && h10[0][0] === "2026-09-21" && h10[9].join() === "2026-09-30,7729,7739,7719,7734");
const hAll = parseCboeHist(HJ, 100);
ok("Cboe history: a day without an open keeps its close and no invented open/high/low", hAll.length === 31 && hAll[0].join() === "1975-01-02,,,,70.23");
ok("Cboe history: a file in another layout is read whole; garbage → nothing", parseCboeHist(JSON.stringify({ data: [{ close: "5", date: "2026-01-02", open: "4", high: "6", low: "3" }] }), 10).length === 1 && parseCboeHist("<html>", 10).length === 0);
ok("Cboe history ×100 (DJX → Dow)", parseCboeHist(HJ, 1, 100)[0].join() === "2026-09-30,772900,773900,771900,773400");

// ---------- STOXX (h_3msx5e.txt) ----------
const SX = "Date;Symbol;Indexvalue;\n08.07.2026;SX5E;6204.91;\n09.07.2026;SX5E;6284.27;\r\n06.10.2026;SX5E;6272.23;\n07.10.2026;SX5E;6180.29;\n";
const sx = parseStoxx(SX);
ok("STOXX: dd.mm.yyyy → ISO, oldest first, header skipped", sx.length === 4 && sx[0].join() === "2026-07-08,6204.91" && sx[3].join() === "2026-10-07,6180.29");
const sr = closeRow(sx);
ok("STOXX close row: change against the previous close (DERIVED), no open/high/low", sr.last === 6180.29 && sr.prev === 6272.23 && sr.chg === -91.94 && sr.chgPct === -1.4658 && sr.open === null && sr.date === "2026-10-07" && sr.prevDate === "2026-10-06");

// ---------- Nikkei (nikkei_stock_average_daily_en.csv) ----------
const NK = 'Date of Data,Close,Open,High,Low\r\n"2026/10/06","70684.20","70100.00","70900.00","70000.00"\r\n"2026/10/07","70035.71","70582.11","70793.29","70017.19"\r\n"This material is a copyrightable work of Nikkei. It is prohibited to copy, reproduce, reprint, or circulate all or part of this material in any form without Nikkei\'s permission."\r\n';
const nk = parseNikkei(NK), nr = closeRow(nk);
ok("Nikkei: close/open/high/low by column, copyright line ignored", nk.length === 2 && nk[1].join() === "2026-10-07,70582.11,70793.29,70017.19,70035.71" && nr.open === 70582.11 && nr.high === 70793.29 && nr.chg === -648.49);
ok("a daily value older than five days is no longer the latest", !tooOld("2026-10-02", Date.UTC(2026, 9, 7, 12)) && tooOld("2026-09-30", Date.UTC(2026, 9, 7, 12)) && tooOld(null, Date.now()));
// fetches one group request can make at most: one per source (B3: quote + two yearly files; ASX: two; NSE: up to five daily
// files, shared by its indices; a Cboe index with a FRED stand-in: two)
const FETCHES = { cboe: 1, stoxx: 1, nikkei: 1, fred: 1, six: 1, sse: 1, b3: 2, asx: 2 };
const budget = (g) => INDICES.filter((x) => x.g === g).reduce((a, x) => a + (FETCHES[x.src] || 0) + (x.fred ? 1 : 0), 0);
ok("catalog: every index in one group; each group within the Worker's limits (≤ 12 fetches); not-connected ones named", INDICES.every((x) => GROUPS.some(([g]) => g === x.g)) && GROUPS.every(([g]) => budget(g) <= 12) && new Set(INDICES.map((x) => x.id)).size === INDICES.length && NOT_CONNECTED.length === 0 && ["UKX", "CAC", "FTSEMIB", "HSI", "KOSPI", "NIFTY", "TSX", "DXY"].every((id) => INDICES.find((x) => x.id === id && x.src === "cnbc")), GROUPS.map(([g]) => g + ":" + budget(g)).join());

// ---------- exchange websites (approved 20 Oct 2026; fixtures in each source's own format, values from real responses) ----------
const six = parseSixSnap({ colNames: ["ValorId", "ClosingPrice", "ClosingPerformance", "ClosingDelta", "PreviousClosingPrice", "MarketDate", "MarketTime"], rowData: [["CH0009980894CHF9", 14478.37, 0.76, 109.59, 14368.78, 20261020, 194538]] });
ok("SIX snapshot: level, previous close, change DERIVED; the snapshot time in Zurich time (19:45:38 CEST = 17:45:38 UTC)", six.last === 14478.37 && six.prev === 14368.78 && six.chg === 109.59 && six.chgPct === 0.7627 && six.date === "2026-10-20" && six.asOf === "2026-10-20T17:45:38.000Z", JSON.stringify(six));
ok("SIX: no row (an unknown valor) → nothing", parseSixSnap({ colNames: ["ValorId"], rowData: [] }) === null && zonedToUtc("Europe/Zurich", "2026-01-15", "120000") === Date.UTC(2026, 0, 15, 11));
const sh = parseSixHist({ valors: [{ ValorId: "CH0009980894CHF9", data: { Date: [20261016, 20261019, 20261020], Time: [173005, 173005, 173005], Open: [14300, 14360, 14476.04], Close: [14320.5, 14368.78, 14478.37] } }] });
ok("SIX daily bars: one close per day, oldest first", sh.length === 3 && sh[2].join() === "2026-10-20,14478.37" && sh[0][0] === "2026-10-16");
const sse = parseSseSnap({ code: "000001", date: 20261020, time: 162902, snap: ["上证指数", 3730.92, 3718.436, 3740.072, 3702.4441, 3735.3704, 4.4504, 0.12, 408693062, 699969753799] });
ok("SSE snapshot: previous close, open, high, low, last by position; Shanghai time (16:29:02 = 08:29:02 UTC)", sse.last === 3735.3704 && sse.prev === 3730.92 && sse.open === 3718.436 && sse.high === 3740.072 && sse.low === 3702.4441 && sse.chg === 4.4504 && sse.asOf === "2026-10-20T08:29:02.000Z");
const dk = parseSseDayk({ code: "000001", total: 8745, kline: [[20261019, 3694.117, 3743.798, 3692.29, 3730.92], [20261020, 3718.436, 3740.072, 3702.444, 3735.37]] });
ok("SSE daily bars: open/high/low/close per day", dk.length === 2 && dk[1].join() === "2026-10-20,3718.436,3740.072,3702.444,3735.37");
const by3 = parseB3Year({ results: [{ day: 1, rateValue1: null, rateValue9: "179.722,48", rateValue10: "187.197,46", rateValue11: "" }, { day: 2, rateValue1: "160.538,69", rateValue10: "188.004,10" }] }, 2026);
ok("B3 daily closes of a year: day × month grid, Brazilian number format, empty days skipped", by3.map((x) => x.join(":")).join() === "2026-01-02:160538.69,2026-09-01:179722.48,2026-10-01:187197.46,2026-10-02:188004.1");
const asx = parseAsx({ data: { displayName: "S&P/ASX 200", priceChange: -28.80000000000109, priceChangePercent: -0.32558192115944573, priceLast: 8816.9, symbol: "XJO" } }, { data: { priceClose: 8845.7, priceDayHigh: 8845.7, priceDayLow: 8747.300000000001 } });
ok("ASX: level, previous close from the key statistics, day range rounded; no time, said so", asx.last === 8816.9 && asx.prev === 8845.7 && asx.chg === -28.8 && asx.low === 8747.3 && asx.asOf === null && asx.date === null && /no time/.test(asx.note));

// ---------- endpoints with mocked sources ----------
let store = new Map();
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const ctx = { waitUntil: () => {} };
const KEYF = "fred-test-key-222";
const NOW = new Date(), todayNY = NOW.toLocaleDateString("en-CA", { timeZone: "America/New_York" }), ymd = (d) => d.toISOString().slice(0, 10);
const ago = (n) => ymd(new Date(Date.now() - n * 86400_000));
let calls = [], cboeDown = new Set();
const nyClock = (t) => new Date(t).toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T");
// CNBC quote service: every symbol answers, except .KS11 (KOSPI) which CNBC reports with code 1 in this test
const cnbcQ = (sym) => sym === ".KS11" ? { symbol: sym, code: 1 } : { symbol: sym, code: 0, name: sym, last: sym === ".FTSE" ? "10,733.00" : "1,234.50", previous_day_closing: sym === ".FTSE" ? "10,700.00" : "1,230.00", change: sym === ".FTSE" ? "+33.00" : "+4.50", change_pct: sym === ".FTSE" ? "+0.31%" : "+0.37%", open: "10,690.00", high: "10,750.00", low: "10,680.00", last_time: new Date(Date.now() - 3600_000).toISOString().replace("Z", "+0000"), exchange: "FTSE International", realTime: "false", curmktstatus: "POST_MKT" };
globalThis.fetch = async (u) => {
  u = String(u); calls.push(u);
  if (u.startsWith("https://quote.cnbc.com/")) { const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split("|"); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map(cnbcQ) } })); }
  if (u.startsWith("https://ts-api.cnbc.com/")) return new Response(JSON.stringify({ barData: { priceBars: [3, 2, 1].map((n, i) => ({ open: String(10600 + i), high: String(10650 + i), low: String(10550 + i), close: String(10620 + i * 10), tradeTime: ago(n).replace(/-/g, "") + "000000", tradeTimeinMills: Date.parse(ago(n)) })) } }));
  const m = /cdn-api\.cboe\.com\/api\/global\/delayed_quotes\/(quotes|charts\/historical)\/(_[A-Z]+)\.json$/.exec(u);
  if (m) {
    if (cboeDown.has(m[2])) return new Response("denied", { status: 403 });
    const base = { _SPX: 7800, _NDX: 31100, _DJX: 512.32, _RUT: 2797, _VIX: 15.15, _MXEA: 3088, _MXEF: 1726, _MXACW: 629, _OEX: 3841, _RUI: 4197 }[m[2]];
    if (m[1] === "quotes") return new Response(JSON.stringify({ timestamp: new Date().toISOString().slice(0, 19).replace("T", " "), data: { current_price: base, price_change: -1, price_change_percent: -0.1, open: base + 1, high: base + 2, low: base - 3, prev_day_close: base + 1, last_trade_time: nyClock(Date.now() - 15 * 60e3) } }));
    return new Response(JSON.stringify({ data: [400, 300, 3].map((n, i) => ({ date: ago(n), open: String(base - 10 + i), high: String(base - 5 + i), low: String(base - 20 + i), close: String(base - 8 + i) })) }));
  }
  if (u.startsWith("https://www.stoxx.com/document/Indices/Current/HistoricalData/")) { const f = u.split("/").pop().replace(".txt", ""); if (f === "h_3mmdax") return new Response("<html>not found</html>"); const d1 = ago(2).split("-").reverse().join("."), d2 = ago(1).split("-").reverse().join("."); return new Response(`Date;Symbol;Indexvalue;\n${d1};X;100.00;\n${d2};X;101.50;\n`); }
  if (u === "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_daily_en.csv") return new Response(`Date of Data,Close,Open,High,Low\n"${ago(2).replace(/-/g, "/")}","69900","69000","70100","68900"\n"${ago(1).replace(/-/g, "/")}","70035.71","70582.11","70793.29","70017.19"\n`);
  if (u.startsWith("https://www.six-group.com/fqs/snap.json")) { const v = /ValorId=([A-Z0-9]+)/.exec(u)[1]; return new Response(JSON.stringify({ colNames: ["ValorId", "ClosingPrice", "ClosingPerformance", "ClosingDelta", "PreviousClosingPrice", "MarketDate", "MarketTime"], rowData: v === "CH0009987501CHF9" ? [] : [[v, v.startsWith("ES") ? 19092.4 : 14478.37, 0.5, 1, v.startsWith("ES") ? 19039.3 : 14368.78, Number(ago(0).replace(/-/g, "")), 120000]] })); }
  if (u.startsWith("https://www.six-group.com/fqs/charts.json")) return new Response(JSON.stringify({ valors: [{ data: { Date: [ago(3), ago(2), ago(1)].map((d) => Number(d.replace(/-/g, ""))), Close: [14300, 14350, 14368.78] } }] }));
  if (u.startsWith("https://yunhq.sse.com.cn:32042/v1/sh1/snap/")) return new Response(JSON.stringify({ date: Number(ago(0).replace(/-/g, "")), time: 150002, snap: ["上证指数", 3730.92, 3718.436, 3740.072, 3702.4441, 3735.3704, 4.4504, 0.12] }));
  if (u.startsWith("https://yunhq.sse.com.cn:32042/v1/sh1/dayk/")) return new Response(JSON.stringify({ kline: [[Number(ago(2).replace(/-/g, "")), 3690, 3745, 3690, 3730.92], [Number(ago(1).replace(/-/g, "")), 3718.4, 3740, 3702.4, 3735.37]] }));
  if (u.startsWith("https://asx.api.markitdigital.com/")) return new Response(JSON.stringify(u.endsWith("/header") ? { data: { priceLast: 8816.9, priceChange: -28.8, priceChangePercent: -0.3256 } } : { data: { priceClose: 8845.7, priceDayHigh: 8845.7, priceDayLow: 8747.3 } }));
  if (u.startsWith("https://sistemaswebb3-listados.b3.com.br/")) { const q = JSON.parse(atob(u.slice("https://sistemaswebb3-listados.b3.com.br/indexStatisticsProxy/IndexCall/GetPortfolioDay/".length))); const y = Number(q.year), d = new Date(Date.now() - 3 * 3600e3); const prevDay = new Date(d.getTime() - 86400e3); const p2 = new Date(prevDay.getTime() - 86400e3), rows = [[p2, "204.000,00"], [prevDay, "205.096,23"]].filter(([t]) => t.getUTCFullYear() === y).map(([t, v]) => ({ day: t.getUTCDate(), ["rateValue" + (t.getUTCMonth() + 1)]: v })); return new Response(JSON.stringify({ results: rows })); }
  if (u.startsWith("https://api.stlouisfed.org/")) { const p = new URL(u).searchParams; if (p.get("api_key") !== KEYF) return new Response("{}", { status: 400 }); const id = p.get("series_id"); const v = { NASDAQCOM: 27500, SP500: 7790, NASDAQ100: 31000, DJIA: 51400, VIXCLS: 15 }[id]; return new Response(JSON.stringify({ observations: [{ date: ago(1), value: String(v) }, { date: ago(2), value: "." }, { date: ago(3), value: String(v - 50) }] })); }
  return new Response("", { status: 404 });
};
const call = async (path, env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", FRED_KEY: KEYF };

let r = await call("/api/indices", env);
ok("GET /api/indices: the catalog only (no source called)", r.status === 200 && r.j.groups.length === 8 && r.j.groups[0].indices[0].id === "SPX" && r.j.notConnected.length === 0 && calls.length === 0);
r = await call("/api/indices?g=us", env);
const by = (id) => r.j.indices.find((x) => x.id === id);
ok("US group: Cboe delayed rows LIVE with time, the Dow DERIVED (DJX × 100), the Nasdaq Composite from FRED (close)", r.status === 200 && by("SPX").status === "LIVE" && by("SPX").kind === "delayed" && by("SPX").delayMin === 15 && by("SPX").date === todayNY && by("DJI").status === "DERIVED" && by("DJI").last === 51232 && /DJX/.test(by("DJI").note) && by("COMP").kind === "close" && by("COMP").last === 27500 && by("COMP").prev === 27450 && by("COMP").date === ago(1) && /FRED/.test(by("COMP").source), JSON.stringify(r.j).slice(0, 600));
ok("US group: FRED key only in the request to FRED, never in the response", !r.text.includes(KEYF) && calls.filter((u) => u.includes(KEYF)).every((u) => u.startsWith("https://api.stlouisfed.org/")));
cboeDown = new Set(["_SPX", "_RUT"]); store = new Map(); calls = [];
r = await call("/api/indices?g=us", env);
ok("Cboe refused: S&P 500 = the official close from FRED (labelled); Russell 2000 (no FRED series) = the same index on CNBC, labelled BACKUP with Cboe's error", by("SPX").kind === "close" && by("SPX").last === 7790 && /FRED/.test(by("SPX").source) && /Cboe did not answer \(provider_forbidden\)/.test(by("SPX").note) && by("RUT").status === "LIVE" && by("RUT").last === 1234.5 && by("RUT").backupFor === "Cboe (15-min delayed)" && by("RUT").primaryError === "provider_forbidden" && /BACKUP/.test(by("RUT").source), JSON.stringify(by("RUT")).slice(0, 300));
store = new Map();
r = await call("/api/indices?g=us", { ...env, FRED_KEY: undefined });
ok("without FRED: S&P 500 from CNBC (BACKUP); the Nasdaq Composite (no CNBC symbol in the backup list) N/A (fred_not_configured)", by("SPX").status === "LIVE" && /BACKUP/.test(by("SPX").source) && by("COMP").status === "N/A" && by("COMP").error === "fred_not_configured" && by("NDX").status === "LIVE");
r = await call("/api/indices?g=eu", env);
ok("Europe: STOXX closes, change DERIVED from the previous close; a file that is not the data → N/A; not-connected ones listed", by("SX5E").last === 101.5 && by("SX5E").chg === 1.5 && by("SX5E").chgPct === 1.5 && by("SX5E").kind === "close" && by("SX5E").status === "LIVE" && by("MDAX").status === "N/A" && r.j.notConnected.length === 0);
ok("Europe: FTSE 100, CAC 40, FTSE MIB, AEX from CNBC's quote service in one request — level, change and CNBC's time, market data", by("UKX").last === 10733 && by("UKX").prev === 10700 && by("UKX").chg === 33 && by("UKX").chgPct === 0.31 && by("UKX").status === "LIVE" && /CNBC quote service.* · FTSE International/.test(by("UKX").source) && by("UKX").kind === "delayed" && by("FTSEMIB").last === 1234.5 && calls.filter((u) => u.startsWith("https://quote.cnbc.com/") && u.includes(".FTSE")).length === 1, JSON.stringify(by("UKX")));
ok("Europe: SMI and IBEX 35 from SIX (15-min delayed snapshot, change DERIVED); a valor SIX does not return → N/A", by("SMI").last === 14478.37 && by("SMI").kind === "delayed" && by("SMI").delayMin === 15 && by("SMI").status === "LIVE" && by("SMI").chg === 109.59 && by("IBEX").last === 19092.4 && by("IBEX").prev === 19039.3 && by("SPI").status === "N/A", JSON.stringify(by("SPI")));
r = await call("/api/indices?g=asia", env);
ok("Asia-Pacific: Nikkei with open/high/low; SSE Composite and CSI 300 from the Shanghai Stock Exchange; S&P/ASX 200 PARTIAL (no time); Nifty 50 not connected with its reason",
  by("N225").last === 70035.71 && by("N225").open === 70582.11 && by("SHCOMP").last === 3735.3704 && by("SHCOMP").status === "LIVE" && by("CSI300").kind === "delayed" && by("XJO").status === "PARTIAL" && by("XJO").asOf === null && by("XJO").chg === -28.8 && by("NIFTY").status === "LIVE" && by("HSI").last === 1234.5 && by("KOSPI").status === "N/A", JSON.stringify(r.j.indices.map((x) => [x.id, x.status, x.error])));
r = await call("/api/indices?g=world", env);
ok("Americas & global: Ibovespa = B3's daily close (its quote service refuses the server), change DERIVED from the close before; MSCI EAFE / EM / ACWI from Cboe", by("IBOV").last === 205096.23 && by("IBOV").prev === 204000 && by("IBOV").kind === "close" && by("IBOV").status === "LIVE" && !calls.some((u) => u.includes("cotacao.b3")) && by("MXEA").kind === "delayed" && by("MXEF").status === "LIVE" && by("MXACW").last === 629, JSON.stringify(by("IBOV")));
r = await call("/api/indices?g=zz", env);
ok("unknown group → 400", r.status === 400);
r = await call("/api/indices/history?id=NDX", env);
ok("history (Cboe): OHLC rows, oldest first, with the source", r.status === 200 && r.j.fields === "ohlc" && r.j.count === 3 && r.j.points[2].length === 5 && r.j.from === ago(400) && /Cboe/.test(r.j.source));
r = await call("/api/indices/history?id=SPX", env);
ok("history: Cboe refused → FRED closes (missing '.' value skipped), said so", r.status === 200 && r.j.fields === "close" && r.j.count === 2 && r.j.points[1].join() === `${ago(1)},7790` && /FRED/.test(r.j.note));
r = await call("/api/indices/history?id=DAX", env);
ok("history (STOXX): closes only, the 3-month limit stated", r.j.fields === "close" && r.j.count === 2 && /3 months/.test(r.j.note));
r = await call("/api/indices/history?id=SMI", env);
ok("history (SIX): daily closes", r.status === 200 && r.j.count === 3 && r.j.points[2].join() === `${ago(1)},14368.78` && /SIX/.test(r.j.source));
r = await call("/api/indices/history?id=SHCOMP", env);
ok("history (SSE): daily open/high/low/close", r.status === 200 && r.j.fields === "ohlc" && r.j.count === 2);
r = await call("/api/indices/history?id=IBOV", env);
ok("history (B3): daily closes of this year and the last", r.status === 200 && r.j.count >= 1 && /B3/.test(r.j.source) && /one year at a time/.test(r.j.note));
r = await call("/api/indices/history?id=XJO", env);
ok("history (ASX): none published → N/A no_history, said so", r.status === 502 && r.j.error === "no_history" && /ASX publishes no free history/.test(r.j.note));
r = await call("/api/indices/history?id=RUT", env);
ok("history: Cboe refused and no stand-in → 502 N/A", r.status === 502 && r.j.status === "N/A" && !r.j.points);
r = await call("/api/indices/history?id=FTSEMIB", env);
ok("history of a CNBC index: daily bars with open/high/low/close, oldest first, labelled as CNBC dates them", r.status === 200 && r.j.fields === "ohlc" && r.j.points.length === 3 && r.j.points[2][4] === 10640 && /CNBC/.test(r.j.source) && /dated as CNBC/.test(r.j.note), JSON.stringify(r.j).slice(0, 300));
r = await call("/api/indices/history?id=NOPE", env);
ok("history of an unknown index → 400", r.status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
