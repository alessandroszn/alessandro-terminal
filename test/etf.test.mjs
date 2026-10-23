// The ETF section (src/etf.mjs, src/etfref.mjs): the universe from Deutsche Börse's Xetra instruments file and Twelve
// Data's U.S. list, justETF reference data for every fund (cron one fund a run; the owner's funds first; read on demand),
// listings from CNBC, compare, the portfolio's look-through. Provider answers are fixtures in the providers' formats
// (Xetra CSV, Twelve Data JSON, justETF profile HTML, CNBC restQuote / bars) — nothing here is shown.
//   node test/etf.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseXetra, parseTdEtfs, buildEtfUniverse, refreshEtfRef, etfDetail, parseJustEtfFull, weightPairs, seriesStats, exposure, XETRA_URL, TD_ETFS_URL, jeDetails, jeMoreUrls, vrowOf } from "../src/etf.mjs";
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
// the live page's layout (21 Oct 2026): the provider's cell by its data-testid; "Countries" first inside the page's
// scripts, then as a heading followed by the largest countries and "Show more" (the rest loaded by script — not read)
const LIVE = PAGE("IE00B4L5Y983").replace(/<h3>Countries<\/h3>[\s\S]*$/, "") + `<script>Wicket.Ajax.ajax({"u":"/en/etf-profile.html?0-1.0-holdingsSection-countries-loadMoreCountries&isin=IE00B4L5Y983","c":"loadMoreCountries6"});</script>
<tr data-testid="etf-basics_row_fund-provider"><td class="vallabel"> Fund Provider </td><td class="val2" data-testid="tl_etf-basics_value_fund-provider">iShares</td></tr>
<div><h3 class="h5"> Countries </h3><table><tr><td>United States</td><td><div style="width:70.32%"></div>70.32%</td></tr><tr><td>Japan</td><td>5.79%</td></tr><tr><td>United Kingdom</td><td>3.68%</td></tr></table><a id="loadMoreCountries6">Show more</a></div>
<div><h3 class="h5"> Sectors </h3><table><tr><td>Technology</td><td>35.71%</td></tr><tr><td>Finance</td><td>18.01%</td></tr><tr><td>Industrials</td><td>9.57%</td></tr></table><a>Show more</a></div> As of 31/08/2026</body></html>`;
const lv = parseJustEtfFull(LIVE);
ok("live layout: the provider from its cell; countries and sectors after their heading (not inside the page's script), up to Show more", lv.provider === "iShares" && JSON.stringify(lv.countries) === '[["United States",70.32],["Japan",5.79],["United Kingdom",3.68]]' && JSON.stringify(lv.sectors) === '[["Technology",35.71],["Finance",18.01],["Industrials",9.57]]', JSON.stringify([lv.provider, lv.countries, lv.sectors]));
// the cells and rows by their data-testid (the markup of 23 Oct 2026, from a bond fund's page): the index, approach,
// sustainability, payout frequency; the top 10 with each holding's ISIN and full name (a bond's coupon kept), countries, sectors
const TID = PAGE("IE00B3F81R35").replace(/<h3>Top 10 Holdings<\/h3>[\s\S]*$/, "") + `<tr data-testid="etf-basics_row_index-name"><td class="vallabel"> Index </td><td><div class="val" data-testid="tl_etf-basics_value_index-name">Bloomberg Euro Corporate Bond</div></td></tr>
<td class="val" data-testid="tl_etf-basics_value_strategy-risk">Long-only</td></tr><td class="val" data-testid="tl_etf-basics_value_sustainable">No</td></tr><td class="val" data-testid="tl_etf-basics_value_distribution-interval">Semi annually</td>
<h3>Top 10 Holdings</h3><div>Weight of top 10 holdings out of 3,912 <span>1.18%</span></div><table>
<tr><td><a data-testid="tl_etf-holdings_top-holdings_link_name" href="/en/stock-profiles/BE6285455497" title="Anheuser-Busch InBev, 2% 17mar2028, EUR"><span>Anheuser-Busch InBev, 2% 17mar…</span></a> </td> <td> <div class="right ws"> <span data-testid="tl_etf-holdings_top-holdings_value_percentage">0.13%</span></div></td></tr>
<tr><td><a data-testid="tl_etf-holdings_top-holdings_link_name" href="/en/stock-profiles/XS2010039035" title="Banco Santander SA, 1.125% 23jun2027, EUR"><span>Banco Santander</span></a></td><td><span data-testid="tl_etf-holdings_top-holdings_value_percentage">0.12%</span></td></tr></table>
<h3>Countries</h3><table><tr><td data-testid="tl_etf-holdings_countries_value_name">France</td> <td> <div class="right ws"> <span data-testid="tl_etf-holdings_countries_value_percentage">18.73%</span></div></td></tr><tr><td data-testid="tl_etf-holdings_countries_value_name">United States</td><td><span data-testid="tl_etf-holdings_countries_value_percentage">15.98%</span></td></tr></table>
<h3>Sectors</h3><table><tr><td data-testid="tl_etf-holdings_sectors_value_name">Finance</td><td><span data-testid="tl_etf-holdings_sectors_value_percentage">45.62%</span></td></tr></table></body></html>`;
const td = parseJustEtfFull(TID);
ok("justETF cells by data-testid: index, approach, sustainability, payout frequency", td.index === "Bloomberg Euro Corporate Bond" && td.approach === "Long-only" && td.sustainable === false && td.payouts === "Semi annually", JSON.stringify({ i: td.index, a: td.approach, s: td.sustainable, p: td.payouts }));
ok("…the top 10 with each holding's ISIN and its full name (the coupon in a bond's name is not read as a weight)", JSON.stringify(td.top10) === '[["Anheuser-Busch InBev, 2% 17mar2028, EUR",0.13,"BE6285455497"],["Banco Santander SA, 1.125% 23jun2027, EUR",0.12,"XS2010039035"]]' && td.top10Weight === 1.18 && td.holdingsTotal === 3912, JSON.stringify(td.top10));
ok("…countries and sectors from their rows", JSON.stringify(td.countries) === '[["France",18.73],["United States",15.98]]' && JSON.stringify(td.sectors) === '[["Finance",45.62]]', JSON.stringify([td.countries, td.sectors]));
ok("…a page without those cells: the fields stay null (never guessed)", full.index === null && full.approach === null && full.sustainable === null && full.payouts === null);
const px2 = parseXetra(XETRA.replace("A0RPWH", "000A0RPWH"));
ok("Xetra's WKN with leading zeros (000A0RPWH) → the six-character WKN", px2.rows.find((r) => r[0] === "IE00B4L5Y983")[4] === "A0RPWH");
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
ok("crawl, first run: the UCITS list's funds first (priority), one justETF page; its table line and full record kept, the priority time noted", r.action === "read" && r.prio === true && r.isin === UCITS_ETFS[0].isin && asked.length === 1 && asked[0] === justEtfUrl(UCITS_ETFS[0].isin) && kv.has("ref/je/" + UCITS_ETFS[0].isin) && tableMap(kv.get("ref/je/table")).has(UCITS_ETFS[0].isin) && JSON.parse(kv.get("ref/je/prio2"))[UCITS_ETFS[0].isin] === now0);
ok("…three KV writes for a priority fund (table, record, priority list), kept 45 days", writes.length === 3 && writes.every(([, ttl]) => ttl === 45 * 86400), JSON.stringify(writes));
const prio = {}; for (const e of UCITS_ETFS) prio[e.isin] = now0; kv.set("ref/je/prio2", JSON.stringify(prio)); asked.length = 0; writes.length = 0;
r = await refreshEtfRef(env, now0 + 300_000, fetchImpl);
ok("priority funds all read this week: the next fund of the universe by time — only its table line written (one KV write)", r.action === "read" && r.prio === false && kv.get("etf/isins").split(",").includes(r.isin) && writes.length === 1 && writes[0][0] === "ref/je/table" && !kv.has("ref/je/" + r.isin) === (r.isin !== UCITS_ETFS[0].isin));
jeReply = () => ({ err: "provider_forbidden", http: 403 }); asked.length = 0;
r = await refreshEtfRef(env, now0 + 600_000, fetchImpl);
const n1 = asked.length; r = await refreshEtfRef(env, now0 + 900_000, fetchImpl);
ok("justETF refusing: no request for 6 hours (no hammering)", r.action === "backoff" && asked.length === n1 && JSON.parse(kv.get("ref/je/prio2"))._fail.err === "provider_forbidden");
jeReply = (u) => ({ text: PAGE(new URL(u).searchParams.get("isin")), http: 200 });
r = await refreshEtfRef(env, now0 + 7 * 3600_000, fetchImpl);
ok("…after the pause it reads again and the failure is cleared", r.action === "read" && !JSON.parse(kv.get("ref/je/prio2"))._fail);
asked.length = 0;
let d = await etfDetail(env, "IE00B4WXJJ64", now0 + 8 * 3600_000, fetchImpl);
ok("a profile opened that was never read: read now from justETF, kept, the fund joins the priority list", d.data && d.data.ter === 0.2 && asked.length === 1 && kv.has("ref/je/IE00B4WXJJ64") && JSON.parse(kv.get("ref/je/prio2")).IE00B4WXJJ64 && tableMap(kv.get("ref/je/table")).has("IE00B4WXJJ64"));
d = await etfDetail(env, "IE00B4WXJJ64", now0 + 9 * 3600_000, fetchImpl);
ok("…opened again within the week: the kept record, no request", d.data && asked.length === 1);

