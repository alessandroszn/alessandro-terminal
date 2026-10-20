// WORLD INDICES (IDX) — approved 7 Oct 2026 (Cboe, STOXX, Nikkei, FRED) and 20 Oct 2026 (SIX, Shanghai Stock Exchange, B3, ASX;
// NSE was approved too but refuses the server): free publications of the index providers and the exchanges, nothing estimated.
//   GET /api/indices?g=us|vol|eu|sec|sec2|asia|world   the indices of one group: last level, change, day range, time, source
//   GET /api/indices                                   the catalog only (groups, names, sources, what is not connected)
//   GET /api/indices/history?id=SPX                    daily closes (open/high/low too when published) for the chart and the
//                                                      1M / YTD / 52-week figures the page derives
// Sources:
//   Cboe delayed quotes, 15 minutes (cdn-api.cboe.com): S&P 500, S&P 100, Nasdaq-100, Dow (Cboe DJX = 1/100 of the DJIA, ×100:
//     DERIVED), Russell 1000 / 2000, VIX and the other Cboe volatility indices, MSCI EAFE / EM / ACWI; daily history since 1975
//   STOXX Ltd. daily closes, last 3 months (stoxx.com): EURO STOXX 50, EURO STOXX, STOXX Europe 50 / 600 and its sectors, DAX,
//     MDAX, TecDAX, EURO STOXX Banks
//   Nikkei Inc. daily CSV: Nikkei 225 · FRED: Nasdaq Composite (and the official closes standing in when Cboe does not answer)
//   SIX (six-group.com data service, 15-min delayed snapshot + daily closes): SMI, SPI, IBEX 35 (BME belongs to SIX)
//   Shanghai Stock Exchange (yunhq.sse.com.cn, port 32042): SSE Composite, CSI 300 — snapshot and daily bars
//   B3 (the daily closes of B3's index statistics, one year per file): Ibovespa, as its daily close — B3's quote service
//     (cotacao.b3.com.br) answers the server with an error (Cloudflare 526, checked 20 Oct 2026)
//   ASX's data vendor (asx.api.markitdigital.com): S&P/ASX 200 — level and change without a time (PARTIAL), no history
// Not connected: FTSE 100, CAC 40, FTSE MIB, Hang Seng, KOSPI, S&P/TSX (no free official source); Nifty 50 (NSE answers the
// server with an error, Cloudflare 520, checked 20 Oct 2026).
// The index providers and exchanges reserve redistribution: the values are shown only in this private terminal, each with its source.
// A group stays small (≤ 12 fetches with the FRED stand-ins) so one request keeps within the Worker's limits.
import { fetchText, cachedSource, parseCsv, iso, easternToUtc } from "./lib.mjs";
import { fredSeries } from "./yields.mjs";

export const CBOE_Q = (sym) => `https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/${sym}.json`;
export const CBOE_H = (sym) => `https://cdn-api.cboe.com/api/global/delayed_quotes/charts/historical/${sym}.json`;
export const STOXX_URL = (file) => `https://www.stoxx.com/document/Indices/Current/HistoricalData/${file}.txt`;
export const NIKKEI_URL = "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_daily_en.csv";
const HIST_ROWS = 2600; // ten years of sessions

// one request per group: a group stays within the Worker's limits (≤ 12 fetches with the FRED stand-ins, ≤ 50 cache calls)
export const GROUPS = [["us", "United States"], ["vol", "Volatility (Cboe)"], ["eu", "Europe"],
  ["sec", "Europe · STOXX 600 sectors — financials, technology, health, staples"], ["sec2", "Europe · STOXX 600 sectors — energy, materials, industrials, cyclicals"],
  ["asia", "Asia-Pacific"], ["world", "Americas & global"]];
