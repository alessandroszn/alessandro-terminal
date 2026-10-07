// World indices (approved 7 Oct 2026): parsers on fixtures in each source's own format (copied from real responses),
// the /api/indices endpoints with mocked sources, the FRED stand-in when Cboe does not answer.
// Fixtures are test data only; nothing here is shown in the terminal.
//   node test/indices.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseCboeQuote, parseCboeHist, parseStoxx, parseNikkei, closeRow, cboeTime, tooOld, INDICES, NOT_CONNECTED, GROUPS } from "../src/indices.mjs";

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
ok("catalog: every index in one group; groups small enough for the subrequest limit; not-connected ones named", INDICES.every((x) => GROUPS.some(([g]) => g === x.g)) && GROUPS.every(([g]) => INDICES.filter((x) => x.g === g).length + INDICES.filter((x) => x.g === g && x.fred).length <= 10) && NOT_CONNECTED.map((x) => x[1]).join() === "FTSE 100,CAC 40,FTSE MIB,SMI,Hang Seng");

// ---------- endpoints with mocked sources ----------
let store = new Map();
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const ctx = { waitUntil: () => {} };
const KEYF = "fred-test-key-222";
const NOW = new Date(), todayNY = NOW.toLocaleDateString("en-CA", { timeZone: "America/New_York" }), ymd = (d) => d.toISOString().slice(0, 10);
const ago = (n) => ymd(new Date(Date.now() - n * 86400_000));
let calls = [], cboeDown = new Set();
const nyClock = (t) => new Date(t).toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T");
globalThis.fetch = async (u) => {
  u = String(u); calls.push(u);
  const m = /cdn-api\.cboe\.com\/api\/global\/delayed_quotes\/(quotes|charts\/historical)\/(_[A-Z]+)\.json$/.exec(u);
  if (m) {
    if (cboeDown.has(m[2])) return new Response("denied", { status: 403 });
    const base = { _SPX: 7800, _NDX: 31100, _DJX: 512.32, _RUT: 2797, _VIX: 15.15, _MXEA: 3088, _MXEF: 1726 }[m[2]];
    if (m[1] === "quotes") return new Response(JSON.stringify({ timestamp: new Date().toISOString().slice(0, 19).replace("T", " "), data: { current_price: base, price_change: -1, price_change_percent: -0.1, open: base + 1, high: base + 2, low: base - 3, prev_day_close: base + 1, last_trade_time: nyClock(Date.now() - 15 * 60e3) } }));
    return new Response(JSON.stringify({ data: [400, 300, 3].map((n, i) => ({ date: ago(n), open: String(base - 10 + i), high: String(base - 5 + i), low: String(base - 20 + i), close: String(base - 8 + i) })) }));
  }
  if (u.startsWith("https://www.stoxx.com/document/Indices/Current/HistoricalData/")) { const f = u.split("/").pop().replace(".txt", ""); if (f === "h_3mmdax") return new Response("<html>not found</html>"); const d1 = ago(2).split("-").reverse().join("."), d2 = ago(1).split("-").reverse().join("."); return new Response(`Date;Symbol;Indexvalue;\n${d1};X;100.00;\n${d2};X;101.50;\n`); }
  if (u === "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_daily_en.csv") return new Response(`Date of Data,Close,Open,High,Low\n"${ago(2).replace(/-/g, "/")}","69900","69000","70100","68900"\n"${ago(1).replace(/-/g, "/")}","70035.71","70582.11","70793.29","70017.19"\n`);
  if (u.startsWith("https://api.stlouisfed.org/")) { const p = new URL(u).searchParams; if (p.get("api_key") !== KEYF) return new Response("{}", { status: 400 }); const id = p.get("series_id"); const v = { NASDAQCOM: 27500, SP500: 7790, NASDAQ100: 31000, DJIA: 51400, VIXCLS: 15 }[id]; return new Response(JSON.stringify({ observations: [{ date: ago(1), value: String(v) }, { date: ago(2), value: "." }, { date: ago(3), value: String(v - 50) }] })); }
  return new Response("", { status: 404 });
};
const call = async (path, env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", FRED_KEY: KEYF };

let r = await call("/api/indices", env);
ok("GET /api/indices: the catalog only (no source called)", r.status === 200 && r.j.groups.length === 3 && r.j.groups[0].indices[0].id === "SPX" && r.j.notConnected.length === 5 && calls.length === 0);
r = await call("/api/indices?g=us", env);
const by = (id) => r.j.indices.find((x) => x.id === id);
ok("US group: Cboe delayed rows LIVE with time, the Dow DERIVED (DJX × 100), the Nasdaq Composite from FRED (close)", r.status === 200 && by("SPX").status === "LIVE" && by("SPX").kind === "delayed" && by("SPX").delayMin === 15 && by("SPX").date === todayNY && by("DJI").status === "DERIVED" && by("DJI").last === 51232 && /DJX/.test(by("DJI").note) && by("COMP").kind === "close" && by("COMP").last === 27500 && by("COMP").prev === 27450 && by("COMP").date === ago(1) && /FRED/.test(by("COMP").source), JSON.stringify(r.j).slice(0, 600));
ok("US group: FRED key only in the request to FRED, never in the response", !r.text.includes(KEYF) && calls.filter((u) => u.includes(KEYF)).every((u) => u.startsWith("https://api.stlouisfed.org/")));
cboeDown = new Set(["_SPX", "_RUT"]); store = new Map(); calls = [];
r = await call("/api/indices?g=us", env);
ok("Cboe refused: S&P 500 = the official close from FRED (labelled), Russell 2000 N/A (no stand-in)", by("SPX").kind === "close" && by("SPX").last === 7790 && /FRED/.test(by("SPX").source) && /Cboe did not answer \(provider_forbidden\)/.test(by("SPX").note) && by("RUT").status === "N/A" && by("RUT").error === "provider_forbidden" && by("RUT").last === undefined);
store = new Map();
r = await call("/api/indices?g=us", { ...env, FRED_KEY: undefined });
ok("without FRED: S&P 500 N/A too, the Nasdaq Composite N/A (fred_not_configured)", by("SPX").status === "N/A" && by("COMP").status === "N/A" && by("COMP").error === "fred_not_configured" && by("NDX").status === "LIVE");
r = await call("/api/indices?g=eu", env);
ok("Europe: STOXX closes, change DERIVED from the previous close; a file that is not the data → N/A; not-connected ones listed", by("SX5E").last === 101.5 && by("SX5E").chg === 1.5 && by("SX5E").chgPct === 1.5 && by("SX5E").kind === "close" && by("SX5E").status === "LIVE" && by("MDAX").status === "N/A" && r.j.notConnected.map((x) => x.name).join() === "FTSE 100,CAC 40,FTSE MIB,SMI");
r = await call("/api/indices?g=world", env);
ok("Asia & global: Nikkei with open/high/low; MSCI EAFE / EM from Cboe", by("N225").last === 70035.71 && by("N225").open === 70582.11 && by("MXEA").kind === "delayed" && by("MXEF").status === "LIVE");
r = await call("/api/indices?g=zz", env);
ok("unknown group → 400", r.status === 400);
r = await call("/api/indices/history?id=NDX", env);
ok("history (Cboe): OHLC rows, oldest first, with the source", r.status === 200 && r.j.fields === "ohlc" && r.j.count === 3 && r.j.points[2].length === 5 && r.j.from === ago(400) && /Cboe/.test(r.j.source));
r = await call("/api/indices/history?id=SPX", env);
ok("history: Cboe refused → FRED closes (missing '.' value skipped), said so", r.status === 200 && r.j.fields === "close" && r.j.count === 2 && r.j.points[1].join() === `${ago(1)},7790` && /FRED/.test(r.j.note));
r = await call("/api/indices/history?id=DAX", env);
ok("history (STOXX): closes only, the 3-month limit stated", r.j.fields === "close" && r.j.count === 2 && /3 months/.test(r.j.note));
r = await call("/api/indices/history?id=RUT", env);
ok("history: Cboe refused and no stand-in → 502 N/A", r.status === 502 && r.j.status === "N/A" && !r.j.points);
r = await call("/api/indices/history?id=FTSEMIB", env);
ok("history of an index without a source → 400", r.status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
