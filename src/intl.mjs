// INTERNATIONAL LISTINGS — quotes and daily / intraday history from the CNBC quote service (approved 20 Oct 2026 for market
// data) for stocks and ETFs outside the U.S. that the Twelve Data plan does not include. The terminal's "SYMBOL:MIC" id maps
// to CNBC's code (checked from the Worker 21 Oct 2026): Milan ISP:XMIL → ISP-IT, Xetra SAP:XETR → SAP-DE, Tokyo 7203:XJPX →
// 7203.T, Hong Kong 700:XHKG → 700-HK, Stockholm VOLV.B:XSTO → VOLV.B-SE …; "C:<CNBC code>" names a CNBC listing directly.
// Fundamentals (market cap, P/E, EPS, dividend yield, shares) are CNBC's own figures, labelled as such.
import { fetchText, iso } from "./lib.mjs";
import { cnbcQuoteUrl, cnbcBarsUrl, cnbcNum, cnbcTime } from "./cnbc.mjs";

export const CNBC_INTL_SOURCE = "cnbc";
// MIC → CNBC suffix ("-IT"), or a Reuters-style suffix (".T") where CNBC uses one
export const MIC_CNBC = {
  XMIL: "-IT", MTAA: "-IT", XETR: "-DE", XFRA: "-FF", XPAR: "-FR", XLON: "-GB", XAMS: "-NL", XBRU: "-BE", XLIS: "-PT", XMAD: "-ES",
  XSWX: "-CH", XVTX: "-CH", XHEL: "-FI", XOSL: "-NO", XSTO: "-SE", XTSE: "-CA", XASX: "-AU", XNSE: "-IN", BVMF: "-BR",
  XSHG: "-CN", XSHE: "-CN", XTAI: "-TW", XSES: "-SG", XHKG: "-HK", XJPX: ".T", XTKS: ".T",
  XDUB: "-IE", XMSM: "-IE", // Euronext Dublin (RYA-IE, KRZ-IE, BIRG-IE answer, 21 Oct 2026)
};
// not carried by CNBC (no primary listing in its symbol lookup, no code answers, 21 Oct 2026): Vienna (XWBO), Copenhagen
// (XCSE), Korea (XKRX / XKOS) — their stocks are found in SRCH through other listings CNBC has (Xetra, Frankfurt, London, Milan)
// the exchange's time zone by CNBC suffix (charts show intraday bars in exchange time)
const SUFFIX_TZ = { IE: "Europe/Dublin", IT: "Europe/Rome", DE: "Europe/Berlin", FF: "Europe/Berlin", FR: "Europe/Paris", GB: "Europe/London", NL: "Europe/Amsterdam", BE: "Europe/Brussels", PT: "Europe/Lisbon", ES: "Europe/Madrid",
  CH: "Europe/Zurich", FI: "Europe/Helsinki", NO: "Europe/Oslo", SE: "Europe/Stockholm", CA: "America/Toronto", AU: "Australia/Sydney", IN: "Asia/Kolkata", BR: "America/Sao_Paulo", CN: "Asia/Shanghai",
  TW: "Asia/Taipei", SG: "Asia/Singapore", HK: "Asia/Hong_Kong", T: "Asia/Tokyo" };
