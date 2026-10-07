// More countries' yields (approved 7 Oct 2026): parsers on fixtures in each provider's own format (copied from real
// responses), the /api/yields?ids= endpoint with mocked providers, past curves, spreads, history, OECD monthly series.
// Fixtures are test data only; nothing here is shown in the terminal.
//   node test/yields-world.test.mjs
import { deflateRawSync } from "node:zlib";
import { app as worker } from "../src/worker.mjs";
import { parseBde, parseNbbCsv, parseBpstat, parseNorgesBank, parseOenb, parseRbaF2, parseRbnzB2, unzipText, parseChinaBond, parseHkma, parseBnm, parseSarb, parseBcrp, bondTenor, pastCurves, spreadVs, yieldCatalog, YIELD_IDS, CURVES, oecdId } from "../src/yields.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
const val = (rows, date, t) => { const r = rows.find((x) => x.date === date); const p = r && r.points.find((x) => x.tenor === t); return p ? p.value : undefined; };

// ---------- Spain (Banco de España BIEST JSON: newest first, ISO timestamps) ----------
const BDE = [
  { serie: "DPUG0B1F0ZN", fechas: ["2026-10-05T08:15:00Z", "2026-10-02T08:15:00Z"], valores: [3.466, 3.434] },
  { serie: "DPUG0B1F0ZP", fechas: ["2026-10-05T08:15:00Z", "2026-10-02T08:15:00Z"], valores: [4.126, null] },
  { serie: "DPUDTES00U7", fechas: ["2026-09-30T08:15:00Z"], valores: [3.092] },
];
const es = parseBde(BDE);
ok("Spain: dates from the timestamps, oldest first; a null is missing (never 0); a series not asked for is ignored", es.map((r) => r.date).join() === "2026-10-02,2026-10-05" && val(es, "2026-10-05", "10Y") === 4.126 && val(es, "2026-10-02", "10Y") === null && val(es, "2026-10-02", "3Y") === 3.434 && !es.some((r) => r.date === "2026-09-30"));

// ---------- Belgium (NBB.Stat SDMX CSV) ----------
const NBB = "DATAFLOW,FREQ,IROLOBE2_MATUR,IROLOBE2_TYPE,TIME_PERIOD,OBS_VALUE,OBS_STATUS,DECIMALS\r\nBE2:DF_IROLOBE2(1.0),D,1Y,F,2026-10-06,3.1,A,2\r\nBE2:DF_IROLOBE2(1.0),D,10Y,F,2026-10-06,4.25,A,2\r\nBE2:DF_IROLOBE2(1.0),D,10Y,F,2026-10-07,4.27,A,2\r\nBE2:DF_IROLOBE2(1.0),D,28Y,F,2026-10-07,4.9,A,2\r\n";
const be = parseNbbCsv(NBB);
ok("Belgium: OLO yields by maturity and day; maturities not on the list ignored", val(be, "2026-10-07", "10Y") === 4.27 && val(be, "2026-10-06", "1Y") === 3.1 && !be.some((r) => r.points.some((p) => p.tenor === "28Y")));

