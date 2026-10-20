// RATES & MACRO (T07) — official publications only.
//   GET /api/cb          policy rates: ECB (Data Portal, FM), Fed (New York Fed markets API: EFFR + target range),
//                        Bank of England (Bank Rate, IADB), Swiss National Bank (SNB data portal), Bank of Canada (Valet)
//   GET /api/sprd        2s10s history, daily, about a year: euro area (ECB AAA spot curve) and United States
//                        (FRED, Federal Reserve H.15 constant-maturity 2Y and 10Y; needs FRED_KEY, else N/A)
//   GET /api/energy      EIA (U.S. Energy Information Administration): daily spot prices (crude, products, natural gas)
//                        (EIA's NYMEX futures series ended 2024-04-05: not requested; curves are FCRV/CNBC). Needs EIA_KEY,
//                        or FRED's copy of the same spot series.
//   GET /api/energy/stocks  EIA weekly inventories (crude, Cushing, SPR, gasoline, distillate, jet fuel, natural gas in
//                        storage), refinery utilization and crude production: latest week, weekly change, vs a year ago and
//                        vs the 5-year average for that week (DERIVED). Needs EIA_KEY.
// Every value is the institution's published figure with its date; nothing is filled in between publications.
// EIA answers keyed data requests slowly (15–30 s, measured 21 Oct 2026 from the Worker): pages never wait on it. The
// 5-minute scheduled run (refreshEia) fetches one EIA request at a time into Workers KV; pages read that copy.
import { fetchText, cachedSource, parseCsv, iso, kvStore } from "./lib.mjs";
import { fredSeries } from "./yields.mjs";

// a published value or nothing: an empty cell is missing, never zero
export const numv = (v) => (v == null || (typeof v === "string" && v.trim() === "") ? NaN : Number(v));
const csvRows = (text) => { const rows = parseCsv(String(text || "")); if (!rows.length) return []; const h = rows[0].map((x) => x.trim()); return rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };
// the latest published level, the level before the last change and the date of that change
// (daily series repeat the same value, so "previous" is the last different one); no change in the data → unchangedSince
export function lastChange(obs) {
  if (!obs || !obs.length) return null;
  const last = obs[obs.length - 1];
  for (let i = obs.length - 2; i >= 0; i--) if (obs[i][1] !== last[1]) return { date: last[0], value: last[1], previous: obs[i][1], changedOn: obs[i + 1][0] };
  return { date: last[0], value: last[1], previous: null, changedOn: null, unchangedSince: obs[0][0] };
}
const lastObs = (rows, dateKey, valKey) => rows.map((r) => [r[dateKey], numv(r[valKey])]).filter(([d, v]) => d && Number.isFinite(v)).sort((a, b) => (a[0] < b[0] ? -1 : 1));

// ---------- central banks ----------
export const ECB_RATES = { DFR: "Deposit facility", MRR_FR: "Main refinancing operations", MLFR: "Marginal lending facility" };
// the ECB key-rate series hold one observation per change (not a daily repeat); detail=dataonly drops the long attribute columns
export const ECB_RATES_URL = `https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.${Object.keys(ECB_RATES).join("+")}.LEV?lastNObservations=6&format=csvdata&detail=dataonly`;
export const NYFED_URL = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/500.json";
export const BOE_URL = "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/2024&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N";
export const snbUrl = (now = Date.now()) => `https://data.snb.ch/api/cube/snbgwdzid/data/csv/en?fromDate=${new Date(now - 3 * 365 * 86400_000).toISOString().slice(0, 10)}`;
export const BOC_URL = "https://www.bankofcanada.ca/valet/observations/V39079/json?recent=750";

