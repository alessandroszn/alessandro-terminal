// ETF SECTION — every ETF, not a hand-picked list (approved 21 Oct 2026):
//   universe   Deutsche Börse "T7 (Xetra) All tradable instruments" (public CSV, updated each trading day, no key): every
//              ETF / ETN / ETC tradable on Xetra with ISIN, WKN, mnemonic, trading currency and Xetra's product group;
//              U.S. ETFs from Twelve Data's ETF list (/etfs, reference data, no key). Built at most once a day, kept in KV.
//   reference  justETF profile pages (reference data only, never prices): the 5-minute cron reads one fund a run through
//              the whole universe (≈ 10 days a round); the owner's funds (UCITS list, portfolio, profiles opened) first and
//              weekly; a profile opened that was never read is read then. Kept in KV: a compact table for the screener
//              (ref/je/table) and the full record of the owner's funds (ref/je/<ISIN>: + top holdings, countries, sectors).
//   prices     CNBC quote service: each listing CNBC carries (Xetra MNEMONIC-DE and the other venues OpenFIGI / Twelve Data
//              list for the ISIN); returns from CNBC's daily bars; currency conversion at CNBC's FX (DERIVED).
import { fetchText, iso, cachedSource } from "./lib.mjs";
import { loadCnbcRaw, cnbcIntlRec } from "./intl.mjs";
import { cnbcDaily, referenceCloses } from "./cnbc.mjs";
import { isinValid } from "./isin.mjs";
import { UCITS_ETFS, UCITS_CCYS, fxRate, justEtfUrl, parseJustEtf, lineOf, JUSTETF } from "./ucits.mjs";
import { handleSearch } from "./search.mjs";

export const XETRA_URL = "https://www.cashmarket.deutsche-boerse.com/resource/blob/1528/374322c724cea673463bc7c2ceae00bf/data/t7-xetr-allTradableInstruments.csv";
export const XETRA_PAGE = "https://www.cashmarket.deutsche-boerse.com/cash-en/trading/Tradable-Instruments-Xetra/";
export const TD_ETFS_URL = "https://api.twelvedata.com/etfs?country=United%20States";
const K = { uni: "etf/universe", isins: "etf/isins", us: "etf/us", table: "ref/je/table", prio: "ref/je/prio", detail: (i) => `ref/je/${i}` };
const DAY = 86400_000, YEAR = 31_557_600_000, SLOT = 300_000, REFRESH = 7 * DAY, BACKOFF = 6 * 3600_000, KEEP = 45 * 86400;
const put = (env, k, v) => env.BRIEFS.put(k, typeof v === "string" ? v : JSON.stringify(v), { expirationTtl: KEEP });
const getJ = async (env, k) => { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : null; } catch { return null; } };

// ---------- the universe ----------
// Xetra's product groups (German) → what they say about the fund
export const XETRA_GROUP = { "EXCHANGE TRADED FUNDS - PASSIV": "Passive ETF", "EXCHANGE TRADED FUNDS - RENTEN": "Bond ETF", "EXCHANGE TRADED FUNDS - AKTIV": "Active ETF",
  "EXCHANGE TRADED NOTES": "ETN", "EXCHANGE TRADED COMMODITIES": "ETC", "ETF RENTEN - FOREIGN CURRENCY": "Bond ETF" };
