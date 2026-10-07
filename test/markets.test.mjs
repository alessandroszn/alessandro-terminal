// Markets board extras (7 Oct 2026): ECB fixing, IMF monthly prices via FRED, EIA energy spot via FRED without EIA_KEY.
// Fixtures are test data only; nothing here is shown in the terminal.
//   node test/markets.test.mjs
import { app as worker } from "../src/worker.mjs";
import { fxRows, monthlyRow, IMF_MONTHLY, FX_CCYS, ecbFxUrl } from "../src/markets.mjs";
import { EIA_ON_FRED, EIA_SPOT } from "../src/macro.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

const fx = fxRows({ USD: [["2026-10-06", 1.1269], ["2026-10-07", 1.1177]], CHF: [["2026-10-07", 0.9309]] });
ok("ECB rows: latest and previous fixing per currency; a currency with one fixing has no previous; a missing one N/A", fx.find((r) => r.ccy === "USD").eurRate === 1.1177 && fx.find((r) => r.ccy === "USD").prevRate === 1.1269 && fx.find((r) => r.ccy === "CHF").prevRate === null && fx.find((r) => r.ccy === "GBP").status === "N/A" && fx.length === FX_CCYS.length);
ok("ECB URL: the last two daily fixings of every currency, data only", /EXR\/D\.USD\+GBP\+JPY\+CHF.*\.EUR\.SP00\.A\?lastNObservations=2&format=csvdata&detail=dataonly$/.test(ecbFxUrl()));
const obs = [["2025-07-01", 10000], ["2026-06-01", 13552], ["2026-07-01", 13542.82]];
const m = monthlyRow(IMF_MONTHLY[0], obs);
ok("IMF monthly row: latest month, change vs the previous month and vs the same month a year earlier", m.date === "2026-07-01" && m.value === 13542.82 && m.prevDate === "2026-06-01" && m.chgPct === -0.0677 && m.yoyPct === 35.4282 && m.freq === "M" && m.unit === "$/t");
ok("IMF monthly row: no observations → N/A (never a guess)", monthlyRow(IMF_MONTHLY[1], []).status === "N/A" && monthlyRow(IMF_MONTHLY[1], null).value === undefined);
ok("every EIA spot series has its FRED twin", EIA_SPOT.every(([, s]) => /^D[A-Z]+$/.test(EIA_ON_FRED[s] || "")));

// ---------- endpoints with mocked sources ----------
const store = new Map();
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const ctx = { waitUntil: () => {} };
const KEYF = "fred-test-key-333";
let calls = [];
globalThis.fetch = async (u, init) => {
  u = String(u); calls.push(u);
  if (u.startsWith("https://data-api.ecb.europa.eu/service/data/EXR/")) return new Response("KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-06,1.1269\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-07,1.1177\nEXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,2026-10-07,176.85\n");
  if (u.startsWith("https://api.stlouisfed.org/")) {
    const p = new URL(u).searchParams; if (p.get("api_key") !== KEYF) return new Response("{}", { status: 400 });
    const id = p.get("series_id");
    if (id === "PCOCOUSDM" || id === "DJFUELUSGULF") return new Response(JSON.stringify({ observations: [] }));
    const monthly = id.endsWith("USDM");
    const o = monthly ? [{ date: "2026-07-01", value: "200" }, { date: "2026-06-01", value: "180" }] : [{ date: "2026-10-06", value: "96.24" }, { date: "2026-10-05", value: "." }, { date: "2026-10-02", value: "96.13" }];
    return new Response(JSON.stringify({ observations: o }));
  }
  return new Response("", { status: 404 });
};
const call = async (path, env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", FRED_KEY: KEYF };

let r = await call("/api/markets/fx", env);
ok("/api/markets/fx: ECB rates per euro with the previous fixing; currencies not published N/A", r.status === 200 && r.j.base === "EUR" && r.j.rates.find((x) => x.ccy === "USD").prevRate === 1.1269 && r.j.rates.find((x) => x.ccy === "JPY").eurRate === 176.85 && r.j.rates.find((x) => x.ccy === "CHF").status === "N/A" && r.j.status === "LIVE", r.text.slice(0, 300));
r = await call("/api/markets/cmdty", env);
ok("/api/markets/cmdty: IMF monthly rows via FRED (change DERIVED), a series without data N/A; the key never in the response", r.status === 200 && r.j.rows.length === IMF_MONTHLY.length && r.j.rows[0].value === 200 && r.j.rows[0].chgPct === 11.1111 && r.j.rows.find((x) => x.id === "PCOCOUSDM").status === "N/A" && !r.text.includes(KEYF));
r = await call("/api/markets/cmdty", { ALLOWED_ORIGIN: env.ALLOWED_ORIGIN });
ok("/api/markets/cmdty without FRED_KEY → 503 N/A", r.status === 503 && r.j.error === "fred_not_configured");
r = await call("/api/energy", env);
ok("/api/energy without EIA_KEY but with FRED: the EIA spot series from FRED (holiday '.' skipped), futures N/A naming EIA_KEY", r.status === 200 && /via FRED/.test(r.j.source) && r.j.spot[0].series === "DCOILWTICO" && r.j.spot[0].value === 96.24 && r.j.spot[0].date === "2026-10-06" && Math.abs(r.j.spot[0].chg1 - (96.24 / 96.13 - 1) * 100) < 1e-9 && r.j.spot.find((x) => x.series === "DJFUELUSGULF").status === "N/A" && r.j.curves.every((c) => c.status === "N/A" && c.error === "eia_not_configured") && !r.text.includes(KEYF), r.text.slice(0, 400));
r = await call("/api/energy", { ALLOWED_ORIGIN: env.ALLOWED_ORIGIN });
ok("/api/energy with neither key → 503 eia_not_configured", r.status === 503 && r.j.error === "eia_not_configured");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
