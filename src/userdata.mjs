// MY STUFF (T07) — the owner's own lists, stored on the server (Workers KV, binding BRIEFS), private behind Access.
//   GET|POST|DELETE  /api/user/alerts          alerts: price, daily move, market open / close, economic release (see
//                                              alerts.mjs: checked on the server every 5 minutes, optionally sent to Telegram)
//   POST             /api/user/alerts/rearm?id a fired price alert watches again
//   GET|POST|PUT|DELETE /api/user/notes        notes {text, sym?}
//   GET|PUT          /api/user/board           custom boards [{id, name, syms[]}]
//   GET|POST|DELETE  /api/user/views           saved layouts [{id, name, desk:{w,h}, layout:[{type, state, x, y, w, h, min}], saved}]
//                                              (a name saved again replaces that view)
//   GET              /api/status[?usage=1]     system status for SYS: which sources are configured (yes/no only),
//                                              Twelve Data credit usage (checked on request: 1 credit), the scheduler's last run
// Nothing here is market data: these are the owner's own entries. All start empty.
import { finnhubKey } from "./earnings.mjs";
import { fetchText, iso, cachedSource, cacheRead } from "./lib.mjs";
import { validateAlert, alertCnbcSym, isActive, kindOf, tgToken, LIMITS_A, LOG_KEY } from "./alerts.mjs";
import { loadCnbcQuotes } from "./cnbc.mjs";

export const UD_KEYS = { alerts: "ud/alerts", notes: "ud/notes", board: "ud/board", views: "ud/views" };
// quotes cost Twelve Data credits (8 a minute on the free plan): a board, like the watchlist, holds at most 12 symbols.
// Alerts are checked on CNBC quotes (one request for all of them): at most 25 different symbols
export const LIMITS = { alerts: LIMITS_A.alerts, alertSyms: LIMITS_A.alertSyms, notes: 300, boards: 20, boardSyms: 12, noteLen: 4000, views: 30, viewWins: 24, viewState: 4000 };
const SYM_RE = /^[A-Z0-9][A-Z0-9.\-:/]{0,19}$/;

