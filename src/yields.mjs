// YIELDS — official sources only (approved T05, more countries 7 Oct 2026):
//   US: U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates (XML feed, CC0);
//       with FRED_KEY: Treasury constant maturities from FRED (Federal Reserve H.15)
//   EA: European Central Bank Data Portal, euro area AAA government bond spot curve (dataset YC)
//   DE: Deutsche Bundesbank · UK: Bank of England · JP: Ministry of Finance · CH: Swiss National Bank · CA: Bank of Canada
//   ES: Banco de España · BE: National Bank of Belgium · PT: Banco de Portugal · AT: OeNB · SE: Riksbank · NO: Norges Bank
//   AU: Reserve Bank of Australia · NZ: Reserve Bank of New Zealand · CN: ChinaBond · HK: HKMA · MY: Bank Negara Malaysia
//   ZA: South African Reserve Bank · PE: Banco Central de Reserva del Perú (all daily, no key; approved 7 Oct 2026)
//   IT, FR, NL, … : 10-year yield, MONTHLY average (OECD via FRED) where no free official daily source exists
// No interpolation, no estimated points: a maturity the source does not publish is null → N/A.
import { fetchText, cachedSource, parseCsv, num, iso, easternDate, daysBetween, UA } from "./lib.mjs";

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
  const rows = fastCsv(String(text));
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

// plain CSV without quoted fields is split directly (much cheaper than the char-by-char parser on a year of rows)
export function fastCsv(text, sep = ",") {
  const t = String(text || "");
  if (t.includes('"')) return sep === "," ? parseCsv(t) : t.split(/\r?\n/).filter((l) => l.length).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, "")));
  return t.split(/\r?\n/).filter((l) => l.length).map((l) => l.split(sep));
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
        changeBp: p.value != null && pv != null ? Math.round((p.value - pv) * 1000) / 10 : p.chgBp != null ? p.chgBp : null,
      };
    }),
  };
}

// about a year of daily publications per curve (past curves 1W / 1M / 3M / 1Y and the 10-year history use them)
export const HIST = 280;
function monthKey(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }

const TREASURY_HEADERS = { accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.8" };
async function loadTreasury(now) {
  const cur = new Date(now), prev = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1));
  const a = await fetchText(TREASURY_URL(monthKey(cur)), { headers: TREASURY_HEADERS, timeoutMs: 15000 });
  if (a.err === "provider_timeout") return { err: a.err };
  const b = await fetchText(TREASURY_URL(monthKey(prev)), { headers: TREASURY_HEADERS, timeoutMs: 15000 });
  const rows = (b.text ? parseTreasuryXml(b.text) : []).concat(a.text ? parseTreasuryXml(a.text) : []);
  return rows.length ? { data: rows.slice(-HIST) } : { err: a.err || b.err || "no_data" };
}
async function loadEcb() {
  const r = await fetchText(ECB_URL.replace("lastNObservations=2", `lastNObservations=${HIST}`) + "&detail=dataonly", { headers: { accept: "text/csv" }, timeoutMs: 25000 });
  if (r.err) return { err: r.err };
  const rows = parseEcbCsv(r.text);
  return rows.length ? { data: rows.slice(-HIST) } : { err: "no_data" };
}

