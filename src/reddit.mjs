// REDDIT MENTIONS (RDT) — ApeWisdom, approved 20 Oct 2026: the tickers mentioned most on Reddit in the last 24 hours, with
// upvotes and where each ticker stood 24 hours earlier, as ApeWisdom counts them. A count of mentions, not a sentiment.
//   GET /api/reddit?filter=all-stocks|wallstreetbets|stocks|investing|options|all-crypto
import { fetchText, cachedSource, iso } from "./lib.mjs";

export const APE_FILTERS = { "all-stocks": "All stock subreddits", wallstreetbets: "r/wallstreetbets", stocks: "r/stocks", investing: "r/investing", options: "r/options", "all-crypto": "All crypto subreddits" };
export const apeUrl = (filter, page = 1) => `https://apewisdom.io/api/v1.0/filter/${filter}/page/${page}`;
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const dec = (s) => String(s == null ? "" : s).replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, e) => ENT[e]).trim();
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
export function parseApe(j) {
  const rows = j && Array.isArray(j.results) ? j.results : [];
  return rows.map((r) => ({ rank: int(r.rank), ticker: String(r.ticker || "").trim().toUpperCase(), name: dec(r.name), mentions: int(r.mentions), upvotes: int(r.upvotes), rank24h: int(r.rank_24h_ago), mentions24h: int(r.mentions_24h_ago) }))
    .filter((r) => r.ticker && r.rank != null && r.mentions != null);
}
export async function handleReddit(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const filter = String(url.searchParams.get("filter") || "all-stocks");
  if (!APE_FILTERS[filter]) return send({ error: "bad_request", message: "filter: " + Object.keys(APE_FILTERS).join(", ") }, 400);
  const r = await cachedSource({ origin: url.origin, key: `ape/${filter}`, ttlMs: 15 * 60_000, staleMaxMs: 3 * 86400_000, failTtlMs: 5 * 60_000, ctx, load: async () => {
    const f = await fetchText(apeUrl(filter), { timeoutMs: 10000, headers: { accept: "application/json" } });
    if (f.err) return { err: f.err };
    let j; try { j = JSON.parse(f.text); } catch { return { err: "provider_error" }; }
    const rows = parseApe(j).slice(0, 100); return rows.length ? { data: rows } : { err: "no_data" };
  } });
  if (!r.data) return send({ filter, status: "N/A", error: r.err, source: "ApeWisdom", sourceUrl: "https://apewisdom.io/" }, 502);
  return send({ filter, name: APE_FILTERS[filter], rows: r.data, source: "ApeWisdom", sourceUrl: "https://apewisdom.io/", basis: "mentions and upvotes in the last 24 hours as ApeWisdom counts them, and the rank / mentions 24 hours earlier; changes DERIVED", status: r.cache === "STALE" ? "STALE" : "LIVE", fetchedAt: iso(r.fetchedAt) });
}
