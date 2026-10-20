// ALERTS ENGINE — the owner's alerts, checked on the server every 5 minutes (Cron Trigger "*/5 * * * *"), whether or not
// the terminal is open, with optional delivery to a Telegram chat. Four kinds (stored in KV ud/alerts by userdata.mjs):
//   price    {sym, op ">="|"<=", price}             fires once when a fresh quote reaches the level (it can then be re-armed)
//   move     {sym, dir "up"|"down"|"any", pct}      the day's change vs the previous close reaches ±pct — at most once a session
//   session  {market, event "open"|"close"|"both"}  the market's main index printed after today's open / has closed — once a day
//   release  {country, match}                       an economic release whose name contains the words is published with its
//                                                   actual figure (Nasdaq economic calendar)
// Market data: CNBC quote service (one request for every symbol), the feed of FUT / IDX. Only a FRESH quote can fire an
// alert — CNBC's own time of the last trade within the last 30 minutes, i.e. the market is trading — never a stale one.
// Market open / close use the main index: holidays need no calendar, because on a holiday the index does not print.
//   GET    /api/alerts[?quotes=1]        alerts, recent firings, the engine's last recorded check, Telegram status, catalog
//   POST   /api/alerts/run               check now (as the cron does)
//   GET    /api/alerts/telegram/chats    the bot's name and the chats that wrote to it (to link yours)
//   POST   /api/alerts/telegram/link     {chatId, lang} link a chat that wrote to the bot · DELETE unlinks
//   POST   /api/alerts/telegram/test     send a test message
//   POST   /api/alerts/telegram/lang     {lang} language of the messages (en | it)
// The bot token is a Worker secret (TELEGRAM_BOT_TOKEN): it is only ever placed in the request URL to api.telegram.org —
// never returned, logged or stored. KV writes are limited (free plan, 1,000 a day): a check writes only when an alert fires,
// plus one heartbeat an hour.
import { iso, fetchText } from "./lib.mjs";
import { loadCnbcQuotes, FUTURES } from "./cnbc.mjs";
import { INDICES } from "./indices.mjs";
import { NQ_CAL, NQ_HEADERS, parseNqCalendar } from "./nasdaq.mjs";
import { cnbcCodeFor } from "./intl.mjs";

export const ALERT_CRON = "*/5 * * * *";
export const ALERTS_KEY = "ud/alerts", LOG_KEY = "ud/alertlog", TG_KEY = "ud/telegram";
export const FRESH_MS = 30 * 60_000;
export const SYM_RE = /^[A-Z0-9][A-Z0-9.\-:/]{0,19}$/;
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

// ---------- symbols: the terminal's names → CNBC symbols (checked against CNBC on 20 Oct 2026) ----------
// FX as Reuters-style codes: "EUR=" is EUR/USD (EUR, GBP, AUD, NZD are quoted in dollars), "JPY=" is USD/JPY (the others);
// crosses "EURJPY=" (CNBC names them "Euro/Japanese Yen"). Crypto from Coin Metrics ("BTC.CM="), metals spot ("XAU=").
const FX_USD_QUOTE = new Set(["EUR", "GBP", "AUD", "NZD"]);
const FX_USD_BASE = new Set(["JPY", "CHF", "CAD", "CNY", "CNH", "MXN", "INR", "TRY", "BRL", "ZAR", "SEK", "NOK", "DKK", "PLN", "HKD", "SGD", "KRW"]);
const FX_CCY = new Set([...FX_USD_QUOTE, ...FX_USD_BASE]);
const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "LTC", "DOGE", "ADA", "BCH"]);
const METALS = new Set(["XAU", "XAG", "XPT", "XPD"]);
// indices: the IDX catalog's CNBC rows, and the others CNBC also quotes
export const IDX_CNBC = { SPX: ".SPX", NDX: ".NDX", DJI: ".DJI", RUT: ".RUT", VIX: ".VIX", VXN: ".VXN", OVX: ".OVX", GVZ: ".GVZ", SX5E: ".STOXX50E", SXXP: ".STOXX",
  DAX: ".GDAXI", TDXP: ".TECDAX", SMI: ".SSMI", IBEX: ".IBEX", N225: ".N225", XJO: ".AXJO", SHCOMP: ".SSEC", IBOV: ".BVSP",
  ...Object.fromEntries(INDICES.filter((i) => i.src === "cnbc").map((i) => [i.id, i.sym])) };
