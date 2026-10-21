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
const UCITS_ETFS_RAW = [
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
  ["GB00BLD4ZL17", "CoinShares Physical Bitcoin ETP", "Crypto ETP", null, "BITC-FR", "BITC", "XPAR", "BITP BITC"],
]; // (mapped below, with each fund's lines by currency)

// each fund's lines by currency, as CNBC answered for that fund on 21 Oct 2026 (traded within the last week; ":p" = a
// London line quoted in pence, shown ÷ 100 in GBP). EUR: Xetra first, then Milan, Paris, London; USD and GBP: London
// first; CHF: SIX. A fund without a line in the chosen currency is converted from its default line (DERIVED).
export const UCITS_LINES = {
  "IE00B4L5Y983": "EUR:EUNL-DE USD:IWDA-GB GBP:SWDA-GB:p",
  "IE00BK5BQT80": "EUR:VWCE-DE USD:VWRA-GB GBP:VWRP-GB CHF:VWRA-CH",
  "IE00B3RBWM25": "EUR:VGWL-DE USD:VWRD-GB GBP:VWRL-GB CHF:VWRL-CH",
  "IE00B6R52259": "EUR:IUSQ-DE USD:ISAC-GB GBP:SSAC-GB:p",
  "IE00BJ0KDQ92": "EUR:XDWD-DE USD:XDWD-GB GBP:XWLD-GB:p",
  "IE00B3YLTY66": "EUR:SPYI-DE USD:IMID-GB",
  "IE00BFY0GT14": "EUR:SPPW-DE USD:SWRD-GB GBP:SWLD-GB",
  "LU1681043599": "EUR:AMEW-DE USD:AMEX-DE",
  "IE00BYX2JD69": "EUR:2B7K-DE",
  "IE00B5BMR087": "EUR:SXR8-DE USD:CSPX-GB GBP:CSP1-GB:p",
  "IE00BFMXXD54": "EUR:VUAA-DE USD:VUAA-GB GBP:VUAG-GB",
  "IE00B3XXRP09": "EUR:VUSA-DE USD:VUSD-GB GBP:VUSA-GB CHF:VUSA-CH",
  "IE00B53SZB19": "EUR:SXRV-DE USD:CNDX-GB GBP:CNX1-GB:p",
  "IE0032077012": "EUR:EQQQ-DE USD:EQQU-GB GBP:EQQQ-GB:p",
  "IE00BLNMYC90": "EUR:XDEW-DE GBP:XDWE-GB:p",
  "IE00B3WJKG14": "EUR:QDVE-DE USD:IUIT-GB GBP:IITU-GB:p",
  "IE00BFZXGZ54": "EUR:EQQB-DE",
  "IE00B4K48X80": "EUR:EUNK-DE GBP:SMEA-GB:p CHF:IMEA-CH",
  "IE00B53L3W79": "EUR:SXRT-DE USD:ISX5-GB GBP:CS51-GB:p",
  "DE0005933931": "EUR:EXS1-DE",
  "DE0002635307": "EUR:EXSA-DE",
  "IE00B53QG562": "EUR:SXR7-DE USD:IEMU-GB GBP:CEU1-GB:p",
  "LU0908500753": "EUR:LYP6-DE USD:MEUS-GB GBP:MEUD-GB:p",
  "FR0010010827": "EUR:ETFMIB-IT GBP:MIBX-GB:p",
  "IE00B53L4X51": "EUR:CSMIB-IT GBP:CMB1-GB:p",
  "LU0274211480": "EUR:DBXD-DE GBP:XDAX-GB:p CHF:XDAX-CH",
  "IE00BKM4GZ66": "EUR:IS3N-DE USD:EIMI-GB GBP:EMIM-GB:p",
  "IE00BK5BR733": "EUR:VFEA-DE USD:VFEA-GB GBP:VFEG-GB",
  "IE00BTJRMP35": "EUR:XMME-DE USD:XMME-GB GBP:XMMS-GB:p",
  "IE00B4L5YX21": "EUR:EUNN-DE USD:IJPA-GB GBP:SJPA-GB:p",
  "IE00BZCQB185": "EUR:QDV5-DE USD:NDIA-GB GBP:IIND-GB",
  "IE00BJ5JPG56": "EUR:ICGA-DE",
  "IE00BF4RFH31": "EUR:IUSN-DE USD:WSML-GB GBP:WLDS-GB",
  "IE00BP3QZ601": "EUR:IS3Q-DE USD:IWQU-GB GBP:IWFQ-GB:p",
  "IE00BP3QZ825": "EUR:IS3R-DE USD:IWMO-GB GBP:IWFM-GB:p",
  "IE00BP3QZB59": "EUR:IS3S-DE USD:IWVL-GB GBP:IWFV-GB:p",
  "IE00B8FHGS14": "EUR:IQQ0-DE USD:MVOL-GB GBP:MINV-GB:p CHF:MVOL-CH",
  "IE00B8GKDB10": "EUR:VGWD-DE USD:VHYD-GB GBP:VHYL-GB CHF:VHYL-CH",
  "IE00B9CQXS71": "EUR:ZPRG-DE USD:GLDV-GB GBP:GBDV-GB CHF:GLDV-CH",
  "IE00B1XNHC34": "EUR:IQQH-DE GBP:INRG-GB:p",
  "IE00BMC38736": "EUR:VVSM-DE USD:SMH-GB GBP:SMGB-GB CHF:SMHV-CH",
  "IE00BYZK4552": "EUR:2B76-DE USD:RBOT-GB GBP:RBTX-GB:p",
  "IE00BM67HT60": "EUR:XDWT-DE USD:XDWT-GB GBP:XXTW-GB",
  "IE00BYZK4776": "EUR:2B78-DE USD:HEAL-GB GBP:DRDR-GB:p",
  "IE00BQQP9F84": "EUR:G2X-DE USD:GDX-GB GBP:GDGB-GB CHF:GDX-CH",
  "IE000NDWFGA5": "EUR:URNU-DE USD:URNU-GB GBP:URNG-GB",
  "IE00BDVPNG13": "EUR:WTI2-DE USD:WTAI-GB GBP:INTL-GB:p",
  "IE00BM67HK77": "EUR:XDWH-DE GBP:XWHS-GB",
  "IE00BGV5VN51": "EUR:XAIX-DE USD:XAID-GB GBP:XAIX-GB",
  "IE00B1FZS350": "EUR:IQQ6-DE USD:IDWP-GB GBP:IWDP-GB:p",
  "IE00BDBRDM35": "EUR:EUNA-DE",
  "IE00B4WXJJ64": "EUR:EUNH-DE GBP:SEGA-GB",
  "IE00B3F81R35": "EUR:EUN5-DE GBP:IEBC-GB CHF:IEAC-CH",
  "IE00B0M62X26": "EUR:IBCI-DE GBP:IBCI-GB",
  "IE00B3VWN518": "USD:SXRM-DE",
  "IE00B14X4S71": "EUR:IUSU-DE USD:IDBT-GB GBP:IBTS-GB",
  "IE00B2NPKV68": "EUR:IUS7-DE USD:IEMB-GB GBP:SEMB-GB:p",
  "IE00B66F4759": "EUR:EUNW-DE GBP:SHYG-GB CHF:IHYG-CH",
  "LU0290355717": "EUR:XGLE-DE",
  "IE00BG47KH54": "EUR:VAGF-DE",
  "IE00BCRY6557": "EUR:IS3M-DE GBP:ERN1-GB CHF:ERNE-CH",
  "LU0290358497": "EUR:XEON-DE",
  "IE00B1FZSC47": "EUR:IUST-DE USD:IDTP-GB GBP:ITPS-GB",
  "IE00BSKRJZ44": "EUR:IS04-DE USD:IDTL-GB GBP:IBTL-GB:p",
  "DE000A0S9GB0": "EUR:68357578-DE",
  "IE00B579F325": "EUR:8PSG-DE USD:SGLD-GB GBP:SGLP-GB:p",
  "IE00B4ND3602": "EUR:PPFB-DE USD:IGLN-GB GBP:SGLN-GB:p",
  "JE00B1VS3333": "EUR:VZLC-DE USD:PHAG-GB GBP:PHSP-GB:p",
  "IE00BDFL4P12": "EUR:SXRS-DE USD:ICOM-GB GBP:COMM-GB:p",
  "GB00BLD4ZL17": "EUR:BITC-FR USD:BITC-GB GBP:BITP-GB CHF:BITC-CH",
  "DE000A27Z304": "EUR:BTCE-DE USD:BTCF-GB GBP:BTCE-GB",
  "CH0454664001": "EUR:2BTC-DE USD:BTCU-GB GBP:ABTC-GB"
};
const SUFFIX_VENUE = { "-DE": ["XETR", "Xetra"], "-IT": ["XMIL", "Borsa Italiana"], "-GB": ["XLON", "London"], "-CH": ["XSWX", "SIX"], "-FR": ["XPAR", "Euronext Paris"], "-NL": ["XAMS", "Euronext Amsterdam"], "-FF": ["XFRA", "Frankfurt"] };
const CODE_TICKER = { "68357578-DE": "4GLD" }; // CNBC's own code for Xetra-Gold
export const UCITS_CCYS = ["EUR", "USD", "GBP", "CHF"];
export function lineOf(code, ccy, pence = false) {
  const i = code.lastIndexOf("-"), [mic, venue] = SUFFIX_VENUE[code.slice(i)] || [null, code.slice(i + 1)];
  return { cnbc: code, ticker: CODE_TICKER[code] || code.slice(0, i), mic, venue, ccy, pence, id: "C:" + code };
}
function parseLines(s) { const out = {}; for (const t of String(s || "").split(" ").filter(Boolean)) { const [ccy, code, p] = t.split(":"); out[ccy] = lineOf(code, ccy, p === "p"); } return out; }
export const UCITS = UCITS_ETFS_RAW.map(([isin, name, group, milan, cnbc, line, mic, tickers]) => {
  const lines = parseLines(UCITS_LINES[isin]), def = Object.values(lines).find((l) => l.cnbc === cnbc) || lineOf(cnbc, null);
  return { isin, name, group, milan, cnbc, line, mic, sym: milan || line, tickers: tickers ? tickers.split(" ") : [], lines, def };
});
export const UCITS_ETFS = UCITS;
export const UCITS_GROUPS = [...new Set(UCITS_ETFS.map((e) => e.group))];
export const UCITS_PART = 16;

