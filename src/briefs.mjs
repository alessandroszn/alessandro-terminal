// BRIEFINGS (T06) — editions in the format of the reference terminal: Daily (weekday mornings),
// Evening (after the US close), Weekly (Saturday), Monthly (first Saturday). Each edition is written
// once, from real data only, and kept in an archive (Workers KV, binding BRIEFS).
//   GET  /api/briefs?period=daily            archive index + the edition that is due now
//   GET  /api/briefs/item?id=daily-2026-10-07
//   POST /api/briefs/write?period=daily      write the due edition if it does not exist yet
// REAL DATA → MODEL (Workers AI) → BRIEFING: the model only rewrites the DATA lines; every figure is
// checked against them, links are kept only if they are in DATA, tickers become chips only if in DATA.
import { cacheRead, cacheWrite, iso, easternDate, num } from "./lib.mjs";
import { getYieldCurves } from "./yields.mjs";
import { getCalendar, getWorldCalendar } from "./calendar.mjs";
import { topHeadlines } from "./press.mjs";
import { getUniverse, getCloses, getLive, alpacaConfigured, todayBarFinal, livePhase } from "./spx.mjs";
import { BRIEF_MODEL, verifyNumbers } from "./briefing.mjs";

export const PERIODS = {
  daily: { label: "Daily", sections: ["In one line", "Equities", "Rates and currencies", "Commodities and crypto", "Today"], words: "300 to 450", schedule: "Written automatically on weekday mornings at 07:30 (Rome time).", chipTf: "1W", eq: "1D" },
  evening: { label: "Evening", sections: ["In one line", "How the day went", "What changed since this morning", "Tomorrow"], words: "250 to 400", schedule: "Written automatically on weekday evenings at 22:30 (Rome time), after the US close.", chipTf: "1D", eq: "1D" },
  weekly: { label: "Weekly", sections: ["The week in one paragraph", "Equities", "Rates", "Currencies", "Commodities and crypto", "What drove it", "Next week"], words: "450 to 700", schedule: "Written automatically on Saturday mornings at 08:00 (Rome time).", chipTf: "1M", eq: "1W" },
  monthly: { label: "Monthly", sections: ["The month in one paragraph", "Equities", "Rates", "Currencies", "Commodities and crypto", "What drove it", "Next month"], words: "450 to 700", schedule: "Written automatically on the first Saturday of each month at 08:00 (Rome time).", chipTf: "6M", eq: "1M" },
};
// the same editions in Italian: written by the model from the same DATA (numbers keep the decimal point, so the
// number check is the same); section names in Italian
export const PERIODS_IT = {
  daily: { label: "Giornaliero", sections: ["In una riga", "Azioni", "Tassi e valute", "Materie prime e cripto", "Oggi"], schedule: "Scritto automaticamente nei giorni feriali alle 07:30 (ora di Roma)." },
  evening: { label: "Serale", sections: ["In una riga", "Com'è andata la giornata", "Cosa è cambiato da stamattina", "Domani"], schedule: "Scritto automaticamente nei giorni feriali alle 22:30 (ora di Roma), dopo la chiusura USA." },
  weekly: { label: "Settimanale", sections: ["La settimana in un paragrafo", "Azioni", "Tassi", "Valute", "Materie prime e cripto", "Cosa l'ha mossa", "La prossima settimana"], schedule: "Scritto automaticamente il sabato alle 08:00 (ora di Roma)." },
  monthly: { label: "Mensile", sections: ["Il mese in un paragrafo", "Azioni", "Tassi", "Valute", "Materie prime e cripto", "Cosa l'ha mosso", "Il prossimo mese"], schedule: "Scritto automaticamente il primo sabato di ogni mese alle 08:00 (ora di Roma)." },
};
export const LANGS = ["en", "it"];
const DISCLAIMER = { en: "AI-written summary of the real data listed below. Not investment advice.", it: "Sintesi scritta dall'AI dai dati reali elencati sotto. Non è una consulenza finanziaria." };
export const SLOT_MIN = { daily: 450, evening: 1350, weekly: 480, monthly: 480 }; // minutes after midnight, Rome
export const MARKET_SYMS = ["EUR/USD", "GBP/USD", "USD/JPY", "BTC/USD", "ETH/USD", "XAU/USD"];

