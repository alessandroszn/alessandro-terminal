// Listings outside the Twelve Data plan through CNBC (src/intl.mjs + /api/quote, /api/history), FINRA short interest and
// short volume (src/finra.mjs), Nasdaq analysts and holders (/api/nasdaq/company). Provider answers are fixtures in the
// providers' formats (CNBC restQuote / bars, FINRA Query API / Reg SHO file, Nasdaq API) — nothing here is shown.
//   node test/intl.test.mjs
import { app as worker, __resetForTests } from "../src/worker.mjs";
import * as I from "../src/intl.mjs";
import { compactSi, shvolLine, recentWeekdays, isListed } from "../src/finra.mjs";
import { parseNqRatings, parseNqTarget, parseNqForecast, parseNqHolders } from "../src/nasdaq.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

// ---------- symbols ----------
const MAP = [["ISP:XMIL", "ISP-IT"], ["SAP:XETR", "SAP-DE"], ["VOD:XLON", "VOD-GB"], ["7203:XJPX", "7203.T"], ["0700:XHKG", "700-HK"], ["700:XHKG", "700-HK"], ["VOLV B:XSTO", "VOLV.B-SE"], ["VOLV-B:XSTO", "VOLV.B-SE"],
  ["RY:XTSE", "RY-CA"], ["600519:XSHG", "600519-CN"], ["NESN:XSWX", "NESN-CH"], ["C:700-HK", "700-HK"], ["C:7203.T", "7203.T"], ["AAPL", null], ["EUR/USD", null], ["005930:XKRX", null], ["NOVN:XXXX", null]];
