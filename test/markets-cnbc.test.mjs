// CNBC markets (futures, curves, implied open), Nasdaq (calendar actuals, screener, movers), ApeWisdom (Reddit) — 20 Oct 2026.
// Fixtures are test data only, in the shapes these services answered the Worker on 20 Oct 2026.
//   node test/markets-cnbc.test.mjs
import { app as worker } from "../src/worker.mjs";
import { FUTURES, CURVES, cnbcNum, cnbcTime, contractOf, parseCnbcQuote, parseCnbcBars, dailyCloses, referenceCloses, impliedOpen, inSession, isAllowed } from "../src/cnbc.mjs";
import { parseNqCalendar, parseNqScreener, parseNqMovers, nqText, nqNum, NQ_HEADERS } from "../src/nasdaq.mjs";
import { parseApe } from "../src/reddit.mjs";
import { PRESS, BRIEF_PRESS } from "../src/press.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

// ---------- CNBC parsing ----------
ok("45 futures in 9 groups; 12 curves; only listed symbols allowed", FUTURES.length === 45 && new Set(FUTURES.map((f) => f[2])).size === 9 && Object.keys(CURVES).length === 12 && isAllowed("@CL.12") && isAllowed("@GC.1") && isAllowed("EUR=") && isAllowed("JPY=") && !isAllowed("@CL.13") && !isAllowed("AAPL") && !isAllowed("XYZ="));
ok("numbers as CNBC writes them", cnbcNum("10,733.00") === 10733 && cnbcNum("-0.4738%") === -0.4738 && cnbcNum("+0.005") === 0.005 && cnbcNum("UNCH") === null && cnbcNum("") === null);
ok("time with offset; contract month from the name", cnbcTime("2026-10-20T11:43:24.000-0400") === Date.parse("2026-10-20T15:43:24Z") && contractOf("WTI Crude (Nov'26)") === "Nov 2026" && contractOf("Gold") === null);
const cl = parseCnbcQuote({ symbol: "@CL.1", code: 0, name: "WTI Crude (Nov'26)", last: "101.09", previous_day_closing: "103.66", change: "-2.57", change_pct: "-2.48%", open: "103.43", high: "110.48", low: "101.04", volume: "16,735", last_time: "2026-10-20T14:30:38.000-0400", exchange: "New York Mercantile Exchange", realTime: "false", curmktstatus: "REG_MKT" });
ok("a futures quote: last, previous, change, contract, venue, delayed flag", cl.last === 101.09 && cl.prev === 103.66 && cl.chg === -2.57 && cl.chgPct === -2.48 && cl.contract === "Nov 2026" && cl.volume === 16735 && cl.realTime === false && cl.venue === "New York Mercantile Exchange");
ok("not a quote: code ≠ 0, no time, or a yield (with %)", parseCnbcQuote({ symbol: "X", code: 1 }) === null && parseCnbcQuote({ symbol: "X", code: 0, last: "1.0" }) === null && parseCnbcQuote({ symbol: "X", code: 0, last: "4.0%", last_time: "2026-10-20T10:00:00.000-0400" }) === null);
ok("'UNCH' change is a zero change", parseCnbcQuote({ symbol: "X", code: 0, last: "5", change: "UNCH", change_pct: "UNCH", last_time: "2026-10-20T10:00:00.000-0400" }).chg === 0);
const bars = { barData: { priceBars: [{ close: "100", open: "99", high: "101", low: "98", tradeTime: "20261019000000", tradeTimeinMills: Date.parse("2026-10-19T04:00:00Z") }, { close: "", tradeTime: "20261020000000", tradeTimeinMills: Date.parse("2026-10-20T04:00:00Z") }, { close: "102", tradeTime: "20261016000000", tradeTimeinMills: Date.parse("2026-10-16T04:00:00Z") }] } };
ok("bars: epoch ms + OHLC, oldest first, empty closes dropped; daily closes by CNBC's date", parseCnbcBars(bars).length === 2 && parseCnbcBars(bars)[0][4] === 102 && dailyCloses(bars).map((x) => x[0]).join() === "2026-10-16,2026-10-19");
const rows = []; for (let t = Date.parse("2025-09-01"); t <= Date.parse("2026-10-20"); t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) rows.push([d.toISOString().slice(0, 10), 100 + rows.length]); }
const ref = referenceCloses(rows);
ok("reference closes: 1W / 1M / 3M / 1Y before the latest bar and the last close of the previous year", ref["1W"][0] === "2026-10-13" && ref["1M"][0] === "2026-09-18" && ref["1Y"][0] === "2025-10-20" && ref.YTD[0] === "2025-12-31", JSON.stringify(ref));
ok("cash session by exchange hours (no holidays)", inSession(Date.parse("2026-10-20T15:00:00Z"), "America/New_York", "09:30", "16:00") && !inSession(Date.parse("2026-10-20T20:52:00Z"), "America/New_York", "09:30", "16:00") && !inSession(Date.parse("2026-10-24T15:00:00Z"), "America/New_York", "09:30", "16:00") && inSession(Date.parse("2026-10-20T01:00:00Z"), "Asia/Tokyo", "09:00", "15:30"));
const cash = { last: 7712.57, time: Date.parse("2026-10-20T20:00:30Z") }, fut = { last: 7772.25 };
const fb = [[Date.parse("2026-10-20T19:50:00Z"), 7760], [Date.parse("2026-10-20T19:55:00Z"), 7765], [Date.parse("2026-10-20T20:00:00Z"), 7790]];
const im = impliedOpen(cash, fut, fb, Date.parse("2026-10-20T20:52:00Z"), ["America/New_York", "09:30", "16:00"]);
ok("implied open: the futures bar that ended by the cash print (15:55–16:00), its change applied to the print", im.cashOpen === false && im.futAtClose === 7765 && im.pct === Math.round((7772.25 / 7765 - 1) * 100000) / 1000 && im.level === Math.round(7712.57 * (7772.25 / 7765) * 100) / 100, JSON.stringify(im));
ok("implied open: nothing while the cash market is open; no bar → error, no number", impliedOpen(cash, fut, fb, Date.parse("2026-10-20T15:00:00Z"), ["America/New_York", "09:30", "16:00"]).cashOpen === true && impliedOpen(cash, fut, [], Date.parse("2026-10-20T20:52:00Z"), ["America/New_York", "09:30", "16:00"]).error === "no_bar_at_close");

