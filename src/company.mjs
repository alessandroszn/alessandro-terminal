// COMPANY DESCRIPTION and OPTIONS (T07)
//   GET /api/des?symbol=AAPL                      SEC EDGAR profile: name, industry (SIC), exchange, state, fiscal year end,
//                                                 address, phone, website, latest filings
//   GET /api/des/fact?symbol=AAPL&c=revenue       one XBRL fact from the company's own filings (10-K / 10-Q), as reported
//                                                 (one request per fact: each SEC concept file is parsed on its own — CPU budget)
//   GET /api/options/expirations?symbol=AAPL      Alpaca: listed option expirations (≤ 120 days) with contract counts
//   GET /api/options/chain?symbol=AAPL&exp=…      Alpaca indicative feed (free): bid/ask/last, implied volatility, greeks,
//                                                 open interest per strike, calls and puts, strikes around the spot price
// SEC data is U.S. government data (fair-access User-Agent with contact). Alpaca's free options feed is "indicative"
// (derived from OPRA, delayed) — labelled as such. Values derived here (market cap, P/E) are marked DERIVED by the page.
import { fetchText, cachedSource, iso, easternDate } from "./lib.mjs";
import { getSecMap, secHeadersFor } from "./news.mjs";
import { alpacaConfigured, alpacaLatestTrades } from "./spx.mjs";

const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const cik10 = (c) => String(c).padStart(10, "0");
const pj = (f) => { if (f.err) return { err: f.err }; try { return { j: JSON.parse(f.text) }; } catch { return { err: "provider_error" }; } };

