// Headless browser tests of the terminal page with MOCKED /api responses (test fixtures, never shipped).
// Quote fixtures come from the Worker's own normalizeQuote + buildInstrument (real contract).
// Policy under test: only real data, otherwise N/A / NO DATA.
//   node test/frontend.e2e.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { normalizeQuote, buildInstrument } from "../src/worker.mjs";
import { normalizeSearch } from "../src/search.mjs";

const html0 = readFileSync(new URL("../public/terminal/index.html", import.meta.url), "utf8");
// speed: lift the client credit budget for UI tests (scenario D tests the real budget)
const htmlFast = html0.replace("creditsPerMin:8,", "creditsPerMin:60,");
const provJs = readFileSync(new URL("../public/terminal/provenance.js", import.meta.url), "utf8");
const ORIGIN = "https://alessandrozanichelli.com";
const SHOTS = process.env.SHOTS_DIR || null;
const WL = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "JPM"];

// ---------- fixtures ----------
function fixtureDaily() {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); const days = [];
  for (let i = 1; days.length < 252; i++) { const x = new Date(d - i * 864e5); const wd = x.getUTCDay(); if (wd !== 0 && wd !== 6) days.push(x.toISOString().slice(0, 10)); }
  days.reverse();
  return days.map((t, i) => { const c = +(200 + i * (50 / 251) + Math.sin(i / 3) * 2).toFixed(2); return { t, o: c, h: c + 1, l: c - 1, c, v: 1e6 }; });
}
const daily = fixtureDaily();
const PRICES = { "7203:XJPX": 2861, NVS: 120.4, NVDA: 190.5, AAPL: 250, MSFT: 430.25, AMZN: 210.1, GOOGL: 205.75, JPM: 260.4, TSLA: 301.2, "EUR/USD": 1.12601, "GBP/USD": 1.32769, "USD/JPY": 158.148, "BTC/USD": 85650.01, "ETH/USD": 2694.37, "XAU/USD": 4165.235 };
function instrument(s, { stale = false } = {}) {
  const now = Date.now(), px = PRICES[s] || 100, fx = s.includes("/"), jp = s === "7203:XJPX";
  const rec = normalizeQuote(s, { symbol: s, name: s + (fx ? " rate" : " Inc"), exchange: fx ? "Forex" : jp ? "JPX" : "NASDAQ", mic_code: fx ? undefined : jp ? "XJPX" : "XNGS", currency: jp ? "JPY" : "USD", close: String(px), previous_close: String(px * 0.99), percent_change: "1.0101", change: String(px * 0.01), open: String(px), high: String(px * 1.01), low: String(px * 0.98), volume: fx ? "" : "537842", is_market_open: true, last_quote_at: Math.floor(now / 1000) - 60, fifty_two_week: { low: String(px * 0.7), high: String(px * 1.2) } });
  return buildInstrument(rec, { fetchedAt: now - 5000, now, stale, error: stale ? "rate_limited" : null });
}
const historyBody = (sym, range, extra = {}) => {
  const now = Date.now();
  const pts = range === "1D" ? daily.slice(-78).map((p, i) => ({ ...p, t: new Date(now - (78 - i) * 300e3).toISOString().slice(0, 19) + "Z" })) : daily;
  return { symbol: sym, range, interval: range === "1D" ? "5min" : "1day", adjust: "splits", count: pts.length, points: pts, status: "LIVE", source: "twelvedata", fetchedAt: new Date(now).toISOString(), staleAt: new Date(now + 864e5).toISOString(), lastBarPartial: false, asOf: new Date(now).toISOString(), provider: "twelvedata", ...extra };
};
const today = new Date().toISOString().slice(0, 10);
const TEN = ["1M", "1.5M", "2M", "3M", "4M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"];
const YIELDS = { curves: {
  US: { id: "US", name: "United States — Treasury par yield curve", kind: "par yield, end of day", source: "U.S. Department of the Treasury", sourceUrl: "https://home.treasury.gov/x", status: "LIVE", timestamp: today, previousDate: "2026-10-02", fetchedAt: new Date().toISOString(), staleAt: new Date(Date.now() + 4 * 864e5).toISOString(), points: TEN.map((t, i) => ({ tenor: t, months: i + 1, value: t === "1.5M" ? null : +(4 + i * 0.12).toFixed(2), status: t === "1.5M" ? "N/A" : "LIVE", changeBp: t === "1.5M" ? null : 2.0 })) },
  EA: { id: "EA", name: "Euro area — AAA government bonds spot curve", kind: "spot rate (Svensson), end of day", source: "European Central Bank", sourceUrl: "https://data.ecb.europa.eu/x", status: "LIVE", timestamp: today, previousDate: "2026-10-02", fetchedAt: new Date().toISOString(), staleAt: new Date(Date.now() + 4 * 864e5).toISOString(), points: ["3M", "2Y", "10Y", "30Y"].map((t, i) => ({ tenor: t, months: i, value: 2 + i * 0.3, status: "LIVE", changeBp: -1.5 })) } },
  errors: {}, notConnected: ["Germany", "Italy", "Japan"] };
const NA = (note) => ({ value: null, status: "N/A", note });
const PRESS = (src) => { const now = Date.now(), ft = src === "FT";
  return { source: src, name: ft ? "Financial Times" : "Bloomberg", home: ft ? "https://www.ft.com/" : "https://www.bloomberg.com/", status: "LIVE", fetchedAt: new Date(now).toISOString(),
    feeds: [{ section: "Markets", status: "LIVE", items: 2 }], basis: "publisher's public RSS feed — headline, time and link only (no article text)",
    items: ft ? [{ title: "Test FT markets headline", url: "https://www.ft.com/content/test-1", timestamp: new Date(now - 60_000).toISOString(), section: "Markets", source: "Financial Times", provider: "FT" }]
              : [{ title: "Test Bloomberg economics headline", url: "https://www.bloomberg.com/news/articles/test-2", timestamp: new Date(now - 120_000).toISOString(), section: "Economics", source: "Bloomberg", provider: "BLOOMBERG" }] }; };