export const FUT_ROOTS = new Set(FUTURES.map((f) => /^@([A-Z]+)\.1$/.exec(f[0])[1]));
export function alertCnbcSym(sym) {
  const s = String(sym || "").trim().toUpperCase(); let m;
  if ((m = /^IDX:([A-Z0-9]{1,12})$/.exec(s))) return IDX_CNBC[m[1]] || null;
  if ((m = /^FUT:([A-Z]{1,4})$/.exec(s))) return FUT_ROOTS.has(m[1]) ? `@${m[1]}.1` : null;
  if ((m = /^([A-Z]{3,4})\/([A-Z]{3})$/.exec(s))) {
    const [, b, q] = m;
    if (q === "USD" && CRYPTO.has(b)) return `${b}.CM=`;
    if (q === "USD" && METALS.has(b)) return `${b}=`;
    if (b.length !== 3 || b === q) return null;
    if (q === "USD") return FX_USD_QUOTE.has(b) ? `${b}=` : null;
    if (b === "USD") return FX_USD_BASE.has(q) ? `${q}=` : null;
    return FX_CCY.has(b) && FX_CCY.has(q) ? `${b}${q}=` : null;
  }
  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(s)) return s; // U.S. stocks and ETFs (BRK.B)
  return cnbcCodeFor(s); // listings outside the U.S.: ISP:XMIL → ISP-IT, C:700-HK → 700-HK
}
export const SYM_HELP = "a U.S. stock or ETF (AAPL), a listing elsewhere (ISP:XMIL, C:700-HK), an FX pair (EUR/USD), crypto (BTC/USD), a metal (XAU/USD), an index (IDX:SPX) or a future (FUT:CL)";

// ---------- markets for open / close alerts: the main index, the exchange's time zone and regular hours ----------
export const SESSIONS = {
  US: { name: "United States", nameIt: "Stati Uniti", index: "S&P 500", sym: ".SPX", tz: "America/New_York", open: "09:30", close: "16:00" },
  CA: { name: "Canada", nameIt: "Canada", index: "S&P/TSX Composite", sym: ".GSPTSE", tz: "America/Toronto", open: "09:30", close: "16:00" },
  UK: { name: "United Kingdom", nameIt: "Regno Unito", index: "FTSE 100", sym: ".FTSE", tz: "Europe/London", open: "08:00", close: "16:30" },
  DE: { name: "Germany", nameIt: "Germania", index: "DAX", sym: ".GDAXI", tz: "Europe/Berlin", open: "09:00", close: "17:30" },
  FR: { name: "France", nameIt: "Francia", index: "CAC 40", sym: ".FCHI", tz: "Europe/Paris", open: "09:00", close: "17:30" },
  IT: { name: "Italy", nameIt: "Italia", index: "FTSE MIB", sym: ".FTMIB", tz: "Europe/Rome", open: "09:00", close: "17:30" },
  ES: { name: "Spain", nameIt: "Spagna", index: "IBEX 35", sym: ".IBEX", tz: "Europe/Madrid", open: "09:00", close: "17:30" },
  CH: { name: "Switzerland", nameIt: "Svizzera", index: "SMI", sym: ".SSMI", tz: "Europe/Zurich", open: "09:00", close: "17:30" },
  EZ: { name: "Euro area", nameIt: "Area euro", index: "EURO STOXX 50", sym: ".STOXX50E", tz: "Europe/Berlin", open: "09:00", close: "17:30" },
  JP: { name: "Japan", nameIt: "Giappone", index: "Nikkei 225", sym: ".N225", tz: "Asia/Tokyo", open: "09:00", close: "15:30" },
  HK: { name: "Hong Kong", nameIt: "Hong Kong", index: "Hang Seng", sym: ".HSI", tz: "Asia/Hong_Kong", open: "09:30", close: "16:00" },
  CN: { name: "China", nameIt: "Cina", index: "SSE Composite", sym: ".SSEC", tz: "Asia/Shanghai", open: "09:30", close: "15:00" },
  IN: { name: "India", nameIt: "India", index: "Nifty 50", sym: ".NSEI", tz: "Asia/Kolkata", open: "09:15", close: "15:30" },
  KR: { name: "South Korea", nameIt: "Corea del Sud", index: "KOSPI", sym: ".KS11", tz: "Asia/Seoul", open: "09:00", close: "15:30" },
  AU: { name: "Australia", nameIt: "Australia", index: "S&P/ASX 200", sym: ".AXJO", tz: "Australia/Sydney", open: "10:00", close: "16:00" },
};
// an open alert fires in the first hour of the session; a close alert from 30 minutes after the close (delayed feeds then
// hold the final print) until 4 hours after
export const OPEN_WINDOW_MIN = 60, CLOSE_AFTER_MIN = 30, CLOSE_UNTIL_MIN = 240;
// economic releases: the countries as the Nasdaq calendar names them
export const RELEASE_COUNTRIES = ["United States", "Euro Zone", "Germany", "France", "Italy", "Spain", "United Kingdom", "Japan", "China", "Canada", "Australia", "New Zealand", "Switzerland"];

