// FACTORS — Fama/French factor exposure (FACT; provider approved 21 Oct 2026)
//   factors      Kenneth R. French Data Library (Tuck School of Business, Dartmouth): the monthly research factors — five
//                factors (Mkt-RF, SMB, HML, RMW, CMA) with the risk-free rate, and momentum — for Developed (23 countries),
//                Europe (16) and the U.S.; returns in USD, in %, published once a month about two months behind. One ZIP
//                of one CSV per file, no key. Downloaded on use at most once a day and kept in KV (ff/<region>); a failed
//                download keeps the last real copy (STALE) and is not tried again for 6 hours.
//   instruments  CNBC's daily bars: the last close of each calendar month, converted to USD at CNBC's FX close of the same
//                day (EUR= / GBP= USD per unit, CHF= CHF per USD) — DERIVED; the month's return from two month-ends in a row.
//   regression   computed in the page (qmath.js): this module only lines the months up. No value is filled in: a month
//                without a close, an FX rate or a factor is left out.
import { fetchBinary, unzipEntry, zipNames, iso } from "./lib.mjs";
import { cnbcDaily } from "./cnbc.mjs";
import { cnbcDailyB } from "./backup.mjs";
import { loadCnbcRaw, isCnbcId, cnbcCodeFor, cnbcForeignFallback } from "./intl.mjs";
import { isinValid } from "./isin.mjs";
import { UCITS_ETFS, lineOf } from "./ucits.mjs";
import { tableMap } from "./etfref.mjs";
import { fundLines } from "./etf.mjs";

export const FF_SOURCE = "Kenneth R. French Data Library";
export const FF_PAGE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html";
export const FF_BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/";
export const FF_REGIONS = {
  dev: { name: "Developed", files: ["Developed_5_Factors_CSV.zip", "Developed_Mom_Factor_CSV.zip"], about: "23 developed countries, the U.S. included" },
  eu: { name: "Europe", files: ["Europe_5_Factors_CSV.zip", "Europe_Mom_Factor_CSV.zip"], about: "16 European countries, the U.K. and Switzerland included" },
  us: { name: "U.S.", files: ["F-F_Research_Data_5_Factors_2x3_CSV.zip", "F-F_Momentum_Factor_CSV.zip"], about: "NYSE, AMEX and NASDAQ stocks" },
};
export const FF_COLS = ["mkt", "smb", "hml", "rmw", "cma", "mom", "rf"];
const DAY = 86400_000, REFRESH = DAY, FAIL_WAIT = 6 * 3600_000, KEEP = 120 * 86400, MAX_ITEMS = 8;
const put = (env, k, v) => env.BRIEFS.put(k, JSON.stringify(v), { expirationTtl: KEEP });
const getJ = async (env, k) => { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : null; } catch { return null; } };

// ---------- the library's CSV ----------
// a few lines of description, a header that starts with a comma (",Mkt-RF,SMB,HML,RMW,CMA,RF" or ",WML" / ",Mom"), one line
// per month ("199007,   0.86, …"), then a blank line and the annual factors (years, left out). Values in %; -99.99 or
// -999 mark a missing value (left out, never filled in).
const colKey = (s) => { const t = String(s || "").trim().toUpperCase(); return t.startsWith("MKT") ? "mkt" : t === "SMB" ? "smb" : t === "HML" ? "hml" : t === "RMW" ? "rmw" : t === "CMA" ? "cma" : t === "RF" ? "rf" : t === "WML" || t === "MOM" ? "mom" : null; };
export function parseFf(text) {
  let cols = null; const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const l = raw.trim();
    if (!cols) { if (l.startsWith(",") && l.split(",").slice(1).some((c) => colKey(c))) cols = l.split(",").slice(1).map(colKey); continue; }
    const m = /^(\d{4})(\d{2})\s*,(.*)$/.exec(l);
    if (!m) { if (rows.length) break; continue; }
    const v = m[3].split(",").map((x) => { const n = Number(x.trim()); return x.trim() !== "" && Number.isFinite(n) && n > -99 ? n / 100 : null; });
    const rec = { month: `${m[1]}-${m[2]}` }; cols.forEach((k, i) => { if (k) rec[k] = v[i] ?? null; });
    rows.push(rec);
  }
  return cols && rows.length ? { cols: cols.filter(Boolean), rows } : null;
}
// the five-factor file and the momentum file → one row a month: [month, mkt, smb, hml, rmw, cma, mom, rf]
export function mergeFf(five, mom) {
  const mm = new Map(mom.rows.map((r) => [r.month, r.mom]));
  return { cols: FF_COLS, rows: five.rows.map((r) => [r.month, r.mkt ?? null, r.smb ?? null, r.hml ?? null, r.rmw ?? null, r.cma ?? null, mm.has(r.month) ? mm.get(r.month) : null, r.rf ?? null]) };
}

