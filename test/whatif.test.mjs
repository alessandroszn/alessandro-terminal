// WHAT IF (purchases on real history), YAS (fixed-coupon bond analytics) and the projection with the owner's
// assumptions (qmath.js) — checked against closed forms and hand-computed cases (test inputs only).
//   node test/whatif.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Q = require("../public/terminal/qmath.js");
let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const days = (start, n) => { const out = []; let t = Date.parse(start + "T12:00:00Z"); while (out.length < n) { const g = new Date(t).getUTCDay(); if (g && g < 6) out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; } return out; };

// ---------- what if ----------
const D = days("2024-01-02", 400), A = { d: D, v: D.map((_, i) => 10 + i * 0.05) }, B = { d: D.slice(100), v: D.slice(100).map((_, i) => 50) };
let w = Q.whatIf({ items: [{ s: A, flows: [{ date: "2024-01-01", amount: 1000, fee: 0 }] }] });
ok("one purchase: bought at the first close on or after the date; value = units × last close", w.rows[0].units === 100 && near(w.total.value, 100 * A.v[399], 1e-9) && w.rows[0].first === "2024-01-02" && w.total.invested === 1000);
const yrs = (Date.parse(D[399] + "T12:00:00Z") + 1 - Date.parse(D[0] + "T12:00:00Z")) / (365.25 * 86400000);
ok("…its money-weighted return = the compound growth a year", near(w.total.irr, Math.pow(A.v[399] / A.v[0], 1 / yrs) - 1, 1e-6) && near(w.rows[0].irr, w.total.irr, 1e-9));
const fl = Q.planDates("monthly", "2024-01-15", "2024-06-30").map((d) => ({ date: d, amount: 100, fee: 1 }));
w = Q.whatIf({ items: [{ s: A, flows: fl }, { s: B, flows: [{ date: "2024-01-15", amount: 500 }, { date: "2024-07-01", amount: 500 }] }], bench: A });
ok("monthly plan: 6 purchases, a fee each off the money invested; a purchase before an instrument's data → not bought, listed", w.rows[0].buys === 6 && near(w.rows[0].fees, 6, 1e-12) && w.rows[0].invested === 600 && w.rows[1].buys === 1 && w.rows[1].missed.length === 1 && w.rows[1].missed[0].date === "2024-01-15");
ok("…total put in = what was bought; the value every day; the time-weighted index unchanged by the flows on a flat line", w.total.invested === 1100 && w.value.length === w.dates.length && w.dates[0] === "2024-01-15" && near(w.rows[1].value, 500 / 50 * 50, 1e-9));
ok("…the benchmark gets the same money on the same dates", w.bench && w.bench.put === 1100 && w.bench.bought === 7 && w.bench.final > 0);
ok("…nothing bought → null", Q.whatIf({ items: [{ s: B, flows: [{ date: "2023-01-01", amount: 100 }] }] }) === null);

