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
| Symbol search (SRCH) | Twelve Data `/symbol_search` via `/api/search` | name or ticker, every exchange the provider lists; metadata only (no prices) |
| Watchlist (editable, max 12) | Twelve Data `/quote` via `/api/quote` | US equities (venue subset: volume/OHL PARTIAL), FX, crypto, gold; any searched listing the plan covers |
| Markets | Twelve Data | FX, crypto, XAU; indices and commodities N/A on the current plan |
| Indices | — | **NO DATA**: no licensed index source (Basic has none; vendors license even delayed values) |
| Yields | U.S. Treasury XML (CC0), ECB Data Portal | par curve 1M–30Y; euro-area AAA spot curve; Δ bp and 2s10s DERIVED |
| Calendar | BLS + BEA ICS schedules | actual/previous N/A until a FRED key is configured; forecast/importance N/A |
| News | GDELT DOC 2.0, SEC EDGAR | headline, source, time, link only |
| Briefing | Cloudflare Workers AI (Llama 3.3 70B) | summary of the real inputs above, sources listed, every figure checked |

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
- `GET /api/search?q=Roche` → `{ q, count, results: [{ id, symbol, name, exchange, mic, country, currency, type, planRequired, quotable }], plan, quotable, source, fetchedAt, status, truncated, credits }`
- `GET /api/quote?symbols=AAPL,MSFT` → `{ quotes: { AAPL: InstrumentData }, errors: { SYM: { error, status:"N/A" } }, meta }`
- `GET /api/history?symbol=AAPL&range=6M[&interval=1day|1d][&adjust=splits]` → `History`
- `GET /api/yields` → `{ curves: { US, EA }, errors, notConnected }`
- `GET /api/calendar` → `{ events, sources, errors }`
- `GET /api/news?tickers=AAPL,MSFT` → `{ items (GDELT), filings (SEC), sources, errors }`
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
- Yields 30 min, calendar 6 h, news 10 min, briefing 60 min (Worker cache; STALE serving on failure).

## Not available (shown as N/A / NO DATA)
Index levels, commodities (WTI, Brent), consensus forecasts and importance, fundamentals, yields for
countries other than the US and the euro area. Earnings, model portfolio, FX conversion and company
descriptions were removed. `test/nomock.test.mjs` fails if mock or hard-coded market data comes back.

## Optional secrets
- `FRED_KEY` — enables actual/previous values in the calendar (not configured yet).
- `SEC_CONTACT` — contact for the SEC fair-access User-Agent, if SEC starts refusing requests.

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
node test/access.test.mjs       # T05: /api refused without a valid Cloudflare Access token (real RS256 tokens)
node test/nomock.test.mjs       # no mock / hard-coded market data in shipped files or the Worker
node test/frontend.e2e.mjs      # headless browser, mocked /api (needs playwright)
```
