# Alessandro Terminal

A multi-window market terminal served at **alessandrozanichelli.com/terminal**.

```
Browser ──► alessandrozanichelli.com/terminal   (static page: public/terminal/index.html + provenance.js)
        └─► alessandrozanichelli.com/api/*      (Cloudflare Worker, src/worker.mjs) ──► Twelve Data
```

The Twelve Data API key lives only in the Worker as the secret `TWELVEDATA_KEY`.
It is never in this repository, in the page, in a URL the browser sees, or in a response.

## Access (T05)
The terminal is **private**: `/terminal*` and `/api/*` sit behind Cloudflare Access (owner login).
The free Twelve Data plan is licensed for internal use only ("Internal non-display usage";
external display needs a redistribution agreement), so its quotes are not shown publicly.
`workers_dev` and preview URLs are disabled so nothing bypasses Access.

Three layers:
0. **WAF custom rule** (free plan): a request to `/api/*` without the Access session cookie is blocked
   with `403` before anything else runs.
1. **Cloudflare Access** (Zero Trust Free): self-hosted application on `alessandrozanichelli.com/terminal`
   and `alessandrozanichelli.com/api` (sub-paths included), one Allow policy for the owner's e-mail;
   everyone else is denied (Access is deny-by-default). Login: one-time PIN by e-mail. Session 24 h.
2. **Worker check** (`src/access.mjs`): every `/api/*` request must carry the Access JWT of this
   application — RS256 signature against the team's public keys, audience = the app's AUD tag,
   issuer, expiry. Missing → `401`; forged / other app / other team → `403`; missing configuration or
   unreachable keys → `503` (fail closed). The provider is never called for a rejected request.

The Twelve Data key is sent only in the `Authorization: apikey …` header, never in a URL.

## Data integrity rules (T04–T05)
- **Only real data.** Every number comes from a real source through `/api/*`; a value without one is
  **N/A** (or the section shows **NO DATA**). No mock, random, estimated or placeholder values.
- Every datum carries source, timestamp, fetchedAt and status: **LIVE**, **PARTIAL**, **STALE**,
  **N/A** (API) and **DERIVED**, **LOADING** (page). Rules: `public/terminal/provenance.js`.
- No silent fallback: on failure a section shows its last real data marked **STALE** (bounded) or N/A.