export function parseEcbRate(text, code) { const rows = csvRows(text).filter((r) => !code || String(r.KEY || "").includes(`.KR.${code}.`)); return lastChange(lastObs(rows, "TIME_PERIOD", "OBS_VALUE")); }
export function parseNyFed(j) {
  const r = j && Array.isArray(j.refRates) ? j.refRates.filter((x) => x && x.type === "EFFR" && Number.isFinite(x.percentRate)).sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1)) : [];
  if (!r.length) return null;
  const tgt = (x) => (Number.isFinite(x.targetRateFrom) && Number.isFinite(x.targetRateTo) ? `${x.targetRateFrom}|${x.targetRateTo}` : null), now = tgt(r[0]);
  // the FOMC target range before the last change, from the same daily publication
  let previous = null, changedOn = null;
  if (now) for (let i = 1; i < r.length; i++) { const t = tgt(r[i]); if (t && t !== now) { previous = { from: r[i].targetRateFrom, to: r[i].targetRateTo }; changedOn = r[i - 1].effectiveDate; break; } }
  return { date: r[0].effectiveDate, value: r[0].percentRate, targetFrom: now ? r[0].targetRateFrom : null, targetTo: now ? r[0].targetRateTo : null, targetPrevious: previous, targetChangedOn: changedOn, targetUnchangedSince: now && !previous ? r[r.length - 1].effectiveDate : null };
}
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
export function parseBoe(text) {
  // "DATE,IUDBEDR" then "06 Oct 2026,4.0000"
  const out = [];
  for (const r of parseCsv(String(text || ""))) { const m = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec((r[0] || "").trim()); const v = numv(r[1]); if (m && MON[m[2]] && Number.isFinite(v)) out.push([`${m[3]}-${MON[m[2]]}-${m[1]}`, v]); }
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return lastChange(out);
}
export function parseSnb(text) {
  // SNB cube CSV: header lines, then "Date;D0;Value" rows; D0 = "LZ" is the SNB policy rate
  const lines = String(text || "").split(/\r?\n/).map((l) => l.split(";").map((x) => x.replace(/^"|"$/g, "").trim()));
  const rows = lines.filter((r) => r.length >= 3 && /^\d{4}-\d{2}(-\d{2})?$/.test(r[0]) && r[1] === "LZ" && r[2] !== "" && Number.isFinite(Number(r[2]))).map((r) => [r[0], Number(r[2])]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return lastChange(rows);
}
export function parseBoc(j) {
  const o = j && Array.isArray(j.observations) ? j.observations.map((x) => [x.d, numv(x.V39079 && x.V39079.v)]).filter(([d, v]) => d && Number.isFinite(v)).sort((a, b) => (a[0] < b[0] ? -1 : 1)) : [];
  return lastChange(o);
}

export const BANKS = [
  { id: "ECB", name: "European Central Bank", ccy: "EUR", page: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html",
    load: async () => { const out = {}; const f = await fetchText(ECB_RATES_URL, { timeoutMs: 25000, headers: { accept: "text/csv" } }); if (f.err) return { err: f.err }; for (const k of Object.keys(ECB_RATES)) { const p = parseEcbRate(f.text, k); if (p) out[k] = p; } return out.DFR ? { data: { rate: out.DFR, label: "Deposit facility rate", others: Object.fromEntries(Object.entries(out).filter(([k]) => k !== "DFR").map(([k, v]) => [ECB_RATES[k], v])) } } : { err: "no_data" }; } },
  { id: "FED", name: "Federal Reserve", ccy: "USD", page: "https://www.newyorkfed.org/markets/reference-rates/effr",
    load: async () => { const f = await fetchText(NYFED_URL, { timeoutMs: 10000, headers: { accept: "application/json" } }); if (f.err) return { err: f.err }; let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; } const p = parseNyFed(j); return p ? { data: { rate: { date: p.date, value: p.value }, label: "Effective federal funds rate", target: p.targetFrom != null ? { from: p.targetFrom, to: p.targetTo, previous: p.targetPrevious, changedOn: p.targetChangedOn, unchangedSince: p.targetUnchangedSince } : null } } : { err: "no_data" }; } },
  { id: "BOE", name: "Bank of England", ccy: "GBP", page: "https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate",
    load: async () => { const f = await fetchText(BOE_URL, { timeoutMs: 10000, headers: { accept: "text/csv,text/plain,*/*" } }); if (f.err) return { err: f.err }; const p = parseBoe(f.text); return p ? { data: { rate: p, label: "Bank Rate" } } : { err: "no_data" }; } },
  { id: "SNB", name: "Swiss National Bank", ccy: "CHF", page: "https://data.snb.ch/en/topics/snb/cube/snbgwdzid",
    load: async () => { const f = await fetchText(snbUrl(), { timeoutMs: 10000, headers: { accept: "text/csv,text/plain,*/*" } }); if (f.err) return { err: f.err }; const p = parseSnb(f.text); return p ? { data: { rate: p, label: "SNB policy rate" } } : { err: "no_data" }; } },
  { id: "BOC", name: "Bank of Canada", ccy: "CAD", page: "https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/",
    load: async () => { const f = await fetchText(BOC_URL, { timeoutMs: 10000, headers: { accept: "application/json" } }); if (f.err) return { err: f.err }; let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; } const p = parseBoc(j); return p ? { data: { rate: p, label: "Target for the overnight rate" } } : { err: "no_data" }; } },
];
export async function handleCentralBanks(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const res = await Promise.all(BANKS.map((b) => cachedSource({ origin: url.origin, key: `cb3/${b.id}`, ttlMs: 6 * 3600_000, staleMaxMs: 14 * 86400_000, ctx, failTtlMs: 5 * 60_000, load: b.load }).then((r) => ({ b, r }))));
  const banks = res.map(({ b, r }) => ({ id: b.id, name: b.name, ccy: b.ccy, page: b.page, ...(r.data ? { ...r.data, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) } : { status: "N/A", error: r.err }) }));
  return send({ banks, note: "Policy rates as published by each central bank, with their dates. Meetings: see the calendar (Forex Factory).", status: banks.some((b) => b.status !== "N/A") ? "LIVE" : "N/A" }, banks.some((b) => b.status !== "N/A") ? 200 : 502);
}