const bad = MAP.filter(([s, e]) => I.cnbcCodeFor(s) !== e);
ok("SYMBOL:MIC → CNBC code (Milan -IT, Xetra -DE, London -GB, Tokyo .T, Hong Kong without leading zeros, Stockholm share class with a dot); C:<code> direct; unmapped exchanges none", bad.length === 0, JSON.stringify(bad));
ok("CNBC big numbers: 103.871B, 17.33B, 950M, 1,234", I.cnbcBig("103.871B") === 103.871e9 && I.cnbcBig("17.33B") === 17.33e9 && I.cnbcBig("950M") === 950e6 && I.cnbcBig("1,234") === 1234 && I.cnbcBig("") === null);
const ISP = { symbol: "ISP-IT", code: 0, name: "Intesa Sanpaolo S.p.A.", last: "5.99", last_time: "2026-10-20T17:35:30.000+0200", change: "-0.02", change_pct: "-0.37%", previous_day_closing: "6.02", open: "5.99", high: "6.04", low: "5.87", volume: "51,948,135", currencyCode: "EUR", exchange: "Milan Stock Exchange", realTime: "false", pe: "10.62", eps: "0.56", mktcapView: "103.871B", dividendyield: "6.27%", sharesout: "17.33B", yrhiprice: "6.94", yrloprice: "4.81", countryCode: "IT", type: "STOCK" };
const HK = { symbol: "700-HK", code: 0, name: "Tencent Holdings Limited", last: "410.40", last_time: "2026-10-20", change: "-4.20", change_pct: "-1.01%", previous_day_closing: "414.60", currencyCode: "HKD", exchange: "Hong Kong Stock Exchange", realTime: "false" };
const rec = I.cnbcIntlRec("ISP:XMIL", ISP), hk = I.cnbcIntlRec("C:700-HK", HK);
ok("CNBC quote → record: price, change, previous close, range, volume, 52 weeks, CNBC's fundamentals; time with its offset", rec.price === 5.99 && rec.changePct === -0.37 && rec.prevClose === 6.02 && rec.volume === 51948135 && rec.fiftyTwoWeekHigh === 6.94 && rec.marketCap === 103.871e9 && rec.pe === 10.62 && rec.dividendYield === 6.27 && rec.asOf === "2026-10-20T15:35:30.000Z" && rec.currency === "EUR");
ok("a quote dated without a time (Asian exchanges) keeps the date only — no time is invented", hk.asOf === null && hk.dateOnly === "2026-10-20" && I.cnbcIntlRec("X", { ...HK, last_time: "" }) === null);
const inst = I.cnbcInstrument(rec, { fetchedAt: Date.now(), fieldKeys: ["price", "marketCap", "sharesOutstanding", "eps"] });
ok("instrument: source cnbc, each field LIVE with its note; a missing field N/A", inst.source === "cnbc" && inst.fields.price.status === "LIVE" && /CNBC/.test(inst.fields.price.note) && inst.fields.marketCap.value === 103.871e9 && inst.cnbcSymbol === "ISP-IT" && I.cnbcInstrument(hk, { fetchedAt: Date.now(), fieldKeys: ["pe"] }).fields.pe.status === "N/A");
// bars
const day = (d, c) => ({ open: String(c), high: String(c + 1), low: String(c - 1), close: String(c), volume: 1000, tradeTime: d.replace(/-/g, "") + "000000", tradeTimeinMills: Date.parse(d + "T04:00:00Z") });
const daily = I.cnbcBarsPoints({ barData: { priceBars: [day("2026-10-19", 6), day("2026-10-20", 5.99), day("2026-10-20", 5.99), { close: "" }] } }, false);
ok("daily bars carry CNBC's date, duplicates and empty bars dropped", daily.length === 2 && daily[1].t === "2026-10-20" && daily[1].c === 5.99 && daily[0].v === 1000);
const five = []; for (let i = 0; i < 12; i++) five.push({ t: new Date(Date.parse("2026-10-20T07:00:00Z") + i * 300_000).toISOString(), o: i, h: i + 1, l: i - 1, c: i, v: 10 });
const q15 = I.toBucket(five, 900_000);
ok("5-minute bars → 15-minute bars (open of the first, high / low / volume over the bucket, close of the last)", q15.length === 4 && q15[0].o === 0 && q15[0].c === 2 && q15[0].h === 3 && q15[0].l === -1 && q15[0].v === 30);
const twoDays = [{ t: "2026-10-19T14:00:00.000Z", c: 1 }, { t: "2026-10-19T14:05:00.000Z", c: 1 }, { t: "2026-10-20T07:00:00.000Z", c: 2 }, { t: "2026-10-20T07:05:00.000Z", c: 2 }];
ok("the last session = the bars after the last gap of more than 4 hours", I.lastSessions(twoDays, 1).length === 2 && I.lastSessions(twoDays, 2).length === 4);
const wk = I.aggregate([{ t: "2026-10-12", o: 1, h: 2, l: 0, c: 1, v: 1 }, { t: "2026-10-16", o: 1, h: 5, l: 1, c: 4, v: 1 }, { t: "2026-10-19", o: 4, h: 4, l: 3, c: 3, v: 1 }], "1week");
ok("daily → weekly bars, each dated by its last session", wk.length === 2 && wk[0].t === "2026-10-16" && wk[0].h === 5 && wk[0].c === 4 && wk[1].t === "2026-10-19");

