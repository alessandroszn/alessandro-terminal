// YAS — a fixed-coupon bond's analytics (yield to maturity, durations, cash flows) are computed in the page (qmath.js) from
// the terms and a price. This module gives the terms of an ISIN: first the ECB's list of eligible marketable assets
// (ecbassets.mjs: coupon, issue and maturity dates, currency, issuer — fixed and zero-coupon bonds), then OpenFIGI
// (approved), whose Bloomberg-style ticker carries the coupon and the maturity ("BTPS 3.85 09/01/49", "T 4 1/4 11/15/34",
// "DBR 0 08/15/31", "CCTS F …" = floating) — parsed from the ticker, to be checked against the prospectus. Neither list
// gives the coupon frequency: it is the usual one of the issuer's country (said).
//   GET /api/bond/ref?isin=
//   GET /api/bond/list?cc=IT[&group=IG2][&q=]   the ECB list's bonds of one issuer country (central government by default)
import { isinValid, openFigiRows } from "./isin.mjs";
import { cachedSource } from "./lib.mjs";
import { eaTable, eaHead, eaLookup, eaList, ECB_EA_PAGE, ISSUER_GROUPS, EA_STATE } from "./ecbassets.mjs";

// "3.85" → 3.85, "4 1/4" → 4.25, "1/2" → 0.5, "0" → 0
export function couponOf(s) {
  const t = String(s || "").trim(), m = /^(\d+(?:\.\d+)?)?(?:\s*(\d+)\/(\d+))?$/.exec(t); if (!m || (!m[1] && !m[2])) return null;
  return (m[1] ? Number(m[1]) : 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}
// a bond ticker → { issuer, coupon, maturity, floating }
export function parseBondTicker(t) {
  const m = /^([A-Z0-9][A-Z0-9-]*)\s+(F|V|FRN|\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s+(\d{2})\/(\d{2})\/(\d{2}|\d{4})\b/.exec(String(t || "").trim().toUpperCase());
  if (!m) return null;
  const yy = m[5].length === 4 ? Number(m[5]) : 2000 + Number(m[5]), maturity = `${yy}-${m[3]}-${m[4]}`;
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(maturity)) return null;
  if (/^(F|V|FRN)$/.test(m[2])) return { issuer: m[1], coupon: null, maturity, floating: true };
  const c = couponOf(m[2]); return c == null ? null : { issuer: m[1], coupon: c, maturity, floating: false };
}
// the usual coupon frequency by the issuer's country: Italy / U.S. semi-annual; Germany, France, most of the euro area annual
export const FREQ_BY_COUNTRY = { IT: 2, US: 2, GB: 2, DE: 1, FR: 1, NL: 1, AT: 1, BE: 1, ES: 1, PT: 1, FI: 1, IE: 1, XS: 1, EU: 1 };
// the frequency for a country, else for a currency (U.S. dollar and pound bonds pay twice a year as a rule), else once
// (the country's rule only for a bond in its own currency: a British bank's dollar bond follows the dollar's)
export function freqOf(cc, ccy) {
  const home = homeCcy(cc);
  if (FREQ_BY_COUNTRY[cc] && cc !== "XS" && cc !== "EU" && (!ccy || !home || home === ccy)) return { freq: FREQ_BY_COUNTRY[cc], freqFrom: "issuer's country" };
  if (ccy === "USD" || ccy === "GBP") return { freq: 2, freqFrom: "currency" };
  if (ccy === "EUR") return { freq: 1, freqFrom: "currency" };
  return { freq: 1, freqFrom: "default" };
}
// the currency of a government's own bonds, for a terms source that does not give it (OpenFIGI)
const EURO = new Set(["DE", "FR", "IT", "ES", "NL", "BE", "AT", "PT", "IE", "GR", "FI", "SI", "SK", "LT", "LV", "EE", "LU", "MT", "CY", "HR", "EU"]);
export const homeCcy = (cc) => (EURO.has(cc) ? "EUR" : { US: "USD", GB: "GBP", CH: "CHF" }[cc] || null);
// what OpenFIGI's ticker and name say about the coupon (checked 22 Oct 2026): indexed to inflation — "BTPS 1.25 09/15/32
// CPI" (BTP€i), "BTPS 2 03/14/28 ICPI" (BTP Italia), "DBRI 0.1 04/15/33 I/L", "FRTR 1.85 07/25/27 OATe", "UKTI 0.75 11/22/33",
// "SPGBEI 0.65 11/30/27", names "… I/L BOND"; a step-up coupon — "BTPS 4.1 10/10/28 VALR" (BTP Valore). The ECB list files
// all of them as fixed coupon
const LINKER_TAGS = new Set(["CPI", "ICPI", "I/L", "IL", "OATE", "OATI", "HICP", "RPI", "INFL"]), LINKER_ROOTS = new Set(["DBRI", "UKTI", "SPGBEI", "TII", "FRTRI"]), STEPUP_TAGS = new Set(["VALR", "FUT", "PIU"]);
export function bondKind(ticker, name) {
  const t = String(ticker || "").toUpperCase().trim().split(/\s+/), tags = t.slice(3);
  if (LINKER_ROOTS.has(t[0]) || tags.some((x) => LINKER_TAGS.has(x)) || /\bI\/L\b|INFLATION|INDEX[- ]LINKED/i.test(String(name || ""))) return "linker";
  if (tags.some((x) => STEPUP_TAGS.has(x))) return "stepup";
  return "fixed";
}
const figiBond = (rows) => { const bond = (rows || []).filter((r) => r && (/govt|corp|muni|mtge/i.test(r.marketSector || "") || /bond|note|bill|govt/i.test(r.securityType || "") || /bond|note/i.test(r.securityType2 || ""))); return bond.find((r) => parseBondTicker(r.ticker)) || bond[0] || null; };
// the ECB list's line → the terms
export function bondRefFromEcb(isin, b, head) {
  const f = freqOf(b.residence || isin.slice(0, 2), b.ccy);
  const name = [String(b.issuer || "").replace(/^Central government:\s*/i, ""), b.zero ? "zero" : b.coupon + "%", b.maturity].filter(Boolean).join(" ");
  return { isin, name, ticker: null, securityType: b.typeName || b.type, marketSector: b.groupName || b.group, coupon: b.coupon, maturity: b.maturity, issue: b.issue, floating: false, zero: b.zero,
    ccy: b.ccy, residence: b.residence, group: b.group, issuer: b.issuer, ...f, parsed: true, source: "ECB list of eligible marketable assets" + (head && head.date ? ` (${head.date})` : ""), sourceUrl: ECB_EA_PAGE };
}
// the terms of an ISIN: the ECB list (and OpenFIGI's ticker to tell an inflation-linked or step-up bond), then OpenFIGI
// alone → { ref, status } | { err }. kind: fixed | linker | stepup; checked: OpenFIGI's ticker was read
export async function bondTerms(url, env, ctx, isin, deps = {}) {
  const table = deps.table != null ? deps.table : await eaTable(env), e = eaLookup(table, isin);
  const figi = () => cachedSource({ origin: url.origin, key: `bond/ref/${isin}`, ttlMs: 7 * 86400_000, staleMaxMs: 30 * 86400_000, ctx, load: () => (deps.rows || openFigiRows)(isin, env) });
  if (e) {
    const ref = bondRefFromEcb(isin, e, eaHead(table)), r = await figi(), pick = r.data ? figiBond(r.data) : null;
    return { ref: { ...ref, ticker: pick ? pick.ticker || null : null, kind: pick ? bondKind(pick.ticker, pick.name) : "fixed", checked: !!pick }, status: "LIVE" };
  }
  const r = await figi();
  if (!r.data) return { err: r.err || "provider_error" };
  const ref = bondRefFrom(isin, r.data); if (!ref) return { err: "not_a_bond" };
  return { ref: { ...ref, issue: null, zero: ref.coupon === 0, ccy: homeCcy(isin.slice(0, 2)), residence: null, kind: bondKind(ref.ticker, ref.name), checked: true, source: "OpenFIGI (ticker parsed: check against the prospectus)" }, status: r.cache === "STALE" ? "STALE" : "LIVE" };
}
export function bondRefFrom(isin, rows) {
  const bond = (rows || []).filter((r) => r && (/govt|corp|muni|mtge/i.test(r.marketSector || "") || /bond|note|bill|govt/i.test(r.securityType || "") || /bond|note/i.test(r.securityType2 || "")));
  const pick = bond.find((r) => parseBondTicker(r.ticker)) || bond[0] || null; if (!pick) return null;
  const p = parseBondTicker(pick.ticker), cc = isin.slice(0, 2);
  return { isin, name: pick.name || null, ticker: pick.ticker || null, securityType: pick.securityType2 || pick.securityType || null, marketSector: pick.marketSector || null,
    coupon: p ? p.coupon : null, maturity: p ? p.maturity : null, floating: p ? p.floating : null, freq: FREQ_BY_COUNTRY[cc] || 1, freqFrom: FREQ_BY_COUNTRY[cc] ? "issuer's country" : "default", parsed: !!p };
}
export async function handleBondRef(url, env, ctx, H, json, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (url.pathname === "/api/bond/list") {
    const cc = String(url.searchParams.get("cc") || "").toUpperCase(), group = String(url.searchParams.get("group") || "IG2").toUpperCase(), q = String(url.searchParams.get("q") || "").trim().slice(0, 30);
    if (!/^[A-Z]{2}$/.test(cc) || !(group === "ALL" || ISSUER_GROUPS[group])) return send({ error: "bad_request", message: "cc: a two-letter country; group: IG1…IG8 or ALL" }, 400);
    const table = deps.table != null ? deps.table : await eaTable(env), head = eaHead(table);
    if (!head) {
      // where the read is (no values: the file's date, how far, how many bonds so far, the last error)
      let r = null; try { r = env.BRIEFS ? JSON.parse((await env.BRIEFS.get(EA_STATE)) || "null") : null; } catch { r = null; }
      const read = r ? { file: r.reading || r.done || null, offset: r.offset || 0, rows: r.rows || 0, error: r.error || null } : null;
      return send({ cc, error: "not_loaded", status: "N/A", read, note: "the ECB list has not been read yet (a slice every 10 minutes once a new file is out)" }, 503);
    }
    const today = new Date(deps.now || Date.now()).toISOString().slice(0, 10), r = eaList(table, { cc, group: group === "ALL" ? "" : group, from: today, q });
    return send({ cc, group, ...r, asOf: head.date, source: "ECB list of eligible marketable assets", sourceUrl: ECB_EA_PAGE, note: "fixed and zero-coupon bonds only; the terms, not prices", status: "LIVE" });
  }
  const isin = String(url.searchParams.get("isin") || "").trim().toUpperCase();
  if (!isinValid(isin)) return send({ error: "bad_request", message: "a valid ISIN" }, 400);
  const t = await bondTerms(url, env, ctx, isin, deps);
  if (t.err === "not_a_bond") return send({ isin, error: "not_a_bond", status: "N/A", note: "neither the ECB list nor OpenFIGI names a bond for this ISIN" }, 404);
  if (t.err) return send({ isin, error: t.err, status: "N/A" }, 502);
  return send({ ...t.ref, status: t.status });
}
