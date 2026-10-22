// Drift alert: your positions (PORTFOLIO) against a lab portfolio's weights (PLAB) — matching by the fund's ISIN, values
// in EUR from CNBC's last prices and FX, cash left out, the weekly key, the daily time, the message, the run (drift.mjs,
// alerts.mjs). Fixtures in the stores' and CNBC's formats (test inputs only).
//   node test/drift.test.mjs
import { computeDrift, targetKey, positionKey, eurPerUnit, listMaps, loadDriftInputs } from "../src/drift.mjs";
import { validateAlert, evalDrift, isoWeek, driftDue, describe, runAlerts, alertCnbcSym } from "../src/alerts.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// the Xetra list (mnemonic → ISIN) and the U.S. ETF list, as etf.mjs keeps them
const uni = { rows: [["IE00B4L5Y983", "ISHSIII-CORE MSCI WLD DLA", "ETF", "Passive ETF", "A0RPWH", "EUNL:EUR IWDA:USD"], ["IE00B4WXJJ64", "ISHS EO GOVT BD", "ETF", "Bond ETF", "A0RGEP", "EUNH:EUR"]] };
const maps = listMaps(uni, { rows: [["SPY", "SPDR S&P 500 ETF Trust", "ARCX"]] });
ok("target keys: an ISIN as typed; a Milan ticker of the UCITS list → its ISIN; a Xetra mnemonic → its ISIN; a stock as itself", targetKey("IE00B4L5Y983", maps) === "IE00B4L5Y983" && targetKey("SWDA", maps) === "IE00B4L5Y983" && targetKey("EUNH", maps) === "IE00B4WXJJ64" && targetKey("NVDA", maps) === "NVDA");
ok("position keys: C:EUNL-DE and EUNL:XETR → the fund's ISIN; ISP:XMIL as itself", positionKey("C:EUNL-DE", maps) === "IE00B4L5Y983" && positionKey("EUNL:XETR", maps) === "IE00B4L5Y983" && positionKey("ISP:XMIL", maps) === "ISP:XMIL");
const fx = { "EUR=": 1.1, "GBP=": 1.3, "CHF=": 0.8 };
ok("EUR a unit: USD 1/1.1; GBP 1.3/1.1; pence ÷ 100; CHF (CHF= is CHF per USD) 1/0.8/1.1; yen → none", near(eurPerUnit("USD", fx), 1 / 1.1) && near(eurPerUnit("GBP", fx), 1.3 / 1.1) && near(eurPerUnit("GBp", fx), 0.013 / 1.1) && near(eurPerUnit("CHF", fx), 1 / 0.8 / 1.1) && eurPerUnit("EUR", fx) === 1 && eurPerUnit("JPY", fx) === null);

// target 60 % SWDA / 30 % NVDA / 10 % cash; held: SWDA on Xetra and on Milan, NVDA, and a stock outside the target
const holdings = [{ id: "SWDA", w: 60 }, { id: "NVDA", w: 30 }, { id: "CASH", w: 10 }];
const positions = [{ sym: "EUNL:XETR", ccy: "EUR", qty: 50 }, { sym: "SWDA:XMIL", ccy: "EUR", qty: 10 }, { sym: "NVDA", ccy: "USD", qty: 20 }, { sym: "ISP:XMIL", ccy: "EUR", qty: 100 }];
const prices = { "EUNL:XETR": 100, "SWDA:XMIL": 100, NVDA: 165, "ISP:XMIL": 5 };
let d = computeDrift({ holdings, positions, prices, fx, maps });
// values: SWDA 6,000 · NVDA 20 × 165 / 1.1 = 3,000 · ISP 500 → total 9,500; target without cash: 2/3 and 1/3
ok("both listings of SWDA's fund add up; NVDA in EUR; a position outside the target counts in the total", near(d.total, 9500, 1e-6) && near(d.rows[0].v, 6000) && near(d.rows[1].v, 3000, 1e-9) && d.outside.length === 1 && d.rows[0].syms.join() === "EUNL:XETR,SWDA:XMIL");
ok("cash in the target left out, the rest scaled to 100 % (2/3, 1/3)", near(d.rows[0].w, 2 / 3) && near(d.rows[1].w, 1 / 3) && d.cashLeftOut);
ok("gaps of the target's holdings, largest first: SWDA 63.2 % vs 66.7 % (−3.5 pts), NVDA 31.6 % vs 33.3 %; ISP 5.3 % outside the target is said, not a gap", near(d.rows[0].drift, 6000 / 9500 - 2 / 3) && d.top[0].label === "SWDA" && d.top.length === 2 && near(d.max, Math.abs(6000 / 9500 - 2 / 3)) && near(d.outsideShare, 500 / 9500));
ok("a position without a price → no check (named), never a value made up", computeDrift({ holdings, positions, prices: { ...prices, NVDA: undefined }, fx, maps }).error === "no_price" && computeDrift({ holdings, positions, prices: { ...prices, NVDA: undefined }, fx, maps }).missing.join() === "NVDA");
ok("…a currency without FX here (JPY) → no check", computeDrift({ holdings, positions: [{ sym: "7203:XJPX", ccy: "JPY", qty: 1 }], prices: { "7203:XJPX": 2800 }, fx, maps }).error === "no_price");
ok("…a target of cash only → empty_target", computeDrift({ holdings: [{ id: "CASH", w: 100 }], positions, prices, fx, maps }).error === "empty_target");

