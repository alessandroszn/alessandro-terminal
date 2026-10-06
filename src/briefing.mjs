// BRIEFING — REAL DATA → MODEL ANALYSIS → BRIEFING (approved T05: Cloudflare Workers AI).
// Inputs are only real, timestamped data the Worker already holds or fetches from approved sources:
//   quotes  : the shared Twelve Data quote cache (read-only; the briefing never spends provider credits)
//   yields  : U.S. Treasury + ECB
//   calendar: BLS + BEA schedules
//   news    : GDELT headlines
// The model is told to use only those facts; every number in its text is then checked against the
// inputs and any number that cannot be traced is reported, not hidden.
import { cacheRead, cacheWrite, iso } from "./lib.mjs";
import { getYieldCurves } from "./yields.mjs";
import { getCalendar } from "./calendar.mjs";
import { getHeadlines } from "./news.mjs";

export const BRIEF_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-:\/]{0,19}$/;
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v).toFixed(d));
const raw = (v) => (v == null || !Number.isFinite(v) ? null : String(+Number(v).toFixed(6))); // full source precision

export function buildBriefingData({ quotes, curves, events, headlines, now }) {
  const lines = [], sources = [];
  for (const q of quotes) {
    lines.push(`QUOTE ${q.symbol} (${q.name || q.symbol}): last ${raw(q.price)} ${q.currency || ""}, change ${fmt(q.changePct)}% vs previous close ${raw(q.prevClose)} — data time ${q.timestamp} [Twelve Data]`);
  }
  if (quotes.length) sources.push({ name: "Twelve Data (quotes, Worker cache)", timestamp: quotes.map((q) => q.timestamp).sort().pop(), items: quotes.length });
  for (const c of Object.values(curves)) {
    const pts = c.points.filter((p) => p.value != null && ["3M", "2Y", "5Y", "10Y", "30Y"].includes(p.tenor));
    lines.push(`YIELDS ${c.id} ${c.kind} on ${c.timestamp} (previous ${c.previousDate}): ` + pts.map((p) => `${p.tenor} ${raw(p.value)}%${p.changeBp != null ? ` (${p.changeBp >= 0 ? "+" : ""}${fmt(p.changeBp, 1)} bp)` : ""}`).join(", ") + ` [${c.source}]`);
    const two = c.points.find((p) => p.tenor === "2Y"), ten = c.points.find((p) => p.tenor === "10Y");
    if (two && ten && two.value != null && ten.value != null) lines.push(`SPREAD ${c.id} 10Y minus 2Y: ${fmt((ten.value - two.value) * 100, 1)} bp [derived from ${c.source}]`);
    sources.push({ name: c.source, timestamp: c.timestamp, url: c.sourceUrl });
  }
  const upcoming = events.filter((e) => Date.parse(e.datetime) >= now).slice(0, 6);
  for (const e of upcoming) lines.push(`EVENT ${e.dateET}${e.timeET ? " " + e.timeET + " ET" : ""} ${e.country} ${e.indicator} [${e.source}]`);
  if (upcoming.length) sources.push({ name: "BLS / BEA release schedules", timestamp: upcoming[0].datetime });
  for (const h of headlines.slice(0, 8)) lines.push(`HEADLINE ${h.timestamp} ${h.source}: ${h.title}`);
  if (headlines.length) sources.push({ name: "GDELT Project (headlines)", timestamp: headlines[0].timestamp });
  return { text: lines.join("\n"), sources, counts: { quotes: quotes.length, curves: Object.keys(curves).length, events: upcoming.length, headlines: Math.min(8, headlines.length) } };
}

