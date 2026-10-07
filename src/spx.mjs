// S&P 500 HEAT MAP (T06) — real data only, fetched in three small pieces so no single Worker
// invocation parses more than one large response (free-plan CPU budget):
//   GET /api/spx/universe            constituents, GICS sector, weight — iShares Core S&P 500 ETF (IVV)
//                                    daily holdings file (the ETF's weights; a proxy for index weights)
//   GET /api/spx/closes?ref=recent   last consolidated (SIP) daily closes per constituent — Alpaca
//   GET /api/spx/closes?ref=1W|1M|3M|6M|YTD|1Y   consolidated close on the last session ≤ the reference date
//   GET /api/spx/live                latest trade per constituent (IEX feed, the free real-time feed) — Alpaca
// Changes (1D, 1W, …) are computed by the page from these real prices and labelled DERIVED.
// Alpaca keys are Worker secrets (ALPACA_KEY_ID, ALPACA_SECRET_KEY), sent only as request headers.
// Other heat maps use the same endpoints with ?u= (default SPX):
//   NDX     Nasdaq-100 — Invesco QQQ daily holdings (Invesco's own holdings API), prices Alpaca
//   DJI     Dow Jones Industrial Average — SPDR DIA daily holdings file (.xlsx), prices Alpaca
//   SECT    US sectors — the 11 SPDR Select Sector ETFs, prices Alpaca (ETF prices, not index levels)
//   CTRY    Countries — single-country ETFs listed in New York (iShares MSCI …), prices Alpaca
//   CRYPTO  Crypto — Alpaca crypto data (USD pairs; 24/7, days in UTC)
import { fetchText, fetchBinary, xlsxRows, cachedSource, parseCsv, iso, easternDate } from "./lib.mjs";

export const IVV_URL = "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv";
export const IVV_PAGE = "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf";
export const ALPACA = "https://data.alpaca.markets/v2/stocks";
export const REFS = ["1W", "1M", "3M", "6M", "YTD", "1Y"];
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const numC = (v) => { const x = Number(String(v ?? "").replace(/,/g, "")); return v == null || v === "" || v === "-" || !Number.isFinite(x) ? null : x; };

// ---------- iShares holdings file ----------
export function parseHoldings(text) {
  const rows = parseCsv(String(text || ""));
  let asOf = null, h = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (/^Fund Holdings as of$/i.test((r[0] || "").trim())) {
      const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec((r[1] || "").trim());
      if (m && MONTHS[m[1]]) asOf = `${m[3]}-${pad(MONTHS[m[1]])}-${pad(m[2])}`;
    }
    if ((r[0] || "").trim() === "Ticker") { h = i; break; }
  }
  if (h < 0) return { asOf, items: [] };
  const head = rows[h].map((x) => x.trim()), col = (n) => head.indexOf(n);
  const iT = col("Ticker"), iN = col("Name"), iS = col("Sector"), iA = col("Asset Class"), iW = col("Weight (%)"), iX = col("Exchange");
  const items = [], seen = new Set();
  for (const r of rows.slice(h + 1)) {
    if (r.length < head.length - 2) continue;          // footer / disclaimer lines
    if ((r[iA] || "").trim() !== "Equity") continue;    // cash, money market, index futures
    const sym = (r[iT] || "").trim().replace(/\s+/g, "."); // "BRK B" → "BRK.B"
    const weight = numC(r[iW]);
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym) || weight == null || seen.has(sym)) continue;
    seen.add(sym);
    items.push({ sym, name: (r[iN] || "").trim() || null, sector: (r[iS] || "").trim() || null, weight, exchange: iX >= 0 ? (r[iX] || "").trim() || null : null });
  }
  return { asOf, items };
}