// ---------- euro-area 2s10s history (ECB AAA spot curve) ----------
export const ECB_SPRD_URL = "https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y+SR_10Y?lastNObservations=270&format=csvdata&detail=dataonly";
export function parseSpread(text) {
  const by = {};
  for (const r of csvRows(text)) { const m = /SR_(2Y|10Y)/.exec(r.KEY || r.DATA_TYPE_FM || ""); const v = numv(r.OBS_VALUE); if (m && r.TIME_PERIOD && Number.isFinite(v)) (by[r.TIME_PERIOD] = by[r.TIME_PERIOD] || {})[m[1]] = v; }
  return Object.entries(by).filter(([, x]) => Number.isFinite(x["2Y"]) && Number.isFinite(x["10Y"])).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, x]) => ({ date: d, y2: x["2Y"], y10: x["10Y"], bp: Math.round((x["10Y"] - x["2Y"]) * 1000) / 10 }));
}
export async function handleSpread(url, env, ctx, H, json) {
  const r = await cachedSource({ origin: url.origin, key: "sprd/EA2", ttlMs: 6 * 3600_000, staleMaxMs: 14 * 86400_000, ctx, failTtlMs: 15 * 60_000,
    load: async () => { const f = await fetchText(ECB_SPRD_URL, { timeoutMs: 25000, headers: { accept: "text/csv" } }); if (f.err) return { err: f.err }; const s = parseSpread(f.text); return s.length > 20 ? { data: s } : { err: "no_data" }; } });
  const out = { series: { EA: r.data ? { name: "Euro area — AAA government bonds, 10Y minus 2Y (spot)", source: "European Central Bank", sourceUrl: "https://data.ecb.europa.eu/data/datasets/YC", points: r.data, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) } : { status: "N/A", error: r.err },
    US: await usSpread(url, env, ctx) }, basis: "daily rates as published (ECB spot; Federal Reserve H.15 constant maturity via FRED); spread = 10Y − 2Y in basis points, only on dates both maturities were published (DERIVED)" };
  const res = json(out, H, r.data || out.series.US.points ? 200 : 502); res.headers.set("cache-control", "no-store"); return res;
}

