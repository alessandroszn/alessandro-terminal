// The ETF section (src/etf.mjs, src/etfref.mjs): the universe from Deutsche Börse's Xetra instruments file and Twelve
// Data's U.S. list, justETF reference data for every fund (cron one fund a run; the owner's funds first; read on demand),
// listings from CNBC, compare, the portfolio's look-through. Provider answers are fixtures in the providers' formats
// (Xetra CSV, Twelve Data JSON, justETF profile HTML, CNBC restQuote / bars) — nothing here is shown.
//   node test/etf.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseXetra, parseTdEtfs, buildEtfUniverse, refreshEtfRef, etfDetail, parseJustEtfFull, weightPairs, seriesStats, exposure, XETRA_URL, TD_ETFS_URL } from "../src/etf.mjs";
import { tableLine, patchTable, tableMap, refFromLine, TABLE_COLS } from "../src/etfref.mjs";
import { UCITS_ETFS, justEtfUrl } from "../src/ucits.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

// ---------- Deutsche Börse's Xetra file (its layout: two lines of metadata, a header, ";"-separated, 89 columns) ----------
const HDR = ["Product Status", "Instrument Status", "Instrument", "ISIN", "Product ID", "Instrument ID", "WKN", "Mnemonic", "MIC Code", "CCP eligible Code", "Trading Model Type", "Product Assignment Group", "Product Assignment Group Description", "Designated Sponsor Member ID", "Designated Sponsor", "Price Range Value", "Price Range Percentage", "Minimum Quote Size", "Instrument Type"];
while (HDR.length < 67) HDR.push("Tick Size " + HDR.length);
HDR.push("Settlement Currency"); while (HDR.length < 89) HDR.push("Col " + HDR.length);
const line = (name, isin, wkn, mnem, grp, type, ccy) => { const f = new Array(89).fill(""); f[0] = "Active"; f[1] = "Active"; f[2] = name; f[3] = isin; f[6] = wkn; f[7] = mnem; f[8] = "XETR"; f[12] = grp; f[18] = type; f[67] = ccy; return f.join(";"); };
const XETRA = ["Market:;XETR", "Date Last Update:;21.10.2026", HDR.join(";"),
  line("ISHSIII-CORE MSCI WLD DLA", "IE00B4L5Y983", "A0RPWH", "EUNL", "EXCHANGE TRADED FUNDS - PASSIV", "ETF", "EUR"),
  line("ISHSIII-CORE MSCI WLD DLA", "IE00B4L5Y983", "A0RPWH", "IWDA", "ETF - CURRENCY USD", "ETF", "USD"),
  line("VANGUARD FTSE ALL-WLD U.ETF", "IE00BK5BQT80", "A2PKXG", "VWCE", "EXCHANGE TRADED FUNDS - PASSIV", "ETF", "EUR"),
  line("ISHS EO GOVT BD", "IE00B4WXJJ64", "A0RGEP", "EUNH", "EXCHANGE TRADED FUNDS - RENTEN", "ETF", "EUR"),
  line("XETRA-GOLD", "DE000A0S9GB0", "A0S9GB", "4GLD", "EXCHANGE TRADED COMMODITIES", "ETC", "EUR"),
  line("SIEMENS AG", "DE0007236101", "723610", "SIE", "DAX", "CS", "EUR"),
  line("BROKEN", "XX0000000000", "", "BRK", "EXCHANGE TRADED FUNDS - PASSIV", "ETF", "EUR")].join("\r\n");
let px = parseXetra(XETRA);
const swda = px.rows.find((r) => r[0] === "IE00B4L5Y983");
ok("Xetra file: ETFs, ETCs and ETNs only (a stock and an invalid ISIN left out), one row per ISIN, the date of the list", px.asOf === "2026-10-21" && px.rows.length === 4 && !px.rows.some((r) => r[0] === "DE0007236101" || r[0] === "XX0000000000"));
ok("…a fund's lines by currency (EUR first), the group of its EUR line kept (the USD line's group says nothing of the fund)", swda[5] === "EUNL:EUR IWDA:USD" && swda[3] === "Passive ETF" && swda[4] === "A0RPWH" && px.rows.find((r) => r[0] === "IE00B4WXJJ64")[3] === "Bond ETF" && px.rows.find((r) => r[0] === "DE000A0S9GB0")[2] === "ETC");
ok("a file without its header → nothing (no list made up)", parseXetra("Market:;XETR\nsomething else") === null && parseXetra("") === null);
const TD = JSON.stringify({ data: [
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", currency: "USD", exchange: "NYSE", mic_code: "ARCX", country: "United States", cfi_code: "CECILU", isin: "request_access_via_add_ons" },
  { symbol: "QQQ", name: "Invesco QQQ Trust", currency: "USD", exchange: "NASDAQ", mic_code: "XNMS", country: "United States", cfi_code: "CEOGEU" },
  { symbol: "OTCX", name: "Some OTC fund", currency: "USD", exchange: "OTC", mic_code: "OTCM", country: "United States", cfi_code: "CECILU" },
  { symbol: "MUTF", name: "A mutual fund", currency: "USD", exchange: "NASDAQ", mic_code: "XNMS", country: "United States", cfi_code: "CIOGEU" }], status: "ok" });
