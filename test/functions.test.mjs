// T07 — function menu, Worker side: central banks, spreads, energy (EIA), earnings (Finnhub), company description
// (SEC), options (Alpaca), the owner's alerts / notes / boards, and the system status.
// Provider responses are test fixtures in the providers' formats; nothing here is shown in the terminal.
//   node test/functions.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseEcbRate, parseNyFed, parseBoe, parseSnb, parseBoc, parseSpread, parseEia, EIA_SPOT, EIA_FUT, lastChange } from "../src/macro.mjs";
import { normalizeEarnings, reaction } from "../src/earnings.mjs";
import { normalizeProfile, pickFact, parseOcc } from "../src/company.mjs";
import { validateAlert, validateNote, validateBoards, sourcesStatus, LIMITS } from "../src/userdata.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };
const ctx = { waitUntil: () => {} };
const call = async (path, init, env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path, init), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };

// ---------- central bank parsers (official formats) ----------
const ECB_CSV = "KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE\nFM.B.U2.EUR.4F.KR.DFR.LEV,B,U2,EUR,4F,KR,DFR,LEV,2026-06-10,2.25\nFM.B.U2.EUR.4F.KR.DFR.LEV,B,U2,EUR,4F,KR,DFR,LEV,2026-06-11,2.0\n";
ok("ECB key rate: latest level, the level before the last change and its date", JSON.stringify(parseEcbRate(ECB_CSV, "DFR")) === JSON.stringify({ date: "2026-06-11", value: 2, previous: 2.25, changedOn: "2026-06-11" }));
const ECB_ALL = ECB_CSV + ["MRR_FR,2026-06-11,2.15", "MLFR,2026-06-11,2.4"].map((x) => { const [k, d, v] = x.split(","); return `FM.B.U2.EUR.4F.KR.${k}.LEV,B,U2,EUR,4F,KR,${k},LEV,${d},${v}`; }).join("\n") + "\n";
ok("ECB key rates: one request for the three rates, each read from its own series", parseEcbRate(ECB_ALL, "MRR_FR").value === 2.15 && parseEcbRate(ECB_ALL, "MLFR").value === 2.4 && parseEcbRate(ECB_ALL, "DFR").value === 2);
ok("last change: daily repeats are not a change; no change in the data → unchangedSince", JSON.stringify(lastChange([["a", 1], ["b", 2], ["c", 2], ["d", 2]])) === JSON.stringify({ date: "d", value: 2, previous: 1, changedOn: "b" }) && lastChange([["a", 2], ["b", 2]]).unchangedSince === "a" && lastChange([["a", 2], ["b", 2]]).previous === null && lastChange([]) === null);
const NYF = { refRates: [{ effectiveDate: "2026-09-17", type: "EFFR", percentRate: 3.83, targetRateFrom: 3.75, targetRateTo: 4 }, { effectiveDate: "2026-09-18", type: "EFFR", percentRate: 3.6, targetRateFrom: 3.5, targetRateTo: 3.75 }, { effectiveDate: "2026-10-05", type: "EFFR", percentRate: 3.6, targetRateFrom: 3.5, targetRateTo: 3.75 }, { effectiveDate: "2026-10-06", type: "EFFR", percentRate: 3.58, targetRateFrom: 3.5, targetRateTo: 3.75 }] };
const ny = parseNyFed(NYF);
ok("NY Fed: latest EFFR, the FOMC target range, the range before the last change and its date", ny.date === "2026-10-06" && ny.value === 3.58 && ny.targetFrom === 3.5 && ny.targetTo === 3.75 && ny.targetPrevious.to === 4 && ny.targetChangedOn === "2026-09-18");
ok("NY Fed: nothing usable → null (no value invented)", parseNyFed({ refRates: [] }) === null && parseNyFed(null) === null);
const BOE = "DATE,IUDBEDR\n06 Aug 2026,4.0000\n07 Aug 2026,3.7500\n06 Oct 2026,3.7500\n";
const be = parseBoe(BOE);
ok("BoE IADB: Bank Rate, last change and the rate before it", be.date === "2026-10-06" && be.value === 3.75 && be.previous === 4 && be.changedOn === "2026-08-07");
ok("parsers: an empty value is missing, never zero", parseBoe("DATE,IUDBEDR\n06 Oct 2026,\n") === null && parseBoc({ observations: [{ d: "2026-10-06", V39079: { v: "" } }] }) === null);
const SNB = '"CubeId";"snbgwdzid"\n"PublishingDate";"2026-10-06 09:30"\n\n"Date";"D0";"Value"\n"2026-09-25";"LZ";"0"\n"2026-09-25";"ENG";"0.5"\n"2026-09-26";"LZ";"0"\n';
const sn = parseSnb(SNB);
ok("SNB data portal: policy rate (LZ) only, other series ignored; unchanged in the data → no previous", sn.date === "2026-09-26" && sn.value === 0 && sn.previous === null && sn.unchangedSince === "2026-09-25");
const BOC = { observations: [{ d: "2026-10-03", V39079: { v: "2.50" } }, { d: "2026-10-06", V39079: { v: "2.50" } }] };
ok("BoC Valet: target for the overnight rate", parseBoc(BOC).date === "2026-10-06" && parseBoc(BOC).value === 2.5 && parseBoc(BOC).previous === null);