// numbers that carry market meaning: with decimals, or followed by % / bp
export function extractNumbers(text) {
  const out = [];
  for (const m of String(text).matchAll(/[-+]?\d+(?:,\d{3})*(?:\.(\d+))?(\s?(?:%|bp|basis points))?/g)) {
    if (!m[1] && !m[2]) continue;
    out.push({ raw: m[0].trim(), value: Number(m[0].replace(/[,%+\s]|bp|basis points/g, "")), decimals: m[1] ? m[1].length : 0 });
  }
  return out;
}
export function verifyNumbers(output, dataText) {
  const pool = extractNumbers(dataText).map((n) => n.value).concat([...String(dataText).matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));
  const checked = extractNumbers(output), unverified = [];
  for (const n of checked) {
    const tol = 0.5 * Math.pow(10, -n.decimals) + 1e-9;
    if (!pool.some((v) => Math.abs(Math.abs(v) - Math.abs(n.value)) <= tol)) unverified.push(n.raw);
  }
  return { checked: checked.length, unverified };
}

export const SYSTEM_PROMPT = [
  "You write a short factual markets briefing for a personal market terminal.",
  "Use ONLY the facts in DATA. Do not add any number, company, event, cause or claim that is not in DATA.",
  "Every number you write must appear in DATA (you may round it). After each fact, put its source in brackets as given in DATA, e.g. [U.S. Department of the Treasury].",
  "If DATA lacks something, do not mention it. Never guess causes or what markets will do next.",
  "No investment advice, no recommendations, no predictions.",
  "Plain text, 120 to 200 words, three short paragraphs titled 'Markets:', 'Rates:', 'Calendar and news:'.",
].join(" ");

export async function handleBriefing(url, env, ctx, H, json) {
  const now = Date.now();
  const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s)))].slice(0, 16);
  const key = `briefing/${symbols.join(",") || "none"}`;
  const cached = await cacheRead(url.origin, key);
  const wantFresh = url.searchParams.get("refresh") === "1";
  if (cached && (now - cached.fetchedAt < (wantFresh ? 10 * 60_000 : 60 * 60_000))) {
    const r = json({ ...cached.data, cache: "HIT" }, H); r.headers.set("cache-control", "no-store"); return r;
  }
  if (!env.AI || typeof env.AI.run !== "function") return json({ error: "model_unavailable", status: "N/A" }, H, 503);

  // real inputs (quotes: read-only from the shared cache, never a provider call)
  const quotes = [];
  for (const s of symbols) {
    const e = await cacheRead(url.origin, `quote/${encodeURIComponent(s)}`);
    if (e && e.rec && now - e.fetchedAt < 24 * 3600_000) quotes.push({ symbol: s, name: e.rec.name, price: e.rec.price, changePct: e.rec.changePct, prevClose: e.rec.prevClose, currency: e.rec.currency, timestamp: e.rec.asOf });
  }
  const [y, cal, news] = await Promise.all([getYieldCurves(url.origin, ctx, now), getCalendar(url.origin, ctx, now), getHeadlines(url.origin, ctx)]);
  const data = buildBriefingData({ quotes, curves: y.curves, events: cal.events, headlines: news.data || [], now });
  if (!data.text) return json({ error: "no_input_data", status: "N/A" }, H, 503);

  let text = null, err = null;
  try {
    const out = await env.AI.run(BRIEF_MODEL, { messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `DATA (as of ${iso(now)}):\n${data.text}` }], max_tokens: 600, temperature: 0.2 });
    text = out && (out.response || (out.result && out.result.response));
  } catch (e) { err = "model_error"; }
  if (!text) return json({ error: err || "model_empty", status: "N/A" }, H, 502);

  const body = {
    status: "DERIVED", model: BRIEF_MODEL, provider: "Cloudflare Workers AI", generatedAt: iso(now),
    text: String(text).trim(), verification: verifyNumbers(text, data.text),
    sources: data.sources, inputs: data.counts, inputData: data.text,
    disclaimer: "AI-generated summary of the listed real data. Not investment advice.",
  };
  cacheWrite(url.origin, key, { data: body, fetchedAt: now }, ctx, 86400);
  const r = json({ ...body, cache: "MISS" }, H); r.headers.set("cache-control", "no-store"); return r;
}
