// SYMBOL DISCOVERY (T05) — the provider's own symbol master, never a hand-made list.
//   GET /api/search?q=Roche  → Twelve Data /symbol_search (name or ticker, every exchange it lists,
//                              with the data plan each listing requires). Metadata only: no prices.
//   GET /api/search?q=IT0000072618 → an ISIN (check digit verified): its listings from OpenFIGI (isin.mjs), matched to
//                              Twelve Data's records of the same tickers; the home market first. No prices either.
// Quotes and history are then fetched on demand, only for the instrument the user selects.
// Instrument id: plain symbol for US listings, FX, metals and crypto ("AAPL", "EUR/USD");
// "SYMBOL:MIC" for every other listing ("NOVN:XSWX"), so quotes and history hit exactly that venue.
import { cnbcCodeFor } from "./intl.mjs";
import { fetchText, cachedSource, iso } from "./lib.mjs";
import { isinValid, openFigi, ISIN_HOME, MIC_COUNTRY, MIC_EXCHANGE } from "./isin.mjs";

const TD = "https://api.twelvedata.com";
export const PLAN_RANK = { Basic: 0, Grow: 1, Pro: 2, Ultra: 3, Enterprise: 4 };
export const CURRENT_PLAN = "Basic"; // the Twelve Data plan of TWELVEDATA_KEY
export const US_MICS = new Set(["XNGS", "XNAS", "XNCM", "XNMS", "XNYS", "ARCX", "XASE", "BATS", "IEXG", "OTCQ", "OTCM", "PINX", "XOTC", "EXPM", "PSGM"]);
const COUNTRY_RANK = ["United States", "Switzerland", "United Kingdom", "Germany", "France", "Italy", "Netherlands", "Spain", "Canada", "Japan", "Hong Kong"];
const TYPE_COST = { "Common Stock": 0, "Physical Currency": 0, "Digital Currency": 0, "Precious Metal": 0, ETF: 5, REIT: 5, "Depositary Receipt": 10, "American Depositary Receipt": 10, "Global Depositary Receipt": 10, "Preferred Stock": 20, "Mutual Fund": 25 };

const isCcy = (r) => String(r.symbol || "").includes("/") || /Currency|Metal/i.test(r.instrument_type || "");
export function instrumentId(r) {
  if (isCcy(r) || !r.mic_code || US_MICS.has(r.mic_code)) return r.symbol;
  return `${r.symbol}:${r.mic_code}`;
}
// "NOVN:XSWX" → { symbol: "NOVN", mic: "XSWX" }; "AAPL" / "EUR/USD" → { symbol, mic: null }
export function splitId(id) {
  const s = String(id), i = s.lastIndexOf(":");
  return i > 0 && !s.includes("/") ? { symbol: s.slice(0, i), mic: s.slice(i + 1) } : { symbol: s, mic: null };
}

const OTC_MICS = new Set(["OTCQ", "OTCM", "PINX", "XOTC", "EXPM", "PSGM"]);
const fold = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase(); // "Nestlé" ~ "Nestle"
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// relevance: exact ticker > name starting with the query as a word ("Roche" ≠ "Rochester") >
// listings the plan can quote > common stock > regulated exchanges before OTC > home markets
function score(r, Q) {
  const name = fold(r.instrument_name), q = reEsc(fold(Q));
  let s = 0;
  if (String(r.symbol).toUpperCase() === Q || String(r.symbol).replace("/", "") === Q.replace("/", "")) s -= 100;
  if (new RegExp(`^${q}(?![A-Z0-9])`).test(name)) s -= 40; else if (new RegExp(`(^|[^A-Z0-9])${q}(?![A-Z0-9])`).test(name)) s -= 20;
  s += TYPE_COST[r.instrument_type] ?? 40;            // warrants, certificates, structured products last
  if (OTC_MICS.has(r.mic_code)) s += 15;
  if (r.quotable) s -= 12;
  const c = COUNTRY_RANK.indexOf(r.country);
  s += isCcy(r) ? 0 : c < 0 ? 25 : (c * 3) / 2; // ranking weight, not market data
  return s;
}

