// UCITS ETFs (src/ucits.mjs): the fixed list (ISINs, price lines), CNBC prices of each line, returns from CNBC's daily bars,
// justETF reference data read by the cron (one fund a run, weekly, never prices), the UCITS funds a search names, and the
// guard against CNBC's answer from a U.S. symbol for a venue code it does not carry. Provider answers are fixtures in the
// providers' formats (CNBC restQuote / bars, justETF's profile table) — nothing here is shown.
//   node test/ucits.test.mjs
import { app as worker } from "../src/worker.mjs";
import { UCITS_ETFS, UCITS_GROUPS, UCITS_CCYS, ucitsMatch, parseJustEtf, refreshJustEtf, JUSTETF_KEY, justEtfUrl, fxRate } from "../src/ucits.mjs";
import { cnbcIntlRec, cnbcForeignFallback, MIC_CNBC } from "../src/intl.mjs";
import { isinValid } from "../src/isin.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

// ---------- the list ----------
const isins = UCITS_ETFS.map((e) => e.isin), codes = UCITS_ETFS.map((e) => e.cnbc), suffixes = Object.values(MIC_CNBC);
ok("72 funds, every ISIN with a valid check digit, no ISIN or price line twice", UCITS_ETFS.length === 72 && isins.every(isinValid) && new Set(isins).size === 72 && new Set(codes).size === 72);
ok("every default line is a CNBC venue code (Xetra -DE, Milan -IT, Paris -FR, London -GB), its venue said; classes in order", UCITS_ETFS.every((e) => suffixes.some((s) => e.cnbc.endsWith(s)) && ["XETR", "XMIL", "XPAR", "XLON"].includes(e.def.mic)) && UCITS_GROUPS[0] === "World equity" && UCITS_GROUPS.includes("Bonds") && UCITS_GROUPS.includes("Crypto ETP"));
ok("lines by currency: every fund's default line is one of its lines; only EUR, USD, GBP, CHF; London pence lines marked", UCITS_ETFS.every((e) => Object.values(e.lines).some((l) => l.cnbc === e.cnbc) && Object.keys(e.lines).every((k) => UCITS_CCYS.includes(k)) && Object.values(e.lines).every((l) => !l.pence || l.cnbc.endsWith("-GB"))) && UCITS_ETFS.filter((e) => e.lines.USD).length >= 50);
const swda = UCITS_ETFS.find((e) => e.isin === "IE00B4L5Y983");
ok("SWDA: iShares Core MSCI World, Milan ticker SWDA, priced on its Xetra EUR line EUNL (CNBC does not carry the Milan line); USD = IWDA London, GBP = SWDA London (pence)", swda.sym === "SWDA" && swda.milan === "SWDA" && swda.cnbc === "EUNL-DE" && swda.line === "EUNL" && swda.tickers.includes("IWDA") && swda.lines.USD.cnbc === "IWDA-GB" && swda.lines.GBP.cnbc === "SWDA-GB" && swda.lines.GBP.pence && !swda.lines.CHF);
ok("funds without a Milan line are named by the line they are priced on (QDVE, 4GLD, BTCE)", ["QDVE", "4GLD", "BTCE"].every((t) => UCITS_ETFS.some((e) => e.sym === t && !e.milan)));

