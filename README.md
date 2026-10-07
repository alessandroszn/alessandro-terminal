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
| Symbol search (SRCH) | Twelve Data `/symbol_search` via `/api/search` | name or ticker, every exchange the provider lists; metadata only (no prices) |
| Watchlist (editable, max 12) | Twelve Data `/quote` via `/api/quote` | US equities (venue subset: volume/OHL PARTIAL), FX, crypto, gold; any searched listing the plan covers |
| Heat maps (MAP) | S&P 500: iShares IVV holdings · Nasdaq-100: Invesco QQQ holdings (Invesco API) · Dow 30: SPDR DIA holdings (.xlsx) · Sectors: 11 SPDR sector ETFs · Countries: ~38 single-country ETFs in New York · Crypto: Alpaca crypto (USD pairs) — prices Alpaca; FX: 9×9 matrix from live Twelve Data quotes vs USD | colour = 1D/1W/1M/3M/6M/YTD/1Y change (DERIVED; FX 1D only); size = index weight (ETF holdings) or traded value (close × volume) or equal; ETF maps show ETF prices, not index levels; crypto days in UTC, closes = completed days |
| World exchanges (EXCH) | Twelve Data `/market_state` (all plans, 1 credit for all exchanges) | open/closed now incl. holidays and early closes, local time, time to open/close, session in your time; status bar `MKTS n/24 open`; cached until the next open/close of a major market (≤ 30 min) |
| Portfolio (PF) | your transactions (Workers KV, private behind Access) · live quotes (Twelve Data) · ECB euro reference rates (trade-date cost in EUR) | starts empty; BUY/SELL with date, qty, price, fees; average-cost positions; value and P&L in EUR (live EUR/currency rate, DERIVED); realised P&L; no risk / attribution / quant analytics yet |
| Markets | Twelve Data | FX, crypto, XAU; indices and commodities N/A on the current plan |
| Indices | — | **NO DATA**: no licensed index source (Basic has none; vendors license even delayed values) |
| Yields (YLD, CURVE) | Official daily sources, no key: U.S. FRED (H.15) or Treasury XML · euro area ECB · Germany Bundesbank · UK Bank of England · Japan Ministry of Finance (current month + history file) · Switzerland SNB · Canada Bank of Canada · Spain Banco de España (BIEST API) · Belgium National Bank of Belgium (NBB.Stat SDMX CSV) · Portugal Banco de Portugal (BPstat JSON-stat; market data LSEG) · Austria OeNB (average yield of all federal bonds, released weekly) · Sweden Riksbank (SWEA) · Norway Norges Bank (SDMX CSV) · Australia RBA table F2 (released weekly) · New Zealand RBNZ table B2 (xlsx, read in the Worker) · China ChinaBond government curve · Malaysia Bank Negara Malaysia (latest day) · South Africa SARB (bonds R2030 and R209) · Peru BCRP (10Y). Monthly 10-year average (OECD via FRED, labelled M): France, Italy, Netherlands, Ireland, Greece, Finland, Denmark, Poland, Czech Republic, Hungary, Slovakia, Slovenia, Luxembourg, South Korea, Israel, Mexico, Chile | WORLD table by region: 2Y/5Y/10Y/30Y, Δ10Y 1D/1W/1M, 2s10s, 10Y spread vs the Bund and vs the U.S. (same day; monthly series vs the same month's German / U.S. average) — DERIVED; sort by region, 10Y, biggest move, spread. Country view: curve on a true maturity axis vs the previous publication and 1W / 1M / 3M / 1Y earlier (the last publication on or before), Δ by maturity, 10Y (or the only series) history. CURVE: up to 6 countries on one chart, or one country at several dates. Not connected (no free official source, or no answer to the Worker): Brazil, Turkey, India, Indonesia, Singapore, Taiwan, Thailand, Philippines, Colombia, Saudi Arabia, Hong Kong |
| World government bonds (BOND) | the curves above + FRED | 2Y/5Y/10Y/20Y/30Y by country, change over 1 publication / ~1 week / ~1 month (bp, DERIVED, heat-coloured), 10Y spread vs the Bund only on the same date (DERIVED); U.S. TIPS real yields, breakevens, IG / HY yields and spreads (ICE BofA), SOFR, 30-year mortgage (FRED). Italy, France, Spain, China, Australia N/A (no free official daily source connected) |
| Futures positioning (COT) | CFTC Commitments of Traders (legacy, futures only; public Socrata API) | 39 major contracts (equity indices, Treasuries, SOFR, energy, metals, currencies, crypto, agriculture): open interest, speculators long / short / net, Δ 1W / 4W, net % OI, place in the 26-week range, 13-week line, commercials net — all derived from the weekly reports; positions as of Tuesday, published Friday. Futures prices stay N/A (licensed) |
| ETFs by asset class (ETF) | Alpaca prices; fixed list chosen with TradingView's largest / most traded as a reference | 56 ETFs: US equity, factors, Treasuries, credit and aggregate, commodities, real estate, international, currencies, volatility, crypto; 1D…1Y change, traded value; also a MAP universe. ETF prices, never shown as the price of what they hold |
| Calendar | WORLD: Forex Factory weekly export (`nfs.faireconomy.media/ff_calendar_thisweek.json`), archived weekly in KV; market reaction from 1-minute prices (Twelve Data FX, Alpaca SPY/TLT); US OFFICIAL: BLS + BEA ICS schedules | WORLD (default): this week + the last 4 days (archive); filters by impact (HIGH / HIGH + MEDIUM / ALL) and currency (USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, CNY), remembered in the browser; forecast/previous as published, actual N/A (not in the export); REACTION 15M for released high-impact events (price just before vs +15 / +60 min, DERIVED; ≤ 3 new per request, 1 Twelve Data credit each, then kept); click an event for details and past releases (archive since 7 Oct 2026); countdown for the next 24 h; NEXT HIGH-IMPACT banner + status-bar countdown. US OFFICIAL: actual/previous N/A until a FRED key is configured. The briefing uses the high-impact world events. |
| News | Top publishers' own public RSS feeds: Financial Times, Bloomberg, The Wall Street Journal, MarketWatch; official releases of the Federal Reserve (press + speeches), ECB and Bank of England; SEC EDGAR filings for the watchlist | headline, section, time, link only — never article text; tabs ALL (publishers + central banks) / FT / BLOOMBERG / WSJ / MARKETWATCH / CENTRAL BANKS / SEC FILINGS. No wire or aggregator (the GDELT feed was removed: it indexed any site). |
| Equities (EQ) | the heat-map lists and prices (IVV / QQQ / DIA holdings; Alpaca) | S&P 500, Nasdaq-100 or Dow 30 members as a board: weight, last, 1D…1Y change, base date; sector filter, text filter, sort; breadth and equal / index-weighted change (DERIVED) |
| Currencies (FX) | Twelve Data `/quote` (8 pairs vs USD) | last, change, open/high/low, previous, 52-week range; average USD move vs the 8 (DERIVED — not the licensed ICE DXY); crosses in FXM (the FX matrix) |
| Crypto (CRYPTO) | Alpaca crypto (USD pairs) | last trade, 1D…1Y change (completed UTC days), traded value of the last completed day |
| Commodities (CMDTY) | U.S. EIA Open Data v2 (`EIA_KEY`) · Twelve Data (gold) | WTI, Brent, gasoline, heating oil, diesel, jet fuel, propane, Henry Hub gas: daily spot with its price date (EIA publishes ~a week behind), changes over 1/5/21 published days (DERIVED), 3-month trend; gold live; silver, copper, agriculture **N/A** (exchange-licensed) |
| Futures (FUT) | — | **NO DATA**: exchange-licensed (CME, ICE, Eurex); FCRV shows the EIA settlement curves instead |
| Futures curves (FCRV) | EIA (NYMEX settlements, contracts 1–4) | WTI and natural gas: latest, a week and a month before; M4/M1 contango/backwardation (DERIVED); dated, not real-time |
| My boards (BOARD) | your lists (Workers KV) · Twelve Data quotes | named boards of up to 12 symbols, each checked with a real quote before it is added |
| Reddit (RDT) | — | **N/A**: the proposed source (ApeWisdom) was not approved |
| Spreads (SPRD) | ECB Data Portal (YC, AAA spot 2Y / 10Y, ~1 year daily) · FRED (Federal Reserve H.15, DGS2 / DGS10, ~1 year daily; `FRED_KEY`) | euro-area and U.S. 2s10s histories on one interactive chart, with Δ 1W/1M/3M and range (DERIVED, only on days both maturities were published); without `FRED_KEY` the U.S. shows the latest curve publication only |
| Central banks (CB) | ECB Data Portal (DFR, MRO, MLF) · New York Fed markets API (EFFR + FOMC target range) · Bank of England IADB (Bank Rate) · SNB data portal (policy rate) · Bank of Canada Valet (overnight target) · Forex Factory (next decision) | each rate with its date, the level before the last change and the date of that change; BoJ, RBA, RBNZ rates **N/A** (no approved machine-readable source); next decision only when it is in the current week |
| Earnings (ERN) | Finnhub earnings calendar (`FINNHUB_KEY`) · Alpaca daily closes | S&P 500 + Nasdaq-100 companies (our index lists), 4 days back / 12 ahead, the 60 largest by index weight or all; time (before open / after close), quarter, EPS and revenue estimate and actual, surprise (DERIVED), price reaction of the first session after the report (DERIVED) |
| Company (DES) | SEC EDGAR (submissions, XBRL companyconcept) · Twelve Data price | profile (industry SIC, exchange, fiscal year end, address, filings); revenue, net income, diluted EPS, assets, equity (last fiscal year, the year before, latest quarter, as filed), shares from the latest cover page; market cap, P/E (last fiscal year EPS), net margin, P/B, equity/assets DERIVED; multi-class share counts → market cap N/A |
| Options (OMON) | Alpaca options (contracts + snapshots, free **indicative** feed) | expirations, chain ±15% around the spot: OI, IV, delta, last (15-min delayed), bid/ask (**indicative**, not exchange quotes → PARTIAL); ATM IV and put/call OI (DERIVED) |
| Workspace (WS) | — | `WS AAPL` opens chart, DES, OMON and news for a ticker, tiled |
| Ratio (CROSS) | Twelve Data daily history (1Y / 5Y) | A / B ratio on common dates, Δ 1M…5Y, correlation of daily returns (all DERIVED) |
| Backtest (BT) | Twelve Data daily history, split- and dividend-adjusted (1Y / 5Y) | buy & hold or SMA crossover (long / flat); signal at a close, executed at the next close; costs only as set; total return, CAGR, volatility, Sharpe (risk-free 0), max drawdown, trades, time in market, vs buy & hold (all DERIVED) |
| Alerts (ALRT) · Notes (NOTE) | your lists (Workers KV) · Twelve Data quotes | price alerts ≥ / ≤ checked in the page on each live quote (only LIVE quotes fire; price and time recorded; toast + desktop notification if allowed; ≤ 10 symbols); notes, optionally tied to a symbol |
| System (SYS) | `/api/status` | which sources are configured (yes/no only — never key values), Twelve Data credits (checked on request: 1 credit, reused 5 min), last scheduled run, this page's budget |
| Briefing | Cloudflare Workers AI (Llama 3.3 70B), archive in Workers KV | editions in the reference format: Daily (weekdays from 07:30 Rome: In one line · Equities · Rates and currencies · Commodities and crypto · Today), Evening (from 22:30: In one line · How the day went · What changed since this morning · Tomorrow), Weekly (Saturday), Monthly (first Saturday). Written once from real data only (S&P 500 constituents, FX/crypto/gold, curves, calendar, FT, Bloomberg, WSJ, MarketWatch and central-bank headlines with links); tickers become chips; windows that explain each section (chosen from the edition's own data: heat map, leading sector, contributors compared, biggest mover, curves vs previous publication, euro-area 2s10s, largest FX move, gold, crypto board, the next high-impact release opened in the calendar, central banks on a rate-decision day) appear under their section with a one-line reason built from the same figures; ▦ Open all as a view lays out the briefing on the left and its windows on the right, ↩ MY LAYOUT brings the previous windows back; every figure checked, links outside the data removed. An edition is written only inside its window, never later with newer data. Written automatically at its time (see Scheduled briefings). |

## Function menu (T07)
`☰ FUNCTIONS` in the taskbar or launcher, `MENU` in the command line, or the `m` key: every function by
category with its code — MARKETS (IDX EQ FX CMDTY CRYPTO FUT BOARD WL HEAT MOV SCR RDT MKT EXCH BRIEF NEWS),
RATES & MACRO (YLD CURVE SPRD CB CAL ERN FXM FCRV), ANALYSIS (DES OMON WS COMP PERF CROSS CORR BT),
MY STUFF (PORT ALRT NOTE SYS), LAYOUT (SET CLOSE UNDO TILE TOUR HELP). Type to filter, Enter to open; functions
without an approved source are marked N/A. A ticker goes with a function in either order (`DES AAPL`,
`AAPL OMON`, `WS MSFT`, `BT NVDA`, `CROSS NVDA AAPL`). `TOUR` walks through the interface.

## Scheduled briefings (Cron Trigger)
Editions are written at their time whether or not the terminal is open: Daily 07:30 and Evening 22:30
(Mon–Fri), Weekly 08:00 (Saturday), Monthly 08:00 (first Saturday), Rome time (CET/CEST handled by the
time zone). `src/cron.mjs`, triggers in `wrangler.toml` (`* 5-7 * * *`, `* 20-21 * * *`, UTC).
- Free plan = 10 ms CPU per run, so **one run does one thing**: from ~15 minutes before the slot, each
  minute fetches one source with the same loaders the terminal uses (IVV universe, yields, the German, UK and Japanese curves (one each), world calendar,
  FT, Bloomberg, WSJ, MarketWatch, central banks, Alpaca closes, Twelve Data FX; weekly/monthly also the
  1W/1M references and FX daily series), plus two retry minutes for anything that failed.
- Inputs are staged in Workers KV (`stage/…`, ≤ 3 days), not in the per-location cache: scheduled runs
  execute in any Cloudflare location.
- At the slot the edition is written **from staged data only** (no source is called), retried at +5 and
  +10 minutes if the write failed. Evening: today's consolidated closes are read at 22:30 (16:30 ET, session
  final) and the edition is written at 22:33. Monthly is written at 08:02, after the weekly.
- The terminal does not write an edition while the scheduled run is due (`409 scheduled_write`); it shows
  it as SCHEDULED and writes it itself only if it is still missing ~12 minutes after its time. REWRITE still
  works. Each edition records `writtenBy: schedule | terminal`; `/api/briefs` reports the last scheduled run.
- Usage: ~300 runs/day, ~70 KV writes/day (free: 100k requests, 1,000 KV writes), 6 Twelve Data credits per edition.

## Languages (EN / IT)
- Toggle in the top bar, remembered in the browser (Italian by default for an Italian browser).
- `public/terminal/i18n.js` renders the terminal's own words (labels, messages, notes) in Italian as they are drawn; data is never translated (headlines, company and event names, tickers; `.notranslate`). Each text node is translated once; phrases never match inside longer words.
- Briefings are written by the model in English and Italian from the same DATA (same number check, decimal point kept); editions without the Italian version can get it on request from their own stored data (`POST /api/briefs/lang?id=…&lang=it`).

## Symbol discovery (T05)
search → select → fetch. Nothing is preloaded and no ticker list is maintained by hand.
1. **Discovery**: `/api/search?q=Novartis` asks the provider's symbol master (name or ticker, all
   exchanges it lists) and returns listings with exchange, MIC, country, currency, type and the data
   plan each one needs. Provider call without a key (no credit); cached 24 h per query.
