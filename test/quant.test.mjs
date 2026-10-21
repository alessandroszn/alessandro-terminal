// Quant library (public/terminal/quant.js): checked against closed-form values and against processes whose
// parameters are known (generated here with a numbered generator — test inputs only, never shown in the terminal).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Q = require("../public/terminal/quant.js");

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rng = Q.mulberry32(42);
const gauss = () => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };

// ---------- distributions ----------
ok("normInv / normCdf: 97.5 % → 1.95996; Φ(1.96) = 0.97500; Φ⁻¹(0.01) = −2.32635", near(Q.normInv(0.975), 1.959964, 1e-5) && near(Q.normCdf(1.96), 0.9750021, 1e-6) && near(Q.normInv(0.01), -2.326348, 1e-5));
ok("χ² survival: χ²₂(5.991) = 0.05, χ²₁(3.841) = 0.05, χ²₁₀(18.307) = 0.05", near(Q.chi2Sf(5.991, 2), 0.05, 2e-4) && near(Q.chi2Sf(3.841, 1), 0.05, 2e-4) && near(Q.chi2Sf(18.307, 10), 0.05, 2e-4));
ok("quantile (type 7, as R / NumPy): [1,2,3,4] at 25 % = 1.75, at 50 % = 2.5", Q.quantileSorted(Float64Array.from([1, 2, 3, 4]), 0.25) === 1.75 && Q.quantileSorted(Float64Array.from([1, 2, 3, 4]), 0.5) === 2.5);
ok("skewness and excess kurtosis of a known sample (bias-adjusted, as SciPy bias=False / Excel SKEW, KURT)", near(Q.skewness([2, 8, 0, 4, 1, 9, 9, 0]), 0.3305822, 1e-6) && near(Q.exKurtosis([2, 8, 0, 4, 1, 9, 9, 0]), -2.0986023, 1e-6), `${Q.skewness([2, 8, 0, 4, 1, 9, 9, 0])} ${Q.exKurtosis([2, 8, 0, 4, 1, 9, 9, 0])}`);

// ---------- DIST ----------
const N = Array.from({ length: 5000 }, () => 0.01 * gauss());
const dN = Q.distStats(N);
ok("DIST on normal returns: skew ≈ 0, excess kurtosis ≈ 0, Jarque–Bera does not reject, ~4.6 % beyond 2σ", near(dN.skew, 0, 0.12) && near(dN.kurt, 0, 0.25) && dN.jbP > 0.01 && near(dN.beyond2, 0.0455, 0.012) && near(dN.annVol, 0.01 * Math.sqrt(252), 0.01), JSON.stringify({ s: dN.skew, k: dN.kurt, p: dN.jbP, b2: dN.beyond2 }));
const T = Array.from({ length: 5000 }, () => { const g = gauss(), c = (gauss() ** 2 + gauss() ** 2 + gauss() ** 2) / 3; return (0.01 * g) / Math.sqrt(c); });
ok("DIST on fat-tailed returns (Student t, 3 df): excess kurtosis large, Jarque–Bera rejects", Q.distStats(T).kurt > 3 && Q.distStats(T).jbP < 1e-6);
const AR = [0]; for (let i = 1; i < 3000; i++) AR.push(0.5 * AR[i - 1] + gauss());
ok("Ljung–Box: white noise not rejected; an AR(1) with φ = 0.5 rejected, lag-1 autocorrelation ≈ 0.5", Q.ljungBox(N, 10).p > 0.01 && Q.ljungBox(AR, 10).p < 1e-10 && near(Q.acf(AR, 1)[0], 0.5, 0.05));