// the CSV: two lines of metadata ("Market:;XETR", "Date Last Update:;21.10.2026"), a header, one line per instrument (";")
export function parseXetra(text) {
  const t = String(text || ""), m = /Date Last Update:;(\d{2})\.(\d{2})\.(\d{4})/.exec(t.slice(0, 300));
  const lines = t.split("\n"); let h = -1; for (let i = 0; i < 10 && i < lines.length; i++) if (lines[i].startsWith("Product Status;")) { h = i; break; }
  if (h < 0) return null;
  const hdr = lines[h].replace(/\r$/, "").split(";"), c = (n) => hdr.indexOf(n);
  const ci = { name: c("Instrument"), isin: c("ISIN"), wkn: c("WKN"), mnem: c("Mnemonic"), type: c("Instrument Type"), grp: c("Product Assignment Group Description"), ccy: c("Settlement Currency") };
  if (Object.values(ci).some((x) => x < 0)) return null;
  const by = new Map();
  for (let i = h + 1; i < lines.length; i++) {
    const f = lines[i].replace(/\r$/, "").split(";"), type = f[ci.type];
    if (type !== "ETF" && type !== "ETN" && type !== "ETC") continue;
    const isin = f[ci.isin]; if (!isinValid(isin)) continue;
    const mnem = (f[ci.mnem] || "").trim(), ccy = (f[ci.ccy] || "").trim(), grp = XETRA_GROUP[(f[ci.grp] || "").trim()] || null;
    let e = by.get(isin); if (!e) { e = [isin, (f[ci.name] || "").trim(), type, grp, (f[ci.wkn] || "").trim(), []]; by.set(isin, e); }
    if (grp && (!e[3] || ccy === "EUR")) e[3] = grp; // a foreign-currency line's group ("ETF - CURRENCY USD") says nothing of the fund
    if (mnem && !e[5].some((x) => x[0] === mnem)) e[5].push([mnem, ccy]);
    if (ccy === "EUR" && f[ci.name]) e[1] = f[ci.name].trim();
  }
  const rows = [...by.values()].map((e) => [e[0], e[1], e[2], e[3], e[4], e[5].sort((a, b) => (a[1] === "EUR" ? 0 : 1) - (b[1] === "EUR" ? 0 : 1)).map((x) => x.join(":")).join(" ")]);
  return { asOf: m ? `${m[3]}-${m[2]}-${m[1]}` : null, rows };
}
// Twelve Data's U.S. ETF list: exchange-traded funds (CFI CE…) on the U.S. exchanges (OTC left out)
export function parseTdEtfs(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  const d = Array.isArray(j && j.data) ? j.data : null; if (!d) return null;
  const rows = [], seen = new Set();
  for (const x of d) { if (!x || !x.symbol || x.exchange === "OTC" || !/^CE/.test(String(x.cfi_code || "")) || seen.has(x.symbol)) continue; seen.add(x.symbol); rows.push([x.symbol, String(x.name || "").trim(), x.mic_code || null]); }
  return rows.length ? { rows } : null;
}
// one source per run (the CSV is ~5 MB): the Xetra list when older than 6 days, else the U.S. list
export async function buildEtfUniverse(env, now = Date.now(), fetchImpl = fetchText, which = null) {
  if (!env || !env.BRIEFS) return { action: "skipped" };
  const [u, us] = await Promise.all([getJ(env, K.uni), which === "xetra" ? null : getJ(env, K.us)]);
  const want = which || (!u || now - u.fetchedAt > 6 * DAY ? "xetra" : !us || now - us.fetchedAt > 6 * DAY ? "us" : null);
  if (!want) return { action: "fresh" };
  if (want === "xetra") {
    const f = await fetchImpl(XETRA_URL, { timeoutMs: 25000, headers: { accept: "text/csv,*/*" } });
    const p = f.err ? null : parseXetra(f.text);
    // a list much shorter than the one kept (a truncated download) never replaces it
    if (!p || !p.rows.length || (u && u.rows && p.rows.length < u.rows.length / 2)) return { action: "failed", which: want, err: f.err || (p ? "short_list" : "parse_error") };
    await put(env, K.uni, { asOf: p.asOf, fetchedAt: now, source: "Deutsche Börse — T7 (Xetra) All tradable instruments", sourceUrl: XETRA_PAGE, rows: p.rows });
    await put(env, K.isins, p.rows.map((r) => r[0]).join(","));
    return { action: "built", which: want, count: p.rows.length };
  }
  const f = await fetchImpl(TD_ETFS_URL, { timeoutMs: 25000, headers: { accept: "application/json" } });
  const p = f.err ? null : parseTdEtfs(f.text);
  if (!p) return { action: "failed", which: want, err: f.err || "parse_error" };
  await put(env, K.us, { fetchedAt: now, source: "Twelve Data — ETF list (reference data)", rows: p.rows });
  return { action: "built", which: want, count: p.rows.length };
}

