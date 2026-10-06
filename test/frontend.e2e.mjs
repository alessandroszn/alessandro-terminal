// Headless browser tests of the terminal page with MOCKED /api responses (test fixtures, not shipped).
// Quote fixtures are produced by the Worker's own normalizeQuote + buildInstrument, so the page is
// tested against the real response contract. Policy under test: only real data, otherwise N/A.
//   node test/frontend.e2e.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { normalizeQuote, buildInstrument } from "../src/worker.mjs";

const html = readFileSync(new URL("../public/terminal/index.html", import.meta.url), "utf8");
const provJs = readFileSync(new URL("../public/terminal/provenance.js", import.meta.url), "utf8");
const ORIGIN = "https://alessandrozanichelli.com";
const SHOTS = process.env.SHOTS_DIR || null;
const LIVE = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "JPM"];

// ---------- fixtures ----------
function fixtureDaily() {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); const days = [];
  for (let i = 1; days.length < 252; i++) { const x = new Date(d - i * 864e5); const wd = x.getUTCDay(); if (wd !== 0 && wd !== 6) days.push(x.toISOString().slice(0, 10)); }
  days.reverse();
  return days.map((t, i) => { const c = +(200 + i * (50 / 251) + Math.sin(i / 3) * 2).toFixed(2); return { t, o: c, h: c + 1, l: c - 1, c, v: 1e6 }; });
}
const daily = fixtureDaily();
const PRICES = { NVDA: 190.5, AAPL: 250, MSFT: 430.25, AMZN: 210.1, GOOGL: 205.75, JPM: 260.4 };
function instrument(s, { stale = false } = {}) {
  const now = Date.now(), px = PRICES[s] || 100;
  const rec = normalizeQuote(s, { symbol: s, name: s + " Inc", exchange: "NASDAQ", currency: "USD", close: String(px), previous_close: String(px - 2), percent_change: String((2 / (px - 2)) * 100), change: "2", open: String(px - 1), high: String(px + 1), low: String(px - 3), volume: "537842", is_market_open: true, last_quote_at: Math.floor(now / 1000) - 60, fifty_two_week: { low: "150", high: "300" } });
  return buildInstrument(rec, { fetchedAt: now - 5000, now, stale, error: stale ? "rate_limited" : null });
}
const historyBody = (sym, range, extra = {}) => {
  const now = Date.now();
  const pts = range === "1D" ? daily.slice(-78).map((p, i) => ({ ...p, t: new Date(now - (78 - i) * 300e3).toISOString().slice(0, 19) + "Z" })) : daily;
  return { symbol: sym, range, interval: range === "1D" ? "5min" : "1day", adjust: "splits", count: pts.length, points: pts, status: "LIVE", source: "twelvedata", fetchedAt: new Date(now).toISOString(), staleAt: new Date(now + 864e5).toISOString(), lastBarPartial: false, asOf: new Date(now).toISOString(), provider: "twelvedata", ...extra };
};

// ---------- harness ----------
let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" + "-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const FORBIDDEN = /SIMULATED|\bSIM\b|MIXED|MODEL|hypothetical|static sample|WORLD INDICES|YIELD CURVE|ECONOMIC CALENDAR|NEWS WIRE|EARNINGS|PORTFOLIO|\bDES\b/;

async function openTerminal(api) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const requests = [], errors = [];
  page.on("request", (r) => requests.push(r.url()));
  // HTTP error statuses are logged by the browser as "Failed to load resource"; that is the mocked API, not a page bug
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === ORIGIN && u.pathname === "/terminal/provenance.js") return route.fulfill({ contentType: "application/javascript", body: provJs });
    if (u.origin === ORIGIN && u.pathname.startsWith("/terminal")) return route.fulfill({ contentType: "text/html", body: html });
    if (u.origin === ORIGIN && u.pathname === "/api/quote") { const r = api.quote((u.searchParams.get("symbols") || "").split(",")); return route.fulfill({ status: r.status || 200, contentType: "application/json", body: JSON.stringify(r.body) }); }
    if (u.origin === ORIGIN && u.pathname === "/api/history") { const r = api.history(u.searchParams.get("symbol"), u.searchParams.get("range")); return route.fulfill({ status: r.status || 200, contentType: "application/json", body: JSON.stringify(r.body) }); }
    if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) return route.fulfill({ body: "" });
    return route.abort();
  });
  await page.goto(ORIGIN + "/terminal/");
  return { page, requests, errors };
}
const winOf = (page, prefix) => page.evaluate((p) => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith(p)); return w ? { text: w.querySelector(".win-body").innerText, pill: w.querySelector(".w-pv")?.innerText || "" } : null; }, prefix);
// returns true when the command line refused the command (input kept / error flash)
const cmd = async (page, c) => { await page.fill("#cmd", c); await page.press("#cmd", "Enter"); await page.waitForTimeout(400); return page.evaluate(() => document.querySelector("#cmd").value !== ""); };
const winCount = (page) => page.evaluate(() => document.querySelectorAll(".win").length);