// ---------- VAR ----------
const rm = Q.riskMeasures(N, 0.99, 1);
ok("VaR 99 % 1-day on normal returns (σ = 1 %): historical ≈ normal ≈ 2.3 %; ES ≈ 2.66 %", near(rm.normal.var, 1 - Math.exp(-0.023263), 0.0012) && near(rm.hist.var, rm.normal.var, 0.0025) && near(rm.normal.es, 1 - Math.exp(-0.026652), 0.0012) && rm.hist.es > rm.hist.var, JSON.stringify({ h: rm.hist, n: rm.normal }));
ok("Cornish–Fisher on normal returns ≈ normal; on fat tails above it", near(rm.cf.var, rm.normal.var, 0.0015) && Q.riskMeasures(T, 0.99, 1).cf.var > Q.riskMeasures(T, 0.99, 1).normal.var);
ok("10-day VaR ≈ √10 × 1-day for i.i.d. returns", near(Q.riskMeasures(N, 0.99, 10).normal.var, 1 - Math.exp(-0.023263 * Math.sqrt(10) + 10 * dN.mean), 0.004));
const days = N.map((_, i) => `d${i}`);
const bt = Q.varBacktest(N, days, 0.99, 250, 250);
ok("VaR backtest on a steady normal process: exceptions near 2.5 in 250 days, Kupiec does not reject, green", bt.n === 250 && bt.exceptions <= 6 && bt.p > 0.01 && bt.zone !== "red", JSON.stringify({ x: bt.exceptions, p: bt.p, z: bt.zone }));
const shift = N.slice(0, 4750).concat(N.slice(4750).map((x) => x * 2.5));
const bt2 = Q.varBacktest(shift, null, 0.99, 250, 250);
ok("VaR backtest when volatility jumps ×2.5: many exceptions, Kupiec rejects, red", bt2.exceptions >= 10 && bt2.p < 0.01 && bt2.zone === "red", JSON.stringify({ x: bt2.exceptions, p: bt2.p }));

// ---------- VOL ----------
// days of 390 one-minute Brownian steps, σ = 1 % a day: range estimators ≈ 15.9 % a year
const pts = [{ t: "d0", o: 100, h: 100, l: 100, c: 100 }]; let px = 100;
for (let d = 1; d <= 400; d++) { const o = px; let h = o, l = o; for (let k = 0; k < 390; k++) { px *= Math.exp(0.01 / Math.sqrt(390) * gauss()); h = Math.max(h, px); l = Math.min(l, px); } pts.push({ t: "d" + d, o, h, l, c: px }); }
const ann = 0.01 * Math.sqrt(252), cc = Q.stdev(Q.logReturns(pts.map((p) => p.c))) * Math.sqrt(252);
ok("range estimators (Parkinson, Garman–Klass, Rogers–Satchell, Yang–Zhang) ≈ the true 15.9 %; close-to-close too", [Q.rangeVol(pts, "parkinson"), Q.rangeVol(pts, "gk"), Q.rangeVol(pts, "rs"), Q.yangZhang(pts), cc].every((v) => near(v, ann, 0.025)), [Q.rangeVol(pts, "parkinson"), Q.rangeVol(pts, "gk"), Q.rangeVol(pts, "rs"), Q.yangZhang(pts), cc].map((v) => v.toFixed(4)).join(" "));
ok("a day without high / low is left out (N/A, never a made-up range)", Number.isNaN(Q.rangeVol([{ t: 1, c: 1 }, { t: 2, c: 2 }], "parkinson")));
// GARCH(1,1) with ω = 2e-6, α = 0.08, β = 0.90: the fit recovers the parameters
const G = []; let v = 2e-6 / (1 - 0.98), eps = 0; for (let i = 0; i < 4000; i++) { v = 2e-6 + 0.08 * eps * eps + 0.9 * v; eps = Math.sqrt(v) * gauss(); G.push(eps); }
const gf = Q.garch11(G);
ok("GARCH(1,1) maximum likelihood recovers α ≈ 0.08, β ≈ 0.90 (persistence ≈ 0.98)", near(gf.alpha, 0.08, 0.035) && near(gf.beta, 0.9, 0.05) && near(gf.persistence, 0.98, 0.015) && gf.halfLife > 10, JSON.stringify({ a: gf.alpha, b: gf.beta, p: gf.persistence }));
ok("GARCH term structure: short horizons near today's volatility, long ones toward the long-run level", near(gf.term(1), gf.nextVol, 1e-9) && Math.abs(gf.term(2000) - gf.longRunVol) < Math.abs(gf.term(1) - gf.longRunVol) + 1e-9);
const cone = Q.volCone(N);
ok("volatility cone: min ≤ 25 % ≤ median ≤ 75 % ≤ max per window, around 15.9 %", cone.length === 6 && cone.every((c) => c.min <= c.p25 && c.p25 <= c.med && c.med <= c.p75 && c.p75 <= c.max) && near(cone[5].med, ann, 0.02));
ok("EWMA (λ 0.94) on normal returns ≈ 1 % a day", near(Q.ewmaSigma(N).sigma, 0.01, 0.004));