// ---------- CNBC's answer from a U.S. symbol ----------
const smh = { symbol: "SMH-IT", code: 0, name: "VanEck Semiconductor ETF", last: "551.84", last_time: "2026-10-21T10:25:00.000-0400", change: "1", change_pct: "0.2%", currencyCode: "USD", exchange: "NASDAQ", countryCode: "US" };
const eunl = { symbol: "EUNL-DE", code: 0, name: "iShares Core MSCI World UCITS ETF USD (Acc)", last: "130.69", last_time: "2026-10-21T16:10:00.000+0200", change: "0.41", change_pct: "0.32%", previous_day_closing: "130.28", volume: "120,000", currencyCode: "EUR", exchange: "XETRA", countryCode: "DE", realTime: "false" };
ok("a venue code CNBC answers from the U.S. (SMH-IT → NASDAQ) is another instrument: no record, never shown as the Milan price", cnbcForeignFallback(smh) && cnbcIntlRec("SMH:XMIL", smh) === null && cnbcForeignFallback({ symbol: "SSAC-NL", countryCode: "US" }));
ok("…a real Xetra answer, a U.S. stock with a share class (BRK.B) and a Tokyo code are not affected", cnbcIntlRec("C:EUNL-DE", eunl).price === 130.69 && !cnbcForeignFallback({ symbol: "BRK.B", countryCode: "US" }) && !cnbcForeignFallback({ symbol: "7203.T", countryCode: "JP" }));

// ---------- /api/etf/ucits ----------
const day = (d, c) => ({ close: String(c), tradeTime: d.replace(/-/g, "") + "000000", tradeTimeinMills: Date.parse(d + "T04:00:00Z") });
const quoteCalls = [], barCalls = [], otherCalls = [];
const fxq = (symbol, last, prev) => ({ symbol, code: 0, name: symbol, last, previous_day_closing: prev, change: "0", change_pct: "0%", last_time: "2026-10-21T16:20:00.000+0200", currencyCode: "USD", exchange: "Currency", realTime: "true" });
const QUOTES = { "EUNL-DE": eunl, "VWCE-DE": { ...eunl, symbol: "VWCE-DE", name: "Vanguard FTSE All-World UCITS ETF USD Accumulating", last: "170.66", change_pct: "-0.10%" }, "SXR8-DE": { ...smh, symbol: "SXR8-DE" },
  "IWDA-GB": { ...eunl, symbol: "IWDA-GB", last: "146.76", previous_day_closing: "146.20", change: "0.56", change_pct: "0.38%", currencyCode: "USD", exchange: "London Stock Exchange", countryCode: "GB" },
  "SWDA-GB": { ...eunl, symbol: "SWDA-GB", last: "10,960", previous_day_closing: "10,920", change: "40", change_pct: "0.37%", currencyCode: "GBp", exchange: "London Stock Exchange", countryCode: "GB" },
  "2B7K-DE": { ...eunl, symbol: "2B7K-DE", last: "10.00", previous_day_closing: "9.90", change: "0.10", change_pct: "1.01%" },
  "EUR=": fxq("EUR=", "1.1650", "1.1600"), "GBP=": fxq("GBP=", "1.3300", "1.3300"), "CHF=": fxq("CHF=", "0.8000", "0.8000") };
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.startsWith("https://quote.cnbc.com/")) {
    const syms = decodeURIComponent(new URL(u).searchParams.get("symbols")).split("|"); quoteCalls.push(syms.length);
    return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((s) => QUOTES[s] || { symbol: s, code: 1 }) } }));
  }
  if (u.startsWith("https://ts-api.cnbc.com/")) {
    const sym = decodeURIComponent(u.split("/bars/")[1].split("/")[0]); barCalls.push(sym);
    if (sym === "EUR=") return new Response(JSON.stringify({ barData: { priceBars: [day("2025-10-17", 1.10), day("2025-12-30", 1.12), day("2026-07-20", 1.15), day("2026-09-18", 1.16), day("2026-10-13", 1.165), day("2026-10-20", 1.16)] } }));
    if (sym !== "EUNL-DE" && sym !== "2B7K-DE") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ barData: { priceBars: [day("2025-10-20", 110), day("2025-12-31", 115), day("2026-07-21", 120), day("2026-09-18", 125), day("2026-10-13", 128), day("2026-10-20", 130.28)] } }));
  }
  otherCalls.push(u); return new Response("", { status: 404 });
};
const kv = new Map();
const BRIEFS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } };
kv.set(JUSTETF_KEY, JSON.stringify({ IE00B4L5Y983: { ter: 0.2, fundSize: { value: 131754e6, currency: "EUR" }, distribution: "Accumulating", replication: "Physical (Optimized sampling)", domicile: "Ireland", fundCurrency: "USD", hedged: false, inception: "25 September 2009", holdings: 1252, legalStructure: "ETF", fetchedAt: Date.now() - 86400_000 },
  IE00BK5BQT80: { triedAt: Date.now(), err: "no_reference_data" } }));
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", TWELVEDATA_KEY: "td-secret", BRIEFS };
const call = async (path) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, { waitUntil() {} }); const text = await r.text(); return { status: r.status, j: JSON.parse(text), text }; };

