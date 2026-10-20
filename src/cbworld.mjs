// CENTRAL BANKS COMPARED — policy rates of about 40 central banks as the Bank for International Settlements compiles them
// (dataset WS_CBPOL; daily and end-of-month series; the BIS publishes with a lag of about a week).
//   GET /api/cb/world               every bank: rate and its date, last move (effective date, size, level before),
//                                   change over 12 months, moves in 12 months, next scheduled decision (official calendars)
//   GET /api/cb/history?ids=US,XM   end-of-month policy rates since January 2006 for up to 12 banks
// Every value is the BIS figure with its date; nothing is filled in between publications. Approved 20 Oct 2026.
import { fetchText, cachedSource, iso } from "./lib.mjs";
import { CB_MEETINGS } from "./cbmeetings.mjs";

export const BIS_PAGE = "https://data.bis.org/topics/CBPOL";
export const bisDailyUrl = (start, areas = "") => `https://stats.bis.org/api/v1/data/WS_CBPOL/D.${areas}/all?startPeriod=${start}&detail=dataonly&format=csv`;
export const bisDailyRangeUrl = (area, start, end) => `https://stats.bis.org/api/v1/data/WS_CBPOL/D.${area}/all?startPeriod=${start}&endPeriod=${end}&detail=dataonly&format=csv`;
export const BIS_MONTHLY_URL = "https://stats.bis.org/api/v1/data/WS_CBPOL/M./all?startPeriod=2006-01&detail=dataonly&format=csv";

// BIS area → central bank, region, currency and the market yields used for "what the market prices" (see YLD, MARKET)
export const CB_AREAS = {
  US: ["Federal Reserve", "Americas", "USD", "US"], CA: ["Bank of Canada", "Americas", "CAD", "CA"], BR: ["Banco Central do Brasil", "Americas", "BRL", "BR"],
  MX: ["Banco de México", "Americas", "MXN", "MX"], CL: ["Banco Central de Chile", "Americas", "CLP", "CL"], CO: ["Banco de la República (Colombia)", "Americas", "COP", null],
  PE: ["Banco Central de Reserva del Perú", "Americas", "PEN", null], AR: ["Banco Central de la República Argentina", "Americas", "ARS", null],
  XM: ["European Central Bank", "Europe", "EUR", "DE"], GB: ["Bank of England", "Europe", "GBP", "UK"], CH: ["Swiss National Bank", "Europe", "CHF", "CH"],
  SE: ["Sveriges Riksbank", "Europe", "SEK", "SE"], NO: ["Norges Bank", "Europe", "NOK", null], DK: ["Danmarks Nationalbank", "Europe", "DKK", "DK"],
  PL: ["Narodowy Bank Polski", "Europe", "PLN", null], CZ: ["Czech National Bank", "Europe", "CZK", null], HU: ["Magyar Nemzeti Bank", "Europe", "HUF", "HU"],
  RO: ["National Bank of Romania", "Europe", "RON", null], RS: ["National Bank of Serbia", "Europe", "RSD", null], MK: ["National Bank of North Macedonia", "Europe", "MKD", null],
  IS: ["Central Bank of Iceland", "Europe", "ISK", null], HR: ["Croatian National Bank", "Europe", "HRK", null], RU: ["Bank of Russia", "Europe", "RUB", null],
  TR: ["Central Bank of the Republic of Türkiye", "Europe", "TRY", "TR"],
  JP: ["Bank of Japan", "Asia-Pacific", "JPY", "JP"], CN: ["People's Bank of China", "Asia-Pacific", "CNY", "CN"], AU: ["Reserve Bank of Australia", "Asia-Pacific", "AUD", "AU"],
  NZ: ["Reserve Bank of New Zealand", "Asia-Pacific", "NZD", "NZ"], KR: ["Bank of Korea", "Asia-Pacific", "KRW", "KR"], IN: ["Reserve Bank of India", "Asia-Pacific", "INR", "IN"],
  ID: ["Bank Indonesia", "Asia-Pacific", "IDR", "ID"], HK: ["Hong Kong Monetary Authority", "Asia-Pacific", "HKD", "HK"], MY: ["Bank Negara Malaysia", "Asia-Pacific", "MYR", null],
  TH: ["Bank of Thailand", "Asia-Pacific", "THB", "TH"], PH: ["Bangko Sentral ng Pilipinas", "Asia-Pacific", "PHP", null],
  ZA: ["South African Reserve Bank", "Middle East & Africa", "ZAR", "ZA"], IL: ["Bank of Israel", "Middle East & Africa", "ILS", null], SA: ["Saudi Central Bank", "Middle East & Africa", "SAR", null],
  KW: ["Central Bank of Kuwait", "Middle East & Africa", "KWD", null], MA: ["Bank Al-Maghrib", "Middle East & Africa", "MAD", null],
};
export const CB_ORDER = ["US", "XM", "GB", "JP", "CH", "CA", "AU", "NZ", "SE", "NO", "DK", ...Object.keys(CB_AREAS).filter((k) => !["US", "XM", "GB", "JP", "CH", "CA", "AU", "NZ", "SE", "NO", "DK"].includes(k))];
// what the BIS series is for the banks where it is not the bank's single published rate
export const CB_NOTE = { US: "mid-point of the FOMC target range", XM: "deposit facility rate" };