// listings the plan does not include but CNBC quotes (intl.mjs: SYMBOL:MIC → CNBC code) are quotable through CNBC
export function normalizeSearch(j, q) {
  const data = Array.isArray(j && j.data) ? j.data : [];
  const Q = String(q).trim().toUpperCase();
  const rows = [];
  for (const r of data) {
    if (!r || !r.symbol) continue;
    const need = (r.access && (r.access.global || r.access.plan)) || null;
    const inPlan = need ? (PLAN_RANK[need] ?? 9) <= PLAN_RANK[CURRENT_PLAN] : null;
    const via = inPlan === false && cnbcCodeFor(instrumentId(r)) ? "CNBC" : null, quotable = via ? true : inPlan;
    rows.push({ r, quotable, via, s: score({ ...r, quotable }, Q) });
  }
  rows.sort((a, b) => a.s - b.s);
  const seen = new Set(), out = [];
  for (const { r, quotable, via } of rows) {
    const id = instrumentId(r);
    if (seen.has(id)) continue; // e.g. AAPL on Nasdaq and on IEX: one US instrument
    seen.add(id);
    out.push({
      id, symbol: r.symbol, name: r.instrument_name || null,
      exchange: isCcy(r) ? null : r.exchange || null, mic: isCcy(r) ? null : r.mic_code || null,
      country: r.country || null, currency: r.currency || null, type: r.instrument_type || null,
      timezone: r.exchange_timezone || null, planRequired: (r.access && (r.access.global || r.access.plan)) || null, quotable,
      ...(via ? { via, cnbc: cnbcCodeFor(id) } : {}),
    });
  }
  return out;
}

