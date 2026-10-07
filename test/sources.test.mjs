// T05 — real-data sources: parsers + handlers with a mocked network/cache/model (test fixtures only).
//   node test/sources.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseTreasuryXml, parseEcbCsv, buildCurve } from "../src/yields.mjs";
import { parseIcs, buildEvents } from "../src/calendar.mjs";
import { secCikMap, normalizeSecSubmissions } from "../src/news.mjs";
import { buildBriefingData, extractNumbers, verifyNumbers } from "../src/briefing.mjs";
import { easternToUtc, parseCsv } from "../src/lib.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

// ---------------- fixtures (shapes copied from the real feeds, values illustrative) ----------------
const tEntry = (date, ten, extra = "") => `<entry><content type="application/xml"><m:properties><d:Id>1</d:Id><d:NEW_DATE>${date}T00:00:00</d:NEW_DATE><d:BC_1MONTH>4.06</d:BC_1MONTH><d:BC_1_5MONTH m:null="true" /><d:BC_2MONTH>4.13</d:BC_2MONTH><d:BC_3MONTH>4.17</d:BC_3MONTH><d:BC_4MONTH>4.26</d:BC_4MONTH><d:BC_6MONTH>4.27</d:BC_6MONTH><d:BC_1YEAR>4.44</d:BC_1YEAR><d:BC_2YEAR>4.78</d:BC_2YEAR><d:BC_3YEAR>4.91</d:BC_3YEAR><d:BC_5YEAR>5.01</d:BC_5YEAR><d:BC_7YEAR>5.12</d:BC_7YEAR><d:BC_10YEAR>${ten}</d:BC_10YEAR><d:BC_20YEAR>5.64</d:BC_20YEAR><d:BC_30YEAR>5.61</d:BC_30YEAR><d:BC_30YEARDISPLAY>9.99</d:BC_30YEARDISPLAY>${extra}</m:properties></content></entry>`;
const TREASURY_XML = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${tEntry("2026-10-05", "5.26")}${tEntry("2026-10-01", "5.24")}${tEntry("2026-10-02", "5.20")}</feed>`;
const ECB_CSV = `KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE,TITLE
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-10-02,2.71,"Yield curve spot rate, 10-year maturity"
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-10-05,2.75,"Yield curve spot rate, 10-year maturity"
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_2Y,2026-10-05,2.10,"Yield curve spot rate, 2-year maturity"
`;
const ICS = `BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:US-Eastern\r\nBEGIN:VEVENT\r\nUID:a1\r\nDTSTART;TZID=US-Eastern:20261014T083000\r\nSUMMARY:Consumer Price Index\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a2\r\nDTSTART;TZID=US-Eastern:20261203T100000\r\nSUMMARY:Job Openings and Labor Turnover\r\n  Survey\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a3\r\nDTSTART:20261029T123000Z\r\nSUMMARY:GDP (Advance Estimate)\\, 3rd Quarter 2026\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>Stocks close higher as tech rallies</title><link>https://www.ft.com/content/a</link><pubDate>Tue, 06 Oct 2026 20:15:00 GMT</pubDate></item></channel></rss>`;
const news = [{ title: "Stocks close higher as tech rallies", url: "https://www.ft.com/content/a", timestamp: "2026-10-06T20:15:00.000Z", source: "Financial Times", section: "Markets" }];
const SEC_TICKERS = { 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } };
const SEC_SUB = { cik: "0000320193", name: "Apple Inc.", filings: { recent: { form: ["4", "8-K", "10-Q"], accessionNumber: ["0001-26-000001", "0000320193-26-000090", "0000320193-26-000080"], filingDate: ["2026-10-03", "2026-10-02", "2026-08-01"], acceptanceDateTime: ["2026-10-03T18:00:00.000Z", "2026-10-02T20:30:12.000Z", "2026-08-01T20:00:00.000Z"], primaryDocument: ["x.xml", "aapl-8k.htm", "aapl-10q.htm"], primaryDocDescription: ["", "8-K", "10-Q"] } } };

