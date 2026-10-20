// MARKETS IN THE BRIEFINGS (20 Oct 2026) — world indices, energy, the ECB fixing, crypto pairs and (monthly) IMF prices.
// The same loaders as the IDX, CMDTY, MKT and CRYPTO windows. The scheduled run stages each of them in its own minute
// (cron.mjs); an edition reads only those staged copies (Workers KV), also when the terminal writes it, so writing an
// edition never calls these sources. Every value keeps its own date and source; a period change is computed only from
// two values of the same source; nothing is filled in.
import { INDICES, getIndexGroup, getIndexHistory } from "./indices.mjs";
import { getEcbFx, getImf } from "./markets.mjs";
import { getEnergySpot } from "./macro.mjs";
import { getCloses, CRYPTO_PAIRS, alpacaConfigured } from "./spx.mjs";

export const BRIEF_ECB_N = 25; // fixings kept for the briefings: enough for a month's change
export const CRYPTO_SYMS = CRYPTO_PAIRS.map((x) => x.sym);
// the pairs of the markets board: EUR crosses as the ECB publishes them, the others through the dollar rate of the same fixing
export const BRIEF_FX = [["EUR", "GBP"], ["EUR", "JPY"], ["EUR", "CHF"], ["USD", "CHF"], ["USD", "CAD"], ["AUD", "USD"], ["NZD", "USD"], ["USD", "CNY"], ["USD", "SGD"],
  ["USD", "SEK"], ["USD", "NOK"], ["USD", "PLN"], ["USD", "TRY"], ["USD", "INR"], ["USD", "BRL"], ["USD", "MXN"], ["USD", "ZAR"], ["USD", "KRW"]];
const GROUP_NAME = { us: "United States", vol: "United States", eu: "Europe", sec: "Europe", sec2: "Europe", asia: "Asia-Pacific", world: "Americas & global" };
// the indices an edition reports (the IDX window has more): the benchmarks of each region with a time or a date
// (S&P/ASX 200 is left out: its source publishes no time); the STOXX Europe 600 sectors give the best and worst three
export const BRIEF_IDX = ["SPX", "NDX", "DJI", "COMP", "RUT", "VIX", "SX5E", "SXXP", "DAX", "SMI", "IBEX", "N225", "SHCOMP", "CSI300", "IBOV", "MXEF", "MXACW"];
export const BRIEF_GROUPS = ["us", "eu", "sec", "sec2", "asia", "world"];
const SECTOR_GROUPS = ["sec", "sec2"];
// indices whose week / month change needs their own history staged (the others come with their group's series)
export const BRIEF_HIST = BRIEF_IDX.filter((id) => ["cboe", "six", "sse"].includes((INDICES.find((x) => x.id === id) || {}).src));
const LONG = { weekly: { span: "1W", days: 7, crypto: "1W" }, monthly: { span: "1M", days: 30, crypto: "1M" } };

const shift = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const refDateOf = (period, d) => (LONG[period] ? shift(d, -LONG[period].days) : null);
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const pct = (a, b) => (fin(a) && fin(b) && b ? (a / b - 1) * 100 : null);
const f2 = (v) => (!fin(v) ? "N/A" : Math.abs(v) < 0.005 ? "0.00" : (v >= 0 ? "+" : "") + v.toFixed(2)); // no "-0.00"
const raw = (v) => (fin(v) ? String(+v.toFixed(6)) : "N/A");
const fx4 = (v) => (fin(v) ? String(+v.toFixed(v >= 100 ? 2 : 4)) : "N/A");

// the last value of a dated series against the last one on or before the reference date
export function refChange(series, refDate) {
  if (!series || series.length < 2 || !refDate) return null;
  const last = series[series.length - 1], base = series.filter(([d]) => d <= refDate).pop();
  return base && fin(base[1]) && base[1] > 0 && base[0] < last[0] ? { chg: pct(last[1], base[1]), last: last[1], lastDate: last[0], base: base[1], baseDate: base[0] } : null;
}
// a cross from the euro rates of one fixing (EUR/x as published; x/y through the euro: DERIVED)
export const ecbCross = (a, b, M) => { const x = b === "EUR" ? 1 : M[b], y = a === "EUR" ? 1 : M[a]; return fin(x) && fin(y) && y ? x / y : null; };

