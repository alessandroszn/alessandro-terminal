// PLAB — portfolio lab: portfolios the owner builds with target weights (saved in KV through /api/user/plab, see
// userdata.mjs) and tests on real history. This module serves ONE instrument's daily closes in EUR:
//   GET /api/plab/series?id=ISIN|C:code|SYMBOL:MIC|SYMBOL[&ccy=EUR|USD|GBP|CHF]   (also the ETF compare, EFC)
//   → CNBC's daily bars of the listing (the same listing rules as FACT, factors.mjs: an ISIN's UCITS line or Xetra line,
//     a C:code, SYMBOL:MIC, a plain U.S. symbol), up to 15 years, converted to EUR at CNBC's FX close of the same day
//     (EUR= and GBP= USD per unit, CHF= CHF per USD) — DERIVED; and the fund's justETF reference line (TER, distribution
//     policy) where it has been read. One instrument a request, so that each runs in its own Worker invocation.
// The backtest, risk, stress tests, comparison and projection are computed in the page (qmath.js). Never a value made
// up: a day without a close or an FX rate is left out; an instrument younger than the period starts at its first close.
// BONDS (approved 22 Oct 2026: "price rebuilt from the curve"): a bond ISIN (the ECB list, else OpenFIGI) has no daily
// price here, so the answer is its terms and the plan of its estimate — the government curve it is priced on (the
// issuer's country when the bond is in that country's currency, else the currency's benchmark: EUR → Germany) and the
// maturities that bracket its remaining life since issue (at most 15 years back). The page loads those yields
//   GET /api/plab/curve?cc=IT&tenor=10Y   CNBC's daily closes of one maturity (yield %), dated by session
//   GET /api/plab/fx?from=USD&to=EUR      the value of one unit of `from` in `to`, CNBC's FX closes
// and prices the bond each day (qmath.js bondHistory: the curve at the remaining maturity plus a constant spread set by
// today's price, coupons reinvested) — an ESTIMATE, labelled as such, never shown as a market price.
import { iso } from "./lib.mjs";
import { cnbcDaily } from "./cnbc.mjs";
import { loadCnbcRaw, cnbcForeignFallback } from "./intl.mjs";
import { isinValid } from "./isin.mjs";
import { factorTarget, uniMaps, valuesOn, usdPer, offListTarget } from "./factors.mjs";
import { UCITS_ETFS, lineOf } from "./ucits.mjs";
import { refFromLine, TABLE_COLS } from "./etfref.mjs";
import { MKT_TENORS, tenorMonths, mktSymbol } from "./mktyields.mjs";
import { bondTerms, homeCcy } from "./yas.mjs";
import { eaTable, eaLookup } from "./ecbassets.mjs";