// ---------- reference dates (US/Eastern calendar) ----------
function shiftDate(d, { days = 0, months = 0, years = 0 }) {
  const [y, m, dd] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y + years, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(dd, last));                    // 31 Mar − 1M → 28/29 Feb, not 3 Mar
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
export function refTarget(ref, today) {
  switch (ref) {
    case "1W": return shiftDate(today, { days: -7 });
    case "1M": return shiftDate(today, { months: -1 });
    case "3M": return shiftDate(today, { months: -3 });
    case "6M": return shiftDate(today, { months: -6 });
    case "YTD": return `${Number(today.slice(0, 4)) - 1}-12-31`;
    case "1Y": return shiftDate(today, { years: -1 });
    default: return null;
  }
}
// daily bars are stamped at midnight US/Eastern expressed in UTC (04:00Z / 05:00Z): the UTC date is the
// session date. (No Intl call per bar: thousands of bars must parse within the free-plan CPU budget.)
export const barDate = (t) => String(t).slice(0, 10);
function etClock(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

// ---------- Alpaca ----------
const alpacaHeaders = (env) => ({ "APCA-API-KEY-ID": env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY, accept: "application/json" });
const alpacaErr = (f) => (f.http === 401 || f.http === 403 ? "provider_auth" : f.err);

// all daily bars (consolidated SIP feed, split-adjusted) for the symbols in [start, end], following pages
export async function alpacaDailyBars(env, symbols, start, end, withDv = false) {
  const out = {};
  let token = null, pages = 0;
  do {
    const qs = new URLSearchParams({ symbols: symbols.join(","), timeframe: "1Day", start, end, adjustment: "split", feed: "sip", limit: "10000", sort: "asc" });
    if (token) qs.set("page_token", token);
    const f = await fetchText(`${ALPACA}/bars?${qs}`, { timeoutMs: 15000, headers: alpacaHeaders(env) });
    if (f.err) return { err: alpacaErr(f) };
    let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
    for (const [s, bars] of Object.entries(j.bars || {})) {
      const list = out[s] || (out[s] = []);
      for (const b of bars || []) if (b && b.t && Number.isFinite(b.c)) list.push(withDv && Number.isFinite(b.v) ? [barDate(b.t), b.c, Math.round(b.c * b.v)] : [barDate(b.t), b.c]);
    }
    token = j.next_page_token || null;
  } while (token && ++pages < 6);
  return { data: out };
}

// ---------- Alpaca crypto (24/7; daily bars in UTC days; only completed days count as closes) ----------
export const ALPACA_CRYPTO = "https://data.alpaca.markets/v1beta3/crypto/us";
export async function alpacaCryptoBars(env, symbols, start, end, now = Date.now()) {
  const qs = new URLSearchParams({ symbols: symbols.join(","), timeframe: "1Day", start: `${start}T00:00:00Z`, end, limit: "10000", sort: "asc" });
  const f = await fetchText(`${ALPACA_CRYPTO}/bars?${qs}`, { timeoutMs: 15000, headers: alpacaHeaders(env) });
  if (f.err) return { err: alpacaErr(f) };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const out = {};
  for (const [s, bars] of Object.entries(j.bars || {})) for (const b of bars || []) {
    if (!b || !b.t || !Number.isFinite(b.c) || Date.parse(b.t) + 86400_000 > now) continue; // the running day is not a close
    (out[s] = out[s] || []).push([barDate(b.t), b.c, Number.isFinite(b.v) ? Math.round(b.c * b.v) : null]);
  }
  return { data: out };
}
export async function alpacaCryptoTrades(env, symbols) {
  const f = await fetchText(`${ALPACA_CRYPTO}/latest/trades?${new URLSearchParams({ symbols: symbols.join(",") })}`, { timeoutMs: 10000, headers: alpacaHeaders(env) });
  if (f.err) return { err: alpacaErr(f) };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const out = {};
  for (const [s, t] of Object.entries(j.trades || {})) if (t && Number.isFinite(t.p) && t.t) out[s] = [t.p, new Date(t.t).toISOString()];
  return { data: out };
}
const utcDate = (now) => new Date(now).toISOString().slice(0, 10);
async function getCryptoCloses(origin, env, ctx, ref, symbols, now) {
  const today = utcDate(now), target = ref === "recent" ? today : refTarget(ref, today);
  const start = shiftDate(target, { days: ref === "recent" ? -6 : -10 });
  const r = await cachedSource({
    origin, key: `map/CRYPTO/closes/${ref}/${target}`, ttlMs: ref === "recent" ? 30 * 60_000 : 24 * 3600_000, staleMaxMs: 7 * 86400_000, ctx, failTtlMs: 2 * 60_000,
    load: async () => {
      const b = await alpacaCryptoBars(env, symbols, start, new Date(now).toISOString(), now);
      if (b.err) return b;
      const closes = {};
      for (const [s, list] of Object.entries(b.data)) { const ok = list.filter(([d]) => d <= target); if (ok.length) closes[s] = ref === "recent" ? ok.slice(-3) : ok[ok.length - 1].slice(0, 2); }
      return Object.keys(closes).length ? { data: closes } : { err: "no_data" };
    },
  });
  return { ...r, target, today };
}

// latest trade per symbol on the IEX feed (free plan); chunks keep URLs short
export async function alpacaLatestTrades(env, symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 200) chunks.push(symbols.slice(i, i + 200));
  const res = await Promise.all(chunks.map((c) => fetchText(`${ALPACA}/trades/latest?${new URLSearchParams({ symbols: c.join(","), feed: "iex" })}`, { timeoutMs: 10000, headers: alpacaHeaders(env) })));
  const out = {};
  for (const f of res) {
    if (f.err) return { err: alpacaErr(f) };
    let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
    for (const [s, t] of Object.entries(j.trades || {})) if (t && Number.isFinite(t.p) && t.t) out[s] = [t.p, new Date(t.t).toISOString()];
  }
  return { data: out };
}

