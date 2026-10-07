// T06 — FT / Bloomberg headlines from public RSS feeds (Worker side). RSS fixtures in RSS 2.0 format.
//   node test/press.test.mjs
import { app as worker } from "../src/worker.mjs";
import { parseRss, decodeXml, mergeHeadlines, PRESS } from "../src/press.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };
let store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const k = typeof req === "string" ? req : req.url; return store.has(k) ? new Response(store.get(k)) : undefined; },
  put: async (req, res) => { const k = typeof req === "string" ? req : req.url; store.set(k, await res.text()); },
} };

const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test feed</title>${items.map((i) => `<item>${i}</item>`).join("")}</channel></rss>`;
const FIX = rss([
  `<title><![CDATA[Stocks <b>rise</b> &amp; bonds slip]]></title><link>https://www.ft.com/content/a1</link><pubDate>Tue, 06 Oct 2026 20:15:00 GMT</pubDate><description><![CDATA[Long article summary that must never be shown]]></description>`,
  `<title>Dollar &#8212; yen &quot;steady&quot;</title><guid isPermaLink="true">https://www.ft.com/content/a2</guid><pubDate>Tue, 06 Oct 2026 21:00:00 +0000</pubDate>`,
  `<title>No date item</title><link>https://www.ft.com/content/a3</link>`,
  `<title></title><link>https://www.ft.com/content/a4</link><pubDate>Tue, 06 Oct 2026 21:00:00 GMT</pubDate>`,
]);
const items = parseRss(FIX, "Markets");
ok("RSS: title, link, time, section; CDATA, tags and entities decoded", items.length === 2 && items[0].title === "Stocks rise & bonds slip" && items[0].url === "https://www.ft.com/content/a1" && items[0].timestamp === "2026-10-06T20:15:00.000Z" && items[0].section === "Markets");
ok("RSS: guid used as link when <link> is missing; numeric entities", items[1].url === "https://www.ft.com/content/a2" && items[1].title === 'Dollar — yen "steady"');
ok("RSS: items without date or title are skipped (nothing invented)", !items.some((i) => /No date/.test(i.title)) && !items.some((i) => i.url.endsWith("a4")));
ok("RSS: description / article text never kept", !JSON.stringify(items).includes("Long article summary") && !("description" in items[0]));
ok("RSS: garbage → no items", parseRss("<html>blocked</html>").length === 0 && parseRss("").length === 0);
ok("decodeXml basic", decodeXml("A &lt;b&gt; &amp;amp; C") === "A <b> &amp; C");
const merged = mergeHeadlines([[{ title: "x", url: "https://a/1?utm=1", timestamp: "2026-10-06T10:00:00Z" }], [{ title: "x2", url: "https://a/1", timestamp: "2026-10-06T09:00:00Z" }, { title: "y", url: "https://a/2", timestamp: "2026-10-06T11:00:00Z" }]]);
ok("merge: newest first, duplicates across sections removed", merged.length === 2 && merged[0].title === "y" && merged[1].title === "x");
ok("feeds: FT and Bloomberg sections defined on the publishers' own domains", PRESS.FT.feeds.every(([, u]) => u.startsWith("https://www.ft.com/")) && PRESS.BLOOMBERG.feeds.every(([, u]) => u.startsWith("https://feeds.bloomberg.com/")));

let failing = new Set(), calls = [];
globalThis.fetch = async (u) => { calls.push(String(u)); if (failing.has(String(u)) || failing.has("*")) return new Response("", { status: 403 }); return new Response(FIX); };
const env = { ALLOWED_ORIGIN: "https://alessandrozanichelli.com" }, ctx = { waitUntil: () => {} };
const call = async (path) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path), env, ctx); const t = await r.text(); return { status: r.status, j: JSON.parse(t), t }; };

let r = await call("/api/headlines?source=FT");
ok("FT: all sections fetched, LIVE, headline/link/time only, source named", r.status === 200 && r.j.status === "LIVE" && r.j.feeds.length === 4 && r.j.items.length === 2 && r.j.items.every((i) => i.source === "Financial Times" && i.provider === "FT") && /no article text/.test(r.j.basis) && !r.t.includes("Long article summary"));
ok("FT: cached 10 min (no refetch)", (calls.length = 0, (await call("/api/headlines?source=FT")).status === 200 && calls.length === 0));
store = new Map(); failing = new Set([PRESS.BLOOMBERG.feeds[1][1]]);
r = await call("/api/headlines?source=BLOOMBERG");
ok("Bloomberg: one section refused → PARTIAL, that section N/A with the reason", r.status === 200 && r.j.status === "PARTIAL" && r.j.feeds.find((f) => f.section === "Economics").status === "N/A" && r.j.feeds.find((f) => f.section === "Economics").error === "provider_forbidden");
store = new Map(); failing = new Set(["*"]);
r = await call("/api/headlines?source=BLOOMBERG");
ok("all feeds refused → 502 N/A, no headlines", r.status === 502 && r.j.status === "N/A" && r.j.items.length === 0 && !!r.j.error);
r = await call("/api/headlines?source=REUTERS");
ok("unknown source → 400", r.status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