// U.S. 2s10s from the H.15 constant-maturity yields on FRED: the 2Y and 10Y of the same day, nothing filled in
export function pairSpread(two, ten) { const m = new Map(two || []); return (ten || []).filter(([d]) => m.has(d)).map(([d, y10]) => ({ date: d, y2: m.get(d), y10, bp: Math.round((y10 - m.get(d)) * 1000) / 10 })); }
async function usSpread(url, env, ctx) {
  if (!env.FRED_KEY) return { status: "N/A", error: "fred_not_configured" };
  const [a, b] = await Promise.all(["DGS2", "DGS10"].map((id) => cachedSource({ origin: url.origin, key: `fred/${id}/270`, ttlMs: 3 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, failTtlMs: 10 * 60_000, load: () => fredSeries(env, id, 270) })));
  if (!a.data || !b.data) return { status: "N/A", error: a.err || b.err || "no_data" };
  const pts = pairSpread(a.data, b.data);
  if (pts.length < 20) return { status: "N/A", error: "no_data" };
  return { name: "United States — Treasury constant maturity, 10Y minus 2Y", source: "FRED · Federal Reserve H.15", sourceUrl: "https://fred.stlouisfed.org/series/T10Y2Y", points: pts,
    status: a.cache === "STALE" || b.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(Math.min(a.fetchedAt, b.fetchedAt)) };
}

// ---------- energy (EIA) ----------
export const EIA_SPOT = [
  ["petroleum/pri/spt", "RWTC", "WTI crude (Cushing)", "$/bbl"], ["petroleum/pri/spt", "RBRTE", "Brent crude (Europe)", "$/bbl"],
  ["petroleum/pri/spt", "EER_EPMRU_PF4_Y35NY_DPG", "Gasoline (NY Harbor)", "$/gal"], ["petroleum/pri/spt", "EER_EPD2F_PF4_Y35NY_DPG", "Heating oil (NY Harbor)", "$/gal"],
  ["petroleum/pri/spt", "EER_EPD2DXL0_PF4_Y35NY_DPG", "Ultra-low sulfur diesel (NY Harbor)", "$/gal"], ["petroleum/pri/spt", "EER_EPJK_PF4_RGC_DPG", "Jet fuel (Gulf Coast)", "$/gal"],
  ["petroleum/pri/spt", "EER_EPLLPA_PF4_Y44MB_DPG", "Propane (Mont Belvieu)", "$/gal"], ["natural-gas/pri/fut", "RNGWHHD", "Natural gas (Henry Hub)", "$/MMBtu"],
];
// EIA's NYMEX futures series (RCLC1-4, RNGC1-4) stop at 2024-04-05 ("Futures prices after April 5, 2024, are not available"):
// they are not requested; the curves by contract month are FCRV (CNBC). A spot series that stops updating is N/A, not stale-as-live.
export const EIA_FUTURES_NOTE = { status: "N/A", error: "source_discontinued", lastDate: "2024-04-05", note: "EIA no longer publishes NYMEX futures prices after 2024-04-05; futures curves by contract month: FCRV (CNBC)" };
const SPOT_MAX_AGE_DAYS = 21, STOCK_MAX_AGE_DAYS = 28;
const ageDays = (d, now) => (now - Date.parse(d + "T00:00:00Z")) / 86400_000;
// the key can only travel in the URL of the server's request to EIA (EIA ignores headers); it is never logged or returned
const eiaUrl = (route, series, key, length, freq = "daily") => `https://api.eia.gov/v2/${route}/data/?${new URLSearchParams([["api_key", key], ["frequency", freq], ["data[0]", "value"], ...series.map((s) => ["facets[series][]", s]), ["sort[0][column]", "period"], ["sort[0][direction]", "desc"], ["length", String(length)]])}`;
export function parseEia(j) {
  const rows = j && j.response && Array.isArray(j.response.data) ? j.response.data : [];
  const out = {};
  for (const r of rows) { const v = numv(r.value); if (r.series && r.period && Number.isFinite(v)) (out[r.series] = out[r.series] || []).push([r.period, v]); }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}
