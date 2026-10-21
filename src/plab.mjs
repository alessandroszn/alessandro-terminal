// PLAB — portfolio lab: portfolios the owner builds with target weights (saved in KV through /api/user/plab, see
// userdata.mjs) and tests on real history. This module serves ONE instrument's daily closes in EUR:
//   GET /api/plab/series?id=ISIN|C:code|SYMBOL:MIC|SYMBOL
//   → CNBC's daily bars of the listing (the same listing rules as FACT, factors.mjs: an ISIN's UCITS line or Xetra line,
//     a C:code, SYMBOL:MIC, a plain U.S. symbol), up to 15 years, converted to EUR at CNBC's FX close of the same day
//     (EUR= and GBP= USD per unit, CHF= CHF per USD) — DERIVED; and the fund's justETF reference line (TER, distribution
//     policy) where it has been read. One instrument a request, so that each runs in its own Worker invocation.
// The backtest, risk, stress tests, comparison and projection are computed in the page (qmath.js). Never a value made
// up: a day without a close or an FX rate is left out; an instrument younger than the period starts at its first close.
import { iso } from "./lib.mjs";
import { cnbcDaily } from "./cnbc.mjs";
import { loadCnbcRaw, cnbcForeignFallback } from "./intl.mjs";
import { isinValid } from "./isin.mjs";
import { factorTarget, uniMaps, valuesOn, usdPer } from "./factors.mjs";
import { refFromLine, TABLE_COLS } from "./etfref.mjs";

export const PLAB_DAYS = 5480; // 15 years of daily bars
const getJ = async (env, k) => { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : null; } catch { return null; } };
// one fund's line out of the justETF table without splitting the whole table
export function tableLineOf(table, isin) {
  const t = String(table || ""), key = isin + "\t", i = t.startsWith(key) ? 0 : t.indexOf("\n" + key);
  if (i < 0) return null; const s = i === 0 ? 0 : i + 1, e = t.indexOf("\n", s), f = t.slice(s, e < 0 ? undefined : e).split("\t");
  return f.length >= TABLE_COLS.length ? f : null;
}
// daily closes [[date, close]] in the listing's currency → EUR, the FX close on or before each date
export function toEur(rows, ccy, pence, fx) {
  const unit = pence ? 100 : 1, dates = rows.map((r) => r[0]);
  if (ccy === "EUR") return rows.map(([d, v]) => [d, v / unit]).filter((x) => x[1] > 0);
  const eur = valuesOn(fx["EUR="] || [], dates), other = ccy === "GBP" ? valuesOn(fx["GBP="] || [], dates) : ccy === "CHF" ? valuesOn(fx["CHF="] || [], dates) : null, out = [];
  rows.forEach(([d, v], i) => {
    const k = { "EUR=": eur[i] }; if (other) k[ccy === "GBP" ? "GBP=" : "CHF="] = other[i];
    const a = usdPer(ccy, k), b = usdPer("EUR", k);
    if (a > 0 && b > 0 && v > 0) out.push([d, (v / unit) * a / b]);
  });
  return out;
}
const sig = (v) => Number(v.toPrecision(7));

export async function handlePlab(url, env, ctx, H, json, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (url.pathname !== "/api/plab/series") return send({ error: "not found" }, 404);
  if (!env.BRIEFS) return send({ error: "not_configured", status: "N/A" }, 503);
  const id = String(url.searchParams.get("id") || "").trim().toUpperCase(), now = deps.now || Date.now();
  if (!/^[A-Z0-9][A-Z0-9.\-:]{0,23}$/.test(id)) return send({ error: "bad_request", message: "id: an ISIN, a C:code, SYMBOL:MIC or a U.S. symbol" }, 400);
  const uni = isinValid(id) || /-DE$|:XETR$/.test(id) ? uniMaps(await getJ(env, "etf/universe")) : {};
  const t = factorTarget(id, uni);
  if (t.error) return send({ id, error: t.error, status: "N/A" }, 404);
  // the listing's currency and name: CNBC's quote (a venue code CNBC answers from the U.S. is not this listing)
  const q = await (deps.loadQuotes || loadCnbcRaw)([t.cnbc]), r = q.data && q.data[t.cnbc];
  if (r && cnbcForeignFallback(r)) return send({ id, error: "not_carried", status: "N/A" }, 404);
  if (!t.ccy) { const c = r && r.currencyCode ? String(r.currencyCode) : null; if (!c) return send({ id, error: r ? "no_currency" : "no_quote", status: "N/A" }, 502); t.pence = c === "GBp" || c === "GBX"; t.ccy = t.pence ? "GBP" : c; }
  if (!usdPer(t.ccy, { "EUR=": 1, "GBP=": 1, "CHF=": 1 })) return send({ id, error: "fx_unavailable", status: "N/A", ccy: t.ccy }, 502);
  if (!t.name && r && r.name) t.name = String(r.name);
  const daily = deps.daily || ((code) => cnbcDaily(url.origin, ctx, code, PLAB_DAYS, now));
  const need = t.ccy === "EUR" ? [] : ["EUR="].concat(t.ccy === "GBP" ? ["GBP="] : t.ccy === "CHF" ? ["CHF="] : []);
  const [b, ...fxr] = await Promise.all([daily(t.cnbc), ...need.map((c) => daily(c))]);
  if (!b || !b.data || !b.data.length) return send({ id, error: (b && b.err) || "no_data", status: "N/A" }, 502);
  const fx = {}; need.forEach((c, i) => { if (fxr[i] && fxr[i].data) fx[c] = fxr[i].data; });
  if (need.some((c) => !fx[c])) return send({ id, error: "fx_unavailable", status: "N/A" }, 502);
  const rows = toEur(b.data, t.ccy, t.pence, fx);
  if (rows.length < 2) return send({ id, error: "no_data", status: "N/A" }, 502);
  const line = t.isin ? tableLineOf(await env.BRIEFS.get("ref/je/table"), t.isin) : null, ref = refFromLine(line);
  return send({
    id, isin: t.isin || null, name: t.name || null, cnbc: t.cnbc, venue: t.venue || null, ticker: t.ticker || null, ccy: t.ccy, pence: !!t.pence,
    conv: t.ccy !== "EUR" ? { from: t.ccy, to: "EUR", via: "CNBC FX" } : null, us: !!t.us,
    first: rows[0][0], last: rows[rows.length - 1][0], d: rows.map((x) => x[0]), v: rows.map((x) => sig(x[1])),
    status: b.cache === "STALE" || fxr.some((x) => x && x.cache === "STALE") ? "STALE" : "LIVE", source: "CNBC daily bars", fetchedAt: iso(b.fetchedAt || now),
    ref: ref ? { ter: ref.ter, distribution: ref.distribution, focus: ref.focus, day: ref.day, source: "justETF" } : null,
    basis: "CNBC daily closes of the listing, converted to EUR at CNBC's FX close of the same day where the listing is in another currency (DERIVED); price returns as CNBC adjusts its bars",
  });
}