export const LIMITS_A = { alerts: 100, alertSyms: 25, log: 60 };

export function validateAlert(b) {
  if (!b || typeof b !== "object") return "body required";
  const kind = b.kind == null || b.kind === "" ? "price" : String(b.kind), note = clean(b.note, 200);
  if (kind === "price" || kind === "move") {
    const sym = clean(b.sym, 20).toUpperCase();
    if (!sym) return "symbol required";
    if (!SYM_RE.test(sym) || !alertCnbcSym(sym)) return `symbol not supported: use ${SYM_HELP}`;
    if (kind === "price") {
      if (b.op !== ">=" && b.op !== "<=") return "op must be >= or <=";
      const price = Number(b.price);
      if (!Number.isFinite(price) || price <= 0) return "price must be a positive number";
      return { kind, sym, op: b.op, price, note };
    }
    if (!["up", "down", "any"].includes(b.dir)) return "dir must be up, down or any";
    const pct = Number(b.pct);
    if (!Number.isFinite(pct) || pct < 0.1 || pct > 50) return "pct must be between 0.1 and 50";
    return { kind, sym, dir: b.dir, pct: Math.round(pct * 100) / 100, note };
  }
  if (kind === "session") {
    if (!SESSIONS[b.market]) return "market: " + Object.keys(SESSIONS).join(", ");
    if (!["open", "close", "both"].includes(b.event)) return "event must be open, close or both";
    return { kind, market: b.market, event: b.event, note };
  }
  if (kind === "release") {
    if (!RELEASE_COUNTRIES.includes(b.country)) return "country: " + RELEASE_COUNTRIES.join(", ");
    const match = clean(b.match, 60).replace(/\s+/g, " ");
    if (match.length < 2) return "words to match required (e.g. nonfarm payrolls)";
    return { kind, country: b.country, match, note };
  }
  return "kind must be price, move, session or release";
}
// the CNBC symbol an alert needs a quote of (null: none)
export function quoteSymOf(a) {
  if (a.kind === "session") return SESSIONS[a.market] ? SESSIONS[a.market].sym : null;
  if (a.kind === "release") return null;
  return alertCnbcSym(a.sym);
}
export const kindOf = (a) => a.kind || "price";
export const isActive = (a) => !(kindOf(a) === "price" && a.hit);

