// DRIFT — how far your positions (PORTFOLIO, KV pf/tx) sit from the target weights of a lab portfolio (PLAB, KV ud/plab),
// for the alert kind "drift" (alerts.mjs: checked once a day after the European close, and on "check now"). Positions
// valued at CNBC's last price in EUR (EUR= and GBP= are USD per unit, CHF= is CHF per USD; pence ÷ 100); matched to the
// target by the fund's ISIN (the UCITS list, the Xetra list: as /api/etf/resolve), else by the symbol. Cash in the target
// is left out and the other weights scaled to 100 % (PORTFOLIO holds no cash). Positions outside the target count in the
// total. DERIVED. Nothing estimated: a position without a price here, or in a currency without an FX rate, means no
// check (the reason is kept in the alerts' log).
import { buildPositions } from "./portfolio.mjs";
import { loadCnbcRaw, cnbcForeignFallback } from "./intl.mjs";
import { parseCnbcQuote } from "./cnbc.mjs";
import { resolveSym } from "./etf.mjs";
import { UCITS_ETFS } from "./ucits.mjs";
import { isinValid } from "./isin.mjs";
import { usdPer } from "./factors.mjs";

const getJ = async (env, k) => { try { const t = await env.BRIEFS.get(k); return t ? JSON.parse(t) : null; } catch { return null; } };
const FX_SYMS = ["EUR=", "GBP=", "CHF="];
const PENCE = new Set(["GBp", "GBX"]);
// the Xetra list's mnemonic → ISIN and the U.S. ETF symbols (the same maps as /api/etf/resolve)
export function listMaps(uni, us) {
  const mn = new Map(), usSet = new Set(((us && us.rows) || []).map((r) => r[0]));
  for (const r of (uni && uni.rows) || []) for (const t of String(r[5] || "").split(" ").filter(Boolean)) mn.set(t.split(":")[0], r[0]);
  return { mn, usSet };
}
// a lab portfolio's instrument → the key it is matched by: an ISIN as typed, a UCITS ticker or a Xetra mnemonic → the
// fund's ISIN, a portfolio-style symbol resolved the same way as the positions, else the instrument itself
export function targetKey(id, maps) {
  const s = String(id || "").toUpperCase();
  if (isinValid(s)) return s;
  const uc = UCITS_ETFS.find((e) => e.milan === s || e.tickers.includes(s)); if (uc) return uc.isin;
  if (/^[A-Z0-9]{2,12}$/.test(s) && maps.mn.has(s)) return maps.mn.get(s);
  const r = resolveSym(s, maps.mn, maps.usSet); return r && r.isin ? r.isin : s;
}
export function positionKey(sym, maps) { const r = resolveSym(String(sym).toUpperCase(), maps.mn, maps.usSet); return r && r.isin ? r.isin : String(sym).toUpperCase(); }
// EUR for one unit of a currency, from CNBC's FX quotes ({ "EUR=": last, … }); pence → pounds ÷ 100
export function eurPerUnit(ccy, fx) {
  const c = PENCE.has(ccy) ? "GBP" : ccy, a = usdPer(c, fx), b = usdPer("EUR", fx);
  return a > 0 && b > 0 ? (a / b) * (PENCE.has(ccy) ? 0.01 : 1) : null;
}
// positions [{ sym, ccy, qty }], their prices { sym: last in the position's currency }, fx → the gaps from the target
export function computeDrift({ holdings, positions, prices, fx, maps }) {
  const tgt = (holdings || []).filter((h) => String(h.id).toUpperCase() !== "CASH" && +h.w > 0), sw = tgt.reduce((a, h) => a + +h.w, 0);
  if (!tgt.length || !(sw > 0)) return { error: "empty_target" };
  const rows = tgt.map((h) => ({ id: String(h.id).toUpperCase(), key: targetKey(h.id, maps), w: +h.w / sw, v: 0, syms: [] }));
  const outside = [], missing = [];
  for (const p of positions) {
    const px = prices[p.sym], k = eurPerUnit(p.ccy, fx);
    if (!(px > 0) || !(k > 0)) { missing.push(p.sym); continue; }
    const v = p.qty * px * k, key = positionKey(p.sym, maps), r = rows.find((x) => x.key === key || x.id === String(p.sym).toUpperCase());
    if (r) { r.v += v; r.syms.push(p.sym); } else outside.push({ sym: p.sym, v });
  }
  if (missing.length) return { error: "no_price", missing };
  const total = rows.reduce((a, r) => a + r.v, 0) + outside.reduce((a, r) => a + r.v, 0);
  if (!(total > 0)) return { error: "no_positions" };
  for (const r of rows) { r.share = r.v / total; r.drift = r.share - r.w; }
  for (const o of outside) o.share = o.v / total;
  // the gaps of the target's holdings, largest first (a position outside the target is yours to keep: it is in the
  // total, and its share is said, but it is not a gap from a weight)
  const top = rows.map((r) => ({ label: r.id, drift: r.drift, share: r.share, w: r.w })).sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  return { total, rows, outside, top, outsideShare: outside.reduce((a, o) => a + o.share, 0), max: Math.abs(top[0].drift), cashLeftOut: (holdings || []).some((h) => String(h.id).toUpperCase() === "CASH") };
}
// everything a check needs, read once for all drift alerts: the open positions, their CNBC quotes, FX, the lists
export async function loadDriftInputs(env, cnbcOf, deps = {}) {
  const tx = await getJ(env, "pf/tx"), b = buildPositions(Array.isArray(tx) ? tx : [], null);
  if (b.error) return { error: "portfolio: " + b.error };
  const positions = (b.positions || []).filter((p) => p.qty > 0).map((p) => ({ sym: p.sym, ccy: p.ccy, qty: p.qty }));
  if (!positions.length) return { error: "no_positions" };
  const codes = new Map(); for (const p of positions) { const c = cnbcOf(p.sym); if (c) codes.set(p.sym, c); }
  const want = [...new Set([...codes.values(), ...FX_SYMS])], raw = await (deps.loadRaw || loadCnbcRaw)(want);
  const R = raw.data || {}, prices = {}, fx = {};
  for (const [sym, c] of codes) { const r = R[c]; if (!r || cnbcForeignFallback(r)) continue; const q = parseCnbcQuote(r); if (q && q.last > 0) prices[sym] = q.last; }
  for (const c of FX_SYMS) { const q = R[c] ? parseCnbcQuote(R[c]) : null; if (q && q.last > 0) fx[c] = q.last; }
  const [uni, us, plab] = await Promise.all([getJ(env, "etf/universe"), getJ(env, "etf/us"), getJ(env, "ud/plab")]);
  return { positions, prices, fx, maps: listMaps(uni, us), plab: Array.isArray(plab) ? plab : [], quotesErr: raw.err || null };
}
