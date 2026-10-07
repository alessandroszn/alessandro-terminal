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

// binary download (e.g. an .xlsx holdings file); same error codes as fetchText
export async function fetchBinary(url, { timeoutMs = 10000, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": UA, ...headers } });
    const buf = await r.arrayBuffer();
    if (r.status === 429) return { err: "rate_limited", http: r.status };
    if (r.status === 403) return { err: "provider_forbidden", http: r.status };
    if (r.status === 404) return { err: "no_data", http: r.status };
    if (!r.ok || !buf.byteLength) return { err: "provider_error", http: r.status };
    return { buf, http: r.status };
  } catch {
    return { err: ac.signal.aborted ? "provider_timeout" : "provider_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// one file out of a ZIP archive (an .xlsx is a ZIP of XML files): stored or deflated entries
export async function unzipEntry(buf, name) {
  const dv = new DataView(buf), n = buf.byteLength;
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    if (dec.decode(new Uint8Array(buf, p + 46, nlen)) === name) {
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = new Uint8Array(buf, start, csize);
      if (method === 0) return dec.decode(data);
      if (method === 8) return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
      return null;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

// first worksheet of an .xlsx as rows of cell strings (shared strings, inline strings, numbers)
export async function xlsxRows(buf) {
  const [ss, sheet] = await Promise.all([unzipEntry(buf, "xl/sharedStrings.xml"), unzipEntry(buf, "xl/worksheets/sheet1.xml")]);
  if (!sheet) return [];
  const unxml = (t) => t.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const strings = ss ? [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""))) : [];
  const col = (ref) => { let c = 0; for (const ch of ref.replace(/\d+$/, "")) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };
  const rows = [];
  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[2] || "", inner = cm[3] || "", t = (/t="(\w+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      row[col(cm[1])] = t === "s" ? strings[Number(v)] ?? "" : t === "inlineStr" ? unxml((/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner) || [])[1] || "") : v != null ? unxml(v) : "";
    }
    rows.push(Array.from(row, (x) => x ?? ""));
  }
  return rows;
}

function cacheStore() { return typeof caches !== "undefined" ? caches.default : null; }
// Scheduled runs (Cron Trigger) execute in any data center, so they cannot share the per-location
// Cache API: they pass a ctx whose `store` is Workers KV instead (see cron.mjs). `readOnly` serves only
// what was staged and never calls a source.
export function kvStore(kv, prefix = "stage/") {
  return {
    async get(key) { try { const t = await kv.get(prefix + key); return t ? JSON.parse(t) : null; } catch { return null; } },
    put(key, obj, ttlSec) { return kv.put(prefix + key, JSON.stringify(obj), { expirationTtl: Math.max(60, Math.min(ttlSec || 86400, 3 * 86400)) }); },
  };
}
export async function cacheRead(origin, key, ctx) {
  if (ctx && ctx.store) return ctx.store.get(key);
  const c = cacheStore(); if (!c) return null;
  const r = await c.match(new Request(`${origin}/__cache/${key}`));
  if (!r) return null;
  try { return await r.json(); } catch { return null; }
}
export function cacheWrite(origin, key, obj, ctx, maxAgeSec = 7 * 86400) {
  if (ctx && ctx.store) { const p = ctx.store.put(key, obj, maxAgeSec); if (ctx.waitUntil) ctx.waitUntil(p); return p; }
  const c = cacheStore(); if (!c) return;
  const p = c.put(new Request(`${origin}/__cache/${key}`), new Response(JSON.stringify(obj), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAgeSec}` } }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

// fresh entry → HIT; else load() → MISS; load failed → last real entry as STALE (bounded); else error.
// failTtlMs: after a failure, report the same error for this long instead of waiting on the source again
export async function cachedSource({ origin, key, ttlMs, staleMaxMs, ctx, load, failTtlMs = 0, now = Date.now() }) {
  const e = await cacheRead(origin, key, ctx);
  if (e && e.data && now - e.fetchedAt < ttlMs) return { data: e.data, fetchedAt: e.fetchedAt, cache: "HIT" };
  if (ctx && ctx.readOnly) return e && e.data && now - e.fetchedAt < staleMaxMs ? { data: e.data, fetchedAt: e.fetchedAt, cache: "STALE", staleReason: "not_refreshed" } : { err: "not_staged", cache: "MISS" };
  if (ctx && ctx.store) failTtlMs = 0; // scheduled runs: no failure memo (it would cost KV writes)
  const f = failTtlMs ? await cacheRead(origin, key + "@fail") : null;
  const recentFail = f && now - f.at < failTtlMs;
  const r = recentFail ? { err: f.err } : await load();
  if (!recentFail && r && !r.data && failTtlMs) cacheWrite(origin, key + "@fail", { err: r.err || "provider_error", at: Date.now() }, ctx, Math.ceil(failTtlMs / 1000));
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
