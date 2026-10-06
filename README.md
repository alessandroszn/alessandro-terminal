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

`Quote = { symbol, name, price, prevClose, changePct, open, high, low, volume, currency,
fiftyTwoWeekLow, fiftyTwoWeekHigh, asOf, provider }`

## Status
- Live: quotes (price, change %, open/high/low, previous close, volume, 52-week range).
- Simulated: price history and charts (next step: `/api/history`), calendars, news, portfolio.

## Deploy
Connected to Cloudflare Workers Builds: every push to `main` redeploys.
Manual alternative: `npx wrangler deploy`.

## Test
```
node test/worker.test.mjs
```