// ---------- Nasdaq parsing ----------
ok("Nasdaq blanks are not values", nqText("&nbsp;") === null && nqText(" nbsp;") === null && nqText(" ") === null && nqNum("$170.21") === 170.21 && nqNum("-1.234%") === -1.234 && nqNum("1,234") === 1234);
const cal = parseNqCalendar({ data: { rows: [{ gmt: "12:30", country: "United States", eventName: "CPI (MoM)", actual: "0.4", consensus: "0.3", previous: "0.2" }, { gmt: "02:00", country: "Euro Zone", eventName: "ECB's Elderson Speaks", actual: "&nbsp;", consensus: " ", previous: " " }, { gmt: "", country: "", eventName: "" }] } }, "2026-10-15");
ok("calendar: GMT time on the date, actual / consensus / previous; empty rows dropped", cal.length === 2 && cal[0].at === "2026-10-15T12:30:00.000Z" && cal[0].actual === "0.4" && cal[1].actual === null);
const scr = parseNqScreener({ data: { rows: [{ symbol: "AAPL", name: "Apple Inc. Common Stock", lastsale: "$250.10", pctchange: "-1.2%", volume: "50000000", marketCap: "3800000000000.00", sector: "Technology", industry: "Computer Manufacturing", country: "United States", ipoyear: "1980" }, { symbol: "bad sym", name: "x" }] } });
ok("screener: compact rows, invalid symbols dropped", scr.length === 1 && scr[0][0] === "AAPL" && scr[0][2] === 250.1 && scr[0][3] === -1.2 && scr[0][5] === 3.8e12 && scr[0][6] === "Technology" && scr[0][9] === 1980);
const mv = parseNqMovers({ data: { STOCKS: { MostAdvanced: { dataAsOf: "Data as of Oct 20, 2026", table: { headers: { lastSalePrice: "Last", lastSaleChange: "Change", change: "% Change" }, rows: [{ symbol: "XYZ", name: "XYZ Corp", lastSalePrice: "$1.50", lastSaleChange: "+0.50", change: "+50%" }] } }, Empty: { table: { rows: [] } } } } });
ok("movers: each list with its own column titles; empty lists dropped", mv.length === 1 && mv[0].key === "MostAdvanced" && mv[0].rows[0].last === 1.5 && mv[0].cols.third === "% Change");
ok("Nasdaq requests look like a browser (the API refuses the Worker's own agent)", /Mozilla/.test(NQ_HEADERS["user-agent"]) && NQ_HEADERS.referer === "https://www.nasdaq.com/");