## Sections and sources
| Section | Source | Notes |
|---|---|---|
| Price chart (GP) | Twelve Data `/time_series` via `/api/history` (OHLCV) · live quote for the bar still forming | interactive chart drawn by TradingView Lightweight Charts™ (Apache-2.0, self-hosted in `public/terminal/vendor/`, unmodified, pinned by hash in the tests): candles / line / area; 1D (5-min) and 5D (15-min) in exchange time; one 5-year daily request serves 1M…5Y (those buttons only move the view); 10Y weekly; MAX monthly; zoom, pan, crosshair legend (O/H/L/C, change, volume); volume, SMA 20/50/200, Bollinger 20·2, RSI 14 computed from the bars (DERIVED); log scale; compare up to 3 symbols in % from the first bar in view; your notes as markers. The same engine draws COMP, SPRD, CROSS, BT and the YLD curves (true maturity axis) |
| Symbol search (SRCH) | Twelve Data `/symbol_search` via `/api/search` | name or ticker, every exchange the provider lists; metadata only (no prices). Listings outside the Twelve Data plan on 28 exchanges CNBC quotes (Milan, Xetra, Paris, London, Amsterdam, Madrid, Dublin, SIX, Tokyo, Hong Kong, Toronto, ASX, NSE, B3, Shanghai, Shenzhen, Taiwan, Singapore, the Nordics…) are marked CNBC and open with CNBC quotes and history; MORE LISTINGS adds CNBC's own symbol lookup (`/api/cnbc/lookup`, opened as `C:<code>`, also typed in the command line); a listing neither in the plan nor at CNBC (Vienna, Copenhagen, Korea) is N/A with OTHER LISTINGS of the same company |
| Watchlist (editable, max 12) | Twelve Data `/quote` via `/api/quote` | US equities (venue subset: volume/OHL PARTIAL), FX, crypto, gold; any searched listing the plan covers |
| Heat maps (MAP) | S&P 500: iShares IVV holdings · Nasdaq-100: Invesco QQQ holdings (Invesco API) · Dow 30: SPDR DIA holdings (.xlsx) · Sectors: 11 SPDR sector ETFs · Countries: ~38 single-country ETFs in New York · Crypto: Alpaca crypto (USD pairs) — prices Alpaca; FX: 9×9 matrix from live Twelve Data quotes vs USD | colour = 1D/1W/1M/3M/6M/YTD/1Y change (DERIVED; FX 1D only); size = index weight (ETF holdings) or traded value (close × volume) or equal; ETF maps show ETF prices, not index levels; crypto days in UTC, closes = completed days |
| World markets (EXCH) | Twelve Data `/market_state` (all plans, 1 credit for all exchanges) · regular trading hours (reference) · IDX | TIMELINE (default, Nico's layout): 15 markets on a 24-hour line in your time (6 h back, 18 h ahead), OPEN/CLOSED, the open session (provider times, green), the next session (provider open + regular length), earlier sessions (regular hours, dimmed), the main index % where IDX has a source (S&P 500, DAX, Nikkei 225), "opens in / closes in". TABLE: | open/closed now incl. holidays and early closes, local time, time to open/close, session in your time; top bar `● LIVE 19:23 · 39/140 open · next … in 36m` (every exchange reported); cached until the next open/close of a major market (≤ 30 min) |
| Portfolio (PF) | your transactions (Workers KV, private behind Access) · live quotes (Twelve Data) · ECB euro reference rates (trade-date cost in EUR) | starts empty; BUY/SELL with date, qty, price, fees; average-cost positions; value and P&L in EUR (live EUR/currency rate, DERIVED), shown in USD / CHF / GBP / JPY at the live rate if chosen; realised P&L; no risk / attribution / quant analytics yet |
| Portfolio analytics (PFA) | your transactions · each holding's daily closes (Twelve Data `/api/history`, split-adjusted, 1 credit each, cached) · ECB daily rates (`/api/portfolio/fx?ccys=…&from=…`) · index history (`/api/indices/history`) as benchmark | time-weighted return (each day in two steps: what was held from the previous close, then the day's trades at their prices — so adding or withdrawing money does not change it), annualised over a year, benchmark (S&P 500, Nasdaq-100, Dow, Nasdaq Composite, Russell 2000, MSCI EAFE / EM, Nikkei 225, EURO STOXX 50, STOXX 600, DAX) in EUR at the same ECB rates or in its own currency, excess return, volatility, max drawdown with peak / trough / recovery, beta, correlation, tracking error, best and worst day, gain since the first trade in EUR; periods SINCE START, 1Y, YTD, 6M, 3M, 1M; charts of the return index vs the benchmark and of the drawdown. Risk of the current holdings over the last year of days on which all of them traded: volatility at current weights, portfolio beta, effective number of holdings, currency split, each holding's weight, volatility, beta, correlation with the portfolio and share of risk, correlation grid. Price return (no dividend source); all DERIVED; a holding without history makes the figures N/A, never estimated. |
| Markets (MKT) | Twelve Data (watchlist, EUR/USD, GBP/USD, USD/JPY, XAU/USD — the only rows that cost credits) · `/api/indices` · `/api/markets/fx` (ECB euro reference rates, 22 currencies, last two fixings) · `/api/markets/cmdty` (IMF Primary Commodity Prices via FRED: copper, aluminium, nickel, zinc, iron ore, wheat, corn, soybeans, coffee, sugar, cocoa — monthly averages) · `/api/energy` · Alpaca crypto | groups: equities, indices, FX (3 live + 19 from the ECB fixing; dollar pairs DERIVED through the same fixing), metals (gold live, gold in euro DERIVED, base metals monthly; silver/platinum/palladium N/A — Twelve Data Grow), energy (EIA daily spot with its date), agriculture (monthly), crypto (top 10 by traded value). BTC/ETH quotes stay only for the briefing written on request. |
| Indices (IDX) | Cboe delayed quotes (cdn-api.cboe.com, 15 min) · STOXX daily files (last 3 months) · Nikkei Inc. daily CSV · FRED (approved 7 Oct 2026) · SIX, Shanghai Stock Exchange, B3, ASX, CNBC quote service (approved 20 Oct 2026) | 81 indices in eight groups, one request each (`/api/indices?g=us\|vol\|eu\|eu2\|sec\|sec2\|asia\|world`, `/api/indices/history?id=`): United States (S&P 500, S&P 100, Nasdaq-100, Dow = Cboe DJX × 100 DERIVED, Nasdaq Composite from FRED, Russell 1000 / 2000, VIX), volatility (VXN, VIX9D, VIX3M, VVIX, OVX, GVZ), Europe (EURO STOXX 50, EURO STOXX, STOXX Europe 50 / 600, DAX, MDAX, TecDAX from STOXX; SMI, SPI, IBEX 35 from SIX, 15-min delayed, with 10 years of daily closes), the 19 STOXX Europe 600 sectors + EURO STOXX Banks, Asia-Pacific (Nikkei 225; SSE Composite and CSI 300 from the Shanghai Stock Exchange, port 32042, with daily bars; S&P/ASX 200 from ASX's data vendor — no time published, PARTIAL, no history), Americas & global (Ibovespa = B3's daily close, from its yearly files of daily closes — B3's quote service answers the Worker with an error; MSCI EAFE / EM / ACWI from Cboe). Level, change, day range, 1M / YTD / 52 weeks DERIVED from the history (loaded three at a time), time and delay, status; chart of the selected index. From CNBC (delayed as CNBC marks it, with 10 years of daily bars): FTSE 100, CAC 40, FTSE MIB, AEX; Europe — more markets (FTSE 250, FTSE All-Share, SBF 120, SDAX, BEL 20, PSI, ISEQ, OMX Stockholm 30, OSEBX, BIST 100); Hang Seng, Hang Seng China Enterprises, KOSPI, Nifty 50, TAIEX, Straits Times, KLCI, SET, NZX 50; S&P/TSX, IPC, COLCAP, TA-125, the ICE U.S. Dollar Index (DXY), Russell 3000. |
| Yields (YLD, CURVE) | Official daily sources, no key: U.S. FRED (H.15) or Treasury XML · euro area ECB · Germany Bundesbank · UK Bank of England · Japan Ministry of Finance (current month + history file) · Switzerland SNB · Canada Bank of Canada · Spain Banco de España (BIEST API) · Belgium National Bank of Belgium (NBB.Stat SDMX CSV) · Portugal Banco de Portugal (BPstat JSON-stat; market data LSEG) · Austria OeNB (average yield of all federal bonds, released weekly) · Sweden Riksbank (SWEA) · Norway Norges Bank (SDMX CSV) · Australia RBA table F2 (released weekly) · New Zealand RBNZ table B2 (xlsx, read in the Worker) · China ChinaBond government curve · Malaysia Bank Negara Malaysia (latest day) · South Africa SARB (bonds R2030 and R209) · Peru BCRP (10Y) · Italy Banca d'Italia BMK0200 (BTP benchmarks 3/5/10/30Y, zipped CSV, refreshed with a lag of one to three weeks). Monthly 10-year average (OECD via FRED, labelled M): France, Netherlands, Ireland, Greece, Finland, Denmark, Poland, Czech Republic, Hungary, Slovakia, Slovenia, Luxembourg, South Korea, Israel, Mexico, Chile | WORLD table by region: 2Y/5Y/10Y/30Y, Δ10Y 1D/1W/1M, 2s10s, 10Y spread vs the Bund and vs the U.S. (same day; monthly series vs the same month's German / U.S. average) — DERIVED; sort by region, 10Y, biggest move, spread. Country view: curve on a true maturity axis vs the previous publication and 1W / 1M / 3M / 1Y earlier (the last publication on or before), Δ by maturity, 10Y (or the only series) history. CURVE: up to 6 countries on one chart, or one country at several dates. Not connected (no free official source, or no answer to the Worker): Brazil, Turkey, India, Indonesia, Singapore, Taiwan, Thailand, Philippines, Colombia, Saudi Arabia, Hong Kong |
| World government bonds (BOND) | the curves above + FRED | 2Y/5Y/10Y/20Y/30Y by country, change over 1 publication / ~1 week / ~1 month (bp, DERIVED, heat-coloured), 10Y spread vs the Bund only on the same date (DERIVED); U.S. TIPS real yields, breakevens, IG / HY yields and spreads (ICE BofA), SOFR, 30-year mortgage (FRED). Italy, France, Spain, China, Australia N/A (no free official daily source connected) |
| Futures positioning (COT) | CFTC Commitments of Traders (legacy, futures only; public Socrata API) | 39 major contracts (equity indices, Treasuries, SOFR, energy, metals, currencies, crypto, agriculture): open interest, speculators long / short / net, Δ 1W / 4W, net % OI, place in the 26-week range, 13-week line, commercials net — all derived from the weekly reports; positions as of Tuesday, published Friday. Futures prices stay N/A (licensed) |
| ETFs by asset class (ETF) | Alpaca prices; fixed list chosen with TradingView's largest / most traded as a reference | 140 US-listed ETFs: US equity (S&P 500, Nasdaq-100, Dow, Russell, mid / small cap, growth / value), factors, dividends and income, industries and themes (semiconductors, software, biotech, banks, defense, homebuilders, energy, miners, uranium, lithium, clean energy…), Treasuries, credit and aggregate, commodities, real estate, international (VT, ACWI, developed, emerging, Eurozone, China, India, Brazil), currencies, volatility, crypto, leveraged and inverse; 1D…1Y change, traded value; also a MAP universe. ETF prices, never shown as the price of what they hold. European UCITS listings: the UCITS list below |
| ETF section (menu ETF: EFS screener, EFP profile, EFC compare, EXPO look-through) | Deutsche Börse "T7 (Xetra) All tradable instruments" (public CSV, approved 21 Oct 2026) · Twelve Data's ETF list (U.S.) · justETF profile pages (reference data, approved 21 Oct 2026: the cron reads one fund every 5 minutes through the whole universe, the owner's funds first and weekly; a profile opened is read then) · CNBC quotes and daily bars | Every ETF / ETC / ETN tradable on Xetra (~3,700 ISINs with WKN, Xetra tickers, trading currency, Xetra's product group) and every U.S. ETF (exchange-traded funds on U.S. exchanges). Screener: search by ticker / ISIN / name; filters on type, class (justETF's investment focus, else Xetra's group), provider, TER, size, Acc / Dist, replication, hedging — the justETF filters apply to the funds read so far (counted on screen); prices of the rows on screen from CNBC. Profile: justETF reference data, every listing CNBC carries for the ISIN (Xetra list, OpenFIGI / Twelve Data listings), returns 1M…5Y p.a., 1-year volatility, maximum drawdown (DERIVED from CNBC daily bars, in EUR / USD / GBP / CHF — the fund's own line or converted at each day's CNBC FX), top 10 holdings, countries, sectors as justETF lists them. Compare: up to 4 funds, rebased chart. EXPO: the portfolio's ETFs (Xetra / UCITS tickers, C:<code>) looked through — countries, sectors, largest holdings weighted by today's market value (DERIVED; holdings a lower bound: top 10 only). U.S. ETFs: no justETF data (European listings only) |
| Factor exposure (FACT) | Kenneth R. French Data Library (Tuck, Dartmouth; public ZIP files, no key; approved 21 Oct 2026) · CNBC daily bars and FX | Monthly research factors — Mkt-RF, SMB, HML, RMW, CMA, RF (5 factors, 2x3) and momentum — for Developed (23 countries), Europe (16) and the U.S., in USD, published once a month about two months behind. Downloaded on use at most once a day, kept in KV (`ff/dev`, `ff/eu`, `ff/us`); a failed download keeps the last copy (STALE) and waits 6 hours. `/api/factors?ids=&region=auto\|dev\|eu\|us&years=5\|10` lines up the factors with each instrument's monthly USD returns (month-end CNBC closes, FX of the same day); the regressions run in the page (qmath.js) — DERIVED. Not published outside the terminal: the library states no licence for the data. |
| UCITS ETFs (UCITS, or LIST → UCITS in the ETF window) | CNBC quote service and daily bars (prices); justETF profile pages (reference data only, approved 21 Oct 2026) | 72 European-listed funds by class — world, US, Europe (FTSE MIB, DAX, EURO STOXX 50), emerging & Asia, factors & dividends, sectors & themes, real estate, bonds, cash & ultrashort (XEON, ERNE), gold / silver ETCs, bitcoin ETPs — named by the Milan ticker (SWDA, VWCE, CSSPX…), with ISIN. CURRENCY EUR / USD / GBP / CHF: each fund is priced on its own line in that currency where CNBC carries one (lines checked 21 Oct 2026 — EUR: Xetra first, Milan for ETFMIB / CSMIB, Paris for CoinShares Bitcoin; USD and GBP: London, pence lines ÷ 100; CHF: SIX), otherwise its default line converted at CNBC's live EUR= / GBP= / CHF= rates (marked conv., DERIVED; returns at each day's FX close). The line is always shown, never presented as the Milan price (CNBC does not carry most Milan ETF lines). 1D from CNBC's quote, 1W…1Y DERIVED from CNBC's daily bars of the same line. TER, fund size, distribution, replication, domicile, fund currency, hedging, inception: justETF, read by the 5-minute cron (one fund a run, each weekly; N/A until read; 6-hour pause if justETF refuses). Also found in SRCH by any of its tickers or its ISIN |
| Calendar | WORLD: Forex Factory weekly export (`nfs.faireconomy.media/ff_calendar_thisweek.json`), archived weekly in KV; market reaction from 1-minute prices (Twelve Data FX, Alpaca SPY/TLT); US OFFICIAL: BLS + BEA ICS schedules | WORLD (default): this week + the last 4 days (archive); filters by impact (HIGH / HIGH + MEDIUM / ALL) and currency (USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, CNY), remembered in the browser; forecast/previous as published; ACTUAL from the Nasdaq economic calendar (`/api/nasdaq/calendar`, matched by country, time and name; marked NQ), else N/A; REACTION 15M for released high-impact events (price just before vs +15 / +60 min, DERIVED; ≤ 3 new per request, 1 Twelve Data credit each, then kept); click an event for details and past releases (archive since 7 Oct 2026); countdown for the next 24 h; NEXT HIGH-IMPACT banner + status-bar countdown. US OFFICIAL: actual/previous N/A until a FRED key is configured. The briefing uses the high-impact world events. |
| News | Top publishers' own public RSS feeds: Financial Times, Bloomberg, The Wall Street Journal, MarketWatch, CNBC, The Economist, Il Sole 24 Ore; Reuters from its own public news sitemap (headline, time, link); official releases of the Federal Reserve (press + speeches), ECB and Bank of England; SEC EDGAR filings for the watchlist | headline, section, time, link only — never article text; tabs ALL (publishers + central banks) / FT / BLOOMBERG / WSJ / MARKETWATCH / CNBC / ECONOMIST / SOLE 24 ORE / REUTERS / CENTRAL BANKS / SEC FILINGS |
| Equities (EQ) | the heat-map lists and prices (IVV / QQQ / DIA holdings; Alpaca) | S&P 500, Nasdaq-100 or Dow 30 members as a board: weight, last, 1D…1Y change, base date; sector filter, text filter, sort; breadth and equal / index-weighted change (DERIVED) |
| Movers (MOV) | Nasdaq market movers (`/api/nasdaq/movers`, approved 20 Oct 2026) · FINRA short interest (`/api/finra/shorts`, approved 21 Oct 2026) · your instruments (Twelve Data) | U.S. MARKET: most active, top gainers, top losers among every U.S.-listed stock as Nasdaq publishes them (delayed); MOST SHORTED: FINRA consolidated short interest of the latest settlement (the 2,500 largest positions of exchange-listed securities) with % of shares outstanding (short ÷ Nasdaq market cap ÷ last price, DERIVED), shares short, change, days to cover, size filter and sorts; MY INSTRUMENTS: the watchlist and boards ranked |
| Screener (SCR) | Nasdaq screener files (`/api/nasdaq/screener?ex=nasdaq\|nyse\|amex`) | every U.S.-listed stock (~7,000): exchange, sector, size, move, country (U.S. / outside: ADRs), min price / volume, text; sort by market cap, change, volume, price, symbol; last sale, change and volume as Nasdaq lists them (delayed) |
| Compare (COMP) | Twelve Data daily history · ECB daily reference rates (`/api/portfolio/fx`) | rebased 100, % change or raw; in each instrument's own currency or converted to USD / EUR / CHF / GBP / JPY at the ECB rate of each day (DERIVED) |
| Currencies (FX) | Twelve Data `/quote` (8 pairs vs USD) · CNBC (DXY, through IDX) | last, change, open/high/low, previous, 52-week range; the ICE U.S. Dollar Index (DXY) from CNBC; average USD move vs the 8 (DERIVED); crosses in FXM (the FX matrix); currency futures in FUT |
| Crypto (CRYPTO) | Alpaca crypto (USD pairs) | last trade, 1D…1Y change (completed UTC days), traded value of the last completed day |
| Commodities (CMDTY) | CNBC quote service (front-month futures, daily bars) · U.S. EIA Open Data v2 (`EIA_KEY`) or the same series on FRED (spot) · EIA weekly series (`EIA_KEY`, inventories) · Twelve Data (gold spot) | 26 front-month futures (energy, metals, grains, softs, livestock) with contract month, last, change, 1W / 1M / 3M / YTD / 1Y from CNBC's daily bars (DERIVED), 3-month line, time and real-time / delayed mark; EIA daily spot energy with its price date (published ~a week behind); U.S. weekly inventories from the EIA Weekly Petroleum Status Report and Natural Gas Storage Report (crude excl. SPR, Cushing, SPR, gasoline, distillate, jet fuel, gas in storage, refinery utilization, crude production) with week-on-week change, change from a year earlier and the gap to the 5-year average of the same week (DERIVED), 60-week line; a series EIA stopped publishing is N/A with its last date; gold live. EIA's NYMEX futures series ended on 2024-04-05 and are not used: curves by contract month are FCRV (CNBC) |
| Futures (FUT) | CNBC quote service (approved 20 Oct 2026) | 45 contracts in 9 groups (equity index, rates, currencies, crypto, energy, metals, grains, softs, livestock) with contract month, last, returns (DERIVED from daily bars), chart; WHERE THE CASH INDICES ARE SET TO OPEN: S&P 500, Nasdaq-100, Dow, Russell 2000, Nikkei 225 — the futures' move since the minute of the cash index's last print (five-minute bars) applied to that print, judged by exchange hours (DERIVED, ignores fair-value basis); COT positioning one click away |
| Futures curves (FCRV) | CNBC quote service (continuous contracts 1…12, daily bars) | 12 curves (WTI, Brent, natural gas, RBOB, heating oil, gold, silver, copper, corn, wheat, soybeans, coffee) by contract month: now, a week and a month before (same positions), change, spread to the previous month (DERIVED) |
| My boards (BOARD) | your lists (Workers KV) · Twelve Data quotes | named boards of up to 12 symbols, each checked with a real quote before it is added |
| Reddit (RDT) | ApeWisdom (approved 20 Oct 2026) | tickers mentioned most in the last 24 hours (all stock subreddits, r/wallstreetbets, r/stocks, r/investing, r/options, crypto): mentions, the 24 hours before, upvotes, rank change (DERIVED) — a count, not a sentiment |
| Spreads (SPRD) | MARKET (default): CNBC market yields and their daily bars · OFFICIAL: ECB Data Portal (YC, AAA 2Y / 10Y) · FRED (H.15; `FRED_KEY`) | MARKET: the spread between any two of the 141 market yields (presets BTP–Bund, OAT–Bund, Bonos–Bund, Gilt–Bund, UST–Bund, 2s10s / 5s30s of several countries…, or any pair), latest quotes vs the last daily bar, Δ 1W/1M/3M/1Y, range, percentile and z-score over 3M…5Y (DERIVED, common dates only; a warning when the two markets close at different times); OFFICIAL: euro-area and U.S. 2s10s histories |
| Yields · MARKET (YLD, default view) | CNBC quote service (`quote.cnbc.com` restQuote; daily bars from `ts-api.cnbc.com`), approved 20 Oct 2026 as intraday market data — 141 maturities in 33 countries checked from the Worker (no Poland, Czech Republic, Colombia, Taiwan, Philippines, Israel, Norway; Singapore's symbol is not a yield) | latest quote of each maturity with its time, bond (coupon, maturity) and venue as CNBC labels it (e.g. Tradeweb); STALE after 4 days without a quote; Δ vs the previous close and vs CNBC's daily bar 1W / 1M / 3M / 1Y earlier (dated as CNBC dates its bars: U.S. and Canada the session's date; German, French and Italian bonds the day after the session; some markets have weekend bars), 2s10s, spreads vs Bund / UST between the latest quotes — DERIVED; curve vs past closes; GRID of every country × maturity as a heat map (level, or Δ 1D / 1W / 1M / 3M / YTD / 1Y in bp); 5-year daily history of any maturity. Always labelled market data, never mixed with the official curves |
| Central banks (CB) | COMPARE: BIS WS_CBPOL (daily CSV for the last 14 months + end-of-month since 2006; ~1 week behind) for 39 central banks (Croatia left out: euro since 2023) · next decision: Forex Factory this week (with the time) or each bank's own published calendar (14 banks, read 20 Oct 2026, `src/cbmeetings.mjs`; Riksbank and Banco Central do Brasil not readable) · PRICED: market yields (above). OFFICIAL DETAIL: ECB Data Portal (DFR, MRO, MLF) · New York Fed markets API (EFFR + FOMC target range) · Bank of England IADB · SNB data portal · Bank of Canada Valet | COMPARE: rate and its date, last move (first day of the new level, bp, level before; month only when older than the daily window and not found in that month's data), 12-month change and number of moves (DERIVED), next decision, priced = 3M / 1Y / 2Y government yield − policy rate (DERIVED; euro area on German yields); sort by region, rate, latest move, 12-month change. HISTORY: up to 8 banks since 2006 with latest / 1Y / 5Y earlier / high / low. OFFICIAL DETAIL: same-day figures, the level before the last change and its date |
| Earnings (ERN) | Finnhub earnings calendar (`FINNHUB_KEY`) · Alpaca daily closes | S&P 500 + Nasdaq-100 companies (our index lists), 4 days back / 12 ahead, the 60 largest by index weight or all; time (before open / after close), quarter, EPS and revenue estimate and actual, surprise (DERIVED), price reaction of the first session after the report (DERIVED) |
| Company (DES) | SEC EDGAR (submissions, XBRL companyconcept) · Twelve Data price · Nasdaq (analysts, institutional holders) · FINRA (short interest, Reg SHO short volume) · CNBC (listings outside the U.S.) | profile (industry SIC, exchange, fiscal year end, address, filings); revenue, net income, diluted EPS, assets, equity (last fiscal year, the year before, latest quarter, as filed), shares from the latest cover page; market cap, P/E, net margin, P/B, equity/assets DERIVED; ANALYSTS: mean rating and number of analysts, consensus price target with low / high, upside vs the live price (DERIVED), buy / hold / sell, EPS forecasts by quarter and fiscal year with range and revisions, monthly history of the consensus; SHORT INTEREST: latest settlement, change, days to cover, % of shares on the SEC cover page (DERIVED), history, short volume of the last 5 sessions; INSTITUTIONAL HOLDERS: ownership %, holders, increased / decreased positions, top holders (13F) with their filing date. A listing outside the U.S.: CNBC's quote and fundamentals (market cap, P/E, EPS, dividend yield, shares, 52-week range), no SEC profile claimed |
| Options (OMON) | Alpaca options (contracts + snapshots, free **indicative** feed) | CHAIN (±15% around the spot: OI, IV, delta, last 15-min delayed, bid/ask indicative → PARTIAL), SMILE (IV by strike), TERM STRUCTURE (ATM IV, straddle and expected move per expiry), SURFACE (IV by moneyness × expiry), PAYOFF (legs bought / sold at the indicative mid; profit or loss at expiry, break-evens, max gain / loss); ATM IV, expected move, max pain, put/call OI (DERIVED) |
| Workspace (WS) | — | `WS AAPL` opens chart, DES, OMON and news for a ticker, tiled |
| Ratio (CROSS) | Twelve Data daily history (1Y / 5Y) | A / B ratio on common dates, Δ 1M…5Y, correlation of daily returns, percentile in its range and z-score (all DERIVED) |
| Backtest (BT) | Twelve Data daily history, split- and dividend-adjusted (1Y / 5Y) | ONE SYMBOL: buy & hold or SMA crossover (long / flat); signal at a close, executed at the next close; costs only as set; total return, CAGR, volatility, Sharpe (risk-free 0), max drawdown, trades, time in market, vs buy & hold. PORTFOLIO MIX: up to 8 holdings with weights, rebalancing none / monthly / quarterly / yearly, vs a benchmark; the same statistics for the mix, each holding and the benchmark, calendar-year returns, correlation (all DERIVED) |
| Alerts (ALRT) · Notes (NOTE) | your lists (Workers KV) · CNBC quote service · Nasdaq economic calendar · Telegram Bot API (optional, `TELEGRAM_BOT_TOKEN`) | alerts checked ON THE SERVER every 5 minutes (Cron Trigger), also with the terminal closed: PRICE ≥ / ≤ (fires once, RE-ARM), DAILY MOVE ±x% vs the previous close (once a session), MARKET OPEN / CLOSE of 15 markets (the main index printed after today's open / 30 minutes after the close — holidays skipped because the index does not print), DATA RELEASE (a release of a country whose name contains the words is published with its actual); only a fresh quote (last trade ≤ 30 min) fires; price and time recorded; sent to the linked Telegram chat (EN / IT) and shown in the page (toast, desktop notification); symbols: U.S. stocks / ETFs, listings elsewhere (`ISP:XMIL`, `C:<code>` — not those CNBC dates without a time), FX pairs, crypto, metals, `IDX:<id>`, `FUT:<root>` (≤ 25); notes, optionally tied to a symbol |
| System (SYS) | `/api/status` | which sources are configured (yes/no only — never key values), Twelve Data credits (checked on request: 1 credit, reused 5 min), last scheduled run, this page's budget |
| Settings (SET) · Saved views (VIEW) | this browser (themes) · your list (Workers KV, views) | eight themes with full palettes (AMBER default, BLOOMBERG, ICE, MATRIX, MONO, NORD, SOLARIZED, CARBON) and custom accent / up / down colours; saved views: name the current layout (window types, what each shows, positions), reopen it later — the current windows close (UNDO brings them back), positions scale to the screen |
| Briefing | Cloudflare Workers AI (Llama 3.3 70B), archive in Workers KV | editions in the reference format: Daily (weekdays from 07:30 Rome: In one line · Equities · Rates and currencies · Commodities and crypto · Today), Evening (from 22:30: In one line · How the day went · What changed since this morning · Tomorrow), Weekly (Saturday), Monthly (first Saturday). Written once from real data only (S&P 500 constituents; world index levels — S&P 500, Nasdaq-100, Dow, Nasdaq Composite, Russell 2000, VIX, EURO STOXX 50, STOXX 600, DAX, SMI, IBEX 35, Nikkei 225, SSE Composite, CSI 300, Ibovespa, MSCI EM / ACWI — and the three strongest and weakest STOXX Europe 600 sectors, with the week's / month's change from each index's own history in the weekly / monthly; the ECB fixing (EUR crosses and dollar crosses through it, with the week's / month's change); EIA energy spot prices with their own date (published with a lag); Alpaca crypto pairs (completed UTC days); IMF monthly metals and crops in the monthly; FX/crypto/gold quotes, curves, calendar, FT, Bloomberg, WSJ, MarketWatch and central-bank headlines with links); tickers become chips; windows that explain each section (chosen from the edition's own data: the largest benchmark-index move (IDX), heat map, leading sector, contributors compared, biggest mover, curves vs previous publication, euro-area 2s10s, largest ECB move (markets board), largest FX move, oil with its date (CMDTY), gold, crypto board, the next high-impact release opened in the calendar, central banks on a rate-decision day) appear under their section with a one-line reason built from the same figures; ▦ Open all as a view lays out the briefing on the left and its windows on the right, ↩ MY LAYOUT brings the previous windows back; every figure checked, links outside the data removed. An edition is written only inside its window, never later with newer data. Written automatically at its time (see Scheduled briefings). |

## Function menu (T07)
`☰ FUNCTIONS` in the taskbar or the dock, `MENU` in the command line, or the `m` key: every function by
category with its code — MARKETS (IDX EQ FX CMDTY CRYPTO ETF FUT COT BOARD WL HEAT MOV SCR RDT MKT EXCH BRIEF NEWS),
RATES & MACRO (YLD CURVE SPRD CB CAL ERN FXM FCRV), ANALYSIS (DES OMON WS COMP PERF CROSS CORR BT),
MY STUFF (PORT PFA ALRT NOTE SYS), LAYOUT (SET VIEW CLOSE UNDO TILE TOUR HELP). Type to filter, Enter to open; functions
without an approved source are marked N/A. A ticker goes with a function in either order (`DES AAPL`,
`AAPL OMON`, `WS MSFT`, `BT NVDA`, `CROSS NVDA AAPL`). `TOUR` walks through the interface.

The top of the screen is one row: brand, a compact command line, the taskbar (▦ tile, ✕ close all, ↩ undo, then the open windows; it scrolls sideways and fades at the edge when they overflow) and the status with the clock. The bottom of the screen is one dock row (Nico's style): `☰ FUNCTIONS` and ten shortcuts (IDX, WL, YLD, CAL, MAP, BRF, N, MKT, PF, HELP) on the left, the data badge on the right (live / stale / N/A counts; its tooltip has the U.S. session, watchlist breadth and the last pull). The scrolling ticker tape is off by default (SETTINGS → TICKER TAPE).

## Scheduled briefings (Cron Trigger)
Editions are written at their time whether or not the terminal is open: Daily 07:30 and Evening 22:30
(Mon–Fri), Weekly 08:00 (Saturday), Monthly 08:00 (first Saturday), Rome time (CET/CEST handled by the
time zone). `src/cron.mjs`, triggers in `wrangler.toml` (`* 5-7 * * *`, `* 20-21 * * *`, UTC).
- Free plan = 10 ms CPU per run, so **one run does one thing**: from ~21 minutes before the slot (daily; ~36 on the
  first Saturday), each minute fetches one input with the same loaders the terminal uses (IVV universe, yields, the
  German, UK and Japanese curves (one each), world calendar, FT, Bloomberg, WSJ, MarketWatch, central banks, the
  European and the Asian indices, the ECB fixing (25 days), energy, crypto closes, the U.S. indices, Alpaca closes,
  Twelve Data FX; weekly/monthly also the 1W/1M references, FX daily series, crypto closes a week / a month ago, each
  U.S. and MSCI index history (one file per minute, a 60-row tail kept for the edition) and, monthly, IMF prices),
  plus two retry minutes that take turns over the inputs still missing.
- Inputs are staged in Workers KV (`stage/…`, ≤ 3 days), not in the per-location cache: scheduled runs
  execute in any Cloudflare location.
- At the slot the edition is written **from staged data only** (no source is called), retried at +5 and
  +10 minutes if the write failed. Evening: today's consolidated closes are read at 22:30 (16:30 ET, session
  final), the U.S. index levels at 22:31, a retry at 22:32, and the edition is written at 22:34. Monthly is written at 08:02, after the weekly.
- The terminal does not write an edition while the scheduled run is due (`409 scheduled_write`); it shows
  it as SCHEDULED and writes it itself only if it is still missing ~12 minutes after its time. REWRITE still
  works. Each edition records `writtenBy: schedule | terminal`; `/api/briefs` reports the last scheduled run.
- Writing an edition (scheduled or from the terminal) reads the markets inputs only from these staged copies; each copy is read once.
- Usage: ~300 runs/day, ~130 KV writes/day (free: 100k requests, 1,000 KV writes), 6 Twelve Data credits per edition (the markets inputs cost none).

## Quant tools (QNT)
One window, seven tools, all DERIVED in the page (`public/terminal/qmath.js`, formulas only, unit-tested in
`test/quant.test.mjs`; not called quant.js, a name content blockers block as Quantcast's tracker) from real daily closes (`/api/history`, adjusted, one Twelve Data credit per symbol, cached;
CNBC for listings outside the plan). Results are cached per input; too little history → N/A, never an estimate.
- `MC NVDA` — Monte Carlo: 1,000 / 5,000 / 10,000 paths over 1 month … 1 year from the past daily log returns: block
  bootstrap (runs of 5 days, keeps volatility clustering), bootstrap or normal (past μ, σ). Fan of the 5 / 25 / 50 / 75 /
  95 % paths after the real history; at the horizon: median, mean, 5–95 % range, probability of a gain, of a 10 % / 20 %
  loss, of touching −10 % on the way, VaR / ES 95 % and 99 %, probability of ending above a target price; histogram.
  Numbered runs (mulberry32): the same inputs and run number give the same result.
- `VAR NVDA` — VaR and ES at 95 / 99 / 99.5 %, 1 or 10 days (overlapping returns), on a position amount: historical,
  normal, Cornish–Fisher (skew / kurtosis), EWMA (λ 0.94). Backtest of the 1-day historical VaR 99 % (250-day window,
  last 250 days): exceptions, Kupiec POF (LR, p), Basel zone; chart and exception days.
- `VOL NVDA` — realised volatility over 21 / 63 / 252 days: close-to-close, Parkinson, Garman–Klass, Rogers–Satchell,
  Yang–Zhang (OHLC; N/A without it); EWMA; GARCH(1,1) by maximum likelihood (Nelder–Mead): α, β, persistence,
  half-life, long-run and next-day volatility, forecasts 1W … 1Y; volatility cone 10 … 252 days with today's percentile.
- `DIST NVDA` — histogram of daily log returns with the normal of the same μ, σ; skewness, excess kurtosis (bias-adjusted),
  Jarque–Bera, quantiles, days beyond 2σ / 3σ vs normal, autocorrelation of returns and squared returns with Ljung–Box Q(10).
- `BETA NVDA SPY` — OLS on the benchmark's daily returns: β (± s.e., t), α annualised, R², correlation, idiosyncratic
  volatility, tracking error, information ratio, up / down capture; scatter with the line; rolling 63-day β.
- ETF section, 22 Oct 2026: the screener shows 1Y, 3Y and 5Y a year, volatility (3 years) and max drawdown (5 years)
  for every fund, sortable — from CNBC's daily bars of each fund's Xetra EUR line (U.S. ETFs: USD), computed by their own
  cron (`2-59/10`, 8 funds a run, KV `etf/perf`, each fund about weekly) and live for the rows on screen
  (`/api/etf/perf?ids=`, `/api/etf/perftable`). ETF COMPARE: up to 8 funds on up to 15 years (each fund's own line in
  EUR / USD / GBP / CHF, else converted), period ALL / 10Y / 5Y / 3Y / 1Y, total, a year, volatility, Sharpe, Sortino, max
  drawdown with dates, Calmar, worst month, months up, calendar years, correlations, rebased and drawdown charts. +LAB in
  the screener, the profile and the compare adds a fund to the lab portfolio being built. An ISIN on neither list (a fund
  listed off Xetra) is found through the ISIN search (OpenFIGI / Twelve Data → CNBC) in PLAB, EFC and FACT.
- `WIF` — what if I had bought… (menu MY STUFF): purchases of stocks, ETFs, bond ETFs — once or every month (same day,
  from / until), amount and fee in EUR — on real history: each bought at the close of the first day the instrument traded
  on or after the date (none within 7 days → not bought, shown), valued daily at each one's last close (CNBC, EUR via
  `/api/plab/series`). Per row: buys, money put in, value today, gain, money-weighted return, units, average price; total,
  IRR, the same money on the same dates in a benchmark, time-weighted max drawdown and volatility, where the gain came from,
  chart. Saved on the server (`/api/user/wif`, ≤ 20).
- `YAS IT0005…` — bond yield calculator (menu RATES & MACRO): the terms from the ECB list of eligible marketable assets
  (coupon, issue and maturity dates, currency, issuer) or, for a bond not on it, parsed from OpenFIGI's Bloomberg-style
  ticker (`/api/bond/ref`, "BTPS 4.4 05/01/33"; floating-rate → not applicable) or typed; frequency by issuer country
  (IT / US half-yearly, euro area annual; another currency's bond: USD / GBP half-yearly, EUR annual); the clean price
  typed (no bond price source connected).
- Bonds in PLAB and WIF, 22 Oct 2026 ("price rebuilt from the curve"): a bond ISIN has no daily price here, so it is an
  ESTIMATE, always said: each day the government curve's yield at the bond's remaining maturity (CNBC daily yields of the
  maturities that bracket its life, `/api/plab/curve?cc=IT&tenor=10Y`, linear in between, flat beyond, a quote older than
  a week not used; European bars moved to their session's weekday) plus a constant spread set by today's clean price as
  typed in BUILD (0 without one), priced at the coupon frequency, coupons reinvested; from the issue date (15 years at
  most); a bond in USD / GBP / CHF converted at CNBC's FX (`/api/plab/fx`). The curve: the issuer's country for a bond in
  its own currency, else the currency's benchmark (EUR → Germany). Fixed and zero-coupon only (floating / index-linked →
  N/A). The ECB list files inflation-linked bonds (BTP€i, BTP Italia, OATi, iBund) and step-ups (BTP Valore) as fixed
  coupon, so OpenFIGI's ticker is read too (cached 7 days): CPI / ICPI / I/L / OATe, UKTI, SPGBEI → inflation-linked, N/A
  in PLAB, a REAL yield in YAS; VALR → step-up, priced at today's coupon, said. A bond not on the ECB list has no issue
  date: typed in BUILD, else N/A. BUILD → "+ GOVERNMENT BONDS (ECB LIST)": a country's central-government bonds to pick
  from (`/api/bond/list?cc=IT`).
- Backups, 22 Oct 2026 (`src/backup.mjs`; "dove il provider non va più serve un backup, in ogni cosa"): a value from a
  backup is always labelled with the provider that gave it and the first one's error (BACKUP in captions, `backupFor` /
  `primaryError` in the answers). Quotes: Twelve Data (credits, limit, refusal, outage, no key) → CNBC (U.S. stocks, FX
  EUR/USD → EUR=, crypto BTC/USD → BTC.CM=, metals, listings elsewhere; 5 s at most) → Finnhub (U.S. stocks) → Alpha Vantage
  (secret ALPHAVANTAGE_KEY, 25 a day, counted) → the last real quote STALE → N/A with what was tried. Chart history:
  Twelve Data → CNBC bars → Alpaca daily (U.S.) → Alpha Vantage (the last 100 sessions, said) → STALE. CNBC daily bars
  (PLAB, EFC, FACT): CNBC (or its stale copy) → FRED H.10 for EUR= / GBP= / CHF= / JPY= → Alpaca for U.S. symbols; a
  Xetra / Milan line has no free backup. World exchanges: Twelve Data market_state → each market's main index on CNBC
  (in its regular session, printed in the last 30 minutes; no countdown). World calendar: Forex Factory → this week's
  archived copy (STALE) → the Nasdaq economic calendar (actual, consensus, previous; no importance rating, every event
  shown, said). Indices: an official source with nothing (Cboe, STOXX, Nikkei, SIX, SSE, B3, ASX) → the same index on CNBC.
  No backup exists where one publisher is the source (CFTC, FINRA, French library, central banks' curves and calendars,
  justETF, ApeWisdom): the last real copy STALE. Stooq (approved) is not used: its downloads now sit behind a JavaScript
  check. Tests: test/backup.test.mjs.
- PLAB → WHAT TO BUY, 22 Oct 2026: the portfolio open in the lab is the target; your open positions (PORTFOLIO) at their
  live prices in EUR are what you hold, matched to the target by the fund's ISIN (`/api/etf/resolve`: Xetra mnemonics,
  UCITS tickers and lines) or the symbol (several listings of one fund add up). This month's money is split so that the
  most underweight holdings come up first — each one bought ends at the same value / weight ratio (water filling,
  qmath `buyPlan`); nothing is sold unless "also sell" (overweight down to its target, a position outside the target sold
  entirely; the gain realised from the EUR average cost, tax at 26 %, a loss said as a capital loss). Smallest trade, the
  cost per trade of the BACKTEST settings, whole units, positions outside the target counted or not, cash already set
  aside for a CASH weight. Units at your position's live price, else the last CNBC close in EUR of the line used (dated);
  a bond's nominal at the price typed (or the estimate's price). Largest gap before → after, orders to copy. A plan, not
  an order. Tests: test/rebalance.test.mjs, e2e [Q] WHAT TO BUY.