let r = await call("/api/etf/ucits");
const row = (isin) => r.j.rows.find((x) => x.isin === isin);
ok("all 72 funds (EUR by default) and CNBC's three FX rates in two requests (≤ 40 codes each); nothing asked of justETF or Twelve Data when the page opens", r.status === 200 && r.j.ccy === "EUR" && r.j.rows.length === 72 && quoteCalls.length === 2 && quoteCalls.every((n) => n <= 40) && quoteCalls[0] + quoteCalls[1] === 75 && otherCalls.length === 0, JSON.stringify(quoteCalls));
const s1 = row("IE00B4L5Y983");
ok("SWDA row: EUNL Xetra price in EUR with CNBC's change and time, LIVE; the line it comes from said", s1.sym === "SWDA" && s1.price === 130.69 && s1.currency === "EUR" && s1.changePct === 0.32 && s1.status === "LIVE" && s1.line.ticker === "EUNL" && s1.line.venue === "Xetra" && s1.line.id === "C:EUNL-DE" && /^2026-10-21T14:10/.test(s1.asOf));
ok("…with justETF's reference data (TER, size, distribution, replication…), its source page and the date read", s1.ref && s1.ref.ter === 0.2 && s1.ref.fundSize.value === 131754e6 && s1.ref.distribution === "Accumulating" && s1.ref.source === "justETF" && s1.ref.sourceUrl === justEtfUrl("IE00B4L5Y983") && s1.ref.status === "LIVE" && !("price" in s1.ref));
ok("a fund justETF had no data for: reference data null (N/A), its price still shown", row("IE00BK5BQT80").ref === null && row("IE00BK5BQT80").price === 170.66);
ok("a line CNBC answered from the U.S. (SXR8-DE fixture with a U.S. answer) and lines with no quote: N/A, nothing in their place", row("IE00B5BMR087").price === null && row("IE00B5BMR087").status === "N/A" && row("IE0032077012").status === "N/A");
ok("the response: PARTIAL (some lines without a price), sources named, how many funds have reference data", r.j.status === "PARTIAL" && /CNBC/.test(r.j.source) && /justETF/.test(r.j.source) && r.j.refCount === 1 && r.j.parts === 5 && !r.text.includes("td-secret"));

r = await call("/api/etf/ucits/returns?part=0");
const ret = r.j.returns["IE00B4L5Y983"];
ok("returns, part 0: 16 lines, one daily-bars request each; reference closes from the same line (1W, 1M, 3M, YTD, 1Y), never interpolated", r.status === 200 && barCalls.length === 16 && ret.ref["1Y"][0] === "2025-10-20" && ret.ref.YTD[0] === "2025-12-31" && ret.ref["1M"][0] === "2026-09-18" && ret.ref["1W"][0] === "2026-10-13" && ret.ref["3M"][0] === "2026-07-21" && ret.lastClose[1] === 130.28, JSON.stringify(ret));
ok("…a line without bars is an error for that fund only", r.j.errors["IE00BK5BQT80"] === "no_data" && /DERIVED/.test(r.j.basis));
r = await call("/api/etf/ucits/returns?part=9");
ok("a part outside the list → 400", r.status === 400);

