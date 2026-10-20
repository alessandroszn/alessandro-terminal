// Market yields (CNBC quote service) and central banks compared (BIS WS_CBPOL), 20 Oct 2026.
// Fixtures are test data only (shapes as the services answered the Worker on 20 Oct 2026).
//   node test/rates-world.test.mjs
import { app as worker } from "../src/worker.mjs";
import { MKT_SYMBOLS, MKT_TENORS, MKT_IDS, mktSymbol, pctYield, quoteTime, parseQuotes, countryOf, parseBars, pastOf } from "../src/mktyields.mjs";
import { parseBisCsv, summarize, lastMonthlyChange, nextMeeting, CB_AREAS, CB_ORDER } from "../src/cbworld.mjs";
import { CB_MEETINGS } from "../src/cbmeetings.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

// ---------- market yields: symbols and parsing ----------
ok("141 symbols checked from the Worker, 33 countries; U.S. without suffix, the U.K. is GB", MKT_SYMBOLS.length === 141 && MKT_IDS.length === 33 && mktSymbol("US", "10Y") === "US10Y" && mktSymbol("IT", "10Y") === "IT10Y-IT" && mktSymbol("UK", "2Y") === "GB2Y-GB" && new Set(MKT_SYMBOLS).size === 141);
ok("no symbol that did not answer with a yield (Poland, Czech Republic, Colombia, Taiwan, Philippines, Israel, Norway, Singapore)", !["PL", "CZ", "CO", "TW", "PH", "IL", "NO", "SG"].some((c) => MKT_TENORS[c]));
ok("a yield is a number with %: '3.991%' yes; '0.57', 'UNCH', '' no", pctYield("3.991%") === 3.991 && pctYield("-0.125%") === -0.125 && pctYield("0.57") === null && pctYield("UNCH") === null && pctYield("") === null && pctYield(null) === null);
ok("quote time with a -0400 / +0200 offset", quoteTime("2026-10-20T11:43:24.000-0400") === Date.parse("2026-10-20T15:43:24Z") && quoteTime("2026-10-20T17:15:00.000+0200") === Date.parse("2026-10-20T15:15:00Z") && quoteTime("x") === null);
const Q = (symbol, last, prev, time, extra = {}) => ({ symbol, code: 0, name: symbol + " name", last, previous_day_closing: prev, last_time: time, exchange: "Tradeweb", maturity_date: "2036-08-01", coupon: "3.85%", ...extra });
const quotes = parseQuotes({ FormattedQuoteResult: { FormattedQuote: [
  Q("IT10Y-IT", "3.912%", "3.95%", "2026-10-20T11:00:00.000-0400"), Q("IT2Y-IT", "2.4%", "2.41%", "2026-10-20T10:00:00.000-0400"),
  Q("US10Y", "4.012%", "4.03%", "2026-10-20T11:43:24.000-0400"), Q("IN30Y-IN", "7.779%", "7.78%", "2026-10-14T07:23:00.000-0400"),
  { symbol: "PL10Y-PL", code: 1 }, Q("SG10Y-SG", "0.57", "0.58", "2026-10-20T17:15:00.000+0200"), Q("XX10Y-XX", "1%", "1%", "2026-10-20T10:00:00.000-0400"),
] } });
ok("quotes: only known symbols with code 0 and a % yield; change in bp from the previous close", Object.keys(quotes).sort().join() === "IN30Y-IN,IT10Y-IT,IT2Y-IT,US10Y" && quotes["IT10Y-IT"].changeBp === -3.8 && quotes["IT10Y-IT"].venue === "Tradeweb" && quotes["IT10Y-IT"].coupon === 3.85 && quotes["IT10Y-IT"].maturity === "2036-08-01", JSON.stringify(quotes["IT10Y-IT"]));
const now = Date.parse("2026-10-20T16:00:00Z");
const it = countryOf("IT", quotes, now), ind = countryOf("IN", quotes, now);
ok("country: maturities in order, only those that answered; a quote older than 4 days is STALE", it.points.map((p) => p.tenor).join() === "2Y,10Y" && it.status === "LIVE" && ind.points[0].status === "STALE" && ind.status === "STALE" && countryOf("DE", quotes, now) === null);
const bars = parseBars({ barData: { priceBars: [{ close: "4.0262", tradeTime: "20260801000000" }, { close: "3.9487", tradeTime: "20260803000000" }, { close: "", tradeTime: "20260804000000" }, { close: "3.9", tradeTime: "20260803000000" }] } });
ok("daily bars: session date and close, empty closes and duplicate days dropped", bars.length === 2 && bars[0][0] === "2026-08-01" && bars[1][1] === 3.9487, JSON.stringify(bars));
const series = []; for (let t = Date.parse("2025-09-01"); t <= Date.parse("2026-10-20"); t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) series.push([d.toISOString().slice(0, 10), 3 + series.length / 1000]); }
const past = pastOf(series);
ok("past closes: the last close on or before 7 / 30 / 91 / 365 days before the latest", past["1W"].date === "2026-10-13" && past["1M"].date === "2026-09-18" && past["1Y"].date === "2025-10-20" && pastOf(series.slice(-5))["1M"] === undefined, JSON.stringify(past));