// live phase: regular session (09:30–16:30 ET, Mon–Fri) and the trades are actually recent (holidays → closed)
export function livePhase(trades, now = Date.now()) {
  const { weekday, minutes } = etClock(now);
  const ages = Object.values(trades).map(([, t]) => now - Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  const median = ages.length ? ages[Math.floor(ages.length / 2)] : Infinity;
  const inSession = !["Sat", "Sun"].includes(weekday) && minutes >= 570 && minutes < 990;
  return { live: inSession && median <= 20 * 60_000, medianAgeSec: Number.isFinite(median) ? Math.round(median / 1000) : null };
}

// a daily bar dated today is final only once the session (and the 15-minute delay) is over
export function todayBarFinal(now = Date.now()) { const { weekday, minutes } = etClock(now); return ["Sat", "Sun"].includes(weekday) || minutes >= 990; }

// ---------- universes other than the S&P 500 ----------
export const QQQ_URL = "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/QQQ/holdings/fund?idType=ticker&interval=monthly&productType=ETF";
export const QQQ_PAGE = "https://www.invesco.com/qqq-etf/en/home.html";
export const DIA_URL = "https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-dia.xlsx";
export const DIA_PAGE = "https://www.ssga.com/us/en/intermediary/etfs/spdr-dow-jones-industrial-average-etf-trust-dia";
const etf = (sym, name, group, short) => ({ sym, name, sector: group, short, weight: null });
export const SECTOR_ETFS = [
  ["XLK", "Technology"], ["XLF", "Financials"], ["XLV", "Health Care"], ["XLY", "Consumer Discretionary"], ["XLP", "Consumer Staples"],
  ["XLE", "Energy"], ["XLI", "Industrials"], ["XLB", "Materials"], ["XLU", "Utilities"], ["XLRE", "Real Estate"], ["XLC", "Communication Services"],
].map(([s, n]) => etf(s, `${n} Select Sector SPDR (${s})`, "US sectors", n.toUpperCase()));
export const COUNTRY_ETFS = [
  ["Americas", [["SPY", "United States", "SPDR S&P 500"], ["EWC", "Canada"], ["EWW", "Mexico"], ["EWZ", "Brazil"], ["ECH", "Chile"]]],
  ["Europe", [["EWU", "United Kingdom"], ["EWG", "Germany"], ["EWQ", "France"], ["EWI", "Italy"], ["EWP", "Spain"], ["EWL", "Switzerland"], ["EWN", "Netherlands"], ["EWD", "Sweden"], ["EWK", "Belgium"], ["EDEN", "Denmark"], ["ENOR", "Norway"], ["EWO", "Austria"], ["EIRL", "Ireland"], ["EPOL", "Poland"], ["TUR", "Turkey"]]],
  ["Asia-Pacific", [["EWJ", "Japan"], ["MCHI", "China"], ["EWH", "Hong Kong"], ["EWT", "Taiwan"], ["EWY", "South Korea"], ["INDA", "India"], ["EWA", "Australia"], ["EWS", "Singapore"], ["EWM", "Malaysia"], ["EIDO", "Indonesia"], ["THD", "Thailand"], ["EPHE", "Philippines"], ["ENZL", "New Zealand"]]],
  ["Middle East & Africa", [["EIS", "Israel"], ["KSA", "Saudi Arabia"], ["QAT", "Qatar"], ["UAE", "United Arab Emirates"], ["EZA", "South Africa"]]],
].flatMap(([g, list]) => list.map(([s, c, issuer]) => etf(s, `${c} — ${issuer || "iShares MSCI " + c} (${s})`, g, c.toUpperCase())));
export const CRYPTO_PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "LTC", "BCH", "DOT", "UNI", "AAVE", "SHIB", "PEPE", "XTZ", "CRV", "GRT", "BAT", "SUSHI", "YFI", "TRUMP"]
  .map((c) => ({ sym: `${c}/USD`, name: `${c} / US dollar`, sector: "Crypto", short: c, weight: null }));