const CALENDAR = { events: [{ id: "a", datetime: new Date(Date.now() + 2 * 864e5).toISOString(), dateET: "2026-10-14", timeET: "08:30", country: "US", indicator: "Consumer Price Index", source: "BLS", sourceName: "U.S. Bureau of Labor Statistics", sourceUrl: "https://www.bls.gov/schedule/news_release/", released: false, actual: NA("needs FRED API key"), forecast: NA("no licensed consensus source"), previous: NA("needs FRED API key"), importance: NA("no licensed importance rating") }],
  sources: [{ id: "BLS", name: "U.S. Bureau of Labor Statistics", url: "https://www.bls.gov/schedule/news_release/", status: "LIVE", fetchedAt: new Date().toISOString() }, { id: "BEA", name: "U.S. Bureau of Economic Analysis", url: "https://www.bea.gov/news/schedule", status: "LIVE", fetchedAt: new Date().toISOString() }], errors: {} };
const NEWS = { items: [{ title: "Stocks close higher as tech rallies", url: "https://www.example-news.com/a", source: "example-news.com", timestamp: new Date().toISOString(), topic: "Stock market", provider: "GDELT" }],
  filings: [{ ticker: "AAPL", company: "Apple Inc.", form: "8-K", description: "8-K", filingDate: today, timestamp: new Date().toISOString(), url: "https://www.sec.gov/Archives/edgar/data/320193/x/aapl-8k.htm", provider: "SEC EDGAR" }],
  sources: [{ id: "GDELT", name: "The GDELT Project", url: "https://www.gdeltproject.org/", status: "LIVE", fetchedAt: new Date().toISOString() }, { id: "SEC", name: "SEC EDGAR", url: "https://www.sec.gov/edgar/search/", status: "LIVE", fetchedAt: new Date().toISOString() }], errors: {} };
const BRIEF = { status: "DERIVED", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "Cloudflare Workers AI", generatedAt: new Date().toISOString(), text: "Markets: AAPL last 250 [Twelve Data].\nRates: US 10Y 5.32% [U.S. Department of the Treasury].\nCalendar and news: Consumer Price Index on 2026-10-14 [BLS].", verification: { checked: 1, unverified: [] }, sources: [{ name: "U.S. Department of the Treasury", timestamp: today, url: "https://home.treasury.gov/x" }, { name: "Twelve Data (quotes, Worker cache)", timestamp: new Date().toISOString() }], inputs: {}, inputData: "QUOTE AAPL ...", disclaimer: "AI-generated summary of the listed real data. Not investment advice.", cache: "MISS" };

const srow = (symbol, name, exchange, mic, type, country, currency, plan) => ({ symbol, instrument_name: name, exchange, mic_code: mic, instrument_type: type, country, currency, access: { global: plan, plan } });
const SEARCH_ROWS = {
  novartis: [srow("NOVN", "Novartis AG Registered Shares", "SIX", "XSWX", "Common Stock", "Switzerland", "CHF", "Pro"), srow("NVS", "Novartis AG Sponsored ADR", "NYSE", "XNYS", "American Depositary Receipt", "United States", "USD", "Basic"), srow("NOVN", "Novartis AG", "NEO", "NEOE", "Depositary Receipt", "Canada", "CAD", "Grow")],
  toyota: [srow("7203", "Toyota Motor Corporation", "JPX", "XJPX", "Common Stock", "Japan", "JPY", "Basic"), srow("TM", "Toyota Motor Corporation ADR", "NYSE", "XNYS", "American Depositary Receipt", "United States", "USD", "Basic")],
  tsla: [srow("TSLA", "Tesla, Inc.", "NASDAQ", "XNGS", "Common Stock", "United States", "USD", "Basic"), srow("TSLA", "Tesla, Inc.", "BMV", "XMEX", "Common Stock", "Mexico", "MXN", "Pro")],
  apple: [srow("AAPL", "Apple Inc.", "NASDAQ", "XNGS", "Common Stock", "United States", "USD", "Basic"), srow("APC", "Apple Inc.", "XETRA", "XETR", "Common Stock", "Germany", "EUR", "Grow")],
};
const searchBody = (q, credits = 0) => { const results = normalizeSearch({ data: SEARCH_ROWS[q.toLowerCase()] || [] }, q);
  return { q, count: results.length, results, plan: "Basic", quotable: results.filter((x) => x.quotable).length, source: "Twelve Data symbol_search", fetchedAt: new Date().toISOString(), status: "LIVE", truncated: false, credits }; };