// ---------- ApeWisdom ----------
const ape = parseApe({ results: [{ rank: 1, ticker: "spcx", name: "SpaceX &amp; Co", mentions: 212, upvotes: 1497, rank_24h_ago: 10, mentions_24h_ago: 54 }, { rank: 2, ticker: "", mentions: 1 }] });
ok("Reddit mentions: ticker upper-case, entities decoded, rows without a ticker dropped", ape.length === 1 && ape[0].ticker === "SPCX" && ape[0].name === "SpaceX & Co" && ape[0].rank24h === 10);
ok("press: CNBC, The Economist, Il Sole 24 Ore for NEWS; the briefing keeps the original five", ["CNBC", "ECONOMIST", "SOLE"].every((k) => PRESS[k] && PRESS[k].feeds.length) && BRIEF_PRESS.join() === "FT,BLOOMBERG,WSJ,MARKETWATCH,CB");

// ---------- endpoints (mocked) ----------
let store = new Map(); const calls = [];
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const ctx = { waitUntil: () => {} };
const now = Date.parse("2026-10-20T20:52:00Z"), realNow = Date.now; Date.now = () => now;
globalThis.fetch = async (u, init = {}) => {
  u = String(u); calls.push({ u, ua: init.headers && init.headers["user-agent"] });
  if (u.startsWith("https://quote.cnbc.com/")) { const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split("|"); return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: syms.map((s) => s === "@OJ.1" ? { symbol: s, code: 1 } : { symbol: s, code: 0, name: s.startsWith("@") ? `${s} (Dec'26)` : s, last: s === ".SPX" ? "7,712.57" : s.startsWith("@SP") ? "7,772.25" : "100.00", previous_day_closing: "99.00", change: "+1.00", change_pct: "+1.01%", last_time: s.startsWith(".") ? "2026-10-20T16:00:30.000-0400" : "2026-10-20T16:50:00.000-0400", exchange: "CME", realTime: "false", curmktstatus: "POST_MKT" }) } })); }
  if (u.startsWith("https://ts-api.cnbc.com/")) {
    if (/\/5M\//.test(u)) return new Response(JSON.stringify({ barData: { priceBars: [["19:50", "7760"], ["19:55", "7765"], ["20:00", "7790"]].map(([t, c]) => ({ close: c, tradeTime: "x", tradeTimeinMills: Date.parse(`2026-10-20T${t}:00Z`) })) } }));
    return new Response(JSON.stringify({ barData: { priceBars: rows.map(([d, v]) => ({ close: String(v), tradeTime: d.replace(/-/g, "") + "000000", tradeTimeinMills: Date.parse(d) })) } }));
  }
  if (u.startsWith("https://api.nasdaq.com/api/calendar/")) return new Response(JSON.stringify({ data: { rows: [{ gmt: "12:30", country: "United States", eventName: "CPI (MoM)", actual: "0.4", consensus: "0.3", previous: "0.2" }] } }));
  if (u.startsWith("https://api.nasdaq.com/api/screener/")) return new Response(JSON.stringify({ data: { rows: [{ symbol: "AAPL", name: "Apple", lastsale: "$250", pctchange: "1%", volume: "1", marketCap: "1", sector: "Technology" }] } }));
  if (u.startsWith("https://api.nasdaq.com/api/marketmovers")) return new Response(JSON.stringify({ data: { STOCKS: { MostDeclined: { table: { rows: [{ symbol: "ABC", lastSalePrice: "$2", lastSaleChange: "-1", change: "-33%" }] } } } } }));
  if (u.startsWith("https://apewisdom.io/")) return new Response(JSON.stringify({ results: [{ rank: 1, ticker: "NVDA", name: "NVIDIA", mentions: 100, upvotes: 50, rank_24h_ago: 2, mentions_24h_ago: 80 }] }));
  return new Response("", { status: 404 });
};
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com" };
const call = async (path) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j }; };

