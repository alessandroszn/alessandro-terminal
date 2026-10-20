// SHORT INTEREST — FINRA (approved 21 Oct 2026), no key:
//  · consolidated short interest (FINRA's Query API, dataset otcMarket/consolidatedShortInterest): shares sold short in every
//    U.S. exchange-listed and OTC stock as of a settlement date (twice a month), published about 8 business days later, with
//    the previous figure, average daily volume and days to cover as FINRA computes them;
//  · daily short sale volume (Reg SHO files on cdn.finra.org): short volume and total volume reported to FINRA's facilities
//    for each trading day — a share of the volume FINRA sees, not of the whole market.
//   GET /api/finra/shorts            the largest short positions of the latest settlement date (exchange-listed, top 2,500)
//   GET /api/finra/symbol?sym=AAPL   one stock: short interest over the last year, short volume of the last 5 sessions
import { cachedSource, iso } from "./lib.mjs";

const UA = "AlessandroTerminal/1.0 (+https://alessandrozanichelli.com/terminal)";
export const FINRA_SI = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest";
export const FINRA_SHVOL = (d) => `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${String(d).replace(/-/g, "")}.txt`;
export const FINRA_PAGE = "https://www.finra.org/finra-data/browse-catalog/equity-short-interest";
const SRC = { source: "FINRA", sourceUrl: FINRA_PAGE };
const FIELDS = ["symbolCode", "issueName", "marketClassCode", "currentShortPositionQuantity", "previousShortPositionQuantity", "averageDailyVolumeQuantity", "daysToCoverQuantity", "changePercent", "settlementDate"];
const DAY = 86400_000;
// FINRA writes 999.99 days to cover when it is undefined (no average volume): a code, not a value
const DAYS_UNDEFINED = 99999 / 100;
const n = (v) => { const x = Number(v); return v == null || v === "" || !Number.isFinite(x) ? null : x; };
// OTC securities are left out of the market-wide list (exchange-listed only)
export const isListed = (m) => !!m && !/^(OTC|PINX|OTCBB|OTHER|U)$/i.test(String(m));

