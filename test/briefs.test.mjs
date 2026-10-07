// T06 — briefings in the reference format (Daily / Evening / Weekly / Monthly), Worker side.
// Mocked: fetch (all sources), Cache API, KV archive, Workers AI.
//   node test/briefs.test.mjs
import { app as worker } from "../src/worker.mjs";
import { dueEdition, equitySummary, buildData, parseOutput, sanitize, attachWindows, storyWindows, localizeWindows, PERIODS, systemPrompt } from "../src/briefs.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
const at = (s) => Date.parse(s);

// ---------- schedule (Europe/Rome; CEST = UTC+2 in October) ----------
ok("daily before 07:30 Rome → previous weekday's edition", dueEdition("daily", at("2026-10-06T05:00:00Z")).id === "daily-2026-10-05");
ok("daily after 07:30 Rome → today's edition", dueEdition("daily", at("2026-10-06T05:31:00Z")).id === "daily-2026-10-06");
ok("daily on Saturday → Friday's edition", dueEdition("daily", at("2026-10-10T09:00:00Z")).id === "daily-2026-10-09");
ok("evening after 22:30 Rome → today's; before → yesterday's", dueEdition("evening", at("2026-10-06T20:31:00Z")).id === "evening-2026-10-06" && dueEdition("evening", at("2026-10-06T20:00:00Z")).id === "evening-2026-10-05");
ok("weekly → the last Saturday after 08:00", dueEdition("weekly", at("2026-10-10T06:01:00Z")).id === "weekly-2026-10-10" && dueEdition("weekly", at("2026-10-09T12:00:00Z")).id === "weekly-2026-10-03");
ok("monthly → first Saturday of the month", dueEdition("monthly", at("2026-10-20T12:00:00Z")).id === "monthly-2026-10-03" && dueEdition("monthly", at("2026-10-02T12:00:00Z")).id === "monthly-2026-09-05");
ok("write window: daily writable the same day, not the next; weekly over the weekend only", dueEdition("daily", at("2026-10-06T12:00:00Z")).writable === true && dueEdition("weekly", at("2026-10-11T12:00:00Z")).writable === true && dueEdition("weekly", at("2026-10-14T12:00:00Z")).writable === false && dueEdition("evening", at("2026-10-07T04:00:00Z")).writable === true && dueEdition("evening", at("2026-10-07T09:00:00Z")).writable === false);
ok("sections follow the reference format", PERIODS.daily.sections.join("|") === "In one line|Equities|Rates and currencies|Commodities and crypto|Today" && PERIODS.evening.sections.join("|") === "In one line|How the day went|What changed since this morning|Tomorrow" && PERIODS.weekly.sections[0] === "The week in one paragraph" && PERIODS.weekly.sections.at(-1) === "Next week");

// ---------- S&P 500 summary (derived from real constituent closes) ----------
const items = [{ sym: "AAA", name: "A CORP", sector: "Tech", weight: 6 }, { sym: "BBB", name: "B CORP", sector: "Tech", weight: 3 }, { sym: "CCC", name: "C CORP", sector: "Energy", weight: 1 }, { sym: "DDD", name: "NO DATA", sector: "Energy", weight: 1 }];
const recent = { AAA: [["2026-10-02", 98], ["2026-10-05", 100], ["2026-10-06", 102]], BBB: [["2026-10-05", 50], ["2026-10-06", 49]], CCC: [["2026-10-05", 20], ["2026-10-06", 20.2]] };
const eq = equitySummary(items, recent, { todayET: "2026-10-07", todayFinal: false });
ok("equity: IVV-weighted average of close-to-close changes", Math.abs(eq.avg - (6 * 2 + 3 * -2 + 1 * 1) / 10) < 1e-9 && eq.lastDate === "2026-10-06" && eq.baseDate === "2026-10-05");
ok("equity: breadth and coverage (constituent without data excluded, not invented)", eq.up === 2 && eq.down === 1 && eq.n === 3 && eq.total === 4);
ok("equity: sectors (sorted by change) and contributions", eq.sectors[0].name === "Energy" && Math.abs(eq.sectors.find((x) => x.name === "Tech").chg - (6 * 2 + 3 * -2) / 9) < 1e-9 && eq.topContrib[0].sym === "AAA" && eq.bottomContrib[0].sym === "BBB");
const eqLive = equitySummary(items, recent, { live: { AAA: [103, "2026-10-07T15:00:00Z"] }, todayET: "2026-10-07", todayFinal: false });
ok("equity live: IEX last trade vs last completed close", eqLive.n === 1 && Math.abs(eqLive.avg - 0.98039215686) < 1e-6);

