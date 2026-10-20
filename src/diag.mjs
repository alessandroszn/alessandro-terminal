// TEMPORARY (20 Oct 2026): how CNBC stamps the daily bars of European bonds (time zone of the bar date) — fixed public URLs,
// owner-only (behind Access like every /api route). Removed once checked.
const UA = "AlessandroTerminal/1.0 (+https://alessandrozanichelli.com/terminal)";
const B = (sym, iv, a, b, tz) => `https://ts-api.cnbc.com/harmony/app/bars/${sym}/${iv}/${a}000000/${b}000000/adjusted/${tz}.json`;
const URLS = {
  est: B("IT10Y-IT", "1D", "20261012", "20261021", "EST5EDT"),
  utc: B("IT10Y-IT", "1D", "20261012", "20261021", "UTC"),
  gmt: B("IT10Y-IT", "1D", "20261012", "20261021", "GMT"),
  cet: B("IT10Y-IT", "1D", "20261012", "20261021", "CET"),
  h1: B("IT10Y-IT", "1H", "20261016", "20261021", "EST5EDT"),
  m60: B("IT10Y-IT", "60M", "20261016", "20261021", "EST5EDT"),
  jp: B("JP10Y-JP", "1D", "20261012", "20261021", "EST5EDT"),
};
export async function handleDiag(url, env, ctx, H, json) {
  const out = {};
  for (const [k, u] of Object.entries(URLS)) {
    try {
      const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } }); const t = await r.text(); let bars = null;
      try { bars = (JSON.parse(t).barData || {}).priceBars || null; } catch {}
      out[k] = { status: r.status, size: t.length, bars: bars ? bars.map((b) => [b.tradeTime, b.tradeTimeinMills, b.open, b.close]) : t.slice(0, 300) };
    } catch (e) { out[k] = { error: String(e && e.message) }; }
  }
  const r = json(out, H); r.headers.set("cache-control", "no-store"); return r;
}
