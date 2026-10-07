// YIELDS — official sources only (approved T05, more countries 7 Oct 2026):
//   US: U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates (XML feed, CC0);
//       with FRED_KEY: Treasury constant maturities from FRED (Federal Reserve H.15)
//   EA: European Central Bank Data Portal, euro area AAA government bond spot curve (dataset YC)
//   DE: Deutsche Bundesbank · UK: Bank of England · JP: Ministry of Finance · CH: Swiss National Bank · CA: Bank of Canada
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
        tenor: p.tenor, months: p.months, ...(p.note ? { note: p.note } : {}),
        value: p.value, status: p.value == null ? "N/A" : stale ? "STALE" : "LIVE",
        changeBp: p.value != null && pv != null ? Math.round((p.value - pv) * 1000) / 10 : null,
      };
    }),
  };
}

function monthKey(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }

const TREASURY_HEADERS = { accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.8" };
async function loadTreasury(now) {
  const cur = new Date(now), prev = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1));
  const a = await fetchText(TREASURY_URL(monthKey(cur)), { headers: TREASURY_HEADERS, timeoutMs: 15000 });
  if (a.err === "provider_timeout") return { err: a.err };
  const b = await fetchText(TREASURY_URL(monthKey(prev)), { headers: TREASURY_HEADERS, timeoutMs: 15000 });
  const rows = (b.text ? parseTreasuryXml(b.text) : []).concat(a.text ? parseTreasuryXml(a.text) : []);
  return rows.length ? { data: rows.slice(-30) } : { err: a.err || b.err || "no_data" };
}
async function loadEcb() {
  const r = await fetchText(ECB_URL.replace("lastNObservations=2", "lastNObservations=30") + "&detail=dataonly", { headers: { accept: "text/csv" }, timeoutMs: 25000 });
  if (r.err) return { err: r.err };
  const rows = parseEcbCsv(r.text);
  return rows.length ? { data: rows.slice(-30) } : { err: "no_data" };
}

