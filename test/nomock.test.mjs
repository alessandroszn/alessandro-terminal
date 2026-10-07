// T04 — "zero mock data in production": static scan of every file the site ships to the browser.
//   node test/nomock.test.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

const ROOT = new URL("../public/", import.meta.url).pathname;
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(ROOT);
const shipped = Object.fromEntries(files.map((f) => [f.slice(ROOT.length), readFileSync(f, "utf8")]));
const all = Object.values(shipped).join("\n");
const html = shipped["terminal/index.html"];
const script = (html.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || "";

ok("shipped files = the page, its provenance rules, its interface translations and the self-hosted chart library with its license", Object.keys(shipped).sort().join() === "terminal/i18n.js,terminal/index.html,terminal/provenance.js,terminal/vendor/lightweight-charts.LICENSE.txt,terminal/vendor/lightweight-charts.js", Object.keys(shipped).join());
// the chart library draws only what the page gives it: unmodified TradingView Lightweight Charts 5.2.1 (Apache-2.0), no network access
const lwc = shipped["terminal/vendor/lightweight-charts.js"];
ok("chart library = TradingView Lightweight Charts v5.2.1 as published (Apache-2.0), byte for byte", /TradingView Lightweight Charts™ v5\.2\.1/.test(lwc.slice(0, 200)) && createHash("sha256").update(lwc).digest("hex") === "e21cc5caa0226ef30bd8549c50b9ef926615f2a4ee6b4e486353477a55f598cf");
ok("chart library makes no network requests (no fetch / XHR / WebSocket / beacon)", !/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|importScripts/.test(lwc));
ok("the page credits TradingView as the chart library's creator (license attribution)", /TradingView Lightweight Charts™/.test(html) && /https:\/\/www\.tradingview\.com\//.test(html));
ok("translations hold words only: no prices, rates or levels", !/\b\d+\.\d+\b/.test(shipped["terminal/i18n.js"].replace(/\/\*[\s\S]*?\*\//, "")) && !/fetch\(|XMLHttpRequest/.test(shipped["terminal/i18n.js"]));
ok("no random generator (Math.random / seeded PRNG)", !/Math\.random|0x6D2B79F5|function rng\(|function path\(/.test(all));
ok("no simulated/mock/demo/sample/fake/seed wording", !/simulat|\bmock|\bdemo\b|\bsample\b|\bfake\b|\bseed/i.test(all), (all.match(/.{30}(simulat|\bmock|\bdemo\b|\bsample\b|\bfake\b|\bseed).{30}/i) || [])[0]);
const fnBody = (name) => { const i = script.indexOf(`function ${name}(`); return i < 0 ? "" : script.slice(i, script.indexOf("\n  function ", i + 10)); };
ok("no SIMULATED / MIXED status in the rules", !/SIMULATED|MIXED/.test(all));
ok("no static market datasets (indices, yield curve, calendar, news, model portfolio, FX rates)", !/\b(INDICES|CURVE|CAL|NEWS|PORT|CCYRATE|DEFS)\s*=/.test(script));
ok("no windows for removed data (model portfolio)", !/\bPORT:\{tag/.test(script));
// earnings came back with an approved source (Finnhub, through the Worker): only what /api/earnings returns, NO DATA without the key
ok("earnings window renders only /api/earnings data (Finnhub via the Worker), NO DATA without the key", fnBody("renderErn").includes("/api/earnings?") && fnBody("renderErn").includes("finnhub_not_configured") && !/\d+\.\d+/.test(fnBody("renderErn").replace(/toFixed\(\d\)/g, "")));
ok("function-menu sections read only the Worker (/api/*), never a provider", ["renderCb:/api/cb", "renderSprd:/api/sprd", "renderCmdty:/api/energy", "renderFcrv:/api/energy", "renderDes:/api/des", "renderOmon:/api/options/", "renderSys:/api/status"].every((x) => { const [f, k] = x.split(":"); return fnBody(f).includes(k); }));
ok("the owner's portfolio starts empty: no preloaded holdings in the page, loaded from /api/portfolio", /const PF=\{data:null/.test(script) && /'\/api\/portfolio'/.test(script) && !/\b(HOLDINGS|POSITIONS|MODEL_PF)\s*=\s*\[/.test(script));
// indices came with approved sources (7 Oct 2026: Cboe delayed quotes, STOXX, Nikkei, FRED — all through the Worker)
ok("indices window renders only /api/indices data, with no numbers of its own", fnBody("renderIndices").length > 0 && /\/api\/indices\?g=/.test(script) && /\/api\/indices\/history\?id=/.test(script) && !/\d+\.\d+/.test(fnBody("renderIndices").replace(/toFixed\(\d\)/g, "")) && !/cboe\.com\/api|stoxx\.com\/document|nikkei_stock_average/.test(all));
ok("yields / calendar / news render only data fetched from /api", ["renderYields:yields", "renderCal:calendar", "renderNews:news"].every((x) => { const [f, k] = x.split(":"); return fnBody(f).includes(`EXT.${k}`) && fnBody(f).includes(`loadExt('${k}')`); }));
ok("briefing renders only editions fetched from /api/briefs (written by the Worker from real data)", fnBody("renderBriefing").includes("BRF.items") && fnBody("brfIndex").includes("/api/briefs?period=") && fnBody("brfItem").includes("/api/briefs/item") && !/Math\.random/.test(fnBody("renderBriefing")));
ok("S&P 500 map renders only data fetched from /api/spx", fnBody("spxEnsure").includes("/api/spx/universe") && fnBody("spxRows").includes("SPX.u"));
const OLD_SEEDS = ["182.40", "247.15", "441.80", "221.60", "198.25", "612.90", "258.70", "598.40", "117.85", "162.30", "892.10", "548.60", "389.20", "965.40", "412.75", "182.95", "232.80", "318.05", "5870.2", "20915.6", "4.42", "138.20", "402.50"];
ok("none of the former seed prices, index levels, yields or cost bases", !OLD_SEEDS.some((v) => all.includes(v)), OLD_SEEDS.filter((v) => all.includes(v)).join());
const REMOVED = ["META", "GS", "XOM", "CVX", "LLY", "UNH", "TSLA", "COST", "CAT", "BA", "AVGO"];
ok("none of the 12 formerly simulated tickers", !REMOVED.some((s) => new RegExp(`["'\\b]${s}["'\\b]`).test(script)), REMOVED.filter((s) => new RegExp(`["'\\b]${s}["'\\b]`).test(script)).join());
const wl = JSON.parse((script.match(/DEFAULT_WATCHLIST=(\[[^\]]*\])/) || [])[1] || "[]");
ok("instruments = default watchlist + verified markets board (+ BTC/ETH for the briefing), nothing else", wl.join() === "NVDA,AAPL,MSFT,AMZN,GOOGL,JPM" && /UNI=WATCH\.map\(inst\)/.test(script) && /MARKET_GROUPS=\[\["FX",\["EUR\/USD","GBP\/USD","USD\/JPY"\]\],\["METALS",\["XAU\/USD"\]\]\]/.test(script) && /BRIEF_SYMS=MARKET_SYMS\.concat\(\["BTC\/USD","ETH\/USD"\]\)/.test(script), wl.join());
ok("no currency conversion (no live FX source)", !/id="ccy"|CCYRATE|fx\(/.test(html));
ok("no hand-written company descriptions", !/\bDES\b —|desc:/.test(html));
ok("no currency symbol on FX / crypto / metal rates (no conversion invented)", /function pxText\(t,v\)\{[^}]*includes\('\/'\)/.test(script));
const literals = (script.match(/[^\w#.]\d+\.\d+/g) || []).map((x) => x.slice(1));
ok("only drawing constants as decimal literals (no hard-coded market numbers)", literals.every((v) => Number(v) < 3), literals.filter((v) => Number(v) >= 3).join());
// ---- server side: the Worker and its source modules (tests may use mocks; production code may not) ----
const SRC = new URL("../src/", import.meta.url).pathname;
const srcFiles = Object.fromEntries(readdirSync(SRC).filter((f) => f.endsWith(".mjs")).map((f) => [f, readFileSync(join(SRC, f), "utf8")]));
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1"); // without comments
// allowed non-data literals: the maturity table (tenor names / months) and version strings like "/1.0"
const codeNoDefs = (t) => code(t).replace(/export const TREASURY_TENORS = \[[\s\S]*?\];/, "");
const decimalLits = (t) => (codeNoDefs(t).match(/[^\w#.\-\/]\d+\.\d+(?![\w.])/g) || []).filter((x) => Number(x.slice(1)) >= 1);
ok("Worker: no random generator", !Object.values(srcFiles).some((t) => /Math\.random|crypto\.getRandomValues/.test(code(t))));
ok("Worker: no mock / fake / demo / sample / placeholder / simulated values", !Object.entries(srcFiles).some(([f, t]) => /\bmock|\bfake|\bdemo\b|\bsample\b|placeholder|simulat/i.test(code(t))), Object.entries(srcFiles).filter(([f, t]) => /\bmock|\bfake|\bdemo\b|\bsample\b|placeholder|simulat/i.test(code(t))).map(([f]) => f).join());
ok("Worker: no hard-coded prices, yields or levels (decimal literals ≥ 1)", !Object.values(srcFiles).some((t) => decimalLits(t).length), Object.entries(srcFiles).map(([f, t]) => [f, decimalLits(t)]).filter(([, a]) => a.length).map(([f, a]) => f + ":" + a.join("|")).join(" "));
ok("Worker: every new section only reads approved sources", /home\.treasury\.gov/.test(srcFiles["yields.mjs"]) && /data-api\.ecb\.europa\.eu/.test(srcFiles["yields.mjs"]) && /bls\.gov/.test(srcFiles["calendar.mjs"]) && /bea\.gov/.test(srcFiles["calendar.mjs"]) && /feeds\.content\.dowjones\.io/.test(srcFiles["press.mjs"]) && /federalreserve\.gov/.test(srcFiles["press.mjs"]) && /sec\.gov/.test(srcFiles["news.mjs"]) && /env\.AI\.run/.test(srcFiles["briefing.mjs"]) && /ishares\.com/.test(srcFiles["spx.mjs"]) && /data\.alpaca\.markets/.test(srcFiles["spx.mjs"]) && /www\.ft\.com/.test(srcFiles["press.mjs"]) && /feeds\.bloomberg\.com/.test(srcFiles["press.mjs"]));
ok("Worker indices: only Cboe delayed quotes, STOXX and Nikkei publications and FRED; the not-connected ones named", /cdn-api\.cboe\.com\/api\/global\/delayed_quotes/.test(srcFiles["indices.mjs"]) && /www\.stoxx\.com\/document\/Indices/.test(srcFiles["indices.mjs"]) && /indexes\.nikkei\.co\.jp/.test(srcFiles["indices.mjs"]) && /fredSeries/.test(srcFiles["indices.mjs"]) && /"FTSE MIB"/.test(srcFiles["indices.mjs"]));
ok("Worker portfolio: transactions only from storage (KV), nothing hard-coded", /env\.BRIEFS\.get\(KEY\)/.test(srcFiles["portfolio.mjs"]) && !/\btxs?\s*=\s*\[\s*\{/.test(srcFiles["portfolio.mjs"]));
ok("no direct provider calls or keys in the client", !/api\.twelvedata\.com|finnhub\.io\/api|api\.eia\.gov|data\.alpaca\.markets|apikey|api_key|token=|X-Finnhub-Token/i.test(all), (all.match(/.{20}(api\.twelvedata\.com|finnhub\.io\/api|api\.eia\.gov|data\.alpaca\.markets|apikey|api_key|token=|X-Finnhub-Token).{20}/i) || [])[0]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