export const cnbcTzOf = (code) => { const m = /[-.]([A-Z]{1,2})$/.exec(String(code || "")); return m ? SUFFIX_TZ[m[1]] || null : null; };
export const isCnbcId = (id) => /^C:[A-Z0-9][A-Z0-9.\-]{0,15}$/.test(String(id || ""));
export function cnbcCodeFor(id) {
  const s = String(id || "").toUpperCase();
  if (isCnbcId(s)) return s.slice(2);
  const i = s.lastIndexOf(":"); if (i <= 0 || s.includes("/")) return null;
  const sym = s.slice(0, i), mic = s.slice(i + 1), suf = MIC_CNBC[mic];
  if (!suf || !/^[A-Z0-9][A-Z0-9.\- ]{0,11}$/.test(sym)) return null;
  if (mic === "XHKG" && /^\d+$/.test(sym)) return `${Number(sym)}-HK`;
  if (mic === "XSTO" || mic === "XHEL" || mic === "XOSL") return sym.replace(/[ -]/g, ".") + suf;
  return sym.replace(/ /g, ".") + suf;
}
// "103.871B" → 103871000000, "6.27%" → 6.27
export function cnbcBig(v) {
  const m = /^(-?[\d,.]+)\s*([KMBT])?$/i.exec(String(v == null ? "" : v).trim());
  if (!m) return null;
  const x = Number(m[1].replace(/,/g, "")); if (!Number.isFinite(x)) return null;
  return x * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(m[2] || "").toUpperCase()] || 1);
}
// CNBC quote → the terminal's flat quote record; Asian exchanges often carry a date without a time ("2026-10-20")
// CNBC answers a venue code it does not carry with the U.S. symbol of the same root (checked 21 Oct 2026: SMH-IT → VanEck
// Semiconductor on NASDAQ, SSAC-NL → a U.S. SPAC, AGGH-IT → a NYSE Arca ETF): a non-U.S. code answered from the U.S. is
// another instrument, never this listing's price
const VENUE_SUFFIXES = [...new Set(Object.values(MIC_CNBC))];
export const cnbcForeignFallback = (q) => { const s = String((q && q.symbol) || "").toUpperCase(); return VENUE_SUFFIXES.some((x) => s.endsWith(x)) && String((q && q.countryCode) || "").toUpperCase() === "US"; };
export function cnbcIntlRec(id, q) {
  if (!q || q.code !== 0 || cnbcForeignFallback(q)) return null;
  const price = cnbcNum(q.last); if (price == null) return null;
  const lt = String(q.last_time || "").trim(), dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(lt) ? lt : null, t = dateOnly ? null : cnbcTime(lt);
  if (!dateOnly && t == null) return null;
  const chgPct = String(q.change_pct).trim() === "UNCH" ? 0 : cnbcNum(q.change_pct), chg = String(q.change).trim() === "UNCH" ? 0 : cnbcNum(q.change);
  return {
    symbol: id, cnbc: q.symbol, name: q.name ? String(q.name) : null, exchange: q.exchange ? String(q.exchange) : null, currency: q.currencyCode ? String(q.currencyCode) : null,
    price, change: chg, changePct: chgPct, prevClose: cnbcNum(q.previous_day_closing), open: cnbcNum(q.open), high: cnbcNum(q.high), low: cnbcNum(q.low),
    volume: cnbcNum(q.volume), fiftyTwoWeekLow: cnbcNum(q.yrloprice), fiftyTwoWeekHigh: cnbcNum(q.yrhiprice),
    marketCap: cnbcBig(q.mktcapView), pe: cnbcNum(q.pe), eps: cnbcNum(q.eps), dividendYield: cnbcNum(q.dividendyield), sharesOutstanding: cnbcBig(q.sharesout),
    asOf: t != null ? iso(t) : null, dateOnly, realTime: String(q.realTime) === "true", country: q.countryCode ? String(q.countryCode) : null, type: q.type ? String(q.type) : null,
  };
}
const NOTE = "CNBC quote service (real-time or delayed as CNBC marks it)", FUND = "as CNBC publishes it";
const FIELD_NOTES = { marketCap: FUND, pe: FUND, eps: FUND, dividendYield: FUND + " (%)", sharesOutstanding: FUND, fiftyTwoWeekLow: FUND, fiftyTwoWeekHigh: FUND };
export const CNBC_STALE_AFTER_MS = 60 * 60_000;
export function cnbcInstrument(rec, { fetchedAt, now = Date.now(), stale = false, error = null, fieldKeys }) {
  const staleAtMs = fetchedAt + CNBC_STALE_AFTER_MS, isStale = stale || now > staleAtMs, fields = {};
  for (const k of fieldKeys) {
    const value = rec[k] == null ? null : rec[k];
    fields[k] = { value, status: value == null ? "N/A" : isStale ? "STALE" : "LIVE", note: value == null ? "not published by CNBC for this listing" : FIELD_NOTES[k] || NOTE };
  }
  return {
    symbol: rec.symbol, name: rec.name, exchange: rec.exchange, mic: null, currency: rec.currency, country: rec.country,
    status: isStale ? "STALE" : "LIVE", source: CNBC_INTL_SOURCE, cnbcSymbol: rec.cnbc, realTime: rec.realTime,
    timestamp: rec.asOf, ...(rec.dateOnly ? { dateOnly: rec.dateOnly } : {}),
    fetchedAt: iso(fetchedAt), staleAt: iso(staleAtMs), marketOpen: null, ...(error ? { staleReason: error } : {}), fields,
  };
}
// one request for up to 40 CNBC codes → { code: raw quote }
export async function loadCnbcRaw(codes, fetchImpl) {
  const out = {}; let err = null;
  for (let i = 0; i < codes.length; i += 40) {
    const f = await (fetchImpl ? fetchImpl(cnbcQuoteUrl(codes.slice(i, i + 40))) : fetchText(cnbcQuoteUrl(codes.slice(i, i + 40)), { timeoutMs: 12000, headers: { accept: "application/json" } }));
    if (f.err) { err = err || f.err; continue; }
    try { const j = JSON.parse(f.text), list = j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote; for (const q of Array.isArray(list) ? list : []) if (q && q.symbol) out[q.symbol] = q; } catch { err = err || "provider_error"; }
  }
  return { data: out, err };
}

