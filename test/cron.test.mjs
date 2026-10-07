// T06 — scheduled briefings (Cron Trigger): plan per minute in Rome time (CET and CEST), a full simulated
// pipeline (one source per run, staged in KV, write from staged data only), retry, and the hand-off with
// the terminal. Provider responses are test fixtures in the providers' formats; fetch, KV and model mocked.
//   node test/cron.test.mjs
import { readFileSync } from "node:fs";
import worker, { app } from "../src/worker.mjs";
import { cronPlan, stepsFor } from "../src/cron.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
const at = (s) => Date.parse(s);
const plan = (s) => cronPlan(at(s));

// ---------------- plan (Rome time; DST from the time zone) ----------------
let p = plan("2026-10-07T05:13:00Z"); // Wed 07:13 Rome (CEST)
ok("daily: staging starts 07:13 Rome with the IVV universe", p.action === "step" && p.step === "universe" && p.first === true && p.periods.join() === "daily");
ok("daily: one input per minute — universe, yields, German / UK / Japanese curves, calendar, 5 press sources, closes, FX, 2 retries", stepsFor(["daily"]).join() === "universe,yields,bonds:DE,bonds:UK,bonds:JP,calendar,press:FT,press:BLOOMBERG,press:WSJ,press:MARKETWATCH,press:CB,closes,fx,retry,retry");
ok("daily: 2-minute pause before the write (KV propagation)", ["05:28", "05:29"].every((m) => plan(`2026-10-07T${m}:00Z`).action === "idle"));
ok("daily: written at 07:30 Rome, retried at 07:35 and 07:40", ["05:30", "05:35", "05:40"].every((m) => { const x = plan(`2026-10-07T${m}:00Z`); return x.action === "write" && x.period === "daily"; }) && plan("2026-10-07T05:31:00Z").action === "idle");
ok("daily in CET (November): same Rome times, one hour later in UTC", plan("2026-11-04T06:13:00Z").step === "universe" && plan("2026-11-04T06:30:00Z").action === "write" && plan("2026-11-04T05:30:00Z").action === "idle");
p = plan("2026-10-07T20:14:00Z");
ok("evening: staging 22:14 Rome without the closes (session not final yet)", p.step === "universe" && !stepsFor(["evening"]).includes("closes"));
ok("evening: closes read at 22:30 (final), retry 22:31, written 22:33 / 22:38 / 22:43", plan("2026-10-07T20:30:00Z").step === "closes" && plan("2026-10-07T20:31:00Z").step === "retry" && ["20:33", "20:38", "20:43"].every((m) => plan(`2026-10-07T${m}:00Z`).period === "evening"));
ok("evening in the week US is still on summer time (28 Oct: 22:30 Rome = 17:30 ET)", plan("2026-10-28T21:30:00Z").step === "closes" && plan("2026-10-28T21:33:00Z").period === "evening");
p = plan("2026-10-03T05:40:00Z"); // first Saturday of October
ok("first Saturday: weekly and monthly share the staging (1W and 1M references, FX daily series)", p.step === "universe" && p.periods.join() === "weekly,monthly" && ["ref:1W", "ref:1M", "fxdaily"].every((s) => stepsFor(p.periods).includes(s)));
ok("first Saturday: weekly at 08:00, monthly at 08:02", plan("2026-10-03T06:00:00Z").period === "weekly" && plan("2026-10-03T06:02:00Z").period === "monthly");
ok("other Saturdays: weekly only; no daily / evening on weekends", plan("2026-10-10T05:50:00Z").periods.join() === "weekly" && plan("2026-10-10T05:30:00Z").action === "idle" && plan("2026-10-10T20:33:00Z").action === "idle");
ok("Sunday: nothing all day", Array.from({ length: 1440 }, (_, i) => cronPlan(at("2026-10-11T00:00:00Z") + i * 60_000)).every((x) => x.action === "idle"));

