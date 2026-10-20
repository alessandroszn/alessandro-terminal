// TEMPORARY (21 Oct 2026): what the approved providers offer for the remaining pieces, as the Worker sees them —
// CNBC (international stocks), Nasdaq (analysts, holders, short interest), Reuters (its own published sitemaps).
// Fixed public URLs, plus CNBC quote symbols (only quote.cnbc.com) and Nasdaq paths (only api.nasdaq.com). Owner-only.
const UA = "AlessandroTerminal/1.0 (+https://alessandrozanichelli.com/terminal)";
const BUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const NQ = { "user-agent": BUA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", origin: "https://www.nasdaq.com", referer: "https://www.nasdaq.com/" };
const URLS = {
  reutNews: "https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml",
  reutIndex: "https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml",
  reutRss: "https://www.reuters.com/arc/outboundfeeds/v3/all/?outputType=xml",
  reutBiz: "https://www.reuters.com/arc/outboundfeeds/v3/business/?outputType=xml",
};
const FINRA = {
  shvol: "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20261020.txt",
  apiGet: "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest?limit=3",
  apiMeta: "https://api.finra.org/metadata/group/otcMarket/name/consolidatedShortInterest",
  biweekly: "https://cdn.finra.org/equity/otcmarket/biweekly/shrt20260930.csv",
};
const cnbcUrl = (syms) => `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms.map(encodeURIComponent).join("%7C")}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
export async function handleDiag(url, env, ctx, H, json) {
  const send = (o) => { const r = json(o, H); r.headers.set("cache-control", "no-store"); return r; };
  const syms = url.searchParams.get("cnbc");
  if (syms) {
    const list = syms.split(",").filter(Boolean).slice(0, 120), out = {}, full = url.searchParams.get("full") === "1";
    for (let i = 0; i < list.length; i += 40) {
      try { const r = await fetch(cnbcUrl(list.slice(i, i + 40)), { headers: { "user-agent": UA, accept: "application/json" } }); const j = await r.json(); const q = (j.FormattedQuoteResult || {}).FormattedQuote || [];
        for (const x of q) out[x.symbol] = full ? x : x.code === 0 && x.last ? [x.name, x.last, x.last_time, x.exchange, x.currencyCode, x.realTime] : null;
      } catch (e) { out.error = String(e && e.message); }
    }
    return send(out);
  }
  const bars = url.searchParams.get("bars");
  if (bars) {
    const iv = url.searchParams.get("iv") || "1D", now = new Date(), ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const u = `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(bars)}/${iv}/${ymd(new Date(now - 30 * 864e5))}000000/${ymd(now)}235900/adjusted/EST5EDT.json`;
    const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } }); const t = await r.text();
    return send({ status: r.status, size: t.length, head: t.slice(0, 900) });
  }
  if (url.searchParams.get("finra")) {
    const out = {};
    for (const [k, u] of Object.entries(FINRA)) {
      try { const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json, text/plain, */*" } }); const t = await r.text(); out[k] = { status: r.status, type: r.headers.get("content-type"), size: t.length, head: t.slice(0, 1200) }; } catch (e) { out[k] = { error: String(e && e.message) }; }
    }
    try {
      const r = await fetch("https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest", { method: "POST", headers: { "user-agent": UA, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ limit: 3, sortFields: ["-currentShortPositionQuantity"], compareFilters: [{ compareType: "EQUAL", fieldName: "settlementDate", fieldValue: "2026-09-30" }] }) });
      const t = await r.text(); out.apiPost = { status: r.status, size: t.length, head: t.slice(0, 1500) };
    } catch (e) { out.apiPost = { error: String(e && e.message) }; }
    return send(out);
  }
  const lk = url.searchParams.get("lookup");
  if (lk) {
    const u = `https://symlookup.cnbc.com/symservice/symlookup.do?prefix=${encodeURIComponent(lk)}&partnerid=20064&fund=1&output=json`;
    const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } }); const t = await r.text();
    return send({ status: r.status, size: t.length, head: t.slice(0, 2500) });
  }
  const nq = url.searchParams.get("nq");
  if (nq) {
    if (!/^\/api\/[A-Za-z0-9/._-]+$/.test(nq.split("?")[0])) return send({ error: "bad path" });
    const r = await fetch("https://api.nasdaq.com" + nq, { headers: NQ }); const t = await r.text();
    return send({ status: r.status, size: t.length, head: t.slice(0, Number(url.searchParams.get("n")) || 1500) });
  }
  const only = url.searchParams.get("only"), browser = url.searchParams.get("ua") === "b", out = {};
  await Promise.all(Object.entries(URLS).filter(([k]) => !only || only.split(",").includes(k)).map(async ([k, u]) => {
    try {
      const r = await fetch(u, { headers: { "user-agent": browser ? BUA : UA, accept: "application/xml, text/xml, application/rss+xml, */*", "accept-language": "en-US,en;q=0.9" } });
      const t = await r.text();
      out[k] = { status: r.status, type: r.headers.get("content-type"), size: t.length, head: t.slice(0, 900), tail: t.slice(-200) };
    } catch (e) { out[k] = { error: String(e && e.message) }; }
  }));
  return send(out);
}
