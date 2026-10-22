// WORLD EXCHANGES — which markets are open now (T06).
//   GET /api/exchanges
// Source: Twelve Data /market_state (all plans, 1 credit for every exchange): open / closed per exchange,
// holidays and early closes included, with the time to the next open / close. The Worker turns those
// durations into instants (opensAt / closesAt) so the page can count down without asking again; the
// shared cache is kept until the next open/close of a major exchange (at most 30 minutes).
// The table below only adds what the provider does not give: a short label, the city and the IANA time
// zone (to show the exchange's local time) for the major markets. It holds no market data.
import { fetchText, cacheRead, cacheWrite, iso } from "./lib.mjs";
import { loadCnbcQuotes } from "./cnbc.mjs";

// ---------- backup (22 Oct 2026): Twelve Data not answering → whether each major market is trading, from its main index on
// CNBC (approved): open when CNBC marks the index in its regular session and its last print is under 30 minutes old;
// no countdown (CNBC gives no open / close times), holidays shown as they are (the index does not trade) — DERIVED
export const MIC_INDEX = { XNYS: ".SPX", XNAS: ".SPX", XTSE: ".GSPTSE", XLON: ".FTSE", XETR: ".GDAXI", XPAR: ".FCHI", XMIL: ".FTMIB", XMAD: ".IBEX", XSWX: ".SSMI", XJPX: ".N225", XHKG: ".HSI", XSHG: ".SSEC", XNSE: ".NSEI", XKRX: ".KS11", XASX: ".AXJO" };
export function stateFromIndices(quotes, now = Date.now()) {
  const out = [];
  for (const [code, label, city, tz, region] of MAJOR) {
    const q = quotes[MIC_INDEX[code]]; if (!q || !Number.isFinite(q.time)) continue;
    const open = q.session === "REG_MKT" && now - q.time < 30 * 60_000;
    out.push({ code, name: label, country: null, open, openedAt: null, closesAt: null, opensAt: null, major: true, label, city, tz, region, via: MIC_INDEX[code], lastPrint: iso(q.time) });
  }
  return out;
}

export const MARKET_STATE_URL = "https://api.twelvedata.com/market_state";
// MIC, label, city, IANA time zone, region
export const MAJOR = [
  ["XNYS", "NYSE", "New York", "America/New_York", "Americas"],
  ["XNAS", "Nasdaq", "New York", "America/New_York", "Americas"],
  ["XTSE", "TSX", "Toronto", "America/Toronto", "Americas"],
  ["XMEX", "BMV", "Mexico City", "America/Mexico_City", "Americas"],
  ["BVMF", "B3", "São Paulo", "America/Sao_Paulo", "Americas"],
  ["XLON", "LSE", "London", "Europe/London", "Europe & Africa"],
  ["XETR", "Xetra", "Frankfurt", "Europe/Berlin", "Europe & Africa"],
  ["XPAR", "Euronext Paris", "Paris", "Europe/Paris", "Europe & Africa"],
  ["XAMS", "Euronext Amsterdam", "Amsterdam", "Europe/Amsterdam", "Europe & Africa"],
  ["XMIL", "Borsa Italiana", "Milan", "Europe/Rome", "Europe & Africa"],
  ["XSWX", "SIX Swiss", "Zurich", "Europe/Zurich", "Europe & Africa"],
  ["XMAD", "BME", "Madrid", "Europe/Madrid", "Europe & Africa"],
  ["XSTO", "Nasdaq Stockholm", "Stockholm", "Europe/Stockholm", "Europe & Africa"],
  ["XJSE", "JSE", "Johannesburg", "Africa/Johannesburg", "Europe & Africa"],
  ["XSAU", "Tadawul", "Riyadh", "Asia/Riyadh", "Europe & Africa"],
  ["XJPX", "JPX", "Tokyo", "Asia/Tokyo", "Asia-Pacific"],
  ["XHKG", "HKEX", "Hong Kong", "Asia/Hong_Kong", "Asia-Pacific"],
  ["XSHG", "Shanghai SE", "Shanghai", "Asia/Shanghai", "Asia-Pacific"],
  ["XSHE", "Shenzhen SE", "Shenzhen", "Asia/Shanghai", "Asia-Pacific"],
  ["XKRX", "KRX", "Seoul", "Asia/Seoul", "Asia-Pacific"],
  ["XTAI", "TWSE", "Taipei", "Asia/Taipei", "Asia-Pacific"],
  ["XNSE", "NSE", "Mumbai", "Asia/Kolkata", "Asia-Pacific"],
  ["XSES", "SGX", "Singapore", "Asia/Singapore", "Asia-Pacific"],
  ["XASX", "ASX", "Sydney", "Australia/Sydney", "Asia-Pacific"],
];
const MAJOR_BY = Object.fromEntries(MAJOR.map(([code, label, city, tz, region]) => [code, { label, city, tz, region }]));