// ---------- inputs (staged copies only) ----------
// the last closes of an index's history, staged next to the full file so that writing an edition parses a few rows, not ten years
export const TAIL_ROWS = 60;
export const tailKey = (id) => `idx/tail/${id}`;
export const tailOf = (h) => ({ data: h.points.slice(-TAIL_ROWS).map((p) => [p[0], p[p.length - 1]]), source: h.source, fetchedAt: Date.now() });

export async function marketInputs(origin, env, ctx0, period, edition, now) {
  // each staged copy is read and parsed once (an index's series serves both its level and its period change)
  const memo = new Map(), ctx = ctx0 && ctx0.store ? { ...ctx0, store: { get: (k) => (memo.has(k) ? memo.get(k) : (memo.set(k, ctx0.store.get(k)), memo.get(k))), put: (...a) => ctx0.store.put(...a) } } : ctx0;
  const errors = {}, u = { origin }, L = LONG[period], refDate = refDateOf(period, edition.d);
  const rowsOf = (await Promise.all(BRIEF_GROUPS.map((g) => getIndexGroup(u, env, ctx, g, now)))).flat();
  let indices = BRIEF_IDX.map((id) => rowsOf.find((r) => r.id === id)).filter(Boolean), sectors = rowsOf.filter((r) => SECTOR_GROUPS.includes(r.group) && r.id !== "SX7E");
  const na = indices.filter((r) => r.status === "N/A");
  if (na.length) errors.indices = na.map((r) => `${r.id} ${r.error || "no_data"}`).join("; ");
  if (L) { // the week's / month's change from each index's own daily history
    const histOf = async (ix) => {
      const t = BRIEF_HIST.includes(ix.id) && ctx.store ? await ctx.store.get(tailKey(ix.id)) : null;
      if (t && t.data && t.data.length && now - t.fetchedAt < 3 * 86400_000) return { points: t.data, source: t.source };
      return getIndexHistory(u, env, ctx, ix);
    };
    const hist = await Promise.all(indices.map((r) => (r.status === "N/A" ? null : histOf(INDICES.find((x) => x.id === r.id)))));
    indices = indices.map((r, i) => { const h = hist[i], c = h && h.points ? refChange(h.points.map((p) => [p[0], p[p.length - 1]]), refDate) : null; return c ? { ...r, ref: { ...c, source: h.source } } : r; });
    const miss = indices.filter((r) => r.status !== "N/A" && !r.ref).map((r) => r.id);
    if (miss.length) errors.indexRef = miss.join(", ");
    const sh = await Promise.all(sectors.map((r) => (r.status === "N/A" ? null : getIndexHistory(u, env, ctx, INDICES.find((x) => x.id === r.id)))));
    sectors = sectors.map((r, i) => { const h = sh[i], c = h && h.points ? refChange(h.points.map((p) => [p[0], p[p.length - 1]]), refDate) : null; return c ? { ...r, ref: { ...c, source: h.source } } : r; });
  }
  const alp = alpacaConfigured(env);
  const [fx, energy, crypto, cryptoRef, imf] = await Promise.all([
    getEcbFx(origin, ctx, BRIEF_ECB_N),
    getEnergySpot(origin, env, ctx),
    alp ? getCloses(origin, env, ctx, "recent", CRYPTO_SYMS, now, "CRYPTO") : { err: "alpaca_not_configured" },
    L && alp ? getCloses(origin, env, ctx, L.crypto, CRYPTO_SYMS, now, "CRYPTO") : null,
    period === "monthly" ? getImf(origin, env, ctx) : null,
  ]);
  if (!fx.data) errors.ecbFx = fx.err;
  if (!energy.spot) errors.energy = energy.err;
  if (!crypto.data) errors.crypto = crypto.err;
  if (cryptoRef && !cryptoRef.data) errors.cryptoRef = cryptoRef.err;
  if (imf && !imf.data) errors.imf = imf.err;
  return {
    period, refDate, indices, sectors,
    ecb: fx.data ? { series: fx.data, fetchedAt: fx.fetchedAt } : null,
    energy: energy.spot ? { spot: energy.spot.map(({ history, ...x }) => x), source: energy.source, sourceUrl: energy.sourceUrl, fetchedAt: energy.fetchedAt } : null,
    crypto: crypto.data ? { closes: crypto.data, ref: cryptoRef && cryptoRef.data ? cryptoRef.data : null, refTarget: cryptoRef ? cryptoRef.target : null, fetchedAt: crypto.fetchedAt } : null,
    imf: imf && imf.data ? { rows: imf.data, fetchedAt: imf.fetchedAt } : null,
    errors,
  };
}