// ---------- through the Worker ----------
const KEY = "td-key-xyz";
const PLAN_ERR = { code: 403, message: "ISP is available starting with the Grow plan.", status: "error" };
let urls = [], cnbcOn = true;
globalThis.fetch = async (u, o = {}) => {
  const s = String(u); urls.push(s);
  if (s.startsWith("https://api.twelvedata.com/quote")) return new Response(JSON.stringify(PLAN_ERR));
  if (s.startsWith("https://api.twelvedata.com/time_series")) return new Response(JSON.stringify(PLAN_ERR));
  if (s.startsWith("https://quote.cnbc.com/")) { if (!cnbcOn) return new Response("", { status: 503 }); const syms = decodeURIComponent(/symbols=([^&]+)/.exec(s)[1]).split("|"); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((x) => x === "ISP-IT" ? ISP : x === "700-HK" ? HK : { symbol: x, code: 1 }) } })); }
  if (s.startsWith("https://ts-api.cnbc.com/")) { const iv = /\/bars\/[^/]+\/(\w+)\//.exec(s)[1]; if (iv === "1D") return new Response(JSON.stringify({ barData: { priceBars: [day("2026-10-16", 6.1), day("2026-10-19", 6.02), day("2026-10-20", 5.99)] } })); return new Response(JSON.stringify({ barData: { priceBars: five.map((p) => ({ open: String(p.o), high: String(p.h), low: String(p.l), close: String(p.c), volume: 10, tradeTimeinMills: Date.parse(p.t) })) } })); }
  if (s.startsWith("https://api.finra.org/")) return finraAnswer(JSON.parse(o.body || "{}"));
  if (s.startsWith("https://cdn.finra.org/equity/regsho/daily/")) { const d = /CNMSshvol(\d{8})/.exec(s)[1]; return d.endsWith("17") ? new Response("", { status: 404 }) : new Response(`Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n${d}|AAPL|4000000.5|1200|10000000|B,Q,N\n${d}|AAPLX|1|0|2|Q\n`); }
  if (s.startsWith("https://api.nasdaq.com/api/analyst/AAPL/ratings")) return new Response(JSON.stringify({ data: { symbol: "aapl", meanRatingType: "Hold", ratingsSummary: "Based on 29 analysts offering recommendations for AAPL.", upgradesDowngrades: [], brokerNames: ["CITIGROUP", "GOLDMAN SACHS"] } }));
  if (s.startsWith("https://api.nasdaq.com/api/analyst/AAPL/targetprice")) return new Response(JSON.stringify({ data: { symbol: "aapl", consensusOverview: { lowPriceTarget: 245, highPriceTarget: 400, priceTarget: 337.18, buy: 16, sell: 4, hold: 10 }, historicalConsensus: [{ z: { buy: 15, hold: 9, sell: 4, date: "10/01/2026", consensus: "Buy" }, x: 1790812800, y: 337.18 }] } }));
  if (s.startsWith("https://api.nasdaq.com/api/analyst/AAPL/earnings-forecast")) return new Response(JSON.stringify({ data: { quarterlyForecast: { rows: [{ fiscalEnd: "Dec 2026", consensusEPSForecast: 2.9, highEPSForecast: 3.04, lowEPSForecast: 2.68, noOfEstimates: 6, up: 1, down: 0 }] }, yearlyForecast: { rows: [{ fiscalEnd: "Sep 2027", consensusEPSForecast: 9.59, highEPSForecast: 10.47, lowEPSForecast: 9.01, noOfEstimates: 11, up: 2, down: 1 }] } } }));
  if (s.startsWith("https://api.nasdaq.com/api/company/AAPL/institutional-holdings")) return new Response(JSON.stringify({ data: { ownershipSummary: { SharesOutstandingPCT: { value: "76.60%" }, ShareoutstandingTotal: { value: "14,594" }, TotalHoldingsValue: { value: "$3,833,714" } }, activePositions: { rows: [{ positions: "Increased Positions", holders: "2,815", shares: "329,984,542" }] }, holdingsTransactions: { totalRecords: "6437", table: { rows: [{ ownerName: "Vanguard Group Inc", date: "06/30/2026", sharesHeld: "1,426,283,914", sharesChange: "26,856,752", sharesChangePCT: "1.919%", marketValue: "$489,129,805" }] } } } }));
  if (s.startsWith("https://api.nasdaq.com/")) return new Response(JSON.stringify({ data: null, status: { rCode: 400 } }));
  return new Response("", { status: 404 });
};
const FINRA_ROWS = [
  { symbolCode: "NVDA", issueName: "NVIDIA Corporation Common Stoc", marketClassCode: "NNM", currentShortPositionQuantity: 311389688, previousShortPositionQuantity: 294225803, averageDailyVolumeQuantity: 110290688, daysToCoverQuantity: 2.82, changePercent: 5.83, settlementDate: "2026-09-30" },
  { symbolCode: "RIG", issueName: "Transocean LTD.", marketClassCode: "NYSE", currentShortPositionQuantity: 299021155, previousShortPositionQuantity: 277763921, averageDailyVolumeQuantity: 43475753, daysToCoverQuantity: 6.88, changePercent: 7.65, settlementDate: "2026-09-30" },
  { symbolCode: "XOTC", issueName: "Some OTC Co", marketClassCode: "OTC", currentShortPositionQuantity: 1000, previousShortPositionQuantity: 900, averageDailyVolumeQuantity: 0, daysToCoverQuantity: 999.99, changePercent: 11.1, settlementDate: "2026-09-30" }];
