// World government bonds (Bundesbank, Bank of England, Japan MOF, SNB, Bank of Canada, FRED), CFTC positioning and the
// ETF universe — Worker side. Provider responses are fixtures in the providers' own formats (checked live on 7 Oct 2026).
//   node test/bonds.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseBundesbank, parseBoeYields, parseMof, parseSnbBonds, parseBocBonds, parseFred, getYieldCurves, ukUrl, fredUrl, US_FRED } from "../src/yields.mjs";
import { changes, countryRow, bundSpreads } from "../src/bonds.mjs";
import { summarizeCot, cotQuery, COT_CONTRACTS } from "../src/cot.mjs";
import { UNIVERSES, ASSET_ETFS } from "../src/spx.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };
const ctx = { waitUntil: () => {} };
const call = async (path, env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };

// ---------- parsers (formats as published) ----------
const K = (c) => `BBSIS.D.I.ZAR.ZI.EUR.S1311.B.A604.${c}.R.A.A._Z._Z.A`;
const DE = `"",${K("R02XX")},${K("R02XX")}_FLAGS,${K("R10XX")},${K("R10XX")}_FLAGS\n"","Yields … 2.0 years","",…\nDecimals,2,,2,\nlast update,2026-10-07 13:07:13,,2026-10-07 13:07:14,\n2026-09-07,2.95,,3.40,\n2026-09-30,3.00,,3.44,\n2026-10-06,3.08,,3.49,\n2026-10-07,3.06,,3.52,\n`;
const de = parseBundesbank(DE);
const DE_DE = DE.replace(/,/g, ";").replace(/(\d)\.(\d)/g, "$1,$2");
ok("Bundesbank: the German-locale output (; and decimal commas) reads the same", JSON.stringify(parseBundesbank(DE_DE)) === JSON.stringify(parseBundesbank(DE)) && parseBundesbank(DE_DE)[3].points.find((p) => p.tenor === "10Y").value === 3.52, JSON.stringify(parseBundesbank(DE_DE)));
ok("Bundesbank: wide CSV — maturities read from the series keys, flags skipped, metadata lines ignored", de.length === 4 && de[3].date === "2026-10-07" && de[3].points.find((p) => p.tenor === "10Y").value === 3.52 && de[3].points.find((p) => p.tenor === "2Y").value === 3.06 && de[3].points.find((p) => p.tenor === "5Y").value === null);
const UK = "DATE,IUDSNPY,IUDMNPY,IUDLNPY\r\n02 Oct 2026,4.8917,5.3341,5.6879\r\n05 Oct 2026,4.9311,5.3634,\r\n";
const uk = parseBoeYields(UK);
ok("Bank of England: gilt par yields 5/10/20 years by date; an empty cell is missing, not zero", uk.length === 2 && uk[1].date === "2026-10-05" && uk[1].points.find((p) => p.tenor === "10Y").value === 5.3634 && uk[1].points.find((p) => p.tenor === "20Y").value === null);
ok("Bank of England URL: about 50 days of history, the three series", /Datefrom=\d{2}\/[A-Z][a-z]{2}\/\d{4}&Dateto=now&SeriesCodes=IUDSNPY,IUDMNPY,IUDLNPY/.test(ukUrl(Date.parse("2026-10-07T12:00:00Z"))));
const JP = "Interest Rate (October 2026),,,,,,,,,,,,,,,(Unit : %)\r\nDate,1Y,2Y,3Y,4Y,5Y,6Y,7Y,8Y,9Y,10Y,15Y,20Y,25Y,30Y,40Y\r\n2026/10/1,1.668,1.939,2.077,2.274,2.407,2.534,2.657,2.82,2.952,3.092,3.62,3.91,4.154,4.122,4.125\r\n2026/10/2,1.65,1.919,2.065,2.259,2.397,2.528,2.657,2.821,2.957,3.097,3.626,3.925,4.171,4.1,-\r\n,,,,,,,,,,,,,,,\r\n\"If you cannot download the latest csv data, please clear the browser's cache\",,,,\r\n";
const jp = parseMof(JP);
ok("Japan MOF: JGB rates by date (YYYY/M/D), \"-\" is missing, footer lines ignored", jp.length === 2 && jp[1].date === "2026-10-02" && jp[1].points.find((p) => p.tenor === "10Y").value === 3.097 && jp[1].points.find((p) => p.tenor === "40Y").value === null);
const SNB = '"CubeId";"rendoeid"\r\n"PublishingDate";"2026-10-01 14:30"\r\n\r\n"Date";"d0";"d1";"Value"\r\n'
  + [["V07_1", 0.147, 0.75], ["V98_2", 0.385, 1.53], ["V16_1", 0.502, 2.73], ["V11_2", 0.583, 4.73], ["V18_1", 0.62, 5.6], ["V13_1", 0.71, 9.6], ["V12_1", 0.73, 10.9], ["V17_2", 0.549, 28.65], ["V14_2", 0.483, 37.7]]
    .map(([b, y, lz]) => `"2026-09-30";"${b}";"R1";"${y}"\r\n"2026-09-30";"${b}";"LZ";"${lz}"`).join("\r\n");