// ---------- rows (shared by the DATA lines and the windows) ----------
export function fxMoves(mk) {
  if (!mk || !mk.ecb || !mk.ecb.series.USD || !mk.ecb.series.USD.length) return [];
  // one fixing per cross: the dates of the dollar rate; a currency the ECB did not publish on that date is left out
  const S = mk.ecb.series, U = S.USD, d0 = U[U.length - 1][0], d1 = U.length > 1 ? U[U.length - 2][0] : null;
  const bd = mk.refDate ? (U.filter(([d]) => d <= mk.refDate).pop() || [null])[0] : null;
  const on = (d) => { if (!d) return {}; const o = {}; for (const [c, s] of Object.entries(S)) { const x = s.find((r) => r[0] === d); if (x) o[c] = x[1]; } return o; };
  const last = on(d0), prev = on(d1), base = on(bd);
  return BRIEF_FX.map(([a, b]) => {
    const v = ecbCross(a, b, last);
    if (!fin(v)) return null;
    const p = ecbCross(a, b, prev), r = ecbCross(a, b, base);
    return { pair: `${a}/${b}`, value: v, date: d0, chg: pct(v, p), prevDate: d1, ref: fin(r) && bd < d0 ? { chg: pct(v, r), baseDate: bd } : null, derived: a !== "EUR" };
  }).filter(Boolean);
}
export function cryptoMoves(mk, skip = []) {
  if (!mk || !mk.crypto) return [];
  const C = mk.crypto.closes, R = mk.crypto.ref || {};
  return CRYPTO_SYMS.filter((s) => !skip.includes(s) && C[s] && C[s].length).map((s) => {
    const b = C[s], l = b[b.length - 1], p = b.length > 1 ? b[b.length - 2] : null, r = R[s];
    return { sym: s, close: l[1], date: l[0], dv: l[2], chg: p ? pct(l[1], p[1]) : null, prevDate: p ? p[0] : null, ref: r && r[0] < l[0] ? { chg: pct(l[1], r[1]), baseDate: r[0] } : null };
  });
}
// the crypto lines: the most traded pairs, and the largest rise and fall if they are not among them
export function cryptoPick(rows, period) {
  const key = (r) => (LONG[period] ? r.ref && r.ref.chg : r.chg);
  const top = rows.slice().sort((a, b) => (b.dv || 0) - (a.dv || 0)).slice(0, 6);
  const moved = rows.filter((r) => fin(key(r))).sort((a, b) => key(b) - key(a));
  for (const r of [moved[0], moved[moved.length - 1]]) if (r && !top.includes(r)) top.push(r);
  return top;
}
export const energyRows = (mk) => (mk && mk.energy ? mk.energy.spot.filter((x) => fin(x.value)) : []);
const label = (r) => (r.name.includes(`(${r.id})`) ? r.name : `${r.name} (${r.id})`);
const nyClock = (isoT) => (isoT ? `${isoT.slice(0, 16).replace("T", " ")} UTC` : null);

