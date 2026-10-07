// PORTFOLIO (T06) — built by the owner from zero: transactions entered on the site, nothing preloaded.
//   GET    /api/portfolio              transactions + positions derived from them
//   POST   /api/portfolio/tx           add a transaction  (JSON: date, side BUY|SELL, sym, qty, price, ccy, fees?, note?)
//   DELETE /api/portfolio/tx?id=…      remove a transaction
// Stored in Workers KV (binding BRIEFS, key pf/tx) behind Cloudflare Access: private to the owner.
// Positions use the average-cost method. Costs are in the listing's currency and in EUR at the ECB
// euro reference rate of the trade date (last published rate on or before it; ECB Data Portal, EXR).
// Market value is computed by the page from live quotes (Twelve Data) — never stored, never estimated.
import { fetchText, cachedSource, parseCsv, iso } from "./lib.mjs";

export const BASE_CCY = "EUR";
const KEY = "pf/tx", MAX_TX = 2000;
// minor units some venues quote in → major currency and factor
const MINOR = { GBp: ["GBP", 0.01], GBX: ["GBP", 0.01], ZAc: ["ZAR", 0.01], ILA: ["ILS", 0.01] };
export const majorCcy = (c) => (MINOR[c] ? MINOR[c][0] : c);
const minorFactor = (c) => (MINOR[c] ? MINOR[c][1] : 1);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------- validation ----------
const SYM_RE = /^[A-Z0-9][A-Z0-9.\-:\/]{0,19}$/, CCY_RE = /^[A-Za-z]{3}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validateTx(b, today) {
  if (!b || typeof b !== "object") return "body must be a JSON object";
  const side = String(b.side || "").toUpperCase(), sym = String(b.sym || "").trim().toUpperCase(), ccy = String(b.ccy || "").trim();
  const qty = Number(b.qty), price = Number(b.price), fees = b.fees == null || b.fees === "" ? 0 : Number(b.fees);
  if (!["BUY", "SELL"].includes(side)) return "side must be BUY or SELL";
  if (!SYM_RE.test(sym)) return "invalid symbol";
  if (!DATE_RE.test(String(b.date || "")) || !Number.isFinite(Date.parse(b.date + "T00:00:00Z"))) return "date must be YYYY-MM-DD";
  if (b.date > today) return "date is in the future";
  if (b.date < "1990-01-01") return "date too far in the past";
  if (!(qty > 0) || !Number.isFinite(qty) || qty > 1e9) return "quantity must be a positive number";
  if (!(price > 0) || !Number.isFinite(price) || price > 1e9) return "price must be a positive number";
  if (!(fees >= 0) || !Number.isFinite(fees) || fees > 1e9) return "fees must be zero or a positive number";
  if (!CCY_RE.test(ccy)) return "currency must be a 3-letter code";
  return { date: b.date, side, sym, qty: r6(qty), price: r6(price), ccy, fees: r6(fees), note: String(b.note || "").slice(0, 140) };
}

// ---------- ECB euro reference rates (currency units per 1 EUR) ----------
export function parseEcbFx(text) {
  const rows = parseCsv(String(text || ""));
  if (!rows.length) return {};
  const h = rows[0].map((x) => x.trim()), iC = h.indexOf("CURRENCY"), iT = h.indexOf("TIME_PERIOD"), iV = h.indexOf("OBS_VALUE");
  if (iC < 0 || iT < 0 || iV < 0) return {};
  const out = {};
  for (const r of rows.slice(1)) { const v = Number(r[iV]); if (r[iC] && DATE_RE.test(r[iT]) && v > 0) (out[r[iC]] = out[r[iC]] || []).push([r[iT], v]); }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}