const ch = parseSnbBonds(SNB), chp = (t) => ch[0].points.find((p) => p.tenor === t);
ok("SNB: each maturity = the Confederation bond closest to it (10Y → 9.6-year bond), with the bond named; none near 20Y → N/A", chp("10Y").value === 0.71 && /V13_1, 9\.6 years/.test(chp("10Y").note) && chp("2Y").value === 0.385 && chp("5Y").value === 0.583 && chp("30Y").value === 0.549 && chp("20Y").value === null, JSON.stringify(ch[0].points));
const BOC = { observations: [{ d: "2026-10-06", "BD.CDN.2YR.DQ.YLD": { v: "3.23" }, "BD.CDN.10YR.DQ.YLD": { v: "3.92" }, "BD.CDN.LONG.DQ.YLD": { v: "4.28" } }, { d: "2026-10-05", "BD.CDN.2YR.DQ.YLD": { v: "3.26" }, "BD.CDN.10YR.DQ.YLD": { v: "" } }] };
const ca = parseBocBonds(BOC);
ok("Bank of Canada: benchmark yields by date (oldest first), long-term benchmark kept as LONG", ca[0].date === "2026-10-05" && ca[1].points.find((p) => p.tenor === "LONG").value === 4.28 && ca[0].points.find((p) => p.tenor === "10Y").value === null);
ok("FRED: \".\" is missing, oldest first", JSON.stringify(parseFred({ observations: [{ date: "2026-10-06", value: "4.13" }, { date: "2026-10-05", value: "." }, { date: "2026-10-02", value: "4.10" }] })) === JSON.stringify([["2026-10-02", 4.1], ["2026-10-06", 4.13]]));
ok("FRED URL: series, JSON, newest first", /series_id=DGS10&api_key=K&file_type=json&sort_order=desc&limit=30/.test(fredUrl("DGS10", "K")));

// ---------- changes and spreads ----------
const c = changes([["2026-09-04", 3.30], ["2026-09-30", 3.44], ["2026-10-06", 3.49], ["2026-10-07", 3.52]]);
ok("changes: vs previous publication, ~1 week and ~1 month earlier, in bp", c.d1 === 3 && c.w1 === 8 && c.m1 === 22 && c.value === 3.52);
ok("changes: not enough history → null, never estimated", changes([["2026-10-07", 3.52]]).d1 === null && changes([["2026-10-06", 3.5], ["2026-10-07", 3.52]]).m1 === null);
const row = countryRow("DE", { name: "Germany", kind: "k", source: "Deutsche Bundesbank", sourceUrl: "u", maxAgeDays: 4 }, de, "2026-10-07");
ok("country row: tenors with level and changes; a tenor the source does not publish is absent", row.tenors["10Y"].value === 3.52 && row.tenors["10Y"].d1 === 3 && row.tenors["10Y"].m1 === 12 && !row.tenors["5Y"] && row.status === "LIVE");
const sp = bundSpreads({ DE: [["2026-10-06", 3.49], ["2026-10-07", 3.52]], UK: [["2026-10-05", 5.36], ["2026-10-07", 5.36]], JP: [["2026-10-06", 3.1]], CH: [["2026-09-30", 0.53]] });
ok("10Y spread vs the Bund: on the latest date both published (UK 7 Oct +184 bp, Japan 6 Oct −39 bp); no common date → none", sp.length === 2 && sp[0].id === "UK" && sp[0].bp === 184 && sp[0].date === "2026-10-07" && sp[1].id === "JP" && sp[1].bp === -39 && sp[1].date === "2026-10-06", JSON.stringify(sp));

