// SYMBOL DISCOVERY (T05) — the provider's own symbol master, never a hand-made list.
//   GET /api/search?q=Roche  → Twelve Data /symbol_search (name or ticker, every exchange it lists,
//                              with the data plan each listing requires). Metadata only: no prices.
// Quotes and history are then fetched on demand, only for the instrument the user selects.
// Instrument id: plain symbol for US listings, FX, metals and crypto ("AAPL", "EUR/USD");
// "SYMBOL:MIC" for every other listing ("NOVN:XSWX"), so quotes and history hit exactly that venue.
import { fetchText, cachedSource, iso } from "./lib.mjs";

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

export function normalizeSearch(j, q) {
  const data = Array.isArray(j && j.data) ? j.data : [];
  const Q = String(q).trim().toUpperCase();
  const rows = [];
  for (const r of data) {
    if (!r || !r.symbol) continue;
    const need = (r.access && (r.access.global || r.access.plan)) || null;
    const quotable = need ? (PLAN_RANK[need] ?? 9) <= PLAN_RANK[CURRENT_PLAN] : null;
    rows.push({ r, quotable, s: score({ ...r, quotable }, Q) });
  }
  rows.sort((a, b) => a.s - b.s);
  const seen = new Set(), out = [];
  for (const { r, quotable } of rows) {
    const id = instrumentId(r);
    if (seen.has(id)) continue; // e.g. AAPL on Nasdaq and on IEX: one US instrument
    seen.add(id);
    out.push({
      id, symbol: r.symbol, name: r.instrument_name || null,
      exchange: isCcy(r) ? null : r.exchange || null, mic: isCcy(r) ? null : r.mic_code || null,
      country: r.country || null, currency: r.currency || null, type: r.instrument_type || null,
      timezone: r.exchange_timezone || null, planRequired: (r.access && (r.access.global || r.access.plan)) || null, quotable,
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
