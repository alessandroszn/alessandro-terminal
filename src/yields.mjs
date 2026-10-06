// YIELDS — official sources only (approved T05):
//   US: U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates (XML feed, CC0)
//   EA: European Central Bank Data Portal, euro area AAA government bond spot curve (dataset YC)
// No interpolation, no estimated points: a maturity the source does not publish is null → N/A.
import { fetchText, cachedSource, parseCsv, num, iso, easternDate, daysBetween } from "./lib.mjs";

export const TREASURY_TENORS = [
  ["BC_1MONTH", "1M", 1], ["BC_1_5MONTH", "1.5M", 1.5], ["BC_2MONTH", "2M", 2], ["BC_3MONTH", "3M", 3],
  ["BC_4MONTH", "4M", 4], ["BC_6MONTH", "6M", 6], ["BC_1YEAR", "1Y", 12], ["BC_2YEAR", "2Y", 24],
  ["BC_3YEAR", "3Y", 36], ["BC_5YEAR", "5Y", 60], ["BC_7YEAR", "7Y", 84], ["BC_10YEAR", "10Y", 120],
  ["BC_20YEAR", "20Y", 240], ["BC_30YEAR", "30Y", 360],
];
export const ECB_TENORS = [["3M", 3], ["6M", 6], ["1Y", 12], ["2Y", 24], ["3Y", 36], ["5Y", 60], ["7Y", 84], ["10Y", 120], ["15Y", 180], ["20Y", 240], ["30Y", 360]];

