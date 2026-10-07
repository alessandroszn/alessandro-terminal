// PRESS HEADLINES (T06) — Financial Times and Bloomberg, from the publishers' own public RSS feeds.
// Shown like a feed reader in this private terminal: headline, section, time and a link to the
// article on the publisher's site. No article text, summary or image is stored or shown.
//   GET /api/headlines?source=FT|BLOOMBERG
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
};

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

export async function handleHeadlines(url, env, ctx, H, json) {
  const id = String(url.searchParams.get("source") || "").toUpperCase();
  if (!PRESS[id]) return json({ error: "bad_request", message: `source must be one of ${Object.keys(PRESS).join(",")}` }, H, 400);
  const src = PRESS[id], per = await getPress(url.origin, ctx, id);
  const ok = per.filter((p) => p.data);
  const items = mergeHeadlines(ok.map((p) => p.data)).map((x) => ({ ...x, source: src.name, provider: id }));
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
