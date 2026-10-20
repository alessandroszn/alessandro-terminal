// MARKET YIELDS — intraday government bond yields as CNBC's quote service publishes them (CNBC labels the venue,
// e.g. Tradeweb). Approved 20 Oct 2026 (category "intraday market data"): private, owner-only use, always labelled as
// market data and never mixed with the official curves (YLD keeps the two apart).
//   GET /api/yields/market                          latest quote of every symbol below (yield %, previous close, time)
//   GET /api/yields/market/past?ids=US,DE,IT        the 10-year 1 week / 1 month / 3 months / 1 year ago (daily closes)
//   GET /api/yields/market/past?id=IT               the same for every maturity of one country (past curves)
//   GET /api/yields/market/history?id=IT&tenor=10Y  five years of daily closes of one maturity
// Symbols checked from the Worker on 20 Oct 2026: only those that answered with a yield (a value ending in "%").
// Not quoted there: Poland, Czech Republic, Colombia, Taiwan, Philippines, Israel, Norway, Slovakia; Singapore's
// symbol answers a number that is not a yield, so it is left out.
import { fetchText, cachedSource, iso } from "./lib.mjs";

export const MKT_SOURCE = "CNBC quote service";
export const MKT_URL_PAGE = "https://www.cnbc.com/bonds/";
export const MKT_TENORS = {
  US: ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"],
  CA: ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "20Y", "30Y"],
  BR: ["2Y", "10Y"], MX: ["10Y"], CL: ["10Y"],
  DE: ["6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
  UK: ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
  FR: ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
  IT: ["6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
  ES: ["6M", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
  NL: ["2Y", "10Y"], BE: ["2Y", "5Y", "10Y", "30Y"], AT: ["2Y", "5Y", "10Y", "30Y"], PT: ["2Y", "3Y", "5Y", "10Y"],
  IE: ["2Y", "5Y", "10Y"], GR: ["2Y", "3Y", "10Y"], FI: ["2Y", "5Y", "10Y"], SI: ["10Y"],
  CH: ["2Y", "10Y"], SE: ["2Y", "10Y"], DK: ["2Y"], HU: ["3Y", "5Y", "10Y"], TR: ["2Y", "10Y"],
  JP: ["3M", "6M", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y", "40Y"], CN: ["2Y", "10Y"],
  AU: ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y"], NZ: ["2Y", "5Y", "10Y"], KR: ["5Y", "10Y"], IN: ["10Y", "30Y"],
  HK: ["10Y"], ID: ["10Y"], TH: ["10Y"],
  ZA: ["5Y", "10Y", "30Y"],
};
export const MKT_REGIONS = [
  ["Americas", ["US", "CA", "BR", "MX", "CL"]],
  ["Europe", ["DE", "UK", "FR", "IT", "ES", "NL", "BE", "AT", "PT", "IE", "GR", "FI", "SI", "CH", "SE", "DK", "HU", "TR"]],
  ["Asia-Pacific", ["JP", "CN", "AU", "NZ", "KR", "IN", "HK", "ID", "TH"]],
  ["Middle East & Africa", ["ZA"]],
];
export const MKT_IDS = MKT_REGIONS.flatMap(([, ids]) => ids);
export const tenorMonths = (t) => { const m = /^(\d+)([MY])$/.exec(t); return m ? (m[2] === "Y" ? +m[1] * 12 : +m[1]) : null; };
// CNBC's symbols: US10Y for the United States, IT10Y-IT elsewhere (the United Kingdom is GB there)
export const mktSymbol = (id, t) => { const c = id === "UK" ? "GB" : id; return id === "US" ? `US${t}` : `${c}${t}-${c}`; };
export const MKT_SYMBOLS = MKT_IDS.flatMap((id) => MKT_TENORS[id].map((t) => mktSymbol(id, t)));
const BY_SYMBOL = Object.fromEntries(MKT_IDS.flatMap((id) => MKT_TENORS[id].map((t) => [mktSymbol(id, t), [id, t]])));

export const quoteUrl = (syms) => `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms.map(encodeURIComponent).join("%7C")}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
export const barsUrl = (sym, from, to) => `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${ymd(from)}000000/${ymd(to)}000000/adjusted/EST5EDT.json`;

// a yield is a number followed by "%"; anything else (a price, "UNCH", empty) is not a yield
export const pctYield = (s) => { const m = /^\s*(-?\d+(?:\.\d+)?)%\s*$/.exec(String(s == null ? "" : s)); return m ? Number(m[1]) : null; };
// "2026-10-20T11:43:24.000-0400" → epoch ms (the offset written with a colon, as ISO wants it)
export const quoteTime = (s) => { const t = Date.parse(String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")); return Number.isFinite(t) ? t : null; };
// a quote older than this is shown as STALE (covers a long weekend; thinly traded maturities can be days old)
export const MKT_FRESH_MS = 4 * 86400_000;

export function parseQuotes(j) {
  const list = j && j.FormattedQuoteResult && Array.isArray(j.FormattedQuoteResult.FormattedQuote) ? j.FormattedQuoteResult.FormattedQuote : [];
  const out = {};
  for (const q of list) {
    const ref = q && BY_SYMBOL[q.symbol]; if (!ref || q.code !== 0) continue;
    const value = pctYield(q.last), time = quoteTime(q.last_time); if (value == null || time == null) continue;
    const prev = pctYield(q.previous_day_closing);
    out[q.symbol] = {
      value, prev, time, changeBp: prev != null ? Math.round((value - prev) * 1000) / 10 : null,
      venue: q.exchange ? String(q.exchange) : null, name: q.name ? String(q.name) : null,
      maturity: /^\d{4}-\d{2}-\d{2}$/.test(q.maturity_date || "") ? q.maturity_date : null, coupon: pctYield(q.coupon),
    };
  }
  return out;
}
// one country's points in maturity order: only maturities that answered
export function countryOf(id, quotes, now = Date.now()) {
  const points = MKT_TENORS[id].map((t) => { const q = quotes[mktSymbol(id, t)]; return q ? { tenor: t, months: tenorMonths(t), value: q.value, prev: q.prev, changeBp: q.changeBp, time: iso(q.time), status: now - q.time > MKT_FRESH_MS ? "STALE" : "LIVE", venue: q.venue, name: q.name, maturity: q.maturity, coupon: q.coupon } : null; }).filter(Boolean);
  if (!points.length) return null;
  const latest = Math.max(...points.map((p) => Date.parse(p.time)));
  return { id, points, asOf: iso(latest), status: points.some((p) => p.status === "LIVE") ? "LIVE" : "STALE" };
}
async function loadQuotes() {
  const parts = []; for (let i = 0; i < MKT_SYMBOLS.length; i += 40) parts.push(MKT_SYMBOLS.slice(i, i + 40));
  const res = await Promise.all(parts.map((p) => fetchText(quoteUrl(p), { timeoutMs: 12000, headers: { accept: "application/json" } })));
  const quotes = {}; let err = null;
  for (const f of res) { if (f.err) { err = err || f.err; continue; } try { Object.assign(quotes, parseQuotes(JSON.parse(f.text))); } catch { err = err || "provider_error"; } }
  return Object.keys(quotes).length ? { data: quotes } : { err: err || "no_data" };
}
export async function getMarketQuotes(origin, ctx) {
  return cachedSource({ origin, key: "myld/q1", ttlMs: 60_000, staleMaxMs: 5 * 86400_000, failTtlMs: 60_000, ctx, load: loadQuotes });
}

// daily closes of one symbol: [["2026-10-19", 4.012], ...] oldest first, dated as CNBC dates its bars. Checked 20 Oct 2026:
// U.S. and Canadian bars carry the session's own date; for German, French and Italian bonds the bar of a day holds the
// previous session's close (it matches the quote's previous close), and some markets have weekend bars. Shown as dated.
export function parseBars(j) {
  const bars = j && j.barData && Array.isArray(j.barData.priceBars) ? j.barData.priceBars : [];
  const out = [];
  for (const b of bars) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(b && b.tradeTime || "")), v = Number(b && b.close);
    if (m && b.close !== "" && b.close != null && Number.isFinite(v)) out.push([`${m[1]}-${m[2]}-${m[3]}`, v]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out.filter((x, i) => i === 0 || x[0] !== out[i - 1][0]);
}
async function loadBars(sym, days, now) {
  const f = await fetchText(barsUrl(sym, now - days * 86400_000, now + 86400_000), { timeoutMs: 15000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.err };
  let rows; try { rows = parseBars(JSON.parse(f.text)); } catch { return { err: "provider_error" }; }
  return rows.length ? { data: rows } : { err: "no_data" };
}
// no failure memo here: each symbol is one cache read and one write (the Cache API allows 50 calls per request)
const bars = (origin, ctx, sym, years, now) => cachedSource({ origin, key: `myld/b${years}/${sym}`, ttlMs: 6 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, load: () => loadBars(sym, years === 1 ? 400 : years * 366, now) });

// the close 1 week / 1 month / 3 months / 1 year before the latest close, and the last close of the previous year (YTD):
// the last close on or before that day — never interpolated
export const MKT_PAST = [["1W", 7], ["1M", 30], ["3M", 91], ["1Y", 365]];
export function pastOf(rows) {
  const out = {}; if (!rows || rows.length < 2) return out;
  const last = Date.parse(rows[rows.length - 1][0]);
  for (const [k, days] of MKT_PAST) {
    const target = last - days * 86400_000; let r = null;
    for (const x of rows) { if (Date.parse(x[0]) <= target) r = x; else break; }
    // a series that starts less than a week after the target still counts; otherwise nothing
    if (!r && Date.parse(rows[0][0]) - target <= 7 * 86400_000 && rows[0] !== rows[rows.length - 1]) r = rows[0];
    if (r) out[k] = { date: r[0], value: r[1] };
  }
  // YTD: the last close of the previous year
  const y = new Date(last).getUTCFullYear(); let ye = null;
  for (const x of rows) { if (x[0] <= `${y - 1}-12-31`) ye = x; else break; }
  if (ye) out.YTD = { date: ye[0], value: ye[1] };
  return out;
}

export async function handleMarketYields(url, env, ctx, H, json) {
  const now = Date.now(), send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const src = { source: MKT_SOURCE, sourceUrl: MKT_URL_PAGE, kind: "market data: last traded / indicative yield as CNBC shows it (intraday), not an official fixing" };
  if (url.pathname === "/api/yields/market/history") {
    const id = String(url.searchParams.get("id") || "").toUpperCase(), tenor = String(url.searchParams.get("tenor") || "10Y").toUpperCase();
    if (!MKT_TENORS[id] || !MKT_TENORS[id].includes(tenor)) return send({ error: "bad_request", message: "unknown id or maturity" }, 400);
    const r = await bars(url.origin, ctx, mktSymbol(id, tenor), 5, now);
    if (!r.data) return send({ id, tenor, status: "N/A", error: r.err }, 502);
    return send({ id, tenor, freq: "D", points: r.data, ...src, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) });
  }
  if (url.pathname === "/api/yields/market/past") {
    const one = url.searchParams.get("id");
    let wanted;
    if (one) { const id = one.toUpperCase(); if (!MKT_TENORS[id]) return send({ error: "bad_request", message: "unknown id" }, 400); wanted = MKT_TENORS[id].map((t) => [id, t]); }
    else {
      const ids = [...new Set(String(url.searchParams.get("ids") || "").toUpperCase().split(",").map((x) => x.trim()).filter((x) => MKT_TENORS[x] && MKT_TENORS[x].includes("10Y")))].slice(0, 12);
      if (!ids.length) return send({ error: "bad_request", message: "ids: up to 12 countries with a 10-year quote" }, 400);
      wanted = ids.map((id) => [id, "10Y"]);
    }
    const res = await Promise.all(wanted.map(([id, t]) => bars(url.origin, ctx, mktSymbol(id, t), 1, now)));
    const past = {}, errors = {};
    wanted.forEach(([id, t], i) => {
      const r = res[i]; if (!r.data) { (errors[id] = errors[id] || {})[t] = r.err; return; }
      const p = pastOf(r.data), c = (past[id] = past[id] || {});
      for (const [k, x] of Object.entries(p)) (c[k] = c[k] || { date: x.date, points: [] }).points.push({ tenor: t, months: tenorMonths(t), value: x.value, date: x.date });
    });
    return send({ past, errors, ...src, basis: "CNBC's daily bars of the same symbol, dated as CNBC dates them (for some markets the day after the session); the last bar on or before each date", meta: { generatedAt: iso(now) } }, Object.keys(past).length ? 200 : 502);
  }
  const r = await getMarketQuotes(url.origin, ctx);
  if (!r.data) return send({ status: "N/A", error: r.err, ...src }, 502);
  const countries = {}, missing = [];
  for (const id of MKT_IDS) { const c = countryOf(id, r.data, now); if (c) countries[id] = c; else missing.push(id); }
  return send({ countries, missing, regions: MKT_REGIONS, catalog: MKT_TENORS, ...src, status: r.cache === "STALE" ? "STALE" : "LIVE", staleReason: r.staleReason || null, fetchedAt: iso(r.fetchedAt), meta: { generatedAt: iso(now), symbols: MKT_SYMBOLS.length } });
}