// ---------- justETF reference data for every fund ----------
export { TABLE_COLS, tableLine, patchTable, tableMap, refFromLine } from "./etfref.mjs";
import { tableLine, patchTable, TABLE_COLS } from "./etfref.mjs";

// justETF's profile page, beyond the basics (ucits.mjs): the fund's name, provider, investment focus, top 10 holdings,
// countries and sectors (as justETF lists them: the largest ones and "Other")
const ENT = { "&amp;": "&", "&nbsp;": " ", "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" };
const clean = (s) => String(s || "").replace(/^[^<>]*>/, " ").replace(/<[^>]*>/g, " ").replace(/<[^>]*$/, " ").replace(/&[a-z#0-9]+;/gi, (m) => ENT[m] || " ").replace(/\s+/g, " ").trim();
// the text up to the next of the page's labels
const LABELS = ["Fund size", "Total expense ratio", "Replication", "Index", "Top 10", "Legal structure", "Distribution policy", "Holdings", "Inception", "Fund currency", "Fund domicile", "Countries", "Sectors", "Show more", "Source: justETF"];
const upToLabel = (t) => { let e = t.length; for (const l of LABELS) { const i = t.indexOf(" " + l); if (i >= 0 && i < e) e = i; } return t.slice(0, e).trim(); };
function textAfter(html, label, span) { const i = html.indexOf(label); return i < 0 ? null : clean(html.slice(i + label.length, i + label.length + span)); }
// "NVIDIA Corp. 5.53% Apple 5.07% …" → [["NVIDIA Corp.", 5.53], …]
export function weightPairs(text, max = 12) {
  const out = [], re = /([^%]{1,70}?)\s(\d{1,3}\.\d{1,2})%/g; let m;
  while ((m = re.exec(String(text || ""))) && out.length < max) { const name = m[1].replace(/^[\s,;|·-]+/, "").trim(); if (!name || /^(Weight of top 10 holdings|out of [\d,]+)/i.test(name)) continue; out.push([name, Number(m[2])]); }
  return out;
}
export function parseJustEtfFull(html) {
  const base = parseJustEtf(html); if (!base) return null;
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1], name = title ? clean(title).split(" | ")[0].trim() : null;
  const prov = /^(.{2,40}?) (?:Legal structure|Fund Structure|UCITS compliance)/.exec(textAfter(html, "Fund Provider", 200) || "");
  const focusT = upToLabel(textAfter(html, "Investment focus", 260) || ""), focus = /^[A-Z][^%]{2,79}$/.test(focusT) ? [null, focusT] : null;
  const top = textAfter(html, "Top 10 Holdings", 1800), topW = /Weight of top 10 holdings out of ([\d,]+) (\d{1,3}\.\d{1,2})%/.exec(top || "");
  const cut = (t) => (t ? t.split(/ (?:Sectors|Countries|Show more|Hide|Source: justETF)\b/)[0] : t);
  const holdings = top ? weightPairs(cut(top.replace(/^Weight of top 10 holdings out of [\d,]+ \d{1,3}\.\d{1,2}%/, "")), 10) : [];
  const countries = weightPairs(cut(textAfter(html, ">Countries<", 900)), 12), sectors = weightPairs(cut(textAfter(html, ">Sectors<", 900)), 12);
  return { ...base, name: name || null, provider: prov ? prov[1] : null, focus: focus ? focus[1] : null,
    top10: holdings.length ? holdings : null, top10Weight: topW ? Number(topW[2]) : null, holdingsTotal: topW ? Number(topW[1].replace(/,/g, "")) : base.holdings,
    countries: countries.length ? countries : null, sectors: sectors.length ? sectors : null };
}

// the funds read first and weekly: the UCITS list, the portfolio's and every profile opened (ref/je/prio: isin → time)
const UCITS_ISINS = UCITS_ETFS.map((e) => e.isin);
async function readJe(env, isin, now, fetchImpl) {
  const f = await fetchImpl(justEtfUrl(isin), { timeoutMs: 15000, headers: { accept: "text/html", "accept-language": "en" } });
  if (f.err && f.err !== "no_data") return { fail: f.err };
  const m = f.err ? null : parseJustEtfFull(f.text);
  return m ? { m: { ...m, fetchedAt: now } } : { none: f.err || "no_reference_data" };
}
// the */5 cron: one fund a run — a priority fund not read for a week, else the next fund of the universe by time
export async function refreshEtfRef(env, now = Date.now(), fetchImpl = fetchText) {
  if (!env || !env.BRIEFS) return { action: "skipped" };
  const prio = (await getJ(env, K.prio)) || {};
  if (prio._fail && now - prio._fail.at < BACKOFF) return { action: "backoff" };
  const pr = [...new Set([...UCITS_ISINS, ...Object.keys(prio).filter((k) => k !== "_fail" && k !== "_extra"), ...(prio._extra || [])])];
  let isin = pr.find((i) => !prio[i] || now - prio[i] >= REFRESH), isPrio = !!isin;
  if (!isin) { const list = String((await env.BRIEFS.get(K.isins)) || "").split(",").filter(Boolean); if (!list.length) return { action: "no_universe" }; isin = list[Math.floor(now / SLOT) % list.length]; }
  const r = await readJe(env, isin, now, fetchImpl);
  if (r.fail) { prio._fail = { at: now, err: r.fail }; await put(env, K.prio, prio); return { action: "failed", isin, err: r.fail }; }
  if (r.m) {
    const table = await env.BRIEFS.get(K.table);
    await put(env, K.table, patchTable(table, isin, tableLine(isin, r.m, now)));
    if (isPrio) await put(env, K.detail(isin), r.m);
  }
  if (isPrio || prio._fail) { delete prio._fail; if (isPrio) prio[isin] = now; await put(env, K.prio, prio); }
  return { action: r.m ? "read" : "no_data", isin, prio: isPrio };
}
// a profile opened: the full record (≤ 7 days old), else read now; the fund joins the priority list
export async function etfDetail(env, isin, now = Date.now(), fetchImpl = fetchText, { read = true } = {}) {
  const d = await getJ(env, K.detail(isin));
  if (d && d.fetchedAt && now - d.fetchedAt < REFRESH) return { data: d };
  const prio = (await getJ(env, K.prio)) || {};
  if (!read || (prio._fail && now - prio._fail.at < BACKOFF)) return d ? { data: d, stale: true } : { err: prio._fail ? "backoff" : "not_read" };
  const r = await readJe(env, isin, now, fetchImpl);
  if (r.fail) { prio._fail = { at: now, err: r.fail }; await put(env, K.prio, prio); return d ? { data: d, stale: true } : { err: r.fail }; }
  prio[isin] = now; delete prio._fail; await put(env, K.prio, prio);
  if (!r.m) return d ? { data: d, stale: true } : { err: r.none };
  await put(env, K.detail(isin), r.m);
  const table = await env.BRIEFS.get(K.table); await put(env, K.table, patchTable(table, isin, tableLine(isin, r.m, now)));
  return { data: r.m };
}
// funds added to the priority list (the portfolio's ETFs) — read weekly from then on
export async function addPriority(env, isins) {
  const prio = (await getJ(env, K.prio)) || {}, add = isins.filter((i) => isinValid(i) && !(i in prio) && !UCITS_ISINS.includes(i) && !(prio._extra || []).includes(i));
  if (!add.length) return 0; prio._extra = [...(prio._extra || []), ...add].slice(-200); await put(env, K.prio, prio); return add.length;
}

// ---------- listings and prices of one fund ----------
const VENUE_ORDER = { XETR: 0, XMIL: 1, XPAR: 2, XAMS: 3, XLON: 4, XSWX: 5, XFRA: 6 };
const normCcy = (c) => (c === "GBp" || c === "GBX" ? "GBP" : c);
export async function fundLines(url, env, ctx, isin, uniRow) {
  const cand = new Map(), add = (code, from) => { if (code && /^[A-Z0-9][A-Z0-9.\-]{0,15}$/.test(code) && !cand.has(code)) cand.set(code, from); };
  if (uniRow) for (const t of String(uniRow[5] || "").split(" ").filter(Boolean)) add(t.split(":")[0] + "-DE", "Xetra list");
  const u = UCITS_ETFS.find((e) => e.isin === isin); if (u) for (const l of Object.values(u.lines)) add(l.cnbc, "UCITS list");
  // the other venues: the terminal's own ISIN search (OpenFIGI, Twelve Data), its CNBC codes
  try { const r = await handleSearch(new URL(`${url.origin}/api/search?q=${isin}`), env, ctx, {}, (b, h, st = 200) => new Response(JSON.stringify(b), { status: st })); const j = await r.json(); for (const x of j.results || []) add(x.cnbc, "ISIN search"); } catch {}
  const codes = [...cand.keys()].slice(0, 40); if (!codes.length) return { lines: [] };
  const q = await cachedSource({ origin: url.origin, key: `etf/lines/${isin}`, ttlMs: 60_000, staleMaxMs: 3 * DAY, failTtlMs: 60_000, ctx, load: async () => { const raw = await loadCnbcRaw(codes); const out = {}; for (const c of codes) { const r = cnbcIntlRec("C:" + c, raw.data[c]); if (r) out[c] = r; } return Object.keys(out).length ? { data: out } : { err: raw.err || "no_data" }; } });
  const now = Date.now(), lines = [];
  for (const c of codes) {
    const r = q.data && q.data[c]; if (!r) continue;
    const pence = r.currency === "GBp" || r.currency === "GBX", l = lineOf(c, normCcy(r.currency), pence), unit = pence ? 100 : 1;
    lines.push({ ...l, price: r.price / unit, change: r.change != null ? r.change / unit : null, changePct: r.changePct, prevClose: r.prevClose != null ? r.prevClose / unit : null, volume: r.volume, asOf: r.asOf, dateOnly: r.dateOnly, name: r.name,
      status: (r.asOf && now - Date.parse(r.asOf) > 4 * DAY) || (r.dateOnly && now - Date.parse(r.dateOnly) > 5 * DAY) ? "STALE" : "LIVE", from: cand.get(c) });
  }
  lines.sort((a, b) => (a.ccy === "EUR" ? 0 : 1) - (b.ccy === "EUR" ? 0 : 1) || (VENUE_ORDER[a.mic] ?? 9) - (VENUE_ORDER[b.mic] ?? 9) || (b.volume || 0) - (a.volume || 0));
  return { lines, asked: codes.length, err: q.err || null };
}

// ---------- compare: each fund's line in the currency, or its first line converted at each day's FX (DERIVED) ----------
const FX_CODES = ["EUR=", "GBP=", "CHF="];
const closeOn = (rows, d) => { let v = null; for (const x of rows) { if (x[0] <= d) v = x[1]; else break; } return v; };
export function seriesStats(rows) {
  if (!rows || rows.length < 20) return null;
  const last = rows[rows.length - 1], ref = referenceCloses(rows), r = {};
  for (const k of ["1W", "1M", "3M", "YTD", "1Y"]) if (ref[k]) r[k] = (last[1] / ref[k][1] - 1) * 100;
  const back = (y) => { const t = Date.parse(last[0]) - y * YEAR, x = rows.find((p) => Date.parse(p[0]) >= t); return x && Date.parse(rows[0][0]) <= t + 7 * DAY ? x : null; };
  for (const y of [3, 5]) { const x = back(y); if (x) { r[y + "Y"] = (last[1] / x[1] - 1) * 100; r[y + "Ya"] = (Math.pow(last[1] / x[1], 1 / y) - 1) * 100; } }
  const y1 = rows.filter((p) => Date.parse(p[0]) >= Date.parse(last[0]) - 365 * DAY), d = [];
  for (let i = 1; i < y1.length; i++) d.push(Math.log(y1[i][1] / y1[i - 1][1]));
  const m = d.reduce((a, x) => a + x, 0) / (d.length || 1), v = d.length > 20 ? Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1) * 252) * 100 : null;
  let peak = -Infinity, mdd = 0, mddAt = null; for (const [t, c] of rows) { if (c > peak) peak = c; const dd = c / peak - 1; if (dd < mdd) { mdd = dd; mddAt = t; } }
  return { returns: r, vol1Y: v, maxDrawdown: mdd * 100, maxDrawdownAt: mddAt, from: rows[0][0], to: last[0] };
}
export async function compareFunds(url, env, ctx, items, ccy) {
  const uni = await getJ(env, K.uni), byIsin = new Map((uni && uni.rows || []).map((r) => [r[0], r])), now = Date.now();
  const pick = items.map((id) => {
    if (isinValid(id)) {
      const u = UCITS_ETFS.find((e) => e.isin === id), row = byIsin.get(id), xl = row ? String(row[5] || "").split(" ").filter(Boolean).map((t) => t.split(":")) : [];
      const own = (u && u.lines[ccy]) || (xl.find((x) => x[1] === ccy) ? lineOf(xl.find((x) => x[1] === ccy)[0] + "-DE", ccy) : null);
      const def = own || (u && u.def) || (xl[0] ? lineOf(xl[0][0] + "-DE", xl[0][1]) : null);
      return { id, isin: id, name: (u && u.name) || (row && row[1]) || null, line: def };
    }
    return { id, name: null, line: { cnbc: id, ticker: id, venue: "U.S.", ccy: "USD", pence: false, id: "C:" + id } }; // a U.S. ETF: CNBC's plain symbol, in USD
  });
  const need = pick.some((p) => p.line && p.line.ccy !== ccy);
  const [bars, fxRes] = await Promise.all([Promise.all(pick.map((p) => (p.line ? cnbcDaily(url.origin, ctx, p.line.cnbc, 1900, now) : { err: "no_line" }))), need ? Promise.all(FX_CODES.map((c) => cnbcDaily(url.origin, ctx, c, 1900, now))) : []]);
  const fxRows = {}; FX_CODES.forEach((c, i) => { if (fxRes[i] && fxRes[i].data) fxRows[c] = fxRes[i].data; });
  return pick.map((p, i) => {
    const b = bars[i]; if (!p.line || !b.data) return { ...p, error: (b && b.err) || "no_line" };
    const unit = p.line.pence ? 100 : 1, conv = p.line.ccy && p.line.ccy !== ccy;
    const rows = b.data.map(([d, v]) => { if (!conv) return [d, v / unit]; const fx = {}; for (const c of FX_CODES) if (fxRows[c]) fx[c] = closeOn(fxRows[c], d); const k = fxRate(p.line.ccy, ccy, fx); return [d, k ? (v / unit) * k : null]; }).filter((x) => x[1] != null && x[1] > 0);
    if (rows.length < 20) return { ...p, error: conv ? "fx_unavailable" : "no_data" };
    const weekly = rows.filter((x, j) => j === rows.length - 1 || new Date(x[0] + "T12:00:00Z").getUTCDay() === 5 || j === 0);
    return { ...p, conv: conv ? { from: p.line.ccy, to: ccy } : null, stats: seriesStats(rows), weekly };
  });
}

