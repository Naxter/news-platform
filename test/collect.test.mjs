import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed } from "../lib/collect/rss.mjs";
import { extractPublishedDate, parseNewsPage } from "../lib/collect/web.mjs";
import { parseOpml, buildOpml } from "../lib/collect/opml.mjs";
import { fetchFullText } from "../lib/collect/fulltext.mjs";
import { inferType, collectSource, collectAll } from "../lib/collect/index.mjs";

const rssSource = { id: "src-rss", name: "Test Feed", url: "https://news.example.com/feed.xml", type: "rss" };
const webSource = { id: "src-web", name: "Example News", url: "https://example.com/", type: "web" };

function stubResponse({ status = 200, headers = {}, text = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text,
    finalUrl: "https://stub.example/"
  };
}

const RSS2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://news.example.com/</link>
    <item>
      <title><![CDATA[Markets rally as chip &amp; software stocks surge]]></title>
      <link>https://news.example.com/articles/markets-rally</link>
      <description><![CDATA[<p>Stocks moved higher on Tuesday after earnings.</p>]]></description>
      <pubDate>Tue, 01 Jul 2026 10:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Undated story about science funding</title>
      <link>/articles/undated-science</link>
      <description>A short update without any date information.</description>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry>
    <title type="text">Satellite launch window confirmed</title>
    <link rel="alternate" href="https://space.example.org/stories/launch"/>
    <summary>The agency confirmed a new launch window for next month.</summary>
    <published>2026-06-28T08:00:00Z</published>
  </entry>
  <entry>
    <title>Second entry with updated only</title>
    <link href="https://space.example.org/stories/second"/>
    <content type="html">&lt;p&gt;Details and analysis inside the report.&lt;/p&gt;</content>
    <updated>2026-06-29T12:15:00Z</updated>
  </entry>
  <entry>
    <title>Third entry with no date at all</title>
    <link href="https://space.example.org/stories/third"/>
    <summary>No date fields exist on this entry.</summary>
  </entry>
</feed>`;

test("parseFeed parses RSS2 items with dates, entities and relative links", () => {
  const items = parseFeed(RSS2_XML, rssSource);
  assert.equal(items.length, 2);

  assert.equal(items[0].title, "Markets rally as chip & software stocks surge");
  assert.equal(items[0].url, "https://news.example.com/articles/markets-rally");
  assert.equal(items[0].body, "Stocks moved higher on Tuesday after earnings.");
  assert.equal(items[0].publishedAt, new Date("Tue, 01 Jul 2026 10:30:00 GMT").toISOString());

  assert.equal(items[1].title, "Undated story about science funding");
  assert.equal(items[1].url, "https://news.example.com/articles/undated-science");
  assert.equal(items[1].publishedAt, null);
});

test("parseFeed parses Atom entries with link href and published/updated", () => {
  const items = parseFeed(ATOM_XML, rssSource);
  assert.equal(items.length, 3);

  assert.equal(items[0].title, "Satellite launch window confirmed");
  assert.equal(items[0].url, "https://space.example.org/stories/launch");
  assert.equal(items[0].publishedAt, "2026-06-28T08:00:00.000Z");

  assert.equal(items[1].url, "https://space.example.org/stories/second");
  assert.equal(items[1].body, "Details and analysis inside the report.");
  assert.equal(items[1].publishedAt, "2026-06-29T12:15:00.000Z");

  assert.equal(items[2].publishedAt, null);
});

test("parseFeed uses guid permalink when link is absent so items don't collapse", () => {
  const xml = `<rss version="2.0"><channel>
    <item><title>Story one</title><guid isPermaLink="true">https://news.example.com/story-1</guid><description>First</description></item>
    <item><title>Story two</title><guid isPermaLink="true">https://news.example.com/story-2</guid><description>Second</description></item>
  </channel></rss>`;
  const items = parseFeed(xml, rssSource);
  assert.equal(items[0].url, "https://news.example.com/story-1");
  assert.equal(items[1].url, "https://news.example.com/story-2");
  assert.notEqual(items[0].url, items[1].url, "distinct guids must not collapse to the feed URL");
});

test("parseFeed caps output at 50 items", () => {
  const items = Array.from({ length: 60 }, (_, i) =>
    `<item><title>Story ${i}</title><link>https://news.example.com/${i}</link><description>Body ${i}</description></item>`
  ).join("");
  const xml = `<rss version="2.0"><channel>${items}</channel></rss>`;
  assert.equal(parseFeed(xml, rssSource).length, 50);
});