// alert: validation, the weekly key, the time of day
ok("validate: a lab portfolio id and points 1–50", validateAlert({ kind: "drift", plab: "3f2a9c1e-0000-4000-8000-000000000001", pp: 5 }).pp === 5 && typeof validateAlert({ kind: "drift", plab: "x", pp: 5 }) === "string" && typeof validateAlert({ kind: "drift", plab: "3f2a9c1e-0000-4000-8000-000000000001", pp: 60 }) === "string");
ok("ISO weeks: 22 Oct 2026 → 2026-W43; Sunday 25 Oct still W43, Monday 26 Oct W44; 1 Jan 2027 → 2026-W53", isoWeek(Date.parse("2026-10-22T12:00:00Z")) === "2026-W43" && isoWeek(Date.parse("2026-10-25T20:00:00Z")) === "2026-W43" && isoWeek(Date.parse("2026-10-26T08:00:00Z")) === "2026-W44" && isoWeek(Date.parse("2027-01-01T12:00:00Z")) === "2026-W53");
ok("checked weekdays at 18:40 Rome (16:40 UTC in summer time, 17:40 in winter), one 5-minute run", driftDue(Date.parse("2026-10-22T16:41:00Z")) && !driftDue(Date.parse("2026-10-22T16:46:00Z")) && driftDue(Date.parse("2026-11-05T17:42:00Z")) && !driftDue(Date.parse("2026-10-24T16:41:00Z")));
const A = { id: "a1", kind: "drift", plab: "3f2a9c1e-0000-4000-8000-000000000001", pp: 3 }, now = Date.parse("2026-10-22T16:41:00Z");
let ev = evalDrift(A, d, now);
ok("fires at ≥ 3 pts (largest 3.5): key = the week, value in pts", ev && ev.key === "wk:2026-W43" && near(ev.value, Math.round(d.max * 10000) / 100));
ok("…not again the same week; not below the threshold; not without a check", evalDrift({ ...A, fired: { keys: ["wk:2026-W43"] } }, d, now) === null && evalDrift({ ...A, pp: 4 }, d, now) === null && evalDrift(A, { error: "no_price" }, now) === null);
const m = describe(A, ev, now);
ok("message: the holding furthest away, now / target / pts, the threshold, the total, where to look — EN and IT", /^“Core”: SWDA −3\.5 pts from its weight$/.test(describe(A, { ...ev, d: { ...d, name: "Core" } }, now).en.title) && /SWDA: 63\.2% · target 66\.7% \(−3\.5 pts\)/.test(m.en.text) && /outside the target: ISP:XMIL 5\.3%/.test(m.en.text) && /threshold ±3 pts · your positions € 9,500/.test(m.en.text) && /cash in the target left out/.test(m.en.text) && /obiettivo 66\.7%/.test(m.it.text) && /PLAB → COSA COMPRO/.test(m.it.text), JSON.stringify(m));

