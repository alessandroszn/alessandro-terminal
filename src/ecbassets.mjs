// ECB LIST — the Eurosystem's list of eligible marketable assets (approved 22 Oct 2026): the bonds the ECB accepts as
// collateral, each with its ISIN, coupon, issue and maturity dates, currency and issuer — the terms of a bond (reference
// data), never a price. Published Monday to Friday around 18:15 CET as one tab-separated file of several MB
// (ea_csv_YYMMDD.csv). The free plan's CPU budget (10 ms a run) does not parse it in one go, so the PERF_CRON trigger
// reads it a slice at a time (a Range request; or the stream read up to the slice when the server sends the whole file)
// and keeps the fixed-coupon and zero-coupon bonds in a compact table (KV bond/ecb: one line a bond), about a dozen runs
// once a new file is out; the rest of the slots go to the ETF screener.
//   bond/ecb        "#ECB\t<file date>\t<bonds>\t<read at>" then  ISIN coupon issue maturity ccy residence group Z|F type issuer
//   bond/ecb-state  where the read is (file, offset, columns)        bond/ecb-next  the bonds read so far (2 days)
// Read by /api/bond/ref (yas.mjs: the ECB list first, OpenFIGI second), /api/bond/list and the bond lines of PLAB.
import { UA } from "./lib.mjs";

export const ECB_EA_URL = "https://www.ecb.europa.eu/paym/coll/assets/html/dla/ea_MID/";
export const ECB_EA_PAGE = "https://www.ecb.europa.eu/paym/coll/assets/html/list-MID.en.html";
export const EA_KEY = "bond/ecb", EA_STATE = "bond/ecb-state", EA_NEXT = "bond/ecb-next";
export const EA_SLICE = 786432; // 768 KB a run
export const EA_COLS = ["isin", "coupon", "issue", "maturity", "ccy", "residence", "group", "kind", "type", "issuer"];
const HOUR = 3600_000, DAY = 86400_000;
const HEAD = { isin: "ISIN_CODE", type: "TYPE", ccy: "DENOMINATION", issue: "ISSUANCE_DATE", maturity: "MATURITY_DATE", coupon: "COUPON_RATE (%)", issuer: "ISSUER_NAME", residence: "ISSUER_RESIDENCE", group: "ISSUER_GROUP", cd: "COUPON_DEFINITION" };
// the coupon definitions kept: CD1 zero coupon, CD4 fixed (CD2 variable and the others need an index: not priced here)
const KEEP_CD = { CD1: "Z", CD4: "F" };
export const ISSUER_GROUPS = { IG1: "Central bank", IG2: "Central government", IG3: "Corporate", IG4: "Credit institution", IG5: "Regional / local government", IG6: "Supranational", IG7: "Agency", IG8: "Multilateral development bank" };
export const ASSET_TYPES = { AT01: "Bond", AT02: "Medium-term note", AT03: "Commercial paper / bill" };

