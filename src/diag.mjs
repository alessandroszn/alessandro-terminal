// TEMPORARY (20 Oct 2026): what candidate sources answer the Worker — fixed list of public URLs, status, type, size,
// first bytes. Owner-only (behind Access like every /api route). Removed once the sources are wired.
const UA = "AlessandroTerminal/1.0 (+https://alessandrozanichelli.com/terminal)";
const URLS = {
  cnbc: "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US10Y%7CIT10Y-IT%7CIT2Y-IT%7CIT30Y-IT%7CDE10Y-DE%7CGB10Y-GB%7CFR10Y-FR%7CNL10Y-NL&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1",
  boeZip: "https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/latest-yield-curve-data.zip",
  snbRss: "https://www.snb.ch/public/rss/en/interestRates",
  bdi: "https://a2a.bancaditalia.it/infostat/dataservices/export/EN/CSV/DATA/CUBE/BANKITALIA/DIFF/BMK0200",
  dst: "https://api.statbank.dk/v1/tableinfo/DNRENTD?format=JSON",
  hkma: "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/efbn/efbn-yield-daily?pagesize=3",
  tesouro: "https://www.tesourodireto.com.br/json/br/com/b3/tesourodireto/service/api/treasurybondsinfo.json",
  bisV1: "https://stats.bis.org/api/v1/data/WS_CBPOL/D.US+XM+GB+JP+AU+NZ+CN+IN/all?startPeriod=2026-10-01&detail=dataonly",
  bisV2csv: "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D.US+XM+JP?startPeriod=2026-10-01&format=csv",
  bisM: "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.US?startPeriod=2006-01&format=csv",
};
export async function handleDiag(url, env, ctx, H, json) {
  const one = async (u) => {
    try {
      const r = await fetch(u, { headers: { "user-agent": UA, accept: "*/*" } });
      const b = new Uint8Array(await r.arrayBuffer());
      const head = new TextDecoder().decode(b.slice(0, 700));
      return { status: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), size: b.length, head };
    } catch (e) { return { status: "err", error: String(e && e.message) }; }
  };
  const only = url.searchParams.get("only");
  const out = {};
  for (const [k, u] of Object.entries(URLS)) if (!only || only.split(",").includes(k)) out[k] = await one(u);
  const r = json(out, H); r.headers.set("cache-control", "no-store"); return r;
}