const cb = (id, g, name, sym, ccy, owner, extra = {}) => ({ id, g, name, ccy, src: "cboe", sym, owner, ...extra });
const sx = (id, g, name, file, owner = "STOXX") => ({ id, g, name, ccy: "EUR", src: "stoxx", file, owner });
const sec = (g, code, name) => sx(code, g, `STOXX Europe 600 ${name}`, `h_3m${code.toLowerCase()}`);
export const INDICES = [
  { id: "SPX", g: "us", name: "S&P 500", ccy: "USD", src: "cboe", sym: "_SPX", fred: "SP500", owner: "S&P Dow Jones Indices" },
  { id: "NDX", g: "us", name: "Nasdaq-100", ccy: "USD", src: "cboe", sym: "_NDX", fred: "NASDAQ100", owner: "Nasdaq" },
  { id: "DJI", g: "us", name: "Dow Jones Industrial Average", ccy: "USD", src: "cboe", sym: "_DJX", scale: 100, fred: "DJIA", owner: "S&P Dow Jones Indices" },
  { id: "COMP", g: "us", name: "Nasdaq Composite", ccy: "USD", src: "fred", series: "NASDAQCOM", owner: "Nasdaq" },
  { id: "RUT", g: "us", name: "Russell 2000", ccy: "USD", src: "cboe", sym: "_RUT", owner: "FTSE Russell" },
  cb("OEX", "us", "S&P 100", "_OEX", "USD", "S&P Dow Jones Indices"),
  cb("RUI", "us", "Russell 1000", "_RUI", "USD", "FTSE Russell"),
  { id: "VIX", g: "us", name: "Cboe Volatility Index (VIX)", ccy: "", src: "cboe", sym: "_VIX", fred: "VIXCLS", owner: "Cboe" },
  cb("VXN", "vol", "Cboe Nasdaq-100 Volatility (VXN)", "_VXN", "", "Cboe"),
  cb("VIX9D", "vol", "Cboe 9-Day Volatility (VIX9D)", "_VIX9D", "", "Cboe"),
  cb("VIX3M", "vol", "Cboe 3-Month Volatility (VIX3M)", "_VIX3M", "", "Cboe"),
  cb("VVIX", "vol", "Cboe VIX of VIX (VVIX)", "_VVIX", "", "Cboe"),
  cb("OVX", "vol", "Cboe Crude Oil Volatility (OVX)", "_OVX", "", "Cboe"),
  cb("GVZ", "vol", "Cboe Gold Volatility (GVZ)", "_GVZ", "", "Cboe"),
  sx("SX5E", "eu", "EURO STOXX 50", "h_3msx5e"),
  sx("SXXP", "eu", "STOXX Europe 600", "h_3msxxp"),
  sx("SX5P", "eu", "STOXX Europe 50", "h_3msx5p"),
  sx("SXXE", "eu", "EURO STOXX", "h_3msxxe"),
  sx("DAX", "eu", "DAX", "h_3mdax", "STOXX (DAX index family)"),
  sx("MDAX", "eu", "MDAX", "h_3mmdax", "STOXX (DAX index family)"),
  sx("TDXP", "eu", "TecDAX", "h_3mtdxp", "STOXX (DAX index family)"),
  { id: "SMI", g: "eu", name: "Swiss Market Index (SMI)", ccy: "CHF", src: "six", valor: "CH0009980894CHF9", owner: "SIX" },
  { id: "SPI", g: "eu", name: "Swiss Performance Index (SPI)", ccy: "CHF", src: "six", valor: "CH0009987501CHF9", owner: "SIX" },
  { id: "IBEX", g: "eu", name: "IBEX 35", ccy: "EUR", src: "six", valor: "ES0SI0000005EUR9", owner: "BME (SIX)" },
  sec("sec", "SX7P", "Banks"), sec("sec", "SXIP", "Insurance"), sec("sec", "SXFP", "Financial Services"), sec("sec", "SX86P", "Real Estate"),
  sec("sec", "SX8P", "Technology"), sec("sec", "SXKP", "Telecommunications"), sec("sec", "SXMP", "Media"), sec("sec", "SXDP", "Health Care"),
  sec("sec", "SX3P", "Food, Beverage and Tobacco"), sec("sec", "SXQP", "Personal Care, Drug and Grocery Stores"),
  sec("sec2", "SXEP", "Energy"), sec("sec2", "SX6P", "Utilities"), sec("sec2", "SXPP", "Basic Resources"), sec("sec2", "SX4P", "Chemicals"),
  sec("sec2", "SXOP", "Construction and Materials"), sec("sec2", "SXNP", "Industrial Goods and Services"), sec("sec2", "SXAP", "Automobiles and Parts"),
  sec("sec2", "SXRP", "Retail"), sec("sec2", "SXTP", "Travel and Leisure"), sx("SX7E", "sec2", "EURO STOXX Banks", "h_3msx7e"),
  { id: "N225", g: "asia", name: "Nikkei 225", ccy: "JPY", src: "nikkei", owner: "Nikkei Inc." },
  { id: "XJO", g: "asia", name: "S&P/ASX 200", ccy: "AUD", src: "asx", code: "xjo", owner: "S&P Dow Jones Indices" },
  { id: "SHCOMP", g: "asia", name: "SSE Composite", ccy: "CNY", src: "sse", code: "000001", owner: "China Securities Index Co. (SSE)" },
  { id: "CSI300", g: "asia", name: "CSI 300", ccy: "CNY", src: "sse", code: "000300", owner: "China Securities Index Co." },
  { id: "IBOV", g: "world", name: "Ibovespa", ccy: "BRL", src: "b3", sym: "IBOV", owner: "B3" },
  cb("MXEA", "world", "MSCI EAFE", "_MXEA", "USD", "MSCI"),
  cb("MXEF", "world", "MSCI Emerging Markets", "_MXEF", "USD", "MSCI"),
  cb("MXACW", "world", "MSCI ACWI", "_MXACW", "USD", "MSCI"),
];
// [id, name, group, reason]
export const NOT_CONNECTED = [["UKX", "FTSE 100", "eu"], ["CAC", "CAC 40", "eu"], ["FTSEMIB", "FTSE MIB", "eu"], ["HSI", "Hang Seng", "asia"], ["KOSPI", "KOSPI", "asia"],
  ["NIFTY", "Nifty 50", "asia", "NSE refuses requests from the server (checked 20 Oct 2026)"], ["TSX", "S&P/TSX Composite", "world"]];
