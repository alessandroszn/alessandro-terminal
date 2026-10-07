// Alessandro Terminal — data proxy (Cloudflare Worker)
//   GET /api/yields | /api/calendar | /api/news | /api/briefing   (T05, see src/*.mjs)
//   GET /api/search?q=Novartis              (T05 symbol discovery, see src/search.mjs)
//   GET /api/spx/universe|closes|live       (T06 S&P 500 heat map, see src/spx.mjs)
//   GET /api/health
//   GET /api/quote?symbols=AAPL,MSFT        (T01/T02, provenance + shared cache in T04;
//                                            "SYMBOL:MIC" ids such as NOVN:XSWX address one venue)
//   GET /api/history?symbol=AAPL&range=6M   (T03, provenance + stale serving in T04)
// The Twelve Data API key lives ONLY here (secret TWELVEDATA_KEY), never in the client, never in
// any URL (it is sent in the Authorization header), never logged.
// Every /api request must carry a valid Cloudflare Access token for this app (src/access.mjs).

import { handleYields } from "./yields.mjs";
import { handleCalendar } from "./calendar.mjs";
import { handleNews } from "./news.mjs";
import { handleBriefing } from "./briefing.mjs";
import { runCron } from "./cron.mjs";
import { handleExchanges } from "./exchanges.mjs";
import { handleCalendarHistory, handleCalendarReactions } from "./calendar.mjs";
import { handlePortfolio } from "./portfolio.mjs";
import { handleSearch, splitId, US_MICS } from "./search.mjs";
import { verifyAccess } from "./access.mjs";
import { handleSpx } from "./spx.mjs";
import { handleHeadlines } from "./press.mjs";
import { handleBriefs } from "./briefs.mjs";

const TD_BASE = "https://api.twelvedata.com";
const SOURCE = "twelvedata";
const PROVIDER_TIMEOUT_MS = 8000;

// ============================ provenance contract ============================
// Every number the API returns carries a status:
//   LIVE     fetched from the provider within its freshness window
//   PARTIAL  real but incomplete (e.g. venue-subset volume, not consolidated)
//   STALE    real but past its freshness window (served because the provider failed)
//   N/A      not available from the current data source — never estimated, never invented
// (DERIVED and LOADING are assigned by the client. Nothing in this API is invented or estimated.)
export const STATUS = { LIVE: "LIVE", PARTIAL: "PARTIAL", STALE: "STALE", NA: "N/A" };

// Twelve Data real-time US equities come from venues that cover ~5% of US volume;
// historical / end-of-day data is consolidated (100%). Source: Twelve Data support,
// "US equities market data".
const VENUE_NOTE = "real-time venue subset (~5% of US consolidated volume); may differ slightly from consolidated";
const NA_NOTE = "not provided by the current data plan";

// Venue notes apply to US equities only. FX, crypto, metals and non-US listings carry the
// provider's own values for that market, labelled as such (no consolidated-tape claim either way).
const PROVIDER_NOTE = "as reported by the provider for this market (see data time)";
export const QUOTE_FIELDS = {
  price:            { from: "price",            status: STATUS.LIVE,    note: "last trade (real-time venues)" },
  change:           { from: "change",           status: STATUS.LIVE },
  changePct:        { from: "changePct",        status: STATUS.LIVE },
  prevClose:        { from: "prevClose",        status: STATUS.LIVE,    note: "previous session close (consolidated)" },
  open:             { from: "open",             status: STATUS.PARTIAL, note: VENUE_NOTE },
  high:             { from: "high",             status: STATUS.PARTIAL, note: VENUE_NOTE },
  low:              { from: "low",              status: STATUS.PARTIAL, note: VENUE_NOTE },
  volume:           { from: "volume",           status: STATUS.PARTIAL, note: "venue subset only — roughly 5% of consolidated US volume" },
  fiftyTwoWeekLow:  { from: "fiftyTwoWeekLow",  status: STATUS.LIVE,    note: "from consolidated daily history" },
  fiftyTwoWeekHigh: { from: "fiftyTwoWeekHigh", status: STATUS.LIVE,    note: "from consolidated daily history" },
  marketCap:        { from: null, status: STATUS.NA, note: NA_NOTE },
  pe:               { from: null, status: STATUS.NA, note: NA_NOTE },
  eps:              { from: null, status: STATUS.NA, note: NA_NOTE },
  dividendYield:    { from: null, status: STATUS.NA, note: NA_NOTE },
  sharesOutstanding:{ from: null, status: STATUS.NA, note: NA_NOTE },
};

