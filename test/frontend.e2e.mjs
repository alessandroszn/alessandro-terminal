// Headless browser tests of the terminal page with MOCKED /api responses (test fixtures, never shipped).
// Quote fixtures come from the Worker's own normalizeQuote + buildInstrument (real contract).
// Policy under test: only real data, otherwise N/A / NO DATA.
//   node test/frontend.e2e.mjs
import { chromium } from "playwright";
import { buildPositions, validateTx } from "../src/portfolio.mjs";
import { readFileSync, existsSync } from "node:fs";
import { normalizeQuote, buildInstrument, app as workerApp } from "../src/worker.mjs";
import { normalizeSearch } from "../src/search.mjs";
import { cnbcIntlRec, cnbcInstrument } from "../src/intl.mjs";
import { settlementCandidates } from "../src/finra.mjs";
import { ucitsMatch, JUSTETF_KEY, UCITS_ETFS } from "../src/ucits.mjs";
import { FF_BASE } from "../src/factors.mjs";
import { deflateRawSync } from "node:zlib";
import { handleRecording, handleReplayPublic, recordable } from "../src/replay.mjs";

const html0 = readFileSync(new URL("../public/terminal/desk/index.html", import.meta.url), "utf8");
// speed: lift the client credit budget for UI tests (scenario D tests the real budget)
const htmlFast = html0.replace("creditsPerMin:8,", "creditsPerMin:60,");
const provJs = readFileSync(new URL("../public/terminal/provenance.js", import.meta.url), "utf8");
const i18nJs = readFileSync(new URL("../public/terminal/i18n.js", import.meta.url), "utf8");
const lwcJs = readFileSync(new URL("../public/terminal/vendor/lightweight-charts.js", import.meta.url), "utf8");
const quantJs = readFileSync(new URL("../public/terminal/qmath.js", import.meta.url), "utf8");
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
  US: { id: "US", name: "United States — Treasury par yield curve", kind: "par yield, end of day", source: "U.S. Department of the Treasury", sourceUrl: "https://home.treasury.gov/x", status: "LIVE", timestamp: today, previousDate: "2026-10-02", fetchedAt: new Date().toISOString(), staleAt: new Date(Date.now() + 4 * 864e5).toISOString(), points: TEN.map((t, i) => ({ tenor: t, months: [1, 1.5, 2, 3, 4, 6, 12, 24, 36, 60, 84, 120, 240, 360][i], value: t === "1.5M" ? null : +(4 + i * 0.12).toFixed(2), status: t === "1.5M" ? "N/A" : "LIVE", changeBp: t === "1.5M" ? null : 2.0 })) },
  EA: { id: "EA", name: "Euro area — AAA government bonds spot curve", kind: "spot rate (Svensson), end of day", source: "European Central Bank", sourceUrl: "https://data.ecb.europa.eu/x", status: "LIVE", timestamp: today, previousDate: "2026-10-02", fetchedAt: new Date().toISOString(), staleAt: new Date(Date.now() + 4 * 864e5).toISOString(), points: ["3M", "2Y", "10Y", "30Y"].map((t, i) => ({ tenor: t, months: [3, 24, 120, 360][i], value: 2 + i * 0.3, status: "LIVE", changeBp: -1.5 })) } },
  errors: {}, notConnected: ["Brazil", "Turkey", "India"],
  catalog: [{ id: "US", region: "Americas", name: "United States", source: "U.S. Department of the Treasury", freq: "D", histTenor: "10Y" }, { id: "EA", region: "Europe", name: "Euro area", source: "European Central Bank", freq: "D", histTenor: "10Y" },
    { id: "DE", region: "Europe", name: "Germany", source: "Deutsche Bundesbank", freq: "D", histTenor: "10Y" }, { id: "IT", region: "Europe", name: "Italy — 10-year government bond", source: "FRED · OECD", freq: "M", histTenor: "10Y" }] };
// /api/yields?ids=…: the countries asked for, with past curves and spreads (the same shapes the Worker returns)
const IT_M = { id: "IT", name: "Italy — 10-year government bond", kind: "10-year yield, MONTHLY AVERAGE (OECD Main Economic Indicators)", source: "FRED · OECD", sourceUrl: "https://fred.stlouisfed.org/series/IRLTLT01ITM156N", status: "LIVE", timestamp: "2026-08-01", previousDate: "2026-07-01", fetchedAt: new Date().toISOString(), staleAt: new Date(Date.now() + 30 * 864e5).toISOString(), freq: "M", histTenor: "10Y",
  points: [{ tenor: "10Y", months: 120, value: 3.98, status: "LIVE", changeBp: 6 }], past: { "1M": { date: "2026-07-01", points: [{ tenor: "10Y", months: 120, value: 3.92 }] } }, spreads: { DE: { bp: 80.6, date: "2026-08-01" }, US: { bp: -25, date: "2026-08-01" } } };
// /api/yields/market (CNBC quote service through the Worker): a few countries; one maturity with an old quote (STALE)
const qt = (m) => new Date(Date.now() - m * 60e3).toISOString();
const MP = (tenor, months, value, prev, mins = 30) => ({ tenor, months, value, prev, changeBp: Math.round((value - prev) * 1000) / 10, time: qt(mins), status: mins > 5760 ? "STALE" : "LIVE", venue: "Tradeweb", name: tenor + " benchmark", maturity: "2036-08-01", coupon: 3.85 });
const MKT_FIX = () => ({ countries: {
  US: { id: "US", points: [MP("3M", 3, 3.99, 4.01), MP("2Y", 24, 3.512, 3.53), MP("5Y", 60, 3.71, 3.72), MP("10Y", 120, 4.012, 4.03), MP("30Y", 360, 4.61, 4.62)], asOf: qt(30), status: "LIVE" },
  DE: { id: "DE", points: [MP("1Y", 12, 2.31, 2.3), MP("2Y", 24, 2.41, 2.4), MP("10Y", 120, 2.654, 2.66), MP("30Y", 360, 3.21, 3.2)], asOf: qt(30), status: "LIVE" },
  IT: { id: "IT", points: [MP("2Y", 24, 2.7, 2.72), MP("5Y", 60, 3.2, 3.25), MP("10Y", 120, 3.912, 3.95), MP("30Y", 360, 4.6, 4.62)], asOf: qt(30), status: "LIVE" },
  IN: { id: "IN", points: [MP("10Y", 120, 7.392, 7.4), MP("30Y", 360, 7.779, 7.78, 9000)], asOf: qt(30), status: "LIVE" },
}, missing: ["TH"], regions: [["Americas", ["US"]], ["Europe", ["DE", "IT"]], ["Asia-Pacific", ["IN", "TH"]]], catalog: { US: ["3M", "2Y", "5Y", "10Y", "30Y"], DE: ["1Y", "2Y", "10Y", "30Y"], IT: ["2Y", "5Y", "10Y", "30Y"], IN: ["10Y", "30Y"], TH: ["10Y"] },
  source: "CNBC quote service", sourceUrl: "https://www.cnbc.com/bonds/", kind: "market data: last traded / indicative yield as CNBC shows it (intraday), not an official fixing", status: "LIVE", fetchedAt: new Date().toISOString() });
function mktApi(u) {
  const C = MKT_FIX().countries;
  if (u.pathname === "/api/yields/market/past") {
    const one = u.searchParams.get("id"), ids = one ? [one] : (u.searchParams.get("ids") || "").split(","), past = {};
    for (const id of ids) { const c = C[id]; if (!c) continue; const pts = one ? c.points : c.points.filter((p) => p.tenor === "10Y");
      past[id] = { "1W": { date: "2026-10-13", points: pts.map((p) => ({ tenor: p.tenor, months: p.months, value: +(p.value - 0.1).toFixed(3), date: "2026-10-13" })) }, "1M": { date: "2026-09-18", points: pts.map((p) => ({ tenor: p.tenor, months: p.months, value: +(p.value + 0.2).toFixed(3), date: "2026-09-18" })) } }; }
    return { body: { past, errors: {}, source: "CNBC quote service" } };
  }
  if (u.pathname === "/api/yields/market/history") { const pts = []; for (let i = 300; i >= 0; i--) { const d = dShift(today, -i); if (new Date(d + "T12:00:00Z").getUTCDay() % 6) { const id = u.searchParams.get("id"); pts.push([d, +(3.5 + i / 1000 + (id === "IT" ? 1.1 + Math.sin(i / 15) * 0.15 : id === "DE" ? -0.9 : 0)).toFixed(4)]); } } return { body: { id: u.searchParams.get("id"), tenor: u.searchParams.get("tenor"), freq: "D", points: pts, source: "CNBC quote service", status: "LIVE", fetchedAt: new Date().toISOString() } }; }
  return { body: MKT_FIX() };
}
function yieldsIds(u) {
  const ids = (u.searchParams.get("ids") || "").split(","), curves = {}, errors = {};
  for (const id of ids) {
    if (id === "US") curves.US = { ...YIELDS.curves.US, freq: "D", histTenor: "10Y", past: { "1W": { date: "2026-09-29", points: YIELDS.curves.US.points.map((p) => ({ ...p, value: p.value == null ? null : +(p.value - 0.05).toFixed(2) })) }, "1M": { date: "2026-09-04", points: YIELDS.curves.US.points.map((p) => ({ ...p, value: p.value == null ? null : +(p.value - 0.2).toFixed(2) })) } }, spreads: { DE: { bp: 184, date: today } } };
    else if (id === "EA") curves.EA = { ...YIELDS.curves.EA, freq: "D", histTenor: "10Y", past: {}, spreads: {} };
    else if (id === "IT") curves.IT = IT_M;
    else if (id === "DE") errors.DE = { error: "provider_timeout", status: "N/A" };
  }
  return { body: { curves, errors, meta: {} } };
}
const yieldsHistory = (u) => ({ body: { id: u.searchParams.get("id"), tenor: u.searchParams.get("tenor"), freq: "D", points: Array.from({ length: 60 }, (_, i) => [new Date(Date.now() - (60 - i) * 864e5).toISOString().slice(0, 10), +(4 + i / 100).toFixed(2)]), source: "test", status: "LIVE" } });
const NA = (note) => ({ value: null, status: "N/A", note });
const PRESS_FIX = {
  FT: ["Financial Times", "https://www.ft.com/", "Test FT markets headline", "https://www.ft.com/content/test-1", 60_000, "Markets"],
  BLOOMBERG: ["Bloomberg", "https://www.bloomberg.com/", "Test Bloomberg economics headline", "https://www.bloomberg.com/news/articles/test-2", 120_000, "Economics"],
  WSJ: ["The Wall Street Journal", "https://www.wsj.com/", "Test WSJ markets headline", "https://www.wsj.com/finance/test-3", 180_000, "Markets"],
  MARKETWATCH: ["MarketWatch", "https://www.marketwatch.com/", "Test MarketWatch top story", "https://www.marketwatch.com/story/test-4", 240_000, "Top stories"],
  CB: ["Central banks", null, "Test Federal Reserve press release", "https://www.federalreserve.gov/newsevents/pressreleases/test-5.htm", 300_000, "Fed"],
  CNBC: ["CNBC", "https://www.cnbc.com/", "Test CNBC top news headline", "https://www.cnbc.com/2026/10/20/test-6.html", 360_000, "Top news"],
  ECONOMIST: ["The Economist", "https://www.economist.com/", "Test Economist finance headline", "https://www.economist.com/finance-and-economics/test-7", 420_000, "Finance & economics"],
  SOLE: ["Il Sole 24 Ore", "https://www.ilsole24ore.com/", "Test Sole 24 Ore finanza headline", "https://www.ilsole24ore.com/art/test-8", 480_000, "Finanza"],
  REUTERS: ["Reuters", "https://www.reuters.com/", "Test Reuters markets headline", "https://www.reuters.com/markets/test-9-2026-10-20/", 540_000, "Markets"],
};
const PRESS = (src) => { const now = Date.now(), [name, home, title, url, ago, section] = PRESS_FIX[src];
  return { source: src, name, home, status: "LIVE", fetchedAt: new Date(now).toISOString(),
    feeds: [{ section, status: "LIVE", items: 1 }], basis: "publisher's public RSS feed — headline, time and link only (no article text)",
    items: [{ title, url, timestamp: new Date(now - ago).toISOString(), section, source: src === "CB" ? "Federal Reserve" : name, provider: src }] }; };
const CALENDAR = { events: [{ id: "a", datetime: new Date(Date.now() + 2 * 864e5).toISOString(), dateET: "2026-10-14", timeET: "08:30", country: "US", indicator: "Consumer Price Index", source: "BLS", sourceName: "U.S. Bureau of Labor Statistics", sourceUrl: "https://www.bls.gov/schedule/news_release/", released: false, actual: NA("needs FRED API key"), forecast: NA("no licensed consensus source"), previous: NA("needs FRED API key"), importance: NA("no licensed importance rating") }],
  world: [
    { at: -864e5, ccy: "GBP", region: "United Kingdom", ind: "GDP m/m", imp: "High", f: "0.1%", p: "0.0%" },
    { at: 3 * 3600e3, ccy: "EUR", region: "Euro area", ind: "German Ifo Business Climate", imp: "Medium", f: "", p: "87.7" },
    { at: 5 * 3600e3, ccy: "USD", region: "United States", ind: "CPI m/m", imp: "High", f: "0.3%", p: "0.2%" },
  ].map((x, i) => ({ id: "ff" + i, datetime: new Date(Date.now() + x.at).toISOString(), dateET: "2026-10-07", timeET: "08:30", currency: x.ccy, country: x.ccy, region: x.region, indicator: x.ind, impact: x.imp, released: x.at < 0, actual: NA("not in the Forex Factory export"), forecast: x.f ? { value: x.f, status: "LIVE" } : NA("not published"), previous: { value: x.p, status: "LIVE" }, source: "FF", sourceName: "Forex Factory", sourceUrl: "https://www.forexfactory.com/calendar" })),
  sources: [{ id: "FF", name: "Forex Factory", url: "https://www.forexfactory.com/calendar", status: "LIVE", fetchedAt: new Date().toISOString() }, { id: "BLS", name: "U.S. Bureau of Labor Statistics", url: "https://www.bls.gov/schedule/news_release/", status: "LIVE", fetchedAt: new Date().toISOString() }, { id: "BEA", name: "U.S. Bureau of Economic Analysis", url: "https://www.bea.gov/news/schedule", status: "LIVE", fetchedAt: new Date().toISOString() }], errors: {} };
const NEWS = {
  filings: [{ ticker: "AAPL", company: "Apple Inc.", form: "8-K", description: "8-K", filingDate: today, timestamp: new Date().toISOString(), url: "https://www.sec.gov/Archives/edgar/data/320193/x/aapl-8k.htm", provider: "SEC EDGAR" }],
  sources: [{ id: "SEC", name: "SEC EDGAR", url: "https://www.sec.gov/edgar/search/", status: "LIVE", fetchedAt: new Date().toISOString() }], errors: {} };
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
const CTRY_ITEMS = [{ sym: "EWI", name: "Italy — iShares MSCI Italy (EWI)", sector: "Europe", short: "ITALY", weight: null }, { sym: "EWJ", name: "Japan — iShares MSCI Japan (EWJ)", sector: "Asia-Pacific", short: "JAPAN", weight: null }];
const spxApi = (path, u, { configured = true } = {}) => {
  const now = new Date().toISOString();
  if (u.searchParams.get("u") === "ETF") {
    if (path === "/api/spx/universe") return { body: { universe: "ETF", source: "ETFs by asset class (fixed list)", count: 3, items: [{ sym: "SPY", name: "SPDR S&P 500 (SPY)", sector: "US equity", short: "SPY", weight: null }, { sym: "TLT", name: "iShares 20+ Year Treasury (TLT)", sector: "Treasuries", short: "TLT", weight: null }, { sym: "HYG", name: "iShares High Yield Corporate (HYG)", sector: "Credit and aggregate", short: "HYG", weight: null }], fetchedAt: now, status: "LIVE" } };
    if (path === "/api/spx/live") return { body: { universe: "ETF", trades: { SPY: [671.2, now], TLT: [88.4, now], HYG: [80.1, now] }, live: true, todayET: ET, fetchedAt: now, status: "LIVE" } };
    return { body: { universe: "ETF", ref: "recent", todayET: ET, todayBarFinal: false, closes: { SPY: [[dShift(ET, -2), 660], [dShift(ET, -1), 668, 4e10]], TLT: [[dShift(ET, -2), 89], [dShift(ET, -1), 89.3, 2e9]], HYG: [[dShift(ET, -2), 80], [dShift(ET, -1), 80.1, 1e9]] }, fetchedAt: now, status: "LIVE" } };
  }
  if (u.searchParams.get("u") === "CRYPTO") {
    if (path === "/api/spx/universe") return { body: { universe: "CRYPTO", source: "Alpaca crypto USD pairs (fixed list)", count: 2, items: [{ sym: "BTC/USD", name: "BTC / US dollar", sector: "Crypto", short: "BTC", weight: null }, { sym: "ETH/USD", name: "ETH / US dollar", sector: "Crypto", short: "ETH", weight: null }], fetchedAt: now, status: "LIVE" } };
    if (path === "/api/spx/live") return { body: { universe: "CRYPTO", trades: { "BTC/USD": [86000, now], "ETH/USD": [2650, now] }, live: true, todayET: ET, fetchedAt: now, status: "LIVE" } };
    return { body: { universe: "CRYPTO", ref: "recent", todayET: ET, closes: { "BTC/USD": [[dShift(ET, -2), 84000, 9e8], [dShift(ET, -1), 85000, 1.2e9]], "ETH/USD": [[dShift(ET, -2), 2700, 4e8], [dShift(ET, -1), 2600, 5e8]] }, fetchedAt: now, status: "LIVE" } };
  }
  if (u.searchParams.get("u") === "CTRY") {
    if (path === "/api/spx/universe") return { body: { universe: "CTRY", label: "Countries", source: "single-country ETFs listed in New York (fixed list)", weightBasis: "none", holdingsAsOf: null, count: 2, items: CTRY_ITEMS, fetchedAt: now, status: "LIVE" } };
    if (path === "/api/spx/live") return { body: { universe: "CTRY", trades: { EWI: [50.5, now], EWJ: [70, now] }, live: true, todayET: ET, fetchedAt: now, status: "LIVE" } };
    return { body: { universe: "CTRY", ref: "recent", todayET: ET, todayBarFinal: false, closes: { EWI: [[dShift(ET, -2), 49], [dShift(ET, -1), 50, 120000000]], EWJ: [[dShift(ET, -2), 71], [dShift(ET, -1), 70.7, 900000000]] }, fetchedAt: now, status: "LIVE" } };
  }
  if (path === "/api/spx/universe") return { body: { source: "iShares Core S&P 500 ETF (IVV) — daily holdings", sourceUrl: "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf", holdingsAsOf: dShift(ET, -1), count: SPX_ITEMS.length, items: SPX_ITEMS, fetchedAt: now, status: "LIVE" } };
  if (!configured) return { status: 503, body: { error: "alpaca_not_configured", status: "N/A" } };
  if (path === "/api/spx/live") return { body: { trades: Object.fromEntries(Object.entries(SPX_LIVE).map(([k, v]) => [k, [v, now]])), live: true, todayET: ET, fetchedAt: now, status: "LIVE" } };
  const ref = u.searchParams.get("ref");
  if (ref === "recent") return { body: { ref, todayET: ET, todayBarFinal: false, closes: Object.fromEntries(Object.entries(SPX_PREV).map(([k, v]) => [k, [[dShift(ET, -2), v * 0.98], [dShift(ET, -1), v]]])), fetchedAt: now, status: "LIVE" } };
  return { body: { ref, target: dShift(ET, -30), todayET: ET, closes: Object.fromEntries(Object.entries(SPX_PREV).map(([k, v]) => [k, [dShift(ET, -31), v * 0.9]])), fetchedAt: now, status: "LIVE" } };
};

// market reaction after the released GBP event (shape of /api/calendar/reactions)
const CAL_REACT = () => ({ reactions: { ff0: { id: "ff0", at: new Date().toISOString(), final: true, items: [{ symbol: "GBP vs USD", pair: "GBP/USD", source: "Twelve Data 1-min", before: 1.3, m15: { price: 1.30195, chg: 0.15 }, m60: { price: 1.30403, chg: 0.31 } }] } }, pending: 0, status: "DERIVED" });
// exchanges (shape of /api/exchanges): London open, New York and Tokyo closed
const EXCH = () => { const now = Date.now(); return { exchanges: [
  { code: "XNYS", name: "New York Stock Exchange", country: "United States", open: false, openedAt: null, closesAt: null, opensAt: now + 2 * 3600e3 + 9e5, major: true, label: "NYSE", city: "New York", tz: "America/New_York", region: "Americas" },
  { code: "XLON", name: "London Stock Exchange", country: "United Kingdom", open: true, openedAt: now - 5 * 3600e3, closesAt: now + 3 * 3600e3 + 18e5, opensAt: null, major: true, label: "LSE", city: "London", tz: "Europe/London", region: "Europe & Africa" },
  { code: "XJPX", name: "Japan Exchange Group", country: "Japan", open: false, openedAt: null, closesAt: null, opensAt: now + 14 * 3600e3, major: true, label: "JPX", city: "Tokyo", tz: "Asia/Tokyo", region: "Asia-Pacific" },
  { code: "XOTH", name: "Other Exchange", country: "Nowhere", open: true, openedAt: now - 3600e3, closesAt: now + 3600e3, opensAt: null, major: false, label: null, city: null, tz: null, region: null },
], count: 4, majorOpen: 1, majorCount: 3, missingMajor: ["XNAS"], fetchedAt: new Date(now).toISOString(), source: "Twelve Data — market_state (holidays and early closes included)", status: "LIVE" }; };
// portfolio API: the real position logic (src/portfolio.mjs) over an in-memory store; ECB USD rate 1.10 per EUR
const PF_SERIES = { USD: [["2020-01-01", 1.1]] };
const pfApi = (u, method, body, state) => {
  const view = () => { const b = buildPositions(state.tx, PF_SERIES); return { baseCurrency: "EUR", transactions: state.tx.slice().reverse(), positions: b.positions, realized: b.realized, error: b.error || null, costBasis: { method: "average cost", currencies: ["USD"], fx: { source: "ECB euro reference rates (ECB Data Portal, EXR)", status: "LIVE", missing: [] } } }; };
  if (u.pathname === "/api/portfolio") return { body: view() };
  if (method === "POST") { state.posts.push(body); const v = validateTx(body, "2099-12-31"); if (typeof v === "string") return { status: 400, body: { error: "bad_request", message: v } }; state.tx.push({ id: "t" + state.tx.length, ...v, created: Date.now() }); return { status: 201, body: view() }; }
  if (method === "DELETE") { const id = u.searchParams.get("id"); state.deletes.push(id); state.tx = state.tx.filter((t) => t.id !== id); return { body: view() }; }
  return { status: 405, body: { error: "method_not_allowed" } };
};

// briefing archive fixtures (shape of /api/briefs responses)
const BRF_TODAY = new Date().toISOString().slice(0, 10), BRF_PREV = dShift(BRF_TODAY, -1);
const BRIEF_ITEM = (id, d, title) => ({ id, period: "daily", d, title, created: Math.floor(Date.now() / 1000) - 600, n: 400, status: "DERIVED", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "Cloudflare Workers AI",
  body: "## In one line\nS&P 500 constituents rose 0.41% on an IVV-weighted basis.\n## Equities\n`NVDA` added 0.14% while `XYZ` is not a chip. [FT](https://www.ft.com/content/test-1)\n## Rates and currencies\n`EUR/USD` fell 0.52%.\n## Commodities and crypto\nData is not available.\n## Today\n- Consumer Price Index at 08:30 ET.",
  verification: { checked: 3, unverified: [], removedLinks: [], missingSections: [] }, symbols: ["NVDA", "EUR/USD"],
  windows: [
    { type: "MAP", state: { u: "SPX", metric: "1D", size: "weight", view: "map" }, section: 1, sectionName: "Equities", sectionName_it: "Azioni", label: "S&P 500 heat map · 1D", why: "Constituents +0.41% (IVV-weighted): 7 up, 4 down — where the moves were, by sector and weight.", label_it: "Heat map S&P 500 · 1D", why_it: "Componenti +0.41% (ponderati IVV): 7 in rialzo, 4 in calo — dove sono stati i movimenti, per settore e peso." },
    { type: "GP", state: { ticker: "NVDA", tf: "1W" }, section: 1, sectionName: "Equities", sectionName_it: "Azioni", label: "NVDA · biggest gain", why: "NVIDIA: +2.00%, the largest rise among the constituents.", label_it: "NVDA · rialzo maggiore", why_it: "NVIDIA: +2.00%, il rialzo più forte tra i componenti." },
    { type: "YLD", state: {}, section: 2, sectionName: "Rates and currencies", sectionName_it: "Tassi e valute", label: "Yield curves vs previous publication", why: "US 10Y 4.24% (+2.0 bp) — the dashed line is the previous curve.", label_it: "Curve dei rendimenti contro la pubblicazione precedente", why_it: "USA 10Y 4.24% (+2.0 bp) — la linea tratteggiata è la curva precedente." },
    { type: "CAL", state: { view: "world", ev: "ff2" }, section: 4, sectionName: "Today", sectionName_it: "Oggi", label: "USD CPI m/m · today", why: "United States CPI m/m, forecast 0.3%, previous 0.2%: the first high-impact release ahead — opened with its past releases.", label_it: "USD CPI m/m · oggi", why_it: "CPI m/m, previsto 0.3%, precedente 0.2%: la prima uscita ad alto impatto in arrivo." }],
  sources: [{ name: "European Central Bank", timestamp: BRF_TODAY, url: "https://data.ecb.europa.eu/x" }], inputData: "EQUITY S&P 500 constituents ... +0.41%", disclaimer: "AI-written summary of the real data listed below. Not investment advice." });
const briefsApi = (u, method, state) => {
  if (u.pathname === "/api/briefs/write") { state.writes.push(u.search); state.written = true; return { status: 201, body: BRIEF_ITEM(`daily-${BRF_TODAY}`, BRF_TODAY, "Constituents edge up while the euro slips") }; }
  if (u.pathname === "/api/briefs/lang") { state.langPosts = (state.langPosts || 0) + 1; state.itWritten = true; const id = u.searchParams.get("id"); return { status: 201, body: { ...BRIEF_ITEM(id, id.slice(6), "Edizione di ieri"), lang: "it", body: "## In una riga\nL'euro è sceso dello 0.52%.\n## Azioni\nDati non disponibili." } }; }
  if (u.pathname === "/api/briefs/item") { const id = u.searchParams.get("id"), it = u.searchParams.get("lang") === "it", today = id.endsWith(BRF_TODAY);
    if (it && (today || state.itWritten)) return { body: { ...BRIEF_ITEM(id, id.slice(6), today ? "I componenti salgono mentre l'euro cede" : "Edizione di ieri"), lang: "it", body: "## In una riga\nI componenti dell'S&P 500 sono saliti dello 0.41%.\n## Azioni\n`NVDA` è salito dello 0.14%.\n## Tassi e valute\n`EUR/USD` è sceso dello 0.52%.\n## Materie prime e cripto\nDati non disponibili.\n## Oggi\n- Consumer Price Index alle 08:30 ET.", disclaimer: "Sintesi scritta dall'AI dai dati reali elencati sotto. Non è una consulenza finanziaria." } };
    return { body: { ...BRIEF_ITEM(id, id.slice(6), today ? "Constituents edge up while the euro slips" : "Yesterday's edition"), lang: "en", ...(it ? { langMissing: "it" } : {}) } }; }
  const period = u.searchParams.get("period");
  const list = period === "daily" ? [...(state.written ? [{ id: `daily-${BRF_TODAY}`, period, d: BRF_TODAY, title: "Constituents edge up while the euro slips", created: 1, n: 400 }] : []), { id: `daily-${BRF_PREV}`, period, d: BRF_PREV, title: "Yesterday's edition", created: 1, n: 400 }] : [];
  return { body: { period, label: period[0].toUpperCase() + period.slice(1), schedule: period === "weekly" ? "Written automatically on Saturday mornings at 08:00 (Rome time)." : "Written automatically on weekday mornings at 07:30 (Rome time).", chipTf: "1W",
    // daily: due, scheduled window over (the terminal writes it); evening: the scheduled run is writing it now
    due: period === "daily" ? { id: `daily-${BRF_TODAY}`, d: BRF_TODAY, writable: true } : period === "evening" ? { id: `evening-${BRF_TODAY}`, d: BRF_TODAY, writable: true, auto: { writeAt: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 10 * 60_000).toISOString() } } : null,
    dueWritten: period === "daily" ? !!state.written : false, briefs: list, automatic: { lastRun: new Date(Date.now() - 15 * 60_000).toISOString() } } };
};


// ---------- T07 function menu fixtures (shapes of /api/cb, /api/sprd, /api/energy, /api/earnings, /api/des, /api/options, /api/user, /api/status) ----------
const T7_NOW = () => new Date().toISOString();
const CB_FIX = () => ({ banks: [
  { id: "ECB", name: "European Central Bank", ccy: "EUR", page: "https://www.ecb.europa.eu/x", rate: { date: "2026-10-06", value: 2, previous: 2.25, changedOn: "2026-06-11" }, label: "Deposit facility rate", others: { "Main refinancing operations": { date: "2026-10-06", value: 2.15, previous: 2.4, changedOn: "2026-06-11" } }, status: "LIVE", fetchedAt: T7_NOW() },
  { id: "FED", name: "Federal Reserve", ccy: "USD", page: "https://www.newyorkfed.org/x", rate: { date: "2026-10-06", value: 3.58 }, label: "Effective federal funds rate", target: { from: 3.5, to: 3.75, previous: { from: 3.75, to: 4 }, changedOn: "2026-09-18" }, status: "LIVE", fetchedAt: T7_NOW() },
  { id: "BOE", name: "Bank of England", ccy: "GBP", page: "https://www.bankofengland.co.uk/x", rate: { date: "2026-10-06", value: 3.75, previous: 4, changedOn: "2026-08-07" }, label: "Bank Rate", status: "LIVE", fetchedAt: T7_NOW() },
  { id: "SNB", name: "Swiss National Bank", ccy: "CHF", page: "https://data.snb.ch/x", status: "N/A", error: "provider_error" },
  { id: "BOC", name: "Bank of Canada", ccy: "CAD", page: "https://www.bankofcanada.ca/x", rate: { date: "2026-10-06", value: 2.5, previous: null, changedOn: null, unchangedSince: "2023-10-06" }, label: "Target for the overnight rate", status: "LIVE", fetchedAt: T7_NOW() },
], note: "x", status: "LIVE" });
const SPRD_FIX = () => { const pts = []; for (let i = 0; i < 260; i++) { const d = dShift(today, i - 260); pts.push({ date: d, y2: 1.9, y10: 2.5 + i / 1000, bp: Math.round((0.6 + i / 1000) * 1000) / 10 }); }
  return { series: { EA: { name: "Euro area", source: "European Central Bank", sourceUrl: "https://data.ecb.europa.eu/data/datasets/YC", points: pts, status: "LIVE", fetchedAt: T7_NOW() }, US: { status: "N/A", error: "needs a FRED API key" } }, basis: "x" }; };
const hist = (base, n) => Array.from({ length: n }, (_, i) => [dShift(today, i - n - 6), +(base + i / 10).toFixed(2)]);
const ENERGY_FIX = () => ({ spot: [
  { series: "RWTC", name: "WTI crude (Cushing)", unit: "$/bbl", date: dShift(today, -7), value: 62.31, chg1: 0.4, chg5: -1.2, chg21: 2.5, history: hist(60, 80) },
  { series: "RBRTE", name: "Brent crude (Europe)", unit: "$/bbl", status: "N/A" },
  { series: "RNGWHHD", name: "Natural gas (Henry Hub)", unit: "$/MMBtu", date: dShift(today, -7), value: 2.871, chg1: -0.5, chg5: 1.1, chg21: -3.2, history: hist(2.5, 80) },
], futures: { status: "N/A", error: "source_discontinued", lastDate: "2024-04-05" }, source: "EIA", sourceUrl: "https://www.eia.gov/opendata/", status: "LIVE" });
// /api/energy/stocks as the Worker shapes it (levels in display units; w/w, vs a year ago, vs the 5-year average DERIVED)
const invHist = (base, step) => Array.from({ length: 60 }, (_, i) => [dShift(today, -7 * (60 - i) - 5), +(base + step * i).toFixed(3)]);
const STOCKS_FIX = () => ({ rows: [
  { series: "WCESTUS1", name: "Crude oil (excl. SPR)", unit: "M bbl", kind: "stock", date: dShift(today, -5), value: 409.2, chgWeek: 3.2, vsYearAgo: 4.2, yearAgoDate: dShift(today, -369), avg5: 403, vsAvg5Pct: 1.5, history: invHist(400, 0.15) },
  { series: "W_EPC0_SAX_YCUOK_MBBL", name: "Crude oil at Cushing, OK", unit: "M bbl", kind: "stock", date: dShift(today, -5), value: 22.4, chgWeek: -0.7, vsYearAgo: -1.1, avg5: 33.6, vsAvg5Pct: -33.3, history: invHist(25, -0.04) },
  { series: "WKJSTUS1", name: "Jet fuel (kerosene-type)", unit: "M bbl", status: "N/A", error: "source_discontinued", lastDate: "2026-08-07" },
  { series: "NW2_EPG0_SWO_R48_BCF", name: "Natural gas in storage (Lower 48)", unit: "Bcf", kind: "stock", date: dShift(today, -4), value: 3712, chgWeek: 87, vsYearAgo: 101, avg5: 3650, vsAvg5Pct: 1.7, history: invHist(3000, 12) },
  { series: "WPULEUS3", name: "Refinery utilization", unit: "%", kind: "rate", date: dShift(today, -5), value: 89.6, chgWeek: -1.2, vsYearAgo: 0.4, avg5: 88.1, vsAvg5Pct: null, history: invHist(90, 0) },
], errors: {}, source: "U.S. Energy Information Administration (EIA)", sourceUrl: "https://www.eia.gov/petroleum/supply/weekly/", basis: "DERIVED", status: "LIVE" });
const ERN_FIX = () => ({ from: dShift(today, -4), to: dShift(today, 12), today, count: 3, rows: [
  { sym: "JPM", name: "JPMORGAN CHASE & CO", weight: 1.5, index: ["S&P 500"], date: dShift(today, -1), hour: "before open", quarter: "Q3 2026", epsEstimate: 4.9, epsActual: 5.39, revenueEstimate: 4.6e10, revenueActual: 4.7e10 },
  { sym: "NFLX", name: "NETFLIX INC", weight: 0.9, index: ["S&P 500", "Nasdaq-100"], date: dShift(today, 2), hour: "after close", quarter: "Q3 2026", epsEstimate: 6.9, epsActual: null, revenueEstimate: 1.1e10, revenueActual: null },
  { sym: "TINYCO", name: "SMALL CO", weight: 0.01, index: ["S&P 500"], date: dShift(today, 3), hour: null, quarter: "Q3 2026", epsEstimate: 0.1, epsActual: null, revenueEstimate: null, revenueActual: null },
], status: "LIVE", fetchedAt: T7_NOW() });
const DES_PROFILE = { name: "Apple Inc.", cik: 320193, tickers: ["AAPL"], exchanges: ["Nasdaq"], sic: "3571", industry: "Electronic Computers", category: "Large accelerated filer", stateOfIncorporation: "CA", fiscalYearEnd: "0927", address: "ONE APPLE PARK WAY, CUPERTINO, CA, 95014", phone: "(408) 996-1010", website: null, formerNames: [], filings: [{ form: "10-K", date: "2025-10-31", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm" }] };
const FACT = (label, unit, annual, prev, q, extra = {}) => ({ label, unit, annual: annual != null ? { value: annual, end: "2025-09-27", form: "10-K", filed: "2025-10-31" } : null, prevAnnual: prev != null ? { value: prev, end: "2024-09-28", form: "10-K", filed: "2024-11-01" } : null, quarter: q != null ? { value: q, end: "2025-06-28", form: "10-Q", filed: "2025-08-01" } : null, latest: { value: annual ?? q, end: "2025-10-17", form: "10-K", filed: "2025-10-31" }, concept: "us-gaap:x", status: "LIVE", ...extra });
const DES_FACTS = { revenue: FACT("Revenue", "USD", 416161e6, 391035e6, 94036e6), netIncome: FACT("Net income", "USD", 112010e6, 93736e6, 23434e6), eps: FACT("EPS (diluted)", "USD/shares", 6.25, 6.08, 1.57), assets: FACT("Total assets", "USD", 359241e6, 364980e6, null), equity: FACT("Shareholders' equity", "USD", 73733e6, 56950e6, null), shares: FACT("Shares outstanding", "shares", null, null, null, { latest: { value: 14.8e9, end: "2025-10-17", form: "10-K", filed: "2025-10-31" } }) };
const OPT_EXP = () => ({ symbol: "AAPL", spot: { price: 251.2, time: T7_NOW() }, expirations: [{ exp: dShift(today, 9), contractsNearSpot: 40 }, { exp: dShift(today, 37), contractsNearSpot: 36 }], status: "LIVE" });
const OPT_CHAIN = (exp) => ({ symbol: "AAPL", exp, spot: { price: 251.2, time: T7_NOW() }, rows: [240, 250, 260].map((k) => ({ strike: k, call: { bid: +(14 - (k - 240) / 2).toFixed(2), ask: +(14.3 - (k - 240) / 2).toFixed(2), last: +(14.1 - (k - 240) / 2).toFixed(2), iv: 0.27, delta: +(0.7 - (k - 240) / 50).toFixed(2), oi: 1200 }, put: { bid: +(3 + (k - 240) / 2).toFixed(2), ask: +(3.2 + (k - 240) / 2).toFixed(2), last: null, iv: 0.29, delta: +(-0.3 - (k - 240) / 50).toFixed(2), oi: 800 } })), feed: "Alpaca indicative options feed (free; derived from OPRA, delayed) — not the consolidated quote", fetchedAt: T7_NOW(), status: "LIVE" });
const STATUS_FIX = () => ({ sources: [{ id: "twelvedata", name: "Twelve Data", use: "quotes", configured: true }, { id: "finnhub", name: "Finnhub", use: "earnings calendar (ERN)", configured: false }, { id: "eia", name: "U.S. EIA", use: "energy", configured: true }], twelvedata: { minute: { used: 3, limit: 8 }, day: { used: 120, limit: 800 }, plan: "basic", fetchedAt: T7_NOW(), status: "LIVE" }, scheduler: { lastRun: { at: T7_NOW(), periods: ["daily"] }, schedule: "Cron Triggers" }, serverTime: T7_NOW() });
const TN = (v, d1, w1, m1, note) => ({ value: v, d1, w1, m1, date: today, ...(note ? { note } : {}) });
const BONDS_FIX = (noFred) => ({ tenors: ["2Y", "5Y", "10Y", "20Y", "30Y"], notConnected: ["Italy", "France"], spreads: [{ id: "UK", tenor: "10Y", bp: 184, date: today }],
  countries: [
    { id: "US", name: "United States — Treasury constant maturity", kind: "constant-maturity yield (Federal Reserve H.15), daily", source: "FRED · Federal Reserve H.15", sourceUrl: "https://fred.stlouisfed.org/x", date: today, status: "LIVE", tenors: { "2Y": TN(3.6, 1, 5, -10), "10Y": TN(4.13, 3, 8, 12), "30Y": TN(4.7, 2, 6, 9) } },
    { id: "DE", name: "Germany — Federal securities (Bunds)", kind: "yield from the term structure (Svensson), daily", source: "Deutsche Bundesbank", sourceUrl: "https://www.bundesbank.de/x", date: today, status: "LIVE", tenors: { "2Y": TN(3.06, -2, 4, 11), "10Y": TN(3.52, 3, 8, 22), "30Y": TN(3.86, 4, 9, 20) } },
    { id: "UK", name: "United Kingdom — gilts", kind: "nominal par yield (fitted curve), daily", source: "Bank of England", sourceUrl: "https://www.bankofengland.co.uk/x", date: today, status: "LIVE", tenors: { "5Y": TN(4.93, 4, 10, 15), "10Y": TN(5.36, 3, 7, 19), "20Y": TN(5.74, 5, 9, 25) } },
    { id: "CH", name: "Switzerland — Confederation bonds", kind: "yield of the Confederation bond nearest each maturity", source: "Swiss National Bank", sourceUrl: "https://data.snb.ch/x", date: dShift(today, -7), status: "LIVE", tenors: { "10Y": TN(0.71, null, 2, 5, "Confederation bond V13_1, 9.6 years to maturity") } },
    { id: "CA", name: "Canada — benchmark bonds", source: "Bank of Canada", sourceUrl: "https://www.bankofcanada.ca/x", status: "N/A", error: "provider_timeout" }],
  fred: noFred ? { status: "N/A", error: "fred_not_configured" } : { status: "LIVE", source: "FRED", groups: [{ group: "Inflation", rows: [{ id: "T10YIE", name: "10-year breakeven inflation", unit: "%", value: 2.31, d1: 1, w1: -2, m1: 5, date: today, status: "LIVE" }] }, { group: "Credit", rows: [{ id: "BAMLH0A0HYM2", name: "US high yield — option-adjusted spread (ICE BofA)", unit: "bp", value: 3.05, d1: 5, w1: 12, m1: -20, date: today, status: "LIVE" }] }] } });
const COT_FIX = () => ({ report: "Commitments of Traders — legacy, futures only", source: "U.S. Commodity Futures Trading Commission", sourceUrl: "https://www.cftc.gov/x", status: "LIVE", contracts: [
  { code: "13874A", name: "E-mini S&P 500", group: "Equity indices", root: "ES", date: "2026-09-29", oi: 1895922, long: 209587, short: 352086, net: -142499, commNet: 35281, chg1w: -9271, chg4w: 12000, netPctOi: -7.5, range: { weeks: 26, min: -200000, max: -100000, pos: 58 }, history: [-150000, -140000, -133228, -142499] },
  { code: "088691", name: "Gold", group: "Metals", root: "GC", date: "2026-09-29", oi: 406456, long: 249736, short: 31104, net: 218632, commNet: -250967, chg1w: -7221, chg4w: 5000, netPctOi: 53.8, range: { weeks: 26, min: 150000, max: 230000, pos: 86 }, history: [210000, 225853, 218632] },
  { code: "133741", name: "Bitcoin", group: "Crypto", root: "BTC", status: "N/A" }] });
// indices: Cboe-style delayed rows, STOXX / Nikkei / FRED closes; histories are straight lines so 1M / YTD are checkable
const IDX_DAYS = (n) => { const out = []; for (let i = 1; out.length < n; i++) { const d = dShift(today, -i), w = new Date(d + "T12:00:00Z").getUTCDay(); if (w % 6) out.push(d); } return out.reverse(); };
const IDX_ROW = (id, name, g, last, pct, kind, extra = {}) => ({ id, name, group: g, last, prev: +(last / (1 + pct / 100)).toFixed(2), chg: +(last - last / (1 + pct / 100)).toFixed(2), chgPct: pct, open: null, high: null, low: null, date: kind === "delayed" ? today : dShift(today, -1), asOf: kind === "delayed" ? new Date(Date.now() - 16 * 60e3).toISOString() : null, kind, delayMin: kind === "delayed" ? 15 : null, source: kind === "delayed" ? "Cboe (15-min delayed)" : "STOXX (daily close)", sourceUrl: "https://www.cboe.com/us/indices/", status: "LIVE", fetchedAt: T7_NOW(), ...extra });
const IDX_FIX = (g) => ({ group: g, status: "LIVE", indices: {
  us: [IDX_ROW("SPX", "S&P 500", "us", 7800.12, -0.24, "delayed", { open: 7792.98, high: 7804.32, low: 7763.34 }), IDX_ROW("DJI", "Dow Jones Industrial Average", "us", 51215, -0.59, "delayed", { status: "DERIVED", note: "Cboe DJX (1/100 of the DJIA) × 100, ±0.5 point" }), IDX_ROW("COMP", "Nasdaq Composite", "us", 27599.89, 0.45, "close", { source: "FRED · Nasdaq (daily close)" }), { id: "RUT", name: "Russell 2000", group: "us", source: "Cboe (15-min delayed)", status: "N/A", error: "provider_timeout" }],
  eu: [IDX_ROW("SX5E", "EURO STOXX 50", "eu", 6180.29, -1.47, "close"), IDX_ROW("DAX", "DAX", "eu", 25104.36, -1.36, "close"), IDX_ROW("SMI", "Swiss Market Index (SMI)", "eu", 14478.37, 0.76, "delayed", { source: "SIX (15-min delayed)" })],
  vol: [], sec: [IDX_ROW("SX7P", "STOXX Europe 600 Banks", "sec", 391.61, -0.44, "close")], sec2: [],
  asia: [IDX_ROW("N225", "Nikkei 225", "asia", 70035.71, -0.92, "close", { source: "Nikkei Inc. (daily)" }), IDX_ROW("XJO", "S&P/ASX 200", "asia", 8816.9, -0.33, "delayed", { status: "PARTIAL", asOf: null, date: null, delayMin: 20, note: "ASX publishes no time for this value", source: "ASX (≥20-min delayed, no time)" }),
    IDX_ROW("SHCOMP", "SSE Composite", "asia", 3735.37, 0.12, "delayed", { delayMin: null, source: "Shanghai Stock Exchange (delayed)" })],
  world: [IDX_ROW("IBOV", "Ibovespa", "world", 207939.03, 1.39, "close", { source: "B3 (daily close)" }), IDX_ROW("DXY", "U.S. Dollar Index (DXY)", "world", 98.765, -0.21, "delayed", { source: "CNBC quote service" })] }[g],
  notConnected: { us: [], vol: [], sec: [], sec2: [], eu: [{ id: "UKX", name: "FTSE 100" }, { id: "CAC", name: "CAC 40" }, { id: "FTSEMIB", name: "FTSE MIB" }], asia: [{ id: "HSI", name: "Hang Seng", reason: "no free official source" }, { id: "KOSPI", name: "KOSPI", reason: "no free official source" }, { id: "NIFTY", name: "Nifty 50", reason: "NSE refuses requests from the server (checked 20 Oct 2026)" }], world: [{ id: "TSX", name: "S&P/TSX Composite" }] }[g] });
// SPX: 420 sessions rising by 1 point a day to 7,700 (OHLC); DAX: 64 STOXX closes (close only)
const IDX_HIST = (id) => { const eu = id === "SX5E" || id === "DAX", n = eu ? 64 : 420, ds = IDX_DAYS(n), end = { SPX: 7700, DJI: 51000, COMP: 27500, SX5E: 6100, DAX: 25000, N225: 70000 }[id] || 1000;
  const pts = ds.map((d, i) => { const c = end - (n - 1 - i); return eu ? [d, c] : [d, c - 2, c + 5, c - 6, c]; });
  return { id, name: id, source: eu ? "STOXX (daily close)" : "Cboe (daily history)", sourceUrl: "https://www.stoxx.com/", note: eu ? "STOXX publishes the last 3 months for free" : null, fields: eu ? "close" : "ohlc", points: pts, from: pts[0][0], to: pts[pts.length - 1][0], count: pts.length, status: "LIVE", fetchedAt: T7_NOW() }; };
const indicesApi = (u) => u.pathname === "/api/indices/history" ? { body: IDX_HIST(u.searchParams.get("id")) } : { body: IDX_FIX(u.searchParams.get("g")) };
// markets board extras: ECB fixing (units per euro, two days) and IMF monthly prices
const MKT_FX_FIX = () => ({ base: "EUR", status: "LIVE", source: "ECB euro reference rates (ECB Data Portal, EXR)", rates: [["USD", 1.1177, 1.1269], ["GBP", 0.84645, 0.8488], ["JPY", 176.85, 178.15], ["CHF", 0.9309, 0.9359], ["CAD", 1.5, 1.51], ["AUD", 1.7, 1.69], ["NZD", 1.9, 1.91], ["CNY", 7.9, 7.95]].map(([ccy, v, p]) => ({ ccy, date: dShift(today, -1), eurRate: v, prevDate: dShift(today, -2), prevRate: p })).concat([{ ccy: "TRY", status: "N/A", error: "no_data" }]) });
const MKT_CMDTY_FIX = () => ({ status: "LIVE", source: "IMF Primary Commodity Prices (via FRED)", rows: [
  { id: "PCOPPUSDM", name: "Copper", unit: "$/t", group: "Metals", freq: "M", date: "2026-07-01", value: 13542.82, prevDate: "2026-06-01", prev: 13552, chgPct: -0.068, yoyPct: 12.5 },
  { id: "PWHEAMTUSDM", name: "Wheat", unit: "$/t", group: "Agriculture", freq: "M", date: "2026-07-01", value: 228.74, prevDate: "2026-06-01", prev: 199.65, chgPct: 14.5709, yoyPct: null },
  { id: "PCOCOUSDM", name: "Cocoa", unit: "$/t", group: "Agriculture", status: "N/A", error: "no_data" }] });
const marketsApi = (u) => u.pathname === "/api/markets/fx" ? { body: MKT_FX_FIX() } : { body: MKT_CMDTY_FIX() };
const CBW_FIX = () => ({ banks: [
  { id: "US", name: "Federal Reserve", region: "Americas", ccy: "USD", mkt: "US", date: "2026-10-13", value: 3.875, move: { date: "2026-09-17", from: 4.125, bp: -25 }, chg12: { bp: -50, from: 4.375, date: "2025-10-13" }, moves12: 2, note: "mid-point of the FOMC target range", status: "LIVE", next: { date: dShift(today, 8), time: "14:00 Washington", source: "Federal Reserve — FOMC meeting calendar", url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", checked: "2026-10-20" } },
  { id: "XM", name: "European Central Bank", region: "Europe", ccy: "EUR", mkt: "DE", date: "2026-10-13", value: 2.5, move: { date: "2026-09-16", from: 2.25, bp: 25 }, chg12: { bp: 50, from: 2, date: "2025-10-13" }, moves12: 2, note: "the deposit facility rate now; the main refinancing rate in earlier years", status: "LIVE", next: { date: null, source: "European Central Bank", url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html", checked: "2026-10-20", note: "no later date in the calendar published by the bank" } },
  { id: "AR", name: "Banco Central de la República Argentina", region: "Americas", ccy: "ARS", mkt: null, value: 29, date: "2025-06", freq: "M", status: "STALE", note: "end-of-month series only (no recent daily data from the BIS)", next: null },
  { id: "NO", name: "Norges Bank", region: "Europe", ccy: "NOK", mkt: null, status: "N/A", error: "no_data", next: null },
  { id: "JP", name: "Bank of Japan", region: "Asia-Pacific", ccy: "JPY", mkt: "JP", date: "2026-10-13", value: 1.25, move: { month: "2026-07", from: 1, bp: 25 }, status: "LIVE", next: null },
], source: "BIS — central bank policy rates (WS_CBPOL)", sourceUrl: "https://data.bis.org/topics/CBPOL", fetchedAt: new Date().toISOString() });
const t07Api = (u, method, body, st) => {
  const p = u.pathname; st.calls.push(method + " " + p + u.search);
  if (p === "/api/cb") return { body: CB_FIX() };
  if (p === "/api/cb/world") return { body: CBW_FIX() };
  if (p === "/api/cb/history") return { body: { series: Object.fromEntries((u.searchParams.get("ids") || "").split(",").filter((id) => ["US", "XM", "GB", "JP"].includes(id)).map((id, k) => [id, ["2006-01", "2006-02", "2020-03", "2025-09", "2025-10", "2026-09"].map((m, i) => [m, +(k + 4.5 - i * 0.5).toFixed(2)])])), freq: "M", source: "BIS — central bank policy rates (WS_CBPOL)", sourceUrl: "https://data.bis.org/topics/CBPOL", status: "LIVE", fetchedAt: new Date().toISOString() } };
  if (p === "/api/sprd") return { body: SPRD_FIX() };
  if (p === "/api/energy/stocks") return st.noEia ? { status: 503, body: { error: "eia_not_configured", status: "N/A" } } : { body: STOCKS_FIX() };
  if (p === "/api/energy") return st.noEia ? { status: 503, body: { error: "eia_not_configured", status: "N/A" } } : { body: ENERGY_FIX() };
  if (p === "/api/earnings") return { body: ERN_FIX() };
  if (p === "/api/earnings/reactions") return { body: { reactions: { [`JPM|${dShift(today, -1)}`]: { session: dShift(today, -1), chg: 2.31 } }, status: "DERIVED" } };
  if (p === "/api/des") return u.searchParams.get("symbol") === "AAPL" || u.searchParams.get("symbol") === "MSFT" ? { body: { symbol: u.searchParams.get("symbol"), profile: DES_PROFILE, facts: Object.entries(DES_FACTS).map(([id, f]) => ({ id, label: f.label })), source: "SEC EDGAR", sourceUrl: "https://www.sec.gov/edgar/browse/?CIK=320193", fetchedAt: T7_NOW(), status: "LIVE" } } : { status: 404, body: { error: "not_sec_registrant", status: "N/A" } };
  if (p === "/api/des/fact") { const c = u.searchParams.get("c"); return { body: { symbol: "AAPL", fact: c, ...DES_FACTS[c] } }; }
  if (p === "/api/options/expirations") return { body: OPT_EXP() };
  if (p === "/api/options/chain") return { body: OPT_CHAIN(u.searchParams.get("exp")) };
  if (p === "/api/status") return { body: STATUS_FIX() };
  if (p === "/api/bonds") return { body: BONDS_FIX(st.noFred) };
  if (p === "/api/cot") return { body: COT_FIX() };
  const kind = p.split("/")[3];
  if (method === "GET") return { body: kind === "board" ? { boards: st.boards } : { [kind]: st[kind] } };
  if (kind === "board") { st.boards = body.boards.map((b, i) => ({ id: b.id || "board-" + i + "-xyz", name: b.name, syms: b.syms })); return { body: { boards: st.boards } }; }
  if (kind === "alerts" && p.endsWith("/hit")) { const a = st.alerts.find((x) => x.id === u.searchParams.get("id")); st.hits.push(body); if (a && !a.hit) a.hit = { at: T7_NOW(), price: body.price }; return { body: { alerts: st.alerts } }; }
  if (method === "DELETE") { st[kind] = st[kind].filter((x) => x.id !== u.searchParams.get("id")); return { body: { [kind]: st[kind] } }; }
  if (kind === "alerts") { const a = { id: "al" + st.alerts.length, sym: body.sym, op: body.op, price: body.price, note: body.note, created: T7_NOW(), hit: null }; st.alerts.push(a); return { status: 201, body: { added: a.id, alerts: st.alerts } }; }
  if (kind === "notes") { const n = { id: "n" + st.notes.length, text: body.text, sym: body.sym || null, created: T7_NOW(), updated: null }; st.notes.unshift(n); return { status: 201, body: { added: n.id, notes: st.notes } }; }
  return { status: 404, body: { error: "not found" } };
};

// ---------- provider formats answered in Node: the real Worker code builds /api/cnbc, /api/nasdaq, /api/reddit, /api/alerts ----------
// (CNBC quote service and bars, Nasdaq calendar / screener / movers, ApeWisdom, Telegram Bot API — fixtures in their formats)
const PV = { kv: new Map(), tg: [], cnbcAsked: [] };
// the ECB list of eligible assets as the cron leaves it in KV (its table format; test inputs only). IT0005518128 is left
// off on purpose: YAS reads it from OpenFIGI
PV.kv.set("bond/ecb", ["#ECB\t261021\t5\t2026-10-22T00:40:00.000Z", "DE0001102614\t1.8\t2022-08-15\t2053-08-15\tEUR\tDE\tIG2\tF\tAT01\tCentral government: Federal Republic of Germany",
  "IT0005138828\t1.25\t2015-09-15\t2032-09-15\tEUR\tIT\tIG2\tF\tAT01\tCentral government: Italian Republic", "IT0005408999\t3.5\t2020-05-01\t2040-03-01\tEUR\tIT\tIG2\tF\tAT01\tCentral government: Italian Republic",
  "IT0005436693\t0.6\t2021-02-23\t2031-08-01\tEUR\tIT\tIG2\tF\tAT01\tCentral government: Italian Republic", "IT0005611303\t0\t2026-08-14\t2027-02-12\tEUR\tIT\tIG2\tZ\tAT03\tCentral government: Italian Republic"].join("\n"));
const TG_TOKEN = "123456789:AAH" + "e".repeat(32);
const cnTime = (ms) => new Date(ms).toISOString().replace("Z", "+0000");
const CN_PX = { ".SPX": 6700.5, ".NDX": 24800, ".DJI": 46500, ".RUT": 2450, ".N225": 49000, "@SP.1": 6731.25, "@ND.1": 24890, "@DJ.1": 46600, "@TFS.1": 2460, "@NK.1": 49150, "@CL.1": 88.42, "@GC.1": 4130.5, "EUR=": 1.1235, "NVDA": 190.5, ".FTMIB": 44000 };
const cnPx = (s) => CN_PX[s] ?? (/^@CL\.(\d+)$/.test(s) ? 88.42 - (+s.split(".")[1] - 1) * 0.35 : /^@NG\.(\d+)$/.test(s) ? 3.1 + (+s.split(".")[1]) * 0.08 : 50 + [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 70);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// the UCITS lines' currencies as CNBC gave them when they were checked (London pence lines in GBp)
const UC_CCY_OF = Object.fromEntries(UCITS_ETFS.flatMap((e) => Object.values(e.lines).map((l) => [l.cnbc, l.pence ? "GBp" : l.ccy])));
const cnQuote = (s) => { const last = cnPx(s), prev = +(last / 1.0075).toFixed(4), n = /^@[A-Z]+\.(\d+)$/.exec(s), m = n ? (10 + +n[1]) : 0;
  return { symbol: s, code: 0, name: n ? `${s} (${MON[m % 12]}'${26 + Math.floor(m / 12)})` : s === "EUR=" ? "EUR/USD" : s, last: last.toLocaleString("en-US", { maximumFractionDigits: 4 }), previous_day_closing: String(prev), change: "+" + (last - prev).toFixed(4), change_pct: "+0.75%", open: String(prev), high: String(last), low: String(prev), volume: "1000", last_time: cnTime(Date.now() - (s.startsWith(".") ? 5 : 2) * 60_000), exchange: "CME", realTime: s.startsWith(".") ? "false" : "true", curmktstatus: "REG_MKT", ...(UC_CCY_OF[s] ? { currencyCode: UC_CCY_OF[s] } : /=$/.test(s) || /^[A-Z]{1,5}$/.test(s) ? { currencyCode: "USD" } : {}) }; };
const cnBars = (s, five) => { const out = [], end = Date.now(); if (five) { for (let t = end - 4 * 864e5; t < end; t += 300_000) out.push({ close: String(cnPx(s)), tradeTime: "x", tradeTimeinMills: t - t % 300_000 }); return out; }
  const d0 = new Date(); d0.setUTCHours(4, 0, 0, 0); for (let i = 420; i >= 1; i--) { const t = d0.getTime() - i * 864e5, wd = new Date(t).getUTCDay(); if (wd === 0 || wd === 6) continue; const v = cnPx(s) * (1 - i * 0.0004 + Math.sin(i / 9) * 0.01); out.push({ close: v.toFixed(4), open: v.toFixed(4), high: (v * 1.01).toFixed(4), low: (v * 0.99).toFixed(4), tradeTime: new Date(t).toISOString().slice(0, 10).replace(/-/g, "") + "000000", tradeTimeinMills: t }); } return out; };
const NQ_TODAY = new Date().toISOString().slice(0, 10);
// daily bars back to a date (weekdays), for the 10-year factor window only
const cnBarsLong = (s, from) => { const out = [], d0 = new Date(); d0.setUTCHours(4, 0, 0, 0); const n = Math.ceil((d0.getTime() - from) / 864e5);
  const ym = /^(?:US|[A-Z]{2})(\d+)([MY])(?:-[A-Z]{2})?$/.exec(s), mo = ym ? +ym[1] * (ym[2] === "Y" ? 12 : 1) : 0; // a government bond's yield, in %
  for (let i = n; i >= 1; i--) { const t = d0.getTime() - i * 864e5, wd = new Date(t).getUTCDay(); if (wd === 0 || wd === 6) continue; const v = ym ? 2 + Math.min(mo, 360) / 180 + Math.sin(i / 90) * 0.5 : cnPx(s) * Math.exp(-i * 0.0002 + Math.sin(i / 23) * 0.04 + Math.sin(i / 7) * 0.01); out.push({ close: v.toFixed(4), tradeTime: new Date(t).toISOString().slice(0, 10).replace(/-/g, "") + "000000", tradeTimeinMills: t }); } return out; };
// the Kenneth R. French Data Library's files (ZIP of one CSV, its layout): 130 months to two months ago
const FF_MON = (() => { const out = [], d = new Date(); let k = d.getUTCFullYear() * 12 + d.getUTCMonth() - 2; for (let i = 129; i >= 0; i--) { const m = k - i; out.push(`${Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, "0")}`); } return out; })();
const ffv = (i, a, b) => (Math.sin(i * a + b) * 3 + Math.cos(i * (a + 0.7)) * 1.5).toFixed(2);
const FF_FIVE = ["This file was created using the Bloomberg database.", "Missing data are indicated by -99.99.", "", ",Mkt-RF,SMB,HML,RMW,CMA,RF", ...FF_MON.map((m, i) => [m, ffv(i, 0.9, 0.1), ffv(i, 1.7, 1), ffv(i, 2.3, 2), ffv(i, 0.6, 3), ffv(i, 1.3, 4), "0.30"].join(",")), "", " Annual Factors: January-December ", ",Mkt-RF,SMB,HML,RMW,CMA,RF", "2020, 10.00, 1.00, 1.00, 1.00, 1.00, 0.50"].join("\r\n");
const FF_MOM = ["This file was created using the Bloomberg database.", "", "            ,WML", ...FF_MON.map((m, i) => [m, ffv(i, 1.1, 5)].join(","))].join("\r\n");
function ffZip(name, text) {
  const data = deflateRawSync(Buffer.from(text)), nb = Buffer.from(name), raw = Buffer.from(text);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nb.length, 12); end.writeUInt32LE(30 + nb.length + data.length, 16);
  return Buffer.concat([lh, nb, data, ch, nb, end]);
}
const E2E_SETTLE = settlementCandidates(Date.now()).find((c) => c <= new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10));
// SEC XBRL company concepts for FA (their format): five fiscal years ending late September, a 10-Q after the last one
const faFlow = (vals, q) => ({ units: { USD: vals.map((v, i) => ({ start: `${2020 + i}-09-27`, end: `${2021 + i}-09-25`, val: v, form: "10-K", filed: `${2021 + i}-10-29`, fp: "FY" })).concat(q ? [{ start: "2025-09-28", end: "2026-06-27", val: q[0], form: "10-Q", filed: "2026-07-31", fp: "Q3" }, { start: "2024-09-29", end: "2025-06-28", val: q[1], form: "10-Q", filed: "2026-07-31", fp: "Q3" }, { start: "2026-03-29", end: "2026-06-27", val: q[2], form: "10-Q", filed: "2026-07-31", fp: "Q3" }] : []) } });
const faInst = (vals) => ({ units: { USD: vals.map((v, i) => ({ end: `${2021 + i}-09-25`, val: v, form: "10-K", filed: `${2021 + i}-10-29`, fp: "FY" })) } });
const SEC_FA = { RevenueFromContractWithCustomerExcludingAssessedTax: faFlow([300e9, 320e9, 340e9, 360e9, 400e9], [310e9, 290e9, 100e9]), CostOfGoodsAndServicesSold: faFlow([180e9, 190e9, 200e9, 210e9, 230e9]), GrossProfit: faFlow([120e9, 130e9, 140e9, 150e9, 170e9]),
  OperatingIncomeLoss: faFlow([90e9, 100e9, 105e9, 110e9, 125e9]), NetIncomeLoss: faFlow([80e9, 90e9, 92e9, 95e9, 100e9], [80e9, 70e9, 25e9]), AssetsCurrent: faInst([130e9, 135e9, 140e9, 145e9, 150e9]), LiabilitiesCurrent: faInst([120e9, 150e9, 140e9, 150e9, 160e9]),
  NetCashProvidedByUsedInOperatingActivities: faFlow([100e9, 110e9, 112e9, 115e9, 120e9]), PaymentsToAcquirePropertyPlantAndEquipment: faFlow([10e9, 11e9, 11e9, 12e9, 13e9]) };
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://quote.cnbc.com/")) { const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split("|"); PV.cnbcAsked.push(syms); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((s) => s === "ZZZZ" ? { symbol: s, code: 1 } : cnQuote(s)) } })); }
  if (u.startsWith("https://ts-api.cnbc.com/")) { const seg = u.split("/bars/")[1].split("/"), sym = decodeURIComponent(seg[0]), from = Date.parse(`${seg[2].slice(0, 4)}-${seg[2].slice(4, 6)}-${seg[2].slice(6, 8)}T00:00:00Z`);
    return new Response(JSON.stringify({ barData: { priceBars: seg[1] === "1D" && Date.now() - from > 3000 * 864e5 ? cnBarsLong(sym, from) : cnBars(sym, /\/5M\//.test(u)) } })); }
  if (u.startsWith(FF_BASE)) { const f = u.slice(FF_BASE.length); PV.ffAsked = (PV.ffAsked || 0) + 1; return new Response(ffZip(f.replace("_CSV.zip", ".csv"), /Mom/i.test(f) ? FF_MOM : FF_FIVE)); }
  if (u.startsWith("https://api.nasdaq.com/api/calendar/")) { const d = /date=([\d-]+)/.exec(u)[1]; return new Response(JSON.stringify({ data: { rows: d === NQ_TODAY ? [{ gmt: "12:30", country: "United States", eventName: "CPI (MoM)", actual: "0.4%", consensus: "0.3%", previous: "0.2%" }, { gmt: "08:00", country: "Germany", eventName: "PPI (MoM)", actual: "-0.1%", consensus: "0.0%", previous: "0.2%" }] : [] } })); }
  if (u.startsWith("https://api.nasdaq.com/api/screener/")) { const ex = /exchange=(\w+)/.exec(u)[1]; return new Response(JSON.stringify({ data: { rows: (ex === "nasdaq" ? [["NVDA", "NVIDIA Corporation Common Stock", "$190.50", "2.1%", "200000000", "4600000000000", "Technology", "Semiconductors", "United States", "1999"], ["AAPL", "Apple Inc. Common Stock", "$250.00", "-0.5%", "50000000", "3700000000000", "Technology", "Computer Manufacturing", "United States", "1980"]] : ex === "nyse" ? [["JPM", "JP Morgan Chase & Co. Common Stock", "$260.40", "0.8%", "9000000", "720000000000", "Finance", "Major Banks", "United States", ""]] : [["AMEX1", "Small Co Common Stock", "$3.10", "12.5%", "100000", "50000000", "Health Care", "Biotechnology", "United States", "2021"]]).map(([symbol, name, lastsale, pctchange, volume, marketCap, sector, industry, country, ipoyear]) => ({ symbol, name, lastsale, pctchange, volume, marketCap, sector, industry, country, ipoyear })) } })); }
  if (u.startsWith("https://api.nasdaq.com/api/marketmovers")) return new Response(JSON.stringify({ data: { STOCKS: { MostActiveByShareVolume: { dataAsOf: "Data as of today", table: { headers: { lastSalePrice: "Last", lastSaleChange: "Change", change: "Share Volume" }, rows: [{ symbol: "NVDA", name: "NVIDIA", lastSalePrice: "$190.50", lastSaleChange: "+3.92", change: "200,000,000" }] } }, MostAdvanced: { dataAsOf: "Data as of today", table: { headers: { lastSalePrice: "Last", lastSaleChange: "Change", change: "% Change" }, rows: [{ symbol: "UPCO", name: "Up Co", lastSalePrice: "$12.00", lastSaleChange: "+3.00", change: "+33.33%" }] } }, MostDeclined: { dataAsOf: "Data as of today", table: { headers: { lastSalePrice: "Last", lastSaleChange: "Change", change: "% Change" }, rows: [{ symbol: "DNCO", name: "Down Co", lastSalePrice: "$2.00", lastSaleChange: "-1.00", change: "-33.33%" }] } } } } }));
  if (u.startsWith("https://api.finra.org/")) { const b = JSON.parse(init.body || "{}"); if (b.limit === 1) { const d = b.compareFilters[0].fieldValue; return new Response(JSON.stringify(d === E2E_SETTLE ? [{ settlementDate: d }] : [])); }
    if ((b.compareFilters || []).some((f) => f.fieldName === "symbolCode")) return new Response(JSON.stringify([{ symbolCode: "AAPL", issueName: "Apple Inc.", marketClassCode: "NNM", currentShortPositionQuantity: 120763539, previousShortPositionQuantity: 128753092, averageDailyVolumeQuantity: 39858260, daysToCoverQuantity: 3.03, changePercent: -6.21, settlementDate: "2026-09-30" }, { symbolCode: "AAPL", issueName: "Apple Inc.", marketClassCode: "NNM", currentShortPositionQuantity: 128753092, previousShortPositionQuantity: 139749097, averageDailyVolumeQuantity: 45135477, daysToCoverQuantity: 2.85, changePercent: -7.87, settlementDate: "2026-09-15" }]));
    return new Response(JSON.stringify([["NVDA", "NVIDIA Corporation Common Stoc", "NNM", 311389688, 294225803, 110290688, 2.82, 5.83], ["JPM", "JP Morgan Chase", "NYSE", 20000000, 21000000, 9000000, 2.22, -4.76], ["AMEX1", "Small Co", "ARCA", 15000000, 10000000, 100000, 150, 50]].map(([symbolCode, issueName, marketClassCode, currentShortPositionQuantity, previousShortPositionQuantity, averageDailyVolumeQuantity, daysToCoverQuantity, changePercent]) => ({ symbolCode, issueName, marketClassCode, currentShortPositionQuantity, previousShortPositionQuantity, averageDailyVolumeQuantity, daysToCoverQuantity, changePercent, settlementDate: "2026-09-30" })))); }
  if (u.startsWith("https://cdn.finra.org/equity/regsho/daily/")) { const d = /CNMSshvol(\d{8})/.exec(u)[1]; return new Response(`Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n${d}|AAPL|4000000|1200|10000000|B,Q,N\n`); }
  if (u.startsWith("https://api.nasdaq.com/api/analyst/AAPL/ratings")) return new Response(JSON.stringify({ data: { symbol: "aapl", meanRatingType: "Buy", ratingsSummary: "Based on 29 analysts offering recommendations for AAPL.", upgradesDowngrades: [], brokerNames: ["CITIGROUP"] } }));
  if (u.startsWith("https://api.nasdaq.com/api/analyst/AAPL/targetprice")) return new Response(JSON.stringify({ data: { consensusOverview: { lowPriceTarget: 245, highPriceTarget: 400, priceTarget: 301.44, buy: 16, sell: 4, hold: 10 }, historicalConsensus: [{ z: { buy: 15, hold: 9, sell: 4, consensus: "Buy" }, x: 1790812800, y: 301.44 }] } }));
  if (u.startsWith("https://api.nasdaq.com/api/analyst/AAPL/earnings-forecast")) return new Response(JSON.stringify({ data: { quarterlyForecast: { rows: [{ fiscalEnd: "Dec 2026", consensusEPSForecast: 2.9, highEPSForecast: 3.04, lowEPSForecast: 2.68, noOfEstimates: 6, up: 1, down: 0 }] }, yearlyForecast: { rows: [{ fiscalEnd: "Sep 2027", consensusEPSForecast: 9.59, highEPSForecast: 10.47, lowEPSForecast: 9.01, noOfEstimates: 11, up: 2, down: 1 }] } } }));
  if (u.startsWith("https://api.nasdaq.com/api/company/AAPL/institutional-holdings")) return new Response(JSON.stringify({ data: { ownershipSummary: { SharesOutstandingPCT: { value: "61.20%" }, ShareoutstandingTotal: { value: "14,800" }, TotalHoldingsValue: { value: "$2,264,400" } }, activePositions: { rows: [{ positions: "Increased Positions", holders: "2,815", shares: "329,984,542" }] }, holdingsTransactions: { totalRecords: "6437", table: { rows: [{ ownerName: "Vanguard Group Inc", date: "06/30/2026", sharesHeld: "1,426,283,914", sharesChange: "26,856,752", sharesChangePCT: "1.919%", marketValue: "$358,000,000" }] } } } }));
  if (u.startsWith("https://api.nasdaq.com/api/analyst/") || u.startsWith("https://api.nasdaq.com/api/company/")) return new Response(JSON.stringify({ data: null }));
  if (u.startsWith("https://symlookup.cnbc.com/")) return new Response(JSON.stringify([{ TotalMatchAvailable: "3" }, { symbolName: "NOV-DE", companyName: "Novartis AG", exchangeName: "XETRA", countryCode: "DE", issueType: "STOCK" }, { symbolName: "NVS", companyName: "Novartis AG", exchangeName: "NYSE", countryCode: "US", issueType: "STOCK" }, { symbolName: "NOVN-CH", companyName: "Novartis AG", exchangeName: "Swiss Exchange", countryCode: "CH", issueType: "STOCK" }]));
  // OpenFIGI /v3/mapping and Twelve Data /symbol_search (ISIN search)
  if (u === "https://api.openfigi.com/v3/mapping") { const b = JSON.parse(init.body || "[]"); PV.figi = (PV.figi || 0) + 1;
    if (b[0].idValue === "IT0005518128") return new Response(JSON.stringify([{ data: [{ figi: "BBG01FV7X8M1", name: "BUONI POLIENNALI DEL TES", ticker: "BTPS 4.4 05/01/33", exchCode: "IM", securityType: "EURO-ZONE", marketSector: "Govt", securityType2: "Govt" }] }]));
    if (b[0].idValue === "IT0005436693") return new Response(JSON.stringify([{ data: [{ figi: "BBG00ZZZ0001", name: "BUONI POLIENNALI DEL TES", ticker: "BTPS 0.6 08/01/31", exchCode: "IM", securityType: "EURO-ZONE", marketSector: "Govt", securityType2: "Govt" }] }]));
    if (b[0].idValue === "IT0005138828") return new Response(JSON.stringify([{ data: [{ figi: "BBG00ZZZ0002", name: "BUONI POLIENNALI DEL TES", ticker: "BTPS 1.25 09/15/32 CPI", exchCode: "IM", securityType: "EURO-ZONE", marketSector: "Govt", securityType2: "Govt" }] }]));
    return new Response(JSON.stringify(b[0].idValue === "IT0000072618" ? [{ data: [{ figi: "BBG000BNSF93", name: "INTESA SANPAOLO", ticker: "ISP", exchCode: "IM", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" },
      { figi: "BBG000BNSF02", name: "INTESA SANPAOLO", ticker: "IES", exchCode: "GY", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" }, { figi: "BBG000BNSF39", name: "INTESA SANPAOLO", ticker: "ISNPF", exchCode: "US", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" }] }] : [{ warning: "No identifier found." }])); }
  if (u.startsWith("https://api.twelvedata.com/symbol_search")) { const q = new URL(u).searchParams.get("symbol"), rw = (symbol, mic, country, currency, plan) => ({ symbol, instrument_name: "Intesa Sanpaolo S.p.A.", exchange: mic, mic_code: mic, exchange_timezone: "Europe/Rome", instrument_type: "Common Stock", country, currency, access: { global: plan, plan } });
    return new Response(JSON.stringify({ data: q === "ISP" ? [rw("ISP", "XMIL", "Italy", "EUR", "Grow")] : q === "IES" ? [rw("IES", "XETR", "Germany", "EUR", "Grow")] : [], status: "ok" })); }
  if (u.startsWith("https://apewisdom.io/")) return new Response(JSON.stringify({ results: [{ rank: 1, ticker: "NVDA", name: "NVIDIA", mentions: 812, upvotes: 4021, rank_24h_ago: 2, mentions_24h_ago: 640 }, { rank: 2, ticker: "TSLA", name: "Tesla", mentions: 700, upvotes: 3000, rank_24h_ago: 1, mentions_24h_ago: 900 }] }));
  if (u.startsWith("https://api.telegram.org/")) { const method = u.split("/").pop(), body = JSON.parse(init.body || "{}"); PV.tg.push({ method, body, tokenInUrl: u.includes(TG_TOKEN) });
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Ale alerts", username: "ale_alerts_bot" } }));
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: { id: 4242, type: "private", first_name: "Alessandro" }, text: "/start" } }] }));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } })); }
  // SEC EDGAR (ticker map, XBRL company concepts) and Finnhub (company news, reported quarters, earnings calendar): FA, CN, ERN
  if (u === "https://www.sec.gov/files/company_tickers.json") return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }));
  if (u.startsWith("https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/")) { const c = u.split("/us-gaap/")[1].replace(".json", ""), F = SEC_FA[c]; PV.secAsked = (PV.secAsked || 0) + 1; return F ? new Response(JSON.stringify(F)) : new Response("", { status: 404 }); }
  if (u.startsWith("https://finnhub.io/api/v1/company-news")) return new Response(JSON.stringify([{ datetime: Math.floor(Date.now() / 1000) - 1800, headline: "Apple widens its chip line-up", source: "Reuters", url: "https://example.com/n1", related: "AAPL", summary: "publisher text" }, { datetime: Math.floor(Date.now() / 1000) - 3 * 86400, headline: "Suppliers report record orders", source: "MarketWatch", url: "https://example.com/n2", related: "AAPL" }]));
  if (u.startsWith("https://finnhub.io/api/v1/stock/earnings")) return new Response(JSON.stringify([{ actual: 1.65, estimate: 1.6, period: "2026-06-30", quarter: 3, year: 2026, surprise: 0.05, surprisePercent: 3.125, symbol: "AAPL" }, { actual: 1.62, estimate: 1.65, period: "2026-03-31", quarter: 2, year: 2026, surprise: -0.03, surprisePercent: -1.8182, symbol: "AAPL" }]));
  if (u.startsWith("https://finnhub.io/api/v1/calendar/earnings")) return new Response(JSON.stringify({ earningsCalendar: [{ date: "2026-07-30", hour: "amc", quarter: 3, year: 2026, epsActual: 1.65, epsEstimate: 1.6, revenueActual: 94e9, revenueEstimate: 92e9, symbol: "AAPL" }, { date: dShift(ET, 14), hour: "amc", quarter: 4, year: 2026, epsEstimate: 1.8, revenueEstimate: 101e9, symbol: "AAPL" }] }));
  return new Response("", { status: 404 });
};
const workerEnv = { ALLOWED_ORIGIN: ORIGIN, TELEGRAM_BOT_TOKEN: TG_TOKEN, BRIEFS: { get: async (k) => PV.kv.get(k) ?? null, put: async (k, v) => { PV.kv.set(k, v); }, delete: async (k) => { PV.kv.delete(k); } } };
async function viaWorker(route, u, envPlus = null) {
  const rq = route.request(), m = rq.method();
  const r = await workerApp.fetch(new Request(u.href, { method: m, headers: { "content-type": rq.headers()["content-type"] || "", origin: ORIGIN }, body: m === "GET" || m === "HEAD" ? undefined : rq.postData() || undefined }), envPlus ? { ...workerEnv, ...envPlus } : workerEnv, { waitUntil() {} });
  return route.fulfill({ status: r.status, contentType: "application/json", body: await r.text() });
}

// ---------- harness ----------
let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" + "-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
// (the briefing legitimately names its AI model, so "model" alone is allowed; a "model portfolio" is not)
// (the owner's own PORTFOLIO is allowed: it starts empty and holds only what is entered on the site)
const FORBIDDEN = /SIMULATED|\bSIM\b|MIXED|MODEL PORTFOLIO|SAMPLE PORTFOLIO|MODEL —|hypothetical|static sample|\bsample\b|\bdemo\b|\bmock\b|\bfake\b/i;

async function openTerminal(api, html = htmlFast, init = null) {
  // service workers blocked: requests must go through the routes below (the app's worker is tested in sw.test.mjs)
  const page = api.phone
    ? await (await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1" })).newPage()
    : await browser.newPage({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  const requests = [], errors = [], quoteBatches = [], spxCalls = [], brfState = { writes: [], written: false }, pfState = { tx: [], posts: [], deletes: [] }, t7 = { calls: [], alerts: [], notes: [], boards: [], hits: [], noEia: !!(api.noEia), noFred: !!(api.noFred) };
  page.on("request", (r) => requests.push(r.url()));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    const send = (r) => route.fulfill({ status: r.status || 200, contentType: "application/json", body: JSON.stringify(r.body) });
    if (api.pre && await api.pre(route, u)) return; // scenario R: the public replay's own paths
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/user/recording")) return send({ status: 404, body: { error: "not found" } }); // no recording made outside scenario R
    if (u.origin === ORIGIN && u.pathname === "/terminal/provenance.js") return route.fulfill({ contentType: "application/javascript", body: provJs });
    if (u.origin === ORIGIN && u.pathname === "/terminal/i18n.js") return route.fulfill({ contentType: "application/javascript", body: i18nJs });
    if (u.origin === ORIGIN && u.pathname === "/terminal/vendor/lightweight-charts.js") return route.fulfill({ contentType: "application/javascript", body: lwcJs });
    if (u.origin === ORIGIN && u.pathname === "/terminal/qmath.js") return route.fulfill({ contentType: "application/javascript", body: quantJs });
    if (u.origin === ORIGIN && (u.pathname === "/terminal/manifest.webmanifest" || u.pathname.startsWith("/terminal/app/"))) { const f = "public" + u.pathname; return existsSync(f) ? route.fulfill({ contentType: f.endsWith(".png") ? "image/png" : "application/manifest+json", body: readFileSync(f) }) : route.fulfill({ status: 404, body: "" }); }
    if (u.origin === ORIGIN && u.pathname.startsWith("/terminal")) return route.fulfill({ contentType: "text/html", body: html });
    if (u.origin === ORIGIN && u.pathname === "/api/health") { const h = api.health ? api.health() : { body: { ok: true } }; return h === "abort" ? route.abort() : send(h); }
    if (u.origin === ORIGIN && u.pathname === "/api/quote") { const syms = (u.searchParams.get("symbols") || "").split(","); quoteBatches.push({ t: Date.now(), syms }); return send(api.quote(syms)); }
    if (u.origin === ORIGIN && u.pathname === "/api/history") return send(api.history(u.searchParams.get("symbol"), u.searchParams.get("range"), u.searchParams.get("interval")));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/briefs")) return send(api.briefs ? api.briefs(u) : briefsApi(u, route.request().method(), brfState));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/portfolio")) { let b = null; try { b = JSON.parse(route.request().postData() || "null"); } catch {} return send(api.portfolio ? api.portfolio(u) : pfApi(u, route.request().method(), b, pfState)); }
    if (u.origin === ORIGIN && u.pathname === "/api/calendar/reactions") return send(api.reactions ? api.reactions() : { body: CAL_REACT() });
    if (u.origin === ORIGIN && u.pathname === "/api/calendar/history") return send({ body: { ccy: u.searchParams.get("ccy"), title: u.searchParams.get("title"), releases: [{ datetime: "2026-09-10T12:30:00.000Z", forecast: "0.2%", previous: "0.2%" }], note: "Forecast and previous as published by Forex Factory in each weekly export since the archive started.", status: "LIVE" } });
    if (u.origin === ORIGIN && u.pathname === "/api/exchanges") return send(api.exchanges ? api.exchanges() : { body: EXCH() });
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/spx/")) { spxCalls.push(u.pathname + u.search); return send(api.spx ? api.spx(u.pathname, u) : spxApi(u.pathname, u)); }
    if (u.origin === ORIGIN && u.pathname === "/api/search" && /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test((u.searchParams.get("q") || "").replace(/ /g, ""))) return viaWorker(route, u); // ISIN: the real Worker code, OpenFIGI in its format
    if (u.origin === ORIGIN && u.pathname === "/api/search") return send(api.search ? api.search(u.searchParams.get("q")) : { body: searchBody(u.searchParams.get("q")) });
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/markets/")) return send(api.markets ? api.markets(u) : marketsApi(u));
    if (u.origin === ORIGIN && (u.pathname === "/api/indices" || u.pathname === "/api/indices/history")) return send(api.indices ? api.indices(u) : indicesApi(u));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/yields/market")) return send(api.mkt ? api.mkt(u) : mktApi(u));
    if (u.origin === ORIGIN && u.pathname === "/api/yields/history") return send(api.yieldsHistory ? api.yieldsHistory(u) : yieldsHistory(u));
    if (u.origin === ORIGIN && u.pathname === "/api/yields" && u.searchParams.get("ids") && !api.yieldsRaw) return send(api.yieldsIds ? api.yieldsIds(u) : yieldsIds(u));
    if (u.origin === ORIGIN && ["/api/yields", "/api/calendar", "/api/news", "/api/briefing", "/api/headlines"].includes(u.pathname)) return send(api.ext(u.pathname.slice(5), u));
    if (u.origin === ORIGIN && (/^\/api\/(cnbc|nasdaq|alerts|finra|etf)\//.test(u.pathname) || u.pathname === "/api/factors" || u.pathname.startsWith("/api/plab/") || u.pathname.startsWith("/api/user/plab") || u.pathname.startsWith("/api/user/wif") || u.pathname === "/api/bond/ref" || u.pathname === "/api/bond/list" || u.pathname === "/api/reddit" || u.pathname === "/api/alerts" || u.pathname.startsWith("/api/user/alerts") || u.pathname.startsWith("/api/user/views") || u.pathname.startsWith("/api/user/bcfg"))) return viaWorker(route, u);
    if (u.origin === ORIGIN && (u.pathname === "/api/fa" || u.pathname === "/api/cn" || u.pathname === "/api/earnings/symbol")) return viaWorker(route, u, api.noFinnhub ? { SEC_CONTACT: "e2e@example.com" } : { SEC_CONTACT: "e2e@example.com", FINNHUB_KEY: "fh-e2e" });
    if (u.origin === ORIGIN && /^\/api\/(cb|sprd|energy|earnings|des|options|user|status|bonds|cot)(\/|$)/.test(u.pathname)) { let b = null; try { b = JSON.parse(route.request().postData() || "null"); } catch {} return send(t07Api(u, route.request().method(), b, t7)); }
    if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) return route.fulfill({ body: "" });
    return route.abort();
  });
  if (init) await page.addInitScript(init);
  await page.goto(ORIGIN + "/terminal/desk/");
  return { page, requests, errors, quoteBatches, spxCalls, brfState, pfState, t7 };
}
const shotWin = async (page, prefix, name) => { if (!SHOTS) return; await page.evaluate((p) => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith(p)); if (w) { w.querySelector(".w-max").click(); } }, prefix); await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/${name}.png` }); await page.evaluate((p) => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith(p)); if (w) w.querySelector(".w-max").click(); }, prefix); };
const winOf = (page, prefix) => page.evaluate((p) => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith(p)); return w ? { text: w.querySelector(".win-body").innerText, pill: w.querySelector(".w-pv")?.innerText || "", pillTitle: w.querySelector(".w-pv .pv")?.getAttribute("title") || "" } : null; }, prefix);
const cmd = async (page, c) => { await page.fill("#cmd", c); await page.press("#cmd", "Enter"); await page.waitForTimeout(500); return page.evaluate(() => document.querySelector("#cmd").value !== ""); };
const wlFill = async (page, sym) => { await page.fill(".wl-in", sym); await page.press(".wl-in", "Enter"); await page.waitForTimeout(700); };

const OK_API = {
  quote: (syms) => {
    const quotes = {}, errors = {};
    for (const s of syms) { if (s === "ZZZZ") errors[s] = { error: "symbol_not_found", status: "N/A" }; else if (s === "NOVN:XSWX") quotes[s] = cnbcInstrument(cnbcIntlRec(s, { symbol: "NOVN-CH", code: 0, name: "Novartis AG", last: "126.50", last_time: new Date(Date.now() - 600_000).toISOString().replace("Z", "+0000"), change: "+0.50", change_pct: "+0.40%", previous_day_closing: "126.00", currencyCode: "CHF", exchange: "Swiss Exchange", realTime: "false", countryCode: "CH" }), { fetchedAt: Date.now(), fieldKeys: ["price", "change", "changePct", "prevClose", "open", "high", "low", "volume", "fiftyTwoWeekLow", "fiftyTwoWeekHigh", "marketCap", "pe", "eps", "dividendYield", "sharesOutstanding"] }); else if (s === "ISP:XMIL") quotes[s] = cnbcInstrument(cnbcIntlRec(s, { symbol: "ISP-IT", code: 0, name: "Intesa Sanpaolo S.p.A.", last: "5.99", last_time: new Date(Date.now() - 600_000).toISOString().replace("Z", "+0000"), change: "-0.02", change_pct: "-0.37%", previous_day_closing: "6.02", currencyCode: "EUR", exchange: "Milan Stock Exchange", realTime: "false", pe: "10.62", eps: "0.56", mktcapView: "103.871B", dividendyield: "6.27%", sharesout: "17.33B", yrhiprice: "6.94", yrloprice: "4.81", countryCode: "IT" }), { fetchedAt: Date.now(), fieldKeys: ["price", "change", "changePct", "prevClose", "open", "high", "low", "volume", "fiftyTwoWeekLow", "fiftyTwoWeekHigh", "marketCap", "pe", "eps", "dividendYield", "sharesOutstanding"] }); else quotes[s] = instrument(s); }
    return { status: Object.keys(quotes).length ? 200 : 404, body: { quotes, errors, meta: {} } };
  },
  history: (sym, range) => ({ body: historyBody(sym, range) }),
  ext: (name, u) => ({ body: name === "headlines" ? PRESS(u.searchParams.get("source")) : { yields: YIELDS, calendar: CALENDAR, news: NEWS, briefing: BRIEF }[name] }),
};

// =============== A. every section on real-shaped data ===============
{
  const { page, requests, errors, quoteBatches, brfState, spxCalls, pfState } = await openTerminal(OK_API);
  await page.evaluate(() => localStorage.removeItem("at-watchlist"));
  await page.reload();
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  ok("[A] quote requests are chunked to ≤ 7 symbols", quoteBatches.length >= 2 && quoteBatches.every((b) => b.syms.length <= 7), quoteBatches.map((b) => b.syms.length).join());
  ok("[A] default layout: security, watchlist, markets, yields", (await page.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent).join())) === "GP,WL,MKT,YLD");
  // GP: interactive chart (Lightweight Charts, self-hosted) on the real bars of /api/history; ranges 1M…5Y share one daily request
  await page.waitForTimeout(800);
  const gp0 = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "GP"); return { canv: w.querySelectorAll(".gp-box .lw-host canvas").length, leg: w.querySelector(".lw-leg")?.innerText || "", lib: typeof window.LightweightCharts?.createChart, ranges: [...w.querySelectorAll("[data-tf]")].map((b) => b.dataset.tf).join() }; });
  ok("[A] GP: interactive candle chart drawn by the self-hosted library, legend with open / high / low / close of the bar", gp0.lib === "function" && gp0.canv >= 2 && /O\s+[\d,.]+\s+H\s+[\d,.]+\s+L\s+[\d,.]+\s+C\s+[\d,.]+/.test(gp0.leg) && gp0.ranges === "1D,5D,1M,3M,6M,YTD,1Y,3Y,5Y,10Y,MAX", JSON.stringify(gp0));
  ok("[A] GP: one 5-year daily request (split-adjusted) serves 1M…5Y", requests.some((u) => /\/api\/history\?symbol=NVDA&range=5Y&adjust=splits&interval=1day/.test(u)));
  const nHist = requests.filter((u) => u.includes("/api/history?symbol=NVDA")).length;
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "GP"); w.querySelector('[data-tf="1Y"]').click(); });
  await page.waitForTimeout(400);
  ok("[A] GP: switching 6M → 1Y only moves the view, no new request", requests.filter((u) => u.includes("/api/history?symbol=NVDA")).length === nHist);
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "GP"); w.querySelector('[data-ind="ma50"]').click(); });
  await page.waitForTimeout(400);
  const gp1 = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "GP"); return { leg: w.querySelector(".lw-leg").innerText, src: w.querySelector(".src-line").innerText }; });
  ok("[A] GP: SMA 50 computed here from the real closes, labelled DRV", /SMA 50\s+[\d,.]+/.test(gp1.leg) && /DRV/.test(gp1.leg) && /indicators computed from these bars/.test(gp1.src), JSON.stringify(gp1));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "GP"); w.querySelector('[data-tf="5D"]').click(); });
  await page.waitForTimeout(600);
  ok("[A] GP: 5D asks for 15-minute bars of the last five sessions", requests.some((u) => /\/api\/history\?symbol=NVDA&range=5D&adjust=splits&interval=15min/.test(u)));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "GP"); w.querySelector('[data-ind="ma50"]').click(); w.querySelector('[data-tf="6M"]').click(); });
  await page.waitForTimeout(300);
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
  ok("[A] markets: live FX majors and gold (Twelve Data), equity volume PARTIAL, FX volume N/A", /EUR\/USD[\s\S]*1\.12601/.test(mkt.text) && /XAU\/USD[\s\S]*4,165\.24/.test(mkt.text) && /537\.8K\s*PART/.test(mkt.text) && /EUR\/USD[^\n]*\n?[^\n]*N\/A/.test(mkt.text), mkt.text.slice(0, 300));
  ok("[A] markets: the main indices from /api/indices (a failed one N/A with its reason)", /INDICES[\s\S]*SPX\s+S&P 500\s+7,800\.12\s+-0\.24%/.test(mkt.text) && /DJI\s+Dow Jones Industrial Average\s+51,215\.00[\s\S]*?DRV/.test(mkt.text) && /RUT\s+Russell 2000\s+N\/A — provider timed out/.test(mkt.text), (mkt.text.match(/INDICES[\s\S]{0,400}/) || [])[0]);
  const chfPrev = 0.9359, chf = 0.9309;
  ok("[A] markets: more FX from the ECB fixing — EUR pairs as published, dollar pairs DERIVED through the same fixing, a missing currency skipped", /EUR\/CHF\s+ECB reference rate\s+0\.9309\s+-0\.53%/.test(mkt.text) && new RegExp("USD/CHF\\s+ECB fixing, via the dollar rate\\s+" + (chf / 1.1177).toFixed(4).replace(".", "\\.") + "\\s+\\+" + ((chf / 1.1177) / (chfPrev / 1.1269) * 100 - 100).toFixed(2).replace(".", "\\.") + "%[\\s\\S]*?DRV").test(mkt.text) && /AUD\/USD\s+ECB fixing, via the dollar rate\s+0\.6575/.test(mkt.text) && /USD\/TRY\s+not in the ECB fixing\s+N\/A/.test(mkt.text), (mkt.text.match(/FX[\s\S]{0,900}/) || [])[0]);
  ok("[A] markets: gold in euro DERIVED; silver / platinum / palladium N/A (plan); copper an IMF monthly average with its month", /XAU\/EUR\s+Gold in euro\s+3,699\.11[\s\S]*?DRV/.test(mkt.text) && /XAG · XPT · XPD\s+N\/A — silver, platinum, palladium: Twelve Data Grow plan/.test(mkt.text) && /CU\s+Copper \(\$\/t\) M\s+13,543\s+-0\.07%\s+—\s+Jul 2026/.test(mkt.text), (mkt.text.match(/METALS[\s\S]{0,600}/) || [])[0]);
  ok("[A] markets: energy spot with its date (EIA), a missing series N/A; agriculture monthly; crypto from Alpaca (the main pairs in order)", /WTI\s+WTI crude \(Cushing\) \(\$\/bbl\)\s+62\.31\s+\+0\.40%/.test(mkt.text) && /BRENT\s+Brent crude \(Europe\)\s+N\/A/.test(mkt.text) && /W\s+Wheat \(\$\/t\) M\s+228\.74\s+\+14\.57%/.test(mkt.text) && /CC\s+Cocoa\s+N\/A/.test(mkt.text) && /CRYPTO[\s\S]*BTC\/USD[\s\S]*86,000\s+\+1\.18%\s+\$1\.20B/.test(mkt.text) && mkt.text.indexOf("BTC/USD") < mkt.text.indexOf("ETH/USD"), (mkt.text.match(/ENERGY[\s\S]{0,900}/) || [])[0]);
  // indices
  await cmd(page, "IDX");
  const idx = await winOf(page, "WORLD INDICES");
  await page.waitForTimeout(900);
  const idx2 = await winOf(page, "WORLD INDICES");
  // expected 1M / YTD from the fixture itself (last close on or before the day)
  const H = IDX_HIST("SPX").points, at = (d) => H.filter((p) => p[0] <= d).pop(), m1d = new Date(today + "T12:00:00Z"); m1d.setUTCMonth(m1d.getUTCMonth() - 1);
  const y1d = new Date(today + "T12:00:00Z"); y1d.setUTCFullYear(y1d.getUTCFullYear() - 1); const lo52 = Math.min(...H.filter((p) => p[0] >= y1d.toISOString().slice(0, 10)).map((p) => p[3])).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pc = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%", ytd = pc((7800.12 / at((Number(today.slice(0, 4)) - 1) + "-12-31")[4] - 1) * 100), m1 = pc((7800.12 / at(m1d.toISOString().slice(0, 10))[4] - 1) * 100);
  ok("[A] indices: groups with level, change, day range, 1M / YTD / 52W DERIVED from the history, time and status", /UNITED STATES[\s\S]*S&P 500 SPX\s+7,800\.12\s+−18\.\d\d\s+-0\.24%\s+7,763\.34 – 7,804\.32/.test(idx2.text) && idx2.text.includes(m1) && idx2.text.includes(ytd) && idx2.text.includes(lo52 + " – 7,804.32") && /EUROPE[\s\S]*DAX DAX\s+25,104\.36/.test(idx2.text) && /ASIA-PACIFIC[\s\S]*Nikkei 225 N225\s+70,035\.71/.test(idx2.text), [m1, ytd, idx2.text.slice(0, 700)].join(" | "));
  ok("[A] indices: the other markets — SMI 15 minutes delayed (SIX), S&P/ASX 200 without a time (PARTIAL), SSE Composite, Ibovespa; STOXX 600 sectors; not connected named", /Swiss Market Index \(SMI\) SMI\s+14,478\.37[\s\S]*?15m/.test(idx2.text) && /S&P\/ASX 200 XJO\s+8,816\.90[\s\S]*?no time/.test(idx2.text) && /SSE Composite SHCOMP\s+3,735\.37/.test(idx2.text) && /AMERICAS & GLOBAL[\s\S]*Ibovespa IBOV\s+207,939\.03/.test(idx2.text) && /STOXX 600 SECTORS[\s\S]*Banks SX7P/.test(idx2.text) && /Hang Seng · KOSPI: no free official source/.test(idx2.text) && /Nifty 50: NSE refuses requests from the server/.test(idx2.text), idx2.text.slice(700, 2200));
  ok("[A] indices: Dow DERIVED (DJX × 100), a failed index N/A with the reason, not-connected ones named, STOXX history too short for YTD / 52W", /Dow Jones Industrial Average DJI[^\n]*[\s\S]*?DRV/.test(idx2.text) && /Russell 2000 RUT\s+N\/A — provider timed out/.test(idx2.text) && /FTSE 100 · CAC 40 · FTSE MIB: no free official source/.test(idx2.text) && /Hang Seng · KOSPI: no free official source/.test(idx2.text) && /EURO STOXX 50 SX5E[^\n]*\n?[^\n]*N\/A\s+N\/A/.test(idx2.text), idx2.text.slice(0, 1200));
  ok("[A] indices: the chart of the selected index (candles from Cboe history + the session in progress) with ranges", /S&P 500 SPX 7,800\.12/.test(idx2.text) && /420 sessions/.test(idx2.text) && /today from the delayed quote/.test(idx2.text) && (await page.$$eval(".ix-box canvas", (c) => c.length)) >= 1 && /1M\s*3M\s*6M\s*YTD\s*1Y\s*MAX/.test(idx2.text), idx2.text.slice(0, 300));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "WORLD INDICES"); w.querySelector('.ix-t tr[data-ix="DAX"]').click(); });
  await page.waitForTimeout(700);
  const idx3 = await winOf(page, "WORLD INDICES");
  ok("[A] indices: clicking DAX charts its STOXX closes (3 months, close only)", /^DAX DAX 25,104\.36/m.test(idx3.text) && /64 sessions/.test(idx3.text) && /STOXX publishes the last 3 months for free/.test(idx3.text) && /1M\s*3M\s*MAX/.test(idx3.text), idx3.text.slice(0, 300));
  await cmd(page, "IDX N225");
  await page.waitForTimeout(500);
  ok("[A] indices: IDX N225 selects the Nikkei", /NIKKEI 225 N225 70,035\.71/.test((await winOf(page, "WORLD INDICES")).text));
  // yields: MARKET (intraday quotes) by default, then the official curves
  await page.waitForTimeout(600);
  let yl = await winOf(page, "GOVERNMENT YIELDS");
  ok("[A] yields MARKET (default): countries by region with intraday quotes; Δ vs the previous close and past closes, 2s10s and spreads DERIVED; a country without a quote N/A; labelled market data", /MARKET · INTRADAY/.test(yl.text) && /IT Italy[^\n]*?2\.70\s+3\.20\s+3\.912\s+4\.60\s+-3\.8\s+\+10\.0\s+-20\.0\s+\+121\.2\s+\+125\.8\s+-10\.0/.test(yl.text) && /TH Thailand\s+N\/A no quote/.test(yl.text) && /market data:\s+CNBC quote service/.test(yl.text) && /ASIA-PACIFIC/.test(yl.text), [/MARKET · INTRADAY/.test(yl.text), /IT Italy[^\n]*?2\.70\s+3\.20\s+3\.912\s+4\.60\s+-3\.8\s+\+10\.0\s+-20\.0\s+\+121\.2\s+\+125\.8\s+-10\.0/.test(yl.text), /TH Thailand\s+N\/A no quote/.test(yl.text), /market data:\s+CNBC quote service/.test(yl.text)].join() + " " + yl.text.slice(-300));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-yc="IT"]').click(); });
  await page.waitForTimeout(800);
  yl = await winOf(page, "GOVERNMENT YIELDS");
  ok("[A] yields MARKET · IT: every quoted maturity with Δ 1D / 1W / 1M, last quote, bond and venue; curve and history charts", /ITALY · MARKET YIELDS/.test(yl.text) && /10Y\s+3\.912\s+-3\.8\s+\+10\.0\s+-20\.0/.test(yl.text) && /Tradeweb/.test(yl.text) && /3\.85%/.test(yl.text) && /daily closes/.test(yl.text) && (await page.$$eval(".yc-box canvas, .yh-box canvas", (c) => c.length)) >= 2, yl.text.slice(0, 700));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-yc="IN"]').click(); });
  await page.waitForTimeout(500);
  ok("[A] yields MARKET · IN: a quote older than 4 days is marked STALE, not replaced", /30Y\s+7\.779[\s\S]{0,120}STALE/.test((await winOf(page, "GOVERNMENT YIELDS")).text), (await winOf(page, "GOVERNMENT YIELDS")).text.slice(0, 600));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-ysrc="OFF"]').click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-yc="WORLD"]').click(); });
  await page.waitForTimeout(800);
  yl = await winOf(page, "GOVERNMENT YIELDS");
  ok("[A] yields WORLD: every country by region with 2Y / 5Y / 10Y / 30Y, changes, 2s10s and spreads; a failed source N/A with its reason", /AMERICAS\s+US United States/.test(yl.text) && /US United States[^\n]*\s4\.84\s/.test(yl.text) && /vs BUND/.test(yl.text) && /\+184\.0/.test(yl.text) && /DE Germany\s+N\/A provider timed out/.test(yl.text) && /Not connected \(no free official source found\): Brazil, Turkey, India/.test(yl.text), yl.text.slice(0, 900));
  ok("[A] yields WORLD: Italy = monthly average, marked M, month-dated, its spread vs the Bund of the same month", /IT Italy[^\n]*\bM\b[\s\S]*?Aug 2026 \(avg\)[\s\S]*?3\.98[\s\S]*?\+80\.6/.test(yl.text), (yl.text.match(/IT Italy[^\n]*/) || [])[0]);
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-yc="US"]').click(); });
  await page.waitForTimeout(700);
  yl = await winOf(page, "GOVERNMENT YIELDS");
  ok("[A] yields US: all 14 maturities with their changes, data date, source link, a curve chart and the 10Y history", /U\.S\. Department of the Treasury/.test(yl.text) && /data date/.test(yl.text) && TEN.every((t) => yl.text.includes(t)) && (await page.$$eval(".yc-box canvas, .yh-box canvas", (c) => c.length)) >= 2, yl.text.slice(0, 300));
  ok("[A] yields US: a maturity the source did not publish is N/A; changes in bp DERIVED; 2s10s", /\b1M\s+4\.00\s/.test(yl.text) && /1\.5M\s+N\/A/.test(yl.text) && /Δ PREV\.\s*DRV/.test(yl.text) && /2s10s \+[\d.]+ bp/.test(yl.text), (yl.text.match(/MATURITY[\s\S]{0,200}/) || [])[0]);
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-yc="EA"]').click(); });
  await page.waitForTimeout(400);
  ok("[A] yields EA: the ECB curve", /European Central Bank/.test((await winOf(page, "GOVERNMENT YIELDS")).text));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-yc="WORLD"]').click(); });
  await cmd(page, "CURVE US IT");
  const cv = await winOf(page, "YIELD CURVES");
  ok("[A] CURVE US IT: both curves on one chart (Italy one point: a monthly average) with a table by maturity", !!cv && /10Y\s+5\.32\s+3\.98/.test(cv.text) && (await page.$$eval(".crv-box canvas", (c) => c.length)) >= 1, cv && cv.text.slice(0, 500));
  // calendar
  await cmd(page, "CAL");
  let cal = await winOf(page, "ECONOMIC CALENDAR");
  ok("[A] calendar: WORLD view by default, high impact only (medium hidden), impact chip, forecast/previous as published, actual N/A, source FF", /WORLD/.test(cal.text) && /USD\s+CPI m\/m\s+HIGH\s+N\/A\s+0\.3%\s+0\.2%\s+—\s+FF/.test(cal.text) && /GBP\s+GDP m\/m\s+HIGH/.test(cal.text) && !/Ifo/.test(cal.text) && /Forex Factory/.test(cal.text), cal.text.slice(0, 500));
  ok("[A] calendar: NEXT HIGH-IMPACT banner skips past and medium events; status bar countdown", /NEXT HIGH-IMPACT · United States · CPI m\/m[\s\S]*in (?:4h5\d|5h00) · forecast 0\.3% · previous 0\.2%/.test(cal.text) && /^USD CPI m\/m in (?:4h5\d|5h00)$/.test(await page.$eval("#nextEv", (x) => x.textContent)) && (await page.$$eval(".win table.cal tr.next", (r) => r.length)) === 1, await page.$eval("#nextEv", (x) => x.textContent));
  await page.click('.win [data-imp="2"]'); await page.waitForTimeout(200);
  cal = await winOf(page, "ECONOMIC CALENDAR");
  ok("[A] calendar: HIGH + MEDIUM shows the medium event; forecast not published → N/A", /EUR\s+German Ifo Business Climate\s+MED\s+N\/A\s+N\/A\s+87\.7/.test(cal.text), cal.text.slice(0, 500));
  ok("[A] calendar: market reaction 15 min after a released high-impact event (DERIVED, 1-minute data)", /GBP\s+GDP m\/m\s+HIGH\s+N\/A\s+0\.1%\s+0\.0%\s+GBP \+0\.15/.test(cal.text), cal.text.slice(0, 600));
  await page.click('.win tr[data-ev="ff0"]'); await page.waitForTimeout(500);
  cal = await winOf(page, "ECONOMIC CALENDAR");
  ok("[A] calendar: click an event → reaction at +15 / +60 min and past releases from the archive", /REACTION\s+BEFORE\s+\+15 MIN\s+\+60 MIN/.test(cal.text) && /GBP vs USD\s+GBP\/USD\s+1\.3\s+\+0\.15%\s+\+0\.31%/.test(cal.text) && /PAST RELEASES[\s\S]*0\.2%\s+0\.2%/.test(cal.text), cal.text.slice(0, 900));
  await page.click('.win [data-ccy="USD"]'); await page.waitForTimeout(200);
  cal = await winOf(page, "ECONOMIC CALENDAR");
  ok("[A] calendar: currency filter (USD only)", /CPI m\/m/.test(cal.text) && !/GDP m\/m/.test(cal.text) && !/Ifo/.test(cal.text));
  await page.click('.win [data-ccy="ALL"]'); await page.click('.win [data-imp="3"]'); await page.waitForTimeout(200);
  await page.click('.win [data-cv="us"]'); await page.waitForTimeout(200);
  cal = await winOf(page, "ECONOMIC CALENDAR");
  ok("[A] calendar: official event with date, time, country, source; actual/forecast/previous/importance N/A", /2026-10-14\s+08:30\s+US\s+Consumer Price Index\s+N\/A\s+N\/A\s+N\/A\s+N\/A\s+BLS/.test(cal.text) && /U\.S\. Bureau of Labor Statistics/.test(cal.text), cal.text.slice(0, 300));
  // news
  await cmd(page, "N");
  const nw = await winOf(page, "NEWS");
  ok("[A] news: ALL = top publishers + central banks only, newest first, each with source tag and https link in a new tab", /Test FT markets headline\s*FT · MARKETS/.test(nw.text) && /Test Bloomberg economics headline\s*BLOOMBERG · ECONOMICS/.test(nw.text) && /Test WSJ markets headline\s*WSJ · MARKETS/.test(nw.text) && /Test MarketWatch top story\s*MARKETWATCH · TOP STORIES/.test(nw.text) && /Test Federal Reserve press release\s*FED/.test(nw.text) && /Test CNBC top news headline\s*CNBC · TOP NEWS/.test(nw.text) && /Test Economist finance headline\s*ECONOMIST · FINANCE & ECONOMICS/i.test(nw.text) && /Test Sole 24 Ore finanza headline\s*SOLE 24 ORE · FINANZA/i.test(nw.text) && /Test Reuters markets headline\s*REUTERS · MARKETS/i.test(nw.text) && ["Test FT", "Test Bloomberg", "Test WSJ", "Test MarketWatch", "Test Federal Reserve", "Test CNBC", "Test Economist", "Test Sole", "Test Reuters"].every((t, i, a) => !i || nw.text.indexOf(a[i - 1]) < nw.text.indexOf(t)) && (await page.$$eval(".news-item a.h", (a) => a.length === 9 && a.every((x) => /^https:\/\//.test(x.href) && x.target === "_blank"))), nw.text.slice(nw.text.indexOf("HEADLINES"), nw.text.indexOf("HEADLINES") + 900));
  ok("[A] news: window status from the headline sources on screen (all LIVE)", nw.pill === "LIVE", nw.pill);
  ok("[A] news: last check time and automatic 5-minute checks shown", /CHECKED \d{2}:\d{2}(:\d{2})? · AUTO EVERY 5 MIN/.test(nw.text), (nw.text.match(/HEADLINES[^\n]*/) || [])[0]);
  ok("[A] news: no wire tab and no SEC filings mixed into ALL", !/WIRE|GDELT/.test(nw.text) && !/AAPL · 8-K/.test(nw.text) && /ALL\s*FT\s*BLOOMBERG\s*WSJ\s*MARKETWATCH\s*CNBC\s*ECONOMIST\s*SOLE 24 ORE\s*REUTERS\s*CENTRAL BANKS\s*SEC FILINGS/.test(nw.text));
  await page.click('.win [data-src="BLOOMBERG"]'); await page.waitForTimeout(300);
  const nwB = await winOf(page, "NEWS");
  ok("[A] news: source filter (BLOOMBERG only)", /Test Bloomberg economics headline/.test(nwB.text) && !/Test FT markets headline/.test(nwB.text) && !/Test WSJ/.test(nwB.text));
  await page.click('.win [data-src="CB"]'); await page.waitForTimeout(300);
  const nwC = await winOf(page, "NEWS");
  ok("[A] news: CENTRAL BANKS tab = official releases only", /FED · ECB · BANK OF ENGLAND/.test(nwC.text) && /Test Federal Reserve press release/.test(nwC.text) && !/Test FT|Test WSJ/.test(nwC.text));
  await page.click('.win [data-src="SEC"]'); await page.waitForTimeout(300);
  const nwS = await winOf(page, "NEWS");
  ok("[A] news: SEC FILINGS tab lists the watchlist filings", /SEC FILINGS · WATCHLIST/.test(nwS.text) && /AAPL · 8-K · Apple Inc\./.test(nwS.text) && !/Test FT/.test(nwS.text));
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
  ok("[A] briefing: a chip opens the instrument at the edition's range (daily → 5D, older editions' 1W read as 5D)", await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent.startsWith("NVDA")); return !!w && w.querySelector('.tf[aria-pressed="true"]').textContent === "5D"; }));
  const strips = await page.$$eval(".brf-see", (d) => d.map((x) => ({ after: x.previousElementSibling && x.previousElementSibling.tagName, head: (() => { let e = x.previousElementSibling; while (e && e.tagName !== "H3") e = e.previousElementSibling; return e ? e.textContent : null; })(), text: x.innerText })));
  ok("[A] briefing: under each section, the windows that show it, with the reason from the same figures", strips.length === 3 && strips[0].head === "Equities" && /S&P 500 heat map · 1D\s*Constituents \+0\.41%/.test(strips[0].text) && /NVDA · biggest gain/.test(strips[0].text) && strips[1].head === "Rates and currencies" && strips[2].head === "Today" && /CPI m\/m/.test(strips[2].text), JSON.stringify(strips));
  if (SHOTS) { await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent.startsWith("BRIEFING")); w.querySelector(".w-max").click(); }); await page.waitForTimeout(400); await page.screenshot({ path: SHOTS + "/brief-strips.png" }); await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent.startsWith("BRIEFING")); w.querySelector(".w-max").click(); }); }
  const before = (await page.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent))).sort().join();
  await page.click('.brf-see button[data-win="3"]'); await page.waitForTimeout(800);
  const calOpen = await winOf(page, "ECONOMIC CALENDAR");
  ok("[A] briefing: a section window opens beside the briefing, in the state the edition gives it (calendar on the CPI release)", !!calOpen && /PAST RELEASES|REACTION/.test(calOpen.text) && await page.evaluate(() => { const ws = [...document.querySelectorAll(".win")], b = ws.find((w) => w.querySelector(".w-title").textContent.startsWith("BRIEFING")), c = ws.find((w) => w.querySelector(".w-title").textContent === "ECONOMIC CALENDAR"); return c.offsetLeft >= b.offsetLeft + b.offsetWidth; }), calOpen && calOpen.text.slice(0, 300));
  await page.click('[data-allwin="1"]'); await page.waitForTimeout(1200);
  const view = (await page.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent))).sort().join();
  if (SHOTS) await page.screenshot({ path: SHOTS + "/brief-view.png" });
  ok("[A] briefing: 'Open all as a view' lays out the briefing and its 4 windows only; the taskbar offers the way back", view === "BRF,CAL,GP,MAP,YLD" && !!(await page.$(".sys-btn.view-back")) && await page.evaluate(() => { const b = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent.startsWith("BRIEFING")); return b.offsetLeft === 0; }), view);
  await page.click(".sys-btn.view-back"); await page.waitForTimeout(900);
  const after = (await page.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent))).sort().join();
  ok("[A] briefing: back to my layout restores the windows that were open before the view", after === before && !(await page.$(".sys-btn.view-back")), before + " → " + after);
  await page.click('.win [data-period="evening"]'); await page.waitForTimeout(500);
  br = await winOf(page, "BRIEFING");
  ok("[A] briefing: an edition the scheduled run is writing is not written by the terminal; shown as SCHEDULED with its time", /SCHEDULED · the evening edition for \d{4}-\d{2}-\d{2} is written automatically at \d{2}:\d{2}/.test(br.text) && /scheduled · \d{2}:\d{2}/.test(br.text) && brfState.writes.length === 1 && !brfState.writes.some((w) => /evening/.test(w)), br.text.slice(0, 400));
  ok("[A] briefing: automatic writing status shown (last scheduled run)", /Automatic writing: last scheduled run/.test(br.text));
  await page.click('.win [data-period="weekly"]'); await page.waitForTimeout(500);
  br = await winOf(page, "BRIEFING");
  ok("[A] briefing: an empty period says when it is written (no text invented)", /No weekly briefing yet\. Written automatically on Saturday mornings at 08:00/.test(br.text) && brfState.writes.length === 1);
  await page.click('.win [data-period="daily"]'); await page.waitForTimeout(300);
  // world exchanges
  await cmd(page, "EXCH"); await page.waitForTimeout(900);
  let ex = await winOf(page, "WORLD MARKETS");
  const wm = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "WORLD MARKETS"); return { open: w.querySelectorAll(".wm-bar.wm-open").length, next: w.querySelectorAll(".wm-bar.wm-next").length, rows: w.querySelectorAll(".wm-row:not(.wm-ax)").length, now: w.querySelectorAll(".wm-now").length }; });
  ok("[A] world markets (timeline): 15 markets on a 24-hour axis in your time, open/closed and countdowns from the provider, the open session green, the next one from the provider's open", /1 of 15 open · your local time/.test(ex.text) && /OPEN\s+London[\s\S]*?closes in 3h30/.test(ex.text) && /CLOSED\s+New York\s+-0\.24%\s+opens in 2h15/.test(ex.text) && /CLOSED\s+Tokyo\s+-0\.92%\s+opens in 14h00/.test(ex.text) && /N\/A\s+Sydney/.test(ex.text) && wm.open === 1 && wm.next === 2 && wm.rows === 15 && wm.now === 15, JSON.stringify(wm) + " " + ex.text.slice(0, 600));
  await page.click('.win [data-exv="table"]'); await page.waitForTimeout(300);
  ex = await winOf(page, "WORLD MARKETS");
  ok("[A] exchanges: open now / next open from the provider, grouped by region with local time and countdown", /OPEN NOW · LSE/.test(ex.text) && /NEXT · NYSE opens in 2h 15m/.test(ex.text) && /EUROPE & AFRICA · 1\/1 OPEN/.test(ex.text) && /LSE\s+London\s+OPEN\s+closes in 3h 30m/.test(ex.text) && /NYSE\s+New York\s+CLOSED\s+opens in 2h 15m/.test(ex.text) && !/Other Exchange/.test(ex.text) && /not in the provider's list: XNAS/.test(ex.text), ex.text.slice(0, 700));
  ok("[A] exchanges: the top bar shows how many markets are open (every exchange the provider reports)", /^2\/4 open$/.test(await page.$eval("#mktsOpen", (x) => x.textContent)));
  await page.click('.win [data-scope="all"]'); await page.waitForTimeout(200);
  ex = await winOf(page, "WORLD MARKETS");
  ok("[A] exchanges: ALL lists every exchange the provider returns (local time N/A without a time zone)", /Other Exchange/.test(ex.text));
  // heat maps: other universes and the FX matrix
  await cmd(page, "MAP"); await page.waitForTimeout(400);
  await page.click('.win [data-mapu="CTRY"]'); await page.waitForTimeout(700);
  let hm = await winOf(page, "COUNTRIES HEAT MAP");
  ok("[A] heat maps: countries via ETFs — same endpoints with ?u=CTRY, tiles named by country, equal size (traded value optional)", !!hm && spxCalls.some((c) => c.includes("u=CTRY")) && /ITALY/.test(hm.text) && /JAPAN/.test(hm.text) && /TRADED VALUE/.test(hm.text) && /size: equal/.test(hm.text) && /ETF prices, not index levels/.test(hm.text), hm && hm.text.slice(0, 300));
  ok("[A] heat maps: change from real prices (EWI 50.5 vs 50 → +1.00%)", await page.evaluate(() => { const t = document.querySelector('.spx-t[data-s="EWI"]'); return !!t && /\+1\.00%/.test(t.textContent); }));
  await page.click('.win [data-mapu="FX"]'); await page.waitForTimeout(1500);
  hm = await winOf(page, "FX HEAT MAP");
  ok("[A] heat maps: FX matrix from live quotes vs USD (crosses DERIVED), strength row", !!hm && /STRENGTH/.test(hm.text) && /BASE \\ QUOTE/.test(hm.text) && quoteBatches.some((b) => b.syms.includes("USD/CHF")) && /DRV|DERIVED/.test(hm.text + hm.pill), hm && hm.text.slice(0, 300));
  await page.click('.win [data-mapu="SPX"]'); await page.waitForTimeout(300);
  // portfolio: starts empty, a trade is recorded, valued from live quotes in EUR, then deleted
  await cmd(page, "PF"); await page.waitForTimeout(600);
  let pf = await winOf(page, "PORTFOLIO");
  ok("[A] portfolio: starts empty — nothing preloaded, value €0.00", /Your portfolio is empty/.test(pf.text) && /MARKET VALUE\s*€0\.00/.test(pf.text), pf.text.slice(0, 300));
  await page.fill('.pf-form input[name="sym"]', "AAPL"); await page.click(".pf-chk"); await page.waitForTimeout(800);
  ok("[A] portfolio: the symbol is checked with the provider; currency and last price prefilled", (await page.inputValue('.pf-form input[name="price"]')) === "250" && /AAPL · .* last \$250\.00/.test((await winOf(page, "PORTFOLIO")).text));
  await page.fill('.pf-form input[name="qty"]', "10"); await page.fill('.pf-form input[name="price"]', "200"); await page.fill('.pf-form input[name="fees"]', "1"); await page.fill('.pf-form input[name="date"]', "2026-10-01");
  await page.click('.pf-form button[type="submit"]'); await page.waitForTimeout(1500);
  pf = await winOf(page, "PORTFOLIO");
  ok("[A] portfolio: trade sent as JSON (side, symbol, qty, price, currency from the quote, fees, date)", pfState.posts.length === 1 && pfState.posts[0].sym === "AAPL" && pfState.posts[0].qty === 10 && pfState.posts[0].price === 200 && pfState.posts[0].ccy === "USD" && pfState.posts[0].fees === 1 && pfState.posts[0].date === "2026-10-01", JSON.stringify(pfState.posts));
  // 10 × 250 USD at the live EUR/USD 1.12601 = €2,220.23; cost (10 × 200 + 1) / 1.10 = €1,819.09; P&L €401.14
  ok("[A] portfolio: value in EUR at the live rate, cost at the trade-date ECB rate (fees in the average cost), P&L and weight", /MARKET VALUE\s*€2,220\.23/.test(pf.text) && /COST \(EUR\)\s*€1,819\.09/.test(pf.text) && /UNREALISED P&L\s*€401\.14/.test(pf.text) && /AAPL[\s\S]*10[\s\S]*200\.1 USD[\s\S]*€2,220\.23[\s\S]*100\.0%[\s\S]*€401\.14/.test(pf.text), pf.text.slice(0, 900));
  ok("[A] portfolio: quotes requested for the position and the EUR/USD rate", quoteBatches.some((b) => b.syms.includes("EUR/USD")));
  await page.click(".pf-del"); await page.waitForTimeout(200); await page.click(".pf-del-yes"); await page.waitForTimeout(800);
  pf = await winOf(page, "PORTFOLIO");
  ok("[A] portfolio: delete asks for confirmation in the page, then removes the trade", pfState.deletes.length === 1 && /Your portfolio is empty/.test(pf.text));
  // global checks
  const body = await page.evaluate(() => document.body.innerText);
  ok("[A] no simulated / mock / sample / model wording anywhere", !FORBIDDEN.test(body), (body.match(new RegExp(".{0,30}(" + FORBIDDEN.source + ").{0,30}", "i")) || [])[0]);
  ok("[A] no NaN / undefined rendered", !/NaN|undefined/.test(body));
  ok("[A] top: one row — brand, a compact command line, the taskbar (window tools as icons) and the status", !!(await page.$("#cmdbar #tabs .tb-tile")) && !(await page.$("#tabs #fnMenuBtn")) && !!(await page.$("#dock #fnMenuBtn")) && (await page.$eval("#cmdbar", (e) => e.getBoundingClientRect().height)) <= 40 && (await page.$eval(".cmd-wrap", (e) => e.getBoundingClientRect().width)) <= 260);
  ok("[A] dock (Nico's style): one row = a few functions + the data badge; the ticker tape off by default", (await page.$$eval("#fnbar .fn", (b) => b.map((x) => x.textContent).join(","))) === "☰ FUNCTIONS,INDICES,WATCHLIST,YIELDS,CALENDAR,HEAT MAPS,BRIEFING,NEWS,MARKETS,PORTFOLIO,? HELP" && !!(await page.$("#dock #dataBadge")) && !(await page.$("#sess, #breadth, #asof")) && (await page.$eval("#strip", (e) => e.hidden && getComputedStyle(e).display === "none")) && (await page.$eval("#dock", (e) => e.getBoundingClientRect().height)) <= 34);
  ok("[A] browser calls only this site's /api (no provider hosts, no keys)", !requests.some((u) => /twelvedata\.com|treasury\.gov|ecb\.europa|bls\.gov|bea\.gov|gdeltproject|sec\.gov|apikey=|token=/i.test(u)));
  ok("[A] no JavaScript errors", errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "TILE"); await page.waitForTimeout(800); await page.screenshot({ path: SHOTS + "/e2e-t05.png" }); }
  await page.close();
}

// =============== B. every provider down: N/A everywhere, nothing invented ===============
{
  const DOWN = {
    yieldsIds: () => ({ status: 502, body: { curves: {}, errors: { US: { error: "provider_timeout", status: "N/A" }, EA: { error: "provider_error", status: "N/A" } } } }),
    indices: () => ({ status: 502, body: { error: "provider_unreachable", status: "N/A" } }),
    mkt: () => ({ status: 502, body: { error: "provider_unreachable", status: "N/A" } }),
    markets: () => ({ status: 502, body: { error: "provider_unreachable", status: "N/A" } }),
    spx: () => ({ status: 502, body: { error: "provider_unreachable", status: "N/A" } }),
    noEia: true,
    briefs: () => ({ status: 503, body: { error: "storage_not_configured", status: "N/A" } }),
    quote: (syms) => ({ status: 429, body: { quotes: {}, errors: Object.fromEntries(syms.map((s) => [s, { error: "rate_limited", status: "N/A" }])), meta: {} } }),
    history: () => ({ status: 429, body: { error: "rate_limited", status: "N/A" } }),
    ext: (name) => ({ status: name === "briefing" ? 503 : 502, body: name === "headlines" ? { items: [], feeds: [], status: "N/A", error: "provider_unreachable" } : name === "yields" ? { curves: {}, errors: { US: { error: "provider_timeout", status: "N/A" }, EA: { error: "provider_error", status: "N/A" } }, notConnected: [] } : name === "briefing" ? { error: "model_unavailable", status: "N/A" } : { events: [], items: [], filings: [], sources: [], errors: { X: { error: "provider_unreachable", status: "N/A" } } } }),
  };
  const { page, errors } = await openTerminal(DOWN);
  await page.waitForFunction(() => /N\/A/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  for (const c of ["CAL", "N", "BRF", "IDX", "MKT"]) await cmd(page, c);
  await page.waitForTimeout(1200);
  const body = await page.evaluate(() => document.body.innerText);
  ok("[B] no price anywhere (no fallback value)", !/\$\d/.test(body) && !/\d\.\d{3,}/.test(body), (body.match(/.{20}(\$\d|\d\.\d{3,}).{10}/) || [])[0]);
  const ymk = await winOf(page, "GOVERNMENT YIELDS");
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "GOVERNMENT YIELDS"); w.querySelector('[data-ysrc="OFF"]').click(); });
  await page.waitForTimeout(600);
  ok("[B] yields: market quotes N/A with the reason; official curves N/A with the provider reason; no curve", /N\/A — market yields unavailable \(provider unreachable\)/.test(ymk.text) && /US United States\s+N\/A provider timed out/.test((await winOf(page, "GOVERNMENT YIELDS")).text), ymk.text.slice(0, 300) + " | " + (await winOf(page, "GOVERNMENT YIELDS")).text.slice(0, 300));
  ok("[B] indices: every group N/A with the reason, no level", /UNITED STATES\s+N\/A — provider unreachable[\s\S]*EUROPE\s+N\/A — provider unreachable/.test((await winOf(page, "WORLD INDICES")).text) && !/\d,\d{3}\.\d\d/.test((await winOf(page, "WORLD INDICES")).text), (await winOf(page, "WORLD INDICES")).text.slice(0, 300));
  ok("[B] calendar and news: NO DATA with the reason", /NO DATA/.test((await winOf(page, "ECONOMIC CALENDAR")).text) && /provider unreachable/.test((await winOf(page, "NEWS")).text));
  ok("[B] briefing: N/A, no text produced", /briefing archive unavailable/.test((await winOf(page, "BRIEFING")).text) && (await winOf(page, "BRIEFING")).pill === "N/A" && !(await page.$(".brf-art")));
  ok("[B] no NaN rendered; no JavaScript errors", !/NaN/.test(body) && errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "TILE"); await page.waitForTimeout(600); await page.screenshot({ path: SHOTS + "/e2e-t05-down.png" }); }
  await page.close();
}
// ---------- [B2] Twelve Data's daily credits used up: the page says when quotes resume and stops asking ----------
{
  const until = new Date(Date.now() + 3 * 3600e3).toISOString();
  let quoteCalls = 0;
  const LIM = { ...OK_API, quote: (syms) => { quoteCalls++; return { status: 429, body: { quotes: {}, errors: Object.fromEntries(syms.map((s) => [s, { error: "daily_limit", status: "N/A" }])), meta: { dailyLimitUntil: until } } }; } };
  const { page, errors } = await openTerminal(LIM);
  await page.waitForTimeout(2500);
  const ts = await page.$eval("#tsTime", (e) => ({ t: e.textContent, c: e.className }));
  const resume = await page.evaluate((u) => new Date(u).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), until);
  const n = quoteCalls;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await page.waitForTimeout(3000);
  ok("[B2] daily credits used up: the top bar says when quotes resume; no further quote request until then", /⏸ quotes resume/.test(ts.t) && ts.t.includes(resume) && /ts-pause/.test(ts.c) && quoteCalls === n && errors.length === 0, JSON.stringify({ ts, resume, n, quoteCalls, errors }));
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
  ok("[E] plan shown per listing: BASIC, CNBC for a listing outside the plan that CNBC quotes (SIX → NOVN-CH), GROW+ for one it cannot; source + time, LIVE pill", /BASIC/.test(sr.text) && /CNBC/.test(sr.text) && /GROW\+/.test(sr.text) && /3 listings · 2 quotable \(Twelve Data Basic, or CNBC for listings outside the plan\) · source Twelve Data symbol_search/.test(sr.text) && sr.pill === "LIVE", sr.text.slice(0, 600));
  ok("[E] search costs no quote: no /api/quote for search results", !quoteBatches.some((b) => b.syms.some((x) => /NOVN|NVS/.test(x))));
  await page.waitForTimeout(600); sr = await winOf(page, "SYMBOL SEARCH");
  ok("[E] SRCH also lists CNBC's own lookup (non-U.S., not already quotable above), opened as C:<code>", /MORE LISTINGS · CNBC SYMBOL LOOKUP/.test(sr.text) && /C:NOV-DE\s+Novartis AG\s+XETRA\s+DE/.test(sr.text) && !/C:NVS/.test(sr.text) && !/C:NOVN-CH/.test(sr.text), sr.text.slice(-600));
  ok("[E] +WL disabled for a listing outside the plan that CNBC cannot quote either", await page.$eval('[data-add="NOVN:NEOE"]', (b) => b.disabled) && !(await page.$eval('[data-add="NOVN:XSWX"]', (b) => b.disabled)));
  await page.click('[data-open="NOVN:XSWX"]'); await page.waitForTimeout(800);
  const gpCh = await winOf(page, "NOVN:XSWX");
  ok("[E] OPEN on a listing outside the plan that CNBC quotes → CNBC's price in its own currency, labelled CNBC", !!gpCh && /126\.50/.test(gpCh.text) && /CHF/.test(gpCh.text) && requests.some((u) => /NOVN%3AXSWX|NOVN:XSWX/.test(u) && /\/api\/quote/.test(u)), gpCh && gpCh.text.slice(0, 300));
  ok("[E] its window shows venue, country and currency", /SIX · XSWX · Switzerland · CHF · Common Stock|Swiss Exchange/.test(gpCh.text), gpCh.text.slice(0, 300));
  await page.evaluate(() => document.querySelector('[data-open="NOVN:NEOE"]').click()); await page.waitForTimeout(700);
  const gpNe = await winOf(page, "NOVN:NEOE");
  ok("[E] a listing neither in the plan nor at CNBC: N/A with the reason, and OTHER LISTINGS searches the company's other listings", !!gpNe && /N\/A — quote and history unavailable/.test(gpNe.text) && (await page.$(".gp-alt")) !== null, gpNe && gpNe.text.slice(0, 300));
  await cmd(page, "C:700-HK"); await page.waitForTimeout(700);
  ok("[E] C:<CNBC code> typed in the command line opens the listing directly (not a search)", (await page.$$eval(".win .w-title", (t) => t.map((x) => x.textContent))).some((x) => x.startsWith("C:700-HK")));
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

// =============== G. Italian interface: labels translated, data untouched, briefing written in Italian ===============
{
  const { page, errors, requests, brfState } = await openTerminal(OK_API, htmlFast, () => { try { localStorage.setItem("at-lang", "it"); } catch (e) {} });
  await page.waitForFunction(() => /LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(800);
  ok("[G] Italian: launcher, page language and toggle", (await page.$$eval("#fnbar .fn", (b) => b.map((x) => x.textContent).join(",")))=== "☰ FUNZIONI,INDICI,WATCHLIST,RENDIMENTI,CALENDARIO,HEAT MAP,BRIEFING,NEWS,MERCATI,PORTAFOGLIO,? AIUTO" && (await page.evaluate(() => document.documentElement.lang)) === "it" && (await page.$eval('#cmdbar [data-lang="it"]', (b) => b.getAttribute("aria-pressed"))) === "true", await page.$$eval("#fnbar .fn", (b) => b.map((x) => x.textContent).join(",")));
  await cmd(page, "CAL"); await page.waitForTimeout(400);
  let cal = await winOf(page, "CALENDARIO ECONOMICO");
  ok("[G] Italian: calendar labels translated, event names as published, Italian dates", !!cal && /ORA \(LOCALE\)\s+VALUTA\s+EVENTO\s+IMPATTO\s+EFFETTIVO\s+PREVISTO\s+PRECED\./.test(cal.text) && /USD\s+CPI m\/m\s+ALTO/.test(cal.text) && /PROSSIMO ALTO IMPATTO/.test(cal.text) && /German Ifo|GDP m\/m/.test(cal.text) && /\b(LUN|MAR|MER|GIO|VEN|SAB|DOM)\b/.test(cal.text), cal && cal.text.slice(0, 600));
  await cmd(page, "N"); await page.waitForTimeout(500);
  const nw = await winOf(page, "NEWS");
  ok("[G] Italian: news labels translated, headlines unchanged", /TITOLI · .*PIÙ RECENTI PRIMA/.test(nw.text) && /Test FT markets headline/.test(nw.text) && /BANCHE CENTRALI/.test(nw.text));
  await cmd(page, "BRF"); await page.waitForTimeout(1200);
  let br = await winOf(page, "BRIEFING");
  ok("[G] Italian: the edition is requested and shown in Italian (sections, title, disclaimer)", requests.some((u) => /\/api\/briefs\/item\?id=daily-[\d-]+&lang=it/.test(u)) && /I componenti salgono mentre l'euro cede/.test(br.text) && /IN UNA RIGA/i.test(br.text) && /Non è una consulenza finanziaria/.test(br.text) && /Verifica delle cifre/.test(br.text), br.text.slice(0, 500));
  await page.click('.brf-list button:not(.on)'); await page.waitForTimeout(700);
  br = await winOf(page, "BRIEFING");
  ok("[G] Italian: an edition without the Italian version says so and offers to write it", /La versione italiana di questa edizione non è ancora stata scritta/.test(br.text) && /SCRIVI IN ITALIANO/.test(br.text) && /Yesterday's edition/.test(br.text), br.text.slice(0, 400));
  await page.click(".brf-it"); await page.waitForTimeout(900);
  br = await winOf(page, "BRIEFING");
  ok("[G] Italian: written in Italian from the edition's data on request", brfState.langPosts === 1 && /Edizione di ieri/.test(br.text) && !/non è ancora stata scritta/.test(br.text));
  await cmd(page, "PF"); await page.waitForTimeout(600);
  const pf = await winOf(page, "PORTAFOGLIO");
  ok("[G] Italian: portfolio labels translated; the trade side keeps its value for the server", !!pf && /VALORE DI MERCATO/.test(pf.text) && /AGGIUNGI OPERAZIONE/.test(pf.text) && /Il portafoglio è vuoto/.test(pf.text) && (await page.$eval('.pf-form select[name="side"]', (s) => s.value)) === "BUY" && (await page.$eval('.pf-form select[name="side"] option', (o) => o.textContent)) === "ACQUISTO");
  // every window open in Italian: the page stays responsive (a translation that re-matched itself once froze it)
  for (const c of ["EXCH", "MAP", "MOV", "SCR", "COMP", "CORR", "HEAT", "SET", "YLD", "MKT", "WL", "SRCH"]) await cmd(page, c);
  await page.waitForTimeout(1500);
  const wmIt = (await winOf(page, "MERCATI MONDIALI")).text;
  ok("[G] Italian: world markets timeline in Italian (aperta / chiusa, apre tra / chiude tra, city names)", /1 su 15 aperte · la tua ora locale/.test(wmIt) && /APERTA\s+Londra[\s\S]*?chiude tra 3h\d\d/.test(wmIt) && /CHIUSA\s+New York\s+-0\.24%\s+apre tra 2h1\d/.test(wmIt), wmIt.slice(0, 500));
  await page.evaluate(() => document.querySelector('.win [data-exv="table"]').click()); await page.waitForTimeout(400);
  const t0 = Date.now(); const regions = await page.evaluate(() => [...document.querySelectorAll(".ex-t tr.grp td")].map((td) => td.textContent).join(" | "));
  ok("[G] Italian: all windows open, page responsive, region names translated once", Date.now() - t0 < 2000 && /ASIA-PACIFICO · 0\/1 APERTE/.test(regions) && !/PACIFICOO/.test(regions) && /EUROPA E AFRICA · 1\/1 APERTE/.test(regions), regions);
  await page.click('#cmdbar [data-lang="en"]'); await page.waitForTimeout(600);
  ok("[G] back to English: launcher and windows in English again", (await page.$$eval("#fnbar .fn", (b) => b.map((x) => x.textContent).join(","))).startsWith("☰ FUNCTIONS,INDICES,WATCHLIST,YIELDS") && !!(await winOf(page, "ECONOMIC CALENDAR")) && (await page.evaluate(() => document.documentElement.lang)) === "en");
  const body = await page.evaluate(() => document.body.innerText);
  ok("[G] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(body) && !/NaN|undefined/.test(body) && errors.length === 0, errors.join(" | "));
  await page.close();
}


// =============== H. function menu and its functions (Nico-style menu; every value real-shaped or N/A) ===============
{
  const { page, errors, requests, t7 } = await openTerminal(OK_API);
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.click("#fnMenuBtn"); await page.waitForTimeout(250);
  const menu = await page.evaluate(() => ({ on: document.querySelector("#fnmenu").classList.contains("on"), cats: [...document.querySelectorAll(".fm-col h4")].map((h) => h.textContent).join("|"), codes: [...document.querySelectorAll(".fm-i code")].map((c) => c.textContent).join(","), na: [...document.querySelectorAll(".fm-i")].filter((b) => b.querySelector(".fm-na")).map((b) => b.dataset.fn).join() }));
  ok("[H] menu: six categories with their codes, N/A marked where there is no source", menu.on && menu.cats === "MARKETS|ETF|RATES & MACRO|ANALYSIS|MY STUFF|LAYOUT" && menu.codes.startsWith("IDX,EQ,FX,CMDTY,CRYPTO,FUT,COT,BOARD,WL,HEAT,MOV,SCR,RDT,MKT,EXCH,BRIEF,NEWS,EFS,EFP,EFC,HOLD,EXPO,UCITS,ETF,YLD,CURVE,BOND,YAS,SPRD,CB,CAL,ERN,FXM,FCRV,DES,FA,CN,OMON,WS,COMP,PERF,CROSS,CORR,BT,MC,VAR,VOL,DIST,BETA,FACT,EF,SEAS,PORT,PORTS,PFA,PLAB,WIF,ALRT,NOTE,SYS,SET,VIEW,CLOSE,UNDO,TILE,SPLIT,YEAR,HIDE,TOUR,HELP") && menu.na === "", JSON.stringify(menu));
  await page.fill("#fnmenu .fm-in", "option"); await page.waitForTimeout(150);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/t07-menu.png" });
  ok("[H] menu: typing filters by code or name", (await page.$$eval(".fm-i code", (c) => c.map((x) => x.textContent).join())) === "OMON");
  await page.press("#fnmenu .fm-in", "Enter"); await page.waitForTimeout(900);
  let om = await winOf(page, "OPTIONS · ");
  ok("[H] menu: Enter opens the function and closes the menu", !!om && !(await page.evaluate(() => document.querySelector("#fnmenu").classList.contains("on"))));
  // OMON
  ok("[H] OMON: expirations, calls / strike / puts, underlying, ATM IV and put/call OI DERIVED", /UNDERLYING\s+\$251\.20/.test(om.text) && /OI\s+IV\s+Δ\s+LAST\s+BID\*\s+ASK\*\s+STRIKE\s+BID\*\s+ASK\*\s+LAST\s+Δ\s+IV\s+OI/.test(om.text) && /1\.2K\s+27\.0%\s+0\.50\s+9\.10\s+9\.00\s+9\.30\s+250\s+8\.00\s+8\.20\s+—\s+-0\.50\s+29\.0%\s+800/.test(om.text) && /ATM IV\s*DRV\s+28\.0%/.test(om.text) && /PUT \/ CALL OI\s*DRV\s+0\.67/.test(om.text), om.text.slice(0, 900));
  ok("[H] OMON: indicative feed marked PARTIAL, with the reason", /PART\s+Alpaca free options feed \(indicative\)/.test(om.text) && /indicative, not the exchanges' actual quotes/.test(om.text), om.text.slice(-500));
  await shotWin(page, "OPTIONS · ", "t07-omon");
  ok("[H] OMON: the strike nearest the spot is framed", (await page.$$eval("table.opt tr.atm .k-strike", (t) => t.map((x) => x.textContent).join())) === "250");
  // DES via the command line, both orders
  await cmd(page, "DES AAPL"); await page.waitForTimeout(1200);
  let des = await winOf(page, "DES · AAPL");
  ok("[H] DES: SEC profile (industry, fiscal year end, address) and filings", /Apple Inc\./.test(des.text) && /Electronic Computers/.test(des.text) && /27 September/.test(des.text) && /CUPERTINO/.test(des.text) && /10-K/.test(des.text), des.text.slice(0, 500));
  ok("[H] DES: fundamentals as filed — revenue, YoY DERIVED, latest quarter", /Revenue\s+\$416\.16B[\s\S]{0,40}\$391\.04B\s+\+6\.4%\s+\$94\.04B/.test(des.text), (des.text.match(/Revenue[^\n]*\n?[^\n]*/) || [])[0]);
  ok("[H] DES: market cap = live price × cover-page shares; P/E on last fiscal year EPS when no 12-month figure (DERIVED)", /MARKET CAP\s*DRV\s+\$3\.70T/.test(des.text) && /P\/E\s*DRV\s+40\.0×\s+price ÷ diluted EPS of the last fiscal year/.test(des.text) && /NET MARGIN\s*DRV\s+26\.9%/.test(des.text), des.text.slice(des.text.indexOf("VALUATION"), des.text.indexOf("VALUATION") + 400));
  await shotWin(page, "DES · AAPL", "t07-des");
  await cmd(page, "ZZQ DES"); await page.waitForTimeout(700);
  des = await winOf(page, "DES · ZZQ");
  ok("[H] DES: a non-SEC symbol is N/A with the reason (no profile invented)", /N\/A — not an SEC registrant/.test(des.text) && des.pill === "N/A", des.text.slice(0, 300));
  // CB
  await cmd(page, "CB"); await page.waitForTimeout(900);
  const cbw = await winOf(page, "CENTRAL BANKS");
  ok("[H] CB COMPARE: BIS policy rate with its date, last move (effective day, bp, level before), 12-month change, moves, next decision from the bank's calendar; priced = market yield − policy rate (DERIVED)", /Federal Reserve\s+USD\s*ⓘ?\s+3\.88%\s+13 Oct 2026\s+17 Sept? 2026\s+−25\s+4\.13%\s+−50\s+2\s+\w{3},? \d{2} \w{3,4}\s+in 8d\s+\+11\.5\s+—\s+-36\.3/.test(cbw.text) && /European Central Bank\s+EUR\s*ⓘ?\s+2\.50%[\s\S]{0,120}not yet published\s+—\s+-19\.0\s+-9\.0/.test(cbw.text), cbw.text.slice(0, 900));
  ok("[H] CB COMPARE: a stopped BIS series shows its last month (STALE); an area with no data N/A; a move known only by month", /Banco Central de la República Argentina\s+ARS\s*ⓘ?\s+29\.00%\s+Jun 2025/.test(cbw.text) && /Norges Bank\s+NOK\s+N\/A — no recent figure from the BIS/.test(cbw.text) && /Bank of Japan\s+JPY\s+1\.25%\s+13 Oct 2026\s+Jul 2026\s+\+25\s+1\.00%/.test(cbw.text), cbw.text.slice(0, 1200));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "CENTRAL BANKS"); w.querySelector('[data-cbv="HIST"]').click(); });
  await page.waitForTimeout(800);
  const cbh = await winOf(page, "CENTRAL BANKS");
  ok("[H] CB HISTORY: end-of-month BIS rates since 2006 on one chart, with latest / 1 and 5 years earlier / high / low per bank", (await page.$$eval(".cbh-box canvas", (c) => c.length)) >= 1 && /Fed\s+USD\s+4\.00%\s+Sept? 2026\s+5\.00%\s+Sept? 2025\s+5\.50%\s+Mar 2020\s+6\.50%\s+Jan 2006/.test(cbh.text) && /HIGH SINCE 2006/.test(cbh.text) && /BIS/.test(cbh.text), cbh.text.slice(0, 900));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent === "CENTRAL BANKS"); w.querySelector('[data-cbv="OFF"]').click(); });
  await page.waitForTimeout(800);
  const cb = await winOf(page, "CENTRAL BANKS");
  ok("[H] CB: published policy rates; the level before the last change with its date; Fed target range and its last move; failed / missing sources N/A", /European Central Bank\s+EUR\s+Deposit facility rate\s+2\.00%\s+2\.25%\s+\(-25 bp\)\s+changed 11 Jun 2026/.test(cb.text) && /FOMC target range\s+3\.58%\s+3\.50–3\.75%\s+daily\s+3\.75–4\.00% changed 18 Sept? 2026/.test(cb.text) && /Bank Rate\s+3\.75%\s+4\.00%\s+\(-25 bp\)\s+changed 07 Aug 2026/.test(cb.text) && /2\.50%\s+no change since 06 Oct 2023/.test(cb.text) && /Swiss National Bank\s+CHF\s+N\/A/.test(cb.text) && /Bank of Japan\s+JPY\s+no same-day official source connected/.test(cb.text), cb.text.slice(0, 900));
  await shotWin(page, "CENTRAL BANKS", "t07-cb");
  // SPRD — any pair from CNBC market yields (default), then the official 2s10s
  await cmd(page, "SPRD"); await page.waitForTimeout(1500);
  await shotWin(page, "SPREADS", "t07-sprd");
  let sp = await winOf(page, "SPREADS");
  ok("[H] SPRD market: BTP–Bund 10Y from the two intraday yields; daily-bar history with 1W/1M/3M changes, range, percentile and z-score DERIVED", /BTP–BUND 10Y\s*DRV/.test(sp.text) && /LATEST QUOTES\s+\+125\.8 bp/.test(sp.text) && /LAST DAILY BAR\s+\+\d{3}\.\d bp/.test(sp.text) && /Δ 1M\s+[+-]\d+\.\d bp/.test(sp.text) && /PERCENTILE\s+\d+%/.test(sp.text) && /Z-SCORE\s+[+-−]?\d\.\d\d/.test(sp.text) && /IT 10Y − DE 10Y: CNBC's daily bars/.test(sp.text), sp.text.slice(sp.text.indexOf("BTP–BUND"), sp.text.indexOf("BTP–BUND") + 700));
  await page.click('[data-spm="OFF"]'); await page.waitForTimeout(900);
  sp = await winOf(page, "SPREADS");
  ok("[H] SPRD official: euro-area 2s10s from the ECB history, changes DERIVED; U.S. latest from the Treasury curve", /SPREAD\s+85\.9 bp/.test(sp.text) && /Δ 1W\s+\+0\.\d bp/.test(sp.text) && /UNITED STATES · 10Y − 2Y\s+\d+\.\d bp/.test(sp.text) && /FRED API key/.test(sp.text) && (await page.$$eval(".sp-cv", (c) => c.length)) === 1, sp.text.slice(0, 700));
  // CMDTY + FCRV — CNBC futures (served by the real Worker code from CNBC-format fixtures)
  await cmd(page, "CMDTY"); await page.waitForTimeout(2500);
  const cm = await winOf(page, "COMMODITIES");
  ok("[H] CMDTY: front-month futures from CNBC with contract month, unit, change, 1W/1M/3M/YTD/1Y DERIVED from daily bars, time and real-time mark", /ENERGY · FUTURES \(CNBC\)/.test(cm.text) && /WTI crude oil\s+Dec 2026\s+88\.42\s+\$\/bbl\s+\+0\.75%\s+[+-]\d+\.\d\d%\s+[+-]\d+\.\d\d%/.test(cm.text) && /Gold\s+Dec 2026\s+4,130\.50\s+\$\/oz/.test(cm.text) && /\d\d:\d\d RT\s+LIVE/.test(cm.text), cm.text.slice(0, 900));
  ok("[H] CMDTY: U.S. weekly inventories (EIA) — level, unit, w/w, vs a year ago, vs the 5-year average (% for stocks, the unit for rates)", /U\.S\. INVENTORIES · EIA WEEKLY/.test(cm.text) && /Crude oil \(excl\. SPR\)\s+\d\d \w{3} \d{4}\s+409\.2\s+M bbl\s+\+3\.2\s+\+4\.2\s+\+1\.5%/.test(cm.text) && /Cushing, OK\s+\d\d \w{3} \d{4}\s+22\.4\s+M bbl\s+-0\.7\s+-1\.1\s+-33\.3%/.test(cm.text) && /Natural gas in storage \(Lower 48\)\s+\d\d \w{3} \d{4}\s+3,712\s+Bcf\s+\+87\s+\+101\s+\+1\.7%/.test(cm.text) && /Refinery utilization\s+\d\d \w{3} \d{4}\s+89\.6\s+%\s+-1\.2\s+\+0\.4\s+\+1\.5\b/.test(cm.text), cm.text.slice(cm.text.indexOf("INVENTORIES"), cm.text.indexOf("INVENTORIES") + 900));
  ok("[H] CMDTY: a weekly series EIA stopped publishing is N/A with its last date, never a value", /Jet fuel \(kerosene-type\)\s+N\/A — EIA has not published this series since 07 Aug 2026/.test(cm.text) && /DERIVED from EIA's own series/.test(cm.text) && (await page.$$eval(".win table.inv svg.spark", (x) => x.length)) === 4);
  await shotWin(page, "COMMODITIES", "t07-cmdty");
  if (SHOTS) { await page.evaluate(() => document.querySelector(".win table.inv")?.scrollIntoView({ block: "center" })); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + "/t07-cmdty-inv.png" }); }
  await cmd(page, "FCRV"); await page.waitForTimeout(2500);
  await shotWin(page, "FUTURES CURVES", "t07-fcrv");
  const fc = await winOf(page, "FUTURES CURVES");
  ok("[H] FCRV: WTI curve by contract month (CNBC), now / a week / a month before, spread to the previous month DERIVED", /WTI CRUDE OIL · CURVE BY CONTRACT MONTH/.test(fc.text) && /1\s+Dec 2026\s+88\.42\s+\+0\.75%\s+\d+\.\d\d\s+\d+\.\d\d\s+[+-]\d+\.\d\d%/.test(fc.text) && /2\s+Jan 2027\s+88\.07\s+\+0\.75%[\s\S]{0,40}-0\.3500/.test(fc.text) && (await page.$$eval(".win canvas", (c) => c.length)) > 0, fc.text.slice(0, 700));
  // ERN
  await cmd(page, "ERN"); await page.waitForTimeout(1000);
  const er = await winOf(page, "EARNINGS CALENDAR");
  ok("[H] ERN: reports by day, estimates and actuals, surprise and reaction DERIVED", /JPM\s+JPMORGAN CHASE & CO\s+SPX\s+Q3 2026\s+4\.90\s+5\.39\s+\+10\.0%\s+\$46\.00B\s+\$47\.00B\s+\+2\.2%\s+\+2\.31%/.test(er.text) && /NFLX\s+NETFLIX INC\s+SPX NDX/.test(er.text), er.text.slice(0, 900));
  await shotWin(page, "EARNINGS CALENDAR", "t07-ern");
  // EQ
  await cmd(page, "EQ"); await page.waitForTimeout(1000);
  let eq = await winOf(page, "EQUITIES · S&P 500");
  ok("[H] EQ: index members with weight, last, change, base date; breadth and weighted change DERIVED", /NVDA\s+NVIDIA\s+Information Technology\s+8\.60%\s+\$240\.72\s+\+2\.00%/.test(eq.text) && /index-weighted/.test(eq.text), eq.text.slice(0, 700));
  await page.fill('[data-k="eqq"]', "nvid"); await page.waitForTimeout(600);
  eq = await winOf(page, "EQUITIES · S&P 500");
  ok("[H] EQ: the filter keeps focus while typing and narrows the list", /^1 shown/m.test(eq.text.split("\n").find((l) => /shown/.test(l)) || "") && (await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-k"))) === "eqq", eq.text.slice(0, 300));
  // FX + CRYPTO + FUT + RDT
  await cmd(page, "FX"); await page.waitForTimeout(1500);
  const fx = await winOf(page, "CURRENCIES");
  ok("[H] FX: the 8 pairs vs USD from live quotes; 1W / 1M / YTD / 1Y from CNBC daily bars; the ICE dollar index (DXY, CNBC); USD average DERIVED", ["EUR/USD", "USD/JPY", "USD/CNY"].every((p) => fx.text.includes(p)) && /DXY\s+98\.765\s+-0\.210\s+-0\.21%/.test(fx.text) && /US dollar vs these 8 currencies, equal weights/.test(fx.text) && /1\.35121\s+[+-]\d+\.\d\d%\s+[+-]\d+\.\d\d%\s+[+-]\d+\.\d\d%\s+[+-]\d+\.\d\d%/.test(fx.text) && /ICE U\.S\. Dollar Index\s+[+-]\d+\.\d\d%/.test(fx.text), fx.text.slice(0, 1200));
  await cmd(page, "CRYPTO"); await page.waitForTimeout(900);
  const cr = await winOf(page, "CRYPTO");
  ok("[H] CRYPTO: pairs by traded value with live price and 1D change", /BTC\/USD\s+86,000\s+\+1\.18%\s+\$1\.20B/.test(cr.text) && cr.text.indexOf("BTC/USD") < cr.text.indexOf("ETH/USD"), cr.text.slice(0, 400));
  await cmd(page, "FUT"); await page.waitForTimeout(2500);
  const fu = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent === "FUTURES"); return w ? { text: w.querySelector(".win-body").innerText, pill: w.querySelector(".w-pv")?.textContent.trim() } : null; });
  // (during the U.S. cash session the row says the market is open instead of an implied move)
  ok("[H] FUT: where the cash indices are set to open (implied move DERIVED) and 45 contracts by group with month, last, returns", /WHERE THE CASH INDICES ARE SET TO OPEN\s*DRV/.test(fu.text) && /S&P 500\s+6,700\.50\s+[\s\S]{0,30}Dec 2026\s+6,731\.25\s+(6,731\.25\s+\+0\.00%\s+6,700\.50|cash market open · today [+-]\d+\.\d\d%)/.test(fu.text) && /S&P 500 E-mini\s+Dec 2026\s+6,731\.25\s+pts\s+\+0\.75%/.test(fu.text) && /LIVESTOCK/.test(fu.text) && fu.pill === "LIVE", fu.text.slice(0, 900));
  await cmd(page, "RDT"); await page.waitForTimeout(1500);
  const rd = await winOf(page, "REDDIT · MOST MENTIONED");
  ok("[H] RDT: most mentioned tickers on Reddit (ApeWisdom) with the 24 hours before and changes DERIVED — a count, not a sentiment", !!rd && /1\s+NVDA\s+NVIDIA\s+812\s+640\s+\+27%\s+▲1\s+4,021/.test(rd.text) && /2\s+TSLA\s+Tesla\s+700\s+900\s+-22%\s+▼1/.test(rd.text) && /not a sentiment/.test(rd.text), rd && rd.text.slice(0, 500));
  await cmd(page, "MOV"); await page.waitForTimeout(1500);
  const mvw = await winOf(page, "MARKET MOVERS");
  ok("[H] MOV: Nasdaq's lists for every U.S.-listed stock (most active, gainers, losers)", /U\.S\. MARKET \(NASDAQ\)/.test(mvw.text) && /MOST ACTIVE · SHARES\s+1\s+NVDA\s+\$190\.50/.test(mvw.text) && /TOP GAINERS\s+1\s+UPCO/.test(mvw.text) && /TOP LOSERS\s+1\s+DNCO/.test(mvw.text), mvw.text.slice(0, 500));
  await cmd(page, "SCR"); await page.waitForTimeout(2000);
  let sc = await winOf(page, "EQUITY SCREENER");
  ok("[H] SCR: every U.S.-listed stock from Nasdaq's screener (three exchanges), sorted by market cap", /4 matches of 4 U\.S\.-listed stocks/.test(sc.text) && /NVDA\s+NVIDIA Corporation\s+Technology · Semiconductors\s+\$190\.50\s+\+2\.10%\s+200\.0M\s+\$4\.60T\s+NASDAQ/.test(sc.text) && sc.text.indexOf("NVDA\t") < sc.text.indexOf("AAPL\t"), sc.text.slice(sc.text.indexOf("SYM"), sc.text.indexOf("SYM") + 600));
  // BOARD
  await cmd(page, "BOARD"); await page.waitForTimeout(500);
  await page.fill('[data-k="bnew"]', "Chips"); await page.click(".b-new"); await page.waitForTimeout(500);
  await page.fill('[data-k="badd"]', "nvda"); await page.click(".b-add"); await page.waitForTimeout(700);
  await page.fill('[data-k="badd"]', "ZZZZ"); await page.click(".b-add"); await page.waitForTimeout(700);
  const bd = await winOf(page, "BOARD · Chips");
  ok("[H] BOARD: create a board, add a symbol checked with a real quote, refuse an unknown one; stored on the server", !!bd && /NVDA\s+NVDA Inc\s+\$190\.50/.test(bd.text) && /ZZZZ not added: unknown symbol/.test(bd.text) && t7.boards.length === 1 && t7.boards[0].syms.join() === "NVDA", bd && bd.text.slice(0, 400));
  // ALRT — served by the real Worker code (KV in memory; CNBC / Telegram in their formats)
  await cmd(page, "ALRT"); await page.waitForTimeout(700);
  await page.fill('.al-f input[name="sym"]', "zzzz"); await page.fill('.al-f input[name="price"]', "5"); await page.click('.al-f button[type="submit"]'); await page.waitForTimeout(700);
  let al = await winOf(page, "ALERTS");
  ok("[H] ALRT: a symbol CNBC does not quote is refused by the server", /no CNBC quote for ZZZZ/.test(al.text), al.text.slice(0, 300));
  await page.fill('.al-f input[name="sym"]', "nvda"); await page.fill('.al-f input[name="price"]', "100"); await page.fill('.al-f input[name="note"]', "test level");
  await page.click('.al-f button[type="submit"]'); await page.waitForTimeout(900);
  al = await winOf(page, "ALERTS");
  ok("[H] ALRT: a price alert is saved on the server, with CNBC's last price and the distance to the level", JSON.parse(PV.kv.get("ud/alerts")).length === 1 && /watching/.test(al.text) && /190\.50/.test(al.text) && /−?-?47\.\d\d%/.test(al.text), al.text.slice(0, 500));
  await page.click(".al-run"); await page.waitForTimeout(1500);
  al = await winOf(page, "ALERTS"); const toastTxt = await page.evaluate(() => document.querySelector("#toasts")?.innerText || "");
  ok("[H] ALRT: CHECK NOW runs the server check — the alert fires on a fresh CNBC quote, records price and time, shows in RECENT FIRINGS and as a toast", JSON.parse(PV.kv.get("ud/alerts"))[0].hit.price === 190.5 && /FIRED/.test(al.text) && /@ 190\.50/.test(al.text) && /RECENT FIRINGS/.test(al.text) && /page only/.test(al.text) && /ALERT NVDA ≥ 100 — last 190\.5/.test(toastTxt), al.text.slice(0, 600) + " | " + toastTxt);
  await page.click(".al-rearm"); await page.waitForTimeout(700);
  ok("[H] ALRT: RE-ARM watches the level again", JSON.parse(PV.kv.get("ud/alerts"))[0].hit === null);
  await page.click('[data-ak="session"]'); await page.waitForTimeout(300);
  await page.selectOption('.al-f select[name="market"]', "IT"); await page.selectOption('.al-f select[name="event"]', "close"); await page.click('.al-f button[type="submit"]'); await page.waitForTimeout(900);
  await page.click('[data-ak="release"]'); await page.waitForTimeout(300);
  await page.fill('.al-f input[name="match"]', "cpi"); await page.click('.al-f button[type="submit"]'); await page.waitForTimeout(900);
  al = await winOf(page, "ALERTS");
  ok("[H] ALRT: market close (Italy, FTSE MIB) and data-release (United States, “cpi”) alerts", /Italy — close \(FTSE MIB\)/.test(al.text) && /United States: “cpi”/.test(al.text) && JSON.parse(PV.kv.get("ud/alerts")).length === 3, al.text.slice(0, 700));
  ok("[H] ALRT: Telegram configured but no chat linked → FIND MY CHAT", /bot configured; no chat linked yet/.test(al.text));
  await page.click(".al-find"); await page.waitForTimeout(900);
  await page.click(".al-link"); await page.waitForTimeout(900);
  al = await winOf(page, "ALERTS");
  ok("[H] ALRT: FIND MY CHAT lists the chats that wrote to the bot; LINK saves it and sends a confirmation", /sending to Alessandro/.test(al.text) && JSON.parse(PV.kv.get("ud/telegram")).id === "4242" && PV.tg.some((x) => x.method === "sendMessage" && /alerts will arrive in this chat/.test(x.body.text)), al.text.slice(-700));
  await page.click(".al-test"); await page.waitForTimeout(800);
  al = await winOf(page, "ALERTS"); const pageHtml = await page.content();
  ok("[H] ALRT: SEND TEST reaches the linked chat; the bot token is used only towards Telegram, never in the page", /Test message sent/.test(al.text) && PV.tg.at(-1).body.chat_id === "4242" && PV.tg.every((x) => x.tokenInUrl) && !pageHtml.includes(TG_TOKEN.split(":")[1]), al.text.slice(-400));
  // NOTE
  await cmd(page, "NOTE"); await page.waitForTimeout(400);
  await page.fill('.nt-f textarea', "Watch the ECB on Thursday"); await page.fill('.nt-f input[name="sym"]', "EUR/USD"); await page.click('.nt-f button[type="submit"]'); await page.waitForTimeout(600);
  ok("[H] NOTE: a note is saved on the server and listed with its symbol", t7.notes.length === 1 && /EUR\/USD · [\s\S]*Watch the ECB on Thursday/.test((await winOf(page, "NOTES")).text));
  // CROSS + BT
  await cmd(page, "CROSS NVDA AAPL"); await page.waitForTimeout(1500);
  const xr = await winOf(page, "CROSS · NVDA / AAPL");
  ok("[H] CROSS: ratio of two real histories on common dates, correlation of daily returns (DERIVED)", /NVDA \/ AAPL\s+1\.0000/.test(xr.text) && /CORRELATION\s+1\.00/.test(xr.text) && /252 obs/.test(xr.text), xr.text.slice(0, 400));
  await cmd(page, "BT NVDA"); await page.waitForTimeout(1800);
  const bt = await winOf(page, "BACKTEST · NVDA"), cs = daily.map((p) => p.c), bh = (cs[cs.length - 1] / cs[199] - 1) * 100;
  ok("[H] BT: SMA 50/200 vs buy & hold on real closes (dividend-adjusted request), from the first signal; results DERIVED", new RegExp(`Total return\\s+[+-]?[\\d.]+%\\s+\\${bh >= 0 ? "+" : "-"}${Math.abs(bh).toFixed(1)}%`).test(bt.text) && /Max drawdown/.test(bt.text) && /Sharpe \(risk-free 0\)/.test(bt.text) && requests.some((r) => /\/api\/history\?symbol=NVDA&range=5Y&adjust=all&interval=1day/.test(r)), bt.text.slice(0, 600) + " bh=" + bh.toFixed(2));
  await shotWin(page, "BACKTEST · NVDA", "t07-bt");
  await shotWin(page, "ALERTS", "t07-alrt");
  // SYS
  await cmd(page, "SYS"); await page.waitForTimeout(600);
  const sy = await winOf(page, "SYSTEM STATUS");
  ok("[H] SYS: sources configured yes/no (no key values), Twelve Data credits, scheduler", /Finnhub\s+earnings calendar \(ERN\)\s+NO/.test(sy.text) && /THIS MINUTE \(ACCOUNT\)\s+3 \/ 8/.test(sy.text) && /TODAY \(ACCOUNT\)\s+120 \/ 800/.test(sy.text) && /last scheduled run/.test(sy.text), sy.text.slice(0, 600));
  const uBefore = t7.calls.filter((c) => c === "GET /api/status?usage=1").length;
  await page.click(".sys-u"); await page.waitForTimeout(600);
  ok("[H] SYS: CHECK CREDITS asks the Worker for the usage (1 credit); otherwise only the hourly check of the page", t7.calls.filter((c) => c === "GET /api/status?usage=1").length === uBefore + 1 && uBefore <= 1);
  // WS
  await page.evaluate(() => document.querySelector("#tabs .tb-close").click()); await page.waitForTimeout(300); // CLOSE all
  await cmd(page, "WS MSFT"); await page.waitForTimeout(1500);
  ok("[H] WS: a ticker workspace — chart, description, options and news", (await page.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent).sort().join())) === "DES,GP,N,OMON" && !!(await winOf(page, "DES · MSFT")) && !!(await winOf(page, "OPTIONS · MSFT")));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/t07-ws.png" });
  // TOUR
  await cmd(page, "TOUR"); await page.waitForTimeout(300);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/t07-tour.png" });
  const t1 = await page.evaluate(() => ({ h: document.querySelector(".tour-card h4")?.textContent, hl: document.querySelector(".tour-hl")?.id }));
  await page.click(".tour-card .t-next"); await page.waitForTimeout(200);
  const t2 = await page.evaluate(() => ({ h: document.querySelector(".tour-card h4")?.textContent, hl: document.querySelector(".tour-hl")?.id }));
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  ok("[H] TOUR: steps highlight the parts of the screen; Escape ends it", t1.h === "1/8 · COMMAND LINE" && t1.hl === "cmd" && t2.h === "2/8 · FUNCTIONS MENU" && t2.hl === "fnMenuBtn" && !(await page.evaluate(() => document.querySelector("#tour")?.classList.contains("on"))), JSON.stringify([t1, t2]));
  // Italian
  await page.click('#cmdbar [data-lang="it"]'); await page.waitForTimeout(500);
  await page.keyboard.press("F2"); await page.waitForTimeout(300);
  const mi = await page.evaluate(() => [...document.querySelectorAll(".fm-col h4")].map((h) => h.textContent).join("|") + " " + document.querySelector('.fm-i[data-fn="OMON"]')?.innerText);
  await page.keyboard.press("Escape");
  await cmd(page, "CB"); await page.waitForTimeout(400);
  ok("[H] Italian: menu and new windows in Italian, codes and data unchanged", /^MERCATI\|ETF\|TASSI E MACRO\|ANALISI\|PERSONALE\|LAYOUT OMON\s+Monitor delle opzioni/.test(mi) && !!(await winOf(page, "BANCHE CENTRALI")) && /BANCA CENTRALE\s+TASSO\s+AL\s+ULTIMA MOSSA/.test((await winOf(page, "BANCHE CENTRALI")).text), mi + " || " + ((await winOf(page, "BANCHE CENTRALI")) || {}).text?.slice(0, 400));
  await page.click('#cmdbar [data-lang="en"]'); await page.waitForTimeout(400);
  const body = await page.evaluate(() => document.body.innerText);
  ok("[H] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(body) && !/NaN|undefined/.test(body) && errors.length === 0, errors.join(" | ") + (body.match(/.{0,40}(NaN|undefined).{0,40}/) || [""])[0]);
  await page.close();
}
{
  // EIA key not set: energy rows and curves say so; nothing in their place
  const { page, errors } = await openTerminal({ ...OK_API, noEia: true });
  await cmd(page, "CMDTY"); await page.waitForTimeout(800);
  const cm = await winOf(page, "COMMODITIES");
  await cmd(page, "FCRV"); await page.waitForTimeout(600);
  const fc = await winOf(page, "FUTURES CURVES");
  ok("[H] no EIA key → the EIA spot rows and the weekly inventories are N/A naming the missing key (Secret EIA_KEY); CNBC futures and curves unaffected", /N\/A — EIA prices unavailable \(EIA API key not set in the Worker\)/.test(cm.text) && /N\/A — EIA weekly inventories unavailable \(EIA API key not set in the Worker\) — they appear once the free EIA key is added to the Worker as the Secret EIA_KEY/.test(cm.text) && !/409\.2/.test(cm.text) && /WTI crude oil\s+Dec 2026\s+88\.42/.test(cm.text) && /WTI CRUDE OIL · CURVE BY CONTRACT MONTH/.test(fc.text) && errors.length === 0, cm.text.slice(cm.text.indexOf("SPOT") - 200, cm.text.indexOf("SPOT") + 400));
  await page.close();
}

// =============== I. bonds, futures positioning, ETFs by asset class ===============
{
  const { page, errors, t7 } = await openTerminal(OK_API);
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await cmd(page, "BOND"); await page.waitForTimeout(800);
  let bd = await winOf(page, "WORLD GOVERNMENT BONDS");
  ok("[I] BOND: countries with 2Y…30Y yields, 10Y daily change, spread vs Bund (same date), source; a failed source N/A", /United States[\s\S]*3\.60\s+—\s+4\.13\s+—\s+4\.70\s+\+3\.0/.test(bd.text) && /United Kingdom[\s\S]*\+184\.0/.test(bd.text) && /Canada\s+N\/A — provider timed out/.test(bd.text) && /Not connected: Italy, France/.test(bd.text), bd.text.slice(0, 900));
  ok("[I] BOND: the Swiss value says which bond it is (hover)", await page.$eval("table.bond-t", (t) => [...t.querySelectorAll("td[title]")].some((td) => /Confederation bond V13_1/.test(td.title))));
  await page.click('[data-bmode="w1"]'); await page.waitForTimeout(300);
  bd = await winOf(page, "WORLD GOVERNMENT BONDS");
  ok("[I] BOND: Δ 1 WEEK view shows the changes in basis points, coloured", /CHANGE IN BASIS POINTS/.test(bd.text) && /Germany[\s\S]*\+4\.0\s+—\s+\+8\.0/.test(bd.text) && (await page.$$eval("table.bond-t td[style*='background']", (t) => t.length)) > 4, bd.text.slice(0, 600));
  ok("[I] BOND: US inflation and credit from FRED (HY spread in bp)", /10-year breakeven inflation T10YIE\s+2\.31%/.test(bd.text) && /option-adjusted spread \(ICE BofA\) BAMLH0A0HYM2\s+305 bp\s+\+5\.0/.test(bd.text), bd.text.slice(-700));
  await cmd(page, "COT"); await page.waitForTimeout(700);
  const ct = await winOf(page, "FUTURES POSITIONING");
  ok("[I] COT: speculators long / short / net, weekly and 4-week change, % of OI, place in the 26-week range; missing contract N/A; positions date", /E-mini S&P 500 ES\s+1\.90M\s+209\.6K\s+352\.1K\s+-142\.5K\s+-9\.3K\s+\+12\.0K\s+-7\.5%\s+58%/.test(ct.text) && /Gold GC[\s\S]*\+218\.6K/.test(ct.text) && /Bitcoin BTC\s+N\/A/.test(ct.text) && /positions as of\s+29 Sept? 2026/.test(ct.text), ct.text.slice(0, 900));
  await page.click('[data-cgrp="Metals"]'); await page.waitForTimeout(200);
  ok("[I] COT: group filter", !/E-mini S&P 500/.test((await winOf(page, "FUTURES POSITIONING")).text) && /Gold/.test((await winOf(page, "FUTURES POSITIONING")).text));
  await cmd(page, "FUT"); await page.waitForTimeout(300);
  ok("[I] FUT: positioning (COT) one click away", !!(await page.$(".go-cot")));
  await cmd(page, "ETF"); await page.waitForTimeout(1200);
  let et = await winOf(page, "ETFs BY ASSET CLASS");
  ok("[I] ETF: grouped by asset class with live price, change and traded value; labelled as ETF prices", /US EQUITY\s+SPY[\s\S]*TREASURIES\s+TLT[\s\S]*CREDIT AND AGGREGATE\s+HYG/.test(et.text) && /TLT\s+iShares 20\+ Year Treasury \(TLT\)\s+Treasuries\s+\$88\.40\s+-1\.01%/.test(et.text) && /not the price of the bonds/.test(et.text), et.text.slice(0, 700));
  await page.click('[data-egrp="BONDS"]'); await page.waitForTimeout(300);
  et = await winOf(page, "ETFs BY ASSET CLASS");
  ok("[I] ETF: ALL BONDS filter keeps Treasuries and credit only", !/SPY/.test(et.text.split("BASE DATE")[1] || "") && /TLT/.test(et.text) && /HYG/.test(et.text));
  await cmd(page, "MAP"); await page.waitForTimeout(500);
  ok("[I] MAP has an ETFS universe", !!(await page.$('[data-mapu="ETF"]')));
  await cmd(page, "YLD"); await page.waitForTimeout(500);
  ok("[I] YLD: country filter and a link to BOND when more countries are published", !!(await page.$(".y-bond")) || (await winOf(page, "GOVERNMENT YIELDS")).text.includes("UNITED STATES"));
  const body = await page.evaluate(() => document.body.innerText);
  ok("[I] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(body) && !/NaN|undefined/.test(body) && errors.length === 0, errors.join(" | "));
  await page.close();
}
{
  const { page, errors } = await openTerminal({ ...OK_API, noFred: true });
  await cmd(page, "BOND"); await page.waitForTimeout(700);
  const bd = await winOf(page, "WORLD GOVERNMENT BONDS");
  ok("[I] no FRED key → inflation and credit NO DATA naming FRED_KEY; countries still shown", /NO DATA — U\.S\. inflation and credit \(FRED\): the API key is not set in the Worker \(FRED_KEY/.test(bd.text) && /Germany/.test(bd.text) && errors.length === 0, bd.text.slice(-400));
  await page.close();
}

// =============== J. portfolio analytics: time-weighted return vs a benchmark, drawdown, risk of the holdings ===============
// business days ending yesterday; the holdings trade on the last 80, the benchmark on all 85 (it starts before the first trade)
const BDJ = (() => { const out = []; let t = Date.now() - 864e5; while (out.length < 85) { const d = new Date(t); if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); t -= 864e5; } return out; })();
const PXA = (i) => 100 + i - (i >= 50 && i < 55 ? 15 : 0), PXS = (i) => 197 + (i % 7);
const histJ = (sym, range) => { const f = sym === "AAPL" ? PXA : sym === "SAP:XETR" ? PXS : null; if (!f) return { status: 404, body: { error: "symbol_not_found", status: "N/A" } };
  const pts = BDJ.slice(5).map((d, i) => ({ t: d, o: f(i), h: f(i), l: f(i), c: f(i), v: 1000 }));
  return { body: { symbol: sym, range, interval: "1day", adjust: "splits", count: pts.length, points: pts, status: "LIVE", source: "twelvedata", fetchedAt: new Date().toISOString(), asOf: new Date().toISOString(), staleAt: new Date(Date.now() + 864e5).toISOString() } }; };
const pfJ = (tx, calls) => (u) => {
  if (u.pathname === "/api/portfolio/fx") { calls.push(u.search); return { body: { base: "EUR", series: { USD: BDJ.map((d) => [d, 1.1]) }, currencies: ["USD"], missing: [], status: "LIVE", source: "ECB euro reference rates (ECB Data Portal, EXR)" } }; }
  const b = buildPositions(tx, { USD: [["2020-01-01", 1.1]] });
  return { body: { baseCurrency: "EUR", transactions: tx.slice().reverse(), positions: b.positions, realized: b.realized, error: null, costBasis: { method: "average cost", currencies: ["USD"], fx: { source: "ECB euro reference rates (ECB Data Portal, EXR)", status: "LIVE", missing: [] } } } };
};
const idxJ = (u) => u.pathname === "/api/indices/history" ? { body: { id: u.searchParams.get("id"), name: "S&P 500", source: "Cboe (daily history)", sourceUrl: "https://www.cboe.com/", fields: "close", points: BDJ.map((d, i) => [d, 1000 + 2 * (i - 5)]), count: 85, status: "LIVE" } } : { body: IDX_FIX(u.searchParams.get("g")) };
{
  const fxCalls = [], tx = [{ id: "a1", date: BDJ[5], side: "BUY", sym: "AAPL", qty: 10, price: 100, ccy: "USD", fees: 0, created: 1 }, { id: "a2", date: BDJ[35], side: "BUY", sym: "AAPL", qty: 10, price: 130, ccy: "USD", fees: 0, created: 2 }, { id: "a3", date: BDJ[65], side: "SELL", sym: "AAPL", qty: 5, price: 160, ccy: "USD", fees: 0, created: 3 }];
  const { page, errors, requests } = await openTerminal({ ...OK_API, history: histJ, portfolio: pfJ(tx, fxCalls), indices: idxJ });
  await cmd(page, "PF"); await page.waitForTimeout(500);
  await page.click(".pf-an"); await page.waitForTimeout(1500);
  let pa = await winOf(page, "PORTFOLIO ANALYTICS");
  ok("[J] PFA opens from the portfolio's ANALYTICS button; the ECB rates asked for the portfolio's and the benchmark's currency from the first trade", !!pa && fxCalls.some((q) => /ccys=USD&from=/.test(q) && q.includes(BDJ[5])), JSON.stringify(fxCalls));
  ok("[J] time-weighted return: a second purchase and a partial sale at the day's price do not change it — the price return from the first trade price (+79.00%)", /RETURN \(TWR\)\s*\+79\.00%/.test(pa.text), JSON.stringify(pa.text.slice(0, 900)));
  ok("[J] benchmark in EUR over the same days, from its close before the first trade (+16.03%); excess +62.97%", /S&P 500 \(EUR\)\s*\+16\.03%/.test(pa.text) && /EXCESS\s*\+62\.97%/.test(pa.text));
  ok("[J] max drawdown of the return index with its peak, trough and recovery (−9.40%)", /MAX DRAWDOWN\s*-9\.40%/.test(pa.text) && /recovered/.test(pa.text));
  ok("[J] gain since the first trade in EUR: value + sales − purchases (ECB 1.10)", /GAIN SINCE THE FIRST TRADE\s*€1,077\.27/.test(pa.text) && /value €2,440\.91 \+ sales €727\.27 − purchases €2,090\.91/.test(pa.text));
  ok("[J] risk of the current holding: weight and share of risk 100%, one effective holding, all in USD", /AAPL\s*100\.0%/.test(pa.text) && /EFFECTIVE HOLDINGS\s*1\.0/.test(pa.text) && /USD 100%/.test(pa.text) && /100\.0%\s*$/m.test(pa.text.split("SHARE OF RISK")[1] || ""));
  ok("[J] the method is stated: purchases and sales at their trade price, last close, ECB fixing, dividends not included", /Time-weighted return: each purchase counts from its trade price/.test(pa.text) && /dividends are not included/.test(pa.text) && /DERIVED|DRV/.test(pa.text + pa.pill));
  ok("[J] two charts: the return index vs the benchmark, and the drawdown", (await page.$$eval(".win .pfa-box canvas, .win .pfa-dd canvas", (c) => c.length)) >= 2);
  const before = pa.text;
  await page.click('[data-prng="1M"]'); await page.waitForTimeout(400);
  pa = await winOf(page, "PORTFOLIO ANALYTICS");
  ok("[J] a shorter period re-bases the figures on its first day (no new request)", pa.text !== before && /RETURN \(TWR\)\s*[+-]\d/.test(pa.text) && requests.filter((u) => u.includes("/api/history?symbol=AAPL")).length === 1);
  await page.click('[data-pcur="LOCAL"]'); await page.waitForTimeout(400);
  pa = await winOf(page, "PORTFOLIO ANALYTICS");
  ok("[J] benchmark in its own currency on request", /S&P 500\s*[+-]\d/.test(pa.text) && !/S&P 500 \(EUR\)/.test(pa.text));
  const body = await page.evaluate(() => document.body.innerText);
  ok("[J] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(body) && !/NaN|undefined/.test(body) && errors.length === 0, errors.join(" | "));
  await page.close();
}
{
  const tx = [{ id: "b1", date: BDJ[5], side: "BUY", sym: "AAPL", qty: 10, price: 100, ccy: "USD", fees: 0, created: 1 }, { id: "b2", date: BDJ[5], side: "BUY", sym: "SAP:XETR", qty: 5, price: 197, ccy: "EUR", fees: 0, created: 2 }];
  const { page, errors } = await openTerminal({ ...OK_API, history: histJ, portfolio: pfJ(tx, []), indices: idxJ });
  await cmd(page, "PFA"); await page.waitForTimeout(1500);
  const pa = await winOf(page, "PORTFOLIO ANALYTICS"), risk = pa.text.split("RISK OF THE CURRENT HOLDINGS")[1] || "";
  const shares = [...risk.matchAll(/(\d+\.\d)%\s*$/gm)].map((m) => Number(m[1]));
  ok("[J] two holdings in two currencies: weights at the last close, shares of risk adding up to 100%, currency split, correlation grid with 1.00 on the diagonal",
    /AAPL\s*(\d+\.\d)%/.test(risk) && /SAP:XETR\s*(\d+\.\d)%/.test(risk) && Math.abs(shares.reduce((a, b) => a + b, 0) - 100) < 0.3 && /USD \d+% · EUR \d+%|EUR \d+% · USD \d+%/.test(risk) && (risk.match(/1\.00/g) || []).length >= 2, JSON.stringify(pa.text).slice(0, 1600));
  ok("[J] no JavaScript errors with two holdings", errors.length === 0, errors.join(" | "));
  await page.close();
}
{
  const { page, errors } = await openTerminal({ ...OK_API, portfolio: pfJ([], []) });
  await cmd(page, "PFA"); await page.waitForTimeout(600);
  const pa = await winOf(page, "PORTFOLIO ANALYTICS");
  ok("[J] no trades: the analytics say so and point to PORTFOLIO (nothing invented)", /No trades yet/.test(pa.text) && errors.length === 0, JSON.stringify(pa).slice(0, 300) + errors.join("|"));
  await page.close();
}

// =============== J. analytics: yields grid, options views, portfolio-mix backtest, currency-converted comparison, ratio stats ===============
{
  const FXD = []; for (let i = 400; i >= 0; i--) FXD.push([dShift(today, -i), 1.1]);
  const { page, errors } = await openTerminal({ ...OK_API, portfolio: (u) => u.pathname === "/api/portfolio/fx" ? { body: { base: "EUR", series: Object.fromEntries((u.searchParams.get("ccys") || "USD").split(",").map((c) => [c, FXD])), currencies: ["USD"], missing: [], status: "LIVE", source: "ECB euro reference rates (ECB Data Portal, EXR)" } } : { body: { baseCurrency: "EUR", transactions: [], positions: [], realized: [], error: null } } });
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  // YLD GRID
  await cmd(page, "YLD"); await page.waitForTimeout(1200); await page.click('[data-yc="GRID"]'); await page.waitForTimeout(700);
  let y = await winOf(page, "GOVERNMENT YIELDS");
  ok("[J] YLD GRID: every country × maturity from CNBC market yields; a country with no quote N/A", /COUNTRY\s+3M\s+1Y\s+2Y\s+5Y\s+10Y\s+30Y/.test(y.text) && /IT Italy\s+·\s+·\s+2\.70\s+3\.20\s+3\.912\s+4\.60/.test(y.text) && /TH Thailand\s+N\/A no quote/.test(y.text), y.text.slice(y.text.indexOf("COUNTRY"), y.text.indexOf("COUNTRY") + 400));
  await page.click('[data-ygm="1W"]'); await page.waitForTimeout(900);
  y = await winOf(page, "GOVERNMENT YIELDS");
  ok("[J] YLD GRID Δ 1W: changes in basis points against the close a week before (DERIVED)", /IT Italy[\s\S]{0,40}\+10\.0/.test(y.text) && /basis points/.test(y.text), y.text.slice(y.text.indexOf("COUNTRY"), y.text.indexOf("COUNTRY") + 400));
  // OMON views
  await cmd(page, "OMON AAPL"); await page.waitForTimeout(1500);
  let om = await winOf(page, "OPTIONS · AAPL");
  ok("[J] OMON: expected move from the ATM straddle and max pain from open interest (DERIVED)", /EXPECTED MOVE\s*DRV\s+±\$17\.25\s+±6\.9% · ATM straddle/.test(om.text) && /MAX PAIN\s*DRV\s+250/.test(om.text), om.text.slice(0, 600));
  // (a click that lands while the window redraws with arriving data is clicked again)
  for (let k = 0; k < 4; k++) { await page.click('[data-ov="TERM"]'); if (await page.waitForFunction(() => /EXPIRY\s+DAYS\s+ATM/.test([...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title").textContent.startsWith("OPTIONS · AAPL"))?.querySelector(".win-body").innerText || ""), null, { timeout: 1500 }).then(() => true).catch(() => false)) break; }
  await page.waitForTimeout(300); om = await winOf(page, "OPTIONS · AAPL");
  // expiry dates follow the fixture (today + 9 / + 37 days); 1σ uses the time left to the close, so it moves with the hour
  const fmtExp = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  ok("[J] OMON TERM: ATM IV, straddle and expected move per expiry", new RegExp(fmtExp(dShift(today, 9)) + "\\s+9\\s+250\\s+28\\.0%\\s+17\\.25\\s+±6\\.9%\\s+±4\\.[3-6]%").test(om.text) && new RegExp(fmtExp(dShift(today, 37)) + "\\s+37\\s+250\\s+28\\.0%").test(om.text), om.text.slice(om.text.indexOf("EXPIRY"), om.text.indexOf("EXPIRY") + 300));
  await page.click('[data-ov="SURF"]'); await page.waitForTimeout(800); om = await winOf(page, "OPTIONS · AAPL");
  ok("[J] OMON SURFACE: IV by moneyness and expiry; no strike near a level → —", /100\.0% ATM\s+28\.0%\s+28\.0%/.test(om.text) && /95\.0% put\s+29\.0%/.test(om.text) && /85\.0% put\s+—\s+—/.test(om.text), om.text.slice(om.text.indexOf("STRIKE / SPOT"), om.text.indexOf("STRIKE / SPOT") + 300));
  await page.click('[data-ov="PAY"]'); await page.waitForTimeout(800);
  ok("[J] OMON PAYOFF: legs from the chain, profit or loss at expiry DERIVED", /ADD LEG/.test((await winOf(page, "OPTIONS · AAPL")).text) && /intrinsic value minus the premium paid/.test((await winOf(page, "OPTIONS · AAPL")).text));
  // BT portfolio mix
  await cmd(page, "BT"); await page.waitForTimeout(1200); await page.click('[data-btm="mix"]'); await page.waitForTimeout(3000);
  const bt = await winOf(page, "BACKTEST · PORTFOLIO MIX");
  ok("[J] BT PORTFOLIO MIX: weights, rebalancing and a benchmark on real daily closes; return, CAGR, volatility, Sharpe, drawdown, calendar years, correlation (DERIVED)", !!bt && /RESULT\s*DRV\s+PORTFOLIO\s+SPY/.test(bt.text) && /Total return\s+[+-]\d+\.\d%/.test(bt.text) && /Max drawdown\s+-?\d+\.\d%/.test(bt.text) && /Rebalancings\s+\d/.test(bt.text) && /CALENDAR YEARS/.test(bt.text) && /CORRELATION\s+SPY\s+TLT\s+GLD/.test(bt.text) && /Real daily closes from Twelve Data/.test(bt.text), bt && bt.text.slice(0, 900));
  // COMP converted to EUR
  await cmd(page, "COMP"); await page.waitForTimeout(1800); await page.click('[data-cccy="EUR"]'); await page.waitForTimeout(1800);
  const cp = await winOf(page, "COMPARE");
  ok("[J] COMP: converted to EUR at the ECB rate of each day (the series from /api/portfolio/fx)", /converted at the ECB reference rate of each day/.test(cp.text) && !/N\/A:/.test(cp.text) && (await page.$$eval(".win canvas", (c) => c.length)) > 0, cp.text.slice(0, 500));
  // CROSS stats
  await cmd(page, "CROSS NVDA AAPL"); await page.waitForTimeout(1800);
  const cx = await winOf(page, "CROSS · NVDA / AAPL");
  ok("[J] CROSS: where the ratio sits in its range (percentile) and its z-score — σ of 0 gives — (nothing invented)", /WHERE IT SITS\s+\d+%\s+percentile of the period/.test(cx.text) && /Z-SCORE\s+—/.test(cx.text) && /CORRELATION\s+1\.00/.test(cx.text), cx.text.slice(0, 500));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[J] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== K. most shorted, analysts / short interest / holders in DES, international listing, themes, saved views ===============
{
  const { page, errors } = await openTerminal(OK_API);
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  // MOV · MOST SHORTED
  await cmd(page, "MOV"); await page.waitForTimeout(600); await page.click('[data-mv="SHORT"]'); await page.waitForTimeout(2500);
  let mv = await winOf(page, "MARKET MOVERS");
  ok("[K] MOV most shorted: FINRA short interest of the latest settlement, % of shares from Nasdaq's market cap ÷ price (DERIVED), days to cover, size filter ≥ $300M by default", /FINRA consolidated short interest, settlement of\s+\d{2} \w{3,4} 2026/.test(mv.text) && /1\s+NVDA\s+NVIDIA Corporation\s+1\.29%\s+311\.4M\s+\+5\.8%\s+2\.82/.test(mv.text) && /2\s+JPM\s+JP Morgan Chase & Co\.\s+0\.72%/.test(mv.text) && !/AMEX1/.test(mv.text), mv.text.slice(0, 900));
  await page.click('[data-scap="0"]'); await page.waitForTimeout(500);
  mv = await winOf(page, "MARKET MOVERS");
  ok("[K] MOV most shorted: ANY SIZE brings in the small cap with the highest short share", /1\s+AMEX1\s+Small Co\s+93\.\d\d%/.test(mv.text), mv.text.slice(0, 600));
  await page.click('[data-ssrt="days"]'); await page.waitForTimeout(400);
  mv = await winOf(page, "MARKET MOVERS");
  ok("[K] MOV most shorted: sort by days to cover", mv.text.indexOf("AMEX1") < mv.text.indexOf("NVDA") && mv.text.indexOf("NVDA") < mv.text.indexOf("JPM"));
  // DES AAPL: analysts, short interest, holders
  await cmd(page, "DES AAPL"); await page.waitForTimeout(3000);
  const ds = await winOf(page, "DES · AAPL");
  ok("[K] DES analysts (Nasdaq): mean rating with the number of analysts, consensus target and range, upside vs the live price (DERIVED), buy / hold / sell, EPS forecasts", /MEAN RATING\s*LIVE\s+Buy\s+based on 29 analysts/.test(ds.text) && /PRICE TARGET\s*LIVE\s+\$301\.44/.test(ds.text) && /UPSIDE\s*DRV\s+\+20\.6%/.test(ds.text) && /Dec 2026\s+2\.90\s+2\.68\s+3\.04\s+6/.test(ds.text) && /Sep 2027\s+9\.59/.test(ds.text), ds.text.slice(ds.text.indexOf("ANALYSTS"), ds.text.indexOf("ANALYSTS") + 900));
  ok("[K] DES short interest (FINRA): latest settlement, change, days to cover, % of shares on the SEC cover page (DERIVED), short volume of the last sessions", /SHORT INTEREST\s*LIVE\s+120\.8M\s+shares, settlement 30 Sept? 2026/.test(ds.text) && /DAYS TO COVER\s*LIVE\s+3\.03/.test(ds.text) && /% OF SHARES OUTSTANDING\s*DRV\s+0\.8\d%/.test(ds.text) && /SHORT VOLUME\s*LIVE\s+40\.0%/.test(ds.text), ds.text.slice(ds.text.indexOf("SHORT INTEREST ·"), ds.text.indexOf("SHORT INTEREST ·") + 900));
  ok("[K] DES institutional holders (Nasdaq, 13F): ownership, holders, top holders with their filing date", /INSTITUTIONAL OWNERSHIP\s*LIVE\s+61\.20%/.test(ds.text) && /Vanguard Group Inc\s+30 Jun 2026\s+1\.43B\s+\+26\.9M\s+\+1\.92%\s+\$358\.00B/.test(ds.text), ds.text.slice(ds.text.indexOf("INSTITUTIONAL HOLDERS"), ds.text.indexOf("INSTITUTIONAL HOLDERS") + 700));
  // DES for a listing outside the U.S. (CNBC)
  await cmd(page, "DES ISP:XMIL"); await page.waitForTimeout(1800);
  const di = await winOf(page, "DES · ISP:XMIL");
  ok("[K] DES international listing: CNBC's quote and fundamentals, no SEC profile claimed", !!di && /Intesa Sanpaolo S\.p\.A\./.test(di.text) && /Milan Stock Exchange · EUR · IT · CNBC ISP-IT/.test(di.text) && /Not an SEC registrant/.test(di.text) && /MARKET CAP\s*LIVE\s+103\.87B EUR/.test(di.text) && /P\/E\s*LIVE\s+10\.6×/.test(di.text) && /DIVIDEND YIELD\s*LIVE\s+6\.27%/.test(di.text), di && di.text.slice(0, 900));
  // themes
  await cmd(page, "SET"); await page.waitForTimeout(400); await page.click('[data-theme="nord"]'); await page.waitForTimeout(300);
  const th = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), panel: getComputedStyle(document.documentElement).getPropertyValue("--panel").trim(), accent: getComputedStyle(document.documentElement).getPropertyValue("--amber").trim(), n: document.querySelectorAll("[data-theme]").length, saved: localStorage.getItem("at-theme"), bar: getComputedStyle(document.querySelector("#cmdbar")).backgroundImage }));
  await page.click('[data-theme="amber"]'); await page.waitForTimeout(300);
  const th2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), bar2 = await page.evaluate(() => getComputedStyle(document.querySelector("#cmdbar")).backgroundImage);
  ok("[K] the top command bar follows the theme (NORD's panels), AMBER keeps its own gradient", /rgb\(46, 52, 64\)/.test(th.bar) && /rgb\(18, 22, 32\)/.test(bar2), th.bar + " | " + bar2);
  ok("[K] SET: eight themes with full palettes (NORD sets background, panels, accent; AMBER restores the default background)", th.n === 8 && th.bg === "#242933" && th.panel === "#2e3440" && th.accent === "#88c0d0" && /nord|242933/.test(th.saved) && th2 === "#0a0b0e", JSON.stringify(th) + " " + th2);
  // saved views
  await cmd(page, "CLOSE"); await cmd(page, "CB"); await cmd(page, "SPRD"); await page.waitForTimeout(600);
  await cmd(page, "VIEW"); await page.waitForTimeout(800);
  await page.fill('.vw-f input[name="name"]', "Rates desk"); await page.click('.vw-f button[type="submit"]'); await page.waitForTimeout(900);
  let vw = await winOf(page, "SAVED VIEWS");
  ok("[K] VIEW: the current layout is saved on the server under a name (without the views window itself)", /Saved: Rates desk/.test(vw.text) && /Rates desk\s+CB · SPRD/.test(vw.text) && JSON.parse(PV.kv.get("ud/views"))[0].layout.map((x) => x.type).join() === "CB,SPRD", vw.text.slice(0, 400));
  await cmd(page, "N"); await page.waitForTimeout(400); await cmd(page, "VIEW"); await page.waitForTimeout(400);
  await page.click(".vw-open"); await page.waitForTimeout(1200);
  const titles = await page.$$eval(".win .w-title", (t) => t.map((x) => x.textContent));
  ok("[K] VIEW: opening a view closes the current windows and reopens the saved ones", titles.includes("CENTRAL BANKS") && titles.includes("SPREADS") && !titles.includes("NEWS"), titles.join("|"));
  await cmd(page, "UNDO"); await page.waitForTimeout(600);
  ok("[K] VIEW: UNDO brings back the windows a view replaced", (await page.$$eval(".win .w-title", (t) => t.map((x) => x.textContent))).includes("NEWS"));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[K] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== L. iPhone: the installable app — one window at a time, tab bar, sheet, no keyboard pop-ups, sign-in ===============
{
  const api = { ...OK_API, phone: true };
  const { page, errors } = await openTerminal(api);
  await page.waitForTimeout(1500);
  const vis = () => page.evaluate(() => [...document.querySelectorAll(".win")].filter((w) => getComputedStyle(w).display !== "none").map((w) => w.querySelector(".w-title").textContent));
  const st0 = await page.evaluate(() => ({ phone: document.body.classList.contains("phone"), tabs: [...document.querySelectorAll("#fnbar .ptab")].map((b) => b.dataset.code + (b.classList.contains("on") ? "*" : "")).join(","), n: document.querySelector("#fnbar .pt-n")?.textContent,
    over: document.documentElement.scrollWidth - innerWidth, cmdFont: getComputedStyle(document.querySelector("#cmd")).fontSize, active: document.activeElement && document.activeElement.id, safe: getComputedStyle(document.querySelector("#cmdbar")).paddingTop }));
  ok("[L] iPhone: phone layout, one window shown (MARKETS, the last opened), tab bar MKT/WL/N/PF/MENU/WIN with MKT on and 2 windows", st0.phone && JSON.stringify(await vis()) === '["MARKETS"]' && st0.tabs === "MKT*,WL,N,PF,MENU,WIN" && st0.n === "2", JSON.stringify(st0));
  ok("[L] iPhone: no sideways page scroll; the command line at 16px (iOS does not zoom); no field focused at start (no keyboard)", st0.over <= 0 && st0.cmdFont === "16px" && st0.active !== "cmd", JSON.stringify(st0));
  const fit = await page.evaluate(() => ({ h: innerHeight, app: document.querySelector("#app").getBoundingClientRect().height, dock: document.querySelector("#dock").getBoundingClientRect().bottom, v: getComputedStyle(document.documentElement).getPropertyValue("--app-h").trim() }));
  ok("[L] iPhone: the app is exactly the window's height (no viewport units): the tab bar sits on the bottom edge", fit.v === fit.h + "px" && Math.abs(fit.app - fit.h) < 1 && Math.abs(fit.dock - fit.h) < 1, JSON.stringify(fit));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-markets.png" });
  const backOf = () => page.evaluate(() => { const b = [...document.querySelectorAll(".win.front .w-back")][0]; return b && !b.hidden && getComputedStyle(b).display !== "none" ? b.textContent : null; });
  ok("[L] iPhone: at start there is nothing to go back to (no ‹)", (await backOf()) === null);
  await page.tap('#fnbar .ptab[data-code="WL"]'); await page.waitForTimeout(500);
  ok("[L] iPhone: tapping WATCH brings the watchlist to the front and hides the board", JSON.stringify(await vis()) === '["WATCHLIST"]' && (await page.$eval('#fnbar .ptab[data-code="WL"]', (b) => b.classList.contains("on"))));
  ok("[L] iPhone: BACK shows where it goes (‹ MKT)", (await backOf()) === "‹ MKT", String(await backOf()));
  await page.tap(".win.front .w-back"); await page.waitForTimeout(400);
  ok("[L] iPhone: ‹ goes back to the board; nothing further back", JSON.stringify(await vis()) === '["MARKETS"]' && (await backOf()) === null);
  await page.tap('#fnbar .ptab[data-code="N"]'); await page.waitForTimeout(500); await page.tap('#fnbar .ptab[data-code="WL"]'); await page.waitForTimeout(500);
  // a swipe from the left edge to the right, as in iOS apps
  await page.evaluate(() => { const el = document.querySelector(".win.front .win-body"), mk = (x, y) => new Touch({ identifier: 7, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [mk(8, 400)], changedTouches: [mk(8, 400)], bubbles: true }));
    el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [mk(150, 410)], bubbles: true })); });
  await page.waitForTimeout(400);
  ok("[L] iPhone: a swipe from the left edge goes back one window (WATCHLIST → NEWS)", JSON.stringify(await vis()) === '["NEWS"]' && (await backOf()) === "‹ MKT", JSON.stringify(await vis()) + " " + (await backOf()));
  await page.tap(".win.front .w-close"); await page.waitForTimeout(400);
  ok("[L] iPhone: closing the window in front shows the previous one; a closed window is never a BACK target", JSON.stringify(await vis()) === '["WATCHLIST"]' && (await backOf()) === "‹ MKT", JSON.stringify(await vis()) + " " + (await backOf()));
  await page.tap("#cmd"); await page.fill("#cmd", "NVDA"); await page.press("#cmd", "Enter"); await page.waitForTimeout(900);
  const gp = await page.evaluate(() => ({ active: document.activeElement && document.activeElement.id, n: document.querySelector("#fnbar .pt-n").textContent }));
  ok("[L] iPhone: a ticker typed in the command line opens full screen and the keyboard closes", (await vis())[0].startsWith("NVDA") && gp.active !== "cmd" && gp.n === "3", JSON.stringify(gp));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-gp.png" });
  await page.tap('#fnbar .ptab[data-code="WIN"]'); await page.waitForTimeout(400);
  const sheet = await page.evaluate(() => ({ on: document.querySelector("#wsheet")?.classList.contains("on"), rows: [...document.querySelectorAll("#wsheet .ws-open")].map((b) => b.innerText.replace(/\s+/g, " ")) }));
  ok("[L] iPhone: WINDOWS lists the open windows, the front one first", sheet.on && sheet.rows.length === 3 && sheet.rows[0].startsWith("GP NVDA") && sheet.rows.some((r) => r.startsWith("WL")) && sheet.rows.some((r) => r.startsWith("MKT")), JSON.stringify(sheet));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-windows.png" });
  await page.locator("#wsheet .ws-row .ws-x").first().tap(); await page.waitForTimeout(400);
  ok("[L] iPhone: closing the front window shows the most recent other one", JSON.stringify(await vis()) === '["WATCHLIST"]' && (await page.$$("#wsheet .ws-row")).length === 2);
  await page.tap('#wsheet [data-a="close"]'); await page.waitForTimeout(400);
  const empty = await page.evaluate(() => ({ e: document.querySelector("#desk").dataset.empty || "", n: document.querySelectorAll(".win").length }));
  ok("[L] iPhone: CLOSE ALL leaves a hint, not an empty screen", empty.n === 0 && /tap a function below/.test(empty.e), JSON.stringify(empty));
  await page.tap('#wsheet [data-a="undo"]'); await page.waitForTimeout(600); await page.tap("#wsheet .ws-done"); await page.waitForTimeout(300);
  ok("[L] iPhone: REOPEN brings the windows back, one in front", (await page.$$(".win")).length === 2 && (await vis()).length === 1 && !(await page.$eval("#wsheet", (x) => x.classList.contains("on"))));
  await page.tap('#fnbar .ptab[data-code="MENU"]'); await page.waitForTimeout(400);
  const menu = await page.evaluate(() => { const c = document.querySelector("#fnmenu .fm-card"), r = c.getBoundingClientRect(); return { on: document.querySelector("#fnmenu").classList.contains("on"), full: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, x: !!c.querySelector(".fm-x"), focused: document.activeElement && document.activeElement.classList.contains("fm-in") }; });
  ok("[L] iPhone: MENU opens the functions full screen with a close button, without opening the keyboard", menu.on && menu.full && menu.x && !menu.focused, JSON.stringify(menu));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-menu.png" });
  await page.tap('#fnmenu .fm-i[data-fn="CMDTY"]'); await page.waitForTimeout(1500);
  ok("[L] iPhone: a function from the menu opens in front; the menu closes", JSON.stringify(await vis()) === '["COMMODITIES"]' && !(await page.$eval("#fnmenu", (x) => x.classList.contains("on"))));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-cmdty.png" });
  // the band under the clock and the header take the theme's background (and the browser's theme colour follows)
  await page.fill("#cmd", "SET"); await page.press("#cmd", "Enter"); await page.waitForTimeout(500); await page.tap('[data-theme="nord"]'); await page.waitForTimeout(400);
  const band = await page.evaluate(() => { const tb = document.querySelector("#topband"), r = tb.getBoundingClientRect(), cs = getComputedStyle(tb);
    return { head: getComputedStyle(document.querySelector("#cmdbar")).backgroundColor, html: getComputedStyle(document.documentElement).backgroundColor, meta: document.querySelector('meta[name="theme-color"]').content,
      top: { bg: cs.backgroundColor, pos: cs.position, top: r.top, w: r.width, h: r.height }, sticky: getComputedStyle(document.querySelector("#cmdbar")).position + "/" + getComputedStyle(document.querySelector("#dock")).position }; });
  ok("[L] iPhone: with the NORD theme the band under the clock (a fixed full-width bar at the top edge: iOS extends its colour instead of blurring), the header and the page are NORD's background", band.head === "rgb(36, 41, 51)" && band.html === "rgb(36, 41, 51)" && band.meta === "#242933" && band.top.bg === "rgb(36, 41, 51)" && band.top.pos === "fixed" && band.top.top === 0 && band.top.w === 393 && band.top.h >= 6 && band.sticky === "sticky/sticky", JSON.stringify(band));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-nord.png" });
  await page.tap('[data-theme="amber"]'); await page.waitForTimeout(300);
  ok("[L] iPhone: back to AMBER, the default background again", (await page.evaluate(() => getComputedStyle(document.querySelector("#cmdbar")).backgroundColor)) === "rgb(10, 11, 14)" && (await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content)) === "#0a0b0e");
  // the app stays open for days: an expired Cloudflare Access session is said, with a way to sign in again
  api.health = () => ({ status: 403, body: { error: "access" } }); api.quote = () => ({ status: 403, body: { error: "access" } });
  await page.evaluate(() => fetch("https://alessandrozanichelli.com/api/quote?symbols=NVDA").catch(() => null)); await page.waitForTimeout(800);
  const nb = await page.evaluate(() => ({ on: document.querySelector("#netbar").classList.contains("on"), t: document.querySelector("#netbar").innerText }));
  ok("[L] session expired → SESSION EXPIRED bar with SIGN IN (a reload goes to the Access sign-in)", nb.on && /SESSION EXPIRED/.test(nb.t) && /SIGN IN/.test(nb.t), JSON.stringify(nb));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/phone-session.png" });
  api.health = () => ({ body: { ok: true } }); api.quote = OK_API.quote;
  await page.evaluate(() => fetch("https://alessandrozanichelli.com/api/quote?symbols=NVDA").catch(() => null)); await page.waitForTimeout(500);
  ok("[L] the bar goes away as soon as /api answers again", !(await page.$eval("#netbar", (x) => x.classList.contains("on"))));
  // installable: manifest (with the Access cookie), icons, iOS tags
  const man = await page.evaluate(async () => { const l = document.querySelector('link[rel="manifest"]'), m = await (await fetch(l.href, { credentials: "include" })).json();
    const icons = await Promise.all(m.icons.map(async (i) => { const r = await fetch(new URL(i.src, l.href)); return r.ok && (r.headers.get("content-type") || "").includes("png"); }));
    return { cred: l.crossOrigin, m: { name: m.name, start: m.start_url, scope: m.scope, display: m.display, bg: m.background_color }, icons, apple: !!document.querySelector('link[rel="apple-touch-icon"]'), capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
      bar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content, launch: document.querySelectorAll('link[rel="apple-touch-startup-image"]').length,
      launchOk: (await Promise.all([...document.querySelectorAll('link[rel="apple-touch-startup-image"]')].map(async (x) => (await fetch(x.href)).ok))).every(Boolean) }; });
  ok("[L] installable: manifest fetched with credentials (Access), standalone, start /terminal/desk/, icons and launch images served, iOS tags", man.cred === "use-credentials" && man.m.display === "standalone" && man.m.start === "/terminal/desk/" && man.m.scope === "/terminal/" && man.icons.length >= 3 && man.icons.every(Boolean) && man.apple && man.capable === "yes" && man.bar === "black-translucent" && man.launch === 10 && man.launchOk, JSON.stringify(man));
  await page.setViewportSize({ width: 1400, height: 900 }); await page.waitForTimeout(700);
  const desk = await page.evaluate(() => ({ phone: document.body.classList.contains("phone"), shown: [...document.querySelectorAll(".win")].filter((w) => getComputedStyle(w).display !== "none").length, n: document.querySelectorAll(".win").length, fn: document.querySelectorAll("#fnbar .ptab").length }));
  ok("[L] wider than a phone (rotated tablet, desktop): back to floating windows, all shown, the desktop dock", !desk.phone && desk.shown === desk.n && desk.n >= 2 && desk.fn === 0, JSON.stringify(desk));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[L] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== M. split screen (desktop): two windows side by side, a divider, swap, the second-window chooser ===============
{
  const { page, errors } = await openTerminal(OK_API);
  await page.waitForTimeout(1500);
  const geo = () => page.evaluate(() => { const d = document.querySelector("#desk").getBoundingClientRect();
    const ws = [...document.querySelectorAll(".win")].map((w) => { const r = w.getBoundingClientRect(); return { t: w.querySelector(".w-title").textContent, x: Math.round(r.left - d.left), w: Math.round(r.width), h: Math.round(r.height), z: +w.style.zIndex }; });
    const dv = document.querySelector(".split-div"); return { dw: Math.round(d.width), dh: Math.round(d.height), ws, div: dv ? Math.round(dv.getBoundingClientRect().left - d.left) : null, on: !!document.querySelector(".tb-split.on") }; });
  const pick = (g, re) => g.ws.find((w) => re.test(w.t));
  await page.click(".tb-split"); await page.waitForTimeout(500);
  let g = await geo(); const L = pick(g, /^GOVERNMENT|^YIELD/), R = pick(g, /^MARKETS/), half = Math.round((g.dw - 6) / 2);
  ok("[M] SPLIT (taskbar ◫): the window in front on the left half, the previous one on the right, full height, a divider between", L && R && L.x === 0 && Math.abs(L.w - half) <= 1 && Math.abs(R.x - (half + 6)) <= 1 && L.h === g.dh && R.h === g.dh && g.div !== null && Math.abs(g.div - half) <= 1 && g.on, JSON.stringify(g));
  await page.click(".tb-split"); await page.waitForTimeout(400); g = await geo();
  ok("[M] SPLIT again swaps the two", pick(g, /^MARKETS/).x === 0 && pick(g, /^GOVERNMENT|^YIELD/).x > 0, JSON.stringify(g.ws));
  const dvb = await page.$eval(".split-div", (d) => { const r = d.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const deskBox = await page.$eval("#desk", (d) => { const r = d.getBoundingClientRect(); return { x: r.left, w: r.width }; });
  await page.mouse.move(dvb.x, dvb.y); await page.mouse.down(); await page.mouse.move(deskBox.x + deskBox.w * 0.7, dvb.y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(300); g = await geo();
  ok("[M] dragging the divider resizes both: 70 / 30", Math.abs(pick(g, /^MARKETS/).w / g.dw - 0.7) < 0.02 && Math.abs(pick(g, /^MARKETS/).w + 6 + pick(g, /^GOVERNMENT|^YIELD/).w - g.dw) <= 2, JSON.stringify(g.ws));
  await page.dblclick(".split-div"); await page.waitForTimeout(300); g = await geo();
  ok("[M] double-click on the divider: half and half", Math.abs(pick(g, /^MARKETS/).w - Math.round((g.dw - 6) / 2)) <= 1);
  await page.setViewportSize({ width: 1300, height: 900 }); await page.waitForTimeout(500); g = await geo();
  ok("[M] the split follows the browser's size", Math.abs(pick(g, /^MARKETS/).w - Math.round((g.dw - 6) / 2)) <= 1 && pick(g, /^MARKETS/).h === g.dh && g.dw <= 1300 && g.div !== null, JSON.stringify(g));
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.waitForTimeout(500);
  // moving one of the two ends the split
  const hd = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("MARKETS")); const r = w.querySelector(".w-title").getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; });
  await page.mouse.move(hd.x, hd.y); await page.mouse.down(); await page.mouse.move(hd.x + 120, hd.y + 140, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(300); g = await geo();
  ok("[M] dragging a split window ends the split (divider gone, the window where it was dropped)", g.div === null && !g.on && pick(g, /^MARKETS/).x > 50, JSON.stringify(g));
  // SPLIT A B from the command line
  await cmd(page, "SPLIT NVDA MSFT"); await page.waitForTimeout(800); g = await geo();
  const n1 = pick(g, /^NVDA/), m1 = pick(g, /^MSFT/);
  ok("[M] SPLIT NVDA MSFT: two charts side by side, NVDA left", n1 && m1 && n1.x === 0 && m1.x > g.dw / 2 - 5 && g.div !== null, JSON.stringify(g.ws));
  // one window only: the other half asks which window
  await cmd(page, "CLOSE"); await page.waitForTimeout(300); await cmd(page, "MKT"); await page.waitForTimeout(600);
  await page.click(".win .w-split"); await page.waitForTimeout(300);
  const ph = await page.evaluate(() => { const p = document.querySelector(".split-ph"); return p ? p.innerText : null; });
  ok("[M] one window and ◫: it takes the left half, the right half asks for the second window", ph && /SECOND WINDOW/.test(ph) && /FUNCTIONS/.test(ph) && /Cancel/.test(ph), String(ph));
  await cmd(page, "WL"); await page.waitForTimeout(700); g = await geo();
  ok("[M] …the next window opened fills it", pick(g, /^MARKETS/).x === 0 && pick(g, /^WATCHLIST/).x > g.dw / 2 - 5 && !(await page.$(".split-ph")) && g.div !== null, JSON.stringify(g));
  // Alt+→: the window in front goes right
  await page.click(".tb-close"); await page.waitForTimeout(200); await cmd(page, "N"); await page.waitForTimeout(400); await cmd(page, "CAL"); await page.waitForTimeout(600);
  await page.click("#desk", { position: { x: 5, y: 5 } }).catch(() => null); await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("Alt+ArrowRight"); await page.waitForTimeout(400); g = await geo();
  ok("[M] Alt+→: the window in front on the right half, the previous one on the left", pick(g, /^ECONOMIC|^CALENDAR/) && pick(g, /^ECONOMIC|^CALENDAR/).x > g.dw / 2 - 5 && pick(g, /^NEWS/).x === 0, JSON.stringify(g.ws));
  // corners: a window dropped with the pointer in a corner takes that quarter; its content adapts (denser, tables fitted)
  await cmd(page, "CLOSE"); await page.waitForTimeout(300); await cmd(page, "CB"); await page.waitForTimeout(1200);
  const dragTo = async (title, cx, cy) => { const hd2 = await page.evaluate((t) => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith(t)); const r = w.querySelector(".w-title").getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; }, title);
    await page.mouse.move(hd2.x, hd2.y); await page.mouse.down(); await page.mouse.move(cx, cy, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(700); };
  const dbox = await page.$eval("#desk", (d) => { const r = d.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await dragTo("CENTRAL BANKS", dbox.x + 4, dbox.y + 4);
  const fitOf = (t) => page.evaluate((t) => { const d = document.querySelector("#desk").getBoundingClientRect(), w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith(t)), r = w.getBoundingClientRect(), b = w.querySelector(".win-body");
    const tb = [...b.querySelectorAll("table.pf")].map((x) => ({ z: x.style.zoom || "", w: Math.round(x.getBoundingClientRect().width), host: Math.round(x.parentElement.getBoundingClientRect().width) }));
    return { x: Math.round(r.left - d.left), y: Math.round(r.top - d.top), w: Math.round(r.width), h: Math.round(r.height), dw: Math.round(d.width), dh: Math.round(d.height), tb, pad: getComputedStyle(b.querySelector(".pf td") || b).paddingLeft }; }, t);
  let q = await fitOf("CENTRAL BANKS");
  ok("[M] a window dropped in the top-left corner: the top-left quarter", q.x === 0 && q.y === 0 && Math.abs(q.w - Math.floor((q.dw - 6) / 2)) <= 1 && Math.abs(q.h - Math.floor((q.dh - 6) / 2)) <= 1, JSON.stringify(q));
  ok("[M] …its content adapts: denser rows, every table within the quarter (every column kept)", q.pad === "6px" && q.tb.length && q.tb.every((t) => t.w <= t.host + 2 || t.z === "0.8"), JSON.stringify(q.tb) + " pad " + q.pad);
  await cmd(page, "IDX"); await page.waitForTimeout(2500);
  await dragTo("WORLD INDICES", dbox.x + dbox.w - 4, dbox.y + dbox.h - 4);
  q = await fitOf("WORLD INDICES");
  ok("[M] …bottom-right corner: the bottom-right quarter; its wide table drawn smaller to fit", q.x === q.dw - q.w && q.y === q.dh - q.h && Math.abs(q.w - Math.floor((q.dw - 6) / 2)) <= 1 && q.tb.some((t) => t.z && +t.z < 1) && q.tb.every((t) => t.w <= t.host + 2 || t.z === "0.8"), JSON.stringify(q));
  // four windows, one a corner
  await cmd(page, "COT"); await page.waitForTimeout(1200); await dragTo("FUTURES POSITIONING", dbox.x + dbox.w - 4, dbox.y + 4);
  await cmd(page, "YLD"); await page.waitForTimeout(1500); await dragTo("GOVERNMENT YIELDS", dbox.x + 4, dbox.y + dbox.h - 4);
  const four = await Promise.all(["CENTRAL BANKS", "FUTURES POSITIONING", "GOVERNMENT YIELDS", "WORLD INDICES"].map(fitOf));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/quarters.png" });
  ok("[M] four windows in the four corners: one a quarter each, none overlapping, every table within its window", four.every((q) => Math.abs(q.w - Math.floor((q.dw - 6) / 2)) <= 1 && Math.abs(q.h - Math.floor((q.dh - 6) / 2)) <= 1 && q.tb.every((x) => x.w <= x.host + 2 || x.z === "0.8")) && new Set(four.map((q) => q.x + "," + q.y)).size === 4, JSON.stringify(four.map((q) => [q.x, q.y, q.w, q.h, q.tb.map((x) => x.z + ":" + x.w + "/" + x.host).join(" ")])));
  await page.click(".tb-tile").catch(() => null); await cmd(page, "TILE"); await page.waitForTimeout(800);
  q = await fitOf("WORLD INDICES");
  ok("[M] …TILE: the four tiled 2 × 2, the tables still within their windows (at the smallest size they scroll)", Math.abs(q.h - (Math.floor(q.dh / 2) - 6)) <= 2 && q.tb.every((t) => t.w <= t.host + 2 || t.z === "0.8"), JSON.stringify(q));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[M] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "SPLIT NVDA MKT"); await page.waitForTimeout(1500); await page.screenshot({ path: SHOTS + "/split.png" }); }
  await page.close();
}

// =============== O. ISIN search: OpenFIGI's listings, the home market first, the first quotable one opened ===============
{
  const { page, errors } = await openTerminal(OK_API);
  await page.waitForTimeout(1200);
  await cmd(page, "IT0000072618"); await page.waitForTimeout(2500);
  const sr = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("SYMBOL SEARCH") || x.querySelector(".w-tag").textContent === "SRCH"); return w ? w.querySelector(".win-body").innerText : ""; });
  ok("[O] an ISIN in the command line: OpenFIGI's listings of Intesa Sanpaolo, Milan first (home market), Xetra, the U.S. line; source named", /ISIN IT0000072618 · INTESA SANPAOLO — 3 listings, the home market first/.test(sr) && /source OpenFIGI \(ISIN → listings\) · Twelve Data symbol_search/.test(sr) && sr.indexOf("Borsa Italiana") < 0 && /ISP\s+Intesa Sanpaolo S\.p\.A\.\s+XMIL/.test(sr) && sr.indexOf("ISP") < sr.indexOf("IES") && sr.indexOf("IES") < sr.indexOf("ISNPF"), sr.slice(0, 700));
  const gp = await page.$$eval(".win .w-title", (t) => t.map((x) => x.textContent));
  ok("[O] …and the Milan listing opens (quoted through CNBC outside the plan)", gp.some((t) => /^ISP:XMIL/.test(t)), gp.join(" | "));
  await cmd(page, "SRCH DE0007164600"); await page.waitForTimeout(1500);
  const sr2 = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "SRCH"); return w ? w.querySelector(".win-body").innerText : ""; });
  ok("[O] an ISIN OpenFIGI does not know: said so, nothing listed", /ISIN DE0007164600 — no listing found at OpenFIGI \(No identifier found\.\)/.test(sr2) && !/SYMBOL\s+NAME\s+EXCHANGE/.test(sr2), sr2.slice(0, 400));
  ok("[O] no JavaScript errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== P. UCITS ETFs: the European list (SWDA, VWCE …) priced on its CNBC lines; justETF reference data ===============
{
  PV.kv.set(JUSTETF_KEY, JSON.stringify({ IE00B4L5Y983: { ter: 0.2, fundSize: { value: 131754e6, currency: "EUR" }, distribution: "Accumulating", replication: "Physical (Optimized sampling)", domicile: "Ireland", fundCurrency: "USD", hedged: false, inception: "25 September 2009", holdings: 1252, legalStructure: "ETF", fetchedAt: Date.now() - 86400_000 } }));
  const api = { ...OK_API, search: (q) => ({ body: { ...searchBody(q), ucits: ucitsMatch(q) } }) };
  const { page, errors } = await openTerminal(api);
  await page.waitForTimeout(1000);
  PV.cnbcAsked.length = 0;
  await cmd(page, "UCITS");
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("UCITS ETFs")); return w && /SWDA/.test(w.querySelector(".win-body").innerText) && /\+\d+\.\d\d%/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(2500);
  let w = await winOf(page, "UCITS ETFs");
  ok("[P] UCITS command: the European list by class — SWDA priced on its Xetra line (EUNL · Xetra), VWCE, CSSPX; Milan ETFMIB on its Milan line", w && /WORLD EQUITY/.test(w.text) && /SWDA\s+iShares Core MSCI World UCITS ETF USD \(Acc\)\s+IE00B4L5Y983\s+EUNL · Xetra\s+[\d.,]+\s/.test(w.text) && /VWCE/.test(w.text) && /CSSPX/.test(w.text) && /ETFMIB · Borsa Italiana/.test(w.text), w && w.text.slice(0, 900));
  ok("[P] prices from CNBC in two requests for the whole list (≤ 40 codes each), no Twelve Data quote for them", PV.cnbcAsked.filter((x) => x.includes("EUNL-DE") || x.includes("XEON-DE")).length >= 1 && PV.cnbcAsked.every((x) => x.length <= 40));
  ok("[P] returns 1D…1Y from the same line's daily bars; TER, fund size, Acc from justETF for SWDA; N/A where justETF was not read yet", /SWDA[^\n]*\+\d+\.\d\d%[^\n]*0\.20%\s+EUR 131\.8B\s+Acc/.test(w.text) && /VWCE[^\n]*N\/A\s+N\/A/.test(w.text), (w.text.match(/SWDA[^\n]*/) || [""])[0] + " || " + (w.text.match(/VWCE[^\n]*/) || [""])[0]);
  ok("[P] the footer says which price is shown (the line, not necessarily Milan), returns DERIVED, justETF reference data and how many funds were read", /not necessarily the Milan price/.test(w.text) && /returns DERIVED/.test(w.text) && /justETF \(reference data, read weekly\) — 1\/72 read so far/.test(w.text));
  await page.click('[data-uccy="USD"]'); await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("UCITS ETFs")); return w && /IWDA · London/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(1500); w = await winOf(page, "UCITS ETFs");
  ok("[P] CURRENCY USD: SWDA on its own USD line (IWDA · London, USD); a fund without a USD line converted from its Xetra line (→ USD, conv., DRV)", /SWDA\s+iShares Core MSCI World UCITS ETF USD \(Acc\)\s+IE00B4L5Y983\s+IWDA · London\s+[\d.,]+\s+USD/.test(w.text) && /SUSW[^\n]*2B7K · Xetra → USD conv\.\s+[\d.,]+\s+USD/.test(w.text) && /without a USD line: converted at CNBC's live rate/.test(w.text), (w.text.match(/SUSW[^\n]*/) || [""])[0] + " || " + (w.text.match(/SWDA[^\n]*/) || [""])[0]);
  await page.click('[data-uccy="GBP"]'); await page.waitForTimeout(2500); w = await winOf(page, "UCITS ETFs");
  ok("[P] CURRENCY GBP: SWDA's London line in pence shown in GBP", /SWDA\s+iShares Core MSCI World UCITS ETF USD \(Acc\)\s+IE00B4L5Y983\s+SWDA · London\s+[\d.,]+\s+GBP/.test(w.text), (w.text.match(/SWDA[^\n]*/) || [""])[0]);
  await page.click('[data-uccy="EUR"]'); await page.waitForTimeout(1500);
  await page.fill(".uc-q", "vwce"); await page.waitForTimeout(300);
  const vis = await page.$$eval("tr[data-uc]", (t) => t.filter((x) => x.style.display !== "none").map((x) => x.querySelector("b").textContent));
  ok("[P] the filter keeps the funds a ticker names (VWCE → one row)", vis.length === 1 && vis[0] === "VWCE", vis.join());
  await page.fill(".uc-q", ""); await page.click('[data-usort="ter"]'); await page.waitForTimeout(400);
  w = await winOf(page, "UCITS ETFs");
  ok("[P] sorted by TER: the fund with a TER first, the ones not read after it", /^[\s\S]*?SYM[^\n]*\n\s*SWDA/.test(w.text), w.text.slice(0, 400));
  await page.click('[data-euniv="US"]'); await page.waitForTimeout(800);
  const titles = await page.$$eval(".win .w-title", (t) => t.map((x) => x.textContent));
  ok("[P] the same window switches back to the US-listed ETFs", titles.includes("ETFs BY ASSET CLASS"), titles.join(" | "));
  await page.click('[data-euniv="UCITS"]'); await page.waitForTimeout(800);
  await page.click('tr[data-uc="C:EUNL-DE"]'); await page.waitForTimeout(1200);
  const t2 = await page.$$eval(".win .w-title", (t) => t.map((x) => x.textContent));
  ok("[P] a row opens its price line (C:EUNL-DE)", t2.some((t) => /^C:EUNL-DE/.test(t)), t2.join(" | "));
  await cmd(page, "SRCH SWDA"); await page.waitForTimeout(1200);
  const sr = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-tag").textContent === "SRCH"); return w ? w.querySelector(".win-body").innerText : ""; });
  ok("[P] SRCH SWDA: the UCITS fund with its price line on top (EUNL · Xetra), OPEN / +WL / LIST", /UCITS ETF · PRICE ON THE LINE SHOWN \(CNBC\)/.test(sr) && /SWDA\s+iShares Core MSCI World UCITS ETF USD \(Acc\)\s+IE00B4L5Y983\s+EUNL · Xetra/.test(sr), sr.slice(0, 500));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/ucits.png" });
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[P] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined|Infinity/.test(txt) && errors.length === 0, errors.join(" | ") + (txt.match(/.{40}(NaN|undefined|Infinity).{40}/) || [""])[0]);
  await page.close();
  PV.kv.delete(JUSTETF_KEY);
}

// =============== Q. ETF section: screener over every Xetra ETF, profile, compare, the portfolio looked through ===============
{
  const HD = ["IE00B4L5Y983", "IE00BK5BQT80", "IE00B4WXJJ64", "DE000A0S9GB0"];
  PV.kv.set("etf/universe", JSON.stringify({ asOf: "2026-10-21", fetchedAt: Date.now() - 3600_000, source: "Deutsche Börse — T7 (Xetra) All tradable instruments", sourceUrl: "https://www.cashmarket.deutsche-boerse.com/cash-en/trading/Tradable-Instruments-Xetra/",
    rows: [[HD[0], "ISHSIII-CORE MSCI WLD DLA", "ETF", "Passive ETF", "A0RPWH", "EUNL:EUR IWDA:USD"], [HD[1], "VANGUARD FTSE ALL-WLD U.ETF", "ETF", "Passive ETF", "A2PKXG", "VWCE:EUR"], [HD[2], "ISHS EO GOVT BD", "ETF", "Bond ETF", "A0RGEP", "EUNH:EUR"], [HD[3], "XETRA-GOLD", "ETC", "ETC", "A0S9GB", "4GLD:EUR"]] }));
  PV.kv.set("etf/isins", HD.join(","));
  PV.kv.set("etf/us", JSON.stringify({ fetchedAt: Date.now() - 3600_000, source: "Twelve Data — ETF list (reference data)", rows: [["SPY", "SPDR S&P 500 ETF Trust", "ARCX"], ["QQQ", "Invesco QQQ Trust", "XNMS"]] }));
  const day0 = new Date().toISOString().slice(0, 10);
  PV.kv.set("ref/je/table", [[HD[0], "0.2", "131754", "EUR", "A", "P", "Optimized sampling", "Ireland", "USD", "0", "iShares", "Equity, World", "ETF", "25 September 2009", "iShares Core MSCI World UCITS ETF USD (Acc)", day0].join("\t"),
    [HD[1], "0.19", "55100", "EUR", "A", "P", "Sampling", "Ireland", "USD", "0", "Vanguard", "Equity, World", "ETF", "23 July 2019", "Vanguard FTSE All-World UCITS ETF (USD) Accumulating", day0].join("\t")].join("\n"));
  PV.kv.set("ref/je/" + HD[0], JSON.stringify({ ter: 0.2, fundSize: { value: 131754e6, currency: "EUR" }, distribution: "Accumulating", replication: "Physical (Optimized sampling)", domicile: "Ireland", fundCurrency: "USD", hedged: false, inception: "25 September 2009", holdings: 1252, legalStructure: "ETF",
    name: "iShares Core MSCI World UCITS ETF USD (Acc)", provider: "iShares", focus: "Equity, World", index: "MSCI World", approach: "Long-only", sustainable: false, payouts: null,
    top10: [["NVIDIA Corp.", 5.53, "US67066G1040"], ["Apple", 5.07, "US0378331005"], ["Microsoft Corp", 3.9, "US5949181045"]], top10Weight: 26.64, holdingsTotal: 1252, countries: [["United States", 71.53], ["Japan", 5.28], ["Other", 23.19]], sectors: [["Technology", 29.12], ["Other", 70.88]], v: 3, fetchedAt: Date.now() - 86400_000 }));
  // the Vanguard fund's justETF record (test input in the page's format), for the deeper compare
  PV.kv.set("ref/je/" + HD[1], JSON.stringify({ ter: 0.19, fundSize: { value: 55100e6, currency: "EUR" }, distribution: "Accumulating", replication: "Physical (Sampling)", domicile: "Ireland", fundCurrency: "USD", hedged: false, inception: "23 July 2019", holdings: 3759, legalStructure: "ETF",
    name: "Vanguard FTSE All-World UCITS ETF (USD) Accumulating", provider: "Vanguard", focus: "Equity, World", index: "FTSE All-World", approach: "Long-only", sustainable: false, payouts: null,
    top10: [["NVIDIA Corp.", 4.9, "US67066G1040"], ["Apple", 4.4, "US0378331005"], ["Taiwan Semiconductor Manufacturing", 1.4, "TW0002330008"]], top10Weight: 22.1, holdingsTotal: 3759,
    countries: [["United States", 62.5], ["Japan", 5.9], ["China", 3.1], ["Other", 28.5]], sectors: [["Technology", 27.4], ["Financials", 16.2], ["Other", 56.4]], v: 3, fetchedAt: Date.now() - 86400_000 }));
  const pfQ = { tx: [{ id: "t0", date: "2026-01-05", side: "BUY", sym: "C:EUNL-DE", qty: 10, price: 110, ccy: "EUR", fees: 0, note: "", created: 1 }], posts: [], deletes: [] };
  const api = { ...OK_API, portfolio: (u) => pfApi(u, "GET", null, pfQ) };
  const { page, errors } = await openTerminal(api);
  await page.waitForTimeout(1000);
  await cmd(page, "EFS");
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("ETF SCREENER")); return w && /EUNL/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(1500);
  let w = await winOf(page, "ETF SCREENER");
  ok("[Q] EFS: every Xetra ETF of the list (4) with ticker, name from justETF where read, ISIN, type, class, provider, TER, size, Acc, replication", w && /XETRA · EUROPE 4/.test(w.text) && /U\.S\. 2/.test(w.text) && /EUNL\s+iShares Core MSCI World UCITS ETF USD \(Acc\)\s+IE00B4L5Y983\s+ETF\s+Equity\s+iShares\s+0\.20%\s+EUR 131\.8B\s+Acc\s+Phys\./.test(w.text) && /4GLD\s+XETRA-GOLD\s+DE000A0S9GB0\s+ETC\s+ETC/.test(w.text), w && w.text.slice(0, 900));
  ok("[Q] …funds not read from justETF yet: N/A, never filled in; the source and date of the list in the footer", /EUNH\s+ISHS EO GOVT BD\s+IE00B4WXJJ64\s+ETF\s+Bonds\s+—\s+N\/A\s+N\/A/.test(w.text) && /Deutsche Börse \(list of 21 Oct 2026\)/.test(w.text) && /2 funds read so far/.test(w.text), (w.text.match(/EUNH[^\n]*/) || [""])[0]);
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("ETF SCREENER")); return w && /Phys\.\s+[+-]\d+\.\d%/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 20000 }).catch(() => null);
  w = await winOf(page, "ETF SCREENER");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/efs-perf.png" });
  ok("[Q] EFS returns and risk: 1Y and max drawdown from CNBC's bars of the Xetra line (live for the rows on screen); 3Y / 5Y / volatility left out when the history is shorter", /EUNL\s+iShares[^\n]*Phys\.\s+[+-]\d+\.\d%\s+—\s+—\s+—\s+-\d+\.\d%/.test(w.text) && /1Y \/ 3Y \/ 5Y, volatility, max drawdown: CNBC daily bars of the same line/.test(w.text), (w.text.match(/EUNL\s+iShares[^\n]*/) || [""])[0]);
  await page.click('[data-efsort="r1"]'); await page.waitForTimeout(500);
  const sorted1 = await page.evaluate(() => [...document.querySelectorAll('.ef-t tbody tr[data-efp]')].map((tr) => tr.dataset.efp));
  ok("[Q] …sorted by 1Y: the four funds, each with its figure", sorted1.length === 4 && (await page.$eval('[data-efsort="r1"]', (b) => b.getAttribute("aria-pressed"))) === "true", sorted1.join());
  await page.click('[data-efsort="size"]'); await page.waitForTimeout(300);
  await page.click('tr[data-efp="IE00BK5BQT80"] [data-eflab]'); await page.waitForTimeout(700);
  w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] +LAB from the screener: the fund goes into the lab portfolio being built, at the weight still free", w && /IE00BK5BQT80 added at 100 %/.test(w.text) && /TOTAL 100\.00%/.test(w.text), w && w.text.slice(0, 500));
  await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("PORTFOLIO LAB")); if (w) w.querySelector(".w-close")?.click(); });
  await page.waitForTimeout(300);
  await page.fill('input[name="efter"]', "0.19"); await page.waitForTimeout(900); w = await winOf(page, "ETF SCREENER");
  ok("[Q] TER ≤ 0.19: only read funds that pass (VWCE), with the banner on how many are read", /VWCE/.test(w.text) && !/EUNL\s+iShares/.test(w.text) && !/EUNH\s+ISHS/.test(w.text) && /apply to the 2 funds whose justETF data has been read/.test(w.text));
  await page.fill('input[name="efter"]', ""); await page.waitForTimeout(600);
  await page.fill(".ef-q", "msci world"); await page.waitForTimeout(800); w = await winOf(page, "ETF SCREENER");
  ok("[Q] search by name (justETF's or Xetra's): MSCI World → the iShares fund", /EUNL/.test(w.text) && !/VWCE\s+Vanguard/.test(w.text));
  await page.click('tr[data-efp="IE00B4L5Y983"]');
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("ETF PROFILE")); return w && /TOP 10 HOLDINGS/.test(w.querySelector(".win-body").innerText) && /3Y p\.a\./.test(w.querySelector(".win-body").innerText); }, null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(1500); w = await winOf(page, "ETF PROFILE");
  ok("[Q] EFP: justETF reference data (TER, size, replication, provider, focus, inception, holdings), source and date", w && /iShares Core MSCI World UCITS ETF USD \(Acc\)/.test(w.text) && /TER\s+0\.20% p\.a\./.test(w.text) && /PROVIDER\s+iShares/.test(w.text) && /HOLDINGS\s+1,252/.test(w.text) && /justETF\s+· read/.test(w.text), w && w.text.slice(0, 900));
  ok("[Q] …every listing CNBC carries (Xetra EUR first; London USD and GBP), returns in EUR DERIVED from CNBC bars, top 10 / countries / sectors", /EUNL\s+Xetra\s+EUR/.test(w.text) && /IWDA\s+London\s+USD/.test(w.text) && /SWDA\s+London\s+GBP \(GBp ÷ 100\)/.test(w.text) && /RETURNS · EUR/.test(w.text) && /Returns DERIVED from CNBC daily bars/.test(w.text) && /NVIDIA Corp\.\s+5\.53%/.test(w.text) && /United States\s+71\.53%/.test(w.text), w.text.slice(800, 2200));
  await page.click(".efp-cmp"); await page.waitForTimeout(800);
  await page.fill(".efc-in", "VWCE"); await page.press(".efc-in", "Enter");
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("ETF COMPARE")); return w && /Vanguard/.test(w.querySelector(".win-body").innerText) && /CALENDAR YEARS/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(1500); w = await winOf(page, "ETF COMPARE");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/efc.png" });
  ok("[Q] EFC: two funds (the iShares from its profile, VWCE typed) in EUR on their own Xetra lines, on the days both traded: TER, a year, volatility, Sharpe, drawdown, years, correlations, charts", w && /iShares Core MSCI World/.test(w.text) && /Vanguard FTSE All-World/.test(w.text) && /EUNL · Xetra/.test(w.text) && /VWCE · Xetra/.test(w.text) && /0\.19%/.test(w.text) && /REBASED TO 100 · EUR/.test(w.text) && /CORRELATIONS \(DAILY RETURNS\)/.test(w.text) && /on the \d+ days all these funds traded/.test(w.text) && (await page.$$(".efc-box canvas")).length > 0 && (await page.$$(".efc-dd canvas")).length > 0, w && w.text.slice(0, 900));
  await page.click('[data-efcp="1"]'); await page.waitForTimeout(800); w = await winOf(page, "ETF COMPARE");
  ok("[Q] …period 1Y: the window cut to the last year", /on the 2\d\d days all these funds traded/.test(w.text), (w.text.match(/on the \d+ days[^)]*\)/) || [""])[0]);
  // the deeper compare: what each fund is and holds (justETF), and its factor loadings (Fama/French)
  const efcView = async (v, re) => { await page.click(`[data-efcv="${v}"]`); await page.waitForFunction((r) => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("ETF COMPARE")); return w && new RegExp(r).test(w.querySelector(".win-body").innerText); }, re, { timeout: 25000 }).catch(() => null); await page.waitForTimeout(400); return winOf(page, "ETF COMPARE"); };
  w = await efcView("PROF", "SUSTAINABLE");
  ok("[Q] EFC PROFILE: per fund from justETF — asset class, focus, index, provider, TER (lowest ◆), size, holdings (most ◆), top-10 weight, replication, distribution, currency, domicile, inception, approach, sustainability", /ASSET CLASS\s+Equity\s+Equity/.test(w.text) && /FOCUS\s+World\s+World/.test(w.text) && /INDEX\s+MSCI World\s+FTSE All-World/.test(w.text) && /PROVIDER\s+iShares\s+Vanguard/.test(w.text) && /TER\s+0\.20% p\.a\.\s+0\.19% p\.a\. ◆/.test(w.text) && /FUND SIZE\s+EUR 131\.8B ◆\s+EUR 55\.1B/.test(w.text) && /HOLDINGS\s+1,252\s+3,759 ◆/.test(w.text) && /TOP 10 WEIGHT\s+26\.64%\s+22\.10%/.test(w.text) && /APPROACH\s+Long-only\s+Long-only/.test(w.text) && /SUSTAINABLE\s+No\s+No/.test(w.text) && /reference data, never prices/.test(w.text), w.text.slice(0, 1500));
  w = await efcView("HOLD", "OVERLAP");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/efc-hold.png" });
  ok("[Q] EFC HOLDINGS: each fund's top 10; overlap on the top 10s matched by ISIN (NVIDIA + Apple → 9.3 %); the holdings in both with each weight", /OVERLAP \(TOP 10s\)/.test(w.text) && /9\.3%/.test(w.text) && /NVIDIA Corp\.\s+US67066G1040\s+5\.53%\s+4\.90%/.test(w.text) && /Apple\s+US0378331005\s+5\.07%\s+4\.40%/.test(w.text) && !/Microsoft Corp\s+US5949181045\s+3\.90%/.test(w.text) && /floor of the real overlap/.test(w.text), w.text.slice(0, 1500));
  w = await efcView("CTRY", "Other / not listed");
  ok("[Q] EFC COUNTRIES: one row per country any fund lists, — where a fund does not list it (not zero), the rest per fund", /United States\s+71\.53%\s+62\.50%/.test(w.text) && /China\s+—\s+3\.10%/.test(w.text) && /Other \/ not listed\s+23\.19%\s+28\.50%/.test(w.text) && /not zero/.test(w.text), w.text.slice(0, 900));
  w = await efcView("SECT", "Other / not listed");
  ok("[Q] EFC SECTORS: the same for sectors", /Technology\s+29\.12%\s+27\.40%/.test(w.text) && /Financials\s+—\s+16\.20%/.test(w.text), w.text.slice(0, 700));
  w = await efcView("FACT", "MARKET|N\\/A");
  await page.click('[data-efcy="10"]'); await page.waitForTimeout(400);
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("ETF COMPARE")); return w && /ALPHA/.test(w.querySelector(".win-body").innerText) && /MONTHS/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(600); w = await winOf(page, "ETF COMPARE");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/efc-fact.png" });
  ok("[Q] EFC FACTORS: per fund the Fama/French loadings (market, size, value, profitability, investment, momentum) with t, alpha a year, R², months, the listing; region and years chosen; how to read them said", /MARKET\s+Mkt−RF\s+[+-]\d+\.\d\d t -?\d+\.\d/.test(w.text) && /SIZE\s+SMB/.test(w.text) && /MOMENTUM\s+MOM/.test(w.text) && /ALPHA\s+a year/.test(w.text) && /R²\s+explained\s+\d+%/.test(w.text) && /MONTHS\s+\d+/.test(w.text) && /Kenneth R\. French Data Library/.test(w.text) && /SIZE > 0 tilts to small companies/.test(w.text), w.text.slice(0, 1500));
  await page.click('[data-efcv="PERF"]'); await page.waitForTimeout(500);
  await cmd(page, "EXPO");
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("PORTFOLIO · ETF LOOK-THROUGH")); return w && /COUNTRIES/.test(w.querySelector(".win-body").innerText) && /United States/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(1000); w = await winOf(page, "PORTFOLIO · ETF LOOK-THROUGH");
  ok("[Q] EXPO: the portfolio's ETF (C:EUNL-DE → IE00B4L5Y983) looked through: countries, sectors, holdings weighted, coverage said, DERIVED", w && /C:EUNL-DE\s+IE00B4L5Y983\s+100\.0%\s+looked through/.test(w.text) && /United States\s+71\.53%/.test(w.text) && /covers 100\.0% of the ETFs' value/.test(w.text) && /lower bound/.test(w.text), w && w.text.slice(0, 900));
  // FACT: the portfolio (C:EUNL-DE → the world fund IE00B4L5Y983) on the Developed factors, then one U.S. stock — 10 years, monthly
  await cmd(page, "FACT PORT"); await page.waitForTimeout(800);
  await page.selectOption('.q-f select[name="fyears"]', "10"); await page.click('.q-f button[type="submit"]');
  const factDone = () => page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("QUANT · FACTORS")); return w && /THE FOUR MODELS|N\/A/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 25000 }).catch(() => null);
  await factDone(); await page.waitForTimeout(1200); w = await winOf(page, "QUANT · FACTORS");
  ok("[Q] FACT PORT: the portfolio's ETF on the Developed factors (its justETF focus: World), 120 months, betas with t, alpha, R², the four models, rolling chart", (w && /MY PORTFOLIO/.test(w.text) && /Developed markets \(automatic\)/.test(w.text) && /120 months/.test(w.text) && /MARKET\s+Mkt−RF\s+-?\d+\.\d\d\s+\(t -?\d+\.\d\)/.test(w.text) && /MOMENTUM\s+MOM/.test(w.text) && /THE FOUR MODELS/.test(w.text) && /CAPM\s+FF3\s+FF5\s+FF5 \+ MOM/.test(w.text) && /C:EUNL-DE\s+100\.0%\s+EUNL · Xetra · EUR → USD\s+120\s+yes/.test(w.text)), w && w.text.slice(0, 1600));
  ok("[Q] …sources and method said: the library, the month published, CNBC month-ends converted to USD, today's weights; chart drawn", /Kenneth R\. French Data Library/.test(w.text) && /factors published up to/.test(w.text) && /CNBC daily bars, the last close of each month/.test(w.text) && /today's weights/.test(w.text) && (await page.$$(".q-cv canvas")).length > 0);
  await page.selectOption('.q-f select[name="fsub"]', "one"); await page.waitForTimeout(500);
  await page.fill('.q-f input[name="fid"]', "NVDA"); await page.click('.q-f button[type="submit"]');
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("QUANT · FACTORS · NVDA")); return w && /THE FOUR MODELS|N\/A/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(800); w = await winOf(page, "QUANT · FACTORS");
  ok("[Q] FACT NVDA: a U.S. symbol → the U.S. factors (automatic), in USD (no conversion)", w && /U\.S\. \(automatic\)/.test(w.text) && /NVDA · U\.S\. · USD/.test(w.text) && !/→ USD/.test(w.text.split("THE FOUR MODELS")[0]) && /THE FOUR MODELS/.test(w.text), w && w.text.slice(0, 900));
  // PLAB: build (Xetra/UCITS ticker → ISIN, a U.S. stock, cash), save, backtest, risk and crises, projection, compare, factors
  await cmd(page, "PLAB"); await page.waitForTimeout(800);
  const plAdd = async (t, wt) => { await page.fill(".pl-new", t); await page.fill(".pl-neww", wt); await page.click(".pl-add"); await page.waitForTimeout(400); };
  await plAdd("SWDA", "60"); await plAdd("NVDA", "30"); await plAdd("CASH", "10");
  await page.fill(".pl-name", "Core 60/30/10"); await page.press(".pl-name", "Tab");
  const plWait = (re) => page.waitForFunction((src) => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("PORTFOLIO LAB")); return w && new RegExp(src).test(w.querySelector(".win-body").innerText); }, re.source, { timeout: 25000 }).catch(() => null);
  await plWait(/EUNL · Xetra · EUR[\s\S]*NVDA/); await page.waitForTimeout(800); w = await winOf(page, "PORTFOLIO LAB");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/plab-build.png" });
  ok("[Q] PLAB build: SWDA → its ISIN and its own EUR line, NVDA converted to EUR, cash; total 100 %; weighted TER from justETF; common history", w && /iShares Core MSCI World UCITS ETF USD \(Acc\)\s+IE00B4L5Y983 · EUNL · Xetra · EUR/.test(w.text) && /NVDA\s+U\.S\. · USD → EUR/.test(w.text) && /Cash \(EUR, no interest\)/.test(w.text) && /TOTAL 100\.00%/.test(w.text) && /weighted TER 0\.20% a year on 60\.0%/.test(w.text) && /common history from/.test(w.text), w && w.text.slice(0, 1200));
  await page.click(".pl-save"); await page.waitForTimeout(900); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] …saved on the server (the real Worker code): listed, 1 / 20", /Saved\./.test(w.text) && /1 \/ 20 saved/.test(w.text) && JSON.parse(PV.kv.get("ud/plab") || "[]").length === 1 && JSON.parse(PV.kv.get("ud/plab"))[0].holdings.map((h) => h.id).join() === "SWDA,NVDA,CASH");
  await page.click('[data-plt="test"]'); await plWait(/CALENDAR YEARS/); await page.waitForTimeout(800); w = await winOf(page, "PORTFOLIO LAB");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/plab-test.png" });
  ok("[Q] PLAB backtest: final value, money put in, money- and time-weighted returns, volatility, Sharpe, drawdown, years — portfolio and benchmark; charts", w && /Final value\s+€ [\d,]+\s+€ [\d,]+/.test(w.text) && /Your return a year \(money-weighted\)/.test(w.text) && /Max drawdown\s+-\d+\.\d%/.test(w.text) && /CALENDAR YEARS/.test(w.text) && /the benchmark gets the same money on the same days/.test(w.text) && /stocks without dividends: NVDA/.test(w.text) && (await page.$$(".pl-cv canvas")).length > 0, w && w.text.slice(0, 1500));
  await page.fill('.pl-set input[name="mon"]', "200"); await page.click('.pl-set button[type="submit"]'); await page.waitForTimeout(1000); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] …with 200 a month: more money put in than the initial 10,000, trades counted", /Money put in\s+€ (1\d|[2-9]\d|\d{3}),\d{3}/.test(w.text) && /on the first trading day of each month/.test(w.text), (w.text.match(/Money put in[^\n]*/) || [""])[0]);
  await page.click('[data-plt="risk"]'); await plWait(/STRESS/); await page.waitForTimeout(800); w = await winOf(page, "PORTFOLIO LAB");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/plab-risk.png" });
  ok("[Q] PLAB risk: volatility, VaR / ES, beta, share of risk, correlations, the portfolio in past crises (COVID-19 with a figure)", w && /VOLATILITY A YEAR/.test(w.text) && /VaR · ES 95 %/.test(w.text) && /SHARE OF RISK/.test(w.text) && /CORRELATIONS/.test(w.text) && /COVID-19 crash\s+\d+ \w+ 2020 → \d+ \w+ 2020\s+[−+-]?\d+\.\d%/.test(w.text), w && w.text.slice(0, 1800));
  await page.click('[data-plt="proj"]'); await plWait(/MEDIAN IN/); await page.waitForTimeout(600);
  await page.fill('.pl-pf input[name="target"]', "60000"); await page.click('.pl-pf button[type="submit"]'); await page.waitForTimeout(1500); w = await winOf(page, "PORTFOLIO LAB");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/plab-proj.png" });
  ok("[Q] PLAB projection: median in 10 years, 5–95 %, money put in, probability of the target and of a loss; numbered run; chart", /MEDIAN IN 10 YEARS\s+€ [\d,]+/.test(w.text) && /PROBABILITY OF REACHING € 60,000\s+\d+\.\d%/.test(w.text) && /MONEY PUT IN\s+€ 34,000/.test(w.text) && /Run 1: the same inputs/.test(w.text) && (await page.$$(".pl-pc canvas")).length > 0, w.text.slice(0, 900));
  await page.click('[data-plpm="mine"]'); await page.waitForTimeout(800);
  await page.fill('.pl-pf input[name="mu_0"]', "7"); await page.fill('.pl-pf input[name="vol_0"]', "16"); await page.click('.pl-pf button[type="submit"]'); await page.waitForTimeout(1500); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] PLAB projection with your assumptions: a table per holding (past as the start), your return / volatility, said to be a model", /A MODEL WITH YOUR ASSUMPTIONS — not data/.test(w.text) && /YOUR RETURN % A YEAR/.test(w.text) && /MEDIAN IN 10 YEARS\s+€ [\d,]+/.test(w.text) && /log-normal law with your return/.test(w.text), w.text.slice(0, 1400));
  await page.click('[data-plpm="past"]'); await page.waitForTimeout(400);
  await page.click('[data-plt="build"]'); await page.waitForTimeout(500); await page.click(".pl-copy"); await page.waitForTimeout(900);
  await page.click('[data-plt="cmp"]'); await page.waitForTimeout(600);
  const nPlc = (await page.$$("[data-plc]")).length; for (let i = 0; i < nPlc; i++) { await page.locator("[data-plc]").nth(i).check(); await page.waitForTimeout(400); }
  await plWait(/Weighted TER/); await page.waitForTimeout(800); w = await winOf(page, "PORTFOLIO LAB");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/plab-cmp.png" });
  ok("[Q] PLAB compare: two saved portfolios side by side on the same window, chart", w && /Core 60\/30\/10\s+Core 60\/30\/10 \(copy\)/.test(w.text) && /Sharpe\s+-?\d+\.\d\d\s+-?\d+\.\d\d/.test(w.text) && /Weighted TER\s+0\.20%\s+0\.20%/.test(w.text) && (await page.$$(".pl-cc canvas")).length > 0, w && w.text.slice(0, 1200));
  await page.click('[data-plt="build"]'); await page.waitForTimeout(500); await page.click(".pl-fact"); await page.waitForTimeout(800);
  await page.selectOption('.q-f select[name="fyears"]', "10"); await page.click('.q-f button[type="submit"]'); await factDone(); await page.waitForTimeout(800); w = await winOf(page, "QUANT · FACTORS");
  ok("[Q] FACT from the lab: the lab portfolio's holdings (cash left out) at their target weights", w && /portfolio lab · 2 holdings/.test(w.text) && /THE FOUR MODELS/.test(w.text) && /SWDA\s+66\.7%/.test(w.text), w && w.text.slice(0, 1400));
  await page.click('.win .w-tag:text("PLAB")').catch(() => null); await cmd(page, "PLAB"); await page.waitForTimeout(500);
  await page.click(".pl-del"); await page.click(".pl-del"); await page.waitForTimeout(900);
  ok("[Q] PLAB delete: asked twice, removed from the server", JSON.parse(PV.kv.get("ud/plab")).length === 1);
  // a BTP picked from the ECB list: its terms, today's price typed, priced on the Italian curve (an estimate, said)
  await page.click(".pl-bl-open"); await plWait(/GOVERNMENT BONDS[\s\S]*IT0005436693/); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] PLAB bonds: Italy's government bonds from the ECB list (ISIN, issuer, coupon, maturity, issue), terms not prices", w && /IT0005611303\s+Italian Republic\s+zero\s+12 Feb 2027/.test(w.text) && /IT0005436693\s+Italian Republic\s+0\.6%\s+01 Aug 2031\s+23 Feb 2021\s+EUR/.test(w.text) && /4 of 4 bonds · ECB list of eligible marketable assets of 21 Oct 2026/.test(w.text), w && w.text.slice(0, 1500));
  await page.fill(".pl-blq", "2031"); await page.waitForTimeout(700); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] …a filter on year / coupon / name", w && /1 of 4 bonds/.test(w.text) && !/IT0005611303/.test(w.text));
  await page.click('.pl-bla[data-isin="IT0005436693"]'); await plWait(/ESTIMATE: IT government curve/); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] …added: its terms (ECB), the Italian curve's maturities that bracket its life, spread 0 until a price is typed", w && /Italian Republic 0\.6% 2031-08-01\s+IT0005436693 · BOND · 0\.6% semi-annual · maturity 01 Aug 2031 · issued 23 Feb 2021 · EUR/.test(w.text) && !/not checked for inflation/.test(w.text) && /ESTIMATE: IT government curve \(CNBC (\d+[MY] )+\d+[MY]\) \+ 0 bp \(no price typed: spread 0\)/.test(w.text) && /an estimate priced on the curve, not a market price/.test(w.text), w && w.text.slice(0, 1600));
  await page.fill(".pl-px", "90"); await page.press(".pl-px", "Tab"); await plWait(/set by your price/); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] …today's price typed: the spread set by it, the model's price today = the price", w && /[+−] \d+ bp \(set by your price\) · model price today 90\.00 · yield \d+\.\d\d%/.test(w.text), w && w.text.slice(0, 1600));
  await page.fill(".pl-blq", ""); await page.waitForTimeout(800);
  await page.click('.pl-bla[data-isin="IT0005138828"]'); await plWait(/inflation-linked bond/); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] …an inflation-linked BTP (OpenFIGI's ticker ends in CPI; the ECB list calls it fixed): N/A, never priced on the nominal curve", w && /IT0005138828 · BOND · 1\.25% semi-annual[\s\S]*an inflation-linked bond \(BTP€i, BTP Italia, OATi, iBund …\): it cannot be priced from the nominal curve/.test(w.text), w && w.text.slice(0, 1800));
  await page.click('.pl-rm[data-i="1"]'); await page.waitForTimeout(300);
  await page.fill(".pl-w", "40"); await page.press(".pl-w", "Tab"); await page.waitForTimeout(300); await plAdd("SWDA", "60");
  await page.click('[data-plt="test"]'); await plWait(/Final value/); w = await winOf(page, "PORTFOLIO LAB");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/plab-bond.png" });
  ok("[Q] …backtest with the bond: from its issue date, the estimate said above the figures", w && /Bonds \(Italian Republic 0\.6% 2031-08-01\): no daily market price here — ESTIMATED each day/.test(w.text) && /Final value\s+€ [\d,]+/.test(w.text) && /2021/.test(w.text), w && w.text.slice(0, 1500));
  await page.click('[data-plt="build"]'); await page.waitForTimeout(400);
  await page.fill(".pl-name", "BTP and world"); await page.press(".pl-name", "Tab"); await page.click(".pl-save"); await page.waitForTimeout(900);
  ok("[Q] …saved with the bond's price", (JSON.parse(PV.kv.get("ud/plab")).find((p) => p.name === "BTP and world") || { holdings: [] }).holdings.some((h) => h.id === "IT0005436693" && h.px === 90));
  // WHAT TO BUY: the lab portfolio (BTP 40 % · SWDA 60 %) against your positions (C:EUNL-DE = SWDA's fund) and €1,000
  await page.click('[data-plt="buy"]'); await plWait(/LARGEST GAP FROM THE TARGET/);
  await page.fill('.pl-rb input[name="amt"]', "1000"); await page.click('.pl-rb button[type="submit"]'); await plWait(/ORDERS/); w = await winOf(page, "PORTFOLIO LAB");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/plab-buy.png" });
  const pfV = await page.evaluate(() => { const m = /YOUR POSITIONS NOW \(LIVE, EUR\)\s+€ ([\d,.]+)/.exec([...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("PORTFOLIO LAB")).querySelector(".win-body").innerText); return m ? +m[1].replace(/,/g, "") : NaN; });
  ok("[Q] WHAT TO BUY: your positions valued live in EUR, matched to the target by the fund's ISIN (C:EUNL-DE → SWDA), the BTP not held; €1,000 split — the most underweight first; orders to copy", w && pfV > 0 && /Italian Republic 0\.6% 2031-08-01 not held\s+40\.00%\s+€ 0\.00\s+0\.00%\s+−40\.00\s+BUY € [\d,.]+\s+nominal € [\d,.]+/.test(w.text) && /C:EUNL-DE\s+60\.00%\s+€ [\d,.]+\s+100\.00%\s+\+40\.00/.test(w.text) && /ORDERS\s+COPY\s+BUY\s+IT0005436693\s+€ [\d,.]+\s+nominal/.test(w.text) && /LARGEST GAP FROM THE TARGET\s+Italian Republic 0\.6% 2031-08-01 −40\.00 pts → /.test(w.text), w && w.text.slice(0, 2200));
  await page.fill('.pl-rb input[name="amt"]', "0"); await page.check('.pl-rb input[name="sell"]'); await plWait(/SELL €/); w = await winOf(page, "PORTFOLIO LAB");
  ok("[Q] …also sell: the overweight fund sold down to 60 %, the money to the BTP — weights exact; the gain realised and the 26 % tax, or the loss, said", w && /C:EUNL-DE\s+60\.00%[\s\S]*SELL € [\d,.]+[\s\S]*60\.00%\s+\+0\.00/.test(w.text) && /GAIN REALISED BY THE SALES\s+(€ [\d,.]+ · tax ≈ € [\d,.]+ \(26 %\)|−?€ [\d,.-]+ · a loss)/.test(w.text), w && w.text.slice(0, 2200));
  await page.uncheck('.pl-rb input[name="sell"]'); await page.waitForTimeout(400); await page.click('[data-plt="build"]'); await page.waitForTimeout(400);
  // ALRT · PORTFOLIO OFF TARGET: the same positions on the server (KV pf/tx) against "BTP and world", checked now
  const alBefore = PV.kv.get("ud/alerts"), logBefore = PV.kv.get("ud/alertlog"); PV.kv.set("ud/alerts", "[]"); PV.kv.set("pf/tx", JSON.stringify(pfQ.tx));
  await cmd(page, "ALRT"); await page.waitForTimeout(900); await page.click('[data-ak="drift"]'); await page.waitForTimeout(400);
  const btpId = JSON.parse(PV.kv.get("ud/plab")).find((p) => p.name === "BTP and world").id;
  await page.selectOption('.al-f select[name="plab"]', btpId); await page.fill('.al-f input[name="pp"]', "5"); await page.click('.al-f button[type="submit"]'); await page.waitForTimeout(900);
  let alq = await winOf(page, "ALERTS");
  ok("[Q] ALRT drift: an alert on a saved lab portfolio (≥ 5 pts from a weight), checked weekdays at 18:40, at most once a week", JSON.parse(PV.kv.get("ud/alerts")).some((a) => a.kind === "drift" && a.plab === btpId && a.pp === 5 && a.name === "BTP and world") && /positions vs “BTP and world” ≥ 5 pts from a weight/.test(alq.text) && /weekdays 18:40, at most once a week/.test(alq.text), alq && alq.text.slice(0, 900));
  await page.click(".al-run"); await page.waitForTimeout(1800); alq = await winOf(page, "ALERTS");
  ok("[Q] …CHECK NOW: positions valued on the server (CNBC, EUR), the BTP 40 pts under its weight → the message, recorded once for the week", /“BTP and world”: IT0005436693 −40\.0 pts from its weight/.test(alq.text) && /IT0005436693: 0\.0% · target 40\.0% \(−40\.0 pts\)/.test(alq.text) && /largest gap 40\.0 pts/.test(alq.text) && (JSON.parse(PV.kv.get("ud/alerts"))[0].fired || { keys: [] }).keys.some((k) => /^wk:\d{4}-W\d\d$/.test(k)), alq && alq.text.slice(0, 1500));
  PV.kv.set("ud/alerts", alBefore || "[]"); if (logBefore) PV.kv.set("ud/alertlog", logBefore); PV.kv.delete("pf/tx");
  await page.click('.win .w-tag:text("PLAB")').catch(() => null);
  // WHAT IF: NVDA once in March 2020, SWDA every month from 2019 with a €1 fee
  await cmd(page, "WIF"); await page.waitForTimeout(700);
  const wfAdd = async (id, kind, from, amt, fee) => { await page.fill(".wf-nid", id); await page.selectOption(".wf-nkind", kind); await page.fill(".wf-nfrom", from); await page.fill(".wf-namt", amt); if (fee) await page.fill(".wf-nfee", fee); await page.click(".wf-add"); await page.waitForTimeout(500); };
  await wfAdd("NVDA", "once", "2020-03-16", "2000"); await wfAdd("SWDA", "monthly", "2019-01-01", "200", "1");
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("WHAT IF")); return w && /VALUE TODAY/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(800); w = await winOf(page, "WHAT IF");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/wif.png" });
  ok("[Q] WIF: NVDA once, SWDA monthly with a fee — per row buys, put in, value, gain, a year; total, money-weighted return, the same money in the benchmark; where the gain came from; chart", w && /NVDA\s+16 Mar 2020\s+1\s+€ 2,000\s+€ [\d,]+/.test(w.text) && /MONEY PUT IN\s+€ [\d,]+/.test(w.text) && /YOUR RETURN A YEAR \(MONEY-WEIGHTED\)\s+[+-]?\d+\.\d%/.test(w.text) && /SAME MONEY IN THE BENCHMARK/.test(w.text) && /WHERE THE GAIN CAME FROM/.test(w.text) && /stocks without dividends: NVDA/.test(w.text) && (await page.$$(".wf-cv canvas")).length > 0, w && w.text.slice(0, 1800));
  await page.fill(".wf-name", "Covid buys"); await page.press(".wf-name", "Tab"); await page.waitForTimeout(300); await page.click(".wf-save"); await page.waitForTimeout(900);
  ok("[Q] …saved on the server", JSON.parse(PV.kv.get("ud/wif") || "[]").length === 1 && JSON.parse(PV.kv.get("ud/wif"))[0].rows[1].kind === "monthly");
  // YAS: a BTP's terms from OpenFIGI's ticker, a price typed
  await cmd(page, "YAS IT0005518128"); await page.waitForTimeout(1200);
  await page.fill('.ys-f input[name="price"]', "102.5"); await page.fill('.ys-f input[name="settle"]', "2026-05-01"); await page.click('.ys-f button[type="submit"]'); await page.waitForTimeout(900); w = await winOf(page, "YAS");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/yas.png" });
  ok("[Q] YAS: coupon 4.4 % and maturity 1 May 2033 read from OpenFIGI's ticker, half-yearly; your price → yield gross and net, accrued 0 on a coupon date, durations, cash flows, shocks", w && /BTPS 4\.4 05\/01\/33/.test(w.text) && /YIELD TO MATURITY \(GROSS\)\s+3\.9\d\d%/.test(w.text) && /NET OF TAX \(12\.5%\)\s+3\.\d{3}%/.test(w.text) && /ACCRUED INTEREST\s+0\.0000/.test(w.text) && /DURATION \(MACAULAY · MODIFIED\)\s+6\.\d\d · 5\.\d\d/.test(w.text) && /CASH FLOWS ON THE NOMINAL/.test(w.text) && /\+100 bp/.test(w.text), w && w.text.slice(0, 1500));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/etf-section.png" });
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[Q] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined|Infinity/.test(txt) && errors.length === 0, errors.join(" | ") + (txt.match(/.{40}(NaN|undefined|Infinity).{40}/) || [""])[0]);
  await page.close();
  // a ticker typed before the lists have arrived: resolved when they do (a European ticker is never taken for a U.S. symbol)
  {
    const { page, errors } = await openTerminal(api);
    await page.waitForTimeout(600);
    await cmd(page, "EFP VWCE");
    await page.waitForFunction(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("ETF PROFILE")); return w && /Vanguard FTSE All-World/.test(w.querySelector(".win-body").innerText); }, null, { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(800); let w = await winOf(page, "ETF PROFILE");
    ok("[Q] EFP VWCE typed before the ETF lists load: the Xetra fund (IE00BK5BQT80), never a U.S. symbol", w && /Vanguard FTSE All-World/.test(w.text) && /IE00BK5BQT80/.test(w.text) && !/U\.S\. ETFs/.test(w.text), w && w.text.slice(0, 700));
    await page.fill(".efp-in", "SPY"); await page.press(".efp-in", "Enter"); await page.waitForTimeout(800); w = await winOf(page, "ETF PROFILE");
    ok("[Q] …SPY: the U.S. fund, no justETF data said", /SPDR S&P 500 ETF Trust/.test(w.text) && /no reference data for U\.S\. ETFs/.test(w.text), w.text.slice(0, 500));
    await page.fill(".efp-in", "ZZZQ"); await page.press(".efp-in", "Enter"); await page.waitForTimeout(600); w = await winOf(page, "ETF PROFILE");
    ok("[Q] …a ticker in neither list: said, with the ISIN asked for", /“ZZZQ” is not an ETF in the Xetra or U\.S\. lists/.test(w.text), w.text.slice(0, 400));
    ok("[Q] …no JavaScript errors", errors.length === 0, errors.join(" | "));
    await page.close();
  }
  for (const k of ["etf/universe", "etf/isins", "etf/us", "ref/je/table", "ref/je/" + HD[0], "ref/je/prio2", "ud/plab", "ud/wif"]) PV.kv.delete(k);
}

// =============== N. quant tools: Monte Carlo, VaR / ES, volatility, distribution, beta, optimiser, seasonality ===============
// history shaped like /api/history: five years of daily OHLC from a fixed process per symbol (SPY the market itself; NVDA β 1.5;
// MSFT β 0.8; a 40-day listing), ten years of monthly closes with every January +5 %
{
  const M32 = (a) => () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r0 = M32(11), g0 = () => { let u = 0; while (!u) u = r0(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r0()); };
  const wdays = []; { const d = new Date(); d.setUTCHours(0, 0, 0, 0); for (let i = 1; wdays.length < 1260; i++) { const x = new Date(d - i * 864e5), w = x.getUTCDay(); if (w && w < 6) wdays.push(x.toISOString().slice(0, 10)); } wdays.reverse(); }
  const mkt = wdays.map(() => 0.01 * g0()), beta = { SPY: 1, NVDA: 1.5, MSFT: 0.8 }, cache = {};
  const dailyOf = (sym) => cache[sym] || (cache[sym] = (() => { const b = beta[sym] ?? 1; let c = 100; return wdays.map((t, i) => { const o = c, rr = 0.0003 + b * mkt[i] + (sym === "SPY" ? 0 : 0.008 * g0()); c = +(c * Math.exp(rr)).toFixed(4); const hi = Math.max(o, c) * (1 + Math.abs(0.004 * g0())), lo = Math.min(o, c) * (1 - Math.abs(0.004 * g0())); return { t, o: +o.toFixed(4), h: +hi.toFixed(4), l: +lo.toFixed(4), c, v: 1e6 }; }); })());
  const monthly = (() => { const out = []; let c = 100; const d = new Date(); for (let k = 119; k >= 0; k--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 28)); c *= x.getUTCMonth() === 0 ? 1.05 : 1.004; out.push({ t: x.toISOString().slice(0, 10), o: c, h: c, l: c, c: +c.toFixed(4), v: 1 }); } return out; })();
  const qHist = (sym, range, interval) => { const pts = interval === "1month" ? monthly : sym === "NEWCO" ? dailyOf("SPY").slice(-40) : dailyOf(sym);
    return { body: { symbol: sym, range, interval: interval || "1day", adjust: "all", count: pts.length, points: pts, status: "LIVE", source: "twelvedata", fetchedAt: new Date().toISOString() } }; };
  const { page, errors } = await openTerminal({ ...OK_API, history: qHist });
  await page.waitForTimeout(1200); await cmd(page, "CLOSE"); await page.waitForTimeout(300);
  const qwin = () => page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("QUANT")); return w ? { title: w.querySelector(".w-title").textContent, text: w.querySelector(".win-body").innerText, svg: w.querySelectorAll(".q-svg").length, cv: w.querySelectorAll("canvas").length, pill: w.querySelector(".w-pv").innerText } : null; });
  const until = (re) => page.waitForFunction((src) => { const w = [...document.querySelectorAll(".win")].find((x) => x.querySelector(".w-title").textContent.startsWith("QUANT")); return w && new RegExp(src).test(w.querySelector(".win-body").innerText); }, re.source, { timeout: 75000 }).then(() => true, () => false);
  await cmd(page, "MC NVDA"); await until(/Probability of a gain/);
  let q = await qwin();
  const p95 = (q.text.match(/5th – 95th percentile\s+(\S+ … \S+)/) || [])[1];
  ok("[N] MC NVDA: Monte Carlo on 5 years of real-shaped closes — start at the last close, median, 5–95 % range, probability of a gain / of a 10 % loss, VaR / ES at the horizon (DERIVED)", q && /QUANT · MONTE CARLO · NVDA/.test(q.title) && /Start: last close\s+\d/.test(q.text) && /Median path\s+[+-]\d+\.\d%/.test(q.text) && !!p95 && /Probability of a gain\s+\d+\.\d%/.test(q.text) && /VaR 99 % · ES 99 %\s+-\d+\.\d% · -\d+\.\d%/.test(q.text) && q.svg === 1 && q.cv >= 1, q && q.text.slice(0, 900));
  ok("[N] MC: what it is, said once — paths from the past daily returns, block bootstrap, run number, not a forecast", /Monte Carlo · 5,000 paths of 252 trading days from the 1259 daily log returns of NVDA \(Twelve Data/.test(q.text) && /block bootstrap/.test(q.text) && /Run 1: the same inputs and run number give the same result/.test(q.text) && /not a forecast, not advice/.test(q.text), q.text.slice(q.text.indexOf("Monte Carlo ·"), q.text.indexOf("Monte Carlo ·") + 400));
  await page.fill('.q-f [name="run"]', "2"); await page.click(".q-f .set-reset"); await until(/Run 2:/); const p95b = ((await qwin()).text.match(/5th – 95th percentile\s+(\S+ … \S+)/) || [])[1];
  await page.fill('.q-f [name="run"]', "1"); await page.click(".q-f .set-reset"); await until(/Run 1:/); const p95c = ((await qwin()).text.match(/5th – 95th percentile\s+(\S+ … \S+)/) || [])[1];
  ok("[N] MC is reproducible: run 1 again gives the same range, run 2 another", p95 === p95c && p95b !== p95, [p95, p95b, p95c].join(" | "));
  await page.fill('.q-f [name="target"]', "1000000"); await page.click(".q-f .set-reset"); await until(/Probability of ending at or above/);
  ok("[N] MC: probability of ending above a target price (an unreachable one: 0.0 %)", /Probability of ending at or above 1,000,000\.00\s+0\.0%/.test((await qwin()).text));
  if (SHOTS) await shotWin(page, "QUANT", "quant-mc");
  // VaR
  await page.click('[data-qt="var"]'); await until(/BACKTEST/); await page.fill('.q-f [name="amount"]', "10000"); await page.click(".q-f .set-reset"); await until(/VaR · amount/);
  q = await qwin();
  ok("[N] VaR · ES: historical, normal, Cornish–Fisher, EWMA at 99 % with the amounts for a 10,000 position", /Historical\s+-\d+\.\d\d%\s+-\d+\.\d\d%\s+-\d+(\.\d+)?\s+-\d+/.test(q.text) && /Normal\s+-\d+\.\d\d%/.test(q.text) && /Cornish–Fisher\s+-\d+\.\d\d%/.test(q.text) && /EWMA \(λ 0\.94\)\s+-\d+\.\d\d%/.test(q.text), q.text.slice(0, 700));
  ok("[N] VaR backtest: exceptions vs expected, Kupiec LR and p, Basel zone, a chart", /EXCEPTIONS\s+\d+ \(expected 2\.5\)/.test(q.text) && /KUPIEC\s+LR \d+\.\d\d · p \d\.\d{3}/.test(q.text) && /BASEL\s+(GREEN|YELLOW|RED)/.test(q.text) && q.cv >= 1, q.text.slice(q.text.indexOf("BACKTEST"), q.text.indexOf("BACKTEST") + 300));
  // volatility
  await page.click('[data-qt="vol"]'); await until(/VOLATILITY CONE/); q = await qwin();
  ok("[N] VOL: realised volatility by five estimators over 21 / 63 / 252 days (OHLC available), EWMA, GARCH(1,1) fit with forecasts, cone", /Parkinson \(high–low\)\s+\d+\.\d%\s+\d+\.\d%\s+\d+\.\d%/.test(q.text) && /Yang–Zhang/.test(q.text) && /GARCH\(1,1\)\s+α \d\.\d{3} · β \d\.\d{3}/.test(q.text) && /GARCH FORECAST\s+1W \d+\.\d%/.test(q.text) && /252 days(\s+\d+\.\d%){6}/.test(q.text), q.text.slice(0, 900));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/quant-vol.png" });
  // distribution
  await page.click('[data-qt="dist"]'); await until(/JARQUE/); q = await qwin();
  ok("[N] DIST: histogram with the normal curve, skewness, excess kurtosis, Jarque–Bera, tails vs normal, autocorrelation with Ljung–Box", q.svg === 1 && /SKEWNESS\s+-?\d\.\d\d/.test(q.text) && /JARQUE–BERA\s+\d+\.\d · p/.test(q.text) && /BEYOND 2σ · 3σ/.test(q.text) && /squared returns(\s+-?\d\.\d\d){10}\s+\d+\.\d · p/.test(q.text), q.text.slice(0, 900));
  // beta: NVDA was built with β 1.5 on SPY
  await cmd(page, "BETA NVDA SPY"); await until(/INFORMATION RATIO/); q = await qwin();
  const b = +((q.text.match(/BETA\s+(\d\.\d\d) ±/) || [])[1]);
  ok("[N] BETA NVDA SPY: β ≈ 1.5 (how the history was built), α, R², tracking error, information ratio, capture; scatter and rolling β", Math.abs(b - 1.5) < 0.1 && /R²\s+0\.\d\d/.test(q.text) && /TRACKING ERROR\s+\d+\.\d%/.test(q.text) && /UP · DOWN CAPTURE\s+\d+% · \d+%/.test(q.text) && q.svg === 1 && q.cv >= 1 && /QUANT · BETA · REGRESSION · NVDA \/ SPY/.test(q.title), String(b) + " " + q.text.slice(0, 500));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/quant-beta.png" });
  // optimiser
  await cmd(page, "EF NVDA MSFT SPY"); await until(/Maximum Sharpe/); q = await qwin();
  const rowW = (name) => ((q.text.match(new RegExp(name + "\\s+((?:—|\\d+\\.\\d%)\\s+(?:—|\\d+\\.\\d%)\\s+(?:—|\\d+\\.\\d%))")) || [])[1] || "").split(/\s+/).map((x) => (x === "—" ? 0 : parseFloat(x)));
  const sums = ["Minimum variance", "Maximum Sharpe", "Risk parity", "Equal weights"].map((n) => rowW(n).reduce((a, x) => a + x, 0));
  ok("[N] EF NVDA MSFT SPY: frontier chart; minimum variance, maximum Sharpe, risk parity, equal weights — long only, weights adding up to 100 %", q.svg === 1 && sums.every((x) => Math.abs(x - 100) < 0.25) && /risk share in risk parity(\s+33\.3%){3}/.test(q.text) && /QUANT · OPTIMISER · NVDA MSFT SPY/.test(q.title), sums.join() + " " + q.text.slice(0, 600));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/quant-ef.png" });
  // seasonality: every January +5 %
  await page.click('[data-qt="seas"]'); await until(/BY CALENDAR MONTH/); q = await qwin();
  ok("[N] SEAS: months × years from monthly closes (every January 5.0), averages, % positive; weekdays from daily closes", /average\s+5\.0\s+0\.4/.test(q.text) && /% positive\s+100/.test(q.text) && /DAY OF THE WEEK/.test(q.text) && /average return(\s+[+-]\d\.\d{3}%){5}/.test(q.text), q.text.slice(q.text.indexOf("BY CALENDAR"), q.text.indexOf("BY CALENDAR") + 300));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/quant-seas.png" });
  // too little history: N/A, nothing made up
  await cmd(page, "VAR NEWCO"); await until(/not enough history/); q = await qwin();
  ok("[N] a 40-day listing: VaR is N/A (not enough history), nothing estimated", /N\/A — not enough history for this tool \(40 days\)/.test(q.text) && !/Historical\s+-/.test(q.text));
  ok("[N] the window's data pill: real history + DERIVED results", /LIVE|DRV/.test(q.pill));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[N] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined|Infinity/.test(txt) && errors.length === 0, errors.join(" | ") + (txt.match(/.{40}(NaN|undefined|Infinity).{40}/) || [""])[0]);
  await page.close();
}

// =============== R. the public replay: recorded by the owner's terminal (official sources only), played on /terminal/ ===============
{
  const kv = new Map();
  const RENV = { ALLOWED_ORIGIN: ORIGIN, BRIEFS: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } },
    ASSETS: { fetch: async () => new Response(htmlFast, { headers: { "content-type": "text/html" } }) } };
  const t7r = { calls: [], alerts: [], notes: [], boards: [], hits: [], noEia: false, noFred: false };
  // the Worker's router as the recording re-reads it: the official routes answer the same fixtures as the scenarios above
  const routerFix = async (req) => { const u = new URL(req.url);
    const r = u.pathname === "/api/yields" && u.searchParams.get("ids") ? yieldsIds(u) : u.pathname === "/api/yields/history" ? yieldsHistory(u) : u.pathname === "/api/yields" ? { body: YIELDS } : u.pathname === "/api/calendar" ? { body: CALENDAR } : t07Api(u, "GET", null, t7r);
    return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { "content-type": "application/json" } }); };
  const jsonR = (b, H, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { ...H, "content-type": "application/json" } });
  const fulfill = async (route, res) => route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  const playerJs = readFileSync(new URL("../public/terminal/replay/player.js", import.meta.url), "utf8");
  const landing = readFileSync(new URL("../public/terminal/index.html", import.meta.url), "utf8");
  const pre = async (route, u) => {
    if (u.origin !== ORIGIN) return false;
    if (u.pathname === "/terminal/replay/player.js") { await route.fulfill({ contentType: "application/javascript", body: playerJs }); return true; }
    if (u.pathname.startsWith("/terminal/replay")) { await fulfill(route, await handleReplayPublic(u, RENV, new Request(u.href))); return true; }
    if (u.pathname === "/terminal/") { await route.fulfill({ contentType: "text/html", body: landing }); return true; }
    if (u.pathname.startsWith("/api/user/recording")) { const rq = route.request(); await fulfill(route, await handleRecording(u, RENV, {}, {}, jsonR, new Request(u.href, { method: rq.method(), headers: rq.headers(), body: rq.method() === "POST" ? rq.postData() : undefined }), routerFix)); return true; }
    return false;
  };
  const statics = async (route, u) => {
    const js = { "/terminal/provenance.js": provJs, "/terminal/i18n.js": i18nJs, "/terminal/vendor/lightweight-charts.js": lwcJs, "/terminal/qmath.js": quantJs }[u.pathname];
    if (u.origin === ORIGIN && js) { await route.fulfill({ contentType: "application/javascript", body: js }); return true; }
    if (u.origin === ORIGIN && u.pathname.startsWith("/terminal/app/") && existsSync("public" + u.pathname)) { await route.fulfill({ contentType: "image/png", body: readFileSync("public" + u.pathname) }); return true; }
    if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) { await route.fulfill({ body: "" }); return true; }
    return false;
  };
  // 1. the owner's terminal records (SYS → RECORD NOW: a hidden copy of the replay runs the script against /api)
  const { page, errors } = await openTerminal({ ...OK_API, pre });
  await page.waitForTimeout(1200);
  await cmd(page, "SYS");
  await page.waitForFunction(() => /PUBLIC REPLAY/.test(document.body.innerText) && /no recording yet/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => null);
  let sys = await winOf(page, "SYS");
  ok("[R] SYS: PUBLIC REPLAY — no recording yet, RECORD NOW", sys && /PUBLIC REPLAY · \/terminal\//.test(sys.text) && /no recording yet/.test(sys.text) && /RECORD NOW/.test(sys.text), sys && sys.text.slice(-900));
  await page.click(".sys-rec");
  const frames0 = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src") + "|" + getComputedStyle(f).visibility).join());
  await page.waitForFunction(() => /recorded: \d+ answers/.test(document.body.innerText), null, { timeout: 120000 }).catch(() => null);
  sys = await winOf(page, "SYS");
  const meta = JSON.parse(kv.get("rec/meta") || "null"), recText = kv.get("rec/current") || "{}", rec = JSON.parse(recText), keys = Object.keys(rec.r || {});
  ok("[R] recorded in a hidden copy of the replay (?rec=1), removed afterwards; SYS shows when and how much", frames0 === "/terminal/replay/?rec=1|hidden" && (await page.$$("iframe")).length === 0 && /recording of\s+\d/.test(sys.text) && /recorded: \d+ answers/.test(sys.text), frames0 + " · " + JSON.stringify(sys && sys.text.slice(sys.text.indexOf("PUBLIC REPLAY"), sys.text.indexOf("PUBLIC REPLAY") + 400)));
  ok("[R] the recording holds the official routes the script asked for, nothing else", meta && meta.n === keys.length && keys.length >= 7 && keys.every((k) => recordable(k) === k) && ["/api/cb/world", "/api/yields", "/api/bonds", "/api/sprd", "/api/cot", "/api/calendar"].every((p) => keys.some((k) => k.split("?")[0] === p)), keys.join(" "));
  ok("[R] nothing commercial recorded: no Forex Factory event, no ICE BofA index, no quote, no market yield", !/Forex Factory|"source":"FF"|BAML|ICE BofA|\/api\/quote|\/api\/yields\/market|Twelve Data/.test(recText) && rec.r["/api/calendar"].b.world.length === 0 && rec.r["/api/calendar"].b.events.every((e) => ["BLS", "BEA"].includes(e.source)), (recText.match(/.{60}(Forex Factory|"source":"FF"|BAML|ICE BofA|Twelve Data).{60}/) || [""])[0]);
  ok("[R] the owner's terminal: no JavaScript error while recording", errors.length === 0, errors.join(" | "));
  await page.close();

  // 2. a visitor on a computer: /terminal/ plays the terminal by itself on the recording
  const p2 = await browser.newPage({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  const net = [], errs2 = [];
  p2.on("request", (r) => net.push(r.url()));
  p2.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errs2.push(m.text()); });
  p2.on("pageerror", (e) => errs2.push(String(e)));
  await p2.route("**/*", async (route) => { const u = new URL(route.request().url()); if (await pre(route, u)) return; if (await statics(route, u)) return; return route.abort(); });
  await p2.goto(ORIGIN + "/terminal/");
  const top = await p2.evaluate(() => ({ h1: document.querySelector("h1").textContent, login: document.querySelector(".login").getAttribute("href"), robots: document.querySelector('meta[name="robots"]').content, ctl: document.querySelectorAll(".ctl button").length, hero: getComputedStyle(document.querySelector(".hero")).display }));
  ok("[R] /terminal/ on a computer: brand bar with ❚❚ / ↺ and the sign-in to /terminal/desk/, not indexed, the terminal filling the window", /market terminal in the browser/.test(top.h1) && top.login === "/terminal/desk/" && top.robots === "noindex,nofollow" && top.ctl === 2 && top.hero === "none", JSON.stringify(top));
  await p2.waitForFunction(() => document.querySelector("#loader").classList.contains("off"), null, { timeout: 20000 }).catch(() => null);
  const fr = p2.frames().find((f) => /\/terminal\/replay\/(\?|$)/.test(f.url()));
  const bar = fr ? await fr.evaluate(() => document.querySelector("#rpbar") && document.querySelector("#rpbar").innerText) : "";
  ok("[R] the replay says what it is: a RECORDING of its date and time, official sources only, not real time", /RECORDING\s+of \d{1,2} \w{3} \d{4}, \d{2}:\d{2} Rome time · official sources only · not real time/.test(bar), bar);
  const clock = fr ? await fr.evaluate(() => Date.now()) : 0;
  ok("[R] the page's clock is the recording's (and runs on from there)", Math.abs(clock - Date.parse(meta.t0)) < 5 * 60000, new Date(clock).toISOString() + " vs " + meta.t0);
  const wt = async (prefix) => (await fr.evaluate((p) => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith(p)); return w ? w.querySelector(".win-body").innerText : ""; }, prefix));
  await fr.waitForFunction(() => [...document.querySelectorAll(".win")].some((w) => /Federal Reserve/.test(w.innerText)), null, { timeout: 30000 }).catch(() => null);
  const cbT = await wt("CENTRAL BANKS");
  await fr.waitForFunction(() => window.AZ_REPLAY && window.AZ_REPLAY.state.i >= 2, null, { timeout: 30000 }).catch(() => null);
  const cbH = await fr.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-tag").textContent === "CB"); return w ? { hist: w.querySelector('[data-cbv="HIST"]').getAttribute("aria-pressed"), canv: w.querySelectorAll("canvas").length, n: document.querySelectorAll(".win").length, full: Math.round(w.getBoundingClientRect().width) } : null; });
  ok("[R] CB opened alone, the whole desk; then its HISTORY (BIS, since 2006) as a chart", cbH && cbH.hist === "true" && cbH.canv >= 1 && cbH.n === 1 && cbH.full > 1200, JSON.stringify(cbH));
  await fr.waitForFunction(() => window.AZ_REPLAY && window.AZ_REPLAY.state.done, null, { timeout: 120000, polling: 500 }).catch(() => null);
  const tags = await fr.$$eval(".win .w-tag", (t) => t.map((x) => x.textContent).sort().join());
  const grid = await fr.evaluate(() => { const r = [...document.querySelectorAll(".win")].map((w) => w.getBoundingClientRect()); const ov = r.some((a, i) => r.some((b, j) => j > i && a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2)); return { n: r.length, overlap: ov, cols: new Set(r.map((x) => Math.round(x.left))).size, rows: new Set(r.map((x) => Math.round(x.top))).size }; });
  ok("[R] the script typed CB, CURVE, BOND, SPRD (official 2s10s), COT, CAL; the desk tiled as they opened, four at most — never one on top of another", tags === "BOND,CAL,COT,SPRD" && grid.n === 4 && !grid.overlap && grid.cols === 2 && grid.rows === 2, tags + " " + JSON.stringify(grid));
  const sprdT = await wt("SPREADS"), calT = await wt("ECONOMIC CALENDAR"), cotT = await wt("FUTURES POSITIONING"), bondT = await wt("WORLD GOVERNMENT BONDS");
  ok("[R] windows show the recorded official data: BIS policy rates, CFTC positioning, the official 2s10s, BLS releases", /Federal Reserve/.test(cbT) && /3\.875|3\.88/.test(cbT) && /E-mini S&P 500/.test(cotT) && /2s10s|10Y minus 2Y|EURO AREA|Euro area/i.test(sprdT) && /Consumer Price Index/.test(calT) && !/German Ifo|Forex Factory/.test(calT), JSON.stringify([cbT.slice(0, 300), cotT.slice(0, 200), sprdT.slice(0, 300), calT.slice(0, 600)]));
  ok("[R] BOND without the ICE BofA index (not public), with the breakeven from FRED", /10-year breakeven inflation/.test(bondT) && !/ICE BofA/.test(bondT), bondT.slice(-500));
  const cap = fr ? await fr.evaluate(() => document.querySelector("#rpbar .rp-cap").textContent) : "";
  ok("[R] at the end: what the private terminal also has (portfolio, lab, what-if, quant, alerts — named, not shown); ↺ plays it again", /End of the recording/.test(cap) && /portfolio lab/.test(cap) && /not shown here/.test(cap), cap);
  // a function outside the recording: N/A, said why — never a value from elsewhere
  await fr.fill("#cmd", "NVDA"); await fr.press("#cmd", "Enter"); await p2.waitForTimeout(1500);
  const gpT = await fr.evaluate(() => document.body.innerText);
  ok("[R] a function that is not in the recording: N/A — not in this public recording (official sources only), the quote too (never \"could not reach /api\")", /not in this public recording/.test(gpT) && !/could not reach \/api/.test(gpT), gpT.slice(0, 600));
  ok("[R] no /api request leaves the replay (every answer comes from the recording)", !net.some((u) => /\/api\//.test(u)), net.filter((u) => /\/api\//.test(u)).join());
  ok("[R] the replay keeps its settings in memory: this site's storage untouched", (await p2.evaluate(() => localStorage.length)) === 0);
  await p2.click("#pp"); await p2.waitForTimeout(300);
  const paused = await fr.evaluate(() => window.AZ_REPLAY.state.paused), ppTxt = await p2.textContent("#pp");
  await p2.click("#pp"); await p2.waitForTimeout(300);
  // EN / IT on /terminal/: the page's words and the replay's interface switch together, remembered on this page only
  await p2.click('.lang [data-lang="it"]'); await p2.waitForTimeout(800);
  const itNow = { h1: await p2.textContent("h1"), login: await p2.textContent(".top .login"), app: await fr.evaluate(() => window.I18N.lang()), bar: await fr.evaluate(() => document.querySelector("#rpbar").innerText), key: await p2.evaluate(() => localStorage.getItem("az-public-lang")), src: await p2.evaluate(() => document.querySelector("#rp").getAttribute("src")) };
  await p2.click('.lang [data-lang="en"]'); await p2.waitForTimeout(800);
  const enNow = { h1: await p2.textContent("h1"), app: await fr.evaluate(() => window.I18N.lang()), bar: await fr.evaluate(() => document.querySelector("#rpbar").innerText) };
  ok("[R] EN / IT at the top of /terminal/: the presentation and the replay (windows, banner, caption) switch language", /mercato nel browser/.test(itNow.h1) && /Accedi/.test(itNow.login) && itNow.app === "it" && /REGISTRAZIONE/.test(itNow.bar) && itNow.key === "it" && /market terminal in the browser/.test(enNow.h1) && enNow.app === "en" && /RECORDING/.test(enNow.bar) && /lang=en/.test(itNow.src), JSON.stringify({ itNow, enNow }));
  await p2.evaluate(() => localStorage.removeItem("az-public-lang"));
  ok("[R] ❚❚ pauses the replay and becomes ▶; again resumes", paused === true && ppTxt === "▶" && (await fr.evaluate(() => window.AZ_REPLAY.state.paused)) === false && (await p2.textContent("#pp")) === "❚❚");
  const allTxt = (await p2.evaluate(() => document.body.innerText)) + (await fr.evaluate(() => document.body.innerText));
  ok("[R] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(allTxt) && !/\bNaN\b|undefined/.test(allTxt) && errs2.length === 0, errs2.join(" | ") + (allTxt.match(/.{40}(NaN|undefined).{40}/) || [""])[0]);
  if (SHOTS) await p2.screenshot({ path: SHOTS + "/replay-desktop.png" });
  await p2.close();

  // 3. a visitor on a phone: words first, then the terminal in its phone layout
  const ctx3 = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "it-IT",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1" });
  const p3 = await ctx3.newPage();
  await p3.route("**/*", async (route) => { const u = new URL(route.request().url()); if (await pre(route, u)) return; if (await statics(route, u)) return; return route.abort(); });
  await p3.goto(ORIGIN + "/terminal/");
  await p3.waitForTimeout(6000);
  const f3 = p3.frames().find((f) => /\/terminal\/replay\/(\?|$)/.test(f.url()));
  const ph = await p3.evaluate(() => ({ h2: document.querySelector(".hero h2").textContent, hero: getComputedStyle(document.querySelector(".hero")).display, ifr: document.querySelector("#rp").getBoundingClientRect().height, lang: document.documentElement.lang }));
  const inner = f3 ? await f3.evaluate(() => ({ phone: document.body.classList.contains("phone"), wins: document.querySelectorAll(".win").length, bar: document.querySelector("#rpbar") && document.querySelector("#rpbar").innerText })) : {};
  ok("[R] /terminal/ on a phone (Italian): the words first, then the terminal in its phone layout playing the recording", ph.hero === "block" && /Un terminale di mercato nel browser/.test(ph.h2) && ph.lang === "it" && ph.ifr > 400 && inner.phone && inner.wins >= 1 && /REGISTRAZIONE\s+del .* solo fonti ufficiali · non in tempo reale/.test(inner.bar || ""), JSON.stringify({ ph, inner }));
  if (SHOTS) await p3.screenshot({ path: SHOTS + "/replay-phone.png" });
  await ctx3.close();

  // 4. before the first recording: the page says so and plays nothing
  kv.clear();
  const p4 = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  await p4.route("**/*", async (route) => { const u = new URL(route.request().url()); if (await pre(route, u)) return; if (await statics(route, u)) return; return route.abort(); });
  await p4.goto(ORIGIN + "/terminal/replay/");
  await p4.waitForTimeout(3500);
  const empty = await p4.evaluate(() => ({ bar: document.querySelector("#rpbar") && document.querySelector("#rpbar").innerText, wins: document.querySelectorAll(".win").length }));
  ok("[R] no recording yet: NO RECORDING YET, no window opened, nothing invented", /NO RECORDING YET/.test(empty.bar || "") && empty.wins === 0, JSON.stringify(empty));
  await p4.close();
}

// =============== S. as on Nico's terminal: YEAR, privacy mode, keyboard, edges, "close what it opened", notes per security ===============
{
  const tx = [{ id: "s1", date: BDJ[5], side: "BUY", sym: "AAPL", qty: 12, price: 100, ccy: "USD", fees: 0, created: 1 }];
  const { page, errors } = await openTerminal({ ...OK_API, history: histJ, portfolio: pfJ(tx, []), indices: idxJ });
  await page.waitForTimeout(1200);
  const blur = () => page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  const wcount = () => page.$$eval(".win", (w) => w.length);
  const front = () => page.evaluate(() => document.querySelector(".tb-win.active")?.textContent || "");
  // YEAR
  await cmd(page, "CLOSE"); await cmd(page, "YEAR"); await page.waitForTimeout(400);
  const yr = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((x) => x.dataset.type === "YEAR"), b = w.querySelector(".win-body");
    const now = new Date(), y = now.getFullYear(), a = new Date(y, 0, 1), e = new Date(y + 1, 0, 1), n = Math.round((e - a) / 864e5);
    return { title: w.querySelector(".w-title").textContent, rows: [...b.querySelectorAll(".yr-row")].map((r) => r.dataset.yr + " " + r.querySelector(".yr-pct").textContent), left: b.querySelector('[data-yr="D"] .yr-left').textContent,
      dots: b.querySelectorAll(".yr-dots i:not(.yr-x)").length, today: b.querySelectorAll(".yr-dots i.yr-t").length, n, yPct: ((now - a) / (e - a) * 100), text: b.innerText }; });
  await page.waitForTimeout(1300);
  const left2 = await page.evaluate(() => document.querySelector('.win[data-type="YEAR"] [data-yr="D"] .yr-left').textContent);
  ok("[S] YEAR: year, quarter, month, week and day gone (device clock), a countdown that runs, a dot per day of the year", yr.title === "YEAR PROGRESS" && yr.rows.length === 5 && /^Y \d+\.\d{2}%$/.test(yr.rows[0]) && Math.abs(parseFloat(yr.rows[0].slice(2)) - yr.yPct) < 0.05 && yr.dots === yr.n && yr.today === 1 && /^left \d{2}:\d{2}:\d{2}$/.test(yr.left) && left2 !== yr.left && /A DOT PER DAY/.test(yr.text), JSON.stringify(yr).slice(0, 400));
  // typing anywhere starts a command; Ctrl+K; F1 / F2; Esc closes the window in front; Alt+Z reopens it
  await blur(); await page.keyboard.type("WL"); await page.waitForTimeout(100);
  const typed = await page.evaluate(() => [document.activeElement?.id, document.querySelector("#cmd").value]);
  await page.keyboard.press("Enter"); await page.waitForTimeout(700);
  ok("[S] typing with nothing focused goes to the command line (WL ⏎ opens the watchlist)", typed[0] === "cmd" && typed[1] === "WL" && /WL/.test(await front()), JSON.stringify(typed));
  await blur(); await page.keyboard.press("Control+k");
  ok("[S] Ctrl+K: the command line", (await page.evaluate(() => document.activeElement?.id)) === "cmd");
  await blur(); await page.keyboard.press("F2"); await page.waitForTimeout(200);
  const menuOn = await page.evaluate(() => !!document.querySelector("#fnmenu.on")); const n0 = await wcount();
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  await blur(); await page.keyboard.press("F1"); await page.waitForTimeout(200);
  const help = await page.evaluate(() => document.querySelector("#help.on")?.innerText || "");
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  ok("[S] F2 the functions, F1 help (with the shortcuts); Esc closes them, not a window", menuOn && /KEYBOARD/.test(help) && /Alt\+Shift\+W/.test(help) && /YEAR/.test(help) && (await wcount()) === n0 && !(await page.$("#help.on")) && !(await page.$("#fnmenu.on")));
  await blur(); await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const afterEsc = await page.$$eval(".win", (w) => w.map((x) => x.dataset.type).join());
  await page.keyboard.press("Alt+z"); await page.waitForTimeout(500);
  ok("[S] Esc closes the window in front (the watchlist); Alt+Z reopens it", afterEsc === "YEAR" && (await page.$$eval(".win", (w) => w.map((x) => x.dataset.type).sort().join())) === "WL,YEAR", afterEsc);
  // Tab / Shift+Tab, Alt+M / Alt+N / Alt+T, Alt+Shift+W
  await cmd(page, "CB"); await page.waitForTimeout(600); await blur();
  const f0 = await front(); await page.keyboard.press("Tab"); const f1 = await front(); await page.keyboard.press("Shift+Tab"); const f2 = await front();
  ok("[S] Tab / Shift+Tab: next / previous window", f0 !== f1 && f2 === f0, [f0, f1, f2].join(" | "));
  await page.keyboard.press("Alt+m"); await page.waitForTimeout(200); const mx = await page.$$eval(".win.ismax", (w) => w.length);
  await page.keyboard.press("Alt+m"); await page.keyboard.press("Alt+n"); await page.waitForTimeout(200); const mn = await page.$$eval(".win.ismin", (w) => w.length);
  await page.keyboard.press("Alt+t"); await page.waitForTimeout(300);
  ok("[S] Alt+M maximises and restores, Alt+N minimises, Alt+T tiles", mx === 1 && mn === 1 && (await page.$$eval(".win.ismax", (w) => w.length)) === 0);
  await page.keyboard.press("Alt+Shift+w"); await page.waitForTimeout(300); const closedAll = await wcount();
  await page.keyboard.press("Alt+z"); await page.waitForTimeout(700);
  ok("[S] Alt+Shift+W closes them all; Alt+Z brings them all back", closedAll === 0 && (await wcount()) === 3);
  // resize from the edges; Alt while dropping: no snapping
  await cmd(page, "CLOSE"); await cmd(page, "MKT"); await page.waitForTimeout(800);
  const box = () => page.evaluate(() => { const w = document.querySelector('.win[data-type="MKT"]'), d = document.querySelector("#desk").getBoundingClientRect(), r = w.getBoundingClientRect(); return { x: Math.round(r.left - d.left), y: Math.round(r.top - d.top), w: Math.round(r.width), h: Math.round(r.height) }; });
  const grab = async (sel, dx, dy) => { const r = await page.$eval(`.win[data-type="MKT"] ${sel}`, (e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.move(r.x, r.y); await page.mouse.down(); await page.mouse.move(r.x + dx, r.y + dy, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(250); };
  const b0 = await box(); await grab(".w-edge.e", 90, 0); const b1 = await box(); await grab(".w-edge.w", -20, 0); const b2 = await box(); await grab(".w-edge.s", 0, 60); const b3 = await box();
  ok("[S] a window resizes from its right, left and bottom edges", b1.w === b0.w + 90 && b1.x === b0.x && b2.x === b1.x - 20 && b2.w === b1.w + 20 && b3.h === b2.h + 60 && b3.w === b2.w, JSON.stringify([b0, b1, b2, b3]));
  const hd = await page.$eval('.win[data-type="MKT"] .w-title', (e) => { const b = e.getBoundingClientRect(); return { x: b.left + 10, y: b.top + b.height / 2 }; });
  const dk = await page.$eval("#desk", (d) => { const r = d.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await page.keyboard.down("Alt"); await page.mouse.move(hd.x, hd.y); await page.mouse.down(); await page.mouse.move(dk.x + 3, dk.y + 3 + 40, { steps: 6 }); await page.mouse.move(dk.x + 3, dk.y + 3, { steps: 3 }); await page.mouse.up(); await page.keyboard.up("Alt"); await page.waitForTimeout(300);
  const b4 = await box();
  ok("[S] holding Alt while dropping in a corner: the window stays where it is (no quarter, size kept)", b4.w === b3.w && b4.h === b3.h && !(await page.$('.win[data-type="MKT"].ismax')), JSON.stringify([b3, b4]));
  // "✕n": a window opened from another one is closed from it, and comes back with UNDO
  await cmd(page, "CLOSE"); await cmd(page, "WL"); await page.waitForTimeout(800);
  await page.click('.win[data-type="WL"] .wl-row[data-sym="AAPL"]'); await page.waitForTimeout(700);
  const kids = await page.evaluate(() => { const b = document.querySelector('.win[data-type="WL"] .w-kids'); return { hidden: b.hidden, t: b.textContent, n: document.querySelectorAll(".win").length }; });
  await page.click('.win[data-type="WL"] .w-kids'); await page.waitForTimeout(300);
  const afterKids = await page.$$eval(".win", (w) => w.map((x) => x.dataset.type).join());
  await cmd(page, "UNDO"); await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({ types: [...document.querySelectorAll(".win")].map((x) => x.dataset.type).sort().join(), t: document.querySelector('.win[data-type="WL"] .w-kids').textContent, h: document.querySelector('.win[data-type="WL"] .w-kids').hidden }));
  await cmd(page, "MSFT"); await page.waitForTimeout(600);
  const own = await page.evaluate(() => document.querySelector('.win[data-type="WL"] .w-kids').textContent);
  ok("[S] ✕1 in the watchlist's title closes the chart opened from it; UNDO reopens it (still its child); a command opens a window of its own", !kids.hidden && kids.t === "✕1" && kids.n === 2 && afterKids === "WL" && back.types === "GP,WL" && back.t === "✕1" && !back.h && own === "✕1", JSON.stringify([kids, afterKids, back, own]));
  // AAPL NOTE
  await cmd(page, "AAPL NOTE"); await page.waitForTimeout(700);
  const nt = await page.evaluate(() => { const w = document.querySelector('.win[data-type="NOTE"]'); return w ? { t: w.querySelector(".w-title").textContent, sym: w.querySelector('[data-k="nsym"]')?.value, f: w.querySelector('[data-k="nfilter"]')?.value } : null; });
  await cmd(page, "NOTE"); await page.waitForTimeout(400);
  const nt2 = await page.evaluate(() => document.querySelector('.win[data-type="NOTE"] .w-title').textContent);
  ok("[S] AAPL NOTE: the notes on AAPL, its symbol filled in; NOTE alone: every note", nt && nt.t === "NOTES · AAPL" && nt.sym === "AAPL" && nt.f === "AAPL" && nt2 === "NOTES", JSON.stringify([nt, nt2]));
  // HIDE: amounts and quantities masked in the portfolio, percentages kept; Alt+P / the eye; remembered
  await cmd(page, "CLOSE"); await cmd(page, "PF"); await page.waitForTimeout(1500);
  const pfTxt = () => page.evaluate(() => document.querySelector('.win[data-type="PF"] .win-body').innerText);
  const shown = await pfTxt();
  await blur(); await page.keyboard.press("Alt+p"); await page.waitForTimeout(500);
  const hidden = await pfTxt();
  const eye = await page.evaluate(() => ({ p: document.querySelector("#hideBtn").getAttribute("aria-pressed"), ls: localStorage.getItem("at-hide"), blur: document.body.classList.contains("hide-amt") }));
  const qtyCell = await page.evaluate(() => { const t = document.querySelector('.win[data-type="PF"] table.pf'); const i = [...t.tHead.rows[0].cells].findIndex((c) => c.textContent.trim() === "QTY"); return t.tBodies[0].rows[0].cells[i].textContent; });
  if (SHOTS) await page.screenshot({ path: SHOTS + "/hide.png" });
  await page.click("#hideBtn"); await page.waitForTimeout(500);
  const again = await pfTxt();
  ok("[S] HIDE (Alt+P): every amount and quantity in the portfolio masked, percentages kept; the eye shows it, remembered; again shows them", /€\d/.test(shown) && /\b12\b/.test(shown) && !/[€$]\s?\d/.test(hidden) && /•••••/.test(hidden) && qtyCell === "•••••" && /\d+\.\d+%/.test(hidden) && eye.p === "true" && eye.ls === "1" && eye.blur && /€\d/.test(again) && (await page.evaluate(() => localStorage.getItem("at-hide"))) === "0", JSON.stringify({ hidden: hidden.slice(0, 500), qtyCell, eye }));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[S] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== T. a company and an ETF, as on Nico's terminal: FA (SEC filings), CN, ERN of one company (Finnhub), HOLD ===============
{
  // the ETF lists and one fund's justETF record as the Worker keeps them in KV (test inputs in their formats)
  PV.kv.set("etf/universe", JSON.stringify({ asOf: "2026-10-21", fetchedAt: Date.now() - 3600_000, source: "Deutsche Börse — T7 (Xetra) All tradable instruments", sourceUrl: "https://www.cashmarket.deutsche-boerse.com/", rows: [["IE00BK5BQT80", "VANGUARD FTSE ALL-WLD U.ETF", "ETF", "Passive ETF", "A2PKXG", "VWCE:EUR"]] }));
  PV.kv.set("etf/us", JSON.stringify({ fetchedAt: Date.now() - 3600_000, source: "Twelve Data — ETF list (reference data)", rows: [["SPY", "SPDR S&P 500 ETF Trust", "ARCX"]] }));
  PV.kv.set("ref/je/IE00BK5BQT80", JSON.stringify({ ter: 0.19, fundSize: { value: 55100e6, currency: "EUR" }, distribution: "Accumulating", replication: "Physical (Sampling)", domicile: "Ireland", fundCurrency: "USD", hedged: false, inception: "23 July 2019", holdings: 3759,
    name: "Vanguard FTSE All-World UCITS ETF (USD) Accumulating", provider: "Vanguard", focus: "Equity, World", index: "FTSE All-World", top10: [["NVIDIA Corp.", 4.9, "US67066G1040"], ["Apple", 4.4, "US0378331005"]], top10Weight: 22.1, holdingsTotal: 3759,
    countries: [["United States", 62.5], ["Japan", 5.9], ["Other", 31.6]], sectors: [["Technology", 27.4], ["Other", 72.6]], v: 3, fetchedAt: Date.now() - 86400_000 }));
  const { page, errors } = await openTerminal(OK_API);
  await page.waitForTimeout(1200);
  await cmd(page, "CLOSE"); await cmd(page, "AAPL FA"); await page.waitForTimeout(2500);
  const fa = () => page.evaluate(() => { const w = document.querySelector('.win[data-type="FA"]'); if (!w) return null; const t = w.querySelector("table.fa-t"); return { title: w.querySelector(".w-title").textContent, pill: w.querySelector(".w-pv").textContent,
    head: t ? [...t.tHead.rows[0].cells].map((c) => c.textContent.trim()) : [], rows: t ? [...t.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent.trim())) : [], text: w.querySelector(".win-body").innerText }; });
  let f = await fa();
  if (SHOTS) await page.screenshot({ path: SHOTS + "/fa.png" });
  const row = (x, re) => x.rows.find((r) => re.test(r[0])) || [];
  ok("[T] AAPL FA: income statement from SEC filings — five fiscal years, TTM (DERIVED), YoY; margins DERIVED from the lines", f && f.title === "FINANCIALS · AAPL" && /^FY2021/.test(f.head[1]) && /^FY2025/.test(f.head[5]) && /^TTM/.test(f.head[6])
    && row(f, /^Revenue$/).slice(1).join() === "$300.00B,$320.00B,$340.00B,$360.00B,$400.00B,$420.00B,+11.11%" && row(f, /^Gross margin/).slice(1, 6).join() === "40.0%,40.6%,41.2%,41.7%,42.5%" && row(f, /^Operating margin/)[5] === "31.3%"
    && /^Research and development\s*N\/A — not in the company's filings/.test(row(f, /^Research/).join(" ")) && /SEC EDGAR XBRL/.test(f.text), JSON.stringify(f).slice(0, 900));
  await page.click('.win[data-type="FA"] [data-fast="bs"]'); await page.waitForTimeout(2000); f = await fa();
  ok("[T] FA balance sheet: year-end figures, current ratio DERIVED; a line not reported N/A", row(f, /^Current assets/).slice(1, 6).join() === "$130.00B,$135.00B,$140.00B,$145.00B,$150.00B" && row(f, /^Current ratio/)[1] === "1.08×" && /N\/A/.test(row(f, /^Total assets/).join(" ")), JSON.stringify(f.rows).slice(0, 600));
  await page.click('.win[data-type="FA"] [data-fast="cf"]'); await page.waitForTimeout(2000); f = await fa();
  ok("[T] FA cash flow: free cash flow and its margin DERIVED (operating cash flow − capex)", row(f, /^Free cash flow/)[5] === "$107.00B" && row(f, /^FCF margin/)[5] === "26.8%", JSON.stringify(f.rows).slice(0, 600));
  await cmd(page, "AAPL CN"); await page.waitForTimeout(1200);
  const cn = await page.evaluate(() => { const w = document.querySelector('.win[data-type="CN"]'); return { title: w.querySelector(".w-title").textContent, items: [...w.querySelectorAll(".cn-i")].map((a) => [a.querySelector(".cn-t").textContent, a.querySelector(".cn-s").textContent, a.querySelector(".cn-h").textContent, a.getAttribute("href"), a.target]), text: w.querySelector(".win-body").innerText }; });
  ok("[T] AAPL CN: company news, newest first, linking to the publisher (no summary copied)", cn.title === "COMPANY NEWS · AAPL" && cn.items.length === 2 && cn.items[0][0] === "30 min ago" && cn.items[0][1] === "Reuters" && cn.items[0][3] === "https://example.com/n1" && cn.items[0][4] === "_blank" && !/publisher text/.test(cn.text) && /Finnhub company news, last 7 days/.test(cn.text), JSON.stringify(cn).slice(0, 500));
  await cmd(page, "AAPL ERN"); await page.waitForTimeout(1200);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/ern-cn.png" });
  const er = await page.evaluate(() => { const w = document.querySelector('.win[data-type="ERNS"]'); return { tag: w.querySelector(".w-tag").textContent, title: w.querySelector(".w-title").textContent, next: w.querySelector(".ern-next")?.innerText || "", rows: [...w.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent.trim())) }; });
  ok("[T] AAPL ERN: the next report (in 14 days, estimates) and the last quarters with surprise; ERN alone stays the calendar", er.tag === "ERN" && er.title === "EARNINGS · AAPL" && /in 14 days/.test(er.next) && /\$1\.80/.test(er.next) && /\$101\.00B/.test(er.next)
    && er.rows.length === 2 && er.rows[0][0] === "Q3 2026" && er.rows[0][4] === "$1.65" && er.rows[0][6] === "+3.13%" && er.rows[0][9] === "$94.00B" && er.rows[1][6] === "-1.82%", JSON.stringify(er).slice(0, 600));
  await cmd(page, "IVV HOLD"); await page.waitForTimeout(1500);
  const hv = await page.evaluate(() => { const w = document.querySelector('.win[data-type="HOLD"]'); return { title: w.querySelector(".w-title").textContent, n: w.querySelectorAll("tbody tr[data-sym]").length, first: w.querySelector("tbody tr[data-sym]")?.innerText || "", text: w.querySelector(".win-body").innerText }; });
  ok("[T] IVV HOLD: every holding from the issuer's file, by weight, with sectors summed (DERIVED) and the source", hv.title === "HOLDINGS · IVV" && hv.n >= 5 && /^1\s+NVDA\s+NVIDIA\s+Information Technology\s+8\.60%/.test(hv.first) && /SECTORS/.test(hv.text) && /iShares Core S&P 500 ETF \(IVV\)/.test(hv.text), JSON.stringify(hv).slice(0, 500));
  await page.fill('.win[data-type="HOLD"] [data-k="hsym"]', "SPY"); await page.press('.win[data-type="HOLD"] [data-k="hsym"]', "Enter"); await page.waitForTimeout(1500);
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('.win[data-type="HOLD"] .win-body').innerText), null, { timeout: 8000 }).catch(() => null);
  const hs = await page.evaluate(() => document.querySelector('.win[data-type="HOLD"] .win-body').innerText);
  ok("[T] HOLD of a U.S. ETF without an issuer file read here: N/A, nothing invented", /N\/A/.test(hs) && /IVV, QQQ and DIA/.test(hs), hs.slice(0, 300));
  await page.evaluate(() => document.querySelector('.win[data-type="FA"] [data-shf="DES"]').click()); await page.waitForTimeout(800);
  await page.fill('.win[data-type="HOLD"] [data-k="hsym"]', "VWCE"); await page.press('.win[data-type="HOLD"] [data-k="hsym"]', "Enter");
  await page.waitForFunction(() => /TOP 10 HOLDINGS/.test(document.querySelector('.win[data-type="HOLD"] .win-body').innerText), null, { timeout: 8000 }).catch(() => null);
  if (SHOTS) await page.screenshot({ path: SHOTS + "/hold.png" });
  const hu = await page.evaluate(() => document.querySelector('.win[data-type="HOLD"] .win-body').innerText);
  ok("[T] VWCE HOLD (UCITS): justETF's top 10, countries and sectors, the number of holdings", /Vanguard FTSE All-World/.test(hu) && /3,759/.test(hu) && /22\.10%/.test(hu) && /NVIDIA Corp\.\s+4\.90%/.test(hu) && /United States\s+62\.50%/.test(hu) && /justETF/.test(hu), hu.slice(0, 600));
  const des = await page.evaluate(() => !!document.querySelector('.win[data-type="DES"]') && [...document.querySelectorAll('.win[data-type="DES"] [data-shf]')].map((b) => b.textContent).join());
  ok("[T] DES / FA / ERN / CN link to each other for the same company", des === "FA,ERN,CN", String(des));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[T] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== U. as on Nico's terminal: colour-linked windows, saved views as tabs, refresh times in the titles ===============
{
  PV.kv.delete("ud/views"); // the views saved by earlier scenarios (K) are not this one's
  const { page, errors } = await openTerminal(OK_API);
  await page.waitForTimeout(1800);
  const rf = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".win")].map((w) => [w.dataset.type, w.querySelector(".w-rf").textContent])));
  ok("[U] a window's title: when its data was read and when it is read next (chart and watchlist: the next quote pull)", /^↻ \d{2}:\d{2} → \d{2}:\d{2}$/.test(rf.GP || "") && /^↻ \d{2}:\d{2} → \d{2}:\d{2}$/.test(rf.WL || ""), JSON.stringify(rf));
  // colour links
  await cmd(page, "CLOSE"); await cmd(page, "WL"); await cmd(page, "NVDA"); await cmd(page, "AAPL DES"); await cmd(page, "TILE"); await page.waitForTimeout(800);
  const dot = (t) => page.evaluate((t) => document.querySelector(`.win[data-type="${t}"] .w-link`).click(), t);
  const titles = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".win")].map((w) => [w.dataset.type, w.querySelector(".w-title").textContent])));
  await dot("WL"); await dot("GP"); await dot("DES"); await page.waitForTimeout(500);
  let t = await titles();
  const lk = await page.evaluate(() => [...document.querySelectorAll(".win.linked")].length + "|" + [...document.querySelectorAll(".lnk-box input")].map((i) => i.value).join());
  ok("[U] the dot gives windows a colour; a security window joining the colour takes its security (DES → NVDA); the colour's box shows it", t.DES === "DES · NVDA" && /^NVDA/.test(t.GP) && lk === "3|NVDA", JSON.stringify([t, lk]));
  const n0 = await page.$$eval(".win", (w) => w.length);
  await page.click('.win[data-type="WL"] .wl-row[data-sym="AAPL"]'); await page.waitForTimeout(700); t = await titles();
  ok("[U] a row clicked in the amber watchlist goes to the amber chart and DES (no new window)", /^AAPL/.test(t.GP) && t.DES === "DES · AAPL" && (await page.$$eval(".win", (w) => w.length)) === n0, JSON.stringify(t));
  await page.fill(".lnk-box input", "MSFT"); await page.press(".lnk-box input", "Enter"); await page.waitForTimeout(700); t = await titles();
  ok("[U] a ticker typed in the colour's box: every window of that colour follows", /^MSFT/.test(t.GP) && t.DES === "DES · MSFT", JSON.stringify(t));
  await page.fill('.win[data-type="DES"] [data-k="dsym"]', "NVDA"); await page.press('.win[data-type="DES"] [data-k="dsym"]', "Enter"); await page.waitForTimeout(700); t = await titles();
  await page.evaluate(() => document.querySelector('.win[data-type="DES"] [data-shf="FA"]').click()); await page.waitForTimeout(800);
  const fa = await page.evaluate(() => { const w = document.querySelector('.win[data-type="FA"]'); return w ? [w.classList.contains("linked"), w.querySelector(".w-title").textContent] : null; });
  ok("[U] a security changed in one window (DES) moves the others; a window opened from it (FA) takes the colour", /^NVDA/.test(t.GP) && fa && fa[0] === true && fa[1] === "FINANCIALS · NVDA", JSON.stringify([t, fa]));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/linked.png" });
  // views as tabs
  await page.click(".vt-add"); await page.fill(".vt-in", "Linked desk"); await page.press(".vt-in", "Enter"); await page.waitForTimeout(900);
  const tab1 = await page.evaluate(() => [...document.querySelectorAll(".vt[data-id]")].map((b) => (b.classList.contains("on") ? "*" : "") + b.textContent).join("|"));
  await cmd(page, "CLOSE"); await cmd(page, "CB"); await page.waitForTimeout(600);
  await page.click(".vt-add"); await page.fill(".vt-in", "Rates"); await page.press(".vt-in", "Enter"); await page.waitForTimeout(900);
  await page.click('.vt[data-id]:not(.on)'); await page.waitForTimeout(1500);
  const back = await page.evaluate(() => ({ types: [...document.querySelectorAll(".win")].map((w) => w.dataset.type).sort().join(), linked: document.querySelectorAll(".win.linked").length, on: document.querySelector(".vt.on")?.textContent }));
  ok("[U] + saves the desk as a view (a tab, active); clicking another tab opens its windows, colours included", tab1 === "*Linked desk" && back.types === "DES,FA,GP,WL" && back.linked === 4 && back.on === "Linked desk", JSON.stringify([tab1, back]));
  await cmd(page, "CAL"); await page.waitForTimeout(500);
  await page.click('.vt[data-id]:not(.on)'); await page.waitForTimeout(1500);
  const saved = await page.evaluate(async () => { const j = await (await fetch("/api/user/views")).json(); const v = j.views.find((x) => x.name === "Linked desk"); return v ? v.layout.map((x) => x.type).sort().join() : null; });
  ok("[U] the view you leave is saved with its windows (CAL opened there is kept); the other tab opens", saved === "CAL,DES,FA,GP,WL" && (await page.$$eval(".win", (w) => w.map((x) => x.dataset.type).join())) === "CB", String(saved));
  await page.dblclick('.vt.on'); await page.fill(".vt-in", "Rates desk"); await page.press(".vt-in", "Enter"); await page.waitForTimeout(800);
  const ren = await page.evaluate(() => [...document.querySelectorAll(".vt[data-id]")].map((b) => (b.classList.contains("on") ? "*" : "") + b.textContent).join("|"));
  await page.click('.vt[data-id]:not(.on)', { button: "right" }); await page.waitForTimeout(200); await page.click(".vt-del"); await page.waitForTimeout(800);
  const del = await page.evaluate(() => [...document.querySelectorAll(".vt[data-id]")].map((b) => b.textContent).join("|"));
  ok("[U] double-click renames a tab; right-click asks, then deletes", ren === "Linked desk|*Rates desk" && del === "Rates desk", JSON.stringify([ren, del]));
  await page.reload(); await page.waitForTimeout(2500);
  const rl = await page.evaluate(() => ({ on: document.querySelector(".vt.on")?.textContent, types: [...document.querySelectorAll(".win")].map((w) => w.dataset.type).join() }));
  ok("[U] reopening the page brings back the view you were in", rl.on === "Rates desk" && rl.types === "CB", JSON.stringify(rl));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[U] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== V. several portfolios (PORTS), as on Nico's terminal — through the real Worker code and its KV ===============
{
  PV.kv.delete("pf/tx"); PV.kv.delete("pf/list");
  const { page, errors } = await openTerminal({ ...OK_API, pre: async (route, u) => { if (u.origin === ORIGIN && u.pathname.startsWith("/api/portfolio")) { await viaWorker(route, u); return true; } return false; } });
  await page.waitForTimeout(1200);
  const trade = async (sym, qty, price) => { await page.fill('.win[data-type="PF"] .pf-form input[name="sym"]', sym); await page.click('.win[data-type="PF"] .pf-chk'); await page.waitForTimeout(800);
    await page.fill('.win[data-type="PF"] .pf-form input[name="qty"]', String(qty)); await page.fill('.win[data-type="PF"] .pf-form input[name="price"]', String(price)); await page.fill('.win[data-type="PF"] .pf-form input[name="date"]', "2026-10-01"); await page.click('.win[data-type="PF"] .pf-form button[type="submit"]'); await page.waitForTimeout(1500); };
  await cmd(page, "CLOSE"); await cmd(page, "PF"); await page.waitForTimeout(800); await trade("AAPL", 10, 200);
  await cmd(page, "PORTS"); await page.waitForTimeout(1500);
  const ports = () => page.evaluate(() => { const w = document.querySelector('.win[data-type="PORTS"]'); return { title: w.querySelector(".w-title").textContent, rows: [...w.querySelectorAll("tbody tr")].map((r) => r.innerText.replace(/\s+/g, " ").trim()), foot: w.querySelector("tfoot")?.innerText.replace(/\s+/g, " ").trim() || "" }; });
  let pt = await ports();
  ok("[V] PORTS: your portfolios valued at live quotes in EUR (the main one with AAPL: 10 × $250 at EUR/USD 1.12601)", pt.title === "PORTFOLIOS" && pt.rows.length === 1 && /^Main main · in view 1 1 €2,220\.23/.test(pt.rows[0]), JSON.stringify(pt));
  await page.fill('.pt-f input[name="name"]', "Kids"); await page.click('.pt-f button[type="submit"]'); await page.waitForTimeout(2000);
  const pfT = () => page.evaluate(() => { const w = document.querySelector('.win[data-type="PF"]'); return { title: w.querySelector(".w-title").textContent, text: w.querySelector(".win-body").innerText, tabs: [...w.querySelectorAll("[data-pfid]")].map((b) => (b.getAttribute("aria-pressed") === "true" ? "*" : "") + b.textContent).join("|") }; });
  let pf = await pfT();
  ok("[V] a new portfolio: created, put in view (PF shows it, empty; its tab pressed)", pf.title === "PORTFOLIO · Kids · EUR" && /Your portfolio is empty/.test(pf.text) && pf.tabs === "Main|*Kids", JSON.stringify({ t: pf.title, tabs: pf.tabs }));
  await trade("MSFT", 2, 400); pf = await pfT();
  pt = await ports();
  ok("[V] a trade goes to the portfolio in view only; PORTS: both, each valued, and their total", /MSFT/.test(pf.text) && !/AAPL/.test(pf.text.split("TRANSACTIONS")[0]) && pt.rows.length === 2 && /^Kids · in view 1 1 €/.test(pt.rows[1]) && /^ALL €[\d,.]+/.test(pt.foot) && JSON.parse(PV.kv.get("pf/tx")).length === 1 && PV.kv.get("pf/list").includes("Kids"), JSON.stringify(pt));
  await page.click('.win[data-type="PF"] [data-pfid="main"]'); await page.waitForTimeout(1500); pf = await pfT();
  ok("[V] the tabs in PF switch the portfolio in view", pf.title === "PORTFOLIO · Main · EUR" && /AAPL/.test(pf.text) && pf.tabs === "*Main|Kids", JSON.stringify({ t: pf.title, tabs: pf.tabs }));
  await page.evaluate(() => document.querySelector('.win[data-type="PORTS"] [data-ptd]').click()); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('.win[data-type="PORTS"] [data-pty]').click()); await page.waitForTimeout(1500);
  pt = await ports();
  ok("[V] a portfolio deleted with its trades (asked first); the main one cannot be", pt.rows.length === 1 && !(await page.$('.win[data-type="PORTS"] [data-ptd]')) && !PV.kv.get("pf/list").includes("Kids"), JSON.stringify(pt));
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[V] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  PV.kv.delete("pf/tx"); PV.kv.delete("pf/list");
  await page.close();
}

// =============== W. boards as on Nico's terminal: rows hidden with ✎ (kept on the server), returns measured in another currency ===============
{
  PV.kv.delete("ud/bcfg");
  const { page, errors } = await openTerminal(OK_API);
  await page.waitForTimeout(1200);
  await cmd(page, "CLOSE"); await cmd(page, "FUT"); await page.waitForTimeout(2500);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.win[data-type="FUT"] tbody tr[data-cn]')].filter((tr) => getComputedStyle(tr).display !== "none").map((tr) => tr.dataset.cn));
  const before = await rows();
  await page.click('.win[data-type="FUT"] .w-bedit'); await page.waitForTimeout(200);
  await page.click('.win[data-type="FUT"] tr[data-cn="@VX.1"]'); await page.waitForTimeout(800);
  const ed = await page.evaluate(() => ({ off: document.querySelector('.win[data-type="FUT"] tr[data-cn="@VX.1"]').classList.contains("b-off"), bar: document.querySelector('.win[data-type="FUT"] .b-edbar').innerText }));
  await page.click('.win[data-type="FUT"] .b-tog'); await page.waitForTimeout(300);
  const after = await rows();
  ok("[W] ✎ on a board: a row clicked is hidden (struck through while editing, gone after DONE), kept on the server", before.includes("@VX.1") && ed.off && /1 hidden/.test(ed.bar) && !after.includes("@VX.1") && after.length === before.length - 1 && JSON.parse(PV.kv.get("ud/bcfg"))[0].hide[0] === "@VX.1", JSON.stringify({ ed, n: [before.length, after.length] }));
  // returns in EUR
  const cell = () => page.evaluate(() => { const tr = document.querySelector('.win[data-type="FUT"] tr[data-cn="@CL.1"]'), c = [...tr.cells]; return { w1: c[5].textContent, t: c[5].title }; });
  const usd = await cell();
  await page.click('.win[data-type="FUT"] [data-bccy="EUR"]'); await page.waitForTimeout(2500);
  const eur = await cell();
  if (SHOTS) await page.screenshot({ path: SHOTS + "/fut-eur.png" });
  const fx = await page.evaluate(async () => { const j = await (await fetch("/api/cnbc/returns?syms=EUR%3D")).json(); return j.returns["EUR="].ref["1W"]; });
  const exp = ((1 + parseFloat(usd.w1) / 100) * (fx[1] / 1.12601) - 1) * 100; // euros per dollar: 1 / EUR/USD, now (Twelve Data) and a week ago (CNBC)
  ok("[W] RETURNS IN EUR: the dollar return × the change in euros per dollar (CNBC's daily FX bar of the period, the live rate now), DERIVED; remembered", Math.abs(parseFloat(eur.w1) - exp) < 0.011 && eur.w1 !== usd.w1 && /EUR/.test(eur.t) && (await page.evaluate(() => localStorage.getItem("at-bccy"))) === "EUR", JSON.stringify({ usd, eur, fx, exp }));
  await page.reload(); await page.waitForTimeout(1500); await cmd(page, "CLOSE"); await cmd(page, "FUT"); await page.waitForTimeout(2500);
  ok("[W] …opened again: the row still hidden, the returns in EUR", !(await rows()).includes("@VX.1") && (await page.evaluate(() => document.querySelector('.win[data-type="FUT"] [data-bccy="EUR"]').getAttribute("aria-pressed"))) === "true");
  const txt = await page.evaluate(() => document.body.innerText);
  ok("[W] no forbidden wording, NaN or undefined; no JavaScript errors", !FORBIDDEN.test(txt) && !/\bNaN\b|undefined/.test(txt) && errors.length === 0, errors.join(" | "));
  PV.kv.delete("ud/bcfg");
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
