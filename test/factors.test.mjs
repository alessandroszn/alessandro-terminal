// Factor exposure (src/factors.mjs + qmath.js FACT): the Kenneth R. French Data Library's ZIP / CSV layout, the KV copy
// refreshed at most once a day (STALE on failure, no retry for 6 hours), the CNBC listing behind each id, month-end
// closes converted to USD, the route, and the regression recovering betas a series was built with. Fixtures are in the
// providers' formats (test inputs only — nothing here is shown in the terminal).
//   node test/factors.test.mjs
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { parseFf, mergeFf, loadFactors, factorTarget, uniMaps, monthEnds, valuesOn, monthlyUsd, autoRegion, handleFactors, FF_BASE, FF_REGIONS } from "../src/factors.mjs";
import { app as worker } from "../src/worker.mjs";
const require = createRequire(import.meta.url);
const Q = require("../public/terminal/qmath.js");

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- the library's files: ZIP of one CSV, header line starting with a comma, monthly rows, annual rows ----------
function zip(name, text) {
  const data = deflateRawSync(Buffer.from(text)), nb = Buffer.from(name), raw = Buffer.from(text);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nb.length, 12); end.writeUInt32LE(30 + nb.length + data.length, 16);
  const b = Buffer.concat([lh, nb, data, ch, nb, end]); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
// a numbered generator → factor returns in % (fixtures only)
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const g = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const MONTHS = []; for (let y = 2016; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 8) break; MONTHS.push(`${y}${String(m).padStart(2, "0")}`); }
const FAC = MONTHS.map(() => ({ mkt: g() * 4.2 + 0.7, smb: g() * 2, hml: g() * 2.5, rmw: g() * 1.5, cma: g() * 1.5, mom: g() * 3, rf: 0.1 + rnd() * 0.3 }));
const f2 = (v) => v.toFixed(2).padStart(7);
const FIVE = ["This file was created using the 202608 Bloomberg database.", "Missing data are indicated by -99.99.", "", ",Mkt-RF,SMB,HML,RMW,CMA,RF",
  ...MONTHS.map((m, i) => `${m},${f2(FAC[i].mkt)},${f2(FAC[i].smb)},${f2(FAC[i].hml)},${f2(FAC[i].rmw)},${f2(i === 3 ? -99.99 : FAC[i].cma)},${f2(FAC[i].rf)}`),
  "", " Annual Factors: January-December ", ",Mkt-RF,SMB,HML,RMW,CMA,RF", "2017,  21.50,  1.20, -3.40,  2.10, -1.00,  0.80", ""].join("\r\n");
const MOM = ["This file was created using the 202608 Bloomberg database.", "", "            ,WML", ...MONTHS.map((m, i) => `${m},${f2(FAC[i].mom)}`), "", " Annual Factors: January-December ", "            ,WML", "2017,  10.00"].join("\r\n");

const p5 = parseFf(FIVE), pm = parseFf(MOM);
ok("CSV: header found by its leading comma, monthly rows only (the annual block left out), % → decimal", p5.cols.join() === "mkt,smb,hml,rmw,cma,rf" && p5.rows.length === MONTHS.length && p5.rows[0].month === "2016-01" && near(p5.rows[0].mkt, Number(f2(FAC[0].mkt)) / 100, 1e-12), JSON.stringify(p5.rows[0]));
ok("…-99.99 is a missing value (null), never a number", p5.rows[3].cma === null && p5.rows[4].cma !== null);
ok("…the momentum file (WML) and the U.S. one (Mom) both read as mom", pm.cols.join() === "mom" && parseFf("x\n ,Mom   \n192701,   0.36\n").rows[0].mom === 0.0036);
ok("…a file without the header → null (nothing made up)", parseFf("no table here\n199001, 1.0") === null && parseFf("") === null);
const mg = mergeFf(p5, pm);
ok("merge: one row a month [month, mkt, smb, hml, rmw, cma, mom, rf]", mg.cols.join() === "mkt,smb,hml,rmw,cma,mom,rf" && mg.rows.length === MONTHS.length && mg.rows[10][0] === "2016-11" && near(mg.rows[10][6], Number(f2(FAC[10].mom)) / 100, 1e-12));