export const TREASURY_URL = (yyyymm) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}`;
export const ECB_URL = `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.${ECB_TENORS.map(([t]) => "SR_" + t).join("+")}?lastNObservations=2&format=csvdata`;

// Treasury OData XML → [{date, points:[{tenor, months, value}]}] oldest → newest
export function parseTreasuryXml(xml) {
  const rows = [];
  for (const m of String(xml).matchAll(/<m:properties>([\s\S]*?)<\/m:properties>/g)) {
    const p = m[1];
    const date = (p.match(/<d:NEW_DATE(?:\s[^>]*)?>(\d{4}-\d{2}-\d{2})/) || [])[1];
    if (!date) continue;
    const points = TREASURY_TENORS.map(([tag, tenor, months]) => {
      const v = (p.match(new RegExp(`<d:${tag}(?:\\s[^>]*)?>([^<]*)</d:${tag}>`)) || [])[1];
      return { tenor, months, value: num(v) };
    });
    if (points.some((x) => x.value != null)) rows.push({ date, points });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

// ECB csvdata → [{date, points}] oldest → newest (columns located by header name)
export function parseEcbCsv(text) {
  const rows = parseCsv(String(text));
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim());
  const iKey = h.indexOf("KEY"), iType = h.indexOf("DATA_TYPE_FM"), iT = h.indexOf("TIME_PERIOD"), iV = h.indexOf("OBS_VALUE");
  if (iT < 0 || iV < 0 || (iType < 0 && iKey < 0)) return [];
  const byDate = {};
  for (const r of rows.slice(1)) {
    const type = iType >= 0 ? r[iType] : String(r[iKey]).split(".").pop();
    const tenor = String(type || "").replace(/^SR_/, "");
    const def = ECB_TENORS.find(([t]) => t === tenor);
    const date = r[iT];
    if (!def || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) continue;
    (byDate[date] = byDate[date] || {})[tenor] = num(r[iV]);
  }
  return Object.keys(byDate).sort().map((date) => ({ date, points: ECB_TENORS.map(([tenor, months]) => ({ tenor, months, value: byDate[date][tenor] ?? null })) }));
}

// latest + previous publication → curve with daily change (bp, DERIVED from two real curves)
export function buildCurve(rows, { id, name, source, sourceUrl, kind, maxAgeDays, today, fetchedAt, cache, staleReason }) {
  const last = rows[rows.length - 1], prev = rows[rows.length - 2] || null;
  const age = daysBetween(last.date, today);
  const stale = cache === "STALE" || age > maxAgeDays;
  return {
    id, name, kind, source, sourceUrl,
    status: stale ? "STALE" : "LIVE",
    timestamp: last.date, previousDate: prev ? prev.date : null,
    fetchedAt: iso(fetchedAt),
    staleAt: iso(Date.parse(last.date + "T00:00:00Z") + (maxAgeDays + 1) * 86400000),
    ...(stale ? { staleReason: staleReason || "source_not_updated" } : {}),
    points: last.points.map((p) => {
      const pv = prev ? (prev.points.find((x) => x.tenor === p.tenor) || {}).value : null;
      return {
        tenor: p.tenor, months: p.months,
        value: p.value, status: p.value == null ? "N/A" : stale ? "STALE" : "LIVE",
        changeBp: p.value != null && pv != null ? Math.round((p.value - pv) * 1000) / 10 : null,
      };
    }),
  };
}

function monthKey(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }

async function loadTreasury(now) {
  const cur = new Date(now), prev = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1));
  const a = await fetchText(TREASURY_URL(monthKey(cur)));
  let rows = a.text ? parseTreasuryXml(a.text) : [];
  if (rows.length < 2) { // early in the month: add the previous month's publications
    const b = await fetchText(TREASURY_URL(monthKey(prev)));
    if (b.text) rows = parseTreasuryXml(b.text).concat(rows);
    else if (!rows.length) return { err: b.err || a.err };
  }
  if (!rows.length) return { err: a.err || "no_data" };
  return { data: rows.slice(-2) };
}
async function loadEcb() {
  const r = await fetchText(ECB_URL, { headers: { accept: "text/csv" } });
  if (r.err) return { err: r.err };
  const rows = parseEcbCsv(r.text);
  return rows.length ? { data: rows.slice(-2) } : { err: "no_data" };
}

export async function getYieldCurves(origin, ctx, now = Date.now()) {
  const today = easternDate(new Date(now));
  const curves = {}, errors = {};
  const [us, ea] = await Promise.all([
    cachedSource({ origin, key: "yields/us", ttlMs: 30 * 60_000, staleMaxMs: 7 * 86400_000, ctx, load: () => loadTreasury(now) }),
    cachedSource({ origin, key: "yields/ea", ttlMs: 30 * 60_000, staleMaxMs: 7 * 86400_000, ctx, load: () => loadEcb() }),
  ]);
  if (us.data) curves.US = buildCurve(us.data, { id: "US", name: "United States — Treasury par yield curve", kind: "par yield, end of day", source: "U.S. Department of the Treasury", sourceUrl: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve", maxAgeDays: 4, today, fetchedAt: us.fetchedAt, cache: us.cache, staleReason: us.staleReason });
  else errors.US = { error: us.err, status: "N/A" };
  if (ea.data) curves.EA = buildCurve(ea.data, { id: "EA", name: "Euro area — AAA government bonds spot curve", kind: "spot rate (Svensson), end of day", source: "European Central Bank", sourceUrl: "https://data.ecb.europa.eu/data/datasets/YC", maxAgeDays: 4, today, fetchedAt: ea.fetchedAt, cache: ea.cache, staleReason: ea.staleReason });
  else errors.EA = { error: ea.err, status: "N/A" };
  return { curves, errors, cache: [us.cache, ea.cache] };
}

export async function handleYields(url, env, ctx, H, json) {
  const now = Date.now();
  const { curves, errors, cache } = await getYieldCurves(url.origin, ctx, now);
  const status = Object.keys(curves).length ? 200 : 502;
  const r = json({ curves, errors, notConnected: ["Germany", "Italy", "France", "United Kingdom", "Japan", "Canada", "Australia"], meta: { generatedAt: iso(now) } }, H, status);
  r.headers.set("cache-control", "no-store");
  r.headers.set("x-cache", cache.join(","));
  return r;
}
