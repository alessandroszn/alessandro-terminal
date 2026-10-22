// THE PUBLIC REPLAY — what a visitor without access to the terminal sees at /terminal/ (landing page) and
// /terminal/replay/: the real terminal page playing a script of commands by itself (public/terminal/replay/player.js),
// its /api requests answered from a RECORDING OF OFFICIAL SOURCES ONLY — central banks, the BIS, the U.S. Treasury,
// FRED (Federal Reserve data), the CFTC, the BLS and the BEA. No market data from licensed or commercial providers
// (Twelve Data, CNBC, Nasdaq, Alpaca, Finnhub, Forex Factory, ICE BofA, …) is ever recorded.
//
// How a recording is made (only by the owner, signed in through Cloudflare Access):
//   1. the owner's terminal opens a hidden copy of the replay with ?rec=1: the same script against the live /api; it
//      notes every /api request the windows make;
//   2. POST /api/user/recording/take {rid, i, path}: this Worker re-reads that route itself (never a body sent by the
//      page), keeps it only if the route is on REPLAY_ROUTES, filters it with that route's rule (countries, series,
//      fields) and keeps the part a day in KV (rec/p/<rid>/<i>);
//   3. POST /api/user/recording/commit {rid, n}: the parts become the recording (rec/current) and its summary (rec/meta).
//   GET /api/user/recording → the summary (when, how many answers, size).
// Public, no sign-in:
//   GET /terminal/replay/                → the terminal page (from the static assets) with the player loaded first
//   GET /terminal/replay/recording.json  → the recording
// The recording is labelled with its date everywhere it is shown; the replay never presents it as live.

export const REC_KEYS = { current: "rec/current", meta: "rec/meta", part: (rid, i) => `rec/p/${rid}/${i}` };
const PART_TTL_S = 86400;
export const REC_MAX_PARTS = 60;
const REC_MAX_PART_BYTES = 2_000_000;

// yield curves published by an official body but made of third-party data (Portugal: LSEG; New Zealand: NZFMA;
// Malaysia: Bursa Malaysia Bonds) or needing permission for products (ChinaBond): never in the public recording
export const NOT_PUBLIC_CURVES = new Set(["CN", "PT", "NZ", "MY"]);
// FRED series that are licensed indices (ICE BofA) or a private survey (Freddie Mac): not public here
export const NOT_PUBLIC_FRED = /^(BAML|MORTGAGE)/;

const keep = (b) => b;
const dropKeys = (o, set) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([k]) => !set.has(k))) : o);
// /api/yields (all curves, ?ids=, the catalog): the official curves minus NOT_PUBLIC_CURVES, also as spread partners
function yieldsRule(b) {
  const out = { ...b };
  if (b.curves) out.curves = Object.fromEntries(Object.entries(b.curves).filter(([id]) => !NOT_PUBLIC_CURVES.has(id)).map(([id, c]) => [id, c && c.spreads ? { ...c, spreads: dropKeys(c.spreads, NOT_PUBLIC_CURVES) } : c]));
  if (b.errors) out.errors = dropKeys(b.errors, NOT_PUBLIC_CURVES);
  if (Array.isArray(b.catalog)) out.catalog = b.catalog.filter((c) => !NOT_PUBLIC_CURVES.has(c && c.id));
  return out;
}
// /api/bonds: the same curves; FRED without the ICE BofA indices and the mortgage survey
function bondsRule(b) {
  const out = { ...b };
  if (Array.isArray(b.countries)) out.countries = b.countries.filter((c) => !NOT_PUBLIC_CURVES.has(c && c.id));
  if (Array.isArray(b.spreads)) out.spreads = b.spreads.filter((s) => !NOT_PUBLIC_CURVES.has(s && s.id));
  if (b.fred && Array.isArray(b.fred.groups)) out.fred = { ...b.fred, groups: b.fred.groups.map((g) => ({ ...g, rows: (g.rows || []).filter((r) => !NOT_PUBLIC_FRED.test(String(r && r.id))) })).filter((g) => g.rows.length) };
  return out;
}
// /api/calendar: the U.S. official release schedules (BLS, BEA) only — the world calendar (Forex Factory, Nasdaq) is not public
function calendarRule(b) {
  const official = new Set(["BLS", "BEA"]);
  return { events: (b.events || []).filter((e) => official.has(e && e.source)), world: [], backDays: b.backDays, sources: (b.sources || []).filter((s) => official.has(s && s.id)), errors: dropKeys(b.errors || {}, new Set(["FF", "NQ"])),
    fields: { actual: "N/A — not in this public recording", forecast: "N/A — no licensed consensus source", impact: "N/A", reaction: "N/A — not in this public recording" }, worldBackup: null, meta: b.meta };
}
// /api/cb: the ECB, the New York Fed, the Bank of England, the SNB and the Bank of Canada as each publishes
const cbRule = (b) => ({ ...b, note: "Policy rates as published by each central bank, with their dates." });