// BIS compact CSV (FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE) → { area: [[period, value], ...] } oldest first; "NaN" and empty cells are not values
export function parseBisCsv(text) {
  const t = String(text || ""), nl = t.indexOf("\n"); if (nl < 0) return {};
  const head = t.slice(0, nl).replace(/\r$/, "").split(",").map((x) => x.replace(/"/g, "").trim());
  const ia = head.indexOf("REF_AREA"), ip = head.indexOf("TIME_PERIOD"), iv = head.indexOf("OBS_VALUE");
  if (ia < 0 || ip < 0 || iv < 0) return {};
  const by = {};
  for (let i = nl + 1; i < t.length;) {
    let j = t.indexOf("\n", i); if (j < 0) j = t.length;
    const c = t.slice(i, j).replace(/\r$/, "").split(","); i = j + 1;
    const raw = (c[iv] || "").replace(/"/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(raw)) continue;
    const a = (c[ia] || "").replace(/"/g, ""), p = (c[ip] || "").replace(/"/g, "");
    if (a && p) (by[a] = by[a] || []).push([p, Number(raw)]);
  }
  for (const k of Object.keys(by)) { const s = by[k]; for (let x = 1; x < s.length; x++) if (s[x][0] < s[x - 1][0]) { s.sort((a, b) => (a[0] < b[0] ? -1 : 1)); break; } }
  return by;
}
const same = (a, b) => Math.abs(a - b) < 1e-9;
const bp = (a, b) => Math.round((a - b) * 10000) / 100;
// the latest level, the last move (first day the new level is published, size in bp, level before), the 12-month change and number of moves
export function summarize(daily, now = Date.now()) {
  if (!daily || !daily.length) return null;
  const last = daily[daily.length - 1], out = { date: last[0], value: last[1], move: null };
  for (let i = daily.length - 2; i >= 0; i--) if (!same(daily[i][1], last[1])) { out.move = { date: daily[i + 1][0], from: daily[i][1], bp: bp(last[1], daily[i][1]) }; break; }
  const t12 = Date.parse(last[0]) - 365 * 86400_000;
  let base = null; for (const x of daily) { if (Date.parse(x[0]) <= t12) base = x; else break; }
  if (base) { out.chg12 = { bp: bp(last[1], base[1]), from: base[1], date: base[0] }; let n = 0; for (let i = 1; i < daily.length; i++) if (Date.parse(daily[i][0]) > t12 && !same(daily[i][1], daily[i - 1][1])) n++; out.moves12 = n; }
  return out;
}
// the month of the last change in the end-of-month series (when the daily window shows none)
export function lastMonthlyChange(monthly) {
  for (let i = (monthly || []).length - 1; i > 0; i--) if (!same(monthly[i][1], monthly[i - 1][1])) return { month: monthly[i][0], from: monthly[i - 1][1] };
  return null;
}
const monthAdd = (ym, k) => { const [y, m] = ym.split("-").map(Number), d = new Date(Date.UTC(y, m - 1 + k, 1)); return d.toISOString().slice(0, 7); };
const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
// the next decision on or after today in the official calendar of each bank (the list is what the banks published)
export function nextMeeting(area, today) {
  const m = CB_MEETINGS[area]; if (!m) return null;
  const d = (m.dates || []).find((x) => x >= today);
  return d ? { date: d, time: m.time || null, source: m.source, url: m.url, checked: m.checked } : { date: null, source: m.source, url: m.url, checked: m.checked, note: "no later date in the calendar published by the bank" };
}

async function loadMonthly() {
  const f = await fetchText(BIS_MONTHLY_URL, { timeoutMs: 25000, headers: { accept: "text/csv" } });
  if (f.err) return { err: f.err };
  const by = parseBisCsv(f.text);
  return Object.keys(by).length ? { data: by } : { err: "no_data" };
}
const DAILY_DAYS = 420;
async function loadDaily(monthly, now) {
  const start = new Date(now - DAILY_DAYS * 86400_000).toISOString().slice(0, 10);
  const f = await fetchText(bisDailyUrl(start), { timeoutMs: 25000, headers: { accept: "text/csv" } });
  if (f.err) return { err: f.err };
  const by = parseBisCsv(f.text), rows = {};
  for (const [a, d] of Object.entries(by)) { const s = summarize(d, now); if (s) rows[a] = s; }
  if (!Object.keys(rows).length) return { err: "no_data" };
  // no move in the daily window: the month of the last change from the end-of-month series, then that month's daily data for the exact day
  const older = Object.keys(rows).filter((a) => !rows[a].move).slice(0, 12);
  await Promise.all(older.map(async (a) => {
    const lm = monthly && lastMonthlyChange(monthly[a]);
    if (!lm) { if (monthly && monthly[a] && monthly[a].length) rows[a].unchangedSince = monthly[a][0][0]; return; }
    const g = await fetchText(bisDailyRangeUrl(a, `${monthAdd(lm.month, -1)}-01`, monthEnd(monthAdd(lm.month, 1))), { timeoutMs: 15000, headers: { accept: "text/csv" } });
    const d = !g.err ? (parseBisCsv(g.text)[a] || []) : [];
    for (let i = d.length - 1; i > 0; i--) if (!same(d[i][1], d[i - 1][1]) && same(d[i][1], rows[a].value)) { rows[a].move = { date: d[i][0], from: d[i - 1][1], bp: bp(rows[a].value, d[i - 1][1]) }; break; }
    if (!rows[a].move) rows[a].move = { month: lm.month, from: lm.from, bp: bp(rows[a].value, lm.from) };
  }));
  return { data: rows };
}
const getMonthly = (origin, ctx) => cachedSource({ origin, key: "cbw/m1", ttlMs: 12 * 3600_000, staleMaxMs: 40 * 86400_000, failTtlMs: 15 * 60_000, ctx, load: loadMonthly });
// a policy rate older than this is shown as STALE (the BIS usually publishes about a week behind)
export const CB_FRESH_DAYS = 21;

export async function handleCbWorld(url, env, ctx, H, json) {
  const now = Date.now(), send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const today = new Date(now).toISOString().slice(0, 10);
  const src = { source: "BIS — central bank policy rates (WS_CBPOL)", sourceUrl: BIS_PAGE };
  if (url.pathname === "/api/cb/history") {
    const ids = [...new Set(String(url.searchParams.get("ids") || "").toUpperCase().split(",").map((x) => x.trim()).filter((x) => CB_AREAS[x]))].slice(0, 12);
    if (!ids.length) return send({ error: "bad_request", message: "ids: up to 12 of " + Object.keys(CB_AREAS).join(",") }, 400);
    const m = await getMonthly(url.origin, ctx);
    if (!m.data) return send({ status: "N/A", error: m.err, ...src }, 502);
    const series = {}; for (const id of ids) if (m.data[id]) series[id] = m.data[id];
    return send({ series, freq: "M", basis: "end-of-month policy rate as the BIS publishes it", ...src, status: m.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(m.fetchedAt) });
  }
  const m = await getMonthly(url.origin, ctx);
  const d = await cachedSource({ origin: url.origin, key: "cbw/d1", ttlMs: 6 * 3600_000, staleMaxMs: 20 * 86400_000, failTtlMs: 15 * 60_000, ctx, load: () => loadDaily(m.data || null, now) });
  const banks = CB_ORDER.map((id) => {
    const [name, region, ccy, mkt] = CB_AREAS[id], s = d.data && d.data[id], mm = m.data && m.data[id];
    const next = nextMeeting(id, today);
    if (!s) {
      // only the end-of-month series (a series the BIS stopped, e.g. Croatia after the euro): shown with its month, as STALE
      if (mm && mm.length) { const l = mm[mm.length - 1]; return { id, name, region, ccy, mkt, value: l[1], date: l[0], freq: "M", status: "STALE", note: "end-of-month series only (no recent daily data from the BIS)", next }; }
      return { id, name, region, ccy, mkt, status: "N/A", error: d.err || "no_data", next };
    }
    const age = (now - Date.parse(s.date)) / 86400_000;
    return { id, name, region, ccy, mkt, ...s, note: CB_NOTE[id] || null, status: age > CB_FRESH_DAYS ? "STALE" : d.cache === "STALE" ? "STALE" : "LIVE", next };
  });
  return send({ banks, ...src, meetings: "next decision: each bank's published calendar of monetary-policy decisions (checked on the date shown)", fetchedAt: d.fetchedAt ? iso(d.fetchedAt) : null, staleReason: d.staleReason || null, meta: { generatedAt: iso(now) } }, banks.some((b) => b.status !== "N/A") ? 200 : 502);
}