let r = await call("/api/cnbc/futures");
const byS = Object.fromEntries((r.j.rows || []).map((x) => [x.sym, x]));
ok("/api/cnbc/futures: every contract in two requests (≤ 40 symbols each), with label, group, unit, contract month; a symbol CNBC does not answer → N/A", r.status === 200 && r.j.rows.length === 45 && calls.filter((c) => c.u.startsWith("https://quote.cnbc.com/")).length === 2 && byS["@CL.1"].group === "Energy" && byS["@CL.1"].contract === "Dec 2026" && byS["@CL.1"].status === "LIVE" && byS["@OJ.1"].status === "N/A", JSON.stringify(byS["@CL.1"]));
r = await call("/api/cnbc/returns?syms=@CL.1,@GC.1,AAPL");
ok("/api/cnbc/returns: reference closes for known symbols only; 3-month line", r.status === 200 && Object.keys(r.j.returns).sort().join() === "@CL.1,@GC.1" && r.j.returns["@CL.1"].ref["1M"][0] === "2026-09-18" && r.j.returns["@CL.1"].line.length === 63);
r = await call("/api/cnbc/curve?root=CL");
ok("/api/cnbc/curve: 12 positions with contract month and their past closes", r.status === 200 && r.j.points.length === 12 && r.j.points[0].contract === "Dec 2026" && r.j.points[11].ref["1W"]);
r = await call("/api/cnbc/curve?root=XX");
ok("/api/cnbc/curve: unknown root → 400", r.status === 400);
r = await call("/api/cnbc/implied");
const sp = r.j.rows.find((x) => x.label === "S&P 500");
ok("/api/cnbc/implied: after the U.S. close, the futures' move since the bar ending at the cash print, applied to it", r.status === 200 && sp.cashOpen === false && sp.futAtClose === 7765 && sp.level === Math.round(7712.57 * (7772.25 / 7765) * 100) / 100, JSON.stringify(sp));
r = await call("/api/cnbc/history?sym=AAPL");
ok("/api/cnbc/history: only listed symbols (no open proxy)", r.status === 400);
r = await call("/api/nasdaq/calendar?from=2026-10-19&to=2026-10-30");
ok("/api/nasdaq/calendar: one request per day, at most 8 days, sent with a browser agent", r.status === 200 && calls.filter((c) => c.u.includes("economicevents")).length === 8 && r.j.rows.length === 8 && calls.filter((c) => c.u.includes("api.nasdaq.com")).every((c) => /Mozilla/.test(c.ua)));
r = await call("/api/nasdaq/calendar?from=bad");
ok("/api/nasdaq/calendar: bad dates → 400", r.status === 400);
r = await call("/api/nasdaq/screener?ex=nyse");
ok("/api/nasdaq/screener: compact rows with their column names", r.status === 200 && r.j.rows[0][0] === "AAPL" && r.j.cols[5] === "marketCap");
r = await call("/api/nasdaq/screener?ex=otc");
ok("/api/nasdaq/screener: only Nasdaq, NYSE, NYSE American", r.status === 400);
r = await call("/api/nasdaq/movers");
ok("/api/nasdaq/movers: the lists Nasdaq publishes", r.status === 200 && r.j.lists[0].key === "MostDeclined");
r = await call("/api/reddit?filter=wallstreetbets");
ok("/api/reddit: mentions with the 24-hour comparison; unknown filter → 400", r.status === 200 && r.j.rows[0].ticker === "NVDA" && r.j.rows[0].mentions24h === 80 && (await call("/api/reddit?filter=x")).status === 400);
Date.now = realNow;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
