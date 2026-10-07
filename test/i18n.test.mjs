// Interface translations (public/terminal/i18n.js): stable (a translated text is never translated again — a
// translation that contained its source would loop), data-safe, and Italian dates.
//   node test/i18n.test.mjs
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
globalThis.localStorage = { getItem: () => "it", setItem() {} };
Object.defineProperty(globalThis, "navigator", { value: { language: "it-IT" }, configurable: true });
await import("../public/terminal/i18n.js");
const I = globalThis.I18N;
const samples = [...I._exact.keys(), ...I._phrases.map(([e]) => e), ...I._phrases.map(([e]) => `Note: ${e} here`),
  "EUROPE & AFRICA · 10/10 OPEN", "ASIA-PACIFIC · 7/9 OPEN", "AMERICAS · 0/5 OPEN", "opens in 1h 11m (15:00)", "USD FOMC Meeting Minutes in 5h58", "10/24 open",
  "No weekly briefing yet. Written automatically on Saturday mornings at 08:00 (Rome time).", "Writing the Daily briefing for 2026-10-07 from real data… (model: Workers AI, about 20 s)",
  "6 results of 6 · market cap and P/E removed: no fundamentals source (N/A)", "Daily · 2026-10-07 · written 07 ott, 11:48:03 ·", "DATA AS OF 21:59:00 local"];
// the page translates each text once (guard), but no translation may keep growing if applied again (that froze the page once)
const unstable = samples.filter((x) => { let a = x; for (let i = 0; i < 3; i++) a = I.tr(a); return I.tr(a) !== a; });
ok("no translation keeps changing when applied again (reaches a fixed point: no loops)", unstable.length === 0, unstable.slice(0, 5).map((x) => `${x} → ${I.tr(x)} → ${I.tr(I.tr(x))}`).join(" | "));
ok("phrases never match inside a longer word", I.tr("ASIA-PACIFIC · 7/9 OPEN") === "ASIA-PACIFICO · 7/9 APERTE" && I.tr("ASIA-PACIFICO · 7/9 APERTE") === "ASIA-PACIFICO · 7/9 APERTE");
ok("labels and dynamic texts", I.tr("PORTFOLIO") === "PORTAFOGLIO" && I.tr("opens in 1h 11m (15:00)") === "apre tra 1h 11m (15:00)" && I.tr("10/24 open") === "10/24 aperte" && /^Nessun briefing settimanale ancora\./.test(I.tr("No weekly briefing yet. Written automatically on Saturday mornings at 08:00 (Rome time).")));
ok("data-like single words are left alone (names, tickers, event titles)", ["NVIDIA", "AAPL", "Ueda", "CPI m/m", "Retail Sales m/m", "FOMC Meeting Minutes", "Bank of England"].every((x) => I.tr(x) === x));
ok("dates and times follow the language", I.locale() === "it-IT");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
