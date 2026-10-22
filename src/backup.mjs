// BACKUPS — when a provider does not answer (daily credits used up, rate limit, refusal, outage), the same value from
// another approved provider, always labelled with the provider that gave it and why the first one did not
// (22 Oct 2026, the owner: "dove il provider non va più serve un backup, in ogni cosa").
//   quotes   Twelve Data → CNBC (U.S. symbols, FX, crypto, metals, listings elsewhere) → Finnhub (U.S. stocks) →
//            Alpha Vantage (approved 22 Oct 2026; secret ALPHAVANTAGE_KEY; 25 requests a day) → the last real quote STALE
//   history  Twelve Data → CNBC bars → Alpaca daily bars (U.S.) → Alpha Vantage daily (the last 100 sessions) → STALE
//   CNBC daily bars (PLAB, EFC, FACT, screener) → FRED for CNBC's FX codes (EUR=, GBP=, CHF=, JPY=) → Alpaca (U.S.)
// Stooq (approved 22 Oct 2026) is not used: since mid-2026 its downloads sit behind a JavaScript proof-of-work page (the
// key route included), which also says automated access is not wanted.
// Keys: Finnhub in its header; Alpha Vantage only accepts its key as a URL parameter — that URL is never logged, returned
// or put in an error.
import { fetchText, iso, cacheRead, cacheWrite, cachedSource } from "./lib.mjs";
import { cnbcCodeFor } from "./intl.mjs";
import { cnbcDaily } from "./cnbc.mjs";
import { alertCnbcSym } from "./alerts.mjs";
import { finnhubKey, FINNHUB } from "./earnings.mjs";

export const AV_BASE = "https://www.alphavantage.co/query";
export const AV_DAILY_MAX = 25;
const DAY = 86400_000;
const num = (v) => { if (v == null || v === "") return null; const x = Number(String(v).replace(/[%,]/g, "")); return Number.isFinite(x) ? x : null; };
// a provider error a backup may stand in for (an invalid symbol is invalid everywhere)
export const BACKUP_ERRORS = new Set(["daily_limit", "rate_limited", "provider_error", "provider_timeout", "provider_unreachable", "provider_forbidden", "provider_auth", "plan_required", "symbol_not_found", "not_configured"]);
// the terminal's id → CNBC's code: listings elsewhere (SYMBOL:MIC, C:code), U.S. stocks and ETFs, FX pairs (EUR/USD → EUR=),
// crypto (BTC/USD → BTC.CM=), metals (XAU/USD → XAU=)
export function cnbcAnyCode(id) {
  const s = String(id || "").toUpperCase();
  if (/^(IDX|FUT):/.test(s)) return null;
  return cnbcCodeFor(s) || alertCnbcSym(s) || null;
}
const US_STOCK = /^[A-Z]{1,5}(\.[A-Z])?$/;
export const isUsStock = (id) => US_STOCK.test(String(id || ""));