- ALRT → PORTFOLIO OFF TARGET (`kind: drift`, 22 Oct 2026, `src/drift.mjs`): weekdays at 18:40 Rome time (and on CHECK
  NOW) the server values your open positions (KV `pf/tx`) at CNBC's last prices in EUR (EUR= / GBP= / CHF=; pence ÷ 100;
  CNBC's U.S. fallback refused), matches them to a saved lab portfolio's weights (cash left out, the rest scaled to
  100 %; positions outside the target in the total, said, not a gap) and sends a message when a holding is ≥ the points
  set from its weight — at most once an ISO week. A position without a price or in a currency without FX here → no check,
  the reason in the engine's log. Tests: test/drift.test.mjs, e2e [Q] ALRT drift.
- ECB list of eligible marketable assets (approved 22 Oct 2026, `src/ecbassets.mjs`): the ECB's daily TSV (checked
  22 Oct 2026: UTF-16LE with a byte-order mark, 8.9 MB, 31,345 assets; residence written "IRIT"; Range ignored; Monday to
  Friday ~18:15 CET) read by the 10-minute trigger 768 KB a run (the stream read up to the slice; a Range request where a
  server honours it) into KV `bond/ecb` (fixed and zero-coupon bonds: ISIN, coupon, issue, maturity, currency,
  issuer residence and group, issuer) — about a dozen runs once a new file is out, the other slots stay with the ETF
  screener. Bundesbank / FedInvest prices (approved, researched 22 Oct 2026): not connected — the Bundesbank publishes the
  federal securities' prices as a monthly XLSX behind a changing link (columns not yet checked), FedInvest only as XML
  behind a session form (and part of the site disallowed to robots); the price stays typed. Yield to maturity
  (compounded at the coupon frequency) and effective, net of 12.5 % / 26 % tax (coupons and a gain at maturity — a
  simplification), current yield, accrued ACT/ACT (ICMA) or 30E/360, dirty price, Macaulay / modified duration, convexity,
  DV01, cash flows on the nominal (gross, net, present value), price if yields move ±50 / 100 / 200 bp.