// ---------- BETA ----------
const xb = N.slice(0, 1000), yb = xb.map((x) => 0.0002 + 1.5 * x + 0.004 * gauss());
const rg = Q.regression(yb, xb);
ok("regression on the benchmark: β ≈ 1.5, α ≈ 0.0002 a day (5 % a year), R² high, rolling β around 1.5", near(rg.beta, 1.5, 0.05) && near(rg.alphaAnn, 0.05, 0.05) && rg.r2 > 0.9 && rg.rolling.length === 1000 - 63 + 1 && near(Q.mean(rg.rolling), 1.5, 0.1), JSON.stringify({ b: rg.beta, a: rg.alphaAnn, r2: rg.r2 }));
ok("up / down capture of a 1.5-β stock ≈ 150 %", near(rg.upCapture, 150, 15) && near(rg.downCapture, 150, 15));

// ---------- EF ----------
ok("projection onto the simplex", JSON.stringify(Q.projSimplex([2, 0])) === "[1,0]" && Q.projSimplex([0.2, 0.2, 0.2]).every((x) => near(x, 1 / 3, 1e-12)) && near(Q.projSimplex([0.6, 0.6])[0], 0.5, 1e-12));
const mu = [0.1, 0.05], cov = [[0.04, 0], [0, 0.01]];
ok("minimum variance (σ 20 % and 10 %, uncorrelated): 20 % / 80 %", near(Q.meanVar(mu, cov, 0)[0], 0.2, 1e-4));
ok("risk parity: weights ∝ 1/σ → 1/3, 2/3; equal risk contributions", near(Q.riskParity(cov)[0], 1 / 3, 1e-6) && Q.riskContrib(cov, Q.riskParity(cov)).every((c) => near(c, 0.5, 1e-6)));
const ms = Q.maxSharpe(mu, cov, 0);
ok("maximum Sharpe (rf 0): tangency ∝ Σ⁻¹μ = 1/3, 2/3", near(ms.w[0], 1 / 3, 0.01) && near(ms.sharpe, Math.sqrt(0.1 ** 2 / 0.04 + 0.05 ** 2 / 0.01), 1e-3), JSON.stringify(ms));
const fr = Q.frontier(mu, cov, 0);
ok("efficient frontier: from the minimum-variance portfolio up to the highest-return asset, return and risk rising", fr.length > 10 && fr.every((p, i) => !i || (p.ret > fr[i - 1].ret && p.vol >= fr[i - 1].vol - 1e-9)) && near(fr[fr.length - 1].ret, 0.1, 0.005) && fr.every((p) => near(p.w.reduce((a, b) => a + b, 0), 1, 1e-9) && p.w.every((x) => x >= 0)));
const opt = Q.optimize([N.slice(0, 1000), T.slice(0, 1000).map((x) => x * 0.5), N.slice(1000, 2000)], 0);
ok("optimize(): moments, frontier, special portfolios with weights adding up to 100 %, long only", [opt.minVar, opt.maxSharpe, opt.riskParity, opt.equal].every((p) => near(p.w.reduce((a, b) => a + b, 0), 1, 1e-9) && p.w.every((x) => x >= -1e-12)) && opt.minVar.vol <= opt.equal.vol + 1e-9);

