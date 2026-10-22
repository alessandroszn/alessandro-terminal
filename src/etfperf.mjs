// ETF SCREENER — returns and risk of every fund: 1 year, 3 and 5 years a year, volatility (the last 3 years of daily
// returns, annualised with 252) and the maximum drawdown of the last 5 years, of each fund's listing in its own trading
// currency — the Xetra EUR line (MNEMONIC-DE) for the Xetra list, the U.S. symbol (USD) for the U.S. list — from CNBC's
// daily bars (about 5 years), DERIVED. Never filled in: a fund younger than a period has no figure for it.
//   cron     its own trigger (PERF_CRON; since 22 Oct 2026 the runs at minutes 2, 22, 42 only — KV writes are 1,000 a day on
//            the free plan; never in the same run as the alerts) computes 8 funds a run through both lists in a fixed order
//            (Xetra first), one KV write a run (etf/perf: one line a fund) → every fund about every two weeks; the date of
//            each figure is kept and shown
//   on use   GET /api/etf/perf?ids=ISIN|SYM,… (≤ 8): the rows on screen not computed yet, live (Cache API, not KV)
//            GET /api/etf/perftable: the KV table
import { cnbcDaily } from "./cnbc.mjs";
import { isinValid } from "./isin.mjs";
import { UCITS_ETFS } from "./ucits.mjs";

export const PERF_CRON = "2-59/10 * * * *";
export const PERF_KEY = "etf/perf";
export const PERF_COLS = ["id", "asOf", "r1", "r3", "r5", "vol", "mdd", "first", "ccy"];
export const PERF_DAYS = 1900, PERF_BATCH = 8;
const DAY = 86400_000, KEEP = 60 * 86400, SLOT10 = 600_000;
const getJ = async (env, k) => { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : null; } catch { return null; } };
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : "");