const yymmdd = (t) => new Date(t).toISOString().slice(2, 10).replace(/-/g, "");
export const eaFileUrl = (f) => `${ECB_EA_URL}ea_csv_${f}.csv`;
// the files a run looks for, newest first: weekdays whose 18:00 UTC is past (the ECB publishes around 16:15–17:15 UTC)
export function eaCandidates(now, n = 4) {
  const out = []; let t = now - 18 * HOUR;
  while (out.length < n) { const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(yymmdd(t)); t -= DAY; }
  return out;
}
// "21/10/2026 00:00:00" → "2026-10-21"
export function dmy(s) { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || "").trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }
const unq = (s) => { const t = String(s == null ? "" : s).trim(); return t.length > 1 && t[0] === '"' && t[t.length - 1] === '"' ? t.slice(1, -1).trim() : t; };
export function eaColumns(headerLine) {
  const h = String(headerLine || "").replace(/^﻿/, "").replace(/\r$/, "").split("\t").map((x) => unq(x).toUpperCase()), c = {};
  for (const [k, name] of Object.entries(HEAD)) { const i = h.indexOf(name); if (i < 0) return null; c[k] = i; }
  return c;
}
// one line of the ECB file → one line of the table, or null (not fixed / zero, no maturity, a malformed ISIN)
export function eaRow(line, c) {
  if (!/\tCD[14]\b/.test(line)) return null;
  const f = line.replace(/\r$/, "").split("\t"), kind = KEEP_CD[unq(f[c.cd])]; if (!kind) return null;
  const isin = unq(f[c.isin]).toUpperCase(); if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return null;
  const maturity = dmy(unq(f[c.maturity])); if (!maturity) return null;
  const cp = kind === "Z" ? 0 : Number(unq(f[c.coupon]).replace(",", ".")); if (!Number.isFinite(cp) || cp < -5 || cp > 50) return null;
  const clean = (s, n) => unq(s).replace(/[\t\n]/g, " ").slice(0, n);
  return [isin, String(Math.round(cp * 1e6) / 1e6), dmy(unq(f[c.issue])) || "", maturity, clean(f[c.ccy], 3).toUpperCase(), clean(f[c.residence], 2).toUpperCase(), clean(f[c.group], 4), kind, clean(f[c.type], 4), clean(f[c.issuer], 48)].join("\t");
}
// a slice of bytes: the response to a Range request (206), or the whole file (200) read up to the slice and then stopped
export async function readSlice(res, off, len) {
  if (res.status === 206) {
    const buf = new Uint8Array(await res.arrayBuffer()), m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
    return { buf, total: m ? Number(m[1]) : null };
  }
  const rd = res.body.getReader(), out = new Uint8Array(len); let pos = 0, got = 0, end = false;
  while (got < len) {
    const { value, done } = await rd.read(); if (done) { end = true; break; }
    const a = Math.max(0, off - pos), b = Math.min(value.length, off + len - pos);
    if (b > a) { out.set(value.subarray(a, b), got); got += b - a; }
    pos += value.length;
  }
  if (!end) { try { await rd.cancel(); } catch { /* the rest of the file is not needed */ } }
  return { buf: out.subarray(0, got), total: end ? pos : null };
}
const getJ = async (env, k) => { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : null; } catch { return null; } };
async function fetchSlice(url, off, len, fetchImpl) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetchImpl(url, { signal: ac.signal, headers: { "user-agent": UA, range: `bytes=${off}-${off + len - 1}`, "accept-encoding": "identity" } });
    if (r.status === 404) return { err: "no_file" };
    if (r.status === 416) return { buf: new Uint8Array(0), total: off };
    if (r.status !== 200 && r.status !== 206) return { err: "provider_error", http: r.status };
    return await readSlice(r, off, len);
  } catch { return { err: "provider_error" }; } finally { clearTimeout(timer); }
}

// one step of the read: { ran: false } when there is nothing to do (the slot then goes to the ETF screener)
export async function stepEcbList(env, now = Date.now(), deps = {}) {
  if (!env.BRIEFS) return { ran: false, skipped: "no_kv" };
  const fetchImpl = deps.fetch || fetch;
  let st = (await getJ(env, EA_STATE)) || {};
  if (!st.reading) {
    if (st.next && now < st.next) return { ran: false };
    // the newest file out; nothing new when it is the one already in the table
    let file = null, first = null;
    for (const f of eaCandidates(now)) {
      if (f === st.done) break;
      const s = await fetchSlice(eaFileUrl(f), 0, EA_SLICE, fetchImpl);
      if (s.err === "no_file") continue;
      if (s.err) { await env.BRIEFS.put(EA_STATE, JSON.stringify({ ...st, next: now + HOUR, error: s.err })); return { ran: true, error: s.err }; }
      file = f; first = s; break;
    }
    if (!file) { await env.BRIEFS.put(EA_STATE, JSON.stringify({ ...st, next: now + 3 * HOUR, error: null })); return { ran: false, upToDate: st.done || null }; }
    st = { done: st.done || null, reading: file, offset: 0, rows: 0, started: now };
    return ingest(env, st, first, now, true);
  }
  const s = await fetchSlice(eaFileUrl(st.reading), st.offset, EA_SLICE, fetchImpl);
  if (s.err === "no_file") { await env.BRIEFS.put(EA_STATE, JSON.stringify({ done: st.done || null, next: 0 })); return { ran: true, error: "file_gone" }; }
  if (s.err) { await env.BRIEFS.put(EA_STATE, JSON.stringify({ ...st, error: s.err, failures: (st.failures || 0) + 1, ...(st.failures >= 5 ? { reading: null, next: now + 6 * HOUR } : {}) })); return { ran: true, error: s.err }; }
  return ingest(env, st, s, now, false);
}
async function ingest(env, st, s, now, fresh) {
  const buf = s.buf, last = st.offset + buf.length >= (s.total == null ? Infinity : s.total) || buf.length < EA_SLICE;
  let cut = buf.length; if (!last) { cut = buf.lastIndexOf(10) + 1; if (cut <= 0) return { ran: true, error: "line_too_long" }; }
  const lines = new TextDecoder("utf-8").decode(buf.subarray(0, cut)).split("\n");
  let i = 0;
  if (st.offset === 0) { const c = eaColumns(lines[0]); if (!c) { await env.BRIEFS.put(EA_STATE, JSON.stringify({ done: st.done || null, next: now + 6 * HOUR, error: "unknown_columns" })); return { ran: true, error: "unknown_columns" }; } st.cols = c; i = 1; }
  const out = []; for (; i < lines.length; i++) { if (!lines[i]) continue; const r = eaRow(lines[i], st.cols); if (r) out.push(r); }
  const prev = fresh ? "" : (await env.BRIEFS.get(EA_NEXT)) || "", text = out.length ? (prev ? prev + "\n" : "") + out.join("\n") : prev;
  st.rows += out.length; st.offset += cut; st.failures = 0; st.error = null;
  if (last) {
    const head = ["#ECB", st.reading, st.rows, new Date(now).toISOString()].join("\t");
    await env.BRIEFS.put(EA_KEY, head + (text ? "\n" + text : ""));
    await env.BRIEFS.put(EA_STATE, JSON.stringify({ done: st.reading, rows: st.rows, at: now, next: now + 6 * HOUR }));
    MEMO.t = 0;
    return { ran: true, done: st.reading, rows: st.rows };
  }
  await env.BRIEFS.put(EA_NEXT, text, { expirationTtl: 2 * 86400 });
  await env.BRIEFS.put(EA_STATE, JSON.stringify(st));
  return { ran: true, file: st.reading, offset: st.offset, rows: st.rows };
}