// Invesco holdings JSON → equities with weights (cash, futures, money market excluded)
export function parseQqq(j) {
  const list = j && Array.isArray(j.holdings) ? j.holdings : [];
  const items = [], seen = new Set();
  for (const h of list) {
    const sym = String(h.ticker || "").trim().replace(/[\s/]+/g, "."), weight = numC(h.percentageOfTotalNetAssets);
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym) || weight == null || weight <= 0 || seen.has(sym)) continue;
    if (/cash|money market|future|treasury/i.test(`${h.securityTypeName || ""} ${h.issuerName || ""}`)) continue;
    seen.add(sym);
    items.push({ sym, name: String(h.issuerName || "").trim() || null, sector: null, weight });
  }
  return { asOf: /^\d{4}-\d{2}-\d{2}$/.test(j && j.effectiveDate) ? j.effectiveDate : null, items };
}
// SPDR holdings sheet → equities with weight and sector
export function parseSpdrRows(rows) {
  let asOf = null, h = -1;
  const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  for (let i = 0; i < rows.length && h < 0; i++) {
    const line = rows[i].join(" ");
    const m = /As of (\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(line);
    if (m && MON[m[2].toUpperCase()]) asOf = `${m[3]}-${pad(MON[m[2].toUpperCase()])}-${pad(m[1])}`;
    if (rows[i].some((c) => /^Ticker$/i.test(String(c).trim())) && rows[i].some((c) => /^Weight$/i.test(String(c).trim()))) h = i;
  }
  if (h < 0) return { asOf, items: [] };
  const head = rows[h].map((x) => String(x).trim().toLowerCase()), c = (n) => head.indexOf(n);
  const iT = c("ticker"), iN = c("name"), iW = c("weight"), iS = c("sector");
  const items = [], seen = new Set();
  for (const r of rows.slice(h + 1)) {
    const sym = String(r[iT] || "").trim().replace(/\s+/g, "."), weight = numC(r[iW]);
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym) || weight == null || weight <= 0 || seen.has(sym)) continue;
    seen.add(sym);
    const sec = iS >= 0 ? String(r[iS] || "").trim() : "";
    items.push({ sym, name: String(r[iN] || "").trim() || null, sector: sec && sec !== "-" ? sec : null, weight });
  }
  return { asOf, items };
}

export const UNIVERSES = {
  SPX: { label: "S&P 500", kind: "stocks" },
  NDX: { label: "Nasdaq-100", kind: "stocks", source: "Invesco QQQ Trust — daily holdings", sourceUrl: QQQ_PAGE, weightBasis: "weight in QQQ (proxy for the Nasdaq-100 index weight)", min: 90,
    load: async () => { const f = await fetchText(QQQ_URL, { timeoutMs: 12000, headers: { accept: "application/json" } }); if (f.err) return { err: f.err }; let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; } return { data: parseQqq(j) }; } },
  DJI: { label: "Dow Jones Industrial Average", kind: "stocks", source: "SPDR Dow Jones Industrial Average ETF (DIA) — daily holdings", sourceUrl: DIA_PAGE, weightBasis: "weight in DIA (the Dow is price-weighted: weight follows the share price)", min: 28,
    load: async () => { const f = await fetchBinary(DIA_URL, { timeoutMs: 12000 }); if (f.err) return { err: f.err }; try { return { data: parseSpdrRows(await xlsxRows(f.buf)) }; } catch { return { err: "provider_error" }; } } },
  SECT: { label: "US sectors (SPDR sector ETFs)", kind: "stocks", static: SECTOR_ETFS, source: "SPDR Select Sector ETFs (fixed list)", weightBasis: "none — size: traded value or equal" },
  CTRY: { label: "Countries (single-country ETFs in New York)", kind: "stocks", static: COUNTRY_ETFS, source: "single-country ETFs listed in New York (fixed list)", weightBasis: "none — size: traded value or equal" },
  CRYPTO: { label: "Crypto (USD pairs)", kind: "crypto", static: CRYPTO_PAIRS, source: "Alpaca crypto USD pairs (fixed list)", weightBasis: "none — size: traded value or equal" },
};

