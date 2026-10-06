// T04 — "zero mock data in production": static scan of every file the site ships to the browser.
//   node test/nomock.test.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

const ROOT = new URL("../public/", import.meta.url).pathname;
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(ROOT);
const shipped = Object.fromEntries(files.map((f) => [f.slice(ROOT.length), readFileSync(f, "utf8")]));
const all = Object.values(shipped).join("\n");
const html = shipped["terminal/index.html"];
const script = (html.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || "";

ok("shipped files = the page and its provenance rules only", Object.keys(shipped).sort().join() === "terminal/index.html,terminal/provenance.js", Object.keys(shipped).join());
ok("no random generator (Math.random / seeded PRNG)", !/Math\.random|0x6D2B79F5|function rng\(|function path\(/.test(all));
ok("no simulated/mock/demo/sample/fake/seed wording", !/simulat|\bmock|\bdemo\b|\bsample\b|\bfake\b|\bseed/i.test(all), (all.match(/.{30}(simulat|\bmock|\bdemo\b|\bsample\b|\bfake\b|\bseed).{30}/i) || [])[0]);
ok("no SIMULATED / MIXED status in the rules", !/SIMULATED|MIXED/.test(all));
ok("no static market datasets (indices, yield curve, calendar, news, model portfolio, FX rates)", !/\b(INDICES|CURVE|CAL|NEWS|PORT|CCYRATE|DEFS)\s*=/.test(script));
ok("no windows for removed data (earnings, model portfolio)", !/\b(ERN|PORT):\{tag/.test(script) && !/'(EARNINGS|PORTFOLIO)'/.test(script));
const fnBody = (name) => { const i = script.indexOf(`function ${name}(`); return i < 0 ? "" : script.slice(i, script.indexOf("\n  function ", i + 10)); };
ok("indices section renders no numbers (NO DATA until a licensed source exists)", fnBody("renderIndices").length > 0 && !/>\s*-?\d+\.\d+\s*</.test(fnBody("renderIndices")) && /NO DATA/.test(fnBody("renderIndices")));
ok("yields / calendar / news / briefing render only data fetched from /api", ["renderYields:yields", "renderCal:calendar", "renderNews:news", "renderBriefing:briefing"].every((x) => { const [f, k] = x.split(":"); return fnBody(f).includes(`EXT.${k}`) && fnBody(f).includes(`loadExt('${k}')`); }));
const OLD_SEEDS = ["182.40", "247.15", "441.80", "221.60", "198.25", "612.90", "258.70", "598.40", "117.85", "162.30", "892.10", "548.60", "389.20", "965.40", "412.75", "182.95", "232.80", "318.05", "5870.2", "20915.6", "4.42", "138.20", "402.50"];
ok("none of the former seed prices, index levels, yields or cost bases", !OLD_SEEDS.some((v) => all.includes(v)), OLD_SEEDS.filter((v) => all.includes(v)).join());
const REMOVED = ["META", "GS", "XOM", "CVX", "LLY", "UNH", "TSLA", "COST", "CAT", "BA", "AVGO"];
ok("none of the 12 formerly simulated tickers", !REMOVED.some((s) => new RegExp(`["'\\b]${s}["'\\b]`).test(script)), REMOVED.filter((s) => new RegExp(`["'\\b]${s}["'\\b]`).test(script)).join());
const wl = JSON.parse((script.match(/DEFAULT_WATCHLIST=(\[[^\]]*\])/) || [])[1] || "[]");
ok("instruments = default watchlist + verified markets board, nothing else", wl.join() === "NVDA,AAPL,MSFT,AMZN,GOOGL,JPM" && /UNI=WATCH\.map\(inst\)/.test(script) && /MARKET_GROUPS=\[\["FX",\["EUR\/USD","GBP\/USD","USD\/JPY"\]\],\["CRYPTO",\["BTC\/USD","ETH\/USD"\]\],\["METALS",\["XAU\/USD"\]\]\]/.test(script), wl.join());
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
ok("Worker: every new section only reads approved sources", /home\.treasury\.gov/.test(srcFiles["yields.mjs"]) && /data-api\.ecb\.europa\.eu/.test(srcFiles["yields.mjs"]) && /bls\.gov/.test(srcFiles["calendar.mjs"]) && /bea\.gov/.test(srcFiles["calendar.mjs"]) && /gdeltproject\.org/.test(srcFiles["news.mjs"]) && /sec\.gov/.test(srcFiles["news.mjs"]) && /env\.AI\.run/.test(srcFiles["briefing.mjs"]));
ok("no direct provider calls or keys in the client", !/api\.twelvedata\.com|finnhub|apikey|token=/i.test(all));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