const ROW_KEYS = ["symbol", "instrument_name", "exchange", "mic_code", "exchange_timezone", "instrument_type", "country", "currency", "access"];
const trimRow = (r) => Object.fromEntries(ROW_KEYS.filter((k) => r && r[k] != null).map((k) => [k, r[k]]));
export const Q_RE = /^[\p{L}\p{N} .&'\-\/:]{1,40}$/u;
const tdError = (txt) => { try { const j = JSON.parse(txt); return j && j.status === "error" ? j : null; } catch { return null; } };

// Twelve Data serves symbol search without a key (no credit used). If that is refused,
// retry once with the server key (1 credit), so the client can account for it.
async function providerSearch(q, key) {
  const base = `${TD}/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=120&show_plan=true`;
  let credits = 0, err = null;
  for (const withKey of [false, true]) {
    if (withKey && !key) break;
    const f = await fetchText(base, withKey ? { headers: { authorization: `apikey ${key}` } } : {}); // key in the header, never in the URL
    if (withKey) credits = 1;
    if (f.err) { err = f.err; continue; }
    const e = tdError(f.text);
    if (e) { err = Number(e.code) === 429 ? "rate_limited" : "provider_error"; continue; }
    // the provider's rows are cached as received (trimmed to the fields used); ranking runs on every request
    try { const j = JSON.parse(f.text); const rows = (Array.isArray(j.data) ? j.data : []).map(trimRow); return { data: { rows, raw: rows.length, credits } }; } catch { err = "provider_error"; }
  }
  return { err: err || "provider_error", credits };
}

export async function handleSearch(url, env, ctx, H, json) {
  const q = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ");
  if (!Q_RE.test(q)) return json({ error: "bad_request", message: "q must be 1-40 letters, digits, spaces or . & ' - / :" }, H, 400);
  const isin = q.toUpperCase().replace(/ /g, "");
  if (isinValid(isin)) return isinSearch(url, env, ctx, H, json, isin);
  let credits = 0;
  const r = await cachedSource({
    origin: url.origin, key: `search-rows/${encodeURIComponent(q.toLowerCase())}`, ttlMs: 24 * 3600_000, staleMaxMs: 30 * 86400_000, ctx,
    load: async () => { const x = await providerSearch(q, env.TWELVEDATA_KEY); credits = x.credits || (x.data && x.data.credits) || 0; return x; },
  });
  if (r.err) return json({ q, results: [], error: r.err, status: "N/A", credits }, H, r.err === "rate_limited" ? 429 : 502);
  const results = normalizeSearch({ data: r.data.rows }, q);
  const resp = json({
    q, count: results.length, results,
    plan: CURRENT_PLAN, quotable: results.filter((x) => x.quotable).length,
    source: "Twelve Data symbol_search", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE",
    // the provider returns at most 120 listings: a broad name can be crowded out by warrants → search the ticker
    truncated: (r.data.raw || 0) >= 120, credits: r.cache === "MISS" ? credits : 0,
  }, H);
  resp.headers.set("cache-control", "no-store");
  resp.headers.set("x-cache", r.cache);
  return resp;
}

// ---------- ISIN: OpenFIGI's listings, each matched to Twelve Data's record of the same listing when it has one ----------
async function isinSearch(url, env, ctx, H, json, isin) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const f = await cachedSource({ origin: url.origin, key: `isin/${isin}`, ttlMs: 7 * 86400_000, staleMaxMs: 60 * 86400_000, ctx, failTtlMs: 10 * 60_000, load: () => openFigi(isin, env) });
  if (f.err) return send({ q: isin, isin, results: [], error: f.err, status: "N/A", source: "OpenFIGI" }, f.err === "rate_limited" ? 429 : 502);
  const L = f.data.listings, home = ISIN_HOME[isin.slice(0, 2)] || null, base = { q: isin, isin, name: f.data.name, plan: CURRENT_PLAN, fetchedAt: iso(f.fetchedAt), status: f.cache === "STALE" ? "STALE" : "LIVE" };
  if (!L.length) return send({ ...base, count: 0, results: [], quotable: 0, note: f.data.note || "no_listing", source: "OpenFIGI" });
  const countryOf = (l) => (l.mic ? MIC_COUNTRY[l.mic] || null : "United States"), rank = (l) => (countryOf(l) === home ? 0 : l.mic ? 1 : 2); // a foreign issuer's U.S. line is mostly over the counter
  // Twelve Data's own records for the tickers found (plan, currency, exchange name): at most three tickers, home market first
  const tickers = [...new Set(L.slice().sort((a, b) => rank(a) - rank(b)).map((l) => l.ticker))].slice(0, 3);
  let credits = 0;
  const td = await Promise.all(tickers.map((t) => cachedSource({ origin: url.origin, key: `search-rows/${encodeURIComponent(t.toLowerCase())}`, ttlMs: 24 * 3600_000, staleMaxMs: 30 * 86400_000, ctx,
    load: async () => { const x = await providerSearch(t, env.TWELVEDATA_KEY); credits += x.credits || (x.data && x.data.credits) || 0; return x; } })));
  const byId = new Map();
  td.forEach((r, i) => { if (r.data) for (const x of normalizeSearch({ data: r.data.rows }, tickers[i])) if (!byId.has(x.id)) byId.set(x.id, x); });
  const results = L.map((l) => {
    const t = byId.get(l.id); if (t) return { ...t, isin, figi: l.figi };
    const cn = cnbcCodeFor(l.id); // a listing Twelve Data does not list: named from OpenFIGI, quotable through CNBC when it carries it
    return { id: l.id, symbol: l.ticker, name: l.name, exchange: l.mic ? MIC_EXCHANGE[l.mic] || l.exch : "US", mic: l.mic, country: countryOf(l), currency: null, type: l.type, timezone: null,
      planRequired: null, quotable: cn ? true : null, ...(cn ? { via: "CNBC", cnbc: cn } : {}), isin, figi: l.figi, from: "OpenFIGI" };
  });
  const order = (x) => (x.country === home ? 0 : 2) + (x.quotable ? 0 : 1) + (x.mic ? 0.5 : 0);
  results.sort((a, b) => order(a) - order(b));
  return send({ ...base, count: results.length, results, quotable: results.filter((x) => x.quotable).length, source: "OpenFIGI (ISIN → listings) · Twelve Data symbol_search", credits });
}