// ---------- BIS ----------
const BIS_D = "FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\r\nD,US,2025-09-01,4.375\r\nD,US,2025-09-17,4.375\r\nD,US,2025-09-18,4.125\r\nD,US,2026-09-17,3.875\r\nD,US,2026-10-13,3.875\r\nD,PH,2026-10-11,NaN\r\nD,PH,2026-10-10,5.5\r\nD,JP,2025-09-01,0.5\r\nD,JP,2026-10-13,0.5\r\n";
const by = parseBisCsv(BIS_D);
ok("BIS CSV: areas, oldest first, NaN skipped", Object.keys(by).sort().join() === "JP,PH,US" && by.PH.length === 1 && by.US[0][0] === "2025-09-01");
ok("BIS CSV: columns found by name, not position", parseBisCsv("OBS_VALUE,TIME_PERIOD,REF_AREA\n1.5,2026-01-02,XM\n").XM[0][1] === 1.5 && Object.keys(parseBisCsv("A,B\n1,2\n")).length === 0);
const us = summarize(by.US);
ok("summary: last move = first day of the new level, size in bp, level before; 12-month change and moves", us.value === 3.875 && us.date === "2026-10-13" && us.move.date === "2026-09-17" && us.move.bp === -25 && us.move.from === 4.125 && us.chg12.bp === -25 && us.chg12.date === "2025-09-18" && us.moves12 === 1, JSON.stringify(us));
ok("summary: no move inside the window → move null (the monthly series is used then)", summarize(by.JP).move === null);
ok("monthly: the month of the last change", lastMonthlyChange([["2024-01", 0.1], ["2024-03", 0.25], ["2024-04", 0.25]]).month === "2024-03" && lastMonthlyChange([["2024-01", 0.1], ["2024-02", 0.1]]) === null);
ok("39 BIS areas named, the G10 first; Croatia (euro since 2023) left out", Object.keys(CB_AREAS).length === 39 && CB_ORDER.slice(0, 3).join() === "US,XM,GB" && CB_ORDER.length === 39 && !CB_AREAS.HR);
const anyMeet = Object.entries(CB_MEETINGS)[0];
ok("meeting calendars: ISO dates in order, each with the bank's own page and the date it was checked", Object.values(CB_MEETINGS).every((m) => /^https:\/\//.test(m.url) && /^\d{4}-\d{2}-\d{2}$/.test(m.checked) && m.dates.every((d, i) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (i === 0 || d > m.dates[i - 1]))));
ok("meeting calendars: 14 banks read from their own sites; Riksbank and Brazil not listed (pages need JavaScript)", Object.keys(CB_MEETINGS).length === 14 && !CB_MEETINGS.SE && !CB_MEETINGS.BR && CB_MEETINGS.US.dates[0] === "2026-10-28" && CB_MEETINGS.XM.dates.includes("2026-12-17") && Object.keys(CB_MEETINGS).every((a) => CB_AREAS[a]));
ok("next meeting on 20 Oct 2026: Fed 28 Oct, ECB 29 Oct, BoE 5 Nov; Bank of Korea on 22 Oct", nextMeeting("US", "2026-10-20").date === "2026-10-28" && nextMeeting("XM", "2026-10-20").date === "2026-10-29" && nextMeeting("GB", "2026-10-20").date === "2026-11-05" && nextMeeting("KR", "2026-10-20").date === "2026-10-22" && nextMeeting("KR", "2026-11-27").date === null && /not yet|no later/.test(nextMeeting("KR", "2026-11-27").note) && nextMeeting("SE", "2026-10-20") === null);
if (anyMeet) { const [a, m] = anyMeet; const n = nextMeeting(a, m.dates[0]); ok("next meeting: the first date on or after today; after the last one, none (no guessing)", n.date === m.dates[0] && nextMeeting(a, "2099-01-01").date === null && nextMeeting("ZZ", "2026-10-20") === null); }

// ---------- endpoints (mocked providers) ----------
let store = new Map();
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const ctx = { waitUntil: () => {} };
let calls = [];
const realNow = Date.now;
Date.now = () => now;
globalThis.fetch = async (u) => {
  u = String(u); calls.push(u);
  if (u.startsWith("https://quote.cnbc.com/")) {
    const syms = decodeURIComponent(new URL(u).searchParams.get("symbols")).split("|");
    return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((s) => s === "TH10Y-TH" ? { symbol: s, code: 1 } : Q(s, (s.startsWith("DE") ? 2.6 : s.startsWith("IT") ? 3.9 : 4) + "%", "4%", s === "IN30Y-IN" ? "2026-10-14T07:23:00.000-0400" : "2026-10-20T11:00:00.000-0400")) } }));
  }
  if (u.startsWith("https://ts-api.cnbc.com/")) return new Response(JSON.stringify({ barData: { priceBars: series.map(([d, v]) => ({ close: v.toFixed(4), tradeTime: d.replace(/-/g, "") + "000000" })) } }));
  if (u.startsWith("https://stats.bis.org/api/v1/data/WS_CBPOL/M.")) return new Response("FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nM,US,2025-08,4.375\nM,US,2025-09,4.125\nM,JP,2024-02,0.1\nM,JP,2024-03,0.25\nM,JP,2024-08,0.25\nM,AR,2025-05,29\nM,AR,2025-06,29\n");
  if (u.startsWith("https://stats.bis.org/api/v1/data/WS_CBPOL/D.JP/")) return new Response("FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nD,JP,2024-03-18,0.1\nD,JP,2024-03-19,0.25\nD,JP,2024-04-30,0.25\n");
  if (u.startsWith("https://stats.bis.org/api/v1/data/WS_CBPOL/D./")) return new Response(BIS_D.replace("D,JP,2026-10-13,0.5", "D,JP,2026-10-13,0.25").replace("D,JP,2025-09-01,0.5", "D,JP,2025-09-01,0.25"));
  return new Response("", { status: 404 });
};
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com" };
const call = async (path) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j }; };

