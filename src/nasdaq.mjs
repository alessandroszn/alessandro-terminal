// NASDAQ (api.nasdaq.com, approved 20 Oct 2026): actual figures of economic releases (the calendar), the screener of every
// listed U.S. stock, and the day's movers. The API refuses the Worker's own user agent (Cloudflare 520, checked 20 Oct
// 2026) and answers requests that look like a browser, so these requests send a browser user agent.
//   GET /api/nasdaq/calendar?from=2026-10-19&to=2026-10-23   releases with actual / consensus / previous (≤ 8 days)
//   GET /api/nasdaq/screener?ex=nasdaq|nyse|amex             every listed stock of one exchange (compact rows)
//   GET /api/nasdaq/movers                                   most active, gainers, losers (the lists Nasdaq publishes)
import { fetchText, cachedSource, iso } from "./lib.mjs";

const BUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
export const NQ_HEADERS = { "user-agent": BUA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", origin: "https://www.nasdaq.com", referer: "https://www.nasdaq.com/" };
export const NQ_CAL = (date) => `https://api.nasdaq.com/api/calendar/economicevents?date=${date}`;
export const NQ_SCR = (ex) => `https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true&exchange=${ex}`;
export const NQ_MOV = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&exchangestatus=currentMarket&limit=20";
export const NQ_PAGE = { calendar: "https://www.nasdaq.com/market-activity/economic-calendar", screener: "https://www.nasdaq.com/market-activity/stocks/screener", movers: "https://www.nasdaq.com/market-activity/most-active" };
const SRC = (k) => ({ source: "Nasdaq", sourceUrl: NQ_PAGE[k] });

// a published figure or nothing: blanks and "&nbsp;" are not values
export const nqText = (v) => { const t = String(v == null ? "" : v).replace(/&nbsp;|nbsp;/gi, " ").trim(); return t === "" || t === "-" || t === "N/A" ? null : t; };
export const nqNum = (v) => { const t = nqText(v); if (t == null) return null; const n = Number(t.replace(/[$,%\s]/g, "")); return Number.isFinite(n) ? n : null; };

// one day of the economic calendar: "gmt" is the release time in GMT on that date
export function parseNqCalendar(j, date) {
  const rows = j && j.data && Array.isArray(j.data.rows) ? j.data.rows : [];
  return rows.map((r) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(r.gmt || "").trim());
    const t = m ? Date.parse(`${date}T${m[1].padStart(2, "0")}:${m[2]}:00Z`) : null;
    return { date, time: m ? `${m[1].padStart(2, "0")}:${m[2]}` : null, at: t ? iso(t) : null, country: nqText(r.country), event: nqText(r.eventName), actual: nqText(r.actual), consensus: nqText(r.consensus), previous: nqText(r.previous) };
  }).filter((r) => r.event && r.country);
}
const DAY = 86400_000;
async function calDay(origin, ctx, date, now) {
  const past = Date.parse(date + "T23:59:59Z") < now - DAY;
  return cachedSource({ origin, key: `nq/cal/${date}`, ttlMs: past ? 12 * 3600_000 : 10 * 60_000, staleMaxMs: 7 * DAY, failTtlMs: 5 * 60_000, ctx, load: async () => {
    const f = await fetchText(NQ_CAL(date), { timeoutMs: 12000, headers: NQ_HEADERS });
    if (f.err) return { err: f.err };
    let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
    return { data: parseNqCalendar(j, date) };
  } });
}

