import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReport } from "../lib/report/report.mjs";

function makeArticle(overrides = {}) {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    title: "Placeholder title for testing",
    url: "https://example.com/story",
    sourceId: "src-1",
    sourceName: "Alpha Wire",
    sourceType: "rss",
    publishedAt: "2026-07-01T00:00:00.000Z",
    collectedAt: "2026-07-01T00:00:00.000Z",
    monthKey: "2026-07",
    category: "Technology",
    summary: "A short summary of the story.",
    keywords: ["signal"],
    sentiment: "neutral",
    entities: { people: [], orgs: [], places: [] },
    readingMinutes: 1,
    clusterId: null,
    read: false,
    starred: false,
    aiEnriched: false,
    fullTextFetched: false,
    ...overrides
  };
}

function fixture() {
  const articles = [];
  for (let i = 0; i < 20; i += 1) {
    articles.push(makeArticle({
      id: `r-${i}`,
      title: `Coverage story number ${i} on rolling developments`,
      publishedAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      monthKey: "2026-07",
      category: i % 2 ? "Technology" : "Security",
      sentiment: i % 3 === 0 ? "watch" : "neutral",
      clusterId: i % 4 === 0 ? "r-0" : null,
      sourceName: i % 2 ? "Alpha Wire" : "Beta Feed",
      keywords: ["signal", i % 2 ? "chips" : "missile"],
      entities: { people: ["Jane Doe"], orgs: ["Acme Corp"], places: ["Berlin"] }
    }));
  }
  const allArticles = [
    ...articles,
    makeArticle({
      id: "p-1",
      monthKey: "2026-06",
      publishedAt: "2026-06-10T00:00:00.000Z",
      category: "Technology",
      keywords: ["signal"]
    })
  ];
  const sources = [
    {
      id: "src-a",
      name: "Alpha Wire",
      url: "https://alpha.example/feed",
      type: "rss",
      paused: false,
      etag: null,
      lastModified: null,
      health: {
        successCount: 5,
        failureCount: 0,
        consecutiveFailures: 0,
        lastError: null,
        lastSuccessAt: "2026-07-01T00:00:00.000Z",
        lastFailureAt: null,
        lastStatus: "ok"
      }
    },
    {
      id: "src-b",
      name: "Beta Feed",
      url: "https://beta.example/feed",
      type: "web",
      paused: false,
      etag: null,
      lastModified: null,
      health: {
        successCount: 1,
        failureCount: 4,
        consecutiveFailures: 4,
        lastError: "Fetch failed with 503",
        lastSuccessAt: null,
        lastFailureAt: "2026-07-02T00:00:00.000Z",
        lastStatus: "error"
      }
    }
  ];
  return { articles, allArticles, sources };
}

function headings(markdown) {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

function sectionBullets(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  if (!match) {
    return [];
  }
  return match[1].split("\n").filter((line) => line.startsWith("- "));
}

test("the three focuses produce genuinely different section headers", () => {
  const { articles, allArticles, sources } = fixture();
  const base = { categories: ["Technology", "Security"], month: "2026-07", template: "standard", articles, allArticles, sources };

  const executive = buildReport({ ...base, focus: "executive" });
  const source = buildReport({ ...base, focus: "source" });
  const watchlist = buildReport({ ...base, focus: "watchlist" });

  const executiveHeadings = headings(executive.markdown);
  const sourceHeadings = headings(source.markdown);
  const watchlistHeadings = headings(watchlist.markdown);

  assert.ok(executiveHeadings.includes("Key developments"));
  assert.ok(executiveHeadings.includes("Momentum"));
  assert.ok(executiveHeadings.includes("Outlook"));
  assert.ok(sourceHeadings.includes("Coverage share"));
  assert.ok(sourceHeadings.includes("Exclusives"));
  assert.ok(sourceHeadings.includes("Source health notes"));
  assert.ok(watchlistHeadings.includes("Risk items"));
  assert.ok(watchlistHeadings.includes("Escalation candidates"));
  assert.ok(watchlistHeadings.includes("Monitoring recommendations"));

  assert.notDeepEqual(executiveHeadings, sourceHeadings);
  assert.notDeepEqual(sourceHeadings, watchlistHeadings);
  assert.notDeepEqual(executiveHeadings, watchlistHeadings);
});

test("template counts drive the key development list length", () => {
  const { articles, allArticles, sources } = fixture();
  const base = { categories: ["Technology", "Security"], month: "2026-07", focus: "executive", articles, allArticles, sources };

  const brief = buildReport({ ...base, template: "brief" });
  const standard = buildReport({ ...base, template: "standard" });
  const detailed = buildReport({ ...base, template: "detailed" });

  assert.equal(sectionBullets(brief.markdown, "Key developments").length, 4);
  assert.equal(sectionBullets(standard.markdown, "Key developments").length, 8);
  assert.equal(sectionBullets(detailed.markdown, "Key developments").length, 15);
  assert.ok(
    sectionBullets(detailed.markdown, "Key developments")[0].includes("Keywords:"),
    "detailed template adds keyword lines"
  );
});

test("executive momentum compares against the prior month from allArticles", () => {
  const { articles, allArticles, sources } = fixture();
  const report = buildReport({
    categories: ["Technology", "Security"],
    month: "2026-07",
    focus: "executive",
    template: "standard",
    articles,
    allArticles,
    sources
  });
  assert.ok(report.markdown.includes("Technology: 10 this month vs 1 prior ▲"));
  assert.ok(report.markdown.includes("Security: 10 this month vs 0 prior ▲"));
});

test("html output escapes a script tag embedded in a title", () => {
  const evil = makeArticle({
    id: "evil",
    title: "Breaking <script>alert(1)</script> market update",
    summary: "A \"quoted\" summary & more.",
    monthKey: "2026-07",
    publishedAt: "2026-07-30T00:00:00.000Z"
  });
  const report = buildReport({
    categories: ["Technology"],
    month: "2026-07",
    focus: "executive",
    template: "brief",
    articles: [evil],
    allArticles: [evil],
    sources: []
  });

  assert.ok(!report.html.includes("<script>"), "raw script tags must never reach the html output");
  assert.ok(report.html.includes("&lt;script&gt;"));
  assert.ok(report.html.includes("&amp;"));
});

test("meta reports story and distinct source counts", () => {
  const { articles, allArticles, sources } = fixture();
  const report = buildReport({
    categories: ["Technology", "Security"],
    month: "2026-07",
    focus: "source",
    template: "brief",
    articles,
    allArticles,
    sources
  });
  assert.equal(report.meta.storyCount, 20);
  assert.equal(report.meta.sources, 2);
  assert.ok(report.markdown.includes("Fetch failed with 503"), "source health notes surface the last error");
});
