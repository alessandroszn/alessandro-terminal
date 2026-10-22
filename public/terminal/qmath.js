/* Alessandro Terminal — quant library (QNT window). Pure functions over REAL price history fetched by the page
   (/api/history). Nothing here produces market data: every output is DERIVED from the closes it is given, and the
   Monte Carlo paths are a model of possible outcomes built from past returns (numbered runs, reproducible), never prices.
   Loaded in the page (window.QUANT) and in Node for the tests (module.exports). */
(function (root) {
  "use strict";
  const fin = Number.isFinite;
  const SQ252 = Math.sqrt(252);

  // ---------- basics ----------
  const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  function variance(a, ddof = 1) { const n = a.length; if (n - ddof <= 0) return NaN; const m = mean(a); let s = 0; for (let i = 0; i < n; i++) s += (a[i] - m) ** 2; return s / (n - ddof); }
  const stdev = (a, ddof = 1) => Math.sqrt(variance(a, ddof));
  // closes in date order → log returns ln(c_t / c_{t-1}) (a non-positive close breaks the pair, nothing is filled in)
  function logReturns(c) { const r = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1])); return r; }
  function simpleReturns(c) { const r = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(c[i] / c[i - 1] - 1); return r; }
  // quantile of a sorted array, linear interpolation between order statistics (Hyndman–Fan type 7, as R / NumPy default)
  function quantileSorted(s, p) { const n = s.length; if (!n) return NaN; if (n === 1) return s[0]; const h = (n - 1) * p, lo = Math.floor(h), hi = Math.min(n - 1, lo + 1); return s[lo] + (h - lo) * (s[hi] - s[lo]); }
  const sorted = (a) => Float64Array.from(a).sort();
  function skewness(a) { const n = a.length; if (n < 3) return NaN; const m = mean(a); let m2 = 0, m3 = 0; for (const x of a) { const d = x - m; m2 += d * d; m3 += d * d * d; } m2 /= n; m3 /= n; if (!m2) return NaN; const g1 = m3 / m2 ** 1.5; return g1 * Math.sqrt(n * (n - 1)) / (n - 2); }
  function exKurtosis(a) { const n = a.length; if (n < 4) return NaN; const m = mean(a); let m2 = 0, m4 = 0; for (const x of a) { const d = x - m; m2 += d * d; m4 += d ** 4; } m2 /= n; m4 /= n; if (!m2) return NaN; const g2 = m4 / (m2 * m2) - 3; return ((n + 1) * g2 + 6) * (n - 1) / ((n - 2) * (n - 3)); }

  // ---------- distributions ----------
  const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  function erf(x) { // Abramowitz–Stegun 7.1.26 refined by one Newton-free series switch: |error| < 1.2e-7
    const t = 1 / (1 + 0.5 * Math.abs(x)), y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? y : -y; }
  const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  // inverse normal (Acklam), relative error < 1.2e-9 after one Halley step
  function normInv(p) { if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239], b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1], c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425; let q, r, x;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    else if (p <= 1 - pl) { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const e = normCdf(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2); return x - u / (1 + x * u / 2); }
  // regularized upper incomplete gamma Q(a, x) (Numerical Recipes: series for x < a+1, continued fraction otherwise)
  function lnGamma(z) { const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let x = z, y = z, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const c of g) s += c / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
  function gammaQ(a, x) { if (x < 0 || a <= 0) return NaN; if (x === 0) return 1;
    if (x < a + 1) { let ap = a, s = 1 / a, del = s; for (let n = 0; n < 500; n++) { ap++; del *= x / ap; s += del; if (Math.abs(del) < Math.abs(s) * 1e-14) break; } return 1 - s * Math.exp(-x + a * Math.log(x) - lnGamma(a)); }
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d; for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
    return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h; }
  const chi2Sf = (x, k) => gammaQ(k / 2, x / 2);

  // ---------- DIST: the shape of daily returns ----------
  function distStats(r) { const n = r.length; if (n < 30) return null; const m = mean(r), sd = stdev(r), S = skewness(r), K = exKurtosis(r), s = sorted(r);
    const jb = (n / 6) * (S * S + (K * K) / 4), b2 = r.filter((x) => Math.abs(x - m) > 2 * sd).length / n, b3 = r.filter((x) => Math.abs(x - m) > 3 * sd).length / n;
    return { n, mean: m, sd, annVol: sd * SQ252, skew: S, kurt: K, min: s[0], max: s[n - 1], p1: quantileSorted(s, 0.01), p5: quantileSorted(s, 0.05), p95: quantileSorted(s, 0.95), p99: quantileSorted(s, 0.99),
      jb, jbP: chi2Sf(jb, 2), beyond2: b2, beyond3: b3, normal2: 2 * (1 - normCdf(2)), normal3: 2 * (1 - normCdf(3)), posShare: r.filter((x) => x > 0).length / n }; }
  function acf(r, maxLag) { const n = r.length, m = mean(r); let d0 = 0; for (const x of r) d0 += (x - m) ** 2; const out = []; for (let k = 1; k <= maxLag; k++) { let s = 0; for (let t = k; t < n; t++) s += (r[t] - m) * (r[t - k] - m); out.push(d0 ? s / d0 : NaN); } return out; }
  // Ljung–Box Q(k): is there autocorrelation up to lag k (in returns: predictability; in squared returns: volatility clustering)
  function ljungBox(r, k) { const n = r.length, rho = acf(r, k); let q = 0; for (let j = 1; j <= k; j++) q += (rho[j - 1] ** 2) / (n - j); q *= n * (n + 2); return { q, p: chi2Sf(q, k), lags: k, rho }; }
  function histogram(x, bins, lo, hi) { lo = lo ?? Math.min(...x); hi = hi ?? Math.max(...x); if (!(hi > lo)) hi = lo + 1e-9; const w = (hi - lo) / bins, counts = new Array(bins).fill(0);
    for (const v of x) { if (v < lo || v > hi) continue; counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++; } return { lo, hi, w, counts }; }

  // ---------- VAR: value at risk and expected shortfall (as positive losses, fraction of the position) ----------
  function ewmaSigma(r, lambda = 0.94) { if (r.length < 30) return { sigma: NaN, series: [] }; let v = variance(r.slice(0, 30), 0); const series = []; for (let i = 30; i < r.length; i++) { v = lambda * v + (1 - lambda) * r[i - 1] ** 2; series.push(Math.sqrt(v)); } v = lambda * v + (1 - lambda) * r[r.length - 1] ** 2; return { sigma: Math.sqrt(v), series }; }
  const toLoss = (logRet) => 1 - Math.exp(logRet); // a log return at the tail → the simple loss it means
  function cornishFisherZ(z, S, K) { return z + (z * z - 1) * S / 6 + (z ** 3 - 3 * z) * K / 24 - (2 * z ** 3 - 5 * z) * S * S / 36; }
  function riskMeasures(r, conf = 0.99, h = 1) {
    const n = r.length; if (n < 60) return null; const a = 1 - conf, m = mean(r), sd = stdev(r), S = skewness(r), K = exKurtosis(r);
    // historical: overlapping h-day log returns (h = 1: the daily returns themselves)
    const rh = []; for (let i = h; i <= n; i++) { let s = 0; for (let j = i - h; j < i; j++) s += r[j]; rh.push(s); }
    const sh = sorted(rh), qh = quantileSorted(sh, a), tail = rh.filter((x) => x <= qh), hist = { var: toLoss(qh), es: toLoss(mean(tail)), n: rh.length };
    const mh = m * h, sdh = sd * Math.sqrt(h), z = normInv(a);
    const normal = { var: toLoss(mh + sdh * z), es: toLoss(mh - sdh * normPdf(z) / a) };
    // Cornish–Fisher: the normal quantile corrected for the skew and fat tails of the daily returns (scaled to h days, i.i.d.)
    const Sh = S / Math.sqrt(h), Kh = K / h, zcf = cornishFisherZ(z, Sh, Kh); let esz = 0; const G = 200; for (let i = 0; i < G; i++) esz += cornishFisherZ(normInv(((i + 0.5) / G) * a), Sh, Kh); esz /= G;
    const cf = { var: toLoss(mh + sdh * zcf), es: toLoss(mh + sdh * esz) };
    const ew = ewmaSigma(r), sdE = ew.sigma * Math.sqrt(h), ewma = { var: toLoss(sdE * z), es: toLoss(-sdE * normPdf(z) / a), sigma: ew.sigma };
    return { conf, h, n, mean: m, sd, skew: S, kurt: K, hist, normal, cf, ewma }; }
  // backtest of the 1-day historical VaR: each of the last `test` days against the VaR of the `window` days before it.
  // Kupiec's proportion-of-failures test; Basel traffic light (for 99 % and 250 days: green ≤ 4, yellow 5–9, red ≥ 10)
  function varBacktest(r, dates, conf = 0.99, window = 250, test = 250) {
    if (r.length < window + 20) return null; const t0 = Math.max(window, r.length - test), a = 1 - conf, rows = []; let x = 0;
    for (let t = t0; t < r.length; t++) { const v = -quantileSorted(sorted(r.slice(t - window, t)), a), hit = r[t] < -v; if (hit) x++; rows.push({ t: dates ? dates[t] : t, r: r[t], v, hit }); }
    const n = rows.length, ph = x / n, ll0 = (n - x) * Math.log(1 - a) + x * Math.log(a), ll1 = (x === 0 || x === n) ? 0 : (n - x) * Math.log(1 - ph) + x * Math.log(ph), lr = -2 * (ll0 - ll1);
    const scale = n / 250, zone = conf === 0.99 ? (x <= 4 * scale ? "green" : x <= 9 * scale ? "yellow" : "red") : null;
    return { n, exceptions: x, expected: n * a, lr, p: chi2Sf(lr, 1), zone, rows }; }

  // ---------- VOL: estimators, EWMA, GARCH(1,1), cone ----------
  // range estimators from daily OHLC (annualised); a day without a valid open / high / low / close is left out
  function rangeVol(pts, est) { const ln = Math.log, v = [];
    for (let i = 1; i < pts.length; i++) { const p = pts[i], q = pts[i - 1]; if (!(p.o > 0 && p.h > 0 && p.l > 0 && p.c > 0 && q.c > 0 && p.h >= p.l)) continue;
      const hl = ln(p.h / p.l), co = ln(p.c / p.o);
      if (est === "parkinson") v.push(hl * hl / (4 * Math.LN2));
      else if (est === "gk") v.push(0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co);
      else if (est === "rs") v.push(ln(p.h / p.c) * ln(p.h / p.o) + ln(p.l / p.c) * ln(p.l / p.o)); }
    return v.length >= 10 ? Math.sqrt(Math.max(0, mean(v)) * 252) : NaN; }
  // Yang–Zhang: overnight + open-to-close + Rogers–Satchell, the minimum-variance combination (k = 0.34 / (1.34 + (n+1)/(n−1)))
  function yangZhang(pts) { const ln = Math.log, on = [], oc = [], rs = [];
    for (let i = 1; i < pts.length; i++) { const p = pts[i], q = pts[i - 1]; if (!(p.o > 0 && p.h > 0 && p.l > 0 && p.c > 0 && q.c > 0 && p.h >= p.l)) continue; on.push(ln(p.o / q.c)); oc.push(ln(p.c / p.o)); rs.push(ln(p.h / p.c) * ln(p.h / p.o) + ln(p.l / p.c) * ln(p.l / p.o)); }
    const n = on.length; if (n < 10) return NaN; const k = 0.34 / (1.34 + (n + 1) / (n - 1)); return Math.sqrt((variance(on) + k * variance(oc) + (1 - k) * mean(rs)) * 252); }
  function rollingVol(r, w) { const out = []; for (let i = w; i <= r.length; i++) out.push(stdev(r.slice(i - w, i)) * SQ252); return out; }
  function volCone(r, windows = [10, 21, 42, 63, 126, 252]) { return windows.filter((w) => r.length >= w + 20).map((w) => { const rv = rollingVol(r, w), s = sorted(rv); return { w, min: s[0], p25: quantileSorted(s, 0.25), med: quantileSorted(s, 0.5), p75: quantileSorted(s, 0.75), max: s[s.length - 1], now: rv[rv.length - 1], pct: rv.filter((x) => x <= rv[rv.length - 1]).length / rv.length }; }); }
  // Nelder–Mead minimiser (small, unconstrained)
  function nelderMead(f, x0, { step = 0.5, iters = 600, tol = 1e-10 } = {}) {
    const n = x0.length; let S = [x0.slice()]; for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step; S.push(x); } let F = S.map(f);
    for (let it = 0; it < iters; it++) {
      const o = F.map((v, i) => i).sort((a, b) => F[a] - F[b]); S = o.map((i) => S[i]); F = o.map((i) => F[i]); if (Math.abs(F[n] - F[0]) < tol) break;
      const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
      const pt = (t) => c.map((v, j) => v + t * (S[n][j] - v)), xr = pt(-1), fr = f(xr);
      if (fr < F[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } }
      else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
      else { const xc = pt(fr < F[n] ? -0.5 : 0.5), fc = f(xc); if (fc < Math.min(fr, F[n])) { S[n] = xc; F[n] = fc; } else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); } } } }
    return { x: S[0], f: F[0] }; }
  // GARCH(1,1) by Gaussian maximum likelihood on demeaned daily log returns: σ²_t = ω + α ε²_{t−1} + β σ²_{t−1}, α+β < 1
  function garch11(r) {
    const n = r.length; if (n < 250) return null; const m = mean(r), e = r.map((x) => x - m), v0 = variance(e, 0), lg = (z) => 1 / (1 + Math.exp(-z));
    const unpack = (x) => { const s = 0.999 * lg(x[1]), p = lg(x[2]); return { w: Math.exp(x[0]), a: s * p, b: s * (1 - p) }; };
    const nll = (x) => { const { w, a, b } = unpack(x); let v = v0, L = 0; for (let t = 0; t < n; t++) { if (t > 0) v = w + a * e[t - 1] ** 2 + b * v; if (!(v > 0)) return 1e12; L += Math.log(v) + e[t] * e[t] / v; } return 0.5 * L; };
    // start: α 0.08, β 0.90, ω from the variance of the returns
    const s0 = 0.98, p0 = 0.08 / 0.98, x0 = [Math.log(v0 * 0.02), Math.log(s0 / 0.999 / (1 - s0 / 0.999)), Math.log(p0 / (1 - p0))];
    const fit = nelderMead(nll, x0, { step: 0.6, iters: 900 }); const { w, a, b } = unpack(fit.x), pers = a + b;
    let v = v0; const cond = []; for (let t = 0; t < n; t++) { if (t > 0) v = w + a * e[t - 1] ** 2 + b * v; cond.push(Math.sqrt(v)); } const next = w + a * e[n - 1] ** 2 + b * v, vl = w / (1 - pers);
    // average variance over the next T days → annualised volatility for that horizon (the term structure)
    const term = (T) => { let s = 0; for (let k = 1; k <= T; k++) s += vl + pers ** (k - 1) * (next - vl); return Math.sqrt((s / T) * 252); };
    return { omega: w, alpha: a, beta: b, persistence: pers, longRunVol: Math.sqrt(vl * 252), halfLife: pers < 1 && pers > 0 ? Math.log(0.5) / Math.log(pers) : Infinity, nextVol: Math.sqrt(next * 252), cond: cond.map((s) => s * SQ252), term, logLik: -fit.f - 0.5 * n * Math.log(2 * Math.PI) }; }

  // ---------- BETA: regression on a benchmark (aligned simple daily returns) ----------
  function ols(y, x) { const n = Math.min(y.length, x.length); if (n < 3) return null; const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n)); let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; } if (!sxx) return null;
    const beta = sxy / sxx, alpha = my - beta * mx; let sse = 0; for (let i = 0; i < n; i++) sse += (y[i] - alpha - beta * x[i]) ** 2; const s2 = sse / (n - 2);
    return { n, alpha, beta, r2: syy ? 1 - sse / syy : NaN, corr: syy ? sxy / Math.sqrt(sxx * syy) : NaN, residSd: Math.sqrt(s2), seBeta: Math.sqrt(s2 / sxx), tBeta: beta / Math.sqrt(s2 / sxx) }; }
  function regression(rs, rb, rollW = 63) { const n = Math.min(rs.length, rb.length); if (n < 60) return null; const o = ols(rs, rb), d = rs.map((x, i) => x - rb[i]), te = stdev(d) * SQ252;
    const up = [], dn = []; for (let i = 0; i < n; i++) (rb[i] > 0 ? up : rb[i] < 0 ? dn : []).push(i);
    const cap = (idx) => { if (idx.length < 5) return NaN; const gs = idx.reduce((g, i) => g * (1 + rs[i]), 1), gb = idx.reduce((g, i) => g * (1 + rb[i]), 1); return (gs ** (1 / idx.length) - 1) / (gb ** (1 / idx.length) - 1) * 100; };
    const roll = []; for (let i = rollW; i <= n; i++) { const q = ols(rs.slice(i - rollW, i), rb.slice(i - rollW, i)); roll.push(q ? q.beta : NaN); }
    return { ...o, alphaAnn: o.alpha * 252, trackingError: te, infoRatio: te ? (mean(d) * 252) / te : NaN, idioVol: o.residSd * SQ252, upCapture: cap(up), downCapture: cap(dn), rolling: roll, rollW }; }

  // ---------- EF: long-only portfolio optimisation on past returns ----------
  // R: assets × days of aligned simple daily returns → annualised arithmetic means and covariance
  function moments(R) { const k = R.length, n = R[0].length, mu = R.map((r) => mean(r) * 252), m = R.map(mean), cov = [];
    for (let i = 0; i < k; i++) { cov.push([]); for (let j = 0; j < k; j++) { let s = 0; for (let t = 0; t < n; t++) s += (R[i][t] - m[i]) * (R[j][t] - m[j]); cov[i][j] = (s / (n - 1)) * 252; } } return { mu, cov, n }; }
  const mv = (M, w) => M.map((row) => row.reduce((s, v, j) => s + v * w[j], 0));
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const pvol = (cov, w) => Math.sqrt(Math.max(0, dot(w, mv(cov, w))));
  // Euclidean projection onto {w ≥ 0, Σw = 1} (Duchi et al.)
  function projSimplex(v) { const u = v.slice().sort((a, b) => b - a); let c = 0, th = 0; for (let i = 0; i < u.length; i++) { c += u[i]; const t = (c - 1) / (i + 1); if (u[i] - t > 0) th = t; } return v.map((x) => Math.max(0, x - th)); }
  // minimise wΣw − λ·wμ over the simplex (projected gradient); λ = 0 is the minimum-variance portfolio
  function meanVar(mu, cov, lambda, w0) { const k = mu.length, L = 2 * Math.max(...cov.map((r) => r.reduce((s, v) => s + Math.abs(v), 0))) || 1; let w = w0 ? w0.slice() : new Array(k).fill(1 / k);
    for (let it = 0; it < 4000; it++) { const g = mv(cov, w).map((v, i) => 2 * v - lambda * mu[i]), nw = projSimplex(w.map((x, i) => x - g[i] / L)); let d = 0; for (let i = 0; i < k; i++) d += Math.abs(nw[i] - w[i]); w = nw; if (d < 1e-12) break; } return w; }
  const stats = (mu, cov, w, rf) => { const ret = dot(w, mu), vol = pvol(cov, w); return { w, ret, vol, sharpe: vol > 0 ? (ret - rf) / vol : NaN }; };
  // the long-only efficient frontier: λ from 0 (minimum variance) to the smallest λ that puts everything in the
  // highest-return asset (found by bisection), evenly spaced — the expected return rises about linearly with λ
  function frontier(mu, cov, rf = 0, points = 40) {
    const minV = meanVar(mu, cov, 0), top = Math.max(...mu), atTop = (w) => dot(w, mu) >= top - 1e-6;
    let hi = 1e-4, w = minV; for (let i = 0; i < 60 && !atTop(w = meanVar(mu, cov, hi, w)); i++) hi *= 2;
    let lo = 0; for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (atTop(meanVar(mu, cov, mid, minV))) hi = mid; else lo = mid; }
    const out = [stats(mu, cov, minV, rf)]; w = minV;
    for (let i = 1; i <= points; i++) { w = meanVar(mu, cov, (hi * i) / points, w); out.push(stats(mu, cov, w, rf)); }
    const f = []; for (const p of out) if (!f.length || p.ret > f[f.length - 1].ret + 1e-7) f.push(p); return f; }
  function maxSharpe(mu, cov, rf = 0, front) { front = front || frontier(mu, cov, rf); let best = front.reduce((b, p) => (p.sharpe > b.sharpe ? p : b), front[0]);
    // refine by projected gradient ascent on the Sharpe ratio
    let w = best.w.slice(); for (let it = 0; it < 3000; it++) { const v = pvol(cov, w); if (!(v > 0)) break; const ex = dot(w, mu) - rf, Sw = mv(cov, w), g = mu.map((m, i) => m / v - ex * Sw[i] / (v ** 3)), nw = projSimplex(w.map((x, i) => x + 0.002 * g[i])); if (dot(nw, mu) - rf <= 0) break; const s = stats(mu, cov, nw, rf); if (s.sharpe < best.sharpe - 1e-12) break; w = nw; best = s; }
    return best; }
  // equal risk contribution (long-only): multiplicative fixed point
  function riskParity(cov) { const k = cov.length; let w = cov.map((r, i) => 1 / Math.sqrt(r[i])); const s0 = sum(w); w = w.map((x) => x / s0);
    for (let it = 0; it < 2000; it++) { const Sw = mv(cov, w), tot = dot(w, Sw), nw = w.map((x, i) => x * Math.sqrt((tot / k) / Math.max(1e-18, x * Sw[i]))), s = sum(nw); let d = 0; for (let i = 0; i < k; i++) { d += Math.abs(nw[i] / s - w[i]); w[i] = nw[i] / s; } if (d < 1e-12) break; } return w; }
  function riskContrib(cov, w) { const Sw = mv(cov, w), tot = dot(w, Sw); return w.map((x, i) => (tot > 0 ? (x * Sw[i]) / tot : NaN)); }
  function optimize(R, rf = 0) { const { mu, cov, n } = moments(R), k = mu.length, front = frontier(mu, cov, rf);
    return { mu, cov, n, vols: cov.map((r, i) => Math.sqrt(r[i])), frontier: front, minVar: front[0], maxSharpe: maxSharpe(mu, cov, rf, front), riskParity: stats(mu, cov, riskParity(cov), rf), equal: stats(mu, cov, new Array(k).fill(1 / k), rf) }; }

  // ---------- MC: Monte Carlo paths from past daily log returns ----------
  // numbered generator (mulberry32): the same inputs and run number give the same result
  function mulberry32(run) { let a = run >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function monteCarlo({ r, s0, days = 252, paths = 5000, method = "boot", block = 5, run = 1, pct = [0.05, 0.25, 0.5, 0.75, 0.95] }) {
    if (!(r && r.length >= 60 && s0 > 0 && days >= 1 && paths >= 100)) return null;
    const rng = mulberry32(run), n = r.length, mu = mean(r), sd = stdev(r); let spare = null;
    const gauss = () => { if (spare != null) { const s = spare; spare = null; return s; } let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); const m = Math.sqrt(-2 * Math.log(u)); spare = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v); };
    const x = new Float64Array(paths), bpos = new Int32Array(paths).fill(-1), bands = pct.map(() => [s0]), tmp = new Float64Array(paths), lo = Math.log(s0);
    let minLog = new Float64Array(paths); // running minimum (for the probability of touching a level)
    for (let t = 1; t <= days; t++) {
      for (let p = 0; p < paths; p++) {
        let d;
        if (method === "gbm") d = mu + sd * gauss();
        else if (method === "block") { if (bpos[p] < 0 || (t - 1) % block === 0) bpos[p] = Math.floor(rng() * (n - block + 1)); else bpos[p]++; d = r[Math.min(n - 1, bpos[p])]; }
        else d = r[Math.floor(rng() * n)];
        x[p] += d; if (x[p] < minLog[p]) minLog[p] = x[p]; }
      tmp.set(x); tmp.sort(); pct.forEach((q, i) => bands[i].push(s0 * Math.exp(quantileSorted(tmp, q)))); }
    const term = Float64Array.from(x).sort(), ret = Array.from(term, (v) => Math.exp(v) - 1);
    const q = (p) => quantileSorted(term, p), lossAt = (a) => { const v = q(a), tail = []; for (const t of term) { if (t > v) break; tail.push(t); } return { var: toLoss(v), es: toLoss(mean(tail)) }; };
    const dd = Array.from(minLog, (m) => Math.exp(m) - 1).sort((a, b) => a - b);
    return { s0, days, paths, method, block, run, mu, sd, bands, pct, terminal: Array.from(term, (v) => s0 * Math.exp(v)),
      stats: { mean: mean(ret), median: Math.exp(q(0.5)) - 1, p5: Math.exp(q(0.05)) - 1, p95: Math.exp(q(0.95)) - 1, pGain: ret.filter((v) => v > 0).length / paths, pLoss10: ret.filter((v) => v <= -0.1).length / paths, pLoss20: ret.filter((v) => v <= -0.2).length / paths,
        r95: lossAt(0.05), r99: lossAt(0.01), worstDrawdownMedian: quantileSorted(dd, 0.5), touch10: dd.filter((v) => v <= -0.1).length / paths },
      probAbove: (level) => ret.filter((v, i) => s0 * (1 + v) >= level).length / paths, histogram: (bins) => histogram(ret, bins) }; }

  // ---------- SEAS: seasonality ----------
  // monthly closes (date order) → returns by calendar month and year (consecutive months only)
  function monthlySeason(pts) { const rows = {}, byM = Array.from({ length: 12 }, () => []);
    for (let i = 1; i < pts.length; i++) { const a = String(pts[i - 1].t).slice(0, 7), b = String(pts[i].t).slice(0, 7), ya = +a.slice(0, 4), ma = +a.slice(5, 7), yb = +b.slice(0, 4), mb = +b.slice(5, 7);
      if (!(pts[i].c > 0 && pts[i - 1].c > 0) || (yb * 12 + mb) - (ya * 12 + ma) !== 1) continue; const v = pts[i].c / pts[i - 1].c - 1; (rows[yb] = rows[yb] || new Array(12).fill(null))[mb - 1] = v; byM[mb - 1].push(v); }
    const years = Object.keys(rows).map(Number).sort((a, b) => a - b).map((y) => { const m = rows[y], got = m.filter((v) => v != null); return { y, m, total: got.length === 12 ? got.reduce((g, v) => g * (1 + v), 1) - 1 : null, months: got.length }; });
    const months = byM.map((a) => { const s = sorted(a); return { n: a.length, avg: a.length ? mean(a) : NaN, median: a.length ? quantileSorted(s, 0.5) : NaN, pos: a.length ? a.filter((v) => v > 0).length / a.length : NaN, best: a.length ? s[s.length - 1] : NaN, worst: a.length ? s[0] : NaN }; });
    return { years, months }; }
  // daily closes → average return by weekday (Mon–Fri), on the day's own close vs the previous trading day
  function weekdaySeason(pts) { const by = Array.from({ length: 5 }, () => []);
    for (let i = 1; i < pts.length; i++) { if (!(pts[i].c > 0 && pts[i - 1].c > 0)) continue; const d = new Date(String(pts[i].t).slice(0, 10) + "T12:00:00Z").getUTCDay(); if (d >= 1 && d <= 5) by[d - 1].push(pts[i].c / pts[i - 1].c - 1); }
    return by.map((a) => ({ n: a.length, avg: a.length ? mean(a) : NaN, pos: a.length ? a.filter((v) => v > 0).length / a.length : NaN })); }

  // ---------- FACT: factor exposure — multiple regression (OLS with an intercept) on monthly excess returns ----------
  // Student t, two-sided p-value through the regularized incomplete beta I_x(a, b) (continued fraction, Numerical Recipes)
  function betaCf(a, b, x) { let c = 1, d = 1 - (a + b) * x / (a + 1); if (Math.abs(d) < 1e-300) d = 1e-300; d = 1 / d; let h = d;
    for (let m = 1; m <= 300; m++) { const m2 = 2 * m; let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2)); d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; h *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1)); d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
    return h; }
  function betaI(a, b, x) { if (!(x > 0)) return 0; if (x >= 1) return 1; const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betaCf(a, b, x) / a : 1 - bt * betaCf(b, a, 1 - x) / b; }
  const tP2 = (t, df) => (fin(t) && df > 0 ? betaI(df / 2, 0.5, df / (df + t * t)) : NaN);
  // Gauss–Jordan inverse with partial pivoting (small matrices); null when singular
  function invert(M) { const n = M.length, A = M.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    const scale = Math.max(...M.map((r, i) => Math.abs(r[i])), 1e-300);
    for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; if (Math.abs(A[p][c]) < scale * 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]]; const d = A[c][c]; for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; } }
    return A.map((r) => r.slice(n)); }
  // y on the columns X (each as long as y) and an intercept: coefficients (intercept first), standard errors, t, p, R²
  function olsMulti(y, X) { const n = y.length, k = X.length + 1; if (n < k + 2 || X.some((c) => c.length !== n)) return null;
    const z = (j, i) => (j === 0 ? 1 : X[j - 1][i]), A = [], c = [];
    for (let a = 0; a < k; a++) { const row = []; for (let b = 0; b < k; b++) { let t = 0; for (let i = 0; i < n; i++) t += z(a, i) * z(b, i); row.push(t); } A.push(row); let s = 0; for (let i = 0; i < n; i++) s += z(a, i) * y[i]; c.push(s); }
    const inv = invert(A); if (!inv) return null;
    const coef = inv.map((r) => r.reduce((s, v, j) => s + v * c[j], 0)), my = mean(y); let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) { let f = 0; for (let j = 0; j < k; j++) f += coef[j] * z(j, i); sse += (y[i] - f) ** 2; sst += (y[i] - my) ** 2; }
    const df = n - k, s2 = sse / df, se = inv.map((r, j) => Math.sqrt(Math.max(0, r[j] * s2))), t = coef.map((b, j) => (se[j] > 0 ? b / se[j] : NaN));
    return { n, k, df, coef, se, t, p: t.map((x) => tP2(x, df)), r2: sst ? 1 - sse / sst : NaN, adjR2: sst ? 1 - (sse / df) / (sst / (n - 1)) : NaN, residSd: Math.sqrt(s2) }; }
  // the models: CAPM, Fama/French 3, Fama/French 5, 5 + momentum (Carhart's momentum on the five)
  const FACTOR_MODELS = { capm: ["mkt"], ff3: ["mkt", "smb", "hml"], ff5: ["mkt", "smb", "hml", "rmw", "cma"], ff6: ["mkt", "smb", "hml", "rmw", "cma", "mom"] };
  // y: monthly excess returns; F: { mkt: [...], smb: [...], … } on the same months. Alpha a month and annualised (× 12);
  // each factor's share of the variance of y (β·cov(f, y) / var(y), they add up to R²) and of the average excess return
  // (β · mean factor return, annualised — with alpha they add up to the average, an identity of least squares)
  function factorFit(y, F, names) { const o = olsMulti(y, names.map((k) => F[k])); if (!o) return null;
    const vy = variance(y), my = mean(y), cov = (a) => { const ma = mean(a); let s = 0; for (let i = 0; i < y.length; i++) s += (a[i] - ma) * (y[i] - my); return s / (y.length - 1); };
    const betas = {}; names.forEach((k, j) => { const b = o.coef[j + 1]; betas[k] = { b, se: o.se[j + 1], t: o.t[j + 1], p: o.p[j + 1], varShare: vy > 0 ? b * cov(F[k]) / vy : NaN, retAnn: b * mean(F[k]) * 12, premAnn: mean(F[k]) * 12 }; });
    return { names, n: o.n, df: o.df, alpha: o.coef[0], alphaAnn: o.coef[0] * 12, alphaSe: o.se[0], alphaT: o.t[0], alphaP: o.p[0], betas, r2: o.r2, adjR2: o.adjR2, residVolAnn: o.residSd * Math.sqrt(12), meanAnn: my * 12, volAnn: Math.sqrt(vy * 12) }; }
  // the coefficients over a moving window (months): one row of betas per window end, null when the window is singular
  function rollingFactorFit(y, F, names, w = 36) { const out = []; for (let e = w; e <= y.length; e++) { const o = olsMulti(y.slice(e - w, e), names.map((k) => F[k].slice(e - w, e))); out.push(o ? o.coef.slice(1) : null); } return out; }

  // ---------- PLAB: portfolio lab — backtest with rebalancing and monthly contributions, risk, stress windows, projection ----------
  const DAY_MS = 86400000, YEAR_MS = 365.25 * DAY_MS;
  // several daily series {d: [dates], v: [values]} → the dates they all have and each one's values on them (nothing filled in)
  function alignDV(list) { if (!list.length) return { dates: [], vals: [] }; const maps = list.map((s) => { const m = new Map(); for (let i = 0; i < s.d.length; i++) m.set(s.d[i], s.v[i]); return m; });
    const dates = list[0].d.filter((d) => maps.every((m) => m.get(d) > 0)); return { dates, vals: maps.map((m) => dates.map((d) => m.get(d))) }; }
  // the last value dated on or before a date (binary search) → { d, v } or null
  function valueAt(s, date) { let lo = 0, hi = s.d.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.d[m] <= date) { k = m; lo = m + 1; } else hi = m - 1; } return k < 0 ? null : { d: s.d[k], v: s.v[k] }; }
  const periodKey = (d, reb) => (reb === "M" ? d.slice(0, 7) : reb === "Q" ? d.slice(0, 4) + "Q" + Math.floor((Number(d.slice(5, 7)) - 1) / 3) : reb === "Y" ? d.slice(0, 4) : null);
  // prices: one array per asset on the same ascending dates; weights: target fractions adding up to 1; noTrade[i]: cash
  // (holding it is not a trade). initial: invested on the first date at the target weights; monthly: added on the first
  // date of each later month and bought at the target weights; rebalance 'none' | 'M' | 'Q' | 'Y': back to the target weights
  // on the first date of each period; cost: a fixed amount per trade (each asset bought or sold once counts one trade).
  // → value, money put in, time-weighted index (flows taken out), trades, costs.
  function backtest({ dates, prices, weights, noTrade = [], initial = 10000, monthly = 0, rebalance = "none", cost = 0 }) {
    const n = dates.length, k = prices.length; if (n < 2 || !k || !(initial > 0)) return null;
    const units = new Array(k).fill(0), value = new Float64Array(n), invested = new Float64Array(n), idx = new Float64Array(n); let trades = 0, costs = 0;
    const val = (t) => { let v = 0; for (let i = 0; i < k; i++) v += units[i] * prices[i][t]; return v; };
    const tradeable = weights.map((w, i) => w > 0 && !noTrade[i]);
    // back to the target weights with `total` (counting a trade for each asset whose holding changes), less the costs
    const toTarget = (t, total) => { let m = 0; const want = weights.map((w, i) => (total * w) / prices[i][t]);
      for (let i = 0; i < k; i++) if (!noTrade[i] && Math.abs(want[i] - units[i]) * prices[i][t] > 0.005) m++;
      const net = total - m * cost; for (let i = 0; i < k; i++) units[i] = (net * weights[i]) / prices[i][t]; trades += m; costs += m * cost; };
    toTarget(0, initial); value[0] = val(0); invested[0] = initial; idx[0] = 1;
    let put = initial;
    for (let t = 1; t < n; t++) {
      const newMonth = dates[t].slice(0, 7) !== dates[t - 1].slice(0, 7), pk = periodKey(dates[t], rebalance), reb = pk != null && pk !== periodKey(dates[t - 1], rebalance);
      const before = val(t), flow = newMonth && monthly > 0 ? monthly : 0;
      if (reb) toTarget(t, before + flow);
      else if (flow) { const m = tradeable.filter(Boolean).length, net = flow - m * cost; for (let i = 0; i < k; i++) units[i] += (net * weights[i]) / prices[i][t]; trades += m; costs += m * cost; }
      put += flow; value[t] = val(t); invested[t] = put;
      idx[t] = idx[t - 1] * ((value[t] - flow) / value[t - 1]);
    }
    return { dates, value: Array.from(value), invested: Array.from(invested), idx: Array.from(idx), trades, costs, initial, monthly, rebalance, final: value[n - 1], put };
  }
  // money-weighted return (annual) of dated flows [{ t: ms, a }] — money put in negative, the final value positive — by bisection
  function xirr(flows) { if (flows.length < 2) return NaN; const t0 = flows[0].t, f = (r) => flows.reduce((s, x) => s + x.a / Math.pow(1 + r, (x.t - t0) / YEAR_MS), 0);
    let lo = -0.99, hi = 10, flo = f(lo); if (!(flo * f(hi) < 0)) return NaN;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2, fm = f(mid); if (Math.abs(fm) < 1e-7 || hi - lo < 1e-10) return mid; if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; } } return (lo + hi) / 2; }
  function btFlows(bt) { const out = [{ t: Date.parse(bt.dates[0] + "T12:00:00Z"), a: -bt.initial }];
    for (let t = 1; t < bt.dates.length; t++) if (bt.invested[t] > bt.invested[t - 1]) out.push({ t: Date.parse(bt.dates[t] + "T12:00:00Z"), a: -(bt.invested[t] - bt.invested[t - 1]) });
    out.push({ t: Date.parse(bt.dates[bt.dates.length - 1] + "T12:00:00Z") + 1, a: bt.final }); return out; }
  // the statistics of a time-weighted index on its dates: total, CAGR, volatility, Sharpe, Sortino, drawdowns, years, months
  function perfStats(dates, idx, rf = 0) { const n = idx.length; if (n < 2) return null; const r = []; for (let i = 1; i < n; i++) r.push(idx[i] / idx[i - 1] - 1);
    const yrs = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / YEAR_MS, total = idx[n - 1] / idx[0] - 1, cagr = yrs > 0 ? Math.pow(1 + total, 1 / yrs) - 1 : NaN, ppy = yrs > 0 ? r.length / yrs : 252;
    const vol = stdev(r) * Math.sqrt(ppy), down = Math.sqrt(r.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / r.length) * Math.sqrt(ppy);
    let peak = idx[0], pi = 0, mdd = 0, mp = 0, mt = 0; const dd = new Array(n);
    for (let i = 0; i < n; i++) { if (idx[i] > peak) { peak = idx[i]; pi = i; } dd[i] = idx[i] / peak - 1; if (dd[i] < mdd) { mdd = dd[i]; mp = pi; mt = i; } }
    let rec = null; for (let i = mt; i < n; i++) if (idx[i] >= idx[mp]) { rec = i; break; }
    const lastOf = (len) => { const m = new Map(); dates.forEach((d, i) => m.set(d.slice(0, len), i)); return [...m.entries()]; };
    const years = [], ye = lastOf(4); ye.forEach(([y, i], j) => { const i0 = j ? ye[j - 1][1] : 0; years.push({ y, r: idx[i] / idx[i0] - 1, partial: (j === 0 && !/-01-0[1-7]$/.test(dates[0])) || (j === ye.length - 1 && !/-12-(2[4-9]|3[01])$/.test(dates[i])) }); });
    const months = [], me = lastOf(7); for (let j = 1; j < me.length; j++) months.push({ m: me[j][0], r: idx[me[j][1]] / idx[me[j - 1][1]] - 1 });
    const full = months.slice(0, /-(2[5-9]|3[01])$/.test(dates[n - 1]) ? months.length : months.length - 1), mr = full.map((x) => x.r);
    return { total, cagr, vol, down, sharpe: vol > 0 ? (cagr - rf) / vol : NaN, sortino: down > 0 ? (cagr - rf) / down : NaN, maxDD: mdd, calmar: mdd < 0 ? cagr / -mdd : NaN,
      ddPeak: dates[mp], ddTrough: dates[mt], ddRecovered: rec != null ? dates[rec] : null, dd, years, months: full, posMonths: mr.length ? mr.filter((x) => x > 0).length / mr.length : NaN,
      bestMonth: mr.length ? Math.max(...mr) : NaN, worstMonth: mr.length ? Math.min(...mr) : NaN, yearsN: yrs, ppy, nDays: r.length, from: dates[0], to: dates[n - 1] }; }
  // risk on the last `win` common dates at constant target weights: volatility, each asset's share of it, correlations,
  // diversification ratio, 1-day historical VaR / ES, beta and correlation with a benchmark (its values on the same dates)
  function portfolioRisk({ prices, weights, bench = null, win = 756 }) { const n = prices[0].length, s = Math.max(0, n - win - 1), k = prices.length;
    const R = prices.map((p) => { const r = []; for (let t = s + 1; t < n; t++) r.push(p[t] / p[t - 1] - 1); return r; }), T = R[0].length; if (T < 60) return null;
    const rp = []; for (let t = 0; t < T; t++) { let x = 0; for (let i = 0; i < k; i++) x += weights[i] * R[i][t]; rp.push(x); }
    const m = R.map(mean), cov = R.map((a, i) => R.map((b, j) => { let c = 0; for (let t = 0; t < T; t++) c += (a[t] - m[i]) * (b[t] - m[j]); return (c / (T - 1)) * 252; }));
    const vols = cov.map((r, i) => Math.sqrt(Math.max(0, r[i]))), vp = Math.sqrt(Math.max(0, weights.reduce((a, w, i) => a + w * weights.reduce((b, v, j) => b + v * cov[i][j], 0), 0)));
    const corr = cov.map((r, i) => r.map((c, j) => (vols[i] > 0 && vols[j] > 0 ? c / (vols[i] * vols[j]) : NaN))), rc = vp > 0 ? riskContrib(cov, weights) : weights.map(() => NaN);
    const srt = sorted(rp), q = (p) => quantileSorted(srt, p), es = (p) => { const v = q(p), tail = rp.filter((x) => x <= v); return tail.length ? mean(tail) : NaN; };
    let beta = NaN, bcorr = NaN, bvol = NaN; if (bench) { const rb = []; for (let t = s + 1; t < n; t++) rb.push(bench[t] / bench[t - 1] - 1); const o = ols(rp, rb); if (o) { beta = o.beta; bcorr = o.corr; } bvol = stdev(rb) * SQ252; }
    const dr = vp > 0 ? weights.reduce((a, w, i) => a + w * vols[i], 0) / vp : NaN;
    return { days: T, vol: vp, vols, cov, corr, rc, divRatio: dr, var95: -q(0.05), es95: -es(0.05), var99: -q(0.01), es99: -es(0.01), worstDay: srt[0], bestDay: srt[srt.length - 1], beta, benchCorr: bcorr, benchVol: bvol }; }
  // a window [from, to]: each asset's return from its last value on or before `from` to the last on or before `to`, at the
  // target weights (held through the window); an asset without a value within 7 days before `from` makes the window N/A
  function stressWindow(series, weights, from, to) { const rows = []; let tot = 0; const miss = [];
    series.forEach((s, i) => { if (!s) { rows.push({ i, r: 0 }); return; } const a = valueAt(s, from), b = valueAt(s, to);
      if (!a || !b || Date.parse(from) - Date.parse(a.d) > 7 * DAY_MS || b.d <= a.d) { miss.push(i); return; } const r = b.v / a.v - 1; rows.push({ i, r }); tot += weights[i] * r; });
    return miss.length ? { na: true, missing: miss } : { r: tot, rows }; }
  // Monte Carlo of the value ahead from the portfolio's own past monthly returns, drawn in blocks (keeps some of their
  // order); `monthly` added at each month end. Numbered runs, reproducible. → percentiles over time, the probability of
  // reaching `target`, of ending below the money put in. A model of possible outcomes from the past, not a forecast.
  function projectGoal({ monthlyR, months, start, monthly = 0, paths = 5000, run = 1, block = 6, target = 0 }) {
    const n = monthlyR.length; if (n < 24 || !(months > 0) || !(start >= 0) || (!(start > 0) && !(monthly > 0))) return null;
    const rng = mulberry32(run * 7919 + 17), step = months <= 240 ? 1 : 3, cps = []; for (let m = step; m <= months; m += step) cps.push(m); if (cps[cps.length - 1] !== months) cps.push(months);
    const at = cps.map(() => new Float32Array(paths)), fin = new Float64Array(paths);
    for (let p = 0; p < paths; p++) { let v = start, pos = 0, c = 0;
      for (let m = 1; m <= months; m++) { if ((m - 1) % block === 0) pos = Math.floor(rng() * n); const r = monthlyR[(pos + ((m - 1) % block)) % n]; v = v * (1 + r) + monthly; if (m === cps[c]) { at[c][p] = v; c++; } }
      fin[p] = v; }
    const P = [0.05, 0.25, 0.5, 0.75, 0.95], bands = at.map((a) => { const s = Float64Array.from(a).sort(); return P.map((x) => quantileSorted(s, x)); });
    const sf = Float64Array.from(fin).sort(), put = start + monthly * months;
    return { months, cps, bands, put, median: quantileSorted(sf, 0.5), p5: quantileSorted(sf, 0.05), p95: quantileSorted(sf, 0.95), mean: mean(Array.from(fin)),
      pTarget: target > 0 ? fin.filter((v) => v >= target).length / paths : NaN, pBelowPut: fin.filter((v) => v < put).length / paths, paths, run, block, n }; }

  // ---------- WHAT IF: purchases on real history (one-off or monthly), valued every day at real closes ----------
  const ymdAdd = (d, months) => { const [y, m, dd] = d.split("-").map(Number), t = y * 12 + (m - 1) + months, Y = Math.floor(t / 12), M = (t % 12) + 1, last = new Date(Date.UTC(Y, M, 0)).getUTCDate(); return `${Y}-${String(M).padStart(2, "0")}-${String(Math.min(dd, last)).padStart(2, "0")}`; };
  // the dates of a plan: one date, or the same day each month from `from` to `to`
  function planDates(kind, from, to) { if (kind !== "monthly") return [from]; const out = []; for (let k = 0; k < 600; k++) { const d = ymdAdd(from, k); if (d > to) break; out.push(d); } return out; }
  const firstOnOrAfter = (s, date) => { let lo = 0, hi = s.d.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.d[m] >= date) { k = m; hi = m - 1; } else lo = m + 1; } return k; };
  // items: [{ s: { d, v }, flows: [{ date, amount, fee }] }] — each flow bought at the close of the first day the instrument
  // traded on or after its date (none within 7 days: not bought, listed); every day valued at each one's last close on or
  // before it. bench: the same money on the same dates into one series. → per item, the total, the daily value and index.
  function whatIf({ items, bench = null }) {
    const ex = items.map((it) => { const done = [], miss = [];
      for (const f of it.flows) { const k = firstOnOrAfter(it.s, f.date); if (k < 0 || Date.parse(it.s.d[k]) - Date.parse(f.date) > 7 * DAY_MS || !(f.amount > (f.fee || 0))) { miss.push(f); continue; } done.push({ k, d: it.s.d[k], amount: f.amount, fee: f.fee || 0, units: (f.amount - (f.fee || 0)) / it.s.v[k], px: it.s.v[k] }); }
      return { done, miss }; });
    const all = ex.flatMap((e) => e.done.map((x) => x.d)); if (!all.length) return null;
    const d0 = all.reduce((a, b) => (a < b ? a : b)), set = new Set(); items.forEach((it) => it.s.d.forEach((d) => { if (d >= d0) set.add(d); })); const dates = [...set].sort();
    const n = dates.length, value = new Float64Array(n), invested = new Float64Array(n), flow = new Float64Array(n), idx = new Float64Array(n), ptr = items.map(() => -1), units = items.map(() => 0), qi = items.map(() => 0), byDate = new Map();
    ex.forEach((e, i) => e.done.forEach((x) => { const a = byDate.get(x.d) || []; a.push([i, x]); byDate.set(x.d, a); }));
    let put = 0;
    for (let t = 0; t < n; t++) { const d = dates[t];
      for (const [i, x] of byDate.get(d) || []) { units[i] += x.units; put += x.amount; flow[t] += x.amount; }
      let v = 0; items.forEach((it, i) => { while (ptr[i] + 1 < it.s.d.length && it.s.d[ptr[i] + 1] <= d) ptr[i]++; if (units[i] && ptr[i] >= 0) v += units[i] * it.s.v[ptr[i]]; });
      value[t] = v; invested[t] = put; idx[t] = t === 0 || !(value[t - 1] > 0) ? 1 : idx[t - 1] * ((v - flow[t]) / value[t - 1]); }
    const end = dates[n - 1], tEnd = Date.parse(end + "T12:00:00Z") + 1;
    const rows = items.map((it, i) => { const e = ex[i], last = it.s.d.length - 1, px = it.s.v[last], u = e.done.reduce((a, x) => a + x.units, 0), inv = e.done.reduce((a, x) => a + x.amount, 0), fees = e.done.reduce((a, x) => a + x.fee, 0), val = u * px;
      const fl = e.done.map((x) => ({ t: Date.parse(x.d + "T12:00:00Z"), a: -x.amount })).concat(u ? [{ t: tEnd, a: val }] : []);
      return { units: u, invested: inv, fees, value: val, gain: val - inv, gainPct: inv > 0 ? val / inv - 1 : NaN, irr: fl.length > 1 ? xirr(fl) : NaN, price: px, priceDate: it.s.d[last], avgPx: u > 0 ? (inv - fees) / u : NaN, buys: e.done.length, first: e.done.length ? e.done[0].d : null, missed: e.miss }; });
    const tot = { invested: put, value: value[n - 1], gain: value[n - 1] - put, irr: xirr(ex.flatMap((e) => e.done.map((x) => ({ t: Date.parse(x.d + "T12:00:00Z"), a: -x.amount }))).sort((a, b) => a.t - b.t).concat([{ t: tEnd, a: value[n - 1] }])) };
    let B = null;
    if (bench) { const bu = []; let bput = 0; const bflows = [];
      ex.forEach((e) => e.done.forEach((x) => { const k = firstOnOrAfter(bench, x.d); if (k >= 0 && Date.parse(bench.d[k]) - Date.parse(x.d) <= 7 * DAY_MS) { bu.push([bench.d[k], (x.amount - x.fee) / bench.v[k], x.amount]); bflows.push({ t: Date.parse(bench.d[k] + "T12:00:00Z"), a: -x.amount }); } }));
      bu.sort((a, b) => (a[0] < b[0] ? -1 : 1)); const bv = new Float64Array(n); let j = -1, k2 = 0, u = 0;
      for (let t = 0; t < n; t++) { while (k2 < bu.length && bu[k2][0] <= dates[t]) { u += bu[k2][1]; bput += bu[k2][2]; k2++; } while (j + 1 < bench.d.length && bench.d[j + 1] <= dates[t]) j++; bv[t] = j >= 0 ? u * bench.v[j] : 0; }
      B = { value: Array.from(bv), final: bv[n - 1], put: bput, irr: xirr(bflows.sort((a, b) => a.t - b.t).concat([{ t: tEnd, a: bv[n - 1] }])), bought: bflows.length }; }
    return { dates, value: Array.from(value), invested: Array.from(invested), idx: Array.from(idx), rows, total: tot, bench: B, from: dates[0], to: end }; }
  // ---------- YAS: a fixed-coupon bond — accrued interest, yield to maturity, durations, convexity, cash flows ----------
  const dayN = (d) => Date.parse(d + "T12:00:00Z") / DAY_MS;
  const d30e = (a, b) => { const [y1, m1, x1] = a.split("-").map(Number), [y2, m2, x2] = b.split("-").map(Number); return 360 * (y2 - y1) + 30 * (m2 - m1) + (Math.min(x2, 30) - Math.min(x1, 30)); };
  // coupon dates counted back from maturity every 12/freq months: the last one on or before settlement, the ones after it
  function bondSchedule(maturity, freq, settle) { const step = 12 / freq, after = []; let k = 0, d = maturity;
    while (d > settle && k < 2000) { after.unshift(d); k++; d = ymdAdd(maturity, -k * step); } return { prev: d, next: after[0], dates: after }; }
  // coupon in % a year, clean price per 100; ACT/ACT (ICMA) or 30E/360 for the accrued interest; yield compounded `freq`
  // times a year (the market convention for BTP semi-annual, Bund / OAT annual); tax: on coupons and on a gain at maturity
  function bondCalc({ coupon, freq = 1, maturity, settle, clean, redemption = 100, basis = "ACT", tax = 0 }) {
    if (!(freq > 0) || !maturity || !settle || !(maturity > settle) || !(clean > 0)) return null;
    const S = bondSchedule(maturity, freq, settle), c = coupon / freq, frac = basis === "30E" ? d30e(S.prev, settle) / (360 / freq) : (dayN(settle) - dayN(S.prev)) / (dayN(S.next) - dayN(S.prev));
    const accrued = c * frac, dirty = clean + accrued, w = 1 - frac, n = S.dates.length;
    const cfs = S.dates.map((d, i) => ({ d, t: w + i, cf: c + (i === n - 1 ? redemption : 0) }));
    const pv = (y, list = cfs) => list.reduce((a, x) => a + x.cf / Math.pow(1 + y / freq, x.t), 0);
    const solve = (target, list) => { let lo = -0.9 * freq, hi = 5; if ((pv(lo, list) - target) * (pv(hi, list) - target) > 0) return NaN; for (let i = 0; i < 300; i++) { const m = (lo + hi) / 2, f = pv(m, list) - target; if (Math.abs(f) < 1e-11) return m; if (f > 0) lo = m; else hi = m; } return (lo + hi) / 2; };
    const y = solve(dirty, cfs); if (!fin(y)) return null;
    const v = 1 + y / freq, PV = cfs.map((x) => x.cf / Math.pow(v, x.t)), P = PV.reduce((a, b) => a + b, 0);
    const mac = cfs.reduce((a, x, i) => a + (x.t / freq) * PV[i], 0) / P, mod = mac / v, conv = cfs.reduce((a, x, i) => a + x.t * (x.t + 1) * PV[i], 0) / (P * v * v * freq * freq);
    const dv01 = (pv(y - 0.0001) - pv(y + 0.0001)) / 2;
    const net = cfs.map((x, i) => ({ ...x, cf: c * (1 - tax) + (i === n - 1 ? redemption - tax * Math.max(0, redemption - clean) : 0) })), yNet = tax > 0 ? solve(dirty, net) : y;
    const shocks = [-200, -100, -50, 50, 100, 200].map((bp) => { const p2 = pv(y + bp / 10000); return { bp, dirty: p2, clean: p2 - accrued, chg: p2 / dirty - 1 }; });
    const years = (dayN(maturity) - dayN(settle)) / 365.25;
    return { ytm: y, effective: Math.pow(v, freq) - 1, current: coupon / clean, accrued, dirty, clean, prev: S.prev, next: S.next, flows: cfs.map((x, i) => ({ d: x.d, coupon: c, principal: i === n - 1 ? redemption : 0, pv: PV[i], net: net[i].cf })), macaulay: mac, modified: mod, convexity: conv, dv01, ytmNet: yNet, effectiveNet: fin(yNet) ? Math.pow(1 + yNet / freq, freq) - 1 : NaN, shocks, years, n, frac };
  }
  // the price for a yield (to go back the other way)
  function bondPrice({ coupon, freq = 1, maturity, settle, ytm, redemption = 100, basis = "ACT" }) { if (!(maturity > settle)) return null; const S = bondSchedule(maturity, freq, settle), c = coupon / freq, frac = basis === "30E" ? d30e(S.prev, settle) / (360 / freq) : (dayN(settle) - dayN(S.prev)) / (dayN(S.next) - dayN(S.prev)), w = 1 - frac;
    const dirty = S.dates.reduce((a, d, i) => a + (c + (i === S.dates.length - 1 ? redemption : 0)) / Math.pow(1 + ytm / freq, w + i), 0); return { dirty, accrued: c * frac, clean: dirty - c * frac }; }
  // ---------- what to buy this month: a contribution split among the target holdings so that the most underweight come
  //            up first — every holding bought ends at the same value / target-weight ratio (water filling), the rest
  //            untouched; optionally sales first (an overweight holding down to its target, a holding outside the target
  //            sold), then the money spread the same way. A minimum trade, a cost per trade and whole units respected.
  //            items: [{ w: target share 0..1 (0 = outside the target), v: value now (EUR), px: EUR a unit or null,
  //            avg: average cost a unit in EUR or null, buy: may be bought }] ----------
  function fill(V, W, ok, money) { // λ with Σ max(0, w λ − v) = money over the eligible ones → the buys
    const idx = V.map((_, i) => i).filter((i) => ok[i] && W[i] > 0).sort((a, b) => V[a] / W[a] - V[b] / W[b]), x = V.map(() => 0);
    if (!(money > 0) || !idx.length) return x;
    let sv = 0, sw = 0, lam = 0;
    for (let k = 0; k < idx.length; k++) { sv += V[idx[k]]; sw += W[idx[k]]; lam = (money + sv) / sw; const nx = idx[k + 1]; if (nx == null || lam <= V[nx] / W[nx]) { for (let j = 0; j <= k; j++) { const b = W[idx[j]] * lam - V[idx[j]]; x[idx[j]] = b > 1e-6 ? b : 0; } break; } }
    return x;
  }
  function buyPlan({ items, cash = 0, sell = false, minTrade = 0, cost = 0, whole = false }) {
    const n = items.length, W = items.map((x) => Math.max(0, +x.w || 0)), sw = W.reduce((a, b) => a + b, 0) || 1, w = W.map((x) => x / sw);
    const v0 = items.map((x) => Math.max(0, +x.v || 0)), T = v0.reduce((a, b) => a + b, 0), Tn = T + Math.max(0, cash);
    const trade = v0.map(() => 0), V = v0.slice();
    // sales first: down to the target (outside the target: all of it); a sale smaller than the minimum is not made
    if (sell) for (let i = 0; i < n; i++) { let s2 = V[i] - w[i] * Tn; if (s2 <= 0 || s2 < minTrade) continue; const px = items[i].px; if (whole && px > 0) s2 = Math.min(V[i], Math.floor(s2 / px + 1e-9) * px); if (!(s2 > 0)) continue; trade[i] = -s2; V[i] -= s2; }
    const sold = -trade.reduce((a, b) => a + (b < 0 ? b : 0), 0), nSell = trade.filter((b) => b < 0).length;
    // buys: the money left after the sales' costs; each buy costs `cost` too, so the number of buys is settled by repeating
    const ok = items.map((x, i) => x.buy !== false && w[i] > 0 && !(trade[i] < 0)); let x = V.map(() => 0);
    for (let it = 0; it < 60; it++) {
      const k = x.filter((b) => b > 0).length || ok.filter(Boolean).length, money = Math.max(0, cash) + sold - cost * (nSell + (it ? x.filter((b) => b > 0).length : k));
      x = fill(V, w, ok, money);
      const small = x.map((b, i) => [b, i]).filter(([b]) => b > 0 && b < minTrade).sort((a, b) => a[0] - b[0]);
      if (small.length) { ok[small[0][1]] = false; continue; }
      const k2 = x.filter((b) => b > 0).length, m2 = Math.max(0, cash) + sold - cost * (nSell + k2);
      if (Math.abs(x.reduce((a, b) => a + b, 0) - Math.max(0, m2)) < 1e-6) break;
    }
    // whole units: down to whole units, then one more unit at a time to the most underweight that the money still covers
    let units = items.map(() => null), spare = 0;
    if (whole) {
      x = x.map((b, i) => { const px = items[i].px; return b > 0 && px > 0 ? Math.floor(b / px + 1e-9) * px : b > 0 ? b : 0; });
      const buys = () => x.filter((b) => b > 0).length;
      spare = Math.max(0, cash) + sold - cost * (nSell + buys()) - x.reduce((a, b) => a + b, 0);
      for (let g = 0; g < 10000; g++) {
        let best = -1, gap = 0;
        for (let i = 0; i < n; i++) { const px = items[i].px; if (!ok[i] || !(px > 0)) continue; const need = px + (x[i] > 0 ? 0 : cost); if (need > spare + 1e-9) continue; const d = w[i] * Tn - (V[i] + x[i]); if (d > gap) { gap = d; best = i; } }
        if (best < 0) break; spare -= items[best].px + (x[best] > 0 ? 0 : cost); x[best] += items[best].px;
      }
    }
    for (let i = 0; i < n; i++) { if (x[i] > 0) trade[i] = x[i]; const px = items[i].px; units[i] = px > 0 && trade[i] ? trade[i] / px : null; }
    const nBuy = trade.filter((b) => b > 0).length, bought = trade.reduce((a, b) => a + (b > 0 ? b : 0), 0), costs = cost * (nBuy + nSell);
    const after = v0.map((b, i) => b + trade[i]), Ta = after.reduce((a, b) => a + b, 0);
    const rows = items.map((it, i) => {
      const gain = trade[i] < 0 && it.px > 0 && it.avg != null ? (-trade[i] / it.px) * (it.px - it.avg) : null;
      return { w: w[i], v: v0[i], now: T > 0 ? v0[i] / T : NaN, drift: T > 0 ? v0[i] / T - w[i] : NaN, trade: trade[i], units: units[i], value: after[i], after: Ta > 0 ? after[i] / Ta : NaN, driftAfter: Ta > 0 ? after[i] / Ta - w[i] : NaN, gain };
    });
    // the largest gap of a holding of the target (one outside it is in the total but has no weight to be away from)
    const mx = (k) => rows.reduce((a, r, i) => (r.w > 0 && fin(r[k]) && Math.abs(r[k]) > Math.abs(a.d) ? { d: r[k], i } : a), { d: 0, i: -1 });
    const gains = rows.filter((r) => r.trade < 0), known = gains.every((r) => r.gain != null);
    return { total: T, cash: Math.max(0, cash), sold, bought, costs, spare: Math.max(0, cash) + sold - bought - costs, nBuy, nSell, totalAfter: Ta, rows, maxBefore: mx("drift"), maxAfter: mx("driftAfter"),
      gainSold: known ? gains.reduce((a, r) => a + r.gain, 0) : null, gainsKnown: known };
  }
  // ---------- a bond without a daily price: its estimate from a government curve. Each day the curve's yield at the
  //            bond's remaining maturity (linear between the two nearest maturities quoted that day — a quote older than
  //            `maxGap` days does not count — flat beyond the shortest and the longest), plus a constant spread, priced
  //            with bondPrice; coupons reinvested in the bond on their payment day. The spread: today's price (clean, as
  //            typed) against the curve on the last day, or 0. curves: [{ months, d: [...], v: [yield %] }] ----------
  function curveYield(pts, months) { if (!pts.length) return NaN; if (months <= pts[0][0]) return pts[0][1]; const n = pts.length; if (months >= pts[n - 1][0]) return pts[n - 1][1];
    for (let i = 1; i < n; i++) if (months <= pts[i][0]) { const [m0, y0] = pts[i - 1], [m1, y1] = pts[i]; return y0 + ((y1 - y0) * (months - m0)) / (m1 - m0); } return NaN; }
  function bondHistory({ coupon, freq = 1, maturity, start, curves, price = null, maxGap = 7, redemption = 100 }) {
    const cs = (curves || []).filter((c) => c && c.d && c.d.length && fin(c.months)).slice().sort((a, b) => a.months - b.months);
    if (!cs.length || !maturity || !(freq > 0)) return null;
    const days = [...new Set(cs.flatMap((c) => c.d))].filter((d) => d >= (start || "") && d < maturity).sort();
    const ptr = cs.map(() => -1), mat = dayN(maturity), MONTH_DAYS = 365.25 / 12;
    const at = (day) => { const pts = []; cs.forEach((c, k) => { while (ptr[k] + 1 < c.d.length && c.d[ptr[k] + 1] <= day) ptr[k]++; const j = ptr[k]; if (j >= 0 && dayN(day) - dayN(c.d[j]) <= maxGap && fin(c.v[j])) pts.push([c.months, c.v[j]]); }); return pts; };
    // pass 1: the curve's yield at the remaining maturity, each day
    const D = [], YC = [];
    for (const day of days) { const pts = at(day); if (!pts.length) continue; D.push(day); YC.push(curveYield(pts, (mat - dayN(day)) / MONTH_DAYS) / 100); }
    if (D.length < 2) return null;
    const last = D[D.length - 1]; let spread = 0, calib = null;
    if (fin(price) && price > 0) { const c = bondCalc({ coupon, freq, maturity, settle: last, clean: price, redemption }); if (c && fin(c.ytm)) { spread = c.ytm - YC[YC.length - 1]; calib = { date: last, price, ytm: c.ytm, curve: YC[YC.length - 1] }; } }
    // pass 2: prices and the total-return index
    const d = [], v = [], y = [], clean = []; let idx = null, prevDirty = null, prevDay = null;
    for (let i = 0; i < D.length; i++) { const day = D[i], yy = YC[i] + spread, p = bondPrice({ coupon, freq, maturity, settle: day, ytm: yy, redemption }); if (!p || !fin(p.dirty) || !(p.dirty > 0)) continue;
      let cpn = 0; if (prevDay && coupon) { const S = bondSchedule(maturity, freq, prevDay); for (const cd of S.dates) { if (cd > day) break; cpn += coupon / freq; } }
      idx = idx == null ? p.dirty : (idx * (p.dirty + cpn)) / prevDirty; prevDirty = p.dirty; prevDay = day;
      d.push(day); v.push(idx); y.push(yy); clean.push(p.clean); }
    if (d.length < 2) return null;
    return { d, v, y, clean, spread, calib, first: d[0], last: d[d.length - 1], curveLast: YC[YC.length - 1] };
  }
  // ---------- projection with the owner's assumptions: expected return (compound, a year) and volatility per holding,
  //            correlations from the past; monthly log-normal draws, rebalanced to the weights each month ----------
  function cholesky(A) { const n = A.length, L = A.map(() => new Array(n).fill(0)); for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; if (i === j) { if (!(s > 0)) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j]; } return L; }
  function projectAssumed({ mu, vol, corr, weights, months, start, monthly = 0, paths = 5000, run = 1, target = 0 }) {
    const k = mu.length; if (!k || !(months > 0) || !(start >= 0) || (!(start > 0) && !(monthly > 0))) return null;
    const m = mu.map((x) => Math.log(1 + x) / 12), s = vol.map((x) => Math.max(0, x) / Math.sqrt(12)), rnd = s.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
    const C = rnd.map((i) => rnd.map((j) => s[i] * s[j] * (i === j ? 1 : fin(corr && corr[i] && corr[i][j]) ? corr[i][j] : 0)));
    let L = cholesky(C); if (!L && C.length) L = cholesky(C.map((r, i) => r.map((v, j) => (i === j ? v : v * 0.98)))); if (!L && C.length) L = C.map((r, i) => r.map((v, j) => (i === j ? Math.sqrt(v) : 0)));
    const rng = mulberry32(run * 7919 + 29), gauss = () => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
    const step = months <= 240 ? 1 : 3, cps = []; for (let q = step; q <= months; q += step) cps.push(q); if (cps[cps.length - 1] !== months) cps.push(months);
    const at = cps.map(() => new Float32Array(paths)), fin2 = new Float64Array(paths), z = new Array(rnd.length);
    for (let p = 0; p < paths; p++) { let v = start, c2 = 0;
      for (let q = 1; q <= months; q++) { for (let a = 0; a < rnd.length; a++) z[a] = gauss(); let r = 0;
        for (let i = 0; i < k; i++) { let x = m[i]; const a = rnd.indexOf(i); if (a >= 0) for (let b = 0; b <= a; b++) x += L[a][b] * z[b]; r += weights[i] * (Math.exp(x) - 1); }
        v = v * (1 + r) + monthly; if (q === cps[c2]) { at[c2][p] = v; c2++; } }
      fin2[p] = v; }
    const P = [0.05, 0.25, 0.5, 0.75, 0.95], bands = at.map((a) => { const so = Float64Array.from(a).sort(); return P.map((x) => quantileSorted(so, x)); }), sf = Float64Array.from(fin2).sort(), put = start + monthly * months;
    return { months, cps, bands, put, median: quantileSorted(sf, 0.5), p5: quantileSorted(sf, 0.05), p95: quantileSorted(sf, 0.95), mean: mean(Array.from(fin2)), pTarget: target > 0 ? fin2.filter((x) => x >= target).length / paths : NaN, pBelowPut: fin2.filter((x) => x < put).length / paths, paths, run, assumed: true }; }

  // align several date-ordered closes on the dates they all have → { dates, closes: [[...], ...] }
  function align(series) { const maps = series.map((s) => new Map(s.map((p) => [String(p.t).slice(0, 10), p.c]))); const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.get(d) > 0)).sort();
    return { dates, closes: maps.map((m) => dates.map((d) => m.get(d))) }; }

  const QUANT = { mean, variance, stdev, skewness, exKurtosis, quantileSorted, logReturns, simpleReturns, normCdf, normInv, normPdf, chi2Sf, gammaQ,
    distStats, acf, ljungBox, histogram, ewmaSigma, riskMeasures, varBacktest, cornishFisherZ, rangeVol, yangZhang, rollingVol, volCone, nelderMead, garch11,
    ols, regression, olsMulti, invert, tP2, betaI, FACTOR_MODELS, factorFit, rollingFactorFit, alignDV, valueAt, backtest, xirr, btFlows, perfStats, portfolioRisk, stressWindow, projectGoal, planDates, whatIf, bondSchedule, bondCalc, bondPrice, curveYield, bondHistory, buyPlan, cholesky, projectAssumed, moments, projSimplex, meanVar, frontier, maxSharpe, riskParity, riskContrib, optimize, mulberry32, monteCarlo, monthlySeason, weekdaySeason, align };
  root.QUANT = QUANT;
  if (typeof module !== "undefined" && module.exports) module.exports = QUANT;
})(typeof window !== "undefined" ? window : globalThis);
