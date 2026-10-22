// Bonds in the portfolio lab: the ECB list of eligible marketable assets read a slice a run (src/ecbassets.mjs), the
// terms of an ISIN (ECB first, OpenFIGI second: src/yas.mjs), the plan of a bond's estimate, the curve and FX endpoints
// (src/plab.mjs), and the estimate itself (qmath.js bondHistory) — checked against closed forms and hand-made cases.
// Fixtures in the providers' formats (test inputs only).
//   node test/bondlab.test.mjs
import { createRequire } from "node:module";
import { eaCandidates, dmy, eaColumns, eaRow, readSlice, stepEcbList, eaTable, eaHead, eaLookup, eaList, eaResetMemo, EA_KEY, EA_STATE, EA_SLICE, eaFileUrl } from "../src/ecbassets.mjs";
import { bondTerms, handleBondRef, freqOf } from "../src/yas.mjs";
import { handlePlab, bondPlan, bondTenors, curveCountry, sessionDated } from "../src/plab.mjs";
import { validatePlab } from "../src/userdata.mjs";
const require = createRequire(import.meta.url);
const Q = require("../public/terminal/qmath.js");

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const json = (b, H, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });

// ---------- which file ----------
// Thursday 22 Oct 2026, 10:00 UTC: Wednesday's file is the newest (Thursday's comes out around 16:15–17:15 UTC)
let c = eaCandidates(Date.parse("2026-10-22T10:00:00Z"));
ok("newest file first: the last weekday whose 18:00 UTC is past", c[0] === "261021" && c.join() === "261021,261020,261019,261016", c.join());
c = eaCandidates(Date.parse("2026-10-26T09:00:00Z"));
ok("…on a Monday morning: Friday's file, never a weekend date", c[0] === "261023" && c[1] === "261022", c.join());
ok("…after 18:00 UTC the same day's file", eaCandidates(Date.parse("2026-10-22T19:00:00Z"))[0] === "261022");
ok("file URL: ea_csv_YYMMDD.csv on the ECB's site", eaFileUrl("261021") === "https://www.ecb.europa.eu/paym/coll/assets/html/dla/ea_MID/ea_csv_261021.csv");
ok("dates: DD/MM/YYYY 00:00:00 → ISO", dmy("01/05/2033 00:00:00") === "2033-05-01" && dmy("") === null && dmy("2033-05-01") === null);

// ---------- the file (the ECB's header and codes) ----------
const HEADER = ["ISIN_CODE", "OTHER_REG_NUMBER", "HAIRCUT_CATEGORY", "TYPE", "REFERENCE_MARKET", "DENOMINATION", "ISSUANCE_DATE", "MATURITY_DATE", "ISSUER_CSD", "COUPON_RATE (%)", "ISSUER_NAME", "ISSUER_RESIDENCE", "ISSUER_GROUP", "GUARANTOR_NAME", "GUARANTOR_RESIDENCE", "GUARANTOR_GROUP", "COUPON_DEFINITION", "HAIRCUT", "HAIRCUT_OWN_USE", "POTENTIALLY_OWN_USABLE_COVERED_BOND", "CLIMATE_FACTOR"];
const line = (isin, type, ccy, iss, mat, cpn, name, res, grp, cd) => [isin, "", "I", type, "M01", ccy, iss + " 00:00:00", mat + " 00:00:00", "IT01", cpn, name, res, grp, "", "", "", cd, "0.5", "", "N", ""].join("\t");
const BTP = line("IT0005518128", "AT01", "EUR", "01/11/2022", "01/05/2033", "4.4", "Repubblica Italiana", "IT", "IG2", "CD4");
const BOT = line("IT0005611303", "AT03", "EUR", "14/08/2026", "12/02/2027", "", "Repubblica Italiana", "IT", "IG2", "CD1");
const CCT = line("IT0005584856", "AT01", "EUR", "15/04/2024", "15/10/2032", "3.9", "Repubblica Italiana", "IT", "IG2", "CD2");
const BUND = line("DE0001102614", "AT01", "EUR", "11/01/2023", "15/02/2033", "2.3", "Bundesrepublik Deutschland", "DE", "IG2", "CD4");
const CORP = line("XS2010030836", "AT02", "USD", "20/06/2019", "20/06/2029", "2.75", "Some Bank plc", "GB", "IG4", "CD4");
const cols = eaColumns(HEADER.join("\t") + "\r");
ok("columns found by name (a trailing \\r ignored)", cols && cols.isin === 0 && cols.cd === 16 && cols.coupon === 9 && cols.residence === 11);
ok("…a header without the needed columns → null", eaColumns("A\tB\tC") === null);
ok("fixed coupon kept: ISIN, coupon, issue, maturity, currency, residence, group, F, type, issuer", eaRow(BTP, cols) === "IT0005518128\t4.4\t2022-11-01\t2033-05-01\tEUR\tIT\tIG2\tF\tAT01\tRepubblica Italiana", eaRow(BTP, cols));
ok("zero coupon kept with coupon 0 (Z)", eaRow(BOT, cols) === "IT0005611303\t0\t2026-08-14\t2027-02-12\tEUR\tIT\tIG2\tZ\tAT03\tRepubblica Italiana");
ok("variable coupon (CD2) left out: not priced from a curve", eaRow(CCT, cols) === null);
ok("…a malformed ISIN or no maturity left out", eaRow(line("IT00055181", "AT01", "EUR", "01/11/2022", "01/05/2033", "4.4", "x", "IT", "IG2", "CD4"), cols) === null && eaRow(line("IT0005518128", "AT01", "EUR", "01/11/2022", "", "4.4", "x", "IT", "IG2", "CD4"), cols) === null);

