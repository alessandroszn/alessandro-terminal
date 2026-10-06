// Headless browser tests of the terminal page with MOCKED /api responses (fixtures, not market data).
// The quote fixtures are produced by the Worker's own normalizeQuote + buildInstrument, so the page is
// tested against the real response contract.
//   node test/frontend.e2e.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { normalizeQuote, buildInstrument } from "../src/worker.mjs";

const html = readFileSync(new URL("../public/terminal/index.html", import.meta.url), "utf8");
const provJs = readFileSync(new URL("../public/terminal/provenance.js", import.meta.url), "utf8");
const ORIGIN = "https://alessandrozanichelli.com";
const SHOTS = process.env.SHOTS_DIR || null;
const LIVE = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "JPM"];
const SEED = { NVDA: "182.40", AAPL: "247.15", MSFT: "441.80", AMZN: "221.60", GOOGL: "198.25", JPM: "258.70" };

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
const cmd = async (page, c) => { await page.fill("#cmd", c); await page.press("#cmd", "Enter"); await page.waitForTimeout(400); };

// =============== A. normal operation: live + simulated universe ===============
{
  const api = {
    quote: (syms) => ({ body: { quotes: Object.fromEntries(syms.map((s) => [s, instrument(s)])), errors: {}, meta: { source: "twelvedata" } } }),
    history: (sym, range) => ({ body: historyBody(sym, range) }),
  };
  const { page, requests, errors } = await openTerminal(api);
  await page.waitForFunction(() => /MIXED/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  const badge = await page.textContent("#dataBadge");
  ok("[A] global badge = MIXED with live and simulated counts", /MIXED · 6 LIVE · 12 SIM/.test(badge), badge);
  const badgeTitle = await page.getAttribute("#dataBadge", "title");
  ok("[A] badge tooltip lists per-instrument status (AAPL — LIVE, XOM — SIMULATED)", badgeTitle.includes("AAPL — LIVE") && badgeTitle.includes("XOM — SIMULATED"), badgeTitle.slice(0, 200));
  const wl = await winOf(page, "WATCHLIST");
  ok("[A] watchlist window marked MIXED", wl.pill === "MIXED", wl.pill);
  ok("[A] watchlist rows carry LIVE and SIM chips", /AAPL\s+LIVE/.test(wl.text) && /XOM\s+SIM/.test(wl.text), wl.text.slice(0, 160));
  const mov = await winOf(page, "MARKET MOVERS");
  ok("[A] movers rank live instruments only", !/XOM|CVX|LLY|TSLA/.test(mov.text) && /NVDA|AAPL/.test(mov.text), mov.text.slice(0, 200));
  ok("[A] movers: no 'most shorted' (no source)", !/SHORTED/i.test(mov.text));
  ok("[A] movers volume ranking flagged PARTIAL", /MOST ACTIVE\s*PART/.test(mov.text), mov.text.slice(0, 300));

  await cmd(page, "AAPL");
  await page.waitForFunction(() => [...document.querySelectorAll(".win")].some((w) => w.querySelector(".w-title")?.textContent.startsWith("AAPL")), null, { timeout: 5000 });
  let gp = await winOf(page, "AAPL");
  ok("[A] AAPL price comes from /api/quote", gp.text.includes("$250.00"), gp.text.slice(0, 120));
  ok("[A] AAPL marked LIVE", /AAPL\s+LIVE/.test(gp.text));
  ok("[A] volume shown with PARTIAL chip", /VOLUME\s*PART\s*537\.8K/.test(gp.text), gp.text.match(/VOLUME[\s\S]{0,30}/)?.[0]);
  ok("[A] open/high/low flagged PARTIAL", /OPEN\s*PART/.test(gp.text) && /DAY HIGH\s*PART/.test(gp.text));
  ok("[A] market cap = N/A (no fundamentals source)", /MKT CAP\s*N\/A\s*N\/A/.test(gp.text), gp.text.match(/MKT CAP[\s\S]{0,20}/)?.[0]);
  ok("[A] P/E = N/A", /P\/E\s*N\/A\s*N\/A/.test(gp.text));
  await page.waitForTimeout(11000); // history queue (9 s gap)
  gp = await winOf(page, "AAPL");
  ok("[A] chart caption: real daily closes, LIVE", /LIVE\s+daily closes, split-adjusted · 252 obs/.test(gp.text), gp.text.match(/daily closes[^\n]*/)?.[0]);
  const histCalls = requests.filter((u) => u.includes("/api/history?symbol=AAPL"));
  ok("[A] /api/history called on the site origin", histCalls.length >= 1 && histCalls.every((u) => u.startsWith(ORIGIN)));
  const chartPx = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find((w) => w.querySelector(".w-title")?.textContent.startsWith("AAPL")); const cv = w.querySelector("canvas"); const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  ok("[A] AAPL chart drew the real series", chartPx > 1000, String(chartPx));

  await cmd(page, "XOM");
  const xom = await winOf(page, "XOM");
  ok("[A] simulated instrument labelled SIMULATED everywhere", /XOM\s+SIMULATED/.test(xom.text) && xom.text.includes("simulated price path") && xom.pill === "SIMULATED", xom.pill);
  ok("[A] simulated instrument: fundamentals still N/A", /MKT CAP\s*N\/A\s*N\/A/.test(xom.text));

  await cmd(page, "IDX");
  const idx = await winOf(page, "WORLD INDICES");
  ok("[A] static dataset (indices) shows a SIMULATED banner and pill", idx.text.includes("SIMULATED — index levels") && idx.pill === "SIMULATED");
  ok("[A] global badge counts the simulated dataset", /SIM DATASET/.test(await page.textContent("#dataBadge")));
  await cmd(page, "ERN");
  const ern = await winOf(page, "EARNINGS");
  ok("[A] earnings: simulated estimates removed, N/A empty state", /No earnings data source/.test(ern.text) && !/EPS EST|BMO|AMC/.test(ern.text));
  await cmd(page, "SCR");
  const scr = await winOf(page, "EQUITY SCREENER");
  ok("[A] screener: no MKT CAP / P/E columns, rows labelled", !/MKT CAP\s|P\/E\s/.test(scr.text.split("\n").slice(0, 8).join(" ")) && /LIVE/.test(scr.text) && /SIM/.test(scr.text));
  await cmd(page, "PORT");
  const port = await winOf(page, "MODEL PORTFOLIO");
  ok("[A] portfolio: hypothetical, MIXED, DRV + SIM rows", port.pill === "MIXED" && /hypothetical/.test(port.text) && /NVDA\s+DRV/.test(port.text) && /LLY\s+SIM/.test(port.text), port.pill);

  const tape = await page.textContent("#tape");
  ok("[A] tape: instruments only, no sample headlines", !/Futures steady|Chipmakers|Treasury yields/.test(tape) && /LIVE/.test(tape));
  ok("[A] tape: live instruments only", !/XOM|CVX|TSLA|LLY/.test(tape));
  const status = await page.textContent("#status");
  ok("[A] status bar: no fake FOMC countdown / breadth", !/FOMC|\/199/.test(status) && !/\/199/.test(await page.textContent("#cmdbar")));
  ok("[A] status bar: US market state from the provider flag", /US MARKET OPEN/.test(status), status);
  ok("[A] status bar: data time from the quote timestamp", /DATA AS OF \d\d:\d\d:\d\d local/.test(status), status);
  ok("[A] currency selector locked to USD (no live FX)", await page.isDisabled("#ccy"));
  const body = await page.evaluate(() => document.body.innerText);
  ok("[A] no NaN / undefined rendered anywhere", !/NaN|undefined/.test(body));
  ok("[A] NO browser request to api.twelvedata.com (or any third-party data host)", !requests.some((u) => /twelvedata\.com|finnhub/.test(u)));
  ok("[A] NO apikey/token in any browser URL", !requests.some((u) => /apikey=|token=/i.test(u)));
  const pageSrc = await page.content();
  ok("[A] no provider host or key parameter in the page source", !/api\.twelvedata\.com|apikey/i.test(pageSrc + provJs));
  ok("[A] no JavaScript errors", errors.length === 0, errors.join(" | "));
  if (SHOTS) { await cmd(page, "TILE"); await page.waitForTimeout(600); await page.screenshot({ path: SHOTS + "/e2e-live-mixed.png" }); }
  await page.close();
}

// =============== B. provider failure: no fake fallback ===============
{
  const api = {
    quote: (syms) => ({ status: 429, body: { quotes: {}, errors: Object.fromEntries(syms.map((s) => [s, { error: "rate_limited", status: "N/A" }])), meta: {} } }),
    history: () => ({ status: 429, body: { error: "rate_limited", status: "N/A" } }),
  };
  const { page, errors } = await openTerminal(api);
  await page.waitForFunction(() => /N\/A/.test(document.querySelector("#dataBadge")?.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const nv = await winOf(page, "NVDA");
  ok("[B] live symbol with failed provider shows — not a seed price", !nv.text.includes(SEED.NVDA) && /\n—\n/.test("\n" + nv.text.split("\n").slice(0, 6).join("\n") + "\n"), nv.text.slice(0, 120));
  ok("[B] failure explained: N/A banner with the reason", /quote unavailable: provider rate limit reached/.test(nv.text) && /NVDA\s+N\/A/.test(nv.text));
  ok("[B] chart: real history unavailable, no simulated substitute", /real history unavailable — provider rate limit reached \(no simulated substitute\)/.test(nv.text), nv.text.match(/real history[^\n]*/)?.[0]);
  const body = await page.evaluate(() => document.body.innerText);
  ok("[B] no seed price of any live symbol anywhere on screen", !Object.values(SEED).some((p) => body.includes(p)), Object.values(SEED).filter((p) => body.includes(p)).join());
  const badge = await page.textContent("#dataBadge");
  ok("[B] badge never claims LIVE: reports N/A and SIM", !/^● LIVE/.test(badge) && /6 N\/A/.test(badge) && /SIM/.test(badge), badge);
  const wl = await winOf(page, "WATCHLIST");
  ok("[B] watchlist: live rows N/A with —, simulated rows still labelled SIM", /AAPL\s+N\/A\s*—/.test(wl.text) && /XOM\s+SIM/.test(wl.text), wl.text.slice(0, 200));
  ok("[B] no NaN rendered", !/NaN/.test(body));
  ok("[B] no JavaScript errors", errors.length === 0, errors.join(" | "));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/e2e-provider-down.png" });
  await page.close();
}

// =============== C. stale data served by the Worker ===============
{
  const api = {
    quote: (syms) => ({ body: { quotes: Object.fromEntries(syms.map((s) => [s, instrument(s, { stale: s === "NVDA" })])), errors: {}, meta: {} } }),
    history: (sym, range) => ({ body: historyBody(sym, range, sym === "NVDA" ? { status: "STALE", staleReason: "provider_timeout" } : {}) }),
  };
  const { page, errors } = await openTerminal(api);
  await page.waitForFunction(() => /STALE/.test(document.querySelector("#dataBadge")?.title || ""), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const nv = await winOf(page, "NVDA");
  ok("[C] stale quote shown with its real value and a STALE label", nv.text.includes("$190.50") && /NVDA\s+STALE/.test(nv.text) && /refresh failed: provider rate limit reached/.test(nv.text));
  ok("[C] stale fields are STALE, not LIVE/PARTIAL", /VOLUME\s*STALE/.test(nv.text) && /PREV CLOSE\s*STALE/.test(nv.text));
  ok("[C] stale history labelled STALE with reason", /STALE\s+daily closes[^\n]*refresh failed: provider timed out/.test(nv.text), nv.text.match(/daily closes[^\n]*/)?.[0]);
  ok("[C] NVDA window pill = STALE", nv.pill === "STALE", nv.pill);
  ok("[C] global badge counts the stale instrument", /1 STALE/.test(await page.textContent("#dataBadge")));
  ok("[C] no JavaScript errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// =============== D. offline "sim" configuration: everything SIMULATED, no network ===============
{
  const simHtml = html.replace('provider:"twelvedata_proxy"', 'provider:"sim"');
  if (simHtml === html) { ok("[D] sim config switch found", false); } else {
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
    const requests = [], errors = [];
    page.on("request", (r) => requests.push(r.url()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/*", (route) => { const u = new URL(route.request().url());
      if (u.pathname === "/terminal/provenance.js") return route.fulfill({ contentType: "application/javascript", body: provJs });
      if (u.pathname.startsWith("/terminal")) return route.fulfill({ contentType: "text/html", body: simHtml });
      return route.abort(); });
    await page.goto(ORIGIN + "/terminal/");
    await page.waitForTimeout(1500);
    const badge = await page.textContent("#dataBadge");
    ok("[D] sim config: badge SIMULATED for all 18 instruments", /^● SIMULATED · 18 SIM/.test(badge), badge);
    ok("[D] sim config: no /api calls at all", !requests.some((u) => u.includes("/api/")));
    ok("[D] sim config: fundamentals still N/A", /MKT CAP\s*N\/A\s*N\/A/.test((await winOf(page, "NVDA")).text));
    ok("[D] sim config: no JavaScript errors", errors.length === 0, errors.join(" | "));
    await page.close();
  }
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
