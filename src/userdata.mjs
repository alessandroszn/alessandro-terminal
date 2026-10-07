// MY STUFF (T07) — the owner's own lists, stored on the server (Workers KV, binding BRIEFS), private behind Access.
//   GET|POST|DELETE  /api/user/alerts          price alerts {sym, op ">="|"<=", price, note}; checked in the page
//   POST             /api/user/alerts/hit?id   the page records when an alert fired, with the live price it saw
//   GET|POST|PUT|DELETE /api/user/notes        notes {text, sym?}
//   GET|PUT          /api/user/board           custom boards [{id, name, syms[]}]
//   GET              /api/status[?usage=1]     system status for SYS: which sources are configured (yes/no only),
//                                              Twelve Data credit usage (checked on request: 1 credit), the scheduler's last run
// Nothing here is market data: these are the owner's own entries. All start empty.
import { finnhubKey } from "./earnings.mjs";
import { fetchText, iso, cachedSource, cacheRead } from "./lib.mjs";

export const UD_KEYS = { alerts: "ud/alerts", notes: "ud/notes", board: "ud/board" };
// quotes cost Twelve Data credits (8 a minute on the free plan): a board, like the watchlist, holds at most 12 symbols,
// and live alerts watch at most 10 different symbols
export const LIMITS = { alerts: 100, alertSyms: 10, notes: 300, boards: 20, boardSyms: 12, noteLen: 4000 };
const SYM_RE = /^[A-Z0-9][A-Z0-9.\-:/]{0,19}$/;

async function load(env, k) { try { const t = await env.BRIEFS.get(UD_KEYS[k]); const a = t ? JSON.parse(t) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
const save = (env, k, v) => env.BRIEFS.put(UD_KEYS[k], JSON.stringify(v));
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

export function validateAlert(b) {
  if (!b || typeof b !== "object") return "body required";
  const sym = clean(b.sym, 20).toUpperCase();
  if (!SYM_RE.test(sym)) return "symbol required";
  if (b.op !== ">=" && b.op !== "<=") return "op must be >= or <=";
  const price = Number(b.price);
  if (!Number.isFinite(price) || price <= 0) return "price must be a positive number";
  return { sym, op: b.op, price, note: clean(b.note, 200) };
}
export function validateNote(b) {
  if (!b || typeof b !== "object") return "body required";
  const text = clean(b.text, LIMITS.noteLen);
  if (!text) return "text required";
  const sym = b.sym ? clean(b.sym, 20).toUpperCase() : "";
  if (sym && !SYM_RE.test(sym)) return "bad symbol";
  return { text, sym: sym || null };
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
  const list = await load(env, kind);
  if (method === "DELETE" && !sub) {
    const rest = list.filter((x) => x.id !== id);
    if (rest.length === list.length) return send({ error: "not_found" }, 404);
    await save(env, kind, rest); return send({ removed: id, [kind]: rest });
  }
  if (kind === "alerts") {
    if (method === "POST" && sub === "hit") {
      const p = await body(); if (p.e) return p.e;
      const a = list.find((x) => x.id === id); if (!a) return send({ error: "not_found" }, 404);
      const price = Number(p.b && p.b.price); if (!Number.isFinite(price) || price <= 0) return send({ error: "bad_request", message: "price required" }, 400);
      if (!a.hit) { a.hit = { at: iso(Date.now()), price, source: clean(p.b.source, 40) || null }; await save(env, kind, list); }
      return send({ alerts: list });
    }
    if (method === "POST" && !sub) {
      const p = await body(); if (p.e) return p.e;
      const v = validateAlert(p.b); if (typeof v === "string") return send({ error: "bad_request", message: v }, 400);
      if (list.length >= LIMITS.alerts) return send({ error: "bad_request", message: `limit of ${LIMITS.alerts} alerts reached` }, 400);
      const watched = new Set(list.filter((x) => !x.hit).map((x) => x.sym));
      if (!watched.has(v.sym) && watched.size >= LIMITS.alertSyms) return send({ error: "bad_request", message: `live alerts can watch at most ${LIMITS.alertSyms} different symbols (quote credits)` }, 400);
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
    { id: "ai", name: "Workers AI", use: "briefing editions", configured: !!env.AI },
    { id: "kv", name: "Workers KV", use: "briefings, portfolio, alerts, notes, boards, calendar archive", configured: !!env.BRIEFS },
    { id: "public", name: "Public sources (no key)", use: "ECB, Bundesbank, NY Fed, BoE, SNB, BoC, Japan MOF, CFTC, Forex Factory, press feeds, iShares, Invesco, SPDR", configured: true },
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
  let cron = null; if (env.BRIEFS) try { const t = await env.BRIEFS.get("cron/last"); cron = t ? JSON.parse(t) : null; } catch { cron = null; }
  return send({ sources: sourcesStatus(env), twelvedata: usage, credits, scheduler: { lastRun: cron, schedule: "Cron Triggers: every minute 05:00–07:59 and 20:00–21:59 UTC; each edition is written at its time" }, serverTime: iso(Date.now()) });
}