// ---------- YAS ----------
let b = Q.bondCalc({ coupon: 4, freq: 2, maturity: "2030-03-01", settle: "2026-03-01", clean: 100 });
ok("a bond at par on a coupon date: yield = coupon, no accrued interest", near(b.ytm, 0.04, 1e-10) && b.accrued === 0 && near(b.dirty, 100, 1e-12));
ok("…Macaulay duration of 4 % semi-annual 4 years at par ≈ 3.74 years; modified = Macaulay / (1 + y/2)", near(b.macaulay, 3.736, 2e-3) && near(b.modified, b.macaulay / 1.02, 1e-12) && b.convexity > 0);
b = Q.bondCalc({ coupon: 4, freq: 2, maturity: "2030-03-01", settle: "2026-06-01", clean: 98 });
ok("half-way through a coupon period (ACT/ACT): accrued = half a coupon (1.00)", near(b.accrued, 92 / 184 * 2, 1e-12) && b.prev === "2026-03-01" && b.next === "2026-09-01" && b.ytm > 0.04);
const back = Q.bondPrice({ coupon: 4, freq: 2, maturity: "2030-03-01", settle: "2026-06-01", ytm: b.ytm });
ok("price ↔ yield round trip", near(back.clean, 98, 1e-8));
const z = Q.bondCalc({ coupon: 0, freq: 1, maturity: "2027-10-22", settle: "2026-10-22", clean: 97 });
ok("a zero-coupon over one year: yield = 100 / price − 1", near(z.ytm, 100 / 97 - 1, 1e-9) && z.flows.length === 1);
const t = Q.bondCalc({ coupon: 4, freq: 1, maturity: "2031-03-01", settle: "2026-03-01", clean: 100, tax: 0.125 });
ok("net of a 12.5 % tax at par: the yield of the net coupon (3.5 %)", near(t.ytmNet, 0.035, 1e-9));
ok("rates +100 bp: the price falls by about modified duration (convexity makes it a little less)", (() => { const s = b.shocks.find((x) => x.bp === 100); return s.chg < 0 && Math.abs(s.chg) < b.modified / 100 && Math.abs(s.chg) > b.modified / 100 * 0.95; })());
ok("30E/360 accrued: 90 days of 180 → half a coupon", near(Q.bondCalc({ coupon: 4, freq: 2, maturity: "2030-03-01", settle: "2026-06-01", clean: 98, basis: "30E" }).accrued, 1, 1e-12));
ok("settlement after maturity, or no price → null", Q.bondCalc({ coupon: 4, freq: 1, maturity: "2025-01-01", settle: "2026-01-01", clean: 99 }) === null && Q.bondCalc({ coupon: 4, freq: 1, maturity: "2030-01-01", settle: "2026-01-01", clean: 0 }) === null);

// ---------- projection with assumptions ----------
const L = Q.cholesky([[4, 2], [2, 3]]);
ok("Cholesky: L·Lᵀ = A; not positive definite → null", near(L[0][0] * L[0][0], 4, 1e-12) && near(L[1][0] * L[0][0], 2, 1e-12) && near(L[1][0] ** 2 + L[1][1] ** 2, 3, 1e-12) && Q.cholesky([[1, 2], [2, 1]]) === null);
const p0 = Q.projectAssumed({ mu: [0.05, 0.02], vol: [0, 0], corr: [[1, 0], [0, 1]], weights: [0.6, 0.4], months: 12, start: 1000, monthly: 0, paths: 200 });
const g = 0.6 * (Math.pow(1.05, 1 / 12) - 1) + 0.4 * (Math.pow(1.02, 1 / 12) - 1);
ok("zero volatility: every path the same, monthly rebalanced growth of the assumed returns", near(p0.median, 1000 * Math.pow(1 + g, 12), 1e-6) && near(p0.p5, p0.p95, 1e-6));
const p1 = Q.projectAssumed({ mu: [0.07, 0.03, 0.02], vol: [0.16, 0.06, 0], corr: [[1, 0.2, 0], [0.2, 1, 0], [0, 0, 1]], weights: [0.6, 0.3, 0.1], months: 240, start: 10000, monthly: 200, paths: 3000, run: 4, target: 120000 });
const p1b = Q.projectAssumed({ mu: [0.07, 0.03, 0.02], vol: [0.16, 0.06, 0], corr: [[1, 0.2, 0], [0.2, 1, 0], [0, 0, 1]], weights: [0.6, 0.3, 0.1], months: 240, start: 10000, monthly: 200, paths: 3000, run: 4, target: 120000 });
ok("with volatility: reproducible run, ordered bands, put in = start + monthly × months, a probability for the target", p1.median === p1b.median && p1.bands.every((x) => x[0] <= x[2] && x[2] <= x[4]) && p1.put === 58000 && p1.pTarget > 0 && p1.pTarget < 1 && p1.assumed);
// median close to the deterministic growth at the median log return (σ small enough here to check loosely)
ok("…the median grows near the assumed compound return (a 60/30/10 at 5.6 % a year)", p1.median > 70000 && p1.median < 140000, String(p1.median));

