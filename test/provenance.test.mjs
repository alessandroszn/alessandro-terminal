// T04 — client provenance rules (public/terminal/provenance.js), run in a sandbox like the browser would.
//   node test/provenance.test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../public/terminal/provenance.js", import.meta.url), "utf8");
const box = {}; vm.createContext(box); vm.runInContext(code, box);
const P = box.Provenance, S = P.S;

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

const NOW = Date.parse("2026-10-06T15:00:00Z");
const iso = (t) => new Date(t).toISOString();
const q = (over = {}) => ({
  symbol: "AAPL", status: "LIVE", source: "twelvedata", timestamp: iso(NOW - 70_000),
  fetchedAt: iso(NOW - 60_000), staleAt: iso(NOW + 540_000), marketOpen: true,
  fields: {
    price: { value: 332.88, status: "LIVE" }, prevClose: { value: 332.89, status: "LIVE" },
    volume: { value: 537842, status: "PARTIAL", note: "venue subset" },
    marketCap: { value: null, status: "N/A", note: "not provided by the current data plan" },
  },
  ...over,
});

// ---- instruments ----
ok("live data -> LIVE", P.instrumentStatus(q(), { live: true, now: NOW }) === S.LIVE);
ok("simulated symbol -> SIMULATED (whatever data it has)", P.instrumentStatus(q(), { live: false, now: NOW }) === S.SIMULATED);
ok("stale from server -> STALE", P.instrumentStatus(q({ status: "STALE" }), { live: true, now: NOW }) === S.STALE);
ok("past staleAt on the client -> STALE", P.instrumentStatus(q(), { live: true, now: NOW + 600_000 }) === S.STALE);
ok("older than 24 h -> N/A (not shown)", P.instrumentStatus(q(), { live: true, now: NOW + 25 * 3600_000 }) === S.NA);
ok("live symbol, no quote yet -> LOADING", P.instrumentStatus(null, { live: true, now: NOW }) === S.LOADING);
ok("live symbol, provider error, no quote -> N/A (no fallback)", P.instrumentStatus(null, { live: true, now: NOW, error: "rate_limited" }) === S.NA);

// ---- fields ----
const inst = P.instrumentStatus(q(), { live: true, now: NOW });
ok("price field -> LIVE", P.fieldStatus(q(), "price", inst) === S.LIVE);
ok("volume field -> PARTIAL", P.fieldStatus(q(), "volume", inst) === S.PARTIAL);
ok("missing fundamental (market cap) -> N/A", P.fieldStatus(q(), "marketCap", inst) === S.NA && P.fieldValue(q(), "marketCap") === null);
ok("field the API never sent (P/E) -> N/A", P.fieldStatus(q(), "pe", inst) === S.NA && P.fieldValue(q(), "pe") === null);
ok("fields of a STALE instrument -> STALE", P.fieldStatus(q(), "price", S.STALE) === S.STALE && P.fieldStatus(q(), "volume", S.STALE) === S.STALE);
ok("fields of a simulated instrument -> SIMULATED", P.fieldStatus(null, "price", S.SIMULATED) === S.SIMULATED);
ok("fieldValue returns the real value", P.fieldValue(q(), "price") === 332.88);

// ---- history ----
const h = { status: "LIVE", fetchedAt: iso(NOW - 1000), staleAt: iso(NOW + 86_000_000) };
ok("history LIVE", P.historyStatus(h, { live: true, now: NOW }) === S.LIVE);
ok("history STALE (server)", P.historyStatus({ ...h, status: "STALE" }, { live: true, now: NOW }) === S.STALE);
ok("history past staleAt -> STALE", P.historyStatus({ ...h, staleAt: iso(NOW - 1) }, { live: true, now: NOW }) === S.STALE);
ok("history of a simulated symbol -> SIMULATED", P.historyStatus(null, { live: false }) === S.SIMULATED);
ok("history failed -> N/A", P.historyStatus(null, { live: true, error: "no_data" }) === S.NA);

// ---- derived ----
ok("derived from real inputs -> DERIVED", P.derivedStatus([S.LIVE, S.LIVE]) === S.DERIVED);
ok("derived from PARTIAL + LIVE -> DERIVED", P.derivedStatus([S.LIVE, S.PARTIAL]) === S.DERIVED);
ok("derived from real + simulated -> MIXED", P.derivedStatus([S.LIVE, S.SIMULATED]) === S.MIXED);
ok("derived from simulated only -> SIMULATED", P.derivedStatus([S.SIMULATED, S.SIMULATED]) === S.SIMULATED);
ok("derived with a stale input -> STALE", P.derivedStatus([S.LIVE, S.STALE]) === S.STALE);
ok("derived with a missing input -> N/A", P.derivedStatus([S.LIVE, S.NA]) === S.NA);
ok("derived with a loading input -> LOADING", P.derivedStatus([S.LIVE, S.LOADING]) === S.LOADING);

// ---- views (mixed indication) ----
const mixed = P.summarize([S.LIVE, S.LIVE, S.SIMULATED]);
ok("view with real + simulated -> MIXED", mixed.label === S.MIXED);
ok("MIXED text names both parts", mixed.text === "MIXED · 2 LIVE · 1 SIM", mixed.text);
ok("all-live view -> LIVE", P.summarize([S.LIVE, S.PARTIAL]).label === S.LIVE);
ok("all-simulated view -> SIMULATED", P.summarize([S.SIMULATED]).label === S.SIMULATED);
ok("live + stale view -> STALE (worst real state wins)", P.summarize([S.LIVE, S.STALE]).label === S.STALE);
ok("live + N/A view -> LIVE with the N/A counted", P.summarize([S.LIVE, S.NA]).text === "LIVE · 1 LIVE · 1 N/A", P.summarize([S.LIVE, S.NA]).text);
ok("nothing real arrived -> LOADING / N/A", P.summarize([S.LOADING]).label === S.LOADING && P.summarize([S.NA]).label === S.NA);
ok("derived-only view -> DERIVED", P.summarize([S.DERIVED]).label === S.DERIVED);
ok("empty view -> no label", P.summarize([]).label === null);

// ---- text ----
ok("short chip labels", P.short(S.SIMULATED) === "SIM" && P.short(S.PARTIAL) === "PART" && P.short(S.NA) === "N/A");
ok("error codes have readable text", P.errorText("symbol_not_found").includes("unknown") && P.errorText("rate_limited").includes("rate limit"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