// ---------- more countries (official publications; approved 7 Oct 2026) ----------
// a published value or nothing: an empty cell or "." is missing, never zero
const numOrNull = (v) => { const t = String(v == null ? "" : v).trim(); if (!t || t === "." || t === "-" || t === "ND") return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const isoDaysAgo = (now, n) => new Date(now - n * 86400_000).toISOString().slice(0, 10);
const rowsFrom = (byDate, tenors) => Object.keys(byDate).sort().map((date) => ({ date, points: tenors.map(([tenor, months]) => ({ tenor, months, value: byDate[date][tenor] ?? null, ...(byDate[date]["note:" + tenor] ? { note: byDate[date]["note:" + tenor] } : {}) })) })).filter((r) => r.points.some((p) => p.value != null));

// Germany — Deutsche Bundesbank: yields on listed Federal securities from the term structure (daily)
export const DE_TENORS = [["R01XX", "1Y", 12], ["R02XX", "2Y", 24], ["R03XX", "3Y", 36], ["R05XX", "5Y", 60], ["R07XX", "7Y", 84], ["R10XX", "10Y", 120], ["R15XX", "15Y", 180], ["R20XX", "20Y", 240], ["R30XX", "30Y", 360]];
export const DE_URL = `https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZAR.ZI.EUR.S1311.B.A604.${DE_TENORS.map(([c]) => c).join("+")}.R.A.A._Z._Z.A?format=csv&lastNObservations=30`;
export function parseBundesbank(text) {
  const rows = parseCsv(String(text || ""));
  if (!rows.length) return [];
  const cols = rows[0].map((h) => { const m = /\.(R\d\dXX)\.R\.A\.A\._Z\._Z\.A$/.exec(h.trim()); const d = m && DE_TENORS.find(([c]) => c === m[1]); return d ? d[1] : null; });
  const byDate = {};
  for (const r of rows.slice(1)) { if (!/^\d{4}-\d{2}-\d{2}$/.test((r[0] || "").trim())) continue; const o = (byDate[r[0].trim()] = {}); cols.forEach((t, i) => { if (t) { const v = numOrNull(r[i]); if (v != null) o[t] = v; } }); }
  return rowsFrom(byDate, DE_TENORS.map(([, t, m]) => [t, m]));
}
// United Kingdom — Bank of England: nominal par yields on gilts (fitted curve; 5, 10 and 20 years published daily)
export const UK_SERIES = [["IUDSNPY", "5Y", 60], ["IUDMNPY", "10Y", 120], ["IUDLNPY", "20Y", 240]];
const BOE_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ukUrl = (now) => { const d = new Date(now - 50 * 86400_000); return `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${String(d.getUTCDate()).padStart(2, "0")}/${BOE_MON[d.getUTCMonth()]}/${d.getUTCFullYear()}&Dateto=now&SeriesCodes=${UK_SERIES.map(([c]) => c).join(",")}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`; };
export function parseBoeYields(text) {
  const rows = parseCsv(String(text || ""));
  if (!rows.length) return [];
  const h = rows[0].map((x) => x.trim()), byDate = {};
  for (const r of rows.slice(1)) {
    const m = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec((r[0] || "").trim()); if (!m || BOE_MON.indexOf(m[2]) < 0) continue;
    const date = `${m[3]}-${String(BOE_MON.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1]}`, o = (byDate[date] = {});
    UK_SERIES.forEach(([code, t]) => { const i = h.indexOf(code); const v = i >= 0 ? numOrNull(r[i]) : null; if (v != null) o[t] = v; });
  }
  return rowsFrom(byDate, UK_SERIES.map(([, t, m]) => [t, m]));
}
// Japan — Ministry of Finance: JGB interest rates (current month file, daily)
export const JP_URL = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv";
export const JP_TENORS = [["1Y", 12], ["2Y", 24], ["3Y", 36], ["5Y", 60], ["7Y", 84], ["10Y", 120], ["15Y", 180], ["20Y", 240], ["30Y", 360], ["40Y", 480]];
export function parseMof(text) {
  const rows = parseCsv(String(text || "")), hi = rows.findIndex((r) => (r[0] || "").trim() === "Date");
  if (hi < 0) return [];
  const h = rows[hi].map((x) => x.trim()), byDate = {};
  for (const r of rows.slice(hi + 1)) {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((r[0] || "").trim()); if (!m) continue;
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, o = (byDate[date] = {});
    JP_TENORS.forEach(([t]) => { const i = h.indexOf(t); const v = i >= 0 ? numOrNull(r[i]) : null; if (v != null) o[t] = v; });
  }
  return rowsFrom(byDate, JP_TENORS);
}
// Switzerland — SNB: yields of individual Confederation bonds; each maturity = the bond whose residual maturity is closest
export const CH_TENORS = [["2Y", 24], ["5Y", 60], ["10Y", 120], ["20Y", 240], ["30Y", 360]];
export const chUrl = (now) => `https://data.snb.ch/api/cube/rendoeid/data/csv/en?fromDate=${isoDaysAgo(now, 45)}`;
export function parseSnbBonds(text) {
  const bonds = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const c = line.split(";").map((x) => x.replace(/^"|"$/g, "").trim());
    if (c.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(c[0])) continue;
    const v = numOrNull(c[3]); if (v == null) continue;
    const d = (bonds[c[0]] = bonds[c[0]] || {}), b = (d[c[1]] = d[c[1]] || {});
    if (c[2] === "R1") b.y = v; else if (c[2] === "LZ") b.lz = v;
  }
  const byDate = {};
  for (const [date, list] of Object.entries(bonds)) {
    const o = (byDate[date] = {});
    for (const [t, months] of CH_TENORS) {
      const T = months / 12, tol = Math.max(3 / 4, T / 5);
      const best = Object.entries(list).filter(([, b]) => b.y != null && b.lz != null && Math.abs(b.lz - T) <= tol).sort((a, b) => Math.abs(a[1].lz - T) - Math.abs(b[1].lz - T))[0];
      if (best) { o[t] = best[1].y; o["note:" + t] = `Confederation bond ${best[0]}, ${best[1].lz.toFixed(1)} years to maturity`; }
    }
  }
  return rowsFrom(byDate, CH_TENORS);
}
// Canada — Bank of Canada Valet: Government of Canada benchmark bond yields (daily)
export const CA_URL = "https://www.bankofcanada.ca/valet/observations/group/bond_yields_benchmark/json?recent=30";
export const CA_SERIES = [["BD.CDN.2YR.DQ.YLD", "2Y", 24], ["BD.CDN.3YR.DQ.YLD", "3Y", 36], ["BD.CDN.5YR.DQ.YLD", "5Y", 60], ["BD.CDN.7YR.DQ.YLD", "7Y", 84], ["BD.CDN.10YR.DQ.YLD", "10Y", 120], ["BD.CDN.LONG.DQ.YLD", "LONG", 360]];
export function parseBocBonds(j) {
  const byDate = {};
  for (const o of (j && Array.isArray(j.observations) ? j.observations : [])) { if (!/^\d{4}-\d{2}-\d{2}$/.test(o.d || "")) continue; const x = (byDate[o.d] = {}); CA_SERIES.forEach(([k, t]) => { const v = numOrNull(o[k] && o[k].v); if (v != null) x[t] = v; }); }
  return rowsFrom(byDate, CA_SERIES.map(([, t, m]) => [t, m]));
}
// FRED (Federal Reserve Bank of St. Louis; free key FRED_KEY). FRED accepts the key only as a URL parameter: it travels
// only in the Worker's request to api.stlouisfed.org and is never logged or returned.
export const fredUrl = (id, key, limit = 30) => `https://api.stlouisfed.org/fred/series/observations?${new URLSearchParams({ series_id: id, api_key: key, file_type: "json", sort_order: "desc", limit: String(limit) })}`;
export function parseFred(j) { return (j && Array.isArray(j.observations) ? j.observations : []).map((o) => [o.date, numOrNull(o.value)]).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && v != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
export async function fredSeries(env, id, limit = 30) {
  if (!env || !env.FRED_KEY) return { err: "fred_not_configured" };
  const f = await fetchText(fredUrl(id, env.FRED_KEY, limit), { timeoutMs: 12000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.http === 400 || f.http === 403 ? "provider_auth" : f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const d = parseFred(j);
  return d.length ? { data: d } : { err: "no_data" };
}
// United States via FRED: Treasury constant-maturity yields (Federal Reserve H.15, from the Treasury's par curve)
export const US_FRED = [["DGS1MO", "1M", 1], ["DGS3MO", "3M", 3], ["DGS6MO", "6M", 6], ["DGS1", "1Y", 12], ["DGS2", "2Y", 24], ["DGS3", "3Y", 36], ["DGS5", "5Y", 60], ["DGS7", "7Y", 84], ["DGS10", "10Y", 120], ["DGS20", "20Y", 240], ["DGS30", "30Y", 360]];
async function loadUsFred(env) {
  const res = await Promise.all(US_FRED.map(([id]) => fredSeries(env, id)));
  const err = res.find((r) => r.err && r.err !== "no_data");
  if (err && !res.some((r) => r.data)) return { err: err.err };
  const byDate = {};
  res.forEach((r, i) => { for (const [d, v] of r.data || []) (byDate[d] = byDate[d] || {})[US_FRED[i][1]] = v; });
  const rows = rowsFrom(byDate, US_FRED.map(([, t, m]) => [t, m]));
  return rows.length ? { data: rows.slice(-30) } : { err: "no_data" };
}
async function csvLoad(url, parse, timeoutMs = 15000, accept = "text/csv,text/plain,*/*") {
  const f = await fetchText(url, { timeoutMs, headers: { accept } });
  if (f.err) return { err: f.err };
  const rows = parse(f.text);
  return rows.length ? { data: rows.slice(-30) } : { err: "no_data" };
}

// every curve the terminal knows: id → source, loader, how stale it may get (publication lags differ)
export const CURVES = {
  US: { name: "United States — Treasury par yield curve", kind: "par yield, end of day", source: "U.S. Department of the Treasury", sourceUrl: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve", maxAgeDays: 4, key: "yields/us" },
  EA: { name: "Euro area — AAA government bonds spot curve", kind: "spot rate (Svensson), end of day", source: "European Central Bank", sourceUrl: "https://data.ecb.europa.eu/data/datasets/YC", maxAgeDays: 4, key: "yields/ea", load: () => loadEcb() },
  DE: { name: "Germany — Federal securities (Bunds)", kind: "yield from the term structure (Svensson), daily", source: "Deutsche Bundesbank", sourceUrl: "https://www.bundesbank.de/en/statistics/money-and-capital-markets/interest-rates-and-yields/term-structure-of-interest-rates", maxAgeDays: 4, key: "yields/de", load: () => csvLoad(DE_URL, parseBundesbank) },
  UK: { name: "United Kingdom — gilts", kind: "nominal par yield (fitted curve), daily", source: "Bank of England", sourceUrl: "https://www.bankofengland.co.uk/statistics/yield-curves", maxAgeDays: 6, key: "yields/uk", load: (now) => csvLoad(ukUrl(now), parseBoeYields) },
  JP: { name: "Japan — JGBs", kind: "JGB interest rate, daily", source: "Ministry of Finance Japan", sourceUrl: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/", maxAgeDays: 5, key: "yields/jp", load: () => csvLoad(JP_URL, parseMof) },
  CH: { name: "Switzerland — Confederation bonds", kind: "yield of the Confederation bond nearest each maturity, daily (published with a lag)", source: "Swiss National Bank", sourceUrl: "https://data.snb.ch/en/topics/ziredev/cube/rendoeid", maxAgeDays: 14, key: "yields/ch", load: (now) => csvLoad(chUrl(now), parseSnbBonds) },
  CA: { name: "Canada — benchmark bonds", kind: "benchmark bond yield, daily (LONG = long-term benchmark)", source: "Bank of Canada", sourceUrl: "https://www.bankofcanada.ca/rates/interest-rates/canadian-bonds/", maxAgeDays: 5, key: "yields/ca", load: async () => { const f = await fetchText(CA_URL, { timeoutMs: 12000, headers: { accept: "application/json" } }); if (f.err) return { err: f.err }; let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; } const rows = parseBocBonds(j); return rows.length ? { data: rows.slice(-30) } : { err: "no_data" }; } },
};
export const WORLD_IDS = ["DE", "UK", "JP", "CH", "CA"];
// the U.S. curve comes from FRED when its key is set (the Treasury site times out from Cloudflare)
const usDef = (env) => (env && env.FRED_KEY
  ? { ...CURVES.US, name: "United States — Treasury constant maturity", kind: "constant-maturity yield (Federal Reserve H.15), daily", source: "FRED · Federal Reserve H.15", sourceUrl: "https://fred.stlouisfed.org/categories/115", key: "yields/us-fred", load: () => loadUsFred(env) }
  : { ...CURVES.US, load: (now) => loadTreasury(now) });

// curves with their recent history (rows) — the same cached entries serve YLD, BOND and the briefing
export async function getCurveRows(origin, ctx, now, env, ids) {
  const defs = ids.map((id) => [id, id === "US" ? usDef(env) : CURVES[id]]);
  const res = await Promise.all(defs.map(([, d]) => cachedSource({ origin, key: d.key, ttlMs: 60 * 60_000, staleMaxMs: 10 * 86400_000, failTtlMs: 10 * 60_000, ctx, load: () => d.load(now) })));
  return defs.map(([id, d], i) => ({ id, def: d, r: res[i] }));
}
export async function getYieldCurves(origin, ctx, now = Date.now(), env = null, ids = ["US", "EA"]) {
  const today = easternDate(new Date(now));
  const curves = {}, errors = {};
  for (const { id, def, r } of await getCurveRows(origin, ctx, now, env, ids)) {
    if (r.data && r.data.length) curves[id] = buildCurve(r.data.slice(-2), { id, name: def.name, kind: def.kind, source: def.source, sourceUrl: def.sourceUrl, maxAgeDays: def.maxAgeDays, today, fetchedAt: r.fetchedAt, cache: r.cache, staleReason: r.staleReason });
    else errors[id] = { error: r.err, status: "N/A" };
  }
  return { curves, errors, cache: ids.map((id) => (curves[id] ? curves[id].status : "N/A")) };
}

export async function handleYields(url, env, ctx, H, json) {
  const now = Date.now();
  const { curves, errors, cache } = await getYieldCurves(url.origin, ctx, now, env, ["US", "EA", ...WORLD_IDS]);
  const status = Object.keys(curves).length ? 200 : 502;
  const r = json({ curves, errors, notConnected: ["Italy", "France", "Spain", "China", "Australia"], meta: { generatedAt: iso(now) } }, H, status);
  r.headers.set("cache-control", "no-store");
  r.headers.set("x-cache", cache.join(","));
  return r;
}