const EIA_TIMEOUT_MS = 45000; // scheduled runs only: they can wait
async function eiaLoad(env, route, series, length, freq = "daily", timeoutMs = 15000) {
  if (!env.EIA_KEY) return { err: "eia_not_configured" };
  const f = await fetchText(eiaUrl(route, series, env.EIA_KEY, length, freq), { timeoutMs, headers: { accept: "application/json" } });
  if (f.err) return { err: f.http === 403 ? "provider_auth" : f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  if (j && j.error) return { err: "provider_error" };
  const d = parseEia(j);
  return Object.keys(d).length ? { data: d } : { err: "no_data" };
}
const chgFrom = (s, back) => (s && s.length > back ? (s[s.length - 1][1] / s[s.length - 1 - back][1] - 1) * 100 : null);
// the same EIA daily spot series as FRED republishes them (used when EIA_KEY is not set; futures contracts are EIA-only)
export const EIA_ON_FRED = { RWTC: "DCOILWTICO", RBRTE: "DCOILBRENTEU", EER_EPMRU_PF4_Y35NY_DPG: "DGASNYH", EER_EPD2F_PF4_Y35NY_DPG: "DHOILNYH",
  EER_EPD2DXL0_PF4_Y35NY_DPG: "DDFUELNYH", EER_EPJK_PF4_RGC_DPG: "DJFUELUSGULF", EER_EPLLPA_PF4_Y44MB_DPG: "DPROPANEMBTX", RNGWHHD: "DHHNGSP" };
export const spotRow = (s, name, unit, x, series, now = Date.now()) => (!x || !x.length ? { series, name, unit, status: "N/A", error: "no_data" }
  : ageDays(x[x.length - 1][0], now) > SPOT_MAX_AGE_DAYS ? { series, name, unit, status: "N/A", error: "source_discontinued", lastDate: x[x.length - 1][0] }
  : { series, name, unit, date: x[x.length - 1][0], value: x[x.length - 1][1], chg1: chgFrom(x, 1), chg5: chgFrom(x, 5), chg21: chgFrom(x, 21), history: x.slice(-260) });
const fredEnergy = (origin, env, ctx) => cachedSource({ origin, key: "fred/energy/v1", ttlMs: 6 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, failTtlMs: 15 * 60_000,
  load: async () => {
    const ids = EIA_SPOT.map(([, s]) => EIA_ON_FRED[s]), res = await Promise.all(ids.map((id) => fredSeries(env, id, 300)));
    if (res.some((x) => x.err === "provider_auth")) return { err: "provider_auth" };
    const d = {}; EIA_SPOT.forEach(([, s], i) => { if (res[i].data) d[s] = res[i].data; });
    return Object.keys(d).length ? { data: d } : { err: res.map((x) => x.err).find(Boolean) || "no_data" };
  } });
const SPOT_ROUTES = [...new Set(EIA_SPOT.map(([r]) => r))];
const spotLoad = (env, route, timeoutMs) => eiaLoad(env, route, EIA_SPOT.filter(([r]) => r === route).map(([, s]) => s), 600, "daily", timeoutMs);
// a page reads the copy the scheduled run keeps in KV (never calls EIA); a scheduled run (ctx.store) may load, and wait
const eiaReadCtx = (env, ctx) => (ctx && ctx.store ? ctx : env.BRIEFS ? { store: kvStore(env.BRIEFS), readOnly: true } : ctx);
const eiaSpot = (origin, env, ctx) => Promise.all(SPOT_ROUTES.map((route) => cachedSource({ origin, key: `eia/spot/${route}`, ttlMs: EIA_FRESH_MS, staleMaxMs: 10 * 86400_000, ctx: eiaReadCtx(env, ctx), failTtlMs: 15 * 60_000,
  load: () => spotLoad(env, route, ctx && ctx.store ? EIA_TIMEOUT_MS : 15000) })));
// the EIA daily spot prices (EIA with EIA_KEY, otherwise the same series on FRED): one row per series, each with its own date
export async function getEnergySpot(origin, env, ctx) {
  if (env.EIA_KEY) {
    const res = await eiaSpot(origin, env, ctx), d = Object.assign({}, ...res.map((r) => r.data || {}));
    const eiaErr = (res.find((r) => r.err) || {}).err || "no_data";
    if (!Object.keys(d).length && !env.FRED_KEY) return { err: eiaErr };
    if (!Object.keys(d).length) { const f = await fredSpot(origin, env, ctx); return f.spot ? { ...f, eiaError: eiaErr } : f; } // EIA unreachable: the same series on FRED
    const ok = res.filter((r) => r.data);
    return { spot: EIA_SPOT.map(([, s, name, unit]) => spotRow(s, name, unit, d[s], s)), source: "U.S. Energy Information Administration (EIA) spot prices", sourceUrl: "https://www.eia.gov/opendata/",
      fetchedAt: Math.min(...ok.map((r) => r.fetchedAt)), cache: ok.some((r) => r.cache === "STALE") ? "STALE" : "HIT", partialError: res.find((r) => r.err && !r.data)?.err };
  }
  if (!env.FRED_KEY) return { err: "eia_not_configured" };
  return fredSpot(origin, env, ctx);
}
async function fredSpot(origin, env, ctx) {
  const r = await fredEnergy(origin, env, ctx);
  if (!r.data) return { err: r.err };
  return { spot: EIA_SPOT.map(([, s, name, unit]) => spotRow(s, name, unit, r.data[s], EIA_ON_FRED[s])), source: "U.S. Energy Information Administration (EIA) spot prices, via FRED", sourceUrl: "https://fred.stlouisfed.org/",
    fetchedAt: r.fetchedAt, cache: r.cache, viaFred: true };
}
async function energyFromFred(url, env, ctx, send, eiaError) {
  const e = eiaError ? await fredSpot(url.origin, env, ctx) : await getEnergySpot(url.origin, env, ctx);
  if (!e.spot) return send({ error: e.err, status: "N/A" }, 502);
  return send({ spot: e.spot, futures: EIA_FUTURES_NOTE, source: e.source, sourceUrl: e.sourceUrl, basis: "EIA publishes with a lag of about a week; dates are the price dates", ...(eiaError ? { eiaError } : {}),
    fetchedAt: iso(e.fetchedAt), status: e.cache === "STALE" ? "STALE" : "LIVE" });
}
// ---------- weekly inventories (EIA Weekly Petroleum Status Report, Weekly Natural Gas Storage Report) ----------
// [route, series, name, display unit, divisor from EIA's unit (thousand barrels → million), kind]
export const EIA_STOCKS = [
  ["petroleum/stoc/wstk", "WCESTUS1", "Crude oil (excl. SPR)", "M bbl", 1000, "stock"],
  ["petroleum/stoc/wstk", "W_EPC0_SAX_YCUOK_MBBL", "Crude oil at Cushing, OK", "M bbl", 1000, "stock"],
  ["petroleum/stoc/wstk", "WCSSTUS1", "Strategic Petroleum Reserve", "M bbl", 1000, "stock"],
  ["petroleum/stoc/wstk", "WGTSTUS1", "Motor gasoline", "M bbl", 1000, "stock"],
  ["petroleum/stoc/wstk", "WDISTUS1", "Distillate fuel oil", "M bbl", 1000, "stock"],
  ["petroleum/stoc/wstk", "WKJSTUS1", "Jet fuel (kerosene-type)", "M bbl", 1000, "stock"],
  ["natural-gas/stor/wkly", "NW2_EPG0_SWO_R48_BCF", "Natural gas in storage (Lower 48)", "Bcf", 1, "stock"],
  ["petroleum/pnp/wiup", "WPULEUS3", "Refinery utilization", "%", 1, "rate"],
  ["petroleum/sum/sndw", "WCRFPUS2", "Crude oil production", "M b/d", 1000, "rate"],
];
const EIA_FRESH_MS = 8 * 3600_000, EIA_REFRESH_MS = 4 * 3600_000; // a staged copy is LIVE for 8 h; the scheduled run renews it after 4 h
const DAY_MS = 86400_000, STOCK_WEEKS = 275; // five years of weeks (261) plus a margin: enough for the 5-year average
// the observation nearest to a date (within 4 days), for "a year ago" and the same week of earlier years
// (ts holds the observations' times, computed once: a few hundred Date.parse per series, not thousands)
const nearest = (s, ts, t) => { let best = null, bd = 4 * DAY_MS + DAY_MS / 2; for (let i = 0; i < s.length; i++) { const x = Math.abs(ts[i] - t); if (x < bd) { bd = x; best = s[i]; } } return best; };
// one series of weekly observations [[date, value]] (EIA units) → the row shown, in display units; DERIVED changes
export function stockRow(series, name, unit, div, kind, x, now = Date.now()) {
  if (!x || !x.length) return { series, name, unit, status: "N/A", error: "no_data" };
  if (ageDays(x[x.length - 1][0], now) > STOCK_MAX_AGE_DAYS) return { series, name, unit, status: "N/A", error: "source_discontinued", lastDate: x[x.length - 1][0] };
  const v = (y) => (y == null ? null : Math.round((y / div) * 1000) / 1000), [d, last] = x[x.length - 1], ts = x.map(([dd]) => Date.parse(dd + "T00:00:00Z")), t = ts[ts.length - 1];
  const prev = x.length > 1 ? x[x.length - 2][1] : null, ya = nearest(x, ts, t - 364 * DAY_MS);
  const past = [1, 2, 3, 4, 5].map((k) => nearest(x, ts, t - 364 * k * DAY_MS)).filter(Boolean), avg5 = past.length === 5 ? past.reduce((a, p) => a + p[1], 0) / 5 : null;
  return { series, name, unit, kind, date: d, value: v(last), chgWeek: prev == null ? null : v(last - prev), vsYearAgo: ya ? v(last - ya[1]) : null, yearAgoDate: ya ? ya[0] : null,
    avg5: avg5 == null ? null : v(avg5), vsAvg5Pct: avg5 && kind === "stock" ? Math.round((last / avg5 - 1) * 1000) / 10 : null, history: x.slice(-60).map(([dd, y]) => [dd, v(y)]) };
}
// one EIA route → its rows, already derived: the cache keeps ~60 points per series, not five years of raw weeks
async function loadStockRoute(env, route, timeoutMs = 15000) {
  const defs = EIA_STOCKS.filter(([r]) => r === route), r = await eiaLoad(env, route, defs.map(([, s]) => s), STOCK_WEEKS * defs.length, "weekly", timeoutMs);
  if (!r.data) return r;
  const out = {};
  for (const [, s, name, unit, div, kind] of defs) if (r.data[s]) out[s] = stockRow(s, name, unit, div, kind, r.data[s]);
  return Object.keys(out).length ? { data: out } : { err: "no_data" };
}
export async function handleEnergyStocks(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.EIA_KEY) return send({ error: "eia_not_configured", status: "N/A", message: "EIA API key not set in the Worker (EIA_KEY)" }, 503);
  const routes = [...new Set(EIA_STOCKS.map(([r]) => r))];
  const res = await Promise.all(routes.map((route) => cachedSource({ origin: url.origin, key: `eia/stocks2/${route}`, ttlMs: EIA_FRESH_MS, staleMaxMs: 14 * 86400_000, ctx: eiaReadCtx(env, ctx), failTtlMs: 15 * 60_000,
    load: () => loadStockRoute(env, route) })));
  const d = Object.assign({}, ...res.map((r) => r.data || {})), errors = {};
  routes.forEach((r, i) => { if (!res[i].data) errors[r] = res[i].err; });
  const rows = EIA_STOCKS.map(([, s, name, unit]) => d[s] || { series: s, name, unit, status: "N/A", error: "no_data" });
  const ok = rows.some((r) => r.value != null);
  return send({ rows, errors, ...(ok ? {} : { error: Object.values(errors)[0] || "no_data" }), source: "U.S. Energy Information Administration (EIA) — Weekly Petroleum Status Report, Weekly Natural Gas Storage Report", sourceUrl: "https://www.eia.gov/petroleum/supply/weekly/",
    basis: "levels as EIA publishes them for the week ending on the date shown (released Wednesdays for petroleum, Thursdays for natural gas); weekly change, change from a year earlier and the 5-year average for the same week are DERIVED from EIA's own series",
    ...(Object.values(errors).includes("not_staged") ? { note: "EIA answers slowly: the scheduled run fetches each EIA table every few minutes until all are in" } : {}),
    status: !ok ? "N/A" : res.some((r) => r.cache === "STALE") ? "STALE" : Object.keys(errors).length ? "PARTIAL" : "LIVE" }, ok ? 200 : 502);
}