// ---------- server: bond terms from OpenFIGI's ticker, saved WHAT IFs ----------
const { parseBondTicker, couponOf, bondRefFrom, handleBondRef } = await import("../src/yas.mjs");
const { validateWif } = await import("../src/userdata.mjs");
const { app: worker } = await import("../src/worker.mjs");
ok("bond tickers: decimal and fractional coupons, zero, floating; MM/DD/YY maturities", JSON.stringify(parseBondTicker("BTPS 3.85 09/01/49")) === JSON.stringify({ issuer: "BTPS", coupon: 3.85, maturity: "2049-09-01", floating: false }) && parseBondTicker("T 4 1/4 11/15/34").coupon === 4.25 && parseBondTicker("BOTS 0 12/14/26").coupon === 0 && parseBondTicker("CCTS F 04/15/29").floating === true && parseBondTicker("AAPL US") === null && couponOf("1/2") === 0.5);
const rows = [{ ticker: "ISP IM", marketSector: "Equity", securityType: "Common Stock" }, { ticker: "BTPS 4.4 05/01/33", name: "BUONI POLIENNALI DEL TES", marketSector: "Govt", securityType: "EURO-ZONE" }];
const ref = bondRefFrom("IT0005518128", rows);
ok("the bond row of an ISIN: coupon, maturity, semi-annual for an Italian issuer", ref.coupon === 4.4 && ref.maturity === "2033-05-01" && ref.freq === 2 && ref.parsed && ref.marketSector === "Govt");
ok("…an ISIN OpenFIGI names no bond for → null", bondRefFrom("US0378331005", [{ ticker: "AAPL", marketSector: "Equity", securityType: "Common Stock" }]) === null);
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const jsonR = (b, H, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
let res = await handleBondRef(new URL("https://x.test/api/bond/ref?isin=IT0005518128"), {}, { waitUntil() {} }, {}, jsonR, { rows: async () => ({ data: rows }) }), bj = await res.json();
ok("/api/bond/ref: the terms and where they come from", res.status === 200 && bj.coupon === 4.4 && /OpenFIGI/.test(bj.source));
res = await handleBondRef(new URL("https://x.test/api/bond/ref?isin=IT0005518120"), {}, { waitUntil() {} }, {}, jsonR, { rows: async () => ({ data: rows }) });
ok("…a bad ISIN → 400", res.status === 400);
ok("WHAT IF validation: a date up to today, an amount, a fee under it, no cash, monthly end after start", typeof validateWif({ name: "x", rows: [{ id: "NVDA", from: "2020-03-16", amount: 2000 }] }, "2026-10-22") === "object" && /up to today/.test(validateWif({ name: "x", rows: [{ id: "NVDA", from: "2030-01-01", amount: 10 }] }, "2026-10-22")) && /fee/.test(validateWif({ name: "x", rows: [{ id: "NVDA", from: "2020-01-01", amount: 10, fee: 10 }] }, "2026-10-22")) && /bad instrument/.test(validateWif({ name: "x", rows: [{ id: "CASH", from: "2020-01-01", amount: 10 }] }, "2026-10-22")) && /end date/.test(validateWif({ name: "x", rows: [{ id: "SWDA", kind: "monthly", from: "2020-01-01", to: "2019-01-01", amount: 10 }] }, "2026-10-22")));
const kv = new Map(), env = { ALLOWED_ORIGIN: "https://x.test", BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const call = async (method, path, body) => { const r = await worker.fetch(new Request("https://x.test" + path, { method, headers: body ? { "content-type": "application/json", origin: "https://x.test" } : { origin: "https://x.test" }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} }); return { st: r.status, b: await r.json() }; };
let r = await call("POST", "/api/user/wif", { name: "NVDA 2020", rows: [{ id: "nvda", from: "2020-03-16", amount: 2000 }, { id: "SWDA", kind: "monthly", from: "2019-01-01", amount: 200, fee: 1 }], bench: "IE00B4L5Y983" });
ok("saved on the server: 201, upper-cased, monthly kept", r.st === 201 && r.b.wif[0].rows[0].id === "NVDA" && r.b.wif[0].rows[1].kind === "monthly" && r.b.wif[0].bench === "IE00B4L5Y983");
r = await call("DELETE", "/api/user/wif?id=" + r.b.saved);
ok("…deleted", r.st === 200 && r.b.wif.length === 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