// ---------- spread ----------
let sp = "KEY,FREQ,TIME_PERIOD,OBS_VALUE\n";
for (let d = 1; d <= 25; d++) { const day = `2026-09-${String(d).padStart(2, "0")}`; sp += `YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y,B,${day},2.0\nYC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,${day},2.75\n`; }
sp += "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y,B,2026-09-26,2.1\n"; // a day with one leg only
const ps = parseSpread(sp);
ok("EA 2s10s: both legs on the same date, spread in bp; a one-leg day is left out", ps.length === 25 && ps[0].bp === 75 && !ps.some((x) => x.date === "2026-09-26"));

// ---------- EIA ----------
const EIA = { response: { data: [{ period: "2026-09-30", series: "RWTC", value: "65.2" }, { period: "2026-09-29", series: "RWTC", value: 64.9 }, { period: "2026-09-30", series: "RBRTE", value: null }] } };
const pe = parseEia(EIA);
ok("EIA v2: series sorted by date, empty values dropped", pe.RWTC.length === 2 && pe.RWTC[0][0] === "2026-09-29" && pe.RWTC[1][1] === 65.2 && !pe.RBRTE);
ok("EIA lists: spot crude/products/gas, futures contracts 1–4 for crude and gas", EIA_SPOT.length === 8 && EIA_FUT.crude[1].length === 4 && EIA_FUT.gas[1].length === 4);