// S&P 500 map fixtures (shape of the Worker's /api/spx/* responses)
const ET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dShift = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const SPX_ITEMS = [["NVDA", "NVIDIA", "Information Technology", 8.6], ["AAPL", "APPLE", "Information Technology", 7.2], ["MSFT", "MICROSOFT", "Information Technology", 5.8], ["AMZN", "AMAZON COM", "Consumer Discretionary", 3.9], ["GOOGL", "ALPHABET CLASS A", "Communication", 2.4], ["META", "META PLATFORMS CLASS A", "Communication", 2.9], ["JPM", "JPMORGAN CHASE & CO", "Financials", 1.5], ["BRK.B", "BERKSHIRE HATHAWAY INC CLASS B", "Financials", 1.6], ["XOM", "EXXON MOBIL CORP", "Energy", 0.9], ["LLY", "ELI LILLY", "Health Care", 1.3], ["UNH", "UNITEDHEALTH GROUP INC", "Health Care", 0.8], ["ZZNA", "NO PRICE INC", "Utilities", 0.1]].map(([sym, name, sector, weight]) => ({ sym, name, sector, weight, exchange: "NYSE" }));
const SPX_PREV = { NVDA: 236, AAPL: 330, MSFT: 520, AMZN: 250, GOOGL: 340, META: 700, JPM: 330, "BRK.B": 480, XOM: 110, LLY: 800, UNH: 300 };
const SPX_LIVE = { NVDA: 240.72, AAPL: 326.7, MSFT: 520, AMZN: 257.5, GOOGL: 340, META: 707, JPM: 323.4, "BRK.B": 480, XOM: 111.1, LLY: 784, UNH: 310 };
const spxApi = (path, u, { configured = true } = {}) => {
  const now = new Date().toISOString();
  if (path === "/api/spx/universe") return { body: { source: "iShares Core S&P 500 ETF (IVV) — daily holdings", sourceUrl: "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf", holdingsAsOf: dShift(ET, -1), count: SPX_ITEMS.length, items: SPX_ITEMS, fetchedAt: now, status: "LIVE" } };
  if (!configured) return { status: 503, body: { error: "alpaca_not_configured", status: "N/A" } };
  if (path === "/api/spx/live") return { body: { trades: Object.fromEntries(Object.entries(SPX_LIVE).map(([k, v]) => [k, [v, now]])), live: true, todayET: ET, fetchedAt: now, status: "LIVE" } };
  const ref = u.searchParams.get("ref");
  if (ref === "recent") return { body: { ref, todayET: ET, todayBarFinal: false, closes: Object.fromEntries(Object.entries(SPX_PREV).map(([k, v]) => [k, [[dShift(ET, -2), v * 0.98], [dShift(ET, -1), v]]])), fetchedAt: now, status: "LIVE" } };
  return { body: { ref, target: dShift(ET, -30), todayET: ET, closes: Object.fromEntries(Object.entries(SPX_PREV).map(([k, v]) => [k, [dShift(ET, -31), v * 0.9]])), fetchedAt: now, status: "LIVE" } };
};

// briefing archive fixtures (shape of /api/briefs responses)
const BRF_TODAY = new Date().toISOString().slice(0, 10), BRF_PREV = dShift(BRF_TODAY, -1);
const BRIEF_ITEM = (id, d, title) => ({ id, period: "daily", d, title, created: Math.floor(Date.now() / 1000) - 600, n: 400, status: "DERIVED", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "Cloudflare Workers AI",
  body: "## In one line\nS&P 500 constituents rose 0.41% on an IVV-weighted basis.\n## Equities\n`NVDA` added 0.14% while `XYZ` is not a chip. [FT](https://www.ft.com/content/test-1)\n## Rates and currencies\n`EUR/USD` fell 0.52%.\n## Commodities and crypto\nData is not available.\n## Today\n- Consumer Price Index at 08:30 ET.",
  verification: { checked: 3, unverified: [], removedLinks: [], missingSections: [] }, symbols: ["NVDA", "EUR/USD"],
  windows: [{ type: "MAP", state: { metric: "1D", size: "weight", view: "map" }, label: "S&P 500 heat map · 1D", why: "Where the moves were." }, { type: "GP", state: { ticker: "NVDA", tf: "1W" }, label: "NVDA · largest positive contribution", why: "NVIDIA" }, { type: "YLD", state: {}, label: "Government curves", why: "Curves" }],
  sources: [{ name: "European Central Bank", timestamp: BRF_TODAY, url: "https://data.ecb.europa.eu/x" }], inputData: "EQUITY S&P 500 constituents ... +0.41%", disclaimer: "AI-written summary of the real data listed below. Not investment advice." });
const briefsApi = (u, method, state) => {
  if (u.pathname === "/api/briefs/write") { state.writes.push(u.search); state.written = true; return { status: 201, body: BRIEF_ITEM(`daily-${BRF_TODAY}`, BRF_TODAY, "Constituents edge up while the euro slips") }; }
  if (u.pathname === "/api/briefs/item") { const id = u.searchParams.get("id"); return { body: BRIEF_ITEM(id, id.slice(6), id.endsWith(BRF_TODAY) ? "Constituents edge up while the euro slips" : "Yesterday's edition") }; }
  const period = u.searchParams.get("period");
  const list = period === "daily" ? [...(state.written ? [{ id: `daily-${BRF_TODAY}`, period, d: BRF_TODAY, title: "Constituents edge up while the euro slips", created: 1, n: 400 }] : []), { id: `daily-${BRF_PREV}`, period, d: BRF_PREV, title: "Yesterday's edition", created: 1, n: 400 }] : [];
  return { body: { period, label: period[0].toUpperCase() + period.slice(1), schedule: period === "weekly" ? "Written on Saturday mornings from 08:00 (Rome time)." : "Written on weekday mornings from 07:30 (Rome time).", chipTf: "1W", due: period === "daily" ? { id: `daily-${BRF_TODAY}`, d: BRF_TODAY, writable: true } : null, dueWritten: period === "daily" ? !!state.written : false, briefs: list } };
};

// ---------- harness ----------
let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" + "-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
// (the briefing legitimately names its AI model, so "model" alone is allowed; a "model portfolio" is not)
const FORBIDDEN = /SIMULATED|\bSIM\b|MIXED|MODEL PORTFOLIO|MODEL —|hypothetical|static sample|\bsample\b|\bdemo\b|\bmock\b|\bfake\b|PORTFOLIO|\bDES\b/i;