// ---------- the factors of a region: KV, refreshed at most once a day on use ----------
async function readZipCsv(fetchImpl, url) {
  const r = await fetchImpl(url, { timeoutMs: 15000 });
  if (r.err) return { err: r.err };
  const names = zipNames(r.buf), csv = names.find((n) => /\.csv$/i.test(n)) || names[0];
  const text = csv ? await unzipEntry(r.buf, csv) : null;
  const p = text ? parseFf(text) : null;
  return p ? { data: p, file: csv } : { err: "provider_error" };
}
export async function loadFactors(env, region, now = Date.now(), fetchImpl = fetchBinary) {
  const R = FF_REGIONS[region]; if (!R) return { err: "bad_request" };
  const key = "ff/" + region, kept = await getJ(env, key);
  if (kept && kept.rows && now - kept.fetchedAt < REFRESH) return { data: kept, status: "LIVE" };
  if (kept && kept.rows && kept.failAt && now - kept.failAt < FAIL_WAIT) return { data: kept, status: "STALE", staleReason: kept.failErr || "provider_error" };
  const [five, mom] = await Promise.all(R.files.map((f) => readZipCsv(fetchImpl, FF_BASE + f)));
  let err = five.err || mom.err || null;
  if (!err) {
    const m = mergeFf(five.data, mom.data), last = m.rows.length ? m.rows[m.rows.length - 1][0] : null;
    if (m.rows.length >= 36 && five.data.cols.includes("mkt") && five.data.cols.includes("rf") && mom.data.cols.includes("mom")) {
      const data = { region, ...m, asOf: last, fetchedAt: now, files: R.files.map((f) => FF_BASE + f) };
      await put(env, key, data);
      return { data, status: "LIVE" };
    }
    err = "provider_error";
  }
  if (kept && kept.rows) { await put(env, key, { ...kept, failAt: now, failErr: err }); return { data: kept, status: "STALE", staleReason: err }; }
  return { err };
}

// ---------- the instruments: a typed id → the CNBC listing used ----------
// an ISIN (its USD line where the UCITS list has one, else its default line; else its Xetra line), a CNBC code (C:EUNL-DE),
// a Twelve Data symbol with its MIC (SAP:XETR → SAP-DE), or a plain U.S. symbol (CNBC's own). A code that is a line of a
// fund (UCITS list, Xetra list) carries the fund's ISIN: its justETF focus picks the region.
const UCITS_BY_CODE = new Map();
for (const e of UCITS_ETFS) for (const l of Object.values(e.lines).concat([e.def])) if (!UCITS_BY_CODE.has(l.cnbc) || (l.ccy && !UCITS_BY_CODE.get(l.cnbc).l.ccy)) UCITS_BY_CODE.set(l.cnbc, { e, l });
const xetraLines = (row) => String(row[5] || "").split(" ").filter(Boolean).map((t) => t.split(":"));
// the Xetra list (KV etf/universe) as two maps: by ISIN, and by CNBC code (MNEMONIC-DE)
export function uniMaps(uni) {
  const byIsin = new Map(), byCode = new Map();
  for (const r of (uni && uni.rows) || []) { byIsin.set(r[0], r); for (const [mn] of xetraLines(r)) if (!byCode.has(mn + "-DE")) byCode.set(mn + "-DE", r); }
  return { byIsin, byCode };
}
export function factorTarget(id, uni = {}) {
  const s = String(id || "").trim().toUpperCase();
  if (isinValid(s)) {
    const u = UCITS_ETFS.find((e) => e.isin === s);
    if (u) { const l = u.lines.USD || u.def; return { id: s, isin: s, name: u.name, cnbc: l.cnbc, ccy: l.ccy || null, pence: !!l.pence, venue: l.venue, ticker: l.ticker }; }
    const row = uni.byIsin && uni.byIsin.get(s);
    if (row) {
      const xl = xetraLines(row), p = xl.find((x) => x[1] === "EUR") || xl[0];
      if (p) { const l = lineOf(p[0] + "-DE", null); return { id: s, isin: s, name: row[1], cnbc: l.cnbc, ccy: null, pence: false, venue: l.venue, ticker: l.ticker }; }
    }
    return { id: s, isin: s, error: "not_listed" };
  }
  const code = isCnbcId(s) ? s.slice(2) : cnbcCodeFor(s);
  if (code) {
    const m = UCITS_BY_CODE.get(code); if (m) return { id: s, isin: m.e.isin, name: m.e.name, cnbc: code, ccy: m.l.ccy || null, pence: !!m.l.pence, venue: m.l.venue, ticker: m.l.ticker };
    const row = uni.byCode && uni.byCode.get(code); if (row) return { id: s, isin: row[0], name: row[1], cnbc: code, ccy: null, pence: false, venue: "Xetra", ticker: code.slice(0, -3) };
    return { id: s, cnbc: code, ccy: null, pence: false, venue: null, ticker: code };
  }
  if (/^[A-Z][A-Z0-9.]{0,9}$/.test(s)) return { id: s, cnbc: s, ccy: null, pence: false, venue: "U.S.", ticker: s, us: true };
  return { id: s, error: "unsupported" };
}