// ---------- routed handlers with mocked providers ----------
const seen = [];
const ENERGY_ROWS = (series, n) => ({ response: { data: series.flatMap((s, k) => Array.from({ length: n }, (_, i) => ({ period: `2026-${String(8 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, series: s, value: 60 + k + i / 100 }))) } });
globalThis.fetch = async (u, o = {}) => {
  u = String(u); seen.push({ u, h: o.headers || {} });
  if (u.includes("FM/B.U2.EUR.4F.KR.DFR+MRR_FR+MLFR.LEV") && u.includes("detail=dataonly")) return new Response(ECB_ALL);
  if (u.startsWith("https://markets.newyorkfed.org/")) return new Response(JSON.stringify(NYF));
  if (u.startsWith("https://www.bankofengland.co.uk/")) return new Response(BOE);
  if (u.startsWith("https://data.snb.ch/")) { if (!/fromDate=\d{4}-\d{2}-\d{2}/.test(u)) return new Response("whole cube", { status: 200 }); return new Response("", { status: 503 }); }
  if (u.startsWith("https://www.bankofcanada.ca/")) return new Response(JSON.stringify(BOC));
  if (u.includes("/YC/")) return new Response(sp);
  if (u.startsWith("https://api.eia.gov/v2/")) { const ser = [...new URL(u).searchParams.getAll("facets[series][]")]; return new Response(JSON.stringify(ENERGY_ROWS(ser, 30))); }
  return new Response("", { status: 404 });
};
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com" };
let r = await call("/api/cb", undefined, env);
const cb = r.j && Object.fromEntries(r.j.banks.map((b) => [b.id, b]));
ok("/api/cb: ECB deposit rate, Fed EFFR + target, BoE, BoC LIVE with their dates", r.status === 200 && cb.ECB.rate.value === 2 && cb.ECB.others["Main refinancing operations"] && cb.FED.target.to === 3.75 && cb.BOE.rate.value === 3.75 && cb.BOC.rate.date === "2026-10-06" && cb.ECB.status === "LIVE");
ok("/api/cb: a bank whose source fails is N/A, the others still shown", cb.SNB.status === "N/A" && !("rate" in cb.SNB));
r = await call("/api/sprd", undefined, env);
ok("/api/sprd: EA history LIVE; US N/A without a FRED key", r.status === 200 && r.j.series.EA.points.length === 25 && r.j.series.EA.status === "LIVE" && r.j.series.US.status === "N/A");
r = await call("/api/energy", undefined, env);
ok("/api/energy without EIA_KEY → 503 N/A, no provider call", r.status === 503 && r.j.error === "eia_not_configured" && !seen.some((x) => x.u.includes("api.eia.gov")));
const KEY_EIA = "eia-test-key-000", envE = { ...env, EIA_KEY: KEY_EIA };
r = await call("/api/energy", undefined, envE);
const wti = r.j && r.j.spot.find((x) => x.series === "RWTC");
ok("/api/energy: spot rows with date, value and 1D/1W/1M changes (DERIVED from EIA values)", r.status === 200 && wti.date && Number.isFinite(wti.value) && Number.isFinite(wti.chg1) && Number.isFinite(wti.chg21) && wti.history.length === 30);
const cr = r.j && r.j.curves.find((c) => c.id === "crude");
ok("/api/energy: futures curve = contracts 1–4 on the latest date, a week and a month before", cr.latest.length === 4 && cr.latest.every((x) => Number.isFinite(x.value)) && cr.dates.week < cr.dates.latest && cr.dates.month < cr.dates.week);
ok("/api/energy: the EIA key travels only in the server's request to EIA, never in the response", seen.some((x) => x.u.includes("api.eia.gov") && x.u.includes(KEY_EIA)) && !r.text.includes(KEY_EIA));

// ---------- earnings ----------
const U = { JPM: { name: "JPMorgan", weight: 1.5, index: ["S&P 500"] }, NFLX: { name: "Netflix", weight: 0.9, index: ["S&P 500", "Nasdaq-100"] } };
const FH = { earningsCalendar: [
  { date: "2026-10-14", hour: "bmo", quarter: 3, year: 2026, symbol: "JPM", epsEstimate: 4.9, epsActual: 5.1, revenueEstimate: 4.6e10, revenueActual: 4.7e10 },
  { date: "2026-10-16", hour: "amc", quarter: 3, year: 2026, symbol: "NFLX", epsEstimate: 6.9, epsActual: null, revenueEstimate: 1.1e10, revenueActual: null },
  { date: "2026-10-16", hour: "amc", quarter: 3, year: 2026, symbol: "NFLX" },
  { date: "2026-10-15", hour: "", symbol: "TINY", epsEstimate: 0.1 },
] };
const ne = normalizeEarnings(FH, U);
ok("earnings: index companies only, duplicates out, before/after the open, quarter", ne.length === 2 && ne[0].sym === "JPM" && ne[0].hour === "before open" && ne[1].hour === "after close" && ne[0].quarter === "Q3 2026" && ne[1].epsActual === null);
const bars = [["2026-10-13", 300], ["2026-10-14", 309], ["2026-10-15", 312]];
{ const rb = reaction(bars, "2026-10-14", "before open"); ok("earnings reaction: before the open → that session vs the close before", rb.session === "2026-10-14" && Math.abs(rb.chg - 3) < 1e-9); }
ok("earnings reaction: after the close → the next session; no session yet → null", reaction(bars, "2026-10-14", "after close").session === "2026-10-15" && reaction(bars, "2026-10-15", "after close") === null);
r = await call("/api/earnings", undefined, env);
ok("/api/earnings without FINNHUB_KEY → 503 N/A", r.status === 503 && r.j.error === "finnhub_not_configured");
// with a key: index lists (fixtures in the iShares / Invesco formats) + Finnhub
const ivv = ["Fund Holdings as of,\"Oct 06, 2026\"", "", "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date"];
ivv.push('JPM,JPMORGAN CHASE & CO,Financials,Equity,1,1.50,1,1,1,United States,New York Stock Exchange Inc.,USD,1.00,USD,-', 'NFLX,NETFLIX INC,Communication,Equity,1,0.90,1,1,1,United States,NASDAQ,USD,1.00,USD,-');
for (let i = 0; i < 420; i++) ivv.push(`T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))},CO ${i},Industrials,Equity,1,0.10,1,1,1,United States,NASDAQ,USD,1.00,USD,-`);
const qqq = { effectiveDate: "2026-10-05", holdings: [{ ticker: "NFLX", issuerName: "Netflix Inc", percentageOfTotalNetAssets: 1.2, securityTypeName: "Common Stock" }].concat(Array.from({ length: 95 }, (_, i) => ({ ticker: `Q${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, issuerName: `N ${i}`, percentageOfTotalNetAssets: 0.5, securityTypeName: "Common Stock" }))) };
const KEY_FH = "fh-test-key-000";
let fhUrl = null, fhHeaders = null;
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  if (u.includes("ishares.com")) return new Response(ivv.join("\n"));
  if (u.includes("dng-api.invesco.com")) return new Response(JSON.stringify(qqq));
  if (u.startsWith("https://finnhub.io/api/v1/calendar/earnings")) { fhUrl = u; fhHeaders = o.headers; return o.headers["X-Finnhub-Token"] === KEY_FH ? new Response(JSON.stringify(FH)) : new Response("", { status: 401 }); }
  return new Response("", { status: 404 });
};
r = await call("/api/earnings?back=0&fwd=20", undefined, { ...env, FINNHUB_KEY: KEY_FH });
ok("/api/earnings: S&P 500 and Nasdaq-100 companies from the real index lists, both indexes kept", r.status === 200 && r.j.rows.map((x) => x.sym).join() === "JPM,NFLX" && r.j.rows[1].index.join() === "S&P 500,Nasdaq-100" && r.j.status === "LIVE");
ok("/api/earnings: the key is sent only in the X-Finnhub-Token header (never in the URL or response)", fhHeaders["X-Finnhub-Token"] === KEY_FH && !fhUrl.includes(KEY_FH) && !r.text.includes(KEY_FH));
fhHeaders = null;
r = await call("/api/earnings?back=0&fwd=21", undefined, { ...env, FINHUB_KEY: KEY_FH });
ok("/api/earnings: the secret saved as FINHUB_KEY works too (header only)", r.status === 200 && fhHeaders && fhHeaders["X-Finnhub-Token"] === KEY_FH && !r.text.includes(KEY_FH));