// a query with a field list is retried once without it (the full rows), should FINRA refuse the list
async function finraQuery(body, fetchImpl = fetch) {
  const r = await finraQuery1(body, fetchImpl);
  if (r.err && body.fields && r.err !== "provider_timeout" && r.err !== "provider_unreachable") { const { fields, ...rest } = body; const r2 = await finraQuery1(rest, fetchImpl); return r2.err ? { ...r2, detail: r2.detail || r.detail } : r2; }
  return r;
}
async function finraQuery1(body, fetchImpl = fetch) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetchImpl(FINRA_SI, { method: "POST", signal: ac.signal, headers: { "user-agent": UA, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    const t = await r.text();
    if (r.status === 429) return { err: "rate_limited" };
    // FINRA's own reason, shortened (it names the field or filter it refused)
    const why = () => String(t || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
    if (!r.ok) return { err: r.status === 404 ? "no_data" : "provider_error", http: r.status, detail: why() };
    let j; try { j = JSON.parse(t); } catch { return { err: "provider_error", detail: why() }; }
    return Array.isArray(j) ? { data: j } : { err: "provider_error", detail: why() };
  } catch { return { err: ac.signal.aborted ? "provider_timeout" : "provider_unreachable" }; } finally { clearTimeout(timer); }
}
// FINRA row → [sym, name, short, previous short, change %, avg daily volume, days to cover, market]
export function compactSi(r) {
  const days = n(r.daysToCoverQuantity);
  return [String(r.symbolCode || "").trim(), String(r.issueName || "").trim(), n(r.currentShortPositionQuantity), n(r.previousShortPositionQuantity), n(r.changePercent), n(r.averageDailyVolumeQuantity), days === DAYS_UNDEFINED ? null : days, r.marketClassCode || null];
}
// one line of a Reg SHO daily file for one symbol: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
export function shvolLine(text, date, sym) {
  const key = `\n${String(date).replace(/-/g, "")}|${sym}|`, i = String(text).indexOf(key);
  if (i < 0) return null;
  const e = text.indexOf("\n", i + 1), line = text.slice(i + 1, e < 0 ? undefined : e).trim().split("|");
  const short = n(line[2]), exempt = n(line[3]), total = n(line[4]);
  return short == null || !total ? null : { date, short: Math.round(short), exempt: exempt == null ? null : Math.round(exempt), total: Math.round(total), pct: Math.round(short / total * 10000) / 100, markets: line[5] || null };
}
// FINRA's settlement dates fall in the middle and at the end of each month (the 15th and the last business day, or the
// weekday before when that is a weekend or holiday). FINRA sorts only within one settlement date, so the latest published
// one is found by asking candidate dates, newest first: each half-month boundary and up to 3 weekdays before it.
export function settlementCandidates(now, months = 2) {
  const out = [], d0 = new Date(now), wk = (t) => { const d = new Date(t); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1); return d; };
  for (let m = 0; m <= months; m++) {
    const y = d0.getUTCFullYear(), mo = d0.getUTCMonth() - m;
    for (const base of [new Date(Date.UTC(y, mo + 1, 0)), new Date(Date.UTC(y, mo, 15))]) {
      let d = wk(base);
      for (let k = 0; k < 4; k++) { if (d.getTime() <= now) out.push(d.toISOString().slice(0, 10)); d = wk(new Date(d.getTime() - DAY)); }
    }
  }
  return [...new Set(out)].sort().reverse();
}
// weekdays before `now` (New York date), newest first
export function recentWeekdays(now, count) {
  const out = []; let t = Date.parse(new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + "T12:00:00Z");
  while (out.length < count) { const d = new Date(t), wd = d.getUTCDay(); if (wd && wd !== 6) out.push(d.toISOString().slice(0, 10)); t -= DAY; }
  return out;
}
// the daily files are kept as text in the Worker's cache (immutable once published; a missing day is remembered 1 hour)
async function shvolFile(origin, date, fetchImpl = fetch) {
  const c = typeof caches !== "undefined" ? caches.default : null, key = new Request(`${origin}/__cache/finra/shvol/${date}`);
  if (c) { const hit = await c.match(key); if (hit) { const t = await hit.text(); return t === "-" ? null : t; } }
  let text = null;
  try { const r = await fetchImpl(FINRA_SHVOL(date), { headers: { "user-agent": UA, accept: "text/plain" } }); if (r.ok) { const t = await r.text(); if (/^Date\|Symbol\|ShortVolume/.test(t)) text = t; } } catch { text = null; }
  if (c) await c.put(key, new Response(text || "-", { headers: { "cache-control": `public, max-age=${text ? 7 * 86400 : 3600}` } }));
  return text;
}

export async function handleFinra(url, env, ctx, H, json, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const f = deps.fetch || fetch, now = deps.now || Date.now(), p = url.pathname;
  if (p === "/api/finra/shorts") {
    let detail = null; const steps = [];
    const r = await cachedSource({ origin: url.origin, key: "finra/si/top5", ttlMs: 12 * 3600_000, staleMaxMs: 20 * DAY, failTtlMs: 60_000, ctx, load: async () => {
      let date = null;
      for (const c of settlementCandidates(now).slice(0, 10)) {
        const one = await finraQuery({ limit: 1, fields: ["settlementDate"], compareFilters: [{ compareType: "EQUAL", fieldName: "settlementDate", fieldValue: c }] }, f);
        steps.push(`${c}:${one.err ? one.err + (one.http ? " " + one.http : "") : one.data.length}`);
        if (one.err) { detail = one.detail || null; return { err: one.err }; }
        if (one.data.length) { date = c; break; }
      }
      if (!date) return { err: "no_data" };
      const q = await finraQuery({ limit: 2500, fields: FIELDS, sortFields: ["-currentShortPositionQuantity"], compareFilters: [{ compareType: "EQUAL", fieldName: "settlementDate", fieldValue: date }] }, f);
      steps.push(`top:${q.err ? q.err + (q.http ? " " + q.http : "") : q.data.length}`);
      if (q.err) { detail = q.detail || null; return { err: q.err }; }
      const rows = q.data.map(compactSi).filter((x) => x[0] && x[2] != null && isListed(x[7]));
      return rows.length ? { data: { date, rows } } : { err: "no_data" };
    } });
    if (!r.data) return send({ status: "N/A", error: r.err, ...(detail ? { detail } : {}), ...(steps.length ? { steps } : {}), ...SRC }, 502);
    return send({ settlementDate: r.data.date, cols: ["symbol", "name", "shortInterest", "previous", "changePct", "avgDailyVolume", "daysToCover", "market"], rows: r.data.rows, ...SRC,
      basis: "FINRA consolidated short interest: shares short as of the settlement date (reported by brokers, published about 8 business days later), the previous settlement's figure, FINRA's average daily volume and days to cover; exchange-listed securities, the 2,500 largest positions", status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) });
  }
  if (p === "/api/finra/symbol") {
    const sym = String(url.searchParams.get("sym") || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) return send({ error: "bad_request", message: "a U.S. ticker" }, 400);
    let detail = null;
    const si = await cachedSource({ origin: url.origin, key: `finra/si/sym4/${sym}`, ttlMs: 12 * 3600_000, staleMaxMs: 20 * DAY, failTtlMs: 15 * 60_000, ctx, load: async () => {
      // the dataset goes back years: the last 13 months only (FINRA sorts only within one date, so the rows are sorted here)
      const from = new Date(now - 400 * DAY).toISOString().slice(0, 10), to = new Date(now).toISOString().slice(0, 10);
      const q = await finraQuery({ limit: 40, fields: FIELDS, compareFilters: [{ compareType: "EQUAL", fieldName: "symbolCode", fieldValue: sym }], dateRangeFilters: [{ fieldName: "settlementDate", startDate: from, endDate: to }] }, f);
      if (q.err) { detail = q.detail || null; return { err: q.err }; }
      const rows = q.data.slice().sort((a, b) => (String(a.settlementDate) < String(b.settlementDate) ? 1 : -1)).map((x) => ({ date: String(x.settlementDate || "").slice(0, 10), short: n(x.currentShortPositionQuantity), previous: n(x.previousShortPositionQuantity), changePct: n(x.changePercent), adv: n(x.averageDailyVolumeQuantity), days: n(x.daysToCoverQuantity) === DAYS_UNDEFINED ? null : n(x.daysToCoverQuantity) })).filter((x) => x.date && x.short != null);
      return rows.length ? { data: rows } : { err: "no_data" };
    } });
    // short sale volume: the last 5 published sessions among the last 8 weekdays (a day not yet published is skipped)
    const days = recentWeekdays(now, 8), vol = [];
    for (const d of days) { if (vol.length >= 5) break; const t = await shvolFile(url.origin, d, f); if (!t) continue; const x = shvolLine(t, d, sym); if (x) vol.push(x); }
    return send({ sym, shortInterest: si.data || [], shortInterestError: si.data ? null : si.err, ...(detail ? { shortInterestDetail: detail } : {}), shortVolume: vol, ...SRC,
      basis: "short interest: FINRA consolidated short interest (settlement dates); short volume: FINRA Reg SHO daily files — short sales reported to FINRA's trade reporting facilities as a share of the volume reported there, not of all exchanges' volume",
      status: si.data || vol.length ? (si.cache === "STALE" ? "STALE" : "LIVE") : "N/A" }, si.data || vol.length ? 200 : 502);
  }
  return send({ error: "not_found" }, 404);
}