export const ecbUrl = (ccys, start) => `https://data-api.ecb.europa.eu/service/data/EXR/D.${ccys.join("+")}.EUR.SP00.A?startPeriod=${start}&format=csvdata`;
async function ecbRates(origin, ctx, ccys, start) {
  if (!ccys.length) return { data: {} };
  return cachedSource({
    origin, key: `pf/ecb/${ccys.join("+")}/${start}`, ttlMs: 6 * 3600_000, staleMaxMs: 7 * 86400_000, ctx, failTtlMs: 5 * 60_000,
    load: async () => { const f = await fetchText(ecbUrl(ccys, start), { timeoutMs: 15000, headers: { accept: "text/csv" } }); if (f.err) return { err: f.err }; const d = parseEcbFx(f.text); return Object.keys(d).length ? { data: d } : { err: "no_data" }; },
  });
}
// EUR per 1 unit of the currency on a date: last ECB rate on or before it
export function eurPer(series, ccy, date) {
  const major = majorCcy(ccy), f = minorFactor(ccy);
  if (major === "EUR") return { v: f, rateDate: date };
  const s = series[major];
  if (!s) return null;
  let lo = 0, hi = s.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m][0] <= date) { best = m; lo = m + 1; } else hi = m - 1; }
  return best < 0 ? null : { v: f / s[best][1], rateDate: s[best][0] };
}

// ---------- positions (average cost) ----------
// returns { positions, realized, error? } — error when a SELL exceeds the quantity held at that date
export function buildPositions(txs, series) {
  const sorted = txs.slice().sort((a, b) => (a.date === b.date ? a.created - b.created : a.date < b.date ? -1 : 1));
  const P = {}, realized = { eur: 0, eurComplete: true }, fxUsed = {};
  for (const t of sorted) {
    const p = P[t.sym] || (P[t.sym] = { sym: t.sym, ccy: t.ccy, qty: 0, cost: 0, costEur: 0, costEurComplete: true, realized: 0, realizedEur: 0, firstDate: t.date, txCount: 0 });
    if (p.ccy !== t.ccy) return { error: `${t.sym}: currency ${t.ccy} differs from earlier transactions (${p.ccy})` };
    const fx = series ? eurPer(series, t.ccy, t.date) : null;
    if (fx) fxUsed[`${majorCcy(t.ccy)}@${t.date}`] = fx.rateDate;
    p.txCount++;
    if (t.side === "BUY") {
      const gross = t.qty * t.price + t.fees;
      p.qty = r6(p.qty + t.qty); p.cost += gross;
      if (fx) p.costEur += gross * fx.v; else p.costEurComplete = false;
    } else {
      if (t.qty > p.qty + 1e-9) return { error: `${t.sym}: selling ${t.qty} on ${t.date} but only ${p.qty} held then` };
      const avg = p.qty ? p.cost / p.qty : 0, avgEur = p.qty ? p.costEur / p.qty : 0, proceeds = t.qty * t.price - t.fees;
      p.realized += proceeds - avg * t.qty;
      if (fx && p.costEurComplete) { p.realizedEur += proceeds * fx.v - avgEur * t.qty; realized.eur += proceeds * fx.v - avgEur * t.qty; }
      else { p.costEurComplete = false; realized.eurComplete = false; }
      p.cost -= avg * t.qty; p.costEur -= avgEur * t.qty; p.qty = r6(p.qty - t.qty);
      if (p.qty === 0) { p.cost = 0; p.costEur = 0; }
    }
  }
  const positions = Object.values(P).map((p) => ({
    sym: p.sym, ccy: p.ccy, qty: p.qty, avgCost: p.qty ? r6(p.cost / p.qty) : null, cost: r6(p.cost),
    costEur: p.costEurComplete ? r6(p.costEur) : null, realized: r6(p.realized), realizedEur: p.costEurComplete ? r6(p.realizedEur) : null,
    firstDate: p.firstDate, txCount: p.txCount, open: p.qty > 0,
  })).sort((a, b) => (b.open - a.open) || (a.sym < b.sym ? -1 : 1));
  return { positions, realized: { eur: realized.eurComplete ? r6(realized.eur) : null }, fxUsed };
}

// ---------- storage ----------
async function loadTx(env) { try { const t = await env.BRIEFS.get(KEY); const a = t ? JSON.parse(t) : []; return Array.isArray(a) ? a : []; } catch { return []; } }

