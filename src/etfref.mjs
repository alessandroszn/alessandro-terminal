// The screener table of justETF reference data (KV ref/je/table): one tab-separated line per fund read — shared by the
// ETF section (etf.mjs) and the UCITS list (ucits.mjs). Reference data only, never prices.
import { iso } from "./lib.mjs";
// the compact line of a fund in the screener table: ISIN, TER, size (millions), size currency, A/D, P/S, replication
// method, domicile, fund currency, hedged 1/0, provider, investment focus, legal structure, inception, name, day read
export const TABLE_COLS = ["isin", "ter", "sizeM", "sizeCcy", "dist", "repl", "method", "domicile", "fundCcy", "hedged", "provider", "focus", "legal", "inception", "name", "day"];
const tsv = (v) => (v == null ? "" : String(v).replace(/[\t\n\r]/g, " "));
export function tableLine(isin, m, now) {
  const repl = m.replication ? (/^Synthetic|swap/i.test(m.replication) ? "S" : "P") : "", method = m.replication ? (m.replication.match(/\(([^)]+)\)/) || [])[1] || "" : "";
  return [isin, m.ter, m.fundSize ? Math.round(m.fundSize.value / 1e6) : "", m.fundSize ? m.fundSize.currency : "", m.distribution ? m.distribution[0] : "", repl, method, m.domicile, m.fundCurrency,
    m.hedged == null ? "" : m.hedged ? 1 : 0, m.provider, m.focus, m.legalStructure, m.inception, m.name, iso(now).slice(0, 10)].map(tsv).join("\t");
}
export function patchTable(table, isin, line) {
  const t = table || "", key = isin + "\t", i = t.startsWith(key) ? 0 : t.indexOf("\n" + key);
  if (i < 0) return t ? t + "\n" + line : line;
  const s = i === 0 ? 0 : i + 1, e = t.indexOf("\n", s);
  return t.slice(0, s) + line + (e < 0 ? "" : t.slice(e));
}
export function tableMap(table, only) {
  const out = new Map(); for (const l of String(table || "").split("\n")) { const f = l.split("\t"); if (f.length < TABLE_COLS.length || (only && !only.has(f[0]))) continue; out.set(f[0], f); }
  return out;
}
// a table line → the reference record shown by the UCITS list and the screener
export function refFromLine(f) {
  if (!f) return null;
  const n = (v) => (v === "" || v == null ? null : Number(v));
  return { ter: n(f[1]), fundSize: f[2] !== "" ? { value: n(f[2]) * 1e6, currency: f[3] || null } : null, distribution: f[4] === "A" ? "Accumulating" : f[4] === "D" ? "Distributing" : null,
    replication: f[5] ? (f[5] === "S" ? "Synthetic" : "Physical") + (f[6] ? ` (${f[6]})` : "") : null, domicile: f[7] || null, fundCurrency: f[8] || null, hedged: f[9] === "" ? null : f[9] === "1",
    provider: f[10] || null, focus: f[11] || null, legalStructure: f[12] || null, inception: f[13] || null, name: f[14] || null, day: f[15] || null };
}