// =============== A. normal operation: every value real ===============
{
  const api = {
    quote: (syms) => ({ body: { quotes: Object.fromEntries(syms.map((s) => [s, instrument(s)])), errors: {}, meta: { source: "twelvedata" } } }),
    history: (sym, range) => ({ body: historyBody(sym, range) }),
  };
  const { page, requests, errors } = await openTerminal(api);
  await page.waitForFunction(() => /^● LIVE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  const badge = await page.textContent("#dataBadge");
  ok("[A] global badge = LIVE · 6 LIVE", badge === "● LIVE · 6 LIVE", badge);
  const badgeTitle = await page.getAttribute("#dataBadge", "title");
  ok("[A] badge tooltip lists each instrument with its status", LIVE.every((s) => badgeTitle.includes(`${s} — LIVE`)), badgeTitle.slice(0, 200));
  const wl = await winOf(page, "WATCHLIST");
  ok("[A] watchlist = exactly the 6 live instruments", (await page.$$eval(".wl-row", (r) => r.map((x) => x.dataset.sym).join())) === LIVE.join());
  ok("[A] watchlist window LIVE, every row LIVE", wl.pill === "LIVE" && LIVE.every((s) => new RegExp(`${s}\\s+LIVE`).test(wl.text)), wl.pill);
  const heatCells = await page.$$eval(".heat-cell", (c) => c.length);
  ok("[A] heatmap = 6 cells, GICS sectors", heatCells === 6 && /INFORMATION TECHNOLOGY/.test((await winOf(page, "SECTOR HEATMAP")).text));
  const mov = await winOf(page, "MARKET MOVERS");
  ok("[A] movers: live instruments, volume ranking flagged PARTIAL", /MOST ACTIVE\s*PART/.test(mov.text) && /NVDA|AAPL/.test(mov.text) && !/SHORTED/i.test(mov.text));

  await cmd(page, "AAPL");
  await page.waitForFunction(() => [...document.querySelectorAll(".win")].some((w) => w.querySelector(".w-title")?.textContent.startsWith("AAPL")), null, { timeout: 5000 });
  let gp = await winOf(page, "AAPL");
  ok("[A] AAPL price and name come from /api/quote", gp.text.includes("$250.00") && gp.text.includes("AAPL Inc") && gp.text.includes("NASDAQ"), gp.text.slice(0, 160));
  ok("[A] volume shown with PARTIAL chip", /VOLUME\s*PART\s*537\.8K/.test(gp.text), gp.text.match(/VOLUME[\s\S]{0,30}/)?.[0]);
  ok("[A] open/high/low flagged PARTIAL", /OPEN\s*PART/.test(gp.text) && /DAY HIGH\s*PART/.test(gp.text));
  ok("[A] market cap and P/E = N/A (no fundamentals source)", /MKT CAP\s*N\/A\s*N\/A/.test(gp.text) && /P\/E\s*N\/A\s*N\/A/.test(gp.text));
  ok("[A] no hand-written description", !/DES —|static description/.test(gp.text));
  await page.waitForTimeout(11000); // history queue (9 s gap)
  gp = await winOf(page, "AAPL");
  ok("[A] chart caption: real daily closes, LIVE", /LIVE\s+daily closes, split-adjusted · 252 obs/.test(gp.text), gp.text.match(/daily closes[^\n]*/)?.[0]);
  const chartPx = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith("AAPL")); const cv = w.querySelector("canvas"); const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  ok("[A] AAPL chart drew the real series", chartPx > 1000, String(chartPx));
  ok("[A] /api/history called on the site origin", requests.some((u) => u.startsWith(ORIGIN + "/api/history?symbol=AAPL")));

  // functions without a real source no longer exist
  const before = await winCount(page);
  const refused = [];
  for (const c of ["IDX", "CURV", "CAL", "N", "ERN", "PORT", "DES", "XOM", "META"]) { if (await cmd(page, c)) refused.push(c); await page.fill("#cmd", ""); }
  ok("[A] IDX, CURV, CAL, N, ERN, PORT, DES and former simulated tickers are refused", refused.length === 9 && (await winCount(page)) === before, refused.join());
  const launcher = await page.$$eval("#fnbar .fn", (b) => b.map((x) => x.textContent).join(","));
  ok("[A] launcher only lists functions backed by real data", launcher === "SECURITY,WATCHLIST,MOVERS,SCREENER,COMPARE,CORREL,HEATMAP,SETTINGS,HELP", launcher);
  ok("[A] no currency selector (no live FX source)", (await page.$("#ccy")) === null);

  await cmd(page, "SCR");
  const scr = await winOf(page, "EQUITY SCREENER");
  ok("[A] screener: 6 rows, no MKT CAP / P/E columns", (await page.$$eval(".scr-results tbody tr", (r) => r.length)) === 6 && !/MKT CAP\s|P\/E\s/.test(scr.text.split("\n").slice(0, 8).join(" ")));
  await cmd(page, "COMP");
  await page.waitForTimeout(500);
  ok("[A] compare: only live instruments to choose from", (await page.$$eval(".chip[data-csym]", (c) => c.map((x) => x.dataset.csym).join())) === LIVE.join());
  await cmd(page, "CORR");
  ok("[A] correlation: 6×6 over live instruments only", (await page.$$eval(".corr .cc", (c) => c.length)) === 36);

  const tape = await page.textContent("#tape");
  ok("[A] tape: live instruments only, no headlines", /LIVE/.test(tape) && !/Futures|Chipmakers|Treasury/.test(tape));
  const status = await page.textContent("#status");
  ok("[A] status bar: US market state and data time from the provider", /US MARKET OPEN/.test(status) && /DATA AS OF \d\d:\d\d:\d\d local/.test(status) && !/FOMC|\/199/.test(status), status);
  ok("[A] top bar: 6/6 live", (await page.textContent("#breadth-top")) === "6/6 live");
  const body = await page.evaluate(() => document.body.innerText);
  ok("[A] no simulated / model / sample wording anywhere on screen", !FORBIDDEN.test(body), (body.match(new RegExp(".{20}(" + FORBIDDEN.source + ").{20}")) || [])[0]);
  ok("[A] no NaN / undefined rendered anywhere", !/NaN|undefined/.test(body));
  ok("[A] NO browser request to api.twelvedata.com (or any third-party data host)", !requests.some((u) => /twelvedata\.com|finnhub/.test(u)));
  ok("[A] NO apikey/token in any browser URL", !requests.some((u) => /apikey=|token=/i.test(u)));
  ok("[A] no JavaScript errors", errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "TILE"); await page.waitForTimeout(600); await page.screenshot({ path: SHOTS + "/e2e-live-only.png" }); }
  await page.close();
}