export const PLAB_DAYS = 5480; // 15 years of daily bars
const getJ = async (env, k) => { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : null; } catch { return null; } };
// one fund's line out of the justETF table without splitting the whole table
export function tableLineOf(table, isin) {
  const t = String(table || ""), key = isin + "\t", i = t.startsWith(key) ? 0 : t.indexOf("\n" + key);
  if (i < 0) return null; const s = i === 0 ? 0 : i + 1, e = t.indexOf("\n", s), f = t.slice(s, e < 0 ? undefined : e).split("\t");
  return f.length >= TABLE_COLS.length ? f : null;
}
export const SERIES_CCYS = ["EUR", "USD", "GBP", "CHF"];
const FX_OF = { EUR: "EUR=", GBP: "GBP=", CHF: "CHF=" };
// daily closes [[date, close]] in the listing's currency → another currency, the FX closes on or before each date
export function toCcy(rows, ccy, pence, fx, to = "EUR") {
  const unit = pence ? 100 : 1, dates = rows.map((r) => r[0]);
  if (ccy === to) return rows.map(([d, v]) => [d, v / unit]).filter((x) => x[1] > 0);
  const codes = [...new Set([FX_OF[ccy], FX_OF[to]].filter(Boolean))], at = Object.fromEntries(codes.map((c) => [c, valuesOn(fx[c] || [], dates)])), out = [];
  rows.forEach(([d, v], i) => { const k = {}; for (const c of codes) k[c] = at[c][i]; const a = usdPer(ccy, k), b = usdPer(to, k); if (a > 0 && b > 0 && v > 0) out.push([d, (v / unit) * a / b]); });
  return out;
}
export const toEur = (rows, ccy, pence, fx) => toCcy(rows, ccy, pence, fx, "EUR");
// the listing used for a currency: the fund's own line in it (UCITS list, or a Xetra line in it) where there is one,
// otherwise the FACT rules (UCITS USD line / default line, Xetra EUR line, C:code, SYMBOL:MIC, U.S. symbol)
export function seriesTarget(id, uni, to) {
  const s = String(id || "").trim().toUpperCase();
  if (isinValid(s)) {
    const u = UCITS_ETFS.find((e) => e.isin === s), l = u && u.lines[to];
    if (l) return { id: s, isin: s, name: u.name, cnbc: l.cnbc, ccy: l.ccy, pence: !!l.pence, venue: l.venue, ticker: l.ticker };
    const row = !u && uni.byIsin && uni.byIsin.get(s), xl = row ? String(row[5] || "").split(" ").filter(Boolean).map((t) => t.split(":")) : [], own = xl.find((x) => x[1] === to);
    if (own) { const k = lineOf(own[0] + "-DE", to); return { id: s, isin: s, name: row[1], cnbc: k.cnbc, ccy: null, pence: false, venue: k.venue, ticker: k.ticker }; }
  }
  return factorTarget(s, uni);
}
const sig = (v) => Number(v.toPrecision(7));
const DAYMS = 86400_000;
// ---------- bonds ----------
// the curve a bond is priced on: its issuer's country when the bond is in that country's currency, else the benchmark of
// its currency
export const CURVE_OF_CCY = { EUR: "DE", USD: "US", GBP: "UK", CHF: "CH" };
export function curveCountry(ref) {
  const cc0 = ref.residence || ref.isin.slice(0, 2), cc = cc0 === "GB" ? "UK" : cc0, own = homeCcy(cc0);
  if (MKT_TENORS[cc] && own && own === ref.ccy) return { cc, why: "issuer's country" };
  const b = CURVE_OF_CCY[ref.ccy]; return b ? { cc: b, why: `benchmark of ${ref.ccy}` } : null;
}
// the maturities whose yields the estimate needs: those inside the bond's remaining life over the window, and the nearest
// one beyond each end (linear interpolation between two quoted maturities; flat beyond the shortest and the longest)
export function bondTenors(cc, start, maturity, now) {
  const yrsTo = (d) => (Date.parse(maturity + "T00:00:00Z") - Date.parse(d + "T00:00:00Z")) / DAYMS / 365, lo = yrsTo(new Date(now).toISOString().slice(0, 10)) * 12, hi = yrsTo(start) * 12;
  const ts = (MKT_TENORS[cc] || []).map((t) => [t, tenorMonths(t)]).sort((a, b) => a[1] - b[1]);
  const inside = ts.filter(([, m]) => m >= lo && m <= hi), below = ts.filter(([, m]) => m < lo).pop(), above = ts.find(([, m]) => m > hi);
  return [below, ...inside, above].filter(Boolean).map(([t]) => t);
}
export function bondPlan(ref, now) {
  if (ref.floating || ref.coupon == null) return { error: "floating_bond" };
  if (ref.kind === "linker") return { error: "inflation_linked" };
  if (!ref.maturity || ref.maturity <= new Date(now + 30 * DAYMS).toISOString().slice(0, 10)) return { error: "bond_matured" };
  if (!ref.ccy) return { error: "no_currency" };
  if (!SERIES_CCYS.includes(ref.ccy)) return { error: "fx_unavailable" };
  const c = curveCountry(ref); if (!c) return { error: "no_curve" };
  const back = new Date(now - PLAB_DAYS * DAYMS).toISOString().slice(0, 10), start = ref.issue && ref.issue > back ? ref.issue : back;
  return { cc: c.cc, why: c.why, start, tenors: bondTenors(c.cc, start, ref.maturity, now) };
}
// CNBC dates a European government bond's daily bar the day after the session it closes (checked 20 Oct 2026: the bar
// of a day holds the previous close; U.S. and Canadian bars carry the session's own date): moved to the previous weekday
export function sessionDated(cc, rows) {
  if (cc === "US" || cc === "CA") return rows;
  const out = [];
  for (const [d, v] of rows) {
    const t = Date.parse(d + "T12:00:00Z"); let p = t - DAYMS; while ([0, 6].includes(new Date(p).getUTCDay())) p -= DAYMS;
    const nd = new Date(p).toISOString().slice(0, 10); if (out.length && out[out.length - 1][0] === nd) out[out.length - 1][1] = v; else out.push([nd, v]);
  }
  return out;
}
async function bondAnswer(url, env, ctx, id, isin, now, deps) {
  const t = await bondTerms(url, env, ctx, isin, deps); if (t.err) return null;
  const ref = t.ref, plan = bondPlan(ref, now);
  return { id, isin, kind: "bond", name: ref.name, ccy: ref.ccy, to: "EUR", status: t.status,
    bond: { coupon: ref.coupon, zero: !!ref.zero, freq: ref.freq, freqFrom: ref.freqFrom, maturity: ref.maturity, issue: ref.issue || null, issuer: ref.issuer || null, residence: ref.residence || null, group: ref.group || null, ticker: ref.ticker || null, kind: ref.kind || "fixed", checked: !!ref.checked, source: ref.source },
    plan: plan.error ? null : plan, error: plan.error || undefined,
    basis: "no daily price: an ESTIMATE priced on the government curve (CNBC daily yields at the bond's remaining maturity) plus a constant spread set by today's price; coupons reinvested" };
}