// ---------- more countries (official publications; approved 7 Oct 2026) ----------
// a published value or nothing: an empty cell or "." is missing, never zero
const numOrNull = (v) => { const t = String(v == null ? "" : v).trim(); if (!t || t === "." || t === "-" || t === "ND") return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const isoDaysAgo = (now, n) => new Date(now - n * 86400_000).toISOString().slice(0, 10);
const rowsFrom = (byDate, tenors) => Object.keys(byDate).sort().map((date) => ({ date, points: tenors.map(([tenor, months]) => ({ tenor, months, value: byDate[date][tenor] ?? null, ...(byDate[date]["note:" + tenor] ? { note: byDate[date]["note:" + tenor] } : {}) })) })).filter((r) => r.points.some((p) => p.value != null));

// Germany — Deutsche Bundesbank: yields on listed Federal securities from the term structure (daily)
export const DE_TENORS = [["R01XX", "1Y", 12], ["R02XX", "2Y", 24], ["R03XX", "3Y", 36], ["R05XX", "5Y", 60], ["R07XX", "7Y", 84], ["R10XX", "10Y", 120], ["R15XX", "15Y", 180], ["R20XX", "20Y", 240], ["R30XX", "30Y", 360]];
export const DE_URL = `https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZAR.ZI.EUR.S1311.B.A604.${DE_TENORS.map(([c]) => c).join("+")}.R.A.A._Z._Z.A?format=csv&lastNObservations=280`;
export function parseBundesbank(text) {
  // English output is comma-separated; German output (Accept-Language de) uses ";" and decimal commas
  let t = String(text || "");
  if (/^[^\n]*;/.test(t) && !/^[^\n]*,BBSIS/.test(t)) t = t.split(/\r?\n/).map((l) => l.split(";").map((c) => (/^-?\d+,\d+$/.test(c) ? c.replace(",", ".") : c)).map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const rows = parseCsv(t);
  if (!rows.length) return [];
  const cols = rows[0].map((h) => { const m = /\.(R\d\dXX)\.R\.A\.A\._Z\._Z\.A$/.exec(h.trim()); const d = m && DE_TENORS.find(([c]) => c === m[1]); return d ? d[1] : null; });
  const byDate = {};
  for (const r of rows.slice(1)) { if (!/^\d{4}-\d{2}-\d{2}$/.test((r[0] || "").trim())) continue; const o = (byDate[r[0].trim()] = {}); cols.forEach((t, i) => { if (t) { const v = numOrNull(r[i]); if (v != null) o[t] = v; } }); }
  return rowsFrom(byDate, DE_TENORS.map(([, t, m]) => [t, m]));
}
// United Kingdom — Bank of England: nominal par yields on gilts (fitted curve; 5, 10 and 20 years published daily)
export const UK_SERIES = [["IUDSNPY", "5Y", 60], ["IUDMNPY", "10Y", 120], ["IUDLNPY", "20Y", 240]];
const BOE_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ukUrl = (now) => { const d = new Date(now - 400 * 86400_000); return `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${String(d.getUTCDate()).padStart(2, "0")}/${BOE_MON[d.getUTCMonth()]}/${d.getUTCFullYear()}&Dateto=now&SeriesCodes=${UK_SERIES.map(([c]) => c).join(",")}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`; };
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
export const CA_URL = "https://www.bankofcanada.ca/valet/observations/group/bond_yields_benchmark/json?recent=280";
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
  const res = await Promise.all(US_FRED.map(([id]) => fredSeries(env, id, HIST)));
  const err = res.find((r) => r.err && r.err !== "no_data");
  if (err && !res.some((r) => r.data)) return { err: err.err };
  const byDate = {};
  res.forEach((r, i) => { for (const [d, v] of r.data || []) (byDate[d] = byDate[d] || {})[US_FRED[i][1]] = v; });
  const rows = rowsFrom(byDate, US_FRED.map(([, t, m]) => [t, m]));
  return rows.length ? { data: rows.slice(-HIST) } : { err: "no_data" };
}
async function csvLoad(url, parse, timeoutMs = 15000, accept = "text/csv,text/plain,*/*") {
  const f = await fetchText(url, { timeoutMs, headers: { accept, "accept-language": "en-GB,en;q=0.9" } });
  if (f.err) return { err: f.err };
  const rows = parse(f.text);
  return rows.length ? { data: rows.slice(-HIST) } : { err: "no_data" };
}
async function jsonLoad(url, parse, timeoutMs = 15000) {
  const f = await fetchText(url, { timeoutMs, headers: { accept: "application/json,text/plain,*/*" } });
  if (f.err) return { err: f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const rows = parse(j);
  return rows.length ? { data: rows.slice(-HIST) } : { err: "no_data" };
}

// ---------- more countries, official daily sources without a key (approved 7 Oct 2026, evening) ----------
const isoDay = (now) => new Date(now).toISOString().slice(0, 10);
const byTenor = (series) => series.map(([, t, m]) => [t, m]);
const put = (byDate, date, tenor, v) => { if (/^\d{4}-\d{2}-\d{2}$/.test(date || "") && v != null) (byDate[date] = byDate[date] || {})[tenor] = v; };
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const pad2 = (n) => String(n).padStart(2, "0");

// Spain — Banco de España: average yield of spot trades in government bonds by residual maturity (daily, BIEST API)
export const ES_SERIES = [["DPUG0B1F0ZN", "3Y", 36], ["DPUG0B1F0ZO", "5Y", 60], ["DPUG0B1F0ZP", "10Y", 120], ["DPUG0B1F0ZQ", "15Y", 180], ["DPUG0B1F0ZR", "30Y", 360]];
export const ES_URL = `https://app.bde.es/bierest/resources/srdatosapp/listaSeries?idioma=en&series=${ES_SERIES.map(([c]) => c).join(",")}&rango=12M`;
export function parseBde(j) {
  const byDate = {};
  for (const s of Array.isArray(j) ? j : []) {
    const d = ES_SERIES.find(([c]) => c === s.serie); if (!d || !Array.isArray(s.fechas)) continue;
    s.fechas.forEach((f, i) => put(byDate, String(f).slice(0, 10), d[1], numOrNull(Array.isArray(s.valores) ? s.valores[i] : null)));
  }
  return rowsFrom(byDate, byTenor(ES_SERIES));
}
// Belgium — National Bank of Belgium (NBB.Stat): OLO reference yields by maturity (daily)
export const BE_TENORS = [["1Y", 12], ["2Y", 24], ["3Y", 36], ["5Y", 60], ["7Y", 84], ["10Y", 120], ["15Y", 180], ["20Y", 240], ["30Y", 360]];
export const beUrl = (now) => `https://nsidisseminate-stat.nbb.be/rest/data/BE2,DF_IROLOBE2,1.0/D.${BE_TENORS.map(([t]) => t).join("+")}.F?startPeriod=${isoDaysAgo(now, 400)}`;
export function parseNbbCsv(text) {
  const rows = fastCsv(text); if (!rows.length) return [];
  const h = rows[0].map((x) => x.trim()), iM = h.indexOf("IROLOBE2_MATUR"), iT = h.indexOf("TIME_PERIOD"), iV = h.indexOf("OBS_VALUE");
  if (iM < 0 || iT < 0 || iV < 0) return [];
  const byDate = {};
  for (const r of rows.slice(1)) if (BE_TENORS.some(([t]) => t === r[iM])) put(byDate, r[iT], r[iM], numOrNull(r[iV]));
  return rowsFrom(byDate, BE_TENORS);
}
// Portugal — Banco de Portugal (BPstat): yields on fixed-rate Treasury bonds by residual maturity (daily; market data from LSEG)
export const PT_SERIES = [["12099454", "2Y", 24], ["12099455", "3Y", 36], ["12099456", "4Y", 48], ["12099457", "5Y", 60], ["12099458", "7Y", 84], ["12099459", "10Y", 120]];
export const ptUrl = (now) => `https://bpstat.bportugal.pt/data/v1/domains/26/datasets/690b7b36fd36c0dbe249c48cbbc39524/?lang=EN&series_ids=${PT_SERIES.map(([c]) => c).join(",")}&obs_since=${isoDaysAgo(now, 400)}`;
// JSON-stat 2.0: one value per combination of dimensions, row-major in the order of `id`
export function parseBpstat(j) {
  const ids = (j && j.id) || [], size = (j && j.size) || [], iM = ids.indexOf("45"), iD = ids.indexOf("reference_date");
  if (iM < 0 || iD < 0 || !j.dimension || size.some((n, k) => k !== iM && k !== iD && n !== 1)) return [];
  const idx = (cat) => (Array.isArray(cat.index) ? cat.index : Object.keys(cat.index).sort((a, b) => cat.index[a] - cat.index[b]));
  const mCat = j.dimension["45"].category, mats = idx(mCat), dates = idx(j.dimension.reference_date.category);
  const stride = size.map((_, k) => size.slice(k + 1).reduce((a, b) => a * b, 1)), byDate = {};
  mats.forEach((m, mi) => {
    const yrs = /(\d+)\s*years?/i.exec((mCat.label && mCat.label[m]) || ""), t = yrs ? `${yrs[1]}Y` : null;
    if (!t || !PT_SERIES.some(([, x]) => x === t)) return;
    dates.forEach((d, di) => { const k = mi * stride[iM] + di * stride[iD]; put(byDate, d, t, numOrNull(Array.isArray(j.value) ? j.value[k] : j.value && j.value[k])); });
  });
  return rowsFrom(byDate, byTenor(PT_SERIES));
}
// Sweden — Sveriges Riksbank (SWEA API): government bond yields, benchmark maturities (daily)
export const SE_SERIES = [["SEGVB2YC", "2Y", 24], ["SEGVB5YC", "5Y", 60], ["SEGVB7YC", "7Y", 84], ["SEGVB10YC", "10Y", 120]];
export const seUrl = (id, now) => `https://api.riksbank.se/swea/v1/Observations/${id}/${isoDaysAgo(now, 400)}`;
async function loadSe(now) {
  const res = await Promise.all(SE_SERIES.map(([id]) => fetchText(seUrl(id, now), { timeoutMs: 12000, headers: { accept: "application/json" } })));
  const byDate = {};
  res.forEach((f, i) => { let a = []; try { a = f.text ? JSON.parse(f.text) : []; } catch {} for (const o of Array.isArray(a) ? a : []) put(byDate, o.date, SE_SERIES[i][1], numOrNull(o.value)); });
  const rows = rowsFrom(byDate, byTenor(SE_SERIES));
  return rows.length ? { data: rows.slice(-HIST) } : { err: (res.find((f) => f.err) || {}).err || "no_data" };
}
// Norway — Norges Bank: generic government bond yields (business days)
export const NO_TENORS = [["3Y", 36], ["5Y", 60], ["7Y", 84], ["10Y", 120]];
export const noUrl = (now) => `https://data.norges-bank.no/api/data/GOVT_GENERIC_RATES/B..GBON.?format=csv&startPeriod=${isoDaysAgo(now, 400)}&locale=en`;
export function parseNorgesBank(text) {
  const rows = fastCsv(text, ";"); if (!rows.length) return [];
  const h = rows[0].map((x) => x.trim()), iM = h.indexOf("TENOR"), iT = h.indexOf("TIME_PERIOD"), iV = h.indexOf("OBS_VALUE");
  if (iM < 0 || iT < 0 || iV < 0) return [];
  const byDate = {};
  for (const r of rows.slice(1)) if (NO_TENORS.some(([t]) => t === r[iM])) put(byDate, r[iT], r[iM], numOrNull(r[iV]));
  return rowsFrom(byDate, NO_TENORS);
}
// Austria — Oesterreichische Nationalbank: average yield of all federal bonds, weighted by outstanding amount (daily values, released weekly)
export const atUrl = (now) => `https://www.oenb.at/isadataservice/data?lang=EN&hierid=24&pos=VDBZIUDRB&freq=D&starttime=${isoDaysAgo(now, 400)}`;
const AT_NOTE = "average yield of all federal bonds, weighted by outstanding amount — not a single maturity";
export function parseOenb(xml) {
  const byDate = {};
  for (const m of String(xml || "").matchAll(/<obs\s+([^>]*?)\/?>/g)) {
    const v = /value="([^"]*)"/.exec(m[1]), d = /periode="(\d{4}-\d{2}-\d{2})"/.exec(m[1]);
    if (v && d) put(byDate, d[1], "AVG", numOrNull(v[1]));
  }
  return Object.keys(byDate).sort().map((date) => ({ date, points: [{ tenor: "AVG", months: null, value: byDate[date].AVG, note: AT_NOTE }] }));
}
// Australia — Reserve Bank of Australia, table F2: government bond yields interpolated to 2, 3, 5 and 10 years (daily, released weekly)
export const AU_URL = "https://www.rba.gov.au/statistics/tables/csv/f2-data.csv";
export const AU_SERIES = [["FCMYGBAG2D", "2Y", 24], ["FCMYGBAG3D", "3Y", 36], ["FCMYGBAG5D", "5Y", 60], ["FCMYGBAG10D", "10Y", 120]];
export function parseRbaF2(text) {
  const lines = String(text || "").split(/\r?\n/), idLine = lines.find((l) => /^Series ID,/.test(l));
  if (!idLine) return [];
  const ids = idLine.split(","), cols = AU_SERIES.map(([c, t]) => [ids.indexOf(c), t]).filter(([i]) => i > 0), byDate = {};
  const data = lines.filter((l) => /^\d{2}-[A-Z][a-z]{2}-\d{4},/.test(l)).slice(-HIST - 20);
  for (const l of data) {
    const c = l.split(","), m = /^(\d{2})-([A-Z][a-z]{2})-(\d{4})$/.exec(c[0]); if (!m || !MON[m[2]]) continue;
    const date = `${m[3]}-${pad2(MON[m[2]])}-${m[1]}`;
    for (const [i, t] of cols) put(byDate, date, t, numOrNull(c[i]));
  }
  return rowsFrom(byDate, byTenor(AU_SERIES));
}
// New Zealand — Reserve Bank of New Zealand, table B2: secondary-market government bond closing yields (daily, from NZFMA; xlsx)
export const NZ_URL = "https://www.rbnz.govt.nz/-/media/project/sites/rbnz/files/statistics/series/b/b2/hb2-daily-close.xlsx";
export const NZ_SERIES = [["INM.DG101.NZZCF", "1Y", 12], ["INM.DG102.NZZCF", "2Y", 24], ["INM.DG105.NZZCF", "5Y", 60], ["INM.DG110.NZZCF", "10Y", 120]];
// one file out of a zip (xlsx): central directory → local header → deflate-raw (or stored) data
export async function unzipText(buf, name) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22; while (e > 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e <= 0) return null;
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), cs = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const fname = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    if (fname === name) {
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = b.subarray(start, start + cs);
      if (method === 0) return new TextDecoder().decode(data);
      const s = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(s).text();
    }
    p += 46 + nl + el + cl;
  }
  return null;
}
const xlsxDate = (serial) => new Date(Date.UTC(1899, 11, 30) + serial * 86400_000).toISOString().slice(0, 10);
export function parseRbnzB2(sharedStrings, sheet) {
  const strs = [...String(sharedStrings || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
  const cellsOf = (row) => [...row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<f>[^<]*<\/f>)?(?:<v>([^<]*)<\/v>)?<\/c>)/g)].map((m) => ({ col: m[1], s: /t="s"/.test(m[2]), v: m[3] }));
  const rows = [...String(sheet || "").matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((m) => m[1]);
  const codeRow = rows.find((r) => cellsOf(r).some((c) => c.s && strs[+c.v] === NZ_SERIES[0][0]));
  if (!codeRow) return [];
  const colOf = {}; for (const c of cellsOf(codeRow)) if (c.s) { const d = NZ_SERIES.find(([k]) => k === strs[+c.v]); if (d) colOf[c.col] = d[1]; }
  const byDate = {};
  for (const r of rows.slice(-HIST - 20)) {
    const cs = cellsOf(r), a = cs.find((c) => c.col === "A"); if (!a || a.s || !/^\d{5}(\.\d+)?$/.test(a.v || "")) continue;
    const date = xlsxDate(Math.floor(+a.v));
    for (const c of cs) if (colOf[c.col] && !c.s) put(byDate, date, colOf[c.col], numOrNull(c.v));
  }
  return rowsFrom(byDate, byTenor(NZ_SERIES));
}
async function loadNz() {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(NZ_URL, { signal: ac.signal, headers: { "user-agent": UA, accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*" } });
    if (!r.ok) return { err: r.status === 403 ? "provider_forbidden" : r.status === 429 ? "rate_limited" : "provider_error" };
    const buf = await r.arrayBuffer();
    const sheet = await unzipText(buf, "xl/worksheets/sheet1.xml"), strs = await unzipText(buf, "xl/sharedStrings.xml");
    if (!sheet || !strs) return { err: "provider_error" };
    // only the header rows and the most recent rows are read
    const cut = sheet.lastIndexOf("<row ", Math.max(0, sheet.length - 160_000));
    const rows = parseRbnzB2(strs, sheet.slice(0, 20_000) + (cut > 20_000 ? sheet.slice(cut) : sheet.slice(20_000)));
    return rows.length ? { data: rows.slice(-HIST) } : { err: "no_data" };
  } catch { return { err: ac.signal.aborted ? "provider_timeout" : "provider_unreachable" }; }
  finally { clearTimeout(timer); }
}
// China — ChinaBond (China Central Depository & Clearing), government bond yield curve as published for the People's Bank of China (daily)
export const CN_TENORS = [["3M", 3], ["6M", 6], ["1Y", 12], ["3Y", 36], ["5Y", 60], ["7Y", 84], ["10Y", 120], ["30Y", 360]];
export const cnUrl = (now) => `https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery?startDate=${isoDaysAgo(now, 360)}&endDate=${isoDay(now)}&gjqx=0&qxId=hzsylqx&locale=en_US`;
export function parseChinaBond(html) {
  const byDate = {};
  for (const m of String(html || "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const c = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").trim());
    if (c.length < 2 + CN_TENORS.length || c[0] !== "ChinaBond Government Bond Yield Curve") continue;
    CN_TENORS.forEach(([t], i) => put(byDate, c[1], t, numOrNull(c[2 + i])));
  }
  return rowsFrom(byDate, CN_TENORS);
}
// Hong Kong — HKMA: Exchange Fund Bills and Notes, indicative yields (latest day only; up to 2 years)
export const HK_URL = "https://api.hkma.gov.hk/public/market-data-and-statistics/daily-monetary-statistics/efbn-indicative-price?segment=IndicativePrice&pagesize=50";
const HK_TERMS = { "1W": ["1W", 0.25], "1M": ["1M", 1], "3M": ["3M", 3], "6M": ["6M", 6], "9M": ["9M", 9], "12M": ["1Y", 12], "2 YR": ["2Y", 24] };
export function parseHkma(j) {
  const recs = (j && j.result && Array.isArray(j.result.records)) ? j.result.records : [], byDate = {}, issue = {};
  for (const r of recs) { const t = HK_TERMS[String(r.term || "").trim()]; if (t) { put(byDate, r.end_of_date, t[0], numOrNull(r.yield)); issue[t[0]] = r.issue_no; } }
  const tenors = Object.values(HK_TERMS);
  return Object.keys(byDate).sort().map((date) => ({ date, points: tenors.map(([t, m]) => ({ tenor: t, months: m, value: byDate[date][t] ?? null, ...(issue[t] ? { note: `Exchange Fund ${t === "2Y" ? "Note" : "Bill"} ${issue[t]}` } : {}) })) })).filter((r) => r.points.some((p) => p.value != null));
}
// Malaysia — Bank Negara Malaysia: MGS benchmark closing yields (latest trading day; daily change as published)
export const MY_URL = "https://www.bnm.gov.my/government-securities-yield";
export function parseBnm(html) {
  const h = String(html || ""), date = (/<option value="(\d{4}-\d{2}-\d{2})"\s+selected/.exec(h) || [])[1];
  const i = h.indexOf("MGS Benchmarks"), j = h.indexOf("Government Investment Issues", i);
  if (!date || i < 0) return [];
  const points = [];
  for (const m of h.slice(i, j > i ? j : i + 20000).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    const y = /^(\d+)-year$/.exec(c[0] || ""); if (!y || c.length < 6) continue;
    const last = /\*/.test(c[5]), v = numOrNull(String(c[5]).replace("*", "")), chg = numOrNull(String(c[7] || "").replace("*", ""));
    points.push({ tenor: `${y[1]}Y`, months: +y[1] * 12, value: v, note: `MGS maturing ${c[1]}, coupon ${c[2]}%${last ? "; last traded yield (no trade that day)" : ""}`, ...(chg != null && !last ? { chgBp: chg } : {}) });
  }
  return points.some((p) => p.value != null) ? [{ date, points }] : [];
}
// South Africa — South African Reserve Bank: closing yields of benchmark government bonds R2030 and R209 (daily)
export const ZA_BONDS = [["MMRD708A", "R2030", "matures 2030", "2030-01-31"], ["MMRD709A", "R209", "matures 2036", "2036-03-31"]];
const zaUrl = (code, now) => `https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/GetTimeseriesObservations/${code}/${isoDaysAgo(now, 400)}/${isoDay(now)}`;
const STD = [1, 2, 3, 5, 7, 10, 15, 20, 30];
// a bond sits at the standard maturity nearest its time to maturity (within a quarter-year or a fifth of the maturity)
export function bondTenor(years) { const T = STD.slice().sort((a, b) => Math.abs(a - years) - Math.abs(b - years))[0]; return Math.abs(T - years) <= Math.max(0.75, T / 5) ? T : null; }
export function parseSarb(lists) {
  const byDate = {};
  ZA_BONDS.forEach(([, name, label, mat], i) => {
    for (const o of Array.isArray(lists[i]) ? lists[i] : []) {
      const d = String(o.Period || "").slice(0, 10), v = numOrNull(o.Value); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || v == null) continue;
      const yrs = (Date.parse(mat) - Date.parse(d)) / 86400_000 / 365, T = bondTenor(yrs); if (!T) continue;
      const x = (byDate[d] = byDate[d] || {}); x[`${T}Y`] = v; x[`note:${T}Y`] = `${name} (${label}), ${yrs.toFixed(1)} years to maturity`;
    }
  });
  const tenors = [...new Set(Object.values(byDate).flatMap((x) => Object.keys(x).filter((k) => !k.startsWith("note:"))))].map((t) => [t, parseInt(t, 10) * 12]).sort((a, b) => a[1] - b[1]);
  return rowsFrom(byDate, tenors);
}
async function loadZa(now) {
  const res = await Promise.all(ZA_BONDS.map(([code]) => fetchText(zaUrl(code, now), { timeoutMs: 15000, headers: { accept: "application/json" } })));
  const lists = res.map((f) => { try { return f.text ? JSON.parse(f.text) : []; } catch { return []; } });
  const rows = parseSarb(lists);
  return rows.length ? { data: rows.slice(-HIST) } : { err: (res.find((f) => f.err) || {}).err || "no_data" };
}
// Peru — Banco Central de Reserva del Perú: yield of the 10-year government bond in soles (daily)
export const peUrl = (now) => `https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD31893DD/json/${isoDaysAgo(now, 400)}/${isoDay(now)}`;
const ES_MON = { Ene: 1, Feb: 2, Mar: 3, Abr: 4, May: 5, Jun: 6, Jul: 7, Ago: 8, Set: 9, Sep: 9, Oct: 10, Nov: 11, Dic: 12 };
export function parseBcrp(j) {
  const byDate = {};
  for (const p of (j && Array.isArray(j.periods)) ? j.periods : []) {
    const m = /^(\d{2})\.([A-Za-z]{3})\.(\d{2})$/.exec(String(p.name || "")); if (!m || !ES_MON[m[2]]) continue;
    put(byDate, `20${m[3]}-${pad2(ES_MON[m[2]])}-${m[1]}`, "10Y", numOrNull(Array.isArray(p.values) ? p.values[0] : null));
  }
  return rowsFrom(byDate, [["10Y", 120]]);
}

