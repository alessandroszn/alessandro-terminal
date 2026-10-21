// UCITS ETFs (the European-listed funds an Italian investor holds: SWDA, VWCE, CSSPX …) — a fixed list by asset class.
//   Listings (ISIN, Milan / Xetra / London tickers) checked 21 Oct 2026 against Twelve Data's symbol search and OpenFIGI;
//   each fund's price line is a CNBC code that answered for that fund on that venue (21 Oct 2026): the Xetra EUR line where
//   CNBC carries it, Milan where it carries Milan (ETFMIB, CSMIB), London otherwise. CNBC does not carry most Milan ETF lines.
//   Prices: CNBC quote service (approved 20 Oct 2026 for market data); returns from CNBC's daily bars of the same line.
//   Reference data (TER, fund size, distribution, replication, domicile, fund currency, inception): justETF profile pages,
//   approved 21 Oct 2026 for reference data only — read by the 5-minute cron, one fund per run, each refreshed weekly;
//   never prices (justETF's terms forbid automated price inquiries), never read when a page opens.
import { iso, fetchText, cachedSource } from "./lib.mjs";
import { loadCnbcRaw, cnbcIntlRec } from "./intl.mjs";
import { cnbcDaily, referenceCloses } from "./cnbc.mjs";

// [ISIN, fund name, class, Milan ticker or null, price line (CNBC code), price-line ticker, venue MIC, tickers on Milan /
//  Xetra / London / SIX (Twelve Data's listings, 21 Oct 2026 — for search)]
export const UCITS_ETFS = [
  ["IE00B4L5Y983", "iShares Core MSCI World UCITS ETF USD (Acc)", "World equity", "SWDA", "EUNL-DE", "EUNL", "XETR", "SWDA EUNL IWDA"],
  ["IE00BK5BQT80", "Vanguard FTSE All-World UCITS ETF (USD) Accumulating", "World equity", "VWCE", "VWCE-DE", "VWCE", "XETR", "VWCE VWRA VWRP"],
  ["IE00B3RBWM25", "Vanguard FTSE All-World UCITS ETF (USD) Distributing", "World equity", "VWRL", "VGWL-DE", "VGWL", "XETR", "VWRL VGWL VWRD"],
  ["IE00B6R52259", "iShares MSCI ACWI UCITS ETF USD (Acc)", "World equity", "ISAC", "IUSQ-DE", "IUSQ", "XETR", "ISAC IUSQ SSAC"],
  ["IE00BJ0KDQ92", "Xtrackers MSCI World UCITS ETF 1C", "World equity", "XDWD", "XDWD-DE", "XDWD", "XETR", "XDWD XWLD"],
  ["IE00B3YLTY66", "SPDR MSCI ACWI IMI UCITS ETF (Acc)", "World equity", "IMIE", "SPYI-DE", "SPYI", "XETR", "IMIE SPYI IMID"],
  ["IE00BFY0GT14", "SPDR MSCI World UCITS ETF", "World equity", "SWRD", "SPPW-DE", "SPPW", "XETR", "SWRD SPPW SWLD"],
  ["LU1681043599", "Amundi MSCI World Swap UCITS ETF EUR Acc", "World equity", "CW8", "AMEW-DE", "AMEW", "XETR", "CW8 AMEW AMEX CW8E"],
  ["IE00BYX2JD69", "iShares MSCI World SRI UCITS ETF EUR (Acc)", "World equity", "SUSW", "2B7K-DE", "2B7K", "XETR", "SUSW 2B7K"],
  ["IE00B5BMR087", "iShares Core S&P 500 UCITS ETF USD (Acc)", "US equity", "CSSPX", "SXR8-DE", "SXR8", "XETR", "CSSPX SXR8 CSPX CSP1"],
  ["IE00BFMXXD54", "Vanguard S&P 500 UCITS ETF (USD) Accumulating", "US equity", "VUAA", "VUAA-DE", "VUAA", "XETR", "VUAA VUAG"],
  ["IE00B3XXRP09", "Vanguard S&P 500 UCITS ETF (USD) Distributing", "US equity", "VUSA", "VUSA-DE", "VUSA", "XETR", "VUSA VUSD"],
  ["IE00B53SZB19", "iShares NASDAQ 100 UCITS ETF USD (Acc)", "US equity", "CSNDX", "SXRV-DE", "SXRV", "XETR", "CSNDX SXRV CNDX CNX1"],
  ["IE0032077012", "Invesco EQQQ NASDAQ-100 UCITS ETF Dist", "US equity", "EQQQ", "EQQQ-DE", "EQQQ", "XETR", "EQQQ EQQU"],
  ["IE00BFZXGZ54", "Invesco EQQQ NASDAQ-100 UCITS ETF Acc", "US equity", "EQAC", "EQQB-DE", "EQQB", "XETR", "EQAC EQQB"],
  ["IE00BLNMYC90", "Xtrackers S&P 500 Equal Weight UCITS ETF 1C", "US equity", "XDEW", "XDEW-DE", "XDEW", "XETR", "XDEW XDWE"],
  ["IE00B3WJKG14", "iShares S&P 500 Information Technology Sector UCITS ETF USD (Acc)", "US equity", null, "QDVE-DE", "QDVE", "XETR", "QDVE IITU IUIT"],
  ["IE00B4K48X80", "iShares Core MSCI Europe UCITS ETF EUR (Acc)", "Europe equity", "SMEA", "EUNK-DE", "EUNK", "XETR", "SMEA EUNK IMEA"],
  ["IE00B53L3W79", "iShares Core EURO STOXX 50 UCITS ETF", "Europe equity", "CSSX5E", "SXRT-DE", "SXRT", "XETR", "CSSX5E SXRT CS51 CSX5 ISX5"],
  ["IE00B53QG562", "iShares Core MSCI EMU UCITS ETF EUR (Acc)", "Europe equity", "CSEMU", "SXR7-DE", "SXR7", "XETR", "CSEMU SXR7 CEU1 IEMU"],
  ["DE0002635307", "iShares STOXX Europe 600 UCITS ETF (DE)", "Europe equity", "EXSA", "EXSA-DE", "EXSA", "XETR", "EXSA"],
  ["LU0908500753", "Amundi Core Stoxx Europe 600 UCITS ETF Acc", "Europe equity", "MEUD", "LYP6-DE", "LYP6", "XETR", "MEUD LYP6 MEUS"],
  ["DE0005933931", "iShares Core DAX UCITS ETF (DE) EUR (Acc)", "Europe equity", "EXS1", "EXS1-DE", "EXS1", "XETR", "EXS1 DAXEX"],
  ["LU0274211480", "Xtrackers DAX UCITS ETF 1C", "Europe equity", "XDAX", "DBXD-DE", "DBXD", "XETR", "XDAX"],
  ["FR0010010827", "Amundi FTSE MIB UCITS ETF Dist", "Europe equity", "ETFMIB", "ETFMIB-IT", "ETFMIB", "XMIL", "ETFMIB LYMK MIBX"],
  ["IE00B53L4X51", "iShares FTSE MIB UCITS ETF EUR (Acc)", "Europe equity", "CSMIB", "CSMIB-IT", "CSMIB", "XMIL", "CSMIB SXRY CMB1"],
  ["IE00BKM4GZ66", "iShares Core MSCI Emerging Markets IMI UCITS ETF (Acc)", "Emerging & Asia", "EIMI", "IS3N-DE", "IS3N", "XETR", "EIMI IS3N EMIM"],
  ["IE00BK5BR733", "Vanguard FTSE Emerging Markets UCITS ETF (USD) Accumulating", "Emerging & Asia", "VFEA", "VFEA-DE", "VFEA", "XETR", "VFEA VFEG"],
  ["IE00BTJRMP35", "Xtrackers MSCI Emerging Markets UCITS ETF 1C", "Emerging & Asia", "XMME", "XMME-DE", "XMME", "XETR", "XMME XMMS"],
  ["IE00B4L5YX21", "iShares Core MSCI Japan IMI UCITS ETF", "Emerging & Asia", "SJPA", "EUNN-DE", "EUNN", "XETR", "SJPA EUNN IJPA"],
  ["IE00BZCQB185", "iShares MSCI India UCITS ETF USD (Acc)", "Emerging & Asia", "NDIA", "QDV5-DE", "QDV5", "XETR", "NDIA QDV5 IIND"],
  ["IE00BJ5JPG56", "iShares MSCI China UCITS ETF USD (Acc)", "Emerging & Asia", null, "ICGA-DE", "ICGA", "XETR", "ICGA 0AC7 ICHN"],
  ["IE00BF4RFH31", "iShares MSCI World Small Cap UCITS ETF", "Factors & dividends", null, "IUSN-DE", "IUSN", "XETR", "IUSN WSML WLDS"],
  ["IE00BP3QZ601", "iShares Edge MSCI World Quality Factor UCITS ETF USD (Acc)", "Factors & dividends", "IWQU", "IS3Q-DE", "IS3Q", "XETR", "IWQU IS3Q IWFQ"],
  ["IE00BP3QZ825", "iShares Edge MSCI World Momentum Factor UCITS ETF USD (Acc)", "Factors & dividends", "IWMO", "IS3R-DE", "IS3R", "XETR", "IWMO IS3R IWFM"],
  ["IE00BP3QZB59", "iShares Edge MSCI World Value Factor UCITS ETF USD (Acc)", "Factors & dividends", "IWVL", "IS3S-DE", "IS3S", "XETR", "IWVL IS3S IWFV"],
  ["IE00B8FHGS14", "iShares Edge MSCI World Minimum Volatility UCITS ETF USD (Acc)", "Factors & dividends", "MVOL", "IQQ0-DE", "IQQ0", "XETR", "MVOL IQQ0 MINV"],
  ["IE00B8GKDB10", "Vanguard FTSE All-World High Dividend Yield UCITS ETF (USD) Distributing", "Factors & dividends", "VHYL", "VGWD-DE", "VGWD", "XETR", "VHYL VGWD VHYD"],
  ["IE00B9CQXS71", "SPDR S&P Global Dividend Aristocrats UCITS ETF", "Factors & dividends", "GLDV", "ZPRG-DE", "ZPRG", "XETR", "GLDV ZPRG GBDV"],
  ["IE00BM67HT60", "Xtrackers MSCI World Information Technology UCITS ETF 1C", "Sectors & themes", "XDWT", "XDWT-DE", "XDWT", "XETR", "XDWT XXTW"],
  ["IE00BM67HK77", "Xtrackers MSCI World Health Care UCITS ETF 1C", "Sectors & themes", "XDWH", "XDWH-DE", "XDWH", "XETR", "XDWH XWHS"],
  ["IE00BMC38736", "VanEck Semiconductor UCITS ETF", "Sectors & themes", "SMH", "VVSM-DE", "VVSM", "XETR", "SMH VVSM SMGB SMHV"],
  ["IE00BGV5VN51", "Xtrackers Artificial Intelligence and Big Data UCITS ETF 1C", "Sectors & themes", "XAIX", "XAIX-DE", "XAIX", "XETR", "XAIX XAID"],
  ["IE00BDVPNG13", "WisdomTree Artificial Intelligence UCITS ETF", "Sectors & themes", "WTAI", "WTI2-DE", "WTI2", "XETR", "WTAI WTI2 INTL"],
  ["IE00BYZK4552", "iShares Automation & Robotics UCITS ETF", "Sectors & themes", "RBOT", "2B76-DE", "2B76", "XETR", "RBOT 2B76 RBTX"],
  ["IE00BYZK4776", "iShares Healthcare Innovation UCITS ETF USD (Acc)", "Sectors & themes", "HEAL", "2B78-DE", "2B78", "XETR", "HEAL 2B78 DRDR"],
  ["IE00B1XNHC34", "iShares Global Clean Energy Transition UCITS ETF", "Sectors & themes", "INRG", "IQQH-DE", "IQQH", "XETR", "INRG IQQH"],
  ["IE00BQQP9F84", "VanEck Gold Miners UCITS ETF", "Sectors & themes", "GDX", "G2X-DE", "G2X", "XETR", "GDX G2X GDGB"],
  ["IE000NDWFGA5", "Global X Uranium UCITS ETF USD Accumulating", "Sectors & themes", "URNU", "URNU-DE", "URNU", "XETR", "URNU URNG"],
  ["IE00B1FZS350", "iShares Developed Markets Property Yield UCITS ETF", "Real estate", "IWDP", "IQQ6-DE", "IQQ6", "XETR", "IWDP IQQ6 IDWP"],
  ["IE00BDBRDM35", "iShares Core Global Aggregate Bond UCITS ETF EUR Hedged (Acc)", "Bonds", "AGGH", "EUNA-DE", "EUNA", "XETR", "AGGH EUNA 0GGH"],
  ["IE00BG47KH54", "Vanguard Global Aggregate Bond UCITS ETF EUR Hedged Accumulating", "Bonds", "VAGF", "VAGF-DE", "VAGF", "XETR", "VAGF 0ACD"],
  ["IE00B4WXJJ64", "iShares Core € Govt Bond UCITS ETF", "Bonds", "SEGA", "EUNH-DE", "EUNH", "XETR", "SEGA EUNH"],
  ["LU0290355717", "Xtrackers II Eurozone Government Bond UCITS ETF 1C", "Bonds", "XGLE", "XGLE-DE", "XGLE", "XETR", "XGLE"],
  ["IE00B3F81R35", "iShares Core € Corp Bond UCITS ETF EUR (Dist)", "Bonds", "IEAC", "EUN5-DE", "EUN5", "XETR", "IEAC EUN5 IEBC"],
  ["IE00B66F4759", "iShares € High Yield Corp Bond UCITS ETF EUR (Dist)", "Bonds", "IHYG", "EUNW-DE", "EUNW", "XETR", "IHYG EUNW SHYG"],
  ["IE00B0M62X26", "iShares € Inflation Linked Govt Bond UCITS ETF", "Bonds", "IBCI", "IBCI-DE", "IBCI", "XETR", "IBCI"],
  ["IE00B14X4S71", "iShares $ Treasury Bond 1-3yr UCITS ETF (Dist)", "Bonds", "IBTS", "IUSU-DE", "IUSU", "XETR", "IBTS IUSU IDBT"],
  ["IE00B3VWN518", "iShares $ Treasury Bond 7-10yr UCITS ETF (Acc)", "Bonds", null, "SXRM-DE", "SXRM", "XETR", "SXRM CBU0 CSBGU0"],
  ["IE00BSKRJZ44", "iShares $ Treasury Bond 20+yr UCITS ETF", "Bonds", null, "IS04-DE", "IS04", "XETR", "IS04 IDTL IBTL"],
  ["IE00B1FZSC47", "iShares $ TIPS UCITS ETF USD (Acc)", "Bonds", "ITPS", "IUST-DE", "IUST", "XETR", "ITPS IUST IDTP"],
  ["IE00B2NPKV68", "iShares J.P. Morgan $ EM Bond UCITS ETF", "Bonds", "IEMB", "IUS7-DE", "IUS7", "XETR", "IEMB IUS7 SEMB"],
  ["IE00BCRY6557", "iShares € Ultrashort Bond UCITS ETF", "Cash & ultrashort", "ERNE", "IS3M-DE", "IS3M", "XETR", "ERNE IS3M ERN1"],
  ["LU0290358497", "Xtrackers II EUR Overnight Rate Swap UCITS ETF 1C", "Cash & ultrashort", "XEON", "XEON-DE", "XEON", "XETR", "XEON"],
  ["DE000A0S9GB0", "Xetra-Gold", "Commodities", null, "68357578-DE", "4GLD", "XETR", "4GLD"],
  ["IE00B579F325", "Invesco Physical Gold ETC", "Commodities", "SGLD", "8PSG-DE", "8PSG", "XETR", "SGLD 8PSG SGLP"],
  ["IE00B4ND3602", "iShares Physical Gold ETC", "Commodities", "SGLN", "PPFB-DE", "PPFB", "XETR", "SGLN PPFB IGLN EGLN"],
  ["JE00B1VS3333", "WisdomTree Physical Silver", "Commodities", "PHAG", "VZLC-DE", "VZLC", "XETR", "PHAG PHSP OVZC"],
  ["IE00BDFL4P12", "iShares Diversified Commodity Swap UCITS ETF", "Commodities", null, "SXRS-DE", "SXRS", "XETR", "SXRS COMM ICOM"],
  ["DE000A27Z304", "Bitwise Physical Bitcoin ETP", "Crypto ETP", null, "BTCE-DE", "BTCE", "XETR", "BTCE BTCF"],
  ["CH0454664001", "21Shares Bitcoin ETP", "Crypto ETP", null, "2BTC-DE", "2BTC", "XETR", "2BTC BTCU ABTC"],
  ["GB00BLD4ZL17", "CoinShares Physical Bitcoin ETP", "Crypto ETP", null, "BITC-GB", "BITC", "XLON", "BITP BITC"],
].map(([isin, name, group, milan, cnbc, line, mic, tickers]) => ({ isin, name, group, milan, cnbc, line, mic, sym: milan || line, tickers: tickers ? tickers.split(" ") : [] }));
export const UCITS_GROUPS = [...new Set(UCITS_ETFS.map((e) => e.group))];
const VENUE = { XETR: "Xetra", XMIL: "Borsa Italiana", XLON: "London" };
export const UCITS_PART = 16;