async function load(env, k) { try { const t = await env.BRIEFS.get(UD_KEYS[k]); const a = t ? JSON.parse(t) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
const save = (env, k, v) => env.BRIEFS.put(UD_KEYS[k], JSON.stringify(v));
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

export { validateAlert };
export function validateNote(b) {
  if (!b || typeof b !== "object") return "body required";
  const text = clean(b.text, LIMITS.noteLen);
  if (!text) return "text required";
  const sym = b.sym ? clean(b.sym, 20).toUpperCase() : "";
  if (sym && !SYM_RE.test(sym)) return "bad symbol";
  return { text, sym: sym || null };
}
// a saved layout: the window types and their own state (no market data), positions and sizes on the desk
export function validateView(b) {
  if (!b || typeof b !== "object") return "body required";
  const name = clean(b.name, 40); if (!name) return "a name is required";
  const L = Array.isArray(b.layout) ? b.layout : null; if (!L || !L.length) return "layout[] required (at least one window)";
  if (L.length > LIMITS.viewWins) return `at most ${LIMITS.viewWins} windows`;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null), layout = [];
  for (const w of L) {
    const type = String(w && w.type || ""); if (!/^[A-Z]{1,8}$/.test(type)) return "bad window type";
    const st = w.state && typeof w.state === "object" && !Array.isArray(w.state) ? w.state : {}, js = JSON.stringify(st);
    if (js.length > LIMITS.viewState) return `window state too large (${type})`;
    const x = num(w.x), y = num(w.y), ww = num(w.w), h = num(w.h);
    if ([x, y, ww, h].some((v) => v == null || v < -100 || v > 20000)) return "bad window position";
    layout.push({ type, state: JSON.parse(js), x, y, w: ww, h, min: !!w.min });
  }
  const dw = num(b.desk && b.desk.w), dh = num(b.desk && b.desk.h);
  return { name, layout, desk: dw && dh ? { w: dw, h: dh } : null };
}
export function validateBoards(b) {
  const list = b && Array.isArray(b.boards) ? b.boards : null;
  if (!list) return "boards[] required";
  if (list.length > LIMITS.boards) return `at most ${LIMITS.boards} boards`;
  const out = [];
  for (const x of list) {
    const name = clean(x && x.name, 40);
    if (!name) return "each board needs a name";
    const syms = [...new Set((Array.isArray(x.syms) ? x.syms : []).map((s) => clean(s, 20).toUpperCase()).filter(Boolean))];
    if (syms.length > LIMITS.boardSyms) return `at most ${LIMITS.boardSyms} symbols per board`;
    const bad = syms.find((s) => !SYM_RE.test(s)); if (bad) return `bad symbol: ${bad}`;
    out.push({ id: x.id && /^[a-z0-9-]{6,40}$/.test(x.id) ? x.id : crypto.randomUUID(), name, syms });
  }
  return out;
}

export async function handleUserData(url, env, ctx, H, json, req) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "storage_not_configured", status: "N/A" }, 503);
  const parts = url.pathname.replace(/^\/api\/user\/?/, "").split("/"), kind = parts[0], sub = parts[1] || "", method = req ? req.method : "GET";
  if (!UD_KEYS[kind]) return send({ error: "not found" }, 404);
  if (method === "GET" && !sub) return send(kind === "board" ? { boards: await load(env, kind) } : { [kind]: await load(env, kind) });
  // writes: same-origin JSON only (as the portfolio)
  const origin = req && req.headers.get("origin");
  if (origin && origin !== (env.ALLOWED_ORIGIN || url.origin)) return send({ error: "forbidden_origin" }, 403);
  const body = async () => { if (!/^application\/json/i.test(req.headers.get("content-type") || "")) return { e: send({ error: "bad_request", message: "JSON body required" }, 415) }; try { return { b: await req.json() }; } catch { return { e: send({ error: "bad_request", message: "invalid JSON" }, 400) }; } };
  const id = url.searchParams.get("id") || "";
  if (kind === "board") {
    if (method !== "PUT" || sub) return send({ error: "method_not_allowed" }, 405);
    const p = await body(); if (p.e) return p.e;
    const v = validateBoards(p.b); if (typeof v === "string") return send({ error: "bad_request", message: v }, 400);
    await save(env, kind, v); return send({ boards: v });
  }
  if (kind === "views" && method === "POST" && !sub) {
    const p = await body(); if (p.e) return p.e;
    const v = validateView(p.b); if (typeof v === "string") return send({ error: "bad_request", message: v }, 400);
    const list = await load(env, kind), same = list.find((x) => x.name.toLowerCase() === v.name.toLowerCase());
    if (!same && list.length >= LIMITS.views) return send({ error: "bad_request", message: `limit of ${LIMITS.views} views reached` }, 400);
    const item = { id: same ? same.id : crypto.randomUUID(), ...v, saved: iso(Date.now()) };
    const next = same ? list.map((x) => (x.id === same.id ? item : x)) : [...list, item];
    await save(env, kind, next); return send({ saved: item.id, replaced: !!same, views: next }, same ? 200 : 201);
  }
  const list = await load(env, kind);
  if (method === "DELETE" && !sub) {
    const rest = list.filter((x) => x.id !== id);
    if (rest.length === list.length) return send({ error: "not_found" }, 404);
    await save(env, kind, rest); return send({ removed: id, [kind]: rest });
  }
  if (kind === "alerts") {
    if (method === "POST" && sub === "rearm") {
      const a = list.find((x) => x.id === id); if (!a) return send({ error: "not_found" }, 404);
      if (kindOf(a) !== "price" || !a.hit) return send({ error: "bad_request", message: "only a fired price alert can be re-armed" }, 400);
      a.hit = null; a.rearmed = iso(Date.now()); await save(env, kind, list); return send({ alerts: list });
    }
    if (method === "POST" && !sub) {
      const p = await body(); if (p.e) return p.e;
      const v = validateAlert(p.b); if (typeof v === "string") return send({ error: "bad_request", message: v }, 400);
      if (list.length >= LIMITS.alerts) return send({ error: "bad_request", message: `limit of ${LIMITS.alerts} alerts reached` }, 400);
      if (v.sym) {
        const watched = new Set(list.filter((x) => isActive(x) && x.sym).map((x) => x.sym));
        if (!watched.has(v.sym) && watched.size >= LIMITS.alertSyms) return send({ error: "bad_request", message: `alerts can watch at most ${LIMITS.alertSyms} different symbols` }, 400);
        // the symbol must have a CNBC quote now (the feed the server checks it on)
        const cs = alertCnbcSym(v.sym), q = await loadCnbcQuotes([cs]);
        if (!q.data || !q.data[cs]) return send({ error: "bad_request", message: `no CNBC quote for ${v.sym}${q.err && q.err !== "no_data" ? " (" + q.err + ")" : ""}` }, 400);
        v.name = q.data[cs].name || null;
      }
      const a = { id: crypto.randomUUID(), ...v, created: iso(Date.now()), hit: null };
      await save(env, kind, [...list, a]); return send({ added: a.id, alerts: [...list, a] }, 201);
    }
  }
  if (kind === "notes") {
    if ((method === "POST" && !sub) || (method === "PUT" && !sub)) {
      const p = await body(); if (p.e) return p.e;
      const v = validateNote(p.b); if (typeof v === "string") return send({ error: "bad_request", message: v }, 400);
      if (method === "PUT") {
        const n = list.find((x) => x.id === id); if (!n) return send({ error: "not_found" }, 404);
        Object.assign(n, v, { updated: iso(Date.now()) }); await save(env, kind, list); return send({ notes: list });
      }
      if (list.length >= LIMITS.notes) return send({ error: "bad_request", message: `limit of ${LIMITS.notes} notes reached` }, 400);
      const n = { id: crypto.randomUUID(), ...v, created: iso(Date.now()), updated: null };
      await save(env, kind, [n, ...list]); return send({ added: n.id, notes: [n, ...list] }, 201);
    }
  }
  return send({ error: "method_not_allowed" }, 405);
}

