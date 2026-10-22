// Portfolio lab (PLAB): the owner's saved portfolios (/api/user/plab), one instrument's daily closes in EUR
// (/api/plab/series: CNBC bars + FX, justETF line), and the math in qmath.js — backtest with rebalancing, monthly
// contributions and costs, money- and time-weighted returns, statistics, risk, stress windows, projection.
// Checked against closed forms and hand-computed cases. Fixtures in the providers' formats (test inputs only).
//   node test/plab.test.mjs
import { createRequire } from "node:module";
import { app as worker } from "../src/worker.mjs";
import { handlePlab, toEur, tableLineOf } from "../src/plab.mjs";
import { validatePlab } from "../src/userdata.mjs";
const require = createRequire(import.meta.url);
const Q = require("../public/terminal/qmath.js");

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- saved portfolios ----------
const kv = new Map();
const env = { ALLOWED_ORIGIN: "https://x.test", BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const call = async (method, path, body) => { const r = await worker.fetch(new Request("https://x.test" + path, { method, headers: body ? { "content-type": "application/json", origin: "https://x.test" } : { origin: "https://x.test" }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} }); return { st: r.status, b: await r.json() }; };
let r = await call("GET", "/api/user/plab");
ok("starts empty", r.st === 200 && Array.isArray(r.b.plab) && r.b.plab.length === 0);
r = await call("POST", "/api/user/plab", { name: "Core 80/20", holdings: [{ id: "IE00B4L5Y983", w: 80 }, { id: "cash", w: 20 }], settings: { reb: "Y" } });
const id1 = r.b.saved;
ok("save: 201, id, holdings upper-cased, settings kept", r.st === 201 && id1 && r.b.plab[0].holdings[1].id === "CASH" && r.b.plab[0].settings.reb === "Y" && r.b.plab[0].saved);
r = await call("POST", "/api/user/plab", { id: id1, name: "Core 70/30", holdings: [{ id: "IE00B4L5Y983", w: 70 }, { id: "C:EUNH-DE", w: 30 }] });
ok("save with its id → replaced (200), still one portfolio", r.st === 200 && r.b.replaced && r.b.plab.length === 1 && r.b.plab[0].name === "Core 70/30");
r = await call("POST", "/api/user/plab", { name: "Bad", holdings: [{ id: "IE00B4L5Y983", w: 70 }, { id: "SPY", w: 20 }] });
ok("weights not adding up to 100 → 400 with the sum", r.st === 400 && /90\.00 %/.test(r.b.message), JSON.stringify(r.b));
ok("validation: a name, 1–15 holdings, no duplicates, weights above 0", typeof validatePlab({ holdings: [{ id: "SPY", w: 100 }] }) === "string" && /twice/.test(validatePlab({ name: "x", holdings: [{ id: "SPY", w: 50 }, { id: "spy", w: 50 }] })) && /above 0/.test(validatePlab({ name: "x", holdings: [{ id: "SPY", w: 0 }, { id: "QQQ", w: 100 }] })) && /at most 15/.test(validatePlab({ name: "x", holdings: Array.from({ length: 16 }, (_, i) => ({ id: "A" + i, w: 6.25 })) })) && /bad instrument/.test(validatePlab({ name: "x", holdings: [{ id: "BTC/USD", w: 100 }] })));
r = await call("DELETE", "/api/user/plab?id=" + id1);
ok("delete → gone", r.st === 200 && r.b.plab.length === 0);

// ---------- one instrument's daily closes in EUR ----------
const json = (b, H, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
const D = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"];
const BARS = { "XMIL-IT": D.map((d, i) => [d, 50 + i]), "EUNL-DE": D.map((d, i) => [d, 100 + i]), "IWDA-GB": D.map((d, i) => [d, 110 + i]), "SWDA-GB": D.map((d, i) => [d, 9000 + 10 * i]), "NOVN-CH": D.map((d, i) => [d, 80 + i]), NVDA: D.map((d, i) => [d, 180 + i]),
  "EUR=": D.map((d, i) => [d, 1.1 + i / 100]), "GBP=": D.map((d, i) => [d, 1.3]), "CHF=": D.map((d, i) => [d, 0.8]) };
const QS = { "XMIL-IT": "EUR", "NOVN-CH": "CHF", NVDA: "USD", "SSAC-NL": "USD", "ZZZ-DE": "EUR" };
const deps = { now: Date.parse("2026-10-20T10:00:00Z"), loadQuotes: async (codes) => ({ data: Object.fromEntries(codes.map((c) => [c, { symbol: c, code: 0, currencyCode: QS[c], name: c === "NVDA" ? "NVIDIA Corp" : c, countryCode: c === "SSAC-NL" || c === "NVDA" ? "US" : "CH" }])) }),
  fundLines: async (url, env, ctx, isin) => (isin === "IE00BL25JP72" ? { lines: [{ cnbc: "XMIL-IT", ccy: "EUR", pence: false, venue: "Borsa Italiana", ticker: "XMIL", name: "A fund listed in Milan" }] } : { lines: [] }),
  daily: async (c) => (BARS[c] ? { data: BARS[c], cache: "HIT", fetchedAt: deps.now } : { err: "no_data" }), rows: async () => ({ data: [] }), table: "" };
const series = async (id) => { const [i, q] = id.split("&"); const res = await handlePlab(new URL("https://x.test/api/plab/series?id=" + encodeURIComponent(i) + (q ? "&" + q : "")), env, {}, {}, json, deps); return { st: res.status, b: await res.json() }; };
kv.set("ref/je/table", ["IE00BK5BQT80\t0.19\t55100\tEUR\tA\tP\tSampling\tIreland\tUSD\t0\tVanguard\tEquity, World\tETF\t23 July 2019\tVanguard FTSE All-World\t2026-10-20", "IE00B4L5Y983\t0.2\t131754\tEUR\tA\tP\tOptimized sampling\tIreland\tUSD\t0\tiShares\tEquity, World\tETF\t25 September 2009\tiShares Core MSCI World UCITS ETF USD (Acc)\t2026-10-20"].join("\n"));
r = await series("C:EUNL-DE");
ok("a EUR listing: its closes as they are, the fund's ISIN and justETF line (TER, Acc)", r.st === 200 && r.b.ccy === "EUR" && !r.b.conv && r.b.v.join() === "100,101,102,103" && r.b.isin === "IE00B4L5Y983" && r.b.ref.ter === 0.2 && r.b.ref.distribution === "Accumulating" && r.b.first === "2026-10-14", JSON.stringify(r.b).slice(0, 400));
r = await series("IE00B4L5Y983");
ok("an ISIN of the UCITS list in EUR → its own EUR line, no conversion", r.st === 200 && r.b.cnbc === "EUNL-DE" && !r.b.conv && r.b.v.join() === "100,101,102,103", JSON.stringify(r.b).slice(0, 200));
r = await series("IE00B4L5Y983&ccy=USD");
ok("…in USD → its USD line (London), no conversion", r.st === 200 && r.b.cnbc === "IWDA-GB" && !r.b.conv && r.b.v[0] === 110 && r.b.to === "USD");
r = await series("IE00B4L5Y983&ccy=GBP");
ok("…in GBP → its GBp line ÷ 100", r.st === 200 && r.b.cnbc === "SWDA-GB" && r.b.v[0] === 90);
r = await series("IE00B4L5Y983&ccy=CHF");
ok("…in CHF (no CHF line) → the USD line converted: USD → CHF at CHF= (CHF per USD)", r.st === 200 && r.b.cnbc === "IWDA-GB" && r.b.conv.to === "CHF" && near(r.b.v[0], 110 * 0.8, 1e-4), JSON.stringify(r.b.v));
r = await series("IE00B4L5Y983&ccy=JPY");
ok("…a currency not offered → 400", r.st === 400);
r = await series("IE00BL25JP72");
ok("an ISIN on neither list: its listing through the ISIN search (here Milan), flagged off-list", r.st === 200 && r.b.cnbc === "XMIL-IT" && r.b.offList && r.b.v[0] === 50 && r.b.name === "A fund listed in Milan", JSON.stringify(r.b).slice(0, 300));
r = await series("US0378331005");
ok("…found nowhere → not listed", r.st === 404 && r.b.error === "not_listed");
r = await series("C:NVDA");
ok("a plain CNBC code without a known line → USD from the quote, converted to EUR", r.st === 200 && near(r.b.v[0], 180 / 1.1, 1e-4));
r = await series("C:NOVN-CH");
ok("a CHF listing: CHF= is CHF per USD, then USD → EUR", r.st === 200 && r.b.ccy === "CHF" && near(r.b.v[0], (80 / 0.8) / 1.1, 1e-4), JSON.stringify(r.b.v));
r = await series("NVDA");
ok("a U.S. symbol: USD from CNBC's quote, converted", r.st === 200 && r.b.ccy === "USD" && r.b.us && r.b.name === "NVIDIA Corp" && near(r.b.v[2], 182 / 1.12, 1e-4));
ok("GBp lines ÷ 100, GBP → USD → EUR", near(toEur([["2026-10-14", 9000]], "GBP", true, { "EUR=": [["2026-10-14", 1.1]], "GBP=": [["2026-10-14", 1.3]] })[0][1], 90 * 1.3 / 1.1, 1e-9));
r = await series("C:SSAC-NL");
ok("a venue code CNBC answers from the U.S. → not carried", r.st === 404 && r.b.error === "not_carried");
r = await series("BTC/USD");
ok("a pair → 400; an unknown listing → its error", r.st === 400 && (await series("C:ZZZ-DE")).b.error === "no_data");
ok("one fund's line out of the table without splitting it", tableLineOf(kv.get("ref/je/table"), "IE00B4L5Y983")[10] === "iShares" && tableLineOf(kv.get("ref/je/table"), "IE00XXXXXXXX") === null);

// ---------- backtest ----------
const days = (n, start = "2024-01-02") => { const out = []; let t = Date.parse(start + "T12:00:00Z"); while (out.length < n) { const d = new Date(t), g = d.getUTCDay(); if (g && g < 6) out.push(d.toISOString().slice(0, 10)); t += 86400000; } return out; };
const dts = days(300), pA = dts.map((_, i) => 100 * Math.exp(i * 0.001 + Math.sin(i / 10) * 0.05)), pB = dts.map((_, i) => 50 * Math.exp(-i * 0.0005 + Math.cos(i / 7) * 0.03));
let bt = Q.backtest({ dates: dts, prices: [pA], weights: [1], initial: 1000 });
ok("one asset, no flows: value = initial × price ratio; the index = price / first price", near(bt.final, 1000 * pA[299] / pA[0], 1e-6) && near(bt.idx[150], pA[150] / pA[0], 1e-12) && bt.trades === 1);
bt = Q.backtest({ dates: dts, prices: [pA], weights: [1], initial: 1000, monthly: 100 });
const nm = new Set(dts.map((d) => d.slice(0, 7))).size - 1;
ok("monthly contributions: put in = initial + 100 × each new month; the time-weighted index unchanged by the flows", near(bt.put, 1000 + 100 * nm, 1e-9) && near(bt.idx[299], pA[299] / pA[0], 1e-9) && bt.trades === 1 + nm, `${bt.put} ${nm} ${bt.idx[299]} ${pA[299] / pA[0]}`);
const bh = Q.backtest({ dates: dts, prices: [pA, pB], weights: [0.5, 0.5], initial: 1000 }), by = Q.backtest({ dates: dts, prices: [pA, pB], weights: [0.5, 0.5], initial: 1000, rebalance: "M" });
ok("two assets, no rebalancing: each leg grows on its own", near(bh.final, 500 * pA[299] / pA[0] + 500 * pB[299] / pB[0], 1e-6));
// hand check of the monthly rebalance: back to 50/50 on the first day of each month
let v = 1000, uA = 500 / pA[0], uB = 500 / pB[0]; for (let t = 1; t < 300; t++) if (dts[t].slice(0, 7) !== dts[t - 1].slice(0, 7)) { v = uA * pA[t] + uB * pB[t]; uA = v / 2 / pA[t]; uB = v / 2 / pB[t]; }
ok("monthly rebalancing: the hand-computed value; trades counted (2 a month)", near(by.final, uA * pA[299] + uB * pB[299], 1e-6) && by.trades === 2 + 2 * nm, `${by.final} ${uA * pA[299] + uB * pB[299]} ${by.trades}`);
const bc = Q.backtest({ dates: dts, prices: [pA, dts.map(() => 1)], weights: [0.6, 0.4], noTrade: [false, true], initial: 1000, cost: 1 });
ok("cash at price 1 is not a trade; a cost per trade comes off the money invested", bc.trades === 1 && bc.costs === 1 && near(bc.final, 999 * 0.6 * pA[299] / pA[0] + 999 * 0.4, 1e-6));
ok("money-weighted return: −100 now, +110 in a year → 10 %", near(Q.xirr([{ t: 0, a: -100 }, { t: 365.25 * 86400000, a: 110 }]), 0.1, 1e-6));
const fl = Q.btFlows(Q.backtest({ dates: dts, prices: [dts.map(() => 1)], weights: [1], initial: 1000, monthly: 100 }));
ok("…a flat price with contributions → 0 %", near(Q.xirr(fl), 0, 1e-6) && fl.length === nm + 2);
// statistics
const two = ["2024-01-02", "2025-01-01", "2026-01-01"], ps = Q.perfStats(two, [1, 1.5, 2]);
ok("CAGR: ×2 over two years → 41.4 %", near(ps.cagr, Math.SQRT2 - 1, 2e-3) && near(ps.total, 1, 1e-12));
const ddI = [1, 1.2, 0.9, 1.0, 1.25, 1.1], ddD = days(6), dds = Q.perfStats(ddD, ddI);
ok("max drawdown −25 % from the peak to the trough, recovered when the peak is passed", near(dds.maxDD, -0.25, 1e-12) && dds.ddPeak === ddD[1] && dds.ddTrough === ddD[2] && dds.ddRecovered === ddD[4]);
const st = Q.perfStats(dts, bh.idx);
ok("years and months from the month-ends; a year started on 2 January is whole, the unfinished last one partial", st.years.length === 2 && st.years[0].y === "2024" && st.months.length >= 12 && st.months.every((m) => Number.isFinite(m.r)) && st.years[0].partial === false && st.years[1].partial === true && fin2(st.vol), JSON.stringify(st.years));
function fin2(x) { return Number.isFinite(x) && x > 0; }
// risk
const rk = Q.portfolioRisk({ prices: [pA, pB], weights: [0.7, 0.3], bench: pA, win: 250 });
ok("risk: each asset's share of the volatility adds up to 1; correlation matrix diagonal 1; diversification ≥ 1", near(rk.rc[0] + rk.rc[1], 1, 1e-9) && near(rk.corr[0][0], 1, 1e-9) && rk.divRatio >= 1 - 1e-9 && rk.var99 >= rk.var95 && rk.es95 >= rk.var95);
const r1 = Q.portfolioRisk({ prices: [pA, pB], weights: [1, 0], bench: pA, win: 250 });
ok("…all in one asset: its own volatility, beta 1 against itself", near(r1.vol, r1.vols[0], 1e-9) && near(r1.beta, 1, 1e-9));
// stress windows
const sA = { d: dts, v: pA }, sB = { d: dts.slice(100), v: pB.slice(100) };
const sw = Q.stressWindow([sA, null], [0.5, 0.5], dts[10], dts[50]);
ok("stress window: weighted returns from the value on or before each date; cash 0", near(sw.r, 0.5 * (pA[50] / pA[10] - 1), 1e-12));
ok("…an asset without data at the start → N/A, the asset named", Q.stressWindow([sA, sB], [0.5, 0.5], dts[10], dts[50]).na === true && Q.stressWindow([sA, sB], [0.5, 0.5], dts[10], dts[50]).missing[0] === 1);
// projection
const flat = new Array(36).fill(0.01), pg = Q.projectGoal({ monthlyR: flat, months: 12, start: 1000, monthly: 100, paths: 500, run: 3, target: 2300 });
let cf = 1000; for (let m = 0; m < 12; m++) cf = cf * 1.01 + 100;
ok("projection: constant past returns → the closed form; all paths alike", near(pg.median, cf, 1e-6) && near(pg.p5, cf, 1e-6) && pg.put === 2200 && pg.pTarget === (cf >= 2300 ? 1 : 0) && pg.pBelowPut === 0, `${pg.median} ${cf}`);
const vr = Array.from({ length: 60 }, (_, i) => Math.sin(i * 1.7) * 0.04 + 0.005), g1 = Q.projectGoal({ monthlyR: vr, months: 120, start: 10000, monthly: 200, paths: 2000, run: 1 }), g1b = Q.projectGoal({ monthlyR: vr, months: 120, start: 10000, monthly: 200, paths: 2000, run: 1 }), g2 = Q.projectGoal({ monthlyR: vr, months: 120, start: 10000, monthly: 200, paths: 2000, run: 2 });
ok("…numbered runs: the same run gives the same result, another run another draw; bands ordered", g1.median === g1b.median && g1.median !== g2.median && g1.bands.every((b) => b[0] <= b[1] && b[1] <= b[2] && b[2] <= b[3] && b[3] <= b[4]) && g1.cps.length === 120);
ok("…fewer than 24 past months → null (no projection from too little)", Q.projectGoal({ monthlyR: new Array(20).fill(0.01), months: 12, start: 1000 }) === null);
// alignment
const al = Q.alignDV([{ d: ["a", "b", "c"], v: [1, 2, 3] }, { d: ["b", "c", "d"], v: [5, 6, 7] }]);
ok("alignment: only the dates every series has", al.dates.join() === "b,c" && al.vals[1].join() === "5,6" && Q.valueAt({ d: ["2026-01-02", "2026-01-05"], v: [1, 2] }, "2026-01-04").v === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
