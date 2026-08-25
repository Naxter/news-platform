import { test } from "node:test";
import assert from "node:assert/strict";

import { assignClusters } from "../lib/analyze/cluster.mjs";
import { computeTrends } from "../lib/analyze/trends.mjs";
import { summarizeHealth, applyCollectResult } from "../lib/analyze/health.mjs";

// alerts.mjs and decorate.mjs depend on lib/text.mjs (owner C). Until that file
// lands, load them dynamically and skip their tests instead of failing the suite.
let alerts = null;
let decorate = null;
let skipTextDependent = false;
try {
  alerts = await import("../lib/analyze/alerts.mjs");
  decorate = await import("../lib/analyze/decorate.mjs");
} catch {
  skipTextDependent = "lib/text.mjs (owner C) is not available yet";
}

const STOP_WORDS = new Set(["with", "amid", "over", "after", "their", "about"]);

function makeArticle(overrides = {}) {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    title: "Placeholder title for testing",
    url: "https://example.com/story",
    sourceId: "src-1",
    sourceName: "Example Wire",
    sourceType: "rss",
    publishedAt: "2026-07-01T00:00:00.000Z",
    collectedAt: "2026-07-01T00:00:00.000Z",
    monthKey: "2026-07",
    category: "Technology",
    summary: "A short summary of the story.",
    keywords: [],
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

test("assignClusters groups near-duplicate titles within the 72h window", () => {
  const first = makeArticle({
    id: "a1",
    title: "Global chip shortage disrupts major automakers",
    publishedAt: "2026-07-01T00:00:00.000Z"
  });
  const second = makeArticle({
    id: "a2",
    title: "Chip shortage disrupts major global automakers again",
    publishedAt: "2026-07-02T12:00:00.000Z"
  });
  const unrelated = makeArticle({
    id: "a3",
    title: "Rainforest study finds unexpected biodiversity gains",
    publishedAt: "2026-07-02T00:00:00.000Z"
  });

  const result = assignClusters([second, unrelated, first], STOP_WORDS);

  assert.equal(result.length, 3);
  assert.equal(first.clusterId, "a1", "cluster id is the earliest member's id");
  assert.equal(second.clusterId, "a1");
  assert.equal(unrelated.clusterId, null);
});

test("assignClusters does not group identical titles across a 4-day gap", () => {
  const early = makeArticle({
    id: "b1",
    title: "Central bank signals cautious approach on interest rates",
    publishedAt: "2026-07-01T00:00:00.000Z"
  });
  const late = makeArticle({
    id: "b2",
    title: "Central bank signals cautious approach on interest rates",
    publishedAt: "2026-07-05T00:00:00.000Z"
  });

  assignClusters([early, late], STOP_WORDS);

  assert.equal(early.clusterId, null);
  assert.equal(late.clusterId, null);
});

test("summarizeHealth and applyCollectResult walk through the status transitions", () => {
  const source = {
    id: "src-1",
    name: "Wire",
    paused: false,
    etag: "W/\"old\"",
    lastModified: null,
    health: {
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastStatus: null
    }
  };

  assert.equal(summarizeHealth(source).status, "new");

  applyCollectResult(source, { sourceId: "src-1", ok: false, notModified: false, items: [], error: "boom" });
  assert.equal(summarizeHealth(source).status, "warning");
  assert.equal(source.health.consecutiveFailures, 1);
  assert.equal(source.health.lastError, "boom");
  assert.equal(source.health.lastStatus, "error");

  applyCollectResult(source, { ok: false, error: "boom" });
  applyCollectResult(source, { ok: false, error: "boom" });
  assert.equal(summarizeHealth(source).status, "failing");
  assert.equal(source.health.failureCount, 3);
  assert.equal(source.health.consecutiveFailures, 3);

  applyCollectResult(source, {
    ok: true,
    notModified: false,
    items: [],
    etag: "W/\"fresh\"",
    lastModified: "Wed, 01 Jul 2026 00:00:00 GMT"
  });
  assert.equal(summarizeHealth(source).status, "healthy");
  assert.equal(source.health.consecutiveFailures, 0);
  assert.equal(source.health.lastError, null);
  assert.equal(source.health.lastStatus, "ok");
  assert.equal(source.etag, "W/\"fresh\"");
  assert.equal(source.lastModified, "Wed, 01 Jul 2026 00:00:00 GMT");

  applyCollectResult(source, { ok: true, notModified: true, items: [], etag: null, lastModified: null });
  assert.equal(source.health.lastStatus, "not-modified");
  assert.equal(source.etag, "W/\"fresh\"", "a 304 without validators keeps the stored etag");
  assert.equal(summarizeHealth(source).status, "healthy");

  source.paused = true;
  assert.equal(summarizeHealth(source).status, "warning");
});

test("computeTrends rising keyword math and month buckets", () => {
  const articles = [
    makeArticle({
      monthKey: "2026-06",
      publishedAt: "2026-06-05T00:00:00.000Z",
      keywords: ["quantum", "laboratory"],
      sentiment: "neutral",
      category: "Science"
    }),
    makeArticle({
      monthKey: "2026-07",
      publishedAt: "2026-07-02T00:00:00.000Z",
      keywords: ["quantum", "solar"],
      sentiment: "watch",
      entities: { people: ["Jane Smith"], orgs: ["Acme Corp"], places: ["Berlin"] }
    }),
    makeArticle({
      monthKey: "2026-07",
      publishedAt: "2026-07-03T00:00:00.000Z",
      keywords: ["quantum", "solar"],
      sentiment: "positive",
      entities: { people: ["Jane Smith"], orgs: [], places: [] }
    }),
    makeArticle({
      monthKey: "2026-07",
      publishedAt: "2026-07-04T00:00:00.000Z",
      keywords: ["quantum", "onceonly"],
      sentiment: "neutral"
    })
  ];

  const trends = computeTrends(articles, ["Technology", "Science"]);

  assert.deepEqual(trends.byMonth.map((entry) => entry.month), ["2026-06", "2026-07"], "byMonth is ascending");
  assert.equal(trends.byMonth[1].total, 3);
  assert.equal(trends.byMonth[1].byCategory.Technology, 3);
  assert.equal(trends.byMonth[0].byCategory.Science, 1);
  assert.deepEqual(trends.byMonth[1].sentiment, { positive: 1, neutral: 1, watch: 1 });

  const quantum = trends.risingKeywords.find((entry) => entry.keyword === "quantum");
  assert.deepEqual(quantum, { keyword: "quantum", current: 3, previous: 1, growth: 3 });
  const solar = trends.risingKeywords.find((entry) => entry.keyword === "solar");
  assert.deepEqual(solar, { keyword: "solar", current: 2, previous: 0, growth: 2 });
  assert.equal(
    trends.risingKeywords.find((entry) => entry.keyword === "onceonly"),
    undefined,
    "keywords with fewer than 2 current mentions are excluded"
  );

  assert.deepEqual(trends.topEntities.people, [{ name: "Jane Smith", count: 2 }]);
  assert.deepEqual(trends.topEntities.orgs, [{ name: "Acme Corp", count: 1 }]);
});

test("matchWatchlists uses whole-word matching", { skip: skipTextDependent }, () => {
  const watchlists = [
    { id: "wl-ai", name: "AI", keywords: ["ai"], categories: [], sources: [], createdAt: "2026-07-01T00:00:00.000Z" },
    { id: "wl-tech", name: "Tech only", keywords: [], categories: ["Technology"], sources: [], createdAt: "2026-07-01T00:00:00.000Z" },
    { id: "wl-src", name: "Wire only", keywords: [], categories: [], sources: ["Example Wire"], createdAt: "2026-07-01T00:00:00.000Z" }
  ];
  const falsePositive = makeArticle({
    id: "art-said",
    title: "Officials said rain will continue through the weekend",
    summary: "Heavy rainfall is expected again.",
    category: "World",
    sourceName: "Weather Desk",
    keywords: ["rainfall"],
    publishedAt: "2026-07-01T00:00:00.000Z"
  });
  const genuine = makeArticle({
    id: "art-ai",
    title: "AI chips power a new research lab",
    summary: "Compute capacity keeps expanding.",
    category: "Technology",
    sourceName: "Example Wire",
    keywords: ["chips"],
    publishedAt: "2026-07-02T00:00:00.000Z"
  });

  const matches = alerts.matchWatchlists(watchlists, [falsePositive, genuine]);

  assert.deepEqual(matches["wl-ai"], ["art-ai"], "\"ai\" must not substring-match \"said\" or \"rain\"");
  assert.deepEqual(matches["wl-tech"], ["art-ai"]);
  assert.deepEqual(matches["wl-src"], ["art-ai"]);
});

test("decorateState masks the AI key and exposes the frontend contract", { skip: skipTextDependent }, () => {
  const store = {
    version: 2,
    settings: {
      autoCollectMinutes: 0,
      maxArticles: 2000,
      ai: { enabled: true, apiKey: "sk-secret", model: "claude-opus-4-8", maxArticlesPerCollect: 30 },
      webhooks: [],
      apiToken: ""
    },
    categories: [
      { name: "Technology", keywords: ["ai", "software"] },
      { name: "World", keywords: ["global"] }
    ],
    sentiment: { positive: ["gain"], negative: ["risk"] },
    sources: [
      {
        id: "src-1",
        name: "Wire",
        url: "https://example.com/feed",
        type: "rss",
        createdAt: "2026-06-01T00:00:00.000Z",
        paused: false,
        etag: null,
        lastModified: null,
        health: {
          successCount: 2,
          failureCount: 0,
          consecutiveFailures: 0,
          lastError: null,
          lastSuccessAt: "2026-07-01T00:00:00.000Z",
          lastFailureAt: null,
          lastStatus: "ok"
        }
      }
    ],
    articles: [
      makeArticle({ id: "d1", starred: true, read: false, clusterId: "d1", sentiment: "watch" }),
      makeArticle({ id: "d2", read: true, clusterId: "d1", monthKey: "2026-06", publishedAt: "2026-06-15T00:00:00.000Z" })
    ],
    watchlists: [],
    collections: [],
    lastCollectedAt: null
  };

  const state = decorate.decorateState(store);

  assert.equal(state.config.settings.ai.apiKey, "", "api key must be masked");
  assert.equal(state.config.settings.ai.apiKeyConfigured, true);
  assert.equal(store.settings.ai.apiKey, "sk-secret", "store itself must not be mutated");
  assert.deepEqual(state.categories, ["Technology", "World"]);
  assert.deepEqual(state.months, ["2026-07", "2026-06"]);
  assert.equal(state.sources[0].healthSummary.status, "healthy");
  assert.equal(state.analytics.totalArticles, 2);
  assert.equal(state.analytics.totalSources, 1);
  assert.equal(state.analytics.unreadCount, 1);
  assert.equal(state.analytics.starredCount, 1);
  assert.equal(state.analytics.clusterCount, 1);
  assert.deepEqual(state.analytics.sentimentTotals, { positive: 0, neutral: 1, watch: 1 });
  assert.equal(state.analytics.latestArticleAt, "2026-07-01T00:00:00.000Z");
  assert.ok(state.trends && Array.isArray(state.trends.byMonth));
  assert.deepEqual(state.watchlistMatches, {});
});