// ---------- DATA lines ----------
export function marketLines(period, mk, { quoteSyms = [] } = {}) {
  const lines = [], sources = [], symbols = [], L = LONG[period];
  if (!mk) return { lines, sources, symbols };
  const srcAt = new Map();
  const note = (name, at, url) => { if (!name) return; const p = srcAt.get(name); if (!p || (at && at > p.at)) srcAt.set(name, { at, url }); };
  for (const r of mk.indices) {
    if (r.status === "N/A") { lines.push(`INDEX ${GROUP_NAME[r.group]} — ${label(r)}: N/A (${r.error || "no_data"})`); continue; }
    const when = r.kind === "delayed" ? `${r.delayMin ? r.delayMin + "-minute delayed" : "delayed"} quote, ${/Cboe/.test(r.source) ? "last trade" : "as of"} ${nyClock(r.asOf) || r.date}` : `close of ${r.date}`;
    const day = fin(r.chgPct) ? `${f2(r.chgPct)}% vs previous close ${raw(r.prev)}${r.prevDate ? ` of ${r.prevDate}` : ""}` : `day change N/A${r.note ? ` (${r.note})` : ""}`;
    lines.push(`INDEX ${GROUP_NAME[r.group]} — ${label(r)}: ${raw(r.last)}${r.id === "VIX" ? " points" : ""}, ${day}; ${when} [${r.source}${r.derived ? "; DERIVED" : ""}]`);
    if (r.ref) lines.push(`INDEX_${L.span} ${label(r)}: ${f2(r.ref.chg)}% — close ${raw(r.ref.last)} on ${r.ref.lastDate} vs ${raw(r.ref.base)} on ${r.ref.baseDate} [${r.ref.source}]`);
    note(r.source, r.asOf || r.fetchedAt, r.sourceUrl);
  }
  // STOXX Europe 600 sectors: the three strongest and the three weakest (day, or the edition's week / month)
  const sk = (r) => (L ? r.ref && r.ref.chg : r.chgPct);
  const ss = (mk.sectors || []).filter((r) => r.status !== "N/A" && fin(sk(r))).sort((a, b) => sk(b) - sk(a));
  for (const r of ss.length > 6 ? [...ss.slice(0, 3), ...ss.slice(-3)] : ss) {
    lines.push(L ? `SECTOR_EU ${r.name}: ${f2(r.ref.chg)}% (${L.span}) — close ${raw(r.ref.last)} on ${r.ref.lastDate} vs ${raw(r.ref.base)} on ${r.ref.baseDate} [STOXX daily close]`
      : `SECTOR_EU ${r.name}: ${f2(r.chgPct)}% on the day — close ${raw(r.last)} on ${r.date} [STOXX daily close]`);
  }
  if (ss.length) note("STOXX Europe 600 sector indices (daily close)", ss.map((r) => r.date).sort().pop(), "https://www.stoxx.com/");
  const fx = fxMoves(mk);
  // EUR/USD only when the live quote is missing (the live quote is in the QUOTE lines)
  if (mk.ecb && !quoteSyms.includes("EUR/USD")) { const s = mk.ecb.series.USD; if (s && s.length) fx.unshift({ pair: "EUR/USD", value: s[s.length - 1][1], date: s[s.length - 1][0], chg: s.length > 1 ? pct(s[s.length - 1][1], s[s.length - 2][1]) : null, prevDate: s.length > 1 ? s[s.length - 2][0] : null, ref: null, derived: false }); }
  for (const x of fx) {
    lines.push(`FX_ECB ${x.pair}: ${fx4(x.value)} — ECB fixing of ${x.date}${x.derived ? " (DERIVED through the euro rates of the same fixing)" : ""}, ${fin(x.chg) ? `${f2(x.chg)}% vs the fixing of ${x.prevDate}` : "change N/A"}${L && x.ref ? `; ${L.span} change ${f2(x.ref.chg)}% vs the fixing of ${x.ref.baseDate}` : ""} [ECB euro reference rates]`);
  }
  if (fx.length) note("ECB euro reference rates (daily fixing around 16:00 CET)", fx[0].date, "https://data.ecb.europa.eu/data/datasets/EXR");
  const en = energyRows(mk);
  for (const x of en) {
    const k = period === "monthly" ? ["chg21", "21 sessions"] : period === "weekly" ? ["chg5", "5 sessions"] : null;
    lines.push(`ENERGY ${x.name}: ${raw(x.value)} ${x.unit} on ${x.date}, ${fin(x.chg1) ? `${f2(x.chg1)}% vs the previous published day` : "change N/A"}${k && fin(x[k[0]]) ? `, ${f2(x[k[0]])}% over ${k[1]}` : ""} [${mk.energy.source}; published with a lag of about a week]`);
  }
  if (en.length) note(mk.energy.source, en.map((x) => x.date).sort().pop(), mk.energy.sourceUrl);
  const cr = cryptoPick(cryptoMoves(mk, quoteSyms.filter((s) => s === "BTC/USD" || s === "ETH/USD")), period);
  for (const r of cr) {
    symbols.push(r.sym);
    lines.push(`CRYPTO \`${r.sym}\`: close ${raw(r.close)} USD on the UTC day ${r.date}, ${fin(r.chg) ? `${f2(r.chg)}% vs the close of ${r.prevDate}` : "change N/A"}${L && r.ref ? `; ${L.span} change ${f2(r.ref.chg)}% vs the close of ${r.ref.baseDate}` : ""} [Alpaca crypto, US venues; completed UTC days]`);
  }
  if (cr.length) note("Alpaca crypto daily closes (US venues, UTC days)", cr.map((r) => r.date).sort().pop());
  if (mk.imf) {
    for (const x of mk.imf.rows) if (fin(x.value)) lines.push(`CMDTY_MONTHLY ${x.name}: ${raw(x.value)} ${x.unit}, average of ${x.date.slice(0, 7)}, ${fin(x.chgPct) ? `${f2(x.chgPct)}% vs ${String(x.prevDate || "").slice(0, 7)}` : "change N/A"}${fin(x.yoyPct) ? `, ${f2(x.yoyPct)}% vs a year earlier` : ""} [IMF Primary Commodity Prices via FRED]`);
    note("IMF Primary Commodity Prices (via FRED), monthly averages", mk.imf.rows.map((x) => x.date).filter(Boolean).sort().pop(), "https://fred.stlouisfed.org/");
  }
  for (const [name, v] of srcAt) sources.push({ name, timestamp: v.at, ...(v.url ? { url: v.url } : {}) });
  return { lines, sources, symbols };
}