// ---------- Finnhub quote (U.S. stocks; free plan; key in its header) ----------
export function finnhubRec(id, j) {
  if (!j || typeof j !== "object") return null;
  const price = num(j.c), t = num(j.t);
  if (!(price > 0) || !(t > 0)) return null; // an unknown symbol answers zeros
  return { symbol: id, name: null, exchange: null, currency: "USD", price, change: num(j.d), changePct: num(j.dp), prevClose: num(j.pc), open: num(j.o), high: num(j.h), low: num(j.l), volume: null, asOf: iso(t * 1000), realTime: true };
}
export async function finnhubQuote(env, id, fetchImpl) {
  const key = finnhubKey(env); if (!key || !isUsStock(id)) return { err: "not_configured" };
  const u = `${FINNHUB}/quote?symbol=${encodeURIComponent(id)}`;
  const f = fetchImpl ? await fetchImpl(u, key) : await fetchText(u, { timeoutMs: 8000, headers: { "X-Finnhub-Token": key, accept: "application/json" } });
  if (f.err) return { err: f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const rec = finnhubRec(id, j); return rec ? { rec } : { err: "symbol_not_found" };
}

// ---------- Alpha Vantage (approved 22 Oct 2026; free key: 25 requests a day) ----------
// the terminal's id → Alpha Vantage's: U.S. as is; Xetra .DEX, London .LON, Toronto .TRT; FX and crypto pairs → from / to
const AV_SUFFIX = { XETR: "DEX", XLON: "LON", XTSE: "TRT" };
export function avTarget(id) {
  const s = String(id || "").toUpperCase(); let m;
  if ((m = /^([A-Z]{3,4})\/([A-Z]{3})$/.exec(s))) return { fx: true, from: m[1], to: m[2] };
  if (US_STOCK.test(s)) return { symbol: s };
  if ((m = /^([A-Z0-9.]{1,12}):([A-Z]{4})$/.exec(s)) && AV_SUFFIX[m[2]]) return { symbol: `${m[1]}.${AV_SUFFIX[m[2]]}` };
  return null;
}
export const avUrl = (params, key) => `${AV_BASE}?${new URLSearchParams({ ...params, apikey: key })}`;
// a refusal comes as a JSON message: "Information" / "Note" (the daily or per-minute limit), "Error Message" (unknown symbol)
export function avError(j) {
  if (!j || typeof j !== "object") return "provider_error";
  if (j["Error Message"]) return "symbol_not_found";
  if (j.Information || j.Note) return /premium/i.test(String(j.Information || j.Note)) ? "plan_required" : "rate_limited";
  return null;
}
export function avQuoteRec(id, j) {
  const g = j && j["Global Quote"]; if (!g || !Object.keys(g).length) return null;
  const price = num(g["05. price"]), day = String(g["07. latest trading day"] || "");
  if (!(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return { symbol: id, name: null, exchange: null, currency: null, price, change: num(g["09. change"]), changePct: num(g["10. change percent"]), prevClose: num(g["08. previous close"]), open: num(g["02. open"]), high: num(g["03. high"]), low: num(g["04. low"]), volume: num(g["06. volume"]), asOf: null, dateOnly: day, realTime: false };
}
export function avFxRec(id, j) {
  const r = j && j["Realtime Currency Exchange Rate"]; if (!r) return null;
  const price = num(r["5. Exchange Rate"]), at = String(r["6. Last Refreshed"] || ""), tz = String(r["7. Time Zone"] || "");
  if (!(price > 0)) return null;
  const t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) && /^UTC$/i.test(tz) ? Date.parse(at.replace(" ", "T") + "Z") : null;
  return { symbol: id, name: null, exchange: null, currency: String(r["3. To_Currency Code"] || "") || null, price, change: null, changePct: null, prevClose: null, open: null, high: null, low: null, volume: null, asOf: t ? iso(t) : null, dateOnly: t ? null : at.slice(0, 10) || null, realTime: false };
}
// the free key's 25 requests a day, counted per data centre (Cache API) so that the backup does not spend them twice
async function avBudget(origin, ctx, now) {
  const k = `av/count/${new Date(now).toISOString().slice(0, 10)}`, c = (await cacheRead(origin, k)) || { n: 0 };
  if (c.n >= AV_DAILY_MAX) return false;
  await cacheWrite(origin, k, { n: c.n + 1 }, ctx, DAY / 1000); return true;
}
async function avGet(env, params, { origin, ctx, now = Date.now(), fetchImpl } = {}) {
  const key = env && env.ALPHAVANTAGE_KEY; if (!key) return { err: "not_configured" };
  if (origin && !(await avBudget(origin, ctx, now))) return { err: "daily_limit" };
  const u = avUrl(params, key);
  const f = fetchImpl ? await fetchImpl(u) : await fetchText(u, { timeoutMs: 10000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.err === "provider_error" && f.http ? "provider_error" : f.err }; // never the URL: it holds the key
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const e = avError(j); return e && !j["Global Quote"] && !j["Realtime Currency Exchange Rate"] && !j["Time Series (Daily)"] ? { err: e } : { json: j };
}
export async function avQuote(env, id, opts = {}) {
  const t = avTarget(id); if (!t) return { err: "not_supported" };
  const r = await avGet(env, t.fx ? { function: "CURRENCY_EXCHANGE_RATE", from_currency: t.from, to_currency: t.to } : { function: "GLOBAL_QUOTE", symbol: t.symbol }, opts);
  if (r.err) return r;
  const rec = t.fx ? avFxRec(id, r.json) : avQuoteRec(id, r.json); return rec ? { rec } : { err: "no_data" };
}
// daily bars (free: the last 100 sessions) → [{ t, o, h, l, c, v }] oldest first
export function avDailyPoints(j) {
  const ts = j && j["Time Series (Daily)"]; if (!ts) return [];
  return Object.entries(ts).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(([t, v]) => ({ t, o: num(v["1. open"]), h: num(v["2. high"]), l: num(v["3. low"]), c: num(v["4. close"]), v: num(v["5. volume"]) }))
    .filter((p) => p.c > 0).sort((a, b) => (a.t < b.t ? -1 : 1));
}
export async function avDaily(env, id, opts = {}) {
  const t = avTarget(id); if (!t || t.fx) return { err: "not_supported" };
  const r = await avGet(env, { function: "TIME_SERIES_DAILY", symbol: t.symbol, outputsize: "compact" }, opts);
  if (r.err) return r;
  const pts = avDailyPoints(r.json); return pts.length ? { data: pts } : { err: "no_data" };
}

// ---------- Alpaca daily bars (U.S. stocks and ETFs; consolidated SIP data older than 15 minutes) ----------
export function alpacaPoints(bars) {
  return (bars || []).map((b) => ({ t: String(b.t || "").slice(0, 10), o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: num(b.v) })).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.t) && p.c > 0);
}
export async function alpacaDaily(env, id, from, now = Date.now(), fetchImpl) {
  if (!env || !env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) return { err: "not_configured" };
  if (!isUsStock(id)) return { err: "not_supported" };
  const out = []; let token = null;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ symbols: id, timeframe: "1Day", start: new Date(from).toISOString(), end: new Date(now - 16 * 60_000).toISOString(), feed: "sip", adjustment: "all", limit: "10000", ...(token ? { page_token: token } : {}) });
    const u = `https://data.alpaca.markets/v2/stocks/bars?${qs}`;
    const f = fetchImpl ? await fetchImpl(u) : await fetchText(u, { timeoutMs: 12000, headers: { "APCA-API-KEY-ID": env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY, accept: "application/json" } });
    if (f.err) return out.length ? { data: out } : { err: f.err };
    let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
    out.push(...alpacaPoints(j.bars && j.bars[id]));
    token = j.next_page_token; if (!token) break;
  }
  return out.length ? { data: out } : { err: "no_data" };
}

