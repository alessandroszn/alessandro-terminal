// FUTURES POSITIONING (COT window) — CFTC Commitments of Traders, legacy report, futures only (approved 7 Oct 2026).
//   GET /api/cot   for the major futures: open interest, non-commercial (speculators) long / short / net, commercial net,
//                  net change over 1 and 4 weeks, net as % of open interest and its place in the 26-week range (DERIVED)
// Positions are as of Tuesday and published on Friday (U.S. holidays shift it). No futures prices: those are licensed.
import { fetchText, cachedSource, iso } from "./lib.mjs";

export const COT_URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
// [CFTC contract market code, short name, group, exchange root symbol]
export const COT_CONTRACTS = [
  ["13874A", "E-mini S&P 500", "Equity indices", "ES"], ["209742", "E-mini Nasdaq-100", "Equity indices", "NQ"], ["124603", "E-mini Dow ($5)", "Equity indices", "YM"],
  ["239742", "E-mini Russell 2000", "Equity indices", "RTY"], ["33874A", "E-mini S&P MidCap 400", "Equity indices", "EMD"], ["240743", "Nikkei 225 (yen)", "Equity indices", "NIY"], ["1170E1", "VIX", "Equity indices", "VX"],
  ["042601", "2-year T-note", "Interest rates", "ZT"], ["044601", "5-year T-note", "Interest rates", "ZF"], ["043602", "10-year T-note", "Interest rates", "ZN"], ["043607", "Ultra 10-year T-note", "Interest rates", "TN"],
  ["020601", "T-bond", "Interest rates", "ZB"], ["134741", "3-month SOFR", "Interest rates", "SR3"],
  ["067651", "WTI crude oil", "Energy", "CL"], ["06765T", "Brent crude (last day)", "Energy", "BZ"], ["023651", "Natural gas", "Energy", "NG"], ["111659", "RBOB gasoline", "Energy", "RB"], ["022651", "NY Harbor ULSD", "Energy", "HO"],
  ["088691", "Gold", "Metals", "GC"], ["084691", "Silver", "Metals", "SI"], ["085692", "Copper", "Metals", "HG"], ["076651", "Platinum", "Metals", "PL"],
  ["099741", "Euro FX", "Currencies", "6E"], ["097741", "Japanese yen", "Currencies", "6J"], ["096742", "British pound", "Currencies", "6B"], ["092741", "Swiss franc", "Currencies", "6S"],
  ["090741", "Canadian dollar", "Currencies", "6C"], ["232741", "Australian dollar", "Currencies", "6A"], ["112741", "New Zealand dollar", "Currencies", "6N"], ["095741", "Mexican peso", "Currencies", "6M"], ["098662", "US Dollar Index", "Currencies", "DX"],
  ["133741", "Bitcoin", "Crypto", "BTC"], ["146021", "Ether", "Crypto", "ETH"],
  ["002602", "Corn", "Agriculture", "ZC"], ["001602", "Wheat (SRW)", "Agriculture", "ZW"], ["005602", "Soybeans", "Agriculture", "ZS"], ["083731", "Coffee C", "Agriculture", "KC"], ["080732", "Sugar No. 11", "Agriculture", "SB"], ["033661", "Cotton No. 2", "Agriculture", "CT"],
];
const FIELDS = ["cftc_contract_market_code", "market_and_exchange_names", "report_date_as_yyyy_mm_dd", "open_interest_all", "noncomm_positions_long_all", "noncomm_positions_short_all", "comm_positions_long_all", "comm_positions_short_all", "nonrept_positions_long_all", "nonrept_positions_short_all"];
export const cotQuery = (now, weeks = 27) => `${COT_URL}?${new URLSearchParams({ $select: FIELDS.join(","), $where: `cftc_contract_market_code in(${COT_CONTRACTS.map(([c]) => `'${c}'`).join(",")}) and report_date_as_yyyy_mm_dd >= '${new Date(now - weeks * 7 * 86400_000).toISOString().slice(0, 10)}'`, $order: "report_date_as_yyyy_mm_dd DESC", $limit: "2000" })}`;
const n = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// rows (any order) → one entry per contract with the latest report and the derived changes
export function summarizeCot(rows) {
  const by = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = r.cftc_contract_market_code, d = String(r.report_date_as_yyyy_mm_dd || "").slice(0, 10);
    const L = n(r.noncomm_positions_long_all), S = n(r.noncomm_positions_short_all), oi = n(r.open_interest_all);
    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(d) || L == null || S == null || oi == null) continue;
    (by[code] = by[code] || []).push({ date: d, oi, long: L, short: S, net: L - S, commNet: n(r.comm_positions_long_all) != null && n(r.comm_positions_short_all) != null ? n(r.comm_positions_long_all) - n(r.comm_positions_short_all) : null, smallNet: n(r.nonrept_positions_long_all) != null && n(r.nonrept_positions_short_all) != null ? n(r.nonrept_positions_long_all) - n(r.nonrept_positions_short_all) : null, market: r.market_and_exchange_names });
  }
  return COT_CONTRACTS.map(([code, name, group, root]) => {
    const h = (by[code] || []).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!h.length) return { code, name, group, root, status: "N/A" };
    const last = h[h.length - 1], ago = (k) => (h.length > k ? last.net - h[h.length - 1 - k].net : null);
    const nets = h.map((x) => x.net), lo = Math.min(...nets), hi = Math.max(...nets);
    return { code, name, group, root, market: last.market, date: last.date, oi: last.oi, long: last.long, short: last.short, net: last.net, commNet: last.commNet, smallNet: last.smallNet,
      chg1w: ago(1), chg4w: ago(4), netPctOi: last.oi ? Math.round((last.net / last.oi) * 1000) / 10 : null,
      range: { weeks: h.length, min: lo, max: hi, pos: hi > lo ? Math.round(((last.net - lo) / (hi - lo)) * 100) : null }, history: nets.slice(-13) };
  });
}
export async function handleCot(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const r = await cachedSource({ origin: url.origin, key: "cot/legacy", ttlMs: 6 * 3600_000, staleMaxMs: 21 * 86400_000, ctx, failTtlMs: 15 * 60_000,
    load: async () => {
      const f = await fetchText(cotQuery(Date.now()), { timeoutMs: 20000, headers: { accept: "application/json" } });
      if (f.err) return { err: f.err };
      let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
      const s = summarizeCot(j);
      return s.some((x) => x.date) ? { data: s } : { err: "no_data" };
    } });
  if (!r.data) return send({ error: r.err, status: "N/A" }, 502);
  return send({ contracts: r.data, report: "Commitments of Traders — legacy, futures only", source: "U.S. Commodity Futures Trading Commission", sourceUrl: "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm",
    basis: "positions as of the report date (Tuesday), published the following Friday; non-commercial ≈ speculators; net = long − short; changes, % of open interest and the 26-week range are DERIVED",
    fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" });
}