ok("Twelve Data's U.S. list: exchange-traded funds (CFI CE…) on U.S. exchanges; OTC and other funds left out", JSON.stringify(parseTdEtfs(TD).rows.map((r) => r[0])) === '["SPY","QQQ"]' && parseTdEtfs("{}") === null);

// ---------- justETF: the profile page, beyond the basics ----------
const PAGE = (isin, extra = "") => `<html><head><title>iShares Core MSCI World UCITS ETF USD (Acc) | IWDA | ${isin}</title></head><body>${"<div>menu</div>".repeat(80)}
<table><tr><td class="vallabel">Fund size</td><td><div> EUR 131,754 m </div></td></tr><tr><td class="vallabel">Total expense ratio</td><td><span>0.20% p.a.</span></td></tr>
<tr><td class="vallabel">Replication</td><td><span>Physical</span> (<span>Optimized sampling</span>)</td></tr><tr><td>Distribution policy</td><td>Accumulating</td></tr>
<tr><td>Fund domicile</td><td>Ireland</td></tr><tr><td>Fund Provider</td><td>iShares</td></tr><tr><td>Legal structure</td><td>ETF</td></tr><tr><td>Fund currency</td><td>USD</td></tr><tr><td>Currency risk</td><td>Currency unhedged</td></tr>
<tr><td>Inception/ Listing Date</td><td>25 September 2009</td></tr><tr><td>Investment focus</td><td>Equity, World</td></tr></table>
<h3>Top 10 Holdings</h3><div>Weight of top 10 holdings out of 1,252 <span>26.64%</span></div><table><tr><td>NVIDIA Corp.</td><td>5.53%</td></tr><tr><td>Apple</td><td>5.07%</td></tr><tr><td>Microsoft Corp</td><td>3.90%</td></tr></table>
<h3>Countries</h3><table><tr><td>United States</td><td>71.53%</td></tr><tr><td>Japan</td><td>5.28%</td></tr><tr><td>Other</td><td>23.19%</td></tr></table><h3>Sectors</h3><table><tr><td>Technology</td><td>29.12%</td></tr><tr><td>Financials</td><td>15.79%</td></tr><tr><td>Other</td><td>55.09%</td></tr></table>${extra}</body></html>`;
const full = parseJustEtfFull(PAGE("IE00B4L5Y983"));
ok("profile → the basics (TER, size, replication…) and name, provider, focus from the page", full.ter === 0.2 && full.fundSize.value === 131754e6 && full.name === "iShares Core MSCI World UCITS ETF USD (Acc)" && full.provider === "iShares" && full.focus === "Equity, World" && full.replication === "Physical (Optimized sampling)", JSON.stringify(full).slice(0, 300));
ok("…the top 10 holdings with the top 10's weight and the number of holdings", full.top10.length === 3 && full.top10[0][0] === "NVIDIA Corp." && full.top10[0][1] === 5.53 && full.top10Weight === 26.64 && full.holdingsTotal === 1252, JSON.stringify(full.top10));
ok("…countries and sectors as justETF lists them (with Other)", JSON.stringify(full.countries) === '[["United States",71.53],["Japan",5.28],["Other",23.19]]' && full.sectors[0][0] === "Technology" && full.sectors.length === 3, JSON.stringify(full.countries) + JSON.stringify(full.sectors));
ok("weights read from text: names with dots, commas; never a price", JSON.stringify(weightPairs("Amazon.com, Inc. 2.74% Alphabet A 2.10%")) === '[["Amazon.com, Inc.",2.74],["Alphabet A",2.1]]' && !Object.keys(full).some((k) => /price|nav|return|perf/i.test(k)));