// ---------- returns, drawdown, exposure ----------
const days = []; for (let i = 0; i < 1300; i++) days.push([new Date(Date.parse("2021-10-21T00:00:00Z") + i * 86400_000 * 1.4).toISOString().slice(0, 10), 100 * Math.pow(1.0004, i) * (i > 600 && i < 700 ? 0.8 : 1)]);
const ss = seriesStats(days);
ok("stats from daily closes: 1Y and annualised 3Y returns, 1-year volatility, the maximum drawdown and its date", Number.isFinite(ss.returns["1Y"]) && Number.isFinite(ss.returns["3Ya"]) && ss.maxDrawdown < -19 && ss.maxDrawdown > -21 && /^2024/.test(ss.maxDrawdownAt) && Number.isFinite(ss.vol1Y), JSON.stringify(ss).slice(0, 300));
const ex = exposure([{ isin: "A", weight: 60, detail: { countries: [["United States", 70], ["Japan", 30]], sectors: [["Technology", 50], ["Other", 50]], top10: [["Apple", 5]] } }, { isin: "B", weight: 40, detail: { countries: [["United States", 50], ["Germany", 50]], sectors: null, top10: [["Apple", 2], ["SAP", 4]] } }, { isin: "C", weight: 0, detail: null }]);
const ex2 = exposure([{ isin: "A", weight: 100, detail: { countries: [["United States", 70.32], ["Japan", 5.79]], sectors: null, top10: null } }]);
ok("exposure: what a fund's page does not list goes to Not listed (100 − 76.11), shown last", ex2.countries[ex2.countries.length - 1][0] === "Not listed" && Math.abs(ex2.countries[ex2.countries.length - 1][1] - 23.89) < 1e-9);
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