// an ISIN on neither list (an ETF listed off Xetra): its listings through the terminal's ISIN search (OpenFIGI / Twelve
// Data → CNBC codes, as the ETF profile finds them), the line in the currency first, else the first one (EUR lines first)
export async function offListTarget(url, env, ctx, isin, to, lines = fundLines) {
  const L = await lines(url, env, ctx, isin, null), list = (L && L.lines) || [];
  const l = list.find((x) => x.ccy === to) || list[0];
  return l ? { id: isin, isin, name: l.name || null, cnbc: l.cnbc, ccy: l.ccy, pence: !!l.pence, venue: l.venue, ticker: l.ticker, offList: true } : { id: isin, isin, error: "not_listed" };
}
// ---------- monthly series ----------
// the last daily close of each calendar month: [["2026-08", close, "2026-08-31"]]
export function monthEnds(rows) {
  const out = [];
  for (const [d, v] of rows) { if (!(v > 0)) continue; const m = d.slice(0, 7), last = out[out.length - 1]; if (last && last[0] === m) { last[1] = v; last[2] = d; } else out.push([m, v, d]); }
  return out;
}
// the close on or before each date (dates ascending; one pass)
export function valuesOn(rows, dates) {
  const out = []; let j = 0, v = null;
  for (const d of dates) { while (j < rows.length && rows[j][0] <= d) { v = rows[j][1]; j++; } out.push(v); }
  return out;
}
export const usdPer = (c, fx) => (c === "USD" ? 1 : c === "EUR" ? fx["EUR="] : c === "GBP" ? fx["GBP="] : c === "CHF" ? (fx["CHF="] > 0 ? 1 / fx["CHF="] : null) : null);
export const FX_CODES = ["EUR=", "GBP=", "CHF="];
// month-ends in USD, then the returns of consecutive months: { months: ["2021-11", …], r: [0.0123, …] }
export function monthlyUsd(rows, ccy, pence, fxRows) {
  const me = monthEnds(rows), dates = me.map((x) => x[2]), unit = pence ? 100 : 1;
  const fxv = {}; if (ccy !== "USD") for (const c of FX_CODES) if (fxRows[c]) fxv[c] = valuesOn(fxRows[c], dates);
  const lv = me.map((x, i) => { const fx = {}; for (const c in fxv) fx[c] = fxv[c][i]; const k = usdPer(ccy, fx); return k > 0 ? [x[0], (x[1] / unit) * k] : [x[0], null]; });
  const months = [], r = [];
  for (let i = 1; i < lv.length; i++) {
    const [m0, a] = lv[i - 1], [m1, b] = lv[i];
    const [y0, mo0] = m0.split("-").map(Number), [y1, mo1] = m1.split("-").map(Number);
    if (!(a > 0 && b > 0) || (y1 * 12 + mo1) - (y0 * 12 + mo0) !== 1) continue; // consecutive months only
    months.push(m1); r.push(b / a - 1);
  }
  return { months, r };
}

