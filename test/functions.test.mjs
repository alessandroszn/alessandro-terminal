// T07 — function menu, Worker side: central banks, spreads, energy (EIA), earnings (Finnhub), company description
// (SEC), options (Alpaca), the owner's alerts / notes / boards, and the system status.
// Provider responses are test fixtures in the providers' formats; nothing here is shown in the terminal.
//   node test/functions.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseEcbRate, parseNyFed, parseBoe, parseSnb, parseBoc, parseSpread, parseEia, EIA_SPOT, EIA_STOCKS, stockRow, spotRow, lastChange } from "../src/macro.mjs";
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
ok("EIA lists: 8 spot series; 9 weekly series (6 petroleum stocks, gas storage, refinery utilization, crude production)", EIA_SPOT.length === 8 && EIA_STOCKS.length === 9 && EIA_STOCKS.filter((x) => x[5] === "stock").length === 7);
// weekly rows (EIA units), oldest first: a week ending every Friday from 2020-10-02 to 2026-10-16
const WEEKS = []; for (let t = Date.parse("2020-10-02T00:00:00Z"); t <= Date.parse("2026-10-16T00:00:00Z"); t += 7 * 86400_000) WEEKS.push(new Date(t).toISOString().slice(0, 10));
const lvl = (d) => 400000 + (Number(d.slice(0, 4)) - 2020) * 1000 + (d === "2026-10-16" ? 3200 : 0); // each year 1,000 higher; the latest week +3,200 over the one before
const crudeX = WEEKS.map((d) => [d, lvl(d)]), NOW_W = Date.parse("2026-10-22T15:00:00Z");
const sr = stockRow("WCESTUS1", "Crude oil (excl. SPR)", "M bbl", 1000, "stock", crudeX, NOW_W);
ok("stockRow: thousand barrels → million, the week's change, vs the week nearest a year earlier", sr.value === 409.2 && sr.chgWeek === 3.2 && sr.yearAgoDate === "2025-10-17" && sr.vsYearAgo === 4.2 && sr.date === "2026-10-16");
ok("stockRow: 5-year average = the same week in each of the five previous years (2021–2025), vs it in % (DERIVED)", sr.avg5 === 403 && sr.vsAvg5Pct === Math.round((409200 / 403000 - 1) * 1000) / 10 && sr.history.length === 60);
const srShort = stockRow("WCESTUS1", "Crude", "M bbl", 1000, "stock", crudeX.slice(-150), NOW_W);
ok("stockRow: fewer than five years of history → no 5-year average (not a shorter one)", srShort.avg5 === null && srShort.vsAvg5Pct === null && srShort.vsYearAgo === 4.2);
const srRate = stockRow("WPULEUS3", "Refinery utilization", "%", 1, "rate", WEEKS.map((d) => [d, 90.1]), NOW_W);
ok("stockRow: a rate (utilization) has no % vs average; its levels as published", srRate.value === 90.1 && srRate.vsAvg5Pct === null && srRate.avg5 === 90.1);
const srOld = stockRow("WCESTUS1", "Crude", "M bbl", 1000, "stock", crudeX.slice(0, -10), NOW_W);
ok("stockRow: a series whose latest week is over four weeks old → N/A (source_discontinued), never shown as current", srOld.status === "N/A" && srOld.error === "source_discontinued" && srOld.value === undefined && srOld.lastDate === "2026-08-07");
const spOld = spotRow("RWTC", "WTI", "$/bbl", [["2024-04-04", 85], ["2024-04-05", 86]], "RWTC", NOW_W);
ok("spotRow: a spot series that stopped (last price 2024) → N/A with its last date, not a value", spOld.status === "N/A" && spOld.error === "source_discontinued" && spOld.lastDate === "2024-04-05" && spOld.value === undefined);

