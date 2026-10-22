// ISIN → LISTINGS (OpenFIGI, approved 21 Oct 2026) — reference data only: ticker, exchange, name, security type.
// No prices: the listings found are then quoted by the usual sources (Twelve Data, or CNBC outside the plan).
//   POST https://api.openfigi.com/v3/mapping [{ idType: "ID_ISIN", idValue }] — free, no key needed (25 requests a
//   minute); OPENFIGI_KEY (optional, free) raises the limit and is sent only in the X-OPENFIGI-APIKEY header.
import { fetchText } from "./lib.mjs";

export const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
// the check digit (ISO 6166): letters as numbers (A = 10 … Z = 35), then the Luhn algorithm over the digits
export function isinValid(s) {
  s = String(s || "").toUpperCase(); if (!ISIN_RE.test(s)) return false;
  const digits = [...s.slice(0, 11)].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join("");
  let sum = 0, dbl = true; for (let i = digits.length - 1; i >= 0; i--) { let d = +digits[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return (10 - (sum % 10)) % 10 === +s[11];
}
// Bloomberg exchange codes (OpenFIGI exchCode) → the MIC of the venues the terminal quotes; US venues are one listing
export const EXCH_MIC = {
  IM: "XMIL", GY: "XETR", GR: "XETR", GF: "XFRA", FP: "XPAR", LN: "XLON", NA: "XAMS", SM: "XMAD", SW: "XSWX", SE: "XSWX", VX: "XSWX",
  BB: "XBRU", PL: "XLIS", FH: "XHEL", NO: "XOSL", SS: "XSTO", DC: "XCSE", AV: "XWBO", ID: "XDUB", JT: "XJPX", JP: "XJPX", HK: "XHKG",
  CT: "XTSE", CN: "XTSE", AT: "XASX", AU: "XASX", IS: "XNSE", IN: "XNSE", BS: "BVMF", BZ: "BVMF", CG: "XSHG", CS: "XSHE", TT: "XTAI", SP: "XSES", KS: "XKRX",
};
const US_EXCH = new Set(["US", "UW", "UQ", "UR", "UN", "UA", "UP", "UF", "UV", "UD", "UT", "UX"]);
export const MIC_COUNTRY = { XMIL: "Italy", XETR: "Germany", XFRA: "Germany", XPAR: "France", XLON: "United Kingdom", XAMS: "Netherlands", XMAD: "Spain", XSWX: "Switzerland",
  XBRU: "Belgium", XLIS: "Portugal", XHEL: "Finland", XOSL: "Norway", XSTO: "Sweden", XCSE: "Denmark", XWBO: "Austria", XDUB: "Ireland", XJPX: "Japan", XHKG: "Hong Kong",
  XTSE: "Canada", XASX: "Australia", XNSE: "India", BVMF: "Brazil", XSHG: "China", XSHE: "China", XTAI: "Taiwan", XSES: "Singapore", XKRX: "South Korea" };
export const MIC_EXCHANGE = { XMIL: "Borsa Italiana", XETR: "XETRA", XFRA: "Frankfurt", XPAR: "Euronext Paris", XLON: "London Stock Exchange", XAMS: "Euronext Amsterdam", XMAD: "BME Madrid",
  XSWX: "SIX Swiss Exchange", XBRU: "Euronext Brussels", XLIS: "Euronext Lisbon", XHEL: "Nasdaq Helsinki", XOSL: "Oslo Børs", XSTO: "Nasdaq Stockholm", XCSE: "Nasdaq Copenhagen",
  XWBO: "Wiener Börse", XDUB: "Euronext Dublin", XJPX: "Tokyo Stock Exchange", XHKG: "Hong Kong Exchanges", XTSE: "Toronto Stock Exchange", XASX: "ASX", XNSE: "NSE India",
  BVMF: "B3", XSHG: "Shanghai Stock Exchange", XSHE: "Shenzhen Stock Exchange", XTAI: "Taiwan Stock Exchange", XSES: "Singapore Exchange", XKRX: "Korea Exchange" };
// the country of the ISIN's issuer prefix, for ranking the home market first
export const ISIN_HOME = { US: "United States", IT: "Italy", DE: "Germany", FR: "France", GB: "United Kingdom", NL: "Netherlands", ES: "Spain", CH: "Switzerland", BE: "Belgium",
  PT: "Portugal", FI: "Finland", NO: "Norway", SE: "Sweden", DK: "Denmark", AT: "Austria", IE: "Ireland", JP: "Japan", HK: "Hong Kong", CA: "Canada", AU: "Australia", IN: "India",
  BR: "Brazil", CN: "China", TW: "Taiwan", SG: "Singapore", KR: "South Korea", LU: "Luxembourg", JE: "Jersey", KY: "Cayman Islands", BM: "Bermuda" };

// OpenFIGI rows → distinct listings the terminal can name (US venues merged into one; unknown venues left out)
export function figiListings(rows) {
  const out = [], seen = new Set();
  for (const r of rows || []) {
    if (!r || !r.ticker || !r.exchCode) continue;
    const us = US_EXCH.has(r.exchCode), mic = us ? null : EXCH_MIC[r.exchCode];
    if (!us && !mic) continue;
    const ticker = String(r.ticker).trim().toUpperCase().replace(/\//g, "."), id = us ? ticker : `${ticker.replace(/ /g, "")}:${mic}`;
    if (seen.has(id)) continue; seen.add(id);
    out.push({ id, ticker, mic, exch: r.exchCode, name: r.name || null, type: r.securityType2 || r.securityType || null, figi: r.figi || null });
  }
  return out;
}
// the raw OpenFIGI rows of an ISIN (every row: ticker, exchCode, name, securityType, marketSector …) — for bonds (YAS)
export async function openFigiRows(isin, env) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (env.OPENFIGI_KEY) headers["x-openfigi-apikey"] = env.OPENFIGI_KEY; // only in this header
  const f = await fetchText("https://api.openfigi.com/v3/mapping", { timeoutMs: 10000, headers, method: "POST", body: JSON.stringify([{ idType: "ID_ISIN", idValue: isin }]) });
  if (f.err) return { err: f.http === 429 ? "rate_limited" : f.http === 401 ? "provider_auth" : f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const res = Array.isArray(j) ? j[0] : null; if (!res) return { err: "provider_error" };
  return { data: Array.isArray(res.data) ? res.data : [], note: res.warning || res.error || null };
}
export async function openFigi(isin, env) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (env.OPENFIGI_KEY) headers["x-openfigi-apikey"] = env.OPENFIGI_KEY; // the key goes only in this header, never in a URL or a response
  const f = await fetchText("https://api.openfigi.com/v3/mapping", { timeoutMs: 10000, headers, method: "POST", body: JSON.stringify([{ idType: "ID_ISIN", idValue: isin }]) });
  if (f.err) return { err: f.http === 429 ? "rate_limited" : f.http === 401 ? "provider_auth" : f.err };
  let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
  const res = Array.isArray(j) ? j[0] : null;
  if (!res) return { err: "provider_error" };
  if (res.warning || res.error) return { data: { listings: [], name: null, note: res.warning || res.error } }; // "No identifier found."
  const listings = figiListings(res.data);
  return { data: { listings, name: (res.data.find((r) => r && r.name) || {}).name || null, total: res.data.length } };
}