// ---------- time ----------
const FMT = new Map();
export function localParts(t, tz) {
  let f = FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit" }); FMT.set(tz, f); }
  const p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}`, wd: p.weekday };
}
export const addMin = (hm, m) => { const t = +hm.slice(0, 2) * 60 + +hm.slice(3, 5) + m; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
export const fresh = (q, now) => !!q && Number.isFinite(q.last) && Number.isFinite(q.time) && now - q.time <= FRESH_MS && q.time <= now + 5 * 60_000;
const seen = (a, key) => !!(a.fired && Array.isArray(a.fired.keys) && a.fired.keys.includes(key));

// ---------- evaluation (pure: alert + data + time → a firing or null) ----------
export function evalPrice(a, q, now) {
  if (!fresh(q, now)) return null;
  const hit = a.op === ">=" ? q.last >= a.price : q.last <= a.price;
  return hit ? { key: "hit", value: q.last, q } : null;
}
// once a session: the previous close identifies the session; the same previous close within 20 hours is the same session
export function evalMove(a, q, now) {
  if (!fresh(q, now) || !Number.isFinite(q.chgPct)) return null;
  const c = q.chgPct, hit = a.dir === "up" ? c >= a.pct : a.dir === "down" ? c <= -a.pct : Math.abs(c) >= a.pct;
  if (!hit) return null;
  const key = `prev:${q.prev}`, last = a.fired && a.fired.last;
  if (last && last.key === key && now - Date.parse(last.at) < 20 * 3600_000) return null;
  return { key, value: c, q };
}
export function evalSession(a, q, now) {
  const m = SESSIONS[a.market]; if (!m || !q || !Number.isFinite(q.time) || !Number.isFinite(q.last)) return null;
  const n = localParts(now, m.tz); if (n.wd === "Sat" || n.wd === "Sun") return null;
  const t = localParts(q.time, m.tz); if (t.date !== n.date || t.hm < m.open) return null; // the index printed today, after the open
  for (const ev of a.event === "both" ? ["open", "close"] : [a.event]) {
    const key = `${ev}:${n.date}`; if (seen(a, key)) continue;
    if (ev === "open" && n.hm >= m.open && n.hm < addMin(m.open, OPEN_WINDOW_MIN) && n.hm < m.close) return { key, event: "open", value: q.last, q, local: t.hm };
    if (ev === "close" && n.hm >= addMin(m.close, CLOSE_AFTER_MIN) && n.hm < addMin(m.close, CLOSE_UNTIL_MIN)) return { key, event: "close", value: q.last, q, local: t.hm };
  }
  return null;
}
// releases published after the alert was created, matching every word; one release time per check (the earliest not yet sent)
export function evalRelease(a, rows, now) {
  if (!Array.isArray(rows)) return null;
  const words = String(a.match || "").toLowerCase().split(/\s+/).filter(Boolean), since = (Date.parse(a.created) || 0) - 60_000;
  const groups = new Map();
  for (const r of rows) {
    if (r.country !== a.country || r.actual == null || !r.event || !r.at) continue;
    const t = Date.parse(r.at); if (!(t >= since && t <= now + 5 * 60_000)) continue;
    const ev = r.event.toLowerCase(); if (!words.every((w) => ev.includes(w))) continue;
    const key = `${r.date} ${r.time}`; if (seen(a, key)) continue;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r);
  }
  if (!groups.size) return null;
  const key = [...groups.keys()].sort()[0];
  return { key, rows: groups.get(key) };
}
export function evaluate(a, quotes, rows, now) {
  const k = kindOf(a), q = quotes ? quotes[quoteSymOf(a)] : null;
  if (k === "price") return a.hit ? null : evalPrice(a, q, now);
  if (k === "move") return evalMove(a, q, now);
  if (k === "session") return evalSession(a, q, now);
  if (k === "release") return evalRelease(a, rows, now);
  return null;
}

// ---------- messages (English and Italian; numbers as CNBC / Nasdaq publish them) ----------
const NF = new Map();
export function fmtNum(v) {
  if (!Number.isFinite(v)) return "—";
  const d = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 4 : 6;
  let f = NF.get(d); if (!f) { f = new Intl.NumberFormat("en-US", { maximumFractionDigits: d }); NF.set(d, f); }
  return f.format(v);
}
const pctS = (v) => (Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%` : "—");
const city = (tz) => tz.split("/").pop().replace(/_/g, " ");
const MSG_TZ = "Europe/Rome";
export function describe(a, ev, now) {
  const k = kindOf(a), q = ev.q, rome = localParts(q ? q.time : now, MSG_TZ).hm, feed = q && !q.realTime ? [" (delayed)", " (ritardata)"] : ["", ""];
  if (k === "price") {
    const t = `${a.sym} ${a.op === ">=" ? "≥" : "≤"} ${fmtNum(a.price)}`;
    return { en: { title: t, text: `last ${fmtNum(q.last)} (${pctS(q.chgPct)} today) at ${rome} Rome time · CNBC${feed[0]}` },
      it: { title: t, text: `ultimo ${fmtNum(q.last)} (${pctS(q.chgPct)} oggi) alle ${rome} ora di Roma · CNBC${feed[1]}` } };
  }
  if (k === "move") {
    const lim = a.dir === "up" ? `+${a.pct}%` : a.dir === "down" ? `−${a.pct}%` : `±${a.pct}%`;
    return { en: { title: `${a.sym} ${pctS(q.chgPct)} today`, text: `alert at ${lim} · last ${fmtNum(q.last)}, previous close ${fmtNum(q.prev)}, ${rome} Rome time · CNBC${feed[0]}` },
      it: { title: `${a.sym} ${pctS(q.chgPct)} oggi`, text: `avviso a ${lim} · ultimo ${fmtNum(q.last)}, chiusura precedente ${fmtNum(q.prev)}, ${rome} ora di Roma · CNBC${feed[1]}` } };
  }
  if (k === "session") {
    const m = SESSIONS[a.market], c = city(m.tz);
    if (ev.event === "open") return { en: { title: `${m.name}: market open`, text: `${m.index} ${fmtNum(q.last)} (${pctS(q.chgPct)}) at ${ev.local} ${c} time · CNBC${feed[0]}` },
      it: { title: `${m.nameIt}: mercato aperto`, text: `${m.index} ${fmtNum(q.last)} (${pctS(q.chgPct)}) alle ${ev.local} ora di ${c} · CNBC${feed[1]}` } };
    return { en: { title: `${m.name}: market closed`, text: `${m.index} closed at ${fmtNum(q.last)} (${pctS(q.chgPct)} on the day), last print ${ev.local} ${c} time · CNBC${feed[0]}` },
      it: { title: `${m.nameIt}: mercato chiuso`, text: `${m.index} ha chiuso a ${fmtNum(q.last)} (${pctS(q.chgPct)} nella seduta), ultima rilevazione ${ev.local} ora di ${c} · CNBC${feed[1]}` } };
  }
  const r0 = ev.rows[0], at = localParts(Date.parse(r0.at), MSG_TZ).hm;
  const line = (r, L) => `${r.event}: ${L[0]} ${r.actual} · ${L[1]} ${r.consensus ?? "—"} · ${L[2]} ${r.previous ?? "—"}`;
  return { en: { title: `${a.country}: ${r0.event}${ev.rows.length > 1 ? ` (+${ev.rows.length - 1})` : ""}`, text: ev.rows.map((r) => line(r, ["actual", "consensus", "previous"])).join("\n") + `\nreleased ${at} Rome time · Nasdaq` },
    it: { title: `${a.country}: ${r0.event}${ev.rows.length > 1 ? ` (+${ev.rows.length - 1})` : ""}`, text: ev.rows.map((r) => line(r, ["effettivo", "consenso", "precedente"])).join("\n") + `\npubblicato alle ${at} ora di Roma · Nasdaq` } };
}
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function telegramText(items, lang) {
  const L = lang === "it" ? "it" : "en";
  return items.map((x) => `🔔 <b>${escH(x.msg[L].title)}</b>\n${escH(x.msg[L].text)}${x.note ? `\n<i>${escH(x.note)}</i>` : ""}`).join("\n\n")
    + `\n\n<a href="https://alessandrozanichelli.com/terminal/">Alessandro Terminal</a> · ALRT`;
}