export async function handlePlab(url, env, ctx, H, json, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "not_configured", status: "N/A" }, 503);
  const now = deps.now || Date.now(), daily0 = deps.daily || ((code) => cnbcDaily(url.origin, ctx, code, PLAB_DAYS, now));
  if (url.pathname === "/api/plab/curve") {
    const cc = String(url.searchParams.get("cc") || "").toUpperCase(), tenor = String(url.searchParams.get("tenor") || "").toUpperCase();
    if (!MKT_TENORS[cc] || !MKT_TENORS[cc].includes(tenor)) return send({ error: "bad_request", message: "cc and tenor: a country and a maturity CNBC quotes (see /api/yields/market)" }, 400);
    const b = await daily0(mktSymbol(cc, tenor));
    if (!b || !b.data || b.data.length < 2) return send({ cc, tenor, error: (b && b.err) || "no_data", status: "N/A" }, 502);
    const rows = sessionDated(cc, b.data);
    return send({ cc, tenor, months: tenorMonths(tenor), symbol: mktSymbol(cc, tenor), d: rows.map((x) => x[0]), v: rows.map((x) => x[1]), first: rows[0][0], last: rows[rows.length - 1][0],
      status: b.cache === "STALE" ? "STALE" : "LIVE", source: "CNBC daily bars (yield %)", fetchedAt: iso(b.fetchedAt || now), basis: cc === "US" || cc === "CA" ? "dated by session" : "CNBC dates these bars the day after the session: moved to the session's weekday" });
  }
  if (url.pathname === "/api/plab/fx") {
    const from = String(url.searchParams.get("from") || "").toUpperCase(), to2 = String(url.searchParams.get("to") || "EUR").toUpperCase();
    if (!SERIES_CCYS.includes(from) || !SERIES_CCYS.includes(to2) || from === to2) return send({ error: "bad_request", message: "from, to: two of EUR, USD, GBP, CHF" }, 400);
    const need = [...new Set([FX_OF[from], FX_OF[to2]].filter(Boolean))], res = await Promise.all(need.map((c) => daily0(c))), fx = {};
    need.forEach((c, i) => { if (res[i] && res[i].data) fx[c] = res[i].data; });
    if (need.some((c) => !fx[c])) return send({ from, to: to2, error: "fx_unavailable", status: "N/A" }, 502);
    const rows = toCcy(fx[need[0]].map(([d]) => [d, 1]), from, false, fx, to2);
    if (rows.length < 2) return send({ from, to: to2, error: "no_data", status: "N/A" }, 502);
    return send({ from, to: to2, d: rows.map((x) => x[0]), v: rows.map((x) => sig(x[1])), first: rows[0][0], last: rows[rows.length - 1][0], status: res.some((x) => x && x.cache === "STALE") ? "STALE" : "LIVE", source: "CNBC FX daily closes", basis: `the value of 1 ${from} in ${to2} (DERIVED from CNBC's EUR=, GBP=, CHF=)` });
  }
  if (url.pathname !== "/api/plab/series") return send({ error: "not found" }, 404);
  const id = String(url.searchParams.get("id") || "").trim().toUpperCase(), to = String(url.searchParams.get("ccy") || "EUR").toUpperCase();
  if (!SERIES_CCYS.includes(to)) return send({ error: "bad_request", message: "ccy: EUR, USD, GBP or CHF" }, 400);
  if (!/^[A-Z0-9][A-Z0-9.\-:]{0,23}$/.test(id)) return send({ error: "bad_request", message: "id: an ISIN, a C:code, SYMBOL:MIC or a U.S. symbol" }, 400);
  const uni = isinValid(id) || /-DE$|:XETR$/.test(id) ? uniMaps(await getJ(env, "etf/universe")) : {};
  let t = seriesTarget(id, uni, to);
  // a bond on the ECB list (never an ETF or a share): its terms and the plan of its estimate
  if (t.error === "not_listed" && t.isin && eaLookup(deps.table != null ? deps.table : await eaTable(env), t.isin)) { const b = await bondAnswer(url, env, ctx, id, t.isin, now, deps); if (b) return send(b); }
  if (t.error === "not_listed" && t.isin) t = await offListTarget(url, env, ctx, t.isin, to, deps.fundLines);
  // not listed anywhere CNBC answers: a bond OpenFIGI names?
  if (t.error === "not_listed" && t.isin) { const b = await bondAnswer(url, env, ctx, id, t.isin, now, deps); if (b) return send(b); }
  if (t.error) return send({ id, error: t.error, status: "N/A" }, 404);
  // the listing's currency and name: CNBC's quote (a venue code CNBC answers from the U.S. is not this listing)
  const q = await (deps.loadQuotes || loadCnbcRaw)([t.cnbc]), r = q.data && q.data[t.cnbc];
  if (r && cnbcForeignFallback(r)) return send({ id, error: "not_carried", status: "N/A" }, 404);
  if (!t.ccy) { const c = r && r.currencyCode ? String(r.currencyCode) : null; if (!c) return send({ id, error: r ? "no_currency" : "no_quote", status: "N/A" }, 502); t.pence = c === "GBp" || c === "GBX"; t.ccy = t.pence ? "GBP" : c; }
  if (!usdPer(t.ccy, { "EUR=": 1, "GBP=": 1, "CHF=": 1 })) return send({ id, error: "fx_unavailable", status: "N/A", ccy: t.ccy }, 502);
  if (!t.name && r && r.name) t.name = String(r.name);
  const daily = daily0;
  const need = t.ccy === to ? [] : [...new Set([FX_OF[t.ccy], FX_OF[to]].filter(Boolean))];
  const [b, ...fxr] = await Promise.all([daily(t.cnbc), ...need.map((c) => daily(c))]);
  if (!b || !b.data || !b.data.length) return send({ id, error: (b && b.err) || "no_data", status: "N/A" }, 502);
  const fx = {}; need.forEach((c, i) => { if (fxr[i] && fxr[i].data) fx[c] = fxr[i].data; });
  if (need.some((c) => !fx[c])) return send({ id, error: "fx_unavailable", status: "N/A" }, 502);
  const rows = toCcy(b.data, t.ccy, t.pence, fx, to);
  if (rows.length < 2) return send({ id, error: "no_data", status: "N/A" }, 502);
  const line = t.isin ? tableLineOf(await env.BRIEFS.get("ref/je/table"), t.isin) : null, ref = refFromLine(line);
  return send({
    id, isin: t.isin || null, name: t.name || null, cnbc: t.cnbc, venue: t.venue || null, ticker: t.ticker || null, ccy: t.ccy, pence: !!t.pence,
    to, conv: t.ccy !== to ? { from: t.ccy, to, via: "CNBC FX" } : null, us: !!t.us, offList: !!t.offList,
    first: rows[0][0], last: rows[rows.length - 1][0], d: rows.map((x) => x[0]), v: rows.map((x) => sig(x[1])),
    status: b.cache === "STALE" || fxr.some((x) => x && x.cache === "STALE") ? "STALE" : "LIVE", source: "CNBC daily bars", fetchedAt: iso(b.fetchedAt || now),
    ref: ref ? { ter: ref.ter, distribution: ref.distribution, focus: ref.focus, day: ref.day, source: "justETF" } : null,
    basis: "CNBC daily closes of the listing (the fund's own line in the currency where it has one), converted at CNBC's FX close of the same day where the listing is in another currency (DERIVED); price returns as CNBC adjusts its bars",
  });
}
