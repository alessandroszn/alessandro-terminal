// YAS — a fixed-coupon bond's analytics (yield to maturity, durations, cash flows) are computed in the page (qmath.js) from
// the terms and a price. This module gives the terms of an ISIN as OpenFIGI (approved) names them: the Bloomberg-style
// ticker carries the coupon and the maturity ("BTPS 3.85 09/01/49", "T 4 1/4 11/15/34", "DBR 0 08/15/31", "CCTS F …" =
// floating). Parsed from the ticker — to be checked against the prospectus; a floating or unrecognised ticker → no terms.
//   GET /api/bond/ref?isin=
import { isinValid, openFigiRows } from "./isin.mjs";
import { cachedSource } from "./lib.mjs";

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
export function bondRefFrom(isin, rows) {
  const bond = (rows || []).filter((r) => r && (/govt|corp|muni|mtge/i.test(r.marketSector || "") || /bond|note|bill|govt/i.test(r.securityType || "") || /bond|note/i.test(r.securityType2 || "")));
  const pick = bond.find((r) => parseBondTicker(r.ticker)) || bond[0] || null; if (!pick) return null;
  const p = parseBondTicker(pick.ticker), cc = isin.slice(0, 2);
  return { isin, name: pick.name || null, ticker: pick.ticker || null, securityType: pick.securityType2 || pick.securityType || null, marketSector: pick.marketSector || null,
    coupon: p ? p.coupon : null, maturity: p ? p.maturity : null, floating: p ? p.floating : null, freq: FREQ_BY_COUNTRY[cc] || 1, freqFrom: FREQ_BY_COUNTRY[cc] ? "issuer's country" : "default", parsed: !!p };
}
export async function handleBondRef(url, env, ctx, H, json, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const isin = String(url.searchParams.get("isin") || "").trim().toUpperCase();
  if (!isinValid(isin)) return send({ error: "bad_request", message: "a valid ISIN" }, 400);
  const r = await cachedSource({ origin: url.origin, key: `bond/ref/${isin}`, ttlMs: 7 * 86400_000, staleMaxMs: 30 * 86400_000, ctx, load: () => (deps.rows || openFigiRows)(isin, env) });
  if (!r.data) return send({ isin, error: r.err || "provider_error", status: "N/A" }, 502);
  const ref = bondRefFrom(isin, r.data);
  if (!ref) return send({ isin, error: "not_a_bond", status: "N/A", note: "OpenFIGI names no bond for this ISIN" }, 404);
  return send({ ...ref, source: "OpenFIGI (ticker parsed: check against the prospectus)", status: r.cache === "STALE" ? "STALE" : "LIVE" });
}
