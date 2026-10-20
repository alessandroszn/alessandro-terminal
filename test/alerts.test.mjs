// Alerts engine (src/alerts.mjs): symbols mapped to CNBC, the four kinds evaluated on real-format data, the 5-minute check
// (KV writes only when something fires, plus an hourly heartbeat), Telegram delivery, and the bot token never leaving the
// server. Provider answers below are fixtures in CNBC / Nasdaq / Telegram formats; nothing here is shown in the terminal.
//   node test/alerts.test.mjs
import * as A from "../src/alerts.mjs";
import worker, { app } from "../src/worker.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

// ---------- symbols ----------
const MAP = [["EUR/USD", "EUR="], ["GBP/USD", "GBP="], ["USD/JPY", "JPY="], ["USD/CHF", "CHF="], ["USD/EUR", null], ["JPY/USD", null], ["EUR/JPY", "EURJPY="], ["BTC/USD", "BTC.CM="], ["DOGE/USD", "DOGE.CM="],
  ["XAU/USD", "XAU="], ["AAPL", "AAPL"], ["BRK.B", "BRK.B"], ["IDX:SPX", ".SPX"], ["IDX:FTSEMIB", ".FTMIB"], ["IDX:DAX", ".GDAXI"], ["IDX:NOPE", null], ["FUT:CL", "@CL.1"], ["FUT:ZZ", null], ["ISP:XMIL", "ISP-IT"], ["C:700-HK", "700-HK"], ["005930:XXXX", null]];
const bad = MAP.filter(([s, e]) => A.alertCnbcSym(s) !== e);
ok("symbols → CNBC: FX by the dollar convention (EUR= is EUR/USD, JPY= is USD/JPY), crosses, crypto, metals, U.S. stocks, IDX:, FUT:, listings elsewhere (ISP:XMIL, C:700-HK)", bad.length === 0, JSON.stringify(bad));
ok("every market of open / close alerts has an index, a time zone and hours", Object.values(A.SESSIONS).every((m) => m.sym.startsWith(".") && m.tz.includes("/") && /^\d\d:\d\d$/.test(m.open) && m.close > m.open && m.nameIt));

// ---------- kinds ----------
const now = Date.parse("2026-10-20T13:40:00Z"); // Tuesday, 09:40 New York
const spx = { last: 6700, prev: 6650, chgPct: 0.75, time: Date.parse("2026-10-20T13:36:00Z"), realTime: false };
const ses = { id: "s1", kind: "session", market: "US", event: "both", created: "2026-10-19T00:00:00Z" };
let ev = A.evalSession(ses, spx, now);
ok("market open: the index printed today after the open, within the first hour → fires once", ev && ev.event === "open" && ev.key === "open:2026-10-20" && !A.evalSession({ ...ses, fired: { keys: [ev.key] } }, spx, now));
ok("market open: yesterday's print (holiday, or not opened yet) → nothing", !A.evalSession(ses, { ...spx, time: Date.parse("2026-10-19T20:00:00Z") }, now));
ok("market open: after the first hour → nothing (an alert added mid-session does not claim the open)", !A.evalSession(ses, spx, Date.parse("2026-10-20T14:31:00Z")));
const spxC = { ...spx, time: Date.parse("2026-10-20T20:00:00Z") };
ok("market close: from 30 minutes after the close, once", A.evalSession({ ...ses, event: "close" }, spxC, Date.parse("2026-10-20T20:31:00Z")).event === "close" && !A.evalSession({ ...ses, event: "close" }, spxC, Date.parse("2026-10-20T20:20:00Z")));
ok("weekend → nothing", !A.evalSession(ses, { ...spx, time: Date.parse("2026-10-24T13:36:00Z") }, Date.parse("2026-10-24T13:40:00Z")));
const tok = { ...ses, market: "JP", event: "open" }, nk = { last: 49000, prev: 48800, chgPct: 0.41, time: Date.parse("2026-10-21T00:20:00Z") };
ok("Tokyo open is judged in Tokyo time (09:20 JST = 00:20 UTC)", A.evalSession(tok, nk, Date.parse("2026-10-21T00:25:00Z")).key === "open:2026-10-21");

