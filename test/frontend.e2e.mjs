// Headless browser tests of the terminal page with MOCKED /api responses (test fixtures, never shipped).
// Quote fixtures come from the Worker's own normalizeQuote + buildInstrument (real contract).
// Policy under test: only real data, otherwise N/A / NO DATA.
//   node test/frontend.e2e.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { normalizeQuote, buildInstrument } from "../src/worker.mjs";

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
const PRICES = { NVDA: 190.5, AAPL: 250, MSFT: 430.25, AMZN: 210.1, GOOGL: 205.75, JPM: 260.4, TSLA: 301.2, "EUR/USD": 1.12601, "GBP/USD": 1.32769, "USD/JPY": 158.148, "BTC/USD": 85650.01, "ETH/USD": 2694.37, "XAU/USD": 4165.235 };
function instrument(s, { stale = false } = {}) {
  const now = Date.now(), px = PRICES[s] || 100, fx = s.includes("/");
  const rec = normalizeQuote(s, { symbol: s, name: s + (fx ? " rate" : " Inc"), exchange: fx ? "Forex" : "NASDAQ", currency: "USD", close: String(px), previous_close: String(px * 0.99), percent_change: "1.0101", change: String(px * 0.01), open: String(px), high: String(px * 1.01), low: String(px * 0.98), volume: fx ? "" : "537842", is_market_open: true, last_quote_at: Math.floor(now / 1000) - 60, fifty_two_week: { low: String(px * 0.7), high: String(px * 1.2) } });
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
const CALENDAR = { events: [{ id: "a", datetime: new Date(Date.now() + 2 * 864e5).toISOString(), dateET: "2026-10-14", timeET: "08:30", country: "US", indicator: "Consumer Price Index", source: "BLS", sourceName: "U.S. Bureau of Labor Statistics", sourceUrl: "https://www.bls.gov/schedule/news_release/", released: false, actual: NA("needs FRED API key"), forecast: NA("no licensed consensus source"), previous: NA("needs FRED API key"), importance: NA("no licensed importance rating") }],
  sources: [{ id: "BLS", name: "U.S. Bureau of Labor Statistics", url: "https://www.bls.gov/schedule/news_release/", status: "LIVE", fetchedAt: new Date().toISOString() }, { id: "BEA", name: "U.S. Bureau of Economic Analysis", url: "https://www.bea.gov/news/schedule", status: "LIVE", fetchedAt: new Date().toISOString() }], errors: {} };
const NEWS = { items: [{ title: "Stocks close higher as tech rallies", url: "https://www.example-news.com/a", source: "example-news.com", timestamp: new Date().toISOString(), topic: "Stock market", provider: "GDELT" }],
  filings: [{ ticker: "AAPL", company: "Apple Inc.", form: "8-K", description: "8-K", filingDate: today, timestamp: new Date().toISOString(), url: "https://www.sec.gov/Archives/edgar/data/320193/x/aapl-8k.htm", provider: "SEC EDGAR" }],
  sources: [{ id: "GDELT", name: "The GDELT Project", url: "https://www.gdeltproject.org/", status: "LIVE", fetchedAt: new Date().toISOString() }, { id: "SEC", name: "SEC EDGAR", url: "https://www.sec.gov/edgar/search/", status: "LIVE", fetchedAt: new Date().toISOString() }], errors: {} };
const BRIEF = { status: "DERIVED", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "Cloudflare Workers AI", generatedAt: new Date().toISOString(), text: "Markets: AAPL last 250 [Twelve Data].\nRates: US 10Y 5.32% [U.S. Department of the Treasury].\nCalendar and news: Consumer Price Index on 2026-10-14 [BLS].", verification: { checked: 1, unverified: [] }, sources: [{ name: "U.S. Department of the Treasury", timestamp: today, url: "https://home.treasury.gov/x" }, { name: "Twelve Data (quotes, Worker cache)", timestamp: new Date().toISOString() }], inputs: {}, inputData: "QUOTE AAPL ...", disclaimer: "AI-generated summary of the listed real data. Not investment advice.", cache: "MISS" };

// ---------- harness ----------
let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" + "-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
// (the briefing legitimately names its AI model, so "model" alone is allowed; a "model portfolio" is not)
const FORBIDDEN = /SIMULATED|\bSIM\b|MIXED|MODEL PORTFOLIO|MODEL —|hypothetical|static sample|\bsample\b|\bdemo\b|\bmock\b|\bfake\b|PORTFOLIO|\bDES\b/i;

async function openTerminal(api, html = htmlFast) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const requests = [], errors = [], quoteBatches = [];
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
    if (u.origin === ORIGIN && ["/api/yields", "/api/calendar", "/api/news", "/api/briefing"].includes(u.pathname)) return send(api.ext(u.pathname.slice(5), u));
    if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) return route.fulfill({ body: "" });
    return route.abort();
  });
  await page.goto(ORIGIN + "/terminal/");
  return { page, requests, errors, quoteBatches };
}
const winOf = (page, prefix) => page.evaluate((p) => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith(p)); return w ? { text: w.querySelector(".win-body").innerText, pill: w.querySelector(".w-pv")?.innerText || "" } : null; }, prefix);
const cmd = async (page, c) => { await page.fill("#cmd", c); await page.press("#cmd", "Enter"); await page.waitForTimeout(500); return page.evaluate(() => document.querySelector("#cmd").value !== ""); };
const wlFill = async (page, sym) => { await page.fill(".wl-in", sym); await page.press(".wl-in", "Enter"); await page.waitForTimeout(700); };