- PLAB PROJECTION, "with your assumptions": per holding a return (compound, a year) and volatility — the past on the
  common window as the starting values — correlations from the holdings' past monthly returns; monthly log-normal draws
  (Cholesky), rebalanced monthly; labelled a model, not data.
- `PLAB` — portfolio lab (menu MY STUFF): portfolios with target weights (ETFs by Xetra / Milan / UCITS ticker or ISIN,
  stocks, C:codes, SYMBOL:MIC, CASH at 0 %; or imported from PORTFOLIO at today's market values), up to 20 saved on the
  server (`/api/user/plab`, 1–15 holdings, weights adding up to 100). Each instrument's CNBC daily closes in EUR, up to 15
  years (`/api/plab/series?id=`, one request each; converted at CNBC's FX of the same day — DERIVED; justETF TER and
  distribution policy). BACKTEST on the window every holding shares (it starts at the youngest one's first close, said):
  initial amount, monthly contributions on the first trading day of each month, rebalancing none / monthly / quarterly /
  yearly, cost per trade; the benchmark gets the same money on the same days. Final value, money put in, money-weighted
  return (IRR), time-weighted CAGR and total, volatility, Sharpe (risk-free as set), Sortino, max drawdown with dates and
  recovery, Calmar, best / worst month, calendar years; value and drawdown charts. RISK (last 756 common days at target
  weights): volatility, historical VaR / ES 95 / 99 % (also in € on the final value), beta and correlation with the
  benchmark, diversification ratio, each holding's share of risk, correlation matrix; STRESS: today's weights through seven
  past crises (S&P 500 closing high → low dates; each holding's own EUR closes; N/A when a holding has no data then).
  COMPARE: 2–4 saved portfolios on their common window, same settings, metrics + weighted TER + chart. PROJECTION: Monte
  Carlo from the portfolio's own past monthly returns (6-month blocks, 5,000 paths, numbered runs) with monthly
  contributions: median, 5–95 %, probability of a target and of ending below the money put in; nominal EUR. FACT on a lab
  portfolio (cash left out). Price returns: distributing funds' payouts and stocks' dividends are not added (said).
- `FACT SWDA` · `FACT NVDA` · `FACT PORT` — Fama/French factor exposure (Kenneth R. French Data Library, approved 21 Oct
  2026): monthly excess returns in USD over 5 or 10 years regressed on the region's factors — Developed, Europe or the U.S.,
  chosen from the listing or the fund's justETF focus (or by hand). β with t and p for market, size (SMB), value (HML),
  profitability (RMW), investment (CMA) and momentum; alpha a year; R² and adjusted R²; each factor's share of the variance
  (they add up to R²) and of the average excess return (with alpha they add up to it); CAPM / FF3 / FF5 / FF5 + momentum
  side by side; betas over rolling 36 months. One instrument (ticker, ISIN, C:code, SYMBOL:MIC) or the portfolio at today's
  weights (the 8 largest positions, held constant). Prices: CNBC daily bars, the last close of each month, converted to
  USD at CNBC's FX of that day (DERIVED). Fewer than 36 months → N/A. Also a FACT button in the ETF profile.
- `EF NVDA MSFT SPY` — 2–8 symbols, long only: efficient frontier (projected gradient on the simplex), minimum variance,
  maximum Sharpe (risk-free rate as set), risk parity, equal weights; weights, return, volatility, Sharpe; risk shares.
- `SEAS NVDA` — returns by month × year from 10 years of monthly closes (a month without the previous close stays
  empty), averages, medians, % positive; by weekday from the daily closes.

## Split screen (desktop)
- ◫ in the taskbar, ◫ in a window's title, Alt+← / Alt+→, `SPLIT` in the command line or the menu (LAYOUT): the window
  in front and the previous one side by side, each full height; again: swap. A divider between them: drag to resize
  (20–80 %), double-click for half and half, ← → when focused. `SPLIT NVDA MSFT`, `SPLIT WL N` (a function or a ticker
  each) opens or brings both; `SPLIT NVDA` pairs it with the previous window. With one window it takes the left half and
  the right half lists the open windows (or the next window opened fills it; Esc cancels). Moving, resizing,
  minimising or maximising one of the two, TILE, CLOSE or a saved VIEW ends the split; the browser's size is followed.

## iPhone app (installable web app, no cost)
- Install: open alessandrozanichelli.com/terminal/ in Safari → Share → Add to Home Screen. It opens full screen
  (`display: standalone`), translucent status bar over the theme's background. iOS 26.1+ blurs a band under the
  clock, so the header starts 20 px below the inset; the tab bar sits 18 px into the home-indicator area (both tuned
  on the iPhone). The status-bar tag is read at install time: changing it needs the app removed and added again., with its icon and launch image; no App Store, no Apple
  developer account. Updates arrive with every deploy.
- Sign-in: the same Cloudflare Access policy. The installed app keeps its own cookies, so the e-mail code is asked once
  per Access session (24 h today; the session length is set in Access). The manifest is fetched with credentials.
- Layout at ≤ 880 px (phone, and the installed app): one window at a time, full screen; a tab bar (MARKETS, WATCH, NEWS,
  PORTF., MENU, WINDOWS with the count); WINDOWS is a sheet to switch, close, close all, reopen, reload; the function
  menu full screen with a close button; BACK (‹ with the previous window's code in the title, or a swipe from the
  left edge) goes to the window shown before, closed windows skipped, the windows opened at start are not a history; fields at 16 px (iOS does not zoom); no field focused automatically (no
  keyboard pop-ups); home indicator and landscape insets respected. The height is the window's own (`innerHeight` →
  `--app-h`), never vh / dvh, which leave a gap at the bottom of home-screen apps on recent iOS. Wider (a rotated tablet, a desktop):
  floating windows as before.
- `public/terminal/sw.js` (service worker, scope /terminal/): keeps only the interface (page, scripts, chart library,
  icons) so the app opens without a network or on a slow one (network first, cached copy after 3.5 s or offline). It
  never handles `/api/*`: data is always live, N/A without a network. A redirect (Access sign-in) passes through and is
  never cached.
- When `/api` stops answering, a bar says why: SESSION EXPIRED (sign in again) or NO NETWORK — checked with
  `/api/health`, also when the app comes back from the background after 5 minutes.
- Icons and launch images: `public/terminal/app/`, drawn by `tools/mkicons.py` — since 22 Oct 2026 the terminal's prompt
  on one line: an amber `>`, AZ, an amber block cursor (no degree sign); the top bar reads AZ TERMINAL. An installed iPhone app
  shows the new icon once removed from the Home Screen and added again.

## Languages (EN / IT)
- Toggle in the top bar, remembered in the browser (Italian by default for an Italian browser).
- `public/terminal/i18n.js` renders the terminal's own words (labels, messages, notes) in Italian as they are drawn; data is never translated (headlines, company and event names, tickers; `.notranslate`). Each text node is translated once; phrases never match inside longer words.
- Briefings are written by the model in English and Italian from the same DATA (same number check, decimal point kept); editions without the Italian version can get it on request from their own stored data (`POST /api/briefs/lang?id=…&lang=it`).

## Symbol discovery (T05)
search → select → fetch. Nothing is preloaded and no ticker list is maintained by hand.
1. **Discovery**: `/api/search?q=Novartis` asks the provider's symbol master (name or ticker, all
   exchanges it lists) and returns listings with exchange, MIC, country, currency, type and the data
   plan each one needs. Provider call without a key (no credit); cached 24 h per query.
   **ISIN** (`/api/search?q=IT0000072618`, check digit verified; approved 21 Oct 2026): OpenFIGI's
   `/v3/mapping` gives the listings (ticker + Bloomberg exchange code → MIC; U.S. venues merged; venues
   the terminal does not quote left out), each matched to Twelve Data's record of the same listing
   (name, currency, plan) or named from OpenFIGI and quotable through CNBC when it carries it; the
   home market first, then other markets, then a foreign issuer's U.S. line. Typed in the command line
   it opens the first quotable listing. Reference data only; cached 7 days. When OpenFIGI is unreachable
   or does not know the ISIN, Twelve Data's own symbol search (which also answers ISINs, seen live
   21 Oct 2026) gives the listings, the home market first (`source: "Twelve Data symbol_search (ISIN)"`).
   **UCITS funds**: a query naming a fund of the UCITS list (a Milan, Xetra, London or SIX ticker, its ISIN, or a word of
   its name) also returns `ucits: [{ isin, sym, name, line: { ticker, venue, id: "C:EUNL-DE" } }]`, shown on top of SRCH
   (OPEN on its CNBC price line, +WL, LIST).