// =============== B. provider failure: no value at all, N/A ===============
{
  const api = {
    quote: (syms) => ({ status: 429, body: { quotes: {}, errors: Object.fromEntries(syms.map((s) => [s, { error: "rate_limited", status: "N/A" }])), meta: {} } }),
    history: () => ({ status: 429, body: { error: "rate_limited", status: "N/A" } }),
  };
  const { page, errors } = await openTerminal(api);
  await page.waitForFunction(() => /N\/A/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => document.body.innerText);
  ok("[B] no price anywhere on screen (no fallback value)", !/\$\d/.test(body), (body.match(/.{20}\$\d.{10}/) || [])[0]);
  const nv = await winOf(page, "NVDA");
  ok("[B] failure explained: N/A banner with the reason", /quote unavailable: provider rate limit reached/.test(nv.text) && /NVDA\s+N\/A/.test(nv.text));
  ok("[B] chart: real history unavailable, nothing drawn in its place", /real history unavailable — provider rate limit reached/.test(nv.text));
  ok("[B] badge = N/A for all 6", (await page.textContent("#dataBadge")) === "● N/A · 6 N/A", await page.textContent("#dataBadge"));
  ok("[B] heatmap and movers show no invented values", (await winOf(page, "SECTOR HEATMAP")).pill === "N/A" && /Waiting for live quotes/.test((await winOf(page, "MARKET MOVERS")).text));
  ok("[B] no NaN rendered", !/NaN/.test(body));
  ok("[B] no JavaScript errors", errors.length === 0, errors.join(" | "));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/e2e-provider-down.png" });
  await page.close();
}

// =============== C. one stale instrument: the mix is indicated ===============
{
  const api = {
    quote: (syms) => ({ body: { quotes: Object.fromEntries(syms.map((s) => [s, instrument(s, { stale: s === "NVDA" })])), errors: {}, meta: {} } }),
    history: (sym, range) => ({ body: historyBody(sym, range, sym === "NVDA" ? { status: "STALE", staleReason: "provider_timeout" } : {}) }),
  };
  const { page, errors } = await openTerminal(api);
  await page.waitForFunction(() => /STALE/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  ok("[C] global badge = STALE · 5 LIVE · 1 STALE", (await page.textContent("#dataBadge")) === "● STALE · 5 LIVE · 1 STALE", await page.textContent("#dataBadge"));
  const nv = await winOf(page, "NVDA");
  ok("[C] stale quote shown with its real value and a STALE label", nv.text.includes("$190.50") && /NVDA\s+STALE/.test(nv.text) && /refresh failed: provider rate limit reached/.test(nv.text));
  ok("[C] stale fields are STALE, not LIVE/PARTIAL", /VOLUME\s*STALE/.test(nv.text) && /PREV CLOSE\s*STALE/.test(nv.text));
  ok("[C] stale history labelled STALE with reason", /STALE\s+daily closes[^\n]*refresh failed: provider timed out/.test(nv.text), nv.text.match(/daily closes[^\n]*/)?.[0]);
  const wl = await winOf(page, "WATCHLIST");
  ok("[C] mixed view indicated: watchlist pill STALE, rows LIVE + STALE", wl.pill === "STALE" && /NVDA\s+STALE/.test(wl.text) && /AAPL\s+LIVE/.test(wl.text), wl.pill);
  ok("[C] no JavaScript errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