// ---------- scheduled refresh (the 5-minute run): the most overdue EIA table, one request per run ----------
export const EIA_UNITS = [
  ...SPOT_ROUTES.map((route) => ({ key: `eia/spot/${route}`, load: (env) => spotLoad(env, route, EIA_TIMEOUT_MS) })),
  ...[...new Set(EIA_STOCKS.map(([r]) => r))].map((route) => ({ key: `eia/stocks2/${route}`, load: (env) => loadStockRoute(env, route, EIA_TIMEOUT_MS) })),
];
// one EIA request per run (CPU: one payload parsed per invocation); a failure writes nothing and is retried next run
export async function refreshEia(env, now = Date.now()) {
  if (!env.EIA_KEY || !env.BRIEFS) return { action: "skipped" };
  const store = kvStore(env.BRIEFS), ent = await Promise.all(EIA_UNITS.map((u) => store.get(u.key)));
  const ages = ent.map((e) => (e && e.data && Number.isFinite(e.fetchedAt) ? now - e.fetchedAt : Infinity));
  let i = -1; ages.forEach((a, k) => { if (a >= EIA_REFRESH_MS && (i < 0 || a > ages[i])) i = k; });
  if (i < 0) return { action: "fresh" };
  const r = await EIA_UNITS[i].load(env);
  if (!r || !r.data) return { action: "failed", key: EIA_UNITS[i].key, err: (r && r.err) || "provider_error" };
  await store.put(EIA_UNITS[i].key, { data: r.data, fetchedAt: Date.now() }, 3 * 86400);
  return { action: "refreshed", key: EIA_UNITS[i].key };
}