// Two separate clocks:
//  - cache freshness: how long the shared Worker cache answers without calling the provider
//    (60 s while the market is open or unknown, 15 min when it is closed);
//  - staleAt: after this instant the value must be DISPLAYED as STALE. It is longer than the
//    client refresh cadence (5 min open / 30 min closed), so a value only turns STALE when
//    refreshing it actually failed.
export const QUOTE_FRESH_OPEN_MS = 60_000;
export const QUOTE_FRESH_CLOSED_MS = 15 * 60_000;
export const QUOTE_STALE_AFTER_OPEN_MS = 10 * 60_000;
export const QUOTE_STALE_AFTER_CLOSED_MS = 60 * 60_000;
export const STALE_MAX_MS = 24 * 3600_000;      // serve STALE data up to 24 h when the provider fails
export function quoteFreshMs(marketOpen) { return marketOpen === false ? QUOTE_FRESH_CLOSED_MS : QUOTE_FRESH_OPEN_MS; }
export function quoteStaleAfterMs(marketOpen) { return marketOpen === false ? QUOTE_STALE_AFTER_CLOSED_MS : QUOTE_STALE_AFTER_OPEN_MS; }

const num = v => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const unixIso = s => (s == null || !Number.isFinite(Number(s)) ? null : new Date(Number(s) * 1000).toISOString());

// --- pure normalizer: Twelve Data /quote -> flat internal record (unit-tested) ---
export function normalizeQuote(sym, q) {
  if (!q || typeof q !== "object" || q.status === "error" || q.close == null) return null;
  const price = num(q.close);
  if (price == null) return null;
  const prev = num(q.previous_close);
  let pct = num(q.percent_change);
  if (pct == null && prev) pct = (price / prev - 1) * 100;
  let chg = num(q.change);
  if (chg == null && prev != null) chg = price - prev;
  // last_quote_at = last minute candle (the real data time); `timestamp` is only the bar's opening time
  const asOf = unixIso(q.last_quote_at) || unixIso(q.timestamp) || (q.datetime ? new Date(q.datetime).toISOString() : null);
  return {
    symbol: sym,
    name: q.name ?? null,
    exchange: q.exchange ?? null,
    currency: q.currency ?? null,                 // never assumed
    mic: q.mic_code ?? null,
    price,
    change: chg,
    changePct: pct,
    prevClose: prev,
    open: num(q.open),
    high: num(q.high),
    low: num(q.low),
    volume: num(q.volume),
    fiftyTwoWeekLow: q.fifty_two_week ? num(q.fifty_two_week.low) : null,
    fiftyTwoWeekHigh: q.fifty_two_week ? num(q.fifty_two_week.high) : null,
    marketOpen: typeof q.is_market_open === "boolean" ? q.is_market_open : null,
    asOf,
    provider: SOURCE,
  };
}

