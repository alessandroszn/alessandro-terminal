# Alessandro Terminal

A multi-window market terminal served at **alessandrozanichelli.com/terminal**.

```
Browser ──► alessandrozanichelli.com/terminal   (static page: public/terminal/index.html + provenance.js)
        └─► alessandrozanichelli.com/api/*      (Cloudflare Worker, src/worker.mjs) ──► Twelve Data
```

The Twelve Data API key lives only in the Worker as the secret `TWELVEDATA_KEY`.
It is never in this repository, in the page, in a URL the browser sees, or in a response.

## Data integrity rules (T04)
- **Only real data.** The UI shows the instruments in `CONFIG.liveSymbols` (NVDA, AAPL, MSFT, AMZN,
  GOOGL, JPM), all served by the provider through `/api/*`. There are no simulated instruments,
  datasets, prices or estimates; the only static data is each symbol's GICS sector (heatmap grouping).
- Every number carries a status: **LIVE**, **PARTIAL**, **STALE**, **N/A** (from the API) and
  **DERIVED**, **LOADING** (assigned by the page). Rules: `public/terminal/provenance.js`.
- No silent fallback: if the provider fails, a symbol shows its last real quote marked **STALE**
  (Worker cache, up to 24 h) or **N/A** — never an invented value.
- Fundamentals (market cap, P/E, EPS, dividend yield, shares outstanding, short interest) have no
  source on the current plan: **N/A**. Nothing is estimated.
- Volume, open, high and low are **PARTIAL**: Twelve Data real-time US equities come from venues
  covering ~5% of US consolidated volume. Prices, previous close and 52-week range match consolidated
  values; historical daily bars are consolidated.
- Each window shows a provenance pill; the status bar badge summarises what is on screen
  (e.g. `LIVE · 6 LIVE`, or `STALE · 5 LIVE · 1 STALE`), with a per-instrument list in its tooltip.

## Endpoints
- `GET /api/health` → `{ ok, ts }`
- `GET /api/quote?symbols=AAPL,MSFT` → `{ quotes: { AAPL: InstrumentData }, errors: { SYM: { error, status:"N/A" } }, meta }`
- `GET /api/history?symbol=AAPL&range=6M[&interval=1day|1d][&adjust=splits]` → `History`

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
- errors: `400 bad_request|invalid_symbol`, `404 symbol_not_found|no_data`, `429 rate_limited`,
  `502 provider_error|provider_auth|provider_unreachable`, `504 provider_timeout`, `500` secret missing

## Caching and provider usage
- Quotes: shared Worker cache per symbol (Cache API). Fresh for 60 s while the market is open,
  15 min when closed (`X-Cache: HIT|MISS|PARTIAL-HIT|STALE`). Concurrent requests for the same
  symbol share one provider call; one batched `/quote` call per refresh. Browsers get `no-store`.
- History: Worker cache 120 s intraday, 900 s daily, 3600 s weekly; served STALE (≤ 24 h) if the provider fails.
- Page: quotes every 5 min while the market is open, 30 min when closed, paused in hidden tabs.
  History: 1Y daily per live symbol (once per session), 1D intraday on demand (refetched after 10 min).
  Free plan budget: 8 credits/min, 800/day.

## Removed because no real source is connected (T04)
World indices, yield curve, economic calendar, news, earnings, model portfolio, currency conversion
(fixed FX rates), company descriptions, short interest, market cap / P/E, and the 12 instruments that
had no live quotes. `test/nomock.test.mjs` fails if any of them comes back.

## Deploy
Connected to Cloudflare Workers Builds: every push to `main` redeploys.
Manual alternative: `npx wrangler deploy`.

## Test
```
node test/worker.test.mjs       # quote normalizer
node test/history.test.mjs      # history contract + Worker handler (mocked provider/cache)
node test/integrity.test.mjs    # T04: provenance, shared cache, coalescing, failures, timeout
node test/provenance.test.mjs   # T04: client status rules
node test/nomock.test.mjs       # T04: no mock / simulated data in the shipped files
node test/frontend.e2e.mjs      # headless browser, mocked /api (needs playwright)
```