// ---------- edition schedule (Europe/Rome) ----------
export function romeNow(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
export const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekday = (d) => new Date(d + "T12:00:00Z").getUTCDay(); // 0 Sun … 6 Sat
export function isSlotDay(period, d) {
  const w = weekday(d);
  if (period === "daily" || period === "evening") return w >= 1 && w <= 5;
  if (period === "weekly") return w === 6;
  if (period === "monthly") return w === 6 && Number(d.slice(8, 10)) <= 7;
  return false;
}
// an edition is written only while its data still describes it: daily until the evening slot,
// evening until the next morning, weekly / monthly over the weekend. Later it is not written at all.
const WRITE_WINDOW_MIN = { daily: 15 * 60, evening: 9 * 60, weekly: 48 * 60, monthly: 48 * 60 };
// the scheduled run (cron.mjs) writes each edition at slot + WRITE_OFFSET, retrying at +5 / +10 min;
// until then the terminal does not write it itself (it would race the schedule)
export const WRITE_OFFSET = { daily: 0, evening: 3, weekly: 0, monthly: 2 };
export const WRITE_RETRY = [0, 5, 10];
export const autoUntilMs = (period, slotAtMs) => slotAtMs + (WRITE_OFFSET[period] + WRITE_RETRY[WRITE_RETRY.length - 1] + 2) * 60_000;
// the latest edition whose writing time has passed
export function dueEdition(period, now = Date.now()) {
  const { date, minutes } = romeNow(now);
  for (let i = 0; i < 45; i++) {
    const d = addDays(date, -i);
    if (!isSlotDay(period, d)) continue;
    if (i === 0 && minutes < SLOT_MIN[period]) continue;
    const ageMin = i * 1440 + minutes - SLOT_MIN[period];
    const at = Math.floor(now / 60_000) * 60_000 - ageMin * 60_000; // slot time (approximate across a DST change)
    return { id: `${period}-${d}`, d, writable: ageMin < WRITE_WINDOW_MIN[period], at: new Date(at).toISOString(), auto: { writeAt: new Date(at + WRITE_OFFSET[period] * 60_000).toISOString(), until: new Date(autoUntilMs(period, at)).toISOString() } };
  }
  return null;
}

// ---------- S&P 500 summary from real constituent prices (derived) ----------
// mode "close": last completed consolidated session vs the one before; "live": IEX last trade vs last close;
// a reference map (1W/1M) compares the latest price with the close on/before the reference date
export function equitySummary(items, recent, { live = null, ref = null, todayET, todayFinal }) {
  const rows = [];
  let lastDate = null, baseDate = null;
  for (const it of items) {
    const bars = recent[it.sym];
    if (!bars || !bars.length) continue;
    const done = bars.filter(([d]) => d < todayET || todayFinal);
    let last = null, lastD = null, base = null, baseD = null;
    if (live) { // live mode: only constituents with a trade now; no mixing with older closes
      if (!live[it.sym]) continue;
      last = live[it.sym][0]; lastD = "live"; const prev = bars.filter(([d]) => d < todayET); if (prev.length) { base = prev[prev.length - 1][1]; baseD = prev[prev.length - 1][0]; }
    } else if (done.length) { last = done[done.length - 1][1]; lastD = done[done.length - 1][0]; if (done.length > 1) { base = done[done.length - 2][1]; baseD = done[done.length - 2][0]; } }
    if (ref) { const r = ref[it.sym]; base = r ? r[1] : null; baseD = r ? r[0] : null; }
    if (!(last > 0) || !(base > 0)) continue;
    rows.push({ ...it, last, base, chg: (last / base - 1) * 100 });
    if (lastD && lastD !== "live" && (!lastDate || lastD > lastDate)) lastDate = lastD;
    if (baseD && (!baseDate || baseD > baseDate)) baseDate = baseD;
  }
  const wsum = rows.reduce((a, r) => a + r.weight, 0);
  const avg = wsum ? rows.reduce((a, r) => a + r.weight * r.chg, 0) / wsum : null;
  const sectors = {};
  for (const r of rows) { const s = sectors[r.sector] || (sectors[r.sector] = { w: 0, wc: 0 }); s.w += r.weight; s.wc += r.weight * r.chg; }
  const sec = Object.entries(sectors).map(([name, s]) => ({ name, weight: s.w, chg: s.wc / s.w })).sort((a, b) => b.chg - a.chg);
  const contrib = rows.map((r) => ({ ...r, pp: (r.weight * r.chg) / (wsum || 1) })).sort((a, b) => b.pp - a.pp);
  const movers = rows.slice().sort((a, b) => b.chg - a.chg);
  return {
    n: rows.length, total: items.length, avg, lastDate, baseDate,
    up: rows.filter((r) => r.chg > 0).length, down: rows.filter((r) => r.chg < 0).length,
    sectors: sec, topContrib: contrib.slice(0, 4), bottomContrib: contrib.slice(-4).reverse(),
    gainers: movers.slice(0, 4), losers: movers.slice(-4).reverse(),
  };
}

// ---------- DATA lines ----------
const f2 = (v) => (v == null || !Number.isFinite(v) ? "N/A" : (v >= 0 ? "+" : "") + v.toFixed(2));
const raw = (v) => (v == null || !Number.isFinite(v) ? "N/A" : String(+Number(v).toFixed(6)));
export function buildData({ period, edition, now, eq, eqMode, quotes, fxHist, curves, events, headlines, morning }) {
  const L = [], sources = [], symbols = new Set();
  L.push(`EDITION ${PERIODS[period].label} briefing for ${edition.d}, written ${iso(now)}`);
  if (eq && eq.n) {
    const span = eqMode === "live" ? `session in progress / latest IEX trades vs close of ${eq.baseDate}` : eqMode === "close" ? `session ${eq.lastDate} vs ${eq.baseDate} (consolidated closes)` : `${eq.lastDate || "latest"} vs ${eq.baseDate} (${PERIODS[period].eq} change, consolidated closes)`;
    L.push(`EQUITY S&P 500 constituents, IVV-weighted average change (derived; not the index level): ${f2(eq.avg)}% — ${span}; advancers ${eq.up}, decliners ${eq.down}, priced ${eq.n} of ${eq.total} [Alpaca prices, iShares IVV weights]`);
    for (const s of eq.sectors) L.push(`SECTOR ${s.name}: ${f2(s.chg)}% (weight ${s.weight.toFixed(2)}%)`);
    const line = (tag, r) => { symbols.add(r.sym); return `${tag} \`${r.sym}\` ${r.name}: ${f2(r.chg)}% (last ${raw(r.last)} USD, weight ${r.weight.toFixed(2)}%${r.pp != null ? `, contribution ${f2(r.pp)} pp` : ""})`; };
    eq.topContrib.forEach((r) => L.push(line("CONTRIBUTION_UP", r)));
    eq.bottomContrib.forEach((r) => L.push(line("CONTRIBUTION_DOWN", r)));
    eq.gainers.forEach((r) => L.push(line("GAINER", r)));
    eq.losers.forEach((r) => L.push(line("LOSER", r)));
    sources.push({ name: "S&P 500 constituents: Alpaca prices, iShares IVV weights (derived)", timestamp: eq.lastDate || iso(now) });
  } else L.push("EQUITY S&P 500 constituent prices: N/A (not available for this edition)");
  for (const q of quotes) {
    symbols.add(q.symbol);
    const h = fxHist && fxHist[q.symbol];
    L.push(`QUOTE \`${q.symbol}\` ${q.name || q.symbol}: last ${raw(q.price)}${q.currency ? " " + q.currency : ""}, day change ${f2(q.changePct)}% vs previous close ${raw(q.prevClose)}${h ? `, ${PERIODS[period].eq} change ${f2(h.chg)}% vs close ${raw(h.base)} on ${h.baseDate}` : ""} — data time ${q.timestamp} [Twelve Data]`);
  }
  if (quotes.length) sources.push({ name: "Twelve Data (FX, crypto, gold, watchlist)", timestamp: quotes.map((q) => q.timestamp).filter(Boolean).sort().pop() });
  for (const c of Object.values(curves || {})) {
    const pts = c.points.filter((p) => p.value != null && ["3M", "2Y", "5Y", "10Y", "30Y"].includes(p.tenor));
    L.push(`YIELDS ${c.id} ${c.kind} on ${c.timestamp} (vs ${c.previousDate}): ` + pts.map((p) => `${p.tenor} ${raw(p.value)}%${p.changeBp != null ? ` (${p.changeBp >= 0 ? "+" : ""}${p.changeBp.toFixed(1)} bp)` : ""}`).join(", ") + ` [${c.source}]`);
    const two = c.points.find((p) => p.tenor === "2Y"), ten = c.points.find((p) => p.tenor === "10Y");
    if (two && ten && two.value != null && ten.value != null) L.push(`SPREAD ${c.id} 10Y minus 2Y: ${((ten.value - two.value) * 100).toFixed(1)} bp [derived from ${c.source}]`);
    sources.push({ name: c.source, timestamp: c.timestamp, url: c.sourceUrl });
  }
  for (const e of events) {
    const fp = [e.forecast && e.forecast.value ? `forecast ${e.forecast.value}` : null, e.previous && e.previous.value ? `previous ${e.previous.value}` : null].filter(Boolean).join(", ");
    L.push(`EVENT ${e.dateET}${e.timeET ? " " + e.timeET + " ET" : ""} ${e.region || "United States"}${e.currency ? " (" + e.currency + ")" : ""} ${e.indicator}${e.impact ? " — impact " + e.impact : ""}${fp ? " — " + fp : ""} [${e.source === "FF" ? "Forex Factory" : e.source}]`);
  }
  if (events.length) sources.push({ name: events.some((e) => e.source === "FF") ? "Forex Factory calendar (high impact)" : "BLS / BEA release schedules", timestamp: events[0].datetime, url: events[0].sourceUrl });
  for (const h of headlines) L.push(`HEADLINE ${h.timestamp} ${h.source}${h.section ? " (" + h.section + ")" : ""}: ${h.title} — ${h.url}`);
  if (headlines.length) sources.push({ name: "Headlines: " + [...new Set(headlines.map((h) => h.source))].join(", "), timestamp: headlines[0].timestamp });
  if (morning) L.push(...morning.split("\n").filter((l) => /^(EQUITY|QUOTE|YIELDS)/.test(l)).map((l) => "MORNING " + l));
  return { text: L.join("\n"), sources, symbols: [...symbols] };
}

export function systemPrompt(period, lang = "en") {
  const p = PERIODS[period], it = lang === "it", secs = it ? PERIODS_IT[period].sections : p.sections;
  return [
    it ? `You write the ${p.label} markets briefing of a personal market terminal, in Italian (natural, professional financial Italian, as in Il Sole 24 Ore), in Markdown.`
      : `You write the ${p.label} markets briefing of a personal market terminal, in English, in Markdown.`,
    it ? "First line exactly: 'TITLE: ' followed by a headline in Italian of at most 12 words." : "First line exactly: 'TITLE: ' followed by a headline of at most 12 words.",
    `Then exactly these level-2 sections, in this order: ${secs.map((s) => "'## " + s + "'").join(", ")}.`,
    ...(it ? ["Write every number exactly as in DATA, with the decimal point (e.g. 0.70%), not the decimal comma. Write 'è salito dello 0.58%' / 'è sceso dello 0.61%'. Keep tickers, instrument codes and headline titles as they are; you may describe a headline in Italian but link it with its exact URL."] : []),
    `The first section is a single sentence. Total length ${p.words} words. Short paragraphs; bullets only for lists of events.`,
    "Use ONLY the facts in DATA. Never add a number, company, event, cause or claim that is not in DATA. Round prices, yields and percentages to at most two decimals (e.g. 0.58%); FX rates to four.",
    "The S&P 500 figure in DATA is an IVV-weighted average of constituent prices, not the index level: never call it the index level or give a level for it.",
    "Write tickers in backticks exactly as in DATA, e.g. `NVDA`, `EUR/USD`.",
    "When you mention a headline, link it with Markdown using its exact URL from DATA, e.g. [FT](https://www.ft.com/...). Use no other URL.",
    "If DATA has nothing for a section, write one sentence saying that data is not available. Lines starting with MORNING are the morning edition's data, for comparison.",
    it ? "Style: a concise note by a markets editor. Plain, varied sentences; never use the word 'rispettivamente' (give each figure next to its instrument); at most three tickers per sentence; no sign after salito/sceso." : "Style: a concise note by a markets editor. Plain, varied sentences; never write 'respectively'; at most three tickers per sentence; write 'fell 0.61%' or 'rose 0.58%' (no sign after rose/fell).",
    "Name instruments plainly: `EUR/USD` is the euro against the dollar, `BTC/USD` bitcoin, `ETH/USD` ether, `XAU/USD` gold, all in dollars.",
    "Say that something led or drove a move only when DATA shows it (CONTRIBUTION lines); otherwise just report it.",
    "Describe what happened; never predict, never recommend, no investment advice.",
  ].join(" ");
}

// keep only links whose URL is in DATA; collect the rest
export function sanitize(markdown, dataText) {
  const removed = [];
  const body = String(markdown).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => { if (dataText.includes(u)) return m; removed.push(u); return t; });
  return { body, removedLinks: removed };
}
export function parseOutput(text, period, lang = "en") {
  const lines = String(text || "").trim().split("\n");
  let title = null;
  const i = lines.findIndex((l) => /^\s*\**TITLE:\**/i.test(l));
  if (i >= 0) { title = lines[i].replace(/^\s*\**TITLE:\**\s*/i, "").replace(/\*\*/g, "").trim(); lines.splice(i, 1); }
  const body = lines.join("\n").trim();
  const missing = (lang === "it" ? PERIODS_IT[period] : PERIODS[period]).sections.filter((s) => !new RegExp(`^##\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "mi").test(body));
  if (!title) { const first = /^##\s+[^\n]+\n+([^\n#][^\n]*)/m.exec(body); title = first ? first[1].replace(/[`*]/g, "").split(/(?<=[.!?])\s/)[0].slice(0, 160) : lang === "it" ? `Briefing ${PERIODS_IT[period].label.toLowerCase()}` : `${PERIODS[period].label} briefing`; }
  return { title, body, missingSections: missing };
}