// --- flat record + freshness -> InstrumentData with a status on every field ---
// US equity = a US venue, or a plain ticker (no ":MIC", not a "/" pair) when the provider sent no MIC
export function isUsEquity(rec) {
  const s = String(rec.symbol || "");
  if (s.includes("/")) return false;
  return rec.mic ? US_MICS.has(rec.mic) : !s.includes(":");
}
export function buildInstrument(rec, { fetchedAt, now = Date.now(), stale = false, error = null }) {
  const staleAtMs = fetchedAt + quoteStaleAfterMs(rec.marketOpen);
  const isStale = stale || now > staleAtMs;
  const us = isUsEquity(rec);
  const fields = {};
  for (const [k, raw] of Object.entries(QUOTE_FIELDS)) {
    const rule = us || !raw.from ? raw : { from: raw.from, status: STATUS.LIVE, note: PROVIDER_NOTE };
    const value = rule.from ? rec[rule.from] : null;
    let status = value == null ? STATUS.NA : rule.status;
    if (isStale && status !== STATUS.NA) status = STATUS.STALE;
    fields[k] = { value, status, ...(value == null ? { note: rule.note || "not returned by provider" } : rule.note ? { note: rule.note } : {}) };
  }
  return {
    symbol: rec.symbol,
    name: rec.name,
    exchange: rec.exchange,
    mic: rec.mic ?? null,
    currency: rec.currency ?? null,
    status: isStale ? STATUS.STALE : STATUS.LIVE,
    source: SOURCE,
    timestamp: rec.asOf,                       // market-data time reported by the provider
    fetchedAt: new Date(fetchedAt).toISOString(), // when this Worker fetched it from the provider
    staleAt: new Date(staleAtMs).toISOString(),   // after this, the value must be shown as STALE
    marketOpen: rec.marketOpen,
    ...(error ? { staleReason: error } : {}),
    fields,
  };
}

// ======================= provider errors =======================
export function mapProviderError(td) {
  const code = Number(td && td.code);
  const msg = String((td && td.message) || "");
  // the listing exists but the key's data plan does not include it ("available starting with Grow/Pro")
  if (code !== 401 && code !== 429 && /\bplan\b|upgrad|subscription/i.test(msg)) return { status: 403, error: "plan_required" };
  if (code === 404 || (code === 400 && /symbol|not found|invalid/i.test(msg))) return { status: 404, error: "symbol_not_found" };
  if (code === 429) return { status: 429, error: "rate_limited" };
  if (code === 401 || code === 403) return { status: 502, error: "provider_auth" };
  return { status: 502, error: "provider_error" };
}
// the provider's own explanation, shortened; anything that could carry the key is removed
export function providerDetail(td, key) {
  let m = String((td && td.message) || "").replace(/https?:\/\/\S+/g, "").replace(/apikey\S*/gi, "");
  if (key) m = m.split(key).join("");
  return m.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 160) || null;
}
const ERROR_HTTP = { plan_required: 403, symbol_not_found: 404, rate_limited: 429, provider_timeout: 504, provider_unreachable: 502, provider_auth: 502, provider_error: 502 };

