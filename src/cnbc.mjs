// CNBC MARKETS — futures (index, rates, currencies, crypto, energy, metals, grains, softs, livestock), their curves by
// contract month, where index futures say the cash index will open, and daily closes for returns and charts.
// Source: CNBC's quote service (quote.cnbc.com) and its chart service (ts-api.cnbc.com), approved 20 Oct 2026 ("CNBC for
// markets", the same service as the market yields). Private, owner-only use; always labelled market data with CNBC's own
// time and whether CNBC marks the quote real-time or delayed. Symbols checked from the Worker on 20 Oct 2026.
//   GET /api/cnbc/futures                 latest quote of every contract below (front month, CNBC's continuous symbol)
//   GET /api/cnbc/returns?syms=@CL.1,…    1W / 1M / 3M / YTD / 1Y reference closes and a 3-month line (≤ 16 symbols)
//   GET /api/cnbc/curve?root=CL           contract months 1…N now, and the same positions 1 week / 1 month earlier
//   GET /api/cnbc/implied                 index futures vs the cash index's last print: implied opening move
//   GET /api/cnbc/history?sym=@GC.1       daily closes (5 years)
import { fetchText, cachedSource, iso } from "./lib.mjs";

export const CNBC_SOURCE = "CNBC quote service";
export const CNBC_PAGE = "https://www.cnbc.com/markets/";
export const cnbcQuoteUrl = (syms) => `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms.map(encodeURIComponent).join("%7C")}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
export const cnbcBarsUrl = (sym, iv, from, to) => `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/${iv}/${ymd(from)}000000/${ymd(to)}${iv === "1D" ? "000000" : "235900"}/adjusted/EST5EDT.json`;

// [symbol, label, group, unit]; the contract month comes from CNBC's name, e.g. "Russell 2000 E-mini (Dec'26)"
export const FUTURES = [
  ["@SP.1", "S&P 500 E-mini", "Equity index", "pts"], ["@ND.1", "Nasdaq-100 E-mini", "Equity index", "pts"], ["@DJ.1", "Dow E-mini", "Equity index", "pts"],
  ["@TFS.1", "Russell 2000 E-mini", "Equity index", "pts"], ["@NK.1", "Nikkei 225 (CME, USD)", "Equity index", "pts"], ["@VX.1", "VIX futures", "Equity index", "pts"],
  ["@TU.1", "U.S. 2-year note", "Rates", "price"], ["@FV.1", "U.S. 5-year note", "Rates", "price"], ["@TY.1", "U.S. 10-year note", "Rates", "price"], ["@US.1", "U.S. Treasury bond", "Rates", "price"],
  ["@URO.1", "Euro FX", "Currencies", "USD"], ["@JY.1", "Japanese yen", "Currencies", "USD"], ["@BP.1", "British pound", "Currencies", "USD"], ["@SF.1", "Swiss franc", "Currencies", "USD"],
  ["@CD.1", "Canadian dollar", "Currencies", "USD"], ["@AD.1", "Australian dollar", "Currencies", "USD"], ["@DX.1", "U.S. Dollar Index futures", "Currencies", "pts"],
  ["@BTC.1", "Bitcoin (CME)", "Crypto", "USD"], ["@ETH.1", "Ether (CME)", "Crypto", "USD"],
  ["@CL.1", "WTI crude oil", "Energy", "$/bbl"], ["@LCO.1", "Brent crude oil", "Energy", "$/bbl"], ["@NG.1", "Natural gas (Henry Hub)", "Energy", "$/MMBtu"],
  ["@RB.1", "RBOB gasoline", "Energy", "$/gal"], ["@HO.1", "Heating oil (ULSD)", "Energy", "$/gal"],
  ["@GC.1", "Gold", "Metals", "$/oz"], ["@SI.1", "Silver", "Metals", "$/oz"], ["@PL.1", "Platinum", "Metals", "$/oz"], ["@PA.1", "Palladium", "Metals", "$/oz"], ["@HG.1", "Copper", "Metals", "$/lb"],
  ["@C.1", "Corn", "Grains", "¢/bu"], ["@W.1", "Wheat (Chicago)", "Grains", "¢/bu"], ["@KW.1", "Wheat (Kansas City)", "Grains", "¢/bu"], ["@S.1", "Soybeans", "Grains", "¢/bu"],
  ["@BO.1", "Soybean oil", "Grains", "¢/lb"], ["@SM.1", "Soybean meal", "Grains", "$/short ton"], ["@O.1", "Oats", "Grains", "¢/bu"], ["@RR.1", "Rough rice", "Grains", "$/cwt"],
  ["@KC.1", "Coffee", "Softs", "¢/lb"], ["@SB.1", "Sugar No. 11", "Softs", "¢/lb"], ["@CC.1", "Cocoa", "Softs", "$/t"], ["@CT.1", "Cotton", "Softs", "¢/lb"], ["@OJ.1", "Orange juice", "Softs", "¢/lb"],
  ["@LC.1", "Live cattle", "Livestock", "¢/lb"], ["@FC.1", "Feeder cattle", "Livestock", "¢/lb"], ["@LH.1", "Lean hogs", "Livestock", "¢/lb"],
];
export const FUT_GROUPS = [...new Set(FUTURES.map((f) => f[2]))];
// the curves: root → [label, contract months answered on 20 Oct 2026]
export const CURVES = { CL: ["WTI crude oil", 12], LCO: ["Brent crude oil", 6], NG: ["Natural gas", 12], RB: ["RBOB gasoline", 6], HO: ["Heating oil", 6], GC: ["Gold", 6], SI: ["Silver", 6], HG: ["Copper", 6], C: ["Corn", 6], W: ["Wheat", 6], S: ["Soybeans", 6], KC: ["Coffee", 6] };
// index futures and the cash index they price: [future, cash, label]
// [future, cash, label, exchange time zone, regular session open, close]
export const IMPLIED = [["@SP.1", ".SPX", "S&P 500", "America/New_York", "09:30", "16:00"], ["@ND.1", ".NDX", "Nasdaq-100", "America/New_York", "09:30", "16:00"],
  ["@DJ.1", ".DJI", "Dow Jones", "America/New_York", "09:30", "16:00"], ["@TFS.1", ".RUT", "Russell 2000", "America/New_York", "09:30", "16:00"], ["@NK.1", ".N225", "Nikkei 225", "Asia/Tokyo", "09:00", "15:30"]];
// is the cash market inside its regular session now (weekday, local time between open and close)? Holidays are not known here:
// on a holiday the cash index's last print is simply the previous close, which the implied move then uses
export function inSession(now, tz, open, close) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const hm = `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}`;
  return hm >= open && hm < close;
}
// other symbols the terminal reads from CNBC (whitelist for /api/cnbc/history and /returns): cash indices, and the FX board's
// eight pairs as CNBC codes them (EUR= is EUR/USD, GBP= GBP/USD, AUD= AUD/USD, NZD= NZD/USD; JPY= is USD/JPY, CHF=, CAD=, CNY= the same way)
export const FX_CNBC = { EUR: "EUR=", GBP: "GBP=", JPY: "JPY=", CHF: "CHF=", CAD: "CAD=", AUD: "AUD=", NZD: "NZD=", CNY: "CNY=" };
export const EXTRA_SYMS = [".DXY", ".SPX", ".NDX", ".DJI", ".RUT", ".N225", ...Object.values(FX_CNBC)];

// numbers as CNBC writes them: "10,733.00", "-0.4738%", "+0.005", "UNCH" (= 0 change)
export const cnbcNum = (s) => { const t = String(s == null ? "" : s).replace(/,/g, "").replace(/%$/, "").trim(); return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
export const cnbcTime = (s) => { const t = Date.parse(String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")); return Number.isFinite(t) ? t : null; };
export const contractOf = (name) => { const m = /\(([A-Z][a-z]{2})'(\d{2})\)/.exec(String(name || "")); return m ? `${m[1]} 20${m[2]}` : null; };
export function parseCnbcQuote(q) {
  if (!q || q.code !== 0) return null;
  const last = cnbcNum(q.last), time = cnbcTime(q.last_time);
  if (last == null || time == null || /%/.test(String(q.last))) return null;
  const prev = cnbcNum(q.previous_day_closing);
  const chg = String(q.change).trim() === "UNCH" ? 0 : cnbcNum(q.change), chgPct = String(q.change_pct).trim() === "UNCH" ? 0 : cnbcNum(q.change_pct);
  return { sym: q.symbol, name: q.name ? String(q.name) : null, contract: contractOf(q.name), last, prev, chg, chgPct,
    open: cnbcNum(q.open), high: cnbcNum(q.high), low: cnbcNum(q.low), volume: cnbcNum(q.volume), time,
    venue: q.exchange ? String(q.exchange) : null, realTime: String(q.realTime) === "true", session: q.curmktstatus ? String(q.curmktstatus) : null };
}
export function parseCnbcQuotes(j) {
  const list = j && j.FormattedQuoteResult && Array.isArray(j.FormattedQuoteResult.FormattedQuote) ? j.FormattedQuoteResult.FormattedQuote : [];
  const out = {}; for (const q of list) { const p = parseCnbcQuote(q); if (p) out[p.sym] = p; }
  return out;
}
export async function loadCnbcQuotes(syms) {
  const parts = []; for (let i = 0; i < syms.length; i += 40) parts.push(syms.slice(i, i + 40));
  const res = await Promise.all(parts.map((p) => fetchText(cnbcQuoteUrl(p), { timeoutMs: 12000, headers: { accept: "application/json" } })));
  const out = {}; let err = null;
  for (const f of res) { if (f.err) { err = err || f.err; continue; } try { Object.assign(out, parseCnbcQuotes(JSON.parse(f.text))); } catch { err = err || "provider_error"; } }
  return Object.keys(out).length ? { data: out } : { err: err || "no_data" };
}
// bars → [[epoch ms, open, high, low, close]] oldest first; daily bars are dated as CNBC dates them (see mktyields.mjs)
export function parseCnbcBars(j) {
  const bars = j && j.barData && Array.isArray(j.barData.priceBars) ? j.barData.priceBars : [];
  const out = [];
  for (const b of bars) {
    const t = Number(b && b.tradeTimeinMills), c = cnbcNum(b && b.close);
    if (!Number.isFinite(t) || c == null) continue;
    out.push([t, cnbcNum(b.open), cnbcNum(b.high), cnbcNum(b.low), c]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.filter((x, i) => i === 0 || x[0] !== out[i - 1][0]);
}
// daily bars → [["2026-10-19", close]]: the date CNBC gives the bar (its tradeTime), weekend-dated bars kept as CNBC has them
export function dailyCloses(j) {
  const bars = j && j.barData && Array.isArray(j.barData.priceBars) ? j.barData.priceBars : [];
  const out = [];
  for (const b of bars) { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(b && b.tradeTime || "")), c = cnbcNum(b && b.close); if (m && c != null) out.push([`${m[1]}-${m[2]}-${m[3]}`, c]); }
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out.filter((x, i) => i === 0 || x[0] !== out[i - 1][0]);
}
async function loadDaily(sym, days, now) {
  const f = await fetchText(cnbcBarsUrl(sym, "1D", now - days * 86400_000, now + 86400_000), { timeoutMs: 15000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.err };
  let rows; try { rows = dailyCloses(JSON.parse(f.text)); } catch { return { err: "provider_error" }; }
  return rows.length ? { data: rows } : { err: "no_data" };
}
const daily = (origin, ctx, sym, days, now) => cachedSource({ origin, key: `cnbc/d${days}/${sym}`, ttlMs: 6 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, load: () => loadDaily(sym, days, now) });

// the reference closes for returns: the last close on or before 7 / 30 / 91 / 365 days before the latest bar, and the last
// close of the previous year (YTD) — never interpolated
export const REF = [["1W", 7], ["1M", 30], ["3M", 91], ["1Y", 365]];
export function referenceCloses(rows) {
  const out = {}; if (!rows || rows.length < 2) return out;
  const lastT = Date.parse(rows[rows.length - 1][0]);
  const at = (t) => { let r = null; for (const x of rows) { if (Date.parse(x[0]) <= t) r = x; else break; } return r; };
  for (const [k, d] of REF) { const r = at(lastT - d * 86400_000); if (r) out[k] = r; }
  const y = new Date(lastT).getUTCFullYear(), ye = at(Date.UTC(y - 1, 11, 31, 23, 59));
  if (ye) out.YTD = ye;
  return out;
}

// implied open: the futures' change since the minute of the cash index's last print, applied to that print
export function impliedOpen(cash, fut, bars, now = Date.now(), session = null) {
  if (!cash || !fut) return null;
  const cashOpen = session ? inSession(now, ...session) : cash.session === "REG_MKT" && now - cash.time < 20 * 60_000;
  if (cashOpen) return { cashOpen: true };
  // bars: [[epoch ms of the bar's start, close]] oldest first (CNBC stamps a bar with its start, checked 20 Oct 2026 on hourly
  // bars); the last five-minute bar that ended by the cash print (one minute of tolerance)
  let ref = null; for (const b of bars || []) { if (b[0] + 5 * 60_000 <= cash.time + 60_000) ref = b; else break; }
  if (!ref || !(ref[1] > 0)) return { cashOpen: false, error: "no_bar_at_close" };
  const pct = (fut.last / ref[1] - 1) * 100;
  return { cashOpen: false, futAtClose: ref[1], futAtCloseTime: iso(ref[0]), pct: Math.round(pct * 1000) / 1000, level: Math.round(cash.last * (1 + pct / 100) * 100) / 100 };
}

const send0 = (json, H) => (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
const ALLOWED = new Set([...FUTURES.map((f) => f[0]), ...EXTRA_SYMS, ...Object.entries(CURVES).flatMap(([r, [, n]]) => Array.from({ length: n }, (_, i) => `@${r}.${i + 1}`))]);
export const isAllowed = (s) => ALLOWED.has(s);
const SRC = { source: CNBC_SOURCE, sourceUrl: CNBC_PAGE, kind: "market data: latest price as CNBC shows it, with CNBC's time; real-time or delayed as CNBC marks it (exchange rules)" };

export async function handleCnbc(url, env, ctx, H, json) {
  const now = Date.now(), send = send0(json, H), p = url.pathname;
  if (p === "/api/cnbc/futures") {
    const r = await cachedSource({ origin: url.origin, key: "cnbc/fut1", ttlMs: 60_000, staleMaxMs: 3 * 86400_000, failTtlMs: 60_000, ctx, load: () => loadCnbcQuotes(FUTURES.map((f) => f[0])) });
    if (!r.data) return send({ status: "N/A", error: r.err, ...SRC }, 502);
    const rows = FUTURES.map(([sym, label, group, unit]) => { const q = r.data[sym]; return q ? { ...q, label, group, unit, status: now - q.time > 4 * 86400_000 ? "STALE" : "LIVE" } : { sym, label, group, unit, status: "N/A", error: "no_quote" }; });
    return send({ rows, groups: FUT_GROUPS, ...SRC, status: r.cache === "STALE" ? "STALE" : "LIVE", staleReason: r.staleReason || null, fetchedAt: iso(r.fetchedAt) });
  }
  if (p === "/api/cnbc/returns") {
    const syms = [...new Set(String(url.searchParams.get("syms") || "").split(",").map((s) => s.trim()).filter(isAllowed))].slice(0, 16);
    if (!syms.length) return send({ error: "bad_request", message: "syms: up to 16 known symbols" }, 400);
    const res = await Promise.all(syms.map((s) => daily(url.origin, ctx, s, 400, now)));
    const out = {}, errors = {};
    syms.forEach((s, i) => { const r = res[i]; if (!r.data) { errors[s] = r.err; return; } const rows = r.data; out[s] = { ref: referenceCloses(rows), last: rows[rows.length - 1], line: rows.slice(-63).map((x) => x[1]) }; });
    return send({ returns: out, errors, basis: "CNBC's daily bars of the same symbol, dated as CNBC dates them; returns = latest price ÷ the reference close − 1 (DERIVED in the page)", ...SRC }, Object.keys(out).length ? 200 : 502);
  }
  if (p === "/api/cnbc/curve") {
    const root = String(url.searchParams.get("root") || "").toUpperCase(), c = CURVES[root];
    if (!c) return send({ error: "bad_request", message: "root: one of " + Object.keys(CURVES).join(",") }, 400);
    const syms = Array.from({ length: c[1] }, (_, i) => `@${root}.${i + 1}`);
    const q = await cachedSource({ origin: url.origin, key: `cnbc/crv/${root}`, ttlMs: 120_000, staleMaxMs: 3 * 86400_000, failTtlMs: 60_000, ctx, load: () => loadCnbcQuotes(syms) });
    if (!q.data) return send({ root, status: "N/A", error: q.err, ...SRC }, 502);
    const hist = await Promise.all(syms.map((s) => daily(url.origin, ctx, s, 400, now)));
    const points = syms.map((s, i) => { const x = q.data[s], h = hist[i].data; return { pos: i + 1, sym: s, contract: x ? x.contract : null, last: x ? x.last : null, chgPct: x ? x.chgPct : null, time: x ? iso(x.time) : null, ref: h ? referenceCloses(h) : {} }; });
    return send({ root, name: c[0], points, ...SRC, basis: "each position is CNBC's continuous contract (1 = front month); earlier curves are the same positions' daily closes, so their contract months can differ (a roll)", status: q.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(q.fetchedAt) });
  }
  if (p === "/api/cnbc/implied") {
    const syms = IMPLIED.flatMap(([f, c]) => [f, c]);
    const q = await cachedSource({ origin: url.origin, key: "cnbc/impl/q", ttlMs: 60_000, staleMaxMs: 86400_000, failTtlMs: 60_000, ctx, load: () => loadCnbcQuotes(syms) });
    if (!q.data) return send({ status: "N/A", error: q.err, ...SRC }, 502);
    // five-minute futures bars of the last four days, to find the futures' price at the cash index's last print
    const bars = await Promise.all(IMPLIED.map(([f]) => cachedSource({ origin: url.origin, key: `cnbc/impl/b/${f}`, ttlMs: 5 * 60_000, staleMaxMs: 86400_000, ctx,
      load: async () => { const g = await fetchText(cnbcBarsUrl(f, "5M", now - 4 * 86400_000, now), { timeoutMs: 15000, headers: { accept: "application/json" } }); if (g.err) return { err: g.err }; try { const b = parseCnbcBars(JSON.parse(g.text)); return b.length ? { data: b.map((x) => [x[0], x[4]]) } : { err: "no_data" }; } catch { return { err: "provider_error" }; } } })));
    const rows = IMPLIED.map(([f, c, label, tz, o, cl], i) => {
      const fq = q.data[f], cq = q.data[c], im = impliedOpen(cq, fq, bars[i].data, now, [tz, o, cl]);
      return { label, future: f, cash: c, contract: fq ? fq.contract : null, futLast: fq ? fq.last : null, futTime: fq ? iso(fq.time) : null, cashLast: cq ? cq.last : null, cashTime: cq ? iso(cq.time) : null, cashChgPct: cq ? cq.chgPct : null, ...(im || { error: "no_quote" }) };
    });
    return send({ rows, ...SRC, basis: "implied move = futures price now ÷ the futures price at the minute of the cash index's last print − 1 (five-minute bars), applied to that print; it ignores the futures' fair-value basis — DERIVED", fetchedAt: iso(q.fetchedAt) });
  }
  if (p === "/api/cnbc/history") {
    const sym = String(url.searchParams.get("sym") || "");
    if (!isAllowed(sym)) return send({ error: "bad_request", message: "unknown symbol" }, 400);
    const r = await daily(url.origin, ctx, sym, 1830, now);
    if (!r.data) return send({ sym, status: "N/A", error: r.err }, 502);
    return send({ sym, points: r.data, ...SRC, basis: "CNBC's daily bars, dated as CNBC dates them", status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) });
  }
  return send({ error: "not_found" }, 404);
}
