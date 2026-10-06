// Alessandro Terminal — data proxy (Cloudflare Worker)
// Vertical slice T01/T02: GET /api/health, GET /api/quote?symbols=AAPL,MSFT
// The Twelve Data API key lives ONLY here (as a secret), never in the client.
//   Deploy:  wrangler deploy
//   Secret:  wrangler secret put TWELVEDATA_KEY
//   (optional) set ALLOWED_ORIGIN to your Pages URL instead of "*"

const TD_BASE = "https://api.twelvedata.com";

// --- pure normalizer: Twelve Data /quote -> our Quote schema (unit-tested) ---
export function normalizeQuote(sym, q) {
  if (!q || q.status === "error" || q.close == null) return null;
  const price = Number(q.close);
  const prev = q.previous_close != null ? Number(q.previous_close) : null;
  const pct = q.percent_change != null
    ? Number(q.percent_change)
    : (prev ? (price / prev - 1) * 100 : null);
  let asOf;
  try {
    asOf = q.timestamp ? new Date(q.timestamp * 1000).toISOString()
         : q.datetime  ? new Date(q.datetime).toISOString()
         : new Date().toISOString();
  } catch { asOf = new Date().toISOString(); }
  return {
    symbol: sym,
    name: q.name ?? null,
    price,
    prevClose: Number.isFinite(prev) ? prev : null,
    changePct: pct != null && Number.isFinite(pct) ? pct : null,
    open: q.open != null ? Number(q.open) : null,
    high: q.high != null ? Number(q.high) : null,
    low:  q.low  != null ? Number(q.low)  : null,
    volume: q.volume != null ? Number(q.volume) : null,
    currency: q.currency ?? "USD",
    fiftyTwoWeekLow:  q.fifty_two_week ? Number(q.fifty_two_week.low)  : null,
    fiftyTwoWeekHigh: q.fifty_two_week ? Number(q.fifty_two_week.high) : null,
    asOf,
    provider: "twelvedata",
  };
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}
function json(obj, headers, status = 200, cacheSec = 0) {
  const h = { ...headers, "content-type": "application/json" };
  if (cacheSec) h["cache-control"] = `public, max-age=${cacheSec}`;
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const H = cors(env);
    if (req.method === "OPTIONS") return new Response(null, { headers: H });

    if (url.pathname === "/api/health") {
      return json({ ok: true, ts: Date.now() }, H);
    }

    if (url.pathname === "/api/quote") {
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
      if (!symbols.length) return json({ error: "no symbols" }, H, 400);
      const key = env.TWELVEDATA_KEY;
      if (!key) return json({ error: "server not configured (TWELVEDATA_KEY missing)" }, H, 500);

      const quotes = {};
      let stale = false;
      for (const s of symbols) {
        try {
          const r = await fetch(`${TD_BASE}/quote?symbol=${encodeURIComponent(s)}&apikey=${key}`);
          const q = await r.json();
          const n = normalizeQuote(s, q);
          if (n) quotes[s] = n; else stale = true;
        } catch { stale = true; }
      }
      // 45s edge cache; on provider trouble, response still returns what we have (stale flag)
      return json({ quotes, asOf: new Date().toISOString(), provider: "twelvedata", stale }, H, 200, 45);
    }

    return json({ error: "not found" }, H, 404);
  },
};
