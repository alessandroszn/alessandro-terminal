// Alessandro Terminal — data proxy (Cloudflare Worker)
// GET /api/health, GET /api/quote?symbols=AAPL,MSFT (T01/T02),
// GET /api/history?symbol=AAPL&range=6M (T03)
// The Twelve Data API key lives ONLY here (as a secret), never in the client.
//   Deploy:  wrangler deploy
//   Secret:  wrangler secret put TWELVEDATA_KEY
//   (optional) set ALLOWED_ORIGIN to your Pages URL instead of "*"

const TD_BASE = "https://api.twelvedata.com";

// --- pure normalizer: Twelve Data /quote -> our Quote schema (unit-tested) ---
export function normalizeQuote(sym, q) {
  if (!q || q.status === "error" || q.close == null) return null;
  const price = Number(q.close);
  const prev = q.previous_close != null ? Number(q.previous_close) : null;
  const pct = q.percent_change != null
    ? Number(q.percent_change)
    : (prev ? (price / prev - 1) * 100 : null);
  let asOf;
  try {
    asOf = q.timestamp ? new Date(q.timestamp * 1000).toISOString()
         : q.datetime  ? new Date(q.datetime).toISOString()
         : new Date().toISOString();
  } catch { asOf = new Date().toISOString(); }
  return {
    symbol: sym,
    name: q.name ?? null,
    price,
    prevClose: Number.isFinite(prev) ? prev : null,
    changePct: pct != null && Number.isFinite(pct) ? pct : null,
    open: q.open != null ? Number(q.open) : null,
    high: q.high != null ? Number(q.high) : null,
    low:  q.low  != null ? Number(q.low)  : null,
    volume: q.volume != null ? Number(q.volume) : null,
    currency: q.currency ?? "USD",
    fiftyTwoWeekLow:  q.fifty_two_week ? Number(q.fifty_two_week.low)  : null,
    fiftyTwoWeekHigh: q.fifty_two_week ? Number(q.fifty_two_week.high) : null,
    asOf,
    provider: "twelvedata",
  };
}

// ======================= T03 — historical market data =======================
// GET /api/history?symbol=AAPL&range=6M[&interval=1day][&adjust=splits]
// Daily points carry the EXCHANGE-LOCAL trading date ("YYYY-MM-DD"): Twelve Data
// ignores `timezone` for daily+ intervals, so we never invent a UTC instant for them.
// Intraday points are requested in UTC and returned as ISO instants ("...Z").

export const HISTORY_RANGES = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y"];
const RANGE_MONTHS = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "5Y": 60 };
const DEFAULT_INTERVAL = { "1D": "5min", "1W": "1day", "1M": "1day", "3M": "1day", "6M": "1day", "1Y": "1day", "5Y": "1week" };
const INTRADAY = new Set(["5min", "15min", "1h"]);
const BARS_PER_SESSION = { "5min": 78, "15min": 26, "1h": 7 };
const ADJUST = new Set(["splits", "all", "none"]);
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-:\/^]{0,19}$/;

export class BadRequest extends Error {}

function isoDate(d) { return d.toISOString().slice(0, 10); }

export function buildHistoryQuery(params, now = new Date()) {
  const symbol = String(params.symbol || "").trim().toUpperCase();
  if (!symbol) throw new BadRequest("symbol is required");
  if (!SYMBOL_RE.test(symbol)) throw new BadRequest("invalid symbol");
  const range = String(params.range || "6M").toUpperCase();
  if (!HISTORY_RANGES.includes(range)) throw new BadRequest(`range must be one of ${HISTORY_RANGES.join(",")}`);
  const interval = params.interval ? String(params.interval) : DEFAULT_INTERVAL[range];
  const intraday = INTRADAY.has(interval);
  if (!intraday && !["1day", "1week"].includes(interval)) throw new BadRequest("interval must be one of 5min,15min,1h,1day,1week");
  if (intraday && !["1D", "1W"].includes(range)) throw new BadRequest("intraday intervals are only allowed for range 1D or 1W");
  if (!intraday && range === "1D") throw new BadRequest("range 1D requires an intraday interval");
  const adjust = String(params.adjust || "splits");
  if (!ADJUST.has(adjust)) throw new BadRequest("adjust must be one of splits,all,none");

  const q = { symbol, interval, order: "asc", adjust };
  if (intraday) {
    q.timezone = "UTC";
    q.outputsize = String(BARS_PER_SESSION[interval] * (range === "1W" ? 5 : 1));
  } else {
    const start = new Date(now);
    if (range === "1W") start.setUTCDate(start.getUTCDate() - 7);
    else start.setUTCMonth(start.getUTCMonth() - RANGE_MONTHS[range]);
    q.start_date = isoDate(start);
    q.outputsize = "5000";
  }
  const ttl = intraday ? 120 : interval === "1week" ? 3600 : 900;
  return { q, range, interval, adjust, intraday, ttl };
}

