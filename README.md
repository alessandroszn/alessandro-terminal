# Alessandro Terminal

A multi-window market terminal served at **alessandrozanichelli.com/terminal**.

```
Browser ──► alessandrozanichelli.com/terminal   (static page, public/terminal/index.html)
        └─► alessandrozanichelli.com/api/quote  (Cloudflare Worker, src/worker.mjs) ──► Twelve Data
```

The Twelve Data API key lives only in the Worker as the secret `TWELVEDATA_KEY`.
It is never in this repository or in the page.

## Endpoints
- `GET /api/health` → `{ ok, ts }`
- `GET /api/quote?symbols=AAPL,MSFT` → `{ quotes: { AAPL: Quote }, asOf, provider, stale }`
- `GET /api/history?symbol=AAPL&range=6M[&interval=1day][&adjust=splits]` → `History`

`Quote = { symbol, name, price, prevClose, changePct, open, high, low, volume, currency,
fiftyTwoWeekLow, fiftyTwoWeekHigh, asOf, provider }`

`History = { symbol, range, interval, adjust, timeBasis, currency, exchange, exchangeTimezone,
type, count, points: [{ t, o, h, l, c, v }], asOf, provider }`

- `range`: `1D 1W 1M 3M 6M 1Y 5Y` · `interval`: `5min 15min 1h` (1D/1W only), `1day`, `1week`
- points are **oldest → newest**, deduplicated, only trading days (no interpolation)
- daily `t` = exchange-local trading date `YYYY-MM-DD`; intraday `t` = ISO UTC instant
- `adjust`: `splits` (default, chart prices), `all` (splits + dividends, for returns), `none`
- errors: `400 bad_request`, `404 symbol_not_found|no_data`, `429 rate_limited`,
  `502 provider_error|provider_auth|provider_unreachable`, `504 provider_timeout`, `500` secret missing
- caching: Worker Cache API, `X-Cache: HIT|MISS`; TTL 120 s intraday, 900 s daily, 3600 s weekly

## Status
- Live: quotes and price history for the configured live symbols.
- Simulated: the other symbols, fundamentals (market cap, P/E), calendars, news, portfolio.

## Deploy
Connected to Cloudflare Workers Builds: every push to `main` redeploys.
Manual alternative: `npx wrangler deploy`.

## Test
```
node test/worker.test.mjs     # quote normalizer
node test/history.test.mjs    # history contract + Worker handler (mocked provider/cache)
node test/frontend.e2e.mjs    # headless browser, mocked /api (needs playwright)
```