const NC_REASON = "no free official source";
const SRC = {
  cboe: { name: "Cboe (15-min delayed)", url: "https://www.cboe.com/us/indices/" },
  stoxx: { name: "STOXX (daily close)", url: "https://www.stoxx.com/" },
  nikkei: { name: "Nikkei Inc. (daily)", url: "https://indexes.nikkei.co.jp/en/nkave/index/profile?idx=nk225" },
  fred: { name: "FRED (daily close)", url: "https://fred.stlouisfed.org/" },
  six: { name: "SIX (15-min delayed)", url: "https://www.six-group.com/en/market-data/indices.html" },
  sse: { name: "Shanghai Stock Exchange (delayed)", url: "https://english.sse.com.cn/" },
  b3: { name: "B3 (daily close)", url: "https://www.b3.com.br/en_us/market-data-and-indices/indices/" },
  asx: { name: "ASX (≥20-min delayed, no time)", url: "https://www.asx.com.au/markets/trade-our-cash-market/overview/indices" },
};
// approved 20 Oct 2026 (exchange websites' own data services; not documented APIs — N/A whenever they refuse)
export const SIX_SNAP = (valor) => `https://www.six-group.com/fqs/snap.json?select=ValorId,ClosingPrice,ClosingPerformance,ClosingDelta,PreviousClosingPrice,MarketDate,MarketTime&where=ValorId=${valor}`;
export const SIX_HIST = (valor, from) => `https://www.six-group.com/fqs/charts.json?select=ValorId&where=ValorId=${valor}&fromdate=${from}&netting=1440`;
export const SSE_SNAP = (code) => `https://yunhq.sse.com.cn:32042/v1/sh1/snap/${code}`;
export const SSE_DAYK = (code, n) => `https://yunhq.sse.com.cn:32042/v1/sh1/dayk/${code}?begin=-${n}&end=-1&select=date,open,high,low,close`;
export const B3_YEAR = (sym, year) => `https://sistemaswebb3-listados.b3.com.br/indexStatisticsProxy/IndexCall/GetPortfolioDay/${btoa(JSON.stringify({ index: sym, language: "pt-br", year: String(year) }))}`;
export const ASX_HEADER = (code) => `https://asx.api.markitdigital.com/asx-research/1.0/companies/${code}/header`;
export const ASX_STATS = (code) => `https://asx.api.markitdigital.com/asx-research/1.0/companies/${code}/key-statistics`;
const fredUrlOf = (s) => `https://fred.stlouisfed.org/series/${s}`;

const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const byDate = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// Cboe times: "2026-10-07 17:45:37" (top-level, UTC), "2026-10-07T13:30:37" (New York, no offset), or with an offset
export function cboeTime(s, utc = false) {
  const t = String(s || "").trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (/(Z|[+-]\d{2}:\d{2})$/.test(t)) { const v = Date.parse(t); return Number.isFinite(v) ? v : null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) return null;
  if (utc) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return easternToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]) + +(m[6] || 0) * 1000;
}
const nyDate = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// one delayed quote; scale 100 turns Cboe's DJX into the Dow's points (rounded to the cent of DJX: ±0.5 point)
export function parseCboeQuote(j, scale = 1) {
  const d = j && j.data;
  const last = d && pos(d.current_price);
  if (!last) return null;
  const sc = (v) => (v == null ? null : scale === 1 ? v : r2(v * scale));
  const prev = pos(d.prev_day_close), open = pos(d.open), high = pos(d.high), low = pos(d.low);
  const at = cboeTime(d.last_trade_time) ?? cboeTime(j.timestamp, true);
  let chg = Number.isFinite(Number(d.price_change)) ? Number(d.price_change) : prev ? last - prev : null;
  let chgPct = Number.isFinite(Number(d.price_change_percent)) ? Number(d.price_change_percent) : prev ? ((last - prev) / prev) * 100 : null;
  let note = null;
  // before a session Cboe can show the last close with no open and a zero change: no change is reported then
  if (open == null && chg === 0) { chg = null; chgPct = null; note = "before the session"; }
  return { last: sc(last), prev: sc(prev), chg: chg == null ? null : sc(scale === 1 ? r4(chg) : chg), chgPct: chgPct == null ? null : r4(chgPct),
    open: sc(open), high: sc(high), low: sc(low), asOf: at ? iso(at) : null, date: at ? nyDate(at) : null, note };
}

