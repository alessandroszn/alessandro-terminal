// WORLD INDICES (IDX) — approved 7 Oct 2026: free publications of the index providers and of Cboe, nothing estimated.
//   GET /api/indices?g=us|eu|world   the indices of one group: last level, change, day range (when published), time, source
//   GET /api/indices                 the catalog only (groups, names, sources, what is not connected)
//   GET /api/indices/history?id=SPX  daily closes (open/high/low too when published) for the chart and for the
//                                    1M / YTD / 52-week figures the page derives
// Sources:
//   Cboe delayed quotes, 15 minutes (cdn-api.cboe.com, the data behind cboe.com): S&P 500, Nasdaq-100, Dow Jones (Cboe DJX
//     = 1/100 of the DJIA, shown ×100: DERIVED), Russell 2000, VIX, MSCI EAFE, MSCI Emerging Markets; daily history since
//     1975, of which the last ten years are kept
//   STOXX Ltd. daily closes, last 3 months (stoxx.com): EURO STOXX 50, STOXX Europe 600, DAX, MDAX, EURO STOXX Banks
//   Nikkei Inc. daily open/high/low/close since 2023 (indexes.nikkei.co.jp): Nikkei 225
//   FRED (needs FRED_KEY): Nasdaq Composite (NASDAQCOM, daily close); the official closes of S&P 500, Nasdaq-100, Dow and
//     VIX stand in, labelled as such, when Cboe does not answer
// Not connected (no free official source): FTSE 100, CAC 40, FTSE MIB, SMI, Hang Seng.
// The index providers reserve redistribution: the values are shown only in this private terminal, each with its source.
// A group stays small (≤ 10 sources with their fallbacks) so one request keeps within the Worker's subrequest limit.
import { fetchText, cachedSource, parseCsv, iso, easternToUtc } from "./lib.mjs";
import { fredSeries } from "./yields.mjs";

export const CBOE_Q = (sym) => `https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/${sym}.json`;
export const CBOE_H = (sym) => `https://cdn-api.cboe.com/api/global/delayed_quotes/charts/historical/${sym}.json`;
export const STOXX_URL = (file) => `https://www.stoxx.com/document/Indices/Current/HistoricalData/${file}.txt`;
export const NIKKEI_URL = "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_daily_en.csv";
const HIST_ROWS = 2600; // ten years of sessions

export const GROUPS = [["us", "United States"], ["eu", "Europe"], ["world", "Asia & global"]];
export const INDICES = [
  { id: "SPX", g: "us", name: "S&P 500", ccy: "USD", src: "cboe", sym: "_SPX", fred: "SP500", owner: "S&P Dow Jones Indices" },
  { id: "NDX", g: "us", name: "Nasdaq-100", ccy: "USD", src: "cboe", sym: "_NDX", fred: "NASDAQ100", owner: "Nasdaq" },
  { id: "DJI", g: "us", name: "Dow Jones Industrial Average", ccy: "USD", src: "cboe", sym: "_DJX", scale: 100, fred: "DJIA", owner: "S&P Dow Jones Indices" },
  { id: "COMP", g: "us", name: "Nasdaq Composite", ccy: "USD", src: "fred", series: "NASDAQCOM", owner: "Nasdaq" },
  { id: "RUT", g: "us", name: "Russell 2000", ccy: "USD", src: "cboe", sym: "_RUT", owner: "FTSE Russell" },
  { id: "VIX", g: "us", name: "Cboe Volatility Index (VIX)", ccy: "", src: "cboe", sym: "_VIX", fred: "VIXCLS", owner: "Cboe" },
  { id: "SX5E", g: "eu", name: "EURO STOXX 50", ccy: "EUR", src: "stoxx", file: "h_3msx5e", owner: "STOXX" },
  { id: "SXXP", g: "eu", name: "STOXX Europe 600", ccy: "EUR", src: "stoxx", file: "h_3msxxp", owner: "STOXX" },
  { id: "DAX", g: "eu", name: "DAX", ccy: "EUR", src: "stoxx", file: "h_3mdax", owner: "STOXX (DAX index family)" },
  { id: "MDAX", g: "eu", name: "MDAX", ccy: "EUR", src: "stoxx", file: "h_3mmdax", owner: "STOXX (DAX index family)" },
  { id: "SX7E", g: "eu", name: "EURO STOXX Banks", ccy: "EUR", src: "stoxx", file: "h_3msx7e", owner: "STOXX" },
  { id: "N225", g: "world", name: "Nikkei 225", ccy: "JPY", src: "nikkei", owner: "Nikkei Inc." },
  { id: "MXEA", g: "world", name: "MSCI EAFE", ccy: "USD", src: "cboe", sym: "_MXEA", owner: "MSCI" },
  { id: "MXEF", g: "world", name: "MSCI Emerging Markets", ccy: "USD", src: "cboe", sym: "_MXEF", owner: "MSCI" },
];
export const NOT_CONNECTED = [["UKX", "FTSE 100", "eu"], ["CAC", "CAC 40", "eu"], ["FTSEMIB", "FTSE MIB", "eu"], ["SMI", "SMI", "eu"], ["HSI", "Hang Seng", "world"]];
const SRC = {
  cboe: { name: "Cboe (15-min delayed)", url: "https://www.cboe.com/us/indices/" },
  stoxx: { name: "STOXX (daily close)", url: "https://www.stoxx.com/" },
  nikkei: { name: "Nikkei Inc. (daily)", url: "https://indexes.nikkei.co.jp/en/nkave/index/profile?idx=nk225" },
  fred: { name: "FRED (daily close)", url: "https://fred.stlouisfed.org/" },
};
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
  const r = ix.src === "stoxx" ? await stoxxSeries(url, ctx, ix) : ix.src === "nikkei" ? await nikkeiSeries(url, ctx) : await fredIdx(url, env, ctx, ix.series);
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
  else { r = await fredIdx(url, env, ctx, ix.series); source = `FRED · ${ix.owner} (daily close)`; sourceUrl = fredUrlOf(ix.series); }
  if (!r.data) return { ...base(ix), source, sourceUrl, status: "N/A", error: r.err || "no_data" };
  const pts = r.data, ohlc = pts.some((p) => p.length === 5 && p[1] != null);
  return { ...base(ix), source, sourceUrl, note, derived, fields: ohlc ? "ohlc" : "close", points: ohlc ? pts.map((p) => (p.length === 5 ? p : [p[0], null, null, null, p[1]])) : pts.map((p) => [p[0], p[p.length - 1]]),
    from: pts[0][0], to: pts[pts.length - 1][0], count: pts.length, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) };
}

export function indexCatalog() {
  return { groups: GROUPS.map(([id, name]) => ({ id, name, indices: INDICES.filter((x) => x.g === id).map((x) => ({ id: x.id, name: x.name, src: x.src })) })),
    notConnected: NOT_CONNECTED.map(([id, name, g]) => ({ id, name, group: g, reason: "no free official source" })) };
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
  return send({ group: g, indices: rows, notConnected: NOT_CONNECTED.filter((x) => x[2] === g).map(([id, name]) => ({ id, name, reason: "no free official source" })), basis: BASIS, status: ok ? "LIVE" : "N/A" }, ok ? 200 : 502);
}
const BASIS = "levels as each source publishes them: Cboe 15-minute delayed quotes (US indices, MSCI EAFE and EM), STOXX and Nikkei daily closes, FRED daily closes; changes against the previous close (DERIVED for the daily closes); the index providers reserve redistribution — shown only in this private terminal";