// daily closes [[date, close]] ascending → the figures; each period only when the history reaches back to its start
export function perfOf(rows) {
  const n = rows.length; if (n < 30) return null;
  const lastD = rows[n - 1][0], last = rows[n - 1][1], t = Date.parse(lastD + "T12:00:00Z"), first = rows[0][0];
  const at = (days) => { const d = new Date(t - days * DAY).toISOString().slice(0, 10); if (first > d) return null; let v = null; for (const [x, c] of rows) { if (x <= d) v = c; else break; } return v; };
  const p1 = at(365), p3 = at(1096), p5 = at(1826);
  const from3 = new Date(t - 1096 * DAY).toISOString().slice(0, 10), rr = [];
  for (let i = 1; i < n; i++) if (rows[i][0] > from3 && rows[i][1] > 0 && rows[i - 1][1] > 0) rr.push(rows[i][1] / rows[i - 1][1] - 1);
  let vol = null; if (rr.length >= 200 && first <= from3) { const m = rr.reduce((a, x) => a + x, 0) / rr.length; vol = Math.sqrt(rr.reduce((a, x) => a + (x - m) ** 2, 0) / (rr.length - 1)) * Math.sqrt(252); }
  const from5 = new Date(t - 1826 * DAY).toISOString().slice(0, 10); let peak = 0, mdd = 0, seen = false;
  for (const [d, c] of rows) { if (d < from5) continue; seen = true; if (c > peak) peak = c; if (peak > 0) mdd = Math.min(mdd, c / peak - 1); }
  return { asOf: lastD, r1: p1 > 0 ? last / p1 - 1 : null, r3: p3 > 0 ? Math.pow(last / p3, 1 / 3) - 1 : null, r5: p5 > 0 ? Math.pow(last / p5, 1 / 5) - 1 : null, vol, mdd: seen && at(365) ? mdd : null, first };
}
// the listing a fund's figures come from: its Xetra EUR line (the screener's price line), a UCITS fund's EUR line, a U.S. ETF
export function perfLine(id, uniRow, usSet) {
  const s = String(id || "").toUpperCase();
  const xl = uniRow ? String(uniRow[5] || "").split(" ").filter(Boolean).map((t) => t.split(":")) : [], p = xl.find((x) => x[1] === "EUR");
  if (p) return { id: s, cnbc: p[0] + "-DE", ccy: "EUR" };
  if (isinValid(s)) {
    const u = UCITS_ETFS.find((e) => e.isin === s), l = u && (u.lines.EUR || u.def);
    return l && l.ccy ? { id: s, cnbc: l.cnbc, ccy: l.ccy, pence: !!l.pence } : null;
  }
  return usSet && usSet.has(s) ? { id: s, cnbc: s, ccy: "USD" } : null;
}
export function perfLineText(id, p, ccy) { return [id, p.asOf, r4(p.r1), r4(p.r3), r4(p.r5), r4(p.vol), r4(p.mdd), p.first, ccy].join("\t"); }
export function patchPerf(table, id, line) {
  const t = table || "", key = id + "\t", i = t.startsWith(key) ? 0 : t.indexOf("\n" + key);
  if (i < 0) return t ? t + "\n" + line : line;
  const s = i === 0 ? 0 : i + 1, e = t.indexOf("\n", s);
  return t.slice(0, s) + line + (e < 0 ? "" : t.slice(e));
}
async function lists(env) {
  const [uni, us] = await Promise.all([getJ(env, "etf/universe"), getJ(env, "etf/us")]);
  const rows = (uni && uni.rows) || [], usRows = (us && us.rows) || [];
  return { byIsin: new Map(rows.map((r) => [r[0], r])), order: rows.map((r) => r[0]).concat(usRows.map((r) => r[0])), usSet: new Set(usRows.map((r) => r[0])) };
}
const daily = (origin, ctx, now) => (code) => cnbcDaily(origin, ctx, code, PERF_DAYS, now);
async function compute(ids, L, load) {
  const lines = ids.map((id) => perfLine(id, L.byIsin.get(id), L.usSet));
  const bars = await Promise.all(lines.map((l) => (l ? load(l.cnbc) : null)));
  return ids.map((id, i) => {
    const l = lines[i], b = bars[i]; if (!l) return { id, error: "not_listed" };
    if (!b || !b.data) return { id, error: (b && b.err) || "no_data" };
    const rows = l.pence ? b.data.map(([d, v]) => [d, v / 100]) : b.data, p = perfOf(rows);
    return p ? { id, cnbc: l.cnbc, ccy: l.ccy, ...p } : { id, error: "no_data" };
  });
}
// the cron: the next 8 funds of both lists (a fixed order, by time), one KV write
export async function refreshEtfPerf(env, now = Date.now(), deps = {}) {
  if (!env.BRIEFS) return { skipped: "no_kv" };
  const L = await lists(env); if (!L.order.length) return { skipped: "no_lists" };
  const k = Math.floor(now / SLOT10) * PERF_BATCH % L.order.length, ids = [];
  for (let j = 0; j < PERF_BATCH && j < L.order.length; j++) ids.push(L.order[(k + j) % L.order.length]);
  const res = await compute(ids, L, deps.daily || daily(env.ALLOWED_ORIGIN || "https://alessandrozanichelli.com", deps.ctx || {}, now));
  let table = (await env.BRIEFS.get(PERF_KEY)) || "", n = 0;
  for (const r of res) if (!r.error) { table = patchPerf(table, r.id, perfLineText(r.id, r, r.ccy)); n++; }
  if (n) await env.BRIEFS.put(PERF_KEY, table, { expirationTtl: KEEP });
  return { ids, computed: n, errors: res.filter((r) => r.error).map((r) => r.id + ":" + r.error) };
}
export async function handleEtfPerf(url, env, ctx, H, json, deps = {}) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "not_configured", status: "N/A" }, 503);
  if (url.pathname === "/api/etf/perftable") { const t = (await env.BRIEFS.get(PERF_KEY)) || ""; return send({ table: t, cols: PERF_COLS, count: t ? t.split("\n").length : 0, basis: "CNBC daily bars of each fund's Xetra EUR line (U.S. ETFs: USD), about 5 years; 1Y; 3Y and 5Y a year; volatility of the last 3 years' daily returns ×√252; max drawdown of the last 5 years — DERIVED", status: t ? "LIVE" : "N/A" }); }
  const ids = [...new Set(String(url.searchParams.get("ids") || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (!ids.length || ids.length > PERF_BATCH || ids.some((x) => !/^[A-Z0-9][A-Z0-9.\-]{0,15}$/.test(x))) return send({ error: "bad_request", message: `ids: 1 to ${PERF_BATCH} ISINs or U.S. symbols` }, 400);
  const L = await lists(env), res = await compute(ids, L, deps.daily || daily(url.origin, ctx, deps.now || Date.now()));
  return send({ funds: res, cols: PERF_COLS, status: "DERIVED" });
}