// the daily history file (1975 →, ~1.7 MB, oldest first): only its tail is parsed
export function parseCboeHist(text, maxRows = HIST_ROWS, scale = 1) {
  const s = String(text || "");
  let rows = null, p = s.length, n = 0;
  while (n < maxRows) { const q = s.lastIndexOf('{"date"', p - 1); if (q < 0) break; p = q; n++; }
  if (n) { const end = s.indexOf("]", p); try { rows = JSON.parse("[" + s.slice(p, end < 0 ? s.length : end).replace(/[\s,]+$/, "") + "]"); } catch { rows = null; } }
  if (!rows) { try { const j = JSON.parse(s); rows = Array.isArray(j && j.data) ? j.data.slice(-maxRows) : []; } catch { rows = []; } }
  const sc = (v) => (v == null ? null : scale === 1 ? v : r2(v * scale));
  return rows.map((r) => {
    const c = r && pos(r.close);
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ""))) return null;
    const o = pos(r.open), h = pos(r.high), l = pos(r.low);
    return o && h && l ? [r.date, sc(o), sc(h), sc(l), sc(c)] : [r.date, null, null, null, sc(c)];
  }).filter(Boolean).sort(byDate);
}

// "Date;Symbol;Indexvalue;" then "07.10.2026;SX5E;6180.29;"
export function parseStoxx(text) {
  const m = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const x = /^(\d{2})\.(\d{2})\.(\d{4});[^;]*;([0-9]+(?:\.[0-9]+)?);?/.exec(line.trim());
    const v = x && pos(x[4]);
    if (v) m.set(`${x[3]}-${x[2]}-${x[1]}`, v);
  }
  return [...m].sort(byDate);
}

// "Date of Data,Close,Open,High,Low" then "2026/10/07","70035.71","70582.11","70793.29","70017.19"
export function parseNikkei(text) {
  const out = [];
  for (const r of parseCsv(String(text || ""))) {
    const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(String(r[0] || "").trim());
    const c = m && pos(r[1]);
    if (c) { const o = pos(r[2]), h = pos(r[3]), l = pos(r[4]); out.push(o && h && l ? [`${m[1]}-${m[2]}-${m[3]}`, o, h, l, c] : [`${m[1]}-${m[2]}-${m[3]}`, null, null, null, c]); }
  }
  return out.sort(byDate);
}

// the latest close of a daily series against the one before (change DERIVED)
export function closeRow(rows) {
  if (!rows || !rows.length) return null;
  const close = (r) => r[r.length - 1], L = rows[rows.length - 1], P = rows.length > 1 ? rows[rows.length - 2] : null;
  const last = close(L), prev = P ? close(P) : null, ohlc = L.length === 5;
  return { last, prev, prevDate: P ? P[0] : null, chg: prev ? r4(last - prev) : null, chgPct: prev ? r4(((last - prev) / prev) * 100) : null,
    open: ohlc ? L[1] : null, high: ohlc ? L[2] : null, low: ohlc ? L[3] : null, date: L[0], asOf: null, note: null };
}
const DAY = 86400_000;

// ---------- exchange websites (approved 20 Oct 2026) ----------
const ymdNum = (n) => { const t = String(n == null ? "" : n); return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null; };
const hmsOk = (x) => { const t = String(x == null ? "" : x).replace(/\..*$/, "").padStart(6, "0"); return /^\d{6}$/.test(t) ? t : null; };
// wall-clock time in a time zone → UTC (two passes for the DST edges)
const tzOff = (tz, t) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t; };
export function zonedToUtc(tz, d, hms = "000000") { const g = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), +hms.slice(0, 2), +hms.slice(2, 4), +hms.slice(4, 6)); let t = g - tzOff(tz, g); t = g - tzOff(tz, t); return t; }
const fixedToUtc = (d, hms, offH) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), +hms.slice(0, 2) - offH, +hms.slice(2, 4), +hms.slice(4, 6));
const withChg = (last, prev) => ({ last, prev, chg: prev ? r4(last - prev) : null, chgPct: prev ? r4(((last - prev) / prev) * 100) : null });