2. **Quote on demand**: OPEN fetches one quote; listings outside the current plan are shown as N/A at
   once (no call spent). +WL validates with a real quote before adding.
3. **History on demand**: requested only when a security window is open.
4. **Watchlist refresh**: only watchlisted / on-screen ids, in ≤ 7-symbol requests within the credit budget.

Instrument ids: plain ticker for US listings, FX, metals and crypto (`AAPL`, `EUR/USD`);
`SYMBOL:MIC` for every other venue (`NOVN:XSWX`, `HSBA:XLON`) → sent as `symbol` + `mic_code`.
Prices are shown in the listing's own currency (`$` only for USD); nothing is converted.
Limits: the provider returns at most 120 listings per query (a broad name can be crowded out by
warrants: search the ticker); indices are not in the provider's search.

## Endpoints
- `GET /api/health` → `{ ok, ts }`
- `GET /api/yields` → `{ curves: { US, EA, DE, UK, JP, CH, CA }, errors, notConnected }` · `GET /api/bonds` → `{ countries: [{ id, tenors: { "10Y": { value, d1, w1, m1, note? } }, date, source, status }], spreads, fred: { groups } }`
- `GET /api/cot` → `{ contracts: [{ code, name, group, root, date, oi, long, short, net, chg1w, chg4w, netPctOi, range, history, commNet }] }`
- `GET /api/cb` → `{ banks: [{ id, name, ccy, page, label, rate: { date, value, previous, changedOn | unchangedSince }, target?, others?, status }] }`
- `GET /api/sprd` → `{ series: { EA: { points: [{ date, y2, y10, bp }], source, status }, US: { status: "N/A" } } }`
- `GET /api/energy` → `{ spot: [{ series, name, unit, date, value, chg1, chg5, chg21, history }], curves: [{ id, name, unit, dates, latest, week, month }] }` (503 `eia_not_configured` without `EIA_KEY`)
- `GET /api/earnings?back=4&fwd=12` → `{ rows: [{ sym, name, weight, index, date, hour, quarter, epsEstimate, epsActual, revenueEstimate, revenueActual }] }` · `/api/earnings/reactions` → `{ reactions: { "SYM|date": { session, chg } } }` (503 without `FINNHUB_KEY`)
- `GET /api/des?symbol=AAPL` → `{ profile, facts }` · `/api/des/fact?symbol=AAPL&c=revenue|netIncome|eps|assets|equity|shares` → `{ annual, prevAnnual, quarter, latest, latestMulti, concept }`
- `GET /api/options/expirations?symbol=AAPL` · `/api/options/chain?symbol=AAPL&exp=YYYY-MM-DD` → `{ spot, rows: [{ strike, call, put }], feed }`
- `GET|POST|DELETE /api/user/alerts` (+ `POST /api/user/alerts/hit?id=`) · `GET|POST|PUT|DELETE /api/user/notes` · `GET|PUT /api/user/board` — same-origin JSON writes only
- `GET /api/status[?usage=1]` → `{ sources: [{ id, name, use, configured }], twelvedata, credits, scheduler }`
- `GET /api/spx/universe[?u=NDX|DJI|SECT|CTRY|CRYPTO]` (also for `/closes` and `/live`; default S&P 500) → `{ holdingsAsOf, count, items: [{ sym, name, sector, weight }], source, fetchedAt, status }`
- `GET /api/spx/closes?ref=recent|1W|1M|3M|6M|YTD|1Y` → `{ ref, target, todayET, todayBarFinal, closes: { SYM: [date, close] | [[date, close]…] } }`
- `GET /api/spx/live` → `{ trades: { SYM: [price, time] }, live, medianTradeAgeSec }` (cache 60 s)
- `GET /api/calendar/history?ccy=USD&title=CPI m/m` → `{ releases: [{ datetime, forecast, previous }] }` · `GET /api/calendar/reactions` → `{ reactions: { <eventId>: { items: [{ symbol, pair, before, m15, m60, source }], final } }, pending }`
- `GET /api/exchanges` → `{ exchanges: [{ code, name, open, openedAt, closesAt, opensAt, major, label, city, tz, region }], majorOpen, majorCount, missingMajor, fetchedAt, status }`
- `GET /api/portfolio` · `POST /api/portfolio/tx` (JSON: date, side, sym, qty, price, ccy, fees, note) · `DELETE /api/portfolio/tx?id=` → `{ transactions, positions, realized, costBasis }`
- `GET /api/headlines?source=FT|BLOOMBERG|WSJ|MARKETWATCH|CB` → `{ items: [{ title, url, timestamp, section }], feeds, status }`
- `GET /api/briefs?period=daily|evening|weekly|monthly` → `{ due: { id, d, writable }, dueWritten, briefs: [{ id, d, title }], schedule }`
- `GET /api/briefs/item?id=daily-2026-10-07` · `POST /api/briefs/write?period=daily&symbols=…`
- `GET /api/search?q=Roche` → `{ q, count, results: [{ id, symbol, name, exchange, mic, country, currency, type, planRequired, quotable }], plan, quotable, source, fetchedAt, status, truncated, credits }`
- `GET /api/quote?symbols=AAPL,MSFT` → `{ quotes: { AAPL: InstrumentData }, errors: { SYM: { error, status:"N/A" } }, meta }`
- `GET /api/history?symbol=AAPL&range=1D|5D|1W|1M|3M|6M|1Y|5Y|10Y|MAX[&interval=5min|15min|1h|1day|1week|1month][&adjust=splits|all|none]` → `History` (defaults: 1D 5-min, 5D 15-min, 5Y and 10Y weekly, MAX monthly; `lastBarPartial` also for the current week's / month's bar)
- `GET /api/sprd` → `{ series: { EA, US: { points: [{ date, y2, y10, bp }], source, status } }, basis }`
- `GET /api/yields` → `{ curves: { US, EA, DE, UK, JP, CH, CA }, errors, catalog, notConnected }`
- `GET /api/yields?ids=ES,BE,IT` (1–6 ids) → `{ curves: { ID: { …curve, freq, past: { 1W, 1M, 3M, 1Y }, spreads: { DE, US } } }, errors }` · `GET /api/yields/history?id=IT&tenor=10Y` → `{ points: [[date, value]], freq }` · `GET /api/yields/catalog`
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
Index levels, futures quotes, real-time commodity prices (EIA energy is daily and lagged; metals other than gold,
agriculture), Reddit sentiment, calendar actual values and weeks after the current one, U.S. spread history (FRED),
policy rates of the BoJ, RBA and RBNZ, yields for countries other than the US and the euro area. The model portfolio
and FX conversion were removed. Fundamentals and earnings came back only from approved sources (SEC EDGAR, Finnhub).
`test/nomock.test.mjs` fails if mock or hard-coded market data comes back.