export async function handleEnergy(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.EIA_KEY && env.FRED_KEY) return energyFromFred(url, env, ctx, send);
  if (!env.EIA_KEY) return send({ error: "eia_not_configured", status: "N/A", message: "EIA API key not set in the Worker (EIA_KEY)" }, 503);
  const spotRes = await eiaSpot(url.origin, env, ctx);
  const spotData = Object.assign({}, ...spotRes.map((r) => r.data || {}));
  if (!Object.keys(spotData).length && env.FRED_KEY) return energyFromFred(url, env, ctx, send, (spotRes.find((r) => r.err) || {}).err || "no_data"); // EIA unreachable: FRED's copy
  const spot = EIA_SPOT.map(([, s, name, unit]) => spotRow(s, name, unit, spotData[s], s));
  const anyErr = spotRes.find((r) => r.err && !r.data), ok = spotRes.filter((r) => r.data);
  return send({ spot, futures: EIA_FUTURES_NOTE, source: "U.S. Energy Information Administration (EIA) — daily spot prices", sourceUrl: "https://www.eia.gov/opendata/", basis: "EIA publishes with a lag of about a week; dates are the price dates",
    ...(ok.length ? { fetchedAt: iso(Math.min(...ok.map((r) => r.fetchedAt))) } : {}), ...(anyErr ? { partialError: anyErr.err } : {}),
    status: !spot.some((x) => x.value != null) ? "N/A" : ok.some((r) => r.cache === "STALE") ? "STALE" : anyErr ? "PARTIAL" : "LIVE" });
}