test("extractPublishedDate prefers JSON-LD datePublished", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2026-06-20T09:00:00Z","author":{"name":"x"}}</script>
    <meta property="article:published_time" content="2026-06-21T09:00:00Z">
    </head><body><time datetime="2026-06-22T09:00:00Z">June 22</time></body></html>`;
  assert.equal(extractPublishedDate(html), "2026-06-20T09:00:00.000Z");
});

test("extractPublishedDate falls back to article:published_time meta", () => {
  const property = `<html><head><meta property="article:published_time" content="2026-06-21T09:30:00Z"></head><body></body></html>`;
  assert.equal(extractPublishedDate(property), "2026-06-21T09:30:00.000Z");

  const name = `<html><head><meta name="article:published_time" content="2026-06-21T10:30:00+02:00"></head><body></body></html>`;
  assert.equal(extractPublishedDate(name), new Date("2026-06-21T10:30:00+02:00").toISOString());
});

test("extractPublishedDate falls back to first time[datetime]", () => {
  const html = `<html><body><article><time datetime="2026-06-22T18:45:00Z">tonight</time></article></body></html>`;
  assert.equal(extractPublishedDate(html), "2026-06-22T18:45:00.000Z");
});

test("extractPublishedDate returns null when nothing usable exists", () => {
  assert.equal(extractPublishedDate("<html><body><p>No dates here.</p></body></html>"), null);
  assert.equal(extractPublishedDate(`<html><head><meta property="article:published_time" content="not a date"></head></html>`), null);
  assert.equal(extractPublishedDate(""), null);
});

const PAGE_HTML = `<html><head><title>Example News — Front Page</title>
<meta name="description" content="Latest headlines from Example News.">
<meta property="article:published_time" content="2026-07-02T06:00:00Z">
</head><body>
<nav><a href="/subscribe">Subscribe now for unlimited digital access today</a></nav>
<a href="/privacy">Read our updated privacy policy and terms today</a>
<a href="/news/2026/07/parliament-vote">Parliament approves sweeping budget reform after marathon session</a>
<a href="https://example.com/story/ports">Shipping delays ripple through regional ports as storm lingers</a>
<a href="/contact">Contact</a>
<a href="/news/short">Too short</a>
</body></html>`;

test("parseNewsPage filters anchors with news-link heuristics", () => {
  const items = parseNewsPage(PAGE_HTML, webSource);
  assert.equal(items.length, 2);

  assert.equal(items[0].title, "Parliament approves sweeping budget reform after marathon session");
  assert.equal(items[0].url, "https://example.com/news/2026/07/parliament-vote");
  assert.equal(items[1].url, "https://example.com/story/ports");

  for (const item of items) {
    assert.equal(item.publishedAt, "2026-07-02T06:00:00.000Z");
    assert.ok(item.body.includes("Latest headlines from Example News."));
  }
});

test("parseNewsPage falls back to a single page-level item without anchors", () => {
  const html = `<html><head><title>Quiet Page</title><meta name="description" content="A page with no links."></head><body><p>Hello.</p></body></html>`;
  const items = parseNewsPage(html, webSource);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Quiet Page");
  assert.equal(items[0].url, webSource.url);
  assert.equal(items[0].publishedAt, null);
  assert.equal(items[0].body, "A page with no links.");
});

test("parseOpml reads nested outlines and skips folders without xmlUrl", () => {
  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>Subs</title></head><body>
  <outline text="News folder">
    <outline type="rss" text="Feed One" xmlUrl="https://one.example.com/rss" htmlUrl="https://one.example.com"/>
    <outline type="rss" title="Feed Two" xmlUrl="https://two.example.com/atom.xml"/>
  </outline>
  </body></opml>`;
  const parsed = parseOpml(opml);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { name: "Feed One", url: "https://one.example.com/rss", type: "auto" });
  assert.deepEqual(parsed[1], { name: "Feed Two", url: "https://two.example.com/atom.xml", type: "auto" });
});