// every minute that has work falls inside the Cron Trigger hours of wrangler.toml (both CET and CEST)
const crons = [...readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").matchAll(/"\* (\d+)-(\d+) \* \* \*"/g)].map((m) => [Number(m[1]), Number(m[2])]);
const days = ["2026-10-03", "2026-10-07", "2026-10-10", "2026-10-28", "2026-11-04", "2026-11-07", "2027-03-03", "2027-03-31"];
const outside = [];
for (const d of days) for (let i = 0; i < 1440; i++) { const t = at(`${d}T00:00:00Z`) + i * 60_000; if (cronPlan(t).action !== "idle") { const h = new Date(t).getUTCHours(); if (!crons.some(([a, b]) => h >= a && h <= b)) outside.push(new Date(t).toISOString()); } }
ok("wrangler.toml cron hours cover every scheduled minute, CET and CEST", crons.length === 2 && outside.length === 0, outside.slice(0, 3).join());

// ---------------- full pipeline (Wed 7 Oct 2026, daily edition) ----------------
const row = (t, n, s, w) => `"${t}","${n}","${s}","Equity","1,000,000.00","${w}","1,000,000.00","1,000.00","100.00","United States","NASDAQ","USD","1.00","USD","-"`;
const SYMS = ["NVDA", "AAPL", ...Array.from({ length: 418 }, (_, i) => `T${i}`)];
const IVV = `iShares Core S&P 500 ETF\nFund Holdings as of,"Oct 05, 2026"\n\nTicker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date\n`
  + SYMS.map((s, i) => row(s, s === "NVDA" ? "NVIDIA" : s === "AAPL" ? "APPLE" : `COMPANY ${i}`, i % 2 ? "Industrials" : "Information Technology", i < 2 ? "7.00" : "0.20")).join("\n") + "\n";
const BARS = { bars: Object.fromEntries(SYMS.map((s, i) => [s, [{ t: "2026-10-05T04:00:00Z", c: 100 }, { t: "2026-10-06T04:00:00Z", c: i === 0 ? 103 : i === 1 ? 98 : 101 }]])), next_page_token: null };
const ECB_CSV = `KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE,TITLE
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-10-05,2.71,"Yield curve spot rate, 10-year maturity"
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-10-06,2.75,"Yield curve spot rate, 10-year maturity"
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_2Y,2026-10-06,2.10,"Yield curve spot rate, 2-year maturity"
`;
const DE_CSV = `"",BBSIS.D.I.ZAR.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A,BBSIS.D.I.ZAR.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A_FLAGS\nDecimals,2,\n2026-10-05,3.47,\n2026-10-06,3.49,\n`;
const UK_CSV = "DATE,IUDSNPY,IUDMNPY,IUDLNPY\r\n02 Oct 2026,4.8917,5.3341,5.6879\r\n05 Oct 2026,4.9311,5.3634,5.7371\r\n";
const JP_CSV = "Interest Rate (October 2026),,,,,,,,,,,,,,,(Unit : %)\r\nDate,1Y,2Y,3Y,4Y,5Y,6Y,7Y,8Y,9Y,10Y,15Y,20Y,25Y,30Y,40Y\r\n2026/10/5,1.6,1.9,2.0,2.2,2.4,2.5,2.6,2.8,2.9,3.09,3.6,3.9,4.1,4.1,4.1\r\n2026/10/6,1.6,1.9,2.0,2.2,2.4,2.5,2.6,2.8,2.9,3.1,3.6,3.9,4.1,4.1,4.1\r\n";
const FF = [{ title: "CPI m/m", country: "USD", date: "2026-10-07T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" }];
const rss = (src) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>${src} test headline</title><link>https://${src}.example/a</link><pubDate>Wed, 07 Oct 2026 04:00:00 GMT</pubDate></item></channel></rss>`;
const tdQuote = (s, px) => ({ symbol: s, name: s, exchange: "Forex", currency: null, datetime: "2026-10-07", timestamp: 1791349200, open: String(px), high: String(px), low: String(px), close: String(px), previous_close: String(px), change: "0", percent_change: "-0.52", is_market_open: true });

const source = (u) => /bundesbank/.test(u) ? "DE" : /boeapps\/database/.test(u) ? "UK" : /mof\.go\.jp/.test(u) ? "JP" : /ishares\.com/.test(u) ? "IVV" : /alpaca\.markets/.test(u) ? "ALPACA" : /treasury\.gov|data-api\.ecb/.test(u) ? "YIELDS" : /faireconomy|bls\.gov|bea\.gov/.test(u) ? "CALENDAR"
  : /ft\.com/.test(u) ? "FT" : /bloomberg\.com/.test(u) ? "BLOOMBERG" : /dowjones\.io.*mw_/.test(u) ? "MARKETWATCH" : /dowjones\.io/.test(u) ? "WSJ" : /federalreserve|www\.ecb\.europa\.eu|bankofengland/.test(u) ? "CB" : /twelvedata/.test(u) ? "TWELVEDATA" : "OTHER:" + u;
let calls = [], failing = new Set();
globalThis.fetch = async (u, opts = {}) => {
  u = String(u); calls.push(u); const s = source(u);
  if (failing.has(s) || s === "YIELDS" && u.includes("treasury.gov")) return new Response("", { status: 503 }); // Treasury times out from Cloudflare
  if (s === "IVV") return new Response(IVV);
  if (s === "ALPACA") return new Response(JSON.stringify(BARS));
  if (s === "YIELDS") return new Response(ECB_CSV);
  if (s === "DE") return new Response(DE_CSV);
  if (s === "UK") return new Response(UK_CSV);
  if (s === "JP") return new Response(JP_CSV);
  if (u.includes("faireconomy")) return new Response(JSON.stringify(FF));
  if (s === "TWELVEDATA") { const syms = new URL(u).searchParams.get("symbol").split(","); return new Response(JSON.stringify(Object.fromEntries(syms.map((x, i) => [x, tdQuote(x, 1.1 + i)])))); }
  if (["FT", "BLOOMBERG", "WSJ", "MARKETWATCH", "CB"].includes(s)) return new Response(rss(s.toLowerCase()));
  return new Response("", { status: 404 });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } }; // the per-location cache is NOT used by scheduled runs
