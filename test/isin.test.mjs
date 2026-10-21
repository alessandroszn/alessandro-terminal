// ISIN search (OpenFIGI, approved 21 Oct 2026): check digit, Bloomberg exchange codes → MICs, OpenFIGI's listings matched
// to Twelve Data's records, the home market first; reference data only. Provider answers are fixtures in their formats.
import { app as worker } from "../src/worker.mjs";
import { isinValid, figiListings, EXCH_MIC } from "../src/isin.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };

ok("check digit (ISO 6166): Apple, NVIDIA, Intesa Sanpaolo, Novartis, SAP, ASML, Vodafone, an iShares ETF valid; one digit off invalid",
  ["US0378331005", "US67066G1040", "IT0000072618", "CH0012005267", "DE0007164600", "NL0010273215", "GB00BH4HKS39", "IE00B4BNMY34"].every(isinValid) && !isinValid("US0378331006") && !isinValid("IT000007261") && !isinValid("AAPL"));
ok("Bloomberg exchange codes → MIC: IM Milan, GY Xetra, SW SIX, LN London, JT Tokyo, HK; US venues one listing; unknown venues dropped",
  EXCH_MIC.IM === "XMIL" && EXCH_MIC.GY === "XETR" && EXCH_MIC.SW === "XSWX" && EXCH_MIC.LN === "XLON" && EXCH_MIC.JT === "XJPX" && EXCH_MIC.HK === "XHKG" &&
  JSON.stringify(figiListings([{ ticker: "AAPL", exchCode: "US" }, { ticker: "AAPL", exchCode: "UW" }, { ticker: "APC", exchCode: "GY" }, { ticker: "AAPL", exchCode: "ZZ" }, { ticker: "BRK/B", exchCode: "UN" }]).map((x) => x.id)) === JSON.stringify(["AAPL", "APC:XETR", "BRK.B"]));