// ---------- DATA, prompt, output handling ----------
const now = at("2026-10-07T05:40:00Z");
const data = buildData({ period: "daily", edition: { id: "daily-2026-10-07", d: "2026-10-07" }, now, eq, eqMode: "close",
  quotes: [{ symbol: "EUR/USD", name: "Euro / US Dollar", price: 1.12021, changePct: -0.52, prevClose: 1.12605, currency: null, timestamp: "2026-10-07T05:30:00.000Z" }],
  curves: {}, events: [{ dateET: "2026-10-07", timeET: "08:30", indicator: "Consumer Price Index", source: "BLS", datetime: "2026-10-07T12:30:00.000Z" }],
  headlines: [{ title: "Test headline", url: "https://www.ft.com/content/x1", timestamp: "2026-10-07T05:00:00.000Z", source: "Financial Times", section: "Markets" }] });
ok("DATA: equity line labelled as derived, not the index level", /EQUITY S&P 500 constituents, IVV-weighted average change \(derived; not the index level\): \+0\.70%/.test(data.text));
ok("DATA: tickers in backticks, quotes, events, headlines with URL", /`AAA` A CORP/.test(data.text) && /QUOTE `EUR\/USD`/.test(data.text) && /EVENT 2026-10-07 08:30 ET United States Consumer Price Index \[BLS\]/.test(data.text) && /HEADLINE .*Test headline — https:\/\/www\.ft\.com\/content\/x1/.test(data.text));
const dataFF = buildData({ period: "daily", edition: { id: "daily-2026-10-07", d: "2026-10-07" }, now, eq: null, quotes: [], curves: {}, headlines: [],
  events: [{ dateET: "2026-10-07", timeET: "08:30", region: "United States", currency: "USD", indicator: "CPI m/m", impact: "High", forecast: { value: "0.3%" }, previous: { value: "0.2%" }, source: "FF", sourceUrl: "https://www.forexfactory.com/calendar", datetime: "2026-10-07T12:30:00.000Z" }] });