// ---------- windows ----------
const pc = (v) => `${f2(v)}%`;
// the benchmark indices a window can lead with (not the VIX, not a sector or mid-cap index)
const HEADLINE = ["SPX", "NDX", "DJI", "COMP", "RUT", "SX5E", "SXXP", "DAX", "SMI", "IBEX", "N225", "SHCOMP", "CSI300", "IBOV", "MXEF", "MXACW"];
export function marketWindows(period, mk, add, { quoteSyms = [] } = {}) {
  if (!mk) return;
  const L = LONG[period], span = L ? L.span : "1D";
  const idx = mk.indices.filter((r) => r.status !== "N/A" && HEADLINE.includes(r.id)).map((r) => ({ r, v: L ? r.ref && r.ref.chg : r.chgPct })).filter((x) => fin(x.v)).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
  if (idx) add("eq", "IDX", { id: idx.r.id, rng: period === "monthly" ? "6M" : L ? "3M" : "1M" },
    [`${idx.r.name} · ${pc(idx.v)} ${span}`, `${idx.r.name} ${pc(idx.v)} (${span}), the largest move among the benchmark indices; every index with its history in IDX.`],
    [`${idx.r.name} · ${pc(idx.v)} ${span}`, `${idx.r.name} ${pc(idx.v)} (${span}), il movimento più ampio tra gli indici di riferimento; tutti gli indici con lo storico in IDX.`]);
  const fx = fxMoves(mk).map((x) => ({ x, v: L ? x.ref && x.ref.chg : x.chg })).filter((y) => fin(y.v)).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
  if (fx) add("fx", "MKT", {}, [`ECB fixing · ${fx.x.pair} ${pc(fx.v)}`, `${fx.x.pair} ${pc(fx.v)} (${span}, ECB fixing of ${fx.x.date}), the largest move among the ECB rates; all of them on the markets board.`],
    [`Fixing BCE · ${fx.x.pair} ${pc(fx.v)}`, `${fx.x.pair} ${pc(fx.v)} (${span}, fixing BCE del ${fx.x.date}), il movimento più ampio tra i cambi BCE; tutti nel quadro dei mercati.`]);
  const en = energyRows(mk), oil = en.find((x) => /^(DCOILWTICO|RWTC)$/.test(x.series)) || en[0];
  if (oil) { const v = period === "monthly" ? oil.chg21 : period === "weekly" ? oil.chg5 : oil.chg1;
    add("cmd", "CMDTY", {}, [`${oil.name} · ${raw(oil.value)} ${oil.unit} (${oil.date})`, `${oil.name} ${raw(oil.value)} ${oil.unit} on ${oil.date}${fin(v) ? `, ${pc(v)}` : ""} — EIA publishes with a lag of about a week; Brent, gas and fuels in CMDTY.`],
      [`${oil.name} · ${raw(oil.value)} ${oil.unit} (${oil.date})`, `${oil.name} ${raw(oil.value)} ${oil.unit} il ${oil.date}${fin(v) ? `, ${pc(v)}` : ""} — l'EIA pubblica con circa una settimana di ritardo; Brent, gas e carburanti in CMDTY.`]); }
  if (!quoteSyms.includes("BTC/USD")) { // no live bitcoin quote: the crypto board from the Alpaca closes
    const c = cryptoMoves(mk).map((r) => ({ r, v: L ? r.ref && r.ref.chg : r.chg })).filter((y) => fin(y.v)).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
    if (c) add("cmd", "CRYPTO", { metric: span, sort: "dv" }, [`Crypto board · ${span}`, `${c.r.sym} ${pc(c.v)} (${span}, UTC-day closes), the largest move among the pairs; all of them by traded value.`],
      [`Quadro cripto · ${span}`, `${c.r.sym} ${pc(c.v)} (${span}, chiusure del giorno UTC), il movimento più ampio tra le coppie; tutte per controvalore scambiato.`]);
  }
}