// SIX snapshot {colNames, rowData:[[valor, last, chg%, chg, prev, yyyymmdd, hhmmss]]}: the time is the snapshot's (15 minutes delayed)
export function parseSixSnap(j) {
  const c = j && j.colNames, r = j && Array.isArray(j.rowData) && j.rowData[0];
  if (!Array.isArray(c) || !r) return null;
  const v = (k) => r[c.indexOf(k)], last = pos(v("ClosingPrice")), date = ymdNum(v("MarketDate"));
  if (!last || !date) return null;
  const hms = hmsOk(v("MarketTime"));
  return { ...withChg(last, pos(v("PreviousClosingPrice"))), open: null, high: null, low: null, date, asOf: hms ? iso(zonedToUtc("Europe/Zurich", date, hms)) : null, note: null };
}
// SIX daily bars (netting 1440): {valors:[{data:{Date:[yyyymmdd], Close:[…]}}]} → [[date, close]]
export function parseSixHist(j) {
  const d = j && Array.isArray(j.valors) && j.valors[0] && j.valors[0].data;
  if (!d || !Array.isArray(d.Date) || !Array.isArray(d.Close)) return [];
  const m = new Map(); d.Date.forEach((x, i) => { const k = ymdNum(x), c = pos(d.Close[i]); if (k && c) m.set(k, c); });
  return [...m].sort(byDate);
}
// SSE snapshot {date, time, snap:[name, prev, open, high, low, last, chg, chg%, …]} — Shanghai time (UTC+8, no daylight saving)
export function parseSseSnap(j) {
  const a = j && j.snap, date = ymdNum(j && j.date);
  if (!Array.isArray(a) || !date) return null;
  const last = pos(a[5]);
  if (!last) return null;
  const hms = hmsOk(j.time);
  return { ...withChg(last, pos(a[1])), open: pos(a[2]), high: pos(a[3]), low: pos(a[4]), date, asOf: hms ? iso(fixedToUtc(date, hms, 8)) : null, note: null };
}
// SSE daily bars {kline:[[yyyymmdd, open, high, low, close]]}
export function parseSseDayk(j) {
  return (j && Array.isArray(j.kline) ? j.kline : []).map((x) => { const d = ymdNum(x[0]), o = pos(x[1]), h = pos(x[2]), l = pos(x[3]), c = pos(x[4]); return d && c ? (o && h && l ? [d, o, h, l, c] : [d, null, null, null, c]) : null; }).filter(Boolean).sort(byDate);
}
const ptNum = (x) => { const t = String(x == null ? "" : x).trim(); if (!t) return null; const n = Number(t.replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };
// B3 daily closes of one year {results:[{day, rateValue1…rateValue12: "187.952,91"}]}
export function parseB3Year(j, year) {
  const out = [];
  for (const r of j && Array.isArray(j.results) ? j.results : []) for (let mo = 1; mo <= 12; mo++) { const v = ptNum(r["rateValue" + mo]); if (v && r.day >= 1 && r.day <= 31) out.push([`${year}-${String(mo).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`, v]); }
  return out.sort(byDate);
}
// ASX (its data vendor): level and change now; previous close and day range from the key statistics; no time is published
export function parseAsx(h, k) {
  const d = h && h.data, s = k && k.data, last = d && pos(d.priceLast);
  if (!last) return null;
  const prev = s ? pos(s.priceClose) : null, hi = s && pos(s.priceDayHigh), lo = s && pos(s.priceDayLow);
  const x = prev ? withChg(last, prev) : { last, prev: null, chg: Number.isFinite(d.priceChange) ? r4(d.priceChange) : null, chgPct: Number.isFinite(d.priceChangePercent) ? r4(d.priceChangePercent) : null };
  return { ...x, open: null, high: hi ? r2(hi) : null, low: lo ? r2(lo) : null, date: null, asOf: null, note: "ASX publishes no time for this value" };
}
// a daily value older than five days (a weekend and a holiday) is no longer the latest one
export const tooOld = (date, now) => !date || now - Date.parse(String(date).slice(0, 10) + "T12:00:00Z") > 5 * DAY;

async function getJson(url, timeoutMs) {
  const f = await fetchText(url, { timeoutMs, headers: { accept: "application/json" } });
  if (f.err) return { err: f.err };
  try { return { j: JSON.parse(f.text) }; } catch { return { err: "provider_error" }; }
}
const cache = (url, ctx, key, ttlMs, staleMaxMs, load, failTtlMs = 5 * 60_000) => cachedSource({ origin: url.origin, key, ttlMs, staleMaxMs, ctx, failTtlMs, load });
const stoxxSeries = (url, ctx, ix) => cache(url, ctx, `idx/stoxx/${ix.file}`, 30 * 60_000, 10 * DAY, async () => {
  const f = await fetchText(STOXX_URL(ix.file), { timeoutMs: 10000, headers: { accept: "text/plain,*/*" } });
  if (f.err) return { err: f.err };
  const s = parseStoxx(f.text);
  return s.length >= 2 ? { data: s } : { err: "no_data" };
});
const nikkeiSeries = (url, ctx) => cache(url, ctx, "idx/nikkei", 30 * 60_000, 10 * DAY, async () => {
  const f = await fetchText(NIKKEI_URL, { timeoutMs: 10000, headers: { accept: "text/csv,*/*" } });
  if (f.err) return { err: f.err };
  const s = parseNikkei(f.text);
  return s.length >= 2 ? { data: s } : { err: "no_data" };
});
const fredIdx = (url, env, ctx, series) => cache(url, ctx, `idx/fred/${series}`, 2 * 3600_000, 10 * DAY, () => fredSeries(env, series, HIST_ROWS), 10 * 60_000);
const cboeQuote = (url, ctx, ix) => cache(url, ctx, `idx/q/${ix.id}`, 60_000, 7 * DAY, async () => {
  const r = await getJson(CBOE_Q(ix.sym), 8000);
  if (r.err) return { err: r.err };
  const q = parseCboeQuote(r.j, ix.scale || 1);
  return q ? { data: q } : { err: "no_data" };
}, 2 * 60_000);
const cboeHist = (url, ctx, ix) => cache(url, ctx, `idx/h/${ix.id}`, 6 * 3600_000, 14 * DAY, async () => {
  const f = await fetchText(CBOE_H(ix.sym), { timeoutMs: 20000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.err };
  const s = parseCboeHist(f.text, HIST_ROWS, ix.scale || 1);
  return s.length >= 2 ? { data: s } : { err: "no_data" };
}, 15 * 60_000);

// SIX, SSE, B3, ASX (approved 20 Oct 2026)
const sixSnap = (url, ctx, ix) => cache(url, ctx, `idx/six/q/${ix.id}`, 60_000, 7 * DAY, async () => {
  const r = await getJson(SIX_SNAP(ix.valor), 8000); if (r.err) return { err: r.err };
  const q = parseSixSnap(r.j); return q ? { data: q } : { err: "no_data" };
}, 2 * 60_000);
const tenYearsAgo = () => new Date(Date.now() - 3653 * DAY).toISOString().slice(0, 10);
const sixHist = (url, ctx, ix) => cache(url, ctx, `idx/six/h/${ix.id}`, 6 * 3600_000, 14 * DAY, async () => {
  const r = await getJson(SIX_HIST(ix.valor, tenYearsAgo().replace(/-/g, "")), 20000); if (r.err) return { err: r.err };
  const s = parseSixHist(r.j); return s.length >= 2 ? { data: s.slice(-HIST_ROWS) } : { err: "no_data" };
}, 15 * 60_000);
const sseSnap = (url, ctx, ix) => cache(url, ctx, `idx/sse/q/${ix.id}`, 60_000, 7 * DAY, async () => {
  const r = await getJson(SSE_SNAP(ix.code), 8000); if (r.err) return { err: r.err };
  const q = parseSseSnap(r.j); return q ? { data: q } : { err: "no_data" };
}, 2 * 60_000);
const sseHist = (url, ctx, ix) => cache(url, ctx, `idx/sse/h/${ix.id}`, 6 * 3600_000, 14 * DAY, async () => {
  const r = await getJson(SSE_DAYK(ix.code, HIST_ROWS), 20000); if (r.err) return { err: r.err };
  const s = parseSseDayk(r.j); return s.length >= 2 ? { data: s } : { err: "no_data" };
}, 15 * 60_000);
// B3 publishes the daily closes one calendar year at a time: this year and the last one
const b3Hist = (url, ctx, ix) => cache(url, ctx, `idx/b3/h/${ix.id}`, 30 * 60_000, 14 * DAY, async () => {
  const y = new Date().getUTCFullYear(), res = await Promise.all([y - 1, y].map((yr) => getJson(B3_YEAR(ix.sym, yr), 15000).then((r) => (r.err ? r : { data: parseB3Year(r.j, yr) }))));
  const s = res.flatMap((r) => r.data || []);
  return s.length >= 2 ? { data: s } : { err: (res.find((r) => r.err) || {}).err || "no_data" };
}, 15 * 60_000);
const asxRow = (url, ctx, ix) => cache(url, ctx, `idx/asx/${ix.id}`, 60_000, 7 * DAY, async () => {
  const [h, k] = await Promise.all([getJson(ASX_HEADER(ix.code), 8000), getJson(ASX_STATS(ix.code), 8000)]);
  if (h.err) return { err: h.err };
  const q = parseAsx(h.j, k.err ? null : k.j); return q ? { data: q } : { err: "no_data" };
}, 2 * 60_000);

const base = (ix) => ({ id: ix.id, name: ix.name, group: ix.g, ccy: ix.ccy, owner: ix.owner });
// one index: its primary source, or for Cboe the FRED close when Cboe does not answer
async function indexRow(url, env, ctx, ix, now) {
  const stale = (r) => r.cache === "STALE";
  if (ix.src === "cboe") {
    const r = await cboeQuote(url, ctx, ix);
    if (r.data) return { ...base(ix), ...r.data, kind: "delayed", delayMin: 15, source: SRC.cboe.name, sourceUrl: SRC.cboe.url, derived: !!ix.scale,
      note: [r.data.note, ix.scale ? "Cboe DJX (1/100 of the DJIA) × 100, ±0.5 point" : null].filter(Boolean).join(" · ") || null,
      status: stale(r) || tooOld(r.data.date, now) ? "STALE" : ix.scale ? "DERIVED" : "LIVE", fetchedAt: iso(r.fetchedAt) };
    if (ix.fred && env.FRED_KEY) {
      const f = await fredIdx(url, env, ctx, ix.fred), c = f.data && closeRow(f.data);
      if (c) return { ...base(ix), ...c, kind: "close", source: `FRED · ${ix.owner} (daily close)`, sourceUrl: fredUrlOf(ix.fred), note: `Cboe did not answer (${r.err}): the last official close`,
        status: stale(f) || tooOld(c.date, now) ? "STALE" : "LIVE", fetchedAt: iso(f.fetchedAt) };
    }
    return { ...base(ix), source: SRC.cboe.name, sourceUrl: SRC.cboe.url, status: "N/A", error: r.err };
  }
  const na = (src, err) => ({ ...base(ix), source: SRC[src].name, sourceUrl: SRC[src].url, status: "N/A", error: err || "no_data" });
  if (ix.src === "six" || ix.src === "sse" || ix.src === "asx") {
    const r = ix.src === "six" ? await sixSnap(url, ctx, ix) : ix.src === "sse" ? await sseSnap(url, ctx, ix) : await asxRow(url, ctx, ix);
    if (!r.data) return na(ix.src, r.err);
    const noTime = ix.src === "asx"; // a level without a time is shown PARTIAL
    return { ...base(ix), ...r.data, kind: "delayed", delayMin: ix.src === "six" ? 15 : ix.src === "asx" ? 20 : null, source: SRC[ix.src].name, sourceUrl: SRC[ix.src].url,
      status: noTime ? "PARTIAL" : stale(r) || tooOld(r.data.date, now) ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) };
  }
  // daily closes: STOXX, Nikkei, FRED, B3 (its quote service refuses the server: Ibovespa is its daily close)
  const r = ix.src === "stoxx" ? await stoxxSeries(url, ctx, ix) : ix.src === "nikkei" ? await nikkeiSeries(url, ctx) : ix.src === "b3" ? await b3Hist(url, ctx, ix) : await fredIdx(url, env, ctx, ix.series);
  const s = ix.src === "fred" ? `FRED · ${ix.owner} (daily close)` : SRC[ix.src].name, su = ix.src === "fred" ? fredUrlOf(ix.series) : SRC[ix.src].url;
  const c = r.data && closeRow(r.data);
  if (!c) return { ...base(ix), source: s, sourceUrl: su, status: "N/A", error: r.err || "no_data" };
  return { ...base(ix), ...c, kind: "close", source: s, sourceUrl: su, status: stale(r) || tooOld(c.date, now) ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) };
}