const mv = { id: "m1", kind: "move", sym: "NVDA", dir: "down", pct: 3 };
const nv = { last: 180, prev: 190, chgPct: -5.26, time: now - 60_000, realTime: true };
ok("daily move: −5.26% reaches −3% → fires; once a session (same previous close)", A.evalMove(mv, nv, now).key === "prev:190" && !A.evalMove({ ...mv, fired: { last: { key: "prev:190", at: new Date(now - 3600e3).toISOString() } } }, nv, now));
ok("daily move: direction respected (an up alert ignores a fall)", !A.evalMove({ ...mv, dir: "up" }, nv, now) && A.evalMove({ ...mv, dir: "any" }, nv, now));
ok("a quote older than 30 minutes (market not trading) never fires", !A.evalMove(mv, { ...nv, time: now - 31 * 60_000 }, now) && !A.evalPrice({ op: "<=", price: 185 }, { ...nv, time: now - 31 * 60_000 }, now));
ok("price: ≤ 185 with last 180 → fires; ≥ 185 → nothing", A.evalPrice({ op: "<=", price: 185 }, nv, now).value === 180 && !A.evalPrice({ op: ">=", price: 185 }, nv, now));

const rows = [
  { date: "2026-10-20", time: "12:30", at: "2026-10-20T12:30:00.000Z", country: "United States", event: "Nonfarm Payrolls", actual: "150K", consensus: "120K", previous: "100K" },
  { date: "2026-10-20", time: "12:30", at: "2026-10-20T12:30:00.000Z", country: "United States", event: "Private Nonfarm Payrolls", actual: "140K", consensus: null, previous: "90K" },
  { date: "2026-10-20", time: "14:00", at: "2026-10-20T14:00:00.000Z", country: "United States", event: "Nonfarm Payrolls Revision", actual: null, consensus: null, previous: null },
  { date: "2026-10-20", time: "09:00", at: "2026-10-20T09:00:00.000Z", country: "Germany", event: "Nonfarm Payrolls", actual: "1", consensus: null, previous: null }];
const rel = { id: "r1", kind: "release", country: "United States", match: "nonfarm payrolls", created: "2026-10-20T08:00:00Z" };
ev = A.evalRelease(rel, rows, now);
ok("release: every word matched, that country only, with the actual published; rows of the same time together", ev && ev.key === "2026-10-20 12:30" && ev.rows.length === 2);
ok("release: once per release; not for releases before the alert existed", !A.evalRelease({ ...rel, fired: { keys: [ev.key] } }, rows, now) && !A.evalRelease({ ...rel, created: "2026-10-20T13:00:00Z" }, rows, now));
const msg = A.describe(rel, ev, now);
ok("message: actual / consensus / previous as Nasdaq publishes them (— when missing), in English and Italian", /Nonfarm Payrolls: actual 150K · consensus 120K · previous 100K/.test(msg.en.text) && /consenso —/.test(msg.it.text) && /14:30 ora di Roma · Nasdaq/.test(msg.it.text));
ok("Telegram text is HTML-escaped", /&lt;b&gt;/.test(A.telegramText([{ msg, note: "<b>" }], "en")) && /^🔔 <b>United States: Nonfarm Payrolls \(\+1\)<\/b>/.test(A.telegramText([{ msg }], "en")));