// the region that fits what is analysed: every target a plain U.S. symbol → U.S.; European listings and funds with a
// European focus → Europe; otherwise (global funds, a mix) → Developed. An emerging-markets fund has no region here: said.
export function autoRegion(targets, focusOf) {
  const ok = targets.filter((t) => !t.error); if (!ok.length) return { region: "dev", why: "default" };
  const kind = ok.map((t) => {
    const f = String((t.isin && focusOf(t.isin)) || "").toLowerCase();
    if (/emerging/.test(f)) return "em";
    if (t.isin) return /united states|north america/.test(f) ? "us" : /europe|eurozone|euro area|germany|france|italy|united kingdom|switzerland|spain/.test(f) && !/world/.test(f) ? "eu" : "dev";
    if (t.us) return "us";
    return /-(DE|IT|FR|NL|GB|CH|ES|BE|PT|FI|NO|SE|IE|FF)$/.test(t.cnbc) ? "eu" : "dev";
  });
  const em = kind.includes("em"), k = kind.filter((x) => x !== "em");
  const region = k.length && k.every((x) => x === "us") ? "us" : k.length && k.every((x) => x === "eu") ? "eu" : "dev";
  return { region, why: k.length && k.every((x) => x === region) ? "listing_or_focus" : "mixed", emerging: em };
}

