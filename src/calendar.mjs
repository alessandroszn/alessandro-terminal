// ECONOMIC CALENDAR
// World (approved T06): Forex Factory weekly export — USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, CNY;
//   title, time, impact (High/Medium/Low/Holiday), forecast and previous as published there.
//   The export has no actual values (→ N/A) and covers the current week only.
// US official schedules (approved T05):
//   BLS: https://www.bls.gov/schedule/news_release/bls.ics   (date + time ET, release name)
//   BEA: https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics
// Actual / previous need the FRED API (free key, not configured yet) → N/A.
// Forecast (consensus) and importance have no free licensed source → N/A. Nothing is estimated.
import { fetchText, cachedSource, cacheRead, cacheWrite, iso, easternToUtc } from "./lib.mjs";

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

// ---------- archive of the weekly exports (Workers KV): past days across the week boundary, history of an event ----------
// Forex Factory weeks run Sunday → Saturday (New York). Each export is kept as published (forecast, previous).
export function ffWeekKey(list) {
  const ts = (Array.isArray(list) ? list : []).map((e) => Date.parse(e && e.date)).filter(Number.isFinite);
  if (!ts.length) return null;
  const et = new Date(Math.min(...ts)).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const d = new Date(et + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
export async function archiveFF(env, raw) {
  const wk = ffWeekKey(raw);
  if (!wk || !env.BRIEFS) return null;
  await env.BRIEFS.put(`cal/ff/${wk}`, JSON.stringify(raw), { expirationTtl: 400 * 86400 });
  return wk;
}
const prevWeek = (wk) => { const d = new Date(wk + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10); };
export const BACK_DAYS = 4;

export async function handleCalendar(url, env, ctx, H, json) {
  const now = Date.now();
  const [{ events, sources, errors, cache }, world] = await Promise.all([getCalendar(url.origin, ctx, now), getWorldCalendar(url.origin, ctx, now)]);
  if (world.data) sources.unshift({ id: "FF", name: "Forex Factory (weekly export)", url: FF_PAGE, status: world.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(world.fetchedAt), ...(world.staleReason ? { staleReason: world.staleReason } : {}) });
  else errors.FF = { error: world.err, status: "N/A" };
  // keep every fresh export; add the last days of the previous week from the archive
  let past = [];
  if (env.BRIEFS && world.data) {
    if (world.cache === "MISS") ctx.waitUntil(archiveFF(env, world.data).catch(() => null));
    const wk = ffWeekKey(world.data);
    if (wk) {
      try { const t = await env.BRIEFS.get(`cal/ff/${prevWeek(wk)}`); if (t) past = normalizeFF(JSON.parse(t), now).filter((e) => Date.parse(e.datetime) >= now - BACK_DAYS * 86400_000).map((e) => ({ ...e, archived: true })); } catch { /* no archive yet */ }
    }
  }
  const r = json({ world: [...past, ...world.events], backDays: BACK_DAYS, events, sources, errors, fields: { actual: "N/A — not in the Forex Factory export; US: FRED key not configured", forecast: "Forex Factory (world); N/A for the US official schedules", impact: "Forex Factory (High / Medium / Low / Holiday)", reaction: "price move after the scheduled time, from 1-minute data (Twelve Data FX, Alpaca SPY/TLT) — DERIVED" }, meta: { generatedAt: iso(now) } }, H, sources.length ? 200 : 502);
  r.headers.set("cache-control", "no-store");
  return r;
}

// ---------- past releases of one event (from the archive): forecast and previous as published each week ----------
export async function handleCalendarHistory(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const ccy = String(url.searchParams.get("ccy") || ""), title = String(url.searchParams.get("title") || "").trim();
  if (!/^[A-Za-z]{3}$/.test(ccy) || !title || title.length > 120) return send({ error: "bad_request" }, 400);
  if (!env.BRIEFS) return send({ error: "storage_not_configured", status: "N/A" }, 503);
  const out = [];
  let cursor;
  do {
    const l = await env.BRIEFS.list({ prefix: "cal/ff/", cursor });
    for (const k of l.keys) {
      const t = await env.BRIEFS.get(k.name); if (!t) continue;
      let list; try { list = JSON.parse(t); } catch { continue; }
      for (const e of list) if (e && e.country === ccy && String(e.title).trim() === title && Number.isFinite(Date.parse(e.date)))
        out.push({ datetime: new Date(Date.parse(e.date)).toISOString(), forecast: e.forecast || null, previous: e.previous || null, week: k.name.slice(7) });
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  const seen = new Set(), rows = out.sort((a, b) => (a.datetime < b.datetime ? 1 : -1)).filter((x) => (seen.has(x.datetime) ? false : seen.add(x.datetime)));
  return send({ ccy, title, releases: rows, note: "Forecast and previous as published by Forex Factory in each weekly export since the archive started; a release's actual appears as 'previous' at the next release (it may include revisions).", source: "Forex Factory weekly exports, archived by this terminal", status: rows.length ? "LIVE" : "N/A" });
}

// ---------- market reaction after a release: 1-minute prices just before vs 15 / 60 minutes after the scheduled time ----------
// FX: Twelve Data 1-minute series (1 credit per event, computed once and kept). USD events also: SPY and TLT from
// Alpaca 1-minute bars (free; only while those ETFs trade, 04:00–20:00 New York). Speeches have no number: the move
// is measured from the scheduled time all the same.
export const REACT_PAIR = { EUR: ["EUR/USD", false], GBP: ["GBP/USD", false], AUD: ["AUD/USD", false], NZD: ["NZD/USD", false], JPY: ["USD/JPY", true], CHF: ["USD/CHF", true], CAD: ["USD/CAD", true], CNY: ["USD/CNH", true], USD: ["EUR/USD", true] };
export function reactionFrom(points, ts) {
  const pts = points.filter((p) => Number.isFinite(p[0]) && p[1] > 0).sort((a, b) => a[0] - b[0]);
  const last = (lim) => { let r = null; for (const p of pts) if (p[0] <= lim) r = p; else break; return r; };
  const p0 = last(ts - 60_000);
  if (!p0 || ts - p0[0] > 10 * 60_000) return null; // no price just before the time
  const out = { before: p0[1] };
  for (const m of [15, 60]) { const p = last(ts + (m - 1) * 60_000); if (p && p[0] >= ts + (m - 6) * 60_000) out[`m${m}`] = { price: p[1], chg: (p[1] / p0[1] - 1) * 100 }; }
  return out.m15 ? out : null;
}
const inv = (r) => (r ? { ...r, m15: r.m15 && { ...r.m15, chg: (100 / (1 + r.m15.chg / 100)) - 100 }, m60: r.m60 && { ...r.m60, chg: (100 / (1 + r.m60.chg / 100)) - 100 } } : null);
const tdTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
async function tdMinutes(env, symbol, from, to) {
  const qs = new URLSearchParams({ symbol, interval: "1min", start_date: tdTime(from), end_date: tdTime(to), timezone: "UTC", order: "ASC", outputsize: "200" });
  const f = await fetchText(`https://api.twelvedata.com/time_series?${qs}`, { timeoutMs: 10000, headers: { authorization: `apikey ${env.TWELVEDATA_KEY}` } });
  if (f.err) return { err: f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  if (j.status === "error") return { err: j.code === 429 ? "rate_limited" : j.code === 400 ? "no_data" : "provider_error" };
  return { data: (j.values || []).map((v) => [Date.parse(v.datetime.replace(" ", "T") + "Z"), Number(v.close)]) };
}
async function alpacaMinutes(env, symbols, from, to) {
  const qs = new URLSearchParams({ symbols: symbols.join(","), timeframe: "1Min", start: new Date(from).toISOString(), end: new Date(to).toISOString(), feed: "sip", adjustment: "raw", limit: "1000" });
  const f = await fetchText(`https://data.alpaca.markets/v2/stocks/bars?${qs}`, { timeoutMs: 10000, headers: { "APCA-API-KEY-ID": env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY, accept: "application/json" } });
  if (f.err) return { err: f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  return { data: Object.fromEntries(Object.entries(j.bars || {}).map(([s, b]) => [s, (b || []).map((x) => [Date.parse(x.t), x.c])])) };
}
export const reactKey = (e) => `cal/react/${e.currency}/${Date.parse(e.datetime)}/${String(e.indicator).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
export async function computeReaction(env, e, now) {
  const ts = Date.parse(e.datetime), from = ts - 6 * 60_000, to = ts + 61 * 60_000, out = { id: e.id, at: iso(now), items: [] };
  const pair = REACT_PAIR[e.currency];
  if (pair && env.TWELVEDATA_KEY) {
    const m = await tdMinutes(env, pair[0], from, Math.min(to, now));
    if (m.data) { const r = reactionFrom(m.data, ts); if (r) out.items.push({ symbol: e.currency === "USD" ? "USD vs EUR" : `${e.currency} vs USD`, pair: pair[0], source: "Twelve Data 1-min", ...(pair[1] ? inv(r) : r) }); }
    else out.fxError = m.err;
  }
  if (e.currency === "USD" && env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY && now - 16 * 60_000 > ts) {
    const a = await alpacaMinutes(env, ["SPY", "TLT"], from, Math.min(to, now - 16 * 60_000));
    if (a.data) for (const s of ["SPY", "TLT"]) { const r = a.data[s] && reactionFrom(a.data[s], ts); if (r) out.items.push({ symbol: s, source: "Alpaca 1-min (SIP)", ...r }); }
  }
  out.final = now >= ts + 77 * 60_000; // both windows complete for every source (Alpaca is 15 minutes behind)
  return out;
}
const MAX_NEW = 3; // reactions computed per request (credits and CPU): the page asks again for the rest
export async function handleCalendarReactions(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "storage_not_configured", status: "N/A" }, 503);
  const now = Date.now(), world = await getWorldCalendar(url.origin, ctx, now);
  let past = [];
  const wk = world.data ? ffWeekKey(world.data) : null;
  if (wk) { try { const t = await env.BRIEFS.get(`cal/ff/${prevWeek(wk)}`); if (t) past = normalizeFF(JSON.parse(t), now); } catch { /* none */ } }
  const due = [...past, ...world.events].filter((e) => e.impact === "High" && REACT_PAIR[e.currency] && Date.parse(e.datetime) <= now - 16 * 60_000 && Date.parse(e.datetime) >= now - BACK_DAYS * 86400_000);
  const reactions = {}; let computed = 0, pending = 0;
  for (const e of due) {
    const key = reactKey(e);
    let r = null; try { const t = await env.BRIEFS.get(key); r = t ? JSON.parse(t) : null; } catch { r = null; }
    if (r && (r.final || now - Date.parse(r.at) < 10 * 60_000)) { reactions[e.id] = r; continue; }
    if (computed >= MAX_NEW) { pending++; if (r) reactions[e.id] = r; continue; }
    computed++;
    r = await computeReaction(env, e, now);
    reactions[e.id] = r;
    ctx.waitUntil(env.BRIEFS.put(key, JSON.stringify(r), { expirationTtl: 120 * 86400 }));
  }
  return send({ reactions, pending, events: due.length, basis: "price just before the scheduled time vs 15 and 60 minutes after; FX: Twelve Data 1-min; USD events also SPY / TLT (Alpaca, ETFs) — DERIVED", status: "DERIVED" });
}