// ---------- FRED for CNBC's FX codes (daily noon buying rates in New York, H.10) ----------
// CNBC's code → FRED series and whether it is the inverse: EUR= and GBP= are USD per unit (DEXUSEU, DEXUSUK); CHF= and
// JPY= are units per USD (DEXSZUS, DEXJPUS)
export const FRED_FX = { "EUR=": "DEXUSEU", "GBP=": "DEXUSUK", "CHF=": "DEXSZUS", "JPY=": "DEXJPUS" };
export async function fredFxDaily(env, code, from, fetchImpl) {
  const id = FRED_FX[code]; if (!id) return { err: "not_supported" };
  if (!env || !env.FRED_KEY) return { err: "not_configured" };
  const qs = new URLSearchParams({ series_id: id, api_key: env.FRED_KEY, file_type: "json", observation_start: new Date(from).toISOString().slice(0, 10) });
  const u = `https://api.stlouisfed.org/fred/series/observations?${qs}`;
  const f = fetchImpl ? await fetchImpl(u) : await fetchText(u, { timeoutMs: 12000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.err }; // never the URL: it holds the key
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const rows = (j.observations || []).map((o) => [o.date, num(o.value)]).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v > 0);
  return rows.length ? { data: rows, series: id } : { err: "no_data" };
}

// ---------- a quote from a backup in the terminal's instrument shape ----------
const NOTES = { finnhub: "Finnhub quote (U.S. consolidated, real-time on the free plan)", alphavantage: "Alpha Vantage quote (the last session's figures on the free plan)" };
export const BACKUP_STALE_MS = 60 * 60_000;
export function backupInstrument(rec, { source, fetchedAt, now = Date.now(), fieldKeys, backupFor, primaryError }) {
  const isStale = now > fetchedAt + BACKUP_STALE_MS, fields = {};
  for (const k of fieldKeys) {
    const value = rec[k] == null ? null : rec[k];
    fields[k] = { value, status: value == null ? "N/A" : isStale ? "STALE" : "LIVE", note: value == null ? `not given by ${source === "finnhub" ? "Finnhub" : "Alpha Vantage"}` : NOTES[source] };
  }
  return {
    symbol: rec.symbol, name: rec.name, exchange: rec.exchange, mic: null, currency: rec.currency, country: null,
    status: isStale ? "STALE" : "LIVE", source, realTime: rec.realTime, timestamp: rec.asOf, ...(rec.dateOnly ? { dateOnly: rec.dateOnly } : {}),
    fetchedAt: iso(fetchedAt), staleAt: iso(fetchedAt + BACKUP_STALE_MS), marketOpen: null, fields, backupFor, primaryError,
  };
}