// ---------- the compact table ----------
const now0 = Date.parse("2026-10-21T15:00:00Z");
const l1 = tableLine("IE00B4L5Y983", full, now0), f1 = l1.split("\t");
ok("table line: ISIN, TER, size in millions with its currency, A, P + method, domicile, fund currency, unhedged, provider, focus, structure, inception, name, day", f1.length === TABLE_COLS.length && f1[0] === "IE00B4L5Y983" && f1[1] === "0.2" && f1[2] === "131754" && f1[3] === "EUR" && f1[4] === "A" && f1[5] === "P" && f1[6] === "Optimized sampling" && f1[9] === "0" && f1[10] === "iShares" && f1[11] === "Equity, World" && f1[15] === "2026-10-21", l1);
let t = patchTable("", "IE00B4L5Y983", l1); t = patchTable(t, "IE00BK5BQT80", "IE00BK5BQT80\t0.19" + "\t".repeat(14)); t = patchTable(t, "IE00B4L5Y983", l1.replace("\t0.2\t", "\t0.18\t"));
ok("patching: a fund added once, a later read replaces its line, the others untouched", t.split("\n").length === 2 && tableMap(t).get("IE00B4L5Y983")[1] === "0.18" && tableMap(t).get("IE00BK5BQT80")[1] === "0.19");
const rf = refFromLine(tableMap(t).get("IE00B4L5Y983"));
ok("a table line → the record the UCITS list shows (TER, size, distribution, replication, hedging)", rf.ter === 0.18 && rf.fundSize.value === 131754e6 && rf.distribution === "Accumulating" && rf.replication === "Physical (Optimized sampling)" && rf.hedged === false && rf.provider === "iShares");

// ---------- the cron, the universe build, the on-demand read (a KV in memory; justETF / Deutsche Börse fixtures) ----------
const kv = new Map(), writes = [];
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v, o) => { kv.set(k, v); writes.push([k, o && o.expirationTtl]); } } };
const asked = []; let jeReply = (u) => ({ text: PAGE(new URL(u).searchParams.get("isin")), http: 200 });
const fetchImpl = async (u) => { asked.push(u); if (u === XETRA_URL) return { text: XETRA, http: 200 }; if (u === TD_ETFS_URL) return { text: TD, http: 200 }; return jeReply(u); };
let r = await buildEtfUniverse(env, now0, fetchImpl);
ok("universe, first run: the Xetra list built (one source a run), its ISINs kept for the crawl", r.action === "built" && r.which === "xetra" && JSON.parse(kv.get("etf/universe")).rows.length === 4 && kv.get("etf/isins").split(",").length === 4 && asked.length === 1);
r = await buildEtfUniverse(env, now0 + 60_000, fetchImpl);
ok("…next run: the U.S. list; then nothing until a copy is 6 days old", r.which === "us" && JSON.parse(kv.get("etf/us")).rows.length === 2 && (await buildEtfUniverse(env, now0 + 2 * 86400_000, fetchImpl)).action === "fresh");
asked.length = 0; writes.length = 0;
r = await refreshEtfRef(env, now0, fetchImpl);
ok("crawl, first run: the UCITS list's funds first (priority), one justETF page; its table line and full record kept, the priority time noted", r.action === "read" && r.prio === true && r.isin === UCITS_ETFS[0].isin && asked.length === 1 && asked[0] === justEtfUrl(UCITS_ETFS[0].isin) && kv.has("ref/je/" + UCITS_ETFS[0].isin) && tableMap(kv.get("ref/je/table")).has(UCITS_ETFS[0].isin) && JSON.parse(kv.get("ref/je/prio"))[UCITS_ETFS[0].isin] === now0);
ok("…three KV writes for a priority fund (table, record, priority list), kept 45 days", writes.length === 3 && writes.every(([, ttl]) => ttl === 45 * 86400), JSON.stringify(writes));
const prio = {}; for (const e of UCITS_ETFS) prio[e.isin] = now0; kv.set("ref/je/prio", JSON.stringify(prio)); asked.length = 0; writes.length = 0;
r = await refreshEtfRef(env, now0 + 300_000, fetchImpl);
ok("priority funds all read this week: the next fund of the universe by time — only its table line written (one KV write)", r.action === "read" && r.prio === false && kv.get("etf/isins").split(",").includes(r.isin) && writes.length === 1 && writes[0][0] === "ref/je/table" && !kv.has("ref/je/" + r.isin) === (r.isin !== UCITS_ETFS[0].isin));
jeReply = () => ({ err: "provider_forbidden", http: 403 }); asked.length = 0;
r = await refreshEtfRef(env, now0 + 600_000, fetchImpl);
const n1 = asked.length; r = await refreshEtfRef(env, now0 + 900_000, fetchImpl);
ok("justETF refusing: no request for 6 hours (no hammering)", r.action === "backoff" && asked.length === n1 && JSON.parse(kv.get("ref/je/prio"))._fail.err === "provider_forbidden");
jeReply = (u) => ({ text: PAGE(new URL(u).searchParams.get("isin")), http: 200 });
r = await refreshEtfRef(env, now0 + 7 * 3600_000, fetchImpl);
ok("…after the pause it reads again and the failure is cleared", r.action === "read" && !JSON.parse(kv.get("ref/je/prio"))._fail);
asked.length = 0;
let d = await etfDetail(env, "IE00B4WXJJ64", now0 + 8 * 3600_000, fetchImpl);
ok("a profile opened that was never read: read now from justETF, kept, the fund joins the priority list", d.data && d.data.ter === 0.2 && asked.length === 1 && kv.has("ref/je/IE00B4WXJJ64") && JSON.parse(kv.get("ref/je/prio")).IE00B4WXJJ64 && tableMap(kv.get("ref/je/table")).has("IE00B4WXJJ64"));
d = await etfDetail(env, "IE00B4WXJJ64", now0 + 9 * 3600_000, fetchImpl);
ok("…opened again within the week: the kept record, no request", d.data && asked.length === 1);

