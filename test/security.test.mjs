// Security functions (23 Oct 2026): FA statements from SEC EDGAR XBRL, CN company news and one company's ERN (Finnhub).
// Provider responses are test fixtures in the providers' formats; nothing here is shown in the terminal.
//   node test/security.test.mjs
import { app as worker } from "../src/worker.mjs";
import { faAnnual, faRecent, faMerge, normalizeCompanyNews, normalizeEarnSym, FA_LINES, parseNqSurprise, fillReportDates, reactionSpan } from "../src/security.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };
const ctx = { waitUntil: () => {} };
const call = async (path, env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", SEC_CONTACT: "test@example.com" };

// ---------- FA: annual series from a companyconcept file (Apple-like fiscal years ending late September) ----------
const flow = (s, e, val, form, filed, fp = "FY") => ({ start: s, end: e, val, form, filed, fp });
const REV = { units: { USD: [
  flow("2020-09-27", "2021-09-25", 365817e6, "10-K", "2021-10-29"), flow("2020-09-27", "2021-09-25", 365817e6, "10-K", "2022-10-28"),
  flow("2021-09-26", "2022-09-24", 394328e6, "10-K", "2022-10-28"), flow("2021-09-26", "2022-09-24", 394328e6, "10-K", "2023-11-03"),
  flow("2022-09-25", "2023-09-30", 383285e6, "10-K", "2023-11-03"), flow("2023-10-01", "2024-09-28", 391035e6, "10-K", "2024-11-01"),
  flow("2024-09-29", "2025-09-27", 416161e6, "10-K", "2025-10-31"), flow("2024-09-29", "2025-09-27", 416000e6, "10-K", "2025-10-30"),
  flow("2019-09-29", "2020-09-26", 274515e6, "10-K", "2020-10-30"),
  // quarters and year-to-date in the 10-Qs (not annual), a 10-K's own quarter (not a full year)
  flow("2025-09-28", "2025-12-27", 140e9, "10-Q", "2026-01-30", "Q1"), flow("2026-03-29", "2026-06-27", 100e9, "10-Q", "2026-07-31", "Q3"), flow("2025-09-28", "2026-06-27", 330e9, "10-Q", "2026-07-31", "Q3"),
  flow("2024-09-29", "2025-06-28", 313e9, "10-Q", "2026-07-31", "Q3"), flow("2025-06-29", "2025-09-27", 102e9, "10-K", "2025-10-31"),
] } };
const yrs = faAnnual(REV, "USD", "flow");
ok("FA: five fiscal years, newest first, each from the latest annual filing that reports it (restated figure wins)", yrs.length === 5 && yrs[0].end === "2025-09-27" && yrs[0].value === 416161e6 && yrs[4].end === "2021-09-25" && yrs.every((y) => /^10-K/.test(y.form)), JSON.stringify(yrs));
ok("FA: quarters, year-to-date and a 10-K's own quarter are not fiscal years", !yrs.some((y) => y.value === 102e9 || y.value === 330e9));
const rec = faRecent(REV, "USD", "flow", yrs[0].end);
ok("FA: after the last fiscal year, the trailing twelve months (YTD + last year − YTD a year earlier), marked derived", rec && rec.basis === "ttm" && rec.derived && rec.value === 330e9 + 416161e6 - 313e9 && rec.end === "2026-06-27", JSON.stringify(rec));
ok("FA: per-share and share counts get no trailing sum", faRecent({ units: { "USD/shares": REV.units.USD } }, "USD/shares", "flow", yrs[0].end) === null);
const inst = (e, val, form, filed) => ({ end: e, val, form, filed, fp: form === "10-K" ? "FY" : "Q2" });
const ASSETS = { units: { USD: [
  inst("2024-09-28", 364980e6, "10-K", "2024-11-01"), inst("2024-09-28", 364980e6, "10-K", "2025-10-31"), inst("2025-09-27", 359241e6, "10-K", "2025-10-31"),
  inst("2023-09-30", 352583e6, "10-K", "2023-11-03"), inst("2022-12-31", 1, "10-K", "2023-11-03"), // a date that is not the fiscal year-end
  inst("2026-03-28", 343e9, "10-Q", "2026-05-01"),
] } };
const ay = faAnnual(ASSETS, "USD", "stock");
const ar = faRecent(ASSETS, "USD", "stock", ay[0].end);
ok("FA balance sheet: instants at the fiscal year-end only (52/53-week years kept), then the latest quarter-end", ay.length === 3 && ay[0].value === 359241e6 && !ay.some((y) => y.value === 1) && ar && ar.basis === "quarter" && ar.value === 343e9 && ar.end === "2026-03-28", JSON.stringify([ay, ar]));
const OLD = { units: { USD: [flow("2016-09-25", "2017-09-30", 229234e6, "10-K", "2017-11-03"), flow("2017-10-01", "2018-09-29", 265595e6, "10-K", "2018-11-05"), flow("2022-10-01", "2023-09-30", 1, "10-K", "2023-11-03")] } };
const mg = faMerge([{ concept: "us-gaap:Revenues", years: faAnnual(OLD, "USD", "flow", 9), recent: null }, { concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", years: yrs.slice(0, 3), recent: rec }]);
ok("FA: several concepts — the newest leads, an older one fills the years it lacks (never the same year twice)", mg.concept === "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" && mg.years.length === 5 && mg.years[3].end === "2018-09-29" && mg.years[3].concept === "us-gaap:Revenues" && !mg.years.some((y) => y.value === 1) && mg.recent === rec, JSON.stringify(mg.years));
{ const y = (end, v) => ({ end, fy: Number(end.slice(0, 4)), val: v, form: "10-K", filed: end });
  const tie = faMerge([{ concept: "us-gaap:CashAndCashEquivalentsAtCarryingValue", years: [y("2025-09-27", 30), y("2024-09-28", 29)], recent: null }, { concept: "us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", years: [y("2025-09-27", 36), y("2024-09-28", 35), y("2023-09-30", 34)], recent: null }]);
  ok("FA: the same latest year in two concepts → the one listed first leads (cash, not cash with restricted cash); older years filled from the other, marked", tie.concept === "us-gaap:CashAndCashEquivalentsAtCarryingValue" && tie.years[0].val === 30 && tie.years.length === 3 && tie.years[2].concept === "us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", JSON.stringify(tie));
  const rev = faMerge([{ concept: "a", years: [y("2024-09-28", 1)], recent: null }, { concept: "b", years: [y("2025-09-27", 2)], recent: null }]);
  ok("FA: a later year in another concept → that concept leads (the company changed concept)", rev.concept === "b" && rev.years[0].val === 2 && rev.years[1].concept === "a"); }
ok("FA: no figures at all → nothing", faMerge([{ concept: "x", years: [], recent: null }]) === null && faAnnual({ units: {} }, "USD", "flow").length === 0);
ok("FA: 24 lines in three statements, from us-gaap concepts only", Object.keys(FA_LINES).length === 24 && ["is", "bs", "cf"].every((s) => Object.values(FA_LINES).some((l) => l.st === s)));

const asked = [];
globalThis.fetch = async (u, o = {}) => {
  u = String(u); asked.push({ u, h: o.headers || {} });
  if (u.includes("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, 1: { cik_str: 1, ticker: "NOFS", title: "No Filings Corp" } }));
  if (u.includes("/companyconcept/CIK0000320193/us-gaap/Revenues.json")) return new Response(JSON.stringify(OLD));
  if (u.includes("/companyconcept/CIK0000320193/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json")) return new Response(JSON.stringify(REV));
  if (u.includes("/companyconcept/CIK0000320193/us-gaap/Assets.json")) return new Response(JSON.stringify(ASSETS));
  if (u.startsWith("https://finnhub.io/api/v1/company-news")) return new Response(JSON.stringify([
    { category: "company", datetime: 1792000000, headline: "Apple unveils new chips", id: 1, image: "", related: "AAPL", source: "Reuters", summary: "Long text from the publisher.", url: "https://example.com/a" },
    { category: "company", datetime: 1792100000, headline: "Apple supplier results", id: 2, related: "AAPL", source: "MarketWatch", summary: "x", url: "https://example.com/b" },
    { category: "company", datetime: 1791000000, headline: "apple unveils new chips", id: 3, related: "AAPL", source: "Yahoo", url: "https://example.com/c" },
    { category: "company", datetime: 0, headline: "no time", url: "https://example.com/d" }, { datetime: 1792000000, headline: "no link", url: "javascript:x" }]));
  if (u.startsWith("https://finnhub.io/api/v1/stock/earnings")) return new Response(JSON.stringify([
    { actual: 1.65, estimate: 1.6, period: "2026-06-30", quarter: 3, year: 2026, surprise: 0.05, surprisePercent: 3.125, symbol: "AAPL" },
    { actual: 1.62, estimate: 1.65, period: "2026-03-31", quarter: 2, year: 2026, surprise: -0.03, surprisePercent: -1.8182, symbol: "AAPL" },
    { actual: 2.84, estimate: 2.65, period: "2025-12-31", quarter: 1, year: 2026, surprise: 0.19, surprisePercent: 7.17, symbol: "AAPL" }]));
  if (u.startsWith("https://api.nasdaq.com/api/company/AAPL/earnings-surprise")) return new Response(JSON.stringify({ data: { symbol: "AAPL", earningsSurpriseTable: { rows: [
    { fiscalQtrEnd: "Jun 2026", dateReported: "7/30/2026", eps: 1.65, consensusForecast: "1.60", percentageSurprise: "3.13" },
    { fiscalQtrEnd: "Mar 2026", dateReported: "4/30/2026", eps: 1.62, consensusForecast: "1.65", percentageSurprise: "-1.82" },
    { fiscalQtrEnd: "Dec 2025", dateReported: "1/29/2026", eps: 2.84, consensusForecast: "2.65", percentageSurprise: "7.17" }] } } }));
  if (u.startsWith("https://finnhub.io/api/v1/calendar/earnings")) return new Response(JSON.stringify({ earningsCalendar: [
    { date: "2026-07-30", hour: "amc", quarter: 3, year: 2026, epsActual: 1.65, epsEstimate: 1.6, revenueActual: 100e9, revenueEstimate: 98e9, symbol: "AAPL" },
    { date: "2026-04-30", hour: "amc", quarter: 2, year: 2026, epsActual: 1.62, epsEstimate: 1.65, symbol: "AAPL" },
    { date: "2099-01-29", hour: "amc", quarter: 1, year: 2027, epsEstimate: 2.4, revenueEstimate: 130e9, symbol: "AAPL" }] }));
  return new Response("", { status: 404 });
};
let r = await call("/api/fa?symbol=AAPL", env);
ok("/api/fa: the company and the lines read (no figures yet)", r.status === 200 && r.j.name === "Apple Inc." && r.j.lines.length === 24 && r.j.lines[0].id === "revenue" && r.j.status === "LIVE" && !asked.some((a) => a.u.includes("companyconcept")));
r = await call("/api/fa?symbol=AAPL&c=revenue", env);
ok("/api/fa: one line — fiscal years merged across concepts, the trailing twelve months, provenance", r.status === 200 && r.j.concept === "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" && r.j.years.length === 5 && r.j.years[0].value === 416161e6 && r.j.recent.basis === "ttm" && r.j.source === "SEC EDGAR XBRL (company filings)" && /sec\.gov/.test(r.j.sourceUrl) && r.j.status === "LIVE", r.text.slice(0, 300));
ok("/api/fa: SEC asked with the contact User-Agent, one concept after another", asked.filter((a) => a.u.includes("companyconcept")).every((a) => /AlessandroTerminal test@example\.com/.test(a.h["user-agent"] || "")));
const n0 = asked.length; r = await call("/api/fa?symbol=AAPL&c=revenue", env);
ok("/api/fa: cached a day (no new SEC request)", r.status === 200 && asked.length === n0);
r = await call("/api/fa?symbol=AAPL&c=assets", env);
ok("/api/fa: balance sheet line with the latest quarter-end", r.status === 200 && r.j.years[0].value === 359241e6 && r.j.recent.basis === "quarter" && r.j.kind === "stock");
r = await call("/api/fa?symbol=AAPL&c=rnd", env);
ok("/api/fa: a line the filings do not have → 404 N/A with the reason (nothing estimated)", r.status === 404 && r.j.status === "N/A" && /not in the company's filings/.test(r.j.message));
r = await call("/api/fa?symbol=ZZZZ", env);
ok("/api/fa: not an SEC registrant → 404 N/A", r.status === 404 && r.j.error === "not_sec_registrant");
r = await call("/api/fa?symbol=AAPL&c=ebitda", env);
ok("/api/fa: unknown line → 400 (only what the filings report)", r.status === 400);
// ---------- CN ----------
r = await call("/api/cn?symbol=AAPL", env);
ok("/api/cn without FINNHUB_KEY → 503 N/A", r.status === 503 && r.j.error === "finnhub_not_configured");
const envF = { ...env, FINNHUB_KEY: "fh-test-key" };
r = await call("/api/cn?symbol=AAPL", envF);
const cnAsk = asked.find((a) => a.u.includes("company-news"));
ok("/api/cn: newest first, duplicates and items without time or link dropped, no summary copied", r.status === 200 && r.j.count === 2 && r.j.items[0].headline === "Apple supplier results" && r.j.items[1].source === "Reuters" && !("summary" in r.j.items[0]) && !/Long text/.test(r.text) && r.j.status === "LIVE", r.text.slice(0, 300));
ok("/api/cn: the key only in the X-Finnhub-Token header, never in the URL or the answer", cnAsk && cnAsk.h["X-Finnhub-Token"] === "fh-test-key" && !cnAsk.u.includes("fh-test-key") && !r.text.includes("fh-test-key") && /from=\d{4}-\d{2}-\d{2}&to=/.test(cnAsk.u));
ok("normalizeCompanyNews: nothing usable → empty", normalizeCompanyNews(null).length === 0 && normalizeCompanyNews([{ headline: "x" }]).length === 0);
// ---------- ERN for one company ----------
r = await call("/api/earnings/symbol?symbol=AAPL", envF);
ok("/api/earnings/symbol: the next report and the reported quarters (estimate, actual, surprise, report date)", r.status === 200 && r.j.next.date === "2099-01-29" && r.j.next.epsEstimate === 2.4 && r.j.next.hour === "after close" && r.j.history.length === 3 && r.j.history[0].quarter === "Q3 2026" && r.j.history[0].surprisePct === 3.125 && r.j.history[0].date === "2026-07-30" && r.j.history[0].revenueActual === 100e9 && r.j.status === "LIVE", r.text.slice(0, 400));
ok("/api/earnings/symbol: without Alpaca no price reaction (nothing invented)", r.j.history.every((x) => !("reaction" in x)));
ok("/api/earnings/symbol: a quarter Finnhub's calendar no longer lists → its report date from Nasdaq (hour unknown), said in the answer; asked like a browser", r.j.history[2].date === "2026-01-29" && r.j.history[2].dateSource === "Nasdaq" && r.j.history[2].hour === null && r.j.history[0].dateSource === undefined && /Nasdaq/.test(r.j.datesSource) && /nasdaq\.com/.test(r.j.datesUrl) && asked.some((a) => a.u.includes("earnings-surprise") && /Mozilla/.test(a.h["user-agent"] || "")), r.text.slice(0, 600));
{ const nq = parseNqSurprise({ data: { earningsSurpriseTable: { rows: [{ fiscalQtrEnd: "Aug 2026", dateReported: "9/24/2026", eps: 6.6 }, { fiscalQtrEnd: "May 2026", dateReported: "5/28/2026", eps: 4.93 }, { fiscalQtrEnd: "bad", dateReported: "x" }] } } });
  ok("parseNqSurprise: fiscal quarter and the date reported; bad rows dropped", nq.length === 2 && nq[0].date === "2026-09-24" && nq[0].eps === 6.6);
  const h = fillReportDates([{ period: "2026-09-30", epsActual: 6.6, date: null }, { period: "2026-06-30", epsActual: 4.93, date: null }, { period: "2026-03-31", epsActual: 4.58, date: null }], nq);
  ok("fillReportDates: a fiscal quarter that Finnhub rounds to the calendar one (Costco's August → September), matched by EPS; no match → no date", h[0].date === "2026-09-24" && h[1].date === "2026-05-28" && h[2].date === null, JSON.stringify(h));
  const amb = fillReportDates([{ period: "2026-06-30", epsActual: 1, date: null }], parseNqSurprise({ data: { earningsSurpriseTable: { rows: [{ fiscalQtrEnd: "Jun 2026", dateReported: "7/30/2026", eps: 2 }] } } }));
  ok("fillReportDates: the only quarter near but with another EPS → no date (nothing guessed)", amb[0].date === null);
  const bars = [["2026-07-28", 100], ["2026-07-29", 101], ["2026-07-30", 102], ["2026-07-31", 99.96]];
  const rs = reactionSpan(bars, "2026-07-30");
  ok("reactionSpan: hour unknown → close before the report date to the close of the session after it", rs.from === "2026-07-29" && rs.session === "2026-07-31" && Math.abs(rs.chg - (99.96 / 101 - 1) * 100) < 1e-9 && rs.span === true && reactionSpan(bars, "2026-07-31") === null); }
const ne = normalizeEarnSym([], { earningsCalendar: [{ date: "2026-01-01", quarter: 1, year: 2026 }] }, "2026-10-23");
ok("normalizeEarnSym: no future date → no next report", ne.next === null && ne.history.length === 0);
r = await call("/api/earnings/symbol?symbol=bad sym", envF);
ok("/api/earnings/symbol: bad symbol → 400", r.status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