## Optional secrets
- `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` — Alpaca market data (free plan) for the S&P 500 heat map. Without
  them the map shows the real constituents and weights only, every change N/A.
- `SEC_CONTACT` — contact for the SEC fair-access User-Agent, if SEC starts refusing requests.
- `FINNHUB_KEY` — Finnhub (free) for the earnings calendar (ERN); sent only in the `X-Finnhub-Token` header.
- `FRED_KEY` — FRED (free): the U.S. curve (instead of the Treasury XML, which times out from Cloudflare) and U.S. inflation / credit in BOND. FRED accepts the key only as a URL parameter: it travels only in the Worker's request to `api.stlouisfed.org`.
- `EIA_KEY` — U.S. EIA Open Data (free) for CMDTY and FCRV; EIA accepts the key only as a URL parameter, so it
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
node test/access.test.mjs       # T05: /api refused without a valid Cloudflare Access token (real RS256 tokens)
node test/bonds.test.mjs        # world curves (Bundesbank, BoE, MOF, SNB, BoC, FRED), BOND changes/spreads, CFTC COT, ETF list
node test/functions.test.mjs    # T07: central banks, spreads, EIA, earnings, SEC, options, alerts/notes/boards, status
node test/nomock.test.mjs       # no mock / hard-coded market data in shipped files or the Worker
node test/yields-world.test.mjs # more countries' yields: parsers, past curves, spreads, OECD monthly
node test/frontend.e2e.mjs      # headless browser, mocked /api (needs playwright)
```