// ---------- another currency: the fund's own line, or its default line converted (DERIVED) ----------
ok("FX from CNBC's codes: EUR→USD at EUR=, GBP→EUR via GBP= and EUR=, USD→CHF at CHF= (CHF per USD)", Math.abs(fxRate("EUR", "USD", { "EUR=": 1.165 }) - 1.165) < 1e-12 && Math.abs(fxRate("GBP", "EUR", { "EUR=": 1.165, "GBP=": 1.33 }) - 1.33 / 1.165) < 1e-12 && Math.abs(fxRate("USD", "CHF", { "CHF=": 0.8 }) - 0.8) < 1e-12 && fxRate("EUR", "USD", {}) === null);
quoteCalls.length = 0; r = await call("/api/etf/ucits?ccy=USD");
const u1 = row("IE00B4L5Y983"), u2 = row("IE00BYX2JD69");
ok("USD: SWDA on its own USD line (IWDA London, 146.76, CNBC's change), LIVE, not converted", r.j.ccy === "USD" && u1.price === 146.76 && u1.currency === "USD" && u1.line.cnbc === "IWDA-GB" && u1.line.venue === "London" && u1.changePct === 0.38 && u1.conv === null && u1.own === true && u1.status === "LIVE", JSON.stringify(u1).slice(0, 300));
ok("USD: a fund with no USD line (iShares MSCI World SRI) — its Xetra EUR price × EUR= 1.1650, DERIVED, the rate and its source said; the change at today's vs yesterday's rate", Math.abs(u2.price - 10 * 1.165) < 1e-9 && u2.currency === "USD" && u2.own === false && u2.conv.from === "EUR" && u2.conv.rate === 1.165 && /CNBC FX/.test(u2.conv.source) && u2.status === "DERIVED" && Math.abs(u2.changePct - ((10 * 1.165) / (9.9 * 1.16) - 1) * 100) < 1e-9, JSON.stringify(u2).slice(0, 400));
ok("USD: the response counts own lines and conversions; the request for USD is its own cached copy", r.j.own >= 1 && r.j.converted >= 1 && /converted at CNBC/.test(r.j.basis) && quoteCalls.length <= 4 && quoteCalls.every((n) => n <= 40), JSON.stringify(quoteCalls));
r = await call("/api/etf/ucits?ccy=GBP");
ok("GBP: SWDA's London line quoted in pence → 10,960 GBp shown as 109.60 GBP (a unit, not a conversion), change in GBP", row("IE00B4L5Y983").price === 109.6 && row("IE00B4L5Y983").currency === "GBP" && row("IE00B4L5Y983").pence === true && row("IE00B4L5Y983").change === 0.4 && row("IE00B4L5Y983").conv === null);
r = await call("/api/etf/ucits?ccy=JPY");
ok("a currency outside EUR, USD, GBP, CHF → 400", r.status === 400 && /EUR, USD, GBP, CHF/.test(r.j.message));
QUOTES["IWDA-GB"] = { ...QUOTES["IWDA-GB"], currencyCode: "EUR" }; store.clear();
r = await call("/api/etf/ucits?ccy=USD");
const cc = row("IE00B4L5Y983");
ok("a line CNBC now quotes in another currency than checked: never shown as USD — the default line converted instead (DERIVED), the reason kept", Math.abs(cc.price - 130.69 * 1.165) < 1e-9 && cc.status === "DERIVED" && cc.conv.from === "EUR" && cc.line.cnbc === "EUNL-DE" && cc.ownLine.cnbc === "IWDA-GB" && cc.ownLine.error === "currency_changed", JSON.stringify(cc).slice(0, 300));
QUOTES["EUNL-DE"] = { ...QUOTES["EUNL-DE"], currencyCode: "GBP" }; store.clear(); r = await call("/api/etf/ucits?ccy=USD");
ok("…and when the default line is wrong too: N/A, nothing shown in its place", row("IE00B4L5Y983").price === null && row("IE00B4L5Y983").error === "currency_changed");
QUOTES["EUNL-DE"] = eunl; QUOTES["IWDA-GB"] = { ...QUOTES["IWDA-GB"], currencyCode: "USD" }; store.clear();
barCalls.length = 0; r = await call("/api/etf/ucits/returns?part=0&ccy=USD");
const rc = r.j.returns["IE00BYX2JD69"];
ok("returns in USD, part 0: the converted fund's bars × EUR= on the same day (1Y: 110 × 1.10 on 20 Oct 2025 — the rate's close on or before), the FX bars asked once", r.j.ccy === "USD" && rc.converted === "EUR→USD" && Math.abs(rc.ref["1Y"][1] - 110 * 1.10) < 1e-9 && Math.abs(rc.lastClose[1] - 130.28 * 1.16) < 1e-9 && barCalls.filter((x) => x === "EUR=").length === 1, JSON.stringify(rc));

