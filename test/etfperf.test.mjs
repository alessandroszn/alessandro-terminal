// ETF screener returns and risk (src/etfperf.mjs): 1Y, 3Y / 5Y a year, volatility, max drawdown from daily closes —
// checked against hand-computed values; the listing used; the cron's batch through both lists (one KV write); the
// on-demand route. Fixtures are CNBC-shaped daily closes (test inputs only).
//   node test/etfperf.test.mjs
import { perfOf, perfLine, patchPerf, perfLineText, refreshEtfPerf, handleEtfPerf, PERF_KEY, PERF_BATCH, PERF_CRON } from "../src/etfperf.mjs";
import { app as worker } from "../src/worker.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// weekdays from a start date, a close each day growing 0.03 % a day with a dip in the middle
const days = (start, n) => { const out = []; let t = Date.parse(start + "T12:00:00Z"); while (out.length < n) { const g = new Date(t).getUTCDay(); if (g && g < 6) out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; } return out; };
const D = days("2020-10-01", 1580), rows = D.map((d, i) => [d, 100 * Math.exp(i * 0.0003) * (i > 700 && i < 760 ? 0.8 : 1)]);
const p = perfOf(rows), last = rows[rows.length - 1], at = (k) => { const dd = new Date(Date.parse(last[0] + "T12:00:00Z") - k * 86400000).toISOString().slice(0, 10); let v = null; for (const [x, c] of rows) if (x <= dd) v = c; return v; };
ok("1Y: last close ÷ the close on or before a year earlier", near(p.r1, last[1] / at(365) - 1, 1e-12) && p.asOf === last[0]);
ok("3Y and 5Y a year: geometric", near(p.r3, Math.pow(last[1] / at(1096), 1 / 3) - 1, 1e-12) && near(p.r5, Math.pow(last[1] / at(1826), 1 / 5) - 1, 1e-12), JSON.stringify(p));
ok("max drawdown over the last 5 years: the −20 % dip", near(p.mdd, -0.2, 1e-3) && p.vol > 0);
const young = perfOf(rows.slice(-400));
ok("a fund younger than 3 years: 1Y only (3Y, 5Y and the 3-year volatility left out, never filled in)", Number.isFinite(young.r1) && young.r3 === null && young.r5 === null && young.vol === null);
ok("too little history → null", perfOf(rows.slice(-10)) === null);
const row = ["IE00B4L5Y983", "ISHSIII-CORE MSCI WLD DLA", "ETF", "Passive ETF", "A0RPWH", "EUNL:EUR IWDA:USD"];
ok("listing: the Xetra EUR line; a U.S. ETF its symbol; a UCITS fund off the Xetra list its EUR line; else null", perfLine("IE00B4L5Y983", row).cnbc === "EUNL-DE" && perfLine("SPY", null, new Set(["SPY"])).ccy === "USD" && perfLine("IE00BK5BQT80", null).cnbc === "VWCE-DE" && perfLine("ZZZZ", null, new Set()) === null);
const t1 = patchPerf("", "A", "A\tx"), t2 = patchPerf(t1 + "\nB\ty", "A", "A\tz");
ok("the table: one line a fund, replaced in place", t2 === "A\tz\nB\ty" && perfLineText("A", { asOf: "2026-10-20", r1: 0.1, r3: null, r5: null, vol: 0.15, mdd: -0.2, first: "2021-01-04" }, "EUR") === "A\t2026-10-20\t0.1\t\t\t0.15\t-0.2\t2021-01-04\tEUR");
// the cron: 8 funds a run through both lists by time, one KV write
const kv = new Map(), writes = [];
kv.set("etf/universe", JSON.stringify({ rows: Array.from({ length: 10 }, (_, i) => [`XX${i}`, "F" + i, "ETF", "Passive ETF", "", `M${i}:EUR`]) }));
kv.set("etf/us", JSON.stringify({ rows: [["SPY", "SPDR", "ARCX"], ["QQQ", "Invesco", "XNMS"]] }));
const env = { BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v, o) => { kv.set(k, v); writes.push([k, o && o.expirationTtl]); } } };
const asked = []; const deps = { daily: async (code) => { asked.push(code); return code === "M3-DE" ? { err: "no_data" } : { data: rows }; } };
let r = await refreshEtfPerf(env, 0, deps);
ok("cron: 8 funds (Xetra first, by their EUR line), one KV write, errors listed", r.ids.length === PERF_BATCH && asked[0] === "M0-DE" && r.computed === 7 && writes.length === 1 && writes[0][0] === PERF_KEY && kv.get(PERF_KEY).split("\n").length === 7 && r.errors[0] === "XX3:no_data", JSON.stringify(r));
asked.length = 0; r = await refreshEtfPerf(env, 600_000, deps);
ok("…the next run: the next 8, wrapping to the U.S. list and back", r.ids.join() === "XX8,XX9,SPY,QQQ,XX0,XX1,XX2,XX3" && asked.includes("SPY") && kv.get(PERF_KEY).split("\n").length === 11, r.ids.join());
ok("its own trigger in wrangler.toml, never the alerts' run", readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").includes(`"${PERF_CRON}"`) && PERF_CRON !== "*/5 * * * *");
// the routes
const json = (b, H, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
let res = await handleEtfPerf(new URL("https://x.test/api/etf/perf?ids=XX1,SPY,NOPE"), env, {}, {}, json, deps), b = await res.json();
ok("on demand: computed live, an unknown id → its error", res.status === 200 && b.funds[0].cnbc === "M1-DE" && near(b.funds[0].r1, p.r1, 1e-12) && b.funds[1].ccy === "USD" && b.funds[2].error === "not_listed");
res = await handleEtfPerf(new URL("https://x.test/api/etf/perf?ids=" + Array.from({ length: 9 }, (_, i) => "A" + i).join(",")), env, {}, {}, json, deps);
ok("…more than 8 → 400", res.status === 400);
res = await worker.fetch(new Request("https://x.test/api/etf/perftable"), env, { waitUntil() {} }); b = await res.json();
ok("the table through the Worker, with its basis", res.status === 200 && b.count === 11 && /DERIVED/.test(b.basis));

// CNBC refusing the bars (403): a pause for every bar request, not one request after another
const { cnbcDaily } = await import("../src/cnbc.mjs");
const store = new Map(); globalThis.caches = { default: { match: async (q) => { const k = typeof q === "string" ? q : q.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (q, r) => { store.set(typeof q === "string" ? q : q.url, await r.text()); } } };
let calls = 0; const realFetch = globalThis.fetch; globalThis.fetch = async (u) => { calls++; return new Response("Forbidden", { status: 403 }); };
const a1 = await cnbcDaily("https://x.test", { waitUntil() {} }, "AAA-DE", 1900, Date.now()), a2 = await cnbcDaily("https://x.test", { waitUntil() {} }, "BBB-DE", 1900, Date.now());
ok("CNBC refuses (403): the error said, then a 10-minute pause — the next symbol is not asked", a1.err === "provider_forbidden" && a2.err === "provider_forbidden" && calls === 1, `calls ${calls}`);
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
