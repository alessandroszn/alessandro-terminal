/* Alessandro Terminal — data provenance rules (T04).
   Pure functions, no DOM: loaded by the page (window.Provenance) and by the Node tests.

   Status vocabulary (what the user sees next to a number):
     LIVE       real, from the provider, inside its freshness window
     PARTIAL    real but incomplete (e.g. volume from a venue subset)
     STALE      real but old: the provider failed or the value is past `staleAt`
     N/A        no source for this value; nothing is estimated or invented
     SIMULATED  generated locally for the demo universe — never real
     DERIVED    computed by the terminal from real inputs (e.g. a correlation)
     MIXED      a view that combines real and simulated values
     LOADING    real data requested, not arrived yet                                   */
(function (root) {
  "use strict";
  var S = Object.freeze({
    LIVE: "LIVE", PARTIAL: "PARTIAL", STALE: "STALE", NA: "N/A",
    SIMULATED: "SIMULATED", DERIVED: "DERIVED", MIXED: "MIXED", LOADING: "LOADING"
  });
  var REAL = [S.LIVE, S.PARTIAL, S.STALE, S.DERIVED];
  var MAX_AGE_MS = 24 * 3600 * 1000; // older than this, a real value is not shown at all

  function ms(x) { var v = Date.parse(x); return isFinite(v) ? v : null; }
  function isReal(s) { return REAL.indexOf(s) >= 0; }

  /* One instrument. q = InstrumentData from /api/quote, or null.
     o = { live: is this symbol served by the real provider?, now, error } */
  function instrumentStatus(q, o) {
    o = o || {};
    if (!o.live) return S.SIMULATED;
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
    if (inst === S.SIMULATED || inst === S.LOADING || inst === S.NA) return inst;
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

  /* Price history (from /api/history). meta = the response envelope, or null. */
  function historyStatus(meta, o) {
    o = o || {};
    if (!o.live) return S.SIMULATED;
    if (!meta) return o.error ? S.NA : S.LOADING;
    var now = o.now != null ? o.now : Date.now();
    if (meta.status === S.STALE) return S.STALE;
    var staleAt = ms(meta.staleAt);
    if (staleAt != null && now > staleAt) return S.STALE;
    return S.LIVE;
  }

  /* A value the terminal computes from other values. */
  function derivedStatus(inputs) {
    if (!inputs || !inputs.length) return S.NA;
    if (inputs.indexOf(S.NA) >= 0) return S.NA;
    if (inputs.indexOf(S.LOADING) >= 0) return S.LOADING;
    var sim = inputs.filter(function (s) { return s === S.SIMULATED; }).length;
    if (sim === inputs.length) return S.SIMULATED;
    if (sim || inputs.indexOf(S.MIXED) >= 0) return S.MIXED;
    if (inputs.indexOf(S.STALE) >= 0) return S.STALE;
    return S.DERIVED;
  }

  /* Label for a view (window) or the whole screen, from the statuses of what it shows. */
  function summarize(statuses) {
    statuses = (statuses || []).filter(Boolean);
    var c = {};
    statuses.forEach(function (s) { c[s] = (c[s] || 0) + 1; });
    var real = statuses.filter(isReal).length, sim = c[S.SIMULATED] || 0;
    var label;
    if (!statuses.length) label = null;
    else if (c[S.MIXED] || (real && sim)) label = S.MIXED;
    else if (sim) label = S.SIMULATED;
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
    if (c[S.SIMULATED]) parts.push(c[S.SIMULATED] + " SIM");
    if (c[S.NA]) parts.push(c[S.NA] + " N/A");
    if (c[S.LOADING]) parts.push(c[S.LOADING] + " LOADING");
    return parts.length > 1 ? label + " · " + parts.join(" · ") : label;
  }

  var SHORT = { LIVE: "LIVE", PARTIAL: "PART", STALE: "STALE", "N/A": "N/A", SIMULATED: "SIM", DERIVED: "DRV", MIXED: "MIX", LOADING: "…" };
  function short(s) { return SHORT[s] || s; }

  var ERRORS = {
    symbol_not_found: "unknown symbol at the provider",
    invalid_symbol: "invalid symbol",
    rate_limited: "provider rate limit reached",
    provider_timeout: "provider timed out",
    provider_unreachable: "provider unreachable",
    provider_auth: "provider rejected the server key",
    provider_error: "provider error / empty response",
    no_data: "no data for this range",
    network: "could not reach /api"
  };
  function errorText(code) { return ERRORS[code] || code || "unavailable"; }

  root.Provenance = {
    S: S, isReal: isReal, instrumentStatus: instrumentStatus, fieldStatus: fieldStatus, fieldValue: fieldValue,
    historyStatus: historyStatus, derivedStatus: derivedStatus, summarize: summarize, short: short, errorText: errorText,
    MAX_AGE_MS: MAX_AGE_MS
  };
})(typeof window !== "undefined" ? window : globalThis);