// ---------- the KV copy: once a day, STALE when the library fails, no new try for 6 hours ----------
const kv = new Map(), writes = [];
const env = { BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v, o) => { kv.set(k, v); writes.push([k, o && o.expirationTtl]); } } };
let calls = [], down = false;
const ffFetch = async (url) => { calls.push(url); if (down) return { err: "provider_unreachable" }; const f = url.slice(FF_BASE.length); return { buf: zip(f.replace("_CSV.zip", ".csv"), /Mom/.test(f) ? MOM : FIVE) }; };
const T0 = Date.parse("2026-10-21T10:00:00Z");
let L = await loadFactors(env, "dev", T0, ffFetch);
ok("first use: both Developed files downloaded, kept in KV (one write), LIVE, last month published", L.status === "LIVE" && calls.length === 2 && calls.every((u) => u.startsWith(FF_BASE + "Developed_")) && writes.length === 1 && writes[0][0] === "ff/dev" && L.data.asOf === "2026-08" && L.data.rows.length === MONTHS.length, JSON.stringify({ calls, writes, s: L.status }));
calls = []; L = await loadFactors(env, "dev", T0 + 3600_000, ffFetch);
ok("…within a day: the KV copy, no download", L.status === "LIVE" && calls.length === 0);
down = true; calls = []; writes.length = 0; L = await loadFactors(env, "dev", T0 + 25 * 3600_000, ffFetch);
ok("after a day with the library down: the last real copy, STALE with the reason; the failure noted (one write)", L.status === "STALE" && L.staleReason === "provider_unreachable" && L.data.asOf === "2026-08" && calls.length === 2 && writes.length === 1);
calls = []; L = await loadFactors(env, "dev", T0 + 26 * 3600_000, ffFetch);
ok("…not tried again for 6 hours", L.status === "STALE" && calls.length === 0);
const E = await loadFactors(env, "eu", T0, ffFetch);
ok("a region never read and the library down → an error, no factors made up", !E.data && E.err === "provider_unreachable");
ok("the U.S. files are the 2x3 research factors and the momentum factor", FF_REGIONS.us.files.join() === "F-F_Research_Data_5_Factors_2x3_CSV.zip,F-F_Momentum_Factor_CSV.zip");
down = false;

// ---------- which CNBC listing an id is read from ----------
let UNI; const t1 = factorTarget("IE00B4L5Y983"); UNI = uniMaps({ rows: [["LU0274208692", "XTR.MSCI WORLD 1C", "ETF", "Passive ETF", "A1XB5U", "DBXW:EUR"]] }); const t2 = factorTarget("LU0274208692", UNI);
ok("an ISIN of the UCITS list → its USD line (no conversion); an ISIN of the Xetra list → its Xetra EUR line", t1.cnbc === "IWDA-GB" && t1.ccy === "USD" && t2.cnbc === "DBXW-DE" && t2.ccy === null && t2.name === "XTR.MSCI WORLD 1C", JSON.stringify([t1, t2]));
const t3 = factorTarget("C:EUNL-DE"), t3b = factorTarget("C:DBXW-DE", UNI), t4 = factorTarget("SAP:XETR"), t5 = factorTarget("NVDA"), t6 = factorTarget("BTC/USD"), t7 = factorTarget("IE00BL25JP72");
ok("C:code of a fund's line → the fund's ISIN (UCITS list or Xetra list), SYMBOL:MIC → CNBC code, a plain symbol → U.S.; a pair or an unknown ISIN → an error", t3.cnbc === "EUNL-DE" && t3.ccy === "EUR" && t3.isin === "IE00B4L5Y983" && t3b.isin === "LU0274208692" && t3b.ccy === null && t4.cnbc === "SAP-DE" && t5.cnbc === "NVDA" && t5.us && t6.error === "unsupported" && t7.error === "not_listed", JSON.stringify([t3, t3b, t4, t5, t6, t7]));

// ---------- month-ends and USD ----------
const rows = [["2026-06-29", 10], ["2026-06-30", 11], ["2026-07-15", 12], ["2026-07-31", 12.1], ["2026-09-30", 13]];
ok("month-end = the last close dated in the month", JSON.stringify(monthEnds(rows)) === JSON.stringify([["2026-06", 11, "2026-06-30"], ["2026-07", 12.1, "2026-07-31"], ["2026-09", 13, "2026-09-30"]]));
ok("the close on or before each date, one pass", JSON.stringify(valuesOn([["2026-06-01", 1], ["2026-07-01", 2]], ["2026-05-31", "2026-06-15", "2026-08-01"])) === "[null,1,2]");
const fx = { "EUR=": [["2026-06-30", 1.1], ["2026-07-31", 1.2], ["2026-09-30", 1.25]] };
const mu = monthlyUsd(rows, "EUR", false, fx);
ok("EUR closes × USD per EUR of the same day; a missing month breaks the chain (no return across the gap)", mu.months.join() === "2026-07" && near(mu.r[0], (12.1 * 1.2) / (11 * 1.1) - 1, 1e-12), JSON.stringify(mu));
const gb = monthlyUsd([["2026-06-30", 500], ["2026-07-31", 510]], "GBP", true, { "GBP=": [["2026-06-30", 1.3], ["2026-07-31", 1.25]] });
ok("pence ÷ 100, GBP × USD per GBP", near(gb.r[0], (5.1 * 1.25) / (5 * 1.3) - 1, 1e-12));
const ch = monthlyUsd([["2026-06-30", 100], ["2026-07-31", 100]], "CHF", false, { "CHF=": [["2026-06-30", 0.8], ["2026-07-31", 0.9]] });
ok("CHF= is CHF per USD: divided, not multiplied", near(ch.r[0], 0.8 / 0.9 - 1, 1e-12));