// ---------- the page's other tables and the "Show more" lists (markup of the live page, 23 Oct 2026) ----------
const MORE_PAGE = `<html><head><title>Vanguard FTSE All-World UCITS ETF (USD) Accumulating | VWRA | IE00BK5BQT80</title></head><body>
<table><tr><td class="vallabel">Total expense ratio</td><td class="val2" data-testid="tl_etf-basics_value_ter">0.19% p.a.</td></tr>
<tr><td class="vallabel"> Fund size </td><td class="val2">EUR 55,100 m</td></tr><tr><td class="vallabel">Distribution policy</td><td>Accumulating</td></tr></table>
<tr><td class="vallabel"> Fund Structure </td><td class="val2">Open-ended Investment Company (OEIC)</td></tr><tr><td class="vallabel"> UCITS compliance </td><td class="val2">Yes</td></tr>
<tr><td class="vallabel"> Administrator </td><td class="val2">Brown Brothers Harriman Fund Administration Services (Ireland) Limited</td></tr><tr><td class="vallabel"> Custodian Bank </td><td class="val2">Brown Brothers Harriman Trustee Services (Ireland) Limited</td></tr>
<tr><td class="vallabel"> Revision Company </td><td class="val2">KPMG</td></tr><tr><td class="vallabel"> Fiscal Year End </td><td class="val2">30 June</td></tr>
<tr><td class="vallabel"> Germany </td><td class="val2"><span class="uielem">30% tax rebate</span><span class="caption-info uielem"></span></td></tr><tr><td class="vallabel"> Italy </td><td class="val2"><span class="uielem">26.0%</span><span class="caption-info uielem"></span></td></tr>
<tr><td class="vallabel"> Indextype </td><td class="val2"><span>Total return index</span></td></tr><tr><td class="vallabel"> Swap counterparty </td><td class="val2"><span>-</span></td></tr>
<tr><td class="vallabel"> Securities lending </td><td class="val2"><span>Yes</span></td></tr><tr><td class="vallabel"> Securities lending counterparty </td><td class="val2"><span>Barclays Bank Plc|BNP Paribas SA|UBS AG</span></td></tr>
<div data-testid="tl_etf-holdings_reference-date">As of 31/08/2026</div>
<tr><td data-testid="tl_etf-holdings_countries_value_name">United States</td><td data-testid="tl_etf-holdings_countries_value_percentage">59.77%</td></tr><tr><td data-testid="tl_etf-holdings_countries_value_name">Other</td><td data-testid="tl_etf-holdings_countries_value_percentage">40.23%</td></tr>
<script>Wicket.Ajax.ajax({"u":"/en/etf-profile.html?1-1.0-holdingsSection-countries-loadMoreCountries&isin=IE00BK5BQT80&_wicket=1","c":"loadMoreCountries6","e":"click","pd":true});;
Wicket.Ajax.ajax({"u":"/en/etf-profile.html?1-1.0-holdingsSection-sectors-loadMoreSectors&isin=IE00BK5BQT80&_wicket=1","c":"loadMoreSectors7","e":"click","pd":true});;</script>
${"<p>filler</p>".repeat(100)}</body></html>`;
const dt = jeDetails(MORE_PAGE);
ok("justETF: structure, service providers, tax status (Italy too), index type, securities lending and its counterparties, the date of the holdings", dt.fundStructure === "Open-ended Investment Company (OEIC)" && dt.ucitsCompliant === true && /^Brown Brothers/.test(dt.custodian) && dt.auditor === "KPMG" && dt.fiscalYearEnd === "30 June"
  && dt.tax.IT === "26.0%" && dt.tax.DE === "30% tax rebate" && !("CH" in dt.tax) && dt.indexType === "Total return index" && dt.swapCounterparty === null && dt.securitiesLending === true && dt.lendingCounterparties.length === 3 && dt.holdingsAsOf === "2026-08-31", JSON.stringify(dt));
