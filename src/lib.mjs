// Shared helpers for the non-Twelve-Data sources (T05): fetch with timeout, shared cache, CSV.
// Policy: a source either returns real data, or an error code — never a substitute value.

export const UA = "AlessandroTerminal/1.0 (+https://alessandrozanichelli.com/terminal)";

export async function fetchText(url, { timeoutMs = 8000, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": UA, ...headers } });
    const text = await r.text();
    if (r.status === 429) return { err: "rate_limited", http: r.status };
    if (r.status === 403) return { err: "provider_forbidden", http: r.status };
    if (r.status === 404) return { err: "no_data", http: r.status };
    if (!r.ok) return { err: "provider_error", http: r.status };
    if (!text || !text.trim()) return { err: "provider_error", http: r.status };
    return { text, http: r.status };
  } catch {
    return { err: ac.signal.aborted ? "provider_timeout" : "provider_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function cacheStore() { return typeof caches !== "undefined" ? caches.default : null; }
export async function cacheRead(origin, key) {
  const c = cacheStore(); if (!c) return null;
  const r = await c.match(new Request(`${origin}/__cache/${key}`));
  if (!r) return null;
  try { return await r.json(); } catch { return null; }
}
export function cacheWrite(origin, key, obj, ctx, maxAgeSec = 7 * 86400) {
  const c = cacheStore(); if (!c) return;
  const p = c.put(new Request(`${origin}/__cache/${key}`), new Response(JSON.stringify(obj), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAgeSec}` } }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

// fresh entry → HIT; else load() → MISS; load failed → last real entry as STALE (bounded); else error.
export async function cachedSource({ origin, key, ttlMs, staleMaxMs, ctx, load, now = Date.now() }) {
  const e = await cacheRead(origin, key);
  if (e && e.data && now - e.fetchedAt < ttlMs) return { data: e.data, fetchedAt: e.fetchedAt, cache: "HIT" };
  const r = await load();
  if (r && r.data) {
    const fetchedAt = Date.now();
    cacheWrite(origin, key, { data: r.data, fetchedAt }, ctx);
    return { data: r.data, fetchedAt, cache: "MISS" };
  }
  const err = (r && r.err) || "provider_error";
  if (e && e.data && now - e.fetchedAt < staleMaxMs) return { data: e.data, fetchedAt: e.fetchedAt, cache: "STALE", staleReason: err };
  return { err, cache: "MISS" };
}

// RFC-4180-ish CSV (quoted fields, escaped quotes, CRLF)
export function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += ch;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

export const iso = (t) => new Date(t).toISOString();
export const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// today's date at the US exchange ("YYYY-MM-DD")
export function easternDate(now = new Date()) { return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
export function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }

// wall-clock time in New York → UTC instant (handles EST/EDT)
export function easternToUtc(y, mo, d, h, mi) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, mi);
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const hh = parts.hour === "24" ? 0 : Number(parts.hour);
    if (Number(parts.year) === y && Number(parts.month) === mo && Number(parts.day) === d && hh === h && Number(parts.minute) === mi) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5, mi);
}
