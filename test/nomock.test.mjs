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
ok("no windows for data without a real source (IDX, CURV, CAL, N, ERN, PORT)", !/\b(IDX|CURV|CAL|ERN|PORT|NEWS):\{tag/.test(script) && !/'(INDICES|YIELDS|CALENDAR|EARNINGS|NEWS|PORTFOLIO)'/.test(script));
const OLD_SEEDS = ["182.40", "247.15", "441.80", "221.60", "198.25", "612.90", "258.70", "598.40", "117.85", "162.30", "892.10", "548.60", "389.20", "965.40", "412.75", "182.95", "232.80", "318.05", "5870.2", "20915.6", "4.42", "138.20", "402.50"];
ok("none of the former seed prices, index levels, yields or cost bases", !OLD_SEEDS.some((v) => all.includes(v)), OLD_SEEDS.filter((v) => all.includes(v)).join());
const REMOVED = ["META", "GS", "XOM", "CVX", "LLY", "UNH", "TSLA", "COST", "CAT", "BA", "AVGO"];
ok("none of the 12 formerly simulated tickers", !REMOVED.some((s) => new RegExp(`["'\\b]${s}["'\\b]`).test(script)), REMOVED.filter((s) => new RegExp(`["'\\b]${s}["'\\b]`).test(script)).join());
const live = JSON.parse((script.match(/liveSymbols:(\[[^\]]*\])/) || [])[1] || "[]");
ok("universe = the live provider symbols only", live.join() === "NVDA,AAPL,MSFT,AMZN,GOOGL,JPM" && /const UNI=CONFIG\.liveSymbols\.map/.test(script), live.join());
ok("no currency conversion (no live FX source)", !/id="ccy"|CCYRATE|fx\(/.test(html));
ok("no hand-written company descriptions", !/\bDES\b —|desc:/.test(html));
const literals = (script.match(/[^\w#.]\d+\.\d+/g) || []).map((x) => x.slice(1));
ok("only drawing constants as decimal literals (no hard-coded market numbers)", literals.every((v) => Number(v) < 3), literals.filter((v) => Number(v) >= 3).join());
ok("no direct provider calls or keys in the client", !/api\.twelvedata\.com|finnhub|apikey|token=/i.test(all));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