// the run: only at the daily time (or CHECK NOW), the drift read once for all the alerts on the same portfolio
const kv = new Map(), sent = [];
const env = { BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
kv.set("ud/alerts", JSON.stringify([A, { ...A, id: "a2", pp: 10 }]));
let reads = 0;
const inputs = async () => { reads++; return { positions, prices, fx, maps, plab: [{ id: A.plab, name: "Core", holdings }] }; };
const deps = { driftInputs: inputs, fetchQuotes: async () => ({ data: {} }), tgCall: async (mth, p) => { sent.push(p); return { data: {} }; } };
let r = await runAlerts(Date.parse("2026-10-22T10:01:00Z"), env, deps);
ok("outside the daily time: no drift read, nothing fired", reads === 0 && r.fired === 0);
r = await runAlerts(now, env, deps);
const list = JSON.parse(kv.get("ud/alerts"));
ok("at 18:40 Rome: read once for both alerts; the 3-pt one fires, the 10-pt one does not; the week recorded", reads === 1 && r.fired === 1 && list[0].fired.keys.includes("wk:2026-W43") && !list[1].fired && r.drift[A.plab].max === Math.round(d.max * 10000) / 100);
r = await runAlerts(now + 60_000, env, deps);
ok("…the same week again: nothing", r.fired === 0);
r = await runAlerts(Date.parse("2026-10-22T20:00:00Z"), env, { ...deps, force: true });
ok("CHECK NOW: read at any time (the week already sent: nothing new), the result kept for the page", reads === 3 && r.fired === 0 && JSON.parse(kv.get("ud/alertlog")).run.drift[A.plab].max > 0);
kv.set("ud/alerts", JSON.stringify([{ ...A, plab: "00000000-0000-4000-8000-00000000dead" }]));
r = await runAlerts(now, env, deps);
ok("a deleted lab portfolio: no message, said in the run", r.fired === 0 && /drift: plab_missing/.test(r.err || ""));

// the inputs read from the stores and CNBC (their formats)
const kv2 = new Map([["pf/tx", JSON.stringify([{ id: "t0", date: "2026-01-05", side: "BUY", sym: "C:EUNL-DE", qty: 10, price: 110, ccy: "EUR", fees: 0, created: 1 }, { id: "t1", date: "2026-02-05", side: "BUY", sym: "NVDA", qty: 2, price: 150, ccy: "USD", fees: 0, created: 2 }])], ["etf/universe", JSON.stringify(uni)], ["ud/plab", JSON.stringify([{ id: A.plab, name: "Core", holdings }])]]);
const env2 = { BRIEFS: { get: async (k) => kv2.get(k) ?? null } };
const q = (symbol, last, extra = {}) => ({ symbol, code: 0, name: symbol, last: String(last), last_time: "2026-10-22T16:30:00.000+0000", previous_day_closing: String(last), change: "UNCH", change_pct: "UNCH", exchange: "X", ...extra });
let asked = [];
const raw = async (codes) => { asked = codes; return { data: { "EUNL-DE": q("EUNL-DE", 105, { currencyCode: "EUR", countryCode: "DE" }), NVDA: q("NVDA", 190, { currencyCode: "USD", countryCode: "US" }), "EUR=": q("EUR=", 1.1), "GBP=": q("GBP=", 1.3), "CHF=": q("CHF=", 0.8) } }; };
const I = await loadDriftInputs(env2, alertCnbcSym, { loadRaw: raw });
ok("inputs: open positions from the trades, CNBC codes (C:EUNL-DE → EUNL-DE) and FX asked in one go, last prices read", I.positions.length === 2 && asked.includes("EUNL-DE") && asked.includes("NVDA") && asked.includes("EUR=") && I.prices["C:EUNL-DE"] === 105 && I.prices.NVDA === 190 && I.fx["EUR="] === 1.1 && I.plab[0].name === "Core", JSON.stringify(I).slice(0, 300));
d = computeDrift({ holdings, positions: I.positions, prices: I.prices, fx: I.fx, maps: I.maps });
ok("…and the drift from them: SWDA 1,050 / NVDA 2 × 190 / 1.1", near(d.rows[0].v, 1050) && near(d.rows[1].v, 380 / 1.1, 1e-9));
ok("no positions → said", (await loadDriftInputs({ BRIEFS: { get: async () => null } }, alertCnbcSym, { loadRaw: raw })).error === "no_positions");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