// ---------------- parsers ----------------
const tr = parseTreasuryXml(TREASURY_XML);
ok("Treasury: 3 publications sorted oldest → newest", tr.map((r) => r.date).join() === "2026-10-01,2026-10-02,2026-10-05");
ok("Treasury: 14 maturities 1M…30Y", tr[0].points.length === 14 && tr[0].points[0].tenor === "1M" && tr[0].points[13].tenor === "30Y");
ok("Treasury: null maturity stays null (never interpolated)", tr[0].points.find((p) => p.tenor === "1.5M").value === null);
ok("Treasury: 30Y read from BC_30YEAR, not BC_30YEARDISPLAY", tr[0].points.find((p) => p.tenor === "30Y").value === 5.61);
const ea = parseEcbCsv(ECB_CSV);
ok("ECB: quoted CSV with commas parsed, by date", ea.length === 2 && ea[1].date === "2026-10-05");
ok("ECB: values by tenor, missing tenor = null", ea[1].points.find((p) => p.tenor === "10Y").value === 2.75 && ea[1].points.find((p) => p.tenor === "30Y").value === null);
ok("CSV: escaped quotes", parseCsv('a,"b ""c"", d"\n1,2\n')[0][1] === 'b "c", d');
const curve = buildCurve(tr.slice(-2), { id: "US", name: "US", kind: "par", source: "U.S. Department of the Treasury", sourceUrl: "x", maxAgeDays: 4, today: "2026-10-06", fetchedAt: Date.parse("2026-10-06T20:00:00Z"), cache: "MISS" });
ok("Curve: LIVE when latest publication ≤ 4 days old", curve.status === "LIVE" && curve.timestamp === "2026-10-05");
ok("Curve: daily change in bp is DERIVED from two real publications", curve.points.find((p) => p.tenor === "10Y").changeBp === 6);
ok("Curve: missing point → N/A, no change computed", curve.points.find((p) => p.tenor === "1.5M").status === "N/A" && curve.points.find((p) => p.tenor === "1.5M").changeBp === null);
const old = buildCurve(tr.slice(-2), { id: "US", name: "US", kind: "par", source: "T", sourceUrl: "x", maxAgeDays: 4, today: "2026-10-15", fetchedAt: Date.now(), cache: "MISS" });
ok("Curve: STALE when the source has not published for > 4 days", old.status === "STALE" && old.points[0].status === "STALE");

const ev = parseIcs(ICS);
ok("ICS: 3 events, folded lines unfolded, escapes removed", ev.length === 3 && ev[1].title === "Job Openings and Labor Turnover Survey" && ev[2].title === "GDP (Advance Estimate), 3rd Quarter 2026", ev.map((e) => e.title).join("|"));
ok("ICS: 08:30 ET in October (EDT) = 12:30 UTC", ev[0].start === "2026-10-14T12:30:00.000Z" && ev[0].timeET === "08:30");
ok("ICS: 10:00 ET in December (EST) = 15:00 UTC", ev[1].start === "2026-12-03T15:00:00.000Z");
ok("ICS: UTC 'Z' time kept, shown in ET", ev[2].start === "2026-10-29T12:30:00.000Z" && ev[2].timeET === "08:30");
ok("ET→UTC helper across DST", easternToUtc(2026, 7, 1, 9, 30) === Date.UTC(2026, 6, 1, 13, 30) && easternToUtc(2026, 1, 15, 9, 30) === Date.UTC(2026, 0, 15, 14, 30));
const events = buildEvents({ BLS: ev }, { now: Date.parse("2026-10-06T12:00:00Z") });
ok("Calendar: window = past 7 / next 35 days", events.length === 2 && events[0].indicator === "Consumer Price Index", events.map((e) => e.indicator).join("|"));
ok("Calendar: actual/forecast/previous/importance are N/A with a reason (never estimated)", ["actual", "forecast", "previous", "importance"].every((k) => events[0][k].status === "N/A" && events[0][k].value === null && events[0][k].note));
ok("Calendar: country, source and official page on every event", events[0].country === "US" && events[0].source === "BLS" && /bls\.gov/.test(events[0].sourceUrl));

const cik = secCikMap(SEC_TICKERS);
ok("SEC: ticker → CIK map", cik.AAPL.cik === 320193);
const fil = normalizeSecSubmissions(SEC_SUB, "AAPL");
ok("SEC: insider form 4 skipped, 8-K and 10-Q kept, newest first", fil.map((f) => f.form).join() === "8-K,10-Q");
ok("SEC: filing URL built from CIK + accession + document", fil[0].url === "https://www.sec.gov/Archives/edgar/data/320193/000032019326000090/aapl-8k.htm" && fil[0].ticker === "AAPL" && fil[0].timestamp === "2026-10-02T20:30:12.000Z");