// ---------- loaders (shared by the heat map endpoints and the briefing) ----------
export async function getUniverse(origin, ctx, u = "SPX") {
  const U = UNIVERSES[u];
  if (U.static) return { data: { asOf: null, items: U.static }, fetchedAt: Date.now(), cache: "STATIC" };
  if (u !== "SPX") return cachedSource({
    origin, key: `map/${u}/universe`, ttlMs: 12 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, failTtlMs: 10 * 60_000,
    load: async () => { const r = await U.load(); return r.data && r.data.items.length >= U.min ? r : { err: r.err || "provider_error" }; },
  });
  return cachedSource({
    origin, key: "spx/universe", ttlMs: 12 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, failTtlMs: 10 * 60_000,
    load: async () => {
      const f = await fetchText(IVV_URL, { timeoutMs: 15000, headers: { accept: "text/csv,text/plain,*/*" } });
      if (f.err) return { err: f.err };
      const p = parseHoldings(f.text);
      return p.items.length >= 400 ? { data: p } : { err: "provider_error" }; // a partial file is not shown as the index
    },
  });
}
export const alpacaConfigured = (env) => !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY);

// consolidated closes: ref "recent" → last ≤ 3 sessions per symbol; 1W…1Y → last close ≤ the reference date
export async function getCloses(origin, env, ctx, ref, symbols, now = Date.now(), u = "SPX") {
  if (UNIVERSES[u].kind === "crypto") return getCryptoCloses(origin, env, ctx, ref, symbols, now);
  const today = easternDate(new Date(now));
  const target = ref === "recent" ? today : refTarget(ref, today);
  const start = shiftDate(target, { days: ref === "recent" ? -14 : -10 });
  // the free plan reads consolidated data up to 15 minutes ago
  const end = ref === "recent" ? new Date(now - 16 * 60_000).toISOString() : `${target}T23:59:59Z`;
  const withDv = u !== "SPX"; // traded value (close × volume) for the "size by traded value" option
  const r = await cachedSource({
    origin, key: u === "SPX" ? `spx/closes/${ref}/${target}` : `map/${u}/closes/${ref}/${target}`, ttlMs: ref === "recent" ? 30 * 60_000 : 24 * 3600_000, staleMaxMs: 7 * 86400_000, ctx, failTtlMs: 2 * 60_000,
    load: async () => {
      const b = await alpacaDailyBars(env, symbols, start, end, withDv);
      if (b.err) return b;
      const closes = {};
      for (const [s, list] of Object.entries(b.data)) {
        const ok = list.filter(([d]) => d <= target);
        if (!ok.length) continue;
        closes[s] = ref === "recent" ? ok.slice(-3) : ok[ok.length - 1].slice(0, 2);
      }
      return Object.keys(closes).length ? { data: closes } : { err: "no_data" };
    },
  });
  return { ...r, target, today };
}
export async function getLive(origin, env, ctx, symbols, u = "SPX") {
  const crypto = UNIVERSES[u].kind === "crypto";
  return cachedSource({ origin, key: u === "SPX" ? "spx/live" : `map/${u}/live`, ttlMs: 60_000, staleMaxMs: 24 * 3600_000, ctx, failTtlMs: 30_000, load: () => (crypto ? alpacaCryptoTrades(env, symbols) : alpacaLatestTrades(env, symbols)) });
}
// crypto trades around the clock, but thin pairs can go hours without a trade: the map is live when the
// most traded quarter of the pairs traded in the last 20 minutes; each tile keeps its own last-trade time
export function cryptoPhase(trades, now = Date.now()) {
  const ages = Object.values(trades).map(([, t]) => now - Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  const q1 = ages.length ? ages[Math.floor((ages.length - 1) / 4)] : Infinity, median = ages.length ? ages[Math.floor(ages.length / 2)] : Infinity;
  return { live: q1 <= 20 * 60_000, medianAgeSec: Number.isFinite(median) ? Math.round(median / 1000) : null };
}

// ---------- handlers ----------
const NA = (json, H, error, status, extra = {}) => json({ error, status: "N/A", ...extra }, H, status);
const send = (json, H, body, cache) => { const r = json(body, H); r.headers.set("cache-control", "no-store"); r.headers.set("x-cache", cache); return r; };

export async function handleSpx(url, env, ctx, H, json) {
  const part = url.pathname.slice("/api/spx/".length);
  const uid = String(url.searchParams.get("u") || "SPX").toUpperCase(), U = UNIVERSES[uid];
  if (!U) return json({ error: "bad_request", message: `u must be one of ${Object.keys(UNIVERSES).join(",")}` }, H, 400);
  if (part === "universe") {
    const u = await getUniverse(url.origin, ctx, uid);
    const src = uid === "SPX" ? { source: "iShares Core S&P 500 ETF (IVV) — daily holdings", sourceUrl: IVV_PAGE, weightBasis: "weight in IVV (proxy for the S&P 500 index weight)" } : { source: U.source, sourceUrl: U.sourceUrl || null, weightBasis: U.weightBasis };
    if (u.err) return NA(json, H, u.err, 502, { universe: uid, ...src });
    return send(json, H, {
      universe: uid, label: U.label, kind: U.kind, ...src,
      holdingsAsOf: u.data.asOf, count: u.data.items.length, items: u.data.items,
      fetchedAt: iso(u.fetchedAt), status: u.cache === "STALE" ? "STALE" : "LIVE",
    }, u.cache);
  }
  if (part !== "closes" && part !== "live") return json({ error: "not found" }, H, 404);
  if (!alpacaConfigured(env)) return NA(json, H, "alpaca_not_configured", 503, { message: "Alpaca API keys are not set in the Worker (ALPACA_KEY_ID, ALPACA_SECRET_KEY)" });
  const u = await getUniverse(url.origin, ctx, uid);
  if (u.err) return NA(json, H, "universe_unavailable", 502);
  const symbols = u.data.items.map((x) => x.sym);
  const crypto = U.kind === "crypto";
  const now = Date.now(), today = crypto ? utcDate(now) : easternDate(new Date(now));

  if (part === "closes") {
    const ref = url.searchParams.get("ref") || "recent";
    if (ref !== "recent" && !REFS.includes(ref)) return json({ error: "bad_request", message: `ref must be recent or ${REFS.join(",")}` }, H, 400);
    const r = await getCloses(url.origin, env, ctx, ref, symbols, now, uid);
    if (r.err) return NA(json, H, r.err, r.err === "rate_limited" ? 429 : 502, { ref });
    return send(json, H, {
      universe: uid, ref, target: r.target, todayET: today, todayBarFinal: crypto ? true : todayBarFinal(now), closes: r.data, count: Object.keys(r.data).length,
      ...(crypto ? { dayBasis: "UTC day; closes are completed days only" } : {}),
      source: crypto ? "Alpaca — crypto daily bars (US venues)" : "Alpaca — consolidated (SIP) daily bars, split-adjusted", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE",
    }, r.cache);
  }

  // live
  const r = await getLive(url.origin, env, ctx, symbols, uid);
  if (r.err) return NA(json, H, r.err, r.err === "rate_limited" ? 429 : 502);
  const phase = crypto ? cryptoPhase(r.data, now) : livePhase(r.data, now);
  return send(json, H, {
    universe: uid, trades: r.data, count: Object.keys(r.data).length, live: phase.live, medianTradeAgeSec: phase.medianAgeSec, todayET: today,
    source: crypto ? "Alpaca — latest crypto trade (US venues)" : "Alpaca — latest trade, IEX feed (one venue: real prices, partial volume)", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE",
  }, r.cache);
}