const OK_API = {
  quote: (syms) => {
    const quotes = {}, errors = {};
    for (const s of syms) { if (s === "ZZZZ") errors[s] = { error: "symbol_not_found", status: "N/A" }; else quotes[s] = instrument(s); }
    return { status: Object.keys(quotes).length ? 200 : 404, body: { quotes, errors, meta: {} } };
  },
  history: (sym, range) => ({ body: historyBody(sym, range) }),
  ext: (name) => ({ body: { yields: YIELDS, calendar: CALENDAR, news: NEWS, briefing: BRIEF }[name] }),
};

// =============== A. every section on real-shaped data ===============
{
  const { page, requests, errors, quoteBatches } = await openTerminal(OK_API);
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
  ok("[A] malformed symbol refused locally", /not a valid symbol/.test((await winOf(page, "WATCHLIST")).text));
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
  ok("[A] news request carries the watchlist equities only", requests.some((u) => u.includes("/api/news?tickers=NVDA%2CAAPL%2CMSFT%2CAMZN%2CGOOGL%2CJPM")));
  // briefing
  await cmd(page, "BRF");
  const br = await winOf(page, "BRIEFING");
  ok("[A] briefing: AI-generated label, model, time, disclaimer, sources, number check", /AI-GENERATED\s*DRV/.test(br.text) && /llama/.test(br.text) && /Not investment advice/.test(br.text) && /Number check: all 1 figures match/.test(br.text) && /SOURCES[\s\S]*U\.S\. Department of the Treasury/.test(br.text));
  ok("[A] briefing request carries watchlist + markets symbols", requests.some((u) => /\/api\/briefing\?symbols=NVDA.*EUR%2FUSD/.test(u)));
  // global checks
  const body = await page.evaluate(() => document.body.innerText);
  ok("[A] no simulated / mock / sample / model wording anywhere", !FORBIDDEN.test(body), (body.match(new RegExp(".{0,30}(" + FORBIDDEN.source + ").{0,30}", "i")) || [])[0]);
  ok("[A] no NaN / undefined rendered", !/NaN|undefined/.test(body));
  ok("[A] launcher has the 7 sections", (await page.$$eval("#fnbar .fn", (b) => b.map((x) => x.textContent).join(","))).startsWith("SECURITY,WATCHLIST,MARKETS,INDICES,YIELDS,CALENDAR,NEWS,BRIEFING"));
  ok("[A] browser calls only this site's /api (no provider hosts, no keys)", !requests.some((u) => /twelvedata\.com|treasury\.gov|ecb\.europa|bls\.gov|bea\.gov|gdeltproject|sec\.gov|apikey=|token=/i.test(u)));
  ok("[A] no JavaScript errors", errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "TILE"); await page.waitForTimeout(800); await page.screenshot({ path: SHOTS + "/e2e-t05.png" }); }
  await page.close();
}

// =============== B. every provider down: N/A everywhere, nothing invented ===============
{
  const DOWN = {
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
  ok("[B] briefing: N/A, no text produced", /briefing unavailable/.test((await winOf(page, "BRIEFING")).text) && (await winOf(page, "BRIEFING")).pill === "N/A");
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
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
