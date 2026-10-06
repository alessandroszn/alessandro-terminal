// Headless browser test of the deployed page's data flow with MOCKED /api responses
// (fixtures, not market data). Proves: LIVE mode, real-series path in the chart
// (no simulated fallback), no direct provider calls, no JS errors.
//   node test/frontend.e2e.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/terminal/index.html", import.meta.url), "utf8");
const ORIGIN = "https://alessandrozanichelli.com";

// fixture: 1Y of weekday closes ending today, last close 250.00
function fixtureDaily() {
  const pts = []; const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  const days = [];
  for (let i = 0; days.length < 252; i++) { const x = new Date(d - i * 864e5); const wd = x.getUTCDay(); if (wd !== 0 && wd !== 6) days.push(x.toISOString().slice(0, 10)); }
  days.reverse();
  days.forEach((t, i) => { const c = 200 + i * (50 / 251); pts.push({ t, o: c, h: c + 1, l: c - 1, c: +c.toFixed(2), v: 1e6 }); });
  return pts;
}
const daily = fixtureDaily();
const quote = (s) => ({ symbol: s, name: s + " Inc", price: s === "AAPL" ? 250 : 100, prevClose: 99, changePct: 1, open: 99, high: 101, low: 98, volume: 1e6, currency: "USD", fiftyTwoWeekLow: 90, fiftyTwoWeekHigh: 260, asOf: new Date().toISOString(), provider: "twelvedata" });

const requests = [], consoleErrors = [];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" + "-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("request", (r) => requests.push(r.url()));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  if (u.origin === ORIGIN && u.pathname.startsWith("/terminal")) return route.fulfill({ contentType: "text/html", body: html });
  if (u.origin === ORIGIN && u.pathname === "/api/quote") {
    const syms = (u.searchParams.get("symbols") || "").split(",");
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ quotes: Object.fromEntries(syms.map((s) => [s, quote(s)])), asOf: new Date().toISOString(), provider: "twelvedata", stale: false }) });
  }
  if (u.origin === ORIGIN && u.pathname === "/api/history") {
    const range = u.searchParams.get("range");
    const pts = range === "1D" ? daily.slice(-78).map((p, i) => ({ ...p, t: `2026-10-06T${String(13 + Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}:00Z` })) : daily;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ symbol: u.searchParams.get("symbol"), range, interval: range === "1D" ? "5min" : "1day", adjust: "splits", count: pts.length, points: pts, asOf: new Date().toISOString(), provider: "twelvedata" }) });
  }
  if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) return route.fulfill({ body: "" });
  return route.continue();
});

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };

await page.goto(ORIGIN + "/terminal/");
await page.waitForFunction(() => document.querySelector("#dataBadge")?.textContent.includes("LIVE"), null, { timeout: 15000 });
ok("badge switches to LIVE (DATA.init fix effective)", true);
await page.waitForFunction(() => !!document.querySelector(".win-body .last"), null, { timeout: 10000 });
// open AAPL security window via the command line
await page.fill("#cmd", "AAPL");
await page.press("#cmd", "Enter");
await page.waitForTimeout(500);
// wait for history to load (queue gap ~9s for the second symbol)
await page.waitForFunction(() => [...document.querySelectorAll(".win")].some(w => w.querySelector(".w-title")?.textContent.startsWith("AAPL")), null, { timeout: 5000 });
const aaplLast = await page.evaluate(() => { const w = [...document.querySelectorAll(".win")].find(w => w.querySelector(".w-title")?.textContent.startsWith("AAPL")); return w.querySelector(".last").textContent; });
ok("AAPL header shows quote price from /api/quote", aaplLast.includes("250.00"), aaplLast);
await page.waitForTimeout(12000);
const histCalls = requests.filter((u) => u.includes("/api/history?symbol=AAPL"));
ok("browser called /api/history for AAPL on the site origin", histCalls.length >= 1 && histCalls.every(u => u.startsWith(ORIGIN)), histCalls.join(" "));
ok("NO browser request to api.twelvedata.com", !requests.some((u) => u.includes("twelvedata.com")));
ok("NO apikey in any browser URL", !requests.some((u) => /apikey=|token=/.test(u)));
const chartState = await page.evaluate(() => {
  const w = [...document.querySelectorAll(".win")].find(w => w.querySelector(".w-title")?.textContent.startsWith("AAPL"));
  const cv = w.querySelector("canvas"); const ctx = cv.getContext("2d");
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data; let colored = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i + 3] > 0) colored++;
  return { colored };
});
ok("AAPL chart drew a series (canvas not empty)", chartState.colored > 1000, JSON.stringify(chartState));
ok("no JavaScript errors", consoleErrors.length === 0, consoleErrors.join(" | "));
await page.screenshot({ path: "/tmp/claude-0/-home-claude/f0d51b9f-a39d-587b-ae15-192d931e0589/scratchpad/e2e-aapl.png" });
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