// ---------------- briefing data + number verification ----------------
const bd = buildBriefingData({ quotes: [{ symbol: "AAPL", name: "Apple Inc.", price: 334.155, changePct: 0.38, prevClose: 332.89, currency: "USD", timestamp: "2026-10-06T19:51:00.000Z" }], curves: { US: curve }, events, headlines: news, now: Date.parse("2026-10-06T12:00:00Z") });
ok("Briefing input: every line is a real datum with its source", /QUOTE AAPL .*334\.155.*\[Twelve Data\]/.test(bd.text) && /YIELDS US .*10Y 5\.26%.*\[U\.S\. Department of the Treasury\]/.test(bd.text) && /EVENT 2026-10-14 08:30 ET US Consumer Price Index \[BLS\]/.test(bd.text) && /HEADLINE/.test(bd.text));
ok("Briefing input: sources listed with timestamps", bd.sources.length === 4 && bd.sources.every((s) => s.timestamp));
ok("Number extraction: decimals and %/bp only (not dates/integers)", extractNumbers("On 6 October the 10Y was 5.26% (+6 bp), AAPL 334.16").map((n) => n.raw).join("|") === "5.26%|+6 bp|334.16");
ok("Verification: numbers present in the data pass", verifyNumbers("AAPL rose 0.38% to 334.16; the 10Y yield is 5.26%.", bd.text).unverified.length === 0);
ok("Verification: an invented number is reported", verifyNumbers("The S&P 500 gained 1.25%.", bd.text).unverified.join() === "1.25%");

// ---------------- handlers (mocked network, cache and model) ----------------
let store = new Map();
globalThis.caches = { default: { match: async (r) => (store.has(r.url) ? new Response(store.get(r.url)) : undefined), put: async (r, res) => { store.set(r.url, await res.text()); } } };
let mode = "ok", seen = [];
globalThis.fetch = async (u, opts = {}) => {
  u = String(u); seen.push({ u, ua: (opts.headers || {})["user-agent"] });
  if (mode === "down") return new Response("upstream error", { status: 503 });
  if (mode === "ratelimit") return new Response("Please limit requests", { status: 429 });
  if (u.includes("treasury.gov")) return new Response(TREASURY_XML);
  if (u.includes("data-api.ecb.europa.eu")) return new Response(ECB_CSV);
  if (u.includes("bls.gov") || u.includes("bea.gov")) return new Response(ICS);
  if (/ft\.com\/|feeds\.bloomberg\.com|dowjones\.io|federalreserve\.gov\/feeds|www\.ecb\.europa\.eu\/rss|bankofengland\.co\.uk\/rss/.test(u)) return new Response(RSS);
  if (u.includes("gdeltproject.org")) throw new Error("GDELT must not be called");
  if (u.includes("company_tickers.json")) return new Response(JSON.stringify(SEC_TICKERS));
  if (u.includes("data.sec.gov/submissions")) return new Response(JSON.stringify(SEC_SUB));
  return new Response("not found", { status: 404 });
};
const pending = [], ctx = { waitUntil: (p) => pending.push(p) };
const aiCalls = [];
const env = { AI: { run: async (model, input) => { aiCalls.push({ model, input }); return { response: "Markets: AAPL last 334.16 [Twelve Data].\nRates: US 10Y 5.26% (+6.0 bp) [U.S. Department of the Treasury].\nCalendar and news: Consumer Price Index on 2026-10-14 [BLS]. The index rose 2.5%." }; } } };
async function call(path, e = env) { const res = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), e, ctx); await Promise.all(pending.splice(0)); const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch {} return { res, body, text }; }