// ---------- reading the table ----------
const MEMO = { t: 0, text: null };
export async function eaTable(env, now = Date.now()) {
  if (MEMO.text != null && now - MEMO.t < HOUR) return MEMO.text;
  const t = env.BRIEFS ? (await env.BRIEFS.get(EA_KEY)) || "" : ""; MEMO.text = t; MEMO.t = now; return t;
}
export const eaResetMemo = () => { MEMO.t = 0; MEMO.text = null; };
export function eaHead(table) {
  const t = String(table || ""); if (!t.startsWith("#ECB\t")) return null;
  const f = t.slice(0, t.indexOf("\n") < 0 ? undefined : t.indexOf("\n")).split("\t"), d = /^(\d{2})(\d{2})(\d{2})$/.exec(f[1] || "");
  return { file: f[1], date: d ? `20${d[1]}-${d[2]}-${d[3]}` : null, rows: Number(f[2]) || 0, readAt: f[3] || null };
}
export function eaParse(line) {
  const f = String(line || "").split("\t"); if (f.length < EA_COLS.length) return null;
  const [isin, coupon, issue, maturity, ccy, residence, group, kind, type, issuer] = f;
  return { isin, coupon: Number(coupon), issue: issue || null, maturity, ccy: ccy || null, residence: residence || null, group: group || null, groupName: ISSUER_GROUPS[group] || null, zero: kind === "Z", type: type || null, typeName: ASSET_TYPES[type] || null, issuer: issuer || null };
}
export function eaLookup(table, isin) {
  const t = String(table || ""), i = t.indexOf("\n" + isin + "\t"); if (i < 0) return null;
  const e = t.indexOf("\n", i + 1); return eaParse(t.slice(i + 1, e < 0 ? undefined : e));
}
// the bonds of one issuer country and group (central government by default), maturing from `from` on, by maturity:
// found by the "<tab>IT<tab>IG2<tab>" of the residence and group columns, without splitting the whole table
export function eaList(table, { cc, group = "IG2", from = "", q = "", limit = 400 } = {}) {
  const t = String(table || ""), out = [], pat = "\t" + cc + "\t" + (group ? group + "\t" : ""), qq = String(q || "").toUpperCase();
  let i = t.indexOf(pat);
  while (i >= 0) {
    const s = t.lastIndexOf("\n", i) + 1, e = t.indexOf("\n", i), line = t.slice(s, e < 0 ? undefined : e);
    i = e < 0 ? -1 : t.indexOf(pat, e);
    const b = eaParse(line); if (!b || b.residence !== cc || (group && b.group !== group)) continue;
    if (from && b.maturity < from) continue;
    if (qq && !line.toUpperCase().includes(qq)) continue;
    out.push(b);
  }
  out.sort((a, b) => (a.maturity < b.maturity ? -1 : a.maturity > b.maturity ? 1 : a.isin < b.isin ? -1 : 1));
  return { bonds: out.slice(0, limit), total: out.length };
}