// ---------- history: CNBC bars in the History contract ----------
const DAY = 86400_000;
const START = { "1W": 7, "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "5Y": 1827, "10Y": 3653, MAX: 13000 };
// CNBC bars → [{ t, o, h, l, c, v }]; daily bars carry CNBC's date (tradeTime YYYYMMDD), intraday bars their start instant (UTC)
export function cnbcBarsPoints(j, intraday) {
  const bars = j && j.barData && Array.isArray(j.barData.priceBars) ? j.barData.priceBars : [], out = [], seen = new Set();
  for (const b of bars) {
    const c = cnbcNum(b.close); if (c == null) continue;
    const t = intraday ? (Number.isFinite(Number(b.tradeTimeinMills)) ? iso(Number(b.tradeTimeinMills)) : null) : (/^(\d{4})(\d{2})(\d{2})/.exec(String(b.tradeTime || "")) || []).slice(1, 4).join("-");
    if (!t || t === "--" || seen.has(t)) continue; seen.add(t);
    out.push({ t, o: cnbcNum(b.open), h: cnbcNum(b.high), l: cnbcNum(b.low), c, v: Number.isFinite(Number(b.volume)) ? Number(b.volume) : null });
  }
  return out.sort((a, b) => (a.t < b.t ? -1 : 1));
}
// the last N sessions of intraday bars (a session = bars without a gap of more than 4 hours)
export function lastSessions(points, n) {
  if (!points.length) return points;
  let k = points.length - 1, sessions = 1;
  for (; k > 0; k--) { if (Date.parse(points[k].t) - Date.parse(points[k - 1].t) > 4 * 3600_000) { if (sessions === n) break; sessions++; } }
  return points.slice(k);
}
// 5-minute bars → 15-minute or hourly bars (aligned to the quarter hour / the hour)
export function toBucket(points, ms) {
  const out = []; let cur = null;
  for (const p of points) {
    const t = Date.parse(p.t), b = t - (t % ms);
    if (!cur || cur.b !== b) { if (cur) out.push(cur.p); cur = { b, p: { t: iso(b), o: p.o, h: p.h, l: p.l, c: p.c, v: p.v } }; }
    else { cur.p.h = Math.max(cur.p.h ?? p.h, p.h ?? cur.p.h); cur.p.l = Math.min(cur.p.l ?? p.l, p.l ?? cur.p.l); cur.p.c = p.c; cur.p.v = cur.p.v == null || p.v == null ? null : cur.p.v + p.v; }
  }
  if (cur) out.push(cur.p);
  return out;
}
// daily → weekly (bar dated by its last session) or monthly
export function aggregate(points, by) {
  const out = []; let cur = null;
  for (const p of points) {
    const d = new Date(p.t + "T12:00:00Z"), key = by === "1month" ? p.t.slice(0, 7) : new Date(d - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    if (!cur || cur.k !== key) { if (cur) out.push(cur.p); cur = { k: key, p: { ...p } }; }
    else { cur.p.t = p.t; cur.p.h = Math.max(cur.p.h ?? p.h, p.h ?? cur.p.h); cur.p.l = Math.min(cur.p.l ?? p.l, p.l ?? cur.p.l); cur.p.c = p.c; cur.p.v = cur.p.v == null || p.v == null ? null : cur.p.v + p.v; }
  }
  if (cur) out.push(cur.p);
  return out;
}
export async function cnbcHistory(code, { range, interval, now = Date.now() }, fetchImpl) {
  const intraday = ["5min", "15min", "1h"].includes(interval);
  // daily requests end at tomorrow 00:00 so that today's bar (a session in progress) is included
  const get = async (iv, from) => {
    const u = cnbcBarsUrl(code, iv, from, iv === "1D" ? now + DAY : now);
    const f = fetchImpl ? await fetchImpl(u) : await fetchText(u, { timeoutMs: 15000, headers: { accept: "application/json" } });
    if (f.err) return { err: f.err };
    try { return { data: cnbcBarsPoints(JSON.parse(f.text), iv !== "1D") }; } catch { return { err: "provider_error" }; }
  };
  if (intraday) {
    const r = await get("5M", now - (range === "1D" ? 5 : 10) * DAY); if (r.err) return r;
    let pts = lastSessions(r.data, range === "1D" ? 1 : 5);
    if (interval === "15min") pts = toBucket(pts, 900_000); else if (interval === "1h") pts = toBucket(pts, 3600_000);
    return pts.length ? { data: pts } : { err: "no_data" };
  }
  const r = await get("1D", now - (START[range] || 366) * DAY); if (r.err) return r;
  const pts = interval === "1week" || interval === "1month" ? aggregate(r.data, interval) : r.data;
  return pts.length ? { data: pts } : { err: "no_data" };
}