// ---------- Telegram ----------
const TG_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,60}$/;
export const tgToken = (env) => { const t = String((env && env.TELEGRAM_BOT_TOKEN) || "").trim(); return TG_TOKEN_RE.test(t) ? t : null; };
export async function tgCall(env, method, payload, fetchImpl = fetch) {
  const tok = tgToken(env);
  if (!tok) return { err: env && env.TELEGRAM_BOT_TOKEN ? "bad_token_format" : "not_configured" };
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${tok}/${method}`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}) });
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (j && j.ok) return { data: j.result };
    const description = j && typeof j.description === "string" ? j.description.split(tok).join("[token]").slice(0, 200) : null;
    return { err: r.status === 401 || r.status === 404 ? "telegram_unauthorized" : r.status === 403 ? "telegram_blocked" : r.status === 429 ? "rate_limited" : r.status === 400 ? "telegram_bad_request" : "provider_error", http: r.status, description };
  } catch { return { err: ac.signal.aborted ? "provider_timeout" : "provider_unreachable" }; } finally { clearTimeout(timer); }
}
const CHAT_RE = /^-?\d{1,20}$/;
async function kvJson(env, k, dflt) { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : dflt; } catch { return dflt; } }
// the chat alerts go to: the one linked from ALRT, else the TELEGRAM_CHAT_ID secret
export async function tgChat(env) {
  const saved = (await kvJson(env, TG_KEY, null)) || {}, lang = saved.lang === "it" ? "it" : "en";
  if (saved.id && CHAT_RE.test(String(saved.id))) return { id: String(saved.id), name: saved.name || null, lang, from: "linked", linkedAt: saved.linkedAt || null };
  const e = String(env.TELEGRAM_CHAT_ID || "").trim();
  if (CHAT_RE.test(e)) return { id: e, name: null, lang, from: "secret" };
  return { id: null, lang };
}
export function chatsOf(updates) {
  const out = new Map();
  for (const u of Array.isArray(updates) ? updates : []) {
    const m = u && (u.message || u.edited_message || u.channel_post || u.my_chat_member), c = m && m.chat;
    if (!c || !CHAT_RE.test(String(c.id))) continue;
    const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? "@" + c.username : String(c.id));
    out.set(String(c.id), { id: String(c.id), type: c.type || null, name: clean(name, 80), username: c.username ? clean(c.username, 40) : null });
  }
  return [...out.values()];
}

// ---------- data for a check ----------
async function loadReleases(now) {
  const d = new Date(now), days = [d.toISOString().slice(0, 10)];
  if (d.getUTCHours() < 2) days.unshift(new Date(now - 86400_000).toISOString().slice(0, 10)); // late figures of the previous day
  const res = await Promise.all(days.map((day) => fetchText(NQ_CAL(day), { timeoutMs: 12000, headers: NQ_HEADERS }).then((f) => {
    if (f.err) return { err: f.err };
    try { return { data: parseNqCalendar(JSON.parse(f.text), day) }; } catch { return { err: "provider_error" }; }
  })));
  const rows = res.flatMap((r) => r.data || []);
  return rows.length || res.some((r) => r.data) ? { data: rows } : { err: res[0].err };
}

// ---------- the check (cron every 5 minutes, or POST /api/alerts/run) ----------
export async function runAlerts(now, env, deps = {}) {
  if (!env || !env.BRIEFS) return { err: "storage_not_configured" };
  const fetchQuotes = deps.fetchQuotes || loadCnbcQuotes, fetchReleases = deps.fetchReleases || loadReleases, call = deps.tgCall || ((m, p) => tgCall(env, m, p));
  const list = await kvJson(env, ALERTS_KEY, []), act = (Array.isArray(list) ? list : []).filter(isActive);
  const run = { at: iso(now), active: act.length, quotes: 0, fired: 0, err: null };
  let entries = [];
  if (act.length) {
    const want = [...new Set(act.map(quoteSymOf).filter(Boolean))];
    let quotes = {}, rows = null;
    const needRel = act.some((a) => kindOf(a) === "release");
    const [qr, rr] = await Promise.all([want.length ? fetchQuotes(want) : { data: {} }, needRel ? fetchReleases(now) : { data: null }]);
    if (qr.data) quotes = qr.data; else run.err = "quotes: " + qr.err;
    if (rr.data) rows = rr.data; else if (needRel) run.err = (run.err ? run.err + "; " : "") + "releases: " + rr.err;
    run.quotes = Object.keys(quotes).length;
    const fired = [];
    for (const a of act) { const ev = evaluate(a, quotes, rows, now); if (ev) fired.push({ a, ev, msg: describe(a, ev, now) }); }
    if (fired.length) {
      // record on the list as it is now (the page may have changed it meanwhile)
      const cur = await kvJson(env, ALERTS_KEY, []), at = iso(now);
      for (const { a, ev, msg } of fired) {
        const x = cur.find((y) => y.id === a.id); if (!x) continue;
        if (kindOf(x) === "price") x.hit = { at, price: ev.value, time: iso(ev.q.time), source: "CNBC" };
        else { const f = x.fired || { count: 0, keys: [] }; x.fired = { count: (f.count || 0) + 1, keys: [...(f.keys || []), ev.key].slice(-8), last: { at, key: ev.key, value: ev.value ?? null, title: msg.en.title } }; }
      }
      await env.BRIEFS.put(ALERTS_KEY, JSON.stringify(cur));
      const chat = await tgChat(env);
      const items = fired.map(({ a, msg }) => ({ msg, note: a.note || "" }));
      const sent = chat.id ? await call("sendMessage", { chat_id: chat.id, text: telegramText(items, chat.lang), parse_mode: "HTML", disable_web_page_preview: true }) : { err: "not_configured" };
      entries = fired.map(({ a, msg }) => ({ at, id: a.id, kind: kindOf(a), msg, note: a.note || "", telegram: sent.data ? "sent" : sent.err }));
      run.fired = fired.length;
    }
  }
  // persist: when something fired, when asked, or with the first check of each hour (heartbeat)
  if (run.fired || deps.force || new Date(now).getUTCMinutes() < 5) {
    const prev = await kvJson(env, LOG_KEY, {});
    await env.BRIEFS.put(LOG_KEY, JSON.stringify({ run, log: [...entries, ...(Array.isArray(prev.log) ? prev.log : [])].slice(0, LIMITS_A.log) }));
  }
  return { ...run, entries };
}

// ---------- HTTP ----------
export async function handleAlerts(url, env, ctx, H, json, req, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "storage_not_configured", status: "N/A" }, 503);
  const p = url.pathname.replace(/\/+$/, ""), method = req ? req.method : "GET", now = deps.now || Date.now();
  if (method !== "GET") {
    const origin = req && req.headers.get("origin");
    if (origin && origin !== (env.ALLOWED_ORIGIN || url.origin)) return send({ error: "forbidden_origin" }, 403);
  }
  const body = async () => { if (!req || !/^application\/json/i.test(req.headers.get("content-type") || "")) return {}; try { const b = await req.json(); return b && typeof b === "object" ? b : {}; } catch { return {}; } };
  const call = deps.tgCall || ((m, pl) => tgCall(env, m, pl));
  const tgStatus = async () => { const c = await tgChat(env); return { configured: !!tgToken(env), tokenFormatOk: env.TELEGRAM_BOT_TOKEN ? !!tgToken(env) : null, chat: c.id ? { name: c.name, from: c.from, linkedAt: c.linkedAt || null } : null, lang: c.lang }; };
  if (p === "/api/alerts" && method === "GET") {
    const [list, log] = await Promise.all([kvJson(env, ALERTS_KEY, []), kvJson(env, LOG_KEY, {})]);
    const out = { alerts: Array.isArray(list) ? list : [], log: Array.isArray(log.log) ? log.log : [], engine: { lastRecorded: log.run || null, schedule: "every 5 minutes (Cloudflare Cron Trigger); recorded when an alert fires and once an hour", freshMinutes: FRESH_MS / 60_000 },
      telegram: await tgStatus(), limits: LIMITS_A,
      catalog: { sessions: Object.entries(SESSIONS).map(([id, m]) => ({ id, ...m })), countries: RELEASE_COUNTRIES, indices: Object.keys(IDX_CNBC).sort(), futures: [...FUT_ROOTS].sort(), symHelp: SYM_HELP },
      source: "CNBC quote service (prices, indices), Nasdaq economic calendar (releases)" };
    if (url.searchParams.get("quotes") === "1") {
      const want = [...new Set(out.alerts.filter(isActive).map(quoteSymOf).filter(Boolean))];
      const r = want.length ? await (deps.fetchQuotes || loadCnbcQuotes)(want) : { data: {} };
      out.quotes = {}; out.quotesError = r.err || null; // by alert id
      for (const a of out.alerts) { const s = quoteSymOf(a), q = r.data && s ? r.data[s] : null; if (q) out.quotes[a.id] = { sym: s, last: q.last, prev: q.prev, chgPct: q.chgPct, time: iso(q.time), realTime: q.realTime, name: q.name, fresh: fresh(q, now) }; }
      out.quotesAt = iso(now);
    }
    return send(out);
  }
  if (p === "/api/alerts/run" && method === "POST") return send(await runAlerts(now, env, { ...deps, force: true }));
  if (p === "/api/alerts/telegram/chats" && method === "GET") {
    if (!tgToken(env)) return send({ error: env.TELEGRAM_BOT_TOKEN ? "bad_token_format" : "not_configured" }, 400);
    const [me, up] = await Promise.all([call("getMe", {}), call("getUpdates", { limit: 100, timeout: 0 })]);
    if (me.err) return send({ error: me.err, description: me.description || null }, 502);
    return send({ bot: { username: me.data.username || null, name: me.data.first_name || null }, chats: up.data ? chatsOf(up.data) : [], updatesError: up.err || null, hint: "send any message to the bot in Telegram, then look again (Telegram keeps messages for 24 hours)" });
  }
  if (p === "/api/alerts/telegram/link" && method === "POST") {
    const b = await body(), id = String(b.chatId || ""), lang = b.lang === "it" ? "it" : "en";
    if (!CHAT_RE.test(id)) return send({ error: "bad_request", message: "chatId required" }, 400);
    const up = await call("getUpdates", { limit: 100, timeout: 0 });
    if (up.err) return send({ error: up.err }, 502);
    const c = chatsOf(up.data).find((x) => x.id === id);
    if (!c) return send({ error: "bad_request", message: "only a chat that wrote to the bot can be linked" }, 400);
    const msg = lang === "it" ? "✅ Alessandro Terminal: gli avvisi arriveranno in questa chat." : "✅ Alessandro Terminal: alerts will arrive in this chat.";
    const s = await call("sendMessage", { chat_id: id, text: msg });
    if (s.err) return send({ error: s.err, description: s.description || null }, 502);
    await env.BRIEFS.put(TG_KEY, JSON.stringify({ id, name: c.name, lang, linkedAt: iso(now) }));
    return send({ telegram: await tgStatus() });
  }
  if (p === "/api/alerts/telegram/link" && method === "DELETE") {
    const saved = (await kvJson(env, TG_KEY, null)) || {};
    await env.BRIEFS.put(TG_KEY, JSON.stringify({ lang: saved.lang === "it" ? "it" : "en" }));
    return send({ telegram: await tgStatus() });
  }
  if (p === "/api/alerts/telegram/lang" && method === "POST") {
    const b = await body(), lang = b.lang === "it" ? "it" : b.lang === "en" ? "en" : null;
    if (!lang) return send({ error: "bad_request", message: "lang: en or it" }, 400);
    const saved = (await kvJson(env, TG_KEY, null)) || {};
    await env.BRIEFS.put(TG_KEY, JSON.stringify({ ...saved, lang }));
    return send({ telegram: await tgStatus() });
  }
  if (p === "/api/alerts/telegram/test" && method === "POST") {
    const c = await tgChat(env);
    if (!tgToken(env)) return send({ error: env.TELEGRAM_BOT_TOKEN ? "bad_token_format" : "not_configured" }, 400);
    if (!c.id) return send({ error: "no_chat", message: "link a chat first" }, 400);
    const t = localParts(now, MSG_TZ).hm;
    const s = await call("sendMessage", { chat_id: c.id, text: c.lang === "it" ? `🔔 Alessandro Terminal: messaggio di prova delle ${t} (ora di Roma). Gli avvisi arriveranno qui.` : `🔔 Alessandro Terminal: test message, ${t} Rome time. Alerts will arrive here.` });
    return s.err ? send({ error: s.err, description: s.description || null }, 502) : send({ sent: true, at: iso(now) });
  }
  return send({ error: "not_found" }, 404);
}
