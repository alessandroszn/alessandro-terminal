// TEMPORARY (20 Oct 2026): which newly approved sources answer the Worker (CNBC markets, Nasdaq, RSS feeds, ApeWisdom).
// Fixed public URLs, plus CNBC quote symbols (only quote.cnbc.com). Owner-only (behind Access like every /api route).
const UA = "AlessandroTerminal/1.0 (+https://alessandrozanichelli.com/terminal)";
const BUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const day = new Date().toISOString().slice(0, 10);
const URLS = {
  nqCal: `https://api.nasdaq.com/api/calendar/economicevents?date=${day}`,
  nqCalY: `https://api.nasdaq.com/api/calendar/economicevents?date=2026-10-16`,
  nqScr: "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true",
  nqEtf: "https://api.nasdaq.com/api/screener/etf?tableonly=true&limit=25&offset=0&download=true",
  nqMov: "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&exchangestatus=currentMarket&limit=10",
  nqMov2: "https://api.nasdaq.com/api/marketmovers?assetclass=stocks",
  cnbcRss: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
  cnbcRss2: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
  reutAg: "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best",
  econFin: "https://www.economist.com/finance-and-economics/rss.xml",
  econBiz: "https://www.economist.com/business/rss.xml",
  soleFin: "https://www.ilsole24ore.com/rss/finanza.xml",
  soleEco: "https://www.ilsole24ore.com/rss/economia.xml",
  soleMondo: "https://www.ilsole24ore.com/rss/mondo.xml",
  ape: "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
  apeWsb: "https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1",
  barsSp5: `https://ts-api.cnbc.com/harmony/app/bars/%40SP.1/5M/${day.replace(/-/g, "")}000000/${day.replace(/-/g, "")}235900/adjusted/EST5EDT.json`,
  barsSpD: `https://ts-api.cnbc.com/harmony/app/bars/.SPX/1D/20260101000000/${day.replace(/-/g, "")}000000/adjusted/EST5EDT.json`,
};
const cnbcUrl = (syms) => `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms.map(encodeURIComponent).join("%7C")}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
export async function handleDiag(url, env, ctx, H, json) {
  const syms = url.searchParams.get("cnbc");
  if (syms) {
    const list = syms.split(",").filter(Boolean).slice(0, 200), out = {};
    for (let i = 0; i < list.length; i += 40) {
      try { const r = await fetch(cnbcUrl(list.slice(i, i + 40)), { headers: { "user-agent": UA, accept: "application/json" } }); const j = await r.json(); const q = (j.FormattedQuoteResult || {}).FormattedQuote || [];
        for (const x of q) out[x.symbol] = x.code === 0 && x.last ? [x.name, x.last, x.last_time, x.change_pct, x.previous_day_closing, x.exchange, x.curmktstatus, x.type, x.currencyCode || x.currency || "", x.expiration_date || x.maturity_date || ""] : ["code " + x.code]; } catch (e) { out["err" + i] = String(e && e.message); }
    }
    const r = json(out, H); r.headers.set("cache-control", "no-store"); return r;
  }
  const only = url.searchParams.get("only"), browser = url.searchParams.get("ua") === "b";
  const out = {};
  await Promise.all(Object.entries(URLS).filter(([k]) => !only || only.split(",").includes(k)).map(async ([k, u]) => {
    try {
      const r = await fetch(u, { headers: { "user-agent": browser ? BUA : UA, accept: "application/json, text/xml, application/rss+xml, */*", "accept-language": "en-US,en;q=0.9" } });
      const t = await r.text();
      out[k] = { status: r.status, type: r.headers.get("content-type"), size: t.length, head: t.slice(0, 600), tail: t.slice(-200) };
    } catch (e) { out[k] = { error: String(e && e.message) }; }
  }));
  const r = json(out, H); r.headers.set("cache-control", "no-store"); return r;
}