// the key travels in the Authorization header (provider's recommended method), never in the URL
export const tdAuth = (key) => ({ authorization: `apikey ${key}` });
async function providerFetchJson(url, key) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: tdAuth(key) });
    const text = await r.text();
    try { return { json: JSON.parse(text) }; } catch { return { err: "provider_error" }; } // empty / non-JSON response
  } catch {
    return { err: ac.signal.aborted ? "provider_timeout" : "provider_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ======================= shared cache (Cloudflare Cache API) =======================
function cacheFor() { return typeof caches !== "undefined" ? caches.default : null; }
async function cacheGet(cache, key) {
  if (!cache) return null;
  const r = await cache.match(new Request(key));
  if (!r) return null;
  try { return await r.json(); } catch { return null; }
}
function cachePut(cache, key, obj, ctx) {
  if (!cache) return;
  const resp = new Response(JSON.stringify(obj), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${STALE_MAX_MS / 1000}` } });
  const p = cache.put(new Request(key), resp);
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

// ======================= quotes: batch + in-flight coalescing =======================
// Concurrent requests for the same symbol inside this isolate share ONE provider call.
const INFLIGHT = new Map();
export const __stats = { providerQuoteCalls: 0 };
export function __resetForTests() { INFLIGHT.clear(); __stats.providerQuoteCalls = 0; }

// plain ids (US, FX, crypto) go in one batched call; "SYMBOL:MIC" ids need their own call with
// mic_code (same credit cost: the provider charges per symbol either way)
async function providerQuoteBatch(syms, key) {
  const venue = syms.filter(s => splitId(s).mic), plain = syms.filter(s => !splitId(s).mic);
  const parts = await Promise.all([plain.length ? providerQuotePlain(plain, key) : new Map(), ...venue.map(s => providerQuoteVenue(s, key))]);
  return new Map(parts.flatMap(m => [...m]));
}
async function providerQuoteVenue(id, key) {
  __stats.providerQuoteCalls++;
  const { symbol, mic } = splitId(id);
  const { json, err } = await providerFetchJson(`${TD_BASE}/quote?symbol=${encodeURIComponent(symbol)}&mic_code=${encodeURIComponent(mic)}`, key);
  if (err) return new Map([[id, { err }]]);
  if (!json || typeof json !== "object") return new Map([[id, { err: "provider_error" }]]);
  if (json.status === "error") return new Map([[id, { err: mapProviderError(json).error, detail: providerDetail(json, key) }]]);
  const rec = normalizeQuote(id, json);
  if (rec && !rec.mic) rec.mic = mic;
  return new Map([[id, rec ? { rec } : { err: "provider_error" }]]);
}
async function providerQuotePlain(syms, key) {
  __stats.providerQuoteCalls++;
  const out = new Map();
  const { json, err } = await providerFetchJson(`${TD_BASE}/quote?symbol=${encodeURIComponent(syms.join(","))}`, key);
  if (err) { syms.forEach(s => out.set(s, { err })); return out; }
  if (!json || typeof json !== "object") { syms.forEach(s => out.set(s, { err: "provider_error" })); return out; }
  // whole-request error (rate limit, auth, single unknown symbol)
  if (json.status === "error" && json.code != null) {
    const m = mapProviderError(json);
    const detail = providerDetail(json, key);
    syms.forEach(s => out.set(s, { err: m.error, detail }));
    return out;
  }
  for (const s of syms) {
    const q = syms.length === 1 ? json : json[s];
    if (!q) { out.set(s, { err: "provider_error" }); continue; }
    if (q.status === "error") { out.set(s, { err: mapProviderError(q).error, detail: providerDetail(q, key) }); continue; }
    const rec = normalizeQuote(s, q);
    out.set(s, rec ? { rec } : { err: "provider_error" });
  }
  return out;
}

function fetchQuotesCoalesced(syms, key) {
  const need = syms.filter(s => !INFLIGHT.has(s));
  if (need.length) {
    const batch = providerQuoteBatch(need, key);
    for (const s of need) {
      const p = batch.then(m => m.get(s) || { err: "provider_error" }).finally(() => INFLIGHT.delete(s));
      INFLIGHT.set(s, p);
    }
  }
  return Promise.all(syms.map(s => INFLIGHT.get(s).then(r => [s, r])));
}

export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-:\/^]{0,19}$/;

async function handleQuote(url, env, ctx, H) {
  const raw = (url.searchParams.get("symbols") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const symbols = [...new Set(raw)].slice(0, 20);
  if (!symbols.length) return json({ error: "no symbols" }, H, 400);
  const key = env.TWELVEDATA_KEY;
  if (!key) return json({ error: "server not configured (TWELVEDATA_KEY missing)" }, H, 500);

  const cache = cacheFor();
  const now = Date.now();
  const quotes = {}, errors = {}, stat = { hit: 0, miss: 0, stale: 0 };
  const entries = {}, misses = [];
  const valid = symbols.filter(s => SYMBOL_RE.test(s));
  for (const s of symbols) if (!valid.includes(s)) errors[s] = { error: "invalid_symbol", status: STATUS.NA };
  const cached = await Promise.all(valid.map(s => cacheGet(cache, `${url.origin}/__cache/quote/${encodeURIComponent(s)}`)));
  for (const [i, s] of valid.entries()) {
    const e = cached[i];
    entries[s] = e;
    if (e && e.rec && now - e.fetchedAt < quoteFreshMs(e.rec.marketOpen)) {
      quotes[s] = buildInstrument(e.rec, { fetchedAt: e.fetchedAt, now });
      stat.hit++;
    } else misses.push(s);
  }
  if (misses.length) {
    const results = await fetchQuotesCoalesced(misses, key);
    for (const [s, r] of results) {
      if (r.rec) {
        const fetchedAt = Date.now();
        cachePut(cache, `${url.origin}/__cache/quote/${encodeURIComponent(s)}`, { rec: r.rec, fetchedAt }, ctx);
        quotes[s] = buildInstrument(r.rec, { fetchedAt, now: fetchedAt });
        stat.miss++;
      } else {
        const e = entries[s];
        if (e && e.rec && now - e.fetchedAt < STALE_MAX_MS && r.err !== "symbol_not_found" && r.err !== "plan_required") {
          quotes[s] = buildInstrument(e.rec, { fetchedAt: e.fetchedAt, now, stale: true, error: r.err });
          stat.stale++;
        } else {
          errors[s] = { error: r.err, status: STATUS.NA, ...(r.detail ? { detail: r.detail } : {}) }; // never a fallback value
        }
      }
    }
  }
  const xc = stat.stale ? "STALE" : stat.miss && stat.hit ? "PARTIAL-HIT" : stat.miss ? "MISS" : stat.hit ? "HIT" : "NONE";
  const body = { quotes, errors, meta: { source: SOURCE, generatedAt: new Date().toISOString(), cache: stat } };
  let status = 200;
  if (!Object.keys(quotes).length) {
    const first = Object.values(errors)[0];
    status = (first && ERROR_HTTP[first.error]) || (first && first.error === "invalid_symbol" ? 400 : 502);
  }
  const resp = json(body, H, status);
  resp.headers.set("cache-control", "no-store"); // freshness is decided by the Worker cache, not the browser
  resp.headers.set("x-cache", xc);
  return resp;
}

// ======================= T03 — historical market data =======================
// Daily points carry the EXCHANGE-LOCAL trading date ("YYYY-MM-DD"): Twelve Data ignores
// `timezone` for daily+ intervals. Intraday points are requested in UTC ("...Z").
// Historical/EOD data is consolidated; an in-progress session's bar is a venue-subset aggregate.
export const HISTORY_RANGES = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y"];
const RANGE_MONTHS = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "5Y": 60 };
const DEFAULT_INTERVAL = { "1D": "5min", "1W": "1day", "1M": "1day", "3M": "1day", "6M": "1day", "1Y": "1day", "5Y": "1week" };
const INTRADAY = new Set(["5min", "15min", "1h"]);
const BARS_PER_SESSION = { "5min": 78, "15min": 26, "1h": 7 };
const ADJUST = new Set(["splits", "all", "none"]);

export class BadRequest extends Error {}
function isoDate(d) { return d.toISOString().slice(0, 10); }

export function buildHistoryQuery(params, now = new Date()) {
  const symbol = String(params.symbol || "").trim().toUpperCase();
  if (!symbol) throw new BadRequest("symbol is required");
  if (!SYMBOL_RE.test(symbol)) throw new BadRequest("invalid symbol");
  const range = String(params.range || "6M").toUpperCase();
  if (!HISTORY_RANGES.includes(range)) throw new BadRequest(`range must be one of ${HISTORY_RANGES.join(",")}`);
  let interval = params.interval ? String(params.interval) : DEFAULT_INTERVAL[range];
  if (interval === "1d") interval = "1day";      // accept the common short form
  if (interval === "1w" || interval === "1wk") interval = "1week";
  const intraday = INTRADAY.has(interval);
  if (!intraday && !["1day", "1week"].includes(interval)) throw new BadRequest("interval must be one of 5min,15min,1h,1day,1week");
  if (intraday && !["1D", "1W"].includes(range)) throw new BadRequest("intraday intervals are only allowed for range 1D or 1W");
  if (!intraday && range === "1D") throw new BadRequest("range 1D requires an intraday interval");
  const adjust = String(params.adjust || "splits");
  if (!ADJUST.has(adjust)) throw new BadRequest("adjust must be one of splits,all,none");

  const { symbol: tdSymbol, mic } = splitId(symbol);
  const q = { symbol: tdSymbol, ...(mic ? { mic_code: mic } : {}), interval, order: "asc", adjust };
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
  return { id: symbol, q, range, interval, adjust, intraday, ttl };
}

function toIsoUtc(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(String(s));
  return m ? `${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}Z` : null;
}

export function normalizeHistory(td, { intraday }) {
  const values = Array.isArray(td && td.values) ? td.values : [];
  const seen = new Set();
  const points = [];
  for (const v of values) {
    const t = intraday ? toIsoUtc(v.datetime) : (/^\d{4}-\d{2}-\d{2}$/.test(v.datetime) ? v.datetime : null);
    const c = num(v.close);
    if (!t || c == null || seen.has(t)) continue;
    seen.add(t);
    points.push({ t, o: num(v.open), h: num(v.high), l: num(v.low), c, v: num(v.volume) });
  }
  points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const meta = (td && td.meta) || {};
  return { currency: meta.currency ?? null, exchange: meta.exchange ?? null, exchangeTimezone: meta.exchange_timezone ?? null, type: meta.type ?? null, points };
}

// display staleness of a history response: intraday bars age quickly; completed daily/weekly
// bars do not change, only the newest one does (see lastBarPartial)
export function historyStaleAfterMs(intraday, interval) {
  return intraday ? 15 * 60_000 : interval === "1week" ? 7 * 24 * 3600_000 : 24 * 3600_000;
}

// today's date at the exchange (for flagging an in-progress, venue-subset last bar)
export function exchangeToday(tz, now = new Date(Date.now())) {
  try { return now.toLocaleDateString("en-CA", { timeZone: tz || "America/New_York" }); } catch { return isoDate(now); }
}

async function handleHistory(url, env, ctx, H) {
  let built;
  try { built = buildHistoryQuery(Object.fromEntries(url.searchParams)); }
  catch (e) { if (e instanceof BadRequest) return json({ error: "bad_request", message: e.message }, H, 400); throw e; }
  const key = env.TWELVEDATA_KEY;
  if (!key) return json({ error: "server not configured (TWELVEDATA_KEY missing)" }, H, 500);

  const { id, q, range, interval, adjust, intraday, ttl } = built;
  const cache = cacheFor();
  const cacheKey = `${url.origin}/__cache/history?${new URLSearchParams({ symbol: id, range, interval, adjust, d: q.start_date || "intraday" })}`;
  const entry = await cacheGet(cache, cacheKey);
  const now = Date.now();
  const respond = (body, xc, status = 200) => { const r = json(body, H, status, status === 200 ? ttl : 0); r.headers.set("x-cache", xc); return r; };
  const envelope = (n, fetchedAt, stale, staleReason) => {
    const last = n.points[n.points.length - 1];
    return {
      symbol: id, range, interval, adjust,
      timeBasis: intraday ? "utc" : "exchange_local_date",
      currency: n.currency, exchange: n.exchange, exchangeTimezone: n.exchangeTimezone, type: n.type,
      count: n.points.length, points: n.points,
      status: stale ? STATUS.STALE : STATUS.LIVE,
      source: SOURCE,
      fetchedAt: new Date(fetchedAt).toISOString(),
      staleAt: new Date(fetchedAt + historyStaleAfterMs(intraday, interval)).toISOString(),
      // completed sessions are consolidated; a bar for today (session in progress) is a venue-subset aggregate
      lastBarPartial: !intraday && !!last && last.t === exchangeToday(n.exchangeTimezone),
      ...(stale ? { staleReason } : {}),
      // kept for backward compatibility with T03 clients
      asOf: new Date(fetchedAt).toISOString(), provider: SOURCE,
    };
  };
  if (entry && entry.n && now - entry.fetchedAt < ttl * 1000) return respond(envelope(entry.n, entry.fetchedAt, false), "HIT");

  const { json: td, err } = await providerFetchJson(`${TD_BASE}/time_series?${new URLSearchParams(q)}`, key);
  let error = err || null, detail = null;
  let n = null;
  if (!error) {
    if (!td || typeof td !== "object") error = "provider_error";
    else if (td.status === "error") { error = mapProviderError(td).error; detail = providerDetail(td, key); }
    else { n = normalizeHistory(td, { intraday }); if (!n.points.length) error = "no_data"; }
  }
  if (!error) {
    const fetchedAt = Date.now();
    cachePut(cache, cacheKey, { n, fetchedAt }, ctx);
    return respond(envelope(n, fetchedAt, false), "MISS");
  }
  if (entry && entry.n && now - entry.fetchedAt < STALE_MAX_MS && error !== "symbol_not_found" && error !== "plan_required") {
    return respond(envelope(entry.n, entry.fetchedAt, true, error), "STALE");
  }
  const status = error === "no_data" ? 404 : ERROR_HTTP[error] || 502;
  const r = json({ error, symbol: id, status: STATUS.NA, ...(detail ? { detail } : {}) }, H, status);
  r.headers.set("x-cache", "MISS");
  return r;
}

// ======================= HTTP plumbing =======================
function cors(env) {
  return { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" };
}
function json(obj, headers, status = 200, cacheSec = 0) {
  const h = { ...headers, "content-type": "application/json" };
  if (cacheSec) h["cache-control"] = `public, max-age=${cacheSec}`;
  return new Response(JSON.stringify(obj), { status, headers: h });
}

// routing without the access check (unit tests exercise the handlers through this)
export const app = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const H = cors(env);
    if (req.method === "OPTIONS") return new Response(null, { headers: H });
    if (url.pathname === "/api/health") return json({ ok: true, ts: Date.now() }, H);
    if (url.pathname === "/api/quote") return handleQuote(url, env, ctx, H);
    if (url.pathname === "/api/history") return handleHistory(url, env, ctx, H);
    if (url.pathname === "/api/yields") return handleYields(url, env, ctx, H, json);
    if (url.pathname === "/api/calendar") return handleCalendar(url, env, ctx, H, json);
    if (url.pathname === "/api/calendar/history") return handleCalendarHistory(url, env, ctx, H, json);
    if (url.pathname === "/api/calendar/reactions") return handleCalendarReactions(url, env, ctx, H, json);
    if (url.pathname === "/api/news") return handleNews(url, env, ctx, H, json);
    if (url.pathname === "/api/exchanges") return handleExchanges(url, env, ctx, H, json);
    if (url.pathname === "/api/portfolio" || url.pathname.startsWith("/api/portfolio/")) return handlePortfolio(url, env, ctx, H, json, req);
    if (url.pathname === "/api/briefing") return handleBriefing(url, env, ctx, H, json);
    if (url.pathname === "/api/search") return handleSearch(url, env, ctx, H, json);
    if (url.pathname.startsWith("/api/spx/")) return handleSpx(url, env, ctx, H, json);
    if (url.pathname === "/api/headlines") return handleHeadlines(url, env, ctx, H, json);
    if (url.pathname === "/api/briefs" || url.pathname.startsWith("/api/briefs/")) return handleBriefs(url, env, ctx, H, json, req);
    return json({ error: "not found" }, H, 404);
  },
};

// what Cloudflare runs: /api/* only for a valid Cloudflare Access session of this application
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const a = await verifyAccess(req, env);
      if (!a.ok) {
        const r = json({ error: a.error, status: STATUS.NA }, { "cache-control": "no-store" }, a.status);
        if (a.status === 401) r.headers.set("www-authenticate", 'Bearer realm="Cloudflare Access"');
        return r;
      }
    }
    return app.fetch(req, env, ctx);
  },
  // Cron Trigger (wrangler.toml [triggers]): briefing editions written at their time — see cron.mjs
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(event.scheduledTime, env, ctx, { fetchQuotes: (syms) => fetchQuotesCoalesced(syms, env.TWELVEDATA_KEY) }));
  },
};