let r = await call("/api/yields/market");
ok("/api/yields/market: all symbols in requests of at most 40, countries by region with the maturities that answered, the catalog, labelled market data", r.status === 200 && calls.filter((u) => u.startsWith("https://quote.cnbc.com/")).length === 4 && r.j.countries.IT.points.length === 10 && !r.j.countries.TH && r.j.missing.includes("TH") && r.j.catalog.IT.length === 10 && r.j.regions.length === 4 && /market data/.test(r.j.kind) && r.j.status === "LIVE", JSON.stringify(r.j).slice(0, 300));
ok("/api/yields/market: an old quote is STALE in place, nothing replaced", r.j.countries.IN.points.find((p) => p.tenor === "30Y").status === "STALE" && r.j.countries.IN.points.find((p) => p.tenor === "10Y").status === "LIVE");
calls = [];
r = await call("/api/yields/market");
ok("/api/yields/market: served from the cache within a minute (no new request)", r.status === 200 && calls.length === 0);
r = await call("/api/yields/market/past?ids=US,DE,IT,DK,ZZ");
ok("/api/yields/market/past?ids=: the 10-year of each country (Denmark has no 10-year quote → left out), 1W/1M/3M/1Y closes", r.status === 200 && Object.keys(r.j.past).sort().join() === "DE,IT,US" && r.j.past.IT["1W"].points[0].tenor === "10Y" && r.j.past.IT["1Y"].date === "2025-10-20", JSON.stringify(r.j).slice(0, 300));
calls = [];
r = await call("/api/yields/market/past?id=JP");
ok("/api/yields/market/past?id=: every maturity of one country (one daily-bar request each)", r.status === 200 && r.j.past.JP["1M"].points.length === 10 && calls.filter((u) => u.startsWith("https://ts-api.cnbc.com/")).length === 10);
r = await call("/api/yields/market/history?id=IT&tenor=10Y");
ok("/api/yields/market/history: daily closes, oldest first", r.status === 200 && r.j.points.length === series.length && r.j.points[0][0] === series[0][0] && r.j.freq === "D");
r = await call("/api/yields/market/history?id=IT&tenor=4Y");
ok("/api/yields/market/history: a maturity that is not quoted → 400", r.status === 400);