// windows attached to an edition (chosen by code, from the data actually used)
export function attachWindows(period, eq, lang = "en") {
  const tf = PERIODS[period].chipTf, metric = PERIODS[period].eq, w = [], it = lang === "it";
  w.push({ type: "MAP", state: { metric, size: "weight", view: "map" }, label: it ? `Heat map S&P 500 · ${metric}` : `S&P 500 heat map · ${metric}`, why: it ? "Dove sono stati i movimenti, per settore e peso nell'indice." : "Where the moves were, by sector and index weight." });
  if (eq && eq.n) {
    const up = eq.topContrib[0], dn = eq.bottomContrib[0];
    if (up) w.push({ type: "GP", state: { ticker: up.sym, tf }, label: it ? `${up.sym} · maggior contributo positivo` : `${up.sym} · largest positive contribution`, why: `${up.name}: ${f2(up.chg)}%` });
    if (dn) w.push({ type: "GP", state: { ticker: dn.sym, tf }, label: it ? `${dn.sym} · maggior contributo negativo` : `${dn.sym} · largest negative contribution`, why: `${dn.name}: ${f2(dn.chg)}%` });
  }
  if (period !== "evening") w.push({ type: "YLD", state: {}, label: it ? "Curve dei titoli di Stato" : "Government curves", why: it ? "Livelli e variazioni delle curve pubblicate." : "Levels and change of the published curves." });
  w.push({ type: period === "evening" ? "CAL" : "MKT", state: {}, label: period === "evening" ? (it ? "Calendario" : "Calendar") : (it ? "Valute, cripto, oro" : "FX, crypto, gold"), why: period === "evening" ? (it ? "Cosa è in programma." : "What is scheduled next.") : (it ? "Quotazioni di valute, cripto e oro." : "Currencies, crypto and gold quotes.") });
  return w;
}