// ---------- SYS ----------
// configured = the secret exists in the Worker (a yes/no only: values are never read out, returned or logged)
export function sourcesStatus(env) {
  return [
    { id: "twelvedata", name: "Twelve Data", use: "quotes, intraday and daily history, market state", configured: !!env.TWELVEDATA_KEY },
    { id: "alpaca", name: "Alpaca", use: "U.S. consolidated daily bars, trades, crypto, options (indicative)", configured: !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) },
    { id: "finnhub", name: "Finnhub", use: "earnings calendar (ERN)", configured: !!finnhubKey(env) },
    { id: "eia", name: "U.S. EIA", use: "energy spot prices and futures curves (CMDTY, FCRV)", configured: !!env.EIA_KEY },
    { id: "fred", name: "FRED (St. Louis Fed)", use: "U.S. Treasury curve, inflation expectations, credit spreads (YLD, BOND)", configured: !!env.FRED_KEY },
    { id: "sec", name: "SEC EDGAR", use: "filings, company descriptions and fundamentals (DES)", configured: true, note: env.SEC_CONTACT ? "no key needed; contact set for SEC fair access" : "no key needed (SEC_CONTACT optional)" },
    { id: "telegram", name: "Telegram bot", use: "alerts sent to your chat (ALRT)", configured: !!tgToken(env), note: env.TELEGRAM_BOT_TOKEN && !tgToken(env) ? "TELEGRAM_BOT_TOKEN is set but does not look like a bot token" : undefined },
    { id: "ai", name: "Workers AI", use: "briefing editions", configured: !!env.AI },
    { id: "kv", name: "Workers KV", use: "briefings, portfolio, alerts, notes, boards, calendar archive", configured: !!env.BRIEFS },
    { id: "public", name: "Public sources (no key)", use: "ECB, Bundesbank, Banca d'Italia, NY Fed, BoE, SNB, BoC, Japan MOF, BIS, CFTC, FINRA, Forex Factory, CNBC, Nasdaq, ApeWisdom, press feeds (Reuters sitemap included), iShares, Invesco, SPDR", configured: true },
  ];
}
// Twelve Data's own counter of credits used this minute and today. Each check costs 1 credit, so it runs only when
// asked (?usage=1) and at most every 5 minutes; otherwise the last check is shown with its time.
const USAGE_KEY = "sys/td-usage", USAGE_TTL = 5 * 60_000;
export async function handleStatus(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  let usage = { status: "N/A", error: "not_configured" }, credits = 0;
  if (env.TWELVEDATA_KEY && url.searchParams.get("usage") === "1") {
    const r = await cachedSource({ origin: url.origin, key: USAGE_KEY, ttlMs: USAGE_TTL, staleMaxMs: 3600_000, ctx, failTtlMs: 60_000,
      load: async () => {
        const f = await fetchText("https://api.twelvedata.com/api_usage", { timeoutMs: 6000, headers: { Authorization: `apikey ${env.TWELVEDATA_KEY}`, accept: "application/json" } });
        let j = null; if (!f.err) try { j = JSON.parse(f.text); } catch { j = null; }
        if (!j || !Number.isFinite(Number(j.current_usage))) return { err: f.err || "provider_error" };
        return { data: { minute: { used: Number(j.current_usage), limit: Number(j.plan_limit) || null }, day: Number.isFinite(Number(j.daily_usage)) ? { used: Number(j.daily_usage), limit: Number(j.plan_daily_limit) || null } : null, plan: j.plan_category || null } };
      } });
    if (r.cache === "MISS") credits = 1;
    usage = r.data ? { ...r.data, fetchedAt: iso(r.fetchedAt), status: r.cache === "STALE" ? "STALE" : "LIVE" } : { status: "N/A", error: r.err };
  } else if (env.TWELVEDATA_KEY) {
    const e = await cacheRead(url.origin, USAGE_KEY, ctx);
    usage = e && e.data ? { ...e.data, fetchedAt: iso(e.fetchedAt), status: Date.now() - e.fetchedAt < USAGE_TTL ? "LIVE" : "STALE" } : { status: "N/A", error: "not_checked" };
  }
  let cron = null, issues = [], alog = null; if (env.BRIEFS) try { const [t, i, l] = await Promise.all([env.BRIEFS.get("cron/last"), env.BRIEFS.get("cron/issues"), env.BRIEFS.get(LOG_KEY)]); cron = t ? JSON.parse(t) : null; issues = i ? JSON.parse(i) : []; alog = l ? JSON.parse(l) : null; } catch { cron = null; }
  return send({ sources: sourcesStatus(env), twelvedata: usage, credits, scheduler: { lastRun: cron, issues, schedule: "Cron Triggers: every minute 05:00–07:59 and 20:00–21:59 UTC; each edition is written at its time" },
    alerts: { lastRecorded: alog && alog.run ? alog.run : null, schedule: "every 5 minutes; recorded when an alert fires and once an hour" }, serverTime: iso(Date.now()) });
}