// route → rule. Anything not listed here is never recorded (the replay answers it "not in this recording").
export const REPLAY_ROUTES = {
  "/api/cb": cbRule,                // official policy rates (see macro.mjs)
  "/api/cb/world": keep,            // BIS WS_CBPOL + each bank's published calendar of decisions (cbworld.mjs)
  "/api/cb/history": keep,          // BIS, end of month
  "/api/yields": yieldsRule,        // official curves (yields.mjs)
  "/api/yields/catalog": yieldsRule,
  "/api/yields/history": keep,      // one official curve's tenor over time (the country is checked in recordable)
  "/api/bonds": bondsRule,          // official curves + FRED (Federal Reserve, Treasury, New York Fed series)
  "/api/sprd": keep,                // ECB AAA spot curve, FRED H.15
  "/api/cot": keep,                 // CFTC Commitments of Traders
  "/api/calendar": calendarRule,    // BLS, BEA schedules
};

// a path the replay may record: a listed route, GET-style query only, and not one of the curves kept private
export function recordable(path) {
  if (typeof path !== "string" || path.length > 400 || !path.startsWith("/api/")) return null;
  let u; try { u = new URL(path, "https://x.invalid"); } catch { return null; }
  if (u.origin !== "https://x.invalid" || !REPLAY_ROUTES[u.pathname]) return null;
  if (u.pathname === "/api/yields/history" && NOT_PUBLIC_CURVES.has(String(u.searchParams.get("id") || "").toUpperCase())) return null;
  return u.pathname + u.search;
}
export function sanitizeRecorded(path, body) {
  const p = recordable(path); if (!p || !body || typeof body !== "object") return null;
  return REPLAY_ROUTES[new URL(p, "https://x.invalid").pathname](body);
}

// ---------- the owner's side (behind Access): take one route, commit, read the summary ----------
// appFetch: the Worker's own router (worker.mjs app.fetch), so a recorded answer is exactly what /api returns
export async function handleRecording(url, env, ctx, H, json, req, appFetch) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "storage_not_configured", status: "N/A" }, 503);
  const sub = url.pathname.replace(/^\/api\/user\/recording\/?/, ""), method = req ? req.method : "GET";
  if (!sub && method === "GET") { let meta = null; try { meta = JSON.parse((await env.BRIEFS.get(REC_KEYS.meta)) || "null"); } catch { meta = null; } return send({ meta, routes: Object.keys(REPLAY_ROUTES) }); }
  if (method !== "POST" || !["take", "commit"].includes(sub)) return send({ error: "not found" }, 404);
  const origin = req.headers.get("origin");
  if (origin && origin !== (env.ALLOWED_ORIGIN || url.origin)) return send({ error: "forbidden_origin" }, 403);
  if (!/^application\/json/i.test(req.headers.get("content-type") || "")) return send({ error: "bad_request", message: "JSON body required" }, 415);
  let b; try { b = await req.json(); } catch { return send({ error: "bad_request", message: "invalid JSON" }, 400); }
  const rid = String((b && b.rid) || ""), i = Number(b && b.i);
  if (!/^[a-z0-9]{6,16}$/.test(rid)) return send({ error: "bad_request", message: "rid" }, 400);
  if (sub === "take") {
    if (!Number.isInteger(i) || i < 0 || i >= REC_MAX_PARTS) return send({ error: "bad_request", message: "i" }, 400);
    const path = recordable(b.path);
    if (!path) return send({ skipped: "not_official", path: String(b.path || "").slice(0, 200) });
    let r; try { r = await appFetch(new Request(url.origin + path, { method: "GET" }), env, ctx); } catch { return send({ skipped: "provider_error", path }); }
    // an answer that failed at the time is not kept: the replay then says "not in this recording" rather than an error
    if (!r.ok) return send({ skipped: "no_data", path, status: r.status });
    let body = null; try { body = await r.json(); } catch { body = null; }
    const clean = body && sanitizeRecorded(path, body);
    if (!clean) return send({ skipped: "no_data", path });
    const text = JSON.stringify({ path, s: r.status, at: new Date().toISOString(), b: clean });
    if (text.length > REC_MAX_PART_BYTES) return send({ skipped: "too_large", path });
    await env.BRIEFS.put(REC_KEYS.part(rid, i), text, { expirationTtl: PART_TTL_S });
    return send({ ok: true, path, status: r.status, bytes: text.length });
  }
  // commit: the parts 0 … n-1 of this rid (missing ones skipped), one JSON assembled as text
  const n = Number(b && b.n);
  if (!Number.isInteger(n) || n < 1 || n > REC_MAX_PARTS) return send({ error: "bad_request", message: "n" }, 400);
  const texts = await Promise.all(Array.from({ length: n }, (_, k) => env.BRIEFS.get(REC_KEYS.part(rid, k))));
  const parts = [];
  for (const t of texts) { if (!t) continue; try { const p = JSON.parse(t); if (p && recordable(p.path) === p.path) parts.push(p); } catch { /* a broken part is left out */ } }
  if (!parts.length) return send({ error: "no_data", message: "no part of this recording was kept" }, 409);
  const ats = parts.map((p) => p.at).sort(), at = new Date().toISOString();
  const rec = { v: 1, t0: ats[0], at, n: parts.length, sources: "official sources only: central banks, BIS, U.S. Treasury, FRED, CFTC, BLS, BEA", r: Object.fromEntries(parts.map((p) => [p.path, { s: p.s, b: p.b }])) };
  const text = JSON.stringify(rec), meta = { t0: rec.t0, at, n: rec.n, bytes: text.length, paths: parts.map((p) => p.path.split("?")[0]).filter((x, k, a) => a.indexOf(x) === k) };
  await env.BRIEFS.put(REC_KEYS.current, text);
  await env.BRIEFS.put(REC_KEYS.meta, JSON.stringify(meta));
  return send({ ok: true, meta });
}