// ---------- inputs ----------
export async function tdDaily(env, symbols, now, origin, ctx) {
  // weekly / monthly change for FX, crypto, gold: one batched daily series (credits = symbols)
  const key = tdDailyKey(now);
  const c = await cacheRead(origin, key, ctx);
  if (c && c.data) return c.data;
  if (!env.TWELVEDATA_KEY || (ctx && ctx.readOnly)) return null;
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?${new URLSearchParams({ symbol: symbols.join(","), interval: "1day", outputsize: "40", order: "asc" })}`, { headers: { authorization: `apikey ${env.TWELVEDATA_KEY}` } });
    const j = await r.json();
    if (j && j.status === "error") return null;
    const out = {};
    for (const s of symbols) { const x = symbols.length === 1 ? j : j[s]; if (x && Array.isArray(x.values)) out[s] = x.values.map((v) => [String(v.datetime).slice(0, 10), num(v.close)]).filter((v) => v[1] != null); }
    cacheWrite(origin, key, { data: out, fetchedAt: now }, ctx, 12 * 3600);
    return out;
  } catch { return null; }
}
export const tdDailyKey = (now) => `brief/td-daily/${new Date(now).toISOString().slice(0, 10)}`;
function periodChange(series, refDate) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1], base = series.filter(([d]) => d <= refDate).pop();
  return base && base[1] > 0 ? { chg: (last[1] / base[1] - 1) * 100, base: base[1], baseDate: base[0] } : null;
}

async function gather(origin, env, ctx, period, edition, symbolsParam, now) {
  const errors = {};
  // S&P 500 (Alpaca + IVV)
  let eq = null, eqMode = null;
  if (alpacaConfigured(env)) {
    const u = await getUniverse(origin, ctx);
    if (u.data) {
      const syms = u.data.items.map((x) => x.sym), todayET = easternDate(new Date(now));
      const rec = await getCloses(origin, env, ctx, "recent", syms, now);
      if (rec.data) {
        const final = todayBarFinal(now);
        let live = null;
        if (period === "evening" && !final) { const l = await getLive(origin, env, ctx, syms); if (l.data && livePhase(l.data, now).live) live = l.data; }
        let ref = null;
        if (period === "weekly" || period === "monthly") { const r = await getCloses(origin, env, ctx, PERIODS[period].eq, syms, now); if (r.data) ref = r.data; else errors.equityRef = r.err; }
        eqMode = ref ? "period" : live ? "live" : "close";
        if (!(period === "weekly" || period === "monthly") || ref) eq = equitySummary(u.data.items, rec.data, { live, ref, todayET, todayFinal: final });
      } else errors.equity = rec.err;
    } else errors.equity = u.err;
  } else errors.equity = "alpaca_not_configured";
  // quotes (Twelve Data cache: watchlist + markets board), never a new quote call here
  const quotes = [];
  for (const s of symbolsParam) {
    const e = await cacheRead(origin, `quote/${encodeURIComponent(s)}`, ctx);
    if (e && e.rec && now - e.fetchedAt < 24 * 3600_000) quotes.push({ symbol: s, name: e.rec.name, price: e.rec.price, changePct: e.rec.changePct, prevClose: e.rec.prevClose, currency: e.rec.currency, timestamp: e.rec.asOf });
  }
  let fxHist = null;
  if (period === "weekly" || period === "monthly") {
    const series = await tdDaily(env, MARKET_SYMS, now, origin, ctx);
    if (series) { const refDate = addDays(edition.d, period === "weekly" ? -7 : -30); fxHist = Object.fromEntries(MARKET_SYMS.map((s) => [s, periodChange(series[s], refDate)]).filter(([, v]) => v)); }
  }
  const nHead = period === "weekly" || period === "monthly" ? 24 : 16;
  const [y, world, headlines] = await Promise.all([getYieldCurves(origin, ctx, now), getWorldCalendar(origin, ctx, now), topHeadlines(origin, ctx, nHead)]);
  // world high-impact events (Forex Factory); the US official schedules only if that source is unavailable
  const cal = world.events.length ? { events: world.events.filter((e) => e.impact === "High") } : await getCalendar(origin, ctx, now);
  if (!world.events.length) errors.calendarWorld = world.err || "no_data";
  // calendar window per edition (US/Eastern dates)
  const todayET = easternDate(new Date(now)), horizon = { daily: [todayET, todayET], evening: [addDays(todayET, 1), addDays(todayET, 3)], weekly: [addDays(todayET, 1), addDays(todayET, 9)], monthly: [addDays(todayET, 1), addDays(todayET, 35)] }[period];
  const events = (cal.events || []).filter((e) => e.dateET >= horizon[0] && e.dateET <= horizon[1]).slice(0, 14);
  return { eq, eqMode, quotes, fxHist, curves: y.curves || {}, events, headlines, errors };
}

// ---------- archive (KV) ----------
const IDX = (period) => `index/${period}`;
export async function kvJson(env, key) { try { const t = await env.BRIEFS.get(key); return t ? JSON.parse(t) : null; } catch { return null; } }

// one language version of an edition from the DATA lines: model → sections → links kept only if in DATA → number check
async function compose(env, period, dataText, lang) {
  let out = null;
  try {
    const r = await env.AI.run(BRIEF_MODEL, { messages: [{ role: "system", content: systemPrompt(period, lang) }, { role: "user", content: `DATA:\n${dataText}` }], max_tokens: period === "weekly" || period === "monthly" ? 1400 : 1000, temperature: 0.2 });
    out = r && (r.response || (r.result && r.result.response));
  } catch { /* reported by the caller */ }
  if (!out) return null;
  const p = parseOutput(out, period, lang), s = sanitize(p.body, dataText);
  return { title: p.title, body: s.body, n: s.body.length, verification: { ...verifyNumbers(s.body, dataText), removedLinks: s.removedLinks, missingSections: p.missingSections }, disclaimer: DISCLAIMER[lang] };
}
// window labels of an edition in Italian (the windows themselves are the same)
export function localizeWindows(windows, lang) {
  if (lang !== "it" || !Array.isArray(windows)) return windows;
  const T = { "Where the moves were, by sector and index weight.": "Dove sono stati i movimenti, per settore e peso nell'indice.", "Government curves": "Curve dei titoli di Stato", "Levels and change of the published curves.": "Livelli e variazioni delle curve pubblicate.", "Calendar": "Calendario", "What is scheduled next.": "Cosa è in programma.", "FX, crypto, gold": "Valute, cripto, oro", "Currencies, crypto and gold quotes.": "Quotazioni di valute, cripto e oro." };
  return windows.map((w) => ({ ...w, label: T[w.label] || String(w.label).replace(/^S&P 500 heat map · /, "Heat map S&P 500 · ").replace(/ · largest positive contribution$/, " · maggior contributo positivo").replace(/ · largest negative contribution$/, " · maggior contributo negativo"), why: T[w.why] || w.why }));
}
// the edition as served in a language (falls back to English when that version does not exist)
export function inLang(brief, lang) {
  const v = lang === "it" && brief.i18n && brief.i18n.it;
  if (!v) return { ...brief, lang: "en", ...(lang === "it" ? { langMissing: "it" } : {}) };
  return { ...brief, ...v, windows: localizeWindows(brief.windows, "it"), lang: "it" };
}

export async function writeEdition(origin, env, ctx, period, edition, symbols, now, force, by = "terminal") {
  const lockKey = `lock/${edition.id}`;
  if (await env.BRIEFS.get(lockKey)) return { status: 202, body: { writing: true, id: edition.id } };
  await env.BRIEFS.put(lockKey, String(now), { expirationTtl: 120 });
  try {
    const g = await gather(origin, env, ctx, period, edition, symbols, now);
    const morning = period === "evening" ? (await kvJson(env, `brief/daily-${edition.d}`))?.inputData || null : null;
    const data = buildData({ period, edition, now, eq: g.eq, eqMode: g.eqMode, quotes: g.quotes, fxHist: g.fxHist, curves: g.curves, events: g.events, headlines: g.headlines, morning });
    // English and Italian from the same DATA, in parallel; the edition exists if the English one was written
    const [en, it] = await Promise.all([compose(env, period, data.text, "en"), compose(env, period, data.text, "it")]);
    if (!en) return { status: 502, body: { error: "model_error", status: "N/A" } };
    const brief = {
      id: edition.id, period, d: edition.d, title: en.title, body: en.body, created: Math.floor(now / 1000), n: en.n,
      status: "DERIVED", model: BRIEF_MODEL, provider: "Cloudflare Workers AI",
      verification: en.verification, writtenBy: by,
      symbols: data.symbols, windows: attachWindows(period, g.eq), sources: data.sources, inputData: data.text, inputErrors: g.errors,
      disclaimer: en.disclaimer, ...(it ? { i18n: { it } } : {}),
    };
    const idx = (await kvJson(env, IDX(period))) || [];
    const meta = { id: brief.id, period, d: brief.d, title: brief.title, ...(it ? { title_it: it.title } : {}), created: brief.created, n: brief.n, writtenBy: by };
    const next = [meta, ...idx.filter((x) => x.id !== brief.id)].sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 60);
    await env.BRIEFS.put(`brief/${brief.id}`, JSON.stringify(brief));
    await env.BRIEFS.put(IDX(period), JSON.stringify(next));
    return { status: force ? 200 : 201, body: brief };
  } finally {
    ctx && ctx.waitUntil ? ctx.waitUntil(env.BRIEFS.delete(lockKey)) : await env.BRIEFS.delete(lockKey);
  }
}

// a language version for an edition that has none yet: written from the edition's own stored DATA (never newer data)
async function writeLang(env, ctx, id, lang) {
  const brief = await kvJson(env, `brief/${id}`);
  if (!brief) return { status: 404, body: { error: "not_found", status: "N/A" } };
  if (brief.i18n && brief.i18n[lang]) return { status: 200, body: inLang(brief, lang) };
  const lockKey = `lock/${id}/${lang}`;
  if (await env.BRIEFS.get(lockKey)) return { status: 202, body: { writing: true, id } };
  await env.BRIEFS.put(lockKey, "1", { expirationTtl: 120 });
  try {
    const v = await compose(env, brief.period, brief.inputData || "", lang);
    if (!v) return { status: 502, body: { error: "model_error", status: "N/A" } };
    brief.i18n = { ...(brief.i18n || {}), [lang]: v };
    await env.BRIEFS.put(`brief/${id}`, JSON.stringify(brief));
    const idx = (await kvJson(env, IDX(brief.period))) || [];
    await env.BRIEFS.put(IDX(brief.period), JSON.stringify(idx.map((x) => (x.id === id ? { ...x, [`title_${lang}`]: v.title } : x))));
    return { status: 201, body: inLang(brief, lang) };
  } finally {
    ctx && ctx.waitUntil ? ctx.waitUntil(env.BRIEFS.delete(lockKey)) : await env.BRIEFS.delete(lockKey);
  }
}

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-:\/]{0,19}$/;
export async function handleBriefs(url, env, ctx, H, json, req) {
  const send = (body, status = 200) => { const r = json(body, H, status); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "storage_not_configured", status: "N/A" }, 503);
  const sub = url.pathname.replace(/^\/api\/briefs\/?/, "");
  if (sub === "item") {
    const id = url.searchParams.get("id") || "";
    if (!/^(daily|evening|weekly|monthly)-\d{4}-\d{2}-\d{2}$/.test(id)) return send({ error: "bad_request" }, 400);
    const b = await kvJson(env, `brief/${id}`);
    return b ? send(inLang(b, url.searchParams.get("lang") === "it" ? "it" : "en")) : send({ error: "not_found", status: "N/A" }, 404);
  }
  if (sub === "lang") {
    if (req && req.method !== "POST") return send({ error: "method_not_allowed" }, 405);
    const id = url.searchParams.get("id") || "", lang = url.searchParams.get("lang") || "";
    if (!/^(daily|evening|weekly|monthly)-\d{4}-\d{2}-\d{2}$/.test(id) || !LANGS.includes(lang) || lang === "en") return send({ error: "bad_request" }, 400);
    if (!env.AI || typeof env.AI.run !== "function") return send({ error: "model_unavailable", status: "N/A" }, 503);
    const r = await writeLang(env, ctx, id, lang);
    return send(r.body, r.status);
  }
  const period = url.searchParams.get("period") || "daily";
  if (!PERIODS[period]) return send({ error: "bad_request", message: `period must be one of ${Object.keys(PERIODS).join(",")}` }, 400);
  const now = Date.now(), due = dueEdition(period, now);
  if (sub === "") {
    const [briefs, last] = await Promise.all([kvJson(env, IDX(period)), kvJson(env, "cron/last")]);
    return send({ period, label: PERIODS[period].label, sections: PERIODS[period].sections, schedule: PERIODS[period].schedule, chipTf: PERIODS[period].chipTf, due, dueWritten: !!(due && (briefs || []).some((b) => b.id === due.id)), briefs: briefs || [], automatic: { lastRun: last ? last.at : null } });
  }
  if (sub === "write") {
    if (req && req.method !== "POST") return send({ error: "method_not_allowed" }, 405);
    if (!due) return send({ error: "not_due" }, 409);
    if (!due.writable) return send({ error: "edition_window_passed", status: "N/A", due }, 409);
    const force = url.searchParams.get("force") === "1";
    if (!force) { const ex = await kvJson(env, `brief/${due.id}`); if (ex) return send(ex); }
    // the scheduled run is writing it now: the terminal does not race it (REWRITE, force=1, still can)
    if (!force && now < Date.parse(due.auto.until)) return send({ error: "scheduled_write", status: "PENDING", due }, 409);
    if (!env.AI || typeof env.AI.run !== "function") return send({ error: "model_unavailable", status: "N/A" }, 503);
    const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s)))].slice(0, 20);
    const r = await writeEdition(url.origin, env, ctx, period, due, symbols, now, force);
    return send(r.body, r.status);
  }
  return send({ error: "not found" }, 404);
}
