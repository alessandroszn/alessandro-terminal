// ECONOMIC CALENDAR
// World (approved T06): Forex Factory weekly export — USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, CNY;
//   title, time, impact (High/Medium/Low/Holiday), forecast and previous as published there.
//   The export has no actual values (→ N/A) and covers the current week only.
// US official schedules (approved T05):
//   BLS: https://www.bls.gov/schedule/news_release/bls.ics   (date + time ET, release name)
//   BEA: https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics
// Actual / previous need the FRED API (free key, not configured yet) → N/A.
// Forecast (consensus) and importance have no free licensed source → N/A. Nothing is estimated.
import { fetchText, cachedSource, iso, easternToUtc } from "./lib.mjs";

export const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
export const FF_PAGE = "https://www.forexfactory.com/calendar";
export const REGIONS = { USD: "United States", EUR: "Euro area", GBP: "United Kingdom", JPY: "Japan", CHF: "Switzerland", CAD: "Canada", AUD: "Australia", NZD: "New Zealand", CNY: "China", All: "Global" };
const IMPACTS = new Set(["High", "Medium", "Low", "Holiday"]);
const val = (v, note) => (v == null || String(v).trim() === "" ? { value: null, status: "N/A", note } : { value: String(v).trim(), status: "LIVE" });

// Forex Factory export → world events (UTC instant, ET date/time for consistency with the US schedules)
export function normalizeFF(list, now = Date.now()) {
  const out = [], seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    const t = Date.parse(e && e.date);
    if (!e || !e.title || !Number.isFinite(t) || !IMPACTS.has(e.impact)) continue;
    const k = `${e.country}|${e.title}|${t}`; if (seen.has(k)) continue; seen.add(k);
    const et = new Date(t).toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const mm = /(\d{4}-\d{2}-\d{2}),?\s*(\d{2}):(\d{2})/.exec(et);
    out.push({
      id: `FF-${k}`, datetime: new Date(t).toISOString(), dateET: mm ? mm[1] : null, timeET: mm ? `${mm[2] === "24" ? "00" : mm[2]}:${mm[3]}` : null,
      currency: e.country, country: e.country === "All" ? "ALL" : e.country, region: REGIONS[e.country] || e.country,
      indicator: String(e.title).trim(), impact: e.impact, released: t <= now,
      actual: { value: null, status: "N/A", note: "not in the Forex Factory export" },
      forecast: val(e.forecast, "no forecast published"), previous: val(e.previous, "no previous value published"),
      source: "FF", sourceName: "Forex Factory (weekly export)", sourceUrl: FF_PAGE,
    });
  }
  return out.sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
}

export async function getWorldCalendar(origin, ctx, now = Date.now()) {
  const r = await cachedSource({
    origin, key: "calendar/FF", ttlMs: 30 * 60_000, staleMaxMs: 3 * 86400_000, ctx, failTtlMs: 10 * 60_000,
    load: async () => {
      const f = await fetchText(FF_URL, { timeoutMs: 10000, headers: { accept: "application/json" } });
      if (f.err) return { err: f.err };
      let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
      return Array.isArray(j) && j.length ? { data: j } : { err: "no_data" };
    },
  });
  return { ...r, events: r.data ? normalizeFF(r.data, now) : [] };
}

export const CAL_SOURCES = [
  { id: "BLS", name: "U.S. Bureau of Labor Statistics", url: "https://www.bls.gov/schedule/news_release/bls.ics", page: "https://www.bls.gov/schedule/news_release/" },
  { id: "BEA", name: "U.S. Bureau of Economic Analysis", url: "https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics", page: "https://www.bea.gov/news/schedule" },
];

const unescapeIcs = (s) => String(s).replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