export async function getIndexGroup(url, env, ctx, g, now = Date.now()) {
  const list = INDICES.filter((x) => x.g === g);
  return Promise.all(list.map((ix) => indexRow(url, env, ctx, ix, now)));
}

export async function getIndexHistory(url, env, ctx, ix) {
  let r, source, sourceUrl, note = null, derived = !!ix.scale;
  if (ix.src === "cboe") {
    r = await cboeHist(url, ctx, ix); source = "Cboe (daily history)"; sourceUrl = SRC.cboe.url;
    if (ix.scale) note = "Cboe DJX (1/100 of the DJIA) × 100";
    if (!r.data && ix.fred && env.FRED_KEY) { const e = r.err; r = await fredIdx(url, env, ctx, ix.fred); source = `FRED · ${ix.owner} (daily close)`; sourceUrl = fredUrlOf(ix.fred); note = `Cboe did not answer (${e}): official closes from FRED`; derived = false; }
  } else if (ix.src === "stoxx") { r = await stoxxSeries(url, ctx, ix); source = SRC.stoxx.name; sourceUrl = SRC.stoxx.url; note = "STOXX publishes the last 3 months for free"; }
  else if (ix.src === "nikkei") { r = await nikkeiSeries(url, ctx); source = SRC.nikkei.name; sourceUrl = SRC.nikkei.url; }
  else if (ix.src === "six") { r = await sixHist(url, ctx, ix); source = "SIX (daily closes)"; sourceUrl = SRC.six.url; }
  else if (ix.src === "sse") { r = await sseHist(url, ctx, ix); source = "Shanghai Stock Exchange (daily)"; sourceUrl = SRC.sse.url; }
  else if (ix.src === "b3") { r = await b3Hist(url, ctx, ix); source = "B3 (daily closes)"; sourceUrl = SRC.b3.url; note = "B3 publishes the daily closes one year at a time: this year and the last one are kept"; }
  else if (ix.src === "asx") return { ...base(ix), source: SRC.asx.name, sourceUrl: SRC.asx.url, status: "N/A", error: "no_history", note: "ASX publishes no free history" };
  else { r = await fredIdx(url, env, ctx, ix.series); source = `FRED · ${ix.owner} (daily close)`; sourceUrl = fredUrlOf(ix.series); }
  if (!r.data) return { ...base(ix), source, sourceUrl, status: "N/A", error: r.err || "no_data" };
  const pts = r.data, ohlc = pts.some((p) => p.length === 5 && p[1] != null);
  return { ...base(ix), source, sourceUrl, note, derived, fields: ohlc ? "ohlc" : "close", points: ohlc ? pts.map((p) => (p.length === 5 ? p : [p[0], null, null, null, p[1]])) : pts.map((p) => [p[0], p[p.length - 1]]),
    from: pts[0][0], to: pts[pts.length - 1][0], count: pts.length, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) };
}