// OpenFIGI /v3/mapping and Twelve Data /symbol_search in their formats
const FIGI = {
  IT0000072618: [{ data: [
    { figi: "BBG000BNSF93", name: "INTESA SANPAOLO", ticker: "ISP", exchCode: "IM", compositeFIGI: "BBG000BNSF93", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" },
    { figi: "BBG000BNSF02", name: "INTESA SANPAOLO", ticker: "IES", exchCode: "GY", compositeFIGI: "BBG000BNSF84", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" },
    { figi: "BBG000BNSF11", name: "INTESA SANPAOLO", ticker: "IES", exchCode: "GF", compositeFIGI: "BBG000BNSF84", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" },
    { figi: "BBG000BNSF20", name: "INTESA SANPAOLO", ticker: "IES", exchCode: "GM", compositeFIGI: "BBG000BNSF84", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" },
    { figi: "BBG000BNSF39", name: "INTESA SANPAOLO", ticker: "ISNPF", exchCode: "US", compositeFIGI: "BBG000BNSF39", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" },
  ] }],
  US67066G1040: [{ data: [{ figi: "BBG000BBJQV0", name: "NVIDIA CORP", ticker: "NVDA", exchCode: "US", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" },
    { figi: "BBG000BBJR03", name: "NVIDIA CORP", ticker: "NVDA", exchCode: "UW", securityType: "Common Stock", marketSector: "Equity", securityType2: "Common Stock" }] }],
  DE0007164600: [{ warning: "No identifier found." }],
};
const row = (symbol, name, exchange, mic, country, currency, plan) => ({ symbol, instrument_name: name, exchange, mic_code: mic, exchange_timezone: "UTC", instrument_type: "Common Stock", country, currency, access: { global: plan, plan } });
const TD = {
  ISP: [row("ISP", "Intesa Sanpaolo S.p.A.", "MTA", "XMIL", "Italy", "EUR", "Grow"), row("ISP", "Some Other ISP", "NYSE", "XNYS", "United States", "USD", "Basic")],
  IES: [row("IES", "Intesa Sanpaolo S.p.A.", "XETR", "XETR", "Germany", "EUR", "Grow")],
  ISNPF: [],
  NVDA: [row("NVDA", "NVIDIA Corporation", "NASDAQ", "XNGS", "United States", "USD", "Basic")],
};
const seen = [];
let figiDown = false;
globalThis.fetch = async (u, init = {}) => {
  u = String(u); seen.push({ u, init });
  if (u === "https://api.openfigi.com/v3/mapping") { if (figiDown) return new Response("{}", { status: 429 }); const b = JSON.parse(init.body); return new Response(JSON.stringify(FIGI[b[0].idValue] || [{ warning: "No identifier found." }])); }
  if (u.startsWith("https://api.twelvedata.com/symbol_search")) { const q = new URL(u).searchParams.get("symbol"); return new Response(JSON.stringify({ data: TD[q] || [], status: "ok" })); }
  return new Response("", { status: 404 });
};
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", TWELVEDATA_KEY: "td-secret", OPENFIGI_KEY: "figi-secret-key" };
const call = async (q, e = env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com/api/search?q=" + encodeURIComponent(q)), e, { waitUntil() {} }); const text = await r.text(); return { status: r.status, j: JSON.parse(text), text }; };

let r = await call("IT0000072618");
const figiCall = seen.find((x) => x.u.includes("openfigi"));
ok("an ISIN goes to OpenFIGI: POST, JSON, ID_ISIN; the key only in the X-OPENFIGI-APIKEY header", figiCall && figiCall.init.method === "POST" && JSON.parse(figiCall.init.body)[0].idType === "ID_ISIN" && figiCall.init.headers["x-openfigi-apikey"] === "figi-secret-key" && figiCall.init.headers["content-type"] === "application/json");
ok("IT0000072618 → Intesa Sanpaolo: Milan first (home market), then Xetra, Frankfurt, the U.S. line; other German venues not quoted here left out", r.status === 200 && r.j.isin === "IT0000072618" && r.j.name === "INTESA SANPAOLO" && JSON.stringify(r.j.results.map((x) => x.id)) === JSON.stringify(["ISP:XMIL", "IES:XETR", "IES:XFRA", "ISNPF"]), JSON.stringify(r.j.results.map((x) => x.id)));
const isp = r.j.results[0];
ok("the Milan listing is Twelve Data's own record (name, currency, plan), quotable through CNBC outside the plan, with the ISIN", isp.name === "Intesa Sanpaolo S.p.A." && isp.currency === "EUR" && isp.planRequired === "Grow" && isp.quotable === true && isp.via === "CNBC" && isp.cnbc === "ISP-IT" && isp.isin === "IT0000072618");
const ff = r.j.results.find((x) => x.id === "IES:XFRA");
ok("a listing Twelve Data did not return: named from OpenFIGI, exchange and country from the MIC, CNBC when it carries it", ff.from === "OpenFIGI" && ff.exchange === "Frankfurt" && ff.country === "Germany" && ff.quotable === true && ff.cnbc === "IES-FF" && ff.currency === null);
ok("a ticker's other companies are not mixed in (ISP on NYSE is another issuer)", !r.j.results.some((x) => x.id === "ISP" && x.mic === "XNYS") && !r.j.results.some((x) => x.name === "Some Other ISP"));
ok("Twelve Data asked for at most three tickers, the home market's first", seen.filter((x) => x.u.includes("symbol_search")).map((x) => new URL(x.u).searchParams.get("symbol")).join() === "ISP,IES,ISNPF");
ok("no key in the response; reference data only (no prices)", !r.text.includes("figi-secret-key") && !r.text.includes("td-secret") && !/"(price|last|close)"/.test(r.text) && /OpenFIGI/.test(r.j.source));
r = await call("US67066G1040");
ok("US67066G1040 → NVDA (one U.S. listing for every U.S. venue), quotable on the plan", r.j.results.length === 1 && r.j.results[0].id === "NVDA" && r.j.results[0].quotable === true && r.j.results[0].isin === "US67066G1040");
r = await call("DE0007164600");
ok("an ISIN OpenFIGI does not know: no listing, said so (nothing guessed)", r.status === 200 && r.j.count === 0 && r.j.results.length === 0 && /No identifier found/.test(r.j.note));
seen.length = 0; r = await call("US0378331006");
ok("a wrong check digit is not an ISIN: an ordinary name / ticker search, OpenFIGI not asked", !seen.some((x) => x.u.includes("openfigi")) && seen.some((x) => x.u.includes("symbol_search")));
figiDown = true; r = await call("CH0012005267", { ...env, OPENFIGI_KEY: undefined });
ok("OpenFIGI over its limit → N/A rate_limited (429), no listing invented", r.status === 429 && r.j.error === "rate_limited" && r.j.results.length === 0);
const nokey = seen.filter((x) => x.u.includes("openfigi")).pop();
ok("without OPENFIGI_KEY no key header is sent", nokey && !("x-openfigi-apikey" in nokey.init.headers));
// OpenFIGI does not know it, Twelve Data's own search does: its listings, the home market first
TD.CH0012005267 = [row("NOVN", "Novartis AG", "SIX", "XSWX", "Switzerland", "CHF", "Grow"), row("NVS", "Novartis AG", "NYSE", "XNYS", "United States", "USD", "Basic"), row("NOT", "Novartis AG", "XETR", "XETR", "Germany", "EUR", "Grow")];
figiDown = false; r = await call("CH0012005267");
ok("OpenFIGI without the ISIN, Twelve Data's search with it: those listings, the home market (SIX) first, the source said", r.status === 200 && r.j.results[0].id === "NOVN:XSWX" && r.j.count === 3 && /Twelve Data symbol_search \(ISIN\)/.test(r.j.source) && r.j.openfigi === "no_identifier" && r.j.results.every((x) => x.isin === "CH0012005267"), JSON.stringify(r.j).slice(0, 300));
figiDown = true; r = await call("CH0012005267");
ok("OpenFIGI over its limit, Twelve Data knows the ISIN: its listings rather than N/A", r.status === 200 && r.j.results[0].id === "NOVN:XSWX" && r.j.openfigi === "rate_limited");
figiDown = false; delete TD.CH0012005267;
r = await call("it0000072618");
ok("lower case is accepted (ISINs are case-insensitive)", r.j.isin === "IT0000072618");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