async function openTerminal(api, html = htmlFast) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const requests = [], errors = [], quoteBatches = [], spxCalls = [], brfState = { writes: [], written: false };
  page.on("request", (r) => requests.push(r.url()));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    const send = (r) => route.fulfill({ status: r.status || 200, contentType: "application/json", body: JSON.stringify(r.body) });
    if (u.origin === ORIGIN && u.pathname === "/terminal/provenance.js") return route.fulfill({ contentType: "application/javascript", body: provJs });
    if (u.origin === ORIGIN && u.pathname.startsWith("/terminal")) return route.fulfill({ contentType: "text/html", body: html });
    if (u.origin === ORIGIN && u.pathname === "/api/quote") { const syms = (u.searchParams.get("symbols") || "").split(","); quoteBatches.push({ t: Date.now(), syms }); return send(api.quote(syms)); }
    if (u.origin === ORIGIN && u.pathname === "/api/history") return send(api.history(u.searchParams.get("symbol"), u.searchParams.get("range")));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/briefs")) return send(api.briefs ? api.briefs(u) : briefsApi(u, route.request().method(), brfState));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/spx/")) { spxCalls.push(u.pathname + u.search); return send(api.spx ? api.spx(u.pathname, u) : spxApi(u.pathname, u)); }
    if (u.origin === ORIGIN && u.pathname === "/api/search") return send(api.search ? api.search(u.searchParams.get("q")) : { body: searchBody(u.searchParams.get("q")) });
    if (u.origin === ORIGIN && ["/api/yields", "/api/calendar", "/api/news", "/api/briefing", "/api/headlines"].includes(u.pathname)) return send(api.ext(u.pathname.slice(5), u));
    if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) return route.fulfill({ body: "" });
    return route.abort();
  });
  await page.goto(ORIGIN + "/terminal/");
  return { page, requests, errors, quoteBatches, spxCalls, brfState };
}
const winOf = (page, prefix) => page.evaluate((p) => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith(p)); return w ? { text: w.querySelector(".win-body").innerText, pill: w.querySelector(".w-pv")?.innerText || "", pillTitle: w.querySelector(".w-pv .pv")?.getAttribute("title") || "" } : null; }, prefix);
const cmd = async (page, c) => { await page.fill("#cmd", c); await page.press("#cmd", "Enter"); await page.waitForTimeout(500); return page.evaluate(() => document.querySelector("#cmd").value !== ""); };
const wlFill = async (page, sym) => { await page.fill(".wl-in", sym); await page.press(".wl-in", "Enter"); await page.waitForTimeout(700); };

const OK_API = {
  quote: (syms) => {
    const quotes = {}, errors = {};
    for (const s of syms) { if (s === "ZZZZ") errors[s] = { error: "symbol_not_found", status: "N/A" }; else quotes[s] = instrument(s); }
    return { status: Object.keys(quotes).length ? 200 : 404, body: { quotes, errors, meta: {} } };
  },
  history: (sym, range) => ({ body: historyBody(sym, range) }),
  ext: (name, u) => ({ body: name === "headlines" ? PRESS(u.searchParams.get("source")) : { yields: YIELDS, calendar: CALENDAR, news: NEWS, briefing: BRIEF }[name] }),
};