// ---------- routed handlers with mocked providers ----------
const seen = []; let eiaWeeklyDown = false, eiaAllDown = false;
const ENERGY_ROWS = (series, n) => ({ response: { data: series.flatMap((s, k) => Array.from({ length: n }, (_, i) => ({ period: `2026-${String(8 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, series: s, value: 60 + k + i / 100 }))) } });
globalThis.fetch = async (u, o = {}) => {
  u = String(u); seen.push({ u, h: o.headers || {} });
  if (u.includes("FM/B.U2.EUR.4F.KR.DFR+MRR_FR+MLFR.LEV") && u.includes("detail=dataonly")) return new Response(ECB_ALL);
  if (u.startsWith("https://markets.newyorkfed.org/")) return new Response(JSON.stringify(NYF));
  if (u.startsWith("https://www.bankofengland.co.uk/")) return new Response(BOE);
  if (u.startsWith("https://data.snb.ch/")) { if (!/fromDate=\d{4}-\d{2}-\d{2}/.test(u)) return new Response("whole cube", { status: 200 }); return new Response("", { status: 503 }); }
  if (u.startsWith("https://www.bankofcanada.ca/")) return new Response(JSON.stringify(BOC));
  if (u.includes("/YC/")) return new Response(sp);
  if (u.startsWith("https://api.eia.gov/v2/") && eiaAllDown) return new Response("", { status: 500 });
  if (u.startsWith("https://api.eia.gov/v2/") && new URL(u).searchParams.get("frequency") === "weekly") {
    const q = new URL(u).searchParams, ser = q.getAll("facets[series][]"), len = Number(q.get("length"));
    if (eiaWeeklyDown && u.includes("/natural-gas/")) return new Response("", { status: 500 });
    // EIA v2 rows as EIA sends them: newest first, facet columns, values as strings, cut at `length`
    const rows = ser.flatMap((s) => WEEKS.map((d) => ({ period: d, duoarea: "NUS", "area-name": "U.S.", series: s, "series-description": s + " (Thousand Barrels)", value: String(s === "WPULEUS3" ? 90.1 : s === "NW2_EPG0_SWO_R48_BCF" ? 3500 : lvl(d)), units: "MBBL" })));
    rows.sort((a, b) => (a.period < b.period ? 1 : -1));
    return new Response(JSON.stringify({ response: { total: rows.length, frequency: "weekly", data: rows.slice(0, len) } }));
  }
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
const realNowF = Date.now; Date.now = () => Date.parse("2026-09-04T12:00:00Z"); // the spot fixture's dates (Aug–2 Sep) are recent at this moment
r = await call("/api/energy", undefined, envE);
Date.now = realNowF;
const wti = r.j && r.j.spot.find((x) => x.series === "RWTC");
ok("/api/energy: spot rows with date, value and 1D/1W/1M changes (DERIVED from EIA values)", r.status === 200 && wti.date && Number.isFinite(wti.value) && Number.isFinite(wti.chg1) && Number.isFinite(wti.chg21) && wti.history.length === 30);
ok("/api/energy: EIA's NYMEX futures (ended 2024-04-05) are not requested; N/A naming why", r.j.futures.status === "N/A" && r.j.futures.error === "source_discontinued" && !r.j.curves && !seen.some((x) => /pri\/fut\/data\/.*R(CL|NG)C\d/.test(decodeURIComponent(x.u))));
r = await call("/api/energy", undefined, envE);
ok("/api/energy: a month later the same fixture is old → each spot row N/A (source_discontinued), status N/A", r.j.status === "N/A" && r.j.spot.every((x) => x.status === "N/A" && x.error === "source_discontinued"));
r = await call("/api/energy/stocks", undefined, env);
ok("/api/energy/stocks without EIA_KEY → 503 N/A naming EIA_KEY, no provider call", r.status === 503 && r.j.error === "eia_not_configured" && !seen.some((x) => x.u.includes("frequency=weekly")));
const realNowS = Date.now; Date.now = () => NOW_W;
r = await call("/api/energy/stocks", undefined, envE);
const st0 = r.j && Object.fromEntries(r.j.rows.map((x) => [x.series, x])), wk = seen.filter((x) => x.u.includes("frequency=weekly"));
ok("/api/energy/stocks: nine rows in order, LIVE; one request per EIA route (4), weekly, five years of weeks", r.status === 200 && r.j.status === "LIVE" && r.j.rows.length === 9 && r.j.rows[0].series === "WCESTUS1" && wk.length === 4 && wk.every((x) => /length=\d+/.test(x.u)) && wk.some((x) => x.u.includes("/petroleum/stoc/wstk/") && x.u.includes("length=1650")), wk.map((x) => x.u.split("?")[0]).join());
ok("/api/energy/stocks: crude in M bbl with the week's change, vs a year ago and vs the 5-year average", st0.WCESTUS1.value === 409.2 && st0.WCESTUS1.chgWeek === 3.2 && st0.WCESTUS1.vsYearAgo === 4.2 && st0.WCESTUS1.avg5 === 403 && st0.NW2_EPG0_SWO_R48_BCF.unit === "Bcf" && st0.NW2_EPG0_SWO_R48_BCF.value === 3500 && st0.WPULEUS3.value === 90.1);
ok("/api/energy/stocks: the response says what is DERIVED and links EIA's report; the key never in it", /DERIVED/.test(r.j.basis) && r.j.sourceUrl.startsWith("https://www.eia.gov/") && !r.text.includes(KEY_EIA) && wk.every((x) => x.u.includes(KEY_EIA)));
ok("/api/energy/stocks: the cache keeps derived rows (about 60 weeks each), not five years of raw weeks", r.j.rows.every((x) => !x.history || x.history.length <= 60));
eiaWeeklyDown = true; Date.now = () => NOW_W + 9 * 3600_000; // past the 8-hour TTL: the gas route fails now, the petroleum routes refresh
r = await call("/api/energy/stocks", undefined, envE);
const gasRow = r.j && r.j.rows.find((x) => x.series === "NW2_EPG0_SWO_R48_BCF");
ok("/api/energy/stocks: one route failing after a good load → its last copy STALE, the response says STALE", r.status === 200 && r.j.status === "STALE" && gasRow.value === 3500);
eiaWeeklyDown = false;
// ---------- EIA staging: the 5-minute scheduled run fetches one EIA table at a time into KV; pages read KV, never EIA ----------
const kvE = new Map(), KVE = { get: async (k) => kvE.get(k) ?? null, put: async (k, v) => { kvE.set(k, v); } }, envK = { ...envE, BRIEFS: KVE };
const eiaCalls = () => seen.filter((x) => x.u.startsWith("https://api.eia.gov/")).length;
Date.now = () => NOW_W; let n0 = eiaCalls();
r = await call("/api/energy/stocks", undefined, envK);
ok("staging: a page with nothing staged yet → N/A not_staged (the page says why), no EIA call", r.status === 502 && r.j.status === "N/A" && r.j.error === "not_staged" && /scheduled run/.test(r.j.note) && eiaCalls() === n0);
const { refreshEia, EIA_UNITS } = await import("../src/macro.mjs");
const acts = []; n0 = eiaCalls();
for (let k = 0; k < EIA_UNITS.length; k++) acts.push((await refreshEia(envK, NOW_W)).action);
ok("staging: refreshEia fetches one EIA table per run (2 spot + 4 weekly routes) and writes it to KV under stage/", EIA_UNITS.length === 6 && acts.every((a) => a === "refreshed") && EIA_UNITS.every((u) => kvE.has("stage/" + u.key)) && eiaCalls() - n0 === 6);
ok("staging: what KV keeps is the derived rows for the weekly tables, never the key", JSON.parse(kvE.get("stage/eia/stocks2/petroleum/stoc/wstk")).data.WCESTUS1.value === 409.2 && ![...kvE.values()].some((v) => v.includes(KEY_EIA)));
ok("staging: every table renewed less than 4 h ago → the run fetches nothing", (await refreshEia(envK, NOW_W + 3600_000)).action === "fresh" && eiaCalls() - n0 === 6);
n0 = eiaCalls();
r = await call("/api/energy/stocks", undefined, envK);
ok("staging: the page serves the staged copy LIVE without calling EIA", r.status === 200 && r.j.status === "LIVE" && r.j.rows[0].value === 409.2 && eiaCalls() === n0);
r = await call("/api/energy", undefined, envK);
ok("staging: /api/energy reads the staged EIA spot table too (no EIA call)", r.status === 200 && /EIA\) — daily spot prices/.test(r.j.source) && eiaCalls() === n0);
eiaAllDown = true; const before = kvE.get("stage/eia/spot/petroleum/pri/spt");
const fr = await refreshEia(envK, NOW_W + 5 * 3600_000);
ok("staging: EIA failing → nothing written (the last copy stays), retried at the next run", fr.action === "failed" && fr.key === "eia/spot/petroleum/pri/spt" && kvE.get("stage/eia/spot/petroleum/pri/spt") === before);
Date.now = () => NOW_W + 9 * 3600_000;
r = await call("/api/energy/stocks", undefined, envK);
ok("staging: a staged copy older than 8 h is shown STALE, not LIVE", r.j.status === "STALE" && r.j.rows[0].value === 409.2);
ok("staging: without EIA_KEY the scheduled run does nothing", (await refreshEia({ BRIEFS: KVE }, NOW_W)).action === "skipped");
Date.now = realNowS; eiaAllDown = false;
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
ok("alert validation: daily move, market open / close, data release; unsupported symbols refused", validateAlert({ kind: "move", sym: "EUR/USD", dir: "any", pct: 1 }).pct === 1 && validateAlert({ kind: "session", market: "IT", event: "close" }).market === "IT" && validateAlert({ kind: "release", country: "United States", match: "cpi" }).match === "cpi" && /not supported/.test(validateAlert({ sym: "USD/EUR", op: ">=", price: 1 })) && typeof validateAlert({ kind: "session", market: "XX", event: "open" }) === "string");
ok("note validation: text required, control characters removed", validateNote({ text: "a\u0000b" }).text === "ab" && typeof validateNote({ text: "  " }) === "string");
ok("board validation: name required, symbols deduplicated, at most 12 per board", validateBoards({ boards: [{ name: "EU banks", syms: ["isp.mi", "ISP.MI", "UCG:XMIL"] }] })[0].syms.join() === "ISP.MI,UCG:XMIL" && typeof validateBoards({ boards: [{ name: "x", syms: Array.from({ length: 13 }, (_, i) => "S" + i) }] }) === "string" && LIMITS.boardSyms === 12);
const kv = new Map(), BRIEFS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
const envU = { ...env, BRIEFS };
const J = (method, b) => ({ method, headers: { "content-type": "application/json", origin: "https://alessandrozanichelli.com" }, body: JSON.stringify(b) });
r = await call("/api/user/alerts", undefined, envU);
ok("alerts / notes / boards start empty", r.status === 200 && r.j.alerts.length === 0 && (await call("/api/user/notes", undefined, envU)).j.notes.length === 0 && (await call("/api/user/board", undefined, envU)).j.boards.length === 0);
// the server saves a symbol only if CNBC (the feed alerts are checked on) quotes it now
const SX = (i) => "S" + String.fromCharCode(65 + i), CN_KNOWN = new Set(["NVDA", ...Array.from({ length: 26 }, (_, i) => SX(i))]), fetch0 = globalThis.fetch;
globalThis.fetch = async (u, o) => { const s = String(u); if (s.startsWith("https://quote.cnbc.com/")) { const syms = new URL(s).searchParams.get("symbols").split("|"); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.filter((x) => CN_KNOWN.has(x) || x === "700-HK" || x === "ISP-IT").map((x) => ({ code: 0, symbol: x, name: x + " Corp", last: "100.00", last_time: x === "700-HK" ? "2026-10-20" : "2026-10-20T15:00:00.000-0400", previous_day_closing: "99.00", change: "+1.00", change_pct: "+1.01%" })) } }), { status: 200 }); } return fetch0(u, o); };
r = await call("/api/user/alerts", J("POST", { sym: "NVDA", op: ">=", price: 200, note: "breakout" }), envU);
const aid = r.j && r.j.added;
ok("alert stored (KV ud/alerts), not fired, with CNBC's name", r.status === 201 && JSON.parse(kv.get("ud/alerts"))[0].hit === null && r.j.alerts[0].name === "NVDA Corp" && r.j.alerts[0].kind === "price");
r = await call("/api/user/alerts", J("POST", { sym: "ZZZZ", op: ">=", price: 1 }), envU);
ok("a symbol CNBC does not quote is refused", r.status === 400 && /no CNBC quote for ZZZZ/.test(r.j.message));
r = await call("/api/user/alerts", J("POST", { sym: "C:700-HK", op: ">=", price: 1 }), envU);
ok("an alert on a listing CNBC dates without a time is refused (it could not tell a live price from an old one)", r.status === 400 && /without a time/.test(r.j.message));
r = await call("/api/user/alerts", J("POST", { sym: "ISP:XMIL", op: "<=", price: 90 }), envU);
ok("an alert on a listing outside the U.S. (Milan, through CNBC) is accepted", r.status === 201 && r.j.alerts.at(-1).sym === "ISP:XMIL");
await call(`/api/user/alerts?id=${r.j.added}`, { method: "DELETE" }, envU);
r = await call(`/api/user/alerts/rearm?id=${aid}`, J("POST", {}), envU);
ok("an alert that has not fired cannot be re-armed", r.status === 400);
{ const l = JSON.parse(kv.get("ud/alerts")); l[0].hit = { at: "2026-10-20T19:00:00.000Z", price: 201.5, source: "CNBC" }; kv.set("ud/alerts", JSON.stringify(l)); }
r = await call(`/api/user/alerts/rearm?id=${aid}`, J("POST", {}), envU);
ok("a fired price alert is re-armed (watches again)", r.status === 200 && r.j.alerts[0].hit === null && r.j.alerts[0].rearmed);
for (let i = 0; i < 24; i++) await call("/api/user/alerts", J("POST", { sym: SX(i), op: "<=", price: 1 }), envU);
r = await call("/api/user/alerts", J("POST", { sym: "SZ", kind: "move", dir: "up", pct: 2 }), envU);
ok("alerts watch at most 25 different symbols (one CNBC request)", r.status === 400 && /25 different symbols/.test(r.j.message));
r = await call("/api/user/alerts", J("POST", { kind: "session", market: "US", event: "both" }), envU);
ok("a market open / close alert needs no symbol", r.status === 201 && r.j.alerts.at(-1).kind === "session");
globalThis.fetch = fetch0;
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
r = await call("/api/user/views", J("POST", { name: "Morning", desk: { w: 1600, h: 900 }, layout: [{ type: "YLD", state: { c: "IT" }, x: 0, y: 0, w: 800, h: 450 }, { type: "N", state: { src: "ALL" }, x: 800, y: 0, w: 800, h: 450, min: true }] }), envU);
const vid = r.j && r.j.saved;
ok("views: a layout is saved (window types, their state, positions, desk size)", r.status === 201 && r.j.views[0].layout.length === 2 && r.j.views[0].layout[1].min === true && r.j.views[0].desk.w === 1600);
r = await call("/api/user/views", J("POST", { name: "morning", layout: [{ type: "CB", state: {}, x: 0, y: 0, w: 500, h: 400 }] }), envU);
ok("views: the same name (any case) replaces that view", r.status === 200 && r.j.replaced === true && r.j.views.length === 1 && r.j.views[0].id === vid && r.j.views[0].layout[0].type === "CB");
r = await call("/api/user/views", J("POST", { name: "x", layout: [{ type: "bad type", state: {}, x: 0, y: 0, w: 1, h: 1 }] }), envU);
ok("views: bad window type / missing name / huge state refused", r.status === 400 && (await call("/api/user/views", J("POST", { layout: [{ type: "CB", x: 0, y: 0, w: 1, h: 1 }] }), envU)).status === 400 && (await call("/api/user/views", J("POST", { name: "big", layout: [{ type: "CB", state: { s: "x".repeat(5000) }, x: 0, y: 0, w: 1, h: 1 }] }), envU)).status === 400);
r = await call("/api/user/views", J("POST", { name: "Linked", layout: [{ type: "GP", state: { ticker: "AAPL" }, x: 0, y: 0, w: 500, h: 400, link: 2 }, { type: "DES", state: {}, x: 0, y: 0, w: 500, h: 400, link: 9 }] }), envU);
const lid = r.j.saved;
ok("views: a window's colour link (1–4) is kept; anything else dropped", r.status === 201 && r.j.views.find((v) => v.id === lid).layout[0].link === 2 && !("link" in r.j.views.find((v) => v.id === lid).layout[1]));
r = await call(`/api/user/views?id=${lid}`, J("PUT", { name: "Linked desk" }), envU);
ok("views: renamed in place (same id, same windows)", r.status === 200 && r.j.views.find((v) => v.id === lid).name === "Linked desk" && r.j.views.find((v) => v.id === lid).layout.length === 2);
r = await call(`/api/user/views?id=${lid}`, J("PUT", { layout: [{ type: "CB", state: {}, x: 10, y: 10, w: 600, h: 400 }], desk: { w: 1600, h: 900 } }), envU);
ok("views: its windows saved again (the tab you leave), name kept", r.status === 200 && r.j.views.find((v) => v.id === lid).layout[0].type === "CB" && r.j.views.find((v) => v.id === lid).name === "Linked desk");
r = await call(`/api/user/views?id=${lid}`, J("PUT", { name: "MORNING" }), envU);
const vr2 = await call("/api/user/views?id=nope", J("PUT", { name: "x" }), envU), vr3 = await call(`/api/user/views?id=${lid}`, J("PUT", { layout: [] }), envU);
ok("views: a name another view has, an unknown view or an empty layout refused", r.status === 400 && vr2.status === 404 && vr3.status === 400);
await call(`/api/user/views?id=${lid}`, { method: "DELETE" }, envU);
r = await call("/api/user/bcfg", J("PUT", { bcfg: [{ type: "FUT", hide: ["@VX.1", "@VX.1", "@OJ.1"] }, { type: "IDX", hide: [] }] }), envU);
ok("boards: the rows hidden in a built-in board are kept (duplicates and empty boards dropped)", r.status === 200 && JSON.stringify(r.j.bcfg) === JSON.stringify([{ type: "FUT", hide: ["@VX.1", "@OJ.1"] }]));
r = await call("/api/user/bcfg", undefined, envU);
const rb1 = await call("/api/user/bcfg", J("PUT", { bcfg: [{ type: "fut", hide: [] }] }), envU), rb2 = await call("/api/user/bcfg", J("PUT", { bcfg: [{ type: "FUT", hide: ["<b>"] }] }), envU);
ok("boards: read back; a bad board type or row key refused", r.status === 200 && r.j.bcfg[0].hide.length === 2 && rb1.status === 400 && rb2.status === 400);
r = await call(`/api/user/views?id=${vid}`, { method: "DELETE" }, envU);
ok("views: delete", r.status === 200 && r.j.views.length === 0);
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