// ---------- the public side ----------
// the terminal page with the recording's summary and the player in front of every other script
export function injectReplay(html, meta) {
  const m = meta ? { t0: meta.t0, at: meta.at, n: meta.n } : null;
  const tag = `<head>\n<script>window.AZ_REC=${JSON.stringify(m).replace(/</g, "\\u003c")};</script>\n<script src="/terminal/replay/player.js"></script>`;
  const i = html.indexOf("<head>");
  return i < 0 ? null : html.slice(0, i) + tag + html.slice(i + "<head>".length);
}
const PUBLIC_HEADERS = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "same-origin", "x-content-type-options": "nosniff" };
export async function handleReplayPublic(url, env, req) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: PUBLIC_HEADERS });
  if (url.pathname === "/terminal/replay") return new Response(null, { status: 301, headers: { ...PUBLIC_HEADERS, location: "/terminal/replay/" } });
  if (url.pathname === "/terminal/replay/recording.json") {
    const text = env.BRIEFS ? await env.BRIEFS.get(REC_KEYS.current) : null;
    if (!text) return new Response(JSON.stringify({ error: "no_recording" }), { status: 404, headers: { ...PUBLIC_HEADERS, "content-type": "application/json", "cache-control": "no-store" } });
    return new Response(text, { headers: { ...PUBLIC_HEADERS, "content-type": "application/json", "cache-control": "public, max-age=300" } });
  }
  if (url.pathname !== "/terminal/replay/" && url.pathname !== "/terminal/replay/index.html") return new Response("not found", { status: 404, headers: PUBLIC_HEADERS });
  if (!env.ASSETS) return new Response("not available", { status: 503, headers: PUBLIC_HEADERS });
  const [page, metaText] = await Promise.all([env.ASSETS.fetch(new Request(url.origin + "/terminal/desk/")), env.BRIEFS ? env.BRIEFS.get(REC_KEYS.meta) : null]);
  if (!page.ok) return new Response("not available", { status: 503, headers: PUBLIC_HEADERS });
  let meta = null; try { meta = JSON.parse(metaText || "null"); } catch { meta = null; }
  const html = injectReplay(await page.text(), meta);
  if (!html) return new Response("not available", { status: 503, headers: PUBLIC_HEADERS });
  return new Response(html, { headers: { ...PUBLIC_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": "frame-ancestors 'self'" } });
}
