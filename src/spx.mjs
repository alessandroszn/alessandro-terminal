// S&P 500 HEAT MAP (T06) — real data only, fetched in three small pieces so no single Worker
// invocation parses more than one large response (free-plan CPU budget):
//   GET /api/spx/universe            constituents, GICS sector, weight — iShares Core S&P 500 ETF (IVV)
//                                    daily holdings file (the ETF's weights; a proxy for index weights)
//   GET /api/spx/closes?ref=recent   last consolidated (SIP) daily closes per constituent — Alpaca
//   GET /api/spx/closes?ref=1W|1M|3M|6M|YTD|1Y   consolidated close on the last session ≤ the reference date
//   GET /api/spx/live                latest trade per constituent (IEX feed, the free real-time feed) — Alpaca
// Changes (1D, 1W, …) are computed by the page from these real prices and labelled DERIVED.
// Alpaca keys are Worker secrets (ALPACA_KEY_ID, ALPACA_SECRET_KEY), sent only as request headers.
import { fetchText, cachedSource, parseCsv, iso, easternDate } from "./lib.mjs";

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
export async function alpacaDailyBars(env, symbols, start, end) {
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
      for (const b of bars || []) if (b && b.t && Number.isFinite(b.c)) list.push([barDate(b.t), b.c]);
    }
    token = j.next_page_token || null;
  } while (token && ++pages < 6);
  return { data: out };
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

// ---------- handlers ----------
async function getUniverse(origin, ctx) {
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

const notConfigured = (env) => !env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY;
const NA = (json, H, error, status, extra = {}) => json({ error, status: "N/A", ...extra }, H, status);
const send = (json, H, body, cache) => { const r = json(body, H); r.headers.set("cache-control", "no-store"); r.headers.set("x-cache", cache); return r; };

export async function handleSpx(url, env, ctx, H, json) {
  const part = url.pathname.slice("/api/spx/".length);
  if (part === "universe") {
    const u = await getUniverse(url.origin, ctx);
    if (u.err) return NA(json, H, u.err, 502, { source: "iShares IVV holdings", sourceUrl: IVV_PAGE });
    return send(json, H, {
      source: "iShares Core S&P 500 ETF (IVV) — daily holdings", sourceUrl: IVV_PAGE, weightBasis: "weight in IVV (proxy for the S&P 500 index weight)",
      holdingsAsOf: u.data.asOf, count: u.data.items.length, items: u.data.items,
      fetchedAt: iso(u.fetchedAt), status: u.cache === "STALE" ? "STALE" : "LIVE",
    }, u.cache);
  }
  if (part !== "closes" && part !== "live") return json({ error: "not found" }, H, 404);
  if (notConfigured(env)) return NA(json, H, "alpaca_not_configured", 503, { message: "Alpaca API keys are not set in the Worker (ALPACA_KEY_ID, ALPACA_SECRET_KEY)" });
  const u = await getUniverse(url.origin, ctx);
  if (u.err) return NA(json, H, "universe_unavailable", 502);
  const symbols = u.data.items.map((x) => x.sym);
  const now = Date.now(), today = easternDate(new Date(now));

  if (part === "closes") {
    const ref = url.searchParams.get("ref") || "recent";
    if (ref !== "recent" && !REFS.includes(ref)) return json({ error: "bad_request", message: `ref must be recent or ${REFS.join(",")}` }, H, 400);
    const target = ref === "recent" ? today : refTarget(ref, today);
    const start = shiftDate(target, { days: ref === "recent" ? -14 : -10 });
    // the free plan reads consolidated data up to 15 minutes ago
    const end = ref === "recent" ? new Date(now - 16 * 60_000).toISOString() : `${target}T23:59:59Z`;
    const r = await cachedSource({
      origin: url.origin, key: `spx/closes/${ref}/${target}`, ttlMs: ref === "recent" ? 30 * 60_000 : 24 * 3600_000, staleMaxMs: 7 * 86400_000, ctx, failTtlMs: 2 * 60_000,
      load: async () => {
        const b = await alpacaDailyBars(env, symbols, start, end);
        if (b.err) return b;
        const closes = {};
        for (const [s, list] of Object.entries(b.data)) {
          const ok = list.filter(([d]) => d <= target);
          if (!ok.length) continue;
          closes[s] = ref === "recent" ? ok.slice(-3) : ok[ok.length - 1];
        }
        return Object.keys(closes).length ? { data: closes } : { err: "no_data" };
      },
    });
    if (r.err) return NA(json, H, r.err, r.err === "rate_limited" ? 429 : 502, { ref });
    return send(json, H, {
      ref, target, todayET: today, todayBarFinal: todayBarFinal(now), closes: r.data, count: Object.keys(r.data).length,
      source: "Alpaca — consolidated (SIP) daily bars, split-adjusted", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE",
    }, r.cache);
  }

  // live
  const r = await cachedSource({
    origin: url.origin, key: "spx/live", ttlMs: 60_000, staleMaxMs: 24 * 3600_000, ctx, failTtlMs: 30_000,
    load: () => alpacaLatestTrades(env, symbols),
  });
  if (r.err) return NA(json, H, r.err, r.err === "rate_limited" ? 429 : 502);
  const phase = livePhase(r.data, now);
  return send(json, H, {
    trades: r.data, count: Object.keys(r.data).length, live: phase.live, medianTradeAgeSec: phase.medianAgeSec, todayET: today,
    source: "Alpaca — latest trade, IEX feed (one venue: real prices, partial volume)", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE",
  }, r.cache);
}