// ---------- 10-year yield, monthly average (OECD Main Economic Indicators, via FRED) for countries without a free official daily source ----------
// approved 7 Oct 2026: FRED is an approved source; the series is a monthly average and is always labelled as such
export const OECD_10Y = {
  IT: ["Italy", "Europe"], FR: ["France", "Europe"], NL: ["Netherlands", "Europe"], IE: ["Ireland", "Europe"], GR: ["Greece", "Europe"], FI: ["Finland", "Europe"],
  DK: ["Denmark", "Europe"], PL: ["Poland", "Europe"], CZ: ["Czech Republic", "Europe"], HU: ["Hungary", "Europe"], SK: ["Slovakia", "Europe"], SI: ["Slovenia", "Europe"],
  LU: ["Luxembourg", "Europe"], LV: ["Latvia", "Europe"], LT: ["Lithuania", "Europe"], IS: ["Iceland", "Europe"],
  KR: ["South Korea", "Asia-Pacific"], IN: ["India", "Asia-Pacific"], IL: ["Israel", "Middle East & Africa"], MX: ["Mexico", "Americas"], CL: ["Chile", "Americas"], CO: ["Colombia", "Americas"],
};
export const oecdId = (cc) => `IRLTLT01${cc}M156N`;
async function loadOecd(env, cc) {
  const r = await fredSeries(env, oecdId(cc), 240);
  if (!r.data) return { err: r.err };
  return { data: r.data.map(([date, value]) => ({ date, points: [{ tenor: "10Y", months: 120, value }] })) };
}