export function indexCatalog() {
  return { groups: GROUPS.map(([id, name]) => ({ id, name, indices: INDICES.filter((x) => x.g === id).map((x) => ({ id: x.id, name: x.name, src: x.src })) })),
    notConnected: NOT_CONNECTED.map(([id, name, g, why]) => ({ id, name, group: g, reason: why || NC_REASON })) };
}

export async function handleIndices(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (url.pathname === "/api/indices/history") {
    const ix = INDICES.find((x) => x.id === String(url.searchParams.get("id") || "").toUpperCase());
    if (!ix) return send({ error: "bad_request", message: "unknown index" }, 400);
    const h = await getIndexHistory(url, env, ctx, ix);
    return send(h, h.points ? 200 : 502);
  }
  const g = url.searchParams.get("g");
  if (!g) return send({ ...indexCatalog(), basis: BASIS });
  if (!GROUPS.some(([id]) => id === g)) return send({ error: "bad_request", message: "unknown group" }, 400);
  const rows = await getIndexGroup(url, env, ctx, g);
  const ok = rows.some((r) => r.status !== "N/A");
  return send({ group: g, indices: rows, notConnected: NOT_CONNECTED.filter((x) => x[2] === g).map(([id, name, , why]) => ({ id, name, reason: why || NC_REASON })), basis: BASIS, status: ok ? "LIVE" : "N/A" }, ok ? 200 : 502);
}
const BASIS = "levels as each source publishes them: Cboe 15-minute delayed quotes (US indices, volatility indices, MSCI EAFE, EM and ACWI), STOXX and Nikkei daily closes, SIX 15-minute delayed (SMI, SPI, IBEX 35), Shanghai Stock Exchange (SSE Composite, CSI 300), B3 daily close (Ibovespa), ASX (S&P/ASX 200, no time published), FRED daily closes; changes against the previous close (DERIVED where computed); the index providers reserve redistribution — shown only in this private terminal";