const finraBodies = [];
function finraAnswer(b) {
  finraBodies.push(b);
  if (b.limit === 1) return new Response(JSON.stringify([{ settlementDate: "2026-09-30" }]));
  if ((b.compareFilters || []).some((f) => f.fieldName === "symbolCode")) return new Response(JSON.stringify([{ ...FINRA_ROWS[0], symbolCode: "AAPL", currentShortPositionQuantity: 120763539, daysToCoverQuantity: 3.03 }, { ...FINRA_ROWS[0], symbolCode: "AAPL", settlementDate: "2026-09-15", currentShortPositionQuantity: 128753092, daysToCoverQuantity: 2.85 }]));
  return new Response(JSON.stringify(FINRA_ROWS));
}
const env = { TWELVEDATA_KEY: KEY, ALLOWED_ORIGIN: "https://alessandrozanichelli.com" }, ctx = { waitUntil: () => {} };
const call = async (path, e = env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), e, ctx); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, text: t }; };

__resetForTests();
let r = await call("/api/quote?symbols=ISP:XMIL");
ok("quote: a listing outside the plan is served from CNBC (source cnbc, LIVE, CNBC's code), after Twelve Data answered plan_required", r.status === 200 && r.j.quotes["ISP:XMIL"].source === "cnbc" && r.j.quotes["ISP:XMIL"].fields.price.value === 5.99 && r.j.quotes["ISP:XMIL"].cnbcSymbol === "ISP-IT" && r.j.meta.cnbc === 1 && urls.some((u) => u.startsWith("https://api.twelvedata.com/quote")), r.text.slice(0, 300));
urls = []; store = new Map([...store].filter(([k]) => !k.includes("quote-cnbc")));
r = await call("/api/quote?symbols=ISP:XMIL");
ok("quote: the plan's refusal is remembered — next time straight to CNBC, no Twelve Data request (no credit)", r.j.quotes["ISP:XMIL"].source === "cnbc" && !urls.some((u) => u.includes("twelvedata")) && r.j.meta.cache.hit === 1);
urls = [];
r = await call("/api/quote?symbols=C:700-HK");
ok("quote: C:<code> goes straight to CNBC; a date-only quote keeps its date and no time", r.status === 200 && r.j.quotes["C:700-HK"].dateOnly === "2026-10-20" && r.j.quotes["C:700-HK"].timestamp === null && !urls.some((u) => u.includes("twelvedata")));
r = await call("/api/quote?symbols=C:ZZZ-HK");
ok("quote: a C: code CNBC does not know → symbol_not_found N/A (nothing invented)", r.status === 404 && r.j.errors["C:ZZZ-HK"].error === "symbol_not_found");
r = await call("/api/quote?symbols=NOVN:XSWX");
ok("quote: outside the plan and unknown to CNBC → plan_required with both reasons", r.status === 403 && r.j.errors["NOVN:XSWX"].error === "plan_required" && /Grow plan/.test(r.j.errors["NOVN:XSWX"].detail) && /CNBC does not quote/.test(r.j.errors["NOVN:XSWX"].detail));
cnbcOn = false; store = new Map([...store].map(([k, v]) => [k, k.includes("quote-cnbc/ISP") ? JSON.stringify({ ...JSON.parse(v), fetchedAt: Date.now() - 120_000 }) : v]));
r = await call("/api/quote?symbols=ISP:XMIL");
ok("quote: CNBC failing → the last real CNBC quote, STALE with the reason", r.j.quotes["ISP:XMIL"].status === "STALE" && r.j.quotes["ISP:XMIL"].staleReason === "provider_error");
cnbcOn = true;
r = await call("/api/history?symbol=ISP:XMIL&range=1Y&interval=1day");
ok("history: CNBC daily bars in the History contract (source cnbc, CNBC's dates, last bar of today partial only if dated today)", r.status === 200 && r.j.source === "cnbc" && r.j.points.length === 3 && r.j.points[2].t === "2026-10-20" && r.j.points[2].c === 5.99 && r.j.timeBasis === "cnbc_date", r.text.slice(0, 300));
r = await call("/api/history?symbol=C:700-HK&range=1D&interval=5min");
ok("history: intraday from CNBC's 5-minute bars, the last session, UTC instants", r.status === 200 && r.j.points.length === 12 && r.j.points[0].t === "2026-10-20T07:00:00.000Z" && r.j.timeBasis === "utc");
r = await call("/api/history?symbol=C:700-HK&range=5D&interval=15min");
ok("history: 5D in 15-minute bars aggregated from CNBC's 5-minute bars", r.status === 200 && r.j.points.length === 4);
r = await call("/api/history?symbol=AAPL:XNGS&range=1Y");
ok("history: ids CNBC cannot name keep the plan error", r.status === 403 && r.j.error === "plan_required");