// ---------- company description (SEC) ----------
const SUB = { cik: "320193", name: "Apple Inc.", tickers: ["AAPL"], exchanges: ["Nasdaq"], sic: "3571", sicDescription: "Electronic Computers", category: "Large accelerated filer", stateOfIncorporation: "CA", stateOfIncorporationDescription: "CA", fiscalYearEnd: "0927", phone: "(408) 996-1010", website: "", addresses: { business: { street1: "ONE APPLE PARK WAY", city: "CUPERTINO", stateOrCountry: "CA", zipCode: "95014" } },
  filings: { recent: { form: ["4", "10-K", "8-K", "10-Q"], filingDate: ["2026-10-02", "2025-10-31", "2025-10-30", "2025-08-01"], accessionNumber: ["0000320193-26-000001", "0000320193-25-000079", "0000320193-25-000077", "0000320193-25-000073"], primaryDocument: ["a.xml", "aapl-20250927.htm", "a8k.htm", "aapl-20250628.htm"] } } };
const pr = normalizeProfile(SUB);
ok("SEC profile: name, industry (SIC), exchange, fiscal year end, address; forms 3/4 left out of filings", pr.name === "Apple Inc." && pr.industry === "Electronic Computers" && pr.exchanges[0] === "Nasdaq" && pr.fiscalYearEnd === "0927" && /CUPERTINO/.test(pr.address) && pr.filings.length === 3 && pr.filings[0].form === "10-K" && pr.filings[0].url.includes("/320193/000032019325000079/aapl-20250927.htm"));
const CONCEPT = { units: { USD: [
  { start: "2023-10-01", end: "2024-09-28", val: 391035e6, fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01" },
  { start: "2024-09-29", end: "2025-09-27", val: 416161e6, fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31" },
  { start: "2025-03-30", end: "2025-06-28", val: 94036e6, fy: 2025, fp: "Q3", form: "10-Q", filed: "2025-08-01" },
  { start: "2024-09-29", end: "2025-06-28", val: 313695e6, fy: 2025, fp: "Q3", form: "10-Q", filed: "2025-08-01" },
] } };
const pf = pickFact(CONCEPT, "USD");
ok("SEC fact: latest full fiscal year, the one before, latest single quarter (not the 9-month figure)", pf.annual.value === 416161e6 && pf.prevAnnual.value === 391035e6 && pf.quarter.value === 94036e6 && pf.quarter.end === "2025-06-28");
ok("SEC fact: a 10-Q's 3-month and 9-month figures for the same date are not taken for share classes", pf.latestMulti === false);
const TTMC = { units: { USD: [
  { start: "2023-10-01", end: "2024-09-28", val: 391e9, fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01" },
  { start: "2024-09-29", end: "2025-09-27", val: 416e9, fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31" },
  { start: "2025-09-28", end: "2026-06-27", val: 330e9, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-07-31" },
  { start: "2026-03-29", end: "2026-06-27", val: 100e9, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-07-31" },
  { start: "2024-09-29", end: "2025-06-28", val: 313e9, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-07-31" },
] } };
const tt = pickFact(TTMC, "USD");
ok("SEC fact: trailing twelve months = 9-month YTD + last fiscal year − the 9 months a year earlier", tt.ttm.value === 330e9 + 416e9 - 313e9 && tt.ttm.end === "2026-06-27" && tt.quarter.value === 100e9);
ok("SEC fact: unit not reported → null", pickFact(CONCEPT, "shares") === null);
ok("SEC fact: two values for the same period and filing (share classes) are flagged, not summed or picked", pickFact({ units: { shares: [{ end: "2025-10-17", val: 5.8e9, form: "10-K", filed: "2025-10-31" }, { end: "2025-10-17", val: 5.4e9, form: "10-K", filed: "2025-10-31" }] } }, "shares").latestMulti === true && pf.latestMulti === false);
ok("OCC option symbol: root, expiry, call/put, strike", JSON.stringify(parseOcc("AAPL261120C00250000")) === JSON.stringify({ root: "AAPL", exp: "2026-11-20", type: "call", strike: 250 }) && parseOcc("bad") === null);
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }));
  if (u.includes("/submissions/CIK0000320193.json")) return new Response(JSON.stringify(SUB));
  if (u.includes("/companyconcept/CIK0000320193/us-gaap/Revenues.json")) return new Response(JSON.stringify({ units: { USD: [{ start: "2017-10-01", end: "2018-09-29", val: 265595e6, fy: 2018, fp: "FY", form: "10-K", filed: "2018-11-05" }] } }));
  if (u.includes("/companyconcept/CIK0000320193/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json")) return new Response(JSON.stringify(CONCEPT));
  return new Response("", { status: 404 });
};
const envS = { ...env, SEC_CONTACT: "test@example.com" };
r = await call("/api/des?symbol=AAPL", undefined, envS);
ok("/api/des: profile from SEC submissions, list of available facts", r.status === 200 && r.j.profile.name === "Apple Inc." && r.j.facts.length === 6 && r.j.status === "LIVE");
r = await call("/api/des/fact?symbol=AAPL&c=revenue", undefined, envS);
ok("/api/des/fact: revenue from the concept the company reports most recently (an old concept with 2018 data loses)", r.status === 200 && r.j.annual.value === 416161e6 && r.j.concept === "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax");
r = await call("/api/des?symbol=ZZZZ", undefined, envS);
ok("/api/des: not an SEC registrant → 404 N/A", r.status === 404 && r.j.status === "N/A");
r = await call("/api/des/fact?symbol=AAPL&c=ebitda", undefined, envS);
ok("/api/des/fact: unknown fact → 400 (only what the filings report)", r.status === 400);

// ---------- options (Alpaca) ----------
const CONTRACTS = { option_contracts: [
  { symbol: "AAPL261120C00250000", expiration_date: "2026-11-20", type: "call", strike_price: "250", open_interest: "1200", open_interest_date: "2026-10-05" },
  { symbol: "AAPL261120P00250000", expiration_date: "2026-11-20", type: "put", strike_price: "250", open_interest: "800", open_interest_date: "2026-10-05" },
  { symbol: "AAPL261218C00250000", expiration_date: "2026-12-18", type: "call", strike_price: "250", open_interest: null },
], next_page_token: null };
const SNAP = { snapshots: {
  AAPL261120C00250000: { latestQuote: { bp: 9.8, ap: 10.1, t: "2026-10-06T19:59:00Z" }, latestTrade: { p: 10, t: "2026-10-06T19:58:00Z" }, impliedVolatility: 0.27, greeks: { delta: 0.52, gamma: 0.02, theta: -0.08, vega: 0.31 } },
  AAPL261120P00250000: { latestQuote: { bp: 8.9, ap: 9.2, t: "2026-10-06T19:59:00Z" }, impliedVolatility: 0.29, greeks: { delta: -0.48 } },
} };
let alpCalls = [];
globalThis.fetch = async (u, o = {}) => {
  u = String(u); alpCalls.push(u);
  if (u.includes("/v2/stocks/trades/latest")) return new Response(JSON.stringify({ trades: { AAPL: { p: 251.2, t: "2026-10-06T19:59:59Z" } } }));
  if (u.startsWith("https://paper-api.alpaca.markets/v2/options/contracts")) return new Response(JSON.stringify(CONTRACTS));
  if (u.startsWith("https://data.alpaca.markets/v1beta1/options/snapshots/AAPL")) return new URL(u).searchParams.get("feed") === "indicative" ? new Response(JSON.stringify(SNAP)) : new Response("", { status: 403 });
  return new Response("", { status: 404 });
};
const envA = { ...env, ALPACA_KEY_ID: "id", ALPACA_SECRET_KEY: "secret" };
r = await call("/api/options/expirations?symbol=AAPL", undefined, envA);
ok("/api/options/expirations: expiries with contract counts near the spot", r.status === 200 && r.j.expirations.map((x) => x.exp).join() === "2026-11-20,2026-12-18" && r.j.spot.price === 251.2);
r = await call("/api/options/chain?symbol=AAPL&exp=2026-11-20", undefined, envA);
const row = r.j && r.j.rows[0];
ok("/api/options/chain: calls and puts per strike, bid/ask/last, IV, greeks, open interest; feed labelled indicative", r.status === 200 && row.strike === 250 && row.call.bid === 9.8 && row.call.oi === 1200 && row.put.delta === -0.48 && row.put.last === null && /indicative/.test(r.j.feed));
r = await call("/api/options/chain?symbol=AAPL&exp=2026-11-20", undefined, env);
ok("/api/options without Alpaca keys → 503 N/A", r.status === 503);

// ---------- the owner's alerts / notes / boards ----------
ok("alert validation: symbol, >= or <=, positive price", validateAlert({ sym: "nvda", op: ">=", price: 200 }).sym === "NVDA" && typeof validateAlert({ sym: "NVDA", op: ">", price: 1 }) === "string" && typeof validateAlert({ sym: "NVDA", op: "<=", price: -1 }) === "string");
ok("note validation: text required, control characters removed", validateNote({ text: "a\u0000b" }).text === "ab" && typeof validateNote({ text: "  " }) === "string");
ok("board validation: name required, symbols deduplicated, at most 12 per board", validateBoards({ boards: [{ name: "EU banks", syms: ["isp.mi", "ISP.MI", "UCG:XMIL"] }] })[0].syms.join() === "ISP.MI,UCG:XMIL" && typeof validateBoards({ boards: [{ name: "x", syms: Array.from({ length: 13 }, (_, i) => "S" + i) }] }) === "string" && LIMITS.boardSyms === 12);
const kv = new Map(), BRIEFS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
const envU = { ...env, BRIEFS };
const J = (method, b) => ({ method, headers: { "content-type": "application/json", origin: "https://alessandrozanichelli.com" }, body: JSON.stringify(b) });
r = await call("/api/user/alerts", undefined, envU);
ok("alerts / notes / boards start empty", r.status === 200 && r.j.alerts.length === 0 && (await call("/api/user/notes", undefined, envU)).j.notes.length === 0 && (await call("/api/user/board", undefined, envU)).j.boards.length === 0);
r = await call("/api/user/alerts", J("POST", { sym: "NVDA", op: ">=", price: 200, note: "breakout" }), envU);
const aid = r.j && r.j.added;
ok("alert stored (KV ud/alerts), not fired", r.status === 201 && JSON.parse(kv.get("ud/alerts"))[0].hit === null);
r = await call(`/api/user/alerts/hit?id=${aid}`, J("POST", { price: 201.5, source: "Twelve Data" }), envU);
ok("alert fired: time and the live price the page saw are recorded once", r.status === 200 && r.j.alerts[0].hit.price === 201.5);
r = await call(`/api/user/alerts/hit?id=${aid}`, J("POST", { price: 250 }), envU);
ok("alert fired twice: the first record stays", r.j.alerts[0].hit.price === 201.5);
for (let i = 0; i < 10; i++) await call("/api/user/alerts", J("POST", { sym: "S" + i, op: "<=", price: 1 }), envU);
r = await call("/api/user/alerts", J("POST", { sym: "EXTRA", op: "<=", price: 1 }), envU);
ok("live alerts watch at most 10 different symbols (quote credits)", r.status === 400 && /10 different symbols/.test(r.j.message));
r = await call("/api/user/alerts", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }, envU);
ok("writes from another origin → 403; non-JSON → 415", r.status === 403 && (await call("/api/user/notes", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }, envU)).status === 415);
r = await call("/api/user/notes", J("POST", { text: "Watch the ECB on Thursday", sym: "EUR/USD" }), envU);
const nid = r.j && r.j.added;
r = await call(`/api/user/notes?id=${nid}`, J("PUT", { text: "Watch the ECB on Thursday — hawkish risk", sym: "EUR/USD" }), envU);
ok("notes: add and edit (updated time recorded)", r.status === 200 && r.j.notes[0].text.endsWith("hawkish risk") && r.j.notes[0].updated);
r = await call(`/api/user/notes?id=${nid}`, { method: "DELETE" }, envU);
ok("notes: delete", r.status === 200 && r.j.notes.length === 0);
r = await call("/api/user/board", J("PUT", { boards: [{ name: "Italy", syms: ["ISP:XMIL", "ENI:XMIL"] }] }), envU);
ok("boards: replaced as a whole, ids assigned", r.status === 200 && r.j.boards[0].id && JSON.parse(kv.get("ud/board"))[0].name === "Italy");
r = await call("/api/user/alerts", undefined, { ...env, BRIEFS: undefined });
ok("no storage → 503 N/A", r.status === 503);

// ---------- system status ----------
const SECRET = "td-secret-value-123";
let tdUsageAuth = null, usageCalls = 0;
globalThis.fetch = async (u, o = {}) => { if (String(u) === "https://api.twelvedata.com/api_usage") { usageCalls++; tdUsageAuth = o.headers.Authorization; return new Response(JSON.stringify({ timestamp: "2026-10-07 10:00:00", current_usage: 3, plan_limit: 8, daily_usage: 120, plan_daily_limit: 800, plan_category: "basic" })); } return new Response("", { status: 404 }); };
kv.set("cron/last", JSON.stringify({ at: "2026-10-07T05:30:00.000Z", periods: ["daily"] }));
const envT = { ...envU, TWELVEDATA_KEY: SECRET, ALPACA_KEY_ID: "kid-xyz", ALPACA_SECRET_KEY: "ks-xyz", EIA_KEY: "eia-xyz" };
r = await call("/api/status", undefined, envT);
const src = r.j && Object.fromEntries(r.j.sources.map((s) => [s.id, s.configured]));
ok("/api/status: sources configured yes/no, scheduler's last run; credits not checked unless asked (each check costs 1)", r.status === 200 && src.twelvedata === true && src.finnhub === false && src.eia === true && r.j.scheduler.lastRun.periods[0] === "daily" && r.j.twelvedata.error === "not_checked" && usageCalls === 0 && r.j.credits === 0);
r = await call("/api/status?usage=1", undefined, envT);
ok("/api/status?usage=1: Twelve Data credits this minute and today; 1 credit reported", r.j.twelvedata.minute.used === 3 && r.j.twelvedata.day.limit === 800 && r.j.credits === 1 && usageCalls === 1);
const r2 = await call("/api/status?usage=1", undefined, envT), r3 = await call("/api/status", undefined, envT);
ok("/api/status: a second check within 5 minutes reuses the first (no credit); the plain status shows the last check", usageCalls === 1 && r2.j.credits === 0 && r3.j.twelvedata.minute.used === 3);
ok("/api/status: no secret value appears in the response; the key goes only in the Authorization header", ![r, r2, r3].some((x) => /td-secret|kid-xyz|ks-xyz|eia-xyz/.test(x.text)) && tdUsageAuth === `apikey ${SECRET}`);
ok("sourcesStatus: only booleans", sourcesStatus({ TWELVEDATA_KEY: "x" }).every((s) => typeof s.configured === "boolean"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