test("buildOpml/parseOpml round-trip preserves names and urls", () => {
  const sources = [
    { name: "Tech & Science Desk", url: "https://tech.example.com/feed.xml", type: "rss" },
    { name: "World \"Wire\"", url: "https://world.example.org/rss?limit=20&lang=en", type: "auto" },
    { name: "Manual Notes", url: "manual://notes", type: "manual" }
  ];
  const xml = buildOpml(sources);
  assert.ok(xml.startsWith("<?xml"));
  assert.ok(xml.includes("<opml version=\"2.0\">"));

  const parsed = parseOpml(xml);
  assert.equal(parsed.length, 2, "manual:// sources are excluded from export");
  assert.deepEqual(parsed[0], { name: "Tech & Science Desk", url: "https://tech.example.com/feed.xml", type: "auto" });
  assert.deepEqual(parsed[1], { name: "World \"Wire\"", url: "https://world.example.org/rss?limit=20&lang=en", type: "auto" });
});

test("inferType detects feeds by content type, body sniff and extension", () => {
  assert.equal(inferType("https://x.example/feed", "application/rss+xml", ""), "rss");
  assert.equal(inferType("https://x.example/feed", "application/atom+xml; charset=utf-8", ""), "rss");
  assert.equal(inferType("https://x.example/feed.xml", "text/plain", ""), "rss");
  assert.equal(inferType("https://x.example/feed", "text/html", "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\">"), "rss");
  assert.equal(inferType("https://x.example/page", "text/html", "<html><body><p>hi</p></body></html>"), "web");
});

test("collectSource sends conditional headers and handles 304", async () => {
  const source = {
    id: "s1", name: "Feed", url: "https://feeds.example.com/a.xml", type: "rss",
    etag: "\"abc\"", lastModified: "Tue, 01 Jul 2026 00:00:00 GMT"
  };
  let seenUrl = null;
  let seenHeaders = null;
  const fetchImpl = async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return stubResponse({ status: 304 });
  };
  const result = await collectSource(source, fetchImpl);
  assert.equal(seenUrl, source.url);
  assert.equal(seenHeaders["if-none-match"], "\"abc\"");
  assert.equal(seenHeaders["if-modified-since"], "Tue, 01 Jul 2026 00:00:00 GMT");
  assert.equal(result.notModified, true);
  assert.deepEqual(result.items, []);
  assert.equal(result.etag, "\"abc\"");
  assert.equal(result.lastModified, "Tue, 01 Jul 2026 00:00:00 GMT");
});

test("collectSource parses a fresh feed and captures caching headers", async () => {
  const source = { id: "s2", name: "Feed", url: "https://feeds.example.com/a.xml", type: "auto" };
  const fetchImpl = async () => stubResponse({
    status: 200,
    headers: {
      "content-type": "application/rss+xml",
      "etag": "\"v2\"",
      "last-modified": "Wed, 02 Jul 2026 00:00:00 GMT"
    },
    text: RSS2_XML
  });
  const result = await collectSource(source, fetchImpl);
  assert.equal(result.notModified, false);
  assert.equal(result.items.length, 2);
  assert.equal(result.etag, "\"v2\"");
  assert.equal(result.lastModified, "Wed, 02 Jul 2026 00:00:00 GMT");
});

test("collectSource throws on http error status", async () => {
  const source = { id: "s3", name: "Feed", url: "https://feeds.example.com/a.xml", type: "rss" };
  const fetchImpl = async () => stubResponse({ status: 500, text: "boom" });
  await assert.rejects(() => collectSource(source, fetchImpl), /Fetch failed with 500/);
});