r = await call("/api/cb/world");
const W = r.j && Object.fromEntries(r.j.banks.map((b) => [b.id, b]));
ok("/api/cb/world: every BIS area in order; the Fed's last move and 12-month change from the daily series", r.status === 200 && r.j.banks.length === 39 && r.j.banks[0].id === "US" && W.US.value === 3.875 && W.US.move.date === "2026-09-17" && W.US.chg12.bp === -25 && W.US.note === "mid-point of the FOMC target range" && W.US.status === "LIVE", JSON.stringify(W && W.US));
ok("/api/cb/world: no move in the daily window → the month from the end-of-month series, then that month's daily data for the exact day", W.JP.move && W.JP.move.date === "2024-03-19" && W.JP.move.from === 0.1 && W.JP.move.bp === 15 && calls.some((u) => u.includes("WS_CBPOL/D.JP/all?startPeriod=2024-02-01&endPeriod=2024-04-30")), JSON.stringify(W.JP));
ok("/api/cb/world: a stopped series (Argentina) shows its last month as STALE; an area with no data is N/A", W.AR.status === "STALE" && W.AR.freq === "M" && W.AR.date === "2025-06" && W.AR.value === 29 && W.NO.status === "N/A");
ok("/api/cb/world: market yields named for 'priced' where quoted (euro area → Germany)", W.XM.mkt === "DE" && W.GB.mkt === "UK" && W.NO.mkt === null);
ok("/api/cb/world: next decision from the bank's calendar with its page and the date it was checked", W.US.next.date === "2026-10-28" && W.US.next.time === "14:00 Washington" && /federalreserve\.gov/.test(W.US.next.url) && W.US.next.checked === "2026-10-20" && W.SE.next === null);
r = await call("/api/cb/history?ids=US,JP,ZZ");
ok("/api/cb/history: end-of-month series of the banks asked for; unknown ids dropped", r.status === 200 && Object.keys(r.j.series).sort().join() === "JP,US" && r.j.series.US[1][0] === "2025-09" && r.j.freq === "M");
r = await call("/api/cb/history?ids=ZZ");
ok("/api/cb/history: nothing valid → 400", r.status === 400);
Date.now = realNow;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