// every curve the terminal knows: id → source, loader, how stale it may get (publication lags differ)
export const CURVES = {
  US: { name: "United States — Treasury par yield curve", kind: "par yield, end of day", source: "U.S. Department of the Treasury", sourceUrl: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve", maxAgeDays: 4, key: "yields/us" },
  EA: { name: "Euro area — AAA government bonds spot curve", kind: "spot rate (Svensson), end of day", source: "European Central Bank", sourceUrl: "https://data.ecb.europa.eu/data/datasets/YC", maxAgeDays: 4, key: "yields/ea", load: () => loadEcb() },
  DE: { name: "Germany — Federal securities (Bunds)", kind: "yield from the term structure (Svensson), daily", source: "Deutsche Bundesbank", sourceUrl: "https://www.bundesbank.de/en/statistics/money-and-capital-markets/interest-rates-and-yields/term-structure-of-interest-rates", maxAgeDays: 4, key: "yields/de2", load: () => csvLoad(DE_URL, parseBundesbank) },
  UK: { name: "United Kingdom — gilts", kind: "nominal par yield (fitted curve), daily", source: "Bank of England", sourceUrl: "https://www.bankofengland.co.uk/statistics/yield-curves", maxAgeDays: 6, key: "yields/uk2", load: (now) => csvLoad(ukUrl(now), parseBoeYields) },
  JP: { name: "Japan — JGBs", kind: "JGB interest rate, daily (current month)", source: "Ministry of Finance Japan", sourceUrl: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/", maxAgeDays: 5, key: "yields/jp", load: () => csvLoad(JP_URL, parseMof) },
  CH: { name: "Switzerland — Confederation bonds", kind: "yield of the Confederation bond nearest each maturity, daily (published with a lag)", source: "Swiss National Bank", sourceUrl: "https://data.snb.ch/en/topics/ziredev/cube/rendoeid", maxAgeDays: 14, key: "yields/ch", load: (now) => csvLoad(chUrl(now), parseSnbBonds) },
  CA: { name: "Canada — benchmark bonds", kind: "benchmark bond yield, daily (LONG = long-term benchmark)", source: "Bank of Canada", sourceUrl: "https://www.bankofcanada.ca/rates/interest-rates/canadian-bonds/", maxAgeDays: 5, key: "yields/ca", load: async () => { const f = await fetchText(CA_URL, { timeoutMs: 12000, headers: { accept: "application/json" } }); if (f.err) return { err: f.err }; let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; } const rows = parseBocBonds(j); return rows.length ? { data: rows.slice(-HIST) } : { err: "no_data" }; } },
  ES: { name: "Spain — government bonds", kind: "average yield of spot trades by residual maturity, daily", source: "Banco de España", sourceUrl: "https://www.bde.es/wbe/en/estadisticas/temas/tipos-interes/", maxAgeDays: 5, key: "yields/es", load: () => jsonLoad(ES_URL, parseBde) },
  BE: { name: "Belgium — OLOs", kind: "OLO reference yield by maturity, daily", source: "National Bank of Belgium", sourceUrl: "https://stat.nbb.be/", maxAgeDays: 4, key: "yields/be", load: (now) => csvLoad(beUrl(now), parseNbbCsv, 15000, "application/vnd.sdmx.data+csv;version=1.0.0") },
  PT: { name: "Portugal — Treasury bonds (OT)", kind: "yield of fixed-rate Treasury bonds by residual maturity, daily (market data: LSEG)", source: "Banco de Portugal", sourceUrl: "https://bpstat.bportugal.pt/", maxAgeDays: 5, key: "yields/pt", load: (now) => jsonLoad(ptUrl(now), parseBpstat) },
  AT: { name: "Austria — federal bonds", kind: "average yield of all federal bonds (UDRB), daily values released weekly", source: "Oesterreichische Nationalbank", sourceUrl: "https://www.oenb.at/en/Statistics/Standardized-Tables/interest-rates-and-exchange-rates.html", maxAgeDays: 14, key: "yields/at", histTenor: "AVG", load: (now) => csvLoad(atUrl(now), parseOenb, 15000, "application/xml,text/xml,*/*") },
  SE: { name: "Sweden — government bonds", kind: "government bond yield, benchmark maturities, daily", source: "Sveriges Riksbank", sourceUrl: "https://www.riksbank.se/en-gb/statistics/interest-rates-and-exchange-rates/", maxAgeDays: 5, key: "yields/se", load: (now) => loadSe(now) },
  NO: { name: "Norway — government bonds", kind: "generic government bond yield, business days", source: "Norges Bank", sourceUrl: "https://www.norges-bank.no/en/topics/Statistics/Interest-rates/Government-bonds-and-treasury-bills/", maxAgeDays: 5, key: "yields/no", load: (now) => csvLoad(noUrl(now), parseNorgesBank) },
  AU: { name: "Australia — Commonwealth government bonds", kind: "yield interpolated to 2, 3, 5 and 10 years, daily (released weekly)", source: "Reserve Bank of Australia (table F2)", sourceUrl: "https://www.rba.gov.au/statistics/tables/#interest-rates", maxAgeDays: 12, key: "yields/au", load: () => csvLoad(AU_URL, parseRbaF2) },
  NZ: { name: "New Zealand — government bonds", kind: "secondary-market closing yield, daily (data: NZFMA)", source: "Reserve Bank of New Zealand (table B2)", sourceUrl: "https://www.rbnz.govt.nz/statistics/series/exchange-and-interest-rates/wholesale-interest-rates", maxAgeDays: 5, key: "yields/nz", load: () => loadNz() },
  CN: { name: "China — government bonds (CGB)", kind: "ChinaBond government bond yield curve, daily", source: "ChinaBond (China Central Depository & Clearing)", sourceUrl: "https://yield.chinabond.com.cn/", maxAgeDays: 10, key: "yields/cn", load: (now) => csvLoad(cnUrl(now), parseChinaBond, 20000, "text/html,*/*") },
  HK: { name: "Hong Kong — Exchange Fund Bills and Notes", kind: "indicative yield, latest day only (up to 2 years)", source: "Hong Kong Monetary Authority", sourceUrl: "https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/daily-monetary-statistics/efbn-indicative-price/", maxAgeDays: 4, key: "yields/hk", histTenor: "2Y", load: () => jsonLoad(HK_URL, parseHkma) },
  MY: { name: "Malaysia — Malaysian Government Securities", kind: "benchmark closing yield, latest trading day (daily change as published)", source: "Bank Negara Malaysia", sourceUrl: "https://www.bnm.gov.my/government-securities-yield", maxAgeDays: 5, key: "yields/my", load: () => csvLoad(MY_URL, parseBnm, 20000, "text/html,*/*") },
  ZA: { name: "South Africa — government bonds", kind: "closing yield of benchmark bonds R2030 and R209, daily", source: "South African Reserve Bank", sourceUrl: "https://www.resbank.co.za/en/home/what-we-do/statistics/key-statistics/current-market-rates", maxAgeDays: 5, key: "yields/za", load: (now) => loadZa(now) },
  PE: { name: "Peru — government bonds", kind: "10-year government bond yield in soles, daily", source: "Banco Central de Reserva del Perú", sourceUrl: "https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias/resultados/PD31893DD/html", maxAgeDays: 6, key: "yields/pe", load: (now) => jsonLoad(peUrl(now), parseBcrp, 20000) },
};
for (const [cc, [country]] of Object.entries(OECD_10Y)) CURVES[cc] = { name: `${country} — 10-year government bond`, kind: "10-year yield, MONTHLY AVERAGE (OECD Main Economic Indicators)", source: "FRED · OECD", sourceUrl: `https://fred.stlouisfed.org/series/${oecdId(cc)}`, maxAgeDays: 100, key: `yields/oecd/${cc}`, freq: "M", ttlMs: 12 * 3600_000, oecd: cc };
// the monthly references for spreads of the monthly series (same statistic for Germany and the United States)
const OECD_REF = { DE: "DE", US: "US" };
const oecdDef = (cc) => ({ ...CURVES[cc] || {}, key: `yields/oecd/${cc}`, freq: "M", ttlMs: 12 * 3600_000, oecd: cc, name: `${cc} — 10-year government bond`, maxAgeDays: 100 });
export const WORLD_IDS = ["DE", "UK", "JP", "CH", "CA"];
// regions and what is shown first in each; daily sources first, then the monthly averages
export const REGIONS = [
  ["Americas", ["US", "CA", "PE", "MX", "CL", "CO"]],
  ["Europe", ["EA", "DE", "UK", "FR", "IT", "ES", "NL", "BE", "AT", "PT", "IE", "GR", "FI", "CH", "SE", "NO", "DK", "PL", "CZ", "HU", "SK", "SI", "LU", "LV", "LT", "IS"]],
  ["Asia-Pacific", ["JP", "CN", "AU", "NZ", "HK", "KR", "IN", "MY"]],
  ["Middle East & Africa", ["ZA", "IL"]],
];
export const YIELD_IDS = REGIONS.flatMap(([, ids]) => ids);
export function yieldCatalog(env) {
  return REGIONS.flatMap(([region, ids]) => ids.map((id) => { const d = id === "US" ? usDef(env) : CURVES[id]; return { id, region, name: d.name, source: d.source, freq: d.freq || "D", histTenor: d.histTenor || "10Y" }; }));
}
// the U.S. curve comes from FRED when its key is set (the Treasury site times out from Cloudflare)
const usDef = (env) => (env && env.FRED_KEY
  ? { ...CURVES.US, name: "United States — Treasury constant maturity", kind: "constant-maturity yield (Federal Reserve H.15), daily", source: "FRED · Federal Reserve H.15", sourceUrl: "https://fred.stlouisfed.org/categories/115", key: "yields/us-fred", load: () => loadUsFred(env) }
  : { ...CURVES.US, load: (now) => loadTreasury(now) });
const defOf = (id, env) => (id === "US" ? usDef(env) : CURVES[id]);
const loaderOf = (d, env) => (d.oecd ? () => loadOecd(env, d.oecd) : d.load);

// curves with their recent history (rows) — the same cached entries serve YLD, CURVE, BOND and the briefing
export async function getCurveRows(origin, ctx, now, env, ids) {
  const defs = ids.map((id) => [id, defOf(id, env)]);
  const res = await Promise.all(defs.map(([, d]) => { const load = loaderOf(d, env); return cachedSource({ origin, key: d.key, ttlMs: d.ttlMs || 60 * 60_000, staleMaxMs: 10 * 86400_000, failTtlMs: 10 * 60_000, ctx, load: () => load(now) }); }));
  return defs.map(([id, d], i) => ({ id, def: d, r: res[i] }));
}
async function oecdRefRows(origin, ctx, now, env) {
  const out = {};
  await Promise.all(Object.keys(OECD_REF).map(async (cc) => { const d = oecdDef(cc); const r = await cachedSource({ origin, key: d.key, ttlMs: d.ttlMs, staleMaxMs: 40 * 86400_000, failTtlMs: 10 * 60_000, ctx, load: () => loadOecd(env, cc) }); out[cc] = r.data || null; }));
  return out;
}
// the same curve 1 week, 1 month, 3 months and 1 year earlier: the last publication on or before that day
// (or, failing that, one within a week after it) — never interpolated
export const PAST = [["1W", 7], ["1M", 30], ["3M", 91], ["1Y", 365]];
export function pastCurves(rows, freq = "D") {
  const out = {}; if (!rows || rows.length < 2) return out;
  const last = Date.parse(rows[rows.length - 1].date);
  for (const [k, days] of PAST) {
    if (freq === "M" && days < 28) continue; // a monthly series has no "a week ago"
    const target = last - days * 86400_000, tol = (days >= 300 ? 7 : days >= 80 ? 5 : days >= 28 ? 3 : 1) * 86400_000;
    let r = null; for (const x of rows) { if (Date.parse(x.date) <= target) r = x; else break; }
    if (!r) { const a = rows.find((x) => Date.parse(x.date) > target); if (a && Date.parse(a.date) - target <= tol && a !== rows[rows.length - 1]) r = a; }
    if (r && r !== rows[rows.length - 1]) out[k] = { date: r.date, points: r.points.map((p) => ({ tenor: p.tenor, months: p.months, value: p.value })) };
  }
  return out;
}
const tenSeries = (rows, tenor = "10Y") => (rows || []).map((r) => { const p = r.points.find((x) => x.tenor === tenor); return p && p.value != null ? [r.date, p.value] : null; }).filter(Boolean);
// 10-year spread against a reference on the latest day both published (monthly series: the same month)
export function spreadVs(rows, refRows) {
  const ref = new Map(tenSeries(refRows)), mine = tenSeries(rows);
  for (let i = mine.length - 1; i >= 0; i--) { const [d, v] = mine[i]; if (ref.has(d)) return { bp: Math.round((v - ref.get(d)) * 1000) / 10, date: d }; }
  return null;
}
export async function getYieldCurves(origin, ctx, now = Date.now(), env = null, ids = ["US", "EA"], opts = {}) {
  const today = easternDate(new Date(now));
  const curves = {}, errors = {};
  const list = await getCurveRows(origin, ctx, now, env, ids);
  let refs = null, mrefs = null;
  if (opts.spreads) {
    const need = ids.filter((id) => id !== "DE" && id !== "US");
    if (need.some((id) => !CURVES[id] || !CURVES[id].oecd)) { const r = await getCurveRows(origin, ctx, now, env, ["DE", "US"]); refs = { DE: r[0].r.data, US: r[1].r.data }; }
    if (need.some((id) => CURVES[id] && CURVES[id].oecd)) mrefs = await oecdRefRows(origin, ctx, now, env);
  }
  for (const { id, def, r } of list) {
    if (r.data && r.data.length) {
      const c = buildCurve(r.data.slice(-2), { id, name: def.name, kind: def.kind, source: def.source, sourceUrl: def.sourceUrl, maxAgeDays: def.maxAgeDays, today, fetchedAt: r.fetchedAt, cache: r.cache, staleReason: r.staleReason });
      if (opts.past) { c.past = pastCurves(r.data, def.freq || "D"); c.freq = def.freq || "D"; c.histTenor = def.histTenor || "10Y"; c.history = { first: r.data[0].date, count: r.data.length }; }
      if (opts.spreads) {
        const ref = def.oecd ? mrefs : refs, sp = {};
        if (ref) for (const k of ["DE", "US"]) if (k !== id && ref[k]) { const v = spreadVs(r.data, ref[k]); if (v) sp[k] = v; }
        c.spreads = sp;
      }
      curves[id] = c;
    } else errors[id] = { error: r.err, status: "N/A" };
  }
  return { curves, errors, cache: ids.map((id) => (curves[id] ? curves[id].status : "N/A")) };
}

export async function handleYields(url, env, ctx, H, json) {
  const now = Date.now(), send = (b, st) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  // one tenor over time: GET /api/yields/history?id=IT&tenor=10Y
  if (url.pathname === "/api/yields/history") {
    const id = String(url.searchParams.get("id") || "").toUpperCase(), d = YIELD_IDS.includes(id) ? defOf(id, env) : null;
    if (!d) return send({ error: "bad_request", message: "unknown id" }, 400);
    const tenor = String(url.searchParams.get("tenor") || d.histTenor || "10Y").toUpperCase();
    const [{ r }] = await getCurveRows(url.origin, ctx, now, env, [id]);
    if (!r.data) return send({ id, tenor, status: "N/A", error: r.err }, 502);
    const points = tenSeries(r.data, tenor);
    return send({ id, tenor, freq: d.freq || "D", points, source: d.source, sourceUrl: d.sourceUrl, kind: d.kind, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) }, points.length ? 200 : 404);
  }
  if (url.pathname === "/api/yields/catalog") return send({ catalog: yieldCatalog(env) }, 200);
  // a few countries per request (each country is one or more requests to its source): GET /api/yields?ids=ES,BE,PT
  const asked = url.searchParams.get("ids");
  if (asked != null) {
    const ids = [...new Set(String(asked).toUpperCase().split(",").map((x) => x.trim()).filter((x) => YIELD_IDS.includes(x)))].slice(0, 6);
    if (!ids.length) return send({ error: "bad_request", message: "ids: one to six of " + YIELD_IDS.join(",") }, 400);
    const { curves, errors } = await getYieldCurves(url.origin, ctx, now, env, ids, { past: true, spreads: true });
    return send({ curves, errors, meta: { generatedAt: iso(now) } }, Object.keys(curves).length ? 200 : 502);
  }
  const { curves, errors, cache } = await getYieldCurves(url.origin, ctx, now, env, ["US", "EA", ...WORLD_IDS]);
  const r = send({ curves, errors, catalog: yieldCatalog(env), notConnected: ["Italy, France, Netherlands and others: daily N/A (monthly average in the world table)", "Brazil", "Turkey", "Indonesia", "Singapore", "Taiwan", "Thailand", "Philippines", "Saudi Arabia"], meta: { generatedAt: iso(now) } }, Object.keys(curves).length ? 200 : 502);
  r.headers.set("x-cache", cache.join(","));
  return r;
}