// ---------- FINRA ----------
ok("FINRA row → compact (days to cover 999.99 = undefined → null); OTC left out of the market-wide list", JSON.stringify(compactSi(FINRA_ROWS[1])) === JSON.stringify(["RIG", "Transocean LTD.", 299021155, 277763921, 7.65, 43475753, 6.88, "NYSE"]) && compactSi(FINRA_ROWS[2])[6] === null && !isListed("OTC") && isListed("NNM") && isListed("ARCA"));
const SHV = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20261020|AAPL|4000000.5|1200|10000000|B,Q,N\n20261020|AAPLX|1|0|2|Q\n";
ok("Reg SHO line for one symbol (exact symbol, not a prefix): short / total volume and its share", JSON.stringify(shvolLine(SHV, "2026-10-20", "AAPL")) === JSON.stringify({ date: "2026-10-20", short: 4000001, exempt: 1200, total: 10000000, pct: 40, markets: "B,Q,N" }) && shvolLine(SHV, "2026-10-20", "AAP") === null);
ok("recent weekdays in New York, newest first", JSON.stringify(recentWeekdays(Date.parse("2026-10-20T03:00:00Z"), 3)) === JSON.stringify(["2026-10-19", "2026-10-16", "2026-10-15"]));
r = await call("/api/finra/shorts");
ok("/api/finra/shorts: the latest settlement date, the largest positions sorted by FINRA, exchange-listed only", r.status === 200 && r.j.settlementDate === "2026-09-30" && r.j.rows.length === 2 && r.j.rows[0][0] === "NVDA" && r.j.source === "FINRA" && finraBodies.some((b) => b.sortFields && b.sortFields[0] === "-currentShortPositionQuantity" && b.compareFilters[0].fieldValue === "2026-09-30" && b.limit === 2500));
r = await call("/api/finra/symbol?sym=AAPL");
ok("/api/finra/symbol: short interest by settlement date and the short volume of the last published sessions (a day not published skipped)", r.status === 200 && r.j.shortInterest.length === 2 && r.j.shortInterest[0].short === 120763539 && r.j.shortVolume.length === 5 && r.j.shortVolume.every((x) => x.pct === 40) && !r.j.shortVolume.some((x) => x.date.endsWith("-17")), r.text.slice(0, 300));
r = await call("/api/finra/symbol?sym=bad%20sym");
ok("/api/finra/symbol: bad ticker → 400", r.status === 400);

// ---------- Nasdaq: analysts and holders ----------
r = await call("/api/nasdaq/company?sym=AAPL");
ok("/api/nasdaq/company: mean rating with the number of analysts, price targets with history, EPS forecasts, institutional holders", r.status === 200 && r.j.ratings.mean === "Hold" && r.j.ratings.analysts === 29 && r.j.target.mean === 337.18 && r.j.target.history[0][0] === "2026-10-01" && r.j.forecast.yearly[0].eps === 9.59 && r.j.holders.instPct === 76.6 && r.j.holders.top[0].name === "Vanguard Group Inc" && r.j.holders.top[0].date === "2026-06-30" && r.j.holders.top[0].valueK === 489129805, r.text.slice(0, 400));
r = await call("/api/nasdaq/company?sym=ZZZQ");
ok("/api/nasdaq/company: nothing published → N/A, each part's error named", r.status === 502 && r.j.status === "N/A" && r.j.errors.ratings === "no_data");
ok("parsers return null on empty answers (no value invented)", parseNqRatings({ data: null }) === null && parseNqTarget({}) === null && parseNqForecast({ data: { quarterlyForecast: { rows: [] } } }) === null && parseNqHolders({ data: {} }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
