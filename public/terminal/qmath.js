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

  // align several date-ordered closes on the dates they all have → { dates, closes: [[...], ...] }
  function align(series) { const maps = series.map((s) => new Map(s.map((p) => [String(p.t).slice(0, 10), p.c]))); const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.get(d) > 0)).sort();
    return { dates, closes: maps.map((m) => dates.map((d) => m.get(d))) }; }

  const QUANT = { mean, variance, stdev, skewness, exKurtosis, quantileSorted, logReturns, simpleReturns, normCdf, normInv, normPdf, chi2Sf, gammaQ,
    distStats, acf, ljungBox, histogram, ewmaSigma, riskMeasures, varBacktest, cornishFisherZ, rangeVol, yangZhang, rollingVol, volCone, nelderMead, garch11,
    ols, regression, moments, projSimplex, meanVar, frontier, maxSharpe, riskParity, riskContrib, optimize, mulberry32, monteCarlo, monthlySeason, weekdaySeason, align };
  root.QUANT = QUANT;
  if (typeof module !== "undefined" && module.exports) module.exports = QUANT;
})(typeof window !== "undefined" ? window : globalThis);