ok("DATA: world event with impact, forecast and previous from Forex Factory", /EVENT 2026-10-07 08:30 ET United States \(USD\) CPI m\/m — impact High — forecast 0\.3%, previous 0\.2% \[Forex Factory\]/.test(dataFF.text) && dataFF.sources.some((x) => /Forex Factory/.test(x.name)), dataFF.text);
ok("DATA: chip symbols = only symbols present in DATA", data.symbols.includes("AAA") && data.symbols.includes("EUR/USD") && !data.symbols.includes("DDD"));
ok("prompt: exact sections, DATA only, no index level, links only from DATA, no advice", /'## In one line', '## Equities'/.test(systemPrompt("daily")) && /ONLY the facts in DATA/.test(systemPrompt("daily")) && /not the index level/.test(systemPrompt("daily")) && /Use no other URL/.test(systemPrompt("daily")) && /never recommend/.test(systemPrompt("daily")));
const MODEL_OUT = `TITLE: Constituents edge up while the euro slips\n## In one line\nS&P 500 constituents rose 0.70% on an IVV-weighted basis.\n## Equities\n\`AAA\` gained 2.00% while \`BBB\` fell 2.00%; \`ZZZ\` did 9.99%.\n## Rates and currencies\n\`EUR/USD\` fell 0.52% [FT](https://www.ft.com/content/x1) and [rumour](https://evil.example.com/a).\n## Commodities and crypto\nData is not available.\n## Today\n- Consumer Price Index at 08:30 ET.`;
const po = parseOutput(MODEL_OUT, "daily");
ok("output: title extracted, all sections present", po.title === "Constituents edge up while the euro slips" && po.missingSections.length === 0 && !/TITLE:/.test(po.body));
ok("output: missing sections reported", parseOutput("## In one line\nx", "daily").missingSections.length === 4);
const sz = sanitize(po.body, data.text);
ok("links: kept only if the URL is in DATA", /\[FT\]\(https:\/\/www\.ft\.com\/content\/x1\)/.test(sz.body) && !/evil\.example/.test(sz.body) && sz.removedLinks[0] === "https://evil.example.com/a");
const w = attachWindows("daily", eq);
ok("windows: heat map, top/bottom contributor charts, curves, markets", w[0].type === "MAP" && w[0].state.metric === "1D" && w.some((x) => x.type === "GP" && x.state.ticker === "AAA" && x.state.tf === "1W") && w.some((x) => x.type === "GP" && x.state.ticker === "BBB") && w.some((x) => x.type === "YLD"));
// story windows: chosen from the edition's data, each tied to the section it explains, reason built from the same figures
const CURVES = { US: { id: "US", points: [{ tenor: "2Y", value: 3.6, changeBp: 1 }, { tenor: "10Y", value: 4.13, changeBp: 3 }] }, EA: { id: "EA", points: [{ tenor: "2Y", value: 3.05, changeBp: 5.5 }, { tenor: "10Y", value: 3.52, changeBp: 1.7 }] } };
const QUOTES = [{ symbol: "EUR/USD", price: 1.12, changePct: -0.52 }, { symbol: "USD/JPY", price: 158.1, changePct: 0.71 }, { symbol: "XAU/USD", price: 4165.24, changePct: 1.01 }, { symbol: "BTC/USD", price: 85650, changePct: -2.4 }];
const EVENTS = [{ id: "FF-b", dateET: "2026-10-07", timeET: "10:00", datetime: "2026-10-07T14:00:00.000Z", currency: "USD", region: "United States", indicator: "Federal Funds Rate", forecast: { value: "4.00%" }, previous: { value: "3.75%" } }, { id: "FF-a", dateET: "2026-10-07", timeET: "08:30", datetime: "2026-10-07T12:30:00.000Z", currency: "USD", region: "United States", indicator: "CPI m/m", forecast: { value: "0.3%" }, previous: { value: "0.2%" } }];
const sw = storyWindows("daily", { eq, quotes: QUOTES, curves: CURVES, events: EVENTS });
const byT = (t) => sw.filter((x) => x.type === t);
ok("story windows: each tied to a section of the edition, in section order", sw.every((x) => PERIODS.daily.sections[x.section] === x.sectionName && x.sectionName_it) && sw.every((x, i) => !i || sw[i - 1].section <= x.section) && byT("MAP")[0].section === 1 && byT("YLD")[0].section === 2 && byT("CAL")[0].section === 4, JSON.stringify(sw.map((x) => [x.type, x.section])));
ok("story windows: heat map reason = the edition's own figures (average, advancers, decliners)", byT("MAP")[0].why.includes(`${eq.up} up, ${eq.down} down`) && /\+0\.70%/.test(byT("MAP")[0].why));
ok("story windows: contributors compared (two that added, one that took away), biggest mover chart", byT("COMP")[0] && byT("COMP")[0].state.sel.length === 3 && byT("COMP")[0].state.sel[2] === eq.bottomContrib.find((r) => r.pp < 0).sym && byT("GP").some((x) => x.section === 1));
ok("story windows: largest FX move (USD/JPY), gold, crypto board, curves with 10Y levels, EA 2s10s", byT("GP").some((x) => x.state.ticker === "USD/JPY" && /\+0\.71%/.test(x.why)) && byT("GP").some((x) => x.state.ticker === "XAU/USD" && x.section === 3) && byT("CRYPTO")[0] && /US 10Y 4\.13% \(\+3\.0 bp\)/.test(byT("YLD")[0].why) && /47\.0 bp/.test(byT("SPRD")[0].why), JSON.stringify(sw.map((x) => x.why)));
ok("story windows: the first high-impact event opens in the calendar; a rate decision adds the central banks", byT("CAL")[0].state.ev === "FF-a" && /CPI m\/m, forecast 0\.3%, previous 0\.2%/.test(byT("CAL")[0].why) && byT("CB")[0] && /Federal Funds Rate/.test(byT("CB")[0].label));
ok("story windows: nothing without data (no equities, no curves, no quotes, no events → none)", storyWindows("daily", {}).length === 0 && storyWindows("weekly", {}).some((x) => x.type === "N") === true && storyWindows("weekly", {}).length === 1);
const swIt = localizeWindows(sw, "it");
ok("story windows in Italian: labels, reasons and section names", swIt.every((x) => x.label === x.label_it && x.why === x.why_it) && byT("MAP").length && /in rialzo/.test(swIt.find((x) => x.type === "MAP").why) && swIt.find((x) => x.type === "MAP").sectionName === "Azioni");