// ---------- endpoints with mocked providers ----------
const KEYF = "fred-test-key-000";
let calls = [];
const FRED = (id) => ({ observations: [{ date: "2026-10-06", value: id === "DGS10" ? "4.13" : id === "BAMLH0A0HYM2" ? "3.05" : "2.00" }, { date: "2026-10-05", value: id === "DGS10" ? "4.10" : "2.10" }, { date: "2026-09-04", value: "1.90" }] });
globalThis.fetch = async (u) => {
  u = String(u); calls.push(u);
  if (u.includes("api.statistiken.bundesbank.de")) return new Response(DE);
  if (u.includes("bankofengland.co.uk/boeapps")) return new Response(UK);
  if (u.includes("mof.go.jp")) return new Response(JP);
  if (u.includes("data.snb.ch")) return new Response(SNB);
  if (u.includes("bankofcanada.ca/valet")) return new Response(JSON.stringify(BOC));
  if (u.startsWith("https://api.stlouisfed.org/fred/series/observations")) { const p = new URL(u).searchParams; return p.get("api_key") === KEYF ? new Response(JSON.stringify(FRED(p.get("series_id")))) : new Response("{}", { status: 400 }); }
  return new Response("", { status: 404 });
};
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com" };
let r = await call("/api/yields", env);
ok("/api/yields: Germany, UK, Japan, Switzerland, Canada curves next to the others; the Treasury unreachable → US N/A", r.j.curves.DE && r.j.curves.UK && r.j.curves.JP && r.j.curves.CH && r.j.curves.CA && r.j.errors.US && r.j.curves.DE.points.find((p) => p.tenor === "10Y").changeBp === 3, JSON.stringify(Object.keys(r.j.curves)));
ok("/api/yields: the Swiss point says which bond it is", /Confederation bond V13_1/.test(r.j.curves.CH.points.find((p) => p.tenor === "10Y").note || ""));
r = await call("/api/bonds", env);
ok("/api/bonds without FRED_KEY: countries shown, inflation / credit NO DATA naming the secret", r.status === 200 && r.j.countries.find((x) => x.id === "DE").tenors["10Y"].value === 3.52 && r.j.fred.error === "fred_not_configured" && JSON.stringify(r.j.spreads) === JSON.stringify([{ id: "CH", tenor: "10Y", bp: -273, date: "2026-09-30" }, { id: "CA", tenor: "10Y", bp: 43, date: "2026-10-06" }]), JSON.stringify(r.j.spreads));
store = new Map(); calls = [];
const envF = { ...env, FRED_KEY: KEYF };
r = await call("/api/bonds", envF);
const us = r.j.countries.find((x) => x.id === "US");
ok("/api/bonds with FRED_KEY: the US curve from FRED (H.15), 10Y with its change", us.source === "FRED · Federal Reserve H.15" && us.tenors["10Y"].value === 4.13 && us.tenors["10Y"].d1 === 3, JSON.stringify(us));
const hy = r.j.fred.groups.flatMap((g) => g.rows).find((x) => x.id === "BAMLH0A0HYM2");
ok("/api/bonds: inflation, credit, money groups; HY spread in its unit with changes", r.j.fred.groups.map((g) => g.group).join() === "Inflation,Credit,Money and mortgages" && hy.unit === "bp" && hy.value === 3.05 && hy.d1 === 95);
ok("/api/bonds: the FRED key goes only in the server's requests to FRED, never in the response", calls.some((u) => u.includes("api.stlouisfed.org") && u.includes(KEYF)) && !r.text.includes(KEYF));
ok("/api/bonds: one request per FRED series, no more (11 curve + 11 extras)", calls.filter((u) => u.includes("api.stlouisfed.org")).length === US_FRED.length + 11);
const y = await getYieldCurves("https://alessandrozanichelli.com", ctx, Date.now(), envF, ["US"]);
ok("getYieldCurves(US) with the key: FRED curve from the cache, no Treasury call", y.curves.US && y.curves.US.source === "FRED · Federal Reserve H.15" && !calls.some((u) => u.includes("treasury.gov")));

