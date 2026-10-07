// WORLD GOVERNMENT BONDS (BOND window) — the same official curves as YLD with their recent history, plus U.S.
// inflation and credit from FRED.
//   GET /api/bonds   countries: 2Y / 5Y / 10Y / 20Y / 30Y yields with changes over 1 publication, ~1 week, ~1 month
//                    (bp, DERIVED from two real publications), 10Y spread vs the Bund on the same date (DERIVED);
//                    fred: TIPS real yields, breakeven inflation, investment-grade / high-yield yields and spreads,
//                    SOFR, 30-year mortgage rate (needs FRED_KEY; the key goes only in the server's request to FRED)
// Nothing is interpolated: a maturity a source does not publish stays N/A; changes need both real values.
import { cachedSource, iso, easternDate, daysBetween } from "./lib.mjs";
import { getCurveRows, fredSeries, WORLD_IDS } from "./yields.mjs";

export const BOND_TENORS = ["2Y", "5Y", "10Y", "20Y", "30Y"];
export const FRED_EXTRAS = [
  ["Inflation", "DFII5", "5-year TIPS real yield", "%"], ["Inflation", "DFII10", "10-year TIPS real yield", "%"],
  ["Inflation", "T5YIE", "5-year breakeven inflation", "%"], ["Inflation", "T10YIE", "10-year breakeven inflation", "%"], ["Inflation", "T5YIFR", "5-year, 5-year forward inflation expectation", "%"],
  ["Credit", "BAMLC0A0CMEY", "US investment grade corporates — effective yield (ICE BofA)", "%"], ["Credit", "BAMLC0A0CM", "US investment grade corporates — option-adjusted spread (ICE BofA)", "bp"],
  ["Credit", "BAMLH0A0HYM2EY", "US high yield — effective yield (ICE BofA)", "%"], ["Credit", "BAMLH0A0HYM2", "US high yield — option-adjusted spread (ICE BofA)", "bp"],
  ["Money and mortgages", "SOFR", "SOFR — secured overnight financing rate (New York Fed)", "%"], ["Money and mortgages", "MORTGAGE30US", "30-year fixed mortgage rate (Freddie Mac, weekly)", "%"],
];
const DAY = 86400000;
const r2 = (v) => Math.round(v * 100) / 100;
// change of the last value vs the previous publication and vs the last value on/before 7 and 30 days earlier (in bp)
export function changes(series) {
  if (!series || !series.length) return null;
  const [d, v] = series[series.length - 1], at = (days) => { const t = Date.parse(d) - days * DAY; const p = series.filter(([x]) => Date.parse(x) <= t).pop(); return p ? r2((v - p[1]) * 100) : null; };
  return { date: d, value: v, d1: series.length > 1 ? r2((v - series[series.length - 2][1]) * 100) : null, w1: at(7), m1: at(30) };
}
export function countryRow(id, def, rows, today) {
  const last = rows[rows.length - 1], age = daysBetween(last.date, today), status = age > def.maxAgeDays ? "STALE" : "LIVE";
  const tenors = {};
  for (const t of BOND_TENORS.concat(id === "CA" ? ["LONG"] : [])) {
    const series = rows.map((r) => { const p = r.points.find((x) => x.tenor === t); return p && p.value != null ? [r.date, p.value] : null; }).filter(Boolean);
    const c = changes(series), note = (last.points.find((x) => x.tenor === t) || {}).note;
    if (c && c.date === last.date) tenors[t === "LONG" ? "30Y" : t] = { ...c, ...(note ? { note } : {}), ...(t === "LONG" ? { note: "long-term benchmark bond" } : {}) };
  }
  return { id, name: def.name, kind: def.kind, source: def.source, sourceUrl: def.sourceUrl, date: last.date, status, tenors };
}
export function bundSpreads(countries) {
  const de = countries.find((c) => c.id === "DE" && c.tenors && c.tenors["10Y"]);
  if (!de) return [];
  return countries.filter((c) => c.id !== "DE" && c.tenors && c.tenors["10Y"] && c.date === de.date).map((c) => ({ id: c.id, tenor: "10Y", bp: r2((c.tenors["10Y"].value - de.tenors["10Y"].value) * 100), date: c.date }));
}

export async function handleBonds(url, env, ctx, H, json) {
  const now = Date.now(), today = easternDate(new Date(now));
  const ids = ["US", "EA", ...WORLD_IDS];
  const rows = await getCurveRows(url.origin, ctx, now, env, ids);
  const countries = rows.map(({ id, def, r }) => (r.data && r.data.length ? { ...countryRow(id, def, r.data, today), ...(r.cache === "STALE" ? { status: "STALE", staleReason: r.staleReason } : {}), fetchedAt: iso(r.fetchedAt) } : { id, name: def.name, source: def.source, sourceUrl: def.sourceUrl, status: "N/A", error: r.err }));
  let fred;
  if (!env.FRED_KEY) fred = { status: "N/A", error: "fred_not_configured" };
  else {
    const res = await Promise.all(FRED_EXTRAS.map(([, id]) => cachedSource({ origin: url.origin, key: `fred/${id}`, ttlMs: 3 * 3600_000, staleMaxMs: 10 * 86400_000, ctx, failTtlMs: 10 * 60_000, load: () => fredSeries(env, id, 40) })));
    const groups = [];
    FRED_EXTRAS.forEach(([group, id, name, unit], i) => {
      const r = res[i], c = r.data ? changes(r.data) : null;
      let g = groups.find((x) => x.group === group); if (!g) groups.push((g = { group, rows: [] }));
      g.rows.push(c ? { id, name, unit, ...c, status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) } : { id, name, unit, status: "N/A", error: r.err });
    });
    fred = { status: groups.some((g) => g.rows.some((x) => x.value != null)) ? "LIVE" : "N/A", groups, source: "FRED, Federal Reserve Bank of St. Louis", sourceUrl: "https://fred.stlouisfed.org/" };
  }
  const res = json({ countries, spreads: bundSpreads(countries), fred, tenors: BOND_TENORS, notConnected: ["Italy", "France", "Spain", "China", "Australia"],
    basis: "yields as published by each source (methods differ: par, spot or benchmark yields); changes in basis points between real publications; spreads only between values of the same date — all changes and spreads DERIVED",
    generatedAt: iso(now) }, H, countries.some((c) => c.status !== "N/A") ? 200 : 502);
  res.headers.set("cache-control", "no-store");
  return res;
}