// ---------- endpoints (KV + AI mocked; sources unreachable except the quote cache) ----------
const FIXED = at("2026-10-07T07:00:00Z"); Date.now = () => FIXED; // Wednesday 09:00 Rome: the daily edition is due and writable
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };
store.set("https://alessandrozanichelli.com/__cache/quote/EUR%2FUSD", JSON.stringify({ rec: { symbol: "EUR/USD", name: "Euro / US Dollar", price: 1.12021, changePct: -0.52, prevClose: 1.12605, currency: null, asOf: new Date().toISOString() }, fetchedAt: Date.now() }));
globalThis.fetch = async () => new Response("", { status: 404 });
const kv = new Map();
const BRIEFS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
let aiCalls = [];
const MODEL_IT = "TITLE: I titoli salgono mentre l'euro cede\n## In una riga\nL'euro è sceso dello 0.52% contro il dollaro.\n## Azioni\nDati non disponibili.\n## Tassi e valute\n`EUR/USD` è sceso dello 0.52%.\n## Materie prime e cripto\nDati non disponibili.\n## Oggi\nNessun evento.";
const AI = { run: async (model, input) => { aiCalls.push(input); return { response: /in Italian/.test(input.messages[0].content) ? MODEL_IT : MODEL_OUT.replace("0.70%", "0.70%") }; } };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", BRIEFS, AI };
const ctx = { waitUntil: () => {} };
const call = async (path, method = "GET", e = env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path, { method }), e, ctx); const t = await r.text(); return { status: r.status, j: JSON.parse(t), t }; };