const kv = new Map();
const BRIEFS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
let aiCalls = 0;
const MODEL_OUT = "TITLE: Constituents edge up\n## In one line\nS&P 500 constituents rose.\n## Equities\n`NVDA` gained 3.00%.\n## Rates and currencies\nThe euro slipped.\n## Commodities and crypto\nN/A.\n## Today\nCPI m/m at 08:30 ET.";
const AI = { run: async () => { aiCalls++; return { response: MODEL_OUT }; } };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", BRIEFS, AI, ALPACA_KEY_ID: "test-id", ALPACA_SECRET_KEY: "test-secret", TWELVEDATA_KEY: "TESTKEY_never_returned" };
const realNow = Date.now;
async function tick(iso, e = env) {
  const t = at(iso); Date.now = () => t; calls = [];
  const pending = []; const ctx = { waitUntil: (x) => pending.push(x) };
  await worker.scheduled({ scheduledTime: t, cron: "* 5-7 * * *" }, e, ctx);
  await Promise.all(pending);
  return { calls: calls.slice(), sources: [...new Set(calls.map(source))] };
}

failing = new Set(["FT"]); // FT unavailable in its minute, back for the retry
const runs = {};
for (let m = 13; m <= 27; m++) { const r = await tick(`2026-10-07T05:${m}:00Z`); runs[m] = r; if (m === 20) failing = new Set(); }
ok("staging: every run calls at most one source (CPU per run ≈ one terminal request)", Object.values(runs).every((r) => r.sources.length <= 1), JSON.stringify(Object.fromEntries(Object.entries(runs).map(([m, r]) => [m, r.sources]))));
ok("staging: sources in order — IVV, yields, Bundesbank, Bank of England, Japan MOF, calendar, FT, Bloomberg, WSJ, MarketWatch, central banks, Alpaca closes, Twelve Data FX", [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map((m) => runs[m].sources[0]).join() === "IVV,YIELDS,DE,UK,JP,CALENDAR,FT,BLOOMBERG,WSJ,MARKETWATCH,CB,ALPACA,TWELVEDATA", [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map((m) => runs[m].sources[0]).join());
ok("retry: the source that failed (FT) is fetched again in the retry minute, then nothing is missing", runs[26].sources.join() === "FT" && runs[27].calls.length === 0);
ok("staged in KV (not in the per-location cache): universe, closes, curves, calendar, headlines, FX quotes", ["stage/spx/universe", "stage/spx/closes/recent/2026-10-07", "stage/yields/ea", "stage/calendar/FF", "stage/press/FT/Home", "stage/press/CB/Fed", "stage/quote/EUR%2FUSD"].every((k) => kv.has(k)) && !kv.has("stage/yields/us"));
ok("heartbeat: first run of the pipeline recorded", JSON.parse(kv.get("cron/last")).at === "2026-10-07T05:13:00.000Z");
let r = await tick("2026-10-07T05:30:00Z");
const ed = JSON.parse(kv.get("brief/daily-2026-10-07") || "null");
ok("07:30 Rome: edition written by the schedule in English and Italian (two model calls on the same DATA), archived and indexed", !!ed && ed.writtenBy === "schedule" && JSON.parse(kv.get("index/daily"))[0].id === "daily-2026-10-07" && aiCalls === 2 && !!ed.i18n.it);
ok("07:30: no source is called while writing (staged data only)", r.calls.length === 0, r.calls.join());
ok("write: DATA from the staged inputs — S&P 500 summary, FX quote, world event, headlines from the top sources", /EQUITY S&P 500/.test(ed.inputData) && /\+3\.00|NVDA/.test(ed.inputData) && /QUOTE `EUR\/USD`/.test(ed.inputData) && /CPI m\/m/.test(ed.inputData) && /ft test headline/.test(ed.inputData) && /cb test headline/.test(ed.inputData) && !ed.inputErrors.equity, ed.inputData.slice(0, 400));
ok("write: the US curve that could not be fetched is absent, not filled in; German, UK and Japanese curves from their staged minutes", !/YIELDS US/.test(ed.inputData) && /YIELDS EA/.test(ed.inputData) && /YIELDS DE .*10Y 3\.49%/.test(ed.inputData) && /YIELDS UK .*10Y 5\.3634%/.test(ed.inputData) && /YIELDS JP .*10Y 3\.1%/.test(ed.inputData), ed.inputData.split("\n").filter((l) => /YIELDS/.test(l)).join(" | "));
r = await tick("2026-10-07T05:35:00Z");
ok("07:35 retry slot: edition exists → not written again", aiCalls === 2 && r.calls.length === 0);

// terminal hand-off: GET shows the schedule; POST before the scheduled window ends → 409, REWRITE still works
const call = async (path, method = "GET") => { const res = await app.fetch(new Request("https://alessandrozanichelli.com" + path, { method }), env, { waitUntil: () => {} }); return { status: res.status, j: await res.json() }; };
Date.now = () => at("2026-10-07T05:31:00Z");
let g = await call("/api/briefs?period=daily");
ok("index: due edition carries its scheduled write time and window; last scheduled run reported", g.j.due.auto.writeAt === "2026-10-07T05:30:00.000Z" && g.j.due.auto.until === "2026-10-07T05:42:00.000Z" && g.j.automatic.lastRun === "2026-10-07T05:13:00.000Z" && g.j.dueWritten === true);
kv.delete("brief/daily-2026-10-07"); kv.set("index/daily", "[]");
let w = await call("/api/briefs/write?period=daily", "POST");
ok("terminal write while the schedule is writing → 409 scheduled_write, model not called", w.status === 409 && w.j.error === "scheduled_write" && aiCalls === 2);
Date.now = () => at("2026-10-07T05:43:00Z");
w = await call("/api/briefs/write?period=daily", "POST");
ok("after the scheduled window, the terminal writes a missing edition itself (fallback)", w.status === 201 && w.j.writtenBy === "terminal" && aiCalls === 4);

// evening: no Alpaca call before the session is final; the 22:30 run reads the closes
const evRuns = [];
for (let m = 14; m <= 27; m++) evRuns.push(await tick(`2026-10-07T20:${m}:00Z`));
ok("evening staging (22:14–22:27 Rome): no closes before the US session is final", !evRuns.some((x) => x.sources.includes("ALPACA")));
r = await tick("2026-10-07T20:30:00Z");
ok("evening 22:30 Rome (16:30 ET): today's consolidated closes read", r.sources.join() === "ALPACA" && JSON.parse(kv.get("stage/spx/closes/recent/2026-10-07")).fetchedAt === at("2026-10-07T20:30:00Z"));
await tick("2026-10-07T20:31:00Z");
r = await tick("2026-10-07T20:33:00Z");
ok("evening written at 22:33 from staged data only", !!kv.get("brief/evening-2026-10-07") && JSON.parse(kv.get("brief/evening-2026-10-07")).writtenBy === "schedule" && r.calls.length === 0);

// no model → nothing written; idle minutes do nothing
kv.clear();
for (let m = 13; m <= 27; m++) await tick(`2026-10-08T05:${m}:00Z`, { ...env, AI: undefined });
await tick("2026-10-08T05:30:00Z", { ...env, AI: undefined });
ok("no model binding → no edition written (no text invented)", !kv.has("brief/daily-2026-10-08"));
r = await tick("2026-10-08T12:00:00Z");
ok("idle minute: no source, no KV write", r.calls.length === 0);

// retries take turns (7 Oct evening: the Bank of England kept failing and used up every retry, so the calendar that had
// failed once was never fetched again): UK keeps failing, the calendar fails in its minute and is back for the retries
kv.clear();
const runs9 = {};
for (let m = 13; m <= 27; m++) { failing = new Set(m <= 18 ? ["UK", "CALENDAR"] : ["UK"]); runs9[m] = await tick(`2026-10-09T05:${m}:00Z`); }
failing = new Set();
const ffCalls = (r) => r.calls.filter((u) => u.includes("faireconomy")).length;
ok("retries rotate over the inputs still missing: the first retry tries the Bank of England, the second the calendar (staged)", runs9[26].sources.join() === "UK" && ffCalls(runs9[27]) === 1 && !!kv.get("stage/calendar/FF"), JSON.stringify([runs9[26].sources, runs9[27].sources]));

// the Bank of England: year-long three-series request refused → one series per request, merged by date
const { loadUkForTest, mergeBoeCsv, parseBoeYields } = await import("../src/yields.mjs");
const m3 = mergeBoeCsv(["DATE,IUDSNPY\n02 Oct 2026,4.89\n05 Oct 2026,4.93", "DATE,IUDMNPY\n05 Oct 2026,5.36", "<html>error</html>"]);
const pm = parseBoeYields(m3);
ok("BoE: CSVs of one series each merged by date (a non-CSV answer ignored)", m3.split("\n")[0] === "DATE,IUDSNPY,IUDMNPY" && pm.length === 2 && pm[1].points.find((p) => p.tenor === "10Y").value === 5.36 && pm[0].points.find((p) => p.tenor === "10Y").value == null, m3);
const realFetch = globalThis.fetch; const ukCalls = [];
globalThis.fetch = async (u) => { u = String(u); ukCalls.push(u); const codes = new URL(u).searchParams.get("SeriesCodes").split(","); if (codes.length > 1) return new Response("", { status: 500 }); return new Response(`DATE,${codes[0]}\n02 Oct 2026,${codes[0] === "IUDMNPY" ? "5.33" : "4.80"}\n05 Oct 2026,${codes[0] === "IUDMNPY" ? "5.36" : "4.90"}\n`); };
const uk = await loadUkForTest(at("2026-10-07T20:00:00Z"));
globalThis.fetch = realFetch;
ok("BoE: the three-series request fails → one request per series, all three maturities on each date", !!uk.data && uk.data.length === 2 && uk.data[1].points.filter((p) => p.value != null).length === 3 && ukCalls.length === 4, JSON.stringify(uk).slice(0, 200));
Date.now = realNow;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