// ---------- CNBC daily bars with a backup (PLAB, EFC, FACT, the screener) ----------
// the Worker's bindings for the backups of modules that do not receive them (set once per request / scheduled run)
let ENV = null;
export const setBackupEnv = (env) => { ENV = env || null; };
// CNBC's code → the backup's daily closes [[date, close]]: FRED for the FX codes, Alpaca for a U.S. symbol
export async function backupDaily(code, days, now, env = ENV, deps = {}) {
  const from = now - days * DAY;
  if (FRED_FX[code]) { const r = await (deps.fred || fredFxDaily)(env, code, from); return r.data ? { data: r.data, source: `FRED ${r.series}` } : r; }
  if (isUsStock(code)) { const r = await (deps.alpaca || alpacaDaily)(env, code, from, now); return r.data ? { data: r.data.map((p) => [p.t, p.c]), source: "Alpaca" } : r; }
  return { err: "no_backup" };
}
// cnbcDaily, then — only when CNBC gives nothing, not even a stale copy — the backup (kept 6 hours under its own key);
// the answer says which provider gave it: { data, source?, backupFor?, primaryError? }
export async function cnbcDailyB(origin, ctx, code, days, now, deps = {}) {
  const r = await (deps.daily || cnbcDaily)(origin, ctx, code, days, now);
  if (r && r.data) return r;
  const b = await cachedSource({ origin, key: `bk/d${days}/${code}`, ttlMs: 6 * 3600_000, staleMaxMs: 10 * DAY, ctx, now,
    load: async () => { const x = await backupDaily(code, days, now, deps.env || ENV, deps); return x.data ? { data: { rows: x.data, source: x.source } } : x; } });
  if (!b.data) return { err: (r && r.err) || b.err, backupErr: b.err };
  return { data: b.data.rows, fetchedAt: b.fetchedAt, cache: b.cache, source: b.data.source, backupFor: "CNBC", primaryError: (r && r.err) || "no_data" };
}

// ---------- the ECB's euro reference rates backed by FRED's H.10 rates (noon buying rates in New York) ----------
// units of a currency per euro, crossed through the dollar: USD per EUR (DEXUSEU) with USD per unit (pound, Australian and
// New Zealand dollar) or units per USD (the others) — DERIVED, labelled; another day's fixing than the ECB's 16:00 CET
export const FRED_PER_USD = { JPY: "DEXJPUS", CHF: "DEXSZUS", CAD: "DEXCAUS", CNY: "DEXCHUS", HKD: "DEXHKUS", SEK: "DEXSDUS", NOK: "DEXNOUS", DKK: "DEXDNUS", ZAR: "DEXSFUS", MXN: "DEXMXUS", INR: "DEXINUS", KRW: "DEXKOUS", SGD: "DEXSIUS", BRL: "DEXBZUS" };
export const FRED_USD_PER = { GBP: "DEXUSUK", AUD: "DEXUSAL", NZD: "DEXUSNZ" };
async function fredObs(env, id, start, fetchImpl) {
  const qs = new URLSearchParams({ series_id: id, api_key: env.FRED_KEY, file_type: "json", observation_start: start });
  const u = `https://api.stlouisfed.org/fred/series/observations?${qs}`;
  const f = fetchImpl ? await fetchImpl(u) : await fetchText(u, { timeoutMs: 12000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  return { data: new Map((j.observations || []).map((o) => [o.date, num(o.value)]).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v > 0)) };
}
export async function fredEcbRates(env, ccys, start, fetchImpl) {
  if (!env || !env.FRED_KEY) return { err: "not_configured" };
  const want = ccys.filter((c) => c === "USD" || FRED_PER_USD[c] || FRED_USD_PER[c]); if (!want.length) return { err: "no_backup" };
  const ids = [...new Set(["DEXUSEU", ...want.map((c) => FRED_PER_USD[c] || FRED_USD_PER[c]).filter(Boolean)])];
  const res = await Promise.all(ids.map((id) => fredObs(env, id, start, fetchImpl))), M = Object.fromEntries(ids.map((id, i) => [id, res[i].data]));
  if (!M.DEXUSEU) return { err: res[0].err || "no_data" };
  const out = {};
  for (const c of want) {
    const rows = [];
    for (const [d, ue] of M.DEXUSEU) {
      if (c === "USD") { rows.push([d, ue]); continue; }
      const x = FRED_PER_USD[c] ? M[FRED_PER_USD[c]] && M[FRED_PER_USD[c]].get(d) : M[FRED_USD_PER[c]] && M[FRED_USD_PER[c]].get(d);
      if (x > 0) rows.push([d, FRED_PER_USD[c] ? ue * x : ue / x]);
    }
    if (rows.length) out[c] = rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  return Object.keys(out).length ? { data: out } : { err: "no_data" };
}
