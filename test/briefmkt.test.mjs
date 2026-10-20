// Markets in the briefings (20 Oct 2026): world indices, the ECB fixing, energy, crypto pairs, IMF prices — staged one per
// minute by the scheduled run, read only from the staged copies when an edition is written (also by the terminal).
// Fixtures are test data in the providers' formats; nothing here is shown in the terminal.
//   node test/briefmkt.test.mjs
import worker, { app } from "../src/worker.mjs";
import { stepsFor } from "../src/cron.mjs";
import { refChange, ecbCross, fxMoves, cryptoPick, marketLines } from "../src/briefmkt.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
const at = (s) => Date.parse(s);
const p2 = (a, b) => ((a / b - 1) * 100).toFixed(2);

// ---------- units ----------
ok("period change: last value vs the last one on or before the reference date; none when the series does not reach back", JSON.stringify(refChange([["2026-09-24", 100], ["2026-09-25", 110], ["2026-10-02", 121]], "2026-09-26")) === JSON.stringify({ chg: 10.000000000000009, last: 121, lastDate: "2026-10-02", base: 110, baseDate: "2026-09-25" }) && refChange([["2026-09-30", 1], ["2026-10-02", 2]], "2026-09-26") === null);
ok("ECB crosses: EUR/x as published, x/y through the euro rates of the same fixing", ecbCross("EUR", "GBP", { GBP: 0.87 }) === 0.87 && Math.abs(ecbCross("USD", "CHF", { USD: 1.125, CHF: 0.9 }) - 0.8) < 1e-12 && Math.abs(ecbCross("AUD", "USD", { USD: 1.1, AUD: 1.65 }) - 1.1 / 1.65) < 1e-12 && ecbCross("USD", "SEK", { USD: 1.1 }) === null);
const mkFx = { refDate: "2026-09-26", ecb: { series: { USD: [["2026-09-25", 1.1], ["2026-10-01", 1.12], ["2026-10-02", 1.125]], CHF: [["2026-09-25", 0.95], ["2026-10-01", 0.92], ["2026-10-02", 0.9]], GBP: [["2026-09-25", 0.86], ["2026-10-02", 0.87]] } } };
const fm = fxMoves(mkFx), uc = fm.find((x) => x.pair === "USD/CHF"), eg = fm.find((x) => x.pair === "EUR/GBP");
ok("ECB moves: one fixing date for every cross; previous and reference fixings taken on the dollar's dates only (a currency missing that day has no change, never an older value)", uc.date === "2026-10-02" && Math.abs(uc.value - 0.8) < 1e-12 && uc.prevDate === "2026-10-01" && p2(0.9 / 1.125, 0.92 / 1.12) === uc.chg.toFixed(2) && uc.ref.baseDate === "2026-09-25" && eg.chg === null && eg.ref.chg.toFixed(2) === p2(0.87, 0.86) && uc.derived && !eg.derived, JSON.stringify(fm));
const cr = cryptoPick([..."ABCDEFGH"].map((c, i) => ({ sym: c + "/USD", dv: 100 - i, chg: i === 7 ? 9 : i === 6 ? -8 : 1 })), "daily");
ok("crypto lines: the six most traded pairs, then the largest rise and fall when they are not among them", cr.map((r) => r.sym).join() === "A/USD,B/USD,C/USD,D/USD,E/USD,F/USD,H/USD,G/USD");
const ml = marketLines("daily", { indices: [], ecb: null, energy: { spot: [{ name: "WTI crude (Cushing)", unit: "$/bbl", value: 61.23, date: "2026-09-28", chg1: -1.5, chg5: 2 }], source: "EIA via FRED" }, crypto: null, imf: null });
ok("energy line: the price with its own date and the publication lag; the daily edition gives the change vs the previous published day only", ml.lines[0] === "ENERGY WTI crude (Cushing): 61.23 $/bbl on 2026-09-28, -1.50% vs the previous published day [EIA via FRED; published with a lag of about a week]", ml.lines[0]);