// =============== A. every section on real-shaped data ===============
{
  const { page, requests, errors, quoteBatches, brfState } = await openTerminal(OK_API);
  await page.evaluate(() => localStorage.removeItem("at-watchlist"));
  await page.reload();
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  ok("[A] quote requests are chunked to ≤ 7 symbols", quoteBatches.length >= 2 && quoteBatches.every((b) => b.syms.length <= 7), quoteBatches.map((b) => b.syms.length).join());
  ok("[A] default layout: security, watchlist, markets, yields", (await page.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent).join())) === "GP,WL,MKT,YLD");
  // watchlist: real rows, editable
  ok("[A] watchlist = 6 default instruments with name, price, change, time, status", (await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())) === WL.join() && /AAPL\s+LIVE\s*AAPL Inc/.test((await winOf(page, "WATCHLIST")).text));
  await wlFill(page, "tsla");
  ok("[A] add TSLA: validated with the provider, appended, saved", (await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())).endsWith(",TSLA") && (await page.evaluate(() => localStorage.getItem("at-watchlist"))).includes("TSLA") && /TSLA added/.test((await winOf(page, "WATCHLIST")).text));
  await wlFill(page, "ZZZZ");
  ok("[A] unknown symbol refused with the provider's reason, nothing added", /ZZZZ not added: unknown symbol/.test((await winOf(page, "WATCHLIST")).text) && !(await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())).includes("ZZZZ"));
  await wlFill(page, "AA PL;");
  ok("[A] text that is not a ticker goes to the symbol search, nothing added", /is not a ticker — searching by name/.test((await winOf(page, "WATCHLIST")).text) && !!(await winOf(page, "SYMBOL SEARCH")) && (await page.$$eval(".wl-row", (r) => r.length)) === 7);
  await page.click('.wl-x[data-del="TSLA"]'); await page.waitForTimeout(400);
  ok("[A] remove TSLA", !(await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())).includes("TSLA") && !(await page.evaluate(() => localStorage.getItem("at-watchlist"))).includes("TSLA"));
  await page.reload();
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  ok("[A] watchlist persists across reloads", (await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())) === WL.join());
  // markets
  await page.waitForTimeout(800);
  const mkt = await winOf(page, "MARKETS");
  ok("[A] markets: FX, crypto, metals with real-shaped quotes", /EUR\/USD[\s\S]*1\.12601/.test(mkt.text) && /BTC\/USD[\s\S]*85,650\.01/.test(mkt.text) && /XAU\/USD[\s\S]*4,165\.24/.test(mkt.text), mkt.text.slice(0, 300));
  ok("[A] markets: FX volume N/A, equity volume PARTIAL", /EUR\/USD[^\n]*\n?[^\n]*N\/A/.test(mkt.text) && /537\.8K\s*PART/.test(mkt.text));
  ok("[A] markets: indices and commodities shown as N/A, not substituted", /INDICES[\s\S]*N\/A — no licensed index source/.test(mkt.text) && /WTI[\s\S]*N\/A — not available on the current data plan/.test(mkt.text));
  // indices
  await cmd(page, "IDX");
  const idx = await winOf(page, "WORLD INDICES");
  ok("[A] indices: NO DATA with the reason, every level N/A, no numbers", /NO DATA — no real index source/.test(idx.text) && idx.pill === "N/A" && (idx.text.match(/N\/A/g) || []).length >= 13 * 4 && !/\d+\.\d+/.test(idx.text.split("ETFs are not shown")[1] || ""));
  // yields
  const yl = await winOf(page, "GOVERNMENT YIELDS");
  ok("[A] yields: U.S. Treasury 14 maturities, data date, source link", /U\.S\. Department of the Treasury/.test(yl.text) && /data date/.test(yl.text) && TEN.every((t) => yl.text.includes(t)), yl.text.slice(0, 200));
  ok("[A] yields: a maturity the source did not publish is N/A", /YIELD %\s+4\.00\s+N\/A\s+4\.24/.test(yl.text), (yl.text.match(/YIELD %[^\n]*/) || [])[0]);
  ok("[A] yields: change and 2s10s marked DERIVED; ECB curve; other countries N/A", /Δ BP\s*DRV/.test(yl.text) && /2s10s spread [\d.]+ bp\s*DRV/.test(yl.text) && /European Central Bank/.test(yl.text) && /Not connected: Germany, Italy, Japan — N\/A/.test(yl.text));
  // calendar
  await cmd(page, "CAL");
  const cal = await winOf(page, "ECONOMIC CALENDAR");
  ok("[A] calendar: official event with date, time, country, source; actual/forecast/previous/importance N/A", /2026-10-14\s+08:30\s+US\s+Consumer Price Index\s+N\/A\s+N\/A\s+N\/A\s+N\/A\s+BLS/.test(cal.text) && /U\.S\. Bureau of Labor Statistics/.test(cal.text), cal.text.slice(0, 300));
  // news
  await cmd(page, "N");
  const nw = await winOf(page, "NEWS");
  ok("[A] news: real headline with source and link; SEC filing for a watchlist ticker", /Stocks close higher as tech rallies\s*example-news\.com/.test(nw.text) && /AAPL · 8-K · Apple Inc\./.test(nw.text) && (await page.$$eval(".news-item a.h", (a) => a.every((x) => /^https:\/\//.test(x.href) && x.target === "_blank"))));
  ok("[A] news: FT and Bloomberg headlines (title, section, time, link only) merged with the wire, newest first", /Test FT markets headline\s*FT · MARKETS/.test(nw.text) && /Test Bloomberg economics headline\s*BLOOMBERG · ECONOMICS/.test(nw.text) && nw.text.indexOf("Test FT markets headline") < nw.text.indexOf("Test Bloomberg economics headline") && (await page.$$eval(".news-item a.h", (a) => a.some((x) => x.href.startsWith("https://www.ft.com/")))));
  await page.click('.win [data-src="BLOOMBERG"]'); await page.waitForTimeout(300);
  const nwB = await winOf(page, "NEWS");
  ok("[A] news: source filter (BLOOMBERG only)", /Test Bloomberg economics headline/.test(nwB.text) && !/Test FT markets headline/.test(nwB.text) && !/Stocks close higher/.test(nwB.text));
  await page.click('.win [data-src="ALL"]'); await page.waitForTimeout(200);
  ok("[A] news request carries the watchlist equities only", requests.some((u) => u.includes("/api/news?tickers=NVDA%2CAAPL%2CMSFT%2CAMZN%2CGOOGL%2CJPM")));
  // briefing (reference format: editions, archive, chips, attached windows)
  await cmd(page, "BRF"); await page.waitForTimeout(900);
  let br = await winOf(page, "BRIEFING");
  ok("[A] briefing: the due daily edition is written once (POST) with the watchlist + markets symbols", brfState.writes.length === 1 && /period=daily/.test(brfState.writes[0]) && /symbols=NVDA.*EUR%2FUSD/.test(brfState.writes[0]));
  ok("[A] briefing: period tabs, archive list, title, sections, DERIVED label, model, disclaimer", /DAILY\s*EVENING\s*WEEKLY\s*MONTHLY/.test(br.text) && /Constituents edge up while the euro slips/.test(br.text) && /Yesterday's edition/.test(br.text) && /IN ONE LINE/i.test(br.text) && /RATES AND CURRENCIES/i.test(br.text) && /DRV/.test(br.text) && /llama/.test(br.text) && /Not investment advice/.test(br.text) && br.pill === "DERIVED", JSON.stringify(br.text.slice(0, 600)) + " pill=" + br.pill);
  ok("[A] briefing: tickers from DATA become chips; others stay plain; links kept", (await page.$$eval(".brief-sym", (b) => b.map((x) => x.textContent).join())) === "NVDA,EUR/USD" && /XYZ/.test(br.text) && (await page.$$eval(".brf-art a", (a) => a.some((x) => x.href === "https://www.ft.com/content/test-1"))));
  ok("[A] briefing: number check and sources shown", /Number check: all 3 figures match the source data/.test(br.text) && /SOURCES[\s\S]*European Central Bank/.test(br.text));
  await page.click('.brief-sym[data-sym="NVDA"]'); await page.waitForTimeout(500);
  ok("[A] briefing: a chip opens the instrument at the edition's range (daily → 1W)", await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent.startsWith("NVDA")); return !!w && w.querySelector('.tf[aria-pressed="true"]').textContent === "1W"; }));
  await page.click('[data-allwin="1"]'); await page.waitForTimeout(900);
  ok("[A] briefing: 'Open all as a view' opens the attached windows (heat map, chart, curves)", (await page.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent))).filter((x) => ["MAP", "YLD"].includes(x)).length === 2);
  await page.click('.win [data-period="weekly"]'); await page.waitForTimeout(500);
  br = await winOf(page, "BRIEFING");
  ok("[A] briefing: an empty period says when it is written (no text invented)", /No weekly briefing yet\. Written on Saturday mornings/.test(br.text) && brfState.writes.length === 1);
  await page.click('.win [data-period="daily"]'); await page.waitForTimeout(300);
  // global checks
  const body = await page.evaluate(() => document.body.innerText);
  ok("[A] no simulated / mock / sample / model wording anywhere", !FORBIDDEN.test(body), (body.match(new RegExp(".{0,30}(" + FORBIDDEN.source + ").{0,30}", "i")) || [])[0]);
  ok("[A] no NaN / undefined rendered", !/NaN|undefined/.test(body));
  ok("[A] launcher has search + the 7 sections", (await page.$$eval("#fnbar .fn", (b) => b.map((x) => x.textContent).join(","))).startsWith("SECURITY,SEARCH,WATCHLIST,MARKETS,S&P 500 MAP,INDICES,YIELDS,CALENDAR,NEWS,BRIEFING"));
  ok("[A] browser calls only this site's /api (no provider hosts, no keys)", !requests.some((u) => /twelvedata\.com|treasury\.gov|ecb\.europa|bls\.gov|bea\.gov|gdeltproject|sec\.gov|apikey=|token=/i.test(u)));
  ok("[A] no JavaScript errors", errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "TILE"); await page.waitForTimeout(800); await page.screenshot({ path: SHOTS + "/e2e-t05.png" }); }
  await page.close();
}