// ICS → [{uid, start (ISO UTC), dateET, timeET, title}]
export function parseIcs(text) {
  const lines = String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n"); // unfold
  const out = []; let ev = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { ev = {}; continue; }
    if (line === "END:VEVENT") { if (ev && ev.start && ev.title) out.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const head = line.slice(0, i), val = line.slice(i + 1), name = head.split(";")[0].toUpperCase();
    if (name === "SUMMARY") ev.title = unescapeIcs(val);
    else if (name === "UID") ev.uid = val.trim();
    else if (name === "DTSTART") {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(val.trim());
      if (!m) continue;
      const [y, mo, d] = [+m[1], +m[2], +m[3]];
      if (m[4] == null) { ev.start = null; ev.dateET = `${m[1]}-${m[2]}-${m[3]}`; ev.timeET = null; ev.start = iso(Date.UTC(y, mo - 1, d, 12)); ev.allDay = true; continue; }
      const t = m[7] ? Date.UTC(y, mo - 1, d, +m[4], +m[5]) : easternToUtc(y, mo, d, +m[4], +m[5]); // TZID=US-Eastern / America/New_York
      ev.start = iso(t);
      const et = new Date(t).toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const mm = /(\d{4}-\d{2}-\d{2}),?\s*(\d{2}):(\d{2})/.exec(et);
      ev.dateET = mm ? mm[1] : `${m[1]}-${m[2]}-${m[3]}`;
      ev.timeET = mm ? `${mm[2] === "24" ? "00" : mm[2]}:${mm[3]}` : null;
    }
  }
  return out;
}

const NA = (note) => ({ value: null, status: "N/A", note });
export function buildEvents(bySource, { now, pastDays = 7, futureDays = 35 }) {
  const lo = now - pastDays * 86400000, hi = now + futureDays * 86400000, seen = new Set(), events = [];
  for (const [src, list] of Object.entries(bySource)) {
    const meta = CAL_SOURCES.find((s) => s.id === src);
    for (const e of list) {
      const t = Date.parse(e.start);
      if (!(t >= lo && t <= hi)) continue;
      const k = e.title + "|" + e.start; if (seen.has(k)) continue; seen.add(k);
      events.push({
        id: e.uid || k, datetime: e.start, dateET: e.dateET, timeET: e.timeET, country: "US",
        indicator: e.title, source: src, sourceName: meta.name, sourceUrl: meta.page,
        released: t <= now,
        actual: NA("needs FRED API key (not configured)"),
        forecast: NA("no licensed consensus source"),
        previous: NA("needs FRED API key (not configured)"),
        importance: NA("no licensed importance rating"),
      });
    }
  }
  return events.sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
}

export async function getCalendar(origin, ctx, now = Date.now()) {
  const results = await Promise.all(CAL_SOURCES.map((s) => cachedSource({
    origin, key: `calendar/${s.id}`, ttlMs: 6 * 3600_000, staleMaxMs: 7 * 86400_000, ctx,
    load: async () => { const r = await fetchText(s.url, { headers: { accept: "text/calendar" } }); if (r.err) return { err: r.err }; const ev = parseIcs(r.text); return ev.length ? { data: ev } : { err: "no_data" }; },
  })));
  const bySource = {}, sources = [], errors = {};
  CAL_SOURCES.forEach((s, i) => {
    const r = results[i];
    if (r.data) { bySource[s.id] = r.data; sources.push({ id: s.id, name: s.name, url: s.page, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt), ...(r.staleReason ? { staleReason: r.staleReason } : {}) }); }
    else errors[s.id] = { error: r.err, status: "N/A" };
  });
  return { events: buildEvents(bySource, { now }), sources, errors, cache: results.map((x) => x.cache) };
}

export async function handleCalendar(url, env, ctx, H, json) {
  const now = Date.now();
  const [{ events, sources, errors, cache }, world] = await Promise.all([getCalendar(url.origin, ctx, now), getWorldCalendar(url.origin, ctx, now)]);
  if (world.data) sources.unshift({ id: "FF", name: "Forex Factory (weekly export)", url: FF_PAGE, status: world.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(world.fetchedAt), ...(world.staleReason ? { staleReason: world.staleReason } : {}) });
  else errors.FF = { error: world.err, status: "N/A" };
  const r = json({ world: world.events, events, sources, errors, fields: { actual: "N/A — not in the Forex Factory export; US: FRED key not configured", forecast: "Forex Factory (world); N/A for the US official schedules", impact: "Forex Factory (High / Medium / Low / Holiday)" }, meta: { generatedAt: iso(now) } }, H, sources.length ? 200 : 502);
  r.headers.set("cache-control", "no-store");
  r.headers.set("x-cache", cache.join(","));
  return r;
}