// ---------- justETF's profile page ----------
const PAGE = `<html><head><title>iShares Core MSCI World UCITS ETF USD (Acc) | IWDA | IE00B4L5Y983</title></head><body>${"<div>menu</div>".repeat(80)}
<div class="infobox">Distribution policy <span>Accumulating</span> Replication <span>Physical</span> Fund size <span>EUR 131,754 m</span> Inception Date <span>25 September 2009</span> Holdings <span>1,252</span></div>
<table><tr data-testid="etf-basics_row_fund-size"><td class="vallabel" data-testid="etf-basics_label_fund-size"> Fund size </td> <td> <div> EUR 131,754 m <span class="indicator-3"></span> </div> </td> </tr>
<tr data-testid="etf-basics_row_ter"> <td class="vallabel" data-testid="etf-basics_label_ter"> Total expense ratio </td> <td> <div class="val" data-testid="tl_etf-basics_value_ter"> <span data-testid="tl_etf-basics_value_ter">0.20% p.a.</span>  </div> </td> </tr>
<tr data-testid="etf-basics_row_replication"> <td class="vallabel" data-testid="etf-basics_label_replication"> Replication </td> <td> <span class="val" data-testid="tl_etf-basics_value_replication">Physical</span> (<span class="val2" data-testid="tl_etf-basics_value_replication-method">Optimized sampling</span>) </td> </tr>
<tr><td class="vallabel">Legal structure</td><td>ETF</td></tr><tr><td class="vallabel">Fund currency</td><td>USD</td></tr><tr><td class="vallabel">Currency risk</td><td>Currency unhedged</td></tr>
<tr><td class="vallabel">Inception/ Listing Date</td><td>25 September 2009</td></tr><tr><td class="vallabel">Fund domicile</td><td>Ireland</td></tr></table></body></html>`;
const m = parseJustEtf(PAGE);
ok("profile page → TER 0.20, fund size EUR 131,754 m, accumulating, physical (optimized sampling — the fuller of the two rows), Ireland, USD, unhedged, inception, holdings, ETF",
  m.ter === 0.2 && m.fundSize.value === 131754e6 && m.fundSize.currency === "EUR" && m.distribution === "Accumulating" && m.replication === "Physical (Optimized sampling)" && m.domicile === "Ireland" && m.fundCurrency === "USD" && m.hedged === false && m.inception === "25 September 2009" && m.holdings === 1252 && m.legalStructure === "ETF", JSON.stringify(m));
ok("no price, no performance figure is read from justETF", Object.keys(m).every((k) => !/price|last|return|perf|nav/i.test(k)));
ok("a page without the profile table (an unknown ISIN, a search page) → nothing", parseJustEtf("<html>" + "<p>justETF</p>".repeat(200) + "</html>") === null && parseJustEtf("") === null);