// ---------- SEC profile ----------
export function normalizeProfile(j) {
  if (!j || !j.name) return null;
  const a = (j.addresses && (j.addresses.business || j.addresses.mailing)) || {};
  const r = j.filings && j.filings.recent, filings = [];
  if (r && Array.isArray(r.form)) for (let i = 0; i < r.form.length && filings.length < 6; i++) if (["10-K", "10-Q", "8-K", "20-F", "6-K", "DEF 14A"].includes(r.form[i]))
    filings.push({ form: r.form[i], date: r.filingDate[i], url: `https://www.sec.gov/Archives/edgar/data/${Number(j.cik)}/${String(r.accessionNumber[i]).replace(/-/g, "")}/${r.primaryDocument[i] || ""}` });
  return {
    name: j.name, cik: Number(j.cik), tickers: j.tickers || [], exchanges: j.exchanges || [], sic: j.sic || null, industry: j.sicDescription || null,
    category: j.category || null, stateOfIncorporation: j.stateOfIncorporationDescription || j.stateOfIncorporation || null, fiscalYearEnd: j.fiscalYearEnd || null,
    address: [a.street1, a.street2, a.city, a.stateOrCountryDescription || a.stateOrCountry, a.zipCode].filter(Boolean).join(", ") || null,
    phone: j.phone || null, website: j.website || null, ein: j.ein || null, formerNames: (j.formerNames || []).slice(0, 3).map((x) => x.name), filings,
  };
}
async function secCompany(url, env, ctx, sym) {
  const map = await getSecMap(url.origin, env, ctx);
  if (map.err) return { err: map.err };
  const c = map.data[sym] || map.data[sym.replace(".", "-")];
  return c ? { cik: c.cik, name: c.name } : { err: "not_sec_registrant" };
}
// facts: companies tag the same item with different concepts over time (Apple's revenue moved from Revenues to
// RevenueFromContractWithCustomer… in 2018), so every listed concept is read and the most recently reported wins
export const FACTS = {
  revenue: { label: "Revenue", unit: "USD", concepts: [["us-gaap", "Revenues"], ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"], ["us-gaap", "SalesRevenueNet"]] },
  netIncome: { label: "Net income", unit: "USD", concepts: [["us-gaap", "NetIncomeLoss"]] },
  eps: { label: "EPS (diluted)", unit: "USD/shares", concepts: [["us-gaap", "EarningsPerShareDiluted"]] },
  assets: { label: "Total assets", unit: "USD", concepts: [["us-gaap", "Assets"]] },
  equity: { label: "Shareholders' equity", unit: "USD", concepts: [["us-gaap", "StockholdersEquity"]] },
  shares: { label: "Shares outstanding", unit: "shares", concepts: [["dei", "EntityCommonStockSharesOutstanding"]] },
};
const DAY = 86400000;
// latest annual (10-K, full fiscal year), the year before, latest single quarter, and for flows the trailing twelve
// months = latest year-to-date + last fiscal year − the same year-to-date a year earlier (DERIVED from the filings)
export function pickFact(j, unit) {
  const list = j && j.units && j.units[unit] ? j.units[unit] : null;
  if (!list) return null;
  const ok = list.filter((x) => Number.isFinite(x.val) && x.end && x.form);
  const newest = (a, b) => (a.end === b.end ? (a.filed < b.filed ? 1 : -1) : a.end < b.end ? 1 : -1);
  const by = (pred) => ok.filter(pred).sort(newest)[0] || null;
  const dur = (x) => (x.start ? (Date.parse(x.end) - Date.parse(x.start)) / DAY : null);
  const annual = by((x) => /^(10-K|20-F)/.test(x.form) && (x.fp === "FY" || x.fp == null) && (dur(x) == null || dur(x) > 330));
  const quarter = by((x) => /^10-Q/.test(x.form) && (dur(x) == null || dur(x) < 100));
  const latest = by(() => true);
  const pack = (x) => (x ? { value: x.val, end: x.end, form: x.form, filed: x.filed, fy: x.fy || null, fp: x.fp || null } : null);
  const prevAnnual = annual ? by((x) => /^(10-K|20-F)/.test(x.form) && x.end < annual.end && (dur(x) == null || dur(x) > 330) && Number(annual.end.slice(0, 4)) - Number(x.end.slice(0, 4)) === 1) : null;
  let ttm = null;
  if (annual && dur(annual) != null) {
    if (!quarter || quarter.end <= annual.end) ttm = { value: annual.val, end: annual.end, basis: "last fiscal year" };
    else {
      const ytd = ok.filter((x) => /^10-Q/.test(x.form) && x.end === quarter.end && x.start && dur(x) < 300).sort((a, b) => dur(b) - dur(a) || (a.filed < b.filed ? 1 : -1))[0];
      const target = ytd ? Date.parse(ytd.end) - 364 * DAY : null;
      const prior = ytd ? ok.filter((x) => x.start && Math.abs(Date.parse(x.end) - target) <= 8 * DAY && Math.abs(dur(x) - dur(ytd)) <= 8).sort((a, b) => (a.filed < b.filed ? 1 : -1))[0] : null;
      if (ytd && prior && annual.end > prior.end && annual.end < ytd.end) ttm = { value: ytd.val + annual.val - prior.val, end: ytd.end, basis: "year-to-date + last fiscal year − year-to-date a year earlier" };
    }
  }
  // several different values for the same instant and filing (e.g. one per share class): no single figure to use
  const latestMulti = latest ? new Set(ok.filter((x) => x.end === latest.end && x.filed === latest.filed && x.form === latest.form && (x.start || null) === (latest.start || null)).map((x) => x.val)).size > 1 : false;
  return { annual: pack(annual), prevAnnual: pack(prevAnnual), quarter: pack(quarter), latest: pack(latest), ttm, latestMulti };
}
export async function handleDes(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const sym = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYM_RE.test(sym)) return send({ error: "bad_request", message: "a U.S. ticker (SEC registrants only)" }, 400);
  const c = await secCompany(url, env, ctx, sym);
  if (c.err) return send({ error: c.err, status: "N/A", ...(c.err === "not_sec_registrant" ? { message: "not an SEC registrant: description and fundamentals N/A" } : {}) }, c.err === "not_sec_registrant" ? 404 : 502);
  if (url.pathname.endsWith("/fact")) {
    const id = url.searchParams.get("c") || "", F = FACTS[id];
    if (!F) return send({ error: "bad_request", message: `c must be one of ${Object.keys(FACTS).join(",")}` }, 400);
    const r = await cachedSource({ origin: url.origin, key: `des/fact/${c.cik}/${id}`, ttlMs: 24 * 3600_000, staleMaxMs: 30 * 86400_000, ctx, failTtlMs: 30 * 60_000,
      load: async () => {
        const res = await Promise.all(F.concepts.map(([tax, concept]) => fetchText(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10(c.cik)}/${tax}/${concept}.json`, { timeoutMs: 12000, headers: secHeadersFor(env) }).then((f) => ({ tax, concept, p: pj(f) }))));
        let best = null, err = null;
        for (const { tax, concept, p } of res) {
          if (p.err) { if (p.err !== "no_data") err = err || p.err; continue; } // no_data: the company does not use this concept
          const v = pickFact(p.j, F.unit);
          const end = v && (v.annual || v.latest) ? (v.annual || v.latest).end : null;
          if (end && (!best || end > best.end)) best = { end, data: { ...v, concept: `${tax}:${concept}` } };
        }
        return best ? { data: best.data } : { err: err || "no_data" };
      } });
    return send(r.data ? { symbol: sym, fact: id, label: F.label, unit: F.unit, ...r.data, source: "SEC EDGAR XBRL (company filings)", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" } : { symbol: sym, fact: id, label: F.label, error: r.err, status: "N/A" });
  }
  const r = await cachedSource({ origin: url.origin, key: `des/profile/${c.cik}`, ttlMs: 24 * 3600_000, staleMaxMs: 30 * 86400_000, ctx, failTtlMs: 30 * 60_000,
    load: async () => { const p = pj(await fetchText(`https://data.sec.gov/submissions/CIK${cik10(c.cik)}.json`, { timeoutMs: 12000, headers: secHeadersFor(env) })); if (p.err) return p; const n = normalizeProfile(p.j); return n ? { data: n } : { err: "no_data" }; } });
  if (!r.data) return send({ error: r.err, status: "N/A" }, 502);
  return send({ symbol: sym, profile: r.data, facts: Object.entries(FACTS).map(([id, f]) => ({ id, label: f.label })), source: "SEC EDGAR (company submissions)", sourceUrl: `https://www.sec.gov/edgar/browse/?CIK=${c.cik}`, fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" });
}

// ---------- options (Alpaca) ----------
// strikes requested around the underlying price, in percent: expirations list ±10%, chain ±15%
const BAND_EXP = 10, BAND_CHAIN = 15;
const ALP_TRADE = "https://paper-api.alpaca.markets/v2/options/contracts", ALP_SNAP = "https://data.alpaca.markets/v1beta1/options/snapshots";
const alpH = (env) => ({ "APCA-API-KEY-ID": env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY, accept: "application/json" });
const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
// OCC symbol: ROOT + YYMMDD + C/P + strike × 1000 (8 digits)
export function parseOcc(s) { const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(s || "")); return m ? { root: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === "C" ? "call" : "put", strike: Number(m[6]) / 1000 } : null; }
async function spotOf(env, sym) { const t = await alpacaLatestTrades(env, [sym]); return t.data && t.data[sym] ? { price: t.data[sym][0], time: t.data[sym][1] } : null; }
async function contracts(env, sym, q) {
  const out = []; let token = null, pages = 0;
  do {
    const qs = new URLSearchParams({ underlying_symbols: sym, status: "active", limit: "10000", ...q }); if (token) qs.set("page_token", token);
    const f = await fetchText(`${ALP_TRADE}?${qs}`, { timeoutMs: 12000, headers: alpH(env) });
    if (f.err) return { err: f.http === 401 || f.http === 403 ? "provider_auth" : f.err };
    let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
    for (const c of j.option_contracts || []) out.push({ symbol: c.symbol, exp: c.expiration_date, type: c.type, strike: Number(c.strike_price), oi: c.open_interest != null ? Number(c.open_interest) : null, oiDate: c.open_interest_date || null });
    token = j.next_page_token || null;
  } while (token && ++pages < 4);
  return { data: out };
}
export async function handleOptions(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const sym = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYM_RE.test(sym)) return send({ error: "bad_request", message: "a U.S. ticker" }, 400);
  if (!alpacaConfigured(env)) return send({ error: "alpaca_not_configured", status: "N/A" }, 503);
  const today = easternDate(new Date());
  const spot = await cachedSource({ origin: url.origin, key: `opt/spot/${sym}`, ttlMs: 60_000, staleMaxMs: 3 * 86400_000, ctx, load: async () => { const s = await spotOf(env, sym); return s ? { data: s } : { err: "no_data" }; } });
  if (!spot.data) return send({ error: spot.err === "no_data" ? "no_underlying_price" : spot.err, status: "N/A" }, 502);
  const S = spot.data.price;
  if (url.pathname.endsWith("/expirations")) {
    const r = await cachedSource({ origin: url.origin, key: `opt/exp/${sym}/${today}`, ttlMs: 3600_000, staleMaxMs: 86400_000, ctx, failTtlMs: 5 * 60_000,
      load: async () => { const c = await contracts(env, sym, { expiration_date_gte: today, expiration_date_lte: addDays(today, 120), strike_price_gte: String(Math.floor(S * (100 - BAND_EXP) / 100)), strike_price_lte: String(Math.ceil(S * (100 + BAND_EXP) / 100)) }); if (c.err) return c; const by = {}; for (const x of c.data) by[x.exp] = (by[x.exp] || 0) + 1; const exps = Object.entries(by).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([exp, n]) => ({ exp, contractsNearSpot: n })); return exps.length ? { data: exps } : { err: "no_data" }; } });
    return send(r.data ? { symbol: sym, spot: spot.data, expirations: r.data, source: "Alpaca options contracts", status: "LIVE" } : { symbol: sym, error: r.err === "no_data" ? "no_listed_options" : r.err, status: "N/A" }, r.data ? 200 : r.err === "no_data" ? 404 : 502);
  }
  if (!url.pathname.endsWith("/chain")) return send({ error: "not found" }, 404);
  const exp = url.searchParams.get("exp") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return send({ error: "bad_request", message: "exp=YYYY-MM-DD" }, 400);
  const lo = String(Math.floor(S * (100 - BAND_CHAIN) / 100)), hi = String(Math.ceil(S * (100 + BAND_CHAIN) / 100));
  const r = await cachedSource({ origin: url.origin, key: `opt/chain/${sym}/${exp}`, ttlMs: 5 * 60_000, staleMaxMs: 86400_000, ctx, failTtlMs: 2 * 60_000,
    load: async () => {
      const qs = new URLSearchParams({ feed: "indicative", expiration_date: exp, strike_price_gte: lo, strike_price_lte: hi, limit: "1000" });
      const [f, oi] = await Promise.all([fetchText(`${ALP_SNAP}/${encodeURIComponent(sym)}?${qs}`, { timeoutMs: 12000, headers: alpH(env) }), contracts(env, sym, { expiration_date: exp, strike_price_gte: lo, strike_price_lte: hi })]);
      if (f.err) return { err: f.http === 401 || f.http === 403 ? "provider_auth" : f.err };
      let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
      const oiBy = Object.fromEntries((oi.data || []).map((c) => [c.symbol, c]));
      const rows = {};
      for (const [occ, s] of Object.entries(j.snapshots || {})) {
        const o = parseOcc(occ); if (!o) continue;
        const row = rows[o.strike] || (rows[o.strike] = { strike: o.strike });
        const q = s.latestQuote || {}, t = s.latestTrade || {}, g = s.greeks || {};
        row[o.type] = { symbol: occ, bid: q.bp ?? null, ask: q.ap ?? null, quoteTime: q.t || null, last: t.p ?? null, tradeTime: t.t || null, iv: s.impliedVolatility ?? null, delta: g.delta ?? null, gamma: g.gamma ?? null, theta: g.theta ?? null, vega: g.vega ?? null, oi: oiBy[occ] ? oiBy[occ].oi : null, oiDate: oiBy[occ] ? oiBy[occ].oiDate : null };
      }
      const list = Object.values(rows).sort((a, b) => a.strike - b.strike);
      return list.length ? { data: list } : { err: "no_data" };
    } });
  return send(r.data ? { symbol: sym, exp, spot: spot.data, rows: r.data, feed: "Alpaca indicative options feed (free; derived from OPRA, delayed) — not the consolidated quote", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" } : { symbol: sym, exp, error: r.err, status: "N/A" }, r.data ? 200 : 502);
}