// the screener file: [symbol, name, last, change %, volume, market cap, sector, industry, country, IPO year]
export function parseNqScreener(j) {
  const rows = j && j.data && Array.isArray(j.data.rows) ? j.data.rows : [];
  const out = [];
  for (const r of rows) {
    const sym = String(r.symbol || "").trim(); if (!/^[A-Z][A-Z0-9.^/-]{0,9}$/.test(sym)) continue;
    out.push([sym, String(r.name || "").trim(), nqNum(r.lastsale), nqNum(r.pctchange), nqNum(r.volume), nqNum(r.marketCap), nqText(r.sector), nqText(r.industry), nqText(r.country), nqNum(r.ipoyear)]);
  }
  return out;
}
// the movers lists as Nasdaq publishes them, each with its own column titles
export function parseNqMovers(j) {
  const st = j && j.data && j.data.STOCKS, out = [];
  if (!st || typeof st !== "object") return out;
  for (const [key, v] of Object.entries(st)) {
    const t = v && v.table, rows = t && Array.isArray(t.rows) ? t.rows : [];
    if (!rows.length) continue;
    const h = (t.headers || {});
    out.push({ key, asOf: nqText(v.dataAsOf), cols: { last: h.lastSalePrice || "Last", chg: h.lastSaleChange || "Change", third: h.change || null },
      rows: rows.map((r) => ({ sym: String(r.symbol || "").trim(), name: nqText(r.name), last: nqNum(r.lastSalePrice), chg: nqText(r.lastSaleChange), third: nqText(r.change) })).filter((r) => r.sym) });
  }
  return out;
}

export async function handleNasdaq(url, env, ctx, H, json) {
  const now = Date.now(), p = url.pathname, send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (p === "/api/nasdaq/calendar") {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && Number.isFinite(Date.parse(d + "T00:00:00Z"));
    const today = new Date(now).toISOString().slice(0, 10), from = url.searchParams.get("from") || today, to = url.searchParams.get("to") || from;
    if (!ok(from) || !ok(to) || to < from) return send({ error: "bad_request", message: "from / to: YYYY-MM-DD" }, 400);
    const days = []; for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z") && days.length < 8; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
    const res = await Promise.all(days.map((d) => calDay(url.origin, ctx, d, now)));
    const rows = [], errors = {};
    days.forEach((d, i) => { if (res[i].data) rows.push(...res[i].data); else errors[d] = res[i].err; });
    return send({ rows, errors, ...SRC("calendar"), basis: "actual, consensus and previous as Nasdaq publishes them; release time in GMT", status: rows.length ? "LIVE" : "N/A" }, rows.length || !Object.keys(errors).length ? 200 : 502);
  }
  if (p === "/api/nasdaq/screener") {
    const ex = String(url.searchParams.get("ex") || "").toLowerCase();
    if (!["nasdaq", "nyse", "amex"].includes(ex)) return send({ error: "bad_request", message: "ex: nasdaq, nyse or amex" }, 400);
    const r = await cachedSource({ origin: url.origin, key: `nq/scr/${ex}`, ttlMs: 15 * 60_000, staleMaxMs: 5 * DAY, failTtlMs: 5 * 60_000, ctx, load: async () => {
      const f = await fetchText(NQ_SCR(ex), { timeoutMs: 25000, headers: NQ_HEADERS });
      if (f.err) return { err: f.err };
      let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
      const rows = parseNqScreener(j); return rows.length ? { data: rows } : { err: "no_data" };
    } });
    if (!r.data) return send({ ex, status: "N/A", error: r.err, ...SRC("screener") }, 502);
    return send({ ex, cols: ["symbol", "name", "last", "chgPct", "volume", "marketCap", "sector", "industry", "country", "ipoYear"], rows: r.data, ...SRC("screener"), basis: "Nasdaq's screener file: last sale, change and volume as Nasdaq lists them (delayed), market cap as Nasdaq computes it", status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) });
  }
  if (p === "/api/nasdaq/movers") {
    const r = await cachedSource({ origin: url.origin, key: "nq/mov", ttlMs: 2 * 60_000, staleMaxMs: 3 * DAY, failTtlMs: 60_000, ctx, load: async () => {
      const f = await fetchText(NQ_MOV, { timeoutMs: 12000, headers: NQ_HEADERS });
      if (f.err) return { err: f.err };
      let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
      const lists = parseNqMovers(j); return lists.length ? { data: lists } : { err: "no_data" };
    } });
    if (!r.data) return send({ status: "N/A", error: r.err, ...SRC("movers") }, 502);
    return send({ lists: r.data, ...SRC("movers"), status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) });
  }
  return send({ error: "not_found" }, 404);
}