// ---------- the 5-minute check ----------
const TOKEN = "123456789:AAH" + "s".repeat(32);
const mkEnv = () => { const kv = new Map(), writes = []; return { kv, writes, env: { BRIEFS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { writes.push(k); kv.set(k, v); }, delete: async (k) => kv.delete(k) }, TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_ORIGIN: "https://alessandrozanichelli.com" } }; };
let E = mkEnv();
E.kv.set("ud/alerts", JSON.stringify([{ id: "p1", kind: "price", sym: "NVDA", op: "<=", price: 185, note: "add", created: "2026-10-19T00:00:00Z", hit: null }, { ...mv, created: "2026-10-19T00:00:00Z" }, ses, rel]));
E.kv.set("ud/telegram", JSON.stringify({ id: "42", name: "Ale", lang: "it" }));
const sent = [], deps = { fetchQuotes: async (syms) => ({ data: Object.fromEntries(syms.map((s) => [s, s === "NVDA" ? nv : spx])) }), fetchReleases: async () => ({ data: rows }), tgCall: async (m, p) => { sent.push([m, p]); return { data: {} }; } };
let run = await A.runAlerts(now + 60_000, E.env, deps);
const after = JSON.parse(E.kv.get("ud/alerts")), log = JSON.parse(E.kv.get("ud/alertlog"));
ok("check: all four fire; one Telegram message to the linked chat, in its language", run.fired === 4 && sent.length === 1 && sent[0][1].chat_id === "42" && /mercato aperto/.test(sent[0][1].text) && sent[0][1].parse_mode === "HTML");
ok("check: the price alert records the CNBC price and time; the others count and keep their keys", after[0].hit.price === 180 && after[0].hit.source === "CNBC" && after[1].fired.count === 1 && after[2].fired.keys[0] === "open:2026-10-20" && after[3].fired.keys[0] === "2026-10-20 12:30");
ok("check: the firings are logged with the delivery result", log.log.length === 4 && log.log.every((e) => e.telegram === "sent") && log.run.fired === 4);
E.writes.length = 0;
run = await A.runAlerts(now + 6 * 60_000, E.env, deps);
ok("next check: nothing fires twice, nothing sent, no KV write (not the top of the hour)", run.fired === 0 && sent.length === 1 && E.writes.length === 0);
run = await A.runAlerts(Date.parse("2026-10-20T15:00:30Z"), E.env, deps);
ok("first check of the hour writes the heartbeat only", E.writes.length === 1 && E.writes[0] === "ud/alertlog" && JSON.parse(E.kv.get("ud/alertlog")).log.length === 4);
E = mkEnv(); E.kv.set("ud/alerts", JSON.stringify([{ id: "p1", kind: "price", sym: "NVDA", op: "<=", price: 185, created: "x", hit: null }]));
const quoteAsk = [];
run = await A.runAlerts(now, { ...E.env, TELEGRAM_BOT_TOKEN: undefined }, { ...deps, fetchQuotes: async (s) => { quoteAsk.push(s); return { data: { NVDA: nv } }; }, tgCall: undefined });
ok("without Telegram the alert still fires and is logged as page-only; one quote request for all symbols", run.fired === 1 && JSON.parse(E.kv.get("ud/alertlog")).log[0].telegram === "not_configured" && quoteAsk.length === 1);
E = mkEnv();
run = await A.runAlerts(now + 60_000, E.env, { ...deps, fetchQuotes: async () => { throw new Error("must not be called"); } });
ok("no alerts → no request, no write (outside the top of the hour)", run.active === 0 && E.writes.length === 0);
E = mkEnv(); E.kv.set("ud/alerts", JSON.stringify([{ id: "p1", kind: "price", sym: "NVDA", op: "<=", price: 185, created: "x", hit: null }]));
run = await A.runAlerts(now, E.env, { ...deps, fetchQuotes: async () => ({ err: "provider_timeout" }) });
ok("quotes unavailable → nothing fires (no substitute price), the error is recorded", run.fired === 0 && /provider_timeout/.test(run.err));

