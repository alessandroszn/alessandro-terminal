// Unit test for the pure normalizer (runs in Node, no network / no Worker APIs).
import { normalizeQuote } from "../src/worker.mjs";

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  got=${got}${ok ? "" : `  want=${want}`}`);
  ok ? pass++ : fail++;
}

// Sample shaped exactly like Twelve Data /quote (strings, as the API returns them)
const sample = {
  symbol: "AAPL", name: "Apple Inc", exchange: "NASDAQ", currency: "USD",
  datetime: "2026-10-06", timestamp: 1759766400,
  open: "246.00000", high: "249.10000", low: "245.20000", close: "247.85001",
  volume: "51230000", previous_close: "246.10000",
  percent_change: "0.71110",
  fifty_two_week: { low: "164.08000", high: "260.10000", range: "164.08 - 260.10" },
};

const n = normalizeQuote("AAPL", sample);
eq("symbol", n.symbol, "AAPL");
eq("name", n.name, "Apple Inc");
eq("price (close)", n.price, 247.85001);
eq("prevClose", n.prevClose, 246.1);
eq("changePct", Math.round(n.changePct * 1000) / 1000, 0.711);
eq("open", n.open, 246);
eq("high", n.high, 249.1);
eq("low", n.low, 245.2);
eq("volume", n.volume, 51230000);
eq("currency", n.currency, "USD");
eq("52w low", n.fiftyTwoWeekLow, 164.08);
eq("52w high", n.fiftyTwoWeekHigh, 260.1);
eq("asOf is valid ISO", !Number.isNaN(Date.parse(n.asOf)), true);
eq("provider", n.provider, "twelvedata");

// changePct derived when percent_change missing
const n2 = normalizeQuote("X", { close: "110", previous_close: "100" });
eq("derived changePct", Math.round(n2.changePct * 100) / 100, 10);

// error / empty payloads -> null
eq("error payload -> null", normalizeQuote("X", { status: "error", message: "bad key" }), null);
eq("no close -> null", normalizeQuote("X", { symbol: "X" }), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