// "HH:MM:SS" (hours may exceed 24) → seconds; anything else → null
export function durSec(s) { const m = /^(\d+):(\d{2}):(\d{2})$/.exec(String(s || "").trim()); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; }

// provider rows → exchanges with absolute instants (ms) computed from the fetch time
export function normalizeMarketState(list, fetchedAt) {
  const out = [], seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const code = String(x && x.code || "").trim().toUpperCase();
    if (!code || typeof x.is_market_open !== "boolean" || seen.has(code)) continue;
    seen.add(code);
    const toOpen = durSec(x.time_to_open), toClose = durSec(x.time_to_close), after = durSec(x.time_after_open);
    const m = MAJOR_BY[code];
    out.push({
      code, name: String(x.name || code), country: x.country || null, open: x.is_market_open,
      openedAt: x.is_market_open && after != null ? fetchedAt - after * 1000 : null,
      closesAt: x.is_market_open && toClose != null && toClose > 0 ? fetchedAt + toClose * 1000 : null,
      opensAt: !x.is_market_open && toOpen != null && toOpen > 0 ? fetchedAt + toOpen * 1000 : null,
      major: !!m, label: m ? m.label : null, city: m ? m.city : null, tz: m ? m.tz : null, region: m ? m.region : null,
    });
  }
  return out;
}
// next open/close among the major exchanges (when the cached state stops being true)
export function nextChange(exchanges) {
  const t = exchanges.filter((e) => e.major).map((e) => (e.open ? e.closesAt : e.opensAt)).filter(Number.isFinite);
  return t.length ? Math.min(...t) : null;
}

const MAX_AGE = 30 * 60_000;
export async function handleExchanges(url, env, ctx, H, json, deps = {}) {
  const send = (body, status = 200) => { const r = json(body, H, status); r.headers.set("cache-control", "no-store"); return r; };
  const now = deps.now || Date.now(), key = "exchanges/state";
  const c = await cacheRead(url.origin, key);
  const fresh = c && c.data && now - c.fetchedAt < MAX_AGE && !(c.nextChange && now >= c.nextChange + 30_000);
  let entry = fresh ? c : null, err = null;
  if (!entry) {
    if (!env.TWELVEDATA_KEY) err = "server_not_configured";
    else {
      const f = await fetchText(MARKET_STATE_URL, { timeoutMs: 10000, headers: { accept: "application/json", authorization: `apikey ${env.TWELVEDATA_KEY}` } });
      if (f.err) err = f.err;
      else {
        let j = null; try { j = JSON.parse(f.text); } catch { err = "provider_error"; }
        if (j && !Array.isArray(j)) err = j.code === 429 ? "rate_limited" : j.code === 403 ? "plan_required" : j.code === 401 ? "provider_auth" : "provider_error";
        else if (j) {
          const fetchedAt = Date.now(), data = normalizeMarketState(j, fetchedAt);
          if (data.length) { entry = { data, fetchedAt, nextChange: nextChange(data) }; cacheWrite(url.origin, key, entry, ctx, 86400); }
          else err = "no_data";
        }
      }
    }
  }
  if (!entry) {
    // the backup: each major market's main index on CNBC (a live reading beats a stale copy with countdowns past)
    const q = await (deps.loadQuotes || loadCnbcQuotes)([...new Set(Object.values(MIC_INDEX))]).catch(() => ({ err: "provider_error" }));
    const data = q.data ? stateFromIndices(q.data, now) : [];
    if (data.length) {
      return send({ exchanges: data, count: data.length, majorOpen: data.filter((e) => e.open).length, majorCount: data.length, missingMajor: MAJOR.map(([code]) => code).filter((code) => !data.some((e) => e.code === code)),
        fetchedAt: iso(now), nextChange: null, source: "CNBC — each market's main index: trading in its regular session now (BACKUP: Twelve Data market_state " + (err || "no_data") + ")", status: "LIVE", backupFor: "twelvedata", primaryError: err || "no_data",
        note: "no countdown to the next open / close in the backup" });
    }
    // last real state, if any, is shown as STALE (its countdowns may have passed); never a guessed state
    if (c && c.data && now - c.fetchedAt < 24 * 3600_000) entry = { ...c, stale: err };
    else return send({ error: err || "no_data", status: "N/A", source: "Twelve Data — market_state" }, err === "rate_limited" ? 429 : 502);
  }
  return send({
    exchanges: entry.data, count: entry.data.length, majorOpen: entry.data.filter((e) => e.major && e.open).length, majorCount: entry.data.filter((e) => e.major).length,
    missingMajor: MAJOR.map(([code]) => code).filter((code) => !entry.data.some((e) => e.code === code)),
    fetchedAt: iso(entry.fetchedAt), nextChange: entry.nextChange ? iso(entry.nextChange) : null,
    source: "Twelve Data — market_state (holidays and early closes included)", status: entry.stale ? "STALE" : "LIVE", ...(entry.stale ? { staleReason: entry.stale } : {}),
  });
}
