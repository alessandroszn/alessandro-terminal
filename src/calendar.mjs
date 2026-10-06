// ECONOMIC CALENDAR — official release schedules only (approved T05):
//   BLS: https://www.bls.gov/schedule/news_release/bls.ics   (date + time ET, release name)
//   BEA: https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics
// Actual / previous need the FRED API (free key, not configured yet) → N/A.
// Forecast (consensus) and importance have no free licensed source → N/A. Nothing is estimated.
import { fetchText, cachedSource, iso, easternToUtc } from "./lib.mjs";

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
  const { events, sources, errors, cache } = await getCalendar(url.origin, ctx, now);
  const r = json({ events, sources, errors, fields: { actual: "N/A — FRED key not configured", previous: "N/A — FRED key not configured", forecast: "N/A — no licensed consensus source", importance: "N/A — no licensed source" }, meta: { generatedAt: iso(now) } }, H, sources.length ? 200 : 502);
  r.headers.set("cache-control", "no-store");
  r.headers.set("x-cache", cache.join(","));
  return r;
}