// ---------- the cron: one fund a run ----------
const kv2 = new Map(), env2 = { BRIEFS: { get: async (k) => kv2.get(k) ?? null, put: async (k, v, o) => { kv2.set(k, v); kv2.ttl = o && o.expirationTtl; } } };
const asked = []; let reply = () => ({ text: PAGE, http: 200 });
const fetchImpl = async (u) => { asked.push(u); return reply(u); };
const now0 = Date.parse("2026-10-21T15:00:00Z");
let x = await refreshJustEtf(env2, now0, fetchImpl);
const saved = () => JSON.parse(kv2.get(JUSTETF_KEY));
ok("first run: one request, the first fund in the list, kept in KV (30 days)", x.action === "refreshed" && asked.length === 1 && asked[0] === justEtfUrl(UCITS_ETFS[0].isin) && saved()[UCITS_ETFS[0].isin].ter === 0.2 && kv2.ttl === 30 * 86400);
x = await refreshJustEtf(env2, now0 + 300_000, fetchImpl);
ok("next run: the next fund not read yet", x.isin === UCITS_ETFS[1].isin && asked.length === 2);
reply = () => ({ text: "<html>" + "<p>x</p>".repeat(400) + "</html>", http: 200 });
x = await refreshJustEtf(env2, now0 + 600_000, fetchImpl);
ok("a page without the data: that fund marked tried (again in a week), the cron moves on", x.action === "no_data" && saved()[UCITS_ETFS[2].isin].triedAt === now0 + 600_000 && !saved()[UCITS_ETFS[2].isin].ter);
reply = () => ({ err: "provider_forbidden", http: 403 });
x = await refreshJustEtf(env2, now0 + 900_000, fetchImpl);
const n1 = asked.length;
x = await refreshJustEtf(env2, now0 + 1200_000, fetchImpl);
ok("justETF refusing (403): no request for hours — no hammering", x.action === "backoff" && asked.length === n1 && saved()._fail.err === "provider_forbidden");
reply = () => ({ text: PAGE, http: 200 });
x = await refreshJustEtf(env2, now0 + 7 * 3600_000, fetchImpl);
ok("after the pause: reads again, the failure cleared", x.action === "refreshed" && !saved()._fail);
const all = saved(); for (const e of UCITS_ETFS) all[e.isin] = { ter: 0.1, fetchedAt: now0 }; kv2.set(JUSTETF_KEY, JSON.stringify(all));
const n2 = asked.length; x = await refreshJustEtf(env2, now0 + 6 * 86400_000, fetchImpl);
ok("all read within the week: no request; after 7 days the oldest again", x.action === "fresh" && asked.length === n2 && (await refreshJustEtf(env2, now0 + 7 * 86400_000 + 1, fetchImpl)).action === "refreshed");
ok("without the KV binding: nothing", (await refreshJustEtf({}, now0, fetchImpl)).action === "skipped");

// ---------- SRCH ----------
ok("search names: SWDA, IWDA, EUNL → the same fund (its lines by currency listed); 'nasdaq' → the Nasdaq-100 funds; an ISIN → its fund", ucitsMatch("swda")[0].isin === "IE00B4L5Y983" && ucitsMatch("swda")[0].lines.USD === "C:IWDA-GB" && ucitsMatch("IWDA")[0].sym === "SWDA" && ucitsMatch("EUNL")[0].sym === "SWDA" && ucitsMatch("nasdaq").length === 3 && ucitsMatch("IE00B5BMR087")[0].sym === "CSSPX" && ucitsMatch("zz").length === 0);
globalThis.fetch = async (u) => { u = String(u); if (u.startsWith("https://api.twelvedata.com/symbol_search")) return new Response(JSON.stringify({ data: [], status: "ok" })); return new Response("", { status: 404 }); };
r = await call("/api/search?q=SWDA");
ok("/api/search?q=SWDA: the UCITS fund with its price line (C:EUNL-DE) alongside the provider's listings", r.status === 200 && r.j.ucits.length === 1 && r.j.ucits[0].line.id === "C:EUNL-DE" && r.j.ucits[0].isin === "IE00B4L5Y983");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