function toIsoUtc(s) {
  // "2026-10-06 15:55:00" (requested in UTC) -> "2026-10-06T15:55:00Z"
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(String(s));
  return m ? `${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}Z` : null;
}
const num = v => (v == null || v === "" ? null : Number(v));

export function normalizeHistory(td, { intraday }) {
  const values = Array.isArray(td && td.values) ? td.values : [];
  const seen = new Set();
  const points = [];
  for (const v of values) {
    const t = intraday ? toIsoUtc(v.datetime) : (/^\d{4}-\d{2}-\d{2}$/.test(v.datetime) ? v.datetime : null);
    const c = num(v.close);
    if (!t || !Number.isFinite(c) || seen.has(t)) continue;
    seen.add(t);
    points.push({ t, o: num(v.open), h: num(v.high), l: num(v.low), c, v: num(v.volume) });
  }
  points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const meta = (td && td.meta) || {};
  return {
    currency: meta.currency ?? null,
    exchange: meta.exchange ?? null,
    exchangeTimezone: meta.exchange_timezone ?? null,
    type: meta.type ?? null,
    points,
  };
}

export function mapProviderError(td) {
  const code = Number(td && td.code);
  const msg = String((td && td.message) || "");
  if (code === 404 || (code === 400 && /symbol|not found|invalid/i.test(msg))) return { status: 404, error: "symbol_not_found" };
  if (code === 429) return { status: 429, error: "rate_limited" };
  if (code === 401 || code === 403) return { status: 502, error: "provider_auth" };
  return { status: 502, error: "provider_error" };
}

async function handleHistory(url, env, ctx, H) {
  let built;
  try {
    built = buildHistoryQuery(Object.fromEntries(url.searchParams));
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: "bad_request", message: e.message }, H, 400);
    throw e;
  }
  const key = env.TWELVEDATA_KEY;
  if (!key) return json({ error: "server not configured (TWELVEDATA_KEY missing)" }, H, 500);

  const { q, range, interval, adjust, intraday, ttl } = built;
  const keyParams = new URLSearchParams({ symbol: q.symbol, range, interval, adjust, d: q.start_date || "intraday" });
  const cacheKey = new Request(`${url.origin}/__cache/history?${keyParams}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-cache", "HIT");
      return r;
    }
  }

  const tdUrl = `${TD_BASE}/time_series?${new URLSearchParams(q)}&apikey=${key}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let td;
  try {
    const r = await fetch(tdUrl, { signal: ac.signal });
    td = await r.json();
  } catch (e) {
    return json({ error: ac.signal.aborted ? "provider_timeout" : "provider_unreachable" }, H, ac.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
  if (!td || td.status === "error") {
    const m = mapProviderError(td);
    return json({ error: m.error, symbol: q.symbol }, H, m.status);
  }
  const n = normalizeHistory(td, { intraday });
  if (!n.points.length) return json({ error: "no_data", symbol: q.symbol }, H, 404);

  const body = {
    symbol: q.symbol, range, interval, adjust,
    timeBasis: intraday ? "utc" : "exchange_local_date",
    currency: n.currency, exchange: n.exchange, exchangeTimezone: n.exchangeTimezone, type: n.type,
    count: n.points.length,
    points: n.points,
    asOf: new Date().toISOString(),
    provider: "twelvedata",
  };
  const resp = json(body, H, 200, ttl);
  resp.headers.set("x-cache", "MISS");
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}
function json(obj, headers, status = 200, cacheSec = 0) {
  const h = { ...headers, "content-type": "application/json" };
  if (cacheSec) h["cache-control"] = `public, max-age=${cacheSec}`;
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const H = cors(env);
    if (req.method === "OPTIONS") return new Response(null, { headers: H });

    if (url.pathname === "/api/health") {
      return json({ ok: true, ts: Date.now() }, H);
    }

    if (url.pathname === "/api/history") {
      return handleHistory(url, env, ctx, H);
    }

    if (url.pathname === "/api/quote") {
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
      if (!symbols.length) return json({ error: "no symbols" }, H, 400);
      const key = env.TWELVEDATA_KEY;
      if (!key) return json({ error: "server not configured (TWELVEDATA_KEY missing)" }, H, 500);

      const quotes = {};
      let stale = false;
      for (const s of symbols) {
        try {
          const r = await fetch(`${TD_BASE}/quote?symbol=${encodeURIComponent(s)}&apikey=${key}`);
          const q = await r.json();
          const n = normalizeQuote(s, q);
          if (n) quotes[s] = n; else stale = true;
        } catch { stale = true; }
      }
      // 45s edge cache; on provider trouble, response still returns what we have (stale flag)
      return json({ quotes, asOf: new Date().toISOString(), provider: "twelvedata", stale }, H, 200, 45);
    }

    return json({ error: "not found" }, H, 404);
  },
};