// ---------- returns, drawdown, exposure ----------
const days = []; for (let i = 0; i < 1300; i++) days.push([new Date(Date.parse("2021-10-21T00:00:00Z") + i * 86400_000 * 1.4).toISOString().slice(0, 10), 100 * Math.pow(1.0004, i) * (i > 600 && i < 700 ? 0.8 : 1)]);
const ss = seriesStats(days);
ok("stats from daily closes: 1Y and annualised 3Y returns, 1-year volatility, the maximum drawdown and its date", Number.isFinite(ss.returns["1Y"]) && Number.isFinite(ss.returns["3Ya"]) && ss.maxDrawdown < -19 && ss.maxDrawdown > -21 && /^2024/.test(ss.maxDrawdownAt) && Number.isFinite(ss.vol1Y), JSON.stringify(ss).slice(0, 300));
const ex = exposure([{ isin: "A", weight: 60, detail: { countries: [["United States", 70], ["Japan", 30]], sectors: [["Technology", 50], ["Other", 50]], top10: [["Apple", 5]] } }, { isin: "B", weight: 40, detail: { countries: [["United States", 50], ["Germany", 50]], sectors: null, top10: [["Apple", 2], ["SAP", 4]] } }, { isin: "C", weight: 0, detail: null }]);
ok("exposure: countries weighted by position (US 0.6×70 + 0.4×50 = 62), sectors covered by the funds that list them (60 %), holdings summed", Math.abs(ex.countries[0][1] - 62) < 1e-9 && ex.countries[0][0] === "United States" && Math.abs(ex.coverage.sectors - 60) < 1e-9 && Math.abs(ex.holdings.find((h) => h[0] === "Apple")[1] - 3.8) < 1e-9);

