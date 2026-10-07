// EARNINGS CALENDAR (T07) — Finnhub (free key, FINNHUB_KEY, sent only in the X-Finnhub-Token header).
//   GET /api/earnings?back=4&fwd=12
//   GET /api/earnings/reactions?back=4&fwd=12   price reaction of reports already out (separate request: CPU budget)
// Companies of the S&P 500 and the Nasdaq-100 (our real index lists), ordered by index weight (a proxy for size).
// For each report: date, before/after the open, fiscal quarter, EPS estimate and actual, revenue estimate and actual,
// and the price reaction on the session that followed it (Alpaca consolidated daily closes) — DERIVED.
import { fetchText, cachedSource, iso, easternDate } from "./lib.mjs";
import { getUniverse, alpacaDailyBars, alpacaConfigured } from "./spx.mjs";

export const FINNHUB = "https://finnhub.io/api/v1";
// the secret as set in the dashboard: FINNHUB_KEY, or FINHUB_KEY (the name it was first saved under, 7 Oct 2026)
export const finnhubKey = (env) => (env && (env.FINNHUB_KEY || env.FINHUB_KEY)) || null;
const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function normalizeEarnings(j, universe) {
  const list = j && Array.isArray(j.earningsCalendar) ? j.earningsCalendar : [];
  const out = [], seen = new Set();
  for (const e of list) {
    const sym = String(e.symbol || "").toUpperCase(), u = universe[sym];
    if (!u || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) continue;
    const k = `${sym}|${e.date}`; if (seen.has(k)) continue; seen.add(k);
    out.push({
      sym, name: u.name, weight: u.weight, index: u.index, date: e.date, hour: e.hour === "bmo" ? "before open" : e.hour === "amc" ? "after close" : e.hour === "dmh" ? "during market" : null,
      quarter: e.quarter != null && e.year != null ? `Q${e.quarter} ${e.year}` : null,
      epsEstimate: num(e.epsEstimate), epsActual: num(e.epsActual), revenueEstimate: num(e.revenueEstimate), revenueActual: num(e.revenueActual),
    });
  }
  return out.sort((a, b) => (a.date === b.date ? (b.weight || 0) - (a.weight || 0) : a.date < b.date ? -1 : 1));
}
// session that reflects the report: the report day itself if before the open, else the next session
export function reaction(bars, date, hour) {
  if (!bars || bars.length < 2) return null;
  const i = hour === "before open" || hour === "during market" ? bars.findIndex(([d]) => d >= date) : bars.findIndex(([d]) => d > date);
  if (i < 1) return null;
  return { session: bars[i][0], chg: (bars[i][1] / bars[i - 1][1] - 1) * 100 };
}

function span(url) {
  const back = Math.min(14, Math.max(0, Number(url.searchParams.get("back") ?? 4) || 0)), fwd = Math.min(30, Math.max(1, Number(url.searchParams.get("fwd") ?? 12) || 12));
  const now = Date.now(), today = easternDate(new Date(now));
  return { now, today, from: addDays(today, -back), to: addDays(today, fwd) };
}
// the calendar, filtered to our index companies and kept small in the cache (the full Finnhub list is parsed once)
async function getRows(url, env, ctx, w) {
  return cachedSource({ origin: url.origin, key: `earn/rows/${w.from}/${w.to}`, ttlMs: 2 * 3600_000, staleMaxMs: 3 * 86400_000, ctx, failTtlMs: 10 * 60_000,
    load: async () => {
      const [spx, ndx] = await Promise.all([getUniverse(url.origin, ctx, "SPX"), getUniverse(url.origin, ctx, "NDX")]);
      const universe = {};
      for (const [u, idx] of [[spx, "S&P 500"], [ndx, "Nasdaq-100"]]) for (const it of (u.data && u.data.items) || []) { const x = universe[it.sym] || (universe[it.sym] = { name: it.name, weight: it.weight, index: [] }); x.index.push(idx); if (idx === "S&P 500") x.weight = it.weight; }
      if (!Object.keys(universe).length) return { err: "universe_unavailable" };
      const f = await fetchText(`${FINNHUB}/calendar/earnings?${new URLSearchParams({ from: w.from, to: w.to })}`, { timeoutMs: 15000, headers: { "X-Finnhub-Token": finnhubKey(env), accept: "application/json" } });
      if (f.err) return { err: f.http === 401 ? "provider_auth" : f.err };
      let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
      return j && Array.isArray(j.earningsCalendar) ? { data: normalizeEarnings(j, universe) } : { err: "provider_error" };
    } });
}
export async function handleEarnings(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!finnhubKey(env)) return send({ error: "finnhub_not_configured", status: "N/A", message: "Finnhub API key not set in the Worker (FINNHUB_KEY)" }, 503);
  const w = span(url), r = await getRows(url, env, ctx, w);
  if (!r.data) return send({ error: r.err, status: "N/A" }, r.err === "rate_limited" ? 429 : 502);
  if (url.pathname.endsWith("/reactions")) {
    const past = r.data.filter((x) => x.date <= w.today);
    if (!past.length) return send({ reactions: {}, status: "LIVE" });
    if (!alpacaConfigured(env)) return send({ error: "alpaca_not_configured", status: "N/A" }, 503);
    const syms = [...new Set(past.map((x) => x.sym))].slice(0, 200);
    const b = await cachedSource({ origin: url.origin, key: `earn/bars/${w.from}/${w.today}/${syms.join(",").length}`, ttlMs: 30 * 60_000, staleMaxMs: 2 * 86400_000, ctx, failTtlMs: 5 * 60_000,
      load: () => alpacaDailyBars(env, syms, addDays(w.from, -7), new Date(w.now - 16 * 60_000).toISOString()) });
    if (!b.data) return send({ error: b.err, status: "N/A" }, 502);
    const reactions = {};
    for (const x of past) { const re = reaction(b.data[x.sym], x.date, x.hour); if (re) reactions[`${x.sym}|${x.date}`] = re; }
    return send({ reactions, basis: "close of the first session after the report vs the close before (Alpaca consolidated) — DERIVED", status: "DERIVED" });
  }
  return send({ from: w.from, to: w.to, today: w.today, rows: r.data, count: r.data.length, universe: "S&P 500 + Nasdaq-100 companies (our index lists); order: index weight", source: "Finnhub earnings calendar", sourceUrl: "https://finnhub.io/docs/api/earnings-calendar", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" });
}