// SRCH: the list's funds a query names — a ticker on any of their venues, the ISIN, or (4+ characters) a word of the name
export function ucitsMatch(q) {
  const Q = String(q || "").trim().toUpperCase(); if (!Q) return [];
  const exact = UCITS_ETFS.filter((e) => e.isin === Q || e.line === Q || e.milan === Q || e.tickers.includes(Q));
  const byName = Q.length >= 4 ? UCITS_ETFS.filter((e) => !exact.includes(e) && e.name.toUpperCase().includes(Q)) : [];
  return [...exact, ...byName].slice(0, 8).map((e) => ({ isin: e.isin, sym: e.sym, milan: e.milan, name: e.name, group: e.group, tickers: e.tickers, line: { ticker: e.line, mic: e.mic, venue: VENUE[e.mic] || e.mic, id: "C:" + e.cnbc } }));
}

export const JUSTETF = "justETF";
export const justEtfUrl = (isin) => `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
export const JUSTETF_KEY = "ref/justetf"; // KV (BRIEFS): { [isin]: { ter, …, fetchedAt } , _fail: { at, err } }
export const JUSTETF_REFRESH_MS = 7 * 86400_000;
const JUSTETF_BACKOFF_MS = 6 * 3600_000;

// the latest quotes of every line: one CNBC request (≤ 40 codes each) — the price, the change, CNBC's time
async function loadUcitsQuotes() {
  const raw = await loadCnbcRaw(UCITS_ETFS.map((e) => e.cnbc));
  const out = {};
  for (const e of UCITS_ETFS) { const r = cnbcIntlRec("C:" + e.cnbc, raw.data[e.cnbc]); if (r) out[e.cnbc] = r; }
  return Object.keys(out).length ? { data: out } : { err: raw.err || "no_data" };
}

export async function handleUcits(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const now = Date.now();
  if (url.pathname === "/api/etf/ucits/returns") {
    // reference closes for one part of the list (≤ 16 lines: one daily-bars request each, cached 6 hours)
    const part = Math.max(0, Math.floor(Number(url.searchParams.get("part")) || 0)), list = UCITS_ETFS.slice(part * UCITS_PART, (part + 1) * UCITS_PART);
    if (!list.length) return send({ error: "bad_request", message: `part: 0–${Math.ceil(UCITS_ETFS.length / UCITS_PART) - 1}` }, 400);
    const res = await Promise.all(list.map((e) => cnbcDaily(url.origin, ctx, e.cnbc, 400, now)));
    const out = {}, errors = {};
    list.forEach((e, i) => { const r = res[i]; if (!r.data) { errors[e.isin] = r.err; return; } const rows = r.data; out[e.isin] = { ref: referenceCloses(rows), lastClose: rows[rows.length - 1] }; });
    return send({ part, parts: Math.ceil(UCITS_ETFS.length / UCITS_PART), returns: out, errors, source: "CNBC", basis: "CNBC's daily bars of each fund's price line, dated as CNBC dates them; return = latest price ÷ the reference close − 1 (DERIVED in the page)" }, Object.keys(out).length ? 200 : 502);
  }
  const [q, ref] = await Promise.all([
    cachedSource({ origin: url.origin, key: "ucits/q", ttlMs: 60_000, staleMaxMs: 3 * 86400_000, failTtlMs: 60_000, ctx, load: loadUcitsQuotes }),
    readJustEtf(env),
  ]);
  const rows = UCITS_ETFS.map((e) => {
    const r = q.data && q.data[e.cnbc], m0 = ref[e.isin], m = m0 && Number.isFinite(m0.fetchedAt) ? m0 : null;
    const stale = !r || q.cache === "STALE" || (r.asOf && now - Date.parse(r.asOf) > 4 * 86400_000);
    return {
      isin: e.isin, sym: e.sym, milan: e.milan, name: e.name, group: e.group, line: { ticker: e.line, mic: e.mic, venue: VENUE[e.mic] || e.mic, cnbc: e.cnbc, id: "C:" + e.cnbc },
      ...(r ? { price: r.price, currency: r.currency, change: r.change, changePct: r.changePct, prevClose: r.prevClose, volume: r.volume, asOf: r.asOf, dateOnly: r.dateOnly, status: stale ? "STALE" : "LIVE" } : { price: null, status: "N/A", error: q.err || "no_quote" }),
      ref: m ? { ter: m.ter, fundSize: m.fundSize, distribution: m.distribution, replication: m.replication, domicile: m.domicile, fundCurrency: m.fundCurrency, hedged: m.hedged, inception: m.inception, holdings: m.holdings, legalStructure: m.legalStructure,
        status: now - m.fetchedAt > 2 * JUSTETF_REFRESH_MS ? "STALE" : "LIVE", fetchedAt: iso(m.fetchedAt), source: JUSTETF, sourceUrl: justEtfUrl(e.isin) } : null,
    };
  });
  return send({
    rows, groups: UCITS_GROUPS, parts: Math.ceil(UCITS_ETFS.length / UCITS_PART),
    source: "CNBC quote service (prices: the listed line of each fund) · justETF (reference data only)",
    basis: "UCITS ETFs by asset class (fixed list, listings checked 21 Oct 2026). Price = the line shown (Xetra EUR where CNBC carries it), not Milan unless said; reference data from justETF profile pages, read weekly",
    refCount: rows.filter((r) => r.ref).length, ...(ref._fail ? { refError: ref._fail.err } : {}),
    status: !q.data ? "N/A" : q.cache === "STALE" ? "STALE" : rows.some((r) => r.price == null) ? "PARTIAL" : "LIVE", fetchedAt: q.fetchedAt ? iso(q.fetchedAt) : null, ...(q.staleReason ? { staleReason: q.staleReason } : {}),
  });
}

// ---------- justETF reference data (cron, one fund a run) ----------
async function readJustEtf(env) {
  if (!env || !env.BRIEFS) return {};
  try { const t = await env.BRIEFS.get(JUSTETF_KEY); const j = t ? JSON.parse(t) : null; return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
const ENT = { "&amp;": "&", "&nbsp;": " ", "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&euro;": "€" };
const clean = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/<[^>]*$/, " ").replace(/&[a-z#0-9]+;/gi, (m) => ENT[m] || " ").replace(/\s+/g, " ").trim();
// the value written right after a label on the page (the label's table row, as text), when it has the expected shape: up
// to five places the label occurs are tried; a small window of the page each time (the page is ~450 KB)
function valueAfter(html, label, re, span = 600) {
  let from = 0, best = null;
  for (let k = 0; k < 5; k++) {
    const i = html.indexOf(label, from); if (i < 0) break;
    const m = re.exec(clean(html.slice(i + label.length, i + label.length + span)));
    if (m && (!best || m.filter((x) => x != null).length > best.filter((x) => x != null).length)) best = m; // the fuller one ("Physical (Sampling)")
    from = i + label.length;
  }
  return best;
}
const DOMICILES = "Ireland|Luxembourg|Germany|France|Jersey|Switzerland|Liechtenstein|United Kingdom|Netherlands|Sweden|Austria|Guernsey|Italy|Spain";
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
// justETF's English profile page (checked 21 Oct 2026): "Total expense ratio 0.20% p.a.", "Fund size EUR 131,754 m",
// "Distribution policy Accumulating", "Replication Physical (Optimized sampling)", "Fund domicile Ireland",
// "Fund currency USD", "Currency risk Currency unhedged", "Inception/ Listing Date 25 September 2009", "Holdings 1,252",
// "Legal structure ETF" (ETC for Xetra-Gold, ETN for CoinShares Physical Bitcoin)
export function parseJustEtf(html) {
  if (!html || html.length < 1000) return null;
  const ter = valueAfter(html, "Total expense ratio", /^(\d{1,2}(?:\.\d{1,3})?)% p\.a\./);
  const size = valueAfter(html, "Fund size", /^([A-Z]{3}) (\d{1,3}(?:,\d{3})*(?:\.\d+)?) (m|bn)\b/);
  const dist = valueAfter(html, "Distribution policy", /^(Accumulating|Distributing)\b/);
  const repl = valueAfter(html, "Replication", /^(Physical|Synthetic|Unfunded swap|Funded swap)(?: \( ?([A-Za-z][A-Za-z ,-]{0,40}?) ?\))?/);
  const dom = valueAfter(html, "Fund domicile", new RegExp(`^(${DOMICILES})\\b`));
  const ccy = valueAfter(html, "Fund currency", /^([A-Z]{3})\b/);
  const hedge = valueAfter(html, "Currency risk", /^Currency (unhedged|hedged)\b/);
  const inc = valueAfter(html, "Inception/ Listing Date", new RegExp(`^(\\d{1,2} (?:${MONTHS}) \\d{4})\\b`)) || valueAfter(html, "Inception Date", new RegExp(`^(\\d{1,2} (?:${MONTHS}) \\d{4})\\b`));
  const hold = valueAfter(html, "Holdings", /^(\d{1,3}(?:,\d{3})*)\b/);
  const legal = valueAfter(html, "Legal structure", /^(ETF|ETC|ETN)\b/);
  const n = (s) => Number(String(s).replace(/,/g, ""));
  const out = {
    ter: ter ? Number(ter[1]) : null,
    fundSize: size ? { value: n(size[2]) * (size[3] === "bn" ? 1e9 : 1e6), currency: size[1] } : null,
    distribution: dist ? dist[1] : null, replication: repl ? (repl[2] ? `${repl[1]} (${repl[2].trim()})` : repl[1]) : null,
    domicile: dom ? dom[1] : null, fundCurrency: ccy ? ccy[1] : null, hedged: hedge ? hedge[1] === "hedged" : null,
    inception: inc ? inc[1] : null, holdings: hold ? n(hold[1]) : null, legalStructure: legal ? legal[1] : null,
  };
  return out.ter == null && !out.fundSize && !out.distribution ? null : out;
}

// the */5 cron: the fund read longest ago (or never), one request. A page without the data (an unknown ISIN) is tried
// again after a week; justETF unreachable or refusing → no request for 6 hours (no hammering). Never prices.
export async function refreshJustEtf(env, now = Date.now(), fetchImpl = fetchText) {
  if (!env || !env.BRIEFS) return { action: "skipped" };
  const all = await readJustEtf(env);
  if (all._fail && now - all._fail.at < JUSTETF_BACKOFF_MS) return { action: "backoff" };
  let pick = null, age = -1;
  for (const e of UCITS_ETFS) {
    const m = all[e.isin], t = m ? Math.max(Number(m.fetchedAt) || 0, Number(m.triedAt) || 0) : 0, a = t ? now - t : Infinity;
    if (a >= JUSTETF_REFRESH_MS && a > age) { pick = e; age = a; }
  }
  if (!pick) return { action: "fresh" };
  const f = await fetchImpl(justEtfUrl(pick.isin), { timeoutMs: 15000, headers: { accept: "text/html", "accept-language": "en" } });
  const save = () => env.BRIEFS.put(JUSTETF_KEY, JSON.stringify(all), { expirationTtl: 30 * 86400 });
  if (f.err && f.err !== "no_data") { all._fail = { at: now, err: f.err }; await save(); return { action: "failed", isin: pick.isin, err: f.err }; }
  const meta = f.err ? null : parseJustEtf(f.text);
  delete all._fail;
  if (!meta) { all[pick.isin] = { ...(all[pick.isin] && all[pick.isin].fetchedAt ? all[pick.isin] : {}), triedAt: now, err: f.err || "no_reference_data" }; await save(); return { action: "no_data", isin: pick.isin }; }
  all[pick.isin] = { ...meta, fetchedAt: now };
  await save();
  return { action: "refreshed", isin: pick.isin };
}