2. **Quote on demand**: OPEN fetches one quote; listings outside the current plan are shown as N/A at
   once (no call spent). +WL validates with a real quote before adding.
3. **History on demand**: requested only when a security window is open.
4. **Watchlist refresh**: only watchlisted / on-screen ids, in ≤ 7-symbol requests within the credit budget.

Instrument ids: plain ticker for US listings, FX, metals and crypto (`AAPL`, `EUR/USD`);
`SYMBOL:MIC` for every other venue (`NOVN:XSWX`, `HSBA:XLON`) → sent as `symbol` + `mic_code`.
Prices are shown in the listing's own currency (`$` only for USD); nothing is converted.
Limits: the provider returns at most 120 listings per query (a broad name can be crowded out by
warrants: search the ticker); indices are not in the provider's search — they are in IDX (`IDX DAX`).

## Endpoints
- `GET /api/health` → `{ ok, ts }`
- `GET /api/yields` → `{ curves: { US, EA, DE, UK, JP, CH, CA }, errors, notConnected }` · `GET /api/bonds` → `{ countries: [{ id, tenors: { "10Y": { value, d1, w1, m1, note? } }, date, source, status }], spreads, fred: { groups } }`
- `GET /api/cot` → `{ contracts: [{ code, name, group, root, date, oi, long, short, net, chg1w, chg4w, netPctOi, range, history, commNet }] }`
- `GET /api/cb` → `{ banks: [{ id, name, ccy, page, label, rate: { date, value, previous, changedOn | unchangedSince }, target?, others?, status }] }`
- `GET /api/cb/world` → `{ banks: [{ id, name, region, ccy, mkt, value, date, move: { date | month, from, bp }, chg12, moves12, note, status, next: { date, time, source, url, checked } }], source }` · `GET /api/cb/history?ids=US,XM` (≤ 12) → `{ series: { US: [["2006-01", 4.5], …] }, freq: "M" }`
- `GET /api/sprd` → `{ series: { EA: { points: [{ date, y2, y10, bp }], source, status }, US: { status: "N/A" } } }`
- `GET /api/energy` → `{ spot: [{ series, name, unit, date, value, chg1, chg5, chg21, history }], futures: { status: "N/A", error: "source_discontinued" } }` (503 `eia_not_configured` with neither `EIA_KEY` nor `FRED_KEY`); a spot series whose latest price is over 21 days old is `N/A` `source_discontinued` with `lastDate`
- `GET /api/energy/stocks` → `{ rows: [{ series, name, unit, kind, date, value, chgWeek, vsYearAgo, yearAgoDate, avg5, vsAvg5Pct, history }], status }` — EIA weekly, one request per EIA route (4), derived rows only; 503 `eia_not_configured` without `EIA_KEY`
- EIA staging: `api.eia.gov` answers keyed data requests in 15–30 s, so pages never call it. The 5-minute scheduled run (`refreshEia`) renews the most overdue EIA table (2 spot routes, 4 weekly routes) when its copy is over 4 h old, one request per run, into Workers KV (`stage/eia/…`); a failure writes nothing and is retried next run. Pages read that copy: LIVE up to 8 h, then STALE; not staged yet → N/A `not_staged` (spot prices then come from FRED's copy)
- `GET /api/earnings?back=4&fwd=12` → `{ rows: [{ sym, name, weight, index, date, hour, quarter, epsEstimate, epsActual, revenueEstimate, revenueActual }] }` · `/api/earnings/reactions` → `{ reactions: { "SYM|date": { session, chg } } }` (503 without `FINNHUB_KEY`)
- `GET /api/des?symbol=AAPL` → `{ profile, facts }` · `/api/des/fact?symbol=AAPL&c=revenue|netIncome|eps|assets|equity|shares` → `{ annual, prevAnnual, quarter, latest, latestMulti, concept }`
- `GET /api/options/expirations?symbol=AAPL` · `/api/options/chain?symbol=AAPL&exp=YYYY-MM-DD` → `{ spot, rows: [{ strike, call, put }], feed }`
- `GET|POST|DELETE /api/user/alerts` (+ `POST /api/user/alerts/rearm?id=`; body `{kind: price|move|session|release, …}`, a symbol is saved only if CNBC quotes it) · `GET|POST|PUT|DELETE /api/user/notes` · `GET|PUT /api/user/board` — same-origin JSON writes only
- `GET /api/alerts[?quotes=1]` → `{ alerts, log, engine: { lastRecorded }, telegram: { configured, chat, lang }, catalog, quotes? }` · `POST /api/alerts/run` (check now) · `GET /api/alerts/telegram/chats` · `POST|DELETE /api/alerts/telegram/link` · `POST /api/alerts/telegram/test` · `POST /api/alerts/telegram/lang` — the bot token is never returned
- `GET /api/cnbc/futures` · `/api/cnbc/returns?syms=` (≤ 16) · `/api/cnbc/curve?root=CL` · `/api/cnbc/implied` · `/api/cnbc/history?sym=` (5 years) — CNBC quote service, whitelisted symbols only
- `GET /api/nasdaq/calendar?from=&to=` (≤ 8 days) · `/api/nasdaq/screener?ex=nasdaq|nyse|amex` · `/api/nasdaq/movers` · `/api/nasdaq/company?sym=AAPL` (analysts, targets, EPS forecasts, institutional holders) · `GET /api/reddit?filter=all-stocks|wallstreetbets|stocks|investing|options|all-crypto`
- `GET /api/finra/shorts` → `{ settlementDate, rows: [[symbol, name, shortInterest, previous, changePct, avgDailyVolume, daysToCover, market]] }` · `GET /api/finra/symbol?sym=AAPL` → `{ shortInterest: [{ date, short, previous, changePct, adv, days }], shortVolume: [{ date, short, total, pct }] }`
- `GET|POST|DELETE /api/user/views` — saved layouts `{ name, desk, layout: [{ type, state, x, y, w, h, min }] }` (same name replaces)
- `/api/quote` and `/api/history` also serve listings outside the Twelve Data plan from CNBC (`source: "cnbc"`): `SYMBOL:MIC` ids on mapped exchanges after the plan refuses them (remembered a day), and `C:<CNBC code>` ids directly; a quote CNBC dates without a time carries `dateOnly`
- `GET /api/status[?usage=1]` → `{ sources: [{ id, name, use, configured }], twelvedata, credits, scheduler, alerts }`
- `GET /api/spx/universe[?u=NDX|DJI|SECT|CTRY|CRYPTO]` (also for `/closes` and `/live`; default S&P 500) → `{ holdingsAsOf, count, items: [{ sym, name, sector, weight }], source, fetchedAt, status }`
- `GET /api/spx/closes?ref=recent|1W|1M|3M|6M|YTD|1Y` → `{ ref, target, todayET, todayBarFinal, closes: { SYM: [date, close] | [[date, close]…] } }`
- `GET /api/spx/live` → `{ trades: { SYM: [price, time] }, live, medianTradeAgeSec }` (cache 60 s)
- `GET /api/calendar/history?ccy=USD&title=CPI m/m` → `{ releases: [{ datetime, forecast, previous }] }` · `GET /api/calendar/reactions` → `{ reactions: { <eventId>: { items: [{ symbol, pair, before, m15, m60, source }], final } }, pending }`
- `GET /api/exchanges` → `{ exchanges: [{ code, name, open, openedAt, closesAt, opensAt, major, label, city, tz, region }], majorOpen, majorCount, missingMajor, fetchedAt, status }`
- `GET /api/portfolio` · `POST /api/portfolio/tx` (JSON: date, side, sym, qty, price, ccy, fees, note) · `DELETE /api/portfolio/tx?id=` → `{ transactions, positions, realized, costBasis }`
- `GET /api/headlines?source=FT|BLOOMBERG|WSJ|MARKETWATCH|CB` → `{ items: [{ title, url, timestamp, section }], feeds, status }`
- `GET /api/briefs?period=daily|evening|weekly|monthly` → `{ due: { id, d, writable }, dueWritten, briefs: [{ id, d, title }], schedule }`
- `GET /api/briefs/item?id=daily-2026-10-07` · `POST /api/briefs/write?period=daily&symbols=…`
- `GET /api/etf/universe` → `{ xetra: { asOf, source, sourceUrl, cols, rows: [[isin, name, type, group, wkn, "MNEM:CCY …"]] }, us: { cols, rows: [[symbol, name, mic]] }, ref: { cols, table }, ucits, status }` — built on first use if nothing is kept, then by the cron (07:52 / 07:56 UTC, one source a run, when older than 6 days)
- `GET /api/etf/profile?isin=` → `{ isin, xetra, ref (justETF record + top10, countries, sectors, fetchedAt, sourceUrl), lines: [{ cnbc, ticker, venue, ccy, pence, price, changePct, asOf, status }] }`
- `GET /api/etf/compare?ids=ISIN,…|SYM&ccy=EUR` → `{ funds: [{ id, line, conv, stats: { returns, vol1Y, maxDrawdown }, weekly }] }` (≤ 4)
- `GET /api/etf/exposure?w=ISIN:weight,…` → `{ countries, sectors, holdings, coverage, funds }` · `GET /api/etf/resolve?syms=` → portfolio symbols → ISINs
- `GET /api/etf/ucits?ccy=EUR|USD|GBP|CHF` → `{ rows: [{ isin, sym, milan, name, group, line: { ticker, mic, venue, cnbc, id, ccy, pence }, own, conv: { from, to, rate, fxAsOf } | null, price, currency, change, changePct, asOf, status (LIVE / DERIVED when converted / STALE / N/A), ref: { ter, fundSize: { value, currency }, distribution, replication, domicile, fundCurrency, hedged, inception, holdings, legalStructure, fetchedAt, source: "justETF", sourceUrl, status } | null }], groups, parts, refCount, refError?, source, status }` — prices in two CNBC requests, cached 60 s; reference data read from KV only (never fetched when a page opens)
- `GET /api/etf/ucits/returns?part=0…4&ccy=…` → `{ returns: { [isin]: { ref: { "1W": [date, close], "1M", "3M", "YTD", "1Y" }, lastClose } }, errors }` — 16 funds a part, one CNBC daily-bars request each (cached 6 h)
- `GET /api/search?q=IT0000072618` (an ISIN) → `{ q, isin, name, count, results: [{ …, isin, figi, from? }], quotable, source: "OpenFIGI (ISIN → listings) · Twelve Data symbol_search", status }`; an unknown ISIN → `count: 0, note`; OpenFIGI over its limit → 429 `rate_limited`
- `GET /api/search?q=Roche` → `{ q, count, results: [{ id, symbol, name, exchange, mic, country, currency, type, planRequired, quotable }], plan, quotable, source, fetchedAt, status, truncated, credits }`
- `GET /api/quote?symbols=AAPL,MSFT` → `{ quotes: { AAPL: InstrumentData }, errors: { SYM: { error, status:"N/A" } }, meta }`
- `GET /api/history?symbol=AAPL&range=1D|5D|1W|1M|3M|6M|1Y|5Y|10Y|MAX[&interval=5min|15min|1h|1day|1week|1month][&adjust=splits|all|none]` → `History` (defaults: 1D 5-min, 5D 15-min, 5Y and 10Y weekly, MAX monthly; `lastBarPartial` also for the current week's / month's bar)
- `GET /api/sprd` → `{ series: { EA, US: { points: [{ date, y2, y10, bp }], source, status } }, basis }`
- `GET /api/yields` → `{ curves: { US, EA, DE, UK, JP, CH, CA }, errors, catalog, notConnected }`
- `GET /api/yields?ids=ES,BE,IT` (1–6 ids) → `{ curves: { ID: { …curve, freq, past: { 1W, 1M, 3M, 1Y }, spreads: { DE, US } } }, errors }` · `GET /api/yields/history?id=IT&tenor=10Y` → `{ points: [[date, value]], freq }` · `GET /api/yields/catalog`
- `GET /api/yields/market` → `{ countries: { IT: { points: [{ tenor, months, value, prev, changeBp, time, status, venue, maturity, coupon }], asOf, status } }, missing, regions, catalog, source }` · `GET /api/yields/market/past?ids=US,DE` (≤ 12, 10Y) or `?id=IT` (every maturity) → `{ past: { IT: { 1W: { date, points } } } }` · `GET /api/yields/market/history?id=IT&tenor=10Y` → `{ points: [[date, close]] }` (5 years)
- `GET /api/calendar` → `{ world: [{ id, datetime, dateET, timeET, currency, region, indicator, impact, released, actual, forecast, previous, source:"FF" }], events (BLS/BEA), sources, errors }`
- `GET /api/news?tickers=AAPL,MSFT` → `{ filings (SEC), sources, errors }`
- `GET /api/briefing?symbols=…[&refresh=1]` → `{ text, model, generatedAt, sources, verification, inputData }`

```
InstrumentData = { symbol, name, exchange, currency,
  status: "LIVE"|"STALE", source: "twelvedata",
  timestamp,   // market-data time reported by the provider
  fetchedAt,   // when the Worker fetched it
  staleAt,     // after this, display as STALE (10 min market open, 60 min closed)
  marketOpen, staleReason?,
  fields: { price, change, changePct, prevClose, open, high, low, volume,
            fiftyTwoWeekLow, fiftyTwoWeekHigh, marketCap, pe, eps, dividendYield,
            sharesOutstanding: { value, status, note? } } }

History = { symbol, range, interval, adjust, timeBasis, currency, exchange, exchangeTimezone, type,
  count, points: [{ t, o, h, l, c, v }], status, source, fetchedAt, staleAt, lastBarPartial,
  staleReason?, asOf, provider }
```
- `range`: `1D 1W 1M 3M 6M 1Y 5Y` · `interval`: `5min 15min 1h` (1D/1W only), `1day`, `1week`
- points are **oldest → newest**, deduplicated, only trading days (no interpolation)
- daily `t` = exchange-local trading date `YYYY-MM-DD`; intraday `t` = ISO UTC instant
- `adjust`: `splits` (default), `all` (splits + dividends), `none`
- errors: `400 bad_request|invalid_symbol`, `403 plan_required` (listed, not in the data plan), `404 symbol_not_found|no_data`, `429 rate_limited`,
  `502 provider_error|provider_auth|provider_unreachable`, `504 provider_timeout`, `500` secret missing

## Caching and provider usage
- Quotes: shared Worker cache per symbol (Cache API). Fresh for 60 s while the market is open,
  15 min when closed (`X-Cache: HIT|MISS|PARTIAL-HIT|STALE`). Concurrent requests for the same
  symbol share one provider call; one batched `/quote` call per refresh. Browsers get `no-store`.
- History: Worker cache 120 s intraday, 900 s daily, 3600 s weekly; served STALE (≤ 24 h) if the provider fails.
- Page: quotes for what is on screen every 10 min while the market is open, 30 min when closed,
  paused in hidden tabs; requests of ≤ 7 symbols, and a client-side budget never sends more than
  8 credits per minute. History: 1Y daily per symbol (once per session), 1D intraday on demand.
  Free plan budget: 8 credits/min, 800/day.
- Yields 30 min, calendar 6 h (Forex Factory 30 min), headlines 5 min (News window checks every 5 min while open; new ones marked NEW), SEC filings 30 min, briefing 60 min (Worker cache; STALE serving on failure).

## Not available (shown as N/A / NO DATA)
Real-time exchange data for most futures and indices (CNBC marks each quote real-time or delayed), the Milan line of most
UCITS ETFs (CNBC does not carry it: the fund is priced on its Xetra line, shown as such), primary listings in
Vienna, Copenhagen and Korea (CNBC does not carry them; their other listings are offered — N/A when outside the plan),
U.S. official calendar actuals without FRED. The model portfolio was removed. Fundamentals and
earnings came back only from approved sources (SEC EDGAR, Finnhub). `test/nomock.test.mjs` fails if mock or hard-coded
market data comes back.

## Optional secrets
- `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` — Alpaca market data (free plan) for the S&P 500 heat map. Without
  them the map shows the real constituents and weights only, every change N/A.
- `SEC_CONTACT` — contact for the SEC fair-access User-Agent, if SEC starts refusing requests.
- `FINNHUB_KEY` — Finnhub (free) for the earnings calendar (ERN); sent only in the `X-Finnhub-Token` header.
- `FRED_KEY` — FRED (free): the U.S. curve (instead of the Treasury XML, which times out from Cloudflare) and U.S. inflation / credit in BOND. FRED accepts the key only as a URL parameter: it travels only in the Worker's request to `api.stlouisfed.org`.
- `OPENFIGI_KEY` — optional (free at openfigi.com): raises OpenFIGI's limit from 25 to 250 ISIN searches a minute; sent
  only in the `X-OPENFIGI-APIKEY` header. Not needed.
- `TELEGRAM_BOT_TOKEN` — a Telegram bot (create it with @BotFather) that sends the alerts; the chat is linked from
  ALRT (FIND MY CHAT → LINK), or set `TELEGRAM_CHAT_ID`. The token goes only into the Worker's requests to
  `api.telegram.org`; it is never returned, logged or stored.
- `EIA_KEY` — U.S. EIA Open Data (free: register at https://www.eia.gov/opendata/register.php, the key arrives by email)
  for the EIA spot prices and the weekly inventories in CMDTY; EIA accepts the key only as a URL parameter, so it
  travels only in the Worker's request to `api.eia.gov` and is never logged or returned.

## Deploy
Connected to Cloudflare Workers Builds: every push to `main` redeploys.
Manual alternative: `npx wrangler deploy`.

## Test
```
node test/worker.test.mjs       # quote normalizer
node test/history.test.mjs      # history contract + Worker handler (mocked provider/cache)
node test/integrity.test.mjs    # T04: provenance, shared cache, coalescing, failures, timeout
node test/provenance.test.mjs   # T04: client status rules
node test/sources.test.mjs      # T05: yields, calendar, news, briefing (parsers + handlers)
node test/search.test.mjs       # T05: symbol search, ranking, SYMBOL:MIC quotes/history, plan errors
node test/spx.test.mjs          # T06: S&P 500 map data (holdings parser, Alpaca bars/trades, live phase)
node test/press.test.mjs        # T06: publishers' and central banks' RSS parsing and endpoint
node test/briefs.test.mjs       # T06: briefing editions, schedule, data lines, link/number checks, archive
node test/calendar-world.test.mjs # T06: world calendar (Forex Factory export normalizer and endpoint)
node test/i18n.test.mjs         # T06: interface translations (stable, data-safe)
node test/maps.test.mjs         # T06: Nasdaq-100 / Dow / ETF / crypto maps, xlsx reader, world exchanges, portfolio
node test/cron.test.mjs         # T06: scheduled briefings (plan per minute, CET/CEST, staging, write, hand-off)
node test/briefmkt.test.mjs     # markets in the briefings: indices, ECB fixing, energy, crypto, IMF (staged, period changes, windows)
node test/access.test.mjs       # T05: /api refused without a valid Cloudflare Access token (real RS256 tokens)
node test/bonds.test.mjs        # world curves (Bundesbank, BoE, MOF, SNB, BoC, FRED), BOND changes/spreads, CFTC COT, ETF list
node test/sw.test.mjs           # the iPhone app's service worker: interface only, never /api, sign-in redirects
node test/quant.test.mjs        # quant formulas against closed forms and known processes
node test/isin.test.mjs         # ISIN: check digit, exchange codes, OpenFIGI listings matched to Twelve Data
node test/etfperf.test.mjs      # screener returns / risk: 1Y–5Y, volatility, drawdown, the cron's batch, routes
node test/whatif.test.mjs       # WIF purchases, YAS bond math and OpenFIGI terms, projection with assumptions, saved what-ifs
node test/plab.test.mjs         # PLAB: saved portfolios, EUR series (FX, GBp, CHF, CNBC's U.S. fallback), backtest / IRR / stats / risk / stress / projection
node test/bondlab.test.mjs      # ECB list read in slices, bond terms (ECB / OpenFIGI), the estimate's plan, curve / FX endpoints, bondHistory
node test/rebalance.test.mjs    # WHAT TO BUY: water filling, sales, smallest trade, cost per trade, whole units, outside positions
node test/drift.test.mjs        # drift alert: matching by ISIN, EUR values, cash left out, weekly key, 18:40 run, message
node test/backup.test.mjs       # backups: quotes, history, CNBC bars, exchanges, calendar — labelled, keys never shown
node test/factors.test.mjs      # FACT: the French library's ZIP / CSV, KV copy (daily, STALE, 6 h), listings, month-ends in USD, route, betas recovered
node test/etf.test.mjs          # ETF section: Xetra / U.S. lists, justETF table and crawl, profile, compare, exposure, resolve
node test/ucits.test.mjs        # UCITS list, CNBC lines (and CNBC's U.S. fallback refused), returns, justETF parser and cron
node test/functions.test.mjs    # T07: central banks, spreads, EIA, earnings, SEC, options, alerts/notes/boards, status
node test/nomock.test.mjs       # no mock / hard-coded market data in shipped files or the Worker
node test/yields-world.test.mjs # more countries' yields: parsers, past curves, spreads, OECD monthly
node test/rates-world.test.mjs  # market yields (CNBC), central banks compared (BIS), meeting calendars
node test/markets-cnbc.test.mjs # CNBC futures / curves / implied open / indices, Nasdaq calendar / screener / movers, ApeWisdom
node test/alerts.test.mjs       # alerts engine: symbols, the four kinds, the 5-minute check, Telegram, token never returned
node test/intl.test.mjs         # listings outside the plan via CNBC (quote, history), FINRA short interest, Nasdaq analysts / holders
node test/frontend.e2e.mjs      # headless browser, mocked /api (needs playwright)
```