// =============== B. every provider down: N/A everywhere, nothing invented ===============
{
  const DOWN = {
    briefs: () => ({ status: 503, body: { error: "storage_not_configured", status: "N/A" } }),
    quote: (syms) => ({ status: 429, body: { quotes: {}, errors: Object.fromEntries(syms.map((s) => [s, { error: "rate_limited", status: "N/A" }])), meta: {} } }),
    history: () => ({ status: 429, body: { error: "rate_limited", status: "N/A" } }),
    ext: (name) => ({ status: name === "briefing" ? 503 : 502, body: name === "yields" ? { curves: {}, errors: { US: { error: "provider_timeout", status: "N/A" }, EA: { error: "provider_error", status: "N/A" } }, notConnected: [] } : name === "briefing" ? { error: "model_unavailable", status: "N/A" } : { events: [], items: [], filings: [], sources: [], errors: { X: { error: "provider_unreachable", status: "N/A" } } } }),
  };
  const { page, errors } = await openTerminal(DOWN);
  await page.waitForFunction(() => /N\/A/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  for (const c of ["CAL", "N", "BRF", "IDX"]) await cmd(page, c);
  await page.waitForTimeout(1200);
  const body = await page.evaluate(() => document.body.innerText);
  ok("[B] no price anywhere (no fallback value)", !/\$\d/.test(body) && !/\d\.\d{3,}/.test(body), (body.match(/.{20}(\$\d|\d\.\d{3,}).{10}/) || [])[0]);
  ok("[B] yields: N/A with the provider reason, no curve", /UNITED STATES · U\.S\. TREASURY\s*N\/A[\s\S]*provider timed out/.test((await winOf(page, "GOVERNMENT YIELDS")).text));
  ok("[B] calendar and news: NO DATA with the reason", /NO DATA/.test((await winOf(page, "ECONOMIC CALENDAR")).text) && /provider unreachable/.test((await winOf(page, "NEWS")).text));
  ok("[B] briefing: N/A, no text produced", /briefing archive unavailable/.test((await winOf(page, "BRIEFING")).text) && (await winOf(page, "BRIEFING")).pill === "N/A" && !(await page.$(".brf-art")));
  ok("[B] no NaN rendered; no JavaScript errors", !/NaN/.test(body) && errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "TILE"); await page.waitForTimeout(600); await page.screenshot({ path: SHOTS + "/e2e-t05-down.png" }); }
  await page.close();
}