// ---------- the region chosen ----------
const fo = (m) => (i) => m[i] || "";
ok("auto region: U.S. symbols → U.S.; a European focus → Europe; a world fund or a mix → Developed; emerging said", autoRegion([t5], fo({})).region === "us" && autoRegion([{ isin: "X", cnbc: "A-DE" }], fo({ X: "Equity, Europe" })).region === "eu" && autoRegion([{ isin: "X", cnbc: "A-DE" }], fo({ X: "Equity, World" })).region === "dev" && autoRegion([t5, t4], fo({})).region === "dev" && autoRegion([t4], fo({})).region === "eu" && autoRegion([{ isin: "X", cnbc: "A-DE" }], fo({ X: "Equity, Emerging Markets" })).emerging === true);

// ---------- the route, end to end: a EUR listing built from known betas, read back through the regression ----------
// USD returns = RF + 0.2 % + 1.1 Mkt + 0.3 SMB − 0.2 HML + 0.15 MOM + noise; priced in EUR at a moving EUR/USD; one bar a month
const B = { a: 0.002, mkt: 1.1, smb: 0.3, hml: -0.2, rmw: 0, cma: 0, mom: 0.15 };
let pUsd = 100, eurusd = 1.1; const bars = [["2015-12-30", 100 / 1.1]], fxBars = [["2015-12-30", 1.1]];
MONTHS.forEach((m, i) => {
  const f = FAC[i], r = f.rf / 100 + B.a + B.mkt * f.mkt / 100 + B.smb * f.smb / 100 + B.hml * f.hml / 100 + B.mom * f.mom / 100 + g() * 0.004;
  pUsd *= 1 + r; eurusd *= 1 + g() * 0.02; const d = `${m.slice(0, 4)}-${m.slice(4)}-28`;
  bars.push([d, pUsd / eurusd]); fxBars.push([d, eurusd]);
});
kv.set("ff/dev", JSON.stringify({ ...JSON.parse(kv.get("ff/dev")), fetchedAt: T0, failAt: undefined }));
const json = (b, H, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
const deps = { now: T0, loadQuotes: async (codes) => ({ data: Object.fromEntries(codes.map((c) => [c, { symbol: c, code: 0, currencyCode: c === "NVDA" ? "USD" : "EUR", name: c === "NVDA" ? "NVIDIA Corp" : "iShares Core MSCI World", countryCode: c === "NVDA" ? "US" : "DE" }])) }),
  daily: async (code) => (code === "EUR=" ? { data: fxBars } : code === "EUNL-DE" ? { data: bars } : code === "GBP=" || code === "CHF=" ? { data: fxBars } : { err: "no_data" }) };
const call = async (qs, d = deps) => { const r = await handleFactors(new URL("https://x.test/api/factors?" + qs), env, {}, {}, json, d); return { st: r.status, b: await r.json() }; };
let R = await call("ids=C:EUNL-DE&region=dev&years=5");
const it = R.b.items[0];
ok("route: the region's factors over the last 60 months to the last one published; the listing's monthly USD returns", R.st === 200 && R.b.region === "dev" && R.b.factors.rows.length === 60 && R.b.factors.rows[59][0] === "2026-08" && R.b.factors.rows[0][0] === "2021-09" && it.ccy === "EUR" && it.conv && it.conv.to === "USD" && it.months.length === 60, JSON.stringify({ st: R.st, n: R.b.factors && R.b.factors.rows.length, it: { ...it, r: undefined, months: it && it.months && it.months.length } }));
ok("…source, page and the library's status named; prices basis said", R.b.factors.source === "Kenneth R. French Data Library" && /dartmouth\.edu/.test(R.b.factors.sourceUrl) && R.b.factors.status === "LIVE" && /month-end/.test(R.b.basis));
// the page's side: excess returns on the six factors (qmath.js)
const FR = new Map(R.b.factors.rows.map((r) => [r[0], r])), cols = R.b.factors.cols, F = {};
for (const k of cols) F[k] = it.months.map((m) => FR.get(m)[cols.indexOf(k) + 1]);
const y = it.months.map((m, i) => it.r[i] - F.rf[i]), fit = Q.factorFit(y, F, Q.FACTOR_MODELS.ff6);
ok("regression recovers the betas the series was built with (USD, through the EUR conversion)", near(fit.betas.mkt.b, 1.1, 0.06) && near(fit.betas.smb.b, 0.3, 0.08) && near(fit.betas.hml.b, -0.2, 0.08) && near(fit.betas.mom.b, 0.15, 0.06) && near(fit.betas.rmw.b, 0, 0.12) && fit.r2 > 0.9, JSON.stringify(Object.fromEntries(Object.entries(fit.betas).map(([k, v]) => [k, +v.b.toFixed(3)]))) + " r2 " + fit.r2);
ok("…alpha a year ≈ 12 × 0.2 %; t of the market beta large; p-values in [0, 1]", near(fit.alphaAnn, 0.024, 0.02) && fit.betas.mkt.t > 20 && Object.values(fit.betas).every((b) => b.p >= 0 && b.p <= 1));
const shareSum = Object.values(fit.betas).reduce((a, b) => a + b.varShare, 0), retSum = Object.values(fit.betas).reduce((a, b) => a + b.retAnn, 0) + fit.alphaAnn;
ok("…variance shares add up to R²; the return contributions plus alpha add up to the average excess return (least-squares identities)", near(shareSum, fit.r2, 1e-9) && near(retSum, fit.meanAnn, 1e-9), `${shareSum} vs ${fit.r2}; ${retSum} vs ${fit.meanAnn}`);
const capm = Q.factorFit(y, F, Q.FACTOR_MODELS.capm), roll = Q.rollingFactorFit(y, F, Q.FACTOR_MODELS.ff6, 36);
ok("…CAPM explains less than the six factors; 36-month rolling betas: one row per window end", capm.r2 < fit.r2 && roll.length === 25 && roll.every((r) => r && r.length === 6));
R = await call("ids=C:EUNL-DE,NVDA,BTC/USD&region=auto&years=10");
ok("auto region with a mix → Developed; 10 years → 120 months; an unsupported id → its error, the others kept; a listing without bars → its error", R.st === 200 && R.b.region === "dev" && R.b.auto && R.b.auto.why === "mixed" && R.b.factors.rows.length === 120 && R.b.items[2].error === "unsupported" && R.b.items[1].error === "no_data" && R.b.items[0].months.length > 100, JSON.stringify(R.b.items.map((x) => x.error || x.months.length)));
R = await call("ids=C:EUNL-DE&region=asia");
ok("a region not offered → 400", R.st === 400);
R = await call("ids=" + Array.from({ length: 9 }, (_, i) => "A" + i).join(","));
ok("more than 8 ids → 400", R.st === 400);
R = await call("ids=C:SSAC-NL", { ...deps, loadQuotes: async () => ({ data: { "SSAC-NL": { symbol: "SSAC-NL", code: 0, currencyCode: "USD", countryCode: "US" } } }) });
ok("a venue code CNBC answers from the U.S. → not carried (never another instrument's prices)", R.st === 200 && R.b.items[0].error === "not_carried");
R = await call("ids=C:EUNL-DE", { ...deps, loadFactors: async () => ({ err: "provider_unreachable" }) });
ok("factors unavailable → 502 N/A with the source, no regression input", R.st === 502 && R.b.status === "N/A" && R.b.error === "provider_unreachable" && !R.b.items);
const wr = await worker.fetch(new Request("https://x.test/api/factors?ids="), { BRIEFS: env.BRIEFS }, { waitUntil() {} });
ok("the Worker routes /api/factors (no ids → 400)", wr.status === 400);

// ---------- qmath: multiple regression against closed forms ----------
const x1 = [1, 2, 3, 4, 5, 6, 7, 8], x2 = [2, 1, 4, 3, 6, 5, 8, 9], yy = x1.map((v, i) => 1 + 2 * v - 0.5 * x2[i]);
const o = Q.olsMulti(yy, [x1, x2]);
ok("olsMulti: an exact linear relation → its coefficients, R² 1", near(o.coef[0], 1, 1e-9) && near(o.coef[1], 2, 1e-9) && near(o.coef[2], -0.5, 1e-9) && near(o.r2, 1, 1e-12));
ok("…two identical columns → null (singular), never a made-up fit", Q.olsMulti(yy, [x1, x1]) === null);
const s1 = Q.ols([3, 5, 4, 8, 9, 12, 11, 15], x1), s2 = Q.olsMulti([3, 5, 4, 8, 9, 12, 11, 15], [x1]);
ok("…one regressor: the same beta, standard error and t as the simple regression", near(s2.coef[1], s1.beta, 1e-12) && near(s2.se[1], s1.seBeta, 1e-12) && near(s2.t[1], s1.tBeta, 1e-12));
ok("Student t two-sided p: t 2.0 / 60 df ≈ 0.0500; t 2.776 / 4 df ≈ 0.05; large df → normal", near(Q.tP2(2, 60), 0.05002, 1e-4) && near(Q.tP2(2.776, 4), 0.05, 1e-3) && near(Q.tP2(1.959964, 1e6), 0.05, 1e-4));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
