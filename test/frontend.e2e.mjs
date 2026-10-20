// Headless browser tests of the terminal page with MOCKED /api responses (test fixtures, never shipped).
// Quote fixtures come from the Worker's own normalizeQuote + buildInstrument (real contract).
// Policy under test: only real data, otherwise N/A / NO DATA.
//   node test/frontend.e2e.mjs
import { chromium } from "playwright";
import { buildPositions, validateTx } from "../src/portfolio.mjs";
import { readFileSync } from "node:fs";
import { normalizeQuote, buildInstrument, app as workerApp } from "../src/worker.mjs";
import { normalizeSearch } from "../src/search.mjs";
import { cnbcIntlRec, cnbcInstrument } from "../src/intl.mjs";
import { settlementCandidates } from "../src/finra.mjs";

const html0 = readFileSync(new URL("../public/terminal/index.html", import.meta.url), "utf8");
// speed: lift the client credit budget for UI tests (scenario D tests the real budget)
const htmlFast = html0.replace("creditsPerMin:8,", "creditsPerMin:60,");
const provJs = readFileSync(new URL("../public/terminal/provenance.js", import.meta.url), "utf8");
const i18nJs = readFileSync(new URL("../public/terminal/i18n.js", import.meta.url), "utf8");
const lwcJs = readFileSync(new URL("../public/terminal/vendor/lightweight-charts.js", import.meta.url), "utf8");
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
], curves: [
  { id: "crude", name: "WTI crude futures (NYMEX)", unit: "$/bbl", dates: { latest: dShift(today, -7), week: dShift(today, -14), month: dShift(today, -37) }, latest: [62.3, 62.0, 61.8, 61.6].map((v, i) => ({ contract: i + 1, value: v })), week: [63, 62.8, 62.5, 62.3].map((v, i) => ({ contract: i + 1, value: v })), month: [60, 60.2, 60.3, 60.4].map((v, i) => ({ contract: i + 1, value: v })), status: "LIVE" },
  { id: "gas", name: "Natural gas futures (NYMEX)", unit: "$/MMBtu", status: "N/A", error: "no_data" },
], source: "EIA", sourceUrl: "https://www.eia.gov/opendata/", status: "LIVE" });
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
const TG_TOKEN = "123456789:AAH" + "e".repeat(32);
const cnTime = (ms) => new Date(ms).toISOString().replace("Z", "+0000");
const CN_PX = { ".SPX": 6700.5, ".NDX": 24800, ".DJI": 46500, ".RUT": 2450, ".N225": 49000, "@SP.1": 6731.25, "@ND.1": 24890, "@DJ.1": 46600, "@TFS.1": 2460, "@NK.1": 49150, "@CL.1": 88.42, "@GC.1": 4130.5, "EUR=": 1.1235, "NVDA": 190.5, ".FTMIB": 44000 };
const cnPx = (s) => CN_PX[s] ?? (/^@CL\.(\d+)$/.test(s) ? 88.42 - (+s.split(".")[1] - 1) * 0.35 : /^@NG\.(\d+)$/.test(s) ? 3.1 + (+s.split(".")[1]) * 0.08 : 50 + [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 70);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const cnQuote = (s) => { const last = cnPx(s), prev = +(last / 1.0075).toFixed(4), n = /^@[A-Z]+\.(\d+)$/.exec(s), m = n ? (10 + +n[1]) : 0;
  return { symbol: s, code: 0, name: n ? `${s} (${MON[m % 12]}'${26 + Math.floor(m / 12)})` : s === "EUR=" ? "EUR/USD" : s, last: last.toLocaleString("en-US", { maximumFractionDigits: 4 }), previous_day_closing: String(prev), change: "+" + (last - prev).toFixed(4), change_pct: "+0.75%", open: String(prev), high: String(last), low: String(prev), volume: "1000", last_time: cnTime(Date.now() - (s.startsWith(".") ? 5 : 2) * 60_000), exchange: "CME", realTime: s.startsWith(".") ? "false" : "true", curmktstatus: "REG_MKT" }; };
const cnBars = (s, five) => { const out = [], end = Date.now(); if (five) { for (let t = end - 4 * 864e5; t < end; t += 300_000) out.push({ close: String(cnPx(s)), tradeTime: "x", tradeTimeinMills: t - t % 300_000 }); return out; }
  const d0 = new Date(); d0.setUTCHours(4, 0, 0, 0); for (let i = 420; i >= 1; i--) { const t = d0.getTime() - i * 864e5, wd = new Date(t).getUTCDay(); if (wd === 0 || wd === 6) continue; const v = cnPx(s) * (1 - i * 0.0004 + Math.sin(i / 9) * 0.01); out.push({ close: v.toFixed(4), open: v.toFixed(4), high: (v * 1.01).toFixed(4), low: (v * 0.99).toFixed(4), tradeTime: new Date(t).toISOString().slice(0, 10).replace(/-/g, "") + "000000", tradeTimeinMills: t }); } return out; };
const NQ_TODAY = new Date().toISOString().slice(0, 10);
const E2E_SETTLE = settlementCandidates(Date.now()).find((c) => c <= new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10));
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://quote.cnbc.com/")) { const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split("|"); PV.cnbcAsked.push(syms); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((s) => s === "ZZZZ" ? { symbol: s, code: 1 } : cnQuote(s)) } })); }
  if (u.startsWith("https://ts-api.cnbc.com/")) { const sym = decodeURIComponent(u.split("/bars/")[1].split("/")[0]); return new Response(JSON.stringify({ barData: { priceBars: cnBars(sym, /\/5M\//.test(u)) } })); }
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
  if (u.startsWith("https://apewisdom.io/")) return new Response(JSON.stringify({ results: [{ rank: 1, ticker: "NVDA", name: "NVIDIA", mentions: 812, upvotes: 4021, rank_24h_ago: 2, mentions_24h_ago: 640 }, { rank: 2, ticker: "TSLA", name: "Tesla", mentions: 700, upvotes: 3000, rank_24h_ago: 1, mentions_24h_ago: 900 }] }));
  if (u.startsWith("https://api.telegram.org/")) { const method = u.split("/").pop(), body = JSON.parse(init.body || "{}"); PV.tg.push({ method, body, tokenInUrl: u.includes(TG_TOKEN) });
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Ale alerts", username: "ale_alerts_bot" } }));
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: { id: 4242, type: "private", first_name: "Alessandro" }, text: "/start" } }] }));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } })); }
  return new Response("", { status: 404 });
};
const workerEnv = { ALLOWED_ORIGIN: ORIGIN, TELEGRAM_BOT_TOKEN: TG_TOKEN, BRIEFS: { get: async (k) => PV.kv.get(k) ?? null, put: async (k, v) => { PV.kv.set(k, v); }, delete: async (k) => { PV.kv.delete(k); } } };
async function viaWorker(route, u) {
  const rq = route.request(), m = rq.method();
  const r = await workerApp.fetch(new Request(u.href, { method: m, headers: { "content-type": rq.headers()["content-type"] || "", origin: ORIGIN }, body: m === "GET" || m === "HEAD" ? undefined : rq.postData() || undefined }), workerEnv, { waitUntil() {} });
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const requests = [], errors = [], quoteBatches = [], spxCalls = [], brfState = { writes: [], written: false }, pfState = { tx: [], posts: [], deletes: [] }, t7 = { calls: [], alerts: [], notes: [], boards: [], hits: [], noEia: !!(api.noEia), noFred: !!(api.noFred) };
  page.on("request", (r) => requests.push(r.url()));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    const send = (r) => route.fulfill({ status: r.status || 200, contentType: "application/json", body: JSON.stringify(r.body) });
    if (u.origin === ORIGIN && u.pathname === "/terminal/provenance.js") return route.fulfill({ contentType: "application/javascript", body: provJs });
    if (u.origin === ORIGIN && u.pathname === "/terminal/i18n.js") return route.fulfill({ contentType: "application/javascript", body: i18nJs });
    if (u.origin === ORIGIN && u.pathname === "/terminal/vendor/lightweight-charts.js") return route.fulfill({ contentType: "application/javascript", body: lwcJs });
    if (u.origin === ORIGIN && u.pathname.startsWith("/terminal")) return route.fulfill({ contentType: "text/html", body: html });
    if (u.origin === ORIGIN && u.pathname === "/api/quote") { const syms = (u.searchParams.get("symbols") || "").split(","); quoteBatches.push({ t: Date.now(), syms }); return send(api.quote(syms)); }
    if (u.origin === ORIGIN && u.pathname === "/api/history") return send(api.history(u.searchParams.get("symbol"), u.searchParams.get("range")));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/briefs")) return send(api.briefs ? api.briefs(u) : briefsApi(u, route.request().method(), brfState));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/portfolio")) { let b = null; try { b = JSON.parse(route.request().postData() || "null"); } catch {} return send(api.portfolio ? api.portfolio(u) : pfApi(u, route.request().method(), b, pfState)); }
    if (u.origin === ORIGIN && u.pathname === "/api/calendar/reactions") return send(api.reactions ? api.reactions() : { body: CAL_REACT() });
    if (u.origin === ORIGIN && u.pathname === "/api/calendar/history") return send({ body: { ccy: u.searchParams.get("ccy"), title: u.searchParams.get("title"), releases: [{ datetime: "2026-09-10T12:30:00.000Z", forecast: "0.2%", previous: "0.2%" }], note: "Forecast and previous as published by Forex Factory in each weekly export since the archive started.", status: "LIVE" } });
    if (u.origin === ORIGIN && u.pathname === "/api/exchanges") return send(api.exchanges ? api.exchanges() : { body: EXCH() });
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/spx/")) { spxCalls.push(u.pathname + u.search); return send(api.spx ? api.spx(u.pathname, u) : spxApi(u.pathname, u)); }
    if (u.origin === ORIGIN && u.pathname === "/api/search") return send(api.search ? api.search(u.searchParams.get("q")) : { body: searchBody(u.searchParams.get("q")) });
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/markets/")) return send(api.markets ? api.markets(u) : marketsApi(u));
    if (u.origin === ORIGIN && (u.pathname === "/api/indices" || u.pathname === "/api/indices/history")) return send(api.indices ? api.indices(u) : indicesApi(u));
    if (u.origin === ORIGIN && u.pathname.startsWith("/api/yields/market")) return send(api.mkt ? api.mkt(u) : mktApi(u));
    if (u.origin === ORIGIN && u.pathname === "/api/yields/history") return send(api.yieldsHistory ? api.yieldsHistory(u) : yieldsHistory(u));
    if (u.origin === ORIGIN && u.pathname === "/api/yields" && u.searchParams.get("ids") && !api.yieldsRaw) return send(api.yieldsIds ? api.yieldsIds(u) : yieldsIds(u));
    if (u.origin === ORIGIN && ["/api/yields", "/api/calendar", "/api/news", "/api/briefing", "/api/headlines"].includes(u.pathname)) return send(api.ext(u.pathname.slice(5), u));
    if (u.origin === ORIGIN && (/^\/api\/(cnbc|nasdaq|alerts|finra)\//.test(u.pathname) || u.pathname === "/api/reddit" || u.pathname === "/api/alerts" || u.pathname.startsWith("/api/user/alerts") || u.pathname.startsWith("/api/user/views"))) return viaWorker(route, u);
    if (u.origin === ORIGIN && /^\/api\/(cb|sprd|energy|earnings|des|options|user|status|bonds|cot)(\/|$)/.test(u.pathname)) { let b = null; try { b = JSON.parse(route.request().postData() || "null"); } catch {} return send(t07Api(u, route.request().method(), b, t7)); }
    if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) return route.fulfill({ body: "" });
    return route.abort();
  });
  if (init) await page.addInitScript(init);
  await page.goto(ORIGIN + "/terminal/");
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
  ok("[H] menu: five categories with their codes, N/A marked where there is no source", menu.on && menu.cats === "MARKETS|RATES & MACRO|ANALYSIS|MY STUFF|LAYOUT" && menu.codes.startsWith("IDX,EQ,FX,CMDTY,CRYPTO,ETF,FUT,COT,BOARD,WL,HEAT,MOV,SCR,RDT,MKT,EXCH,BRIEF,NEWS,YLD,CURVE,BOND,SPRD,CB,CAL,ERN,FXM,FCRV,DES,OMON,WS,COMP,PERF,CROSS,CORR,BT,PORT,PFA,ALRT,NOTE,SYS,SET,VIEW,CLOSE,UNDO,TILE,TOUR,HELP") && menu.na === "", JSON.stringify(menu));
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
  await shotWin(page, "COMMODITIES", "t07-cmdty");
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
  ok("[H] FUT: where the cash indices are set to open (implied move DERIVED) and 45 contracts by group with month, last, returns", /WHERE THE CASH INDICES ARE SET TO OPEN\s*DRV/.test(fu.text) && /S&P 500\s+6,700\.50\s+[\s\S]{0,30}Dec 2026\s+6,731\.25\s+6,731\.25\s+\+0\.00%\s+6,700\.50/.test(fu.text) && /S&P 500 E-mini\s+Dec 2026\s+6,731\.25\s+pts\s+\+0\.75%/.test(fu.text) && /LIVESTOCK/.test(fu.text) && fu.pill === "LIVE", fu.text.slice(0, 900));
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
  await page.keyboard.press("m"); await page.waitForTimeout(300);
  const mi = await page.evaluate(() => [...document.querySelectorAll(".fm-col h4")].map((h) => h.textContent).join("|") + " " + document.querySelector('.fm-i[data-fn="OMON"]')?.innerText);
  await page.keyboard.press("Escape");
  await cmd(page, "CB"); await page.waitForTimeout(400);
  ok("[H] Italian: menu and new windows in Italian, codes and data unchanged", /^MERCATI\|TASSI E MACRO\|ANALISI\|PERSONALE\|LAYOUT OMON\s+Monitor delle opzioni/.test(mi) && !!(await winOf(page, "BANCHE CENTRALI")) && /BANCA CENTRALE\s+TASSO\s+AL\s+ULTIMA MOSSA/.test((await winOf(page, "BANCHE CENTRALI")).text), mi + " || " + ((await winOf(page, "BANCHE CENTRALI")) || {}).text?.slice(0, 400));
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
  ok("[H] no EIA key → the EIA spot rows are N/A naming the missing key; CNBC futures and curves unaffected", /N\/A — EIA prices unavailable \(EIA API key not set in the Worker\)/.test(cm.text) && /WTI crude oil\s+Dec 2026\s+88\.42/.test(cm.text) && /WTI CRUDE OIL · CURVE BY CONTRACT MONTH/.test(fc.text) && errors.length === 0, cm.text.slice(cm.text.indexOf("SPOT") - 200, cm.text.indexOf("SPOT") + 400));
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
  await page.click('[data-ov="TERM"]'); await page.waitForTimeout(800); om = await winOf(page, "OPTIONS · AAPL");
  ok("[J] OMON TERM: ATM IV, straddle and expected move per expiry", /29 Oct 2026\s+9\s+250\s+28\.0%\s+17\.25\s+±6\.9%\s+±4\.4%/.test(om.text) && /26 Nov 2026\s+37\s+250\s+28\.0%/.test(om.text), om.text.slice(om.text.indexOf("EXPIRY"), om.text.indexOf("EXPIRY") + 300));
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
  const th = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), panel: getComputedStyle(document.documentElement).getPropertyValue("--panel").trim(), accent: getComputedStyle(document.documentElement).getPropertyValue("--amber").trim(), n: document.querySelectorAll("[data-theme]").length, saved: localStorage.getItem("at-theme") }));
  await page.click('[data-theme="amber"]'); await page.waitForTimeout(300);
  const th2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
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

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