ok("justETF: a label is read only as a table label (a country named in a list is not a tax row)", vrowOf('<td data-testid="x">Italy</td><td>3.1%</td>', "Italy") === null);
const mu = jeMoreUrls(MORE_PAGE);
ok("justETF: the page's own \"Show more\" requests for countries and sectors", /\?1-1\.0-holdingsSection-countries-loadMoreCountries&isin=IE00BK5BQT80&_wicket=1$/.test(mu.countries) && /loadMoreSectors/.test(mu.sectors));
const XML = (k, rows) => `<?xml version="1.0" encoding="UTF-8"?><ajax-response><component id="x"><![CDATA[${rows.map(([n, v]) => `<tr><td data-testid="tl_etf-holdings_${k}_value_name">${n}</td><td data-testid="tl_etf-holdings_${k}_value_percentage">${v}%</td></tr>`).join("")}]]></component></ajax-response>`;
const moreAsked = [];
const fetchMore = async (u, o = {}) => { moreAsked.push({ u, h: o.headers || {} });
  if (u === justEtfUrl("IE00BK5BQT80")) return { text: MORE_PAGE, http: 200, cookie: "JSESSIONID=abc; AWSALB=x" };
  if (/loadMoreCountries/.test(u)) return { text: XML("countries", [["United States", 59.77], ["Japan", 5.97], ["Taiwan", 3.29], ["United Kingdom", 3.25], ["China", 2.49], ["India", 1.58], ["Other", 23.65]]), http: 200 };
  if (/loadMoreSectors/.test(u)) return { text: XML("sectors", [["Technology", 30], ["Finance", 20]]), http: 200 }; // a list that does not add up: not taken
  return { err: "no_data" }; };
const dm = await etfDetail(env, "IE00BK5BQT80", now0 + 30 * 86400_000, fetchMore);
const mc = moreAsked.find((a) => /loadMoreCountries/.test(a.u));
ok("justETF \"Show more\": asked in the page's session (its cookies, Wicket's headers); the whole country list kept, a partial sector list not", dm.data && dm.data.countries.length === 7 && dm.data.countriesFull === true && dm.data.countries[2][0] === "Taiwan" && !dm.data.sectorsFull && mc && mc.h.cookie === "JSESSIONID=abc; AWSALB=x" && mc.h["wicket-ajax"] === "true" && mc.u.startsWith("https://www.justetf.com/en/etf-profile.html?1-1.0-"), JSON.stringify(dm.data && dm.data.countries));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
