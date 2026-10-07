// MARKETS BOARD extras (7 Oct 2026) — approved sources only, no Twelve Data credits.
//   GET /api/markets/fx      ECB euro reference rates (ECB Data Portal, EXR): the last two daily fixings (about 16:00 CET)
//                            of the main currencies against the euro
//   GET /api/markets/cmdty   IMF Primary Commodity Prices on FRED (needs FRED_KEY): monthly average prices of base metals and
//                            agricultural commodities, the last 13 months (month-on-month and year-on-year changes DERIVED)
// Energy spot prices are /api/energy (EIA, or the same EIA series on FRED without EIA_KEY).
// A value is shown with its own date; a monthly average is labelled as such; nothing is filled in between publications.
import { fetchText, cachedSource, iso } from "./lib.mjs";
import { parseEcbFx } from "./portfolio.mjs";
import { fredSeries } from "./yields.mjs";

export const FX_CCYS = ["USD", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "SGD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "INR", "BRL", "MXN", "ZAR", "KRW"];
export const ecbFxUrl = (ccys = FX_CCYS) => `https://data-api.ecb.europa.eu/service/data/EXR/D.${ccys.join("+")}.EUR.SP00.A?lastNObservations=2&format=csvdata&detail=dataonly`;

// [FRED series, name, unit, group]
export const IMF_MONTHLY = [
  ["PCOPPUSDM", "Copper", "$/t", "Metals"], ["PALUMUSDM", "Aluminium", "$/t", "Metals"], ["PNICKUSDM", "Nickel", "$/t", "Metals"],
  ["PZINCUSDM", "Zinc", "$/t", "Metals"], ["PIORECRUSDM", "Iron ore", "$/t", "Metals"],
  ["PWHEAMTUSDM", "Wheat", "$/t", "Agriculture"], ["PMAIZMTUSDM", "Corn", "$/t", "Agriculture"], ["PSOYBUSDM", "Soybeans", "$/t", "Agriculture"],
  ["PCOFFOTMUSDM", "Coffee (arabica)", "¢/lb", "Agriculture"], ["PSUGAISAUSDM", "Sugar", "¢/lb", "Agriculture"], ["PCOCOUSDM", "Cocoa", "$/t", "Agriculture"],
];

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? Math.round((a / b - 1) * 1e6) / 1e4 : null);

export function fxRows(series) {
  return FX_CCYS.map((c) => {
    const s = series[c] || [];
    if (!s.length) return { ccy: c, status: "N/A", error: "no_data" };
    const [d, v] = s[s.length - 1], p = s.length > 1 ? s[s.length - 2] : null;
    return { ccy: c, date: d, eurRate: v, prevDate: p ? p[0] : null, prevRate: p ? p[1] : null };
  });
}

export function monthlyRow([id, name, unit, group], obs) {
  if (!obs || !obs.length) return { id, name, unit, group, status: "N/A", error: "no_data" };
  const [d, v] = obs[obs.length - 1], p = obs.length > 1 ? obs[obs.length - 2] : null, y = obs.find(([x]) => x.slice(0, 4) === String(Number(d.slice(0, 4)) - 1) && x.slice(5, 7) === d.slice(5, 7));
  return { id, name, unit, group, freq: "M", date: d, value: v, prevDate: p ? p[0] : null, prev: p ? p[1] : null, chgPct: p ? pct(v, p[1]) : null, yoyPct: y ? pct(v, y[1]) : null };
}

export async function handleMarkets(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (url.pathname === "/api/markets/fx") {
    const r = await cachedSource({ origin: url.origin, key: "mkt/ecbfx/v1", ttlMs: 2 * 3600_000, staleMaxMs: 7 * 86400_000, ctx, failTtlMs: 10 * 60_000,
      load: async () => { const f = await fetchText(ecbFxUrl(), { timeoutMs: 20000, headers: { accept: "text/csv" } }); if (f.err) return { err: f.err }; const d = parseEcbFx(f.text); return d.USD ? { data: d } : { err: "no_data" }; } });
    if (!r.data) return send({ error: r.err, status: "N/A" }, 502);
    return send({ base: "EUR", rates: fxRows(r.data), source: "ECB euro reference rates (ECB Data Portal, EXR)", sourceUrl: "https://data.ecb.europa.eu/data/datasets/EXR",
      basis: "units of each currency per 1 euro, daily fixing around 16:00 CET; pairs against the dollar and changes are DERIVED from the same fixing", fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" });
  }
  if (url.pathname === "/api/markets/cmdty") {
    if (!env.FRED_KEY) return send({ error: "fred_not_configured", status: "N/A" }, 503);
    const r = await cachedSource({ origin: url.origin, key: "mkt/imf/v1", ttlMs: 12 * 3600_000, staleMaxMs: 40 * 86400_000, ctx, failTtlMs: 15 * 60_000,
      load: async () => {
        const res = await Promise.all(IMF_MONTHLY.map(([id]) => fredSeries(env, id, 14)));
        const auth = res.find((x) => x.err === "provider_auth"); if (auth) return { err: "provider_auth" };
        const rows = IMF_MONTHLY.map((m, i) => monthlyRow(m, res[i].data));
        return rows.some((x) => x.value != null) ? { data: rows } : { err: res.map((x) => x.err).find(Boolean) || "no_data" };
      } });
    if (!r.data) return send({ error: r.err, status: "N/A" }, 502);
    return send({ rows: r.data, source: "IMF Primary Commodity Prices (via FRED)", sourceUrl: "https://fred.stlouisfed.org/", basis: "monthly average prices; change against the previous month and the same month a year earlier (DERIVED)",
      fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" });
  }
  return send({ error: "not found" }, 404);
}