// ---------- the page's request ----------
//   GET /api/factors?ids=ID[:weight],…&region=auto|dev|eu|us&years=5|10
//   → the region's monthly factors over the window, and each instrument's monthly USD returns (DERIVED from CNBC)
export async function handleFactors(url, env, ctx, H, json, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "not_configured", status: "N/A" }, 503);
  const now = deps.now || Date.now();
  const raw = String(url.searchParams.get("ids") || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!raw.length || raw.length > MAX_ITEMS) return send({ error: "bad_request", message: `ids: 1 to ${MAX_ITEMS}` }, 400);
  const years = url.searchParams.get("years") === "10" ? 10 : 5, want = String(url.searchParams.get("region") || "auto");
  if (want !== "auto" && !FF_REGIONS[want]) return send({ error: "bad_request", message: "region: auto, dev, eu or us" }, 400);
  const items = raw.map((x) => { const i = x.lastIndexOf(":"), w = i > 0 ? Number(x.slice(i + 1)) : NaN; return Number.isFinite(w) && /^[\d.]+$/.test(x.slice(i + 1)) ? { id: x.slice(0, i), weight: w } : { id: x, weight: null }; });
  const uni = items.some((x) => isinValid(x.id.toUpperCase()) || /-DE$|:XETR$/.test(x.id.toUpperCase())) ? uniMaps(await getJ(env, "etf/universe")) : {};
  const targets = items.map((x) => ({ ...factorTarget(x.id, uni), weight: x.weight }));
  // an ISIN on neither list: its listings through the ISIN search (as the ETF profile finds them)
  for (let i = 0; i < targets.length; i++) if (targets[i].error === "not_listed" && targets[i].isin) targets[i] = { ...(await offListTarget(url, env, ctx, targets[i].isin, "USD", deps.fundLines)), weight: targets[i].weight };
  // the listing's currency and name from one CNBC quote request (a venue code CNBC answers from the U.S. is not this listing)
  const codes = [...new Set(targets.filter((t) => !t.error).map((t) => t.cnbc))];
  const q = codes.length ? await (deps.loadQuotes || loadCnbcRaw)(codes) : { data: {} };
  for (const t of targets) {
    if (t.error) continue;
    const r = q.data && q.data[t.cnbc];
    if (r && cnbcForeignFallback(r)) { t.error = "not_carried"; continue; }
    const c = r && r.currencyCode ? String(r.currencyCode) : null;
    if (!t.ccy) { if (!c) { t.error = r ? "no_currency" : "no_quote"; continue; } t.pence = c === "GBp" || c === "GBX"; t.ccy = t.pence ? "GBP" : c; }
    if (!t.name && r && r.name) t.name = String(r.name);
    if (!usdPer(t.ccy, { "EUR=": 1, "GBP=": 1, "CHF=": 1 })) t.error = "fx_unavailable"; // a currency without CNBC FX here
  }
  // the region's factors (refreshed on use) and the table of justETF focus for the auto region
  let region = want, auto = null;
  if (want === "auto") {
    const table = targets.some((t) => t.isin) ? await env.BRIEFS.get("ref/je/table") : "";
    const fm = tableMap(table || "", new Set(targets.filter((t) => t.isin).map((t) => t.isin)));
    auto = autoRegion(targets, (isin) => (fm.get(isin) || [])[11]); region = auto.region;
  }
  const F = await (deps.loadFactors || loadFactors)(env, region, now);
  if (!F.data) return send({ error: F.err || "provider_error", status: "N/A", region, source: FF_SOURCE, sourceUrl: FF_PAGE }, 502);
  const fr = F.data.rows, lastF = F.data.asOf, firstM = (() => { const [y, m] = lastF.split("-").map(Number), k = y * 12 + (m - 1) - (years * 12 - 1); return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`; })();
  const fWin = fr.filter((r) => r[0] >= firstM && r[0] <= lastF);
  // CNBC daily bars over the window (and a month before it), the FX bars when a listing is not in USD
  const days = years === 10 ? 3720 : 1900, ok = targets.filter((t) => !t.error), needFx = ok.some((t) => t.ccy !== "USD");
  const daily = deps.daily || ((code) => cnbcDailyB(url.origin, ctx, code, days, now));
  const [bars, fxRes] = await Promise.all([Promise.all(ok.map((t) => daily(t.cnbc))), needFx ? Promise.all(FX_CODES.map((c) => daily(c))) : []]);
  const fxRows = {}; FX_CODES.forEach((c, i) => { if (fxRes[i] && fxRes[i].data) fxRows[c] = fxRes[i].data; });
  ok.forEach((t, i) => {
    const b = bars[i]; if (!b || !b.data) { t.error = (b && b.err) || "no_data"; return; }
    if (t.ccy !== "USD" && !(t.ccy === "EUR" ? fxRows["EUR="] : t.ccy === "GBP" ? fxRows["GBP="] : fxRows["CHF="])) { t.error = "fx_unavailable"; return; }
    const s = monthlyUsd(b.data, t.ccy, t.pence, fxRows), keep = s.months.map((m, j) => [m, s.r[j]]).filter(([m]) => m >= firstM && m <= lastF);
    t.months = keep.map((x) => x[0]); t.r = keep.map((x) => x[1]); t.firstBar = b.data[0][0]; t.lastBar = b.data[b.data.length - 1][0];
    t.barsStatus = b.cache === "STALE" ? "STALE" : "LIVE"; if (b.backupFor) t.backup = { source: b.source, for: b.backupFor, reason: b.primaryError };
  });
  return send({
    region, regionName: FF_REGIONS[region].name, regionAbout: FF_REGIONS[region].about, auto, years,
    factors: { source: FF_SOURCE, sourceUrl: FF_PAGE, files: F.data.files, cols: FF_COLS, rows: fWin, asOf: lastF, fetchedAt: iso(F.data.fetchedAt), status: F.status, ...(F.staleReason ? { staleReason: F.staleReason } : {}), units: "monthly returns, decimal (the library publishes %), in USD" },
    items: targets.map((t) => ({ id: t.id, weight: t.weight, isin: t.isin || null, name: t.name || null, cnbc: t.cnbc || null, venue: t.venue || null, ticker: t.ticker || null, ccy: t.ccy || null,
      conv: t.ccy && t.ccy !== "USD" ? { from: t.ccy, to: "USD", via: "CNBC FX" } : null, ...(t.error ? { error: t.error } : { months: t.months, r: t.r, firstBar: t.firstBar, lastBar: t.lastBar, status: t.barsStatus, ...(t.backup ? { backup: t.backup } : {}) }) })),
    basis: "month-end = the last CNBC daily bar dated in the month; USD at CNBC's FX close of that day; returns of consecutive months only",
    meta: { generatedAt: iso(now) },
  });
}