async function view(origin, env, ctx, txs) {
  const ccys = [...new Set(txs.map((t) => majorCcy(t.ccy)).filter((c) => c !== "EUR"))].sort();
  const start = txs.length ? txs.reduce((m, t) => (t.date < m ? t.date : m), "9999-12-31") : null;
  // ECB series from 10 days before the first trade (weekends / holidays have no fixing)
  const st = start ? new Date(Date.parse(start + "T00:00:00Z") - 10 * 86400_000).toISOString().slice(0, 10) : null;
  const fx = st ? await ecbRates(origin, ctx, ccys, st) : { data: {} };
  const b = buildPositions(txs, fx.data || null);
  const missingFx = ccys.filter((c) => !(fx.data && fx.data[c]));
  return {
    baseCurrency: BASE_CCY, transactions: txs.slice().sort((a, c) => (a.date === c.date ? c.created - a.created : a.date < c.date ? 1 : -1)),
    positions: b.positions || [], realized: b.realized || { eur: null }, error: b.error || null,
    costBasis: {
      method: "average cost", currencies: ccys,
      fx: { source: "ECB euro reference rates (ECB Data Portal, EXR)", url: "https://data.ecb.europa.eu/data/datasets/EXR", status: !ccys.length ? "LIVE" : fx.err && !fx.data ? "N/A" : fx.cache === "STALE" ? "STALE" : missingFx.length ? "PARTIAL" : "LIVE", missing: missingFx, ...(fx.err ? { error: fx.err } : {}), fetchedAt: fx.fetchedAt ? iso(fx.fetchedAt) : null },
    },
    valuation: "market value from live quotes in the page (Twelve Data); EUR value at the live EUR/<currency> rate — DERIVED",
    updatedAt: iso(Date.now()),
  };
}

export async function handlePortfolio(url, env, ctx, H, json, req) {
  const send = (body, status = 200) => { const r = json(body, H, status); r.headers.set("cache-control", "no-store"); return r; };
  if (!env.BRIEFS) return send({ error: "storage_not_configured", status: "N/A" }, 503);
  const sub = url.pathname.replace(/^\/api\/portfolio\/?/, ""), method = req ? req.method : "GET";
  if (sub === "" && method === "GET") return send(await view(url.origin, env, ctx, await loadTx(env)));
  if (sub !== "tx") return send({ error: "not found" }, 404);
  // writes: same-origin JSON only (a cross-site form cannot send application/json without a preflight)
  const origin = req.headers.get("origin");
  if (origin && origin !== (env.ALLOWED_ORIGIN || url.origin)) return send({ error: "forbidden_origin" }, 403);
  if (method === "POST") {
    if (!/^application\/json/i.test(req.headers.get("content-type") || "")) return send({ error: "bad_request", message: "JSON body required" }, 415);
    let body = null; try { body = await req.json(); } catch { return send({ error: "bad_request", message: "invalid JSON" }, 400); }
    const today = new Date(Date.now() + 14 * 3600_000).toISOString().slice(0, 10); // latest time zone's date: a trade made today anywhere
    const v = validateTx(body, today);
    if (typeof v === "string") return send({ error: "bad_request", message: v }, 400);
    const txs = await loadTx(env);
    if (txs.length >= MAX_TX) return send({ error: "bad_request", message: `limit of ${MAX_TX} transactions reached` }, 400);
    const tx = { id: crypto.randomUUID(), ...v, created: Date.now() };
    const check = buildPositions([...txs, tx], null);
    if (check.error) return send({ error: "invalid_transaction", message: check.error }, 409);
    await env.BRIEFS.put(KEY, JSON.stringify([...txs, tx]));
    return send({ added: tx.id, ...(await view(url.origin, env, ctx, [...txs, tx])) }, 201);
  }
  if (method === "DELETE") {
    const id = url.searchParams.get("id") || "", txs = await loadTx(env), rest = txs.filter((t) => t.id !== id);
    if (rest.length === txs.length) return send({ error: "not_found" }, 404);
    const check = buildPositions(rest, null);
    if (check.error) return send({ error: "invalid_transaction", message: `removing it would leave a sale without the shares: ${check.error}` }, 409);
    await env.BRIEFS.put(KEY, JSON.stringify(rest));
    return send({ removed: id, ...(await view(url.origin, env, ctx, rest)) });
  }
  return send({ error: "method_not_allowed" }, 405);
}