let r = await call("/api/yields");
ok("/api/yields: US + EA curves with source, timestamp, fetchedAt, status", r.res.status === 200 && r.body.curves.US.source === "U.S. Department of the Treasury" && r.body.curves.US.timestamp === "2026-10-05" && !!r.body.curves.US.fetchedAt && ["LIVE", "STALE"].includes(r.body.curves.US.status) && r.body.curves.EA.source === "European Central Bank");
ok("/api/yields: other countries declared as not connected (no values)", Array.isArray(r.body.notConnected) && !JSON.stringify(r.body.notConnected).match(/\d/));
r = await call("/api/calendar");
ok("/api/calendar: events from BLS and BEA with sources", r.res.status === 200 && r.body.sources.map((s) => s.id).join() === "BLS,BEA" && Array.isArray(r.body.events));
r = await call("/api/news?tickers=AAPL,ZZZZ");
ok("/api/news: SEC filings for known tickers only; no wire headlines (GDELT removed)", r.res.status === 200 && !("items" in r.body) && r.body.filings.length === 2 && r.body.sources.map((s) => s.id).join() === "SEC" && !seen.some((x) => x.u.includes("gdelt")));
ok("/api/news: SEC requests carry a User-Agent", seen.filter((x) => x.u.includes("sec.gov")).every((x) => !!x.ua));

// briefing: quotes only from the shared cache — seed one cached quote the way /api/quote stores it
store.set("https://alessandrozanichelli.com/__cache/quote/AAPL", JSON.stringify({ rec: { symbol: "AAPL", name: "Apple Inc.", price: 334.155, changePct: 0.38, prevClose: 332.89, currency: "USD", asOf: "2026-10-06T19:51:00.000Z" }, fetchedAt: Date.now() }));
const before = seen.length;
r = await call("/api/briefing?symbols=AAPL");
ok("/api/briefing: DERIVED, model + generatedAt + sources", r.res.status === 200 && r.body.status === "DERIVED" && /llama/.test(r.body.model) && !!r.body.generatedAt && r.body.sources.length >= 3);
ok("/api/briefing: never calls the quote provider", !seen.slice(before).some((x) => x.u.includes("twelvedata")));
ok("/api/briefing: model received only the real DATA lines", /DATA \(as of/.test(aiCalls[0].input.messages[1].content) && /QUOTE AAPL/.test(aiCalls[0].input.messages[1].content));
ok("/api/briefing: an untraceable number in the model text is flagged", r.body.verification.unverified.join() === "2.5%" && r.body.verification.checked === 4, JSON.stringify(r.body.verification));
ok("/api/briefing: disclaimer present", /Not investment advice/.test(r.body.disclaimer));
r = await call("/api/briefing?symbols=AAPL");
ok("/api/briefing: cached for repeat requests (no second model call)", r.body.cache === "HIT" && aiCalls.length === 1);
r = await call("/api/briefing?symbols=MSFT", { });
ok("/api/briefing: no model binding → 503 N/A (no text invented)", r.res.status === 503 && r.body.status === "N/A");

// failures: no fallback values, last real data served STALE, or N/A
store = new Map(); mode = "down";
r = await call("/api/yields");
ok("failure, empty cache: /api/yields → 502, no curves, errors N/A", r.res.status === 502 && Object.keys(r.body.curves).length === 0 && r.body.errors.US.status === "N/A");
r = await call("/api/news?tickers=AAPL");
ok("failure is remembered briefly: the next call does not wait on the source again", await (async () => { const n = seen.length; await call("/api/yields"); return !seen.slice(n).some((x) => x.u.includes("treasury.gov")); })());
ok("failure, empty cache: /api/news → 502, no filings, SEC N/A", r.res.status === 502 && r.body.filings.length === 0 && r.body.errors.SEC.status === "N/A");
r = await call("/api/calendar");
ok("failure, empty cache: /api/calendar → 502, no events", r.res.status === 502 && r.body.events.length === 0);
// fill the cache, age it past the TTL, then fail: STALE with the real values
for (const k of [...store.keys()]) if (k.includes("@fail")) store.delete(k); // source recovered: forget the remembered failures
mode = "ok"; await call("/api/yields"); await call("/api/calendar");
for (const [k, v] of store) { const o = JSON.parse(v); if (o.fetchedAt) { o.fetchedAt -= 7 * 3600_000; store.set(k, JSON.stringify(o)); } }
mode = "ratelimit";
r = await call("/api/yields");
ok("rate limit after TTL: yields served STALE with reason, real values kept", r.res.status === 200 && r.body.curves.US.status === "STALE" && r.body.curves.US.staleReason === "rate_limited" && r.body.curves.US.points.find((p) => p.tenor === "10Y").value === 5.26);
r = await call("/api/calendar");
ok("rate limit after TTL: calendar sources marked STALE", r.res.status === 200 && r.body.sources.every((s) => s.status === "STALE"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