// ---------- the endpoints ----------
const day = (dd, c) => ({ close: String(c), tradeTime: dd.replace(/-/g, "") + "000000", tradeTimeinMills: Date.parse(dd + "T04:00:00Z") });
const quote = (symbol, last, ccy, country) => ({ symbol, code: 0, name: symbol, last, previous_day_closing: last, change: "0", change_pct: "0.5%", last_time: "2026-10-21T16:10:00.000+0200", currencyCode: ccy, exchange: "X", countryCode: country });
const Q = { "EUNL-DE": quote("EUNL-DE", "130.69", "EUR", "DE"), "IWDA-DE": quote("IWDA-DE", "146.70", "USD", "DE"), "SWDA-GB": quote("SWDA-GB", "10,960", "GBp", "GB"), "IWDA-GB": quote("IWDA-GB", "146.76", "USD", "GB") };
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://quote.cnbc.com/")) { const syms = decodeURIComponent(new URL(u).searchParams.get("symbols")).split("|"); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((s) => Q[s] || { symbol: s, code: 1 }) } })); }
  if (u.startsWith("https://ts-api.cnbc.com/")) { const sym = decodeURIComponent(u.split("/bars/")[1].split("/")[0]); if (sym !== "EUNL-DE" && sym !== "VWCE-DE") return new Response("{}", { status: 404 }); return new Response(JSON.stringify({ barData: { priceBars: days.slice(-500).map(([dd, c]) => day(dd, sym === "VWCE-DE" ? c * 1.1 : c)) } })); }
  if (u === "https://api.openfigi.com/v3/mapping") return new Response(JSON.stringify([{ data: [{ ticker: "SWDA", exchCode: "LN", name: "ISHARES CORE MSCI WORLD", securityType: "ETP" }] }]));
  if (u.startsWith("https://api.twelvedata.com/symbol_search")) return new Response(JSON.stringify({ data: [], status: "ok" }));
  return new Response("", { status: 404 });
};
const call = async (path) => { const res = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, { waitUntil() {} }); const text = await res.text(); return { status: res.status, j: JSON.parse(text), text }; };
let c = await call("/api/etf/universe");
ok("/api/etf/universe: the Xetra and U.S. lists as kept, the justETF table, the UCITS tickers (SWDA → its ISIN)", c.status === 200 && c.j.xetra.rows.length === 4 && c.j.us.rows.length === 2 && c.j.ref.table.includes("IE00B4L5Y983") && c.j.ucits.some((u) => u[0] === "IE00B4L5Y983" && u.includes("SWDA")) && c.j.status === "LIVE");
c = await call("/api/etf/profile?isin=IE00B4L5Y983");
const ls = c.j.lines.map((x) => x.cnbc + ":" + x.ccy).join(",");
ok("/api/etf/profile: justETF record, and every listing CNBC carries — Xetra EUR first, then other lines (London pence ÷ 100)", c.status === 200 && c.j.ref.ter === 0.2 && c.j.ref.source === "justETF" && c.j.lines[0].cnbc === "EUNL-DE" && /SWDA-GB:GBP/.test(ls) && c.j.lines.find((x) => x.cnbc === "SWDA-GB").price === 109.6 && c.j.xetra.wkn === "A0RPWH", ls);
c = await call("/api/etf/profile?isin=NOTANISIN");
ok("a profile without a valid ISIN → 400", c.status === 400);
c = await call("/api/etf/compare?ids=IE00B4L5Y983,IE00BK5BQT80&ccy=EUR");
ok("/api/etf/compare in EUR: each fund's Xetra EUR line, stats and weekly points (DERIVED); not converted", c.status === 200 && c.j.funds.length === 2 && c.j.funds[0].line.cnbc === "EUNL-DE" && c.j.funds[0].conv === null && c.j.funds[0].stats && c.j.funds[0].weekly.length > 50 && c.j.funds[1].line.cnbc === "VWCE-DE", JSON.stringify(c.j.funds.map((f) => [f.id, f.error, f.line && f.line.cnbc])));
c = await call("/api/etf/compare?ids=&ccy=EUR");
ok("compare without funds → 400; a currency outside EUR / USD / GBP / CHF → 400", c.status === 400 && (await call("/api/etf/compare?ids=IE00B4L5Y983&ccy=JPY")).status === 400);
c = await call("/api/etf/resolve?syms=" + encodeURIComponent("SWDA:XMIL,EUNL:XETR,C:EUNL-DE,SPY,NVDA"));
ok("/api/etf/resolve: the Milan ticker (UCITS list), the Xetra mnemonic and C:<code>-DE → the ISIN; SPY a U.S. ETF; a stock → null", c.j.resolved["SWDA:XMIL"].isin === "IE00B4L5Y983" && c.j.resolved["EUNL:XETR"].isin === "IE00B4L5Y983" && c.j.resolved["C:EUNL-DE"].isin === "IE00B4L5Y983" && c.j.resolved.SPY.us === true && c.j.resolved.NVDA === null, JSON.stringify(c.j.resolved));
c = await call("/api/etf/exposure?w=IE00B4L5Y983:70,IE00B4WXJJ64:30");
ok("/api/etf/exposure: the funds' composition weighted, coverage said, DERIVED", c.status === 200 && c.j.countries[0][0] === "United States" && c.j.coverage.countries === 100 && c.j.status === "DERIVED" && c.j.funds.length === 2, JSON.stringify(c.j).slice(0, 300));
ok("no response carries anything but reference data and CNBC's own quotes (no justETF price)", !/"nav"|justetf.*price/i.test(c.text));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