// ---------- Portugal (BPstat JSON-stat 2.0) ----------
const BPSTAT = { id: ["18", "45", "reference_date"], size: [1, 2, 4], value: [3.27, 3.25, 3.28, 3.24, 4, 4.03, 3.95, null],
  dimension: { "45": { category: { index: ["2743", "2740"], label: { "2740": "10 years", "2743": "2 years" } } }, reference_date: { category: { index: ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"] } } } };
const pt = parseBpstat(BPSTAT);
ok("Portugal: JSON-stat values located by maturity and date; null stays missing", val(pt, "2026-09-30", "2Y") === 3.27 && val(pt, "2026-10-02", "10Y") === 3.95 && val(pt, "2026-10-05", "10Y") === null && val(pt, "2026-10-05", "2Y") === 3.24);
ok("Portugal: an unexpected dimension with several values → nothing (never guessed)", parseBpstat({ ...BPSTAT, size: [2, 2, 4] }).length === 0);

// ---------- Norway (semicolon CSV) ----------
const NB = "FREQ;Frequency;TENOR;Tenor;INSTRUMENT_TYPE;Instrument Type;DECIMALS;Decimals;TIME_PERIOD;OBS_VALUE\nB;Business;3Y;3 years;GBON;Government bonds;3;Three;2026-10-05;4.856\nB;Business;10Y;10 years;GBON;Government bonds;3;Three;2026-10-06;4.68\n";
const no = parseNorgesBank(NB);
ok("Norway: tenor and value by header name", val(no, "2026-10-06", "10Y") === 4.68 && val(no, "2026-10-05", "3Y") === 4.856);

// ---------- Austria (OeNB XML: one average yield) ----------
const at = parseOenb('<OeNBData><data><dataSet pos="VDBZIUDRB" freq="D"><values><obs value="3.535" periode="2026-09-24"/><obs value="3.55" periode="2026-09-25"/></values></dataSet></data></OeNBData>');
ok("Austria: a single average yield (no maturity: not placed on a curve), labelled as such", at.length === 2 && at[1].points.length === 1 && at[1].points[0].tenor === "AVG" && at[1].points[0].months === null && at[1].points[0].value === 3.55 && /not a single maturity/.test(at[1].points[0].note));

// ---------- Australia (RBA F2 CSV) ----------
const F2 = "F2 CAPITAL MARKET YIELDS – GOVERNMENT BONDS\nTitle,Australian Government 2 year bond,Australian Government 3 year bond,Australian Government 5 year bond,Australian Government 10 year bond,Australian Government Indexed Bond\nSeries ID,FCMYGBAG2D,FCMYGBAG3D,FCMYGBAG5D,FCMYGBAG10D,FCMYGBAGID\n20-May-2013,,,,3.229\n29-Sep-2026,4.984,4.964,5.023,5.369,2.950\n30-Sep-2026,4.942,4.922,4.983,5.344,2.942\n\n\n";
const au = parseRbaF2(F2);
ok("Australia: columns by series id, dd-Mon-yyyy dates; the indexed bond is not a nominal maturity", val(au, "2026-09-30", "10Y") === 5.344 && val(au, "2026-09-29", "2Y") === 4.984 && !au[0].points.some((p) => p.tenor === "ID"));

// ---------- New Zealand (RBNZ B2 xlsx) ----------
const SS = '<sst><si><t>Secondary market government bond closing yields</t></si><si><t>INM.DG101.NZZCF</t></si><si><t>INM.DG102.NZZCF</t></si><si><t>INM.DG105.NZZCF</t></si><si><t>INM.DG110.NZZCF</t></si><si><t>Series Id</t></si></sst>';
const SHEET = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="5"><c r="A5" t="s"><v>5</v></c><c r="I5" t="s"><v>1</v></c><c r="J5" t="s"><v>2</v></c><c r="K5" t="s"><v>3</v></c><c r="L5" t="s"><v>4</v></c></row>' +
  '<row r="2198"><c r="A2198"><v>46300</v></c><c r="I2198"><v>3.2</v></c><c r="J2198"><v>3.83</v></c><c r="K2198"><v>4.49</v></c><c r="L2198"><v>5.04</v></c></row><row r="2199"><c r="A2199"><v>46301</v></c><c r="I2199"><v>3.2</v></c><c r="J2199"><v>3.88</v></c><c r="K2199"><v>4.55</v></c><c r="L2199"><v>5.11</v></c><c r="M2199"/></row></sheetData></worksheet>';
const nz = parseRbnzB2(SS, SHEET);
ok("New Zealand: columns found by series code, Excel serial dates (46301 = 6 Oct 2026)", val(nz, "2026-10-06", "10Y") === 5.11 && val(nz, "2026-10-05", "2Y") === 3.83 && nz.length === 2, JSON.stringify(nz));
// a real zip container around the two files
function zip(files) {
  const parts = [], cen = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text)), nb = Buffer.from(name), raw = Buffer.from(text);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, data); cen.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(cen), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(cen.length / 2, 8); end.writeUInt16LE(cen.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const XLSX = zip({ "xl/sharedStrings.xml": SS, "xl/worksheets/sheet1.xml": SHEET });
ok("xlsx: a file is read out of the zip (deflate)", (await unzipText(XLSX, "xl/worksheets/sheet1.xml")) === SHEET && (await unzipText(XLSX, "nope.xml")) === null);

// ---------- China (ChinaBond HTML table) ----------
const CB = '<table><tr><td>Yield Curve Name</td><td>Date</td></tr><tr> <td style="text-align: left">ChinaBond Government Bond Yield Curve</td> <td>2026-09-30</td> <td>1.1611</td> <td>1.1916</td> <td>1.2197</td> <td>1.2818</td> <td>1.4090</td> <td>1.5101</td> <td>1.6822</td> <td>2.1000</td> </tr><tr> <td>ChinaBond CP Note Yield Curve (AAA)</td> <td>2026-09-30</td> <td>1.44</td><td>1.48</td><td>1.49</td><td>1.63</td><td>1.68</td><td>1.79</td><td>1.95</td><td></td></tr></table>';
const cn = parseChinaBond(CB);
ok("China: only the government curve; 3M…30Y in order", cn.length === 1 && val(cn, "2026-09-30", "10Y") === 1.6822 && val(cn, "2026-09-30", "3M") === 1.1611 && val(cn, "2026-09-30", "30Y") === 2.1);

// ---------- Hong Kong (HKMA JSON) ----------
const hk = parseHkma({ header: { success: true }, result: { records: [{ end_of_date: "2026-10-07", term: "1W", issue_no: "Q2628", yield: 2.24 }, { end_of_date: "2026-10-07", term: "12M", issue_no: "Q2700", yield: 3.29 }, { end_of_date: "2026-10-07", term: "2 YR", issue_no: "4210", yield: 3.644 }] } });
ok("Hong Kong: Exchange Fund paper by term, the issue named", val(hk, "2026-10-07", "2Y") === 3.644 && val(hk, "2026-10-07", "1Y") === 3.29 && /Note 4210/.test(hk[0].points.find((p) => p.tenor === "2Y").note) && val(hk, "2026-10-07", "6M") === null);

// ---------- Malaysia (BNM page) ----------
const BNM = '<select><option value="2026-10-07" selected>2026-10-07</option><option value="2026-10-06">x</option></select><table><tr><td> MGS Benchmarks </td></tr><tr><td> Tenure </td></tr>' +
  '<tr> <td> 3-year </td> <td> Mar-2029 </td> <td> 3.237 </td> <td> 3.48 </td> <td> 3.49 </td> <td> 3.49 </td> <td> 110.47 </td> <td> <span id="there3"> 1</span> </td> </tr>' +
  '<tr> <td> 5-year </td> <td> Jun-2031 </td> <td> 4.232 </td> <td> 3.75 * </td> <td> 3.77 * </td> <td> 3.77 * </td> <td> - </td> <td> <span> 0</span> </td> </tr>' +
  '<tr> <td> 10-year </td> <td> Jul-2035 </td> <td> 3.476 </td> <td> 3.97 </td> <td> 3.99 </td> <td> 3.97 </td> <td> 54.51 </td> <td> <span> -3</span> </td> </tr></table> Government Investment Issues <tr><td> 3-year </td><td>Oct-2029</td><td>3.52</td><td>3.53</td><td>3.53</td><td>9.99</td></tr>';
const my = parseBnm(BNM);
const my10 = my[0].points.find((p) => p.tenor === "10Y"), my5 = my[0].points.find((p) => p.tenor === "5Y");
ok("Malaysia: the selected day, MGS closing yields, the published daily change; a last-traded yield says so and carries no change", my[0].date === "2026-10-07" && my10.value === 3.97 && my10.chgBp === -3 && my5.value === 3.77 && /last traded/.test(my5.note) && my5.chgBp === undefined && my[0].points.length === 3);

// ---------- South Africa (SARB JSON) ----------
const za = parseSarb([[{ Period: "2026-10-06T00:00:00", Value: 8.175 }, { Period: "2026-10-05T00:00:00", Value: 8.225 }], [{ Period: "2026-10-06T00:00:00", Value: 8.965 }]]);
ok("South Africa: each bond at the standard maturity nearest its time to maturity, the bond named", val(za, "2026-10-06", "3Y") === 8.175 && val(za, "2026-10-06", "10Y") === 8.965 && /R209/.test(za.find((r) => r.date === "2026-10-06").points.find((p) => p.tenor === "10Y").note));
ok("nearest standard maturity: within a quarter-year or a fifth of the maturity, else none", bondTenor(3.3) === 3 && bondTenor(9.5) === 10 && bondTenor(4.1) === 5 && bondTenor(12.5) === null);

// ---------- Peru (BCRP JSON, Spanish months) ----------
const pe = parseBcrp({ config: {}, periods: [{ name: "30.Set.26", values: ["6.66"] }, { name: "05.Oct.26", values: ["6.56"] }, { name: "06.Oct.26", values: ["n.d."] }] });
ok("Peru: Spanish month names (Set = September); n.d. is missing", val(pe, "2026-09-30", "10Y") === 6.66 && val(pe, "2026-10-05", "10Y") === 6.56 && !pe.some((r) => r.date === "2026-10-06"));

// ---------- past curves and spreads ----------
const mk = (d, v) => ({ date: d, points: [{ tenor: "10Y", months: 120, value: v }] });
const rows = [mk("2025-10-06", 3.0), mk("2026-07-06", 3.5), mk("2026-09-04", 3.8), mk("2026-09-28", 3.9), mk("2026-10-05", 4.0), mk("2026-10-06", 4.1)];
const past = pastCurves(rows);
ok("past curves: the last publication on or before 1W / 1M / 3M before; 1Y within a week after when nothing earlier", past["1W"].date === "2026-09-28" && past["1M"].date === "2026-09-04" && past["3M"].date === "2026-07-06" && past["1Y"].date === "2025-10-06", JSON.stringify(past));
ok("past curves: nothing when the history is too short", Object.keys(pastCurves([mk("2026-10-05", 4), mk("2026-10-06", 4.1)])).length === 0);
const sp = spreadVs([mk("2026-10-02", 4.2), mk("2026-10-06", 4.3)], [mk("2026-10-02", 2.9), mk("2026-10-05", 3.0)]);
ok("10Y spread: on the latest day both published (never across two days)", sp.bp === 130 && sp.date === "2026-10-02");

// ---------- catalog ----------
const cat = yieldCatalog({});
ok("catalog: every id once, with region, frequency and the series used for its history", cat.length === YIELD_IDS.length && new Set(cat.map((c) => c.id)).size === cat.length && cat.find((c) => c.id === "IT").freq === "M" && cat.find((c) => c.id === "ES").freq === "D" && cat.find((c) => c.id === "AT").histTenor === "AVG" && cat.find((c) => c.id === "ZA").region === "Middle East & Africa");
ok("monthly series: Italy is the OECD 10-year average on FRED, labelled MONTHLY AVERAGE", oecdId("IT") === "IRLTLT01ITM156N" && /MONTHLY AVERAGE/.test(CURVES.IT.kind));

// ---------- endpoint with mocked providers ----------
let store = new Map();
globalThis.caches = { default: { match: async (r) => { const k = typeof r === "string" ? r : r.url; return store.has(k) ? new Response(store.get(k)) : undefined; }, put: async (r, res) => { store.set(typeof r === "string" ? r : r.url, await res.text()); } } };
const ctx = { waitUntil: () => {} };
const KEYF = "fred-test-key-111";
// weekdays only, like a market calendar, ending Tuesday 6 Oct 2026
const days = (n) => { const out = []; for (let k = 0; out.length < n; k++) { const t = new Date(Date.UTC(2026, 9, 6) - k * 86400_000); if (t.getUTCDay() % 6) out.push(t.toISOString().slice(0, 10)); } return out.reverse(); };
const D = days(400);
let calls = [];
globalThis.fetch = async (u, init) => {
  u = String(u); calls.push({ u, accept: init && init.headers && init.headers.accept });
  if (u.startsWith("https://app.bde.es/")) return new Response(JSON.stringify(["DPUG0B1F0ZN", "DPUG0B1F0ZP"].map((s, k) => ({ serie: s, fechas: D.map((d) => d + "T08:15:00Z").reverse(), valores: D.map((_, i) => +(3 + k + i / 1000).toFixed(3)).reverse() }))));
  if (u.startsWith("https://nsidisseminate-stat.nbb.be/")) return new Response("DATAFLOW,FREQ,IROLOBE2_MATUR,IROLOBE2_TYPE,TIME_PERIOD,OBS_VALUE\n" + D.map((d, i) => `BE2:DF_IROLOBE2(1.0),D,10Y,F,${d},${(3 + i / 1000).toFixed(3)}`).join("\n"));
  if (u.startsWith("https://api.stlouisfed.org/")) {
    const p = new URL(u).searchParams; if (p.get("api_key") !== KEYF) return new Response("{}", { status: 400 });
    const id = p.get("series_id"), base = { IRLTLT01ITM156N: 3.6, IRLTLT01DEM156N: 2.7, IRLTLT01USM156N: 4.3, DGS10: 4.1 }[id];
    if (id === "IRLTLT01XXM156N" || base == null) return new Response(JSON.stringify({ observations: [] }));
    const mon = id.startsWith("IRLTLT"), obs = mon ? ["2026-06-01", "2026-07-01", "2026-08-01"].map((d, i) => ({ date: d, value: (base + i / 10).toFixed(2) })) : D.slice(-30).map((d) => ({ date: d, value: String(base) }));
    return new Response(JSON.stringify({ observations: obs.reverse() }));
  }
  if (u.startsWith("https://api.statistiken.bundesbank.de/")) return new Response("x," + "BBSIS.D.I.ZAR.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A\n" + D.map((d) => `${d},2.70`).join("\n"));
  return new Response("", { status: 404 });
};
const call = async (path, env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com", FRED_KEY: KEYF };
let r = await call("/api/yields?ids=ES,BE,IT,ZZ", env);
const ES = r.j && r.j.curves.ES, BEc = r.j && r.j.curves.BE, IT = r.j && r.j.curves.IT;
ok("/api/yields?ids=: Spain and Belgium daily with past curves; unknown ids dropped", r.status === 200 && ES && BEc && !r.j.curves.ZZ && ES.timestamp === "2026-10-06" && ES.past["1W"] && ES.past["1Y"] && BEc.points.find((p) => p.tenor === "10Y").value === 3.399, JSON.stringify(r.j).slice(0, 400));
ok("/api/yields?ids=: Spain's 10Y spread vs the Bund on the same day (Bundesbank) and vs the U.S. (FRED)", ES.spreads.DE && ES.spreads.DE.date === "2026-10-06" && ES.spreads.DE.bp === Math.round((4.399 - 2.7) * 1000) / 10 && ES.spreads.US && ES.spreads.US.bp === Math.round((4.399 - 4.1) * 1000) / 10, JSON.stringify(ES.spreads));
ok("/api/yields?ids=: Italy = OECD monthly average via FRED, month-dated, spread vs the German and U.S. averages of the same month; no 'a week ago' for a monthly series", IT.freq === "M" && IT.timestamp === "2026-08-01" && IT.points[0].value === 3.8 && !IT.past["1W"] && IT.past["1M"].date === "2026-07-01" && IT.spreads.DE.bp === 90 && IT.spreads.DE.date === "2026-08-01" && IT.spreads.US.bp === -70 && /MONTHLY AVERAGE/.test(IT.kind), JSON.stringify(IT));
ok("/api/yields?ids=: Belgium asked for SDMX CSV; the FRED key only in requests to FRED, never in the response", calls.some((c) => c.u.includes("nbb.be") && /sdmx\.data\+csv/.test(c.accept || "")) && calls.some((c) => c.u.includes(KEYF) && c.u.includes("api.stlouisfed.org")) && !r.text.includes(KEYF));
r = await call("/api/yields?ids=", env);
ok("/api/yields?ids= with nothing valid → 400", r.status === 400);
r = await call("/api/yields/history?id=ES&tenor=10Y", env);
ok("/api/yields/history: Spain 10Y about a year of daily publications, oldest first", r.status === 200 && r.j.points.length >= 250 && r.j.points[0][0] < r.j.points[r.j.points.length - 1][0] && r.j.freq === "D", JSON.stringify(r.j).slice(0, 200));
r = await call("/api/yields/history?id=IT", env);
ok("/api/yields/history: Italy monthly averages", r.status === 200 && r.j.freq === "M" && r.j.points.length === 3 && r.j.tenor === "10Y");
r = await call("/api/yields/history?id=XX", env);
ok("/api/yields/history: unknown id → 400", r.status === 400);
r = await call("/api/yields/catalog", env);
ok("/api/yields/catalog: the full list without contacting any source", r.status === 200 && r.j.catalog.length === YIELD_IDS.length);
calls = []; store = new Map();
r = await call("/api/yields?ids=IT", { ALLOWED_ORIGIN: env.ALLOWED_ORIGIN });
ok("/api/yields?ids=IT without FRED_KEY → N/A naming the missing secret", r.status === 502 && r.j.errors.IT.error === "fred_not_configured");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