// =============== C. one stale instrument: the mix is indicated ===============
{
  const STALE = { ...OK_API, quote: (syms) => ({ body: { quotes: Object.fromEntries(syms.map((s) => [s, instrument(s, { stale: s === "NVDA" })])), errors: {}, meta: {} } }) };
  const { page, errors } = await openTerminal(STALE);
  await page.waitForFunction(() => /STALE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  ok("[C] badge counts the stale instrument", /● STALE · \d+ LIVE · 1 STALE/.test(await page.textContent("#dataBadge")), await page.textContent("#dataBadge"));
  const wl = await winOf(page, "WATCHLIST");
  ok("[C] watchlist pill STALE, rows LIVE + STALE", wl.pill === "STALE" && /NVDA\s+STALE/.test(wl.text) && /AAPL\s+LIVE/.test(wl.text));
  ok("[C] no JavaScript errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== D. real credit budget: never more than 8 credits per minute ===============
{
  const { page, quoteBatches } = await openTerminal(OK_API, html0);
  await page.waitForTimeout(6000);
  const first = quoteBatches.reduce((a, b) => a + b.syms.length, 0);
  ok("[D] with the real budget (8/min) only one ≤7-symbol batch is sent in the first minute", quoteBatches.length === 1 && first <= 7, quoteBatches.map((b) => b.syms.length).join());
  ok("[D] that first batch is the watchlist (priority over the markets board)", WL.every((s) => quoteBatches[0].syms.includes(s)), quoteBatches[0] && quoteBatches[0].syms.join());
  await page.close();
}

// =============== E. symbol discovery: search → select → fetch on demand ===============
{
  const { page, requests, errors, quoteBatches } = await openTerminal(OK_API);
  await page.evaluate(() => { localStorage.removeItem("at-watchlist"); localStorage.removeItem("at-wlmeta"); });
  await page.reload();
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await cmd(page, "Novartis"); await page.waitForTimeout(400);
  let sr = await winOf(page, "SYMBOL SEARCH");
  ok("[E] a company name in the command line opens SYMBOL SEARCH with the provider's listings", !!sr && /NOVN\s+Novartis AG Registered Shares\s+SIX XSWX\s+Switzerland/.test(sr.text) && /NVS\s+Novartis AG Sponsored ADR/.test(sr.text), sr && sr.text.slice(0, 400));
  ok("[E] plan shown per listing (BASIC vs PRO+), source + time, LIVE pill", /BASIC/.test(sr.text) && /PRO\+/.test(sr.text) && /3 listings · 1 quotable on the current plan \(Basic\) · source Twelve Data symbol_search/.test(sr.text) && sr.pill === "LIVE");
  ok("[E] search costs no quote: no /api/quote for search results", !quoteBatches.some((b) => b.syms.some((x) => /NOVN|NVS/.test(x))));
  ok("[E] +WL disabled for a listing outside the plan", await page.$eval('[data-add="NOVN:XSWX"]', (b) => b.disabled));
  await page.click('[data-open="NOVN:XSWX"]'); await page.waitForTimeout(500);
  const gpCh = await winOf(page, "NOVN:XSWX");
  ok("[E] OPEN on a listing outside the plan → N/A with the reason, no credit spent", !!gpCh && /N\/A — quote and history unavailable: listed by the provider on SIX, but not included in the current data plan \(Twelve Data Basic\); it needs the Pro plan or higher/.test(gpCh.text) && !requests.some((u) => /NOVN/.test(u) && /\/api\/(quote|history)/.test(u)), gpCh && gpCh.text.slice(0, 300));
  ok("[E] its window shows venue, country and currency from the symbol master, no price", /SIX · XSWX · Switzerland · CHF · Common Stock/.test(gpCh.text) && !/CHF\s*\d|\d[\d,]*\.\d\d CHF/.test(gpCh.text));
  await page.click('[data-add="NVS"]'); await page.waitForTimeout(700);
  ok("[E] +WL on a quotable listing: validated with a real quote, added, metadata saved", (await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())).endsWith(",NVS") && quoteBatches.some((b) => b.syms.join() === "NVS") && JSON.parse(await page.evaluate(() => localStorage.getItem("at-wlmeta"))).NVS.exchange === "NYSE" && /NVS added/.test((await winOf(page, "SYMBOL SEARCH")).text));
  await page.click('[data-open="NVS"]'); await page.waitForTimeout(800);
  const gpN = await winOf(page, "NVS");
  ok("[E] OPEN on a quotable listing: real quote + history fetched on demand", /\$120\.40/.test(gpN.text) && requests.some((u) => /\/api\/history\?symbol=NVS&/.test(u)), gpN.text.slice(0, 200));
  await cmd(page, "toyota"); await page.waitForTimeout(400);
  await page.click('[data-open="7203:XJPX"]'); await page.waitForTimeout(900);
  const gpJ = await winOf(page, "7203:XJPX");
  ok("[E] non-US listing on the plan: venue id sent as SYMBOL:MIC, price in its own currency (no $, no conversion)", quoteBatches.some((b) => b.syms.includes("7203:XJPX")) && /2,861\.00 JPY/.test(gpJ.text) && !/\$2,861/.test(gpJ.text) && requests.some((u) => u.includes("/api/history?symbol=7203%3AXJPX")), gpJ.text.slice(0, 200));
  const before = (await winOf(page, "SYMBOL SEARCH")).text;
  await cmd(page, "TSLA"); await page.waitForTimeout(900);
  ok("[E] an exact quotable ticker typed in the command line opens its quote window", !!(await winOf(page, "TSLA")) && quoteBatches.some((b) => b.syms.includes("TSLA")) && before !== (await winOf(page, "SYMBOL SEARCH")).text);
  await cmd(page, "SRCH apple"); await page.waitForTimeout(400);
  ok("[E] SRCH <query> searches; 'Apple' → AAPL first", /^AAPL\s+Apple Inc\./m.test((await winOf(page, "SYMBOL SEARCH")).text.split("CCY")[1].trim()));
  await page.reload();
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  ok("[E] watchlist with a searched instrument persists with its name", (await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())).endsWith(",NVS"));
  ok("[E] news is not asked for venue ids or pairs", requests.filter((u) => u.includes("/api/news?")).every((u) => !/%3A|%2F/.test(u.split("tickers=")[1] || "")));
  const body = await page.evaluate(() => document.body.innerText);
  ok("[E] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(body) && !/NaN|undefined/.test(body) && errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "Roche"); await page.waitForTimeout(500); await page.screenshot({ path: SHOTS + "/e2e-search.png" }); }
  await page.close();
}
{
  // search provider down → N/A message, nothing invented
  const DOWN = { ...OK_API, search: (q) => ({ status: 502, body: { q, results: [], error: "provider_unreachable", status: "N/A", credits: 0 } }) };
  const { page, errors } = await openTerminal(DOWN);
  await cmd(page, "Roche"); await page.waitForTimeout(400);
  const sr = await winOf(page, "SYMBOL SEARCH");
  ok("[E] search unavailable → N/A with the reason, no rows", /N\/A — search unavailable: provider unreachable/.test(sr.text) && sr.pill === "N/A" && !/SYMBOL\s+NAME/.test(sr.text));
  ok("[E] no JavaScript errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== F. S&P 500 heat map: real constituents + prices, changes derived ===============
{
  const { page, errors, spxCalls, quoteBatches } = await openTerminal(OK_API);
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await cmd(page, "MAP"); await page.waitForTimeout(900);
  let mp = await winOf(page, "S&P 500 HEAT MAP");
  const tiles = await page.$$eval(".spx-t", (t) => t.map((x) => ({ s: x.dataset.s, na: x.classList.contains("spx-na"), bg: x.style.background, w: x.offsetWidth, h: x.offsetHeight, txt: x.innerText })));
  ok("[F] MAP opens the heat map: one tile per constituent, grouped by sector", !!mp && tiles.length === SPX_ITEMS.length && (await page.$$eval(".spx-sec", (s) => s.length)) === 7, mp && mp.text.slice(0, 200));
  ok("[F] only universe, recent closes and live trades are requested for 1D", ["/api/spx/universe", "/api/spx/closes?ref=recent", "/api/spx/live"].every((p) => spxCalls.includes(p)) && !spxCalls.some((p) => /ref=1M/.test(p)));
  const nv = tiles.find((t) => t.s === "NVDA"), aapl = tiles.find((t) => t.s === "AAPL");
  ok("[F] 1D change = live IEX trade vs last consolidated close (NVDA +2.00%, AAPL −1.00%)", /\+2\.00%/.test(nv.txt) && /-1\.00%/.test(aapl.txt), nv.txt + " / " + aapl.txt);
  ok("[F] colour by sign, neutral at 0, striped N/A for a constituent without price", nv.bg !== aapl.bg && tiles.find((t) => t.s === "ZZNA").na && !tiles.find((t) => t.s === "MSFT").na);
  ok("[F] tile area follows the index weight", nv.w * nv.h > 20 * tiles.find((t) => t.s === "XOM").w * tiles.find((t) => t.s === "XOM").h / 2);
  ok("[F] footer names the sources, holdings date and N/A count; pill DERIVED", /iShares IVV holdings as of/.test(mp.text) && /latest IEX trade/.test(mp.text) && /1 N\/A/.test(mp.text) && /changes DERIVED/.test(mp.text) && mp.pill === "LIVE", mp.pill + " | " + mp.text.slice(-300));
  ok("[F] sector header shows the weighted change", /INFORMATION TECHNOLOGY [+-]\d+\.\d\d%/.test(mp.text));
  await page.hover('.spx-t[data-s="AAPL"]'); await page.waitForTimeout(150);
  const tip = await page.$eval(".spx-tip", (t) => ({ d: getComputedStyle(t).display, txt: t.innerText }));
  ok("[F] hover: value first, then name, weight, last price source and base date", tip.d === "block" && /^-1\.00%/.test(tip.txt) && /APPLE/.test(tip.txt) && /weight 7\.20%/.test(tip.txt) && /IEX trade/.test(tip.txt) && /consolidated close \d{4}-\d{2}-\d{2}/.test(tip.txt), tip.txt);
  await page.click('[data-metric="1M"]'); await page.waitForTimeout(700);
  mp = await winOf(page, "S&P 500 HEAT MAP");
  ok("[F] switching to 1M fetches the 1M reference closes and recolours (NVDA +13.33%)", spxCalls.includes("/api/spx/closes?ref=1M") && /\+13\.33%/.test(await page.$eval('.spx-t[data-s="NVDA"]', (t) => t.innerText)));
  await page.click('[data-size="equal"]'); await page.waitForTimeout(300);
  const eq = await page.$$eval(".spx-t", (t) => t.map((x) => x.offsetWidth * x.offsetHeight));
  ok("[F] EQUAL size: tiles of (almost) equal area", Math.max(...eq) / Math.min(...eq) < 1.6, eq.join());
  await page.click('[data-view="table"]'); await page.waitForTimeout(300);
  const rowsT = await page.$$eval(".win tr[data-open]", (r) => r.map((x) => x.dataset.open));
  ok("[F] TABLE view: every constituent, sorted by change, N/A last", rowsT.length === SPX_ITEMS.length && rowsT[rowsT.length - 1] === "ZZNA" && rowsT[0] === "UNH");
  await page.click('[data-view="map"]'); await page.waitForTimeout(300);
  await page.click('.spx-t[data-s="MSFT"]'); await page.waitForTimeout(600);
  ok("[F] clicking a tile opens its quote window", !!(await winOf(page, "MSFT")));
  const body = await page.evaluate(() => document.body.innerText);
  ok("[F] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(body) && !/NaN|undefined/.test(body) && errors.length === 0, errors.join(" | "));
  if (SHOTS) { await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => /S&P 500/.test(w.querySelector(".w-title").textContent)); w.querySelector(".w-max").click(); }); await page.click('[data-metric="1D"]'); await page.click('[data-size="weight"]'); await page.waitForTimeout(600); await page.screenshot({ path: SHOTS + "/e2e-map.png" }); }
  await page.close();
}
{
  // price source not connected: constituents and weights only, every change N/A, nothing invented
  const NOKEY = { ...OK_API, spx: (path, u) => spxApi(path, u, { configured: false }) };
  const { page, errors } = await openTerminal(NOKEY);
  await cmd(page, "MAP"); await page.waitForTimeout(900);
  const mp = await winOf(page, "S&P 500 HEAT MAP");
  const tiles = await page.$$eval(".spx-t", (t) => t.map((x) => ({ na: x.classList.contains("spx-na"), txt: x.innerText })));
  ok("[F] keys missing → NO DATA banner, all tiles N/A, no percentages", /NO DATA — price source not connected/.test(mp.text) && tiles.length === SPX_ITEMS.length && tiles.every((t) => t.na && !/%/.test(t.txt)) && !/[+-]\d+\.\d\d%/.test(mp.text) && /N\/A/.test(mp.pillTitle || ""), mp.pill + " | " + mp.pillTitle + " | " + mp.text.slice(0, 400));
  ok("[F] no JavaScript errors (keys missing)", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