// ---------- first Saturday (weekly + monthly): the whole staging with every source answering ----------
const days = []; for (let t = at("2026-08-17T12:00:00Z"); t <= at("2026-10-02T12:00:00Z"); t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const allDays = []; for (let t = at("2026-08-17T12:00:00Z"); t <= at("2026-10-03T12:00:00Z"); t += 86400_000) allDays.push(new Date(t).toISOString().slice(0, 10));
const lvl = (base, i) => Math.round((base + i * 3.7) * 100) / 100;
const HBASE = { _SPX: 6400, _NDX: 23500, _DJX: 440, _RUT: 2300, _VIX: 15, _MXEA: 2800, _MXEF: 1300, _MXACW: 600, _OEX: 3700, _RUI: 4000, SMI: 14000, IBEX: 18500, SPI: 20000, SHCOMP: 3600, CSI300: 4100, IBOV: 190000 };
const hist = (sym) => days.map((d, i) => [d, lvl(HBASE[sym] || 100, i)]);
const SX = { h_3msx5e: 5400, h_3msxxp: 560, h_3mdax: 23800, h_3mmdax: 30100, h_3msx7e: 210 };
const FRED = { NASDAQCOM: [22000, "D"], DCOILWTICO: [64, "E"], DCOILBRENTEU: [67, "E"], DGASNYH: [2.1, "E"], DHOILNYH: [2.3, "E"], DDFUELNYH: [2.35, "E"], DJFUELUSGULF: [2.2, "E"], DPROPANEMBTX: [0.7, "E"], DHHNGSP: [2.9, "E"] };
const eDays = days.filter((d) => d <= "2026-09-28"); // EIA: published with a lag
const CRY = { "BTC/USD": [110000, 900], "ETH/USD": [4100, 9000], "SOL/USD": [200, 900000], "XRP/USD": [2.8, 5e7], "DOGE/USD": [0.25, 4e8], "AVAX/USD": [30, 1e6], "LINK/USD": [22, 2e6], "LTC/USD": [110, 5e5], "UNI/USD": [9, 1e5] };
const cryClose = (s, i) => Math.round(CRY[s][0] * (1 + (s === "UNI/USD" ? -0.01 : 0.002) * i) * 1e4) / 1e4;
let calls = [];
const kind = (u) => /cdn-api\.cboe\.com/.test(u) ? "CBOE" : /six-group/.test(u) ? "SIX" : /sse\.com\.cn/.test(u) ? "SSE" : /b3\.com\.br/.test(u) ? "B3" : /nseindia/.test(u) ? "NSE" : /markitdigital/.test(u) ? "ASX" : /stoxx\.com/.test(u) ? "STOXX" : /nikkei/.test(u) ? "NIKKEI" : /service\/data\/EXR/.test(u) ? "ECBFX" : /stlouisfed/.test(u) ? "FRED" : /crypto\/us\/bars/.test(u) ? "CRYPTO" : /twelvedata/.test(u) ? "TD" : "OTHER";
globalThis.fetch = async (u) => {
  u = String(u); calls.push(u); const k = kind(u);
  if (k === "CBOE") {
    const q = /quotes\/(_[A-Z]+)\.json/.exec(u), h = /historical\/(_[A-Z]+)\.json/.exec(u);
    if (q) { const s = hist(q[1]), l = s[s.length - 1], p = s[s.length - 2]; return new Response(JSON.stringify({ timestamp: "2026-10-03 05:30:00", data: { current_price: l[1], prev_day_close: p[1], open: p[1], high: l[1], low: p[1], price_change: Math.round((l[1] - p[1]) * 100) / 100, price_change_percent: ((l[1] - p[1]) / p[1]) * 100, last_trade_time: "2026-10-02T16:00:00" } })); }
    if (h) return new Response(JSON.stringify({ symbol: h[1], data: hist(h[1]).map(([date, c]) => ({ date, open: c, high: c, low: c, close: c, volume: 0 })) }));
  }
  if (k === "STOXX") { const f = /HistoricalData\/(h_3m[a-z0-9]+)\.txt/.exec(u)[1], b = SX[f] || 400 + f.length * 37; return new Response("Date;Symbol;Indexvalue;\n" + days.slice(-60).map((d, i) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)};X;${f === "h_3msxap" ? lvl(b, -i) : lvl(b, i)};`).join("\n") + "\n"); }
  const SIXID = { CH0009980894CHF9: "SMI", CH0009987501CHF9: "SPI", ES0SI0000005EUR9: "IBEX" }, SSEID = { "000001": "SHCOMP", "000300": "CSI300" };
  if (k === "SIX") { const id = SIXID[/ValorId=([A-Z0-9]+)/.exec(u)[1]], H = hist(id), l = H[H.length - 1], p = H[H.length - 2];
    if (/snap\.json/.test(u)) return new Response(JSON.stringify({ colNames: ["ValorId", "ClosingPrice", "ClosingPerformance", "ClosingDelta", "PreviousClosingPrice", "MarketDate", "MarketTime"], rowData: [["x", l[1], 0, 0, p[1], Number(l[0].replace(/-/g, "")), 173000]] }));
    return new Response(JSON.stringify({ valors: [{ data: { Date: H.map((x) => Number(x[0].replace(/-/g, ""))), Close: H.map((x) => x[1]) } }] })); }
  if (k === "SSE") { const id = SSEID[/\/(\d{6})(\?|$)/.exec(u)[1]], H = hist(id), l = H[H.length - 1], p = H[H.length - 2];
    if (/\/snap\//.test(u)) return new Response(JSON.stringify({ date: Number(l[0].replace(/-/g, "")), time: 150002, snap: [id, p[1], p[1], l[1], p[1], l[1], 0, 0] }));
    return new Response(JSON.stringify({ kline: H.map(([d, c]) => [Number(d.replace(/-/g, "")), c, c, c, c]) })); }
  if (k === "B3") { const H = hist("IBOV"), l = H[H.length - 1];
    if (/instrumentQuotation/.test(u)) return new Response(JSON.stringify({ Msg: { dtTm: l[0] + " 17:10:00" }, Trad: [{ scty: { SctyQtn: { curPrc: l[1], prcFlcn: 0.5, opngPric: l[1], minPric: l[1], maxPric: l[1] } } }] }));
    const y = JSON.parse(atob(u.slice("https://sistemaswebb3-listados.b3.com.br/indexStatisticsProxy/IndexCall/GetPortfolioDay/".length))).year;
    return new Response(JSON.stringify({ results: H.filter(([d]) => d.startsWith(y)).map(([d, c]) => ({ day: Number(d.slice(8, 10)), ["rateValue" + Number(d.slice(5, 7))]: c.toFixed(2).replace(".", ",") })) })); }
  if (k === "NSE") { const m = /_(\d{2})(\d{2})(\d{4})\.csv$/.exec(u), d = `${m[3]}-${m[2]}-${m[1]}`, i = days.indexOf(d); if (i < 0) return new Response("nf", { status: 404 });
    const c = lvl(22000, i), b = lvl(52000, i); return new Response(`Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%)\nNifty 50,${m[1]}-${m[2]}-${m[3]},${c},${c},${c},${c},3.7,0.02\nNifty Bank,${m[1]}-${m[2]}-${m[3]},${b},${b},${b},${b},3.7,0.01\n`); }
  if (k === "ASX") return new Response(JSON.stringify(u.endsWith("/header") ? { data: { priceLast: 8816.9, priceChange: -28.8, priceChangePercent: -0.3256 } } : { data: { priceClose: 8845.7, priceDayHigh: 8845.7, priceDayLow: 8747.3 } }));
  if (k === "NIKKEI") return new Response('"Date of Data","Close","Open","High","Low"\n' + days.map((d, i) => `"${d.replace(/-/g, "/")}","${lvl(45000, i)}","${lvl(45000, i)}","${lvl(45000, i)}","${lvl(45000, i)}"`).join("\n") + "\n");
  if (k === "ECBFX") { const n = Number(new URL(u).searchParams.get("lastNObservations")); return new Response("KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n" + [["USD", 1.16], ["GBP", 0.86], ["JPY", 172], ["CHF", 0.94], ["SEK", 11.1]].flatMap(([c, v]) => days.slice(-n).map((d, i) => `EXR.D.${c}.EUR.SP00.A,D,${c},EUR,SP00,A,${d},${Math.round(v * (1 + (c === "CHF" ? -0.001 : 0.0005) * i) * 1e4) / 1e4}`)).join("\n") + "\n"); }
  if (k === "FRED") {
    const id = new URL(u).searchParams.get("series_id"), lim = Number(new URL(u).searchParams.get("limit"));
    if (/USDM$/.test(id)) return new Response(JSON.stringify({ observations: ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"].map((m, i) => ({ date: m + "-01", value: String(1000 + i * 10) })).reverse().slice(0, lim) }));
    const f = FRED[id]; if (!f) return new Response("", { status: 503 });
    const ds = f[1] === "E" ? eDays : days;
    return new Response(JSON.stringify({ observations: ds.map((d, i) => ({ date: d, value: String(Math.round(f[0] * (1 + 0.001 * i) * 1000) / 1000) })).reverse().slice(0, lim) }));
  }
  if (k === "CRYPTO") {
    const q = new URL(u).searchParams, start = q.get("start").slice(0, 10), end = q.get("end").slice(0, 10), bars = {};
    for (const s of q.get("symbols").split(",")) if (CRY[s]) bars[s] = allDays.map((d, i) => [d, i]).filter(([d]) => d >= start && d <= end).map(([d, i]) => ({ t: d + "T00:00:00Z", c: cryClose(s, i), v: CRY[s][1] }));
    return new Response(JSON.stringify({ bars }));
  }
  if (k === "TD" && /\/quote/.test(u)) { const syms = new URL(u).searchParams.get("symbol").split(","); return new Response(JSON.stringify(Object.fromEntries(syms.map((x) => [x, { symbol: x, name: x, currency: "USD", datetime: "2026-10-02", timestamp: 1791000000, close: "1.2", previous_close: "1.1", percent_change: "0.5", is_market_open: false }])))); }
  if (k === "TD") return new Response(JSON.stringify({ status: "error", code: 400, message: "test" }));
  return new Response("", { status: 404 });
};
const cstore = new Map();
globalThis.caches = { default: { match: async (r) => { const key = typeof r === "string" ? r : r.url; return cstore.has(key) ? new Response(cstore.get(key)) : undefined; }, put: async (r, res) => { cstore.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const kv = new Map();
let kvReads = [];
const BRIEFS = { get: async (k) => { kvReads.push(k); return kv.get(k) ?? null; }, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
const AI = { run: async () => ({ response: "TITLE: A week of markets\n## The week in one paragraph\nIndices moved." }) };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", BRIEFS, AI, ALPACA_KEY_ID: "test-id", ALPACA_SECRET_KEY: "test-secret", TWELVEDATA_KEY: "TESTKEY_x", FRED_KEY: "fred-test-key-444" };
const realNow = Date.now;
async function tick(iso) {
  const t = at(iso); Date.now = () => t; calls = [];
  const pending = []; await worker.scheduled({ scheduledTime: t, cron: "* 5-7 * * *" }, env, { waitUntil: (x) => pending.push(x) }); await Promise.all(pending);
  return calls.slice();
}
const WM = stepsFor(["weekly", "monthly"]), S0 = 60 - WM.length - 2;
const perStep = {};
for (let m = S0; m < 60; m++) { const c = await tick(`2026-10-03T05:${String(m).padStart(2, "0")}:00Z`); if (m - S0 < WM.length) perStep[WM[m - S0]] = c.map(kind); }
ok("staging: each index history in its own minute (one Cboe file), the energy series from FRED in one, the IMF prices in one, crypto closes now and a week / a month ago",
  ["idxh:SPX", "idxh:NDX", "idxh:DJI", "idxh:RUT", "idxh:VIX", "idxh:MXEF", "idxh:MXACW"].every((s) => perStep[s].join() === "CBOE") && perStep["idxh:SMI"].join() === "SIX" && perStep["idxh:SHCOMP"].join() === "SSE" && !perStep["idxh:IBOV"] && !perStep["idxh:NIFTY"] && !perStep["idxh:MXEA"] && perStep.energy.every((x) => x === "FRED") && perStep.energy.length === 8 && perStep.imf.length === 11 && perStep.crypto.join() === "CRYPTO" && perStep["crypto:1W"].join() === "CRYPTO" && perStep["crypto:1M"].join() === "CRYPTO", JSON.stringify(perStep));
ok("staging: what was staged — index quotes and histories, ECB 25 fixings, energy, crypto, IMF — in KV", ["stage/idx/q/SPX", "stage/idx/h/SPX", "stage/idx/h/MXEF", "stage/idx/stoxx/h_3mdax", "stage/idx/nikkei", "stage/idx/fred/NASDAQCOM", "stage/mkt/ecbfx/n25", "stage/fred/energy/v1", "stage/map/CRYPTO/closes/recent/2026-10-03", "stage/map/CRYPTO/closes/1W/2026-09-26", "stage/mkt/imf/v1", "stage/idx/tail/SPX", "stage/idx/tail/NDX", "stage/idx/tail/SMI", "stage/idx/tail/SHCOMP", "stage/idx/b3/h/IBOV"].every((k) => kv.has(k)) && JSON.parse(kv.get("stage/idx/tail/SPX")).data.length === Math.min(60, days.length), [...kv.keys()].filter((k) => k.startsWith("stage/")).join());
kvReads = [];
let c = await tick("2026-10-03T06:00:00Z");
const wk = JSON.parse(kv.get("brief/weekly-2026-10-03") || "null"), D = wk ? wk.inputData : "";
ok("weekly written at 08:00 from staged data only (no source called)", !!wk && wk.writtenBy === "schedule" && c.length === 0, c.join());
ok("weekly: the index histories read for the edition are the staged 60-row tails, not the ten-year files", kvReads.filter((k) => /^stage\/idx\/h\//.test(k)).length === 0 && kvReads.filter((k) => /^stage\/idx\/tail\//.test(k)).length === 11 && new Set(kvReads.filter((k) => k.startsWith("stage/idx/"))).size === kvReads.filter((k) => k.startsWith("stage/idx/")).length, JSON.stringify(kvReads.filter((k) => k.startsWith("stage/idx/"))));
const H = hist("_SPX"), i25 = H.findIndex(([d]) => d === "2026-09-25");
ok("weekly: each index's week change from its own daily history — close of Fri 2 Oct vs Fri 25 Sep (the last close on or before 26 Sep)",
  D.includes(`INDEX_1W S&P 500 (SPX): +${p2(H[H.length - 1][1], H[i25][1])}% — close ${H[H.length - 1][1]} on 2026-10-02 vs ${H[i25][1]} on 2026-09-25 [Cboe (daily history)]`) && /INDEX_1W DAX \(DAX\): \+[\d.]+% — close [\d.]+ on 2026-10-02 vs [\d.]+ on 2026-09-25 \[STOXX \(daily close\)\]/.test(D) && /INDEX_1W Nikkei 225 \(N225\): .* vs [\d.]+ on 2026-09-25 \[Nikkei/.test(D) && /INDEX_1W Nasdaq Composite \(COMP\): .*\[FRED/.test(D) && /INDEX_1W Dow Jones Industrial Average \(DJI\)/.test(D),
  D.split("\n").filter((l) => l.startsWith("INDEX")).slice(0, 4).join("\n"));
const W1 = D.split("\n").filter((l) => l.startsWith("INDEX_1W "));
ok("weekly: the week's change of the other markets from their own histories — SMI / IBEX (SIX), SSE Composite / CSI 300 (SSE), Ibovespa (B3's daily closes); no S&P/ASX 200 (no time), no Nifty (NSE refuses the server)",
  W1.some((l) => l.includes("(SMI)") && l.includes("[SIX (daily closes)]")) && W1.some((l) => l.includes("(IBEX)")) && W1.some((l) => l.includes("(SHCOMP)") && l.includes("Shanghai Stock Exchange")) && W1.some((l) => l.includes("(CSI300)"))
  && W1.some((l) => l.includes("(IBOV)") && l.includes("[B3")) && !D.includes("S&P/ASX") && !D.includes("NIFTY"), W1.slice(9).join("\n"));
ok("weekly: STOXX Europe 600 sectors — the three strongest and the three weakest of the week", (D.match(/^SECTOR_EU /gm) || []).length === 6 && /SECTOR_EU STOXX Europe 600 Automobiles and Parts: -[\d.]+% \(1W\)/.test(D));
ok("weekly: index level and day change too (the Friday close as the delayed quote shows it on Saturday)", /INDEX United States — S&P 500 \(SPX\): [\d.]+, \+[\d.]+% vs previous close [\d.]+; 15-minute delayed quote, last trade 2026-10-02 20:00 UTC/.test(D));
ok("weekly: ECB fixing with its week change vs the fixing of 25 Sep; energy with its own date (28 Sep) and the 5-session change; crypto with the change vs the close of 26 Sep (UTC days)",
  /FX_ECB EUR\/CHF: [\d.]+ — ECB fixing of 2026-10-02, -[\d.]+% vs the fixing of 2026-10-01; 1W change -[\d.]+% vs the fixing of 2026-09-25/.test(D) && /FX_ECB USD\/SEK: [\d.]+ — ECB fixing of 2026-10-02 \(DERIVED/.test(D) && !/FX_ECB USD\/CAD/.test(D)
  && /ENERGY WTI crude \(Cushing\): [\d.]+ \$\/bbl on 2026-09-28, \+[\d.]+% vs the previous published day, \+[\d.]+% over 5 sessions \[U\.S\. Energy Information Administration \(EIA\) spot prices, via FRED; published with a lag of about a week\]/.test(D)
  && /CRYPTO `SOL\/USD`: close [\d.]+ USD on the UTC day 2026-10-02, \+[\d.]+% vs the close of 2026-10-01; 1W change \+[\d.]+% vs the close of 2026-09-26/.test(D) && /CRYPTO `UNI\/USD`: .*-[\d.]+%/.test(D) && !/CRYPTO `BTC\/USD`/.test(D) && !/CMDTY_MONTHLY/.test(D),
  D.split("\n").filter((l) => /^(FX_ECB|ENERGY|CRYPTO)/.test(l)).slice(0, 6).join("\n"));
ok("weekly: windows — the largest index move (IDX, 3M), the largest ECB move (MKT), energy with its date (CMDTY)", wk.windows.some((w) => w.type === "IDX" && w.state.rng === "3M" && / 1W$/.test(w.label)) && wk.windows.some((w) => w.type === "MKT") && wk.windows.some((w) => w.type === "CMDTY" && /2026-09-28/.test(w.label)) && wk.windows.every((w) => w.label_it && w.why_it), JSON.stringify(wk.windows.map((w) => [w.type, w.label])));
ok("weekly: sources list the index publishers, the ECB, EIA via FRED, Alpaca crypto", ["Cboe (15-min delayed)", "STOXX (daily close)", "ECB euro reference rates (daily fixing around 16:00 CET)", "U.S. Energy Information Administration (EIA) spot prices, via FRED", "Alpaca crypto daily closes (US venues, UTC days)"].every((n) => wk.sources.some((s) => s.name === n)), JSON.stringify(wk.sources.map((s) => s.name)));
await tick("2026-10-03T06:02:00Z");
const mo = JSON.parse(kv.get("brief/monthly-2026-10-03") || "null"), MD = mo ? mo.inputData : "";
ok("monthly: month change vs the last close on or before 3 Sep; IMF monthly averages with the month and year-on-year change", !!mo && /INDEX_1M S&P 500 \(SPX\): \+[\d.]+% — close [\d.]+ on 2026-10-02 vs [\d.]+ on 2026-09-03/.test(MD) && /CMDTY_MONTHLY Copper: 1120 \$\/t, average of 2026-08, \+0\.90% vs 2026-07, \+12\.00% vs a year earlier \[IMF Primary Commodity Prices via FRED\]/.test(MD) && /over 21 sessions/.test(MD) && /1M change [+-][\d.]+% vs the close of 2026-09-03/.test(MD),
  MD.split("\n").filter((l) => /^(INDEX_1M|CMDTY_MONTHLY|CRYPTO)/.test(l)).slice(0, 4).join("\n"));
ok("the keys never reach an edition", !JSON.stringify(wk).includes("fred-test-key-444") && !JSON.stringify(mo).includes("fred-test-key-444") && !JSON.stringify(wk).includes("TESTKEY_x"));

// ---------- the terminal writes an edition: the markets come from the staged copies, no source is called for them ----------
Date.now = () => at("2026-10-03T06:30:00Z"); calls = [];
const res = await app.fetch(new Request("https://alessandrozanichelli.com/api/briefs/write?period=weekly&force=1", { method: "POST" }), env, { waitUntil: () => {} });
const tw = await res.json();
ok("terminal REWRITE: the index levels, ECB fixing, energy and crypto lines come from the staged copies (no Cboe, STOXX, Nikkei, ECB, FRED energy or Alpaca crypto call)", res.status === 200 && tw.writtenBy === "terminal" && /INDEX_1W S&P 500/.test(tw.inputData) && /FX_ECB EUR\/GBP/.test(tw.inputData) && /ENERGY WTI/.test(tw.inputData) && /CRYPTO `SOL\/USD`/.test(tw.inputData) && !calls.some((u) => ["CBOE", "STOXX", "NIKKEI", "ECBFX", "CRYPTO"].includes(kind(u)) || /DCOIL|NASDAQCOM/.test(u)), calls.map(kind).join());
Date.now = realNow;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
