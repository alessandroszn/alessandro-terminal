// SECURITY FUNCTIONS (23 Oct 2026, as on Nico's terminal; no new provider: SEC EDGAR and Finnhub are already used)
//   GET /api/fa?symbol=AAPL                  FA: the company (SEC registrant) and the statement lines this terminal reads
//   GET /api/fa?symbol=AAPL&c=revenue        FA: one line of the financial statements from the company's own filings (SEC
//                                            EDGAR XBRL companyconcept): its last five fiscal years as reported in the
//                                            10-K / 20-F filings and, after them, the trailing twelve months (flows, DERIVED
//                                            from the 10-Qs) or the latest quarter-end (balance sheet). One request per
//                                            line: each SEC concept file is parsed on its own (CPU budget of the free plan).
//   GET /api/cn?symbol=AAPL                  CN: company news, last 7 days (Finnhub company-news): time, headline, source,
//                                            link — the publishers' summaries are not copied
//   GET /api/earnings/symbol?symbol=AAPL     ERN for one company: the next report (Finnhub earnings calendar) and the
//                                            last reported quarters with estimate, actual and surprise (Finnhub), with
//                                            the price reaction of the session after each report when Alpaca is set
// Nothing is estimated here: a line a company does not report is N/A; a value is the filing's own figure.
import { fetchText, cachedSource, iso, easternDate } from "./lib.mjs";
import { getSecMap, secHeadersFor } from "./news.mjs";
import { pickFact } from "./company.mjs";
import { FINNHUB, finnhubKey, reaction } from "./earnings.mjs";
import { alpacaConfigured, alpacaDailyBars } from "./spx.mjs";

const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DAY = 86400000;
const cik10 = (c) => String(c).padStart(10, "0");
const pj = (f) => { if (f.err) return { err: f.err }; try { return { j: JSON.parse(f.text) }; } catch { return { err: "provider_error" }; } };
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const noStore = (json, H) => (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };

// ---------- FA: the statement lines (us-gaap concepts; a company may use any of those listed, the newest wins) ----------
// st: is income statement · bs balance sheet · cf cash flow; kind: flow (over the fiscal year) or stock (at its end)
export const FA_LINES = {
  revenue: { st: "is", label: "Revenue", unit: "USD", kind: "flow", concepts: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"] },
  cogs: { st: "is", label: "Cost of revenue", unit: "USD", kind: "flow", concepts: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"] },
  gross: { st: "is", label: "Gross profit", unit: "USD", kind: "flow", concepts: ["GrossProfit"] },
  rnd: { st: "is", label: "Research and development", unit: "USD", kind: "flow", concepts: ["ResearchAndDevelopmentExpense"] },
  sga: { st: "is", label: "Selling, general and administrative", unit: "USD", kind: "flow", concepts: ["SellingGeneralAndAdministrativeExpense"] },
  opInc: { st: "is", label: "Operating income", unit: "USD", kind: "flow", concepts: ["OperatingIncomeLoss"] },
  pretax: { st: "is", label: "Income before taxes", unit: "USD", kind: "flow", concepts: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"] },
  tax: { st: "is", label: "Income tax", unit: "USD", kind: "flow", concepts: ["IncomeTaxExpenseBenefit"] },
  netInc: { st: "is", label: "Net income", unit: "USD", kind: "flow", concepts: ["NetIncomeLoss"] },
  eps: { st: "is", label: "EPS (diluted)", unit: "USD/shares", kind: "flow", concepts: ["EarningsPerShareDiluted"] },
  shDil: { st: "is", label: "Diluted shares (average)", unit: "shares", kind: "flow", concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"] },
  cash: { st: "bs", label: "Cash and equivalents", unit: "USD", kind: "stock", concepts: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"] },
  curAssets: { st: "bs", label: "Current assets", unit: "USD", kind: "stock", concepts: ["AssetsCurrent"] },
  assets: { st: "bs", label: "Total assets", unit: "USD", kind: "stock", concepts: ["Assets"] },
  curLiab: { st: "bs", label: "Current liabilities", unit: "USD", kind: "stock", concepts: ["LiabilitiesCurrent"] },
  liab: { st: "bs", label: "Total liabilities", unit: "USD", kind: "stock", concepts: ["Liabilities"] },
  ltDebt: { st: "bs", label: "Long-term debt", unit: "USD", kind: "stock", concepts: ["LongTermDebtNoncurrent", "LongTermDebt"] },
  equity: { st: "bs", label: "Shareholders' equity", unit: "USD", kind: "stock", concepts: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
  cfo: { st: "cf", label: "Operating cash flow", unit: "USD", kind: "flow", concepts: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
  capex: { st: "cf", label: "Capital expenditure", unit: "USD", kind: "flow", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"] },
  cfi: { st: "cf", label: "Investing cash flow", unit: "USD", kind: "flow", concepts: ["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"] },
  cff: { st: "cf", label: "Financing cash flow", unit: "USD", kind: "flow", concepts: ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"] },
  buyback: { st: "cf", label: "Share repurchases", unit: "USD", kind: "flow", concepts: ["PaymentsForRepurchaseOfCommonStock"] },
  divPaid: { st: "cf", label: "Dividends paid", unit: "USD", kind: "flow", concepts: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"] },
};
const durD = (x) => (x.start ? (Date.parse(x.end) - Date.parse(x.start)) / DAY : null);
const doy = (d) => { const t = Date.parse(d); return Math.floor((t - Date.UTC(new Date(t).getUTCFullYear(), 0, 1)) / DAY); };
// the fiscal years in the annual filings, newest first: for each year-end the figure of the latest 10-K / 20-F that
// reports it (a restated figure replaces the first one). Flows: a full year (330–380 days, 52/53-week years included);
// stocks: an instant within a week of the company's fiscal year-end (the date of its latest annual report).
export function faAnnual(j, unit, kind, n = 5) {
  const list = j && j.units && Array.isArray(j.units[unit]) ? j.units[unit] : null;
  if (!list) return [];
  const annual = list.filter((x) => Number.isFinite(x.val) && /^\d{4}-\d{2}-\d{2}$/.test(x.end || "") && /^(10-K|20-F|40-F)/.test(x.form || ""));
  let rows;
  if (kind === "flow") rows = annual.filter((x) => { const d = durD(x); return d != null && d >= 330 && d <= 380; });
  else {
    const inst = annual.filter((x) => !x.start);
    const last = inst.reduce((a, x) => (!a || x.filed > a.filed || (x.filed === a.filed && x.end > a.end) ? x : a), null);
    if (!last) return [];
    const fy = doy(last.end), near = (d) => { const k = Math.abs(doy(d) - fy); return Math.min(k, 365 - k) <= 7; };
    rows = inst.filter((x) => near(x.end));
  }
  const by = new Map();
  for (const x of rows) { const o = by.get(x.end); if (!o || x.filed > o.filed) by.set(x.end, x); }
  return [...by.values()].sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, n).map((x) => ({ end: x.end, value: x.val, form: x.form, filed: x.filed }));
}
// after the last fiscal year: flows in dollars → the trailing twelve months (DERIVED: year-to-date + last year − the
// same year-to-date a year earlier); stocks → the latest quarter-end; per-share and share counts → nothing (a sum of
// them is not a figure)
export function faRecent(j, unit, kind, lastEnd) {
  if (!lastEnd || (kind === "flow" && unit !== "USD")) return null;
  const p = pickFact(j, unit);
  if (!p) return null;
  if (kind === "flow") return p.ttm && p.ttm.end > lastEnd ? { value: p.ttm.value, end: p.ttm.end, basis: "ttm", derived: true } : null;
  return p.latest && p.latest.end > lastEnd && !p.latestMulti ? { value: p.latest.value, end: p.latest.end, basis: "quarter", form: p.latest.form, filed: p.latest.filed } : null;
}
// several concepts for one line (companies change tags over time): the one with the newest year leads, the others fill
// the years it does not have
export function faMerge(parts, n = 5) {
  const ok = parts.filter((p) => p.years.length).sort((a, b) => (a.years[0].end < b.years[0].end ? 1 : -1));
  if (!ok.length) return null;
  // the same fiscal year in two concepts may end a few days apart (52/53-week years): within 10 days is the same year
  const lead = ok[0], years = lead.years.slice(), same = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 10 * DAY;
  for (const p of ok.slice(1)) for (const y of p.years) if (y.end < lead.years[0].end && !years.some((x) => same(x.end, y.end))) years.push({ ...y, concept: p.concept });
  years.sort((a, b) => (a.end < b.end ? 1 : -1));
  return { concept: lead.concept, years: years.slice(0, n), recent: lead.recent };
}
async function secCompany(url, env, ctx, sym) {
  const map = await getSecMap(url.origin, env, ctx);
  if (map.err) return { err: map.err };
  const c = map.data[sym] || map.data[sym.replace(".", "-")];
  return c ? { cik: c.cik, name: c.name } : { err: "not_sec_registrant" };
}
export async function handleFa(url, env, ctx, H, json) {
  const send = noStore(json, H);
  const sym = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYM_RE.test(sym)) return send({ error: "bad_request", message: "a U.S. ticker (SEC registrants only)" }, 400);
  const c = await secCompany(url, env, ctx, sym);
  if (c.err) return send({ error: c.err, status: "N/A", ...(c.err === "not_sec_registrant" ? { message: "not an SEC registrant: financial statements N/A" } : {}) }, c.err === "not_sec_registrant" ? 404 : 502);
  const id = url.searchParams.get("c");
  const sourceUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}&type=10-K`;
  if (!id) return send({ symbol: sym, name: c.name, cik: c.cik, lines: Object.entries(FA_LINES).map(([k, L]) => ({ id: k, st: L.st, label: L.label, unit: L.unit, kind: L.kind })), source: "SEC EDGAR XBRL (company filings)", sourceUrl, status: "LIVE" });
  const L = FA_LINES[id];
  if (!L) return send({ error: "bad_request", message: `c must be one of ${Object.keys(FA_LINES).join(",")}` }, 400);
  const r = await cachedSource({ origin: url.origin, key: `fa/v1/${c.cik}/${id}`, ttlMs: 24 * 3600_000, staleMaxMs: 30 * 86400_000, ctx, failTtlMs: 60_000,
    load: async () => {
      const parts = []; let err = null;
      for (const concept of L.concepts) { // one after another: SEC refuses bursts
        const p = pj(await fetchText(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10(c.cik)}/us-gaap/${concept}.json`, { timeoutMs: 12000, headers: secHeadersFor(env) }));
        if (p.err) { if (p.err !== "no_data") err = err || p.err; continue; } // no_data: the company does not use this concept
        const years = faAnnual(p.j, L.unit, L.kind);
        parts.push({ concept: `us-gaap:${concept}`, years, recent: years.length ? faRecent(p.j, L.unit, L.kind, years[0].end) : null });
      }
      const m = faMerge(parts);
      return m ? { data: m } : { err: err || "no_data" };
    } });
  const base = { symbol: sym, name: c.name, line: id, label: L.label, unit: L.unit, st: L.st, kind: L.kind, source: "SEC EDGAR XBRL (company filings)", sourceUrl };
  if (!r.data) return send({ ...base, error: r.err, status: "N/A", ...(r.err === "no_data" ? { message: "not in the company's filings (or not tagged with a standard us-gaap concept)" } : {}) }, r.err === "no_data" ? 404 : 502);
  return send({ ...base, ...r.data, fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" });
}

// ---------- CN: company news (Finnhub) ----------
export function normalizeCompanyNews(arr, n = 40) {
  const out = [], seen = new Set();
  for (const x of Array.isArray(arr) ? arr : []) {
    const t = Number(x && x.datetime), h = String((x && x.headline) || "").trim(), u = String((x && x.url) || "");
    if (!Number.isFinite(t) || t <= 0 || !h || !/^https?:\/\//.test(u)) continue;
    const k = h.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    out.push({ t: iso(t * 1000), headline: h, source: String(x.source || "").trim() || null, url: u, related: String(x.related || "").trim() || null });
  }
  return out.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, n);
}
export async function handleCompanyNews(url, env, ctx, H, json) {
  const send = noStore(json, H);
  const sym = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYM_RE.test(sym)) return send({ error: "bad_request", message: "a U.S. ticker" }, 400);
  if (!finnhubKey(env)) return send({ error: "finnhub_not_configured", status: "N/A", message: "Finnhub API key not set in the Worker (FINNHUB_KEY)" }, 503);
  const today = easternDate(new Date()), from = addDays(today, -7);
  const r = await cachedSource({ origin: url.origin, key: `cn/${sym}/${today}`, ttlMs: 15 * 60_000, staleMaxMs: 2 * 86400_000, ctx, failTtlMs: 60_000,
    load: async () => {
      const f = await fetchText(`${FINNHUB}/company-news?${new URLSearchParams({ symbol: sym, from, to: today })}`, { timeoutMs: 12000, headers: { "X-Finnhub-Token": finnhubKey(env), accept: "application/json" } });
      if (f.err) return { err: f.http === 401 ? "provider_auth" : f.err };
      let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
      return Array.isArray(j) ? { data: normalizeCompanyNews(j) } : { err: "provider_error" };
    } });
  if (!r.data) return send({ symbol: sym, error: r.err, status: "N/A" }, r.err === "rate_limited" ? 429 : 502);
  return send({ symbol: sym, from, to: today, items: r.data, count: r.data.length, source: "Finnhub company news", sourceUrl: "https://finnhub.io/docs/api/company-news", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" });
}

// ---------- ERN for one company (Finnhub) ----------
const hourOf = (h) => (h === "bmo" ? "before open" : h === "amc" ? "after close" : h === "dmh" ? "during market" : null);
// the reported quarters (Finnhub /stock/earnings) joined to the calendar's report dates (same fiscal quarter); the next
// report: the first calendar date from today
export function normalizeEarnSym(hist, cal, today) {
  const rows = (Array.isArray(cal && cal.earningsCalendar) ? cal.earningsCalendar : []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date || ""));
  const q = (e) => (e.quarter != null && e.year != null ? `Q${e.quarter} ${e.year}` : null);
  const next = rows.filter((e) => e.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
  const past = Array.isArray(hist) ? hist : [];
  const history = past.filter((x) => x && x.period).map((x) => {
    const c = rows.find((e) => e.date < today && e.quarter === x.quarter && e.year === x.year) || null;
    return { period: x.period, quarter: q(x), epsActual: num(x.actual), epsEstimate: num(x.estimate), surprise: num(x.surprise), surprisePct: num(x.surprisePercent),
      date: c ? c.date : null, hour: c ? hourOf(c.hour) : null, revenueActual: c ? num(c.revenueActual) : null, revenueEstimate: c ? num(c.revenueEstimate) : null };
  }).sort((a, b) => (a.period < b.period ? 1 : -1));
  return { next: next ? { date: next.date, hour: hourOf(next.hour), quarter: q(next), epsEstimate: num(next.epsEstimate), revenueEstimate: num(next.revenueEstimate) } : null, history };
}
export async function handleEarnSym(url, env, ctx, H, json) {
  const send = noStore(json, H);
  const sym = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYM_RE.test(sym)) return send({ error: "bad_request", message: "a U.S. ticker" }, 400);
  if (!finnhubKey(env)) return send({ error: "finnhub_not_configured", status: "N/A", message: "Finnhub API key not set in the Worker (FINNHUB_KEY)" }, 503);
  const today = easternDate(new Date());
  const r = await cachedSource({ origin: url.origin, key: `ern/sym/${sym}/${today}`, ttlMs: 6 * 3600_000, staleMaxMs: 3 * 86400_000, ctx, failTtlMs: 5 * 60_000,
    load: async () => {
      const h = { "X-Finnhub-Token": finnhubKey(env), accept: "application/json" };
      const [a, b] = await Promise.all([fetchText(`${FINNHUB}/stock/earnings?${new URLSearchParams({ symbol: sym })}`, { timeoutMs: 12000, headers: h }),
        fetchText(`${FINNHUB}/calendar/earnings?${new URLSearchParams({ symbol: sym, from: addDays(today, -400), to: addDays(today, 120) })}`, { timeoutMs: 12000, headers: h })]);
      if (a.err && b.err) return { err: a.http === 401 || b.http === 401 ? "provider_auth" : a.err };
      let hist = null, cal = null; try { hist = a.err ? null : JSON.parse(a.text); } catch {} try { cal = b.err ? null : JSON.parse(b.text); } catch {}
      if (!Array.isArray(hist) && !(cal && Array.isArray(cal.earningsCalendar))) return { err: "provider_error" };
      const d = normalizeEarnSym(hist, cal, today);
      if (!d.next && !d.history.length) return { err: "no_data" };
      // the session after each report (Alpaca consolidated closes), DERIVED
      const dated = d.history.filter((x) => x.date);
      if (dated.length && alpacaConfigured(env)) {
        const bars = await alpacaDailyBars(env, [sym], addDays(dated[dated.length - 1].date, -10), new Date(Date.now() - 16 * 60_000).toISOString());
        if (bars.data && bars.data[sym]) for (const x of dated) { const re = reaction(bars.data[sym], x.date, x.hour); if (re) x.reaction = re; }
      }
      return { data: { ...d, partial: !!(a.err || b.err) } };
    } });
  if (!r.data) return send({ symbol: sym, error: r.err, status: "N/A" }, r.err === "no_data" ? 404 : r.err === "rate_limited" ? 429 : 502);
  return send({ symbol: sym, today, ...r.data, source: "Finnhub (earnings calendar and reported quarters)", sourceUrl: "https://finnhub.io/docs/api/company-earnings", reactionBasis: "close of the first session after the report vs the close before (Alpaca consolidated) — DERIVED", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : r.data.partial ? "PARTIAL" : "LIVE" });
}
