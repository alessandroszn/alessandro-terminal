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
  bisV1csv: "https://stats.bis.org/api/v1/data/WS_CBPOL/D.US+XM/all?startPeriod=2026-10-01&detail=dataonly&format=csv",
  bisAll: "https://stats.bis.org/api/v1/data/WS_CBPOL/D./all?startPeriod=2026-10-12&detail=dataonly",
  cnbcBars: "https://ts-api.cnbc.com/harmony/app/bars/IT10Y-IT/1D/20260801000000/20261020000000/adjusted/EST5EDT.json",
  cnbcBars2: "https://ts-api.cnbc.com/harmony/app/bars/US10Y/1D/20260101000000/20261020000000/adjusted/EST5EDT.json",
  ffNext: "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
  cnbcBars5y: "https://ts-api.cnbc.com/harmony/app/bars/US10Y/1D/20211020000000/20261020000000/adjusted/EST5EDT.json",
  fedCal: "https://www.federalreserve.gov/json/calendar.json",
};
const BIS = {
  d: "https://stats.bis.org/api/v1/data/WS_CBPOL/D./all?startPeriod=2025-09-01&detail=dataonly&format=csv",
  m: "https://stats.bis.org/api/v1/data/WS_CBPOL/M./all?startPeriod=2006-01&detail=dataonly&format=csv",
};
const T = (cc, list, suf) => list.map((t) => `${cc}${t}${suf}`);
const CNBC_ALL = [
  ...T("US", ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"], ""),
  ...T("DE", ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"], "-DE"),
  ...T("IT", ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"], "-IT"),
  ...T("FR", ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"], "-FR"),
  ...T("ES", ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"], "-ES"),
  ...T("PT", ["2Y", "3Y", "5Y", "7Y", "10Y", "30Y"], "-PT"), ...T("GR", ["2Y", "3Y", "5Y", "10Y", "30Y"], "-GR"), ...T("NL", ["2Y", "5Y", "10Y", "30Y"], "-NL"),
  ...T("GB", ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"], "-GB"), ...T("CH", ["2Y", "5Y", "10Y", "30Y"], "-CH"),
  ...T("JP", ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y", "40Y"], "-JP"), ...T("CN", ["1Y", "2Y", "5Y", "10Y", "30Y"], "-CN"),
  ...T("CA", ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"], "-CA"), ...T("AU", ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"], "-AU"),
  ...T("AT", ["2Y", "5Y", "10Y", "30Y"], "-AT"), ...T("BE", ["2Y", "5Y", "10Y", "30Y"], "-BE"), ...T("IE", ["2Y", "5Y", "10Y", "30Y"], "-IE"), ...T("FI", ["2Y", "5Y", "10Y"], "-FI"),
  ...T("DK", ["2Y", "5Y", "10Y"], "-DK"), ...T("SE", ["2Y", "5Y", "10Y"], "-SE"), ...T("NO", ["3Y", "10Y"], "-NO"), ...T("PL", ["2Y", "5Y", "10Y"], "-PL"), ...T("CZ", ["2Y", "5Y", "10Y"], "-CZ"),
  ...T("HU", ["3Y", "5Y", "10Y"], "-HU"), ...T("KR", ["2Y", "3Y", "5Y", "10Y", "30Y"], "-KR"), ...T("IN", ["2Y", "5Y", "10Y", "30Y"], "-IN"), ...T("BR", ["2Y", "5Y", "10Y"], "-BR"),
  ...T("MX", ["2Y", "5Y", "10Y", "30Y"], "-MX"), ...T("ZA", ["2Y", "5Y", "10Y", "30Y"], "-ZA"), ...T("TR", ["2Y", "5Y", "10Y"], "-TR"), ...T("NZ", ["2Y", "5Y", "10Y"], "-NZ"),
  ...T("SG", ["2Y", "5Y", "10Y"], "-SG"), ...T("HK", ["2Y", "5Y", "10Y"], "-HK"), ...T("ID", ["5Y", "10Y"], "-ID"), ...T("IL", ["2Y", "5Y", "10Y"], "-IL"), ...T("CL", ["2Y", "5Y", "10Y"], "-CL"),
  ...T("CO", ["2Y", "5Y", "10Y"], "-CO"), ...T("TW", ["2Y", "5Y", "10Y"], "-TW"), ...T("TH", ["2Y", "5Y", "10Y"], "-TH"), ...T("PH", ["2Y", "5Y", "10Y"], "-PH"), ...T("SK", ["10Y"], "-SK"), ...T("SI", ["10Y"], "-SI"),
];
const cnbcUrl = (syms) => `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms.map(encodeURIComponent).join("%7C")}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
export async function handleDiag(url, env, ctx, H, json) {
  if (url.searchParams.get("cnbc") === "all") {
    const out = {}; let first = null;
    for (let i = 0; i < CNBC_ALL.length; i += 40) {
      try { const r = await fetch(cnbcUrl(CNBC_ALL.slice(i, i + 40)), { headers: { "user-agent": UA, accept: "application/json" } }); const j = await r.json(); const q = (j.FormattedQuoteResult || {}).FormattedQuote || [];
        for (const x of q) { if (!first && x.last) first = x; out[x.symbol] = x.code === 0 && x.last ? [x.last, x.last_time, x.change, x.previous_day_closing, x.curmktstatus] : ["code " + x.code]; } } catch (e) { out["err" + i] = String(e && e.message); }
    }
    const r = json({ n: CNBC_ALL.length, got: Object.keys(out).length, first, out }, H); r.headers.set("cache-control", "no-store"); return r;
  }
  if (url.searchParams.get("bis") === "1") {
    const out = {};
    for (const [k, u] of Object.entries(BIS)) {
      try {
        const r = await fetch(u, { headers: { "user-agent": UA, accept: "text/csv" } }); const t = await r.text(); const by = {};
        const lines = t.split(/\r?\n/); const head = lines[0];
        for (const l of lines.slice(1)) { const c = l.split(","); if (c.length < 4) continue; const a = c[1]; const x = (by[a] = by[a] || { n: 0, first: c[2], last: null, v: null }); x.n++; x.last = c[2]; x.v = c[3]; }
        out[k] = { status: r.status, size: t.length, head, areas: Object.keys(by).length, by };
      } catch (e) { out[k] = { error: String(e && e.message) }; }
    }
    const r = json(out, H); r.headers.set("cache-control", "no-store"); return r;
  }
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