// ---------- MC ----------
const g0 = Array.from({ length: 1000 }, () => 0.01 * gauss()), gm = Q.mean(g0), gs = Q.stdev(g0);
const mc = Q.monteCarlo({ r: g0, s0: 100, days: 252, paths: 20000, method: "gbm", run: 7 });
const p5 = Math.exp(252 * gm - 1.644854 * gs * Math.sqrt(252)) - 1;
ok("Monte Carlo (normal paths with the sample μ, σ): terminal 5th percentile and median match the closed form", near(mc.stats.p5, p5, 0.012) && near(mc.stats.median, Math.exp(252 * gm) - 1, 0.012) && mc.bands[0].length === 253 && mc.bands[2][0] === 100, JSON.stringify({ p5: mc.stats.p5, want: p5 }));
const mcA = Q.monteCarlo({ r: g0, s0: 100, days: 63, paths: 2000, method: "boot", run: 3 }), mcB = Q.monteCarlo({ r: g0, s0: 100, days: 63, paths: 2000, method: "boot", run: 3 }), mcC = Q.monteCarlo({ r: g0, s0: 100, days: 63, paths: 2000, method: "boot", run: 4 });
ok("Monte Carlo is reproducible: the same run number gives the same result, another a different one", mcA.stats.p5 === mcB.stats.p5 && mcA.stats.p5 !== mcC.stats.p5);
const bl = Q.monteCarlo({ r: g0, s0: 100, days: 252, paths: 5000, method: "block", block: 5, run: 9 });
ok("bootstrap and block bootstrap: bands ordered (5 % ≤ 25 % ≤ 50 % ≤ 75 % ≤ 95 %) every day; VaR / ES positive, ES ≥ VaR", [mcA, bl].every((m) => m.bands[0].every((v, t) => v <= m.bands[1][t] && m.bands[1][t] <= m.bands[2][t] && m.bands[2][t] <= m.bands[3][t] && m.bands[3][t] <= m.bands[4][t])) && bl.stats.r99.es >= bl.stats.r99.var && bl.stats.r95.var > 0);
ok("Monte Carlo refuses too little history or a bad start (no output rather than a weak one)", Q.monteCarlo({ r: g0.slice(0, 30), s0: 100 }) === null && Q.monteCarlo({ r: g0, s0: 0 }) === null);
ok("probability of ending above a level, from the paths", near(mc.probAbove(100), mc.stats.pGain, 0.001) && mc.probAbove(1e9) === 0);

// ---------- SEAS ----------
const mpts = []; let c = 100; for (let y = 2020; y <= 2024; y++) for (let m = 1; m <= 12; m++) { c *= m === 1 ? 1.05 : m === 9 ? 0.97 : 1.01; mpts.push({ t: `${y}-${String(m).padStart(2, "0")}-28`, c }); }
const se = Q.monthlySeason(mpts);
ok("seasonality: January +5 % and September −3 % every year; the first month has no previous close (not filled)", near(se.months[0].avg, 0.05, 1e-12) && se.months[0].n === 4 && near(se.months[8].avg, -0.03, 1e-12) && se.months[8].pos === 0 && se.years[0].m[0] === null && se.years[1].total != null);
const gap = mpts.filter((p) => p.t !== "2022-06-28"), seg = Q.monthlySeason(gap);
ok("a missing month breaks the pair: no return for June or July 2022 rather than a two-month one", seg.years.find((y) => y.y === 2022).m[5] === null && seg.years.find((y) => y.y === 2022).m[6] === null);
const wk = Q.weekdaySeason([{ t: "2026-10-16", c: 100 }, { t: "2026-10-19", c: 101 }, { t: "2026-10-20", c: 100 }]);
ok("weekday returns: Monday vs the Friday before, Tuesday vs Monday", near(wk[0].avg, 0.01, 1e-12) && near(wk[1].avg, 100 / 101 - 1, 1e-12) && wk[2].n === 0);
const al = Q.align([[{ t: "2026-01-02", c: 1 }, { t: "2026-01-05", c: 2 }], [{ t: "2026-01-05", c: 3 }, { t: "2026-01-06", c: 4 }]]);
ok("align(): only the dates every series has", JSON.stringify(al) === JSON.stringify({ dates: ["2026-01-05"], closes: [[2], [3]] }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
