// PRESS HEADLINES (T06) — top publishers and central banks, from their own public RSS feeds:
// Financial Times, Bloomberg, The Wall Street Journal, MarketWatch; Federal Reserve, ECB, Bank of England.
// Shown like a feed reader in this private terminal: headline, section, time and a link to the
// article on the publisher's site. No article text, summary or image is stored or shown.
//   GET /api/headlines?source=FT|BLOOMBERG|WSJ|MARKETWATCH|CB
import { fetchText, cachedSource, iso } from "./lib.mjs";

export const PRESS = {
  FT: {
    name: "Financial Times", home: "https://www.ft.com/",
    feeds: [
      ["Home", "https://www.ft.com/rss/home"],
      ["Markets", "https://www.ft.com/markets?format=rss"],
      ["Global economy", "https://www.ft.com/global-economy?format=rss"],
      ["Companies", "https://www.ft.com/companies?format=rss"],
    ],
  },
  BLOOMBERG: {
    name: "Bloomberg", home: "https://www.bloomberg.com/",
    feeds: [
      ["Markets", "https://feeds.bloomberg.com/markets/news.rss"],
      ["Economics", "https://feeds.bloomberg.com/economics/news.rss"],
      ["Technology", "https://feeds.bloomberg.com/technology/news.rss"],
      ["Politics", "https://feeds.bloomberg.com/politics/news.rss"],
    ],
  },
  WSJ: {
    name: "The Wall Street Journal", home: "https://www.wsj.com/",
    feeds: [
      ["Markets", "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain"],
      ["World", "https://feeds.content.dowjones.io/public/rss/RSSWorldNews"],
      ["Business", "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness"],
      ["Technology", "https://feeds.content.dowjones.io/public/rss/RSSWSJD"],
    ],
  },
  MARKETWATCH: {
    name: "MarketWatch", home: "https://www.marketwatch.com/",
    feeds: [["Top stories", "https://feeds.content.dowjones.io/public/rss/mw_topstories"]],
  },
  // official releases: each feed is its own institution (the section names it)
  CB: {
    name: "Central banks", home: null,
    feeds: [
      ["Fed", "https://www.federalreserve.gov/feeds/press_all.xml"],
      ["Fed speeches", "https://www.federalreserve.gov/feeds/speeches.xml"],
      ["ECB", "https://www.ecb.europa.eu/rss/press.html"],
      ["BoE", "https://www.bankofengland.co.uk/rss/news"],
    ],
    feedName: { Fed: "Federal Reserve", "Fed speeches": "Federal Reserve", ECB: "European Central Bank", BoE: "Bank of England" },
  },
};
// the name to show for one item: the institution for central banks, the publisher otherwise
export const pressSourceName = (id, section) => (PRESS[id].feedName && PRESS[id].feedName[section]) || PRESS[id].name;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")                                   // tags inside a title
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ").trim();
}
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml); return m ? m[1] : null; };

// RSS 2.0 items → { title, url, timestamp, section } — title and link only, by design
export function parseRss(xml, section) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const title = decodeXml(tag(it, "title"));
    let url = decodeXml(tag(it, "link"));
    if (!/^https?:\/\//.test(url)) { const g = decodeXml(tag(it, "guid")); url = /^https?:\/\//.test(g) ? g : ""; }
    const t = Date.parse(decodeXml(tag(it, "pubDate") || tag(it, "dc:date") || ""));
    if (!title || !url || !Number.isFinite(t)) continue;
    out.push({ title, url, timestamp: new Date(t).toISOString(), section });
  }
  return out;
}

export function mergeHeadlines(lists, limit = 40) {
  const seen = new Set(), out = [];
  for (const it of lists.flat().sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))) {
    const k = it.url.split("?")[0];
    if (seen.has(k)) continue; seen.add(k);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getPress(origin, ctx, id) {
  const src = PRESS[id];
  const per = await Promise.all(src.feeds.map(([section, url]) => cachedSource({
    origin, key: `press/${id}/${section}`, ttlMs: 10 * 60_000, staleMaxMs: 24 * 3600_000, ctx, failTtlMs: 5 * 60_000,
    load: async () => {
      const f = await fetchText(url, { timeoutMs: 10000, headers: { accept: "application/rss+xml, application/xml, text/xml" } });
      if (f.err) return { err: f.err };
      const items = parseRss(f.text, section);
      return items.length ? { data: items } : { err: "no_data" };
    },
  }).then((r) => ({ section, url, ...r }))));
  return per;
}

// headlines from every listed source, newest first, each named by its publisher / institution
export async function topHeadlines(origin, ctx, limit = 40, ids = Object.keys(PRESS)) {
  const per = await Promise.all(ids.map((id) => getPress(origin, ctx, id).then((feeds) => feeds.filter((f) => f.data).map((f) => f.data.map((x) => ({ ...x, source: pressSourceName(id, x.section), provider: id }))))));
  return mergeHeadlines(per.flat(), limit);
}

export async function handleHeadlines(url, env, ctx, H, json) {
  const id = String(url.searchParams.get("source") || "").toUpperCase();
  if (!PRESS[id]) return json({ error: "bad_request", message: `source must be one of ${Object.keys(PRESS).join(",")}` }, H, 400);
  const src = PRESS[id], per = await getPress(url.origin, ctx, id);
  const ok = per.filter((p) => p.data);
  const items = mergeHeadlines(ok.map((p) => p.data)).map((x) => ({ ...x, source: pressSourceName(id, x.section), provider: id }));
  const feeds = per.map((p) => ({ section: p.section, status: p.data ? (p.cache === "STALE" ? "STALE" : "LIVE") : "N/A", ...(p.data ? { fetchedAt: iso(p.fetchedAt), items: p.data.length } : { error: p.err }) }));
  const status = !ok.length ? "N/A" : ok.some((p) => p.cache === "STALE") || ok.length < per.length ? (ok.some((p) => p.cache === "STALE") ? "STALE" : "PARTIAL") : "LIVE";
  const r = json({
    source: id, name: src.name, home: src.home, items, feeds, status,
    basis: "publisher's public RSS feed — headline, time and link only (no article text)",
    fetchedAt: ok.length ? iso(Math.max(...ok.map((p) => p.fetchedAt))) : null,
    ...(ok.length ? {} : { error: (per.find((p) => p.err) || {}).err || "no_data" }),
  }, H, ok.length ? 200 : 502);
  r.headers.set("cache-control", "no-store");
  return r;
}