// ---------- HTTP and Telegram (through the Worker) ----------
E = mkEnv();
E.kv.set("ud/alerts", JSON.stringify([{ id: "p1", kind: "price", sym: "EUR/USD", op: ">=", price: 1.2, created: "2026-10-19T00:00:00Z", hit: null }]));
const tgSeen = [];
const CNBC_Q = (sym, last) => ({ code: 0, symbol: sym, name: "EUR/USD", last, last_time: new Date(Date.now() - 60_000).toISOString().replace("Z", "+0000"), previous_day_closing: "1.1200", change: "+0.0035", change_pct: "+0.31%", realTime: "true" });
globalThis.fetch = async (u, o = {}) => {
  const s = String(u);
  if (s.startsWith("https://quote.cnbc.com/")) return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: [CNBC_Q("EUR=", "1.1235")] } }));
  if (s.startsWith("https://api.telegram.org/")) {
    const method = s.split("/").pop(), body = JSON.parse(o.body || "{}"); tgSeen.push({ method, body, tokenInUrl: s.includes(TOKEN) });
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Ale alerts", username: "ale_alerts_bot" } }));
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: { id: 4242, type: "private", first_name: "Alessandro", username: "ale" }, text: "/start" } }] }));
    if (method === "sendMessage") return body.chat_id === "999" ? new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), { status: 400 }) : new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
  }
  return new Response("", { status: 404 });
};
const ctx = { waitUntil: () => {} };
const J = (method, b) => ({ method, headers: { "content-type": "application/json", origin: "https://alessandrozanichelli.com" }, body: b === undefined ? undefined : JSON.stringify(b) });
const call = async (path, init, env = E.env) => { const r = await app.fetch(new Request("https://alessandrozanichelli.com" + path, init), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };
const texts = [];
let r = await call("/api/alerts?quotes=1"); texts.push(r.text);
ok("GET /api/alerts: alerts, engine, Telegram status (configured, no chat), catalog; quotes by alert id from CNBC", r.status === 200 && r.j.telegram.configured === true && r.j.telegram.chat === null && r.j.quotes.p1.sym === "EUR=" && r.j.quotes.p1.last === 1.1235 && r.j.quotes.p1.fresh === true && r.j.catalog.sessions.length === Object.keys(A.SESSIONS).length);
r = await call("/api/alerts/telegram/chats"); texts.push(r.text);
ok("FIND MY CHAT: the bot's username and the chats that wrote to it", r.status === 200 && r.j.bot.username === "ale_alerts_bot" && r.j.chats[0].id === "4242" && r.j.chats[0].name === "Alessandro");
r = await call("/api/alerts/telegram/link", J("POST", { chatId: "777", lang: "it" })); texts.push(r.text);
ok("LINK: a chat that never wrote to the bot is refused", r.status === 400);
r = await call("/api/alerts/telegram/link", J("POST", { chatId: "4242", lang: "it" })); texts.push(r.text);
ok("LINK: the chat is saved (KV ud/telegram) after a confirmation message reaches it", r.status === 200 && r.j.telegram.chat.name === "Alessandro" && JSON.parse(E.kv.get("ud/telegram")).id === "4242" && tgSeen.at(-1).method === "sendMessage" && /questa chat/.test(tgSeen.at(-1).body.text));
r = await call("/api/alerts/telegram/test", J("POST")); texts.push(r.text);
ok("SEND TEST: a message to the linked chat", r.status === 200 && r.j.sent === true && tgSeen.at(-1).body.chat_id === "4242" && /prova/.test(tgSeen.at(-1).body.text));
r = await call("/api/alerts/telegram/lang", J("POST", { lang: "en" })); texts.push(r.text);
ok("language of the messages", r.j.telegram.lang === "en" && JSON.parse(E.kv.get("ud/telegram")).id === "4242");
E.kv.set("ud/telegram", JSON.stringify({ id: "999", name: "gone", lang: "en" }));
r = await call("/api/alerts/telegram/test", J("POST")); texts.push(r.text);
ok("Telegram refusing a message → the error code and Telegram's description, no token", r.status === 502 && r.j.error === "telegram_bad_request" && /chat not found/.test(r.j.description));
E.kv.set("ud/telegram", JSON.stringify({ id: "4242", name: "Alessandro", lang: "en" }));
r = await call("/api/alerts/run", J("POST")); texts.push(r.text);
ok("CHECK NOW: runs the check (EUR/USD 1.1235 < 1.2: nothing fires) and records it", r.status === 200 && r.j.active === 1 && r.j.fired === 0 && r.j.quotes === 1 && JSON.parse(E.kv.get("ud/alertlog")).run.active === 1);
r = await call("/api/alerts/telegram/link", { method: "DELETE", headers: { origin: "https://alessandrozanichelli.com" } }); texts.push(r.text);
ok("UNLINK keeps only the language", r.status === 200 && r.j.telegram.chat === null && !JSON.parse(E.kv.get("ud/telegram")).id);
r = await call("/api/alerts/telegram/test", { method: "POST", headers: { origin: "https://evil.example" } });
ok("writes from another site → 403", r.status === 403);
r = await call("/api/alerts/telegram/chats", undefined, { ...E.env, TELEGRAM_BOT_TOKEN: "not-a-token" }); texts.push(r.text);
ok("a malformed token is reported as such (and never echoed)", r.status === 400 && r.j.error === "bad_token_format" && !r.text.includes("not-a-token"));
ok("the bot token appears only in the request URL to api.telegram.org — never in any response", tgSeen.length > 0 && tgSeen.every((x) => x.tokenInUrl) && texts.every((t) => !t.includes(TOKEN) && !t.includes(TOKEN.split(":")[1])));
const st = await call("/api/status", undefined, E.env);
ok("SYS: Telegram configured yes/no, the alert check's last record", st.j.sources.find((x) => x.id === "telegram").configured === true && st.j.alerts.lastRecorded && !st.text.includes(TOKEN));

// ---------- the Cron Trigger dispatch ----------
const waits = []; E.kv.set("ud/alerts", JSON.stringify([{ id: "p2", kind: "price", sym: "EUR/USD", op: ">=", price: 1.1, created: "2026-10-19T00:00:00Z", hit: null }])); E.kv.set("ud/telegram", JSON.stringify({ id: "4242", lang: "en" }));
tgSeen.length = 0;
await worker.scheduled({ cron: A.ALERT_CRON, scheduledTime: Date.now() }, E.env, { waitUntil: (p) => waits.push(p) });
await Promise.all(waits);
ok("Cron \"*/5 * * * *\" runs the alert check (and not the briefing scheduler): EUR/USD ≥ 1.1 fires and is sent", JSON.parse(E.kv.get("ud/alerts"))[0].hit.price === 1.1235 && tgSeen.length === 1 && /EUR\/USD ≥ 1\.1/.test(tgSeen[0].body.text) && !E.kv.has("cron/last"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