// ---------- exposure: the portfolio's ETFs looked through (justETF's top 10, countries, sectors), weighted ----------
export function exposure(funds) {
  const total = funds.reduce((a, f) => a + (f.weight > 0 ? f.weight : 0), 0) || 1, agg = { countries: {}, sectors: {}, holdings: {} }, cover = { countries: 0, sectors: 0, holdings: 0 };
  for (const f of funds) {
    const w = (f.weight > 0 ? f.weight : 0) / total, d = f.detail; if (!d) continue;
    for (const [k, list] of [["countries", d.countries], ["sectors", d.sectors], ["holdings", d.top10]]) { if (!list) continue; cover[k] += w; for (const [n, p] of list) agg[k][n] = (agg[k][n] || 0) + (w * p); }
  }
  const sorted = (o) => Object.entries(o).sort((a, b) => (a[0] === "Other") - (b[0] === "Other") || b[1] - a[1]).map(([n, v]) => [n, v]); // "Other" last
  return { countries: sorted(agg.countries), sectors: sorted(agg.sectors), holdings: sorted(agg.holdings).slice(0, 25), coverage: { countries: cover.countries * 100, sectors: cover.sectors * 100, holdings: cover.holdings * 100 } };
}

// ---------- the page's requests ----------
export async function handleEtf(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const p = url.pathname, now = Date.now();
  if (!env.BRIEFS) return send({ error: "not_configured", status: "N/A" }, 503);
  if (p === "/api/etf/universe") {
    // the lists as kept; nothing kept yet (first use) → built now, one source per request
    let [u, us] = await Promise.all([getJ(env, K.uni), getJ(env, K.us)]);
    if (!u || !us) { const b = await buildEtfUniverse(env, now, fetchText, !u ? "xetra" : "us"); if (b.action === "built") [u, us] = await Promise.all([getJ(env, K.uni), getJ(env, K.us)]); }
    const table = await env.BRIEFS.get(K.table);
    return send({ xetra: u ? { asOf: u.asOf, fetchedAt: iso(u.fetchedAt), source: u.source, sourceUrl: u.sourceUrl, cols: ["isin", "name", "type", "group", "wkn", "lines"], rows: u.rows } : null,
      us: us ? { fetchedAt: iso(us.fetchedAt), source: us.source, cols: ["symbol", "name", "mic"], rows: us.rows } : null,
      ref: { source: JUSTETF, cols: TABLE_COLS, table: table || "", note: "reference data read from justETF profile pages, one fund every 5 minutes (≈ 10 days a round); never prices" },
      ucits: UCITS_ETFS.map((e) => [e.isin, ...new Set([e.milan, ...e.tickers].filter(Boolean))]), // Milan / London / SIX tickers of the UCITS list (the Xetra list has Xetra's only)
      status: u ? (now - u.fetchedAt > 9 * DAY ? "STALE" : "LIVE") : "N/A" });
  }
  if (p === "/api/etf/profile") {
    const isin = String(url.searchParams.get("isin") || "").toUpperCase(); if (!isinValid(isin)) return send({ error: "bad_request", message: "isin" }, 400);
    const u = await getJ(env, K.uni), row = u ? u.rows.find((r) => r[0] === isin) || null : null;
    const [d, L] = await Promise.all([etfDetail(env, isin, now), fundLines(url, env, ctx, isin, row)]);
    const ucits = UCITS_ETFS.find((e) => e.isin === isin);
    return send({ isin, xetra: row ? { name: row[1], type: row[2], group: row[3], wkn: row[4], lines: row[5], asOf: u.asOf } : null, ucits: ucits ? { sym: ucits.sym, group: ucits.group } : null,
      ref: d.data ? { ...d.data, fetchedAt: iso(d.data.fetchedAt), source: JUSTETF, sourceUrl: justEtfUrl(isin), status: d.stale ? "STALE" : "LIVE" } : null, refError: d.err || null,
      lines: L.lines, linesAsked: L.asked, linesError: L.err, status: L.lines.length ? "LIVE" : "N/A" });
  }
  if (p === "/api/etf/compare") {
    const ccy = String(url.searchParams.get("ccy") || "EUR").toUpperCase(); if (!UCITS_CCYS.includes(ccy)) return send({ error: "bad_request", message: `ccy: ${UCITS_CCYS.join(", ")}` }, 400);
    const items = [...new Set(String(url.searchParams.get("ids") || "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => isinValid(s) || /^[A-Z][A-Z0-9.]{0,9}$/.test(s)))].slice(0, 4);
    if (items.length < 1) return send({ error: "bad_request", message: "ids: up to 4 ISINs or U.S. ETF symbols" }, 400);
    const funds = await compareFunds(url, env, ctx, items, ccy);
    return send({ ccy, funds, source: "CNBC daily bars (each fund's line in the currency, or its first line converted at each day's CNBC FX close — DERIVED)", status: funds.some((f) => f.stats) ? "LIVE" : "N/A" });
  }
  if (p === "/api/etf/exposure") {
    // w=ISIN:weight,… (the page's market values); the full records of those funds, read now where never read (≤ 3)
    const items = String(url.searchParams.get("w") || "").split(",").map((s) => s.split(":")).filter((x) => isinValid(String(x[0]).toUpperCase()) && Number(x[1]) > 0).slice(0, 40).map(([i, w]) => ({ isin: i.toUpperCase(), weight: Number(w) }));
    if (!items.length) return send({ error: "bad_request", message: "w: ISIN:weight,…" }, 400);
    await addPriority(env, items.map((x) => x.isin));
    const kept = await Promise.all(items.map((it) => getJ(env, K.detail(it.isin))));
    let reads = 0; const funds = [];
    for (const [i, it] of items.entries()) {
      let d = kept[i] ? { data: kept[i] } : null;
      if (!d && reads < 3) { reads++; d = await etfDetail(env, it.isin, now); } // never read: read now (at most three a request)
      if (!d) d = { err: "not_read" };
      funds.push({ ...it, detail: d.data || null, error: d.err || null, name: d.data ? d.data.name : null, fetchedAt: d.data ? iso(d.data.fetchedAt) : null });
    }
    const x = exposure(funds);
    return send({ ...x, funds: funds.map((f) => ({ isin: f.isin, weight: f.weight, name: f.name, has: f.detail ? { countries: !!f.detail.countries, sectors: !!f.detail.sectors, top10: !!f.detail.top10 } : null, error: f.error, fetchedAt: f.fetchedAt })),
      source: "justETF profile pages (countries, sectors and top 10 holdings as justETF lists them) — weighted by the page's market values, DERIVED", status: funds.some((f) => f.detail) ? "DERIVED" : "N/A" });
  }
  if (p === "/api/etf/resolve") {
    // portfolio symbols → ISINs: Xetra mnemonics (SYMBOL:XETR, C:MNEMONIC-DE), the UCITS list's tickers and lines; U.S. ETFs
    const syms = String(url.searchParams.get("syms") || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
    const [u, us] = await Promise.all([getJ(env, K.uni), getJ(env, K.us)]), mn = new Map(), usSet = new Set((us && us.rows || []).map((r) => r[0]));
    for (const r of (u && u.rows) || []) for (const t of String(r[5] || "").split(" ").filter(Boolean)) mn.set(t.split(":")[0], r[0]);
    const out = {};
    for (const s of syms) {
      const [t, mic] = s.startsWith("C:") ? [s.slice(2).replace(/-DE$/, ""), s.endsWith("-DE") ? "XETR" : null] : s.split(":");
      const uc = UCITS_ETFS.find((e) => e.milan === t || e.tickers.includes(t) || Object.values(e.lines).some((l) => "C:" + l.cnbc === s));
      out[s] = uc ? { isin: uc.isin, name: uc.name } : (mic === "XETR" || s.startsWith("C:")) && mn.has(t) ? { isin: mn.get(t) } : !mic && usSet.has(t) ? { us: true } : null;
    }
    return send({ resolved: out });
  }
  return send({ error: "not found" }, 404);
}
