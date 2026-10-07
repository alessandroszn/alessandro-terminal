// RATES & MACRO (T07) — official publications only.
//   GET /api/cb          policy rates: ECB (Data Portal, FM), Fed (New York Fed markets API: EFFR + target range),
//                        Bank of England (Bank Rate, IADB), Swiss National Bank (SNB data portal), Bank of Canada (Valet)
//   GET /api/sprd        2s10s history, daily, about a year: euro area (ECB AAA spot curve) and United States
//                        (FRED, Federal Reserve H.15 constant-maturity 2Y and 10Y; needs FRED_KEY, else N/A)
//   GET /api/energy      EIA (U.S. Energy Information Administration): daily spot prices (crude, products, natural gas)
//                        and NYMEX futures contracts 1–4 (crude, natural gas) — the futures curve. Needs EIA_KEY.
// Every value is the institution's published figure with its date; nothing is filled in between publications.
import { fetchText, cachedSource, parseCsv, iso } from "./lib.mjs";
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
export const EIA_FUT = { crude: ["petroleum/pri/fut", ["RCLC1", "RCLC2", "RCLC3", "RCLC4"], "WTI crude futures (NYMEX)", "$/bbl"], gas: ["natural-gas/pri/fut", ["RNGC1", "RNGC2", "RNGC3", "RNGC4"], "Natural gas futures (NYMEX)", "$/MMBtu"] };
// the key can only travel in the URL of the server's request to EIA (EIA ignores headers); it is never logged or returned
const eiaUrl = (route, series, key, length) => `https://api.eia.gov/v2/${route}/data/?${new URLSearchParams([["api_key", key], ["frequency", "daily"], ["data[0]", "value"], ...series.map((s) => ["facets[series][]", s]), ["sort[0][column]", "period"], ["sort[0][direction]", "desc"], ["length", String(length)]])}`;
export function parseEia(j) {
  const rows = j && j.response && Array.isArray(j.response.data) ? j.response.data : [];
  const out = {};
  for (const r of rows) { const v = numv(r.value); if (r.series && r.period && Number.isFinite(v)) (out[r.series] = out[r.series] || []).push([r.period, v]); }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}
async function eiaLoad(env, route, series, length) {
  if (!env.EIA_KEY) return { err: "eia_not_configured" };
  const f = await fetchText(eiaUrl(route, series, env.EIA_KEY, length), { timeoutMs: 15000, headers: { accept: "application/json" } });
  if (f.err) return { err: f.http === 403 ? "provider_auth" : f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  if (j && j.error) return { err: "provider_error" };
  const d = parseEia(j);
  return Object.keys(d).length ? { data: d } : { err: "no_data" };
}
const chgFrom = (s, back) => (s && s.length > back ? (s[s.length - 1][1] / s[s.length - 1 - back][1] - 1) * 100 : null);
export async function handleEnergy(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.EIA_KEY) return send({ error: "eia_not_configured", status: "N/A", message: "EIA API key not set in the Worker (EIA_KEY)" }, 503);
  const routes = [...new Set(EIA_SPOT.map(([r]) => r))];
  const spotRes = await Promise.all(routes.map((route) => cachedSource({ origin: url.origin, key: `eia/spot/${route}`, ttlMs: 6 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, failTtlMs: 15 * 60_000, load: () => eiaLoad(env, route, EIA_SPOT.filter(([r]) => r === route).map(([, s]) => s), 600) })));
  const futRes = await Promise.all(Object.entries(EIA_FUT).map(([id, [route, series]]) => cachedSource({ origin: url.origin, key: `eia/fut/${id}`, ttlMs: 6 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, failTtlMs: 15 * 60_000, load: () => eiaLoad(env, route, series, 400) })));
  const spotData = Object.assign({}, ...spotRes.map((r) => r.data || {}));
  const spot = EIA_SPOT.map(([, s, name, unit]) => { const x = spotData[s]; return x && x.length ? { series: s, name, unit, date: x[x.length - 1][0], value: x[x.length - 1][1], chg1: chgFrom(x, 1), chg5: chgFrom(x, 5), chg21: chgFrom(x, 21), history: x.slice(-260) } : { series: s, name, unit, status: "N/A" }; });
  const curves = Object.entries(EIA_FUT).map(([id, [, series, name, unit]], i) => {
    const d = futRes[i].data; if (!d) return { id, name, unit, status: "N/A", error: futRes[i].err };
    const dates = [...new Set(series.flatMap((s) => (d[s] || []).map(([p]) => p)))].sort();
    const at = (date) => series.map((s, k) => { const v = (d[s] || []).find(([p]) => p === date); return { contract: k + 1, value: v ? v[1] : null }; });
    const last = dates[dates.length - 1], pick = (n) => dates.filter((x) => x <= last).slice(-1 - n)[0];
    return { id, name, unit, dates: { latest: last, week: pick(5), month: pick(21) }, latest: at(last), week: at(pick(5)), month: at(pick(21)), status: futRes[i].cache === "STALE" ? "STALE" : "LIVE" };
  });
  const anyErr = [...spotRes, ...futRes].find((r) => r.err && !r.data);
  return send({ spot, curves, source: "U.S. Energy Information Administration (EIA) — daily spot and NYMEX futures prices", sourceUrl: "https://www.eia.gov/opendata/", basis: "EIA publishes with a lag of about a week; dates are the price dates", ...(anyErr ? { partialError: anyErr.err } : {}), status: spot.some((x) => x.value != null) || curves.some((c) => c.status !== "N/A") ? "LIVE" : "N/A" });
}
