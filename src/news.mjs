// NEWS — SEC EDGAR filings for the watchlist (U.S. government data, free redistribution; fair-access policy).
// Headlines come from the top publishers' and central banks' own feeds (press.mjs, /api/headlines).
// The GDELT wire was removed: it indexed any site, quality not controllable.
// Only form, company, time and link are shown. Nothing is generated.
import { fetchText, cachedSource, iso } from "./lib.mjs";

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const SEC_SUBMISSIONS_URL = (cik10) => `https://data.sec.gov/submissions/CIK${cik10}.json`;
export const SEC_FORMS = new Set(["8-K", "10-Q", "10-K", "20-F", "6-K", "DEF 14A", "S-1", "S-3", "SC 13D", "SC 13G"]);

export function secCikMap(tickersJson) {
  const map = {};
  for (const v of Object.values(tickersJson || {})) if (v && v.ticker && v.cik_str != null) map[String(v.ticker).toUpperCase()] = { cik: Number(v.cik_str), name: v.title };
  return map;
}

export function normalizeSecSubmissions(j, ticker, limit = 5) {
  const r = j && j.filings && j.filings.recent; if (!r || !Array.isArray(r.form)) return [];
  const cik = Number(j.cik), out = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    if (!SEC_FORMS.has(r.form[i])) continue;
    const acc = String(r.accessionNumber[i] || ""), doc = r.primaryDocument && r.primaryDocument[i];
    if (!acc) continue;
    const ts = r.acceptanceDateTime && r.acceptanceDateTime[i] ? new Date(r.acceptanceDateTime[i]).toISOString() : (r.filingDate[i] ? `${r.filingDate[i]}T00:00:00.000Z` : null);
    out.push({
      ticker, company: j.name || null, form: r.form[i],
      description: (r.primaryDocDescription && r.primaryDocDescription[i]) || null,
      filingDate: r.filingDate[i] || null, timestamp: ts,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${doc || acc + "-index.htm"}`,
      provider: "SEC EDGAR",
    });
  }
  return out;
}

const parseJson = (r) => { if (r.err) return { err: r.err }; try { return { j: JSON.parse(r.text) }; } catch { return { err: "provider_error" }; } };
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

export async function handleNews(url, env, ctx, H, json) {
  const now = Date.now();
  const tickers = [...new Set((url.searchParams.get("tickers") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s)))].slice(0, 8);
  const secHeaders = { accept: "application/json", ...(env.SEC_CONTACT ? { "user-agent": `AlessandroTerminal ${env.SEC_CONTACT}` } : {}) };

  let filings = [], secStatus = null, secErr = null;
  if (tickers.length) {
    const map = await cachedSource({
      origin: url.origin, key: "news/sec-tickers", ttlMs: 24 * 3600_000, staleMaxMs: 30 * 86400_000, ctx,
      load: async () => { const p = parseJson(await fetchText(SEC_TICKERS_URL, { headers: secHeaders, timeoutMs: 10000 })); if (p.err) return p; const m = secCikMap(p.j); return Object.keys(m).length ? { data: m } : { err: "no_data" }; },
    });
    if (map.err) secErr = map.err;
    else {
      const per = await Promise.all(tickers.map((t) => {
        const c = map.data[t]; if (!c) return Promise.resolve({ data: [] });
        return cachedSource({
          origin: url.origin, key: `news/sec/${t}`, ttlMs: 30 * 60_000, staleMaxMs: 7 * 86400_000, ctx,
          load: async () => { const p = parseJson(await fetchText(SEC_SUBMISSIONS_URL(String(c.cik).padStart(10, "0")), { headers: secHeaders })); if (p.err) return p; return { data: normalizeSecSubmissions(p.j, t) }; },
        });
      }));
      const okOnes = per.filter((p) => p.data);
      filings = okOnes.flatMap((p) => p.data).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      secStatus = okOnes.length ? (per.some((p) => p.cache === "STALE") ? "STALE" : "LIVE") : null;
      if (!okOnes.length) secErr = (per.find((p) => p.err) || {}).err || "no_data";
    }
  }

  const sources = [];
  if (secStatus) sources.push({ id: "SEC", name: "SEC EDGAR", url: "https://www.sec.gov/edgar/search/", status: secStatus, fetchedAt: iso(now) });
  const errors = {};
  if (secErr) errors.SEC = { error: secErr, status: "N/A", ...(secErr === "provider_forbidden" && !env.SEC_CONTACT ? { note: "SEC requires a contact in the User-Agent: set SEC_CONTACT" } : {}) };
  const r = json({ filings, sources, errors, tickers, meta: { generatedAt: iso(now) } }, H, !tickers.length || sources.length ? 200 : 502);
  r.headers.set("cache-control", "no-store");
  return r;
}