// ---------- CFTC ----------
const COT_ROWS = [];
const add = (code, date, oi, L, S, cl, cs) => COT_ROWS.push({ cftc_contract_market_code: code, market_and_exchange_names: code === "13874A" ? "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE" : "GOLD - COMMODITY EXCHANGE INC.", report_date_as_yyyy_mm_dd: date + "T00:00:00.000", open_interest_all: String(oi), noncomm_positions_long_all: String(L), noncomm_positions_short_all: String(S), comm_positions_long_all: String(cl), comm_positions_short_all: String(cs), nonrept_positions_long_all: "10", nonrept_positions_short_all: "5" });
["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"].forEach((d, i) => add("088691", d, 400000, 240000 + i * 2000, 30000, 58000, 310000));
add("13874A", "2026-09-29", 1895922, 209587, 352086, 1410900, 1375619); add("13874A", "2026-09-22", 1890000, 218043, 351271, 1400000, 1370000);
const s = summarizeCot(COT_ROWS), gold = s.find((x) => x.code === "088691"), es = s.find((x) => x.code === "13874A");
ok("COT: net = long − short, changes over 1 and 4 reports, net as % of open interest", gold.net === 218000 && gold.chg1w === 2000 && gold.chg4w === 8000 && gold.netPctOi === 54.5 && es.net === -142499 && es.chg1w === -9271, JSON.stringify(gold));
ok("COT: place in the range (at the top = 100%), commercial net, 13-week line", gold.range.pos === 100 && gold.commNet === -252000 && gold.history.length === 5);
ok("COT: a contract missing from the report is N/A (no figures invented)", s.find((x) => x.code === "133741").status === "N/A" && s.length === COT_CONTRACTS.length);
ok("COT query: the selected contracts and fields only, newest first", /cftc_contract_market_code\+in%28%2713874A%27/.test(cotQuery(Date.now()).replace(/%2C/g, ",")) || decodeURIComponent(cotQuery(Date.now())).includes("cftc_contract_market_code in('13874A','209742'"));
globalThis.fetch = async (u) => (String(u).startsWith("https://publicreporting.cftc.gov/resource/6dca-aqww.json") ? new Response(JSON.stringify(COT_ROWS)) : new Response("", { status: 404 }));
r = await call("/api/cot", env);
ok("/api/cot: contracts with the latest report, source and basis", r.status === 200 && r.j.contracts.find((x) => x.code === "088691").date === "2026-09-29" && /Commodity Futures Trading Commission/.test(r.j.source) && r.j.status === "LIVE");

// ---------- ETFs ----------
ok("ETF universe: asset classes incl. Treasuries, credit, commodities, crypto; no weights invented", UNIVERSES.ETF && ASSET_ETFS.some((x) => x.sym === "TLT" && x.sector === "Treasuries") && ASSET_ETFS.some((x) => x.sym === "HYG" && x.sector === "Credit and aggregate") && ASSET_ETFS.some((x) => x.sym === "GLD") && ASSET_ETFS.some((x) => x.sym === "IBIT") && ASSET_ETFS.every((x) => x.weight === null) && new Set(ASSET_ETFS.map((x) => x.sym)).size === ASSET_ETFS.length);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