// a whole file: these five, then enough corporate lines to need three slices
const filler = []; for (let i = 0; filler.join("\n").length < 2 * EA_SLICE; i++) filler.push(line(`XS${String(100000000 + i)}${i % 10}`, "AT02", "EUR", "01/01/2020", "01/01/2030", "1.25", "Filler Corp " + i + " é", "FR", "IG3", "CD4"));
const FILE = new TextEncoder().encode([HEADER.join("\t"), BTP, BOT, CCT, BUND, CORP, ...filler].join("\r\n") + "\r\n");
const kv = new Map(), writes = [];
const env = { BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { writes.push(k); kv.set(k, v); } } };
let ranges = 0, mode = "range";
const fakeFetch = async (url, init) => {
  if (!url.endsWith("ea_csv_261021.csv")) return new Response("not here", { status: 404 });
  const m = /bytes=(\d+)-(\d+)/.exec((init && init.headers && init.headers.range) || "");
  if (mode === "range" && m) { ranges++; const a = +m[1], b = Math.min(+m[2], FILE.length - 1); if (a >= FILE.length) return new Response("", { status: 416 }); return new Response(FILE.slice(a, b + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${FILE.length}` } }); }
  let p = 0; return new Response(new ReadableStream({ pull(ctl) { if (p >= FILE.length) return ctl.close(); ctl.enqueue(FILE.slice(p, p + 65536)); p += 65536; } }), { status: 200 });
};
const NOW = Date.parse("2026-10-22T00:12:00Z");
let r, n = 0;
do { r = await stepEcbList(env, NOW + n * 600_000, { fetch: fakeFetch }); n++; } while (r.ran && !r.done && n < 20);
const table = kv.get(EA_KEY);
ok("read in slices (Range requests): one slice a run, then the table written", r.done === "261021" && n === Math.ceil(FILE.length / EA_SLICE) && ranges === n, JSON.stringify(r) + " runs " + n + " ranges " + ranges);
ok("…every fixed / zero bond kept, the variable one left out", r.rows === 4 + filler.length && table.split("\n").length === r.rows + 1 && !table.includes("IT0005584856"));
ok("…no line cut at a slice's edge (each line has its 10 fields)", table.split("\n").slice(1).every((l) => l.split("\t").length === 10));
ok("…a name with an accent read as UTF-8", table.includes("Filler Corp 7 é"));
const head = eaHead(table);
ok("table head: the file's date, the number of bonds, when it was read", head.file === "261021" && head.date === "2026-10-21" && head.rows === r.rows && /^2026-10-22T/.test(head.readAt));
const st = JSON.parse(kv.get(EA_STATE));
ok("…state: done, next look 6 hours later", st.done === "261021" && st.next === NOW + (n - 1) * 600_000 + 6 * 3600_000 && !st.reading);
const w0 = writes.length;
r = await stepEcbList(env, NOW + 7 * 3600_000, { fetch: async () => { throw new Error("must not fetch"); } });
ok("the newest file already read: nothing fetched, the slot goes to the ETF screener", r.ran === false && writes.length === w0 + 1);
r = await stepEcbList(env, NOW + 8 * 3600_000, { fetch: async () => { throw new Error("must not fetch"); } });
ok("…and nothing looked at again until 3 hours later", r.ran === false && writes.length === w0 + 1);

// the same file from a server that ignores Range (the whole file streamed, read up to the slice)
const kv2 = new Map(), env2 = { BRIEFS: { get: async (k) => kv2.get(k) ?? null, put: async (k, v) => { kv2.set(k, v); } } };
mode = "whole"; n = 0;
do { r = await stepEcbList(env2, NOW + n * 600_000, { fetch: fakeFetch }); n++; } while (r.ran && !r.done && n < 20);
ok("…a server without Range: the same table", r.done === "261021" && kv2.get(EA_KEY).split("\n").slice(1).join("\n") === table.split("\n").slice(1).join("\n"));
const s206 = await readSlice(new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-range": "bytes 10-12/99" } }), 10, 3);
ok("readSlice: a 206 answer is the slice, its total from Content-Range", s206.buf.length === 3 && s206.total === 99);

// the first run when no file is out yet for the newest weekday (holiday): an older one
const kv3 = new Map(), env3 = { BRIEFS: { get: async (k) => kv3.get(k) ?? null, put: async (k, v) => { kv3.set(k, v); } } };
mode = "range"; r = await stepEcbList(env3, Date.parse("2026-10-23T19:00:00Z"), { fetch: fakeFetch });
ok("newest file missing (404) → the previous weekday's", r.ran && r.file === "261021" && r.offset > 0);
const kv4 = new Map(), env4 = { BRIEFS: { get: async (k) => kv4.get(k) ?? null, put: async (k, v) => { kv4.set(k, v); } } };
r = await stepEcbList(env4, NOW, { fetch: async () => new Response("", { status: 404 }) });
ok("no file at all → nothing written but the next look (3 hours)", r.ran === false && JSON.parse(kv4.get(EA_STATE)).next === NOW + 3 * 3600_000 && !kv4.has(EA_KEY));
r = await stepEcbList(env4, NOW + 4 * 3600_000, { fetch: async () => new Response("<html>", { status: 500 }) });
ok("a server error → retried an hour later, said", r.ran && r.error === "provider_error" && JSON.parse(kv4.get(EA_STATE)).next === NOW + 5 * 3600_000);

// ---------- lookups ----------
const b1 = eaLookup(table, "IT0005518128");
ok("lookup by ISIN: the terms", b1 && b1.coupon === 4.4 && b1.issue === "2022-11-01" && b1.maturity === "2033-05-01" && b1.ccy === "EUR" && b1.residence === "IT" && b1.groupName === "Central government" && !b1.zero && b1.typeName === "Bond");
ok("…not on the list → null; a prefix of a longer ISIN does not match", eaLookup(table, "IT0005584856") === null && eaLookup(table, "IT000551812") === null);
let L = eaList(table, { cc: "IT", from: "2026-10-22" });
ok("list: Italy's central-government bonds by maturity (the BOT first)", L.total === 2 && L.bonds[0].isin === "IT0005611303" && L.bonds[1].isin === "IT0005518128");
ok("…matured ones left out; a filter on the line", eaList(table, { cc: "IT", from: "2027-03-01" }).total === 1 && eaList(table, { cc: "IT", q: "2033" }).bonds[0].isin === "IT0005518128" && eaList(table, { cc: "FR", group: "IG3" }).total === filler.length);
eaResetMemo(); kv.set(EA_KEY, table);
ok("eaTable: read from KV, kept an hour in the isolate", (await eaTable(env, NOW)) === table && (kv.set(EA_KEY, "x"), await eaTable(env, NOW + 60_000)) === table && (await eaTable(env, NOW + 3601_000)) === "x");
kv.set(EA_KEY, table); eaResetMemo();

// ---------- terms ----------
const url = new URL("https://x.test/api/bond/ref?isin=IT0005518128");
let t = await bondTerms(url, env, {}, "IT0005518128", { table, rows: async () => { throw new Error("must not ask OpenFIGI"); } });
ok("terms: the ECB list first (OpenFIGI not asked); Italy pays twice a year", t.ref.coupon === 4.4 && t.ref.issue === "2022-11-01" && t.ref.freq === 2 && t.ref.freqFrom === "issuer's country" && /^ECB list of eligible marketable assets \(2026-10-21\)$/.test(t.ref.source) && t.ref.name === "Repubblica Italiana 4.4% 2033-05-01");
t = await bondTerms(url, env, {}, "XS2010030836", { table });
ok("…a dollar bond of a bank: twice a year by its currency", t.ref.freq === 2 && t.ref.freqFrom === "currency" && t.ref.ccy === "USD");
ok("freqOf: Germany once a year; Luxembourg in euro once (the currency's rule); a yen bond once (default)", freqOf("DE", "EUR").freq === 1 && freqOf("LU", "EUR").freqFrom === "currency" && freqOf("JP", "JPY").freqFrom === "default" && freqOf("IT", "USD").freqFrom === "currency");
const FIGI = { data: [{ ticker: "T 4 1/4 11/15/34", name: "US TREASURY N/B", marketSector: "Govt", securityType: "US GOVERNMENT", securityType2: "Note" }] };
t = await bondTerms(new URL("https://x.test/"), env, {}, "US91282CLW90", { table, rows: async () => FIGI });
ok("…not on the ECB list → OpenFIGI's ticker (no issue date; the home currency of a U.S. ISIN)", t.ref.coupon === 4.25 && t.ref.maturity === "2034-11-15" && t.ref.issue === null && t.ref.ccy === "USD" && /OpenFIGI/.test(t.ref.source));
let res = await handleBondRef(new URL("https://x.test/api/bond/ref?isin=IT0005518128"), env, {}, {}, json, { table });
let j = await res.json();
ok("/api/bond/ref answers the ECB terms", res.status === 200 && j.issue === "2022-11-01" && j.status === "LIVE" && j.sourceUrl.includes("ecb.europa.eu"));
res = await handleBondRef(new URL("https://x.test/api/bond/list?cc=IT"), env, {}, {}, json, { table, now: Date.parse("2026-10-22T10:00:00Z") });
j = await res.json();
ok("/api/bond/list?cc=IT: the government bonds, the list's date, terms only", res.status === 200 && j.total === 2 && j.asOf === "2026-10-21" && j.bonds[1].coupon === 4.4 && /terms, not prices/.test(j.note));
res = await handleBondRef(new URL("https://x.test/api/bond/list?cc=IT"), env, {}, {}, json, { table: "" });
ok("…the list not read yet → 503 not_loaded (never a made-up list)", res.status === 503 && (await res.json()).error === "not_loaded");
res = await handleBondRef(new URL("https://x.test/api/bond/list?cc=ITA"), env, {}, {}, json, { table });
ok("…a bad country → 400", res.status === 400);

// ---------- the plan of an estimate ----------
const now = Date.parse("2026-10-22T10:00:00Z");
ok("curve: an Italian bond in euro on Italy's curve; a dollar bond of a British bank on the U.S. curve", curveCountry({ isin: "IT0005518128", residence: "IT", ccy: "EUR" }).cc === "IT" && curveCountry({ isin: "XS2010030836", residence: "GB", ccy: "USD" }).cc === "US" && curveCountry({ isin: "XS1", residence: "LU", ccy: "EUR" }).cc === "DE");
ok("…a gilt on the U.K. curve; a yen bond → none", curveCountry({ isin: "GB00B24FF097", residence: "GB", ccy: "GBP" }).cc === "UK" && curveCountry({ isin: "XS2", residence: "JP", ccy: "JPY" }) === null);
const tn = bondTenors("IT", "2022-11-01", "2033-05-01", now);
ok("maturities: those inside 6.5 → 10.5 years left, and the nearest beyond each end", tn.join() === "5Y,7Y,10Y,15Y", tn.join());
ok("…a bond with 4 months left: the shortest quoted and the next", bondTenors("IT", "2026-08-14", "2027-02-12", now).join() === "6M", bondTenors("IT", "2026-08-14", "2027-02-12", now).join());
let pl = bondPlan({ isin: "IT0005518128", residence: "IT", ccy: "EUR", coupon: 4.4, maturity: "2033-05-01", issue: "2022-11-01" }, now);
ok("plan: from the issue date", pl.cc === "IT" && pl.start === "2022-11-01" && pl.tenors.length === 4);
pl = bondPlan({ isin: "DE0001135275", residence: "DE", ccy: "EUR", coupon: 4, maturity: "2037-01-04", issue: "2005-01-04" }, now);
ok("…issued more than 15 years ago: 15 years back", pl.start === new Date(now - 5480 * 86400_000).toISOString().slice(0, 10));
ok("…floating, matured, unknown currency, a currency without FX → said", bondPlan({ floating: true, coupon: null }, now).error === "floating_bond" && bondPlan({ coupon: 1, maturity: "2026-11-01", ccy: "EUR" }, now).error === "bond_matured" && bondPlan({ coupon: 1, maturity: "2030-01-01", ccy: null }, now).error === "no_currency" && bondPlan({ coupon: 1, maturity: "2030-01-01", ccy: "JPY" }, now).error === "fx_unavailable");
const sd = sessionDated("IT", [["2026-10-19", 3.4], ["2026-10-20", 3.5], ["2026-10-21", 3.6]]);
ok("European bars moved to the session (Monday's bar → Friday)", sd.map((x) => x[0]).join() === "2026-10-16,2026-10-19,2026-10-20" && sd[2][1] === 3.6);
ok("…a weekend bar and Monday's both Friday's session: one day, the later value", sessionDated("DE", [["2026-10-17", 2.1], ["2026-10-19", 2.1]]).length === 1 && sessionDated("US", [["2026-10-19", 4]])[0][0] === "2026-10-19");

// ---------- the endpoints ----------
const B = (n0, f) => { const out = []; let t2 = Date.parse("2022-10-03T12:00:00Z"); while (out.length < n0) { const g = new Date(t2).getUTCDay(); if (g && g < 6) out.push([new Date(t2).toISOString().slice(0, 10), f(out.length)]); t2 += 86400_000; } return out; };
const BARS = { "IT5Y-IT": B(1050, () => 3), "IT7Y-IT": B(1050, () => 3.2), "IT10Y-IT": B(1050, () => 3.5), "IT15Y-IT": B(1050, () => 3.8), "US10Y": B(1050, () => 4), "EUR=": B(1050, () => 1.1) };
const deps = { now, table, daily: async (s2) => (BARS[s2] ? { data: BARS[s2], cache: "HIT", fetchedAt: now } : { err: "no_data" }), fundLines: async () => ({ lines: [] }), rows: async () => ({ data: [] }) };
const get = async (p) => { const r2 = await handlePlab(new URL("https://x.test" + p), env, {}, {}, json, deps); return { st: r2.status, b: await r2.json() }; };
let g = await get("/api/plab/series?id=IT0005518128");
ok("/api/plab/series for a bond on the ECB list: its terms and the plan, no price made up", g.st === 200 && g.b.kind === "bond" && !g.b.d && g.b.bond.coupon === 4.4 && g.b.bond.freq === 2 && g.b.plan.cc === "IT" && g.b.plan.tenors.join() === "5Y,7Y,10Y,15Y" && /ESTIMATE/.test(g.b.basis), JSON.stringify(g.b).slice(0, 300));
g = await get("/api/plab/series?id=IT0005584856");
ok("…an ISIN nowhere (OpenFIGI names no bond) → not listed", g.st === 404 && g.b.error === "not_listed");
g = await get("/api/plab/curve?cc=IT&tenor=10Y");
ok("/api/plab/curve: the yields of one maturity, moved to the session", g.st === 200 && g.b.months === 120 && g.b.v[0] === 3.5 && g.b.d[0] === "2022-09-30" && g.b.symbol === "IT10Y-IT");
g = await get("/api/plab/curve?cc=US&tenor=10Y");
ok("…U.S. bars keep their date", g.st === 200 && g.b.d[0] === "2022-10-03");
ok("…a maturity CNBC does not quote → 400", (await get("/api/plab/curve?cc=IT&tenor=4Y")).st === 400 && (await get("/api/plab/curve?cc=ZZ&tenor=10Y")).st === 400);
g = await get("/api/plab/fx?from=USD&to=EUR");
ok("/api/plab/fx: one dollar in euro = 1 / EUR=", g.st === 200 && near(g.b.v[0], 1 / 1.1, 1e-6) && g.b.from === "USD");
ok("…a currency not offered → 400", (await get("/api/plab/fx?from=JPY&to=EUR")).st === 400);

// ---------- the estimate ----------
const days = B(1050, () => 0).map((x) => x[0]);
const flat = (y) => [{ months: 60, d: days, v: days.map(() => y) }, { months: 120, d: days, v: days.map(() => y) }];
let h = Q.bondHistory({ coupon: 3, freq: 1, maturity: "2031-06-15", start: "2022-11-01", curves: flat(3) });
const yrs = (Date.parse(h.last) - Date.parse(h.first)) / (365.25 * 86400_000);
ok("flat curve at the coupon: the total return a year = the yield (coupons reinvested)", near(Math.pow(h.v[h.v.length - 1] / h.v[0], 1 / yrs) - 1, 0.03, 2e-4) && h.spread === 0 && h.calib === null, Math.pow(h.v[h.v.length - 1] / h.v[0], 1 / yrs) - 1);
ok("…the model's clean price stays near par", h.clean.every((p) => near(p, 100, 0.2)));
h = Q.bondHistory({ coupon: 3, freq: 1, maturity: "2031-06-15", start: "2022-11-01", curves: flat(3), price: 97 });
ok("today's price sets the spread: the model's last clean price = the price typed", near(h.clean[h.clean.length - 1], 97, 1e-6) && h.spread > 0 && h.calib.price === 97);
const zc = Q.bondHistory({ coupon: 0, freq: 1, maturity: "2031-06-15", start: "2022-11-01", curves: flat(2) });
ok("zero coupon on a flat 2 % curve: price = 100 / 1.02^years left; return a year 2 %", near(zc.clean[0], 100 / Math.pow(1.02, (Date.parse("2031-06-15T12:00:00Z") - Date.parse(zc.first + "T12:00:00Z")) / (86400_000 * 365.25)), 0.05) && near(Math.pow(zc.v[zc.v.length - 1] / zc.v[0], 1 / yrs) - 1, 0.02, 2e-4));
ok("curve between two maturities: linear; flat beyond", near(Q.curveYield([[60, 2], [120, 3]], 90), 2.5, 1e-12) && Q.curveYield([[60, 2], [120, 3]], 12) === 2 && Q.curveYield([[60, 2], [120, 3]], 400) === 3);
// a jump in the yield: the price falls by about duration × the jump
const jump = [{ months: 96, d: days, v: days.map((_, i) => (i < 500 ? 3 : 4)) }];
h = Q.bondHistory({ coupon: 3, freq: 1, maturity: "2031-06-15", start: "2022-11-01", curves: jump });
const i5 = h.d.indexOf(days[500]), dur = Q.bondCalc({ coupon: 3, freq: 1, maturity: "2031-06-15", settle: h.d[i5 - 1], clean: h.clean[i5 - 1] }).modified;
ok("a 100 bp rise: the price falls by about the modified duration (convexity aside)", near(h.v[i5] / h.v[i5 - 1] - 1, -dur * 0.01, 0.003), [h.v[i5] / h.v[i5 - 1] - 1, -dur * 0.01].join());
// two maturities, 2 % and 4 %; the short one not quoted for 100 days: those days priced on the long one alone (4 %), never
// on a quote older than a week
const short = days.slice(0, 100).concat(days.slice(200)), two = [{ months: 60, d: short, v: short.map(() => 2) }, { months: 120, d: days, v: days.map(() => 4) }];
h = Q.bondHistory({ coupon: 3, freq: 1, maturity: "2031-06-15", start: "2022-11-01", curves: two });
const yAt = (d) => h.y[h.d.indexOf(d)];
ok("a maturity whose newest quote is older than a week does not count (never filled in)", yAt(days[150]) === 0.04 && yAt(days[102]) < 0.04 && yAt(days[250]) < 0.04, [yAt(days[150]), yAt(days[102]), yAt(days[250])].join());
ok("…no curve → null", Q.bondHistory({ coupon: 3, maturity: "2031-06-15", curves: [] }) === null);

// ---------- saved holdings ----------
let v = validatePlab({ name: "Bonds", holdings: [{ id: "IT0005518128", w: 40, px: 104.5 }, { id: "SWDA", w: 60 }] });
ok("a saved holding keeps a bond's typed price; others have none", v.holdings[0].px === 104.5 && !("px" in v.holdings[1]));
ok("…a price of 0 or above 1000 refused", typeof validatePlab({ name: "x", holdings: [{ id: "IT0005518128", w: 100, px: 0 }] }) === "string" && typeof validatePlab({ name: "x", holdings: [{ id: "IT0005518128", w: 100, px: 1001 }] }) === "string");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