let r = await call("/api/briefs?period=daily");
ok("index: empty archive, due edition announced, schedule text", r.status === 200 && r.j.briefs.length === 0 && /^daily-\d{4}-\d{2}-\d{2}$/.test(r.j.due.id) && r.j.dueWritten === false && /07:30/.test(r.j.schedule));
const dueId = r.j.due.id;
r = await call("/api/briefs/write?period=daily&symbols=EUR/USD", "GET");
ok("write needs POST", r.status === 405);
r = await call("/api/briefs/write?period=daily&symbols=EUR/USD", "POST");
ok("write: edition written once from DATA, in English and Italian from the same DATA lines", r.status === 201 && r.j.id === dueId && aiCalls.length === 2 && aiCalls[0].messages[1].content === aiCalls[1].messages[1].content && /QUOTE `EUR\/USD`/.test(aiCalls[0].messages[1].content) && /## Equities/.test(r.j.body));
ok("write: verification reports numbers not in DATA and removed links", r.j.verification.unverified.length >= 1 && r.j.verification.removedLinks.includes("https://evil.example.com/a"));
ok("write: unavailable inputs are recorded (no Alpaca keys → equity N/A), DATA says N/A", r.j.inputErrors.equity === "alpaca_not_configured" && /EQUITY S&P 500 constituent prices: N\/A/.test(r.j.inputData));
ok("write: archived in KV with index", !!kv.get(`brief/${dueId}`) && JSON.parse(kv.get("index/daily"))[0].id === dueId && !kv.has(`lock/${dueId}`));
r = await call("/api/briefs/write?period=daily&symbols=EUR/USD", "POST");
ok("write again: existing edition returned, model not called again", r.status === 200 && aiCalls.length === 2 && r.j.id === dueId);
r = await call(`/api/briefs/item?id=${dueId}`);
ok("item: full edition with title, body, windows, sources, input data", r.status === 200 && r.j.title && r.j.body && Array.isArray(r.j.windows) && Array.isArray(r.j.sources) && r.j.inputData);
r = await call("/api/briefs?period=daily");
ok("index after write: dueWritten", r.j.dueWritten === true && r.j.briefs.length === 1);
kv.set(`lock/${dueId}`, "1");
r = await call("/api/briefs/write?period=daily&force=1", "POST");
ok("a write in progress → 202, no second model call", r.status === 202 && aiCalls.length === 2);
kv.delete(`lock/${dueId}`);
r = await call(`/api/briefs/item?id=${dueId}&lang=it`);
ok("Italian version: Italian title, sections and disclaimer; same number check (decimal point kept); windows labelled in Italian", r.j.lang === "it" && /euro cede/.test(r.j.title) && /## In una riga/.test(r.j.body) && r.j.verification.missingSections.length === 0 && r.j.verification.checked === 2 && r.j.verification.unverified.length === 0 && /Non è una consulenza/.test(r.j.disclaimer) && r.j.windows.length > 0 && r.j.windows.every((w) => w.label === w.label_it && w.why === w.why_it) && r.j.inputData === JSON.parse(kv.get(`brief/${dueId}`)).inputData, JSON.stringify({lang:r.j.lang,title:r.j.title,v:r.j.verification,w:(r.j.windows||[]).map((w)=>w.label)}));
r = await call(`/api/briefs/item?id=${dueId}`);
ok("English version unchanged by default", r.j.lang === "en" && /## In one line/.test(r.j.body));
r = await call("/api/briefs?period=daily");
ok("index: Italian title next to the English one", r.j.briefs[0].title_it && /euro cede/.test(r.j.briefs[0].title_it));
// an edition without the Italian version (written before it existed): written later from its own stored DATA
const old = JSON.parse(kv.get(`brief/${dueId}`)); delete old.i18n; kv.set(`brief/${dueId}`, JSON.stringify(old)); aiCalls = [];
r = await call(`/api/briefs/item?id=${dueId}&lang=it`);
ok("edition without Italian: English served with langMissing", r.j.lang === "en" && r.j.langMissing === "it");
r = await call(`/api/briefs/lang?id=${dueId}&lang=it`, "POST");
ok("POST /api/briefs/lang: Italian written once from the edition's stored DATA (not newer data)", r.status === 201 && r.j.lang === "it" && aiCalls.length === 1 && aiCalls[0].messages[1].content === "DATA:\n" + old.inputData && !!JSON.parse(kv.get(`brief/${dueId}`)).i18n.it);
r = await call(`/api/briefs/lang?id=${dueId}&lang=it`, "POST");
ok("POST /api/briefs/lang again: existing version returned, no model call", r.status === 200 && aiCalls.length === 1);
r = await call(`/api/briefs/lang?id=${dueId}&lang=de`, "POST");
ok("POST /api/briefs/lang: only Italian", r.status === 400);
r = await call("/api/briefs/item?id=../../etc");
ok("item id validated", r.status === 400);
r = await call("/api/briefs?period=daily", "GET", { ...env, BRIEFS: undefined });
ok("no archive storage → 503 N/A", r.status === 503 && r.j.error === "storage_not_configured");
r = await call("/api/briefs/write?period=daily&force=1", "POST", { ...env, AI: undefined });
ok("no model → 503 N/A, nothing written", r.status === 503 && r.j.error === "model_unavailable");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
