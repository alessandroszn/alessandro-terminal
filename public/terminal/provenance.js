/* Alessandro Terminal — data provenance rules (T04).
   Pure functions, no DOM: loaded by the page (window.Provenance) and by the Node tests.

   Policy: the terminal shows ONLY real data. There is no status for invented values: a value
   without a real source is N/A (or the field is removed). Status vocabulary shown next to a number:
     LIVE     real, from the provider, inside its freshness window
     PARTIAL  real but incomplete (e.g. volume from a venue subset)
     STALE    real but old: the provider failed or the value is past `staleAt`
     DERIVED  computed by the terminal from real inputs (e.g. a correlation, breadth)
     N/A      no real value available: nothing is estimated or invented
     LOADING  real data requested, not arrived yet                                          */
(function (root) {
  "use strict";
  var S = Object.freeze({ LIVE: "LIVE", PARTIAL: "PARTIAL", STALE: "STALE", NA: "N/A", DERIVED: "DERIVED", LOADING: "LOADING" });
  var REAL = [S.LIVE, S.PARTIAL, S.STALE, S.DERIVED];
  var MAX_AGE_MS = 24 * 3600 * 1000; // older than this, a real value is not shown at all

  function ms(x) { var v = Date.parse(x); return isFinite(v) ? v : null; }
  function isReal(s) { return REAL.indexOf(s) >= 0; }

  /* One instrument. q = InstrumentData from /api/quote, or null. o = { now, error } */
  function instrumentStatus(q, o) {
    o = o || {};
    var now = o.now != null ? o.now : Date.now();
    if (!q) return o.error ? S.NA : S.LOADING;
    var fetched = ms(q.fetchedAt);
    if (fetched == null || now - fetched > MAX_AGE_MS) return S.NA;
    if (q.status === S.STALE) return S.STALE;
    var staleAt = ms(q.staleAt);
    if (staleAt != null && now > staleAt) return S.STALE;
    return S.LIVE;
  }

  /* One displayed field of an instrument (price, volume, marketCap…). */
  function fieldStatus(q, key, inst) {
    if (inst === S.LOADING || inst === S.NA) return inst;
    var f = q && q.fields && q.fields[key];
    if (!f || f.value == null || f.status === S.NA) return S.NA;
    if (inst === S.STALE) return S.STALE;
    return f.status === S.PARTIAL ? S.PARTIAL : S.LIVE;
  }

  /* Field value — null unless the field is real and present. Never a fallback. */
  function fieldValue(q, key) {
    var f = q && q.fields && q.fields[key];
    return f && f.value != null && f.status !== S.NA ? f.value : null;
  }

  /* Price history (from /api/history). meta = the response envelope, or null. o = { now, error } */
  function historyStatus(meta, o) {
    o = o || {};
    if (!meta) return o.error ? S.NA : S.LOADING;
    var now = o.now != null ? o.now : Date.now();
    if (meta.status === S.STALE) return S.STALE;
    var staleAt = ms(meta.staleAt);
    if (staleAt != null && now > staleAt) return S.STALE;
    return S.LIVE;
  }

  /* A value the terminal computes from other (real) values. */
  function derivedStatus(inputs) {
    if (!inputs || !inputs.length) return S.NA;
    if (inputs.indexOf(S.NA) >= 0) return S.NA;
    if (inputs.indexOf(S.LOADING) >= 0) return S.LOADING;
    if (inputs.indexOf(S.STALE) >= 0) return S.STALE;
    return S.DERIVED;
  }

  /* Label for a view (window) or the whole screen, from the statuses of what it shows.
     A view whose items differ (e.g. 5 LIVE + 1 STALE) is labelled by its worst real state
     and the text counts each state, so the mix is always visible. */
  function summarize(statuses) {
    statuses = (statuses || []).filter(Boolean);
    var c = {};
    statuses.forEach(function (s) { c[s] = (c[s] || 0) + 1; });
    var real = statuses.filter(isReal).length;
    var label;
    if (!statuses.length) label = null;
    else if (real) label = c[S.STALE] ? S.STALE : (c[S.LIVE] || c[S.PARTIAL]) ? S.LIVE : S.DERIVED;
    else if (c[S.LOADING]) label = S.LOADING;
    else label = S.NA;
    return { label: label, counts: c, text: describe(label, c) };
  }
  function describe(label, c) {
    if (!label) return "";
    var parts = [], live = (c[S.LIVE] || 0) + (c[S.PARTIAL] || 0);
    if (live) parts.push(live + " LIVE");
    if (c[S.DERIVED]) parts.push(c[S.DERIVED] + " DERIVED");
    if (c[S.STALE]) parts.push(c[S.STALE] + " STALE");
    if (c[S.NA]) parts.push(c[S.NA] + " N/A");
    if (c[S.LOADING]) parts.push(c[S.LOADING] + " LOADING");
    return parts.length > 1 ? label + " · " + parts.join(" · ") : label;
  }

  var SHORT = { LIVE: "LIVE", PARTIAL: "PART", STALE: "STALE", "N/A": "N/A", DERIVED: "DRV", LOADING: "…" };
  function short(s) { return SHORT[s] || s; }

  var ERRORS = {
    plan_required: "listed by the provider, but not included in the current data plan",
    alpaca_not_configured: "price source not connected (Alpaca keys not set)",
    universe_unavailable: "S&P 500 constituent list unavailable",
    provider_forbidden: "provider refused the request",
    symbol_not_found: "unknown symbol at the provider",
    invalid_symbol: "invalid symbol",
    rate_limited: "provider rate limit reached",
    provider_timeout: "provider timed out",
    provider_unreachable: "provider unreachable",
    provider_auth: "provider rejected the server key",
    provider_error: "provider error / empty response",
    no_data: "no data for this range",
    network: "could not reach /api",
    expired: "last real value is older than 24 h",
    eia_not_configured: "EIA API key not set in the Worker",
    finnhub_not_configured: "Finnhub API key not set in the Worker",
    not_sec_registrant: "not an SEC registrant",
    no_underlying_price: "no price for the underlying",
    no_listed_options: "no listed options",
    storage_not_configured: "server storage not configured",
    forbidden_origin: "request from another site refused",
    bad_request: "invalid request",
    not_found: "not found"
  };
  function errorText(code) { return ERRORS[code] || code || "unavailable"; }

  root.Provenance = {
    S: S, isReal: isReal, instrumentStatus: instrumentStatus, fieldStatus: fieldStatus, fieldValue: fieldValue,
    historyStatus: historyStatus, derivedStatus: derivedStatus, summarize: summarize, short: short, errorText: errorText,
    MAX_AGE_MS: MAX_AGE_MS
  };
})(typeof window !== "undefined" ? window : globalThis);