test("collectAll never throws per-source and skips manual/paused sources", async () => {
  const sources = [
    { id: "ok", name: "OK", url: "https://ok.example/feed.xml", type: "rss" },
    { id: "bad", name: "Bad", url: "https://bad.example/feed.xml", type: "rss", etag: "\"keep\"" },
    { id: "man", name: "Manual", url: "manual://notes", type: "manual" },
    { id: "paused", name: "Paused", url: "https://p.example/feed.xml", type: "rss", paused: true }
  ];
  const fetchImpl = async (url) => {
    if (url.includes("bad.example")) throw new Error("boom");
    return stubResponse({ status: 200, headers: { "content-type": "application/rss+xml" }, text: RSS2_XML });
  };
  const { results, attempted } = await collectAll(sources, { fetchImpl });
  assert.equal(attempted, 2);
  assert.equal(results.length, 2);

  const ok = results.find((entry) => entry.sourceId === "ok");
  assert.equal(ok.ok, true);
  assert.equal(ok.notModified, false);
  assert.equal(ok.items.length, 2);
  assert.equal(ok.error, null);

  const bad = results.find((entry) => entry.sourceId === "bad");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "boom");
  assert.deepEqual(bad.items, []);
  assert.equal(bad.etag, "\"keep\"", "failure keeps the source's existing etag");
});

test("collectAll limits concurrency to the pool size", async () => {
  let inFlight = 0;
  let peak = 0;
  const sources = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`, name: `S${i}`, url: `https://s${i}.example/feed.xml`, type: "rss"
  }));
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return stubResponse({ status: 200, headers: { "content-type": "application/rss+xml" }, text: "<rss><channel></channel></rss>" });
  };
  const { results, attempted } = await collectAll(sources, { fetchImpl });
  assert.equal(attempted, 10);
  assert.equal(results.length, 10);
  assert.ok(results.every((entry) => entry.ok), "all stub fetches succeed");
  assert.ok(peak <= 4, `peak concurrency ${peak} should not exceed 4`);
});

test("fetchFullText prefers article content and strips chrome", async () => {
  const paragraph = "Analysts described the outcome as a decisive turn in the negotiations. ".repeat(6);
  const html = `<html><head><title>Deep Dive</title></head><body>
    <nav><a href="/x">Navigation junk that should never appear</a></nav>
    <header>Masthead junk</header>
    <article><p>${paragraph}</p></article>
    <footer>Footer junk</footer>
  </body></html>`;
  const fetchImpl = async () => stubResponse({ status: 200, headers: { "content-type": "text/html" }, text: html });
  const { title, text } = await fetchFullText("https://example.com/story", fetchImpl);
  assert.equal(title, "Deep Dive");
  assert.ok(text.includes("decisive turn in the negotiations"));
  assert.ok(!text.includes("Navigation junk"));
  assert.ok(!text.includes("Footer junk"));
  assert.ok(text.length >= 200);
});

test("fetchFullText falls back to long paragraph blocks", async () => {
  const long = "This sentence keeps going with enough substance to pass the one hundred and twenty character paragraph threshold used by the extractor heuristic.";
  const html = `<html><head><title>P Blocks</title></head><body>
    <p>short</p>
    <p>${long}</p>
    <p>${long}</p>
  </body></html>`;
  const fetchImpl = async () => stubResponse({ status: 200, headers: { "content-type": "text/html" }, text: html });
  const { text } = await fetchFullText("https://example.com/p-blocks", fetchImpl);
  assert.ok(text.includes("paragraph threshold"));
  assert.ok(!text.includes("short "), "paragraphs under 120 chars are excluded");
  assert.ok(text.length >= 200);
});

test("fetchFullText throws on thin pages and http errors", async () => {
  const thin = async () => stubResponse({ status: 200, headers: { "content-type": "text/html" }, text: "<html><body><p>tiny</p></body></html>" });
  await assert.rejects(() => fetchFullText("https://example.com/thin", thin), /substantial/i);

  const failing = async () => stubResponse({ status: 404, text: "" });
  await assert.rejects(() => fetchFullText("https://example.com/missing", failing), /Fetch failed with 404/);
});