// SRCH: the list's funds a query names — a ticker on any of their venues, the ISIN, or (4+ characters) a word of the name
export function ucitsMatch(q) {
  const Q = String(q || "").trim().toUpperCase(); if (!Q) return [];
  const exact = UCITS_ETFS.filter((e) => e.isin === Q || e.line === Q || e.milan === Q || e.tickers.includes(Q));
  const byName = Q.length >= 4 ? UCITS_ETFS.filter((e) => !exact.includes(e) && e.name.toUpperCase().includes(Q)) : [];
  return [...exact, ...byName].slice(0, 8).map((e) => ({ isin: e.isin, sym: e.sym, milan: e.milan, name: e.name, group: e.group, tickers: e.tickers, line: e.def, lines: Object.fromEntries(Object.entries(e.lines).map(([k, l]) => [k, l.id])) }));
}

export const JUSTETF = "justETF";
export const justEtfUrl = (isin) => `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
export const JUSTETF_KEY = "ref/justetf"; // KV (BRIEFS): { [isin]: { ter, …, fetchedAt } , _fail: { at, err } }
export const JUSTETF_REFRESH_MS = 7 * 86400_000;
const JUSTETF_BACKOFF_MS = 6 * 3600_000;

// ---------- currency: the fund's own line in that currency, or its default line converted (DERIVED) ----------
// CNBC's FX codes: EUR= and GBP= are USD per unit, CHF= is CHF per USD (see cnbc.mjs)
const FX_CODES = ["EUR=", "GBP=", "CHF="];
const usdPer = (c, fx) => (c === "USD" ? 1 : c === "EUR" ? fx["EUR="] : c === "GBP" ? fx["GBP="] : c === "CHF" ? (fx["CHF="] ? 1 / fx["CHF="] : null) : null);
export function fxRate(from, to, fx) { if (from === to) return 1; const a = usdPer(from, fx), b = usdPer(to, fx); return a > 0 && b > 0 ? a / b : null; }
export const pickLine = (e, ccy) => e.lines[ccy] || null;
const normCcy = (c) => (c === "GBp" || c === "GBX" ? "GBP" : c);

// the latest quotes of the lines needed for one currency, and CNBC's three FX rates: ≤ 40 codes a request
async function loadUcitsQuotes(ccy) {
  const codes = [...new Set(UCITS_ETFS.map((e) => (pickLine(e, ccy) || e.def).cnbc)), ...FX_CODES];
  const raw = await loadCnbcRaw(codes), out = {};
  for (const c of codes) { const r = cnbcIntlRec("C:" + c, raw.data[c]); if (r) out[c] = r; }
  return UCITS_ETFS.some((e) => out[(pickLine(e, ccy) || e.def).cnbc]) ? { data: out } : { err: raw.err || "no_data" };
}
// a line's quote as a row in the chosen currency: pence ÷ 100 (a unit, not a conversion); another currency converted at
// CNBC's latest rates (the change: today's price at today's rate vs yesterday's close at yesterday's close of the rate)
export function ucitsQuote(e, ccy, q, now = Date.now()) {
  const line = pickLine(e, ccy) || e.def, r = q[line.cnbc];
  if (!r) return { line, price: null, status: "N/A", error: "no_quote" };
  const unit = r.currency === "GBp" || r.currency === "GBX" ? 100 : 1, lineCcy = normCcy(r.currency);
  if (line.ccy && lineCcy !== line.ccy) return { line, price: null, status: "N/A", error: "currency_changed" }; // CNBC now quotes it otherwise
  const p = r.price / unit, pc = r.prevClose != null ? r.prevClose / unit : null;
  const stale = r.asOf ? now - Date.parse(r.asOf) > 4 * 86400_000 : r.dateOnly ? now - Date.parse(r.dateOnly) > 5 * 86400_000 : false;
  const base = { line, asOf: r.asOf, dateOnly: r.dateOnly, volume: r.volume, lineCurrency: lineCcy, ...(unit !== 1 ? { pence: true } : {}) };
  if (lineCcy === ccy) return { ...base, price: p, currency: ccy, prevClose: pc, change: r.change != null ? r.change / unit : null, changePct: r.changePct, conv: null, status: stale ? "STALE" : "LIVE" };
  const fx = {}, fxPrev = {}; let fxAt = null;
  for (const c of FX_CODES) { const x = q[c]; if (x) { fx[c] = x.price; fxPrev[c] = x.prevClose; fxAt = fxAt || x.asOf; } }
  const rate = fxRate(lineCcy, ccy, fx), ratePrev = fxRate(lineCcy, ccy, fxPrev);
  if (!rate) return { ...base, price: null, status: "N/A", error: "fx_unavailable" };
  const price = p * rate, prev = pc != null && ratePrev ? pc * ratePrev : null;
  return { ...base, price, currency: ccy, prevClose: prev, change: prev != null ? price - prev : null, changePct: prev ? (price / prev - 1) * 100 : null,
    conv: { from: lineCcy, to: ccy, rate, fxAsOf: fxAt, source: "CNBC FX (EUR=, GBP=, CHF=)" }, status: stale ? "STALE" : "DERIVED" };
}
// the close on or before a date, from daily closes [[date, close]] in date order
const closeOn = (rows, d) => { let v = null; for (const x of rows) { if (x[0] <= d) v = x[1]; else break; } return v; };

export async function handleUcits(url, env, ctx, H, json) {
  const send = (b, st = 200) => { const r = json(b, H, st); r.headers.set("cache-control", "no-store"); return r; };
  const now = Date.now(), qc = String(url.searchParams.get("ccy") || "EUR").toUpperCase(), ccy = UCITS_CCYS.includes(qc) ? qc : null;
  if (!ccy) return send({ error: "bad_request", message: `ccy: ${UCITS_CCYS.join(", ")}` }, 400);
  if (url.pathname === "/api/etf/ucits/returns") {
    // reference closes for one part of the list (≤ 16 lines: one daily-bars request each, cached 6 hours), in the chosen
    // currency: the line's own bars, or the default line's bars converted at each day's CNBC FX close (≤ 3 more requests)
    const part = Math.max(0, Math.floor(Number(url.searchParams.get("part")) || 0)), list = UCITS_ETFS.slice(part * UCITS_PART, (part + 1) * UCITS_PART);
    if (!list.length) return send({ error: "bad_request", message: `part: 0–${Math.ceil(UCITS_ETFS.length / UCITS_PART) - 1}` }, 400);
    const lines = list.map((e) => pickLine(e, ccy) || e.def), conv = lines.some((l) => l.ccy !== ccy);
    const [res, fxRes] = await Promise.all([Promise.all(lines.map((l) => cnbcDaily(url.origin, ctx, l.cnbc, 400, now))), conv ? Promise.all(FX_CODES.map((c) => cnbcDaily(url.origin, ctx, c, 400, now))) : []]);
    const fxRows = {}; FX_CODES.forEach((c, i) => { if (fxRes[i] && fxRes[i].data) fxRows[c] = fxRes[i].data; });
    const out = {}, errors = {};
    list.forEach((e, i) => {
      const r = res[i], l = lines[i]; if (!r.data) { errors[e.isin] = r.err; return; }
      const unit = l.pence ? 100 : 1, conv1 = l.ccy !== ccy;
      const toCcy = (d, v) => { if (!conv1) return v / unit; const fx = {}; for (const c of FX_CODES) if (fxRows[c]) fx[c] = closeOn(fxRows[c], d); const k = fxRate(l.ccy, ccy, fx); return k ? (v / unit) * k : null; };
      const rows = r.data.map(([d, v]) => [d, toCcy(d, v)]).filter((x) => x[1] != null);
      if (rows.length < 2) { errors[e.isin] = conv1 ? "fx_unavailable" : "no_data"; return; }
      out[e.isin] = { ref: referenceCloses(rows), lastClose: rows[rows.length - 1], line: l.cnbc, ...(conv1 ? { converted: l.ccy + "→" + ccy } : {}) };
    });
    return send({ part, parts: Math.ceil(UCITS_ETFS.length / UCITS_PART), ccy, returns: out, errors, source: "CNBC",
      basis: `CNBC's daily bars of each fund's ${ccy} line, dated as CNBC dates them; a fund without a ${ccy} line: its default line's bars at each day's CNBC FX close (DERIVED); return = latest price ÷ the reference close − 1 (DERIVED in the page)` }, Object.keys(out).length ? 200 : 502);
  }
  const [q, ref] = await Promise.all([
    cachedSource({ origin: url.origin, key: `ucits/q/${ccy}`, ttlMs: 60_000, staleMaxMs: 3 * 86400_000, failTtlMs: 60_000, ctx, load: () => loadUcitsQuotes(ccy) }),
    readJustEtf(env),
  ]);
  const rows = UCITS_ETFS.map((e) => {
    const m0 = ref[e.isin], m = m0 && Number.isFinite(m0.fetchedAt) ? m0 : null;
    const x = q.data ? ucitsQuote(e, ccy, q.data, now) : { line: pickLine(e, ccy) || e.def, price: null, status: "N/A", error: q.err || "no_quote" };
    if (q.cache === "STALE" && x.price != null) x.status = "STALE";
    return {
      isin: e.isin, sym: e.sym, milan: e.milan, name: e.name, group: e.group, ...x, own: !!pickLine(e, ccy),
      ref: m ? { ter: m.ter, fundSize: m.fundSize, distribution: m.distribution, replication: m.replication, domicile: m.domicile, fundCurrency: m.fundCurrency, hedged: m.hedged, inception: m.inception, holdings: m.holdings, legalStructure: m.legalStructure,
        status: now - m.fetchedAt > 2 * JUSTETF_REFRESH_MS ? "STALE" : "LIVE", fetchedAt: iso(m.fetchedAt), source: JUSTETF, sourceUrl: justEtfUrl(e.isin) } : null,
    };
  });
  return send({
    rows, ccy, currencies: UCITS_CCYS, groups: UCITS_GROUPS, parts: Math.ceil(UCITS_ETFS.length / UCITS_PART),
    own: rows.filter((r) => r.own && r.price != null).length, converted: rows.filter((r) => r.conv && r.price != null).length,
    source: "CNBC quote service (prices: each fund's line in the currency, or its default line converted at CNBC's FX rates) · justETF (reference data only)",
    basis: `UCITS ETFs by asset class (fixed list, lines checked 21 Oct 2026). Price in ${ccy}: the fund's own ${ccy} line where CNBC carries one; otherwise its default line converted at CNBC's latest EUR=, GBP=, CHF= rates (DERIVED). London pence lines ÷ 100. Reference data from justETF profile pages, read weekly`,
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
